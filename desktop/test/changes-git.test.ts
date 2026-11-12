// HerdrKit AgentChangesGitTests, the parsed half: git in an agent's folder, read only. The commands are built and their
// outputs parsed from hand-made outputs: every kind of entry, the heads, the
// markers, a cut, the exits (a failed section is a failure, the one the cut
// stopped is not judged), a log with file counts, a file's and a commit's parts.

import { describe, expect, it } from "vitest";

import {
  changedCount,
  changeKind,
  fileDiffCommand,
  gitFileChange,
  gitMarker,
  gitOutput,
  isFolder,
  isStaged,
  isUnstaged,
  logCommand,
  noFolderMarker,
  notARepositoryMarker,
  parseLog,
  parseStatus,
  parseText,
  shortHash,
  showCommand,
  statusAdded,
  statusCommand,
  statusRemoved,
  untrackedCount,
  type GitFileChange,
  type GitFolderStatus,
  type GitSection,
} from "../src/shared/changes/git";

const nonce = "N0NCE";
const a40 = "a".repeat(40);

/** With each section's exit after it (0, else `exits`). */
function statusOutput(fields: {
  head?: string;
  oid?: string;
  top?: string;
  status: readonly string[];
  unstaged: readonly string[];
  staged: readonly string[];
  end?: boolean;
  exits?: Partial<Record<GitSection, number>>;
}): string {
  const oid = fields.oid ?? a40;
  return gitOutput(
    [
      ["HEAD", (fields.head ?? "refs/heads/main") + "\n"],
      ["OID", oid === "" ? "" : oid + "\n"],
      ["TOP", (fields.top ?? "/r") + "\n"],
      ["STATUS", fields.status.map((s) => s + "\0").join("")],
      ["UNSTAGED", fields.unstaged.map((s) => s + "\0").join("")],
      ["STAGED", fields.staged.map((s) => s + "\0").join("")],
    ],
    nonce,
    { exits: fields.exits ?? {}, cut: fields.end === false },
  );
}

/** The output cut just after `at`, the exits after it as the Mac prints them. */
function cut(whole: string, at: string): string {
  const exits = whole.indexOf("\n" + gitMarker("EXITS", nonce));
  const end = whole.indexOf(at) + at.length;
  return whole.slice(0, end) + whole.slice(exits);
}

function repository(output: string): GitFolderStatus {
  const read = parseStatus(output, nonce);
  if (read.kind !== "repository") throw new Error(`not read: ${read.kind}`);
  return read.status;
}

