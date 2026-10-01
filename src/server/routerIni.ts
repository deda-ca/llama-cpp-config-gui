import type { ModelConfig, ParamDef } from './modelConfig.js';
import { generateId } from './modelConfig.js';

/**
 * Parse a router.ini file into ModelConfig objects.
 * Format:
 *   version = 1
 *   [*]
 *   # global defaults (commented or active)
 *   [AliasName]
 *   key = value
 */
export function parseRouterIni(content: string, params: ParamDef[]): ModelConfig[] {
  const configs: ModelConfig[] = [];
  const lines = content.split('\n');
  let currentAlias: string | null = null;
  let currentParams: Record<string, string> = {};
  let currentOrder: string[] = [];
  let currentDisabled: string[] = [];
  let currentNotes: string[] = [];

  const paramKeySet = new Set(params.map((p) => p.key));

  function flush() {
    if (!currentAlias) return;
    configs.push({
      id: generateId(),
      alias: currentAlias,
      displayName: currentAlias,
      notes: currentNotes.join('\n').trim(),
      modelPath: currentParams['model'] || '',
      mmproj: currentParams['mmproj'] || undefined,
      chatTemplateFile: currentParams['chat-template-file'] || undefined,
      params: { ...currentParams },
      paramOrder: [...currentOrder],
      disabledParams: currentDisabled.length ? [...currentDisabled] : undefined,
      isDefault: false,
    });
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Section header: [AliasName]
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      flush();
      currentAlias = sectionMatch[1];
      currentParams = {};
      currentOrder = [];
      currentDisabled = [];
      currentNotes = [];
      // Skip the global [*] section
      if (currentAlias === '*') {
        currentAlias = null;
      }
      continue;
    }

    // Skip empty lines, version line, and content in global section
    if (!line || line === 'version = 1' || currentAlias === null) continue;

    // Structural category headers (## ...) — skip entirely
    if (line.startsWith('##')) continue;

    // Comment lines → check for commented-out params, otherwise notes
    if (line.startsWith('#')) {
      const commentContent = line.slice(1).trim();
      const eqIdx = commentContent.indexOf('=');
      if (eqIdx > 0) {
        const cKey = commentContent.slice(0, eqIdx).trim();
        const cValue = commentContent.slice(eqIdx + 1).trim();
        // If it looks like a known param key with a value, treat as disabled param
        if (paramKeySet.has(cKey) && !currentParams[cKey]) {
          currentParams[cKey] = cValue;
          if (!currentOrder.includes(cKey)) currentOrder.push(cKey);
          if (!currentDisabled.includes(cKey)) currentDisabled.push(cKey);
          continue;
        }
      }
      currentNotes.push(commentContent);
      continue;
    }

    // key = value
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      currentParams[key] = value;
      if (!currentOrder.includes(key)) {
        currentOrder.push(key);
      }
      continue;
    }

    // Bare key with no value (e.g. "load-on-startup") → toggle on
    if (paramKeySet.has(line)) {
      currentParams[line] = 'on';
      if (!currentOrder.includes(line)) {
        currentOrder.push(line);
      }
    }
  }
  flush();

  return configs;
}

/** Display names for param categories used in INI section headers. */
const CATEGORY_NAMES: Record<string, string> = {
  gpu: 'GPU & Offload',
  context: 'Context & RoPE',
  sampling: 'Sampling',
  reasoning: 'Reasoning',
  speculative: 'Speculative Decoding',
  other: 'Other',
};

/**
 * Export ModelConfig objects to router.ini format with category comment headers.
 */
export function exportRouterIni(configs: ModelConfig[], params: ParamDef[]): string {
  const keyToCategory = new Map<string, string>();
  for (const p of params) {
    keyToCategory.set(p.key, p.category);
  }

  const lines: string[] = ['version = 1', ''];

  for (const config of configs) {
    lines.push(`[${config.alias}]`);

    // Notes go inside the section so they survive round-trip
    if (config.notes) {
      for (const noteLine of config.notes.split('\n')) {
        lines.push(`# ${noteLine}`);
      }
    }

    // Write params in order, grouped by category with structural headers
    const written = new Set<string>();
    let lastCategory: string | null = null;

    function writeHeader(category: string) {
      if (category === lastCategory) return;
      lastCategory = category;
      const name = CATEGORY_NAMES[category] || category;
      lines.push(`## ${name}`);
    }

    // Always write model first if present (no category header for core fields)
    if (config.modelPath) {
      lines.push(`model = ${config.modelPath}`);
      written.add('model');
    }
    if (config.mmproj) {
      lines.push(`mmproj = ${config.mmproj}`);
      written.add('mmproj');
    }
    if (config.chatTemplateFile) {
      lines.push(`chat-template-file = ${config.chatTemplateFile}`);
      written.add('chat-template-file');
    }

    // Write remaining params in paramOrder, grouped by category
    const disabledSet = new Set(config.disabledParams || []);
    for (const key of config.paramOrder) {
      if (written.has(key)) continue;
      const value = config.params[key];
      if (value === undefined || value === '') continue;

      const category = keyToCategory.get(key) || 'other';
      writeHeader(category);

      // Toggles that are off: write as a comment (a bare "key = off" line
      // would still be truthy to llama.cpp's preset parser, e.g. load-on-startup)
      if (value === 'off' && !disabledSet.has(key)) {
        lines.push(`# ${key} = off`);
        written.add(key);
        continue;
      }
      if (disabledSet.has(key)) {
        lines.push(`# ${key} = ${value}`);
      } else {
        lines.push(`${key} = ${value}`);
      }
      written.add(key);
    }

    // Catch any params not in paramOrder
    for (const [key, value] of Object.entries(config.params)) {
      if (!written.has(key) && value !== '') {
        const category = keyToCategory.get(key) || 'other';
        writeHeader(category);
        lines.push(`${key} = ${value}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
