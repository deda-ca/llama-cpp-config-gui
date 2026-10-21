import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../proxy/router.js';
import { DEFAULT_PROXY_SETTINGS } from '../proxy/types.js';

function settingsWith(models: { model: string; backend: 'audio' | 'sdiffusion'; backendModel?: string }[]) {
  return { ...DEFAULT_PROXY_SETTINGS, models: models.map((m) => ({ ...m, enabled: true })) };
}

const NEW_BACKENDS = [
  { id: 'embeddings', name: 'embeddings', kind: 'embeddings' as const, baseUrl: 'http://127.0.0.1:8083', enabled: true },
  { id: 'moderation', name: 'moderation', kind: 'moderation' as const, baseUrl: 'http://127.0.0.1:8084', enabled: true },
  { id: 'videos', name: 'videos', kind: 'videos' as const, baseUrl: 'http://127.0.0.1:8085', enabled: true },
];

describe('ModelRouter', () => {
  it('resolves exact llama aliases', () => {
    const r = new ModelRouter();
    r.rebuild(DEFAULT_PROXY_SETTINGS, ['qwen2.5-14b', 'phi4']);
    const res = r.resolve('phi4', '/v1/chat/completions');
    expect(res).toEqual({ backend: 'llamacpp', upstreamModel: 'phi4', route: { model: 'phi4', backend: 'llamacpp', enabled: true, auto: true } });
  });

  it('resolves declared routes with backendModel remapping', () => {
    const r = new ModelRouter();
    r.rebuild(settingsWith([{ model: 'sd-xl-turbo', backend: 'sdiffusion', backendModel: 'sd-xl-turbo-v1' }]), []);
    const res = r.resolve('sd-xl-turbo', '/v1/images/generations');
    expect(res!.backend).toBe('sdiffusion');
    expect(res!.upstreamModel).toBe('sd-xl-turbo-v1');
  });

  it('prefix convention routes audio/, sd/, tts/ when not in registry', () => {
    const r = new ModelRouter();
    r.rebuild(DEFAULT_PROXY_SETTINGS, []);
    expect(r.resolve('audio/my-tts', '/v1/chat/completions')!.backend).toBe('audio');
    expect(r.resolve('audio/my-tts', '/v1/chat/completions')!.upstreamModel).toBe('my-tts');
    expect(r.resolve('sd/flux', '/v1/images/generations')!.backend).toBe('sdiffusion');
    expect(r.resolve('tts/voice1', '/v1/audio/speech')!.backend).toBe('audio');
  });

  it('prefix convention routes embed/, mod/, video/ to the matching kind', () => {
    const r = new ModelRouter();
    r.rebuild({ ...DEFAULT_PROXY_SETTINGS, backends: [...DEFAULT_PROXY_SETTINGS.backends, ...NEW_BACKENDS] }, []);
    expect(r.resolve('embed/bge-m3', '/v1/embeddings')!.backend).toBe('embeddings');
    expect(r.resolve('embed/bge-m3', '/v1/embeddings')!.upstreamModel).toBe('bge-m3');
    expect(r.resolve('mod/omni-moderation', '/v1/moderations')!.backend).toBe('moderation');
    expect(r.resolve('video/wan', '/v1/videos')!.backend).toBe('videos');
  });

  it('path fallback for embeddings, moderations and videos endpoints', () => {
    const r = new ModelRouter();
    r.rebuild({ ...DEFAULT_PROXY_SETTINGS, backends: [...DEFAULT_PROXY_SETTINGS.backends, ...NEW_BACKENDS] }, []);
    expect(r.resolve(undefined, '/v1/embeddings')!.backend).toBe('embeddings');
    expect(r.resolve('unknown-embed', '/v1/embeddings')!.backend).toBe('embeddings');
    expect(r.resolve(undefined, '/v1/moderations')!.backend).toBe('moderation');
    expect(r.resolve(undefined, '/v1/videos')!.backend).toBe('videos');
    // No backend of that kind configured -> no route
    const r2 = new ModelRouter();
    r2.rebuild(DEFAULT_PROXY_SETTINGS, []);
    expect(r2.resolve(undefined, '/v1/embeddings')).toBeNull();
  });

  it('exact registry match wins over prefix', () => {
    const r = new ModelRouter();
    r.rebuild(settingsWith([{ model: 'sd/special', backend: 'audio' }]), []);
    expect(r.resolve('sd/special', '/v1/images/generations')!.backend).toBe('audio');
  });

  it('path fallback when model missing or unknown on namespaced paths', () => {
    const r = new ModelRouter();
    r.rebuild(DEFAULT_PROXY_SETTINGS, ['qwen']);
    expect(r.resolve(undefined, '/v1/audio/transcriptions')!.backend).toBe('audio');
    expect(r.resolve('unknown-model', '/v1/images/generations')!.backend).toBe('sdiffusion');
  });

  it('returns null for unknown model on chat endpoints', () => {
    const r = new ModelRouter();
    r.rebuild(DEFAULT_PROXY_SETTINGS, ['qwen']);
    expect(r.resolve('nope', '/v1/chat/completions')).toBeNull();
    expect(r.resolve(undefined, '/v1/chat/completions')).toBeNull();
  });

  it('disabled declared routes are not resolvable', () => {
    const r = new ModelRouter();
    const s = { ...DEFAULT_PROXY_SETTINGS, models: [{ model: 'off-model', backend: 'sdiffusion' as const, enabled: false }] };
    r.rebuild(s, []);
    expect(r.resolve('off-model', '/v1/images/generations')).toBeNull();
  });

  it('discovered backend models route to their backend; declared entries win', () => {
    const r = new ModelRouter();
    const backends = [
      ...DEFAULT_PROXY_SETTINGS.backends,
      { id: 'llamacpp-2', name: 'llama.cpp 2', kind: 'llamacpp' as const, baseUrl: 'http://127.0.0.1:9090', enabled: true, models: ['llama-3.1-8b', 'mistral-7b'] },
    ];
    r.rebuild({ ...DEFAULT_PROXY_SETTINGS, backends }, ['qwen']);
    expect(r.resolve('llama-3.1-8b', '/v1/chat/completions')!.backend).toBe('llamacpp-2');
    expect(r.resolve('mistral-7b', '/v1/chat/completions')!.backend).toBe('llamacpp-2');
    // Declared route with the same name wins over discovery
    const s2 = {
      ...DEFAULT_PROXY_SETTINGS,
      backends,
      models: [{ model: 'mistral-7b', backend: 'audio', enabled: true }],
    };
    const r2 = new ModelRouter();
    r2.rebuild(s2, []);
    expect(r2.resolve('mistral-7b', '/v1/audio/transcriptions')!.backend).toBe('audio');
  });

  it('discovered models on disabled backends are not resolvable', () => {
    const r = new ModelRouter();
    const backends = DEFAULT_PROXY_SETTINGS.backends.map((b) =>
      b.id === 'llamacpp' ? { ...b, enabled: false, models: ['qwen-x'] } : b,
    );
    r.rebuild({ ...DEFAULT_PROXY_SETTINGS, backends }, []);
    expect(r.resolve('qwen-x', '/v1/chat/completions')).toBeNull();
  });

  it('routes to disabled backends are not resolvable', () => {
    const r = new ModelRouter();
    const backends = DEFAULT_PROXY_SETTINGS.backends.map((b) => (b.id === 'audio' ? { ...b, enabled: false } : b));
    r.rebuild({ ...DEFAULT_PROXY_SETTINGS, backends }, []);
    expect(r.resolve('audio/my-tts', '/v1/chat/completions')).toBeNull();
    expect(r.resolve(undefined, '/v1/audio/transcriptions')).toBeNull();
    expect(r.resolve('sd/flux', '/v1/images/generations')!.backend).toBe('sdiffusion');
  });

  it('rebuild replaces the previous registry', () => {
    const r = new ModelRouter();
    r.rebuild(DEFAULT_PROXY_SETTINGS, ['a', 'b']);
    r.rebuild(DEFAULT_PROXY_SETTINGS, ['c']);
    expect(r.resolve('a', '/v1/chat/completions')).toBeNull();
    expect(r.resolve('c', '/v1/chat/completions')!.backend).toBe('llamacpp');
    expect(r.listRoutes()).toHaveLength(1);
  });

  it("'default' kind backend catches anything not routed elsewhere", () => {
    const r = new ModelRouter();
    const s = {
      ...DEFAULT_PROXY_SETTINGS,
      backends: [...DEFAULT_PROXY_SETTINGS.backends, { id: 'default', name: 'Default', kind: 'default' as const, baseUrl: 'http://127.0.0.1:8099', enabled: true }],
    };
    r.rebuild(s, ['qwen']);
    // Unknown model on chat -> default instead of null
    expect(r.resolve('nope', '/v1/chat/completions')!.backend).toBe('default');
    expect(r.resolve('nope', '/v1/chat/completions')!.upstreamModel).toBe('nope');
    // Missing model field -> default
    expect(r.resolve(undefined, '/v1/chat/completions')!.backend).toBe('default');
    // Namespaced paths without a matching kind backend -> default
    expect(r.resolve(undefined, '/v1/audio/transcriptions')!.backend).toBe('audio'); // audio kind exists in defaults
    expect(r.resolve(undefined, '/v1/embeddings')!.backend).toBe('default');
    // Exact routes still win over the catch-all
    expect(r.resolve('qwen', '/v1/chat/completions')!.backend).toBe('llamacpp');
  });

  it("prefix fallback uses 'default' when the kind backend is missing", () => {
    const r = new ModelRouter();
    const s = {
      ...DEFAULT_PROXY_SETTINGS,
      backends: [
        ...DEFAULT_PROXY_SETTINGS.backends.filter((b) => b.kind !== 'sdiffusion'),
        { id: 'default', name: 'Default', kind: 'default' as const, baseUrl: 'http://127.0.0.1:8099', enabled: true },
      ],
    };
    r.rebuild(s, []);
    expect(r.resolve('sd/flux', '/v1/images/generations')!.backend).toBe('default');
    expect(r.resolve('sd/flux', '/v1/images/generations')!.upstreamModel).toBe('flux');
  });

  it("explicitly disabled routes/backends are not rescued by 'default'", () => {
    const r = new ModelRouter();
    const def = { id: 'default', name: 'Default', kind: 'default' as const, baseUrl: 'http://127.0.0.1:8099', enabled: true };
    r.rebuild({ ...DEFAULT_PROXY_SETTINGS, backends: [...DEFAULT_PROXY_SETTINGS.backends, def], models: [{ model: 'off-model', backend: 'sdiffusion' as const, enabled: false }] }, []);
    expect(r.resolve('off-model', '/v1/images/generations')).toBeNull();
    const backends = DEFAULT_PROXY_SETTINGS.backends.map((b) => (b.id === 'audio' ? { ...b, enabled: false } : b)).concat(def);
    const r2 = new ModelRouter();
    r2.rebuild({ ...DEFAULT_PROXY_SETTINGS, backends }, []);
    expect(r2.resolve('audio/my-tts', '/v1/chat/completions')).toBeNull();
  });

  it("disabled 'default' backend does not catch anything", () => {
    const r = new ModelRouter();
    const s = {
      ...DEFAULT_PROXY_SETTINGS,
      backends: [...DEFAULT_PROXY_SETTINGS.backends, { id: 'default', name: 'Default', kind: 'default' as const, baseUrl: 'http://127.0.0.1:8099', enabled: false }],
    };
    r.rebuild(s, []);
    expect(r.resolve('nope', '/v1/chat/completions')).toBeNull();
  });

  it('duplicate aliases: the active route receives requests', () => {
    const r = new ModelRouter();
    const s = {
      ...DEFAULT_PROXY_SETTINGS,
      models: [
        { model: 'my-model', backend: 'audio' as const, backendModel: 'up-a', enabled: true, active: true },
        { model: 'my-model', backend: 'sdiffusion' as const, backendModel: 'up-b', enabled: true },
      ],
    };
    r.rebuild(s, []);
    expect(r.resolve('my-model', '/v1/audio/transcriptions')!.backend).toBe('audio');
    expect(r.resolve('my-model', '/v1/audio/transcriptions')!.upstreamModel).toBe('up-a');
    // Switching the live flag swaps the routing target
    const s2 = {
      ...s,
      models: [
        { ...s.models[0], active: false },
        { ...s.models[1], active: true },
      ],
    };
    r.rebuild(s2, []);
    expect(r.resolve('my-model', '/v1/audio/transcriptions')!.backend).toBe('sdiffusion');
    expect(r.resolve('my-model', '/v1/audio/transcriptions')!.upstreamModel).toBe('up-b');
    // /v1/models and resolve() expose only the live route; allRoutes() shows both
    expect(r.listRoutes().filter((m) => m.model === 'my-model')).toHaveLength(1);
    expect(r.allRoutes().filter((m) => m.model === 'my-model')).toHaveLength(2);
  });

  it('duplicate aliases without an active flag fall back to the first route', () => {
    const r = new ModelRouter();
    const s = {
      ...DEFAULT_PROXY_SETTINGS,
      models: [
        { model: 'sw', backend: 'audio' as const, backendModel: 'up-a', enabled: true },
        { model: 'sw', backend: 'sdiffusion' as const, backendModel: 'up-b', enabled: true },
      ],
    };
    r.rebuild(s, []);
    expect(r.resolve('sw', '/v1/chat/completions')!.backend).toBe('audio');
  });

  it("duplicate aliases: the route whose upstream model is available wins, even if another is flagged active", () => {
    const r = new ModelRouter();
    const backends = DEFAULT_PROXY_SETTINGS.backends.map((b) => {
      if (b.id === 'audio') return { ...b, models: ['other-model'] }; // up-a NOT hosted here
      if (b.id === 'sdiffusion') return { ...b, models: ['up-b'] }; // up-b hosted here
      return b;
    });
    const s = {
      ...DEFAULT_PROXY_SETTINGS,
      backends,
      models: [
        { model: 'auto', backend: 'audio' as const, backendModel: 'up-a', enabled: true, active: true },
        { model: 'auto', backend: 'sdiffusion' as const, backendModel: 'up-b', enabled: true, active: false },
      ],
    };
    r.rebuild(s, []);
    // Flagged active is 'audio/up-a' but that upstream doesn't host it -> auto-pick sdiffusion
    expect(r.resolve('auto', '/v1/chat/completions')!.backend).toBe('sdiffusion');
    expect(r.resolve('auto', '/v1/chat/completions')!.upstreamModel).toBe('up-b');
    // listRoutes (GET /v1/models) reflects the auto-picked live route too
    expect(r.listRoutes().find((m) => m.model === 'auto')!.backend).toBe('sdiffusion');
    // allRoutes still exposes every duplicate for the GUI
    expect(r.allRoutes().filter((m) => m.model === 'auto')).toHaveLength(2);
    // If none of the duplicates is available upstream, the flagged active one is used
    const s2 = {
      ...s,
      backends: backends.map((b) => (b.id === 'sdiffusion' ? { ...b, models: ['something-else'] } : b)),
    };
    r.rebuild(s2, []);
    expect(r.resolve('auto', '/v1/chat/completions')!.backend).toBe('audio');
  });
});
