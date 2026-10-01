import os from 'os';
import { readFile, statfs } from 'fs/promises';
import type { SystemStats } from './types.js';

/**
 * Lightweight system metrics (CPU, RAM, disk) using only Node built-ins.
 * No child processes are spawned — everything reads kernel data structures
 * directly, so a 1-second refresh costs essentially nothing.
 */

// --- CPU: keep the previous per-core tick counts to compute usage deltas ---
export interface CpuTimes { user: number; nice: number; sys: number; idle: number; irq: number }
let prevCpus: CpuTimes[] | null = null;

/** Compute a single core's usage % from two consecutive tick-count samples. */
export function cpuCorePercent(prev: CpuTimes, curr: CpuTimes): number {
  const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
  const currTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;
  const totalDelta = currTotal - prevTotal;
  if (totalDelta <= 0) return 0;
  const idleDelta = curr.idle - prev.idle;
  const pct = (1 - idleDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

// --- Disk I/O: keep the previous /proc/diskstats sample (Linux only) ---
interface DiskSample { readSectors: number; writeSectors: number; timeMs: number }
let prevDisk: DiskSample | null = null;

/**
 * Parse /proc/diskstats and sum sectors across all real block devices.
 * We skip partitions (e.g. nvme0n1p1) by only counting whole-disk entries,
 * identified by having a matching parent that is NOT itself a partition.
 * A simpler heuristic: sum devices whose name does not end in a digit after
 * the last letter run (i.e. "nvme0n1" yes, "nvme0n1p1" no, "sda" yes, "sda1" no).
 */
/**
 * True for a whole block device, false for one of its partitions (or loop/ram/dm
 * pseudo-devices). We match the known whole-disk naming patterns explicitly so we
 * never double-count I/O by summing a disk and its partitions together.
 */
export function isWholeDisk(name: string): boolean {
  // NVMe whole disks: nvme0n1, nvme1n1, ... (partitions are nvme0n1p1)
  if (/^nvme\d+n\d$/.test(name)) return true;
  // SCSI / USB / virtio whole disks: sda, sdb, vda, hda, xvda (prefix + one letter)
  if (/^(sd|vd|hd|xvd)[a-z]$/.test(name)) return true;
  // eMMC / SD-card whole disks: mmcblk0, mmcblk1 (partitions are mmcblk0p1)
  if (/^mmcblk\d+$/.test(name)) return true;
  // Everything else — partitions (sda1, vda2), loop/ram/dm pseudo-devices — is skipped.
  return false;
}

/**
 * Sum read/write sectors across whole-disk entries in /proc/diskstats content.
 * Pure function (no I/O) so it can be unit-tested with sample data.
 */
export function parseDiskStats(content: string): { readSectors: number; writeSectors: number } {
  let readSectors = 0;
  let writeSectors = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    // fields: major minor name reads ... sectors_read(5) ... writes ... sectors_written(9)
    if (parts.length < 10) continue;
    const name = parts[2];
    if (!isWholeDisk(name)) continue;
    readSectors += parseInt(parts[5], 10) || 0;
    writeSectors += parseInt(parts[9], 10) || 0;
  }
  return { readSectors, writeSectors };
}

async function readDiskStats(): Promise<DiskSample | null> {
  if (process.platform !== 'linux') return null;
  try {
    const content = await readFile('/proc/diskstats', 'utf-8');
    const { readSectors, writeSectors } = parseDiskStats(content);
    return { readSectors, writeSectors, timeMs: Date.now() };
  } catch {
    return null;
  }
}

export async function querySystem(): Promise<SystemStats> {
  // --- CPU ---
  const cpus = os.cpus();
  const currCpus: CpuTimes[] = cpus.map((c) => ({
    user: c.times.user, nice: c.times.nice, sys: c.times.sys, idle: c.times.idle, irq: c.times.irq,
  }));

  let perCore: number[];
  if (prevCpus && prevCpus.length === currCpus.length) {
    perCore = currCpus.map((c, i) => cpuCorePercent(prevCpus![i], c));
  } else {
    // First sample: no delta available yet.
    perCore = currCpus.map(() => 0);
  }
  prevCpus = currCpus;

  const overallPercent = perCore.length > 0 ? Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length) : 0;
  const activeCores = perCore.filter((p) => p > 5).length;

  // --- RAM ---
  const totalBytes = os.totalmem();
  const usedBytes = totalBytes - os.freemem();

  // --- Disk space (all platforms) + I/O (Linux only) ---
  let diskUsedBytes = 0;
  let diskTotalBytes = 0;
  try {
    const s = await statfs('/');
    diskTotalBytes = s.blocks * s.bsize;
    diskUsedBytes = diskTotalBytes - s.bavail * s.bsize;
  } catch {
    // statfs unavailable — leave zeros
  }

  let readMBs: number | null = null;
  let writeMBs: number | null = null;
  const diskSample = await readDiskStats();
  if (diskSample && prevDisk) {
    const dtSec = (diskSample.timeMs - prevDisk.timeMs) / 1000;
    if (dtSec > 0) {
      readMBs = ((diskSample.readSectors - prevDisk.readSectors) * 512) / dtSec / (1024 * 1024);
      writeMBs = ((diskSample.writeSectors - prevDisk.writeSectors) * 512) / dtSec / (1024 * 1024);
      if (readMBs < 0) readMBs = 0;
      if (writeMBs < 0) writeMBs = 0;
    }
  }
  prevDisk = diskSample ?? prevDisk;

  return {
    cpu: { overallPercent, coreCount: perCore.length, activeCores, perCore },
    ram: { usedBytes, totalBytes },
    disk: { usedBytes: diskUsedBytes, totalBytes: diskTotalBytes, readMBs, writeMBs },
  };
}

export function startSystemPolling(
  onStats: (stats: SystemStats) => void,
  intervalMs = 1000,
): { stop: () => void; setInterval: (ms: number) => void } {
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = async () => {
    try {
      onStats(await querySystem());
    } catch { /* non-fatal */ }
  };

  const start = (ms: number) => {
    if (timer) clearInterval(timer);
    poll();
    timer = setInterval(poll, ms);
  };

  start(intervalMs);

  return {
    stop: () => { if (timer) clearInterval(timer); timer = null; },
    setInterval: (ms: number) => start(ms),
  };
}
