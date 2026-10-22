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

/**
 * Top-level config keys that are structural, not editable rows: `args` becomes
 * the Engine tab's row list and `vision` its own section, so neither appears as
 * a server row.
 */
const STRUCTURAL_KEYS = new Set(['args', 'vision']);

/**
 * Top-level deployment keys the Server tab edits as ordinary key/value rows.
 * `serve/server.py` reads each straight from the config (`cfg.get("cwd")`,
 * `cfg.get("exe")`, `cfg["tokenizer"]`, `cfg.get("model_name")`), never from a
 * CLI flag of the same name, so a row's name is the config key verbatim — the
 * same rule the vision rows follow. (`--tokenizer` is a CLI flag, but the
 * config key overrides it, so the key — not the flag — is what the row writes.)
 */
export const DEPLOYMENT_KEYS = new Set(['exe', 'cwd', 'tokenizer', 'model_name']);

/**
 * Top-level config keys that `serve/server.py` reads as its own options — the
 * CLI flags from its argparse block, in their config spelling. Anything else
 * is a config-only key (`gpus_asked`, `lib_dirs`, `layer_split`, `sampling`,
 * `reasoning_*`, …) that has no flag: those ride in `extra` and are edited
 * through the raw JSON view, so the server group never shows a fake flag.
 */
export const SERVER_CONFIG_KEYS = new Set([
  'host', 'port', 'api_key', 'no_api_key', 'offline', 'open_browser', 'gpu',
  'parallel', 'batch_groups', 'max_queue', 'queue_timeout',
  'shutdown_timeout', 'replicas', 'lazy_load', 'idle_unload_s',
  'min_free_vram_mib', 'before_load', 'before_load_timeout_s',
  'before_load_strict', 'before_load_ignore_failure', 'slot_save_path',
  'ready_file', 'batch_telemetry', 'mcp_config', 'api_monitor',
  'fit_max_tokens', 'script', 'script_cycle', 'script_delay', 'engine',
  'config', 'owner_fd',
]);

/** Flag for a server config key, preferring the documented spelling. */
export function serverFlagFor(key: string): string {
  // Deployment keys have no flag spelling — the row name IS the config key.
  if (DEPLOYMENT_KEYS.has(key)) return key;
  const entry = Object.entries(SERVER_KEY_ALIASES).find(([, k]) => k === key);
  if (entry) return entry[0];
  return `--${key.replace(/_/g, '-')}`;
}

/** Config key a server param writes, and whether it is a negated flag. */
function serverKeyOf(param: EngineParam): { key: string; negated: boolean } {
  // A deployment row is keyed by its config key verbatim (no leading dashes).
  if (DEPLOYMENT_KEYS.has(param.key)) return { key: param.key, negated: false };
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
      // A deployment row holds a path or a name: an empty one means "not set",
      // not a boolean flag, so it is left out of the file entirely.
      if (DEPLOYMENT_KEYS.has(key)) continue;
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
    if (STRUCTURAL_KEYS.has(key)) continue;
    if (!SERVER_CONFIG_KEYS.has(key) && !DEPLOYMENT_KEYS.has(key)) continue;
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
 * Vision rows -> the config's `vision` object. These keys are config keys, not
 * flags, so a row name is used verbatim and its value keeps its JSON type. A
 * disabled row omits the key; a row explicitly holding `false` re-emits
 * `false`, because the server distinguishes `"gpu": false` from a missing gpu
 * when it builds the encoder command line.
 */
export function visionParamsToConfig(params: EngineParam[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const key = p.key.trim();
    if (!key) continue;
    if (p.value === undefined || p.value === '') {
      if (p.disabled) continue;
      out[key] = true;
      continue;
    }
    out[key] = parseConfigValue(p.value);
  }
  return out;
}

/**
 * Normalize a vision block. The stored form is `{ args: EngineParam[] }`; a
 * pre-upgrade engines.json (or a raw config section) holding named keys is
 * folded into rows, so old files keep loading unchanged. `maxTokens` was the
 * old stored spelling of the `max_tokens` config key, so it is renamed back.
 */
const LEGACY_VISION_KEYS: Record<string, string> = { maxTokens: 'max_tokens' };

export function normalizeVision(raw: unknown): StrataVisionConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (Array.isArray(v.args)) return { args: normalizeEngineParams(v.args) };
  const rowOf = ([key, value]: [string, unknown]): EngineParam => ({
    key: LEGACY_VISION_KEYS[key] ?? key,
    value: formatConfigValue(value),
  });
  const rows = Object.entries(v).filter(([k]) => k !== 'extra').map(rowOf);
  const extraRows = v.extra && typeof v.extra === 'object' && !Array.isArray(v.extra)
    ? Object.entries(v.extra as Record<string, unknown>).map(rowOf)
    : [];
  return { args: normalizeEngineParams([...rows, ...extraRows]) };
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
    if (STRUCTURAL_KEYS.has(k)) continue;
    if (SERVER_CONFIG_KEYS.has(k) || DEPLOYMENT_KEYS.has(k) || k === 'port') serverCfg[k] = v;
    else extra[k] = v;
  }
  return {
    engineArgs: argvToParams(cfg.args),
    serverArgs: configToServerParams(serverCfg),
    vision: normalizeVision(cfg.vision),
    extra,
  };
}

