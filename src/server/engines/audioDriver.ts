/**
 * audio.cpp engine driver (docs/audio.md, docs/todo.md #21 Phase 4).
 *
 * `audiocpp_server` takes exactly one interesting flag — `--config <file.json>`
 * holding the server options and the `models[]` array — and resolves every
 * relative path inside that file against the *file's* folder. The launch
 * endpoint therefore writes `.config/audio-<instance>.json` with absolute
 * paths before starting the process (like strata's generated JSON), and this
 * driver only reads `spec.audioConfigPath`, staying side-effect free.
 *
 * The executable is the instance's `binary` field (default
 * `audiocpp_server`), usually a path into the build tree such as
 * `audio.cpp/build/bin/audiocpp_server`. A relative binary resolves against
 * the instance's run folder (carried in `llamaCppPath` for audio instances),
 * matching how the user launches it by hand; a bare name is left to PATH.
 *
 * Log parsing: audio.cpp prints plain text with no structured perf lines
 * (docs/audio.md §1.4), so there are no metrics to extract — only level
 * coloring for its `ERROR:`/`WARNING:` prefixes.
 */

import path from 'path';
import type { LlamaConfig } from '../types.js';
import type { LogEntry } from './llama.js';
import type { DriverLaunch, EngineDriver } from './driver.js';

/** Executable for an instance: the instance's `binary` field. */
function exeOf(spec: LlamaConfig): string {
  return spec.binary.trim() || 'audiocpp_server';
}

export const audioDriver: EngineDriver = {
  kind: 'audio',

  // Unused when buildLaunch is present; kept for interface completeness.
  binaryName: (spec) => exeOf(spec),
  buildArgs: (spec) => buildLaunch(spec).args,

  buildLaunch,

  toLogEntry(line: string): LogEntry {
    return { raw: line, level: audioLevel(line) };
  },
};

/**
 * `audiocpp_server --config <generated>.json`, run from the instance's run
 * folder so a relative `binary` and any env-var-relative paths behave as they
 * do in the user's shell. `--config` is required unless `--ui` is passed, and
 * we always generate a config, so it is unconditional.
 */
function buildLaunch(spec: LlamaConfig): DriverLaunch {
  const cwd = spec.llamaCppPath;
  const exe = exeOf(spec);
  const command = !path.isAbsolute(exe) && exe.includes('/') ? path.resolve(cwd, exe) : exe;
  const args = ['--config', spec.audioConfigPath ?? ''];
  return { command, args, cwd };
}

/** Level coloring: audio.cpp prefixes its own diagnostics. */
export function audioLevel(line: string): LogEntry['level'] {
  if (/audiocpp_server failed|Fatal|terminate called/i.test(line)) return 'F';
  if (/ERROR:|\bfailed\b/i.test(line)) return 'E';
  if (/WARNING:|WARN\b/i.test(line)) return 'W';
  return 'plain';
}
