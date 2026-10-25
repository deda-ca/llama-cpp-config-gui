/**
 * stable-diffusion.cpp engine driver (docs/stable-diffusion.md §3.4).
 *
 * `sd-server` is a plain flag-driven HTTP server: it has **no config file**
 * (unlike strata's JSON or audio's `--config`), so the launch is just the
 * instance's `sd.serverArgs` rows rendered to argv. It is also self-contained
 * like audio — the instance names the executable with a full path, so the
 * working directory is that path's folder (`sdRunDir`, mirroring `audioRunDir`);
 * a bare name is left to PATH.
 *
 * **Option A (§1.4.1): no weight flags on the command line.** The server starts
 * empty from its `--model-dir` roots and every model — including the first —
 * arrives over `POST /sdcpp/v1/models/load` after the process is up. So
 * `buildLaunch` emits only server options; the model-management layer (§3.10)
 * drives loading. The argv fallback (§3.3) is the only path that puts weights
 * on the line, and it does so by adding rows to the same `serverArgs` list, so
 * the driver stays agnostic.
 *
 * Version probe: `sd-server --version` prints one line to stdout:
 *   `stable-diffusion.cpp version master-1004-a85db96-2-g0886f11, commit 0886f11`
 * — `version <build>` → `version`, `commit <sha>` → `commit`.
 *
 * Device probe: `sd-cli --list-devices` prints `name<TAB>description` lines on
 * stdout (`CUDA0  NVIDIA GeForce RTX 5070 Ti`) after a ggml banner on stderr
 * that carries the per-device VRAM. The names are exactly what `--backend` /
 * `--params-backend` accept (§1.6).
 *
 * Log parsing: sd.cpp tags each line with a single letter — `[D]/[V]/[I]/[W]/
 * [E] message --- file.cpp:123` (`examples/common/log.cpp`). Only level
 * coloring, no metrics: there is no `print_timing`-equivalent perf line (§1.7).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { LlamaConfig, LlamaDevice } from '../types.js';
import type { LogEntry } from './llama.js';
import type { DriverLaunch, DriverVersionInfo, EngineDriver } from './driver.js';
import { paramsToArgv } from './args.js';

/** Executable for an instance: the instance's `binary` field. */
function exeOf(spec: LlamaConfig): string {
  return spec.binary.trim() || 'sd-server';
}

export const sdDriver: EngineDriver = {
  kind: 'sdiffusion',

  // Unused when buildLaunch is present; kept for interface completeness.
  binaryName: (spec) => exeOf(spec),
  buildArgs: (spec) => buildLaunch(spec).args,

  buildLaunch,
  getVersion: getSdVersion,
  listDevices: listSdDevices,

  toLogEntry(line: string): LogEntry {
    return { raw: line, level: sdLevel(line) };
  },
};

/**
 * `sd-server <serverArgs…>`. The instance names the executable with a full
 * path, so a path with a slash is absolutized and the working directory is its
 * folder (matching `sdRunDir`, which the launch mapping stores in
 * `llamaCppPath`); a bare name is left to PATH and inherits the app's cwd.
 *
 * The args are the block's flag rows verbatim (`--listen-ip`, `--listen-port`,
 * one `--model-dir` per root, plus any device/generation flag). In Option A
 * there are no weight flags — the model arrives over the API — and the argv
 * fallback simply adds weight rows to the same list, so nothing here changes.
 */
function buildLaunch(spec: LlamaConfig): DriverLaunch {
  const exe = exeOf(spec);
  const command = exe.includes('/') ? path.resolve(exe) : exe;
  const cwd = command.includes('/') ? path.dirname(command) : spec.llamaCppPath;
  return { command, args: paramsToArgv(spec.sdArgs ?? []), cwd };
}

/**
 * `sd-server --version`, run from the executable's folder. One stdout line:
 *   stable-diffusion.cpp version master-1004-a85db96-2-g0886f11, commit 0886f11
 * `version` is the git describe string (the field that identifies the build);
 * `commit` is the short sha. `build`/`compiler`/`backend` are not reported.
 *
 * `exePath` is the full executable path (the Environment dialog posts it), but
 * a build folder is accepted too for parity with the llama.cpp probe.
 */
