<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import type { UsageRecord, UsageSummaryRow } from '../types';

const props = defineProps<{
  /** Latest completed request, streamed over SSE (event: proxy-usage) */
  liveUsage: UsageRecord | null;
  collapsed?: boolean;
}>();

const emit = defineEmits(['toggle-collapse']);

const summary = ref<UsageSummaryRow[]>([]);
const recent = ref<UsageRecord[]>([]);

async function loadUsage() {
  try {
    const [sumRes, rowsRes] = await Promise.all([
      fetch('/api/proxy/usage/summary'),
      fetch('/api/proxy/usage?limit=15'),
    ]);
    if (sumRes.ok) summary.value = (await sumRes.json()).rows;
    if (rowsRes.ok) recent.value = (await rowsRes.json()).rows;
  } catch { /* usage is best-effort */ }
}

// Live rows: prepend each completed request and refresh aggregates (debounced)
let usageTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.liveUsage,
  (rec) => {
    if (!rec) return;
    recent.value = [rec, ...recent.value].slice(0, 15);
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = setTimeout(loadUsage, 800);
  },
);

onMounted(loadUsage);

function fmtTok(n: number | null): string {
  if (n === null) return '--';
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtAgo(iso: string | null): string {
  if (!iso) return '--';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
</script>

<template>
  <div class="usage-panel">
    <div class="usage-header">
      <h2 class="section-title">Usage</h2>
      <div class="usage-totals" v-if="summary.length > 0">
        <div class="metric">
          <span class="metric-label">Requests</span>
          <span class="metric-value">{{ summary.reduce((a, r) => a + r.requests, 0) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Tokens</span>
          <span class="metric-value highlight">{{ fmtTok(summary.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0)) }}</span>
        </div>
      </div>
      <div class="usage-actions">
        <a v-if="!props.collapsed" class="collapse-btn" href="/api/proxy/usage/export" title="Download usage as CSV">⬇ CSV</a>
        <button class="collapse-btn" @click="emit('toggle-collapse')" :title="props.collapsed ? 'Expand usage' : 'Collapse usage'">
          {{ props.collapsed ? '▸ Expand' : '▾ Collapse' }}
        </button>
      </div>
    </div>

    <div v-if="!props.collapsed" class="usage-body">
      <table class="usage-table" v-if="summary.length > 0">
        <thead>
          <tr><th>Model</th><th>Backend</th><th>Reqs</th><th>In</th><th>Out</th><th>t/s</th><th>TTFB</th><th>Last used</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in summary" :key="r.model + r.backend">
            <td>{{ r.model }}</td>
            <td>{{ r.backend }}</td>
            <td>{{ r.requests }}</td>
            <td>{{ fmtTok(r.inputTokens) }}</td>
            <td>{{ fmtTok(r.outputTokens) }}</td>
            <td>{{ r.avgTokensPerSec !== null ? r.avgTokensPerSec.toFixed(1) : '--' }}</td>
            <td>{{ r.avgTtfbMs !== null ? Math.round(r.avgTtfbMs) + 'ms' : '--' }}</td>
            <td>{{ fmtAgo(r.lastUsed) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="recent-list" v-if="recent.length > 0">
        <div v-for="r in recent" :key="r.requestId" class="recent-row">
          {{ r.timestamp.slice(11, 19) }} · {{ r.backend }} · {{ r.model }} · {{ r.endpoint }} · {{ r.stream ? 'stream' : 'json' }} · {{ r.status }} · {{ r.totalDurationMs }}ms<template v-if="r.inputTokens !== null || r.outputTokens !== null"> · {{ r.inputTokens ?? '?' }}→{{ r.outputTokens ?? '?' }} tok</template><template v-if="r.tokensPerSec !== null"> · {{ r.tokensPerSec.toFixed(1) }} t/s</template><template v-if="r.tokensEstimated"> (est)</template>
        </div>
      </div>
      <pre v-if="summary.length === 0 && recent.length === 0" class="empty">No usage recorded yet. Start the proxy and send a request.</pre>
    </div>
  </div>
</template>

<style scoped>
.usage-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.usage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.usage-totals {
  display: flex;
  gap: 16px;
}

.metric {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 10px;
}

.metric-label {
  font-size: 0.75rem;
  color: #8b949e;
}

.metric-value {
  font-size: 0.9rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.metric-value.highlight {
  color: #3fb950;
}

.usage-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
}

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

.collapse-btn:hover {
  border-color: #58a6ff;
  color: #58a6ff;
}

.usage-body {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 12px;
  overflow-y: auto;
  min-height: 0;
}

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}

.usage-table th {
  text-align: left;
  color: #8b949e;
  font-weight: 600;
  padding: 4px 8px;
  border-bottom: 1px solid #30363d;
  text-transform: uppercase;
  font-size: 0.68rem;
  letter-spacing: 0.4px;
}

.usage-table td {
  padding: 4px 8px;
  border-bottom: 1px solid #21262d;
  font-variant-numeric: tabular-nums;
}

.recent-list {
  margin-top: 10px;
}

.recent-row {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.74rem;
  color: #8b949e;
  padding: 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty {
  color: #484f58;
  font-style: italic;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.78rem;
}
</style>
