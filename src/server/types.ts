export interface GpuInfo {
  index: number;
  name: string;
  memoryUsedMb: number;
  memoryTotalMb: number;
  temperatureC: number;
  utilizationPct: number;
  powerDrawW: number | null;
  pcieGen: number | null;      // current PCIe generation (e.g. 4 => PCIe 4.0)
  pcieWidth: number | null;    // current PCIe lane width (e.g. 16 => x16)
  cudaIndex: number | null; // matched CUDA device index from llama-cli, if available
}

export interface LlamaDevice {
  index: number;
  name: string;
  type: string; // e.g. "CUDA", "CPU"
  memoryTotalMb: number;
}

export type GpuSortMode = 'default' | 'cuda' | 'name' | 'memory' | 'temperature' | 'manual';

export interface LlamaConfig {
  llamaCppPath: string;
  /** Multimodal projector file (.gguf), passed as --mmproj */
  mmproj?: string;
  /** Router preset INI file, passed as --models-preset (router mode with multiple models) */
  routerIniPath?: string;
  /** Root folder containing model .gguf files (for browsing/picking in the UI) */
  modelsDir: string;
  /** Path to the router.ini file (for import/export) */
  //routerIniPath: string;
  /** Environment variables passed to spawned llama.cpp processes */
  envVars: Record<string, string>;
  modelPath: string;
  /**
   * Executable name inside the build folder. llama.cpp uses 'llama-server' |
   * 'llama-cli'; other engine kinds name their own binary (Phase 3 drivers).
   */
  binary: string;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  mainThreads: number;
  batchSize: number;
  ubatchSize: number;
  /** Host/interface llama-server binds to (--host) */
  host: string;
  port: number;
  /** API key for the server (--api-key); empty = no auth */
  apiKey: string;
  extraArgs: string;
  /**
   * Engine-instance launch: `extraArgs` is the complete, user-authored param
   * list, so the llama.cpp driver must not inject its own defaults
   * (-c/-ngl/-b/-ub/-t/-ts/--host/--port/--api-key) for flags the instance
   * does not list. Legacy settings.json launches leave this unset and keep
   * the old default-injection behavior.
   */
  paramsOnly?: boolean;
  gpuIntervalMs: number;
  gpuSort: GpuSortMode;
  gpuOrder: number[]; // manual order of SMI indices; empty = use sort mode
  /** OpenAI-compatible proxy gateway settings (docs/proxy-server.md) */
  proxy?: import('./proxy/types.js').ProxySettings;
  /**
   * strata kind: the generated `strata-<instance>.json` the Python server is
   * launched with (`--config`). Written by the launch endpoint, like
   * `routerIniPath`, so the driver itself stays side-effect free.
   */
  strataConfigPath?: string;
}

export interface PerfMetrics {
  prefillTokensPerSec: number | null;
  generationTokensPerSec: number | null;
  lastUpdated: number;
}

export type ProcessStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'error';

export interface ModelMetrics {
  model: string;
  prefillTokensPerSec: number | null;
  generationTokensPerSec: number | null;
  lastUpdated: number;
}

export interface SystemStats {
  cpu: {
    overallPercent: number; // aggregate usage across all cores, 0-100
    coreCount: number;      // total logical cores
    activeCores: number;    // cores above the 5% "active" threshold
    perCore: number[];      // per-core usage 0-100, one entry per core
  };
  ram: {
    usedBytes: number;
    totalBytes: number;
  };
  disk: {
    usedBytes: number;
    totalBytes: number;
    readMBs: number | null;  // aggregate read throughput (null on non-Linux)
    writeMBs: number | null; // aggregate write throughput (null on non-Linux)
  };
}

export interface WsMessage {
  type: 'gpu-stats' | 'log-line' | 'log-history' | 'metrics' | 'process-status' | 'model-metrics' | 'system-stats' | 'model-status' | 'proxy-usage' | 'proxy-log' | 'proxy-log-history';
  payload: unknown;
}
