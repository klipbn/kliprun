import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { ArrowLeft } from "lucide-react";
import type { BoardPayload, CardPayload } from "@shared/types";
import { formatDuration } from "@shared/format";
import { colorFor, Mascot, modelName } from "./appearance";
import { OfficeLeaderboard, useOfficeUsage } from "./Leaderboard";
import { stateFor, updatePlacements, type OfficeArea, type OfficePlacement, type OfficeZone } from "./placement";
import "./office.css";

const CAPTIONS = {
  working: "Shipping tiny miracles", waiting: "A human is required",
  resting: "On a coffee break", unknown: "Status unknown", error: "A little technical drama",
};

function Workstation({ state, small, zone }: { state: ReturnType<typeof stateFor>; small: boolean; zone: OfficeZone }) {
  const atDesk = state === "working";
  return <svg viewBox="0 0 240 164" className="office-station" aria-hidden="true" shapeRendering="crispEdges">
    <ellipse cx="120" cy="145" rx="83" ry="9" fill="#101722" opacity=".35" />
    {zone === "superwork" && <g className="office-reactor-screen">
      <path d="M20 63h44v38H20z" fill="#202c40" /><path d="M24 67h36v29H24z" fill="#111a29" />
      <path d="M28 74h23v3H28zM28 82h16v3H28zM28 90h27v3H28z" fill="#d5a6ff" />
      <path d="M38 101h8v13h-8z" fill="#26344b" />
      <path className="office-sparks" d="M61 34h7v-9h6v18h-7v9h-6zM174 30h5v-8h5v15h-5v8h-5z" fill="#efd081" />
    </g>}
    <Mascot small={small} />
    {atDesk && <g>
      <path d="M173 68h43v34h-43z" fill="#202c40" /><path d="M177 72h35v25h-35z" fill="#111a29" />
      <g className="office-screen" fill="var(--resident-color)"><path d="M181 77h15v3h-15zM181 83h23v3h-23zM181 89h10v3h-10z" />
        <path className="office-cursor" d="M197 89h5v3h-5z" /></g>
      <path d="M191 102h7v9h-7zM182 110h25v4h-25z" fill="#26344b" />
      <path d="M113 109h42v5h-42z" fill="#66758b" /><path d="M117 110h34v2h-34z" fill="#abb8c8" />
    </g>}
    <g className="office-mug">
      <path d={!atDesk ? "M153 89h17v18h-17zM170 93h6v10h-6z" : "M62 101h13v14H62zM75 104h5v8h-5z"} fill="#e4d9ba" />
      <path className="office-steam" d={!atDesk ? "M158 74h3v9h-3zM165 70h3v9h-3z" : "M65 89h2v8h-2zM71 86h2v8h-2z"} fill="#e4d9ba" opacity=".5" />
    </g>
    {state === "waiting" && <g className="office-bubble"><path d="M132 13h30v28h-18l-8 8v-8h-4z" fill="#efd081" /><text x="147" y="34" textAnchor="middle" fill="#392e21" fontSize="22" fontWeight="bold">?</text></g>}
    {state === "error" && <g className="office-bubble"><path d="M132 13h30v28h-18l-8 8v-8h-4z" fill="#f38c86" /><text x="147" y="34" textAnchor="middle" fill="#392e21" fontSize="22" fontWeight="bold">!</text></g>}
    {state === "unknown" && <text x="150" y="36" fill="#9aa9be" fontSize="22">?</text>}
    {state === "resting" && <text className="office-zzz" x="147" y="42" fill="#a5b6cc" fontSize="16">z z</text>}
  </svg>;
}

