import { describe, it, expect } from 'vitest';
import { parseRouterIni, exportRouterIni } from '../routerIni.js';
import type { ModelConfig, ParamDef } from '../modelConfig.js';

// Minimal param defs for testing (subset of real params)
const testParams: ParamDef[] = [
  { flag: '--ctx-size', key: 'ctx-size', label: 'Context Size', description: '', category: 'context', inputType: 'number' },
  { flag: '--n-gpu-layers', key: 'n-gpu-layers', label: 'GPU Layers', description: '', category: 'gpu', inputType: 'number' },
  { flag: '--flash-attn', key: 'flash-attn', label: 'Flash Attention', description: '', category: 'gpu', inputType: 'toggle' },
  { flag: '--load-on-startup', key: 'load-on-startup', label: 'Load on Startup', description: '', category: 'other', inputType: 'toggle' },
];

describe('parseRouterIni', () => {
  it('parses a simple single-section INI', () => {
    const ini = `version = 1

[MyModel]
model = /path/to/model.gguf
ctx-size = 4096
n-gpu-layers = 33
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(1);
    expect(configs[0].alias).toBe('MyModel');
    expect(configs[0].modelPath).toBe('/path/to/model.gguf');
    expect(configs[0].params['ctx-size']).toBe('4096');
    expect(configs[0].params['n-gpu-layers']).toBe('33');
  });

  it('parses multiple sections', () => {
    const ini = `version = 1

[ModelA]
model = /a.gguf
ctx-size = 2048

[ModelB]
model = /b.gguf
n-gpu-layers = 99
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(2);
    expect(configs[0].alias).toBe('ModelA');
    expect(configs[1].alias).toBe('ModelB');
    expect(configs[0].params['ctx-size']).toBe('2048');
    expect(configs[1].params['n-gpu-layers']).toBe('99');
  });

  it('skips the [*] global section', () => {
    const ini = `version = 1

[*]
ctx-size = 8192

[MyModel]
model = /m.gguf
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(1);
    expect(configs[0].alias).toBe('MyModel');
    // Global params should NOT leak into the model
    expect(configs[0].params['ctx-size']).toBeUndefined();
  });

  it('treats commented known params as disabled', () => {
    const ini = `version = 1

[MyModel]
model = /m.gguf
# flash-attn = on
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(1);
    expect(configs[0].params['flash-attn']).toBe('on');
    expect(configs[0].disabledParams).toContain('flash-attn');
  });

  it('treats bare known param keys as toggles on', () => {
    const ini = `version = 1

[MyModel]
model = /m.gguf
load-on-startup
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(1);
    expect(configs[0].params['load-on-startup']).toBe('on');
  });

  it('collects non-param comments as notes', () => {
    const ini = `version = 1

[MyModel]
# This is a note about the model
model = /m.gguf
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(1);
    expect(configs[0].notes).toBe('This is a note about the model');
  });

  it('returns empty array for empty input', () => {
    expect(parseRouterIni('', testParams)).toEqual([]);
  });

  it('preserves param order from file', () => {
    const ini = `version = 1

[MyModel]
model = /m.gguf
n-gpu-layers = 33
ctx-size = 4096
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs[0].paramOrder).toEqual(['model', 'n-gpu-layers', 'ctx-size']);
  });

  it('handles unknown params (not in param defs)', () => {
    const ini = `version = 1

[MyModel]
model = /m.gguf
some-unknown-flag = hello
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(1);
    expect(configs[0].params['some-unknown-flag']).toBe('hello');
  });
});

