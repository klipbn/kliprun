import type { ColumnKey, SessionSource } from "./types";

export interface UsageTokens {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  other: number;
}
export interface UsageSession {
  id: string;
  source: SessionSource;
  parent_id: string | null;
  title: string;
  directory: string;
  created_at: number;
  updated_at: number;
}
export interface UsageEvent {
  id: string;
  session_id: string;
  at: number | null;
  kind: "usage" | "turn";
  agent: string | null;
  model: string | null;
  tokens: UsageTokens | null;
  cost: number | null;
  incomplete: boolean;
}
export interface UsageInterval {
  id: number;
  session_id: string;
  directory: string;
  column_name: ColumnKey;
  entered_at: number;
  exited_at: number | null;
  duration_ms: number | null;
}
export interface UsageAttribution {
  interval_id: number;
  start: number;
  end: number;
  agent: string | null;
  model: string | null;
}
export interface UsageObservation {
  at: number;
  intervals: UsageInterval[];
  cards: Array<{ session_id: string; source: SessionSource; parent_id: string | null; title: string; directory: string; agent: string | null; model: string | null }>;
}
export interface StatsFilters {
  from: number;
  to: number;
  timezone: string;
  sources: string[];
  agents: string[];
  models: string[];
  projects: string[];
  role: "all" | "roots" | "children";
  granularity: "day" | "week" | "month";
  period?: "today" | "yesterday" | "7" | "30" | "month" | "all" | "custom";
}
export interface UsageMetrics {
  tokens: UsageTokens;
  running_ms: number | null;
  active_ms: number | null;
  tasks: number;
  calls: number;
  turns: number;
  active_days: number;
  cost: number | null;
  cost_calls: number;
  incomplete: boolean;
}
export interface StatsSessionRow extends UsageMetrics {
  id: string;
  source: SessionSource;
  title: string;
  directory: string;
  agents: string[];
  models: string[];
  subagents: number;
  last_at: number;
}
export interface StatsBreakdown extends UsageMetrics { key: string; label: string }
export interface StatsBucket extends UsageMetrics { key: string; label: string; from: number; to: number }
export interface StatsHeatCell { weekday: number; hour: number; running_ms: number; active_ms: number }
export interface UsageImportStatus {
  source: SessionSource;
  state: "loading" | "ready" | "unavailable";
  indexed: number;
  total: number;
  updated_at: number | null;
  skipped: number;
  message: string | null;
}
export interface StatsDashboardPayload {
  filters: StatsFilters;
  summary: UsageMetrics;
  previous: UsageMetrics;
  series: StatsBucket[];
  breakdowns: Record<"source" | "agent" | "model" | "project", StatsBreakdown[]>;
  facets: Record<"sources" | "agents" | "models" | "projects", string[]>;
  heatmap: StatsHeatCell[];
  scatter: StatsSessionRow[];
  observation_since: number | null;
  undated_calls: number;
  sources: UsageImportStatus[];
  generated_at: number;
}
export interface StatsSessionsPayload { rows: StatsSessionRow[]; total: number; page: number; limit: number }
export interface StatsSessionPayload {
  session: StatsSessionRow | null;
  participants: StatsSessionRow[];
  models: StatsBreakdown[];
  agents: StatsBreakdown[];
  intervals: Array<{ session_id: string; start: number; end: number; agent: string | null; model: string | null }>;
}
