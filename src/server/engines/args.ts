/**
 * Split a raw argument string into tokens, respecting single/double quotes.
 * Same semantics as the helper in llama.ts, shared so legacy `extraArgs` can be
 * migrated into structured EngineParam lists.
 */
export function splitArgs(str: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Convert a token list (from splitArgs) into key/value params.
 * A token starting with `-` becomes a key; the following non-flag token becomes
 * its value. Consecutive flags stay flag-only (e.g. `--metrics --no-warmup`).
 */
export function tokensToParams(tokens: string[]): { key: string; value?: string }[] {
  const params: { key: string; value?: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-')) continue; // leading bare token (binary name) — skip
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      params.push({ key: token, value: next });
      i++;
    } else {
      params.push({ key: token });
    }
  }
  return params;
}

/** Params that actually reach the command line (disabled rows are kept in the
 * config but excluded from the launch, like ModelConfig.disabledParams). */
export function enabledParams<T extends { disabled?: boolean }>(params: T[]): T[] {
  return params.filter((p) => !p.disabled);
}

/** Render params back to a flat CLI string (for display / legacy extraArgs). */
export function paramsToArgs(params: { key: string; value?: string; disabled?: boolean }[]): string {
  return enabledParams(params)
    .map((p) => {
      if (p.value === undefined || p.value === '') return p.key;
      return /\s/.test(p.value) ? `${p.key} "${p.value}"` : `${p.key} ${p.value}`;
    })
    .join(' ');
}

/**
 * Params straight to argv tokens (no quoting round-trip). `paramsToArgs` +
 * `splitArgs` is lossy for a value containing a quote, so a driver that spawns
 * argv directly uses this instead: each enabled row is its key, plus the value
 * as one token when present.
 */
export function paramsToArgv(params: { key: string; value?: string; disabled?: boolean }[]): string[] {
  const out: string[] = [];
  for (const p of enabledParams(params)) {
    out.push(p.key);
    if (p.value !== undefined && p.value !== '') out.push(p.value);
  }
  return out;
}
