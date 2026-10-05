# KlipRun

[![Bun](https://img.shields.io/badge/bun-1.4%2B-fa0)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**A local, read-only Kanban board for observing OpenCode sessions.** KlipRun
shows active sessions, requests that need your attention, and idle sessions
whose OpenCode TUI is still open. It never sends commands to OpenCode or
changes session state.

KlipRun reads the OpenCode database directly (read-only) and reacts to file
changes — no background services to manage and no OpenCode API calls. Board
updates reach the browser in ~100 ms over Server-Sent Events.

## Preview

![KlipRun dashboard](docs/screenshot.png)

## Features

- Three columns: **Needs attention**, **Running**, and **IDLE**.
- Session cards with the title, agent, current stage (`Tool: bash`,
  `Generating response`, …), elapsed time, and child-agent count.
- **Context window bar** per card: model name, percent of the context window
  spent, and used/limit tokens (limits come from OpenCode's own model catalog;
  unknown providers show plain token counts).
- **Git branch chip**: the current branch of the session's repository
  (worktrees included).
- **Merge request chips**: MRs/PRs created by the session, extracted from the
  tool calls that created them — on the card and in the details panel.
- **Read/unread envelopes**: idle cards show a closed envelope until you open
  them; the status bar counts unread sessions.
- A details panel with messages (All / Agent / User), model usage and cost,
  and Kanban column history.
- Bottom status bar: session and project counts, running and unread counters,
  working agents, and the app version.
- Live updates over Server-Sent Events with ETag polling fallback.
- Monitoring of up to 20 directories with an OpenCode TUI currently open.

## Requirements

- macOS (uses `ps`/`lsof` for TUI detection).
- [Bun](https://bun.sh/) 1.4 or newer.
- OpenCode CLI (`opencode`) with sessions on disk.

## Install and run

Clone and run from the repository root:

```bash
bun install
bun run build     # build the web client
bun run start     # http://127.0.0.1:8792
```

Development:

```bash
bun run dev            # server with --watch on :8792
bun run dev:client     # Vite dev server on :5173, proxies /api → :8792
```

## How session cards are classified

- **Needs attention** — the TUI is waiting for a permission or an answer
  (confirmed via local Hermes heartbeat status, or a running `question` tool
  call in the open session history).
- **Running** — a fresh user turn (under 4 s) or an assistant turn still
  streaming (under 15 min without updates).
- **IDLE** — finished, inactive, or interrupted sessions left open in a TUI.
  An active response with no updates for over 15 minutes is treated as
  interrupted, not current work.

Only sessions mapped to a live TUI stay on the board: Hermes-matched sessions,
the latest session per unmatched TUI directory, and their transitive
sub-agent children. KlipRun detects TUI processes with `ps`/`lsof`, maps
windows to sessions through fresh heartbeat files under
`~/.cache/opencode-hermes/instances/*.json`, and falls back to the latest
session in a directory when Hermes is unavailable.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `KLIPRUN_BUN_PORT` | Local web server port (`--port` flag wins) | `8792` |
| `KLIPRUN_BUN_DB` | OpenCode SQLite database (opened read-only) | `~/.local/share/opencode/opencode.db` |
| `KLIPRUN_BUN_HOME` | Directory for KlipRun local state (Kanban history) | `~/.kliprun_bun` |
| `KLIPRUN_BUN_MODELS` | Model catalog with context limits | `~/.cache/opencode/models.json` |

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Liveness summary |
| `GET /api/board` | Board snapshot (ETag / 304) |
| `GET /api/stream` | SSE: `board-update` pushes + 30 s heartbeat |
| `GET /api/session/:id` | Messages, models, tools, MRs, Kanban history |

## Development

```bash
bun test src/server src/shared   # tests
bunx tsc -b                      # typecheck
bun run build                    # build the client
```

## Safety and privacy

KlipRun is a local observer, not an OpenCode controller. Its web server binds
only to `127.0.0.1`; the OpenCode SQLite database is opened read-only and is
never written. KlipRun does not create sessions, send prompts, answer
questions, approve permissions, or edit OpenCode settings. Potential secrets
are filtered before session details are sent to the browser. The Kanban
history database stores only observed column intervals.

## License

KlipRun is distributed under the [MIT License](LICENSE).
