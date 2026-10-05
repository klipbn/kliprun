/**
 * KlipRun Bun server: single process, read-only access to the OpenCode DB.
 * Never manages `opencode serve` processes; never writes to OpenCode storage.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { DEFAULT_PORT } from "@shared/constants";
import { BoardService } from "./boardService";
import { Watcher } from "./watcher";
import { registerBoardRoute, registerHealthRoute, registerSessionRoute } from "./routes/api";
import { closeAllSSEConnections, registerStreamRoute } from "./routes/stream";
import { checkDbExists, getDbPath } from "./storage/db";

function resolvePort(args: string[]): number {
  const flagIndex = args.indexOf("--port");
  if (flagIndex !== -1 && args[flagIndex + 1]) {
    const parsed = Number.parseInt(args[flagIndex + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const env = process.env.KLIPRUN_BUN_PORT;
  if (env) {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

const port = resolvePort(process.argv.slice(2));

const app = new Hono();
app.use("*", cors({ origin: (origin) => origin ?? "*" }));

const service = new BoardService();
const watcher = new Watcher();

registerHealthRoute(app, service);
registerBoardRoute(app, service);
registerSessionRoute(app, service);
registerStreamRoute(app, watcher, service);

// Production: serve the built client when present.
app.use("*", serveStatic({ root: "./src/client/dist" }));
app.use("*", serveStatic({ path: "./src/client/dist/index.html" }));

watcher.on("change", (event: { source: "db" | "hermes" }) => {
  if (event.source === "hermes") service.refreshLivenessNow();
  service.invalidate();
});

watcher.start();
service.start();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: app.fetch,
});

console.log(`[kliprun-bun] listening on http://127.0.0.1:${port}`);
console.log(`[kliprun-bun] watching db: ${getDbPath()} (exists: ${checkDbExists()})`);

function shutdown() {
  console.log("[kliprun-bun] shutting down…");
  closeAllSSEConnections();
  watcher.stop();
  service.stop();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
