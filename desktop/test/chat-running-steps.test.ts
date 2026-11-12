// Running work in Chat: a running subagent's step reads never hold up Chat (the parent
// load is published and loaded() resolves first; the reads run beside the
// follow, bounded, while live polls go on); a step pass ends with
// its follow (stop, a new follow, a start-over, a pause, Chat hidden, the
// follow's end) and writes nothing after; running work survives
// trims (ordinary calls never let a running task or subagent go, and its end
// is kept for Load earlier); Load earlier carries the session ids
// it read into the live parser (a later line naming one is no new session);
// a hide (shown again or not) and endSession end a pass for
// good, a fresh pass reading the step as it is then;
// running work is oldest first by its start (insertion order for
// ties and unknown starts: each call's own, first seen),
// held or let go by a trim; a Bash
// call Claude Code moved to the background keeps its description.
// The twin of the iPhone app's tests on the same fixtures. Fixtures only.

import { afterEach, describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { claudeToolCall } from "../src/shared/chat/claude-parser";
import { ChatFeed, TranscriptNotFoundError } from "../src/shared/chat/feed";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { runningWork, type ChatSubagent, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { SubagentSteps } from "../src/shared/chat/subagent-steps";
import { claudePath, claudeSession, eventually, FakeTranscriptReader, reply, stamp } from "./support/chat-lines";
import {
  agentCall,
  agentLaunched,
  assistantTool,
  backgroundBash,
  busyTurn,
  foregroundAgentID,
  notice,
  queued,
  shellLaunched,
  subagentMeta,
  subagentPrompt,
  subagentTool,
  subagentsFolder,
  toolResult,
  typed,
} from "./support/running-lines";

const backgroundAgentID = "a1b2c3d4e5f60718";
const foregroundMeta = `${subagentsFolder}/agent-${foregroundAgentID}.meta.json`;
const backgroundMeta = `${subagentsFolder}/agent-${backgroundAgentID}.meta.json`;
const otherPath = "/Users/fixture/.claude/projects/-Users-fixture-proj/7c2e5b1d-3a8f-4e6b-9c0d-6e5f1a2b3c4d.jsonl";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake reader with a folder listing, one subagent file's first read held until `release`, and the follow's file gone on request. */
class HeldStepsReader extends FakeTranscriptReader {
  private readonly names = new Set<string>();
  /** The subagent file whose `holdRead`th read waits for `release`. */
  holdPath: string | null = null;
  holdRead = 1;
  private readsOfHeld = 0;
  heldNow = false;
  private releaseHeld: (() => void) | null = null;
  /** The followed file is gone (its size: not found). */
  gone = false;
  /** Every request for the subagents folder or a file in it, in order. */
  stepCalls: string[] = [];

  override put(path: string, content: string, located: string | null): void {
    super.put(path, content, located);
    this.names.add(path);
  }

  async list(folder: string): Promise<readonly string[]> {
    this.stepCalls.push("list");
    const prefix = folder + "/";
    return [...this.names].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map((path) => path.slice(prefix.length));
  }

  override async size(path: string): Promise<number> {
    if (this.gone && path === claudePath) throw new TranscriptNotFoundError(path);
    if (path.startsWith(subagentsFolder + "/")) this.stepCalls.push("size " + path.slice(subagentsFolder.length + 1));
    return super.size(path);
  }

  override async read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    // A held read answers with the file as it was when asked.
    const answer = await super.read(path, offset, maxBytes);
    if (path.startsWith(subagentsFolder + "/")) {
      this.stepCalls.push("read " + path.slice(subagentsFolder.length + 1));
      if (path === this.holdPath) this.readsOfHeld += 1;
      if (path === this.holdPath && this.readsOfHeld === this.holdRead) {
        this.heldNow = true;
        await new Promise<void>((resolve) => (this.releaseHeld = resolve));
        this.heldNow = false;
      }
    }
    return answer;
  }

  release(): void {
    this.releaseHeld?.();
    this.releaseHeld = null;
  }
}

/** The busy turn's two subagents' files: the foreground one (toolu_fga) found by its meta.json, the background one (toolu_bga) by its launch id. */
function putSubagents(reader: HeldStepsReader): void {
  reader.put(claudePath, busyTurn.map((line) => line + "\n").join(""), claudePath);
  reader.put(foregroundMeta, subagentMeta("toolu_fga", false), null);
  reader.put(
    `${subagentsFolder}/agent-${foregroundAgentID}.jsonl`,
    subagentPrompt(foregroundAgentID, "Read Banner.swift.", "s1", 5) + subagentTool(foregroundAgentID, "toolu_s2", "Read", { file_path: "/Users/fixture/proj/Sources/Banner.swift" }, "s4", 7),
    null,
  );
  reader.put(backgroundMeta, subagentMeta("toolu_bga", false, "Check the phone layout"), null);
  reader.put(`${subagentsFolder}/agent-${backgroundAgentID}.jsonl`, subagentTool(backgroundAgentID, "toolu_b1", "Bash", { command: "swift test --filter Chips" }, "b2", 8), null);
}

let feeds: ChatFeed<TranscriptSessionRef>[] = [];
let readers: HeldStepsReader[] = [];
afterEach(() => {
  for (const reader of readers) reader.release();
  for (const feed of feeds) feed.stop();
  feeds = [];
  readers = [];
});

function heldFeed(holdPath: string, shown: () => boolean = () => true, read = 1): { reader: HeldStepsReader; feed: ChatFeed<TranscriptSessionRef> } {
  const reader = new HeldStepsReader();
  readers.push(reader);
  putSubagents(reader);
  reader.holdPath = holdPath;
  reader.holdRead = read;
  const feed = new ChatFeed(reader, { pollIntervalMs: 5, stepIntervalMs: 10, stepsShown: shown });
  feeds.push(feed);
  feed.start(claudeSession);
  return { reader, feed };
}

const lastText = (timeline: ChatTimeline): string | null => {
  const item = timeline.turns.at(-1)?.items.at(-1);
  return item?.type === "agentText" ? item.value.markdown : null;
};

const within = <T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> => Promise.race([promise, sleep(ms).then(() => "timed out" as const)]);

describe("a subagent's step reads never hold up Chat", () => {
  it.each([
    ["a discovery meta read (the foreground agent's, found by listing)", foregroundMeta],
    ["a known agent's meta read (the background agent's, by its launch id)", backgroundMeta],
  ])("loaded() resolves, the chat is live and a reply appended shows while %s is held", async (_, holdPath) => {
    const { reader, feed } = heldFeed(holdPath);
    expect(await within(feed.loaded(), 2_000)).toBe(true);
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    expect(feed.state.status).toBe("live");
    reader.append(claudePath, reply("The banner's line limit is set now.", "a9", 30) + "\n");
    expect(await eventually(() => lastText(feed.timeline) === "The banner's line limit is set now.", 2_000)).toBe(true);
    // The step read is still held: the live polls went on beside it.
    expect(reader.heldNow).toBe(true);
    reader.release();
    expect(await eventually(() => runningWork(feed.timeline).find((work) => work.id === "toolu_fga")?.step === "Read Banner.swift", 2_000)).toBe(true);
  });
});

describe("a step pass ends with its follow", () => {
  const triggers: [string, (feed: ChatFeed<TranscriptSessionRef>, reader: HeldStepsReader, hide: () => void) => void][] = [
    ["stop", (feed) => feed.stop()],
    ["a new follow", (feed, reader) => {
      reader.put(otherPath, typed("Another session, nothing running", "o1", 40) + "\n", otherPath);
      feed.start(makeSessionRef("claude", { kind: "id", id: "7c2e5b1d-3a8f-4e6b-9c0d-6e5f1a2b3c4d" })!);
    }],
    ["a start-over (the file replaced by one with nothing running)", (_, reader) => reader.put(claudePath, typed("Replaced", "n1", 50) + "\n", claudePath)],
    ["a pause", (feed) => feed.pause()],
    ["Chat hidden", (_, __, hide) => hide()],
    ["the follow's end (the file gone)", (_, reader) => {
      reader.gone = true;
    }],
  ];

  it.each(triggers)("%s with a discovery meta read held: released, the pass reads nothing more and remembers nothing", async (name, trigger) => {
    let shown = true;
    const { reader, feed } = heldFeed(foregroundMeta, () => shown);
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    const known = feed.subagentStepsKnown;
    trigger(feed, reader, () => (shown = false));
    // A start-over or the file's end is seen by the next poll.
    if (name.startsWith("a start-over")) expect(await eventually(() => runningWork(feed.timeline).length === 0, 2_000)).toBe(true);
    if (name.startsWith("the follow's end")) expect(await eventually(() => feed.state.status === "unavailable", 2_000)).toBe(true);
    const before = reader.stepCalls.length;
    reader.release();
    await sleep(80);
    expect(reader.stepCalls.slice(before)).toEqual([]);
    if (name === "a pause" || name === "Chat hidden") expect(feed.subagentStepsKnown).toBe(known);
  });

  it("stop with a known agent's meta read for its step held: its size and tail are not read after", async () => {
    // Its second read: the folder's discovery reads it first.
    const { reader, feed } = heldFeed(backgroundMeta, () => true, 2);
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    feed.stop();
    const before = reader.stepCalls.length;
    reader.release();
    await sleep(80);
    expect(reader.stepCalls.slice(before)).toEqual([]);
  });

  it("a pass whose follow ended during a held read writes nothing to its memory and reads no more (SubagentSteps)", async () => {
    const reader = new HeldStepsReader();
    readers.push(reader);
    putSubagents(reader);
    reader.holdPath = foregroundMeta;
    const agent = (id: string, agentID: string | null, background: boolean): ChatSubagent => ({
      id,
      description: id,
      type: "Explore",
      background,
      name: null,
      agentID,
      prompt: "check",
      state: "running",
      startedAt: 4,
      finishedAt: null,
      report: null,
    });
    const steps = new SubagentSteps(10);
    let alive = true;
    const pass = steps.read(reader, claudePath, [agent("toolu_bga", backgroundAgentID, true), agent("toolu_fga", null, false)], () => alive);
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    alive = false;
    const before = reader.stepCalls.length;
    reader.release();
    const result = await pass;
    expect(reader.stepCalls.slice(before)).toEqual([]);
    expect(steps.known).toBe(0);
    expect([...result.values()].every((step) => step === null)).toBe(true);
  });

  it("a call that ended while its pass ran is not read on", async () => {
    const reader = new HeldStepsReader();
    readers.push(reader);
    putSubagents(reader);
    reader.holdPath = foregroundMeta;
    const running = new Set(["toolu_bga", "toolu_fga"]);
    const agent = (id: string, agentID: string | null): ChatSubagent => ({ id, description: id, type: null, background: agentID !== null, name: null, agentID, prompt: null, state: "running", startedAt: 4, finishedAt: null, report: null });
    const steps = new SubagentSteps(10);
    const pass = steps.read(reader, claudePath, [agent("toolu_fga", null), agent("toolu_bga", backgroundAgentID)], (callID) => callID === undefined || running.has(callID));
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    running.delete("toolu_bga");
    reader.release();
    const result = await pass;
    // The folder's discovery may read its meta.json; its step (the transcript's size and tail) is not read.
    expect(reader.stepCalls.filter((call) => call.includes(`agent-${backgroundAgentID}.jsonl`))).toEqual([]);
    expect(result.get("toolu_fga")).toBe("Read Banner.swift");
    expect(result.has("toolu_bga")).toBe(false);
  });
});

describe("hide and endSession retire a step pass for good", () => {
  const foregroundTail = `${subagentsFolder}/agent-${foregroundAgentID}.jsonl`;
  const stepOf = (feed: ChatFeed<TranscriptSessionRef>, id: string): string | null | undefined => runningWork(feed.timeline).find((work) => work.id === id)?.step;

  function feedWith(holdPath: string, options: { shown?: () => boolean; revision?: () => number; intervalMs: number; other?: boolean }): { reader: HeldStepsReader; feed: ChatFeed<TranscriptSessionRef> } {
    const reader = new HeldStepsReader();
    readers.push(reader);
    putSubagents(reader);
    if (options.other === true) reader.put(`${subagentsFolder}/agent-zz-other.meta.json`, subagentMeta("unrelated", false), null);
    reader.holdPath = holdPath;
    const feed = new ChatFeed(reader, { pollIntervalMs: 5, stepIntervalMs: options.intervalMs, stepsShown: options.shown, stepsRevision: options.revision });
    feeds.push(feed);
    feed.start(claudeSession);
    return { reader, feed };
  }

  it("a tail held, Chat hidden for a few polls and shown again, released: no old step, nothing remembered", async () => {
    let shown = true;
    const { reader, feed } = feedWith(foregroundTail, { shown: () => shown, intervalMs: 60_000 });
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    const known = feed.subagentStepsKnown;
    shown = false;
    await sleep(40);
    shown = true;
    const before = reader.stepCalls.length;
    reader.release();
    await sleep(60);
    expect(reader.stepCalls.slice(before)).toEqual([]);
    expect(feed.subagentStepsKnown).toBe(known);
    expect(stepOf(feed, "toolu_fga") ?? null).toBe(null);
  });

  it("shown again, a fresh pass reads the step as it is now; the old pass's answer never lands", async () => {
    let shown = true;
    const { reader, feed } = feedWith(foregroundTail, { shown: () => shown, intervalMs: 50 });
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    // The held read answers with the old tail (Read Banner.swift); the file has a newer step meanwhile.
    reader.append(foregroundTail, subagentTool(foregroundAgentID, "toolu_s9", "Edit", { file_path: "/Users/fixture/proj/Sources/Header.swift" }, "s9", 20));
    shown = false;
    await sleep(40);
    shown = true;
    expect(await eventually(() => stepOf(feed, "toolu_fga") === "Edit Header.swift", 2_000)).toBe(true);
    reader.release();
    await sleep(80);
    expect(stepOf(feed, "toolu_fga")).toBe("Edit Header.swift");
  });

  it("a hide too quick for any poll still ends the pass, by the visibility revision", async () => {
    let shown = true;
    let hides = 0;
    const { reader, feed } = feedWith(foregroundTail, { shown: () => shown, revision: () => hides, intervalMs: 50 });
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    reader.append(foregroundTail, subagentTool(foregroundAgentID, "toolu_s9", "Edit", { file_path: "/Users/fixture/proj/Sources/Header.swift" }, "s9", 20));
    // Chat to Changes and back between two polls: only the revision says so.
    shown = false;
    hides += 1;
    shown = true;
    expect(await eventually(() => stepOf(feed, "toolu_fga") === "Edit Header.swift", 2_000)).toBe(true);
    reader.release();
    await sleep(80);
    expect(stepOf(feed, "toolu_fga")).toBe("Edit Header.swift");
  });

  it("endSession with a discovery meta read held: released, no further meta read and no owner remembered", async () => {
    const { reader, feed } = feedWith(foregroundMeta, { intervalMs: 60_000, other: true });
    expect(await eventually(() => reader.heldNow, 2_000)).toBe(true);
    const known = feed.subagentStepsKnown;
    feed.endSession();
    const before = reader.stepCalls.length;
    reader.release();
    await sleep(60);
    expect(reader.stepCalls.slice(before)).toEqual([]);
    expect(feed.subagentStepsKnown).toBe(known);
  });
});

describe("running work survives trims", () => {
  /** `count` ordinary Read calls with their results (a second apart from `second`). */
  const reads = (from: number, count: number, second: number): string[] =>
    Array.from({ length: count }, (_, n) => {
      const id = `toolu_r${from + n}`;
      return [assistantTool(id, "Read", { file_path: `/Users/fixture/proj/f${from + n}.ts` }, `ra${from + n}`, second + n), toolResult(id, "1\u2192x", {}, `rr${from + n}`, second + n)];
    }).flat();
  const shellStart = [typed("Start the server and read around", "u1", 0), backgroundBash("toolu_sh", "npm run dev -- --port 5173", "Start the dev server", "a1", 2), shellLaunched("toolu_sh", "b7k2q9", "r1", 2)];
  const shellDone = queued(notice({ task: "b7k2q9", toolUse: "toolu_sh", status: "completed", summary: 'Background command "Start the dev server" completed (exit code 0)' }), 1_000);
  const callNamed = (timeline: ChatTimeline, id: string) =>
    timeline.turns.flatMap((turn) => turn.items).flatMap((item) => (item.type === "toolCall" && item.value.id === id ? [item.value] : []))[0];

  it("a background shell stays running past 300 later ordinary calls trimmed; its notice ends it; Load earlier then brings no ghost", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder(2, 4);
    const apply = (lines: readonly string[]): void => {
      for (const line of lines) builder.apply(parser.parse(line).events);
    };
    apply(shellStart);
    apply(reads(0, 300, 10));
    expect(callNamed(builder.timeline, "toolu_sh")).toBeUndefined();
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["toolu_sh"]);
    apply([shellDone]);
    expect(runningWork(builder.timeline)).toEqual([]);
    // 300 more ordinary calls let go after its end: the end is still kept for the lines read again.
    apply(reads(300, 300, 1_010));
    const older = new ChatTimelineBuilder();
    older.apply(new TranscriptParser("claude").parseText(shellStart.join("\n")));
    expect(runningWork(older.timeline).map((work) => work.id)).toEqual(["toolu_sh"]);
    builder.prepend(older);
    expect(callNamed(builder.timeline, "toolu_sh")?.task?.state).toBe("done");
    expect(runningWork(builder.timeline)).toEqual([]);
  });

  it("a background agent stays running past 300 later finished subagents trimmed, and its notice ends it", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder(2, 4);
    const apply = (lines: readonly string[]): void => {
      for (const line of lines) builder.apply(parser.parse(line).events);
    };
    apply([typed("Check the phone layout in the background", "u0", 0), agentCall("toolu_bga", "Check the phone layout", "Open the phone layout.", "a0", 1, true), agentLaunched("toolu_bga", backgroundAgentID, "r0", 1), reply("Started.", "e0", 2, true)]);
    for (let n = 0; n < 300; n += 1) {
      const second = 10 + n * 3;
      apply([typed(`Look ${n}`, `u${n + 1}`, second), agentCall(`toolu_f${n}`, `Look ${n}`, "Look.", `a${n + 1}`, second, false), toolResult(`toolu_f${n}`, "Nothing.", { status: "completed" }, `r${n + 1}`, second + 1), reply(`Done ${n}.`, `e${n + 1}`, second + 2, true)]);
    }
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["toolu_bga"]);
    apply([queued(notice({ task: backgroundAgentID, toolUse: "toolu_bga", status: "completed", summary: 'Agent "Check the phone layout" completed' }), 2_000)]);
    expect(runningWork(builder.timeline)).toEqual([]);
  });

  it("one old running shell after 300 ordinary calls are trimmed (tiny caps)", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder(2, 4);
    for (const line of [...shellStart, ...reads(0, 300, 10)]) builder.apply(parser.parse(line).events);
    expect(runningWork(builder.timeline).map((work) => work.id)).toContain("toolu_sh");
  });
});

