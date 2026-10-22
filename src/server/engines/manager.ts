/**
 * Engine process registry (docs/llm-engines.md §2.2, todo #21 Phase 1 step 2).
 *
 * Replaces the single `LlamaProcessManager` singleton with a map of
 * instanceId -> ManagedInstance. Each ManagedInstance owns one worker (the
 * existing LlamaProcessManager, unchanged), its own log cache, and its own
 * status/metrics. Engine-specific knowledge stays in the worker.
 *
 * During the transition the launch spec is still a LlamaConfig (the legacy
 * /api/launch endpoint sends one); the EngineInstance -> LlamaConfig mapping
 * lands with the REST/API step. This keeps behavior identical while the
 * plumbing becomes per-instance.
 */

import { LlamaProcessManager } from '../llama.js';
import type { LlamaConfig, PerfMetrics, ProcessStatus } from '../types.js';
import type { LogEntry } from '../logParser.js';
import { enginesFileExists, loadEngines, migrateLegacyConfig, saveEngines } from './store.js';
import type { EnginesFile } from './types.js';

const LOG_CACHE_SIZE = 1024;

export interface ManagedInstance {
  id: string;
  worker: LlamaProcessManager;
  /** In-memory log cache, replayed to clients on (re)connect */
  logCache: LogEntry[];
  status: ProcessStatus;
  metrics: PerfMetrics;
}

export interface InstanceEvents {
  onLogLine?: (instanceId: string, line: string) => void;
  onStatusChange?: (instanceId: string, status: ProcessStatus) => void;
  onMetrics?: (instanceId: string, metrics: PerfMetrics) => void;
}

export class EngineManager {
  private instances = new Map<string, ManagedInstance>();
  private events: InstanceEvents;
  /** Engines file (definitions + instances), loaded lazily with legacy migration. */
  private engines: EnginesFile;

  constructor(events: InstanceEvents = {}) {
    this.events = events;
    this.engines = this.loadOrMigrate();
  }

  /** Load engines.json; when absent, synthesize from legacy settings.json. */
  private loadOrMigrate(): EnginesFile {
    if (enginesFileExists()) return loadEngines();
    return { definitions: [], instances: [], defaultInstanceId: null };
  }

  getEngines(): EnginesFile {
    return this.engines;
  }

  /** Persist an updated engines file (and keep the in-memory copy in sync). */
  saveEngines(data: EnginesFile): void {
    this.engines = saveEngines(data);
  }

  /** Seed the engines file from a legacy LlamaConfig (called once at startup). */
  migrateFromLegacy(legacy: LlamaConfig): void {
    if (enginesFileExists()) return;
    const migrated = migrateLegacyConfig(legacy);
    if (!migrated) return;
    this.engines = migrated;
    saveEngines(migrated);
  }

  /** The instance backing the legacy /api/launch, /api/stop, /api/status aliases. */
  getDefaultInstanceId(): string | null {
    return this.engines.defaultInstanceId;
  }

  list(): ManagedInstance[] {
    return [...this.instances.values()];
  }

  get(instanceId: string): ManagedInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Launch (or relaunch) an instance. `config` is the launch spec; the instance
   * id must already exist in the engines file. Wires the worker's callbacks to
   * this instance's cache + the manager's broadcast events.
   */
  launch(instanceId: string, config: LlamaConfig): ManagedInstance {
    let inst = this.instances.get(instanceId);
    if (!inst) {
      inst = this.createInstance(instanceId);
    }
    inst.worker.launch(config);
    return inst;
  }

  private createInstance(instanceId: string): ManagedInstance {
    const worker = new LlamaProcessManager();
    const inst: ManagedInstance = {
      id: instanceId,
      worker,
      logCache: [],
      status: worker.getStatus(),
      metrics: worker.getMetrics(),
    };

    worker.onLogLine = (line) => {
      this.events.onLogLine?.(instanceId, line);
    };
    worker.onStatusChange = (status) => {
      inst.status = status;
      this.events.onStatusChange?.(instanceId, status);
    };
    worker.onMetrics = (metrics) => {
      inst.metrics = metrics;
      this.events.onMetrics?.(instanceId, metrics);
    };

    this.instances.set(instanceId, inst);
    return inst;
  }

  /** Append a parsed log entry to an instance's cache (called by the SSE wiring). */
  pushLog(instanceId: string, entry: LogEntry): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.logCache.push(entry);
    if (inst.logCache.length > LOG_CACHE_SIZE) inst.logCache.shift();
  }

  getLogCache(instanceId: string): LogEntry[] {
    return this.instances.get(instanceId)?.logCache ?? [];
  }

  /** Drop an instance's cached log history (prevents replay on reconnect). */
  clearLogs(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (inst) inst.logCache.length = 0;
  }

  getStatus(instanceId: string): ProcessStatus {
    return this.instances.get(instanceId)?.status ?? 'stopped';
  }

  getMetrics(instanceId: string): PerfMetrics {
    return this.instances.get(instanceId)?.metrics ?? { prefillTokensPerSec: null, generationTokensPerSec: null, lastUpdated: 0 };
  }

  stop(instanceId: string): void {
    this.instances.get(instanceId)?.worker.stop();
  }

  /** Stop every running instance (shutdown / restart). */
  stopAll(): void {
    for (const inst of this.instances.values()) inst.worker.stop();
  }

  /** Aggregate status counts for the header badge. */
  statusCounts(): { running: number; stopped: number; total: number } {
    let running = 0;
    for (const inst of this.instances.values()) {
      if (inst.status === 'running' || inst.status === 'starting') running++;
    }
    return { running, stopped: this.instances.size - running, total: this.instances.size };
  }
}
