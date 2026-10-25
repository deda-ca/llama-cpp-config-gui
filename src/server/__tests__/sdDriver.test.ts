/**
 * stable-diffusion.cpp driver (docs/stable-diffusion.md §3.4, §1.6, §1.7).
 *
 * The launch plan (full-path binary run from its own folder, argv straight from
 * the block's flag rows, no weight flags in Option A), the version/device probes
 * against the real output shapes, and the single-letter log tags.
 *
 * child_process is mocked so the probes never spawn anything; the fixtures are
 * the exact strings the real `sd-server`/`sd-cli` print (captured 2026-10-25).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { getSdVersion, listSdDevices, parseSdDevices, sdDriver } from '../engines/sdDriver.js';
import { execFile } from 'child_process';

/** execFile mock that hands the callback fixed stdout/stderr. */
function mockExecFile(stdout: string, stderr = '', error: Error | null = null) {
  (execFile as any).mockImplementation((_file: string, _args: any[], _opts: any, cb: Function) => {
    cb(error, stdout, stderr);
  });
}

/** A temp dir holding an executable so the probes' existence checks pass. */
function fakeBin(name: string): { dir: string; exe: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-driver-'));
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  return { dir, exe };
}

describe('sdDriver.buildLaunch', () => {
  it('runs a full-path binary from its own folder with the block rows verbatim', () => {
    const launch = sdDriver.buildLaunch!({
      binary: '/home/u/Programs/AI/stable-diffusion.cpp/build/bin/sd-server',
      llamaCppPath: '/home/u/Programs/AI/stable-diffusion.cpp/build/bin',
      sdArgs: [
        { key: '--listen-ip', value: '127.0.0.1' },
        { key: '--listen-port', value: '8080' },
        { key: '--model-dir', value: '/models/sd/qwen-image-2.1' },
        { key: '--model-dir', value: '/models/sd/wan2.2-ti2v-5b' },
        { key: '--backend', value: 'diffusion=CUDA0,te=CUDA1' },
      ],
    } as any);
    expect(launch.command).toBe('/home/u/Programs/AI/stable-diffusion.cpp/build/bin/sd-server');
    expect(launch.cwd).toBe('/home/u/Programs/AI/stable-diffusion.cpp/build/bin');
    // Option A: server options only, no weight flags. Repeated --model-dir rows
    // keep their order (root order decides file-id shape, §1.3.1).
    expect(launch.args).toEqual([
      '--listen-ip', '127.0.0.1',
      '--listen-port', '8080',
      '--model-dir', '/models/sd/qwen-image-2.1',
      '--model-dir', '/models/sd/wan2.2-ti2v-5b',
      '--backend', 'diffusion=CUDA0,te=CUDA1',
    ]);
  });

  it('omits disabled rows and flag-only rows carry no value token', () => {
    const launch = sdDriver.buildLaunch!({
      binary: '/b/sd-server',
      llamaCppPath: '/b',
      sdArgs: [
        { key: '--mmap' },
        { key: '--offload-to-cpu', disabled: true },
        { key: '--log-level', value: 'info' },
      ],
    } as any);
    expect(launch.args).toEqual(['--mmap', '--log-level', 'info']);
  });

  it('absolutizes a relative binary and runs from its folder', () => {
    const launch = sdDriver.buildLaunch!({
      binary: 'stable-diffusion.cpp/build/bin/sd-server',
      llamaCppPath: '',
      sdArgs: [],
    } as any);
    expect(launch.command).toBe(path.resolve('stable-diffusion.cpp/build/bin/sd-server'));
    expect(launch.cwd).toBe(path.resolve('stable-diffusion.cpp/build/bin'));
  });

  it('leaves a bare binary for PATH resolution, keeping the fallback cwd', () => {
    const launch = sdDriver.buildLaunch!({
      binary: 'sd-server',
      llamaCppPath: '/run',
      sdArgs: [],
    } as any);
    expect(launch.command).toBe('sd-server');
    expect(launch.cwd).toBe('/run');
    expect(launch.args).toEqual([]);
  });
});

