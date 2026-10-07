import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageEvent, UsageSession } from "@shared/usage";
import { UsageImporter, type UsageImportSink } from "../usage/importer";
import { normalizeOpenCodeTokens, normalizeCodexTokens } from "../usage/normalize";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "kliprun-usage-")); dirs.push(dir); return dir; }
const at = 1_800_000_000_000;
function event(type: string, payload: Record<string, unknown>, timestamp: number | null = at): string {
  return JSON.stringify({ ...(timestamp === null ? {} : { timestamp: new Date(timestamp).toISOString() }), type, payload }) + "\n";
}
function counter(total: number, input: number, output: number, cached = 0, reasoning = 0) {
  return { total_tokens: total, input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: reasoning };
}
function usage(value: ReturnType<typeof counter>, timestamp = at) {
  return event("event_msg", { type: "token_count", info: { total_token_usage: value, last_token_usage: value } }, timestamp);
}
function memorySink(): UsageImportSink & { sessions: Map<string, UsageSession>; events: Map<string, UsageEvent>; checkpoints: Map<string, unknown> } {
  const sessions = new Map<string, UsageSession>(); const events = new Map<string, UsageEvent>(); const checkpoints = new Map<string, unknown>();
  return { sessions, events, checkpoints,
    upsertSession: (session) => { sessions.set(session.id, session); },
    replaceEvents: (sessionId, rows) => { for (const [key, value] of events) if (value.session_id === sessionId) events.delete(key); for (const row of rows) events.set(row.id, row); },
    upsertEvents: (_sessionId, rows) => { for (const row of rows) events.set(row.id, row); },
    getCheckpoint: (key) => checkpoints.get(key), setCheckpoint: (key, value) => { checkpoints.set(key, structuredClone(value)); },
  };
}
function codexDatabase(dir: string) {
  const path = join(dir, "state_5.sqlite"); const db = new Database(path);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, source TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, model TEXT, model_provider TEXT, originator TEXT)");
  return { db, path };
}
function insertThread(db: Database, id: string, path: string, source = "cli", originator: string | null = null, archived = 0) {
  db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, "/project", "token=secret-value", source, path, at / 1000, at / 1000, archived, "final-model", "openai", originator);
}
function opencodeDatabase(dir: string) {
  const path = join(dir, "opencode.db"); const db = new Database(path);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
  db.exec("CREATE INDEX message_session_time ON message(session_id,time_created,id)");
  return { db, path };
}

describe("usage token normalization", () => {
  test("preserves OpenCode exclusive categories and authoritative total with an unallocated remainder", () => {
    expect(normalizeOpenCodeTokens({ total: 150, input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 3 } })).toEqual({
      tokens: { total: 150, input: 100, output: 20, reasoning: 5, cache_read: 10, cache_write: 3, other: 12 }, incomplete: false,
    });
  });
  test("subtracts Codex nested categories so input, cache, output and reasoning do not double count", () => {
    expect(normalizeCodexTokens(counter(120, 100, 20, 40, 5))).toEqual({
      tokens: { total: 120, input: 60, output: 15, reasoning: 5, cache_read: 40, cache_write: 0, other: 0 }, incomplete: false,
    });
  });
  test("keeps partial counters explicit and rejects invalid numbers", () => {
    expect(normalizeOpenCodeTokens({ total: 20 })).toEqual({ tokens: { total: 20, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: 20 }, incomplete: true });
    expect(normalizeOpenCodeTokens({ input: -3, output: Infinity })).toBeNull();
  });
  test("keeps an inconsistent source total unallocated instead of rendering categories exceeding it", () => {
    expect(normalizeOpenCodeTokens({ total: 5, input: 7, output: 2 })).toEqual({ tokens: { total: 5, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, other: 5 }, incomplete: true });
  });
});

