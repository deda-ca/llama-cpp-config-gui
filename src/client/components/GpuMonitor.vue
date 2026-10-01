<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';

const props = defineProps<{
  gpus: any[];
}>();

const intervalSec = ref(2);
const sortMode = ref('default'); // 'default' | 'cuda' | 'name' | 'memory' | 'temperature' | 'manual'
const manualOrder = ref<number[]>([]); // SMI indices in display order (used when sortMode === 'manual')
const showControls = ref(false);

// Compute displayed GPU list based on sort mode
const sortedGpus = computed(() => {
  const gpus = [...props.gpus];
  switch (sortMode.value) {
    case 'manual':
      if (manualOrder.value.length > 0) {
        gpus.sort((a, b) => {
          const ia = manualOrder.value.indexOf(a.index);
          const ib = manualOrder.value.indexOf(b.index);
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
      }
      break;
    case 'cuda':
      gpus.sort((a, b) => (a.cudaIndex ?? 999) - (b.cudaIndex ?? 999));
      break;
    case 'name':
      gpus.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'memory':
      gpus.sort((a, b) => b.memoryUsedMb - a.memoryUsedMb);
      break;
    case 'temperature':
      gpus.sort((a, b) => b.temperatureC - a.temperatureC);
      break;
    default:
      gpus.sort((a, b) => a.index - b.index);
  }
  return gpus;
});

onMounted(async () => {
  try {
    const res = await fetch('/api/gpu-interval');
    if (res.ok) {
      const data = await res.json();
      intervalSec.value = data.intervalMs / 1000;
    }
  } catch { /* keep default */ }

  try {
    const res = await fetch('/api/gpu-order');
    if (res.ok) {
      const data = await res.json();
      sortMode.value = data.sort || 'default';
      manualOrder.value = data.order || [];
    }
  } catch { /* keep defaults */ }
});

async function applyInterval() {
  const ms = Math.max(0.5, intervalSec.value) * 1000;
  await fetch('/api/gpu-interval', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intervalMs: ms }),
  });
}

function onSortChange() {
  // Switching sort mode clears manual order
  manualOrder.value = [];
  persistOrder();
}

function moveGpu(smiIndex: number, direction: -1 | 1) {
  // Switch to manual mode and build order from current display
  const currentOrder = sortedGpus.value.map((g) => g.index);
  const pos = currentOrder.indexOf(smiIndex);
  const target = pos + direction;
  if (target < 0 || target >= currentOrder.length) return;
  [currentOrder[pos], currentOrder[target]] = [currentOrder[target], currentOrder[pos]];
  sortMode.value = 'manual';
  manualOrder.value = currentOrder;
  persistOrder();
}

async function persistOrder() {
  await fetch('/api/gpu-order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sort: sortMode.value, order: manualOrder.value }),
  });
}

function formatMb(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb.toFixed(0) + ' MB';
}

function memPct(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}
</script>

