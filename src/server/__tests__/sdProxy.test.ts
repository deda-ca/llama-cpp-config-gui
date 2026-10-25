/**
 * stable-diffusion.cpp model-management proxy (docs/stable-diffusion.md §3.10).
 *
 * The sdcpp endpoints are exercised against a **real** local stub server rather
 * than a mocked `fetch`: the whole point of this layer is that file-ids come
 * from a live server, and the shapes below are the exact JSON
 * `examples/server/routes_models.cpp` emits (captured 2026-10-25).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { ModelConfig } from '../modelConfig.js';
import type { EngineInstance } from '../engines/types.js';
import {
  sdBaseUrl,
  sdCardRecipeId,
  sdInitialLoad,
  sdLoadCard,
  sdModelFiles,
  sdModelStatus,
  sdRequest,
  sdUnloadModel,
  sdUpstreamError,
  sdWaitUntilReady,
} from '../engines/sdProxy.js';

/**
 * A stub sd-server. Routes are registered per test; an unhandled path answers
 * 404 so a typo in a proxied path fails loudly instead of hanging.
 */
class StubSdServer {
  readonly server: http.Server;
  private routes = new Map<string, (body: unknown, req: http.IncomingMessage) => { status: number; body: unknown }>();
  /** Every request seen, as `METHOD path` — to assert a retry actually happened. */
  readonly calls: string[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      this.calls.push(key);
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const handler = this.routes.get(key);
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no stub route for ' + key }));
          return;
        }
        const body = raw ? JSON.parse(raw) : undefined;
        const out = handler(body, req);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
      });
    });
  }

  on(method: string, apiPath: string, handler: (body: unknown, req: http.IncomingMessage) => { status: number; body: unknown }): void {
    this.routes.set(`${method} ${apiPath}`, handler);
  }

  reset(): void {
    this.routes.clear();
    this.calls.length = 0;
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const READY = { state: 'ready', recipe: 'flux1-dev', models: {}, error: null, revision: 2, load_elapsed_seconds: 1.5 };
const EMPTY = { state: 'empty', recipe: null, models: {}, error: null, revision: 1, load_elapsed_seconds: null };

const FILES = [
  { id: 'diffusion_models/flux1-dev.gguf', name: 'flux1-dev', category: 'diffusion_models', root: '', relative_path: 'flux1-dev.gguf' },
  { id: 'text_encoders/clip_l.safetensors', name: 'clip_l', category: 'text_encoders', root: '', relative_path: 'clip_l.safetensors' },
  { id: 'vae/ae.safetensors', name: 'ae', category: 'vae', root: '', relative_path: 'ae.safetensors' },
];

function card(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'flux1-dev',
    alias: 'flux1-dev',
    displayName: 'FLUX.1 dev',
    notes: '',
    modelPath: '/models/sd/flux/diffusion_models/flux1-dev.gguf',
    params: {
      '--diffusion-model': '/models/sd/flux/diffusion_models/flux1-dev.gguf',
      '--clip_l': '/models/sd/flux/text_encoders/clip_l.safetensors',
      '--vae': '/models/sd/flux/vae/ae.safetensors',
    },
    paramOrder: ['--diffusion-model', '--clip_l', '--vae'],
    type: 'sdiffusion',
    sdExtras: { recipe: 'flux1-dev' },
    isDefault: false,
    ...over,
  };
}

function sdInstance(port: number, over: Partial<EngineInstance> = {}): EngineInstance {
  return {
    id: 'sd-test',
    name: 'SD Test',
    notes: '',
    kind: 'sdiffusion',
    definitionId: '',
    binary: '/home/u/Programs/AI/stable-diffusion.cpp/build/bin/sd-server',
    params: [],
    routerMode: false,
    modelConfigIds: [],
    autoLaunch: false,
    sd: {
      envVars: {},
      serverArgs: [
        { key: '--listen-ip', value: '127.0.0.1' },
        { key: '--listen-port', value: String(port) },
        { key: '--model-dir', value: '/models/sd/flux' },
      ],
      modelConfigIds: ['flux1-dev'],
      extra: {},
    },
    ...over,
  };
}

let stub: StubSdServer;
let port: number;
let baseUrl: string;

beforeAll(async () => {
  stub = new StubSdServer();
  port = await stub.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await stub.close();
});

describe('sdBaseUrl', () => {
  it('builds the address from --listen-ip and --listen-port', () => {
    expect(sdBaseUrl(sdInstance(8080))).toBe('http://127.0.0.1:8080');
    expect(sdBaseUrl(sdInstance(8080, {
      sd: { envVars: {}, serverArgs: [{ key: '--listen-ip', value: '0.0.0.0' }, { key: '--listen-port', value: '7860' }], modelConfigIds: [], extra: {} },
    }))).toBe('http://127.0.0.1:7860');
  });

  it('is null when the block has no usable port', () => {
    const inst = sdInstance(8080);
    inst.sd!.serverArgs = [{ key: '--listen-ip', value: '127.0.0.1' }];
    expect(sdBaseUrl(inst)).toBeNull();
  });
});

