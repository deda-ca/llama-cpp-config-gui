export interface ParamDef {
  flag: string;
  key: string;
  label: string;
  description: string;
  category: string;
  inputType: string;
  default?: string;
  options?: string[];
  /** Preset values for 'preset' inputs (free text still allowed, shown in a dropdown) */
  presets?: string[];
}

export interface ModelConfig {
  id: string;
  alias: string;
  displayName: string;
  notes: string;
  modelPath: string;
  mmproj?: string;
  chatTemplateFile?: string;
  params: Record<string, string>;
  paramOrder: string[];
  /** Param keys that are kept in the config but disabled (commented out in INI) */
  disabledParams?: string[];
  /** Whether this config is included in router launches (checkbox in the list) */
  includeInLaunch?: boolean;
  isDefault: boolean;
}

export interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  params: Record<string, string>;
  paramOrder: string[];
}

export interface ModelsFile {
  configs: ModelConfig[];
  templates: ConfigTemplate[];
  defaultConfigId: string | null;
  configOrder?: string[];
}

export interface SystemStats {
  cpu: {
    overallPercent: number;
    coreCount: number;
    activeCores: number;
    perCore: number[];
  };
  ram: {
    usedBytes: number;
    totalBytes: number;
  };
  disk: {
    usedBytes: number;
    totalBytes: number;
    readMBs: number | null;
    writeMBs: number | null;
  };
}

/** A log line with its parsed level (for color-coding). */
export interface LogEntry {
  raw: string;
  /** Parsed log level, or 'plain' when the line is not structured */
  level: 'I' | 'W' | 'E' | 'F' | 'plain';
}

/** Live model performance status extracted from print_timing log lines. */
export interface ModelStatusData {
  // PROMPT row
  promptProgress: number | null;      // 0..1 during prefill
  promptTokens: number | null;        // tokens in prompt
  promptSpeed: number | null;         // prompt tokens/s
  // GENERATION row
  genTokens: number | null;           // generated token count
  genAvgTps: number | null;          // avg generation t/s
  gen3sTps: number | null;           // last-3s window t/s
  genMsPerToken: number | null;      // ms per token (from eval-time)
  // SUMMARY row
  totalTimeMs: number | null;        // total time in ms
  totalTokens: number | null;        // total tokens (prompt + gen)
}
