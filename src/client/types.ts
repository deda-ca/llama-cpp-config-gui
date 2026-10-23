export interface ParamDef {
  flag: string;
  key: string;
  label: string;
  description: string;
  category: string;
  inputType: string;
  default?: string;
  options?: string[];
  /** Preset values for 'preset' inputs (free text still allowed, shown in a dropdown) */
  presets?: string[];
}

export interface ModelConfig {
  id: string;
  alias: string;
  displayName: string;
  notes: string;
  modelPath: string;
  mmproj?: string;
  chatTemplateFile?: string;
  params: Record<string, string>;
  paramOrder: string[];
  /** Param keys that are kept in the config but disabled (commented out in INI) */
  disabledParams?: string[];
  /** Whether this config is included in router launches (checkbox in the list) */
  includeInLaunch?: boolean;
  /**
   * Engine family this card configures (absent = 'llamacpp'). Decides which
   * parameter catalog the editor loads and which generator renders it.
   */
  type?: string;
  /**
   * audio.cpp only: model keys too nested for flat rows (`voice_presets`,
   * `live_ingest`, …), preserved verbatim on export.
   */
  audioExtras?: Record<string, unknown>;
  isDefault: boolean;
}

export interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  params: Record<string, string>;
  paramOrder: string[];
}

export interface ModelsFile {
  configs: ModelConfig[];
  templates: ConfigTemplate[];
  defaultConfigId: string | null;
  configOrder?: string[];
}

export interface SystemStats {
  cpu: {
    overallPercent: number;
    coreCount: number;
    activeCores: number;
    perCore: number[];
  };
  ram: {
    usedBytes: number;
    totalBytes: number;
  };
  disk: {
    usedBytes: number;
    totalBytes: number;
    readMBs: number | null;
    writeMBs: number | null;
  };
}

/** A log line with its parsed level (for color-coding). */
export interface LogEntry {
  raw: string;
  /** Parsed log level, or 'plain' when the line is not structured */
  level: 'I' | 'W' | 'E' | 'F' | 'plain';
  /** Engine instance the line came from (process-scoped streams only). */
  instanceId?: string;
  /** Display name of the originating instance (merged log view only). */
  instanceLabel?: string;
}

/** Engine kinds that can be spawned (mirrors src/server/engines/types.ts). */
export type EngineKind =
  | 'llamacpp'
  | 'strata'
  | 'audio'
  | 'sdiffusion'
  | 'embeddings'
  | 'moderation'
  | 'videos'
  | 'default'
  | 'custom';

export const ENGINE_KIND_LABELS: Record<EngineKind, string> = {
  llamacpp: 'llama.cpp',
  strata: 'strata',
  audio: 'audio.cpp',
  sdiffusion: 'stable-diffusion.cpp',
  embeddings: 'embeddings',
  moderation: 'moderation',
  videos: 'videos',
  default: 'default',
  custom: 'custom',
};

/** A named build folder + environment, reusable across instances. */
export interface EngineDefinition {
  id: string;
  name: string;
  kind: EngineKind;
  buildPath: string;
  envVars: Record<string, string>;
}

/** One CLI argument: key + optional value (flag-only when value is undefined).
 * `disabled` keeps the row in the config but excludes it from the launch. */
export interface EngineParam {
  key: string;
  value?: string;
  disabled?: boolean;
}

/** A launchable engine instance, with its live process status. Server options
 * (--host/--port/--api-key, ...) are ordinary params, not dedicated fields. */
export interface EngineInstance {
  id: string;
  name: string;
  /** Free-form notes shown in the editor (not part of the launch). */
  notes: string;
  /** Engine family this instance belongs to; decides which editor opens. */
  kind: EngineKind;
  definitionId: string;
  binary: string;
  params: EngineParam[];
  routerMode: boolean;
  modelConfigIds: string[];
  modelPath?: string;
  mmproj?: string;
  /** Start this engine when the application boots (all kinds). */
  autoLaunch: boolean;
  /** strata only: self-contained engine/server/vision config. */
  strata?: StrataConfig;
  /** audio.cpp only: self-contained server config (see AudioConfig). */
  audio?: AudioConfig;
  /** Live process status, added by GET /api/engines. */
  status?: 'stopped' | 'starting' | 'running' | 'exited' | 'error';
}

/**
 * Strata engine config (mirrors src/server/engines/types.ts). Three layers in
 * one JSON file: the strata engine binary + its `strata generate` flags, the
 * `serve/server.py` server options, and an optional vision encoder. `extra`
 * holds keys the UI has no field for, preserved verbatim on export.
 * The deployment keys (`exe`, `cwd`, `tokenizer`, `model_name`) are ordinary
 * rows in `serverArgs`, keyed by their config name.
 */
