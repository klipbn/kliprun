import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchOf, clearBranchCache } from "../vcs";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kliprun-vcs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  clearBranchCache();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("branchOf", () => {
  test("reads HEAD of a plain repo", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(branchOf(root)).toBe("main");
  });

  test("walks up from a nested directory", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/TRG-233968\n");
    const nested = join(root, "task", "subdir");
    mkdirSync(nested, { recursive: true });
    expect(branchOf(nested)).toBe("TRG-233968");
  });

  test("worktree .git file resolves gitdir HEAD", () => {
    const root = tempDir();
    const gitdir = join(root, "repo.git", "worktrees", "wt1");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feature-x\n");
    const worktree = join(root, "wt");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
    expect(branchOf(worktree)).toBe("feature-x");
  });

  test("detached HEAD yields null", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "1a2b3c4d5e6f\n");
    expect(branchOf(root)).toBeNull();
  });

  test("directory without a repo yields null", () => {
    const root = tempDir();
    expect(branchOf(root)).toBeNull();
  });

  test("result is cached per directory", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(branchOf(root)).toBe("main");
    // Change HEAD: the cached value persists within the TTL.
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/other\n");
    expect(branchOf(root)).toBe("main");
    clearBranchCache();
    expect(branchOf(root)).toBe("other");
  });
});