describe("Load earlier carries the session ids it read", () => {
  const sessionA = "aaaaaaaa-1111-4222-8333-444444444444";
  const sessionB = "bbbbbbbb-5555-4666-8777-888888888888";
  const sessionC = "cccccccc-9999-4aaa-8bbb-cccccccccccc";
  const inSession = (line: string, id: string): string => JSON.stringify({ ...(JSON.parse(line) as object), sessionId: id });
  const named = (id: string, second: number): string => JSON.stringify({ content: "an earlier session's line", operation: "enqueue", sessionId: id, timestamp: stamp(second), type: "queue-operation" });
  const liveB = [backgroundBash("toolu_bg", "npm run dev -- --port 5173", "Start the dev server", "b2", 21), shellLaunched("toolu_bg", "b7k2q9", "b3", 21)].map((line) => inSession(line, sessionB));

  /** Live in `live`; then each chunk (the newest first) loaded earlier as the feed does: joined at the seam, put in front, the seam adopted. */
  function loadedEarlier(live: readonly string[], chunks: readonly (readonly string[])[]): { parser: TranscriptParser; builder: ChatTimelineBuilder } {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    builder.apply(parser.parseText(live.join("\n")));
    let opening = parser.seamOpening;
    const seams = [];
    for (const chunk of chunks) {
      const olderParser = new TranscriptParser("claude");
      const older = new ChatTimelineBuilder();
      older.apply(olderParser.parseText(chunk.join("\n")));
      const joined = TranscriptParser.seam(olderParser, opening);
      older.apply(joined.finished);
      builder.prepend(older);
      opening = joined.opening;
      seams.push({ ...joined, opening });
    }
    for (const seam of seams) parser.adopt(seam);
    return { parser, builder };
  }

  it("live in B, Load earlier brings A then B, a line naming A again: B's work keeps running", () => {
    const earlier = [inSession(typed("An old question", "a1", 0), sessionA), inSession(reply("An old answer.", "a2", 1, true), sessionA), inSession(typed("Start the server", "b1", 20), sessionB)];
    const { parser, builder } = loadedEarlier(liveB, [earlier]);
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["toolu_bg"]);
    builder.apply(parser.parse(named(sessionA, 90)).events);
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["toolu_bg"]);
    // A session no line named before is a new one: what ran is over.
    builder.apply(parser.parse(named(sessionC, 91)).events);
    expect(runningWork(builder.timeline)).toEqual([]);
  });

  it("over two Load earlier chunks: A in the earlier one, B in the later one", () => {
    const chunkB = [inSession(typed("Start the server", "b1", 20), sessionB)];
    const chunkA = [inSession(typed("An old question", "a1", 0), sessionA), inSession(reply("An old answer.", "a2", 1, true), sessionA)];
    const { parser, builder } = loadedEarlier(liveB, [chunkB, chunkA]);
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["toolu_bg"]);
    builder.apply(parser.parse(named(sessionA, 90)).events);
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["toolu_bg"]);
  });

  it("earlier session ids remembered after adopting a seam", () => {
    const older = new TranscriptParser("claude");
    const newer = new TranscriptParser("claude");
    older.parse(inSession(typed("old", "uold", 0), "old-session"));
    older.parse(inSession(typed("new", "unew", 1), "new-session"));
    const builder = new ChatTimelineBuilder();
    builder.apply(newer.parseText([backgroundBash("bg", "server", "server", "a", 2), shellLaunched("bg", "task", "r", 3)].map((line) => inSession(line, "new-session")).join("\n")));
    newer.adopt(TranscriptParser.seam(older, newer.seamOpening));
    builder.apply(newer.parse(named("old-session", 9)).events);
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["bg"]);
  });
});