describe("a folder's status, parsed", () => {
  it("reads every kind of entry with its counts", () => {
    const status = repository(
      statusOutput({
        status: [
          "M  staged.swift",
          " M work.swift",
          "MM both.swift",
          "R  new name.swift",
          "old name.swift",
          "C  copy.swift",
          "orig.swift",
          "A  bin.dat",
          "D  gone.swift",
          "?? nl\nname.txt",
          "?? dir/",
          "UU conflict.swift",
          " T link",
        ],
        unstaged: ["3\t1\twork.swift", "2\t2\tboth.swift"],
        staged: ["1\t0\tstaged.swift", "4\t4\tboth.swift", "0\t0\t", "old name.swift", "new name.swift", "-\t-\tbin.dat", "0\t5\tgone.swift", "7\t0\t", "orig.swift", "copy.swift"],
      }),
    );
    expect(status.head).toEqual({ kind: "branch", name: "main" });
    expect(status.top).toBe("/r");
    expect(status.cut).toBe(false);
    expect(status.files.map((f) => f.path)).toEqual([
      "staged.swift",
      "work.swift",
      "both.swift",
      "new name.swift",
      "copy.swift",
      "bin.dat",
      "gone.swift",
      "nl\nname.txt",
      "dir/",
      "conflict.swift",
      "link",
    ]);
    const file = (path: string): GitFileChange => status.files.find((f) => f.path === path)!;
    expect(changeKind(file("staged.swift"))).toBe("modified");
    expect(isStaged(file("staged.swift"))).toBe(true);
    expect(isUnstaged(file("staged.swift"))).toBe(false);
    expect(isUnstaged(file("work.swift"))).toBe(true);
    expect(file("both.swift").added).toBe(6);
    expect(file("both.swift").removed).toBe(6);
    expect(changeKind(file("new name.swift"))).toBe("renamed");
    expect(file("new name.swift").originalPath).toBe("old name.swift");
    expect(changeKind(file("copy.swift"))).toBe("copied");
    expect(file("copy.swift").originalPath).toBe("orig.swift");
    expect(file("copy.swift").added).toBe(7);
    expect(file("bin.dat").binary).toBe(true);
    expect(file("bin.dat").added).toBeNull();
    expect(changeKind(file("bin.dat"))).toBe("added");
    expect(changeKind(file("gone.swift"))).toBe("deleted");
    expect(file("gone.swift").removed).toBe(5);
    expect(changeKind(file("nl\nname.txt"))).toBe("untracked");
    expect(isFolder(file("dir/"))).toBe(true);
    expect(changeKind(file("conflict.swift"))).toBe("conflicted");
    expect(changeKind(file("link"))).toBe("typeChanged");
    expect(statusAdded(status)).toBe(1 + 3 + 6 + 0 + 7 + 0);
    expect(statusRemoved(status)).toBe(0 + 1 + 6 + 0 + 0 + 5);
    expect(untrackedCount(status)).toBe(2);
    expect(changedCount(status)).toBe(9);
  });

  it("reads the heads and the markers", () => {
    const head = (h: string, oid: string) => repository(statusOutput({ head: h, oid, status: [], unstaged: [], staged: [] })).head;
    expect(head("refs/heads/feature/x y", "b" + "0".repeat(39))).toEqual({ kind: "branch", name: "feature/x y" });
    expect(head("refs/heads/trunk", "")).toEqual({ kind: "unborn", name: "trunk" });
    expect(head("", "0123456789abcdef0123456789abcdef01234567")).toEqual({ kind: "detached", hash: "0123456" });
    expect(parseStatus(notARepositoryMarker + "\n", nonce)).toEqual({ kind: "notARepository" });
    expect(parseStatus(noFolderMarker + "\n", nonce)).toEqual({ kind: "noFolder" });
    expect(parseStatus("", nonce)).toEqual({ kind: "failed" });
    expect(parseStatus("fatal: something\n", nonce)).toEqual({ kind: "failed" });
  });

  it("keeps the whole entries of a status cut at its bound and says it was cut", () => {
    const whole = statusOutput({ status: ["M  a.swift", " M b.swift", "?? c.txt"], unstaged: [], staged: [] });
    const status = repository(cut(whole, "?? c.t"));
    expect(status.cut).toBe(true);
    expect(status.files.map((f) => f.path)).toEqual(["a.swift", "b.swift"]);
  });

  it("a failed section fails the read, the one the cut stopped is not judged, no exits is a failure", () => {
    expect(parseStatus(statusOutput({ status: [], unstaged: [], staged: [], exits: { STATUS: 128 } }), nonce), "not a clean folder").toEqual({ kind: "failed" });
    expect(parseStatus(statusOutput({ status: [" M a.swift"], unstaged: [], staged: [], exits: { UNSTAGED: 128 } }), nonce)).toEqual({ kind: "failed" });
    const big = Array.from({ length: 50 }, (_, i) => `1\t1\tf${i}.swift`);
    const failedThenCut = cut(statusOutput({ status: [" M f0.swift"], unstaged: big, staged: [], exits: { STATUS: 128, UNSTAGED: 141 } }), "f20.sw");
    expect(parseStatus(failedThenCut, nonce), "the cap hides no status").toEqual({ kind: "failed" });
    const cutOnly = cut(statusOutput({ status: [" M f0.swift"], unstaged: big, staged: [], exits: { UNSTAGED: 141, STAGED: 141 } }), "f20.sw");
    const status = repository(cutOnly);
    expect(status.cut).toBe(true);
    expect(status.files[0]?.added).toBe(1);
    const noExits = cutOnly.slice(0, cutOnly.indexOf(gitMarker("EXITS", nonce)));
    expect(parseStatus(noExits, nonce)).toEqual({ kind: "failed" });
    const meant = statusOutput({ head: "", status: [], unstaged: [], staged: [], exits: { HEAD: 1, OID: 1 } });
    expect(parseStatus(meant, nonce).kind).toBe("repository");

    expect(parseText(gitOutput([["STAGED", ""], ["UNSTAGED", ""]], nonce, { exits: { UNSTAGED: 128 } }), nonce), "not nothing to show").toEqual({
      kind: "failed",
    });
    expect(parseText(gitOutput([["SHOW", ""]], nonce, { exits: { SHOW: 128 } }), nonce)).toEqual({ kind: "failed" });
    expect(parseText(gitOutput([["UNTRACKED", "diff --git a/x b/x\n+x\n"]], nonce, { exits: { UNTRACKED: 1 } }), nonce)).toEqual({
      kind: "text",
      text: { parts: [{ title: "Untracked", text: "diff --git a/x b/x\n+x\n" }], cut: false },
    });
  });
});

