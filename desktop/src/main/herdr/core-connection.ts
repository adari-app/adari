// One connection to herdr-core over any byte link (an SSH exec
// channel running `hc connect`, core-ssh.ts; an in-process fake core in the
// tests). The port of the Swift client's CoreConnection.swift.
//
// It starts in plain mode (herdr-core schema/README.md "Connecting"): our
// `hello` goes as one line and its reply comes as one line. With
// `framed: true` the connection is framed from the byte after that line
// (core-frames.ts). Calls run side by side and are matched by id; stream
// channels (attach, events) get their frames in order, including frames that
// arrive before the caller has read the reply that named the channel.

import {
  CoreFrameDecoder,
  CoreFrameError,
  CoreFrameKind,
  CoreFrames,
  CoreLineOversizeError,
  CoreLineSplitter,
  coreFrame,
  encodeCoreFrame,
  creditAmount,
  resizeGrid,
  type CoreFrame,
} from "./core-frames";
import {
  coreJSONBytes,
  jsonArray,
  jsonBool,
  jsonInt,
  jsonObject,
  jsonSmallInt,
  jsonString,
  jsonU64,
  member,
  tryParseCoreJSON,
  type CoreJSON,
} from "./core-json";
import { CoreQueue } from "./core-queue";

/** The bytes between this app and one herdr-core. */
export interface CoreLink {
  /** Bytes from the core, in order. Finishes when the link ends; an error says why. */
  readonly inbound: CoreQueue<Uint8Array>;
  /** Queues bytes for the core, in call order. False once the link is closed. */
  send(bytes: Uint8Array): boolean;
  /** Ends the link. Idempotent. */
  close(): void;
}

/** A JSON-RPC error from herdr-core. `kind` and `hint` are kept as sent ("Errors are JSON-RPC errors with a stable kind and a hint"). */
export class CoreRPCError extends Error {
  readonly code: number;
  readonly rpcMessage: string;
  readonly kind: string | undefined;
  readonly hint: string | undefined;

  constructor(code: number, message: string, kind?: string, hint?: string) {
    super(hint === undefined || hint === "" ? message : `${message} (${hint})`);
    this.name = "CoreRPCError";
    this.code = code;
    this.rpcMessage = message;
    this.kind = kind;
    this.hint = hint;
  }

  /** From a JSON-RPC `error` object. */
  static from(json: CoreJSON | undefined): CoreRPCError {
    const code = jsonInt(member(json, "code"));
    const data = member(json, "data");
    return new CoreRPCError(
      typeof code === "number" ? code : -32000,
      jsonString(member(json, "message")) ?? "herdr-core refused the call",
      jsonString(member(data, "kind")),
      jsonString(member(data, "hint")),
    );
  }

  /** The message, then the hint in brackets when there is one (as Herdr App shows them). */
  get description(): string {
    return this.message;
  }
}

export const coreProtocolGeneration = 1;
/** What the app calls on the core: a core without one of them can't serve it. */
export const coreRequiredMethods: readonly string[] = [
  "events.subscribe",
  "terminal.attach",
  "terminal.send",
  "terminal.keys",
  "terminal.read",
  "terminal.run",
  "terminal.kill",
  "terminal.label",
];

/** Why a connection to herdr-core is not usable. */
export type CoreConnectionFault =
  /** `hello` named a generation above the one this app speaks (or refused ours as `unsupported_generation`). */
  | { readonly kind: "newerGeneration"; readonly generation: number | null }
  /** `hello` named a generation below 1. */
  | { readonly kind: "olderGeneration"; readonly generation: number }
  /** The core lacks methods the app calls. */
  | { readonly kind: "missingMethods"; readonly methods: readonly string[] }
  /** `hello` was refused for another reason. */
  | { readonly kind: "helloRefused"; readonly error: CoreRPCError }
  /** What came back was not a hello reply. */
  | { readonly kind: "badHello"; readonly detail: string }
  /** The link ended (the reason when one is known). */
  | { readonly kind: "closed"; readonly reason: string }
  /** A frame or line could not be read: the link is closed. */
  | { readonly kind: "protocolViolation"; readonly detail: string }
  /** No answer in time. */
  | { readonly kind: "timedOut"; readonly method: string; readonly seconds: number }
  /** Framed mode was asked for and `hello` said `framed: false`. */
  | { readonly kind: "notFramed" };

