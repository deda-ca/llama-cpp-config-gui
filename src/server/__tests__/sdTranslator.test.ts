/**
 * Phase 4: the OpenAI -> sd.cpp native image translator
 * (docs/proxy-server.md §4.3.2).
 *
 * Two layers, per the spec's testing strategy:
 *  - `translateSdImageRequest` unit tests (mapping + deliberate rejections);
 *  - integration through `createProxyApp` against a stub `sd-server` that
 *    replays the Phase 0 fixtures in `fixtures/proxy/sd/` byte-for-byte.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { createProxyApp } from '../proxy/index.js';
import { ModelRouter } from '../proxy/router.js';
import { UsageDb } from '../proxy/usageDb.js';
import { translateSdImageRequest } from '../proxy/sdTranslator.js';
import { DEFAULT_PROXY_SETTINGS, type ProxySettings } from '../proxy/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'proxy');
const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf-8'));

const SUBMITTED = readJson('sd/img_gen-job-submitted.json');
const COMPLETED = readJson('sd/img_gen-job-completed.json');

// --- translateSdImageRequest (§4.3.2 mapping table) ---

describe('translateSdImageRequest: mapping', () => {
  it('maps the OpenAI fields onto the native img_gen schema', () => {
    const r = translateSdImageRequest({
      model: 'sd-xl', // selects the route only — never forwarded
      prompt: 'a blue sphere',
      n: 2,
      size: '512x768',
      output_format: 'webp',
      output_compression: 90,
      seed: 1234,
      steps: 4,
      sampler: 'euler',
      scheduler: 'simple',
      guidance: 3.5,
      negative_prompt: 'blurry',
      user: 'alice', // never parsed upstream — ignored
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request).toEqual({
      prompt: 'a blue sphere',
      batch_count: 2,
      width: 512,
      height: 768,
      output_format: 'webp',
      output_compression: 90,
      seed: 1234,
      negative_prompt: 'blurry',
      sample_params: {
        sample_steps: 4,
        sample_method: 'euler',
        scheduler: 'simple',
        guidance: { txt_cfg: 3.5 },
      },
    });
  });

  it('writes only what the client sent — server defaults stay untouched', () => {
    const r = translateSdImageRequest({ model: 'sd-xl', prompt: 'hi' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request).toEqual({ prompt: 'hi' });
  });

  it('keeps seed top-level, never inside sample_params', () => {
    // The fixture proof: seed inside sample_params is silently dropped upstream
    // (fixtures/proxy/sd/openai-generations.extra-args.json).
    const r = translateSdImageRequest({ prompt: 'hi', seed: 777, steps: 3 });
    if (!r.ok) throw new Error('should translate');
    expect(r.request.seed).toBe(777);
    expect((r.request.sample_params as Record<string, unknown>).seed).toBeUndefined();
  });

  it('accepts bare width/height when size is absent, size wins otherwise', () => {
    const bare = translateSdImageRequest({ prompt: 'hi', width: 256, height: 128 });
    if (!bare.ok) throw new Error('should translate');
    expect(bare.request).toMatchObject({ width: 256, height: 128 });
    const both = translateSdImageRequest({ prompt: 'hi', size: '64x64', width: 256 });
    if (!both.ok) throw new Error('should translate');
    expect(both.request).toMatchObject({ width: 64, height: 64 });
    expect(both.request.width).toBe(64);
  });
});

describe('translateSdImageRequest: deliberate rejections (§4.3.2)', () => {
  const bad = (body: Record<string, unknown>) => {
    const r = translateSdImageRequest(body);
    if (r.ok) throw new Error('expected rejection');
    return r.error;
  };

  it('rejects a missing or empty prompt', () => {
    expect(bad({}).code).toBe('missing_prompt');
    expect(bad({ prompt: '' }).code).toBe('missing_prompt');
    expect(bad({ prompt: 42 }).code).toBe('missing_prompt');
  });

  it('rejects quality and style instead of silently dropping them', () => {
    for (const field of ['quality', 'style'] as const) {
      const e = bad({ prompt: 'hi', [field]: 'hd' });
      expect(e.code).toBe('unsupported_parameter');
      expect(e.message).toContain(field);
    }
  });

  it('rejects response_format "url" (sd.cpp hosts no images) but accepts b64_json', () => {
    expect(bad({ prompt: 'hi', response_format: 'url' }).code).toBe('unsupported_parameter');
    const ok = translateSdImageRequest({ prompt: 'hi', response_format: 'b64_json' });
    expect(ok.ok).toBe(true);
  });

  it('rejects malformed size and out-of-range n / dimensions', () => {
    expect(bad({ prompt: 'hi', size: 'big' }).code).toBe('invalid_parameter');
    expect(bad({ prompt: 'hi', size: '64' }).code).toBe('invalid_parameter');
    expect(bad({ prompt: 'hi', n: 0 }).code).toBe('invalid_parameter');
    expect(bad({ prompt: 'hi', n: 9 }).code).toBe('invalid_parameter'); // max_batch_count 8
    expect(bad({ prompt: 'hi', width: 32 }).code).toBe('invalid_parameter'); // min_width 64
    expect(bad({ prompt: 'hi', size: '8192x64' }).code).toBe('invalid_parameter'); // max_width 4096
  });
});

// --- Stub sd-server replaying the Phase 0 fixtures ---

let sdStub: http.Server;
let sdUrl = '';
/** Requests the stub saw, in order: {url, method, body}. */
let sdRequests: Array<{ url: string; method: string; body: unknown }>;
/** How many polls answer `queued` before the completed fixture is replayed. */
let queuedPolls = 0;
/** When set, the stub never answers the job poll (drives the timeout path). */
let stallPolls = false;
/** When set, img_gen answers 400 like the real validation does. */
let rejectNext = false;
/** When set, img_gen answers 429 (queue full). */
let queueFull = false;
/** Cancel calls the stub received. */
let cancelCalls = 0;

