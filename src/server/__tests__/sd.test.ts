/**
 * stable-diffusion.cpp engine config (docs/stable-diffusion.md §3.1, §3.6).
 *
 * The load-bearing invariants here are the ones the launch depends on: the
 * `--model-dir` rows a new instance is seeded with (sorted, model roots only),
 * the port read from `--listen-port` (never `-l`, which is the IP on
 * sd-server), and the fact that a garbage/absent block normalizes to
 * `undefined` so an older engines.json keeps loading.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SD_CATEGORY_DIRS,
  SD_DEFAULT_PORT,
  blankSdConfig,
  discoverSdModelDirs,
  isSdModelRoot,
  normalizeSdConfig,
  sdHost,
  sdModelDirs,
  sdPort,
  sdRunDir,
} from '../engines/sd.js';

/** A throwaway sd root tree mirroring §1.3.1: one folder per model. */
function makeSdRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-root-'));
  const mk = (model: string, ...dirs: string[]) => {
    for (const d of dirs) fs.mkdirSync(path.join(base, model, d), { recursive: true });
  };
  mk('wan2.2-ti2v-5b', 'diffusion_models', 'text_encoders', 'vae');
  mk('qwen-image-2.1', 'diffusion_models', 'vae');
  mk('sd1.5', 'checkpoints');
  // Not a model root: the category dir is a grandchild, not an immediate child
  // (`model_category_directories` only matches direct children).
  fs.mkdirSync(path.join(base, 'not-a-model', 'sub', 'diffusion_models'), { recursive: true });
  fs.mkdirSync(path.join(base, 'loose-files'), { recursive: true });
  return base;
}

