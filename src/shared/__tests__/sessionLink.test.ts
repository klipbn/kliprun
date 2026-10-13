import { expect, test } from "bun:test";
import { linkedSessionId } from "../sessionLink";

test("desktop links accept OpenCode and Codex session IDs only", () => {
  expect(linkedSessionId("?session=ses_demo-1")).toBe("ses_demo-1");
  expect(linkedSessionId("?session=codex%3A12345678-1234-1234-1234-123456789abc"))
    .toBe("codex:12345678-1234-1234-1234-123456789abc");
  expect(linkedSessionId("?session=https://example.org")).toBeNull();
  expect(linkedSessionId("?session=../../private")).toBeNull();
  expect(linkedSessionId("?session=")).toBeNull();
  expect(linkedSessionId("?date=all")).toBeNull();
});
