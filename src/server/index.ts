import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { loadConfig, saveConfig } from './config.js';
import { startGpuPolling } from './gpu.js';
import { startSystemPolling } from './system.js';
import { matchCudaIndices, parseTimingMessage } from './engines/llama.js';
import type { LogEntry, TimingData } from './engines/llama.js';
import { EngineManager } from './engines/manager.js';
import { instanceToLlamaConfig } from './engines/launch.js';
import {
  blankInstance,
  instancePort,
  isPortTaken,
  makeEngineId,
  normalizeEngineParams,
  normalizeEnvVars,
} from './engines/store.js';
import { loadTemplate, saveTemplate } from './engines/template.js';
import { isEngineKind, type EngineDefinition, type EngineInstance } from './engines/types.js';
import { getDriver } from './engines/driver.js';
import type { WsMessage, LlamaConfig, GpuInfo, LlamaDevice, GpuSortMode, SystemStats } from './types.js';
import { loadModels, saveModels, loadParams, saveParams, generateId, type ModelConfig, type ConfigTemplate, type ParamDef } from './modelConfig.js';
import { DEFAULT_PARAMS } from './params-default.js';
import { parseRouterIni, exportRouterIni } from './routerIni.js';
import { createProxyApp } from './proxy/index.js';
import { ModelRouter } from './proxy/router.js';
import { UsageDb } from './proxy/usageDb.js';
import { DEFAULT_PROXY_SETTINGS, normalizeProxySettings, type ProxyBackend, type ProxySettings, type UsageQuery, type UsageRecord } from './proxy/types.js';
import { isBackendKind, makeBackendId } from './proxy/backends.js';
import { ModelMetricsPoller } from './metricsPoller.js';
import { APP_VERSION } from './version.js';
import { applyUpdate, checkForUpdate } from './update.js';

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

const PORT = parseInt(process.env.PORT ?? '3001', 10);

export const app = express();
app.use(express.json());

// --- State ---
let config = loadConfig();

// Engine process registry (todo #21 Phase 1). During the transition the legacy
// endpoints (/api/launch, /api/stop, /api/status) operate on the *default
// instance*, whose id comes from the engines file (seeded from settings.json).
const engines = new EngineManager({
  onLogLine: (instanceId, line) => {
    // Log interpretation is per kind: the driver classifies lines, other kinds
    // fall back to plain (uncolored) entries.
    const driver = engines.driverFor(instanceId);
    const entry = driver.toLogEntry?.(line) ?? { raw: line, level: 'plain' as const };
    engines.pushLog(instanceId, entry);
    broadcast({ type: 'log-line', payload: { ...entry, instanceId } });

    // Extract timing data for the Model Status panel (llama.cpp only — other
    // drivers report no structured log format)
    const parsed = driver.parseLogLine?.(line) ?? null;
    if (parsed && parsed.func === 'print_timing') {
      const timing = parseTimingMessage(parsed.message);
      if (timing) {
        updateModelStatus(timing);
        broadcast({ type: 'model-status', payload: { ...modelStatus, instanceId } });
      }
    }
  },
  onStatusChange: (instanceId, status) => broadcast({ type: 'process-status', payload: { instanceId, status } }),
  onMetrics: (instanceId, metrics) => broadcast({ type: 'metrics', payload: { ...metrics, instanceId } }),
});
engines.migrateFromLegacy(config);

/** Instance backing the legacy launch/stop/status endpoints. */
function defaultInstanceId(): string {
  return engines.getDefaultInstanceId() ?? 'default';
}

/**
 * Build folder used for host-level probes (device listing, CUDA matching).
 * Follows the default instance's definition so multiple builds are supported
 * (todo #21 Phase 2); falls back to the legacy settings.json path while the
 * engines file has no definition yet.
 */
function defaultBuildPath(): string {
  const data = engines.getEngines();
  const inst = data.instances.find((i) => i.id === data.defaultInstanceId);
  const def = data.definitions.find((d) => d.id === inst?.definitionId);
  return def?.buildPath || config.llamaCppPath || '';
}

/**
 * Overlay the default instance's definition (build folder + env vars) onto a
 * legacy launch spec. The Environment dialog now edits definitions rather than
 * settings.json, so the legacy /api/launch endpoints must follow them.
 */
function applyDefaultDefinition(spec: LlamaConfig): LlamaConfig {
  const data = engines.getEngines();
  const inst = data.instances.find((i) => i.id === data.defaultInstanceId);
  const def = data.definitions.find((d) => d.id === inst?.definitionId);
  if (!def) return spec;
  return {
    ...spec,
    llamaCppPath: def.buildPath || spec.llamaCppPath,
    envVars: Object.keys(def.envVars).length > 0 ? def.envVars : spec.envVars,
  };
}

// --- Proxy gateway (docs/proxy-server.md) ---
const proxyRouter = new ModelRouter();
let proxyDb: UsageDb | null = null;
let proxyServer: http.Server | null = null;
let proxySettings: ProxySettings = normalizeProxySettings(config.proxy);

// Proxy log stream: startup/errors + one line per proxied request
const PROXY_LOG_CACHE_SIZE = 1024;
const proxyLogCache: LogEntry[] = [];

