import { describe, it, expect } from 'vitest';
import { parseLogLine, parseTimingMessage, toLogEntry } from '../logParser.js';
import { FINAL_RESULTS, PROMPT_PROGRESS, GEN_STATS, UNSTRUCTURED, REAL_LOGS } from './fixtures/logLines.js';

describe('parseLogLine', () => {
  it('parses a structured log line into all fields', () => {
    const parsed = parseLogLine(FINAL_RESULTS[0]);
    expect(parsed).not.toBeNull();
    expect(parsed!.pid).toBe(55997);
    expect(parsed!.timestamp).toBe('113.23.820.783');
    expect(parsed!.level).toBe('I');
    expect(parsed!.component).toBe('slot');
    expect(parsed!.func).toBe('print_timing');
    expect(parsed!.message).toBe('id  0 | task 38633 | n_gen =    228, tg =  74.89 t/s, tg_3s =  75.22 t/s');
  });

  it('parses all final-results lines', () => {
    for (const line of FINAL_RESULTS) {
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.pid).toBe(55997);
      expect(parsed!.level).toBe('I');
      expect(parsed!.component).toBe('slot');
      expect(parsed!.func).toBe('print_timing');
    }
  });

  it('parses all prompt-progress lines', () => {
    for (const line of PROMPT_PROGRESS) {
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.func).toBe('print_timing');
    }
  });

  it('parses all gen-stats lines', () => {
    for (const line of GEN_STATS) {
      const parsed = parseLogLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.func).toBe('print_timing');
    }
  });

  it('returns null for unstructured lines', () => {
    for (const line of UNSTRUCTURED) {
      expect(parseLogLine(line)).toBeNull();
    }
  });

  it('handles warning and error levels', () => {
    const warn = parseLogLine('[123] 1.00.000.000 W slot some_func: something is off');
    expect(warn).not.toBeNull();
    expect(warn!.level).toBe('W');

    const err = parseLogLine('[123] 1.00.000.000 E llama load_model: failed to open file');
    expect(err).not.toBeNull();
    expect(err!.level).toBe('E');
    expect(err!.component).toBe('llama');
    expect(err!.func).toBe('load_model');
  });

  it('parses real logs without [PID] prefix (pid is null)', () => {
    for (const line of REAL_LOGS) {
      const parsed = parseLogLine(line);
      expect(parsed, `should parse: ${line}`).not.toBeNull();
      expect(parsed!.pid).toBeNull();
    }
  });

  it('parses a line with no function field (component only)', () => {
    // "E ggml_cuda_init: failed..." — component=ggml_cuda_init, no separate func
    const parsed = parseLogLine(REAL_LOGS[1]);
    expect(parsed).not.toBeNull();
    expect(parsed!.level).toBe('E');
    expect(parsed!.component).toBe('ggml_cuda_init');
    expect(parsed!.func).toBe('');
    expect(parsed!.message).toContain('failed to initialize CUDA');
  });

  it('parses a line with both component and function', () => {
    const parsed = parseLogLine(REAL_LOGS[2]);
    expect(parsed).not.toBeNull();
    expect(parsed!.component).toBe('cmn');
    expect(parsed!.func).toBe('common_param');
    expect(parsed!.message).toContain('verbosity = 3');
  });

  it('parses real print_timing lines and extracts timing data', () => {
    const peLine = REAL_LOGS.find((l) => l.includes('prompt eval time'))!;
    const pe = parseTimingMessage(parseLogLine(peLine)!.message);
    expect(pe).not.toBeNull();
    expect(pe!.type).toBe('prompt-eval');

    const etLine = REAL_LOGS.find((l) => /eval time\s*=/.test(l) && !l.includes('prompt eval'))!;
    const et = parseTimingMessage(parseLogLine(etLine)!.message);
    expect(et).not.toBeNull();
    expect(et!.type).toBe('eval-time');

    const ttLine = REAL_LOGS.find((l) => l.includes('total time'))!;
    const tt = parseTimingMessage(parseLogLine(ttLine)!.message);
    expect(tt).not.toBeNull();
    expect(tt!.type).toBe('total-time');
  });
});

describe('parseTimingMessage — gen-stats', () => {
  it('parses ongoing generation stats', () => {
    const parsed = parseLogLine(GEN_STATS[0])!;
    const data = parseTimingMessage(parsed.message);
    expect(data).not.toBeNull();
    expect(data!.type).toBe('gen-stats');
    if (data!.type === 'gen-stats') {
      expect(data!.id).toBe(0);
      expect(data!.task).toBe(25672);
      expect(data!.nGen).toBe(1118);
      expect(data!.tg).toBeCloseTo(123.79, 2);
      expect(data!.tg3s).toBeCloseTo(128.08, 2);
    }
  });

  it('parses all gen-stats lines with increasing n_gen', () => {
    const nGens: number[] = [];
    for (const line of GEN_STATS) {
      const parsed = parseLogLine(line)!;
      const data = parseTimingMessage(parsed.message);
      expect(data).not.toBeNull();
      expect(data!.type).toBe('gen-stats');
      if (data!.type === 'gen-stats') nGens.push(data!.nGen);
    }
    // n_gen should be monotonically increasing
    for (let i = 1; i < nGens.length; i++) {
      expect(nGens[i]).toBeGreaterThan(nGens[i - 1]);
    }
  });
});

