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
