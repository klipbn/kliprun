import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardPayload, CardPayload } from "../../../../shared/types";
import Office from "../Office";
import { OfficeLeaderboard } from "../Leaderboard";
import { updatePlacements } from "../placement";

function card(id: string, overrides: Partial<CardPayload> = {}): CardPayload {
  return {
    source: "opencode", session_id: id, directory: "/work/app", directory_name: "app",
    title: id, prompt_snippet: null, parent_id: null, agent: { name: "build" },
    column: "running", stage: "Thinking", stage_since: 1, running_since: 1,
    last_event_at: 1, reason: null, error: null, last_tool: null, message_count: 1,
    finished_at: null, tokens_total: null, model_ref: null, context: null, branch: null,
    mrs: [], subagent_count: 0, subagent_active: 0, subagent_errors: 0,
    subagent_error_notes: [], children: [], ...overrides,
  };
}

function board(cards: CardPayload[]): BoardPayload {
  return {
    columns: Object.fromEntries(["running", "attention", "idle"].map(key => [key, {
      title: key, count: cards.filter(c => c.column === key).length,
      cards: cards.filter(c => c.column === key),
    }])) as BoardPayload["columns"],
    agents: [], agent_stats: { working: 0, resting: 0 }, project_count: 1, generated_at: 1,
  };
}

test("office shows real sessions and active children with their observed states", () => {
  const html = renderToStaticMarkup(<Office board={board([
    card("coder", { children: [card("helper", { parent_id: "coder" })] }),
    card("question", { column: "attention" }),
    card("rest", { column: "idle" }),
    card("unknown", { source: "codex", column: "idle", stage: "Status unknown" }),
    card("broken", { column: "idle", error: "oops" }),
  ])} onSelect={() => {}} />);
  for (const [id, state] of [["coder", "working"], ["helper", "working"], ["question", "waiting"],
    ["rest", "resting"], ["unknown", "unknown"], ["broken", "error"]]) {
    expect(html).toContain(`data-session-id="${id}" data-office-state="${state}"`);
  }
  expect(html).toContain("Subagent");
  expect(html).toContain("Status unknown");
});

test("office distinguishes loading from an empty live board", () => {
  expect(renderToStaticMarkup(<Office board={null} onSelect={() => {}} />)).toContain("Loading office");
  expect(renderToStaticMarkup(<Office board={board([])} onSelect={() => {}} />)).toContain("The office is quiet");
});

test("the empty waiting area is a persistent meeting room rather than an unoccupied help queue", () => {
  const html = renderToStaticMarkup(<Office board={board([])} onSelect={() => {}} />);
  expect(html).toContain('aria-label="Meeting room"');
  expect(html).toContain('aria-label="Meeting room available"');
  expect(html).not.toContain("Human needed");
  expect(html).not.toContain("No questions for now");
});

test("a coworker with a question sits in the meeting room and requests input immediately", () => {
  const html = renderToStaticMarkup(<Office board={board([card("question", { column: "attention", running_since: null })])} onSelect={() => {}} />);
  const meeting = html.match(/<section[^>]*aria-label="Meeting room"[\s\S]*?<\/section>/)?.[0];
  expect(meeting).toBeDefined();
  expect(meeting).toContain('aria-label="Meeting needs your input"');
  expect(meeting).toContain('data-session-id="question" data-office-state="waiting"');
});

test("a coworker keeps their color when their state and board position change", () => {
  const render = (cards: CardPayload[]) => renderToStaticMarkup(<Office board={board(cards)} onSelect={() => {}} />);
  const before = render([card("same"), card("other")]);
  const after = render([card("other"), card("same", { column: "attention" })]);
  const color = (html: string) => html.match(/data-session-id="same"[^>]*style="([^"]+)"/)?.[1];
  expect(color(before)).toBeDefined();
  expect(color(after)).toBe(color(before));
  expect(after).toContain('data-session-id="same" data-office-state="waiting"');
});

