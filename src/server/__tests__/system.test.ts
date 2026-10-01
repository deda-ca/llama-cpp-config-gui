import { describe, it, expect } from 'vitest';
import { isWholeDisk, cpuCorePercent, parseDiskStats, type CpuTimes } from '../system.js';

describe('isWholeDisk', () => {
  it('treats SCSI/USB whole disks as whole disks', () => {
    expect(isWholeDisk('sda')).toBe(true);
    expect(isWholeDisk('sdb')).toBe(true);
    expect(isWholeDisk('vda')).toBe(true);
  });

  it('treats SCSI/USB partitions as partitions', () => {
    expect(isWholeDisk('sda1')).toBe(false);
    expect(isWholeDisk('sdb2')).toBe(false);
    expect(isWholeDisk('vda3')).toBe(false);
  });

  it('treats NVMe whole disks as whole disks', () => {
    expect(isWholeDisk('nvme0n1')).toBe(true);
    expect(isWholeDisk('nvme1n1')).toBe(true);
  });

  it('treats NVMe partitions (with p) as partitions', () => {
    expect(isWholeDisk('nvme0n1p1')).toBe(false);
    expect(isWholeDisk('nvme1n1p2')).toBe(false);
  });

  it('handles mmcblk whole disk and partition', () => {
    expect(isWholeDisk('mmcblk0')).toBe(true);
    expect(isWholeDisk('mmcblk0p1')).toBe(false);
  });

  it('skips loop/ram/dm pseudo-devices', () => {
    expect(isWholeDisk('loop0')).toBe(false);
    expect(isWholeDisk('ram0')).toBe(false);
    expect(isWholeDisk('dm-0')).toBe(false);
  });

  it('rejects names that do not match a known whole-disk pattern', () => {
    expect(isWholeDisk('')).toBe(false);
    expect(isWholeDisk('12345')).toBe(false); // no leading letters
    expect(isWholeDisk('sd a')).toBe(false);  // space is not allowed
    expect(isWholeDisk('sdaa')).toBe(false);  // two trailing letters is not a disk
  });
});

describe('cpuCorePercent', () => {
  const base: CpuTimes = { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 };

  it('returns 0 when there is no time delta (first sample)', () => {
    expect(cpuCorePercent(base, base)).toBe(0);
  });

  it('computes ~100% when the core is fully busy', () => {
    // total went 10000 → 20000 (Δ10000), idle stayed the same (Δ0) → 100%
    const curr: CpuTimes = { user: 2000, nice: 0, sys: 1000, idle: 8500, irq: 0 };
    expect(cpuCorePercent(base, curr)).toBe(100);
  });

  it('computes ~50% when half the delta is idle', () => {
    // base total = 10000. curr total = 20000 (Δ10000), idle Δ = 5000 → (1 - 5000/10000) = 50%
    const curr: CpuTimes = { user: 4000, nice: 0, sys: 2500, idle: 13500, irq: 0 };
    expect(cpuCorePercent(base, curr)).toBe(50);
  });

  it('computes ~0% when the core is fully idle', () => {
    // total Δ = 10000, idle Δ = 10000 → (1 - 1) = 0%
    const curr: CpuTimes = { user: 1000, nice: 0, sys: 500, idle: 18500, irq: 0 };
    expect(cpuCorePercent(base, curr)).toBe(0);
  });

  it('clamps to the 0-100 range', () => {
    // A negative idle delta (shouldn't happen) must not produce >100.
    const curr: CpuTimes = { user: 2000, nice: 0, sys: 1000, idle: 8000, irq: 0 };
    expect(cpuCorePercent(base, curr)).toBeLessThanOrEqual(100);
    expect(cpuCorePercent(base, curr)).toBeGreaterThanOrEqual(0);
  });
});

describe('parseDiskStats', () => {
  // Realistic /proc/diskstats sample. Field layout (1-based):
  // 1 major, 2 minor, 3 name, 4 reads, 5 merged_reads, 6 sectors_read,
  // 7 ms_reading, 8 writes, 9 merged_writes, 10 sectors_written, ...
  const sample = [
    '259       0 nvme0n1 123456 0 7890123 45678 234567 0 12345678 56789 0 0 0',
    '259       1 nvme0n1p1 100 0 5000 100 200 0 6000 200 0 0 0',
    '259       2 nvme0n1p2 300 0 15000 300 400 0 18000 400 0 0 0',
    '      8       0 sda 5000 0 250000 1200 6000 0 300000 1500 0 0 0',
    '      8       1 sda1 4000 0 200000 1000 5000 0 250000 1300 0 0 0',
    '',
  ].join('\n');

  it('sums sectors only from whole disks, skipping partitions', () => {
    const { readSectors, writeSectors } = parseDiskStats(sample);
    // Whole disks: nvme0n1 (read 7890123, write 12345678) + sda (read 250000, write 300000)
    expect(readSectors).toBe(7890123 + 250000);
    expect(writeSectors).toBe(12345678 + 300000);
  });

  it('returns zeros for empty input', () => {
    const { readSectors, writeSectors } = parseDiskStats('');
    expect(readSectors).toBe(0);
    expect(writeSectors).toBe(0);
  });

  it('ignores malformed lines with too few fields', () => {
    const { readSectors, writeSectors } = parseDiskStats('bad line here\n259 0 nvme0n1 1 0 100 0 2 0 200 0 0 0');
    expect(readSectors).toBe(100);
    expect(writeSectors).toBe(200);
  });
});
