/**
 * OpenAI-compatible proxy gateway (docs/proxy-server.md).
 * Transparent passthrough: streams are never buffered and recording failures
 * never surface to API clients.
 */

import express, { type Request, type Response } from 'express';
import http from 'http';
import { URL } from 'url';
import { ModelRouter } from './router.js';
import { RequestRecorder, SseUsageScanner, extractJsonUsage, persistRecord } from './recorder.js';
import { runSdImageJob, translateSdImageRequest } from './sdTranslator.js';
import { estimateMessagesTokens, estimateTokens } from './tokenCount.js';
import type { UsageDb } from './usageDb.js';
import type { ProxyBackend, ProxyBackendKind, ProxySettings, UsageRecord } from './types.js';

export interface ProxyAppDeps {
  /** Getter so settings changes apply without rebuilding the app. */
  getSettings: () => ProxySettings;
  router: ModelRouter;
  db: UsageDb;
  onUsage?: (rec: UsageRecord) => void;
  onRecordError?: (e: unknown) => void;
  /** Connect timeout override (tests); defaults to CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
}

const JSON_BODY_LIMIT = '10mb';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/** Which backend kinds may serve each JSON endpoint ('custom'/'default' always allowed). */
const ENDPOINT_KINDS: Record<string, ProxyBackendKind[]> = {
  '/v1/chat/completions': ['llamacpp', 'default', 'custom'],
  '/v1/completions': ['llamacpp', 'default', 'custom'],
  '/v1/embeddings': ['llamacpp', 'embeddings', 'default', 'custom'],
  '/v1/images/generations': ['sdiffusion', 'default', 'custom'],
  '/v1/moderations': ['moderation', 'default', 'custom'],
  '/v1/videos': ['videos', 'default', 'custom'],
};

/** Kinds accepted by the raw audio passthrough endpoints. */
const AUDIO_KINDS: ProxyBackendKind[] = ['audio', 'default', 'custom'];

/** Kinds accepted by the raw image-edit passthrough (multipart body, §3.7). */
const IMAGE_KINDS: ProxyBackendKind[] = ['sdiffusion', 'default', 'custom'];

/** Idle (inactivity) timeout on the upstream socket: a 20-step 2048² render
 *  legitimately runs for minutes, so the budget is per-gap-in-traffic, not
 *  per-request (docs/stable-diffusion.md §3.7). `ProxyBackend.timeoutMs`
 *  overrides it per backend; 0 disables it. */
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Connect timeout: a dead instance should fail fast, not sit for minutes. */
const CONNECT_TIMEOUT_MS = 5_000;
/** JSON responses larger than this still pass through, but are not parsed for `usage`. */
const MAX_USAGE_SCAN_BYTES = 5 * 1024 * 1024;

/** Endpoints whose `prompt` string feeds the estimated-token fallback. */
const TEXT_ENDPOINTS = ['/v1/completions', '/v1/embeddings'];

/** Kinds whose upstream `model` field may be rewritten from the route alias. */
const REWRITE_MODEL_KINDS: ProxyBackendKind[] = ['llamacpp', 'embeddings', 'moderation', 'videos', 'default', 'custom'];

function openaiError(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json({ error: { message, type: 'invalid_request_error', code: code ?? null } });
}

export function createProxyApp(deps: ProxyAppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // --- Auth (optional Bearer) ---
  app.use((req, res, next) => {
    const key = deps.getSettings().apiKey;
    if (!key) return next();
    const auth = req.headers.authorization ?? '';
    if (auth === `Bearer ${key}` || auth === key) return next();
    openaiError(res, 401, 'Invalid API key', 'invalid_api_key');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/v1/models', (_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    res.json({
      object: 'list',
      data: deps.router.listRoutes().map((r) => ({
        id: r.model,
        object: 'model',
        created: now,
        owned_by: r.backend,
      })),
    });
  });

  // --- Passthrough endpoints ---
  const jsonParser = express.json({ limit: JSON_BODY_LIMIT });

  app.post('/v1/chat/completions', jsonParser, (req, res) => handleJson(req, res, true));
  app.post('/v1/completions', jsonParser, (req, res) => handleJson(req, res, false));
  app.post('/v1/embeddings', jsonParser, (req, res) => handleJson(req, res, false));
  app.post('/v1/images/generations', jsonParser, (req, res) => handleJson(req, res, false));
  app.post('/v1/moderations', jsonParser, (req, res) => handleJson(req, res, false));
  app.post('/v1/videos', jsonParser, (req, res) => handleJson(req, res, false));
  // Audio endpoints: raw passthrough (multipart / binary bodies are not parsed)
  app.post('/v1/audio/speech', (req, res) => handleRaw(req, res));
  app.post('/v1/audio/transcriptions', (req, res) => handleRaw(req, res));
  // Image edits: sd.cpp accepts multipart here (api.md:428-441), which
  // express.json would consume — raw passthrough like audio (§3.7).
  app.post('/v1/images/edits', (req, res) => handleRaw(req, res));

  // Express 5 wildcard syntax: {*splat}
  app.all('/v1/{*splat}', (_req, res) => openaiError(res, 404, 'Unknown endpoint', 'unknown_endpoint'));

  // --- handlers ---

  function resolveOr404(req: Request, res: Response, model: string | undefined) {
    const route = deps.router.resolve(model, req.path);
    if (!route) {
      openaiError(res, 404, `Unknown model "${model ?? ''}"`, 'model_not_found');
      return null;
    }
    const settings = deps.getSettings();
    const backend = settings.backends.find((b) => b.id === route.backend);
    if (!backend || !backend.baseUrl) {
      openaiError(res, 502, `Backend "${route.backend}" is not configured`, 'backend_unconfigured');
      return null;
    }
    return { route, backend };
  }

  function makeRecorder(req: Request, model: string, backend: string, stream: boolean, meta?: Record<string, unknown> | null, estimatedInput?: number): RequestRecorder {
    return new RequestRecorder({
      model,
      backend,
      endpoint: req.path,
      stream,
      clientIp: req.ip ?? '',
      meta: meta ?? null,
      estimatedInput,
    });
  }

  function finalize(rec: RequestRecorder, status: number, error?: string | null): void {
    const record = persistRecord(deps.db, rec.build(status, error ?? null), deps.onRecordError);
    deps.onUsage?.(record);
  }

  /** JSON-body endpoints: parse, resolve model, possibly rewrite body, forward. */
  function handleJson(req: Request, res: Response, isChat: boolean): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const resolved = resolveOr404(req, res, model);
    if (!resolved) return;
    const { route, backend } = resolved;

    // Each endpoint only accepts backends whose kind can serve it
    const allowed = ENDPOINT_KINDS[req.path];
    if (allowed && !allowed.includes(backend.kind)) {
      openaiError(res, 400, `Model "${model}" (${backend.kind}) cannot serve ${req.path}`, 'unsupported_model');
      return;
    }

    const stream = body.stream === true;
    const outBody = { ...body };
    if (route.upstreamModel !== model && REWRITE_MODEL_KINDS.includes(backend.kind)) outBody.model = route.upstreamModel;
    // Ensure streaming usage is available from llama.cpp
    if (isChat && stream && backend.kind === 'llamacpp') {
      const so = (outBody.stream_options ?? {}) as Record<string, unknown>;
      outBody.stream_options = { ...so, include_usage: true };
    }

    // Token estimation fallback applies to text endpoints only (not image/audio/video)
    const estimatedInput = isChat
      ? estimateMessagesTokens(body.messages)
      : TEXT_ENDPOINTS.includes(req.path) && typeof body.prompt === 'string' ? estimateTokens(body.prompt) : undefined;
    const meta = req.path === '/v1/images/generations'
      ? { promptChars: typeof body.prompt === 'string' ? body.prompt.length : 0, steps: body.steps, width: body.width, height: body.height, n: body.n }
      : req.path === '/v1/videos'
        ? { promptChars: typeof body.prompt === 'string' ? body.prompt.length : 0, seconds: body.seconds, size: body.size, n: body.n }
        : null;

    const rec = makeRecorder(req, model ?? '', route.backend, stream, meta, estimatedInput);

    // sd.cpp speaks its own native job API, not the OpenAI image route (§4.3.1):
    // translate, submit, poll, then answer with an OpenAI-shaped body.
    if (req.path === '/v1/images/generations' && backend.kind === 'sdiffusion') {
      runSdGeneration(req, res, backend, body, rec);
      return;
    }

    const payload = Buffer.from(JSON.stringify(outBody));
    forward(req, res, backend, req.path, payload, rec, stream);
  }

  /**
   * `POST /v1/images/generations` against an `sdiffusion` backend: the request
   * is rebuilt as a native `img_gen` job and polled to completion (§4.3.2).
   * One usage row per request, same once-guard as the passthrough path.
   */
  async function runSdGeneration(
    req: Request,
    res: Response,
    backend: ProxyBackend,
    body: Record<string, unknown>,
    rec: RequestRecorder,
  ): Promise<void> {
    res.setHeader('X-Proxy-Request-Id', rec.requestId);
    const translated = translateSdImageRequest(body);
    if (!translated.ok) {
      finalize(rec, 400, translated.error.message);
      openaiError(res, 400, translated.error.message, translated.error.code);
      return;
    }

    // A client that hangs up stops the poll loop and asks the backend to cancel
    // the job — unlike a passthrough socket, abandoning the loop can free the queue.
    const abort = new AbortController();
    let recorded = false;
    const finalizeOnce = (status: number, error?: string | null): void => {
      if (recorded) return;
      recorded = true;
      finalize(rec, status, error ?? undefined);
    };
    res.on('close', () => {
      if (res.writableEnded) return;
      abort.abort();
      finalizeOnce(499, 'client disconnected');
    });

    let outcome;
    try {
      outcome = await runSdImageJob({
        baseUrl: backend.baseUrl,
        request: translated.request,
        timeoutMs: backend.timeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
        signal: abort.signal,
      });
    } catch (e) {
      // `runSdImageJob` is written never to throw; this is the belt to the braces.
      finalizeOnce(502, `translator error: ${(e as Error)?.message ?? String(e)}`);
      if (!res.headersSent) openaiError(res, 502, `Image generation failed: ${(e as Error)?.message ?? String(e)}`, 'backend_error');
      return;
    }
    if (recorded) return; // the client already went away: the row exists
    rec.mergeMeta(outcome.meta);
    rec.markTtfb();
    finalizeOnce(outcome.status, outcome.errorMessage ?? null);
    res.status(outcome.status).json(outcome.body);
  }

  /** Raw passthrough endpoints (audio, image edits): body is piped unmodified. */
  function handleRaw(req: Request, res: Response): void {
    const modelHeader = (req.headers['x-model'] as string) || undefined;
    // Try to peek model from JSON content-type bodies without consuming the stream
    const resolved = resolveOr404(req, res, modelHeader ?? inferRawModel(req));
    if (!resolved) return;
    const { route, backend } = resolved;
    const allowed = req.path.startsWith('/v1/images/') ? IMAGE_KINDS : AUDIO_KINDS;
    if (!allowed.includes(backend.kind)) {
      openaiError(res, 400, `Endpoint ${req.path} requires a ${req.path.startsWith('/v1/images/') ? 'stable diffusion' : 'audio'} model`, 'unsupported_model');
      return;
    }
    const rec = makeRecorder(req, modelHeader ?? inferRawModel(req) ?? '', route.backend, false);
    forward(req, res, backend, req.path, null, rec, false);
  }

  function inferRawModel(req: Request): string | undefined {
    // Multipart bodies: rip out a `model` field heuristically from the first KB is
    // overkill; rely on x-model header or path fallback instead.
    void req;
    return undefined;
  }

  /** Forward via node:http, piping both directions. */
  function forward(
    req: Request,
    res: Response,
    backend: ProxyBackend,
    path: string,
    jsonPayload: Buffer | null,
    rec: RequestRecorder,
    stream: boolean,
  ): void {
    res.setHeader('X-Proxy-Request-Id', rec.requestId);
    const target = new URL(backend.baseUrl);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`;
    if (jsonPayload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(jsonPayload.length);
    }

    // One usage row per request: the upstream paths below finalize normally,
    // and the client-abort path must not record a second one.
    let recorded = false;
    const finalizeOnce = (status: number, error?: string | null): void => {
      if (recorded) return;
      recorded = true;
      finalize(rec, status, error ?? undefined);
    };
    // An upstream read failure after headers were sent: the status line is gone,
    // so cut the client connection rather than leave it waiting forever.
    const abortClient = (): void => {
      if (!res.writableEnded) res.destroy();
    };

    const connectMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const idleMs = backend.timeoutMs === 0 ? 0 : (backend.timeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS);
    let connected = false;

    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path,
        method: req.method,
        headers,
        // Socket idle timeout from the start, covering the connect phase (§3.7).
        timeout: connectMs,
      },
      (upRes) => {
        rec.markTtfb();
        const statusCode = upRes.statusCode ?? 502;
        const contentType = String(upRes.headers['content-type'] ?? '');
        const isSse = stream && contentType.includes('text/event-stream');

        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
          outHeaders[k] = v;
        }
        res.writeHead(statusCode, outHeaders);

        if (isSse) {
          const scanner = new SseUsageScanner();
          scanner.on('error', () => { /* passthrough continues below */ });
          // The scanner's own 'end' runs after its flush, so a trailing usage
          // line without a final newline is still counted.
          scanner.on('end', () => {
            rec.adoptScanner(scanner);
            finalizeOnce(statusCode);
          });
          upRes.on('error', () => {
            finalizeOnce(statusCode, 'upstream stream error');
            abortClient();
          });
          upRes.pipe(scanner).pipe(res);
        } else if (contentType.includes('application/json')) {
          // Stream the body straight through (large embedding batches are
          // legitimately many MB) and keep a bounded copy only for usage.
          const chunks: Buffer[] = [];
          let size = 0;
          upRes.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= MAX_USAGE_SCAN_BYTES) chunks.push(c);
          });
          upRes.on('end', () => {
            if (size <= MAX_USAGE_SCAN_BYTES) {
              try {
                const usage = extractJsonUsage(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                rec.setUsage(usage.input, usage.output, usage.cached);
              } catch { /* non-parseable JSON: leave usage null */ }
            }
            finalizeOnce(statusCode);
          });
          upRes.on('error', () => {
            finalizeOnce(statusCode, 'upstream read error');
            abortClient();
          });
          upRes.pipe(res);
        } else {
          upRes.on('end', () => finalizeOnce(statusCode));
          upRes.on('error', () => {
            finalizeOnce(statusCode, 'upstream stream error');
            abortClient();
          });
          upRes.pipe(res);
        }
      },
    );

    upstream.on('error', (e) => {
      finalizeOnce(502, `upstream error: ${e.message}`);
      if (!res.headersSent) {
        openaiError(res, 502, `Backend ${backend.baseUrl} unreachable: ${e.message}`, 'backend_unreachable');
      } else {
        res.end();
      }
    });

    // Connected: swap the fast connect timeout for the idle budget (§3.7). This
    // must happen at connect, not at response headers — a non-streamed
    // completion sends nothing until it is done, which easily exceeds 5 s.
    // A pooled keep-alive socket is already connected.
    upstream.on('socket', (socket) => {
      const onConnect = (): void => {
        connected = true;
        upstream.setTimeout(idleMs);
      };
      if (socket.connecting) socket.once('connect', onConnect);
      else onConnect();
    });

    // Node only *emits* `timeout` on an idle socket — destroying the request is
    // on us. The message distinguishes a stalled/dead backend from a reset.
    upstream.on('timeout', () => {
      upstream.destroy(new Error(`timed out after ${connected ? idleMs : connectMs}ms without data`));
    });

    // Propagate client aborts (§3.7): an abandoned client must not keep the
    // upstream socket open. (It does not cancel an sd.cpp generation — its
    // mutex is held regardless — but it frees the proxy.)
    // `res.on('close')` is the reliable hangup signal: `req.on('close')` fires
    // as soon as the request body has been consumed, long before any abort.
    // `writableEnded === false` means the response was cut short; an upstream
    // failure already recorded above, so the once-guard keeps it to one row.
    res.on('close', () => {
      if (res.writableEnded) return;
      finalizeOnce(499, 'client disconnected');
      upstream.destroy();
    });

    if (jsonPayload) upstream.end(jsonPayload);
    else req.pipe(upstream);
  }

  return app;
}
