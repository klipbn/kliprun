import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../codex/adapter";

const t = Date.parse("2026-10-11T18:20:00Z");
const id = "01900000-0000-7000-8000-000000000001";
const fixtures: Array<{ home: string; adapter: CodexAdapter }> = [];
afterEach(() => {
  for (const { home, adapter } of fixtures.splice(0)) {
    adapter.close(); rmSync(home, { recursive: true, force: true });
  }
});
const iso = (at: number) => new Date(at).toISOString();
const event = (type: string, payload: object, at = t) => JSON.stringify({ timestamp: iso(at), type, payload }) + "\n";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kliprun-codex-hermes-"));
  const base = join(home, "hermes");
  mkdirSync(join(base, "sessions"), { recursive: true });
  const rollout = join(home, `rollout-${id}.jsonl`);
  writeFileSync(rollout, event("event_msg", { type: "task_started", turn_id: "turn-1" }) +
    event("response_item", { type: "custom_tool_call", name: "exec", call_id: "cmd", input: "opaque wrapper" }, t + 1));
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, source TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)");
  db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run(id, home, "Codex fixture", "cli", rollout, t / 1000, 0);
  db.close();
  const adapter = new CodexAdapter(home, base);
  fixtures.push({ home, adapter });
  adapter.setProcesses([{ pid: "10", cwd: home, rollouts: [rollout] }]);
  const statePath = join(base, "sessions", `${createHash("sha256").update(id).digest("hex")}.json`);
  function heartbeat(at: number) {
    writeFileSync(join(base, "watcher.json"), JSON.stringify({ version: "1.3.1", pid: 123, heartbeatAt: iso(at),
      daemon: { connected: true, checkedAt: iso(at) } }));
  }
  function status(status: string, at: number, overrides: object = {}) {
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, source: "codex", sessionID: id, directory: home,
      status, updatedAt: iso(at), waitingSince: status === "waiting" ? iso(t + 2) : null,
      active: { id: "turn-1", startedAt: iso(t) }, daemon: { observedAt: iso(at) }, ...overrides }));
  }
  return { home, base, adapter, rollout, statePath, heartbeat, status };
}

test("a Hermes approval inside an opaque exec moves the live Codex card to attention", () => {
  const { adapter, heartbeat, status } = fixture();
  expect(adapter.cards(t + 1)[0].column).toBe("running");
  heartbeat(t + 3); status("waiting", t + 3);
  expect(adapter.cards(t + 3)[0]).toMatchObject({ column: "attention", stage: "Waiting for input",
    stage_since: t + 2, running_since: null, finished_at: null });
});

test("long waits retain their timer and busy resumes without resetting on each heartbeat", () => {
  const { adapter, heartbeat, status, rollout } = fixture();
  heartbeat(t + 3); status("waiting", t + 3);
  expect(adapter.cards(t + 3)[0].column).toBe("attention");
  const later = t + 60 * 60_000;
  heartbeat(later); status("waiting", later);
  expect(adapter.cards(later)[0]).toMatchObject({ column: "attention", stage_since: t + 2 });
  heartbeat(later + 1); status("busy", later + 1);
  expect(adapter.cards(later + 1)[0]).toMatchObject({ column: "running", stage_since: later + 1, finished_at: null });
  heartbeat(later + 2); status("busy", later + 2);
  expect(adapter.cards(later + 2)[0].stage_since).toBe(later + 1);
  appendFileSync(rollout, event("event_msg", { type: "task_complete", turn_id: "turn-1" }, later + 3));
  heartbeat(later + 4); status("waiting", later + 4);
  expect(adapter.cards(later + 4)[0]).toMatchObject({ column: "idle", stage: "Finished", finished_at: later + 3 });
});

test("busy clears a recorded question while a newer journal event overrides an older Hermes snapshot", () => {
  const { adapter, heartbeat, status, rollout } = fixture();
  appendFileSync(rollout, event("response_item", { type: "function_call", name: "request_user_input", call_id: "q" }, t + 2));
  expect(adapter.cards(t + 2)[0].column).toBe("attention");
  heartbeat(t + 3); status("busy", t + 3);
  expect(adapter.cards(t + 3)[0].column).toBe("running");
  appendFileSync(rollout, event("response_item", { type: "function_call", name: "request_user_input", call_id: "q2" }, t + 4));
  expect(adapter.cards(t + 4)[0].column).toBe("attention");
});

test("hook waits survive long silence only for the same active journal turn", () => {
  const { adapter, heartbeat, status, rollout } = fixture();
  status("waiting", t + 3, { daemon: undefined });
  const later = t + 60 * 60_000;
  heartbeat(later);
  expect(adapter.cards(later)[0]).toMatchObject({ column: "attention", stage_since: t + 2 });
  appendFileSync(rollout, event("response_item", { type: "function_call_output", call_id: "cmd" }, later + 1));
  expect(adapter.cards(later + 1)[0].column).toBe("running");
  status("waiting", later + 2, { daemon: undefined, active: { id: "old-turn" } });
  expect(adapter.cards(later + 2)[0].column).toBe("running");
});

