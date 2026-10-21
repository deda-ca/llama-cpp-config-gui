<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import GpuMonitor from './components/GpuMonitor.vue';
import SystemMonitor from './components/SystemMonitor.vue';
import UsageStatus from './components/UsageStatus.vue';
import ConfigList from './components/ConfigList.vue';
import LogView from './components/LogView.vue';
import ProxyPanel from './components/ProxyPanel.vue';
import ProxyUsagePanel from './components/ProxyUsagePanel.vue';
import EnvironmentConfig from './components/EnvironmentConfig.vue';
import type { SystemStats, LogEntry, ModelStatusData, UsageRecord } from './types';

const gpus = ref<any[]>([]);
const systemStats = ref<SystemStats | null>(null);
const logLines = ref<LogEntry[]>([]);
const metrics = ref({ prefillTokensPerSec: null, generationTokensPerSec: null });
// Per-model token speeds parsed from llama.cpp logs
const modelMetrics = ref<Record<string, { prefillTokensPerSec: number | null; generationTokensPerSec: number | null }>>({});
const processStatus = ref('stopped');
const modelStatusData = ref<ModelStatusData | null>(null);
const appVersion = ref<string | null>(null);
const showEnv = ref(false);
// Self-update state (GitHub Releases)
interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  releaseUrl: string;
  assetName: string | null;
  canApply: boolean;
}
const updateInfo = ref<UpdateInfo | null>(null);
const updateChecking = ref(false);
const updateApplying = ref(false);

async function checkForUpdate() {
  if (updateChecking.value) return;
  updateChecking.value = true;
  try {
    const res = await fetch('/api/update/check');
    if (res.ok) {
      updateInfo.value = await res.json();
    } else {
      updateInfo.value = null;
    }
  } catch {
    updateInfo.value = null;
  } finally {
    updateChecking.value = false;
  }
}

function openReleasePage() {
  const info = updateInfo.value;
  if (info) window.open(info.releaseUrl, '_blank');
}

async function applyUpdate() {
  const info = updateInfo.value;
  if (!info || updateApplying.value) return;
  if (!info.canApply) {
    // Dev mode or no matching asset — send the user to the release page instead
    openReleasePage();
    return;
  }
  if (!confirm(`Update to v${info.latest}? This downloads the new version and replaces the current binary.`)) return;
  updateApplying.value = true;
  try {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      updateInfo.value = null;
      const backupNote = data.backupPath ? ` (previous version kept at ${data.backupPath})` : '';
      if (confirm(`Updated to v${data.latest}${backupNote}. Restart now to run the new version?`)) {
        restartServer();
      }
    } else {
      alert(`Update failed: ${data.error ?? 'unknown error'}`);
    }
  } catch (e) {
    alert(`Update failed: ${(e as Error).message}`);
  } finally {
    updateApplying.value = false;
  }
}
// Right-column tab selection, persisted across refreshes
const TAB_KEY = 'llama-gui:right-tab';
const TAB_VALUES = ['models', 'proxy', 'usage'] as const;
const rightTab = ref<'models' | 'proxy' | 'usage'>(
  (TAB_VALUES as readonly string[]).includes(localStorage.getItem(TAB_KEY) ?? '')
    ? (localStorage.getItem(TAB_KEY) as 'models' | 'proxy' | 'usage')
    : 'models',
);
function setRightTab(tab: 'models' | 'proxy' | 'usage') {
  rightTab.value = tab;
  localStorage.setItem(TAB_KEY, tab);
}
// Proxy log stream + latest usage event (fed by SSE)
const proxyLogLines = ref<LogEntry[]>([]);
const liveUsage = ref<UsageRecord | null>(null);
// Logs & Metrics collapsed state, persisted across refreshes
const LOGS_COLLAPSED_KEY = 'llama-gui:logs-collapsed';
const logsCollapsed = ref(localStorage.getItem(LOGS_COLLAPSED_KEY) === '1');
function toggleLogsCollapsed() {
  logsCollapsed.value = !logsCollapsed.value;
  localStorage.setItem(LOGS_COLLAPSED_KEY, logsCollapsed.value ? '1' : '0');
}
// SSE: EventSource auto-reconnects with backoff; no manual reconnect logic needed
let es: EventSource | null = null;

