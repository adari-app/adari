// A pane switch shows its Chat at once. HerdrKit's
// ChatFeedShelfTests.swift, ported: the shelf of kept chats (bounded by count
// and by bytes), what a timeline weighs, the warm plan (at most two at once),
// and the gate that lets one warming read at a time go to a machine.

import { describe, expect, it } from "vitest";

import { ChatFeed, standardColdLoad, type TranscriptFileReader } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import { emptyTimeline } from "../src/shared/chat/model";
import {
  approximateBytes,
  ChatShelf,
  ChatWarmGate,
  defaultShelfByteBudget,
  defaultShelfCapacity,
  WarmingReader,
  warmLimit,
  warmPlan,
} from "../src/shared/chat/shelf";
import { claudePath, claudeSession, FakeTranscriptReader, reply, timelineOf, user } from "./support/chat-lines";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A reader that counts the calls in flight at once, each taking `delayMs`. */
class Counting implements TranscriptFileReader<TranscriptSessionRef> {
  now = 0;
  most = 0;
  calls = 0;
  constructor(private readonly delayMs = 30) {}
  async locate(): Promise<string | null> {
    return this.held("/x.jsonl");
  }
  async size(): Promise<number> {
    return this.held(10);
  }
  async read(): Promise<Uint8Array> {
    return this.held(new Uint8Array([1]));
  }
  private async held<T>(value: T): Promise<T> {
    this.now += 1;
    this.calls += 1;
    this.most = Math.max(this.most, this.now);
    try {
      await sleep(this.delayMs);
      return value;
    } finally {
      this.now -= 1;
    }
  }
}

/** Passes calls to `base`, counting those in flight at once (each held a little, as a real link would). */
class InFlight implements TranscriptFileReader<TranscriptSessionRef> {
  now = 0;
  most = 0;
  constructor(private readonly base: TranscriptFileReader<TranscriptSessionRef>) {}
  locate(session: TranscriptSessionRef): Promise<string | null> {
    return this.counted(() => this.base.locate(session));
  }
  size(path: string): Promise<number> {
    return this.counted(() => this.base.size(path));
  }
  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    return this.counted(() => this.base.read(path, offset, maxBytes));
  }
  private async counted<T>(operation: () => Promise<T>): Promise<T> {
    this.now += 1;
    this.most = Math.max(this.most, this.now);
    try {
      await sleep(5);
      return await operation();
    } finally {
      this.now -= 1;
    }
  }
}

describe("the shelf of kept chats", () => {
  it("keeps the last seven panes (with the one on show, eight)", () => {
    expect(defaultShelfCapacity).toBe(7);
    expect(defaultShelfByteBudget).toBe(24 * 1_024 * 1_024);
    const shelf = new ChatShelf<number>();
    for (let index = 0; index < 7; index += 1) expect(shelf.put(`p${index}`, index, 10)).toEqual([]);
    expect(shelf.put("p7", 7, 10)).toEqual([0]);
    expect(shelf.keys).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
    // Taken back (on show again), then kept again: the newest.
    expect(shelf.take("p1")).toBe(1);
    expect(shelf.take("p1")).toBeUndefined();
    expect(shelf.put("p1", 1, 10)).toEqual([]);
    expect(shelf.put("p8", 8, 10)).toEqual([2]);
    expect(shelf.keys.at(-1)).toBe("p8");
    expect(shelf.keys[0]).toBe("p3");
  });

  it("lets the oldest go over its byte budget; one alone over it is not kept; a key kept again replaces", () => {
    const shelf = new ChatShelf<string>(10, 100);
    expect(shelf.put("a", "a", 40)).toEqual([]);
    expect(shelf.put("b", "b", 40)).toEqual([]);
    expect(shelf.put("c", "c", 40)).toEqual(["a"]);
    expect(shelf.bytes).toBe(80);
    expect(shelf.resize("c", 70)).toEqual(["b"]);
    expect(shelf.put("huge", "huge", 101)).toEqual(["c", "huge"]);
    expect(shelf.count).toBe(0);
    expect(shelf.put("d", "d1", 10)).toEqual([]);
    expect(shelf.put("d", "d2", 10)).toEqual(["d1"]);
    expect(shelf.peek("d")).toBe("d2");
    expect(shelf.has("d")).toBe(true);
    expect(shelf.removeAll((key) => key === "d")).toEqual(["d2"]);
    expect(shelf.count).toBe(0);
  });

  it("weighs a timeline by its text", () => {
    const { timeline } = timelineOf([user("hello", "u1", 0), reply("x".repeat(10_000), "a1", 1)]);
    expect(approximateBytes(timeline)).toBeGreaterThanOrEqual(10_005);
    expect(approximateBytes(timeline)).toBeLessThan(11_000);
    expect(approximateBytes(emptyTimeline)).toBe(0);
  });
});

