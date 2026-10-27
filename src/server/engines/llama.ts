/**
 * llama.cpp engine driver (docs/llm-engines.md §2.1).
 *
 * All llama.cpp-specific knowledge lives here: the `--version` probe, device
 * listing via `llama-cli --list-devices`, GPU/CUDA name matching, the CLI arg
 * builder, and the structured log format (line parsing, print_timing metrics).
 * The generic process layer (`worker.ts`) calls into this driver; nothing
 * outside `src/server/engines/` should import these helpers directly.
 *
 * Log format reference (llama.cpp):
 *   [PID] timestamp LEVEL component [function]: message
 *   - The [PID] prefix is optional (present in some builds/contexts).
 *   - The function field is optional (e.g. "E ggml_cuda_init: ..." has no function).
 * Examples:
 *   [55997] 113.23.820.783 I slot print_timing: id  0 | task 38633 | n_gen =    228, tg =  74.89 t/s, tg_3s =  75.22 t/s
 *   0.20.763.882 I slot print_timing: id  3 | task 0 | prompt eval time =      55.97 ms /     8 tokens (...)
 *   0.00.070.233 E ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected
 */

import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { LlamaConfig, LlamaDevice, PerfMetrics } from '../types.js';
import { splitArgs } from './args.js';
import type { DriverVersionInfo, EngineDriver } from './driver.js';

// --- Version / build info from llama-server ---

/** llama.cpp's version probe result — same shape as the driver's VersionInfo. */
export type LlamaVersionInfo = DriverVersionInfo;

export function getLlamaVersion(llamaCppPath: string): Promise<LlamaVersionInfo> {
  return new Promise((resolve) => {
    const binary = path.join(llamaCppPath, 'llama-server');
    if (!fs.existsSync(binary)) {
      resolve({ version: null, build: null, commit: null, compiler: null, backend: null, raw: [] });
      return;
    }

    execFile(binary, ['--version'], { cwd: llamaCppPath, timeout: 10000 }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        resolve({ version: null, build: null, commit: null, compiler: null, backend: null, raw: [] });
        return;
      }
      // llama-server writes --version output to stderr, not stdout
      const output = (stdout + '\n' + stderr).trim();
      const lines = output.split('\n').filter((l) => l.trim()).slice(0, 10);

      // New format (>= b6000-ish):
      //   version: 0.5.0-dev (build 11242, commit 526c43b8f)
      //   built with GNU 15.2.0 for Linux x86_64
      // Old format:
      //   version: 7841 (abc123def)
      let version: string | null = null;
      let build: string | null = null;
      let commit: string | null = null;
      let compiler: string | null = null;
      let backend: string | null = null;

      for (const line of lines) {
        // New format: version: X.Y.Z[-suffix] (build NNNN, commit HASH)
        const newMatch = line.match(/version:\s*([\w.+-]+)\s*\(\s*build\s+(\d+)(?:,\s*commit\s+([0-9a-f]{7,40}))?\s*\)/i);
        if (newMatch) {
          version = newMatch[1];
          build = newMatch[2];
          commit = newMatch[3] || null;
          continue;
        }
        // Old format: version: NNNN (HASH)
        const oldMatch = line.match(/version:\s*(\d+)\s*(?:\(([0-9a-f]{7,40})\))?/i);
        if (oldMatch) {
          build = oldMatch[1];
          commit = oldMatch[2] || null;
          continue;
        }
        // Compiler / platform line: built with GNU 15.2.0 for Linux x86_64
        const cMatch = line.match(/built with\s+(.+)$/i);
        if (cMatch) compiler = cMatch[1].trim();
        const beMatch = line.match(/(CUDA|HIP|Vulkan|SYCL)/i);
        if (beMatch && !backend) backend = beMatch[1];
      }

      resolve({ version, build, commit, compiler, backend, raw: lines });
    });
  });
}

// --- Device detection via llama-cli --list-devices ---

