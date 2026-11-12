// Claude Code 2.1.322 with the user's messages in its queue, as read from a throwaway pane (keys through
// Herdr 0.9.5's pane send-keys): each queued message under the running
// turn with "ctrl+enter to send now", the box reading "Press up to edit queued messages". Up moves the queue into
// the input row (the send-now line goes); ctrl+u empties that row; the turn runs on. A stateful fake: its keys
// act as Claude Code's, its screen is read as Herdr's pane.read returns it.

import { checkHerdrKeys } from "./herdr-keys";
import { transcriptQueueRecord, type QueueRecord } from "../../src/shared/claude-queue-record";
import type { TranscriptFileReader } from "../../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../../src/shared/chat/locator";

const width = 80;
const dashes = (count: number): string => "\u{2500}".repeat(count);
const name = "esc takeback";
export const queueWorkingLine = "\u{273B} Cogitating\u{2026} (12s \u{00B7} \u{2193} 340 tokens \u{00B7} esc to interrupt)";

export interface QueueState {
  /** The user's messages waiting in Claude's queue, oldest first. */
  queued: string[];
  /** Claude's input row ("" empty). */
  input: string;
  /** The turn runs (its working line shows). */
  working: boolean;
  /** A dialog over the box (no box at the bottom). */
  dialog: boolean;
  /** The box wraps its input rows at this many columns, at a space (absent: no wrap drawn). */
  wrap?: number;
}

/** One logical line of the input as the box draws it, wrapped at a space within `wrap` columns (its 2-column mark aside). */
function wrapped(line: string, wrap: number | undefined): string[] {
  if (wrap === undefined) return [line];
  const rows: string[] = [];
  let row = "";
  for (const word of line.split(" ")) {
    if (row !== "" && row.length + 1 + word.length > wrap - 2) {
      rows.push(row);
      row = word;
    } else row = row === "" ? word : `${row} ${word}`;
  }
  rows.push(row);
  return rows;
}

/** The screen for `state`, as 2.1.322 draws it. */
export function queueScreen(state: QueueState): string {
  if (state.dialog) {
    return [
      "\u{23FA} Bash(rm -rf build)",
      "",
      "Do you want to proceed?",
      "\u{276F} 1. Yes",
      "  2. No, and tell Claude what to do differently (esc)",
      "",
      "Esc to cancel \u{00B7} Tab to amend",
    ].join("\n");
  }
  const rows = state.input === "" ? [`\u{276F} ${state.queued.length > 0 ? "Press up to edit queued messages" : ""}`] : state.input
          .split("\n")
          .flatMap((line) => wrapped(line, state.wrap))
          .map((line, index) => (index === 0 ? `\u{276F} ${line}` : `  ${line}`));
  return [
    "\u{23FA} Bash(sleep 30)",
    "  \u{23BF}  Running\u{2026}",
    "",
    ...(state.working ? [queueWorkingLine] : []),
    ...state.queued.flatMap((text) => text.split("\n").map((line, index) => (index === 0 ? `  \u{23BF} ${line}` : `    ${line}`))),
    ...(state.queued.length > 0 ? ["    ctrl+enter to send now"] : []),
    "",
    `${dashes(width - [...name].length - 2)} ${name} `,
    ...rows,
    dashes(width),
    "  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)",
  ].join("\n");
}

/** The fake session's transcript path and id (invented). */
export const fakeSessionPath = "/fake/projects/esc-takeback/esc-takeback-s1.jsonl";
export const fakeSessionRef: TranscriptSessionRef = { format: "claude", lookup: { kind: "id", id: "esc-takeback-s1" } } as TranscriptSessionRef;

/** One queue-operation line as Claude Code 2.1.322 writes it (the shapes it was seen to write). */
export function queueLine(operation: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "queue-operation", operation, sessionId: "esc-takeback-s1", timestamp: "2026-11-10T16:00:00.000Z", ...extra });
}

/** A user prompt line, as the transcript records the user's message. */
export function userLine(text: string): string {
  return JSON.stringify({ type: "user", sessionId: "esc-takeback-s1", message: { role: "user", content: text } });
}

