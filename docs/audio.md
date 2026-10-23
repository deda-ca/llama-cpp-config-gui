# audio.cpp engine — integration spec

Status: **decided — ready to implement** (design choices locked 2026-10-23).
Everything under "Engine facts" is verified against
the source checkout at `~/Programs/AI/audio.cpp` (upstream
`https://github.com/0xShug0/audio.cpp`, HEAD `d3ab9df2`, 2026-10-04, clean tree).
File references are paths in that repo. The "GUI design" section is the
agreed design for this app; follow-ups are listed at the end.

---

## 1. Engine facts

### 1.1 Binary & launch

- Built binary: `audio.cpp/build/bin/audiocpp_server` (~159 MB, built 2026-10-04).
- The user's current start script (`~/Programs/AI/audio-cpp-start.sh`):

  ```bash
  nohup env CUDA_VISIBLE_DEVICES=0 ./audio.cpp/build/bin/audiocpp_server \
      --config audio-cpp.json > audio-cpp.log 2>&1 &
  ```

  run from `~/Programs/AI` (the *parent* of the `audio.cpp` checkout).
- `--config <server.json>` is **required** unless `--ui` is given
  (`app/server/main.cpp`: "missing required --config argument").
- Unlike llama.cpp, **models can only come from the JSON file** — no CLI flag
  adds one. The JSON is the whole launch story, like strata's
  `strata-<model>.json`.

### 1.2 CLI flags (`app/server/main.cpp`, `print_help`)

Every server option below can also be set in the JSON; the CLI value wins
(applied after the file is loaded).

| Flag | JSON key | Notes |
|---|---|---|
| `--config <path>` | — | required; the server config file |
| `--ui` / `--no-ui` | `ui` | embedded WebUI (default on when a config is loaded) |
| `--ui-management` | `ui_management` | model install/delete endpoints; needs build flag `AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER=ON` |
| `--host <ip>` | `host` | default `127.0.0.1` |
| `--port <port>` | `port` | default `8080` |
| `--backend cpu\|cuda\|hip\|rocm\|vulkan\|metal` | `backend` | default `cuda`; `rocm` = alias of `hip` |
| `--device <id>` | `device` | default `0` |
| `--threads <n>` | `threads` | default `1`; must be > 0 |
| `--busy-timeout-ms <ms>` | `busy_timeout_ms` | default `300000`; 0 disables |
| `--max-loaded-models <n>` | `max_loaded_models` | default `0` (no limit); LRU-unloads idle models past the cap |
| `--idle-unload-ms <ms>` | `idle_unload_ms` | default `0` (disabled) |
| `--min-free-memory-mb <mb>` | `min_free_memory_mb` | default `0` (guard off) |
| `--cors-origins <origins>` | `cors_origins` | only `*` or `""` accepted (validated) |
| `--model-spec-override <json-or-dir>` | `model_spec_override` | path |
| `--voice-dir <dir>` | `voice_dir` | shared reference-voice library (wav + `prompt_text` map) |
| `--frontend-listener <name>` | `frontend_listener` | e.g. `https`, `websocket` |
| `--frontend-option key=value` | `frontend_options{}` | repeatable; requires a listener |
| `--log` / `--log-file <path>` | — | debug logging (not in the JSON) |
| `--parallel-jobs` | — | experimental parallel runtime; enables per-model `slots` |
| `--list-devices` | — | prints backend devices and exits (device listing hook) |
| `--version` | — | build version/commit/compiler/backends (version probe hook) |

Validation errors that abort startup (`main.cpp` + `config.cpp`):
`threads <= 0`, `busy_timeout_ms < 0`, `max_loaded_models < 0`,
`idle_unload_ms < 0`, `min_free_memory_mb < 0`, `port` outside 1..65535,
`cors_origins` not `*`/`""`, `frontend_options` without a listener,
`slots` present without `--parallel-jobs`, missing/empty `models` array
(unless `ui_management` is on).

