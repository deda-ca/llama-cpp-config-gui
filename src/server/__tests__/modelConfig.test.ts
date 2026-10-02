import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFileSync = vi.fn();
const writeFileSync = vi.fn();
const mkdirSync = vi.fn();

vi.mock('fs', () => ({
  default: {
    readFileSync: (...args: any[]) => readFileSync(...args),
    writeFileSync: (...args: any[]) => writeFileSync(...args),
    mkdirSync: (...args: any[]) => mkdirSync(...args),
  },
}));

import { loadModels, saveModels, loadParams, saveParams, generateId } from '../modelConfig.js';
import type { ModelsFile, ParamDef } from '../modelConfig.js';

const emptyModels: ModelsFile = { configs: [], templates: [], defaultConfigId: null, configOrder: [] };

describe('loadModels / saveModels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty state when file missing', () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(loadModels()).toEqual(emptyModels);
  });

  it('round-trips a models file', () => {
    const data: ModelsFile = {
      configs: [{ id: 'a', alias: 'A', displayName: 'A', notes: '', modelPath: '/a.gguf', params: {}, paramOrder: [], isDefault: true }],
      templates: [],
      defaultConfigId: 'a',
      configOrder: ['a'],
    };
    readFileSync.mockReturnValue(JSON.stringify(data));
    expect(loadModels()).toEqual(data);

    saveModels(data);
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toEqual(data);
  });

  it('persists config ordering metadata', () => {
    const data: any = {
      configs: [
        { id: 'b', alias: 'B', displayName: 'B', notes: '', modelPath: '/b.gguf', params: {}, paramOrder: [], isDefault: false },
        { id: 'a', alias: 'A', displayName: 'A', notes: '', modelPath: '/a.gguf', params: {}, paramOrder: [], isDefault: true },
      ],
      templates: [],
      defaultConfigId: 'a',
    };

    saveModels(data);
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.configOrder).toEqual(['b', 'a']);
    expect(written.configs.map((c: any) => c.id)).toEqual(['b', 'a']);
  });

  it('returns empty state on corrupt file', () => {
    readFileSync.mockReturnValue('{ not valid json');
    expect(loadModels()).toEqual(emptyModels);
  });
});

describe('loadParams / saveParams', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when file missing', () => {
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(loadParams()).toEqual([]);
  });

  it('round-trips params', () => {
    const params: ParamDef[] = [
      { flag: '--ctx-size', key: 'ctx-size', label: 'Context', description: '', category: 'context', inputType: 'number' },
    ];
    readFileSync.mockReturnValue(JSON.stringify(params));
    expect(loadParams()).toEqual(params);

    saveParams(params);
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toEqual(params);
  });
});

describe('generateId', () => {
  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('produces base36 strings', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-z]+$/);
    expect(id.length).toBeGreaterThan(5);
  });
});
