// How a Copilot pane binds to its event log, and the log followed in the feed, against fakes:
// Herdr snapshots as the wire gives them, a fake transcript reader, and the locate command run with `/bin/sh` on a
// synthetic home under the test scratch folder (never the real home). The session lines are synthetic, built
// from github/copilot-sdk d1e6021 nodejs/src/generated/session-events.ts.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { copilotAmbiguousReason, copilotFolderCandidates, copilotResumeID } from "../src/shared/chat/agents/copilot-locate";
import { blobMark, blobsToRestore, rebuildOmitted, type BlobRange } from "../src/shared/chat/blobs";
import { ChatFeed, type ChatFeedState } from "../src/shared/chat/feed";
import { TranscriptFollower } from "../src/shared/chat/follower";
import { chatKinds, chatReadsKind } from "../src/shared/chat/kinds";
import {
  grokFolderShared,
  locateCommand,
  makeSessionRef,
  paneSession,
  parseLocateOutput,
  sessionForPane,
  sessionFromArgv,
  sessionRefFromAgentSession,
  type AgentSessionLike,
  type MachinePanes,
  type TranscriptSessionRef,
} from "../src/shared/chat/locator";
import { turnUserMessage } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { SearchCommand, SearchQuery } from "../src/shared/search/search";
import { scratch } from "./support/changes-git";
import { eventually, FakeTranscriptReader, stamp } from "./support/chat-lines";

const own = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const peer = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d";
const folder = "/Users/fixture/my proj";
const logOf = (id: string): string => `/Users/fixture/.copilot/session-state/${id}/events.jsonl`;
const named = (id: string): AgentSessionLike => ({ source: "herdr:copilot", agent: "copilot", kind: "id", value: id });

let serial = 0;
function event(type: string, data: Record<string, unknown>, second: number): string {
  serial += 1;
  return JSON.stringify({ id: `ev-${serial}`, timestamp: stamp(second), parentId: null, type, data });
}
const start = (cwd: string, id = own): string => event("session.start", { sessionId: id, version: 1, context: { cwd } }, 0);
const prompt = (content: string, second: number): string => event("user.message", { content }, second);
const answer = (content: string, second: number): string => event("assistant.message", { messageId: `m${second}`, content, toolRequests: [] }, second);
const session = (cwd: string, turns: number): string => [start(cwd), ...Array.from({ length: turns }, (_, n) => [prompt(`question ${n}`, n * 2 + 1), answer(`answer ${n}`, n * 2 + 2)]).flat()].join("\n") + "\n";

const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;
const userTexts = (feed: ChatFeed<TranscriptSessionRef>): (string | undefined)[] => feed.timeline.turns.map((turn) => turnUserMessage(turn)?.text);

