// A Changes read never runs a filter from the
// folder's git config. The filter keys git lists are read NUL-terminated (`git
// config -z --name-only --get-regexp`) and byte for byte (`od`), never split on
// a newline or on IFS; each whole key is checked (`filter.<name>.<variable>`); a
// key that is not one, or a name a `-c` cannot say (an "="), stops the read with
// its note before any git command that could apply a filter; and every git call
// Changes makes, the log's too, carries each name's empty commands. Temporary
// repositories under the scratch folder, no user or system git config; each test
// first shows its filter does run under a plain git.

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/shared/chat/locator";
import {
  changeKind,
  defaultChangesLimits,
  fileDiffCommand,
  gitFileChange,
  isUnstaged,
  logCommand,
  showCommand,
  statusCommand,
  type GitFolderRead,
} from "../src/shared/changes/git";
import { AgentChangesGitReader, CommandGate } from "../src/shared/changes/reader";
import { LocalShell, git, makeRoot, plainGitCommand, write } from "./support/changes-git";

const nonce = "N0NCE";

function reader(environment: Record<string, string> = {}): AgentChangesGitReader {
  return new AgentChangesGitReader(new LocalShell("/bin/sh", environment), new CommandGate(3), defaultChangesLimits);
}

/** A command that leaves a stamp when it runs, then passes its input on. */
const stamping = (stamp: string): string => `printf ran >> ${shellQuote(stamp)}; cat`;
const ran = (stamp: string): boolean => existsSync(stamp);
/** The control's stamp moved aside (nothing is deleted), so the read under test starts with none. */
const setAside = (stamp: string): void => renameSync(stamp, `${stamp}.control-${randomUUID()}`);

/** Plain git in the folder (the user's own command): the control. */
function plainGit(args: readonly string[], folder: string): Promise<string> {
  return new LocalShell("/bin/sh", {}, false).runReadOnlyCommand(plainGitCommand(args, folder), 1 << 20);
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

/** One commit with file.txt, then file.txt changed at the same size with a new time. */
function makeRepository(folder: string, attributes: string): void {
  mkdirSync(folder, { recursive: true });
  git(["init", "-q", "-b", "main", "."], folder);
  write("one\n", "file.txt", folder);
  write(attributes, ".gitattributes", folder);
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "First"], folder);
  touchSameSize("file.txt", "ONE\n", folder);
}

/** The commands of every git call Changes makes. */
function commands(folder: string): string[] {
  return [
    statusCommand(folder, nonce, 1_000),
    fileDiffCommand(folder, gitFileChange("a.txt", " ", "M"), nonce, 1_000),
    fileDiffCommand(folder, gitFileChange("b.txt", "?", "?"), nonce, 1_000),
    showCommand(folder, "c".repeat(40), nonce, 1_000)!,
    logCommand(folder, 1_793_570_000, 5, nonce, 1_000),
  ];
}

describe("a Changes read never runs the folder's git filter", () => {
  it("reads the filter keys NUL-terminated in every command and turns each one off", () => {
    for (const command of commands("/r")) {
      expect(command).toContain(" config -z --name-only --get-regexp ");
      expect(command, "byte for byte").toContain("od -An -v -to1");
      expect(command, "no list split on IFS").not.toContain("IFS=");
      expect(command, "no newline-separated list").not.toContain(" config --name-only ");
      for (const variable of ["clean=", "smudge=", "process=", "required=false"]) expect(command, variable).toContain(`-c "filter.$n.${variable}"`);
      // No newline anywhere (a folder without one), so no reading of the source can differ from what the shell runs.
      expect(command.includes("\n"), command).toBe(false);
    }
  });

  it("does not run a filter named n", async () => {
    const root = makeRoot("filter-keys-named-n");
    const repo = path.join(root, "repo");
    makeRepository(repo, "*.txt filter=n\n");
    const stamp = path.join(root, "sentinel");
    git(["config", "filter.n.clean", stamping(stamp)], repo);
    await plainGit(["diff", "--numstat"], repo);
    expect(ran(stamp), "control: plain git runs filter n").toBe(true);
    setAside(stamp);

    const read = await readEverything(reader(), repo);
    expect(ran(stamp), "a Changes read ran filter n").toBe(false);
    if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
    const change = read.status.files.find((f) => f.path === "file.txt");
    expect(change && isUnstaged(change), JSON.stringify(read.status.files)).toBe(true);
    expect(await reader().fileDiff(repo, change!), "its own filter: not diffed").toEqual({ kind: "runsAFilter" });
    expect(ran(stamp)).toBe(false);
  });

  it("fails closed on a filter. key that is not a filter's (and still reads the commits)", async () => {
    const root = makeRoot("filter-keys-not-a-filter-key");
    const repo = path.join(root, "repo");
    makeRepository(repo, "*.txt filter=n\n");
    const stamp = path.join(root, "sentinel");
    git(["config", "filter.n.clean", stamping(stamp)], repo);
    git(["config", "filter.clean", stamping(stamp)], repo);
    await plainGit(["diff", "--numstat"], repo);
    expect(ran(stamp), "control: plain git runs filter n").toBe(true);
    setAside(stamp);

    expect(await readEverything(reader(), repo)).toEqual({ kind: "runsAFilter" });
    expect(await reader().fileDiff(repo, gitFileChange("file.txt", " ", "M"))).toEqual({ kind: "runsAFilter" });
    const commits = await reader().commits(repo, -Infinity);
    if (commits.kind !== "commits") throw new Error(commits.kind);
    expect(commits.commits.length).toBe(1);
    expect(await reader().show(repo, commits.commits[0]!.hash)).toEqual({ kind: "runsAFilter" });
    expect(ran(stamp), "a Changes read ran a filter").toBe(false);
  });
});

