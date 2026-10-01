<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const props = withDefaults(defineProps<{
  title: string;
  width?: number;
}>(), {
  width: 760,
});

const emit = defineEmits(['close']);

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="dialog-overlay" @click.self="emit('close')">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      :style="{ width: `${width}px` }"
    >
      <div class="dialog-header">
        <h3>{{ title }}</h3>
        <button class="dialog-close" title="Close" @click="emit('close')">&times;</button>
      </div>
      <div class="dialog-body">
        <slot />
      </div>
      <div v-if="$slots.footer" class="dialog-footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 4vh;
  z-index: 100;
}

.dialog {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 8vh);
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #30363d;
  flex-shrink: 0;
}

.dialog-header h3 {
  font-size: 0.95rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dialog-close {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 4px;
  flex-shrink: 0;
}

.dialog-close:hover {
  color: #f85149;
  background: #da363322;
}

.dialog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #30363d;
  flex-shrink: 0;
}
</style>