function describeFault(fault: CoreConnectionFault): string {
  switch (fault.kind) {
    case "newerGeneration": {
      const which = fault.generation === null ? "" : ` (protocol generation ${fault.generation}; this app speaks ${coreProtocolGeneration})`;
      return `This Mac runs a newer herdr-core than this app understands${which}. Update the app to use it.`;
    }
    case "olderGeneration":
      return `This Mac runs an older herdr-core than this app understands (protocol generation ${fault.generation}). Update herdr-core with \`hc update\`.`;
    case "missingMethods":
      return `This Mac's herdr-core lacks ${fault.methods.join(", ")}. Update herdr-core with \`hc update\`.`;
    case "helloRefused":
      return `herdr-core refused the connection: ${fault.error.description}`;
    case "notFramed":
      return "This Mac's herdr-core did not accept framed mode, which terminals and live updates need. Update herdr-core with `hc update`.";
    case "badHello":
      return `herdr-core did not answer as expected: ${fault.detail}`;
    case "closed":
      return `The connection to herdr-core closed: ${fault.reason}`;
    case "protocolViolation":
      return `herdr-core's connection broke: ${fault.detail}`;
    case "timedOut":
      return `herdr-core did not answer ${fault.method} within ${Math.trunc(fault.seconds)} seconds`;
  }
}

export class CoreConnectionError extends Error {
  constructor(readonly fault: CoreConnectionFault) {
    super(describeFault(fault));
    this.name = "CoreConnectionError";
  }

  get description(): string {
    return this.message;
  }
}

/** `hello`'s reply (`HelloResult`). */
export interface CoreHello {
  readonly generation: number;
  readonly version: string;
  readonly core: { readonly id: string; readonly name: string };
  readonly framed: boolean;
  readonly methods: readonly string[];
  readonly features: readonly string[];
}

export function decodeCoreHello(value: CoreJSON | undefined): CoreHello | null {
  const generation = jsonSmallInt(member(value, "generation"), 0, 4294967295);
  const version = jsonString(member(value, "version"));
  const core = member(value, "core");
  const id = jsonString(member(core, "id"));
  const name = jsonString(member(core, "name"));
  const framed = jsonBool(member(value, "framed"));
  const methods = stringList(member(value, "methods"));
  const features = stringList(member(value, "features"));
  if (
    generation === undefined ||
    version === undefined ||
    id === undefined ||
    name === undefined ||
    framed === undefined ||
    methods === null ||
    features === null
  ) {
    return null;
  }
  return { generation, version, core: { id, name }, framed, methods, features };
}

