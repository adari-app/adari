// What the loaded window offers and keeps: every earlier message is reachable,
// a load never stalls on a long line, a load that ends late changes nothing
// once the feed has ended, and the cap never takes what is on show. HerdrKit ChatHistoryWindowTests.swift,
// ported. Fixtures in Claude Code's line shapes, invented content.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed, liveFailureLimit, type ChatFeedUpdate, type TranscriptFileReader } from "../src/shared/chat/feed";
import { maxLineBytes } from "../src/shared/chat/follower";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import { emptyTimeline, timelineItemCount, turnToolCalls, turnUserMessage, userMessage, type ChatTimeline } from "../src/shared/chat/model";
import {
  brief,
  claudeLines,
  claudePath,
  claudeSession,
  eventually,
  FakeTranscriptReader,
  json,
  liveFeed,
  loadAll,
  reply,
  session,
  stamp,
  text,
  user,
} from "./support/chat-lines";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** `count` user lines, `message-0` first. */
function messages(count: number, first = 0, prefix = "message"): string {
  return text(Array.from({ length: count }, (_, n) => `${prefix}-${first + n}`).map((name, n) => user(name, name, (first + n) % 3_000)));
}

const texts = (timeline: ChatTimeline): string[] => timeline.turns.flatMap((turn) => {
  const message = turnUserMessage(turn);
  return message === null ? [] : [message.text];
});

const lastText = (timeline: ChatTimeline): string | undefined => {
  const last = timeline.turns.at(-1);
  return last === undefined ? undefined : turnUserMessage(last)?.text;
};

const firstText = (timeline: ChatTimeline): string | undefined => {
  const first = timeline.turns[0];
  return first === undefined ? undefined : turnUserMessage(first)?.text;
};

const range = (count: number, prefix = "message-"): string[] => Array.from({ length: count }, (_, n) => `${prefix}${n}`);

/** A reader whose reads of earlier messages (any read that ends before the file's end) wait while held, each let go on its own. */
class GateReader implements TranscriptFileReader<TranscriptSessionRef> {
  private bytes: Uint8Array;
  private holding = false;
  private held: (() => void)[] = [];

  constructor(content: string) {
    this.bytes = new TextEncoder().encode(content);
  }

  get waiting(): number {
    return this.held.length;
  }

  hold(hold: boolean): void {
    this.holding = hold;
    if (!hold) {
      const all = this.held;
      this.held = [];
      for (const resume of all) resume();
    }
  }

  releaseOldest(): void {
    this.held.shift()?.();
  }

  replace(content: string): void {
    this.bytes = new TextEncoder().encode(content);
  }

  async locate(): Promise<string | null> {
    return claudePath;
  }

  async size(): Promise<number> {
    return this.bytes.length;
  }

  async read(_path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    if (this.holding && offset + maxBytes < this.bytes.length) await new Promise<void>((resolve) => this.held.push(resolve));
    const start = Math.min(offset, this.bytes.length);
    const end = Math.min(this.bytes.length, offset + maxBytes);
    return this.bytes.slice(start, end);
  }
}