// MARK: - The matrix

/** A repository with one file per attribute line, committed, then each changed at the same size with a new time. */
function makeFiles(folder: string, files: readonly (readonly [string, string])[]): void {
  mkdirSync(folder, { recursive: true });
  git(["init", "-q", "-b", "main", "."], folder);
  for (const [name] of files) write("one\n", name, folder);
  write(files.map(([name, attributes]) => `/${name} ${attributes}\n`).join(""), ".gitattributes", folder);
  git(["add", "-A"], folder);
  git(["commit", "-q", "-m", "First"], folder);
  for (const [name] of files) touchSameSize(name, "ONE\n", folder);
}

/** The control, the read, and what it must show: no stamp, the folder read, every file listed as changed. */
async function expectNothingRuns(repo: string, stamp: string, files: readonly string[], control: readonly string[] = ["diff", "--numstat"]): Promise<void> {
  await plainGit(control, repo);
  expect(ran(stamp), `control: plain git ${control.join(" ")} runs it`).toBe(true);
  setAside(stamp);
  const read = await readEverything(reader(), repo);
  expect(ran(stamp), "a Changes read ran it").toBe(false);
  if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
  for (const name of files) {
    const change = read.status.files.find((f) => f.path === name);
    expect(change === undefined ? "missing" : changeKind(change), name).toBe("modified");
  }
}

/** A `git` first on the PATH that answers the filter list with `keys` and `exit`, passes every other call to /usr/bin/git, and writes each call's arguments to `calls`. */
function fakeGit(root: string, keys: Buffer, exit: number): { environment: Record<string, string>; calls: string } {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const list = path.join(root, "keys");
  const calls = path.join(root, "calls");
  writeFileSync(list, keys);
  writeFileSync(
    path.join(bin, "git"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + shellQuote(calls) + "\n" +
      'case " $* " in *" config -z --name-only --get-regexp "*) cat ' + shellQuote(list) + "; exit " + String(exit) + ";; esac\n" +
      'exec /usr/bin/git "$@"\n',
  );
  chmodSync(path.join(bin, "git"), 0o755);
  return { environment: { PATH: `${bin}:/usr/bin:/bin` }, calls };
}

const ranCalls = (calls: string): string[] => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line.length > 0) : []);

/** The calls that could reach a filter (anything but the folder's checks, the list, the top and the attribute lookup). */
const couldApplyAFilter = (call: string): boolean =>
  !(call.includes(" rev-parse --is-inside-work-tree") || call.includes(" config -z --name-only --get-regexp ") || call.includes(" rev-parse --show-cdup") || call.includes(" check-attr filter "));

