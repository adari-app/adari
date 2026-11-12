// Reads the shown pane's screen while its agent works, for the reply as it is
// written (a port of HerdrKit's ChatLiveReader.swift; the screen is read by
// ChatLiveScreen, live-screen.ts).
//
// `follow(pane)` reads that pane every `intervalMs` (about 400 ms), the next
// read asked only once the last has answered; `follow(null)` stops. One pane
// is read at a time, and never two reads of one pane at once: a read still out
// when the reader stops or moves on (another pane, another connection) keeps
// its pane until it answers, and its answer is dropped. The panes with a read
// out are a `PaneReadGate`, which the main process shares with the needs-you
// card's reads (src/main/prompt/prompts.ts), so no pane is read twice at once
// by either. Swift's reader stops by itself once let go; this one stops on
// `close()` (no deinit in JavaScript).

import { ChatLiveScreen, type ChatLiveBlock } from "./live-screen";

/** One read of a pane's screen (`pane.read`, recent lines, ANSI stripped). */
export type LiveScreenRead = (pane: string) => Promise<string>;
/** What a read found on the pane's screen (null: no text being written, a screen that does not read, a read that failed). */
export type LiveDeliver = (pane: string, block: ChatLiveBlock | null) => void;

/** The panes with a read out; a pane is read by one reader at a time. */
/**
 * The agent stopped working with its Chat on show: the live row stays at most
 * this long for its text to land (the page's wait, from when it has the stop;
 * main holds the reads' identity while the Chat stays shown, to end the row
 * should it change meanwhile).
 */
export const liveLandingMs = 2_000;

export class PaneReadGate {
  private readonly out = new Set<string>();
  /** The reads waiting for the pane (an answer's), in the order they asked. */
  private readonly waiting = new Map<string, (() => void)[]>();

  /** Takes the pane for a read: false while another read of it is out (or waits for it). */
  begin(pane: string): boolean {
    if (this.out.has(pane)) return false;
    this.out.add(pane);
    return true;
  }

  /** The pane's read answered: the pane goes to the read waiting longest, if any. */
  end(pane: string): void {
    const queue = this.waiting.get(pane);
    const next = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.waiting.delete(pane);
    if (next !== undefined) {
      next();
      return;
    }
    this.out.delete(pane);
  }

  /**
   * `read` once the pane is free (waiting its turn
   * while another read of it is out; first after it, before any new one), the
   * pane released when it answers or fails. The answer path's reads use it.
   */
  async reading<T>(pane: string, read: () => Promise<T>): Promise<T> {
    if (!this.begin(pane)) {
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(pane) ?? [];
        queue.push(resolve);
        this.waiting.set(pane, queue);
      });
    }
    try {
      return await read();
    } finally {
      this.end(pane);
    }
  }

  busy(pane: string): boolean {
    return this.out.has(pane);
  }
}

export interface ChatLiveReaderOptions {
  /** The rhythm of the reads: from an answer to the next read (default 400 ms). */
  readonly intervalMs?: number;
  /** The read `follow` uses when it is given none. */
  readonly read?: LiveScreenRead;
  /** The panes with a read out (default: the reader's own). */
  readonly gate?: PaneReadGate;
}

export class ChatLiveReader {
  /** The rhythm of the reads: about 400 ms from an answer to the next read. */
  static readonly intervalMs = 400;

  private readonly intervalMs: number;
  private readonly defaultRead: LiveScreenRead | null;
  private readonly gate: PaneReadGate;
  private pane: string | null = null;
  private key: string | null = null;
  /** The followed pane's agent (its screen's reader). */
  private kind: string | null = null;
  private serial = 0;
  private wait: { timer: ReturnType<typeof setTimeout>; resolve: (goOn: boolean) => void } | null = null;
  /** Reads asked so far. */
  reads = 0;

  constructor(
    private readonly deliver: LiveDeliver,
    options: ChatLiveReaderOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? ChatLiveReader.intervalMs;
    this.defaultRead = options.read ?? null;
    this.gate = options.gate ?? new PaneReadGate();
  }

  /** The pane being read (null: none). */
  get following(): string | null {
    return this.pane;
  }

  /**
   * Reads `pane`'s screen until told otherwise, over `read` (else the
   * reader's own) on the connection `key` names; null stops. The same pane on
   * the same connection goes on as it was. `kind`: the pane's agent, whose
   * reader reads the screen (Cursor's
   * only for a Cursor pane; null: Claude Code's or Codex's by the screen's shape).
   */
  follow(pane: string | null, key = "", read?: LiveScreenRead, kind: string | null = null): void {
    const reading = read ?? this.defaultRead;
    const next = reading === null ? null : pane;
    if (next === this.pane && (next === null || (key === this.key && kind === this.kind))) return;
    this.pane = next;
    this.key = next === null ? null : key;
    this.kind = next === null ? null : kind;
    this.serial += 1;
    this.endWait();
    if (next === null || reading === null) return;
    void this.run(next, reading, kind, this.serial);
  }

  /** Stops for good (Swift's reader let go). */
  close(): void {
    this.follow(null);
  }

  private current(serial: number): boolean {
    return this.serial === serial;
  }

  private async run(pane: string, read: LiveScreenRead, kind: string | null, serial: number): Promise<void> {
    while (this.current(serial)) {
      // The pane's last read (an earlier follow's, or another reader's) is still out: wait a turn.
      if (this.gate.begin(pane)) {
        this.reads += 1;
        let screen: string | null;
        try {
          screen = await read(pane);
        } catch {
          screen = null;
        }
        this.gate.end(pane);
        if (!this.current(serial)) return;
        this.deliver(pane, screen === null ? null : ChatLiveScreen.block(screen, kind));
        if (!this.current(serial)) return;
      }
      if (!(await this.sleep(serial))) return;
    }
  }

  /** The interval; false once the follow is over. */
  private sleep(serial: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.wait?.timer === timer) this.wait = null;
        resolve(this.current(serial));
      }, this.intervalMs);
      this.wait = { timer, resolve };
    });
  }

  private endWait(): void {
    const wait = this.wait;
    this.wait = null;
    if (wait === null) return;
    clearTimeout(wait.timer);
    wait.resolve(false);
  }
}
