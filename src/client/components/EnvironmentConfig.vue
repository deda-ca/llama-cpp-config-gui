<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import Dialog from './ui/Dialog.vue';
import type { EngineDefinition, EngineKind } from '../types';
import { ENGINE_KIND_LABELS } from '../types';

interface EnvConfig {
  modelsDir: string;
  routerIniPath: string;
  host: string;
  port: number;
  apiKey: string;
}

const emit = defineEmits(['saved', 'close']);

const local = ref<EnvConfig>({
  modelsDir: '',
  routerIniPath: '',
  host: '127.0.0.1',
  port: 8080,
  apiKey: '',
});

// Engine builds (definitions): build folder + env vars, reusable across engine
// instances. Edited as a list here (todo #21 Phase 2) — the single legacy
// llamaCppPath/envVars in settings.json is no longer surfaced.
interface VersionInfo {
  version: string | null;
  build: string | null;
  commit: string | null;
  backend: string | null;
  note?: string;
}
interface DefRow {
  /** null while a new row has not been persisted yet */
  id: string | null;
  name: string;
  kind: EngineKind;
  buildPath: string;
  envRows: { key: string; value: string }[];
  checking: boolean;
  valid: boolean | null;
  info: VersionInfo | null;
}
const defs = ref<DefRow[]>([]);
// Definitions removed since the last save — deleted through the API on Save
const pendingDefDeletes = ref<string[]>([]);

const saving = ref(false);
const savedFlash = ref(false);
const formError = ref('');

// Dirty tracking: compare the current form against a snapshot of the last
// loaded/saved state. A deep watch fires on nextTick (after initial load), so a
// simple "loaded" flag would misfire — comparing values is reliable here.
const dirty = ref(false);
let snapshot = '';
function currentState() {
  return JSON.stringify({
    form: local.value,
    defs: defs.value.map((d) => ({ id: d.id, name: d.name, kind: d.kind, buildPath: d.buildPath, envRows: d.envRows })),
    deleted: pendingDefDeletes.value,
  });
}
function takeSnapshot() {
  snapshot = currentState();
}
watch([local, defs, pendingDefDeletes], () => {
  dirty.value = currentState() !== snapshot;
}, { deep: true });

// Validate a persisted definition through its own endpoint (probes the saved
// folder with the right kind); unsaved rows use the generic path probe.
async function validateDef(def: DefRow) {
  const url = def.id
    ? `/api/engines/definitions/${def.id}/version`
    : null;
  if (!url) {
    const p = def.buildPath.trim();
    if (!p) {
      def.info = null;
      def.valid = false;
      return;
    }
    def.checking = true;
    try {
      const res = await fetch('/api/version/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p, kind: def.kind }),
      });
      if (res.ok) {
        const info = await res.json();
        def.info = info;
        def.valid = !!info.valid;
      } else {
        def.info = null;
        def.valid = false;
      }
    } catch {
      def.info = null;
      def.valid = false;
    } finally {
      def.checking = false;
    }
    return;
  }
  def.checking = true;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const info = await res.json();
      def.info = info;
      def.valid = !!info.valid;
    } else {
      def.info = null;
      def.valid = false;
    }
  } catch {
    def.info = null;
    def.valid = false;
  } finally {
    def.checking = false;
  }
}

onMounted(async () => {
  try {
    const [cfgRes, engRes] = await Promise.all([fetch('/api/config'), fetch('/api/engines')]);
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      local.value = {
        modelsDir: cfg.modelsDir || '',
        routerIniPath: cfg.routerIniPath || '',
        host: cfg.host || '127.0.0.1',
        port: cfg.port ?? 8080,
        apiKey: cfg.apiKey || '',
      };
    }
    if (engRes.ok) {
      const data = await engRes.json();
      defs.value = ((data.definitions || []) as EngineDefinition[]).map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        buildPath: d.buildPath,
        envRows: Object.entries(d.envVars).map(([key, value]) => ({ key, value })),
        checking: false,
        valid: null,
        info: null,
      }));
    }
  } catch (e) {
    console.error('Failed to load environment config:', e);
  }
  takeSnapshot();
  // Validate saved llama.cpp builds on open so the version badges are accurate.
  for (const d of defs.value) {
    if (d.id && d.kind === 'llamacpp' && d.buildPath) validateDef(d);
  }
});

function addDef() {
  defs.value.push({
    id: null,
    name: '',
    kind: 'llamacpp',
    buildPath: '',
    envRows: [],
    checking: false,
    valid: null,
    info: null,
  });
}

function removeDef(idx: number) {
  const def = defs.value[idx];
  if (def.id && !confirm(`Remove build "${def.name}"? Engine instances using it must be moved or deleted first.`)) return;
  defs.value.splice(idx, 1);
  // Persisted rows are deleted through the API on Save; unsaved rows just vanish
  if (def.id) pendingDefDeletes.value.push(def.id);
}

