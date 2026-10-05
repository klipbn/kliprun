/**
 * Board assembly pipeline: liveness + DB reads + classifier + history + cache.
 * Single instance per server process. All OpenCode access is read-only.
 */
import { BOARD_CACHE_TTL_MS, LIVENESS_INTERVAL_MS } from "@shared/constants";
import type { BoardPayload, KanbanInterval, SessionDetailPayload } from "@shared/types";
import { Engine } from "./classifier";
import { StatusHistoryStore } from "./history";
import { openTuiSessions, type TuiLiveness } from "./liveness";
import { querySession } from "./storage/queries";
import { branchOf } from "./vcs";
import { sessionMrLinks } from "./mergeRequests";

interface BoardCacheEntry {
  data: BoardPayload;
  etag: string;
  livenessAt: number;
}

export interface BoardResult {
  data: BoardPayload;
  etag: string;
  notModified: boolean;
}

export class BoardService {
  readonly engine = new Engine();
  readonly history = new StatusHistoryStore();
  private cache: BoardCacheEntry | null = null;
  private building = false;
  private livenessTimer: Timer | null = null;
  private lastLiveness: TuiLiveness | null = null;
  private livenessChanged = false;
  readonly startedAt = Date.now();

  start(): void {
    if (this.livenessTimer) return;
    void this.refreshLiveness();
    this.livenessTimer = setInterval(() => {
      void this.refreshLiveness();
    }, LIVENESS_INTERVAL_MS);
  }

  stop(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.history.closeOpenIntervals();
    this.history.close();
  }

  private async refreshLiveness(): Promise<void> {
    try {
      const liveness = await openTuiSessions();
      this.lastLiveness = liveness;
      const changed = this.engine.setTuiLiveness(liveness);
      if (changed) {
        this.livenessChanged = true;
        this.cache = null;
      }
    } catch (error) {
      console.warn("[board] liveness scan failed:", error instanceof Error ? error.message : error);
    }
  }

  /** Hermes watcher fast-path: refresh liveness immediately on fs events. */
  refreshLivenessNow(): void {
    void this.refreshLiveness();
  }

  invalidate(): void {
    this.cache = null;
  }

  getLivenessAge(): number {
    return this.lastLiveness ? Date.now() - this.startedAt : -1;
  }

  tuiCount(): number {
    return this.lastLiveness?.directories.size ?? 0;
  }

  getBoard(ifNoneMatch?: string | null): BoardResult {
    const now = Date.now();
    if (!this.cache || now - this.cache.livenessAt >= BOARD_CACHE_TTL_MS || this.livenessChanged) {
      this.buildBoard(now);
    }
    const cache = this.cache;
    if (!cache) {
      const empty = this.engine.board(now);
      return { data: empty, etag: `"empty"`, notModified: false };
    }
    if (ifNoneMatch && ifNoneMatch === cache.etag) {
      return { data: cache.data, etag: cache.etag, notModified: true };
    }
    return { data: cache.data, etag: cache.etag, notModified: false };
  }

  private buildBoard(now: number): void {
    if (this.building) return;
    this.building = true;
    try {
      this.engine.rebuild(now);
      this.history.record(this.engine.historyCards(), now);
      const data = this.engine.board(now);
      const etag = `"${this.engine.revision()}"`;
      this.cache = { data, etag, livenessAt: now };
      this.livenessChanged = false;
    } catch (error) {
      console.warn("[board] rebuild failed:", error instanceof Error ? error.message : error);
    } finally {
      this.building = false;
    }
  }

  getSessionDetail(sessionId: string): SessionDetailPayload {
    const row = querySession(sessionId);
    const directory = this.engine.sessionDirectory(sessionId) ?? row?.directory ?? "";
    if (!row) {
      return {
        session_id: sessionId,
        title: "",
        directory,
        branch: null,
        mrs: [],
        messages: [],
        models: [],
        kanban_history: [],
        exists: false,
      };
    }
    const detail = this.engine.detail(sessionId);
    const kanbanHistory: KanbanInterval[] = this.history.get(sessionId, Date.now());
    return {
      session_id: sessionId,
      title: row.title,
      directory,
      branch: branchOf(directory),
      mrs: sessionMrLinks(sessionId),
      messages: detail.messages,
      models: detail.models,
      kanban_history: kanbanHistory,
      exists: true,
    };
  }
}