test("only continuous running beyond one hour enters the superwork zone", () => {
  const now = 7_200_000;
  const html = renderToStaticMarkup(<Office now={now} board={board([
    card("fresh", { running_since: now - 10_000 }),
    card("exact-hour", { running_since: now - 3_600_000 }),
    card("overtime", { running_since: now - 3_600_001 }),
    card("no-clock", { running_since: null }),
    card("future-clock", { running_since: now + 1000 }),
    card("waiting", { column: "attention", running_since: now - 7_000_000 }),
    card("idle", { column: "idle", running_since: now - 7_000_000 }),
    card("unknown", { source: "codex", column: "idle", stage: "Status unknown", running_since: null }),
    card("error", { column: "idle", error: "oops", running_since: null }),
  ])} onSelect={() => {}} />);
  for (const [id, zone] of [["fresh", "work"], ["exact-hour", "work"], ["overtime", "superwork"],
    ["no-clock", "work"], ["future-clock", "work"], ["waiting", "work"], ["idle", "lounge"],
    ["unknown", "lounge"], ["error", "lounge"]]) {
    const tag = html.match(new RegExp(`data-session-id="${id}"[^>]*`))?.[0];
    expect(tag).toContain(`data-office-zone="${zone}"`);
  }
});

test("the office keeps all three physical zones visible even without coworkers", () => {
  const html = renderToStaticMarkup(<Office board={board([])} onSelect={() => {}} />);
  for (const zone of ["work", "lounge", "superwork"]) expect(html).toContain(`data-zone="${zone}"`);
});

test("the same running session moves after the hour boundary and leaves when it rests", () => {
  const live = board([card("traveler", { running_since: 1000 })]);
  const render = (data: BoardPayload, now: number) => renderToStaticMarkup(<Office board={data} now={now} onSelect={() => {}} />);
  expect(render(live, 3_601_000)).toContain('data-office-zone="work"');
  expect(render(live, 3_601_001)).toContain('data-office-zone="superwork"');
  const rested = board([card("traveler", { column: "idle", running_since: null })]);
  expect(render(rested, 3_602_000)).toContain('data-office-zone="lounge"');
});

test("coworkers show their model and the time spent in their current state above their heads", () => {
  const html = renderToStaticMarkup(<Office now={120_000} board={board([
    card("worker", { running_since: 60_000, model_ref: "openai/gpt-6.1" }),
    card("idle-timer", { column: "idle", running_since: null, stage_since: 30_000, finished_at: 10_000, model_ref: "anthropic/claude-opus" }),
    card("wait-timer", { column: "attention", running_since: null, stage_since: 110_000 }),
    card("uncertain", { source: "codex", column: "idle", stage: "Status unknown", running_since: null }),
  ])} onSelect={() => {}} />);
  expect(html).toContain('class="office-timer" data-timer-state="working"');
  expect(html).toContain('<span class="office-timer-session">worker</span>');
  expect(html).toContain('<span class="office-timer-session">idle-timer</span>');
  expect(html).toContain("Working · 1m");
  expect(html).toContain("Idle · 1m 30s");
  expect(html).toContain("Waiting · 10s");
  expect(html).toContain("gpt-6.1");
  expect(html).toContain("claude-opus");
  expect(html).toContain("Unknown model");
  expect(html).not.toContain("Idle · 1m 59s");
});

test("leaderboard ranks current coworkers by accumulated usage, not their context size", () => {
  const html = renderToStaticMarkup(<OfficeLeaderboard residents={[
    card("low", { tokens_total: 999999, model_ref: "openai/gpt-6.1" }),
    card("high", { title: "Deep work", tokens_total: 1, model_ref: "anthropic/claude-opus" }),
    card("missing"),
  ]} usage={{ rows: [
    { session_id: "low", tokens: 1500, incomplete: false },
    { session_id: "high", tokens: 9000, incomplete: true },
    { session_id: "foreign", tokens: 999999, incomplete: false },
  ] }} pending={false} error={null} onSelect={() => {}} />);
  expect([...html.matchAll(/data-leaderboard-session="([^"]+)"/g)].map(match => match[1])).toEqual(["high", "low", "missing"]);
  expect(html).toContain('<span class="office-leaderboard-session">Deep work</span>');
  expect(html).toContain("9.0k");
  expect(html).toContain("1.5k");
  expect(html).toContain("No data");
  expect(html).toContain("Partial data");
  expect(html).not.toContain("foreign");
});

test("a brief idle snapshot keeps the coworker at their desk and resuming cancels the move", () => {
  let placement = updatePlacements(new Map(), [card("busy")], 100_000);
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null })], 101_000);
  expect(placement.get("busy")!.zone).toBe("work");
  placement = updatePlacements(placement, [card("busy")], 102_000);
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null })], 105_000);
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null })], 109_999);
  expect(placement.get("busy")!.zone).toBe("work");
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null })], 110_000);
  expect(placement.get("busy")!.zone).toBe("lounge");
});

