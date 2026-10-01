/**
 * Parser for llama.cpp structured log output.
 *
 * Format: [PID] timestamp LEVEL component [function]: message
 *   - The [PID] prefix is optional (present in some builds/contexts).
 *   - The function field is optional (e.g. "E ggml_cuda_init: ..." has no function).
 *
 * Examples:
 *   [55997] 113.23.820.783 I slot print_timing: id  0 | task 38633 | n_gen =    228, tg =  74.89 t/s, tg_3s =  75.22 t/s
 *   0.20.763.882 I slot print_timing: id  3 | task 0 | prompt eval time =      55.97 ms /     8 tokens (...)
 *   0.00.070.233 E ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected
 */

// --- Base parsed log line ---

export interface ParsedLog {
  /** Process ID, or null when the line has no [PID] prefix */
  pid: number | null;
  timestamp: string;
  level: 'I' | 'W' | 'E' | 'F';
  component: string;
  /** Function/source name, or empty string when absent */
  func: string;
  message: string;
}

// Timestamp is always d.d.d.d (e.g. 0.20.763.882 or 113.23.820.783)
const LOG_RE = /^(?:\[(\d+)\]\s+)?(\d+\.\d+\.\d+\.\d+)\s+([IWEF])\s+(\S+)(?:\s+(\S+?))?\s*:\s*(.*)$/;

/**
 * Parse a single log line into structured fields.
 * Returns null if the line does not match the llama.cpp structured format.
 */
export function parseLogLine(line: string): ParsedLog | null {
  const m = line.match(LOG_RE);
  if (!m) return null;
  return {
    pid: m[1] ? parseInt(m[1], 10) : null,
    timestamp: m[2],
    level: m[3] as 'I' | 'W' | 'E' | 'F',
    component: m[4],
    func: m[5] || '',
    message: m[6],
  };
}

// --- Log entry (raw text + level) for SSE transport & client coloring ---

export type LogLevel = 'I' | 'W' | 'E' | 'F';

export interface LogEntry {
  raw: string;
  /** Parsed log level, or 'plain' when the line is not structured */
  level: LogLevel | 'plain';
}

/**
 * Convert a raw log line into a LogEntry (raw text + level for coloring).
 * Non-structured lines get level 'plain'.
 */
export function toLogEntry(line: string): LogEntry {
  const parsed = parseLogLine(line);
  return { raw: line, level: parsed ? parsed.level : 'plain' };
}

// --- print_timing sub-parsers ---

export interface GenStats {
  type: 'gen-stats';
  id: number;
  task: number;
  nGen: number;
  tg: number;      // avg tokens/s
  tg3s: number;    // tokens/s (last 3s window)
}

export interface PromptEval {
  type: 'prompt-eval';
  id: number;
  task: number;
  timeMs: number;
  tokens: number;
  msPerToken: number;
  tokensPerSec: number;
}

export interface EvalTime {
  type: 'eval-time';
  id: number;
  task: number;
  timeMs: number;
  tokens: number;
  msPerToken: number;
  tokensPerSec: number;
}

export interface TotalTime {
  type: 'total-time';
  id: number;
  task: number;
  timeMs: number;
  tokens: number;
}

export interface PromptProgress {
  type: 'prompt-progress';
  id: number;
  task: number;
  nTokens: number;
  progress: number;   // 0..1
  timeSec: number;
  tokensPerSec: number;
}

export type TimingData = GenStats | PromptEval | EvalTime | TotalTime | PromptProgress;

// Sub-patterns for print_timing message field

const GEN_STATS_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*n_gen\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t\/s,\s*tg_3s\s*=\s*([\d.]+)\s*t\/s$/;

const PROMPT_EVAL_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)$/;

const EVAL_TIME_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)$/;

const TOTAL_TIME_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens$/;

const PROMPT_PROGRESS_RE = /^id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*prompt processing,\s*n_tokens\s*=\s*(\d+),\s*progress\s*=\s*([\d.]+),\s*t\s*=\s*([\d.]+)\s*s\s*\/\s*([\d.]+)\s*tokens per second$/;

/**
 * Parse the message portion of a print_timing log line into structured timing data.
 * Returns null if the message doesn't match any known sub-format.
 */
export function parseTimingMessage(message: string): TimingData | null {
  // Generation stats (ongoing or final)
  let m = message.match(GEN_STATS_RE);
  if (m) {
    return {
      type: 'gen-stats',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      nGen: parseInt(m[3], 10),
      tg: parseFloat(m[4]),
      tg3s: parseFloat(m[5]),
    };
  }

  // Prompt eval time (part of final results group)
  m = message.match(PROMPT_EVAL_RE);
  if (m) {
    return {
      type: 'prompt-eval',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      timeMs: parseFloat(m[3]),
      tokens: parseInt(m[4], 10),
      msPerToken: parseFloat(m[5]),
      tokensPerSec: parseFloat(m[6]),
    };
  }

  // Eval time (part of final results group)
  m = message.match(EVAL_TIME_RE);
  if (m) {
    return {
      type: 'eval-time',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      timeMs: parseFloat(m[3]),
      tokens: parseInt(m[4], 10),
      msPerToken: parseFloat(m[5]),
      tokensPerSec: parseFloat(m[6]),
    };
  }

  // Total time (part of final results group)
  m = message.match(TOTAL_TIME_RE);
  if (m) {
    return {
      type: 'total-time',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      timeMs: parseFloat(m[3]),
      tokens: parseInt(m[4], 10),
    };
  }

  // Prompt processing progress (during prefill)
  m = message.match(PROMPT_PROGRESS_RE);
  if (m) {
    return {
      type: 'prompt-progress',
      id: parseInt(m[1], 10),
      task: parseInt(m[2], 10),
      nTokens: parseInt(m[3], 10),
      progress: parseFloat(m[4]),
      timeSec: parseFloat(m[5]),
      tokensPerSec: parseFloat(m[6]),
    };
  }

  return null;
}
