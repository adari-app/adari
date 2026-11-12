// Following a growing transcript from byte offsets (the cases of HerdrKit's
// TranscriptFollowerTests.swift).

import { describe, expect, it } from "vitest";

import { firstLoadWindow, maxLineBytes, pollWindow, startsOver, TranscriptFollower } from "../src/shared/chat/follower";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("TranscriptFollower", () => {
  it("first load of a small file reads it all and keeps the partial tail", () => {
    const follower = new TranscriptFollower();
    const file = bytes('{"a":1}\n{"b":2}\n{"c":');
    const request = follower.nextRead(file.length)!;
    expect(request).toEqual({ kind: "firstLoad", offset: 0, maxBytes: file.length });
    expect(startsOver(request)).toBe(true);
    expect(follower.consume(0, file)).toEqual(['{"a":1}', '{"b":2}']);
    expect(follower.offset).toBe(file.length);
    expect(follower.partialByteCount).toBe(5);
    expect(follower.hasLoaded).toBe(true);
  });

  it("growth is read from the last offset and completes the partial line", () => {
    const follower = new TranscriptFollower();
    const file = bytes('{"a":1}\n{"c":');
    follower.nextRead(file.length);
    follower.consume(0, file);
    expect(follower.nextRead(file.length)).toBeNull();
    const more = bytes('3}\n{"d":4}\n');
    const start = file.length;
    const request = follower.nextRead(file.length + more.length)!;
    expect(request).toEqual({ kind: "follow", offset: start, maxBytes: more.length });
    expect(startsOver(request)).toBe(false);
    expect(follower.consume(start, more)).toEqual(['{"c":3}', '{"d":4}']);
    expect(follower.partialByteCount).toBe(0);
  });

  it("a UTF-8 character split across reads comes out whole", () => {
    const follower = new TranscriptFollower();
    const line = bytes('{"t":"café 🐑"}\n');
    const sheep = line.indexOf(0xf0);
    const first = line.slice(0, sheep + 2);
    const second = line.slice(sheep + 2);
    follower.nextRead(first.length);
    expect(follower.consume(0, first)).toEqual([]);
    follower.nextRead(line.length);
    expect(follower.consume(first.length, second)).toEqual(['{"t":"café 🐑"}']);
    const accent = line.indexOf(0xc3);
    const split = new TranscriptFollower();
    split.nextRead(accent + 1);
    expect(split.consume(0, line.slice(0, accent + 1))).toEqual([]);
    split.nextRead(line.length);
    expect(split.consume(accent + 1, line.slice(accent + 1))).toEqual(['{"t":"café 🐑"}']);
  });

  it("a shorter file was replaced and is reloaded", () => {
    const follower = new TranscriptFollower();
    const old = bytes('{"a":1}\n{"b":2}\n{"part');
    follower.nextRead(old.length);
    follower.consume(0, old);
    const fresh = bytes('{"z":9}\n');
    const request = follower.nextRead(fresh.length)!;
    expect(request).toEqual({ kind: "reload", offset: 0, maxBytes: fresh.length });
    expect(startsOver(request)).toBe(true);
    expect(follower.consume(0, fresh)).toEqual(['{"z":9}']);
  });

  it("first load of a large file reads the last four megabytes and drops the partial first line", () => {
    const follower = new TranscriptFollower();
    const size = 10 * 1_024 * 1_024;
    const request = follower.nextRead(size)!;
    expect(request.kind).toBe("firstLoad");
    expect(request.offset).toBe(size - firstLoadWindow);
    expect(request.maxBytes).toBe(firstLoadWindow);
    const window = bytes('ail of a line\n{"a":1}\n{"b":2}\n');
    expect(follower.consume(request.offset, window)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("the first partial line is dropped even when it spans reads", () => {
    const follower = new TranscriptFollower();
    const size = 5 * 1_024 * 1_024;
    const request = follower.nextRead(size)!;
    expect(follower.consume(request.offset, bytes("no newline in this read"))).toEqual([]);
    const next = follower.nextRead(size + 20)!;
    expect(next.kind).toBe("follow");
    expect(follower.consume(next.offset, bytes('still it\n{"ok":1}\n'))).toEqual(['{"ok":1}']);
  });

  /** The contract is one megabyte, written out; past it a catch-up window of four. */
  it("later reads ask for at most one megabyte, or a catch-up window of four", () => {
    const oneMegabyte = 1_048_576;
    const fourMegabytes = 4_194_304;
    const first = bytes('{"a":1}\n\n');
    const offset = first.length;
    for (const [growth, expected] of [
      [oneMegabyte - 1, oneMegabyte - 1],
      [oneMegabyte, oneMegabyte],
      [oneMegabyte + 1, oneMegabyte + 1],
      [3 * oneMegabyte, 3 * oneMegabyte],
      [fourMegabytes, fourMegabytes],
      [fourMegabytes + 1, fourMegabytes],
      [10 * oneMegabyte, fourMegabytes],
    ] as const) {
      const follower = new TranscriptFollower();
      follower.nextRead(first.length);
      follower.consume(0, first);
      expect(follower.nextRead(offset + growth), `growth ${growth}`).toEqual({ kind: "follow", offset, maxBytes: expected });
    }
  });

  it("offsets stay exact beyond four gigabytes", () => {
    const follower = new TranscriptFollower();
    const size = 6 * 1_024 * 1_024 * 1_024;
    const request = follower.nextRead(size)!;
    expect(request.offset).toBe(size - firstLoadWindow);
    const window = bytes('x\n{"a":1}\n');
    expect(follower.consume(request.offset, window)).toEqual(['{"a":1}']);
    const next = follower.nextRead(size + 5_000_000)!;
    expect(next.offset).toBe(request.offset + window.length);
    expect(next.maxBytes, "more than a megabyte waits: a catch-up window").toBe(4_194_304);
  });

  it("CRLF and blank lines are cleaned and a stale read is ignored", () => {
    const follower = new TranscriptFollower();
    follower.nextRead(20);
    expect(follower.consume(7, bytes('{"x":1}\n')), "not the offset asked for").toEqual([]);
    expect(follower.offset).toBe(0);
    expect(follower.consume(0, bytes('{"a":1}\r\n\r\n  \n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(follower.consume(follower.offset, bytes('{"c":3}\n')), "no read was asked for").toEqual([]);
  });

  it("an oversized line is dropped and counted and the next line survives", () => {
    const follower = new TranscriptFollower();
    const head = bytes('{"a":1}\n');
    follower.nextRead(head.length);
    expect(follower.consume(0, head)).toEqual(['{"a":1}']);
    // One line of 9 MB arrives over nine 1 MB polls.
    const chunk = new Uint8Array(pollWindow).fill(0x61);
    let size = head.length;
    for (let n = 0; n < 9; n += 1) {
      size += chunk.length;
      const request = follower.nextRead(size)!;
      expect(request.maxBytes).toBe(pollWindow);
      expect(follower.consume(request.offset, chunk)).toEqual([]);
      expect(follower.partialByteCount).toBeLessThanOrEqual(maxLineBytes);
    }
    expect(follower.oversizedLines).toBe(1);
    expect(follower.partialByteCount, "the runaway line is not held").toBe(0);
    const rest = bytes('aaaa\n{"after":1}\n');
    const request = follower.nextRead(size + rest.length)!;
    expect(follower.consume(request.offset, rest)).toEqual(['{"after":1}']);
  });

  it("an empty file loads and then follows", () => {
    const follower = new TranscriptFollower();
    const request = follower.nextRead(0)!;
    expect(request).toEqual({ kind: "firstLoad", offset: 0, maxBytes: 0 });
    expect(follower.consume(0, new Uint8Array(0))).toEqual([]);
    expect(follower.hasLoaded).toBe(true);
    expect(follower.nextRead(0)).toBeNull();
    expect(follower.nextRead(8)?.kind).toBe("follow");
  });

  it("a failed first read is asked for again", () => {
    const follower = new TranscriptFollower();
    follower.nextRead(100);
    // The read threw: nothing was consumed, so the next poll loads again.
    expect(follower.nextRead(120)).toEqual({ kind: "firstLoad", offset: 0, maxBytes: 120 });
  });
});
