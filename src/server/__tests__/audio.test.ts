/**
 * audio.cpp engine config mapping + driver (docs/audio.md).
 *
 * The round-trip guarantee is the important one: an `audiocpp_server` config
 * imported into the UI and exported again must come back equivalent in content,
 * including keys the UI has no field for and a `task` written as an array
 * (which upstream's `optional_string` ignores but must not be lost).
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  AUDIO_MODEL_KEYS,
  AUDIO_OPTION_PREFIXES,
  AUDIO_SERVER_KEYS,
  audioConfigPath,
  audioFromConfig,
  audioModelFromEntry,
  audioModelToEntry,
  audioPort,
  audioRunDir,
  audioToConfig,
  blankAudioConfig,
  configToServerParams,
  normalizeAudioConfig,
  serverParamsToConfig,
} from '../engines/audio.js';
import { audioDriver, audioLevel, getAudioVersion } from '../engines/audioDriver.js';

/** The user's real audio-cpp.json (relative paths, a task array, an `options`
 * map the upstream parser ignores, and a streaming model). */
const realConfig = {
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
      path: 'models/Breeze-TTS-2/breeze-tts-2-q8_0.gguf',
      task: ['tts', 'clon', 'vdes'],
      mode: 'streaming',
      default_request_options: {
        instruction: 'Speak like a friendly radio host. Energetic, speak very fast, confident and engaging.',
      },
    },
    {
      id: 'qwen3-asr',
      family: 'qwen3_asr',
      path: 'models/Qwen3-ASR/qwen3-asr-1.7b-q8_0.gguf',
      task: 'asr',
      mode: 'streaming',
    },
    {
      id: 'parakeet_tdt',
      family: 'parakeet_tdt',
      path: 'models/parakeet-tdt-0.6b-v3-q8_0.gguf',
      task: 'asr',
      options: {
        matmul_weight_type: 'native',
        audio_chunk_duration_sec: 1.0,
      },
      mode: 'streaming',
    },
  ],
};

describe('server params <-> config keys', () => {
  it('restores JSON types from row values', () => {
    expect(serverParamsToConfig([
      { key: 'host', value: '0.0.0.0' },
      { key: 'port', value: '5455' },
      { key: 'device', value: '0' },
      { key: 'threads', value: '8' },
      { key: 'lazy_load' },
      { key: 'cors_origins', value: '*' },
    ])).toEqual({
      host: '0.0.0.0',
      port: 5455,
      device: 0,
      threads: 8,
      lazy_load: true,
      cors_origins: '*',
    });
  });

  it('ignores rows that are not server keys or are disabled', () => {
    expect(serverParamsToConfig([
      { key: 'not_a_key', value: 'x' },
      { key: 'threads', value: '4', disabled: true },
    ])).toEqual({});
  });

  it('renders config entries back to rows, in catalog order', () => {
    const rows = configToServerParams({ port: 5455, host: '0.0.0.0', threads: 8, lazy_load: false });
    expect(rows).toEqual([
      { key: 'host', value: '0.0.0.0' },
      { key: 'port', value: '5455' },
      { key: 'threads', value: '8' },
      { key: 'lazy_load', disabled: true },
    ]);
  });
});