export function getSdVersion(exePath: string): Promise<DriverVersionInfo> {
  const empty: DriverVersionInfo = {
    version: null, build: null, commit: null, compiler: null, backend: null, raw: [],
  };
  return new Promise((resolve) => {
    const exe = resolveSdBinary(exePath, 'sd-server');
    if (!exe) {
      resolve(empty);
      return;
    }
    execFile(exe, ['--version'], { cwd: path.dirname(exe), timeout: 10000 },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          resolve(empty);
          return;
        }
        const lines = (stdout + '\n' + stderr).split('\n').filter((l) => l.trim()).slice(0, 10);
        let version: string | null = null;
        let commit: string | null = null;
        for (const line of lines) {
          // version <build> (git describe, e.g. master-1004-a85db96-2-g0886f11)
          const vMatch = line.match(/version\s+([A-Za-z0-9._-]+)/);
          if (vMatch && !version) version = vMatch[1];
          // commit <sha>
          const cMatch = line.match(/commit\s+([0-9a-f]{7,40})/i);
          if (cMatch) commit = cMatch[1];
        }
        resolve({ version, build: null, commit, compiler: null, backend: null, raw: lines });
      });
  });
}

/**
 * `sd-cli --list-devices`, run next to the server binary (falling back to the
 * server binary itself if `sd-cli` is absent). stdout carries `name<TAB>
 * description` lines; stderr carries the ggml banner with `Device N: <name>,
 * …, VRAM: <n> MiB`, which is the only place the memory size appears.
 *
 * Device names are relative to `CUDA_VISIBLE_DEVICES`; the GUI never masks it
 * for sd instances (§5 Q5), so the enumerated names are stable and match the
 * physical order — and are exactly what `--backend` accepts.
 */
export function listSdDevices(buildPath: string): Promise<LlamaDevice[]> {
  return new Promise((resolve) => {
    const exe = resolveSdBinary(buildPath, 'sd-cli') ?? resolveSdBinary(buildPath, 'sd-server');
    if (!exe) {
      resolve([]);
      return;
    }
    execFile(exe, ['--list-devices'], { cwd: path.dirname(exe), timeout: 10000 },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(parseSdDevices(stdout, stderr));
      });
  });
}

/**
 * Parse the two device outputs. The `name<TAB>description` lines (stdout) are
 * authoritative for name/type/index; the ggml banner (stderr) supplies VRAM by
 * device **index** (`Device 0:` ↔ `CUDA0`). Matching by name would collapse
 * identical GPUs — a multi-GPU box with the same card four times is exactly the
 * common case — so the index is the join key. A line like `CUDA0  NVIDIA …`
 * becomes `{ index: 0, type: 'CUDA', name: 'NVIDIA …' }`; `CPU` has no index.
 */
export function parseSdDevices(stdout: string, stderr: string): LlamaDevice[] {
  // VRAM per device index, from the ggml banner: "Device 0: <name>, … VRAM: 15838 MiB"
  const vramByIndex = new Map<number, number>();
  const bannerRe = /Device\s+(\d+):.*?VRAM:\s*(\d+)\s*MiB/gis;
  let b: RegExpExecArray | null;
  while ((b = bannerRe.exec(stderr)) !== null) {
    vramByIndex.set(parseInt(b[1], 10), parseInt(b[2], 10));
  }

  const devices: LlamaDevice[] = [];
  // name<TAB>description (TAB-separated). Skip the ggml banner lines, which are
  // indented or start with "Device"/"ggml" and carry no TAB.
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\w+)\t(.+)$/);
    if (!m) continue;
    const typeLabel = m[1]; // CUDA0, CUDA1, CPU, …
    const name = m[2].trim();
    const type = typeLabel.replace(/\d+$/, '');
    const index = parseInt(typeLabel.replace(/\D/g, ''), 10);
    const hasIndex = !Number.isNaN(index);
    devices.push({
      index: hasIndex ? index : devices.length,
      name,
      type,
      memoryTotalMb: hasIndex ? (vramByIndex.get(index) ?? 0) : 0,
    });
  }
  return devices;
}

/**
 * Locate an sd executable from a path that may be a full executable path (the
 * Environment dialog posts the instance's `binary`) or a build folder. Returns
 * the file if it exists, else `<dir>/<name>` if that exists, else null.
 */
function resolveSdBinary(p: string, name: string): string | null {
  if (!p) return null;
  try {
    if (fs.statSync(p).isFile()) return p;
  } catch {
    // not a file — treat as a folder below
  }
  const candidate = path.join(p, name);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Level coloring from sd.cpp's single-letter tags (`log.cpp`): `[E]` error,
 * `[W]` warn, `[I]/[V]/[D]` informational. INFO/VERBOSE/DEBUG are 'plain' so
 * only actionable levels stand out, matching the llama.cpp view. A bare
 * error/failed mention (e.g. an untagged ggml init failure) still reads as E.
 */
export function sdLevel(line: string): LogEntry['level'] {
  const tag = /^\s*\[([DWIVE])\]/.exec(line)?.[1];
  if (tag === 'E') return 'E';
  if (tag === 'W') return 'W';
  if (tag === 'I' || tag === 'V' || tag === 'D') return 'plain';
  if (/failed to initialize|\bERROR\b|terminate called|what\(\):/i.test(line)) return 'E';
  return 'plain';
}
