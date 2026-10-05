/**
 * MR/PR links created by a session: extracted ONLY from tool-call parts that
 * created an MR/PR (MCP gitlab_create_merge_request / *_create_pull_request,
 * `glab mr create` / `gh pr create` bash commands, create-MR skills). URLs the
 * agent merely read (grep/SQL output, foreign tasks) never count.
 * Read-only DB scan with LIKE prefilter; cached per session subtree revision.
 */
import { getDb } from "./storage/db";
import { querySessionSubtreeRevision } from "./storage/queries";
import type { MrLink } from "@shared/types";

const PATTERNS: RegExp[] = [
  /https?:\/\/[^\s"'<>`|\\]+\/-\/merge_requests\/(\d+)/g,
  /https?:\/\/[^\s"'<>`|\\]+\/merge_requests\/(\d+)/g,
  /https?:\/\/[^\s"'<>`|\\]+\/pull\/(\d+)/g,
];

const TRAILING = /[.,;:)\]}>]+$/;
const CACHE_LIMIT = 256;

const cache = new Map<string, { revision: number; mrs: MrLink[] }>();

const TOOL_CREATE = /create[ _-]*(merge_request|pull_request)|(merge_request|pull_request)[ _-]*create/i;
const SKILL_CREATE = /(create[ _-]?mr|mr[ _-]?create|submit[ _-]?for[ _-]?review)/i;
const CMD_CREATE = /\b(mr|pr)\s+create\b|\bmerge_request[ .]create\b/i;

interface ToolPartShape {
  type?: string;
  tool?: string;
  text?: string;
  state?: { status?: string; input?: { command?: string; name?: string } | string };
}

/** True when the parsed part is a tool call that creates an MR/PR. */
export function isMrCreationPart(part: ToolPartShape | null | undefined): boolean {
  if (!part || part.type !== "tool") return false;
  const tool = part.tool ?? "";
  if (TOOL_CREATE.test(tool)) return true;
  const input = part.state?.input;
  if (tool === "skill") {
    const name = typeof input === "object" && input !== null ? input.name : null;
    return name !== null && name !== undefined ? SKILL_CREATE.test(name) : false;
  }
  if (/(bash|sh|zsh|exec|terminal)/i.test(tool)) {
    const command = typeof input === "object" && input !== null ? input.command : null;
    return command !== null && command !== undefined ? CMD_CREATE.test(command) : false;
  }
  return false;
}

/** Extract unique MR/PR links from a blob of text (pure, testable). */
export function extractMrLinks(text: string): MrLink[] {
  const seen = new Map<string, MrLink>();
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[0].replace(TRAILING, "");
      const id = match[1];
      const label = url.includes("/pull/") ? `#${id}` : `!${id}`;
      if (!seen.has(url)) seen.set(url, { url, label });
    }
  }
  return [...seen.values()];
}

export function sessionMrLinks(sessionId: string): MrLink[] {
  const revision = querySessionSubtreeRevision(sessionId);
  const memo = cache.get(sessionId);
  if (memo && memo.revision === revision) return memo.mrs;
  const mrs = scan(sessionId);
  cache.set(sessionId, { revision, mrs });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return mrs;
}

function scan(sessionId: string): MrLink[] {
  const db = getDb();
  if (!db) return [];
  const rows = db
    .query<{ data: string }, [string]>(
      `SELECT data FROM part
       WHERE session_id = ?1 AND (data LIKE '%merge_requests/%' OR data LIKE '%/pull/%')
       ORDER BY time_created ASC, id ASC`,
    )
    .all(sessionId);
  const seen = new Map<string, MrLink>();
  for (const row of rows) {
    let part: ToolPartShape | null = null;
    try {
      part = JSON.parse(row.data) as ToolPartShape;
    } catch {
      continue;
    }
    if (!isMrCreationPart(part)) continue;
    for (const link of extractMrLinks(row.data)) {
      if (!seen.has(link.url)) seen.set(link.url, link);
    }
  }
  return [...seen.values()];
}
