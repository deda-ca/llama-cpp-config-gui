import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelMetricsPoller } from '../metricsPoller.js';

// Prometheus-style metrics body with given counter values
function metricsBody(promptTokens: number, promptSeconds: number, genTokens: number, genSeconds: number): string {
  return [
    '# HELP llamacpp:prompt_tokens_total Total prompt tokens processed',
    'llamacpp:prompt_tokens_total ' + promptTokens,
    'llamacpp:prompt_seconds_total ' + promptSeconds,
    'llamacpp:tokens_predicted_total ' + genTokens,
    'llamacpp:tokens_predicted_seconds_total ' + genSeconds,
  ].join('\n');
}

const MODELS_LOADED = { data: [{ id: 'model-a', status: { value: 'loaded' } }] };
const MODELS_EMPTY = { data: [] };

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: any) => handler(String(input))));
}

describe('ModelMetricsPoller', () => {
  let poller: ModelMetricsPoller;

  beforeEach(() => {
    poller = new ModelMetricsPoller();
  });

  afterEach(() => {
    poller.stop();
    vi.unstubAllGlobals();
  });

  it('computes prefill and generation speeds from counter deltas', async () => {
    let call = 0;
    mockFetch((url) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify(MODELS_LOADED), { status: 200 });
      // /metrics?model=model-a
      call++;
      if (call === 1) return new Response(metricsBody(100, 2, 50, 1), { status: 200 });
      return new Response(metricsBody(300, 4, 150, 2), { status: 200 });
    });

    poller.endpoints = [{ baseUrl: 'http://x' }] as any;

    // First poll: establishes baseline (no deltas yet)
    await (poller as any).pollOnce();
    let metrics = poller.getMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0].prefillTokensPerSec).toBeNull();
    expect(metrics[0].generationTokensPerSec).toBeNull();

    // Second poll: deltas → prefill = (300-100)/(4-2)=100, gen = (150-50)/(2-1)=100
    await (poller as any).pollOnce();
    metrics = poller.getMetrics();
    expect(metrics[0].prefillTokensPerSec).toBeCloseTo(100);
    expect(metrics[0].generationTokensPerSec).toBeCloseTo(100);
  });

  it('sends the API key as a Bearer header when configured', async () => {
    const fetchMock = vi.fn(async (input: any, init: any) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify(MODELS_EMPTY), { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    poller.endpoints = [{ baseUrl: 'http://x', apiKey: 'secret' }] as any;
    await (poller as any).pollOnce();

    const modelsCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/models'))!;
    expect(modelsCall[1].headers.Authorization).toBe('Bearer secret');
  });

  it('does not send auth header when no API key', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify(MODELS_EMPTY), { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    poller.endpoints = [{ baseUrl: 'http://x' }] as any;
    await (poller as any).pollOnce();

    const modelsCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/models'))!;
    expect(modelsCall[1].headers.Authorization).toBeUndefined();
  });

  it('prunes metrics for models that are no longer loaded', async () => {
    let loaded = true;
    mockFetch((url) => {
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify(loaded ? MODELS_LOADED : MODELS_EMPTY), { status: 200 });
      }
      return new Response(metricsBody(10, 1, 5, 1), { status: 200 });
    });

    poller.endpoints = [{ baseUrl: 'http://x' }] as any;

    await (poller as any).pollOnce(); // model-a present
    expect(poller.getMetrics().map((m) => m.model)).toContain('model-a');

    loaded = false;
    await (poller as any).pollOnce(); // model-a gone → pruned
    expect(poller.getMetrics()).toHaveLength(0);
  });

  it('ignores negative counter deltas (counter reset)', async () => {
    let call = 0;
    mockFetch((url) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify(MODELS_LOADED), { status: 200 });
      call++;
      // First: high counters, second: lower (reset) → no speed computed
      if (call === 1) return new Response(metricsBody(500, 10, 300, 5), { status: 200 });
      return new Response(metricsBody(10, 1, 5, 1), { status: 200 });
    });

    poller.endpoints = [{ baseUrl: 'http://x' }] as any;
    await (poller as any).pollOnce();
    await (poller as any).pollOnce();

    const m = poller.getMetrics()[0];
    // Deltas are negative → speeds stay null (last known, which was also null)
    expect(m.prefillTokensPerSec).toBeNull();
    expect(m.generationTokensPerSec).toBeNull();
  });

  it('returns empty metrics when no endpoints configured', async () => {
    await (poller as any).pollOnce();
    expect(poller.getMetrics()).toEqual([]);
  });
});
