import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { loadConfig, saveConfig } from './config.js';
import { startGpuPolling } from './gpu.js';
import { startSystemPolling } from './system.js';
import { LlamaProcessManager, listLlamaDevices, matchCudaIndices, getLlamaVersion } from './llama.js';
import type { WsMessage, LlamaConfig, GpuInfo, LlamaDevice, GpuSortMode, SystemStats } from './types.js';
import { loadModels, saveModels, loadParams, saveParams, generateId, type ModelConfig, type ConfigTemplate, type ParamDef } from './modelConfig.js';
import { DEFAULT_PARAMS } from './params-default.js';
import { parseRouterIni, exportRouterIni } from './routerIni.js';
import { toLogEntry, parseLogLine, parseTimingMessage, type LogEntry, type TimingData } from './logParser.js';
import { ModelMetricsPoller } from './metricsPoller.js';
import { APP_VERSION } from './version.js';

// When compiled with `bun build --compile --asset dist/client`, the built client
// bundle is embedded in the executable and served from memory. In dev / node mode
// we fall back to reading dist/client from disk.
const BunAny = (globalThis as any).Bun;

// Minimal shape of an entry in Bun.embeddedFiles (a Blob with a file name).
interface EmbeddedFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

// Map of relative path (e.g. "index.html", "assets/x.js") → embedded file, built
// from Bun.embeddedFiles when running inside a compiled binary. Empty otherwise.
const embeddedClient = new Map<string, EmbeddedFile>();
{
  const files: Array<{ name?: string; arrayBuffer?(): Promise<ArrayBuffer> }> | undefined = BunAny?.embeddedFiles;
  if (Array.isArray(files) && files.length > 0) {
    // Every entry shares a common first path segment — the basename of the
    // --asset directory (e.g. "client"). Strip it so keys are relative to the
    // client root, matching incoming request paths.
    const firstSegments = new Set(files.map((f) => String(f?.name ?? '').split('/')[0]));
    const prefix = firstSegments.size === 1 ? [...firstSegments][0] + '/' : '';
    for (const f of files) {
      if (!f || typeof f.name !== 'string' || typeof f.arrayBuffer !== 'function') continue;
      const rel = prefix && f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name;
      // Store the original Blob so its methods keep their `this` binding.
      embeddedClient.set(rel, f as unknown as EmbeddedFile);
    }
  }
}

const PORT = parseInt(process.env.PORT ?? '3000', 10);

export const app = express();
app.use(express.json());

// --- State ---
let config = loadConfig();
const llama = new LlamaProcessManager();
let gpuIntervalMs = config.gpuIntervalMs || 2000;

// In-memory cache of recent log entries, replayed to clients on (re)connect
const LOG_CACHE_SIZE = 1024;
const logCache: LogEntry[] = [];

// --- SSE setup ---
const server = http.createServer(app);
const sseClients = new Set<http.ServerResponse>();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Replay log history on connect
  if (logCache.length > 0) {
    res.write(`event: log-history\ndata: ${JSON.stringify([...logCache])}\n\n`);
  }
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(msg: WsMessage): void {
  const data = `event: ${msg.type}\ndata: ${JSON.stringify(msg.payload)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

// Per-model performance metrics: the poller queries the router's /models and
// /metrics?model=<id> endpoints on a timer
const metricsPoller = new ModelMetricsPoller();
const METRICS_POLL_INTERVAL_MS = 3000;
// Temporarily disabled to reduce load on the llama-server. Set to true to re-enable.
const METRICS_POLLING_ENABLED = false;

metricsPoller.onMetrics = (modelMetrics) => {
  broadcast({ type: 'model-metrics', payload: modelMetrics });
};

// Start polling per-model metrics against the llama-server router
function startMetricsPolling(): void {
  if (!METRICS_POLLING_ENABLED) return;
  const host = config.host || '127.0.0.1';
  const baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${config.port}`;
  metricsPoller.start([{ baseUrl, apiKey: config.apiKey || undefined }], METRICS_POLL_INTERVAL_MS);
}

// --- Model status (extracted from print_timing log lines) ---
interface ModelStatusState {
  promptProgress: number | null;
  promptTokens: number | null;
  promptSpeed: number | null;
  genTokens: number | null;
  genAvgTps: number | null;
  gen3sTps: number | null;
  genMsPerToken: number | null;
  totalTimeMs: number | null;
  totalTokens: number | null;
}
const modelStatus: ModelStatusState = {
  promptProgress: null, promptTokens: null, promptSpeed: null,
  genTokens: null, genAvgTps: null, gen3sTps: null, genMsPerToken: null,
  totalTimeMs: null, totalTokens: null,
};