describe('sdRequest', () => {
  beforeEach(() => stub.reset());

  it('GETs and parses a JSON body', async () => {
    stub.on('GET', '/sdcpp/v1/models/status', () => ({ status: 200, body: READY }));
    const result = await sdRequest(baseUrl, '/sdcpp/v1/models/status');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(READY);
  });

  it('POSTs a JSON body and keeps the upstream status', async () => {
    let seen: unknown = null;
    stub.on('POST', '/sdcpp/v1/models/load', (body) => { seen = body; return ({ status: 400, body: { error: 'bad', code: 'invalid_model_config' } }); });
    const result = await sdRequest(baseUrl, '/sdcpp/v1/models/load', { method: 'POST', body: { recipe: 'x' } });
    expect(seen).toEqual({ recipe: 'x' });
    expect(result.status).toBe(400);
  });

  it('passes a non-JSON body through as text', async () => {
    stub.on('GET', '/plain', () => ({ status: 200, body: 'not json' }));
    const result = await sdRequest(baseUrl, '/plain');
    expect(result.body).toBe('not json');
  });
});

describe('sdModelFiles / sdModelStatus', () => {
  beforeEach(() => stub.reset());

  it('returns the live catalog files', async () => {
    stub.on('GET', '/sdcpp/v1/model-files', () => ({ status: 200, body: { files: FILES, errors: [] } }));
    expect(await sdModelFiles(baseUrl)).toEqual(FILES);
  });

  it('returns [] when the response has no files array', async () => {
    stub.on('GET', '/sdcpp/v1/model-files', () => ({ status: 200, body: { errors: [] } }));
    expect(await sdModelFiles(baseUrl)).toEqual([]);
  });

  it('returns the status payload', async () => {
    stub.on('GET', '/sdcpp/v1/models/status', () => ({ status: 200, body: EMPTY }));
    expect((await sdModelStatus(baseUrl)).state).toBe('empty');
  });
});

describe('sdUpstreamError', () => {
  it('maps the verified failure codes to actionable text (§1.4.1)', () => {
    expect(sdUpstreamError({ status: 409, body: { code: 'model_busy', error: 'busy' } }))
      .toContain('finish or cancel running generations');
    expect(sdUpstreamError({ status: 400, body: { code: 'invalid_model_config', error: 'unknown model slot: x' } }))
      .toContain('loaded model is unchanged');
    expect(sdUpstreamError({ status: 422, body: { code: 'model_load_failed', error: 'init failed' } }))
      .toContain('no model loaded');
    expect(sdUpstreamError({ status: 503, body: { code: 'model_loading', error: 'x' } }))
      .toContain('still running');
  });

  it('falls back to the status line for an unmapped body', () => {
    expect(sdUpstreamError({ status: 500, body: 'boom' })).toContain('sd-server returned 500');
  });
});

describe('sdCardRecipeId', () => {
  it('is the card recipe verbatim, trimmed', () => {
    expect(sdCardRecipeId(card({ sdExtras: { recipe: '  qwen-image-21  ' } }))).toBe('qwen-image-21');
  });

  it('is empty when the card declares no recipe', () => {
    expect(sdCardRecipeId(card({ sdExtras: {} }))).toBe('');
  });
});

