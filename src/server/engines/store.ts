/**
 * Engine definitions + instances storage (`.config/engines.json`).
 *
 * Follows the modelConfig.ts pattern: load/save/normalize with defensive parsing.
 * Migration (docs/llm-engines.md §2.3) is non-destructive: when engines.json is
 * absent, `migrateLegacyConfig()` synthesizes one `default` definition + one
 * `default` instance from the legacy global LlamaConfig. The legacy fields in
 * settings.json are left untouched.
 */

import fs from 'fs';
import path from 'path';
import { configDir } from '../config.js';
import type { LlamaConfig } from '../types.js';
import { splitArgs, tokensToParams } from './args.js';
import { blankAudioConfig, audioPort, normalizeAudioConfig } from './audio.js';
import { blankSdConfig, normalizeSdConfig, sdPort, SD_DEFAULT_PORT } from './sd.js';
import { blankStrataConfig, normalizeStrataConfig, strataPort } from './strata.js';
import { loadTemplate } from './template.js';
import {
  EMPTY_ENGINES,
  defaultBinaryForKind,
  isEngineKind,
  type EngineDefinition,
  type EngineInstance,
  type EngineKind,
  type EngineParam,
  type EnginesFile,
} from './types.js';

// Resolved at call time so tests can isolate .config by changing cwd.
function enginesFile(): string {
  return path.join(configDir(), 'engines.json');
}

/** Slug form of an engine name (no uniquification). */
export function slugifyEngineName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'engine';
}

/** Slug id derived from a name, uniquified against the existing ids. */
export function makeEngineId(name: string, existing: { id: string }[]): string {
  const base = slugifyEngineName(name);
  let id = base;
  let n = 2;
  while (existing.some((e) => e.id === id)) id = `${base}-${n++}`;
  return id;
}

/**
 * Id an instance should carry after a rename. Generated files are named from
 * the id (`router-<id>.ini`, `strata-<id>.json`), so the id follows the name
 * instead of staying pinned to whatever it was first created as. Returns the
 * current id unchanged when the slug already matches, and never collides with
 * another instance's id.
 */
export function engineIdForRename(
  name: string,
  currentId: string,
  others: { id: string }[],
): string {
  const base = slugifyEngineName(name);
  if (base === currentId) return currentId;
  let id = base;
  let n = 2;
  while (others.some((e) => e.id === id)) id = `${base}-${n++}`;
  return id;
}

export function normalizeEnvVars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

export function normalizeEngineParams(raw: unknown): EngineParam[] {
  if (!Array.isArray(raw)) return [];
  const out: EngineParam[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const key = (p as EngineParam).key;
    if (typeof key !== 'string' || !key.trim()) continue;
    const value = (p as EngineParam).value;
    // A number value is accepted and stringified: `EngineParam.value` is a
    // string by contract, but a client that bound a numeric input straight to
    // the model used to send real numbers, and dropping them silently lost the
    // value (a --port row saved with no port). Files already written that way
    // are repaired on load.
    const param: EngineParam =
      typeof value === 'string'
        ? { key: key.trim(), value }
        : typeof value === 'number' && Number.isFinite(value)
          ? { key: key.trim(), value: String(value) }
          : { key: key.trim() };
    if ((p as EngineParam).disabled === true) param.disabled = true;
    out.push(param);
  }
  return out;
}

function normalizeDefinition(raw: unknown, index: number): EngineDefinition | null {
  const d = (raw ?? {}) as Partial<EngineDefinition>;
  if (!d || typeof d !== 'object') return null;
  const id = typeof d.id === 'string' && d.id ? d.id : `def-${index}`;
  return {
    id,
    name: typeof d.name === 'string' && d.name ? d.name : id,
    kind: isEngineKind(d.kind) ? d.kind : 'llamacpp',
    buildPath: typeof d.buildPath === 'string' ? d.buildPath : '',
    envVars: normalizeEnvVars(d.envVars),
  };
}