function updateModelStatus(timing: TimingData): void {
  switch (timing.type) {
    case 'prompt-progress':
      modelStatus.promptProgress = timing.progress;
      modelStatus.promptTokens = timing.nTokens;
      modelStatus.promptSpeed = timing.tokensPerSec;
      break;
    case 'prompt-eval':
      modelStatus.promptProgress = 1;
      modelStatus.promptTokens = timing.tokens;
      modelStatus.promptSpeed = timing.tokensPerSec;
      break;
    case 'gen-stats':
      modelStatus.genTokens = timing.nGen;
      modelStatus.genAvgTps = timing.tg;
      modelStatus.gen3sTps = timing.tg3s;
      break;
    case 'eval-time':
      modelStatus.genMsPerToken = timing.msPerToken;
      break;
    case 'total-time':
      modelStatus.totalTimeMs = timing.timeMs;
      modelStatus.totalTokens = timing.tokens;
      break;
  }
}

// Wire up llama process events → broadcast
llama.onLogLine = (line) => {
  const entry = toLogEntry(line);
  logCache.push(entry);
  if (logCache.length > LOG_CACHE_SIZE) logCache.shift();
  broadcast({ type: 'log-line', payload: entry });

  // Extract timing data for the Model Status panel
  const parsed = parseLogLine(line);
  if (parsed && parsed.func === 'print_timing') {
    const timing = parseTimingMessage(parsed.message);
    if (timing) {
      updateModelStatus(timing);
      broadcast({ type: 'model-status', payload: { ...modelStatus } });
    }
  }
};
llama.onStatusChange = (status) => broadcast({ type: 'process-status', payload: status });
llama.onMetrics = (metrics) => broadcast({ type: 'metrics', payload: metrics });

// --- Device detection & CUDA matching ---
let cudaMatchMap: Map<number, number> = new Map();

async function refreshDeviceMatch(): Promise<void> {
  if (!config.llamaCppPath) return;
  const devices = await listLlamaDevices(config.llamaCppPath);
  // We need current GPU names — query once
  const { queryGpus } = await import('./gpu.js');
  const gpus = await queryGpus();
  cudaMatchMap = matchCudaIndices(gpus.map((g) => g.name), devices);
}

// Refresh device match on startup and when config changes
refreshDeviceMatch();

// GPU polling → broadcast (with CUDA index attached)
const gpuPoller = startGpuPolling((gpus) => {
  const enriched: GpuInfo[] = gpus.map((g) => ({
    ...g,
    cudaIndex: cudaMatchMap.get(g.index) ?? null,
  }));
  broadcast({ type: 'gpu-stats', payload: enriched });
}, gpuIntervalMs);

// System polling (CPU / RAM / disk) → broadcast. Fixed 1s cadence; the metrics
// are cheap to sample so no user-configurable interval is needed.
let lastSystemStats: SystemStats | null = null;
const systemPoller = startSystemPolling((stats) => {
  lastSystemStats = stats;
  broadcast({ type: 'system-stats', payload: stats });
}, 1000);

app.get('/api/devices', async (_req, res) => {
  if (!config.llamaCppPath) {
    res.json([]);
    return;
  }
  const devices = await listLlamaDevices(config.llamaCppPath);
  res.json(devices);
});

// This app's own version (baked in at compile time from package.json)
app.get('/api/app-version', (_req, res) => {
  res.json({ version: APP_VERSION });
});

app.get('/api/version', async (_req, res) => {
  if (!config.llamaCppPath) {
    res.json({ version: null, commit: null, buildDate: null, backend: null, raw: [] });
    return;
  }
  const info = await getLlamaVersion(config.llamaCppPath);
  res.json(info);
});

// Check a specific path (used by the Environment dialog's refresh button)
app.post('/api/version/check', async (req, res) => {
  const p: string = req.body?.path || '';
  if (!p) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const info = await getLlamaVersion(p);
  // If all fields are null, the path is invalid (binary not found)
  const valid = info.version !== null || info.build !== null;
  res.json({ ...info, valid });
});

app.get('/api/gpu-interval', (_req, res) => {
  res.json({ intervalMs: gpuIntervalMs });
});

app.put('/api/gpu-interval', (req, res) => {
  const ms = Math.max(500, parseInt(req.body.intervalMs, 10) || 2000);
  gpuIntervalMs = ms;
  config.gpuIntervalMs = ms;
  saveConfig(config);
  gpuPoller.setInterval(ms);
  res.json({ intervalMs: ms });
});

