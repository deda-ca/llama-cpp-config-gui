<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import Dialog from './ui/Dialog.vue';
import type { ModelPricing, UsageRecord, UsageSummaryRow } from '../types';

const props = defineProps<{
  /** Latest completed request, streamed over SSE (event: proxy-usage) */
  liveUsage: UsageRecord | null;
  collapsed?: boolean;
}>();

const emit = defineEmits(['toggle-collapse']);

const summary = ref<UsageSummaryRow[]>([]);
const recent = ref<UsageRecord[]>([]);
const pricing = ref<Record<string, ModelPricing>>({});

// --- Pricing dialog ---
const pricingOpen = ref(false);
const pricingDraft = ref<Record<string, { input: string; cached: string; output: string }>>({});

async function loadUsage() {
  try {
    const [sumRes, rowsRes, priceRes] = await Promise.all([
      fetch('/api/proxy/usage/summary'),
      fetch('/api/proxy/usage?limit=15'),
      fetch('/api/proxy/settings'),
    ]);
    if (sumRes.ok) summary.value = (await sumRes.json()).rows;
    if (rowsRes.ok) recent.value = (await rowsRes.json()).rows;
    if (priceRes.ok) pricing.value = (await priceRes.json()).modelPricing ?? {};
  } catch { /* usage is best-effort */ }
}

function openPricing() {
  const draft: Record<string, { input: string; cached: string; output: string }> = {};
  for (const r of summary.value) {
    if (!draft[r.model]) {
      const p = pricing.value[r.model];
      draft[r.model] = {
        input: p ? String(p.input) : '',
        cached: p ? String(p.cached) : '',
        output: p ? String(p.output) : '',
      };
    }
  }
  // Keep models that have pricing but no usage yet
  for (const [model, p] of Object.entries(pricing.value)) {
    if (!draft[model]) draft[model] = { input: String(p.input), cached: String(p.cached), output: String(p.output) };
  }
  pricingDraft.value = draft;
  pricingOpen.value = true;
}

async function savePricing() {
  const next: Record<string, ModelPricing> = {};
  for (const [model, v] of Object.entries(pricingDraft.value)) {
    const input = Number(v.input);
    const cached = Number(v.cached);
    const output = Number(v.output);
    if (!Number.isFinite(input) && !Number.isFinite(cached) && !Number.isFinite(output)) continue;
    if (input === 0 && cached === 0 && output === 0) continue;
    next[model] = {
      input: Number.isFinite(input) && input >= 0 ? input : 0,
      cached: Number.isFinite(cached) && cached >= 0 ? cached : 0,
      output: Number.isFinite(output) && output >= 0 ? output : 0,
    };
  }
  try {
    const res = await fetch('/api/proxy/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPricing: next }),
    });
    if (res.ok) {
      pricing.value = (await res.json()).modelPricing ?? {};
      pricingOpen.value = false;
    }
  } catch { /* handled by next load */ }
}

function costOf(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): number | null {
  const p = pricing.value[model];
  if (!p) return null;
  const fresh = Math.max(0, inputTokens - cachedTokens);
  return (fresh * p.input + cachedTokens * p.cached + outputTokens * p.output) / 1_000_000;
}

