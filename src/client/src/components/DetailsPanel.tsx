import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Clock,
  Coins,
  Cpu,
  GitBranch,
  GitMerge,
  History,
  Loader2,
  MessageSquare,
  Terminal,
  User,
  Wrench,
  X,
} from "lucide-react";
import type { ColumnKey, DetailMessage, SessionDetailPayload } from "@shared/types";
import { formatDuration, formatRelativeTimeVerbose, formatTokens } from "@shared/format";

const AGENT_MESSAGE_LIMIT = 42;

type TabKey = "all" | "agent" | "user" | "models" | "kanban";

const TABS: { key: TabKey; label: string; icon: typeof MessageSquare }[] = [
  { key: "all", label: "All", icon: MessageSquare },
  { key: "agent", label: "Agent", icon: Terminal },
  { key: "user", label: "User", icon: User },
  { key: "models", label: "Models", icon: Cpu },
  { key: "kanban", label: "Kanban", icon: History },
];

const COLUMN_BADGE: Record<string, string> = {
  attention: "bg-warning/15 text-warning",
  running: "bg-accent/10 text-accent",
  idle: "bg-success/15 text-success",
};

function MessageView({ message }: { message: DetailMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`rounded-md border p-2.5 space-y-1.5 ${
        message.error ? "border-error/40 bg-error/5" : isUser ? "border-border bg-surface" : "border-border bg-surface/60"
      }`}
      data-testid="detail-message"
    >
      <div className="flex items-center gap-2 text-xs text-text-secondary flex-wrap">
        {isUser ? (
          <User className="w-3.5 h-3.5 text-accent" />
        ) : (
          <Terminal className="w-3.5 h-3.5 text-accent" />
        )}
        <span className="text-text-primary font-medium">{message.agent ?? message.role}</span>
        {message.model && <span className="px-1.5 rounded bg-background border border-border">{message.model}</span>}
        {message.created !== null && <span>{formatRelativeTimeVerbose(message.created)}</span>}
        {message.duration_ms !== null && (
          <span className="flex items-center gap-0.5">
            <Clock className="w-3 h-3" />
            {formatDuration(message.duration_ms)}
          </span>
        )}
        {message.cost !== null && message.cost > 0 && (
          <span className="flex items-center gap-0.5">
            <Coins className="w-3 h-3" />
            {message.cost < 0.01 ? message.cost.toExponential(1) : message.cost.toFixed(3)}
          </span>
        )}
        {message.usage && typeof message.usage === "object" && "total" in message.usage && (
          <span>{formatTokens(Number((message.usage as { total?: number }).total) || null)} tok</span>
        )}
      </div>
      {message.text && (
        <p className="text-sm whitespace-pre-wrap break-words text-text-primary max-h-64 overflow-y-auto">
          {message.text}
        </p>
      )}
      {message.tools.length > 0 && (
        <div className="space-y-1">
          {message.tools.map((tool, index) => (
            <div key={index} className="flex items-center gap-2 text-xs text-text-secondary">
              <Wrench className="w-3 h-3 shrink-0" />
              <span className="text-text-primary">{tool.skill_name ?? tool.tool ?? "tool"}</span>
              {tool.status === "running" ? (
                <Loader2 className="w-3 h-3 text-accent animate-spin" />
              ) : tool.status === "error" || tool.status === "failed" ? (
                <AlertCircle className="w-3 h-3 text-error" />
              ) : (
                <span className="text-success">{tool.status}</span>
              )}
              {tool.duration_ms !== null && <span>{formatDuration(tool.duration_ms)}</span>}
            </div>
          ))}
        </div>
      )}
      {message.error && (
        <p className="text-xs text-error whitespace-pre-wrap break-words">{message.error}</p>
      )}
    </div>
  );
}

function KanbanHistory({ detail }: { detail: SessionDetailPayload }) {
  const intervals = [...detail.kanban_history].reverse();
  if (intervals.length === 0) {
    return <p className="text-sm text-text-secondary p-4">No recorded transitions yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {intervals.map((interval, index) => (
        <div
          key={index}
          className="flex items-center gap-2 rounded-md border border-border bg-surface p-2 text-xs"
        >
          <span className={`px-2 py-0.5 rounded-full ${COLUMN_BADGE[interval.column] ?? "bg-surface"}`}>
            {interval.column}
          </span>
          <span className="text-text-secondary">{formatRelativeTimeVerbose(interval.entered_at)}</span>
          <span className="flex-1" />
          <span className="text-text-primary font-medium">{formatDuration(interval.duration_ms)}</span>
          {interval.current && <span className="text-accent">current</span>}
        </div>
      ))}
    </div>
  );
}