describe("running work is oldest first by its start", () => {
  const ids = (builder: ChatTimelineBuilder): string[] => runningWork(builder.timeline).map((work) => work.id);
  const started = (builder: ChatTimelineBuilder, id: string, name: string, time: number | null): void => {
    const input = name === "Agent" ? { description: id, prompt: "Look." } : { command: `run ${id}`, run_in_background: true };
    builder.apply([{ type: "toolStarted", call: claudeToolCall(id, name, input, time) }]);
  };

  it("agent A, a shell, agent B interleaved show A, the shell, B", () => {
    const builder = new ChatTimelineBuilder();
    started(builder, "a1", "Agent", 1_000);
    started(builder, "sh", "Bash", 2_000);
    started(builder, "a2", "Agent", 3_000);
    expect(ids(builder)).toEqual(["a1", "sh", "a2"]);
  });

  it("from the transcript: two background agents and a shell between them", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    builder.apply(
      parser.parseText(
        [
          typed("Check the layout, start the server, then check the banner", "u0", 0),
          agentCall("toolu_bga", "Check the phone layout", "Open the phone layout.", "a1", 1, true),
          agentLaunched("toolu_bga", backgroundAgentID, "r1", 1),
          backgroundBash("toolu_sh", "npm run dev -- --port 5173", "Start the dev server", "a2", 2),
          shellLaunched("toolu_sh", "b7k2q9", "r2", 2),
          agentCall("toolu_bgb", "Check the banner", "Open the banner.", "a3", 3, true),
          agentLaunched("toolu_bgb", "0f1e2d3c4b5a6978", "r3", 3),
        ].join("\n"),
      ),
    );
    expect(ids(builder)).toEqual(["toolu_bga", "toolu_sh", "toolu_bgb"]);
  });

  it("past a trim: an agent let go, a shell let go and one held keep their start order", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder(2, 4);
    const reads = Array.from({ length: 300 }, (_, n) => {
      const id = `toolu_r${n}`;
      return [assistantTool(id, "Read", { file_path: `/Users/fixture/proj/f${n}.ts` }, `ra${n}`, 10 + n), toolResult(id, "1\u2192x", {}, `rr${n}`, 10 + n)];
    }).flat();
    const lines = [
      typed("Check the layout and start the server", "u0", 0),
      agentCall("toolu_bga", "Check the phone layout", "Open the phone layout.", "a1", 1, true),
      agentLaunched("toolu_bga", backgroundAgentID, "r1", 1),
      backgroundBash("toolu_sh", "npm run dev -- --port 5173", "Start the dev server", "a2", 2),
      shellLaunched("toolu_sh", "b7k2q9", "r2", 2),
      ...reads,
      backgroundBash("toolu_sh2", "npm run test -- --watch", "Watch the tests", "a3", 400),
      shellLaunched("toolu_sh2", "c8l3r0", "r3", 400),
    ];
    for (const line of lines) builder.apply(parser.parse(line).events);
    expect(ids(builder)).toEqual(["toolu_bga", "toolu_sh", "toolu_sh2"]);
  });

  // The order they came in: each call's own, first seen, whatever row shows it.
  it("ties and unknown starts keep the order they came in", () => {
    const builder = new ChatTimelineBuilder();
    started(builder, "unknown", "Bash", null);
    started(builder, "late", "Agent", 2_000);
    started(builder, "early", "Bash", 1_000);
    started(builder, "tie1", "Bash", 5_000);
    started(builder, "tie2", "Agent", 5_000);
    expect(ids(builder)).toEqual(["unknown", "early", "late", "tie1", "tie2"]);
    const none = new ChatTimelineBuilder();
    for (const id of ["x", "y", "z"]) started(none, id, "Bash", null);
    expect(ids(none)).toEqual(["x", "y", "z"]);
  });

  it.each([
    ["one timestamp", 1_000],
    ["no timestamp", null],
  ])("agent A, a shell, agent B with %s show A, the shell, B", (_, time) => {
    const builder = new ChatTimelineBuilder();
    started(builder, "a", "Agent", time);
    started(builder, "shell", "Bash", time);
    started(builder, "b", "Agent", time);
    expect(ids(builder)).toEqual(["a", "shell", "b"]);
  });

  it("tied in the transcript (one second), held and past a trim: A, the shell, B", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder(2, 4);
    const apply = (lines: readonly string[]): void => {
      for (const line of lines) builder.apply(parser.parse(line).events);
    };
    apply([
      typed("Check the layout, start the server, then check the banner", "u0", 0),
      agentCall("toolu_bga", "Check the phone layout", "Open the phone layout.", "a1", 1, true),
      agentLaunched("toolu_bga", backgroundAgentID, "r1", 1),
      backgroundBash("toolu_sh", "npm run dev -- --port 5173", "Start the dev server", "a2", 1),
      shellLaunched("toolu_sh", "b7k2q9", "r2", 1),
      agentCall("toolu_bgb", "Check the banner", "Open the banner.", "a3", 1, true),
      agentLaunched("toolu_bgb", "0f1e2d3c4b5a6978", "r3", 1),
    ]);
    expect(ids(builder)).toEqual(["toolu_bga", "toolu_sh", "toolu_bgb"]);
    apply(
      Array.from({ length: 300 }, (_, n) => {
        const id = `toolu_r${n}`;
        return [assistantTool(id, "Read", { file_path: `/Users/fixture/proj/f${n}.ts` }, `ra${n}`, 10 + n), toolResult(id, "1\u2192x", {}, `rr${n}`, 10 + n)];
      }).flat(),
    );
    expect(ids(builder)).toEqual(["toolu_bga", "toolu_sh", "toolu_bgb"]);
  });

  it("Load earlier puts the older part's work first among ties", () => {
    const older = new ChatTimelineBuilder();
    started(older, "a", "Agent", 1_000);
    started(older, "c", "Agent", 1_000);
    const live = new ChatTimelineBuilder();
    started(live, "shell", "Bash", 1_000);
    started(live, "b", "Agent", 1_000);
    live.prepend(older);
    expect(ids(live)).toEqual(["a", "c", "shell", "b"]);
  });
});

