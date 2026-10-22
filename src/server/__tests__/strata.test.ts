/**
 * Strata engine config mapping + driver (docs/todo.md #21 Phase 4, #22).
 *
 * The round-trip guarantee is the important one: a `strata-<model>.json` file
 * imported into the UI and exported again must come back byte-equivalent in
 * content, including keys the UI has no field for.
 */

import { describe, it, expect } from 'vitest';
import {
  SERVER_CONFIG_KEYS,
  argvToParams,
  blankStrataConfig,
  configToServerParams,
  formatConfigValue,
  normalizeStrataConfig,
  normalizeVision,
  paramsToArgv,
  parseConfigValue,
  serverFlagFor,
  serverParamsToConfig,
  strataConfigPath,
  strataFromConfig,
  strataPort,
  strataToConfig,
} from '../engines/strata.js';
import { strataDriver, strataLevel, parseStrataLine } from '../engines/strataDriver.js';
import type { StrataConfig } from '../engines/types.js';

/** Trimmed stand-in for the user's real strata-iq3_s.json. */
const realConfig = {
  exe: '/home/u/Strata/engine/strata',
  args: [
    '--pack',
    '/home/u/Strata-data/packs/iq3_s',
    '--native',
    '/home/u/models/Qwen-00001-of-00002.gguf',
    '--ple-gguf',
    '/home/u/models/Qwen-00002-of-00002.gguf',
    '--expert-profile',
    '/home/u/Strata/data/expert-profile.bin',
    '--ctx',
    '262144',
    '--temp',
    '0.7',
    '--metrics',
  ],
  cwd: '/home/u/Strata',
  tokenizer: '/home/u/Strata-data/tokenizers/qwen3',
  model_name: 'qwen3.8',
  log: '/home/u/Strata/logs/iq3_s.log',
  lib_dirs: ['/home/u/Strata/lib'],
  port: 5456,
  gpu: [1, 2, 3],
  gpu_order: [1, 2, 3],
  layer_split: [10, 10, 8],
  gpus_asked: 3,
  vision: {
    exe: '/home/u/Strata/engine/strata-vision',
    mmproj: '/home/u/models/mmproj-BF16.gguf',
    model: '/home/u/models/Qwen-00001-of-00002.gguf',
    gpu: true,
    max_tokens: 1024,
  },
  reasoning_budget_tokens: 8192,
};

