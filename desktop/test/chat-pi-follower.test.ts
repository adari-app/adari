// A Pi or omp session as it grows, and the read bounds on main applied to it (the existing
// follower and readers, no read of its own): a partial last line waits, an oversize line is dropped and
// the next one read, a relay read's omissions are kept (a picture's base64 never fetched to parse),
// a replaced or truncated file starts over, and omp's title line rewritten in place changes nothing.

import { afterEach, describe, expect, it, vi } from "vitest";

import { rebuildOmitted } from "../src/shared/chat/blobs";
import { ChatFeed, standardColdLoad, type TranscriptReadOptions } from "../src/shared/chat/feed";
import { maxLineBytes } from "../src/shared/chat/follower";
import { makeSessionRef } from "../src/shared/chat/locator";
import { turnUserMessage } from "../src/shared/chat/model";
import {
  agentTexts,
  assistant,
  eventually,
  header,
  ompPath,
  ompSession,
  picture,
  piFolder,
  piPath,
  piSession,
  text,
  titleLine,
  user,
} from "./chat-pi-fixtures";
import { FakeTranscriptReader } from "./support/chat-lines";
import { relayOmit, runClock } from "./support/cold-link";

const piRef = makeSessionRef("pi", { kind: "path", path: piPath() })!;

function liveFeed(reader: FakeTranscriptReader, ref = piRef): ChatFeed {
  const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
  feed.start(ref, [piFolder]);
  return feed;
}

describe("pi session: the follower", () => {
  it("shows the reply as the file grows; a partial last line waits for its end", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(piPath(), header() + "\n" + user("Go", 1) + "\n", piPath());
    const feed = liveFeed(reader);
    expect(await eventually(() => feed.state.status === "live" && turnUserMessage(feed.timeline.turns[0]!)?.text === "Go")).toBe(true);
    reader.append(piPath(), assistant([text("First")], "toolUse", 2) + "\n");
    expect(await eventually(() => JSON.stringify(agentTexts(feed.timeline.turns.at(-1))) === '["First"]')).toBe(true);
    const second = new TextEncoder().encode(assistant([text("Second")], "stop", 3));
    const half = Math.floor(second.length / 2);
    reader.appendBytes(piPath(), second.slice(0, half));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(agentTexts(feed.timeline.turns.at(-1))).toEqual(["First"]);
    expect(feed.timeline.turns.at(-1)!.isFinished).toBe(false);
    reader.appendBytes(piPath(), second.slice(half));
    reader.append(piPath(), "\n");
    expect(await eventually(() => JSON.stringify(agentTexts(feed.timeline.turns.at(-1))) === '["First","Second"]')).toBe(true);
    expect(feed.timeline.turns.at(-1)!.isFinished).toBe(true);
    expect(feed.state.status).toBe("live");
    feed.stop();
  });

  it("drops a line over the line bound, counts it, and reads the next one", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(piPath(), header() + "\n" + user("Read the log", 1) + "\n", piPath());
    const feed = liveFeed(reader);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    // A tool result of more than the 8 MiB line bound.
    const huge = JSON.stringify({ type: "message", id: "big", parentId: null, timestamp: "2026-11-09T09:00:02.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x".repeat(maxLineBytes + 1_024) }], isError: false, timestamp: 1 } });
    reader.append(piPath(), huge + "\n" + assistant([text("The log is long.")], "stop", 3) + "\n");
    expect(await eventually(() => agentTexts(feed.timeline.turns.at(-1)).includes("The log is long."), 20_000)).toBe(true);
    expect(feed.state.status).toBe("live");
    expect(JSON.stringify(feed.timeline)).not.toContain("xxxxxxxx");
    feed.stop();
  });

  it("starts over when the file is replaced or truncated (Pi's /new writes a new file; a rewrite is shorter)", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(piPath(), piSession(), piPath());
    const feed = liveFeed(reader);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 6)).toBe(true);
    reader.put(piPath(), header() + "\n" + user("fresh start", 1) + "\n", piPath());
    expect(await eventually(() => feed.timeline.turns.length === 1 && turnUserMessage(feed.timeline.turns[0]!)?.text === "fresh start")).toBe(true);
    reader.put(piPath(), "", piPath());
    expect(await eventually(() => feed.timeline.turns.length === 0)).toBe(true);
    reader.append(piPath(), header() + "\n" + user("again", 1) + "\n");
    expect(await eventually(() => feed.timeline.turns.length === 1 && turnUserMessage(feed.timeline.turns[0]!)?.text === "again")).toBe(true);
    feed.stop();
  });

  it("omp: its title line rewritten in place (the same length) changes nothing; lines after it are read", async () => {
    const reader = new FakeTranscriptReader();
    const ref = makeSessionRef("omp", { kind: "path", path: ompPath() })!;
    const first = ompSession("Rename foo");
    reader.put(ompPath(), first, ompPath());
    const feed = liveFeed(reader, ref);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 2)).toBe(true);
    const before = JSON.stringify(feed.timeline);
    const retitled = titleLine("Rename foo to bar everywhere") + first.slice(first.indexOf("\n"));
    expect(new TextEncoder().encode(retitled).length).toBe(new TextEncoder().encode(first).length);
    reader.put(ompPath(), retitled + user("one more", 20) + "\n", ompPath());
    expect(await eventually(() => feed.timeline.turns.length === 3)).toBe(true);
    expect(turnUserMessage(feed.timeline.turns[2]!)?.text).toBe("one more");
    expect(JSON.stringify(feed.timeline.turns.slice(0, 2))).toBe(JSON.stringify(JSON.parse(before).turns));
    feed.stop();
  });
});

