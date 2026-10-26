/**
 * OpenAI `/v1/images/generations` -> stable-diffusion.cpp native
 * `POST /sdcpp/v1/img_gen` translator (docs/proxy-server.md §4.3.2).
 *
 * sd.cpp's own OpenAI route reads five fields and nothing else (§4.3.1), so a
 * `sdiffusion` backend is driven through the native job API instead: submit,
 * poll `poll_url` until the job settles, then answer with an OpenAI-shaped
 * body. Only fields the client actually sent are written into the job request —
 * `parse_img_gen_request` starts from the server's own defaults
 * (`routes_sdcpp.cpp:439`), and defaults we invent would override the loaded
 * recipe.
 *
 * Fixtures replayed by the tests: `__tests__/fixtures/proxy/sd/`.
 */

/** A pre-flight rejection: answered as an OpenAI-shaped 400. */
export interface SdTranslateError {
  message: string;
  code: string;
}

export type SdTranslateResult =
  | { ok: true; request: Record<string, unknown> }
  | { ok: false; error: SdTranslateError };

/** `size:"WxH"` split the way upstream does it (`routes_openai.cpp:40-45`). */
function parseSize(size: unknown): { width: number; height: number } | null {
  if (typeof size !== 'string') return null;
  const pos = size.indexOf('x');
  if (pos < 0) return null;
  const width = Number.parseInt(size.slice(0, pos), 10);
  const height = Number.parseInt(size.slice(pos + 1), 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

const asInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Map an OpenAI image request onto the native `img_gen` schema.
 *
 * Rejections are deliberate rather than lossy: `quality`/`style` have no
 * upstream equivalent at all, and `response_format:"url"` cannot be honoured
 * because sd.cpp hosts no images — silently dropping any of them would promise
 * an effect that never happens (§4.3.2).
 */
export function translateSdImageRequest(body: Record<string, unknown>): SdTranslateResult {
  const prompt = body.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { ok: false, error: { message: 'A non-empty "prompt" string is required', code: 'missing_prompt' } };
  }

  for (const field of ['quality', 'style']) {
    if (body[field] !== undefined) {
      return {
        ok: false,
        error: {
          message: `"${field}" is not supported by stable-diffusion.cpp and would be ignored`,
          code: 'unsupported_parameter',
        },
      };
    }
  }
  if (body.response_format !== undefined && body.response_format !== 'b64_json') {
    return {
      ok: false,
      error: {
        message: 'stable-diffusion.cpp cannot serve response_format "url": it does not host generated images. Use "b64_json"',
        code: 'unsupported_parameter',
      },
    };
  }

  const request: Record<string, unknown> = { prompt };

  const n = asInt(body.n);
  if (n !== null) {
    if (n < 1 || n > 8) {
      return { ok: false, error: { message: `"n" must be between 1 and 8 (sd.cpp max_batch_count)`, code: 'invalid_parameter' } };
    }
    request.batch_count = n;
  }

  // `size` wins; bare width/height rows are accepted as an extension (§4.3.2).
  if (body.size !== undefined) {
    const size = parseSize(body.size);
    if (!size) {
      return { ok: false, error: { message: `"size" must look like "WIDTHxHEIGHT" (e.g. "1024x1024")`, code: 'invalid_parameter' } };
    }
    request.width = size.width;
    request.height = size.height;
  } else {
    const width = asInt(body.width);
    const height = asInt(body.height);
    if (width !== null) request.width = width;
    if (height !== null) request.height = height;
  }
  for (const key of ['width', 'height'] as const) {
    const v = request[key];
    if (typeof v === 'number' && (v < 64 || v > 4096)) {
      return { ok: false, error: { message: `${key} must be between 64 and 4096 (sd.cpp limits)`, code: 'invalid_parameter' } };
    }
  }

  if (body.output_format !== undefined) request.output_format = body.output_format;
  const compression = asInt(body.output_compression);
  if (compression !== null) request.output_compression = compression;
  // `seed` is a TOP-LEVEL native field: inside `sample_params` it is silently
  // ignored (fixtures/proxy/sd/openai-generations.extra-args.json).
  const seed = asInt(body.seed);
  if (seed !== null) request.seed = seed;
  if (typeof body.negative_prompt === 'string') request.negative_prompt = body.negative_prompt;

  const sampleParams: Record<string, unknown> = {};
  const steps = asInt(body.steps);
  if (steps !== null) sampleParams.sample_steps = steps;
  if (typeof body.sampler === 'string') sampleParams.sample_method = body.sampler;
  if (typeof body.scheduler === 'string') sampleParams.scheduler = body.scheduler;
  const guidance = asNumber(body.guidance);
  if (guidance !== null) sampleParams.guidance = { txt_cfg: guidance };
  if (Object.keys(sampleParams).length > 0) request.sample_params = sampleParams;

  // `model` selects the backend/route only (sd.cpp ignores it), `user` is never
  // parsed upstream, and unknown keys are ignored by the native schema — none
  // are forwarded.
  return { ok: true, request };
}

/** Job statuses the native API reports (`routes_sdcpp.cpp`). */
export type SdJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string;

export interface SdJobInfo {
  id?: string;
  kind?: string;
  status?: SdJobStatus;
  /** Where to poll — the submit reply hands this out verbatim. */
  poll_url?: string;
  error?: string | null;
  created?: number;
  started?: number;
  completed?: number;
  result?: {
    images?: Array<{ index?: number; b64_json?: string; generation_info?: Record<string, unknown> }>;
    output_format?: string;
  };
}

/** What one upstream call produced (same shape as `sdRequest` in engines/sdProxy.ts). */
export interface SdHttpResult {
  status: number;
  body: unknown;
}

export interface SdJobOutcome {
  /** HTTP status to answer the client with. */
  status: number;
  /** JSON body to answer with (OpenAI response or OpenAI error envelope). */
  body: unknown;
  /** Usage meta (§4.3.2): what the job actually ran. */
  meta: Record<string, unknown>;
  /** Recorded error message, when the request failed. */
  errorMessage?: string;
}

export interface SdJobDeps {
  baseUrl: string;
  request: Record<string, unknown>;
  /** Total submit->completion budget; `ProxyBackend.timeoutMs` or the proxy default. */
  timeoutMs: number;
  /** First poll delay; doubles up to `maxPollIntervalMs`. Injectable so tests do not sleep. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Connect/response guard on each individual call, not the generation budget. */
  callTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Aborted when the client hangs up: the poll loop stops and the job is cancelled. */
  signal?: AbortSignal;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** `GET`/`POST` one sdcpp endpoint, JSON in and out; network errors become `status:0`. */
async function sdcppCall(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiPath: string,
  init: { method: string; body?: unknown; timeoutMs: number; signal?: AbortSignal },
): Promise<SdHttpResult> {
  try {
    const res = await fetchImpl(`${baseUrl}${apiPath}`, {
      method: init.method,
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.any([AbortSignal.timeout(init.timeoutMs), ...(init.signal ? [init.signal] : [])]),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep the raw text so an error page still surfaces something */
      }
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { message: (e as Error)?.message ?? String(e) } };
  }
}

/** The upstream's own error text, for an actionable message. */
function upstreamDetail(body: unknown): string {
  if (typeof body === 'string') return body || 'no response body';
  const b = body as { error?: unknown; message?: unknown } | null;
  if (typeof b?.error === 'string') return b.error;
  if (typeof b?.message === 'string') return b.message;
  return JSON.stringify(body ?? '');
}

function openaiErrorBody(message: string, code: string): unknown {
  return { error: { message, type: 'invalid_request_error', code } };
}

/**
 * Submit a native job and poll it to completion, translating both directions.
 * Never throws: every failure ends up as an OpenAI-shaped error body plus a
 * usage row, so the proxy's recording contract holds (§5).
 */
export async function runSdImageJob(deps: SdJobDeps): Promise<SdJobOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollBase = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollMax = deps.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
  const callTimeout = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const budget = deps.timeoutMs > 0 ? deps.timeoutMs : Number.POSITIVE_INFINITY;
  const deadline = Date.now() + budget;

  const submitted = await sdcppCall(fetchImpl, deps.baseUrl, '/sdcpp/v1/img_gen', {
    method: 'POST',
    body: deps.request,
    timeoutMs: callTimeout,
    signal: deps.signal,
  });

  if (submitted.status === 0) {
    return {
      status: 502,
      body: openaiErrorBody(`Backend ${deps.baseUrl} unreachable: ${upstreamDetail(submitted.body)}`, 'backend_unreachable'),
      meta: {},
      errorMessage: `upstream error: ${upstreamDetail(submitted.body)}`,
    };
  }
  if (submitted.status === 429) {
    return {
      status: 503,
      body: openaiErrorBody('The sd.cpp job queue is full; retry later', 'backend_busy'),
      meta: {},
      errorMessage: 'job queue full',
    };
  }
  if (submitted.status >= 400) {
    // `img_gen` validates the native schema itself ("invalid generation
    // parameters"), so an upstream 4xx is reported as our own 400 with its text.
    const detail = upstreamDetail(submitted.body);
    return {
      status: 400,
      body: openaiErrorBody(`sd.cpp rejected the request: ${detail}`, 'invalid_generation_params'),
      meta: {},
      errorMessage: `upstream rejected request: ${detail}`,
    };
  }

  const job0 = submitted.body as SdJobInfo;
  const jobId = typeof job0.id === 'string' ? job0.id : '';
  const pollPath = typeof job0.poll_url === 'string' ? job0.poll_url : `/sdcpp/v1/jobs/${jobId}`;
  const meta: Record<string, unknown> = { jobId: jobId || null };

  // Best-effort cancel: `features_by_mode.img_gen` reports cancel support, but
  // an old build may not have the route — the result is never surfaced.
  const cancel = async (): Promise<void> => {
    if (!jobId) return;
    await sdcppCall(fetchImpl, deps.baseUrl, `${pollPath}/cancel`, { method: 'POST', timeoutMs: callTimeout });
  };

  let delay = pollBase;
  for (;;) {
    if (deps.signal?.aborted) {
      await cancel();
      return { status: 499, body: openaiErrorBody('Client disconnected', 'client_disconnected'), meta, errorMessage: 'client disconnected' };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await cancel();
      return {
        status: 504,
        body: openaiErrorBody(`Generation did not finish within ${Math.round(budget / 1000)}s; the job was cancelled`, 'generation_timeout'),
        meta,
        errorMessage: 'generation timeout',
      };
    }

    // Each poll's own guard is capped by the remaining budget, so a wedged
    // backend ends the request at the deadline rather than at the call timeout.
    const poll = await sdcppCall(fetchImpl, deps.baseUrl, pollPath, {
      method: 'GET',
      timeoutMs: Math.min(callTimeout, remaining),
      signal: deps.signal,
    });
    if (deps.signal?.aborted) {
      await cancel();
      return { status: 499, body: openaiErrorBody('Client disconnected', 'client_disconnected'), meta, errorMessage: 'client disconnected' };
    }
    if (poll.status === 0) {
      if (Date.now() >= deadline) {
        await cancel();
        return {
          status: 504,
          body: openaiErrorBody(`Generation did not finish within ${Math.round(budget / 1000)}s; the job was cancelled`, 'generation_timeout'),
          meta,
          errorMessage: 'generation timeout',
        };
      }
      return {
        status: 502,
        body: openaiErrorBody(`Backend ${deps.baseUrl} unreachable while polling the job: ${upstreamDetail(poll.body)}`, 'backend_unreachable'),
        meta,
        errorMessage: `upstream error while polling: ${upstreamDetail(poll.body)}`,
      };
    }
    if (poll.status === 410) {
      return { status: 500, body: openaiErrorBody('The generation job expired before the proxy could read it', 'job_expired'), meta, errorMessage: 'job expired' };
    }
    if (poll.status === 404) {
      return { status: 500, body: openaiErrorBody('The generation job disappeared from the backend', 'job_not_found'), meta, errorMessage: 'job not found' };
    }
    if (poll.status >= 400) {
      const detail = upstreamDetail(poll.body);
      return { status: 502, body: openaiErrorBody(`sd.cpp job poll failed: ${detail}`, 'backend_error'), meta, errorMessage: `job poll failed: ${detail}` };
    }

    const job = poll.body as SdJobInfo;
    // Queue/render split from the job's own millisecond timestamps (§4.3.1).
    if (typeof job.created === 'number') meta.created = job.created;
    if (typeof job.started === 'number' && typeof job.created === 'number') meta.queueMs = job.started - job.created;
    if (typeof job.completed === 'number' && typeof job.started === 'number') meta.renderMs = job.completed - job.started;

    if (job.status === 'completed') {
      const images = Array.isArray(job.result?.images) ? job.result!.images! : [];
      // The base64 is copied through untouched — never decoded or re-encoded.
      const data = images
        .filter((img) => typeof img.b64_json === 'string')
        .map((img) => ({ b64_json: img.b64_json as string }));
      // `generation_info` is sd.cpp-specific and is not forwarded to the client,
      // but the *effective* parameters it reports belong in the usage row.
      const info = (images.find((img) => img.generation_info)?.generation_info ?? {}) as Record<string, unknown>;
      const params = (info.sample_params ?? {}) as Record<string, unknown>;
      for (const [key, value] of [['seed', info.seed], ['steps', params.sample_steps], ['width', info.width], ['height', info.height]] as const) {
        if (value !== undefined) meta[key] = value;
      }
      if (typeof job.result?.output_format === 'string') meta.outputFormat = job.result.output_format;
      meta.count = data.length;
      return {
        status: 200,
        body: { created: Math.floor((job.completed ?? Date.now()) / 1000), data },
        meta,
      };
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      const detail = typeof job.error === 'string' && job.error ? job.error : `job ${job.status}`;
      return {
        status: 500,
        body: openaiErrorBody(`Generation ${job.status}: ${detail}`, job.status === 'failed' ? 'generation_failed' : 'generation_cancelled'),
        meta,
        errorMessage: `generation ${job.status}: ${detail}`,
      };
    }

    await sleep(delay);
    delay = Math.min(delay * 2, pollMax);
  }
}