<template>
  <div class="gpu-monitor">
    <div class="gpu-header">
      <h2 class="section-title">GPU Monitor</h2>
      <button
        class="gear-btn"
        :class="{ active: showControls }"
        @click="showControls = !showControls"
        title="GPU settings"
      >&#9881;</button>
    </div>

    <div v-if="showControls" class="gpu-controls">
      <select v-model="sortMode" @change="onSortChange" class="sort-select">
        <option value="default">Default</option>
        <option value="cuda">CUDA Index</option>
        <option value="name">Name</option>
        <option value="memory">Memory Usage</option>
        <option value="temperature">Temperature</option>
        <option value="manual">Manual</option>
      </select>
      <div class="interval-control">
        <label for="gpu-interval">Refresh (s)</label>
        <input
          id="gpu-interval"
          v-model.number="intervalSec"
          type="number"
          min="0.5"
          step="0.5"
          @change="applyInterval"
        />
      </div>
    </div>

    <div v-if="gpus.length === 0" class="no-gpu">
      No NVIDIA GPUs detected. Is <code>nvidia-smi</code> available?
    </div>

    <div v-else class="gpu-grid">
      <div v-for="(gpu, gi) in sortedGpus" :key="gpu.index" class="gpu-card">
        <div class="gpu-name-row">
          <span class="gpu-name">{{ gpu.name }}</span>
          <div class="gpu-card-actions">
            <span v-if="gpu.cudaIndex !== null" class="cuda-badge">CUDA{{ gpu.cudaIndex }}</span>
            <button class="arrow-btn" :disabled="gi === 0" @click="moveGpu(gpu.index, -1)" title="Move up">&#9650;</button>
            <button class="arrow-btn" :disabled="gi === sortedGpus.length - 1" @click="moveGpu(gpu.index, 1)" title="Move down">&#9660;</button>
          </div>
        </div>

        <div class="gpu-stat">
          <span class="label">Memory</span>
          <div class="bar-container">
            <div
              class="bar"
              :style="{ width: memPct(gpu.memoryUsedMb, gpu.memoryTotalMb) + '%' }"
            ></div>
          </div>
          <span class="value value-bar">
            {{ formatMb(gpu.memoryUsedMb) }} / {{ formatMb(gpu.memoryTotalMb) }}
          </span>
        </div>

        <div class="gpu-stat">
          <span class="label">Utilization</span>
          <div class="bar-container">
            <div
              class="bar bar-util"
              :style="{ width: gpu.utilizationPct + '%' }"
            ></div>
          </div>
          <span class="value value-bar">{{ gpu.utilizationPct }}%</span>
        </div>

        <div class="gpu-stat-row">
          <div class="gpu-stat">
            <span class="label">Temp</span>
            <span class="value" :class="{ warn: gpu.temperatureC > 80 }">
              {{ gpu.temperatureC }}°C
            </span>
          </div>

          <div class="gpu-stat" v-if="gpu.powerDrawW != null">
            <span class="label">Power</span>
            <span class="value">{{ gpu.powerDrawW.toFixed(0) }} W</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gpu-monitor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gpu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
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

.gpu-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sort-select {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 8px;
  color: #e1e4e8;
  font-size: 0.8rem;
}

.sort-select:focus {
  outline: none;
  border-color: #58a6ff;
}

.interval-control {
  display: flex;
  align-items: center;
  gap: 6px;
}

.interval-control label {
  font-size: 0.75rem;
  color: #8b949e;
}

.interval-control input {
  width: 60px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 4px 8px;
  color: #e1e4e8;
  font-size: 0.85rem;
}

.interval-control input:focus {
  outline: none;
  border-color: #58a6ff;
}

.gpu-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.arrow-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 3px;
  color: #8b949e;
  font-size: 0.6rem;
  padding: 2px 5px;
  cursor: pointer;
  line-height: 1;
}

.arrow-btn:hover:not(:disabled) {
  border-color: #58a6ff;
  color: #58a6ff;
}

.arrow-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.no-gpu {
  color: #8b949e;
  font-size: 0.9rem;
  padding: 16px;
  text-align: center;
}

.gpu-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gpu-card {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 12px;
}

.gpu-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.gpu-name {
  font-weight: 600;
  font-size: 0.95rem;
}

.cuda-badge {
  background: #1f6feb33;
  color: #58a6ff;
  border: 1px solid #1f6feb66;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.gpu-stat {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
}

.gpu-stat .label {
  width: 80px;
  color: #8b949e;
}

.gpu-stat .value {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.gpu-stat .value-bar {
  min-width: 110px;
  text-align: right;
}

.gpu-stat .value.warn {
  color: #f85149;
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
  background: #58a6ff;
  border-radius: 3px;
  transition: width 0.5s ease;
}

.bar-util {
  background: #3fb950;
}

.gpu-stat-row {
  display: flex;
  gap: 16px;
  margin-top: 8px;
}

.gpu-stat-row .gpu-stat .label {
  width: auto;
  min-width: 40px;
}
</style>