/** Render the strata block back to the `strata-<model>.json` shape. */
export function strataToConfig(s: StrataConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s.extra };
  out.args = paramsToArgv(s.engineArgs);
  // The deployment keys (exe, cwd, tokenizer, model_name) ride in the server
  // rows, so they are emitted by the same conversion as the server options.
  Object.assign(out, serverParamsToConfig(s.serverArgs));
  if (s.vision) out.vision = visionParamsToConfig(s.vision.args);
  return out;
}

/** The generated config file an instance launches from. */
export function strataConfigPath(instanceId: string): string {
  return path.join(configDir(), `strata-${instanceId}.json`);
}

/** Blank strata block for a new instance. */
export function blankStrataConfig(): StrataConfig {
  return {
    engineArgs: [],
    // The deployment keys lead the Server tab as ordinary rows: a new engine
    // only needs paths filled in, no separate form to discover them.
    serverArgs: [
      { key: 'cwd', value: '' },
      { key: 'exe', value: '' },
      { key: 'tokenizer', value: '' },
      { key: 'model_name', value: '' },
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
  const serverArgs = normalizeEngineParams(c.serverArgs);
  // engines.json written while the deployment keys were dedicated fields:
  // fold them into server rows so the row list is the single source.
  const legacyField = (key: string, value: unknown): void => {
    if (typeof value !== 'string' || !value || serverArgs.some((p) => p.key === key)) return;
    serverArgs.push({ key, value });
  };
  legacyField('exe', c.exe);
  legacyField('cwd', c.cwd);
  legacyField('tokenizer', c.tokenizer);
  legacyField('model_name', c.modelName ?? c.model_name);
  return {
    engineArgs: normalizeEngineParams(c.engineArgs),
    serverArgs,
    vision: normalizeVision(c.vision),
    extra: c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra)
      ? { ...(c.extra as Record<string, unknown>) }
      : {},
  };
}

/**
 * Value of a deployment row (enabled only), e.g. the repo folder a strata
 * instance launches from. Empty when the row is missing, blank or off.
 */
export function deploymentValue(s: StrataConfig | undefined, key: string): string {
  const raw = s?.serverArgs.find((p) => p.key === key && !p.disabled)?.value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The Strata repo folder: the `cwd` deployment row, the launch working dir. */
export function strataRepoRoot(s: StrataConfig | undefined): string {
  return deploymentValue(s, 'cwd');
}

/** Port a strata instance listens on, from its --port server row. */
export function strataPort(s: StrataConfig | undefined): number | null {
  const raw = s?.serverArgs.find((p) => p.key === '--port' && !p.disabled)?.value;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}
