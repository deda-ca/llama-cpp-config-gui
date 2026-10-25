/**
 * stable-diffusion.cpp model-management proxy (docs/stable-diffusion.md §3.10).
 *
 * sd.cpp's model catalog is **live server state**, not a file we can read: file
 * ids are handed out by a running `sd-server` (`GET /sdcpp/v1/model-files`) and
 * a load request must carry those ids, never paths (§1.4.1). So every model
 * operation is an HTTP call to the instance's own `baseUrl`, which the GUI
 * server makes on the browser's behalf — the browser never talks to sd-server
 * directly and needs no CORS.
 *
 * The verified contract (`examples/server/api.md:84-89`, `routes_models.cpp`):
 *
 *   GET  /sdcpp/v1/model-files   {files:[{id,name,category,root,relative_path}], errors}
 *   GET  /sdcpp/v1/recipes       {recipes:[…], errors}
 *   POST /sdcpp/v1/models/refresh {errors}
 *   GET  /sdcpp/v1/models/status {state, recipe, models, error, revision, load_elapsed_seconds}
 *   POST /sdcpp/v1/models/load   status after completion
 *   POST /sdcpp/v1/models/unload empty status
 *
 * Load failures map onto the spec's error table (§1.4.1): `409 model_busy`
 * (generation in flight), `400 invalid_model_config` (current model survives),
 * `422 model_load_failed` (state `error`, nothing loaded), `503 model_loading`.
 * `sdUpstreamError` turns any of those into a message that says what to do.
 *
 * A card whose `recipe` id is not in the server's catalog gets a **user recipe**
 * emitted into `<first --model-dir>/recipes/<id>.json` and the catalog
 * refreshed, then the load is retried once (§3.3). That is the only way a
 * card's own generation defaults and GPU split reach the loaded model.
 */

import fs from 'fs';
import path from 'path';
import type { ModelConfig } from '../modelConfig.js';
import type { EngineInstance } from './types.js';
import {
  sdBuildUserRecipe,
  sdHost,
  sdModelDirs,
  sdModelToLoadRequest,
  sdPort,
  sdRecipePath,
  type SdModelFile,
} from './sd.js';

/** A model file as the running server reports it (`model-files`). */
export type SdCatalogFile = SdModelFile;

/** The `models/status` payload, kept loose — the server owns the shape. */
export interface SdModelStatus {
  state?: string;
  recipe?: string | null;
  models?: Record<string, string>;
  error?: string | null;
  revision?: number;
  load_elapsed_seconds?: number | null;
  [key: string]: unknown;
}

/** What an upstream call produced: the HTTP status plus its parsed body. */
export interface SdUpstreamResult {
  status: number;
  body: unknown;
}

/**
 * Where an instance's sd-server answers. `--listen-ip` 0.0.0.0 is reachable
 * locally as 127.0.0.1, and a bare `--listen-port` row is what `sdPort` reads
 * (`-l` is the IP on sd-server, never a port). Null when the block has no
 * usable port — there is nothing to proxy to.
 */
export function sdBaseUrl(inst: EngineInstance): string | null {
  const port = sdPort(inst.sd);
  if (port === null) return null;
  const host = sdHost(inst.sd);
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
}

/**
 * One call to the instance's sdcpp API. JSON in, JSON out; a non-JSON body is
 * passed through as text so an error page still surfaces something.
 *
 * `timeoutMs` is a **connect/response** guard, not a generation budget: model
 * management is quick (a load blocks while weights read, so loads get the long
 * budget — §3.7's idle-timeout reasoning applies to generations, not here).
 */
export async function sdRequest(
  baseUrl: string,
  apiPath: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<SdUpstreamResult> {
  const timeoutMs = init?.timeoutMs ?? 10_000;
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
  }
  return { status: res.status, body };
}

/** `GET /sdcpp/v1/model-files` — the live catalog a load request must use. */
export async function sdModelFiles(baseUrl: string): Promise<SdCatalogFile[]> {
  const { body } = await sdRequest(baseUrl, '/sdcpp/v1/model-files');
  const files = (body as { files?: unknown })?.files;
  return Array.isArray(files) ? (files as SdCatalogFile[]) : [];
}

/** `GET /sdcpp/v1/models/status` — drives the loaded badge / loading spinner. */
export async function sdModelStatus(baseUrl: string): Promise<SdModelStatus> {
  const { body } = await sdRequest(baseUrl, '/sdcpp/v1/models/status');
  return (body && typeof body === 'object' ? body : {}) as SdModelStatus;
}