describe("read-only history importer", () => {
  test("imports archived OpenCode trees beyond the detail message limit and replaces changed messages", async () => {
    const dir = temp(); const { db, path } = opencodeDatabase(dir); const sink = memorySink();
    db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("root", null, "/project", "Root", at, at, at);
    db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("child", "root", "/project", "Child", at, at, null);
    const insert = db.query("INSERT INTO message VALUES (?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < 2105; i++) insert.run(`m${i.toString().padStart(5, "0")}`, "root", at + i, at + i, JSON.stringify({ role: "assistant", agent: "build", providerID: "provider", modelID: "model", time: { completed: at + i }, tokens: { input: 2, output: 1, total: 3 }, cost: 0 }));
      insert.run("user", "child", at, at, JSON.stringify({ role: "user", agent: "plan", time: { created: at }, text: "DO NOT STORE THIS" }));
    })();
    db.close(); const before = readFileSync(path);
    const importer = new UsageImporter({ opencodePath: path, codexHome: join(dir, "missing") }, sink);
    const status = await importer.runOnce();
    expect(sink.sessions.get("child")?.parent_id).toBe("root");
    expect([...sink.events.values()].filter(row => row.kind === "usage")).toHaveLength(2105);
    expect([...sink.events.values()].reduce((sum, row) => sum + (row.tokens?.total ?? 0), 0)).toBe(6315);
    expect(sink.events.get("opencode:message:user")?.kind).toBe("turn");
    expect(JSON.stringify([...sink.events.values()])).not.toContain("DO NOT STORE THIS");
    expect(status.find(row => row.source === "opencode")).toMatchObject({ state: "ready", indexed: 2, total: 2 });
    expect(readFileSync(path)).toEqual(before);
    const writer = new Database(path);
    writer.query("UPDATE message SET data = ?, time_updated = ? WHERE id = ?").run(JSON.stringify({ role: "assistant", time: {}, tokens: { total: 10 } }), at + 10000, "m00000"); writer.close();
    await importer.runOnce();
    expect(sink.events.get("opencode:message:m00000")).toMatchObject({ at: null, incomplete: true, model: null, tokens: { total: 10 } });
    expect([...sink.events.values()].reduce((sum, row) => sum + (row.tokens?.total ?? 0), 0)).toBe(6322);
  });

  test("streams the complete Codex journal beyond 4 MiB and resumes counters without counting duplicates", async () => {
    const dir = temp(); const { db, path } = codexDatabase(dir); const sink = memorySink(); const rollout = join(dir, "session.jsonl");
    insertThread(db, "cli", rollout, "cli", null, 1); insertThread(db, "tui", join(dir, "tui.jsonl"), "vscode", "codex-tui");
    insertThread(db, "desktop", rollout, "vscode", "codex-desktop"); db.close();
    writeFileSync(rollout, event("session_meta", { model_provider: "openai" }) + event("turn_context", { model: "first" }) + event("event_msg", { type: "task_started", turn_id: "turn-a" }) + usage(counter(120, 100, 20, 40, 5)));
    const filler = event("response_item", { type: "message", role: "assistant", content: [{ text: "x".repeat(700_000) }] });
    for (let i = 0; i < 7; i++) appendFileSync(rollout, filler);
    appendFileSync(rollout, usage(counter(120, 100, 20, 40, 5), at + 1) + event("turn_context", { model: "second" }, at + 2) + usage(counter(157, 130, 27, 50, 7), at + 3));
    writeFileSync(join(dir, "tui.jsonl"), usage(counter(9, 7, 2)));
    const before = readFileSync(path);
    const importer = new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink);
    await importer.runOnce();
    const cliUsage = [...sink.events.values()].filter(row => row.session_id === "codex:cli" && row.kind === "usage");
    expect(cliUsage.map(row => row.tokens?.total)).toEqual([120, 37]);
    expect(cliUsage.map(row => row.model)).toEqual(["openai/first", "openai/second"]);
    expect(cliUsage[1]?.tokens).toEqual({ total: 37, input: 20, output: 5, reasoning: 2, cache_read: 10, cache_write: 0, other: 0 });
    expect(sink.sessions.has("codex:desktop")).toBe(false);
    expect(sink.sessions.get("codex:cli")?.title).toBe("token=[redacted]");
    expect([...sink.events.values()].filter(row => row.kind === "turn")).toHaveLength(1);
    expect(readFileSync(path)).toEqual(before);
    appendFileSync(rollout, usage(counter(157, 130, 27, 50, 7), at + 4) + usage(counter(12, 10, 2), at + 5));
    await new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink).runOnce();
    expect([...sink.events.values()].filter(row => row.session_id === "codex:cli" && row.kind === "usage").map(row => row.tokens?.total)).toEqual([120, 37, 12]);
    await importer.runOnce();
    expect([...sink.events.values()].filter(row => row.session_id === "codex:cli" && row.kind === "usage")).toHaveLength(3);
    expect(JSON.stringify([...sink.checkpoints.values()])).not.toContain("xxxx");
  });

  test("rebuilds truncated or rewritten journals and waits for incomplete writes", async () => {
    const dir = temp(); const { db } = codexDatabase(dir); const sink = memorySink(); const rollout = join(dir, "session.jsonl");
    insertThread(db, "cli", rollout); db.close(); writeFileSync(rollout, usage(counter(20, 15, 5)));
    const importer = new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink);
    await importer.runOnce();
    writeFileSync(rollout, usage(counter(7, 5, 2)));
    await importer.runOnce();
    expect([...sink.events.values()].map(row => row.tokens?.total)).toEqual([7]);
    const next = usage(counter(12, 8, 4), at + 1); appendFileSync(rollout, next.slice(0, -5));
    await importer.runOnce(); expect(sink.events.size).toBe(1);
    appendFileSync(rollout, next.slice(-5));
    await new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink).runOnce();
    expect([...sink.events.values()].map(row => row.tokens?.total)).toEqual([7, 5]);
    const current = readFileSync(rollout, "utf8");
    writeFileSync(rollout, current.replaceAll('"total_tokens":7', '"total_tokens":9'));
    await importer.runOnce();
    expect([...sink.events.values()].map(row => row.tokens?.total)).toEqual([9, 3]);
  });

  test("reports unavailable sources without creating source files and flags unknown dates and damaged lines", async () => {
    const dir = temp(); const sink = memorySink(); const missing = join(dir, "opencode.db");
    const importer = new UsageImporter({ opencodePath: missing, codexHome: dir }, sink);
    expect((await importer.runOnce()).map(row => row.state)).toEqual(["unavailable", "unavailable"]);
    expect(() => readFileSync(missing)).toThrow();
    const { db } = codexDatabase(dir); const rollout = join(dir, "session.jsonl"); insertThread(db, "cli", rollout); db.close();
    writeFileSync(rollout, "bad json\n" + event("response_item", { text: "x".repeat(2 * 1024 * 1024) }) + event("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 42 } } }, null));
    const status = await importer.runOnce();
    expect(status.find(row => row.source === "codex")?.skipped).toBe(2);
    expect([...sink.events.values()]).toHaveLength(1);
    expect([...sink.events.values()][0]).toMatchObject({ at: null, model: null, incomplete: true, tokens: { total: 42 } });
  });

  test("keeps an initial cumulative backlog undated while dating only the confirmed last request", async () => {
    const dir = temp(); const { db } = codexDatabase(dir); const rollout = join(dir, "session.jsonl"); const sink = memorySink();
    insertThread(db, "cli", rollout); db.close();
    writeFileSync(rollout, event("turn_context", { model: "actual-model", model_provider: "openai" }) + event("event_msg", { type: "token_count", info: { total_token_usage: counter(120, 100, 20), last_token_usage: counter(12, 10, 2) } }));
    await new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink).runOnce();
    const rows = [...sink.events.values()];
    expect(rows.filter(row => row.at === at).reduce((sum, row) => sum + (row.tokens?.total ?? 0), 0)).toBe(12);
    expect(rows.find(row => row.at === null)).toMatchObject({ model: null, incomplete: true, tokens: { total: 108 } });
  });

  test("uses the board Codex agent for main usage, turns and undated backlog", async () => {
    const dir = temp(); const { db } = codexDatabase(dir); const rollout = join(dir, "session.jsonl"); const sink = memorySink();
    insertThread(db, "cli", rollout); db.close();
    writeFileSync(rollout, event("event_msg", { type: "task_started", turn_id: "turn" }) + event("event_msg", { type: "token_count", info: { total_token_usage: counter(120, 100, 20), last_token_usage: counter(12, 10, 2) } }));
    await new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink).runOnce();
    const rows = [...sink.events.values()];
    expect(rows.find(row => row.kind === "turn")?.agent).toBe("Codex");
    expect(rows.find(row => row.kind === "usage" && row.at === at)?.agent).toBe("Codex");
    expect(rows.find(row => row.kind === "usage" && row.at === null)?.agent).toBe("Codex");
  });

  test("rebuilds pre-attribution Codex checkpoints so previously indexed usage joins the agent filter", async () => {
    const dir = temp(); const { db } = codexDatabase(dir); const rollout = join(dir, "session.jsonl"); const sink = memorySink();
    insertThread(db, "cli", rollout); db.close(); writeFileSync(rollout, usage(counter(15, 10, 5)));
    const options = { opencodePath: join(dir, "missing"), codexHome: dir };
    await new UsageImporter(options, sink).runOnce();
    for (const row of sink.events.values()) row.agent = null;
    const key = "codex:journal:cli"; sink.checkpoints.set(key, { ...sink.checkpoints.get(key) as object, version: 2 });
    await new UsageImporter(options, sink).runOnce();
    expect([...sink.events.values()].map(row => row.agent)).toEqual(["Codex"]);
  });

  test("detects an overwritten middle of a growing journal instead of treating it as an append", async () => {
    const dir = temp(); const { db } = codexDatabase(dir); const rollout = join(dir, "session.jsonl"); const sink = memorySink();
    insertThread(db, "cli", rollout); db.close();
    const padding = event("response_item", { text: "x".repeat(10_000) });
    writeFileSync(rollout, padding + usage(counter(20, 15, 5)) + padding);
    const importer = new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink); await importer.runOnce();
    const old = readFileSync(rollout, "utf8");
    writeFileSync(rollout, old.replaceAll('"total_tokens":20', '"total_tokens":25') + usage(counter(30, 20, 10), at + 1));
    await importer.runOnce();
    expect([...sink.events.values()].map(row => row.tokens?.total)).toEqual([25, 5]);
  });

  test("excludes journal-declared Codex subagents even when metadata resembles a CLI thread", async () => {
    const dir = temp(); const { db } = codexDatabase(dir); const rollout = join(dir, "session.jsonl"); const sink = memorySink();
    insertThread(db, "agent", rollout); db.close();
    writeFileSync(rollout, event("session_meta", { source: { subagent: { thread_spawn: { parent_thread_id: "root" } } } }) + usage(counter(15, 10, 5)));
    await new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink).runOnce();
    expect(sink.sessions.size).toBe(0); expect(sink.events.size).toBe(0);
  });

  test("preserves the recorded model on OpenCode user turns and zero-usage completed calls", async () => {
    const dir = temp(); const { db, path } = opencodeDatabase(dir); const sink = memorySink();
    db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("root", null, "/project", "Root", at, at, null);
    db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("turn", "root", at, at, JSON.stringify({ role: "user", agent: "build", model: { providerID: "actual-provider", modelID: "actual-model" }, time: { created: at } }));
    db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("response", "root", at + 1, at + 1, JSON.stringify({ role: "assistant", agent: "build", providerID: "actual-provider", modelID: "actual-model", tokens: { total: 0, input: 0, output: 0 }, time: { completed: at + 1 } })); db.close();
    await new UsageImporter({ opencodePath: path, codexHome: join(dir, "missing") }, sink).runOnce();
    expect(sink.events.get("opencode:message:turn")?.model).toBe("actual-provider/actual-model");
    expect(sink.events.get("opencode:message:response")).toMatchObject({ kind: "usage", tokens: { total: 0 } });
  });

  test("retains known completed OpenCode calls and costs even when token usage is missing", async () => {
    const dir = temp(); const { db, path } = opencodeDatabase(dir); const sink = memorySink();
    db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("root", null, "/project", "Root", at, at, null);
    db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("response", "root", at, at, JSON.stringify({ role: "assistant", modelID: "actual-model", cost: 0.5, time: { completed: at } })); db.close();
    await new UsageImporter({ opencodePath: path, codexHome: join(dir, "missing") }, sink).runOnce();
    expect(sink.events.get("opencode:message:response")).toMatchObject({ kind: "usage", cost: 0.5, tokens: null, incomplete: true });
  });

  test("accepts legacy Codex metadata without originator and isolates an unsupported OpenCode schema", async () => {
    const dir = temp(); const sink = memorySink(); const rollout = join(dir, "session.jsonl"); const codex = new Database(join(dir, "state_4.sqlite"));
    codex.exec("CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,title TEXT,source TEXT,rollout_path TEXT,updated_at INTEGER)");
    codex.query("INSERT INTO threads VALUES (?,?,?,?,?,?)").run("cli", "/project", "Legacy", "cli", rollout, at / 1000);
    codex.query("INSERT INTO threads VALUES (?,?,?,?,?,?)").run("app", "/project", "App", "vscode", rollout, at / 1000); codex.close();
    writeFileSync(rollout, usage(counter(15, 10, 5)));
    const path = join(dir, "opencode.db"); const opencode = new Database(path); opencode.exec("CREATE TABLE session (id TEXT)"); opencode.close();
    const statuses = await new UsageImporter({ opencodePath: path, codexHome: dir }, sink).runOnce();
    expect(statuses.map(row => row.state)).toEqual(["unavailable", "ready"]);
    expect([...sink.sessions.keys()]).toEqual(["codex:cli"]);
    expect([...sink.events.values()].map(row => row.tokens?.total)).toEqual([15]);
  });

  test("stops OpenCode between message pages without further sink writes and permits a fresh importer to resume", async () => {
    const dir = temp(); const { db, path } = opencodeDatabase(dir); const sink = memorySink();
    db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("root", null, "/project", "Root", at, at, null);
    const insert = db.query("INSERT INTO message VALUES (?,?,?,?,?)");
    db.transaction(() => { for (let i = 0; i < 600; i++) insert.run(`m${i}`, "root", at + i, at + i, JSON.stringify({ role: "assistant", time: { completed: at + i }, tokens: { total: 1 } })); })(); db.close();
    const importer = new UsageImporter({ opencodePath: path, codexHome: dir }, sink);
    const upsert = sink.upsertEvents; let stopped = false;
    sink.upsertEvents = (id, events) => {
      expect(stopped).toBe(false); upsert(id, events);
      setTimeout(() => { stopped = true; (importer as UsageImporter & { stop?: () => void }).stop?.(); }, 0);
    };
    const statuses = await importer.runOnce();
    expect(sink.events.size).toBe(250);
    expect(statuses.find(row => row.source === "opencode")?.state).not.toBe("unavailable");
    sink.upsertEvents = upsert;
    await new UsageImporter({ opencodePath: path, codexHome: join(dir, "missing") }, sink).runOnce();
    expect(sink.events.size).toBe(600);
  });

  test("stops Codex after a committed chunk and resumes using durable counters without double counting", async () => {
    const dir = temp(); const { db } = codexDatabase(dir); const rollout = join(dir, "session.jsonl"); const sink = memorySink();
    insertThread(db, "cli", rollout); db.close();
    const padding = event("response_item", { text: "x".repeat(700_000) });
    writeFileSync(rollout, usage(counter(20, 15, 5)) + padding.repeat(7) + usage(counter(30, 20, 10), at + 1));
    const importer = new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink);
    const set = sink.setCheckpoint; let stopped = false;
    sink.setCheckpoint = (key, value) => { expect(stopped).toBe(false); set(key, value); stopped = true; (importer as UsageImporter & { stop?: () => void }).stop?.(); };
    const statuses = await importer.runOnce();
    expect([...sink.events.values()].map(row => row.tokens?.total)).toEqual([20]);
    expect(statuses.find(row => row.source === "codex")?.state).not.toBe("unavailable");
    sink.setCheckpoint = set;
    await new UsageImporter({ opencodePath: join(dir, "missing"), codexHome: dir }, sink).runOnce();
    expect([...sink.events.values()].map(row => row.tokens?.total)).toEqual([20, 10]);
  });

  test("reimports an earlier streaming message updated below the session maximum timestamp", async () => {
    const dir = temp(); const { db, path } = opencodeDatabase(dir); const sink = memorySink();
    db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("root", null, "/project", "Root", at, at, null);
    db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("stream", "root", at, at, JSON.stringify({ role: "assistant", tokens: { total: 1 } }));
    db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("later", "root", at + 100, at + 100, JSON.stringify({ role: "assistant", time: { completed: at + 100 }, tokens: { total: 2 } })); db.close();
    const importer = new UsageImporter({ opencodePath: path, codexHome: join(dir, "missing") }, sink); await importer.runOnce();
    const writer = new Database(path); writer.query("UPDATE message SET data=?,time_updated=? WHERE id='stream'").run(JSON.stringify({ role: "assistant", time: { completed: at + 50 }, tokens: { total: 5 } }), at + 50); writer.close();
    await importer.runOnce();
    expect(sink.events.get("opencode:message:stream")).toMatchObject({ at: at + 50, tokens: { total: 5 } });
  });

  test("rebuilds OpenCode events when the source database is replaced while metadata revisions remain unchanged", async () => {
    const dir = temp(); const { db, path } = opencodeDatabase(dir); const sink = memorySink();
    db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("root", null, "/project", "Root", at, at, null);
    db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("response", "root", at, at, JSON.stringify({ role: "assistant", time: { completed: at }, tokens: { total: 1 } })); db.close();
    const importer = new UsageImporter({ opencodePath: path, codexHome: join(dir, "missing") }, sink); await importer.runOnce();
    const replacement = opencodeDatabase(temp()); replacement.db.query("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("root", null, "/project", "Root", at, at, null);
    replacement.db.query("INSERT INTO message VALUES (?,?,?,?,?)").run("response", "root", at, at, JSON.stringify({ role: "assistant", time: { completed: at }, tokens: { total: 9 } })); replacement.db.close(); renameSync(replacement.path, path);
    await importer.runOnce();
    expect(sink.events.get("opencode:message:response")?.tokens?.total).toBe(9);
  });
});
