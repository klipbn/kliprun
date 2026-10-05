/**
 * Board state machine: DB sessions -> cards -> kanban columns.
 * Pure in-memory engine over direct opencode.db reads:
 * merges read-only DB snapshots with TUI liveness and derives for every session
 * a column, a stage and the time the stage was entered.
 */
import { createHash } from "node:crypto";
import {
  DEBOUNCE_MS,
  ERROR_MAX,
  MAX_WATCHED_DIRECTORIES,
  MESSAGE_LIMIT_PER_SESSION,
  SNIPPET_MAX,
  STALE_STREAM_MS,
  TITLE_MAX,
} from "@shared/constants";
import {
  COLUMNS,
  COLUMN_TITLES,
  type AgentSummary,
  type BoardPayload,
  type CardPayload,
  type ColumnKey,
  type DetailMessage,
  type ModelUsageSummary,
} from "@shared/types";
import type { TuiLiveness } from "./liveness";
import { scrub } from "./security";
import { contextUsage } from "./modelLimits";
import { branchOf } from "./vcs";
import { sessionMrLinks } from "./mergeRequests";
import {
  queryMessageCount,
  queryMessages,
  queryPartsByMessageIds,
  querySessionsByDirectories,
  querySessionDescendantIds,
  querySessionSubtreeRevision,
  type DbMessageRow,
} from "./storage/queries";

/** Part JSON blobs larger than this are skipped (defensive; observed max ~120KB). */
const PART_BLOB_LIMIT = 1_000_000;

const EMPTY_LIVENESS: TuiLiveness = {
  sessionIds: new Set(),
  directories: new Set(),
  waitingIds: new Set(),
  fallbackDirectories: new Set(),
  sessionDirectories: new Map(),
};

export function truncate(value: string, limit: number): string {
  const collapsed = value.split(/\s+/).filter(Boolean).join(" ");
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + "…";
}

export interface MessageInfo {
  agentName: string | null;
  error: string | null;
  lastTool: string | null;
  toolPending: boolean;
  questionRunning: boolean;
  lastRole: string | null;
  lastCompleted: number | null;
  lastActivityMs: number;
  promptSnippet: string | null;
  messageCount: number;
  modelRef: string | null;
  tokensTotal: number | null;
  modelUsages: Map<string, number>;
}

interface MessageData {
  role?: string;
  mode?: string;
  agent?: string;
  error?: unknown;
  modelID?: string;
  providerID?: string;
  tokens?: { total?: number };
  time?: Record<string, unknown>;
}

