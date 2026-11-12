// Chat never falls behind the file. HerdrKit's
// ChatFeedCatchUpTests.swift, ChatFeedCatchUpReadTests.swift and
// ClaudeTranscriptParserScanTests.swift, ported: a burst of 1.2 MB screenshot,
// image-read and api-request-blob lines then a text line, read through a reader
// paced as SFTP reads over a real link; the scan that reads a long line without
// a parse; the SFTP read that keeps several chunk requests in flight.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed, type TranscriptFileReader } from "../src/shared/chat/feed";
import { ClaudeTranscriptParser } from "../src/shared/chat/claude-parser";
import { scanLine } from "../src/shared/chat/line-scan";
import type { ChatTimeline } from "../src/shared/chat/model";
import { skipsUnparsedClaude, TranscriptParser } from "../src/shared/chat/parser";
import { readRange, transcriptReadChunk, transcriptReadDepth } from "../src/main/chat/ssh-reader";
import { claudePath, claudeSession, eventually as eventuallyIn, FakeTranscriptReader } from "./support/chat-lines";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import type { SFTPWrapper } from "ssh2";

const eventually = (condition: () => boolean | Promise<boolean>, seconds = 5): Promise<boolean> => eventuallyIn(condition, seconds * 1_000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// MARK: lines (Claude Code 2.1.316 shapes, built by hand)

const opening =
  '{"isSidechain":false,"message":{"content":"hi","role":"user"},"sessionId":"s","timestamp":"2026-11-02T20:50:00.000Z","type":"user","uuid":"u0","cwd":"/Users/fixture/proj"}\n' +
  '{"isSidechain":false,"message":{"content":[{"text":"Ready.","type":"text"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-02T20:50:01.000Z","type":"assistant","uuid":"a0"}\n';

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

// MARK: a reader paced as SFTP over a real link

/**
 * Each SFTP request is one 25 ms round trip (an iPad or a Mac on a home network, to the Mac over
 * Tailscale); a size is one request; a read is the open, its chunk requests (256 KB each, 8 in flight: one
 * round trip a batch) and the close, plus the bytes at 80 MB/s. Reads see the file as it was when asked.
 */
class PacedTranscriptReader implements TranscriptFileReader<TranscriptSessionRef> {
  static readonly roundTripMs = 25;
  static readonly chunk = 256 * 1_024;
  static readonly inFlight = 8;
  static readonly bytesPerMs = (80 * 1_024 * 1_024) / 1_000;

  private file: Uint8Array;
  readonly log: { call: string; at: number }[] = [];
  sizesAnswered = 0;

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
    this.sizesAnswered += 1;
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

describe("ChatFeed: a burst of image and blob lines", () => {
  it("shows the text line written after 12 MB of them within 2 s, then polls once a second", async () => {
    const reader = new PacedTranscriptReader(claudePath, opening);
    const feed = new ChatFeed(reader); // the real 1 s poll
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live" && lastAgentText(feed.timeline) === "Ready.")).toBe(true);

    // The moment after a poll found nothing new.
    const sizes = reader.sizesAnswered;
    expect(await eventually(() => reader.sizesAnswered > sizes, 3)).toBe(true);
    const lines = burst(10);
    expect(lines.length).toBeGreaterThanOrEqual(12_000_000);
    const written = Date.now();
    reader.append(lines + reply("Both screenshots show Chat behind Terminal."));
    const shown = await eventually(() => lastAgentText(feed.timeline) === "Both screenshots show Chat behind Terminal.", 6);
    const took = (Date.now() - written) / 1_000;
    console.log(`chat-catch-up: the text line on show ${took} s after its write`);
    expect(shown).toBe(true);
    expect(took, `the text line is on show ${took} s after its write`).toBeLessThanOrEqual(2);
    const last = feed.timeline.turns.at(-1)!;
    const opened = last.items[0];
    expect(opened?.type === "user" ? opened.value.attachments.length : -1, "the user's screenshot is still an image").toBe(1);

    // Caught up: one size a second, nothing read.
    const caughtUp = reader.log.length;
    await sleep(2_600);
    const later = reader.log.slice(caughtUp);
    expect(later.some((entry) => entry.call.startsWith("read")), JSON.stringify(later)).toBe(false);
    const polls = later.filter((entry) => entry.call === "size").map((entry) => entry.at);
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls.length).toBeLessThanOrEqual(3);
    for (let index = 1; index < polls.length; index += 1) expect(polls[index]! - polls[index - 1]!).toBeGreaterThan(900);
    feed.stop();
  }, 20_000);

  it("reads on in catch-up windows from the size it found, asking the size again only once read to", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, opening, claudePath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    const start = new TextEncoder().encode(opening).length;
    reader.clearCalls();
    const lines = burst(8) + reply("Done.");
    reader.append(claudePath, lines);
    expect(await eventually(() => lastAgentText(feed.timeline) === "Done.", 3)).toBe(true);
    const window = 4 * 1_024 * 1_024; // catchUpWindow
    const total = new TextEncoder().encode(lines).length;
    expect(reader.calls.filter((call) => call.startsWith("read"))).toEqual([
      `read ${start} ${window}`,
      `read ${start + window} ${window}`,
      `read ${start + 2 * window} ${total - 2 * window}`,
    ]);
    const firstRead = reader.calls.findIndex((call) => call.startsWith("read"));
    expect(reader.calls.slice(firstRead), "one size for the whole catch-up").not.toContain("size");
    feed.stop();
  }, 10_000);
});