function fmtCost(v: number | null): string {
  if (v === null) return '--';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

const totalCost = computed(() => {
  let sum = 0;
  let any = false;
  for (const r of summary.value) {
    const c = costOf(r.model, r.inputTokens, r.cachedTokens, r.outputTokens);
    if (c !== null) { sum += c; any = true; }
  }
  return any ? sum : null;
});

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
        <div class="metric" v-if="totalCost !== null">
          <span class="metric-label">Cost</span>
          <span class="metric-value cost">{{ fmtCost(totalCost) }}</span>
        </div>
      </div>
      <div class="usage-actions">
        <button v-if="!props.collapsed" class="collapse-btn" @click="openPricing" title="Set per-model pricing (USD per 1M tokens)">💵 Pricing</button>
        <a v-if="!props.collapsed" class="collapse-btn" href="/api/proxy/usage/export" title="Download usage as CSV">⬇ CSV</a>
        <button class="collapse-btn" @click="emit('toggle-collapse')" :title="props.collapsed ? 'Expand usage' : 'Collapse usage'">
          {{ props.collapsed ? '▸ Expand' : '▾ Collapse' }}
        </button>
      </div>
    </div>

    <div v-if="!props.collapsed" class="usage-body">
      <table class="usage-table" v-if="summary.length > 0">
        <thead>
          <tr><th>Model</th><th>Backend</th><th>Reqs</th><th>In</th><th>Cache</th><th>Out</th><th>Cost</th><th>t/s</th><th>TTFB</th><th>Last used</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in summary" :key="r.model + r.backend">
            <td>{{ r.model }}</td>
            <td>{{ r.backend }}</td>
            <td>{{ r.requests }}</td>
            <td>{{ fmtTok(r.inputTokens) }}</td>
            <td>{{ r.cachedTokens > 0 ? fmtTok(r.cachedTokens) : '--' }}</td>
            <td>{{ fmtTok(r.outputTokens) }}</td>
            <td>{{ fmtCost(costOf(r.model, r.inputTokens, r.cachedTokens, r.outputTokens)) }}</td>
            <td>{{ r.avgTokensPerSec !== null ? r.avgTokensPerSec.toFixed(1) : '--' }}</td>
            <td>{{ r.avgTtfbMs !== null ? Math.round(r.avgTtfbMs) + 'ms' : '--' }}</td>
            <td>{{ fmtAgo(r.lastUsed) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="recent-list" v-if="recent.length > 0">
        <div v-for="r in recent" :key="r.requestId" class="recent-row">
          {{ r.timestamp.slice(11, 19) }} · {{ r.backend }} · {{ r.model }} · {{ r.endpoint }} · {{ r.stream ? 'stream' : 'json' }} · {{ r.status }} · {{ r.totalDurationMs }}ms<template v-if="r.inputTokens !== null || r.outputTokens !== null"> · {{ r.inputTokens ?? '?' }}→{{ r.outputTokens ?? '?' }} tok<template v-if="r.cachedTokens"> ({{ r.cachedTokens }} cached)</template></template><template v-if="r.tokensPerSec !== null"> · {{ r.tokensPerSec.toFixed(1) }} t/s</template><template v-if="r.tokensEstimated"> (est)</template>
        </div>
      </div>
      <pre v-if="summary.length === 0 && recent.length === 0" class="empty">No usage recorded yet. Start the proxy and send a request.</pre>
    </div>

    <Dialog v-if="pricingOpen" title="Model pricing (USD per 1M tokens)" :width="560" @close="pricingOpen = false">
      <table class="pricing-table" v-if="Object.keys(pricingDraft).length > 0">
        <thead>
          <tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr>
        </thead>
        <tbody>
          <tr v-for="(p, model) in pricingDraft" :key="model">
            <td>{{ model }}</td>
            <td><input v-model="p.input" type="number" min="0" step="0.01" placeholder="0" /></td>
            <td><input v-model="p.cached" type="number" min="0" step="0.01" placeholder="0" /></td>
            <td><input v-model="p.output" type="number" min="0" step="0.01" placeholder="0" /></td>
          </tr>
        </tbody>
      </table>
      <pre v-else class="empty">No models seen yet. Send a request through the proxy first.</pre>
      <template #footer>
        <button class="collapse-btn" @click="pricingOpen = false">Cancel</button>
        <button class="collapse-btn save" @click="savePricing">Save pricing</button>
      </template>
    </Dialog>
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

.metric-value.cost {
  color: #d29922;
}

.pricing-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

.pricing-table th {
  text-align: left;
  color: #8b949e;
  font-weight: 600;
  padding: 4px 8px;
  border-bottom: 1px solid #30363d;
  text-transform: uppercase;
  font-size: 0.68rem;
}

.pricing-table td {
  padding: 4px 8px;
  border-bottom: 1px solid #21262d;
}

.pricing-table input {
  width: 90px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #c9d1d9;
  padding: 4px 6px;
  font-size: 0.8rem;
}

.collapse-btn.save {
  border-color: #238636;
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
