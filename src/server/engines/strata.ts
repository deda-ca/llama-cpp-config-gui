/**
 * Strata engine config (docs/todo.md #21 Phase 4, #22).
 *
 * A strata deployment is described by one JSON file (`strata-<model>.json`)
 * covering three layers: the `strata` engine binary and its `strata generate`
 * flags (`args`), the `serve/server.py` HTTP server options (top-level keys),
 * and an optional `vision` encoder. This module is the single mapping between
 * that file format and the GUI's `StrataConfig`, in both directions.
 *
 * Round-trip guarantee: importing a file and exporting it back preserves every
 * key, including ones the UI has no field for (`gpus_asked`, `gpu_order`,
 * `layer_split`, `lib_dirs`, `log`, …). Those ride in `StrataConfig.extra`
 * (and `vision.extra`) untouched.
 *
 * Launch note: `serve/server.py` reads `port` ONLY from `--port`, never from
 * the config file, so `port` is modelled as a server argument and always
 * emitted on the command line.
 */

import path from 'path';
import { configDir } from '../config.js';
import { enabledParams } from './args.js';
import { normalizeEngineParams } from './store.js';
import type { EngineParam, StrataConfig, StrataVisionConfig } from './types.js';

/**
 * serve/server.py options that map to a top-level config key rather than their
 * own flag spelling (`--api-key` -> "api_key"). Flags not listed here convert
 * by kebab->snake (`--idle-unload` -> "idle_unload"), which covers every
 * option the server accepts.
 */
const SERVER_KEY_ALIASES: Record<string, string> = {
  '--api-key': 'api_key',
  '--no-api-key': 'api_key',
  '--mcp-config': 'mcp_config',
  '--ready-file': 'ready_file',
  '--slot-save-path': 'slot_save_path',
  '--api-monitor': 'api_monitor',
  '--idle-unload': 'idle_unload_s',
  '--min-free-vram-mib': 'min_free_vram_mib',
  '--before-load': 'before_load',
  '--batch-groups': 'batch_groups',
  '--batch-telemetry': 'batch_telemetry',
  '--no-batch-telemetry': 'batch_telemetry',
  '--fit-max-tokens': 'fit_max_tokens',
  '--no-fit-max-tokens': 'fit_max_tokens',
  '--open': 'open_browser',
  '--lazy': 'lazy_load',
  '--script-cycle': 'script_cycle',
  '--script-delay': 'script_delay',
  '--owner-fd': 'owner_fd',
};

/** Config keys that are engine-owned (never server options). */
const ENGINE_KEYS = new Set(['exe', 'args', 'cwd', 'tokenizer', 'model_name', 'vision']);

/**
 * Top-level config keys that `serve/server.py` reads as its own options — the
 * CLI flags from its argparse block, in their config spelling. Anything else
 * is a config-only key (`gpus_asked`, `lib_dirs`, `layer_split`, `sampling`,
 * `reasoning_*`, …) that has no flag: those ride in `extra` and are edited
 * through the raw JSON view, so the server group never shows a fake flag.
 */
export const SERVER_CONFIG_KEYS = new Set([
  'host', 'port', 'api_key', 'no_api_key', 'offline', 'open_browser', 'gpu',
  'tokenizer', 'parallel', 'batch_groups', 'max_queue', 'queue_timeout',
  'shutdown_timeout', 'replicas', 'lazy_load', 'idle_unload_s',
  'min_free_vram_mib', 'before_load', 'before_load_timeout_s',
  'before_load_strict', 'before_load_ignore_failure', 'slot_save_path',
  'ready_file', 'batch_telemetry', 'mcp_config', 'api_monitor',
  'fit_max_tokens', 'script', 'script_cycle', 'script_delay', 'engine',
  'config', 'owner_fd',
]);

/** Flag for a server config key, preferring the documented spelling. */
export function serverFlagFor(key: string): string {
  const entry = Object.entries(SERVER_KEY_ALIASES).find(([, k]) => k === key);
  if (entry) return entry[0];
  return `--${key.replace(/_/g, '-')}`;
}