function proxyLog(level: 'I' | 'W' | 'E', message: string): void {
  // Proxy lines are our own format, never llama.cpp-structured → plain level.
  const entry: LogEntry = { raw: `[proxy] ${new Date().toISOString().slice(11, 23)} ${level} ${message}`, level: 'plain' };
  proxyLogCache.push(entry);
  if (proxyLogCache.length > PROXY_LOG_CACHE_SIZE) proxyLogCache.shift();
  broadcast({ type: 'proxy-log', payload: entry });
}

function proxyRequestLog(rec: UsageRecord): void {
  const tok = rec.inputTokens !== null || rec.outputTokens !== null
    ? ` ${rec.inputTokens ?? '?'}->${rec.outputTokens ?? '?'} tok` : '';
  const tps = rec.tokensPerSec !== null ? ` ${rec.tokensPerSec.toFixed(1)} t/s` : '';
  const est = rec.tokensEstimated ? ' (est)' : '';
  const level: 'I' | 'W' | 'E' = rec.status >= 500 ? 'E' : rec.status >= 400 ? 'W' : 'I';
  proxyLog(level, `${rec.backend.padEnd(10)} ${rec.model.padEnd(20)} ${rec.endpoint} ${rec.stream ? 'stream' : 'json'} ${rec.status} ${rec.totalDurationMs}ms${tok}${tps}${est}`);
}

function proxyLlamaAliases(): string[] {
  return loadModels().configs
    .filter((c) => c.includeInLaunch !== false && c.alias)
    .map((c) => c.alias);
}

function proxyLlamaBaseUrl(): string {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : (config.host || '127.0.0.1');
  return `http://${host}:${config.port}`;
}

function rebuildProxyRegistry(): void {
  proxyRouter.rebuild(proxySettings, proxyLlamaAliases());
}

function stopProxy(log = true): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    if (log) proxyLog('I', 'proxy stopped');
  }
  if (proxyDb) {
    proxyDb.close();
    proxyDb = null;
  }
  if (proxySettings.enabled) {
    proxySettings = { ...proxySettings, enabled: false };
    saveProxySettings();
  }
}

function startProxy(): void {
  stopProxy(false);
  proxySettings = { ...proxySettings, enabled: true };
  saveProxySettings();
  const dbPath = path.join(path.resolve(process.cwd(), '.config'), 'usage.db');
  try {
    proxyDb = new UsageDb(dbPath);
  } catch (e) {
    proxyLog('E', `failed to open usage db: ${e}`);
    return;
  }
  rebuildProxyRegistry();
  const proxyApp = createProxyApp({
    getSettings: () => proxySettings,
    router: proxyRouter,
    db: proxyDb,
    onUsage: (rec) => {
      broadcast({ type: 'proxy-usage', payload: rec });
      proxyRequestLog(rec);
    },
    onRecordError: (e) => proxyLog('E', `usage record failed: ${e}`),
  });
  proxyServer = http.createServer(proxyApp);
  proxyServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      proxyLog('E', `port ${proxySettings.port} is already in use; proxy not started`);
    } else {
      proxyLog('E', `server error: ${err.message}`);
    }
    proxyServer = null;
  });
  proxyServer.listen(proxySettings.port, proxySettings.host, () => {
    proxyLog('I', `OpenAI-compatible proxy listening on http://${proxySettings.host}:${proxySettings.port}`);
  });
}

function saveProxySettings(): void {
  config = { ...config, proxy: proxySettings };
  saveConfig(config);
}

// Daily retention purge of old usage rows
setInterval(() => {
  if (proxyDb) proxyDb.purge(proxySettings.usageRetentionDays);
}, 24 * 3600_000).unref();

function parseUsageQuery(req: express.Request): UsageQuery {
  const q: UsageQuery = {};
  if (typeof req.query.model === 'string') q.model = req.query.model;
  if (typeof req.query.backend === 'string') q.backend = req.query.backend as UsageQuery['backend'];
  if (typeof req.query.from === 'string') q.from = req.query.from;
  if (typeof req.query.to === 'string') q.to = req.query.to;
  if (typeof req.query.limit === 'string') q.limit = parseInt(req.query.limit, 10) || undefined;
  if (typeof req.query.offset === 'string') q.offset = parseInt(req.query.offset, 10) || undefined;
  return q;
}

function validateProxySettings(p: ProxySettings): string | null {
  if (p.port === PORT) return `Proxy port ${p.port} conflicts with the GUI server port ${PORT}`;
  if (p.port === config.port) return `Proxy port ${p.port} conflicts with llama-server port ${config.port}`;
  for (const b of p.backends) {
    if (b.baseUrl) {
      try { new URL(b.baseUrl); } catch { return `Invalid URL for backend "${b.name}"`; }
    }
  }
  const backendIds = new Set(p.backends.map((b) => b.id));
  if (backendIds.size !== p.backends.length) return 'Backend ids must be unique';
  const aliases = new Set(proxyLlamaAliases());
  const seen = new Set<string>();
  for (const m of p.models) {
    if (aliases.has(m.model) || seen.has(m.model)) return `Duplicate model alias "${m.model}"`;
    seen.add(m.model);
  }
  return null;
}

