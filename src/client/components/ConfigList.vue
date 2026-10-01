<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { ModelConfig, ConfigTemplate, ParamDef } from '../types';
import ConfigEditor from './ConfigEditor.vue';

interface ModelSpeeds {
  prefillTokensPerSec: number | null;
  generationTokensPerSec: number | null;
}

const props = defineProps<{
  /** Per-model token speeds parsed from llama.cpp logs, keyed by model name (alias) */
  modelMetrics?: Record<string, ModelSpeeds>;
}>();

const emit = defineEmits(['open-env']);

function getSpeeds(cfg: ModelConfig): ModelSpeeds | null {
  return props.modelMetrics?.[cfg.alias] || null;
}

const configs = ref<ModelConfig[]>([]);
const templates = ref<ConfigTemplate[]>([]);
const params = ref<ParamDef[]>([]);
const selectedId = ref<string | null>(null);
const editing = ref(false); // false = view mode (list only), true = editor open
const showNewModal = ref(false);
const newAlias = ref('');
const newTemplateId = ref('');

const selectedConfig = computed(() => configs.value.find((c) => c.id === selectedId.value) || null);

// True when a param is enabled (present, not "off", and not disabled)
function isParamOn(cfg: ModelConfig, key: string): boolean {
  const val = cfg.params[key];
  if (!val || val.toLowerCase() === 'off') return false;
  if ((cfg.disabledParams || []).includes(key)) return false;
  return true;
}