describe('sdDriver.getVersion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses the real one-line banner', async () => {
    const { exe } = fakeBin('sd-server');
    try {
      mockExecFile('stable-diffusion.cpp version master-1004-a85db96-2-g0886f11, commit 0886f11\n');
      const info = await getSdVersion(exe);
      expect(info.version).toBe('master-1004-a85db96-2-g0886f11');
      expect(info.commit).toBe('0886f11');
      // sd.cpp reports no build/compiler/backend on this line.
      expect(info.build).toBeNull();
      expect(info.compiler).toBeNull();
    } finally {
      fs.rmSync(path.dirname(exe), { recursive: true, force: true });
    }
  });

  it('accepts a build folder and probes sd-server inside it', async () => {
    const { dir } = fakeBin('sd-server');
    try {
      mockExecFile('stable-diffusion.cpp version b42, commit abc1234\n');
      const info = await getSdVersion(dir);
      expect(info.version).toBe('b42');
      expect(info.commit).toBe('abc1234');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty info for a missing binary', async () => {
    const info = await getSdVersion('/nonexistent/sd-server');
    expect(info.version).toBeNull();
    expect(info.commit).toBeNull();
    expect(info.raw).toEqual([]);
  });

  it('returns empty info when the probe fails', async () => {
    const { exe } = fakeBin('sd-server');
    try {
      mockExecFile('', '', new Error('boom'));
      const info = await getSdVersion(exe);
      expect(info.version).toBeNull();
    } finally {
      fs.rmSync(path.dirname(exe), { recursive: true, force: true });
    }
  });
});

describe('sdDriver.listDevices', () => {
  beforeEach(() => vi.clearAllMocks());

  // The real capture: TAB-separated names on stdout, ggml banner with VRAM on
  // stderr.
  const STDOUT = [
    'CUDA0\tNVIDIA GeForce RTX 5070 Ti',
    'CUDA1\tNVIDIA GeForce RTX 5070 Ti',
    'CUDA2\tNVIDIA GeForce RTX 5070 Ti',
    'CUDA3\tNVIDIA GeForce RTX 5070 Ti',
    'CPU\tAMD Ryzen 9 5950X 16-Core Processor',
  ].join('\n') + '\n';
  const STDERR = [
    'ggml_cuda_init: found 4 CUDA devices (Total VRAM: 63364 MiB):',
    '  Device 0: NVIDIA GeForce RTX 5070 Ti, compute capability 12.0, VMM: yes, VRAM: 15838 MiB',
    '  Device 1: NVIDIA GeForce RTX 5070 Ti, compute capability 12.0, VMM: yes, VRAM: 15841 MiB',
  ].join('\n') + '\n';

  it('parses name<TAB>description lines and joins VRAM from the banner', async () => {
    const { exe } = fakeBin('sd-cli');
    try {
      mockExecFile(STDOUT, STDERR);
      const devices = await listSdDevices(exe);
      expect(devices.map((d) => d.type)).toEqual(['CUDA', 'CUDA', 'CUDA', 'CUDA', 'CPU']);
      expect(devices[0]).toEqual({
        index: 0,
        name: 'NVIDIA GeForce RTX 5070 Ti',
        type: 'CUDA',
        memoryTotalMb: 15838,
      });
      expect(devices[1].memoryTotalMb).toBe(15841);
      // CPU has no index and no VRAM line.
      expect(devices[4].type).toBe('CPU');
      expect(devices[4].memoryTotalMb).toBe(0);
    } finally {
      fs.rmSync(path.dirname(exe), { recursive: true, force: true });
    }
  });

  it('falls back to sd-server when sd-cli is absent', async () => {
    const { dir } = fakeBin('sd-server');
    try {
      mockExecFile(STDOUT, STDERR);
      const devices = await listSdDevices(dir);
      expect(devices).toHaveLength(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for a missing binary', async () => {
    expect(await listSdDevices('/nonexistent/dir')).toEqual([]);
  });

  it('parseSdDevices tolerates a banner-less probe (VRAM 0)', () => {
    const devices = parseSdDevices(STDOUT, '');
    expect(devices).toHaveLength(5);
    expect(devices[0].memoryTotalMb).toBe(0);
  });
});

describe('sdDriver.toLogEntry', () => {
  it('colors the single-letter tags sd.cpp actually prints', () => {
    expect(sdDriver.toLogEntry!('[E] failed to bind port --- main.cpp:12').level).toBe('E');
    expect(sdDriver.toLogEntry!('[W] VRAM low --- runtime.cpp:88').level).toBe('W');
    expect(sdDriver.toLogEntry!('[I] listening on: http://127.0.0.1:8080 --- main.cpp:170').level).toBe('plain');
    expect(sdDriver.toLogEntry!('[D] verbose detail --- x.cpp:1').level).toBe('plain');
  });

  it('flags an untagged ggml init failure as an error', () => {
    expect(sdDriver.toLogEntry!('ggml_cuda_init: failed to initialize CUDA: no device').level).toBe('E');
  });

  it('keeps the raw line verbatim', () => {
    const line = '[I] hello --- main.cpp:1';
    expect(sdDriver.toLogEntry!(line).raw).toBe(line);
  });
});
