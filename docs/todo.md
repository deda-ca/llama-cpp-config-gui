
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

## 11. Add the ability to point to different llama.cpp builds for each model or when running.

## 12. Add the ability to run multiple llama.cpp instances for different models and builds (need review).

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