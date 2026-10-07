import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { MAX_WATCHED_DIRECTORIES } from "@shared/constants";
import type { CliProcess } from "./liveness";

export interface CodexThread {
  id: string;
  cwd: string;
  title: string;
  source: string;
  rollout_path: string;
  updated_at: number;
  model: string | null;
  model_provider?: string | null;
  /** TUI clients using the shared app-server may persist source=vscode. */
  originator?: string | null;
}

export function codexHome(): string {
  return process.env.KLIPRUN_BUN_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Only metadata. Rollouts are tailed separately after CLI membership is known. */
export class CodexStorage {
  private db: Database | null = null;
  private identity = "";
  private columns = new Set<string>();
  path: string | null = null;

  constructor(readonly home = codexHome()) {}

  private connect(): Database {
    const names = readdirSync(this.home).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!names[0]) throw new Error("Codex database not found");
    const path = join(this.home, names[0]);
    const stat = statSync(path);
    const identity = `${path}:${stat.dev}:${stat.ino}`;
    if (this.db && this.identity === identity) return this.db;
    this.close();
    const db = new Database(path, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 100");
      this.columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(threads)").all().map(row => row.name));
      if (!["id", "cwd", "title", "source", "rollout_path", "updated_at", "archived"].every(key => this.columns.has(key))) {
        throw new Error("Unsupported Codex database schema");
      }
      this.db = db; this.path = path; this.identity = identity;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  candidates(processes: CliProcess[]): CodexThread[] {
    const db = this.connect();
    const hasOriginator = this.columns.has("originator");
    const fields = `id, cwd, title, source, rollout_path, updated_at, ${this.columns.has("model") ? "model" : "NULL AS model"}, ${this.columns.has("model_provider") ? "model_provider" : "NULL AS model_provider"}, ${hasOriginator ? "originator" : "NULL AS originator"}`;
    const cliSource = hasOriginator ? "(source = 'cli' OR (source = 'vscode' AND originator = 'codex-tui'))" : "source = 'cli'";
    const rows = new Map<string, CodexThread>();
    const referencedIds = new Set<string>();
    const directories = [...new Set(processes.map(p => p.cwd))].slice(0, MAX_WATCHED_DIRECTORIES);
    for (const cwd of directories) {
      // Two results preserve ambiguity; never load every session in a directory.
      for (const row of db.query<CodexThread, [string]>(`SELECT ${fields} FROM threads WHERE archived = 0 AND cwd = ? AND ${cliSource} LIMIT 2`).all(cwd)) rows.set(row.id, row);
    }
    for (const process of processes.filter(p => directories.includes(p.cwd))) {
      for (const id of [...(process.writerSessionIds ?? []), ...(process.daemonSessionIds ?? [])]) referencedIds.add(id);
      for (const path of process.rollouts.slice(0, 4)) {
        const id = basename(path).match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i)?.[1];
        if (id) referencedIds.add(id);
      }
    }
    // Fetch live references by primary key, even when history has many entries in this cwd.
    for (const id of referencedIds) {
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) continue;
      const row = db.query<CodexThread, [string]>(`SELECT ${fields} FROM threads WHERE id = ? AND archived = 0 LIMIT 1`).get(id);
      if (row) rows.set(row.id, row);
    }
    return [...rows.values()].filter(row =>
      [row.id, row.cwd, row.title, row.source, row.rollout_path].every(value => typeof value === "string") &&
      typeof row.updated_at === "number" && Number.isFinite(row.updated_at) && row.updated_at >= 0,
    ).map(row => ({ ...row, model: typeof row.model === "string" ? row.model : null }));
  }

  close(): void {
    this.db?.close(); this.db = null; this.path = null; this.identity = "";
  }
}
