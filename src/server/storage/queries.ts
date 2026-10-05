import { getDb } from "./db";

export interface DbSessionRow {
  id: string;
  projectID: string;
  parentID: string | null;
  directory: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
}

export interface DbMessageRow {
  id: string;
  sessionID: string;
  timeCreated: number;
  timeUpdated: number;
  data: string;
}

export interface DbPartRow {
  id: string;
  messageID: string;
  sessionID: string;
  timeCreated: number;
  timeUpdated: number;
  data: string;
}

function toSessionColumns(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `
      ${p}id,
      ${p}project_id AS projectID,
      ${p}parent_id AS parentID,
      ${p}directory,
      ${p}title,
      ${p}time_created AS timeCreated,
      ${p}time_updated AS timeUpdated`;
}

export function querySessionsByDirectories(directories: string[]): DbSessionRow[] {
  const db = getDb();
  if (!db || directories.length === 0) return [];
  const placeholders = directories.map((_, i) => `?${i + 1}`).join(", ");
  const stmt = db.query<DbSessionRow, string[]>(`
    SELECT${toSessionColumns()}
    FROM session
    WHERE directory IN (${placeholders})
    ORDER BY time_updated DESC
  `);
  return stmt.all(...directories);
}

export function querySession(sessionId: string): DbSessionRow | null {
  const db = getDb();
  if (!db) return null;
  const stmt = db.query<DbSessionRow, [string]>(`
    SELECT${toSessionColumns()}
    FROM session
    WHERE id = ?1
    LIMIT 1
  `);
  return stmt.get(sessionId) ?? null;
}

export function querySessionSubtreeRevision(sessionId: string): number {
  const db = getDb();
  if (!db) return 0;
  const stmt = db.query<{ maxTimestamp: number | null }, [string]>(`
    WITH RECURSIVE subtree AS (
      SELECT id FROM session WHERE id = ?1
      UNION ALL
      SELECT s.id FROM session s INNER JOIN subtree st ON s.parent_id = st.id
    )
    SELECT MAX(ts) AS maxTimestamp
    FROM (
      SELECT MAX(time_updated) AS ts FROM session WHERE id IN (SELECT id FROM subtree)
      UNION ALL
      SELECT MAX(time_updated) AS ts FROM message WHERE session_id IN (SELECT id FROM subtree)
      UNION ALL
      SELECT MAX(time_updated) AS ts FROM part WHERE session_id IN (SELECT id FROM subtree)
    )
  `);
  return Number(stmt.get(sessionId)?.maxTimestamp ?? 0);
}

export function queryMessages(sessionId: string, limit: number): DbMessageRow[] {
  const db = getDb();
  if (!db) return [];
  const stmt = db.query<DbMessageRow, [string, number]>(`
    SELECT
      id,
      session_id AS sessionID,
      time_created AS timeCreated,
      time_updated AS timeUpdated,
      data
    FROM message
    WHERE session_id = ?1
    ORDER BY time_created DESC
    LIMIT ?2
  `);
  return stmt.all(sessionId, limit);
}

/** Ids of the newest `count` messages of a session (newest first). */
export function queryLatestMessageIds(sessionId: string, count: number): string[] {
  const db = getDb();
  if (!db) return [];
  const stmt = db.query<{ id: string }, [string, number]>(`
    SELECT id FROM message
    WHERE session_id = ?1
    ORDER BY time_created DESC
    LIMIT ?2
  `);
  return stmt.all(sessionId, count).map((row) => row.id);
}

/** Parts belonging to the given messages, oldest first. */
export function queryPartsByMessageIds(sessionId: string, messageIds: string[]): DbPartRow[] {
  const db = getDb();
  if (!db || messageIds.length === 0) return [];
  const placeholders = messageIds.map((_, i) => `?${i + 1}`).join(", ");
  const stmt = db.query<DbPartRow, string[]>(`
    SELECT
      id,
      message_id AS messageID,
      session_id AS sessionID,
      time_created AS timeCreated,
      time_updated AS timeUpdated,
      data
    FROM part
    WHERE session_id = ?${messageIds.length + 1} AND message_id IN (${placeholders})
    ORDER BY time_created ASC, id ASC
  `);
  return stmt.all(...messageIds, sessionId);
}

/** Transitive child session ids of a root session (excluding the root). */
export function querySessionDescendantIds(rootId: string): string[] {
  const db = getDb();
  if (!db) return [];
  const stmt = db.query<{ id: string }, [string]>(`
    WITH RECURSIVE subtree AS (
      SELECT id FROM session WHERE parent_id = ?1
      UNION ALL
      SELECT s.id FROM session s INNER JOIN subtree st ON s.parent_id = st.id
    )
    SELECT id FROM subtree
  `);
  return stmt.all(rootId).map((row) => row.id);
}

export function queryMessageCount(sessionId: string): number {
  const db = getDb();
  if (!db) return 0;
  const stmt = db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM message WHERE session_id = ?1
  `);
  return Number(stmt.get(sessionId)?.count ?? 0);
}

export function queryParts(sessionId: string): DbPartRow[] {
  const db = getDb();
  if (!db) return [];
  const stmt = db.query<DbPartRow, [string]>(`
    SELECT
      id,
      message_id AS messageID,
      session_id AS sessionID,
      time_created AS timeCreated,
      time_updated AS timeUpdated,
      data
    FROM part
    WHERE session_id = ?1
    ORDER BY time_created ASC, id ASC
  `);
  return stmt.all(sessionId);
}