describe("a long line costs a scan, not a parse", () => {
  function parsed(line: string, format: "claude" | "codex" = "claude") {
    const parser = new TranscriptParser(format);
    const result = parser.parse(line, 0);
    return { result, stats: parser.stats };
  }

  /** What a parser makes of the line with no scan: the same line under the scan's length. */
  function unscanned(line: string, format: "claude" | "codex" = "claude") {
    const slim = scanLine(line)?.slimmed ?? line;
    const parser = new TranscriptParser(format);
    return parser.parse(slim, 0);
  }

  it("parses a screenshot with its payload cut and shows it the same", () => {
    const line = screenshot(3, 1_200_000);
    const { result, stats } = parsed(line);
    expect(result).toEqual(unscanned(line));
    const event = result.events[0];
    expect(event?.type).toBe("userMessage");
    if (event?.type !== "userMessage") return;
    expect(event.message.text).toBe("see the difference 3");
    expect(event.message.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(stats.scanned).toBe(1);
    expect(stats.parsedChars).toBeLessThan(1_000);
  });

  it("parses an image read with both payloads cut, and it finishes its call", () => {
    const line = imageRead(2, 1_200_000);
    const { result, stats } = parsed(line);
    expect(result.events[0]).toMatchObject({ type: "toolFinished", id: "toolu_read2" });
    expect(scanLine(line)).toMatchObject({ type: "user", cuts: 2 });
    expect(stats.parsedChars).toBeLessThan(1_000);
  });

  it("skips a blob line by its type with no parse", () => {
    const quoted = '{\\"role\\":\\"user\\",\\"content\\":\\"see\\"},'.repeat(40_000);
    for (const line of [blob(1, 1_200_000), `{"type":"api-request-blob","blob":"${quoted}","uuid":"b2"}`]) {
      const { result, stats } = parsed(line);
      expect(result).toEqual({ events: [], outcome: { kind: "skipped", type: "api-request-blob" } });
      expect(stats.scanned).toBe(1);
      expect(stats.parsedChars).toBe(0);
      expect([...stats.skippedTypes]).toEqual([["api-request-blob", 1]]);
    }
  });

  it("skips by the scan what the Claude parser skips", () => {
    const padding = payload(80_000);
    for (const type of ["system", "api-request", "api-request-blob", "queue-operation", "summary", "file-history-snapshot"]) {
      expect(skipsUnparsedClaude(type), type).toBe(true);
      const line = `{"type":"${type}","data":"${padding}","uuid":"x"}`;
      const plain = new TranscriptParser("claude").parse(`{"type":"${type}","uuid":"x"}`, 0);
      expect(parsed(line).result, type).toEqual(plain);
      expect(parsed(line).stats.parsedChars, type).toBe(0);
    }
    for (const type of ["user", "assistant", "attachment", "ai-title", "custom-title"]) expect(skipsUnparsedClaude(type), type).toBe(false);
  });

  it("parses a short line as it is", () => {
    const line = screenshot(1, 2_000);
    const { stats } = parsed(line);
    expect(stats.scanned).toBe(0);
    expect(stats.parsedChars).toBe(line.length);
  });

  it("takes the top level's type, wherever its key is", () => {
    const image = `"source":{"type":"base64","media_type":"image/png","data":"${payload(70_000)}"}`;
    const line = `{"message":{"content":[{"type":"api-request-blob",${image}},{"type":"image",${image}}],"role":"user","type":"x"},"uuid":"u","type":"user"}`;
    expect(scanLine(line)).toMatchObject({ type: "user", cuts: 1 });
  });

  it("never cuts text", () => {
    const words = 'see the \\"difference\\" '.repeat(4_000);
    const word = payload(70_000);
    for (const line of [
      `{"type":"user","message":{"role":"user","content":"${words}"},"uuid":"u1"}`,
      `{"type":"user","message":{"role":"user","content":"${word}"},"uuid":"u2"}`,
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${word}"}]},"uuid":"u3"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Write","input":{"file_path":"/a","content":"${word}"}}]},"uuid":"a1"}`,
    ]) {
      expect(scanLine(line)).toEqual({ type: expect.any(String), slimmed: null, cuts: 0 });
    }
    expect(scanLine(`{"type":"user","data":"${word} ${word}","uuid":"u4"}`)?.cuts).toBe(0);
  });

  // The scan cuts a payload only inside an image's structure (an
  // image block's base64 source, the image read's `toolUseResult.file.base64`, an image block's
  // data URL); the user's text, the agent's and a tool's are the parser's whole, a data URL in it too.
  it("cuts only images, and a scanned line shows what the line parsed whole shows", () => {
    const word = payload(70_000);
    const textual = "data:text/plain;base64," + "A".repeat(70_000);
    const direct = (line: string) => new ClaudeTranscriptParser().parse(line);
    const kept = [
      // The user's message, a string and a text block.
      `{"type":"user","uuid":"u","message":{"role":"user","content":"${textual}"}}`,
      `{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"text","text":"data:image/png;base64,${word}"}]}}`,
      // The agent's text.
      `{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"${textual}"}]}}`,
      // A tool's input and its result.
      `{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__store__put","input":{"url":"${textual}","data":"${word}","base64":"${word}"}}]}}`,
      `{"type":"user","uuid":"r1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"${textual}"}]}}`,
      // Base64 that is not an image's: a document, a text file read.
      `{"type":"user","uuid":"u3","message":{"role":"user","content":[{"type":"text","text":"the manual"},{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"${word}"}}]}}`,
      `{"type":"user","uuid":"r2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"ok"}]},"toolUseResult":{"file":{"base64":"${word}","type":"text/plain"},"type":"text"}}`,
    ];
    for (const line of kept) {
      expect(scanLine(line), line.slice(0, 60)).toEqual({ type: expect.any(String), slimmed: null, cuts: 0 });
      expect(new TranscriptParser("claude").parse(line).events, line.slice(0, 60)).toEqual(direct(line).events);
    }
    // An image's structure is still cut, and shows the same.
    for (const [line, cuts] of [[screenshot(1, 300_000), 1], [imageRead(1, 300_000), 2]] as const) {
      expect(scanLine(line)?.cuts).toBe(cuts);
      const { result, stats } = parsed(line);
      expect(result.events).toEqual(direct(line).events);
      expect(stats.parsedChars).toBeLessThan(1_000);
    }
  });

  it("keeps a Codex data URL's head, so its media type still reads", () => {
    const line = `{"timestamp":"2026-11-02T20:51:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"look"},{"type":"input_image","image_url":"data:image/jpeg;base64,${payload(900_000)}"}]}}`;
    const scan = scanLine(line);
    expect(scan?.cuts).toBe(1);
    expect(scan?.slimmed).toContain('"image_url":"data:image/jpeg;base64,"');
    const { result, stats } = parsed(line, "codex");
    const event = result.events[0];
    expect(event?.type === "userMessage" ? event.message.attachments : null).toEqual([{ path: null, mediaType: "image/jpeg" }]);
    expect(stats.parsedChars).toBeLessThan(1_000);
  });

  it("parses as it is what a scan cannot read as one object", () => {
    const body = payload(70_000);
    for (const line of [
      `{"type":"api-request-blob","data":"${body}"`,
      `{"type":"api-request-blob","data":"${body}"}]`,
      `{"type":"api-request-blob","data":"${body}"} {"a":1}`,
      `["type","api-request-blob","${body}"]`,
    ]) {
      expect(scanLine(line)).toBeNull();
      const { stats } = parsed(line);
      expect(stats.scanned).toBe(0);
      expect(stats.parsedChars).toBe(line.length);
    }
  });

  it("ends a string at its closing quote", () => {
    const line = `{"note":"a \\"quoted\\" word and a slash \\\\","type":"user","x":{"source":{"data":"${payload(70_000)}","type":"base64"},"type":"image"},"tail":"\\\\\\\\"}`;
    expect(scanLine(line)).toEqual({
      type: "user",
      slimmed: '{"note":"a \\"quoted\\" word and a slash \\\\","type":"user","x":{"source":{"data":"","type":"base64"},"type":"image"},"tail":"\\\\\\\\"}',
      cuts: 1,
    });
  });

  it("hands the JSON parser a few kilobytes of the 12 MB burst", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    let offset = 0;
    for (const line of (opening + burst(10) + reply("Seen.")).split("\n")) {
      if (line.length === 0) continue;
      builder.apply(parser.parse(line, offset).events, offset);
      offset += line.length + 1;
    }
    expect(parser.stats.scanned).toBe(10);
    expect(parser.stats.parsedChars).toBeLessThan(64 * 1_024);
    expect(parser.stats.skippedTypes.get("api-request-blob")).toBe(3);
    expect(lastAgentText(builder.timeline)).toBe("Seen.");
  });
});