export interface StrataConfig {
  engineArgs: EngineParam[];
  serverArgs: EngineParam[];
  vision: StrataVisionConfig | null;
  extra: Record<string, unknown>;
}

/**
 * The config's "vision" object: strata-vision encoder settings. An ordered row
 * list like the engine/server groups — keys are config keys (`exe`, `gpu`,
 * `elastic_mib`, …), so any of them can be added, edited, disabled or reordered.
 */
export interface StrataVisionConfig {
  args: EngineParam[];
}

/**
 * audio.cpp launch config (mirrors src/server/engines/types.ts).
 * `audiocpp_server` reads one JSON file holding the server options plus the
 * `models[]` array, so the block is self-contained like strata's. Rows in
 * `serverArgs` are keyed by the JSON key verbatim (`host`, `port`, `backend`,
 * …); `modelConfigIds` selects model cards carrying `type: 'audio'`; `extra`
 * preserves keys the UI has no field for (`live_ingest`, `frontend_options`, …).
 */
export interface AudioConfig {
  /** Process environment (`CUDA_VISIBLE_DEVICES=0`, …) — audio instances have
   * no shared definition to carry it, so the block owns it. The executable is
   * the instance's `binary` (full path); the working directory is its folder,
   * derived by the server — there is no separate cwd field. */
  envVars: Record<string, string>;
  serverArgs: EngineParam[];
  /** Launch with `--parallel-jobs` (audio.cpp's experimental parallel
   * runtime). A CLI flag, not a config key, so it is a field not a row — and
   * it gates the per-model `slots` row, which the server rejects without it. */
  parallelJobs?: boolean;
  modelConfigIds: string[];
  extra: Record<string, unknown>;
}

export interface EnginesResponse {
  definitions: EngineDefinition[];
  instances: EngineInstance[];
  defaultInstanceId: string | null;
}

/** Live model performance status extracted from print_timing log lines. */
export interface ModelStatusData {
  // PROMPT row
  promptProgress: number | null;      // 0..1 during prefill
  promptTokens: number | null;        // tokens in prompt
  promptSpeed: number | null;         // prompt tokens/s
  // GENERATION row
  genTokens: number | null;           // generated token count
  genAvgTps: number | null;          // avg generation t/s
  gen3sTps: number | null;           // last-3s window t/s
  genMsPerToken: number | null;      // ms per token (from eval-time)
  // SUMMARY row
  totalTimeMs: number | null;        // total time in ms
  totalTokens: number | null;        // total tokens (prompt + gen)
}

/** Proxy gateway settings (mirrors src/server/proxy/types.ts). */
export type ProxyBackendKind =
  | 'llamacpp'
  | 'strata'
  | 'audio'
  | 'sdiffusion'
  | 'embeddings'
  | 'moderation'
  | 'videos'
  | 'default'
  | 'custom';

export interface ProxyBackend {
  id: string;
  name: string;
  kind: ProxyBackendKind;
  baseUrl: string;
  enabled: boolean;
  apiKey?: string;
  /** Model ids discovered from the upstream's GET /v1/models (via Refresh). */
  models?: string[];
  modelsFetchedAt?: string;
  /** Set when the row mirrors a launched engine instance (kept in sync). */
  engineId?: string;
}

/** USD price per 1M tokens. */
export interface ModelPricing {
  input: number;
  cached: number;
  output: number;
}

export interface ProxySettings {
  enabled: boolean;
  autoStart: boolean;
  host: string;
  port: number;
  apiKey: string;
  usageRetentionDays: number;
  backends: ProxyBackend[];
  models: ProxyModelRoute[];
  /** USD price per 1M tokens keyed by model name. */
  modelPricing: Record<string, ModelPricing>;
}

export interface ProxyModelRoute {
  model: string;
  backend: string;
  backendModel?: string;
  enabled: boolean;
  auto?: boolean;
  /** True for the live route when several share the same alias. */
  active?: boolean;
}

/** One proxied request, as recorded by the usage store. */
export interface UsageRecord {
  id?: number;
  requestId: string;
  timestamp: string;
  model: string;
  backend: string;
  endpoint: string;
  stream: boolean;
  status: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  tokensEstimated: boolean;
  totalDurationMs: number;
  ttfbMs: number | null;
  tokensPerSec: number | null;
  clientIp: string;
  errorMessage: string | null;
  meta: Record<string, unknown> | null;
}

export interface UsageSummaryRow {
  model: string;
  backend: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  avgTokensPerSec: number | null;
  avgTtfbMs: number | null;
  lastUsed: string | null;
}

export interface ProxyStatus {
  running: boolean;
  url: string;
  /** backend id -> healthy */
  backends: Record<string, boolean>;
  models: ProxyModelRoute[];
}
