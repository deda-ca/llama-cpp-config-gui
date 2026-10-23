/**
 * Parameter catalogs for the audio.cpp engine (docs/audio.md §1.2–§1.4).
 *
 * `audiocpp_server`'s options are fixed by its own parser
 * (`app/server/config.cpp`, `ServerConfig` / `ServerModelConfig`), so — like
 * the strata server catalog — these lists ship with the app rather than
 * living in a user-editable `.config/params.<kind>.json`. The `flag` is the
 * row name the editor shows; for audio these are the **config keys verbatim**
 * (`host`, `port`, `family`, `task`, …), not CLI flags, because the models and
 * server options are read from the JSON file. (`audiocpp_server` does accept
 * CLI overrides for the server keys, but the generated file is the source of
 * truth, so a row writes the key.)
 *
 * `inputType: 'toggle'` rows are bare on/off keys; the rest take a value.
 */

import type { ParamDef } from '../modelConfig.js';

/** Server-level config keys, grouped as the AudioEditor's Server tab renders them. */
export const AUDIO_SERVER_PARAMS: ParamDef[] = [
  // --- Network ---
  { flag: 'host', key: 'host', label: 'Host', description: 'Address to listen on: 127.0.0.1 = this PC only, 0.0.0.0 = also other devices', category: 'network', inputType: 'text', default: '127.0.0.1' },
  { flag: 'port', key: 'port', label: 'Port', description: 'HTTP port to bind (1..65535)', category: 'network', inputType: 'number', default: '8080' },
  { flag: 'cors_origins', key: 'cors_origins', label: 'CORS Origins', description: "Experimental: '*' allows browser requests from any origin (trusted local demos only); '' disables. Only * or empty are accepted", category: 'network', inputType: 'text' },

  // --- Device / compute ---
  { flag: 'backend', key: 'backend', label: 'Backend', description: 'Inference backend (rocm is an alias for hip)', category: 'device', inputType: 'select', options: ['cuda', 'cpu', 'hip', 'vulkan', 'metal'], default: 'cuda' },
  { flag: 'device', key: 'device', label: 'Device', description: 'Backend device index to run on', category: 'device', inputType: 'number', default: '0' },
  { flag: 'threads', key: 'threads', label: 'Threads', description: 'CPU threads (must be positive)', category: 'device', inputType: 'number', default: '1' },

  // --- Load lifecycle ---
  { flag: 'lazy_load', key: 'lazy_load', label: 'Lazy Load', description: 'Load models on first request instead of at startup; also the per-model default for "lazy"', category: 'lifecycle', inputType: 'toggle', default: 'off' },
  { flag: 'max_loaded_models', key: 'max_loaded_models', label: 'Max Loaded Models', description: 'Keep at most N models resident, unloading the least-recently-used idle one first; 0 = no limit', category: 'lifecycle', inputType: 'number', default: '0' },
  { flag: 'idle_unload_ms', key: 'idle_unload_ms', label: 'Idle Unload (ms)', description: 'Unload every resident model after this many idle ms; 0 = disabled, next request reloads lazily', category: 'lifecycle', inputType: 'number', default: '0' },
  { flag: 'min_free_memory_mb', key: 'min_free_memory_mb', label: 'Min Free Memory (MiB)', description: 'Refuse a load unless host and GPU each keep this much free after it; 0 = guard off', category: 'lifecycle', inputType: 'number', default: '0' },
  { flag: 'busy_timeout_ms', key: 'busy_timeout_ms', label: 'Busy Timeout (ms)', description: 'Fail a request with 503 once the current run has held the model this long; 0 disables the guard', category: 'lifecycle', inputType: 'number', default: '300000' },

  // --- Paths / UI ---
  { flag: 'voice_dir', key: 'voice_dir', label: 'Voice Library Dir', description: 'Shared reference-voice library: *.wav files plus a prompt_text map, so a request "voice" name clones without voice_ref', category: 'paths', inputType: 'path' },
  { flag: 'model_spec_override', key: 'model_spec_override', label: 'Model Spec Override', description: 'JSON file or directory overriding model specs for every model', category: 'paths', inputType: 'path' },
  { flag: 'ui', key: 'ui', label: 'Embedded WebUI', description: 'Serve the built-in WebUI at / (on by default when a config is loaded)', category: 'paths', inputType: 'toggle', default: 'on' },
  { flag: 'ui_management', key: 'ui_management', label: 'WebUI Model Management', description: 'Enable /v1/ui model install/delete endpoints (needs AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER=ON at build time)', category: 'paths', inputType: 'toggle', default: 'off' },
];

/**
 * Model-card keys (a `models[]` entry). `alias`/`modelPath` on the card carry
 * `id`/`path`, so they are not rows here; the option maps
 * (`load_options.*`, `session_options.*`, `default_request_options.*`) are
 * prefixed rows added on demand, and the nested shapes (voice presets,
 * live_ingest, …) live in the card's raw-JSON extras block.
 */
export const AUDIO_MODEL_PARAMS: ParamDef[] = [
  { flag: 'family', key: 'family', label: 'Model Family', description: 'Model family the loader selects (see audio.cpp model_specs/)', category: 'identity', inputType: 'text' },
  { flag: 'task', key: 'task', label: 'Task', description: 'What the model does: tts speech, asr transcription, clon voice clone, vdes voice design, …', category: 'identity', inputType: 'select', options: ['tts', 'asr', 'clon', 'vdes', 'vc', 's2s', 'align', 'spk', 'svc', 'vad', 'diar', 'sep', 'gen', 'midi'], default: 'tts' },
  { flag: 'mode', key: 'mode', label: 'Mode', description: 'offline (whole-file) or streaming (live-ingest routes)', category: 'runtime', inputType: 'select', options: ['offline', 'streaming'], default: 'offline' },
  { flag: 'lazy', key: 'lazy', label: 'Lazy Load', description: 'Load this model on first request; defaults to the server lazy_load when unset', category: 'runtime', inputType: 'toggle', default: 'off' },
  { flag: 'busy_timeout_ms', key: 'busy_timeout_ms', label: 'Busy Timeout (ms)', description: 'Per-model override of the server busy timeout; 0 disables the guard', category: 'runtime', inputType: 'number' },
  { flag: 'slots', key: 'slots', label: 'Slots', description: 'Parallel slots (1..16): how many requests this model serves at once. Only emitted when the engine has "Parallel jobs" (--parallel-jobs) on in its Launch tab — audio.cpp rejects the key without the flag', category: 'runtime', inputType: 'number' },
];

/** Option-map row prefixes a model card can add (each becomes a nested object). */
export const AUDIO_MODEL_OPTION_ROWS: ParamDef[] = [
  { flag: 'load_options.<key>', key: 'load_options', label: 'Load Option', description: 'A loader option passed to the model loader (string value), e.g. load_options.language = english', category: 'options', inputType: 'text' },
  { flag: 'session_options.<key>', key: 'session_options', label: 'Session Option', description: 'A per-session option (string value), e.g. session_options.language = english', category: 'options', inputType: 'text' },
  { flag: 'default_request_options.<key>', key: 'default_request_options', label: 'Default Request Option', description: 'A standing request option applied unless the request overrides it, e.g. an instruction', category: 'options', inputType: 'text' },
];
