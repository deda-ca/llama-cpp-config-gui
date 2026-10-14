/**
 * Types for the OpenAI-compatible proxy gateway (docs/proxy-server.md).
 */

/** Determines endpoint compatibility and usage-capture behavior. */
export type ProxyBackendKind = 'llamacpp' | 'audio' | 'sdiffusion' | 'custom';

/** A user-managed upstream server that the proxy can route to. */
export interface ProxyBackend {
  /** Stable slug id, derived from name on creation. */
  id: string;
  name: string;
  kind: ProxyBackendKind;
  baseUrl: string;
  enabled: boolean;
  /** Optional key the proxy sends upstream (Bearer). Empty = none. */
  apiKey?: string;
  /** Model ids discovered from the upstream's GET /v1/models (via Refresh). */
  models?: string[];
  /** ISO timestamp of the last successful model discovery. */
  modelsFetchedAt?: string;
}

/** A model route in the proxy registry. */
export interface ProxyModelRoute {
  /** Model name clients send in the `model` field. */
  model: string;
  /** id of the ProxyBackend this routes to. */
  backend: string;
  /** Upstream model name if different from `model` (e.g. llama router alias). */
  backendModel?: string;
  enabled: boolean;
  /** True for routes auto-derived from llama.cpp model configs (read-only). */
  auto?: boolean;
}

export interface ProxySettings {
  /** Runtime switch: true while the proxy listener is running. */
  enabled: boolean;
  /** Start the proxy automatically when the GUI server boots. */
  autoStart: boolean;
  host: string;
  port: number;
  /** Optional client-facing API key (Bearer). Empty = no auth. */
  apiKey: string;
  usageRetentionDays: number;
  backends: ProxyBackend[];
  /** Declared audio/SD/custom routes; llama alias routes are derived from model configs. */
  models: ProxyModelRoute[];
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  enabled: false,
  autoStart: false,
  host: '127.0.0.1',
  port: 8090,
  apiKey: '',
  usageRetentionDays: 90,
  backends: [
    { id: 'llamacpp', name: 'llama.cpp', kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', enabled: true },
    { id: 'audio', name: 'audio.cpp', kind: 'audio', baseUrl: 'http://127.0.0.1:8082', enabled: true },
    { id: 'sdiffusion', name: 'stable-diffusion.cpp', kind: 'sdiffusion', baseUrl: 'http://127.0.0.1:7860', enabled: true },
  ],
  models: [],
};

function normalizeBackend(raw: unknown, fallbackId: string, fallbackKind: ProxyBackendKind, fallbackName: string): ProxyBackend | null {
  const b = (raw ?? {}) as Partial<ProxyBackend>;
  if (typeof b.baseUrl !== 'string') return null;
  const kind = b.kind === 'llamacpp' || b.kind === 'audio' || b.kind === 'sdiffusion' || b.kind === 'custom' ? b.kind : fallbackKind;
  return {
    id: typeof b.id === 'string' && b.id ? b.id : fallbackId,
    name: typeof b.name === 'string' && b.name ? b.name : fallbackName,
    kind,
    baseUrl: b.baseUrl,
    enabled: b.enabled !== false,
    ...(typeof b.apiKey === 'string' && b.apiKey ? { apiKey: b.apiKey } : {}),
    ...(Array.isArray(b.models) ? { models: b.models.filter((m): m is string => typeof m === 'string') } : {}),
    ...(typeof b.modelsFetchedAt === 'string' ? { modelsFetchedAt: b.modelsFetchedAt } : {}),
  };
}

/** Merge partial settings over defaults, defensively. Migrates the legacy
 *  fixed-key `backends` object ({llamacpp:{...}, audio:{...}}) to a list. */
export function normalizeProxySettings(partial: unknown): ProxySettings {
  const p = (partial ?? {}) as Partial<ProxySettings> & { backends?: unknown };
  const d = DEFAULT_PROXY_SETTINGS;

  let backends: ProxyBackend[];
  if (Array.isArray(p.backends)) {
    backends = p.backends
      .map((b, i) => normalizeBackend(b, `backend-${i + 1}`, 'custom', `Backend ${i + 1}`))
      .filter((b): b is ProxyBackend => b !== null);
  } else if (p.backends && typeof p.backends === 'object') {
    // Legacy shape: fixed llamacpp/audio/sdiffusion keys
    const legacy = p.backends as Record<string, unknown>;
    backends = [
      normalizeBackend(legacy.llamacpp, 'llamacpp', 'llamacpp', 'llama.cpp'),
      normalizeBackend(legacy.audio, 'audio', 'audio', 'audio.cpp'),
      normalizeBackend(legacy.sdiffusion, 'sdiffusion', 'sdiffusion', 'stable-diffusion.cpp'),
    ].filter((b): b is ProxyBackend => b !== null);
  } else {
    backends = d.backends.map((b) => ({ ...b }));
  }
  // Ensure unique ids
  const ids = new Set<string>();
  for (const b of backends) {
    let id = b.id;
    let n = 2;
    while (ids.has(id)) id = `${b.id}-${n++}`;
    b.id = id;
    ids.add(id);
  }

  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : d.enabled,
    autoStart: typeof p.autoStart === 'boolean' ? p.autoStart : d.autoStart,
    host: typeof p.host === 'string' && p.host ? p.host : d.host,
    port: Number.isInteger(p.port) ? p.port! : d.port,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : d.apiKey,
    usageRetentionDays: Number.isInteger(p.usageRetentionDays) && p.usageRetentionDays! > 0
      ? p.usageRetentionDays! : d.usageRetentionDays,
    backends,
    models: Array.isArray(p.models)
      ? p.models.filter((m) => m && typeof m.model === 'string' && typeof m.backend === 'string')
      : [],
  };
}

/** One row per proxied request. */
export interface UsageRecord {
  id?: number;
  requestId: string;
  /** ISO-8601 with offset, request start time. */
  timestamp: string;
  model: string;
  backend: string;
  endpoint: string;
  stream: boolean;
  status: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when token counts were estimated heuristically. */
  tokensEstimated: boolean;
  totalDurationMs: number;
  ttfbMs: number | null;
  tokensPerSec: number | null;
  clientIp: string;
  errorMessage: string | null;
  /** Backend-specific extras (steps, width/height, char counts...). */
  meta: Record<string, unknown> | null;
}

export interface UsageQuery {
  model?: string;
  backend?: string;
  /** ISO date/datetime lower bound (inclusive). */
  from?: string;
  /** ISO date/datetime upper bound (inclusive). */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface UsageSummaryRow {
  model: string;
  backend: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  avgTokensPerSec: number | null;
  avgTtfbMs: number | null;
  lastUsed: string | null;
}
