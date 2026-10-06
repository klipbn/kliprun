import type { Hono } from "hono";
import type { BoardService } from "../boardService";

export function registerBoardRoute(app: Hono, service: BoardService) {
  app.get("/api/board", (c) => {
    const ifNoneMatch = c.req.header("If-None-Match");
    const result = service.getBoard(ifNoneMatch);
    if (result.notModified) {
      return c.body(null, 304, { ETag: result.etag, "Cache-Control": "no-cache" });
    }
    c.header("ETag", result.etag);
    c.header("Cache-Control", "no-cache");
    return c.json(result.data);
  });
}

export function registerSessionRoute(app: Hono, service: BoardService) {
  app.get("/api/session/:id", (c) => {
    const id = c.req.param("id");
    if (!/^ses_[a-zA-Z0-9_-]+$/.test(id) && !/^codex:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    return c.json(service.getSessionDetail(id));
  });
}

export function registerHealthRoute(app: Hono, service: BoardService) {
  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      tui_directories: service.tuiCount(),
      codex_diagnostics: service.codexDiagnostics(),
      uptime_s: Math.floor((Date.now() - service.startedAt) / 1000),
    });
  });
}