/** Fetch the upstream's GET /v1/models list (OpenAI-compatible). */
function proxyFetchModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL('/v1/models', baseUrl); } catch { return reject(new Error('invalid baseUrl')); }
    const req = http.get(target, {
      timeout: 4000,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { chunks.push(c); size += c.length; if (size > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const ids = Array.isArray(data?.data) ? data.data.map((m: { id?: unknown }) => m?.id).filter((x: unknown): x is string => typeof x === 'string') : [];
          resolve(ids);
        } catch { reject(new Error('invalid models response')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (e) => reject(e));
  });
}

function proxyHealthProbe(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!baseUrl) return resolve(false);
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.get(baseUrl, { timeout: 1500 }, (res) => {
        res.resume();
        done((res.statusCode ?? 0) < 500);
      });
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}
let gpuIntervalMs = config.gpuIntervalMs || 2000;

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
  // Replay log history on connect (default instance — per-instance replay lands
  // with the client Engines tab)
  const history = engines.getLogCache(defaultInstanceId());
  if (history.length > 0) {
    res.write(`event: log-history\ndata: ${JSON.stringify([...history])}\n\n`);
  }
  if (proxyLogCache.length > 0) {
    res.write(`event: proxy-log-history\ndata: ${JSON.stringify([...proxyLogCache])}\n\n`);
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

// --- Device detection & CUDA matching ---
let cudaMatchMap: Map<number, number> = new Map();

/** Device listing for the default definition, through its kind's driver. */
async function defaultDevices(): Promise<LlamaDevice[]> {
  const buildPath = defaultBuildPath();
  if (!buildPath) return [];
  const data = engines.getEngines();
  const inst = data.instances.find((i) => i.id === data.defaultInstanceId);
  const def = data.definitions.find((d) => d.id === inst?.definitionId);
  const list = getDriver(def?.kind).listDevices;
  return list ? list(buildPath) : [];
}

async function refreshDeviceMatch(): Promise<void> {
  const buildPath = defaultBuildPath();
  if (!buildPath) return;
  const devices = await defaultDevices();
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
  res.json(await defaultDevices());
});

// This app's own version (baked in at compile time from package.json)
app.get('/api/app-version', (_req, res) => {
  res.json({ version: APP_VERSION });
});

// --- Self-update (GitHub Releases) ---
// Check whether a newer release exists; release assets are matched per platform.
app.get('/api/update/check', async (_req, res) => {
  try {
    const check = await checkForUpdate(APP_VERSION);
    // Self-replacement only works inside the compiled binary (we know its path)
    res.json({ ...check, canApply: embeddedClient.size > 0 && check.assetName !== null });
  } catch (e) {
    res.status(502).json({ error: `update check failed: ${(e as Error).message}` });
  }
});

// Download the latest release binary and replace the running executable.
app.post('/api/update/apply', async (_req, res) => {
  if (embeddedClient.size === 0) {
    res.status(400).json({ error: 'self-update is only available in the compiled release binary' });
    return;
  }
  try {
    const check = await checkForUpdate(APP_VERSION);
    if (!check.available) {
      res.status(400).json({ error: `already on the latest version (${check.latest})` });
      return;
    }
    const target = process.execPath;
    const binaryName = path.basename(target);
    const result = await applyUpdate(check, target, binaryName);
    proxyLog('I', `updated to v${result.latest} — restart to run the new version`);
    res.json({ ok: true, latest: result.latest, restartRequired: true, backupPath: result.backupPath });
  } catch (e) {
    proxyLog('E', `update failed: ${(e as Error).message}`);
    res.status(500).json({ error: `update failed: ${(e as Error).message}` });
  }
});

// Restart the GUI server process (llama.cpp child is stopped first).
// The compiled binary re-spawns itself detached; in dev, tsx watch restarts
// the child when it exits.
app.post('/api/restart', (_req, res) => {
  res.json({ ok: true });
  gpuPoller.stop();
  systemPoller.stop();
  for (const client of sseClients) {
    client.end();
  }
  sseClients.clear();
  engines.stopAll();
  if (embeddedClient.size > 0) {
    try {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', (err) => console.error(`[server] restart failed: ${err.message}`));
      child.unref();
    } catch (e) {
      console.error(`[server] restart spawn failed: ${(e as Error).message}`);
    }
  }
  console.log('[server] restart requested, exiting…');
  setTimeout(() => process.exit(0), 300);
});

app.get('/api/version', async (_req, res) => {
  const buildPath = defaultBuildPath();
  if (!buildPath) {
    res.json({ version: null, commit: null, buildDate: null, backend: null, raw: [] });
    return;
  }
  const data = engines.getEngines();
  const inst = data.instances.find((i) => i.id === data.defaultInstanceId);
  const def = data.definitions.find((d) => d.id === inst?.definitionId);
  const driver = getDriver(def?.kind);
  if (!driver.getVersion) {
    res.json({ version: null, build: null, commit: null, compiler: null, backend: null, raw: [] });
    return;
  }
  const info = await driver.getVersion(buildPath);
  res.json(info);
});