describe("no filter, text conversion or external diff runs, whatever the names", () => {
  it("runs none of several filters at once", async () => {
    const root = makeRoot("filter-keys-several");
    const repo = path.join(root, "repo");
    const files = ["model.bin", "n.txt", "review.swift", "other.md"];
    makeFiles(repo, [
      ["model.bin", "filter=lfs diff=lfs -text"],
      ["n.txt", "filter=n"],
      ["review.swift", "filter=review"],
      ["other.md", "filter=other"],
    ]);
    const stamp = path.join(root, "sentinel");
    for (const key of ["filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.process", "filter.n.clean", "filter.review.clean", "filter.review.smudge", "filter.other.process"]) {
      git(["config", key, stamping(stamp)], repo);
    }
    git(["config", "filter.lfs.required", "true"], repo);
    git(["config", "filter.review.required", "true"], repo);
    await expectNothingRuns(repo, stamp, files);
  });

  it("runs no filter with dots, quotes, $, backquotes, %, an empty or a UTF-8 name, and names no attribute can select do not stop the read", async () => {
    const root = makeRoot("filter-keys-awkward");
    const repo = path.join(root, "repo");
    const selected = ["a.b.c", "q\"u'o", "$x`y`%s%%", "", "é"];
    const files = selected.map((_, index) => `f${index}.txt`);
    makeFiles(repo, files.map((file, index) => [file, "filter=" + selected[index]!] as const));
    const stamps = selected.map((_, index) => path.join(root, `sentinel-${index}`));
    selected.forEach((name, index) => git(["config", `filter.${name}.clean`, stamping(stamps[index]!)], repo));
    const unselectable = path.join(root, "sentinel-unselectable");
    for (const name of ["my \"q\" 's' x", "tab\there", "back\\slash", "$(touch x)"]) git(["config", `filter.${name}.clean`, stamping(unselectable)], repo);
    await plainGit(["diff", "--numstat"], repo);
    selected.forEach((name, index) => {
      expect(ran(stamps[index]!), `control: plain git runs filter ${name}`).toBe(true);
      setAside(stamps[index]!);
    });
    const read = await readEverything(reader(), repo);
    selected.forEach((name, index) => expect(ran(stamps[index]!), `a Changes read ran filter ${name}`).toBe(false));
    expect(ran(unselectable)).toBe(false);
    if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
    for (const name of files) expect(read.status.files.find((f) => f.path === name)?.worktreeStatus, name).toBe("M");
  });

  it("runs no filter whose command spans lines and whose output carries newlines", async () => {
    const root = makeRoot("filter-keys-newlines");
    const repo = path.join(root, "repo");
    makeFiles(repo, [["file.txt", "filter=n"]]);
    const stamp = path.join(root, "sentinel");
    const command = `printf ran >> ${shellQuote(stamp)}\nprintf 'first\\nsecond\\n'\ncat\nprintf '\\nfilter.n.clean\\n'`;
    git(["config", "filter.n.clean", command], repo);
    git(["config", "filter.n.smudge", command], repo);
    await expectNothingRuns(repo, stamp, ["file.txt"]);
  });

  it("runs no clean, smudge or process command, each the only one its filter has (smudge's control: git show with a text conversion)", async () => {
    for (const [variable, control] of [
      ["clean", ["diff", "--numstat"]],
      ["process", ["diff", "--numstat"]],
      ["smudge", ["show", "HEAD"]],
    ] as const) {
      const root = makeRoot(`filter-keys-only-${variable}`);
      const repo = path.join(root, "repo");
      makeFiles(repo, [["file.txt", "filter=n diff=t"]]);
      const stamp = path.join(root, "sentinel");
      git(["config", `filter.n.${variable}`, stamping(stamp)], repo);
      git(["config", "diff.t.textconv", "cat"], repo);
      await expectNothingRuns(repo, stamp, ["file.txt"], control);
    }
  });

  it("runs no text conversion, diff driver command or diff.external", async () => {
    const root = makeRoot("filter-keys-textconv");
    const repo = path.join(root, "repo");
    makeFiles(repo, [
      ["file.txt", "diff=d"],
      ["other.md", "plain"],
    ]);
    write("u\n", "new.txt", repo);
    write("/file.txt diff=d\n/other.md plain\n/new.txt diff=d\n", ".gitattributes", repo);
    const textconv = path.join(root, "textconv-ran");
    const driver = path.join(root, "command-ran");
    const external = path.join(root, "external-ran");
    git(["config", "diff.d.textconv", stamping(textconv)], repo);
    git(["config", "diff.d.command", `printf ran >> ${shellQuote(driver)}`], repo);
    git(["config", "diff.external", `printf ran >> ${shellQuote(external)}`], repo);
    await plainGit(["diff"], repo);
    expect(ran(driver), "control: plain git diff runs the driver's command").toBe(true);
    expect(ran(external), "control: plain git diff runs diff.external").toBe(true);
    await plainGit(["diff", "--no-ext-diff"], repo);
    expect(ran(textconv), "control: plain git diff runs the text conversion").toBe(true);
    for (const stamp of [textconv, driver, external]) setAside(stamp);

    const read = await readEverything(reader(), repo);
    if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
    expect(new Set(read.status.files.map((f) => f.path))).toEqual(new Set(["file.txt", "other.md", "new.txt", ".gitattributes"]));
    for (const stamp of [textconv, driver, external]) expect(ran(stamp), `a Changes read ran ${path.basename(stamp)}`).toBe(false);
  });
});