// Toggle a param on/off directly from the list and persist it
async function toggleParam(cfg: ModelConfig, key: string) {
  const turningOn = !isParamOn(cfg, key);
  if (turningOn) {
    cfg.params[key] = 'on';
    cfg.paramOrder = [...new Set([...cfg.paramOrder, key])];
    cfg.disabledParams = (cfg.disabledParams || []).filter((k) => k !== key);
  } else {
    cfg.params[key] = 'off';
    if (!cfg.disabledParams) cfg.disabledParams = [];
    if (!cfg.disabledParams.includes(key)) cfg.disabledParams.push(key);
  }
  await fetch(`/api/models/configs/${cfg.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }).catch(() => { /* non-fatal */ });
}

// Truncate notes for the list view; full text is shown on hover via title
function truncateNotes(notes: string, max = 128): string {
  const flat = (notes || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + '…' : flat;
}

// --- Process state (shared llama-server process) ---
const processStatus = ref('stopped');
let es: EventSource | null = null;

onMounted(async () => {
  await Promise.all([loadData(), fetchStatus()]);
  connectSse();
});

onUnmounted(() => {
  es?.close();
});

// Sync process state from the server on load, so a refresh doesn't hide the Stop button
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      const data = await res.json();
      processStatus.value = data.status;
    }
  } catch { /* ignore */ }
}

function connectSse() {
  es = new EventSource('/api/events');
  es.addEventListener('process-status', (e) => {
    processStatus.value = JSON.parse(e.data);
  });
}

const isRunning = computed(() => processStatus.value === 'running' || processStatus.value === 'starting');

// --- Router launch: select models via checkboxes, one Launch button ---
const selectedForLaunch = ref<Set<string>>(new Set());
const launching = ref(false);
const launchError = ref('');

function toggleLaunchSelection(id: string) {
  const next = new Set(selectedForLaunch.value);
  let included: boolean;
  if (next.has(id)) {
    next.delete(id);
    included = false;
  } else {
    next.add(id);
    included = true;
  }
  selectedForLaunch.value = next;

  // Persist on the config so the selection survives a browser refresh
  const cfg = configs.value.find((c) => c.id === id);
  if (cfg) {
    cfg.includeInLaunch = included;
    fetch(`/api/models/configs/${id}/launch-include`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include: included }),
    }).catch(() => { /* non-fatal */ });
  }
}

async function launchRouter() {
  if (selectedForLaunch.value.size === 0) return;
  launching.value = true;
  launchError.value = '';
  try {
    const res = await fetch('/api/launch-router', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configIds: [...selectedForLaunch.value] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      launchError.value = err.error || `Launch failed (${res.status})`;
    }
  } catch (e) {
    launchError.value = String(e);
  } finally {
    launching.value = false;
  }
}

async function stopProcess() {
  await fetch('/api/stop', { method: 'POST' });
}

async function loadData() {
  try {
    const [modelsRes, paramsRes] = await Promise.all([
      fetch('/api/models'),
      fetch('/api/params'),
    ]);
    if (modelsRes.ok) {
      const data = await modelsRes.json();
      configs.value = data.configs;
      templates.value = data.templates;
      // Restore persisted launch selection
      selectedForLaunch.value = new Set(
        data.configs.filter((c: ModelConfig) => c.includeInLaunch).map((c: ModelConfig) => c.id),
      );
      // Auto-select default config
      if (data.defaultConfigId) {
        selectedId.value = data.defaultConfigId;
      } else if (configs.value.length > 0) {
        selectedId.value = configs.value[0].id;
      }
    }
    if (paramsRes.ok) {
      params.value = await paramsRes.json();
    }
  } catch (e) {
    console.error('Failed to load models:', e);
  }
}

async function createConfig() {
  const alias = newAlias.value.trim() || 'New Config';
  // Apply template params if selected
  let initParams: Record<string, string> = {};
  let initOrder: string[] = [];
  if (newTemplateId.value) {
    const tpl = templates.value.find((t) => t.id === newTemplateId.value);
    if (tpl) {
      initParams = { ...tpl.params };
      initOrder = [...tpl.paramOrder];
    }
  }

  const res = await fetch('/api/models/configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias, params: initParams, paramOrder: initOrder }),
  });
  if (res.ok) {
    const newConfig = await res.json();
    configs.value.push(newConfig);
    selectedId.value = newConfig.id;
    showNewModal.value = false;
    newAlias.value = '';
    newTemplateId.value = '';
  }
}

async function deleteConfig(id: string) {
  if (!confirm('Delete this config?')) return;
  await fetch(`/api/models/configs/${id}`, { method: 'DELETE' });
  configs.value = configs.value.filter((c) => c.id !== id);
  if (selectedId.value === id) {
    selectedId.value = configs.value[0]?.id || null;
  }
}

async function cloneConfig(id: string) {
  const res = await fetch(`/api/models/configs/${id}/clone`, { method: 'POST' });
  if (res.ok) {
    const clone = await res.json();
    configs.value.push(clone);
    selectedId.value = clone.id;
  }
}

async function onConfigSaved(updated: ModelConfig) {
  const idx = configs.value.findIndex((c) => c.id === updated.id);
  if (idx !== -1) configs.value[idx] = updated;
}

function startEditing(id?: string) {
  if (id) selectedId.value = id;
  if (selectedId.value) {
    editing.value = true;
  }
}

function closeEditor() {
  editing.value = false;
}

async function importIni() {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.ini,.txt';
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const content = await file.text();
    const res = await fetch('/api/models/import-ini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (res.ok) {
      await loadData();
    }
  };
  fileInput.click();
}

async function exportIni() {
  const res = await fetch('/api/models/export-ini');
  const text = await res.text();
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'router.ini';
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="config-list">
    <!-- Toolbar -->
    <div class="toolbar">
      <h2 class="section-title">Model Configs</h2>
      <div class="toolbar-actions">
        <button
          v-if="!isRunning"
          class="btn btn-sm btn-launch"
          :disabled="launching || selectedForLaunch.size === 0"
          :title="selectedForLaunch.size === 0 ? 'Select models with the checkboxes first' : `Launch ${selectedForLaunch.size} model(s) via router.ini`"
          @click="launchRouter"
        >{{ launching ? 'Launching…' : `Launch (${selectedForLaunch.size})` }}</button>
        <button v-else class="btn btn-sm btn-stop" @click="stopProcess">Stop</button>
        <button class="btn btn-sm" @click="importIni" title="Import router.ini">Import</button>
        <button class="btn btn-sm" @click="exportIni" title="Export to router.ini">Export</button>
        <button class="btn btn-sm" @click="emit('open-env')" title="Environment settings">&#9881; Env</button>
        <button class="btn btn-sm btn-primary" @click="showNewModal = true">+ New</button>
      </div>
    </div>

    <!-- Launch error -->
    <div v-if="launchError" class="launch-error">{{ launchError }}</div>

    <!-- Config list (stays visible behind the editor dialog) -->
    <div class="config-items" v-if="configs.length > 0">
      <div
        v-for="cfg in configs"
        :key="cfg.id"
        class="config-item"
        :class="{ active: cfg.id === selectedId }"
        @click="selectedId = cfg.id"
      >
        <div class="config-item-main">
          <input
            type="checkbox"
            class="launch-check"
            :checked="selectedForLaunch.has(cfg.id)"
            :title="'Include in router launch'"
            @click.stop
            @change="toggleLaunchSelection(cfg.id)"
          />
          <div class="config-item-text">
            <span class="config-alias">{{ cfg.alias }}</span>
            <span v-if="getSpeeds(cfg)" class="config-speeds">
              <template v-if="getSpeeds(cfg)!.prefillTokensPerSec != null">⚡ {{ getSpeeds(cfg)!.prefillTokensPerSec!.toFixed(0) }} t/s</template>
              <template v-if="getSpeeds(cfg)!.generationTokensPerSec != null"> · ✍ {{ getSpeeds(cfg)!.generationTokensPerSec!.toFixed(1) }} t/s</template>
            </span>
          </div>
          <!-- Badge toggles: extensible, add more param toggles here -->
          <div class="item-badges">
            <button
              class="badge-toggle"
              :class="{ on: isParamOn(cfg, 'load-on-startup') }"
              title="Load on startup (click to toggle)"
              @click.stop="toggleParam(cfg, 'load-on-startup')"
            >load</button>
          </div>
          <span v-if="cfg.notes" class="config-notes" :title="cfg.notes">{{ truncateNotes(cfg.notes) }}</span>
        </div>
        <div class="config-item-actions" @click.stop>
          <button class="icon-btn" title="Edit" @click="startEditing(cfg.id)">&#9998;</button>
          <button class="icon-btn" title="Clone" @click="cloneConfig(cfg.id)">&#10697;</button>
          <button class="icon-btn icon-danger" title="Delete" @click="deleteConfig(cfg.id)">&times;</button>
        </div>
      </div>
    </div>
    <div v-else class="empty-state">
      No configs yet. Click "+ New" to create one, or "Import" to load a router.ini.
    </div>

    <!-- Editor dialog (self-contained: owns its own Dialog, footer, and close logic) -->
    <ConfigEditor
      v-if="selectedConfig && editing"
      :key="selectedConfig.id"
      :config="selectedConfig"
      :params="params"
      @saved="onConfigSaved"
      @close="closeEditor"
    />

    <!-- New Config Modal -->
    <div v-if="showNewModal" class="modal-overlay" @click.self="showNewModal = false">
      <div class="modal">
        <h3>New Model Config</h3>
        <label>Alias</label>
        <input v-model="newAlias" type="text" placeholder="e.g. Qwen3.8-27b:UD-Q4_K_XL" @keyup.enter="createConfig" />
        <label>Start from template (optional)</label>
        <select v-model="newTemplateId">
          <option value="">Blank</option>
          <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
        </select>
        <div class="modal-actions">
          <button class="btn" @click="showNewModal = false">Cancel</button>
          <button class="btn btn-primary" @click="createConfig">Create</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.toolbar-actions {
  display: flex;
  gap: 6px;
}

.btn {
  padding: 5px 12px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #e1e4e8;
  font-size: 0.78rem;
  cursor: pointer;
}

.btn:hover { background: #30363d; }

.btn-primary {
  background: #238636;
  border-color: #238636;
  color: white;
}

.btn-primary:hover { background: #2ea043; }

.btn-launch {
  background: #1f6feb;
  border-color: #1f6feb;
  color: white;
}

.btn-launch:hover { background: #388bfd; }

.btn-stop {
  background: #da3633;
  border-color: #da3633;
  color: white;
}

.btn-stop:hover { background: #f85149; }

.btn-sm { padding: 4px 10px; font-size: 0.75rem; }

.config-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}



.config-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.1s;
}

.config-item:hover { background: #21262d; }
.config-item.active { background: #1f6feb22; border-color: #1f6feb55; }

.config-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.launch-check {
  accent-color: #1f6feb;
  cursor: pointer;
  flex-shrink: 0;
}

.launch-error {
  flex-shrink: 0;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: #da363322;
  border: 1px solid #da363355;
  border-radius: 4px;
  color: #f85149;
  font-size: 0.75rem;
}

.config-item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.config-alias {
  font-size: 0.82rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-speeds {
  font-size: 0.68rem;
  color: #3fb950;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.badge-toggle {
  background: #21262d;
  border: 1px solid #30363d;
  color: #8b949e;
  font-size: 0.6rem;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.badge-toggle:hover { border-color: #58a6ff; color: #e1e4e8; }

.badge-toggle.on {
  background: #1f6feb33;
  border-color: #1f6feb55;
  color: #58a6ff;
}

.config-notes {
  flex: 1;
  min-width: 0;
  margin-left: auto;
  font-size: 0.72rem;
  color: #8b949e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}

.config-item-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.config-item:hover .config-item-actions { opacity: 1; }

.icon-btn {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 2px 4px;
}

.icon-btn:hover { color: #e1e4e8; }
.icon-danger:hover { color: #f85149; }

.empty-state {
  color: #484f58;
  font-size: 0.82rem;
  text-align: center;
  padding: 20px;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 20px;
  width: 380px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modal h3 { font-size: 1rem; margin-bottom: 4px; }

.modal label {
  font-size: 0.75rem;
  color: #8b949e;
}

.modal input,
.modal select {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 8px 10px;
  color: #e1e4e8;
  font-size: 0.85rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
