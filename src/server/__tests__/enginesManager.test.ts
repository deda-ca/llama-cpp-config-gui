import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// --- fs mock (store layer) ---
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

// --- child_process mock (worker layer) ---
const spawn = vi.fn();

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: (...args: any[]) => spawn(...args),
}));

import { EngineManager } from '../engines/manager.js';
import { instanceToLlamaConfig } from '../engines/launch.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { EngineDefinition, EngineInstance } from '../engines/types.js';
import type { ProcessStatus } from '../types.js';

/** Fake child process: exposes stdout/stderr streams + kill/on like ChildProcess. */
function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function makeFs() {
  // engines.json absent; engine binaries present (llama.ts checks existsSync too)
  existsSync.mockImplementation((p: unknown) => /llama-(server|cli)$/.test(String(p)));
  readFileSync.mockImplementation(() => {
    throw new Error('ENOENT');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  makeFs();
  spawn.mockImplementation(() => fakeChild());
});

describe('EngineManager', () => {
  it('starts with no instances and a null default id', () => {
    const mgr = new EngineManager();
    expect(mgr.list()).toEqual([]);
    expect(mgr.getDefaultInstanceId()).toBeNull();
    expect(mgr.getStatus('missing')).toBe('stopped');
  });

  it('launch creates one instance per id with isolated status', () => {
    const mgr = new EngineManager();
    const seen: Array<[string, ProcessStatus]> = [];
    (mgr as any).events.onStatusChange = (id: string, s: ProcessStatus) => seen.push([id, s]);

    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.launch('b', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    expect(mgr.list().map((i) => i.id)).toEqual(['a', 'b']);

    // Both workers report 'starting' on launch
    expect(mgr.getStatus('a')).toBe('starting');
    expect(mgr.getStatus('b')).toBe('starting');
    expect(seen).toEqual([
      ['a', 'starting'],
      ['b', 'starting'],
    ]);
  });

  it('relaunching the same id reuses the instance (no duplicate)', () => {
    const mgr = new EngineManager();
    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    expect(mgr.list()).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('routes log lines to the owning instance cache and event', () => {
    const lines: Array<[string, string]> = [];
    const mgr = new EngineManager({ onLogLine: (id, line) => lines.push([id, line]) });

    const childA = fakeChild();
    const childB = fakeChild();
    spawn.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.launch('b', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });

    childA.stderr.emit('data', Buffer.from('line for a\n'));
    childB.stdout.emit('data', Buffer.from('line for b\n'));

    // Each instance's stream carries only its own lines (plus the worker's
    // [LAUNCH] banner emitted at spawn time)
    expect(lines.filter(([, l]) => l.startsWith('line for'))).toEqual([
      ['a', 'line for a'],
      ['b', 'line for b'],
    ]);
    expect(lines.filter(([id]) => id === 'a').map(([, l]) => l)).toEqual([
      expect.stringContaining('[LAUNCH]'),
      'line for a',
    ]);
  });

  it('pushLog caches per instance and replays only that instance', () => {
    const mgr = new EngineManager();
    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.launch('b', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.pushLog('a', { raw: 'one', level: 'I' });
    mgr.pushLog('a', { raw: 'two', level: 'W' });
    mgr.pushLog('b', { raw: 'three', level: 'E' });

    expect(mgr.getLogCache('a').map((l) => l.raw)).toEqual(['one', 'two']);
    expect(mgr.getLogCache('b').map((l) => l.raw)).toEqual(['three']);
    expect(mgr.getLogCache('missing')).toEqual([]);

    mgr.clearLogs('a');
    expect(mgr.getLogCache('a')).toEqual([]);
    expect(mgr.getLogCache('b')).toHaveLength(1);
  });

  it('caps the per-instance log cache at 1024 entries', () => {
    const mgr = new EngineManager();
    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    for (let i = 0; i < 1030; i++) mgr.pushLog('a', { raw: `l${i}`, level: 'plain' });
    const cache = mgr.getLogCache('a');
    expect(cache).toHaveLength(1024);
    expect(cache[0].raw).toBe('l6');
  });

  it('a non-zero exit marks only that instance as error', () => {
    const mgr = new EngineManager();
    const childA = fakeChild();
    const childB = fakeChild();
    spawn.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.launch('b', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });

    childA.emit('close', 1);
    expect(mgr.getStatus('a')).toBe('error');
    expect(mgr.getStatus('b')).toBe('starting');
    expect(mgr.statusCounts()).toEqual({ running: 1, stopped: 1, total: 2 });
  });

  it('stop stops one instance; stopAll stops every instance', () => {
    const mgr = new EngineManager();
    const childA = fakeChild();
    const childB = fakeChild();
    spawn.mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.launch('b', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });

    mgr.stop('a');
    expect(childA.kill).toHaveBeenCalledWith('SIGTERM');
    expect(childB.kill).not.toHaveBeenCalled();
    expect(mgr.getStatus('a')).toBe('stopped');

    mgr.stopAll();
    expect(childB.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('statusCounts counts running and starting as running', () => {
    const mgr = new EngineManager();
    const childA = fakeChild();
    const childB = fakeChild();
    spawn.mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    mgr.launch('a', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    mgr.launch('b', { ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    childA.emit('close', 0);
    expect(mgr.statusCounts()).toEqual({ running: 1, stopped: 1, total: 2 });
  });
});

describe('EngineManager legacy migration', () => {
  it('seeds engines.json from a legacy config with a build path', () => {
    const mgr = new EngineManager();
    mgr.migrateFromLegacy({ ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama', port: 8081 });
    expect(mgr.getDefaultInstanceId()).toBe('default');
    expect(writeFileSync).toHaveBeenCalled();
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.definitions[0].buildPath).toBe('/opt/llama');
    expect(written.instances[0].port).toBe(8081);
  });

  it('does nothing when no build path is configured', () => {
    const mgr = new EngineManager();
    mgr.migrateFromLegacy({ ...DEFAULT_CONFIG });
    expect(mgr.getDefaultInstanceId()).toBeNull();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing engines file', () => {
    existsSync.mockImplementation((p: unknown) =>
      /llama-(server|cli)$/.test(String(p)) || /engines\.json$/.test(String(p)),
    );
    readFileSync.mockReturnValue(
      JSON.stringify({
        definitions: [{ id: 'd1', name: 'Build', kind: 'llamacpp', buildPath: '/x', envVars: {} }],
        instances: [{ id: 'i1', name: 'Inst', definitionId: 'd1', binary: 'llama-server', host: '127.0.0.1', port: 9000, apiKey: '', params: [], routerMode: false, modelConfigIds: [] }],
        defaultInstanceId: 'i1',
      }),
    );
    const mgr = new EngineManager();
    mgr.migrateFromLegacy({ ...DEFAULT_CONFIG, llamaCppPath: '/opt/llama' });
    expect(mgr.getDefaultInstanceId()).toBe('i1');
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe('instanceToLlamaConfig', () => {
  const def: EngineDefinition = {
    id: 'default',
    name: 'default',
    kind: 'llamacpp',
    buildPath: '/opt/llama/build',
    envVars: { CUDA_VISIBLE_DEVICES: '0' },
  };
  const base: EngineInstance = {
    id: 'llama-main',
    name: 'llama-main',
    definitionId: 'default',
    binary: 'llama-server',
    host: '0.0.0.0',
    port: 8081,
    apiKey: 'k',
    params: [{ key: '--metrics' }, { key: '--flash-attn', value: 'auto' }],
    routerMode: false,
    modelConfigIds: [],
    modelPath: '/models/a.gguf',
    mmproj: '/models/a-mmproj.gguf',
  };

  it('maps definition + instance into a launch spec', () => {
    const spec = instanceToLlamaConfig(base, def);
    expect(spec.llamaCppPath).toBe('/opt/llama/build');
    expect(spec.envVars).toEqual({ CUDA_VISIBLE_DEVICES: '0' });
    expect(spec.binary).toBe('llama-server');
    expect(spec.host).toBe('0.0.0.0');
    expect(spec.port).toBe(8081);
    expect(spec.apiKey).toBe('k');
    expect(spec.extraArgs).toBe('--metrics --flash-attn auto');
    expect(spec.modelPath).toBe('/models/a.gguf');
    expect(spec.mmproj).toBe('/models/a-mmproj.gguf');
    expect(spec.routerIniPath).toBe('');
  });

  it('router mode clears the single-model fields and uses the INI path', () => {
    const spec = instanceToLlamaConfig({ ...base, routerMode: true, modelConfigIds: ['c1'] }, def, '/tmp/router.ini');
    expect(spec.routerIniPath).toBe('/tmp/router.ini');
    expect(spec.modelPath).toBe('');
    expect(spec.mmproj).toBeUndefined();
  });

  it('maps llama-cli binaries and leaves unknown binaries as llama-server', () => {
    expect(instanceToLlamaConfig({ ...base, binary: 'llama-cli' }, def).binary).toBe('llama-cli');
    expect(instanceToLlamaConfig({ ...base, binary: 'weird' }, def).binary).toBe('llama-server');
  });
});