beforeAll(async () => {
  sdStub = http.createServer((req, res) => {
    const url = req.url ?? '';
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      sdRequests.push({ url, method: req.method ?? '', body: raw ? JSON.parse(raw) : null });

      if (url === '/sdcpp/v1/img_gen') {
        if (rejectNext) {
          rejectNext = false;
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid generation parameters' }));
          return;
        }
        if (queueFull) {
          queueFull = false;
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'job queue is full' }));
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(SUBMITTED));
        return;
      }
      const cancelMatch = url.match(/^\/sdcpp\/v1\/jobs\/([A-Za-z0-9_-]+)\/cancel$/);
      if (cancelMatch) {
        cancelCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: cancelMatch[1], status: 'cancelled' }));
        return;
      }
      const jobMatch = url.match(/^\/sdcpp\/v1\/jobs\/([A-Za-z0-9_-]+)$/);
      if (jobMatch) {
        if (stallPolls) return; // deliberately never respond
        if (queuedPolls > 0) {
          queuedPolls--;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...SUBMITTED, status: 'running' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(COMPLETED));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'job not found' }));
    });
  });
  await new Promise<void>((r) => sdStub.listen(0, '127.0.0.1', r));
  sdUrl = `http://127.0.0.1:${(sdStub.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => sdStub.close(() => r())));

let tmpDir: string;
let db: UsageDb;
let settings: ProxySettings;
let app: ReturnType<typeof createProxyApp>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-sd-test-'));
  db = new UsageDb(path.join(tmpDir, 'usage.db'));
  settings = {
    ...DEFAULT_PROXY_SETTINGS,
    backends: [
      { id: 'sdiffusion', name: 'stable-diffusion.cpp', kind: 'sdiffusion', baseUrl: sdUrl, enabled: true },
      { id: 'custom-img', name: 'OpenAI images', kind: 'custom', baseUrl: sdUrl, enabled: true },
    ],
    models: [
      { model: 'qwen-image', backend: 'sdiffusion', enabled: true },
      { model: 'dalle-clone', backend: 'custom-img', enabled: true },
    ],
  };
  const router = new ModelRouter();
  router.rebuild(settings, []);
  app = createProxyApp({ getSettings: () => settings, router, db });
  sdRequests = [];
  queuedPolls = 0;
  stallPolls = false;
  rejectNext = false;
  queueFull = false;
  cancelCalls = 0;
});

async function settle() {
  for (let i = 0; i < 40 && db.query({}).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('proxy /v1/images/generations -> native img_gen job (§4.3.2)', () => {
  it('submits a native job, polls it and answers with an OpenAI body', async () => {
    const res = await request(app).post('/v1/images/generations').send({
      model: 'qwen-image',
      prompt: 'a blue sphere',
      n: 1,
      size: '64x64',
      seed: 1234,
      steps: 4,
      sampler: 'euler',
      scheduler: 'simple',
      guidance: 3.5,
      output_format: 'png',
    });
    expect(res.status).toBe(200);
    // OpenAI shape: created + data[].b64_json, base64 copied through untouched.
    expect(typeof res.body.created).toBe('number');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].b64_json).toBe(COMPLETED.result.images[0].b64_json);
    // sd.cpp's own generation_info is not leaked to the client.
    expect(res.body.data[0].generation_info).toBeUndefined();
    expect(res.headers['x-proxy-request-id']).toBeTruthy();

    // The translated upstream call: native schema, top-level seed, batch_count.
    const submit = sdRequests[0];
    expect(submit.method).toBe('POST');
    expect(submit.url).toBe('/sdcpp/v1/img_gen');
    expect(submit.body).toEqual({
      prompt: 'a blue sphere',
      batch_count: 1,
      width: 64,
      height: 64,
      seed: 1234,
      output_format: 'png',
      sample_params: { sample_steps: 4, sample_method: 'euler', scheduler: 'simple', guidance: { txt_cfg: 3.5 } },
    });
    // Polled the poll_url the submit handed back.
    expect(sdRequests[1].url).toBe(SUBMITTED.poll_url);
    expect(sdRequests[1].method).toBe('GET');

    await settle();
    const [row] = db.query({});
    expect(row.endpoint).toBe('/v1/images/generations');
    expect(row.status).toBe(200);
    // No token concept for images: honest nulls, no estimated fallback.
    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.tokensEstimated).toBe(false);
    // meta: request shape plus what the job actually ran (§4.3.2).
    expect(row.meta).toMatchObject({
      promptChars: 'a blue sphere'.length,
      n: 1,
      jobId: COMPLETED.id,
      queueMs: COMPLETED.started - COMPLETED.created,
      renderMs: COMPLETED.completed - COMPLETED.started,
      seed: COMPLETED.result.images[0].generation_info.seed,
      steps: 4,
      width: 64,
      height: 64,
      outputFormat: 'png',
      count: 1,
    });
  });

  it('keeps polling through queued/running until the job settles', async () => {
    queuedPolls = 2;
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'qwen-image', prompt: 'patient render', size: '64x64' });
    expect(res.status).toBe(200);
    const polls = sdRequests.filter((r) => r.url === SUBMITTED.poll_url);
    expect(polls).toHaveLength(3); // queued, running, completed
  });

  it('maps an upstream validation 400 to an OpenAI 400 carrying the upstream text', async () => {
    rejectNext = true;
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'qwen-image', prompt: 'nope', size: '64x64' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(res.body.error.code).toBe('invalid_generation_params');
    expect(res.body.error.message).toContain('invalid generation parameters');
    await settle();
    expect(db.query({})[0].status).toBe(400);
  });

  it('maps a full job queue to 503', async () => {
    queueFull = true;
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'qwen-image', prompt: 'too busy', size: '64x64' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('backend_busy');
    await settle();
    expect(db.query({})[0].status).toBe(503);
  });

  it('rejects quality/style/url before ever touching the backend', async () => {
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'qwen-image', prompt: 'hi', quality: 'hd' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_parameter');
    expect(sdRequests).toHaveLength(0);
    await settle();
    expect(db.query({})[0].status).toBe(400);
  });

  it('times out on the total budget, cancels the job and records 504', async () => {
    settings.backends[0].timeoutMs = 400;
    stallPolls = true;
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'qwen-image', prompt: 'forever render', size: '64x64' });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('generation_timeout');
    // Best-effort cancel fired against the job's poll_url.
    expect(cancelCalls).toBe(1);
    expect(sdRequests.some((r) => r.url === `${SUBMITTED.poll_url}/cancel` && r.method === 'POST')).toBe(true);
    await settle();
    const [row] = db.query({});
    expect(row.status).toBe(504);
    expect(row.errorMessage).toContain('timeout');
  });

  it('a client abort stops the poll loop, cancels the job and records one 499', async () => {
    settings.backends[0].timeoutMs = 0; // no budget: only the abort ends this
    stallPolls = true;
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/images/generations', method: 'POST', headers: { 'content-type': 'application/json' } },
      () => { /* never expected: the stub stalls the poll */ },
    );
    req.on('error', () => { /* the aborted client sees ECONNRESET */ });
    req.end(JSON.stringify({ model: 'qwen-image', prompt: 'abandoned', size: '64x64' }));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (db.query({}).length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => req.destroy(), 250);
    });
    const [row] = db.query({});
    expect(row.status).toBe(499);
    expect(row.errorMessage).toContain('client disconnected');
    await new Promise((r) => setTimeout(r, 150));
    expect(db.query({})).toHaveLength(1); // exactly one row
    // Unlike a passthrough socket, the translator asks sd.cpp to cancel the job.
    expect(cancelCalls).toBe(1);
    req.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('502s when the sd backend is unreachable', async () => {
    settings.backends[0].baseUrl = 'http://127.0.0.1:1';
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'qwen-image', prompt: 'hi', size: '64x64' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('backend_unreachable');
    await settle();
    expect(db.query({})[0].status).toBe(502);
  });

  it('custom-kind image backends keep the raw OpenAI passthrough', async () => {
    // The stub 404s /v1/images/generations — proof the body went through
    // untranslated and the upstream's answer was piped back.
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'dalle-clone', prompt: 'hi', quality: 'hd' });
    expect(res.status).toBe(404);
    expect(sdRequests).toHaveLength(1);
    expect(sdRequests[0].url).toBe('/v1/images/generations');
    expect((sdRequests[0].body as Record<string, unknown>).quality).toBe('hd');
  });
});
