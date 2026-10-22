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
import { strataPort } from './strata.js';
import { paramValue, paramValueAny } from './store.js';
import type { EngineDefinition, EngineInstance } from './types.js';

/**
 * `routerIniPath` is passed in by the caller because generating it requires
 * reading model configs and writing a file (side effects kept out of here).
 * `strataConfigPath` is likewise caller-generated for strata instances.
 *
 * host/port/api-key are plain params on the instance; the llama.cpp driver
 * still expects them as spec fields (legacy launch parity), so they are read
 * back out of the param list here. `paramsOnly` tells the driver that
 * `extraArgs` is the whole story: it must not inject defaults for flags the
 * instance does not list, so the launched command line matches the Command
 * tab exactly.
 */
export function instanceToLlamaConfig(
  instance: EngineInstance,
  definition: EngineDefinition,
  routerIniPath?: string,
  strataConfigPath?: string,
): LlamaConfig {
  const portParam = paramValueAny(instance.params, '--port');
  const port = Number(portParam);
  const strata = instance.strata;
  const kind = instance.kind || definition.kind;
  return {
    ...DEFAULT_CONFIG,
    // A strata instance carries its own repo root in `strata.cwd`; the
    // definition's build folder is a llama.cpp concept.
    llamaCppPath: strata ? strata.cwd : definition.buildPath,
    modelsDir: '',
    routerIniPath: routerIniPath ?? '',
    strataConfigPath: strataConfigPath ?? '',
    envVars: definition.envVars,
    // llama.cpp kinds pick one of the two known binaries; other kinds launch
    // whatever executable the instance names (passthrough driver).
    binary: kind === 'llamacpp'
      ? (instance.binary === 'llama-cli' ? 'llama-cli' : 'llama-server')
      : instance.binary,
    modelPath: instance.routerMode ? '' : (instance.modelPath ?? ''),
    mmproj: instance.routerMode ? undefined : instance.mmproj,
    host: paramValue(instance.params, '--host') ?? '',
    port: Number.isInteger(port) && port > 0
      ? port
      : (strataPort(strata) ?? DEFAULT_CONFIG.port),
    apiKey: paramValue(instance.params, '--api-key') ?? '',
    extraArgs: paramsToArgs(instance.params),
    paramsOnly: true,
  };
}
