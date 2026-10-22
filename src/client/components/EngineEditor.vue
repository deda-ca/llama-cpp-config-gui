<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import Dialog from './ui/Dialog.vue';
import type {
  EngineDefinition,
  EngineInstance,
  EngineKind,
  EngineParam,
} from '../types';
import { ENGINE_KIND_LABELS } from '../types';

interface ModelOption {
  id: string;
  alias: string;
}

const props = defineProps<{
  instance: EngineInstance;
  definitions: EngineDefinition[];
  models: ModelOption[];
  /** Pre-selected definition id for a brand-new instance (kind dropdown helper) */
  isNew?: boolean;
}>();

const emit = defineEmits<{
  saved: [instance: EngineInstance];
  close: [];
}>();

// --- Form state (instance) ---
const form = ref({
  name: props.instance.name,
  definitionId: props.instance.definitionId,
  binary: props.instance.binary,
  host: props.instance.host,
  port: props.instance.port,
  apiKey: props.instance.apiKey,
  routerMode: props.instance.routerMode,
  modelPath: props.instance.modelPath ?? '',
  mmproj: props.instance.mmproj ?? '',
});
const modelIds = ref<string[]>([...props.instance.modelConfigIds]);
const params = ref<EngineParam[]>(
  props.instance.params.map((p) => ({ key: p.key, value: p.value })),
);

// --- Definition editing (build folder + env live on the definition) ---
const def = ref<EngineDefinition | null>(
  props.definitions.find((d) => d.id === props.instance.definitionId) ?? null,
);
const defName = ref(def.value?.name ?? '');
const defKind = ref<EngineKind>(def.value?.kind ?? 'llamacpp');
const buildPath = ref(def.value?.buildPath ?? '');
interface EnvRow { key: string; value: string }
const envRows = ref<EnvRow[]>(
  Object.entries(def.value?.envVars ?? {}).map(([key, value]) => ({ key, value })),
);

// Switching to an existing definition pulls its values into the edit fields;
// choosing "+ New build definition" blanks them for a fresh entry.
function onDefinitionChange() {
  const d = props.definitions.find((x) => x.id === form.value.definitionId);
  if (d) {
    def.value = d;
    defName.value = d.name;
    defKind.value = d.kind;
    buildPath.value = d.buildPath;
    envRows.value = Object.entries(d.envVars).map(([key, value]) => ({ key, value }));
  } else {
    def.value = null;
    defName.value = '';
    buildPath.value = '';
    envRows.value = [];
    versionInfo.value = null;
    pathValid.value = null;
  }
}

const kindIsLlamaCpp = computed(() => defKind.value === 'llamacpp');
const selectedDefIsNew = computed(() => !props.definitions.some((d) => d.id === form.value.definitionId));

// --- Build path validation (llama.cpp only — the probe runs llama-server) ---
interface VersionInfo {
  version: string | null;
  build: string | null;
  commit: string | null;
  backend: string | null;
  valid?: boolean;
}
const versionInfo = ref<VersionInfo | null>(null);
const checkingPath = ref(false);
const pathValid = ref<boolean | null>(null);

async function checkBuildPath() {
  const p = buildPath.value.trim();
  if (!p) {
    versionInfo.value = null;
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
      versionInfo.value = info;
      pathValid.value = !!info.valid;
    } else {
      versionInfo.value = null;
      pathValid.value = false;
    }
  } catch {
    versionInfo.value = null;
    pathValid.value = false;
  } finally {
    checkingPath.value = false;
  }
}

// Validate the saved path on open so the badge is accurate for llama.cpp
onMounted(() => {
  if (kindIsLlamaCpp.value && buildPath.value) checkBuildPath();
});

// --- Env rows ---
function addEnvRow() {
  envRows.value.push({ key: '', value: '' });
}
function removeEnvRow(idx: number) {
  envRows.value.splice(idx, 1);
}

