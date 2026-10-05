import { Folder, Loader2, Mail, SquareTerminal } from "lucide-react";
import type { AgentSummary } from "@shared/types";

interface Props {
  sessionCount: number;
  projectCount: number;
  running: number;
  unread: number;
  agents: AgentSummary[];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${Math.abs(count) === 1 ? "" : "s"}`;
}

/** Bottom application status bar. */
export function StatusBar({ sessionCount, projectCount, running, unread, agents }: Props) {
  return (
    <footer
      className="shrink-0 flex items-center gap-3 px-4 py-1.5 border-t border-border bg-surface text-xs"
      aria-label="Application status"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center gap-1.5 text-text-primary" data-testid="session-count">
          <SquareTerminal className="w-3.5 h-3.5 text-accent" />
          {plural(sessionCount, "session")}
        </span>
        <span className="flex items-center gap-1.5 text-text-primary" data-testid="project-count">
          <Folder className="w-3.5 h-3.5 text-accent" />
          {plural(projectCount, "project")}
        </span>
      </div>

      <div className="flex-1 flex items-center justify-center gap-3 min-w-0 overflow-hidden">
        <span
          className="flex items-center gap-1.5 text-text-primary"
          title="Running"
          aria-label={`Running: ${running}`}
          data-testid="running-count"
        >
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
          {running}
        </span>
        <span
          className={`flex items-center gap-1.5 ${unread > 0 ? "text-warning" : "text-text-secondary"}`}
          title="Unread IDLE cards"
          aria-label={`Unread: ${unread}`}
          data-testid="unread-count"
        >
          <Mail className="w-3.5 h-3.5" />
          {unread}
        </span>
        {agents.length > 0 && (
          <span className="flex items-center gap-1.5 min-w-0 overflow-hidden" aria-label="Agents">
            {agents.map((agent) => (
              <span
                key={agent.name}
                className={`px-2 py-0.5 rounded-full border shrink-0 ${
                  agent.working
                    ? "bg-accent/10 text-accent border-accent/40"
                    : "bg-surface text-text-secondary border-border"
                }`}
              >
                {agent.name}
              </span>
            ))}
          </span>
        )}
      </div>

      <span className="text-text-secondary shrink-0" title="Application version" data-testid="version">
        v{__APP_VERSION__}
      </span>
    </footer>
  );
}
