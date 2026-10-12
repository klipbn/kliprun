# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-10-12

### Added
- **KlipRun Agent Office**, opened next to Statistics or at `/office`: a shared
  pixel-art room with colorful coworkers representing live sessions and active
  subagents. Working agents type at a communal desk, waiting agents raise a hand,
  and idle agents rest on a couch. Errors and unknown statuses stay distinct.
- Work, Idle and Superwork zones. Agents enter Superwork automatically after
  more than one hour of continuous Running, with extra monitors, glow and faster
  typing animations. Empty zones retain their furniture.
- Two-line labels above each coworker show the session title, current status and
  elapsed working, idle or waiting time. Timers update every second; model names
  appear below coworkers, with explicit fallbacks for missing metadata.
- A pixel-art token Leaderboard lists current session titles, models and
  accumulated usage from the Statistics index, refreshed every 30 seconds.
  Sessions and subagents contribute their own usage once; context-window size
  is not used as a consumption total. Missing and partial data remain explicit.
- Bounded `GET /api/stats/office-usage` batches of up to 50 session IDs, handled
  by the statistics worker with indexed per-session queries.

### Changed
- Office uses English interface labels, a compact layout and windows instead
  of decorative slogans. Session names retain their original language.
- Coworkers and Leaderboard entries open the existing session details panel.
  Board, Statistics and Office support browser back/forward navigation while
  preserving Statistics filters.
- Office adapts to narrow screens, placing Leaderboard above the room and
  displaying details full-width. Animations respect reduced-motion settings.
- Standard tests now include Office rendering, zone thresholds, model labels,
  timers, stable colors and token-ranking regressions, plus batch API checks.

### Fixed
- Codex rollout and Hermes directory changes are also detected through file
  metadata in the existing watcher loop, recovering native notifications missed
  immediately after watcher registration.

## [0.8.4] - 2026-10-12

### Fixed
- Codex cards, session details and usage statistics now show the current
  session name after it is renamed. Sessions without a name or using an older
  Codex database schema continue to show their original title.

## [0.8.3] - 2026-10-11

### Fixed
- Codex approvals and answer selections inside tool wrappers now move live
  cards to Needs attention using fresh local codex-hermes status files.
  Answering returns the card to Running; waiting timers remain stable and
  waiting time is excluded from observed work. Invalid or stale Hermes
  evidence falls back to the journal, and completed turns stay idle.

## [0.8.2] - 2026-10-11

### Added
- `scripts/kliprun` process helper with `start`, `stop`, `restart`, `status`
  and `log` commands, plus `install` linking `kliprun-start`-style commands
  into `~/.local/bin` (or a given directory). Start refuses to touch a foreign
  process on the port; stop sends SIGTERM only to a recognized KlipRun server.

## [0.8.1] - 2026-10-11

### Fixed
- Codex 0.162 "code mode" TUI sessions persisted as `source=vscode` with
  `originator=codex_hermes_monitor` are now matched through the shared
  daemon's writer locks and counted in statistics; previously the live card
  was omitted as an ambiguous match. A shared `TUI_ORIGINATORS` allowlist now
  covers storage, liveness and the usage importer. Plain `vscode` records and
  `codex-desktop` remain excluded.

## [0.8.0] - 2026-10-07

### Added
- Usage statistics dashboard, opened from the upper-right button or `/stats`,
  with calendar periods and source, agent, model and project filters.
- Normalized token breakdowns, observed Running time, activity heatmaps,
  comparisons with the previous period and sortable task rankings. OpenCode
  task details include each subagent's contribution without double counting.
- Worker-based import of available OpenCode and Codex CLI history, including
  archived sessions, with durable checkpoints and explicit partial-data status.
  The separate local usage index stores no prompts or response/tool text.
- Read-only statistics APIs for summaries, task rankings and historical details.

### Changed
- Column observations continue while the server runs, even without an open
  browser. Running totals exclude Attention, IDLE and monitor downtime.
- Standard tests include the statistics calendar and URL-filter regressions.

## [0.7.0] - 2026-10-07

### Fixed
- Codex CLI sessions now show recorded model and token usage in the Models tab.
  Repeated cumulative token snapshots are not counted twice, and unavailable
  cost is shown as a dash.

## [0.6.2] - 2026-10-07

### Fixed
- Multiple Codex CLI windows in the same directory no longer hide each other
  when their number matches the remaining sessions held by the shared daemon.
  Exact session matches take priority; mismatched counts remain ambiguous.
- Context usage percentages on cards are rounded to whole numbers.

## [0.6.1] - 2026-10-07

### Fixed
- Resumed Codex CLI sessions no longer disappear when older sessions share
  their directory. Matching now also uses session-writer files held open by
  the CLI or a live managed Codex daemon, including sessions beyond the
  historical candidate limit. Stale files on disk do not count, and ambiguous
  matches remain excluded.

## [0.6.0] - 2026-10-06

### Added
- Codex CLI sessions on the same board as OpenCode, with source badges,
  session details, observed status history and live updates.
- Read-only Codex SQLite metadata and bounded incremental journal reads,
  including TUI sessions recorded as `source=vscode` with
  `originator=codex-tui` by the shared app-server.
- Confirmed input questions move Codex cards to Needs attention. Unknown
  states use neutral styling; permission dialogs cannot always be detected.
- `KLIPRUN_BUN_CODEX_HOME` for a custom Codex data directory and matching
  diagnostics in `/api/health`. Ambiguous sessions are omitted.

### Fixed
- Observed status intervals stop accumulating time when cards leave the board.
- Quiet SSE connections stay open long enough to receive the 30-second heartbeat.

## [0.5.0] - 2026-10-06

### Changed
- Selected cards are now clearly highlighted: a full accent-colored outline
  (inset ring) is drawn around the card. The status-colored left border
  (warning/accent/success/error) is preserved, so attention cards keep their
  pulse and running cards stay distinguishable while selected.
- Clicking an already-selected card no longer closes the details panel.
  Selection is sticky; the panel closes only via its close button.

## [0.4.0] - 2026-10-05

### Added
- Details panel, Kanban tab: a totals row above the transition list showing
  the cumulative time the card spent in each column. Only statuses with
  time greater than zero are shown; the running interval is included live
  (panel refreshes every 3 s).

## [0.3.0] - 2026-10-05

### Added
- Context-limit overrides via an optional JSON file
  (`KLIPRUN_BUN_MODEL_LIMITS`, defaults to `~/.kliprun_bun/model-limits.json`).
  Exact `"provider/model"` keys replace catalog values; `"provider/*"`
  wildcards fill only models the models.dev catalog does not know, so custom
  proxies finally get a context bar. Hot-reloaded by
  file mtime — no server restart needed for edits.

## [0.2.0] - 2026-10-05

### Added
- Parent cards carry a subagent chip (Bot icon) showing how many subagents
  are working out of the total spawned: `2/5` in accent color while any are
  active, plain total when all finished.
- Status bar splits running cards into main agents and subagents:
  `N agents · M subagents` (the subagent part appears only when M > 0).

### Changed
- Completed (IDLE) subagent cards are hidden from the board entirely —
  including the case where the parent card is in a different column or
  already IDLE. Only failed subagents (stage `Error`) stay visible. Session
  history and the details panel are unaffected.
- Column count badges reflect only the cards actually displayed.
- Hidden subagents no longer count towards the resting-agents summary, so
  agent statistics match the visible board.
