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
    // Mirrors the real worker: status changes are pushed to the manager through
    // onStatusChange, which is what engines.getStatus() reports.
    launch() { this.setStatus('starting'); }
    stop() { this.setStatus('stopped'); }
    private setStatus(status: string) {
      this.status = status;
      this.onStatusChange?.(status);
    }
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
import path from 'path';

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

  it('POST /api/engines/command previews router mode with --models-preset', async () => {
    const res = await request(app)
      .post('/api/engines/command')
      .send({
        definitionId: defId,
        kind: 'llamacpp',
        executable: '/opt/llama/build/bin/llama-server',
        params: [{ key: '--port', value: '9090' }],
        instanceId: instId,
        routerMode: true,
        modelConfigIds: ['cfg-x'],
      });
    expect(res.status).toBe(200);
    // The preview names the same generated INI a real launch writes, and drops
    // the single-model -m argument.
    expect(res.body.args).toEqual(expect.arrayContaining([
      '--models-preset',
      expect.stringContaining(`router-${instId}.ini`),
    ]));
    expect(res.body.args).not.toContain('-m');
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

  it('launching a router-mode instance writes its own INI from the selected models', async () => {
    const models = await request(app).get('/api/models');
    const cfg = models.body.configs[0];
    const put = await request(app)
      .put(`/api/engines/instances/${instId}`)
      .send({ routerMode: true, modelConfigIds: [cfg.id] });
    expect(put.status).toBe(200);
    expect(put.body.routerMode).toBe(true);
    expect(put.body.modelConfigIds).toEqual([cfg.id]);

    const res = await request(app).post(`/api/engines/instances/${instId}/launch`);
    expect(res.status).toBe(200);
    expect(res.body.routerIniPath).toContain(`router-${instId}.ini`);
    const ini = fs.readFileSync(res.body.routerIniPath, 'utf-8');
    expect(ini).toContain(`[${cfg.alias}]`);

    await request(app).put(`/api/engines/instances/${instId}`).send({ routerMode: false, modelConfigIds: [] });
  });

  it('POST /api/engines/instances/:id/stop stops the instance', async () => {
    const res = await request(app).post(`/api/engines/instances/${instId}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');
  });

  it('renaming an instance re-keys its id so generated files follow', async () => {
    // The id is the slug of the name and the launch files are named from it
    // (router-<id>.ini), so an old name must not keep pointing at an old file.
    const oldId = instId;
    const iniPath = path.join(tmpDir, '.config', `router-${oldId}.ini`);
    fs.writeFileSync(iniPath, '[stale]\n');

    const res = await request(app).put(`/api/engines/instances/${oldId}`).send({ name: 'Renamed Engine' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('renamed-engine');

    const after = await request(app).get('/api/engines');
    expect(after.body.instances.some((i: any) => i.id === oldId)).toBe(false);
    expect(after.body.instances.some((i: any) => i.id === 'renamed-engine')).toBe(true);
    // The stale INI from the old id is gone, and the old id no longer resolves.
    expect(fs.existsSync(iniPath)).toBe(false);
    expect((await request(app).put(`/api/engines/instances/${oldId}`).send({})).status).toBe(404);

    instId = 'renamed-engine';
  });

  it('renaming the default instance re-points defaultInstanceId', async () => {
    const before = await request(app).get('/api/engines');
    expect(before.body.defaultInstanceId).toBe('default');

    const res = await request(app).put('/api/engines/instances/default').send({ name: 'Main Build' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('main-build');

    const after = await request(app).get('/api/engines');
    expect(after.body.defaultInstanceId).toBe('main-build');

    // Put it back so later tests keep the legacy id.
    const back = await request(app).put('/api/engines/instances/main-build').send({ name: 'default' });
    expect(back.body.id).toBe('default');
    expect((await request(app).get('/api/engines')).body.defaultInstanceId).toBe('default');
  });

  it('renaming only re-keys when the slug actually changes', async () => {
    // Whitespace/case tweaks keep the id, so no files are rewritten.
    const res = await request(app).put(`/api/engines/instances/${instId}`).send({ name: 'Renamed Engine ' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(instId);
  });

  it('PUT rename is rejected while the engine is running', async () => {
    const launch = await request(app).post(`/api/engines/instances/${instId}/launch`);
    expect(launch.status).toBe(200);

    const res = await request(app).put(`/api/engines/instances/${instId}`).send({ name: 'Moved While Running' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stop this engine');

    // The instance keeps its original id/name until it is stopped.
    const after = await request(app).get('/api/engines');
    const inst = after.body.instances.find((i: any) => i.id === instId);
    expect(inst.name).toBe('Renamed Engine');

    await request(app).post(`/api/engines/instances/${instId}/stop`);
    const ok = await request(app).put(`/api/engines/instances/${instId}`).send({ name: 'Stopped Rename' });
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe('stopped-rename');
    instId = 'stopped-rename';
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

  it('GET /api/params/strata-vision returns the vision encoder catalog', async () => {
    const res = await request(app).get('/api/params/strata-vision');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Vision options are config keys, so flag === key (no leading dashes).
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'exe', flag: 'exe', category: 'encoder' }),
      expect.objectContaining({ key: 'max_tokens', flag: 'max_tokens' }),
      expect.objectContaining({ key: 'elastic', inputType: 'toggle' }),
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
    expect(s.engineArgs).toEqual([
      { key: '--pack', value: '/p/iq3_s' },
      { key: '--ctx', value: '262144' },
      { key: '--metrics' },
    ]);
    // The deployment keys, port and gpu are all ordinary server rows now.
    expect(s.serverArgs).toEqual(expect.arrayContaining([
      { key: 'exe', value: '/home/u/Strata/engine/strata' },
      { key: 'cwd', value: '/home/u/Strata' },
      { key: 'tokenizer', value: '/home/u/tok' },
      { key: 'model_name', value: 'qwen3.8' },
      { key: '--port', value: '5456' },
      { key: '--gpu', value: '1,2,3' },
    ]));
    expect(s.extra).toEqual({ gpus_asked: 3 });
    // The vision section becomes editable rows, one per config key.
    expect(s.vision?.args).toEqual(expect.arrayContaining([
      { key: 'mmproj', value: '/m.gguf' },
      { key: 'max_tokens', value: '1024' },
    ]));
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
      engineArgs: [{ key: '--ctx', value: '262144' }],
      serverArgs: [
        { key: 'exe', value: '/home/u/Strata/engine/strata' },
        { key: 'cwd', value: '/home/u/Strata' },
        { key: 'tokenizer', value: '/home/u/tok' },
        { key: 'model_name', value: 'qwen3.8' },
        { key: '--host', value: '0.0.0.0' },
        { key: '--port', value: '8123' },
      ],
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
        strata: { serverArgs: [{ key: 'cwd', value: '/home/u/Strata' }, { key: '--port', value: '8123' }] },
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
      .send({ strata: { ...inst.strata, serverArgs: inst.strata.serverArgs.filter((p: any) => p.key !== 'cwd') } });
    const res = await request(app).post(`/api/engines/instances/${strataId}/launch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('repo folder');
  });

  it('deletes the strata instance', async () => {
    const res = await request(app).delete(`/api/engines/instances/${strataId}`);
    expect(res.status).toBe(200);
  });
});

describe('Audio Engine API', () => {
  let audioId: string;
  let audioModelIds: string[] = [];

  it('GET /api/params/audio-server returns the audiocpp_server catalog', async () => {
    const res = await request(app).get('/api/params/audio-server');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Audio server options are config keys, so flag === key (no leading dashes).
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'host', flag: 'host', category: 'network' }),
      expect.objectContaining({ key: 'port', flag: 'port' }),
      expect.objectContaining({ key: 'backend', inputType: 'select' }),
      expect.objectContaining({ key: 'lazy_load', inputType: 'toggle' }),
    ]));
  });

  it('GET /api/params/audio-model returns the model-key catalog', async () => {
    const res = await request(app).get('/api/params/audio-model');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'family', flag: 'family', category: 'identity' }),
      expect.objectContaining({ key: 'task', inputType: 'select' }),
      expect.objectContaining({ key: 'mode', inputType: 'select' }),
    ]));
  });

  it('GET /api/engines/instances/draft?kind=audio seeds an audio block without saving', async () => {
    const before = (await request(app).get('/api/engines')).body.instances.length;
    const res = await request(app).get('/api/engines/instances/draft?kind=audio');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('audio');
    // Self-contained: an audio draft has no definition link.
    expect(res.body.definitionId).toBe('');
    expect(res.body.binary).toBe('audiocpp_server');
    expect(res.body.audio).toBeTruthy();
    expect(res.body.audio.serverArgs).toEqual(expect.arrayContaining([
      { key: 'host', value: '127.0.0.1' },
      { key: 'backend', value: 'cuda' },
    ]));
    const after = (await request(app).get('/api/engines')).body.instances.length;
    expect(after).toBe(before);
  });

  it('POST /api/engines/audio/import creates a model card per models[] entry', async () => {
    const file = {
      host: '0.0.0.0',
      port: 5455,
      backend: 'cuda',
      device: 0,
      threads: 8,
      lazy_load: true,
      cors_origins: '*',
      models: [
        {
          id: 'breeze_tts_2',
          family: 'breeze_tts',
          path: 'models/Breeze-TTS-2/breeze.gguf',
          task: ['tts', 'clon', 'vdes'],
          mode: 'streaming',
          default_request_options: { instruction: 'radio host' },
        },
        { id: 'qwen3-asr', family: 'qwen3_asr', path: 'models/Qwen3-ASR/qwen.gguf', task: 'asr', mode: 'streaming' },
      ],
    };
    const res = await request(app).post('/api/engines/audio/import').send({ json: JSON.stringify(file) });
    expect(res.status).toBe(200);
    const a = res.body.audio;
    expect(a.serverArgs).toEqual(expect.arrayContaining([
      { key: 'host', value: '0.0.0.0' },
      { key: 'port', value: '5455' },
      { key: 'backend', value: 'cuda' },
      { key: 'cors_origins', value: '*' },
    ]));
    expect(res.body.models).toHaveLength(2);
    audioModelIds = res.body.models.map((m: any) => m.id);
    // The created cards carry type: 'audio' and the task array survives in extras.
    const cards = (await request(app).get('/api/models')).body.configs.filter((c: any) => audioModelIds.includes(c.id));
    expect(cards.every((c: any) => c.type === 'audio')).toBe(true);
    const breeze = cards.find((c: any) => c.alias === 'breeze_tts_2');
    expect(breeze.audioExtras?.task).toEqual(['tts', 'clon', 'vdes']);
    expect(breeze.params['default_request_options.instruction']).toBe('radio host');
  });

  it('POST /api/engines/audio/import skips a card whose alias already exists', async () => {
    const file = { models: [{ id: 'qwen3-asr', family: 'qwen3_asr', path: '/x.gguf' }] };
    const res = await request(app).post('/api/engines/audio/import').send({ json: JSON.stringify(file) });
    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(0);
    expect(res.body.skipped).toBe(1);
  });

  it('POST /api/engines/audio/import rejects invalid JSON and non-objects', async () => {
    expect((await request(app).post('/api/engines/audio/import').send({ json: '{' })).status).toBe(400);
    expect((await request(app).post('/api/engines/audio/import').send({ json: '[1,2]' })).status).toBe(400);
  });

  it('POST /api/engines/instances accepts kind=audio without a definitionId', async () => {
    const res = await request(app)
      .post('/api/engines/instances')
      .send({ name: 'Audio TTS', kind: 'audio' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('audio');
    expect(res.body.definitionId).toBe('');
    expect(res.body.binary).toBe('audiocpp_server');
    const port = res.body.audio.serverArgs.find((p: any) => p.key === 'port').value;
    expect(Number(port)).toBeGreaterThanOrEqual(8080);
    audioId = res.body.id;
  });

  it('PUT /api/engines/instances/:id round-trips the audio block and port conflict', async () => {
    const block = {
      envVars: { CUDA_VISIBLE_DEVICES: '0' },
      serverArgs: [
        { key: 'host', value: '0.0.0.0' },
        { key: 'port', value: '8130' },
        { key: 'backend', value: 'cuda' },
        { key: 'threads', value: '8' },
        { key: 'lazy_load' },
      ],
      modelConfigIds: audioModelIds,
      extra: { live_ingest: { idle_timeout_ms: 5000 } },
    };
    const res = await request(app)
      .put(`/api/engines/instances/${audioId}`)
      .send({ binary: '/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server', audio: block, autoLaunch: true });
    expect(res.status).toBe(200);
    expect(res.body.autoLaunch).toBe(true);
    expect(res.body.audio).toEqual(block);

    // The audio port participates in the port conflict check like a param.
    const clash = await request(app)
      .put(`/api/engines/instances/${audioId}`)
      .send({ audio: { ...block, serverArgs: [{ key: 'port', value: '8080' }] } });
    expect(clash.status).toBe(409);
  });

  it('GET /api/engines/instances/:id/audio/export renders the file shape with absolute paths', async () => {
    const res = await request(app).get(`/api/engines/instances/${audioId}/audio/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(`audio-${audioId}.json`);
    expect(res.body).toMatchObject({ host: '0.0.0.0', port: 8130, backend: 'cuda', live_ingest: { idle_timeout_ms: 5000 } });
    const models = res.body.models as Record<string, unknown>[];
    expect(models).toHaveLength(2);
    // Relative model paths become absolute against the executable's folder.
    expect(models[0].path).toBe('/home/u/Programs/AI/audio.cpp/build/bin/models/Breeze-TTS-2/breeze.gguf');
    expect(models[0].task).toEqual(['tts', 'clon', 'vdes']);
  });

  it('audio export 400s for an instance without an audio block', async () => {
    const res = await request(app).get('/api/engines/instances/default/audio/export');
    expect(res.status).toBe(400);
  });

  it('POST /api/engines/audio/render round-trips a draft block', async () => {
    const res = await request(app)
      .post('/api/engines/audio/render')
      .send({
        audio: { serverArgs: [{ key: 'port', value: '9000' }], modelConfigIds: [], extra: { ui: false } },
        modelConfigIds: [],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ui: false, port: 9000, models: [] });
  });

  it('POST /api/engines/command previews the audiocpp_server --config spawn plan', async () => {
    const res = await request(app)
      .post('/api/engines/command')
      .send({
        kind: 'audio',
        instanceId: audioId,
        executable: '/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server',
        audio: { envVars: { CUDA_VISIBLE_DEVICES: '0' }, serverArgs: [{ key: 'port', value: '8130' }] },
      });
    expect(res.status).toBe(200);
    // The full-path binary is the command; cwd is the executable's folder.
    expect(res.body.binaryPath).toBe('/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server');
    expect(res.body.cwd).toBe('/home/u/Programs/AI/audio.cpp/build/bin');
    // The audio block's env vars reach the spawn environment (no definition to carry them).
    expect(res.body.envVars).toEqual({ CUDA_VISIBLE_DEVICES: '0' });
    expect(res.body.args).toEqual(['--config', expect.stringContaining(`audio-${audioId}.json`)]);
  });

  it('launching an audio instance writes the generated config file', async () => {
    const res = await request(app).post(`/api/engines/instances/${audioId}/launch`);
    expect(res.status).toBe(200);
    expect(res.body.routerIniPath).toBeNull();
    const generated = res.body.audioConfigPath;
    expect(generated).toContain(`audio-${audioId}.json`);
    const written = JSON.parse(fs.readFileSync(generated, 'utf-8'));
    expect(written).toMatchObject({ host: '0.0.0.0', port: 8130, backend: 'cuda' });
    expect((written.models as any[]).map((m) => m.id).sort()).toEqual(['breeze_tts_2', 'qwen3-asr']);
    await request(app).post(`/api/engines/instances/${audioId}/stop`);
  });

  it('mirrors the audio instance into the proxy backends with its model ids', async () => {
    const get = await request(app).get('/api/proxy/settings');
    const mirror = get.body.backends.find((b: any) => b.engineId === audioId);
    expect(mirror).toBeTruthy();
    expect(mirror.kind).toBe('audio');
    expect(mirror.name).toBe('Audio TTS');
    expect(mirror.baseUrl).toBe('http://127.0.0.1:8130');
    // The selected cards' aliases are the upstream ids the launched server
    // reports, so they become auto routes without a manual Refresh.
    expect(mirror.models).toEqual(['breeze_tts_2', 'qwen3-asr']);

    const status = await request(app).get('/api/proxy/status');
    const route = status.body.models.find((m: any) => m.model === 'breeze_tts_2');
    expect(route.backend).toBe(mirror.id);
  });

  it('launch with parallelJobs adds --parallel-jobs and keeps slots in the file', async () => {
    const get = await request(app).get('/api/engines');
    const inst = get.body.instances.find((i: any) => i.id === audioId);
    // A slots row on a selected card is only emitted once the flag is on —
    // upstream rejects the combination ("slots requires --parallel-jobs").
    await request(app)
      .put(`/api/models/configs/${audioModelIds[0]}`)
      .send({ params: { task: 'tts', slots: '3' } });
    const saved = await request(app)
      .put(`/api/engines/instances/${audioId}`)
      .send({ audio: { ...inst.audio, parallelJobs: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.audio.parallelJobs).toBe(true);

    const preview = await request(app)
      .post('/api/engines/command')
      .send({
        kind: 'audio',
        instanceId: audioId,
        executable: '/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server',
        audio: { ...inst.audio, parallelJobs: true },
      });
    expect(preview.body.args).toEqual([
      '--config', expect.stringContaining(`audio-${audioId}.json`),
      '--parallel-jobs',
    ]);

    const res = await request(app).post(`/api/engines/instances/${audioId}/launch`);
    expect(res.status).toBe(200);
    const written = JSON.parse(fs.readFileSync(res.body.audioConfigPath, 'utf-8'));
    const breeze = (written.models as any[]).find((m) => m.id === 'breeze_tts_2');
    expect(breeze.slots).toBe(3);
    await request(app).post(`/api/engines/instances/${audioId}/stop`);

    // Flag off again: the same card loses its slots row instead of producing a
    // file the server refuses to parse.
    await request(app)
      .put(`/api/engines/instances/${audioId}`)
      .send({ audio: { ...inst.audio, parallelJobs: false } });
    const off = await request(app).post(`/api/engines/instances/${audioId}/launch`);
    expect(off.status).toBe(200);
    const writtenOff = JSON.parse(fs.readFileSync(off.body.audioConfigPath, 'utf-8'));
    expect((writtenOff.models as any[]).find((m) => m.id === 'breeze_tts_2').slots).toBeUndefined();
    await request(app).post(`/api/engines/instances/${audioId}/stop`);
  });

  it('launch rejects an audio instance whose binary is a bare name', async () => {
    const get = await request(app).get('/api/engines');
    const inst = get.body.instances.find((i: any) => i.id === audioId);
    await request(app)
      .put(`/api/engines/instances/${audioId}`)
      .send({ binary: 'audiocpp_server' });
    const res = await request(app).post(`/api/engines/instances/${audioId}/launch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('full path');
  });

  it('launch rejects an audio instance with no selected models', async () => {
    const get = await request(app).get('/api/engines');
    const inst = get.body.instances.find((i: any) => i.id === audioId);
    await request(app)
      .put(`/api/engines/instances/${audioId}`)
      .send({ binary: '/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server', audio: { ...inst.audio, modelConfigIds: [] } });
    const res = await request(app).post(`/api/engines/instances/${audioId}/launch`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('model');
  });

  it('deletes the audio instance', async () => {
    const res = await request(app).delete(`/api/engines/instances/${audioId}`);
    expect(res.status).toBe(200);
    // The proxy mirror follows the instance out.
    const get = await request(app).get('/api/proxy/settings');
    expect(get.body.backends.some((b: any) => b.engineId === audioId)).toBe(false);
  });
});
