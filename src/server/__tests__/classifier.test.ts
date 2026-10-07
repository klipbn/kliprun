import { describe, expect, test } from "bun:test";
import {
  analyzeMessages,
  isHiddenIdleChild,
  truncate,
  type CardState,
  type MessageInfo,
  type PartData,
} from "../classifier";
import type { DbMessageRow, DbPartRow } from "../storage/queries";

function msgRow(id: string, timeCreated: number): DbMessageRow {
  return { id, sessionID: "ses_t", timeCreated, timeUpdated: timeCreated, data: "{}" };
}

function msg(id: string, timeCreated: number, data: Record<string, unknown>) {
  return { row: msgRow(id, timeCreated), data: { role: "user", time: { created: timeCreated }, ...data } };
}

function part(messageId: string, data: Record<string, unknown>): DbPartRow {
  return {
    id: `prt_${messageId}_${Math.random().toString(36).slice(2, 6)}`,
    messageID: messageId,
    sessionID: "ses_t",
    timeCreated: 0,
    timeUpdated: 0,
    data: JSON.stringify(data),
  };
}

function partsToMap(parts: { messageID: string; data: string }[]): Map<string, PartData[]> {
  const map = new Map<string, PartData[]>();
  for (const p of parts) {
    const list = map.get(p.messageID) ?? [];
    list.push(JSON.parse(p.data) as PartData);
    map.set(p.messageID, list);
  }
  return map;
}

function emptyInfo(overrides: Partial<MessageInfo> = {}): MessageInfo {
  return {
    agentName: null,
    error: null,
    lastTool: null,
    toolPending: false,
    questionRunning: false,
    lastRole: null,
    lastCompleted: null,
    lastActivityMs: 0,
    promptSnippet: null,
    messageCount: 0,
    modelRef: null,
    tokensTotal: null,
    modelUsages: new Map(),
    ...overrides,
  };
}

