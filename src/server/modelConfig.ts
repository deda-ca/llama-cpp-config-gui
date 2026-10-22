// --- Model Config Types ---

export type ParamCategory =
  | 'gpu'
  | 'context'
  | 'sampling'
  | 'reasoning'
  | 'speculative'
  | 'other';

export type ParamInputType =
  | 'text'
  | 'number'
  | 'select'
  | 'preset'
  | 'toggle'
  | 'comma-list'
  | 'path';

export interface ParamDef {
  /** Full CLI flag name, e.g. "--cache-type-k" */
  flag: string;
  /** INI key (no dashes), e.g. "cache-type-k" */
  key: string;
  /** Human-readable label */
  label: string;
  /** Short description from llama.cpp docs */
  description: string;
  /** Category for grouping */
  category: ParamCategory;
  /** Input control type */
  inputType: ParamInputType;
  /** Default value (string representation) */
  default?: string;
  /** Options for select inputs */
  options?: string[];
  /** Preset values for 'preset' inputs (free text still allowed, shown in a dropdown) */
  presets?: string[];
}

export interface ModelConfig {
  id: string;
  alias: string;
  displayName: string;
  notes: string;
  modelPath: string;
  mmproj?: string;
  chatTemplateFile?: string;
  /** Ordered list of param keys that are active in this config */
  params: Record<string, string>;
  /** Order of param keys for display (drag-to-reorder) */
  paramOrder: string[];
  /** Param keys that are kept in the config but disabled (commented out in INI) */
  disabledParams?: string[];
  /** Whether this config is included in router launches (checkbox in the list) */
  includeInLaunch?: boolean;
  isDefault: boolean;
}

export interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  /** Param keys pre-populated when creating from this template */
  params: Record<string, string>;
  paramOrder: string[];
}

export interface ModelsFile {
  configs: ModelConfig[];
  templates: ConfigTemplate[];
  defaultConfigId: string | null;
  /** Ordered list of config IDs, used to persist the model list order */
  configOrder?: string[];
}

// --- Storage ---

import fs from 'fs';
import path from 'path';
import { configDir } from './config.js';

// Paths resolve at call time so tests can isolate .config by changing cwd.
function modelsFile(): string {
  return path.join(configDir(), 'models.json');
}

export function normalizeModelsFile(data: any): ModelsFile {
  const configs = Array.isArray(data?.configs) ? data.configs : [];
  const configOrder = Array.isArray(data?.configOrder)
    ? data.configOrder.filter((id: unknown) => typeof id === 'string')
    : configs.map((cfg: any) => cfg?.id).filter((id: unknown): id is string => typeof id === 'string');

  const byId = new Map<string, ModelConfig>();
  for (const cfg of configs) {
    if (cfg?.id && typeof cfg.id === 'string') byId.set(cfg.id, cfg);
  }

  const orderedConfigs: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const id of configOrder) {
    const cfg = byId.get(id);
    if (cfg && !seen.has(id)) {
      orderedConfigs.push(cfg);
      seen.add(id);
    }
  }
  for (const cfg of configs) {
    if (cfg?.id && typeof cfg.id === 'string' && !seen.has(cfg.id)) {
      orderedConfigs.push(cfg);
      seen.add(cfg.id);
    }
  }

  const normalized: ModelsFile = {
    configs: orderedConfigs,
    templates: Array.isArray(data?.templates) ? data.templates : [],
    defaultConfigId: typeof data?.defaultConfigId === 'string' ? data.defaultConfigId : orderedConfigs[0]?.id || null,
    configOrder: orderedConfigs.map((cfg) => cfg.id),
  };

  if (normalized.defaultConfigId && !normalized.configs.some((cfg) => cfg.id === normalized.defaultConfigId)) {
    normalized.defaultConfigId = normalized.configs[0]?.id || null;
  }

  return normalized;
}

export function loadModels(): ModelsFile {
  try {
    const raw = fs.readFileSync(modelsFile(), 'utf-8');
    return normalizeModelsFile(JSON.parse(raw));
  } catch {
    return { configs: [], templates: [], defaultConfigId: null, configOrder: [] };
  }
}

export function saveModels(data: ModelsFile): void {
  const normalized = normalizeModelsFile(data);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(modelsFile(), JSON.stringify(normalized, null, 2));
}

// --- Params Reference ---

const PARAMS_FILE_NAME = 'params.json';

/**
 * Params catalog file for an engine kind (docs/llm-engines.md §2.6).
 * llama.cpp keeps the original `params.json` for back-compat; other kinds use
 * `params.<kind>.json`. `kind` is optional so existing llama.cpp callers are
 * unchanged.
 */
export function paramsFileForKind(kind?: string): string {
  return path.join(configDir(), !kind || kind === 'llamacpp' ? PARAMS_FILE_NAME : `params.${kind}.json`);
}

export function loadParams(kind?: string): ParamDef[] {
  try {
    const raw = fs.readFileSync(paramsFileForKind(kind), 'utf-8');
    return JSON.parse(raw);
  } catch {
    // Kinds without their own catalog yet fall back to the llama.cpp reference
    // so the param editor still shows something useful.
    if (kind && kind !== 'llamacpp') {
      try {
        return JSON.parse(fs.readFileSync(paramsFileForKind(), 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }
}

export function saveParams(params: ParamDef[], kind?: string): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(paramsFileForKind(kind), JSON.stringify(params, null, 2));
}

// --- ID generation ---

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
