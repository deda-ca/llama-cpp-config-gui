import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, DEFAULT_CONFIG } from '../config.js';
import { loadModels, saveModels } from '../modelConfig.js';
import { loadEngines } from '../engines/store.js';

// A config file that exists but does not parse used to read as "empty", and the
// next save overwrote it — wiping every model card / engine. The broken file
// must now survive as a `.corrupt-<timestamp>` copy (code review 2026-10-27).

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-safety-'));
  fs.mkdirSync(path.join(tmpDir, '.config'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function backups(name: string): string[] {
  return fs.readdirSync(path.join(tmpDir, '.config')).filter((f) => f.startsWith(`${name}.corrupt-`));
}

describe('corrupt config files are preserved', () => {
  it('models.json: falls back to empty but keeps a copy the next save cannot overwrite', () => {
    const file = path.join(tmpDir, '.config', 'models.json');
    const broken = '{"configs": [{"id": "a", "alias": "keep-me",}]'; // trailing comma typo
    fs.writeFileSync(file, broken);

    expect(loadModels().configs).toEqual([]);
    loadModels(); // a second load of the same broken file adds no second copy
    const copies = backups('models.json');
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, '.config', copies[0]), 'utf-8')).toBe(broken);

    saveModels({ configs: [], templates: [], defaultConfigId: null });
    expect(fs.readFileSync(path.join(tmpDir, '.config', copies[0]), 'utf-8')).toBe(broken);
  });

  it('settings.json and engines.json get the same protection', () => {
    fs.writeFileSync(path.join(tmpDir, '.config', 'settings.json'), '{ "port": 9 ');
    fs.writeFileSync(path.join(tmpDir, '.config', 'engines.json'), 'not json');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
    expect(loadEngines().instances).toEqual([]);
    expect(backups('settings.json')).toHaveLength(1);
    expect(backups('engines.json')).toHaveLength(1);
  });

  it('a missing file is not treated as corrupt', () => {
    expect(loadModels().configs).toEqual([]);
    expect(fs.readdirSync(path.join(tmpDir, '.config'))).toEqual([]);
  });
});