export function listLlamaDevices(llamaCppPath: string): Promise<LlamaDevice[]> {
  return new Promise((resolve) => {
    const binary = path.join(llamaCppPath, 'llama-cli');
    if (!fs.existsSync(binary)) {
      resolve([]);
      return;
    }

    execFile(binary, ['--list-devices'], { cwd: llamaCppPath, timeout: 10000 }, (error: Error | null, stdout: string) => {
      if (error) {
        resolve([]);
        return;
      }
      const devices: LlamaDevice[] = [];
      // Actual llama-cli --list-devices output format (indented):
      //   CUDA0: NVIDIA GeForce RTX 5070 Ti (15841 MiB, 255 MiB free)
      //   CUDA1: NVIDIA GeForce RTX 3050 (5806 MiB, 5708 MiB free)
      //   BLAS: OpenBLAS (0 MiB, 0 MiB free)
      const re = /^\s*(\w+):\s*(.+?)\s*\((\d+)\s*MiB/gm;
      let match: RegExpExecArray | null;
      while ((match = re.exec(stdout)) !== null) {
        const typeLabel = match[1]; // e.g. "CUDA0", "BLAS"
        const type = typeLabel.replace(/\d+$/, ''); // "CUDA", "BLAS"
        const index = parseInt(typeLabel.replace(/\D/g, '') || '0', 10);
        devices.push({
          index,
          name: match[2].trim(),
          type,
          memoryTotalMb: parseInt(match[3], 10),
        });
      }
      resolve(devices);
    });
  });
}

// Match nvidia-smi GPUs to llama.cpp CUDA devices using optimal assignment.
// Uses Hungarian-style greedy: build a similarity matrix, then assign
// highest-scoring pairs first (each GPU and device used at most once).
export function matchCudaIndices(
  gpuNames: string[],
  devices: LlamaDevice[],
): Map<number, number> {
  const result = new Map<number, number>();
  const cudaDevices = devices
    .filter((d) => d.type.startsWith('CUDA'))
    .sort((a, b) => a.index - b.index);

  if (cudaDevices.length === 0 || gpuNames.length === 0) return result;

  // Build similarity matrix
  interface Pair { smiIdx: number; cudaIdx: number; score: number }
  const pairs: Pair[] = [];
  for (let i = 0; i < gpuNames.length; i++) {
    for (let j = 0; j < cudaDevices.length; j++) {
      const score = nameSimilarity(
        normalizeGpuName(gpuNames[i]),
        normalizeGpuName(cudaDevices[j].name),
      );
      pairs.push({ smiIdx: i, cudaIdx: cudaDevices[j].index, score });
    }
  }

  // Greedy assignment: highest score first, skip if either side already matched
  pairs.sort((a, b) => b.score - a.score);
  const usedSmi = new Set<number>();
  const usedCuda = new Set<number>();

  for (const pair of pairs) {
    if (pair.score < 0.3) break; // below threshold, stop
    if (usedSmi.has(pair.smiIdx) || usedCuda.has(pair.cudaIdx)) continue;
    result.set(pair.smiIdx, pair.cudaIdx);
    usedSmi.add(pair.smiIdx);
    usedCuda.add(pair.cudaIdx);
  }

  return result;
}

function normalizeGpuName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const setA = new Set(a);
  const setB = new Set(b);
  let common = 0;
  for (const ch of setA) if (setB.has(ch)) common++;
  return common / Math.max(setA.size, setB.size);
}

// --- Structured log line parsing ---

export interface ParsedLog {
  /** Process ID, or null when the line has no [PID] prefix */
  pid: number | null;
  timestamp: string;
  level: 'I' | 'W' | 'E' | 'F';
  component: string;
  /** Function/source name, or empty string when absent */
  func: string;
  message: string;
}

// Timestamp is always d.d.d.d (e.g. 0.20.763.882 or 113.23.820.783)
const LOG_RE = /^(?:\[(\d+)\]\s+)?(\d+\.\d+\.\d+\.\d+)\s+([IWEF])\s+(\S+)(?:\s+(\S+?))?\s*:\s*(.*)$/;

/**
 * Parse a single log line into structured fields.
 * Returns null if the line does not match the llama.cpp structured format.
 */
export function parseLogLine(line: string): ParsedLog | null {
  const m = line.match(LOG_RE);
  if (!m) return null;
  return {
    pid: m[1] ? parseInt(m[1], 10) : null,
    timestamp: m[2],
    level: m[3] as 'I' | 'W' | 'E' | 'F',
    component: m[4],
    func: m[5] || '',
    message: m[6],
  };
}

// --- Log entry (raw text + level) for SSE transport & client coloring ---

export type LogLevel = 'I' | 'W' | 'E' | 'F';

export interface LogEntry {
  raw: string;
  /** Parsed log level, or 'plain' when the line is not structured */
  level: LogLevel | 'plain';
}

/**
 * Convert a raw log line into a LogEntry (raw text + level for coloring).
 * Non-structured lines get level 'plain'.
 */
export function toLogEntry(line: string): LogEntry {
  const parsed = parseLogLine(line);
  return { raw: line, level: parsed ? parsed.level : 'plain' };
}

