import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFileSync = vi.fn();
const writeFileSync = vi.fn();
const mkdirSync = vi.fn();
const existsSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    readFileSync: (...args: any[]) => readFileSync(...args),
    writeFileSync: (...args: any[]) => writeFileSync(...args),
    mkdirSync: (...args: any[]) => mkdirSync(...args),
    existsSync: (...args: any[]) => existsSync(...args),
  },
}));

import {
  loadEngines,
  saveEngines,
  enginesFileExists,
  migrateLegacyConfig,
  normalizeEngines,
  isPortTaken,
  findFreePort,
  instancePort,
  blankInstance,
  makeEngineId,
} from '../engines/store.js';
import { splitArgs, tokensToParams, paramsToArgs } from '../engines/args.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { EnginesFile } from '../engines/types.js';

const emptyEngines: EnginesFile = { definitions: [], instances: [], defaultInstanceId: null };

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
});

describe('loadEngines / saveEngines', () => {
  it('returns empty state when file missing', () => {
    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(loadEngines()).toEqual(emptyEngines);
  });

  it('returns empty state on corrupt file', () => {
    readFileSync.mockReturnValue('{ not valid json');
    expect(loadEngines()).toEqual(emptyEngines);
  });

  it('round-trips an engines file', () => {
    const data: EnginesFile = {
      definitions: [{ id: 'default', name: 'default', kind: 'llamacpp', buildPath: '/opt/llama', envVars: { CUDA_VISIBLE_DEVICES: '0' } }],
      instances: [
        {
          id: 'llama-main',
          name: 'llama-main',
          notes: 'main box',
          definitionId: 'default',
          binary: 'llama-server',
          params: [{ key: '--host', value: '0.0.0.0' }, { key: '--port', value: '8080' }, { key: '--api-key', value: 'secret' }, { key: '--metrics' }],
          routerMode: true,
          modelConfigIds: ['cfg1', 'cfg2'],
        },
      ],
      defaultInstanceId: 'llama-main',
    };
    readFileSync.mockReturnValue(JSON.stringify(data));
    expect(loadEngines()).toEqual(data);

    saveEngines(data);
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toEqual(data);
  });

  it('enginesFileExists reflects the file on disk', () => {
    existsSync.mockReturnValueOnce(true);
    expect(enginesFileExists()).toBe(true);
    expect(enginesFileExists()).toBe(false);
  });
});

describe('normalizeEngines', () => {
  it('fills defaults for partial entries', () => {
    const normalized = normalizeEngines({
      definitions: [{ name: 'Build A' }],
      instances: [{ name: 'Inst', definitionId: 'def-0' }],
    });
    expect(normalized.definitions[0]).toEqual({
      id: 'def-0',
      name: 'Build A',
      kind: 'llamacpp',
      buildPath: '',
      envVars: {},
    });
    expect(normalized.instances[0]).toEqual({
      id: 'inst-0',
      name: 'Inst',
      notes: '',
      definitionId: 'def-0',
      binary: 'llama-server',
      params: [],
      routerMode: false,
      modelConfigIds: [],
    });
    expect(normalized.defaultInstanceId).toBe('inst-0');
  });

  it('folds pre-upgrade host/port/apiKey fields into params', () => {
    const normalized = normalizeEngines({
      instances: [
        {
          id: 'a',
          host: '0.0.0.0',
          port: 9090,
          apiKey: 'secret',
          params: [{ key: '--host', value: '127.0.0.1' }, { key: '--metrics' }],
        },
      ],
    });
    // Existing params win; missing flags are appended in host/port/api-key order.
    expect(normalized.instances[0].params).toEqual([
      { key: '--host', value: '127.0.0.1' },
      { key: '--metrics' },
      { key: '--port', value: '9090' },
      { key: '--api-key', value: 'secret' },
    ]);
    expect(normalized.instances[0]).not.toHaveProperty('port');
  });

  it('drops invalid params entries and keeps flag-only params', () => {
    const normalized = normalizeEngines({
      instances: [
        {
          id: 'a',
          params: [{ key: '--host', value: '0.0.0.0' }, { key: '  ' }, { key: '--metrics' }, null, { value: 'x' }],
        },
      ],
    });
    expect(normalized.instances[0].params).toEqual([
      { key: '--host', value: '0.0.0.0' },
      { key: '--metrics' },
    ]);
  });

  it('falls back to the first instance when defaultInstanceId is stale', () => {
    const normalized = normalizeEngines({
      instances: [{ id: 'a' }, { id: 'b' }],
      defaultInstanceId: 'missing',
    });
    expect(normalized.defaultInstanceId).toBe('a');
  });

  it('uniquifies duplicate ids', () => {
    const normalized = normalizeEngines({
      definitions: [{ id: 'd', name: 'one' }, { id: 'd', name: 'two' }],
      instances: [{ id: 'i' }, { id: 'i' }],
    });
    expect(normalized.definitions.map((d) => d.id)).toEqual(['d', 'd-x']);
    expect(normalized.instances.map((i) => i.id)).toEqual(['i', 'i-x']);
  });

  it('rejects unknown engine kinds', () => {
    const normalized = normalizeEngines({ definitions: [{ id: 'd', kind: 'bogus' }] });
    expect(normalized.definitions[0].kind).toBe('llamacpp');
  });
});

