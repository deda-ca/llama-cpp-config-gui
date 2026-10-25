/**
 * stable-diffusion.cpp engine config (docs/stable-diffusion.md §3.1, §3.6).
 *
 * The load-bearing invariants here are the ones the launch depends on: the
 * `--model-dir` rows a new instance is seeded with (sorted, model roots only),
 * the port read from `--listen-port` (never `-l`, which is the IP on
 * sd-server), and the fact that a garbage/absent block normalizes to
 * `undefined` so an older engines.json keeps loading.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SD_CATEGORY_DIRS,
  SD_DEFAULT_PORT,
  blankSdConfig,
  discoverSdModelDirs,
  isSdModelRoot,
  normalizeSdConfig,
  resolveSdFileId,
  sdBuildUserRecipe,
  sdHost,
  sdModelDirs,
  sdModelFromArgs,
  sdModelToArgs,
  sdModelToLoadRequest,
  sdPort,
  sdPrimarySlot,
  sdRecipeDefaults,
  sdRecipePath,
  sdRunDir,
  slugifySdRecipeId,
} from '../engines/sd.js';
import type { ModelConfig } from '../modelConfig.js';

/** A throwaway sd root tree mirroring §1.3.1: one folder per model. */
function makeSdRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-root-'));
  const mk = (model: string, ...dirs: string[]) => {
    for (const d of dirs) fs.mkdirSync(path.join(base, model, d), { recursive: true });
  };
  mk('wan2.2-ti2v-5b', 'diffusion_models', 'text_encoders', 'vae');
  mk('qwen-image-2.1', 'diffusion_models', 'vae');
  mk('sd1.5', 'checkpoints');
  // Not a model root: the category dir is a grandchild, not an immediate child
  // (`model_category_directories` only matches direct children).
  fs.mkdirSync(path.join(base, 'not-a-model', 'sub', 'diffusion_models'), { recursive: true });
  fs.mkdirSync(path.join(base, 'loose-files'), { recursive: true });
  return base;
}

