import { describe, expect, test } from "bun:test";
import { extractMrLinks, isMrCreationPart } from "../mergeRequests";

describe("extractMrLinks", () => {
  test("GitLab MR with /-/", () => {
    const links = extractMrLinks("created https://gitlab.example.com/team/project/-/merge_requests/814 ok");
    expect(links).toEqual([
      {
        url: "https://gitlab.example.com/team/project/-/merge_requests/814",
        label: "!814",
      },
    ]);
  });

  test("GitLab MR without /-/", () => {
    const links = extractMrLinks("see https://gitlab.com/group/project/merge_requests/42");
    expect(links[0]).toMatchObject({ label: "!42" });
  });

  test("GitHub PR uses # label", () => {
    const links = extractMrLinks("PR https://github.com/klipbn/streamlens/pull/7 merged");
    expect(links[0]).toMatchObject({ label: "#7" });
  });

  test("dedupes the same URL and strips trailing punctuation", () => {
    const text =
      "[MR|https://gitlab.com/a/b/-/merge_requests/1] and https://gitlab.com/a/b/-/merge_requests/1.";
    const links = extractMrLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://gitlab.com/a/b/-/merge_requests/1");
  });

  test("multiple different MRs keep order of appearance", () => {
    const links = extractMrLinks(
      "first https://gitlab.com/a/b/-/merge_requests/2 then https://github.com/x/y/pull/10",
    );
    expect(links.map((l) => l.label)).toEqual(["!2", "#10"]);
  });

  test("ignores bare mentions without a URL", () => {
    expect(extractMrLinks("merge_requests/5 pending, pull/9 soon")).toEqual([]);
  });
});

describe("isMrCreationPart", () => {
  test("MCP gitlab_create_merge_request counts as creation", () => {
    expect(
      isMrCreationPart({ type: "tool", tool: "gitlab_create_merge_request", state: { status: "completed" } }),
    ).toBe(true);
  });

  test("prefixed MCP names count", () => {
    expect(isMrCreationPart({ type: "tool", tool: "mcp__gitlab_create_merge_request" })).toBe(true);
    expect(isMrCreationPart({ type: "tool", tool: "github_create_pull_request" })).toBe(true);
  });

  test("read-only MR tools never count (foreign MRs)", () => {
    expect(isMrCreationPart({ type: "tool", tool: "gitlab_get_merge_request" })).toBe(false);
    expect(isMrCreationPart({ type: "tool", tool: "gitlab_list_merge_requests" })).toBe(false);
    expect(isMrCreationPart({ type: "tool", tool: "gitlab_add_merge_request_note" })).toBe(false);
    expect(isMrCreationPart({ type: "tool", tool: "gitlab_update_merge_request" })).toBe(false);
  });

  test("bash with an mr/pr create command counts", () => {
    expect(
      isMrCreationPart({
        type: "tool",
        tool: "bash",
        state: { input: { command: "glab mr create --title fix" } },
      }),
    ).toBe(true);
    expect(
      isMrCreationPart({
        type: "tool",
        tool: "bash",
        state: { input: { command: "gh pr create --fill" } },
      }),
    ).toBe(true);
    expect(
      isMrCreationPart({
        type: "tool",
        tool: "bash",
        state: { input: { command: "git push -o merge_request.create" } },
      }),
    ).toBe(true);
  });

  test("bash that merely reads/greps MR URLs does not count", () => {
    expect(
      isMrCreationPart({
        type: "tool",
        tool: "bash",
        state: { input: { command: "sqlite3 opencode.db 'SELECT data FROM part'" } },
      }),
    ).toBe(false);
    expect(
      isMrCreationPart({
        type: "tool",
        tool: "bash",
        state: { input: { command: "grep -r 'merge_requests/814' ." } },
      }),
    ).toBe(false);
  });

  test("create-MR skills count, other skills do not", () => {
    expect(
      isMrCreationPart({ type: "tool", tool: "skill", state: { input: { name: "generic-create-mr" } } }),
    ).toBe(true);
    expect(
      isMrCreationPart({
        type: "tool",
        tool: "skill",
        state: { input: { name: "generic-submit-for-review" } },
      }),
    ).toBe(true);
    expect(isMrCreationPart({ type: "tool", tool: "skill", state: { input: { name: "generic-yql" } } })).toBe(false);
  });

  test("non-tool parts never count", () => {
    expect(isMrCreationPart({ type: "text", text: "https://gitlab.com/a/b/-/merge_requests/1" })).toBe(false);
    expect(isMrCreationPart({ type: "reasoning", text: "should create an MR" })).toBe(false);
    expect(isMrCreationPart(null)).toBe(false);
  });
});