function connect() {
  es = new EventSource('/api/events');

  es.addEventListener('gpu-stats', (e) => {
    gpus.value = JSON.parse(e.data);
  });
  es.addEventListener('log-line', (e) => {
    logLines.value.push(JSON.parse(e.data));
    if (logLines.value.length > 2000) logLines.value.shift();
  });
  es.addEventListener('log-history', (e) => {
    // Server replays its in-memory cache on connect so logs survive refreshes
    logLines.value = JSON.parse(e.data);
  });
  es.addEventListener('metrics', (e) => {
    metrics.value = JSON.parse(e.data);
  });
  es.addEventListener('model-metrics', (e) => {
    modelMetrics.value = Object.fromEntries(
      (JSON.parse(e.data) as any[]).map((m) => [m.model, { prefillTokensPerSec: m.prefillTokensPerSec, generationTokensPerSec: m.generationTokensPerSec }]),
    );
  });
  es.addEventListener('process-status', (e) => {
    processStatus.value = JSON.parse(e.data);
  });
  es.addEventListener('system-stats', (e) => {
    systemStats.value = JSON.parse(e.data);
  });
  es.addEventListener('model-status', (e) => {
    modelStatusData.value = JSON.parse(e.data);
  });
  es.addEventListener('proxy-log', (e) => {
    proxyLogLines.value.push(JSON.parse(e.data));
    if (proxyLogLines.value.length > 2000) proxyLogLines.value.shift();
  });
  es.addEventListener('proxy-log-history', (e) => {
    proxyLogLines.value = JSON.parse(e.data);
  });
  es.addEventListener('proxy-usage', (e) => {
    liveUsage.value = JSON.parse(e.data);
  });
}

// This app's own version (baked into the server binary at build time)
async function fetchAppVersion() {
  try {
    const res = await fetch('/api/app-version');
    if (res.ok) {
      const data = await res.json();
      appVersion.value = data.version;
      document.title = `llama.cpp Config GUI (${data.version})`;
    }
  } catch { /* ignore */ }
}

// Sync process state from the server on load, so a refresh doesn't reset it to 'stopped'
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      const data = await res.json();
      processStatus.value = data.status;
      if (data.metrics) metrics.value = data.metrics;
      if (Array.isArray(data.modelMetrics)) {
        modelMetrics.value = Object.fromEntries(
          data.modelMetrics.map((m: any) => [m.model, { prefillTokensPerSec: m.prefillTokensPerSec, generationTokensPerSec: m.generationTokensPerSec }]),
        );
      }
      if (data.systemStats) systemStats.value = data.systemStats;
      if (data.modelStatus) modelStatusData.value = data.modelStatus;
    }
  } catch { /* ignore */ }
}

// Stop the llama.cpp process and shut down the Node server
async function shutdownServer() {
  if (!confirm('Shut down? This stops llama.cpp and the GUI server.')) return;
  try {
    await fetch('/api/shutdown', { method: 'POST' });
  } catch { /* server is already going away */ }
  document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-size:1.2rem;color:#8b949e">Server shut down.</div>';
}

// Restart the GUI server (the release binary re-spawns itself; dev relies on tsx watch)
async function restartServer() {
  if (!confirm('Restart the GUI server? llama.cpp will be stopped.')) return;
  try {
    await fetch('/api/restart', { method: 'POST' });
  } catch { /* server is restarting */ }
  document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-size:1.2rem;color:#8b949e">Restarting… reload this page in a moment.</div>';
}

onMounted(() => {
  connect();
  fetchAppVersion();
  fetchStatus();
});

onUnmounted(() => {
  es?.close();
});
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>
        llama.cpp Config GUI<template v-if="appVersion"> ({{ appVersion }})</template>
        <button
          class="update-check-btn"
          :class="{ spinning: updateChecking }"
          :disabled="updateChecking"
          @click="checkForUpdate"
          :title="updateChecking ? 'Checking for updates…' : 'Check GitHub for a new version'"
        >⟳</button>
        <button
          v-if="updateInfo?.available"
          class="upgrade-btn"
          :class="{ applying: updateApplying }"
          :disabled="updateApplying"
          :title="updateApplying ? `Downloading v${updateInfo.latest}…` : `New version v${updateInfo.latest} available — click to download and replace the current binary`"
          @click="applyUpdate"
        >⬆ v{{ updateInfo.latest }}<span v-if="updateApplying" class="upgrade-spin">…</span></button>
        <a
          v-if="updateInfo?.available"
          class="release-link"
          :href="updateInfo.releaseUrl"
          target="_blank"
          rel="noopener"
          title="Open the GitHub release page"
        >↗</a>
      </h1>
      <div class="header-right">
        <span class="status-badge" :class="processStatus">{{ processStatus }}</span>
        <button class="restart-btn" @click="restartServer" title="Restart the GUI server">⟳ Restart</button>
        <button class="shutdown-btn" @click="shutdownServer" title="Stop llama.cpp and shut down the server">⏻ Shutdown</button>
      </div>
    </header>

    <main class="main">
      <!-- Left: GPU Monitor + System Monitor -->
      <div class="left-col">
        <section class="panel gpu-panel">
          <GpuMonitor :gpus="gpus" />
        </section>
        <section class="panel system-panel">
          <SystemMonitor :stats="systemStats" />
        </section>
        <section class="panel usage-status-panel">
          <UsageStatus :live-usage="liveUsage" />
        </section>
      </div>

      <!-- Right: tabbed — Models (config list + logs) or Proxy (settings, usage, logs) -->
      <div class="right-col">
        <nav class="tab-bar">
          <button class="tab" :class="{ active: rightTab === 'models' }" @click="setRightTab('models')">
            <span class="tab-icon">▤</span> Models
          </button>
          <button class="tab" :class="{ active: rightTab === 'proxy' }" @click="setRightTab('proxy')">
            <span class="tab-icon">⇄</span> Proxy
          </button>
          <button class="tab" :class="{ active: rightTab === 'usage' }" @click="setRightTab('usage')">
            <span class="tab-icon">▮</span> Usage
          </button>
        </nav>

        <template v-if="rightTab === 'models'">
          <section class="panel config-section">
            <ConfigList :model-metrics="modelMetrics" @open-env="showEnv = true" />
          </section>
          <section class="panel log-panel" :class="{ collapsed: logsCollapsed }">
            <LogView
              :lines="logLines"
              :metrics="metrics"
              :collapsed="logsCollapsed"
              @toggle-collapse="toggleLogsCollapsed"
              @clear-logs="logLines = []"
            />
          </section>
        </template>
        <template v-else-if="rightTab === 'proxy'">
          <section class="panel proxy-section">
            <ProxyPanel :lines="proxyLogLines" />
          </section>
        </template>
        <template v-else>
          <section class="panel usage-tab-section">
            <ProxyUsagePanel :live-usage="liveUsage" />
          </section>
        </template>
      </div>
    </main>

    <!-- Environment dialog (self-contained) -->
    <EnvironmentConfig v-if="showEnv" @close="showEnv = false" />
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body {
  height: 100%;
  overflow: hidden; /* single-page app: no page scrollbar, panels scroll internally */
}

