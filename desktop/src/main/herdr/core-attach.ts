// A herdr-core terminal on the Mac's screen, over its attach channel
// (herdr-core schema/README.md "Attach streams"). Ported from the Swift
// client's CoreAttachSession.swift. The same terminal view takes the
// bytes: the first paint (the current screen), then the program's output. Keys
// go back as DATA, the grid as RESIZE, being on screen as FOCUS. Bytes are
// credited as the screen takes them (`fed`; a stream starts
// with 256 KiB), so a slow screen holds the core back instead of buffering
// without limit, and one more than 4 MiB behind gets a fresh repaint. A kept
// terminal that loses its program (CLOSE with its reason, the terminal still
// live) is waited for: after `restarted` the session attaches again on the same
// screen. A program that finished ends the session for good; a dropped line
// ends it so the app reattaches.

import { CoreConnectionError, CoreRPCError, type CoreConnection } from "./core-connection";
import { CoreFrames } from "./core-frames";
import { jsonObject, jsonSmallInt, jsonString, member, type CoreJSON } from "./core-json";
import { decodeCoreAttachResult, isLive, type CoreAttachResult, type CoreTerminal } from "./core-wire";

/** How a core terminal session ended. */
export type CoreTerminalFault =
  /** The program ended (the terminal's `reason`, its exit code). Final. */
  | { readonly kind: "finished"; readonly reason: string; readonly exitCode?: number }
  /** No such terminal any more (removed, or its machine forgotten). Final. */
  | { readonly kind: "gone" }
  /** This connection cannot attach (`needs_framed`). Final. */
  | { readonly kind: "unsupported"; readonly why: string }
  /** The terminal lost its program and no new shell came in time. */
  | { readonly kind: "waitingForShell" }
  /** The line to herdr-core went (why). */
  | { readonly kind: "line"; readonly why: string }
  /** herdr-core refused the attach (its words). */
  | { readonly kind: "refused"; readonly why: string };

/** CoreTerminalError.description. */
export function coreTerminalText(fault: CoreTerminalFault): string {
  switch (fault.kind) {
    case "finished":
      switch (fault.reason) {
        case "exited":
          return fault.exitCode === undefined ? "The program exited." : `The program exited (code ${fault.exitCode}).`;
        case "killed":
          return "The program was stopped.";
        case "server_stop":
        case "stopped_by_restart":
          return "herdr-core stopped, and the program with it.";
        case "host_shutdown":
          return "The Mac shut down, and the program with it.";
        default:
          return `The program ended (${fault.reason}).`;
      }
    case "gone":
      return "This terminal is gone.";
    case "unsupported":
      return fault.why;
    case "waitingForShell":
      return "The terminal lost its program; herdr-core is starting a new shell.";
    case "line":
      return `The connection to herdr-core dropped: ${fault.why}`;
    case "refused":
      return fault.why;
  }
}

export class CoreTerminalError extends Error {
  constructor(readonly fault: CoreTerminalFault) {
    super(coreTerminalText(fault));
    this.name = "CoreTerminalError";
  }

  /** Whether attaching again could work: not for an ended program or a terminal that is gone. */
  get isRetryable(): boolean {
    return this.fault.kind !== "finished" && this.fault.kind !== "gone" && this.fault.kind !== "unsupported";
  }
}

/** Input to a session that closed (OfficialTerminalInputError.closed). */
export class CoreTerminalClosedError extends Error {
  constructor() {
    super("The terminal is closed.");
    this.name = "CoreTerminalClosedError";
  }
}

/** What a session needs of the host's core: its live connection and its terminals (CoreFollower). */
export interface CoreAttachHost {
  connection(): Promise<CoreConnection>;
  terminal(address: string): CoreTerminal | undefined;
}

export interface CoreAttachOptions {
  /** How long a lost terminal is waited for (herdr-core retries a new shell after 1.5, 3, 6, 12, 30, then every 60 s). */
  readonly restartWaitSeconds?: number;
  /** How long the model may lag the CLOSE it explains. */
  readonly settleWaitSeconds?: number;
  readonly pollSeconds?: number;
  /**
   * Desktop: how long opening waits for the first paint (or a kept terminal's wait
   * for its new shell), connecting included, before it gives up and closes the attach. Default 30.
   */
  readonly firstPaintSeconds?: number;
}

