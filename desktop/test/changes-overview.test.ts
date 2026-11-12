// The across-agents Changes screen (HerdrKit
// AgentChangesGitTests "across agents" and AgentChangesTests' sharing): every
// agent pane's row on one Mac, git once per folder (20 folders at most) and the
// transcripts of the first 20 panes that have one, at most 3 at a time through
// the Mac's gate; grouped by workspace with changes first; a cancel stops what
// has not started; a transcript of another folder is not the pane's.

import { describe, expect, it } from "vitest";

import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { defaultChangesLimits, gitOutput, statusAdded, untrackedCount, type GitSection } from "../src/shared/changes/git";
import {
  collectOverview,
  groupedOverview,
  readTools,
  rowGitStatus,
  rowHasChanges,
  rowToolFileCount,
  sharingPanes,
  type AgentChangesPane,
} from "../src/shared/changes/overview";
import { AgentChangesGitReader, ChangesCancelled, CommandGate, type ReadOnlyCommandRunner } from "../src/shared/changes/reader";
import { FakeTranscriptReader } from "./support/chat-lines";
import { claudeEdits, fixtureFolder } from "./support/changes-lines";

const templateNonce = "N0NCE";

/** The status of one folder, by HerdrKit's NonceEchoGit: the command's own nonce put in, after a delay; commands and the most at once counted. */
class NonceEchoGit implements ReadOnlyCommandRunner {
  readonly commands: string[] = [];
  mostAtOnce = 0;
  private inFlight = 0;

  constructor(
    private readonly template: string,
    private readonly delayMs: number,
  ) {}

  runReadOnlyCommand(command: string, _max: number, signal?: AbortSignal): Promise<string> {
    this.commands.push(command);
    this.inFlight += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.inFlight);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight -= 1;
        const nonce = /HERDR-CHANGES-([^-]+)-/.exec(command)?.[1] ?? "";
        resolve(this.template.split("HERDR-CHANGES-" + templateNonce + "-").join("HERDR-CHANGES-" + nonce + "-"));
      }, this.delayMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.inFlight -= 1;
          reject(new Error("closed"));
        },
        { once: true },
      );
    });
  }
}

/** Transcripts by session id at /t/<id>.jsonl. */
class SessionFiles extends FakeTranscriptReader {
  constructor(files: Record<string, string>) {
    super();
    for (const [path, content] of Object.entries(files)) this.put(path, content, null);
  }

  override async locate(ref: TranscriptSessionRef): Promise<string | null> {
    if (ref.lookup.kind !== "id") return null;
    const path = `/t/${ref.lookup.id}.jsonl`;
    try {
      await this.size(path);
      return path;
    } catch {
      return null;
    }
  }
}

const sessionID = (index: number): string => "5b1d7c2e-0000-0000-0000-" + String(index).padStart(12, "0");
const session = (index: number): TranscriptSessionRef => makeSessionRef("claude", { kind: "id", id: sessionID(index) })!;

function statusTemplate(): string {
  const sections: [GitSection, string][] = [
    ["HEAD", "refs/heads/main\n"],
    ["OID", "a".repeat(40) + "\n"],
    ["TOP", "/f\n"],
    ["STATUS", " M a.swift\0?? n.txt\0"],
    ["UNSTAGED", "2\t1\ta.swift\0"],
    ["STAGED", ""],
  ];
  return gitOutput(sections, templateNonce);
}

