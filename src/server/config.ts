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

export function loadConfig(): LlamaConfig {
  try {
    const raw = fs.readFileSync(configFile(), 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: LlamaConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}
