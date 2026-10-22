# Strata `serve/server.py` — full feature list, checked against `strata/strata.ts`

Legend: ✅ supported · 🟡 partial · ❌ not in `strata.ts`

`serve/server.py` is 8,269 lines. `strata/strata.ts` is the minimal experiment
(~560 lines). The list below is everything the Python server does, grouped, with
what the TS shim covers.

---

## 1. HTTP endpoints

| Endpoint | server.py | strata.ts |
|---|---|---|
| `POST /v1/chat/completions` (OpenAI, stream + non-stream) | ✅ | ✅ |
| `GET /v1/models`, `GET /models` | ✅ | ✅ (`/v1/models` only) |
| `GET /health`, `GET /api/health` | ✅ | ✅ |
| `POST /v1/messages` (Anthropic, stream + non-stream) | ✅ | ❌ |
| `POST /v1/messages/count_tokens` | ✅ | ❌ |
| `POST /v1/responses` (+ retrieve/delete/cancel/compact) | ✅ | ❌ |
| `GET /props` | ✅ | ❌ |
| `GET /slots`, `POST /slots/{id}?action=save\|restore` | ✅ | ❌ |
| `GET /status`, `GET /v1/status` | ✅ | ❌ |
| `POST /v1/vram` (elastic expert-cache reserve) | ✅ | ❌ |
| `POST /load`, `POST /unload` (+ `/v1/load`, `/v1/unload`) | ✅ | ❌ |
| `POST /v1/images/generations` (sd-cli image gen) | ✅ | ❌ |
| `GET /v1/images/files/{…}` | ✅ | ❌ |
| `GET /mcp` | ✅ | ❌ |
| `GET /metrics`, `GET /metrics/prometheus` | ✅ | ❌ |
| `GET /v1/telemetry` | ✅ | ❌ |
| `GET /api/requests` (API monitor) | ✅ | ❌ |
| `GET /settings`, `POST /settings` | ✅ | ❌ |
| `GET /config`, `POST /config` | ✅ | ❌ |
| `GET /web/…`, `GET /fonts/…` (bundled web UI) | ✅ | ❌ |
| `/v1/v1/messages` alias handling | ✅ | ❌ |

## 2. Request parameters (OpenAI chat)

| Parameter | server.py | strata.ts |
|---|---|---|
| `messages` | ✅ | ✅ |
| `stream` | ✅ | ✅ |
| `model` (validated against aliases) | ✅ | 🟡 (echoed, not validated) |
| `max_tokens` / `max_completion_tokens` | ✅ | 🟡 (`max_tokens` only; default 512, not "unlimited") |
| unset / 0 / -1 max_tokens = "rest of context" | ✅ | ❌ (defaults to 512) |
| `temperature` | ✅ | ✅ |
| `top_p` | ✅ | ✅ |
| `top_k` | ✅ | ✅ |
| `seed` | ✅ | ✅ |
| `min_p` | ✅ | ❌ |
| `presence_penalty` | ✅ | ❌ |
| `frequency_penalty` | ✅ | ❌ |
| `repetition_penalty` (+ llama.cpp `repeat_penalty`) | ✅ | ❌ |
| `penalty_last_n` (+ `repeat_last_n`) | ✅ | ❌ |
| `logit_bias` | ✅ | ❌ |
| `stop` (string or ≤4 list) + StopMatcher | ✅ | ❌ |
| `response_format` (json_schema / grammar) | ✅ | ❌ |
| `tools` / `tool_choice` / tool-call parsing | ✅ | ❌ |
| `reasoning_effort` / `thinking` / `reasoning` | ✅ | ❌ |
| `reasoning_budget_tokens` / `thinking_budget_tokens` | ✅ | ❌ |
| `chat_template_kwargs` | ✅ | ❌ |
| `strata_mcp` (opt-in MCP tools) | ✅ | ❌ |
| `strata_prefix` (shared-prefix reuse) | ✅ | ❌ |
| `return_progress` | ✅ | ❌ |
| sampling type validation → 400 naming the field | ✅ | ❌ |
| string-number coercion ("0.7" → 0.7) | ✅ | ❌ |
| model-card sampling defaults (thinking/instruct) | ✅ | ❌ |
| config `sampling` block defaults | ✅ | ❌ |

## 3. Context / token budget handling

| Behaviour | server.py | strata.ts |
|---|---|---|
| Prompt alone doesn't fit → reject 400, never truncate | ✅ | ❌ |
| Prompt + max doesn't fit → shorten max (less CTX_SLACK) | ✅ | ❌ |
| Thinking budget follows the shortened max | ✅ | ❌ |
| `fit_max_tokens: false` → strict 400 | ✅ | ❌ |
| Answer-room reserve (`ANSWER_RESERVE_MIN`) | ✅ | ❌ |

## 4. Chat template / prompt building

| Behaviour | server.py | strata.ts |
|---|---|---|
| Full Jinja `chat_template.jinja` (183 lines) | ✅ | 🟡 (hardcoded Qwen3 ChatML wrapper) |
| Tool-call blocks in the template | ✅ | ❌ |
| Effort-sentence swap (low/medium/high/xhigh) | ✅ | ❌ |
| `effort_position` start/end (`--tail-role-token`) | ✅ | ❌ |
| Special-token parsing (`<\|im_start\|>` etc. as single ids) | ✅ | ✅ |
| `plain` spans (quoted specials stay text) | ✅ | ❌ |

## 5. Tokenizer

