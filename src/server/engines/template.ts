/**
 * Per-kind parameter templates (`.config/params.<kind>.template.json`).
 *
 * A template is the ordered list of CLI parameters auto-filled when a new
 * engine instance of that kind is created (docs/llm-engines.md §2.6). It is
 * plain `EngineParam` rows — the engine model stays a generic
 * executable + env + params spawner, so things like `--host`, `--port` or
 * `--api-key` are ordinary parameters here, never dedicated fields.
 *
 * File naming follows `paramsFileForKind()`: llama.cpp keeps
 * `params.template.json`, other kinds use `params.<kind>.template.json`.
 * When the file is absent, `defaultTemplateForKind()` seeds the list.
 */

import fs from 'fs';
import path from 'path';
import { configDir, readJsonFile } from '../config.js';
import { DEFAULT_PARAMS } from '../params-default.js';
import { normalizeEngineParams } from './store.js';
import type { EngineParam } from './types.js';

function templateFileForKind(kind: string): string {
  return path.join(configDir(), kind === 'llamacpp' ? 'params.template.json' : `params.${kind}.template.json`);
}

/**
 * Seed template for a kind. llama.cpp: the common server flags first
 * (model, host, port, api-key), then the curated `templateOrder` slice of the
 * params catalog with its defaults. Other kinds start empty — the generic
 * spawner has no knowledge of any specific tool's flags.
 */
export function defaultTemplateForKind(kind: string): EngineParam[] {
  if (kind !== 'llamacpp') return [];

  const byFlag = new Map(DEFAULT_PARAMS.map((p) => [p.flag, p]));
  const out: EngineParam[] = [
    { key: '--host', value: '127.0.0.1' },
    { key: '--port', value: '8080' },
    { key: '--api-key' },
  ];
  for (const flag of templateOrder) {
    const def = byFlag.get(flag);
    if (!def) continue;
    // Toggle params default to "off": keep them as bare flags so the row is
    // visible but enabling it stays an explicit user choice.
    out.push(def.default && def.inputType !== 'toggle' ? { key: flag, value: def.default } : { key: flag });
  }
  return out;
}

/**
 * Catalog flags shown after the server basics, in display order. Kept short on
 * purpose — the full catalog stays available through the "+ Add" row.
 */
const templateOrder = [
  '--ctx-size',
  '--n-gpu-layers',
  '--flash-attn',
  '--threads',
  '--parallel',
  '--temp',
  '--top-p',
  '--top-k',
  '--min-p',
  '--repeat-penalty',
  '--seed',
];

/** Load the template for a kind; seeded default when the file is missing. */
export function loadTemplate(kind: string): EngineParam[] {
  const parsed = readJsonFile(templateFileForKind(kind));
  return parsed === undefined ? defaultTemplateForKind(kind) : normalizeEngineParams(parsed);
}

/** Persist the template for a kind (rows normalized before writing). */
export function saveTemplate(kind: string, params: unknown): EngineParam[] {
  const normalized = normalizeEngineParams(params);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(templateFileForKind(kind), JSON.stringify(normalized, null, 2));
  return normalized;
}
