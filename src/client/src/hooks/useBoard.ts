import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardPayload } from "@shared/types";

export type ConnectionState = "connecting" | "live" | "polling";

interface BoardState {
  board: BoardPayload | null;
  connection: ConnectionState;
  error: string | null;
}

export function useBoard(pollMs = 2000) {
  const [state, setState] = useState<BoardState>({
    board: null,
    connection: "connecting",
    error: null,
  });
  const etagRef = useRef<string | null>(null);

  const fetchBoard = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (etagRef.current) headers["If-None-Match"] = etagRef.current;
      const response = await fetch("/api/board", { headers });
      if (response.status === 304) {
        setState((prev) => (prev.error ? { ...prev, error: null } : prev));
        return;
      }
      if (!response.ok) throw new Error(`board fetch failed: ${response.status}`);
      const etag = response.headers.get("ETag");
      if (etag) etagRef.current = etag;
      const board = (await response.json()) as BoardPayload;
      setState((prev) => ({ ...prev, board, error: null }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : "unknown error",
      }));
    }
  }, []);

  useEffect(() => {
    void fetchBoard();
    const poll = setInterval(() => void fetchBoard(), pollMs);
    return () => clearInterval(poll);
  }, [fetchBoard, pollMs]);

  useEffect(() => {
    const source = new EventSource("/api/stream");
    const onOpen = () => {
      setState((prev) => ({ ...prev, connection: "live" }));
      void fetchBoard();
    };
    const onBoardUpdate = () => void fetchBoard();
    const onError = () => {
      setState((prev) => ({ ...prev, connection: "polling" }));
    };
    source.addEventListener("open", onOpen);
    source.addEventListener("board-update", onBoardUpdate);
    source.addEventListener("error", onError);
    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("board-update", onBoardUpdate);
      source.removeEventListener("error", onError);
      source.close();
    };
  }, [fetchBoard]);

  return state;
}

/** Re-render tick for live duration counters. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
