import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardService } from "../boardService";
import { CodexAdapter } from "../codex/adapter";
import { StatusHistoryStore } from "../history";
import { registerBoardRoute, registerSessionRoute } from "../routes/api";
import type { UsageObservation } from "@shared/usage";
import type { BoardPayload, CardPayload } from "@shared/types";

const dirs: string[] = [];
const services: BoardService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "kliprun-board-")); dirs.push(home);
  const id = "01900000-0000-7000-8000-000000000001";
  const rollout = join(home, `rollout-${id}.jsonl`);
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, source TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER)");
  db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run(id, home, "Codex fixture", "cli", rollout, Date.now() / 1000, 0);
  db.close();
  const event = (type: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type } }) + "\n";
  writeFileSync(rollout, event("task_started"));
  const codex = new CodexAdapter(home);
  codex.setProcesses([{ pid: "10", cwd: home, rollouts: [rollout] }]);
  const opencode: CardPayload = { ...codex.cards(Date.now())[0], source: "opencode", session_id: "ses_test", title: "OpenCode fixture", agent: { name: "build" } };
  const board: BoardPayload = { columns: { attention: { title: "Needs attention", count: 0, cards: [] },
    running: { title: "Running", count: 1, cards: [opencode] }, idle: { title: "IDLE", count: 0, cards: [] } },
    agents: [{ name: "build", working: true, on_board: true }], agent_stats: { working: 1, resting: 0 }, project_count: 1, generated_at: 0 };
  const engine = { rebuild: (_now: number) => {}, board: (_now: number) => board,
    historyCards: () => [{ sessionId: "ses_test", directory: home, column: "running" }],
    setTuiLiveness: () => false, sessionDirectory: () => home, detail: () => ({ messages: [], models: [] }) };
  const service = new BoardService({ codex, history: new StatusHistoryStore(":memory:"), engine }); services.push(service);
  const app = new Hono(); registerBoardRoute(app, service); registerSessionRoute(app, service);
  return { app, service, codex, home, rollout, event, engine, id: `codex:${id}` };
}

test("combined API counts both sources, serves namespaced details, updates ETag and history", async () => {
  const { app, service, rollout, event, id } = fixture();
  const response = await app.request("/api/board");
  expect(response.status).toBe(200);
  const board = await response.json() as BoardPayload;
  expect(board.columns.running.count).toBe(2);
  expect(board.project_count).toBe(1);
  expect(board.agent_stats.working).toBe(2);
  const tag = response.headers.get("etag")!;
  expect((await app.request("/api/board", { headers: { "If-None-Match": tag } })).status).toBe(304);
  service.invalidate();
  expect((await app.request("/api/board", { headers: { "If-None-Match": tag } })).status).toBe(304);
  appendFileSync(rollout, event("task_complete")); service.invalidate();
  const changed = await app.request("/api/board", { headers: { "If-None-Match": tag } });
  expect(changed.status).toBe(200);
  expect((await changed.json() as BoardPayload).columns.idle.cards[0].session_id).toBe(id);
  const detail = await app.request(`/api/session/${encodeURIComponent(id)}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ source: "codex", exists: true,
    kanban_history: [{ column: "running", current: false }, { column: "idle", current: true }] });
  expect((await app.request(`/api/session/${encodeURIComponent("codex:../invalid")}`)).status).toBe(400);
});

test("Codex disappearance closes its observed interval without removing OpenCode", async () => {
  const { service, codex, id } = fixture();
  service.getBoard(); codex.setProcesses([]); service.invalidate();
  expect(service.getBoard().data.columns.running.count).toBe(1);
  expect(service.history.get(id, Date.now())[0].current).toBe(false);
});

test("unavailable Codex storage leaves OpenCode usable", () => {
  const { service, home } = fixture();
  rmSync(join(home, "state_5.sqlite"));
  expect(service.getBoard().data.columns.running.cards.map(c => c.source)).toEqual(["opencode"]);
  expect(service.codex.diagnostics.length).toBeGreaterThan(0);
});

test("failing OpenCode rebuild leaves Codex usable", () => {
  const { service, engine } = fixture();
  engine.rebuild = () => { throw new Error("fixture failure"); };
  service.invalidate();
  expect(service.getBoard().data.columns.running.cards.map(c => c.source)).toContain("codex");
});

test("liveness sampling records Running without browser requests and publishes raw observations", async () => {
  const { engine, home, codex } = fixture();
  const observed: UsageObservation[] = [];
  const history = new StatusHistoryStore(":memory:");
  const service = new BoardService({ engine, codex, history, observe: value => observed.push(value),
    scanLiveness: async () => ({ directories: new Set([home]), sessionIds: new Set(["ses_test"]), waitingIds: new Set(), fallbackDirectories: new Set(), sessionDirectories: new Map() }),
    scanCodex: async () => [],
  });
  services.push(service);
  await service.refreshLivenessNow();
  expect(history.get("ses_test", Date.now())[0].column).toBe("running");
  expect(observed[0].intervals[0]).toMatchObject({ session_id: "ses_test", column_name: "running" });
});
