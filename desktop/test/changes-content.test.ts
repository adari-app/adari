// An agent's Changes as rows in every state and the words
// (HerdrCompanionTests CompanionChangesModelTests: testLoadingRowsThenEveryPart,
// testNotARepositoryHasNoCommits, testEmptyEverywhere,
// testFailedReadsOfferTryAgain, testAFolderWhoseGitRunsAFilterSaysSo,
// testOfflineSaysSoAndShowsNoGit, testGrokIsGitOnlyAndASharedFolderSaysWho,
// testAPartOfTheSessionOffersLoadEarlier,
// testTheFolderShowsThreeHundredFilesAndCountsTheRest,
// testTheChatsToolsAndABackwardRead, testTheWords, the overview's offline and
// loading rows; CompanionChangesHookTests testATurnFinishesWhenAPaneLeavesWorking).

import { describe, expect, it } from "vitest";

import {
  agentLine,
  changesItems,
  changesText,
  changesTools,
  commitMeta,
  fileLabel,
  fileSubtitle,
  fileTitle,
  gitLine,
  headText,
  overviewHostsItems,
  overviewItems,
  sharingText,
  statusLetter,
  toolsLine,
  turnFinished,
  type ChangesCommitsState,
  type ChangesGitState,
  type ChangesInput,
  type ChangesItem,
  type ChangesToolsState,
} from "../src/shared/changes/content";
import { gitFileChange, type AgentCommit, type GitFolderStatus } from "../src/shared/changes/git";
import type { AgentOverviewRow } from "../src/shared/changes/overview";
import { emptyToolChanges, type AgentChangedFile, type AgentToolChanges } from "../src/shared/changes/tools";

/** 2 November 2026, 03:00 UTC. */
const clock = 1_793_588_400;
const utc = "UTC";

function input(fields: Partial<ChangesInput> & { tools?: ChangesToolsState; git?: ChangesGitState; commits?: ChangesCommitsState } = {}): ChangesInput {
  return {
    kind: "claude",
    folder: "/Users/fixture/app",
    online: true,
    tools: { kind: "read", changes: emptyToolChanges },
    canLoadEarlier: false,
    git: { kind: "loading" },
    commits: { kind: "loading" },
    commitsSince: clock,
    sinceKnown: true,
    sharing: [],
    ...fields,
  };
}

const ids = (items: readonly ChangesItem[]): string[] => items.map((item) => item.id);
const kindOf = (items: readonly ChangesItem[], id: string) => items.find((item) => item.id === id)?.kind;

function file(path: string, turn: number, added = 2, removed = 1): AgentChangedFile {
  return {
    path,
    added,
    removed,
    edits: [
      {
        callId: `c-${path}-${turn}`,
        tool: "Edit",
        path,
        turnId: `t${turn}`,
        turnNumber: turn,
        turnMessage: `turn ${turn}`,
        time: null,
        added,
        removed,
        lines: [
          { kind: "removed", text: "old" },
          { kind: "added", text: "new" },
        ],
        moreLines: 0,
      },
    ],
  } as AgentChangedFile;
}

const status: GitFolderStatus = {
  top: "/Users/fixture/app",
  head: { kind: "branch", name: "main" },
  files: [gitFileChange("a.swift", " ", "M", { added: 3, removed: 1 })],
  cut: false,
};

function tools(fields: Partial<AgentToolChanges>): AgentToolChanges {
  return { ...emptyToolChanges, ...fields };
}

