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

// The process layer is generic (engines/worker.ts) and spawns real processes —
// replace it with a stub so launches never touch the filesystem or a binary.
vi.mock('../engines/worker.js', () => {
  class ProcessWorker {
    onLogLine: any = null;
    onStatusChange: any = null;
    onMetrics: any = null;
    private status = 'stopped';
    constructor(_driver: unknown) {}
    getDriver() { return {}; }
    getStatus() { return this.status; }
    getMetrics() { return { prefillTokensPerSec: null, generationTokensPerSec: null, lastUpdated: 0 }; }
    launch() {}
    stop() { this.status = 'stopped'; }
  }
  return { ProcessWorker };
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

  it('GET /api/engines/definitions/:id/version probes the saved build folder', async () => {
    // The llama.js mock reports no version, so the path is considered invalid
    const res = await request(app).get(`/api/engines/definitions/${defId}/version`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('llamacpp');
    expect(res.body.valid).toBe(false);
  });

  it('GET /api/engines/definitions/:id/version 404s for an unknown definition', async () => {
    const res = await request(app).get('/api/engines/definitions/nope/version');
    expect(res.status).toBe(404);
  });

  it('GET /api/engines/definitions/:id/version reports missing buildPath', async () => {
    const created = await request(app)
      .post('/api/engines/definitions')
      .send({ name: 'No Path', kind: 'llamacpp' });
    const res = await request(app).get(`/api/engines/definitions/${created.body.id}/version`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toContain('buildPath');
    await request(app).delete(`/api/engines/definitions/${created.body.id}`);
  });

  it('non-llamacpp definitions validate by folder existence (no probe yet)', async () => {
    const created = await request(app)
      .post('/api/engines/definitions')
      .send({ name: 'SD Build', kind: 'sdiffusion', buildPath: tmpDir });
    expect(created.status).toBe(200);
    const ok = await request(app).get(`/api/engines/definitions/${created.body.id}/version`);
    expect(ok.status).toBe(200);
    expect(ok.body.kind).toBe('sdiffusion');
    expect(ok.body.valid).toBe(true);

    const missing = await request(app)
      .post('/api/engines/definitions')
      .send({ name: 'SD Missing', kind: 'sdiffusion', buildPath: '/nonexistent/sd/build' });
    const bad = await request(app).get(`/api/engines/definitions/${missing.body.id}/version`);
    expect(bad.body.valid).toBe(false);

    await request(app).delete(`/api/engines/definitions/${created.body.id}`);
    await request(app).delete(`/api/engines/definitions/${missing.body.id}`);
  });

  it('GET /api/engines/templates/:kind returns the seeded llamacpp template', async () => {
    const res = await request(app).get('/api/engines/templates/llamacpp');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('llamacpp');
    expect(res.body.params).toEqual(expect.arrayContaining([{ key: '--port', value: '8080' }]));
  });

  it('PUT /api/engines/templates/:kind persists and round-trips', async () => {
    const res = await request(app)
      .put('/api/engines/templates/custom')
      .send({ params: [{ key: '--serve' }, { key: '--port', value: '9000' }, { key: '  ' }] });
    expect(res.status).toBe(200);
    expect(res.body.params).toEqual([{ key: '--serve' }, { key: '--port', value: '9000' }]);
    const get = await request(app).get('/api/engines/templates/custom');
    expect(get.body.params).toEqual([{ key: '--serve' }, { key: '--port', value: '9000' }]);
  });

  it('POST /api/engines/instances seeds params from the kind template', async () => {
    const res = await request(app)
      .post('/api/engines/instances')
      .send({ name: 'My Engine', definitionId: defId });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('my-engine');
    expect(res.body.definitionId).toBe(defId);
    // The llamacpp template seeds --host/--port/--api-key as ordinary params
    expect(res.body.params).toEqual(expect.arrayContaining([
      { key: '--host', value: '127.0.0.1' },
      { key: '--port', value: '8081' },
    ]));
    // The legacy default instance already holds :8080, so the new one is free
    const portParam = res.body.params.find((p: any) => p.key === '--port');
    expect(portParam.value).not.toBe('8080');
    instId = res.body.id;
  });

  it('POST /api/engines/instances nudges a clashing template port to a free one', async () => {
    // Force the template --port onto the default instance's port: creation
    // must shift to the next free port instead of failing.
    const putT = await request(app)
      .put('/api/engines/templates/llamacpp')
      .send({ params: [{ key: '--host', value: '127.0.0.1' }, { key: '--port', value: '8080' }] });
    expect(putT.status).toBe(200);
    const res = await request(app)
      .post('/api/engines/instances')
      .send({ name: 'Nudged', definitionId: defId });
    expect(res.status).toBe(200);
    const port = res.body.params.find((p: any) => p.key === '--port').value;
    expect(port).not.toBe('8080');
    expect(Number(port)).toBeGreaterThan(8080);
    await request(app).delete(`/api/engines/instances/${res.body.id}`);
    // Restore the default template for later tests
    await request(app).put('/api/engines/templates/llamacpp').send({ params: [] });
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

    const clash = await request(app)
      .put(`/api/engines/instances/${instId}`)
      .send({ params: [{ key: '--port', value: '8080' }] });
    expect(clash.status).toBe(409);
  });

  it('PUT /api/engines/instances/:id round-trips notes', async () => {
    const res = await request(app)
      .put(`/api/engines/instances/${instId}`)
      .send({ notes: 'runs on the 3050' });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('runs on the 3050');
  });

  it('POST /api/engines/command composes the launch command from a draft', async () => {
    const res = await request(app)
      .post('/api/engines/command')
      .send({
        definitionId: defId,
        kind: 'llamacpp',
        executable: '/opt/llama/build/bin/llama-server',
        envVars: { CUDA_VISIBLE_DEVICES: '1' },
        params: [{ key: '--port', value: '9090' }, { key: '--metrics' }, { key: '--seed', value: '-1' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.binaryPath).toBe('/opt/llama/build/bin/llama-server');
    expect(res.body.cwd).toBe('/opt/llama/build/bin');
    expect(res.body.envVars).toEqual({ CUDA_VISIBLE_DEVICES: '1' });
    expect(res.body.exists).toBe(false);
    expect(res.body.args).toEqual(expect.arrayContaining(['--port', '9090', '--metrics', '--seed', '-1']));
  });

  it('POST /api/engines/command requires an executable', async () => {
    const res = await request(app).post('/api/engines/command').send({ kind: 'llamacpp', params: [] });
    expect(res.status).toBe(400);
  });

  it('disabled param rows round-trip and stay out of the composed command', async () => {
    const put = await request(app)
      .put(`/api/engines/instances/${instId}`)
      .send({ params: [{ key: '--metrics', disabled: true }, { key: '--port', value: '9090' }] });
    expect(put.status).toBe(200);
    expect(put.body.params).toEqual([
      { key: '--metrics', disabled: true },
      { key: '--port', value: '9090' },
    ]);

    const cmd = await request(app)
      .post('/api/engines/command')
      .send({
        definitionId: defId,
        kind: 'llamacpp',
        executable: '/opt/llama/build/bin/llama-server',
        params: put.body.params,
      });
    expect(cmd.status).toBe(200);
    expect(cmd.body.args).not.toContain('--metrics');
    expect(cmd.body.args).toEqual(expect.arrayContaining(['--port', '9090']));
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

describe('Strata Engine API', () => {
  let strataId: string;

  it('GET /api/params/strata-server returns the serve/server.py catalog', async () => {
    const res = await request(app).get('/api/params/strata-server');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'port', flag: '--port' }),
      expect.objectContaining({ key: 'host', flag: '--host' }),
    ]));
  });

  it('GET /api/engines/instances/draft?kind=strata seeds a strata block without saving', async () => {
    const before = (await request(app).get('/api/engines')).body.instances.length;
    const res = await request(app).get('/api/engines/instances/draft?kind=strata');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('strata');
    // Self-contained: a strata draft has no definition link.
    expect(res.body.definitionId).toBe('');
    expect(res.body.strata).toBeTruthy();
    expect(res.body.strata.serverArgs).toEqual(expect.arrayContaining([
      { key: '--host', value: '127.0.0.1' },
    ]));
    const after = (await request(app).get('/api/engines')).body.instances.length;
    expect(after).toBe(before);
  });

  it('POST /api/engines/strata/import maps a strata-<model>.json into the editable block', async () => {
    const file = {
      exe: '/home/u/Strata/engine/strata',
      args: ['--pack', '/p/iq3_s', '--ctx', '262144', '--metrics'],
      cwd: '/home/u/Strata',
      tokenizer: '/home/u/tok',
      model_name: 'qwen3.8',
      port: 5456,
      gpu: [1, 2, 3],
      gpus_asked: 3,
      vision: { exe: '/home/u/Strata/engine/strata-vision', mmproj: '/m.gguf', model: '/m.gguf', gpu: true, max_tokens: 1024 },
    };
    const res = await request(app).post('/api/engines/strata/import').send({ json: JSON.stringify(file) });
    expect(res.status).toBe(200);
    const s = res.body.strata;
    expect(s.exe).toBe('/home/u/Strata/engine/strata');
    expect(s.modelName).toBe('qwen3.8');
    expect(s.engineArgs).toEqual([
      { key: '--pack', value: '/p/iq3_s' },
      { key: '--ctx', value: '262144' },
      { key: '--metrics' },
    ]);
    // port becomes a --port server row; gpu is a server option; gpus_asked rides in extra.
    expect(s.serverArgs).toEqual(expect.arrayContaining([
      { key: '--port', value: '5456' },
      { key: '--gpu', value: '1,2,3' },
    ]));
    expect(s.extra).toEqual({ gpus_asked: 3 });
    expect(s.vision?.maxTokens).toBe(1024);
  });

  it('POST /api/engines/strata/import rejects invalid JSON and non-objects', async () => {
    expect((await request(app).post('/api/engines/strata/import').send({ json: '{' })).status).toBe(400);
    expect((await request(app).post('/api/engines/strata/import').send({ json: '[1,2]' })).status).toBe(400);
  });

  it('POST /api/engines/instances accepts kind=strata without a definitionId', async () => {
    const res = await request(app)
      .post('/api/engines/instances')
      .send({ name: 'Strata Qwen', kind: 'strata' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('strata');
    expect(res.body.definitionId).toBe('');
    expect(res.body.autoLaunch).toBe(false);
    // The blank strata block seeds --host/--port and the python binary.
    expect(res.body.binary).toBe('python3');
    const port = res.body.strata.serverArgs.find((p: any) => p.key === '--port').value;
    expect(Number(port)).toBeGreaterThanOrEqual(8095);
    strataId = res.body.id;
  });

  it('PUT /api/engines/instances/:id round-trips the strata block and autoLaunch', async () => {
    const block = {
      exe: '/home/u/Strata/engine/strata',
      cwd: '/home/u/Strata',
      tokenizer: '/home/u/tok',
      modelName: 'qwen3.8',
      engineArgs: [{ key: '--ctx', value: '262144' }],
      serverArgs: [{ key: '--host', value: '0.0.0.0' }, { key: '--port', value: '8123' }],
      vision: null,
      extra: { gpus_asked: 3 },
    };
    const res = await request(app)
      .put(`/api/engines/instances/${strataId}`)
      .send({ strata: block, autoLaunch: true });
    expect(res.status).toBe(200);
    expect(res.body.autoLaunch).toBe(true);
    expect(res.body.strata).toEqual(block);

    // The strata --port participates in the port conflict check like a param.
    const clash = await request(app)
      .put(`/api/engines/instances/${strataId}`)
      .send({ strata: { ...block, serverArgs: [{ key: '--port', value: '8080' }] } });
    expect(clash.status).toBe(409);
  });

  it('GET /api/engines/instances/:id/strata/export renders the file shape', async () => {
    const res = await request(app).get(`/api/engines/instances/${strataId}/strata/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(`strata-${strataId}.json`);
    expect(res.body).toMatchObject({
      exe: '/home/u/Strata/engine/strata',
      cwd: '/home/u/Strata',
      model_name: 'qwen3.8',
      args: ['--ctx', '262144'],
      host: '0.0.0.0',
      port: 8123,
      gpus_asked: 3,
    });
  });

  it('export 400s for an instance without a strata block', async () => {
    const res = await request(app).get('/api/engines/instances/default/strata/export');
    expect(res.status).toBe(400);
  });

  it('POST /api/engines/strata/render round-trips a draft block losslessly', async () => {
    const imported = await request(app)
      .post('/api/engines/strata/import')
      .send({ json: JSON.stringify({ exe: '/e', cwd: '/c', port: 5456, gpu: [1, 2], layer_split: [10, 8] }) });
    const res = await request(app).post('/api/engines/strata/render').send(imported.body.strata);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      exe: '/e',
      cwd: '/c',
      args: [],
      port: 5456,
      gpu: [1, 2],
      layer_split: [10, 8],
    });
  });

  it('POST /api/engines/command previews the python -m serve.server spawn plan', async () => {
    const res = await request(app)
      .post('/api/engines/command')
      .send({
        kind: 'strata',
        instanceId: strataId,
        executable: '/usr/bin/python3',
        strata: { cwd: '/home/u/Strata', serverArgs: [{ key: '--port', value: '8123' }] },
      });
    expect(res.status).toBe(200);
    // A strata preview keeps the interpreter path verbatim — there is no
    // build-folder/binary split for a kind with its own spawn plan.
    expect(res.body.binaryPath).toBe('/usr/bin/python3');
    expect(res.body.cwd).toBe('/home/u/Strata');
    expect(res.body.args).toEqual([
      '-m', 'serve.server', '--engine', 'strata',
      '--config', expect.stringContaining(`strata-${strataId}.json`),
      '--port', '8123',
    ]);
  });

  it('launching a strata instance writes the generated config file', async () => {
    const res = await request(app).post(`/api/engines/instances/${strataId}/launch`);
    expect(res.status).toBe(200);
    expect(res.body.routerIniPath).toBeNull();
    const generated = res.body.strataConfigPath;
    expect(generated).toContain(`strata-${strataId}.json`);
    const written = JSON.parse(fs.readFileSync(generated, 'utf-8'));
    expect(written).toMatchObject({
      exe: '/home/u/Strata/engine/strata',
      model_name: 'qwen3.8',
      port: 8123,
      gpus_asked: 3,
    });
    await request(app).post(`/api/engines/instances/${strataId}/stop`);
  });

  it('launch rejects a strata instance without a repo folder', async () => {
    const get = await request(app).get('/api/engines');
    const inst = get.body.instances.find((i: any) => i.id === strataId);
    await request(app)
      .put(`/api/engines/instances/${strataId}`)
      .send({ strata: { ...inst.strata, cwd: '' } });
    const res = await request(app).post(`/api/engines/instances/${strataId}/launch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('repo folder');
  });

  it('deletes the strata instance', async () => {
    const res = await request(app).delete(`/api/engines/instances/${strataId}`);
    expect(res.status).toBe(200);
  });
});