// --- Param rows (key-only = flag, key+value = option) ---
function addParamRow() {
  params.value.push({ key: '', value: '' });
}
function removeParamRow(idx: number) {
  params.value.splice(idx, 1);
}

// Bulk "paste args" mode: one text blob converted to rows (quote-aware server-side
// would be nicer, but the client keeps it simple: whitespace split honoring quotes).
const argsText = ref('');
const showArgsPaste = ref(false);
function splitArgsLocal(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function applyArgsPaste() {
  const tokens = splitArgsLocal(argsText.value);
  const rows: EngineParam[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-')) {
      const next = tokens[i + 1];
      if (next && !next.startsWith('-')) {
        rows.push({ key: tok, value: next });
        i++;
      } else {
        rows.push({ key: tok });
      }
    } else {
      rows.push({ key: tok });
    }
  }
  params.value = rows;
  showArgsPaste.value = false;
  argsText.value = '';
}

const previewArgs = computed(() =>
  params.value
    .filter((p) => p.key.trim())
    .map((p) => (p.value !== undefined && p.value !== '' ? `${p.key} ${p.value}` : p.key))
    .join(' '),
);

// --- Dirty tracking (same snapshot pattern as EnvironmentConfig) ---
const dirty = ref(false);
let snapshot = '';
function currentState() {
  return JSON.stringify({
    form: form.value,
    modelIds: modelIds.value,
    params: params.value,
    defName: defName.value,
    defKind: defKind.value,
    buildPath: buildPath.value,
    envRows: envRows.value,
  });
}
watch(
  [form, modelIds, params, defName, defKind, buildPath, envRows],
  () => {
    dirty.value = currentState() !== snapshot;
  },
  { deep: true },
);

// --- Save ---
const saving = ref(false);
const error = ref('');

