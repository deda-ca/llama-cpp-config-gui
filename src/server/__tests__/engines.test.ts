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
  normalizeEngineParams,
  isPortTaken,
  findFreePort,
  instancePort,
  blankInstance,
  makeEngineId,
  engineIdForRename,
} from '../engines/store.js';
import { splitArgs, tokensToParams, paramsToArgs } from '../engines/args.js';
import { blankStrataConfig } from '../engines/strata.js';
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
          kind: 'llamacpp',
          definitionId: 'default',
          binary: 'llama-server',
          params: [{ key: '--host', value: '0.0.0.0' }, { key: '--port', value: '8080' }, { key: '--api-key', value: 'secret' }, { key: '--metrics' }],
          routerMode: true,
          modelConfigIds: ['cfg1', 'cfg2'],
          autoLaunch: false,
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
      kind: 'llamacpp',
      definitionId: 'def-0',
      binary: 'llama-server',
      params: [],
      routerMode: false,
      modelConfigIds: [],
      autoLaunch: false,
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

  it('folds a legacy audio run folder into a relative binary', () => {
    const normalized = normalizeEngines({
      instances: [
        {
          id: 'audio-cpp',
          kind: 'audio',
          binary: 'build/bin/audiocpp_server',
          audio: { cwd: '/home/u/Programs/AI/audio.cpp', serverArgs: [] },
        },
      ],
    });
    // The merged field is a single full path; the launch cwd is its folder.
    expect(normalized.instances[0].binary).toBe('/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server');
    expect(normalized.instances[0].audio).not.toHaveProperty('cwd');
  });

  it('leaves an already-full-path audio binary alone', () => {
    const normalized = normalizeEngines({
      instances: [
        {
          id: 'audio-cpp',
          kind: 'audio',
          binary: '/opt/audio.cpp/build/bin/audiocpp_server',
          audio: { cwd: '/home/u/Programs/AI', serverArgs: [] },
        },
      ],
    });
    expect(normalized.instances[0].binary).toBe('/opt/audio.cpp/build/bin/audiocpp_server');
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
      kind: 'llamacpp',
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
      autoLaunch: false,
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
      { id: 'a', name: 'a', notes: '', kind: 'llamacpp', definitionId: 'default', binary: 'llama-server', params: [{ key: '--port', value: '8080' }], routerMode: false, modelConfigIds: [], autoLaunch: false },
      { id: 'b', name: 'b', notes: '', kind: 'llamacpp', definitionId: 'default', binary: 'llama-server', params: [{ key: '--port', value: '8082' }], routerMode: false, modelConfigIds: [], autoLaunch: false },
    ],
    defaultInstanceId: 'a',
  };

  it('instancePort reads --port from params', () => {
    expect(instancePort({ params: [{ key: '--port', value: '8080' }] })).toBe(8080);
    expect(instancePort({ params: [{ key: '-p', value: '5000' }] })).toBe(5000);
    expect(instancePort({ params: [{ key: '--port', value: 'nope' }] })).toBeNull();
    expect(instancePort({ params: [] })).toBeNull();
  });

  it('instancePort ignores a disabled --port row', () => {
    expect(instancePort({ params: [{ key: '--port', value: '8080', disabled: true }] })).toBeNull();
    // A later enabled row still wins
    expect(instancePort({
      params: [
        { key: '--port', value: '8080', disabled: true },
        { key: '--port', value: '9090' },
      ],
    })).toBe(9090);
  });

  it('instancePort falls back to the strata --port server row', () => {
    expect(instancePort({
      params: [],
      strata: { ...blankStrataConfig(), serverArgs: [{ key: '--port', value: '5456' }] },
    })).toBe(5456);
  });

  it('a strata --port row holding a number still reports its port', () => {
    // Repairs engines.json written while a numeric input sent a real number.
    const normalized = normalizeEngines({
      definitions: [],
      instances: [
        {
          id: 's1',
          name: 'S',
          kind: 'strata',
          definitionId: '',
          binary: 'python3',
          params: [],
          strata: { engineArgs: [], serverArgs: [{ key: '--port', value: 5457 }], vision: null, extra: {} },
        },
      ],
      defaultInstanceId: 's1',
    });
    expect(instancePort(normalized.instances[0])).toBe(5457);
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
    expect(instancePort(inst)).toBe(8080);
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
    expect(instancePort(inst)).toBe(8081);
  });

  it('uniquifies ids against existing instances', () => {
    const existing = normalizeEngines({ instances: [{ id: 'my-engine' }] });
    expect(makeEngineId('My Engine', existing.instances)).toBe('my-engine-2');
    expect(blankInstance('My Engine', def, existing).id).toBe('my-engine-2');
  });
});

describe('engineIdForRename', () => {
  it('keeps the id when the slug already matches', () => {
    expect(engineIdForRename('My Engine', 'my-engine', [])).toBe('my-engine');
    // Case/whitespace edits are not a real rename.
    expect(engineIdForRename('  my Engine ', 'my-engine', [])).toBe('my-engine');
  });

  it('follows the name when it changes', () => {
    expect(engineIdForRename('llama.cpp 2', 'llamacpp', [])).toBe('llama-cpp-2');
  });

  it('uniquifies the new id against the other instances', () => {
    const others = [{ id: 'llama-cpp-2' }, { id: 'llama-cpp-3' }];
    expect(engineIdForRename('llama.cpp 2', 'engine-1', others)).toBe('llama-cpp-2-2');
  });
});

describe('normalizeEngineParams', () => {
  it('stringifies a numeric value instead of dropping it', () => {
    // A number input bound straight to the model used to send real numbers,
    // which were dropped — leaving e.g. a --port row with no port at all.
    expect(normalizeEngineParams([{ key: '--port', value: 5457 as unknown as string }])).toEqual([
      { key: '--port', value: '5457' },
    ]);
  });

  it('keeps string values and drops non-finite numbers', () => {
    expect(
      normalizeEngineParams([
        { key: '--port', value: '5457' },
        { key: '--ctx', value: NaN as unknown as number },
      ]),
    ).toEqual([{ key: '--port', value: '5457' }, { key: '--ctx' }]);
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
        { id: 'a', name: 'a', notes: '', kind: 'llamacpp', definitionId: 'default', binary: 'llama-server', params: [{ key: '--metrics', disabled: true }], routerMode: false, modelConfigIds: [], autoLaunch: false },
      ],
      defaultInstanceId: 'a',
    };
    readFileSync.mockReturnValue(JSON.stringify(data));
    expect(loadEngines()).toEqual(data);
  });
});
