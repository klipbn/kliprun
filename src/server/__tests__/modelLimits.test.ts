import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextUsage,
  parseModelLimitOverrides,
  parseModelLimits,
  type ModelsCatalog,
} from "../modelLimits";

const FIXTURE: ModelsCatalog = {
  "zai-coding-plan": {
    models: {
      "glm-5.3": { limit: { context: 1_000_000, output: 131072 } },
    },
  },
};

let fixtureDir: string | null = null;

/**
 * Point KLIPRUN_BUN_MODELS/KLIPRUN_BUN_MODEL_LIMITS at fixtures so tests do
 * not depend on (or leak in) the live caches in ~/.cache and ~/.kliprun_bun.
 */
function useFixtureModelLimits(overridesJson: string = "{}"): void {
  fixtureDir ??= mkdtempSync(join(tmpdir(), "kliprun-models-"));
  process.env.KLIPRUN_BUN_MODELS = join(fixtureDir, "models.json");
  process.env.KLIPRUN_BUN_MODEL_LIMITS = join(fixtureDir, "model-limits.json");
  writeFileSync(process.env.KLIPRUN_BUN_MODELS, JSON.stringify(FIXTURE), { flag: "w" });
  writeFileSync(process.env.KLIPRUN_BUN_MODEL_LIMITS, overridesJson, { flag: "w" });
}

afterAll(() => {
  delete process.env.KLIPRUN_BUN_MODELS;
  delete process.env.KLIPRUN_BUN_MODEL_LIMITS;
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

describe("parseModelLimitOverrides", () => {
  test("splits exact keys and provider wildcards, drops junk", () => {
    const { exact, wildcards } = parseModelLimitOverrides({
      "acme-proxy/llm-x": 1_000_000,
      "acme-proxy/*": 400_000,
      "no-slash": 100,
      "negative/model": -5,
      "zero/model": 0,
      "string/model": "1000000",
    });
    expect(exact.get("acme-proxy/llm-x")).toBe(1_000_000);
    expect(wildcards.get("acme-proxy")).toBe(400_000);
    expect(exact.size).toBe(1);
    expect(wildcards.size).toBe(1);
  });

  test("non-object input yields empty overrides", () => {
    for (const raw of [null, undefined, "x", [1], 5]) {
      const { exact, wildcards } = parseModelLimitOverrides(raw);
      expect(exact.size).toBe(0);
      expect(wildcards.size).toBe(0);
    }
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

describe("contextUsage with overrides", () => {
  test("provider wildcard fills models unknown to the catalog", () => {
    useFixtureModelLimits('{ "acme-proxy/*": 1000000 }');
    expect(contextUsage("acme-proxy/llm-x", 500_000)).toEqual({
      model: "llm-x",
      percent: 50,
      used: 500_000,
      limit: 1_000_000,
    });
  });

  test("exact override replaces the catalog limit", () => {
    useFixtureModelLimits('{ "zai-coding-plan/glm-5.3": 200000 }');
    expect(contextUsage("zai-coding-plan/glm-5.3", 100_000)?.limit).toBe(200_000);
  });

  test("wildcard never replaces a known catalog limit", () => {
    useFixtureModelLimits('{ "zai-coding-plan/*": 2000 }');
    expect(contextUsage("zai-coding-plan/glm-5.3", 500_000)?.limit).toBe(1_000_000);
  });

  test("corrupt overrides file is ignored", () => {
    useFixtureModelLimits("not json");
    expect(contextUsage("acme-proxy/llm-x", 123)).toBeNull();
  });
});
