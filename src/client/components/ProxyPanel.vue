<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import Dialog from './ui/Dialog.vue';
import type { LogEntry, ProxyBackend, ProxyBackendKind, ProxySettings, ProxyStatus } from '../types';

const props = defineProps<{
  /** Proxy log lines streamed over SSE (event: proxy-log) */
  lines: LogEntry[];
}>();

// --- Settings form ---
const settings = ref<ProxySettings | null>(null);
const status = ref<ProxyStatus | null>(null);
const saving = ref(false);
const savedFlash = ref(false);
const loadError = ref<string | null>(null);

async function loadSettings() {
  try {
    const res = await fetch('/api/proxy/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    settings.value = await res.json();
  } catch (e) {
    loadError.value = `Failed to load proxy settings: ${e}`;
  }
}

async function loadStatus() {
  try {
    const res = await fetch('/api/proxy/status');
    if (res.ok) status.value = await res.json();
  } catch { /* status is best-effort */ }
}

async function save() {
  if (!settings.value) return;
  saving.value = true;
  loadError.value = null;
  try {
    const res = await fetch('/api/proxy/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings.value),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    settings.value = await res.json();
    savedFlash.value = true;
    setTimeout(() => (savedFlash.value = false), 1500);
    loadStatus();
  } catch (e) {
    loadError.value = `Save failed: ${e}`;
  } finally {
    saving.value = false;
  }
}

// --- Start / Stop / Restart ---
const running = computed(() => status.value?.running ?? false);
const proxyBusy = ref(false);

async function proxyAction(action: 'start' | 'stop' | 'restart') {
  proxyBusy.value = true;
  loadError.value = null;
  try {
    const res = await fetch(`/api/proxy/${action}`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
  } catch (e) {
    loadError.value = `${action} failed: ${e}`;
  } finally {
    proxyBusy.value = false;
    await loadStatus();
    if (settings.value) settings.value.enabled = running.value;
  }
}

// --- Backend (proxy) list ---
const KIND_LABELS: Record<ProxyBackendKind, string> = {
  llamacpp: 'llama.cpp',
  audio: 'audio',
  sdiffusion: 'image',
  custom: 'custom',
};

interface BackendForm {
  id: string | null; // null = new
  name: string;
  kind: ProxyBackendKind;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}
const editForm = ref<BackendForm | null>(null);
const backendError = ref<string | null>(null);

function newBackend() {
  backendError.value = null;
  editForm.value = { id: null, name: '', kind: 'custom', baseUrl: 'http://127.0.0.1:', enabled: true, apiKey: '' };
}
function editBackend(b: ProxyBackend) {
  backendError.value = null;
  editForm.value = { id: b.id, name: b.name, kind: b.kind, baseUrl: b.baseUrl, apiKey: b.apiKey ?? '', enabled: b.enabled };
}

async function saveBackend() {
  if (!editForm.value || !settings.value) return;
  const f = editForm.value;
  const payload = { name: f.name, kind: f.kind, baseUrl: f.baseUrl, apiKey: f.apiKey, enabled: f.enabled };
  try {
    const url = f.id ? `/api/proxy/backends/${f.id}` : '/api/proxy/backends';
    const res = await fetch(url, {
      method: f.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      backendError.value = body.error ?? `HTTP ${res.status}`;
      return;
    }
    settings.value.backends = await fetch('/api/proxy/settings').then((r) => r.json()).then((s: ProxySettings) => s.backends);
    editForm.value = null;
    loadStatus();
  } catch (e) {
    backendError.value = `Save failed: ${e}`;
  }
}

async function deleteBackend(b: ProxyBackend) {
  if (!settings.value) return;
  if (!confirm(`Delete proxy "${b.name}" (${b.baseUrl})? Routes pointing at it are removed too.`)) return;
  try {
    const res = await fetch(`/api/proxy/backends/${b.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    settings.value.backends = settings.value.backends.filter((x) => x.id !== b.id);
    loadStatus();
  } catch (e) {
    loadError.value = `Delete failed: ${e}`;
  }
}

const refreshing = ref<Set<string>>(new Set());
const refreshErrors = ref<Record<string, string>>({});

async function refreshBackendModels(b: ProxyBackend) {
  if (!settings.value) return;
  refreshing.value = new Set([...refreshing.value, b.id]);
  delete refreshErrors.value[b.id];
  try {
    const res = await fetch(`/api/proxy/backends/${b.id}/refresh`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    b.models = body.models;
    b.modelsFetchedAt = body.modelsFetchedAt;
  } catch (e) {
    refreshErrors.value = { ...refreshErrors.value, [b.id]: e instanceof Error ? e.message : String(e) };
  } finally {
    const next = new Set(refreshing.value);
    next.delete(b.id);
    refreshing.value = next;
  }
}

async function toggleBackend(b: ProxyBackend) {
  if (!settings.value) return;
  try {
    const res = await fetch(`/api/proxy/backends/${b.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !b.enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    b.enabled = !b.enabled;
    loadStatus();
  } catch (e) {
    loadError.value = `Toggle failed: ${e}`;
  }
}

// Status polling: backend health + running state
let statusTimer: ReturnType<typeof setInterval> | null = null;

// --- Proxy logs ---
const logContainer = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const logsCollapsed = ref(localStorage.getItem('llama-gui:proxy-logs-collapsed') === '1');
function toggleLogsCollapsed() {
  logsCollapsed.value = !logsCollapsed.value;
  localStorage.setItem('llama-gui:proxy-logs-collapsed', logsCollapsed.value ? '1' : '0');
}
watch(
  () => props.lines.length,
  async () => {
    if (!autoScroll.value || logsCollapsed.value) return;
    await nextTick();
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight;
  },
);
function onLogScroll() {
  const el = logContainer.value;
  if (!el) return;
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
async function clearProxyLogs() {
  try {
    await fetch('/api/proxy/logs/clear', { method: 'POST' });
  } catch { /* ignore */ }
}

onMounted(() => {
  loadSettings();
  loadStatus();
  statusTimer = setInterval(loadStatus, 10_000);
});
onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
});
</script>

<template>
  <div class="proxy-panel">
    <!-- Header: title, status, start/stop/restart -->
    <div class="toolbar">
      <h2 class="section-title">Proxy Server</h2>
      <span class="proxy-status" :class="running ? 'on' : 'off'">{{ running ? 'Running' : 'Stopped' }}</span>
      <span v-if="running && status" class="proxy-url">{{ status.url }}</span>
      <div class="toolbar-actions">
        <button v-if="!running" class="btn btn-sm btn-launch" :disabled="proxyBusy" @click="proxyAction('start')">Start</button>
        <button v-else class="btn btn-sm btn-stop" :disabled="proxyBusy" @click="proxyAction('stop')">Stop</button>
        <button class="btn btn-sm" :disabled="proxyBusy" @click="proxyAction('restart')">Restart</button>
      </div>
    </div>

    <!-- Settings row -->
    <div class="settings-row" v-if="settings">
      <label class="field">
        <span>Port</span>
        <input type="number" v-model.number="settings.port" min="1" max="65535" />
      </label>
      <label class="field">
        <span>Host</span>
        <input type="text" v-model="settings.host" />
      </label>
      <label class="field">
        <span>API Key</span>
        <input type="password" v-model="settings.apiKey" placeholder="(no auth)" />
      </label>
      <label class="field">
        <span>Retention (days)</span>
        <input type="number" v-model.number="settings.usageRetentionDays" min="1" />
      </label>
      <label class="check-field" title="Start the proxy automatically when the GUI server boots">
        <input type="checkbox" v-model="settings.autoStart" />
        <span>Auto-start</span>
      </label>
      <div class="settings-actions">
        <button class="btn btn-sm btn-primary" :disabled="saving" @click="save">{{ saving ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save' }}</button>
      </div>
    </div>

    <div v-if="loadError" class="error-banner">{{ loadError }}</div>

    <!-- Proxy (backend) list -->
    <div class="backends-section">
      <div class="sub-header">
        <h3 class="sub-title">Proxies</h3>
        <button class="btn btn-sm btn-primary" @click="newBackend">+ New</button>
      </div>
      <div class="backend-list" v-if="settings">
        <div v-for="b in settings.backends" :key="b.id" class="backend-item">
          <div class="backend-row" :class="{ disabled: !b.enabled }">
            <input
              type="checkbox"
              class="backend-check"
              :checked="b.enabled"
              :title="b.enabled ? 'Disable proxy' : 'Enable proxy'"
              @change="toggleBackend(b)"
            />
            <span class="backend-name">{{ b.name }}</span>
            <span class="backend-kind" :class="'kind-' + b.kind">{{ KIND_LABELS[b.kind] }}</span>
            <span class="backend-url">{{ b.baseUrl }}</span>
            <span
              class="health-dot"
              :class="{ up: status?.backends[b.id] === true, down: status?.backends[b.id] === false, off: !b.enabled }"
              :title="!b.enabled ? 'Disabled' : status?.backends[b.id] ? 'Reachable' : 'Unreachable'"
            ></span>
            <button
              class="row-btn"
              :class="{ spinning: refreshing.has(b.id) }"
              :disabled="refreshing.has(b.id)"
              title="Test URL and fetch models from this proxy"
              @click="refreshBackendModels(b)"
            >⟳</button>
            <button class="row-btn" title="Edit" @click="editBackend(b)">✎</button>
            <button class="row-btn danger" title="Delete" @click="deleteBackend(b)">✕</button>
          </div>
          <div v-if="refreshErrors[b.id]" class="backend-models error">{{ refreshErrors[b.id] }}</div>
          <div v-else-if="b.models && b.models.length > 0" class="backend-models">
            <span class="models-label" :title="b.modelsFetchedAt ? 'Fetched ' + b.modelsFetchedAt : ''">
              Models ({{ b.models.length }}):
            </span>
            <span v-for="m in b.models" :key="m" class="model-chip">{{ m }}</span>
          </div>
          <div v-else-if="b.modelsFetchedAt" class="backend-models empty">No models reported by this proxy.</div>
        </div>
        <div v-if="settings.backends.length === 0" class="empty-hint">No proxies yet. Add one with + New.</div>
      </div>
    </div>

    <!-- Proxy logs -->
    <div class="logs-section" :class="{ collapsed: logsCollapsed }">
      <div class="sub-header">
        <h3 class="sub-title">Proxy Logs</h3>
        <div class="log-actions">
          <button v-if="!logsCollapsed && lines.length > 0" class="collapse-btn" @click="clearProxyLogs" title="Clear proxy logs">✕ Clear</button>
          <button class="collapse-btn" @click="toggleLogsCollapsed" :title="logsCollapsed ? 'Expand logs' : 'Collapse logs'">
            {{ logsCollapsed ? '▸ Expand' : '▾ Collapse' }}
          </button>
        </div>
      </div>
      <div v-if="!logsCollapsed" ref="logContainer" class="log-container" @scroll="onLogScroll">
        <pre v-if="lines.length === 0" class="empty">No proxy activity yet.</pre>
        <div v-for="(line, i) in lines" :key="i" class="log-line" :class="'level-' + line.level">{{ line.raw }}</div>
      </div>
    </div>

    <!-- Backend edit dialog -->
    <Dialog v-if="editForm" :title="editForm.id ? `Edit proxy` : 'New proxy'" :width="480" @close="editForm = null">
      <div class="form-grid">
        <label class="field">
          <span>Name</span>
          <input type="text" v-model="editForm.name" placeholder="audio.cpp" />
        </label>
        <label class="field">
          <span>Type</span>
          <select v-model="editForm.kind">
            <option value="llamacpp">llama.cpp (text)</option>
            <option value="audio">audio</option>
            <option value="sdiffusion">image (stable-diffusion)</option>
            <option value="custom">custom</option>
          </select>
        </label>
        <label class="field wide">
          <span>URL</span>
          <input type="text" v-model="editForm.baseUrl" placeholder="http://127.0.0.1:8082" />
        </label>
        <label class="field wide">
          <span>Upstream API key (optional)</span>
          <input type="password" v-model="editForm.apiKey" placeholder="(none)" />
        </label>
        <label class="check-field">
          <input type="checkbox" v-model="editForm.enabled" />
          <span>Enabled</span>
        </label>
        <div v-if="backendError" class="error-banner">{{ backendError }}</div>
      </div>
      <template #footer>
        <button class="btn btn-sm" @click="editForm = null">Cancel</button>
        <button class="btn btn-sm btn-primary" :disabled="!editForm.name || !editForm.baseUrl" @click="saveBackend">Save</button>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.proxy-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* --- Toolbar (Models-tab style) --- */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.toolbar-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.proxy-status {
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
}
.proxy-status.on { background: #23863633; color: #3fb950; }
.proxy-status.off { background: #30363d; color: #8b949e; }
.proxy-url {
  font-size: 0.75rem;
  color: #8b949e;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.btn {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #e1e4e8;
  font-family: inherit;
  font-size: 0.8rem;
  padding: 6px 14px;
  cursor: pointer;
}
.btn:hover { background: #30363d; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: #238636; border-color: #238636; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #2ea043; }
.btn-launch { background: #1f6feb; border-color: #1f6feb; color: #fff; }
.btn-launch:hover:not(:disabled) { background: #388bfd; }
.btn-stop { background: #da363344; border-color: #da3633; color: #f85149; }
.btn-stop:hover:not(:disabled) { background: #f85149; color: #fff; }
.btn-sm { padding: 4px 10px; font-size: 0.75rem; }

/* --- Settings row --- */
.settings-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px 12px;
  flex-shrink: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field span, .check-field span {
  font-size: 0.7rem;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.field input, .field select {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #e1e4e8;
  font-family: inherit;
  font-size: 0.8rem;
  padding: 5px 8px;
  width: 110px;
}
.field.wide input { width: 100%; }
.field input:focus, .field select:focus { outline: none; border-color: #58a6ff; }
.check-field {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 5px;
  cursor: pointer;
}
.check-field input { accent-color: #238636; }
.settings-actions { margin-left: auto; }

.error-banner {
  background: #da363322;
  border: 1px solid #f8514966;
  color: #f85149;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 0.78rem;
}

/* --- Backend list --- */
.backends-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}
.sub-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sub-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.sub-header .btn { margin-left: auto; }
.log-actions { margin-left: auto; display: flex; gap: 6px; }
.backend-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.backend-item {
  display: flex;
  flex-direction: column;
}
.backend-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px 12px;
}
.backend-models {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  padding: 6px 12px 8px 34px;
  margin-top: -1px;
  border: 1px solid #30363d;
  border-top: none;
  border-radius: 0 0 6px 6px;
  background: #0d1117;
}
.backend-models.error {
  color: #f85149;
  font-size: 0.74rem;
}
.backend-models.empty {
  color: #484f58;
  font-size: 0.74rem;
  font-style: italic;
}
.models-label {
  font-size: 0.7rem;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.model-chip {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.72rem;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 10px;
  padding: 2px 9px;
  color: #79c0ff;
}
.row-btn.spinning {
  animation: spin 0.9s linear infinite;
  color: #58a6ff;
  border-color: #58a6ff;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.backend-row.disabled { opacity: 0.55; }
.backend-check { accent-color: #238636; flex-shrink: 0; }
.backend-name {
  font-size: 0.82rem;
  font-weight: 600;
  min-width: 120px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.backend-kind {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}
.kind-llamacpp { background: #388bfd22; color: #79c0ff; }
.kind-audio { background: #a371f722; color: #d2a8ff; }
.kind-sdiffusion { background: #db6d2822; color: #f0883e; }
.kind-custom { background: #30363d; color: #8b949e; }
.backend-url {
  flex: 1;
  font-size: 0.75rem;
  color: #8b949e;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.health-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #484f58;
}
.health-dot.up { background: #3fb950; }
.health-dot.down { background: #f85149; }
.health-dot.off { background: #30363d; }
.row-btn {
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  color: #8b949e;
  font-size: 0.8rem;
  padding: 3px 7px;
  cursor: pointer;
  flex-shrink: 0;
}
.row-btn:hover { border-color: #58a6ff; color: #58a6ff; }
.row-btn.danger:hover { border-color: #f85149; color: #f85149; }
.empty-hint {
  color: #484f58;
  font-size: 0.78rem;
  font-style: italic;
  padding: 6px 2px;
}

/* --- Proxy logs --- */
.logs-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 40%;
  min-height: 90px;
}
.logs-section.collapsed { flex: 0 0 auto; }
.log-container {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 10px;
  overflow-y: auto;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.76rem;
  line-height: 1.5;
  min-height: 80px;
}
.log-line { white-space: pre-wrap; word-break: break-all; }
.log-line.level-I { color: #e1e4e8; }
.log-line.level-W { color: #d29922; }
.log-line.level-E { color: #f85149; }
.log-line.level-F { color: #ff7b72; font-weight: 600; }
.log-line.level-plain { color: #8b949e; }
.empty { color: #484f58; font-style: italic; }

.collapse-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #8b949e;
  font-size: 0.72rem;
  padding: 3px 10px;
  cursor: pointer;
  flex-shrink: 0;
  text-decoration: none;
  font-family: inherit;
}
.collapse-btn:hover { border-color: #58a6ff; color: #58a6ff; }

/* --- Dialog form --- */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-grid .field.wide, .form-grid .check-field, .form-grid .error-banner {
  grid-column: 1 / -1;
}
</style>
