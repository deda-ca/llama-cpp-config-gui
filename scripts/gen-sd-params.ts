/**
 * Generate `.config/params.sdiffusion.json` — the stable-diffusion.cpp
 * parameter catalog (docs/stable-diffusion.md §3.9).
 *
 * The flag vocabulary is parsed from `sd-cli -h` **and** `sd-server -h`. Both
 * share one Context Options vocabulary, but the sets are not identical: 16 flags
 * are sd-cli-only, and **sd-server hard-fails on an unknown argument**
 * (`error: unknown argument: --preview`, exit non-zero). So the catalog is the
 * intersection plus the server-only rows — anything the launched binary would
 * reject never reaches the editor.
 *
 * Each flag then gets a category, a label and an inputType from the table
 * below. Deprecated flags are dropped — the binary itself points users at their
 * replacement, and offering both in the editor only invites mistakes.
 *
 * Re-runnable: when the engine updates, run this again and diff the output.
 * Flags it does not know about land in `other` with an inferred inputType, so a
 * new upstream flag never disappears silently.
 *
 * Usage: npm run gen:sd-params [path-to-sd-repo-build-dir]
 *        (default: ~/Programs/AI/stable-diffusion.cpp/build/bin)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParamDef, ParamInputType } from '../src/server/modelConfig.js';

const root = path.resolve(import.meta.dirname, '..');
const defaultBinDir = path.join(os.homedir(), 'Programs/AI/stable-diffusion.cpp/build/bin');
const binDir = process.argv[2] || defaultBinDir;
const cliExe = path.join(binDir, 'sd-cli');
const serverExe = path.join(binDir, 'sd-server');

/** Curated category per flag. Anything absent falls back to `other`. */
const categories: Record<string, ParamDef['category']> = {
  // --- Model components (the slot vocabulary, §1.3) ---
  '--model': 'model',
  '--diffusion-model': 'model',
  '--high-noise-diffusion-model': 'model',
  '--uncond-diffusion-model': 'model',
  '--upscale-model': 'model',
  '--ad-model': 'model',
  // --- Text encoders ---
  '--clip_l': 'text-encoder',
  '--clip_g': 'text-encoder',
  '--t5xxl': 'text-encoder',
  '--llm': 'text-encoder',
  '--llm_vision': 'text-encoder',
  '--clip_vision': 'text-encoder',
  '--audio-encoder': 'text-encoder',
  '--embeddings-connectors': 'text-encoder',
  '--tokenizer': 'text-encoder',
  // --- VAE / decode ---
  '--vae': 'vae',
  '--vae-format': 'vae',
  '--audio-vae': 'vae',
  '--taesd': 'vae',
  '--tae': 'vae',
  '--taesd-preview-only': 'vae',
  '--force-sdxl-vae-conv-scale': 'vae',
  '--vae-tiling': 'vae',
  '--vae-tile-size': 'vae',
  '--vae-relative-tile-size': 'vae',
  '--vae-tile-overlap': 'vae',
  '--temporal-tiling': 'vae',
  '--extra-tiling-args': 'vae',
  // --- Add-on components ---
  '--control-net': 'addon',
  '--ip-adapter': 'addon',
  '--motion-module': 'addon',
  '--photo-maker': 'addon',
  '--pulid-weights': 'addon',
  '--lora-model-dir': 'addon',
  '--embd-dir': 'addon',
  '--hires-upscalers-dir': 'addon',
  '--lora-apply-mode': 'addon',
  '--qwen-image-layers': 'model',
  // --- Device / backend placement ---
  '--backend': 'device',
  '--params-backend': 'device',
  '--split-mode': 'device',
  '--max-vram': 'device',
  '--rpc-servers': 'device',
  '--list-devices': 'device',
  '--type': 'device',
  '--threads': 'device',
  // --- Memory / loading ---
  '--offload-to-cpu': 'memory',
  '--mmap': 'memory',
  '--auto-fit': 'memory',
  '--eager-load': 'memory',
  '--disable-prefetch': 'memory',
  '--disable-segmented-compute': 'memory',
  '--batched-cfg': 'memory',
  '--conditioning-cache-size': 'memory',
  // --- Attention / kernels ---
  '--flash-attn': 'kernel',
  '--conv-direct': 'kernel',
  '--sage-attn': 'kernel',
  '--linear-scale': 'kernel',
  '--attn-scale': 'kernel',
  // --- Size / batch ---
  '--width': 'size',
  '--height': 'size',
  '--batch-count': 'size',
  '--circular': 'size',
  '--circularx': 'size',
  '--circulary': 'size',
  // --- Highres fix ---
  '--hires': 'hires',
  '--hires-upscaler': 'hires',
  '--hires-scale': 'hires',
  '--hires-width': 'hires',
  '--hires-height': 'hires',
  '--hires-steps': 'hires',
  '--hires-denoising-strength': 'hires',
  '--hires-sigmas': 'hires',
  '--hires-upscale-tile-size': 'hires',
  '--upscale-repeats': 'hires',
  '--upscale-tile-size': 'hires',
  // --- Sampler / scheduler / guidance ---
  '--steps': 'sampler',
  '--sampling-method': 'sampler',
  '--scheduler': 'sampler',
  '--sigmas': 'sampler',
  '--eta': 'sampler',
  '--clip-skip': 'sampler',
  '--strength': 'sampler',
  '--prediction': 'sampler',
  '--extra-sample-args': 'sampler',
  '--cfg-scale': 'guidance',
  '--img-cfg-scale': 'guidance',
  '--guidance': 'guidance',
  '--slg-scale': 'guidance',
  '--skip-layer-start': 'guidance',
  '--skip-layer-end': 'guidance',
  '--skip-layers': 'guidance',
  '--flow-shift': 'guidance',
  '--timestep-shift': 'guidance',
  '--vace-strength': 'guidance',
  '--control-strength': 'guidance',
  '--ip-adapter-strength': 'guidance',
  '--pm-style-strength': 'guidance',
  '--pulid-id-weight': 'guidance',
  // --- Wan2.2 MoE (high-noise half) ---
  '--high-noise-steps': 'moe',
  '--high-noise-cfg-scale': 'moe',
  '--high-noise-img-cfg-scale': 'moe',
  '--high-noise-guidance': 'moe',
  '--high-noise-slg-scale': 'moe',
  '--high-noise-skip-layer-start': 'moe',
  '--high-noise-skip-layer-end': 'moe',
  '--high-noise-eta': 'moe',
  '--high-noise-sampling-method': 'moe',
  '--high-noise-skip-layers': 'moe',
  '--moe-boundary': 'moe',
  // --- Video ---
  '--video-frames': 'video',
  '--fps': 'video',
  '--control-video': 'video',
  '--ref-video': 'video',
  '--ref-video-audio': 'video',
  '--ref-audio': 'video',
  '--audio': 'video',
  // --- Reference images / editing ---
  '--ref-image': 'reference',
  '--ref-image-args': 'reference',
  '--increase-ref-index': 'reference',
  '--init-img': 'reference',
  '--end-img': 'reference',
  '--mask': 'reference',
  '--control-image': 'reference',
  '--ip-adapter-image': 'reference',
  '--image-preprocess': 'reference',
  '--pm-id-images-dir': 'reference',
  '--pm-id-embed-path': 'reference',
  '--pulid-id-embedding': 'reference',
  // --- ADetailer ---
  '--ad-prompt': 'adetailer',
  '--ad-negative-prompt': 'adetailer',
  '--extra-ad-args': 'adetailer',
  // --- Caching / speed ---
  '--cache-mode': 'cache',
  '--cache-option': 'cache',
  '--scm-mask': 'cache',
  '--scm-policy': 'cache',
  // --- Output ---
  '--output': 'output',
  '--output-begin-idx': 'output',
  '--compression-quality': 'output',
  '--preview': 'output',
  '--preview-path': 'output',
  '--preview-interval': 'output',
  '--preview-noisy': 'output',
  '--disable-image-metadata': 'output',
  // --- Prompts ---
  '--prompt': 'prompt',
  '--negative-prompt': 'prompt',
  '--prompt-file': 'prompt',
  '--negative-prompt-file': 'prompt',
  // --- RNG ---
  '--seed': 'rng',
  '--rng': 'rng',
  '--sampler-rng': 'rng',
  // --- Convert / inspect modes ---
  '--convert-name': 'convert',
  '--imat-in': 'convert',
  '--imat-out': 'convert',
  '--tensor-type-rules': 'convert',
  '--model-args': 'convert',
  '--image': 'convert',
  '--metadata-format': 'convert',
  '--metadata-raw': 'convert',
  '--metadata-brief': 'convert',
  '--metadata-all': 'convert',
  // --- Server / logging ---
  '--listen-ip': 'serve',
  '--listen-port': 'serve',
  '--model-dir': 'serve',
  '--serve-html-path': 'serve',
  '--log-level': 'logging',
  '--verbose': 'logging',
  '--color': 'logging',
  '--mode': 'other',
};

