# KlipRun — Agent Instructions

## Purpose

KlipRun is a local, read-only Kanban board for observing OpenCode and Codex CLI sessions
with a currently open TUI. It reads the OpenCode SQLite database directly
(read-only) and reacts to file changes; it never calls OpenCode APIs and never
manages OpenCode processes.

Codex CLI is a separate read-only adapter (`src/server/codex/`): SQLite
metadata plus bounded incremental rollout reads. Never write to Codex
storage or call Codex APIs. Only terminal-attached CLI processes qualify;
match their open rollouts or writer files first. For shared-daemon clients
in the same directory, match the remaining loaded CLI sessions as a set only
when their count equals the unmatched terminal count and every terminal has
the same live-session evidence. Do not invent individual PID-to-session links.
Only live Codex-managed-daemon file descriptors count, never writer files
merely present on disk. Otherwise
require one CLI session and one terminal per directory. Ambiguous matches
are omitted with `/api/health` diagnostics.
`source=vscode` alone never establishes CLI membership; paired with
`originator=codex-tui` it identifies a TUI using the shared app-server.
Cards/details carry
`source`; Codex IDs use `codex:<uuid>`. Unknown Codex status belongs in IDLE
with neutral styling, never an invented completion. Codex subagents and MR
extraction are out of scope for this adapter's first version.

## Mandatory safety boundaries

- Open `~/.local/share/opencode/opencode.db` **read-only** (`bun:sqlite`,
  `readonly: true`). Never write to it, never open it read-write.
- Never call OpenCode HTTP API endpoints; never send prompts, start or stop
  sessions, or approve permissions through KlipRun.
- The HTTP server must listen only on `127.0.0.1`.
- The history database at `~/.kliprun_bun/status-history.sqlite3` belongs to
  KlipRun; it stores only observed column intervals, never OpenCode data.
- The separate KlipRun-owned `usage.sqlite3` stores derived usage events,
  minimal session metadata, Running attribution and importer checkpoints.
  Never persist prompts, response text or tool inputs/outputs in this index.
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
- `src/server/usage/` — worker-based read-only history import, normalized
  request tokens, raw Running aggregation and statistics APIs. Import complete
  histories in bounded pages/chunks; do not use live detail/tail limits.
  Record board observations on the 3 s liveness loop without requiring a browser.
  Recover open intervals at the last saved observation, never at restart time.
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
  board entirely (`isHiddenIdleChild`). Column counts reflect displayed
  cards; parent cards carry `subagent_active`/`subagent_count` (working of
  total subagents). Failed subagents are also hidden; the parent carries
  `subagent_errors`/`subagent_error_notes` rendered as an error chip
  (hover for titles and error messages).
- Watch at most 20 directories (most recently updated first).
- Statistics history is independent of live board membership. Historical Codex
  records require `source=cli`, or `source=vscode` with `originator=codex-tui`;
  archived CLI sessions qualify, Codex subagents do not. Never add historical
  sessions to the board. Task rankings aggregate OpenCode descendants once.
- Work time is observed Running only: summed agent time and union activity time.
  Use raw intervals, preserving restart gaps; legacy intervals have unknown
  model/agent attribution. Filters select contributions inside task trees.
  Unknown dates enter all-history totals only; source costs show coverage.

## Configuration

- `KLIPRUN_BUN_PORT` (default 8792; `--port` flag wins).
- `KLIPRUN_BUN_DB` — path to the OpenCode database.
- `KLIPRUN_BUN_CODEX_HOME` — read-only Codex data directory, defaulting to
  `$CODEX_HOME` or `~/.codex`.
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
bun run test               # server, shared and statistics calendar/filter tests
bunx tsc -b                # typecheck (server + shared)
```

- For logic changes, add a regression test first where practical
  (see `src/server/__tests__/` and `src/shared/__tests__/`).
- For UI changes, keep the dark theme and verify in a browser on a real board
  page.
- Do not claim a check passed unless you ran the command.
