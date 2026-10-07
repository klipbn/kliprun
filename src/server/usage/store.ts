import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageAttribution, UsageEvent, UsageImportStatus, UsageInterval, UsageObservation, UsageSession } from "@shared/usage";
import type { UsageDataset } from "./aggregate";
import { scrub } from "../security";

/** KlipRun-owned derived metadata only. No prompts, response text or tool output. */
export class UsageStore {
  private db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS usage_sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_events(row_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER, data TEXT NOT NULL, UNIQUE(session_id,event_id));
      CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events(at);
      CREATE INDEX IF NOT EXISTS usage_events_session ON usage_events(session_id);
      CREATE TABLE IF NOT EXISTS usage_intervals(id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_attributions(id INTEGER PRIMARY KEY, interval_id INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, agent TEXT, model TEXT);
      CREATE INDEX IF NOT EXISTS usage_attributions_interval ON usage_attributions(interval_id,start_at);
      CREATE TABLE IF NOT EXISTS usage_checkpoints(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  upsertSession(session: UsageSession): void {
    const safe = { ...session, title: scrub(session.title), directory: scrub(session.directory) };
    this.db.query("INSERT INTO usage_sessions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(session.id, JSON.stringify(safe));
  }
  upsertEvents(sessionId: string, events: UsageEvent[]): void {
    const insert = this.db.query("INSERT INTO usage_events(session_id,event_id,at,data) VALUES(?,?,?,?) ON CONFLICT(session_id,event_id) DO UPDATE SET at=excluded.at,data=excluded.data");
    this.db.transaction(() => {
      for (const event of events) {
        const safe = { ...event, session_id: sessionId, agent: scrub(event.agent), model: scrub(event.model) };
        insert.run(sessionId, event.id, event.at, JSON.stringify(safe));
      }
    })();
  }
  replaceEvents(sessionId: string, events: UsageEvent[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM usage_events WHERE session_id=?").run(sessionId);
      this.upsertEvents(sessionId, events);
    })();
  }
  getCheckpoint(key: string): unknown {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM usage_checkpoints WHERE key=? LIMIT 1").get(key);
    return row ? JSON.parse(row.data) : null;
  }
  setCheckpoint(key: string, value: unknown): void {
    this.db.query("INSERT INTO usage_checkpoints(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(key, JSON.stringify(value));
  }
  importIntervals(intervals: UsageInterval[], observedAt: number): void {
    const insert = this.db.query("INSERT INTO usage_intervals(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data");
    this.db.transaction(() => {
      for (const interval of intervals) {
        insert.run(interval.id, JSON.stringify({ ...interval, directory: scrub(interval.directory) }));
        const session = this.db.query<{ data: string }, [string]>("SELECT data FROM usage_sessions WHERE id=? LIMIT 1").get(interval.session_id);
        if (!session) this.upsertSession({ id: interval.session_id, source: interval.session_id.startsWith("codex:") ? "codex" : "opencode", parent_id: null, title: "Сессия недоступна", directory: interval.directory, created_at: interval.entered_at, updated_at: interval.exited_at ?? observedAt });
      }
      const old = Number(this.getCheckpoint("observed_at") ?? 0);
      this.setCheckpoint("observed_at", Math.max(old, observedAt));
    })();
  }
  observe(observation: UsageObservation): void {
    this.db.transaction(() => {
      this.importIntervals(observation.intervals, observation.at);
      const cards = new Map(observation.cards.map(card => [card.session_id, card]));
      for (const card of observation.cards) {
        const old = this.db.query<{ data: string }, [string]>("SELECT data FROM usage_sessions WHERE id=? LIMIT 1").get(card.session_id);
        const session = old ? JSON.parse(old.data) as UsageSession : null;
        this.upsertSession({ id: card.session_id, source: card.source, parent_id: card.parent_id, title: card.title, directory: card.directory, created_at: session?.created_at ?? observation.at, updated_at: session?.updated_at ?? observation.at });
      }
      for (const interval of observation.intervals) {
        if (interval.column_name !== "running") continue;
        const latest = this.db.query<{ id: number; start_at: number; end_at: number; agent: string | null; model: string | null }, [number]>("SELECT * FROM usage_attributions WHERE interval_id=? ORDER BY start_at DESC,id DESC LIMIT 1").get(interval.id);
        const end = interval.exited_at ?? observation.at;
        if (latest && end >= latest.end_at) this.db.query("UPDATE usage_attributions SET end_at=? WHERE id=?").run(end, latest.id);
        if (interval.exited_at !== null) continue;
        const card = cards.get(interval.session_id);
        const agent = scrub(card?.agent ?? null), model = scrub(card?.model ?? null);
        if (!latest || latest.agent !== agent || latest.model !== model) {
          this.db.query("INSERT INTO usage_attributions(interval_id,start_at,end_at,agent,model) VALUES(?,?,?,?,?)").run(interval.id, observation.at, observation.at, agent, model);
        }
      }
    })();
  }
  dataset(): UsageDataset {
    const rows = <T>(table: string, key: string): T[] => {
      const result: T[] = [];
      let cursor: string | number = key === "id" && table === "usage_sessions" ? "" : 0;
      while (true) {
        const batch = this.db.query<{ cursor: string | number; data: string }, [string | number]>(`SELECT ${key} AS cursor,data FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 500`).all(cursor);
        for (const row of batch) result.push(JSON.parse(row.data) as T);
        if (batch.length < 500) break;
        cursor = batch[batch.length - 1].cursor;
      }
      return result;
    };
    const attributions: UsageAttribution[] = [];
    let cursor = 0;
    while (true) {
      const batch = this.db.query<{ id: number; interval_id: number; start_at: number; end_at: number; agent: string | null; model: string | null }, [number]>("SELECT * FROM usage_attributions WHERE id>? ORDER BY id LIMIT 500").all(cursor);
      attributions.push(...batch.map(a => ({ interval_id: a.interval_id, start: a.start_at, end: a.end_at, agent: a.agent, model: a.model })));
      if (batch.length < 500) break;
      cursor = batch[batch.length - 1].id;
    }
    return { sessions: rows<UsageSession>("usage_sessions", "id"), events: rows<UsageEvent>("usage_events", "row_id"), intervals: rows<UsageInterval>("usage_intervals", "id"), attributions,
      observed_at: Number(this.getCheckpoint("observed_at") ?? 0), sources: this.getCheckpoint("sources") as UsageImportStatus[] ?? [] };
  }
  close(): void { this.db.close(); }
}