export default function Office({ board, onSelect, onBack, now = Date.now() }: {
  board: BoardPayload | null; onSelect: (id: string) => void; onBack?: () => void; now?: number;
}) {
  const residents = useMemo(() => {
    const result: CardPayload[] = [];
    const seen = new Set<string>();
    const visit = (cards: CardPayload[]) => {
      for (const card of cards) {
        if (seen.has(card.session_id)) continue;
        seen.add(card.session_id);
        result.push(card);
        visit(card.children);
      }
    };
    if (board) for (const key of ["running", "attention", "idle"] as const) visit(board.columns[key].cards);
    return result.sort((a, b) => a.session_id.localeCompare(b.session_id));
  }, [board]);
  const previousPlacements = useRef(new Map<string, OfficePlacement>());
  const previousCapacity = useRef<Record<OfficeArea, number>>({ work: 0, waiting: 0, superwork: 0, lounge: 0 });
  const placements = useMemo(() => updatePlacements(previousPlacements.current, residents, now), [residents, now]);
  const capacity = useMemo(() => {
    const next = { ...previousCapacity.current };
    // Unknown sessions may report activity on the next snapshot; reserve their desks now.
    const potentialWorkers = residents.filter(card => {
      const state = stateFor(card);
      if (state === "resting" || state === "error") return false;
      const last = previousPlacements.current.get(card.session_id);
      return state !== "unknown" || !last || last.zone !== "lounge";
    }).length;
    next.work = Math.max(next.work, potentialWorkers);
    for (const placement of placements.values()) next[placement.area] = Math.max(next[placement.area], placement.seat + 1);
    return next;
  }, [placements, residents]);
  useEffect(() => { previousPlacements.current = placements; previousCapacity.current = capacity; }, [placements, capacity]);
  const { usage, pending, error } = useOfficeUsage(residents.map(card => card.session_id));
  const working = residents.filter(c => stateFor(c) === "working").length;
  const waiting = residents.filter(c => stateFor(c) === "waiting").length;
  const zones: Record<OfficeZone, CardPayload[]> = { work: [], lounge: [], superwork: [] };
  for (const card of residents) zones[placements.get(card.session_id)!.zone].push(card);

  const renderResident = (card: CardPayload, zone: OfficeZone) => {
    const state = stateFor(card);
    const since = state === "working" ? card.running_since : state === "unknown" ? null : card.stage_since;
    const duration = since !== null && since > 0 && Number.isFinite(since) ? formatDuration(Math.max(0, now - since)) : null;
    const timerLabel = { working: "Working", resting: "Idle", waiting: "Waiting", error: "Error", unknown: "Status unknown" }[state];
    const model = modelName(card);
    return <button type="button" key={card.session_id} data-session-id={card.session_id} data-office-state={state} data-office-zone={zone}
      className={`office-resident office-${state}`} style={{ "--resident-color": colorFor(card.session_id) } as CSSProperties}
      onClick={() => onSelect(card.session_id)} aria-label={`${card.title} — ${CAPTIONS[state]} — ${card.stage}`}
      title={`${card.title}\n${card.directory_name} · ${model}${card.parent_id ? " · Subagent" : ""}\n${card.stage}${duration ? ` · ${duration}` : ""}${card.error ? `\n${card.error}` : ""}`}>
      <span className="office-timer" data-timer-state={state}>
        <span className="office-timer-session">{card.title}</span>
        <span>{timerLabel}{duration ? ` · ${duration}` : state === "unknown" ? "" : " · —"}</span>
      </span>
      <Workstation state={state} small={!!card.parent_id} zone={zone} />
      <span className="office-nameplate"><span className="office-model-label">{model}</span>{card.parent_id && <small>Subagent</small>}</span>
      <span className="office-tooltip"><strong>{card.title}</strong><span>{card.directory_name} · {card.source}</span>
        <span>{card.stage} · {CAPTIONS[state]}</span>{card.error && <span>{card.error}</span>}</span>
    </button>;
  };

  const renderSeats = (area: OfficeArea) => {
    const occupants = new Map<number, CardPayload>();
    for (const card of residents) {
      const placement = placements.get(card.session_id)!;
      if (placement.area === area) occupants.set(placement.seat, card);
    }
    return Array.from({ length: capacity[area] }, (_, seat) => {
      const card = occupants.get(seat);
      return <div className="office-seat" key={seat} aria-hidden={card ? undefined : true}>
        {card && renderResident(card, placements.get(card.session_id)!.zone)}
      </div>;
    });
  };

  return <section className="office-page" aria-label="Live agent office" data-testid="office-page">
    <div className="office-heading">
      <div><div className="office-eyebrow">KLIPRUN / AFTER HOURS DEPARTMENT</div>
        <h2>KlipRun Agent Office<span className="office-live"><i /> LIVE</span></h2></div>
      {onBack && <button type="button" className="office-back" onClick={onBack}><ArrowLeft size={14} /> Board</button>}
    </div>
    <div className="office-layout">
      <OfficeLeaderboard residents={residents} usage={usage} pending={pending} error={error} onSelect={onSelect} />
    <div className="office-room">
      <div className="office-wall">
        <div className="office-window"><span /><span /><span /><span /></div>
        <div className="office-window office-window-center"><span /><span /><span /><span /></div>
        <div className="office-clock" aria-hidden="true"><span /></div>
        <div className="office-plant" aria-hidden="true">✦<span /></div>
      </div>
      {!board ? <div className="office-empty" role="status">Loading office…</div> : residents.length === 0 ?
        <div className="office-empty"><h3>The office is quiet</h3><p>Open an OpenCode or Codex terminal session to bring a coworker in.</p></div> : null}
      <div className="office-floor">
        <section className="office-zone office-zone-work" data-zone="work" aria-label="Work zone">
          <div className="office-zone-heading"><h3>Work zone</h3><span>{zones.work.length} on task</span></div>
          <div className="office-seats office-desks">{renderSeats("work")}
            {!residents.some(c => placements.get(c.session_id)!.area === "work") && <div className="office-vacant">Monitors are on. The team will be back soon.</div>}</div>
          <div className="office-help-desk"><span className="office-help-sign">Human needed ↗</span>
            <div className="office-waiting-line">{renderSeats("waiting")}
              {!residents.some(c => placements.get(c.session_id)!.area === "waiting") && <span className="office-no-questions">No questions for now</span>}</div></div>
        </section>
        <section className="office-zone office-zone-superwork" data-zone="superwork" aria-label="Superwork zone">
          <div className="office-zone-heading"><h3>⚡ Superwork</h3><span>{zones.superwork.length} in the flow</span></div>
          <div className="office-reactor" aria-hidden="true"><span /><span /><span /><small>FLOW CORE / 60+ MIN</small></div>
          <div className="office-seats office-desks">{renderSeats("superwork")}</div>
        </section>
        <section className="office-zone office-zone-lounge" data-zone="lounge" aria-label="Idle zone">
          <div className="office-zone-heading"><h3>Idle zone</h3><span>{zones.lounge.length} on a break</span></div>
          <div className="office-coffee-corner" aria-hidden="true"><div className="office-coffee-machine"><span />☕</div><small>COFFEE.exe</small></div>
          <div className="office-seats office-sofas">{renderSeats("lounge")}
            {!zones.lounge.length && <div className="office-vacant">The couch is free. So are the cookies.</div>}</div>
        </section>
      </div>
      <div className="office-footer"><span><i className="office-dot-working" />{working} working</span><span><i className="office-dot-waiting" />{waiting} waiting for you</span>
        <span><i className="office-dot-superwork" />{zones.superwork.length} superworking</span>
        <span className="office-footer-note">Hover over a coworker or click to view their task ↗</span></div>
    </div>
    </div>
  </section>;
}
