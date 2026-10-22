<script setup lang="ts">
/**
 * Strata engine editor (docs/todo.md #21 Phase 4, #22).
 *
 * A strata deployment is a Python HTTP server wrapping a resident engine, so it
 * has far more settings than the generic executable+params model can express.
 * This dialog edits the self-contained `StrataConfig` block on the instance in
 * three groups — the strata engine, the serve/server.py server, and an optional
 * vision encoder — plus a raw JSON view for keys the UI has no field for.
 *
 * Import/export speak the real `strata-<model>.json` format: importing fills
 * every group, exporting re-emits it including untouched keys. Nothing is
 * shared with another engine, so two strata instances never affect each other.
 *
 * A new engine is only created when Save is clicked (the list's kind dropdown
 * opens this dialog without posting anything first).
 */

import { computed, ref, watch, onMounted } from 'vue';
import Dialog from './ui/Dialog.vue';
import ParamRows from './ui/ParamRows.vue';
import type { EngineInstance, EngineParam, ParamDef, StrataConfig } from '../types';

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
  binary: props.instance.binary || 'python3',
  autoLaunch: props.instance.autoLaunch === true,
});

function blankStrata(): StrataConfig {
  return {
    engineArgs: [],
    serverArgs: [
      { key: 'cwd', value: '' },
      { key: 'exe', value: '' },
      { key: 'tokenizer', value: '' },
      { key: 'model_name', value: '' },
      { key: '--host', value: '127.0.0.1' },
      { key: '--port', value: '8095' },
    ],
    vision: null,
    extra: {},
  };
}

const strata = ref<StrataConfig>({ ...blankStrata(), ...(props.instance.strata ?? {}) });

// --- Catalogs ---
const engineCatalog = ref<ParamDef[]>([]);
const serverCatalog = ref<ParamDef[]>([]);
const visionCatalog = ref<ParamDef[]>([]);

async function loadCatalogs() {
  try {
    const [engineRes, serverRes, visionRes] = await Promise.all([
      fetch('/api/params?kind=strata'),
      fetch('/api/params/strata-server'),
      fetch('/api/params/strata-vision'),
    ]);
    engineCatalog.value = engineRes.ok ? await engineRes.json() : [];
    serverCatalog.value = serverRes.ok ? await serverRes.json() : [];
    visionCatalog.value = visionRes.ok ? await visionRes.json() : [];
  } catch {
    /* catalogs are optional decoration — rows still edit without them */
  }
}
onMounted(loadCatalogs);

const ENGINE_CATEGORY_LABELS: Record<string, string> = {
  model: 'Model & Pack',
  gpu: 'GPU & Offload',
  ple: 'PLE',
  kv: 'KV Cache',
  experts: 'Experts / MoE',
  cpu: 'CPU & Threads',
  context: 'Context',
  sampling: 'Sampling',
  speculative: 'Speculative Decoding',
  serve: 'Serve',
  prefill: 'Prefill',
  steering: 'Steering',
  native: 'Native / GGUF',
  debug: 'Debug',
};

const SERVER_CATEGORY_LABELS: Record<string, string> = {
  deployment: 'Deployment',
  network: 'Network',
  gpu: 'GPU & Slots',
  queue: 'Queue & Overload',
  lifecycle: 'Load Lifecycle',
  tools: 'Tools & Observability',
};

const VISION_CATEGORY_LABELS: Record<string, string> = {
  encoder: 'Encoder & Files',
  device: 'Device & Threads',
  tokens: 'Image Tokens',
  vram: 'Elastic VRAM',
};

// --- Tabs ---
// Server first: the deployment paths and the serve/server.py options are what a
// new strata engine needs; the engine's own flags come after them.
type Tab = 'server' | 'engine' | 'vision' | 'json' | 'command';
const activeTab = ref<Tab>('server');

