import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../proxy/router.js';
import { DEFAULT_PROXY_SETTINGS } from '../proxy/types.js';

function settingsWith(models: { model: string; backend: 'audio' | 'sdiffusion'; backendModel?: string }[]) {
  return { ...DEFAULT_PROXY_SETTINGS, models: models.map((m) => ({ ...m, enabled: true })) };
}

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
});
