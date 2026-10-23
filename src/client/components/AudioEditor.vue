<script setup lang="ts">
/**
 * audio.cpp engine editor (docs/audio.md §2.5).
 *
 * `audiocpp_server` reads one JSON file holding the server options plus the
 * `models[]` array, so this dialog edits the self-contained `AudioConfig`
 * block on the instance: server rows (Server tab), the model selection
 * (Models tab — the audio counterpart of the llama.cpp Router tab, picking
 * `type: 'audio'` cards from the global Models list), and a raw JSON view for
 * keys the UI has no field for (Other Keys).
 *
 * Import/export speak the real `audiocpp_server --config` format: importing
 * fills the block *and* creates a model card per `models[]` entry (skipped
 * when a card with that alias exists), exporting re-emits the file including
 * untouched keys and absolute paths. Like strata, nothing is shared with
 * another engine, so two audio instances never affect each other.
 *
 * A new engine is only created when Save is clicked (the list's kind dropdown
 * opens this dialog without posting anything first).
 */

import { computed, ref, watch, onMounted } from 'vue';
import Dialog from './ui/Dialog.vue';
import ParamRows from './ui/ParamRows.vue';
import type { AudioConfig, EngineInstance, EngineParam, ModelConfig, ModelsFile, ParamDef } from '../types';

const props = defineProps<{
  /** Existing instance, or a blank draft for a new engine (not yet saved). */
  instance: EngineInstance;
  isNew?: boolean;
}>();

const emit = defineEmits<{
  saved: [instance: EngineInstance];
  close: [];
}>();

// --- Basics ---
const form = ref({
  name: props.instance.name,
  notes: props.instance.notes ?? '',
  binary: props.instance.binary || 'audiocpp_server',
  autoLaunch: props.instance.autoLaunch === true,
});

function blankAudio(): AudioConfig {
  return {
    cwd: '',
    serverArgs: [
      { key: 'host', value: '127.0.0.1' },
      { key: 'port', value: '8080' },
      { key: 'backend', value: 'cuda' },
      { key: 'device', value: '0' },
      { key: 'threads', value: '8' },
      { key: 'lazy_load' },
    ],
    modelConfigIds: [],
    extra: {},
  };
}

const audio = ref<AudioConfig>({ ...blankAudio(), ...(props.instance.audio ?? {}) });

// --- Catalog ---
const serverCatalog = ref<ParamDef[]>([]);

async function loadCatalog() {
  try {
    const res = await fetch('/api/params/audio-server');
    serverCatalog.value = res.ok ? await res.json() : [];
  } catch {
    /* catalog is optional decoration — rows still edit without it */
  }
}
onMounted(loadCatalog);

const SERVER_CATEGORY_LABELS: Record<string, string> = {
  network: 'Network',
  device: 'Device & Compute',
  lifecycle: 'Load Lifecycle',
  paths: 'Paths & WebUI',
};

// --- Tabs ---
type Tab = 'server' | 'models' | 'json' | 'command';
const activeTab = ref<Tab>('server');

// --- Model picker (Models tab) ---
// Same UX as the llama.cpp Router tab, filtered to audio model cards: the
// launch writes the selected cards into the generated file's `models[]`.
const allModels = ref<ModelConfig[]>([]);
const modelFilter = ref('');

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data: ModelsFile = res.ok ? await res.json() : { configs: [], templates: [], defaultConfigId: null };
    allModels.value = data.configs.filter((m) => m.type === 'audio');
  } catch {
    allModels.value = [];
  }
}
onMounted(loadModels);

const visibleModels = computed(() => {
  const q = modelFilter.value.toLowerCase();
  return allModels.value.filter(
    (m) => !q || m.alias.toLowerCase().includes(q) || m.modelPath.toLowerCase().includes(q),
  );
});

const selectedModelIds = computed(() => new Set(audio.value.modelConfigIds));