function stringList(value: CoreJSON | undefined): string[] | null {
  const array = jsonArray(value);
  if (array === undefined) return null;
  const out: string[] = [];
  for (const item of array) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/** Whether this app can talk to the core that sent this. */
export function checkCoreHello(hello: CoreHello, required: readonly string[] = coreRequiredMethods): CoreConnectionError | null {
  if (hello.generation > coreProtocolGeneration) return new CoreConnectionError({ kind: "newerGeneration", generation: hello.generation });
  if (hello.generation < coreProtocolGeneration) return new CoreConnectionError({ kind: "olderGeneration", generation: hello.generation });
  const missing = required.filter((method) => !hello.methods.includes(method));
  return missing.length === 0 ? null : new CoreConnectionError({ kind: "missingMethods", methods: missing });
}

/** What a stream channel delivers. */
export type CoreStreamItem =
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  /** RESIZE from the core (observers that asked for resize notifications). */
  | { readonly kind: "resize"; readonly cols: number; readonly rows: number }
  /** The core ended the stream; its JSON reason (`{}` for the answer to our CLOSE). */
  | { readonly kind: "closed"; readonly reason: CoreJSON }
  /** The connection to the core ended (why). */
  | { readonly kind: "lost"; readonly reason: string };

export interface CoreOpenOptions {
  /** Asks for framed mode (attach needs it); default true. */
  readonly framed?: boolean;
  readonly required?: readonly string[];
  /** Seconds for hello's answer (default 20). */
  readonly timeoutSeconds?: number;
  /**
   * Tests only: each channel-0 notification as it comes. Nothing in the app reads them (events
   * come on their subscription's channel), so without this they are dropped as they come, never kept.
   */
  readonly notified?: (message: CoreJSON) => void;
}

/** A pending call's resolution. */
interface Pending {
  readonly resolve: (value: CoreJSON) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout | null;
}

export class CoreConnection {
  /** Bytes kept early, all channels together, at most. */
  static readonly earlyLimit = 4 << 20;
  /** Items kept early, all channels together (a zero-byte frame is one). */
  static readonly earlyItemLimit = 4096;
  /** README "Flow control": a stream starts with 256 KiB of credit. */
  static readonly streamWindow = 256 * 1024;
  /**
   * How far past its window and the credit sent back a stream may go before the core is taken to
   * ignore credit (README: a paint goes whole once the viewer has any credit, so one item may overrun the window).
   */
  static readonly streamOverrun = 4 << 20;
  /**
   * Items a routed stream may hold that its reader has not taken (DATA, RESIZE, any control item),
   * whatever their bytes. A core keeps to its 256 KiB window, so this is reached only by thousands of tiny or
   * empty-of-credit frames no paint, output or event traffic makes.
   */
  static readonly routeItemLimit = 16_384;

  private nextID = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly routes = new Map<number, CoreQueue<CoreStreamItem>>();
  private readonly early = new Map<number, CoreStreamItem[]>();
  private readonly earlyBytes = new Map<number, number>();
  /**
   * Channels a reply opened (its result named the `channel`) that no reader has claimed yet: only their frames
   * are kept early. A reply precedes its stream's frames, so anything else is for
   * nobody and is dropped.
   */
  private readonly expected = new Set<number>();
  /** Expected channels whose early frames went over the bound: their reader gets `lost`, never a stream with a hole. */
  private readonly overflowed = new Set<number>();
  /** Channels this side stopped reading: their late frames are dropped, not kept. */
  private readonly forgotten = new Set<number>();
  private ended: CoreConnectionError | null = null;
  private readonly endWaiters: ((error: CoreConnectionError) => void)[] = [];
  /**
   * DATA bytes each kept or routed stream got beyond what was credited back (CREDIT frames sent
   * through `send`), counted here whatever the core says it allows, so no stream holds more than its window and
   * `streamOverrun` in this app, however fast or slow its reader is.
   */
  private readonly uncredited = new Map<number, number>();

  private constructor(
    private readonly link: CoreLink,
    readonly hello: CoreHello,
    readonly framed: boolean,
    /** Tests only: channel-0 notifications (CoreOpenOptions.notified); null drops them. */
    private readonly notified: ((message: CoreJSON) => void) | null = null,
  ) {}

  // MARK: - Opening

  /**
   * Says hello on `link` and returns the connection, or throws why it can't be used. `framed` asks for framed
   * mode (attach needs it). The link is closed on any failure.
   */
  static async open(link: CoreLink, options: CoreOpenOptions = {}): Promise<CoreConnection> {
    const framed = options.framed ?? true;
    const reader = new CoreLinkReader(link.inbound);
    try {
      const request = { jsonrpc: "2.0", id: 0, method: "hello", params: { framed, generation: coreProtocolGeneration } };
      if (!link.send(lineBytes(coreJSONBytes(request)))) {
        throw new CoreConnectionError({ kind: "closed", reason: "the link closed before hello" });
      }
      const { reply, rest } = await withCoreDeadline(options.timeoutSeconds ?? 20, "hello", () => reader.helloReply());
      const error = member(reply, "error");
      if (error !== undefined && error !== null) {
        const rpc = CoreRPCError.from(error);
        if (rpc.kind === "unsupported_generation") throw new CoreConnectionError({ kind: "newerGeneration", generation: null });
        throw new CoreConnectionError({ kind: "helloRefused", error: rpc });
      }
      const result = member(reply, "result");
      if (result === undefined) throw new CoreConnectionError({ kind: "badHello", detail: "no result" });
      const hello = decodeCoreHello(result);
      if (hello === null) throw new CoreConnectionError({ kind: "badHello", detail: "the reply is not a HelloResult" });
      const refusal = checkCoreHello(hello, options.required);
      if (refusal !== null) throw refusal;
      // Asked for framed mode, it is framed mode or a refusal: never a silent plain connection that attach and
      // subscribe cannot use.
      if (framed && !hello.framed) throw new CoreConnectionError({ kind: "notFramed" });
      const connection = new CoreConnection(link, hello, framed, options.notified ?? null);
      connection.startReading(reader, rest);
      return connection;
    } catch (error) {
      link.close();
      throw error;
    }
  }

  private startReading(reader: CoreLinkReader, leftover: Uint8Array): void {
    const frames = new CoreFrameDecoder();
    const lines = new CoreLineSplitter();
    const take = (bytes: Uint8Array): void => {
      if (bytes.length === 0) return;
      if (this.framed) {
        for (const frame of frames.push(bytes)) this.handle(frame);
      } else {
        for (const line of lines.push(bytes)) if (line.length > 0) this.handleMessage(line);
      }
    };
    void (async () => {
      let why = "the link ended";
      try {
        take(leftover);
        for (;;) {
          if (this.ended !== null) return;
          const chunk = await reader.next();
          if (chunk === null) break;
          take(chunk);
        }
      } catch (error) {
        if (error instanceof CoreFrameError) {
          this.finish(new CoreConnectionError({ kind: "protocolViolation", detail: error.message }));
          return;
        }
        if (error instanceof CoreLineOversizeError) {
          this.finish(new CoreConnectionError({ kind: "protocolViolation", detail: "a line over 16 MiB" }));
          return;
        }
        why = error instanceof Error ? error.message : String(error);
      }
      this.finish(new CoreConnectionError({ kind: "closed", reason: why }));
    })();
  }

  // MARK: - Calls

  /**
   * One JSON-RPC call on channel 0. Calls run side by side; each reply is matched by id. Rejects with
   * `CoreRPCError` for the core's refusal, `CoreConnectionError` when the connection ends or the time runs out.
   */
  call(method: string, params: CoreJSON | Readonly<Record<string, unknown>> = {}, timeoutSeconds: number | null = 30): Promise<CoreJSON> {
    if (this.ended !== null) return Promise.reject(this.ended);
    const id = this.nextID;
    this.nextID += 1;
    const bytes = coreJSONBytes({ jsonrpc: "2.0", id, method, params });
    return new Promise<CoreJSON>((resolve, reject) => {
      const timer =
        timeoutSeconds === null
          ? null
          : setTimeout(() => {
              const waiting = this.pending.get(id);
              if (waiting === undefined) return;
              this.pending.delete(id);
              waiting.reject(new CoreConnectionError({ kind: "timedOut", method, seconds: timeoutSeconds }));
            }, timeoutSeconds * 1000);
      this.pending.set(id, { resolve, reject, timer });
      const sent = this.framed ? this.link.send(encodeCoreFrame(CoreFrames.data(0, bytes))) : this.link.send(lineBytes(bytes));
      if (!sent) {
        this.pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        reject(this.ended ?? new CoreConnectionError({ kind: "closed", reason: "the link is closed" }));
      }
    });
  }

  /** A call whose result decodes with `decode` (a throw there is "an unexpected shape"). */
  async callAs<T>(
    method: string,
    params: CoreJSON | Readonly<Record<string, unknown>>,
    decode: (value: CoreJSON) => T,
    timeoutSeconds: number | null = 30,
  ): Promise<T> {
    const result = await this.call(method, params, timeoutSeconds);
    try {
      return decode(result);
    } catch {
      throw new CoreConnectionError({ kind: "badHello", detail: `${method} answered in an unexpected shape` });
    }
  }

  // MARK: - Streams

  /** The frames of `channel`, from the first (frames that came before this call are kept for it). Ends after `closed` or `lost`. */
  stream(channel: number): CoreQueue<CoreStreamItem> {
    const queue = new CoreQueue<CoreStreamItem>();
    if (this.ended !== null) {
      queue.push({ kind: "lost", reason: this.ended.description });
      queue.finish();
      return queue;
    }
    this.forgotten.delete(channel);
    this.expected.delete(channel);
    if (this.overflowed.delete(channel)) {
      this.dropEarly(channel);
      queue.push({ kind: "lost", reason: "more output came before the terminal was read than the app keeps" });
      queue.finish();
      return queue;
    }
    this.earlyBytes.delete(channel);
    const kept = this.early.get(channel) ?? [];
    this.early.delete(channel);
    for (const item of kept) {
      queue.push(item);
      if (item.kind === "closed") {
        queue.finish();
        return queue;
      }
    }
    this.routes.set(channel, queue);
    return queue;
  }

  /** Stops routing `channel` (its frames after this are dropped). */
  forget(channel: number): void {
    const route = this.routes.get(channel);
    this.routes.delete(channel);
    route?.finish();
    this.dropEarly(channel);
    this.uncredited.delete(channel);
    this.expected.delete(channel);
    this.overflowed.delete(channel);
    this.forgotten.add(channel);
  }

  private dropEarly(channel: number): void {
    this.early.delete(channel);
    this.earlyBytes.delete(channel);
  }

  /** The stream a reply's result opened (`AttachResult`, `SubscribeResult`). */
  private static channelOpened(result: CoreJSON | undefined): number | null {
    const value = jsonU64(member(result, "channel"));
    if (value === undefined || typeof value !== "number" || value <= 0 || value > 0xffffffff) return null;
    return value;
  }

  /** Channels with frames kept for a reader that has not come (tests). */
  get earlyChannels(): number {
    return this.early.size;
  }

  /** Bytes kept for readers that have not come, all channels (tests). */
  get earlyKeptBytes(): number {
    let total = 0;
    for (const bytes of this.earlyBytes.values()) total += bytes;
    return total;
  }

  get earlyKeptItems(): number {
    let total = 0;
    for (const items of this.early.values()) total += items.length;
    return total;
  }

  /** Sends one frame. False once the connection is closed. A CREDIT is counted against its stream. */
  send(frame: CoreFrame): boolean {
    const sent = this.link.send(encodeCoreFrame(frame));
    const amount = frame.channel === 0 ? null : creditAmount(frame);
    const owed = amount === null ? undefined : this.uncredited.get(frame.channel);
    if (sent && amount !== null && owed !== undefined) this.uncredited.set(frame.channel, owed - amount);
    return sent;
  }

  /** DATA bytes a stream holds beyond what was credited back (tests). */
  uncreditedBytes(channel: number): number {
    return this.uncredited.get(channel) ?? 0;
  }

  // MARK: - Ending

  /** The connection's end, once it comes. */
  closed(): Promise<CoreConnectionError> {
    if (this.ended !== null) return Promise.resolve(this.ended);
    return new Promise((resolve) => this.endWaiters.push(resolve));
  }

  get isClosed(): boolean {
    return this.ended !== null;
  }

  /** Why it ended (null while open). */
  get ending(): CoreConnectionError | null {
    return this.ended;
  }

  /** Closes the link: every call waiting fails and every stream ends with `lost`. */
  close(reason = "closed by the app"): void {
    this.link.close();
    this.finish(new CoreConnectionError({ kind: "closed", reason }));
  }

  private finish(error: CoreConnectionError): void {
    if (this.ended !== null) return;
    this.ended = error;
    this.link.close();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const waiting of pending) {
      if (waiting.timer !== null) clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    const routes = [...this.routes.values()];
    this.routes.clear();
    for (const route of routes) {
      route.push({ kind: "lost", reason: error.description });
      route.finish();
    }
    this.early.clear();
    this.earlyBytes.clear();
    this.expected.clear();
    this.overflowed.clear();
    this.uncredited.clear();
    const waiters = this.endWaiters.splice(0);
    for (const waiter of waiters) waiter(error);
  }

  // MARK: - Inbound

  private handle(frame: CoreFrame): void {
    if (this.ended !== null) return;
    if (frame.channel === 0) {
      if (frame.kind === CoreFrameKind.data) this.handleMessage(frame.payload);
      return;
    }
    let item: CoreStreamItem;
    switch (frame.kind) {
      case CoreFrameKind.data:
        // An empty DATA carries nothing (a paint always has bytes): dropped before it is counted,
        // kept or routed.
        if (frame.payload.length === 0) return;
        item = { kind: "data", bytes: frame.payload };
        break;
      case CoreFrameKind.close:
        item = { kind: "closed", reason: frame.payload.length === 0 ? {} : (tryParseCoreJSON(frame.payload) ?? {}) };
        break;
      case CoreFrameKind.resize: {
        const grid = resizeGrid(frame);
        if (grid === null) return;
        item = { kind: "resize", cols: grid.cols, rows: grid.rows };
        break;
      }
      default:
        // Viewer-to-core kinds; a core never sends them to a viewer.
        return;
    }
    const route = this.routes.get(frame.channel);
    const kept = route !== undefined || (this.expected.has(frame.channel) && !this.overflowed.has(frame.channel));
    if (kept && item.kind === "data" && !this.withinCredit(frame.channel, item.bytes.length)) return;
    if (route !== undefined) {
      // Items count as well as bytes; a stream its reader leaves this far behind ends the
      // connection as a credit overrun does.
      if (item.kind !== "closed" && route.pendingCount >= CoreConnection.routeItemLimit) {
        this.finish(
          new CoreConnectionError({ kind: "protocolViolation", detail: `channel ${frame.channel} holds ${route.pendingCount} items its reader has not taken` }),
        );
        return;
      }
      route.push(item);
      if (item.kind === "closed") {
        route.finish();
        this.routes.delete(frame.channel);
        this.uncredited.delete(frame.channel);
      }
    } else if (this.forgotten.has(frame.channel)) {
      // Over for this side; its CLOSE ends it for the core too.
      if (item.kind === "closed") this.forgotten.delete(frame.channel);
    } else if (this.expected.has(frame.channel) && !this.overflowed.has(frame.channel)) {
      const size = frame.payload.length;
      if (this.earlyKeptBytes + size > CoreConnection.earlyLimit || this.earlyKeptItems >= CoreConnection.earlyItemLimit) {
        this.overflowed.add(frame.channel);
        this.dropEarly(frame.channel);
        this.uncredited.delete(frame.channel);
        return;
      }
      this.earlyBytes.set(frame.channel, (this.earlyBytes.get(frame.channel) ?? 0) + size);
      const list = this.early.get(frame.channel);
      if (list === undefined) this.early.set(frame.channel, [item]);
      else list.push(item);
    }
    // Otherwise no reply opened it: for nobody (an unknown CLOSE included), dropped.
  }

  private handleMessage(bytes: Uint8Array): void {
    const message = tryParseCoreJSON(bytes);
    if (message === undefined || jsonObject(message) === undefined) return;
    const id = jsonInt(member(message, "id"));
    const method = member(message, "method");
    if (id !== undefined && method === undefined) {
      const error = member(message, "error");
      const errorIsNull = error === undefined || error === null;
      const opened = errorIsNull ? CoreConnection.channelOpened(member(message, "result")) : null;
      const waiting = typeof id === "number" ? this.pending.get(id) : undefined;
      if (waiting === undefined) {
        // A reply nobody waits for any more (timed out): a stream it opened is closed at once, never kept.
        if (opened !== null && typeof id === "number" && id > 0 && id < this.nextID) {
          this.forgotten.add(opened);
          this.dropEarly(opened);
          this.link.send(encodeCoreFrame(coreFrame(opened, CoreFrameKind.close)));
        }
        return;
      }
      this.pending.delete(id as number);
      if (waiting.timer !== null) clearTimeout(waiting.timer);
      if (opened !== null) this.expected.add(opened);
      if (!errorIsNull) waiting.reject(CoreRPCError.from(error));
      else waiting.resolve(member(message, "result") ?? null);
      return;
    }
    // A notification is for nobody in the app; dropped, never kept (tests may see it).
    if (method !== undefined) this.notified?.(message);
  }

  /**
   * Counts `bytes` more DATA on a kept or routed stream; false (and the connection ends as a
   * protocol violation) when that goes past its window, the credit sent back and `streamOverrun`: the core ignores
   * credit, and nothing more of it is kept.
   */
  private withinCredit(channel: number, bytes: number): boolean {
    const owed = (this.uncredited.get(channel) ?? 0) + bytes;
    if (owed > CoreConnection.streamWindow + CoreConnection.streamOverrun) {
      this.finish(new CoreConnectionError({ kind: "protocolViolation", detail: `channel ${channel} got ${owed} bytes more than it was credited` }));
      return false;
    }
    this.uncredited.set(channel, owed);
    return true;
  }
}

function lineBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 10;
  return out;
}