describe('parseTimingMessage — prompt-progress', () => {
  it('parses prompt processing progress', () => {
    const parsed = parseLogLine(PROMPT_PROGRESS[0])!;
    const data = parseTimingMessage(parsed.message);
    expect(data).not.toBeNull();
    expect(data!.type).toBe('prompt-progress');
    if (data!.type === 'prompt-progress') {
      expect(data!.id).toBe(0);
      expect(data!.task).toBe(30880);
      expect(data!.nTokens).toBe(4096);
      expect(data!.progress).toBeCloseTo(0.98, 2);
      expect(data!.timeSec).toBeCloseTo(4.64, 2);
      expect(data!.tokensPerSec).toBeCloseTo(882.60, 1);
    }
  });

  it('reaches progress 1.00 on the final line', () => {
    const parsed = parseLogLine(PROMPT_PROGRESS[3])!;
    const data = parseTimingMessage(parsed.message);
    expect(data!.type).toBe('prompt-progress');
    if (data!.type === 'prompt-progress') {
      expect(data!.progress).toBeCloseTo(1.0, 2);
      expect(data!.nTokens).toBe(5948);
    }
  });
});

describe('parseTimingMessage — final results group', () => {
  it('parses prompt eval time', () => {
    const parsed = parseLogLine(FINAL_RESULTS[1])!;
    const data = parseTimingMessage(parsed.message);
    expect(data).not.toBeNull();
    expect(data!.type).toBe('prompt-eval');
    if (data!.type === 'prompt-eval') {
      expect(data!.id).toBe(0);
      expect(data!.task).toBe(38633);
      expect(data!.timeMs).toBeCloseTo(2243.22, 1);
      expect(data!.tokens).toBe(952);
      expect(data!.msPerToken).toBeCloseTo(2.36, 2);
      expect(data!.tokensPerSec).toBeCloseTo(424.39, 1);
    }
  });

  it('parses eval time', () => {
    const parsed = parseLogLine(FINAL_RESULTS[2])!;
    const data = parseTimingMessage(parsed.message);
    expect(data).not.toBeNull();
    expect(data!.type).toBe('eval-time');
    if (data!.type === 'eval-time') {
      expect(data!.id).toBe(0);
      expect(data!.task).toBe(38633);
      expect(data!.timeMs).toBeCloseTo(3325.02, 1);
      expect(data!.tokens).toBe(246);
      expect(data!.msPerToken).toBeCloseTo(13.57, 2);
      expect(data!.tokensPerSec).toBeCloseTo(73.68, 1);
    }
  });

  it('parses total time', () => {
    const parsed = parseLogLine(FINAL_RESULTS[3])!;
    const data = parseTimingMessage(parsed.message);
    expect(data).not.toBeNull();
    expect(data!.type).toBe('total-time');
    if (data!.type === 'total-time') {
      expect(data!.id).toBe(0);
      expect(data!.task).toBe(38633);
      expect(data!.timeMs).toBeCloseTo(5568.24, 1);
      expect(data!.tokens).toBe(1198);
    }
  });

  it('parses the gen-stats line in the final group', () => {
    const parsed = parseLogLine(FINAL_RESULTS[0])!;
    const data = parseTimingMessage(parsed.message);
    expect(data!.type).toBe('gen-stats');
    if (data!.type === 'gen-stats') {
      expect(data!.task).toBe(38633);
      expect(data!.nGen).toBe(228);
      expect(data!.tg).toBeCloseTo(74.89, 2);
    }
  });
});

describe('parseTimingMessage — edge cases', () => {
  it('returns null for unrecognized message format', () => {
    expect(parseTimingMessage('some unknown timing text')).toBeNull();
    expect(parseTimingMessage('')).toBeNull();
  });

  it('does not confuse eval-time with prompt-eval', () => {
    // "prompt eval time" must match prompt-eval, not eval-time
    const pe = parseTimingMessage(FINAL_RESULTS[1].split(': ')[1]);
    expect(pe!.type).toBe('prompt-eval');

    const et = parseTimingMessage(FINAL_RESULTS[2].split(': ')[1]);
    expect(et!.type).toBe('eval-time');
  });
});

describe('toLogEntry', () => {
  it('returns level I for structured info lines', () => {
    const entry = toLogEntry(GEN_STATS[0]);
    expect(entry.raw).toBe(GEN_STATS[0]);
    expect(entry.level).toBe('I');
  });

  it('returns level W for warning lines', () => {
    const entry = toLogEntry('[123] 1.00.000.000 W slot some_func: heads up');
    expect(entry.level).toBe('W');
  });

  it('returns level E for error lines', () => {
    const entry = toLogEntry('[123] 1.00.000.000 E llama load_model: failed');
    expect(entry.level).toBe('E');
  });

  it('returns level F for fatal lines', () => {
    const entry = toLogEntry('[123] 1.00.000.000 F server main: crash');
    expect(entry.level).toBe('F');
  });

  it('returns level plain for unstructured lines', () => {
    for (const line of UNSTRUCTURED) {
      const entry = toLogEntry(line);
      expect(entry.raw).toBe(line);
      expect(entry.level).toBe('plain');
    }
  });
});
