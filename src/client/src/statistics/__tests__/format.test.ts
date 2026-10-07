import { expect, test } from "bun:test";
import { compare, count, dateLabel, duration, projectName, readable, tokens } from "../format";

test("statistics quantities use English separators and compact units", () => {
  expect(count(1234567)).toBe("1,234,567");
  expect(tokens(26400000)).toBe("26.4M");
});

test("statistics durations and unavailable values use English", () => {
  expect(duration(null)).toBe("No data");
  expect(duration(45000)).toBe("45s");
  expect(duration(150000)).toBe("2m");
  expect(duration(3900000)).toBe("1h 5m");
  expect(projectName("__unknown__")).toBe("Unknown");
  expect(readable("unknown")).toBe("Unknown");
});

test("English date labels preserve the selected timezone", () => {
  const instant = Date.parse("2026-10-07T00:30:00Z");
  expect(dateLabel(instant, "UTC")).toBe("Oct 7");
  expect(dateLabel(instant, "America/New_York")).toBe("Oct 6");
});

test("period comparisons have English labels for zero and missing baselines", () => {
  expect(compare(20, 10)).toBe("+100% vs. previous period");
  expect(compare(10, 20)).toBe("−50% vs. previous period");
  expect(compare(0, 0)).toBe("No change");
  expect(compare(10, 0)).toBe("Previously 0");
  expect(compare(10, null)).toBe("No comparison data");
});