describe("warming", () => {
  it("plans at most two at once, in the sidebar's order, none on show, kept or warming", () => {
    expect(warmLimit).toBe(2);
    const candidates = ["a", "b", "c", "d", "e"];
    expect(warmPlan(candidates, new Set(["a"]), new Set(["b"]), new Set())).toEqual(["c", "d"]);
    expect(warmPlan(candidates, new Set(["a"]), new Set(["b"]), new Set(["c"]))).toEqual(["d"]);
    expect(warmPlan(candidates, new Set(), new Set(), new Set(["c", "d"]))).toEqual([]);
    expect(warmPlan(["a", "a"], new Set(), new Set(), new Set())).toEqual(["a"]);
  });

  it("lets one warming read at a time go to a machine; another machine's do not wait; one on show reads straight through", async () => {
    const gate = new ChatWarmGate();
    const mac1 = new Counting();
    const mac2 = new Counting();
    const warming1 = Array.from({ length: 3 }, () => new WarmingReader(mac1, "mac-1", gate));
    const warming2 = new WarmingReader(mac2, "mac-2", gate);
    const start = Date.now();
    const three = async (reader: WarmingReader<TranscriptSessionRef>) => {
      for (let index = 0; index < 3; index += 1) await reader.read("/x.jsonl", 0, 1);
    };
    await Promise.all([...warming1.map(three), three(warming2)]);
    const took = Date.now() - start;
    expect(mac1.calls).toBe(9);
    expect(mac1.most, "one warming read in flight on the machine").toBe(1);
    expect(mac2.most).toBe(1);
    // Mac 2's three reads went alongside Mac 1's nine: about nine reads' time (270 ms), not twelve (360 ms).
    expect(took, `${took} ms`).toBeLessThan(330);
    // On show: no gate.
    for (const reader of warming1) reader.warming = false;
    await Promise.all(warming1.map((reader) => reader.size("/x.jsonl")));
    expect(mac1.most).toBe(3);
  });

  it("lets a warming read waiting its turn go at once when its chat comes on show", async () => {
    const gate = new ChatWarmGate();
    const slow = new Counting(300);
    const quick = new Counting(5);
    const busy = new WarmingReader(slow, "mac-1", gate);
    const waiting = new WarmingReader(quick, "mac-1", gate);
    const start = Date.now();
    const first = busy.read("/x.jsonl", 0, 1);
    const second = waiting.read("/x.jsonl", 0, 1);
    await sleep(20);
    expect(quick.calls, "waits its turn while warming").toBe(0);
    waiting.warming = false;
    await second;
    expect(Date.now() - start, "not after the slow read").toBeLessThan(200);
    await first;
    // The gate is free again for the next warming read.
    const next = new WarmingReader(quick, "mac-1", gate);
    await next.read("/x.jsonl", 0, 1);
    expect(quick.calls).toBe(2);
  });

  it("loads two cold feeds warming on one machine, never two of their reads at once", async () => {
    const gate = new ChatWarmGate();
    const base = new FakeTranscriptReader();
    let text = "";
    for (let index = 0; index < 20; index += 1) {
      text += `${user(`question ${index}`, `u${index}`, index)}\n${reply(`answer ${index} ${"w".repeat(60_000)}`, `a${index}`, index)}\n`;
    }
    base.put(claudePath, text, claudePath);
    const counting = new InFlight(base);
    const feeds = Array.from({ length: 2 }, () => new ChatFeed(new WarmingReader(counting, "mac-1", gate), { cold: standardColdLoad }));
    for (const feed of feeds) feed.start(claudeSession);
    for (const feed of feeds) {
      expect(await feed.loaded()).toBe(true);
      feed.pause();
    }
    expect(counting.most).toBe(1);
    for (const feed of feeds) expect(feed.timeline.turns.length).toBeGreaterThanOrEqual(4);
    for (const feed of feeds) feed.stop();
  });
});
