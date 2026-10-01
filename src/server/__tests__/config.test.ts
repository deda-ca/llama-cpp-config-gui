import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so we don't touch the real .config directory
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

import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../config.js';

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns defaults when file does not exist', () => {
    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const config = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('merges partial file over defaults', () => {
    readFileSync.mockReturnValue(JSON.stringify({ port: 9999, host: '0.0.0.0' }));
    const config = loadConfig();
    expect(config.port).toBe(9999);
    expect(config.host).toBe('0.0.0.0');
    // Unspecified fields fall back to defaults
    expect(config.gpuLayers).toBe(DEFAULT_CONFIG.gpuLayers);
    expect(config.binary).toBe(DEFAULT_CONFIG.binary);
  });

  it('returns full config when file has all fields', () => {
    const full = { ...DEFAULT_CONFIG, port: 1234 };
    readFileSync.mockReturnValue(JSON.stringify(full));
    const config = loadConfig();
    expect(config.port).toBe(1234);
  });
});

describe('saveConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates directory and writes JSON', () => {
    saveConfig({ ...DEFAULT_CONFIG, port: 8081 });
    expect(mkdirSync).toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [filePath, content] = writeFileSync.mock.calls[0];
    expect(typeof filePath).toBe('string');
    const parsed = JSON.parse(content as string);
    expect(parsed.port).toBe(8081);
  });

  it('writes pretty-printed JSON (2-space indent)', () => {
    saveConfig(DEFAULT_CONFIG);
    const content = writeFileSync.mock.calls[0][1] as string;
    expect(content).toContain('\n  ');
  });
});
