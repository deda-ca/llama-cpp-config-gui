// --- Model Config Types ---

/**
 * Grouping key for a parameter. The llama.cpp categories are listed for
 * autocomplete, but per-kind catalogs (`.config/params.<kind>.json`) are plain
 * user-editable JSON, so any category string is accepted — the editor renders
 * unknown ones as extra groups (see EngineEditor's categoryOrder).
 */
export type ParamCategory =
  | 'gpu'
  | 'context'
  | 'sampling'
  | 'reasoning'
  | 'speculative'
  | 'other'
  | (string & {});

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
  /** Starred in the model list — purely a UI marker, ignored by launchers */
  favorite?: boolean;
  /**
   * Engine family this card configures (docs/audio.md §2.1). The type decides
   * which parameter catalog the card edits and what the generated launch file
   * looks like: `llamacpp` params are CLI flags rendered into the router INI,
   * `audio` params are audio.cpp config keys rendered into a `models[]` entry.
   * Open-ended so a later kind (stable-diffusion.cpp) needs no type change.
   * Absent = 'llamacpp', keeping every pre-existing card working unchanged.
   */
  type?: string;
  /**
   * audio.cpp only: model keys too nested for flat rows (`voice_presets`,
   * `default_voice_preset`, `live_ingest`, `model_spec_override`, `config`,
   * `weight`), plus anything the UI has no field for. Preserved verbatim and
   * re-emitted on export, mirroring `AudioConfig.extra` at server level.
   */
  audioExtras?: Record<string, unknown>;
  /**
   * stable-diffusion.cpp only (docs/stable-diffusion.md §3.2): the card-level
   * keys that have no param row.
   * - `recipe: string` — the **recipe id** submitted to `models/load`: one of
   *   sd.cpp's ~100 built-ins (`qwen-image-21`, `flux1-dev`, …) or an id we
   *   emit into `<model-dir>/recipes/<id>.json`. A recipe names *slots*, never
   *   files, so the component rows stay the source of the files.
   * - `capabilities: string[]` — mirrors a recipe's `features[]`
   *   (`ref_images`, `controlnet`, `ip_adapter`, `flow_shift`, …) so the UI only
   *   offers controls the checkpoint actually supports (§1.5.2).
   * - `hf_repo` / `hf_file` — provenance notes for a future Download button.
   * Preserved verbatim and re-emitted on export, mirroring `audioExtras`.
   */
  sdExtras?: Record<string, unknown>;
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
import { configDir, readJsonFile } from './config.js';

// Paths resolve at call time so tests can isolate .config by changing cwd.
function modelsFile(): string {
  return path.join(configDir(), 'models.json');
}

/**
 * Defensive per-card normalization. Most fields are trusted as written (the
 * editor owns them), but the kind-specific ones added later are validated so a
 * hand-edited models.json can never smuggle a wrong shape into a generator:
 * `type` must be a string, `audioExtras`/`sdExtras` a plain object.
 */
function normalizeModelCard(cfg: any): ModelConfig {
  const out: ModelConfig = cfg;
  if (typeof out.type !== 'string' || !out.type) delete out.type;
  if (!out.audioExtras || typeof out.audioExtras !== 'object' || Array.isArray(out.audioExtras)) {
    delete out.audioExtras;
  }
  if (!out.sdExtras || typeof out.sdExtras !== 'object' || Array.isArray(out.sdExtras)) {
    delete out.sdExtras;
  }
  return out;
}

export function normalizeModelsFile(data: any): ModelsFile {
  const configs = Array.isArray(data?.configs) ? data.configs : [];
  const configOrder = Array.isArray(data?.configOrder)
    ? data.configOrder.filter((id: unknown) => typeof id === 'string')
    : configs.map((cfg: any) => cfg?.id).filter((id: unknown): id is string => typeof id === 'string');

  const byId = new Map<string, ModelConfig>();
  for (const cfg of configs) {
    if (cfg?.id && typeof cfg.id === 'string') byId.set(cfg.id, normalizeModelCard(cfg));
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
      orderedConfigs.push(byId.get(cfg.id) as ModelConfig);
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
  const parsed = readJsonFile(modelsFile());
  if (parsed === undefined) return { configs: [], templates: [], defaultConfigId: null, configOrder: [] };
  return normalizeModelsFile(parsed);
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
