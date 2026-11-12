// Reading a transcript by byte offsets, with no I/O of its own: the follower
// tails a growing JSONL file (bounded reads from the last offset), the earlier
// reader walks backwards from a line start in bounded chunks. Both hand back
// whole lines only, each with the offset it starts at. A port of HerdrKit's
// TranscriptFollower.swift and TranscriptEarlierReader.swift.
//
// Relay v1.2: a read may come with the base64 runs the relay
// left out (`omitted`, file ranges; their bytes in the read are filler, see
// blobs.ts): the bytes and every offset stay the file's, and a line built over
// such a run gets a placeholder in its text and the run in its `blobs`.

import { blobLineText, clipBlobs, type BlobRange } from "./blobs";

/** The first load reads at most this much from the end of the file. */
export const firstLoadWindow = 4 * 1_024 * 1_024;
/** Each later poll reads at most this much from the last offset. */
export const pollWindow = 1 * 1_024 * 1_024;
/**
 * When more than one poll window waits (a burst of
 * screenshot and blob lines), the feed reads on at once, without a poll's
 * wait, in windows of this much until it has caught up. Why 4 MB: over SFTP
 * every read is an open and a close (two round trips) plus its chunk requests
 * (`transcriptReadDepth` at once), and before this every 1 MB window also asked
 * the size: a 4 MB window is 4 round trips where four 1 MB windows were 12. And
 * memory: it is the first load's window, so a catch-up holds no more than
 * opening the chat already does (the window, its lines, one partial line).
 */
export const catchUpWindow = 4 * 1_024 * 1_024;
/** A line longer than this is dropped (and counted). */
export const maxLineBytes = 8 * 1_024 * 1_024;
/** What one backwards read asks for at most. */
export const defaultEarlierChunkBytes = 512 * 1_024;

export type TranscriptReadKind = "firstLoad" | "reload" | "follow";

/** What to read from the transcript next. */
export interface TranscriptReadRequest {
  /** firstLoad: the last 4 MB at most; reload: the file got shorter (replaced), start over; follow: new bytes, at most 1 MB (4 MB while a catch-up reads on). */
  readonly kind: TranscriptReadKind;
  readonly offset: number;
  readonly maxBytes: number;
}

/** The caller starts a new timeline before applying this read's lines. */
export const startsOver = (request: TranscriptReadRequest): boolean => request.kind !== "follow";

/** One complete transcript line and the byte offset it starts at. */
export interface TranscriptLine {
  readonly text: string;
  readonly offset: number;
  /** The runs a relay read left out of it (each a placeholder in `text`), ascending; absent: none. */
  readonly blobs?: readonly BlobRange[];
  /** With `blobs`, where its line break is (the line is the file's [offset, end)). */
  readonly end?: number;
}

/** A line over `bytes` from `at` (its line break at `at + bytes.length`) with the runs in `ranges` inside it. */
function blobLine(bytes: Uint8Array, at: number, ranges: readonly BlobRange[]): TranscriptLine | null {
  if (ranges.length === 0) {
    const text = lineText(bytes);
    return text === null ? null : { text, offset: at };
  }
  const text = blobLineText(bytes, at, ranges);
  return text === null ? null : { text, offset: at, blobs: ranges, end: at + bytes.length };
}

/** Takes the ranges of `held` that start before `end` out of it, and gives those starting at `start` or later. */
function takeBlobs(held: BlobRange[], start: number, end: number): BlobRange[] {
  let taken = 0;
  const inside: BlobRange[] = [];
  while (taken < held.length && held[taken]![0] < end) {
    if (held[taken]![0] >= start) inside.push(held[taken]!);
    taken += 1;
  }
  held.splice(0, taken);
  return inside;
}

