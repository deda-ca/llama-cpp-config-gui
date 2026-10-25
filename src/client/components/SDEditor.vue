<script setup lang="ts">
/**
 * stable-diffusion.cpp engine editor (docs/stable-diffusion.md §3.8).
 *
 * `sd-server` reads **no config file** (unlike strata/audio): the launch line is
 * the flag list itself, and it carries `--model-dir` roots but never weights.
 * So this dialog edits the self-contained `SdConfig` block on the instance:
 * server flags (Server tab), the model selection (Model tab — `type:
 * 'sdiffusion'` cards from the global Models list, first one loaded at startup),
 * a raw JSON view for flags the UI has no row for (Other Keys), and the Command
 * preview.
 *
 * Models are **hot-swapped over the model-management API** (§3.10), not
 * restarted into: the Model tab's Load/Unload buttons post to
 * `/api/engines/instances/:id/sd/models/{load,unload}` and the loaded badge
 * polls `…/sd/models/status`. Those routes act on the *stored* instance, so
 * they are disabled until the engine is saved (and the status poll only runs
 * while the process is up). Generation itself happens in sd.cpp's own Web UI —
 * the "open sd.cpp UI" link goes straight there (§5 Q8: link out, don't rebuild).
 *
 * A new engine is only created when Save is clicked (the list's kind dropdown
 * opens this dialog without posting anything first).
 */

import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import Dialog from './ui/Dialog.vue';
import ParamRows from './ui/ParamRows.vue';
import type { EngineInstance, EngineParam, ModelConfig, ModelsFile, ParamDef, SdConfig } from '../types';

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
  binary: props.instance.binary || 'sd-server',
  autoLaunch: props.instance.autoLaunch === true,
});

function blankSd(): SdConfig {
  return {
    envVars: {},
    serverArgs: [
      { key: '--listen-ip', value: '127.0.0.1' },
      { key: '--listen-port', value: '8080' },
    ],
    modelConfigIds: [],
    extra: {},
  };
}

const sd = ref<SdConfig>({ ...blankSd(), ...(props.instance.sd ?? {}) });

// --- Env rows (ENV) ---
// sd instances have no shared definition to carry environment variables, so the
// block owns them. Note the GUI never sets CUDA_VISIBLE_DEVICES for this kind:
// the mask renumbers devices, so a masked `CUDA0` is not the `CUDA0` that
// `--backend` names (§5 Q5).
interface EnvRow { key: string; value: string }
const envRows = ref<EnvRow[]>(
  Object.entries(sd.value.envVars ?? {}).map(([key, value]) => ({ key, value })),
);

function addEnvRow() {
  envRows.value.push({ key: '', value: '' });
}
function removeEnvRow(idx: number) {
  envRows.value.splice(idx, 1);
}
function collectEnvVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of envRows.value) {
    if (row.key.trim()) out[row.key.trim()] = row.value;
  }
  return out;
}

// --- Executable validation (sd-server --version banner) ---
interface VersionInfo {
  version: string | null;
  build: string | null;
  commit: string | null;
  compiler: string | null;
  backend: string | null;
  valid?: boolean;
}
const versionInfo = ref<VersionInfo | null>(null);
const checkingPath = ref(false);
const pathValid = ref<boolean | null>(null);