describe('model entry <-> card', () => {
  it('splits scalar keys into rows and nested maps into prefixed rows', () => {
    const card = audioModelFromEntry(realConfig.models[0] as Record<string, unknown>);
    expect(card.type).toBe('audio');
    expect(card.alias).toBe('breeze_tts_2');
    expect(card.modelPath).toBe('models/Breeze-TTS-2/breeze-tts-2-q8_0.gguf');
    expect(card.params['family']).toBe('breeze_tts');
    expect(card.params['mode']).toBe('streaming');
    expect(card.params['default_request_options.instruction']).toContain('radio host');
    // A `task` array has no scalar row, so it rides in extras verbatim.
    expect(card.params['task']).toBeUndefined();
    expect(card.audioExtras?.task).toEqual(['tts', 'clon', 'vdes']);
  });

  it('keeps an unknown object key (options) in extras verbatim', () => {
    const card = audioModelFromEntry(realConfig.models[2] as Record<string, unknown>);
    expect(card.audioExtras?.options).toEqual({
      matmul_weight_type: 'native',
      audio_chunk_duration_sec: 1.0,
    });
  });

  it('regroups prefixed rows and absolutizes the path on export', () => {
    const card = audioModelFromEntry(realConfig.models[0] as Record<string, unknown>);
    const entry = audioModelToEntry(card, '/home/u/Programs/AI');
    expect(entry.id).toBe('breeze_tts_2');
    expect(entry.family).toBe('breeze_tts');
    expect(entry.path).toBe('/home/u/Programs/AI/models/Breeze-TTS-2/breeze-tts-2-q8_0.gguf');
    expect(entry.default_request_options).toEqual({
      instruction: 'Speak like a friendly radio host. Energetic, speak very fast, confident and engaging.',
    });
    // The task array survives verbatim.
    expect(entry.task).toEqual(['tts', 'clon', 'vdes']);
  });

  it('round-trips a scalar task as a string row', () => {
    const card = audioModelFromEntry(realConfig.models[1] as Record<string, unknown>);
    expect(card.params['task']).toBe('asr');
    const entry = audioModelToEntry(card, '/base');
    expect(entry.task).toBe('asr');
    expect(entry.mode).toBe('streaming');
  });

  it('honours disabled rows and numeric/boolean typing on export', () => {
    const card = audioModelFromEntry({
      id: 'm', family: 'f', path: '/abs/m.gguf', task: 'tts', lazy: true, busy_timeout_ms: 1000, slots: 4,
    });
    card.disabledParams = ['slots'];
    const entry = audioModelToEntry(card, '/base');
    expect(entry.lazy).toBe(true);
    expect(entry.busy_timeout_ms).toBe(1000);
    expect(entry.slots).toBeUndefined();
  });
});

describe('audioFromConfig / audioToConfig round-trip', () => {
  it('splits the file into a block + model cards', () => {
    const { audio, models } = audioFromConfig(realConfig as Record<string, unknown>);
    expect(audioPort(audio)).toBe(5455);
    expect(audio.serverArgs.find((p) => p.key === 'host')?.value).toBe('0.0.0.0');
    expect(audio.extra).toEqual({});
    expect(models).toHaveLength(3);
    expect(models.map((m) => m.alias)).toEqual(['breeze_tts_2', 'qwen3-asr', 'parakeet_tdt']);
  });

  it('re-emits the whole file with absolute paths, preserving extras', () => {
    const { audio, models } = audioFromConfig(realConfig as Record<string, unknown>);
    const out = audioToConfig(audio, models, '/home/u/Programs/AI');
    expect(out.host).toBe('0.0.0.0');
    expect(out.port).toBe(5455);
    expect(out.lazy_load).toBe(true);
    expect(out.cors_origins).toBe('*');
    const modelsOut = out.models as Record<string, unknown>[];
    expect(modelsOut).toHaveLength(3);
    expect(modelsOut[0].path).toBe('/home/u/Programs/AI/models/Breeze-TTS-2/breeze-tts-2-q8_0.gguf');
    expect(modelsOut[0].task).toEqual(['tts', 'clon', 'vdes']);
    expect(modelsOut[2].options).toEqual({ matmul_weight_type: 'native', audio_chunk_duration_sec: 1.0 });
  });

  it('preserves server keys with no UI field through extra', () => {
    const cfg = { ...realConfig, live_ingest: { idle_timeout_ms: 5000 }, frontend_options: { theme: 'dark' } };
    const { audio } = audioFromConfig(cfg as Record<string, unknown>);
    expect(audio.extra).toEqual({ live_ingest: { idle_timeout_ms: 5000 }, frontend_options: { theme: 'dark' } });
    const out = audioToConfig(audio, [], '/base');
    expect(out.live_ingest).toEqual({ idle_timeout_ms: 5000 });
    expect(out.frontend_options).toEqual({ theme: 'dark' });
  });

  it('drops a slots row unless parallelJobs adds --parallel-jobs', () => {
    // Upstream throws "slots requires --parallel-jobs at server startup", so a
    // file we write must never carry the key without the flag (config.cpp:309).
    const card = audioModelFromEntry({ id: 'm', family: 'f', path: '/abs/m.gguf', slots: 4 });
    expect(audioModelToEntry(card, '/base').slots).toBeUndefined();
    expect(audioModelToEntry(card, '/base', true).slots).toBe(4);

    const { audio, models } = audioFromConfig(realConfig as Record<string, unknown>);
    models[0].params.slots = '3';
    expect((audioToConfig(audio, models, '/base').models as any[])[0].slots).toBeUndefined();
    const out = audioToConfig({ ...audio, parallelJobs: true }, models, '/base');
    expect((out.models as any[])[0].slots).toBe(3);
  });
});

