# Proxy upstream fixtures (Phase 0 spike, docs/proxy-server.md §11 Phase 0)

Real responses captured from the local engines on **2026-10-25** — not hand-written
mocks. Translators and recorder tests replay these byte-for-byte through a stub
upstream, per §12.

| Engine | Version | Endpoint |
|---|---|---|
| llama.cpp | `b11835` (0.7.0-dev, commit f64a49819) | `llama-server` router mode, 127.0.0.1:7001 |
| stable-diffusion.cpp | `master-1004-a85db96-2-g0886f11` (commit 0886f11) | `sd-server`, 127.0.0.1:5458 |
| audio.cpp | `d3ab9df2` (2026-10-04) | `audiocpp_server`, 127.0.0.1:5455 |

Model context: llama router had `Qwen2.5-Coder-3B` + `EmbeddingGemma2` loaded;
sd-server had the `qwen-image-21` recipe loaded (Q4_K diffusion + Qwen3VL TE +
bf16 VAE); audio.cpp had `Breeze-TTS-2` (TTS) and `Qwen3-ASR` (ASR) configured.

## llama/

- `chat-nonstream.json` — `POST /v1/chat/completions`, `stream:false`. Carries
  `usage.prompt_tokens_details.cached_tokens` and a llama-only `timings` object.
- `chat-stream.sse` — `stream:true` **with** `stream_options.include_usage`. The
  usage arrives in a final chunk with `"choices":[]`, alongside `timings`.

## sd/

- `capabilities.json` — `GET /sdcpp/v1/capabilities`. The vocabulary a translator
  must validate against: `samplers` (22), `schedulers` (18),
  `output_formats_by_mode.img_gen` = `png|jpeg|webp`, `limits`
  (min/max width/height 64..4096, `max_batch_count` 8, `max_queue_size` 64), and
  `features_by_mode.img_gen` for the loaded context.
- `openai-generations.ignored-fields.json` — `POST /v1/images/generations` with
  `steps:3`, `seed:777`, `response_format:"url"`, `quality`, `style`, `user`.
  **The proof that the OpenAI route drops everything but
  `prompt/n/size/output_format/output_compression`**: the response's
  `generation_info` reports `sample_steps:20`, `seed:42`, `txt_cfg:1.0` — the
  server defaults, not the requested values. `response_format`/`quality`/`style`/
  `user` are never read at all. Response is always `data[].b64_json`, never `url`.
- `openai-generations.extra-args.json` — the escape hatch:
  `prompt = "… <sd_cpp_extra_args>{\"sample_params\":{\"sample_steps\":7,…}}</sd_cpp_extra_args>"`
  does reach the sampler (`sample_steps:7`), and the block is stripped from the
  prompt. Note `seed` inside `sample_params` is **ignored** — `seed` is a
  top-level field in the native schema.
- `img_gen-job-submitted.json` — `POST /sdcpp/v1/img_gen` returns **202** with
  `{id, kind, status:"queued", created, poll_url}`. `created` is **milliseconds**.
- `img_gen-job-completed.json` — `GET /sdcpp/v1/jobs/{id}` once finished:
  `status:"completed"`, `started`/`completed` ms timestamps, and
  `result.images[].{index,b64_json,generation_info}` + `result.output_format`.
  Unlike the OpenAI route, this one **honours** `sample_steps`, `seed`,
  `sample_method`, `scheduler` and `guidance.txt_cfg` — verified by echoing them
  back in `generation_info`.

## audio/

- `models.json` — `GET /v1/models`; `owned_by:"engine"`, no `slots` on this runtime.
- `speech-json.json` — `POST /v1/audio/speech` with `response_format:"json"`:
  `{audio:<b64 wav>, format, timing:{wall_ms, audio_duration_ms, rtf}}`. This is
  the only shape that exposes timing, so it is what a recording translator wants.
- `speech-stream.sse` + `speech-stream.headers.txt` — `stream:true`. Streaming
  **only supports `response_format:"pcm"`** (anything else is a 500
  `server_error`), and the SSE events are audio.cpp's own, not OpenAI's:
  `speech.audio.delta` (b64 PCM chunk) … `speech.audio.done`
  (`timing.ttft_ms`) … `data: [DONE]`. PCM is 16-bit signed; sample rate comes
  from the model.
- `speech-stream-unsupported-format.json` — the 500 body for
  `stream:true, response_format:"wav"`. Arguably an upstream bug (a client
  mistake answered with 5xx); a translator should pre-validate rather than relay it.
- `transcriptions.json` — `POST /v1/audio/transcriptions` (multipart `model` +
  `file`): `{text, timing:{wall_ms, audio_duration_ms, rtf}}`. No `usage` object
  at all — audio usage must be derived from characters in / audio duration out.

## Re-capturing

sd-server, llama-server and audiocpp_server were driven with plain `curl`; the
exact request bodies are recorded in `docs/proxy-server.md` §4.3.1. To refresh:
start each engine from its GUI instance, then re-run those curls and overwrite the
files here. Keep the shapes byte-exact — the tests assert against them.
