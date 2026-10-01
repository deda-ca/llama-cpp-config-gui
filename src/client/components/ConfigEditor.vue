<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { ModelConfig, ParamDef } from '../types';
import Dialog from './ui/Dialog.vue';

const props = defineProps<{
  config: ModelConfig;
  params: ParamDef[];
}>();

const emit = defineEmits(['saved', 'close']);

// App config (for export command: binary path, host, port, api-key, env vars)
interface AppConfig {
  llamaCppPath: string;
  host: string;
  port: number;
  apiKey: string;
  envVars: Record<string, string>;
}
const appConfig = ref<AppConfig>({ llamaCppPath: '', host: '127.0.0.1', port: 8080, apiKey: '', envVars: {} });

onMounted(async () => {
  try {
    const res = await fetch('/api/config');
    if (res.ok) appConfig.value = await res.json();
  } catch { /* use defaults */ }
});

// Local editable copy
function cloneConfig(cfg: ModelConfig): ModelConfig {
  return JSON.parse(JSON.stringify(cfg));
}

const local = ref<ModelConfig>(cloneConfig(props.config));

// Dirty flag: set once the user makes an edit, cleared on a successful save.
// (Replaces the old JSON.stringify snapshot comparison, which could desync from
// Vue's reactive proxies and keep reporting "modified" even right after a save.)
const dirty = ref(false);
let suppressDirty = false;

watch(
  local,
  () => {
    if (!suppressDirty) dirty.value = true;
  },
  { deep: true },
);

// Reset local when the config changes (programmatic — don't mark as dirty).
// In practice the parent re-creates this component via :key, so this is a safety net.
watch(
  () => props.config.id,
  () => {
    suppressDirty = true;
    local.value = cloneConfig(props.config);
    dirty.value = false;
    nextTick(() => {
      suppressDirty = false;
    });
  },
);

// Request close: confirm if there are unsaved changes
function requestClose() {
  if (dirty.value && !confirm('You have unsaved changes. Close without saving?')) return;
  emit('close');
}

// --- Param picker state ---
const showPicker = ref(false);
const pickerFilter = ref('');
const pickerRef = ref<HTMLElement | null>(null);
const bulkPasteRef = ref<HTMLElement | null>(null);

const filteredParams = computed(() => {
  const activeKeys = new Set(local.value.paramOrder);
  const q = pickerFilter.value.toLowerCase();
  return props.params.filter((p) => {
    if (activeKeys.has(p.key)) return false; // already added
    if (!q) return true;
    return p.key.toLowerCase().includes(q) || p.label.toLowerCase().includes(q) || p.flag.toLowerCase().includes(q);
  });
});

const groupedParams = computed(() => {
  const groups: Record<string, ParamDef[]> = {};
  for (const p of filteredParams.value) {
    if (!groups[p.category]) groups[p.category] = [];
    groups[p.category].push(p);
  }
  return groups;
});

// --- Active params grouped by category, in order ---
// Unknown params (e.g. from bulk paste) are kept as raw key=value entries
// and always rendered in their own "Unknown" group at the very end.
const UNKNOWN_GROUP = '__unknown__';

interface UnknownParam {
  key: string;
}

const knownKeySet = computed(() => new Set(props.params.map((p) => p.key)));

const activeParamDefs = computed(() => {
  return local.value.paramOrder
    .filter((key) => knownKeySet.value.has(key))
    .map((key) => props.params.find((p) => p.key === key)!);
});

const unknownParams = computed<UnknownParam[]>(() => {
  return local.value.paramOrder
    .filter((key) => !knownKeySet.value.has(key))
    .map((key) => ({ key }));
});

const groupedActive = computed(() => {
  const groups: Record<string, ParamDef[]> = {};
  for (const p of activeParamDefs.value) {
    if (!groups[p.category]) groups[p.category] = [];
    groups[p.category].push(p);
  }
  return groups;
});

