/**
 * stable-diffusion.cpp engine config (docs/stable-diffusion.md §3).
 *
 * `sd-server` has **no config file**: unlike strata (`strata-<id>.json`) and
 * audio.cpp (`audio-<id>.json`) there is nothing to generate — the launch is
 * the flag list itself, and the weights are *not* on the command line. The
 * server starts empty from `--model-dir` roots and every model arrives over
 * `POST /sdcpp/v1/models/load` (Option A, §1.4.1/§3.10), which is why
 * `--model-dir` is a required row rather than a convenience.
 *
 * `serverArgs` rows are keyed by the **flag verbatim** (`--listen-port`,
 * `--backend`, `--model-dir`, …) because these are real CLI flags — the
 * opposite of audio's config-key rows.
 *
 * `extra` preserves flags the UI has no row for so an import/export round-trip
 * never loses data, mirroring `AudioConfig.extra`.
 *
 * Model cards live in models.json with `type: 'sdiffusion'`; an instance
 * selects them by id and `modelConfigIds[0]` is the card loaded at startup
 * (sd-server holds exactly one context — `load` is unload-then-load in one
 * call, §1.4.1).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeEngineParams, normalizeEnvVars } from './store.js';
import type { ModelConfig } from '../modelConfig.js';
import type { SdConfig, EngineParam } from './types.js';

/** Default port for a new sd-server instance (`--listen-port`; sd-server has no `--port`). */
export const SD_DEFAULT_PORT = 8080;

/**
 * The parent folder holding one folder per model (§1.3.1). `--model-dir`
 * points at the *model* folders, never at this parent: category dirs must be
 * **immediate** children of a root, so pointing here would scan nothing.
 *
 * The shared `models/` root is deliberately not the default either — it also
 * holds llama.cpp and audio GGUFs, which `--model-dir` must not scan.
 */
export function sdModelsRoot(): string {
  return path.join(os.homedir(), 'Programs', 'AI', 'models', 'sd');
}

/**
 * The category directory names the server's own scan recognises
 * (`k_model_slots` categories in `examples/server/model_catalog.cpp`, plus the
 * two aliases `model_category_directories` accepts: `Stable-diffusion` for
 * `checkpoints` and `lora` for `loras`). A folder under the sd root counts as a
 * model root only when one of these is an *immediate* child.
 */
export const SD_CATEGORY_DIRS: readonly string[] = [
  'checkpoints',
  'diffusion_models',
  'text_encoders',
  'clip_vision',
  'tokenizers',
  'vae',
  'vae_approx',
  'controlnet',
  'ipadapter',
  'motion_modules',
  'photomaker',
  'pulid',
  'loras',
  'stable-diffusion',
  'lora',
];

/** True when `dir` looks like a model root: it has a recognised category dir as an immediate child. */
export function isSdModelRoot(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) => e.isDirectory() && SD_CATEGORY_DIRS.includes(e.name.toLowerCase()),
  );
}

/**
 * The `--model-dir` rows to seed a new instance with: every folder under the sd
 * root that is itself a model root, **sorted by name**.
 *
 * Sorting is not cosmetic — root order is load-bearing. The first root keeps
 * plain file-ids (`diffusion_models/x.gguf`) and every later root gets an
 * `@<16-hex-hash>/…` prefix (§1.3.1 caveat 1), so discovery order must not
 * drift between launches. Manual rows still win: this only seeds a new
 * instance.
 */