/**
 * A load/unload failure as an actionable message (§3.10 error table). The
 * server's own text is always included — it names the offending slot or file —
 * and the code decides what the user should do next.
 */
export function sdUpstreamError(result: SdUpstreamResult): string {
  const b = result.body as { code?: string; error?: string } | null;
  const detail = typeof b?.error === 'string' ? b.error : JSON.stringify(result.body);
  switch (b?.code ?? '') {
    case 'model_busy':
      return `The model is busy: finish or cancel running generations first (${detail})`;
    case 'invalid_model_config':
      return `Invalid model config — the loaded model is unchanged: ${detail}`;
    case 'model_load_failed':
      return `Load failed; the instance now has no model loaded: ${detail}`;
    case 'model_loading':
      return 'Another model operation is still running; try again when it finishes';
    case 'model_not_loaded':
      return 'No model is loaded on this instance';
    default:
      return `sd-server returned ${result.status}: ${detail}`;
  }
}

/**
 * The recipe id a card submits to `models/load`.
 *
 * This **must** be the exact string `sdModelToLoadRequest` put in the request
 * (`cfg.sdExtras.recipe`, trimmed), because the emitted user recipe file has to
 * carry the same id the retry submits — and the server validates that id with
 * `valid_identifier` (1-128 of `[A-Za-z0-9._-]`, `model_catalog.cpp:147`) when
 * it scans the file. A card whose recipe is not already a valid identifier
 * therefore cannot be loaded through a user recipe; `sdLoadCard` reports that
 * instead of writing a file the server would silently skip.
 */
export function sdCardRecipeId(cfg: ModelConfig): string {
  return typeof cfg.sdExtras?.recipe === 'string' ? cfg.sdExtras.recipe.trim() : '';
}

/** Recipe ids the server accepts (`valid_identifier`): 1-128 of `[A-Za-z0-9._-]`. */
const SD_RECIPE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Write the card's user recipe into the first model root and refresh the
 * server's catalog so the recipe id resolves (§3.3). Returns the recipe id.
 *
 * The file goes to `<first --model-dir>/recipes/<id>.json` — the earliest root
 * containing a valid recipe wins, so writing to the primary root is what makes
 * the id deterministic regardless of how many roots are configured.
 */
export async function sdEmitUserRecipe(
  baseUrl: string,
  cfg: ModelConfig,
  roots: string[],
  recipeId: string,
): Promise<void> {
  const recipePath = sdRecipePath(roots, recipeId);
  fs.mkdirSync(path.dirname(recipePath), { recursive: true });
  fs.writeFileSync(recipePath, JSON.stringify(sdBuildUserRecipe(cfg, recipeId), null, 2), 'utf-8');
  await sdRequest(baseUrl, '/sdcpp/v1/models/refresh', { method: 'POST', timeoutMs: 30_000 });
}

/** Outcome of a load attempt, for the caller to render. */
export interface SdLoadOutcome {
  ok: boolean;
  /** The status body on success; an error message otherwise. */
  status?: SdModelStatus;
  error?: string;
  /** Non-fatal notes from the mapping (rows that could not become defaults…). */
  warnings: string[];
  /** Set when a user recipe had to be written for the load to work. */
  recipeWritten?: string;
}

/**
 * Load one card into a running instance (§3.10): resolve its component paths to
 * live file-ids, submit `models/load`, and — when the recipe id is unknown —
 * emit the card as a user recipe and retry once.
 *
 * `files`/`roots` come from the live server (`model-files`) and the instance's
 * `--model-dir` rows; a path outside every root has no id and fails with the
 * actionable message `sdModelToLoadRequest` builds (§3.3).
 */
