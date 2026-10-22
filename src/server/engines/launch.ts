/**
 * Map an EngineInstance + EngineDefinition to the LlamaConfig launch spec used
 * by LlamaProcessManager (docs/llm-engines.md §6.1).
 *
 * Kept as a pure function so the mapping is testable without spawning
 * processes. llama.cpp is the only kind with a driver in Phase 1; other kinds
 * get a generic spec (binary + params) that the Phase 3 driver interface will
 * formalize.
 */

import { DEFAULT_CONFIG } from '../config.js';
import type { LlamaConfig } from '../types.js';
import { paramsToArgs } from './args.js';
import type { EngineDefinition, EngineInstance } from './types.js';

/**
 * `routerIniPath` is passed in by the caller because generating it requires
 * reading model configs and writing a file (side effects kept out of here).
 */
export function instanceToLlamaConfig(
  instance: EngineInstance,
  definition: EngineDefinition,
  routerIniPath?: string,
): LlamaConfig {
  return {
    ...DEFAULT_CONFIG,
    llamaCppPath: definition.buildPath,
    modelsDir: '',
    routerIniPath: routerIniPath ?? '',
    envVars: definition.envVars,
    binary: (instance.binary === 'llama-cli' ? 'llama-cli' : 'llama-server'),
    modelPath: instance.routerMode ? '' : (instance.modelPath ?? ''),
    mmproj: instance.routerMode ? undefined : instance.mmproj,
    host: instance.host,
    port: instance.port,
    apiKey: instance.apiKey,
    extraArgs: paramsToArgs(instance.params),
  };
}
