import { basename } from "node:path";
import type { CardPayload, SessionDetailPayload } from "@shared/types";
import { scrub } from "../security";
import { branchOf } from "../vcs";
import { matchCliSessions, type CliProcess } from "./liveness";
import { RolloutReader } from "./rollout";
import { codexHome, CodexStorage, type CodexThread } from "./storage";

export class CodexAdapter {
  private readonly storage: CodexStorage;
  private processes: CliProcess[] = [];
  private readers = new Map<string, RolloutReader>();
  private threads = new Map<string, CodexThread>();
  diagnostics: string[] = [];

  constructor(home = codexHome()) { this.storage = new CodexStorage(home); }

  setProcesses(processes: CliProcess[]): void { this.processes = processes; }

  cards(now: number): CardPayload[] {
    this.diagnostics = [];
    if (!this.processes.length) { this.threads.clear(); this.readers.clear(); return []; }
    try {
      const match = matchCliSessions(this.processes, this.storage.candidates(this.processes));
      this.diagnostics = match.diagnostics;
      this.threads = new Map(match.threads.map(row => [row.id, row]));
    } catch {
      this.diagnostics = ["Codex database unavailable or incompatible; CLI sessions cannot be matched"];
      this.threads.clear();
    }
    for (const id of this.readers.keys()) if (!this.threads.has(id)) this.readers.delete(id);
    return [...this.threads.values()].map(row => this.card(row, now));
  }

  private card(row: CodexThread, now: number): CardPayload {
    let reader = this.readers.get(row.id);
    if (!reader) { reader = new RolloutReader(); this.readers.set(row.id, reader); }
    let state;
    try { state = reader.read(row.rollout_path, now); } catch {
      this.diagnostics.push(`Session ${row.id}: local journal unavailable`);
    }
    return {
      source: "codex", session_id: `codex:${row.id}`, directory: scrub(row.cwd), directory_name: scrub(basename(row.cwd)),
      title: scrub(row.title).slice(0, 90), prompt_snippet: state?.prompt ?? null, parent_id: null, agent: { name: "Codex" },
      column: state?.column ?? "idle", stage: state?.stage ?? "Status unknown", stage_since: state?.since || row.updated_at * 1000,
      running_since: state?.column === "running" ? state.startedAt : null, last_event_at: state?.lastEventAt || row.updated_at * 1000,
      reason: state?.reason ?? (state ? null : "Local journal unavailable"), error: state?.stage === "Error" ? "Turn failed" : null,
      last_tool: state?.lastTool ?? null, message_count: state?.messages.length ?? 0, finished_at: state?.finishedAt ?? null,
      tokens_total: state?.tokens ?? null, model_ref: scrub(state?.model ?? row.model), context: state?.context ? { ...state.context, model: scrub(state.context.model) } : null,
      branch: scrub(branchOf(row.cwd)), mrs: [], subagent_count: 0, subagent_active: 0, subagent_errors: 0, subagent_error_notes: [], children: [],
    };
  }

  detail(sessionId: string, now: number): SessionDetailPayload {
    const row = this.threads.get(sessionId.replace(/^codex:/, ""));
    let messages: SessionDetailPayload["messages"] = [];
    let models: SessionDetailPayload["models"] = [];
    if (row) {
      try {
        const state = this.readers.get(row.id)?.read(row.rollout_path, now);
        messages = state?.messages ?? [];
        models = state?.models ?? [];
      } catch { /* journal removed */ }
    }
    return { source: "codex", session_id: sessionId, title: scrub(row?.title ?? ""), directory: scrub(row?.cwd ?? ""),
      branch: row ? scrub(branchOf(row.cwd)) : null, mrs: [], messages, models, kanban_history: [], exists: !!row };
  }

  watchPaths(): string[] {
    return [...(this.storage.path ? [this.storage.path, `${this.storage.path}-wal`] : []), ...[...this.threads.values()].map(row => row.rollout_path)];
  }

  /** Current journal model, with only an explicitly persisted provider. */
  usageModel(card: CardPayload): string | null {
    if (!card.model_ref) return null;
    const provider = this.threads.get(card.session_id.replace(/^codex:/, ""))?.model_provider;
    return provider ? scrub(`${provider}/${card.model_ref}`) : card.model_ref;
  }

  close(): void { this.storage.close(); this.threads.clear(); this.readers.clear(); }
}