/**
 * Reads the link's chunks for the connection: first the hello reply line (skipping anything else a login shell
 * printed before `hc connect` ran), then raw chunks.
 */
export class CoreLinkReader {
  /** Bytes skipped before the hello reply, at most. */
  static readonly maximumPreamble = 64 * 1024;
  private buffer = new Uint8Array(0);

  constructor(private readonly inbound: CoreQueue<Uint8Array>) {}

  next(): Promise<Uint8Array | null> {
    return this.inbound.take();
  }

  /** The hello reply (the first line that is a JSON-RPC answer to id 0) and the bytes after its newline. */
  async helloReply(): Promise<{ reply: CoreJSON; rest: Uint8Array }> {
    let skipped = 0;
    for (;;) {
      let newline = this.buffer.indexOf(10);
      while (newline >= 0) {
        let line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
        const message = tryParseCoreJSON(line);
        if (message !== undefined && jsonInt(member(message, "id")) === 0) return { reply: message, rest: this.buffer.slice() };
        skipped += line.length + 1;
        if (skipped > CoreLinkReader.maximumPreamble) {
          throw new CoreConnectionError({ kind: "badHello", detail: "no hello reply in the first 64 KB" });
        }
        newline = this.buffer.indexOf(10);
      }
      const chunk = await this.inbound.take();
      if (chunk === null) throw new CoreConnectionError({ kind: "closed", reason: "the link ended before hello answered" });
      const joined = new Uint8Array(this.buffer.length + chunk.length);
      joined.set(this.buffer);
      joined.set(chunk, this.buffer.length);
      this.buffer = joined;
      if (this.buffer.length > CoreLinkReader.maximumPreamble + 1024 * 1024) {
        throw new CoreConnectionError({ kind: "badHello", detail: "no hello reply line" });
      }
    }
  }
}

/** Runs `work`, failing with a `timedOut` CoreConnectionError after `seconds`. */
export function withCoreDeadline<T>(seconds: number, method: string, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CoreConnectionError({ kind: "timedOut", method, seconds })), seconds * 1000);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
