/**
 * Generic process worker (docs/llm-engines.md §2.1–2.2).
 *
 * Owns exactly one child process: spawn, line-buffered stdout/stderr, status
 * transitions, SIGTERM/SIGKILL stop. Everything engine-specific — binary name,
 * argument list, log classification, metrics extraction — is delegated to the
 * `EngineDriver` injected at construction. This is the neutralized
 * `LlamaProcessManager` from Phase 1/2: behavior is unchanged, the llama.cpp
 * knowledge simply moved into `engines/llama.ts`.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { LlamaConfig, PerfMetrics, ProcessStatus } from '../types.js';
import type { EngineDriver } from './driver.js';

const EMPTY_METRICS: PerfMetrics = {
  prefillTokensPerSec: null,
  generationTokensPerSec: null,
  lastUpdated: 0,
};

export class ProcessWorker {
  private child: ChildProcess | null = null;
  private status: ProcessStatus = 'stopped';
  private metrics: PerfMetrics = { ...EMPTY_METRICS };
  private driver: EngineDriver;

  onLogLine: ((line: string) => void) | null = null;
  onStatusChange: ((status: ProcessStatus) => void) | null = null;
  onMetrics: ((metrics: PerfMetrics) => void) | null = null;

  constructor(driver: EngineDriver) {
    this.driver = driver;
  }

  getDriver(): EngineDriver {
    return this.driver;
  }

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

  buildArgs(spec: LlamaConfig): string[] {
    return this.driver.buildArgs(spec);
  }

  launch(spec: LlamaConfig): void {
    if (this.child) {
      this.stop();
    }

    // A driver with a custom launch plan (strata: a Python module run from the
    // repo root) supplies command/args/cwd directly; the default is the
    // llama.cpp layout of <buildPath>/<binary> with cwd = buildPath.
    const custom = this.driver.buildLaunch?.(spec);
    const binaryPath = custom
      ? custom.command
      : path.join(spec.llamaCppPath, this.driver.binaryName(spec));

    // PATH-resolved commands (python, node) are not checked for existence —
    // spawn reports a clear ENOENT for those.
    if (!custom && !fs.existsSync(binaryPath)) {
      this.setStatus('error');
      this.onLogLine?.(`[ERROR] Binary not found: ${binaryPath}`);
      return;
    }

    const args = custom ? custom.args : this.driver.buildArgs(spec);
    const cwd = custom ? custom.cwd : spec.llamaCppPath;
    this.metrics = { ...EMPTY_METRICS };

    this.setStatus('starting');
    this.onLogLine?.(`[LAUNCH] ${binaryPath} ${args.join(' ')}`);

    // Merge user-defined environment variables (e.g. CUDA_VISIBLE_DEVICES, LD_LIBRARY_PATH)
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [k, v] of Object.entries(spec.envVars || {})) {
      if (v !== '') env[k] = v;
    }

    const child = spawn(binaryPath, args, {
      cwd,
      env,
    });

    this.child = child;

    let buffer = '';

    const emit = (line: string) => {
      if (line.trim()) this.handleLine(line);
    };

    child.stdout?.on('data', (chunk: Uint8Array) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) emit(line);
    });

    child.stderr?.on('data', (chunk: Uint8Array) => {
      const text = chunk.toString();
      // llama.cpp writes most output to stderr
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) emit(line);
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

    const extract = this.driver.extractMetrics;
    if (!extract) return;

    const updated = extract(line, this.metrics);
    if (updated) {
      this.metrics = updated;
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
