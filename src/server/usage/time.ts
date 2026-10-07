import type { StatsFilters } from "@shared/usage";

const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(at: number, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}
export function dayKey(at: number, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
function localMidnight(date: Date, timezone: string): number {
  const wanted = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  // Some zones skip midnight. Find the first real instant of the calendar
  // date rather than oscillating between yesterday 23:00 and today 01:00.
  let low = wanted - 36 * 3600000, high = wanted + 36 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const p = localParts(middle, timezone);
    if (Date.UTC(p.year, p.month - 1, p.day) < wanted) low = middle;
    else high = middle;
  }
  return high;
}
function shiftedClock(at: number, timezone: string, days: number, months = 0): number {
  const p = localParts(at, timezone);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (months) {
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(p.day, last));
  } else date.setUTCDate(date.getUTCDate() + days);
  if (p.hour === 0 && p.minute === 0 && p.second === 0 && at % 1000 === 0) return localMidnight(date, timezone);
  const wanted = date.getTime() + p.hour * 3600000 + p.minute * 60000 + p.second * 1000 + at % 1000;
  let low = date.getTime() - 36 * 3600000, high = date.getTime() + 36 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2), parts = localParts(middle, timezone);
    const clock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) + middle % 1000;
    if (clock < wanted) low = middle; else high = middle;
  }
  return high;
}
export function previousPeriod(filters: StatsFilters, now: number): { from: number; to: number } {
  if (filters.from === 0) return { from: 0, to: 0 };
  const start = localParts(filters.from, filters.timezone), end = localParts(filters.to, filters.timezone);
  const startDate = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const endDate = new Date(Date.UTC(end.year, end.month - 1, end.day));
  const calendarDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
  const effectiveEnd = Math.min(now, filters.to);
  const aligned = filters.from === localMidnight(startDate, filters.timezone) && filters.to === localMidnight(endDate, filters.timezone);
  if (aligned && calendarDays > 0) {
    const month = start.day === 1 && (filters.period === "month" || end.day === 1 && (end.year * 12 + end.month) - (start.year * 12 + start.month) === 1);
    return { from: Math.max(0, shiftedClock(filters.from, filters.timezone, -calendarDays, month ? -1 : 0)), to: Math.max(0, shiftedClock(effectiveEnd, filters.timezone, -calendarDays, month ? -1 : 0)) };
  }
  const span = Math.max(0, effectiveEnd - filters.from);
  return { from: Math.max(0, filters.from - span), to: filters.from };
}
export function bucketBoundaries(from: number, to: number, timezone: string, granularity: StatsFilters["granularity"]): Array<{ key: string; label: string; from: number; to: number }> {
  if (to <= from) return [];
  const p = localParts(from, timezone);
  const calendar = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (granularity === "week") calendar.setUTCDate(calendar.getUTCDate() - (calendar.getUTCDay() + 6) % 7);
  if (granularity === "month") calendar.setUTCDate(1);
  const result = [];
  let start = localMidnight(calendar, timezone);
  while (start < to) {
    const key = dayKey(start, timezone);
    if (granularity === "month") calendar.setUTCMonth(calendar.getUTCMonth() + 1);
    else calendar.setUTCDate(calendar.getUTCDate() + (granularity === "week" ? 7 : 1));
    const end = localMidnight(calendar, timezone);
    if (end <= start) throw new Error("Unable to resolve calendar boundaries");
    result.push({ key, label: key, from: Math.max(from, start), to: Math.min(to, end) });
    start = end;
  }
  return result;
}
export function parseStatsFilters(url: URL, now = Date.now()): StatsFilters {
  const q = url.searchParams;
  const from = Number(q.get("from") ?? Math.max(0, now - 7 * 86400000));
  const to = Number(q.get("to") ?? now);
  if (![from, to].every(Number.isSafeInteger) || from < 0 || to <= from || to > now + 366 * 86400000) throw new Error("invalid statistics range");
  const timezone = q.get("timezone") ?? "UTC";
  localParts(from, timezone);
  const role = q.get("role") ?? "all";
  const granularity = q.get("granularity") ?? "day";
  const period = q.get("period");
  if (period && !["today", "yesterday", "7", "30", "month", "all", "custom"].includes(period)) throw new Error("invalid statistics period");
  if (!["all", "roots", "children"].includes(role) || !["day", "week", "month"].includes(granularity)) throw new Error("invalid statistics filter");
  const list = (key: string) => [...new Set(q.getAll(key))].filter(Boolean);
  const sources = list("source");
  if (sources.some(source => !["opencode", "codex"].includes(source))) throw new Error("invalid statistics source");
  return { from, to, timezone, sources, agents: list("agent"), models: list("model"), projects: list("project"), role: role as StatsFilters["role"], granularity: granularity as StatsFilters["granularity"], ...(period ? { period: period as StatsFilters["period"] } : {}) };
}