describe("a filter list git could not have written stops the read", () => {
  const cases: readonly { name: string; keys: Buffer; exit: number; read: "runsAFilter" | "failed" }[] = [
    { name: "a newline in a key", keys: Buffer.from("filter.a\nb.clean\0"), exit: 0, read: "runsAFilter" },
    { name: "a variable git would not write", keys: Buffer.from("filter.n.CLEAN\0"), exit: 0, read: "runsAFilter" },
    { name: "not a filter key", keys: Buffer.from("core.n.clean\0"), exit: 0, read: "runsAFilter" },
    { name: "an empty key", keys: Buffer.from("filter.n.clean\0\0"), exit: 0, read: "runsAFilter" },
    { name: "a key not ended", keys: Buffer.from("filter.n.clean"), exit: 0, read: "failed" },
    { name: "git failed", keys: Buffer.alloc(0), exit: 128, read: "failed" },
    { name: "a bad config file", keys: Buffer.alloc(0), exit: 3, read: "failed" },
  ];
  for (const entry of cases) {
    it(`${entry.name}: ${entry.read}, before any command that could apply a filter (the commits still read)`, async () => {
      const root = makeRoot(`filter-keys-fake-${entry.name.replaceAll(" ", "-")}`);
      const repo = path.join(root, "repo");
      makeFiles(repo, [["file.txt", "filter=n"]]);
      const stamp = path.join(root, "sentinel");
      git(["config", "filter.n.clean", stamping(stamp)], repo);
      const fake = fakeGit(root, entry.keys, entry.exit);
      const r = reader(fake.environment);

      expect(await r.status(repo)).toEqual({ kind: entry.read });
      expect(await r.fileDiff(repo, gitFileChange("file.txt", " ", "M"))).toEqual({ kind: entry.read });
      expect(await r.fileDiff(repo, gitFileChange("file.txt", "?", "?"))).toEqual({ kind: entry.read });
      const head = git(["rev-parse", "HEAD"], repo).trim();
      expect(await r.show(repo, head)).toEqual({ kind: entry.read });
      expect(ranCalls(fake.calls).filter(couldApplyAFilter)).toEqual([]);
      // The log, stored commits only, still reads.
      const commits = await r.commits(repo, -Infinity);
      if (commits.kind !== "commits") throw new Error(commits.kind);
      expect(commits.commits.length).toBe(1);
      expect(ran(stamp), "a Changes read ran a filter").toBe(false);
    });
  }

  it("turns the names git listed off on every call that could reach a filter, the log's too", async () => {
    const root = makeRoot("filter-keys-fake-listed");
    const repo = path.join(root, "repo");
    makeFiles(repo, [["file.txt", "filter=n"]]);
    write("u\n", "new.txt", repo);
    const stamp = path.join(root, "sentinel");
    git(["config", "filter.n.clean", stamping(stamp)], repo);
    const fake = fakeGit(root, Buffer.from('filter.n.clean\0filter.my "q" x.smudge\0'), 0);
    const read = await readEverything(reader(fake.environment), repo);
    if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
    const filtering = ranCalls(fake.calls).filter(couldApplyAFilter);
    for (const verb of [" status --porcelain", " diff --numstat", " diff --cached --numstat", " diff --no-index", " show ", " log --no-color", " symbolic-ref "]) {
      expect(filtering.some((call) => call.includes(verb)), `${verb} not run: ${filtering.join("\n")}`).toBe(true);
    }
    for (const call of filtering) {
      expect(call).toContain("-c filter.n.clean= -c filter.n.smudge= -c filter.n.process= -c filter.n.required=false");
      expect(call).toContain('-c filter.my "q" x.clean=');
    }
    expect(ran(stamp)).toBe(false);
  });
});
