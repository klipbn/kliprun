import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { codexHome, type CodexThread } from "./storage";

export interface CliProcess {
  pid: string;
  cwd: string;
  rollouts: string[];
  /** Session writer files held open by this terminal's Codex process. */
  writerSessionIds?: string[];
  /** Session writer files held open by live managed Codex daemons. Not an exact terminal match. */
  daemonSessionIds?: string[];
}

const NON_INTERACTIVE = new Set(["exec", "e", "review", "app-server", "mcp", "mcp-server", "login", "logout", "completion", "debug", "sandbox", "apply", "cloud", "features", "help"]);
const VALUE_FLAGS = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-a", "--ask-for-approval", "-s", "--sandbox", "-i", "--image", "--add-dir", "--enable", "--disable"]);

/** Require a terminal and the actual Codex executable, never daemon/worker names. */
export function parseCliProcesses(output: string): string[] {
  const pids: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || ["??", "?", "-"].includes(match[2])) continue;
    const args = match[3].match(/"[^"]*"|'[^']*'|\S+/g)?.map(s => s.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
    if (basename(args[0] ?? "") !== "codex") continue;
    let interactive = true;
    for (let i = 1; i < args.length; i++) {
      if (VALUE_FLAGS.has(args[i])) { i++; continue; }
      if (["--help", "-h", "--version", "-V"].includes(args[i])) { interactive = false; break; }
      if (args[i].startsWith("-")) continue;
      interactive = !NON_INTERACTIVE.has(args[i]);
      break;
    }
    if (interactive) pids.push(match[1]);
  }
  return pids;
}

export function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Managed local backends supply evidence, never cards of their own. */
export function parseDaemonProcesses(output: string): string[] {
  const pids: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+\S+\s+(\S+)\s+app-server(?:\s|$)/);
    if (match && basename(match[2]) === "codex" && /\s--managed-daemon(?:\s|$)/.test(line)) pids.push(match[1]);
  }
  return pids;
}

async function command(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => proc.kill(), 2500);
  try {
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    // lsof may return 1 when a process exits during the scan.
    if (code !== 0 && !(args[0] === "lsof" && code === 1)) throw new Error("CLI process scan unavailable");
    return output;
  } finally { clearTimeout(timeout); }
}

export async function scanCodexCli(): Promise<CliProcess[]> {
  const ps = await command(["ps", "-axo", "pid=,tty=,command="]);
  const pids = parseCliProcesses(ps).slice(0, 100);
  if (!pids.length) return [];
  const daemonPids = parseDaemonProcesses(ps).slice(0, 20);
  const output = await command(["lsof", "-a", "-p", [...pids, ...daemonPids].join(","), "-Fpnf"]);
  return parseCodexFiles(output, pids, daemonPids, codexHome());
}

/** Read only open descriptors: stale writer files left on disk are not evidence. */
export function parseCodexFiles(output: string, pids: string[], daemonPids: string[], home: string): CliProcess[] {
  const processes = new Map<string, CliProcess>();
  const daemonSessions = new Set<string>();
  const writerDirectory = canonicalPath(join(home, "thread-writer-locks"));
  let current: CliProcess | undefined;
  let daemon = false;
  let fd = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = line.slice(1);
      current = pids.includes(pid) ? { pid, cwd: "", rollouts: [], writerSessionIds: [] } : undefined;
      daemon = daemonPids.includes(pid);
      if (current) processes.set(pid, current);
      fd = "";
    } else if (line.startsWith("f")) fd = line.slice(1);
    else if ((current || daemon) && line.startsWith("n/")) {
      const path = line.slice(1);
      if (current && fd === "cwd") current.cwd = canonicalPath(path);
      else if (current && /\/rollout-[^/]+\.jsonl$/.test(path)) current.rollouts.push(canonicalPath(path));
      const id = basename(path).match(/^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.lock$/i)?.[1];
      if (id && canonicalPath(dirname(path)) === writerDirectory) {
        if (current) current.writerSessionIds!.push(id);
        if (daemon) daemonSessions.add(id);
      }
    }
  }
  return [...processes.values()].filter(p => p.cwd).map(p => ({ ...p, daemonSessionIds: [...daemonSessions] }));
}

export function matchCliSessions(processes: CliProcess[], candidates: CodexThread[]) {
  const selected = new Map<string, CodexThread>();
  const diagnostics: string[] = [];
  for (const process of processes) {
    const rollouts = process.rollouts.map(canonicalPath);
    const cwd = canonicalPath(process.cwd);
    const direct = candidates.filter(row =>
      (rollouts.includes(canonicalPath(row.rollout_path)) || process.writerSessionIds?.includes(row.id)) && !row.source.startsWith("{"),
    );
    if (direct.length === 1) { selected.set(direct[0].id, direct[0]); continue; }
    const sameDirectory = candidates.filter(row =>
      (row.source === "cli" || (row.source === "vscode" && row.originator === "codex-tui")) && canonicalPath(row.cwd) === cwd,
    );
    const terminalCount = processes.filter(p => canonicalPath(p.cwd) === cwd).length;
    const loaded = sameDirectory.filter(row => process.daemonSessionIds?.includes(row.id));
    if (!direct.length && terminalCount === 1 && loaded.length === 1) {
      selected.set(loaded[0].id, loaded[0]);
    } else if (!direct.length && terminalCount === 1 && sameDirectory.length === 1) {
      selected.set(sameDirectory[0].id, sameDirectory[0]);
    } else diagnostics.push(`CLI ${process.pid}: ${direct.length > 1 || sameDirectory.length > 1 || terminalCount > 1 ? "ambiguous session match" : "no matching CLI session"}`);
  }
  return { threads: [...selected.values()], diagnostics };
}