export async function sdLoadCard(
  baseUrl: string,
  cfg: ModelConfig,
  files: SdCatalogFile[],
  roots: string[],
): Promise<SdLoadOutcome> {
  const built = sdModelToLoadRequest(cfg, files, roots);
  if (built.errors.length) {
    return { ok: false, error: built.errors.join('; '), warnings: built.warnings };
  }
  const request = built.request!;

  // A load blocks while weights read — tens of seconds for a large bundle — so
  // it gets a generous budget; the request itself waits for completion.
  let result = await sdRequest(baseUrl, '/sdcpp/v1/models/load', { method: 'POST', body: request, timeoutMs: 300_000 });
  let recipeWritten: string | undefined;

  // "unknown recipe" is the one failure we can repair ourselves: the card names
  // a recipe the server has never seen, so emit it and refresh (§3.3). The id
  // must be one the server's `valid_identifier` accepts, or the recipe file we
  // write would be skipped at scan time and the retry would fail the same way.
  const b = result.body as { error?: string } | null;
  if (result.status === 400 && typeof b?.error === 'string' && b.error.includes('unknown recipe')) {
    const recipeId = sdCardRecipeId(cfg);
    if (!SD_RECIPE_ID_RE.test(recipeId)) {
      return {
        ok: false,
        error: `"${recipeId}" is not a valid recipe id (1-128 letters, digits, dot, underscore or hyphen), `
          + 'so no user recipe can be written for it. Pick a built-in recipe or rename it.',
        warnings: built.warnings,
      };
    }
    await sdEmitUserRecipe(baseUrl, cfg, roots, recipeId);
    recipeWritten = recipeId;
    result = await sdRequest(baseUrl, '/sdcpp/v1/models/load', { method: 'POST', body: request, timeoutMs: 300_000 });
  }

  if (result.status >= 400) {
    return { ok: false, error: sdUpstreamError(result), warnings: built.warnings, recipeWritten };
  }
  return {
    ok: true,
    status: (result.body && typeof result.body === 'object' ? result.body : {}) as SdModelStatus,
    warnings: built.warnings,
    recipeWritten,
  };
}

/** Release the active context (§3.10): frees VRAM, state → `empty`. */
export async function sdUnloadModel(baseUrl: string): Promise<SdLoadOutcome> {
  const result = await sdRequest(baseUrl, '/sdcpp/v1/models/unload', { method: 'POST', timeoutMs: 60_000 });
  if (result.status >= 400) return { ok: false, error: sdUpstreamError(result), warnings: [] };
  return { ok: true, status: (result.body && typeof result.body === 'object' ? result.body : {}) as SdModelStatus, warnings: [] };
}

/**
 * Poll `models/status` until the server answers with a state that is not
 * `loading` — i.e. until it is ready to take a load — or the deadline passes.
 * Used after a launch, before the initial load: sd.cpp prints its `listening
 * on:` line just before `svr.listen()`, so the port answers almost immediately,
 * but a model operation in flight answers `503 model_loading` and must not be
 * raced.
 *
 * `isAlive` lets the caller cancel the wait when the process died: a failed
 * spawn would otherwise keep polling a port that can never open.
 */
export async function sdWaitUntilReady(
  baseUrl: string,
  timeoutMs = 30_000,
  isAlive: () => boolean = () => true,
): Promise<SdModelStatus | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive()) return null;
    try {
      const status = await sdModelStatus(baseUrl);
      if (status.state && status.state !== 'loading') return status;
    } catch {
      /* not answering yet — keep polling until the deadline */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The startup sequence for an sd instance (§3.5/§3.10): wait for the server to
 * answer, then load `modelConfigIds[0]`. Called fire-and-forget after launch,
 * so a slow model read never blocks the launch response.
 *
 * Returns the outcome so callers (and tests) can inspect it; the launch
 * endpoint logs warnings rather than failing — the server is up either way, and
 * the UI's status poll shows `error` with the server's message.
 */
export async function sdInitialLoad(
  inst: EngineInstance,
  findCard: (id: string) => ModelConfig | undefined,
  isAlive: () => boolean = () => true,
  readyTimeoutMs = 30_000,
): Promise<SdLoadOutcome> {
  const baseUrl = sdBaseUrl(inst);
  if (!baseUrl) return { ok: false, error: 'Instance has no listen port', warnings: [] };
  const cardId = inst.sd?.modelConfigIds[0];
  if (!cardId) return { ok: false, error: 'No model config selected', warnings: [] };
  const card = findCard(cardId);
  if (!card) return { ok: false, error: `Model config "${cardId}" not found`, warnings: [] };

  if (!await sdWaitUntilReady(baseUrl, readyTimeoutMs, isAlive)) {
    return { ok: false, error: 'sd-server did not become ready', warnings: [] };
  }
  const files = await sdModelFiles(baseUrl);
  return sdLoadCard(baseUrl, card, files, sdModelDirs(inst.sd));
}
