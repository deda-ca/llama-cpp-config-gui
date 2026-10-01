<script setup lang="ts">
import { computed } from 'vue';
import type { SystemStats } from '../types';

const props = defineProps<{
  stats: SystemStats | null;
}>();

// --- Formatting helpers ---
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i >= 2 ? 0 : 1)} ${units[i]}`;
}

function formatMBs(mbs: number | null): string {
  if (mbs == null) return '—';
  if (mbs >= 1024) return (mbs / 1024).toFixed(1) + ' GB/s';
  return mbs.toFixed(0) + ' MB/s';
}

// --- Derived values ---
const cpu = computed(() => props.stats?.cpu ?? null);
const ram = computed(() => props.stats?.ram ?? null);
const disk = computed(() => props.stats?.disk ?? null);

const ramPct = computed(() => {
  const r = ram.value;
  if (!r || r.totalBytes <= 0) return 0;
  return Math.round((r.usedBytes / r.totalBytes) * 100);
});

const diskPct = computed(() => {
  const d = disk.value;
  if (!d || d.totalBytes <= 0) return 0;
  return Math.round((d.usedBytes / d.totalBytes) * 100);
});

// Color class for a CPU percentage (green <50, yellow 50-80, red >80)
function cpuColor(pct: number): string {
  if (pct > 80) return 'bar-cpu-hot';
  if (pct >= 50) return 'bar-cpu-warm';
  return 'bar-cpu-cool';
}

// Per-core bars: cap the rendered count so very high core counts stay compact.
const perCore = computed(() => cpu.value?.perCore ?? []);
</script>

<template>
  <div class="system-monitor">
    <h2 class="section-title">System Monitor</h2>

    <!-- CPU -->
    <div class="sys-block" v-if="cpu">
      <div class="sys-stat">
        <span class="label">CPU</span>
        <div class="bar-container">
          <div class="bar bar-cpu" :class="cpuColor(cpu.overallPercent)" :style="{ width: cpu.overallPercent + '%' }"></div>
        </div>
        <span class="value value-bar">{{ cpu.overallPercent }}%</span>
      </div>
      <!-- Hidden for now to keep the UI compact; re-enable by removing display:none -->
      <div class="sys-sub" style="display:none">
        <span class="sub-label">{{ cpu.activeCores }}/{{ cpu.coreCount }} cores active</span>
      </div>
      <!-- Per-core bars -->
      <div class="core-bars" :title="'Per-core CPU usage'">
        <div
          v-for="(pct, i) in perCore"
          :key="i"
          class="core-bar"
          :class="cpuColor(pct)"
          :style="{ height: Math.max(4, pct) + '%' }"
          :title="`Core ${i}: ${pct}%`"
        ></div>
      </div>
    </div>

    <!-- RAM -->
    <div class="sys-block" v-if="ram">
      <div class="sys-stat">
        <span class="label">RAM</span>
        <div class="bar-container">
          <div class="bar bar-ram" :style="{ width: ramPct + '%' }"></div>
        </div>
        <span class="value value-bar">{{ formatBytes(ram.usedBytes) }} / {{ formatBytes(ram.totalBytes) }}</span>
      </div>
    </div>

    <!-- Disk -->
    <div class="sys-block" v-if="disk">
      <div class="sys-stat">
        <span class="label">Disk</span>
        <div class="bar-container">
          <div class="bar bar-disk" :style="{ width: diskPct + '%' }"></div>
        </div>
        <span class="value value-bar">{{ formatBytes(disk.usedBytes) }} / {{ formatBytes(disk.totalBytes) }}</span>
      </div>
      <div class="sys-sub io-row" v-if="disk.readMBs != null || disk.writeMBs != null">
        <span class="io-item" title="Disk read throughput">↓ {{ formatMBs(disk.readMBs) }}</span>
        <span class="io-item" title="Disk write throughput">↑ {{ formatMBs(disk.writeMBs) }}</span>
      </div>
    </div>

    <!-- Fallback when no stats yet -->
    <div v-if="!cpu && !ram && !disk" class="no-data">Collecting system metrics…</div>
  </div>
</template>

<style scoped>
.system-monitor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sys-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sys-stat {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
}

.sys-stat .label {
  width: 44px;
  color: #8b949e;
  font-weight: 500;
}

.sys-stat .value {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.sys-stat .value-bar {
  min-width: 120px;
  text-align: right;
}

.bar-container {
  flex: 1;
  height: 6px;
  background: #21262d;
  border-radius: 3px;
  overflow: hidden;
}

.bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s ease;
}

/* CPU bar color by intensity */
.bar-cpu-cool { background: #3fb950; }
.bar-cpu-warm { background: #d29922; }
.bar-cpu-hot  { background: #f85149; }

.bar-ram  { background: #58a6ff; }
.bar-disk { background: #bc8cff; }

.sys-sub {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sub-label {
  font-size: 0.72rem;
  color: #484f58;
}

/* Per-core vertical bars */
.core-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 28px;
  padding: 3px 6px;
  background: #0d1117;
  border: 1px solid #21262d;
  border-radius: 4px;
  overflow-x: auto;
}

.core-bar {
  flex: 1 0 3px;
  min-width: 3px;
  max-width: 8px;
  border-radius: 1px;
  transition: height 0.5s ease;
}

/* Disk I/O row */
.io-row {
  gap: 16px;
}

.io-item {
  font-size: 0.75rem;
  color: #8b949e;
  font-variant-numeric: tabular-nums;
}

.no-data {
  color: #8b949e;
  font-size: 0.9rem;
  padding: 16px;
  text-align: center;
}
</style>
