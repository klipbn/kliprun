export const DEFAULT_PORT = 8792 as const;

/** Board cache TTL: also drives re-classification cadence (debounce windows). */
export const BOARD_CACHE_TTL_MS = 1000 as const;

/** fs.watch debounce for the OpenCode DB WAL file. */
export const WATCH_DEBOUNCE_MS = 100 as const;

/** fs.watch debounce for Hermes instance heartbeat files. */
export const HERMES_DEBOUNCE_MS = 300 as const;

/** Interval for the ps/lsof TUI liveness scan. */
export const LIVENESS_INTERVAL_MS = 3000 as const;

/** Max TUI directories on the board (matches kliprun semantics). */
export const MAX_WATCHED_DIRECTORIES = 20 as const;

/** Messages analyzed per session. */
export const MESSAGE_LIMIT_PER_SESSION = 100 as const;

/** Classifier: fresh user turn keeps a session "running" for this long. */
export const DEBOUNCE_MS = 4000 as const;

/** Classifier: an assistant turn with no updates for this long is "Interrupted". */
export const STALE_STREAM_MS = 15 * 60_000;

/** Hermes heartbeat freshness window. */
export const HEARTBEAT_MAX_AGE_S = 30 as const;

export const TITLE_MAX = 90 as const;
export const SNIPPET_MAX = 140 as const;
export const REASON_MAX = 200 as const;
export const ERROR_MAX = 300 as const;