describe("the across-agents screen", () => {
  it("reads 20 folders at most, 3 at once, changes first", async () => {
    const edits = claudeEdits.join("\n") + "\n";
    const files: Record<string, string> = {};
    const panes: AgentChangesPane[] = [];
    // Panes 0 and 1 share /f/0; the rest have a folder each (24 folders).
    for (let index = 0; index < 26; index += 1) {
      const folder = index <= 1 ? "/f/0" : `/f/${index - 1}`;
      panes.push({
        paneId: `p${index}`,
        name: `agent ${index}`,
        kind: index === 3 ? "grok" : "claude",
        folder,
        workspace: index % 2 === 0 ? "ws-a" : "ws-b",
        session: index === 3 ? null : session(index),
      });
      if (index === 1) files[`/t/${sessionID(index)}.jsonl`] = edits.split(fixtureFolder).join(folder);
    }
    const transcripts = new SessionFiles(files);
    const git = new NonceEchoGit(statusTemplate(), 5);
    const reader = new AgentChangesGitReader(git, new CommandGate(3), defaultChangesLimits);
    const rows = await collectOverview({ panes, transcripts, git: reader, limits: defaultChangesLimits });
    expect(rows.map((r) => r.pane.paneId)).toEqual(panes.map((p) => p.paneId));
    expect(git.commands.length, "20 folders").toBe(20);
    expect(git.mostAtOnce).toBeLessThanOrEqual(3);
    expect(rows[0]!.git, "one read for the shared folder").toEqual(rows[1]!.git);
    const read = rowGitStatus(rows[0]!);
    if (read === null) throw new Error("not read");
    expect(statusAdded(read)).toBe(2);
    expect(untrackedCount(read)).toBe(1);
    expect(rows[25]!.git, "past the 20 folders").toBeNull();
    expect(rowToolFileCount(rows[1]!), JSON.stringify(rows[1]!.tools).slice(0, 200)).toBe(3);
    expect(rows[3]!.tools).toEqual({ kind: "noTranscript" });
    expect(rows[0]!.tools, "no file for it").toEqual({ kind: "unreadable" });

    const groups = groupedOverview(rows);
    expect(groups.map((g) => g.workspace)).toEqual(["ws-a", "ws-b"]);
    expect(groups[1]!.rows[0]!.pane.paneId, "changes first").toBe("p1");
    expect(groups[1]!.rows[groups[1]!.rows.length - 1]!.pane.paneId, "not read last").toBe("p25");
    expect(rowHasChanges(rows[1]!)).toBe(true);
    expect(rowHasChanges(rows[25]!)).toBe(false);
  });

  it("lists the transcripts past the first 20 as not read, and none without a reader as unreadable", async () => {
    const panes: AgentChangesPane[] = Array.from({ length: 22 }, (_, index) => ({
      paneId: `p${index}`,
      name: "a",
      kind: "claude",
      folder: null,
      workspace: "w",
      session: session(index),
    }));
    const rows = await collectOverview({ panes, transcripts: new SessionFiles({}), git: null, limits: defaultChangesLimits });
    expect(rows.slice(0, 20).every((r) => r.tools.kind === "unreadable")).toBe(true);
    expect(rows.slice(20).map((r) => r.tools.kind)).toEqual(["notRead", "notRead"]);
    const none = await collectOverview({ panes: panes.slice(0, 2), transcripts: null, git: null, limits: defaultChangesLimits });
    expect(none.map((r) => r.tools.kind)).toEqual(["unreadable", "unreadable"]);
    expect(none.map((r) => r.git)).toEqual([null, null]);
  });

  it("stops when cancelled: nothing starts after the cancel", async () => {
    const panes: AgentChangesPane[] = Array.from({ length: 6 }, (_, index) => ({
      paneId: `p${index}`,
      name: "a",
      kind: "claude",
      folder: `/f/${index}`,
      workspace: "w",
      session: null,
    }));
    const git = new NonceEchoGit("", 2_000);
    const reader = new AgentChangesGitReader(git, new CommandGate(3), defaultChangesLimits);
    const cancel = new AbortController();
    const collecting = collectOverview({ panes, transcripts: null, git: reader, limits: defaultChangesLimits, signal: cancel.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    cancel.abort();
    await expect(collecting).rejects.toBeInstanceOf(ChangesCancelled);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(git.commands.length, "no command starts after the cancel").toBe(3);
  });

  it("does not take another folder's transcript as the pane's", async () => {
    const transcripts = new SessionFiles({ [`/t/${sessionID(1)}.jsonl`]: claudeEdits.join("\n") + "\n" });
    expect((await readTools(session(1), "/elsewhere", transcripts, defaultChangesLimits)).kind).toBe("unreadable");
    expect((await readTools(session(1), fixtureFolder + "/sub", transcripts, defaultChangesLimits)).kind, "a folder inside it is").toBe("read");
    expect((await readTools(session(1), null, transcripts, defaultChangesLimits)).kind, "no folder: no check").toBe("read");
    expect((await readTools(session(2), fixtureFolder, transcripts, defaultChangesLimits)).kind, "no file").toBe("unreadable");
  });

  it("names the other open panes in the folder: Also used by …", () => {
    const pane = (paneId: string, name: string, folder: string, workspace: string): AgentChangesPane => ({ paneId, name, kind: "claude", folder, workspace, session: null });
    const panes = [pane("p1", "dev", "/r", "w"), pane("p2", "codex-review", "/r/", "w"), pane("p3", "other", "/elsewhere", "w"), pane("p4", "grok", "/r", "x")];
    expect(sharingPanes("p1", "/r", panes)).toEqual(["codex-review", "grok"]);
    expect(sharingPanes("p3", "/elsewhere", panes)).toEqual([]);
    expect(sharingPanes("p1", null, panes)).toEqual([]);
  });
});