// --- print_timing sub-parsers ---

export interface GenStats {
  type: 'gen-stats';
  id: number;
  task: number;
  nGen: number;
  tg: number;      // avg tokens/s
  tg3s: number;    // tokens/s (last 3s window)
}

export interface PromptEval {
  type: 'prompt-eval';
  id: number;
  task: number;
  timeMs: number;
  tokens: number;
  msPerToken: number;
  tokensPerSec: number;
}

export interface EvalTime {
  type: 'eval-time';
  id: number;
  task: number;
  timeMs: number;
  tokens: number;
  msPerToken: number;
  tokensPerSec: number;
}

export interface TotalTime {
  type: 'total-time';
  id: number;
  task: number;
  timeMs: number;
  tokens: number;
}

export interface PromptProgress {
  type: 'prompt-progress';
  id: number;
  task: number;
  nTokens: number;
  progress: number;   // 0..1
  timeSec: number;
  tokensPerSec: number;
}

export type TimingData = GenStats | PromptEval | EvalTime | TotalTime | PromptProgress;

// Sub-patterns for print_timing message field

const GEN_STATS_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*n_gen\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t\/s,\s*tg_3s\s*=\s*([\d.]+)\s*t\/s$/;

const PROMPT_EVAL_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)$/;

const EVAL_TIME_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)$/;

const TOTAL_TIME_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens$/;

const PROMPT_PROGRESS_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*prompt processing,\s*n_tokens\s*=\s*(\d+),\s*progress\s*=\s*([\d.]+),\s*t\s*=\s*([\d.]+)\s*s\s*\/\s*([\d.]+)\s*tokens per second$/;

/**
 * Parse the message portion of a print_timing log line into structured timing data.
 * Returns null if the message doesn't match any known sub-format.
 */
export function parseTimingMessage(message: string): TimingData | null {
  // Generation stats (ongoing or final)
  let m = message.match(GEN_STATS_RE);
  if (m) {
    return {
      type: 'gen-stats',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      nGen: parseInt(m[3], 10),
      tg: parseFloat(m[4]),
      tg3s: parseFloat(m[5]),
    };
  }

  // Prompt eval time (part of final results group)
  m = message.match(PROMPT_EVAL_RE);
  if (m) {
    return {
      type: 'prompt-eval',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      timeMs: parseFloat(m[3]),
      tokens: parseInt(m[4], 10),
      msPerToken: parseFloat(m[5]),
      tokensPerSec: parseFloat(m[6]),
    };
  }

  // Eval time (part of final results group)
  m = message.match(EVAL_TIME_RE);
  if (m) {
    return {
      type: 'eval-time',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      timeMs: parseFloat(m[3]),
      tokens: parseInt(m[4], 10),
      msPerToken: parseFloat(m[5]),
      tokensPerSec: parseFloat(m[6]),
    };
  }

  // Total time (part of final results group)
  m = message.match(TOTAL_TIME_RE);
  if (m) {
    return {
      type: 'total-time',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      timeMs: parseFloat(m[3]),
      tokens: parseInt(m[4], 10),
    };
  }

  // Prompt processing progress (during prefill)
  m = message.match(PROMPT_PROGRESS_RE);
  if (m) {
    return {
      type: 'prompt-progress',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      nTokens: parseInt(m[3], 10),
      progress: parseFloat(m[4]),
      timeSec: parseFloat(m[5]),
      tokensPerSec: parseFloat(m[6]),
    };
  }

  return null;
}

// --- Perf metrics from legacy (non-print_timing) timing output ---

// Regex patterns for llama.cpp timing output
const PREFILL_RE = /llama_eval\s*:\s+([\d.]+)\s*ms,\s+(\d+)\s*prompt tokens,\s+([\d.]+)\s*tokens\/s/;
const GEN_RE = /eval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*tokens\s*\(.*?([\d.]+)\s*tokens\/s\)/;
// Fallback: some builds print "tokens/s" in the eval loop line
const GEN_LOOP_RE = /([\d.]+)\s*tokens\/s/;

// Temporarily disabled to reduce load on the llama-server. Set to true to re-enable.
const METRICS_PARSING_ENABLED = false;

/**
 * Extract prefill/generation speed from a raw output line.
 * Returns a new PerfMetrics when the line carried a number, else null.
 */
