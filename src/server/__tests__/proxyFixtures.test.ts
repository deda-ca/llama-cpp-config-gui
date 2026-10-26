/**
 * Phase 0 spike fixtures (docs/proxy-server.md §11 Phase 0, §4.3.1, §13).
 *
 * These assertions are the executable form of the spike's findings: they pin the
 * upstream shapes the translators will be written against, so a re-capture that
 * drifts fails here instead of quietly invalidating a Phase 4/5 design. They also
 * document the two surprises the spike found — sd.cpp's OpenAI route discards
 * every generation parameter, and audio.cpp's streaming speech accepts pcm only.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'proxy');

function read(rel: string): string {
  return fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');
}

function readJson(rel: string): any {
  return JSON.parse(read(rel));
}

/** Every `data:` payload in an SSE capture, in order. */
function sseData(rel: string): string[] {
  return read(rel)
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));
}

describe('llama.cpp fixtures (§13 Q3)', () => {
  it('non-streaming response carries usage with cached_tokens and timings', () => {
    const d = readJson('llama/chat-nonstream.json');
    expect(d.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
    // The recorder's cached-token column depends on this nested shape.
    expect(d.usage.prompt_tokens_details.cached_tokens).toEqual(expect.any(Number));
    expect(d.timings).toBeTruthy();
  });

  it('streaming usage arrives in a final choices-less chunk before [DONE]', () => {
    const chunks = sseData('llama/chat-stream.sse');
    expect(chunks.at(-1)).toBe('[DONE]');
    const usageChunk = JSON.parse(chunks[chunks.length - 2]);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage.completion_tokens).toBeGreaterThan(0);
    expect(usageChunk.usage.prompt_tokens_details.cached_tokens).toEqual(expect.any(Number));
    // Only the injected stream_options.include_usage gets us this chunk at all.
    expect(usageChunk.timings).toBeTruthy();
  });
});

describe('stable-diffusion.cpp fixtures (§4.3.1, §13 Q2)', () => {
  it('the OpenAI route ignores steps, seed and the unimplemented OpenAI fields', () => {
    // Captured request: steps:3, seed:777, response_format:"url", quality:"hd",
    // style:"vivid", user:"alice". The generation_info below is what the server
    // actually used — its own startup defaults, proving the fields were dropped.
    const d = readJson('sd/openai-generations.ignored-fields.json');
    const gi = d.data[0].generation_info;
    expect(gi.sample_params.sample_steps).toBe(20); // requested 3
    expect(gi.seed).toBe('42'); // requested 777
    expect(gi.sample_params.guidance.txt_cfg).toBe(1.0);
    // Always b64, never a url — so response_format:"url" cannot be honoured.
    expect(d.data[0].b64_json).toBeTruthy();
    expect(d.data[0].url).toBeUndefined();
    expect(d.output_format).toBe('png');
  });

  it('sd_cpp_extra_args reaches the sampler and is stripped from the prompt', () => {
    const gi = readJson('sd/openai-generations.extra-args.json').data[0].generation_info;
    expect(gi.sample_params.sample_steps).toBe(7);
    expect(gi.prompt).not.toContain('sd_cpp_extra_args');
    // seed inside sample_params is ignored: seed is a TOP-LEVEL native field.
    expect(gi.seed).toBe('42');
  });

  it('native img_gen submits a job with millisecond timestamps', () => {
    const d = readJson('sd/img_gen-job-submitted.json');
    expect(d).toMatchObject({ kind: 'img_gen', status: 'queued' });
    expect(d.poll_url).toBe(`/sdcpp/v1/jobs/${d.id}`);
    // ms, not seconds — a seconds check would pass by accident on an old capture.
    expect(d.created).toBeGreaterThan(1e12);
  });

  it('a completed job honours the requested sampling parameters', () => {
    // Captured request: sample_steps:4, seed:1234, euler/simple, txt_cfg:3.5.
    const d = readJson('sd/img_gen-job-completed.json');
    expect(d.status).toBe('completed');
    const gi = d.result.images[0].generation_info;
    expect(gi.sample_params.sample_steps).toBe(4);
    expect(gi.seed).toBe('1234');
    expect(gi.sample_params.sample_method).toBe('euler');
    expect(gi.sample_params.scheduler).toBe('simple');
    expect(gi.sample_params.guidance.txt_cfg).toBe(3.5);
    // Generation time excludes queue time; both are ms.
    expect(d.completed - d.started).toBeGreaterThan(0);
    expect(d.error).toBeNull();
  });

  it('capabilities expose the vocabulary a translator must validate against', () => {
    const c = readJson('sd/capabilities.json');
    expect(c.supported_modes).toContain('img_gen');
    expect(c.output_formats_by_mode.img_gen).toEqual(['png', 'jpeg', 'webp']);
    expect(c.samplers).toEqual(expect.arrayContaining(['euler', 'euler_a', 'dpm++2m']));
    expect(c.schedulers).toEqual(expect.arrayContaining(['discrete', 'karras', 'flux']));
    expect(c.limits).toMatchObject({ min_width: 64, max_width: 4096, max_batch_count: 8 });
    // Which extras the loaded context can actually serve.
    expect(c.features_by_mode.img_gen).toMatchObject({
      init_image: expect.any(Boolean),
      hires: expect.any(Boolean),
      preview: expect.any(Boolean),
    });
  });
});

describe('audio.cpp fixtures (§13 Q1)', () => {
  it('models are listed with owned_by engine', () => {
    const d = readJson('audio/models.json');
    expect(d.data.map((m: any) => m.id)).toEqual(['Breeze-TTS-2', 'Qwen3-ASR']);
    expect(d.data[0].owned_by).toBe('engine');
  });

  it('json response_format is the only non-streaming shape exposing timing', () => {
    const d = readJson('audio/speech-json.json');
    expect(d.format).toBe('wav');
    expect(d.audio).toBeTruthy();
    expect(d.timing.audio_duration_ms).toBeGreaterThan(0);
    expect(d.timing.wall_ms).toBeGreaterThan(0);
    // No usage object anywhere — audio usage has to be derived.
    expect(d.usage).toBeUndefined();
  });

  it('streaming speech emits audio.cpp events, not OpenAI ones', () => {
    const events = sseData('audio/speech-stream.sse').map((s) => (s === '[DONE]' ? '[DONE]' : JSON.parse(s)));
    expect(events.at(-1)).toBe('[DONE]');
    const done = events.at(-2) as any;
    expect(done.type).toBe('speech.audio.done');
    expect(done.timing.ttft_ms).toBeGreaterThan(0);
    expect(events.filter((e: any) => e?.type === 'speech.audio.delta').length).toBeGreaterThan(0);
  });

  it('streaming accepts response_format=pcm only, answered with a 500', () => {
    const e = readJson('audio/speech-stream-unsupported-format.json');
    expect(e.error.message).toContain('response_format=pcm');
    // Upstream answers a client mistake with 5xx — a translator should pre-validate.
    expect(e.error.type).toBe('server_error');
  });

  it('transcriptions return text plus timing and no usage', () => {
    const d = readJson('audio/transcriptions.json');
    expect(d.text).toBe('The quick brown fox jumps over the lazy dog.');
    expect(d.timing.audio_duration_ms).toBeGreaterThan(0);
    expect(d.usage).toBeUndefined();
  });
});