async function checkExecutablePath() {
  const exe = form.value.binary.trim();
  // A bare name is a PATH lookup with nothing to stat or probe locally.
  if (!exe.includes('/')) {
    versionInfo.value = null;
    pathValid.value = exe ? true : null;
    return;
  }
  checkingPath.value = true;
  try {
    const res = await fetch('/api/version/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: exe, kind: 'sdiffusion' }),
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

onMounted(() => {
  if (form.value.binary.trim().includes('/')) checkExecutablePath();
});

// --- Catalog (the shipped sd-server option list) ---
const serverCatalog = ref<ParamDef[]>([]);

async function loadCatalog() {
  try {
    const res = await fetch('/api/params/sd-server');
    serverCatalog.value = res.ok ? await res.json() : [];
  } catch {
    /* catalog is optional decoration — rows still edit without it */
  }
}
onMounted(loadCatalog);

const SERVER_CATEGORY_LABELS: Record<string, string> = {
  network: 'Network',
  model: 'Model Folders',
  device: 'Device & Compute',
  memory: 'Memory & Speed',
  logging: 'Logging',
};

// --- Tabs ---
type Tab = 'launch' | 'models' | 'json' | 'command';
const activeTab = ref<Tab>('launch');

// --- Where the instance answers (for the "open sd.cpp UI" link, §3.8) ---
// Mirrors the server's sdBaseUrl(): 0.0.0.0 is reached locally as 127.0.0.1,
// and `-l` is the listen IP — the port row is --listen-port only.
function rowValue(key: string): string {
  const row = sd.value.serverArgs.find((p) => p.key === key && !p.disabled);
  return row?.value?.trim() ?? '';
}

const sdUiUrl = computed(() => {
  const port = rowValue('--listen-port');
  if (!/^\d+$/.test(port)) return '';
  const ip = rowValue('--listen-ip') || '127.0.0.1';
  return `http://${ip === '0.0.0.0' ? '127.0.0.1' : ip}:${port}/`;
});

// --- Model picker (Model tab) ---
// `modelConfigIds` is a selection list whose **first entry is loaded at
// startup**; the rest are swap candidates (§3.1). sd-server holds exactly one
// context, so Load swaps rather than adds.
const allModels = ref<ModelConfig[]>([]);
const modelFilter = ref('');

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data: ModelsFile = res.ok ? await res.json() : { configs: [], templates: [], defaultConfigId: null };
    allModels.value = data.configs.filter((m) => m.type === 'sdiffusion');
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

const selectedModelIds = computed(() => new Set(sd.value.modelConfigIds));

function toggleModelSelection(id: string) {
  const next = new Set(sd.value.modelConfigIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  sd.value.modelConfigIds = [...next];
}

// Keep the selection list in the saved order of the global model list.
function selectAllVisible() {
  const next = new Set(sd.value.modelConfigIds);
  for (const m of visibleModels.value) next.add(m.id);
  sd.value.modelConfigIds = allModels.value.filter((m) => next.has(m.id)).map((m) => m.id);
}

function clearModelSelection() {
  sd.value.modelConfigIds = [];
}

// --- Live model state (§3.10): loaded badge, loading spinner, Load/Unload ---
// The sd/* routes act on the *stored* instance, so they need a saved engine;
// and status polling only makes sense while the process is up.
const statusUrl = computed(() => `/api/engines/instances/${props.instance.id}/sd/models/status`);
// The sd/* routes act on the *stored* instance, so they need a saved engine (a
// draft has no id on the server yet). `status` is only present on instances that
// came back from GET /api/engines, which is exactly the saved case.
const canUseModelApi = computed(() => !props.isNew && props.instance.status !== undefined);
// Auto-polling only makes sense while the process is up — a stopped instance
// would answer every poll with a connection error. The manual Status button and
// Load/Unload still work (and report the 502 clearly) regardless.
const processLive = computed(() => {
  const s = props.instance.status;
  return s === 'running' || s === 'starting';
});

const modelStatus = ref<Record<string, unknown> | null>(null);
const statusError = ref('');
const statusLoading = ref(false);
const busyCardId = ref('');
const loadMessage = ref('');
const loadError = ref('');

const loadedRecipe = computed(() => {
  const s = modelStatus.value;
  return typeof s?.recipe === 'string' ? s.recipe : '';
});
const stateOf = computed(() => {
  const s = modelStatus.value;
  return typeof s?.state === 'string' ? s.state : '';
});
const statusErrorText = computed(() => {
  const s = modelStatus.value;
  return typeof s?.error === 'string' ? s.error : '';
});
/** The card whose recipe the server currently holds — drives the badge. */
const loadedCardId = computed(() => {
  const recipe = loadedRecipe.value;
  if (!recipe) return '';
  return sd.value.modelConfigIds.find((id) => {
    const card = allModels.value.find((m) => m.id === id);
    if (!card) return false;
    const r = typeof card.sdExtras?.recipe === 'string' ? card.sdExtras.recipe.trim() : '';
    return r === recipe || card.alias === recipe;
  }) ?? '';
});

async function fetchStatus() {
  if (!canUseModelApi.value) return;
  statusLoading.value = true;
  try {
    const res = await fetch(statusUrl.value);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      modelStatus.value = data;
      statusError.value = '';
    } else {
      modelStatus.value = null;
      statusError.value = typeof data.error === 'string' ? data.error : `Status failed (${res.status})`;
    }
  } catch (e) {
    modelStatus.value = null;
    statusError.value = String(e);
  } finally {
    statusLoading.value = false;
  }
}

// Poll while the Model tab is open: a swap takes tens of seconds (§3.10), so
// the spinner has to keep up. Faster while a load/unload is in flight. Only
// auto-poll while the process is live — a stopped instance would answer every
// poll with a connection error (the manual Status button still reports it).
let statusTimer: ReturnType<typeof setInterval> | null = null;
function restartStatusPoll() {
  if (statusTimer) clearInterval(statusTimer);
  if (activeTab.value !== 'models' || !processLive.value) return;
  statusTimer = setInterval(fetchStatus, busyCardId.value ? 1_500 : 5_000);
}
watch([activeTab, processLive], restartStatusPoll);
onMounted(() => {
  if (activeTab.value === 'models' && processLive.value) void fetchStatus();
});
onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
});

async function postSd(path: string, body?: unknown) {
  const res = await fetch(`/api/engines/instances/${props.instance.id}/sd/${path}`, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${res.status})`);
  }
  return data;
}

// Load (or swap to) one selected card. The server resolves the card's component
// paths to live file-ids and repairs an unknown recipe id (§3.3/§3.10), so this
// is just the action + its result text. A load blocks while weights read —
// tens of seconds — hence the busy state and the status poll picking up `loading`.
async function loadCard(id: string) {
  if (busyCardId.value) return;
  busyCardId.value = id;
  loadMessage.value = '';
  loadError.value = '';
  try {
    const data = await postSd('models/load', { modelConfigId: id });
    const seconds = typeof data.status?.load_elapsed_seconds === 'number'
      ? ` (${data.status.load_elapsed_seconds.toFixed(1)}s)`
      : '';
    loadMessage.value = `Loaded ${loadedAliasOf(id)}${seconds}${data.recipeWritten ? ` — wrote recipe "${data.recipeWritten}"` : ''}`;
    await fetchStatus();
  } catch (e) {
    loadError.value = (e as Error).message;
    await fetchStatus();
  } finally {
    busyCardId.value = '';
    restartStatusPoll();
  }
}

async function unloadModel() {
  if (busyCardId.value) return;
  busyCardId.value = '__unload__';
  loadMessage.value = '';
  loadError.value = '';
  try {
    await postSd('models/unload');
    loadMessage.value = 'Model unloaded — VRAM freed.';
    await fetchStatus();
  } catch (e) {
    loadError.value = (e as Error).message;
    await fetchStatus();
  } finally {
    busyCardId.value = '';
    restartStatusPoll();
  }
}

async function refreshCatalog() {
  if (busyCardId.value) return;
  busyCardId.value = '__refresh__';
  loadMessage.value = '';
  loadError.value = '';
  try {
    await postSd('models/refresh');
    loadMessage.value = 'Server catalog refreshed.';
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    busyCardId.value = '';
  }
}

function loadedAliasOf(id: string): string {
  return allModels.value.find((m) => m.id === id)?.alias ?? id;
}

// --- Raw JSON view (`extra` flags the UI has no row for) ---
const jsonText = ref('');
const jsonError = ref('');
const jsonApplied = ref(false);

watch(activeTab, (tab) => {
  if (tab === 'json') {
    jsonText.value = JSON.stringify(sd.value.extra ?? {}, null, 2);
    jsonError.value = '';
  }
});

function applyJson() {
  try {
    const parsed = JSON.parse(jsonText.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      jsonError.value = 'Expected a JSON object of flag keys.';
      return;
    }
    sd.value.extra = parsed as Record<string, unknown>;
    jsonError.value = '';
    jsonApplied.value = true;
    setTimeout(() => (jsonApplied.value = false), 1500);
  } catch (e) {
    jsonError.value = (e as Error).message;
  }
}

// --- Command preview (same driver path a real launch uses) ---
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

async function fetchCommand() {
  commandLoading.value = true;
  try {
    const res = await fetch('/api/engines/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'sdiffusion',
        instanceId: props.instance.id,
        executable: form.value.binary.trim() || 'sd-server',
        params: [],
        sd: { ...sd.value, envVars: collectEnvVars() },
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

watch([activeTab, sd, envRows, () => form.value.binary], () => {
  if (activeTab.value !== 'command') return;
  if (commandTimer) clearTimeout(commandTimer);
  commandTimer = setTimeout(fetchCommand, 250);
}, { deep: true });

const commandLines = computed(() => {
  const c = command.value;
  if (!c) return [];
  const lines: string[] = Object.entries(c.envVars ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}="${v}"`);
  lines.push(c.binaryPath);
  for (const arg of c.args) lines.push(/\s/.test(arg) ? `"${arg}"` : arg);
  return lines;
});