describe('normalizeAudioConfig', () => {
  it('returns undefined for a missing/garbage block', () => {
    expect(normalizeAudioConfig(undefined)).toBeUndefined();
    expect(normalizeAudioConfig(null)).toBeUndefined();
    expect(normalizeAudioConfig([])).toBeUndefined();
    expect(normalizeAudioConfig('x')).toBeUndefined();
  });

  it('coerces each field defensively', () => {
    const c = normalizeAudioConfig({
      envVars: { CUDA_VISIBLE_DEVICES: '0', bad: 5 },
      serverArgs: [{ key: 'port', value: 8080 }],
      modelConfigIds: ['a', 3, 'b'],
      extra: { live_ingest: { x: 1 } },
    });
    expect(c).toEqual({
      envVars: { CUDA_VISIBLE_DEVICES: '0' },
      serverArgs: [{ key: 'port', value: '8080' }],
      modelConfigIds: ['a', 'b'],
      extra: { live_ingest: { x: 1 } },
    });
  });

  it('defaults missing fields to empty', () => {
    expect(normalizeAudioConfig({})).toEqual({
      envVars: {},
      serverArgs: [],
      modelConfigIds: [],
      extra: {},
    });
  });

  it('keeps parallelJobs only when true', () => {
    expect(normalizeAudioConfig({ parallelJobs: true })?.parallelJobs).toBe(true);
    expect(normalizeAudioConfig({ parallelJobs: false })).not.toHaveProperty('parallelJobs');
    expect(normalizeAudioConfig({ parallelJobs: 'yes' })).not.toHaveProperty('parallelJobs');
  });
});

describe('blankAudioConfig / audioPort / audioConfigPath', () => {
  it('seeds the rows a new server needs to bind', () => {
    const a = blankAudioConfig();
    expect(audioPort(a)).toBe(8080);
    expect(a.serverArgs.find((p) => p.key === 'backend')?.value).toBe('cuda');
  });

  it('reads the port from the port row, null when absent', () => {
    expect(audioPort({ envVars: {}, serverArgs: [{ key: 'port', value: '5455' }], modelConfigIds: [], extra: {} })).toBe(5455);
    expect(audioPort({ envVars: {}, serverArgs: [{ key: 'port', value: '5455', disabled: true }], modelConfigIds: [], extra: {} })).toBeNull();
    expect(audioPort(undefined)).toBeNull();
  });

  it('names the generated file from the instance id', () => {
    expect(audioConfigPath('a')).toMatch(/\.config[/\\]audio-a\.json$/);
    expect(audioConfigPath('a')).not.toBe(audioConfigPath('b'));
  });
});