describe("copilot: a pane binds to its session (fake Herdr snapshots)", () => {
  it("the reported id: Herdr's herdr:copilot report names the log", () => {
    expect(sessionRefFromAgentSession(named(own))).toEqual({ format: "copilot", lookup: { kind: "id", id: own } });
    expect(sessionRefFromAgentSession(named("not-a-uuid-at-all")), "an id that is not Copilot's never reaches a command").toBeNull();
    const machine: MachinePanes = { agents: [{ paneID: "A", agent: "copilot", cwd: folder, agentSession: named(own) }], panes: [{ paneID: "A", agent: "copilot", cwd: folder }] };
    const bound = paneSession(machine, "A");
    expect(bound !== null && bound !== "ambiguous" ? [bound.ref, bound.source, bound.paneFolders] : bound).toEqual([{ format: "copilot", lookup: { kind: "id", id: own } }, "herdr:copilot", [folder]]);
    expect([chatReadsKind("copilot"), chatReadsKind("Copilot"), chatKinds.includes("copilot"), chatReadsKind("devin"), chatReadsKind(null)]).toEqual([true, true, true, false, false]);
  });

  it("the resume id in the foreground command (copilot --resume=<id>, --resume <id>, -r <id>)", () => {
    expect(copilotResumeID(["copilot", `--resume=${own}`])).toBe(own);
    expect(copilotResumeID(["copilot", "--resume", own])).toBe(own);
    expect(copilotResumeID(["copilot", "-r", own])).toBe(own);
    expect(copilotResumeID(["copilot", "--resume"]), "a bare --resume picks in a list").toBeNull();
    expect(copilotResumeID(["copilot", "--resume=../../etc"])).toBeNull();
    expect(sessionFromArgv(["copilot", `--resume=${own}`], "copilot")).toEqual(named(own));
    const pane = sessionForPane({ agent: "copilot", cwd: folder }, { argv: ["copilot", `--resume=${own}`] });
    expect([pane?.ref, pane?.source]).toEqual([{ format: "copilot", lookup: { kind: "id", id: own } }, "argv"]);
  });

  it("the folder rule: a pane that names no session follows the newest log of its folder", () => {
    const pane = sessionForPane({ agent: "copilot", cwd: folder + "/" });
    expect(pane?.ref).toEqual({ format: "copilot", lookup: { kind: "folder", folder } });
    expect(sessionForPane({ agent: "github-copilot", cwd: folder })?.ref.format).toBe("copilot");
  });

  it("the ambiguous case: two Copilot panes in one folder naming no session are not told apart", () => {
    const plain = { agent: "copilot", cwd: folder };
    const machine: MachinePanes = {
      agents: [{ paneID: "A", ...plain }, { paneID: "B", ...plain }],
      panes: [{ paneID: "A", agent: "copilot", cwd: folder }, { paneID: "B", agent: "copilot", cwd: folder }],
    };
    expect(paneSession(machine, "A")).toBe("ambiguous");
    expect(grokFolderShared(sessionForPane(plain)!, "A", [{ paneID: "B", ...plain }])).toBe(true);
    expect(copilotAmbiguousReason("copilot")).toBe("ambiguousCopilotSession");
    expect(copilotAmbiguousReason("droid")).toBeNull();
    // A peer that names its session is skipped instead: the pane follows the newest log that is not the peer's.
    const withNamedPeer: MachinePanes = { ...machine, agents: [{ paneID: "A", ...plain }, { paneID: "B", ...plain, agentSession: named(peer) }] };
    const bound = paneSession(withNamedPeer, "A");
    expect(bound !== null && bound !== "ambiguous" ? bound.ref.lookup : bound).toEqual({ kind: "folder", folder, exclude: [peer] });
    // Another kind in the same folder is no peer.
    expect(paneSession({ ...machine, agents: [{ paneID: "A", ...plain }, { paneID: "B", agent: "claude", cwd: folder }] }, "A")).not.toBe("ambiguous");
  });

  it("Search skips a Copilot or Droid pane (never greps another agent's folder for it)", () => {
    const query = SearchQuery.make("typo")!;
    const targets = [
      { paneID: "A", session: makeSessionRef("copilot", { kind: "folder", folder })! },
      { paneID: "B", session: makeSessionRef("copilot", { kind: "id", id: own })! },
      { paneID: "C", session: makeSessionRef("droid", { kind: "folder", folder })! },
    ];
    expect(SearchCommand.make(query, targets)).toBeNull();
    const claude = { paneID: "D", session: makeSessionRef("claude", { kind: "folder", folder })! };
    const command = SearchCommand.make(query, [...targets, claude])!;
    expect([command.targets.map((target) => target.paneID), command.skipped.map((target) => target.paneID)]).toEqual([["D"], ["A", "B", "C"]]);
  });

  it("a mismatch: a log of another folder shows nothing", async () => {
    serial = 0;
    const reader = new FakeTranscriptReader();
    reader.put(logOf(own), session("/Users/fixture/elsewhere", 2), logOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makeSessionRef("copilot", { kind: "id", id: own }), [folder]);
    expect(await eventually(() => isUnavailable(feed.state, "sessionMismatch"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
    // The same log in its own folder reads.
    const right = new FakeTranscriptReader();
    right.put(logOf(own), session(folder, 2), logOf(own));
    const live = new ChatFeed(right, { pollIntervalMs: 5 });
    live.start(makeSessionRef("copilot", { kind: "id", id: own }), [folder]);
    expect(await eventually(() => live.state.status === "live" && live.timeline.turns.length === 2)).toBe(true);
    live.stop();
  });
});

describe("copilot: the locate command on a synthetic home", () => {
  function home(): string {
    const made = path.join(scratch, `copilot-home-${randomUUID()}`);
    mkdirSync(made, { recursive: true });
    return made;
  }
  function putLog(root: string, id: string, content: string, mtime: number): string {
    const dir = path.join(root, ".copilot", "session-state", id);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "events.jsonl");
    writeFileSync(file, content);
    utimesSync(file, mtime, mtime);
    return file;
  }
  function located(root: string, ref: TranscriptSessionRef): string | null {
    const output = execFileSync("/bin/sh", ["-c", locateCommand(ref)!], { env: { PATH: "/usr/bin:/bin", HOME: root }, encoding: "utf8" });
    return parseLocateOutput(output, ref);
  }

  it("finds a log by id, and none for an id that is not there", () => {
    const root = home();
    const file = putLog(root, own, session(folder, 1), 1_000);
    expect(located(root, makeSessionRef("copilot", { kind: "id", id: own })!)).toBe(file);
    expect(located(root, makeSessionRef("copilot", { kind: "id", id: peer })!)).toBeNull();
  });

  it("finds a folder's newest log, skips a peer's, and never takes another folder's or a longer name's", () => {
    const root = home();
    const older = putLog(root, own, session(folder, 1), 1_000);
    const newer = putLog(root, peer, session(folder, 1), 2_000);
    putLog(root, randomUUID(), session(folder + "2", 1), 3_000);
    putLog(root, randomUUID(), session("/Users/fixture/other", 1), 4_000);
    expect(located(root, makeSessionRef("copilot", { kind: "folder", folder })!)).toBe(newer);
    expect(located(root, makeSessionRef("copilot", { kind: "folder", folder, exclude: [peer] })!)).toBe(older);
    expect(located(root, makeSessionRef("copilot", { kind: "folder", folder: "/Users/fixture/none" })!)).toBeNull();
  });

  it("reads only a log's first lines for its folder, and an empty home finds nothing", () => {
    const root = home();
    const late = [event("session.info", { infoType: "x", message: "y" }, 0), event("session.info", { infoType: "x", message: "y" }, 0), event("session.info", { infoType: "x", message: "y" }, 0), event("session.info", { infoType: "x", message: "y" }, 0), start(folder)].join("\n") + "\n";
    putLog(root, own, late, 1_000);
    expect(located(root, makeSessionRef("copilot", { kind: "folder", folder })!), "cwd only on the fifth line").toBeNull();
    expect(located(home(), makeSessionRef("copilot", { kind: "folder", folder })!)).toBeNull();
    expect(copilotFolderCandidates).toBe(64);
  });

  it("parses only a path in Copilot's layout, and never the excluded session", () => {
    const ref = makeSessionRef("copilot", { kind: "folder", folder, exclude: [peer] })!;
    expect(parseLocateOutput(logOf(own) + "\n", ref)).toBe(logOf(own));
    expect(parseLocateOutput(logOf(peer) + "\n", ref)).toBeNull();
    expect(parseLocateOutput(`/Users/fixture/.copilot/history-session-state/${own}/events.jsonl\n`, ref)).toBeNull();
    expect(parseLocateOutput("/tmp/events.jsonl\n", ref)).toBeNull();
    const byID = makeSessionRef("copilot", { kind: "id", id: own })!;
    expect(parseLocateOutput(logOf(peer) + "\n", byID), "another session's log is not this id's").toBeNull();
  });
});

describe("copilot: following the log, within the reader's bounds", () => {
  const ref = makeSessionRef("copilot", { kind: "id", id: own })!;

  it("growth: new lines show as they are written", async () => {
    serial = 0;
    const reader = new FakeTranscriptReader();
    reader.put(logOf(own), session(folder, 1), logOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    reader.append(logOf(own), prompt("one more", 10) + "\n");
    expect(await eventually(() => userTexts(feed).at(-1) === "one more" && feed.timeline.turns.at(-1)!.isFinished === false)).toBe(true);
    reader.append(logOf(own), answer("done", 11) + "\n");
    expect(await eventually(() => feed.timeline.turns.at(-1)!.isFinished)).toBe(true);
    feed.stop();
  });

  it("an oversize line (over 8 MiB) is dropped and the line after it still shows", async () => {
    serial = 0;
    const reader = new FakeTranscriptReader();
    reader.put(logOf(own), session(folder, 1), logOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 1 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    reader.append(logOf(own), prompt("x".repeat(9 * 1_024 * 1_024), 20) + "\n" + prompt("after the big one", 21) + "\n");
    expect(await eventually(() => userTexts(feed).at(-1) === "after the big one", 20_000)).toBe(true);
    expect(userTexts(feed).some((text) => text !== undefined && text.length > 1_000), "the oversize line shows nothing").toBe(false);
    feed.stop();
  }, 30_000);

  it("a file replaced or truncated starts over", async () => {
    serial = 0;
    const reader = new FakeTranscriptReader();
    reader.put(logOf(own), session(folder, 3), logOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 3)).toBe(true);
    reader.put(logOf(own), [start(folder), prompt("fresh start", 1)].join("\n") + "\n", logOf(own));
    expect(await eventually(() => userTexts(feed).length === 1 && userTexts(feed)[0] === "fresh start")).toBe(true);
    feed.stop();
  });

  it("omissions kept: a picture's base64 the relay left out is put back before the line is parsed", () => {
    serial = 0;
    const data = "iVBORw0KGgo" + "A".repeat(2_000);
    const line = event("user.message", { content: "see this", attachments: [{ type: "blob", data, mimeType: "image/png" }] }, 1);
    const bytes = new TextEncoder().encode(line + "\n");
    const at = line.indexOf(data);
    const range: BlobRange = [at, data.length];
    const kept = new Uint8Array([...bytes.subarray(0, at), ...bytes.subarray(at + data.length)]);
    const follower = new TranscriptFollower();
    follower.nextRead(bytes.length);
    const [read] = follower.consumeLines(0, rebuildOmitted(0, kept, [range])!, [range]);
    expect(read!.text).toContain(blobMark(range));
    expect(read!.blobs).toEqual([range]);
    // Copilot's blob `data` is no image block the scan knows: the run is fetched back, never parsed as a placeholder.
    const plan = blobsToRestore(read!.text, read!.blobs!);
    expect(plan).toEqual({ restore: [range], whole: false });
    const parsed = new TranscriptParser("copilot").parse(read!.text.replace(blobMark(range), data), 0);
    expect(parsed.events.map((event) => (event.type === "userMessage" ? event.message.attachments : null))).toEqual([[{ path: null, mediaType: "image/png" }]]);
  });
});