/** Reasons a CLOSE gives when the program ended (README "reason on a finished terminal"). */
export const coreFinishedReasons: ReadonlySet<string> = new Set(["exited", "killed", "server_stop", "host_shutdown", "holder_lost", "stopped_by_restart"]);

const chunkLimit = 1 << 20;
const clamp = (value: number): number => Math.min(65535, Math.max(1, Math.floor(value)));
const sleep = (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

interface PendingInput {
  readonly data: Uint8Array;
  readonly acknowledgement?: { resolve: () => void; reject: (error: unknown) => void };
}

type Next = "done" | "again";

export class CoreAttachSession {
  readonly address: string;
  private readonly pipe: CoreOutputPipe;
  private readonly restartWait: number;
  private readonly settleWait: number;
  private readonly poll: number;
  private cols: number;
  private rows: number;
  private connection: CoreConnection | null = null;
  private channel: number | null = null;
  private ready = false;
  private pendingInput: PendingInput[] = [];
  private running = false;
  private closed = false;
  private readonly opening: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void; settled: boolean };
  /** The program asked for win32-input-mode (`CSI ?9001h`): Windows' ConPTY. */
  win32InputMode = false;
  /** How many times this session attached (1 at first, more after a restart). */
  attachCount = 0;

  constructor(
    private readonly host: CoreAttachHost,
    address: string,
    cols: number,
    rows: number,
    options: CoreAttachOptions = {},
  ) {
    this.address = address;
    this.cols = clamp(cols);
    this.rows = clamp(rows);
    this.restartWait = options.restartWaitSeconds ?? 180;
    this.settleWait = options.settleWaitSeconds ?? 3;
    this.poll = options.pollSeconds ?? 0.1;
    this.pipe = new CoreOutputPipe((channel, bytes) => this.credit(channel, bytes));
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Nobody may wait for it (a session closed before it opened).
    promise.catch(() => undefined);
    this.opening = { promise, resolve, reject, settled: false };
  }

  /** The output, chunk by chunk as the screen pulls it: ends cleanly on close, with a CoreTerminalError otherwise. */
  readonly output: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const chunk = await this.pipe.next();
        return chunk === null ? { value: undefined, done: true } : { value: chunk, done: false };
      },
    }),
  };

  get readyForInput(): boolean {
    return this.ready && !this.closed;
  }

  /**
   * Desktop: settles when the screen has something to show (the first paint), or the terminal is waiting for
   * its new shell; fails when the session ends before either (a refused attach, a gone terminal).
   */
  opened(): Promise<void> {
    return this.opening.promise;
  }

  /** Starts once; the output can be read before. */
  start(): void {
    if (this.running || this.closed) return;
    this.running = true;
    void this.run();
  }

  /**
   * The screen took `bytes` of `output`: credited back to the core, in the order they came and
   * to the stream that sent them, unless the screen is behind; never more than was received. Output only taken
   * off `output` is not credited, so the core (at most 256 KiB ahead) waits for the screen, and a screen more
   * than 4 MiB behind gets a fresh repaint instead of the backlog.
   */
  fed(bytes: number): void {
    this.pipe.fed(bytes);
  }

  /** The screen fell behind (true): what it is fed meanwhile is credited once it catches up (false). */
  parserBacklogged(isBacklogged: boolean): void {
    this.pipe.setBacklogged(isBacklogged);
  }

  /** Output this session holds that the screen has not fed yet. */
  get unfedBytes(): number {
    return this.pipe.unfedBytes;
  }

  /** Keys, in call order. */
  send(data: Uint8Array): void {
    if (data.length === 0) return;
    this.deliver({ data: Uint8Array.from(data) });
  }

  /** Settles once the bytes are written to the line (not when the program read them). */
  sendAcknowledged(data: Uint8Array): Promise<void> {
    if (data.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.deliver({ data: Uint8Array.from(data), acknowledgement: { resolve, reject } }));
  }

  resize(cols: number, rows: number): void {
    const newCols = clamp(cols);
    const newRows = clamp(rows);
    if (this.closed || (newCols === this.cols && newRows === this.rows && this.channel !== null)) return;
    this.cols = newCols;
    this.rows = newRows;
    if (this.channel !== null && this.connection !== null) this.connection.send(CoreFrames.resize(this.channel, newCols, newRows));
  }

  /** Detaches (CLOSE); the program runs on. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.channel !== null && this.connection !== null) {
      this.connection.send(CoreFrames.focus(this.channel, false));
      this.connection.send(CoreFrames.close(this.channel));
      this.connection.forget(this.channel);
    }
    this.channel = null;
    this.rejectPending(new CoreTerminalClosedError());
    this.settleOpening(new CoreTerminalClosedError());
    this.pipe.finish(null);
  }

  // MARK: - Input

  private deliver(input: PendingInput): void {
    if (this.closed) {
      input.acknowledgement?.reject(new CoreTerminalClosedError());
      return;
    }
    if (!this.ready || this.channel === null || this.connection === null) {
      this.pendingInput.push(input);
      return;
    }
    let sent = true;
    for (let offset = 0; offset < input.data.length; offset += chunkLimit) {
      sent = this.connection.send(CoreFrames.data(this.channel, input.data.subarray(offset, Math.min(input.data.length, offset + chunkLimit)))) && sent;
    }
    if (sent) input.acknowledgement?.resolve();
    else input.acknowledgement?.reject(new CoreTerminalClosedError());
  }

  private flushPending(): void {
    const held = this.pendingInput;
    this.pendingInput = [];
    for (const input of held) this.deliver(input);
  }

  private rejectPending(error: unknown): void {
    const held = this.pendingInput;
    this.pendingInput = [];
    for (const input of held) input.acknowledgement?.reject(error);
  }

  private credit(channel: number, bytes: number): void {
    if (channel !== this.channel || this.connection === null || bytes <= 0) return;
    this.connection.send(CoreFrames.credit(channel, Math.min(bytes, 0xffffffff)));
  }

  private settleOpening(error?: unknown): void {
    if (this.opening.settled) return;
    this.opening.settled = true;
    if (error === undefined) this.opening.resolve();
    else this.opening.reject(error);
  }

  // MARK: - Attaching

  private async run(): Promise<void> {
    while (!this.closed) {
      let next: Next;
      try {
        next = await this.attachOnce();
      } catch (error) {
        this.fail(error instanceof CoreTerminalError ? error : new CoreTerminalError({ kind: "line", why: describe(error) }));
        return;
      }
      if (next === "done") return;
    }
  }

  /** One attach: until its stream ends. "again" after a restart. */
  private async attachOnce(): Promise<Next> {
    let connection: CoreConnection;
    try {
      connection = await this.host.connection();
    } catch (error) {
      throw new CoreTerminalError({ kind: "line", why: describe(error) });
    }
    if (this.closed) return "done";
    const asked = { cols: this.cols, rows: this.rows };
    let result: CoreAttachResult;
    try {
      result = decodeCoreAttachResult(await connection.call("terminal.attach", { terminal: this.address, cols: asked.cols, rows: asked.rows }));
    } catch (error) {
      if (!(error instanceof CoreRPCError)) throw new CoreTerminalError({ kind: "line", why: describe(error) });
      switch (error.kind) {
        case "not_found":
        case "machine_unknown":
          throw new CoreTerminalError({ kind: "gone" });
        case "finished":
          throw this.finishedError("exited");
        case "needs_framed":
          throw new CoreTerminalError({ kind: "unsupported", why: error.description });
        case "unavailable":
          // Lost, waiting for its new shell (or a spawn still pending).
          await this.waitForShell(undefined);
          return "again";
        default:
          throw new CoreTerminalError({ kind: "refused", why: error.description });
      }
    }
    if (this.closed) {
      connection.send(CoreFrames.close(result.channel));
      connection.forget(result.channel);
      return "done";
    }
    this.attachCount += 1;
    this.connection = connection;
    this.channel = result.channel;
    this.ready = false;
    const stream = connection.stream(result.channel);
    // The view resized while the attach was in flight: the core has the grid it was
    // asked for, so send ours.
    if (this.cols !== asked.cols || this.rows !== asked.rows) connection.send(CoreFrames.resize(result.channel, this.cols, this.rows));
    connection.send(CoreFrames.focus(result.channel, true));
    const attachedPID = result.terminal.pid;

    for await (const item of stream) {
      switch (item.kind) {
        case "data":
          this.noteModes(item.bytes);
          this.pipe.push(item.bytes, result.channel);
          if (!this.ready) {
            // The first paint is here: what is typed now lands on this screen.
            this.ready = true;
            this.settleOpening();
            this.flushPending();
          }
          break;
        case "resize":
          break;
        case "closed":
          this.channel = null;
          this.ready = false;
          connection.forget(result.channel);
          if (this.closed) return "done";
          return this.settle(item.reason, attachedPID, connection);
        case "lost":
          this.channel = null;
          this.ready = false;
          throw new CoreTerminalError({ kind: "line", why: item.reason });
      }
    }
    this.channel = null;
    this.ready = false;
    if (this.closed) return "done";
    throw new CoreTerminalError({ kind: "line", why: "the attach stream ended" });
  }

  /** The core closed the stream: the program ended (final), or a kept terminal lost it (wait for `restarted`, attach again). */
  private async settle(reason: CoreJSON, attachedPID: number | undefined, connection: CoreConnection): Promise<Next> {
    const word = jsonString(member(reason, "reason"));
    const code = jsonSmallInt(member(reason, "exit_code"), -2147483648, 2147483647);
    // The answer to our CLOSE.
    if (word === undefined && Object.keys(jsonObject(reason) ?? {}).length === 0) return "done";
    const started = Date.now();
    while (!this.closed) {
      if (connection.isClosed) throw new CoreTerminalError({ kind: "line", why: (await connection.closed()).description });
      const terminal = this.host.terminal(this.address);
      if (terminal === undefined) throw new CoreTerminalError({ kind: "gone" });
      if (terminal.state === "finished") {
        throw new CoreTerminalError(withCode(terminal.reason ?? word ?? "exited", terminal.exitCode ?? code));
      }
      if (isLive(terminal) && terminal.pid === undefined) {
        // Lost: herdr-core starts a new shell when it can.
        await this.waitForShell(attachedPID);
        return "again";
      }
      // Already restarted.
      if (isLive(terminal) && terminal.pid !== undefined && terminal.pid !== attachedPID) return "again";
      if ((Date.now() - started) / 1000 > this.settleWait) {
        // The model never explained it: trust the CLOSE.
        if (word !== undefined && coreFinishedReasons.has(word)) throw new CoreTerminalError(withCode(word, code));
        return "again";
      }
      await sleep(this.poll);
    }
    return "done";
  }

  /** Waits for the terminal's new shell (`restarted`: live with a pid). */
  private async waitForShell(attachedPID: number | undefined): Promise<void> {
    // Desktop: the screen opens meanwhile (empty until the new shell's first paint).
    this.settleOpening();
    const started = Date.now();
    while (!this.closed) {
      const terminal = this.host.terminal(this.address);
      if (terminal === undefined) throw new CoreTerminalError({ kind: "gone" });
      if (terminal.state === "finished") throw new CoreTerminalError(withCode(terminal.reason ?? "exited", terminal.exitCode));
      if (isLive(terminal) && terminal.pid !== undefined && terminal.pid !== attachedPID) return;
      if ((Date.now() - started) / 1000 > this.restartWait) throw new CoreTerminalError({ kind: "waitingForShell" });
      await sleep(this.poll);
    }
  }

  private finishedError(fallback: string): CoreTerminalError {
    const terminal = this.host.terminal(this.address);
    return new CoreTerminalError(withCode(terminal?.reason ?? fallback, terminal?.exitCode));
  }

  /** `CSI ?9001h` / `l` in the first paint or later (Windows' ConPTY asking for win32-input-mode; this app sends plain keys either way). */
  private noteModes(bytes: Uint8Array): void {
    if (!bytes.includes(0x1b)) return;
    const text = new TextDecoder().decode(bytes);
    const on = text.lastIndexOf("\u001b[?9001h");
    const off = text.lastIndexOf("\u001b[?9001l");
    if (on >= 0) this.win32InputMode = off < on;
    else if (off >= 0) this.win32InputMode = false;
  }

  private fail(error: CoreTerminalError): void {
    if (this.closed) return;
    this.closed = true;
    if (this.channel !== null && this.connection !== null) this.connection.send(CoreFrames.close(this.channel));
    this.channel = null;
    this.rejectPending(error);
    this.settleOpening(error);
    this.pipe.finish(error);
  }
}