app.get('/api/gpu-order', (_req, res) => {
  res.json({ sort: config.gpuSort, order: config.gpuOrder });
});

app.put('/api/gpu-order', (req, res) => {
  const { sort, order } = req.body;
  if (typeof sort === 'string') config.gpuSort = sort as GpuSortMode;
  if (Array.isArray(order)) config.gpuOrder = order;
  saveConfig(config);
  res.json({ sort: config.gpuSort, order: config.gpuOrder });
});

// --- REST API ---
app.get('/api/config', (_req, res) => {
  res.json(config);
});

app.put('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  saveConfig(config);
  res.json(config);
});

app.post('/api/launch', async (req, res) => {
  if (req.body) {
    config = { ...config, ...req.body };
    saveConfig(config);
  }
  await refreshDeviceMatch();
  metricsPoller.reset();
  startMetricsPolling();
  llama.launch(config);
  res.json({ status: llama.getStatus() });
});

// Launch router mode: generate a preset INI from the given model configs,
// write it to disk, and launch llama-server with --models-preset.
app.post('/api/launch-router', async (req, res) => {
  const { configIds } = req.body as { configIds?: string[] };
  if (!Array.isArray(configIds) || configIds.length === 0) {
    res.status(400).json({ error: 'configIds array required' });
    return;
  }

  const data = loadModels();
  const selected = data.configs.filter((c) => configIds.includes(c.id));
  if (selected.length === 0) {
    res.status(400).json({ error: 'No matching configs found' });
    return;
  }

  // Write the generated INI next to the configured router path (or .config/)
  const iniPath = config.routerIniPath || path.join(path.resolve(process.cwd(), '.config'), 'router.ini');
  try {
    fs.mkdirSync(path.dirname(iniPath), { recursive: true });
    fs.writeFileSync(iniPath, exportRouterIni(selected, loadParams()), 'utf-8');
  } catch (e) {
    res.status(500).json({ error: `Failed to write router INI: ${e}` });
    return;
  }

  await refreshDeviceMatch();
  metricsPoller.reset();
  startMetricsPolling();
  llama.launch({ ...config, routerIniPath: iniPath, modelPath: '' });
  res.json({ status: llama.getStatus(), routerIniPath: iniPath, models: selected.map((c) => c.alias) });
});

app.post('/api/stop', (_req, res) => {
  metricsPoller.stop();
  llama.stop();
  res.json({ status: llama.getStatus() });
});

// Full shutdown: stop the llama.cpp process and exit the Node server
app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true });
  gpuPoller.stop();
  systemPoller.stop();
  for (const client of sseClients) {
    client.end();
  }
  sseClients.clear();
  llama.stop();
  console.log('[server] shutdown requested, exiting…');
  setTimeout(() => process.exit(0), 300);
});

app.get('/api/status', (_req, res) => {
  res.json({
    status: llama.getStatus(),
    metrics: llama.getMetrics(),
    modelMetrics: metricsPoller.getMetrics(),
    systemStats: lastSystemStats,
    modelStatus: { ...modelStatus },
  });
});

// Clear the in-memory model status (resets all timing values to null)
app.post('/api/model-status/clear', (_req, res) => {
  modelStatus.promptProgress = null;
  modelStatus.promptTokens = null;
  modelStatus.promptSpeed = null;
  modelStatus.genTokens = null;
  modelStatus.genAvgTps = null;
  modelStatus.gen3sTps = null;
  modelStatus.genMsPerToken = null;
  modelStatus.totalTimeMs = null;
  modelStatus.totalTokens = null;
  broadcast({ type: 'model-status', payload: { ...modelStatus } });
  res.json({ ok: true });
});

// Clear the server-side log cache (prevents replay on reconnect)
app.post('/api/logs/clear', (_req, res) => {
  logCache.length = 0;
  res.json({ ok: true });
});

// --- Model Config API ---

// Ensure params.json exists on first run, or re-seed it when the bundled
// defaults drift from the saved file: new params added, or input types changed
// (e.g. 'number' → 'preset'). User param files from older app versions lack
// those, so we refresh from DEFAULT_PARAMS to keep the UI in sync.
{
  const existing = loadParams();
  const existingKeys = new Set(existing.map((p) => p.key));
  const needsReseed =
    existing.length === 0 ||
    DEFAULT_PARAMS.some((d) => !existingKeys.has(d.key)) ||
    !existing.every((p) => {
      const def = DEFAULT_PARAMS.find((d) => d.key === p.key);
      return def && def.inputType === p.inputType;
    });
  if (needsReseed) {
    saveParams(DEFAULT_PARAMS);
  }
}

