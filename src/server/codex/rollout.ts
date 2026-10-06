import { closeSync, openSync, readSync, statSync } from "node:fs";
import { STALE_STREAM_MS } from "@shared/constants";
import type { ColumnKey, ContextUsage, DetailMessage, ModelUsageSummary, ToolEntry } from "@shared/types";
import { scrub } from "../security";

const MAX_READ = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_MESSAGES = 100;

type Json = Record<string, unknown>;
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }

interface TokenSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

const TOKEN_FIELDS = ["input", "output", "reasoning", "cache_read", "cache_write", "total"] as const;

function tokenSnapshot(value: unknown): TokenSnapshot | null {
  const usage = object(value);
  const total = number(usage.total_tokens);
  if (total === null) return null;
  return { input: number(usage.input_tokens) ?? 0, output: number(usage.output_tokens) ?? 0,
    reasoning: number(usage.reasoning_output_tokens) ?? 0, cache_read: number(usage.cached_input_tokens) ?? 0,
    cache_write: number(usage.cache_write_input_tokens) ?? 0, total };
}

function tokenDifference(current: TokenSnapshot, previous: TokenSnapshot): TokenSnapshot {
  return { input: current.input - previous.input, output: current.output - previous.output,
    reasoning: current.reasoning - previous.reasoning, cache_read: current.cache_read - previous.cache_read,
    cache_write: current.cache_write - previous.cache_write, total: current.total - previous.total };
}

export interface RolloutState {
  column: ColumnKey;
  stage: string;
  since: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastEventAt: number;
  model: string | null;
  tokens: number | null;
  context: ContextUsage | null;
  messages: DetailMessage[];
  models: ModelUsageSummary[];
  lastTool: string | null;
  prompt: string | null;
  reason: string | null;
}

/** Bounded, incremental reader. Never retains system prompts or raw tool arguments/output. */
export class RolloutReader {
  private offset = 0;
  private identity = "";
  private mtime = 0;
  private partial = Buffer.alloc(0);
  private skipping = false;
  private turn: string | null = null;
  private active = false;
  private pending = new Map<string, { question: boolean; tool: ToolEntry }>();
  private state = this.empty();
  private limit: number | null = null;
  private used: number | null = null;
  private previousUsage: TokenSnapshot | null = null;
  private truncatedHistory = false;
  private modelUsage = new Map<string, ModelUsageSummary>();

  private empty(): RolloutState {
    return { column: "idle", stage: "Status unknown", since: 0, startedAt: null, finishedAt: null,
      lastEventAt: 0, model: null, tokens: null, context: null, messages: [], models: [], lastTool: null, prompt: null,
      reason: "No confirmed turn status in the local journal" };
  }

  read(path: string, now: number): RolloutState {
    const stat = statSync(path);
    const identity = `${path}:${stat.dev}:${stat.ino}`;
    if (identity !== this.identity || stat.size < this.offset || (stat.size === this.offset && stat.mtimeMs !== this.mtime)) {
      this.reset(); this.identity = identity;
    }
    // Start from a bounded tail on first read or after a large backlog.
    if (stat.size - this.offset > MAX_READ) {
      this.reset(); this.identity = identity;
      this.offset = stat.size - MAX_READ; this.skipping = true; this.truncatedHistory = true;
    }
    const length = Math.min(MAX_READ, stat.size - this.offset);
    if (length > 0) {
      const fd = openSync(path, "r");
      try {
        const chunk = Buffer.alloc(length);
        const bytes = readSync(fd, chunk, 0, length, this.offset);
        this.offset += bytes;
        this.consume(chunk.subarray(0, bytes));
      } finally { closeSync(fd); }
    }
    this.mtime = stat.mtimeMs;
    const stale = this.active && this.state.column === "running" && now - this.state.lastEventAt > STALE_STREAM_MS;
    if (stale) return { ...this.state, column: "idle", stage: "Status unknown", since: this.state.lastEventAt + STALE_STREAM_MS,
      finishedAt: null, reason: "No recent events; work or permission waiting cannot be confirmed" };
    return this.state;
  }

  private reset(): void {
    this.offset = 0; this.partial = Buffer.alloc(0); this.skipping = false;
    this.turn = null; this.active = false; this.pending.clear(); this.state = this.empty();
    this.limit = null; this.used = null;
    this.previousUsage = null; this.truncatedHistory = false; this.modelUsage.clear();
  }

