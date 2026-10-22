/**
 * Types for the OpenAI-compatible proxy gateway (docs/proxy-server.md).
 */

/** Determines endpoint compatibility and usage-capture behavior. */
export type ProxyBackendKind =
  | 'llamacpp'
  | 'strata'
  | 'audio'
  | 'sdiffusion'
  | 'embeddings'
  | 'moderation'
  | 'videos'
  | 'default'
  | 'custom';

/** All valid backend kinds, in UI display order. 'default' is the catch-all
 *  fallback for requests that match no route, prefix or path convention. */
export const BACKEND_KINDS: ProxyBackendKind[] = [
  'llamacpp',
  'strata',
  'embeddings',
  'audio',
  'sdiffusion',
  'moderation',
  'videos',
  'default',
  'custom',
];

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

/** A model route in the proxy registry. Several routes may share the same
 *  `model` alias (same client-facing name, different upstream); exactly one of
 *  them is `active` and receives requests. */
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
  /** True for the live route of a duplicated alias. Missing = first route wins. */
  active?: boolean;
}

/** USD price per 1M tokens. */
export interface ModelPricing {
  input: number;
  cached: number;
  output: number;
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
  /** USD price per 1M tokens keyed by model name (for Usage panel cost estimates). */
  modelPricing: Record<string, ModelPricing>;
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
  modelPricing: {},
};

/** Validate/normalize a pricing object; returns null if not a valid pricing. */
export function normalizePricing(raw: unknown): ModelPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<ModelPricing>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const input = num(p.input);
  const cached = num(p.cached);
  const output = num(p.output);
  if (input === null && cached === null && output === null) return null;
  return { input: input ?? 0, cached: cached ?? 0, output: output ?? 0 };
}

function normalizeBackend(raw: unknown, fallbackId: string, fallbackKind: ProxyBackendKind, fallbackName: string): ProxyBackend | null {
  const b = (raw ?? {}) as Partial<ProxyBackend>;
  if (typeof b.baseUrl !== 'string') return null;
  const kind: ProxyBackendKind = BACKEND_KINDS.includes(b.kind as ProxyBackendKind) ? (b.kind as ProxyBackendKind) : fallbackKind;
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
    models: (() => {
      const routes = Array.isArray(p.models)
        ? p.models.filter((m) => m && typeof m.model === 'string' && typeof m.backend === 'string')
        : [];
      // Duplicate aliases are allowed (same client name -> different upstreams);
      // keep exactly one active route per alias, defaulting to the first.
      const activeByAlias = new Map<string, boolean>();
      for (const m of routes) {
        if (m.active && !activeByAlias.has(m.model)) activeByAlias.set(m.model, true);
      }
      for (const m of routes) {
        if (!activeByAlias.get(m.model)) {
          m.active = true;
          activeByAlias.set(m.model, true);
        } else {
          m.active = false;
        }
      }
      return routes;
    })(),
    modelPricing: (() => {
      const out: Record<string, ModelPricing> = {};
      if (p.modelPricing && typeof p.modelPricing === 'object') {
        for (const [model, raw] of Object.entries(p.modelPricing)) {
          const pricing = normalizePricing(raw);
          if (pricing) out[model] = pricing;
        }
      }
      return out;
    })(),
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
  /** KV-cache hit tokens within inputTokens (when upstream reports them). */
  cachedTokens: number | null;
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
  cachedTokens: number;
  avgTokensPerSec: number | null;
  avgTtfbMs: number | null;
  lastUsed: string | null;
}