const commandText = computed(() =>
  commandLines.value
    .map((line, i) => (i < commandLines.value.length - 1 ? `${line} \\` : line))
    .join('\n'),
);

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
  return JSON.stringify({ form: form.value, sd: sd.value, envRows: envRows.value });
}
watch([form, sd, envRows], () => {
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
    const sdBody: SdConfig = {
      envVars: collectEnvVars(),
      serverArgs: cleanRows(sd.value.serverArgs),
      modelConfigIds: sd.value.modelConfigIds,
      extra: sd.value.extra ?? {},
    };

    // New engines are created here — the kind dropdown only opens the dialog.
    let target = props.instance;
    if (props.isNew) {
      const res = await fetch('/api/engines/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.value.name.trim(), kind: 'sdiffusion' }),
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
        kind: 'sdiffusion',
        // An sd engine carries its own config, so it has no shared definition.
        definitionId: '',
        binary: form.value.binary.trim() || 'sd-server',
        autoLaunch: form.value.autoLaunch,
        sd: sdBody,
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
  <Dialog :title="isNew ? 'New stable-diffusion.cpp Engine' : `stable-diffusion.cpp Engine: ${instance.name}`" :width="880" @close="requestClose">
    <div class="sd-editor">
      <div v-if="error" class="editor-error">{{ error }}</div>

      <div class="field-row">
        <div class="field">
          <label>Engine Name</label>
          <input v-model="form.name" type="text" placeholder="sd-image" />
        </div>
      </div>

      <div class="field">
        <label>Notes</label>
        <textarea v-model="form.notes" rows="2" placeholder="Which GPU this engine owns, model folders scanned, trade-offs..."></textarea>
      </div>

      <label class="check-row">
        <input v-model="form.autoLaunch" type="checkbox" />
        <span>Start this engine when the application launches</span>
      </label>

      <div class="tab-bar">
        <button class="tab-btn" :class="{ active: activeTab === 'launch' }" @click="activeTab = 'launch'">Server</button>
        <button class="tab-btn" :class="{ active: activeTab === 'models' }" @click="activeTab = 'models'">
          Model<template v-if="sd.modelConfigIds.length"> ({{ sd.modelConfigIds.length }})</template>
        </button>
        <button class="tab-btn" :class="{ active: activeTab === 'json' }" @click="activeTab = 'json'">Other Keys</button>
        <button class="tab-btn" :class="{ active: activeTab === 'command' }" @click="activeTab = 'command'">Command</button>
      </div>

      <template v-if="activeTab === 'launch'">
      <div class="field">
        <label>Executable (CMD)</label>
        <div class="path-row">
          <input v-model="form.binary" type="text" placeholder="/path/to/stable-diffusion.cpp/build/bin/sd-server" />
          <button
            class="btn refresh-btn"
            :disabled="checkingPath"
            @click="checkExecutablePath"
            title="Validate this path and fetch the sd-server build version"
          >{{ checkingPath ? '…' : '↻ Validate' }}</button>
        </div>
        <small>Full path to <code>sd-server</code>; the server runs from that folder. Weights are never on the command line — they load over the API (§3.10)</small>
        <div v-if="pathValid === false" class="version-info version-invalid">
          Invalid path — no executable found there.
        </div>
        <div v-else-if="versionInfo && (versionInfo.version || versionInfo.commit)" class="version-info">
          sd.cpp {{ versionInfo.version || '?' }}<template v-if="versionInfo.commit"> · git {{ versionInfo.commit.slice(0, 8) }}</template><template v-if="versionInfo.build"> · {{ versionInfo.build }}</template><template v-if="versionInfo.backend"> · {{ versionInfo.backend }}</template>
        </div>
      </div>

      <div class="field">
        <label>Environment Variables (ENV)</label>
        <div v-for="(row, idx) in envRows" :key="idx" class="env-row">
          <input v-model="row.key" type="text" placeholder="VAR_NAME" class="env-key" />
          <input v-model="row.value" type="text" placeholder="value" class="env-value" />
          <button class="remove-btn" @click="removeEnvRow(idx)" title="Remove">&times;</button>
        </div>
        <button class="add-env-btn" @click="addEnvRow">+ Add Variable</button>
        <small>Prefer <code>--backend</code> over <code>CUDA_VISIBLE_DEVICES</code>: the mask renumbers devices, so a masked <code>CUDA0</code> is not the <code>CUDA0</code> <code>--backend</code> names</small>
      </div>

      <div class="field">
        <label>Server Flags</label>
        <small class="tab-hint">
          <code>sd-server</code> reads no config file — these rows <em>are</em> the command line
          (<code>--listen-ip</code>, <code>--listen-port</code>, <code>--model-dir</code>,
          <code>--backend</code>, …). <code>--model-dir</code> is <strong>required</strong>, once per
          model folder, because models resolve to catalog file-ids under those roots. A row switched
          <code>off</code> is left out of the launch.
        </small>
        <ParamRows
          v-model="sd.serverArgs"
          :catalog="serverCatalog"
          :category-labels="SERVER_CATEGORY_LABELS"
          flag-placeholder="flag (e.g. --offload-to-cpu)"
        />
      </div>
      </template>

      <template v-else-if="activeTab === 'models'">
        <small class="tab-hint">
          sd-server holds <strong>one</strong> model context. The selected
          <code>type: sdiffusion</code> cards below are what the GUI can load; the
          <strong>first</strong> one is loaded automatically when the engine starts, and
          <strong>Load</strong> swaps to another without restarting (a full reload — tens of
          seconds for a large bundle). Generation runs in sd.cpp's own UI.
        </small>

        <div v-if="sdUiUrl" class="ui-link-row">
          <a class="ui-link" :href="sdUiUrl" target="_blank" rel="noopener">{{ sdUiUrl }}</a>
          <span class="tab-hint">open sd.cpp's Web UI (image / video generation)</span>
        </div>

        <div class="field">
          <div class="status-row">
            <span class="status-badge" :class="`state-${stateOf || 'unknown'}`">
              {{ statusLoading && !stateOf ? '…' : stateOf || 'no status' }}
            </span>
            <span v-if="loadedRecipe" class="status-recipe">loaded: {{ loadedRecipe }}</span>
            <button class="add-env-btn" :disabled="statusLoading" @click="fetchStatus">↻ Status</button>
            <button
              class="add-env-btn"
              :disabled="!canUseModelApi || busyCardId === '__refresh__'"
              @click="refreshCatalog"
              title="Re-scan the --model-dir roots on the running server"
            >↻ Refresh catalog</button>
            <button
              class="add-env-btn"
              :disabled="!canUseModelApi || busyCardId === '__unload__' || !stateOf || stateOf === 'empty'"
              @click="unloadModel"
              title="Unload the active model and free VRAM"
            >Unload</button>
          </div>
          <div v-if="statusError" class="version-info version-invalid">{{ statusError }}</div>
          <div v-else-if="stateOf === 'error' && statusErrorText" class="version-info version-invalid">
            Load failed: {{ statusErrorText }}
          </div>
          <div v-if="loadMessage" class="version-info">{{ loadMessage }}</div>
          <div v-if="loadError" class="version-info version-invalid">{{ loadError }}</div>
          <small v-if="!canUseModelApi" class="tab-hint">
            Save the engine first — Load / Unload / status act on a stored instance.
          </small>
        </div>

        <div class="field">
          <div class="router-toolbar">
            <input v-model="modelFilter" type="text" placeholder="Search models…" class="router-search" />
            <button class="add-env-btn" @click="selectAllVisible">Select shown</button>
            <button class="add-env-btn" @click="clearModelSelection">Clear</button>
          </div>
          <div v-if="!allModels.length" class="version-info version-invalid">
            No stable-diffusion model configs yet — create them on the Models tab.
          </div>
          <div v-else-if="!visibleModels.length" class="router-empty">No models match that search.</div>
          <div v-else class="model-list">
            <div v-for="m in visibleModels" :key="m.id" class="model-row" :class="{ 'is-selected': selectedModelIds.has(m.id) }">
              <input
                type="checkbox"
                :checked="selectedModelIds.has(m.id)"
                @change="toggleModelSelection(m.id)"
              />
              <span class="model-alias">{{ m.alias }}</span>
              <span v-if="sd.modelConfigIds[0] === m.id" class="model-tag" title="Loaded when the engine starts">startup</span>
              <span v-if="loadedCardId === m.id" class="model-tag model-tag-loaded" title="The context the server currently holds">loaded</span>
              <span class="model-path" :title="m.modelPath">{{ m.modelPath || '(no model path)' }}</span>
              <button
                class="add-env-btn"
                :disabled="!canUseModelApi || !selectedModelIds.has(m.id) || busyCardId !== ''"
                :title="`Load ${m.alias} now (swaps out the current model)`"
                @click="loadCard(m.id)"
              >{{ busyCardId === m.id ? 'Loading…' : 'Load' }}</button>
            </div>
          </div>
          <small v-if="sd.modelConfigIds.length === 0" class="version-info version-invalid">
            Launching needs at least one stable diffusion model — none selected.
          </small>
          <small v-else>Selected {{ sd.modelConfigIds.length }} of {{ allModels.length }} model config(s).</small>
        </div>
      </template>

      <template v-else-if="activeTab === 'json'">
        <small class="tab-hint">
          <code>sd-server</code> flags the UI has no row for. They are kept verbatim
          and re-emitted on export, mirroring the other engines' Other Keys tab.
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
            Working directory <code>{{ command.cwd || '(not set)' }}</code> · no config file is written —
            the model arrives over <code>/sdcpp/v1/models/load</code> once the server is up
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
.sd-editor {
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

.io-note {
  font-size: 0.72rem;
  color: #3fb950;
}

.io-error { color: #f85149; }

.env-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.env-key {
  flex: 0 0 200px;
}

.env-value {
  flex: 1;
}

.env-key, .env-value {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 10px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: 'Cascadia Code', monospace;
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

.ui-link-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ui-link {
  color: #58a6ff;
  font-size: 0.78rem;
  font-family: 'Cascadia Code', monospace;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.status-badge {
  font-size: 0.72rem;
  font-family: 'Cascadia Code', monospace;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #8b949e;
}

.status-badge.state-ready,
.status-badge.state-loaded { color: #3fb950; border-color: #238636; }
.status-badge.state-loading { color: #d29922; border-color: #9e6a03; }
.status-badge.state-error { color: #f85149; border-color: #da3633; }

.status-recipe {
  font-size: 0.74rem;
  color: #e1e4e8;
  font-family: 'Cascadia Code', monospace;
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

.add-env-btn:hover:not(:disabled) { color: #e1e4e8; background: #30363d; }
.add-env-btn:disabled { opacity: 0.45; cursor: not-allowed; }

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

.model-tag {
  font-size: 0.62rem;
  color: #8b949e;
  border: 1px solid #30363d;
  border-radius: 3px;
  padding: 1px 5px;
  flex-shrink: 0;
}

.model-tag-loaded {
  color: #3fb950;
  border-color: #238636;
}

.model-path {
  color: #484f58;
  font-size: 0.7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.router-empty {
  font-size: 0.75rem;
  color: #484f58;
  padding: 6px 0;
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
