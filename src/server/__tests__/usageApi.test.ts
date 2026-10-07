import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsService, registerStatsRoutes } from "../usage/service";
import type { StatsDashboardPayload, StatsSessionsPayload, StatsSessionPayload } from "@shared/usage";

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
  await service.close();
});