/** A Claude pane whose keys act as 2.1.322's: every key and read logged. */
export class FakeClaudeQueue {
  readonly log: unknown[][] = [];
  readonly sent: string[] = [];
  readonly state: QueueState;
  /** Called before each key goes (a test changes the screen between keys). */
  beforeKey: (keys: readonly string[]) => void = () => undefined;
  /**
   * The session transcript's lines (Claude Code's queue record among them), newest last; earlier
   * lines of the session stand before them. `recording` false: Claude Code writes nothing more (a slow write).
   * `recordFails`: every read of the transcript fails.
   */
  readonly transcript: string[] = [userLine("an earlier prompt"), JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })];
  recording = true;
  recordFails = false;
  /**
   * Claude Code 2.1.322 writes one popAll line per message on Up (seen live); true: a single joined line
   * instead (still read when it is exactly the user's texts).
   */
  joinedPopAll = false;
  /** Lines Claude Code writes late, held back until the record is read so many more times (`late`). */
  private held: { readonly match: (line: string) => boolean; reads: number; readonly lines: string[] } | null = null;

  constructor(state: Partial<QueueState> = {}) {
    this.state = { queued: [], input: "", working: true, dialog: false, ...state };
    for (const text of this.state.queued) this.transcript.push(queueLine("enqueue", { content: text }));
  }

  /** Appends a transcript line (while recording; a line held back as late waits). */
  write(line: string): void {
    if (!this.recording) return;
    if (this.held !== null && this.held.match(line)) this.held.lines.push(line);
    else this.transcript.push(line);
  }

  /**
   * Lines that `match` reach the file late: written only once the record has been read `reads`
   * more times (Infinity: never within any bound). The live write took about 0.14 s after the key.
   */
  late(match: (line: string) => boolean, reads: number): void {
    this.held = { match, reads, lines: [] };
  }

  /** The popAll lines held back so far. */
  heldLines(): readonly string[] {
    return this.held?.lines ?? [];
  }

  /** Each read of the record's size counts toward the late lines. */
  private recordRead(): void {
    if (this.held === null) return;
    this.held.reads -= 1;
    if (this.held.reads > 0) return;
    this.transcript.push(...this.held.lines);
    this.held = null;
  }

  /** The transcript as a machine's reader serves it (locate, size, read), from its bytes. */
  reader(): TranscriptFileReader<TranscriptSessionRef> {
    const bytes = (): Uint8Array => new TextEncoder().encode(this.transcript.map((line) => `${line}\n`).join(""));
    const check = (): void => {
      if (this.recordFails) throw new Error("the transcript could not be read");
    };
    return {
      locate: async () => fakeSessionPath,
      size: async () => {
        check();
        this.recordRead();
        return bytes().length;
      },
      read: async (_path, offset, maxBytes) => {
        check();
        return bytes().slice(offset, offset + maxBytes);
      },
    };
  }

  /** Claude Code's queue record for take-backs (main's adapter over the reader). */
  record(): QueueRecord {
    return transcriptQueueRecord(this.reader(), fakeSessionRef);
  }

  /**
   * Claude takes queued messages mid-turn (steering), the oldest `count` (absent: all): delivered, the record says
   * `remove` absorbed_mid_turn for each, with its own text. `prompted` writes an ordinary
   * user line for each too, right after its remove (one delivery, two lines; nothing links them).
   */
  absorb(count: number = this.state.queued.length, prompted = false): void {
    for (const text of this.state.queued.splice(0, count)) {
      this.sent.push(text);
      this.write(queueLine("remove", { reason: "absorbed_mid_turn", content: text, commandUuid: `c-${this.sent.length}`, deliveryId: `d-${this.sent.length}` }));
      if (prompted) this.write(userLine(text));
    }
  }

  read(): string {
    this.log.push(["read"]);
    return queueScreen(this.state);
  }

  keys(keys: readonly string[]): void {
    checkHerdrKeys(keys);
    this.beforeKey(keys);
    this.log.push(["keys", [...keys]]);
    for (const key of keys) {
      if (key === "Up") {
        if (this.state.input === "" && this.state.queued.length > 0) {
          const pulled = this.state.queued.splice(0);
          this.state.input = pulled.join("\n");
          // The pull, in Claude Code's record: one popAll line per message, in queue order, each
          // holding only its own text, all with the same timestamp (one joined line on `joinedPopAll`).
          for (const content of this.joinedPopAll ? [this.state.input] : pulled) this.write(queueLine("popAll", { content }));
        }
        // With nothing queued, Up recalls the last prompt Claude got (history), as any prompt box does.
        else if (this.state.input === "" && this.sent.length > 0) this.state.input = this.sent.at(-1)!;
      } else if (key === "ctrl+u") {
        const at = this.state.input.lastIndexOf("\n");
        this.state.input = at < 0 ? "" : this.state.input.slice(0, at + 1);
      } else if (key === "Backspace") {
        this.state.input = this.state.input.slice(0, -1);
      } else if (key === "Escape") {
        // 2.1.322: Esc interrupts the turn and sends the queue as the next prompt.
        if (this.state.queued.length > 0) this.deliverQueue();
        this.state.working = false;
      } else if (key === "Enter" || key === "Return") {
        if (this.state.input !== "") {
          this.sent.push(this.state.input);
          this.write(userLine(this.state.input));
        }
        this.state.input = "";
      }
    }
  }

  /** The user's message from Chat (agent.prompt) while the turn runs: it waits in the queue. */
  prompt(text: string): void {
    this.log.push(["prompt", text]);
    if (this.state.working) {
      this.state.queued.push(text);
      this.write(queueLine("enqueue", { content: text }));
    } else {
      this.sent.push(text);
      this.write(userLine(text));
    }
  }

  /** The turn ends: the queue goes as the next prompt. */
  turnEnds(): void {
    this.state.working = false;
    if (this.state.queued.length > 0) this.deliverQueue();
  }

  /** The queue goes as one prompt: `dequeue`, then the user's message in the record. */
  private deliverQueue(): void {
    const text = this.state.queued.splice(0).join("\n");
    this.sent.push(text);
    this.write(queueLine("dequeue"));
    this.write(userLine(text));
  }

  /** The keys written, in order. */
  keysSent(): string[] {
    return this.log.flatMap((entry) => (entry[0] === "keys" ? (entry[1] as string[]) : []));
  }
}
