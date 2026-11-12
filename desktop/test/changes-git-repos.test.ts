// HerdrKit AgentChangesGitTests, the real half: the
// commands run for real through zsh and sh against temporary repositories made
// under the scratch folder, whose names carry spaces, quotes, `$`, backticks, a
// newline and a leading dash; a file's diff from a subfolder with both parts; a
// detached HEAD and a repository with no commits; the commits since the first
// turn with a merge shown against its first parent; nothing written to the
// repository; a diff past its bound cut there.

import { mkdirSync, readFileSync, realpathSync, statSync, existsSync, utimesSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { changeKind, defaultChangesLimits, gitFileChange, isStaged, isUnstaged, untrackedCount, type GitFolderRead, type GitFolderStatus } from "../src/shared/changes/git";
import { AgentChangesGitReader, CommandGate } from "../src/shared/changes/reader";
import { LocalShell, git, makeRepository, makeRoot, write } from "./support/changes-git";

const reader = (shell: string): AgentChangesGitReader => new AgentChangesGitReader(new LocalShell(shell), new CommandGate(3), defaultChangesLimits);
const seconds = (iso: string): number => Date.parse(iso) / 1000;

function repository(read: GitFolderRead, what: string): GitFolderStatus {
  if (read.kind !== "repository") throw new Error(`${what}: not read (${read.kind})`);
  return read.status;
}

describe("real repositories", () => {
  it("are read in awkward folders through zsh and sh", { timeout: 60_000 }, async () => {
    const root = makeRoot("status");
    const names = ["plain", "with space", "it's quoted", "dollar $HOME and $(echo no)", "back`tick`", "new\nline", 'double"quote', "-dash", "semi;colon && echo no"];
    for (const name of names) makeRepository(path.join(root, name));
    const plain = path.join(root, "not a repo");
    mkdirSync(plain, { recursive: true });
    for (const shell of ["/bin/zsh", "/bin/sh"]) {
      const r = reader(shell);
      for (const name of names) {
        const folder = path.join(root, name);
        const status = repository(await r.status(folder), `${shell} ${name}`);
        expect(status.head, `${shell} ${name}`).toEqual({ kind: "branch", name: "main" });
        expect(new Set(status.files.map((f) => f.path)), `${shell} ${name}`).toEqual(new Set(["work file.swift", "staged.swift", "new.txt", "un\ntracked $x.txt"]));
        const work = status.files.find((f) => f.path === "work file.swift")!;
        expect(work.added).toBe(2);
        expect(work.removed).toBe(1);
        expect(isUnstaged(work)).toBe(true);
        const renamed = status.files.find((f) => f.path === "new.txt")!;
        expect(changeKind(renamed)).toBe("renamed");
        expect(renamed.originalPath).toBe("old.txt");
        expect(untrackedCount(status)).toBe(1);
        expect(status.cut).toBe(false);
        expect(realpathSync(status.top!)).toBe(realpathSync(folder));
      }
      expect(await r.status(plain), shell).toEqual({ kind: "notARepository" });
      expect(await r.status(root + "/gone"), shell).toEqual({ kind: "noFolder" });
    }
  });

  it("reads a file's diff from a subfolder with both parts, the path taken literally from the top", async () => {
    const repo = path.join(makeRoot("diff"), "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main", "."], repo);
    write("1\n2\n3\n", "src/a*b [c].swift", repo);
    write("x\n", "src/aXb c.swift", repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "First"], repo);
    write("1\n2 staged\n3\n", "src/a*b [c].swift", repo);
    git(["add", "-A"], repo);
    write("1\n2 staged\n3\n4 not staged\n", "src/a*b [c].swift", repo);
    write("x changed\n", "src/aXb c.swift", repo);
    write("new\n", "src/fresh.txt", repo);
    // The user's config's i/ and w/ prefixes do not reach the view.
    git(["config", "diff.mnemonicPrefix", "true"], repo);
    const sub = path.join(repo, "src");
    const r = reader("/bin/zsh");
    const status = repository(await r.status(sub), "sub");
    const glob = status.files.find((f) => f.path === "src/a*b [c].swift")!;
    expect(isStaged(glob) && isUnstaged(glob)).toBe(true);
    const diff = await r.fileDiff(sub, glob);
    if (diff.kind !== "text") throw new Error(diff.kind);
    expect(diff.text.parts.map((p) => p.title)).toEqual(["Staged", "Not staged"]);
    expect(diff.text.parts[0]!.text).toContain("+2 staged");
    expect(diff.text.parts[1]!.text).toContain("+4 not staged");
    for (const part of diff.text.parts) {
      expect(part.text).toContain("--- a/src/a*b [c].swift");
      expect(part.text).toContain("+++ b/src/a*b [c].swift");
    }
    expect(diff.text.parts.some((p) => p.text.includes("aXb")), "the glob matched one file only").toBe(false);
    expect(diff.text.cut).toBe(false);

    const untracked = status.files.find((f) => f.path === "src/fresh.txt")!;
    const fresh = await r.fileDiff(sub, untracked);
    if (fresh.kind !== "text") throw new Error(fresh.kind);
    expect(fresh.text.parts.map((p) => p.title)).toEqual(["Untracked"]);
    expect(fresh.text.parts[0]!.text).toContain("+new");
    expect(fresh.text.parts[0]!.text).toContain("b/src/fresh.txt");
  });

  it("reads a detached HEAD and a repository with no commits", async () => {
    const root = makeRoot("heads");
    const r = reader("/bin/sh");
    const empty = path.join(root, "empty");
    mkdirSync(empty, { recursive: true });
    git(["init", "-q", "-b", "trunk", "."], empty);
    write("z\n", "z.txt", empty);
    git(["add", "z.txt"], empty);
    const unborn = repository(await r.status(empty), "unborn");
    expect(unborn.head).toEqual({ kind: "unborn", name: "trunk" });
    expect(unborn.files.map((f) => f.path)).toEqual(["z.txt"]);
    expect(unborn.files[0]!.added).toBe(1);
    expect(await r.commits(empty, -Infinity)).toEqual({ kind: "commits", commits: [] });

    const detached = path.join(root, "detached");
    makeRepository(detached);
    git(["commit", "-q", "-m", "Second"], detached);
    git(["checkout", "-q", "--detach", "HEAD~1"], detached);
    const first = git(["rev-parse", "HEAD"], detached).trim();
    expect(repository(await r.status(detached), "detached").head).toEqual({ kind: "detached", hash: first.slice(0, 7) });
  });

  it("reads the commits since the first turn and shows a merge against its first parent", async () => {
    const repo = path.join(makeRoot("log"), "it's a repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main", "."], repo);
    write("a\n", "a.txt", repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "Before"], repo, { date: "2026-11-02T00:30:00Z" });
    git(["checkout", "-q", "-b", "side"], repo);
    write("b\n", "b.txt", repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "Side"], repo, { date: "2026-11-02T01:10:00Z" });
    git(["checkout", "-q", "main"], repo);
    write("c\nc2\n", "c.txt", repo);
    write("a\nmore\n", "a.txt", repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "Main two files"], repo, { date: "2026-11-02T01:20:00Z" });
    git(["merge", "-q", "--no-edit", "side"], repo, { date: "2026-11-02T01:30:00Z" });
    const r = reader("/bin/zsh");
    const read = await r.commits(repo, seconds("2026-11-02T01:00:00.000Z"));
    if (read.kind !== "commits") throw new Error(read.kind);
    expect(read.commits.map((c) => c.subject)).toEqual(["Merge branch 'side'", "Main two files", "Side"]);
    expect(read.commits[0]!.parents).toBe(2);
    expect(read.commits[1]!.files).toBe(2);
    expect(read.commits[1]!.added).toBe(3);
    const merge = await r.show(repo, read.commits[0]!.hash);
    if (merge.kind !== "text") throw new Error(merge.kind);
    expect(merge.text.parts[0]!.text).toContain("diff --git a/b.txt b/b.txt");
    expect(merge.text.parts[0]!.text).toContain("1 file changed");
    expect(merge.text.parts[0]!.text).not.toContain("diff --cc");
  });

  it("writes nothing to the repository: a stat-dirty file leaves the index as it was, with no lock", async () => {
    const repo = path.join(makeRoot("readonly"), "repo");
    makeRepository(repo);
    const index = path.join(repo, ".git/index");
    const before = readFileSync(index);
    const stamp = statSync(index).mtimeMs;
    // Same content, a new time: a plain `git status` would refresh the index.
    write("one\ntwo\n", "staged.swift", repo);
    const later = new Date(Date.now() + 5_000);
    utimesSync(path.join(repo, "staged.swift"), later, later);
    const r = reader("/bin/zsh");
    const status = repository(await r.status(repo), "repo");
    for (const file of status.files) await r.fileDiff(repo, file);
    await r.commits(repo, -Infinity);
    await r.show(repo, git(["rev-parse", "HEAD"], repo).trim());
    expect(readFileSync(index).equals(before)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(stamp);
    expect(existsSync(path.join(repo, ".git/index.lock"))).toBe(false);
  });

  it("cuts one file's diff past 256 KB and says so", async () => {
    const repo = path.join(makeRoot("bound"), "repo");
    mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main", "."], repo);
    write("start\n", "big.txt", repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "First"], repo);
    write(Array.from({ length: 40_000 }, (_, i) => `line number ${i + 1}`).join("\n"), "big.txt", repo);
    const diff = await reader("/bin/zsh").fileDiff(repo, gitFileChange("big.txt", " ", "M"));
    if (diff.kind !== "text") throw new Error(diff.kind);
    expect(diff.text.cut).toBe(true);
    const bytes = diff.text.parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0);
    expect(bytes).toBeLessThanOrEqual(262_144);
    expect(bytes).toBeGreaterThan(200_000);
  });
});