const NEWLINE = 0x0a;
const CR = 0x0d;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** A line's text, a trailing CR removed; null for a blank line. */
function lineText(bytes: Uint8Array): string | null {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.length - 1 : bytes.length;
  const text = decoder.decode(bytes.subarray(0, end));
  return /^\s*$/u.test(text) ? null : text;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Follows a growing JSONL file from byte offsets: ask `nextRead(fileSize)` what
 * to read, read it, hand the bytes to `consumeLines(offset, bytes)`, get back the
 * complete lines. The partial last line is kept until its newline arrives.
 */
export class TranscriptFollower {
  /**
   * What this follower's first load reads from the end (`firstLoadWindow`; a
   * cold load's first window, which then reads earlier only as far as it needs, `ChatColdLoad`).
   */
  firstLoadBytes = firstLoadWindow;
  /** The next byte to read. */
  offset = 0;
  /** Lines dropped for being longer than `maxLineBytes`. */
  oversizedLines = 0;
  hasLoaded = false;
  /** Where the first whole line of the loaded window starts (0 for the whole file); null until found. */
  windowStart: number | null = null;

  private partial: Uint8Array[] = [];
  private partialLength = 0;
  private partialStart = 0;
  /** The runs left out of the bytes not yet handed out as lines (the partial line's), ascending. */
  private blobs: BlobRange[] = [];
  private droppingFirstLine = false;
  private discardingOversizedLine = false;
  private expected: TranscriptReadRequest | null = null;

  /** What to read given the file's size now, or null when there is nothing new. */
  nextRead(fileSize: number): TranscriptReadRequest | null {
    let kind: TranscriptReadKind = "firstLoad";
    if (this.hasLoaded) {
      if (fileSize < this.offset) {
        this.reset();
        kind = "reload";
      } else if (fileSize === this.offset) {
        this.expected = null;
        return null;
      } else {
        const waiting = fileSize - this.offset;
        const window = waiting > pollWindow ? catchUpWindow : pollWindow;
        const request: TranscriptReadRequest = { kind: "follow", offset: this.offset, maxBytes: Math.min(waiting, window) };
        this.expected = request;
        return request;
      }
    }
    const start = fileSize > this.firstLoadBytes ? fileSize - this.firstLoadBytes : 0;
    this.offset = start;
    this.windowStart = null;
    this.clearPartial();
    this.blobs = [];
    this.discardingOversizedLine = false;
    this.droppingFirstLine = start > 0;
    const request: TranscriptReadRequest = { kind, offset: start, maxBytes: fileSize - start };
    this.expected = request;
    return request;
  }

  /** `consumeLines`, the texts only. */
  consume(readOffset: number, bytes: Uint8Array): string[] {
    return this.consumeLines(readOffset, bytes).map((line) => line.text);
  }

  /**
   * Feeds what a read returned (possibly fewer bytes than asked); bytes for any offset but the one asked for are ignored.
   * `omitted`: the runs a relay read left out of them (their bytes here are filler).
   */
  consumeLines(readOffset: number, bytes: Uint8Array, omitted: readonly BlobRange[] = []): TranscriptLine[] {
    const request = this.expected;
    if (request === null || request.offset !== readOffset || readOffset !== this.offset) return [];
    this.expected = null;
    if (startsOver(request)) {
      this.hasLoaded = true;
      if (readOffset === 0) this.windowStart = 0;
      this.blobs = [];
    }
    if (omitted.length > 0) this.blobs.push(...clipBlobs(omitted, readOffset, readOffset + bytes.length));
    this.offset += bytes.length;
    const lines: TranscriptLine[] = [];
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(NEWLINE, start);
      if (newline < 0) break;
      const segment = bytes.subarray(start, newline);
      const segmentStart = readOffset + start;
      start = newline + 1;
      if (this.droppingFirstLine || this.discardingOversizedLine) {
        if (this.droppingFirstLine && this.windowStart === null) this.windowStart = readOffset + start;
        this.droppingFirstLine = false;
        this.discardingOversizedLine = false;
        this.clearPartial();
        continue;
      }
      let line: Uint8Array;
      let lineStart: number;
      if (this.partialLength === 0) {
        line = segment;
        lineStart = segmentStart;
      } else {
        this.pushPartial(segment);
        line = this.joinedPartial();
        lineStart = this.partialStart;
      }
      const inside = this.blobs.length === 0 ? [] : takeBlobs(this.blobs, lineStart, readOffset + newline);
      if (line.length > maxLineBytes) {
        this.oversizedLines += 1;
      } else {
        const made = blobLine(line, lineStart, inside);
        if (made !== null) lines.push(made);
      }
      this.clearPartial();
    }
    // Only the partial line's runs stay held. A partial line
    // held from an earlier read (this one brought no line break) keeps every run from its start, those of the earlier
    // reads too; they go when the line is handed out or dropped on purpose (too long, a reset, a rewind).
    if (this.blobs.length > 0) takeBlobs(this.blobs, Infinity, this.partialLength > 0 ? this.partialStart : readOffset + start);
    if (start < bytes.length && !this.droppingFirstLine && !this.discardingOversizedLine) {
      if (this.partialLength === 0) this.partialStart = readOffset + start;
      this.pushPartial(bytes.slice(start));
      if (this.partialLength > maxLineBytes) {
        this.clearPartial();
        this.blobs = [];
        this.discardingOversizedLine = true;
        this.oversizedLines += 1;
      }
    }
    return lines;
  }

  /** Reads again from `lineOffset`, the start of a line the last read handed out that was not used. */
  rewind(lineOffset: number): void {
    if (!this.hasLoaded || lineOffset > this.offset) return;
    this.offset = lineOffset;
    this.clearPartial();
    this.blobs = [];
    this.droppingFirstLine = false;
    this.discardingOversizedLine = false;
    this.expected = null;
  }

  /**
   * The first load's window started inside a line and held no line break: the line is still
   * being written, its start before the window (`restart`).
   */
  get windowHoldsNoLineStart(): boolean {
    return this.hasLoaded && this.windowStart === null && this.droppingFirstLine;
  }

  /**
   * Reads on from `lineStart`, the start of the line the first window started inside (found
   * reading back): the window starts there now, and the next read is from there.
   */
  restart(lineStart: number): void {
    if (!this.hasLoaded || lineStart > this.offset) return;
    this.offset = lineStart;
    this.windowStart = lineStart;
    this.clearPartial();
    this.blobs = [];
    this.droppingFirstLine = false;
    this.discardingOversizedLine = false;
    this.expected = null;
  }

  /** Bytes held after the last newline (a line still being written). */
  get partialByteCount(): number {
    return this.partialLength;
  }

  /** Forgets everything; the next read is a first load. */
  reset(): void {
    this.offset = 0;
    this.windowStart = null;
    this.clearPartial();
    this.blobs = [];
    this.droppingFirstLine = false;
    this.discardingOversizedLine = false;
    this.hasLoaded = false;
    this.expected = null;
  }

  private pushPartial(bytes: Uint8Array): void {
    this.partial.push(bytes.slice());
    this.partialLength += bytes.length;
  }

  private joinedPartial(): Uint8Array {
    if (this.partial.length === 1) return this.partial[0]!;
    const out = new Uint8Array(this.partialLength);
    let at = 0;
    for (const part of this.partial) {
      out.set(part, at);
      at += part.length;
    }
    this.partial = [out];
    return out;
  }

  private clearPartial(): void {
    this.partial = [];
    this.partialLength = 0;
  }
}