describe('migrateLegacyConfig', () => {
  it('returns null when no build path is configured', () => {
    expect(migrateLegacyConfig({ ...DEFAULT_CONFIG })).toBeNull();
  });

  it('synthesizes one definition + one default instance from legacy settings', () => {
    const legacy = {
      ...DEFAULT_CONFIG,
      llamaCppPath: '/opt/llama/build',
      envVars: { CUDA_VISIBLE_DEVICES: '1', LD_LIBRARY_PATH: '/opt/cuda/lib' },
      binary: 'llama-server' as const,
      host: '0.0.0.0',
      port: 8081,
      apiKey: 'k',
      modelPath: '/models/a.gguf',
      mmproj: '/models/a-mmproj.gguf',
      extraArgs: '--metrics --flash-attn auto',
    };
    const migrated = migrateLegacyConfig(legacy);
    expect(migrated).not.toBeNull();
    expect(migrated!.definitions).toEqual([
      {
        id: 'default',
        name: 'default',
        kind: 'llamacpp',
        buildPath: '/opt/llama/build',
        envVars: { CUDA_VISIBLE_DEVICES: '1', LD_LIBRARY_PATH: '/opt/cuda/lib' },
      },
    ]);
    expect(migrated!.instances[0]).toEqual({
      id: 'default',
      name: 'default',
      notes: '',
      definitionId: 'default',
      binary: 'llama-server',
      params: [
        { key: '--host', value: '0.0.0.0' },
        { key: '--port', value: '8081' },
        { key: '--api-key', value: 'k' },
        { key: '--metrics' },
        { key: '--flash-attn', value: 'auto' },
      ],
      routerMode: false,
      modelConfigIds: [],
      modelPath: '/models/a.gguf',
      mmproj: '/models/a-mmproj.gguf',
    });
    expect(migrated!.defaultInstanceId).toBe('default');
  });

  it('produces a file that survives a normalize round-trip', () => {
    const migrated = migrateLegacyConfig({ ...DEFAULT_CONFIG, llamaCppPath: '/x' })!;
    expect(normalizeEngines(migrated)).toEqual(migrated);
  });
});

describe('port allocation', () => {
  const data: EnginesFile = {
    definitions: [],
    instances: [
      { id: 'a', name: 'a', notes: '', definitionId: 'default', binary: 'llama-server', params: [{ key: '--port', value: '8080' }], routerMode: false, modelConfigIds: [] },
      { id: 'b', name: 'b', notes: '', definitionId: 'default', binary: 'llama-server', params: [{ key: '--port', value: '8082' }], routerMode: false, modelConfigIds: [] },
    ],
    defaultInstanceId: 'a',
  };

  it('instancePort reads --port from params', () => {
    expect(instancePort([{ key: '--port', value: '8080' }])).toBe(8080);
    expect(instancePort([{ key: '-p', value: '5000' }])).toBe(5000);
    expect(instancePort([{ key: '--port', value: 'nope' }])).toBeNull();
    expect(instancePort([])).toBeNull();
  });

  it('instancePort ignores a disabled --port row', () => {
    expect(instancePort([{ key: '--port', value: '8080', disabled: true }])).toBeNull();
    // A later enabled row still wins
    expect(instancePort([
      { key: '--port', value: '8080', disabled: true },
      { key: '--port', value: '9090' },
    ])).toBe(9090);
  });

  it('isPortTaken ignores the excluded instance', () => {
    expect(isPortTaken(data, 8080)).toBe(true);
    expect(isPortTaken(data, 8080, 'a')).toBe(false);
    expect(isPortTaken(data, 8081)).toBe(false);
  });

  it('findFreePort skips instance and reserved ports', () => {
    expect(findFreePort(data, 8080)).toBe(8081);
    expect(findFreePort(data, 8080, [8081, 8083])).toBe(8084);
    expect(findFreePort(emptyEngines, 8080)).toBe(8080);
  });
});

