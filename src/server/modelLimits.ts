/**
 * Model context limits from OpenCode's own models.dev cache
 * (~/.cache/opencode/models.json). Read-only; reloaded when the file mtime
 * changes. Unknown providers (e.g. custom proxies) have no limit — no bar.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextUsage } from "@shared/types";

export interface ModelLimitEntry {
  limit?: { context?: number; input?: number; output?: number };
}

export type ModelsCatalog = Record<string, { models?: Record<string, ModelLimitEntry> }>;

export function modelsJsonPath(): string {
  return process.env.KLIPRUN_BUN_MODELS ?? join(homedir(), ".cache", "opencode", "models.json");
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

let cache: { mtimeMs: number; limits: Map<string, number> } | null = null;

export function getModelLimits(): Map<string, number> {
  const path = modelsJsonPath();
  try {
    const stats = statSync(path);
    if (cache && cache.mtimeMs === stats.mtimeMs) return cache.limits;
    const catalog = JSON.parse(readFileSync(path, "utf8")) as ModelsCatalog;
    cache = { mtimeMs: stats.mtimeMs, limits: parseModelLimits(catalog) };
    return cache.limits;
  } catch {
    return cache?.limits ?? new Map();
  }
}

export function contextLimit(modelRef: string | null | undefined): number | null {
  if (!modelRef) return null;
  return getModelLimits().get(modelRef) ?? null;
}

/** Usage-bar data: percent of the context window spent. Null when limit unknown. */
export function contextUsage(modelRef: string | null | undefined, used: number | null | undefined): ContextUsage | null {
  const limit = contextLimit(modelRef);
  if (!limit || !used) return null;
  const percent = Math.min(100, Math.round((used / limit) * 100));
  return { model: (modelRef ?? "").split("/").slice(1).join("/") || modelRef!, percent, used, limit };
}
