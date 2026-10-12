import type { CardPayload } from "@shared/types";

export type OfficeZone = "work" | "lounge" | "superwork";
export type OfficeArea = OfficeZone | "waiting";
export interface OfficePlacement { zone: OfficeZone; area: OfficeArea; seat: number; idleSince: number | null }

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
    const state = stateFor(card);
    let zone = zoneFor(card, now);
    let holdSeat = false;
    let idleSince: number | null = null;
    // Only seat changes are delayed; displayed status and usage stay factual.
    if (old && state === "unknown") {
      // Missing status evidence does not establish that the coworker stopped.
      zone = old.zone; holdSeat = true;
    } else if (old && old.zone !== "lounge" && state === "resting") {
      idleSince = old.idleSince ?? now;
      if (now - idleSince < 5000) { zone = old.zone; holdSeat = true; }
      else idleSince = null;
    }
    const area = holdSeat ? old!.area : zone === "work" && state === "waiting" ? "waiting" : zone;
    const seat = old?.area === area ? old.seat : -1;
    next.set(card.session_id, { zone, area, seat, idleSince });
  }
  const occupied: Record<OfficeArea, Set<number>> = { work: new Set(), waiting: new Set(), superwork: new Set(), lounge: new Set() };
  // Reserve surviving seats before assigning newcomers, regardless of ID order.
  for (const placement of next.values()) if (placement.seat >= 0) occupied[placement.area].add(placement.seat);
  for (const placement of next.values()) {
    if (placement.seat >= 0) continue;
    let seat = 0;
    while (occupied[placement.area].has(seat)) seat++;
    placement.seat = seat;
    occupied[placement.area].add(seat);
  }
  return next;
}