const categoryLabels: Record<string, string> = {
  gpu: 'GPU & Offload',
  context: 'Context & RoPE',
  sampling: 'Sampling',
  reasoning: 'Reasoning',
  speculative: 'Speculative Decoding',
  other: 'Other',
  [UNKNOWN_GROUP]: 'Unknown',
};

// --- Preset inputs: free text + dropdown of preset values from param def ---
function presetValue(key: string): string {
  const def = props.params.find((p) => p.key === key);
  const cur = local.value.params[key] || '';
  return def?.presets?.includes(cur) ? cur : '';
}

function applyPreset(key: string, e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  if (val) local.value.params[key] = val;
}

// --- Actions ---
function addParam(key: string) {
  if (!local.value.paramOrder.includes(key)) {
    local.value.paramOrder.push(key);
    const def = props.params.find((p) => p.key === key);
    if (def?.default && !local.value.params[key]) {
      local.value.params[key] = def.default;
    } else if (!local.value.params[key]) {
      local.value.params[key] = '';
    }
  }
  showPicker.value = false;
  pickerFilter.value = '';
}

function removeParam(key: string) {
  local.value.paramOrder = local.value.paramOrder.filter((k) => k !== key);
  delete local.value.params[key];
  if (local.value.disabledParams) {
    local.value.disabledParams = local.value.disabledParams.filter((k) => k !== key);
  }
}

function isDisabled(key: string): boolean {
  return (local.value.disabledParams || []).includes(key);
}

function toggleDisabled(key: string) {
  if (!local.value.disabledParams) local.value.disabledParams = [];
  const idx = local.value.disabledParams.indexOf(key);
  if (idx >= 0) {
    local.value.disabledParams.splice(idx, 1);
  } else {
    local.value.disabledParams.push(key);
  }
}

function moveParam(key: string, direction: -1 | 1) {
  const idx = local.value.paramOrder.indexOf(key);
  const target = idx + direction;
  if (target < 0 || target >= local.value.paramOrder.length) return;
  [local.value.paramOrder[idx], local.value.paramOrder[target]] =
    [local.value.paramOrder[target], local.value.paramOrder[idx]];
}

// --- Drag to reorder (native HTML5 DnD, works across category groups) ---
// Dropping on a row always inserts the dragged param UNDERNEATH that row.
// Rows are only draggable while a press started on the drag handle, so
// text selection inside inputs/selects is not hijacked by the browser.
const dragKey = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
const dragEnabledKey = ref<string | null>(null);

function onHandleMousedown(key: string) {
  dragEnabledKey.value = key;
}

// Clear the flag if the press ended without a drag actually starting
function onGlobalMouseup() {
  dragEnabledKey.value = null;
}

onMounted(() => window.addEventListener('mouseup', onGlobalMouseup));
onUnmounted(() => window.removeEventListener('mouseup', onGlobalMouseup));

