/**
 * audio.cpp engine config (docs/audio.md, docs/todo.md #21 Phase 4).
 *
 * `audiocpp_server` reads one JSON file holding the whole launch: server
 * options at the top level plus a required `models[]` array
 * (`app/server/config.cpp`). There is no CLI flag that adds a model, so the
 * generated file is the entire story — the audio counterpart of strata's
 * `strata-<model>.json` and llama.cpp's router INI.
 *
 * The models themselves are ordinary model configs in models.json carrying
 * `type: 'audio'`; an instance selects them by id. This module maps a model
 * config to a `models[]` entry and back, so a card round-trips losslessly:
 *
 *   alias                     -> id
 *   modelPath                 -> path
 *   params[family|task|mode…] -> the scalar model keys, row name = config key
 *   params[load_options.x]    -> load_options: { x: … }  (prefixed rows regroup)
 *   audioExtras               -> voice_presets, default_voice_preset, live_ingest, …
 *
 * Round-trip guarantee: keys the UI has no field for ride in
 * `AudioConfig.extra` (server level) and `ModelConfig.audioExtras` (model
 * level) untouched, including a `task` written as an array — upstream parses
 * `task` with `optional_string`, so an array is ignored by the server yet must
 * survive an import → export (docs/audio.md §1.6).
 *
 * Path note: audio.cpp resolves every relative path against the *config
 * file's* folder, not the process cwd. The generated file lives in `.config/`,
 * so relative paths would resolve against the wrong place; the generator
 * therefore emits absolute paths, resolved against the instance's `cwd`
 * (docs/audio.md §1.5).
 */

import path from 'path';
import { configDir } from '../config.js';
import { parseConfigValue, formatConfigValue } from './strata.js';
import { normalizeEngineParams } from './store.js';
import type { ModelConfig } from '../modelConfig.js';
import type { AudioConfig, EngineParam } from './types.js';

/**
 * Top-level server keys the Server tab edits as ordinary rows, in the JSON
 * spelling `app/server/config.cpp` reads. Anything else at the top level is a
 * config-only key (`live_ingest`, `frontend_options`, `log_request_body`, …)
 * that rides in `extra`, so the server group never shows a fake row.
 */
export const AUDIO_SERVER_KEYS = new Set([
  'host', 'port', 'backend', 'device', 'threads', 'lazy_load', 'cors_origins',
  'ui', 'ui_management', 'max_loaded_models', 'idle_unload_ms',
  'busy_timeout_ms', 'min_free_memory_mb', 'voice_dir', 'model_spec_override',
]);

/** Structural top-level keys: `models` becomes the picker, never a row. */
const STRUCTURAL_KEYS = new Set(['models']);

/**
 * Scalar keys of a `models[]` entry (`ServerModelConfig`). `id` and `path` are
 * the card's alias/modelPath instead, and the option maps are prefixed rows —
 * see `AUDIO_OPTION_PREFIXES`.
 */
export const AUDIO_MODEL_KEYS = new Set([
  'family', 'task', 'mode', 'lazy', 'busy_timeout_ms', 'slots',
]);

/**
 * Model keys holding a string→string map, written as prefixed rows
 * (`load_options.language = english`) and regrouped into nested objects on
 * export. Values stay strings, matching what audio.cpp's `json_options_map`
 * accepts.
 */
export const AUDIO_OPTION_PREFIXES = ['load_options', 'session_options', 'default_request_options'] as const;

/** Model keys too nested for flat rows, preserved verbatim in `audioExtras`. */
export const AUDIO_MODEL_EXTRA_KEYS = [
  'voice_presets', 'default_voice_preset', 'live_ingest',
  'model_spec_override', 'config', 'weight',
] as const;

/** Server keys with no row: structural, or preserved through `extra`. */
function isServerRow(key: string): boolean {
  return AUDIO_SERVER_KEYS.has(key);
}

/** Server rows -> top-level config entries, values restored to JSON types. */
export function serverParamsToConfig(params: EngineParam[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p.disabled || !isServerRow(p.key)) continue;
    if (p.value === undefined || p.value === '') {
      out[p.key] = true;
      continue;
    }
    out[p.key] = parseConfigValue(p.value);
  }
  return out;
}

