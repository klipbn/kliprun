import { describe, expect, test } from "bun:test";
import { calendarPeriod, dateRange, parseFilters, refreshRelativeFilters, serializeFilters } from "../filters";

describe("statistics calendar periods", () => {
  test("seven days includes today and uses calendar boundaries across DST", () => {
    const range = calendarPeriod("7", Date.parse("2026-11-03T18:00:00Z"), "America/New_York");
    expect(range.from).toBe(Date.parse("2026-10-28T04:00:00Z"));
    expect(range.to).toBe(Date.parse("2026-11-04T05:00:00Z"));
  });
  test("custom end date includes the entire chosen local day", () => {
    const range = dateRange("2026-03-08", "2026-03-08", "America/New_York");
    expect(range).toEqual({ from: Date.parse("2026-03-08T05:00:00Z"), to: Date.parse("2026-03-09T04:00:00Z") });
    expect(dateRange("2026-10-08", "2026-10-07", "Europe/Moscow")).toBeNull();
    expect(dateRange("2026-02-31", "2026-03-03", "Europe/Moscow")).toBeNull();
  });
  test("a skipped midnight starts at the first actual instant of that local date", () => {
    const range = dateRange("2018-11-04", "2018-11-04", "America/Sao_Paulo");
    expect(range).toEqual({ from: Date.parse("2018-11-04T03:00:00Z"), to: Date.parse("2018-11-05T02:00:00Z") });
    expect(calendarPeriod("today", Date.parse("2018-11-04T12:00:00Z"), "America/Sao_Paulo")).toEqual(range!);
  });
});

describe("statistics URL filters", () => {
  test("a saved relative preset is recalculated when reopened on a later day", () => {
    const filters = parseFilters("?period=today&from=1791234000000&to=1791320400000&timezone=Europe%2FMoscow&agent=build", Date.parse("2026-10-07T10:00:00Z"));
    expect(filters.from).toBe(Date.parse("2026-10-06T21:00:00Z"));
    expect(filters.to).toBe(Date.parse("2026-10-07T21:00:00Z"));
    expect(filters.agents).toEqual(["build"]);
  });
  test("the relative tick crosses local midnight while preserving explicit custom dates", () => {
    const filters = parseFilters("?period=today&agent=build&timezone=Europe%2FMoscow", Date.parse("2026-10-07T20:59:00Z"));
    expect(refreshRelativeFilters(filters, "today", Date.parse("2026-10-07T20:59:30Z"))).toBe(filters);
    const next = refreshRelativeFilters(filters, "today", Date.parse("2026-10-07T21:00:00Z"));
    expect(next.from).toBe(Date.parse("2026-10-07T21:00:00Z"));
    expect(next.to).toBe(Date.parse("2026-10-08T21:00:00Z"));
    expect(next.agents).toEqual(["build"]);
    expect(refreshRelativeFilters(filters, "custom", Date.parse("2026-10-08T10:00:00Z"))).toBe(filters);
  });
  test("invalid ranges and enums fall back without retaining invalid selections", () => {
    const filters = parseFilters("?from=Infinity&to=-1&role=admin&source=codex&source=other&granularity=year", Date.parse("2026-10-07T10:00:00Z"), "Europe/Moscow");
    expect(filters.from).toBe(Date.parse("2026-09-30T21:00:00Z"));
    expect(filters.to).toBe(Date.parse("2026-10-07T21:00:00Z"));
    expect(filters.role).toBe("all");
    expect(filters.granularity).toBe("day");
    expect(filters.sources).toEqual(["codex"]);
  });
  test("multiple selections round trip including paths and model names", () => {
    const filters = parseFilters("?from=0&to=1000000&timezone=UTC&source=opencode&source=codex&agent=build&agent=plan&model=proxy%2Fgpt-6&project=%2Fa%20b&role=children&granularity=week");
    const query = serializeFilters(filters);
    expect(query.getAll("agent")).toEqual(["build", "plan"]);
    expect(query.getAll("source")).toEqual(["opencode", "codex"]);
    expect(parseFilters(query.toString())).toEqual(filters);
  });
});