### 1.3 Config JSON — server-level keys (`app/server/config.cpp`, `ServerConfig` in `config.h`)

```jsonc
{
  "host": "0.0.0.0",              // string,  default "127.0.0.1"
  "port": 5455,                   // int,     default 8080
  "backend": "cuda",              // string,  default "cuda"
  "device": 0,                    // int
  "threads": 8,                   // int,     default 1
  "lazy_load": true,              // bool,    default false; per-model default for "lazy"
  "cors_origins": "*",            // string,  default ""
  "ui": true,                     // bool,    default true
  "ui_management": false,         // bool
  "log_request_body": false,      // bool
  "max_request_body_bytes": 2147483648, // int ≤ 2^53-1, default 2 GiB
  "busy_timeout_ms": 300000,      // int ≥ 0
  "max_loaded_models": 0,         // int ≥ 0
  "idle_unload_ms": 0,            // int ≥ 0
  "min_free_memory_mb": 0,        // int ≥ 0
  "live_ingest": {                // fleet-wide streaming-body policy; all ints ≥ 0
    "idle_timeout_ms": 0, "total_timeout_ms": 0,
    "max_body_bytes": 0, "max_chunk_bytes": 0, // max_chunk_bytes must be > 0
    "send_timeout_ms": 0
  },
  "model_spec_override": "path",  // resolved against the config file's folder
  "voice_dir": "path",            // resolved against the config file's folder
  "frontend_listener": "https",
  "frontend_options": { "key": "value" }, // values must be strings
  "models": [ /* required, see §1.4 */ ]
}
```

Unknown top-level keys are ignored by the parser (safe to preserve on
round-trip). Wrongly-typed known keys fall back to the default silently
(`optional_string`/`optional_i32`/`optional_bool`), except `live_ingest` and
`max_request_body_bytes`, which throw.

### 1.4 Config JSON — `models[]` entries (`ServerModelConfig`)

```jsonc
{
  "id": "qwen3-asr",              // required string — the name clients request
  "family": "qwen3_asr",          // required string — model family (see model_specs/)
  "path": "models/Qwen3-ASR/…gguf", // required; relative → resolved against the CONFIG FILE's folder
  "task": "asr",                  // string, default "tts"  (⚠ see §1.6)
  "mode": "streaming",            // "offline" (default) | "streaming"
  "lazy": false,                  // bool, default = server lazy_load
  "slots": 2,                     // int 1..16 — only with --parallel-jobs, else parse error
  "busy_timeout_ms": 600000,      // int ≥ 0, per-model override of the server value
  "live_ingest": { /* any subset of the server block, per-model override */ },
  "model_spec_override": "path",  // resolved against the config file's folder
  "config": "id", "weight": "id", // built-in utility model references (config_id/weight_id)
  "load_options":    { "k": "v" }, // string→string map, passed to the loader
  "session_options": { "k": "v" }, // string→string map, per session
  "default_request_options": { "k": "v" }, // e.g. a standing TTS "instruction"
  "voice_presets": {              // name → preset; each needs voice_id | voice_ref | reference_text
    "cosette": { "voice_id": "cosette" },
    "clone1":  { "voice_ref": "refs/a.wav", "reference_text": "…" }
  },
  "default_voice_preset": "cosette" // preset name, or an inline preset object
}
```

`voice_ref` inside presets is also resolved against the config file's folder.

Task vocabulary (from `app/cli/main.cpp` help — the CLI's list; the server
stores `task` as an opaque string):
`vad asr diar sep gen tts clon vc s2s align vdes spk svc midi`
(`clon` = voice cloning, `vdes` = voice design).

### 1.5 Path resolution (matters for the generated file)

`load_server_config()` resolves every relative path (`models[].path`,
`voice_dir`, `model_spec_override`, preset `voice_ref`) against **the config
file's parent directory** — *not* the process cwd. The server's cwd is used
elsewhere (upload/temp handling), and the user runs it from `~/Programs/AI`.

