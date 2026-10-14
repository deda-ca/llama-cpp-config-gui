/**
 * Per-request usage recording (docs/proxy-server.md §5).
 * Tracks timing and extracts token usage from JSON or SSE responses.
 * Recording must never break the passthrough response.
 */

import { randomUUID } from 'crypto';
import { Transform, type TransformCallback } from 'stream';
import type { UsageRecord } from './types.js';
import type { UsageDb } from './usageDb.js';

/** Extract `usage` from a full non-streaming OpenAI-style JSON body. */
export function extractJsonUsage(body: unknown): { input: number | null; output: number | null } {
  const u = (body as any)?.usage;
  return {
    input: Number.isFinite(u?.prompt_tokens) ? u.prompt_tokens : null,
    output: Number.isFinite(u?.completion_tokens) ? u.completion_tokens : null,
  };
}

/**
 * Incremental SSE scanner: feeds chunks through, looks for `data: {...}` lines
 * carrying a `usage` object (emitted by llama.cpp when
 * stream_options.include_usage is set). Buffer-safe across chunk boundaries.
 */
export class SseUsageScanner extends Transform {
  usage: { input: number | null; output: number | null } = { input: null, output: null };
  firstContentAt: number | null = null;
  private buf = '';

  constructor() {
    super();
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    const text = chunk.toString('utf8');
    if (this.firstContentAt === null && text.length > 0) this.firstContentAt = Date.now();
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const u = obj?.usage;
        if (u) {
          if (Number.isFinite(u.prompt_tokens)) this.usage.input = u.prompt_tokens;
          if (Number.isFinite(u.completion_tokens)) this.usage.output = u.completion_tokens;
        }
      } catch {
        // partial/invalid line: ignore, more chunks will follow
      }
    }
    this.push(chunk);
    cb();
  }

  _flush(cb: TransformCallback): void {
    // Parse any trailing line without a final newline
    const line = this.buf.trim();
    if (line.startsWith('data:')) {
      try {
        const obj = JSON.parse(line.slice(5).trim());
        const u = obj?.usage;
        if (u) {
          if (Number.isFinite(u.prompt_tokens)) this.usage.input = u.prompt_tokens;
          if (Number.isFinite(u.completion_tokens)) this.usage.output = u.completion_tokens;
        }
      } catch { /* ignore */ }
    }
    this.buf = '';
    cb();
  }
}

export interface RecorderContext {
  model: string;
  backend: string;
  endpoint: string;
  stream: boolean;
  clientIp: string;
  meta?: Record<string, unknown> | null;
  /** Fallback estimates when upstream omits usage. */
  estimatedInput?: number;
}

export class RequestRecorder {
  readonly requestId = randomUUID();
  readonly t0 = Date.now();
  ttfbMs: number | null = null;
  private usage: { input: number | null; output: number | null } = { input: null, output: null };
  private firstContentAt: number | null = null;

  constructor(private ctx: RecorderContext) {}

  markTtfb(): void {
    if (this.ttfbMs === null) this.ttfbMs = Date.now() - this.t0;
  }

  setUsage(input: number | null, output: number | null): void {
    if (input !== null) this.usage.input = input;
    if (output !== null) this.usage.output = output;
  }

  adoptScanner(scanner: SseUsageScanner): void {
    this.usage = scanner.usage;
    if (scanner.firstContentAt !== null) this.firstContentAt = scanner.firstContentAt;
  }

  build(status: number, errorMessage: string | null = null): UsageRecord {
    const tEnd = Date.now();
    let input = this.usage.input;
    let output = this.usage.output;
    let estimated = false;
    if (input === null && this.ctx.estimatedInput !== undefined) {
      input = this.ctx.estimatedInput;
      estimated = true;
    }
    const denomStart = this.ctx.stream ? this.firstContentAt : this.ttfbMs !== null ? this.t0 + this.ttfbMs : null;
    let tokensPerSec: number | null = null;
    if (output !== null && denomStart !== null) {
      const genMs = tEnd - denomStart;
      if (genMs > 0) tokensPerSec = (output / genMs) * 1000;
    }
    return {
      requestId: this.requestId,
      timestamp: new Date(this.t0).toISOString(),
      model: this.ctx.model,
      backend: this.ctx.backend,
      endpoint: this.ctx.endpoint,
      stream: this.ctx.stream,
      status,
      inputTokens: input,
      outputTokens: output,
      tokensEstimated: estimated,
      totalDurationMs: tEnd - this.t0,
      ttfbMs: this.ttfbMs,
      tokensPerSec,
      clientIp: this.ctx.clientIp,
      errorMessage,
      meta: this.ctx.meta ?? null,
    };
  }
}

/**
 * Persist a record; swallow/log errors so recording never breaks the response.
 * Returns the record for SSE fan-out regardless of persistence outcome.
 */
export function persistRecord(db: UsageDb, rec: UsageRecord, onError?: (e: unknown) => void): UsageRecord {
  try {
    db.insert(rec);
  } catch (e) {
    onError?.(e);
  }
  return rec;
}
