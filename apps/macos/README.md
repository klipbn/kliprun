# KlipRun desktop notifications

A small native macOS companion: a waving Office-style pixel coworker and a text bubble above other windows. It reads only `http://127.0.0.1:8792/api/board`; it never opens agent databases, sends prompts or approves permissions. The browser can be closed while the server and companion are running.

## Build and run

Requires macOS 13+ and Swift 6+ Command Line Tools. From the repository root:

```bash
bun run macos:build
open "apps/macos/dist/KlipRun Notifications.app"
```

Start the KlipRun server separately (`kliprun-start` or `bun run start`). The companion shows connection status in its menu bar menu and retries automatically. The menu offers duration settings, pause/resume, a fictional preview, resetting the position, opening the board and quitting. The preview can also be shown on launch with `open "apps/macos/dist/KlipRun Notifications.app" --args --preview`.

The build creates an app for the current Mac's architecture with an ad-hoc local signature. It does not install anything, add a login item or create a publicly distributed/notarized app. You may move the bundle to Applications manually.

For a different server port, launch the executable directly:

```bash
KLIPRUN_BUN_PORT=8793 "apps/macos/dist/KlipRun Notifications.app/Contents/MacOS/KlipRunNotifications"
```

## Behavior

- The first successful snapshot and the first snapshot after an outage are silent. Old completions are not replayed.
- A visible session entering confirmed `Finished` with `finished_at` says its **response** is ready. Unknown, inactive, interrupted and error states never imply success or task completion.
- Waiting for an answer and waiting for permission use distinct messages. Generic Codex waiting says that input (an answer or permission) is needed; the API does not always distinguish them.
- Each bubble includes the session title. No question text or answer summary is invented or generated. Clicking “Открыть сессию” or the coworker opens its details in the browser and marks the current idle revision read.
- Initially, notifications appear at the top right of the display containing the pointer, without taking keyboard focus. Drag the bubble by its upper heading (the cursor becomes a hand) to place it anywhere. Its top-left position is remembered across notifications and app restarts; if a display disappears, the next bubble is clamped to a connected display. Use **«Вернуть в правый верхний угол»** to reset the position. The panel joins Spaces and requests fullscreen auxiliary placement; exclusive fullscreen apps and OS-owned screens may prevent overlays. It does not duplicate the bubble on all monitors.
- **«Время показа»** offers 5, 8 (default), 15, 30 or 60 seconds, **«Другое…»** for a whole number from 1 to 3600 seconds, and **«До закрытия»** for no timeout. The setting persists across app restarts. Changing it restarts the current bubble's timer; dragging suspends the timer and restarts it on release.
- One bubble is visible at a time. In timed mode, resolved or removed sessions can close their bubble early. In **«До закрытия»**, the visible notification stays even if the agent resumes or the server disconnects; close it with the cross, open its session, or pause notifications. The queue holds at most 20 notifications and discards resolved or removed pending events. Dismiss advances the queue. Pause discards bubbles and continues observing, so resume does not replay events.
- The coworker waves and bobs; Reduce Motion disables both. Session colors use the Office palette and ID hash. No sound or voice is played.
- Polling every two seconds uses ETags. Only visible board sessions qualify; hidden completed OpenCode subagents cannot trigger completion bubbles. Notifications are transient, with no persistent history or background launch service.

## Verify

```bash
bun run macos:test       # Swift Testing, requires Swift 6+ / macOS 14+
bun run macos:test:drag  # native window mouse-down/drag/up regression
bun test src/shared/__tests__/sessionLink.test.ts
bun run macos:build
```

Swift tests cover silent startup, real completions, repeat suppression, uncertain status, waiting reasons, visible descendants, queue reconciliation, saved duration/position, different bubble heights and display removal. The standalone drag test builds a fictional notification and dispatches AppKit mouse events through its window in both directions, checking movement, drag callbacks and keyboard focus. It briefly shows a test bubble and does not change saved preferences. The `.app` build uses `swiftc` directly and requires no full Xcode installation or third-party dependencies.

For manual UI checks: use the menu's preview, drag by its upper heading, then show another preview and restart to verify the saved position. Choose custom seconds and «До закрытия», change the setting while a bubble is visible, close it, open a session, reset its position and toggle pause. Check uninterrupted typing, Spaces, fullscreen, display placement and Reduce Motion on the target Mac.
