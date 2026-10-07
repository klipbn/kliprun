import type { StatsDashboardPayload, StatsFilters, StatsSessionPayload, StatsSessionRow, StatsSessionsPayload, UsageAttribution, UsageEvent, UsageImportStatus, UsageInterval, UsageMetrics, UsageSession, UsageTokens } from "@shared/usage";
import { bucketBoundaries, dayKey, localParts, previousPeriod } from "./time";

export interface UsageDataset {
  sessions: UsageSession[];
  events: UsageEvent[];
  intervals: UsageInterval[];
  attributions: UsageAttribution[];
  observed_at: number;
  sources: UsageImportStatus[];
}
const UNKNOWN = "__unknown__";
export const emptyTokens = (): UsageTokens => ({ total: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: 0 });
interface Segment { session_id: string; start: number; end: number; column: string; agent: string | null; model: string | null }
interface Contribution { session: UsageSession; root: string; agent: string | null; model: string | null; event?: UsageEvent; segment?: Segment }
export function unionDuration(ranges: Array<{ start: number; end: number }>): number {
  const sorted = ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start);
  let sum = 0, start = 0, end = 0;
  for (const range of sorted) {
    if (range.start > end) { sum += end - start; start = range.start; end = range.end; }
    else end = Math.max(end, range.end);
  }
  return sum + end - start;
}
function roots(sessions: UsageSession[]): Map<string, string> {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const result = new Map<string, string>();
  for (const session of sessions) {
    const seen = new Set<string>();
    let cursor = session;
    while (cursor.parent_id && byId.has(cursor.parent_id) && !seen.has(cursor.id)) {
      seen.add(cursor.id); cursor = byId.get(cursor.parent_id)!;
    }
    result.set(session.id, seen.has(cursor.id) ? session.id : cursor.id);
  }
  return result;
}
function segments(data: UsageDataset, filters: StatsFilters): Segment[] {
  const attrs = new Map<number, UsageAttribution[]>();
  for (const attr of data.attributions) { const list = attrs.get(attr.interval_id) ?? []; list.push(attr); attrs.set(attr.interval_id, list); }
  const result: Segment[] = [];
  for (const row of data.intervals) {
    const start = Math.max(row.entered_at, filters.from);
    const end = Math.min(row.exited_at ?? data.observed_at, filters.to, data.observed_at || row.exited_at || 0);
    if (end <= start) continue;
    let cursor = start;
    const relevant = (attrs.get(row.id) ?? []).filter(a => a.end > start && a.start < end).sort((a, b) => a.start - b.start);
    const add = (s: number, e: number, agent: string | null, model: string | null) => {
      if (e > s) result.push({ session_id: row.session_id, start: s, end: e, column: row.column_name, agent, model });
    };
    for (const attr of relevant) {
      const s = Math.max(cursor, attr.start), e = Math.min(end, attr.end);
      add(cursor, s, null, null); add(s, e, attr.agent, attr.model); cursor = Math.max(cursor, e);
    }
    add(cursor, end, null, null);
  }
  return result;
}
function contributions(data: UsageDataset, f: StatsFilters): Contribution[] {
  const byId = new Map(data.sessions.map(s => [s.id, s])), rootIds = roots(data.sessions);
  const accepts = (session: UsageSession | undefined, agent: string | null, model: string | null): session is UsageSession => !!session
    && (!f.sources.length || f.sources.includes(session.source))
    && (!f.projects.length || f.projects.includes(session.directory))
    && (f.role === "all" || (f.role === "roots" ? !session.parent_id : !!session.parent_id))
    && (!f.agents.length || f.agents.includes(agent ?? UNKNOWN))
    && (!f.models.length || f.models.includes(model ?? UNKNOWN));
  const result: Contribution[] = [];
  for (const event of data.events) {
    if (event.at === null ? f.from !== 0 : event.at < f.from || event.at >= f.to) continue;
    const session = byId.get(event.session_id);
    if (accepts(session, event.agent, event.model)) result.push({ session, root: rootIds.get(session.id)!, agent: event.agent, model: event.model, event });
  }
  for (const segment of segments(data, f)) {
    const session = byId.get(segment.session_id);
    if (accepts(session, segment.agent, segment.model)) result.push({ session, root: rootIds.get(session.id)!, agent: segment.agent, model: segment.model, segment });
  }
  return result;
}
function summarize(items: Contribution[], timezone: string): UsageMetrics {
  const tokens = emptyTokens(), tasks = new Set<string>(), days = new Set<string>();
  const observed = new Map<string, Array<{ start: number; end: number }>>(), used: Array<{ id: string; at: number | null }> = [];
  const running: Array<{ start: number; end: number }> = [];
  let calls = 0, turns = 0, cost = 0, costCalls = 0, incomplete = false, hasObservation = false;
  for (const item of items) {
    const event = item.event, segment = item.segment;
    if (event) {
      tasks.add(item.root); used.push({ id: item.session.id, at: event.at });
      if (event.at !== null) days.add(dayKey(event.at, timezone));
      if (event.kind === "turn") turns++;
      else {
        calls++;
        if (event.tokens) for (const key of Object.keys(tokens) as Array<keyof UsageTokens>) tokens[key] += event.tokens[key];
        if (event.cost !== null) { cost += event.cost; costCalls++; }
      }
      incomplete ||= event.incomplete || event.at === null;
    }
    if (segment) {
      hasObservation = true;
      const ranges = observed.get(item.session.id) ?? []; ranges.push(segment); observed.set(item.session.id, ranges);
      if (segment.column === "running") {
        tasks.add(item.root); running.push(segment);
        const firstDay = dayKey(segment.start, timezone), lastDay = dayKey(segment.end - 1, timezone);
        if (firstDay === lastDay) days.add(firstDay);
        else for (const bucket of bucketBoundaries(segment.start, segment.end, timezone, "day")) days.add(bucket.key);
      }
    }
  }
  incomplete ||= used.some(event => event.at === null || !(observed.get(event.id) ?? []).some(range => range.start <= event.at! && range.end >= event.at!));
  return { tokens, running_ms: hasObservation ? running.reduce((sum, s) => sum + s.end - s.start, 0) : null,
    active_ms: hasObservation ? unionDuration(running) : null, tasks: tasks.size, calls, turns, active_days: days.size,
    cost: costCalls ? cost : null, cost_calls: costCalls, incomplete };
}
function groups(items: Contribution[], dimension: "source" | "agent" | "model" | "project", timezone: string) {
  const map = new Map<string, Contribution[]>();
  for (const item of items) {
    const key = dimension === "source" ? item.session.source : dimension === "project" ? item.session.directory : item[dimension] ?? UNKNOWN;
    const list = map.get(key) ?? []; list.push(item); map.set(key, list);
  }
  return [...map].map(([key, rows]) => ({ key, label: key === UNKNOWN ? "Unknown" : key, ...summarize(rows, timezone) }))
    .sort((a, b) => b.tokens.total - a.tokens.total || (b.running_ms ?? 0) - (a.running_ms ?? 0));
}
function sessionRows(data: UsageDataset, items: Contribution[], timezone: string, individual = false): StatsSessionRow[] {
  const byId = new Map(data.sessions.map(s => [s.id, s])), grouped = new Map<string, Contribution[]>();
  for (const item of items) { const key = individual ? item.session.id : item.root; const list = grouped.get(key) ?? []; list.push(item); grouped.set(key, list); }
  return [...grouped].map(([id, list]) => {
    const session = byId.get(id)!;
    const metrics = summarize(list, timezone);
    return { ...metrics, id, source: session.source, title: session.title, directory: session.directory,
      agents: [...new Set(list.map(x => x.agent ?? UNKNOWN))], models: [...new Set(list.map(x => x.model ?? UNKNOWN))],
      subagents: new Set(list.filter(x => x.session.id !== id).map(x => x.session.id)).size,
      last_at: list.reduce((last, x) => Math.max(last, x.event?.at ?? x.segment?.end ?? 0), 0) };
  }).filter(row => row.tasks > 0);
}
export function rankSessions(data: UsageDataset, filters: StatsFilters, sort: string, page: number, limit: number): StatsSessionsPayload {
  const rows = sessionRows(data, contributions(data, filters), filters.timezone);
  rows.sort((a, b) => (sort === "tokens" ? b.tokens.total - a.tokens.total : sort === "turns" ? b.turns - a.turns : (b.running_ms ?? -1) - (a.running_ms ?? -1)) || b.tokens.total - a.tokens.total || a.id.localeCompare(b.id));
  return { rows: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit };
}
export function buildDashboard(data: UsageDataset, filters: StatsFilters, now = Date.now()): StatsDashboardPayload {
  const items = contributions(data, filters);
  const previous = contributions(data, { ...filters, ...previousPeriod(filters, now) });
  const earliest = items.reduce((first, x) => Math.min(first, x.event?.at ?? x.segment?.start ?? filters.to), filters.to);
  const extentFrom = filters.from === 0 ? earliest : filters.from;
  const bounds = bucketBoundaries(extentFrom, filters.to, filters.timezone, filters.granularity);
  const bucketItems = bounds.map(() => [] as Contribution[]);
  for (const item of items) {
    if (item.event?.at !== null && item.event?.at !== undefined) {
      // Binary search keeps long histories independent of the number of calendar buckets.
      const at = item.event.at; let lo = 0, hi = bounds.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (bounds[mid].to <= at) lo = mid + 1; else hi = mid; }
      if (bounds[lo] && at >= bounds[lo].from) bucketItems[lo].push(item);
    } else if (item.segment) {
      let lo = 0, hi = bounds.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (bounds[mid].to <= item.segment.start) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < bounds.length && bounds[i].from < item.segment.end; i++) {
        const start = Math.max(item.segment.start, bounds[i].from), end = Math.min(item.segment.end, bounds[i].to);
        if (end > start) bucketItems[i].push({ ...item, segment: { ...item.segment, start, end } });
      }
    }
  }
  const heat = Array.from({ length: 168 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24, running_ms: 0, active_ms: 0, ranges: [] as Array<{ start: number; end: number }> }));
  for (const item of items) {
    const segment = item.segment;
    if (!segment || segment.column !== "running") continue;
    let cursor = segment.start;
    while (cursor < segment.end) {
      const p = localParts(cursor, filters.timezone);
      const end = Math.min(segment.end, cursor + (60 - p.minute) * 60000 - p.second * 1000 - (cursor % 1000));
      const weekday = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
      const cell = heat[weekday * 24 + p.hour]; cell.running_ms += end - cursor; cell.ranges.push({ start: cursor, end }); cursor = end;
    }
  }
  const allItems = contributions(data, { ...filters, from: 0, sources: [], agents: [], models: [], projects: [], role: "all" });
  const unique = (values: string[]) => [...new Set(values)].sort();
  const observationSince = data.intervals.length ? data.intervals.reduce((first, i) => Math.min(first, i.entered_at), Infinity) : null;
  const summary = summarize(items, filters.timezone);
  if (data.sources.some(source => (!filters.sources.length || filters.sources.includes(source.source)) && (source.state !== "ready" || source.skipped > 0 || source.message !== null))) summary.incomplete = true;
  return {
    filters, summary, previous: summarize(previous, filters.timezone),
    series: bounds.map((b, i) => ({ ...b, ...summarize(bucketItems[i], filters.timezone) })),
    breakdowns: { source: groups(items, "source", filters.timezone), agent: groups(items, "agent", filters.timezone), model: groups(items, "model", filters.timezone), project: groups(items, "project", filters.timezone) },
    facets: { sources: unique(data.sessions.map(s => s.source)), agents: unique(allItems.map(i => i.agent ?? UNKNOWN)), models: unique(allItems.map(i => i.model ?? UNKNOWN)), projects: unique(data.sessions.map(s => s.directory)) },
    heatmap: heat.map(({ ranges, ...cell }) => ({ ...cell, active_ms: unionDuration(ranges) })),
    scatter: sessionRows(data, items, filters.timezone).filter(r => r.running_ms !== null).sort((a, b) => b.tokens.total - a.tokens.total).slice(0, 200),
    observation_since: observationSince, undated_calls: items.filter(i => i.event?.kind === "usage" && i.event.at === null).length,
    sources: data.sources, generated_at: now,
  };
}
export function buildSessionDetail(data: UsageDataset, filters: StatsFilters, id: string): StatsSessionPayload {
  const rootIds = roots(data.sessions), root = rootIds.get(id) ?? id;
  const items = contributions(data, filters).filter(i => i.root === root);
  return { session: sessionRows(data, items, filters.timezone)[0] ?? null, participants: sessionRows(data, items, filters.timezone, true),
    models: groups(items, "model", filters.timezone), agents: groups(items, "agent", filters.timezone),
    intervals: items.filter(i => i.segment?.column === "running").map(i => ({ session_id: i.session.id, start: i.segment!.start, end: i.segment!.end, agent: i.agent, model: i.model })) };
}