app.get('/api/models', (_req, res) => {
  res.json(loadModels());
});

app.post('/api/models/configs', (req, res) => {
  const data = loadModels();
  const newConfig: ModelConfig = {
    id: generateId(),
    alias: req.body.alias || 'New Config',
    displayName: req.body.displayName || req.body.alias || 'New Config',
    notes: req.body.notes || '',
    modelPath: req.body.modelPath || '',
    mmproj: req.body.mmproj,
    chatTemplateFile: req.body.chatTemplateFile,
    params: req.body.params || {},
    paramOrder: req.body.paramOrder || [],
    includeInLaunch: true,
    isDefault: false,
  };
  data.configs.push(newConfig);
  data.configOrder = data.configs.map((cfg) => cfg.id);
  if (!data.defaultConfigId) data.defaultConfigId = newConfig.id;
  saveModels(data);
  res.json(newConfig);
});

app.put('/api/models/configs/reorder', (req, res) => {
  const data = loadModels();
  const orderedIds = Array.isArray(req.body?.configOrder)
    ? req.body.configOrder.filter((id: unknown) => typeof id === 'string')
    : [];

  const byId = new Map(data.configs.map((cfg) => [cfg.id, cfg]));
  const orderedConfigs: ModelConfig[] = [];
  const seen = new Set<string>();

  for (const id of orderedIds) {
    const cfg = byId.get(id);
    if (cfg && !seen.has(id)) {
      orderedConfigs.push(cfg);
      seen.add(id);
    }
  }
  for (const cfg of data.configs) {
    if (!seen.has(cfg.id)) {
      orderedConfigs.push(cfg);
      seen.add(cfg.id);
    }
  }

  data.configs = orderedConfigs;
  data.configOrder = orderedConfigs.map((cfg) => cfg.id);
  if (data.defaultConfigId && !orderedConfigs.some((cfg) => cfg.id === data.defaultConfigId)) {
    data.defaultConfigId = orderedConfigs[0]?.id || null;
  }
  saveModels(data);
  res.json({ configOrder: data.configOrder, configs: data.configs });
});

app.put('/api/models/configs/:id', (req, res) => {
  const data = loadModels();
  const idx = data.configs.findIndex((c) => c.id === req.params.id);
  if (idx === -1) {
    res.status(404).json({ error: 'Config not found' });
    return;
  }
  const updated = { ...data.configs[idx], ...req.body, id: data.configs[idx].id };
  data.configs[idx] = updated;
  if (updated.isDefault) {
    for (const c of data.configs) c.isDefault = false;
    updated.isDefault = true;
    data.defaultConfigId = updated.id;
  }
  saveModels(data);
  res.json(updated);
});

// Toggle whether a config is included in router launches (persisted checkbox state)
app.put('/api/models/configs/:id/launch-include', (req, res) => {
  const data = loadModels();
  const cfg = data.configs.find((c) => c.id === req.params.id);
  if (!cfg) {
    res.status(404).json({ error: 'Config not found' });
    return;
  }
  cfg.includeInLaunch = !!req.body?.include;
  saveModels(data);
  res.json(cfg);
});

app.delete('/api/models/configs/:id', (req, res) => {
  const data = loadModels();
  data.configs = data.configs.filter((c) => c.id !== req.params.id);
  data.configOrder = data.configs.map((cfg) => cfg.id);
  if (data.defaultConfigId === req.params.id) {
    data.defaultConfigId = data.configs[0]?.id || null;
    if (data.configs[0]) data.configs[0].isDefault = true;
  }
  saveModels(data);
  res.json({ ok: true });
});

app.post('/api/models/configs/:id/clone', (req, res) => {
  const data = loadModels();
  const src = data.configs.find((c) => c.id === req.params.id);
  if (!src) {
    res.status(404).json({ error: 'Config not found' });
    return;
  }
  const clone: ModelConfig = {
    ...src,
    id: generateId(),
    alias: (req.body.alias || src.alias + ' (copy)'),
    displayName: req.body.displayName || src.displayName + ' (copy)',
    isDefault: false,
  };
  data.configs.push(clone);
  data.configOrder = data.configs.map((cfg) => cfg.id);
  saveModels(data);
  res.json(clone);
});

// --- Templates API ---

app.get('/api/models/templates', (_req, res) => {
  res.json(loadModels().templates);
});

