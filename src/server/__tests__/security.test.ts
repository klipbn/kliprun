import { describe, expect, test } from "bun:test";
import { scrub } from "../security";

describe("scrub", () => {
  test("redacts dict keys that look like secrets", () => {
    const result = scrub({ api_key: "abc", nested: { password: "x", safe: "ok" } });
    expect(result).toEqual({
      api_key: "[redacted]",
      nested: { password: "[redacted]", safe: "ok" },
    });
  });

  test("redacts inline bearer tokens and assignments in strings", () => {
    expect(scrub("Authorization: Bearer abc.def-ghi_123")).toBe("Authorization: Bearer [redacted]");
    expect(scrub("api_key=supersecret123")).toBe("api_key=[redacted]");
    expect(scrub("token: value123, other")).toBe("token: [redacted], other");
  });

  test("redacts environment variable values in strings", () => {
    process.env["KLIPRUN_TEST_SECRET_TOKEN"] = "super-secret-value-123";
    try {
      expect(scrub("leaked super-secret-value-123 here")).toBe("leaked [redacted] here");
    } finally {
      delete process.env["KLIPRUN_TEST_SECRET_TOKEN"];
    }
  });

  test("leaves clean data untouched, handles arrays", () => {
    expect(scrub(["plain", { ok: 1 }])).toEqual(["plain", { ok: 1 }]);
  });
});
