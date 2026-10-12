import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Watcher } from "../watcher";

test("Codex rollout writes emit a debounced board update", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kliprun-watch-"));
  const path = join(dir, "rollout-test.jsonl");
  writeFileSync(path, "");
  const watcher = new Watcher(join(dir, "missing.db"), join(dir, "missing-hermes"), () => [path]);
  let timeout: Timer | undefined;
  try {
    watcher.start();
    const changed = new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("No Codex change event")), 2000);
      watcher.on("change", event => resolve(event.source));
    });
    appendFileSync(path, "{}\n");
    expect(await changed).toBe("codex");
  } finally {
    clearTimeout(timeout); watcher.stop(); rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic Hermes status replacement emits a Codex update even without journal writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kliprun-watch-hermes-"));
  const sessions = join(dir, "sessions");
  mkdirSync(sessions);
  const path = join(sessions, "session.json");
  writeFileSync(path, JSON.stringify({ status: "busy" }));
  const watcher = new Watcher(join(dir, "missing.db"), join(dir, "missing-hermes"), () => [sessions]);
  let timeout: Timer | undefined;
  try {
    watcher.start();
    const changed = new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("No Hermes status change event")), 2000);
      watcher.on("change", event => resolve(event.source));
    });
    const temporary = join(sessions, "session.tmp");
    writeFileSync(temporary, JSON.stringify({ status: "waiting" }));
    renameSync(temporary, path);
    expect(await changed).toBe("codex");
  } finally {
    clearTimeout(timeout); watcher.stop(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex writes are detected even when the native watcher misses an event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kliprun-watch-missed-"));
  const path = join(dir, "rollout-test.jsonl");
  writeFileSync(path, "");
  const watcher = new Watcher(join(dir, "missing.db"), join(dir, "missing-hermes"), () => [path]);
  let timeout: Timer | undefined;
  try {
    watcher.start();
    // Fault injection: stop native notifications without changing the watched file.
    const native = (watcher as unknown as { codexWatchers: Map<string, { watcher: FSWatcher }> }).codexWatchers.get(path)!;
    native.watcher.close();
    const changed = new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Missed event was not recovered")), 2000);
      watcher.on("change", event => resolve(event.source));
    });
    appendFileSync(path, "{}\n");
    expect(await changed).toBe("codex");
  } finally {
    clearTimeout(timeout); watcher.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