export interface PartData {
  type?: string;
  tool?: string;
  text?: string;
  state?: {
    status?: string;
    input?: { name?: string };
    time?: { start?: number; end?: number };
  };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extract everything the classifier needs from a session's messages. */
export function analyzeMessages(
  messages: { row: DbMessageRow; data: MessageData }[],
  partsByMessageId: Map<string, PartData[]>,
): MessageInfo {
  const info: MessageInfo = {
    agentName: null,
    error: null,
    lastTool: null,
    toolPending: false,
    questionRunning: false,
    lastRole: null,
    lastCompleted: null,
    lastActivityMs: 0,
    promptSnippet: null,
    messageCount: messages.length,
    modelRef: null,
    tokensTotal: null,
    modelUsages: new Map(),
  };
  const ordered = [...messages].sort((a, b) => a.row.timeCreated - b.row.timeCreated);

  for (const { row, data: message } of ordered) {
    const role = message.role;
    const times = (message.time ?? {}) as Record<string, unknown>;
    for (const stamp of [...Object.values(times), row.timeCreated, row.timeUpdated]) {
      const num = asNumber(stamp);
      if (num !== null && num > info.lastActivityMs) info.lastActivityMs = num;
    }

    const parts = partsByMessageId.get(row.id) ?? [];
    if (role === "assistant") {
      const mode = message.agent ?? message.mode;
      if (mode) info.agentName = mode;
      const error = message.error;
      info.error = error ? truncate(typeof error === "string" ? error : String(error), ERROR_MAX) : null;
      if (message.modelID) {
        // Streaming turns have no token usage yet; keep the latest completed
        // measurement as the best-known context snapshot.
        const tokensTotal = message.tokens?.total;
        if (tokensTotal) {
          const modelRef = `${message.providerID}/${message.modelID}`;
          info.modelRef = modelRef;
          info.tokensTotal = tokensTotal;
          info.modelUsages.set(modelRef, tokensTotal);
        }
      }
    }
    if (role === "user") {
      // A new user turn retries/resumes the session; an earlier aborted
      // assistant message must not keep the card in the error state.
      info.error = null;
      for (const part of parts) {
        if (part.type === "text" && (part.text ?? "").trim()) {
          info.promptSnippet = truncate(part.text ?? "", SNIPPET_MAX);
          break;
        }
      }
    }
    for (const part of parts) {
      if (part.type !== "tool") continue;
      const status = part.state?.status;
      if (status === "running") {
        info.lastTool = part.tool ?? null;
      } else if (status === "pending") {
        info.toolPending = true;
        if (!info.lastTool) info.lastTool = part.tool ?? null;
      }
    }
  }

  if (ordered.length > 0) {
    const last = ordered[ordered.length - 1];
    info.lastRole = last.data.role ?? null;
    info.lastCompleted = asNumber(last.data.time?.completed);
    if (info.lastRole === "assistant" && info.lastCompleted === null) {
      info.questionRunning = (partsByMessageId.get(last.row.id) ?? []).some(
        (part) => part.type === "tool" && part.tool === "question" && part.state?.status === "running",
      );
    }
  }
  return info;
}

export interface CardState {
  sessionId: string;
  directory: string;
  title: string;
  promptSnippet: string | null;
  parentId: string | null;
  agentName: string | null;
  column: ColumnKey;
  stage: string;
  stageKey: string;
  stageSince: number;
  runningSince: number | null;
  lastEventAt: number;
  reason: string | null;
  error: string | null;
  lastTool: string | null;
  messageCount: number;
  finishedAt: number | null;
  modelRef: string | null;
  tokensTotal: number | null;
  updatedAt: number;
  children: string[];
}

interface SessionAnalysisMemo {
  revision: number;
  info: MessageInfo;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function parsePartsGrouped(rows: { messageID: string; data: string }[]): Map<string, PartData[]> {
  const grouped = new Map<string, PartData[]>();
  for (const part of rows) {
    if (part.data.length > PART_BLOB_LIMIT) continue;
    let parsed: PartData;
    try {
      parsed = parseJson<PartData>(part.data);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const list = grouped.get(part.messageID);
    if (list) list.push(parsed);
    else grouped.set(part.messageID, [parsed]);
  }
  return grouped;
}

/** Accumulates read-only DB snapshots into cards; one instance per server. */
export class Engine {
  private cards = new Map<string, CardState>();
  private analysis = new Map<string, SessionAnalysisMemo>();
  private detailMemo = new Map<string, { revision: number; result: { messages: DetailMessage[]; models: ModelUsageSummary[] } }>();
  private liveSessionIds = new Set<string>();
  private liveness: TuiLiveness = EMPTY_LIVENESS;
  private cachedRevision = "";
  private cachedBoard: BoardPayload | null = null;
  private cachedBoardAt = 0;

  setTuiLiveness(liveness: TuiLiveness): boolean {
    const changed =
      !setsEqual(liveness.sessionIds, this.liveness.sessionIds) ||
      !setsEqual(liveness.directories, this.liveness.directories) ||
      !setsEqual(liveness.fallbackDirectories, this.liveness.fallbackDirectories) ||
      !setsEqual(liveness.waitingIds, this.liveness.waitingIds);
    this.liveness = liveness;
    return changed;
  }

  getLiveness(): TuiLiveness {
    return this.liveness;
  }

  /** Refresh cards from the DB for the sessions mapped to live TUIs.
   *
   * Classify only Hermes-matched sessions, the
   * latest root session per unmatched TUI directory, and their transitive
   * children — never every session in the directory.
   */
  rebuild(now: number): void {
    const directories = [...this.liveness.directories];
    if (directories.length === 0) {
      this.cards.clear();
      this.liveSessionIds.clear();
      return;
    }
    const sessions = querySessionsByDirectories(directories);
    const byId = new Map(sessions.map((session) => [session.id, session]));

    // Latest root session per directory (for the fallback rule and dir cap).
    const latestRootByDir = new Map<string, { id: string; timeUpdated: number }>();
    for (const session of sessions) {
      if (session.parentID) continue;
      const current = latestRootByDir.get(session.directory);
      if (!current || session.timeUpdated > current.timeUpdated) {
        latestRootByDir.set(session.directory, { id: session.id, timeUpdated: session.timeUpdated });
      }
    }
    // Watch at most MAX_WATCHED_DIRECTORIES, keeping the most recently updated.
    const watched = new Set(
      [...latestRootByDir.entries()]
        .sort((a, b) => b[1].timeUpdated - a[1].timeUpdated)
        .slice(0, MAX_WATCHED_DIRECTORIES)
        .map(([dir]) => dir),
    );

    // Candidate roots: Hermes-matched sessions + latest root per fallback dir.
    const keepRoots = new Set<string>();
    for (const sessionId of this.liveness.sessionIds) {
      const session = byId.get(sessionId);
      if (session && watched.has(session.directory)) keepRoots.add(sessionId);
    }
    for (const directory of this.liveness.fallbackDirectories) {
      if (!watched.has(directory)) continue;
      const best = latestRootByDir.get(directory);
      if (best) keepRoots.add(best.id);
    }

    // Children follow their (transitively) kept parents.
    const keep = new Set(keepRoots);
    for (const rootId of keepRoots) {
      for (const childId of querySessionDescendantIds(rootId)) keep.add(childId);
    }

    this.liveSessionIds = new Set(keep);
    for (const sessionId of keep) {
      const session = byId.get(sessionId);
      if (!session) continue;
      this.refreshCard(
        sessionId,
        session.directory,
        session.title,
        session.parentID,
        session.timeUpdated,
        now,
      );
    }
    for (const sessionId of this.cards.keys()) {
      if (!keep.has(sessionId)) {
        this.cards.delete(sessionId);
        this.analysis.delete(sessionId);
      }
    }
    this.linkChildren();
  }

  private refreshCard(
    sessionId: string,
    directory: string,
    rawTitle: string,
    parentId: string | null,
    updatedAt: number,
    now: number,
  ): void {
    const revision = querySessionSubtreeRevision(sessionId);
    let memo = this.analysis.get(sessionId);
    if (!memo || memo.revision !== revision) {
      const info = this.analyzeSession(sessionId);
      memo = { revision, info };
      this.analysis.set(sessionId, memo);
    }
    const info = memo.info;

    if (info.messageCount === 0) {
      // Session created but never prompted: not work yet, keep it off the board.
      this.cards.delete(sessionId);
      this.analysis.delete(sessionId);
      return;
    }

    let card = this.cards.get(sessionId);
    if (!card) {
      card = {
        sessionId,
        directory,
        title: "",
        promptSnippet: null,
        parentId: null,
        agentName: null,
        column: "running",
        stage: "Starting",
        stageKey: "",
        stageSince: 0,
        runningSince: null,
        lastEventAt: 0,
        reason: null,
        error: null,
        lastTool: null,
        messageCount: 0,
        finishedAt: null,
        modelRef: null,
        tokensTotal: null,
        updatedAt: 0,
        children: [],
      };
      this.cards.set(sessionId, card);
    }
    card.directory = directory;
    card.updatedAt = updatedAt;
    card.parentId = parentId ?? null;
    card.promptSnippet = info.promptSnippet;
    const title = (rawTitle ?? "").trim();
    card.title = title ? truncate(title, TITLE_MAX) : truncate(card.promptSnippet ?? "Session", TITLE_MAX);
    card.agentName = info.agentName;
    card.lastTool = info.lastTool;
    card.messageCount = info.messageCount;
    card.modelRef = info.modelRef;
    card.tokensTotal = info.tokensTotal;
    card.lastEventAt = Math.max(updatedAt, info.lastActivityMs, card.lastEventAt);
    this.classify(card, info, now);
  }

  private analyzeSession(sessionId: string): MessageInfo {
    const total = queryMessageCount(sessionId);
    if (total === 0) {
      return {
        agentName: null,
        error: null,
        lastTool: null,
        toolPending: false,
        questionRunning: false,
        lastRole: null,
        lastCompleted: null,
        lastActivityMs: 0,
        promptSnippet: null,
        messageCount: 0,
        modelRef: null,
        tokensTotal: null,
        modelUsages: new Map(),
      };
    }
    const rows = queryMessages(sessionId, MESSAGE_LIMIT_PER_SESSION); // newest first
    const messageIds = rows.map((row) => row.id);
    const parts = queryPartsByMessageIds(sessionId, messageIds);
    const partsByMessageId = parsePartsGrouped(parts);
    const messages: { row: DbMessageRow; data: MessageData }[] = [];
    for (const row of [...rows].reverse()) {
      let data: MessageData;
      try {
        data = parseJson<MessageData>(row.data);
      } catch {
        continue;
      }
      if (!data || typeof data !== "object") continue;
      messages.push({ row, data });
    }
    const info = analyzeMessages(messages, partsByMessageId);
    // Fold DB row timestamps into activity: streaming turns bump time_updated.
    for (const { row } of messages) {
      info.lastActivityMs = Math.max(info.lastActivityMs, row.timeUpdated, row.timeCreated);
    }
    info.messageCount = total;
    return info;
  }

  // ------------------------------------------------------------ classifier
  private classify(card: CardState, info: MessageInfo, now: number): void {
    const previousColumn = card.column;
    const permissionWaiting = this.liveness.waitingIds.has(card.sessionId);
    const questionWaiting =
      info.questionRunning &&
      (this.liveness.sessionIds.has(card.sessionId) || this.liveness.directories.has(card.directory));
    const error = info.error;
    const activity = Math.max(info.lastActivityMs, 1);
    const streaming = info.lastRole === "assistant" && info.lastCompleted === null;
    const busy =
      (info.lastRole === "user" && now - activity < DEBOUNCE_MS) ||
      (streaming && now - activity < STALE_STREAM_MS);
    const stable = now - card.updatedAt >= DEBOUNCE_MS;

    let column: ColumnKey = card.column;
    let stage = card.stage;
    let reason: string | null = card.reason;
    let since: number | null = null;
    let finished: number | null = null;

    if (error) {
      column = "idle";
      stage = "Error";
      reason = `Error: ${error}`;
      since = Math.max(info.lastActivityMs, card.lastEventAt);
    } else if (permissionWaiting || questionWaiting) {
      column = "attention";
      if (permissionWaiting) {
        stage = "Waiting for permission";
        reason = "Permission request";
      } else {
        stage = "Waiting for answer";
        reason = "Agent question";
      }
      since = info.lastActivityMs || now;
    } else if (busy) {
      column = "running";
      if (streaming && info.lastTool) {
        stage = `Tool: ${info.lastTool}`;
        reason = null;
      } else if (streaming) {
        stage = "Generating response";
        reason = null;
      } else {
        stage = "Starting";
        reason = null;
      }
      since = info.lastActivityMs || now;
    } else if (info.lastRole === "assistant" && info.lastCompleted !== null && stable) {
      column = "idle";
      stage = "Finished";
      reason = null;
      since = info.lastCompleted;
      finished = info.lastCompleted;
    } else if (info.lastRole === "user" && stable) {
      column = "idle";
      stage = "Inactive";
      reason = "Agent did not respond (session is inactive)";
      since = info.lastActivityMs;
    } else if (streaming && stable) {
      column = "idle";
      stage = "Interrupted";
      reason = "Interrupted: agent response was not completed (no updates for over 15 min)";
      since = info.lastActivityMs;
    } else {
      // Freshly idle snapshots stay where they are until debounced.
      column = "running";
      stage = info.lastCompleted !== null ? "Finishing…" : "Starting";
      reason = null;
      since = info.lastActivityMs || now;
    }

    if (column === "running") {
      if (previousColumn !== "running" || card.runningSince === null) {
        card.runningSince = since ?? now;
      }
    } else {
      card.runningSince = null;
    }
    card.column = column;
    card.stage = stage;
    card.reason = reason;
    card.finishedAt = finished ?? (column === "idle" ? info.lastCompleted : null);
    card.error = column === "idle" ? error : null;
    const stageKey = `${column}:${stage}`;
    if (stageKey !== card.stageKey) {
      card.stageKey = stageKey;
      card.stageSince = since ?? now;
    }
  }

  // --------------------------------------------------------- presentation
  private linkChildren(): void {
    for (const card of this.cards.values()) card.children = [];
    for (const card of [...this.cards.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
      const parent = card.parentId !== null ? this.cards.get(card.parentId) : undefined;
      // Nest subagent cards under the parent only while they share a column;
      // a finished child must stay visible in its own (idle) column.
      if (parent && parent.column === card.column) parent.children.push(card.sessionId);
    }
  }

  private cardPayload(card: CardState): CardPayload {
    const subagentCount = [...this.cards.values()].filter((c) => c.parentId === card.sessionId).length;
    return {
      session_id: card.sessionId,
      directory: card.directory,
      directory_name: card.directory.replace(/\/+$/, "").split("/").pop() ?? card.directory,
      title: card.title,
      prompt_snippet: card.promptSnippet,
      parent_id: card.parentId,
      agent: card.agentName ? { name: card.agentName } : null,
      column: card.column,
      stage: card.stage,
      stage_since: card.stageSince,
      running_since: card.runningSince,
      last_event_at: card.lastEventAt,
      reason: card.reason,
      error: card.error,
      last_tool: card.lastTool,
      message_count: card.messageCount,
      finished_at: card.finishedAt,
      tokens_total: card.tokensTotal,
      model_ref: card.modelRef,
      context: contextUsage(card.modelRef, card.tokensTotal),
      branch: branchOf(card.directory),
      mrs: sessionMrLinks(card.sessionId),
      subagent_count: subagentCount,
      children: card.children
        .map((id) => this.cards.get(id))
        .filter((child): child is CardState => child !== undefined)
        .map((child) => this.cardPayload(child)),
    };
  }

  board(now: number): BoardPayload {
    if (this.cachedBoard && now - this.cachedBoardAt < 250) return this.cachedBoard;

    const workingAgents = new Set<string>();
    const restingAgents = new Set<string>();
    for (const card of this.cards.values()) {
      if (!card.agentName) continue;
      if (card.column === "running" || card.column === "attention") workingAgents.add(card.agentName);
      else if (card.column === "idle") restingAgents.add(card.agentName);
    }
    for (const name of workingAgents) restingAgents.delete(name);
    const agents: AgentSummary[] = [...new Set([...workingAgents, ...restingAgents])]
      .sort()
      .map((name) => ({
        name,
        working: workingAgents.has(name),
        on_board: workingAgents.has(name) || restingAgents.has(name),
      }));

    const byColumn: Record<ColumnKey, CardState[]> = { attention: [], running: [], idle: [] };
    for (const card of this.cards.values()) byColumn[card.column].push(card);
    byColumn.running.sort((a, b) => b.lastEventAt - a.lastEventAt);
    byColumn.attention.sort((a, b) => a.stageSince - b.stageSince);
    byColumn.idle.sort((a, b) => (b.finishedAt ?? b.stageSince) - (a.finishedAt ?? a.stageSince));

    const columns = {} as Record<ColumnKey, { title: string; count: number; cards: CardPayload[] }>;
    for (const key of COLUMNS) {
      const top = byColumn[key].filter((card) => {
        if (card.parentId === null) return true;
        const parent = this.cards.get(card.parentId);
        return !parent || parent.column !== card.column;
      });
      columns[key] = {
        title: COLUMN_TITLES[key],
        count: byColumn[key].length,
        cards: top.map((card) => this.cardPayload(card)),
      };
    }

    const projectCount = new Set([...this.cards.values()].map((card) => card.directory)).size;
    const payload: BoardPayload = {
      columns,
      agents,
      agent_stats: { working: workingAgents.size, resting: restingAgents.size },
      project_count: projectCount,
      generated_at: now,
    };
    this.cachedBoard = payload;
    this.cachedBoardAt = now;
    return payload;
  }

  /** Stable signature of the visible board state (for ETag). */
  revision(): string {
    const parts: string[] = [];
    for (const card of [...this.cards.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
      parts.push(
        [
          card.sessionId,
          card.column,
          card.stageKey,
          card.stageSince,
          card.lastEventAt,
          card.agentName ?? "",
          card.reason ?? "",
          card.error ?? "",
          card.messageCount,
          card.children.length,
        ].join("|"),
      );
    }
    const signature = parts.join(";");
    const digest = createHash("sha1").update(signature).digest("hex").slice(0, 16);
    if (digest !== this.cachedRevision) this.cachedRevision = digest;
    return this.cachedRevision;
  }

  sessionDirectory(sessionId: string): string | null {
    return this.cards.get(sessionId)?.directory ?? null;
  }

  /** Flat snapshot of kept cards for the history store. */
  historyCards(): { sessionId: string; directory: string; column: string }[] {
    return [...this.cards.values()].map((card) => ({
      sessionId: card.sessionId,
      directory: card.directory,
      column: card.column,
    }));
  }

  /** Rendered session detail: messages (newest first), models, per-message tools.
   * Memoized by the session subtree revision. */
  detail(sessionId: string): { messages: DetailMessage[]; models: ModelUsageSummary[] } {
    const revision = querySessionSubtreeRevision(sessionId);
    const memo = this.detailMemo.get(sessionId);
    if (memo && memo.revision === revision) return memo.result;
    const result = this.renderDetail(sessionId);
    this.detailMemo.set(sessionId, { revision, result });
    if (this.detailMemo.size > 32) {
      const oldest = this.detailMemo.keys().next().value;
      if (oldest !== undefined) this.detailMemo.delete(oldest);
    }
    return result;
  }

  private renderDetail(sessionId: string): { messages: DetailMessage[]; models: ModelUsageSummary[] } {
    const DETAIL_MESSAGE_LIMIT = 2000;
    const rows = queryMessages(sessionId, DETAIL_MESSAGE_LIMIT); // newest first
    const messageIds = rows.map((row) => row.id);
    const partsByMessageId = parsePartsGrouped(queryPartsByMessageIds(sessionId, messageIds));
    const rendered: DetailMessage[] = [];
    const modelAgg = new Map<string, ModelUsageSummary>();
    for (const row of rows) {
      let message: MessageData & {
        cost?: number;
        finish?: unknown;
      };
      try {
        message = parseJson<MessageData & { cost?: number; finish?: unknown }>(row.data);
      } catch {
        continue;
      }
      const times = (message.time ?? {}) as Record<string, unknown>;
      const started = asNumber(times.started);
      const created = asNumber(times.created);
      const completed = asNumber(times.completed);
      const durationStart = started ?? created;
      const durationMs =
        completed !== null && durationStart !== null ? Math.max(0, completed - durationStart) : null;
      const tokens = message.tokens as
        | { input?: number; output?: number; reasoning?: number; total?: number; cache?: { read?: number; write?: number } }
        | undefined;
      const providerId = message.providerID;
      const modelId = message.modelID;
      const modelRef = providerId && modelId ? `${providerId}/${modelId}` : null;
      const textParts: string[] = [];
      const tools: DetailMessage["tools"] = [];
      for (const part of partsByMessageId.get(row.id) ?? []) {
        if (part.type === "text") textParts.push(part.text ?? "");
        else if (part.type === "tool") {
          const toolStarted = asNumber(part.state?.time?.start);
          const toolEnded = asNumber(part.state?.time?.end);
          tools.push({
            tool: part.tool ?? null,
            status: part.state?.status ?? "unknown",
            started: toolStarted,
            ended: toolEnded,
            duration_ms:
              toolStarted !== null && toolEnded !== null ? Math.max(0, toolEnded - toolStarted) : null,
            skill_name: part.tool === "skill" ? (part.state?.input?.name ?? null) : null,
          });
        }
      }
      const error = message.error;
      rendered.push(
        scrub<DetailMessage>({
          role: message.role ?? null,
          agent: (message.agent ?? message.mode) ?? null,
          created,
          started,
          completed,
          duration_ms: durationMs,
          model: modelRef,
          cost: typeof message.cost === "number" ? message.cost : null,
          usage: tokens ?? null,
          text: textParts.filter((t) => t.trim()).join("\n"),
          tools,
          error: error ? truncate(String(error), ERROR_MAX) : null,
        }),
      );
      if (modelRef && message.role === "assistant" && tokens) {
        const entry =
          modelAgg.get(modelRef) ??
          ({
            model: modelRef,
            turns: 0,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 },
          } satisfies ModelUsageSummary);
        entry.turns += 1;
        entry.cost += typeof message.cost === "number" ? message.cost : 0;
        entry.tokens.input += tokens.input ?? 0;
        entry.tokens.output += tokens.output ?? 0;
        entry.tokens.reasoning += tokens.reasoning ?? 0;
        entry.tokens.cache_read += tokens.cache?.read ?? 0;
        entry.tokens.cache_write += tokens.cache?.write ?? 0;
        entry.tokens.total += tokens.total ?? 0;
        modelAgg.set(modelRef, entry);
      }
    }
    return { messages: rendered, models: [...modelAgg.values()] };
  }
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}
