// The TS port of the iPhone app's CoreTestLink.swift. A byte link
// a test drives by hand: what the app sent comes out of `split()` /
// `requests()`; what the core says goes in with `deliver`.

import { CoreFrameDecoder, CoreFrameKind, encodeCoreFrame, type CoreFrame, CoreFrames } from "../../src/main/herdr/core-frames";
import { coreJSONBytes, coreJSONString, member, tryParseCoreJSON, utf8Bytes, type CoreJSON } from "../../src/main/herdr/core-json";
import type { CoreLink } from "../../src/main/herdr/core-connection";
import { CoreQueue } from "../../src/main/herdr/core-queue";

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` (awaited when it is async) every 5 ms, up to `tries` times (2 s by default). */
export async function eventually<T>(check: () => T | null | undefined | false | Promise<T | null | undefined | false>, tries = 400): Promise<T | null> {
  for (let index = 0; index < tries; index += 1) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    await pause(5);
  }
  return null;
}

export class CoreTestLink implements CoreLink {
  readonly inbound = new CoreQueue<Uint8Array>();
  private sent: number[] = [];
  private closedFlag = false;
  private waiters: { count: number; resolve: () => void }[] = [];
  private answeredHello = false;

  /** Answered at once when the app's hello line arrives (null: the test answers). */
  constructor(readonly autoHello: CoreJSON | null = null) {}

  send(bytes: Uint8Array): boolean {
    if (this.closedFlag) return false;
    for (const byte of bytes) this.sent.push(byte);
    const count = this.sent.length;
    const ready = this.waiters.filter((waiter) => waiter.count <= count);
    this.waiters = this.waiters.filter((waiter) => waiter.count > count);
    const answer = !this.answeredHello && this.autoHello !== null && this.sent.includes(10);
    if (answer) this.answeredHello = true;
    for (const waiter of ready) waiter.resolve();
    if (answer) this.deliver(`${coreJSONString({ jsonrpc: "2.0", id: 0, result: this.autoHello })}\n`);
    return true;
  }

  close(): void {
    this.closedFlag = true;
    const all = this.waiters.splice(0);
    for (const waiter of all) waiter.resolve();
    this.inbound.finish();
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  deliver(input: Uint8Array | string | readonly number[]): void {
    this.inbound.push(typeof input === "string" ? utf8Bytes(input) : input instanceof Uint8Array ? input : Uint8Array.from(input));
  }

  deliverFrame(frame: CoreFrame): void {
    this.deliver(encodeCoreFrame(frame));
  }

  deliverJson(json: unknown, channel = 0): void {
    this.deliverFrame(CoreFrames.data(channel, coreJSONBytes(json)));
  }

  end(error?: unknown): void {
    this.inbound.finish(error);
  }

  get sentBytes(): Uint8Array {
    return Uint8Array.from(this.sent);
  }

  /** Waits until at least `count` bytes were sent (or the link closed). */
  waitForSent(count: number): Promise<void> {
    if (this.sent.length >= count || this.closedFlag) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  /** The hello line the app sent first, and the frames after it. */
  split(): { hello: CoreJSON | undefined; frames: CoreFrame[] } {
    const bytes = this.sentBytes;
    const newline = bytes.indexOf(10);
    if (newline < 0) return { hello: undefined, frames: [] };
    const hello = tryParseCoreJSON(bytes.subarray(0, newline));
    let frames: CoreFrame[] = [];
    try {
      frames = new CoreFrameDecoder().push(bytes.subarray(newline + 1));
    } catch {
      frames = [];
    }
    return { hello, frames };
  }

  /** Waits for the n-th frame after hello (0-based) and returns it. */
  async frame(index: number): Promise<CoreFrame | null> {
    return eventually(() => this.split().frames[index]);
  }

  /** The JSON-RPC requests sent on channel 0 so far. */
  requests(): CoreJSON[] {
    return this.split()
      .frames.filter((frame) => frame.channel === 0 && frame.kind === CoreFrameKind.data)
      .flatMap((frame) => {
        const json = tryParseCoreJSON(frame.payload);
        return json === undefined ? [] : [json];
      });
  }

  /** Waits until `count` requests went out. */
  async waitForRequests(count: number): Promise<CoreJSON[]> {
    return (await eventually(() => (this.requests().length >= count ? this.requests() : null))) ?? this.requests();
  }
}

export const CoreFixtures = {
  /** A HelloResult as hc.openrpc.json :301-339 has it (every required field). */
  helloResult(options: { generation?: number; framed?: boolean; methods?: readonly string[] } = {}): CoreJSON {
    const all = options.methods ?? [
      "hello",
      "server.status",
      "terminal.run",
      "terminal.list",
      "terminal.get",
      "terminal.kill",
      "terminal.rm",
      "terminal.keep",
      "terminal.label",
      "terminal.read",
      "terminal.attach",
      "terminal.send",
      "terminal.wait",
      "terminal.keys",
      "terminal.interrupt",
      "doc.get",
      "doc.set",
      "events.subscribe",
      "machine.list",
    ];
    return {
      generation: options.generation ?? 1,
      version: "0.1.16",
      core: { id: "c0ffee", name: "studio" },
      framed: options.framed ?? true,
      methods: [...all],
      features: ["resize_notifications"],
    };
  },

  helloReplyLine(result: CoreJSON = CoreFixtures.helloResult()): string {
    return `${coreJSONString({ jsonrpc: "2.0", id: 0, result })}\n`;
  },
};

/** `json[key]` for test reads. */
export function at(json: CoreJSON | undefined, ...path: (string | number)[]): CoreJSON | undefined {
  let value = json;
  for (const key of path) {
    if (typeof key === "number") value = Array.isArray(value) ? (value as CoreJSON[])[key] : undefined;
    else value = member(value, key);
  }
  return value;
}
