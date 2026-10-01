import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// Neutralize side-effectful modules BEFORE importing the app.
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
    start() {}
    stop() {}
    reset() {}
    getMetrics() { return []; }
  }
  return { ModelMetricsPoller };
});

// Prevent the real HTTP server from binding a port.
vi.mock('http', async () => {
  const actual = await vi.importActual<any>('http');
  const fakeServer = { on: () => {}, listen: () => ({}) };
  const httpMock = { ...actual.default, createServer: () => fakeServer };
  return { ...actual, default: httpMock };
});

import { app } from '../index.js';

// Use an isolated temp dir for the .config files so tests don't clobber real config.
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let originalCwd: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-api-test-'));
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Config API', () => {
  it('GET /api/config returns a config object', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('port');
    expect(res.body).toHaveProperty('host');
  });

  it('PUT /api/config updates and persists', async () => {
    const res = await request(app).put('/api/config').send({ port: 9999 });
    expect(res.status).toBe(200);
    expect(res.body.port).toBe(9999);

    const get = await request(app).get('/api/config');
    expect(get.body.port).toBe(9999);
  });
});

describe('Model Config API', () => {
  it('POST /api/models/configs creates a config', async () => {
    const res = await request(app)
      .post('/api/models/configs')
      .send({ alias: 'Test Model', modelPath: '/m.gguf', params: { 'ctx-size': '4096' }, paramOrder: ['model', 'ctx-size'] });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('Test Model');
    expect(res.body.id).toBeTruthy();
  });

  it('GET /api/models returns the created config', async () => {
    const res = await request(app).get('/api/models');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.configs)).toBe(true);
    expect(res.body.configs.some((c: any) => c.alias === 'Test Model')).toBe(true);
  });

  it('PUT /api/models/configs/:id updates a config', async () => {
    const list = await request(app).get('/api/models');
    const cfg = list.body.configs.find((c: any) => c.alias === 'Test Model');
    const res = await request(app).put(`/api/models/configs/${cfg.id}`).send({ notes: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('updated');
  });

  it('POST /api/models/configs/:id/clone creates a copy', async () => {
    const list = await request(app).get('/api/models');
    const cfg = list.body.configs.find((c: any) => c.alias === 'Test Model');
    const res = await request(app).post(`/api/models/configs/${cfg.id}/clone`).send({});
    expect(res.status).toBe(200);
    expect(res.body.id).not.toBe(cfg.id);
    expect(res.body.alias).toContain('Test Model');
  });

  it('DELETE /api/models/configs/:id removes a config', async () => {
    const list = await request(app).get('/api/models');
    const cfg = list.body.configs.find((c: any) => c.alias === 'Test Model');
    const res = await request(app).delete(`/api/models/configs/${cfg.id}`);
    expect(res.status).toBe(200);

    const after = await request(app).get('/api/models');
    expect(after.body.configs.some((c: any) => c.id === cfg.id)).toBe(false);
  });

  it('PUT on unknown id returns 404', async () => {
    const res = await request(app).put('/api/models/configs/nonexistent').send({ notes: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('Params API', () => {
  it('GET /api/params returns an array of param defs', async () => {
    const res = await request(app).get('/api/params');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Seeded from DEFAULT_PARAMS on first run
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('key');
    expect(res.body[0]).toHaveProperty('flag');
  });
});

describe('Router INI Import/Export', () => {
  it('POST /api/models/import-ini parses and stores configs', async () => {
    const ini = `version = 1\n\n[Imported]\nmodel = /imp.gguf\nctx-size = 2048\n`;
    const res = await request(app).post('/api/models/import-ini').send({ content: ini });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const list = await request(app).get('/api/models');
    expect(list.body.configs.some((c: any) => c.alias === 'Imported')).toBe(true);
  });

  it('POST /api/models/import-ini without content returns 400', async () => {
    const res = await request(app).post('/api/models/import-ini').send({});
    expect(res.status).toBe(400);
  });

  it('GET /api/models/export-ini returns INI text', async () => {
    const res = await request(app).get('/api/models/export-ini');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('version = 1');
    expect(res.text).toContain('[Imported]');
  });
});

describe('Status & Version', () => {
  it('GET /api/status returns process status', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('metrics');
  });

  it('GET /api/app-version returns a version string', async () => {
    const res = await request(app).get('/api/app-version');
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('string');
  });
});

describe('Logs API', () => {
  it('POST /api/logs/clear returns ok', async () => {
    const res = await request(app).post('/api/logs/clear');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