describe("every earlier message is reachable", () => {
  /** A small file of 200, 201, 300, 400 and 401 messages: the newest 200 show; one load shows all of it, in order. */
  it("every count up to the trim offers what is hidden", async () => {
    for (const count of [200, 201, 300, 400, 401]) {
      const feed = await liveFeed(messages(count));
      const first = feed.timeline;
      expect(timelineItemCount(first), `${count}: the newest 200 show`).toBe(200);
      expect(first.earlier, `${count}`).toBe(count > 200 ? "available" : "none");
      await feed.loadEarlier();
      const loaded = feed.timeline;
      expect(timelineItemCount(loaded), `${count}: one load shows the rest`).toBe(count);
      expect(loaded.earlier, `${count}`).toBe("none");
      expect(texts(loaded), `${count}`).toEqual(range(count));
      feed.stop();
    }
  });

  /** Live growth keeps every earlier message reachable; past the trim the hidden part is read from the file again. */
  it("live growth keeps every earlier message reachable", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(200), { reader });
    expect(feed.timeline.earlier).toBe("none");
    reader.append(claudePath, messages(1, 200));
    expect(await eventually(() => lastText(feed.timeline) === "message-200")).toBe(true);
    let timeline = feed.timeline;
    expect(timelineItemCount(timeline)).toBe(200);
    expect(timeline.earlier, "message-0 is hidden").toBe("available");
    await feed.loadEarlier();
    timeline = feed.timeline;
    expect(timelineItemCount(timeline)).toBe(201);
    expect(timeline.earlier).toBe("none");
    reader.append(claudePath, messages(5, 201));
    expect(await eventually(() => lastText(feed.timeline) === "message-205")).toBe(true);
    timeline = feed.timeline;
    expect(timelineItemCount(timeline), "all of it shows, the new ones too").toBe(206);
    expect(timeline.earlier).toBe("none");
    feed.stop();

    const trimmedReader = new FakeTranscriptReader();
    const trimmed = await liveFeed(messages(350), { reader: trimmedReader });
    expect(trimmed.timeline.earlier).toBe("available");
    trimmedReader.append(claudePath, messages(60, 350));
    expect(await eventually(() => lastText(trimmed.timeline) === "message-409")).toBe(true);
    timeline = trimmed.timeline;
    expect(timelineItemCount(timeline)).toBe(200);
    expect(timeline.earlier, "trimmed: the start is read again").toBe("available");
    await loadAll(trimmed);
    timeline = trimmed.timeline;
    expect(texts(timeline)).toEqual(range(410));
    expect(timeline.earlier).toBe("none");
    trimmed.stop();
  });

  /** The builder alone: what it holds beyond what it shows is counted, and showing it all keeps the newest in place. */
  it("the builder shows what it holds on request", () => {
    const builder = new ChatTimelineBuilder(3, 10);
    for (let index = 0; index < 5; index += 1) {
      builder.applyEvent({ type: "userMessage", message: userMessage(`u${index}`, `${index}`, null) });
    }
    expect(timelineItemCount(builder.timeline)).toBe(3);
    expect(builder.hiddenItemCount).toBe(2);
    builder.showHeld();
    expect(builder.hiddenItemCount).toBe(0);
    expect(texts(builder.timeline)).toEqual(["0", "1", "2", "3", "4"]);
    builder.applyEvent({ type: "userMessage", message: userMessage("u5", "5", null) });
    expect(timelineItemCount(builder.timeline), "what arrives shows with it").toBe(6);
  });
});

describe("a long line never traps a load", () => {
  /** An assistant line of 8 MB + 100 characters between two messages: one load reads through it, drops and counts it. */
  it("a line over the bound is read through and dropped", async () => {
    const long = reply("x".repeat(maxLineBytes + 100), "huge", 1);
    const content = text([user("oldest", "old", 0), long, user("newest", "new", 2)]);
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(content, { reader });
    let timeline = feed.timeline;
    expect(texts(timeline)).toEqual(["newest"]);
    expect(timeline.earlier).toBe("available");
    reader.clearCalls();
    await feed.loadEarlier();
    const reads = reader.calls.filter((call) => call.startsWith("read"));
    timeline = feed.timeline;
    expect(texts(timeline)).toEqual(["oldest", "newest"]);
    expect(brief(timeline), "the long line is dropped").toEqual(["user:oldest", "user:newest"]);
    expect(timeline.earlier).toBe("none");
    expect(new Set(reads).size, "no bytes read twice").toBe(reads.length);
    expect(feed.earlierLongLines, "the long line is counted").toBe(1);
    expect(reads.length).toBeLessThanOrEqual(Math.floor((utf8Length(long) + 200) / (512 * 1_024)) + 2);
    feed.stop();
  }, 30_000);

  /** A line just under the bound that a load's four steps do not reach the start of: the load reads on to its start. */
  it("a line longer than a load is read to its start", async () => {
    const base = utf8Length(reply("", "big", 1));
    const big = reply("y".repeat(maxLineBytes - 1 - base), "big", 1);
    expect(utf8Length(big)).toBe(maxLineBytes - 1);
    const content = text([user("oldest", "old", 0), big, user("newest", "new", 2)]);
    const feed = await liveFeed(content);
    await feed.loadEarlier();
    const timeline = feed.timeline;
    expect(brief(timeline)).toEqual(["user:oldest", "agent:yyyy", "user:newest"]);
    expect(timeline.earlier).toBe("none");
    feed.stop();
  }, 30_000);

  /** Two loads in a row never ask for the same reads, with long lines and short ones mixed. */
  it("loads always go on", async () => {
    const lines: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      lines.push(user(`message-${index}`, `m${index}`, index));
      lines.push(reply("z".repeat(3_000_000), `r${index}`, index));
    }
    lines.push(user("newest", "new", 99));
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(text(lines), { reader });
    let previous: string[] = [];
    let loads = 0;
    while (feed.timeline.earlier === "available" && loads < 20) {
      reader.clearCalls();
      await feed.loadEarlier();
      const reads = reader.calls.filter((call) => call.startsWith("read"));
      expect(reads.length).toBeGreaterThan(0);
      expect(
        reads.some((read) => previous.includes(read)),
        `load ${loads} read again what the last one read`,
      ).toBe(false);
      previous = reads;
      loads += 1;
    }
    const timeline = feed.timeline;
    expect(timeline.earlier).toBe("none");
    expect(texts(timeline)).toEqual([...range(6), "newest"]);
    feed.stop();
  }, 30_000);
});