// --- Vision ---
// The section is a row list like the engine/server groups: "no vision" is a null
// block, "vision configured" is a block whose rows the encoder command is built
// from. gpu/threads/elastic and any other key are ordinary rows.
const visionEnabled = ref(strata.value.vision !== null);

function enableVision() {
  if (!strata.value.vision) {
    strata.value.vision = { args: [] };
  }
  visionEnabled.value = true;
}

function disableVision() {
  strata.value.vision = null;
  visionEnabled.value = false;
}

// --- Raw JSON view ---
// The `extra` keys (gpus_asked, gpu_order, layer_split, lib_dirs, log, …) have
// no rows anywhere else, so they are edited here as a JSON object.
const jsonText = ref('');
const jsonError = ref('');
const jsonApplied = ref(false);

watch(activeTab, (tab) => {
  if (tab === 'json') {
    jsonText.value = JSON.stringify(strata.value.extra ?? {}, null, 2);
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
    strata.value.extra = parsed as Record<string, unknown>;
    jsonError.value = '';
    jsonApplied.value = true;
    setTimeout(() => (jsonApplied.value = false), 1500);
  } catch (e) {
    jsonError.value = (e as Error).message;
  }
}

// --- Import / export the strata JSON file ---
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
    const res = await fetch('/api/engines/strata/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      importError.value = data.error || `Import failed (${res.status})`;
      return;
    }
    strata.value = data.strata as StrataConfig;
    visionEnabled.value = strata.value.vision !== null;
    importedName.value = file.name;
    // A file whose name looks like a model hint seeds the engine name once.
    if (props.isNew && !form.value.name) {
      form.value.name = file.name.replace(/^strata-/, '').replace(/\.json$/i, '');
    }
  } catch (err) {
    importError.value = String(err);
  } finally {
    input.value = '';
  }
}

