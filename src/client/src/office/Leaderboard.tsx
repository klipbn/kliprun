import { useEffect, useState, type CSSProperties } from "react";
import type { CardPayload } from "@shared/types";
import type { OfficeUsagePayload } from "@shared/usage";
import { formatTokens } from "@shared/format";
import { colorFor, Mascot, modelName } from "./appearance";

export function useOfficeUsage(sessionIds: string[]) {
  const key = sessionIds.join(",");
  const [state, setState] = useState<{ key: string; usage: OfficeUsagePayload | null; pending: boolean; error: string | null }>({
    key: "", usage: null, pending: false, error: null,
  });
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setState(previous => ({ key, usage: previous.key === key ? previous.usage : null, pending: true, error: null }));
      try {
        const rows: OfficeUsagePayload["rows"] = [];
        // Keep requests bounded, including offices with many active subagents.
        for (let start = 0; start < ids.length; start += 50) {
          const query = new URLSearchParams(ids.slice(start, start + 50).map(id => ["session", id]));
          const response = await fetch(`/api/stats/office-usage?${query}`, { signal: controller.signal });
          if (!response.ok) throw new Error("Unable to refresh leaderboard");
          rows.push(...((await response.json()) as OfficeUsagePayload).rows);
        }
        if (!controller.signal.aborted) setState({ key, usage: { rows }, pending: false, error: null });
      } catch {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, pending: false, error: "Unable to refresh leaderboard" }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 30_000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key]);
  return state.key === key ? state : { usage: null, pending: !!key, error: null };
}

export function OfficeLeaderboard({ residents, usage, pending, error, onSelect }: {
  residents: CardPayload[]; usage: OfficeUsagePayload | null; pending: boolean; error: string | null; onSelect: (id: string) => void;
}) {
  const totals = new Map(usage?.rows.map(row => [row.session_id, row]) ?? []);
  const ranked = [...residents].sort((a, b) => (totals.get(b.session_id)?.tokens ?? -1) - (totals.get(a.session_id)?.tokens ?? -1)
    || a.session_id.localeCompare(b.session_id));
  return <aside className="office-leaderboard" aria-label="Token usage leaderboard">
    <div className="office-leaderboard-header"><svg viewBox="0 0 24 24" aria-hidden="true" shapeRendering="crispEdges">
      <path d="M6 3h12v9h-3v3h-2v4h5v3H6v-3h5v-4H9v-3H6zM2 5h4v3H4v3h2v3H2zM18 5h4v9h-4v-3h2V8h-2z" fill="#efd081" /></svg>
      <h3>Leaderboard</h3></div>
    {error && <p className="office-leaderboard-message" role="status">{error}{usage ? ". Showing the last available data." : ""}</p>}
    {pending && !usage && <p className="office-leaderboard-message" role="status">Counting tokens…</p>}
    {!residents.length && <p className="office-leaderboard-message">Waiting for the team</p>}
    <ol className="office-leaderboard-list">{ranked.map((card, index) => {
      const total = totals.get(card.session_id);
      const known = total?.tokens !== null && total?.tokens !== undefined;
      return <li key={card.session_id}><button type="button" data-leaderboard-session={card.session_id}
        onClick={() => onSelect(card.session_id)} style={{ "--resident-color": colorFor(card.session_id) } as CSSProperties}
        title={`${card.title}\n${modelName(card)}\n${known ? `${total.tokens!.toLocaleString("en-US")} tokens${total.incomplete ? " · Partial data" : ""}` : "No data"}`}>
        <span className="office-leaderboard-rank">{known ? String(index + 1).padStart(2, "0") : "—"}</span>
        <svg className="office-leaderboard-avatar" viewBox="60 40 110 90" shapeRendering="crispEdges" aria-hidden="true"><Mascot /></svg>
        <span className="office-leaderboard-entry"><span className="office-leaderboard-session">{card.title}</span>
          <span className="office-leaderboard-model">{modelName(card)}</span>
          <span className="office-leaderboard-tokens">{known ? `${total.incomplete ? "≈ " : ""}${formatTokens(total.tokens)}` : "No data"}</span></span>
      </button></li>;
    })}</ol>
  </aside>;
}