describe("an agent's Changes as rows", () => {
  it("shows loading rows, then every part", () => {
    expect(ids(changesItems(input({ tools: { kind: "loading" } }), utc))).toEqual(["turn", "tools-loading", "git", "git-loading", "commits", "commits-loading"]);
    const changes = tools({
      thisTurn: [file("/Users/fixture/app/a.swift", 2)],
      session: [file("/Users/fixture/app/a.swift", 2), file("/Users/fixture/app/b.swift", 1)],
      turnCount: 2,
      firstTurnAt: clock,
      fromSessionStart: true,
      thisTurnRunning: true,
      thisTurnStartedAt: clock,
    });
    const commit: AgentCommit = { hash: "c".repeat(40), subject: "Fix it", time: clock, parents: 1, files: 1, added: 3, removed: 1 };
    const items = changesItems(
      input({
        tools: { kind: "read", changes },
        git: { kind: "read", read: { kind: "repository", status } },
        commits: { kind: "read", read: { kind: "commits", commits: [commit] } },
      }),
      utc,
    );
    expect(ids(items)).toEqual([
      "turn",
      "turn|/Users/fixture/app/a.swift",
      "session",
      "session|/Users/fixture/app/a.swift",
      "session|/Users/fixture/app/b.swift",
      "git",
      "git|a.swift",
      "commits",
      "commit|" + commit.hash,
    ]);
    expect(items[0]!.kind).toEqual({ type: "header", title: "This turn", detail: "working" });
    expect(items[2]!.kind).toEqual({ type: "header", title: "This session", detail: "2 files · 2 edits" });
    expect(items[5]!.kind).toEqual({ type: "header", title: "In its folder now", detail: "main · 1 file +3 −1" });
    const row = items[1]!.kind;
    expect(row.type === "toolFile" && row.scope === "This turn" && row.shown).toBe("a.swift");
    expect(items[7]!.kind).toEqual({ type: "header", title: "Commits this session", detail: expect.stringMatching(/^since (3:00|03:00)\s?(AM)?$/) });
  });

  it("has no commits for a folder that is not a repository", () => {
    const items = changesItems(input({ git: { kind: "read", read: { kind: "notARepository" } }, commits: { kind: "read", read: { kind: "notARepository" } } }));
    expect(ids(items).slice(-2)).toEqual(["git", "git-none"]);
    expect(items[items.length - 1]!.kind).toEqual({ type: "note", text: "/Users/fixture/app is not a git repository.", tone: "plain" });
  });

  it("says when everything is empty", () => {
    const clean: GitFolderStatus = { top: "/Users/fixture/app", head: { kind: "unborn", name: "main" }, files: [], cut: false };
    const items = changesItems(input({ git: { kind: "read", read: { kind: "repository", status: clean } }, commits: { kind: "read", read: { kind: "commits", commits: [] } } }));
    expect(ids(items)).toEqual(["turn", "turn-empty", "session", "session-empty", "git", "git-clean", "commits", "commits-empty"]);
    expect(items[4]!.kind).toEqual({ type: "header", title: "In its folder now", detail: "main, no commits yet · clean" });
  });

  it("offers Try again where a read failed", () => {
    const items = changesItems(input({ git: { kind: "read", read: { kind: "failed" } }, commits: { kind: "read", read: { kind: "timedOut" } } }));
    expect(kindOf(items, "git-retry")).toEqual({ type: "retry", text: "git could not be read." });
    expect(kindOf(items, "commits-retry")).toEqual({ type: "retry", text: "git did not answer within 5 seconds." });
    const log = changesItems(input({ git: { kind: "read", read: { kind: "repository", status } }, commits: { kind: "read", read: { kind: "failed" } } }));
    expect(kindOf(log, "commits-retry")).toEqual({ type: "retry", text: "The commits could not be read." });
  });

  it("says a folder whose git runs a filter is not read, its commits still are", () => {
    const items = changesItems(input({ git: { kind: "read", read: { kind: "runsAFilter" } }, commits: { kind: "read", read: { kind: "commits", commits: [] } } }));
    expect(kindOf(items, "git-none")).toEqual({ type: "note", text: changesText.runsAFilter, tone: "plain" });
    expect(kindOf(items, "commits-empty")).toBeDefined();
    expect(gitLine({ kind: "runsAFilter" })).toBe("git runs a filter here");
    expect(changesText.runsAFilter).toBe("This folder's git setup runs a filter; open it in a terminal.");
  });

  it("says a folder that is gone is not there", () => {
    const items = changesItems(input({ git: { kind: "read", read: { kind: "noFolder" } }, commits: { kind: "read", read: { kind: "notARepository" } } }));
    expect(kindOf(items, "git-none")).toEqual({ type: "note", text: "/Users/fixture/app is not there.", tone: "problem" });
    expect(ids(items)).not.toContain("commits");
    const none = changesItems(input({ folder: null, git: { kind: "noFolder" }, commits: { kind: "noFolder" } }));
    expect(kindOf(none, "git-none")).toEqual({ type: "note", text: "No folder is known for this pane.", tone: "plain" });
    expect(ids(none)).not.toContain("commits");
  });

  it("says offline and shows no git", () => {
    const items = changesItems(input({ git: { kind: "offline" }, commits: { kind: "offline" }, online: false }));
    expect(ids(items)).toEqual(["offline", "turn", "turn-empty", "session", "session-empty"]);
    expect(items[0]!.kind).toEqual({ type: "note", text: changesText.offline, tone: "problem" });
  });

  it("shows Grok's folder's git only, and who else uses a shared folder", () => {
    const grok = changesTools(null, null, false, "grok");
    const items = changesItems(
      input({ tools: grok, git: { kind: "read", read: { kind: "repository", status } }, commits: { kind: "read", read: { kind: "commits", commits: [] } }, sharing: ["Review", "Ops"], kind: "grok" }),
    );
    expect(ids(items).slice(0, 3)).toEqual(["sharing", "tools", "tools-none"]);
    expect(items[0]!.kind).toEqual({ type: "note", text: "Also used by Review and Ops: the folder's changes are theirs too.", tone: "plain" });
    const note = items[2]!.kind;
    expect(note.type === "note" && note.text.includes("Grok") && note.text.includes("git only")).toBe(true);
    expect(ids(items)).toContain("git|a.swift");
  });

  it("offers Load earlier for a part of the session", () => {
    const partial = tools({ turnCount: 1, firstTurnAt: clock, fromSessionStart: false });
    expect(ids(changesItems(input({ tools: { kind: "read", changes: partial }, canLoadEarlier: true })))).toEqual(expect.arrayContaining(["session-partial", "load-earlier"]));
    expect(ids(changesItems(input({ tools: { kind: "read", changes: partial } })))).not.toContain("load-earlier");
    expect(kindOf(changesItems(input({ tools: { kind: "read", changes: partial } }), utc), "session-partial")).toEqual({
      type: "note",
      text: expect.stringMatching(/^Only the turns read so far \(from (3:00|03:00)\s?(AM)?\)\.$/),
      tone: "plain",
    });
  });

  it("shows the folder's first 300 files and counts the rest", () => {
    const files = Array.from({ length: 320 }, (_, index) => gitFileChange(`f${index}.txt`, "?", "?"));
    const many: GitFolderStatus = { top: "/r", head: { kind: "branch", name: "main" }, files, cut: true };
    const items = changesItems(input({ git: { kind: "read", read: { kind: "repository", status: many } }, commits: { kind: "read", read: { kind: "commits", commits: [] } } }));
    expect(items.filter((item) => item.kind.type === "gitFile").length).toBe(300);
    expect(kindOf(items, "git-more")).toEqual({ type: "note", text: "300 of 320 files shown.", tone: "plain" });
    expect(kindOf(items, "git-cut")).toBeDefined();
    expect(kindOf(items, "git")).toEqual({ type: "header", title: "In its folder now", detail: "main · 320 untracked" });
  });

  it("titles the commits of the last 12 hours when the session's start is not known", () => {
    const items = changesItems(input({ sinceKnown: false, git: { kind: "read", read: { kind: "repository", status } }, commits: { kind: "read", read: { kind: "commits", commits: [] } } }));
    const header = kindOf(items, "commits");
    expect(header?.type === "header" && header.title).toBe("Commits, last 12 hours");
  });
});

