<script setup lang="ts">
import { computed } from 'vue';
import type { ModelStatusData } from '../types';

const props = defineProps<{
  status: ModelStatusData | null;
}>();

defineEmits<{ clear: [] }>();

// --- Formatting helpers ---
function fmtNum(n: number | null, decimals = 0): string {
  if (n == null) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
  return ms.toFixed(0) + ' ms';
}

function fmtTps(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(1) + ' t/s';
}

// --- Derived values ---
const promptPct = computed(() => {
  const p = props.status?.promptProgress;
  if (p == null) return 0;
  return Math.round(p * 100);
});

const hasPromptData = computed(() =>
  props.status != null && (props.status.promptProgress != null || props.status.promptTokens != null),
);
const hasGenData = computed(() =>
  props.status != null && (props.status.genTokens != null || props.status.genAvgTps != null),
);
const hasSummaryData = computed(() =>
  props.status != null && props.status.totalTimeMs != null,
);
</script>

<template>
  <div class="model-status">
    <div class="status-header">
      <h2 class="section-title">Model Status</h2>
      <button class="clear-btn" title="Clear model status" @click="$emit('clear')">✕</button>
    </div>

    <!-- PROMPT row -->
    <div class="status-row">
      <span class="row-header">PROMPT</span>
      <div class="row-values" v-if="hasPromptData">
        <div class="progress-bar" v-if="status!.promptProgress != null && status!.promptProgress < 1">
          <div class="progress-fill" :style="{ width: promptPct + '%' }"></div>
        </div>
        <span class="val" v-if="status!.promptProgress != null">{{ promptPct }}<span class="unit">%</span></span>
        <span class="val">{{ fmtNum(status!.promptTokens) }} <span class="unit">tok</span></span>
        <span class="val">{{ status!.promptSpeed != null ? status!.promptSpeed.toFixed(1) : '—' }} <span class="unit">t/s</span></span>
      </div>
      <span class="val dim" v-else>—</span>
    </div>

    <!-- GENERATION row -->
    <div class="status-row">
      <span class="row-header">GENERATION</span>
      <div class="row-values" v-if="hasGenData">
        <span class="val"><span class="unit">3s</span> {{ status!.gen3sTps != null ? status!.gen3sTps.toFixed(1) : '—' }} <span class="unit">t/s</span></span>
        <span class="val"><span class="unit">avg</span> {{ status!.genAvgTps != null ? status!.genAvgTps.toFixed(1) : '—' }} <span class="unit">t/s</span></span>
        <span class="val">{{ status!.genMsPerToken != null ? status!.genMsPerToken.toFixed(1) : '—' }} <span class="unit">ms/tok</span></span>
        <span class="val">{{ fmtNum(status!.genTokens) }} <span class="unit">tokens</span></span>
      </div>
      <span class="val dim" v-else>—</span>
    </div>

    <!-- SUMMARY row -->
    <div class="status-row">
      <span class="row-header">SUMMARY</span>
      <div class="row-values" v-if="hasSummaryData">
        <span class="val"><span class="unit">Total</span> {{ status!.totalTimeMs != null ? (status!.totalTimeMs >= 1000 ? (status!.totalTimeMs / 1000).toFixed(2) + ' s' : status!.totalTimeMs.toFixed(0) + ' ms') : '—' }}</span>
        <span class="val">{{ fmtNum(status!.totalTokens) }} <span class="unit">tok</span></span>
      </div>
      <span class="val dim" v-else>—</span>
    </div>
  </div>
</template>

<style scoped>
.model-status {
  padding: 10px 14px;
}

.status-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-title {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8b949e;
}

.clear-btn {
  background: none;
  border: none;
  color: #484f58;
  font-size: 0.7rem;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
}

.clear-btn:hover {
  color: #e1e4e8;
  background: #21262d;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid #21262d;
}

.status-row:last-child {
  border-bottom: none;
}

.row-header {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #8b949e;
  min-width: 80px;
  flex-shrink: 0;
}

.row-values {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  overflow: hidden;
}

.val {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.78rem;
  color: #e1e4e8;
  white-space: nowrap;
}

.val.dim {
  color: #484f58;
}

.unit {
  font-size: 0.65rem;
  opacity: 0.55;
}

.progress-bar {
  width: 60px;
  height: 6px;
  background: #21262d;
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #58a6ff;
  border-radius: 3px;
  transition: width 0.3s ease;
}
</style>
