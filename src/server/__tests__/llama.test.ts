import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { getLlamaVersion, listLlamaDevices, matchCudaIndices } from '../llama.js';
import type { LlamaDevice } from '../types.js';
import { execFile } from 'child_process';

// Helper: set up execFile mock to call the callback with given output
function mockExecFile(stdout: string, stderr = '', error: Error | null = null) {
  (execFile as any).mockImplementation((_file: string, _args: any[], _opts: any, cb: Function) => {
    cb(error, stdout, stderr);
  });
}

describe('getLlamaVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses new format (version + build + commit)', async () => {
    // Create a fake binary so fs.existsSync returns true
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-test-'));
    const binPath = path.join(tmpDir, 'llama-server');
    fs.writeFileSync(binPath, '#!/bin/sh\n', { mode: 0o755 });

    mockExecFile('', 'version: 0.5.0-dev (build 11242, commit 526c43b8f)\nbuilt with GNU 15.2.0 for Linux x86_64\nCUDA');

    const result = await getLlamaVersion(tmpDir);
    expect(result.version).toBe('0.5.0-dev');
    expect(result.build).toBe('11242');
    expect(result.commit).toBe('526c43b8f');
    expect(result.compiler).toBe('GNU 15.2.0 for Linux x86_64');
    expect(result.backend).toBe('CUDA');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('parses old format (build number + commit)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-test-'));
    const binPath = path.join(tmpDir, 'llama-server');
    fs.writeFileSync(binPath, '#!/bin/sh\n', { mode: 0o755 });

    mockExecFile('', 'version: 7841 (abc123def)\nbuilt with Clang 19.0.0 for Linux x86_64');

    const result = await getLlamaVersion(tmpDir);
    expect(result.build).toBe('7841');
    expect(result.commit).toBe('abc123def');
    expect(result.compiler).toBe('Clang 19.0.0 for Linux x86_64');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns nulls when binary does not exist', async () => {
    const result = await getLlamaVersion('/nonexistent/path');
    expect(result.version).toBeNull();
    expect(result.build).toBeNull();
    expect(result.raw).toEqual([]);
  });

  it('returns nulls on exec error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-test-'));
    const binPath = path.join(tmpDir, 'llama-server');
    fs.writeFileSync(binPath, '#!/bin/sh\n', { mode: 0o755 });

    mockExecFile('', '', new Error('spawn failed'));

    const result = await getLlamaVersion(tmpDir);
    expect(result.version).toBeNull();
    expect(result.build).toBeNull();

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('listLlamaDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses CUDA and BLAS devices from --list-devices output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-test-'));
    const binPath = path.join(tmpDir, 'llama-cli');
    fs.writeFileSync(binPath, '#!/bin/sh\n', { mode: 0o755 });

    const output = `CUDA0: NVIDIA GeForce RTX 5070 Ti (15841 MiB, 255 MiB free)
CUDA1: NVIDIA GeForce RTX 3050 (5806 MiB, 5708 MiB free)
BLAS: OpenBLAS (0 MiB, 0 MiB free)`;

    mockExecFile(output);

    const devices = await listLlamaDevices(tmpDir);
    expect(devices).toHaveLength(3);
    expect(devices[0]).toMatchObject({ index: 0, type: 'CUDA', name: 'NVIDIA GeForce RTX 5070 Ti', memoryTotalMb: 15841 });
    expect(devices[1]).toMatchObject({ index: 1, type: 'CUDA', name: 'NVIDIA GeForce RTX 3050', memoryTotalMb: 5806 });
    expect(devices[2]).toMatchObject({ index: 0, type: 'BLAS', name: 'OpenBLAS' });

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns empty array when binary does not exist', async () => {
    const devices = await listLlamaDevices('/nonexistent/path');
    expect(devices).toEqual([]);
  });
});

describe('matchCudaIndices', () => {
  it('matches identical GPU names', () => {
    const gpuNames = ['NVIDIA GeForce RTX 5070 Ti', 'NVIDIA GeForce RTX 3050'];
    const devices: LlamaDevice[] = [
      { index: 0, name: 'NVIDIA GeForce RTX 5070 Ti', type: 'CUDA', memoryTotalMb: 15841 },
      { index: 1, name: 'NVIDIA GeForce RTX 3050', type: 'CUDA', memoryTotalMb: 5806 },
    ];
    const result = matchCudaIndices(gpuNames, devices);
    expect(result.get(0)).toBe(0);
    expect(result.get(1)).toBe(1);
  });

  it('returns empty map when no CUDA devices', () => {
    const gpuNames = ['NVIDIA GeForce RTX 5070 Ti'];
    const devices: LlamaDevice[] = [
      { index: 0, name: 'OpenBLAS', type: 'BLAS', memoryTotalMb: 0 },
    ];
    const result = matchCudaIndices(gpuNames, devices);
    expect(result.size).toBe(0);
  });

  it('returns empty map when no GPU names', () => {
    const devices: LlamaDevice[] = [
      { index: 0, name: 'NVIDIA GeForce RTX 5070 Ti', type: 'CUDA', memoryTotalMb: 15841 },
    ];
    const result = matchCudaIndices([], devices);
    expect(result.size).toBe(0);
  });

  it('handles partial name matches', () => {
    const gpuNames = ['NVIDIA GeForce RTX 5070 Ti'];
    const devices: LlamaDevice[] = [
      { index: 0, name: 'GeForce RTX 5070 Ti', type: 'CUDA', memoryTotalMb: 15841 },
    ];
    const result = matchCudaIndices(gpuNames, devices);
    expect(result.get(0)).toBe(0);
  });
});
