/**
 * fs.watch on the OpenCode DB (preferring -wal) and Hermes instances directory.
 * Emits "db" and "hermes" events (debounced); never reads or writes their contents.
 */
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { EventEmitter } from "node:events";
import { getDbPath } from "./storage/db";
import { hermesInstancesDir } from "./liveness";
import { HERMES_DEBOUNCE_MS, WATCH_DEBOUNCE_MS } from "@shared/constants";

export interface CombinedEvent {
  source: "db" | "hermes" | "codex";
}

export class Watcher extends EventEmitter {
  private dbWatcher: FSWatcher | null = null;
  private hermesWatcher: FSWatcher | null = null;
  private dbDebounce: Timer | null = null;
  private hermesDebounce: Timer | null = null;
  private rebindTimer: Timer | null = null;
  private readonly dbPath: string;
  private readonly walPath: string;
  private readonly hermesDir: string;
  private dbWatcherTarget: string | null = null;
  private hermesWatcherTarget: string | null = null;
  private running = false;
  private codexWatchers = new Map<string, { watcher: FSWatcher; ino: number }>();
  private codexDebounce: Timer | null = null;

  constructor(dbPath?: string, hermesDir?: string, private readonly codexPaths: () => string[] = () => []) {
    super();
    this.dbPath = dbPath ?? getDbPath();
    this.walPath = `${this.dbPath}-wal`;
    this.hermesDir = hermesDir ?? hermesInstancesDir();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rebindDbWatcher();
    this.rebindHermesWatcher();
    this.rebindCodexWatchers();
    this.rebindTimer = setInterval(() => {
      this.rebindDbWatcher();
      this.rebindHermesWatcher();
      this.rebindCodexWatchers();
    }, 100);
    this.emit("started");
  }

  stop(): void {
    if (!this.running) return;
    if (this.dbDebounce) clearTimeout(this.dbDebounce);
    if (this.hermesDebounce) clearTimeout(this.hermesDebounce);
    if (this.codexDebounce) clearTimeout(this.codexDebounce);
    this.codexDebounce = null;
    for (const { watcher } of this.codexWatchers.values()) watcher.close();
    this.codexWatchers.clear();
    if (this.rebindTimer) clearInterval(this.rebindTimer);
    this.dbDebounce = null;
    this.hermesDebounce = null;
    this.rebindTimer = null;
    this.dbWatcher?.close();
    this.hermesWatcher?.close();
    this.dbWatcher = null;
    this.hermesWatcher = null;
    this.dbWatcherTarget = null;
    this.hermesWatcherTarget = null;
    this.running = false;
    this.emit("stopped");
  }

  private emitDebounced(source: CombinedEvent["source"], delay: number): void {
    const timer = source === "db" ? this.dbDebounce : source === "hermes" ? this.hermesDebounce : this.codexDebounce;
    if (timer) clearTimeout(timer);
    const handle = setTimeout(() => {
      this.emit("change", { source } satisfies CombinedEvent);
      if (source === "db") this.dbDebounce = null;
      else if (source === "hermes") this.hermesDebounce = null;
      else this.codexDebounce = null;
    }, delay);
    if (source === "db") this.dbDebounce = handle;
    else if (source === "hermes") this.hermesDebounce = handle;
    else this.codexDebounce = handle;
  }

  private rebindCodexWatchers(): void {
    const targets = new Set(this.codexPaths());
    for (const [path, entry] of this.codexWatchers) {
      let same = false;
      try { same = targets.has(path) && statSync(path).ino === entry.ino; } catch { /* removed */ }
      if (!same) { entry.watcher.close(); this.codexWatchers.delete(path); }
    }
    for (const path of targets) {
      if (this.codexWatchers.has(path)) continue;
      try {
        const ino = statSync(path).ino;
        const watcher = watch(path, () => this.emitDebounced("codex", WATCH_DEBOUNCE_MS));
        watcher.on("error", () => { watcher.close(); this.codexWatchers.delete(path); });
        this.codexWatchers.set(path, { watcher, ino });
      } catch { /* polling discovers files that appear later */ }
    }
  }

  private preferredDbTarget(): string | null {
    if (existsSync(this.walPath)) return this.walPath;
    if (existsSync(this.dbPath)) return this.dbPath;
    return null;
  }

  private rebindDbWatcher(): void {
    const target = this.preferredDbTarget();
    if (this.dbWatcher && this.dbWatcherTarget === target) return;
    if (this.dbWatcher) {
      this.dbWatcher.close();
      this.dbWatcher = null;
      this.dbWatcherTarget = null;
    }
    if (!target) return;
    try {
      this.dbWatcher = watch(target, (eventType) => {
        this.emitDebounced("db", WATCH_DEBOUNCE_MS);
        if (eventType === "rename") this.rebindDbWatcher();
      });
      this.dbWatcherTarget = target;
    } catch {
      this.dbWatcherTarget = null;
    }
  }

  private rebindHermesWatcher(): void {
    let target: string | null = null;
    try {
      if (existsSync(this.hermesDir)) target = this.hermesDir;
    } catch {
      target = null;
    }
    if (this.hermesWatcher && this.hermesWatcherTarget === target) return;
    if (this.hermesWatcher) {
      this.hermesWatcher.close();
      this.hermesWatcher = null;
      this.hermesWatcherTarget = null;
    }
    if (!target) return;
    try {
      this.hermesWatcher = watch(target, (eventType, filename) => {
        if (filename && !filename.endsWith(".json")) return;
        this.emitDebounced("hermes", HERMES_DEBOUNCE_MS);
        if (eventType === "rename") this.rebindHermesWatcher();
      });
      this.hermesWatcherTarget = target;
    } catch {
      this.hermesWatcherTarget = null;
    }
  }
}

export function describeTarget(path: string): string {
  return basename(path);
}
