/**
 * Shared helpers for the user-managed backend (proxy upstream) list.
 */

import type { ProxyBackend, ProxyBackendKind } from './types.js';

export const BACKEND_KINDS: ProxyBackendKind[] = ['llamacpp', 'audio', 'sdiffusion', 'custom'];

export function isBackendKind(v: unknown): v is ProxyBackendKind {
  return v === 'llamacpp' || v === 'audio' || v === 'sdiffusion' || v === 'custom';
}

/** Slug id derived from a name, uniquified against the existing list. */
export function makeBackendId(name: string, existing: ProxyBackend[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'backend';
  let id = base;
  let n = 2;
  while (existing.some((b) => b.id === id)) id = `${base}-${n++}`;
  return id;
}

/** First enabled backend of a given kind (used for prefix/path fallbacks). */
export function backendOfKind(backends: ProxyBackend[], kind: ProxyBackendKind): ProxyBackend | undefined {
  return backends.find((b) => b.enabled && b.kind === kind);
}