describe("the commands", () => {
  const folder = "/Users/x/it's $HOME `x`\n-dash";
  const change = gitFileChange("a*b [c].swift", "R", "M", { originalPath: "old's.swift" });
  const commands = [
    statusCommand(folder, nonce, 262_144),
    fileDiffCommand(folder, change, nonce, 262_144),
    logCommand(folder, 1_793_570_000, 50, nonce, 65_536),
    showCommand(folder, "c".repeat(40), nonce, 524_288)!,
  ];

  it("are read only, bounded and quoted", () => {
    for (const command of commands) {
      expect(command.startsWith("/bin/sh -c '"), command).toBe(true);
      expect(command).toContain("--no-optional-locks");
    }
    for (const command of [commands[0]!, commands[1]!, commands[3]!]) {
      expect(command).toContain("GIT_OPTIONAL_LOCKS=0");
      expect(command).toContain("core.quotepath=off");
      expect(command).toContain("--no-pager");
      expect(command).toContain("core.fsmonitor=false");
      expect(command).toContain("diff.autoRefreshIndex=false");
    }
    expect(commands[0]).toContain("head -c 262144");
    expect(commands[1]).toContain("head -c 262144");
    expect(commands[3]).toContain("head -c 524288");
    expect(commands[2], "the log is framed and cut like the rest").toContain("head -c 65536");
    for (const command of commands) expect(command, "each exit kept").toContain(" >&3; ");
    expect(commands[1]).toContain("--no-ext-diff");
    expect(commands[1]).toContain("--no-textconv");
    expect(commands[1], "the path is literal, from the top").toContain(":(top,literal)a*b [c].swift");
    expect(commands[2]).toContain("--shortstat");
  });

  it("run nothing that writes (config only to list the filter names)", () => {
    const writers = ["add", "commit", "checkout", "reset", "stash", "update-index", "gc", "fetch", "pull", "push", "merge", "rebase", "apply", "rm", "mv", "clean", "switch", "restore", "tag", "branch"];
    for (const command of commands) {
      const words = new Set(command.split(/[ ;|&(){}'"\n]+/));
      for (const writer of writers) expect(words.has(writer), `${writer} in ${command}`).toBe(false);
      // The names listed NUL-terminated.
      expect(command.split(" config ").length, command).toBe(command.split(" config -z --name-only --get-regexp ").length);
    }
  });

  it("turn off every filter git has set up, check no signature, look into no submodule", () => {
    for (const command of [commands[0]!, commands[1]!, commands[3]!]) {
      expect(command).toContain("log.showSignature=false");
      expect(command).toContain('-c "filter.$n.process="');
      expect(command).toContain('-c "filter.$n.required=false"');
      expect(command).toContain("--submodule=short");
    }
    expect(commands[0]).toContain("status --porcelain=v1 -z --ignore-submodules=dirty");
    expect(commands[1], "a tracked file's filter is looked up first").toContain("check-attr filter");
    expect(commands[2]).toContain("log.showSignature=false");
    expect(commands[2]).toContain("--no-textconv");
  });

  it("show takes a full hash only", () => {
    expect(showCommand("/r", "HEAD", nonce, 1)).toBeNull();
    expect(showCommand("/r", "abc1234; rm -rf x", nonce, 1)).toBeNull();
    expect(showCommand("/r", "--output=/tmp/x", nonce, 1)).toBeNull();
    expect(showCommand("/r", "A".repeat(40), nonce, 1), "lower-case hex only").toBeNull();
    expect(showCommand("/r", "f".repeat(64), nonce, 1)).not.toBeNull();
  });

  it("keep a marker no path can make: the command's own nonce", () => {
    expect(gitMarker("STATUS", "abc123")).toBe("HERDR-CHANGES-abc123-STATUS");
  });
});

describe("the commits since the session began", () => {
  it("are read with their file counts, newest first, a merge not counted", () => {
    const p1 = "1".repeat(40);
    const p2 = "2".repeat(40);
    const records =
      "\u001e" + "a".repeat(40) + `\u001f1793574000\u001f${p1}\u001fSecond: two files\u001f\n\n` +
      " 2 files changed, 10 insertions(+), 3 deletions(-)\n" +
      "\u001e" + "b".repeat(40) + `\u001f1793573000\u001f${p1} ${p2}\u001fMerge branch 'x'\u001f\n` +
      "\u001e" + "c".repeat(40) + `\u001f1793572000\u001f${p1}\u001fOne file\u001f\n\n` +
      " 1 file changed, 1 deletion(-)\n" +
      "\u001e" + "e".repeat(40) + `\u001f1793571000\u001f${p1}\u001fEmpty\u001f\n` +
      "\u001e" + "d".repeat(40) + `\u001f1793000000\u001f${p1}\u001fBefore the session\u001f\n\n` +
      " 1 file changed, 1 insertion(+)\n";
    const read = parseLog(gitOutput([["OID", a40 + "\n"], ["LOG", records]], nonce), 1_793_570_000, nonce);
    if (read.kind !== "commits") throw new Error(read.kind);
    const commits = read.commits;
    expect(commits.map((c) => c.subject)).toEqual(["Second: two files", "Merge branch 'x'", "One file", "Empty"]);
    expect(commits.map((c) => c.parents > 1)).toEqual([false, true, false, false]);
    expect(commits.map((c) => c.files), "a merge's files are not counted").toEqual([2, null, 1, 0]);
    expect(commits.map((c) => c.added)).toEqual([10, null, 0, 0]);
    expect(commits.map((c) => c.removed)).toEqual([3, null, 1, 0]);
    expect(commits[0]!.time).toBe(1_793_574_000);
    expect(shortHash(commits[0]!)).toBe("aaaaaaa");
    expect(parseLog(notARepositoryMarker + "\n", -Infinity, nonce)).toEqual({ kind: "notARepository" });
  });

  it("no commits yet is an empty history, a failed log a failure", () => {
    expect(parseLog(gitOutput([["OID", ""]], nonce, { exits: { OID: 1 } }), -Infinity, nonce)).toEqual({ kind: "commits", commits: [] });
    expect(parseLog(gitOutput([["OID", "a\n"], ["LOG", ""]], nonce, { exits: { LOG: 128 } }), -Infinity, nonce)).toEqual({ kind: "failed" });
    expect(parseLog("", -Infinity, nonce)).toEqual({ kind: "failed" });
  });
});

describe("a file's diff and a commit, by their parts", () => {
  it("titles the staged and unstaged parts, leaves out empty ones, keeps the cut", () => {
    expect(parseText(gitOutput([["STAGED", "diff --git a/x b/x\n+s\n"], ["UNSTAGED", "diff --git a/x b/x\n+u\n"]], nonce), nonce)).toEqual({
      kind: "text",
      text: {
        parts: [
          { title: "Staged", text: "diff --git a/x b/x\n+s\n" },
          { title: "Not staged", text: "diff --git a/x b/x\n+u\n" },
        ],
        cut: false,
      },
    });
    expect(parseText(gitOutput([["STAGED", ""], ["UNSTAGED", "diff --git a/x b/x\n+u\n"]], nonce, { cut: true }), nonce)).toEqual({
      kind: "text",
      text: { parts: [{ title: "Not staged", text: "diff --git a/x b/x\n+u\n" }], cut: true },
    });
    expect(parseText(gitOutput([["SHOW", "commit abc\n"]], nonce), nonce)).toEqual({
      kind: "text",
      text: { parts: [{ title: "", text: "commit abc\n" }], cut: false },
    });
    expect(parseText(notARepositoryMarker, nonce)).toEqual({ kind: "notARepository" });
    expect(parseText(noFolderMarker, nonce)).toEqual({ kind: "noFolder" });
    expect(parseText("", nonce)).toEqual({ kind: "failed" });
  });
});
