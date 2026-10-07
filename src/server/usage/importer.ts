import type { UsageEvent, UsageImportStatus, UsageSession } from "@shared/usage";
import { Database } from "bun:sqlite";
import { createHash, type Hash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scrub } from "../security";
import { nonnegative, normalizeCodexTokens, normalizeOpenCodeTokens, record } from "./normalize";

const PAGE = 250;
const BLOCK = 4 * 1024 * 1024;
const LINE = 1024 * 1024;
const VERSION = 3;
const RAW_FIELDS = ["total_tokens", "input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"] as const;
type Counter = Partial<Record<typeof RAW_FIELDS[number], number>> & { total_tokens: number };
type Json = Record<string, unknown>;
const textValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

interface OpenCodeRow { id: string; parent_id: string | null; title: string; directory: string; time_created: number; time_updated: number }
interface MessageRow { id: string; time_created: number; data: string | null }
interface MessageRevisionRow { id: string; time_created: number; time_updated: number }
interface CodexRow { id: string; cwd: string; title: string; rollout_path: string; created_at: number | null; updated_at: number }
interface JournalCheckpoint {
  version: number;
  identity: string;
  offset: number;
  size: number;
  mtime: number;
  content_hash: string;
  skipping: boolean;
  skipped: number;
  previous: Counter | null;
  model: string | null;
  provider: string | null;
  ineligible: boolean;
}

export interface UsageImportSink {
  upsertSession(session: UsageSession): void;
  replaceEvents(sessionId: string, events: UsageEvent[]): void;
  upsertEvents(sessionId: string, events: UsageEvent[]): void;
  getCheckpoint(key: string): unknown;
  setCheckpoint(key: string, value: unknown): void;
}

export interface UsageImporterOptions {
  opencodePath: string;
  codexHome: string;
  onProgress?: (status: UsageImportStatus[]) => void;
}

function counter(value: unknown): Counter | null {
  const data = record(value); const total = nonnegative(data.total_tokens);
  if (total === null) return null;
  const result: Counter = { total_tokens: total };
  for (const field of RAW_FIELDS) { const value = nonnegative(data[field]); if (value !== null) result[field] = value; }
  return result;
}
function difference(current: Counter, previous: Counter): Counter {
  const result: Counter = { total_tokens: Math.max(0, current.total_tokens - previous.total_tokens) };
  for (const field of RAW_FIELDS) {
    if (current[field] !== undefined && previous[field] !== undefined) result[field] = Math.max(0, current[field]! - previous[field]!);
  }
  return result;
}
function resetCounter(current: Counter, previous: Counter): boolean {
  return RAW_FIELDS.some(field => current[field] !== undefined && previous[field] !== undefined && current[field]! < previous[field]!);
}
function database(path: string): Database {
  statSync(path); // Refuse to create missing source databases.
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 100");
  return db;
}
function columns(db: Database, table: "threads" | "session" | "message"): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(row => row.name));
}
function identity(path: string): string {
  const stat = statSync(path); return `${path}:${stat.dev}:${stat.ino}`;
}
class ImportCancelled extends Error {}

async function advanceHash(fd: number, hash: Hash, start: number, end: number, check: () => void): Promise<void> {
  while (start < end) {
    check();
    const chunk = Buffer.alloc(Math.min(BLOCK, end - start));
    const bytes = readSync(fd, chunk, 0, chunk.length, start);
    if (bytes === 0) throw new Error("Journal changed while being indexed");
    hash.update(chunk.subarray(0, bytes)); start += bytes;
    if (chunk.length === BLOCK) await pause();
  }
  check();
}

/** Source-only importer. Its sink exclusively owns KlipRun's normalized index and checkpoints. */
export class UsageImporter {
  private states: UsageImportStatus[] = ["opencode", "codex"].map(source => ({ source: source as "opencode" | "codex", state: "loading", indexed: 0, total: 0, updated_at: null, skipped: 0, message: null }));
  private inFlight: Promise<UsageImportStatus[]> | null = null;
  private stopping = false;
  constructor(private options: UsageImporterOptions, private sink: UsageImportSink) {}