/** Top-level config entries -> editable server rows, in catalog order. */
export function configToServerParams(cfg: Record<string, unknown>): EngineParam[] {
  const out: EngineParam[] = [];
  for (const key of AUDIO_SERVER_KEYS) {
    if (!(key in cfg)) continue;
    const value = cfg[key];
    if (typeof value === 'boolean') {
      // A false boolean is a disabled option: keep the row visible but off.
      out.push(value ? { key } : { key, disabled: true });
      continue;
    }
    out.push({ key, value: formatConfigValue(value) });
  }
  return out;
}

/**
 * A `models[]` entry -> a model config card. `alias`/`modelPath` carry `id`
 * and `path`; scalar keys and prefixed option rows go in `params` (with
 * `paramOrder` preserving the file's order); everything too nested for a row
 * rides in `audioExtras`, including a `task` array the server would ignore.
 */
export function audioModelFromEntry(entry: Record<string, unknown>): ModelConfig {
  const params: Record<string, string> = {};
  const paramOrder: string[] = [];
  const extras: Record<string, unknown> = {};

  const push = (key: string, value: unknown): void => {
    params[key] = formatConfigValue(value);
    if (!paramOrder.includes(key)) paramOrder.push(key);
  };

  for (const [key, value] of Object.entries(entry)) {
    if (key === 'id' || key === 'path') continue;
    const prefix = AUDIO_OPTION_PREFIXES.find((p) => key === p);
    if (prefix && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [optKey, optValue] of Object.entries(value as Record<string, unknown>)) {
        push(`${prefix}.${optKey}`, optValue);
      }
      continue;
    }
    // A scalar row only when the value is a scalar the editor can show; a
    // `task` array (or any other shape with no row) rides in extras verbatim.
    if (AUDIO_MODEL_KEYS.has(key) && typeof value !== 'object') {
      push(key, value);
      continue;
    }
    if (AUDIO_MODEL_EXTRA_KEYS.includes(key as (typeof AUDIO_MODEL_EXTRA_KEYS)[number])) {
      extras[key] = value;
    } else if (typeof value === 'object') {
      extras[key] = value;
    } else {
      // Unknown scalar key: still a row, so an upgrade of audio.cpp adding a
      // model option stays editable rather than vanishing.
      push(key, value);
    }
  }

  return {
    id: '',
    alias: String(entry.id ?? ''),
    displayName: String(entry.id ?? ''),
    notes: '',
    modelPath: String(entry.path ?? ''),
    params,
    paramOrder,
    type: 'audio',
    audioExtras: Object.keys(extras).length ? extras : undefined,
    includeInLaunch: true,
    isDefault: false,
  };
}

/**
 * A model config card -> a `models[]` entry. `baseDir` resolves a relative
 * `path` (and any relative path in `audioExtras`) so the generated file can
 * hold absolute paths — audio.cpp resolves relatives against the file's own
 * folder, which for a generated `.config/audio-<id>.json` is not where the
 * models live.
 */
export function audioModelToEntry(cfg: ModelConfig, baseDir: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: cfg.alias.trim(),
    family: '',
    path: resolveFrom(cfg.modelPath, baseDir),
  };
  const options: Record<string, Record<string, string>> = {};
  const disabled = new Set(cfg.disabledParams ?? []);

  for (const key of orderedModelKeys(cfg)) {
    const value = cfg.params[key];
    if (value === undefined) continue;
    const prefix = AUDIO_OPTION_PREFIXES.find((p) => key.startsWith(`${p}.`));
    if (prefix) {
      const optKey = key.slice(prefix.length + 1);
      if (!optKey) continue;
      (options[prefix] ??= {})[optKey] = value;
      continue;
    }
    if (disabled.has(key)) continue;
    out[key] = modelValueOf(key, value);
  }

  for (const [prefix, map] of Object.entries(options)) {
    if (Object.keys(map).length) out[prefix] = map;
  }

  // Extras ride verbatim, except a relative path in a known path key.
  const extras = cfg.audioExtras ?? {};
  for (const [key, value] of Object.entries(extras)) {
    out[key] = key === 'model_spec_override' || key === 'voice_ref'
      ? resolveFrom(String(value), baseDir)
      : value;
  }
  return out;
}

