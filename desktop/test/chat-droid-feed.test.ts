// How a Droid pane binds to its session file, and the file followed in the feed, against fakes:
// Herdr snapshots as the wire gives them, a fake transcript reader, and the locate command run with `/bin/sh` on a
// synthetic home under the test scratch folder (never the real home). The session lines are synthetic, built from
// Factory-AI/droid-sdk-python aa6fd94 (discovery.py, schemas/messages.py).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { droidAmbiguousReason, droidProjectName, droidResumeID } from "../src/shared/chat/agents/droid-locate";
import { blobMark, blobsToRestore, rebuildOmitted, type BlobRange } from "../src/shared/chat/blobs";
import { ChatFeed, type ChatFeedState } from "../src/shared/chat/feed";
import { TranscriptFollower } from "../src/shared/chat/follower";
import { chatReadsKind } from "../src/shared/chat/kinds";
import {
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
import { scratch } from "./support/changes-git";
import { at, eventually, FakeTranscriptReader } from "./support/chat-lines";

const own = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const peer = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const folder = "/Users/fixture/my proj";
const project = "-Users-fixture-my proj";
const fileOf = (id: string, name = project): string => `/Users/fixture/.factory/sessions/${name}/${id}.jsonl`;
const named = (id: string): AgentSessionLike => ({ source: "herdr:droid", agent: "droid", kind: "id", value: id });

const start = (cwd: string): string => JSON.stringify({ type: "session_start", title: "t", cwd, owner: "fixture" });
const said = (id: string, role: string, value: string, second: number): string =>
  JSON.stringify({ type: "message", message: { id, role, content: [{ type: "text", text: value }], createdAt: at(second) * 1_000 } });
const session = (cwd: string, turns: number): string =>
  [start(cwd), ...Array.from({ length: turns }, (_, n) => [said(`u${n}`, "user", `question ${n}`, n * 2 + 1), said(`a${n}`, "assistant", `answer ${n}`, n * 2 + 2)]).flat()].join("\n") + "\n";

const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;
const userTexts = (feed: ChatFeed<TranscriptSessionRef>): (string | undefined)[] => feed.timeline.turns.map((turn) => turnUserMessage(turn)?.text);

describe("droid: a pane binds to its session (fake Herdr snapshots)", () => {
  it("the reported id: Herdr's herdr:droid report names the file", () => {
    expect(sessionRefFromAgentSession(named(own))).toEqual({ format: "droid", lookup: { kind: "id", id: own } });
    expect(sessionRefFromAgentSession(named("abc;rm")), "an id that is not Droid's never reaches a command").toBeNull();
    const machine: MachinePanes = { agents: [{ paneID: "A", agent: "droid", cwd: folder, agentSession: named(own) }], panes: [{ paneID: "A", agent: "droid", cwd: folder }] };
    const bound = paneSession(machine, "A");
    expect(bound !== null && bound !== "ambiguous" ? [bound.ref, bound.source] : bound).toEqual([{ format: "droid", lookup: { kind: "id", id: own } }, "herdr:droid"]);
    expect(chatReadsKind("droid")).toBe(true);
  });

  it("the resume id in the foreground command (droid --resume <id>, --resume=<id>, -r <id>)", () => {
    expect(droidResumeID(["droid", "--resume", own])).toBe(own);
    expect(droidResumeID(["droid", `--resume=${own}`])).toBe(own);
    expect(droidResumeID(["droid", "-r", own])).toBe(own);
    expect(droidResumeID(["droid", "--resume"])).toBeNull();
    expect(sessionFromArgv(["droid", "--resume", own], "droid")).toEqual(named(own));
    const pane = sessionForPane({ agent: "droid", cwd: folder }, { argv: ["droid", "--resume", own] });
    expect([pane?.ref, pane?.source]).toEqual([{ format: "droid", lookup: { kind: "id", id: own } }, "argv"]);
  });

  it("the folder rule: Droid's folder name is the path with every / as -", () => {
    expect(droidProjectName(folder)).toBe(project);
    expect(droidProjectName("/Users/fixture/proj/")).toBe("-Users-fixture-proj");
    expect(sessionForPane({ agent: "droid", cwd: folder })?.ref).toEqual({ format: "droid", lookup: { kind: "folder", folder } });
  });

  it("the ambiguous case: two Droid panes in one folder naming no session are not told apart", () => {
    const plain = { agent: "droid", cwd: folder };
    const machine: MachinePanes = {
      agents: [{ paneID: "A", ...plain }, { paneID: "B", ...plain }],
      panes: [{ paneID: "A", agent: "droid", cwd: folder }, { paneID: "B", agent: "droid", cwd: folder }],
    };
    expect(paneSession(machine, "A")).toBe("ambiguous");
    expect(droidAmbiguousReason("droid")).toBe("ambiguousDroidSession");
    expect(droidAmbiguousReason("copilot")).toBeNull();
    const withNamedPeer: MachinePanes = { ...machine, agents: [{ paneID: "A", ...plain }, { paneID: "B", ...plain, agentSession: named(peer) }] };
    const bound = paneSession(withNamedPeer, "A");
    expect(bound !== null && bound !== "ambiguous" ? bound.ref.lookup : bound).toEqual({ kind: "folder", folder, exclude: [peer] });
  });

  it("a mismatch: a session of another folder shows nothing", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(fileOf(own), session("/Users/fixture/elsewhere", 2), fileOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makeSessionRef("droid", { kind: "id", id: own }), [folder]);
    expect(await eventually(() => isUnavailable(feed.state, "sessionMismatch"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });
});

describe("droid: the locate command on a synthetic home", () => {
  function home(): string {
    const made = path.join(scratch, `droid-home-${randomUUID()}`);
    mkdirSync(made, { recursive: true });
    return made;
  }
  function putFile(root: string, name: string | null, id: string, content: string, mtime: number): string {
    const dir = name === null ? path.join(root, ".factory", "sessions") : path.join(root, ".factory", "sessions", name);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, content);
    utimesSync(file, mtime, mtime);
    return file;
  }
  function located(root: string, ref: TranscriptSessionRef): string | null {
    const output = execFileSync("/bin/sh", ["-c", locateCommand(ref)!], { env: { PATH: "/usr/bin:/bin", HOME: root }, encoding: "utf8" });
    return parseLocateOutput(output, ref);
  }

  it("finds a session by id, filed under its folder or an older one in the sessions folder itself", () => {
    const root = home();
    const filed = putFile(root, project, own, session(folder, 1), 1_000);
    expect(located(root, makeSessionRef("droid", { kind: "id", id: own })!)).toBe(filed);
    const older = putFile(root, null, peer, session(folder, 1), 1_000);
    expect(located(root, makeSessionRef("droid", { kind: "id", id: peer })!)).toBe(older);
    expect(located(root, makeSessionRef("droid", { kind: "id", id: randomUUID() })!)).toBeNull();
  });

  it("finds a folder's newest session, skips a peer's, and never takes a session another folder's", () => {
    const root = home();
    const older = putFile(root, project, own, session(folder, 1), 1_000);
    const newer = putFile(root, project, peer, session(folder, 1), 2_000);
    // Filed under this folder's name but naming another folder in its first line: not taken (Droid's names can
    // collide, `/a-b` and `/a/b` are both `-a-b`, so the first line's cwd decides).
    putFile(root, project, randomUUID(), session("/Users/fixture/my/proj", 1), 3_000);
    putFile(root, "-Users-fixture-other", randomUUID(), session("/Users/fixture/other", 1), 4_000);
    expect(located(root, makeSessionRef("droid", { kind: "folder", folder })!)).toBe(newer);
    expect(located(root, makeSessionRef("droid", { kind: "folder", folder, exclude: [peer] })!)).toBe(older);
    expect(located(home(), makeSessionRef("droid", { kind: "folder", folder })!), "an empty home").toBeNull();
  });

  it("parses only a path in Droid's layout, and never the excluded session", () => {
    const ref = makeSessionRef("droid", { kind: "folder", folder, exclude: [peer] })!;
    expect(parseLocateOutput(fileOf(own) + "\n", ref)).toBe(fileOf(own));
    expect(parseLocateOutput(fileOf(peer) + "\n", ref)).toBeNull();
    expect(parseLocateOutput(fileOf(own, "-Users-fixture-other") + "\n", ref), "another folder's").toBeNull();
    expect(parseLocateOutput(`/Users/fixture/.factory/sessions/${project}/notes.jsonl\n`, ref)).toBeNull();
    const byID = makeSessionRef("droid", { kind: "id", id: own })!;
    expect(parseLocateOutput(fileOf(peer) + "\n", byID)).toBeNull();
    expect(parseLocateOutput(`/Users/fixture/.factory/sessions/${own}.jsonl\n`, byID), "an older one in the sessions folder").toBe(`/Users/fixture/.factory/sessions/${own}.jsonl`);
  });
});

describe("droid: following the file, within the reader's bounds", () => {
  const ref = makeSessionRef("droid", { kind: "id", id: own })!;

  it("growth: new lines show as they are written", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(fileOf(own), session(folder, 1), fileOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    reader.append(fileOf(own), said("u9", "user", "one more", 10) + "\n");
    expect(await eventually(() => userTexts(feed).at(-1) === "one more" && !feed.timeline.turns.at(-1)!.isFinished)).toBe(true);
    reader.append(fileOf(own), said("a9", "assistant", "done", 11) + "\n");
    expect(await eventually(() => feed.timeline.turns.at(-1)!.isFinished)).toBe(true);
    feed.stop();
  });

  it("an oversize line (over 8 MiB) is dropped and the line after it still shows", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(fileOf(own), session(folder, 1), fileOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 1 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    reader.append(fileOf(own), said("big", "user", "x".repeat(9 * 1_024 * 1_024), 20) + "\n" + said("after", "user", "after the big one", 21) + "\n");
    expect(await eventually(() => userTexts(feed).at(-1) === "after the big one", 20_000)).toBe(true);
    expect(userTexts(feed).some((text) => text !== undefined && text.length > 1_000), "the oversize line shows nothing").toBe(false);
    feed.stop();
  }, 30_000);

  it("a file replaced or truncated starts over", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(fileOf(own), session(folder, 3), fileOf(own));
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 3)).toBe(true);
    reader.put(fileOf(own), [start(folder), said("n1", "user", "fresh start", 1)].join("\n") + "\n", fileOf(own));
    expect(await eventually(() => userTexts(feed).length === 1 && userTexts(feed)[0] === "fresh start")).toBe(true);
    feed.stop();
  });

  it("omissions kept: an image block's base64 the relay left out stays a placeholder, and the line still reads", () => {
    const data = "iVBORw0KGgo" + "A".repeat(2_000);
    const line = JSON.stringify({ type: "message", message: { id: "u1", role: "user", content: [{ type: "image", source: { type: "base64", data, mediaType: "image/png" } }, { type: "text", text: "see this" }] } });
    const bytes = new TextEncoder().encode(line + "\n");
    const offset = line.indexOf(data);
    const range: BlobRange = [offset, data.length];
    const kept = new Uint8Array([...bytes.subarray(0, offset), ...bytes.subarray(offset + data.length)]);
    const follower = new TranscriptFollower();
    follower.nextRead(bytes.length);
    const [read] = follower.consumeLines(0, rebuildOmitted(0, kept, [range])!, [range]);
    expect(read!.text).toContain(blobMark(range));
    // Droid's image block is Anthropic's shape: the scan keeps the placeholder (no read to put it back).
    expect(blobsToRestore(read!.text, read!.blobs!)).toEqual({ restore: [], whole: false });
    const parsed = new TranscriptParser("droid").parse(read!.text, 0, { path: fileOf(own), ino: null, ranges: read!.blobs! });
    expect(parsed.events.map((event) => (event.type === "userMessage" ? [event.message.text, event.message.attachments] : null))).toEqual([["see this", [{ path: null, mediaType: "image/png" }]]]);
  });
});
