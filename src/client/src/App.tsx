import { useCallback, useState } from "react";
import type { CardPayload, ColumnKey } from "@shared/types";
import type { TrackedCard } from "@shared/readTracker";
import { sessionCards } from "@shared/readTracker";
import { useBoard, useNow } from "./hooks/useBoard";
import { useReadTracker } from "./hooks/useReadTracker";
import { BoardColumn } from "./components/BoardColumn";
import { DetailsPanel } from "./components/DetailsPanel";
import { StatusBar } from "./components/StatusBar";
import { formatRelativeTimeVerbose } from "@shared/format";

function ConnectionIndicator(state: "connecting" | "live" | "polling", error: string | null) {
  let dot = "bg-warning animate-pulse";
  let text = "Connecting…";
  if (error && state !== "live") {
    dot = "bg-error";
    text = "Offline";
  } else if (state === "live") {
    dot = "bg-success shadow-[0_0_8px_#3fb95099]";
    text = "Connected";
  } else if (state === "polling") {
    dot = "bg-success";
    text = "Connected (polling)";
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-text-secondary" data-testid="connection">
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} aria-hidden="true" />
      {text}
    </div>
  );
}

export default function App() {
  const { board, connection, error } = useBoard();
  const now = useNow();
  const { isRead, counts, markRead } = useReadTracker(board);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const select = useCallback(
    (id: string) => {
      setSelectedId((prev) => {
        if (prev === id) return prev;
        // Opening details marks an IDLE card as read.
        const card = board ? findCard(board, id) : null;
        if (card) markRead(card as TrackedCard);
        return id;
      });
    },
    [board, markRead],
  );

  const loading = board === null;

  return (
    <div className="h-screen flex flex-col bg-background text-text-primary">
      <header className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border bg-surface">
        <div className="flex items-center gap-2">
          <img src="/kliprun-icon.png" alt="" className="w-6 h-6" />
          <h1 className="font-semibold text-lg">KlipRun</h1>
        </div>
        <div className="flex-1" />
        {error && <span className="text-xs text-error">{error}</span>}
        {ConnectionIndicator(connection, error)}
        {board && (
          <span className="text-xs text-text-secondary">
            updated {formatRelativeTimeVerbose(board.generated_at)}
          </span>
        )}
      </header>

      <main className="flex-1 min-h-0 flex">
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-secondary" data-testid="loading-screen">
            <Loader2Impl />
            <p className="text-sm">Loading sessions…</p>
            {error && <p className="text-xs text-error">{error}</p>}
          </div>
        ) : (
          <>
            <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-3 gap-3 p-3">
              {(["attention", "running", "idle"] as ColumnKey[]).map((key) => (
                <BoardColumn
                  key={key}
                  columnKey={key}
                  column={board?.columns[key] ?? { title: key, count: 0, cards: [] }}
                  selectedId={selectedId}
                  now={now}
                  isRead={isRead}
                  onSelect={select}
                />
              ))}
            </div>
            {selectedId && (
              <DetailsPanel sessionId={selectedId} onClose={() => setSelectedId(null)} />
            )}
          </>
        )}
      </main>

      <StatusBar
        sessionCount={
          board ? board.columns.attention.count + board.columns.running.count + board.columns.idle.count : 0
        }
        projectCount={board?.project_count ?? 0}
        running={counts.running}
        agentsRunning={counts.agents_running}
        subagentsRunning={counts.subagents_running}
        unread={counts.unread}
        agents={board?.agents ?? []}
      />
    </div>
  );
}

function Loader2Impl() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="text-accent animate-spin"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" pathLength="100" strokeDasharray="75 25" />
    </svg>
  );
}

function findCard(
  board: NonNullable<ReturnType<typeof useBoard>["board"]>,
  sessionId: string,
): TrackedCard | null {
  for (const key of ["attention", "running", "idle"] as ColumnKey[]) {
    const found = sessionCards(board.columns[key].cards).find((card) => card.session_id === sessionId);
    if (found) return found;
  }
  return null;
}

export type { CardPayload };