describe('model root discovery (§1.3.1)', () => {
  it('finds folders with a recognised category dir as an immediate child', () => {
    const base = makeSdRoot();
    try {
      const found = discoverSdModelDirs(base).map((p) => path.basename(p));
      expect(found).toEqual(['qwen-image-2.1', 'sd1.5', 'wan2.2-ti2v-5b']);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('sorts by name because root order is load-bearing (§1.3.1 caveat 1)', () => {
    const base = makeSdRoot();
    try {
      const found = discoverSdModelDirs(base);
      const names = found.map((p) => path.basename(p));
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      // The first root keeps plain file-ids, later roots get @<hash>/… — so the
      // first entry must be deterministic, not readdir order.
      expect(path.basename(found[0])).toBe('qwen-image-2.1');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('accepts the category aliases the server itself matches', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-alias-'));
    try {
      for (const name of ['Stable-diffusion', 'lora', 'VAE_APPROX']) {
        const dir = path.join(base, `m-${name}`);
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        expect(isSdModelRoot(dir)).toBe(true);
      }
      expect(SD_CATEGORY_DIRS).toContain('checkpoints');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns nothing for a missing root instead of throwing', () => {
    expect(discoverSdModelDirs('/nonexistent/sd/root')).toEqual([]);
    expect(isSdModelRoot('/nonexistent/sd/root')).toBe(false);
  });

  it('never treats the sd parent itself as a root', () => {
    // The parent holds model folders, not category dirs, so the scan that
    // decides "is this a root" rejects it — pointing --model-dir there would
    // find nothing (§1.3.1).
    const base = makeSdRoot();
    try {
      expect(isSdModelRoot(base)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('sd block shape', () => {
  it('blankSdConfig seeds bind rows and one --model-dir per discovered root', () => {
    const cfg = blankSdConfig();
    expect(cfg.serverArgs[0]).toEqual({ key: '--listen-ip', value: '127.0.0.1' });
    expect(cfg.serverArgs[1]).toEqual({ key: '--listen-port', value: String(SD_DEFAULT_PORT) });
    // sd-server has no --port flag; the row must be named --listen-port.
    expect(cfg.serverArgs.some((p) => p.key === '--port')).toBe(false);
    for (const row of cfg.serverArgs.filter((p) => p.key === '--model-dir')) {
      expect(path.isAbsolute(row.value ?? '')).toBe(true);
      expect(isSdModelRoot(row.value ?? '')).toBe(true);
    }
    expect(cfg.modelConfigIds).toEqual([]);
    expect(cfg.extra).toEqual({});
  });

  it('normalizeSdConfig is undefined for a missing or garbage block', () => {
    expect(normalizeSdConfig(undefined)).toBeUndefined();
    expect(normalizeSdConfig(null)).toBeUndefined();
    expect(normalizeSdConfig([])).toBeUndefined();
    expect(normalizeSdConfig('nope')).toBeUndefined();
  });

  it('normalizeSdConfig keeps every field and drops junk entries', () => {
    const out = normalizeSdConfig({
      envVars: { LD_LIBRARY_PATH: '/opt/cuda', BAD: 7 },
      serverArgs: [
        { key: '--listen-port', value: 5458 },
        { key: '--model-dir', value: '/m/sd1.5' },
        { key: '  ' },
        null,
      ],
      modelConfigIds: ['qwen', 42, 'sd15'],
      extra: { '--some-flag': true },
    });
    expect(out).toBeDefined();
    expect(out?.envVars).toEqual({ LD_LIBRARY_PATH: '/opt/cuda' });
    // A numeric value survives as a string instead of being dropped (the
    // v-model coercion bug, docs/todo.md).
    expect(out?.serverArgs).toEqual([
      { key: '--listen-port', value: '5458' },
      { key: '--model-dir', value: '/m/sd1.5' },
    ]);
    expect(out?.modelConfigIds).toEqual(['qwen', 'sd15']);
    expect(out?.extra).toEqual({ '--some-flag': true });
  });

  it('extra round-trips untouched', () => {
    const cfg = { envVars: {}, serverArgs: [], modelConfigIds: [], extra: { nested: { a: [1, 2] } } };
    expect(normalizeSdConfig(cfg)?.extra).toEqual(cfg.extra);
  });
});

describe('port, host and model dirs (§3.6)', () => {
  const block = (rows: { key: string; value?: string; disabled?: boolean }[]) =>
    normalizeSdConfig({ serverArgs: rows })!;

  it('sdPort reads --listen-port', () => {
    expect(sdPort(block([{ key: '--listen-port', value: '5458' }]))).toBe(5458);
    expect(sdPort(block([{ key: '--listen-port', value: 'nope' }]))).toBeNull();
    expect(sdPort(block([]))).toBeNull();
    expect(sdPort(undefined)).toBeNull();
  });

  it('sdPort ignores out-of-range and disabled rows', () => {
    expect(sdPort(block([{ key: '--listen-port', value: '0' }]))).toBeNull();
    expect(sdPort(block([{ key: '--listen-port', value: '70000' }]))).toBeNull();
    expect(sdPort(block([{ key: '--listen-port', value: '5458', disabled: true }]))).toBeNull();
  });

  it('sdPort does not read -l: on sd-server that is the listen IP', () => {
    expect(sdPort(block([{ key: '-l', value: '5458' }]))).toBeNull();
  });

  it('sdHost defaults to loopback', () => {
    expect(sdHost(block([{ key: '--listen-ip', value: '0.0.0.0' }]))).toBe('0.0.0.0');
    expect(sdHost(block([]))).toBe('127.0.0.1');
  });

  it('sdModelDirs keeps order and skips blank/disabled rows', () => {
    const dirs = sdModelDirs(block([
      { key: '--model-dir', value: '/m/a' },
      { key: '--model-dir', value: '  ' },
      { key: '--model-dir', value: '/m/b', disabled: true },
      { key: '--model-dir', value: '/m/c' },
    ]));
    expect(dirs).toEqual(['/m/a', '/m/c']);
    expect(sdModelDirs(undefined)).toEqual([]);
  });
});

describe('sdRunDir', () => {
  it('is the executable folder, like audioRunDir', () => {
    expect(sdRunDir('/home/u/Programs/AI/stable-diffusion.cpp/build/bin/sd-server'))
      .toBe('/home/u/Programs/AI/stable-diffusion.cpp/build/bin');
  });

  it('absolutizes a relative path', () => {
    expect(sdRunDir('build/bin/sd-server')).toBe(path.join(process.cwd(), 'build/bin'));
  });

  it('a bare name has no folder (spawn inherits cwd)', () => {
    expect(sdRunDir('sd-server')).toBe('');
    expect(sdRunDir(undefined)).toBe('');
  });
});