/** One backwards read of a transcript: `maxBytes` from `offset`. */
export interface TranscriptEarlierRead {
  readonly offset: number;
  readonly maxBytes: number;
}

/**
 * Reads a transcript backwards from a line start, in bounded chunks, and hands
 * back whole lines only (oldest first, each with its offset). A chunk boundary
 * never splits or drops a line; a line longer than `maxLineBytes` is dropped
 * (and counted) without holding more than that in memory.
 */
export class TranscriptEarlierReader {
  private chunk: number;
  /** Where the earliest line handed out starts: everything before it is unread. */
  end: number;
  oversizedLines = 0;
  bytesRead = 0;

  /** The next read ends here; bytes [cursor, end) are held in `head`. */
  private cursor: number;
  /** The tail of the line that ends just before `end`, its line break included. */
  private head: Uint8Array = new Uint8Array(0);
  /** The runs a relay read left out of `head`, ascending. */
  private headBlobs: BlobRange[] = [];
  /** The line before `end` is too long: its bytes are dropped until its start is found. */
  private skipping = false;
  private expected: TranscriptEarlierRead | null = null;

  /**
   * As the iPhone app's cold load: `tail`, when given, is the bytes just before `end` (a line
   * start) that a read already took: the tail of the line before it, its line break last. They are held as
   * a read would have left them, so the next read ends where they begin and they are not read again. A tail
   * that is not one line's (a line break before its last byte), longer than a line may be, or reaching the
   * file's start is not taken. `tailBlobs`: the runs a relay read left out of it.
   */
  constructor(end: number, chunkBytes: number = defaultEarlierChunkBytes, tail: Uint8Array | null = null, tailBlobs: readonly BlobRange[] = []) {
    this.end = end;
    this.cursor = end;
    this.chunk = Math.max(1, chunkBytes);
    if (tail === null || tail.length === 0 || tail.length >= end || tail.length > maxLineBytes) return;
    const lastBreak = tail.indexOf(NEWLINE);
    if (lastBreak !== tail.length - 1) return;
    this.cursor = end - tail.length;
    this.head = tail.slice();
    this.headBlobs = clipBlobs(tailBlobs, this.cursor, end);
  }