app.post('/api/models/templates', (req, res) => {
  const data = loadModels();
  const tpl: ConfigTemplate = {
    id: generateId(),
    name: req.body.name || 'New Template',
    description: req.body.description || '',
    params: req.body.params || {},
    paramOrder: req.body.paramOrder || [],
  };
  data.templates.push(tpl);
  saveModels(data);
  res.json(tpl);
});

app.delete('/api/models/templates/:id', (req, res) => {
  const data = loadModels();
  data.templates = data.templates.filter((t) => t.id !== req.params.id);
  saveModels(data);
  res.json({ ok: true });
});

// --- Params API ---

app.get('/api/params', (_req, res) => {
  res.json(loadParams());
});

app.post('/api/params/refresh', async (_req, res) => {
  // Fetch latest from llama.cpp GitHub README
  try {
    const response = await fetch('https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/cli/README.md');
    const text = await response.text();
    // For now, just confirm we fetched it successfully.
    // Full parsing would extract flag names and descriptions from the markdown.
    // We keep our curated DEFAULT_PARAMS as the source of truth for now,
    // but log that a refresh was attempted.
    console.log(`[params] Fetched llama.cpp README (${text.length} chars). Manual review needed to update params.json.`);
    res.json({ ok: true, message: 'Fetched latest README. Params file unchanged (manual curation required).' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Router INI Import/Export ---

app.post('/api/models/import-ini', (req, res) => {
  const content: string = req.body.content;
  if (!content) {
    res.status(400).json({ error: 'Missing "content" field' });
    return;
  }
  const params = loadParams();
  const imported = parseRouterIni(content, params);
  const data = loadModels();
  // Merge: add imported configs that don't already exist by alias
  for (const cfg of imported) {
    if (!data.configs.some((c) => c.alias === cfg.alias)) {
      data.configs.push(cfg);
    }
  }
  data.configOrder = data.configs.map((cfg) => cfg.id);
  if (!data.defaultConfigId && data.configs.length > 0) {
    data.defaultConfigId = data.configs[0].id;
    data.configs[0].isDefault = true;
  }
  saveModels(data);
  res.json({ imported: imported.length, total: data.configs.length });
});

app.get('/api/models/export-ini', (_req, res) => {
  const data = loadModels();
  const ini = exportRouterIni(data.configs, loadParams());
  res.type('text/plain').send(ini);
});

// Serve the built frontend (after all API routes).
// In a compiled Bun executable the client is embedded in the binary; otherwise
// fall back to serving dist/client from disk.
async function serveClientAsset(res: express.Response, relPath: string): Promise<boolean> {
  const file = embeddedClient.get(relPath);
  if (file) {
    // res.type() treats its argument as a literal MIME type unless it looks
    // like an extension — pass just the extension so the correct type is inferred.
    res.type(path.extname(relPath));
    res.send(Buffer.from(await file.arrayBuffer()));
    return true;
  }
  return false;
}

const clientDist = path.resolve(process.cwd(), 'dist/client');
if (embeddedClient.size > 0 || fs.existsSync(clientDist)) {
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const relPath = req.path.replace(/^\//, '');
    // SPA fallback: root path and unknown non-asset paths get index.html
    const isAsset = relPath.includes('.');
    const assetPath = (!relPath || (!isAsset && !embeddedClient.has(relPath))) ? 'index.html' : relPath;
    if (await serveClientAsset(res, assetPath)) return;
    if (fs.existsSync(clientDist)) {
      const filePath = path.join(clientDist, assetPath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.sendFile(filePath, (err) => { if (err) next(); });
        return;
      }
      // File not on disk — SPA fallback to index.html
      res.sendFile(path.join(clientDist, 'index.html'), (err) => { if (err) next(); });
      return;
    }
    next();
  });
}

// --- Start ---
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} is already in use. Stop the other process (e.g. lsof -i :${PORT}) and try again.`);
  } else {
    console.error('[server] failed to start:', err);
  }
  process.exit(1);
});

// --- Auto-launch browser (release mode only) ---
function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      console.warn(`[server] Failed to open browser: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.warn(`[server] Failed to spawn browser opener: ${(err as Error).message}`);
  }
}

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`[server] llama.cpp Config GUI v${APP_VERSION} — listening on ${url}`);

  // Auto-launch browser only in release mode (compiled binary) and when NO_BROWSER is not set
  if (embeddedClient.size > 0 && !process.env.NO_BROWSER) {
    openBrowser(url);
  }
});
