<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import EngineEditor from './EngineEditor.vue';
import StrataEditor from './StrataEditor.vue';
import AudioEditor from './AudioEditor.vue';
import type { EngineDefinition, EngineInstance, EngineKind, EngineParam } from '../types';
import { ENGINE_KIND_LABELS } from '../types';

interface ModelOption {
  id: string;
  alias: string;
}

const props = defineProps<{
  /** Live instance statuses from SSE, keyed by instance id */
  statuses?: Record<string, string>;
}>();

const emit = defineEmits<{
  /** Instance status changed (launch/stop) — parent refreshes the header badge */
  'statuses-changed': [];
}>();

const definitions = ref<EngineDefinition[]>([]);
const instances = ref<EngineInstance[]>([]);
const models = ref<ModelOption[]>([]);
const error = ref('');
const busyId = ref<string | null>(null);

// Inline drawer expansion
const expandedId = ref<string | null>(null);
// Editor dialog (null = closed). `isNew` marks a draft the server has not seen
// yet — the engine is only created when the dialog's Save button is used.
const editingInstance = ref<EngineInstance | null>(null);
const isNewInstance = ref(false);

// The kind to create, chosen from the toolbar dropdown before the dialog opens.
const newKind = ref<EngineKind>('llamacpp');
// Only kinds with a real driver get offered; the rest stay in the generic
// editor's kind list for advanced use.
const creatableKinds: EngineKind[] = ['llamacpp', 'strata', 'audio'];

const statusOf = (i: EngineInstance) => props.statuses?.[i.id] ?? i.status ?? 'stopped';
const isLive = (i: EngineInstance) => {
  const s = statusOf(i);
  return s === 'running' || s === 'starting';
};

const kindOf = (i: EngineInstance): EngineKind =>
  i.kind || definitionOf(i)?.kind || 'custom';

// --port is a plain parameter now; the list column reads it back out.
// Disabled rows never reach the command line, so they don't count here either.
// strata keeps its port in the separate server-arg list instead, and audio in
// its `port` config-key row.
const portOf = (i: EngineInstance) => {
  const p = i.params.find((x) => (x.key === '--port' || x.key === '-p') && !x.disabled)
    ?? i.strata?.serverArgs.find((x) => x.key === '--port' && !x.disabled)
    ?? i.audio?.serverArgs.find((x) => x.key === 'port' && !x.disabled);
  return p?.value ? `:${p.value}` : '';
};

async function loadData() {
  try {
    const [engRes, modelsRes] = await Promise.all([
      fetch('/api/engines'),
      fetch('/api/models'),
    ]);
    if (engRes.ok) {
      const data = await engRes.json();
      definitions.value = data.definitions || [];
      instances.value = data.instances || [];
    }
    if (modelsRes.ok) {
      const data = await modelsRes.json();
      models.value = (data.configs || []).map((c: any) => ({ id: c.id, alias: c.alias }));
    }
  } catch (e) {
    error.value = String(e);
  }
}

async function postJson(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${url} failed (${res.status})`);
  return data;
}

async function newEngine() {
  error.value = '';
  try {
    // Ask the server for a blank draft of the chosen kind (template params + a
    // free port). Nothing is stored yet: the editor's Save creates the engine.
    const res = await fetch(`/api/engines/instances/draft?kind=${newKind.value}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.value = data.error || `Could not start a new engine (${res.status})`;
      return;
    }
    editingInstance.value = data;
    isNewInstance.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function editInstance(inst: EngineInstance) {
  editingInstance.value = inst;
  isNewInstance.value = false;
}

async function launchInstance(id: string) {
  error.value = '';
  busyId.value = id;
  try {
    await postJson(`/api/engines/instances/${id}/launch`, 'POST');
    emit('statuses-changed');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busyId.value = null;
  }
}

async function stopInstance(id: string) {
  busyId.value = id;
  try {
    await postJson(`/api/engines/instances/${id}/stop`, 'POST');
    emit('statuses-changed');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busyId.value = null;
  }
}

