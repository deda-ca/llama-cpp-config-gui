# Agent Collaboration Guide

> This file defines how the AI agent and user work together on this project.
> At the start of a new session, reference this file to restore the working flow.

## Working Agreements

- **Never commit without explicit user approval.** Stage changes → show what will be committed → wait for "go ahead and commit."
- **One step at a time.** User verifies each step before proceeding to the next.
- **Show layout/mockup before implementing UI changes.** ASCII art or description first, get approval, then code.
- **Use real data for testing.** Actual log lines from live model runs, not synthetic examples.
- **Screenshot visual changes** so the user can confirm without switching windows.
- **Don't over-engineer.** Keep solutions minimal and idiomatic to the existing codebase.

## Development Workflow

1. **Plan** — Add detailed sub-tasks to `docs/todo.md` under the relevant numbered item. Include data sources, architecture notes, and verification steps.
2. **Implement** — Write code + tests together in the same step. Tests use real captured fixtures.
3. **Verify** — Run full test suite (`npx vitest run`) + client build (`npx vite build`) + server compile (`npx tsc -p tsconfig.server.json --noEmit`). All must pass.
4. **Show** — Screenshot or terminal output for user review. For UI: launch a real process if needed to generate live data.
5. **Commit** — Only after explicit user approval. Use conventional commit messages (`feat:`, `fix:`, `chore:`).

## Release Process

1. Bump version in `package.json` (patch for fixes, minor for features).
2. Run `npm run release` — this:
   - Generates `src/server/version.ts` from package.json
   - Builds the client with Vite → `dist/client`
   - Compiles a single executable with `bun build --compile --asset dist/client`
3. **Verify standalone:** Run the binary from `/tmp` (no project files present):
   ```bash
   cd /tmp && PORT=3199 NO_BROWSER=1 ./release/llama-cpp-config-gui &
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3199/          # expect 200
   curl -s http://localhost:3199/api/app-version                          # expect {"version":"X.Y.Z"}
   # Also verify a JS asset returns 200 with correct content-type
   kill %1
   ```
4. Commit `package.json` version bump. Optionally add a git tag (`vX.Y.Z`).

## Testing Philosophy

- **Framework:** Vitest + supertest for server-side tests.
- **Location:** `src/server/__tests__/` with fixtures in `src/server/__tests__/fixtures/`.
- **Fixtures use real captured data** (actual log lines from llama-server runs), not synthetic examples.
- **Full suite must pass before any commit.** No skipped or failing tests.
- **Client build must be clean** (`vite build` with no errors).
- When adding a new feature, add tests in the same step as implementation.

## Project Conventions

| Area | Convention |
|------|-----------|
| Frontend | Vue 3 Composition API, `<script setup>`, TypeScript |
| Backend | Express (Node-compatible), compiled with Bun for release only |
| Real-time | SSE (`GET /api/events`), no WebSocket |
| Types | Shared shapes in `src/client/types.ts` and `src/server/types.ts` |
| Log format | `[PID] timestamp LEVEL component [function]: message` (PID and function optional) |
| Styling | Scoped CSS in components, dark theme (#0f1117 bg, #e1e4e8 text) |
| State | In-memory on server; localStorage for UI prefs (collapsed panels, etc.) |

## Key Gotchas

- **Bun embedding API:** Use `Bun.embeddedFiles` (NOT `Bun.embedDir`). Must keep the original Blob object and call `.arrayBuffer()` on it directly — detaching the method throws.
- **Env var override in llama.ts:** Empty string values are skipped (`if (v !== '')`), so you can't unset a variable via the config. Use a non-empty value to override.
- **GPU OOM during `common_fit_params`:** Even with `-ngl 0`, llama.cpp queries all visible GPUs for memory info. If any GPU is OOM, the process crashes. Workaround: set `CUDA_VISIBLE_DEVICES` to a specific free GPU index.
- **Launch endpoint persists config:** `POST /api/launch` merges the request body into the saved config. Test launches will overwrite user settings — always restore or warn.
- **Vite proxy:** Dev server proxies `/api` → `localhost:3001`. The API server must be running separately (or via `npm run dev` which runs both).

## Session Handoff Pattern

When starting a new session, the user can say:
> "Follow docs/agent.md" or attach the file.

The agent should then:
1. Read this file and adopt all working agreements.
2. Check `docs/todo.md` for current progress and next items.
3. Ask which item to work on (or proceed if context makes it obvious).
4. Follow the Development Workflow above for each step.
