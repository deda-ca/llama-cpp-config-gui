/**
 * Sample llama.cpp structured log lines for testing the log parser.
 * Captured from real llama-server output.
 */

// --- Final results group (one query completion) ---
export const FINAL_RESULTS = [
  '[55997] 113.23.820.783 I slot print_timing: id  0 | task 38633 | n_gen =    228, tg =  74.89 t/s, tg_3s =  75.22 t/s',
  '[55997] 113.24.114.723 I slot print_timing: id  0 | task 38633 | prompt eval time =    2243.22 ms /   952 tokens (    2.36 ms per token,   424.39 tokens per second)',
  '[55997] 113.24.114.726 I slot print_timing: id  0 | task 38633 |        eval time =    3325.02 ms /   246 tokens (   13.57 ms per token,    73.68 tokens per second)',
  '[55997] 113.24.114.726 I slot print_timing: id  0 | task 38633 |       total time =    5568.24 ms /  1198 tokens',
];

// --- Prompt processing progress (during prefill) ---
export const PROMPT_PROGRESS = [
  '[55997] 72.01.529.783 I slot print_timing: id  0 | task 30880 | prompt processing, n_tokens =   4096, progress = 0.98, t =   4.64 s / 882.60 tokens per second',
  '[55997] 72.02.968.901 I slot print_timing: id  0 | task 30880 | prompt processing, n_tokens =   5436, progress = 0.99, t =   6.13 s / 886.14 tokens per second',
  '[55997] 72.03.313.253 I slot print_timing: id  0 | task 30880 | prompt processing, n_tokens =   5470, progress = 0.99, t =   6.59 s / 830.36 tokens per second',
  '[55997] 72.04.060.314 I slot print_timing: id  0 | task 30880 | prompt processing, n_tokens =   5948, progress = 1.00, t =   7.29 s / 815.53 tokens per second',
];

// --- Ongoing generation stats (periodic updates) ---
export const GEN_STATS = [
  '[55997] 56.31.224.920 I slot print_timing: id  0 | task 25672 | n_gen =   1118, tg = 123.79 t/s, tg_3s = 128.08 t/s',
  '[55997] 56.34.241.751 I slot print_timing: id  0 | task 25672 | n_gen =   1508, tg = 125.17 t/s, tg_3s = 129.27 t/s',
  '[55997] 56.37.251.097 I slot print_timing: id  0 | task 25672 | n_gen =   1891, tg = 125.59 t/s, tg_3s = 127.27 t/s',
  '[55997] 56.40.276.233 I slot print_timing: id  0 | task 25672 | n_gen =   2283, tg = 126.26 t/s, tg_3s = 129.58 t/s',
  '[55997] 56.43.284.592 I slot print_timing: id  0 | task 25672 | n_gen =   2644, tg = 125.36 t/s, tg_3s = 120.00 t/s',
];

// --- Non-structured lines (should return null from parseLogLine) ---
export const UNSTRUCTURED = [
  '',
  'some random text without structure',
  '[LAUNCH] /path/to/llama-server --model foo.gguf',
  'ggml_backend_cuda_init: found 3 CUDA devices',
  '  model size = 12.34 GB',
];

// --- Real captured log (CPU run, no [PID] prefix, optional function field) ---
// Captured from an actual llama-server run of Qwen2.5-Coder-1.5B on CPU.
export const REAL_LOGS = [
  '0.00.001.606 I srv  llama_server: initializing ...',
  '0.00.070.233 E ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected',
  '0.00.071.310 I cmn  common_param: common_params_print_info: verbosity = 3 (adjust with the `-lv N` CLI arg)',
  '0.00.071.567 W srv  llama_server: security: no API key is set and CORS allows all origins (see https://github.com/ggml-org/llama.cpp/pull/25655)',
  "0.00.075.674 I srv    load_model: loading model '/home/ueiricho/Programs/AI/models/Qwen2.5-Coder/Qwen2.5-Coder-1.5B-Instruct-Q8_0.gguf'",
  "0.00.343.062 W load: control-looking token: 128247 '</s>' was not control-type; this is probably a bug in the model. its type will be overridden",
  '0.00.930.365 I cmn          init: llama threadpool init, n_threads = 8',
  "0.01.027.340 I srv    load_model: initializing, n_slots = 4, n_ctx_slot = 2048, kv_unified = 'true'",
  '0.01.030.409 I srv  llama_server: model loaded',
  '0.01.030.413 I srv  llama_server: listening on http://127.0.0.1:9911',
  '0.19.127.530 I slot get_availabl: id  3 | task -1 | selected slot by LRU, t_last = -1',
  '0.19.127.548 I slot launch_slot_: id  3 | task 0 | processing task, is_child = 0',
  '0.20.763.882 I slot print_timing: id  3 | task 0 | prompt eval time =      55.97 ms /     8 tokens (    7.00 ms per token,   142.93 tokens per second)',
  '0.20.763.886 I slot print_timing: id  3 | task 0 |        eval time =    1580.34 ms /    40 tokens (   40.52 ms per token,    24.68 tokens per second)',
  '0.20.763.886 I slot print_timing: id  3 | task 0 |       total time =    1636.32 ms /    48 tokens',
  '0.20.763.887 I slot print_timing: id  3 | task 0 |    graphs reused =         39',
  '0.20.763.896 I slot      release: id  3 | task 0 | stop processing: n_tokens = 47, truncated = 0',
  '2.34.315.709 I srv    operator(): operator(): cleaning up before exit...',
];
