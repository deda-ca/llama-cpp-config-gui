import { describe, it, expect } from 'vitest';
import { buildLlamaArgs } from '../engines/llama.js';
import { passthroughDriver } from '../engines/passthrough.js';
import { instanceToLlamaConfig } from '../engines/launch.js';
import { DEFAULT_CONFIG } from '../config.js';
import type { EngineInstance } from '../engines/types.js';

// Code review 2026-10-27: params went through a string round-trip
// (paramsToArgs -> splitArgs) that stripped quotes inside values, and the
// legacy launch passed the API key wrapped in literal quote characters.

const def = { id: 'd', name: 'd', kind: 'llamacpp' as const, buildPath: '/opt/llama', envVars: {} };

function instance(params: EngineInstance['params'], kind: EngineInstance['kind'] = 'llamacpp'): EngineInstance {
  return {
    id: 'i', name: 'i', notes: '', kind, definitionId: 'd', binary: kind === 'llamacpp' ? 'llama-server' : 'my-server',
    params, routerMode: false, modelConfigIds: [], autoLaunch: false,
  } as EngineInstance;
}

describe('engine params reach argv verbatim', () => {
  it('keeps JSON and quoted values intact for llama.cpp', () => {
    const spec = instanceToLlamaConfig(instance([
      { key: '--chat-template-kwargs', value: '{"enable_thinking":false}' },
      { key: '--alias', value: 'my "quoted" model' },
      { key: '--jinja' },
      { key: '--temp', value: '0.7', disabled: true },
    ]), def);
    expect(buildLlamaArgs(spec)).toEqual([
      '--chat-template-kwargs', '{"enable_thinking":false}',
      '--alias', 'my "quoted" model',
      '--jinja',
    ]);
  });

  it('keeps quoted values intact for the passthrough driver', () => {
    const spec = instanceToLlamaConfig(instance([{ key: '--json', value: '{"a": 1}' }], 'custom'), { ...def, kind: 'custom' });
    expect(passthroughDriver.buildArgs(spec)).toEqual(['--json', '{"a": 1}']);
  });

  it('legacy launches pass the API key without literal quotes', () => {
    const args = buildLlamaArgs({ ...DEFAULT_CONFIG, apiKey: 'secret' });
    expect(args[args.indexOf('--api-key') + 1]).toBe('secret');
    const router = buildLlamaArgs({ ...DEFAULT_CONFIG, apiKey: 'secret', routerIniPath: '/r.ini' });
    expect(router[router.indexOf('--api-key') + 1]).toBe('secret');
  });

  it('legacy extraArgs strings are still split', () => {
    expect(buildLlamaArgs({ ...DEFAULT_CONFIG, paramsOnly: true, extraArgs: '--alias "two words" --jinja' }))
      .toEqual(['--alias', 'two words', '--jinja']);
  });
});