async function exportJson() {
  const body = {
    engineArgs: strata.value.engineArgs,
    serverArgs: strata.value.serverArgs,
    vision: strata.value.vision,
    extra: strata.value.extra,
  };
  try {
    const res = await fetch('/api/engines/strata/render', {
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
    a.download = `strata-${form.value.name || props.instance.id || 'engine'}.json`;
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
        kind: 'strata',
        instanceId: props.instance.id,
        executable: form.value.binary.trim() || 'python3',
        params: [],
        strata: strata.value,
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

watch([activeTab, strata, () => form.value.binary], () => {
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
  return JSON.stringify({ form: form.value, strata: strata.value });
}
watch([form, strata], () => {
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
    const strataBody: StrataConfig = {
      engineArgs: cleanRows(strata.value.engineArgs),
      serverArgs: cleanRows(strata.value.serverArgs),
      vision: strata.value.vision ? { args: cleanRows(strata.value.vision.args) } : null,
      extra: strata.value.extra ?? {},
    };

    // New engines are created here — the kind dropdown only opens the dialog.
    let target = props.instance;
    if (props.isNew) {
      const res = await fetch('/api/engines/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.value.name.trim(), kind: 'strata' }),
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
        kind: 'strata',
        // A strata engine carries its own config, so it has no shared definition.
        definitionId: '',
        binary: form.value.binary.trim() || 'python3',
        autoLaunch: form.value.autoLaunch,
        strata: strataBody,
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
  <Dialog :title="isNew ? 'New Strata Engine' : `Strata Engine: ${instance.name}`" :width="880" @close="requestClose">
    <div class="strata-editor">
      <div v-if="error" class="editor-error">{{ error }}</div>

      <div class="field-row">
        <div class="field">
          <label>Engine Name</label>
          <input v-model="form.name" type="text" placeholder="strata-iq3_s" />
        </div>
      </div>

      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" rows="2" placeholder="Which GPUs this deployment owns, quant, trade-offs..."></textarea>
      </div>

      <div class="field">
        <label>Python Interpreter</label>
        <input v-model="form.binary" type="text" placeholder="python3"
          title="Interpreter that runs serve.server.py; point it at the venv holding Strata's Python deps" />
      </div>

      <label class="check-row">
        <input v-model="form.autoLaunch" type="checkbox" />
        <span>Start this engine when the application launches</span>
      </label>

      <div class="io-row">
        <button class="btn" @click="pickFile">Import strata JSON…</button>
        <button class="btn" @click="exportJson">Export strata JSON</button>
        <input ref="fileInput" type="file" accept="application/json,.json" class="file-input" @change="onFileChosen" />
        <span v-if="importedName" class="io-note">Imported {{ importedName }}</span>
        <span v-if="importError" class="io-note io-error">{{ importError }}</span>
      </div>

      <div class="tab-bar">
        <button class="tab-btn" :class="{ active: activeTab === 'server' }" @click="activeTab = 'server'">Server</button>
        <button class="tab-btn" :class="{ active: activeTab === 'engine' }" @click="activeTab = 'engine'">Engine</button>
        <button class="tab-btn" :class="{ active: activeTab === 'vision' }" @click="activeTab = 'vision'">Vision</button>
        <button class="tab-btn" :class="{ active: activeTab === 'json' }" @click="activeTab = 'json'">Other Keys</button>
        <button class="tab-btn" :class="{ active: activeTab === 'command' }" @click="activeTab = 'command'">Command</button>
      </div>

      <template v-if="activeTab === 'server'">
        <small class="tab-hint">
          Options for <code>serve/server.py</code>, including the deployment paths
          (<code>cwd</code>, <code>exe</code>, <code>tokenizer</code>, <code>model_name</code>).
          <code>--port</code> is always passed on the command line — the config's
          <code>port</code> key is ignored by the server.
        </small>
        <ParamRows
          v-model="strata.serverArgs"
          :catalog="serverCatalog"
          :category-labels="SERVER_CATEGORY_LABELS"
        />
      </template>

      <template v-else-if="activeTab === 'engine'">
        <small class="tab-hint">Flags passed to the <code>strata</code> engine (the config's <code>args</code> array).</small>
        <ParamRows
          v-model="strata.engineArgs"
          :catalog="engineCatalog"
          :category-labels="ENGINE_CATEGORY_LABELS"
        />
      </template>

      <template v-else-if="activeTab === 'vision'">
        <div v-if="!visionEnabled" class="vision-off">
          <p>No vision encoder configured for this engine.</p>
          <button class="btn btn-primary" @click="enableVision">+ Add Vision Encoder</button>
        </div>
        <template v-else>
          <div class="vision-hint-row">
            <small class="tab-hint">
              Keys of the config's <code>vision</code> object; <code>serve/server.py</code> builds the
              <code>strata-vision</code> command from them. <code>exe</code>, <code>mmproj</code> and
              <code>model</code> are required — a row switched <code>off</code> is left out of the file.
            </small>
            <button class="btn" @click="disableVision">Remove Vision</button>
          </div>
          <ParamRows
            v-model="strata.vision!.args"
            :catalog="visionCatalog"
            :category-labels="VISION_CATEGORY_LABELS"
            flag-placeholder="key (e.g. threads)"
          />
        </template>
      </template>

      <template v-else-if="activeTab === 'json'">
        <small class="tab-hint">
          Config keys the UI has no field for (<code>gpus_asked</code>, <code>gpu_order</code>,
          <code>layer_split</code>, <code>lib_dirs</code>, <code>log</code>, <code>sampling</code>, …).
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
          <pre v-else class="preview-code">{{ commandLoading ? 'Composing…' : commandText || 'Set the Strata repo folder to preview.' }}</pre>
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
.strata-editor {
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

.field small {
  font-size: 0.65rem;
  color: #484f58;
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

.vision-off {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.8rem;
  color: #8b949e;
}

.vision-hint-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.vision-hint-row .tab-hint { flex: 1; }

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
