import { useCallback, useMemo, useRef, useState } from "react";
import type { BoardPayload } from "@shared/types";
import {
  boardActivityCounts,
  createReadTracker,
  sessionCards,
  type ReadTracker,
  type TrackedCard,
} from "@shared/readTracker";

function flattenBoard(board: BoardPayload): TrackedCard[] {
  return (["attention", "running", "idle"] as const).flatMap((key) =>
    sessionCards(board.columns[key].cards),
  );
}

export interface ReadTrackerApi {
  isRead: (card: TrackedCard) => boolean;
  counts: { running: number; unread: number };
  markRead: (card: TrackedCard) => void;
}

export function useReadTracker(board: BoardPayload | null): ReadTrackerApi {
  const trackerRef = useRef<ReadTracker | null>(null);
  if (!trackerRef.current) trackerRef.current = createReadTracker(globalThis.localStorage ?? null);
  const tracker = trackerRef.current;
  const [version, setVersion] = useState(0);

  const cards = useMemo(() => (board ? flattenBoard(board) : []), [board]);

  const counts = useMemo(() => {
    // observe() drops stale entries so cards that left IDLE become unread again.
    tracker.observe(cards);
    return boardActivityCounts(cards, tracker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracker, cards, version]);

  const isRead = useCallback((card: TrackedCard) => tracker.isRead(card), [tracker, version]);

  const markRead = useCallback(
    (card: TrackedCard) => {
      tracker.markRead(card);
      setVersion((v) => v + 1);
    },
    [tracker],
  );

  return { isRead, counts, markRead };
}
