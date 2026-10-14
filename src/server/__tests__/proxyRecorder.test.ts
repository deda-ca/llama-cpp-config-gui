import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { SseUsageScanner, extractJsonUsage, RequestRecorder } from '../proxy/recorder.js';
import { estimateMessagesTokens, estimateTokens } from '../proxy/tokenCount.js';

/** Realistic llama.cpp SSE stream with a trailing usage chunk (include_usage). */
const SSE_STREAM = [
  'data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"content":"lo"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":2,"total_tokens":125}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

async function runScanner(chunks: string[]): Promise<SseUsageScanner> {
  const scanner = new SseUsageScanner();
  const out: Buffer[] = [];
  scanner.on('data', (c: Buffer) => out.push(c));
  const done = new Promise<void>((resolve) => scanner.on('end', () => resolve()));
  for (const c of chunks) scanner.write(Buffer.from(c, 'utf8'));
  scanner.end();
  await done;
  expect(Buffer.concat(out).toString('utf8')).toBe(chunks.join('')); // passthrough byte-identical
  return scanner;
}

describe('SseUsageScanner', () => {
  it('extracts usage from a whole-stream write', async () => {
    const s = await runScanner([SSE_STREAM]);
    expect(s.usage).toEqual({ input: 123, output: 2 });
    expect(s.firstContentAt).not.toBeNull();
  });

  it('extracts usage when chunks split mid-line', async () => {
    const mid = SSE_STREAM.indexOf('"prompt_tokens"');
    const s = await runScanner([SSE_STREAM.slice(0, mid), SSE_STREAM.slice(mid)]);
    expect(s.usage).toEqual({ input: 123, output: 2 });
  });

  it('extracts usage when split byte-by-byte', async () => {
    const s = await runScanner([...SSE_STREAM].map((ch) => ch));
    expect(s.usage).toEqual({ input: 123, output: 2 });
  });

  it('handles streams with no usage chunk', async () => {
    const noUsage = SSE_STREAM.replace(/data: \{"choices":\[\],"usage".*\n/, '');
    const scanner = new SseUsageScanner();
    scanner.resume();
    const done = new Promise<void>((r) => scanner.on('end', () => r()));
    scanner.write(Buffer.from(noUsage));
    scanner.end();
    await done;
    expect(scanner.usage).toEqual({ input: null, output: null });
  });

  it('handles usage on a final line without trailing newline', async () => {
    const s = await runScanner([SSE_STREAM.replace(/\n$/, '')]);
    expect(s.usage).toEqual({ input: 123, output: 2 });
  });
});

describe('extractJsonUsage', () => {
  it('extracts prompt/completion tokens', () => {
    expect(extractJsonUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }))
      .toEqual({ input: 10, output: 5 });
  });
  it('returns nulls when usage missing', () => {
    expect(extractJsonUsage({ choices: [] })).toEqual({ input: null, output: null });
  });
});

describe('RequestRecorder', () => {
  const ctx = { model: 'm', backend: 'llamacpp' as const, endpoint: '/v1/chat/completions', stream: false, clientIp: '::1' };

  it('builds a record with usage and computed tokensPerSec', () => {
    const rec = new RequestRecorder(ctx);
    rec.markTtfb();
    rec.setUsage(100, 50);
    const r = rec.build(200);
    expect(r.status).toBe(200);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(50);
    expect(r.tokensEstimated).toBe(false);
    expect(r.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(r.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('falls back to estimated input tokens and flags them', () => {
    const rec = new RequestRecorder({ ...ctx, estimatedInput: 42 });
    const r = rec.build(502, 'upstream error');
    expect(r.inputTokens).toBe(42);
    expect(r.tokensEstimated).toBe(true);
    expect(r.errorMessage).toBe('upstream error');
    expect(r.outputTokens).toBeNull();
    expect(r.tokensPerSec).toBeNull();
  });
});

describe('token estimation', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('estimates across chat messages with per-message overhead', () => {
    const t = estimateMessagesTokens([
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(40) }] },
    ]);
    expect(t).toBe(10 + 4 + 10 + 4);
  });
});
