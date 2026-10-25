/**
 * Engine types for multi-instance engine launching (docs/llm-engines.md §2, §6).
 *
 * Three concepts:
 *  - EngineDefinition: a named, reusable build ("which executable + env vars"),
 *    generalizing today's single EnvironmentConfig (todo #11).
 *  - EngineInstance:  a launchable entry — a definition + executable/params/model
 *    selection. Launching spawns one child process tracked by instance id.
 *  - EngineParam:     one CLI argument. `value === undefined` means a flag-only
 *    key (e.g. `--metrics`); a string value is passed as key + value
 *    (e.g. `--host 0.0.0.0`). Empty string value is treated as "not set".
 *
 * Storage lives in `.config/engines.json` (see store.ts). Phase 1 only uses
 * kind 'llamacpp'; other kinds are accepted by the type but have no driver yet.
 */

import type { ProxyBackendKind } from '../proxy/types.js';

/** Engine families that can be spawned. Reuses the proxy backend vocabulary. */
export type EngineKind = ProxyBackendKind;

export const ENGINE_KINDS: EngineKind[] = [
  'llamacpp',
  'strata',
  'audio',
  'sdiffusion',
  'embeddings',
  'moderation',
  'videos',
  'default',
  'custom',
];

export function isEngineKind(v: unknown): v is EngineKind {
  return ENGINE_KINDS.includes(v as EngineKind);
}

/** A named build folder + environment, reusable across instances. */
export interface EngineDefinition {
  /** Stable slug id, derived from name on creation. */
  id: string;
  name: string;
  kind: EngineKind;
  /** Folder containing the engine executable (e.g. the llama.cpp build dir). */
  buildPath: string;
  /** Environment variables for spawned processes; empty-string values are skipped. */
  envVars: Record<string, string>;
}

/** One CLI argument on an instance: key + optional value (flag-only when absent). */
export interface EngineParam {
  /** Full flag as the user typed it, e.g. "--host" or "-ngl". */
  key: string;
  /** Argument value; undefined = flag-only (boolean switch). */
  value?: string;
  /** Row kept in the config but excluded from the launch (editor "off" toggle). */
  disabled?: boolean;
}

/**
 * Strata-specific launch config (kind 'strata'). A strata deployment is three
 * programs' worth of settings in one JSON file (`strata-<model>.json`), so it
 * gets its own self-contained block instead of the generic
 * definition+params shape: the strata engine binary and its `strata generate`
 * flags, the `serve/server.py` HTTP server flags, and an optional vision
 * encoder. Nothing is inherited from an EngineDefinition, so two strata
 * instances never affect each other (docs/todo.md #21, #22).
 *
 * The deployment keys (config `exe`, `cwd`, `tokenizer`, `model_name`) are
 * ordinary rows in `serverArgs` — `serve/server.py` reads them straight from
 * the config, so a row is keyed by the config name verbatim.
 *
 * `extra` preserves keys the UI has no field for (gpus_asked, gpu_order,
 * layer_split, lib_dirs, …) verbatim so an import/export round-trip never
 * loses data.
 */
export interface StrataConfig {
  /** `strata generate` flags — the config's "args" array as flat argv tokens. */
  engineArgs: EngineParam[];
  /** `serve/server.py` options (host, port, api_key, gpu, lazy_load, …) plus
   * the deployment keys (exe, cwd, tokenizer, model_name) as config-key rows. */
  serverArgs: EngineParam[];
  /** Vision encoder (config "vision"); null = no vision section. */
  vision: StrataVisionConfig | null;
  /** Config keys with no UI field, preserved verbatim and re-emitted on export. */
  extra: Record<string, unknown>;
}

/**
 * The config's "vision" object: strata-vision encoder settings. Like the
 * engine and server groups it is an ordered row list, so every key the encoder
 * understands (and any the UI has no catalog entry for) can be added, edited,
 * disabled or reordered. Values keep their JSON type through `parseConfigValue`
 * (`gpu: true`, `elastic_mib: 2048`), and a disabled row omits the key.
 */
export interface StrataVisionConfig {
  args: EngineParam[];
}

/**
 * audio.cpp launch config (docs/audio.md §2.2, docs/todo.md #21 Phase 4).
 *
 * `audiocpp_server` takes one JSON file holding everything — server options
 * plus the `models[]` array — and has no CLI flag that adds a model, so the
 * file is the whole launch story (like strata's `strata-<model>.json`). The
 * models themselves are ordinary model configs in models.json with
 * `type: 'audio'`; an instance selects them by id, exactly like llama.cpp
 * router mode selects model configs for its generated INI.
 *
 * `serverArgs` rows are keyed by the JSON key verbatim (`host`, `port`,
 * `backend`, `device`, `threads`, `lazy_load`, …) because these are config
 * keys, not CLI flags — the same rule strata's deployment/vision rows follow.
 *
 * `extra` preserves keys the UI has no field for (`live_ingest`,
 * `frontend_listener`, `frontend_options`, `log_request_body`, …) verbatim so
 * an import → export round-trip never loses data.
 */