function toggleModelSelection(id: string) {
  const next = new Set(audio.value.modelConfigIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  audio.value.modelConfigIds = [...next];
}

// Keep the selection list in the saved order of the global model list.
function selectAllVisible() {
  const next = new Set(audio.value.modelConfigIds);
  for (const m of visibleModels.value) next.add(m.id);
  audio.value.modelConfigIds = allModels.value.filter((m) => next.has(m.id)).map((m) => m.id);
}

function clearModelSelection() {
  audio.value.modelConfigIds = [];
}

// --- Raw JSON view (`extra` keys: live_ingest, frontend_options, …) ---
const jsonText = ref('');
const jsonError = ref('');
const jsonApplied = ref(false);

watch(activeTab, (tab) => {
  if (tab === 'json') {
    jsonText.value = JSON.stringify(audio.value.extra ?? {}, null, 2);
    jsonError.value = '';
  }
});

function applyJson() {
  try {
    const parsed = JSON.parse(jsonText.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      jsonError.value = 'Expected a JSON object of config keys.';
      return;
    }
    audio.value.extra = parsed as Record<string, unknown>;
    jsonError.value = '';
    jsonApplied.value = true;
    setTimeout(() => (jsonApplied.value = false), 1500);
  } catch (e) {
    jsonError.value = (e as Error).message;
  }
}

// --- Import / export the audio.cpp JSON file ---
const fileInput = ref<HTMLInputElement | null>(null);
const importError = ref('');
const importedName = ref('');

function pickFile() {
  fileInput.value?.click();
}

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importError.value = '';
  importedName.value = '';
  try {
    const text = await file.text();
    const res = await fetch('/api/engines/audio/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      importError.value = data.error || `Import failed (${res.status})`;
      return;
    }
    audio.value = data.audio as AudioConfig;
    // The imported models[] entries became model cards — select them (plus
    // anything already selected) so the instance launches with them.
    const importedIds = (data.models as ModelConfig[]).map((m) => m.id);
    audio.value.modelConfigIds = [...new Set([...audio.value.modelConfigIds, ...importedIds])];
    await loadModels();
    importedName.value = file.name;
    // A file whose name looks like a hint seeds the engine name once.
    if (props.isNew && !form.value.name) {
      form.value.name = file.name.replace(/^audio-/, '').replace(/\.json$/i, '');
    }
  } catch (err) {
    importError.value = String(err);
  } finally {
    input.value = '';
  }
}