describe('blankInstance / makeEngineId', () => {
  const def = { id: 'default', name: 'default', kind: 'llamacpp' as const, buildPath: '/opt/llama', envVars: {} };

  beforeEach(() => {
    // No template file on disk → the seeded llamacpp template is used
    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  it('derives a slug id and a free port', () => {
    const inst = blankInstance('My Engine', def, emptyEngines);
    expect(inst.id).toBe('my-engine');
    // New instances are seeded from the kind's parameter template
    expect(instancePort(inst.params)).toBe(8080);
    expect(inst.params[0]).toEqual({ key: '--host', value: '127.0.0.1' });
    expect(inst.binary).toBe('llama-server');
    expect(inst.definitionId).toBe('default');
  });

  it('nudges the template --port past ports already in use', () => {
    const existing = normalizeEngines({
      definitions: [{ id: 'default', kind: 'llamacpp' }],
      instances: [{ id: 'x', params: [{ key: '--port', value: '8080' }] }],
    });
    const inst = blankInstance('Another', def, existing);
    expect(instancePort(inst.params)).toBe(8081);
  });

  it('uniquifies ids against existing instances', () => {
    const existing = normalizeEngines({ instances: [{ id: 'my-engine' }] });
    expect(makeEngineId('My Engine', existing.instances)).toBe('my-engine-2');
    expect(blankInstance('My Engine', def, existing).id).toBe('my-engine-2');
  });
});

describe('args helpers', () => {
  it('splitArgs respects quotes', () => {
    expect(splitArgs('--host 0.0.0.0 --api-key "a b"')).toEqual(['--host', '0.0.0.0', '--api-key', 'a b']);
  });

  it('tokensToParams pairs flags with following values', () => {
    expect(tokensToParams(['--metrics', '--host', '0.0.0.0', '-ngl', '99'])).toEqual([
      { key: '--metrics' },
      { key: '--host', value: '0.0.0.0' },
      { key: '-ngl', value: '99' },
    ]);
  });

  it('paramsToArgs quotes values containing spaces', () => {
    expect(paramsToArgs([{ key: '--metrics' }, { key: '--api-key', value: 'a b' }])).toBe(
      '--metrics --api-key "a b"',
    );
  });

  it('paramsToArgs skips disabled rows', () => {
    expect(paramsToArgs([
      { key: '--host', value: '0.0.0.0' },
      { key: '--metrics', disabled: true },
      { key: '--flash-attn', value: 'on' },
    ])).toBe('--host 0.0.0.0 --flash-attn on');
  });
});

describe('disabled param rows', () => {
  it('normalizeEngineParams keeps the disabled flag and drops it when false', () => {
    const normalized = normalizeEngines({
      instances: [
        {
          id: 'a',
          params: [
            { key: '--metrics', disabled: true },
            { key: '--temp', value: '0.7', disabled: false },
          ],
        },
      ],
    });
    expect(normalized.instances[0].params).toEqual([
      { key: '--metrics', disabled: true },
      { key: '--temp', value: '0.7' },
    ]);
  });

  it('a disabled row survives a save round-trip', () => {
    const data: EnginesFile = {
      definitions: [],
      instances: [
        { id: 'a', name: 'a', notes: '', definitionId: 'default', binary: 'llama-server', params: [{ key: '--metrics', disabled: true }], routerMode: false, modelConfigIds: [] },
      ],
      defaultInstanceId: 'a',
    };
    readFileSync.mockReturnValue(JSON.stringify(data));
    expect(loadEngines()).toEqual(data);
  });
});