describe("a load that ends late changes nothing", () => {
  /** A read of earlier messages is held; the size polls fail three times, so the feed ends; then the read is let go. */
  it("a late load never revives an ended feed", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(text(claudeLines(1_100, 4_400)), { reader });
    const updates: ChatFeedUpdate[] = [];
    const unsubscribe = feed.subscribe((update) => updates.push(update));
    reader.holdReads(true);
    const loading = feed.loadEarlier();
    expect(await eventually(() => reader.readsWaiting > 0)).toBe(true);
    reader.failNextSizes(liveFailureLimit);
    expect(await eventually(() => feed.state.status === "unavailable" && feed.state.reason === "unreadable")).toBe(true);
    await sleep(50);
    const publishedBefore = updates.length;
    reader.holdReads(false);
    await loading;
    expect(feed.state).toEqual({ status: "unavailable", reason: "unreadable" });
    expect(feed.timeline).toEqual(emptyTimeline);
    await sleep(50);
    expect(updates.length, "nothing published after the end").toBe(publishedBefore);
    expect(updates.at(-1)?.state).toEqual({ status: "unavailable", reason: "unreadable" });
    unsubscribe();
    feed.stop();
  }, 30_000);

  /** A load overtaken by a reload of the file ends late, after a newer load began: it leaves the newer one's Loading. */
  it("a late load leaves a newer load loading", async () => {
    const reader = new GateReader(text(claudeLines(1_100, 4_400)));
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    reader.hold(true);
    const first = feed.loadEarlier();
    expect(await eventually(() => reader.waiting === 1)).toBe(true);
    // The file is replaced by a shorter one: the feed starts over.
    reader.replace(text(claudeLines(600, 4_400)));
    expect(await eventually(() => lastText(feed.timeline) === "message 599" && feed.timeline.earlier === "available")).toBe(true);
    const second = feed.loadEarlier();
    expect(await eventually(() => reader.waiting === 2)).toBe(true);
    expect(feed.timeline.earlier).toBe("loading");
    reader.releaseOldest();
    await first;
    expect(feed.timeline.earlier, "the late load left the newer one loading").toBe("loading");
    reader.hold(false);
    await second;
    const landed = feed.timeline;
    expect(landed.earlier).not.toBe("loading");
    expect(timelineItemCount(landed)).toBeGreaterThan(200);
    feed.stop();
  }, 30_000);
});

