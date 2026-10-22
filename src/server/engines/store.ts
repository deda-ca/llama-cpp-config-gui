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
    out.push(typeof value === 'string' ? { key: key.trim(), value } : { key: key.trim() });
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

function normalizeInstance(raw: unknown, index: number): EngineInstance | null {
  const i = (raw ?? {}) as Partial<EngineInstance>;
  if (!i || typeof i !== 'object') return null;
  const id = typeof i.id === 'string' && i.id ? i.id : `inst-${index}`;
  const port = typeof i.port === 'number' && Number.isFinite(i.port) ? i.port : 8080;
  return {
    id,
    name: typeof i.name === 'string' && i.name ? i.name : id,
    definitionId: typeof i.definitionId === 'string' ? i.definitionId : 'default',
    binary: typeof i.binary === 'string' && i.binary ? i.binary : 'llama-server',
    host: typeof i.host === 'string' && i.host ? i.host : '127.0.0.1',
    port,
    apiKey: typeof i.apiKey === 'string' ? i.apiKey : '',
    params: normalizeEngineParams(i.params),
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

  const instance: EngineInstance = {
    id: 'default',
    name: 'default',
    definitionId: 'default',
    binary: legacy.binary || 'llama-server',
    host: legacy.host || '127.0.0.1',
    port: legacy.port || 8080,
    apiKey: legacy.apiKey || '',
    params: tokensToParams(splitArgs(legacy.extraArgs || '')),
    routerMode: false,
    modelConfigIds: [],
    ...(legacy.modelPath ? { modelPath: legacy.modelPath } : {}),
    ...(legacy.mmproj ? { mmproj: legacy.mmproj } : {}),
  };

  return { definitions: [definition], instances: [instance], defaultInstanceId: 'default' };
}

/** True when `port` is used by another instance (optionally excluding one). */
export function isPortTaken(data: EnginesFile, port: number, excludeInstanceId?: string): boolean {
  return data.instances.some((i) => i.port === port && i.id !== excludeInstanceId);
}

/** First free port at or after `base`, avoiding all instances plus `reserved`. */
export function findFreePort(data: EnginesFile, base: number, reserved: number[] = []): number {
  let port = base;
  const taken = new Set([...data.instances.map((i) => i.port), ...reserved]);
  while (taken.has(port)) port++;
  return port;
}

/** Convenience for creating a blank instance bound to a definition. */
export function blankInstance(name: string, def: EngineDefinition, existing: EnginesFile): EngineInstance {
  return {
    id: makeEngineId(name, existing.instances),
    name,
    definitionId: def.id,
    binary: defaultBinaryForKind(def.kind),
    host: '127.0.0.1',
    port: findFreePort(existing, 8080),
    apiKey: '',
    params: [],
    routerMode: false,
    modelConfigIds: [],
  };
}