export function discoverSdModelDirs(root: string = sdModelsRoot()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter(isSdModelRoot)
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** Blank sd block for a new instance: bind rows plus the discovered model roots. */
export function blankSdConfig(): SdConfig {
  return {
    envVars: {},
    serverArgs: [
      { key: '--listen-ip', value: '127.0.0.1' },
      { key: '--listen-port', value: String(SD_DEFAULT_PORT) },
      // One row per discovered model folder (§5 Q4). Empty when the sd root
      // does not exist yet — the launch path then refuses to start the
      // instance with a clear error rather than serving an empty catalog.
      ...discoverSdModelDirs().map((dir): EngineParam => ({ key: '--model-dir', value: dir })),
    ],
    modelConfigIds: [],
    extra: {},
  };
}

/**
 * Normalize an sd block read from disk or an API body. Defensive like
 * `normalizeAudioConfig`: a missing/garbage block is `undefined`, so an old
 * engines.json loads unchanged.
 */
export function normalizeSdConfig(raw: unknown): SdConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  return {
    envVars: normalizeEnvVars(c.envVars),
    serverArgs: normalizeEngineParams(c.serverArgs),
    modelConfigIds: Array.isArray(c.modelConfigIds)
      ? c.modelConfigIds.filter((x): x is string => typeof x === 'string')
      : [],
    extra: c.extra && typeof c.extra === 'object' && !Array.isArray(c.extra)
      ? { ...(c.extra as Record<string, unknown>) }
      : {},
  };
}

/**
 * Port an sd instance listens on, from its `--listen-port` server row.
 *
 * `-l` is **not** aliased here: on `sd-server` it is the listen *IP*, not the
 * port (unlike llama.cpp's `-p`), so treating it as a port would read an
 * address as a number.
 */
