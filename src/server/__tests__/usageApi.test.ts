import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsService, registerStatsRoutes } from "../usage/service";
import type { OfficeUsagePayload, StatsDashboardPayload, StatsSessionsPayload, StatsSessionPayload } from "@shared/usage";
import { UsageStore } from "../usage/store";

const resources: Array<{ service: StatsService; home: string }> = [];
afterEach(async () => { for (const { service, home } of resources.splice(0)) { await service.close(); rmSync(home, { recursive: true, force: true }); } });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kliprun-usage-api-"));
  const service = new StatsService({ path: join(home, "usage.sqlite3"), historyPath: join(home, "missing-history"), opencodePath: join(home, "missing-opencode"), codexHome: home });
  resources.push({ service, home });
  const app = new Hono(); registerStatsRoutes(app, service);
  return { service, app };
}
test("worker-backed statistics serve independent observations while unavailable sources remain isolated", async () => {
  const { service, app } = fixture();
  const cards = [{ session_id: "ses_a", source: "opencode" as const, title: "Task", directory: "/p", parent_id: null, agent: "build", model: "p/a" }];
  const interval = { id: 1, session_id: "ses_a", directory: "/p", column_name: "running" as const, entered_at: 100, exited_at: null, duration_ms: null };
  service.observe({ at: 100, cards, intervals: [interval] });
  service.observe({ at: 200, cards, intervals: [interval] });
  const response = await app.request("/api/stats?from=0&to=300&timezone=UTC");
  expect(response.status).toBe(200);
  const result = await response.json() as StatsDashboardPayload;
  expect(result.summary.running_ms).toBe(100);
  expect(result.sources.some(s => s.state === "unavailable")).toBe(true);
  const list = await (await app.request("/api/stats/sessions?from=0&to=300&timezone=UTC")).json() as StatsSessionsPayload;
  expect(list.rows[0].id).toBe("ses_a");
  const detail = await (await app.request("/api/stats/session/ses_a?from=0&to=300&timezone=UTC")).json() as StatsSessionPayload;
  expect(detail.session!.running_ms).toBe(100);
});
test("statistics API rejects invalid dates, filters, session ids and unbounded pagination", async () => {
  const { app } = fixture();
  for (const url of ["/api/stats?from=2&to=1", "/api/stats?timezone=Nope", "/api/stats?source=bad", "/api/stats/sessions?page=-1", "/api/stats/sessions?limit=9999", "/api/stats/sessions?sort=bad", "/api/stats/session/bad"]) {
    expect((await app.request(url)).status).toBe(400);
  }
});
test("a terminated worker immediately fails later requests without hanging shutdown", async () => {
  const { service, app } = fixture();
  await app.request("/api/stats?from=0&to=300");
  // Fault injection uses the actual worker, not a fake RPC response.
  const worker = (service as unknown as { worker: Worker }).worker;
  const ended = new Promise<void>(resolve => worker.addEventListener("close", () => resolve(), { once: true }));
  worker.terminate(); await ended;
  const response = await Promise.race([
    app.request("/api/stats?from=0&to=300"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("worker failure hung a new request")), 1000)),
  ]);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Statistics temporarily unavailable" });
  await service.close();
});

test("office usage returns each requested session's own accumulated tokens exactly once", async () => {
  const { app } = fixture();
  const store = new UsageStore(join(resources[resources.length - 1].home, "usage.sqlite3"));
  try {
    for (const [id, parent, amount] of [["ses_parent", null, 120], ["ses_child", "ses_parent", 900], ["ses_foreign", null, 9999]] as const) {
      store.upsertSession({ id, parent_id: parent, source: "opencode", title: id, directory: "/p", created_at: 1, updated_at: 1 });
      store.upsertEvents(id, [{ id: "usage", session_id: id, at: null, kind: "usage", agent: "build", model: "p/m",
        tokens: { total: amount, input: amount, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: 0 }, cost: null, incomplete: false }]);
    }
    store.upsertEvents("ses_parent", [{ id: "second-call", session_id: "ses_parent", at: 2, kind: "usage", agent: "build", model: "p/m",
      tokens: { total: 80, input: 80, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: 0 }, cost: null, incomplete: false }]);
    const response = await app.request("/api/stats/office-usage?session=ses_parent&session=ses_child&session=ses_parent&session=ses_missing");
    expect(response.status).toBe(200);
    const payload = await response.json() as OfficeUsagePayload;
    expect(payload.rows.map(row => [row.session_id, row.tokens])).toEqual([
      ["ses_parent", 200], ["ses_child", 900], ["ses_missing", null],
    ]);
    expect(payload.rows.find(row => row.session_id === "ses_missing")!.incomplete).toBe(true);
  } finally { store.close(); }
});

test("office usage rejects malformed IDs and unbounded batches", async () => {
  const { app } = fixture();
  for (const query of ["", "session=bad", Array.from({ length: 51 }, (_, i) => `session=ses_${i}`).join("&")]) {
    expect((await app.request(`/api/stats/office-usage?${query}`)).status).toBe(400);
  }
});