Consequence for the GUI: if we generate `.config/audio-<id>.json`, relative
model paths would resolve against `.config/` — wrong. Two safe options:

- **A.** Emit **absolute** paths in the generated file (simplest, always correct).
- **B.** Keep the generated file in `.config/` but rewrite relative paths
  against a user-set "base folder" row.

Proposal: **A** — the editor stores whatever the user typed; the generator
resolves against the instance's base folder and writes absolute paths.

### 1.6 Known discrepancy: `task` as an array

The user's live `~/Programs/AI/audio-cpp.json` uses `"task": ["tts","clon","vdes"]`.
The upstream parser (`config.cpp:318`) reads `task` via `optional_string`, so an
array is **silently ignored** and the model falls back to `task: "tts"`. No
commit in the repo's history ever parsed `task` as an array. So today that
array is decorative — the model runs as `tts` (which happens to be the first
element, so behavior matches by luck).

GUI decision: model `task` as a **single select** over the vocabulary above;
preserve an imported array verbatim in `extra` so import→export never loses
data (same "unknown keys ride along" rule strata uses).

### 1.7 HTTP surface (for proxy/log awareness)

Endpoints (`print_help`): `/` (WebUI), `/health`, `GET /v1/models`,
`POST /v1/audio/speech`, `/v1/audio/speech/live`, `/v1/audio/transcriptions`,
`/v1/batches/transcriptions`, `/v1/audio/alignments`,
`/v1/audio/transcriptions/live`, `/v1/tasks/run`, `/v1/tasks/batch`,
`GET /v1/audio/voices?model=<id>`, plus `/v1/ui/*` model-management routes
when `ui_management` is on. It is OpenAI-compatible for audio routes, which is
why the proxy already has an `audio` backend kind.

Log output: plain text; startup prints model loading lines; `--parallel-jobs`
prints a big WARNING block. No structured perf lines like llama.cpp's
`print_timing` were found — the driver should start with level-classified
plain lines and no metrics extraction.

---

## 2. GUI design (decided 2026-10-23)

Decisions:
1. **Models come from the Models tab.** `ModelConfig` gains a `type`
   (`llamacpp` | `audio` | `sdiffusion` | …, default `llamacpp`). The type
   decides which parameter catalog the card edits and what the generated
   output looks like. An audio engine instance selects which audio model
   configs go into its JSON — the same selection UX as llama.cpp router mode.
2. **Audio instances are fully self-contained** (like strata): no
   `EngineDefinition`. The executable and the run folder are rows/fields on
   the instance.
3. **Per-model option maps live on the model card** (decision 1): a typed
   model config carries its own `load_options` / `session_options` /
   `default_request_options` / voice presets, so the engine instance only
   picks ids — no per-instance model editing.

### 2.1 Typed model configs (`models.json`)

`ModelConfig` (src/server/modelConfig.ts) gains:

```ts
interface ModelConfig {
  // …existing fields…
  /** Engine family this card configures; decides catalog + output shape. */
  type?: 'llamacpp' | 'audio' | 'sdiffusion' | (string & {}); // default 'llamacpp'
}
```

- Default `'llamacpp'` keeps every existing card working unchanged; the
  router INI path ignores `type` and keeps using llama.cpp params.
- **Audio card fields**: `alias` doubles as the audio model `id` (what clients
  request), `modelPath` is the `path`, and the audio keys (`family`, `task`,
  `mode`, `lazy`, `busy_timeout_ms`, `slots`, …) are ordinary `params` rows
  keyed by the JSON key verbatim (`family`, `task`, `mode`, …) — the same
  "row name = config key" rule strata's deployment/vision rows use.
- **Option maps on the card**: `load_options.*` / `session_options.*` /
  `default_request_options.*` as prefixed rows (`load_options.language =
  english`), which the generator groups back into nested objects. Voice
  presets are the one nested shape too fiddly for flat rows: stored in a new
  `audioExtras?: { voice_presets?, default_voice_preset?, live_ingest?, … }`
  raw-JSON block on the card, preserved verbatim (mirrors `StrataConfig.extra`).
