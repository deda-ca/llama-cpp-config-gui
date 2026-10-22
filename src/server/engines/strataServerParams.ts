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
 * aliases). `inputType: 'toggle'` rows are bare on/off flags; the rest take a
 * value.
 */

import type { ParamDef } from '../modelConfig.js';

export const STRATA_SERVER_PARAMS: ParamDef[] = [
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
  { flag: '--tokenizer', key: 'tokenizer', label: 'Tokenizer Dir', description: 'Pack tokenizer directory (falls back to a byte tokenizer if absent)', category: 'gpu', inputType: 'path' },

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
