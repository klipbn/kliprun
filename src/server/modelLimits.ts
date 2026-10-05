/**
 * Model context limits from OpenCode's own models.dev cache
 * (~/.cache/opencode/models.json). Read-only; reloaded when the file mtime
 * changes. Unknown providers (e.g. custom proxies) have no limit — no bar —
 * unless the optional overrides file (~/.kliprun_bun/model-limits.json)
 * supplies one: `{ "provider/model": 1000000, "provider/*": 1000000 }`.
 * Exact keys override the catalog; "provider/*" fills only models the
 * catalog does not know. Absent or corrupt file means "no overrides".
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextUsage } from "@shared/types";

export interface ModelLimitEntry {
  limit?: { context?: number; input?: number; output?: number };
}

export type ModelsCatalog = Record<string, { models?: Record<string, ModelLimitEntry> }>;

export interface ModelLimitOverrides {
  exact: Map<string, number>;
  /** providerId -> limit, applied only when neither catalog nor exact knows the model. */
  wildcards: Map<string, number>;
}

const EMPTY_OVERRIDES: ModelLimitOverrides = { exact: new Map(), wildcards: new Map() };

export function modelsJsonPath(): string {
  return process.env.KLIPRUN_BUN_MODELS ?? join(homedir(), ".cache", "opencode", "models.json");
}

export function modelLimitsOverridesPath(): string {
  const base = process.env.KLIPRUN_BUN_HOME ?? join(homedir(), ".kliprun_bun");
  return process.env.KLIPRUN_BUN_MODEL_LIMITS ?? join(base, "model-limits.json");
}

/** Pure parse: catalog -> "provider/model" -> context limit. */
export function parseModelLimits(catalog: ModelsCatalog): Map<string, number> {
  const limits = new Map<string, number>();
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      const context = model?.limit?.context;
      if (typeof context === "number" && context > 0) {
        limits.set(`${providerId}/${modelId}`, context);
      }
    }
  }
  return limits;
}

/** Pure parse: `{ "provider/model": n, "provider/*": n }` -> overrides. */
export function parseModelLimitOverrides(raw: unknown): ModelLimitOverrides {
  const overrides: ModelLimitOverrides = { exact: new Map(), wildcards: new Map() };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return overrides;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !(value > 0)) continue;
    const wildcard = /^(.+)\/\*$/.exec(key);
    if (wildcard) overrides.wildcards.set(wildcard[1]!, value);
    else if (key.includes("/")) overrides.exact.set(key, value);
  }
  return overrides;
}

let cache: { mtimeMs: number; overrides: ModelLimitOverrides; limits: Map<string, number> } | null =
  null;
let overridesCache: { mtimeMs: number; overrides: ModelLimitOverrides } | null = null;

/** User overrides; absent or corrupt file means "no overrides". */
function getModelLimitOverrides(): ModelLimitOverrides {
  const path = modelLimitsOverridesPath();
  try {
    const stats = statSync(path);
    if (overridesCache && overridesCache.mtimeMs === stats.mtimeMs) return overridesCache.overrides;
    const overrides = parseModelLimitOverrides(JSON.parse(readFileSync(path, "utf8")));
    overridesCache = { mtimeMs: stats.mtimeMs, overrides };
    return overrides;
  } catch {
    return EMPTY_OVERRIDES;
  }
}

export function getModelLimits(): Map<string, number> {
  const overrides = getModelLimitOverrides();
  const path = modelsJsonPath();
  try {
    const stats = statSync(path);
    if (cache && cache.mtimeMs === stats.mtimeMs && cache.overrides === overrides) return cache.limits;
    const limits = parseModelLimits(JSON.parse(readFileSync(path, "utf8")) as ModelsCatalog);
    for (const [key, value] of overrides.exact) limits.set(key, value);
    cache = { mtimeMs: stats.mtimeMs, overrides, limits };
    return limits;
  } catch {
    return cache?.limits ?? new Map<string, number>();
  }
}

export function contextLimit(modelRef: string | null | undefined): number | null {
  if (!modelRef) return null;
  const exact = getModelLimits().get(modelRef);
  if (exact !== undefined) return exact;
  const provider = modelRef.split("/")[0];
  return getModelLimitOverrides().wildcards.get(provider) ?? null;
}

/** Usage-bar data: percent of the context window spent. Null when limit unknown. */
export function contextUsage(modelRef: string | null | undefined, used: number | null | undefined): ContextUsage | null {
  const limit = contextLimit(modelRef);
  if (!limit || !used) return null;
  const percent = Math.min(100, Math.round((used / limit) * 100));
  return { model: (modelRef ?? "").split("/").slice(1).join("/") || modelRef!, percent, used, limit };
}