/** Value of an *enabled* param key (first match), or undefined when absent.
 * Disabled rows are stored but never reach the command line, so they must not
 * count for port allocation or launch spec fields either. */
export function paramValue(params: EngineParam[], key: string): string | undefined {
  return params.find((p) => p.key === key && !p.disabled)?.value;
}

/**
 * Alternate spellings of a long flag as accepted by the llama.cpp CLI, so a
 * param written as `-c` is still found when looking up `--ctx-size`. Mirrors
 * the short options `buildLlamaArgs` itself emits.
 */
const PARAM_FLAG_ALIASES: Record<string, string[]> = {
  '--ctx-size': ['-c'],
  '--n-gpu-layers': ['-ngl'],
  '--batch-size': ['-b'],
  '--ubatch-size': ['-ub'],
  '--threads': ['-t'],
  '--threads-shared': ['-ts'],
  '--port': ['-p'],
};

/** All spellings to try for a flag: the flag itself then its short aliases. */
export function paramFlagAliases(flag: string): string[] {
  return [flag, ...(PARAM_FLAG_ALIASES[flag] ?? [])];
}

/** Value of a flag under any of its accepted spellings. */
export function paramValueAny(params: EngineParam[], flag: string): string | undefined {
  for (const key of paramFlagAliases(flag)) {
    const value = paramValue(params, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Port an instance listens on: its --port/-p param, or for strata the
 * server-arg --port row, or for audio the `port` config-key row, or for
 * stable-diffusion the `--listen-port` row (null = unset). sd-server has no
 * `--port` flag, so an sd row never collides with the llama.cpp spellings. */
export function instancePort(
  inst: Pick<EngineInstance, 'params' | 'strata' | 'audio' | 'sd'>,
): number | null {
  const raw = paramValueAny(inst.params, '--port');
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  return strataPort(inst.strata) ?? audioPort(inst.audio) ?? sdPort(inst.sd);
}

/**
 * Audio instances used to keep the run folder in `audio.cwd` with the
 * executable relative to it. That field merged into a single full-path
 * `binary` (the launch cwd is the executable's folder), so join the old cwd
 * with a relative binary once on load. Idempotent: an absolute path — or a
 * missing legacy cwd — is left alone.
 */
function mergeLegacyAudioBinary(raw: unknown, binary: string): string {
  const block = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { cwd?: unknown })
    : undefined;
  const runDir = typeof block?.cwd === 'string' ? block.cwd.trim() : '';
  if (!runDir || !binary || binary.startsWith('/') || binary.startsWith('~')) return binary;
  return path.join(runDir, binary);
}

function normalizeInstance(raw: unknown, index: number): EngineInstance | null {
  const i = (raw ?? {}) as Partial<EngineInstance> & {
    host?: unknown; port?: unknown; apiKey?: unknown;
  };
  if (!i || typeof i !== 'object') return null;
  const id = typeof i.id === 'string' && i.id ? i.id : `inst-${index}`;
  const params = normalizeEngineParams(i.params);
  // engines.json written before host/port/apiKey became plain params: fold the
  // old fields in (unless a param already names the flag) so launches keep the
  // same flags after the upgrade.
  const legacyField = (key: string, value: unknown): void => {
    const flag = `--${key}`;
    if (typeof value !== 'string' || !value || params.some((p) => p.key === flag)) return;
    params.push({ key: flag, value });
  };
  legacyField('host', i.host);
  if (typeof i.port === 'number' && Number.isFinite(i.port) && !params.some((p) => p.key === '--port')) {
    params.push({ key: '--port', value: String(i.port) });
  }
  legacyField('api-key', i.apiKey);
  const binary = typeof i.binary === 'string' && i.binary ? i.binary : 'llama-server';
  return {
    id,
    name: typeof i.name === 'string' && i.name ? i.name : id,
    notes: typeof i.notes === 'string' ? i.notes : '',
    kind: isEngineKind(i.kind) ? i.kind : ('' as EngineKind),
    definitionId: typeof i.definitionId === 'string' ? i.definitionId : 'default',
    binary: mergeLegacyAudioBinary(i.audio, binary),
    params,
    routerMode: !!i.routerMode,
    modelConfigIds: Array.isArray(i.modelConfigIds)
      ? i.modelConfigIds.filter((x): x is string => typeof x === 'string')
      : [],
    ...(typeof i.modelPath === 'string' && i.modelPath ? { modelPath: i.modelPath } : {}),
    ...(typeof i.mmproj === 'string' && i.mmproj ? { mmproj: i.mmproj } : {}),
    autoLaunch: i.autoLaunch === true,
    ...(normalizeStrataConfig(i.strata) ? { strata: normalizeStrataConfig(i.strata) } : {}),
    ...(normalizeAudioConfig(i.audio) ? { audio: normalizeAudioConfig(i.audio) } : {}),
    ...(normalizeSdConfig(i.sd) ? { sd: normalizeSdConfig(i.sd) } : {}),
  };
}

export function normalizeEngines(data: unknown): EnginesFile {
  const raw = (data ?? {}) as Partial<EnginesFile>;
  const definitions = (Array.isArray(raw.definitions) ? raw.definitions : [])
    .map((d, idx) => normalizeDefinition(d, idx))
    .filter((d): d is EngineDefinition => d !== null);
  const instances = (Array.isArray(raw.instances) ? raw.instances : [])
    .map((i, idx) => normalizeInstance(i, idx))
    .filter((i): i is EngineInstance => i !== null);

  // Files written before instances carried their own kind: inherit it from the
  // definition so the UI and launch path can treat every instance uniformly.
  for (const i of instances) {
    if (!i.kind) {
      i.kind = definitions.find((d) => d.id === i.definitionId)?.kind ?? 'llamacpp';
    }
  }

  // Enforce unique ids on both lists (later duplicates get a suffixed id).
  const defIds = new Set<string>();
  for (const d of definitions) {
    while (defIds.has(d.id)) d.id = `${d.id}-x`;
    defIds.add(d.id);
  }
  const instIds = new Set<string>();
  for (const i of instances) {
    while (instIds.has(i.id)) i.id = `${i.id}-x`;
    instIds.add(i.id);
  }

  let defaultInstanceId =
    typeof raw.defaultInstanceId === 'string' && instances.some((i) => i.id === raw.defaultInstanceId)
      ? raw.defaultInstanceId
      : instances[0]?.id ?? null;

  return { definitions, instances, defaultInstanceId };
}

/** Load `.config/engines.json`; empty state when missing or corrupt. */
export function loadEngines(): EnginesFile {
  try {
    const raw = fs.readFileSync(enginesFile(), 'utf-8');
    return normalizeEngines(JSON.parse(raw));
  } catch {
    return { ...EMPTY_ENGINES, definitions: [], instances: [] };
  }
}

/** True when the engines file exists on disk (migration trigger). */
export function enginesFileExists(): boolean {
  return fs.existsSync(enginesFile());
}

export function saveEngines(data: EnginesFile): EnginesFile {
  const normalized = normalizeEngines(data);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(enginesFile(), JSON.stringify(normalized, null, 2));
  return normalized;
}

/**
 * Build an initial engines file from the legacy global LlamaConfig
 * (settings.json). Returns null when there is nothing to migrate (no build
 * path configured). Non-destructive: the legacy config is not modified.
 */
export function migrateLegacyConfig(legacy: LlamaConfig): EnginesFile | null {
  if (!legacy.llamaCppPath) return null;

  const definition: EngineDefinition = {
    id: 'default',
    name: 'default',
    kind: 'llamacpp',
    buildPath: legacy.llamaCppPath,
    envVars: normalizeEnvVars(legacy.envVars),
  };

  const params = tokensToParams(splitArgs(legacy.extraArgs || ''));
  // host/port/api-key are ordinary launch params now — migrate them to the
  // front of the ordered list instead of dedicated fields.
  const prefix: EngineParam[] = [];
  if (legacy.host && !params.some((p) => p.key === '--host')) {
    prefix.push({ key: '--host', value: legacy.host });
  }
  if (legacy.port && !params.some((p) => p.key === '--port')) {
    prefix.push({ key: '--port', value: String(legacy.port) });
  }
  if (legacy.apiKey && !params.some((p) => p.key === '--api-key')) {
    prefix.push({ key: '--api-key', value: legacy.apiKey });
  }

  const instance: EngineInstance = {
    id: 'default',
    name: 'default',
    notes: '',
    kind: 'llamacpp',
    definitionId: 'default',
    binary: legacy.binary || 'llama-server',
    params: [...prefix, ...params],
    routerMode: false,
    modelConfigIds: [],
    autoLaunch: false,
    ...(legacy.modelPath ? { modelPath: legacy.modelPath } : {}),
    ...(legacy.mmproj ? { mmproj: legacy.mmproj } : {}),
  };

  return { definitions: [definition], instances: [instance], defaultInstanceId: 'default' };
}

/** True when `port` is used by another instance (optionally excluding one). */
export function isPortTaken(data: EnginesFile, port: number, excludeInstanceId?: string): boolean {
  return data.instances.some((i) => instancePort(i) === port && i.id !== excludeInstanceId);
}

/** First free port at or after `base`, avoiding all instances plus `reserved`. */
export function findFreePort(data: EnginesFile, base: number, reserved: number[] = []): number {
  let port = base;
  const taken = new Set([
    ...data.instances.map((i) => instancePort(i)).filter((p): p is number => p !== null),
    ...reserved,
  ]);
  while (taken.has(port)) port++;
  return port;
}

/** Convenience for creating a blank instance bound to a definition. */
export function blankInstance(name: string, def: EngineDefinition, existing: EnginesFile): EngineInstance {
  // New instances start from the kind's parameter template; the --port row is
  // nudged to a free port so parallel instances don't collide.
  const params = loadTemplate(def.kind);
  // Strata keeps its port in a separate server-arg list, so it gets the same
  // free-port treatment there.
  const strata = def.kind === 'strata' ? blankStrataConfig() : undefined;
  const audio = def.kind === 'audio' ? blankAudioConfig() : undefined;
  const sd = def.kind === 'sdiffusion' ? blankSdConfig() : undefined;
  const portRow = params.find((p) => p.key === '--port' || p.key === '-p');
  if (portRow) portRow.value = String(findFreePort(existing, instancePort({ params, strata, audio, sd }) ?? 8080));
  if (strata) {
    const row = strata.serverArgs.find((p) => p.key === '--port');
    if (row) row.value = String(findFreePort(existing, strataPort(strata) ?? 8095));
  }
  if (audio) {
    const row = audio.serverArgs.find((p) => p.key === 'port');
    if (row) row.value = String(findFreePort(existing, audioPort(audio) ?? 8080));
  }
  if (sd) {
    const row = sd.serverArgs.find((p) => p.key === '--listen-port');
    if (row) row.value = String(findFreePort(existing, sdPort(sd) ?? SD_DEFAULT_PORT));
  }
  return {
    id: makeEngineId(name, existing.instances),
    name,
    notes: '',
    kind: def.kind,
    // A self-contained kind (strata, audio, sd) keeps its whole config on the
    // instance, so it carries no definition link.
    definitionId: def.kind === 'strata' || def.kind === 'audio' || def.kind === 'sdiffusion'
      ? ''
      : def.id,
    binary: defaultBinaryForKind(def.kind),
    params,
    routerMode: false,
    modelConfigIds: [],
    autoLaunch: false,
    ...(strata ? { strata } : {}),
    ...(audio ? { audio } : {}),
    ...(sd ? { sd } : {}),
  };
}