describe('exportRouterIni', () => {
  function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return {
      id: 'test-id',
      alias: 'TestModel',
      displayName: 'TestModel',
      notes: '',
      modelPath: '/path/to/model.gguf',
      params: {},
      paramOrder: [],
      isDefault: false,
      ...overrides,
    };
  }

  it('exports a basic config', () => {
    const config = makeConfig({
      params: { 'ctx-size': '4096' },
      paramOrder: ['model', 'ctx-size'],
    });
    const ini = exportRouterIni([config], testParams);
    expect(ini).toContain('version = 1');
    expect(ini).toContain('[TestModel]');
    expect(ini).toContain('model = /path/to/model.gguf');
    expect(ini).toContain('ctx-size = 4096');
  });

  it('exports disabled params as comments', () => {
    const config = makeConfig({
      params: { 'flash-attn': 'on' },
      paramOrder: ['model', 'flash-attn'],
      disabledParams: ['flash-attn'],
    });
    const ini = exportRouterIni([config], testParams);
    expect(ini).toContain('# flash-attn = on');
    expect(ini).not.toContain('\nflash-attn = on');
  });

  it('exports unchecked toggles as key = off', () => {
    const config = makeConfig({
      params: { 'load-on-startup': 'off' },
      paramOrder: ['model', 'load-on-startup'],
    });
    const ini = exportRouterIni([config], testParams);
    expect(ini).toContain('load-on-startup = off');
    expect(ini).not.toContain('# load-on-startup = off');
  });

  it('still exports disabled off-toggles as comments', () => {
    const config = makeConfig({
      params: { 'load-on-startup': 'off' },
      paramOrder: ['model', 'load-on-startup'],
      disabledParams: ['load-on-startup'],
    });
    const ini = exportRouterIni([config], testParams);
    expect(ini).toContain('# load-on-startup = off');
  });

  it('exports notes as comment lines inside the section', () => {
    const config = makeConfig({ notes: 'Fast model\nGood for chat' });
    const ini = exportRouterIni([config], testParams);
    expect(ini).toContain('# Fast model');
    expect(ini).toContain('# Good for chat');
    // Notes should appear AFTER the section header
    const sectionIdx = ini.indexOf('[TestModel]');
    const noteIdx = ini.indexOf('# Fast model');
    expect(noteIdx).toBeGreaterThan(sectionIdx);
  });

  it('round-trips: parse(export(configs)) preserves data', () => {
    const original = makeConfig({
      params: { 'ctx-size': '8192', 'n-gpu-layers': '45' },
      paramOrder: ['model', 'ctx-size', 'n-gpu-layers'],
    });

    const ini = exportRouterIni([original], testParams);
    const parsed = parseRouterIni(ini, testParams);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].alias).toBe('TestModel');
    expect(parsed[0].modelPath).toBe('/path/to/model.gguf');
    expect(parsed[0].params['ctx-size']).toBe('8192');
    expect(parsed[0].params['n-gpu-layers']).toBe('45');
  });

  it('round-trips notes inside the section', () => {
    const original = makeConfig({
      notes: 'A test model\nSecond line',
      params: { 'ctx-size': '4096' },
      paramOrder: ['model', 'ctx-size'],
    });

    const ini = exportRouterIni([original], testParams);
    const parsed = parseRouterIni(ini, testParams);

    expect(parsed[0].notes).toBe('A test model\nSecond line');
  });

  it('round-trips disabled params', () => {
    const original = makeConfig({
      params: { 'flash-attn': 'on' },
      paramOrder: ['model', 'flash-attn'],
      disabledParams: ['flash-attn'],
    });

    const ini = exportRouterIni([original], testParams);
    const parsed = parseRouterIni(ini, testParams);

    expect(parsed[0].params['flash-attn']).toBe('on');
    expect(parsed[0].disabledParams).toContain('flash-attn');
  });

  it('adds category headers for grouped params', () => {
    const config = makeConfig({
      params: { 'n-gpu-layers': '33', 'flash-attn': 'on', 'ctx-size': '4096' },
      paramOrder: ['model', 'n-gpu-layers', 'flash-attn', 'ctx-size'],
    });
    const ini = exportRouterIni([config], testParams);
    expect(ini).toContain('## GPU & Offload');
    expect(ini).toContain('## Context & RoPE');
  });

  it('does not repeat category header for consecutive same-category params', () => {
    const config = makeConfig({
      params: { 'n-gpu-layers': '33', 'flash-attn': 'on' },
      paramOrder: ['model', 'n-gpu-layers', 'flash-attn'],
    });
    const ini = exportRouterIni([config], testParams);
    // Both are 'gpu' category — header should appear only once
    const count = (ini.match(/## GPU & Offload/g) || []).length;
    expect(count).toBe(1);
  });

  it('parser skips ## structural headers', () => {
    const ini = `version = 1

[MyModel]
model = /m.gguf
## GPU & Offload
n-gpu-layers = 33
## Context & RoPE
ctx-size = 4096
`;
    const configs = parseRouterIni(ini, testParams);
    expect(configs).toHaveLength(1);
    // Structural headers should NOT appear in notes
    expect(configs[0].notes).not.toContain('GPU');
    expect(configs[0].notes).not.toContain('Context');
  });

  it('round-trips with category headers and notes', () => {
    const original = makeConfig({
      notes: 'My custom note',
      params: { 'n-gpu-layers': '99', 'ctx-size': '16384', 'flash-attn': 'on' },
      paramOrder: ['model', 'n-gpu-layers', 'ctx-size', 'flash-attn'],
    });

    const ini = exportRouterIni([original], testParams);
    const parsed = parseRouterIni(ini, testParams);

    expect(parsed[0].alias).toBe('TestModel');
    expect(parsed[0].notes).toBe('My custom note');
    expect(parsed[0].params['n-gpu-layers']).toBe('99');
    expect(parsed[0].params['ctx-size']).toBe('16384');
    expect(parsed[0].params['flash-attn']).toBe('on');
  });
});
