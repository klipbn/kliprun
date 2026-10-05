import { describe, expect, test } from "bun:test";
import { StatusHistoryStore } from "../history";

describe("StatusHistoryStore", () => {
  test("opens intervals per column and closes on transition", () => {
    const store = new StatusHistoryStore(":memory:");
    const t0 = 1000;
    store.record(
      [
        { sessionId: "ses_a", directory: "/d", column: "running" },
        { sessionId: "ses_b", directory: "/d", column: "idle" },
      ],
      t0,
    );
    store.record(
      [
        { sessionId: "ses_a", directory: "/d", column: "idle" }, // transition
        { sessionId: "ses_b", directory: "/d", column: "idle" }, // unchanged
      ],
      t0 + 5000,
    );

    const a = store.get("ses_a", t0 + 5000);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ column: "running", duration_ms: 5000, current: false });
    expect(a[1]).toMatchObject({ column: "idle", current: true });
    expect(a[1].duration_ms).toBe(0);

    const b = store.get("ses_b", t0 + 5000);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ column: "idle", current: true });

    store.close();
  });

  test("same-column interval after restart is merged as continuation", () => {
    const store = new StatusHistoryStore(":memory:");
    store.record([{ sessionId: "ses_a", directory: "/d", column: "running" }], 1000);
    // Simulate restart: close open intervals, then re-enter the same column.
    store.closeOpenIntervals(4000);
    store.record([{ sessionId: "ses_a", directory: "/d", column: "running" }], 5000);
    store.closeOpenIntervals(7000);

    const intervals = store.get("ses_a", 7000);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].column).toBe("running");
    expect(intervals[0].duration_ms).toBe(3000 + 2000);
    store.close();
  });

  test("directory change closes the interval; same column merges in get()", () => {
    const store = new StatusHistoryStore(":memory:");
    store.record([{ sessionId: "ses_a", directory: "/a", column: "running" }], 1000);
    store.record([{ sessionId: "ses_a", directory: "/b", column: "running" }], 3000);
    store.closeOpenIntervals(5000);
    // Same-column intervals are presented as one continuation (kliprun semantics).
    const intervals = store.get("ses_a", 5000);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].column).toBe("running");
    expect(intervals[0].duration_ms).toBe(2000 + 2000);
    store.close();
  });
});