/** Config key a server param writes, and whether it is a negated flag. */
function serverKeyOf(param: EngineParam): { key: string; negated: boolean } {
  const alias = SERVER_KEY_ALIASES[param.key];
  const negated = param.key.startsWith('--no-');
  return { key: alias ?? param.key.replace(/^--/, '').replace(/-/g, '_'), negated };
}

/**
 * Convert server params to config-file entries. A bare `--no-*` flag writes
 * `false`, a bare positive flag writes `true`, and a value is parsed so
 * numbers/arrays/objects keep their JSON type (the server validates types).
 */
export function serverParamsToConfig(params: EngineParam[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p.disabled) continue;
    const { key, negated } = serverKeyOf(p);
    if (p.value === undefined || p.value === '') {
      out[key] = !negated;
      continue;
    }
    out[key] = parseConfigValue(p.value);
  }
  return out;
}

/** Convert config-file server entries to editable server params. */
export function configToServerParams(cfg: Record<string, unknown>): EngineParam[] {
  const out: EngineParam[] = [];
  for (const [key, value] of Object.entries(cfg)) {
    if (ENGINE_KEYS.has(key) || !SERVER_CONFIG_KEYS.has(key)) continue;
    const flag = serverFlagFor(key);
    if (typeof value === 'boolean') {
      // A false boolean is a disabled option: keep the row visible but off.
      out.push(value ? { key: flag } : { key: flag, disabled: true });
      continue;
    }
    out.push({ key: flag, value: formatConfigValue(value) });
  }
  return out;
}

/** Values arrive from text inputs; restore JSON types the server expects. */
export function parseConfigValue(raw: string): unknown {
  const s = raw.trim();
  if (s === '') return true;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('[') || s.startsWith('{') || s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  // Comma list -> array, which is how gpu/replicas/lib_dirs are written.
  if (s.includes(',')) {
    const parts = s.split(',').map((x) => parseConfigValue(x));
    return parts.every((x) => typeof x === 'number') ? parts : parts.map((x) => String(x));
  }
  return raw;
}

/** Render a config value for a single-line text input. */
export function formatConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    return value.join(',');
  }
  return JSON.stringify(value);
}

/** Parse the config's `args` argv array into flag/value rows. */
export function argvToParams(argv: unknown): EngineParam[] {
  if (!Array.isArray(argv)) return [];
  const out: EngineParam[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = String(argv[i]);
    if (!tok.startsWith('-')) {
      out.push({ key: tok });
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith('-')) {
      out.push({ key: tok, value: String(next) });
      i++;
    } else {
      out.push({ key: tok });
    }
  }
  return normalizeEngineParams(out);
}

/**
 * Render params as a config `args` token array. Unlike `paramsToArgs` (a flat
 * display string), values keep their own element so paths with spaces survive
 * without quoting — the config format is argv, not a shell line.
 */
export function paramsToArgv(params: EngineParam[]): string[] {
  const out: string[] = [];
  for (const p of enabledParams(params)) {
    out.push(p.key);
    if (p.value !== undefined && p.value !== '') out.push(p.value);
  }
  return out;
}

/**
 * Normalize a raw vision object, preserving unknown keys in `extra`.
 * Accepts both the config-file spelling (`max_tokens`) and the stored
 * StrataConfig spelling (`maxTokens`), since it runs on imported files and on
 * values read back from engines.json.
 */
export function normalizeVision(raw: unknown): StrataVisionConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const known = new Set(['exe', 'mmproj', 'model', 'gpu', 'max_tokens', 'maxTokens', 'extra']);
  const extra: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (!known.has(k)) extra[k] = val;
  // A stored StrataVisionConfig carries its preserved keys under `extra`; fold
  // them back in so re-normalizing an already-normalized block is idempotent.
  if (v.extra && typeof v.extra === 'object' && !Array.isArray(v.extra)) {
    Object.assign(extra, v.extra as Record<string, unknown>);
  }
  const gpu = typeof v.gpu === 'number' ? v.gpu : v.gpu === false ? false : true;
  const maxTokens = typeof v.max_tokens === 'number'
    ? v.max_tokens
    : typeof v.maxTokens === 'number' ? v.maxTokens : 1024;
  return {
    exe: typeof v.exe === 'string' ? v.exe : '',
    mmproj: typeof v.mmproj === 'string' ? v.mmproj : '',
    model: typeof v.model === 'string' ? v.model : '',
    gpu,
    maxTokens,
    extra,
  };
}