/** Human labels for flags whose help text has no usable short name. */
const labels: Record<string, string> = {
  '--clip_l': 'CLIP-L Text Encoder',
  '--clip_g': 'CLIP-G Text Encoder',
  '--t5xxl': 'T5-XXL Text Encoder',
  '--llm': 'LLM Text Encoder',
  '--llm_vision': 'LLM Vision Projector',
  '--clip_vision': 'CLIP-Vision Encoder',
  '--tae': 'Tiny AutoEncoder (alias)',
  '--moe-boundary': 'MoE Boundary',
  '--slg-scale': 'Skip Layer Guidance Scale',
  '--auto-fit': 'Auto Fit Weights',
  '--batched-cfg': 'Batched CFG',
  '--conv-direct': 'Direct Convolution',
  '--flash-attn': 'Flash Attention',
  '--sage-attn': 'SageAttention',
  '--rng': 'RNG Backend',
  '--sigmas': 'Custom Sigmas',
  '--scm-mask': 'SCM Steps Mask',
  '--scm-policy': 'SCM Policy',
};

/**
 * Flags excluded from the catalog. Each is a deprecated alias whose own help
 * text names the replacement — offering both in one editor is a footgun.
 */
const excluded: Record<string, string> = {
  '--qwen2vl': 'use --llm',
  '--qwen2vl_vision': 'use --llm_vision',
  '--clip-on-cpu': 'use --backend te=cpu',
  '--vae-on-cpu': 'use --backend vae=cpu',
  '--control-net-cpu': 'use --backend controlnet=cpu',
  '--fa': 'use --flash-attn on',
  '--diffusion-fa': 'use --flash-attn off,diffusion=on',
  '--diffusion-conv-direct': 'use --conv-direct auto,diffusion=on',
  '--vae-conv-direct': 'use --conv-direct auto,vae=on',
  // CLI-only one-shot plumbing: meaningless for a resident sd-server.
  '--mode': 'sd-cli run mode; sd-server is always a server',
  '--output': 'sd-cli writes a file; the server returns the image',
  '--output-begin-idx': 'sd-cli image sequence numbering',
  '--prompt': 'per-request, not a launch flag',
  '--negative-prompt': 'per-request, not a launch flag',
  '--prompt-file': 'per-request, not a launch flag',
  '--negative-prompt-file': 'per-request, not a launch flag',
  '--seed': 'per-request, not a launch flag',
  '--list-devices': 'probed by the driver, not a launch flag',
  '--color': 'ANSI codes in the log pipe break level parsing (§1.2)',
  '--help': 'not a parameter',
};

