import { describe, expect, test } from "bun:test";
import { isTuiCommand } from "../liveness";

describe("isTuiCommand", () => {
  test("bare opencode is a TUI", () => {
    expect(isTuiCommand("opencode")).toBe(true);
    expect(isTuiCommand("/usr/local/bin/opencode")).toBe(true);
    expect(isTuiCommand("opencode attach")).toBe(true);
    expect(isTuiCommand("opencode --port 1234")).toBe(true);
  });

  test("non-interactive subcommands are never a TUI", () => {
    expect(isTuiCommand("opencode run ls")).toBe(false);
    expect(isTuiCommand("opencode serve")).toBe(false);
    expect(isTuiCommand("opencode mcp")).toBe(false);
    expect(isTuiCommand("/opt/opencode serve --port 1")).toBe(false);
  });

  test("other binaries are not a TUI", () => {
    expect(isTuiCommand("bun run server.ts")).toBe(false);
    expect(isTuiCommand("vim")).toBe(false);
    expect(isTuiCommand("node opencode-wrapper.js")).toBe(false);
    expect(isTuiCommand("")).toBe(false);
  });
});
