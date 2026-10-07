import { describe, expect, test } from "bun:test";
import { buildDashboard, buildSessionDetail, rankSessions } from "../usage/aggregate";
import { bucketBoundaries, parseStatsFilters, previousPeriod } from "../usage/time";
import type { StatsFilters, UsageEvent, UsageInterval, UsageSession, UsageTokens } from "@shared/usage";

const tokens = (total: number): UsageTokens => ({ total, input: total, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: 0 });
const filters: StatsFilters = { from: 0, to: 200, timezone: "UTC", sources: [], agents: [], models: [], projects: [], role: "all", granularity: "day" };
const sessions: UsageSession[] = [
  { id: "ses_root", source: "opencode", parent_id: null, title: "Root", directory: "/p", created_at: 0, updated_at: 200 },
  { id: "ses_child", source: "opencode", parent_id: "ses_root", title: "Child", directory: "/p", created_at: 0, updated_at: 200 },
];
const events: UsageEvent[] = [
  { id: "r", session_id: "ses_root", kind: "usage", at: 75, agent: "build", model: "openai/a", tokens: tokens(100), cost: 0.5, incomplete: false },
  { id: "c", session_id: "ses_child", kind: "usage", at: 125, agent: "explore", model: "openai/b", tokens: tokens(50), cost: null, incomplete: false },
  { id: "t", session_id: "ses_root", kind: "turn", at: 1, agent: "build", model: "openai/a", tokens: null, cost: null, incomplete: false },
];
const intervals: UsageInterval[] = [
  { id: 1, session_id: "ses_root", directory: "/p", column_name: "running", entered_at: 0, exited_at: 100, duration_ms: 100 },
  { id: 2, session_id: "ses_child", directory: "/p", column_name: "running", entered_at: 50, exited_at: 150, duration_ms: 100 },
  { id: 3, session_id: "ses_root", directory: "/p", column_name: "attention", entered_at: 100, exited_at: 200, duration_ms: 100 },
];
const data = { sessions, events, intervals, attributions: [
  { interval_id: 1, start: 0, end: 100, agent: "build", model: "openai/a" },
  { interval_id: 2, start: 50, end: 150, agent: "explore", model: "openai/b" },
], observed_at: 200, sources: [] };

describe("usage aggregation", () => {
  test("sums task-tree spend once and distinguishes parallel agent time from active time", () => {
    const result = buildDashboard(data, filters, 200);
    expect(result.summary.tokens.total).toBe(150);
    expect(result.summary.running_ms).toBe(200);
    expect(result.summary.active_ms).toBe(150);
    expect(result.summary.tasks).toBe(1);
    expect(result.summary.calls).toBe(2);
    expect(result.summary.cost).toBe(0.5);
    expect(result.summary.cost_calls).toBe(1);
    const top = rankSessions(data, filters, "running", 1, 50);
    expect(top.total).toBe(1);
    expect(top.rows[0]).toMatchObject({ id: "ses_root", subagents: 1, running_ms: 200, active_ms: 150 });
    expect(buildSessionDetail(data, filters, "ses_root").participants).toHaveLength(2);
  });
  test("filters contributions inside a task rather than charging the entire task to a model", () => {
    const f = { ...filters, models: ["openai/b"] };
    const result = buildDashboard(data, f, 200);
    expect(result.summary.tokens.total).toBe(50);
    expect(result.summary.running_ms).toBe(100);
    expect(rankSessions(data, f, "tokens", 1, 50).rows[0].id).toBe("ses_root");
  });
  test("clamps durations to range, counts no Attention, and preserves unobserved gaps", () => {
    const result = buildDashboard({ ...data, intervals: [intervals[0], { ...intervals[0], id: 4, entered_at: 150, exited_at: 190, duration_ms: 40 }], attributions: [] }, { ...filters, from: 90, to: 180 }, 200);
    expect(result.summary.running_ms).toBe(40);
    expect(result.summary.active_ms).toBe(40);
  });
  test("missing observations are null, and legacy Running is not attributed to a current model", () => {
    expect(buildDashboard({ ...data, intervals: [], attributions: [] }, filters, 200).summary.running_ms).toBeNull();
    expect(buildDashboard({ ...data, attributions: [] }, { ...filters, models: ["openai/a"] }, 200).summary.running_ms).toBeNull();
    expect(buildDashboard({ ...data, attributions: [] }, filters, 200).breakdowns.model.find(r => r.key === "__unknown__")).toMatchObject({ running_ms: 200, label: "Unknown" });
  });
  test("a later IDLE sample cannot make earlier unobserved work appear fully covered", () => {
    const result = buildDashboard({ ...data, events: [{ ...events[0], at: 50 }], intervals: [{ ...intervals[0], column_name: "idle", entered_at: 150, exited_at: 200 }], attributions: [] }, filters, 200);
    expect(result.summary.incomplete).toBe(true);
  });
  test("unavailable or skipped source records keep overall totals explicitly partial", () => {
    const source = { source: "opencode" as const, state: "ready" as const, indexed: 2, total: 2, updated_at: 200, skipped: 1, message: null };
    expect(buildDashboard({ ...data, sources: [source] }, filters, 200).summary.incomplete).toBe(true);
  });
  test("caps open intervals at last observation instead of charging monitor downtime", () => {
    const result = buildDashboard({ ...data, intervals: [{ ...intervals[0], exited_at: null, duration_ms: null }], observed_at: 100, attributions: [] }, filters, 9999);
    expect(result.summary.running_ms).toBe(100);
  });
  test("child-only filtering still ranks the containing task, and orphan sessions survive", () => {
    expect(rankSessions(data, { ...filters, role: "children" }, "tokens", 1, 50).rows[0].tokens.total).toBe(50);
    const orphan = { ...data, sessions: [{ ...sessions[1], parent_id: "missing" }] };
    expect(rankSessions(orphan, filters, "tokens", 1, 50).rows[0].id).toBe("ses_child");
  });
  test("unknown dates are included only for all-history totals, not assigned a fake day", () => {
    const d = { ...data, events: [{ ...events[0], at: null }], intervals: [], attributions: [] };
    const all = buildDashboard(d, filters, 200);
    expect(all.summary.tokens.total).toBe(100);
    expect(all.undated_calls).toBe(1);
    expect(all.series.reduce((sum, b) => sum + b.tokens.total, 0)).toBe(0);
    expect(buildDashboard(d, { ...filters, from: 1 }, 200).summary.tokens.total).toBe(0);
  });
});