  get status(): UsageImportStatus[] { return this.states.map(row => ({ ...row })); }
  stop(): void { this.stopping = true; }
  private checkStopped(): void { if (this.stopping) throw new ImportCancelled(); }
  runOnce(): Promise<UsageImportStatus[]> {
    if (this.inFlight) return this.inFlight;
    if (this.stopping) return Promise.resolve(this.status);
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private update(source: "opencode" | "codex", patch: Partial<UsageImportStatus>): void {
    const index = source === "opencode" ? 0 : 1;
    this.states[index] = { ...this.states[index]!, ...patch };
    this.options.onProgress?.(this.status);
  }
  private async run(): Promise<UsageImportStatus[]> {
    for (const source of ["opencode", "codex"] as const) {
      if (this.stopping) return this.status;
      this.update(source, { state: "loading", indexed: 0, total: 0, skipped: 0, message: null });
      try {
        this.checkStopped();
        if (source === "opencode") await this.importOpenCode(); else await this.importCodex();
        this.checkStopped();
        this.update(source, { state: "ready", updated_at: Date.now() });
      } catch (error) {
        if (error instanceof ImportCancelled || this.stopping) return this.status;
        this.update(source, { state: "unavailable", message: scrub(error instanceof Error ? error.message : String(error)) });
      }
    }
    return this.status;
  }

  private async importOpenCode(): Promise<void> {
    const db = database(this.options.opencodePath);
    try {
      const sessionSchema = columns(db, "session"); const messageSchema = columns(db, "message");
      if (!["id", "parent_id", "directory", "title", "time_created", "time_updated"].every(key => sessionSchema.has(key)) || !["id", "session_id", "time_created", "time_updated", "data"].every(key => messageSchema.has(key))) throw new Error("Unsupported OpenCode history schema");
      this.update("opencode", { total: db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session").get()!.count });
      const sessions = db.query<OpenCodeRow, [string, number]>("SELECT id,parent_id,title,directory,time_created,time_updated FROM session WHERE id > ? ORDER BY id LIMIT ?");
      const revision = db.query<MessageRevisionRow, [string, number, string, number]>("SELECT id,time_created,time_updated FROM message WHERE session_id = ? AND (time_created,id) > (?,?) ORDER BY time_created,id LIMIT ?");
      const messages = db.query<MessageRow, [string, number, string, number]>(`SELECT id,time_created,CASE WHEN length(CAST(data AS BLOB)) <= ${LINE} THEN data ELSE NULL END AS data FROM message WHERE session_id = ? AND (time_created,id) > (?,?) ORDER BY time_created,id LIMIT ?`);
      const sourceIdentity = identity(this.options.opencodePath);
      let lastSession = ""; let indexed = 0; let skipped = 0;
      for (;;) {
        this.checkStopped();
        const page = sessions.all(lastSession, PAGE);
        if (page.length === 0) break;
        for (const row of page) {
          this.checkStopped();
          lastSession = row.id;
          this.sink.upsertSession({ id: row.id, source: "opencode", parent_id: row.parent_id, title: scrub(row.title ?? ""), directory: scrub(row.directory ?? ""), created_at: row.time_created, updated_at: row.time_updated });
          const stampHash = createHash("sha256").update(`${VERSION}:${sourceIdentity}:${row.time_updated}\n`);
          let revTime = -1; let revId = "";
          for (;;) {
            this.checkStopped();
            const revisions = revision.all(row.id, revTime, revId, PAGE); if (revisions.length === 0) break;
            for (const entry of revisions) { stampHash.update(JSON.stringify([entry.id, entry.time_created, entry.time_updated]) + "\n"); revTime = entry.time_created; revId = entry.id; }
            await pause();
          }
          const key = `opencode:${row.id}`; const stamp = stampHash.digest("hex");
          const previous = record(this.sink.getCheckpoint(key));
          if (previous.stamp === stamp) { skipped += Number(previous.skipped ?? 0); indexed++; continue; }
          this.checkStopped();
          this.sink.replaceEvents(row.id, []);
          let lastTime = -1; let lastId = ""; let sessionSkipped = 0;
          for (;;) {
            this.checkStopped();
            const messagePage = messages.all(row.id, lastTime, lastId, PAGE);
            if (messagePage.length === 0) break;
            const batch: UsageEvent[] = [];
            for (const message of messagePage) {
              lastTime = message.time_created; lastId = message.id;
              let data: Json;
              try { if (message.data === null) throw new Error("Oversized message"); data = record(JSON.parse(message.data)); }
              catch { sessionSkipped++; continue; }
              const event = this.openCodeEvent(row.id, message.id, data);
              if (event) batch.push(event);
            }
            this.checkStopped(); this.sink.upsertEvents(row.id, batch);
            await pause();
          }
          this.checkStopped(); this.sink.setCheckpoint(key, { stamp, skipped: sessionSkipped });
          skipped += sessionSkipped; indexed++;
          this.update("opencode", { indexed, skipped });
        }
        await pause();
      }
      this.update("opencode", { indexed, skipped });
    } finally { db.close(); }
  }

  private openCodeEvent(sessionId: string, messageId: string, data: Json): UsageEvent | null {
    const role = textValue(data.role); if (role !== "assistant" && role !== "user") return null;
    const time = record(data.time); const at = nonnegative(role === "user" ? time.created : time.completed);
    const agent = textValue(data.agent) ?? textValue(data.mode);
    const nestedModel = record(data.model);
    const model = textValue(data.modelID) ?? textValue(nestedModel.modelID); const provider = textValue(data.providerID) ?? textValue(nestedModel.providerID);
    const modelRef = model ? provider ? `${provider}/${model}` : model : null;
    if (role === "user") return { id: `opencode:message:${messageId}`, session_id: sessionId, at, kind: "turn", agent: scrub(agent), model: scrub(modelRef), tokens: null, cost: null, incomplete: at === null };
    const usage = normalizeOpenCodeTokens(data.tokens);
    if ((!usage || usage.tokens.total === 0) && at === null) return null;
    return { id: `opencode:message:${messageId}`, session_id: sessionId, at, kind: "usage", agent: scrub(agent), model: scrub(modelRef), tokens: usage?.tokens ?? null, cost: nonnegative(data.cost), incomplete: !usage || usage.incomplete || at === null || model === null };
  }

  private async importCodex(): Promise<void> {
    const names = readdirSync(this.options.codexHome).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    if (!names[0]) throw new Error("Codex database not found");
    const db = database(join(this.options.codexHome, names[0]));
    try {
      const schema = columns(db, "threads");
      if (!["id", "cwd", "title", "source", "rollout_path", "updated_at"].every(key => schema.has(key))) throw new Error("Unsupported Codex history schema");
      let eligible = schema.has("originator") ? "(source = 'cli' OR (source = 'vscode' AND originator = 'codex-tui'))" : "source = 'cli'";
      if (schema.has("parent_thread_id")) eligible += " AND parent_thread_id IS NULL";
      this.update("codex", { total: db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM threads WHERE ${eligible}`).get()!.count });
      const rows = db.query<CodexRow, [string, number]>(`SELECT id,cwd,title,rollout_path,${schema.has("created_at") ? "created_at" : "NULL AS created_at"},updated_at FROM threads WHERE ${eligible} AND id > ? ORDER BY id LIMIT ?`);
      let lastId = ""; let indexed = 0; let skipped = 0; let missing = 0;
      for (;;) {
        this.checkStopped();
        const page = rows.all(lastId, PAGE); if (page.length === 0) break;
        for (const row of page) {
          this.checkStopped();
          lastId = row.id;
          try {
            const checkpoint = await this.readJournal(row);
            this.checkStopped();
            if (checkpoint.ineligible) continue;
            this.sink.upsertSession({ id: `codex:${row.id}`, source: "codex", parent_id: null, title: scrub(row.title ?? ""), directory: scrub(row.cwd ?? ""), created_at: (nonnegative(row.created_at) ?? 0) * 1000, updated_at: row.updated_at * 1000 });
            skipped += checkpoint.skipped; indexed++;
          } catch (error) { if (error instanceof ImportCancelled) throw error; missing++; }
          this.update("codex", { indexed, skipped, message: missing > 0 ? `${missing} journals unavailable; previously indexed usage retained` : null });
        }
        await pause();
      }
      if (indexed === 0 && missing > 0) throw new Error("No Codex journals accessible");
      this.update("codex", { indexed, skipped });
    } finally { db.close(); }
  }

  private async readJournal(row: CodexRow): Promise<JournalCheckpoint> {
    this.checkStopped();
    const sessionId = `codex:${row.id}`; const key = `codex:journal:${row.id}`;
    const path = row.rollout_path; const stat = statSync(path); const fileIdentity = identity(path); const fd = openSync(path, "r");
    try {
      const stored = this.sink.getCheckpoint(key) as JournalCheckpoint | undefined;
      if (stored?.version === VERSION && stored.identity === fileIdentity && stored.size === stat.size && stored.mtime === stat.mtimeMs && stored.offset === stat.size) return { ...stored };
      let hash = createHash("sha256");
      let resumable = stored?.version === VERSION && stored.identity === fileIdentity && stored.offset <= stat.size && !(stored.size === stat.size && stored.mtime !== stat.mtimeMs);
      if (resumable) {
        await advanceHash(fd, hash, 0, stored!.offset, () => this.checkStopped());
        resumable = hash.copy().digest("hex") === stored!.content_hash;
      }
      if (!resumable) hash = createHash("sha256");
      const state: JournalCheckpoint = resumable ? { ...stored! } : { version: VERSION, identity: fileIdentity, offset: 0, size: stat.size, mtime: stat.mtimeMs, content_hash: "", skipping: false, skipped: 0, previous: null, model: null, provider: null, ineligible: false };
      this.checkStopped(); if (!resumable) this.sink.replaceEvents(sessionId, []);
      if (state.ineligible) return state;
      let readAt = state.offset; let partial = Buffer.alloc(0); let lineStart = state.offset; let hashAt = state.offset;
      while (readAt < stat.size) {
        this.checkStopped();
        const chunk = Buffer.alloc(Math.min(BLOCK, stat.size - readAt)); const bytes = readSync(fd, chunk, 0, chunk.length, readAt); if (!bytes) break;
        const data = Buffer.concat([partial, chunk.subarray(0, bytes)]);
        const base = readAt - partial.length; let start = 0; const batch: UsageEvent[] = [];
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          const offset = base + start;
          if (state.skipping || end - start > LINE) state.skipped++;
          else if (end > start) {
            try { this.codexEntry(sessionId, offset, record(JSON.parse(data.subarray(start, end).toString("utf8"))), state, batch); }
            catch { state.skipped++; }
          }
          state.skipping = false; start = end + 1; state.offset = base + start;
        }
        readAt += bytes; lineStart = base + start;
        if (data.length - start > LINE || state.skipping) { partial = Buffer.alloc(0); state.skipping = true; state.offset = readAt; }
        else partial = Buffer.from(data.subarray(start));
        this.checkStopped(); if (state.ineligible) { this.sink.replaceEvents(sessionId, []); batch.length = 0; }
        this.checkStopped(); this.sink.upsertEvents(sessionId, batch);
        state.size = stat.size; state.mtime = stat.mtimeMs;
        await advanceHash(fd, hash, hashAt, state.offset, () => this.checkStopped()); hashAt = state.offset;
        state.content_hash = hash.copy().digest("hex");
        this.checkStopped(); this.sink.setCheckpoint(key, state);
        await pause();
        if (state.ineligible) break;
      }
      if (partial.length > 0) state.offset = lineStart;
      state.size = stat.size; state.mtime = stat.mtimeMs;
      state.content_hash = hash.copy().digest("hex");
      this.checkStopped(); this.sink.setCheckpoint(key, state);
      return state;
    } finally { closeSync(fd); }
  }

  private codexEntry(sessionId: string, offset: number, entry: Json, state: JournalCheckpoint, batch: UsageEvent[]): void {
    const payload = record(entry.payload); const type = textValue(payload.type);
    const parsedAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const at = Number.isFinite(parsedAt) && parsedAt >= 0 ? parsedAt : null;
    if (entry.type === "session_meta") {
      state.provider = textValue(payload.model_provider) ?? state.provider;
      const source = payload.source;
      if (source !== null && typeof source === "object" && /sub.?agent/i.test(JSON.stringify(source))) state.ineligible = true;
    }
    if (entry.type === "turn_context") {
      state.model = textValue(payload.model) ?? state.model;
      state.provider = textValue(payload.model_provider) ?? state.provider;
    }
    if (entry.type !== "event_msg") return;
    const model = state.model ? state.provider ? `${state.provider}/${state.model}` : state.model : null;
    if (type === "task_started") {
      const turnId = textValue(payload.turn_id);
      batch.push({ id: `${sessionId}:turn:${turnId ?? `line:${offset}`}`, session_id: sessionId, at, kind: "turn", agent: "Codex", model: scrub(model), tokens: null, cost: null, incomplete: at === null || turnId === null });
    }
    if (type !== "token_count") return;
    const info = record(payload.info); const current = counter(info.total_token_usage); if (!current) return;
    const previous = state.previous; const last = counter(info.last_token_usage); const reset = previous !== null && resetCounter(current, previous);
    state.previous = current;
    const eventId = `${sessionId}:usage:${offset}`;
    const add = (value: Counter, id: string, eventAt: number | null, eventModel: string | null, partial: boolean): void => {
      const usage = normalizeCodexTokens(value); if (!usage || usage.tokens.total <= 0) return;
      batch.push({ id, session_id: sessionId, at: eventAt, kind: "usage", agent: "Codex", model: scrub(eventModel), tokens: usage.tokens, cost: null, incomplete: partial || usage.incomplete || eventAt === null || eventModel === null || state.skipped > 0 });
    };
    if (previous && !reset) { add(difference(current, previous), eventId, at, model, false); return; }
    if (last && current.total_tokens > last.total_tokens && !reset) {
      add(difference(current, last), `${eventId}:unattributed`, null, null, true);
      add(last, eventId, at, model, false);
    } else add(reset && last ? last : current, eventId, at, model, reset && !last);
  }
}
