
# Features and Fixes for V0.2.0

> **Working agreement:** Do **not** commit code to Git without the user reviewing it first. Stage changes, show what will be committed, and wait for explicit approval before running `git commit`.

1. ~~Move 'ENVIRONMENT' side bar to a dialog box.~~ ✅
2. ~~Use Vitest and write test suite for all server side functionality.~~ ✅
3. ~~Add a clear logs button within the 'LOGS & METRICS' panel.~~ ✅
4. ~~Consider using SSE instead of websocket: review pros and cons with AI.~~ ✅
5. ~~Fix Config dialog box save, close, cancel buttons. It should not ask me if I want to cancel if I have just saved the changes.~~ ✅
6. ~~Add a view router.ini file/output button. Perhaps also add button to down it.~~ ✅
7. Within the Config dialog box allow the unknown parameters name to be edited as well. Also do not add '--' automatically, use what is given directly.
8. ~~Add comment headers to the router.ini file for each group of parameters.~~ ✅
9. ~~Add CPU and RAM usage, maybe disk as well if not too difficult.~~ ✅
10. Add the 'temperature' argument along with 'load-mode' with the dropdown options.
11. Add the ability to point to different llama.cpp builds for each model or when running.
12. Add the ability to run multiple llama.cpp instances for different models and builds (need review).
13. ~~Auto launch browser with the correct url when the application is launched from an executable.~~ ✅
14. ~~Create a collapsed mode, fix the title tool bar scaling, maybe move the versions somewhere else.~~ ✅
15. Add metrics / llama.cpp log parsing and some data extractions. Perhaps add coloring to identify error and warnings.
16. Add the ability to order the model configs list. Order is persistent and stored within the settings.

17. Add information about the model such as size, etc.
18. when selecting models preload them from the model's folder and allow user to to auto complete when selecting.
19. ~~When a boolean (toggle) argument is unchecked, set it to `off` in the preview and export instead of commenting it out.~~ ✅

---

## 1. Move 'ENVIRONMENT' side bar to a dialog box ✅

**Current behavior**
- The Environment panel lives in the left column (`App.vue`), stacked above the GPU Monitor.
- It has two states: a compact view (a `⚙ Environment` header with an `✎ Edit` button) and an edit state where `EnvironmentConfig.vue` expands to fill that panel.
- The app already has a modal dialog pattern in `ConfigList.vue` (`.editor-overlay` / `.editor-dialog` / `.dialog-header` / `.dialog-body` / `.dialog-footer`) that we can reuse for consistency.

**Proposed sub-tasks**
1. **Remove the Environment panel from the left column** — delete the `env-panel` section and the `editingEnv` state from `App.vue`, so the GPU Monitor becomes the only item in the left column (it will now fill the full height).
2. **Add a trigger button** — place an "Environment" button in the model configs list header where the other buttons are, that opens the dialog.
3. **Wrap `EnvironmentConfig.vue` in a modal dialog** — reuse the existing `.editor-overlay` / `.editor-dialog` styling so it matches the Config editor dialog (header with title + close ×, scrollable body, footer with Cancel/Save). Dialog width: 760px (same as Config editor).
4. **Move Save/Cancel into the dialog footer** — currently `EnvironmentConfig.vue` renders its own save row; lift those buttons into the shared dialog footer for consistency with the Config editor.
5. **Close-on-escape / close-on-backdrop-click** — match the existing dialog behavior (clicking the backdrop or pressing Esc closes it).
6. **Keep `@saved` → `fetchVersion`** so the llama.cpp version badge refreshes after saving, as it does today.

**Decisions**
- Trigger location: model configs list header (where other buttons are)
- Dialog width: 760px (reuse Config editor width)
- Read-only summary: No — go straight into the editable form when opened

## 2. Use Vitest and write test suite for all server side functionality ✅

**Note:** Server-side tests are complete (63 tests). Client-side component testing (Vue components with `@vue/test-utils` + jsdom) is still to be done.

## 3. Add a clear logs button within the 'LOGS & METRICS' panel ✅

**Note:** The client-side Clear button only clears the local view. A `POST /api/logs/clear` endpoint now exists to also wipe the server's in-memory log cache (prevents replay on reconnect), but it is **not yet wired to the client**. Link the Clear button to call this endpoint when ready.

## 4. Consider using SSE instead of websocket: review pros and cons with AI. ✅

**Decision: Switched to SSE.** The WebSocket was used exclusively as a one-way server→client push channel (gpu-stats, log-line, log-history, metrics, model-metrics, process-status). All user actions already go over REST, so no client→server channel was needed.

**Why SSE wins here:**
- Built-in browser reconnection with backoff (removed manual `setTimeout(connect, 2000)` logic)
- No `ws` dependency (removed from package.json)
- Simpler server code: no WebSocketServer / client set / readyState checks — just `res.write()` to open responses
- Proxy/LB friendly (no HTTP upgrade handshake)
- Semantically correct: SSE is designed for exactly this push-stream use case

**Implementation:**
- Server: `GET /api/events` returns a `text/event-stream`; clients tracked in a `Set<ServerResponse>`; `broadcast()` writes `event: <type>\ndata: <json>\n\n`. Log history replayed on connect.
- Client: `EventSource('/api/events')` with per-event `addEventListener` handlers in `App.vue` and `ConfigList.vue`.

**Trade-off accepted:** SSE is one-directional and text-only — both fine for this app. If bidirectional real-time comms are ever needed, WebSocket can be re-introduced alongside.

## 5. Fix Config dialog box save, close, cancel buttons. It should not ask me if I want to cancel if I have just saved the changes. ✅