body {
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  background: #0f1117;
  color: #e1e4e8;
}

.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
}

.header h1 {
  font-size: 1.1rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}

.update-check-btn {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 0.95rem;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
}

.update-check-btn:hover {
  color: #e1e4e8;
  background: #30363d;
}

.update-check-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

.update-check-btn.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.upgrade-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #23863633;
  border: 1px solid #3fb95066;
  border-radius: 12px;
  color: #3fb950;
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  padding: 5px 11px;
  cursor: pointer;
  text-decoration: none;
}

.upgrade-btn:hover {
  background: #23863655;
  border-color: #3fb950;
}

.upgrade-btn.applying {
  opacity: 0.7;
  cursor: wait;
}

.upgrade-spin {
  animation: blink 1s steps(2) infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.release-link {
  color: #8b949e;
  font-size: 0.8rem;
  text-decoration: none;
  padding: 2px 4px;
  border-radius: 4px;
}

.release-link:hover {
  color: #79c0ff;
  background: #30363d;
}

.status-badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.version-badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  background: #388bfd22;
  color: #79c0ff;
  border: 1px solid #388bfd44;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Responsive: below 800px, hide the right column and shrink the header */
@media (max-width: 800px) {
  .header h1 {
    display: none;
  }

  .main {
    grid-template-columns: minmax(0, 400px);
  }

  .right-col {
    display: none;
  }
}

.status-badge.stopped { background: #30363d; color: #8b949e; }
.status-badge.starting { background: #1f6feb33; color: #58a6ff; }
.status-badge.running { background: #23863633; color: #3fb950; }
.status-badge.exited { background: #30363d; color: #8b949e; }
.status-badge.error { background: #da363333; color: #f85149; }

.restart-btn {
  background: none;
  border: 1px solid #388bfd66;
  border-radius: 12px;
  color: #79c0ff;
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  padding: 5px 11px;
  cursor: pointer;
}

.restart-btn:hover {
  background: #388bfd22;
  border-color: #79c0ff;
}

.shutdown-btn {
  background: none;
  border: 1px solid #da363366;
  border-radius: 12px;
  color: #f85149;
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  padding: 5px 11px; /* 1px border + 3px padding = same outer size as the status pill */
  cursor: pointer;
}

.shutdown-btn:hover {
  background: #da363322;
  border-color: #f85149;
}

.main {
  flex: 1;
  display: grid;
  grid-template-columns: 400px 1fr;
  gap: 12px;
  padding: 12px 16px;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.left-col,
.right-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  min-width: 0;
}

.panel {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.gpu-panel {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 120px;
}

.system-panel {
  flex: 0 0 auto;
  overflow-y: auto;
  min-height: 0;
}

.usage-status-panel {
  flex: 0 0 auto;
  overflow-y: auto;
  min-height: 0;
}

.log-panel {
  flex: 1 1 50%;
  min-height: 0;
}

.log-panel.collapsed {
  flex: 0 0 auto;
}

.config-section {
  flex: 1 1 50%;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}

.proxy-section {
  flex: 1 1 auto;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}

.usage-tab-section {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
  min-width: 0;
}

/* Right-column tab bar */
.tab-bar {
  display: flex;
  gap: 4px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 4px;
  flex: 0 0 auto;
}

.tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  background: none;
  border: none;
  border-radius: 6px;
  color: #8b949e;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 7px 12px;
  cursor: pointer;
}

.tab:hover {
  color: #e1e4e8;
  background: #21262d;
}

.tab.active {
  background: #21262d;
  color: #e1e4e8;
  box-shadow: inset 0 -2px 0 #58a6ff;
}

.tab-icon {
  font-size: 0.9rem;
}

</style>