function addDefEnv(def: DefRow) {
  def.envRows.push({ key: '', value: '' });
}

function removeDefEnv(def: DefRow, idx: number) {
  def.envRows.splice(idx, 1);
}

async function save() {
  saving.value = true;
  formError.value = '';
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelsDir: local.value.modelsDir,
        routerIniPath: local.value.routerIniPath,
        host: local.value.host,
        port: Number(local.value.port) || 8080,
        apiKey: local.value.apiKey,
      }),
    });
    if (!res.ok) {
      formError.value = (await res.json().catch(() => ({}))).error || `Config save failed (${res.status})`;
      return;
    }

    // Create/update each definition through the engines API
    for (const def of defs.value) {
      const envVars: Record<string, string> = {};
      for (const row of def.envRows) {
        if (row.key.trim()) envVars[row.key.trim()] = row.value;
      }
      const body = {
        name: def.name.trim() || def.id || 'build',
        kind: def.kind,
        buildPath: def.buildPath.trim(),
        envVars,
      };
      const dRes = await fetch(def.id ? `/api/engines/definitions/${def.id}` : '/api/engines/definitions', {
        method: def.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!dRes.ok) {
        formError.value = (await dRes.json().catch(() => ({}))).error || `Build save failed (${dRes.status})`;
        return;
      }
      def.id = (await dRes.json()).id;
    }

    // Definitions removed since the last save
    for (const id of [...pendingDefDeletes.value]) {
      const dRes = await fetch(`/api/engines/definitions/${id}`, { method: 'DELETE' });
      if (!dRes.ok) {
        formError.value = (await dRes.json().catch(() => ({}))).error || `Build delete failed (${dRes.status})`;
        return;
      }
      pendingDefDeletes.value.splice(pendingDefDeletes.value.indexOf(id), 1);
    }

    takeSnapshot();
    dirty.value = false;
    savedFlash.value = true;
    setTimeout(() => (savedFlash.value = false), 1500);
    // Re-validate the (possibly edited) build folders and refresh the badges.
    for (const d of defs.value) {
      if (d.kind === 'llamacpp' && d.buildPath) validateDef(d);
    }
    emit('saved');
    emit('close');
  } catch (e) {
    formError.value = String(e);
  } finally {
    saving.value = false;
  }
}

// Cancel: close immediately when there are no unsaved changes, otherwise confirm.
function requestClose() {
  if (dirty.value && !confirm('Discard unsaved environment changes?')) return;
  emit('close');
}
</script>

<template>
  <Dialog title="Environment" @close="requestClose">
  <div class="env-config">
    <div v-if="formError" class="form-error">{{ formError }}</div>

    <div class="field">
      <label>Models Folder</label>
      <input v-model="local.modelsDir" type="text" placeholder="/path/to/models" />
      <small>Root folder with your <code>.gguf</code> model files</small>
    </div>

    <div class="field">
      <label>router.ini Path</label>
      <input v-model="local.routerIniPath" type="text" placeholder="/path/to/router.ini" />
      <small>Existing router file for import/export</small>
    </div>

    <div class="field-row">
      <div class="field">
        <label>Host</label>
        <input v-model="local.host" type="text" placeholder="127.0.0.1" />
        <small>Default interface for new engine instances (<code>--host</code>)</small>
      </div>
      <div class="field field-port">
        <label>Port</label>
        <input v-model.number="local.port" type="number" min="1" max="65535" />
        <small>Default port (<code>--port</code>)</small>
      </div>
    </div>

    <div class="field">
      <label>API Key</label>
      <input v-model="local.apiKey" type="password" placeholder="(optional) — sent as --api-key" autocomplete="off" />
      <small>Requires clients to send this key; leave empty for no auth</small>
    </div>

    <!-- Engine builds (definitions): build folder + env, reusable across instances -->
    <div class="field">
      <label>Engine Builds</label>
      <small>Build folders and their environment variables. Engine instances pick one of these in the Engines tab.</small>
      <div v-for="(def, idx) in defs" :key="def.id ?? `new-${idx}`" class="def-card">
        <div class="def-head">
          <input v-model="def.name" type="text" placeholder="build name" class="def-name" />
          <select v-model="def.kind" class="def-kind">
            <option v-for="(label, k) in ENGINE_KIND_LABELS" :key="k" :value="k">{{ label }}</option>
          </select>
          <button class="remove-btn" @click="removeDef(idx)" title="Remove build">&times;</button>
        </div>
        <div class="path-row">
          <input v-model="def.buildPath" type="text" placeholder="/path/to/build/bin" class="def-path" />
          <button
            class="btn refresh-btn"
            :disabled="def.checking"
            @click="validateDef(def)"
            title="Validate this build folder"
          >{{ def.checking ? '…' : '↻ Validate' }}</button>
        </div>
        <div v-if="def.kind === 'llamacpp' && def.valid === false" class="version-info version-invalid">
          Invalid path — <code>llama-server</code> not found here.
        </div>
        <div v-else-if="def.kind === 'llamacpp' && def.info && (def.info.version || def.info.build)" class="version-info">
          llama.cpp {{ def.info.version || '?' }} (build {{ def.info.build || '?' }})<template v-if="def.info.backend"> · {{ def.info.backend }}</template><template v-if="def.info.commit"> · {{ def.info.commit.slice(0, 7) }}</template>
        </div>
        <div v-else-if="def.kind !== 'llamacpp' && def.valid === true" class="version-info">
          Folder exists. No version probe for this kind yet.
        </div>
        <div class="def-env">
          <div v-for="(row, eidx) in def.envRows" :key="eidx" class="env-row">
            <input v-model="row.key" type="text" placeholder="VAR_NAME" class="env-key" />
            <input v-model="row.value" type="text" placeholder="value" class="env-value" />
            <button class="remove-btn" @click="removeDefEnv(def, eidx)" title="Remove">&times;</button>
          </div>
          <button class="add-env-btn" @click="addDefEnv(def)">+ Add Variable</button>
        </div>
      </div>
      <button class="add-env-btn" @click="addDef">+ Add Build</button>
      <small>e.g. <code>CUDA_VISIBLE_DEVICES=0,2</code>, <code>LD_LIBRARY_PATH=/opt/cuda/lib64</code></small>
    </div>

  </div>
  <template #footer>
    <button class="btn" @click="requestClose">Cancel</button>
    <button class="btn btn-primary" :disabled="saving" @click="save">
      {{ savedFlash ? '✓ Saved' : saving ? 'Saving…' : 'Save Environment' }}
    </button>
  </template>
  </Dialog>