test("idle placement waits five observed seconds even when server stage timestamps are old or change", () => {
  let placement = updatePlacements(new Map(), [card("busy")], 100_000);
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null, stage_since: 1 })], 101_000);
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null, stage_since: 105_000 })], 105_999);
  expect(placement.get("busy")!.zone).toBe("work");
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null })], 106_000);
  expect(placement.get("busy")!.zone).toBe("lounge");
});

test("superwork keeps its seat during idle grace; questions and errors relocate immediately but unknown does not", () => {
  const initial = updatePlacements(new Map(), [card("busy")], 4_000_000);
  const idle = updatePlacements(initial, [card("busy", { column: "idle", running_since: null })], 4_001_000);
  expect(idle.get("busy")!.zone).toBe("superwork");
  expect(updatePlacements(idle, [card("busy", { column: "attention" })], 4_002_000).get("busy")!.zone).toBe("work");
  expect(updatePlacements(idle, [card("busy", { column: "idle", error: "failure" })], 4_002_000).get("busy")!.zone).toBe("lounge");
  expect(updatePlacements(idle, [card("busy", { source: "codex", column: "idle", stage: "Status unknown" })], 4_002_000).get("busy")!.zone).toBe("superwork");
});

test("initial idle sessions appear in the lounge and removed sessions do not retain placement history", () => {
  let placement = updatePlacements(new Map(), [card("gone")], 100_000);
  placement = updatePlacements(placement, [], 101_000);
  expect(placement.size).toBe(0);
  placement = updatePlacements(placement, [card("gone", { column: "idle", running_since: null })], 102_000);
  expect(placement.get("gone")!.zone).toBe("lounge");
});

test("unknown snapshots keep the last observed area without confirming idle or inventing work", () => {
  const unknown = card("busy", { source: "codex", column: "idle", stage: "Status unknown", running_since: null });
  let placement = updatePlacements(new Map(), [card("busy")], 100_000);
  placement = updatePlacements(placement, [unknown], 101_000);
  placement = updatePlacements(placement, [unknown], 120_000);
  expect(placement.get("busy")!.zone).toBe("work");
  expect(placement.get("busy")!.idleSince).toBeNull();
  placement = updatePlacements(placement, [card("busy", { column: "idle", running_since: null })], 121_000);
  expect(placement.get("busy")!.zone).toBe("work");
  expect(updatePlacements(new Map(), [unknown], 121_000).get("busy")!.zone).toBe("lounge");
});

test("new coworkers cannot displace already seated coworkers even when sorted before them", () => {
  let placement = updatePlacements(new Map(), [card("b"), card("c")], 100_000);
  expect(placement.get("b")!.seat).toBe(0);
  expect(placement.get("c")!.seat).toBe(1);
  placement = updatePlacements(placement, [card("a"), card("b"), card("c")], 101_000);
  expect(placement.get("b")!.seat).toBe(0);
  expect(placement.get("c")!.seat).toBe(1);
  expect(placement.get("a")!.seat).toBe(2);
});

test("moving or removing one coworker leaves holes instead of compacting neighbors", () => {
  let placement = updatePlacements(new Map(), [card("a"), card("b"), card("c")], 100_000);
  placement = updatePlacements(placement, [card("b", { column: "attention" }), card("c")], 101_000);
  expect(placement.get("c")!.seat).toBe(2);
  expect(placement.get("c")!.area).toBe("work");
  expect(placement.get("b")!.area).toBe("waiting");
  placement = updatePlacements(placement, [card("c"), card("d")], 102_000);
  expect(placement.get("c")!.seat).toBe(2);
  expect(placement.get("d")!.seat).toBe(0);
});
