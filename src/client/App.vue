<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import GpuMonitor from './components/GpuMonitor.vue';
import SystemMonitor from './components/SystemMonitor.vue';
import ModelStatus from './components/ModelStatus.vue';
import ConfigList from './components/ConfigList.vue';
import LogView from './components/LogView.vue';
import EnvironmentConfig from './components/EnvironmentConfig.vue';
import type { SystemStats, LogEntry, ModelStatusData } from './types';

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

async function clearModelStatus() {
  try {
    await fetch('/api/model-status/clear', { method: 'POST' });
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
      <h1>llama.cpp Config GUI<template v-if="appVersion"> ({{ appVersion }})</template></h1>
      <div class="header-right">
        <span class="status-badge" :class="processStatus">{{ processStatus }}</span>
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
        <section class="panel model-status-panel">
          <ModelStatus :status="modelStatusData" @clear="clearModelStatus" />
        </section>
      </div>

      <!-- Right: Config List + Editor, with Logs & Metrics below -->
      <div class="right-col">
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

</style>