async function duplicateInstance(inst: EngineInstance) {
  error.value = '';
  try {
    // --port is a param now: shift the copy's port clear of every instance
    const portKey = (p: EngineParam) => (p.key === '--port' || p.key === '-p' || p.key === 'port') && !p.disabled;
    const taken = new Set(
      instances.value
        .map((i) => Number(
          i.params.find(portKey)?.value
          ?? i.strata?.serverArgs.find(portKey)?.value
          ?? i.audio?.serverArgs.find(portKey)?.value,
        ))
        .filter((n) => Number.isFinite(n)),
    );
    const params = inst.params.map((p) => ({ ...p }));
    const portRow = params.find(portKey);
    const strata = inst.strata
      ? { ...inst.strata, engineArgs: inst.strata.engineArgs.map((p) => ({ ...p })), serverArgs: inst.strata.serverArgs.map((p) => ({ ...p })) }
      : undefined;
    const audio = inst.audio
      ? {
          ...inst.audio,
          envVars: { ...inst.audio.envVars },
          serverArgs: inst.audio.serverArgs.map((p) => ({ ...p })),
          modelConfigIds: [...inst.audio.modelConfigIds],
          extra: { ...inst.audio.extra },
        }
      : undefined;
    const strataPortRow = strata?.serverArgs.find(portKey);
    const audioPortRow = audio?.serverArgs.find(portKey);
    const currentPort = Number(portRow?.value ?? strataPortRow?.value ?? audioPortRow?.value);
    if (portRow || strataPortRow || audioPortRow) {
      let port = Number.isFinite(currentPort) ? currentPort : (inst.kind === 'strata' ? 8095 : 8080);
      while (taken.has(port)) port++;
      if (portRow) portRow.value = String(port);
      if (strataPortRow) strataPortRow.value = String(port);
      if (audioPortRow) audioPortRow.value = String(port);
    }
    const copy = await postJson('/api/engines/instances', 'POST', {
      name: `${inst.name}-copy`,
      kind: inst.kind,
      definitionId: inst.definitionId,
    });
    await postJson(`/api/engines/instances/${copy.id}`, 'PUT', {
      notes: inst.notes,
      binary: inst.binary,
      params,
      routerMode: inst.routerMode,
      modelConfigIds: inst.modelConfigIds,
      modelPath: inst.modelPath ?? '',
      mmproj: inst.mmproj ?? '',
      autoLaunch: false,
      ...(strata ? { strata } : {}),
      ...(audio ? { audio } : {}),
    });
    await loadData();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function deleteInstance(id: string) {
  if (!confirm('Delete this engine instance? Running processes will be stopped.')) return;
  error.value = '';
  try {
    await postJson(`/api/engines/instances/${id}`, 'DELETE');
    instances.value = instances.value.filter((i) => i.id !== id);
    if (expandedId.value === id) expandedId.value = null;
    emit('statuses-changed');
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function onEditorSaved(updated: EngineInstance) {
  // A rename re-derives the instance id (generated files are named from it), so
  // match the row on the id the editor started with, not the one it came back with.
  const previousId = editingInstance.value?.id ?? updated.id;
  const idx = instances.value.findIndex((i) => i.id === previousId || i.id === updated.id);
  if (idx !== -1) instances.value[idx] = { ...instances.value[idx], ...updated };
  else instances.value.push(updated);
  // Definition edits happen inside the editor — refresh the shared list
  fetch('/api/engines')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d) definitions.value = d.definitions || [];
    })
    .catch(() => { /* non-fatal */ });
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

function fmtParams(params: EngineParam[]): string {
  return params
    .filter((p) => p.key)
    .map((p) => (p.value !== undefined && p.value !== '' ? `${p.key} ${p.value}` : p.key))
    .join(' ');
}

function fmtEnv(def: EngineDefinition | undefined): string {
  if (!def) return '';
  return Object.entries(def.envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
}

function definitionOf(inst: EngineInstance): EngineDefinition | undefined {
  return definitions.value.find((d) => d.id === inst.definitionId);
}

// The strata deployment keys (exe, cwd, …) are ordinary server rows now.
function deploymentOf(inst: EngineInstance, key: string): string {
  const row = inst.strata?.serverArgs.find((p) => p.key === key && !p.disabled);
  return row?.value?.trim() ?? '';
}

function modelNames(inst: EngineInstance): string {
  return inst.modelConfigIds
    .map((id) => models.value.find((m) => m.id === id)?.alias ?? id)
    .join(', ');
}

// The audio block keeps its model selection separately from the instance's
// router-mode ids; the drawer shows the same names for it.
function audioModelNames(inst: EngineInstance): string {
  return (inst.audio?.modelConfigIds ?? [])
    .map((id) => models.value.find((m) => m.id === id)?.alias ?? id)
    .join(', ');
}

onMounted(loadData);

// Refresh statuses when any instance's process state changes
let es: EventSource | null = null;
onMounted(() => {
  es = new EventSource('/api/events');
  es.addEventListener('process-status', () => {
    loadData();
  });
});
onUnmounted(() => es?.close());
</script>

<template>
  <div class="engine-list">
    <div class="toolbar">
      <h2 class="section-title">Engines</h2>
      <div class="toolbar-actions">
        <select v-model="newKind" class="kind-select" title="Engine type to create">
          <option v-for="k in creatableKinds" :key="k" :value="k">{{ ENGINE_KIND_LABELS[k] }}</option>
        </select>
        <button class="btn btn-sm btn-primary" @click="newEngine">+ New engine</button>
      </div>
    </div>

    <div v-if="error" class="engine-error">{{ error }}</div>

    <div v-if="instances.length === 0" class="empty-hint">
      No engine instances yet. Pick a type and click <strong>+ New engine</strong> to create one.
    </div>

    <div class="engine-items">
      <div v-for="inst in instances" :key="inst.id" class="engine-block">
        <div class="engine-row">
          <button class="expand-btn" @click="toggleExpand(inst.id)" :title="expandedId === inst.id ? 'Collapse' : 'Expand'">
            {{ expandedId === inst.id ? '▾' : '▸' }}
          </button>
          <span class="engine-name">{{ inst.name }}</span>
          <span class="status-dot" :class="statusOf(inst)"></span>
          <span class="engine-status">{{ statusOf(inst) }}</span>
          <span class="engine-kind">{{ ENGINE_KIND_LABELS[kindOf(inst)] }}</span>
          <span class="engine-port">{{ portOf(inst) }}</span>
          <div class="engine-actions">
            <button
              v-if="!isLive(inst)"
              class="row-btn launch"
              :disabled="busyId === inst.id"
              @click="launchInstance(inst.id)"
              title="Start this engine"
            >▶</button>
            <button
              v-else
              class="row-btn stop"
              :disabled="busyId === inst.id"
              @click="stopInstance(inst.id)"
              title="Stop this engine"
            >⏹</button>
            <button class="row-btn" @click="editInstance(inst)" title="Configure">⚙</button>
            <button class="row-btn" @click="duplicateInstance(inst)" title="Duplicate">⧉</button>
            <button class="row-btn danger" @click="deleteInstance(inst.id)" title="Delete">✕</button>
          </div>
        </div>

        <!-- Inline drawer: read-only summary -->
        <div v-if="expandedId === inst.id" class="engine-drawer">
          <div v-if="definitionOf(inst)" class="drawer-section">
            <span class="drawer-label">Build</span>
            <code>{{ definitionOf(inst)?.buildPath || '(not set)' }}/{{ inst.binary }}</code>
          </div>
          <div v-if="definitionOf(inst) && Object.keys(definitionOf(inst)?.envVars || {}).length" class="drawer-section">
            <span class="drawer-label">Env</span>
            <code>{{ fmtEnv(definitionOf(inst)) }}</code>
          </div>
          <div v-if="inst.strata" class="drawer-section">
            <span class="drawer-label">Strata</span>
            <code>{{ deploymentOf(inst, 'exe') || '(no engine exe)' }} · cwd {{ deploymentOf(inst, 'cwd') || '(not set)' }}</code>
          </div>
          <div v-if="inst.params.length" class="drawer-section">
            <span class="drawer-label">Params</span>
            <code>{{ fmtParams(inst.params) }}</code>
          </div>
          <div v-if="inst.strata" class="drawer-section">
            <span class="drawer-label">Server</span>
            <code>{{ fmtParams(inst.strata.serverArgs) || '(defaults)' }}</code>
          </div>
          <div v-if="inst.audio" class="drawer-section">
            <span class="drawer-label">Audio</span>
            <code>{{ inst.binary || '(no executable)' }}</code>
          </div>
          <div v-if="inst.audio" class="drawer-section">
            <span class="drawer-label">Server</span>
            <code>{{ fmtParams(inst.audio.serverArgs) || '(defaults)' }}</code>
          </div>
          <div v-if="inst.routerMode" class="drawer-section">
            <span class="drawer-label">Router</span>
            <code>{{ inst.modelConfigIds.length }} model(s): {{ modelNames(inst) || '(none selected)' }}</code>
          </div>
          <div v-else-if="inst.audio" class="drawer-section">
            <span class="drawer-label">Models</span>
            <code>{{ inst.audio.modelConfigIds.length }} model(s): {{ audioModelNames(inst) || '(none selected)' }}</code>
          </div>
          <div v-else-if="inst.modelPath" class="drawer-section">
            <span class="drawer-label">Model</span>
            <code>{{ inst.modelPath }}</code>
          </div>
        </div>
      </div>
    </div>

    <AudioEditor
      v-if="editingInstance && kindOf(editingInstance) === 'audio'"
      :instance="editingInstance"
      :is-new="isNewInstance"
      @saved="onEditorSaved"
      @close="editingInstance = null"
    />
    <StrataEditor
      v-else-if="editingInstance && kindOf(editingInstance) === 'strata'"
      :instance="editingInstance"
      :is-new="isNewInstance"
      @saved="onEditorSaved"
      @close="editingInstance = null"
    />
    <EngineEditor
      v-else-if="editingInstance"
      :instance="editingInstance"
      :definitions="definitions"
      :is-new="isNewInstance"
      @saved="onEditorSaved"
      @close="editingInstance = null"
    />
  </div>
</template>

<style scoped>
.engine-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 600;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.kind-select {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 5px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
}

.kind-select:focus {
  outline: none;
  border-color: #58a6ff;
}

.engine-error {
  color: #f85149;
  background: #da363315;
  border: 1px solid #da363333;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.78rem;
}

.empty-hint {
  color: #8b949e;
  font-size: 0.82rem;
  padding: 12px 0;
}

.empty-hint strong {
  color: #58a6ff;
}

.engine-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.engine-block {
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #161b22;
}

.engine-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
}

.expand-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 2px 4px;
  width: 20px;
}

.expand-btn:hover { color: #e1e4e8; }

.engine-name {
  font-size: 0.85rem;
  font-weight: 600;
  min-width: 120px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #484f58;
  flex-shrink: 0;
}

.status-dot.running { background: #3fb950; }
.status-dot.starting { background: #d29922; }
.status-dot.error { background: #f85149; }
.status-dot.exited { background: #8b949e; }

.engine-status {
  font-size: 0.75rem;
  color: #8b949e;
  width: 62px;
}

.engine-kind {
  font-size: 0.72rem;
  color: #58a6ff;
  background: #388bfd15;
  border: 1px solid #388bfd33;
  border-radius: 10px;
  padding: 2px 8px;
}

.engine-port {
  font-size: 0.75rem;
  color: #8b949e;
  font-family: 'Cascadia Code', monospace;
}

.engine-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.row-btn {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #e1e4e8;
  font-size: 0.75rem;
  cursor: pointer;
  padding: 4px 8px;
  line-height: 1;
}

.row-btn:hover { border-color: #8b949e; }
.row-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.row-btn.launch { color: #3fb950; }
.row-btn.stop { color: #f85149; }
.row-btn.danger:hover { color: #f85149; border-color: #f85149; }

.engine-drawer {
  border-top: 1px solid #21262d;
  padding: 8px 12px 10px 34px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.drawer-section {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 0.75rem;
}

.drawer-label {
  color: #484f58;
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.65rem;
  letter-spacing: 0.04em;
  width: 52px;
  flex-shrink: 0;
}

.drawer-section code {
  font-family: 'Cascadia Code', monospace;
  color: #79c0ff;
  word-break: break-all;
}

.btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #e1e4e8;
  font-size: 0.78rem;
  cursor: pointer;
}

.btn-sm { padding: 4px 10px; font-size: 0.75rem; }
.btn-primary { background: #238636; border-color: #238636; color: white; }
.btn-primary:hover { background: #2ea043; }
</style>