function onDragStart(key: string, e: DragEvent) {
  dragKey.value = key;
  e.dataTransfer?.setData('text/plain', key);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onDragOverRow(key: string, e: DragEvent) {
  e.preventDefault(); // allow drop
  if (!dragKey.value || dragKey.value === key) return;
  dropTarget.value = key;
}

function onDragLeaveRow() {
  dropTarget.value = null;
}

function onDropRow(targetKey: string, e: DragEvent) {
  e.preventDefault();
  const src = dragKey.value;
  clearDragState();
  if (!src || src === targetKey) return;

  const order = [...local.value.paramOrder];
  const fromIdx = order.indexOf(src);
  if (fromIdx === -1) return;

  // Always insert underneath the target row (index computed in the original
  // array, adjusted for the source removal when dragging downward).
  let insertIdx = order.indexOf(targetKey);
  if (insertIdx === -1) return;
  insertIdx += 1; // underneath
  if (fromIdx < insertIdx) insertIdx -= 1;

  order.splice(fromIdx, 1);
  order.splice(insertIdx, 0, src);
  local.value.paramOrder = order;
}

function onDragEnd() {
  clearDragState();
}

function clearDragState() {
  dragKey.value = null;
  dropTarget.value = null;
  dragEnabledKey.value = null;
}

function rowDropClass(key: string): string {
  if (!dragKey.value || dragKey.value === key) return '';
  if (dropTarget.value !== key) return '';
  return 'drop-after';
}

// --- Bulk paste ---
const showBulkPaste = ref(false);
const bulkText = ref('');
const bulkResult = ref<{ added: string[]; updated: string[]; unknown: string[] } | null>(null);

// Auto-scroll the editor to the expanded panel so it's visible without manual scrolling
watch(showPicker, (open) => {
  if (open) {
    requestAnimationFrame(() => pickerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
});

watch(showBulkPaste, (open) => {
  if (open) {
    requestAnimationFrame(() => bulkPasteRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
});

function applyBulkPaste() {
  const lines = bulkText.value.split('\n');
  const added: string[] = [];
  const updated: string[] = [];
  const unknown: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Support "key = value" and "--flag value" and "--flag" (toggle) formats
    let key: string | null = null;
    let value: string | null = null;

    const eqMatch = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (eqMatch) {
      key = eqMatch[1].trim();
      value = eqMatch[2].trim();
    } else {
      // Try --flag format
      const flagMatch = line.match(/^--([\w-]+)(?:\s+(.+))?$/);
      if (flagMatch) {
        key = flagMatch[1].trim();
        value = flagMatch[2]?.trim() || null;
      }
    }

    if (!key) continue;

    // Look up param def by key. Unknown params are kept as raw key=value
    // entries and shown under the "Unknown" group at the end.
    const def = props.params.find((p) => p.key === key);

    let finalValue: string;
    if (!def) {
      finalValue = value ?? '';
    } else if (def.inputType === 'toggle') {
      // For toggles, presence of flag or "on" means on
      finalValue = value === null || value === '' || value === 'on' || value === 'true' ? 'on' : value;
    } else {
      finalValue = value ?? '';
    }

    const alreadyExists = local.value.paramOrder.includes(key);
    if (alreadyExists) {
      local.value.params[key] = finalValue;
      updated.push(key);
    } else {
      local.value.paramOrder.push(key);
      local.value.params[key] = finalValue;
      added.push(key);
    }
    if (!def) unknown.push(key);
  }

  bulkResult.value = { added, updated, unknown };
}

// --- Tabs ---
const activeTab = ref<'params' | 'preview' | 'export'>('params');

// Build INI preview from the current local config (mirrors server exportRouterIni)
const CATEGORY_NAMES: Record<string, string> = {
  gpu: 'GPU & Offload',
  context: 'Context & RoPE',
  sampling: 'Sampling',
  reasoning: 'Reasoning',
  speculative: 'Speculative Decoding',
  other: 'Other',
};

const previewIni = computed(() => {
  const keyToCategory = new Map<string, string>();
  for (const p of props.params) keyToCategory.set(p.key, p.category);

  const lines: string[] = ['version = 1', ''];
  const cfg = local.value;
  lines.push(`[${cfg.alias}]`);

  if (cfg.notes) {
    for (const noteLine of cfg.notes.split('\n')) {
      lines.push(`# ${noteLine}`);
    }
  }

  const written = new Set<string>();
  let lastCategory: string | null = null;

  function writeHeader(category: string) {
    if (category === lastCategory) return;
    lastCategory = category;
    lines.push(`## ${CATEGORY_NAMES[category] || category}`);
  }

  if (cfg.modelPath) { lines.push(`model = ${cfg.modelPath}`); written.add('model'); }
  if (cfg.mmproj) { lines.push(`mmproj = ${cfg.mmproj}`); written.add('mmproj'); }
  if (cfg.chatTemplateFile) { lines.push(`chat-template-file = ${cfg.chatTemplateFile}`); written.add('chat-template-file'); }

  const disabledSet = new Set(cfg.disabledParams || []);
  for (const key of cfg.paramOrder) {
    if (written.has(key)) continue;
    const value = cfg.params[key];
    if (value === undefined || value === '') continue;
    const category = keyToCategory.get(key) || 'other';
    writeHeader(category);
    if (value === 'off' && !disabledSet.has(key)) {
      lines.push(`# ${key} = off`);
    } else if (disabledSet.has(key)) {
      lines.push(`# ${key} = ${value}`);
    } else {
      lines.push(`${key} = ${value}`);
    }
    written.add(key);
  }

  for (const [key, value] of Object.entries(cfg.params)) {
    if (!written.has(key) && value !== '') {
      const category = keyToCategory.get(key) || 'other';
      writeHeader(category);
      lines.push(`${key} = ${value}`);
    }
  }

  return lines.join('\n');
});

const copied = ref(false);
function copyPreview() {
  navigator.clipboard.writeText(previewIni.value).then(() => {
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  });
}

// --- Export command line (multi-line, grouped by category like the UI) ---
const exportCommand = computed(() => {
  const cfg = local.value;
  const app = appConfig.value;
  const binaryPath = app.llamaCppPath ? `${app.llamaCppPath}/llama-server` : 'llama-server';

  // Category order matching the UI
  const categoryOrder = ['gpu', 'context', 'sampling', 'reasoning', 'speculative', 'other'];

  // Build param lines grouped by category (same grouping as UI)
  const disabledSet = new Set(cfg.disabledParams || []);
  const keyToDef = new Map(props.params.map((p) => [p.key, p]));

  function paramLine(key: string): string | null {
    const value = cfg.params[key];
    if (value === undefined || value === '') return null;
    if (disabledSet.has(key)) return null;
    const def = keyToDef.get(key);
    if (def?.inputType === 'toggle') {
      return (value === 'on' || value === 'true') ? `--${key}` : null;
    }
    return `--${key} "${value}"`;
  }

  // Group active params by category, preserving paramOrder within each group
  const grouped: Record<string, string[]> = {};
  for (const key of cfg.paramOrder) {
    if (key === 'model') continue;
    const line = paramLine(key);
    if (!line) continue;
    const cat = keyToDef.get(key)?.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(line);
  }

  // Build lines in order: env vars → binary → server args → model → params
  const allLines: string[] = [];

  // Environment variables (each on its own line)
  for (const [k, v] of Object.entries(app.envVars)) {
    if (v) allLines.push(`${k}="${v}"`);
  }

  // Binary path
  allLines.push(binaryPath);

  // Server args (host, port, api-key) right after binary
  allLines.push(`--host ${app.host || '127.0.0.1'}`);
  allLines.push(`--port ${app.port || 8080}`);
  if (app.apiKey) allLines.push(`--api-key "${app.apiKey}"`);

  // Model
  if (cfg.modelPath) allLines.push(`--model "${cfg.modelPath}"`);

  // Params grouped by category (same order as UI)
  for (const cat of categoryOrder) {
    if (grouped[cat]) {
      for (const line of grouped[cat]) allLines.push(line);
    }
  }

  // Join with backslash continuation (each line ends with " \" except last)
  return allLines.map((line, i) => i < allLines.length - 1 ? line + ' \\' : line).join('\n');
});

const copiedExport = ref(false);
function copyExport() {
  navigator.clipboard.writeText(exportCommand.value).then(() => {
    copiedExport.value = true;
    setTimeout(() => (copiedExport.value = false), 1500);
  });
}

// --- Save feedback ---
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const saveLabel = computed(() => {
  switch (saveState.value) {
    case 'saving': return 'Saving…';
    case 'saved': return '✓ Saved';
    case 'error': return '✗ Failed';
    default: return 'Save';
  }
});

async function save() {
  saveState.value = 'saving';
  try {
    const res = await fetch(`/api/models/configs/${local.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(local.value),
    });
    if (res.ok) {
      saveState.value = 'saved';
      dirty.value = false;
      emit('saved', local.value);
    } else {
      saveState.value = 'error';
    }
  } catch {
    saveState.value = 'error';
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => (saveState.value = 'idle'), 2000);
}

async function setDefault() {
  local.value.isDefault = true;
  await save();
}

</script>

<template>
  <Dialog :title="`Edit Config — ${local.alias}`" @close="requestClose">
  <div class="config-editor">
    <!-- Header: alias + actions -->
    <div class="editor-header">
      <input v-model="local.alias" class="alias-input" type="text" />
      <div class="header-actions">
        <button v-if="!local.isDefault" class="btn btn-sm" @click="setDefault">Set Default</button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tab-bar">
      <button class="tab-btn" :class="{ active: activeTab === 'params' }" @click="activeTab = 'params'">Params</button>
      <button class="tab-btn" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'">Preview</button>
      <button class="tab-btn" :class="{ active: activeTab === 'export' }" @click="activeTab = 'export'">Export</button>
    </div>

    <!-- Params tab content -->
    <template v-if="activeTab === 'params'">
    <!-- Notes -->
    <div class="field">
      <label>Notes</label>
      <textarea v-model="local.notes" rows="2" placeholder="Performance notes, use case, trade-offs..."></textarea>
    </div>

    <!-- Model path -->
    <div class="field">
      <label>Model (.gguf)</label>
      <input v-model="local.modelPath" type="text" placeholder="/path/to/model.gguf" />
    </div>

    <!-- Active params grouped by category -->
    <div v-for="(group, cat) in groupedActive" :key="cat" class="param-group">
      <h4 class="group-title">{{ categoryLabels[cat] || cat }}</h4>
      <div
        v-for="pdef in group"
        :key="pdef.key"
        class="param-row"
        :class="{ 'param-disabled': isDisabled(pdef.key), 'dragging': dragKey === pdef.key }"
        :draggable="dragEnabledKey === pdef.key"
        @dragstart="onDragStart(pdef.key, $event)"
        @dragover="onDragOverRow(pdef.key, $event)"
        @dragleave="onDragLeaveRow()"
        @drop="onDropRow(pdef.key, $event)"
        @dragend="onDragEnd()"
      >
        <span class="drag-handle" title="Drag to reorder" @mousedown="onHandleMousedown(pdef.key)">&#8942;</span>
        <span class="param-flag">{{ pdef.flag }}</span>
        <!-- Toggle -->
        <label v-if="pdef.inputType === 'toggle'" class="toggle-wrap">
          <input
            type="checkbox"
            :checked="local.params[pdef.key] === 'on' || local.params[pdef.key] === 'true'"
            @change="(e: any) => local.params[pdef.key] = e.target.checked ? 'on' : 'off'"
          />
          <span>{{ local.params[pdef.key] === 'on' || local.params[pdef.key] === 'true' ? 'on' : 'off' }}</span>
        </label>
        <!-- Select -->
        <select
          v-else-if="pdef.inputType === 'select'"
          v-model="local.params[pdef.key]"
        >
          <option value="">(none)</option>
          <option v-for="opt in pdef.options" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <!-- Number -->
        <input
          v-else-if="pdef.inputType === 'number'"
          v-model="local.params[pdef.key]"
          type="number"
          step="any"
        />
        <!-- Path -->
        <input
          v-else-if="pdef.inputType === 'path'"
          v-model="local.params[pdef.key]"
          type="text"
          placeholder="/path/to/file"
        />
        <!-- Preset: free text + dropdown of preset values -->
        <template v-else-if="pdef.inputType === 'preset'">
          <input
            v-model="local.params[pdef.key]"
            type="text"
            :placeholder="pdef.default || ''"
          />
          <select v-if="pdef.presets?.length" class="preset-select" :value="presetValue(pdef.key)" @change="applyPreset(pdef.key, $event)" title="Quick presets">
            <option value="">preset…</option>
            <option v-for="p in pdef.presets" :key="p" :value="p">{{ p }}</option>
          </select>
        </template>
        <!-- Comma list / text -->
        <input
          v-else
          v-model="local.params[pdef.key]"
          type="text"
          :placeholder="pdef.inputType === 'comma-list' ? 'e.g. CUDA0,CUDA1' : ''"
        />
        <span class="param-desc" :title="pdef.description">{{ pdef.description }}</span>
        <button
          class="toggle-enabled-btn"
          :class="{ 'is-disabled': isDisabled(pdef.key) }"
          @click="toggleDisabled(pdef.key)"
          :title="isDisabled(pdef.key) ? 'Enable (uncomment in INI)' : 'Disable (comment out in INI)'"
        >{{ isDisabled(pdef.key) ? 'off' : 'on' }}</button>
        <button class="remove-btn" @click="removeParam(pdef.key)" title="Remove">&times;</button>
      </div>
    </div>

    <!-- Unknown params (from bulk paste) — always last -->
    <div v-if="unknownParams.length" class="param-group">
      <h4 class="group-title group-unknown">{{ categoryLabels[UNKNOWN_GROUP] }}</h4>
      <div
        v-for="up in unknownParams"
        :key="up.key"
        class="param-row param-unknown"
        :class="{ 'param-disabled': isDisabled(up.key), dragging: dragKey === up.key }"
        :draggable="dragEnabledKey === up.key"
        @dragstart="onDragStart(up.key, $event)"
        @dragover="onDragOverRow(up.key, $event)"
        @dragleave="onDragLeaveRow()"
        @drop="onDropRow(up.key, $event)"
        @dragend="onDragEnd()"
      >
        <span class="drag-handle" title="Drag to reorder" @mousedown="onHandleMousedown(up.key)">&#8942;</span>
        <span class="param-flag">{{ up.key }}</span>
        <input v-model="local.params[up.key]" type="text" />
        <span class="param-desc" :title="'Not a known llama.cpp parameter — kept as-is'">unknown parameter</span>
        <button
          class="toggle-enabled-btn"
          :class="{ 'is-disabled': isDisabled(up.key) }"
          @click="toggleDisabled(up.key)"
          :title="isDisabled(up.key) ? 'Enable (uncomment in INI)' : 'Disable (comment out in INI)'"
        >{{ isDisabled(up.key) ? 'off' : 'on' }}</button>
        <button class="remove-btn" @click="removeParam(up.key)" title="Remove">&times;</button>
      </div>
    </div>

    <!-- Add parameter button -->
    <div class="add-params-row">
      <button class="add-param-btn" @click="showPicker = !showPicker; showBulkPaste = false">
        + Add Parameter
      </button>
      <button class="add-param-btn" @click="showBulkPaste = !showBulkPaste; showPicker = false">
        Bulk Paste
      </button>
    </div>

    <!-- Bulk paste -->
    <div v-if="showBulkPaste" ref="bulkPasteRef" class="bulk-paste">
      <textarea
        v-model="bulkText"
        rows="10"
        placeholder="Paste key=value lines or --flag value pairs...&#10;e.g.&#10;device = CUDA0,CUDA2&#10;n-gpu-layers = 999&#10;flash-attn = on&#10;ctx-size = 262144"
      ></textarea>
      <div v-if="bulkResult" class="bulk-result">
        <span v-if="bulkResult.added.length" class="bulk-added">+ {{ bulkResult.added.join(', ') }}</span>
        <span v-if="bulkResult.updated.length" class="bulk-updated">~ {{ bulkResult.updated.join(', ') }}</span>
        <span v-if="bulkResult.unknown.length" class="bulk-unknown">? {{ bulkResult.unknown.join(', ') }}</span>
      </div>
      <div class="picker-actions">
        <button class="btn btn-sm btn-primary" @click="applyBulkPaste">Apply</button>
        <button class="btn btn-sm" @click="showBulkPaste = false; bulkText = ''; bulkResult = null">Cancel</button>
      </div>
    </div>

    <!-- Param picker -->
    <div v-if="showPicker" ref="pickerRef" class="param-picker">
      <input v-model="pickerFilter" type="text" placeholder="Search parameters..." autofocus />
      <div class="picker-list">
        <div v-for="(group, cat) in groupedParams" :key="cat" class="picker-group">
          <h5>{{ categoryLabels[cat] || cat }}</h5>
          <div
            v-for="p in group"
            :key="p.key"
            class="picker-item"
            @click="addParam(p.key)"
          >
            <span class="picker-flag">{{ p.flag }}</span>
            <span class="picker-desc">{{ p.description }}</span>
          </div>
        </div>
        <div v-if="filteredParams.length === 0" class="picker-empty">No matching parameters</div>
      </div>
      <div class="picker-actions">
        <button class="btn btn-sm" @click="showPicker = false; pickerFilter = ''">Cancel</button>
      </div>
    </div>
    </template>

    <!-- Preview tab content -->
    <div v-if="activeTab === 'preview'" class="preview-panel">
      <div class="preview-header">
        <span class="preview-label">router.ini output</span>
        <button class="btn btn-sm" @click="copyPreview">{{ copied ? '✓ Copied' : 'Copy' }}</button>
      </div>
      <pre class="preview-code">{{ previewIni }}</pre>
    </div>

    <!-- Export tab content -->
    <div v-if="activeTab === 'export'" class="preview-panel">
      <div class="preview-header">
        <span class="preview-label">Command line</span>
        <button class="btn btn-sm" @click="copyExport">{{ copiedExport ? '✓ Copied' : 'Copy' }}</button>
      </div>
      <pre class="preview-code export-cmd">{{ exportCommand }}</pre>
    </div>
  </div>
  <template #footer>
    <button class="btn" @click="requestClose">{{ dirty ? 'Cancel' : 'Close' }}</button>
    <button
      class="btn"
      :class="saveState === 'saved' ? 'btn-saved' : saveState === 'error' ? 'btn-error' : 'btn-primary'"
      :disabled="saveState === 'saving'"
      @click="save"
    >{{ saveLabel }}</button>
  </template>
  </Dialog>
</template>

<style scoped>
.config-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100%;
  padding-right: 4px;
}

.editor-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.alias-input {
  flex: 1;
  min-width: 200px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 8px 10px;
  color: #e1e4e8;
  font-size: 0.9rem;
  font-weight: 600;
}

.alias-input:focus { outline: none; border-color: #58a6ff; }

.header-actions {
  display: flex;
  gap: 6px;
}

.tab-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #30363d;
}

.tab-btn {
  padding: 6px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #8b949e;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}

.tab-btn:hover { color: #e1e4e8; }

.tab-btn.active {
  color: #58a6ff;
  border-bottom-color: #58a6ff;
}

.preview-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.preview-label {
  font-size: 0.72rem;
  color: #8b949e;
  font-weight: 500;
}

.preview-code {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 12px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 200px;
}

.export-cmd {
  color: #7ee787;
}

.btn {
  padding: 5px 12px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #e1e4e8;
  font-size: 0.75rem;
  cursor: pointer;
}

.btn:hover { background: #30363d; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-primary { background: #238636; border-color: #238636; color: white; }
.btn-primary:hover:not(:disabled) { background: #2ea043; }

.btn-saved { background: #2ea043; border-color: #2ea043; color: white; }

.btn-error { background: #da3633; border-color: #da3633; color: white; }

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field label {
  font-size: 0.72rem;
  color: #8b949e;
  font-weight: 500;
}

.field input,
.field textarea {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 7px 10px;
  color: #e1e4e8;
  font-size: 0.82rem;
  font-family: inherit;
}

.field input:focus,
.field textarea:focus { outline: none; border-color: #58a6ff; }

.param-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-title {
  font-size: 0.7rem;
  color: #58a6ff;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 4px;
}

.group-unknown {
  color: #d29922;
}

.param-unknown .param-flag {
  color: #d29922;
}

.param-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: #0d1117;
  border: 1px solid #21262d;
}

.param-row:hover { border-color: #30363d; }

.param-row[draggable] { cursor: default; }

.param-row.dragging {
  opacity: 0.4;
}

.param-row.drop-after {
  box-shadow: 0 2px 0 0 #58a6ff;
}

.param-row.param-disabled {
  opacity: 0.5;
}

.param-row.param-disabled .param-flag {
  text-decoration: line-through;
  color: #484f58;
}

.toggle-enabled-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 3px;
  color: #3fb950;
  font-size: 0.62rem;
  padding: 1px 5px;
  cursor: pointer;
  text-transform: uppercase;
}

.toggle-enabled-btn:hover { background: #23863633; }

.toggle-enabled-btn.is-disabled {
  color: #f85149;
  border-color: #da3633;
}

.toggle-enabled-btn.is-disabled:hover { background: #da363333; }

.drag-handle {
  color: #484f58;
  cursor: grab;
  font-size: 0.8rem;
  user-select: none;
}

.drag-handle:active { cursor: grabbing; }

.param-flag {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.72rem;
  color: #79c0ff;
  min-width: 140px;
}

.param-row input,
.param-row select {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 3px;
  padding: 4px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
  flex: 1;
  min-width: 60px;
}

.param-row input:focus,
.param-row select:focus { outline: none; border-color: #58a6ff; }

.preset-select {
  flex: 0 0 auto;
  min-width: 74px;
  background: #0d1117;
  color: #8b949e;
}

.toggle-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: #8b949e;
}

.param-desc {
  font-size: 0.65rem;
  color: #484f58;
  flex: 0 0 160px;
  width: 160px;
  margin-left: auto; /* push description + buttons to the far right */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toggle-enabled-btn {
  flex: 0 0 auto;
}

.remove-btn {
  background: none;
  border: none;
  color: #484f58;
  font-size: 1rem;
  cursor: pointer;
  padding: 0 4px;
  flex: 0 0 auto;
}

.remove-btn:hover { color: #f85149; }

.add-params-row {
  display: flex;
  gap: 8px;
}

.add-param-btn {
  background: none;
  border: 1px dashed #30363d;
  border-radius: 4px;
  padding: 8px;
  color: #58a6ff;
  font-size: 0.82rem;
  cursor: pointer;
  text-align: center;
  flex: 1;
}

.add-param-btn:hover { border-color: #58a6ff; background: #1f6feb11; }

.bulk-paste {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid #30363d;
  border-radius: 6px;
  overflow: hidden;
}

.bulk-paste textarea {
  width: 100%;
  background: #0d1117;
  border: none;
  border-bottom: 1px solid #30363d;
  padding: 10px 12px;
  color: #e1e4e8;
  font-size: 0.8rem;
  font-family: 'Cascadia Code', monospace;
  resize: vertical;
  min-height: 160px;
}

.bulk-paste textarea:focus { outline: none; }

.param-picker {
  border: 1px solid #30363d;
  border-radius: 6px;
  overflow: hidden;
}

.param-picker input {
  width: 100%;
  background: #0d1117;
  border: none;
  border-bottom: 1px solid #30363d;
  padding: 8px 12px;
  color: #e1e4e8;
  font-size: 0.82rem;
}

.param-picker input:focus { outline: none; }

.picker-list {
  max-height: 250px;
  overflow-y: auto;
}

.picker-group h5 {
  font-size: 0.65rem;
  color: #8b949e;
  text-transform: uppercase;
  padding: 6px 12px 2px;
  position: sticky;
  top: 0;
  background: #161b22;
}

.picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px;
  cursor: pointer;
}

.picker-item:hover { background: #21262d; }

.picker-flag {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.72rem;
  color: #79c0ff;
  min-width: 150px;
}

.picker-desc {
  font-size: 0.7rem;
  color: #8b949e;
}

.picker-empty {
  padding: 12px;
  text-align: center;
  color: #484f58;
  font-size: 0.8rem;
}

.picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid #30363d;
}
</style>
