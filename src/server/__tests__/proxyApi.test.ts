// Reuse the same side-effect neutralizers as api.test.ts
vi.mock('../gpu.js', () => ({
  startGpuPolling: () => ({ stop: () => {}, setInterval: () => {} }),
  queryGpus: async () => [],
}));
vi.mock('../llama.js', () => {
  class LlamaProcessManager {
    onLogLine: any = null;
    onStatusChange: any = null;
    onMetrics: any = null;
    getStatus() { return 'stopped'; }
    getMetrics() { return { prefillTokensPerSec: null, generationTokensPerSec: null, lastUpdated: 0 }; }
    launch() {}
    stop() {}
  }
  return {
    LlamaProcessManager,
    listLlamaDevices: async () => [],
    matchCudaIndices: () => new Map(),
    getLlamaVersion: async () => ({ version: null, build: null, commit: null, compiler: null, backend: null, raw: [] }),
  };
});
vi.mock('../metricsPoller.js', () => {
  class ModelMetricsPoller {
    onMetrics: any = null;
    start() {} stop() {} reset() {} getMetrics() { return []; }
  }
  return { ModelMetricsPoller };
});
vi.mock('http', async () => {
  const actual = await vi.importActual<any>('http');
  const fakeServer = { on: () => {}, listen: () => ({}), close: () => {} };
  const httpMock = { ...actual.default, createServer: () => fakeServer };
  return { ...actual, default: httpMock };
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from '../index.js';

let tmpDir: string;
let originalCwd: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-api-test-'));
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset proxy settings to defaults between tests (module state persists)
  await request(app).put('/api/proxy/settings').send({
    enabled: false, host: '127.0.0.1', port: 8090, apiKey: '', usageRetentionDays: 90,
    backends: [
      { id: 'llamacpp', name: 'llama.cpp', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', enabled: true },
      { id: 'audio', name: 'audio.cpp', kind: 'audio', baseUrl: 'http://127.0.0.1:8082', enabled: true },
      { id: 'sdiffusion', name: 'stable-diffusion.cpp', kind: 'sdiffusion', baseUrl: 'http://127.0.0.1:7860', enabled: true },
    ],
    models: [],
  });
});

describe('GET/PUT /api/proxy/settings', () => {
  it('returns defaults initially', async () => {
    const res = await request(app).get('/api/proxy/settings');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.port).toBe(8090);
    expect(res.body.usageRetentionDays).toBe(90);
  });

  it('persists updates', async () => {
    const res = await request(app).put('/api/proxy/settings').send({ port: 8091, apiKey: 'k' });
    expect(res.status).toBe(200);
    expect(res.body.port).toBe(8091);
    const get = await request(app).get('/api/proxy/settings');
    expect(get.body.port).toBe(8091);
    expect(get.body.apiKey).toBe('k');
  });

  it('rejects port conflicting with GUI server port', async () => {
    const res = await request(app).put('/api/proxy/settings').send({ port: 3001 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('conflicts');
  });

  it('rejects invalid backend baseUrl', async () => {
    const res = await request(app).put('/api/proxy/settings').send({
      backends: [{ id: 'audio', name: 'audio', kind: 'audio', baseUrl: 'not a url', enabled: true }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('URL');
  });

  it('persists model pricing and drops invalid entries', async () => {
    const res = await request(app).put('/api/proxy/settings').send({
      modelPricing: {
        'qwen2.5-14b': { input: 0.5, cached: 0.1, output: 2 },
        bad: { input: -3 },
        alsoBad: 'nope',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.modelPricing['qwen2.5-14b']).toEqual({ input: 0.5, cached: 0.1, output: 2 });
    expect(res.body.modelPricing.bad).toBeUndefined();
    expect(res.body.modelPricing.alsoBad).toBeUndefined();
    const get = await request(app).get('/api/proxy/settings');
    expect(get.body.modelPricing['qwen2.5-14b'].output).toBe(2);
  });
});

describe('/api/proxy/models CRUD', () => {
  it('adds, updates, and deletes an SD route', async () => {
    const add = await request(app).post('/api/proxy/models')
      .send({ model: 'sd-xl', backend: 'sdiffusion', backendModel: 'xl-v1' });
    expect(add.status).toBe(200);
    expect(add.body).toHaveLength(1);

    const upd = await request(app).put('/api/proxy/models/sd-xl').send({ enabled: false });
    expect(upd.body.enabled).toBe(false);

    const del = await request(app).delete('/api/proxy/models/sd-xl');
    expect(del.status).toBe(200);
    const get = await request(app).get('/api/proxy/settings');
    expect(get.body.models).toHaveLength(0);
  });

  it('rejects routes to unknown backend ids', async () => {
    const res = await request(app).post('/api/proxy/models').send({ model: 'x', backend: 'nope' });
    expect(res.status).toBe(400);
  });

  it('allows duplicate aliases with exactly one active route', async () => {
    const first = await request(app).post('/api/proxy/models')
      .send({ model: 'dup', backend: 'audio', backendModel: 'up-a' });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/proxy/models')
      .send({ model: 'dup', backend: 'sdiffusion', backendModel: 'up-b' });
    expect(second.status).toBe(200);
    let get = await request(app).get('/api/proxy/settings');
    const routes = get.body.models.filter((m: { model: string }) => m.model === 'dup');
    expect(routes).toHaveLength(2);
    expect(routes.filter((m: { active: boolean }) => m.active)).toHaveLength(1);
    expect(routes[0].active).toBe(true);
    expect(routes[1].active).toBe(false);

    // Activating the second deactivates the first
    const act = await request(app).put('/api/proxy/models/dup')
      .send({ backend: 'sdiffusion', backendModel: 'up-b', active: true });
    expect(act.status).toBe(200);
    get = await request(app).get('/api/proxy/settings');
    const after = get.body.models.filter((m: { model: string }) => m.model === 'dup');
    expect(after.find((m: { backend: string }) => m.backend === 'audio').active).toBe(false);
    expect(after.find((m: { backend: string }) => m.backend === 'sdiffusion').active).toBe(true);

    // Deleting the live route promotes the twin
    const del = await request(app).delete('/api/proxy/models/dup?backend=sdiffusion&backendModel=up-b');
    expect(del.status).toBe(200);
    get = await request(app).get('/api/proxy/settings');
    const remaining = get.body.models.filter((m: { model: string }) => m.model === 'dup');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].backend).toBe('audio');
    expect(remaining[0].active).toBe(true);
  });

  it('allows the same alias twice on the same backend with different upstreams', async () => {
    const a = await request(app).post('/api/proxy/models').send({ model: 'same', backend: 'audio' });
    const b = await request(app).post('/api/proxy/models').send({ model: 'same', backend: 'audio', backendModel: 'other' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('/api/proxy/backends CRUD', () => {
  it('adds, edits, toggles, and deletes a backend', async () => {
    const add = await request(app).post('/api/proxy/backends')
      .send({ name: 'My TTS', kind: 'audio', baseUrl: 'http://127.0.0.1:9000', enabled: true });
    expect(add.status).toBe(200);
    expect(add.body.id).toBe('my-tts');

    const upd = await request(app).put('/api/proxy/backends/my-tts')
      .send({ baseUrl: 'http://127.0.0.1:9001', apiKey: 'sk-1', enabled: false });
    expect(upd.status).toBe(200);
    expect(upd.body.baseUrl).toBe('http://127.0.0.1:9001');
    expect(upd.body.apiKey).toBe('sk-1');
    expect(upd.body.enabled).toBe(false);

    const del = await request(app).delete('/api/proxy/backends/my-tts');
    expect(del.status).toBe(200);
    const get = await request(app).get('/api/proxy/settings');
    expect(get.body.backends.map((b: { id: string }) => b.id)).not.toContain('my-tts');
  });

  it('uniquifies ids for duplicate names', async () => {
    await request(app).post('/api/proxy/backends').send({ name: 'dup', kind: 'custom', baseUrl: 'http://127.0.0.1:1' });
    const second = await request(app).post('/api/proxy/backends').send({ name: 'dup', kind: 'custom', baseUrl: 'http://127.0.0.1:2' });
    expect(second.body.id).toBe('dup-2');
  });

  it('validates kind and baseUrl', async () => {
    const bad = await request(app).post('/api/proxy/backends').send({ name: 'x', kind: 'bogus', baseUrl: 'http://127.0.0.1:1' });
    expect(bad.status).toBe(400);
    const badUrl = await request(app).post('/api/proxy/backends').send({ name: 'x', kind: 'custom', baseUrl: 'nope' });
    expect(badUrl.status).toBe(400);
  });

  it('refresh fetches upstream /v1/models and persists them', async () => {
    const http = await import('http');
    const stub = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama-3.1-8b' }, { id: 'phi4-mini' }] }));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const port = (stub.address() as { port: number }).port;
    try {
      const add = await request(app).post('/api/proxy/backends')
        .send({ name: 'Llama Two', kind: 'llamacpp', baseUrl: `http://127.0.0.1:${port}` });
      expect(add.status).toBe(200);

      const ref = await request(app).post('/api/proxy/backends/llama-two/refresh');
      expect(ref.status).toBe(200);
      expect(ref.body.models).toEqual(['llama-3.1-8b', 'phi4-mini']);
      expect(ref.body.modelsFetchedAt).toBeTypeOf('string');

      const get = await request(app).get('/api/proxy/settings');
      const b = get.body.backends.find((x: { id: string }) => x.id === 'llama-two');
      expect(b.models).toEqual(['llama-3.1-8b', 'phi4-mini']);
    } finally {
      stub.close();
    }
  });

  it('refresh returns 502 when the upstream is unreachable', async () => {
    await request(app).post('/api/proxy/backends')
      .send({ name: 'Dead', kind: 'custom', baseUrl: 'http://127.0.0.1:1' });
    const ref = await request(app).post('/api/proxy/backends/dead/refresh');
    expect(ref.status).toBe(502);
    expect(ref.body.error).toContain('Failed to fetch models');
  });

  it('probe-models verifies an arbitrary URL without persisting anything', async () => {
    const http = await import('http');
    const stub = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'bge-m3' }, { id: 'nomic-embed' }] }));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const port = (stub.address() as { port: number }).port;
    try {
      const res = await request(app).post('/api/proxy/probe-models')
        .send({ baseUrl: `http://127.0.0.1:${port}` });
      expect(res.status).toBe(200);
      expect(res.body.models).toEqual(['bge-m3', 'nomic-embed']);
      // Nothing was created or attached
      const get = await request(app).get('/api/proxy/settings');
      expect(get.body.backends).toHaveLength(3);
    } finally {
      stub.close();
    }
  });

  it('probe-models validates input and 502s on unreachable URLs', async () => {
    const noUrl = await request(app).post('/api/proxy/probe-models').send({});
    expect(noUrl.status).toBe(400);
    const badUrl = await request(app).post('/api/proxy/probe-models').send({ baseUrl: 'nope' });
    expect(badUrl.status).toBe(400);
    const dead = await request(app).post('/api/proxy/probe-models').send({ baseUrl: 'http://127.0.0.1:1' });
    expect(dead.status).toBe(502);
    expect(dead.body.error).toContain('Failed to fetch models');
  });

  it('deleting a backend removes its routes', async () => {
    await request(app).post('/api/proxy/backends').send({ name: 'Temp', kind: 'sdiffusion', baseUrl: 'http://127.0.0.1:9100' });
    await request(app).post('/api/proxy/models').send({ model: 'tmp-sd', backend: 'temp' });
    await request(app).delete('/api/proxy/backends/temp');
    const get = await request(app).get('/api/proxy/settings');
    expect(get.body.models).toHaveLength(0);
  });
});

describe('/api/proxy/start|stop|restart', () => {
  it('starts and stops the listener on a free port', async () => {
    await request(app).put('/api/proxy/settings').send({ port: 8231, host: '127.0.0.1' });
    const start = await request(app).post('/api/proxy/start');
    expect(start.status).toBe(200);
    expect(start.body.running).toBe(true);
    const settings = await request(app).get('/api/proxy/settings');
    expect(settings.body.enabled).toBe(true);

    const stop = await request(app).post('/api/proxy/stop');
    expect(stop.body.running).toBe(false);
    const after = await request(app).get('/api/proxy/settings');
    expect(after.body.enabled).toBe(false);
  });
});

describe('/api/proxy/status', () => {
  it('reports not running with backend health probes', async () => {
    const res = await request(app).get('/api/proxy/status');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
    expect(res.body.backends.llamacpp).toBe(false);
    expect(res.body.models).toBeInstanceOf(Array);
  });
});
