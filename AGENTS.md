# KlipRun — Agent Instructions

## Purpose

KlipRun is a local, read-only Kanban board for observing OpenCode sessions
with a currently open TUI. It reads the OpenCode SQLite database directly
(read-only) and reacts to file changes; it never calls OpenCode APIs and never
manages OpenCode processes.

## Mandatory safety boundaries

- Open `~/.local/share/opencode/opencode.db` **read-only** (`bun:sqlite`,
  `readonly: true`). Never write to it, never open it read-write.
- Never call OpenCode HTTP API endpoints; never send prompts, start or stop
  sessions, or approve permissions through KlipRun.
- The HTTP server must listen only on `127.0.0.1`.
- The history database at `~/.kliprun_bun/status-history.sqlite3` belongs to
  KlipRun; it stores only observed column intervals, never OpenCode data.
- Scrub potential secrets through `src/server/security.ts` before sending
  session details to the browser.
- Display cards, models, tokens only when present in the DB or model catalog;
  never infer from session names, never invent context limits.

## Architecture

```
fs.watch opencode.db-wal (100ms debounce)  ──┐
fs.watch ~/.cache/opencode-hermes/instances ─├─→ invalidate → SSE push + ETag poll
3s loop: ps + lsof + Hermes parse           ─┘
                     │
bun:sqlite (read-only) → Engine (classifier) → history → /api/board → React kanban
```

- `src/server/index.ts` — Hono bootstrap, CORS, static client serving, shutdown.
- `src/server/storage/db.ts`, `queries.ts` — read-only SQLite access. All queries
  must stay bounded (LIMIT) and index-friendly.
- `src/server/watcher.ts` — fs.watch on db/wal (preferring `-wal`) and the
  Hermes instances directory; debounced `change` events with rebinding.
- `src/server/liveness.ts` — TUI detection: `ps` + `lsof -d cwd` + Hermes
  heartbeats → open TUI directories, matched session ids, `waiting` sessions.
  Heartbeats older than 30 s are ignored.
- `src/server/classifier.ts` — message analysis, column classification
  (attention/running/idle), debounce 4 s, stale stream 15 min, card trees,
  session detail rendering.
- `src/server/history.ts` — Kanban column intervals in KlipRun's own SQLite.
- `src/server/boardService.ts` — board cache (TTL 1 s), rebuild orchestration,
  ETag, history recording, session detail.
- `src/server/modelLimits.ts` — model context limits from OpenCode's model
  catalog (`~/.cache/opencode/models.json`, env `KLIPRUN_BUN_MODELS`),
  reloaded by mtime. Unknown providers get no context bar.
- `src/server/vcs.ts` — current git branch per session directory: walk-up to
  `.git` (worktree `.git` file resolved to gitdir), cached 10 s. This is the
  *current* branch of the repo, not a historical session branch; containers
  without a repo show no branch.
- `src/server/mergeRequests.ts` — MR/PR links extracted ONLY from tool-call
  parts that created them (MCP `*_create_merge_request`/`*_create_pull_request`,
  bash `mr|pr create` commands, create-MR skills); URLs an agent merely read
  (grep/SQL output, foreign tasks) never count. Cached per session subtree
  revision. Shown as chips on cards and in the details panel.
- `src/server/routes/` — `/api/health`, `/api/board` (ETag/304),
  `/api/session/:id`, `/api/stream` (SSE, heartbeat 30 s).
- `src/client/` — React + Vite + Tailwind SPA, dark theme
  (`#0d1117`/`#58a6ff`); kanban cards carry status icons (spinner /
  attention "!" / read-unread envelopes), a git-branch chip, a subagent chip
  (`active/total`, Bot icon), MR chips and a context-window progress bar
  (accent → warning ≥70% → error ≥90%). The status bar splits running cards
  into agents and subagents.

## Key contracts

- **Board membership**: only Hermes-matched sessions, the latest root session
  per unmatched TUI directory, and their transitive children. `Engine.rebuild`
  computes the keep-set **before** classification — never classify every
  session in watched directories (that was a 12 s-rebuild performance bug;
  keep it that way).
- Analysis memoization: per-session `MessageInfo` is cached by the session
  subtree revision (`MAX(time_updated)`). Detail rendering is memoized the
  same way (LRU 32); MR extraction is cached per revision too.
- **Needs attention** = Hermes `currentSessionStatus == "waiting"` for the
  session, or a running `question` tool in a streaming turn.
- Part JSON blobs larger than 1 MB are skipped defensively.
- **Running**: fresh user turn < 4 s or streaming < 15 min.
- Columns: `attention` (sorted by stage_since), `running` (by last_event_at),
  `idle` (by finished_at/stage_since). Cards nest children only while sharing
  the parent's column; completed (IDLE) subagent cards are hidden from the
  board entirely (`isHiddenIdleChild` — only a subagent with stage `Error`
  stays visible). Column counts reflect displayed cards; parent cards carry
  `subagent_active`/`subagent_count` (working of total subagents).
- Watch at most 20 directories (most recently updated first).

## Configuration

- `KLIPRUN_BUN_PORT` (default 8792; `--port` flag wins).
- `KLIPRUN_BUN_DB` — path to the OpenCode database.
- `KLIPRUN_BUN_HOME` — defaults to `~/.kliprun_bun`.
- `KLIPRUN_BUN_MODELS` — path to the model catalog
  (defaults to `~/.cache/opencode/models.json`).
- `KLIPRUN_BUN_MODEL_LIMITS` — optional JSON with context-limit overrides
  (defaults to `$KLIPRUN_BUN_HOME/model-limits.json`). Exact `"provider/model"`
  keys replace catalog values; `"provider/*"` fills only models the catalog
  does not know (custom proxies). Hot-reloaded by mtime.

## Commands

```bash
bun install                # server deps
bun run dev                # server with --watch (port 8792)
bun run dev:client         # Vite dev server (5173, proxies /api → 8792)
bun run build              # build client into src/client/dist
bun run start              # production server (serves built client)
bun test src/server src/shared   # tests
bunx tsc -b                # typecheck (server + shared)
```

- For logic changes, add a regression test first where practical
  (see `src/server/__tests__/` and `src/shared/__tests__/`).
- For UI changes, keep the dark theme and verify in a browser on a real board
  page.
- Do not claim a check passed unless you ran the command.
