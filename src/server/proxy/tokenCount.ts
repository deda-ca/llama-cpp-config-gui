/**
 * Fallback input-token estimation when the upstream response omits `usage`
 * (older llama.cpp builds, error responses). Rough chars/4 heuristic; can be
 * refined later via llama-server POST /tokenize.
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars per token on average for English BPE vocabularies.
  return Math.max(1, Math.round(text.length / 4));
}

/** Estimate tokens across a chat-completions `messages` array. */
export function estimateMessagesTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (typeof part?.text === 'string') total += estimateTokens(part.text);
      }
    }
    total += 4; // per-message role/separator overhead
  }
  return total;
}
