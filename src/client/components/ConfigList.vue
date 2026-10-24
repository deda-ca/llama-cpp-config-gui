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
// Engine family for a new card (docs/audio.md §2.5): '' = llama.cpp, the
// default every pre-existing card uses. Templates only apply to llama.cpp.
const newType = ref('');
const dragId = ref<string | null>(null);
const dropTargetId = ref<string | null>(null);
const dragEnabledId = ref<string | null>(null);

const selectedConfig = computed(() => configs.value.find((c) => c.id === selectedId.value) || null);

// Toggle the star on a model card and persist it (UI-only marker)
async function toggleFavorite(cfg: ModelConfig) {
  cfg.favorite = !cfg.favorite;
  await fetch(`/api/models/configs/${cfg.id}/favorite`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite: cfg.favorite }),
  }).catch(() => { /* non-fatal */ });
}

// Truncate notes for the list view; full text is shown on hover via title
function truncateNotes(notes: string, max = 128): string {
  const flat = (notes || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + '…' : flat;
}

// Engine family column: every card shows its runtime; cards created before
// typed cards existed carry no `type` and are llama.cpp. Each kind gets its
// own icon + color so the list is scannable at a glance.
interface TypeMeta {
  label: string;
  icon: string;
  cls: string;
}
function typeMeta(type?: string): TypeMeta {
  if (type === 'audio') return { label: 'audio.cpp', icon: '🔊', cls: 'type-audio' };
  if (type === 'strata') return { label: 'strata', icon: '🧠', cls: 'type-strata' };
  if (!type) return { label: 'llama.cpp', icon: '🦙', cls: 'type-llama' };
  return { label: type, icon: '⚙', cls: 'type-other' };
}

onMounted(() => {
  loadData();
});

async function loadData() {
  try {
    const [modelsRes, paramsRes] = await Promise.all([
      fetch('/api/models'),
      fetch('/api/params'),
    ]);
    if (modelsRes.ok) {
      const data = await modelsRes.json();
      const orderedIds = Array.isArray(data.configOrder) ? data.configOrder : data.configs.map((c: ModelConfig) => c.id);
      const byId = new Map((data.configs || []).map((c: ModelConfig) => [c.id, c]));
      configs.value = orderedIds
        .map((id: string) => byId.get(id))
        .filter(Boolean) as ModelConfig[];
      const leftover = (data.configs || []).filter((c: ModelConfig) => !orderedIds.includes(c.id));
      configs.value.push(...leftover);
      templates.value = data.templates;
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
    body: JSON.stringify({
      alias,
      params: initParams,
      paramOrder: initOrder,
      ...(newType.value ? { type: newType.value } : {}),
    }),
  });
  if (res.ok) {
    const newConfig = await res.json();
    configs.value.push(newConfig);
    selectedId.value = newConfig.id;
    showNewModal.value = false;
    newAlias.value = '';
    newTemplateId.value = '';
    newType.value = '';
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

async function persistConfigOrder() {
  const order = configs.value.map((cfg) => cfg.id);
  try {
    await fetch('/api/models/configs/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configOrder: order }),
    });
  } catch {
    // non-fatal; the UI still reflects the local reorder during the session
  }
}

function onGlobalMouseup() {
  dragEnabledId.value = null;
}

function onConfigDragStart(id: string, e: DragEvent) {
  dragId.value = id;
  e.dataTransfer?.setData('text/plain', id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onConfigDragOver(id: string, e: DragEvent) {
  e.preventDefault();
  if (!dragId.value || dragId.value === id) return;
  dropTargetId.value = id;
}

function onConfigDrop(targetId: string, e: DragEvent) {
  e.preventDefault();
  const srcId = dragId.value;
  clearConfigDrag();
  if (!srcId || srcId === targetId) return;

  const sourceIndex = configs.value.findIndex((cfg) => cfg.id === srcId);
  const targetIndex = configs.value.findIndex((cfg) => cfg.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return;

  const next = [...configs.value];
  const [moved] = next.splice(sourceIndex, 1);
  let insertIndex = targetIndex + 1;
  if (sourceIndex < insertIndex) insertIndex -= 1;
  next.splice(insertIndex, 0, moved);
  configs.value = next;
  persistConfigOrder();
}

function clearConfigDrag() {
  dragId.value = null;
  dropTargetId.value = null;
  dragEnabledId.value = null;
}

function configDropClass(id: string): string {
  if (!dragId.value || dragId.value === id) return '';
  return dropTargetId.value === id ? 'drop-after' : '';
}

onMounted(() => {
  window.addEventListener('mouseup', onGlobalMouseup);
});

onUnmounted(() => {
  window.removeEventListener('mouseup', onGlobalMouseup);
});

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
        <button class="btn btn-sm" @click="importIni" title="Import router.ini">Import</button>
        <button class="btn btn-sm" @click="exportIni" title="Export to router.ini">Export</button>
        <button class="btn btn-sm btn-primary" @click="showNewModal = true">+ New</button>
      </div>
    </div>

    <!-- Column headers -->
    <div class="config-header" v-if="configs.length > 0">
      <span class="col col-handle"></span>
      <span class="col col-fav" title="Favorites">★</span>
      <span class="col col-name">Name</span>
      <span class="col col-notes">Comment</span>
      <span class="col col-type">Engine</span>
      <span class="col col-actions"></span>
    </div>

    <!-- Config list (stays visible behind the editor dialog) -->
    <div class="config-items" v-if="configs.length > 0">
      <div
        v-for="cfg in configs"
        :key="cfg.id"
        class="config-item"
        :class="[{ active: cfg.id === selectedId }, configDropClass(cfg.id)]"
        :draggable="dragEnabledId === cfg.id"
        @click="selectedId = cfg.id"
        @dragstart="onConfigDragStart(cfg.id, $event)"
        @dragover="onConfigDragOver(cfg.id, $event)"
        @drop="onConfigDrop(cfg.id, $event)"
        @dragend="clearConfigDrag"
      >
        <span class="col col-handle">
          <button
            class="drag-handle"
            title="Drag to reorder"
            tabindex="-1"
            @mousedown="dragEnabledId = cfg.id"
            @click.stop
          >⋮</button>
        </span>
        <span class="col col-fav">
          <button
            class="fav-star"
            :class="{ on: cfg.favorite }"
            :title="cfg.favorite ? 'Remove from favorites' : 'Add to favorites'"
            @click.stop="toggleFavorite(cfg)"
          >{{ cfg.favorite ? '★' : '☆' }}</button>
        </span>
        <span class="col col-name">
          <span class="config-alias">{{ cfg.alias }}</span>
          <span v-if="getSpeeds(cfg)" class="config-speeds">
            <template v-if="getSpeeds(cfg)!.prefillTokensPerSec != null">⚡ {{ getSpeeds(cfg)!.prefillTokensPerSec!.toFixed(0) }} t/s</template>
            <template v-if="getSpeeds(cfg)!.generationTokensPerSec != null"> · ✍ {{ getSpeeds(cfg)!.generationTokensPerSec!.toFixed(1) }} t/s</template>
          </span>
        </span>
        <span class="col col-notes" :title="cfg.notes">{{ cfg.notes ? truncateNotes(cfg.notes) : '' }}</span>
        <span class="col col-type">
          <span class="type-badge" :class="typeMeta(cfg.type).cls">
            <span class="type-icon">{{ typeMeta(cfg.type).icon }}</span>{{ typeMeta(cfg.type).label }}
          </span>
        </span>
        <span class="col col-actions config-item-actions" @click.stop>
          <button class="icon-btn" title="Edit" @click="startEditing(cfg.id)">&#9998;</button>
          <button class="icon-btn" title="Clone" @click="cloneConfig(cfg.id)">&#10697;</button>
          <button class="icon-btn icon-danger" title="Delete" @click="deleteConfig(cfg.id)">&times;</button>
        </span>
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
        <label>Engine type</label>
        <select v-model="newType">
          <option value="">llama.cpp</option>
          <option value="audio">audio.cpp</option>
        </select>
        <label>Start from template (optional)</label>
        <select v-model="newTemplateId" :disabled="!!newType">
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

.btn-sm { padding: 4px 10px; font-size: 0.75rem; }

.config-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* Shared grid so the header row and every card line up in columns */
.config-header,
.config-item {
  display: grid;
  grid-template-columns: 20px 26px minmax(120px, 2fr) minmax(100px, 3fr) 84px auto;
  align-items: center;
  gap: 8px;
}

.config-header {
  flex-shrink: 0;
  padding: 4px 10px;
  border-bottom: 1px solid #30363d;
  color: #8b949e;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.col {
  min-width: 0;
}

.col-handle {
  text-align: center;
}

.col-fav {
  text-align: center;
}

.col-type {
  text-align: right;
}

.col-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.config-item {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.1s;
}

.config-item[draggable] { cursor: grab; }
.config-item:hover { background: #21262d; }
.config-item.active { background: #1f6feb22; border-color: #1f6feb55; }

.fav-star {
  appearance: none;
  background: none;
  border: none;
  color: #484f58;
  font-size: 0.95rem;
  line-height: 1;
  padding: 2px 4px;
  cursor: pointer;
}

.fav-star:hover { color: #e1e4e8; }

.fav-star.on { color: #e3b341; }

.type-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #8b949e;
  font-size: 0.68rem;
  white-space: nowrap;
}

.type-icon {
  font-size: 0.72rem;
  line-height: 1;
}

/* Per-engine accent: tinted pill so the kind is visible at a glance */
.type-badge.type-llama {
  background: #23863622;
  border-color: #3fb95055;
  color: #3fb950;
}

.type-badge.type-audio {
  background: #8957e522;
  border-color: #bc8cff55;
  color: #bc8cff;
}

.type-badge.type-strata {
  background: #9e6a0322;
  border-color: #d2992255;
  color: #d29922;
}

.type-badge.type-other {
  background: #1f6feb22;
  border-color: #58a6ff55;
  color: #58a6ff;
}
.config-item.drop-after { border-bottom-color: #58a6ff; box-shadow: inset 0 -2px 0 #58a6ff; }

.drag-handle {
  appearance: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  background: #0d1117;
  color: #8b949e;
  font-size: 0.7rem;
  line-height: 1;
  padding: 3px 5px;
  cursor: grab;
  flex-shrink: 0;
}

.drag-handle:hover { border-color: #58a6ff; color: #e1e4e8; }

.config-alias {
  font-size: 0.82rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.config-speeds {
  font-size: 0.68rem;
  color: #3fb950;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-notes {
  font-size: 0.72rem;
  color: #8b949e;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