export interface AudioConfig {
  /** Environment for the spawned process (`CUDA_VISIBLE_DEVICES=0`, …).
   * Audio instances have no EngineDefinition to carry env vars, so the block
   * owns them like every other launch setting. */
  envVars: Record<string, string>;
  /** Server-level config keys as ordered rows (host, port, backend, device,
   * threads, lazy_load, cors_origins, busy_timeout_ms, …). */
  serverArgs: EngineParam[];
  /** Launch with `--parallel-jobs`, audio.cpp's experimental parallel
   * runtime. A **CLI flag**, not a config key, so it is a field rather than a
   * row: `audiocpp_server` only reads it from the command line
   * (`app/server/main.cpp`). It also gates the per-model `slots` key — a
   * `slots` row is rejected by the server's parser unless this is on. */
  parallelJobs?: boolean;
  /** Model config ids (models.json entries with `type: 'audio'`) written into
   * the generated file's `models[]` array. */
  modelConfigIds: string[];
  /** Config keys with no UI field, preserved verbatim and re-emitted on export. */
  extra: Record<string, unknown>;
}

/**
 * stable-diffusion.cpp launch config (docs/stable-diffusion.md §3.1).
 *
 * sd.cpp has **no config file**, so `serverArgs` are plain `sd-server` flags
 * (keyed by the flag verbatim, unlike audio's config-key rows). Unlike
 * strata/audio there is no generated file, and unlike llama.cpp/audio the
 * weights are **not** on the command line: the server starts empty from its
 * `--model-dir` roots and models arrive over `POST /sdcpp/v1/models/load`,
 * which resolves catalog file-ids inside those roots — which is what makes
 * `--model-dir` a required row (§1.4.1).
 *
 * `modelConfigIds` selects model cards with `type: 'sdiffusion'`. sd-server
 * holds exactly one context, so this is a *selection list whose first entry is
 * loaded at startup*; the rest are swap candidates for the "Load model"
 * action (§3.10), not extra models to run side by side.
 *
 * `extra` preserves flags the UI has no row for, verbatim, so an
 * import/export round-trip never loses data (mirrors `AudioConfig.extra`).
 */
export interface SdConfig {
  /** Environment for the spawned process. Note: the GUI never sets
   * `CUDA_VISIBLE_DEVICES` for sd instances — the mask **renumbers** devices,
   * so a masked `CUDA0` is not the unmasked `CUDA0` that `--backend` names
   * (§5 Q5). Placement goes through `--backend`/`--params-backend`/`--max-vram`. */
  envVars: Record<string, string>;
  /** `sd-server` flags as ordered rows. `--listen-ip`, `--listen-port` and
   * `--model-dir` lead the Server tab (model-dir is what makes loading possible
   * at all); plus any Context/Default-Generation flag the user adds. Weight
   * flags are only emitted by the argv fallback (§3.3). */
  serverArgs: EngineParam[];
  /** Model config ids (models.json entries with `type: 'sdiffusion'`). Exactly
   * one is loaded at a time; the first selected card is loaded at startup. */
  modelConfigIds: string[];
  /** Flags with no UI row, preserved verbatim and re-emitted on export. */
  extra: Record<string, unknown>;
}

/** A launchable engine: definition + runtime settings + model selection. */
export interface EngineInstance {
  /** Stable slug id, derived from name on creation. */
  id: string;
  name: string;
  /** Free-form notes shown in the editor (not part of the launch). */
  notes: string;
  /** Engine family this instance launches (see EngineKind). Owned by the
   * instance so every engine is configured in isolation; files written before
   * this field existed fall back to their definition's kind. */
  kind: EngineKind;
  /** EngineDefinition this instance launches from ('' = self-contained, e.g. strata). */
  definitionId: string;
  /** Executable name inside the build folder (llama.cpp: "llama-server" | "llama-cli"). */
  binary: string;
  /** Ordered CLI parameters applied to every launch of this instance. Server
   * options (--host/--port/--api-key, ...) are ordinary params, not fields. */
  params: EngineParam[];
  /** llama.cpp only: launch in router mode with these model config ids. */
  routerMode: boolean;
  /** llama.cpp only: model config ids (models.json) used in router mode. */
  modelConfigIds: string[];
  /** llama.cpp only (non-router): single model path, .gguf. */
  modelPath?: string;
  /** llama.cpp only (non-router): multimodal projector file. */
  mmproj?: string;
  /** Start this engine when the application boots (all kinds). */
  autoLaunch: boolean;
  /** strata only: self-contained engine/server/vision config (see StrataConfig). */
  strata?: StrataConfig;
  /** audio.cpp only: self-contained server config (see AudioConfig). */
  audio?: AudioConfig;
  /** stable-diffusion.cpp only: self-contained server config (see SdConfig). */
  sd?: SdConfig;
}

export interface EnginesFile {
  definitions: EngineDefinition[];
  instances: EngineInstance[];
  /** Instance used by the legacy /api/launch, /api/stop, /api/status aliases. */
  defaultInstanceId: string | null;
}

export const EMPTY_ENGINES: EnginesFile = {
  definitions: [],
  instances: [],
  defaultInstanceId: null,
};

/** Default executable per kind (used when creating new instances). */
export function defaultBinaryForKind(kind: EngineKind): string {
  switch (kind) {
    case 'llamacpp':
      return 'llama-server';
    case 'strata':
      // serve/server.py is a Python module, so the "executable" is the
      // interpreter the driver runs `-m serve.server` with.
      return 'python3';
    case 'audio':
      // audiocpp_server is a single binary; the instance names it (absolute
      // path, or resolved against the audio block's cwd — audio is
      // self-contained, so there is no definition build folder to join).
      return 'audiocpp_server';
    case 'sdiffusion':
      // sd-server is a single binary, named by the instance with a full path
      // (same self-contained rule as audio; docs/stable-diffusion.md §3.4).
      return 'sd-server';
    default:
      return '';
  }
}