describe('parseConfigValue / formatConfigValue', () => {
  it('restores JSON types from text input', () => {
    expect(parseConfigValue('262144')).toBe(262144);
    expect(parseConfigValue('true')).toBe(true);
    expect(parseConfigValue('false')).toBe(false);
    expect(parseConfigValue('')).toBe(true);
    expect(parseConfigValue('127.0.0.1')).toBe('127.0.0.1');
    expect(parseConfigValue('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseConfigValue('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads a comma list as an array, the way gpu/replicas are written', () => {
    expect(parseConfigValue('1,2,3')).toEqual([1, 2, 3]);
    expect(parseConfigValue('/a/lib,/b/lib')).toEqual(['/a/lib', '/b/lib']);
  });

  it('renders values back for a single-line input', () => {
    expect(formatConfigValue(5456)).toBe('5456');
    expect(formatConfigValue([1, 2, 3])).toBe('1,2,3');
    expect(formatConfigValue(['/a', '/b'])).toBe('["/a","/b"]');
    expect(formatConfigValue('plain')).toBe('plain');
  });
});

describe('argv <-> params', () => {
  it('pairs a flag with the token after it', () => {
    expect(argvToParams(['--pack', '/p', '--metrics'])).toEqual([
      { key: '--pack', value: '/p' },
      { key: '--metrics' },
    ]);
  });

  it('keeps values as separate tokens so paths with spaces survive', () => {
    const argv = paramsToArgv([
      { key: '--pack', value: '/home/u/my pack' },
      { key: '--metrics' },
      { key: '--off', value: 'x', disabled: true },
    ]);
    expect(argv).toEqual(['--pack', '/home/u/my pack', '--metrics']);
  });

  it('round-trips an args array', () => {
    const argv = ['--pack', '/p', '--ctx', '4096', '--metrics'];
    expect(paramsToArgv(argvToParams(argv))).toEqual(argv);
  });
});

describe('server params <-> config keys', () => {
  it('maps documented flag spellings to config keys', () => {
    expect(serverFlagFor('api_key')).toBe('--api-key');
    expect(serverFlagFor('idle_unload_s')).toBe('--idle-unload');
    expect(serverFlagFor('max_queue')).toBe('--max-queue');
  });

  it('writes booleans and typed values', () => {
    expect(
      serverParamsToConfig([
        { key: '--host', value: '127.0.0.1' },
        { key: '--port', value: '5456' },
        { key: '--gpu', value: '1,2,3' },
        { key: '--offline' },
        { key: '--no-batch-telemetry' },
      ]),
    ).toEqual({
      host: '127.0.0.1',
      port: 5456,
      gpu: [1, 2, 3],
      offline: true,
      batch_telemetry: false,
    });
  });

  it('turns a false boolean into a disabled row, not a --no-* flag', () => {
    const rows = configToServerParams({ batch_telemetry: false, host: '0.0.0.0' });
    expect(rows).toEqual([
      { key: '--batch-telemetry', disabled: true },
      { key: '--host', value: '0.0.0.0' },
    ]);
  });

  it('ignores config-only keys so no fake flag is shown', () => {
    const rows = configToServerParams({ gpus_asked: 3, layer_split: [10, 10, 8] });
    expect(rows).toEqual([]);
    for (const key of ['gpus_asked', 'layer_split', 'sampling']) {
      expect(SERVER_CONFIG_KEYS.has(key)).toBe(false);
    }
  });
});

describe('strataFromConfig / strataToConfig', () => {
  const s = strataFromConfig(realConfig as Record<string, unknown>);

  it('extracts the engine basics', () => {
    expect(s.exe).toBe('/home/u/Strata/engine/strata');
    expect(s.cwd).toBe('/home/u/Strata');
    expect(s.tokenizer).toBe('/home/u/Strata-data/tokenizers/qwen3');
    expect(s.modelName).toBe('qwen3.8');
    expect(s.engineArgs).toHaveLength(7);
    expect(s.engineArgs[0]).toEqual({ key: '--pack', value: '/home/u/Strata-data/packs/iq3_s' });
  });

  it('keeps the port as a server row because the config key is ignored', () => {
    const port = s.serverArgs.find((p) => p.key === '--port');
    expect(port?.value).toBe('5456');
    expect(strataPort(s)).toBe(5456);
    expect(s.extra).not.toHaveProperty('port');
  });

  it('preserves keys the UI has no field for', () => {
    expect(s.extra).toEqual({
      log: '/home/u/Strata/logs/iq3_s.log',
      lib_dirs: ['/home/u/Strata/lib'],
      gpu_order: [1, 2, 3],
      layer_split: [10, 10, 8],
      gpus_asked: 3,
      reasoning_budget_tokens: 8192,
    });
  });

  it('parses the vision block', () => {
    expect(s.vision).not.toBeNull();
    expect(s.vision?.mmproj).toBe('/home/u/models/mmproj-BF16.gguf');
    expect(s.vision?.gpu).toBe(true);
    expect(s.vision?.maxTokens).toBe(1024);
  });

  it('round-trips without losing or inventing a key', () => {
    const out = strataToConfig(s);
    expect(Object.keys(out).sort()).toEqual(Object.keys(realConfig).sort());
    expect(out).toEqual(realConfig);
  });

  it('is stable across a second import/export', () => {
    const again = strataToConfig(strataFromConfig(strataToConfig(s)));
    expect(again).toEqual(strataToConfig(s));
  });
});

describe('blankStrataConfig / normalizeStrataConfig', () => {
  it('seeds host and port so a new engine is launchable', () => {
    const blank = blankStrataConfig();
    expect(blank.serverArgs.map((p) => p.key)).toEqual(['--host', '--port']);
    expect(strataPort(blank)).toBe(8095);
    expect(blank.vision).toBeNull();
  });

  it('rejects non-objects and fills missing fields', () => {
    expect(normalizeStrataConfig(undefined)).toBeUndefined();
    expect(normalizeStrataConfig([])).toBeUndefined();
    const s = normalizeStrataConfig({ exe: '/x', engineArgs: [{ key: '--ctx', value: '1' }] });
    expect(s?.exe).toBe('/x');
    expect(s?.engineArgs).toEqual([{ key: '--ctx', value: '1' }]);
    expect(s?.serverArgs).toEqual([]);
    expect(s?.extra).toEqual({});
  });

  it('survives a JSON round-trip, which is how engines.json stores it', () => {
    const s = strataFromConfig(realConfig as Record<string, unknown>);
    expect(normalizeStrataConfig(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('normalizeVision', () => {
  it('keeps unknown vision keys in extra', () => {
    const v = normalizeVision({ mmproj: '/m.gguf', gpu: 2, crop: 'top' });
    expect(v?.gpu).toBe(2);
    expect(v?.maxTokens).toBe(1024);
    expect(v?.extra).toEqual({ crop: 'top' });
  });

  it('treats a false gpu as CPU and a missing one as the engine GPU', () => {
    expect(normalizeVision({ gpu: false })?.gpu).toBe(false);
    expect(normalizeVision({})?.gpu).toBe(true);
    expect(normalizeVision('nope')).toBeNull();
  });
});

describe('strataConfigPath', () => {
  it('is per-instance so engines never share a generated file', () => {
    expect(strataConfigPath('a')).toMatch(/\.config[/\\]strata-a\.json$/);
    expect(strataConfigPath('a')).not.toBe(strataConfigPath('b'));
  });
});

describe('strataDriver', () => {
  const spec = {
    llamaCppPath: '/home/u/Strata',
    strataConfigPath: '/cfg/strata-iq3.json',
    port: 5456,
    binary: 'python3',
  };

  it('runs the server module from the repo root with the generated config', () => {
    const launch = strataDriver.buildLaunch!(spec as any);
    expect(launch.command).toBe('python3');
    expect(launch.cwd).toBe('/home/u/Strata');
    expect(launch.args).toEqual([
      '-m',
      'serve.server',
      '--engine',
      'strata',
      '--config',
      '/cfg/strata-iq3.json',
      '--port',
      '5456',
    ]);
  });

  it('falls back to python when no interpreter is set', () => {
    expect(strataDriver.buildLaunch!({ ...spec, binary: '' } as any).command).toBe('python');
  });

  it('classifies log lines', () => {
    expect(strataLevel('Traceback (most recent call last):')).toBe('F');
    expect(strataLevel('ERROR: out of memory')).toBe('E');
    expect(strataLevel('WARNING slow load')).toBe('W');
    expect(strataLevel('serving on 127.0.0.1:5456')).toBe('plain');
  });

  it('extracts throughput from timing lines', () => {
    expect(parseStrataLine('tg = 74.89 t/s')?.generationTokensPerSec).toBe(74.89);
    expect(parseStrataLine('pp = 1200.5 t/s')?.prefillTokensPerSec).toBe(1200.5);
    expect(parseStrataLine('decode 512 tok in 6.83 s (74.9 tok/s)')?.generationTokensPerSec).toBe(74.9);
    expect(parseStrataLine('loading pack')).toBeNull();
  });

  it('reports metrics only when a line changes them', () => {
    const current = { prefillTokensPerSec: null, generationTokensPerSec: null, lastUpdated: 0 };
    expect(strataDriver.extractMetrics!('loading', current)).toBeNull();
    const next = strataDriver.extractMetrics!('tg = 10 t/s', current)!;
    expect(next.generationTokensPerSec).toBe(10);
  });
});

describe('strata instance isolation', () => {
  it('two configs never share state through the mapping', () => {
    const a = strataFromConfig({ ...realConfig, port: 5456 });
    const b = strataFromConfig({ ...realConfig, port: 5457, model_name: 'other' });
    strataToConfig(a);
    expect(strataPort(b)).toBe(5457);
    expect(b.modelName).toBe('other');
    expect((a as StrataConfig).modelName).toBe('qwen3.8');
  });
});
