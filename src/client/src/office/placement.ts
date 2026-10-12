import type { CardPayload } from "@shared/types";

export type OfficeZone = "work" | "lounge" | "superwork";
export interface OfficePlacement { zone: OfficeZone; idleSince: number | null }

export function stateFor(card: CardPayload) {
  if (card.error) return "error";
  if (card.source === "codex" && card.stage === "Status unknown") return "unknown";
  if (card.column === "running") return "working";
  if (card.column === "attention") return "waiting";
  return "resting";
}

function zoneFor(card: CardPayload, now: number): OfficeZone {
  const state = stateFor(card);
  if (state === "working") {
    return card.running_since !== null && now - card.running_since > 3_600_000 ? "superwork" : "work";
  }
  return state === "waiting" ? "work" : "lounge";
}

export function updatePlacements(previous: Map<string, OfficePlacement>, cards: CardPayload[], now: number) {
  const next = new Map<string, OfficePlacement>();
  for (const card of cards) {
    const old = previous.get(card.session_id);
    let zone = zoneFor(card, now);
    let idleSince: number | null = null;
    // Only seat changes are delayed; displayed status and usage stay factual.
    if (old && old.zone !== "lounge" && stateFor(card) === "resting") {
      idleSince = old.idleSince ?? now;
      if (now - idleSince < 5000) zone = old.zone;
      else idleSince = null;
    }
    next.set(card.session_id, { zone, idleSince });
  }
  return next;
}