function toggleModel(id: string) {
  const next = new Set(modelIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  modelIds.value = [...next];
}

async function save() {
  saving.value = true;
  error.value = '';
  try {
    // 1. Persist the definition (build folder + env live there)
    const envVars: Record<string, string> = {};
    for (const row of envRows.value) {
      if (row.key.trim()) envVars[row.key.trim()] = row.value;
    }
    const defBody = {
      name: defName.value.trim() || def.value?.name || 'Engine',
      kind: defKind.value,
      buildPath: buildPath.value.trim(),
      envVars,
    };
    let defId = form.value.definitionId;
    if (def.value && !selectedDefIsNew.value) {
      const res = await fetch(`/api/engines/definitions/${def.value.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defBody),
      });
      if (!res.ok) {
        error.value = (await res.json().catch(() => ({}))).error || `Definition save failed (${res.status})`;
        return;
      }
      defId = def.value.id;
    } else {
      const res = await fetch('/api/engines/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defBody),
      });
      if (!res.ok) {
        error.value = (await res.json().catch(() => ({}))).error || `Definition create failed (${res.status})`;
        return;
      }
      defId = (await res.json()).id;
    }

    // 2. Persist the instance
    const cleanParams = params.value
      .filter((p) => p.key.trim())
      .map((p) => ({ key: p.key.trim(), ...(p.value !== undefined && p.value !== '' ? { value: p.value } : {}) }));
    const body = {
      ...form.value,
      definitionId: defId,
      port: Number(form.value.port) || 8080,
      params: cleanParams,
      modelConfigIds: modelIds.value,
      modelPath: form.value.modelPath.trim(),
      mmproj: form.value.mmproj.trim(),
    };
    const res = await fetch(`/api/engines/instances/${props.instance.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const updated = await res.json();
      snapshot = currentState();
      dirty.value = false;
      emit('saved', updated);
      emit('close');
    } else {
      error.value = (await res.json().catch(() => ({}))).error || `Save failed (${res.status})`;
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

function requestClose() {
  if (dirty.value && !confirm('Discard unsaved engine changes?')) return;
  emit('close');
}

// Take the baseline snapshot after the initial values are in place
snapshot = currentState();
</script>

<template>
  <Dialog :title="isNew ? 'New Engine' : `Engine: ${instance.name}`" :width="820" @close="requestClose">
    <div class="engine-editor">
      <div v-if="error" class="editor-error">{{ error }}</div>

      <div class="field-row">
        <div class="field">
          <label>Instance Name</label>
          <input v-model="form.name" type="text" placeholder="llama-main" />
        </div>
        <div class="field field-kind">
          <label>Engine Kind</label>
          <select v-model="defKind">
            <option v-for="(label, k) in ENGINE_KIND_LABELS" :key="k" :value="k">{{ label }}</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Build / Definition</label>
        <select v-model="form.definitionId" @change="onDefinitionChange">
          <option v-for="d in definitions" :key="d.id" :value="d.id">{{ d.name }} ({{ ENGINE_KIND_LABELS[d.kind] }})</option>
          <option value="__new__">+ New build definition</option>
        </select>
        <small>Build folder and environment variables are shared by every instance using this definition</small>
      </div>

      <div v-if="selectedDefIsNew" class="def-block">
        <div class="field">
          <label>Definition Name</label>
          <input v-model="defName" type="text" placeholder="llama-cpp-cuda" />
        </div>
      </div>

      <div class="field">
        <label>Build Folder</label>
        <div class="path-row">
          <input v-model="buildPath" type="text" placeholder="/path/to/build/bin" />
          <button
            v-if="kindIsLlamaCpp"
            class="btn refresh-btn"
            :disabled="checkingPath"
            @click="checkBuildPath"
            title="Validate this path and fetch the llama.cpp version"
          >{{ checkingPath ? '…' : '↻ Validate' }}</button>
        </div>
        <small>Folder containing the engine executable</small>
        <div v-if="kindIsLlamaCpp && pathValid === false" class="version-info version-invalid">
          Invalid path — <code>llama-server</code> not found here.
        </div>
        <div v-else-if="kindIsLlamaCpp && versionInfo && (versionInfo.version || versionInfo.build)" class="version-info">
          llama.cpp {{ versionInfo.version || '?' }} (build {{ versionInfo.build || '?' }})<template v-if="versionInfo.backend"> · {{ versionInfo.backend }}</template><template v-if="versionInfo.commit"> · {{ versionInfo.commit.slice(0, 7) }}</template>
        </div>
      </div>

      <div class="field">
        <label>Environment Variables</label>
        <div v-for="(row, idx) in envRows" :key="idx" class="env-row">
          <input v-model="row.key" type="text" placeholder="VAR_NAME" class="env-key" />
          <input v-model="row.value" type="text" placeholder="value" class="env-value" />
          <button class="remove-btn" @click="removeEnvRow(idx)" title="Remove">&times;</button>
        </div>
        <button class="add-env-btn" @click="addEnvRow">+ Add Variable</button>
        <small>e.g. <code>CUDA_VISIBLE_DEVICES=1</code></small>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Executable</label>
          <input v-model="form.binary" type="text" placeholder="llama-server" />
          <small>Name inside the build folder (<code>llama-server</code>, <code>llama-cli</code>, …)</small>
        </div>
        <div class="field">
          <label>Host</label>
          <input v-model="form.host" type="text" placeholder="0.0.0.0" />
        </div>
        <div class="field field-port">
          <label>Port</label>
          <input v-model.number="form.port" type="number" min="1" max="65535" />
        </div>
      </div>

      <div class="field">
        <label>API Key</label>
        <input v-model="form.apiKey" type="password" placeholder="(optional)" autocomplete="off" />
      </div>

      <!-- llama.cpp specific block -->
      <div v-if="kindIsLlamaCpp" class="kind-block">
        <div class="kind-block-title">llama.cpp options</div>
        <label class="check-row">
          <input v-model="form.routerMode" type="checkbox" />
          <span>Router mode — launch with <code>--models-preset</code> using selected model configs</span>
        </label>
        <div v-if="form.routerMode" class="model-checks">
          <label v-for="m in models" :key="m.id" class="check-row">
            <input type="checkbox" :checked="modelIds.includes(m.id)" @change="toggleModel(m.id)" />
            <span>{{ m.alias }}</span>
          </label>
          <small v-if="models.length === 0">No model configs yet — create them in the Models tab.</small>
        </div>
        <template v-else>
          <div class="field">
            <label>Model Path</label>
            <input v-model="form.modelPath" type="text" placeholder="/path/to/model.gguf" />
          </div>
          <div class="field">
            <label>MMProj Path</label>
            <input v-model="form.mmproj" type="text" placeholder="(optional) vision projector .gguf" />
          </div>
        </template>
      </div>

      <!-- Generic params -->
      <div class="field">
        <label>Parameters</label>
        <div v-for="(row, idx) in params" :key="idx" class="env-row">
          <input v-model="row.key" type="text" placeholder="--flag" class="env-key" />
          <input v-model="row.value" type="text" placeholder="value (empty = flag only)" class="env-value" />
          <button class="remove-btn" @click="removeParamRow(idx)" title="Remove">&times;</button>
        </div>
        <div class="params-actions">
          <button class="add-env-btn" @click="addParamRow">+ Add Parameter</button>
          <button class="add-env-btn" @click="showArgsPaste = !showArgsPaste">Paste args…</button>
        </div>
        <div v-if="showArgsPaste" class="args-paste">
          <textarea
            v-model="argsText"
            rows="3"
            placeholder="--host 0.0.0.0 -c 8192 --metrics --flash-attn"
          ></textarea>
          <button class="btn" @click="applyArgsPaste">Replace params</button>
        </div>
        <small v-if="previewArgs" class="params-preview">→ <code>{{ previewArgs }}</code></small>
      </div>
    </div>

    <template #footer>
      <button class="btn" @click="requestClose">Cancel</button>
      <button class="btn btn-primary" :disabled="saving" @click="save">
        {{ saving ? 'Saving…' : 'Save Engine' }}
      </button>
    </template>
  </Dialog>
</template>

<style scoped>
.engine-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editor-error {
  color: #f85149;
  background: #da363315;
  border: 1px solid #da363333;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 0.78rem;
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

.field input,
.field select {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 7px 10px;
  color: #e1e4e8;
  font-size: 0.82rem;
  font-family: inherit;
}

.field input:focus,
.field select:focus { outline: none; border-color: #58a6ff; }

.field-row {
  display: flex;
  gap: 12px;
}

.field-row .field {
  flex: 1;
}

.field-kind {
  width: 180px;
  flex-shrink: 0;
  flex-grow: 0 !important;
}

.field-port {
  width: 110px;
  flex-shrink: 0;
  flex-grow: 0 !important;
}

.def-block,
.kind-block {
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #0d111766;
}

.kind-block-title {
  font-size: 0.72rem;
  font-weight: 600;
  color: #58a6ff;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

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
  width: 40%;
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
  padding: 5px 8px;
  color: #58a6ff;
  font-size: 0.75rem;
  cursor: pointer;
}

.add-env-btn:hover { border-color: #58a6ff; background: #1f6feb11; }

.params-actions {
  display: flex;
  gap: 8px;
}

.args-paste {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.args-paste textarea {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 7px 10px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: 'Cascadia Code', monospace;
  resize: vertical;
}

.args-paste textarea:focus { outline: none; border-color: #58a6ff; }

.params-preview {
  margin-top: 4px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: #e1e4e8;
  cursor: pointer;
}

.check-row code {
  font-family: 'Cascadia Code', monospace;
  color: #79c0ff;
  font-size: 0.75rem;
}

.model-checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 4px;
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

.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary { background: #238636; border-color: #238636; color: white; }
.btn-primary:hover:not(:disabled) { background: #2ea043; }
</style>