/** A relay that leaves base64 runs of 1,024 bytes or more out of its reads (contract v1.2), as the Mac's SSH reader asks. */
class OmitReader extends FakeTranscriptReader {
  readonly asks: { at: number; max: number; omit: boolean }[] = [];
  async readWithIdentity(path: string, at: number, max: number, options: TranscriptReadOptions = {}) {
    this.asks.push({ at, max, omit: options.omit === true });
    const size = await super.size(path);
    const full = await super.read(path, 0, size);
    const start = options.tail === undefined ? at : Math.max(0, size - options.tail);
    const raw = full.subarray(start, start + max);
    const out = options.omit ? relayOmit(full, start, raw, 1_024) : { kept: raw, omitted: [] as [number, number][] };
    return { size, ino: 77, offset: start, data: rebuildOmitted(start, out.kept, out.omitted)!, omitted: out.omitted };
  }
}

describe("pi session: a relay read's omissions", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the same chat as a plain read, the user's long words put back, the user's picture's base64 never fetched", async () => {
    vi.useFakeTimers();
    const longWords = "question " + "A".repeat(2_000);
    const session =
      [
        header(),
        user([text(longWords), { type: "image", data: picture(200_000), mimeType: "image/png" }], 1),
        assistant([text("answer " + "B".repeat(2_000))], "stop", 2),
      ].join("\n") + "\n";
    const plain = new FakeTranscriptReader();
    const omitting = new OmitReader();
    for (const reader of [plain, omitting]) reader.put(piPath(), session, piPath());
    const feeds = [new ChatFeed(plain, { cold: standardColdLoad }), new ChatFeed(omitting, { cold: standardColdLoad })];
    let done = 0;
    for (const feed of feeds) {
      feed.start(piRef, [piFolder]);
      void feed.loaded().then(() => (done += 1));
    }
    await runClock(() => done === 2, 10_000);
    expect(feeds[1]!.state).toEqual({ status: "live" });
    expect(feeds[1]!.timeline).toEqual(feeds[0]!.timeline);
    const message = turnUserMessage(feeds[1]!.timeline.turns[0]!)!;
    expect(message.text).toBe(longWords);
    expect(message.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(agentTexts(feeds[1]!.timeline.turns[0])).toEqual(["answer " + "B".repeat(2_000)]);
    // Only the words were fetched again (two runs), never the picture's 200 KB.
    const plainReads = omitting.asks.filter((ask) => !ask.omit && ask.max > 0);
    expect(plainReads.length).toBeGreaterThan(0);
    expect(plainReads.every((ask) => ask.max < 10_000)).toBe(true);
    for (const feed of feeds) feed.stop();
  });
});
