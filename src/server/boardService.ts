/**
 * Board assembly pipeline: liveness + DB reads + classifier + history + cache.
 * Single instance per server process. All OpenCode access is read-only.
 */
import { BOARD_CACHE_TTL_MS, LIVENESS_INTERVAL_MS } from "@shared/constants";
import { createHash } from "node:crypto";
import { COLUMNS, type BoardPayload, type CardPayload, type KanbanInterval, type SessionDetailPayload } from "@shared/types";
import { Engine } from "./classifier";
import { StatusHistoryStore } from "./history";
import { openTuiSessions, type TuiLiveness } from "./liveness";
import { querySession } from "./storage/queries";
import { branchOf } from "./vcs";
import { sessionMrLinks } from "./mergeRequests";
import { CodexAdapter } from "./codex/adapter";
import { scanCodexCli } from "./codex/liveness";

type BoardEngine = Pick<Engine, "rebuild" | "board" | "historyCards" | "setTuiLiveness" | "sessionDirectory" | "detail">;

/** Merge visible trees without changing either source's cached payload. */
function combineBoard(board: BoardPayload, codex: CardPayload[], now: number): BoardPayload {
  const columns = { ...board.columns };
  const visible: CardPayload[] = [];
  const visit = (card: CardPayload) => { visible.push(card); card.children.forEach(visit); };
  for (const key of COLUMNS) {
    const cards = [...board.columns[key].cards, ...codex.filter(card => card.column === key)];
    cards.sort(key === "attention" ? (a, b) => a.stage_since - b.stage_since
      : key === "running" ? (a, b) => b.last_event_at - a.last_event_at
      : (a, b) => (b.finished_at ?? b.stage_since) - (a.finished_at ?? a.stage_since));
    const before = visible.length;
    cards.forEach(visit);
    columns[key] = { ...board.columns[key], cards, count: visible.length - before };
  }
  const names = new Map<string, boolean>();
  for (const card of visible) if (card.agent) names.set(card.agent.name, (names.get(card.agent.name) ?? false) || card.column !== "idle");
  const agents = [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, working]) => ({ name, working, on_board: true }));
  return { columns, agents, agent_stats: { working: agents.filter(a => a.working).length, resting: agents.filter(a => !a.working).length },
    project_count: new Set(visible.map(card => card.directory)).size, generated_at: now };
}

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
  readonly engine: BoardEngine;
  readonly history: StatusHistoryStore;
  readonly codex: CodexAdapter;
  private cache: BoardCacheEntry | null = null;
  private building = false;
  private livenessTimer: Timer | null = null;
  private lastLiveness: TuiLiveness | null = null;
  private livenessChanged = false;
  private scanning = false;
  private stopped = false;
  private codexScanError: string | null = null;
  readonly startedAt = Date.now();

  constructor(options: { engine?: BoardEngine; history?: StatusHistoryStore; codex?: CodexAdapter } = {}) {
    this.engine = options.engine ?? new Engine();
    this.history = options.history ?? new StatusHistoryStore();
    this.codex = options.codex ?? new CodexAdapter();
  }

  start(): void {
    if (this.livenessTimer) return;
    void this.refreshLiveness();
    this.livenessTimer = setInterval(() => {
      void this.refreshLiveness();
    }, LIVENESS_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.history.closeOpenIntervals();
    this.history.close();
    this.codex.close();
  }

  private async refreshLiveness(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      const [openCode, codex] = await Promise.allSettled([openTuiSessions(), scanCodexCli()]);
      if (this.stopped) return;
      if (codex.status === "fulfilled") {
        this.codex.setProcesses(codex.value);
        this.codexScanError = null;
      } else {
        this.codex.setProcesses([]);
        this.codexScanError = "Codex CLI process scan unavailable";
      }
      this.cache = null;
      if (openCode.status !== "fulfilled") return;
      const liveness = openCode.value;
      this.lastLiveness = liveness;
      const changed = this.engine.setTuiLiveness(liveness);
      if (changed) {
        this.livenessChanged = true;
        this.cache = null;
      }
    } catch (error) {
      console.warn("[board] liveness scan failed:", error instanceof Error ? error.message : error);
    } finally { this.scanning = false; }
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

  codexDiagnostics(): string[] {
    return [...(this.codexScanError ? [this.codexScanError] : []), ...this.codex.diagnostics];
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
      try { this.engine.rebuild(now); } catch (error) {
        console.warn("[board] OpenCode rebuild failed:", error instanceof Error ? error.message : error);
      }
      const codex = this.codex.cards(now);
      this.history.record([...this.engine.historyCards(), ...codex.map(card => ({ sessionId: card.session_id, directory: card.directory, column: card.column }))], now);
      const data = combineBoard(this.engine.board(now), codex, now);
      const etag = `"${createHash("sha1").update(JSON.stringify({ ...data, generated_at: 0 })).digest("hex").slice(0, 16)}"`;
      this.cache = { data, etag, livenessAt: now };
      this.livenessChanged = false;
    } catch (error) {
      console.warn("[board] rebuild failed:", error instanceof Error ? error.message : error);
    } finally {
      this.building = false;
    }
  }

  getSessionDetail(sessionId: string): SessionDetailPayload {
    if (sessionId.startsWith("codex:")) {
      this.getBoard();
      const detail = this.codex.detail(sessionId, Date.now());
      return { ...detail, kanban_history: this.history.get(sessionId, Date.now()) };
    }
    const row = querySession(sessionId);
    const directory = this.engine.sessionDirectory(sessionId) ?? row?.directory ?? "";
    if (!row) {
      return {
        source: "opencode",
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
      source: "opencode",
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