async function exportJson() {
  const body = {
    audio: audio.value,
    modelConfigIds: audio.value.modelConfigIds,
    instanceId: props.instance.id,
  };
  try {
    const res = await fetch('/api/engines/audio/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      importError.value = (await res.json().catch(() => ({}))).error || 'Export failed';
      return;
    }
    const config = await res.json();
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audio-${form.value.name || props.instance.id || 'engine'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    importError.value = String(e);
  }
}

// --- Command preview (same driver path a real launch uses) ---
interface CommandPreview {
  binaryPath: string;
  args: string[];
  cwd: string;
  exists: boolean;
}
const command = ref<CommandPreview | null>(null);
const commandLoading = ref(false);
const commandError = ref('');
let commandTimer: ReturnType<typeof setTimeout> | null = null;

async function fetchCommand() {
  commandLoading.value = true;
  try {
    const res = await fetch('/api/engines/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'audio',
        instanceId: props.instance.id,
        executable: form.value.binary.trim() || 'audiocpp_server',
        params: [],
        audio: audio.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      command.value = null;
      commandError.value = data.error || `Preview failed (${res.status})`;
    } else {
      command.value = data;
      commandError.value = '';
    }
  } catch (e) {
    command.value = null;
    commandError.value = String(e);
  } finally {
    commandLoading.value = false;
  }
}

watch([activeTab, audio, () => form.value.binary], () => {
  if (activeTab.value !== 'command') return;
  if (commandTimer) clearTimeout(commandTimer);
  commandTimer = setTimeout(fetchCommand, 250);
}, { deep: true });

const commandText = computed(() => {
  if (!command.value) return '';
  return `${command.value.binaryPath} ${command.value.args.join(' ')}`.trim();
});

const copiedCommand = ref(false);
function copyCommand() {
  navigator.clipboard.writeText(commandText.value).then(() => {
    copiedCommand.value = true;
    setTimeout(() => (copiedCommand.value = false), 1500);
  });
}

// --- Dirty tracking ---
const dirty = ref(false);
let snapshot = '';
function currentState() {
  return JSON.stringify({ form: form.value, audio: audio.value });
}
watch([form, audio], () => {
  dirty.value = currentState() !== snapshot;
}, { deep: true });

// --- Save ---
const saving = ref(false);
const error = ref('');

function cleanRows(rows: EngineParam[]): EngineParam[] {
  return rows
    .filter((p) => p.key.trim())
    .map((p) => ({
      key: p.key.trim(),
      ...(p.value !== undefined && p.value !== '' ? { value: p.value } : {}),
      ...(p.disabled ? { disabled: true } : {}),
    }));
}

async function save() {
  saving.value = true;
  error.value = '';
  try {
    if (!form.value.name.trim()) {
      error.value = 'Engine name is required';
      return;
    }
    const audioBody: AudioConfig = {
      cwd: audio.value.cwd,
      serverArgs: cleanRows(audio.value.serverArgs),
      modelConfigIds: audio.value.modelConfigIds,
      extra: audio.value.extra ?? {},
    };

    // New engines are created here — the kind dropdown only opens the dialog.
    let target = props.instance;
    if (props.isNew) {
      const res = await fetch('/api/engines/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.value.name.trim(), kind: 'audio' }),
      });
      if (!res.ok) {
        error.value = (await res.json().catch(() => ({}))).error || `Create failed (${res.status})`;
        return;
      }
      target = await res.json();
    }

    const res = await fetch(`/api/engines/instances/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.value.name.trim(),
        notes: form.value.notes,
        kind: 'audio',
        // An audio engine carries its own config, so it has no shared definition.
        definitionId: '',
        binary: form.value.binary.trim() || 'audiocpp_server',
        autoLaunch: form.value.autoLaunch,
        audio: audioBody,
      }),
    });
    if (!res.ok) {
      error.value = (await res.json().catch(() => ({}))).error || `Save failed (${res.status})`;
      return;
    }
    const updated = await res.json();
    snapshot = currentState();
    dirty.value = false;
    emit('saved', updated);
    emit('close');
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

snapshot = currentState();
</script>

<template>
  <Dialog :title="isNew ? 'New audio.cpp Engine' : `audio.cpp Engine: ${instance.name}`" :width="880" @close="requestClose">
    <div class="audio-editor">
      <div v-if="error" class="editor-error">{{ error }}</div>

      <div class="field-row">
        <div class="field">
          <label>Engine Name</label>
          <input v-model="form.name" type="text" placeholder="audio-tts" />
        </div>
      </div>

      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" rows="2" placeholder="Which GPU this engine owns, models loaded, trade-offs..."></textarea>
      </div>

      <div class="field">
        <label>Executable</label>
        <input v-model="form.binary" type="text" placeholder="audio.cpp/build/bin/audiocpp_server"
          title="audiocpp_server binary: absolute path, or resolved against the run folder below" />
      </div>

      <div class="field">
        <label>Run Folder</label>
        <input v-model="audio.cwd" type="text" placeholder="/home/me/Programs/AI"
          title="Folder the server runs from; relative model paths in the generated file resolve against it (absolute paths are written)" />
      </div>

      <label class="check-row">
        <input v-model="form.autoLaunch" type="checkbox" />
        <span>Start this engine when the application launches</span>
      </label>

      <div class="io-row">
        <button class="btn" @click="pickFile">Import audio JSON…</button>
        <button class="btn" @click="exportJson">Export audio JSON</button>
        <input ref="fileInput" type="file" accept="application/json,.json" class="file-input" @change="onFileChosen" />
        <span v-if="importedName" class="io-note">Imported {{ importedName }}</span>
        <span v-if="importError" class="io-note io-error">{{ importError }}</span>
      </div>

      <div class="tab-bar">
        <button class="tab-btn" :class="{ active: activeTab === 'server' }" @click="activeTab = 'server'">Server</button>
        <button class="tab-btn" :class="{ active: activeTab === 'models' }" @click="activeTab = 'models'">Models</button>
        <button class="tab-btn" :class="{ active: activeTab === 'json' }" @click="activeTab = 'json'">Other Keys</button>
        <button class="tab-btn" :class="{ active: activeTab === 'command' }" @click="activeTab = 'command'">Command</button>
      </div>

      <template v-if="activeTab === 'server'">
        <small class="tab-hint">
          Top-level keys of the generated <code>audio-&lt;engine&gt;.json</code>, read by
          <code>audiocpp_server</code> (<code>host</code>, <code>port</code>, <code>backend</code>,
          <code>device</code>, <code>threads</code>, <code>lazy_load</code>, …). A row switched
          <code>off</code> is left out of the file; the server then applies its own default.
        </small>
        <ParamRows
          v-model="audio.serverArgs"
          :catalog="serverCatalog"
          :category-labels="SERVER_CATEGORY_LABELS"
          flag-placeholder="key (e.g. cors_origins)"
        />
      </template>

      <template v-else-if="activeTab === 'models'">
        <small class="tab-hint">
          <code>audiocpp_server</code> has no CLI flag that adds a model: the selected
          <code>type: audio</code> cards below are written to the generated file's
          <code>models[]</code> array (each card's alias is the model id clients request).
        </small>
        <div class="field">
          <div class="router-toolbar">
            <input v-model="modelFilter" type="text" placeholder="Search models…" class="router-search" />
            <button class="add-env-btn" @click="selectAllVisible">Select shown</button>
            <button class="add-env-btn" @click="clearModelSelection">Clear</button>
          </div>
          <div v-if="!allModels.length" class="version-info version-invalid">
            No audio model configs yet — create them on the Models tab or import an audio JSON.
          </div>
          <div v-else-if="!visibleModels.length" class="router-empty">No models match that search.</div>
          <div v-else class="model-list">
            <label v-for="m in visibleModels" :key="m.id" class="model-row" :class="{ 'is-selected': selectedModelIds.has(m.id) }">
              <input type="checkbox" :checked="selectedModelIds.has(m.id)" @change="toggleModelSelection(m.id)" />
              <span class="model-alias">{{ m.alias }}</span>
              <span class="model-path" :title="m.modelPath">{{ m.modelPath || '(no model path)' }}</span>
            </label>
          </div>
          <small v-if="audio.modelConfigIds.length === 0" class="version-info version-invalid">
            Launching needs at least one audio model — none selected.
          </small>
          <small v-else>Selected {{ audio.modelConfigIds.length }} of {{ allModels.length }} model config(s).</small>
        </div>
      </template>

      <template v-else-if="activeTab === 'json'">
        <small class="tab-hint">
          Config keys the UI has no field for (<code>live_ingest</code>,
          <code>frontend_listener</code>, <code>frontend_options</code>,
          <code>log_request_body</code>, <code>max_request_body_bytes</code>, …).
          They are kept verbatim and written back on export.
        </small>
        <textarea v-model="jsonText" rows="14" class="json-area" spellcheck="false"></textarea>
        <div class="json-actions">
          <button class="btn btn-primary" @click="applyJson">{{ jsonApplied ? '✓ Applied' : 'Apply' }}</button>
          <span v-if="jsonError" class="io-note io-error">{{ jsonError }}</span>
        </div>
      </template>

      <template v-else>
        <div class="preview-panel">
          <div class="preview-header">
            <span class="preview-label">Command line</span>
            <button class="btn" :disabled="!commandText" @click="copyCommand">
              {{ copiedCommand ? '✓ Copied' : 'Copy' }}
            </button>
          </div>
          <div v-if="commandError" class="hint-error">{{ commandError }}</div>
          <pre v-else class="preview-code">{{ commandLoading ? 'Composing…' : commandText || 'Set the executable to preview.' }}</pre>
          <small v-if="command" class="preview-hint">
            Working directory <code>{{ command.cwd || '(not set)' }}</code> · the generated config file is written at launch
          </small>
        </div>
      </template>
    </div>

    <template #footer>
      <button class="btn" @click="requestClose">Cancel</button>
      <button class="btn btn-primary" :disabled="saving" @click="save">
        {{ saving ? 'Saving…' : (isNew ? 'Create Engine' : 'Save Engine') }}
      </button>
    </template>
  </Dialog>
</template>

<style scoped>
.audio-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.editor-error {
  background: #da363322;
  border: 1px solid #f85149;
  color: #f85149;
  border-radius: 6px;
  padding: 8px 10px;
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

.field code, .tab-hint code, .preview-hint code {
  font-family: 'Cascadia Code', monospace;
  color: #79c0ff;
}

.field input,
.field select,
.field textarea {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 7px 10px;
  color: #e1e4e8;
  font-size: 0.82rem;
  font-family: inherit;
}

.field textarea { resize: vertical; }
.field input:focus,
.field select:focus,
.field textarea:focus { outline: none; border-color: #58a6ff; }

.field-row {
  display: flex;
  gap: 12px;
}

.field-row .field { flex: 1; min-width: 0; }

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  color: #8b949e;
}

.io-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.file-input { display: none; }

.io-note {
  font-size: 0.72rem;
  color: #3fb950;
}

.io-error { color: #f85149; }

.tab-bar {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid #30363d;
}

.tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 14px;
  color: #8b949e;
  font-size: 0.8rem;
  cursor: pointer;
}

.tab-btn:hover { color: #e1e4e8; }
.tab-btn.active { color: #58a6ff; border-bottom-color: #58a6ff; }

.tab-hint {
  display: block;
  font-size: 0.68rem;
  color: #484f58;
  margin-bottom: 6px;
}

.router-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.router-search {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 10px;
  color: #e1e4e8;
  font-size: 0.78rem;
}

.add-env-btn {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #8b949e;
  font-size: 0.72rem;
  padding: 5px 10px;
  cursor: pointer;
}

.add-env-btn:hover { color: #e1e4e8; background: #30363d; }

.model-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 0.78rem;
  cursor: pointer;
}

.model-row:hover { background: #21262d; }
.model-row.is-selected { background: #1f6feb22; }

.model-alias {
  color: #e1e4e8;
  font-weight: 500;
  flex-shrink: 0;
}

.model-path {
  color: #484f58;
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.router-empty {
  font-size: 0.75rem;
  color: #484f58;
  padding: 6px 0;
}

.version-info {
  font-size: 0.72rem;
  color: #8b949e;
}

.version-invalid { color: #f85149; }

.json-area {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 8px 10px;
  color: #e1e4e8;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.76rem;
  resize: vertical;
}

.json-area:focus { outline: none; border-color: #58a6ff; }

.json-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.preview-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.preview-label {
  font-size: 0.72rem;
  color: #8b949e;
}

.preview-code {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px;
  color: #e1e4e8;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.76rem;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

.preview-hint {
  font-size: 0.68rem;
  color: #484f58;
}

.hint-error {
  font-size: 0.75rem;
  color: #f85149;
  background: #da363315;
  border: 1px solid #da363333;
  border-radius: 6px;
  padding: 6px 10px;
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