/** `paramOrder` first (the user's order), then any params it forgot. */
function orderedModelKeys(cfg: ModelConfig): string[] {
  const keys = Object.keys(cfg.params ?? {});
  const ordered = (cfg.paramOrder ?? []).filter((k) => keys.includes(k));
  return [...ordered, ...keys.filter((k) => !ordered.includes(k))];
}

/**
 * Restore a model row's JSON type. `family`/`task`/`mode` are strings even
 * when they look numeric; the numeric keys are numbers, `lazy` a boolean.
 */
function modelValueOf(key: string, value: string): unknown {
  if (key === 'family' || key === 'task' || key === 'mode') return value;
  return parseConfigValue(value);
}

/** Absolute paths pass through; relatives resolve against `baseDir`. */
function resolveFrom(p: string, baseDir: string): string {
  const trimmed = (p ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return trimmed;
  return baseDir ? path.resolve(baseDir, trimmed) : trimmed;
}

/** Split a raw audio.cpp config into the instance block + model cards. */
export function audioFromConfig(cfg: Record<string, unknown>): {
  audio: AudioConfig;
  /** Model cards parsed from `models[]` (ids assigned by the caller). */
  models: ModelConfig[];
} {
  const extra: Record<string, unknown> = {};
  const serverCfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (STRUCTURAL_KEYS.has(k)) continue;
    if (isServerRow(k)) serverCfg[k] = v;
    else extra[k] = v;
  }
  const models = Array.isArray(cfg.models)
    ? cfg.models
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m))
        .map(audioModelFromEntry)
    : [];
  return {
    audio: {
      cwd: '',
      serverArgs: configToServerParams(serverCfg),
      modelConfigIds: [],
      extra,
    },
    models,
  };
}

/**
 * Render the instance block to the `audio-<model>.json` shape. `modelConfigs`
 * are the selected cards, emitted in the instance's selection order;
 * `baseDir` is the instance's run folder, used to absolutize relative paths.
 */
export function audioToConfig(
  audio: AudioConfig,
  modelConfigs: ModelConfig[],
  baseDir: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...audio.extra };
  Object.assign(out, serverParamsToConfig(audio.serverArgs));
  out.models = modelConfigs.map((cfg) => audioModelToEntry(cfg, baseDir));
  return out;
}

/** The generated config file an instance launches from. */
export function audioConfigPath(instanceId: string): string {
  return path.join(configDir(), `audio-${instanceId}.json`);
}

/** Blank audio block for a new instance. */
export function blankAudioConfig(): AudioConfig {
  return {
    cwd: '',
    // The keys a new server needs to bind at all lead the Server tab; the
    // rest are added from the catalog on demand.
    serverArgs: [
      { key: 'host', value: '127.0.0.1' },
      { key: 'port', value: '8080' },
      { key: 'backend', value: 'cuda' },
      { key: 'device', value: '0' },
      { key: 'threads', value: '8' },
      { key: 'lazy_load' },
    ],
    modelConfigIds: [],
    extra: {},
  };
}

/**
 * Normalize an audio block read from disk or an API body. Defensive like
 * `normalizeStrataConfig`: a missing/garbage block is `undefined`, so an old
 * engines.json loads unchanged.
 */
export function normalizeAudioConfig(raw: unknown): AudioConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  return {
    cwd: typeof c.cwd === 'string' ? c.cwd.trim() : '',
    serverArgs: normalizeEngineParams(c.serverArgs),
    modelConfigIds: Array.isArray(c.modelConfigIds)
      ? c.modelConfigIds.filter((x): x is string => typeof x === 'string')
      : [],
    extra: c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra)
      ? { ...(c.extra as Record<string, unknown>) }
      : {},
  };
}

/** Port an audio instance listens on, from its `port` server row. */
export function audioPort(audio: AudioConfig | undefined): number | null {
  const raw = audio?.serverArgs.find((p) => p.key === 'port' && !p.disabled)?.value;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}
