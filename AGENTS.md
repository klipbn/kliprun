# KlipRun — Agent Instructions

## Purpose

KlipRun is a local, read-only monitor with Kanban, Statistics and Agent Office views
for observing OpenCode and Codex CLI sessions with a currently open TUI.
It reads the OpenCode SQLite database directly
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
`originator=codex-tui` (or `originator=codex_hermes_monitor`, how Codex
0.162 "code mode" persists working TUI threads) it identifies a TUI using
the shared app-server. The TUI-originator allowlist lives in
`src/server/codex/storage.ts` (`TUI_ORIGINATORS`); keep storage, liveness
and the usage importer on the same predicate.
Cards/details carry
`source`; Codex IDs use `codex:<uuid>`. On the board, unknown Codex status belongs in IDLE
with neutral styling, never an invented completion. Codex subagents and MR
extraction are out of scope for this adapter's first version.
For Codex titles, read `threads.name` when nonempty and fall back to
`threads.title`; apply this to live cards/details and historical usage imports.

Codex waiting/busy status can also come from bounded reads of local
codex-hermes files (`src/server/codex/hermes.ts`, `CODEX_HERMES_BASE_DIR`).
Apply them only after CLI membership is established. Require a fresh watcher
heartbeat and, for daemon records, fresh connected-daemon evidence; hooks
require the same active journal turn. Newer journal events and confirmed
turn endings take precedence. Invalid or stale evidence falls back to the
journal. Preserve waiting/working transition times across heartbeat updates.

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
bun:sqlite (read-only) → Engine (classifier) → history → /api/board → Board + Office
```

- `src/server/index.ts` — Hono bootstrap, CORS, static client serving, shutdown.
- `src/server/storage/db.ts`, `queries.ts` — read-only SQLite access. All queries
  must stay bounded (LIMIT) and index-friendly.
- `src/server/watcher.ts` — fs.watch on db/wal (preferring `-wal`) and the
  Hermes instances directory, plus Codex DB/WAL, rollouts and Hermes session
  paths. The existing 100 ms rebind loop checks inode, mtime and size for Codex
  targets to recover missed native notifications; reuse these metadata checks.
- `src/server/liveness.ts` — TUI detection: `ps` + `lsof -d cwd` + Hermes
  heartbeats → open TUI directories, matched session ids, `waiting` sessions.
  Heartbeats older than 30 s are ignored.
- `src/server/classifier.ts` — message analysis, column classification
  (attention/running/idle), debounce 4 s, stale stream 15 min, card trees,
  session detail rendering.
- `src/server/history.ts` — Kanban column intervals in KlipRun's own SQLite.
- `src/server/boardService.ts` — board cache (TTL 1 s), rebuild orchestration,
  ETag, history recording, session detail.
- `src/server/codex/hermes.ts` — read-only waiting/busy evidence from Hermes;
  its sessions directory is watched for Codex board updates.
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
- `src/client/src/App.tsx` — Board (`/`), Statistics (`/stats`) and Office
  (`/office`) navigation, shared live board data and session details. Preserve
  browser back/forward behavior and remembered Statistics query filters.
- `src/client/src/office/` — pixel-art Office. Read `placement.ts` before
  changing seating; `Office.tsx` owns room capacity, `Leaderboard.tsx` loads
  usage, and `office.css` / `meeting-room.svg` define the room presentation.

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
  records require `source=cli`, or `source=vscode` with a TUI originator
  (`codex-tui`/`codex_hermes_monitor`);
  archived CLI sessions qualify, Codex subagents do not. Never add historical
  sessions to the board. Task rankings aggregate OpenCode descendants once.
- Work time is observed Running only: summed agent time and union activity time.
  Use raw intervals, preserving restart gaps; legacy intervals have unknown
  model/agent attribution. Filters select contributions inside task trees.
  Unknown dates enter all-history totals only; source costs show coverage.

## Office presentation contracts

- Render only current board cards and their visible descendants, each once.
  Placement is client-only: badges and time counters use observed status;
  classification, history and Running attribution use raw server observations.
- Desktop room order is a 2×2 grid: Work / Idle above Meeting / Superwork.
  Narrow screens use Work → Idle → Meeting → Superwork. Meeting and Superwork
  have plain English headings without emoji or icons. Start empty rooms with
  compact footprints rather than spanning both desktop rows.
- Superwork requires Running with a known `running_since` older than one hour.
  Attention sessions enter Meeting immediately; errors remain immediate.
  Initial Idle sessions start in the lounge. Existing coworkers move there only
  after five continuous seconds of client-observed Idle; resuming cancels that move.
- Unknown status keeps an existing coworker's last known seat with a neutral
  label; it establishes neither completion nor continued work. A new unknown
  session starts in the lounge. Unknown snapshots do not confirm an Idle pause.
- Reserve surviving seat numbers before assigning newcomers; reuse holes
  without compacting neighbors. Keep room capacity at its observed high-water
  mark for the current view, including initial active/unknown desk reservations.
  Empty slots and stable scrollbar width prevent room and coworker jumps.
  Keep coworker colors keyed by `session_id`, independent of sorting or status.
- Labels show the session title and status duration above, and the recorded
  model below; use explicit unknown/dash fallbacks. Timers tick every second.
- Known Idle/error coworkers in the lounge raise a hand for an unread Idle
  revision, using the shared Kanban read tracker. Opening their details on Board
  or Office marks that revision read; a later completion becomes unread again.
  Unknown status stays neutral. This review pose changes neither status nor room.
- Leaderboard shows current session titles, models and nine full desktop rows.
  Read all-history per-session totals through `/api/stats/office-usage`:
  validated batches of at most 50 repeated `session` parameters, worker-side
  indexed sums, refreshed every 30 s. Each subagent contributes its own usage
  once. Board `tokens_total` is not accumulated consumption; preserve missing
  and partial-data markers rather than substituting context tokens or zero.

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
bun run test               # server, shared, statistics and Office tests
bunx tsc -b                # typecheck (server + shared)
```

- For logic changes, add a regression test first where practical
  (see `src/server/__tests__/`, `src/shared/__tests__/` and
  `src/client/src/office/__tests__/`).
- For UI changes, keep the dark theme and verify in a browser on a real board
  page at desktop/mobile widths. Office checks include empty/occupied rooms,
  short Idle and unknown transitions, newcomer/removal seating, and 0–2
  Superwork coworkers. Verify reduced-motion behavior when changing animation.
- README and public preview screenshots use **fictional** sessions, projects,
  paths, messages and usage. Capture in an isolated browser context with every
  API response overridden and unmatched API requests blocked; inspect the final
  images for leaks or invalid values. Keep Office first in the README previews.
- Do not claim a check passed unless you ran the command.