export function sdPort(sd: SdConfig | undefined): number | null {
  const raw = sd?.serverArgs.find((p) => p.key === '--listen-port' && !p.disabled)?.value;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** Value of an enabled flag row (first match), '' when absent/blank. */
function flagValue(sd: SdConfig | undefined, flag: string): string {
  const raw = sd?.serverArgs.find((p) => p.key === flag && !p.disabled)?.value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The address an sd instance binds to, for the "open sd.cpp UI" link (§3.8). */
export function sdHost(sd: SdConfig | undefined): string {
  return flagValue(sd, '--listen-ip') || '127.0.0.1';
}

/** Every enabled `--model-dir` row, in launch order (the first is the primary root). */
export function sdModelDirs(sd: SdConfig | undefined): string[] {
  return (sd?.serverArgs ?? [])
    .filter((p) => p.key === '--model-dir' && !p.disabled)
    .map((p) => (p.value ?? '').trim())
    .filter((v) => v !== '');
}

/**
 * The folder an sd instance runs from: the folder holding its executable —
 * the same rule `audioRunDir` follows, and what lets a relative `--model-dir`
 * or weight path resolve the way the user's own start script does. A bare name
 * (PATH lookup) has no folder and yields '' (spawn inherits).
 */
export function sdRunDir(binary: string | undefined): string {
  const trimmed = (binary ?? '').trim();
  if (!trimmed || !trimmed.includes('/')) return '';
  return path.dirname(path.resolve(trimmed));
}

// ---------------------------------------------------------------------------
// Card -> load request (§3.3)
// ---------------------------------------------------------------------------

/**
 * A `GET /sdcpp/v1/model-files` entry (`routes_models.cpp:132`). `id` is the
 * opaque value a load request must carry: `<category>/<relative>` under the
 * first `--model-dir` root, `@<16-hex-hash>/<relative>` under every later one
 * (§1.3.1 caveat 1). `root` is that root's `@<hash>` id (`""`-ish for the
 * primary root — the primary root's files simply carry no prefix), which is
 * what lets the UI filter component pickers to one model folder (§3.8).
 */
export interface SdModelFile {
  id: string;
  name: string;
  category: string;
  root: string;
  relative_path: string;
}

/**
 * The 22 slots the server knows (`k_model_slots`, `model_catalog.cpp:19-42`),
 * mapped to the **CLI spelling** the card row uses. The two vocabularies are
 * deliberately not the same: slots are snake_case (`clip_l`,
 * `high_noise_diffusion_model`) while flags are whatever `sd-server -h` prints,
 * which mixes both (`--clip_l` but `--diffusion-model`, `--audio-vae`).
 *
 * `tae`/`taesd` are one field behind two aliases; the card keeps the flag the
 * user wrote and the alias is normalised at load time (upstream folds
 * `taesd`->`tae` and rejects specifying both, `model_catalog.cpp:631-637`).
 */
export const SD_SLOT_FLAGS: Record<string, string> = {
  model: '--model',
  diffusion_model: '--diffusion-model',
  high_noise_diffusion_model: '--high-noise-diffusion-model',
  uncond_diffusion_model: '--uncond-diffusion-model',
  clip_l: '--clip_l',
  clip_g: '--clip_g',
  clip_vision: '--clip_vision',
  t5xxl: '--t5xxl',
  llm: '--llm',
  llm_vision: '--llm_vision',
  tokenizer: '--tokenizer',
  vae: '--vae',
  audio_vae: '--audio-vae',
  audio_encoder: '--audio-encoder',
  embeddings_connectors: '--embeddings-connectors',
  tae: '--tae',
  taesd: '--taesd',
  control_net: '--control-net',
  ip_adapter: '--ip-adapter',
  motion_module: '--motion-module',
  photo_maker: '--photo-maker',
  pulid_weights: '--pulid-weights',
};

/** Reverse of `SD_SLOT_FLAGS`: card row key -> slot id. */
export const SD_FLAG_SLOTS: Record<string, string> = Object.fromEntries(
  Object.entries(SD_SLOT_FLAGS).map(([slot, flag]) => [flag, slot]),
);

/** The primary slot: a card's `modelPath` fills `model` (checkpoint) or `diffusion_model`. */
export const SD_PRIMARY_SLOTS = ['model', 'diffusion_model'] as const;

/**
 * Card generation rows -> the recipe `defaults{}` vocabulary
 * (`apply_recipe_defaults`, `model_catalog.cpp:166-169`). Only these 20 keys are
 * accepted there — anything else makes the server reject the whole recipe with
 * `unknown key in defaults`, so the table is closed, not open-ended.
 *
 * Rows outside the table are **not** dropped silently: they are reported as
 * warnings and left out of `defaults{}` (they still reach the launch line in
 * argv-fallback mode, §3.3).
 *
 * The left column is the **CLI** spelling, so it follows `sd-server -h` rather
 * than the JSON name: `--sigmas` fills `custom_sigmas`, and `--timestep-shift`
 * fills `shifted_timestep` (`common.cpp:1252` binds them). Two defaults keys
 * (`high_noise_scheduler`, `high_noise_flow_shift`) have no flag of their own
 * yet, so those rows only appear when typed by hand — kept so a hand-written
 * card still reaches the recipe instead of being dropped.
 */
export const SD_DEFAULT_KEYS: Record<string, string> = {
  '--width': 'width',
  '--height': 'height',
  '--steps': 'steps',
  '--cfg-scale': 'cfg_scale',
  '--strength': 'strength',
  '--guidance': 'distilled_guidance',
  '--sampling-method': 'sampling_method',
  '--scheduler': 'scheduler',
  '--sigmas': 'custom_sigmas',
  '--video-frames': 'video_frames',
  '--fps': 'fps',
  '--flow-shift': 'flow_shift',
  '--moe-boundary': 'moe_boundary',
  '--high-noise-steps': 'high_noise_steps',
  '--high-noise-cfg-scale': 'high_noise_cfg_scale',
  '--high-noise-flow-shift': 'high_noise_flow_shift',
  '--high-noise-sampling-method': 'high_noise_sampling_method',
  '--high-noise-scheduler': 'high_noise_scheduler',
  '--img-cfg-scale': 'img_cfg_scale',
  '--timestep-shift': 'shifted_timestep',
};

/**
 * Card rows -> the recipe `context{}` vocabulary (`apply_recipe_context`,
 * `model_catalog.cpp:275-292`). This is how a card pins its **own** GPU split:
 * the launch-line `--backend` becomes the base context for every API-loaded
 * model (§1.4.1), and a recipe `context{}` overrides it per load.
 */
export const SD_CONTEXT_KEYS: Record<string, string> = {
  '--backend': 'backend',
  '--params-backend': 'params_backend',
  '--vae-format': 'vae_format',
  '--model-args': 'model_args',
};

/** Keys a recipe file may carry at the top level (`validate_recipe`). */
const RECIPE_KEYS = [
  'schema_version', 'id', 'name', 'description', 'model_url', 'slots',
  'required_any', 'defaults', 'context', 'features', 'disabled_features',
];

/** A `models/load` body: recipe id + slot -> catalog file-id. */
export interface SdLoadRequest {
  recipe: string;
  models: Record<string, string>;
}

/** Enabled card rows in `paramOrder` order (rows with no order entry keep insertion order). */
function orderedCardRows(cfg: ModelConfig): { key: string; value: string }[] {
  const disabled = new Set(cfg.disabledParams ?? []);
  const keys = cfg.paramOrder?.length
    ? [...cfg.paramOrder.filter((k) => k in cfg.params), ...Object.keys(cfg.params).filter((k) => !(cfg.paramOrder ?? []).includes(k))]
    : Object.keys(cfg.params);
  const out: { key: string; value: string }[] = [];
  for (const key of keys) {
    if (disabled.has(key)) continue;
    const value = cfg.params[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    out.push({ key, value: value.trim() });
  }
  return out;
}

/**
 * Resolve an absolute on-disk path to the catalog file-id a load request needs.
 *
 * The id is **never constructed** — `api.md` forbids it ("Do not construct IDs
 * or use display names in load requests"), and the `@<hash>` prefix a later
 * root gets is derived from the root's canonical path, which we cannot
 * reproduce reliably. So the live `model-files` list is the only source, and a
 * path that is not inside any scanned root has no id at all (§1.4.1).
 *
 * Matching is on the canonical path: `relative_path` is relative to the root,
 * and the root itself is only identified by its opaque `@<hash>`, so the file
 * list alone cannot rebuild an absolute path — the caller supplies the roots it
 * launched with, and the first root whose join matches wins.
 */
export function resolveSdFileId(
  absolutePath: string,
  files: SdModelFile[],
  roots: string[],
): string | null {
  const target = path.resolve(absolutePath);
  // Prefer the exact join against a known root (the shape upstream itself
  // canonicalises), then fall back to a suffix match for a root the user did
  // not list but whose files are in the catalog anyway.
  for (const root of roots) {
    const rootAbs = path.resolve(root);
    const relative = path.relative(rootAbs, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const id = files.find((f) => f.relative_path === relative.split(path.sep).join('/'))?.id;
    if (id) return id;
  }
  const posix = target.split(path.sep).join('/');
  const match = files
    .filter((f) => posix.endsWith('/' + f.relative_path))
    .sort((a, b) => b.relative_path.length - a.relative_path.length)[0];
  return match?.id ?? null;
}

/**
 * Which primary slot a card's `modelPath` fills (§3.2): a card that also names
 * a *separate* component — an encoder, a VAE, a TAE — is a split bundle, so its
 * primary file is the standalone DiT (`diffusion_model`); a card that names
 * nothing else is an all-in-one checkpoint (`model`). An explicit
 * `--diffusion-model` row settles it either way.
 */
export function sdPrimarySlot(cfg: ModelConfig): 'model' | 'diffusion_model' {
  const rows = orderedCardRows(cfg);
  if (rows.some((r) => r.key === SD_SLOT_FLAGS.diffusion_model)) return 'diffusion_model';
  const split = rows.some((r) => {
    const slot = SD_FLAG_SLOTS[r.key];
    return !!slot && !SD_PRIMARY_SLOTS.includes(slot as (typeof SD_PRIMARY_SLOTS)[number]);
  });
  return split ? 'diffusion_model' : 'model';
}

/** Result of building a load request: either a request, or the reasons it cannot be built. */
export interface SdLoadRequestResult {
  request?: SdLoadRequest;
  /** Slot/file problems that make the load impossible — surface these to the user. */
  errors: string[];
  /** Non-fatal notes: rows that cannot become recipe defaults, alias choices, … */
  warnings: string[];
}

/**
 * A model card -> the `POST /sdcpp/v1/models/load` body (§3.3).
 *
 * `sdExtras.recipe` names the recipe, `modelPath` fills the primary slot, and
 * every component row fills its slot — with the path translated to a live
 * catalog file-id. Generation rows become recipe `defaults{}` and the device
 * rows a `context{}` **only when we emit the recipe ourselves** (a built-in's
 * defaults are theirs to keep; overriding them would need a user recipe, which
 * is what `sdBuildUserRecipe` produces).
 */
export function sdModelToLoadRequest(
  cfg: ModelConfig,
  files: SdModelFile[],
  roots: string[],
): SdLoadRequestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const extras = cfg.sdExtras ?? {};
  const recipe = typeof extras.recipe === 'string' ? extras.recipe.trim() : '';
  if (!recipe) {
    errors.push(`"${cfg.alias || cfg.id}" has no recipe id (sdExtras.recipe): pick a built-in recipe or let the GUI emit one`);
  }

  const models: Record<string, string> = {};
  const fill = (slot: string, rawPath: string): void => {
    const abs = path.resolve(rawPath);
    const id = resolveSdFileId(abs, files, roots);
    if (!id) {
      errors.push(
        `${slot}: ${abs} is not inside any --model-dir root, so it has no catalog file-id. `
        + 'Move the file under a scanned model folder, add that folder with --model-dir, or use the argv fallback (§3.3).',
      );
      return;
    }
    models[slot] = id;
  };

  const primary = (cfg.modelPath ?? '').trim();
  const rows = orderedCardRows(cfg);
  const primarySlot = sdPrimarySlot(cfg);
  // modelPath is the primary component (§3.2); the matching flag row
  // (--model / --diffusion-model) is an accepted spelling when modelPath is
  // empty, so a card imported from a command line round-trips either way.
  const primaryFlag = SD_SLOT_FLAGS[primarySlot];
  const primaryValue = primary || (rows.find((r) => r.key === primaryFlag)?.value ?? '');
  if (!primaryValue) {
    errors.push(`"${cfg.alias || cfg.id}" has no primary component: set the checkpoint (--model) or the diffusion model (--diffusion-model)`);
  } else {
    fill(primarySlot, primaryValue);
  }

  for (const row of rows) {
    const slot = SD_FLAG_SLOTS[row.key];
    if (!slot || slot === primarySlot) continue; // primary already filled
    // The *other* primary slot (a `--model` row on a split card, or a
    // `--diffusion-model` row when modelPath is the checkpoint) is still a real
    // slot the server accepts, so it fills like any other component.
    fill(slot, row.value);
  }

  if (models.tae && models.taesd) {
    errors.push('specify only one of --tae and --taesd (they are aliases of the same slot)');
  }

  if (errors.length) return { errors, warnings };
  if (!recipe) return { errors, warnings };
  return { request: { recipe, models }, errors, warnings };
}

/**
 * Card generation rows -> a recipe `defaults{}` object.
 *
 * Only the 20 keys in `SD_DEFAULT_KEYS` are legal there — `check_keys` rejects
 * the whole recipe for anything else — so rows outside the table (`--clip-skip`,
 * `--seed`, `--denoiser…`) are reported in `skipped` rather than silently
 * dropped: they are per-request or launch-line settings, not model defaults.
 */
export function sdRecipeDefaults(cfg: ModelConfig): {
  defaults: Record<string, unknown>;
  skipped: { key: string; value: string }[];
} {
  const defaults: Record<string, unknown> = {};
  const skipped: { key: string; value: string }[] = [];
  for (const row of orderedCardRows(cfg)) {
    const dKey = SD_DEFAULT_KEYS[row.key];
    if (dKey) defaults[dKey] = parseSdValue(row.value);
    else if (!SD_FLAG_SLOTS[row.key] && !SD_CONTEXT_KEYS[row.key]) skipped.push(row);
  }
  return { defaults, skipped };
}

/**
 * The user recipe a card implies, in the schema `api.md:238-265` documents
 * (`schema_version: 1`, `id`, `name`, `slots[]`, optional `required_any`,
 * `defaults`, `context`, `features`). Emitted into
 * `<model-dir>/recipes/<id>.json` for a card whose recipe is not a built-in —
 * which is also the only way a card's own generation defaults and GPU split
 * reach the loaded model (§3.3).
 *
 * Slot ids come from the component rows actually filled, so the recipe declares
 * exactly the bundle the card describes. `required_any: [["vae","tae"]]`
 * mirrors the built-ins' VAE-or-TAE choice.
 */
export function sdBuildUserRecipe(cfg: ModelConfig, recipeId: string): Record<string, unknown> {
  const slots: { id: string; required: boolean }[] = [];
  const context: Record<string, unknown> = {};
  const rows = orderedCardRows(cfg);
  const primarySlot = sdPrimarySlot(cfg);
  slots.push({ id: primarySlot, required: true });
  const { defaults } = sdRecipeDefaults(cfg);

  for (const row of rows) {
    let slot = SD_FLAG_SLOTS[row.key];
    // Built-in recipes name the Tiny AutoEncoder slot `tae`; `taesd` is the
    // legacy alias of the same field. Emit the canonical id so the recipe and
    // the load request agree (upstream folds the alias either way, and rejects
    // a recipe that declares both).
    if (slot === 'taesd') slot = 'tae';
    if (slot && slot !== primarySlot && !slots.some((s) => s.id === slot)) {
      slots.push({ id: slot, required: false });
    }
    const cKey = SD_CONTEXT_KEYS[row.key];
    if (cKey) context[cKey] = row.value;
  }

  const features = Array.isArray(cfg.sdExtras?.capabilities)
    ? (cfg.sdExtras?.capabilities as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];

  const recipe: Record<string, unknown> = {
    schema_version: 1,
    id: recipeId,
    name: cfg.displayName || cfg.alias || recipeId,
    slots,
  };
  if (cfg.notes.trim()) recipe.description = cfg.notes.trim();
  // The built-ins' VAE-or-TAE choice, only when the card declares both; a
  // checkpoint with a bundled VAE (no VAE row) must stay loadable, so the
  // group never appears on its own.
  if (slots.some((s) => s.id === 'vae') && slots.some((s) => s.id === 'tae')) {
    recipe.required_any = [['vae', 'tae']];
  }
  if (Object.keys(defaults).length) recipe.defaults = defaults;
  if (Object.keys(context).length) recipe.context = context;
  if (features.length) recipe.features = features;
  return recipe;
}

/** Where a user recipe for a card belongs: `<first model root>/recipes/<id>.json`. */
export function sdRecipePath(roots: string[], recipeId: string): string {
  const root = roots[0];
  if (!root) throw new Error('no --model-dir root to write the recipe into');
  return path.join(root, 'recipes', `${recipeId}.json`);
}

/** Recipe ids must be 1-128 of [A-Za-z0-9._-] (`valid_identifier`, `model_catalog.cpp:146`). */
export function slugifySdRecipeId(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (base || 'model').slice(0, 128);
}

/** Restore a JSON type for a recipe value written from a text row. */
function parseSdValue(raw: string): unknown {
  const s = raw.trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  if (s.includes(',')) {
    const parts = s.split(',').map((x) => x.trim());
    // `custom_sigmas` (the only list-valued default) must be an array of
    // numbers — `apply_recipe_defaults` rejects string elements — so a
    // comma-separated numeric row becomes number[]. A non-numeric list (no
    // such default exists today) stays strings.
    const nums = parts.map(Number);
    return parts.every((p, i) => p !== '' && Number.isFinite(nums[i])) ? nums : parts;
  }
  return s;
}

/** Keys a recipe object may carry at the top level — exported for validation/tests. */
export const SD_RECIPE_KEYS = RECIPE_KEYS;

// ---------------------------------------------------------------------------
// argv fallback (§3.3): components outside the model root, or a model with no
// usable recipe. Choosing this mode means restart-to-swap and the
// `@command-line` restrictions (§1.4.1) — the loaded context is not
// submittable to models/load and its defaults come from the command line.
// ---------------------------------------------------------------------------

/**
 * A model card -> `sd-server` weight flags, verbatim (`-m` is the short form
 * `sd-server` prints for `--model`, so the primary checkpoint uses it).
 * Relative paths are absolutized against `baseDir` — the instance's run folder,
 * i.e. the executable's folder — because that is the cwd the process starts in
 * (`sdRunDir`), matching the audio rule.
 *
 * Generation rows are **not** emitted here: in fallback mode they are already
 * ordinary instance rows or the server's own defaults, and duplicating them per
 * card would fight the user's launch line.
 */
export function sdModelToArgs(cfg: ModelConfig, baseDir: string): EngineParam[] {
  const out: EngineParam[] = [];
  const primarySlot = sdPrimarySlot(cfg);
  const primary = (cfg.modelPath ?? '').trim()
    || (orderedCardRows(cfg).find((r) => r.key === SD_SLOT_FLAGS[primarySlot])?.value ?? '');
  if (primary) {
    out.push({ key: primarySlot === 'model' ? '-m' : SD_SLOT_FLAGS.diffusion_model, value: resolveFrom(primary, baseDir) });
  }
  for (const row of orderedCardRows(cfg)) {
    const slot = SD_FLAG_SLOTS[row.key];
    if (!slot || slot === primarySlot) continue;
    out.push({ key: row.key, value: resolveFrom(row.value, baseDir) });
  }
  return out;
}

/**
 * `sd-server` weight flags -> a model card (Import from a command line, §3.8).
 * Anything that is not a component flag is left out — the instance rows own the
 * server options — and the recipe id is derived from the primary file name so
 * the card is loadable once its files sit under a root.
 */
export function sdModelFromArgs(argv: string[]): ModelConfig {
  const params: Record<string, string> = {};
  const paramOrder: string[] = [];
  let modelPath = '';

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const flag = SD_FLAG_SLOTS[token] ? token : (token === '-m' ? '--model' : null);
    if (!flag) continue;
    const value = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
    if (!value) continue;
    if (flag === '--model' || flag === '--diffusion-model') {
      if (!modelPath) modelPath = value;
      else params[flag] = value;
      if (!paramOrder.includes(flag)) paramOrder.push(flag);
      continue;
    }
    params[flag] = value;
    if (!paramOrder.includes(flag)) paramOrder.push(flag);
  }

  const primaryBase = modelPath ? path.basename(modelPath).replace(/\.(gguf|safetensors|sft|ckpt|pt|pth|bin)$/i, '') : 'model';
  return {
    id: '',
    alias: slugifySdRecipeId(primaryBase),
    displayName: primaryBase,
    notes: '',
    modelPath,
    params,
    paramOrder,
    type: 'sdiffusion',
    sdExtras: { recipe: slugifySdRecipeId(primaryBase), capabilities: [] },
    includeInLaunch: true,
    isDefault: false,
  };
}

/** Absolute paths pass through; relatives resolve against `baseDir` (the instance run folder). */
function resolveFrom(value: string, baseDir: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return trimmed;
  return baseDir ? path.resolve(baseDir, trimmed) : trimmed;
}
