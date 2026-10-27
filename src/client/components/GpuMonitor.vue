<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

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

// Release drag eligibility if the user clicks the handle without dragging
function onGlobalMouseup() {
  if (draggingIndex.value === null) handlePressed.value = null;
}
onUnmounted(() => window.removeEventListener('mouseup', onGlobalMouseup));

onMounted(async () => {
  window.addEventListener('mouseup', onGlobalMouseup);

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

// Drag & drop reordering (initiated from the grip handle on each card).
// The card is only draggable while its handle is held down, so drags start
// from the handle but the whole card follows.
const draggingIndex = ref<number | null>(null);
const dropTargetIndex = ref<number | null>(null);
const handlePressed = ref<number | null>(null);

function onDragStart(smiIndex: number) {
  draggingIndex.value = smiIndex;
}

function onDragOver(targetIndex: number) {
  if (draggingIndex.value !== null && draggingIndex.value !== targetIndex) {
    dropTargetIndex.value = targetIndex;
  }
}

function onDragLeave(targetIndex: number) {
  if (dropTargetIndex.value === targetIndex) dropTargetIndex.value = null;
}

function onDragEnd() {
  draggingIndex.value = null;
  dropTargetIndex.value = null;
  handlePressed.value = null;
}

function onDrop(targetIndex: number) {
  const source = draggingIndex.value;
  draggingIndex.value = null;
  dropTargetIndex.value = null;
  if (source === null || source === targetIndex) return;
  const currentOrder = sortedGpus.value.map((g) => g.index);
  const from = currentOrder.indexOf(source);
  const to = currentOrder.indexOf(targetIndex);
  if (from === -1 || to === -1) return;
  currentOrder.splice(to, 0, ...currentOrder.splice(from, 1));
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

function formatPcie(gpu: any): string | null {
  if (gpu.pcieGen == null && gpu.pcieWidth == null) return null;
  let s = '';
  if (gpu.pcieGen != null) s += gpu.pcieGen + '.0';
  if (gpu.pcieWidth != null) s += (s ? ' ' : '') + 'x' + gpu.pcieWidth;
  return s;
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
      <div
        v-for="gpu in sortedGpus"
        :key="gpu.index"
        class="gpu-card"
        :draggable="handlePressed === gpu.index"
        :class="{ 'gpu-card-dragging': draggingIndex === gpu.index, 'gpu-card-drop-target': dropTargetIndex === gpu.index && draggingIndex !== null && draggingIndex !== gpu.index }"
        @dragstart="onDragStart(gpu.index)"
        @dragend="onDragEnd"
        @dragover.prevent="onDragOver(gpu.index)"
        @dragleave="onDragLeave(gpu.index)"
        @drop="onDrop(gpu.index)"
      >
        <div class="gpu-name-row">
          <span class="gpu-name-group">
            <span
              class="drag-handle"
              @mousedown="handlePressed = gpu.index"
              title="Drag to reorder"
            >&#8942;&#8942;</span>
            <span class="gpu-name">{{ gpu.name }}</span>
          </span>
          <div class="gpu-card-actions">
            <span v-if="gpu.cudaIndex !== null" class="cuda-badge">CUDA{{ gpu.cudaIndex }}</span>
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

          <div class="gpu-stat" v-if="formatPcie(gpu)">
            <span class="label">PCIe</span>
            <span class="value">{{ formatPcie(gpu) }}</span>
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

.drag-handle {
  color: #8b949e;
  font-size: 0.8rem;
  letter-spacing: -2px;
  cursor: grab;
  user-select: none;
  padding: 2px 4px;
  margin-right: 6px;
  border-radius: 3px;
}

.drag-handle:hover {
  color: #58a6ff;
  background: #1f6feb22;
}

.drag-handle:active {
  cursor: grabbing;
}

.gpu-card-dragging {
  opacity: 0.4;
}

.gpu-card-drop-target {
  border-color: #58a6ff;
  box-shadow: 0 0 0 1px #58a6ff44;
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

.gpu-name-group {
  display: flex;
  align-items: center;
  min-width: 0;
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
