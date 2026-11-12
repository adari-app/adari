// A program's own copy, an OSC 52 clipboard
// write (ESC ] 52 ; Pc ; base64 BEL or ST), the way Claude Code and Herdr
// copy what is selected in them. Ghostty's VT core (ghostty-web's WASM build)
// drops the write and never answers a read, so the bytes are read here:
// - a write goes to the clipboard only within 2 s after the user's own mouse or key
//   action in that tile, and only while the tile is on show; a program never
//   sets the user's clipboard on its own;
// - the clipboard (c), primary (p) and selection (s, and an empty Pc, xterm's
//   default) targets are all the clipboard; the secondary and cut buffers are
//   not;
// - a write over 1 MB (decoded) is refused, said with a note;
// - a read (Pd "?") is always refused: nothing is answered;
// - the sequence is found split anywhere across the stream's chunks.

import { describe, expect, it } from "vitest";

import { maxOsc52Bytes, Osc52Clipboard, osc52ActionWindowMs, Osc52Scanner, type Osc52Event } from "../src/renderer/terminal/osc52";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const osc52 = (targets: string, text: string, end = "\x07"): string => `\x1b]52;${targets};${base64(text)}${end}`;

function scan(...chunks: (string | Uint8Array)[]): Osc52Event[] {
  const scanner = new Osc52Scanner();
  return chunks.flatMap((chunk) => scanner.feed(typeof chunk === "string" ? bytes(chunk) : chunk));
}

describe("the OSC 52 scanner", () => {
  it("reads a write ended by BEL or by ST, among other output", () => {
    expect(scan(`before ${osc52("c", "hello")} after`)).toEqual([{ kind: "write", targets: "c", text: "hello" }]);
    expect(scan(`\x1b[1mx${osc52("p", "naïve 日本", "\x1b\\")}y`)).toEqual([{ kind: "write", targets: "p", text: "naïve 日本" }]);
  });

  it("finds it split at any byte across chunks", () => {
    const whole = bytes(`ab${osc52("c", "split me")}cd${osc52("c", "second", "\x1b\\")}`);
    for (let cut = 0; cut <= whole.length; cut += 1) {
      expect(scan(whole.subarray(0, cut), whole.subarray(cut)), `cut at ${cut}`).toEqual([
        { kind: "write", targets: "c", text: "split me" },
        { kind: "write", targets: "c", text: "second" },
      ]);
    }
    // One byte at a time.
    const scanner = new Osc52Scanner();
    const events = Array.from(whole).flatMap((byte) => scanner.feed(Uint8Array.of(byte)));
    expect(events.map((e) => (e.kind === "write" ? e.text : e.kind))).toEqual(["split me", "second"]);
  });

  it("leaves other OSC sequences alone (a title, a hyperlink, OSC 520)", () => {
    expect(scan("\x1b]0;title\x07\x1b]8;;https://x.invalid\x1b\\link\x1b]8;;\x1b\\\x1b]520;c;aGk=\x07")).toEqual([]);
  });

  it("reads a read (query) as a query", () => {
    expect(scan("\x1b]52;c;?\x07")).toEqual([{ kind: "query", targets: "c" }]);
  });

  it("drops a sequence cut by CAN, SUB or another escape, and reads the next", () => {
    expect(scan(`\x1b]52;c;${base64("lost")}\x18${osc52("c", "kept")}`)).toEqual([{ kind: "write", targets: "c", text: "kept" }]);
    expect(scan(`\x1b]52;c;${base64("lost")}\x1a`)).toEqual([]);
    expect(scan(`\x1b]52;c;${base64("lost")}\x1b[31m${osc52("c", "kept")}`)).toEqual([{ kind: "write", targets: "c", text: "kept" }]);
    expect(scan(`\x1b]52;c;${base64("lost")}${osc52("c", "kept")}`)).toEqual([{ kind: "write", targets: "c", text: "kept" }]);
  });

  it("ignores data that is not base64, and an empty write (xterm's clear)", () => {
    expect(scan("\x1b]52;c;not base64!\x07", "\x1b]52;c;\x07", "\x1b]52;c\x07")).toEqual([]);
  });

  it("bounds a write at 1 MB decoded: larger is too large, without keeping it", () => {
    expect(maxOsc52Bytes).toBe(1_048_576);
    const fits = "a".repeat(maxOsc52Bytes);
    const over = "a".repeat(maxOsc52Bytes + 1);
    expect(scan(osc52("c", fits))).toEqual([{ kind: "write", targets: "c", text: fits }]);
    expect(scan(osc52("c", over))).toEqual([{ kind: "too-large" }]);
    // Far over the bound, in pieces: still one refusal, and the scanner goes on.
    const scanner = new Osc52Scanner();
    const piece = bytes("QUFB".repeat(65_536));
    const events: Osc52Event[] = [...scanner.feed(bytes("\x1b]52;c;"))];
    for (let i = 0; i < 8; i += 1) events.push(...scanner.feed(piece));
    events.push(...scanner.feed(bytes(`\x07${osc52("c", "after")}`)));
    expect(events).toEqual([{ kind: "too-large" }, { kind: "write", targets: "c", text: "after" }]);
  });
});

