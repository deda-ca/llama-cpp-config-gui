import { execFile } from 'child_process';
import type { GpuInfo } from './types.js';

const QUERY =
  'index,name,memory.used,memory.total,temperature.gpu,utilization.gpu,power.draw';

function parseCsvLine(line: string): string[] {
  return line.split(',').map((s) => s.trim());
}

export function queryGpus(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=' + QUERY, '--format=csv,noheader,nounits'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const gpus: GpuInfo[] = [];
        for (const line of stdout.trim().split('\n')) {
          if (!line.trim()) continue;
          const [index, name, memUsed, memTotal, temp, util, power] = parseCsvLine(line);
          gpus.push({
            index: parseInt(index, 10),
            name,
            memoryUsedMb: parseFloat(memUsed),
            memoryTotalMb: parseFloat(memTotal),
            temperatureC: parseFloat(temp),
            utilizationPct: parseFloat(util),
            powerDrawW: power === '[N/A]' ? null : parseFloat(power),
            cudaIndex: null, // filled in by the server after matching
          });
        }
        resolve(gpus);
      },
    );
  });
}

export function startGpuPolling(
  onStats: (gpus: GpuInfo[]) => void,
  intervalMs = 2000,
): { stop: () => void; setInterval: (ms: number) => void } {
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = async () => {
    const gpus = await queryGpus();
    onStats(gpus);
  };

  const start = (ms: number) => {
    if (timer) clearInterval(timer);
    poll();
    timer = setInterval(poll, ms);
  };

  start(intervalMs);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    setInterval: (ms: number) => start(ms),
  };
}
