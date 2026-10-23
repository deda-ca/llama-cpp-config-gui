/**
 * Engine kind drivers (docs/llm-engines.md §2.1, todo #21 Phase 3).
 *
 * A driver owns everything that is *specific to one engine family*: the
 * executable name inside a build folder, the CLI arg builder, the version
 * probe, device listing, and log interpretation (line level + metrics).
 * The process layer (`worker.ts`) is generic — it spawns, streams lines,
 * tracks status, and delegates every engine-specific decision here.
 *
 * The launch spec is still a `LlamaConfig` during the transition: the legacy
 * `/api/launch` endpoints send one directly, and `engines/launch.ts` maps an
 * `EngineInstance` + `EngineDefinition` to one. Fields a kind does not use
 * are simply ignored by its driver.
 *
 * Registry: `getDriver(kind)` returns the kind's driver, falling back to the
 * passthrough driver for kinds without a dedicated one (custom, unknown).
 */

import type { LlamaConfig, LlamaDevice, PerfMetrics } from '../types.js';
import type { LogEntry, ParsedLog } from './llama.js';
import type { EngineKind } from './types.js';
import { llamaDriver } from './llama.js';
import { strataDriver } from './strataDriver.js';
import { audioDriver } from './audioDriver.js';
import { passthroughDriver } from './passthrough.js';

/** Result of probing a build folder for version/build info. */
export interface DriverVersionInfo {
  version: string | null;
  build: string | null;
  commit: string | null;
  compiler: string | null;
  backend: string | null;
  raw: string[];
}

/** How a driver wants its process spawned, when the default layout does not fit. */
export interface DriverLaunch {
  /** Executable to spawn (absolute, or resolved from PATH). */
  command: string;
  /** Full argv after the command. */
  args: string[];
  /** Working directory for the child. */
  cwd: string;
}

export interface EngineDriver {
  /** Engine family this driver implements. */
  kind: EngineKind;
  /** Executable name inside the build folder for this launch. */
  binaryName(spec: LlamaConfig): string;
  /** Full CLI arguments for a launch (excluding the binary itself). */
  buildArgs(spec: LlamaConfig): string[];
  /**
   * Complete spawn plan, for kinds that do not follow the llama.cpp layout of
   * `<buildPath>/<binary>` run with `cwd = buildPath` (strata runs a Python
   * module from the repo root). When present the worker uses this instead of
   * `binaryName`/`buildArgs`, so the process layer stays generic.
   */
  buildLaunch?(spec: LlamaConfig): DriverLaunch;
  /** Probe `<buildPath>/<binary> --version`. Absent = no version support. */
  getVersion?(buildPath: string): Promise<DriverVersionInfo>;
  /** List devices the build reports. Absent = no device listing. */
  listDevices?(buildPath: string): Promise<LlamaDevice[]>;
  /** Classify one output line (level for coloring). Absent = treat as plain. */
  toLogEntry?(line: string): LogEntry;
  /** Structured parse of one output line. Absent = lines are unstructured. */
  parseLogLine?(line: string): ParsedLog | null;
  /** Extract perf metrics from one output line. Absent = no metrics. */
  extractMetrics?(line: string, current: PerfMetrics): PerfMetrics | null;
}

const drivers = new Map<EngineKind, EngineDriver>([
  [llamaDriver.kind, llamaDriver],
  [strataDriver.kind, strataDriver],
  [audioDriver.kind, audioDriver],
]);

/** Look up the driver for a kind; unknown kinds get the passthrough driver. */
export function getDriver(kind: EngineKind | string | undefined): EngineDriver {
  return drivers.get(kind as EngineKind) ?? passthroughDriver;
}