// Check a specific path (used by the Environment dialog's refresh button).
// Optional `kind` selects the driver; defaults to llama.cpp for back-compat.
app.post('/api/version/check', async (req, res) => {
  const p: string = req.body?.path || '';
  if (!p) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const kind = isEngineKind(req.body?.kind) ? req.body.kind : 'llamacpp';
  const driver = getDriver(kind);
  if (!driver.getVersion) {
    res.json({ version: null, build: null, commit: null, compiler: null, backend: null, raw: [], valid: fs.existsSync(p), kind });
    return;
  }
  const info = await driver.getVersion(p);
  // If all fields are null, the path is invalid (binary not found)
  const valid = info.version !== null || info.build !== null;
  res.json({ ...info, valid, kind });
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

// --- Engine API (todo #21 Phase 1 step 3) ---
// Definitions (build folder + env) and instances (launchable entries). The
// legacy /api/launch, /api/stop and /api/status endpoints keep operating on the
// default instance while the client migrates.

app.get('/api/engines', (_req, res) => {
  const data = engines.getEngines();
  res.json({
    ...data,
    instances: data.instances.map((i) => ({
      ...i,
      status: engines.getStatus(i.id),
    })),
  });
});

app.post('/api/engines/definitions', (req, res) => {
  const data = engines.getEngines();
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const kind = isEngineKind(req.body?.kind) ? req.body.kind : 'llamacpp';
  const def: EngineDefinition = {
    id: makeEngineId(name, data.definitions),
    name,
    kind,
    buildPath: typeof req.body?.buildPath === 'string' ? req.body.buildPath : '',
    envVars: normalizeEnvVars(req.body?.envVars),
  };
  data.definitions.push(def);
  engines.saveEngines(data);
  res.json(def);
});

app.put('/api/engines/definitions/:id', (req, res) => {
  const data = engines.getEngines();
  const def = data.definitions.find((d) => d.id === req.params.id);
  if (!def) {
    res.status(404).json({ error: `Definition "${req.params.id}" not found` });
    return;
  }
  if (typeof req.body?.name === 'string' && req.body.name.trim()) def.name = req.body.name.trim();
  if (isEngineKind(req.body?.kind)) def.kind = req.body.kind;
  if (typeof req.body?.buildPath === 'string') def.buildPath = req.body.buildPath;
  if (req.body?.envVars !== undefined) def.envVars = normalizeEnvVars(req.body.envVars);
  engines.saveEngines(data);
  // Device matching depends on the default definition's build folder
  void refreshDeviceMatch();
  res.json(def);
});

app.delete('/api/engines/definitions/:id', (req, res) => {
  const data = engines.getEngines();
  const idx = data.definitions.findIndex((d) => d.id === req.params.id);
  if (idx < 0) {
    res.status(404).json({ error: `Definition "${req.params.id}" not found` });
    return;
  }
  if (data.instances.some((i) => i.definitionId === req.params.id)) {
    res.status(409).json({ error: 'Definition is used by an instance' });
    return;
  }
  data.definitions.splice(idx, 1);
  engines.saveEngines(data);
  res.json({ status: 'deleted' });
});

// Validate a definition's saved build folder using its kind's driver. Kinds
// without a version probe report valid when the folder exists.
app.get('/api/engines/definitions/:id/version', async (req, res) => {
  const def = engines.getEngines().definitions.find((d) => d.id === req.params.id);
  if (!def) {
    res.status(404).json({ error: `Definition "${req.params.id}" not found` });
    return;
  }
  if (!def.buildPath) {
    res.json({ valid: false, error: 'buildPath is not set' });
    return;
  }
  const driver = getDriver(def.kind);
  if (!driver.getVersion) {
    res.json({ valid: fs.existsSync(def.buildPath), kind: def.kind, note: 'no version probe for this kind yet' });
    return;
  }
  const info = await driver.getVersion(def.buildPath);
  const valid = info.version !== null || info.build !== null;
  res.json({ ...info, valid, kind: def.kind });
});

// Compose the command line a launch would run, for the editor's Command tab.
// Takes the *draft* from the dialog (unsaved edits included) and goes through
// the exact same driver path as a real launch, so the preview cannot drift
// from what would actually be spawned.
app.post('/api/engines/command', (req, res) => {
  const body = req.body ?? {};
  const data = engines.getEngines();
  const def = data.definitions.find((d) => d.id === body.definitionId);
  const executable = typeof body.executable === 'string' ? body.executable.trim() : '';
  if (!executable) {
    res.status(400).json({ error: 'executable is required' });
    return;
  }
  const kind = isEngineKind(body.kind) ? body.kind : def?.kind ?? 'llamacpp';
  const buildPath = path.dirname(executable);
  const binary = path.basename(executable);
  const driver = getDriver(kind);

  const spec = instanceToLlamaConfig(
    {
      id: '__preview__',
      name: '__preview__',
      notes: '',
      definitionId: def?.id ?? 'default',
      binary,
      params: normalizeEngineParams(body.params),
      routerMode: false,
      modelConfigIds: [],
    } as EngineInstance,
    {
      id: def?.id ?? '__preview__',
      name: def?.name ?? 'preview',
      kind,
      buildPath,
      envVars: normalizeEnvVars(body.envVars),
    },
  );

  const args = driver.buildArgs(spec);
  res.json({
    binaryPath: path.join(buildPath, driver.binaryName(spec)),
    args,
    envVars: spec.envVars,
    cwd: buildPath,
    exists: fs.existsSync(path.join(buildPath, driver.binaryName(spec))),
  });
});

// Ordered parameter list auto-filled when a new instance of a kind is
// created. --host/--port/--api-key are ordinary params here, not fields.
app.get('/api/engines/templates/:kind', (req, res) => {
  const kind = isEngineKind(req.params.kind) ? req.params.kind : 'llamacpp';
  res.json({ kind, params: loadTemplate(kind) });
});

app.put('/api/engines/templates/:kind', (req, res) => {
  const kind = isEngineKind(req.params.kind) ? req.params.kind : 'llamacpp';
  const params = saveTemplate(kind, req.body?.params);
  res.json({ kind, params });
});

app.post('/api/engines/instances', (req, res) => {
  const data = engines.getEngines();
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const def = data.definitions.find((d) => d.id === req.body?.definitionId);
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!def) {
    res.status(400).json({ error: 'a valid definitionId is required' });
    return;
  }
  const inst = blankInstance(name, def, data);
  const port = instancePort(inst.params);
  if (port !== null && isPortTaken(data, port)) {
    res.status(409).json({ error: `Port ${port} is already used by another instance` });
    return;
  }
  data.instances.push(inst);
  if (!data.defaultInstanceId) data.defaultInstanceId = inst.id;
  engines.saveEngines(data);
  res.json(inst);
});

app.put('/api/engines/instances/:id', (req, res) => {
  const data = engines.getEngines();
  const inst = data.instances.find((i) => i.id === req.params.id);
  if (!inst) {
    res.status(404).json({ error: `Instance "${req.params.id}" not found` });
    return;
  }
  const body = req.body ?? {};
  // --port is a plain param; conflict-check it against the other instances
  // *before* touching the stored instance, so a rejected edit leaves no trace.
  const nextParams = body.params !== undefined ? normalizeEngineParams(body.params) : inst.params;
  const nextPort = instancePort(nextParams);
  if (nextPort !== null && isPortTaken(data, nextPort, inst.id)) {
    res.status(409).json({ error: `Port ${nextPort} is already used by another instance` });
    return;
  }
  if (typeof body.name === 'string' && body.name.trim()) inst.name = body.name.trim();
  if (typeof body.notes === 'string') inst.notes = body.notes;
  if (typeof body.binary === 'string' && body.binary) inst.binary = body.binary;
  if (typeof body.routerMode === 'boolean') inst.routerMode = body.routerMode;
  if (Array.isArray(body.modelConfigIds)) inst.modelConfigIds = body.modelConfigIds.filter((x: unknown): x is string => typeof x === 'string');
  if (typeof body.modelPath === 'string') inst.modelPath = body.modelPath || undefined;
  if (typeof body.mmproj === 'string') inst.mmproj = body.mmproj || undefined;
  inst.params = nextParams;
  if (typeof body.definitionId === 'string' && data.definitions.some((d) => d.id === body.definitionId)) {
    inst.definitionId = body.definitionId;
  }
  engines.saveEngines(data);
  res.json(inst);
});

app.delete('/api/engines/instances/:id', (req, res) => {
  const id = req.params.id;
  const data = engines.getEngines();
  const idx = data.instances.findIndex((i) => i.id === id);
  if (idx < 0) {
    res.status(404).json({ error: `Instance "${id}" not found` });
    return;
  }
  engines.stop(id);
  data.instances.splice(idx, 1);
  if (data.defaultInstanceId === id) data.defaultInstanceId = data.instances[0]?.id ?? null;
  engines.saveEngines(data);
  res.json({ status: 'deleted' });
});

// Launch an engine instance from its stored definition + settings.
app.post('/api/engines/instances/:id/launch', async (req, res) => {
  const id = req.params.id;
  const data = engines.getEngines();
  const inst = data.instances.find((i) => i.id === id);
  if (!inst) {
    res.status(404).json({ error: `Instance "${id}" not found` });
    return;
  }
  const def = data.definitions.find((d) => d.id === inst.definitionId);
  if (!def) {
    res.status(400).json({ error: `Instance references missing definition "${inst.definitionId}"` });
    return;
  }
  // Non-llama kinds launch the executable named on the instance (passthrough
  // driver), so a binary must be set — llama.cpp falls back to llama-server.
  if (def.kind !== 'llamacpp' && !inst.binary.trim()) {
    res.status(400).json({ error: 'Set an executable name for this engine before launching' });
    return;
  }

  let routerIniPath: string | undefined;
  // Router mode is a llama.cpp feature (--models-preset); other kinds ignore it.
  if (inst.routerMode && def.kind === 'llamacpp') {
    const modelsData = loadModels();
    const selected = modelsData.configs.filter((c) => inst.modelConfigIds.includes(c.id));
    if (selected.length === 0) {
      res.status(400).json({ error: 'Router mode requires at least one model config' });
      return;
    }
    routerIniPath = path.join(path.resolve(process.cwd(), '.config'), `router-${inst.id}.ini`);
    try {
      fs.mkdirSync(path.dirname(routerIniPath), { recursive: true });
      fs.writeFileSync(routerIniPath, exportRouterIni(selected, loadParams()), 'utf-8');
    } catch (e) {
      res.status(500).json({ error: `Failed to write router INI: ${e}` });
      return;
    }
  }

  const spec = instanceToLlamaConfig(inst, def, routerIniPath);
  await refreshDeviceMatch();
  metricsPoller.reset();
  startMetricsPolling();
  engines.launch(id, spec);
  res.json({ status: engines.getStatus(id), routerIniPath: routerIniPath ?? null });
});

app.post('/api/engines/instances/:id/stop', (req, res) => {
  const id = req.params.id;
  if (!engines.getEngines().instances.some((i) => i.id === id)) {
    res.status(404).json({ error: `Instance "${id}" not found` });
    return;
  }
  engines.stop(id);
  res.json({ status: engines.getStatus(id) });
});

app.post('/api/launch', async (req, res) => {
  if (req.body) {
    config = { ...config, ...req.body };
    saveConfig(config);
  }
  await refreshDeviceMatch();
  metricsPoller.reset();
  startMetricsPolling();
  engines.launch(defaultInstanceId(), applyDefaultDefinition(config));
  res.json({ status: engines.getStatus(defaultInstanceId()) });
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
  engines.launch(defaultInstanceId(), applyDefaultDefinition({ ...config, routerIniPath: iniPath, modelPath: '' }));
  res.json({ status: engines.getStatus(defaultInstanceId()), routerIniPath: iniPath, models: selected.map((c) => c.alias) });
});

app.post('/api/stop', (_req, res) => {
  metricsPoller.stop();
  engines.stop(defaultInstanceId());
  res.json({ status: engines.getStatus(defaultInstanceId()) });
});

// Full shutdown: stop every engine instance and exit the Node server
app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true });
  gpuPoller.stop();
  systemPoller.stop();
  for (const client of sseClients) {
    client.end();
  }
  sseClients.clear();
  engines.stopAll();
  console.log('[server] shutdown requested, exiting…');
  setTimeout(() => process.exit(0), 300);
});

