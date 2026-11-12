// The Mac side's size bounds on untrusted input.
//   Relay replies: a relay reply is checked against its request before anything is decoded or allocated: the offset
//     and `max` asked, safe whole counters, strict base64, kept-plus-omitted coverage within the request's maximum
//     and the 4 MiB read / 256 KB grew caps, an end within the safe whole numbers and the file's size. A refused
//     read fails as a broken relay's does (RelayReplyError); a refused grew ends its watch (the feed reads instead).
//   The launch cache: it keeps each chat within 1 MiB encoded (texts capped, long ids left out), the topology
//     within 2 MiB and the file within 6 MiB, and a file over 6 MiB on disk is neither read nor parsed at launch.
//   Partial lines: a partial line held over several reads keeps the omission ranges of every read since its start.
// Synthetic data only; fake relay pipes, no SSH, no socket.

import { createHash } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SshTranscriptReader } from "../src/main/chat/ssh-reader";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { RelayClient, RelayReplyError, type RelayWatchSink } from "../src/main/herdr/relay";
import * as launchCache from "../src/main/launch-cache";
import { diskCacheFiles, LaunchCache, type CacheFiles } from "../src/main/launch-cache";
import { blobMark, type BlobRange } from "../src/shared/chat/blobs";
import { TranscriptFollower } from "../src/shared/chat/follower";
import type { ChatItem, ChatTimeline, ChatTurn } from "../src/shared/chat/model";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const MiB = 1_048_576;
/** The launch cache's budgets (launch-cache.ts): per chat, topology and machine file. */
const chatBudget = MiB;
const topologyBudget = 2 * MiB;
const hostBudget = 6 * MiB;
const transcript = "/synthetic/transcript.jsonl";
const b64 = (text: string | Uint8Array): string => Buffer.from(text).toString("base64");

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

type Reply = Record<string, unknown> | string;
type Answer = (frame: Record<string, unknown>) => Reply | Reply[] | null;

/** A relay channel in memory: each frame the client writes is answered by `answer` (objects as JSON, strings as raw lines). */
function fakeRelay(answer: Answer) {
  const frames: Record<string, unknown>[] = [];
  const client: RelayClient = new RelayClient(
    {
      write: (raw: string) => {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        frames.push(frame);
        const reply = answer(frame);
        if (reply === null) return;
        for (const one of Array.isArray(reply) ? reply : [reply]) {
          const line = (typeof one === "string" ? one : JSON.stringify(one)) + "\n";
          queueMicrotask(() => client.data(Buffer.from(line)));
        }
      },
      close: () => undefined,
    },
    "/fake/sec-mac.sock",
  );
  client.data(Buffer.from('{"relay":"hello","v":1}\n'));
  return { client, frames };
}

function readerOver(client: RelayClient): SshTranscriptReader {
  return new SshTranscriptReader(
    { host: "fixture.invalid", port: 22, username: "fixture", privateKeyPath: "", herdrSession: "default" },
    new PinningHostKeyPolicy(new MemoryPinStore()),
    { relay: async () => client, timeoutMs: 20 },
  );
}

async function outcome<T>(promise: Promise<T>): Promise<T | Error> {
  try {
    return await promise;
  } catch (error) {
    return error as Error;
  }
}

/**
 * `work` runs with every `new Uint8Array(n)` over 16 MiB refused (and its size noted) instead of
 * allocated, so a missing bound shows as a noted size, never as gigabytes taken.
 */
