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
import { loadTemplate } from './template.js';
import {
  EMPTY_ENGINES,
  defaultBinaryForKind,
  isEngineKind,
  type EngineDefinition,
  type EngineInstance,
  type EngineParam,
  type EnginesFile,
} from './types.js';

// Resolved at call time so tests can isolate .config by changing cwd.
function enginesFile(): string {
  return path.join(configDir(), 'engines.json');
}

/** Slug id derived from a name, uniquified against the existing ids. */
export function makeEngineId(name: string, existing: { id: string }[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'engine';
  let id = base;
  let n = 2;
  while (existing.some((e) => e.id === id)) id = `${base}-${n++}`;
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
    const param: EngineParam =
      typeof value === 'string' ? { key: key.trim(), value } : { key: key.trim() };
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

/** Port an instance listens on, read from its --port/-p param (null = unset). */
export function instancePort(params: EngineParam[]): number | null {
  const raw = paramValueAny(params, '--port');
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
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
  return {
    id,
    name: typeof i.name === 'string' && i.name ? i.name : id,
    notes: typeof i.notes === 'string' ? i.notes : '',
    definitionId: typeof i.definitionId === 'string' ? i.definitionId : 'default',
    binary: typeof i.binary === 'string' && i.binary ? i.binary : 'llama-server',
    params,
    routerMode: !!i.routerMode,
    modelConfigIds: Array.isArray(i.modelConfigIds)
      ? i.modelConfigIds.filter((x): x is string => typeof x === 'string')
      : [],
    ...(typeof i.modelPath === 'string' && i.modelPath ? { modelPath: i.modelPath } : {}),
    ...(typeof i.mmproj === 'string' && i.mmproj ? { mmproj: i.mmproj } : {}),
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
    definitionId: 'default',
    binary: legacy.binary || 'llama-server',
    params: [...prefix, ...params],
    routerMode: false,
    modelConfigIds: [],
    ...(legacy.modelPath ? { modelPath: legacy.modelPath } : {}),
    ...(legacy.mmproj ? { mmproj: legacy.mmproj } : {}),
  };

  return { definitions: [definition], instances: [instance], defaultInstanceId: 'default' };
}

/** True when `port` is used by another instance (optionally excluding one). */
export function isPortTaken(data: EnginesFile, port: number, excludeInstanceId?: string): boolean {
  return data.instances.some((i) => instancePort(i.params) === port && i.id !== excludeInstanceId);
}

/** First free port at or after `base`, avoiding all instances plus `reserved`. */
export function findFreePort(data: EnginesFile, base: number, reserved: number[] = []): number {
  let port = base;
  const taken = new Set([
    ...data.instances.map((i) => instancePort(i.params)).filter((p): p is number => p !== null),
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
  const portRow = params.find((p) => p.key === '--port' || p.key === '-p');
  if (portRow) portRow.value = String(findFreePort(existing, instancePort(params) ?? 8080));
  return {
    id: makeEngineId(name, existing.instances),
    name,
    notes: '',
    definitionId: def.id,
    binary: defaultBinaryForKind(def.kind),
    params,
    routerMode: false,
    modelConfigIds: [],
  };
}
