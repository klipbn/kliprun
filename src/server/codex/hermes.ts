import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HEARTBEAT_MAX_AGE_S } from "@shared/constants";
import { canonicalPath } from "./liveness";
import type { CodexThread } from "./storage";

type Json = Record<string, unknown>;
const MAX_JSON = 2 * 1024 * 1024;
function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}
function fresh(at: number, now: number): boolean {
  return at <= now && now - at <= HEARTBEAT_MAX_AGE_S * 1000;
}

/** Read one bounded file through its descriptor; Hermes replaces files atomically. */
function json(path: string): Json {
  try {
    const fd = openSync(path, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_JSON) return {};
      const buffer = Buffer.alloc(stat.size);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      return object(JSON.parse(buffer.subarray(0, bytes).toString("utf8")));
    } finally { closeSync(fd); }
  } catch { return {}; }
}

export function codexHermesHome(): string {
  return resolve(process.env.CODEX_HERMES_BASE_DIR || join(homedir(), ".cache", "codex-hermes"));
}

export interface HermesStatus {
  status: "waiting" | "busy";
  updatedAt: number;
  waitingSince: number | null;
  turnId: string | null;
  daemon: boolean;
}

/** Status evidence only: never discovers board members or retains Hermes summaries. */
export function readHermesStatuses(home: string, threads: CodexThread[], now: number): Map<string, HermesStatus> {
  const result = new Map<string, HermesStatus>();
  if (!threads.length) return result;
  const watcher = json(join(home, "watcher.json"));
  if (!fresh(timestamp(watcher.heartbeatAt), now)) return result;
  const health = object(watcher.daemon);
  const daemonHealthy = health.connected === true && fresh(timestamp(health.checkedAt), now);
  for (const row of threads) {
    const name = createHash("sha256").update(row.id).digest("hex");
    const data = json(join(home, "sessions", `${name}.json`));
    if (data.schemaVersion !== 1 || data.source !== "codex" || data.sessionID !== row.id ||
      typeof data.directory !== "string" || canonicalPath(data.directory) !== canonicalPath(row.cwd) ||
      (data.status !== "waiting" && data.status !== "busy")) continue;
    const updatedAt = timestamp(data.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt > now) continue;
    const daemon = data.daemon !== undefined;
    if (daemon && (!daemonHealthy || !fresh(timestamp(object(data.daemon).observedAt), now))) continue;
    if (data.status === "busy" && !fresh(updatedAt, now)) continue;
    const waitingSince = data.status === "waiting" ? timestamp(data.waitingSince) : null;
    if (waitingSince !== null && (!Number.isFinite(waitingSince) || waitingSince > updatedAt)) continue;
    const active = object(data.active);
    result.set(row.id, { status: data.status, updatedAt, waitingSince,
      turnId: typeof active.id === "string" && active.id ? active.id : null, daemon });
  }
  return result;
}
