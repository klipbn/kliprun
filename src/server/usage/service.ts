import type { Hono } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StatsFilters, UsageObservation } from "@shared/usage";
import { getDbPath } from "../storage/db";
import { codexHome } from "../codex/storage";
import { defaultHistoryPath } from "../history";
import { parseStatsFilters } from "./time";

export interface StatsOptions { path: string; historyPath: string; opencodePath: string; codexHome: string }
/** All history parsing and aggregation stays off the board's server thread. */
export class StatsService {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: Timer }>();
  private ready: Promise<unknown>;
  private closed = false;
  private failure: Error | null = null;
  constructor(options: Partial<StatsOptions> = {}) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url).href);
    this.worker.onmessage = event => {
      const { id, result, error } = event.data as { id: number; result?: unknown; error?: string };
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id); clearTimeout(pending.timer);
      if (error) pending.reject(new Error(error)); else pending.resolve(result);
    };
    const failed = () => {
      this.failure = new Error("Statistics worker unavailable");
      this.failPending(this.failure);
    };
    this.worker.onerror = failed;
    this.worker.addEventListener("close", failed);
    this.ready = this.send("init", { path: join(process.env.KLIPRUN_BUN_HOME ?? join(homedir(), ".kliprun_bun"), "usage.sqlite3"), historyPath: defaultHistoryPath(), opencodePath: getDbPath(), codexHome: codexHome(), ...options });
    // A worker startup failure must not crash the read-only board.
    void this.ready.catch(() => {});
  }
  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private send(op: string, data: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Statistics request timed out")); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, op, data });
    });
  }
  observe(observation: UsageObservation): void {
    if (this.closed || this.failure) return;
    void this.ready.then(() => { if (!this.closed && !this.failure) this.worker.postMessage({ op: "observe", data: observation }); }).catch(() => {});
  }
  async query(op: "dashboard" | "sessions" | "detail", filters: StatsFilters, extra: Record<string, unknown> = {}): Promise<unknown> {
    await this.ready;
    if (this.closed) throw new Error("Statistics service stopped");
    return this.send(op, { filters, ...extra });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    // Observe messages queued before shutdown must be flushed first.
    await this.ready.catch(() => {});
    this.closed = true;
    try { await this.send("close", {}); } catch { /* worker already unavailable */ }
    this.worker.terminate(); this.failPending(new Error("Statistics service stopped"));
  }
}

export function registerStatsRoutes(app: Hono, service: StatsService): void {
  app.get("/api/stats", async c => {
    let filters: StatsFilters;
    try { filters = parseStatsFilters(new URL(c.req.url)); } catch { return c.json({ error: "invalid statistics filters" }, 400); }
    try { c.header("Cache-Control", "no-store"); return c.json(await service.query("dashboard", filters)); }
    catch { return c.json({ error: "Статистика временно недоступна" }, 503); }
  });
  app.get("/api/stats/sessions", async c => {
    let filters: StatsFilters, page: number, limit: number, sort: string;
    try {
      const url = new URL(c.req.url); filters = parseStatsFilters(url);
      page = Number(url.searchParams.get("page") ?? 1); limit = Number(url.searchParams.get("limit") ?? 50); sort = url.searchParams.get("sort") ?? "running";
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !["running", "tokens", "turns"].includes(sort)) throw new Error("invalid pagination");
    } catch { return c.json({ error: "invalid statistics filters" }, 400); }
    try { c.header("Cache-Control", "no-store"); return c.json(await service.query("sessions", filters, { page, limit, sort })); }
    catch { return c.json({ error: "Статистика временно недоступна" }, 503); }
  });
  app.get("/api/stats/session/:id", async c => {
    const id = c.req.param("id");
    if (!/^ses_[a-zA-Z0-9_-]+$/.test(id) && !/^codex:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return c.json({ error: "invalid session id" }, 400);
    let filters: StatsFilters;
    try { filters = parseStatsFilters(new URL(c.req.url)); } catch { return c.json({ error: "invalid statistics filters" }, 400); }
    try { c.header("Cache-Control", "no-store"); return c.json(await service.query("detail", filters, { sessionId: id })); }
    catch { return c.json({ error: "Статистика временно недоступна" }, 503); }
  });
}
