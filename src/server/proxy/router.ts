/**
 * Model routing for the proxy (docs/proxy-server.md §4).
 * Resolution order: exact registry match -> prefix convention -> path fallback.
 * Backends are user-managed; routes reference backend ids.
 */

import { backendOfKind } from './backends.js';
import type { ProxyBackend, ProxyBackendKind, ProxyModelRoute, ProxySettings } from './types.js';

export interface ResolvedRoute {
  /** id of the resolved ProxyBackend */
  backend: string;
  /** Model name to use upstream (backendModel if set, else requested name). */
  upstreamModel: string;
  /** The registry entry that matched, if any. */
  route?: ProxyModelRoute;
}

/** Prefix convention: "audio/...", "sd/...", "tts/..." map onto backend kinds. */
const PREFIX_KINDS: Record<string, ProxyBackendKind> = {
  'audio/': 'audio',
  'sd/': 'sdiffusion',
  'tts/': 'audio',
};

export class ModelRouter {
  private byModel = new Map<string, ProxyModelRoute>();
  private backends: ProxyBackend[] = [];

  /** Rebuild the registry: llama routes (aliases) + declared audio/SD/custom routes. */
  rebuild(settings: ProxySettings, llamaAliases: string[]): void {
    this.byModel.clear();
    this.backends = settings.backends;
    const llamaBackend = backendOfKind(settings.backends, 'llamacpp');
    if (llamaBackend) {
      for (const alias of llamaAliases) {
        this.byModel.set(alias, { model: alias, backend: llamaBackend.id, enabled: true, auto: true });
      }
    }
    for (const m of settings.models) {
      this.byModel.set(m.model, m);
    }
    // Models discovered from upstream /v1/models (e.g. multiple llama.cpp instances):
    // route by model name. Existing entries (aliases, declared routes) win.
    for (const b of settings.backends) {
      if (!b.enabled) continue;
      for (const model of b.models ?? []) {
        if (!this.byModel.has(model)) {
          this.byModel.set(model, { model, backend: b.id, enabled: true, auto: true });
        }
      }
    }
  }

  listRoutes(): ProxyModelRoute[] {
    return [...this.byModel.values()].filter((m) => m.enabled);
  }

  /**
   * Resolve a request to a backend.
   * @param model the `model` field from the request body (may be empty/missing)
   * @param path  the proxy request path, for the path-based fallback
   */
  resolve(model: string | undefined, path: string): ResolvedRoute | null {
    if (model) {
      const route = this.byModel.get(model);
      if (route) {
        if (!route.enabled) return null;
        const backend = this.backends.find((b) => b.id === route.backend);
        if (!backend || !backend.enabled) return null;
        return { backend: backend.id, upstreamModel: route.backendModel ?? route.model, route };
      }
      for (const [prefix, kind] of Object.entries(PREFIX_KINDS)) {
        if (model.startsWith(prefix)) {
          const backend = backendOfKind(this.backends, kind);
          if (backend) return { backend: backend.id, upstreamModel: model.slice(prefix.length) };
          return null;
        }
      }
    }
    // Path fallback for namespaced endpoints
    if (path.startsWith('/v1/audio/')) {
      const backend = backendOfKind(this.backends, 'audio');
      return backend ? { backend: backend.id, upstreamModel: model ?? '' } : null;
    }
    if (path.startsWith('/v1/images/')) {
      const backend = backendOfKind(this.backends, 'sdiffusion');
      return backend ? { backend: backend.id, upstreamModel: model ?? '' } : null;
    }
    return null;
  }
}