describe("the cap never takes what is on show", () => {
  /** The cap is what is held, not what is shown: at the cap an arrival takes the oldest out. */
  it("the cap is what is held", () => {
    const builder = new ChatTimelineBuilder(2, 4);
    for (let index = 0; index < 4; index += 1) builder.applyEvent({ type: "userMessage", message: userMessage(`u${index}`, `${index}`, null) });
    builder.prepend(new ChatTimelineBuilder());
    builder.applyEvent({ type: "userMessage", message: userMessage("u4", "4", null) });
    expect(builder.heldItemCount).toBeLessThanOrEqual(4);
    expect(timelineItemCount(builder.timeline)).toBe(4);
    expect(texts(builder.timeline)).toEqual(["1", "2", "3", "4"]);
    const full = new ChatTimelineBuilder(3, 10);
    for (let index = 0; index < 10; index += 1) full.applyEvent({ type: "userMessage", message: userMessage(`f${index}`, `${index}`, null) });
    full.showHeld();
    for (let index = 10; index < 40; index += 1) {
      full.applyEvent({ type: "userMessage", message: userMessage(`f${index}`, `${index}`, null) });
      expect(full.heldItemCount, "never more than the cap is held").toBeLessThanOrEqual(10);
    }
  });

  /** Reading away from the newest (below the cap): what arrives is added below and the top stays. */
  it("reading away from the newest keeps the top", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(300), { reader });
    const before = feed.timeline;
    expect(timelineItemCount(before)).toBe(200);
    const top = firstText(before);
    expect(top).toBe("message-100");
    feed.setFollowingNewest(false);
    reader.append(claudePath, messages(250, 300));
    expect(await eventually(() => lastText(feed.timeline) === "message-549")).toBe(true);
    const after = feed.timeline;
    expect(firstText(after), "the top stays").toBe(top);
    expect(timelineItemCount(after)).toBe(450);
    expect(after.newerWaiting).toBe(false);
    feed.stop();
  });

  /** At the cap arrivals wait while the user reads (the timeline says so); following again they show and the oldest go. */
  it("at the cap arrivals wait while the user reads and the oldest go when they follow", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(80), { maxItems: 20, historyCap: 50, reader });
    await loadAll(feed);
    const full = feed.timeline;
    expect(timelineItemCount(full)).toBe(50);
    expect(full.earlier).toBe("capped");
    expect(firstText(full)).toBe("message-30");
    feed.setFollowingNewest(false);
    reader.append(claudePath, messages(5, 80));
    expect(await eventually(() => feed.timeline.newerWaiting), "the timeline says newer messages wait").toBe(true);
    await sleep(60);
    const reading = feed.timeline;
    expect(timelineItemCount(reading)).toBe(50);
    expect(firstText(reading), "what the user reads stays").toBe("message-30");
    expect(lastText(reading), "nothing arrived").toBe("message-79");
    feed.setFollowingNewest(true);
    expect(await eventually(() => lastText(feed.timeline) === "message-84")).toBe(true);
    const following = feed.timeline;
    expect(timelineItemCount(following)).toBe(50);
    expect(firstText(following), "the oldest five went").toBe("message-35");
    expect(following.newerWaiting).toBe(false);
    expect(following.earlier).toBe("capped");
    feed.stop();
  });

  /** One line that brings several items when only one more fits: it waits whole. */
  it("a line that would cross the cap waits whole", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(80), { maxItems: 20, historyCap: 50, reader });
    await loadAll(feed);
    feed.setFollowingNewest(false);
    const three = json({
      isSidechain: false,
      sessionId: session,
      timestamp: stamp(90),
      type: "assistant",
      uuid: "multi",
      message: {
        content: [
          { text: "one", type: "text" },
          { id: "toolu_a", input: { command: "ls" }, name: "Bash", type: "tool_use" },
          { id: "toolu_b", input: { command: "pwd" }, name: "Bash", type: "tool_use" },
        ],
        id: "msg_multi",
        role: "assistant",
        stop_reason: "tool_use",
        type: "message",
      },
    });
    reader.append(claudePath, three + "\n");
    expect(await eventually(() => feed.timeline.newerWaiting)).toBe(true);
    const reading = feed.timeline;
    expect(timelineItemCount(reading)).toBe(50);
    expect(firstText(reading)).toBe("message-30");
    expect(reading.turns.flatMap(turnToolCalls).length).toBe(0);
    feed.setFollowingNewest(true);
    expect(await eventually(() => feed.timeline.turns.flatMap(turnToolCalls).length === 2)).toBe(true);
    expect(timelineItemCount(feed.timeline)).toBe(50);
    feed.stop();
  });
});
