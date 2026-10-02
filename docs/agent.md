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

## Release Process (automated)

Releases are fully automated via **semantic-release** on push to `main`:

1. **Use Conventional Commits in PR titles.** GitHub squash-merges use the PR title as the commit message, so the title must be conventional:
   - `feat: ...` → minor bump (e.g. 0.3.0 → 0.4.0)
   - `fix: ...` → patch bump (e.g. 0.3.0 → 0.3.1)
   - `feat!: ...` or `BREAKING CHANGE:` footer → major bump
2. **Merge to `main`.** The Release workflow (`.github/workflows/release.yml`) then:
   - Runs `semantic-release` (Node 24) which analyzes commits since the last tag
   - Bumps `package.json` + lockfile, updates `CHANGELOG.md`, creates a `vX.Y.Z` tag and GitHub Release
   - Builds the single-file executable (`npm run release` → Bun compile with embedded client)
   - Uploads the binary as a ZIP asset to the GitHub Release
3. **No manual version bump needed.** The baseline tag is `v0.3.0`. Each subsequent conventional commit merged to `main` triggers the next release automatically.
4. **Local build (for testing):** `npm run release` still works standalone — it reads the current `package.json` version, builds the client, and compiles the executable into `release/llama-cpp-config-gui`.

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
