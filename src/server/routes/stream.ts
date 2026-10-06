import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Watcher, CombinedEvent } from "../watcher";
import type { BoardService } from "../boardService";

const activeAbortControllers = new Set<AbortController>();

export function closeAllSSEConnections(): void {
  for (const controller of activeAbortControllers) controller.abort();
  activeAbortControllers.clear();
}

export function registerStreamRoute(app: Hono, watcher: Watcher, service: BoardService) {
  app.get("/api/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();
      activeAbortControllers.add(abortController);
      abortController.signal.addEventListener("abort", () => stream.abort());

      await stream.writeSSE({
        data: JSON.stringify({ connected: true, timestamp: Date.now() }),
        event: "connected",
      });

      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({
            data: JSON.stringify({ timestamp: Date.now() }),
            event: "heartbeat",
          });
        } catch {
          // Stream closed — expected during disconnect
        }
      }, 30000);

      const handleChange = async (event: CombinedEvent) => {
        try {
          if (event.source === "hermes") {
            service.refreshLivenessNow();
          }
          service.invalidate();
          await stream.writeSSE({
            data: JSON.stringify({ source: event.source, timestamp: Date.now() }),
            event: "board-update",
          });
        } catch {
          // Stream closed — expected during disconnect
        }
      };

      watcher.on("change", handleChange);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        watcher.removeListener("change", handleChange);
        activeAbortControllers.delete(abortController);
      });

      await new Promise(() => {});
    });
  });
}
