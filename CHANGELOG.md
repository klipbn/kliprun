# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