**Fix:** Replaced the `JSON.stringify` snapshot comparison (which desynced from Vue's reactive proxies and kept reporting "modified" after a save) with an explicit `dirty` flag — set by a deep watch on edits, cleared on successful save. Both the × header and Cancel/Close buttons now close cleanly right after saving.

## 6. Add a view router.ini file/output button. Perhaps also add button to down it.

## 7. Within the Config dialog box allow the unknown parameters name to be edited as well. Also do not add '--' automatically, use what is given directly.

## 8. Add comment headers to the router.ini file for each group of parameters.

**Note:** While writing tests, discovered that `exportRouterIni` writes user notes *before* the `[Alias]` header, but `parseRouterIni` only collects comments as notes *inside* a section. This means notes don't survive a parse→export round-trip. Should be fixed alongside this item (e.g., move notes inside the section, or teach the parser to handle pre-section comments).

## 9. Add CPU and RAM usage, maybe disk as well if not too difficult. ✅

**Plan:**

### Data sources (all Node built-in, zero dependencies, zero process spawning)

| Metric | Method | Cost per tick | Cross-platform? |
|--------|--------|---------------|-----------------|
| CPU % (overall + per-core) | `os.cpus()` delta between samples | ~0 (in-memory arithmetic) | ✅ Linux, macOS, Windows |
| RAM used/total | `os.totalmem()` / `os.freemem()` | ~0 (kernel query) | ✅ All |
| Disk space used/total/% | `fs.statfs('/')` (Node 18.15+) | 1 syscall (~µs) | ✅ All |
| Disk I/O read/write MB/s | Parse `/proc/diskstats`, compute delta | 1 file read (~µs) | ⚠️ Linux only |

### CPU display design

- **Primary line:** Overall % (aggregate across all cores) + horizontal bar, same style as GPU utilization.
- **Secondary:** Row of thin per-core vertical bars (2-3px wide each), one per core, showing individual usage.
  - Color-coded: green <50%, yellow 50-80%, red/orange >80%
  - "Active cores" count (>5% threshold) shown as text, e.g. "12/16 active"
- Per-core data comes free from the same `os.cpus()` call — zero extra cost.

### Disk I/O (Linux only)

- Parse `/proc/diskstats`, keep previous sample, compute:
  - `readMB/s = (Δsectors_read × 512) / Δtime`
  - `writeMB/s = (Δsectors_write × 512) / Δtime`
- Show "—" on non-Linux platforms.

### Architecture

- New file: `src/server/system.ts` — exports `querySystem(): Promise<SystemStats>` and `startSystemPolling(onStats, intervalMs)` (same pattern as `gpu.ts`).
- New SSE event type: `system-stats`.
- New component: `src/client/components/SystemMonitor.vue` — placed in the left column below GPU Monitor.
- Types added to `src/server/types.ts` and `src/client/types.ts`.

### SystemStats interface

```ts
interface SystemStats {
  cpu: {
    overallPercent: number;   // aggregate 0-100
    coreCount: number;        // total cores
    activeCores: number;      // cores above 5% threshold
    perCore: number[];        // array of 0-100, one per core
  };
  ram: {
    usedBytes: number;
    totalBytes: number;
  };
  disk: {
    usedBytes: number;
    totalBytes: number;
    readMBs: number | null;   // null on non-Linux
    writeMBs: number | null;
  };
}
```

## 10. Add the 'temperature' argument along with 'load-mode' with the dropdown options.

**Plan:**
- Confirm the default param catalog includes `--temp`/`temperature` and the missing `--load-mode` flag with a typed dropdown so the config editor can render it correctly.
- Add a server-side regression test that checks `DEFAULT_PARAMS` exposes the expected keys and option list.
- Update `src/server/params-default.ts` with the missing load-mode values and preserve the existing `temp` preset defaults.
- Verify the relevant tests and project builds still pass.

## 11. Add the ability to point to different llama.cpp builds for each model or when running.

**Merged into item 21** (LLM Engines, Phase 2 — engine definitions).

## 12. Add the ability to run multiple llama.cpp instances for different models and builds (need review).

**Reviewed — merged into item 21** (LLM Engines, Phase 1). See `docs/llm-engines.md`.

## 13. Auto launch browser with the correct url when the application is launched from an executable. ✅

**Plan:**
- Add `openBrowser(url)` in `src/server/index.ts` using platform-specific commands:
  - macOS: `open <url>`
  - Windows: `cmd /c start "" <url>`
  - Linux: `xdg-open <url>` (falls back silently if no DE)
- Call it inside the `server.listen()` callback so the URL is live when the browser hits it
- **Release-only:** detect compiled binary via `Bun.embeddedFiles` — dev mode won't auto-open
- **Opt-out:** `NO_BROWSER=1` env var suppresses the launch (for headless/SSH)
- **Non-fatal:** if the spawn fails, log a hint ("Open http://localhost:3001 manually")

**Cross-OS notes:**
- Works on macOS, Windows, and Linux desktops. Linux headless/SSH will fail silently (acceptable).
- The executable itself is per-platform (Bun `--compile` targets the host OS/arch) — pre-existing constraint.

**Bonus: Chrome "Install as App" (PWA)**
- Serve a Web App Manifest (`/manifest.json`) with `name`, `short_name`, `start_url`, `display: "standalone"`, and an icon
- Add `<link rel="manifest">` to the HTML
- Chrome will show the install icon in the address bar → user gets a standalone app window (no tabs, own taskbar icon)
- No service worker needed for a local always-running app
- Complements auto-launch: first run opens browser → user installs as app → subsequent runs feel native

## 14. Create a collapsed mode, fix the title tool bar scaling, maybe move the versions somewhere else. ✅

**Implemented:** Compact-mode toggle (◫/▢) in the header, persisted to localStorage. In compact mode the title hides and the right column (configs + logs) is removed, leaving the left monitor column at its natural 400px width — GPU cards are unchanged. The version badge now has a max-width with ellipsis so it never breaks the header layout.

## 15. Add metrics / llama.cpp log parsing and some data extractions. Perhaps add coloring to identify error and warnings.

**Log line format (llama.cpp structured output):**
```
[35799] 11.40.276.622 I slot print_timing : id 0 | task 5813 ...
```
Fields: `[PID] timestamp LEVEL component function : message`

**Plan (incremental, one step at a time):**

### Step 1: Server-side log parser (`src/server/logParser.ts`)
- New module that exports `parseLogLine(line: string): ParsedLog | null`
- Regex to match the structured format: `/^\[(\d+)\]\s+([\d.]+)\s+([IWEF])\s+(\S+)\s+(\S+)\s*:\s*(.*)$/`
  - Group 1: PID
  - Group 2: timestamp (seconds since epoch, e.g. `11.40.276.622`)
  - Group 3: level (`I`=info, `W`=warning, `E`=error, `F`=fatal)
  - Group 4: component (e.g. `slot`, `llama`, `server`)
  - Group 5: function/source (e.g. `print_timing`, `load_model`, `init_from_params`)
  - Group 6: message (free text after the colon)
- If the line does NOT match → return `null` (caller passes through as plain text)
- Export a `ParsedLog` interface with all fields

### Step 2: Function-specific message parsers
- For known `function` values, parse the message into structured data:
  - `print_timing` → extract tokens/s, prompt eval time, generation time, token counts
  - `load_model` / `init_from_params` → extract model size, layer count, memory usage
  - (extend as needed)
- Each parser returns a typed object or `null` if the message doesn't match expected sub-format
- These structured extractions feed into the existing metrics system (replacing/augmenting the current regex-based approach in `llama.ts`)

### Step 3: SSE event enrichment
- Modify the log line broadcast to include parsed metadata alongside raw text
- New SSE event shape: `{ type: 'log-line', data: { raw: string, parsed: ParsedLog | null } }`
- Backward compatible: client still renders `raw` as the visible text

### Step 4: Client-side coloring (`LogView.vue`)
- Color-code each log line based on `parsed.level`:
  - `I` (info) → default/white
  - `W` (warning) → yellow/amber
  - `E` (error) → red
  - `F` (fatal) → bright red / bold
- Unparsed lines (no structure) → dimmed gray (de-emphasized noise)
- CSS classes: `.log-line.info`, `.log-line.warning`, `.log-line.error`, `.log-line.fatal`, `.log-line.plain`

### Step 5: Metrics extraction from parsed logs
- Replace the current `PREFILL_RE` / `GEN_RE` / `GEN_LOOP_RE` regexes in `llama.ts` with calls to the new parser
- When `function === 'print_timing'`, extract timing data from the structured message
- Keep existing metrics SSE event shape unchanged

### Step 6: Model Status panel (client-side) ✅

**Layout:** Three horizontal rows below System Monitor, each with a small uppercase header label and inline metrics:

```
┌──────────────────────────────────────────────────────────┐
│  MODEL STATUS                                            │
├──────────────────────────────────────────────────────────┤
│  PROMPT                                                  │
│  ▓▓▓▓▓▓▓▓░░ 82%   5,436 tok   882 t/s                    │
├──────────────────────────────────────────────────────────┤
│  GENERATION                                              │
│  1,247 tokens   avg 74.9 t/s   3s 75.2 t/s   13.6 ms/tok│
├──────────────────────────────────────────────────────────┤
│  SUMMARY                                                 │
│  Total 5.57 s   Prompt 2.24 s   Gen 3.33 s   1,198 tok  │
└──────────────────────────────────────────────────────────┘
```

**Data flow:**
- Server: `onLogLine` calls `parseTimingMessage` on structured lines; when timing data is found, updates an in-memory `modelStatus` object and broadcasts a new SSE event `model-status`.
- Client: `App.vue` listens for `model-status`, stores in a ref, passes to `<ModelStatus>` component.
- Component: `src/client/components/ModelStatus.vue` — renders the 3 rows with live values; shows "—" placeholders when no data.

**Behavior:**
- PROMPT row: progress bar animates during prefill (from `prompt-progress` events), freezes at 100% with final speed on completion (`prompt-eval`).
- GENERATION row: token count and speeds tick up in real-time (from `gen-stats`); ms/token from `eval-time`.
- SUMMARY row: populated only after a request completes (`total-time` + `prompt-eval` + `eval-time`).
- When no model is running or no data yet: all values show dimmed "—".

**Verification after each step:** user reviews output before proceeding to next.

## 16. Add the ability to order the model configs list. Order is persistent and stored within the settings.

**Implementation plan:**
- Add a persisted model-order field alongside the existing saved model data in the server-side models file so list ordering survives reloads and app restarts.
- Update the config loading path to restore the saved order before rendering the list, and keep the default selection aligned with the ordered array.
- Add a simple UI control in each model row (arrow buttons or drag handle) that reorders the list in place without changing nested config values.
- Save the reordered array immediately after each move so the order is durable and consistent with the rest of the model settings.
- Add a focused regression test to confirm reordering is persisted and restores correctly from disk.
- After implementation, capture a screenshot of the ordered list in the app and confirm the saved order still exists after a page refresh.
- If browser tooling is available, record a brief interaction video showing the list reorder and persistence behavior.

**Expected UX:**
- The model list shows in the selected order.
- Reordering is persistent across refreshes.
- The launch-check and config editing actions continue to work normally.
- No config data is lost or mutated except for the display order of the top-level list.

**Test plan:**
- Add a server-side regression test covering persisted model ordering: after reordering the configs array, the saved data contains the new config order and reloads into that same sequence.
- Add a client-side interaction test (if Vue test utilities are used) that verifies a drag/drop reorder changes the list order without breaking selection or launch checkboxes.
- Run the focused model-ordering tests first, then the full suite (`npm run test`) and the client/server build checks before the feature is considered complete.

**Notes for implementation:**
- Prefer server-backed persistence over browser-only localStorage so the order is treated as part of the config state rather than ephemeral UI state.
- Keep the change minimal and scoped to the model-list ordering feature; avoid changing route logic or launch behavior.
- The app already stores config metadata centrally, so the cleanest approach is to extend that existing saved objects model rather than bolt on a separate ordering store.
- For the client UI, reuse the same native HTML5 drag-and-drop ordering pattern already used for config arguments in `ConfigEditor.vue`: drag from a handle only, drop beneath a target row, and reorder with a splice-based move. This keeps the interaction consistent with the rest of the app instead of introducing a different control style.
- The model list should persist the final order back through the same server save path used for model data so reloads restore the exact sequence.

## 19. When a boolean (toggle) argument is unchecked, set it to `off` in the preview and export instead of commenting it out. ✅

**Previous behavior**
- In `exportRouterIni` (`src/server/routerIni.ts`) and the client-side `previewIni` computed (`ConfigEditor.vue`), when a param value was `'off'` and not in `disabledParams`, it was written as a comment: `# key = off`.
- The export command omitted off-toggles entirely (returned `null`).

**Fixed behavior**
- Unchecked toggles now appear as active `key = off` lines in both the INI preview/export and the CLI export command (`--key off`).
- Only params explicitly disabled by the user (in `disabledParams`) are written as comments.

**Changes made**
1. `src/server/routerIni.ts` — removed the special-case branch that wrote `# key = off`; now falls through to the normal `key = value` path.
2. `src/client/components/ConfigEditor.vue` — same fix in `previewIni` computed; `exportCommand` now emits `--key off` instead of omitting.
3. `src/server/__tests__/routerIni.test.ts` — updated test to assert `load-on-startup = off` is present (not commented).

## 20. OpenAI-compatible proxy server with model routing and usage tracking 🚧

Full specification: [docs/proxy-server.md](./proxy-server.md)

**Goal:** A lightweight OpenAI-compatible reverse proxy in front of llama.cpp (router mode),
audio.ccp, and stable-diffusion.cpp. Routes requests by the `model` field to the right
backend and records per-request input/output tokens, timing (total, TTFB, tokens/sec), and
timestamp into SQLite.

**Progress (branch `feat/proxy-server`):**

- ✅ Phase 1 — Usage store: `src/server/proxy/usageDb.ts` (node:sqlite, WAL, `user_version`
  migrations, insert/query/summary/purge) + `usageDb.test.ts` (6 tests).
- ✅ Phase 2 — Proxy core: `src/server/proxy/index.ts` (Express app on its own port,
  `/health`, `GET /v1/models`, passthrough forwarding via `node:http` piping, optional
  Bearer auth, `X-Proxy-Request-Id`), `router.ts` (exact/prefix/path-fallback resolution),
  `recorder.ts` (t0/TTFB/end timing, `stream_options.include_usage` injection, buffer-safe
  SSE usage scanner, JSON `usage` extraction, estimated-token fallback), `tokenCount.ts`.
  Tests: `proxyRouter.test.ts` (8), `proxyRecorder.test.ts` (11), `proxy.test.ts` (12,
  supertest against a real stub upstream replaying realistic llama.cpp responses).
- ✅ Phase 3 — Settings & wiring: `ProxySettings` embedded in `LlamaConfig`
  (`.config/settings.json`), registry rebuilt on every model-config change, daily retention
  purge, SSE `proxy-usage` / `proxy-log` broadcast events. Management API:
  `GET/PUT /api/proxy/settings`, `POST /api/proxy/start|stop|restart`,
  `GET /api/proxy/status` (per-backend health probes),
  `GET /api/proxy/usage` (+ `/summary`, `/export` CSV), `POST/PUT/DELETE /api/proxy/models`,
  `POST/PUT/DELETE /api/proxy/backends`. Tests: `proxyApi.test.ts` (14).
- ✅ Dynamic backends: `backends` is now a user-managed list (`ProxyBackend[]` with
  id/name/kind/baseUrl/enabled/apiKey) — llama.cpp is a regular entry, custom upstreams
  supported; legacy fixed-key shape auto-migrates. `backends.ts` helpers, router resolves
  by backend id, disabled backends block their routes and fallbacks.
- ✅ Model discovery: per-proxy ⟳ Refresh button probes upstream `GET /v1/models`
  (`POST /api/proxy/backends/:id/refresh`), lists discovered models as chips under the row,
  and registers them as auto routes — multiple llama.cpp instances route by model name
  (declared routes/aliases win on conflicts). Tests cover discovery routing + endpoint.
- ✅ Cached tokens & cost: captures `usage.prompt_tokens_details.cached_tokens` (JSON + SSE)
  into a `cached_tokens` column (usage.db v2, auto `ALTER TABLE` migration from v1); summary
  and CSV export include it. `ProxySettings.modelPricing` stores USD per 1M tokens
  (input/cached/output) per model; Usage panel shows Cache + Cost columns, a total Cost
  metric, and a 💵 Pricing dialog. Cost = `((in − cached)·inPrice + cached·cachedPrice +
  out·outPrice) / 1e6`.
- ✅ GUI (Proxy tab): header with Start/Stop/Restart + status badge, settings row
  (Port/Host/API Key/Retention + Auto-start), proxy list with enable checkboxes, edit
  dialogs (name/type/url/upstream key/enabled) and delete, collapsible Proxy Logs panel,
  and a bottom Usage panel (`ProxyPanel.vue`, `ProxyUsagePanel.vue`) styled like Logs & Metrics.
- ✅ E2E smoke (manual): real proxy + real upstream over HTTP — streaming passthrough is
  byte-identical, usage rows land in SQLite, summary aggregates correctly.

**Remaining:**
- [ ] Phase 0 — Spike audio.ccp and stable-diffusion.cpp HTTP APIs; capture real fixtures
      under `src/server/__tests__/fixtures/proxy/` (open questions §13 of the spec).
- [ ] Phase 4 — stable-diffusion.cpp translator (`/v1/images/generations` is routed and
      recorded already; upstream translation pending the Phase 0 spike).
- [ ] Phase 5 — audio.ccp translators (`/v1/audio/*` passthrough pending spike).
- [ ] Phase 6 extras — usage export pagination for >1000 rows.
- [x] ~~Phase 7 — GUI "Proxy & Usage" panel~~ — shipped as the Proxy tab (see above).
- [ ] Verify `node:sqlite` works in the Bun-compiled release binary (spec §13.4).

**Verification so far:** `npx vitest run` 170/170, `npx tsc -p tsconfig.server.json --noEmit`
clean, `npx vite build` clean. Shipped in v0.4.0 (proxy feature) and v0.5.0 (cached tokens,
pricing & cost).

## 21. LLM Engines — multiple engine instances, builds, and kinds 🚧

Full specification: [docs/llm-engines.md](./llm-engines.md)

**Goal:** spawn and monitor **multiple engine instances**, each with its own executable,
parameters, env vars, and port. Generic starter (executable + env key/value pairs +
params as `{ key, value? }`), with a llama.cpp-only block for router/model config.
Supersedes items 11 and 12 and the Next Phase bullets for audio.cpp /
stable-diffusion.cpp / strata.

**UI direction (agreed, spec §6):** new **Engines** tab with one row per instance
(`▸` drawer summary, `▶/⏹` start/stop, `⚙` configure dialog, `⧉` duplicate), the Logs &
Metrics panel gains an instance selector (`All` merged + instance tag), header status
badge becomes aggregate. Models tab stays as the config library.

### Phase 1 — multi-instance, llama.cpp only (start here)

1. ✅ **Data model + storage** (`src/server/engines/types.ts`, `src/server/engines/store.ts`)
   - `EngineDefinition { id, name, kind, buildPath, envVars }` and
     `EngineInstance { id, name, definitionId, port, host, apiKey, params[], modelConfigIds[], routerMode }`
     — params as `{ key, value? }[]` (flag-only when `value` is undefined).
   - New `.config/engines.json` with `loadEngines()/saveEngines()/normalizeEngines()`
     following the `modelConfig.ts` pattern.
   - **Non-destructive migration:** when `engines.json` is absent and `settings.json`
     still has `llamaCppPath`/`port`, synthesize one `default` definition + one default
     instance from it. Legacy fields are kept, not deleted.
   - Tests: round-trip, migration from legacy `settings.json`, port conflict detection.

2. ✅ **Process registry** (`src/server/engines/manager.ts`)
   - Replace the `const llama = new LlamaProcessManager()` singleton in `index.ts` with
     an `EngineManager` holding `Map<instanceId, ManagedInstance>`;
     `LlamaProcessManager` stays mostly intact and becomes the per-instance worker.
   - Per-instance log cache (replaces the single `logCache`); `stopAll()` wired into
     `/api/shutdown` and `/api/restart`.
   - Port auto-assign + conflict check against other instances, the GUI port, and the
     proxy port.
   - Tests: launch/stop two instances, per-instance status isolation, non-zero exit →
     `error` status for that instance only.

3. ✅ **`instanceId` through SSE + REST**
   - Payloads become `{ instanceId, … }` for `log-line`, `process-status`, `metrics`,
     `model-status`; `log-history` sends per-instance history.
   - `GET /api/engines`, `POST/PUT/DELETE /api/engines/:id`,
     `POST /api/engines/:id/launch|stop`; keep `/api/launch`, `/api/stop`, `/api/status`
     as aliases bound to the default instance during transition.
   - `modelStatus` and `metricsPoller` state keyed per instance.
   - Tests: extend `api.test.ts` — two instances produce separate log streams and statuses.

4. ✅ **Client: Engines tab** (mockup before implementing, per `agent.md`)
   - `src/client/components/EngineList.vue` — rows + inline drawer + `⚙` dialog
     (reuse `ui/Dialog.vue`), `+ New engine` with kind dropdown.
   - Generic starter form: executable path + validate, port, env key/value rows, params
     rows (key-only vs key+value), llama.cpp block (router mode + model selection reusing
     the checkbox pattern from `ConfigList.vue`).
   - `LogView.vue` instance selector (`All` merged with an instance tag column).
   - Header aggregate badge (`2 running / 1 stopped`) replacing the single status.

### Phase 2 — multiple engine definitions (builds) → old item 11 ✅
Environment dialog now edits the **list of engine builds** (definitions): add/edit/remove,
kind dropdown, per-build env rows, and per-definition validation
(`GET /api/engines/definitions/:id/version` — llama.cpp runs the `llama-server --version`
probe, other kinds check folder existence until Phase 3 drivers land).
The legacy single `llamaCppPath`/`envVars` fields were dropped from the dialog but stay
in `settings.json` untouched (migration compatibility). Host/port/API key remain there as
defaults for new instances. Host-level probes (`/api/devices`, CUDA matching,
`/api/version`) and the legacy launch endpoints follow the **default definition's** build
folder, so there is one source of truth.

**Not done (deliberately):** per-model-config `definitionId`. In the engines model a build
is chosen by the *instance*, so "different builds per model" is expressed as one instance
per build — adding `definitionId` to model configs would reintroduce a second source of
truth. Revisit if a per-model build override is actually wanted.

### Phase 3 — engine kind drivers ✅
`EngineDriver` interface (`src/server/engines/driver.ts`: binary name, `buildArgs`,
optional `getVersion` / `listDevices` / `parseLogLine` / `toLogEntry` /
`metricsSource`); all llama.cpp logic (version probe, device listing, CUDA matching,
log parsing + print_timing, arg building) moved to `engines/llama.ts`; the process
layer is now the neutral `ProcessWorker` (`engines/worker.ts`) with the driver
injected per instance from the definition's kind — `LlamaProcessManager`,
`src/server/llama.ts` and `src/server/logParser.ts` are gone. Passthrough driver
(`engines/passthrough.ts`) makes custom/unknown kinds launchable: the instance's
binary runs from the definition's build folder with its params, raw logs, no
version probe/metrics/proxy. Per-kind param catalogs: `GET /api/params?kind=<k>`
reads `params.<kind>.json` when present (llama.cpp keeps `params.json`; other
kinds fall back to it until their own catalog exists). `/api/version/check` and
`/api/engines/definitions/:id/version` now probe through the kind's driver.

### Phase 3.5 — engine = generic spawner (UI refinement) ✅
The engine model dropped its special-cased fields: `EngineInstance` is now
**executable + env vars + ordered params** only — `host`, `port` and `apiKey`
were removed and are ordinary `--host` / `--port` / `--api-key` params, so no
kind gets preferential treatment.
- **Editor:** the Host/Port/API Key inputs are gone; the params list is the only
  place they exist (the single full-path **Executable** field from the previous
  step stays, splitting into definition `buildPath` + instance `binary`).
- **Templates:** `GET/PUT /api/engines/templates/:kind` read/write
  `.config/params.<kind>.template.json` (`params.template.json` for llama.cpp,
  same convention as the param catalogs). A template is an ordered `EngineParam[]`
  auto-filled when a new instance is created; the llama.cpp seed is
  `--host/--port/--api-key` + a curated slice of the params catalog defaults,
  other kinds start empty. `blankInstance()` nudges the template `--port` to a
  free port.
- **Launch:** `instanceToLlamaConfig()` reads host/port/api-key back out of the
  params into the legacy spec fields (Models tab + `/api/launch` unchanged), and
  `buildLlamaArgs()` skips its own injection when `extraArgs` already names the
  flag — each flag appears exactly once, including in router mode.
- **Port checks** (`isPortTaken`/`findFreePort`/instance CRUD 409) and the
  Engines list `:port` column read the `--port`/`-p` param (`instancePort()`).
- **Migration:** `normalizeInstance()` folds pre-upgrade `host`/`port`/`apiKey`
  fields from an existing `engines.json` into params (existing params win);
  `migrateLegacyConfig()` prefixes them instead of setting fields.
- **Fully generic dialog:** the configure dialog is now just name + kind +
  executable + env vars + params — the "llama.cpp options" block (router mode,
  model/mmproj paths) and the Build/Definition dropdown are gone from the UI
  (model selection stays on the Models tab; definition switching deferred).
  Path validation runs for every kind (kinds without a probe report folder
  existence). `routerMode`/`modelConfigIds`/`modelPath`/`mmproj` stay on the
  instance — the PUT only touches fields present in the body.
- **Notes + Command tab:** instances carry a free-form `notes` string shown under
  the name in the dialog (and copied by Duplicate). The dialog body is split into
  **Launch** (executable/env/params) and **Command** tabs; the latter shows the
  exact command line a launch would run — env assignments, the resolved binary
  path and the driver-built args, one flag/value pair per line with `\`
  continuations, styled like the model config Export tab. `POST /api/engines/command`
  composes it from the *draft* in the dialog through the same driver path as a
  real launch, and flags a missing executable.
- **Catalog-driven parameter editor:** the params section borrows the model
  config editor wholesale. Each engine kind's catalog
  (`GET /api/params?kind=` → `.config/params.<kind>.json`, llama.cpp =
  `params.json`) supplies grouping, descriptions, input types (number/select/
  path/preset/comma-list), dropdown options and defaults. Rows render grouped by
  category in the instance's own order, are drag-reorderable (handle-based
  native DnD), and value rows get an **on/off** include toggle backed by a new
  optional `disabled` flag on `EngineParam` — a disabled row stays in the config
  but is excluded from the launch (`paramsToArgs`), the launch spec fields and
  port allocation (`paramValue`/`instancePort`), and the Engines list port
  column. Flags not in the catalog land in an **Unknown** group with plain
  value inputs; "+ Add Parameter" opens a searchable catalog picker (already
  added flags hidden), "+ Custom Flag" and "Paste args…" keep the free-form
  escape hatches.
- **No hidden launch args:** engine instances launch strictly from their
  parameter list. `instanceToLlamaConfig` marks the spec `paramsOnly`, and
  `buildLlamaArgs` then emits only the model selection (`-m`/`--mmproj`) or the
  router preset plus the instance's own params — the old unconditional
  `-c 4096 -ngl 99 -b 512 -ub 512` and the `--host`/`--port`/`--api-key`
  fallbacks are skipped, so the Command tab and the real spawn agree exactly.
  Legacy `POST /api/launch` (settings.json) leaves the flag unset and keeps the
  default injection. `paramValueAny`/`paramFlagAliases` resolve a flag under
  any accepted spelling (`--port`/`-p`, `--ctx-size`/`-c`, …) for port lookup.
- **strata kind + catalog:** `strata` is a valid engine/proxy kind, with a
  144-entry parameter catalog at `.config/params.strata.json` (generated from
  `docs/strata-parameters.md`) served by `GET /api/params?kind=strata`. It uses
  its own categories (`model`, `ple`, `kv`, `experts`, `cpu`, `serve`,
  `prefill`, `steering`, `native`, `debug`); `ParamCategory` is an open string
  union and the editor appends catalog-only categories after the llama.cpp ones,
  so each kind's JSON controls its own grouping. No strata driver yet — it
  launches through the passthrough driver (Phase 4 will add log parsing/version).

### Phase 4 — real non-llama kinds
audio.cpp, stable-diffusion.cpp drivers + auto-registration as proxy backends.
Blocked on the proxy Phase 0 spike (fixtures for their HTTP APIs).

**audio.cpp kind ✅** — driver (`engines/audioDriver.ts`: `--config` spawn plan,
`--version` banner probe, level-classified logs), typed model cards, generated
`.config/audio-<id>.json` on launch (docs/audio.md). **Proxy auto-registration:**
every audio instance is mirrored into the proxy backend list
(`ProxyBackend.engineId`); name/port follow the instance, the selected cards'
aliases ride as discovered `models[]` (the ids `audiocpp_server` reports on
`GET /v1/models`), and the mirror is dropped when the instance is deleted.
`/v1/audio/*` routes to it by model name, `audio/`/`tts/` prefix or path
fallback — no manual backend row or Refresh needed.

**strata kind ✅** — the first *specialized* engine kind: a strata deployment is
described by one JSON file (`strata-<model>.json`) covering the `strata` engine
binary + `strata generate` flags, the `serve/server.py` HTTP options, and an
optional `vision` encoder, so it is **self-contained** (no shared definition).
- **Data model:** `EngineInstance` gained a self-describing `kind` (a `''` value
  falls back to the definition's kind, so existing files keep working) and
  `autoLaunch` on **every** kind. A `StrataConfig` block (`engineArgs[]` /
  `serverArgs[]` / `vision` / `extra`) lives on the instance in `engines.json`;
  several strata configs can run side by side. The deployment keys (`exe`, `cwd`,
  `tokenizer`, `model_name`) are ordinary `serverArgs` rows keyed by their config
  name — `serve/server.py` reads them straight from the config, not from flags.
- **Mapping** (`engines/strata.ts`): lossless import/export of the real file shape.
  Unknown keys (`gpus_asked`, `gpu_order`, `layer_split`, `lib_dirs`, `log`,
  `sampling`, …) ride in `extra` untouched, so import → export is byte-equivalent
  in content. `port` is modelled as a `--port` server row because `serve/server.py`
  reads it **only** from the CLI, never the config.
- **Driver** (`engines/strataDriver.ts`): a `buildLaunch` spawn plan — the worker
  layer stays generic while strata runs `python -m serve.server --engine strata
  --config <generated.json> --port <p>` from the repo root. `--host`/`--api-key`
  are deliberately not repeated (the server reads them from the config). Log level
  coloring + prefill/generation tok/s metrics included.
- **Launch:** the launch endpoint writes `.config/strata-<id>.json` from the block
  (same pattern as the router INI), so the Command tab and the real spawn agree.
  `autoLaunchEngines()` starts every `autoLaunch` instance on server startup.
- **API:** `POST /api/engines/strata/import`, `POST /api/engines/strata/render`,
  `GET /api/engines/instances/:id/strata/export`,
  `GET /api/engines/instances/draft?kind=` (unsaved draft — an engine is only
  created on Save), `GET /api/params/strata-server` (the fixed `serve/server.py`
  option catalog), and `kind`/`autoLaunch`/`strata` on instance POST/PUT.
- **UI:** `+ New Engine` is now a **kind dropdown** (`llama.cpp` / `strata` /
  custom); picking a kind fetches a draft and opens the matching dialog, and
  nothing is written until Save. `StrataEditor.vue` edits basics + Server (first
  tab, deployment rows included) / Engine / Vision tabs, an **Other Keys** raw-JSON
  tab for `extra`, Import/Export of the strata file, and a Command preview.
  `ui/ParamRows.vue` is the shared
  catalog-driven row editor (grouping, add-from-catalog, custom flag, paste args,
  drag-reorder, on/off toggle) reused by both editors.
- **Tests:** `strata.test.ts` (mapping round-trip + driver) and a `Strata Engine
  API` block in `api.test.ts` (draft, import, create, PUT round-trip, export,
  render, command preview, launch writing the generated file, port conflicts).

**Open questions to resolve before remaining Phase 4 kinds** (spec §4): audio.cpp /
sd.cpp HTTP vs CLI-only, per-instance GPU allocation UX.

## 22. Serve the llama.cpp Web UI from the GUI server 🚧

**Goal:** expose llama.cpp's own Web UI (`tools/ui/`) from this app so it can be opened
next to the GUI, without running a separate `llama-server` just for the UI.

### Approach rejected — proxy passthrough (reverted 2026-10-22)

A first attempt made the OpenAI proxy (`src/server/proxy/index.ts`) forward llama.cpp's
own routes to the `llamacpp` backend, so `http://<proxy>:8090/` served the UI that
`llama-server` embeds in its binary. It worked end to end (all 70 files of
`build/tools/ui/dist` and all 51 `index.html` refs resolved through the proxy, query
strings preserved, no usage rows polluted), but it was reverted:

- It couples the **OpenAI gateway** to a **browser UI**. The proxy's job is model routing +
  usage capture; making it a static file host and a second management API is scope creep.
- It inherits llama.cpp's auth split. Only `index.html` + assets are keyless upstream
  (`get_public_endpoints` in `tools/server/server-http.cpp`), so the proxy had to mirror
  that exactly or leak `/props`, `/slots`, `/completions`, `/tokenize` unauthenticated.
  Fragile to track across llama.cpp releases.
- The UI's model list is answered by the proxy (`GET /v1/models` → all registered models,
  including SD/audio), but Load/Unload/Delete/`/models/sse` are llama-only paths. So the
  picker shows non-llama models that cannot be managed — confusing half-support.
- It only works for a running llama.cpp backend, which is the case least in need of the UI.

### Chosen approach — serve the build output directly

Serve the UI's static build from the **GUI server** (`src/server/index.ts`, port 1535)
out of a llama.cpp checkout's `build/tools/ui/dist`, rather than proxying a live
`llama-server`'s embedded copy.

Why this build tree: `llama.cpp` provisions it via `scripts/ui-assets.cmake` — an `npm`
build when configured with `BUILD_UI=ON`, otherwise a verified `dist.tar.gz` from the
`ggml-org/llama-ui` Hub bucket (`.ui-stamp` records `ggml-org/llama-ui|b11601`). It is
already on disk at `<llama.cpp>/build/tools/ui/dist` (~10 MB, 70 files) and needs no
C++ embedding step. `adapter-static` with `bundleStrategy: 'single'` means the app is one
`index.html` + one hashed `bundle.js` + one hashed `bundle.css`, hash-routed
(`router: { type: 'hash' }`), so serving it is a plain static mount.

**Blocker to solve first — inconsistent endpoint prefixes.** The UI's
`src/lib/constants/api-endpoints.constants.ts` mixes `./`-relative (`./v1/chat/completions`,
`./props`, `./slots`, `./v1/stream`) with root-absolute (`/models`, `/models/load`,
`/v1/models`, `/models/sse`, `/tools`, `/cors-proxy`) paths, resolved against
`window.location.href`. Proven empirically: serving under `/ui` sends `./props` to
`/ui/props` while `/models` still goes to `/models` — the API splits in half. Options:

- [ ] Serve at the **root of a dedicated port** (no base path) so both prefix styles land
      on the same origin — simplest, no UI patching. Decide: new port, or reuse the proxy
      port at `/` (rejected above) vs a third listener.
- [ ] Or rebuild the UI with SvelteKit `paths.base = '/ui'` so the constants agree —
      requires owning a UI fork/build, and the root-absolute constants are *not* rewritten
      by `paths.base`, so this alone is not sufficient.
- [ ] Either way the GUI server must also **forward the UI's API calls** to the selected
      engine (`/props`, `/slots`, `/models*`, `/models/sse`, `/v1/chat/completions/control`,
      `/v1/stream`, `/tokenize`, `/tools`) — static files alone are not enough. Scope that
      forwarding to the GUI server's `/api`-style surface, not the OpenAI proxy.
- [ ] Pick which engine instance the UI talks to (per-instance from the Engines tab, item
      21) and how the `--api-key` of that instance is injected.
- [ ] Setting for the llama.cpp build path already exists per engine definition
      (`buildPath`) — derive `build/tools/ui/dist` from it, with a fallback/override.

**Related:** the Next Phase bullet about proxying to each backend's own UI page
(audio.cpp, stable-diffusion.cpp, strata) is the same problem shape — one static/UI
mount per engine kind, plus per-instance API forwarding.


# Next Phase

- ~~Ability to to map model names so I don't have to keep changing them in apps.~~
- ~~Add embeddings, images, videos, etc to the proxy server. ~~
- ~~Move Usage to bottom status panel.~~
- ~~The number of tokens in the usage status does not match in the proxy usage  also review the cost.~~
- ~~Move the usage panel from within the proxy tab into it's own tab.~~
- ~~Add a refresh icon next to the title version to check if there is a new version available. This checks the github releases and if there is a new version available, it will show an upgrade icon with the latest version and clicking it will go to the github release page. Clicking on the upgrade icon will download the new version and replace the current version. Also add a restart button next to the shutdown button.~~
- ~~Restart the service/program~~
- ~~Usage status panel add settings gear icon to provide a setting of the max number of last used models within the list bellow. Something similar to the GPU monitor settings icon where it expands down the options. Also make the title size similar to the System monitor and also the same padding as the system monitor so that more space is given to the content.~~
- ~~When refreshing version if there is no new version then show latest in the pill.~~
- ~~Add strata configuration and startup within the app. → item 21 Phase 4~~
- ~~Ability to start other .ccp apps with configs such as audio.cpp and stable-diffusion.ccp → item 21 Phase 4~~

- Ability to delete usage input.
- Add configuration backup process.
- The title bar has 'STARTING' which is always the same. Replace it with the current status of the models, and proxy.
- For the different internal proxy services create a new url to proxy to the main pages of each UIs such as audio.cpp and stable-diffusion.cpp, llama.cpp or strata. Also show a button for each to jump to the main page of each UI.
- Keep track of watts used for each active gpu for each request, average, and add a cost to the power including different times of day power and calculate the power usage in real time.

- 






