/**
 * Model routing for the proxy (docs/proxy-server.md §4).
 * Resolution order: exact registry match -> prefix convention -> path fallback
 * -> 'default' kind backend (catch-all).
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

/** Prefix convention: "audio/...", "sd/...", "tts/"... map onto backend kinds. */
const PREFIX_KINDS: Record<string, ProxyBackendKind> = {
  'audio/': 'audio',
  'sd/': 'sdiffusion',
  'tts/': 'audio',
  'embed/': 'embeddings',
  'mod/': 'moderation',
  'video/': 'videos',
};

/** Path fallback: namespaced endpoints map onto backend kinds. */
const PATH_KINDS: [string, ProxyBackendKind][] = [
  ['/v1/audio/', 'audio'],
  ['/v1/images/', 'sdiffusion'],
  ['/v1/embeddings', 'embeddings'],
  ['/v1/moderations', 'moderation'],
  ['/v1/videos', 'videos'],
];

export class ModelRouter {
  private byModel = new Map<string, ProxyModelRoute[]>();
  private backends: ProxyBackend[] = [];

  /** Rebuild the registry: llama routes (aliases) + declared audio/SD/custom routes. */
  rebuild(settings: ProxySettings, llamaAliases: string[]): void {
    this.byModel.clear();
    this.backends = settings.backends;
    const llamaBackend = backendOfKind(settings.backends, 'llamacpp');
    if (llamaBackend) {
      for (const alias of llamaAliases) {
        this.addRoute({ model: alias, backend: llamaBackend.id, enabled: true, auto: true });
      }
    }
    for (const m of settings.models) {
      this.addRoute(m);
    }
    // Models discovered from upstream /v1/models (e.g. multiple llama.cpp instances):
    // route by model name. Existing entries (aliases, declared routes) win.
    for (const b of settings.backends) {
      if (!b.enabled) continue;
      for (const model of b.models ?? []) {
        if (!this.byModel.has(model)) {
          this.addRoute({ model, backend: b.id, enabled: true, auto: true });
        }
      }
    }
  }

  /** Insert a route, keeping declared entries ahead of auto-discovered ones. */
  private addRoute(route: ProxyModelRoute): void {
    const list = this.byModel.get(route.model);
    if (!list) {
      this.byModel.set(route.model, [route]);
      return;
    }
    if (!route.auto) {
      const firstAuto = list.findIndex((r) => r.auto);
      if (firstAuto < 0) list.push(route);
      else list.splice(firstAuto, 0, route);
    } else {
      list.push(route);
    }
  }

  /** The live route for an alias: the flagged-active one when its upstream model
   *  is actually served by that backend, else the first duplicate whose upstream
   *  is available, else the flagged/first route (unchanged behaviour otherwise). */
  private activeRoute(model: string): ProxyModelRoute | undefined {
    const list = this.byModel.get(model);
    if (!list || list.length === 0) return undefined;
    const flagged = list.find((r) => r.active) ?? list[0];
    if (list.length > 1 && !this.upstreamAvailable(flagged)) {
      // Same alias, several upstreams: prefer one that is live upstream right now.
      const available = list.find((r) => this.upstreamAvailable(r));
      if (available) return available;
    }
    return flagged;
  }

  /** True when the route's upstream model is reported by its backend's discovery.
   *  Unknown discovery (never refreshed) counts as available. */
  private upstreamAvailable(route: ProxyModelRoute): boolean {
    if (!route.enabled) return false;
    const backend = this.backends.find((b) => b.id === route.backend);
    if (!backend || !backend.enabled) return false;
    if (!backend.models) return true;
    return backend.models.includes(route.backendModel ?? route.model);
  }

  listRoutes(): ProxyModelRoute[] {
    return [...this.byModel.keys()]
      .map((model) => this.activeRoute(model)!)
      .filter((m) => m.enabled);
  }

  /** Every registry entry, including non-active duplicates of the same alias. */
  allRoutes(): ProxyModelRoute[] {
    return [...this.byModel.values()].flat();
  }

  /**
   * Resolve a request to a backend.
   * @param model the `model` field from the request body (may be empty/missing)
   * @param path  the proxy request path, for the path-based fallback
   */
  resolve(model: string | undefined, path: string): ResolvedRoute | null {
    let prefixStripped: string | null = null;
    if (model) {
      const route = this.activeRoute(model);
      if (route) {
        if (!route.enabled) return null;
        const backend = this.backends.find((b) => b.id === route.backend);
        if (!backend || !backend.enabled) return null;
        return { backend: backend.id, upstreamModel: route.backendModel ?? route.model, route };
      }
      for (const [prefix, kind] of Object.entries(PREFIX_KINDS)) {
        if (model.startsWith(prefix)) {
          const target = this.kindTarget(kind);
          if (target === undefined) {
            prefixStripped = model.slice(prefix.length); // kind not configured -> 'default' catch-all
            break;
          }
          return target
            ? { backend: target.id, upstreamModel: model.slice(prefix.length) }
            : null; // explicitly disabled -> not rescued by 'default'
        }
      }
    }
    // Path fallback for namespaced endpoints
    for (const [prefix, kind] of PATH_KINDS) {
      if (!path.startsWith(prefix)) continue;
      const target = this.kindTarget(kind);
      if (target !== undefined) return target ? { backend: target.id, upstreamModel: model ?? '' } : null;
    }
    // Catch-all: a backend of kind 'default' receives anything not routed elsewhere.
    const fallback = backendOfKind(this.backends, 'default');
    if (fallback) return { backend: fallback.id, upstreamModel: prefixStripped ?? model ?? '' };
    return null;
  }

  /** Fallback target for a kind: the first *enabled* backend of it, `null` when
   *  every backend of that kind is disabled (blocked, not rescued by 'default'),
   *  `undefined` when the kind is not configured at all. A disabled backend
   *  listed first must not shadow an enabled one of the same kind. */
  private kindTarget(kind: ProxyBackendKind): ProxyBackend | null | undefined {
    const ofKind = this.backends.filter((b) => b.kind === kind);
    if (ofKind.length === 0) return undefined;
    return ofKind.find((b) => b.enabled) ?? null;
  }
}
