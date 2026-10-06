import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
