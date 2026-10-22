import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// Isolate the .config directory BEFORE the app module loads (its module-level
// side effects — loadConfig, engines migration, params reseed — touch .config).
// A legacy settings.json is seeded so the engines migration has a known start.
const tmpDir = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-api-test-'));
  fs.mkdirSync(path.join(dir, '.config'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.config', 'settings.json'),
    JSON.stringify({ llamaCppPath: '/opt/llama-test', port: 8080, host: '127.0.0.1' }),
  );
  (globalThis as any).__originalCwd = process.cwd();
  process.chdir(dir);
  return dir;
});

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

// The temp dir was created and chdir'd in the hoisted block above.
import fs from 'fs';

afterAll(() => {
  process.chdir((globalThis as any).__originalCwd);
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

  it('PUT /api/models/configs/reorder persists a config order', async () => {
    const list = await request(app).get('/api/models');
    const ids = list.body.configs.map((c: any) => c.id);
    const reversed = [...ids].reverse();

    const res = await request(app)
      .put('/api/models/configs/reorder')
      .send({ configOrder: reversed });

    expect(res.status).toBe(200);
    expect(res.body.configOrder).toEqual(reversed);

    const after = await request(app).get('/api/models');
    expect(after.body.configOrder).toEqual(reversed);
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

describe('Engine API', () => {
  let defId: string;
  let instId: string;

  it('GET /api/engines returns definitions, instances and a default id', async () => {
    const res = await request(app).get('/api/engines');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.definitions)).toBe(true);
    expect(Array.isArray(res.body.instances)).toBe(true);
    // Seeded from the legacy settings.json at startup
    expect(res.body.defaultInstanceId).toBeTruthy();
    expect(res.body.instances[0]).toHaveProperty('status');
  });

  it('POST /api/engines/definitions creates a definition', async () => {
    const res = await request(app)
      .post('/api/engines/definitions')
      .send({ name: 'Build A', kind: 'llamacpp', buildPath: '/opt/llama', envVars: { CUDA_VISIBLE_DEVICES: '0' } });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('build-a');
    expect(res.body.envVars).toEqual({ CUDA_VISIBLE_DEVICES: '0' });
    defId = res.body.id;
  });

  it('POST /api/engines/definitions requires a name', async () => {
    const res = await request(app).post('/api/engines/definitions').send({ kind: 'llamacpp' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/engines/definitions/:id updates fields', async () => {
    const res = await request(app).put(`/api/engines/definitions/${defId}`).send({ buildPath: '/opt/llama2', envVars: {} });
    expect(res.status).toBe(200);
    expect(res.body.buildPath).toBe('/opt/llama2');
    expect(res.body.envVars).toEqual({});
  });

  it('POST /api/engines/instances creates an instance with a free port', async () => {
    const before = await request(app).get('/api/engines');
    const taken = new Set(before.body.instances.map((i: any) => i.port));

    const res = await request(app)
      .post('/api/engines/instances')
      .send({ name: 'My Engine', definitionId: defId });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('my-engine');
    expect(res.body.definitionId).toBe(defId);
    expect(taken.has(res.body.port)).toBe(false);
    instId = res.body.id;
  });

  it('POST /api/engines/instances rejects an explicit port conflict', async () => {
    const before = await request(app).get('/api/engines');
    const used = before.body.instances[0].port;
    const res = await request(app)
      .post('/api/engines/instances')
      .send({ name: 'Clash', definitionId: defId, port: used });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(String(used));
  });

  it('POST /api/engines/instances requires a valid definitionId', async () => {
    const res = await request(app).post('/api/engines/instances').send({ name: 'X', definitionId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/engines/instances/:id updates params and rejects port clashes', async () => {
    const res = await request(app)
      .put(`/api/engines/instances/${instId}`)
      .send({
        params: [{ key: '--host', value: '0.0.0.0' }, { key: '--metrics' }, { key: '  ' }],
        routerMode: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.params).toEqual([
      { key: '--host', value: '0.0.0.0' },
      { key: '--metrics' },
    ]);

    const before = await request(app).get('/api/engines');
    const otherPort = before.body.instances.find((i: any) => i.id !== instId).port;
    const clash = await request(app).put(`/api/engines/instances/${instId}`).send({ port: otherPort });
    expect(clash.status).toBe(409);
  });

  it('DELETE /api/engines/definitions/:id is blocked while an instance uses it', async () => {
    const res = await request(app).delete(`/api/engines/definitions/${defId}`);
    expect(res.status).toBe(409);
  });

  it('POST /api/engines/instances/:id/launch starts the instance', async () => {
    const res = await request(app).post(`/api/engines/instances/${instId}/launch`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body.routerIniPath).toBeNull();
  });

  it('POST /api/engines/instances/:id/launch rejects router mode without models', async () => {
    await request(app).put(`/api/engines/instances/${instId}`).send({ routerMode: true, modelConfigIds: [] });
    const res = await request(app).post(`/api/engines/instances/${instId}/launch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('model config');
    await request(app).put(`/api/engines/instances/${instId}`).send({ routerMode: false });
  });

  it('POST /api/engines/instances/:id/stop stops the instance', async () => {
    const res = await request(app).post(`/api/engines/instances/${instId}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');
  });

  it('unknown instance ids return 404', async () => {
    expect((await request(app).put('/api/engines/instances/nope').send({})).status).toBe(404);
    expect((await request(app).post('/api/engines/instances/nope/launch')).status).toBe(404);
    expect((await request(app).post('/api/engines/instances/nope/stop')).status).toBe(404);
    expect((await request(app).delete('/api/engines/instances/nope')).status).toBe(404);
  });

  it('DELETE /api/engines/instances/:id removes it and re-points the default', async () => {
    const res = await request(app).delete(`/api/engines/instances/${instId}`);
    expect(res.status).toBe(200);

    const after = await request(app).get('/api/engines');
    expect(after.body.instances.some((i: any) => i.id === instId)).toBe(false);
    expect(after.body.defaultInstanceId).not.toBe(instId);

    const del = await request(app).delete(`/api/engines/definitions/${defId}`);
    expect(del.status).toBe(200);
  });
});
