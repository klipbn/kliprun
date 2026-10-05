/**
 * Match OpenCode TUI processes to sessions via local Hermes heartbeats.
 * TUI detection: ps + lsof(cwd) + ~/.cache/opencode-hermes/instances.
 * Read-only: never touches OpenCode or Hermes files.
 */
import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { HEARTBEAT_MAX_AGE_S } from "@shared/constants";

const EXCLUDED_SUBCOMMANDS = new Set(["mcp", "run", "serve"]);

export function isTuiCommand(command: string): boolean {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0 || basename(parts[0]) !== "opencode") return false;
  const positional = parts.slice(1).filter((a) => !a.startsWith("-"));
  return !(positional.length > 0 && EXCLUDED_SUBCOMMANDS.has(positional[0]));
}

async function runCommand(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } catch {
    return null;
  }
}

export async function tuiPids(): Promise<string[]> {
  const output = await runCommand(["ps", "-axo", "pid=,command="]);
  if (output === null) return [];
  const pids: string[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) continue;
    const pid = line.slice(0, spaceIndex);
    const command = line.slice(spaceIndex + 1);
    if (isTuiCommand(command)) pids.push(pid);
  }
  return pids;
}

/** Map each live TUI PID to its resolved working directory. */
export async function tuiCwds(): Promise<Map<string, string>> {
  const pids = await tuiPids();
  const directories = new Map<string, string>();
  if (pids.length === 0) return directories;
  // -a is mandatory: without it lsof ORs the selectors and returns every
  // process's cwd, not just the requested PIDs.
  const output = await runCommand(["lsof", "-a", "-Fn", "-d", "cwd", "-p", pids.join(",")]);
  if (output === null) return directories;
  const pidSet = new Set(pids);
  let pid: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p") && pidSet.has(line.slice(1))) {
      pid = line.slice(1);
    } else if (pid && line.startsWith("n/")) {
      directories.set(pid, resolvePath(line.slice(1)));
    }
  }
  return directories;
}

function resolvePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface TuiLiveness {
  /** Hermes-matched live session ids. */
  sessionIds: Set<string>;
  /** Resolved cwds of running OpenCode TUI processes. */
  directories: Set<string>;
  /** Sessions whose Hermes status is "waiting" (attention). */
  waitingIds: Set<string>;
  /** TUI cwds without a fresh Hermes match (fallback: keep latest session). */
  fallbackDirectories: Set<string>;
  /** session id -> TUI directory. */
  sessionDirectories: Map<string, string>;
}

export function hermesInstancesDir(): string {
  return join(homedir(), ".cache", "opencode-hermes", "instances");
}

interface HermesMatch {
  heartbeatMs: number;
  sessionId: string;
  waiting: boolean;
  directory: string;
}

export async function openTuiSessions(instancesDir?: string): Promise<TuiLiveness> {
  const cwds = await tuiCwds();
  const dir = instancesDir ?? hermesInstancesDir();
  const matched = new Map<string, HermesMatch>();

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await readFile(join(dir, entry), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pid = String(data.pid ?? "");
    if (!cwds.has(pid) || data.headless) continue;
    if (resolvePath(String(data.directory ?? "")) !== cwds.get(pid)) continue;
    const sessionId = data.currentSessionID;
    if (typeof sessionId !== "string" || !sessionId.startsWith("ses_")) continue;
    const heartbeatRaw = data.heartbeatAt;
    if (typeof heartbeatRaw !== "string") continue;
    const heartbeatMs = Date.parse(heartbeatRaw);
    if (!Number.isFinite(heartbeatMs)) continue;
    const age = (Date.now() - heartbeatMs) / 1000;
    if (!(age >= 0 && age <= HEARTBEAT_MAX_AGE_S)) continue;
    const existing = matched.get(pid);
    if (!existing || heartbeatMs > existing.heartbeatMs) {
      matched.set(pid, {
        heartbeatMs,
        sessionId,
        waiting: data.currentSessionStatus === "waiting",
        directory: cwds.get(pid)!,
      });
    }
  }

  const sessionDirectories = new Map<string, string>();
  const waitingIds = new Set<string>();
  for (const match of matched.values()) {
    sessionDirectories.set(match.sessionId, match.directory);
    if (match.waiting) waitingIds.add(match.sessionId);
  }
  const fallbackDirectories = new Set<string>();
  for (const [pid, directory] of cwds) {
    if (!matched.has(pid)) fallbackDirectories.add(directory);
  }

  return {
    sessionIds: new Set(sessionDirectories.keys()),
    directories: new Set(cwds.values()),
    waitingIds,
    fallbackDirectories,
    sessionDirectories,
  };
}
