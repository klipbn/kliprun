import type { UsageTokens } from "@shared/usage";
export interface NormalizedUsage { tokens: UsageTokens; incomplete: boolean }

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function normalize(total: number | null, categories: Omit<UsageTokens, "total" | "other">, incomplete: boolean): NormalizedUsage | null {
  const sum = Object.values(categories).reduce((acc, value) => acc + value, 0);
  if (total === null && sum === 0) return null;
  const knownTotal = total ?? sum;
  if (sum > knownTotal) return { tokens: { total: knownTotal, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: knownTotal }, incomplete: true };
  return { tokens: { total: knownTotal, ...categories, other: knownTotal - sum }, incomplete: incomplete || total === null };
}

/** OpenCode stores canonical, exclusive usage categories. Keep its recorded total authoritative. */
export function normalizeOpenCodeTokens(value: unknown): NormalizedUsage | null {
  const data = record(value); const cache = record(data.cache);
  const input = nonnegative(data.input); const output = nonnegative(data.output);
  return normalize(nonnegative(data.total), {
    input: input ?? 0, output: output ?? 0, reasoning: nonnegative(data.reasoning) ?? 0,
    cache_read: nonnegative(cache.read) ?? 0, cache_write: nonnegative(cache.write) ?? 0,
  }, input === null || output === null);
}

/** Codex input includes cached input and output includes reasoning output. */
export function normalizeCodexTokens(value: unknown): NormalizedUsage | null {
  const data = record(value); const input = nonnegative(data.input_tokens); const output = nonnegative(data.output_tokens);
  const cached = nonnegative(data.cached_input_tokens) ?? 0; const written = nonnegative(data.cache_write_input_tokens) ?? 0;
  const reasoning = nonnegative(data.reasoning_output_tokens) ?? 0;
  const invalid = cached + written > (input ?? 0) || reasoning > (output ?? 0);
  const normalized = normalize(nonnegative(data.total_tokens), {
    input: Math.max(0, (input ?? 0) - cached - written), output: Math.max(0, (output ?? 0) - reasoning),
    reasoning, cache_read: cached, cache_write: written,
  }, input === null || output === null || invalid);
  if (invalid && normalized) return { tokens: { total: normalized.tokens.total, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: normalized.tokens.total }, incomplete: true };
  return normalized;
}
