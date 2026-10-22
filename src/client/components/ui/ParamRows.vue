<script setup lang="ts">
/**
 * Editable parameter rows bound to a catalog (docs/todo.md #21 Phase 4).
 *
 * Shared by the strata editor's Engine / Server / Vision groups: each is a flat
 * `EngineParam[]` with a `ParamDef[]` catalog driving grouping, descriptions
 * and input types. Same row model as the generic engine editor — order is
 * launch order, `disabled` keeps a row visible but out of the command line —
 * so add / edit / delete / disable / drag-reorder behave identically here.
 *
 * The list is mutated in place (rows are objects), which keeps the parent's
 * draft state trivial; the parent owns the array reference.
 */

import { computed, ref } from 'vue';
import type { EngineParam, ParamDef } from '../../types';

const props = defineProps<{
  /** Rows to edit; mutated in place. */
  modelValue: EngineParam[];
  /** Catalog driving grouping, descriptions and input types. */
  catalog: ParamDef[];
  /** Category display order; unlisted catalog categories follow, then unknown. */
  categoryOrder?: string[];
  /** Labels for categories; unknown ones fall back to the raw name. */
  categoryLabels?: Record<string, string>;
  /** Placeholder shown for a value-less custom flag. */
  flagPlaceholder?: string;
}>();

const params = computed(() => props.modelValue);

const keyToDef = computed(() => new Map(props.catalog.map((d) => [d.flag, d])));

const orderedCategories = computed(() => {
  const base = props.categoryOrder ?? [];
  const extra: string[] = [];
  for (const d of props.catalog) {
    if (!base.includes(d.category) && d.category !== 'unknown' && !extra.includes(d.category)) {
      extra.push(d.category);
    }
  }
  return [...base, ...extra, 'unknown'];
});

function categoryLabel(cat: string): string {
  return props.categoryLabels?.[cat] || cat;
}

interface ParamRow {
  param: EngineParam;
  index: number;
  def: ParamDef | null;
}

const grouped = computed(() => {
  const groups: Record<string, ParamRow[]> = {};
  params.value.forEach((param, index) => {
    if (!param.key.trim()) return;
    const def = keyToDef.value.get(param.key) ?? null;
    const cat = def ? def.category : 'unknown';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ param, index, def });
  });
  return orderedCategories.value
    .filter((cat) => groups[cat]?.length)
    .map((cat) => ({ cat, label: categoryLabel(cat), rows: groups[cat] }));
});

function isToggleOn(p: EngineParam): boolean {
  return !p.disabled && (p.value === undefined || p.value === '');
}

function toggleParam(p: EngineParam) {
  if (p.disabled) {
    p.disabled = false;
    p.value = undefined;
  } else {
    p.disabled = true;
  }
}

function removeRow(idx: number) {
  params.value.splice(idx, 1);
}

// --- Add from catalog (entries not present yet) ---
const showPicker = ref(false);
const pickerFilter = ref('');

const pickerGroups = computed(() => {
  const used = new Set(params.value.map((p) => p.key));
  const q = pickerFilter.value.toLowerCase();
  const groups: Record<string, ParamDef[]> = {};
  for (const d of props.catalog) {
    if (used.has(d.flag)) continue;
    if (q && !d.flag.toLowerCase().includes(q) && !d.label.toLowerCase().includes(q)
      && !d.description.toLowerCase().includes(q)) continue;
    if (!groups[d.category]) groups[d.category] = [];
    groups[d.category].push(d);
  }
  return orderedCategories.value
    .filter((cat) => groups[cat]?.length)
    .map((cat) => ({ cat, label: categoryLabel(cat), defs: groups[cat] }));
});

function addCatalogParam(d: ParamDef) {
  params.value.push(d.inputType === 'toggle' ? { key: d.flag } : { key: d.flag, value: d.default ?? '' });
  showPicker.value = false;
  pickerFilter.value = '';
}

function addCustomRow() {
  params.value.push({ key: '', value: '' });
}

// --- Bulk paste ---
const showPaste = ref(false);
const pasteText = ref('');

function applyPaste() {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pasteText.value))) out.push(m[1] ?? m[2] ?? m[3]);
  const rows: EngineParam[] = [];
  for (let i = 0; i < out.length; i++) {
    const tok = out[i];
    if (tok.startsWith('-')) {
      const next = out[i + 1];
      if (next && !next.startsWith('-')) {
        rows.push({ key: tok, value: next });
        i++;
      } else {
        rows.push({ key: tok });
      }
    } else {
      rows.push({ key: tok });
    }
  }
  params.value.splice(0, params.value.length, ...rows);
  showPaste.value = false;
  pasteText.value = '';
}