describe("statistics dates and validation", () => {
  test("local daily buckets respect a 23-hour DST day and exact range edges", () => {
    const from = Date.parse("2026-03-08T05:00:00Z");
    const to = Date.parse("2026-03-09T04:00:00Z");
    expect(bucketBoundaries(from, to, "America/New_York", "day")).toMatchObject([{ from, to, key: "2026-03-08" }]);
  });
  test("a skipped midnight begins at the first actual instant of that local day", () => {
    const result = bucketBoundaries(Date.parse("2018-11-03T03:00:00Z"), Date.parse("2018-11-05T02:00:00Z"), "America/Sao_Paulo", "day");
    expect(result).toMatchObject([
      { key: "2018-11-03", from: Date.parse("2018-11-03T03:00:00Z"), to: Date.parse("2018-11-04T03:00:00Z") },
      { key: "2018-11-04", from: Date.parse("2018-11-04T03:00:00Z"), to: Date.parse("2018-11-05T02:00:00Z") },
    ]);
  });
  test("today compares against yesterday through the same local clock time", () => {
    const range = previousPeriod({ ...filters, from: Date.parse("2026-10-07T00:00:00Z"), to: Date.parse("2026-10-08T00:00:00Z") }, Date.parse("2026-10-07T10:00:00Z"));
    expect(range).toEqual({ from: Date.parse("2026-10-06T00:00:00Z"), to: Date.parse("2026-10-06T10:00:00Z") });
  });
  test("calendar weeks and months compare equivalent calendar boundaries", () => {
    expect(previousPeriod({ ...filters, from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-10-08T00:00:00Z") }, Date.parse("2026-10-07T10:00:00Z"))).toEqual({ from: Date.parse("2026-09-24T00:00:00Z"), to: Date.parse("2026-09-30T10:00:00Z") });
    expect(previousPeriod({ ...filters, from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-11-01T00:00:00Z") }, Date.parse("2026-10-07T10:00:00Z"))).toEqual({ from: Date.parse("2026-09-01T00:00:00Z"), to: Date.parse("2026-09-07T10:00:00Z") });
  });
  test("month-to-date compares with the previous month rather than the preceding seven days", () => {
    const f: StatsFilters = { ...filters, from: Date.parse("2026-10-01T00:00:00Z"), to: Date.parse("2026-10-08T00:00:00Z"), period: "month" };
    expect(previousPeriod(f, Date.parse("2026-10-07T10:00:00Z"))).toEqual({ from: Date.parse("2026-09-01T00:00:00Z"), to: Date.parse("2026-09-07T10:00:00Z") });
  });
  test("comparison across DST preserves the previous day's local clock time", () => {
    expect(previousPeriod({ ...filters, timezone: "America/New_York", from: Date.parse("2026-03-08T05:00:00Z"), to: Date.parse("2026-03-09T04:00:00Z") }, Date.parse("2026-03-08T14:00:00Z"))).toEqual({ from: Date.parse("2026-03-07T05:00:00Z"), to: Date.parse("2026-03-07T15:00:00Z") });
  });
  test("rejects invalid ranges, unknown role, and invalid timezones", () => {
    expect(() => parseStatsFilters(new URL("http://local/?from=20&to=10"), 200)).toThrow();
    expect(() => parseStatsFilters(new URL("http://local/?timezone=Nope"), 200)).toThrow();
    expect(() => parseStatsFilters(new URL("http://local/?role=bad"), 200)).toThrow();
  });
});