describe("the tools shown", () => {
  it("takes the chat's newest turn, and the session from a backward read only when it holds more", () => {
    const chat = tools({ thisTurn: [file("/x/new.swift", 2)], session: [file("/x/new.swift", 2)], turnCount: 2, firstTurnAt: clock, fromSessionStart: false, thisTurnRunning: true });
    const read = tools({ session: [file("/x/new.swift", 9), file("/x/old.swift", 1)], turnCount: 9, firstTurnAt: clock - 3600, fromSessionStart: true });
    const merged = changesTools(chat, read, false, "claude");
    expect(merged.kind).toBe("read");
    if (merged.kind !== "read") return;
    expect(merged.changes.thisTurn).toEqual(chat.thisTurn);
    expect(merged.changes.thisTurnRunning).toBe(true);
    expect(merged.changes.session.map((f) => f.path)).toEqual(["/x/new.swift", "/x/old.swift"]);
    expect(merged.changes.firstTurnAt).toBe(read.firstTurnAt);
    const whole = { ...chat, fromSessionStart: true };
    expect(changesTools(whole, read, false, "claude")).toEqual({ kind: "read", changes: whole });
    expect(changesTools(null, null, true, "claude")).toEqual({ kind: "loading" });
    expect(changesTools(null, read, false, "claude")).toEqual({ kind: "read", changes: read });
    expect(changesTools(null, null, false, "claude")).toEqual({ kind: "none", reason: "No transcript is read for this agent: this shows its folder's git only." });
  });
});

