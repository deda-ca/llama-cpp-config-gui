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
 * `audiocpp_server`), named with a full path like the llama.cpp editors do —
 * so the working directory is that path's folder (carried in `llamaCppPath`
 * for audio instances, the same layout the llama.cpp driver uses). A bare
 * name is left to PATH.
 *
 * Version probe: `audiocpp_server --version` prints its build banner
 * (`audio.cpp <ver>`, `git: <sha> <date>`, `build: …`, `backends: …`).
 *
 * Log parsing: audio.cpp prints plain text with no structured perf lines
 * (docs/audio.md §1.4), so there are no metrics to extract — only level
 * coloring for its `ERROR:`/`WARNING:` prefixes.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { LlamaConfig } from '../types.js';
import type { LogEntry } from './llama.js';
import type { DriverLaunch, DriverVersionInfo, EngineDriver } from './driver.js';

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
  getVersion: getAudioVersion,

  toLogEntry(line: string): LogEntry {
    return { raw: line, level: audioLevel(line) };
  },
};

/**
 * `audiocpp_server --version`, run from the build folder. The banner is fixed
 * by `app/common/build_info.cpp`:
 *   audio.cpp dev
 *   git: d3ab9df2 2026-10-04
 *   build: Release, gcc 15.2.0, Linux x86_64
 *   backends: cpu,cuda
 * `version` is the CMake `AUDIOCPP_VERSION` string (often just `dev`), so the
 * git sha is the field that actually identifies a build.
 */
export function getAudioVersion(exePath: string): Promise<DriverVersionInfo> {
  const empty: DriverVersionInfo = {
    version: null, build: null, commit: null, compiler: null, backend: null, raw: [],
  };
  return new Promise((resolve) => {
    if (!exePath || !fs.existsSync(exePath)) {
      resolve(empty);
      return;
    }
    execFile(exePath, ['--version'], { cwd: path.dirname(exePath), timeout: 10000 },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          resolve(empty);
          return;
        }
        const lines = (stdout + '\n' + stderr).split('\n').filter((l) => l.trim()).slice(0, 10);
        let version: string | null = null;
        let build: string | null = null;
        let commit: string | null = null;
        let compiler: string | null = null;
        let backend: string | null = null;
        for (const line of lines) {
          // audio.cpp <version>
          const vMatch = line.match(/^audio\.cpp\s+(\S+)/);
          if (vMatch) {
            version = vMatch[1];
            continue;
          }
          // git: <sha> <date>
          const gMatch = line.match(/^git:\s*([0-9a-f]{7,40})/i);
          if (gMatch) {
            commit = gMatch[1];
            continue;
          }
          // build: <type>, <compiler> <version>, <system> <arch>
          const bMatch = line.match(/^build:\s*([^,]+),\s*([^,]+),/);
          if (bMatch) {
            build = bMatch[1].trim();
            compiler = bMatch[2].trim();
            continue;
          }
          // backends: cpu,cuda — prefer a GPU backend for the badge
          const beMatch = line.match(/^backends:\s*(.+)$/);
          if (beMatch) {
            const list = beMatch[1].split(',').map((b) => b.trim()).filter(Boolean);
            backend = list.find((b) => /cuda|hip|vulkan|metal/i.test(b)) ?? list[0] ?? null;
          }
        }
        resolve({ version, build, commit, compiler, backend, raw: lines });
      });
  });
}

/**
 * `audiocpp_server --config <generated>.json [--parallel-jobs]`. The instance
 * names the executable with a full path, so a path with a slash is absolutized
 * and the working directory is its folder — matching `audioRunDir`, which the
 * launch mapping stores in `llamaCppPath`. A bare name is left to PATH, and the
 * process inherits the app's cwd. `--config` is required unless `--ui` is
 * passed, and we always generate a config, so it is unconditional.
 * `--parallel-jobs` (the experimental parallel runtime) is a CLI-only flag:
 * upstream never reads it from the JSON, so it rides on the command line when
 * the instance's `audio.parallelJobs` is on.
 */
function buildLaunch(spec: LlamaConfig): DriverLaunch {
  const exe = exeOf(spec);
  const command = exe.includes('/') ? path.resolve(exe) : exe;
  const cwd = command.includes('/') ? path.dirname(command) : spec.llamaCppPath;
  const args = ['--config', spec.audioConfigPath ?? ''];
  if (spec.audioParallelJobs) args.push('--parallel-jobs');
  return { command, args, cwd };
}

/** Level coloring: audio.cpp prefixes its own diagnostics. */
export function audioLevel(line: string): LogEntry['level'] {
  if (/audiocpp_server failed|Fatal|terminate called/i.test(line)) return 'F';
  if (/ERROR:|\bfailed\b/i.test(line)) return 'E';
  if (/WARNING:|WARN\b/i.test(line)) return 'W';
  return 'plain';
}
