# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