/**
 * Explicit inputType overrides where the help text is ambiguous. Everything
 * else is inferred from the `<type>` token and the description.
 */
const inputTypes: Record<string, ParamInputType> = {
  '--backend': 'text',
  '--params-backend': 'text',
  '--max-vram': 'text',
  '--split-mode': 'text',
  '--flash-attn': 'text',
  '--conv-direct': 'text',
  '--auto-fit': 'select',
  '--batched-cfg': 'select',
  '--vae-format': 'select',
  '--rng': 'select',
  '--sampler-rng': 'select',
  '--prediction': 'select',
  '--lora-apply-mode': 'select',
  '--sampling-method': 'select',
  '--high-noise-sampling-method': 'select',
  '--scheduler': 'select',
  '--preview': 'select',
  '--cache-mode': 'select',
  '--scm-policy': 'select',
  '--metadata-format': 'select',
  '--hires-upscaler': 'preset',
  '--sigmas': 'preset',
  '--hires-sigmas': 'preset',
  '--skip-layers': 'comma-list',
  '--high-noise-skip-layers': 'comma-list',
  '--scm-mask': 'comma-list',
  '--rpc-servers': 'comma-list',
  '--tokenizer': 'text',
  '--tae': 'path',
  '--imat-out': 'path',
  '--imat-in': 'path',
  '--tensor-type-rules': 'text',
  '--model-args': 'text',
  '--extra-sample-args': 'text',
  '--extra-tiling-args': 'text',
  '--extra-ad-args': 'text',
  '--ref-image-args': 'text',
  '--image-preprocess': 'text',
  '--cache-option': 'text',
  '--vae-tile-size': 'text',
  '--vae-relative-tile-size': 'text',
  // Value flags the help prints without a <type> token — inference would read
  // them as bare toggles.
  '--log-level': 'select',
  '--model-dir': 'path',
  '--type': 'preset',
  '--linear-scale': 'number',
  '--attn-scale': 'number',
  '--ref-image': 'path',
  '--ref-video': 'path',
  '--ref-video-audio': 'path',
  '--ref-audio': 'path',
  '--audio': 'path',
};

