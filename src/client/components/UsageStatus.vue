<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import type { ModelPricing, UsageRecord, UsageSummaryRow } from '../types';

const props = defineProps<{
  /** Latest completed proxy request, streamed over SSE (event: proxy-usage) */
  liveUsage: UsageRecord | null;
}>();

const summary = ref<UsageSummaryRow[]>([]);
const pricing = ref<Record<string, ModelPricing>>({});

// --- Settings (gear) ---
const MAX_MODELS_KEY = 'llama-gui:usage-status-max-models';
const showControls = ref(false);
const maxModels = ref(parseInt(localStorage.getItem(MAX_MODELS_KEY) ?? '', 10) || 5);
function applyMaxModels() {
  maxModels.value = Math.min(50, Math.max(1, Math.round(maxModels.value) || 5));
  localStorage.setItem(MAX_MODELS_KEY, String(maxModels.value));
}

async function loadUsage() {
  try {
    const [sumRes, priceRes] = await Promise.all([
      fetch('/api/proxy/usage/summary'),
      fetch('/api/proxy/settings'),
    ]);
    if (sumRes.ok) summary.value = (await sumRes.json()).rows;
    if (priceRes.ok) pricing.value = (await priceRes.json()).modelPricing ?? {};
  } catch { /* usage is best-effort */ }
}

// Refresh aggregates shortly after each live request lands (debounced)
let usageTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.liveUsage,
  (rec) => {
    if (!rec) return;
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = setTimeout(loadUsage, 800);
  },
);

onMounted(loadUsage);

function costOf(model: string, inputTokens: number, cachedTokens: number, outputTokens: number): number | null {
  const p = pricing.value[model];
  if (!p) return null;
  const fresh = Math.max(0, inputTokens - cachedTokens);
  return (fresh * p.input + cachedTokens * p.cached + outputTokens * p.output) / 1_000_000;
}

function fmtCost(v: number | null): string {
  if (v === null) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/** Tokens in k; switches to m once past 1M. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const totalRequests = computed(() => summary.value.reduce((a, r) => a + r.requests, 0));
const totalTokens = computed(() =>
  summary.value.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0),
);
const totalCost = computed(() => {
  let sum = 0;
  let any = false;
  for (const r of summary.value) {
    const c = costOf(r.model, r.inputTokens, r.cachedTokens, r.outputTokens);
    if (c !== null) { sum += c; any = true; }
  }
  return any ? sum : null;
});

/** Latest-used models first (summary comes back ordered by request count). */
const latestModels = computed(() =>
  [...summary.value]
    .sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''))
    .slice(0, maxModels.value),
);
const hiddenModels = computed(() => Math.max(0, summary.value.length - maxModels.value));
</script>

<template>
  <div class="usage-status">
    <div class="status-header">
      <h2 class="section-title">Usage</h2>
      <button
        class="gear-btn"
        :class="{ active: showControls }"
        @click="showControls = !showControls"
        title="Usage settings"
      >&#9881;</button>
    </div>

    <div v-if="showControls" class="usage-controls">
      <div class="max-models-control">
        <label for="usage-max-models">Max models</label>
        <input
          id="usage-max-models"
          v-model.number="maxModels"
          type="number"
          min="1"
          max="50"
          @change="applyMaxModels"
        />
      </div>
    </div>

    <div class="totals">
      <div class="metric">
        <span class="metric-label">Requests</span>
        <span class="metric-value">{{ totalRequests }}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Tokens</span>
        <span class="metric-value highlight">{{ fmtTokens(totalTokens) }}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Cost</span>
        <span class="metric-value cost">{{ fmtCost(totalCost) }}</span>
      </div>
    </div>

    <div class="model-list" v-if="latestModels.length > 0">
      <div v-for="r in latestModels" :key="r.model + r.backend" class="model-row" :title="`${r.model} · ${r.backend} · ${r.requests} req`">
        <span class="model-name">{{ r.model }}</span>
        <span class="model-cost">{{ fmtCost(costOf(r.model, r.inputTokens, r.cachedTokens, r.outputTokens)) }}</span>
        <span class="model-tps">{{ r.avgTokensPerSec !== null ? r.avgTokensPerSec.toFixed(1) : '—' }}<span class="unit"> t/s</span></span>
      </div>
      <div v-if="hiddenModels > 0" class="more-note">+{{ hiddenModels }} more — raise “Max models”</div>
    </div>
    <div v-else class="empty">No proxy usage recorded yet.</div>
  </div>
</template>

<style scoped>
.usage-status {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8b949e;
}

.gear-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #8b949e;
  font-size: 0.9rem;
  padding: 2px 7px;
  cursor: pointer;
  line-height: 1;
}

.gear-btn:hover { background: #21262d; color: #e1e4e8; }
.gear-btn.active { border-color: #58a6ff; color: #58a6ff; }

.usage-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.max-models-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.max-models-control label {
  font-size: 0.75rem;
  color: #8b949e;
}

.max-models-control input {
  width: 56px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 6px;
  color: #e1e4e8;
  font-size: 0.8rem;
}

.max-models-control input:focus {
  outline: none;
  border-color: #58a6ff;
}

.more-note {
  font-size: 0.66rem;
  color: #484f58;
  font-style: italic;
  padding: 2px 4px;
}

.totals {
  display: flex;
  gap: 8px;
}

.metric {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 6px 8px;
}

.metric-label {
  font-size: 0.62rem;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.metric-value {
  font-size: 0.95rem;
  font-weight: 600;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.metric-value.highlight { color: #79c0ff; }
.metric-value.cost { color: #3fb950; }

.model-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 160px;
  overflow-y: auto;
}

.model-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.74rem;
  padding: 2px 4px;
  border-radius: 4px;
}
.model-row:hover { background: #0d1117; }

.model-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e1e4e8;
}

.model-cost {
  flex-shrink: 0;
  color: #3fb950;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.model-tps {
  flex-shrink: 0;
  min-width: 64px;
  text-align: right;
  color: #8b949e;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.unit {
  font-size: 0.62rem;
  color: #8b949e;
}

.empty {
  color: #484f58;
  font-size: 0.74rem;
  font-style: italic;
}
</style>
