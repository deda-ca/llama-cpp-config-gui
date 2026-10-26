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
let lastUpstreamContentType = '';
/** Set when the stub never answers: the request is parked so the proxy's idle
 *  timeout is the only thing that can end it. */
let stallNext = false;
const stalledRequests: http.IncomingMessage[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastUpstreamBody = body;
      lastUpstreamAuth = String(req.headers.authorization ?? '');
      lastUpstreamContentType = String(req.headers['content-type'] ?? '');
      if (stallNext) {
        stallNext = false;
        stalledRequests.push(req);
        return; // deliberately never respond
      }
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
      } else if (req.url === '/v1/images/edits') {
        // sd.cpp's image-edit endpoint: multipart in, JSON out (api.md:428-441)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: 'RkZC' }] }));
      } else if (req.url === '/v1/embeddings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list', model: JSON.parse(body).model,
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }));
      } else if (req.url === '/v1/moderations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'mod-1', model: JSON.parse(body).model, results: [{ flagged: false }] }));
      } else if (req.url === '/v1/videos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'vid-1', object: 'video', model: JSON.parse(body).model, status: 'queued' }));
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
      { id: 'custom-img', name: 'OpenAI images', kind: 'custom', baseUrl: upstreamUrl, enabled: true },
      { id: 'embeddings', name: 'embeddings.cpp', kind: 'embeddings', baseUrl: upstreamUrl, enabled: true },
      { id: 'moderation', name: 'moderation.cpp', kind: 'moderation', baseUrl: upstreamUrl, enabled: true },
      { id: 'videos', name: 'videos.cpp', kind: 'videos', baseUrl: upstreamUrl, enabled: true },
    ],
    models: [
      { model: 'sd-xl', backend: 'sdiffusion', enabled: true },
      { model: 'dalle-clone', backend: 'custom-img', enabled: true },
      { model: 'bge-m3', backend: 'embeddings', enabled: true },
      { model: 'omni-mod', backend: 'moderation', enabled: true },
      { model: 'wan-video', backend: 'videos', enabled: true },
    ],
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

  it('images route to a custom image backend with meta captured', async () => {
    // Raw passthrough path: a `custom` upstream is a real OpenAI image server,
    // so the body goes through untouched. (`sdiffusion` backends are translated
    // to native img_gen jobs instead — see sdTranslator.test.ts.)
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'dalle-clone', prompt: 'a cat', steps: 20, width: 1024, height: 1024 });
    expect(res.status).toBe(200);
    expect(res.body.data[0].b64_json).toBe('AA');
    await settle();
    const [row] = db.query({});
    expect(row.backend).toBe('custom-img');
    expect(row.inputTokens).toBeNull();
    expect(row.meta).toMatchObject({ steps: 20, width: 1024, promptChars: 5 });
  });

  it('embeddings route to the embeddings backend and record usage', async () => {
    const res = await request(app).post('/v1/embeddings')
      .send({ model: 'bge-m3', prompt: 'hello there my friend' });
    expect(res.status).toBe(200);
    expect(res.body.data[0].embedding).toEqual([0.1, 0.2]);
    await settle();
    const [row] = db.query({});
    expect(row.backend).toBe('embeddings');
    expect(row.endpoint).toBe('/v1/embeddings');
    expect(row.inputTokens).toBe(7);
  });

  it('embeddings still accepted by llama.cpp backends', async () => {
    settings.models.push({ model: 'qwen-embed', backend: 'llamacpp', enabled: true });
    router.rebuild(settings, ['qwen']);
    const res = await request(app).post('/v1/embeddings').send({ model: 'qwen-embed', input: 'hi' });
    expect(res.status).toBe(200);
  });

  it('rejects embedding models on chat endpoints', async () => {
    const res = await request(app).post('/v1/chat/completions').send({ model: 'bge-m3', messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_model');
  });

  it('moderations route to the moderation backend', async () => {
    const res = await request(app).post('/v1/moderations').send({ model: 'omni-mod', input: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.results[0].flagged).toBe(false);
    await settle();
    expect(db.query({})[0].backend).toBe('moderation');
  });

  it('videos route to the videos backend with meta captured', async () => {
    const res = await request(app).post('/v1/videos')
      .send({ model: 'wan-video', prompt: 'a cat', seconds: 4, size: '720p' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    await settle();
    const [row] = db.query({});
    expect(row.backend).toBe('videos');
    expect(row.meta).toMatchObject({ seconds: 4, size: '720p', promptChars: 5 });
  });

  it('rejects non-video models on the videos endpoint', async () => {
    const res = await request(app).post('/v1/videos').send({ model: 'sd-xl', prompt: 'a cat' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_model');
  });

  it("'default' kind backend catches unrouted requests", async () => {
    settings.backends.push({ id: 'default', name: 'Default', kind: 'default', baseUrl: upstreamUrl, enabled: true });
    router.rebuild(settings, ['qwen']);
    const res = await request(app).post('/v1/chat/completions')
      .send({ model: 'anything-not-registered', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('Hello!');
    await settle();
    const [row] = db.query({});
    expect(row.backend).toBe('default');
    expect(row.model).toBe('anything-not-registered');
  });

  it("'default' backend also serves embeddings and raw audio endpoints", async () => {
    settings.backends.push({ id: 'default', name: 'Default', kind: 'default', baseUrl: upstreamUrl, enabled: true });
    // Only llamacpp + default exist, so namespaced paths with no kind backend land on default
    settings.backends = settings.backends.filter((b) => b.id === 'llamacpp' || b.id === 'default');
    router.rebuild(settings, []);
    const emb = await request(app).post('/v1/embeddings').send({ model: 'whatever', input: 'hi' });
    expect(emb.status).toBe(200);
    expect(emb.body.data[0].embedding).toEqual([0.1, 0.2]);
    const audio = await request(app).post('/v1/audio/speech')
      .set('x-model', 'unrouted-voice').send(JSON.stringify({ input: 'hi' }));
    // Upstream stub has no /v1/audio/speech -> its own 404 proves the request was forwarded
    expect(audio.status).toBe(404);
    expect(audio.body?.error).toBeUndefined();
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

// --- image-edit raw passthrough + upstream timeouts (docs/stable-diffusion.md §3.7) ---

describe('/v1/images/edits raw passthrough', () => {
  it('pipes a multipart body untouched to an sdiffusion backend', async () => {
    const boundary = '----sdTestBoundary123';
    const multipart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'sd-xl',
      `--${boundary}`,
      'Content-Disposition: form-data; name="prompt"',
      '',
      'make it blue',
      `--${boundary}`,
      'Content-Disposition: form-data; name="image[]"; filename="cat.png"',
      'Content-Type: image/png',
      '',
      'PNGDATA',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await request(app)
      .post('/v1/images/edits')
      .set('content-type', `multipart/form-data; boundary=${boundary}`)
      .set('x-model', 'sd-xl')
      .send(multipart);
    expect(res.status).toBe(200);
    expect(res.body.data[0].b64_json).toBe('RkZC');
    // The body reached upstream byte-for-byte: express.json never consumed it,
    // and the JSON_BODY_LIMIT is irrelevant to a raw route.
    expect(lastUpstreamContentType).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(lastUpstreamBody).toContain('make it blue');
    expect(lastUpstreamBody).toContain('PNGDATA');
    await settle();
    const [row] = db.query({});
    expect(row.backend).toBe('sdiffusion');
    expect(row.model).toBe('sd-xl');
    expect(row.endpoint).toBe('/v1/images/edits');
  });

  it('resolves the model from the path fallback when no x-model header is set', async () => {
    // /v1/images/* falls back to the sdiffusion backend like /v1/audio/* does
    // for audio (§3.7 reuses handleRaw's resolution rule).
    const res = await request(app)
      .post('/v1/images/edits')
      .set('content-type', 'multipart/form-data; boundary=x')
      .send('--x--\r\n');
    expect(res.status).toBe(200);
    expect(res.body.data[0].b64_json).toBe('RkZC');
  });

  it('rejects a non-image model on the image-edit endpoint', async () => {
    const res = await request(app)
      .post('/v1/images/edits')
      .set('content-type', 'multipart/form-data; boundary=x')
      .set('x-model', 'qwen')
      .send('--x--\r\n');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_model');
  });

  it('a huge multipart body passes despite the 10mb JSON body limit', async () => {
    const big = 'A'.repeat(11 * 1024 * 1024);
    const res = await request(app)
      .post('/v1/images/edits')
      .set('content-type', 'multipart/form-data; boundary=x')
      .set('x-model', 'sd-xl')
      .send(`--x\r\n\r\n${big}\r\n--x--\r\n`);
    expect(res.status).toBe(200);
    expect(lastUpstreamBody.length).toBeGreaterThan(11 * 1024 * 1024);
  });
});

describe('upstream idle timeout + client abort (proxy §3.7)', () => {
  it('502s and records when the backend stalls past timeoutMs', async () => {
    settings.backends.find((b) => b.id === 'custom-img')!.timeoutMs = 300;
    router.rebuild(settings, ['qwen']);
    stallNext = true;
    const res = await request(app).post('/v1/images/generations')
      .send({ model: 'dalle-clone', prompt: 'slow render' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('backend_unreachable');
    expect(res.body.error.message).toContain('timed out');
    await settle();
    const [row] = db.query({});
    expect(row.status).toBe(502);
    expect(row.errorMessage).toContain('timed out');
  });

  it('a client abort records one 499 row and kills the upstream request', async () => {
    settings.backends.find((b) => b.id === 'custom-img')!.timeoutMs = 0; // no idle budget: only the abort ends this
    router.rebuild(settings, ['qwen']);
    stallNext = true;
    // supertest always completes its request, so drive the proxy through a real
    // listener and hang up mid-response.
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/images/generations', method: 'POST', headers: { 'content-type': 'application/json' } },
      () => { /* never expected: the stub stalls */ },
    );
    req.on('error', () => { /* the aborted client sees ECONNRESET */ });
    req.end(JSON.stringify({ model: 'dalle-clone', prompt: 'abandoned' }));
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
    // Exactly one row: the abort path must not double-record alongside upstream.
    await new Promise((r) => setTimeout(r, 150));
    expect(db.query({})).toHaveLength(1);
    // The upstream request was destroyed by the proxy, not left hanging.
    expect(stalledRequests[stalledRequests.length - 1].destroyed).toBe(true);
    req.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
