/**
 * Read/unread tracking for IDLE cards (createReadTracker,
 * boardActivityCounts). Pure logic, no React.
 */

/** Minimal storage interface (subset of DOM Storage). */
export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TrackedCard {
  session_id: string;
  column: string;
  stage_since?: number;
  finished_at?: number | null;
  children?: TrackedCard[];
}

export interface ReadTracker {
  isRead(card: TrackedCard): boolean;
  markRead(card: TrackedCard): void;
  /** Drop stored state for cards that are no longer IDLE (they become unread again after the next idle). */
  observe(cards: TrackedCard[]): void;
}

const STORAGE_KEY = "kliprun-bun.read-idle.v1";

function cardRevision(card: TrackedCard): string {
  return JSON.stringify([card.stage_since || 0, card.finished_at || 0]);
}

export function createReadTracker(storage: KVStorage | null): ReadTracker {
  let read = new Map<string, string>();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) read = new Map(JSON.parse(raw) as [string, string][]);
  } catch {
    // Storage may be blocked or contain invalid data.
  }
  const save = () => {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify([...read]));
    } catch {
      // Keep in-memory state.
    }
  };
  return {
    isRead: (card) => card.column === "idle" && read.get(card.session_id) === cardRevision(card),
    markRead(card) {
      if (card.column !== "idle") return;
      read.set(card.session_id, cardRevision(card));
      save();
    },
    observe(cards) {
      let changed = false;
      for (const card of cards) {
        if (card.column !== "idle" && read.delete(card.session_id)) changed = true;
      }
      if (changed) save();
    },
  };
}

/** Flatten a card tree into a list (parents first, then descendants). */
export function sessionCards(cards: TrackedCard[] | undefined | null): TrackedCard[] {
  const out: TrackedCard[] = [];
  const visit = (items: TrackedCard[] | undefined | null) => {
    for (const card of items ?? []) {
      out.push(card);
      visit(card.children);
    }
  };
  visit(cards);
  return out;
}

export interface ActivityCounts {
  running: number;
  unread: number;
}

export function boardActivityCounts(cards: TrackedCard[], tracker: ReadTracker): ActivityCounts {
  const counts: ActivityCounts = { running: 0, unread: 0 };
  for (const card of cards) {
    if (card.column === "running") counts.running += 1;
    if (card.column === "idle" && !tracker.isRead(card)) counts.unread += 1;
  }
  return counts;
}
