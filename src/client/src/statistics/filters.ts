import type { StatsFilters } from "@shared/usage";

export type Preset = "today" | "yesterday" | "7" | "30" | "month" | "all" | "custom";
const RELATIVE_PRESETS: string[] = ["today", "yesterday", "7", "30", "month", "all"];
export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function validTimezone(value: string | null, fallback: string): string {
  try { if (value) { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return value; } } catch { /* malformed deep link */ }
  return fallback;
}
function localParts(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (name: string) => Number(parts.find((p) => p.type === name)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}
function midnight(year: number, month: number, day: number, timezone: string): number {
  const target = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const ordinal = year * 10000 + month * 100 + day;
  // Some zones advance the clock at midnight. Find the date boundary rather
  // than solving for a local 00:00 that may never have existed.
  let low = target - 36 * 60 * 60 * 1000, high = target + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const parts = formatter.formatToParts(middle);
    const part = (name: string) => Number(parts.find((p) => p.type === name)?.value ?? 0);
    const localDate = part("year") * 10000 + part("month") * 100 + part("day");
    if (localDate >= ordinal) high = middle;
    else low = middle + 1;
  }
  return low;
}
function shifted(year: number, month: number, day: number, days: number, timezone: string) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return midnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), timezone);
}
export function calendarPeriod(preset: Exclude<Preset, "custom">, now = Date.now(), timezone = browserTimezone()): { from: number; to: number } {
  const p = localParts(now, timezone);
  const today = midnight(p.year, p.month, p.day, timezone);
  const tomorrow = shifted(p.year, p.month, p.day, 1, timezone);
  if (preset === "all") return { from: 0, to: tomorrow };
  if (preset === "yesterday") return { from: shifted(p.year, p.month, p.day, -1, timezone), to: today };
  if (preset === "month") return { from: midnight(p.year, p.month, 1, timezone), to: tomorrow };
  return { from: shifted(p.year, p.month, p.day, preset === "7" ? -6 : preset === "30" ? -29 : 0, timezone), to: tomorrow };
}
export function dateText(at: number, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
function parseDay(value: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day ? { year, month, day } : null;
}
export function dateRange(start: string, end: string, timezone: string): { from: number; to: number } | null {
  const a = parseDay(start), b = parseDay(end);
  if (!a || !b || start > end) return null;
  return { from: midnight(a.year, a.month, a.day, timezone), to: shifted(b.year, b.month, b.day, 1, timezone) };
}
export function parseFilters(search: string, now = Date.now(), fallbackTimezone = browserTimezone()): StatsFilters {
  const query = new URLSearchParams(search);
  const timezone = validTimezone(query.get("timezone"), fallbackTimezone);
  const initial = calendarPeriod("7", now, timezone);
  const from = Number(query.get("from")), to = Number(query.get("to"));
  const validRange = query.has("from") && query.has("to") && Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to <= 8.64e15;
  const preset = query.get("period");
  const range = preset && RELATIVE_PRESETS.includes(preset) ? calendarPeriod(preset as Exclude<Preset, "custom">, now, timezone) : validRange ? { from, to } : initial;
  const distinct = (key: string) => [...new Set(query.getAll(key).filter(Boolean))];
  const role = query.get("role"), granularity = query.get("granularity");
  return { ...range, timezone,
    sources: distinct("source").filter((source) => source === "opencode" || source === "codex"), agents: distinct("agent"), models: distinct("model"), projects: distinct("project"),
    role: role === "roots" || role === "children" ? role : "all", granularity: granularity === "week" || granularity === "month" ? granularity : granularity === "day" ? "day" : preset === "all" ? "month" : "day" };
}
export function serializeFilters(filters: StatsFilters): URLSearchParams {
  const query = new URLSearchParams({ from: String(filters.from), to: String(filters.to), timezone: filters.timezone, role: filters.role, granularity: filters.granularity });
  for (const [key, values] of [["source", filters.sources], ["agent", filters.agents], ["model", filters.models], ["project", filters.projects]] as const) values.forEach((value) => query.append(key, value));
  return query;
}
export function refreshRelativeFilters(filters: StatsFilters, preset: Preset, now = Date.now()): StatsFilters {
  if (preset === "custom") return filters;
  const range = calendarPeriod(preset, now, filters.timezone);
  return range.from === filters.from && range.to === filters.to ? filters : { ...filters, ...range };
}
export function toggleValue(values: string[], value: string): string[] { return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]; }
