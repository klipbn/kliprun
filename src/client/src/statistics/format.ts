import type { UsageTokens } from "@shared/usage";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const count = (value: number) => new Intl.NumberFormat("en-US").format(value);
export const tokens = (value: number) => compact.format(value);
export function duration(value: number | null): string {
  if (value === null) return "No data";
  const seconds = Math.floor(Math.max(0, value) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return `${count(hours)}h${remainder ? ` ${remainder}m` : ""}`;
}
export const sourceName = (source: string) => source === "codex" ? "Codex CLI" : source === "opencode" ? "OpenCode" : source;
export const projectName = (directory: string) => directory === "__unknown__" || directory === "unknown" ? "Unknown" : directory.split(/[\\/]/).filter(Boolean).at(-1) || directory || "Unknown";
export const readable = (value: string) => value === "unknown" || value === "__unknown__" || !value ? "Unknown" : value;
export function dateLabel(at: number, timezone: string, full = false): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, day: "numeric", month: "short", ...(full ? { year: "numeric", hour: "2-digit", minute: "2-digit" } : {}) }).format(at);
}
export const percent = (part: number, total: number) => total > 0 ? `${Math.round(part / total * 100)}%` : "—";
export function cacheShare(value: UsageTokens): string { return percent(value.cache_read, value.input + value.cache_read + value.cache_write); }
export function compare(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return "No comparison data";
  if (previous === 0) return current === 0 ? "No change" : "Previously 0";
  const delta = (current - previous) / previous * 100;
  if (Math.abs(delta) < 0.5) return "No change";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("en-US", { maximumFractionDigits: 0 })}% vs. previous period`;
}
export const TOKEN_PARTS: Array<{ key: Exclude<keyof UsageTokens, "total">; label: string; color: string }> = [
  { key: "input", label: "Uncached input", color: "#58a6ff" },
  { key: "cache_read", label: "Cache read", color: "#3fb950" },
  { key: "cache_write", label: "Cache write", color: "#56d4dd" },
  { key: "output", label: "Output", color: "#bc8cff" },
  { key: "reasoning", label: "Reasoning", color: "#d29922" },
  { key: "other", label: "Other", color: "#8b949e" },
];
