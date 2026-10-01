<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import Dialog from './ui/Dialog.vue';

interface EnvConfig {
  llamaCppPath: string;
  modelsDir: string;
  routerIniPath: string;
  host: string;
  port: number;
  apiKey: string;
  envVars: Record<string, string>;
}

const emit = defineEmits(['saved', 'close']);

const local = ref<EnvConfig>({
  llamaCppPath: '',
  modelsDir: '',
  routerIniPath: '',
  host: '127.0.0.1',
  port: 8080,
  apiKey: '',
  envVars: {},
});

// Env var rows for easy editing
interface EnvRow { key: string; value: string }
const envRows = ref<EnvRow[]>([]);

const saving = ref(false);
const savedFlash = ref(false);

// Dirty tracking: compare the current form against a snapshot of the last
// loaded/saved state. A deep watch fires on nextTick (after initial load), so a
// simple "loaded" flag would misfire — comparing values is reliable here.
const dirty = ref(false);
let snapshot = '';
function currentState() {
  return JSON.stringify({ form: local.value, rows: envRows.value });
}
function takeSnapshot() {
  snapshot = currentState();
}
watch([local, envRows], () => {
  dirty.value = currentState() !== snapshot;
}, { deep: true });

// llama.cpp version info (read-only, shown below the build folder field)
interface LlamaVersionInfo {
  version: string | null;
  build: string | null;
  commit: string | null;
  compiler: string | null;
  backend: string | null;
}
const llamaVersion = ref<LlamaVersionInfo | null>(null);
const checkingPath = ref(false);
const pathValid = ref<boolean | null>(null); // null = not yet checked

// Validate the (possibly edited) build folder and refresh the version display.
async function checkBuildPath() {
  const p = local.value.llamaCppPath.trim();
  if (!p) {
    llamaVersion.value = null;
    pathValid.value = false;
    return;
  }
  checkingPath.value = true;
  try {
    const res = await fetch('/api/version/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    if (res.ok) {
      const info = await res.json();
      llamaVersion.value = info;
      pathValid.value = !!info.valid;
    } else {
      llamaVersion.value = null;
      pathValid.value = false;
    }
  } catch {
    llamaVersion.value = null;
    pathValid.value = false;
  } finally {
    checkingPath.value = false;
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      local.value = {
        llamaCppPath: cfg.llamaCppPath || '',
        modelsDir: cfg.modelsDir || '',
        routerIniPath: cfg.routerIniPath || '',
        host: cfg.host || '127.0.0.1',
        port: cfg.port ?? 8080,
        apiKey: cfg.apiKey || '',
        envVars: cfg.envVars || {},
      };
      envRows.value = Object.entries(local.value.envVars).map(([key, value]) => ({ key, value }));
    }
  } catch (e) {
    console.error('Failed to load environment config:', e);
  }
  takeSnapshot();
  // Validate the saved path on open so the version badge is accurate.
  checkBuildPath();
});

function addEnvRow() {
  envRows.value.push({ key: '', value: '' });
}

function removeEnvRow(idx: number) {
  envRows.value.splice(idx, 1);
}

async function save() {
  saving.value = true;
  try {
    // Build envVars object from rows (skip empty keys)
    const envVars: Record<string, string> = {};
    for (const row of envRows.value) {
      if (row.key.trim()) envVars[row.key.trim()] = row.value;
    }

    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llamaCppPath: local.value.llamaCppPath,
        modelsDir: local.value.modelsDir,
        routerIniPath: local.value.routerIniPath,
        host: local.value.host,
        port: Number(local.value.port) || 8080,
        apiKey: local.value.apiKey,
        envVars,
      }),
    });
    if (res.ok) {
      takeSnapshot();
      dirty.value = false;
      savedFlash.value = true;
      setTimeout(() => (savedFlash.value = false), 1500);
      // Re-validate the (possibly new) build folder and refresh the version.
      checkBuildPath();
      emit('saved');
      emit('close');
    }
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
    <div class="field">
      <label>llama.cpp Build Folder</label>
      <div class="path-row">
        <input v-model="local.llamaCppPath" type="text" placeholder="/path/to/llama.cpp/build/bin" />
        <button
          class="btn btn-sm refresh-btn"
          :disabled="checkingPath"
          @click="checkBuildPath"
          title="Validate this path and fetch the latest version"
        >{{ checkingPath ? '…' : '↻ Refresh' }}</button>
      </div>
      <small>Folder containing <code>llama-server</code> / <code>llama-cli</code></small>
      <div v-if="pathValid === false" class="version-info version-invalid">
        Invalid path — <code>llama-server</code> not found here.
      </div>
      <div v-else-if="llamaVersion && (llamaVersion.version || llamaVersion.build)" class="version-info">
        llama.cpp {{ llamaVersion.version || '?' }} (build {{ llamaVersion.build || '?' }})<template v-if="llamaVersion.backend"> · {{ llamaVersion.backend }}</template><template v-if="llamaVersion.commit"> · {{ llamaVersion.commit.slice(0, 7) }}</template>
      </div>
    </div>

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
        <small>Interface llama-server binds to (<code>--host</code>)</small>
      </div>
      <div class="field field-port">
        <label>Port</label>
        <input v-model.number="local.port" type="number" min="1" max="65535" />
        <small>Server port (<code>--port</code>)</small>
      </div>
    </div>

    <div class="field">
      <label>API Key</label>
      <input v-model="local.apiKey" type="password" placeholder="(optional) — sent as --api-key" autocomplete="off" />
      <small>Requires clients to send this key; leave empty for no auth</small>
    </div>

    <div class="field">
      <label>Environment Variables</label>
      <div v-for="(row, idx) in envRows" :key="idx" class="env-row">
        <input v-model="row.key" type="text" placeholder="VAR_NAME" class="env-key" />
        <input v-model="row.value" type="text" placeholder="value" class="env-value" />
        <button class="remove-btn" @click="removeEnvRow(idx)" title="Remove">&times;</button>
      </div>
      <button class="add-env-btn" @click="addEnvRow">+ Add Variable</button>
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