/** Split a raw config object into the strata block the UI edits. */
export function strataFromConfig(cfg: Record<string, unknown>): StrataConfig {
  // `extra` keeps everything the UI has no field for (config-only keys such as
  // gpus_asked / gpu_order / layer_split / lib_dirs / log / sampling). `port`
  // is the exception: it has no config effect, so it rides as a --port server
  // row instead and is re-emitted from there on export.
  const extra: Record<string, unknown> = {};
  const serverCfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (ENGINE_KEYS.has(k)) continue;
    if (SERVER_CONFIG_KEYS.has(k) || k === 'port') serverCfg[k] = v;
    else extra[k] = v;
  }
  return {
    exe: typeof cfg.exe === 'string' ? cfg.exe : '',
    cwd: typeof cfg.cwd === 'string' ? cfg.cwd : '',
    tokenizer: typeof cfg.tokenizer === 'string' ? cfg.tokenizer : '',
    modelName: typeof cfg.model_name === 'string' ? cfg.model_name : '',
    engineArgs: argvToParams(cfg.args),
    serverArgs: configToServerParams(serverCfg),
    vision: normalizeVision(cfg.vision),
    extra,
  };
}

/** Render the strata block back to the `strata-<model>.json` shape. */
export function strataToConfig(s: StrataConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s.extra };
  if (s.exe) out.exe = s.exe;
  if (s.cwd) out.cwd = s.cwd;
  if (s.tokenizer) out.tokenizer = s.tokenizer;
  if (s.modelName) out.model_name = s.modelName;
  out.args = paramsToArgv(s.engineArgs);
  Object.assign(out, serverParamsToConfig(s.serverArgs));
  if (s.vision) {
    const v: Record<string, unknown> = { ...s.vision.extra };
    if (s.vision.exe) v.exe = s.vision.exe;
    if (s.vision.mmproj) v.mmproj = s.vision.mmproj;
    if (s.vision.model) v.model = s.vision.model;
    v.gpu = s.vision.gpu;
    v.max_tokens = s.vision.maxTokens;
    out.vision = v;
  }
  return out;
}

/** The generated config file an instance launches from. */
export function strataConfigPath(instanceId: string): string {
  return path.join(configDir(), `strata-${instanceId}.json`);
}

/** Blank strata block for a new instance. */
export function blankStrataConfig(): StrataConfig {
  return {
    exe: '',
    cwd: '',
    tokenizer: '',
    modelName: '',
    engineArgs: [],
    serverArgs: [
      { key: '--host', value: '127.0.0.1' },
      { key: '--port', value: '8095' },
    ],
    vision: null,
    extra: {},
  };
}

/**
 * Normalize a strata block read from disk or an API body. This is the stored
 * StrataConfig shape (camelCase `modelName`), not the config-file shape.
 */
export function normalizeStrataConfig(raw: unknown): StrataConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  return {
    exe: typeof c.exe === 'string' ? c.exe : '',
    cwd: typeof c.cwd === 'string' ? c.cwd : '',
    tokenizer: typeof c.tokenizer === 'string' ? c.tokenizer : '',
    modelName: typeof c.modelName === 'string' ? c.modelName : '',
    engineArgs: normalizeEngineParams(c.engineArgs),
    serverArgs: normalizeEngineParams(c.serverArgs),
    vision: normalizeVision(c.vision),
    extra: c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra)
      ? { ...(c.extra as Record<string, unknown>) }
      : {},
  };
}

/** Port a strata instance listens on, from its --port server row. */
export function strataPort(s: StrataConfig | undefined): number | null {
  const raw = s?.serverArgs.find((p) => p.key === '--port' && !p.disabled)?.value;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}