/** Select option lists, read off the help text (kept here so the UI can offer them). */
const selectOptions: Record<string, string[]> = {
  '--vae-format': ['auto', 'flux', 'sd3', 'flux2', 'wan'],
  '--rng': ['std_default', 'cuda', 'cpu'],
  '--sampler-rng': ['std_default', 'cuda', 'cpu'],
  '--prediction': ['eps', 'v', 'edm_v', 'sd3_flow', 'flux_flow', 'sefi_flow', 'minit2i_flow', 'sensenova_u1_flow', 'flux3_flow', 'h3_av_flow', 'ming_image_flow'],
  '--lora-apply-mode': ['auto', 'immediately', 'at_runtime'],
  '--sampling-method': ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd', 'res_multistep', 'res_2s', 'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp', 'euler_ge', 'dpm++2m_sde', 'dpm++2m_sde_bt', 'lms'],
  '--high-noise-sampling-method': ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd', 'res_multistep', 'res_2s', 'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp', 'euler_ge', 'dpm++2m_sde', 'dpm++2m_sde_bt', 'lms'],
  '--scheduler': ['discrete', 'karras', 'exponential', 'ays', 'gits', 'sgm_uniform', 'simple', 'smoothstep', 'kl_optimal', 'lcm', 'bong_tangent', 'ltx2', 'logit_normal', 'flux2', 'flux', 'beta', 'llada_image'],
  '--preview': ['none', 'proj', 'tae', 'vae'],
  '--cache-mode': ['easycache', 'ucache', 'dbcache', 'taylorseer', 'cache-dit', 'spectrum'],
  '--scm-policy': ['dynamic', 'static'],
  '--metadata-format': ['text', 'json'],
  '--log-level': ['debug', 'verbose', 'info', 'warn', 'error'],
  '--auto-fit': ['on', 'off', 'auto'],
  '--batched-cfg': ['on', 'off', 'auto'],
};

