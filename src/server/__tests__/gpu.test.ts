import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { queryGpus } from '../gpu.js';
import { execFile } from 'child_process';

function mockExecFile(stdout: string, error: Error | null = null) {
  (execFile as any).mockImplementation((_cmd: string, _args: any[], _opts: any, cb: Function) => {
    cb(error, stdout);
  });
}

describe('queryGpus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses a single GPU row', async () => {
    mockExecFile('0, NVIDIA GeForce RTX 5070 Ti, 1234, 16384, 55, 78, 245.5, 4, 16');
    const gpus = await queryGpus();
    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({
      index: 0,
      name: 'NVIDIA GeForce RTX 5070 Ti',
      memoryUsedMb: 1234,
      memoryTotalMb: 16384,
      temperatureC: 55,
      utilizationPct: 78,
      powerDrawW: 245.5,
      pcieGen: 4,
      pcieWidth: 16,
    });
  });

  it('parses multiple GPU rows', async () => {
    mockExecFile(
      '0, NVIDIA GeForce RTX 5070 Ti, 1234, 16384, 55, 78, 245.5, 4, 16\n' +
      '1, NVIDIA GeForce RTX 3050, 512, 6144, 42, 12, 89.0, 3, 8',
    );
    const gpus = await queryGpus();
    expect(gpus).toHaveLength(2);
    expect(gpus[0].index).toBe(0);
    expect(gpus[1].index).toBe(1);
    expect(gpus[1].name).toBe('NVIDIA GeForce RTX 3050');
  });

  it('handles [N/A] power draw as null', async () => {
    mockExecFile('0, NVIDIA GeForce RTX 4090, 100, 24564, 60, 90, [N/A], 4, 16');
    const gpus = await queryGpus();
    expect(gpus).toHaveLength(1);
    expect(gpus[0].powerDrawW).toBeNull();
  });

  it('parses current PCIe gen and width', async () => {
    mockExecFile('0, NVIDIA GPU, 100, 8192, 50, 10, 80.0, 3, 8');
    const gpus = await queryGpus();
    expect(gpus[0]).toMatchObject({ pcieGen: 3, pcieWidth: 8 });
  });

  it('handles [N/A] PCIe fields as null', async () => {
    mockExecFile('0, NVIDIA GPU, 100, 8192, 50, 10, 80.0, [N/A], [N/A]');
    const gpus = await queryGpus();
    expect(gpus[0].pcieGen).toBeNull();
    expect(gpus[0].pcieWidth).toBeNull();
  });

  it('returns empty array on exec error (no nvidia-smi)', async () => {
    mockExecFile('', new Error('not found'));
    const gpus = await queryGpus();
    expect(gpus).toEqual([]);
  });

  it('skips blank lines', async () => {
    mockExecFile('\n0, NVIDIA GPU, 10, 2048, 30, 40, 50.0, 4, 16\n\n');
    const gpus = await queryGpus();
    expect(gpus).toHaveLength(1);
  });
});
