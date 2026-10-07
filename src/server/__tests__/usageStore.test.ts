import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../usage/store";
import type { UsageEvent, UsageObservation } from "@shared/usage";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const event: UsageEvent = { id: "msg1", session_id: "ses_a", kind: "usage", at: 100, agent: "build", model: "p/a", cost: null, incomplete: false,
  tokens: { total: 10, input: 10, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: 0 } };
const observation = (at: number, model: string): UsageObservation => ({ at, intervals: [
  { id: 1, session_id: "ses_a", directory: "/p", column_name: "running", entered_at: 100, exited_at: null, duration_ms: null },
], cards: [{ session_id: "ses_a", source: "opencode", parent_id: null, title: "Task", directory: "/p", agent: "build", model }] });

test("durable event upserts replace revised usage rather than double-counting, and checkpoints resume", () => {
  const home = mkdtempSync(join(tmpdir(), "kliprun-usage-store-")); dirs.push(home);
  const path = join(home, "usage.sqlite3");
  let store = new UsageStore(path);
  store.upsertSession({ id: "ses_a", source: "opencode", parent_id: null, title: "Task", directory: "/p", created_at: 1, updated_at: 100 });
  store.upsertEvents("ses_a", [event]); store.upsertEvents("ses_a", [{ ...event, tokens: { ...event.tokens!, total: 20, input: 20 } }]);
  store.setCheckpoint("import", { offset: 123 }); store.close();
  store = new UsageStore(path);
  expect(store.getCheckpoint("import")).toEqual({ offset: 123 });
  expect(store.dataset().events).toHaveLength(1);
  expect(store.dataset().events[0].tokens!.total).toBe(20);
  store.replaceEvents("ses_a", []);
  expect(store.dataset().events).toHaveLength(0);
  store.close();
});
test("observed model changes split attribution without assigning older history to the latest model", () => {
  const store = new UsageStore(":memory:");
  store.observe(observation(150, "p/a"));
  store.observe(observation(200, "p/b"));
  store.observe(observation(250, "p/b"));
  const data = store.dataset();
  expect(data.observed_at).toBe(250);
  expect(data.attributions).toMatchObject([
    { interval_id: 1, start: 150, end: 200, model: "p/a" },
    { interval_id: 1, start: 200, end: 250, model: "p/b" },
  ]);
  // History before the first observation is left without a fabricated model.
  expect(data.intervals[0].entered_at).toBe(100);
  store.close();
});
test("terminal disappearance closes attribution at its actual observed end", () => {
  const store = new UsageStore(":memory:");
  store.observe(observation(100, "p/a"));
  store.observe({ at: 180, cards: [], intervals: [{ ...observation(100, "p/a").intervals[0], exited_at: 180, duration_ms: 80 }] });
  expect(store.dataset().attributions[0]).toMatchObject({ start: 100, end: 180 });
  store.close();
});