| Behaviour | server.py | strata.ts |
|---|---|---|
| GGUF vocab (`vocab.json` + `merges.txt` + `token_type.json`) | ✅ | ✅ |
| qwen35 pre-tokenizer regex | ✅ | ✅ (native JS) |
| Byte-level BPE, byte_fallback | ✅ | ✅ (HF package BPE model) |
| Exact id-for-id vs reference | ✅ | ✅ (verified) |
| Incremental detokenizer (constant time/token) | ✅ | 🟡 (pending-buffer, re-decodes) |
| `PromptEncoder` resume points (prompt cache) | ✅ | ❌ |
| `token_bytes` for split multi-byte chars | ✅ | 🟡 (U+FFFD hold-back) |

## 6. Engine protocol / lifecycle

| Behaviour | server.py | strata.ts |
|---|---|---|
| Spawn `strata --serve`, resident | ✅ | ✅ |
| `READY <ctx> stop` handshake | ✅ | ✅ |
| `GEN <max_new> [k=v…] <ids>` | ✅ | ✅ |
| `T <id>` streaming | ✅ | ✅ |
| `DONE …` parse (produced/prompt/stop) | ✅ | ✅ |
| `ERR` / `FATAL` handling | ✅ | ✅ |
| `STOP` (cancel) | ✅ | 🟡 (method exists, not wired to client disconnect) |
| `QUIT` shutdown | ✅ | ✅ |
| FIFO, one sequence at a time | ✅ | ✅ |
| `RESUME` / `REUSED` / `PP` progress lines | ✅ | 🟡 (ignored) |
| Engine watchdog / silence timeout / restart | ✅ | ❌ |
| `--batch` / `BGEN` / `BSTOP` / `BYIELD` parallel | ✅ | ❌ |
| Replicas (multi-engine, core pinning) | ✅ | ❌ |
| `GENI` / `BGENI` image embeddings | ✅ | ❌ |
| `VRAM <mib>` elastic | ✅ | ❌ |
| `SAVE` / `RESTORE` disk sessions | ✅ | ❌ |
| Lazy load / `ensure_loaded` | ✅ | ❌ |
| `before_load` hook, VRAM check | ✅ | ❌ |
| `idle_unload_s` | ✅ | ❌ |
| `prevent_sleep` (keepawake) | ✅ | ❌ |

## 7. Vision / images

| Behaviour | server.py | strata.ts |
|---|---|---|
| `strata-vision` subprocess (mmproj) | ✅ | ❌ |
| OpenAI `image_url` parts, Anthropic image blocks | ✅ | ❌ |
| base64 / http(s) / local file paths | ✅ | ❌ |
| WebP/TIFF/AVIF → PNG (Pillow) | ✅ | ❌ |
| `SVE1` embedding file format | ✅ | ❌ |
| Elastic vision encoder | ✅ | ❌ |

## 8. Tools / MCP

| Behaviour | server.py | strata.ts |
|---|---|---|
| MCP servers (`mcp_servers`, `--mcp-config`) | ✅ | ❌ |
| Tool schemas injected into template | ✅ | ❌ |
| Tool-call parsing / `tool_choice` forcing | ✅ | ❌ |
| `strata_mcp: true` opt-in | ✅ | ❌ |

## 9. Sessions / slots / cache

| Behaviour | server.py | strata.ts |
|---|---|---|
| llama-server-style `/slots/{id}?action=save\|restore` | ✅ | ❌ |
| Slot filename validation / save dir | ✅ | ❌ |
| Prompt cache (`--prompt-cache`, resume points) | ✅ | ❌ |
| Shared-prefix reuse (`strata_prefix`) | ✅ | ❌ |

## 10. API surface extras

| Behaviour | server.py | strata.ts |
|---|---|---|
| `aliases` (llama-server `--alias`) | ✅ | ❌ |
| API key auth (Bearer / `x-api-key`) | ✅ | ❌ |
| CORS origins | ✅ | ❌ |
| `/v1/*` request recording / API monitor | ✅ | ❌ |
| Prometheus metrics | ✅ | ❌ |
| `/settings` live editing | ✅ | ❌ |
| `/config` run-config editing | ✅ | ❌ |
| Bundled web UI (`/web/`) | ✅ | ❌ |
| `usage` in responses | ✅ | ✅ |
| `finish_reason` stop vs length | ✅ | 🟡 (always `stop`) |

---

## Summary

**`strata.ts` supports (✅):**
- `POST /v1/chat/completions` — stream + non-stream
- `GET /v1/models`, `GET /health`
- tokenizer: GGUF vocab + qwen35 split + byte-level BPE, exact id match
- special-token ids (`<|im_start|>`/`<|im_end|>`/`<|endoftext|>`)
- hardcoded Qwen3 ChatML chat template
- sampling: `temperature`, `top_p`, `top_k`, `seed`
- `max_tokens`
- EOS filtering, `usage` reporting
- engine spawn + `READY`/`GEN`/`T`/`DONE`/`ERR`/`QUIT` + FIFO

**Partial (🟡):** `model` echo, `max_tokens` default (512 not unlimited), `STOP` not wired to disconnect, `RESUME`/`REUSED` ignored, incremental decode is re-decode not constant-time, `finish_reason` always `stop`.

**Everything else (❌):** Anthropic + Responses dialects, vision, tools/MCP, slots/save-restore, VRAM elastic, load/unload, batch/replicas, prompt cache, reasoning/thinking budget + effort steering, `stop` strings, penalties, `logit_bias`, `response_format`, context-fit/400 logic, aliases, auth, CORS, metrics, web UI, settings/config editing, watchdog/restart.

That matches the §15 estimate in `docs/strata.md`: `strata.ts` is the **~500-line core** (chat + tokenizer + template + basic sampling). The remaining ❌ items are the +1,000–1,500 lines of features that would take it toward full parity.