app.get('/api/status', (_req, res) => {
  const id = defaultInstanceId();
  res.json({
    status: engines.getStatus(id),
    metrics: engines.getMetrics(id),
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
  engines.clearLogs(defaultInstanceId());
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
  rebuildProxyRegistry();
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
  rebuildProxyRegistry();
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
  rebuildProxyRegistry();
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
  rebuildProxyRegistry();
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
  rebuildProxyRegistry();
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
  rebuildProxyRegistry();
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
  rebuildProxyRegistry();
  res.json(tpl);
});

app.delete('/api/models/templates/:id', (req, res) => {
  const data = loadModels();
  data.templates = data.templates.filter((t) => t.id !== req.params.id);
  saveModels(data);
  rebuildProxyRegistry();
  res.json({ ok: true });
});

// --- Params API ---

// Per-kind param catalog (?kind=audio etc). llama.cpp is the default and keeps
// the original params.json file.
app.get('/api/params', (req, res) => {
  const kind = isEngineKind(req.query.kind) ? req.query.kind : undefined;
  res.json(loadParams(kind));
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
  rebuildProxyRegistry();
  res.json({ imported: imported.length, total: data.configs.length });
});

app.get('/api/models/export-ini', (_req, res) => {
  const data = loadModels();
  const ini = exportRouterIni(data.configs, loadParams());
  res.type('text/plain').send(ini);
});

// --- Proxy management API (docs/proxy-server.md §7) ---

app.post('/api/proxy/logs/clear', (_req, res) => {
  proxyLogCache.length = 0;
  res.json({ status: 'cleared' });
});

app.post('/api/proxy/start', (_req, res) => {
  if (proxyServer) {
    res.json({ running: true, note: 'already running' });
    return;
  }
  startProxy();
  res.json({ running: proxyServer !== null });
});

app.post('/api/proxy/stop', (_req, res) => {
  stopProxy();
  res.json({ running: proxyServer !== null });
});

app.post('/api/proxy/restart', (_req, res) => {
  startProxy();
  res.json({ running: proxyServer !== null });
});

app.post('/api/proxy/backends', (req, res) => {
  const body = req.body as { name?: string; kind?: string; baseUrl?: string; apiKey?: string; enabled?: boolean };
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!isBackendKind(body.kind)) {
    res.status(400).json({ error: 'kind must be one of llamacpp|audio|sdiffusion|custom' });
    return;
  }
  if (typeof body.baseUrl !== 'string' || !body.baseUrl) {
    res.status(400).json({ error: 'baseUrl is required' });
    return;
  }
  try { new URL(body.baseUrl); } catch {
    res.status(400).json({ error: 'baseUrl is not a valid URL' });
    return;
  }
  const backend: ProxyBackend = {
    id: makeBackendId(name, proxySettings.backends),
    name,
    kind: body.kind,
    baseUrl: body.baseUrl,
    enabled: body.enabled !== false,
    ...(typeof body.apiKey === 'string' && body.apiKey ? { apiKey: body.apiKey } : {}),
  };
  proxySettings.backends.push(backend);
  saveProxySettings();
  rebuildProxyRegistry();
  res.json(backend);
});

app.post('/api/proxy/probe-models', async (req, res) => {
  // Verify a URL and list hosted models without persisting anything — used by the
  // backend edit dialog so unsaved URL/key edits can be tested before saving.
  const body = req.body as { baseUrl?: string; apiKey?: string };
  if (typeof body?.baseUrl !== 'string' || !body.baseUrl) {
    res.status(400).json({ error: 'baseUrl is required' });
    return;
  }
  try { new URL(body.baseUrl); } catch {
    res.status(400).json({ error: 'baseUrl is not a valid URL' });
    return;
  }
  try {
    const models = await proxyFetchModels(body.baseUrl, typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : undefined);
    res.json({ models });
  } catch (e) {
    res.status(502).json({ error: `Failed to fetch models from ${body.baseUrl}: ${e instanceof Error ? e.message : e}` });
  }
});

app.post('/api/proxy/backends/:id/refresh', async (req, res) => {
  const b = proxySettings.backends.find((x) => x.id === req.params.id);
  if (!b) {
    res.status(404).json({ error: `Backend "${req.params.id}" not found` });
    return;
  }
  try {
    const models = await proxyFetchModels(b.baseUrl, b.apiKey);
    b.models = models;
    b.modelsFetchedAt = new Date().toISOString();
    saveProxySettings();
    rebuildProxyRegistry();
    proxyLog('I', `models refreshed for "${b.name}": ${models.length} model(s)`);
    res.json({ models, modelsFetchedAt: b.modelsFetchedAt });
  } catch (e) {
    res.status(502).json({ error: `Failed to fetch models from ${b.baseUrl}: ${e instanceof Error ? e.message : e}` });
  }
});

app.put('/api/proxy/backends/:id', (req, res) => {
  const b = proxySettings.backends.find((x) => x.id === req.params.id);
  if (!b) {
    res.status(404).json({ error: `Backend "${req.params.id}" not found` });
    return;
  }
  const body = req.body as { name?: string; kind?: string; baseUrl?: string; apiKey?: string; enabled?: boolean };
  if (typeof body.name === 'string' && body.name.trim()) b.name = body.name.trim();
  if (body.kind !== undefined) {
    if (!isBackendKind(body.kind)) {
      res.status(400).json({ error: 'kind must be one of llamacpp|audio|sdiffusion|custom' });
      return;
    }
    b.kind = body.kind;
  }
  if (typeof body.baseUrl === 'string' && body.baseUrl) {
    try { new URL(body.baseUrl); } catch {
      res.status(400).json({ error: 'baseUrl is not a valid URL' });
      return;
    }
    b.baseUrl = body.baseUrl;
  }
  if (typeof body.apiKey === 'string') {
    if (body.apiKey) b.apiKey = body.apiKey;
    else delete b.apiKey;
  }
  if (typeof body.enabled === 'boolean') b.enabled = body.enabled;
  saveProxySettings();
  rebuildProxyRegistry();
  res.json(b);
});

app.delete('/api/proxy/backends/:id', (req, res) => {
  const idx = proxySettings.backends.findIndex((x) => x.id === req.params.id);
  if (idx < 0) {
    res.status(404).json({ error: `Backend "${req.params.id}" not found` });
    return;
  }
  const [removed] = proxySettings.backends.splice(idx, 1);
  // Routes pointing at the removed backend become unroutable; drop them too.
  proxySettings.models = proxySettings.models.filter((m) => m.backend !== removed.id);
  saveProxySettings();
  rebuildProxyRegistry();
  res.json({ status: 'deleted' });
});

app.get('/api/proxy/settings', (_req, res) => {
  res.json(proxySettings);
});

app.put('/api/proxy/settings', (req, res) => {
  const next = normalizeProxySettings({ ...proxySettings, ...(req.body as Partial<ProxySettings>) });
  const err = validateProxySettings(next);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  const wasRunning = proxyServer !== null;
  const portChanged = next.port !== proxySettings.port || next.host !== proxySettings.host;
  proxySettings = next;
  saveProxySettings();
  rebuildProxyRegistry();
  if (wasRunning && portChanged) startProxy();
  res.json(proxySettings);
});

app.get('/api/proxy/status', async (_req, res) => {
  const health: Record<string, boolean> = {};
  await Promise.all(
    proxySettings.backends.map(async (b) => {
      health[b.id] = b.enabled ? await proxyHealthProbe(b.baseUrl) : false;
    }),
  );
  res.json({
    running: proxyServer !== null,
    url: `http://${proxySettings.host}:${proxySettings.port}`,
    backends: health,
    models: proxyRouter.listRoutes(),
  });
});

app.get('/api/proxy/usage', (req, res) => {
  if (!proxyDb) {
    res.json({ rows: [], note: 'proxy usage db not open' });
    return;
  }
  res.json({ rows: proxyDb.query(parseUsageQuery(req)) });
});

app.get('/api/proxy/usage/summary', (req, res) => {
  if (!proxyDb) {
    res.json({ rows: [] });
    return;
  }
  const q = parseUsageQuery(req);
  res.json({ rows: proxyDb.summary({ from: q.from, to: q.to }) });
});

app.get('/api/proxy/usage/export', (req, res) => {
  if (!proxyDb) {
    res.status(404).json({ error: 'usage db not open' });
    return;
  }
  const rows = proxyDb.query({ ...parseUsageQuery(req), limit: 1000, offset: 0 });
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'request_id,timestamp,model,backend,endpoint,stream,status,input_tokens,output_tokens,cached_tokens,tokens_estimated,total_ms,ttfb_ms,tokens_per_sec,client_ip,error';
  const lines = rows.map((r: UsageRecord) => [
    r.requestId, r.timestamp, r.model, r.backend, r.endpoint, r.stream ? 1 : 0, r.status,
    r.inputTokens, r.outputTokens, r.cachedTokens, r.tokensEstimated ? 1 : 0, r.totalDurationMs,
    r.ttfbMs, r.tokensPerSec, r.clientIp, r.errorMessage,
  ].map(esc).join(','));
  res.type('text/csv').send([header, ...lines].join('\n'));
});

/** Find a declared route; when several share an alias, backend/backendModel pick one. */
function findDeclaredRoute(model: string, backend?: string, backendModel?: string) {
  const matches = proxySettings.models.filter((m) => m.model === model);
  if (matches.length <= 1) return matches[0];
  return matches.find((m) => m.backend === backend && (m.backendModel ?? '') === (backendModel ?? ''))
    ?? matches.find((m) => m.backend === backend)
    ?? matches.find((m) => m.active)
    ?? matches[0];
}

app.post('/api/proxy/models', (req, res) => {
  const body = req.body as { model?: string; backend?: string; backendModel?: string; enabled?: boolean; active?: boolean };
  if (!body?.model || !proxySettings.backends.some((b) => b.id === body.backend)) {
    res.status(400).json({ error: 'model and a valid backend id are required' });
    return;
  }
  if (proxyLlamaAliases().includes(body.model)) {
    res.status(409).json({ error: `Model alias "${body.model}" already exists` });
    return;
  }
  // Duplicate aliases are allowed (same client name -> different upstreams); the
  // first route for an alias is active unless another one already is.
  const anyActive = proxySettings.models.some((m) => m.model === body.model && m.active);
  const active = body.active === true || !anyActive;
  if (active) proxySettings.models.forEach((m) => { if (m.model === body.model) m.active = false; });
  proxySettings.models.push({
    model: body.model,
    backend: body.backend!,
    backendModel: body.backendModel,
    enabled: body.enabled !== false,
    active,
  });
  saveProxySettings();
  rebuildProxyRegistry();
  res.json(proxySettings.models);
});

app.put('/api/proxy/models/:model', (req, res) => {
  const body = req.body as { backend?: string; backendModel?: string; enabled?: boolean; active?: boolean };
  const m = findDeclaredRoute(req.params.model, body.backend, body.backendModel);
  if (!m) {
    res.status(404).json({ error: `Model "${req.params.model}" not found` });
    return;
  }
  if (typeof body.backendModel === 'string') m.backendModel = body.backendModel;
  if (typeof body.enabled === 'boolean') m.enabled = body.enabled;
  if (body.active === true) {
    // Exactly one live route per alias: activating one deactivates its twins.
    proxySettings.models.forEach((x) => {
      if (x.model === m.model && x !== m) x.active = false;
    });
    m.active = true;
  } else if (body.active === false && m.active) {
    // Never leave an alias without a live route: promote a twin first.
    const other = proxySettings.models.find((x) => x.model === m.model && x !== m);
    if (other) other.active = true;
    m.active = false;
  }
  saveProxySettings();
  rebuildProxyRegistry();
  res.json(m);
});

app.delete('/api/proxy/models/:model', (req, res) => {
  const backend = typeof req.query.backend === 'string' ? req.query.backend : undefined;
  const backendModel = typeof req.query.backendModel === 'string' ? req.query.backendModel : undefined;
  const target = findDeclaredRoute(req.params.model, backend, backendModel);
  const idx = target ? proxySettings.models.indexOf(target) : -1;
  if (idx < 0) {
    res.status(404).json({ error: `Model "${req.params.model}" not found` });
    return;
  }
  const wasActive = target!.active === true;
  const alias = target!.model;
  proxySettings.models.splice(idx, 1);
  // Deleting the live route promotes a remaining twin so the alias stays usable.
  if (wasActive) {
    const other = proxySettings.models.find((x) => x.model === alias);
    if (other) other.active = true;
  }
  saveProxySettings();
  rebuildProxyRegistry();
  res.json({ status: 'deleted' });
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
  if (proxySettings.autoStart) startProxy();

  // Auto-launch browser only in release mode (compiled binary) and when NO_BROWSER is not set
  if (embeddedClient.size > 0 && !process.env.NO_BROWSER) {
    openBrowser(url);
  }
});
