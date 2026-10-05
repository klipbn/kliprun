import { describe, expect, test } from "bun:test";
import { formatDuration, formatRelativeTimeVerbose, formatTokens } from "@shared/format";

describe("formatRelativeTimeVerbose", () => {
  test("buckets", () => {
    const now = Date.now();
    expect(formatRelativeTimeVerbose(now - 5_000)).toBe("just now");
    expect(formatRelativeTimeVerbose(now - 65_000)).toBe("1m ago");
    expect(formatRelativeTimeVerbose(null)).toBe("");
  });
});

describe("formatDuration", () => {
  test("buckets", () => {
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(64_000)).toBe("1m 4s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(7_200_000)).toBe("2h");
  });
});

describe("formatTokens", () => {
  test("buckets", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});