  private recordUsage(info: Json): void {
    const current = tokenSnapshot(info.total_token_usage);
    if (!current) return;
    const previous = this.previousUsage;
    this.previousUsage = current;
    const reset = previous && TOKEN_FIELDS.some(field => current[field] < previous[field]);
    const usage = previous && !reset
      ? tokenDifference(current, previous)
      : this.truncatedHistory || reset ? tokenSnapshot(info.last_token_usage) : current;
    if (!usage || usage.total <= 0 || !this.state.model) return;
    const model = scrub(this.state.model);
    let summary = this.modelUsage.get(model);
    if (!summary) {
      summary = { model, turns: 0, cost: null,
        tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0 } };
      this.modelUsage.set(model, summary);
      this.state.models.push(summary);
    }
    summary.turns += 1;
    for (const field of TOKEN_FIELDS) summary.tokens[field] += usage[field];
  }

  private consume(chunk: Buffer): void {
    const data = Buffer.concat([this.partial, chunk]);
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      if (!this.skipping && end - start <= MAX_LINE) {
        try { this.apply(object(JSON.parse(data.subarray(start, end).toString("utf8")))); } catch { /* incomplete/corrupt event */ }
      }
      this.skipping = false;
      start = end + 1;
    }
    if (data.length - start > MAX_LINE || this.skipping) {
      this.partial = Buffer.alloc(0); this.skipping = true;
    } else this.partial = Buffer.from(data.subarray(start));
  }

  private transition(column: ColumnKey, stage: string, at: number): void {
    if (this.state.column !== column || this.state.stage !== stage) this.state.since = at;
    this.state.column = column; this.state.stage = stage;
    this.state.reason = null;
  }

  private message(role: string, text: string, at: number, tools: ToolEntry[] = []): void {
    this.state.messages.unshift({ role, agent: null, created: at || null, started: null, completed: null,
      duration_ms: null, model: scrub(this.state.model), cost: null, usage: null, text: scrub(text).slice(0, 16000), tools, error: null });
    this.state.messages.length = Math.min(this.state.messages.length, MAX_MESSAGES);
  }

  private apply(entry: Json): void {
    const payload = object(entry.payload);
    const at = Date.parse(String(entry.timestamp ?? ""));
    if (!Number.isFinite(at)) return;
    const type = string(payload.type);
    this.state.lastEventAt = Math.max(this.state.lastEventAt, at);
    if (entry.type === "turn_context") {
      const model = string(payload.model);
      if (model && this.state.model && model !== this.state.model) {
        this.limit = null; this.used = null; this.state.context = null;
      }
      this.state.model = model ?? this.state.model;
    }
    if (entry.type === "event_msg") {
      if (type === "task_started") {
        this.turn = string(payload.turn_id); this.active = true; this.pending.clear();
        this.state.startedAt = at; this.state.finishedAt = null; this.state.lastTool = null;
        this.state.since = at;
        this.transition("running", "Working", at);
        this.limit = number(payload.model_context_window) ?? this.limit;
      } else if (["task_complete", "turn_aborted", "task_failed"].includes(type ?? "")) {
        if (payload.turn_id && this.turn && payload.turn_id !== this.turn) return;
        this.active = false;
        for (const { tool } of this.pending.values()) { tool.status = "unknown"; tool.ended = at; }
        this.pending.clear();
        this.state.finishedAt = type === "task_complete" ? at : null;
        this.transition("idle", type === "task_complete" ? "Finished" : type === "turn_aborted" ? "Interrupted" : "Error", at);
      } else if (type === "token_count") {
        const info = object(payload.info);
        this.limit = number(info.model_context_window) ?? this.limit;
        this.used = number(object(info.last_token_usage).total_tokens) ?? this.used;
        this.state.tokens = number(object(info.total_token_usage).total_tokens) ?? this.state.tokens;
        this.recordUsage(info);
      }
    }
    if (entry.type === "response_item") {
      if (type === "message" && ["user", "assistant"].includes(String(payload.role))) {
        const text = Array.isArray(payload.content) ? payload.content.map(item => string(object(item).text) ?? "").join("\n") : "";
        if (text) {
          this.message(String(payload.role), text, at);
          if (payload.role === "user") this.state.prompt = scrub(text).slice(0, 140);
        }
      } else if (["function_call", "custom_tool_call"].includes(type ?? "")) {
        const name = string(payload.name);
        const callId = string(payload.call_id);
        if (name && callId && this.active) {
          const tool: ToolEntry = { tool: scrub(name), status: "running", started: at, ended: null, duration_ms: null, skill_name: null };
          const question = /(?:^|\.)request_user_input$/.test(name);
          this.pending.set(callId, { question, tool });
          // Bound pending calls even if a journal never emits their outputs.
          if (this.pending.size > 100) this.pending.delete(this.pending.keys().next().value!);
          this.state.lastTool = scrub(name);
          this.message("assistant", "", at, [tool]);
          if (question) this.transition("attention", "Waiting for input", at);
        }
      } else if (["function_call_output", "custom_tool_call_output"].includes(type ?? "")) {
        const callId = string(payload.call_id) ?? "";
        const pending = this.pending.get(callId);
        if (pending) {
          pending.tool.status = "completed"; pending.tool.ended = at;
          pending.tool.duration_ms = Math.max(0, at - (pending.tool.started ?? at));
          this.pending.delete(callId);
          if (this.active && ![...this.pending.values()].some(p => p.question)) this.transition("running", "Working", at);
        }
      }
    }
    if (this.state.model && this.limit && this.used !== null) {
      this.state.context = { model: this.state.model, percent: Math.min(100, this.used / this.limit * 100), used: this.used, limit: this.limit };
    }
  }
}
