/**
 * Per-request usage recording (docs/proxy-server.md §5).
 * Tracks timing and extracts token usage from JSON or SSE responses.
 * Recording must never break the passthrough response.
 */

import { randomUUID } from 'crypto';
import { Transform, type TransformCallback } from 'stream';
import type { UsageRecord } from './types.js';
import type { UsageDb } from './usageDb.js';

export interface ExtractedUsage {
  input: number | null;
  output: number | null;
  /** KV-cache hits within prompt_tokens (usage.prompt_tokens_details.cached_tokens). */
  cached: number | null;
}

/** Extract `usage` from a full non-streaming OpenAI-style JSON body. */
export function extractJsonUsage(body: unknown): ExtractedUsage {
  const u = (body as any)?.usage;
  const cached = u?.prompt_tokens_details?.cached_tokens;
  return {
    input: Number.isFinite(u?.prompt_tokens) ? u.prompt_tokens : null,
    output: Number.isFinite(u?.completion_tokens) ? u.completion_tokens : null,
    cached: Number.isFinite(cached) ? cached : null,
  };
}

/**
 * Incremental SSE scanner: feeds chunks through, looks for `data: {...}` lines
 * carrying a `usage` object (emitted by llama.cpp when
 * stream_options.include_usage is set). Buffer-safe across chunk boundaries.
 */
export class SseUsageScanner extends Transform {
  usage: ExtractedUsage = { input: null, output: null, cached: null };
  firstContentAt: number | null = null;
  private buf = '';

  constructor() {
    super();
  }

  private applyUsage(u: any): void {
    if (!u) return;
    if (Number.isFinite(u.prompt_tokens)) this.usage.input = u.prompt_tokens;
    if (Number.isFinite(u.completion_tokens)) this.usage.output = u.completion_tokens;
    const cached = u.prompt_tokens_details?.cached_tokens;
    if (Number.isFinite(cached)) this.usage.cached = cached;
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
        this.applyUsage(JSON.parse(payload)?.usage);
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
        this.applyUsage(JSON.parse(line.slice(5).trim())?.usage);
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
  private usage: ExtractedUsage = { input: null, output: null, cached: null };
  private firstContentAt: number | null = null;

  constructor(private ctx: RecorderContext) {}

  markTtfb(): void {
    if (this.ttfbMs === null) this.ttfbMs = Date.now() - this.t0;
  }

  setUsage(input: number | null, output: number | null, cached: number | null = null): void {
    if (input !== null) this.usage.input = input;
    if (output !== null) this.usage.output = output;
    if (cached !== null) this.usage.cached = cached;
  }

  adoptScanner(scanner: SseUsageScanner): void {
    this.usage = scanner.usage;
    if (scanner.firstContentAt !== null) this.firstContentAt = scanner.firstContentAt;
  }

  /**
   * Add fields discovered after the request started — an sd.cpp job reports
   * what it actually ran (seed, effective steps/size, queue/render split) only
   * once it completes (§4.3.2).
   */
  mergeMeta(fields: Record<string, unknown>): void {
    this.ctx.meta = { ...(this.ctx.meta ?? {}), ...fields };
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
      cachedTokens: this.usage.cached,
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