function ModelsView({ detail }: { detail: SessionDetailPayload }) {
  if (detail.models.length === 0) {
    return <p className="text-sm text-text-secondary p-4">No model usage recorded.</p>;
  }
  return (
    <div className="space-y-2">
      {detail.models.map((model) => (
        <div key={model.model} className="rounded-md border border-border bg-surface p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-accent" />
            <span className="text-sm font-medium">{model.model}</span>
            <span className="text-xs text-text-secondary">{model.turns} turns</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-text-secondary">Input</div>
              <div className="text-text-primary">{formatTokens(model.tokens.input)}</div>
            </div>
            <div>
              <div className="text-text-secondary">Output</div>
              <div className="text-text-primary">{formatTokens(model.tokens.output)}</div>
            </div>
            <div>
              <div className="text-text-secondary">Reasoning</div>
              <div className="text-text-primary">{formatTokens(model.tokens.reasoning)}</div>
            </div>
            <div>
              <div className="text-text-secondary">Cache read</div>
              <div className="text-text-primary">{formatTokens(model.tokens.cache_read)}</div>
            </div>
            <div>
              <div className="text-text-secondary">Cache write</div>
              <div className="text-text-primary">{formatTokens(model.tokens.cache_write)}</div>
            </div>
            <div>
              <div className="text-text-secondary">Cost</div>
              <div className="text-text-primary">
                {model.cost < 0.01 && model.cost > 0 ? model.cost.toExponential(1) : model.cost.toFixed(4)}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function DetailsPanel({ sessionId, onClose }: Props) {
  const [detail, setDetail] = useState<SessionDetailPayload | null>(null);
  const [tab, setTab] = useState<TabKey>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/session/${sessionId}`);
        if (!response.ok) throw new Error(`session fetch failed: ${response.status}`);
        const payload = (await response.json()) as SessionDetailPayload;
        if (!cancelled) {
          setDetail(payload);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "unknown error");
      }
    };
    setDetail(null);
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  const filtered = useMemo<DetailMessage[]>(() => {
    if (!detail) return [];
    const agent = detail.messages.filter((m) => m.role !== "user");
    const user = detail.messages.filter((m) => m.role === "user");
    switch (tab) {
      case "agent":
        return agent.slice(0, AGENT_MESSAGE_LIMIT);
      case "user":
        return user;
      case "all":
        return [...user, ...agent.slice(0, AGENT_MESSAGE_LIMIT)];
      default:
        return [];
    }
  }, [detail, tab]);

  return (
    <aside
      className="w-[420px] shrink-0 border-l border-border bg-surface/50 flex flex-col min-h-0"
      data-testid="details-panel"
    >
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <ChevronRight className="w-4 h-4 text-accent shrink-0" />
        <h2 className="text-sm font-medium truncate flex-1" title={detail?.title ?? sessionId}>
          {detail?.title ?? sessionId}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-background text-text-secondary"
          aria-label="Close details"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {detail && detail.directory && (
        <div className="shrink-0 px-3 py-1.5 text-xs text-text-secondary border-b border-border flex items-center gap-2 min-w-0">
          <span className="truncate" title={detail.directory}>
            {detail.directory}
          </span>
          {detail.branch && (
            <span className="flex items-center gap-0.5 text-accent shrink-0" title={`git branch: ${detail.branch}`}>
              <GitBranch className="w-3 h-3" />
              {detail.branch}
            </span>
          )}
        </div>
      )}
      {detail?.exists && detail.mrs.length > 0 && (
        <div className="shrink-0 px-3 py-1.5 border-b border-border flex items-center gap-1.5 flex-wrap" data-testid="detail-mrs">
          <span className="text-xs text-text-secondary shrink-0">Merge requests:</span>
          {detail.mrs.map((mr) => (
            <a
              key={mr.url}
              href={mr.url}
              target="_blank"
              rel="noreferrer"
              title={mr.url}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-accent/10 border border-accent/40 text-accent hover:bg-accent/20"
            >
              <GitMerge className="w-3 h-3" />
              {mr.label}
            </a>
          ))}
        </div>
      )}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-border">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
              tab === key ? "bg-accent/10 text-accent" : "text-text-secondary hover:bg-background"
            }`}
            data-testid={`tab-${key}`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
        {error && <p className="text-sm text-error">{error}</p>}
        {!detail && !error && <p className="text-sm text-text-secondary p-4">Loading…</p>}
        {detail && !detail.exists && (
          <p className="text-sm text-text-secondary p-4">Session not found in the database.</p>
        )}
        {detail?.exists && (tab === "all" || tab === "agent" || tab === "user") &&
          (filtered.length === 0 ? (
            <p className="text-sm text-text-secondary p-4">No messages in this tab.</p>
          ) : (
            filtered.map((message, index) => <MessageView key={index} message={message} />)
          ))}
        {detail?.exists && tab === "models" && <ModelsView detail={detail} />}
        {detail?.exists && tab === "kanban" && <KanbanHistory detail={detail} />}
      </div>
    </aside>
  );
}

export type { ColumnKey };
