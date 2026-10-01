import { spawn, execFile, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { LlamaConfig, LlamaDevice, PerfMetrics, ProcessStatus } from './types.js';

// --- Version / build info from llama-server ---

export interface LlamaVersionInfo {
  version: string | null;      // release tag, e.g. "0.5.0-dev" (null for old builds)
  build: string | null;        // build number, e.g. "11242"
  commit: string | null;       // git hash if available
  compiler: string | null;     // e.g. "GNU 15.2.0 for Linux x86_64"
  backend: string | null;      // e.g. "CUDA"
  raw: string[];               // first lines of --version output
}

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

// Regex patterns for llama.cpp timing output
const PREFILL_RE = /llama_eval\s*:\s+([\d.]+)\s*ms,\s+(\d+)\s*prompt tokens,\s+([\d.]+)\s*tokens\/s/;
const GEN_RE = /eval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*tokens\s*\(.*?([\d.]+)\s*tokens\/s\)/;
// Fallback: some builds print "tokens/s" in the eval loop line
const GEN_LOOP_RE = /([\d.]+)\s*tokens\/s/;

// Temporarily disabled to reduce load on the llama-server. Set to true to re-enable.
const METRICS_PARSING_ENABLED = false;

export class LlamaProcessManager {
  private child: ChildProcess | null = null;
  private status: ProcessStatus = 'stopped';
  private metrics: PerfMetrics = {
    prefillTokensPerSec: null,
    generationTokensPerSec: null,
    lastUpdated: 0,
  };

  onLogLine: ((line: string) => void) | null = null;
  onStatusChange: ((status: ProcessStatus) => void) | null = null;
  onMetrics: ((metrics: PerfMetrics) => void) | null = null;

  getStatus(): ProcessStatus {
    return this.status;
  }

  getMetrics(): PerfMetrics {
    return { ...this.metrics };
  }

  private setStatus(status: ProcessStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }

  buildArgs(config: LlamaConfig): string[] {
    const args: string[] = [];

    // Router mode: launch with a preset INI containing multiple models.
    // Per-model flags come from the INI sections, so skip single-model args.
    if (config.routerIniPath) {
      args.push('--models-preset', config.routerIniPath);
      if (config.binary === 'llama-server') {
        args.push('--port', String(config.port));
        args.push('--host', config.host || '127.0.0.1');
        // Enable the Prometheus /metrics endpoint so the GUI can poll per-model speeds
        if (METRICS_PARSING_ENABLED) args.push('--metrics');
        if (config.apiKey) args.push('--api-key', `"${config.apiKey}"`);
      }
      return args;
    }

    if (config.modelPath) {
      args.push('-m', config.modelPath);
    }
    if (config.mmproj) {
      args.push('--mmproj', config.mmproj);
    }
    args.push('-c', String(config.contextSize));
    args.push('-ngl', String(config.gpuLayers));

    if (config.threads > 0) args.push('-t', String(config.threads));
    if (config.mainThreads > 0) args.push('-ts', String(config.mainThreads));
    args.push('-b', String(config.batchSize));
    args.push('-ub', String(config.ubatchSize));

    if (config.binary === 'llama-server') {
      args.push('--port', String(config.port));
      args.push('--host', config.host || '127.0.0.1');
      if (config.apiKey) args.push('--api-key', `"${config.apiKey}"`);
    }

    // Append extra args (split on whitespace, respecting quotes)
    if (config.extraArgs.trim()) {
      args.push(...splitArgs(config.extraArgs));
    }

    return args;
  }

  launch(config: LlamaConfig): void {
    if (this.child) {
      this.stop();
    }

    const binaryName = config.binary === 'llama-server' ? 'llama-server' : 'llama-cli';
    const binaryPath = path.join(config.llamaCppPath, binaryName);

    if (!fs.existsSync(binaryPath)) {
      this.setStatus('error');
      this.onLogLine?.(`[ERROR] Binary not found: ${binaryPath}`);
      return;
    }

    const args = this.buildArgs(config);
    this.metrics = { prefillTokensPerSec: null, generationTokensPerSec: null, lastUpdated: 0 };

    this.setStatus('starting');
    this.onLogLine?.(`[LAUNCH] ${binaryPath} ${args.join(' ')}`);

    // Merge user-defined environment variables (e.g. CUDA_VISIBLE_DEVICES, LD_LIBRARY_PATH)
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [k, v] of Object.entries(config.envVars || {})) {
      if (v !== '') env[k] = v;
    }

    const child = spawn(binaryPath, args, {
      cwd: config.llamaCppPath,
      env,
    });

    this.child = child;

    let buffer = '';

    child.stdout?.on('data', (chunk: Uint8Array) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.handleLine(line);
      }
    });

    child.stderr?.on('data', (chunk: Uint8Array) => {
      const text = chunk.toString();
      // llama.cpp writes most output to stderr
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.handleLine(line);
      }
    });

    child.on('error', (err: Error) => {
      this.setStatus('error');
      this.onLogLine?.(`[ERROR] ${err.message}`);
    });

    child.on('close', (code: number) => {
      this.child = null;
      this.setStatus(code === 0 ? 'exited' : 'error');
      this.onLogLine?.(`[EXIT] Process exited with code ${code}`);
    });
  }

  private handleLine(line: string): void {
    this.onLogLine?.(line);

    if (!METRICS_PARSING_ENABLED) return;

    // Parse prefill speed
    const prefillMatch = line.match(PREFILL_RE);
    if (prefillMatch) {
      this.metrics.prefillTokensPerSec = parseFloat(prefillMatch[3]);
      this.metrics.lastUpdated = Date.now();
      this.onMetrics?.(this.getMetrics());
      return;
    }

    // Parse generation speed from llama_print_timings
    const genMatch = line.match(GEN_RE);
    if (genMatch) {
      this.metrics.generationTokensPerSec = parseFloat(genMatch[2]);
      this.metrics.lastUpdated = Date.now();
      this.onMetrics?.(this.getMetrics());
      return;
    }

    // Fallback: any line with tokens/s that isn't prefill
    const fallback = line.match(GEN_LOOP_RE);
    if (fallback && !line.includes('prompt tokens')) {
      this.metrics.generationTokensPerSec = parseFloat(fallback[1]);
      this.metrics.lastUpdated = Date.now();
      this.onMetrics?.(this.getMetrics());
    }
  }

  stop(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      // Force kill after 3s if still alive
      setTimeout(() => {
        if (this.child) this.child.kill('SIGKILL');
      }, 3000);
      this.child = null;
    }
    this.setStatus('stopped');
  }
}

function splitArgs(str: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