test("stale hook busy does not turn silence into confirmed work", () => {
  const { adapter, heartbeat, status } = fixture();
  status("busy", t + 3, { daemon: undefined });
  const later = t + 16 * 60_000;
  heartbeat(later);
  expect(adapter.cards(later)[0]).toMatchObject({ column: "idle", stage: "Status unknown" });
});

test.each([
  ["another session", { sessionID: "another" }],
  ["another directory", { directory: "/another-project" }],
  ["another source", { source: "opencode" }],
  ["another schema", { schemaVersion: 2 }],
  ["unknown status", { status: "unknown" }],
  ["another turn", { active: { id: "old-turn" } }],
  ["future update", { updatedAt: iso(t + 10) }],
  ["invalid waiting time", { waitingSince: "invalid" }],
  ["future waiting time", { waitingSince: iso(t + 10) }],
  ["stale daemon observation", { daemon: { observedAt: iso(t - 31_000) } }],
  ["future daemon observation", { daemon: { observedAt: iso(t + 10) } }],
  ["hook without a turn", { daemon: undefined, active: null }],
] as Array<[string, object]>)("ignores Hermes metadata for %s", (_name, overrides) => {
  const { adapter, heartbeat, status } = fixture();
  heartbeat(t + 3); status("waiting", t + 3, overrides);
  expect(adapter.cards(t + 3)[0].column).toBe("running");
});

test.each([
  ["stale heartbeat", { heartbeatAt: iso(t - 31_000) }],
  ["future heartbeat", { heartbeatAt: iso(t + 10) }],
  ["disconnected daemon", { daemon: { connected: false, checkedAt: iso(t + 3) } }],
  ["stale daemon check", { daemon: { connected: true, checkedAt: iso(t - 31_000) } }],
] as Array<[string, object]>)("falls back to the journal with %s", (_name, overrides) => {
  const { adapter, base, heartbeat, status } = fixture();
  heartbeat(t + 3); status("waiting", t + 3);
  const path = join(base, "watcher.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...overrides }));
  expect(adapter.cards(t + 3)[0].column).toBe("running");
});

test("missing, corrupt and oversized Hermes files cannot retain a previous waiting status", () => {
  const { adapter, base, heartbeat, status, statePath } = fixture();
  heartbeat(t + 3); status("waiting", t + 3);
  const before = readFileSync(statePath);
  expect(adapter.cards(t + 3)[0].column).toBe("attention");
  expect(readFileSync(statePath)).toEqual(before);
  writeFileSync(statePath, "{broken");
  expect(adapter.cards(t + 4)[0].column).toBe("running");
  status("waiting", t + 3, { lastSummary: "x".repeat(2 * 1024 * 1024) });
  expect(adapter.cards(t + 4)[0].column).toBe("running");
  status("waiting", t + 3);
  rmSync(join(base, "watcher.json"));
  expect(adapter.cards(t + 4)[0].column).toBe("running");
  heartbeat(t + 4); rmSync(statePath);
  expect(adapter.cards(t + 4)[0].column).toBe("running");
});

test("Hermes cannot create cards and statuses remain independent for two CLI windows", () => {
  const { adapter, home, heartbeat, status, rollout } = fixture();
  const second = "01900000-0000-7000-8000-000000000002";
  const secondRollout = join(home, `rollout-${second}.jsonl`);
  writeFileSync(secondRollout, event("event_msg", { type: "task_started", turn_id: "turn-2" }));
  const db = new Database(join(home, "state_5.sqlite"));
  db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run(second, home, "Second window", "cli", secondRollout, t / 1000, 0);
  db.close();
  adapter.setProcesses([{ pid: "10", cwd: home, rollouts: [rollout] }, { pid: "11", cwd: home, rollouts: [secondRollout] }]);
  heartbeat(t + 3); status("waiting", t + 3);
  expect(adapter.cards(t + 3).map(card => [card.session_id, card.column])).toEqual([
    [`codex:${id}`, "attention"], [`codex:${second}`, "running"],
  ]);
  adapter.setProcesses([]);
  expect(adapter.cards(t + 4)).toEqual([]);
});

test("a completed turn in a bounded journal tail cannot be revived by Hermes", () => {
  const { adapter, heartbeat, status, rollout } = fixture();
  writeFileSync(rollout, event("event_msg", { type: "task_complete", turn_id: "turn-1" }, t + 2));
  heartbeat(t + 3); status("waiting", t + 3);
  expect(adapter.cards(t + 3)[0]).toMatchObject({ column: "idle", stage: "Finished", finished_at: t + 2 });
});