describe('model root discovery (§1.3.1)', () => {
  it('finds folders with a recognised category dir as an immediate child', () => {
    const base = makeSdRoot();
    try {
      const found = discoverSdModelDirs(base).map((p) => path.basename(p));
      expect(found).toEqual(['qwen-image-2.1', 'sd1.5', 'wan2.2-ti2v-5b']);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('sorts by name because root order is load-bearing (§1.3.1 caveat 1)', () => {
    const base = makeSdRoot();
    try {
      const found = discoverSdModelDirs(base);
      const names = found.map((p) => path.basename(p));
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      // The first root keeps plain file-ids, later roots get @<hash>/… — so the
      // first entry must be deterministic, not readdir order.
      expect(path.basename(found[0])).toBe('qwen-image-2.1');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('accepts the category aliases the server itself matches', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-alias-'));
    try {
      for (const name of ['Stable-diffusion', 'lora', 'VAE_APPROX']) {
        const dir = path.join(base, `m-${name}`);
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        expect(isSdModelRoot(dir)).toBe(true);
      }
      expect(SD_CATEGORY_DIRS).toContain('checkpoints');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns nothing for a missing root instead of throwing', () => {
    expect(discoverSdModelDirs('/nonexistent/sd/root')).toEqual([]);
    expect(isSdModelRoot('/nonexistent/sd/root')).toBe(false);
  });

  it('never treats the sd parent itself as a root', () => {
    // The parent holds model folders, not category dirs, so the scan that
    // decides "is this a root" rejects it — pointing --model-dir there would
    // find nothing (§1.3.1).
    const base = makeSdRoot();
    try {
      expect(isSdModelRoot(base)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('sd block shape', () => {
  it('blankSdConfig seeds bind rows and one --model-dir per discovered root', () => {
    const cfg = blankSdConfig();
    expect(cfg.serverArgs[0]).toEqual({ key: '--listen-ip', value: '127.0.0.1' });
    expect(cfg.serverArgs[1]).toEqual({ key: '--listen-port', value: String(SD_DEFAULT_PORT) });
    // sd-server has no --port flag; the row must be named --listen-port.
    expect(cfg.serverArgs.some((p) => p.key === '--port')).toBe(false);
    for (const row of cfg.serverArgs.filter((p) => p.key === '--model-dir')) {
      expect(path.isAbsolute(row.value ?? '')).toBe(true);
      expect(isSdModelRoot(row.value ?? '')).toBe(true);
    }
    expect(cfg.modelConfigIds).toEqual([]);
    expect(cfg.extra).toEqual({});
  });

  it('normalizeSdConfig is undefined for a missing or garbage block', () => {
    expect(normalizeSdConfig(undefined)).toBeUndefined();
    expect(normalizeSdConfig(null)).toBeUndefined();
    expect(normalizeSdConfig([])).toBeUndefined();
    expect(normalizeSdConfig('nope')).toBeUndefined();
  });

  it('normalizeSdConfig keeps every field and drops junk entries', () => {
    const out = normalizeSdConfig({
      envVars: { LD_LIBRARY_PATH: '/opt/cuda', BAD: 7 },
      serverArgs: [
        { key: '--listen-port', value: 5458 },
        { key: '--model-dir', value: '/m/sd1.5' },
        { key: '  ' },
        null,
      ],
      modelConfigIds: ['qwen', 42, 'sd15'],
      extra: { '--some-flag': true },
    });
    expect(out).toBeDefined();
    expect(out?.envVars).toEqual({ LD_LIBRARY_PATH: '/opt/cuda' });
    // A numeric value survives as a string instead of being dropped (the
    // v-model coercion bug, docs/todo.md).
    expect(out?.serverArgs).toEqual([
      { key: '--listen-port', value: '5458' },
      { key: '--model-dir', value: '/m/sd1.5' },
    ]);
    expect(out?.modelConfigIds).toEqual(['qwen', 'sd15']);
    expect(out?.extra).toEqual({ '--some-flag': true });
  });

  it('extra round-trips untouched', () => {
    const cfg = { envVars: {}, serverArgs: [], modelConfigIds: [], extra: { nested: { a: [1, 2] } } };
    expect(normalizeSdConfig(cfg)?.extra).toEqual(cfg.extra);
  });
});

describe('port, host and model dirs (§3.6)', () => {
  const block = (rows: { key: string; value?: string; disabled?: boolean }[]) =>
    normalizeSdConfig({ serverArgs: rows })!;

  it('sdPort reads --listen-port', () => {
    expect(sdPort(block([{ key: '--listen-port', value: '5458' }]))).toBe(5458);
    expect(sdPort(block([{ key: '--listen-port', value: 'nope' }]))).toBeNull();
    expect(sdPort(block([]))).toBeNull();
    expect(sdPort(undefined)).toBeNull();
  });

  it('sdPort ignores out-of-range and disabled rows', () => {
    expect(sdPort(block([{ key: '--listen-port', value: '0' }]))).toBeNull();
    expect(sdPort(block([{ key: '--listen-port', value: '70000' }]))).toBeNull();
    expect(sdPort(block([{ key: '--listen-port', value: '5458', disabled: true }]))).toBeNull();
  });

  it('sdPort does not read -l: on sd-server that is the listen IP', () => {
    expect(sdPort(block([{ key: '-l', value: '5458' }]))).toBeNull();
  });

  it('sdHost defaults to loopback', () => {
    expect(sdHost(block([{ key: '--listen-ip', value: '0.0.0.0' }]))).toBe('0.0.0.0');
    expect(sdHost(block([]))).toBe('127.0.0.1');
  });

  it('sdModelDirs keeps order and skips blank/disabled rows', () => {
    const dirs = sdModelDirs(block([
      { key: '--model-dir', value: '/m/a' },
      { key: '--model-dir', value: '  ' },
      { key: '--model-dir', value: '/m/b', disabled: true },
      { key: '--model-dir', value: '/m/c' },
    ]));
    expect(dirs).toEqual(['/m/a', '/m/c']);
    expect(sdModelDirs(undefined)).toEqual([]);
  });
});

describe('sdRunDir', () => {
  it('is the executable folder, like audioRunDir', () => {
    expect(sdRunDir('/home/u/Programs/AI/stable-diffusion.cpp/build/bin/sd-server'))
      .toBe('/home/u/Programs/AI/stable-diffusion.cpp/build/bin');
  });

  it('absolutizes a relative path', () => {
    expect(sdRunDir('build/bin/sd-server')).toBe(path.join(process.cwd(), 'build/bin'));
  });

  it('a bare name has no folder (spawn inherits cwd)', () => {
    expect(sdRunDir('sd-server')).toBe('');
    expect(sdRunDir(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Card -> load request (§3.3)
// ---------------------------------------------------------------------------

const ROOT_A = '/home/u/models/sd/qwen-image-2.1';
const ROOT_B = '/home/u/models/sd/sd1.5';
/** The @<16-hex> qualifier a later root carries (§1.3.1 caveat 1). */
const HASH_B = '@1a2b3c4d5e6f7a8b';

/** A model-files payload in the shape routes_models.cpp:132 emits. */
const files = [
  { id: 'diffusion_models/qwen_image_2.1-Q4_K.gguf', name: 'qwen_image_2.1-Q4_K.gguf', category: 'diffusion_models', root: '', relative_path: 'diffusion_models/qwen_image_2.1-Q4_K.gguf' },
  { id: 'text_encoders/Qwen3VL-8B-Instruct-Q4_K_M.gguf', name: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf', category: 'text_encoders', root: '', relative_path: 'text_encoders/Qwen3VL-8B-Instruct-Q4_K_M.gguf' },
  { id: 'text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf', name: 'mmproj-Qwen3VL-8B-Instruct-F16.gguf', category: 'text_encoders', root: '', relative_path: 'text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf' },
  { id: 'vae/qwen_image_2.1_vae_bf16.safetensors', name: 'qwen_image_2.1_vae_bf16.safetensors', category: 'vae', root: '', relative_path: 'vae/qwen_image_2.1_vae_bf16.safetensors' },
  { id: 'vae/taeqi2_1.safetensors', name: 'taeqi2_1.safetensors', category: 'vae', root: '', relative_path: 'vae/taeqi2_1.safetensors' },
  { id: `${HASH_B}/checkpoints/v1-5-pruned-emaonly.safetensors`, name: 'v1-5-pruned-emaonly.safetensors', category: 'checkpoints', root: HASH_B, relative_path: 'checkpoints/v1-5-pruned-emaonly.safetensors' },
];

const card = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  id: 'qwen',
  alias: 'qwen-image-21',
  displayName: 'Qwen Image 2.1',
  notes: '',
  modelPath: `${ROOT_A}/diffusion_models/qwen_image_2.1-Q4_K.gguf`,
  params: {
    '--llm': `${ROOT_A}/text_encoders/Qwen3VL-8B-Instruct-Q4_K_M.gguf`,
    '--llm_vision': `${ROOT_A}/text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf`,
    '--vae': `${ROOT_A}/vae/qwen_image_2.1_vae_bf16.safetensors`,
    '--steps': '20',
    '--cfg-scale': '5',
    '--width': '1280',
    '--height': '704',
    '--backend': 'diffusion=CUDA0,te=CUDA1,vae=CUDA1',
  },
  paramOrder: ['--llm', '--llm_vision', '--vae', '--steps', '--cfg-scale', '--width', '--height', '--backend'],
  type: 'sdiffusion',
  sdExtras: { recipe: 'qwen-image-21', capabilities: ['flow_shift'] },
  isDefault: false,
  ...over,
});

describe('file-id resolution (§1.4.1)', () => {
  it('resolves inside the primary root to a plain id', () => {
    expect(resolveSdFileId(`${ROOT_A}/vae/qwen_image_2.1_vae_bf16.safetensors`, files, [ROOT_A, ROOT_B]))
      .toBe('vae/qwen_image_2.1_vae_bf16.safetensors');
  });

  it('resolves inside a later root to its @<hash>-qualified id', () => {
    expect(resolveSdFileId(`${ROOT_B}/checkpoints/v1-5-pruned-emaonly.safetensors`, files, [ROOT_A, ROOT_B]))
      .toBe(`${HASH_B}/checkpoints/v1-5-pruned-emaonly.safetensors`);
  });

  it('returns null for a path outside every root — the ids are never constructed', () => {
    expect(resolveSdFileId('/home/u/elsewhere/model.gguf', files, [ROOT_A, ROOT_B])).toBeNull();
    // A sibling folder that merely shares a name prefix is not inside the root.
    expect(resolveSdFileId(`${ROOT_A}-backup/vae/x.safetensors`, files, [ROOT_A])).toBeNull();
  });

  it('matches a nested relative path exactly', () => {
    const nested = [{ id: 'vae/sub/deep.safetensors', name: 'deep.safetensors', category: 'vae', root: '', relative_path: 'vae/sub/deep.safetensors' }];
    expect(resolveSdFileId(`${ROOT_A}/vae/sub/deep.safetensors`, nested, [ROOT_A])).toBe('vae/sub/deep.safetensors');
  });
});

describe('card -> models/load request', () => {
  it('fills one slot per component row with catalog ids', () => {
    const res = sdModelToLoadRequest(card(), files, [ROOT_A, ROOT_B]);
    expect(res.errors).toEqual([]);
    expect(res.request).toEqual({
      recipe: 'qwen-image-21',
      models: {
        diffusion_model: 'diffusion_models/qwen_image_2.1-Q4_K.gguf',
        llm: 'text_encoders/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
        llm_vision: 'text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf',
        vae: 'vae/qwen_image_2.1_vae_bf16.safetensors',
      },
    });
  });

  it('a card naming only a checkpoint fills the model slot', () => {
    const ckpt: ModelConfig = {
      ...card({
        modelPath: `${ROOT_B}/checkpoints/v1-5-pruned-emaonly.safetensors`,
        params: {},
        paramOrder: [],
        sdExtras: { recipe: 'sd1-checkpoint' },
      }),
    };
    expect(sdPrimarySlot(ckpt)).toBe('model');
    expect(sdModelToLoadRequest(ckpt, files, [ROOT_A, ROOT_B]).request?.models)
      .toEqual({ model: `${HASH_B}/checkpoints/v1-5-pruned-emaonly.safetensors` });
  });

  it('honours disabledParams and skips blank rows', () => {
    const res = sdModelToLoadRequest(
      card({
        params: { ...card().params, '--control-net': '', '--clip_l': '/home/u/models/sd/shared/clip_l.safetensors' },
        paramOrder: [...card().paramOrder, '--control-net', '--clip_l'],
        disabledParams: ['--llm_vision', '--control-net'],
      }),
      files,
      [ROOT_A, ROOT_B],
    );
    const models = res.request?.models ?? {};
    expect(models.llm_vision).toBeUndefined();
    expect(models['control_net']).toBeUndefined();
    expect(models.clip_l).toBeUndefined(); // outside the roots -> reported, not sent
    expect(res.errors.some((e) => e.includes('clip_l') && e.includes('--model-dir'))).toBe(true);
  });

  it('errors when the recipe id is missing', () => {
    const res = sdModelToLoadRequest(card({ sdExtras: undefined }), files, [ROOT_A]);
    expect(res.request).toBeUndefined();
    expect(res.errors[0]).toContain('recipe');
  });

  it('rejects both tae and taesd, which are one slot', () => {
    const res = sdModelToLoadRequest(
      card({
        params: { ...card().params, '--tae': `${ROOT_A}/vae/taeqi2_1.safetensors`, '--taesd': `${ROOT_A}/vae/taeqi2_1.safetensors` },
        paramOrder: [...card().paramOrder, '--tae', '--taesd'],
      }),
      files,
      [ROOT_A],
    );
    expect(res.request).toBeUndefined();
    expect(res.errors.join(' ')).toContain('only one of --tae and --taesd');
  });

  it('a component outside every root produces an actionable error, not a constructed id', () => {
    const res = sdModelToLoadRequest(
      card({ params: { ...card().params, '--vae': '/home/u/Downloads/ae.safetensors' } }),
      files,
      [ROOT_A],
    );
    expect(res.request).toBeUndefined();
    expect(res.errors.join(' ')).toMatch(/not inside any --model-dir root/);
    expect(res.errors.join(' ')).toMatch(/argv fallback/);
  });
});

describe('card -> user recipe (§3.3, api.md schema)', () => {
  it('emits schema_version, slots and typed defaults', () => {
    const recipe = sdBuildUserRecipe(card(), 'my-qwen');
    expect(recipe.schema_version).toBe(1);
    expect(recipe.id).toBe('my-qwen');
    expect(recipe.slots).toEqual([
      { id: 'diffusion_model', required: true },
      { id: 'llm', required: false },
      { id: 'llm_vision', required: false },
      { id: 'vae', required: false },
    ]);
    // Numbers stay numbers: apply_recipe_defaults rejects a string steps value.
    expect(recipe.defaults).toEqual({ steps: 20, cfg_scale: 5, width: 1280, height: 704 });
    // The card's own GPU split rides in context{} (§1.4.1).
    expect(recipe.context).toEqual({ backend: 'diffusion=CUDA0,te=CUDA1,vae=CUDA1' });
    expect(recipe.features).toEqual(['flow_shift']);
    expect(recipe.required_any).toBeUndefined();
  });

  it('declares required_any only when both vae and tae are slots', () => {
    const both = card({
      params: { ...card().params, '--tae': `${ROOT_A}/vae/taeqi2_1.safetensors` },
      paramOrder: [...card().paramOrder, '--tae'],
    });
    expect(sdBuildUserRecipe(both, 'r').required_any).toEqual([['vae', 'tae']]);
    const taeOnly = card({
      params: { '--taesd': `${ROOT_A}/vae/taeqi2_1.safetensors` },
      paramOrder: ['--taesd'],
    });
    const recipe = sdBuildUserRecipe(taeOnly, 'r');
    // The legacy --taesd row becomes the canonical `tae` slot id.
    expect(recipe.slots).toEqual([
      { id: 'diffusion_model', required: true },
      { id: 'tae', required: false },
    ]);
    expect(recipe.required_any).toBeUndefined();
  });

  it('reports rows that cannot become defaults instead of dropping them', () => {
    const { defaults, skipped } = sdRecipeDefaults(card({
      params: { ...card().params, '--clip-skip': '2', '--seed': '1234' },
      paramOrder: [...card().paramOrder, '--clip-skip', '--seed'],
    }));
    expect(defaults.steps).toBe(20);
    expect(skipped.map((s) => s.key)).toEqual(['--clip-skip', '--seed']);
  });

  it('maps defaults/context keys by the CLI spelling, not the JSON name', () => {
    // sd-server has no --custom-sigmas or --shifted-timestep flag: the CLI
    // spellings are --sigmas and --timestep-shift (common.cpp binds them to the
    // custom_sigmas / shifted_timestep fields). A row keyed by the JSON name
    // would be silently skipped instead of reaching defaults{}.
    const { defaults, skipped } = sdRecipeDefaults(card({
      params: { ...card().params, '--sigmas': '14.61,7.8,3.5,0.0', '--timestep-shift': '250' },
      paramOrder: [...card().paramOrder, '--sigmas', '--timestep-shift'],
    }));
    expect(defaults.custom_sigmas).toEqual([14.61, 7.8, 3.5, 0]);
    expect(defaults.shifted_timestep).toBe(250);
    expect(skipped).toEqual([]);
    // --model-args is a context key, so it never lands in defaults{} (check_keys
    // would reject the whole recipe) nor in skipped.
    const withArgs = sdRecipeDefaults(card({
      params: { ...card().params, '--model-args': 'chroma_use_dit_mask=false' },
      paramOrder: [...card().paramOrder, '--model-args'],
    }));
    expect(withArgs.defaults).not.toHaveProperty('model_args');
    expect(withArgs.skipped).toEqual([]);
    const recipe = sdBuildUserRecipe(card({
      params: { ...card().params, '--model-args': 'chroma_use_dit_mask=false' },
      paramOrder: [...card().paramOrder, '--model-args'],
    }), 'r');
    expect(recipe.context).toEqual({
      backend: 'diffusion=CUDA0,te=CUDA1,vae=CUDA1',
      model_args: 'chroma_use_dit_mask=false',
    });
  });

  it('recipe path is <first root>/recipes/<id>.json and ids are slugified', () => {
    expect(sdRecipePath([ROOT_A, ROOT_B], 'my-qwen')).toBe(`${ROOT_A}/recipes/my-qwen.json`);
    expect(() => sdRecipePath([], 'x')).toThrow(/no --model-dir root/);
    expect(slugifySdRecipeId('Qwen Image 2.1!!')).toBe('qwen-image-2.1');
    expect(slugifySdRecipeId('')).toBe('model');
    expect(slugifySdRecipeId('x'.repeat(200))).toHaveLength(128);
  });
});

describe('argv fallback round-trip (§3.3)', () => {
  it('emits weight flags with absolute paths from the run folder', () => {
    // No component rows -> an all-in-one checkpoint, so the primary is -m.
    const args = sdModelToArgs(card({
      modelPath: 'models/sd/sd1.5/checkpoints/v1-5-pruned-emaonly.safetensors',
      params: {},
      paramOrder: [],
    }), '/home/u/run');
    expect(args).toEqual([
      { key: '-m', value: '/home/u/run/models/sd/sd1.5/checkpoints/v1-5-pruned-emaonly.safetensors' },
    ]);
  });

  it('a split bundle uses --diffusion-model, not -m', () => {
    const args = sdModelToArgs(card(), '/home/u/run');
    expect(args[0]).toEqual({ key: '--diffusion-model', value: card().modelPath });
  });

  it('reconstructs a card from a command line', () => {
    const argv = ['sd-server', '--model-dir', ROOT_A, '-m', `${ROOT_B}/checkpoints/v1-5-pruned-emaonly.safetensors`,
      '--vae', `${ROOT_B}/vae/ae.safetensors`, '--clip_l', `${ROOT_B}/text_encoders/clip_l.safetensors`,
      '--listen-port', '5458'];
    const cfg = sdModelFromArgs(argv);
    expect(cfg.type).toBe('sdiffusion');
    expect(cfg.modelPath).toBe(`${ROOT_B}/checkpoints/v1-5-pruned-emaonly.safetensors`);
    expect(cfg.params).toEqual({
      '--vae': `${ROOT_B}/vae/ae.safetensors`,
      '--clip_l': `${ROOT_B}/text_encoders/clip_l.safetensors`,
    });
    expect(cfg.alias).toBe('v1-5-pruned-emaonly');
    // --model-dir / --listen-port are instance rows, never card rows.
    expect(cfg.params['--model-dir']).toBeUndefined();
    expect(cfg.params['--listen-port']).toBeUndefined();
  });

  it('card -> argv -> card keeps the component rows', () => {
    const once = sdModelToArgs(card(), '/home/u/run');
    const argv = once.flatMap((p) => [p.key, p.value ?? '']);
    const back = sdModelFromArgs(argv);
    expect(back.modelPath).toBe(card().modelPath);
    expect(back.params['--llm']).toBe(card().params['--llm']);
    expect(back.params['--vae']).toBe(card().params['--vae']);
    expect(back.params['--llm_vision']).toBe(card().params['--llm_vision']);
    // Generation rows are instance/server settings in fallback mode, not card rows.
    expect(back.params['--steps']).toBeUndefined();
  });
});