- **Catalogs**: `GET /api/params/audio-model` (model-key catalog) and
  `GET /api/params/audio-server` (server-key catalog) drive the card's
  "+ Add" list per type. `ConfigEditor.vue` picks the catalog by `type`.
- `includeInLaunch` already exists on cards — the audio engine's model picker
  filters `models.json` by `type === 'audio'` (and optionally `includeInLaunch`).

### 2.2 Audio instance block (`EngineInstance.audio`)

Self-contained, like `strata?:`:

```ts
interface AudioConfig {
  /** Run folder (the folder holding audio.cpp/, models/) — launch cwd. */
  cwd: string;
  /** Executable: absolute path, or resolved against cwd. Default
   * `audio.cpp/build/bin/audiocpp_server` relative to cwd. */
  exe: string;
  /** Server-level options as rows keyed by JSON key verbatim
   * (host, port, backend, device, threads, lazy_load, cors_origins, …). */
  serverArgs: EngineParam[];
  /** Model config ids (models.json, type 'audio') written into models[]. */
  modelConfigIds: string[];
  /** Keys with no UI field, preserved verbatim (live_ingest,
   * frontend_options, frontend_listener, …). */
  extra: Record<string, unknown>;
}
```

Row values keep JSON types through the existing `parseConfigValue` /
`formatConfigValue` helpers (`threads: 8`, `lazy_load: true`).

### 2.3 Generated file

- `.config/audio-<instanceId>.json`, written on every launch (like
  `strata-<id>.json` / `router-<id>.ini`), removed on rename/delete via
  `removeGeneratedFiles()`.