describe("the words", () => {
  it("says each part as the Swift app does", () => {
    expect(headText({ kind: "detached", hash: "abc1234" })).toBe("detached at abc1234");
    expect(headText({ kind: "unknown" })).toBe("git");
    expect(statusLetter("untracked")).toBe("?");
    expect(statusLetter("conflicted")).toBe("U");
    expect(sharingText(["A"])).toBe("Also used by A: the folder's changes are theirs too.");
    expect(sharingText(["A", "B", "C"])).toBe("Also used by A, B and C: the folder's changes are theirs too.");
    expect(sharingText([])).toBe("");
    expect(toolsLine({ kind: "noTranscript" }, "grok")).toBe("git only");
    expect(toolsLine({ kind: "noTranscript" }, "claude")).toBe("no transcript");
    expect(toolsLine({ kind: "unreadable" }, "claude")).toBe("transcript not read");
    expect(toolsLine({ kind: "notRead" }, "claude")).toBe("transcript not read (20 at a time)");
    expect(toolsLine({ kind: "read", changes: emptyToolChanges }, "claude")).toBe("no files by its own calls");
    expect(toolsLine({ kind: "read", changes: tools({ session: [file("/a", 1)] }) }, "claude")).toBe("1 file by its own calls");
    expect(gitLine(null)).toBe("git not read");
    expect(gitLine({ kind: "notARepository" })).toBe("not a git repository");
    expect(gitLine({ kind: "noFolder" })).toBe("folder not there");
    expect(gitLine({ kind: "failed" })).toBe("git could not be read");
    expect(gitLine({ kind: "timedOut" })).toBe("git did not answer");
    const png = gitFileChange("x.png", "M", " ", { binary: true });
    expect(fileLabel(png)).toBe("modified, x.png, binary");
    expect(fileSubtitle(png)).toBe("modified · staged");
    expect(fileSubtitle(gitFileChange("a", "M", "M"))).toBe("modified · staged and not staged");
    expect(fileSubtitle(gitFileChange("a", " ", "M"))).toBe("modified · not staged");
    expect(fileSubtitle(gitFileChange("dir/", "?", "?"))).toBe("untracked · a folder: its files are not listed");
    expect(fileTitle(gitFileChange("new.swift", "R", " ", { originalPath: "old.swift" }))).toBe("old.swift → new.swift");
    const commit: AgentCommit = { hash: "4f1c2a9e7b3d5c6a8e9f0b1c2d3e4f5a6b7c8d9e", subject: "s", time: clock, parents: 1, files: 2, added: 1, removed: 1 };
    expect(commitMeta(commit, utc)).toMatch(/^4f1c2a9 · (3:00|03:00)\s?(AM)? · 2 files$/);
    expect(commitMeta({ ...commit, parents: 2, files: null }, utc)).toMatch(/· merge$/);
  });
});

describe("the across-agents screen's rows", () => {
  const row = (paneId: string, workspace: string, changed: boolean): AgentOverviewRow => ({
    pane: { paneId, name: paneId, kind: "claude", folder: "/r", workspace, session: null },
    git: { kind: "repository", status: changed ? status : { ...status, files: [] } },
    tools: { kind: "noTranscript" },
  });

  it("shows offline, loading, then the machine with its workspaces", () => {
    expect(overviewItems("offline", "", []).map((item) => item.id)).toEqual(["offline"]);
    expect(overviewItems("loading", "", []).map((item) => item.id)).toEqual(["loading"]);
    const groups = [{ workspace: "herdr", rows: [row("w1:p1", "herdr", true), row("w1:p2", "herdr", false)] }];
    const items = overviewItems("read", "Mac mini", groups, "h1");
    expect(items.map((item) => item.id)).toEqual(["mac", "workspace|herdr", "agent|w1:p1", "agent|w1:p2"]);
    expect(items[0]!.kind).toEqual({ type: "mac", name: "Mac mini", detail: "1 of 2 agents with changes" });
    expect(overviewItems("read", "Mac mini", []).map((item) => item.id)).toEqual(["mac", "empty"]);
    const agent = items[2]!.kind;
    expect(agent.type === "agent" && agentLine(agent.row)).toBe("main · 1 file +3 −1 · no transcript");
  });

  it("lists every machine, an offline one by name", () => {
    const items = overviewHostsItems([
      { hostId: "a", name: "Mac mini", state: "read", groups: [{ workspace: "w", rows: [row("w1:p1", "w", true)] }] },
      { hostId: "b", name: "build-box", state: "offline", groups: [] },
    ]);
    expect(items.map((item) => item.id)).toEqual(["a|mac", "a|workspace|w", "a|agent|w1:p1", "b|mac", "b|offline"]);
    expect(items[3]!.kind).toEqual({ type: "mac", name: "build-box", detail: null });
    expect(overviewHostsItems([]).map((item) => item.id)).toEqual(["none"]);
  });

  it("a turn finishes when a working pane leaves Working", () => {
    expect(turnFinished({ a: true }, { a: false })).toBe(true);
    expect(turnFinished({ a: true }, { a: true })).toBe(false);
    expect(turnFinished({ a: false }, { a: true })).toBe(false);
    expect(turnFinished({ a: true }, {})).toBe(false);
  });
});
