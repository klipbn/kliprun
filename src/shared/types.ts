export type ColumnKey = "attention" | "running" | "idle";
export type SessionSource = "opencode" | "codex";

export const COLUMNS: readonly ColumnKey[] = ["attention", "running", "idle"] as const;

export const COLUMN_TITLES: Record<ColumnKey, string> = {
  attention: "Needs attention",
  running: "Running",
  idle: "IDLE",
};

export interface AgentSummary {
  name: string;
  working: boolean;
  on_board: boolean;
}

export interface ContextUsage {
  model: string;
  percent: number;
  used: number;
  limit: number;
}

export interface MrLink {
  url: string;
  label: string;
}

export interface CardPayload {
  source: SessionSource;
  session_id: string;
  directory: string;
  directory_name: string;
  title: string;
  prompt_snippet: string | null;
  parent_id: string | null;
  agent: { name: string } | null;
  column: ColumnKey;
  stage: string;
  stage_since: number;
  running_since: number | null;
  last_event_at: number;
  reason: string | null;
  error: string | null;
  last_tool: string | null;
  message_count: number;
  finished_at: number | null;
  tokens_total: number | null;
  model_ref: string | null;
  context: ContextUsage | null;
  branch: string | null;
  mrs: MrLink[];
  subagent_count: number;
  subagent_active: number;
  subagent_errors: number;
  subagent_error_notes: string[];
  children: CardPayload[];
}

export interface BoardColumn {
  title: string;
  count: number;
  cards: CardPayload[];
}

export interface BoardPayload {
  columns: Record<ColumnKey, BoardColumn>;
  agents: AgentSummary[];
  agent_stats: { working: number; resting: number };
  project_count: number;
  generated_at: number;
}

export interface ToolEntry {
  tool: string | null;
  status: string;
  started: number | null;
  ended: number | null;
  duration_ms: number | null;
  skill_name: string | null;
}

export interface DetailMessage {
  role: string | null;
  agent: string | null;
  created: number | null;
  started: number | null;
  completed: number | null;
  duration_ms: number | null;
  model: string | null;
  cost: number | null;
  usage: Record<string, unknown> | null;
  text: string;
  tools: ToolEntry[];
  error: string | null;
}

export interface ModelUsageSummary {
  model: string;
  turns: number;
  cost: number | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
}

export interface KanbanInterval {
  column: string;
  entered_at: number;
  exited_at: number | null;
  duration_ms: number;
  current: boolean;
}

export interface SessionDetailPayload {
  source: SessionSource;
  session_id: string;
  title: string;
  directory: string;
  branch: string | null;
  mrs: MrLink[];
  messages: DetailMessage[];
  models: ModelUsageSummary[];
  kanban_history: KanbanInterval[];
  exists: boolean;
}
