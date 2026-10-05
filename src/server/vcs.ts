/**
 * Current git branch for a session directory: walk up to the repository root
 * (.git dir or worktree .git file), read HEAD. Read-only; cached 10s per dir.
 * Containers without a repo (or detached HEAD) yield null — never guessed.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const CACHE_TTL_MS = 10_000;
const MAX_DEPTH = 10;
const REF_PREFIX = "ref: refs/heads/";

const cache = new Map<string, { at: number; branch: string | null }>();

export function branchOf(directory: string): string | null {
  const now = Date.now();
  const hit = cache.get(directory);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.branch;
  const branch = resolveBranch(directory);
  cache.set(directory, { at: now, branch });
  return branch;
}

export function clearBranchCache(): void {
  cache.clear();
}

function resolveBranch(startDir: string): string | null {
  let dir: string | null = startDir;
  for (let depth = 0; dir && depth < MAX_DEPTH; depth++) {
    const dotGit = join(dir, ".git");
    let isDir = false;
    try {
      isDir = statSync(dotGit).isDirectory();
    } catch {
      dir = parentOf(dir);
      continue;
    }
    const headPath = isDir ? join(dotGit, "HEAD") : worktreeHead(dotGit);
    if (headPath) {
      const branch = readHeadBranch(headPath);
      if (branch) return branch;
    }
    dir = parentOf(dir);
  }
  return null;
}

/** A worktree keeps `.git` as a file: "gitdir: <repo>/.git/worktrees/<name>". */
function worktreeHead(dotGitFile: string): string | null {
  try {
    const content = readFileSync(dotGitFile, "utf8").trim();
    if (!content.startsWith("gitdir:")) return null;
    return join(content.slice("gitdir:".length).trim(), "HEAD");
  } catch {
    return null;
  }
}

function readHeadBranch(headPath: string): string | null {
  try {
    const content = readFileSync(headPath, "utf8").trim();
    if (content.startsWith(REF_PREFIX)) return content.slice(REF_PREFIX.length) || null;
    return null; // detached HEAD
  } catch {
    return null;
  }
}

function parentOf(dir: string): string | null {
  const parent = dirname(dir);
  return parent === dir ? null : parent;
}
