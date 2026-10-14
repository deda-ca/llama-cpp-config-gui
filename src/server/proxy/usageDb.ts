/**
 * SQLite-backed usage store for the proxy (docs/proxy-server.md §6).
 * Uses node:sqlite (built into Node >= 22) so no new runtime dependency.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import type { UsageQuery, UsageRecord, UsageSummaryRow } from './types.js';

const SCHEMA_VERSION = 2;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  backend TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL,
  ttfb_ms INTEGER,
  tokens_per_sec REAL,
  client_ip TEXT,
  error TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model, ts);
`;

export class UsageDb {
  private db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version < SCHEMA_VERSION) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(CREATE_SQL);
        // v1 databases lack cached_tokens; CREATE above is IF NOT EXISTS so add it here.
        const cols = this.db.prepare("PRAGMA table_info(usage)").all() as { name: string }[];
        if (!cols.some((c) => c.name === 'cached_tokens')) {
          this.db.exec('ALTER TABLE usage ADD COLUMN cached_tokens INTEGER');
        }
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // WAL unsupported on some filesystems; default journal is fine
    }
  }

  insert(rec: UsageRecord): void {
    this.db.prepare(`
      INSERT INTO usage (request_id, ts, model, backend, endpoint, stream, status,
        input_tokens, output_tokens, cached_tokens, tokens_estimated, total_ms, ttfb_ms,
        tokens_per_sec, client_ip, error, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.requestId, rec.timestamp, rec.model, rec.backend, rec.endpoint,
      rec.stream ? 1 : 0, rec.status,
      rec.inputTokens, rec.outputTokens, rec.cachedTokens, rec.tokensEstimated ? 1 : 0,
      rec.totalDurationMs, rec.ttfbMs, rec.tokensPerSec,
      rec.clientIp, rec.errorMessage, rec.meta ? JSON.stringify(rec.meta) : null,
    );
  }

  query(q: UsageQuery): UsageRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.model) { where.push('model = ?'); params.push(q.model); }
    if (q.backend) { where.push('backend = ?'); params.push(q.backend); }
    if (q.from) { where.push('ts >= ?'); params.push(q.from); }
    if (q.to) { where.push('ts <= ?'); params.push(q.to + '\uffff'); }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);

    const rows = this.db.prepare(`
      SELECT * FROM usage
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as unknown as DbRow[];
    return rows.map(rowToRecord);
  }

  summary(q: Pick<UsageQuery, 'from' | 'to'> = {}): UsageSummaryRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.from) { where.push('ts >= ?'); params.push(q.from); }
    if (q.to) { where.push('ts <= ?'); params.push(q.to + '\uffff'); }

    const rows = this.db.prepare(`
      SELECT model, backend,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        AVG(tokens_per_sec) AS avg_tps,
        AVG(ttfb_ms) AS avg_ttfb,
        MAX(ts) AS last_used
      FROM usage
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY model, backend
      ORDER BY requests DESC
    `).all(...params) as unknown as SummaryRow[];

    return rows.map((r) => ({
      model: r.model,
      backend: r.backend as UsageSummaryRow['backend'],
      requests: Number(r.requests),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cachedTokens: Number(r.cached_tokens),
      avgTokensPerSec: r.avg_tps === null ? null : Number(r.avg_tps),
      avgTtfbMs: r.avg_ttfb === null ? null : Number(r.avg_ttfb),
      lastUsed: r.last_used,
    }));
  }

  /** Delete rows older than `days`. Returns number of rows removed. */
  purge(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const res = this.db.prepare('DELETE FROM usage WHERE ts < ?').run(cutoff);
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }
}

interface DbRow {
  id: number; request_id: string; ts: string; model: string; backend: string;
  endpoint: string; stream: number; status: number;
  input_tokens: number | null; output_tokens: number | null;
  cached_tokens: number | null;
  tokens_estimated: number; total_ms: number; ttfb_ms: number | null;
  tokens_per_sec: number | null; client_ip: string | null; error: string | null;
  meta: string | null;
}

function rowToRecord(r: DbRow): UsageRecord {
  let meta: Record<string, unknown> | null = null;
  if (r.meta) {
    try { meta = JSON.parse(r.meta); } catch { /* keep null */ }
  }
  return {
    id: Number(r.id),
    requestId: r.request_id,
    timestamp: r.ts,
    model: r.model,
    backend: r.backend as UsageRecord['backend'],
    endpoint: r.endpoint,
    stream: r.stream === 1,
    status: Number(r.status),
    inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
    cachedTokens: r.cached_tokens === null || r.cached_tokens === undefined ? null : Number(r.cached_tokens),
    tokensEstimated: r.tokens_estimated === 1,
    totalDurationMs: Number(r.total_ms),
    ttfbMs: r.ttfb_ms === null ? null : Number(r.ttfb_ms),
    tokensPerSec: r.tokens_per_sec === null ? null : Number(r.tokens_per_sec),
    clientIp: r.client_ip ?? '',
    errorMessage: r.error,
    meta,
  };
}

interface SummaryRow {
  model: string; backend: string; requests: number | string;
  input_tokens: number | string; output_tokens: number | string;
  cached_tokens: number | string;
  avg_tps: number | null; avg_ttfb: number | null; last_used: string | null;
}
