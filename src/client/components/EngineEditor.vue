<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import Dialog from './ui/Dialog.vue';
import type {
  EngineDefinition,
  EngineInstance,
  EngineKind,
  EngineParam,
  ModelConfig,
  ModelsFile,
  ParamDef,
} from '../types';
import { ENGINE_KIND_LABELS } from '../types';

const props = defineProps<{
  instance: EngineInstance;
  definitions: EngineDefinition[];
  /** Pre-selected definition id for a brand-new instance (kind dropdown helper) */
  isNew?: boolean;
}>();

const emit = defineEmits<{
  saved: [instance: EngineInstance];
  close: [];
}>();

// --- Form state (instance) ---
// The dialog is fully generic: name, executable, env vars and parameters.
// host/port/api-key and even llama.cpp model/router options are ordinary
// parameters — model selection stays on the Models tab for now.
const form = ref({
  name: props.instance.name,
  notes: props.instance.notes ?? '',
  definitionId: props.instance.definitionId,
  binary: props.instance.binary,
  autoLaunch: props.instance.autoLaunch === true,
});
const params = ref<EngineParam[]>(
  props.instance.params.map((p) => ({ key: p.key, value: p.value })),
);

// --- Router mode (llama.cpp only): which models from the global Models list
// go into this instance's generated router INI (--models-preset) ---
const routerMode = ref(props.instance.routerMode === true);
const modelConfigIds = ref<string[]>([...props.instance.modelConfigIds]);

// --- Definition editing (build folder + env live on the definition) ---
// The definition dropdown is hidden for now; edits apply to the definition
// this instance already belongs to.
const def = ref<EngineDefinition | null>(
  props.definitions.find((d) => d.id === props.instance.definitionId) ?? null,
);
const defName = ref(def.value?.name ?? '');
const defKind = ref<EngineKind>(def.value?.kind ?? 'llamacpp');

// The editor shows ONE "Executable" field with the full path
// (<definition build folder>/<binary>); on save it splits back into the
// definition's buildPath + the instance's binary name.
function joinPath(folder: string, file: string): string {
  if (!folder) return file;
  return `${folder.replace(/\/+$/, '')}/${file}`;
}
function splitPath(p: string): { folder: string; file: string } {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return { folder: '', file: p };
  return { folder: p.slice(0, idx), file: p.slice(idx + 1) };
}
const executablePath = ref(joinPath(def.value?.buildPath ?? '', props.instance.binary));
interface EnvRow { key: string; value: string }
const envRows = ref<EnvRow[]>(
  Object.entries(def.value?.envVars ?? {}).map(([key, value]) => ({ key, value })),
);

