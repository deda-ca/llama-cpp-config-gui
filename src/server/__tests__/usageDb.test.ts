import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UsageDb } from '../proxy/usageDb.js';
import type { UsageRecord } from '../proxy/types.js';

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: 'req-1',
    timestamp: new Date().toISOString(),
    model: 'qwen2.5-14b',
    backend: 'llamacpp',
    endpoint: '/v1/chat/completions',
    stream: false,
    status: 200,
    inputTokens: 100,
    outputTokens: 42,
    cachedTokens: null,
    tokensEstimated: false,
    totalDurationMs: 1500,
    ttfbMs: 200,
    tokensPerSec: 28.0,
    clientIp: '127.0.0.1',
    errorMessage: null,
    meta: null,
    ...overrides,
  };
}

describe('UsageDb', () => {
  let dir: string;
  let db: UsageDb;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-db-test-'));
    db = new UsageDb(path.join(dir, 'usage.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates schema and is idempotent across reopen', () => {
    db.insert(makeRecord());
    db.close();
    db = new UsageDb(path.join(dir, 'usage.db'));
    const rows = db.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('qwen2.5-14b');
  });

  it('insert/query round-trip preserves all fields', () => {
    const rec = makeRecord({
      stream: true,
      meta: { steps: 20, width: 1024 },
      tokensEstimated: true,
      inputTokens: null,
      outputTokens: null,
      ttfbMs: null,
      tokensPerSec: null,
      errorMessage: 'upstream 502',
    });
    db.insert(rec);
    const [row] = db.query({});
    expect(row.id).toBeGreaterThan(0);
    expect(row.stream).toBe(true);
    expect(row.meta).toEqual({ steps: 20, width: 1024 });
    expect(row.tokensEstimated).toBe(true);
    expect(row.inputTokens).toBeNull();
    expect(row.ttfbMs).toBeNull();
    expect(row.errorMessage).toBe('upstream 502');
  });

  it('filters by model, backend, and time range', () => {
    db.insert(makeRecord({ model: 'a', timestamp: '2026-01-01T00:00:00Z' }));
    db.insert(makeRecord({ model: 'b', backend: 'sdiffusion', timestamp: '2026-06-01T00:00:00Z' }));
    db.insert(makeRecord({ model: 'a', timestamp: '2026-07-01T00:00:00Z' }));

    expect(db.query({ model: 'a' })).toHaveLength(2);
    expect(db.query({ backend: 'sdiffusion' })).toHaveLength(1);
    expect(db.query({ from: '2026-06-01', to: '2026-06-30' })).toHaveLength(1);
    expect(db.query({ model: 'a', from: '2026-06-01' })).toHaveLength(1);
  });

  it('paginates newest-first', () => {
    for (let i = 0; i < 5; i++) db.insert(makeRecord({ requestId: `r${i}` }));
    const page = db.query({ limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
    expect(page[0].requestId).toBe('r3');
    expect(page[1].requestId).toBe('r2');
  });

  it('summary aggregates per model', () => {
    db.insert(makeRecord({ inputTokens: 100, outputTokens: 10, cachedTokens: 80, tokensPerSec: 20, ttfbMs: 100 }));
    db.insert(makeRecord({ inputTokens: 50, outputTokens: 30, cachedTokens: 10, tokensPerSec: 40, ttfbMs: 300 }));
    db.insert(makeRecord({ model: 'sd-xl', backend: 'sdiffusion', inputTokens: null, outputTokens: null, tokensPerSec: null, ttfbMs: null }));

    const rows = db.summary();
    expect(rows).toHaveLength(2);
    const qwen = rows.find((r) => r.model === 'qwen2.5-14b')!;
    expect(qwen.requests).toBe(2);
    expect(qwen.inputTokens).toBe(150);
    expect(qwen.outputTokens).toBe(40);
    expect(qwen.cachedTokens).toBe(90);
    expect(qwen.avgTokensPerSec).toBeCloseTo(30);
    expect(qwen.avgTtfbMs).toBeCloseTo(200);
    const sd = rows.find((r) => r.model === 'sd-xl')!;
    expect(sd.inputTokens).toBe(0);
    expect(sd.avgTokensPerSec).toBeNull();
  });

  it('purge deletes rows older than the retention window', () => {
    const old = new Date(Date.now() - 100 * 86400_000).toISOString();
    db.insert(makeRecord({ requestId: 'old', timestamp: old }));
    db.insert(makeRecord({ requestId: 'fresh' }));
    const removed = db.purge(90);
    expect(removed).toBe(1);
    const rows = db.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe('fresh');
  });

  it('migrates a v1 database by adding cached_tokens', () => {
    const file = path.join(dir, 'v1.db');
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL, ts TEXT NOT NULL, model TEXT NOT NULL,
        backend TEXT NOT NULL, endpoint TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER,
        tokens_estimated INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL, ttfb_ms INTEGER,
        tokens_per_sec REAL, client_ip TEXT, error TEXT, meta TEXT
      );
      INSERT INTO usage (request_id, ts, model, backend, endpoint, status, total_ms)
      VALUES ('legacy', '2026-01-01T00:00:00Z', 'm', 'llamacpp', '/v1/chat/completions', 200, 10);
      PRAGMA user_version = 1;
    `);
    raw.close();

    const migrated = new UsageDb(file);
    const rows = migrated.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0].cachedTokens).toBeNull();
    migrated.insert(makeRecord({ requestId: 'new', cachedTokens: 42 }));
    expect(migrated.query({}).find((r) => r.requestId === 'new')!.cachedTokens).toBe(42);
    migrated.close();
  });
});
