// The whole conversation: the transcript read backwards from the loaded part's
// first line in bounded chunks, whole lines only, parsed with the same parsers
// and put in front; at most the history cap held. HerdrKit
// ChatEarlierHistoryTests.swift, ported.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed } from "../src/shared/chat/feed";
import { maxLineBytes, TranscriptEarlierReader, TranscriptFollower, type TranscriptLine } from "../src/shared/chat/follower";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import { timelineItemCount, turnToolCalls, turnUserMessage, userMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import {
  claudeLines,
  claudePath,
  claudeSession,
  codexFixture,
  codexPath,
  eventually,
  FakeTranscriptReader,
  otherSession,
  shape,
  text,
  whole,
} from "./support/chat-lines";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const ids = (timeline: ChatTimeline): string[] => timeline.turns.flatMap((turn) => turn.items.map((item) => item.value.id));
const calls = (timeline: ChatTimeline) => timeline.turns.flatMap(turnToolCalls);

describe("the backwards reader", () => {
  /** Every chunk size, from one byte up, gives back exactly the lines after the start offset, with their offsets. */
  it("chunk boundaries mid-line never split or drop a line", () => {
    const content = '{"a":1}\n\n{"b":"twø"}\r\n{"c":"' + "x".repeat(40) + '"}\n{"d":4}\n';
    const bytes = encode(content);
    const expected: TranscriptLine[] = [];
    let start = 0;
    bytes.forEach((byte, index) => {
      if (byte !== 0x0a) return;
      let line = bytes.slice(start, index);
      if (line.at(-1) === 0x0d) line = line.slice(0, -1);
      const string = new TextDecoder().decode(line);
      if (string.length > 0) expected.push({ text: string, offset: start });
      start = index + 1;
    });
    for (let chunk = 1; chunk <= bytes.length + 3; chunk += 1) {
      for (const end of [bytes.length, expected[3]!.offset]) {
        const reader = new TranscriptEarlierReader(end, chunk);
        let lines: TranscriptLine[] = [];
        for (let read = reader.nextRead(); read !== null; read = reader.nextRead()) {
          const got = reader.consume(read.offset, bytes.slice(read.offset, read.offset + read.maxBytes));
          expect(got, `chunk ${chunk}`).not.toBeNull();
          lines = [...got!, ...lines];
        }
        expect(reader.reachedStart).toBe(true);
        expect(lines, `chunk ${chunk} end ${end}`).toEqual(expected.filter((line) => line.offset < end));
      }
    }
  });

  /** Each step's `end` is a line start; a read that came back short is refused without moving anything. */
  it("end is always a line start and a short read is refused", () => {
    const bytes = encode("first line\nsecond line\nthird\n");
    const reader = new TranscriptEarlierReader(bytes.length, 8);
    const read = reader.nextRead()!;
    expect(read).toEqual({ offset: bytes.length - 8, maxBytes: 8 });
    expect(reader.consume(read.offset, bytes.slice(read.offset, read.offset + 5))).toBeNull();
    expect(reader.end).toBe(bytes.length);
    const again = reader.nextRead()!;
    const lines = reader.consume(again.offset, bytes.slice(again.offset));
    expect(lines).toEqual([{ text: "third", offset: 23 }]);
    expect(reader.end).toBe(23);
  });

  /** A line longer than the follower's limit is dropped and counted; the lines around it come out whole. */
  it("an oversized line is dropped and its neighbours kept", () => {
    const long = '{"big":"' + "y".repeat(maxLineBytes + 10) + '"}';
    const bytes = encode('{"a":1}\n' + long + '\n{"z":2}\n');
    const reader = new TranscriptEarlierReader(bytes.length, 1_024 * 1_024);
    let lines: TranscriptLine[] = [];
    let reads = 0;
    for (let read = reader.nextRead(); read !== null; read = reader.nextRead()) {
      reads += 1;
      lines = [...reader.consume(read.offset, bytes.subarray(read.offset, read.offset + read.maxBytes))!, ...lines];
    }
    expect(lines.map((line) => line.text)).toEqual(['{"a":1}', '{"z":2}']);
    expect(lines.map((line) => line.offset)).toEqual([0, bytes.length - 8]);
    expect(reader.oversizedLines).toBe(1);
    expect(reads).toBeGreaterThan(8);
  });

  /** The follower says where its loaded window's first whole line starts, and each line's offset. */
  it("the follower knows where its window starts", () => {
    const follower = new TranscriptFollower();
    const lines = claudeLines(2_000, 2_000);
    const bytes = encode(text(lines));
    const request = follower.nextRead(bytes.length)!;
    expect(request.offset).toBeGreaterThan(0);
    const got = follower.consumeLines(request.offset, bytes.slice(request.offset));
    const start = follower.windowStart;
    expect(start).not.toBeNull();
    expect(got[0]?.offset).toBe(start);
    expect(bytes[start! - 1]).toBe(0x0a);
    for (const line of got.slice(0, 50)) {
      expect(new TextDecoder().decode(bytes.slice(line.offset, line.offset + encode(line.text).length))).toBe(line.text);
    }
    const small = new TranscriptFollower();
    const all = small.nextRead(100)!;
    small.consumeLines(all.offset, encode(text(lines.slice(0, 1))).slice(0, 100));
    expect(small.windowStart).toBe(0);
  });
});

describe("the builder", () => {
  /**
   * The turn that ran across the seam is one turn under the newer id, a call whose
   * result the newer part read is finished, nothing shows twice, the newer title
   * wins, held ids stay, and the limit grows.
   */
  it("prepend joins the seam, finishes calls and keeps held ids", () => {
    const lines = claudeLines(3);
    // The newer part starts mid-turn 1, between the call and its result.
    const split = 2 + 5; // turn 0 whole, then turn 1's message and reply
    const newerParser = new TranscriptParser("claude");
    const newer = new ChatTimelineBuilder();
    lines.forEach((line, index) => {
      if (index >= split + 1) newer.apply(newerParser.parse(line).events, index);
    });
    newer.apply([{ type: "title", value: "newer title" }]);
    expect(newer.timeline.turns[0]!.isPartial).toBe(true);
    const heldIDs = ids(newer.timeline);
    const heldTurnIDs = newer.timeline.turns.map((turn) => turn.id);
    const olderParser = new TranscriptParser("claude");
    const older = new ChatTimelineBuilder(2_000);
    lines.forEach((line, index) => {
      if (index < split + 1) older.apply(olderParser.parse(line).events, index);
    });
    older.apply([{ type: "title", value: "older title" }]);
    const result = newer.prepend(older);
    expect(result.droppedForCap).toBe(0);
    expect(result.start).toBeNull();
    expect(shape(newer.timeline)).toEqual(shape(whole(text(lines))));
    expect(calls(newer.timeline).every((call) => call.state === "ok")).toBe(true);
    expect(newer.timeline.title).toBe("newer title");
    expect(ids(newer.timeline).slice(-heldIDs.length)).toEqual(heldIDs);
    expect(newer.timeline.turns.map((turn) => turn.id).slice(-heldTurnIDs.length)).toEqual(heldTurnIDs);
    expect(newer.timeline.turns[0]!.isPartial).toBe(false);
    // Items arriving now are shown too: the limit grows with them.
    const before = timelineItemCount(newer.timeline);
    newer.apply([{ type: "userMessage", message: userMessage("new", "more", null) }]);
    expect(timelineItemCount(newer.timeline)).toBe(before + 1);
  });

  /** Past the cap the oldest of the earlier part stay out; the newest are never dropped for it. */
  it("the cap drops the oldest of the earlier part", () => {
    const lines = claudeLines(40);
    const newer = new ChatTimelineBuilder(20, 50);
    const newerParser = new TranscriptParser("claude");
    lines.forEach((line, index) => {
      if (index >= 150) newer.apply(newerParser.parse(line).events, index);
    });
    const newest = ids(newer.timeline);
    const older = new ChatTimelineBuilder(50, 50);
    const olderParser = new TranscriptParser("claude");
    lines.forEach((line, index) => {
      if (index < 150) older.apply(olderParser.parse(line).events, index);
    });
    const result = newer.prepend(older);
    expect(result.droppedForCap).toBeGreaterThan(0);
    expect(timelineItemCount(newer.timeline)).toBe(50);
    expect(newer.isAtHistoryCap).toBe(true);
    expect(ids(newer.timeline).slice(-newest.length)).toEqual(newest);
    const wholeIDs = ids(whole(text(lines)));
    expect(ids(newer.timeline)).toEqual(wholeIDs.slice(-50));
    expect(result.start).not.toBeNull();
  });
});

describe("the feed", () => {
  async function liveFeed(
    content: string,
    options: { historyCap?: number; chunk?: number; step?: number } = {},
  ): Promise<{ feed: ChatFeed<TranscriptSessionRef>; reader: FakeTranscriptReader }> {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, content, claudePath);
    const feed = new ChatFeed(reader, {
      pollIntervalMs: 5,
      historyCap: options.historyCap ?? 1_000_000,
      earlierStepBytes: options.step ?? 2 * 1_024 * 1_024,
      earlierChunkBytes: options.chunk ?? 512 * 1_024,
    });
    feed.start(claudeSession);
    await eventually(() => feed.state.status === "live");
    return { feed, reader };
  }

  /**
   * A transcript of about 12 MB: the first load shows its end; each load of earlier
   * messages reads a bounded step backwards; in the end the whole conversation is on
   * show, exactly as one parse of the file, every call finished.
   */
  it("a multi-megabyte transcript loads whole", async () => {
    const content = text(claudeLines(1_100, 4_400));
    expect(encode(content).length).toBeGreaterThan(10_000_000);
    const { feed, reader } = await liveFeed(content);
    let timeline = feed.timeline;
    expect(timeline.earlier).toBe("available");
    expect(timelineItemCount(timeline)).toBe(200);
    let loads = 0;
    while (timeline.earlier === "available" && loads < 20) {
      reader.clearCalls();
      await feed.loadEarlier();
      loads += 1;
      timeline = feed.timeline;
      const reads = reader.calls.filter((call) => call.startsWith("read"));
      for (const call of reads) {
        const maxBytes = Number(call.split(" ").at(-1));
        expect(maxBytes, "each read is a bounded chunk").toBeLessThanOrEqual(512 * 1_024);
      }
      expect(reads.length, "a load reads about one step").toBeLessThanOrEqual(4 * 4);
    }
    expect(timeline.earlier).toBe("none");
    expect(loads).toBeGreaterThanOrEqual(4);
    expect(shape(timeline)).toEqual(shape(whole(content)));
    expect(calls(timeline).every((call) => call.state === "ok")).toBe(true);
    feed.stop();
  }, 60_000);

  /** Chunks far smaller than a line: every boundary falls mid-line, and the result is still exactly the file. */
  it("tiny chunks still give the exact conversation", async () => {
    const content = text(claudeLines(500, 9_000));
    const { feed } = await liveFeed(content, { chunk: 777, step: 64 * 1_024 });
    let timeline = feed.timeline;
    let loads = 0;
    while (timeline.earlier === "available" && loads < 200) {
      await feed.loadEarlier();
      loads += 1;
      timeline = feed.timeline;
    }
    expect(timeline.earlier).toBe("none");
    expect(shape(timeline)).toEqual(shape(whole(content)));
    feed.stop();
  }, 60_000);

  /** The cap: once reached the earlier part says so and offers no more; the newest `historyCap` items are held. */
  it("the cap holds the newest and offers no more", async () => {
    const lines = claudeLines(1_100, 4_400);
    const content = text(lines);
    const { feed, reader } = await liveFeed(content, { historyCap: 700 });
    let timeline = feed.timeline;
    let loads = 0;
    while (timeline.earlier === "available" && loads < 20) {
      await feed.loadEarlier();
      loads += 1;
      timeline = feed.timeline;
    }
    expect(timeline.earlier).toBe("capped");
    expect(timelineItemCount(timeline)).toBe(700);
    const wholeIDs = ids(whole(content));
    expect(ids(timeline)).toEqual(wholeIDs.slice(-700));
    await feed.loadEarlier();
    expect(feed.timeline, "nothing more past the cap").toEqual(timeline);
    reader.append(claudePath, text(claudeLines(1_101).slice(-5)));
    expect(
      await eventually(() => {
        const last = feed.timeline.turns.at(-1);
        return last !== undefined && turnUserMessage(last)?.text === "message 1100";
      }),
    ).toBe(true);
    expect(timelineItemCount(feed.timeline)).toBeLessThanOrEqual(700 + 200);
    feed.stop();
  }, 60_000);

  /** The pane's session changes while earlier messages are read: the load is dropped. */
  it("a session change while loading drops the load", async () => {
    const content = text(claudeLines(1_100, 4_400));
    const { feed, reader } = await liveFeed(content);
    reader.put(codexPath, codexFixture(), null);
    reader.holdReads(true);
    const load = feed.loadEarlier();
    expect(await eventually(() => reader.readsWaiting > 0)).toBe(true);
    expect(feed.timeline.earlier).toBe("loading");
    reader.setLocated(codexPath);
    feed.start(otherSession);
    reader.holdReads(false);
    await load;
    expect(await eventually(() => feed.state.status === "live" && feed.path === codexPath)).toBe(true);
    const timeline = feed.timeline;
    expect(
      ids(timeline).some((id) => id.startsWith("u") && id.length <= 5),
      "no Claude message of the dropped load",
    ).toBe(false);
    expect(timeline.earlier).toBe("none");
    feed.stop();
  }, 60_000);

  /** The file is replaced under a load (it got shorter): the load is dropped and the feed reloads. */
  it("a reload while loading drops the load", async () => {
    const content = text(claudeLines(1_100, 4_400));
    const { feed, reader } = await liveFeed(content);
    reader.holdReads(true);
    const load = feed.loadEarlier();
    await eventually(() => reader.readsWaiting > 0);
    const replaced = text(claudeLines(3));
    reader.put(claudePath, replaced, null);
    reader.holdReads(false);
    await load;
    expect(await eventually(() => timelineItemCount(feed.timeline) === timelineItemCount(whole(replaced)))).toBe(true);
    const timeline = feed.timeline;
    expect(shape(timeline)).toEqual(shape(whole(replaced)));
    expect(timeline.earlier).toBe("none");
    feed.stop();
  }, 60_000);

  /** Codex rollouts load the same way; the session's folder (its first line, out of the first window) is checked when it arrives. */
  it("Codex history loads and its folder is checked", async () => {
    const lines = codexFixture()
      .split("\n")
      .filter((line) => line.length > 0);
    const filler = "lorem ".repeat(2_000);
    let ordinal = 100;
    for (let turn = 0; turn < 600; turn += 1) {
      ordinal += 3;
      lines.push(
        `{"ordinal":${ordinal},"payload":{"turn_id":"t${turn}","type":"task_started"},"timestamp":"2026-11-01T04:00:00.000Z","type":"event_msg"}`,
      );
      lines.push(
        `{"ordinal":${ordinal + 1},"payload":{"content":[{"text":"ask ${turn}","type":"input_text"}],"id":"mu${turn}","role":"user","type":"message"},"timestamp":"2026-11-01T04:00:01.000Z","type":"response_item"}`,
      );
      lines.push(
        `{"ordinal":${ordinal + 2},"payload":{"content":[{"text":"answer ${turn} ${filler}","type":"output_text"}],"id":"ma${turn}","role":"assistant","type":"message"},"timestamp":"2026-11-01T04:00:02.000Z","type":"response_item"}`,
      );
    }
    const content = text(lines);
    const reader = new FakeTranscriptReader();
    reader.put(codexPath, content, codexPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(otherSession, ["/Users/fixture/proj"]);
    await eventually(() => feed.state.status === "live");
    let timeline = feed.timeline;
    for (let n = 0; n < 40 && timeline.earlier === "available"; n += 1) {
      await feed.loadEarlier();
      timeline = feed.timeline;
    }
    expect(shape(timeline)).toEqual(shape(whole(content, "codex")));
    feed.stop();

    // The same file for a pane in another folder: the first window has no folder, the earliest lines do.
    // The rollout's header is read before anything shows, so it is never live: another folder's.
    const other = new ChatFeed(reader, { pollIntervalMs: 5 });
    const states: string[] = [];
    other.subscribe((update) => states.push(update.state.status));
    other.start(otherSession, ["/Users/someone/else"]);
    await eventually(() => other.state.status === "unavailable");
    expect(other.state).toEqual({ status: "unavailable", reason: "codexOtherFolder", folder: "/Users/fixture/proj" });
    expect(other.timeline.turns.length).toBe(0);
    expect(states).not.toContain("live");
    other.stop();
  }, 60_000);
});
