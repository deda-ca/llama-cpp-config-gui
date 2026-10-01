import type { ParamDef } from './modelConfig.js';

/**
 * Default parameter reference, generated from llama.cpp CLI README.
 * Source: https://github.com/ggml-org/llama.cpp/blob/master/tools/cli/README.md
 * Can be refreshed via the UI "Refresh Param Info" button.
 */
export const DEFAULT_PARAMS: ParamDef[] = [
  // --- GPU & Offload ---
  { flag: '--device', key: 'device', label: 'Device', description: 'Comma-separated list of devices to use (e.g. CUDA0,CUDA1)', category: 'gpu', inputType: 'comma-list' },
  { flag: '--tensor-split', key: 'tensor-split', label: 'Tensor Split', description: 'Comma-separated weights for splitting tensors across GPUs (e.g. 16,8,16)', category: 'gpu', inputType: 'comma-list' },
  { flag: '--split-mode', key: 'split-mode', label: 'Split Mode', description: 'How to split the model across devices', category: 'gpu', inputType: 'select', options: ['layer', 'row', 'tensor'] },
  { flag: '--n-gpu-layers', key: 'n-gpu-layers', label: 'GPU Layers', description: 'Number of layers to offload to GPU (999 = all)', category: 'gpu', inputType: 'number', default: '99' },
  { flag: '--main-gpu', key: 'main-gpu', label: 'Main GPU', description: 'Index of the main GPU device', category: 'gpu', inputType: 'number', default: '0' },
  { flag: '--threads', key: 'threads', label: 'Threads', description: 'Number of CPU threads to use', category: 'gpu', inputType: 'number', default: '0' },
  { flag: '--flash-attn', key: 'flash-attn', label: 'Flash Attention', description: 'Enable flash attention for improved performance', category: 'gpu', inputType: 'toggle', default: 'off' },
  { flag: '--cache-type-k', key: 'cache-type-k', label: 'Cache Type K', description: 'Data type for K cache in KV cache', category: 'gpu', inputType: 'select', options: ['f16', 'f32', 'q8_0', 'q5_1', 'q5_0', 'q4_0', 'q4_1'] },
  { flag: '--cache-type-v', key: 'cache-type-v', label: 'Cache Type V', description: 'Data type for V cache in KV cache', category: 'gpu', inputType: 'select', options: ['f16', 'f32', 'q8_0', 'q5_1', 'q5_0', 'q4_0', 'q4_1'] },
  { flag: '--no-warmup', key: 'no-warmup', label: 'No Warmup', description: 'Skip the warmup pass at startup', category: 'gpu', inputType: 'toggle', default: 'off' },
  { flag: '--fit', key: 'fit', label: 'Fit', description: 'Automatically fit context size to available VRAM', category: 'gpu', inputType: 'toggle', default: 'off' },
  { flag: '--no-mmap', key: 'no-mmap', label: 'No MMAP', description: 'Do not use memory-mapped file loading', category: 'gpu', inputType: 'toggle', default: 'off' },
  { flag: '--mlock', key: 'mlock', label: 'MLock', description: 'Force system to keep model in RAM', category: 'gpu', inputType: 'toggle', default: 'off' },

  // --- Context & RoPE ---
  { flag: '--ctx-size', key: 'ctx-size', label: 'Context Size', description: 'Size of the context window (tokens)', category: 'context', inputType: 'preset', default: '4096', presets: ['4096', '8192', '16384', '32768', '65536', '131072', '262144'] },
  { flag: '--rope-scaling', key: 'rope-scaling', label: 'RoPE Scaling', description: 'RoPE scaling method for extended context', category: 'context', inputType: 'select', options: ['linear', 'yarn'] },
  { flag: '--rope-scale', key: 'rope-scale', label: 'RoPE Scale', description: 'RoPE scaling factor', category: 'context', inputType: 'preset', presets: ['1.0', '2.0', '4.0', '8.0', '16.0'] },
  { flag: '--yarn-orig-ctx', key: 'yarn-orig-ctx', label: 'YaRN Original Context', description: 'Original context size for YaRN scaling', category: 'context', inputType: 'preset', presets: ['4096', '8192', '16384', '32768', '65536', '131072'] },

  // --- Sampling ---
  { flag: '--temp', key: 'temp', label: 'Temperature', description: 'Sampling temperature (0 = greedy)', category: 'sampling', inputType: 'preset', default: '1.0', presets: ['0.0', '0.5', '0.7', '0.8', '1.0', '1.2'] },
  { flag: '--top-p', key: 'top-p', label: 'Top-P', description: 'Nucleus sampling threshold', category: 'sampling', inputType: 'preset', default: '0.95', presets: ['0.8', '0.9', '0.95', '1.0'] },
  { flag: '--top-k', key: 'top-k', label: 'Top-K', description: 'Only sample from top K tokens (0 = disabled)', category: 'sampling', inputType: 'preset', default: '40', presets: ['0', '10', '20', '40', '50', '100'] },
  { flag: '--min-p', key: 'min-p', label: 'Min-P', description: 'Minimum probability threshold relative to top token', category: 'sampling', inputType: 'number', default: '0.05' },
  { flag: '--presence-penalty', key: 'presence-penalty', label: 'Presence Penalty', description: 'Penalty for repeating tokens already in context', category: 'sampling', inputType: 'number', default: '0.0' },
  { flag: '--repeat-penalty', key: 'repeat-penalty', label: 'Repeat Penalty', description: 'Penalty for repeating n-grams', category: 'sampling', inputType: 'number', default: '1.1' },
  { flag: '--seed', key: 'seed', label: 'Seed', description: 'Random seed for reproducible sampling (-1 = random)', category: 'sampling', inputType: 'number', default: '-1' },

  // --- Reasoning ---
  { flag: '--reasoning', key: 'reasoning', label: 'Reasoning', description: 'Enable reasoning mode (chain-of-thought)', category: 'reasoning', inputType: 'toggle', default: 'off' },
  { flag: '--reasoning-format', key: 'reasoning-format', label: 'Reasoning Format', description: 'Format for reasoning output parsing', category: 'reasoning', inputType: 'select', options: ['deepseek', 'qwen'] },
  { flag: '--reasoning-preserve', key: 'reasoning-preserve', label: 'Reasoning Preserve', description: 'Preserve reasoning tokens in conversation history', category: 'reasoning', inputType: 'toggle', default: 'off' },
  { flag: '--reasoning-budget', key: 'reasoning-budget', label: 'Reasoning Budget', description: 'Maximum tokens for reasoning before forcing answer', category: 'reasoning', inputType: 'number' },
  { flag: '--reasoning-effort', key: 'reasoning-effort', label: 'Reasoning Effort', description: 'Reasoning effort level', category: 'reasoning', inputType: 'select', options: ['low', 'medium', 'high'] },
  { flag: '--reasoning-budget-message', key: 'reasoning-budget-message', label: 'Budget Exceeded Message', description: 'Message injected when reasoning budget is exceeded', category: 'reasoning', inputType: 'text' },

  // --- Speculative Decoding ---
  { flag: '--spec-type', key: 'spec-type', label: 'Speculative Type', description: 'Speculative decoding method', category: 'speculative', inputType: 'select', options: ['draft-mtp', 'draft'] },
  { flag: '--spec-draft-n-max', key: 'spec-draft-n-max', label: 'Spec Draft N Max', description: 'Maximum number of draft tokens per step', category: 'speculative', inputType: 'number', default: '2' },
  { flag: '--model-draft', key: 'model-draft', label: 'Draft Model', description: 'Path to draft model for speculative decoding', category: 'speculative', inputType: 'path' },

  // --- Other ---
  { flag: '--mmproj', key: 'mmproj', label: 'MMProj File', description: 'Path to a local multimodal projector file (.gguf)', category: 'other', inputType: 'path' },
  { flag: '--mmproj-url', key: 'mmproj-url', label: 'MMProj URL', description: 'URL to a multimodal projector file (alternative to --mmproj)', category: 'other', inputType: 'text' },
  { flag: '--mmproj-offload', key: 'mmproj-offload', label: 'MMProj Offload', description: 'Enable GPU offloading for the multimodal projector', category: 'other', inputType: 'toggle', default: 'on' },
  { flag: '--mmproj-device', key: 'mmproj-device', label: 'MMProj Device', description: 'Device for the multimodal projector (none = don\'t offload; default follows --device)', category: 'other', inputType: 'text' },
  { flag: '--alias', key: 'alias', label: 'Alias', description: 'Model name aliases, comma-separated (used by the API for routing)', category: 'other', inputType: 'comma-list' },
  { flag: '--jinja', key: 'jinja', label: 'Jinja Templates', description: 'Use Jinja chat templates from the model', category: 'other', inputType: 'toggle', default: 'off' },
  { flag: '--parallel', key: 'parallel', label: 'Parallel Slots', description: 'Number of parallel request slots', category: 'other', inputType: 'preset', default: '1', presets: ['1', '2', '4', '8'] },
  { flag: '--port', key: 'port', label: 'Port', description: 'Server port (llama-server mode)', category: 'other', inputType: 'preset', default: '8080', presets: ['8080', '8081', '5000', '3000'] },
  { flag: '--host', key: 'host', label: 'Host', description: 'Server bind address', category: 'other', inputType: 'text', default: '127.0.0.1' },
  { flag: '--chat-template-file', key: 'chat-template-file', label: 'Chat Template File', description: 'Path to custom Jinja chat template file', category: 'other', inputType: 'path' },

  // --- Router (preset-only, used in router.ini sections) ---
  { flag: '--load-on-startup', key: 'load-on-startup', label: 'Load on Startup', description: 'Router mode: automatically load this model when the server starts (per INI section)', category: 'other', inputType: 'toggle', default: 'off' },
  { flag: '--models-max', key: 'models-max', label: 'Models Max', description: 'Router mode: maximum number of models to load simultaneously (0 = unlimited; startup loads exceeding this are an error)', category: 'other', inputType: 'preset', default: '4', presets: ['1', '2', '4', '8', '0'] },
];
