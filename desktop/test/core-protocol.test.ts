// The herdr-core connection: its frames and JSON-RPC, ported from
// CoreProtocolTests.swift (herdr-core schema/README.md
// "Connecting", "Framed mode"; hc.openrpc.json).

import { describe, expect, it } from "vitest";

import {
  CoreFrameDecoder,
  CoreFrameError,
  CoreFrameKind,
  CoreFrames,
  CoreLineSplitter,
  coreFrame,
  coreFrameMaximumPayload,
  creditAmount,
  encodeCoreFrame,
  resizeGrid,
  writeLE32,
  type CoreFrame,
} from "../src/main/herdr/core-frames";
import { coreJSONBytes, coreJSONString, member, parseCoreJSON, utf8Bytes, type CoreJSON } from "../src/main/herdr/core-json";
import { CoreConnection, CoreConnectionError, CoreRPCError, type CoreStreamItem } from "../src/main/herdr/core-connection";
import { CoreFixtures, CoreTestLink, at, eventually } from "./support/core-test-link";

const text = (value: string): Uint8Array => utf8Bytes(value);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const plain = (frames: CoreFrame[]): { channel: number; kind: number; payload: number[] }[] =>
  frames.map((frame) => ({ channel: frame.channel, kind: frame.kind, payload: [...frame.payload] }));

