/**
 * strata engine driver (docs/todo.md #21 Phase 4).
 *
 * A strata deployment is launched as a Python HTTP server that owns a resident
 * engine process:
 *
 *   <python> -m serve.server --engine strata --config <generated>.json --port N …
 *
 * run from the Strata repo root, because `serve` is a package inside it. That
 * layout does not match the worker's default of `<buildPath>/<binary>` with
 * `cwd = buildPath`, so this driver supplies a full launch plan through
 * `buildLaunch` and the process layer stays generic.
 *
 * The config file itself is written by the launch endpoint (like llama.cpp's
 * router INI) — the driver only reads `spec.strataConfigPath`, keeping it free
 * of side effects.
 *
 * Log parsing: the server prints its own progress lines plus the engine's. The
 * patterns below cover the ones that matter for status and metrics; anything
 * else is plain text.
 */

import type { LlamaConfig, PerfMetrics } from '../types.js';
import type { LogEntry, ParsedLog } from './llama.js';
import type { DriverLaunch, EngineDriver } from './driver.js';

/** Python interpreter for an instance: the instance's `binary` field. */
function pythonOf(spec: LlamaConfig): string {
  return spec.binary.trim() || 'python';
}

export const strataDriver: EngineDriver = {
  kind: 'strata',

  // Unused when buildLaunch is present; kept for interface completeness.
  binaryName: (spec) => pythonOf(spec),
  buildArgs: (spec) => buildLaunch(spec).args,

  buildLaunch,

  toLogEntry(line: string): LogEntry {
    return { raw: line, level: strataLevel(line) };
  },

  extractMetrics(line: string, current: PerfMetrics): PerfMetrics | null {
    const parsed = parseStrataLine(line);
    if (!parsed) return null;
    const next = { ...current, lastUpdated: Date.now() };
    let changed = false;
    if (parsed.prefillTokensPerSec !== null) {
      next.prefillTokensPerSec = parsed.prefillTokensPerSec;
      changed = true;
    }
    if (parsed.generationTokensPerSec !== null) {
      next.generationTokensPerSec = parsed.generationTokensPerSec;
      changed = true;
    }
    return changed ? next : null;
  },
};

/**
 * The generated config file carries every option (engine args, server options,
 * vision, config-only keys), so the command line stays minimal. `--port` is the
 * one exception: `serve/server.py` reads `port` only from the CLI, never from
 * the config, so it is always passed explicitly.
 *
 * `--host` / `--api-key` are deliberately NOT repeated — the server reads
 * `host` and `api_key` from the config, and duplicating them risks the CLI
 * silently overriding a value the user edited in the dialog.
 */
function buildLaunch(spec: LlamaConfig): DriverLaunch {
  const args = ['-m', 'serve.server', '--engine', 'strata'];
  if (spec.strataConfigPath) args.push('--config', spec.strataConfigPath);
  if (spec.port) args.push('--port', String(spec.port));
  return {
    // `-m serve.server` resolves the package from the repo root, so cwd is the
    // Strata checkout (carried in llamaCppPath for strata instances).
    command: pythonOf(spec),
    args,
    cwd: spec.llamaCppPath,
  };
}

/** Level coloring: the server prefixes warnings/errors in its own lines. */
export function strataLevel(line: string): LogEntry['level'] {
  if (/\bFATAL\b|Traceback|\bCRITICAL\b/i.test(line)) return 'F';
  if (/\bERROR\b|\berror:|\bfailed\b/i.test(line)) return 'E';
  if (/\bWARN\b|WARNING/i.test(line)) return 'W';
  return 'plain';
}

/**
 * Structured fields the server prints around a generation. Two shapes are
 * recognized:
 *   "tg = 74.89 t/s" style timing lines (llama.cpp-compatible wording)
 *   "prefill 1234 tok in 8.20 s" / "decode 512 tok in 6.83 s"
 */
export function parseStrataLine(line: string): {
  prefillTokensPerSec: number | null;
  generationTokensPerSec: number | null;
} | null {
  let prefill: number | null = null;
  let generation: number | null = null;

  const tg = /tg(?:_3s)?\s*=\s*([\d.]+)\s*t\/s/.exec(line);
  if (tg) generation = Number(tg[1]);
  const pp = /pp\s*=\s*([\d.]+)\s*t\/s/.exec(line);
  if (pp) prefill = Number(pp[1]);

  const rate = /(\bprefill|\bdecode)\b.*?([\d.]+)\s*tok\/s/.exec(line);
  if (rate) {
    const v = Number(rate[2]);
    if (rate[1] === 'prefill') prefill = v;
    else generation = v;
  }

  if (prefill === null && generation === null) return null;
  return { prefillTokensPerSec: prefill, generationTokensPerSec: generation };
}