function clipboard(shown = true) {
  let now = 10_000;
  const state = { shown, copies: [] as string[], copied: 0, notes: [] as string[] };
  const gate = new Osc52Clipboard({
    now: () => now,
    shown: () => state.shown,
    copy: (text) => state.copies.push(text),
    copied: () => (state.copied += 1),
    note: (text) => state.notes.push(text),
  });
  return {
    state,
    gate,
    later: (ms: number) => (now += ms),
    feed: (text: string) => gate.bytes(bytes(text)),
  };
}

describe("a program's OSC 52 write", () => {
  it("copies within 2 s after the user's own action in the tile, with the Copied note", () => {
    expect(osc52ActionWindowMs).toBe(2_000);
    const c = clipboard();
    c.gate.action();
    c.later(1_999);
    c.feed(osc52("c", "from claude"));
    expect(c.state.copies).toEqual(["from claude"]);
    expect(c.state.copied).toBe(1);
  });

  it("is refused with no action of the user's, or one older than 2 s", () => {
    const c = clipboard();
    c.feed(osc52("c", "on its own"));
    c.gate.action();
    c.later(2_001);
    c.feed(osc52("c", "too late"));
    expect(c.state.copies).toEqual([]);
    expect(c.state.copied).toBe(0);
    expect(c.state.notes).toEqual([]);
  });

  it("is refused for a tile not on show, even right after an action", () => {
    const c = clipboard(false);
    c.gate.action();
    c.feed(osc52("c", "hidden"));
    expect(c.state.copies).toEqual([]);
  });

  it("takes the clipboard, primary and selection targets (and the default) as the clipboard; not the others", () => {
    const c = clipboard();
    c.gate.action();
    for (const targets of ["c", "p", "s", "", "pc", "s0"]) c.feed(osc52(targets, `to ${targets || "default"}`));
    for (const targets of ["q", "0", "7"]) c.feed(osc52(targets, `not to ${targets}`));
    expect(c.state.copies).toEqual(["to c", "to p", "to s", "to default", "to pc", "to s0"]);
  });

  it("over 1 MB is refused with a note", () => {
    const c = clipboard();
    c.gate.action();
    c.feed(osc52("c", "a".repeat(maxOsc52Bytes + 1)));
    expect(c.state.copies).toEqual([]);
    expect(c.state.notes).toEqual(["Not copied: the program's copy is over 1 MB."]);
  });

  it("a read is always refused, even right after an action", () => {
    const c = clipboard();
    c.gate.action();
    c.feed("\x1b]52;c;?\x07");
    expect(c.state.copies).toEqual([]);
    expect(c.state.copied).toBe(0);
  });
});