async function drain(stream: AsyncIterable<CoreStreamItem>): Promise<CoreStreamItem[]> {
  const items: CoreStreamItem[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

async function openFramed(): Promise<{ connection: CoreConnection; link: CoreTestLink }> {
  const link = new CoreTestLink();
  const opened = CoreConnection.open(link);
  await link.waitForSent(1);
  link.deliver(CoreFixtures.helloReplyLine());
  return { connection: await opened, link };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("frames", () => {
  it("every frame kind round-trips", () => {
    const frames: CoreFrame[] = [
      CoreFrames.data(0, text('{"jsonrpc":"2.0","id":1,"method":"terminal.list","params":{}}')),
      CoreFrames.credit(7, 262_144),
      coreFrame(7, CoreFrameKind.close, text('{"reason":"exited","exit_code":0,"signal":null}')),
      CoreFrames.resize(7, 132, 43),
      CoreFrames.focus(7, true),
      coreFrame(7, CoreFrameKind.facts, text('{"cell":[9,18]}')),
      CoreFrames.data(4_294_967_295, new Uint8Array(0)),
    ];
    const decoder = new CoreFrameDecoder();
    expect(plain(decoder.push(concat(...frames.map(encodeCoreFrame))))).toEqual(plain(frames));
    expect(decoder.pendingByteCount).toBe(0);
  });

  it("the header is channel, kind, length, little-endian", () => {
    expect([...encodeCoreFrame(CoreFrames.data(0x01020304, Uint8Array.of(0xaa, 0xbb)))]).toEqual([
      0x04, 0x03, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb,
    ]);
    expect([...CoreFrames.credit(1, 256 * 1024).payload]).toEqual([0x00, 0x00, 0x04, 0x00]);
    expect([...CoreFrames.resize(1, 0x0102, 0x0304).payload]).toEqual([0x02, 0x01, 0x04, 0x03]);
    expect([...CoreFrames.focus(1, false).payload]).toEqual([0]);
    expect(creditAmount(CoreFrames.credit(1, 99))).toBe(99);
    expect(resizeGrid(CoreFrames.resize(1, 80, 24))?.cols).toBe(80);
  });

  it("frames split across reads, and several in one read", () => {
    const frames: CoreFrame[] = [
      CoreFrames.data(0, text("one")),
      CoreFrames.data(3, new Uint8Array(40).fill(0x0a)),
      CoreFrames.credit(3, 5),
      coreFrame(3, CoreFrameKind.close),
    ];
    const bytes = concat(...frames.map(encodeCoreFrame));
    // Byte by byte.
    const decoder = new CoreFrameDecoder();
    const got: CoreFrame[] = [];
    for (const byte of bytes) got.push(...decoder.push(Uint8Array.of(byte)));
    expect(plain(got)).toEqual(plain(frames));
    // Every two-way split.
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const split = new CoreFrameDecoder();
      const first = split.push(bytes.subarray(0, cut));
      const second = split.push(bytes.subarray(cut));
      expect(plain([...first, ...second]), `cut at ${cut}`).toEqual(plain(frames));
    }
    // All in one read.
    expect(plain(new CoreFrameDecoder().push(bytes))).toEqual(plain(frames));
  });

  it("an oversize frame is refused and the decoder stays refused; exactly 16 MiB waits for its payload", () => {
    const header = new Uint8Array(9);
    writeLE32(header, 0, 9);
    header[4] = CoreFrameKind.data;
    writeLE32(header, 5, coreFrameMaximumPayload + 1);
    const decoder = new CoreFrameDecoder();
    let error: unknown;
    try {
      decoder.push(header);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(CoreFrameError);
    expect((error as CoreFrameError).fault).toEqual({ kind: "oversize", channel: 9, length: coreFrameMaximumPayload + 1 });
    expect(() => decoder.push(encodeCoreFrame(CoreFrames.data(0, new Uint8Array(0)))), "refused for good").toThrow(CoreFrameError);

    const atLimit = new Uint8Array(9);
    writeLE32(atLimit, 0, 1);
    atLimit[4] = 0;
    writeLE32(atLimit, 5, coreFrameMaximumPayload);
    const ok = new CoreFrameDecoder();
    expect(ok.push(atLimit)).toEqual([]);
    expect(ok.pendingByteCount).toBe(9);
  });

  it("an unknown kind is refused", () => {
    const bytes = encodeCoreFrame(CoreFrames.data(1, Uint8Array.of(1)));
    bytes[4] = 9;
    let error: unknown;
    try {
      new CoreFrameDecoder().push(bytes);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as CoreFrameError).fault).toEqual({ kind: "unknownKind", byte: 9 });
  });

  it("lines split anywhere; a line over the limit is refused", () => {
    const lines = new CoreLineSplitter();
    expect(lines.push(text('{"a":1}\r\n{"b')).map((line) => coreJSONString(parseCoreJSON(line)))).toEqual(['{"a":1}']);
    expect(lines.push(text('":2}\n')).map((line) => coreJSONString(parseCoreJSON(line)))).toEqual(['{"b":2}']);
    const small = new CoreLineSplitter(4);
    expect(() => small.push(text("12345"))).toThrow();
  });

  it("JSON keeps integers exact and bools apart", () => {
    const value = parseCoreJSON('{"seq":9007199254740993,"ok":true,"one":1,"f":1.5,"n":null,"s":"x","a":[1,"2"],"u":18446744073709551615}');
    expect(member(value, "seq")).toBe(9_007_199_254_740_993n);
    expect(member(value, "ok")).toBe(true);
    expect(member(value, "one")).toBe(1);
    expect(member(value, "f")).toBe(1.5);
    expect(member(value, "n")).toBe(null);
    expect(member(value, "a")).toEqual([1, "2"]);
    expect(member(value, "u")).toBe(18_446_744_073_709_551_615n);
    expect(parseCoreJSON(coreJSONBytes(value))).toEqual(value);
    expect(coreJSONString({ turn: 18_446_744_073_709_551_615n })).toBe('{"turn":18446744073709551615}');
  });
});

describe("JSON-RPC over the framed connection", () => {
  it("hello switches to framed mode; calls run side by side, matched by id", async () => {
    const link = new CoreTestLink();
    // The app keeps no notifications; the test-only `notified` sees them.
    const notes: CoreJSON[] = [];
    const opened = CoreConnection.open(link, { notified: (message) => notes.push(message) });
    await link.waitForSent(1);
    const hello = link.split().hello;
    expect(at(hello, "method")).toBe("hello");
    expect(at(hello, "params", "framed")).toBe(true);
    expect(at(hello, "params", "generation")).toBe(1);
    // The reply line and the first frame after it in one read (a stream frame no reply opened is for nobody,
    // so the frame here is a channel-0 notification).
    const early = { jsonrpc: "2.0", method: "heartbeat", params: { seq: 7 } };
    link.deliver(concat(text(CoreFixtures.helloReplyLine()), encodeCoreFrame(CoreFrames.data(0, coreJSONBytes(early)))));
    const connection = await opened;
    expect(connection.framed).toBe(true);
    expect(connection.hello.version).toBe("0.1.16");
    expect(connection.hello.core.name).toBe("studio");

    const first = connection.call("terminal.get", { terminal: "t1" });
    const second = connection.call("terminal.get", { terminal: "t2" });
    const requests = await link.waitForRequests(2);
    expect(requests).toHaveLength(2);
    const idFor = (terminal: string): CoreJSON | undefined => at(requests.find((request) => at(request, "params", "terminal") === terminal), "id");
    // Replies out of order: t2's first.
    link.deliverJson({ jsonrpc: "2.0", id: idFor("t2"), result: { address: "t2" } });
    link.deliverJson({ jsonrpc: "2.0", id: idFor("t1"), result: { address: "t1" } });
    expect(at(await first, "address")).toBe("t1");
    expect(at(await second, "address")).toBe("t2");

    // The frame that came with the hello reply was read, not lost.
    expect(at(notes[0] ?? null, "params", "seq")).toBe(7);
  });

  it("errors keep their kind and hint", async () => {
    const { connection, link } = await openFramed();
    const call = connection.call("terminal.send", { terminal: "t9", text: "hi" });
    const [request] = await link.waitForRequests(1);
    link.deliverJson({
      jsonrpc: "2.0",
      id: at(request, "id"),
      error: { code: -32000, message: "no terminal t9", data: { kind: "not_found", hint: "see hc ls" } },
    });
    const error = (await rejection(call)) as CoreRPCError;
    expect(error).toBeInstanceOf(CoreRPCError);
    expect(error.code).toBe(-32000);
    expect(error.kind).toBe("not_found");
    expect(error.hint).toBe("see hc ls");
    expect(error.description).toBe("no terminal t9 (see hc ls)");
  });

  it("a newer generation is refused in plain words, and the link closed", async () => {
    const link = new CoreTestLink();
    const opened = CoreConnection.open(link);
    await link.waitForSent(1);
    link.deliver(CoreFixtures.helloReplyLine(CoreFixtures.helloResult({ generation: 2 })));
    const error = (await rejection(opened)) as CoreConnectionError;
    expect(error.fault).toEqual({ kind: "newerGeneration", generation: 2 });
    expect(error.description.startsWith("This Mac runs a newer herdr-core than this app understands")).toBe(true);
    expect(link.isClosed).toBe(true);
  });

  it("an unsupported_generation error, an older generation and missing methods", async () => {
    const refused = new CoreTestLink();
    const a = CoreConnection.open(refused);
    await refused.waitForSent(1);
    refused.deliver(
      `${coreJSONString({ jsonrpc: "2.0", id: 0, error: { code: -32000, message: "unsupported_generation", data: { kind: "unsupported_generation" } } })}\n`,
    );
    expect(((await rejection(a)) as CoreConnectionError).fault).toEqual({ kind: "newerGeneration", generation: null });

    const older = new CoreTestLink();
    const b = CoreConnection.open(older);
    await older.waitForSent(1);
    older.deliver(CoreFixtures.helloReplyLine(CoreFixtures.helloResult({ generation: 0 })));
    expect(((await rejection(b)) as CoreConnectionError).fault).toEqual({ kind: "olderGeneration", generation: 0 });

    const thin = new CoreTestLink();
    const c = CoreConnection.open(thin);
    await thin.waitForSent(1);
    thin.deliver(CoreFixtures.helloReplyLine(CoreFixtures.helloResult({ methods: ["hello", "terminal.list"] })));
    const fault = ((await rejection(c)) as CoreConnectionError).fault;
    expect(fault.kind).toBe("missingMethods");
    expect(fault.kind === "missingMethods" && fault.methods.includes("terminal.attach")).toBe(true);
  });

  it("hello skips what a login shell printed first", async () => {
    const link = new CoreTestLink();
    const opened = CoreConnection.open(link);
    await link.waitForSent(1);
    link.deliver('Last login: Sun Nov  1 on ttys001\nwelcome\n{"not":"ours"}\n');
    link.deliver(CoreFixtures.helloReplyLine());
    expect((await opened).hello.generation).toBe(1);
  });

  it("plain mode is one message per line; notifications go to notifications", async () => {
    const link = new CoreTestLink();
    const notes: CoreJSON[] = [];
    const opened = CoreConnection.open(link, { framed: false, notified: (message) => notes.push(message) });
    await link.waitForSent(1);
    link.deliver(CoreFixtures.helloReplyLine(CoreFixtures.helloResult({ framed: false })));
    const connection = await opened;
    expect(connection.framed).toBe(false);
    const helloBytes = link.sentBytes.length;
    const listed = connection.call("terminal.list", {});
    await link.waitForSent(helloBytes + 10);
    const sentText = new TextDecoder().decode(link.sentBytes.subarray(helloBytes));
    expect(sentText.endsWith("\n")).toBe(true);
    const request = parseCoreJSON(sentText);
    expect(at(request, "method")).toBe("terminal.list");
    link.deliver(`${coreJSONString({ jsonrpc: "2.0", id: at(request, "id"), result: { terminals: [], hidden_finished: 0, machines: [] } })}\n`);
    expect(at(await listed, "hidden_finished")).toBe(0);
    link.deliver('{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":42}}\n');
    expect(await eventually(() => notes.length === 1)).toBe(true);
    expect(at(notes[0] ?? null, "params", "seq")).toBe(42);
  });

  it("a CLOSE from the core ends its stream with the reason", async () => {
    const { connection, link } = await openFramed();
    const stream = connection.stream(3);
    link.deliverFrame(CoreFrames.data(3, Uint8Array.of(1, 2, 3)));
    link.deliverFrame(coreFrame(3, CoreFrameKind.close, text('{"reason":"exited","exit_code":0,"signal":null}')));
    const items = await drain(stream);
    expect(items.map((item) => (item.kind === "data" ? { kind: "data", bytes: [...item.bytes] } : item))).toEqual([
      { kind: "data", bytes: [1, 2, 3] },
      { kind: "closed", reason: { reason: "exited", exit_code: 0, signal: null } },
    ]);
  });

  it("the link ending fails calls and ends streams", async () => {
    const { connection, link } = await openFramed();
    const stream = connection.stream(4);
    const call = connection.call("terminal.list");
    await link.waitForRequests(1);
    link.end();
    expect(((await rejection(call)) as CoreConnectionError).fault.kind).toBe("closed");
    const items = await drain(stream);
    expect(items.at(-1)?.kind).toBe("lost");
    expect((await connection.closed()).fault.kind).toBe("closed");
    await expect(connection.call("terminal.list")).rejects.toBeInstanceOf(CoreConnectionError);
  });

  it("an oversize frame closes the connection", async () => {
    const { connection, link } = await openFramed();
    const call = connection.call("terminal.list");
    await link.waitForRequests(1);
    const header = new Uint8Array(9);
    writeLE32(header, 0, 0);
    header[4] = 0;
    writeLE32(header, 5, coreFrameMaximumPayload + 1);
    link.deliver(header);
    expect(((await rejection(call)) as CoreConnectionError).fault.kind).toBe("protocolViolation");
    expect(link.isClosed).toBe(true);
  });

  it("a call without an answer times out", async () => {
    const { connection } = await openFramed();
    const error = (await rejection(connection.call("terminal.list", {}, 0.05))) as CoreConnectionError;
    expect(error.fault).toEqual({ kind: "timedOut", method: "terminal.list", seconds: 0.05 });
  });
});
