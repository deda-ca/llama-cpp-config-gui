/**
 * Map an EngineInstance + EngineDefinition to the LlamaConfig launch spec used
 * by the process worker (docs/llm-engines.md §6.1).
 *
 * Kept as a pure function so the mapping is testable without spawning
 * processes. The spec is a superset: llama.cpp fields are filled for the
 * llama.cpp driver, while other kinds ignore them and launch from `binary` +
 * `extraArgs` through their own driver (Phase 3).
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
    // llama.cpp kinds pick one of the two known binaries; other kinds launch
    // whatever executable the instance names (passthrough driver).
    binary: definition.kind === 'llamacpp'
      ? (instance.binary === 'llama-cli' ? 'llama-cli' : 'llama-server')
      : instance.binary,
    modelPath: instance.routerMode ? '' : (instance.modelPath ?? ''),
    mmproj: instance.routerMode ? undefined : instance.mmproj,
    host: instance.host,
    port: instance.port,
    apiKey: instance.apiKey,
    extraArgs: paramsToArgs(instance.params),
  };
}
