// A pane switch shows its Chat at once. Following HerdrKit's
// ChatFeedColdLoadTests.swift: a cold first load reads backwards from
// the end only until it holds a screenful of turns plus one (`ChatColdLoad`);
// a feed not on show is paused, not stopped, and reads on from its offset at
// once when shown again. Lines built by hand (never read from a real
// transcript); the paced reader models SFTP over a real link (25 ms round trips, 256 KB chunks,
// 8 in flight, 80 MB/s).

import { describe, expect, it } from "vitest";

import { ChatFeed, standardColdLoad, type TranscriptFileReader } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import type { ChatTimeline } from "../src/shared/chat/model";
import { claudePath, claudeSession, eventually as eventuallyIn, FakeTranscriptReader } from "./support/chat-lines";

const eventually = (condition: () => boolean | Promise<boolean>, seconds = 5): Promise<boolean> => eventuallyIn(condition, seconds * 1_000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// MARK: lines (Claude Code 2.1.316 shapes, built by hand)

const opening =
  '{"isSidechain":false,"message":{"content":"hi","role":"user"},"sessionId":"s","timestamp":"2026-11-02T20:50:00.000Z","type":"user","uuid":"u0","cwd":"/Users/fixture/proj"}\n' +
  '{"isSidechain":false,"message":{"content":[{"text":"Ready.","type":"text"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-02T20:50:01.000Z","type":"assistant","uuid":"a0"}\n';

/** A text turn: the user's message, then a reply of `length` characters. */
function turn(index: number, length = 30_000): string {
  const words = "the feed reads on at once ".repeat(Math.ceil(length / 26)).slice(0, length);
  return (
    `{"isSidechain":false,"message":{"content":"question ${index}","role":"user"},"sessionId":"s","timestamp":"2026-11-02T20:00:00.000Z","type":"user","uuid":"u${index}","cwd":"/Users/fixture/proj"}\n` +
    `{"isSidechain":false,"message":{"content":[{"text":"answer ${index}: ${words}","type":"text"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-02T20:00:01.000Z","type":"assistant","uuid":"a${index}"}\n`
  );
}

function turns(from: number, to: number, length = 30_000): string {
  let all = "";
  for (let index = from; index < to; index += 1) all += turn(index, length);
  return all;
}

/** A base64 payload of `length` characters (the alphabet only, as a PNG's). */
function payload(length: number): string {
  const unit = "iVBORw0KGgoAAAANSUhEUgAAB4AAAAQ4CAIAAABnsVYUAAAgAElEQVR4nOzdd3hTVf/A8U/S";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function screenshot(index: number, length: number): string {
  return `{"isSidechain":false,"message":{"content":[{"text":"see the difference ${index}","type":"text"},{"source":{"data":"${payload(length)}","media_type":"image/png","type":"base64"},"type":"image"}],"role":"user"},"sessionId":"s","timestamp":"2026-11-02T20:51:0${index % 10}.000Z","type":"user","uuid":"shot-${index}"}`;
}

function imageRead(index: number, length: number): string {
  const half = payload(Math.floor(length / 2));
  return `{"isSidechain":false,"message":{"content":[{"content":[{"source":{"data":"${half}","media_type":"image/png","type":"base64"},"type":"image"}],"tool_use_id":"toolu_read${index}","type":"tool_result"}],"role":"user"},"sessionId":"s","timestamp":"2026-11-02T20:51:1${index % 10}.000Z","toolUseResult":{"file":{"base64":"${half}","originalSize":${length},"type":"image/png"},"type":"image"},"type":"user","uuid":"read-${index}"}`;
}

function blob(index: number, length: number): string {
  return `{"body":{"messages":[{"content":[{"text":"see the difference","type":"text"},{"source":{"data":"${payload(length)}","media_type":"image/png","type":"base64"},"type":"image"}],"role":"user"}],"model":"claude-opus-5-5"},"requestId":"req_${index}","sessionId":"s","timestamp":"2026-11-02T20:51:2${index % 10}.000Z","type":"api-request-blob","uuid":"blob-${index}"}`;
}

/** `count` lines of 1.2 MB (ten are 12 MB): screenshots, blobs and image reads in turn; the last a screenshot. */
function burst(count: number): string {
  const size = 1_200_000;
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = (index + 10 - count) % 10;
    if (kind === 0 || kind === 3 || kind === 6 || kind === 9) lines.push(screenshot(index, size));
    else if (kind === 1 || kind === 4 || kind === 7) lines.push(blob(index, size));
    else lines.push(imageRead(index, size));
  }
  return lines.join("\n") + "\n";
}

function reply(text: string): string {
  return `{"isSidechain":false,"message":{"content":[{"text":"${text}","type":"text"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-02T20:52:00.000Z","type":"assistant","uuid":"a-${text.length}"}\n`;
}

function lastAgentText(timeline: ChatTimeline): string | null {
  const item = timeline.turns.at(-1)?.items.at(-1);
  return item?.type === "agentText" ? item.value.markdown : null;
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

// MARK: a reader paced as SFTP over a real link

class PacedTranscriptReader implements TranscriptFileReader<TranscriptSessionRef> {
  static readonly roundTripMs = 25;
  static readonly chunk = 256 * 1_024;
  static readonly inFlight = 8;
  static readonly bytesPerMs = (80 * 1_024 * 1_024) / 1_000;

  private file: Uint8Array;
  readonly log: { call: string; at: number }[] = [];

  constructor(private readonly path: string, text: string) {
    this.file = new TextEncoder().encode(text);
  }

  append(text: string): void {
    const more = new TextEncoder().encode(text);
    const next = new Uint8Array(this.file.length + more.length);
    next.set(this.file, 0);
    next.set(more, this.file.length);
    this.file = next;
  }

  async locate(): Promise<string | null> {
    return this.path;
  }

  async size(): Promise<number> {
    await sleep(PacedTranscriptReader.roundTripMs);
    this.log.push({ call: "size", at: Date.now() });
    return this.file.length;
  }

  async read(_path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    const bytes = this.file.slice(Math.min(offset, this.file.length), Math.min(this.file.length, offset + maxBytes));
    const chunks = Math.max(1, Math.ceil(bytes.length / PacedTranscriptReader.chunk));
    const batches = Math.ceil(chunks / PacedTranscriptReader.inFlight);
    await sleep(PacedTranscriptReader.roundTripMs * (2 + batches) + bytes.length / PacedTranscriptReader.bytesPerMs);
    this.log.push({ call: `read ${offset} ${bytes.length}`, at: Date.now() });
    return bytes;
  }
}

function fake(text: string): FakeTranscriptReader {
  const reader = new FakeTranscriptReader();
  reader.put(claudePath, text, claudePath);
  return reader;
}

const reads = (reader: FakeTranscriptReader): string[] => reader.calls.filter((call) => call.startsWith("read"));

// MARK: the cold read

describe("ChatFeed: a cold first load", () => {
  it("reads only the end of a long chat: one 512 KB read holds more than a screenful", async () => {
    // A screenful is four turns or 20 items, read back in 1 to 4 MB reads, every byte once.
    expect(standardColdLoad).toEqual({
      window: 512 * 1_024,
      turns: 4,
      items: 20,
      chunkBytes: 2 * 1_024 * 1_024,
      readBytes: [1_024 * 1_024, 4 * 1_024 * 1_024],
      readsOnce: true,
    });
    const text = turns(0, 200);
    expect(bytes(text)).toBeGreaterThan(6_000_000);
    const reader = fake(text);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    expect(feed.bytesRead, `${feed.bytesRead} bytes read`).toBeLessThanOrEqual(standardColdLoad.window);
    expect(feed.timeline.turns.length).toBeGreaterThanOrEqual(standardColdLoad.turns);
    expect(lastAgentText(feed.timeline)?.startsWith("answer 199:")).toBe(true);
    expect(feed.timeline.earlier).toBe("available");
    expect(reads(reader)).toHaveLength(1);
    feed.stop();
  });

  it("reads earlier only until it holds a screenful of turns plus one; Load earlier goes on as before", async () => {
    const text = turns(0, 60, 400_000);
    expect(bytes(text)).toBeGreaterThan(24_000_000);
    const reader = fake(text);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    const timeline = feed.timeline;
    expect(timeline.turns.length).toBeGreaterThanOrEqual(4);
    expect(timeline.turns.length, "a few turns, not the window's worth").toBeLessThanOrEqual(8);
    // The first window and one 2 MB read earlier; the old first load read 4 MB.
    expect(feed.bytesRead, `${feed.bytesRead} bytes of ${bytes(text)} read`).toBeLessThan(3 * 1_024 * 1_024);
    expect(timeline.earlier).toBe("available");
    await feed.loadEarlier();
    expect(feed.timeline.turns.length).toBeGreaterThan(timeline.turns.length);
    feed.stop();
  });

  it("shows a cold pane's last reply after 12 MB of image lines within 1.5 s, over the paced link", async () => {
    const text = turns(0, 40, 50_000) + burst(10) + reply("The last reply.");
    const reader = new PacedTranscriptReader(claudePath, text);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    const start = Date.now();
    feed.start(claudeSession);
    const shown = await eventually(() => lastAgentText(feed.timeline) === "The last reply.", 6);
    const took = (Date.now() - start) / 1_000;
    expect(shown).toBe(true);
    console.log(`cold load (desktop): a cold pane's last reply on show ${took} s after the start`);
    expect(took, `the last reply on show ${took} s after the start`).toBeLessThanOrEqual(1.5);
    const loaded = await feed.loaded();
    const loadedAt = (Date.now() - start) / 1_000;
    console.log(`cold load (desktop): a cold pane's screenful (${feed.timeline.turns.length} turns) in ${loadedAt} s`);
    expect(loaded).toBe(true);
    expect(feed.timeline.turns.length).toBeGreaterThanOrEqual(4);
    feed.stop();
  });

  it("reads a short chat whole in one read: nothing earlier", async () => {
    const text = turns(0, 3, 200);
    const reader = fake(text);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    expect(feed.timeline.turns).toHaveLength(3);
    expect(feed.timeline.earlier).toBe("none");
    expect(reads(reader)).toHaveLength(1);
    expect(reads(reader)[0]!.startsWith("read 0 ")).toBe(true);
    feed.stop();
  });

  it("says not loaded for a chat that ends, and for one never started", async () => {
    const reader = new FakeTranscriptReader();
    reader.setLocated(null);
    const feed = new ChatFeed(reader, { cold: standardColdLoad, pollIntervalMs: 5 });
    expect(await feed.loaded(), "not started").toBe(false);
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(false);
    expect(feed.state).toEqual({ status: "unavailable", reason: "notFound" });
  });

  it("keeps the old 4 MB first load when no cold load is asked for", async () => {
    const reader = fake(turns(0, 200));
    const feed = new ChatFeed(reader);
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    expect(feed.bytesRead).toBe(4 * 1_024 * 1_024);
    feed.stop();
  });
});

// MARK: paused while not on show

describe("ChatFeed: paused while not on show", () => {
  it("reads nothing while paused, then reads on from its offset at once (not at the next poll)", async () => {
    const text = turns(0, 3, 200);
    const reader = fake(text);
    const feed = new ChatFeed(reader, { cold: standardColdLoad, pollIntervalMs: 1_000 });
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    feed.pause();
    expect(feed.isPaused).toBe(true);
    // Past the poll it was waiting in: still nothing asked.
    await sleep(1_100);
    reader.clearCalls();
    const held = feed.timeline;
    reader.append(claudePath, reply("Written while away."));
    await sleep(1_100);
    expect(reader.calls, "nothing read while paused").toEqual([]);
    expect(feed.timeline).toBe(held);
    expect(feed.state.status).toBe("live");
    const resumed = Date.now();
    feed.resume();
    expect(feed.isPaused).toBe(false);
    expect(await eventually(() => lastAgentText(feed.timeline) === "Written while away.", 2)).toBe(true);
    expect(Date.now() - resumed, "at once, not at the next poll").toBeLessThan(500);
    expect(reads(reader)[0]?.startsWith(`read ${bytes(text)} `), `from the offset: ${reads(reader).join(", ")}`).toBe(true);
    feed.stop();
  });

  it("catches up a 12 MB burst written while paused within 2 s of the resume", async () => {
    const reader = new PacedTranscriptReader(claudePath, opening);
    const feed = new ChatFeed(reader, { cold: standardColdLoad }); // the real 1 s poll
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    feed.pause();
    await sleep(1_100);
    const quiet = reader.log.length;
    reader.append(burst(10) + reply("Caught up after the switch."));
    // Longer than a poll: a feed still reading would have read the burst by now.
    await sleep(1_200);
    expect(reader.log.length, "paused: no reads").toBe(quiet);
    expect(lastAgentText(feed.timeline)).toBe("Ready.");
    const resumed = Date.now();
    feed.resume();
    const shown = await eventually(() => lastAgentText(feed.timeline) === "Caught up after the switch.", 6);
    const took = (Date.now() - resumed) / 1_000;
    expect(shown).toBe(true);
    console.log(`cold load (desktop): resumed, the burst caught up in ${took} s`);
    expect(took).toBeLessThanOrEqual(2);
    const first = reader.log.slice(quiet).find((entry) => entry.call.startsWith("read"));
    expect(first?.call.startsWith(`read ${bytes(opening)} `), first?.call ?? "none").toBe(true);
    feed.stop();
  });

  it("stops at once while paused", async () => {
    const reader = fake(turns(0, 3, 200));
    const feed = new ChatFeed(reader, { cold: standardColdLoad, pollIntervalMs: 5 });
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    feed.pause();
    await sleep(30);
    reader.clearCalls();
    const stopping = Date.now();
    feed.stop();
    expect(Date.now() - stopping).toBeLessThan(200);
    expect(feed.state).toEqual({ status: "idle" });
    await sleep(50);
    expect(reader.calls).toEqual([]);
    feed.resume();
    await sleep(30);
    expect(reader.calls, "a stopped feed reads nothing on a resume").toEqual([]);
  });
});

describe("a cold load never shows an empty Chat before an unfinished line", () => {
  // A question and its reply, then a 700 KB blob line still being written. The cold window
  // (512 KB) starts inside it and holds no line break: the completed turn still shows (its start found reading
  // back, the unfinished line not parsed), and once the line is whole what follows reads on.
  it("keeps the completed turns before a long unfinished line", async () => {
    const reader = new FakeTranscriptReader();
    const unfinished = '{"type":"api-request-blob","requestId":"req_1","blob":"' + "A".repeat(700_000);
    reader.put(claudePath, turn(1, 40) + unfinished, claudePath);
    const feed = new ChatFeed(reader, { cold: standardColdLoad, pollIntervalMs: 50 });
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    expect(feed.timeline.turns, "the completed turn before the unfinished line").toHaveLength(1);
    expect(lastAgentText(feed.timeline)?.startsWith("answer 1:")).toBe(true);
    expect(feed.parseStats.malformed, "the unfinished line is never parsed").toBe(0);
    reader.append(claudePath, '"}\n' + turn(2, 40));
    expect(await eventually(() => lastAgentText(feed.timeline)?.startsWith("answer 2:") === true)).toBe(true);
    expect(feed.timeline.turns).toHaveLength(2);
    feed.stop();
  });

  it("shows the user's unfinished screenshot once its line is whole (not lost because the window started inside it)", async () => {
    const reader = new FakeTranscriptReader();
    const shot = new TextEncoder().encode(screenshot(1, 900_000));
    const cut = shot.length - 100;
    reader.put(claudePath, turn(1, 40), claudePath);
    reader.appendBytes(claudePath, shot.slice(0, cut));
    const feed = new ChatFeed(reader, { cold: standardColdLoad, pollIntervalMs: 50 });
    feed.start(claudeSession);
    await feed.loaded();
    expect(lastAgentText(feed.timeline)?.startsWith("answer 1:")).toBe(true);
    reader.appendBytes(claudePath, shot.slice(cut));
    reader.append(claudePath, "\n");
    expect(await eventually(() => feed.timeline.turns.at(-1)?.items[0]?.type === "user" && feed.timeline.turns.length === 2)).toBe(true);
    const message = feed.timeline.turns.at(-1)!.items[0]!;
    expect(message.type === "user" ? message.value.attachments.length : 0, "the user's screenshot is an image").toBe(1);
    feed.stop();
  });
});