describe("the SFTP read keeps several chunk requests in flight", () => {
  /** An ssh2 SFTP stand-in: answers after a delay, counts requests in flight, can answer short or fail one. */
  class FlightSftp {
    now = 0;
    most = 0;
    asked: string[] = [];
    closes = 0;
    constructor(
      readonly data: Buffer,
      readonly answer: (position: number, length: number) => number | Error = (position, length) => Math.max(0, Math.min(length, data.length - position)),
    ) {}
    open(_path: string, _flags: string, cb: (error: unknown, handle: Buffer) => void): void {
      cb(undefined, Buffer.from("h"));
    }
    read(_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: (error: unknown, bytesRead: number) => void): void {
      this.now += 1;
      this.most = Math.max(this.most, this.now);
      this.asked.push(`${position}+${length}`);
      const answer = this.answer(position, length);
      // The later a chunk, the sooner it answers.
      setTimeout(() => {
        this.now -= 1;
        if (answer instanceof Error) return cb(answer, 0);
        this.data.copy(buffer, offset, position, position + answer);
        cb(undefined, answer);
      }, Math.max(0, 20 - this.asked.length));
    }
    close(_handle: Buffer, cb: () => void): void {
      this.closes += 1;
      cb();
    }
  }

  const asSftp = (fake: FlightSftp): SFTPWrapper => fake as unknown as SFTPWrapper;

  it("asks eight 254 KB chunks at once and puts their answers together in order", async () => {
    expect(transcriptReadDepth).toBe(8);
    expect(transcriptReadChunk).toBe(254 * 1_024);
    const data = Buffer.alloc(4 * 1_024 * 1_024);
    for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
    const fake = new FlightSftp(data);
    const bytes = await readRange(asSftp(fake), "/f", 0, data.length);
    expect(Buffer.from(bytes).equals(data)).toBe(true);
    expect(fake.most).toBe(8);
    expect(fake.asked.length).toBe(Math.ceil(data.length / transcriptReadChunk));
    expect(fake.closes).toBe(1);
  });

  it("asks again from after a short answer, and stops at the end of the file", async () => {
    const data = Buffer.from("0123456789abcdefghij".repeat(40_000)); // 800,000 bytes
    const fake = new FlightSftp(data, (position, length) => (position === transcriptReadChunk ? 10 : Math.max(0, Math.min(length, data.length - position))));
    const bytes = await readRange(asSftp(fake), "/f", 0, data.length + 5_000);
    expect(Buffer.from(bytes).equals(data)).toBe(true);
    expect(fake.asked.slice(0, 4)).toEqual([`0+${transcriptReadChunk}`, `${transcriptReadChunk}+${transcriptReadChunk}`, `${2 * transcriptReadChunk}+${transcriptReadChunk}`, `${3 * transcriptReadChunk}+${data.length + 5_000 - 3 * transcriptReadChunk}`]);
    expect(fake.asked[4]).toBe(`${transcriptReadChunk + 10}+${transcriptReadChunk}`);
    expect(fake.closes).toBe(1);
  });

  it("fails the read when a request fails, and closes once", async () => {
    const data = Buffer.alloc(1_024 * 1_024);
    const fake = new FlightSftp(data, (position, length) => (position === 2 * transcriptReadChunk ? new Error("lost") : Math.min(length, data.length - position)));
    await expect(readRange(asSftp(fake), "/f", 0, data.length)).rejects.toThrow("lost");
    expect(fake.closes).toBe(1);
  });
});
