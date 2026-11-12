// A program's own copy: an OSC 52 clipboard
// write, ESC ] 52 ; Pc ; Pd BEL (or ST, ESC \), Pd the text in base64. Claude
// Code, Herdr and other programs that take the mouse make their own selection
// and copy it this way. Ghostty's VT core (ghostty-web's WASM build) drops the
// write and never answers a read, so the pane's bytes are read here as they
// arrive (they still go to the terminal whole), and a write is honoured only:
// - within 2 s after your own mouse or key action in that tile (a program
//   cannot set your clipboard on its own), and only while the tile is on show;
// - for the clipboard (c), primary (p) or selection (s) target, or none
//   (xterm's default "s 0"): all are the clipboard here; the secondary (q)
//   and cut buffers (0-7) alone are not;
// - up to 1 MB of text (decoded); larger is refused, said with a note.
// A read (Pd "?") is always refused: nothing is answered, nothing is said.
// An empty write (xterm's clear) and data that is not base64 change nothing.

/** The largest text a program may copy (decoded bytes). */
export const maxOsc52Bytes = 1_048_576;
/** How long after your own key or mouse in the tile a program may copy. */
export const osc52ActionWindowMs = 2_000;

/** Base64 of the largest text, and room for the targets and their ';'. */
const maxBodyBytes = 4 * Math.ceil(maxOsc52Bytes / 3) + 32;

export type Osc52Event = { kind: "write"; targets: string; text: string } | { kind: "query"; targets: string } | { kind: "too-large" };

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const OSC = 0x5d; // ]
const SEMICOLON = 0x3b;
const BACKSLASH = 0x5c;

const enum State {
  Ground,
  Escape,
  /** After ESC ]: the OSC's number, up to its ';'. */
  Number,
  /** Another OSC: passed over to its end. */
  Other,
  Body,
  BodyEscape,
}

const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

function latin1(chunks: readonly Uint8Array[]): string {
  let out = "";
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 8_192) out += String.fromCharCode(...chunk.subarray(i, i + 8_192));
  }
  return out;
}

/** OSC 52 sequences in a byte stream, found across chunk boundaries. */
export class Osc52Scanner {
  private state = State.Ground;
  private number = "";
  private body: Uint8Array[] = [];
  private bodyLength = 0;
  private overflow = false;

  feed(bytes: Uint8Array): Osc52Event[] {
    const events: Osc52Event[] = [];
    let i = 0;
    while (i < bytes.length) {
      if (this.state === State.Ground) {
        const next = bytes.indexOf(ESC, i);
        if (next === -1) break;
        this.state = State.Escape;
        i = next + 1;
        continue;
      }
      if (this.state === State.Body) {
        // The body up to its end, kept while within the bound.
        let end = i;
        while (end < bytes.length && bytes[end] !== BEL && bytes[end] !== ESC && bytes[end] !== CAN && bytes[end] !== SUB) end += 1;
        this.keep(bytes.subarray(i, end));
        i = end;
        if (i >= bytes.length) break;
        const byte = bytes[i]!;
        i += 1;
        if (byte === BEL) this.finish(events);
        else if (byte === ESC) this.state = State.BodyEscape;
        else this.reset(State.Ground);
        continue;
      }
      const byte = bytes[i]!;
      i += 1;
      switch (this.state) {
        case State.Escape:
          this.afterEscape(byte);
          break;
        case State.BodyEscape:
          if (byte === BACKSLASH) this.finish(events);
          else {
            // Cut by another sequence: dropped, and that sequence read.
            this.reset(State.Ground);
            this.afterEscape(byte);
          }
          break;
        case State.Number:
          if (byte === SEMICOLON) {
            if (this.number === "52") this.reset(State.Body);
            else this.state = State.Other;
          } else if (byte === ESC) this.state = State.Escape;
          else if (byte === BEL || byte === CAN || byte === SUB) this.state = State.Ground;
          else {
            this.number += String.fromCharCode(byte);
            if (this.number.length > 3) this.state = State.Other;
          }
          break;
        case State.Other:
          if (byte === ESC) this.state = State.Escape;
          else if (byte === BEL || byte === CAN || byte === SUB) this.state = State.Ground;
          break;
      }
    }
    return events;
  }

  private afterEscape(byte: number): void {
    if (byte === OSC) {
      this.state = State.Number;
      this.number = "";
    } else if (byte !== ESC) this.state = State.Ground;
  }

  private keep(part: Uint8Array): void {
    if (part.length === 0 || this.overflow) return;
    if (this.bodyLength + part.length > maxBodyBytes) {
      this.overflow = true;
      this.body = [];
      return;
    }
    this.body.push(part.slice());
    this.bodyLength += part.length;
  }

  private reset(state: State): void {
    this.state = state;
    this.body = [];
    this.bodyLength = 0;
    this.overflow = false;
  }

  private finish(events: Osc52Event[]): void {
    const overflow = this.overflow;
    const body = latin1(this.body);
    this.reset(State.Ground);
    if (overflow) {
      events.push({ kind: "too-large" });
      return;
    }
    const split = body.indexOf(";");
    if (split === -1) return;
    const targets = body.slice(0, split);
    const data = body.slice(split + 1);
    if (data === "?") {
      events.push({ kind: "query", targets });
      return;
    }
    if (data === "" || data.length % 4 !== 0 || !base64.test(data)) return;
    let binary: string;
    try {
      binary = atob(data);
    } catch {
      return;
    }
    if (binary.length > maxOsc52Bytes) {
      events.push({ kind: "too-large" });
      return;
    }
    const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    events.push({ kind: "write", targets, text: new TextDecoder().decode(decoded) });
  }
}

/** The clipboard, primary and selection targets (or none, xterm's default) are the clipboard. */
function takesClipboard(targets: string): boolean {
  return targets === "" || /[cps]/.test(targets);
}

export interface Osc52ClipboardDeps {
  now(): number;
  /** Whether the tile is on show (the window shown, the tile laid out). */
  shown(): boolean;
  copy(text: string): void;
  /** Said once a text went to the clipboard ("Copied"). */
  copied(): void;
  /** A line to show (a copy too large). */
  note(text: string): void;
}

/** One tile's OSC 52: its bytes read, a write honoured only right after your own action in it. */
export class Osc52Clipboard {
  private readonly scanner = new Osc52Scanner();
  private lastAction = -Infinity;

  constructor(private readonly deps: Osc52ClipboardDeps) {}

  /** Your own key or mouse in this tile. */
  action(): void {
    this.lastAction = this.deps.now();
  }

  /** The pane's bytes, as they arrive (before or as they go to the terminal). */
  bytes(bytes: Uint8Array): void {
    for (const event of this.scanner.feed(bytes)) this.handle(event);
  }

  private handle(event: Osc52Event): void {
    // A read is never answered.
    if (event.kind === "query") return;
    if (event.kind === "write" && !takesClipboard(event.targets)) return;
    // A program cannot set your clipboard on its own, nor from a tile not on show.
    if (this.deps.now() - this.lastAction > osc52ActionWindowMs || !this.deps.shown()) return;
    if (event.kind === "too-large") {
      this.deps.note(`Not copied: the program's copy is over ${maxOsc52Bytes / 1_048_576} MB.`);
      return;
    }
    if (event.text === "") return;
    this.deps.copy(event.text);
    this.deps.copied();
  }
}
