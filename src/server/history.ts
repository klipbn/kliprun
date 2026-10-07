/**
 * Durable history of observed Kanban column transitions.
 * Stored in KlipRun's own database
 * (~/.kliprun_bun/status-history.sqlite3) — never in OpenCode's DB.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KanbanInterval } from "@shared/types";
import type { UsageInterval } from "@shared/usage";

export interface HistoryCard {
  sessionId: string;
  directory: string;
  column: string;
}

type IntervalRow = UsageInterval;

export function defaultHistoryPath(): string {
  const home = process.env.KLIPRUN_BUN_HOME;
  const base = home ?? join(homedir(), ".kliprun_bun");
  return join(base, "status-history.sqlite3");
}

export class StatusHistoryStore {
  private readonly db: Database;

  constructor(path: string = defaultHistoryPath()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.query("PRAGMA busy_timeout = 5000;").run();
    this.db
      .query(
        `CREATE TABLE IF NOT EXISTS status_intervals (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          directory TEXT NOT NULL,
          column_name TEXT NOT NULL,
          entered_at INTEGER NOT NULL,
          exited_at INTEGER,
          duration_ms INTEGER
        )`,
      )
      .run();
    this.db
      .query(
        "CREATE INDEX IF NOT EXISTS status_intervals_session ON status_intervals(session_id, entered_at)",
      )
      .run();
    this.db
      .query(
        `CREATE TABLE IF NOT EXISTS history_metadata (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        )`,
      )
      .run();
  }

  /** Close/open intervals when a session's observed board column changes. */
  record(cards: HistoryCard[], observedAt: number): UsageInterval[] {
    const byId = new Map(cards.map((card) => [card.sessionId, card]));
    const active = this.db
      .query<IntervalRow, []>("SELECT * FROM status_intervals WHERE exited_at IS NULL")
      .all();
    const activeById = new Map(active.map((row) => [row.session_id, row]));

    const closed: UsageInterval[] = [];
    const tx = this.db.transaction(() => {
      for (const [sessionId, row] of activeById) {
        const card = byId.get(sessionId);
        if (!card || row.column_name !== card.column || row.directory !== card.directory) {
          closed.push(this.closeInterval(row, observedAt));
        }
      }
      for (const [sessionId, card] of byId) {
        const current = activeById.get(sessionId);
        if (
          current &&
          current.exited_at === null &&
          current.column_name === card.column &&
          current.directory === card.directory
        ) {
          continue;
        }
        this.db
          .query(
            "INSERT INTO status_intervals (session_id, directory, column_name, entered_at) VALUES (?, ?, ?, ?)",
          )
          .run(sessionId, card.directory, card.column, observedAt);
      }
      this.db
        .query(
          "INSERT INTO history_metadata(key, value) VALUES ('last_observed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(observedAt);
    });
    tx();
    return [...closed, ...this.db.query<IntervalRow, []>("SELECT * FROM status_intervals WHERE exited_at IS NULL").all()];
  }

  get(sessionId: string, now: number): KanbanInterval[] {
    const rows = this.db
      .query<IntervalRow, [string]>(
        "SELECT * FROM status_intervals WHERE session_id = ? ORDER BY entered_at, id",
      )
      .all(sessionId);
    const result: KanbanInterval[] = [];
    for (const row of rows) {
      const duration = row.duration_ms ?? Math.max(0, now - row.entered_at);
      const interval: KanbanInterval = {
        column: row.column_name,
        entered_at: row.entered_at,
        exited_at: row.exited_at,
        duration_ms: duration,
        current: row.exited_at === null,
      };
      const last = result[result.length - 1];
      if (last && last.column === interval.column && !last.current) {
        // A same-column interval after a monitor restart is a continuation.
        last.duration_ms += interval.duration_ms;
        last.exited_at = interval.exited_at;
        last.current = interval.current;
      } else {
        result.push(interval);
      }
    }
    return result;
  }

  /** End current intervals on shutdown/restart without counting downtime. */
  closeOpenIntervals(at?: number): UsageInterval[] {
    let stamp = at;
    if (stamp === undefined) {
      const row = this.db
        .query<{ value: number } | null, []>(
          "SELECT value FROM history_metadata WHERE key = 'last_observed_at'",
        )
        .get();
      if (!row) return [];
      stamp = row.value;
    }
    const rows = this.db
      .query<IntervalRow, []>("SELECT * FROM status_intervals WHERE exited_at IS NULL")
      .all();
    const result: UsageInterval[] = [];
    const tx = this.db.transaction(() => {
      for (const row of rows) result.push(this.closeInterval(row, stamp));
    });
    tx();
    return result;
  }

  private closeInterval(row: IntervalRow, at: number): UsageInterval {
    const endedAt = Math.max(row.entered_at, at);
    this.db
      .query("UPDATE status_intervals SET exited_at = ?, duration_ms = ? WHERE id = ?")
      .run(endedAt, endedAt - row.entered_at, row.id);
    return { ...row, exited_at: endedAt, duration_ms: endedAt - row.entered_at };
  }

  close(): void {
    this.closeOpenIntervals();
    this.db.close();
  }
}