function withCode(reason: string, exitCode: number | undefined): CoreTerminalFault {
  return exitCode === undefined ? { kind: "finished", reason } : { kind: "finished", reason, exitCode };
}

function describe(error: unknown): string {
  if (error instanceof CoreConnectionError) return error.description;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session's output as the screen pulls it. A chunk handed over is credited back to its channel once the
 * screen says it took it (`fed`), and not while the screen is behind (`setBacklogged`).
 */
export class CoreOutputPipe {
  private chunks: { data: Uint8Array; channel: number }[] = [];
  /** Handed to the screen and not fed yet, in order. */
  private handed: { channel: number; bytes: number }[] = [];
  /** Fed while the screen was behind: credited when it catches up. */
  private held: { channel: number; bytes: number }[] = [];
  private backlogged = false;
  private ending: { readonly error: unknown } | null = null;
  private waiter: { resolve: (chunk: Uint8Array | null) => void; reject: (error: unknown) => void } | null = null;

  constructor(private readonly creditSink: (channel: number, bytes: number) => void) {}

  get unfedBytes(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0) + this.handed.reduce((sum, each) => sum + each.bytes, 0);
  }

  /** The screen fed `bytes` of what it was handed (anything beyond what it was handed is ignored: never more credit than was received). */
  fed(bytes: number): void {
    if (bytes <= 0) return;
    let left = bytes;
    let taken: { channel: number; bytes: number }[] = [];
    while (left > 0 && this.handed.length > 0) {
      const first = this.handed[0]!;
      const take = Math.min(left, first.bytes);
      add(taken, first.channel, take);
      first.bytes -= take;
      if (first.bytes === 0) this.handed.shift();
      left -= take;
    }
    if (this.backlogged) {
      for (const each of taken) add(this.held, each.channel, each.bytes);
      taken = [];
    }
    for (const each of taken) this.creditSink(each.channel, each.bytes);
  }

  setBacklogged(isBacklogged: boolean): void {
    this.backlogged = isBacklogged;
    if (isBacklogged) return;
    const released = this.held;
    this.held = [];
    for (const each of released) this.creditSink(each.channel, each.bytes);
  }

  push(data: Uint8Array, channel: number): void {
    if (data.length === 0 || this.ending !== null) return;
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      this.handed.push({ channel, bytes: data.length });
      waiter.resolve(data);
      return;
    }
    this.chunks.push({ data, channel });
  }

  /** Ends the output after what is queued (null: cleanly). */
  finish(error: unknown): void {
    if (this.ending !== null) return;
    this.ending = { error };
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter === null) return;
    if (error === null || error === undefined) waiter.resolve(null);
    else waiter.reject(error);
  }

  next(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk !== undefined) {
      this.handed.push({ channel: chunk.channel, bytes: chunk.data.length });
      return Promise.resolve(chunk.data);
    }
    if (this.ending !== null) {
      const { error } = this.ending;
      return error === null || error === undefined ? Promise.resolve(null) : Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

function add(list: { channel: number; bytes: number }[], channel: number, bytes: number): void {
  const last = list.at(-1);
  if (last !== undefined && last.channel === channel) last.bytes += bytes;
  else list.push({ channel, bytes });
}
