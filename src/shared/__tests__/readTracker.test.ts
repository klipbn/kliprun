import { describe, expect, test } from "bun:test";
import {
  boardActivityCounts,
  createReadTracker,
  sessionCards,
  type KVStorage,
  type TrackedCard,
} from "../readTracker";

function memoryStorage(): KVStorage & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    dump: () => map,
  };
}

function card(sessionId: string, column: string, overrides: Partial<TrackedCard> = {}): TrackedCard {
  return { session_id: sessionId, column, stage_since: 100, finished_at: null, ...overrides };
}

describe("createReadTracker", () => {
  test("idle cards start unread and become read after markRead", () => {
    const tracker = createReadTracker(memoryStorage());
    const idle = card("ses_a", "idle", { finished_at: 500 });
    expect(tracker.isRead(idle)).toBe(false);
    tracker.markRead(idle);
    expect(tracker.isRead(idle)).toBe(true);
  });

  test("markRead ignores non-idle cards", () => {
    const tracker = createReadTracker(memoryStorage());
    tracker.markRead(card("ses_a", "running"));
    expect(tracker.isRead(card("ses_a", "running"))).toBe(false);
  });

  test("a new idle revision (finished again) is unread again", () => {
    const tracker = createReadTracker(memoryStorage());
    tracker.markRead(card("ses_a", "idle", { stage_since: 100, finished_at: 500 }));
    const reRun = card("ses_a", "idle", { stage_since: 900, finished_at: 1000 });
    expect(tracker.isRead(reRun)).toBe(false);
  });

  test("observe drops state when a card leaves idle", () => {
    const tracker = createReadTracker(memoryStorage());
    tracker.markRead(card("ses_a", "idle", { finished_at: 500 }));
    tracker.observe([card("ses_a", "running")]);
    expect(tracker.isRead(card("ses_a", "idle", { finished_at: 500 }))).toBe(false);
  });

  test("state persists across trackers sharing storage", () => {
    const storage = memoryStorage();
    const first = createReadTracker(storage);
    first.markRead(card("ses_a", "idle", { finished_at: 500 }));
    const second = createReadTracker(storage);
    expect(second.isRead(card("ses_a", "idle", { finished_at: 500 }))).toBe(true);
  });

  test("null storage keeps in-memory state", () => {
    const tracker = createReadTracker(null);
    tracker.markRead(card("ses_a", "idle"));
    expect(tracker.isRead(card("ses_a", "idle"))).toBe(true);
  });
});

describe("sessionCards", () => {
  test("flattens nested children", () => {
    const tree: TrackedCard[] = [
      {
        session_id: "ses_root",
        column: "running",
        children: [
          { session_id: "ses_child", column: "running", children: [{ session_id: "ses_grand", column: "idle" }] },
        ],
      },
      { session_id: "ses_top", column: "idle" },
    ];
    expect(sessionCards(tree).map((c) => c.session_id)).toEqual([
      "ses_root",
      "ses_child",
      "ses_grand",
      "ses_top",
    ]);
  });
});

describe("boardActivityCounts", () => {
  test("counts running and unread idle", () => {
    const tracker = createReadTracker(memoryStorage());
    const readIdle = card("ses_read", "idle", { finished_at: 10 });
    tracker.markRead(readIdle);
    const counts = boardActivityCounts(
      [
        card("ses_r1", "running"),
        card("ses_r2", "running"),
        readIdle,
        card("ses_unread", "idle", { finished_at: 20 }),
        card("ses_att", "attention"),
      ],
      tracker,
    );
    expect(counts).toEqual({ running: 2, unread: 1 });
  });
});