async function refusingLargeArrays<T>(work: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; large: number[] }> {
  const Real = globalThis.Uint8Array;
  const large: number[] = [];
  globalThis.Uint8Array = new Proxy(Real, {
    construct(target, args: unknown[], newTarget) {
      if (typeof args[0] === "number" && args[0] > 16 * MiB) {
        large.push(args[0]);
        throw new RangeError("the test refused a large allocation");
      }
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  try {
    const [result] = await Promise.allSettled([work()]);
    await settle();
    return { result: result!, large };
  } finally {
    globalThis.Uint8Array = Real;
  }
}

/** One read on a fresh relay: `reply` merged over a good answer to the frame, or a raw line built from it. */
async function readOnce(reply: Record<string, unknown> | ((frame: Record<string, unknown>) => string), ask: { offset?: number; max?: number; omit?: number; tail?: number } = {}) {
  const { client } = fakeRelay((frame) => {
    if (frame["relay"] !== "read") return null;
    if (typeof reply === "function") return reply(frame);
    return { relay: "read", id: frame["id"], size: 10, ino: 7, offset: frame["offset"] ?? 0, data: "", ...reply };
  });
  const fields = { ...(ask.omit === undefined ? {} : { omit: ask.omit }), ...(ask.tail === undefined ? {} : { tail: ask.tail }) };
  return outcome(client.read(transcript, ask.offset ?? 0, ask.max ?? 4, 1_000, fields));
}

/** A watch on a fresh relay from `offset`, answered with `frames` (each built from the watch frame); what its sink heard. */
async function watchOnce(offset: number, frames: ((watch: Record<string, unknown>) => Reply)[], omit?: number) {
  const relay = fakeRelay((frame) => (frame["relay"] === "watch" ? frames.map((make) => make(frame)) : null));
  const events: string[] = [];
  const sink: RelayWatchSink = {
    grew: (at, size, data, omitted) => events.push(`grew ${at} ${size} ${data.length}${omitted === undefined ? "" : ` ${JSON.stringify(omitted)}`}`),
    reset: (size, ino) => events.push(`reset ${size} ${ino}`),
    gone: () => events.push("gone"),
    ended: () => events.push("ended"),
  };
  relay.client.watch(transcript, offset, sink, omit);
  await settle();
  return { events, unwatched: relay.frames.some((frame) => frame["relay"] === "unwatch"), up: relay.client.up };
}

const grew = (fields: Record<string, unknown>) => (watch: Record<string, unknown>): Reply => ({ relay: "grew", id: watch["id"], ...fields });

describe("a relay reply is bounded before anything is allocated", () => {
  it("a one-byte read answered with omitted [[0, 2147483648]] allocates nothing large and fails the read", async () => {
    let first = true;
    const { client, frames } = fakeRelay((frame) => {
      if (frame["relay"] !== "read") return null;
      if (first) {
        first = false;
        return { relay: "read", id: frame["id"], size: 2_147_483_649, ino: 7, offset: 0, data: "", omitted: [[0, 2_147_483_648]] };
      }
      return { relay: "read", id: frame["id"], size: 2, ino: 7, offset: 0, data: b64("{\n"), omitted: [] };
    });
    const reader = readerOver(client);
    const { result, large } = await refusingLargeArrays(() => reader.readWithIdentity(transcript, 0, 1, { omit: true }));
    expect(frames[0]).toMatchObject({ relay: "read", offset: 0, max: 1, omit: 1_024 });
    expect(large).toEqual([]);
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(RelayReplyError);
    // A failed read, as a broken relay's: the channel stays up and the next read is answered.
    expect(client.up).toBe(true);
    expect(await reader.readWithIdentity(transcript, 0, 2, { omit: true })).toMatchObject({ size: 2, ino: 7 });
  });

  it("safe-integer edges: 2^53 - 1 is taken; 2^53, 2^64 - 1 and an end past 2^53 - 1 are refused", async () => {
    const top = Number.MAX_SAFE_INTEGER;
    expect(await readOnce({ size: top, data: b64("A") }, { max: 1 })).toMatchObject({ size: top, offset: 0 });
    expect(await readOnce({ size: top + 1 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce((frame) => `{"relay":"read","id":${JSON.stringify(frame["id"])},"size":18446744073709551615,"ino":7,"offset":0,"data":""}`)).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ ino: top + 1 })).toBeInstanceOf(RelayReplyError);
    // The last byte a safe offset names is read; a byte after it would end past 2^53 - 1.
    expect(await readOnce({ size: top, offset: top - 1, data: b64("A") }, { offset: top - 1, max: 1 })).toMatchObject({ offset: top - 1 });
    expect(await readOnce({ size: top, offset: top, data: b64("A") }, { offset: top, max: 1 })).toBeInstanceOf(RelayReplyError);
    // A run whose length is past 2^53 - 1, and one that would end past it.
    expect(await readOnce({ size: top, omitted: [[0, top + 1]] }, { max: 4, omit: 1_024 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ size: top, offset: top - 1, omitted: [[top - 1, 2]] }, { offset: top - 1, max: 4, omit: 1_024 })).toBeInstanceOf(RelayReplyError);
    // A grew whose size is 2^53 ends its watch.
    const watched = await watchOnce(0, [grew({ offset: 0, size: top + 1, data: b64("A") })]);
    expect(watched.events).toEqual(["ended"]);
  });

  it("fractions are refused: size, offset, inode, a run's length, a grew's size", async () => {
    expect(await readOnce({ size: 10.5 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ offset: 0.5 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ ino: 7.5 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ omitted: [[0, 1_024.5]] }, { max: 4_096, omit: 1_024 })).toBeInstanceOf(RelayReplyError);
    const watched = await watchOnce(6, [grew({ offset: 6, size: 12.5, data: b64("again\n") })]);
    expect(watched.events).toEqual(["ended"]);
    expect(watched.unwatched).toBe(true);
  });

  it("negatives are refused: an inode, a size, an offset, a run, a reset's size", async () => {
    expect(await readOnce({ ino: -1 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ size: -1 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ offset: -1 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ omitted: [[-4, 2]] }, { max: 4_096, omit: 1_024 })).toBeInstanceOf(RelayReplyError);
    const watched = await watchOnce(6, [(watch) => ({ relay: "reset", id: watch["id"], size: -1, ino: 8 })]);
    expect(watched.events).toEqual(["ended"]);
    expect(watched.unwatched).toBe(true);
  });

  it("missing or invalid base64 is refused; strict base64 is decoded", async () => {
    expect(await readOnce((frame) => JSON.stringify({ relay: "read", id: frame["id"], size: 10, ino: 7, offset: 0 }))).toBeInstanceOf(RelayReplyError);
    for (const data of ["@@@@", "QQ=", "QQ==QQ==", "QQ\n==", "-_8=", " QQ==", "====", 5, null]) {
      expect(await readOnce({ data }, { max: 8 }), String(data)).toBeInstanceOf(RelayReplyError);
    }
    const read = await readOnce({ data: "QUJD" }, { max: 3 });
    expect(Buffer.from((read as { data: Uint8Array }).data).toString()).toBe("ABC");
    const watched = await watchOnce(6, [grew({ offset: 6, size: 12 })]);
    expect(watched.events).toEqual(["ended"]);
  });

  it("a tiny frame with a huge omission allocates nothing large: a 4 MiB read and a grew", async () => {
    const { client } = fakeRelay((frame) =>
      frame["relay"] === "read" ? { relay: "read", id: frame["id"], size: 2 ** 31 + 1, ino: 7, offset: 0, data: b64("{"), omitted: [[1, 2 ** 31]] } : null,
    );
    const read = await refusingLargeArrays(() => readerOver(client).readWithIdentity(transcript, 0, 4 * MiB, { omit: true }));
    expect(read.large).toEqual([]);
    expect(read.result.status).toBe("rejected");
    expect((read.result as PromiseRejectedResult).reason).toBeInstanceOf(RelayReplyError);

    const relay = fakeRelay((frame) =>
      frame["relay"] === "watch" ? { relay: "grew", id: frame["id"], offset: 6, size: 2 ** 31 + 7, data: b64("x"), omitted: [[7, 2 ** 31]] } : null,
    );
    const events: string[] = [];
    const watched = await refusingLargeArrays(async () => {
      const watch = await readerOver(relay.client).watch(transcript, 6, {
        grew: () => events.push("grew"),
        reset: () => events.push("reset"),
        gone: () => events.push("gone"),
        ended: () => events.push("ended"),
      });
      await settle();
      return watch;
    });
    expect(watched.large).toEqual([]);
    expect(events).toEqual(["ended"]);
    expect(relay.frames.filter((frame) => frame["relay"] === "unwatch")).toHaveLength(1);
    expect(relay.client.up).toBe(true);
  });

  it("a reply past the requested maximum is refused (kept bytes, runs left out, the 4 MiB cap)", async () => {
    expect(await readOnce({ data: b64("AAAAA") }, { max: 4 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ size: 2_000, data: b64("ab"), omitted: [[1, 1_024]] }, { max: 512, omit: 1_024 })).toBeInstanceOf(RelayReplyError);
    // Asking more than 4 MiB gets 4 MiB at most (the relay's cap): exactly 4 MiB is taken, one byte more is not.
    expect(await readOnce({ size: 8 * MiB, omitted: [[0, 4 * MiB]] }, { max: 8 * MiB, omit: 1_024 })).toMatchObject({ omitted: [[0, 4 * MiB]] });
    expect(await readOnce({ size: 8 * MiB, data: b64("{"), omitted: [[1, 4 * MiB]] }, { max: 8 * MiB, omit: 1_024 })).toBeInstanceOf(RelayReplyError);
    // Runs left out of a read that did not ask `omit`.
    expect(await readOnce({ omitted: [] }, { max: 4 })).toBeInstanceOf(RelayReplyError);
  });

  it("a reply from another offset than the one asked, or bytes from past the file's end, are refused", async () => {
    expect(await readOnce({ size: 20, offset: 0 }, { offset: 10 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ size: 10, offset: 10, data: b64("A") }, { offset: 10 })).toBeInstanceOf(RelayReplyError);
    // A tail read starts at max(0, size - tail); a relay that ignored `tail` (no `omitted`) read from 0.
    expect(await readOnce({ size: 10, offset: 6, data: b64("abcd"), omitted: [] }, { tail: 4, max: 4, omit: 1_024 })).toMatchObject({ offset: 6 });
    expect(await readOnce({ size: 10, offset: 0, data: b64("abcd"), omitted: [] }, { tail: 4, max: 4, omit: 1_024 })).toBeInstanceOf(RelayReplyError);
    expect(await readOnce({ size: 10, offset: 0, data: b64("abcd") }, { tail: 4, max: 4, omit: 1_024 })).toMatchObject({ offset: 0 });
  });

  it("growth past 256 KiB ends the watch; exactly 256 KiB is taken", async () => {
    const over = await watchOnce(0, [grew({ offset: 0, size: 262_145, data: b64(new Uint8Array(262_145).fill(0x41)) })]);
    expect(over.events).toEqual(["ended"]);
    expect(over.unwatched).toBe(true);
    const leftOut = await watchOnce(0, [grew({ offset: 0, size: 300_000, data: b64("{"), omitted: [[1, 262_144]] })], 1_024);
    expect(leftOut.events).toEqual(["ended"]);
    const exact = await watchOnce(0, [grew({ offset: 0, size: 262_144, data: b64(new Uint8Array(262_144).fill(0x41)) })]);
    expect(exact.events).toEqual(["grew 0 262144 262144"]);
  });

  it("a grew must start where its watch stands, stay within the file's size and list runs only with omit", async () => {
    expect((await watchOnce(6, [grew({ offset: 0, size: 12, data: b64("hello\n") })])).events).toEqual(["ended"]);
    expect((await watchOnce(6, [grew({ offset: 6, size: 8, data: b64("again\n") })])).events).toEqual(["ended"]);
    expect((await watchOnce(6, [grew({ offset: 6, size: 12, data: b64("again\n"), omitted: [] })])).events).toEqual(["ended"]);
    // In order: each grew from where the last ended; after a reset, from its size.
    const ordered = await watchOnce(6, [
      grew({ offset: 6, size: 12, data: b64("again\n") }),
      grew({ offset: 12, size: 15, data: b64("ok\n") }),
      (watch) => ({ relay: "reset", id: watch["id"], size: 2, ino: 8 }),
      grew({ offset: 2, size: 4, data: b64("x\n") }),
    ]);
    expect(ordered.events).toEqual(["grew 6 12 6", "grew 12 15 3", "reset 2 8", "grew 2 4 2"]);
    expect(ordered.up).toBe(true);
  });
});

function user(id: string, text: string): ChatItem {
  return { type: "user", value: { id, text, time: null, attachments: [] } };
}

function reply(id: string, markdown: string): ChatItem {
  return { type: "agentText", value: { id, markdown, time: null } };
}

function turnOf(id: string, items: ChatItem[]): ChatTurn {
  return { id, items, startedAt: null, lastEventAt: null, endedAt: null, isFinished: true, reportedDuration: null, isPartial: false };
}

const timelineOf = (...turns: ChatTurn[]): ChatTimeline => ({ turns, title: null, earlier: "none", newerWaiting: false, running: [] });

function memoryFiles(): CacheFiles & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return { stored, read: (file) => stored.get(file) ?? null, write: (file, text) => void stored.set(file, text), remove: (file) => void stored.delete(file) };
}

const bytes = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");

describe("the launch cache has a byte budget", () => {
  it("states its budgets: 64 KiB a text, 256 bytes an id, 1 MiB a chat, 2 MiB the topology, 6 MiB a machine's file", () => {
    expect({
      text: launchCache.cachedTextBytes,
      id: launchCache.cachedIdBytes,
      chat: launchCache.cachedChatBytes,
      topology: launchCache.cachedTopologyBytes,
      host: launchCache.cachedHostBytes,
    }).toEqual({ text: 64 * 1_024, id: 256, chat: chatBudget, topology: topologyBudget, host: hostBudget });
  });

  it("a chat with a 2 MiB id and a 2 MiB text stays within its budget, written and reloaded", () => {
    const files = memoryFiles();
    const cache = new LaunchCache(files, () => 0);
    cache.noteChat("mini", "w1:p1", timelineOf(turnOf("turn-1", [user("I".repeat(2 * MiB), "ok"), reply("a1", "T".repeat(2 * MiB)), user("u2", "hello")])));
    cache.flush(true);
    const text = [...files.stored.values()][0]!;
    expect(bytes(text)).toBeLessThanOrEqual(chatBudget + 1_024);
    const file = JSON.parse(text) as { chats: Record<string, ChatTimeline> };
    const chat = file.chats["w1:p1"]!;
    expect(bytes(chat)).toBeLessThanOrEqual(chatBudget);
    const items = chat.turns.flatMap((turn) => turn.items);
    // The item with the 2 MiB id is left out (never cut); the 2 MiB text is cut to 64 KiB.
    expect(items.map((item) => item.value.id)).toEqual(["a1", "u2"]);
    expect(bytes((items[0]!.value as { markdown: string }).markdown)).toBe(64 * 1_024);
    const loaded = new LaunchCache(files).load("mini");
    expect(loaded?.chats["w1:p1"]?.turns.flatMap((turn) => turn.items).map((item) => item.value.id)).toEqual(["a1", "u2"]);
  });

  it("a chat of large items keeps the newest that fit in 1 MiB, the first kept turn partial", () => {
    const files = memoryFiles();
    const cache = new LaunchCache(files, () => 0);
    const items = Array.from({ length: 40 }, (_, n) => reply(`a${n}`, `${n}:`.padEnd(60_000, "x")));
    cache.noteChat("mini", "w1:p1", timelineOf(turnOf("turn-1", items.slice(0, 20)), turnOf("turn-2", items.slice(20))));
    cache.flush(true);
    const chat = (JSON.parse([...files.stored.values()][0]!) as { chats: Record<string, ChatTimeline> }).chats["w1:p1"]!;
    expect(bytes(chat)).toBeLessThanOrEqual(chatBudget);
    const kept = chat.turns.flatMap((turn) => turn.items).map((item) => item.value.id);
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(40);
    expect(kept.at(-1)).toBe("a39");
    expect(kept).toEqual(items.slice(40 - kept.length).map((item) => item.value.id));
    expect(chat.turns[0]!.isPartial).toBe(true);
  });

  it("a topology over 2 MiB is not kept, a pane id over 256 bytes is left out, and the machine's file stays within 6 MiB", () => {
    const files = memoryFiles();
    const cache = new LaunchCache(files, () => 0);
    cache.noteTopology("mini", { workspaces: [], panes: [{ pane_id: "w1:p1", label: "L".repeat(3 * MiB) }] } as never);
    const big = (n: number): ChatTimeline => timelineOf(turnOf("turn-1", Array.from({ length: 30 }, (_, at) => reply(`c${n}-${at}`, "y".repeat(50_000)))));
    for (let n = 0; n < 4; n += 1) cache.noteChat("mini", `w1:p${n + 1}`, big(n));
    cache.noteChat("mini", "P".repeat(300), big(9));
    cache.flush(true);
    const text = [...files.stored.values()][0]!;
    expect(bytes(text)).toBeLessThanOrEqual(hostBudget);
    const file = JSON.parse(text) as { topology: unknown; chats: Record<string, ChatTimeline> };
    expect(file.topology).toBeNull();
    expect(Object.keys(file.chats).length).toBeGreaterThan(0);
    expect(Object.keys(file.chats).some((pane) => pane.length > 256)).toBe(false);
    for (const chat of Object.values(file.chats)) expect(bytes(chat)).toBeLessThanOrEqual(chatBudget);
    // A topology within its budget is kept.
    cache.noteTopology("mini", { workspaces: [], panes: [{ pane_id: "w1:p1", label: "small" }] } as never);
    cache.flush(true);
    expect((JSON.parse([...files.stored.values()][0]!) as { topology: unknown }).topology).toEqual({ workspaces: [], panes: [{ pane_id: "w1:p1", label: "small" }] });
  });

  it("an oversize file on disk is ignored at launch (not read, not parsed); one within budget loads", () => {
    const dir = mkdtempSync(path.join(process.env["HERDR_TEST_SCRATCH"] ?? process.env["TMPDIR"] ?? "/tmp", "herdr-sec-mac-"));
    const name = `${createHash("sha256").update("mini").digest("hex").slice(0, 32)}.json`;
    const fileOn = (timeline: ChatTimeline): string => JSON.stringify({ v: 1, topology: null, chats: { "w1:p1": timeline } });
    writeFileSync(path.join(dir, name), fileOn(timelineOf(turnOf("turn-1", [user("u1", "T".repeat(hostBudget + MiB / 2))]))), { mode: 0o600 });
    expect(statSync(path.join(dir, name)).size).toBeGreaterThan(hostBudget);
    expect(new LaunchCache(diskCacheFiles(dir)).load("mini")).toBeNull();
    // The disk's read gives nothing over the bytes allowed (it stats the file first).
    expect(diskCacheFiles(dir).read(name, hostBudget)).toBeNull();
    // A reader that gives an oversize text anyway (no stat) is not parsed either.
    const files = memoryFiles();
    files.stored.set(name, fileOn(timelineOf(turnOf("turn-1", [user("u1", "T".repeat(hostBudget + 1))]))));
    expect(new LaunchCache(files).load("mini")).toBeNull();
    // Within the budget, it loads as before.
    writeFileSync(path.join(dir, name), fileOn(timelineOf(turnOf("turn-1", [user("u1", "hello")]))), { mode: 0o600 });
    expect(new LaunchCache(diskCacheFiles(dir)).load("mini")?.chats["w1:p1"]?.turns[0]?.items[0]).toEqual(user("u1", "hello"));
  });
});

describe("a partial transcript line keeps its omission ranges across reads", () => {
  const head = '{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"';
  const tail = '"}}]}}\n';
  const first: BlobRange = [head.length, 1_024];
  const second: BlobRange = [head.length + 1_024, 1_024];
  // The line as a relay read rebuilds it: each run left out filled with `A` (blobs.ts).
  const line = new TextEncoder().encode(head + "A".repeat(2_048) + tail);
  const expected = { text: head + blobMark(first) + blobMark(second) + tail.slice(0, -1), offset: 0, blobs: [first, second], end: line.length - 1 };

  it("a line spanning three reads with two omissions keeps both ranges", () => {
    const follower = new TranscriptFollower();
    expect(follower.nextRead(line.length)).toMatchObject({ offset: 0 });
    expect(follower.consumeLines(0, line.subarray(0, second[0]), [first])).toEqual([]);
    expect(follower.nextRead(line.length)).toMatchObject({ kind: "follow", offset: second[0] });
    expect(follower.consumeLines(second[0], line.subarray(second[0], second[0] + 1_024), [second])).toEqual([]);
    const third = second[0] + 1_024;
    expect(follower.nextRead(line.length)).toMatchObject({ kind: "follow", offset: third });
    const lines = follower.consumeLines(third, line.subarray(third), []);
    expect(lines).toEqual([expected]);
    expect(lines[0]!.text.includes("A".repeat(64))).toBe(false);
  });

  it("an empty read between the two keeps the first range too", () => {
    const follower = new TranscriptFollower();
    follower.nextRead(line.length);
    follower.consumeLines(0, line.subarray(0, second[0]), [first]);
    follower.nextRead(line.length);
    expect(follower.consumeLines(second[0], new Uint8Array(0), [])).toEqual([]);
    follower.nextRead(line.length);
    follower.consumeLines(second[0], line.subarray(second[0], second[0] + 1_024), [second]);
    follower.nextRead(line.length);
    expect(follower.consumeLines(second[0] + 1_024, line.subarray(second[0] + 1_024), [])).toEqual([expected]);
  });
});