</template>

<style scoped>
.env-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-error {
  color: #f85149;
  background: #da363315;
  border: 1px solid #da363333;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.78rem;
}

.def-card {
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #0d111766;
}

.def-head {
  display: flex;
  gap: 8px;
  align-items: center;
}

.def-name {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 10px;
  color: #e1e4e8;
  font-size: 0.82rem;
  font-family: inherit;
}

.def-name:focus { outline: none; border-color: #58a6ff; }

.def-kind {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: inherit;
  width: 170px;
  flex-shrink: 0;
}

.def-kind:focus { outline: none; border-color: #58a6ff; }

.def-path {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 7px 10px;
  color: #e1e4e8;
  font-size: 0.82rem;
  font-family: 'Cascadia Code', monospace;
}

.def-path:focus { outline: none; border-color: #58a6ff; }

.def-env {
  display: flex;
  flex-direction: column;
}

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

.field small {
  font-size: 0.65rem;
  color: #484f58;
}

.field code {
  font-family: 'Cascadia Code', monospace;
  color: #79c0ff;
}

.field input {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 7px 10px;
  color: #e1e4e8;
  font-size: 0.82rem;
  font-family: inherit;
}

.field input:focus { outline: none; border-color: #58a6ff; }

.version-info {
  margin-top: 4px;
  font-size: 0.72rem;
  color: #79c0ff;
  background: #388bfd15;
  border: 1px solid #388bfd33;
  border-radius: 6px;
  padding: 5px 10px;
}

.version-invalid {
  color: #f85149;
  background: #da363315;
  border-color: #da363333;
}

.path-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.path-row input {
  flex: 1;
}

.refresh-btn {
  white-space: nowrap;
  padding: 7px 12px;
}

.field-row {
  display: flex;
  gap: 12px;
}

.field-port {
  width: 140px;
  flex-shrink: 0;
}

.env-row {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
}

.env-key {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: 'Cascadia Code', monospace;
  width: 45%;
}

.env-value {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: 'Cascadia Code', monospace;
  flex: 1;
}

.env-key:focus, .env-value:focus { outline: none; border-color: #58a6ff; }

.remove-btn {
  background: none;
  border: none;
  color: #484f58;
  font-size: 1rem;
  cursor: pointer;
  padding: 0 4px;
}

.remove-btn:hover { color: #f85149; }

.add-env-btn {
  background: none;
  border: 1px dashed #30363d;
  border-radius: 4px;
  padding: 5px;
  color: #58a6ff;
  font-size: 0.75rem;
  cursor: pointer;
  align-self: flex-start;
}

.add-env-btn:hover { border-color: #58a6ff; background: #1f6feb11; }

.btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #e1e4e8;
  font-size: 0.78rem;
  cursor: pointer;
}

.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary { background: #238636; border-color: #238636; color: white; }
.btn-primary:hover:not(:disabled) { background: #2ea043; }
</style>
