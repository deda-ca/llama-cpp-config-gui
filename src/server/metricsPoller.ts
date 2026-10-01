/**
 * Polls the llama.cpp /metrics endpoint (Prometheus format) on a fixed
 * interval and computes per-model token speeds.
 *
 * In router mode the router itself serves:
 *   GET /models             → lists all models with load status
 *   GET /metrics?model=<id> → proxied to the child server owning the model
 * (both require the API key when one is set; /metrics requires --metrics).
 *
 * The poller discovers which models are currently loaded each round and
 * only queries those, so unloaded models cost nothing. Models that get
 * unloaded have their stale metrics pruned.
 *
 * Speeds are computed from counter deltas between polls, using llama.cpp's
 * own processing-time counters so idle gaps don't skew the numbers:
 *   prefill t/s = Δprompt_tokens_total / Δprompt_seconds_total
 *   generation t/s = Δtokens_predicted_total / Δtokens_predicted_seconds_total
 */

import type { ModelMetrics } from './types.js';

const FETCH_TIMEOUT_MS = 2000;

export interface MetricsEndpoint {
  /** Base URL of the llama-server router, e.g. http://127.0.0.1:8080 */
  baseUrl: string;
  /** API key for the server (sent as Authorization: Bearer <key>) */
  apiKey?: string;
}

interface Counters {
  promptTokens: number;
  promptSeconds: number;
  genTokens: number;
  genSeconds: number;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function parseCounter(text: string, name: string): number | null {
  const m = text.match(new RegExp(`^${name}\\s+([\\d.eE+-]+)$`, 'm'));
  return m ? parseFloat(m[1]) : null;
}

export class ModelMetricsPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private endpoints: MetricsEndpoint[] = [];
  /** Previous counter values per model, for delta computation */
  private prev = new Map<string, Counters>();
  /** Latest known speeds per model (persisted across idle polls) */
  private latest = new Map<string, ModelMetrics>();

  onMetrics: ((metrics: ModelMetrics[]) => void) | null = null;

  start(endpoints: MetricsEndpoint[], intervalMs = 3000): void {
    this.stop();
    this.endpoints = endpoints;
    const tick = () => {
      void this.pollOnce();
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.endpoints = [];
  }

  /** Clear all state (call when a new process is launched). */
  reset(): void {
    this.prev.clear();
    this.latest.clear();
  }

  /** Snapshot of the latest known per-model metrics. */
  getMetrics(): ModelMetrics[] {
    return [...this.latest.values()].map((m) => ({ ...m }));
  }

  private async pollOnce(): Promise<void> {
    if (this.endpoints.length === 0) return;
    const results = await Promise.allSettled(this.endpoints.map((ep) => this.pollEndpoint(ep)));

    // Models seen this round; null means discovery failed → don't prune
    let active: Set<string> | null = new Set();
    let changed = false;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { seen, metrics } = r.value;
      if (seen === null) {
        active = null;
      } else {
        for (const m of seen) active!.add(m);
      }
      for (const m of metrics) {
        this.latest.set(m.model, m);
        changed = true;
      }
    }

    // Drop metrics for models that are no longer loaded
    if (active) {
      for (const key of [...this.latest.keys()]) {
        if (!active.has(key)) {
          this.latest.delete(key);
          changed = true;
        }
      }
    }

    if (changed) this.onMetrics?.(this.getMetrics());
  }

  private async pollEndpoint(ep: MetricsEndpoint): Promise<{ seen: string[] | null; metrics: ModelMetrics[] }> {
    const models = await this.discoverLoadedModels(ep);
    if (models === null) return { seen: null, metrics: [] };

    const metrics: ModelMetrics[] = [];
    for (const model of models) {
      const m = await this.pollTarget(ep, model);
      if (m) metrics.push(m);
    }
    return { seen: models, metrics };
  }

  /** Models currently loaded on the router; null on transient failure. */
  private async discoverLoadedModels(ep: MetricsEndpoint): Promise<string[] | null> {
    try {
      const res = await fetch(`${ep.baseUrl}/models`, {
        headers: authHeaders(ep.apiKey),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const data = await res.json() as { data?: unknown };
      const list = Array.isArray(data?.data) ? data.data : [];
      return list
        .filter((m: any) => m?.status?.value === 'loaded')
        .map((m: any) => String(m.id));
    } catch {
      return null;
    }
  }

  private async pollTarget(ep: MetricsEndpoint, model: string): Promise<ModelMetrics | null> {
    const url = `${ep.baseUrl}/metrics?model=${encodeURIComponent(model)}`;

    let text: string;
    try {
      const res = await fetch(url, {
        headers: authHeaders(ep.apiKey),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null; // model not loaded / metrics disabled — skip this round
      text = await res.text();
    } catch {
      return null;
    }

    const promptTokens = parseCounter(text, 'llamacpp:prompt_tokens_total');
    const promptSeconds = parseCounter(text, 'llamacpp:prompt_seconds_total');
    const genTokens = parseCounter(text, 'llamacpp:tokens_predicted_total');
    const genSeconds = parseCounter(text, 'llamacpp:tokens_predicted_seconds_total');
    if (promptTokens == null || promptSeconds == null || genTokens == null || genSeconds == null) {
      return null;
    }

    let prefill: number | null = null;
    let generation: number | null = null;

    const p = this.prev.get(model);
    if (p) {
      // Negative deltas mean the counters were reset (model reloaded) — ignore
      const dPromptTokens = promptTokens - p.promptTokens;
      const dPromptSeconds = promptSeconds - p.promptSeconds;
      const dGenTokens = genTokens - p.genTokens;
      const dGenSeconds = genSeconds - p.genSeconds;
      if (dPromptTokens > 0 && dPromptSeconds > 0) prefill = dPromptTokens / dPromptSeconds;
      if (dGenTokens > 0 && dGenSeconds > 0) generation = dGenTokens / dGenSeconds;
    }

    this.prev.set(model, { promptTokens, promptSeconds, genTokens, genSeconds });

    // Keep the last known value for fields with no new activity this round
    const existing = this.latest.get(model);
    return {
      model,
      prefillTokensPerSec: prefill ?? existing?.prefillTokensPerSec ?? null,
      generationTokensPerSec: generation ?? existing?.generationTokensPerSec ?? null,
      lastUpdated: Date.now(),
    };
  }
}
