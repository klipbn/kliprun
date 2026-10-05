import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextUsage, parseModelLimits, type ModelsCatalog } from "../modelLimits";

const FIXTURE: ModelsCatalog = {
  "zai-coding-plan": {
    models: {
      "glm-5.3": { limit: { context: 1_000_000, output: 131072 } },
    },
  },
};

let fixtureDir: string | null = null;

/** Point KLIPRUN_BUN_MODELS at a fixture so tests do not depend on the live cache. */
function useFixtureModelLimits(): void {
  fixtureDir ??= mkdtempSync(join(tmpdir(), "kliprun-models-"));
  const path = join(fixtureDir, "models.json");
  writeFileSync(path, JSON.stringify(FIXTURE), { flag: "w" });
  process.env.KLIPRUN_BUN_MODELS = path;
}

afterAll(() => {
  delete process.env.KLIPRUN_BUN_MODELS;
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("parseModelLimits", () => {
  test("keeps only positive context limits keyed provider/model", () => {
    const catalog: ModelsCatalog = {
      "zai-coding-plan": {
        models: {
          "glm-5.3": { limit: { context: 1_000_000, output: 131072 } },
          "glm-5.3-flash": { limit: { context: 1_000_000 } },
        },
      },
      weird: {
        models: {
          zero: { limit: { context: 0 } },
          none: {},
        },
      },
    };
    const limits = parseModelLimits(catalog);
    expect(limits.get("zai-coding-plan/glm-5.3")).toBe(1_000_000);
    expect(limits.get("zai-coding-plan/glm-5.3-flash")).toBe(1_000_000);
    expect(limits.has("weird/zero")).toBe(false);
    expect(limits.has("weird/none")).toBe(false);
  });
});

describe("contextUsage", () => {
  test("computes percent of the window", () => {
    useFixtureModelLimits();
    const usage = contextUsage("zai-coding-plan/glm-5.3", 500_000);
    expect(usage).toEqual({
      model: "glm-5.3",
      percent: 50,
      used: 500_000,
      limit: 1_000_000,
    });
  });

  test("caps at 100 percent", () => {
    useFixtureModelLimits();
    expect(contextUsage("zai-coding-plan/glm-5.3", 2_000_000)?.percent).toBe(100);
  });

  test("unknown model or missing tokens yield null", () => {
    useFixtureModelLimits();
    expect(contextUsage("acme-proxy/llm-x", 123)).toBeNull();
    expect(contextUsage("zai-coding-plan/glm-5.3", null)).toBeNull();
    expect(contextUsage(null, 123)).toBeNull();
  });
});
