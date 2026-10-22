/**
 * Parameter catalog for the `serve/server.py` HTTP server (strata kind).
 *
 * These are the CLI options the Strata server's argparse block accepts
 * (serve/server.py). Unlike the engine catalog (`params.strata.json`, a
 * user-editable file of `strata generate` flags), this list is fixed by the
 * server's own argument parser, so it ships with the app rather than living in
 * `.config`. The StrataEditor's "Server" group renders it.
 *
 * `flag` is the CLI spelling the row shows; the config key it maps to is
 * derived by strata.ts (`--idle-unload` -> `idle_unload`, with a few documented
 * aliases). The `deployment` entries are the exception: `cwd`, `exe`,
 * `tokenizer` and `model_name` are config keys the server reads directly, so
 * their row name is the key verbatim (`flag` === `key`).
 * `inputType: 'toggle'` rows are bare on/off flags; the rest take a value.
 */

import type { ParamDef } from '../modelConfig.js';

export const STRATA_SERVER_PARAMS: ParamDef[] = [
  // --- Deployment (config keys, not CLI flags: the server reads these straight
  // from the config, so the row name is the key verbatim) ---
  { flag: 'cwd', key: 'cwd', label: 'Strata Repo Folder', description: 'Working directory; serve.server is imported from here and relative paths in the config resolve against it', category: 'deployment', inputType: 'path' },
  { flag: 'exe', key: 'exe', label: 'Engine Executable', description: 'The strata engine binary the server keeps resident; a component reference resolves against the engine component', category: 'deployment', inputType: 'path' },
  { flag: 'tokenizer', key: 'tokenizer', label: 'Tokenizer Directory', description: 'Pack tokenizer directory (vocab.json + merges.txt); overrides the --tokenizer flag', category: 'deployment', inputType: 'path' },
  { flag: 'model_name', key: 'model_name', label: 'Model Name', description: 'Name advertised on GET /v1/models; falls back to the family name when absent', category: 'deployment', inputType: 'text' },

  // --- Network ---
  { flag: '--host', key: 'host', label: 'Host', description: 'Address to listen on: 127.0.0.1 = this PC only, 0.0.0.0 = also other devices (set an API key)', category: 'network', inputType: 'text', default: '127.0.0.1' },
  { flag: '--port', key: 'port', label: 'Port', description: 'HTTP port to bind (CLI-only: the config "port" key is ignored)', category: 'network', inputType: 'number', default: '8095' },
  { flag: '--api-key', key: 'api-key', label: 'API Key', description: 'Require this key on /v1/* (Bearer or x-api-key); several keys separated by commas. Also $STRATA_API_KEY', category: 'network', inputType: 'text' },
  { flag: '--no-api-key', key: 'no-api-key', label: 'No API Key', description: 'Serve on the network without a key (anyone reaching the port can use the model)', category: 'network', inputType: 'toggle', default: 'off' },
  { flag: '--offline', key: 'offline', label: 'Offline', description: 'Do not fetch remote image URLs or start MCP/tool subprocesses', category: 'network', inputType: 'toggle', default: 'off' },
  { flag: '--open', key: 'open', label: 'Open Browser', description: 'Open the local page in the browser once the model is ready', category: 'network', inputType: 'toggle', default: 'off' },

  // --- GPU / engine slots ---
  { flag: '--gpu', key: 'gpu', label: 'GPU', description: 'GPU(s) as nvidia-smi numbers them; several for a layer split ("1,2,3"). Also "gpu" in the config', category: 'gpu', inputType: 'comma-list' },
  { flag: '--parallel', key: 'parallel', label: 'Parallel Slots', description: 'Request this many simultaneous engine slots without changing the saved config', category: 'gpu', inputType: 'number' },
  { flag: '--batch-groups', key: 'batch-groups', label: 'Batch Groups', description: 'Pipeline groups: "auto" or a positive integer, without changing the saved config', category: 'gpu', inputType: 'text' },
  { flag: '--replicas', key: 'replicas', label: 'Replicas', description: 'Data-parallel replicas: cut the GPU list into N equal groups, one engine each', category: 'gpu', inputType: 'number' },

  // --- Queue / overload ---
  { flag: '--max-queue', key: 'max-queue', label: 'Max Queue', description: 'Max inference calls waiting beyond engine slots; 0 refuses overload', category: 'queue', inputType: 'number' },
  { flag: '--queue-timeout', key: 'queue-timeout', label: 'Queue Timeout', description: 'Max seconds waiting for the first engine turn (0.1..600; off by default). Requires --max-queue', category: 'queue', inputType: 'number' },
  { flag: '--shutdown-timeout', key: 'shutdown-timeout', label: 'Shutdown Timeout', description: 'Graceful drain deadline in seconds (0..300) before owned requests are cancelled', category: 'queue', inputType: 'number' },
  { flag: '--batch-telemetry', key: 'batch-telemetry', label: 'Batch Telemetry', description: 'Low-rate engine decode-window samples for /v1/telemetry', category: 'queue', inputType: 'toggle', default: 'off' },

  // --- Load lifecycle ---
  { flag: '--lazy', key: 'lazy', label: 'Lazy Load', description: 'Start the API unloaded; the engine and vision encoder start with the first request', category: 'lifecycle', inputType: 'toggle', default: 'off' },
  { flag: '--idle-unload', key: 'idle-unload', label: 'Idle Unload (s)', description: 'Unload the model after this many idle seconds so other programs can use the VRAM; next request reloads', category: 'lifecycle', inputType: 'number' },
  { flag: '--min-free-vram-mib', key: 'min-free-vram-mib', label: 'Min Free VRAM (MiB)', description: 'Load an unloaded model only when this much VRAM is free, else answer 503', category: 'lifecycle', inputType: 'number' },
  { flag: '--before-load', key: 'before-load', label: 'Before Load', description: 'Command run before the model is loaded again (e.g. to unload another server)', category: 'lifecycle', inputType: 'text' },
  { flag: '--slot-save-path', key: 'slot-save-path', label: 'Slot Save Path', description: 'Enable POST /slots/0?action=save|restore to/from this directory (llama-server API)', category: 'lifecycle', inputType: 'path' },
  { flag: '--fit-max-tokens', key: 'fit-max-tokens', label: 'Fit Max Tokens', description: 'Clamp max_tokens to the remaining context instead of rejecting (the default)', category: 'lifecycle', inputType: 'toggle', default: 'off' },
  { flag: '--no-fit-max-tokens', key: 'no-fit-max-tokens', label: 'No Fit Max Tokens', description: 'Answer 400 when prompt + max_tokens does not fit, like llama.cpp', category: 'lifecycle', inputType: 'toggle', default: 'off' },

  // --- Tools / observability ---
  { flag: '--api-monitor', key: 'api-monitor', label: 'API Monitor', description: 'Request monitor at /api-monitor: keeps the last 100 requests in memory', category: 'tools', inputType: 'toggle', default: 'off' },
  { flag: '--mcp-config', key: 'mcp-config', label: 'MCP Config', description: 'JSON file with MCP servers in Claude Desktop format; the chat can use their tools', category: 'tools', inputType: 'path' },
  { flag: '--ready-file', key: 'ready-file', label: 'Ready File', description: 'Write a JSON instance record once the API is bound and model state is known', category: 'tools', inputType: 'path' },
];