describe("a Bash call moved to the background keeps its description", () => {
  const promoted = (input: { [key: string]: string }) => {
    const builder = new ChatTimelineBuilder();
    builder.apply(
      new TranscriptParser("claude").parseText(
        [typed("Run the full suite", "u1", 0), assistantTool("toolu_fg", "Bash", input, "a1", 1), shellLaunched("toolu_fg", "b0fg11", "r1", 5)].join("\n"),
      ),
    );
    return builder.timeline;
  };

  it("its task's title is the call's description, as run_in_background's is", () => {
    const timeline = promoted({ command: "npm test -- --runInBand\n# the slow one", description: "Run the full test suite" });
    expect(runningWork(timeline).map((work) => [work.id, work.title, work.detail])).toEqual([
      ["toolu_fg", "Run the full test suite", "npm test -- --runInBand\n# the slow one"],
    ]);
  });

  it("a description of several lines gives its first; none (or blank) gives the command's first line", () => {
    expect(runningWork(promoted({ command: "npm test", description: "Run the suite\nall of it" }))[0]?.title).toBe("Run the suite");
    expect(runningWork(promoted({ command: "npm test -- --runInBand\n# the slow one" }))[0]?.title).toBe("npm test -- --runInBand");
    expect(runningWork(promoted({ command: "npm test", description: "  " }))[0]?.title).toBe("npm test");
  });
});
