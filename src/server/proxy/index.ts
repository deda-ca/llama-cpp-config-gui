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
import { estimateMessagesTokens, estimateTokens } from './tokenCount.js';
import type { UsageDb } from './usageDb.js';
import type { ProxyBackend, ProxySettings, UsageRecord } from './types.js';

export interface ProxyAppDeps {
  /** Getter so settings changes apply without rebuilding the app. */
  getSettings: () => ProxySettings;
  router: ModelRouter;
  db: UsageDb;
  onUsage?: (rec: UsageRecord) => void;
  onRecordError?: (e: unknown) => void;
}

const JSON_BODY_LIMIT = '10mb';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

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
  // Audio endpoints: raw passthrough (multipart / binary bodies are not parsed)
  app.post('/v1/audio/speech', (req, res) => handleRaw(req, res));
  app.post('/v1/audio/transcriptions', (req, res) => handleRaw(req, res));

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

    // llama.cpp only serves text endpoints; SD/audio only their own namespaces
    const isTextEp = isChat || req.path === '/v1/completions' || req.path === '/v1/embeddings';
    if (isTextEp && backend.kind !== 'llamacpp' && backend.kind !== 'custom') {
      openaiError(res, 400, `Model "${model}" is not a text model for ${req.path}`, 'unsupported_model');
      return;
    }
    if (req.path === '/v1/images/generations' && backend.kind !== 'sdiffusion' && backend.kind !== 'custom') {
      openaiError(res, 400, `Model "${model}" is not an image model`, 'unsupported_model');
      return;
    }

    const stream = body.stream === true;
    const outBody = { ...body };
    if (route.upstreamModel !== model && (backend.kind === 'llamacpp' || backend.kind === 'custom')) outBody.model = route.upstreamModel;
    // Ensure streaming usage is available from llama.cpp
    if (isChat && stream && backend.kind === 'llamacpp') {
      const so = (outBody.stream_options ?? {}) as Record<string, unknown>;
      outBody.stream_options = { ...so, include_usage: true };
    }

    // Token estimation fallback applies to text endpoints only (not image/audio)
    const estimatedInput = isChat
      ? estimateMessagesTokens(body.messages)
      : isTextEp && typeof body.prompt === 'string' ? estimateTokens(body.prompt) : undefined;
    const meta = req.path === '/v1/images/generations'
      ? { promptChars: typeof body.prompt === 'string' ? body.prompt.length : 0, steps: body.steps, width: body.width, height: body.height, n: body.n }
      : null;

    const rec = makeRecorder(req, model ?? '', route.backend, stream, meta, estimatedInput);
    const payload = Buffer.from(JSON.stringify(outBody));
    forward(req, res, backend, req.path, payload, rec, stream);
  }

  /** Raw passthrough endpoints (audio): body is piped unmodified. */
  function handleRaw(req: Request, res: Response): void {
    const modelHeader = (req.headers['x-model'] as string) || undefined;
    // Try to peek model from JSON content-type bodies without consuming the stream
    const resolved = resolveOr404(req, res, modelHeader ?? inferAudioModel(req));
    if (!resolved) return;
    const { route, backend } = resolved;
    if (backend.kind !== 'audio' && backend.kind !== 'custom') {
      openaiError(res, 400, `Endpoint ${req.path} requires an audio model`, 'unsupported_model');
      return;
    }
    const rec = makeRecorder(req, modelHeader ?? inferAudioModel(req) ?? '', route.backend, false);
    forward(req, res, backend, req.path, null, rec, false);
  }

  function inferAudioModel(req: Request): string | undefined {
    // Multipart bodies: rip out a `model` field heuristically from the first KB is
    // overkill; rely on x-model header or path fallback instead.
    void req;
    return undefined;
  }

  /** Forward via node:http, piping both directions. */
  function forward(
    req: Request,
    res: Response,
    backend: { baseUrl: string; apiKey?: string },
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

    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path,
        method: req.method,
        headers,
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
          upRes.on('end', () => {
            rec.adoptScanner(scanner);
            finalize(rec, statusCode);
          });
          upRes.on('error', () => finalize(rec, statusCode, 'upstream stream error'));
          upRes.pipe(scanner).pipe(res);
        } else if (contentType.includes('application/json')) {
          const chunks: Buffer[] = [];
          let size = 0;
          upRes.on('data', (c: Buffer) => {
            chunks.push(c);
            size += c.length;
            if (size > 5 * 1024 * 1024) upRes.destroy(); // cap buffered JSON
          });
          upRes.on('end', () => {
            const buf = Buffer.concat(chunks);
            try {
              const usage = extractJsonUsage(JSON.parse(buf.toString('utf8')));
              rec.setUsage(usage.input, usage.output);
            } catch { /* non-parseable JSON: leave usage null */ }
            finalize(rec, statusCode);
            res.end(buf);
          });
          upRes.on('error', () => finalize(rec, statusCode, 'upstream read error'));
        } else {
          upRes.on('end', () => finalize(rec, statusCode));
          upRes.on('error', () => finalize(rec, statusCode, 'upstream stream error'));
          upRes.pipe(res);
        }
      },
    );

    upstream.on('error', (e) => {
      finalize(rec, 502, `upstream error: ${e.message}`);
      if (!res.headersSent) {
        openaiError(res, 502, `Backend ${backend.baseUrl} unreachable: ${e.message}`, 'backend_unreachable');
      } else {
        res.end();
      }
    });

    if (jsonPayload) upstream.end(jsonPayload);
    else req.pipe(upstream);
  }

  return app;
}