export function extractMetrics(line: string, current: PerfMetrics): PerfMetrics | null {
  if (!METRICS_PARSING_ENABLED) return null;

  // Parse prefill speed
  const prefillMatch = line.match(PREFILL_RE);
  if (prefillMatch) {
    return {
      ...current,
      prefillTokensPerSec: parseFloat(prefillMatch[3]),
      lastUpdated: Date.now(),
    };
  }

  // Parse generation speed from llama_print_timings
  const genMatch = line.match(GEN_RE);
  if (genMatch) {
    return {
      ...current,
      generationTokensPerSec: parseFloat(genMatch[2]),
      lastUpdated: Date.now(),
    };
  }

  // Fallback: any line with tokens/s that isn't prefill
  const fallback = line.match(GEN_LOOP_RE);
  if (fallback && !line.includes('prompt tokens')) {
    return {
      ...current,
      generationTokensPerSec: parseFloat(fallback[1]),
      lastUpdated: Date.now(),
    };
  }

  return null;
}

// --- Arg builder (llama-server / llama-cli flags) ---

/** The user's extra parameters as argv tokens: the structured list when the
 *  launch carries one (no quoting round-trip), else the legacy string split. */
export function extraTokens(spec: LlamaConfig): string[] {
  if (spec.extraArgv) return [...spec.extraArgv];
  return spec.extraArgs.trim() ? splitArgs(spec.extraArgs) : [];
}

/**
 * Build the CLI argument list for a llama.cpp launch. `spec` is the legacy
 * LlamaConfig shape: `llamaCppPath` carries the build folder, `extraArgs`
 * carries the instance's structured params rendered by `paramsToArgs`.
 *
 * `--host`/`--port`/`--api-key` are injected from the spec fields only when
 * `extraArgs` does not already name those flags — engine instances keep them
 * as ordinary params, so this avoids emitting a flag twice.
 *
 * When `spec.paramsOnly` is set (engine-instance launches), `extraArgs` *is*
 * the user's parameter list: nothing that the list does not name is added, so
 * the command line matches the Command tab exactly. Only the model selection
 * (`-m`/`--mmproj`) or the router preset comes from the spec itself. Legacy
 * settings.json launches leave the flag unset and keep the default injection.
 */
export function buildLlamaArgs(spec: LlamaConfig): string[] {
  const args: string[] = [];
  const extra = extraTokens(spec);
  const hasExtraFlag = (flag: string) => extra.includes(flag);
  const paramsOnly = spec.paramsOnly === true;

  // Router mode: launch with a preset INI containing multiple models.
  // Per-model flags come from the INI sections, so skip single-model args.
  if (spec.routerIniPath) {
    args.push('--models-preset', spec.routerIniPath);
    if (spec.binary === 'llama-server' && !paramsOnly) {
      if (!hasExtraFlag('--port')) args.push('--port', String(spec.port));
      if (!hasExtraFlag('--host')) args.push('--host', spec.host || '127.0.0.1');
      // Enable the Prometheus /metrics endpoint so the GUI can poll per-model speeds
      if (METRICS_PARSING_ENABLED) args.push('--metrics');
      if (spec.apiKey && !hasExtraFlag('--api-key')) args.push('--api-key', spec.apiKey);
    }
    args.push(...extra);
    return args;
  }

  if (spec.modelPath) {
    args.push('-m', spec.modelPath);
  }
  if (spec.mmproj && !hasExtraFlag('--mmproj')) {
    args.push('--mmproj', spec.mmproj);
  }

  if (!paramsOnly) {
    args.push('-c', String(spec.contextSize));
    args.push('-ngl', String(spec.gpuLayers));

    if (spec.threads > 0) args.push('-t', String(spec.threads));
    if (spec.mainThreads > 0) args.push('-ts', String(spec.mainThreads));
    args.push('-b', String(spec.batchSize));
    args.push('-ub', String(spec.ubatchSize));

    if (spec.binary === 'llama-server') {
      if (!hasExtraFlag('--port')) args.push('--port', String(spec.port));
      if (!hasExtraFlag('--host')) args.push('--host', spec.host || '127.0.0.1');
      if (spec.apiKey && !hasExtraFlag('--api-key')) args.push('--api-key', spec.apiKey);
    }
  }

  // Append extra args (split on whitespace, respecting quotes)
  args.push(...extra);

  return args;
}

// --- The driver ---

export const llamaDriver: EngineDriver = {
  kind: 'llamacpp',
  binaryName: (spec) => (spec.binary === 'llama-server' ? 'llama-server' : 'llama-cli'),
  buildArgs: buildLlamaArgs,
  getVersion: getLlamaVersion,
  listDevices: listLlamaDevices,
  toLogEntry,
  parseLogLine,
  extractMetrics,
};