// --- Build validation (kinds with a version probe report it; others just
// check the folder exists) ---
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
  const folder = splitPath(executablePath.value.trim()).folder;
  if (!folder) {
    versionInfo.value = null;
    pathValid.value = false;
    return;
  }
  checkingPath.value = true;
  try {
    const res = await fetch('/api/version/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder, kind: defKind.value }),
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

// Validate the saved path on open so the badge is accurate
onMounted(() => {
  if (splitPath(executablePath.value).folder) checkBuildPath();
});

// --- Tabs: the launch panel, per-instance router models, the composed command ---
const activeTab = ref<'launch' | 'router' | 'command'>('launch');

// Router mode is a llama.cpp feature: switching kind away closes its tab.
watch(defKind, (kind) => {
  if (kind !== 'llamacpp' && activeTab.value === 'router') activeTab.value = 'launch';
});

interface CommandPreview {
  binaryPath: string;
  args: string[];
  envVars: Record<string, string>;
  cwd: string;
  exists: boolean;
}
const command = ref<CommandPreview | null>(null);
const commandLoading = ref(false);
const commandError = ref('');
let commandTimer: ReturnType<typeof setTimeout> | null = null;

// Ask the server to compose the command: it runs the draft through the exact
// driver path a real launch uses, so the preview matches what would spawn.
async function fetchCommand() {
  const executable = executablePath.value.trim();
  if (!executable) {
    command.value = null;
    commandError.value = 'Set an executable path to preview the command.';
    return;
  }
  commandLoading.value = true;
  try {
    const envVars: Record<string, string> = {};
    for (const row of envRows.value) {
      if (row.key.trim()) envVars[row.key.trim()] = row.value;
    }
    const res = await fetch('/api/engines/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definitionId: form.value.definitionId,
        kind: defKind.value,
        executable,
        envVars,
        params: params.value,
        instanceId: props.instance.id,
        routerMode: routerMode.value,
        modelConfigIds: modelConfigIds.value,
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

// Re-preview whenever the draft changes while the Command tab is open.
watch([activeTab, executablePath, defKind, envRows, params, routerMode, modelConfigIds], () => {
  if (activeTab.value !== 'command') return;
  if (commandTimer) clearTimeout(commandTimer);
  commandTimer = setTimeout(fetchCommand, 250);
}, { deep: true });

// Group a flat argv list into "--flag value" lines, mirroring the Models tab
// export: a flag and its value stay on one line, bare flags get their own.
// A leading `-` only starts a new flag when a letter follows, so values like
// `--seed -1` stay paired with their flag.
const isFlag = (s: string) => /^--?[a-zA-Z]/.test(s);

const commandLines = computed(() => {
  const c = command.value;
  if (!c) return [];
  const lines: string[] = Object.entries(c.envVars)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}="${v}"`);
  lines.push(c.binaryPath);
  const args = c.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (isFlag(arg) && next !== undefined && !isFlag(next)) {
      lines.push(/\s/.test(next) ? `${arg} "${next}"` : `${arg} ${next}`);
      i++;
    } else {
      lines.push(/\s/.test(arg) ? `"${arg}"` : arg);
    }
  }
  return lines;
});

const commandText = computed(() =>
  commandLines.value.map((line, i) => (i < commandLines.value.length - 1 ? `${line} \\` : line)).join('\n'),
);

const copiedCommand = ref(false);
function copyCommand() {
  navigator.clipboard.writeText(commandText.value).then(() => {
    copiedCommand.value = true;
    setTimeout(() => (copiedCommand.value = false), 1500);
  });
}

// --- Env rows ---
function addEnvRow() {
  envRows.value.push({ key: '', value: '' });
}
function removeEnvRow(idx: number) {
  envRows.value.splice(idx, 1);
}

// --- Param rows (key-only = flag, key+value = option) ---
// The kind's parameter catalog (`.config/params.<kind>.json`, served by
// GET /api/params?kind=) drives grouping, descriptions, input types and
// dropdown options — same model as the model-config editor. Rows stay plain
// EngineParams: order is the launch order, `disabled` keeps a row visible but
// out of the command line.
const catalog = ref<ParamDef[]>([]);

async function loadCatalog() {
  try {
    const res = await fetch(`/api/params?kind=${defKind.value}`);
    catalog.value = res.ok ? await res.json() : [];
  } catch {
    catalog.value = [];
  }
}
watch(defKind, loadCatalog);
onMounted(loadCatalog);

const keyToDef = computed(() => new Map(catalog.value.map((d) => [d.flag, d])));

const CATEGORY_LABELS: Record<string, string> = {
  gpu: 'GPU & Offload',
  context: 'Context & RoPE',
  sampling: 'Sampling',
  reasoning: 'Reasoning',
  speculative: 'Speculative Decoding',
  other: 'Other',
  unknown: 'Unknown',
};

// The llama.cpp categories, in display order. A kind's own catalog may name
// others (strata's ple/kv/experts/native/…): those follow, in the order the
// catalog lists them, so the JSON file controls its own grouping. 'unknown'
// (flags outside the catalog) always comes last.
const BASE_CATEGORY_ORDER = ['gpu', 'context', 'sampling', 'reasoning', 'speculative', 'other'];

const categoryOrder = computed(() => {
  const extra: string[] = [];
  for (const d of catalog.value) {
    if (!BASE_CATEGORY_ORDER.includes(d.category) && d.category !== 'unknown' && !extra.includes(d.category)) {
      extra.push(d.category);
    }
  }
  return [...BASE_CATEGORY_ORDER, ...extra, 'unknown'];
});

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] || cat;
}

interface ParamRow {
  param: EngineParam;
  index: number;
  def: ParamDef | null;
}

// Active rows grouped by category, preserving the instance's param order.
const groupedParams = computed(() => {
  const groups: Record<string, ParamRow[]> = {};
  params.value.forEach((param, index) => {
    if (!param.key.trim()) return;
    const def = keyToDef.value.get(param.key) ?? null;
    const cat = def ? def.category : 'unknown';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ param, index, def });
  });
  return categoryOrder.value.filter((cat) => groups[cat]?.length).map((cat) => ({
    cat,
    label: categoryLabel(cat),
    rows: groups[cat],
  }));
});

function isToggleOn(p: EngineParam): boolean {
  return !p.disabled && (p.value === undefined || p.value === '');
}

function toggleParam(p: EngineParam) {
  if (p.disabled) {
    p.disabled = false;
    p.value = undefined; // bare flag on the command line
  } else {
    p.disabled = true;
  }
}

function removeParamRow(idx: number) {
  params.value.splice(idx, 1);
}

// --- Add parameter picker (catalog entries not on the instance yet) ---
const showPicker = ref(false);
const pickerFilter = ref('');
const pickerRef = ref<HTMLElement | null>(null);

const pickerGroups = computed(() => {
  const used = new Set(params.value.map((p) => p.key));
  const q = pickerFilter.value.toLowerCase();
  const groups: Record<string, ParamDef[]> = {};
  for (const d of catalog.value) {
    if (used.has(d.flag)) continue;
    if (q && !d.flag.toLowerCase().includes(q) && !d.label.toLowerCase().includes(q) && !d.description.toLowerCase().includes(q)) continue;
    if (!groups[d.category]) groups[d.category] = [];
    groups[d.category].push(d);
  }
  return categoryOrder.value.filter((cat) => groups[cat]?.length).map((cat) => ({
    cat,
    label: categoryLabel(cat),
    defs: groups[cat],
  }));
});

function addCatalogParam(d: ParamDef) {
  // Toggle params join as bare flags (enabled); everything else takes its default.
  params.value.push(d.inputType === 'toggle' ? { key: d.flag } : { key: d.flag, value: d.default ?? '' });
  showPicker.value = false;
  pickerFilter.value = '';
}

function addParamRow() {
  params.value.push({ key: '', value: '' });
}

// --- Drag to reorder (same native DnD pattern as the model-config editor) ---
// Rows are tracked by index rather than flag, since the same flag can appear
// more than once in a generic param list.
const dragIndex = ref<number | null>(null);
const dropTarget = ref<number | null>(null);
const dragEnabledIndex = ref<number | null>(null);

function onHandleMousedown(index: number) {
  dragEnabledIndex.value = index;
}
function onGlobalMouseup() {
  dragEnabledIndex.value = null;
}
onMounted(() => window.addEventListener('mouseup', onGlobalMouseup));
onUnmounted(() => window.removeEventListener('mouseup', onGlobalMouseup));

function onDragStart(index: number, e: DragEvent) {
  dragIndex.value = index;
  e.dataTransfer?.setData('text/plain', String(index));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}

function onDragOverRow(index: number, e: DragEvent) {
  e.preventDefault();
  if (dragIndex.value === null || dragIndex.value === index) return;
  dropTarget.value = index;
}

function onDragLeaveRow() {
  dropTarget.value = null;
}

function onDropRow(targetIndex: number, e: DragEvent) {
  e.preventDefault();
  const from = dragIndex.value;
  clearDragState();
  if (from === null || from === targetIndex) return;
  // Always insert underneath the target row (adjusted for the source removal).
  let insertIdx = targetIndex + 1;
  if (from < insertIdx) insertIdx -= 1;
  const [moved] = params.value.splice(from, 1);
  params.value.splice(insertIdx, 0, moved);
}

function onDragEnd() {
  clearDragState();
}

function clearDragState() {
  dragIndex.value = null;
  dropTarget.value = null;
  dragEnabledIndex.value = null;
}

watch(showPicker, (open) => {
  if (open) {
    requestAnimationFrame(() => pickerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
});

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
    .filter((p) => p.key.trim() && !p.disabled)
    .map((p) => (p.value !== undefined && p.value !== '' ? `${p.key} ${p.value}` : p.key))
    .join(' '),
);

// --- Dirty tracking (same snapshot pattern as EnvironmentConfig) ---
const dirty = ref(false);
let snapshot = '';
function currentState() {
  return JSON.stringify({
    form: form.value,
    params: params.value,
    defName: defName.value,
    defKind: defKind.value,
    executablePath: executablePath.value,
    envRows: envRows.value,
    routerMode: routerMode.value,
    modelConfigIds: modelConfigIds.value,
  });
}
watch(
  [form, params, defName, defKind, executablePath, envRows, routerMode, modelConfigIds],
  () => {
    dirty.value = currentState() !== snapshot;
  },
  { deep: true },
);

// --- Global model list (Models tab) for the Router tab's checkbox list ---
const allModels = ref<ModelConfig[]>([]);
const modelFilter = ref('');

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data: ModelsFile = res.ok ? await res.json() : { configs: [], templates: [], defaultConfigId: null };
    allModels.value = data.configs;
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

const selectedModelIds = computed(() => new Set(modelConfigIds.value));

function toggleModelSelection(id: string) {
  const next = new Set(modelConfigIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  modelConfigIds.value = [...next];
}

// Keep the selection list in the saved order of the global model list.
function selectAllVisible() {
  const next = new Set(modelConfigIds.value);
  for (const m of visibleModels.value) next.add(m.id);
  modelConfigIds.value = allModels.value.filter((m) => next.has(m.id)).map((m) => m.id);
}

function clearModelSelection() {
  modelConfigIds.value = [];
}

// --- Save ---
const saving = ref(false);
const error = ref('');

async function save() {
  saving.value = true;
  error.value = '';
  try {
    // Split the single Executable field back into definition folder + binary name
    const { folder: exeFolder, file: exeName } = splitPath(executablePath.value.trim());
    if (!exeName) {
      error.value = 'Executable path is required';
      return;
    }

    // 1. Persist the definition (build folder + env live there)
    const envVars: Record<string, string> = {};
    for (const row of envRows.value) {
      if (row.key.trim()) envVars[row.key.trim()] = row.value;
    }
    const defBody = {
      name: defName.value.trim() || def.value?.name || 'Engine',
      kind: defKind.value,
      buildPath: exeFolder,
      envVars,
    };
    let defId = form.value.definitionId;
    if (def.value) {
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

    // 2. Persist the instance. modelPath/mmproj stay untouched — the generic
    // dialog never edits them; routerMode/modelConfigIds are edited on the
    // Router tab. The server PUT only touches the fields present in the body.
    const cleanParams = params.value
      .filter((p) => p.key.trim())
      .map((p) => ({
        key: p.key.trim(),
        ...(p.value !== undefined && p.value !== '' ? { value: p.value } : {}),
        ...(p.disabled ? { disabled: true } : {}),
      }));
    const body = {
      ...form.value,
      binary: exeName,
      definitionId: defId,
      params: cleanParams,
      routerMode: routerMode.value,
      modelConfigIds: modelConfigIds.value,
    };
    // A draft from the kind dropdown has no row on the server yet: create it,
    // then write the dialog's edits onto it. Existing instances update in place.
    let targetId = props.instance.id;
    if (props.isNew) {
      const created = await fetch('/api/engines/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.value.name.trim() || 'engine',
          kind: defKind.value,
          definitionId: defId,
        }),
      });
      if (!created.ok) {
        error.value = (await created.json().catch(() => ({}))).error || `Create failed (${created.status})`;
        return;
      }
      targetId = (await created.json()).id;
    }
    const res = await fetch(`/api/engines/instances/${targetId}`, {
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
        <label>Notes</label>
        <textarea
          v-model="form.notes"
          rows="2"
          placeholder="What this engine is for, GPU it sits on, trade-offs..."
        ></textarea>
      </div>

      <label class="check-row">
        <input v-model="form.autoLaunch" type="checkbox" />
        <span>Start this engine when the application launches</span>
      </label>

      <!-- Tabs: launch settings, router models (llama.cpp only), the real command -->
      <div class="tab-bar">
        <button class="tab-btn" :class="{ active: activeTab === 'launch' }" @click="activeTab = 'launch'">Launch</button>
        <button
          v-if="defKind === 'llamacpp'"
          class="tab-btn"
          :class="{ active: activeTab === 'router' }"
          @click="activeTab = 'router'"
        >Router<template v-if="modelConfigIds.length"> ({{ modelConfigIds.length }})</template></button>
        <button class="tab-btn" :class="{ active: activeTab === 'command' }" @click="activeTab = 'command'">Command</button>
      </div>

      <template v-if="activeTab === 'launch'">
      <div class="field">
        <label>Executable</label>
        <div class="path-row">
          <input v-model="executablePath" type="text" placeholder="/path/to/build/bin/llama-server" />
          <button
            class="btn refresh-btn"
            :disabled="checkingPath"
            @click="checkBuildPath"
            title="Validate this path and fetch the engine version when available"
          >{{ checkingPath ? '…' : '↻ Validate' }}</button>
        </div>
        <small>Full path to the engine executable; its folder is shared by every instance using this definition</small>
        <div v-if="pathValid === false" class="version-info version-invalid">
          Invalid path — no engine build found in that folder.
        </div>
        <div v-else-if="versionInfo && (versionInfo.version || versionInfo.build)" class="version-info">
          {{ versionInfo.version || '?' }} (build {{ versionInfo.build || '?' }})<template v-if="versionInfo.backend"> · {{ versionInfo.backend }}</template><template v-if="versionInfo.commit"> · {{ versionInfo.commit.slice(0, 7) }}</template>
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

      <!-- Parameters: grouped by the kind's catalog, ordered, on/off to include -->
      <div class="field">
        <label>Parameters</label>
        <div v-for="group in groupedParams" :key="group.cat" class="param-group">
          <h4 class="group-title" :class="{ 'group-unknown': group.cat === 'unknown' }">{{ group.label }}</h4>
          <div
            v-for="row in group.rows"
            :key="row.index"
            class="param-row"
            :class="{ 'param-disabled': row.param.disabled, dragging: dragIndex === row.index, 'drop-after': dropTarget === row.index && dragIndex !== null }"
            :draggable="dragEnabledIndex === row.index"
            @dragstart="onDragStart(row.index, $event)"
            @dragover="onDragOverRow(row.index, $event)"
            @dragleave="onDragLeaveRow()"
            @drop="onDropRow(row.index, $event)"
            @dragend="onDragEnd()"
          >
            <span class="drag-handle" title="Drag to reorder" @mousedown="onHandleMousedown(row.index)">&#8942;</span>
            <span class="param-flag" :title="row.def?.description || ''">{{ row.param.key }}</span>
            <!-- Catalog toggle params: presence on/off -->
            <label v-if="row.def && row.def.inputType === 'toggle'" class="toggle-wrap">
              <input type="checkbox" :checked="isToggleOn(row.param)" @change="toggleParam(row.param)" />
              <span>{{ isToggleOn(row.param) ? 'on' : 'off' }}</span>
            </label>
            <!-- Catalogued value params -->
            <select v-else-if="row.def?.inputType === 'select'" v-model="row.param.value">
              <option value="">(none)</option>
              <option v-for="opt in row.def?.options" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input
              v-else-if="row.def?.inputType === 'number'"
              v-model="row.param.value"
              type="number"
              step="any"
              :placeholder="row.def?.default || ''"
            />
            <input
              v-else-if="row.def?.inputType === 'path'"
              v-model="row.param.value"
              type="text"
              placeholder="/path/to/file"
            />
            <template v-else-if="row.def?.inputType === 'preset'">
              <input v-model="row.param.value" type="text" :placeholder="row.def?.default || ''" />
              <select
                v-if="row.def?.presets?.length"
                class="preset-select"
                :value="row.def?.presets?.includes(row.param.value ?? '') ? row.param.value : ''"
                @change="(e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) row.param.value = v; }"
                title="Quick presets"
              >
                <option value="">preset…</option>
                <option v-for="p in row.def?.presets" :key="p" :value="p">{{ p }}</option>
              </select>
            </template>
            <input
              v-else
              v-model="row.param.value"
              type="text"
              :placeholder="row.def ? (row.def.inputType === 'comma-list' ? 'e.g. CUDA0,CUDA1' : row.def.default || '') : 'value (empty = flag only)'"
            />
            <span class="param-desc" :title="row.def?.description || 'Not in this parameter catalog'">{{ row.def?.description || 'custom flag' }}</span>
            <button
              v-if="!row.def || row.def.inputType !== 'toggle'"
              class="toggle-enabled-btn"
              :class="{ 'is-disabled': row.param.disabled }"
              @click="row.param.disabled = !row.param.disabled"
              :title="row.param.disabled ? 'Include in the launch' : 'Exclude from the launch'"
            >{{ row.param.disabled ? 'off' : 'on' }}</button>
            <button class="remove-btn" @click="removeParamRow(row.index)" title="Remove">&times;</button>
          </div>
        </div>
        <div class="params-actions">
          <button class="add-env-btn" @click="showPicker = !showPicker">+ Add Parameter</button>
          <button class="add-env-btn" @click="addParamRow">+ Custom Flag</button>
          <button class="add-env-btn" @click="showArgsPaste = !showArgsPaste">Paste args…</button>
        </div>
        <div v-if="showPicker" ref="pickerRef" class="param-picker">
          <input v-model="pickerFilter" type="text" placeholder="Search parameters..." autofocus />
          <div class="picker-list">
            <div v-for="group in pickerGroups" :key="group.cat" class="picker-group">
              <h5>{{ group.label }}</h5>
              <div v-for="d in group.defs" :key="d.flag" class="picker-item" @click="addCatalogParam(d)">
                <span class="picker-flag">{{ d.flag }}</span>
                <span class="picker-desc">{{ d.description }}</span>
              </div>
            </div>
            <div v-if="!pickerGroups.length" class="picker-empty">No matching parameters</div>
          </div>
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
      </template>

      <!-- Router mode: pick which models from the global Models list this
           instance serves. The launch writes them to a per-instance INI and
           starts llama-server with --models-preset. -->
      <template v-else-if="activeTab === 'router'">
        <label class="check-row">
          <input v-model="routerMode" type="checkbox" />
          <span>Serve multiple models from a generated <code>router.ini</code> (<code>--models-preset</code>)</span>
        </label>
        <small>
          When on, this engine launches without a single <code>-m</code> model: the selected
          models below are written to <code>.config/router-{{ instance.id }}.ini</code>, each with
          its own parameters. Engines using a different build get their own file.
        </small>
        <div v-if="routerMode" class="field">
          <div class="router-toolbar">
            <input v-model="modelFilter" type="text" placeholder="Search models…" class="router-search" />
            <button class="add-env-btn" @click="selectAllVisible">Select shown</button>
            <button class="add-env-btn" @click="clearModelSelection">Clear</button>
          </div>
          <div v-if="!allModels.length" class="version-info version-invalid">
            No model configs yet — create them on the Models tab first.
          </div>
          <div v-else-if="!visibleModels.length" class="router-empty">No models match that search.</div>
          <div v-else class="model-list">
            <label v-for="m in visibleModels" :key="m.id" class="model-row" :class="{ 'is-selected': selectedModelIds.has(m.id) }">
              <input type="checkbox" :checked="selectedModelIds.has(m.id)" @change="toggleModelSelection(m.id)" />
              <span class="model-alias">{{ m.alias }}</span>
              <span class="model-path" :title="m.modelPath">{{ m.modelPath || '(no model path)' }}</span>
            </label>
          </div>
          <small v-if="routerMode && modelConfigIds.length === 0" class="version-info version-invalid">
            Router mode needs at least one model — launching would fail otherwise.
          </small>
          <small v-else>Selected {{ modelConfigIds.length }} of {{ allModels.length }} model config(s).</small>
        </div>
      </template>

      <!-- Composed command line (same driver path a real launch uses) -->
      <template v-else>
        <div class="preview-panel">
          <div class="preview-header">
            <span class="preview-label">Command line</span>
            <button class="btn" :disabled="!commandText" @click="copyCommand">
              {{ copiedCommand ? '✓ Copied' : 'Copy' }}
            </button>
          </div>
          <div v-if="commandError" class="version-info version-invalid">{{ commandError }}</div>
          <pre v-else class="preview-code command-cmd">{{ commandLoading ? 'Composing…' : commandText || 'Nothing to run yet.' }}</pre>
          <small v-if="command && !command.exists" class="version-info version-invalid">
            The executable does not exist at that path — this command would fail to start.
          </small>
          <small v-if="command" class="preview-hint">
            Working directory <code>{{ command.cwd || '(not set)' }}</code> · generated by the engine's driver, so it matches the actual launch
          </small>
        </div>
      </template>
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

.field textarea {
  resize: vertical;
}

.field input:focus,
.field select:focus,
.field textarea:focus { outline: none; border-color: #58a6ff; }

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

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  color: #8b949e;
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

/* Router tab: model selection list */
.router-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}

.router-search {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
}

.router-search:focus { outline: none; border-color: #58a6ff; }

.model-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.78rem;
}

.model-row:hover { background: #161b22; }
.model-row.is-selected { background: #1f6feb18; }

.model-alias {
  color: #e1e4e8;
  font-weight: 500;
  flex-shrink: 0;
}

.model-path {
  color: #484f58;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.router-empty {
  font-size: 0.75rem;
  color: #8b949e;
  padding: 8px 4px;
}

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

/* Tabs — same look as the model config editor */
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

/* Command tab */
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
  font-weight: 500;
}

.preview-code {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 12px;
  margin: 0;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.78rem;
  line-height: 1.6;
  color: #e1e4e8;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 180px;
}

.command-cmd {
  color: #7ee787;
}

.preview-hint {
  font-size: 0.65rem;
  color: #484f58;
}

.preview-hint code {
  font-family: 'Cascadia Code', monospace;
  color: #79c0ff;
}

/* Grouped parameter rows */
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
  margin: 4px 0 0;
}

.group-unknown { color: #d29922; }

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
.param-row.dragging { opacity: 0.4; }
.param-row.drop-after { box-shadow: 0 2px 0 0 #58a6ff; }
.param-row.param-disabled { opacity: 0.5; }
.param-row.param-disabled .param-flag { text-decoration: line-through; color: #484f58; }

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
  min-width: 150px;
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
  flex: 1;
}

.param-desc {
  font-size: 0.65rem;
  color: #484f58;
  flex: 0 0 150px;
  width: 150px;
  margin-left: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toggle-enabled-btn {
  flex: 0 0 auto;
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

/* Add-parameter picker */
.param-picker {
  margin-top: 6px;
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
  max-height: 260px;
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
</style>
