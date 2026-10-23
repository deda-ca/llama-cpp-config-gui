/**
 * Map an EngineInstance + EngineDefinition to the LlamaConfig launch spec used
 * by the process worker (docs/llm-engines.md §6.1).
 *
 * Kept as a pure function so the mapping is testable without spawning
 * processes. The spec is a superset: llama.cpp fields are filled for the
 * llama.cpp driver, while other kinds ignore them and launch from `binary` +
 * `extraArgs` through their own driver (Phase 3).
 */

import path from 'path';
import { configDir, DEFAULT_CONFIG } from '../config.js';
import type { LlamaConfig } from '../types.js';
import { paramsToArgs } from './args.js';
import { strataPort, strataRepoRoot } from './strata.js';
import { audioPort, audioRunDir } from './audio.js';
import { paramValue, paramValueAny } from './store.js';
import type { EngineDefinition, EngineInstance } from './types.js';

/** The generated router INI an instance launches from in router mode. Shared
 * by the launch path and the Command-tab preview so both name the same file. */
export function routerIniPathFor(instanceId: string): string {
  return path.join(configDir(), `router-${instanceId}.ini`);
}

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
  audioConfigPath?: string,
): LlamaConfig {
  const portParam = paramValueAny(instance.params, '--port');
  const port = Number(portParam);
  const strata = instance.strata;
  const audio = instance.audio;
  const kind = instance.kind || definition.kind;
  return {
    ...DEFAULT_CONFIG,
    // A strata instance carries its own repo root in the `cwd` deployment row.
    // An audio instance names its executable with a full path, so the working
    // directory is that executable's folder; the definition's build folder is
    // a llama.cpp concept neither kind uses.
    llamaCppPath: strata ? strataRepoRoot(strata) : audio ? audioRunDir(instance.binary) : definition.buildPath,
    modelsDir: '',
    routerIniPath: routerIniPath ?? '',
    strataConfigPath: strataConfigPath ?? '',
    audioConfigPath: audioConfigPath ?? '',
    audioParallelJobs: audio?.parallelJobs === true,
    // An audio instance has no definition to carry env vars, so its block owns
    // them (CUDA_VISIBLE_DEVICES etc.); every other kind inherits the
    // definition's environment.
    envVars: audio ? { ...definition.envVars, ...audio.envVars } : definition.envVars,
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
      : (strataPort(strata) ?? audioPort(audio) ?? DEFAULT_CONFIG.port),
    apiKey: paramValue(instance.params, '--api-key') ?? '',
    extraArgs: paramsToArgs(instance.params),
    paramsOnly: true,
  };
}
