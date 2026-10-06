import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../codex/adapter";
import { parseCliProcesses, parseDaemonProcesses, parseCodexFiles, matchCliSessions, type CliProcess } from "../codex/liveness";
import { RolloutReader } from "../codex/rollout";
import { CodexStorage, type CodexThread } from "../codex/storage";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "kliprun-codex-")); dirs.push(dir); return dir; }
const id = "01900000-0000-7000-8000-000000000001";
const t = 1_800_000_000_000;
function event(type: string, payload: Record<string, unknown>, at = t) {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + "\n";
}
function thread(overrides: Partial<CodexThread> = {}): CodexThread {
  return { id, cwd: "/project", title: "CLI task", source: "cli", rollout_path: `/logs/rollout-${overrides.id ?? id}.jsonl`,
    updated_at: t / 1000, model: null, ...overrides };
}
function cli(pid = "10"): CliProcess { return { pid, cwd: "/project", rollouts: [] }; }

describe("Codex CLI membership", () => {
  test("selects the single daemon-loaded CLI session instead of hiding a resumed window", () => {
    const process = { ...cli(), daemonSessionIds: [id] };
    const candidates = [thread({ id: "old", updated_at: t + 100 }), thread()];
    expect(matchCliSessions([process], candidates).threads.map(row => row.id)).toEqual([id]);
    expect(matchCliSessions([cli()], candidates).threads).toEqual([]);
    expect(matchCliSessions([{ ...process, daemonSessionIds: ["old", id] }], candidates).threads).toEqual([]);
    expect(matchCliSessions([process, { ...process, pid: "11" }], candidates).threads).toEqual([]);
    expect(matchCliSessions([process], [thread({ source: "vscode", originator: "codex-desktop" }), candidates[0], thread({ id: "older" })]).threads).toEqual([]);
  });
  test("an exact CLI writer file takes precedence over shared-daemon candidates", () => {
    const process = { ...cli(), writerSessionIds: [id], daemonSessionIds: ["other"] };
    expect(matchCliSessions([process, cli("11")], [thread(), thread({ id: "other" })]).threads.map(row => row.id)).toEqual([id]);
  });
  test("uses only live Codex owners and the configured home's writer files", () => {
    const ps = "10 ttys001 /opt/codex resume\n20 ?? /opt/codex app-server --listen unix:// --managed-daemon\n21 ?? /opt/codex app-server --listen stdio://\n22 ?? /opt/other app-server --managed-daemon\n";
    expect(parseDaemonProcesses(ps)).toEqual(["20"]);
    const files = `p10\nfcwd\nn/project\np20\nf31\nn/codex-home/thread-writer-locks/${id}.lock\nf32\nn/another-home/thread-writer-locks/01900000-0000-7000-8000-000000000002.lock\np22\nf1\nn/codex-home/thread-writer-locks/01900000-0000-7000-8000-000000000003.lock\n`;
    const processes = parseCodexFiles(files, ["10"], ["20"], "/codex-home");
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ pid: "10", daemonSessionIds: [id] });
    expect(parseCodexFiles("p10\nfcwd\nn/project\n", ["10"], ["20"], "/codex-home")[0].daemonSessionIds).toEqual([]);
  });
  test("recognizes daemon-backed TUI sessions without treating desktop sessions as CLI", () => {
    const tui = thread({ source: "vscode", originator: "codex-tui" });
    expect(matchCliSessions([cli()], [tui]).threads.map(row => row.id)).toEqual([id]);
    expect(matchCliSessions([cli()], [thread({ source: "vscode", originator: "codex-desktop" })]).threads).toEqual([]);
    expect(matchCliSessions([cli()], [tui, thread({ id: "second", source: "vscode", originator: "codex-tui" })]).threads).toEqual([]);
  });
  test("excludes daemons, exec, other programs and processes without a terminal", () => {
    const ps = "10 ttys001 /opt/bin/codex --model test\n11 ?? /opt/bin/codex app-server\n12 ttys002 /opt/bin/codex exec hi\n13 ttys003 /opt/bin/opencode\n14 ttys004 /opt/bin/codex resume --last\n15 ttys005 /opt/bin/codex --config x=y mcp-server\n";
    expect(parseCliProcesses(ps)).toEqual(["10", "14"]);
  });
  test("matches the open rollout, not the latest unrelated session in the directory", () => {
    const process = { ...cli(), rollouts: [thread().rollout_path] };
    const result = matchCliSessions([process], [thread(), thread({ id: "other", updated_at: t })]);
    expect(result.threads.map(x => x.id)).toEqual([id]);
  });
  test("uses only an unambiguous CLI fallback; rejects app sessions and duplicate terminals", () => {
    expect(matchCliSessions([cli()], [thread()]).threads).toHaveLength(1);
    expect(matchCliSessions([cli()], [thread({ source: "vscode" })]).threads).toHaveLength(0);
    const ambiguous = matchCliSessions([cli()], [thread(), thread({ id: "other" })]);
    expect(ambiguous.threads).toHaveLength(0);
    expect(ambiguous.diagnostics.length).toBeGreaterThan(0);
    expect(matchCliSessions([cli(), cli("11")], [thread()]).threads).toHaveLength(0);
    expect(matchCliSessions([], [thread()]).threads).toHaveLength(0);
  });
});