/** Free-text rows that still have useful starting points. */
const presets: Record<string, string[]> = {
  '--hires-upscaler': ['Latent', 'Lanczos', 'Nearest'],
  '--sigmas': ['qwen-image-2.1-turbo'],
  '--hires-sigmas': ['qwen-image-2.1-turbo'],
  '--type': ['f32', 'f16', 'q8_0', 'q5_0', 'q5_1', 'q4_0', 'q4_1', 'q2_K', 'q3_K', 'q4_K'],
};

/** Defaults worth pre-filling (only where the engine's default is a good one for us). */
const defaults: Record<string, string> = {
  '--threads': '-1',
  '--width': '512',
  '--height': '512',
  '--steps': '20',
  '--cfg-scale': '7.0',
  '--seed': '42',
};

/**
 * Descriptions worth overriding because the help text hides something the GUI
 * needs to know. `--model-dir` is the important one: the help prints no type
 * token, and repeating it is what makes model hot swapping possible at all
 * (docs/stable-diffusion.md §1.3.1, §1.4.1).
 */
const descriptions: Record<string, string> = {
  '--model-dir': 'model root to scan for category subfolders (checkpoints/, diffusion_models/, text_encoders/, vae/, …); repeat once per model folder — required for loading models over the API',
};

interface ParsedFlag {
  flag: string;
  short?: string;
  typeToken?: string;
  description: string;
}

/** Parse one `Options:` block of the help text into flags. */
function parseGroup(block: string): ParsedFlag[] {
  const out: ParsedFlag[] = [];
  let current: ParsedFlag | null = null;
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    // A flag line starts at a fixed 2-space indent with `-x,` or `--`.
    const m = /^  (?:-(\w), )?(--[a-z0-9][a-z0-9_-]*)(?: <([a-z0-9_]+)>)?\s\s*(.*)$/.exec(line);
    if (m) {
      if (current) out.push(current);
      current = { flag: m[2], short: m[1], typeToken: m[3], description: m[4].trim() };
      continue;
    }
    // Some flags have no description on the same line (e.g. --pm-style-strength).
    const bare = /^  (?:-(\w), )?(--[a-z0-9][a-z0-9_-]*)(?: <([a-z0-9_]+)>)?\s*$/.exec(line);
    if (bare) {
      if (current) out.push(current);
      current = { flag: bare[2], short: bare[1], typeToken: bare[3], description: '' };
      continue;
    }
    if (current) current.description += ' ' + line.trim();
  }
  if (current) out.push(current);
  return out;
}

/** Infer the editor control from the `<type>` token and the description. */
function inferInputType(f: ParsedFlag): ParamInputType {
  if (inputTypes[f.flag]) return inputTypes[f.flag];
  if (f.typeToken === 'int' || f.typeToken === 'float') return 'number';
  if (!f.typeToken) return 'toggle';
  const d = f.description.toLowerCase();
  if (d.startsWith('path to') || d.includes('directory') || d.endsWith('dir')) return 'path';
  return 'text';
}