describe('sdLoadCard', () => {
  beforeEach(() => stub.reset());

  it('submits the recipe and live file-ids, returning the status', async () => {
    let sent: { recipe?: string; models?: Record<string, string> } | null = null;
    stub.on('POST', '/sdcpp/v1/models/load', (body) => {
      sent = body as typeof sent;
      return ({ status: 200, body: READY });
    });
    const outcome = await sdLoadCard(baseUrl, card(), FILES, ['/models/sd/flux']);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toEqual(READY);
    // Paths became the server's own ids — never the paths themselves (§1.4.1).
    expect(sent).toEqual({
      recipe: 'flux1-dev',
      models: {
        diffusion_model: 'diffusion_models/flux1-dev.gguf',
        clip_l: 'text_encoders/clip_l.safetensors',
        vae: 'vae/ae.safetensors',
      },
    });
  });

  it('fails with the mapping error when a component has no catalog file-id', async () => {
    // A file the running server never scanned has no id, so the load cannot be
    // built at all — and must not be attempted (§3.3).
    const stray = card({
      modelPath: '/models/sd/flux/diffusion_models/not-scanned.gguf',
      params: { '--diffusion-model': '/models/sd/flux/diffusion_models/not-scanned.gguf' },
      paramOrder: ['--diffusion-model'],
    });
    const outcome = await sdLoadCard(baseUrl, stray, FILES, ['/models/sd/flux']);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not inside any --model-dir root');
    expect(stub.calls).toEqual([]); // never reached the server
  });

  it('surfaces the upstream failure message', async () => {
    stub.on('POST', '/sdcpp/v1/models/load', () => ({ status: 409, body: { code: 'model_busy', error: 'Finish or cancel pending generation jobs' } }));
    const outcome = await sdLoadCard(baseUrl, card(), FILES, ['/models/sd/flux']);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('finish or cancel running generations');
  });

  it('emits a user recipe and retries once when the recipe is unknown', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-recipe-'));
    try {
      let attempts = 0;
      stub.on('POST', '/sdcpp/v1/models/load', () => {
        attempts += 1;
        return attempts === 1
          ? ({ status: 400, body: { code: 'invalid_model_config', error: 'unknown recipe' } })
          : ({ status: 200, body: READY });
      });
      stub.on('POST', '/sdcpp/v1/models/refresh', () => ({ status: 200, body: { errors: [] } }));

      const outcome = await sdLoadCard(baseUrl, card({ sdExtras: { recipe: 'my-flux' } }), FILES, [root]);
      expect(outcome.ok).toBe(true);
      expect(outcome.recipeWritten).toBe('my-flux');
      expect(attempts).toBe(2);
      // The recipe file carries the id the retry submitted, in the first root.
      const written = JSON.parse(fs.readFileSync(path.join(root, 'recipes', 'my-flux.json'), 'utf-8'));
      expect(written.id).toBe('my-flux');
      expect(written.schema_version).toBe(1);
      expect(stub.calls).toContain('POST /sdcpp/v1/models/refresh');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to write a recipe for an id the server would reject', async () => {
    stub.on('POST', '/sdcpp/v1/models/load', () => ({ status: 400, body: { code: 'invalid_model_config', error: 'unknown recipe' } }));
    const outcome = await sdLoadCard(baseUrl, card({ sdExtras: { recipe: 'not a valid id!' } }), FILES, ['/models/sd/flux']);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not a valid recipe id');
    // No recipe file was written and no retry was attempted.
    expect(stub.calls).toEqual(['POST /sdcpp/v1/models/load']);
  });
});

describe('sdUnloadModel', () => {
  beforeEach(() => stub.reset());

  it('returns the empty status', async () => {
    stub.on('POST', '/sdcpp/v1/models/unload', () => ({ status: 200, body: EMPTY }));
    const outcome = await sdUnloadModel(baseUrl);
    expect(outcome.ok).toBe(true);
    expect(outcome.status?.state).toBe('empty');
  });

  it('maps a busy unload to an error', async () => {
    stub.on('POST', '/sdcpp/v1/models/unload', () => ({ status: 409, body: { code: 'model_busy', error: 'busy' } }));
    const outcome = await sdUnloadModel(baseUrl);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('busy');
  });
});

describe('sdWaitUntilReady', () => {
  beforeEach(() => stub.reset());

  it('returns as soon as the server reports a state', async () => {
    stub.on('GET', '/sdcpp/v1/models/status', () => ({ status: 200, body: EMPTY }));
    expect((await sdWaitUntilReady(baseUrl))?.state).toBe('empty');
  });

  it('waits out a loading state', async () => {
    let polls = 0;
    stub.on('GET', '/sdcpp/v1/models/status', () => {
      polls += 1;
      return polls < 2 ? ({ status: 200, body: { state: 'loading' } }) : ({ status: 200, body: READY });
    });
    expect((await sdWaitUntilReady(baseUrl))?.state).toBe('ready');
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('gives up when the process is no longer alive', async () => {
    expect(await sdWaitUntilReady('http://127.0.0.1:1', 2000, () => false)).toBeNull();
  });

  it('gives up when the server never answers', async () => {
    expect(await sdWaitUntilReady('http://127.0.0.1:1', 1500)).toBeNull();
  });
});

describe('sdInitialLoad', () => {
  beforeEach(() => stub.reset());

  it('waits for the server, reads the catalog and loads the first card', async () => {
    stub.on('GET', '/sdcpp/v1/models/status', () => ({ status: 200, body: EMPTY }));
    stub.on('GET', '/sdcpp/v1/model-files', () => ({ status: 200, body: { files: FILES, errors: [] } }));
    const sent: { recipe?: string } = {};
    stub.on('POST', '/sdcpp/v1/models/load', (body) => {
      Object.assign(sent, body);
      return ({ status: 200, body: READY });
    });
    const outcome = await sdInitialLoad(sdInstance(port), (id) => (id === 'flux1-dev' ? card() : undefined));
    expect(outcome.ok).toBe(true);
    expect(sent.recipe).toBe('flux1-dev');
    expect(stub.calls).toEqual([
      'GET /sdcpp/v1/models/status',
      'GET /sdcpp/v1/model-files',
      'POST /sdcpp/v1/models/load',
    ]);
  });

  it('reports a missing card without touching the server', async () => {
    const outcome = await sdInitialLoad(sdInstance(port), () => undefined);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('not found');
    expect(stub.calls).toEqual([]);
  });

  it('reports a server that never comes up', async () => {
    const outcome = await sdInitialLoad(sdInstance(1), (id) => (id === 'flux1-dev' ? card() : undefined), () => true, 1500);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('did not become ready');
  });
});
