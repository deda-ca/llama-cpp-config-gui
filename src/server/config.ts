import fs from 'fs';
import path from 'path';
import type { LlamaConfig } from './types.js';

// Resolved at call time (not import time) so tests can isolate the config
// directory by changing cwd before exercising the API.
export function configDir(): string {
  return path.resolve(process.cwd(), '.config');
}

function configFile(): string {
  return path.join(configDir(), 'settings.json');
}

export const DEFAULT_CONFIG: LlamaConfig = {
  llamaCppPath: '',
  modelsDir: '',
  routerIniPath: '',
  envVars: {},
  modelPath: '',
  binary: 'llama-server',
  contextSize: 4096,
  gpuLayers: 99,
  threads: 0, // 0 = auto
  mainThreads: 0, // 0 = auto
  batchSize: 512,
  ubatchSize: 512,
  host: '127.0.0.1',
  port: 8080,
  apiKey: '',
  extraArgs: '',
  gpuIntervalMs: 2000,
  gpuSort: 'default',
  gpuOrder: [],
};

/** Corrupt files already copied aside, by path -> mtime, so repeated loads of
 *  the same broken file do not pile up backups. */
const backedUp = new Map<string, number>();

/**
 * Parse a JSON config file; `undefined` when it is missing or unreadable.
 * A file that exists but does not parse (a hand-edit typo, a write cut short
 * by a crash) is first copied aside to `<file>.corrupt-<timestamp>`: callers
 * fall back to defaults, and the next save would otherwise overwrite the
 * user's only copy with an empty one.
 */
export function readJsonFile(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (backedUp.get(file) !== mtime) {
        const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(file, backup);
        backedUp.set(file, mtime);
        console.warn(`[config] ${file} is not valid JSON (${(e as Error).message}); saved a copy to ${backup}`);
      }
    } catch {
      /* a failed backup must not stop the app from starting */
    }
    return undefined;
  }
}

export function loadConfig(): LlamaConfig {
  const parsed = readJsonFile(configFile());
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...DEFAULT_CONFIG, ...(parsed as Partial<LlamaConfig>) }
    : { ...DEFAULT_CONFIG };
}

export function saveConfig(config: LlamaConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}