// --- Drag to reorder (rows tracked by index: a flag can repeat) ---
const dragIndex = ref<number | null>(null);
const dropTarget = ref<number | null>(null);
const dragEnabledIndex = ref<number | null>(null);

function onHandleMousedown(index: number) {
  dragEnabledIndex.value = index;
}
function onDragStart(index: number, e: DragEvent) {
  dragIndex.value = index;
  e.dataTransfer?.setData('text/plain', String(index));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOverRow(index: number, e: DragEvent) {
  e.preventDefault();
  if (dragIndex.value === null || dragIndex.value === index) return;
  dropTarget.value = index;
}
function onDragLeaveRow() {
  dropTarget.value = null;
}
function onDropRow(targetIndex: number, e: DragEvent) {
  e.preventDefault();
  const from = dragIndex.value;
  clearDrag();
  if (from === null || from === targetIndex) return;
  let insertIdx = targetIndex + 1;
  if (from < insertIdx) insertIdx -= 1;
  const [moved] = params.value.splice(from, 1);
  params.value.splice(insertIdx, 0, moved);
}
function onDragEnd() {
  clearDrag();
}
function clearDrag() {
  dragIndex.value = null;
  dropTarget.value = null;
  dragEnabledIndex.value = null;
}
</script>

<template>
  <div class="param-rows">
    <div v-for="group in grouped" :key="group.cat" class="param-group">
      <h4 class="group-title" :class="{ 'group-unknown': group.cat === 'unknown' }">{{ group.label }}</h4>
      <div
        v-for="row in group.rows"
        :key="row.index"
        class="param-row"
        :class="{ 'param-disabled': row.param.disabled, dragging: dragIndex === row.index, 'drop-after': dropTarget === row.index && dragIndex !== null }"
        :draggable="dragEnabledIndex === row.index"
        @dragstart="onDragStart(row.index, $event)"
        @dragover="onDragOverRow(row.index, $event)"
        @dragleave="onDragLeaveRow()"
        @drop="onDropRow(row.index, $event)"
        @dragend="onDragEnd()"
      >
        <span class="drag-handle" title="Drag to reorder" @mousedown="onHandleMousedown(row.index)">&#8942;</span>
        <span class="param-flag" :title="row.def?.description || ''">{{ row.param.key }}</span>
        <label v-if="row.def && row.def.inputType === 'toggle'" class="toggle-wrap">
          <input type="checkbox" :checked="isToggleOn(row.param)" @change="toggleParam(row.param)" />
          <span>{{ isToggleOn(row.param) ? 'on' : 'off' }}</span>
        </label>
        <select v-else-if="row.def?.inputType === 'select'" v-model="row.param.value">
          <option value="">(none)</option>
          <option v-for="opt in row.def?.options" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <input
          v-else-if="row.def?.inputType === 'number'"
          v-model="row.param.value"
          type="number"
          step="any"
          :placeholder="row.def?.default || ''"
        />
        <input
          v-else-if="row.def?.inputType === 'path'"
          v-model="row.param.value"
          type="text"
          placeholder="/path/to/file"
        />
        <template v-else-if="row.def?.inputType === 'preset'">
          <input v-model="row.param.value" type="text" :placeholder="row.def?.default || ''" />
          <select
            v-if="row.def?.presets?.length"
            class="preset-select"
            :value="row.def?.presets?.includes(row.param.value ?? '') ? row.param.value : ''"
            @change="(e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) row.param.value = v; }"
            title="Quick presets"
          >
            <option value="">preset…</option>
            <option v-for="p in row.def?.presets" :key="p" :value="p">{{ p }}</option>
          </select>
        </template>
        <input
          v-else
          v-model="row.param.value"
          type="text"
          :placeholder="row.def ? (row.def.inputType === 'comma-list' ? 'e.g. 1,2,3' : row.def.default || '') : (flagPlaceholder || 'value (empty = flag only)')"
        />
        <span class="param-desc" :title="row.def?.description || 'Not in this parameter catalog'">{{ row.def?.description || 'custom flag' }}</span>
        <button
          v-if="!row.def || row.def.inputType !== 'toggle'"
          class="toggle-enabled-btn"
          :class="{ 'is-disabled': row.param.disabled }"
          @click="row.param.disabled = !row.param.disabled"
          :title="row.param.disabled ? 'Include in the launch' : 'Exclude from the launch'"
        >{{ row.param.disabled ? 'off' : 'on' }}</button>
        <button class="remove-btn" @click="removeRow(row.index)" title="Remove">&times;</button>
      </div>
    </div>

    <div class="params-actions">
      <button class="add-btn" @click="showPicker = !showPicker">+ Add Parameter</button>
      <button class="add-btn" @click="addCustomRow">+ Custom Flag</button>
      <button class="add-btn" @click="showPaste = !showPaste">Paste args…</button>
    </div>

    <div v-if="showPicker" class="param-picker">
      <input v-model="pickerFilter" type="text" placeholder="Search parameters..." autofocus />
      <div class="picker-list">
        <div v-for="group in pickerGroups" :key="group.cat" class="picker-group">
          <h5>{{ group.label }}</h5>
          <div v-for="d in group.defs" :key="d.flag" class="picker-item" @click="addCatalogParam(d)">
            <span class="picker-flag">{{ d.flag }}</span>
            <span class="picker-desc">{{ d.description }}</span>
          </div>
        </div>
        <div v-if="!pickerGroups.length" class="picker-empty">No matching parameters</div>
      </div>
    </div>

    <div v-if="showPaste" class="args-paste">
      <textarea v-model="pasteText" rows="3" placeholder="--pack /path/to/pack --ctx 262144 --metrics"></textarea>
      <button class="btn" @click="applyPaste">Replace rows</button>
    </div>
  </div>
</template>

<style scoped>
.param-group {
  margin-bottom: 10px;
}

.group-title {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #8b949e;
  margin: 0 0 4px;
}

.group-unknown { color: #d29922; }

.param-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.param-row.dragging { opacity: 0.4; }
.param-row.drop-after { box-shadow: 0 2px 0 0 #58a6ff; }
.param-disabled .param-flag,
.param-disabled .param-desc { opacity: 0.45; text-decoration: line-through; }

.drag-handle {
  color: #484f58;
  cursor: grab;
  font-size: 0.9rem;
  width: 12px;
  text-align: center;
}

.param-flag {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.78rem;
  color: #79c0ff;
  min-width: 150px;
  flex-shrink: 0;
}

.param-row input,
.param-row select {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 5px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: inherit;
  min-width: 0;
}

.param-row input[type='text'] { flex: 1; }
.preset-select { width: 90px; flex-shrink: 0; }

.toggle-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: #8b949e;
}

.param-desc {
  font-size: 0.68rem;
  color: #484f58;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.toggle-enabled-btn {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  color: #3fb950;
  font-size: 0.68rem;
  padding: 3px 7px;
  cursor: pointer;
}

.toggle-enabled-btn.is-disabled { color: #8b949e; background: #21262d; }

.remove-btn {
  background: none;
  border: none;
  color: #484f58;
  font-size: 1rem;
  cursor: pointer;
  padding: 0 4px;
}

.remove-btn:hover { color: #f85149; }

.params-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.add-btn {
  background: none;
  border: 1px dashed #30363d;
  border-radius: 4px;
  padding: 5px 8px;
  color: #58a6ff;
  font-size: 0.75rem;
  cursor: pointer;
}

.add-btn:hover { border-color: #58a6ff; background: #1f6feb11; }

.param-picker {
  margin-top: 8px;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px;
  background: #0d1117;
}

.param-picker input {
  width: 100%;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 6px 8px;
  color: #e1e4e8;
  font-size: 0.78rem;
  margin-bottom: 6px;
}

.picker-list {
  max-height: 220px;
  overflow-y: auto;
}

.picker-group h5 {
  font-size: 0.68rem;
  text-transform: uppercase;
  color: #8b949e;
  margin: 6px 0 2px;
}

.picker-item {
  display: flex;
  gap: 8px;
  padding: 3px 4px;
  cursor: pointer;
  border-radius: 4px;
}

.picker-item:hover { background: #1f6feb22; }

.picker-flag {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.75rem;
  color: #79c0ff;
  min-width: 150px;
}

.picker-desc {
  font-size: 0.7rem;
  color: #8b949e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-empty {
  font-size: 0.75rem;
  color: #484f58;
  padding: 6px;
}

.args-paste {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.args-paste textarea {
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 7px 10px;
  color: #e1e4e8;
  font-size: 0.78rem;
  font-family: 'Cascadia Code', monospace;
  resize: vertical;
}

.args-paste textarea:focus { outline: none; border-color: #58a6ff; }

.btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #e1e4e8;
  font-size: 0.78rem;
  cursor: pointer;
  align-self: flex-start;
}
</style>