/** Title-case a flag into a label, expanding the engine's own abbreviations. */
function labelFor(f: ParsedFlag): string {
  if (labels[f.flag]) return labels[f.flag];
  const words = f.flag.replace(/^--/, '').replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean);
  const cap: Record<string, string> = {
    vae: 'VAE', tae: 'TAE', taesd: 'TAE-SD', llm: 'LLM', clip: 'CLIP', cfg: 'CFG',
    slg: 'SLG', rng: 'RNG', imat: 'Imatrix', moe: 'MoE', ad: 'ADetailer',
    ip: 'IP', id: 'ID', esrgan: 'ESRGAN', rpc: 'RPC', vram: 'VRAM', scm: 'SCM',
    s2v: 'S2V', ltxav: 'LTXAV', vit: 'ViT', pm: 'PhotoMaker', pulid: 'PuLID',
  };
  return words.map((w) => cap[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function main(): void {
  for (const exe of [cliExe, serverExe]) {
    if (!fs.existsSync(exe)) {
      console.error(`[sd-params] not found: ${exe}\nPass the build/bin folder as an argument.`);
      process.exit(1);
    }
  }
  const helpOf = (exe: string): string =>
    execFileSync(exe, ['-h'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  const parseHelp = (help: string): Map<string, ParsedFlag> => {
    const groups = help.split(/\n(?=\S+ Options:\n)/).filter((g) => /^\S+ Options:\n/.test(g));
    const out = new Map<string, ParsedFlag>();
    for (const g of groups) {
      for (const f of parseGroup(g)) {
        if (!out.has(f.flag)) out.set(f.flag, f);
      }
    }
    return out;
  };

  const cli = parseHelp(helpOf(cliExe));
  const server = parseHelp(helpOf(serverExe));

  // sd-server is what we launch, so it defines the vocabulary. sd-cli-only
  // flags would abort the launch with "unknown argument".
  const seen = new Map<string, ParsedFlag>(server);
  for (const [flag, f] of cli) if (!seen.has(flag)) seen.set(flag, f);
  const cliOnly = new Set([...cli.keys()].filter((f) => !server.has(f)));

  const defs: ParamDef[] = [];
  const skipped: string[] = [];
  for (const f of seen.values()) {
    if (cliOnly.has(f.flag)) {
      skipped.push(`${f.flag} (sd-cli only — sd-server rejects it)`);
      continue;
    }
    if (excluded[f.flag]) {
      skipped.push(`${f.flag} (${excluded[f.flag]})`);
      continue;
    }
    const def: ParamDef = {
      flag: f.flag,
      key: f.flag.replace(/^--?/, ''),
      label: labelFor(f),
      description: (descriptions[f.flag] ?? f.description).replace(/\s+/g, ' ').trim(),
      category: categories[f.flag] ?? 'other',
      inputType: inferInputType(f),
    };
    if (defaults[f.flag]) def.default = defaults[f.flag];
    if (selectOptions[f.flag]) def.options = selectOptions[f.flag];
    if (presets[f.flag]) def.presets = presets[f.flag];
    defs.push(def);
  }

  const outFile = path.join(root, '.config', 'params.sdiffusion.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(defs, null, 2) + '\n');

  // Shipped fallback: `.config` is gitignored, so a fresh install would otherwise
  // fall back to the llama.cpp catalog for sd cards. Same role as
  // src/server/params-default.ts plays for llama.cpp (loadParams() prefers the
  // user-editable .config file and falls back to this).
  const moduleFile = path.join(root, 'src', 'server', 'sdParams-default.ts');
  const body = defs
    .map((d) => '  ' + JSON.stringify(d))
    .join(',\n');
  fs.writeFileSync(
    moduleFile,
    `import type { ParamDef } from './modelConfig.js';

/**
 * Generated by scripts/gen-sd-params.ts — do not edit manually.
 * Source: \`sd-cli -h\` + \`sd-server -h\` of the local stable-diffusion.cpp
 * checkout, curated by the tables in that script. Edit the curation there and
 * re-run \`npm run gen:sd-params\`, or override per install by editing
 * \`.config/params.sdiffusion.json\` (which takes precedence).
 */
export const SD_DEFAULT_PARAMS: ParamDef[] = [
${body},
];
`,
  );

  const byCat = new Map<string, number>();
  for (const d of defs) byCat.set(d.category, (byCat.get(d.category) ?? 0) + 1);
  console.log(`[sd-params] parsed ${cli.size} sd-cli + ${server.size} sd-server flags`);
  console.log(`[sd-params] wrote ${defs.length} rows to ${path.relative(root, outFile)}`);
  console.log(`[sd-params] wrote shipped fallback to ${path.relative(root, moduleFile)}`);
  console.log(`[sd-params] categories: ${[...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(', ')}`);
  console.log(`[sd-params] excluded ${skipped.length}: ${skipped.join('; ')}`);
  const uncategorised = defs.filter((d) => d.category === 'other').map((d) => d.flag);
  if (uncategorised.length) console.log(`[sd-params] uncategorised (review): ${uncategorised.join(', ')}`);
}

main();