describe("truncate", () => {
  test("collapses whitespace and appends ellipsis", () => {
    expect(truncate("a  b   c", 10)).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

test("Running attribution uses the streaming model instead of the previous context measurement", () => {
  const result = analyzeMessages([
    msg("old", 100, { role: "assistant", providerID: "openai", modelID: "old", tokens: { total: 100 }, time: { completed: 150 } }),
    msg("new", 200, { role: "assistant", providerID: "openai", modelID: "new" }),
  ], new Map());
  expect(result.modelRef).toBe("openai/old");
  expect(result.currentModelRef).toBe("openai/new");
});

describe("isHiddenIdleChild", () => {
  function child(
    overrides: Partial<Pick<CardState, "parentId" | "column" | "stage">> = {},
  ): Pick<CardState, "parentId" | "column" | "stage"> {
    return { parentId: "ses_parent", column: "idle", stage: "Finished", ...overrides };
  }

  test("completed subagent in idle is hidden (parent on board)", () => {
    expect(isHiddenIdleChild(child(), { column: "running" })).toBe(true);
    expect(isHiddenIdleChild(child(), { column: "idle" })).toBe(true);
  });

  test("interrupted and inactive subagents in idle are hidden", () => {
    expect(isHiddenIdleChild(child({ stage: "Interrupted" }), { column: "running" })).toBe(true);
    expect(isHiddenIdleChild(child({ stage: "Inactive" }), { column: "idle" })).toBe(true);
  });

  test("error subagent stays visible", () => {
    expect(isHiddenIdleChild(child({ stage: "Error" }), { column: "running" })).toBe(false);
    expect(isHiddenIdleChild(child({ stage: "Error" }), { column: "idle" })).toBe(false);
  });

  test("running and attention children stay visible", () => {
    expect(isHiddenIdleChild(child({ column: "running" }), { column: "running" })).toBe(false);
    expect(isHiddenIdleChild(child({ column: "attention" }), { column: "running" })).toBe(false);
  });

  test("root cards and orphans stay visible", () => {
    expect(isHiddenIdleChild(child({ parentId: null }), { column: "idle" })).toBe(false);
    expect(isHiddenIdleChild(child(), undefined)).toBe(false);
  });
});

describe("analyzeMessages", () => {
  test("empty session", () => {
    expect(analyzeMessages([], new Map())).toEqual(emptyInfo());
  });

  test("prompt snippet from the newest user text part", () => {
    const parts = partsToMap([
      part("m1", { type: "text", text: "первый запрос" }),
      part("m2", { type: "text", text: "второй запрос" }),
    ]);
    const info = analyzeMessages(
      [
        msg("m1", 1000, { role: "user" }),
        msg("m2", 2000, { role: "user" }),
      ],
      parts,
    );
    expect(info.promptSnippet).toBe("второй запрос");
    expect(info.lastRole).toBe("user");
    expect(info.messageCount).toBe(2);
  });

  test("completed assistant turn sets model usage and completion", () => {
    const parts = partsToMap([]);
    const info = analyzeMessages(
      [
        msg("m1", 1000, { role: "user" }),
        msg("m2", 2000, {
          role: "assistant",
          agent: "build",
          modelID: "glm-5.3",
          providerID: "zai",
          tokens: { total: 12345 },
          time: { created: 2000, completed: 2500 },
        }),
      ],
      parts,
    );
    expect(info.agentName).toBe("build");
    expect(info.modelRef).toBe("zai/glm-5.3");
    expect(info.tokensTotal).toBe(12345);
    expect(info.modelUsages.get("zai/glm-5.3")).toBe(12345);
    expect(info.lastRole).toBe("assistant");
    expect(info.lastCompleted).toBe(2500);
    expect(info.lastActivityMs).toBe(2500);
  });

  test("streaming assistant keeps latest completed token snapshot", () => {
    const info = analyzeMessages(
      [
        msg("m1", 1000, {
          role: "assistant",
          modelID: "glm-5.3",
          providerID: "zai",
          tokens: { total: 999 },
          time: { created: 1000, completed: 1500 },
        }),
        msg("m2", 2000, {
          role: "assistant",
          modelID: "glm-5.3",
          providerID: "zai",
          time: { created: 2000 }, // streaming: no completed, no tokens
        }),
      ],
      new Map(),
    );
    expect(info.lastCompleted).toBeNull();
    expect(info.tokensTotal).toBe(999); // kept from the last completed turn
  });

  test("a newer user message clears an older assistant error", () => {
    const info = analyzeMessages(
      [
        msg("m1", 1000, { role: "assistant", error: "boom" }),
        msg("m2", 2000, { role: "user" }),
      ],
      new Map(),
    );
    expect(info.error).toBeNull();
  });

  test("running tool sets last_tool; pending tool marks tool_pending", () => {
    const parts = partsToMap([
      part("m1", { type: "tool", tool: "bash", state: { status: "completed" } }),
      part("m2", { type: "tool", tool: "read", state: { status: "running" } }),
      part("m3", { type: "tool", tool: "write", state: { status: "pending" } }),
    ]);
    const info = analyzeMessages(
      [
        msg("m1", 1000, { role: "assistant" }),
        msg("m2", 2000, { role: "assistant" }),
        msg("m3", 3000, { role: "assistant" }),
      ],
      parts,
    );
    expect(info.lastTool).toBe("read");
    expect(info.toolPending).toBe(true);
  });

  test("unfinished question tool in a streaming turn flags question_running", () => {
    const parts = partsToMap([
      part("m2", { type: "tool", tool: "question", state: { status: "running" } }),
    ]);
    const info = analyzeMessages(
      [
        msg("m1", 1000, { role: "user" }),
        msg("m2", 2000, { role: "assistant", time: { created: 2000 } }), // no completed
      ],
      parts,
    );
    expect(info.questionRunning).toBe(true);
  });
});
