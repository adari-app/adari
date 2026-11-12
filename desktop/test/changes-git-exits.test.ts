// Git's failures (the twin of HerdrKit's AgentChangesGitExitTests) are
// failures (Try again), not a clean folder or "nothing to show"; the exits git
// means (a detached HEAD's symbolic-ref, an unborn HEAD, diff --no-index finding
// a difference) are not; a repository with no commits has an empty history.
// Real temporary repositories under the scratch folder, run through a shell that
// takes exits as the app's runner does (a failure with nothing on stdout rejects).

import { mkdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultChangesLimits, gitFileChange, isUntracked } from "../src/shared/changes/git";
import { AgentChangesGitReader, CommandGate } from "../src/shared/changes/reader";
import { LocalShell, git, makeRepository, makeRoot, write } from "./support/changes-git";

const reader = new AgentChangesGitReader(new LocalShell("/bin/sh"), new CommandGate(3), defaultChangesLimits);

describe("git's exits", () => {
  it("reads a corrupt index as a failure, not a clean folder", async () => {
    const repo = path.join(makeRoot("index"), "repo");
    makeRepository(repo);
    write("not an index", ".git/index", repo);
    expect(await reader.status(repo), "git's failure must not read as a clean folder").toEqual({ kind: "failed" });
    expect(await reader.fileDiff(repo, gitFileChange("work file.swift", " ", "M")), "nor as nothing to show").toEqual({ kind: "failed" });
  });

  it("fails a commit that is not there", async () => {
    const repo = path.join(makeRoot("show"), "repo");
    makeRepository(repo);
    expect(await reader.show(repo, "1".repeat(40))).toEqual({ kind: "failed" });
  });

  it("gives a repository with no commits an empty history", async () => {
    const repo = path.join(makeRoot("unborn"), "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main", "."], repo);
    expect(await reader.commits(repo, -Infinity)).toEqual({ kind: "commits", commits: [] });
    write("z\n", "z.txt", repo);
    git(["add", "z.txt"], repo);
    const read = await reader.status(repo);
    if (read.kind !== "repository") throw new Error(read.kind);
    expect(read.status.head).toEqual({ kind: "unborn", name: "main" });
    expect(read.status.files[0]?.added).toBe(1);
    const diff = await reader.fileDiff(repo, read.status.files[0]!);
    if (diff.kind !== "text") throw new Error(diff.kind);
    expect(diff.text.parts.map((p) => p.title)).toEqual(["Staged"]);
  });

  it("does not take the exits git means as failures", async () => {
    const repo = path.join(makeRoot("meant"), "repo");
    makeRepository(repo);
    git(["commit", "-q", "-m", "Second"], repo);
    git(["checkout", "-q", "--detach", "HEAD~1"], repo);
    const read = await reader.status(repo);
    if (read.kind !== "repository") throw new Error(read.kind);
    expect(read.status.head.kind).toBe("detached");
    const untracked = read.status.files.find(isUntracked)!;
    const diff = await reader.fileDiff(repo, untracked);
    if (diff.kind !== "text") throw new Error(diff.kind);
    expect(diff.text.parts[0]?.text).toContain("+u");
    const commits = await reader.commits(repo, -Infinity);
    if (commits.kind !== "commits") throw new Error(commits.kind);
    expect(commits.commits.length).toBe(1);
  });
});