describe("Codex rollout state", () => {
  test("bounds initial history and skips oversized JSON records while keeping later events", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, event("response_item", { type: "message", role: "assistant", content: [{ text: "x".repeat(5 * 1024 * 1024) }] }) +
      event("event_msg", { type: "task_started", turn_id: "new" }) +
      event("event_msg", { type: "task_complete", turn_id: "old" }));
    expect(new RolloutReader().read(path, t)).toMatchObject({ column: "running", messages: [], finishedAt: null });
  });
  test("does not reuse the previous model's context bar when the model changes", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, event("turn_context", { model: "first" }) +
      event("event_msg", { type: "token_count", info: { model_context_window: 10000, last_token_usage: { total_tokens: 2500 } } }));
    const reader = new RolloutReader();
    expect(reader.read(path, t).context?.model).toBe("first");
    appendFileSync(path, event("turn_context", { model: "second" }, t + 1));
    expect(reader.read(path, t + 1).context).toBeNull();
  });
  test("confirmed unanswered questions remain attention even after a long wait", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, event("event_msg", { type: "task_started" }) + event("response_item", { type: "function_call", name: "request_user_input", call_id: "q" }));
    expect(new RolloutReader().read(path, t + 60 * 60_000).column).toBe("attention");
  });
  test("tracks start, confirmed question, answer, completion and interruption incrementally", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, event("event_msg", { type: "task_started", turn_id: "a" }));
    const reader = new RolloutReader();
    expect(reader.read(path, t).column).toBe("running");
    appendFileSync(path, event("response_item", { type: "function_call", name: "request_user_input", call_id: "q" }, t + 1));
    expect(reader.read(path, t + 1).column).toBe("attention");
    appendFileSync(path, event("response_item", { type: "function_call_output", call_id: "q", output: "ok" }, t + 2));
    expect(reader.read(path, t + 2).column).toBe("running");
    appendFileSync(path, event("event_msg", { type: "task_complete", turn_id: "a" }, t + 3));
    expect(reader.read(path, t + 3)).toMatchObject({ column: "idle", stage: "Finished", finishedAt: t + 3 });
    appendFileSync(path, event("event_msg", { type: "task_started", turn_id: "b" }, t + 4) + event("event_msg", { type: "turn_aborted", turn_id: "b" }, t + 5));
    expect(reader.read(path, t + 5)).toMatchObject({ column: "idle", stage: "Interrupted", finishedAt: null });
  });
  test("does not infer completion or permission waiting from silence or a pending command", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, event("event_msg", { type: "task_started" }) + event("response_item", { type: "function_call", name: "exec_command", call_id: "cmd" }));
    const reader = new RolloutReader();
    expect(reader.read(path, t).column).toBe("running");
    expect(reader.read(path, t + 16 * 60_000)).toMatchObject({ column: "idle", stage: "Status unknown", finishedAt: null });
  });
  test("handles incomplete writes, malformed JSON and truncation without replaying messages", () => {
    const path = join(temp(), "session.jsonl");
    const line = event("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] });
    writeFileSync(path, "bad JSON\n" + line.slice(0, -2));
    const reader = new RolloutReader();
    expect(reader.read(path, t).messages).toHaveLength(0);
    appendFileSync(path, line.slice(-2));
    expect(reader.read(path, t).messages).toHaveLength(1);
    expect(reader.read(path, t).messages).toHaveLength(1);
    writeFileSync(path, event("event_msg", { type: "task_started" }));
    expect(reader.read(path, t)).toMatchObject({ column: "running", messages: [] });
  });
  test("uses explicit context usage and scrubs message secrets", () => {
    const path = join(temp(), "session.jsonl");
    writeFileSync(path, event("turn_context", { model: "actual-model" }) +
      event("event_msg", { type: "token_count", info: { model_context_window: 10000, last_token_usage: { total_tokens: 2500 }, total_token_usage: { total_tokens: 99000 } } }) +
      event("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "token=secret-value" }] }));
    const state = new RolloutReader().read(path, t);
    expect(state.context).toEqual({ model: "actual-model", percent: 25, used: 2500, limit: 10000 });
    expect(state.messages[0].text).toBe("token=[redacted]");
    expect(state.finishedAt).toBeNull();
  });
});

function database(dir: string) {
  const path = join(dir, "state_5.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, source TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER, model TEXT)");
  db.exec("CREATE INDEX idx_threads_archived_cwd ON threads(archived, cwd)");
  return { db, path };
}

describe("Codex storage and adapter", () => {
  test("loads a writer-referenced session even when it is outside the two historical candidates", () => {
    const dir = temp(); const { db } = database(dir);
    db.exec("ALTER TABLE threads ADD COLUMN originator TEXT");
    const rollout = join(dir, "session.jsonl");
    writeFileSync(rollout, event("event_msg", { type: "task_started" }));
    for (const key of ["old-a", "old-b", id]) {
      db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)").run(key, "/project", key, "vscode", rollout, t / 1000, 0, null, "codex-tui");
    }
    db.close();
    const adapter = new CodexAdapter(dir);
    adapter.setProcesses([{ ...cli(), daemonSessionIds: [id] }]);
    expect(adapter.cards(t).map(card => card.session_id)).toEqual([`codex:${id}`]);
    expect(adapter.diagnostics).toEqual([]);
    adapter.setProcesses([cli()]);
    expect(adapter.cards(t + 1)).toEqual([]);
    adapter.close();
  });
  test("shows a daemon-backed CLI session recorded as vscode with originator codex-tui", () => {
    const dir = temp(); const { db } = database(dir);
    db.exec("ALTER TABLE threads ADD COLUMN originator TEXT");
    const rollout = join(dir, "session.jsonl");
    writeFileSync(rollout, event("event_msg", { type: "task_started" }));
    db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)").run(id, "/project", "Daemon TUI", "vscode", rollout, t / 1000, 0, "actual-model", "codex-tui");
    db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)").run("desktop", "/project", "Desktop session", "vscode", rollout, t / 1000, 0, "actual-model", "codex-desktop");
    db.close();
    const adapter = new CodexAdapter(dir); adapter.setProcesses([cli()]);
    expect(adapter.cards(t)).toMatchObject([{ session_id: `codex:${id}`, source: "codex", title: "Daemon TUI", column: "running" }]);
    expect(adapter.diagnostics).toEqual([]);
    adapter.close();
  });
  test("malformed metadata does not take down other sessions", () => {
    const dir = temp(); const { db } = database(dir);
    const rollout = join(dir, "session.jsonl");
    writeFileSync(rollout, event("event_msg", { type: "task_started" }));
    db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run(id, "/project", "healthy", "cli", rollout, t / 1000, 0, null);
    db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run("bad", "/other", null, "cli", rollout, t / 1000, 0, null);
    db.close();
    const adapter = new CodexAdapter(dir);
    adapter.setProcesses([cli(), { ...cli("11"), cwd: "/other" }]);
    expect(adapter.cards(t).map(card => card.title)).toEqual(["healthy"]);
    adapter.close();
  });
  test("reads real SQLite and rollout fixtures without changing the source database", () => {
    const dir = temp();
    const { db, path } = database(dir);
    const rollout = join(dir, `rollout-${id}.jsonl`);
    writeFileSync(rollout, event("event_msg", { type: "task_started" }));
    db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run(id, "/project", "token=secret", "cli", rollout, t / 1000, 0, "model");
    db.close();
    const before = readFileSync(path);
    const adapter = new CodexAdapter(dir);
    adapter.setProcesses([cli()]);
    const cards = adapter.cards(t);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ source: "codex", session_id: `codex:${id}`, column: "running", title: "token=[redacted]" });
    expect(adapter.detail(`codex:${id}`, t)).toMatchObject({ source: "codex", exists: true });
    adapter.setProcesses([]);
    expect(adapter.cards(t + 1)).toHaveLength(0);
    adapter.close();
    expect(readFileSync(path)).toEqual(before);
  });
  test("missing and incompatible databases produce diagnostics, not crashes or files", () => {
    const dir = temp();
    const adapter = new CodexAdapter(dir);
    adapter.setProcesses([cli()]);
    expect(adapter.cards(t)).toEqual([]);
    expect(adapter.diagnostics.length).toBeGreaterThan(0);
    const db = new Database(join(dir, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT)"); db.close();
    expect(adapter.cards(t + 1)).toEqual([]);
    expect(adapter.diagnostics.length).toBeGreaterThan(0);
    adapter.close();
  });
  test("a removed rollout becomes unknown instead of retaining its last successful status", () => {
    const dir = temp(); const { db } = database(dir);
    const rollout = join(dir, "session.jsonl");
    db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run(id, "/project", "task", "cli", rollout, t / 1000, 0, null); db.close();
    writeFileSync(rollout, event("event_msg", { type: "task_complete" }));
    const adapter = new CodexAdapter(dir); adapter.setProcesses([cli()]);
    expect(adapter.cards(t)[0].stage).toBe("Finished");
    rmSync(rollout);
    expect(adapter.cards(t + 1)[0]).toMatchObject({ stage: "Status unknown", finished_at: null });
    adapter.close();
  });
  test("fallback queries retain ambiguity rather than selecting the newest CLI thread", () => {
    const dir = temp(); const { db } = database(dir);
    for (const key of [id, "other"]) db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run(key, "/project", "task", "cli", `/logs/${key}`, 100, 0, null);
    db.close();
    const storage = new CodexStorage(dir);
    expect(storage.candidates([cli()])).toHaveLength(2);
    storage.close();
  });
});