  /** What one read asks for at most; a reader taken on by the next load reads its next chunk at the size set. */
  get chunkBytes(): number {
    return this.chunk;
  }

  set chunkBytes(bytes: number) {
    this.chunk = Math.max(1, bytes);
  }

  /** Whether the file's start has been reached. */
  get reachedStart(): boolean {
    return this.end === 0;
  }

  /** The chunk before what was read, or null at the file's start. */
  nextRead(): TranscriptEarlierRead | null {
    if (this.cursor <= 0) {
      this.expected = null;
      return null;
    }
    const start = this.cursor > this.chunk ? this.cursor - this.chunk : 0;
    const read = { offset: start, maxBytes: this.cursor - start };
    this.expected = read;
    return read;
  }

  /**
   * The lines the read completed, oldest first; null when the bytes are not the read asked for (the reader is left as it was).
   * `omitted`: the runs a relay read left out of them (their bytes here are filler).
   */
  consume(offset: number, bytes: Uint8Array, omitted: readonly BlobRange[] = []): TranscriptLine[] | null {
    const read = this.expected;
    if (read === null || read.offset !== offset || bytes.length !== read.maxBytes) return null;
    this.expected = null;
    this.cursor = offset;
    this.bytesRead += bytes.length;
    let region: Uint8Array = bytes;
    let blobs: BlobRange[] = omitted.length === 0 ? [] : clipBlobs(omitted, offset, offset + bytes.length);
    if (this.skipping) {
      // Still inside the long line: its start is just after the last line break in this chunk (or the file's start).
      const lastBreak = region.lastIndexOf(NEWLINE);
      if (lastBreak < 0) {
        if (offset === 0) {
          this.skipping = false;
          this.oversizedLines += 1;
          this.end = 0;
        }
        return [];
      }
      this.skipping = false;
      this.oversizedLines += 1;
      this.end = offset + lastBreak + 1;
      region = region.subarray(0, lastBreak + 1);
      blobs = clipBlobs(blobs, offset, offset + lastBreak + 1);
    } else {
      region = concat(region, this.head);
      this.head = new Uint8Array(0);
      if (this.headBlobs.length > 0) blobs = [...blobs, ...this.headBlobs];
      this.headBlobs = [];
    }
    if (region.length === 0) return [];
    // From the file's start every byte is in a whole line; otherwise the bytes up to the first break end an earlier line.
    let firstLine = 0;
    if (offset > 0) {
      const firstBreak = region.indexOf(NEWLINE);
      if (firstBreak < 0 || firstBreak + 1 >= region.length) {
        // One line's tail so far.
        this.head = region.slice();
        this.headBlobs = blobs;
        if (this.head.length > maxLineBytes) {
          this.head = new Uint8Array(0);
          this.headBlobs = [];
          this.skipping = true;
        }
        return [];
      }
      firstLine = firstBreak + 1;
      this.head = region.slice(0, firstLine);
      this.headBlobs = blobs.length === 0 ? [] : takeBlobs(blobs, offset, offset + firstLine);
      if (this.head.length > maxLineBytes) {
        this.head = new Uint8Array(0);
        this.headBlobs = [];
        this.skipping = true;
      }
    }
    const lines: TranscriptLine[] = [];
    let start = firstLine;
    while (start < region.length) {
      const found = region.indexOf(NEWLINE, start);
      const lineEnd = found < 0 ? region.length : found;
      const line = region.subarray(start, lineEnd);
      const lineOffset = offset + start;
      const inside = blobs.length === 0 ? [] : takeBlobs(blobs, lineOffset, offset + lineEnd);
      if (line.length > maxLineBytes) {
        this.oversizedLines += 1;
      } else {
        const made = blobLine(line, lineOffset, inside);
        if (made !== null) lines.push(made);
      }
      start = lineEnd + 1;
    }
    this.end = offset + firstLine;
    return lines;
  }
}