- Contents = `audioToConfig(block, modelConfigs)`: server rows → top-level
  keys, `models[]` built from the selected audio model cards, `extra` merged,
  **paths emitted absolute** (§1.5 option A — the generator resolves relative
  paths against the instance's `cwd`).
- Launch: `<exe> --config <generated>.json` with `cwd = AudioConfig.cwd`
  (matches the user's script; `CUDA_VISIBLE_DEVICES` rides in per-instance
  env vars — see §3 note).

- `.config/audio-<instanceId>.json`, written on every launch (like
  `strata-<id>.json` / `router-<id>.ini`), removed on rename/delete via
  `removeGeneratedFiles()`.
- Contents = `audioToConfig(block)`: server rows → top-level keys, `models`
  array from the model blocks, `extra` merged, **paths emitted absolute**
  (§1.5 option A).
- Launch command: `<buildPath>/audiocpp_server --config <generated>.json`
  with `cwd = AudioConfig.cwd` (matches the user's script; `CUDA_VISIBLE_DEVICES`
  rides in the definition's envVars or a per-instance env later).

### 2.4 Server modules

| File | Role (strata counterpart) |
|---|---|
| `src/server/engines/audio.ts` | block ↔ file JSON both ways, `normalizeAudioConfig`, `blankAudioConfig`, `audioConfigPath(id)`, `audioPort(block)`, model-card → `models[]` entry builder (counterpart of `strata.ts`) |
| `src/server/engines/audioDriver.ts` | `EngineDriver` kind `'audio'`: `buildLaunch` (command/args/cwd), `toLogEntry` level rules, `--version` probe, `--list-devices` (counterpart of `strataDriver.ts`) |
| `src/server/engines/audioServerParams.ts` | fixed `ParamDef[]` catalogs: `AUDIO_SERVER_PARAMS` (server keys) + `AUDIO_MODEL_PARAMS` (model-card keys), from §1.2/§1.3/§1.4 (counterpart of `STRATA_SERVER_PARAMS`) |
| `src/server/engines/types.ts` | `AudioConfig` interface; `defaultBinaryForKind('audio') = 'audiocpp_server'` |
| `src/server/engines/store.ts` | `normalizeInstance` folds `i.audio` through `normalizeAudioConfig`; `instancePort` falls back to `audioPort` |
| `src/server/modelConfig.ts` | `ModelConfig.type` + `audioExtras`, normalized defensively (default `'llamacpp'`) |
| `src/server/index.ts` | `buildLaunchSpec` writes the JSON for kind `audio` (selected audio models required non-empty, like strata's repo-folder check); `/api/params/audio-server` + `/api/params/audio-model`; import/render endpoints `/api/engines/audio/import` + `/api/engines/audio/render`; draft/POST treat `audio` as self-contained like `strata` |
| `src/server/engines/driver.ts` | register `audioDriver` |

`params.audio.json` (user-editable, `.config/`) is **not** needed: the audio
server's options are fixed by its parser, exactly like strata's server catalog
ships in code. (llama.cpp's file exists because that CLI is huge and
user-refreshable.) The fixed catalog ships as `AUDIO_SERVER_PARAMS` /
`AUDIO_MODEL_PARAMS`.

### 2.5 Client

- `src/client/types.ts`: mirror `AudioConfig`; `ModelConfig.type` +
  `audioExtras`.
- `ConfigEditor.vue` / `ConfigList.vue` (Models tab): type dropdown on
  create (llama.cpp | audio.cpp | …); catalog + param groups switch by type;
  audio cards show the audio keys and an `audioExtras` raw-JSON block;
  the list shows a type badge so mixed kinds stay readable.
- `src/client/components/AudioEditor.vue` (new, modeled on `StrataEditor.vue`):
  - Header: Engine Name, Notes, **Executable** (default
    `audio.cpp/build/bin/audiocpp_server`), **Run folder (cwd)**, autoLaunch
    checkbox, **Import audio JSON… / Export audio JSON** buttons.
  - Tabs: **Server** (server rows, catalog-driven) |
    **Models** (picker over `type === 'audio'` model cards — same UX as the
    llama.cpp Router tab: filter, select-all-visible, clear) |
    **Other Keys** (raw JSON of `extra`) | **Command** (preview via
    `POST /api/engines/command` with `kind: 'audio'`).
- `EngineList.vue`: add `'audio'` to `creatableKinds`; open `AudioEditor` for
  kind `audio`; `portOf()` also reads the audio `port` row; duplicate handles
  the `audio` block.
- Engine rename/id logic already handles generated-file cleanup — audio just
  joins `removeGeneratedFiles()`.

### 2.6 Tests

- `audio.test.ts`: block ↔ file round-trip (user's `audio-cpp.json` as
  fixture, including the `task` array preserved verbatim), model-card →
  `models[]` builder (prefixed option rows regrouped, absolute paths),
  `normalizeAudioConfig` defensiveness.
- `modelConfig.test.ts`: `type` + `audioExtras` normalization, default
  `'llamacpp'` for old files.
- `api.test.ts`: draft/POST/PUT round-trip of the `audio` block; launch writes
  `.config/audio-<id>.json` with the selected models; rename removes the stale
  file; `/api/params/audio-server` + `/api/params/audio-model` endpoints;
  creating a model config with `type: 'audio'`.

---

## 3. Follow-ups (not blocking v1)

1. **Per-instance env vars** (`CUDA_VISIBLE_DEVICES=0`): definitions carry
   `envVars`, but audio is self-contained with no definition. v1 can put the
   device in the `device` row (audio.cpp's own key); a per-instance env map is
   a separate small feature.
2. **Proxy**: `audio` is already a `ProxyBackendKind`; wiring an audio engine
   into the proxy backend list is out of scope here.
3. **`--parallel-jobs` / `slots`**: experimental upstream; the generator
   refuses `slots` rows unless a `parallel_jobs` server row is on (mirrors the
   parse error), or simply leaves `slots` to `extra` in v1.
4. **stable-diffusion.cpp**: same typed-card pattern will apply later; keep
   `ModelConfig.type` open-ended.
