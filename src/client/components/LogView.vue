<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import type { LogEntry } from '../types';

const props = defineProps<{
  lines: LogEntry[];
  metrics: { prefillTokensPerSec: number | null; generationTokensPerSec: number | null };
  /** Whether the log body is hidden (the whole panel collapses in the parent) */
  collapsed?: boolean;
}>();

const emit = defineEmits(['toggle-collapse', 'clear-logs']);

const containerRef = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

watch(
  () => props.lines.length,
  async () => {
    if (autoScroll.value) {
      await nextTick();
      if (containerRef.value) {
        containerRef.value.scrollTop = containerRef.value.scrollHeight;
      }
    }
  },
);

function onScroll() {
  if (!containerRef.value) return;
  const el = containerRef.value;
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
</script>

<template>
  <div class="log-view">
    <div class="log-header">
      <h2 class="section-title">Logs & Metrics</h2>
      <div class="metrics">
        <div class="metric" v-if="metrics.prefillTokensPerSec != null">
          <span class="metric-label">Prefill</span>
          <span class="metric-value">{{ metrics.prefillTokensPerSec.toFixed(1) }} t/s</span>
        </div>
        <div class="metric" v-if="metrics.generationTokensPerSec != null">
          <span class="metric-label">Generation</span>
          <span class="metric-value highlight">{{ metrics.generationTokensPerSec.toFixed(1) }} t/s</span>
        </div>
      </div>
      <div class="log-actions">
        <button v-if="!props.collapsed && lines.length > 0" class="collapse-btn" @click="emit('clear-logs')" title="Clear all logs">✕ Clear</button>
        <button class="collapse-btn" @click="emit('toggle-collapse')" :title="props.collapsed ? 'Expand logs' : 'Collapse logs'">
          {{ props.collapsed ? '▸ Expand' : '▾ Collapse' }}
        </button>
      </div>
    </div>

    <div v-if="!props.collapsed" ref="containerRef" class="log-container" @scroll="onScroll">
      <pre v-if="lines.length === 0" class="empty">No output yet. Launch a process to see logs.</pre>
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="log-line"
        :class="'level-' + line.level"
      >{{ line.raw }}</div>
    </div>
  </div>
</template>

<style scoped>
.log-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.metrics {
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

.collapse-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #8b949e;
  font-size: 0.72rem;
  padding: 3px 10px;
  cursor: pointer;
  flex-shrink: 0;
}

.log-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.collapse-btn:hover {
  border-color: #58a6ff;
  color: #58a6ff;
}

.log-container {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 12px;
  overflow-y: auto;
  max-height: 400px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 0.8rem;
  line-height: 1.5;
}

.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}

/* Level-based coloring */
.log-line.level-I { color: #e1e4e8; }
.log-line.level-W { color: #d29922; }
.log-line.level-E { color: #f85149; }
.log-line.level-F { color: #ff7b72; font-weight: 600; }
.log-line.level-plain { color: #8b949e; }

.empty {
  color: #484f58;
  font-style: italic;
}
</style>