/**
 * Vision encoder options (the config's `vision` object). Unlike the server
 * options these are **config keys, not CLI flags** — `serve/server.py` reads the
 * section and builds the `strata-vision` command line itself (`Vision.
 * reader_args`), so a row's name is the config key verbatim and a disabled row
 * simply omits the key. Keys the server does not know still ride through
 * untouched, which is why the editor offers custom rows here too.
 */
export const STRATA_VISION_PARAMS: ParamDef[] = [
  // --- Encoder & files ---
  { flag: 'exe', key: 'exe', label: 'Encoder Executable', description: 'strata-vision binary; a component reference resolves against the engine component', category: 'encoder', inputType: 'path' },
  { flag: 'mmproj', key: 'mmproj', label: 'mmproj File', description: 'Multimodal projector .gguf for the encoder', category: 'encoder', inputType: 'path' },
  { flag: 'model', key: 'model', label: 'Vision Model', description: 'Model .gguf the encoder reads embeddings from', category: 'encoder', inputType: 'path' },
  { flag: 'cpu_exe', key: 'cpu_exe', label: 'CPU Fallback Executable', description: 'CPU reader started instead when the GPU reader will not start (AMD/hip setups)', category: 'encoder', inputType: 'path' },

  // --- Device ---
  { flag: 'gpu', key: 'gpu', label: 'GPU', description: 'true = the engine GPU, false = CPU, a number = that device index', category: 'device', inputType: 'text', default: 'true' },
  { flag: 'cuda_device', key: 'cuda_device', label: 'CUDA Device', description: 'Pin the encoder to one device via its environment instead of the engine default', category: 'device', inputType: 'number' },
  { flag: 'threads', key: 'threads', label: 'Threads', description: 'CPU threads for the encoder (--threads on strata-vision)', category: 'device', inputType: 'number' },

  // --- Tokens ---
  { flag: 'max_tokens', key: 'max_tokens', label: 'Max Tokens', description: 'Image token budget (--max-tokens)', category: 'tokens', inputType: 'number', default: '1024' },
  { flag: 'min_tokens', key: 'min_tokens', label: 'Min Tokens', description: 'mtmd image_min_tokens floor (--min-tokens)', category: 'tokens', inputType: 'number' },

  // --- Elastic VRAM ---
  { flag: 'elastic', key: 'elastic', label: 'Elastic', description: 'Start the encoder with the first picture and stop it when idle; needs "vram_elastic": true at the top level', category: 'vram', inputType: 'toggle', default: 'off' },
  { flag: 'elastic_mib', key: 'elastic_mib', label: 'Elastic VRAM (MiB)', description: 'VRAM the expert cache keeps free for the encoder while it waits (default 2048)', category: 'vram', inputType: 'number' },
  { flag: 'elastic_idle_s', key: 'elastic_idle_s', label: 'Elastic Idle (s)', description: 'Idle seconds before an elastic encoder stops (default 120)', category: 'vram', inputType: 'number' },
];
