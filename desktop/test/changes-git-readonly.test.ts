// HerdrKit AgentChangesGitReadOnlyTests: no program set up in
// the repository or in the user's git config runs from a Changes read: clean, smudge
// and process filters (the repository's own, a global config's through
// include.path, a submodule's), the signature verifier, and the
// pager, fsmonitor, an external diff, textconv and an alias. An LFS-style file
// is still listed. Temporary repositories under the scratch folder; the
// "global" config is a scratch file (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM=1).
// Each test first shows its helper does run under a plain git, so a pass is
// not vacuous.

import { chmodSync, existsSync, renameSync, utimesSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/shared/chat/locator";
import { defaultChangesLimits, gitFileChange, isUnstaged, type GitFolderRead } from "../src/shared/changes/git";
import { AgentChangesGitReader, CommandGate } from "../src/shared/changes/reader";
import { LocalShell, git, makeRepository, makeRoot, plainGitCommand, write } from "./support/changes-git";

function reader(global?: string): AgentChangesGitReader {
  return new AgentChangesGitReader(new LocalShell("/bin/sh", global === undefined ? {} : { GIT_CONFIG_GLOBAL: global }), new CommandGate(3), defaultChangesLimits);
}

/** A command that leaves a stamp when it runs, then passes its input on. */
const stamping = (stamp: string): string => `printf ran >> ${shellQuote(stamp)}; cat`;
const ran = (stamp: string): boolean => existsSync(stamp);
/** The control's stamp moved aside (nothing is deleted), so the read under test starts with none. */
const setAside = (stamp: string): void => renameSync(stamp, `${stamp}.control-${Date.now()}`);

/** Plain git in the folder (the user's own `git diff`), with the given global config: the control. */
function plainGit(args: readonly string[], folder: string, global?: string): Promise<string> {
  return new LocalShell("/bin/sh", global === undefined ? {} : { GIT_CONFIG_GLOBAL: global }, false).runReadOnlyCommand(plainGitCommand(args, folder), 1 << 20);
}

/** Everything Changes reads in a folder: its status, every file's diff, the commits and each commit. */
async function readEverything(r: AgentChangesGitReader, folder: string): Promise<GitFolderRead> {
  const read = await r.status(folder);
  if (read.kind === "repository") for (const file of read.status.files) await r.fileDiff(folder, file);
  const commits = await r.commits(folder, -Infinity);
  if (commits.kind === "commits") for (const commit of commits.commits) await r.show(folder, commit.hash);
  return read;
}

/** The same size, new content and a new time: git has to read the file (through its clean filter) to know it changed. */
function touchSameSize(name: string, text: string, folder: string): void {
  write(text, name, folder);
  const later = new Date(Date.now() + 5_000);
  utimesSync(path.join(folder, name), later, later);
}

describe("a Changes read starts no configured helper", () => {
  it("runs none of the repository's clean, smudge and process filters", async () => {
    const root = makeRoot("filter");
    const repo = path.join(root, "repo");
    makeRepository(repo);
    write("*.swift filter=review\n*.txt filter=other\n", ".gitattributes", repo);
    touchSameSize("work file.swift", "a\nC\nc\nd\n", repo);
    const stamp = path.join(root, "filter-ran");
    git(["config", "filter.review.clean", stamping(stamp)], repo);
    git(["config", "filter.review.smudge", stamping(stamp)], repo);
    git(["config", "filter.review.required", "true"], repo);
    git(["config", "filter.other.process", stamping(stamp)], repo);
    await plainGit(["diff", "--numstat"], repo);
    expect(ran(stamp), "control: plain git runs the filter").toBe(true);
    setAside(stamp);

    const read = await readEverything(reader(), repo);
    expect(ran(stamp), "a Changes read ran the repository's filter").toBe(false);
    if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
    expect(read.status.files.some((f) => f.path === "work file.swift" && isUnstaged(f))).toBe(true);
    // A tracked file through a filter: its diff is not run (it says so); an untracked one shows as it is on disk.
    for (const name of ["work file.swift", "staged.swift"]) {
      const change = read.status.files.find((f) => f.path === name)!;
      expect(await reader().fileDiff(repo, change), name).toEqual({ kind: "runsAFilter" });
    }
    const untracked = read.status.files.find((f) => f.path === "un\ntracked $x.txt")!;
    const shown = await reader().fileDiff(repo, untracked);
    if (shown.kind !== "text") throw new Error(`untracked not shown: ${shown.kind}`);
    expect(shown.text.parts[0]?.text).toContain("+u");
    const renamed = read.status.files.find((f) => f.path === "new.txt")!;
    expect(await reader().fileDiff(repo, renamed)).toEqual({ kind: "runsAFilter" });
    expect(ran(stamp)).toBe(false);
  });

  it("runs neither a global config's included filter nor its pager, fsmonitor, external diff, textconv or alias", async () => {
    const root = makeRoot("global");
    const repo = path.join(root, "repo");
    makeRepository(repo);
    touchSameSize("work file.swift", "a\nC\nc\nd\n", repo);
    const global = path.join(root, "global.config");
    const included = path.join(root, "included.config");
    write("", "global.config", root);
    write("", "included.config", root);
    git(["config", "--file", global, "include.path", included], root);
    const helper = path.join(root, "helper-ran");
    const filter = path.join(root, "filter-ran");
    for (const key of ["core.fsmonitor", "core.pager", "diff.external", "diff.review.textconv"]) git(["config", "--file", included, key, stamping(helper)], root);
    git(["config", "--file", included, "alias.status", "!" + stamping(helper)], root);
    git(["config", "--file", included, "filter.review.clean", stamping(filter)], root);
    write("*.swift diff=review filter=review\n", ".gitattributes", repo);
    await plainGit(["diff", "--no-ext-diff", "--numstat"], repo, global);
    expect(ran(filter), "control: plain git runs the included filter").toBe(true);
    setAside(filter);
    if (ran(helper)) setAside(helper);

    const read = await readEverything(reader(global), repo);
    expect(ran(filter), "a Changes read ran the global config's included filter").toBe(false);
    expect(ran(helper), "a Changes read ran the pager, fsmonitor, an external diff, textconv or an alias").toBe(false);
    expect(read.kind).toBe("repository");
  });

  it("does not run the signature verifier when a commit is opened", async () => {
    const root = makeRoot("signature");
    const repo = path.join(root, "repo");
    makeRepository(repo);
    const stamp = path.join(root, "gpg-ran");
    const program = path.join(root, "gpg-helper");
    write(`#!/bin/sh\nprintf ran >> ${shellQuote(stamp)}\nexit 1\n`, "gpg-helper", root);
    chmodSync(program, 0o755);
    const tree = git(["rev-parse", "HEAD^{tree}"], repo).trim();
    const parent = git(["rev-parse", "HEAD"], repo).trim();
    const now = Math.floor(Date.now() / 1000);
    const object =
      `tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> ${now} +0000\n` +
      `committer Fixture <fixture@example.invalid> ${now} +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n` +
      " -----END PGP SIGNATURE-----\n\nA signed fixture\n";
    const hash = (await new LocalShell("/bin/sh").runReadOnlyCommand(`printf '%s' ${shellQuote(object)} | git -C ${shellQuote(repo)} hash-object -t commit -w --stdin`, 1_000)).trim();
    git(["update-ref", "refs/heads/main", hash], repo);
    git(["config", "log.showSignature", "true"], repo);
    git(["config", "gpg.program", program], repo);
    await plainGit(["show", "--stat", hash], repo);
    expect(ran(stamp), "control: plain git show runs the verifier").toBe(true);
    setAside(stamp);

    const shown = await reader().show(repo, hash);
    if (shown.kind !== "text") throw new Error(`not shown: ${shown.kind}`);
    expect(shown.text.parts[0]?.text).toContain("A signed fixture");
    const commits = await reader().commits(repo, -Infinity);
    if (commits.kind !== "commits") throw new Error(commits.kind);
    expect(commits.commits[0]?.hash).toBe(hash);
    expect(ran(stamp), "a Changes read ran the configured signature verifier").toBe(false);
  });

  it("still lists an LFS-style file and runs none of its filter", async () => {
    const root = makeRoot("lfs");
    const repo = path.join(root, "repo");
    git(["init", "-q", "-b", "main", repo], root);
    write("*.bin filter=lfs diff=lfs merge=lfs -text\n", ".gitattributes", repo);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"4".repeat(64)}\nsize 12\n`;
    write(pointer, "assets/model.bin", repo);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "Track the model with LFS"], repo);
    const stamp = path.join(root, "lfs-ran");
    for (const key of ["filter.lfs.process", "filter.lfs.clean", "filter.lfs.smudge", "diff.lfs.textconv"]) git(["config", key, stamping(stamp)], repo);
    git(["config", "filter.lfs.required", "true"], repo);
    touchSameSize("assets/model.bin", "M".repeat(Buffer.byteLength(pointer)), repo);
    write("fresh\n", "assets/fresh.bin", repo);
    await plainGit(["diff", "--numstat"], repo);
    expect(ran(stamp), "control: plain git runs the LFS filter").toBe(true);
    setAside(stamp);

    const read = await readEverything(reader(), repo);
    expect(ran(stamp), "a Changes read ran the LFS filter").toBe(false);
    if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
    const model = read.status.files.find((f) => f.path === "assets/model.bin");
    const fresh = read.status.files.find((f) => f.path === "assets/fresh.bin");
    expect(model?.worktreeStatus).toBe("M");
    expect(fresh?.indexStatus).toBe("?");
    expect(await reader().fileDiff(repo, model!)).toEqual({ kind: "runsAFilter" });
    const shown = await reader().fileDiff(repo, fresh!);
    if (shown.kind !== "text") throw new Error(`untracked not shown: ${shown.kind}`);
    expect(shown.text.parts[0]?.text).toContain("+fresh");
    expect(ran(stamp)).toBe(false);
  });

  it("does not look into a submodule, so its own filter does not run", async () => {
    const root = makeRoot("submodule");
    const child = path.join(root, "child");
    const parent = path.join(root, "parent");
    makeRepository(child);
    git(["add", "-A"], child);
    git(["commit", "-q", "-m", "Child"], child);
    makeRepository(parent);
    git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "module"], parent);
    git(["commit", "-q", "-m", "Add the module"], parent);
    const module = path.join(parent, "module");
    const stamp = path.join(root, "submodule-filter-ran");
    write("*.swift filter=inner\n", ".gitattributes", module);
    git(["config", "filter.inner.clean", stamping(stamp)], module);
    touchSameSize("module/work file.swift", "a\nC\nc\nd\n", parent);
    await plainGit(["status", "--porcelain=v1"], parent);
    expect(ran(stamp), "control: plain git status runs the submodule's filter").toBe(true);
    setAside(stamp);

    const read = await readEverything(reader(), parent);
    expect(ran(stamp), "a Changes read ran a submodule's filter").toBe(false);
    if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
    expect(read.status.files.some((f) => f.path === "module"), "work-tree changes inside it are not looked into").toBe(false);
    // A new commit in it still shows (its commit id, read in place).
    git(["-c", "filter.inner.clean=", "commit", "-q", "-am", "Inside"], module);
    renameSync(path.join(module, ".gitattributes"), path.join(module, "attributes.off"));
    const moved = await reader().status(parent);
    if (moved.kind !== "repository") throw new Error(moved.kind);
    expect(moved.status.files.find((f) => f.path === "module")?.worktreeStatus).toBe("M");
    expect(ran(stamp)).toBe(false);
  });

  it("does not read a folder whose filter git cannot be told to skip (an = in its name)", async () => {
    const root = makeRoot("unsayable");
    const repo = path.join(root, "repo");
    makeRepository(repo);
    write("*.swift filter=a=b\n", ".gitattributes", repo);
    touchSameSize("work file.swift", "a\nC\nc\nd\n", repo);
    const stamp = path.join(root, "filter-ran");
    git(["config", "filter.a=b.clean", stamping(stamp)], repo);
    await plainGit(["diff", "--numstat"], repo);
    expect(ran(stamp), "control: plain git runs the filter").toBe(true);
    setAside(stamp);

    const read = await readEverything(reader(), repo);
    expect(ran(stamp), "a Changes read ran a filter named with an =").toBe(false);
    expect(read).toEqual({ kind: "runsAFilter" });
    expect(await reader().fileDiff(repo, gitFileChange("work file.swift", " ", "M"))).toEqual({ kind: "runsAFilter" });
    // Its commits are still read (no working copy goes through a filter).
    const commits = await reader().commits(repo, -Infinity);
    if (commits.kind !== "commits") throw new Error(commits.kind);
    expect(commits.commits.length).toBe(1);
  });
});
