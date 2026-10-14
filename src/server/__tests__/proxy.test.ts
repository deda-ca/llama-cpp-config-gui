import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createProxyApp } from '../proxy/index.js';
import { ModelRouter } from '../proxy/router.js';
import { UsageDb } from '../proxy/usageDb.js';
import { DEFAULT_PROXY_SETTINGS, type ProxySettings, type UsageRecord } from '../proxy/types.js';

// --- Stub upstream that replays realistic llama.cpp responses ---
const CHAT_JSON = JSON.stringify({
  id: 'chatcmpl-1', object: 'chat.completion', model: 'qwen',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 123, completion_tokens: 2, total_tokens: 125 },
});
const CHAT_SSE = [
  'data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"content":"lo!"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":3,"total_tokens":126}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

let upstream: http.Server;
let upstreamUrl = '';
let lastUpstreamBody = '';
let lastUpstreamAuth = '';

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastUpstreamBody = body;
      lastUpstreamAuth = String(req.headers.authorization ?? '');
      if (req.url === '/v1/chat/completions') {
        const wantsStream = JSON.parse(body).stream === true;
        if (wantsStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          // Write in two chunks to exercise boundary handling
          res.write(CHAT_SSE.slice(0, 60));
          res.end(CHAT_SSE.slice(60));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(CHAT_JSON);
        }
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen' }] }));
      } else if (req.url === '/v1/images/generations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'AA' }] }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

let tmpDir: string;
let db: UsageDb;
let settings: ProxySettings;
let router: ModelRouter;
let usageEvents: UsageRecord[];
let app: ReturnType<typeof createProxyApp>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
  db = new UsageDb(path.join(tmpDir, 'usage.db'));
  settings = {
    ...DEFAULT_PROXY_SETTINGS,
    backends: [
      { id: 'llamacpp', name: 'llama.cpp', kind: 'llamacpp', baseUrl: upstreamUrl, apiKey: 'upstream-key', enabled: true },
      { id: 'audio', name: 'audio.cpp', kind: 'audio', baseUrl: 'http://127.0.0.1:1', enabled: true },
      { id: 'sdiffusion', name: 'stable-diffusion.cpp', kind: 'sdiffusion', baseUrl: upstreamUrl, enabled: true },
    ],
    models: [{ model: 'sd-xl', backend: 'sdiffusion', enabled: true }],
  };
  router = new ModelRouter();
  router.rebuild(settings, ['qwen']);
  usageEvents = [];
  app = createProxyApp({
    getSettings: () => settings,
    router,
    db,
    onUsage: (r) => usageEvents.push(r),
  });
});

// Let async finalize run (finalize happens on upstream 'end')
async function settle() {
  for (let i = 0; i < 20 && db.query({}).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('proxy auth', () => {
  it('rejects when apiKey set and no bearer', async () => {
    settings.apiKey = 'secret';
    const res = await request(app).post('/v1/chat/completions').send({ model: 'qwen', messages: [] });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_api_key');
  });
  it('accepts bearer key and attaches upstream key', async () => {
    settings.apiKey = 'secret';
    const res = await request(app).post('/v1/chat/completions')
      .set('Authorization', 'Bearer secret')
      .send({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(lastUpstreamAuth).toBe('Bearer upstream-key');
  });
});

describe('proxy routing', () => {
  it('404s unknown models on chat endpoints', async () => {
    const res = await request(app).post('/v1/chat/completions').send({ model: 'nope', messages: [] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('model_not_found');
  });

  it('rejects non-llama models on chat endpoints', async () => {
    const res = await request(app).post('/v1/chat/completions').send({ model: 'sd-xl', messages: [] });
    expect(res.status).toBe(400);
  });

  it('lists models from the registry', async () => {
    const res = await request(app).get('/v1/models');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['qwen', 'sd-xl']));
  });

  it('health endpoint works', async () => {
    const res = await request(app).get('/health');
    expect(res.body.status).toBe('ok');
  });

  it('502s when backend unreachable', async () => {
    settings.backends.find((b) => b.id === 'audio')!.baseUrl = 'http://127.0.0.1:1';
    const res = await request(app).post('/v1/audio/speech')
      .set('x-model', 'audio/voice1').send({ input: 'hi' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('backend_unreachable');
  });
});

describe('proxy passthrough + usage recording', () => {
  it('non-streaming chat: response passthrough and usage row', async () => {
    const res = await request(app).post('/v1/chat/completions')
      .send({ model: 'qwen', messages: [{ role: 'user', content: 'hello world this is a test prompt' }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Hello!');
    expect(res.headers['x-proxy-request-id']).toMatch(/[0-9a-f-]{36}/);
    await settle();
    const [row] = db.query({});
    expect(row.model).toBe('qwen');
    expect(row.backend).toBe('llamacpp');
    expect(row.inputTokens).toBe(123);
    expect(row.outputTokens).toBe(2);
    expect(row.tokensEstimated).toBe(false);
    expect(row.stream).toBe(false);
    expect(row.ttfbMs).not.toBeNull();
    expect(row.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(usageEvents).toHaveLength(1);
  });

  it('streaming chat: injects include_usage and records usage from SSE', async () => {
    const res = await request(app).post('/v1/chat/completions')
      .send({ model: 'qwen', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.text).toBe(CHAT_SSE); // byte-identical passthrough
    // forwarded body must carry stream_options.include_usage
    expect(JSON.parse(lastUpstreamBody).stream_options).toEqual({ include_usage: true });
    await settle();
    const [row] = db.query({});
    expect(row.stream).toBe(true);
    expect(row.inputTokens).toBe(123);
    expect(row.outputTokens).toBe(3);
  });

  it('remaps backendModel upstream', async () => {
    settings.models.push({ model: 'alias-x', backend: 'llamacpp', backendModel: 'qwen', enabled: true });
    router.rebuild(settings, ['qwen']);
    const res = await request(app).post('/v1/chat/completions')
      .send({ model: 'alias-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(JSON.parse(lastUpstreamBody).model).toBe('qwen');
  });

  it('images route to SD backend with meta captured', async () => {
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'sd-xl', prompt: 'a cat', steps: 20, width: 1024, height: 1024 });
    expect(res.status).toBe(200);
    expect(res.body.data[0].b64_json).toBe('AA');
    await settle();
    const [row] = db.query({});
    expect(row.backend).toBe('sdiffusion');
    expect(row.inputTokens).toBeNull();
    expect(row.meta).toMatchObject({ steps: 20, width: 1024, promptChars: 5 });
  });

  it('records 502 row when upstream unreachable', async () => {
    settings.backends.find((b) => b.id === 'llamacpp')!.baseUrl = 'http://127.0.0.1:1';
    const res = await request(app).post('/v1/chat/completions')
      .send({ model: 'qwen', messages: [{ role: 'user', content: 'hi there friend' }] });
    expect(res.status).toBe(502);
    await settle();
    const [row] = db.query({});
    expect(row.status).toBe(502);
    expect(row.errorMessage).toContain('upstream error');
    // Estimated input tokens used as fallback
    expect(row.inputTokens).toBeGreaterThan(0);
    expect(row.tokensEstimated).toBe(true);
  });
});
