import type { UsageTokens } from "@shared/usage";

const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
export const count = (value: number) => new Intl.NumberFormat("ru-RU").format(value);
export const tokens = (value: number) => compact.format(value);
export function duration(value: number | null): string {
  if (value === null) return "Нет данных";
  const seconds = Math.floor(Math.max(0, value) / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return `${count(hours)} ч${remainder ? ` ${remainder} мин` : ""}`;
}
export const sourceName = (source: string) => source === "codex" ? "Codex CLI" : source === "opencode" ? "OpenCode" : source;
export const projectName = (directory: string) => directory === "__unknown__" || directory === "unknown" ? "Неизвестно" : directory.split(/[\\/]/).filter(Boolean).at(-1) || directory || "Неизвестно";
export const readable = (value: string) => value === "unknown" || value === "__unknown__" || !value ? "Неизвестно" : value;
export function dateLabel(at: number, timezone: string, full = false): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, day: "numeric", month: "short", ...(full ? { year: "numeric", hour: "2-digit", minute: "2-digit" } : {}) }).format(at);
}
export const percent = (part: number, total: number) => total > 0 ? `${Math.round(part / total * 100)}%` : "—";
export function cacheShare(value: UsageTokens): string { return percent(value.cache_read, value.input + value.cache_read + value.cache_write); }
export function compare(current: number | null, previous: number | null): string {
  if (current === null || previous === null) return "Нет данных для сравнения";
  if (previous === 0) return current === 0 ? "Без изменений" : "Ранее — 0";
  const delta = (current - previous) / previous * 100;
  if (Math.abs(delta) < 0.5) return "Без изменений";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("ru-RU", { maximumFractionDigits: 0 })}% к предыдущему периоду`;
}
export const TOKEN_PARTS: Array<{ key: Exclude<keyof UsageTokens, "total">; label: string; color: string }> = [
  { key: "input", label: "Обычный вход", color: "#58a6ff" },
  { key: "cache_read", label: "Чтение кэша", color: "#3fb950" },
  { key: "cache_write", label: "Запись кэша", color: "#56d4dd" },
  { key: "output", label: "Ответ", color: "#bc8cff" },
  { key: "reasoning", label: "Reasoning", color: "#d29922" },
  { key: "other", label: "Прочие", color: "#8b949e" },
];