describe('audioRunDir', () => {
  it('derives the working directory from a full executable path', () => {
    expect(audioRunDir('/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server'))
      .toBe('/home/u/Programs/AI/audio.cpp/build/bin');
    expect(audioRunDir('audio.cpp/build/bin/audiocpp_server'))
      .toBe(path.resolve('audio.cpp/build/bin'));
  });

  it('is empty for a bare name or blank binary (PATH lookup)', () => {
    expect(audioRunDir('audiocpp_server')).toBe('');
    expect(audioRunDir('')).toBe('');
    expect(audioRunDir(undefined)).toBe('');
  });
});

describe('audioDriver', () => {
  it('launches a full-path binary from its own folder', () => {
    const launch = audioDriver.buildLaunch!({
      binary: '/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server',
      llamaCppPath: '/home/u/Programs/AI/audio.cpp/build/bin',
      audioConfigPath: '/cfg/audio-a.json',
    } as any);
    expect(launch.command).toBe('/home/u/Programs/AI/audio.cpp/build/bin/audiocpp_server');
    expect(launch.args).toEqual(['--config', '/cfg/audio-a.json']);
    expect(launch.cwd).toBe('/home/u/Programs/AI/audio.cpp/build/bin');
  });

  it('absolutizes a relative binary and runs from its folder', () => {
    const launch = audioDriver.buildLaunch!({
      binary: 'audio.cpp/build/bin/audiocpp_server',
      llamaCppPath: '',
      audioConfigPath: '/cfg/audio-a.json',
    } as any);
    expect(launch.command).toBe(path.resolve('audio.cpp/build/bin/audiocpp_server'));
    expect(launch.cwd).toBe(path.resolve('audio.cpp/build/bin'));
  });

  it('leaves a bare binary for PATH resolution, keeping the fallback cwd', () => {
    const launch = audioDriver.buildLaunch!({
      binary: 'audiocpp_server',
      llamaCppPath: '/run',
      audioConfigPath: '/cfg/audio-a.json',
    } as any);
    expect(launch.command).toBe('audiocpp_server');
    expect(launch.cwd).toBe('/run');
  });

  it('appends --parallel-jobs only when the instance enables it', () => {
    // The flag is CLI-only upstream, so it rides on the command line.
    const base = {
      binary: '/b/audiocpp_server',
      llamaCppPath: '/b',
      audioConfigPath: '/cfg/audio-a.json',
    };
    expect(audioDriver.buildLaunch!(base as any).args)
      .toEqual(['--config', '/cfg/audio-a.json']);
    expect(audioDriver.buildLaunch!({ ...base, audioParallelJobs: true } as any).args)
      .toEqual(['--config', '/cfg/audio-a.json', '--parallel-jobs']);
  });

  it('classifies log levels', () => {
    expect(audioLevel('audiocpp_server failed: boom')).toBe('F');
    expect(audioLevel('ERROR: cannot load model')).toBe('E');
    expect(audioLevel('WARNING: experimental')).toBe('W');
    expect(audioLevel('serving on 0.0.0.0:5455')).toBe('plain');
  });

  it('version probe returns empty info for a missing binary', async () => {
    const info = await getAudioVersion('/nonexistent/audiocpp_server');
    expect(info.version).toBeNull();
    expect(info.commit).toBeNull();
    expect(info.build).toBeNull();
    expect(info.backend).toBeNull();
    expect(info.raw).toEqual([]);
  });
});

// Sanity: the exported key sets stay consistent with the module's own lists.
describe('key sets', () => {
  it('AUDIO_SERVER_KEYS / AUDIO_MODEL_KEYS / prefixes are populated', () => {
    expect(AUDIO_SERVER_KEYS.has('host')).toBe(true);
    expect(AUDIO_MODEL_KEYS.has('family')).toBe(true);
    expect(AUDIO_OPTION_PREFIXES).toContain('load_options');
    expect(path.basename(audioConfigPath('x'))).toBe('audio-x.json');
  });
});
