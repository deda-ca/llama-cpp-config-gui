/**
 * Engine types for multi-instance engine launching (docs/llm-engines.md §2, §6).
 *
 * Three concepts:
 *  - EngineDefinition: a named, reusable build ("which executable + env vars"),
 *    generalizing today's single EnvironmentConfig (todo #11).
 *  - EngineInstance:  a launchable entry — a definition + executable/params/model
 *    selection. Launching spawns one child process tracked by instance id.
 *  - EngineParam:     one CLI argument. `value === undefined` means a flag-only
 *    key (e.g. `--metrics`); a string value is passed as key + value
 *    (e.g. `--host 0.0.0.0`). Empty string value is treated as "not set".
 *
 * Storage lives in `.config/engines.json` (see store.ts). Phase 1 only uses
 * kind 'llamacpp'; other kinds are accepted by the type but have no driver yet.
 */

import type { ProxyBackendKind } from '../proxy/types.js';

/** Engine families that can be spawned. Reuses the proxy backend vocabulary. */
export type EngineKind = ProxyBackendKind;

export const ENGINE_KINDS: EngineKind[] = [
  'llamacpp',
  'audio',
  'sdiffusion',
  'embeddings',
  'moderation',
  'videos',
  'default',
  'custom',
];

export function isEngineKind(v: unknown): v is EngineKind {
  return ENGINE_KINDS.includes(v as EngineKind);
}

/** A named build folder + environment, reusable across instances. */
export interface EngineDefinition {
  /** Stable slug id, derived from name on creation. */
  id: string;
  name: string;
  kind: EngineKind;
  /** Folder containing the engine executable (e.g. the llama.cpp build dir). */
  buildPath: string;
  /** Environment variables for spawned processes; empty-string values are skipped. */
  envVars: Record<string, string>;
}

/** One CLI argument on an instance: key + optional value (flag-only when absent). */
export interface EngineParam {
  /** Full flag as the user typed it, e.g. "--host" or "-ngl". */
  key: string;
  /** Argument value; undefined = flag-only (boolean switch). */
  value?: string;
  /** Row kept in the config but excluded from the launch (editor "off" toggle). */
  disabled?: boolean;
}

/** A launchable engine: definition + runtime settings + model selection. */
export interface EngineInstance {
  /** Stable slug id, derived from name on creation. */
  id: string;
  name: string;
  /** Free-form notes shown in the editor (not part of the launch). */
  notes: string;
  /** EngineDefinition this instance launches from. */
  definitionId: string;
  /** Executable name inside the build folder (llama.cpp: "llama-server" | "llama-cli"). */
  binary: string;
  /** Ordered CLI parameters applied to every launch of this instance. Server
   * options (--host/--port/--api-key, ...) are ordinary params, not fields. */
  params: EngineParam[];
  /** llama.cpp only: launch in router mode with these model config ids. */
  routerMode: boolean;
  /** llama.cpp only: model config ids (models.json) used in router mode. */
  modelConfigIds: string[];
  /** llama.cpp only (non-router): single model path, .gguf. */
  modelPath?: string;
  /** llama.cpp only (non-router): multimodal projector file. */
  mmproj?: string;
}

export interface EnginesFile {
  definitions: EngineDefinition[];
  instances: EngineInstance[];
  /** Instance used by the legacy /api/launch, /api/stop, /api/status aliases. */
  defaultInstanceId: string | null;
}

export const EMPTY_ENGINES: EnginesFile = {
  definitions: [],
  instances: [],
  defaultInstanceId: null,
};

/** Default executable per kind (used when creating new instances). */
export function defaultBinaryForKind(kind: EngineKind): string {
  switch (kind) {
    case 'llamacpp':
      return 'llama-server';
    default:
      return '';
  }
}
