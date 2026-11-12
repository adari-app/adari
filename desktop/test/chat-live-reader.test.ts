// The shown pane's screen is read about every 400 ms while it is followed (its
// agent working, its Chat on show: the main process says so with `follow`),
// never otherwise, and never two reads of a pane at once. The cases of the
// iPhone app's Tests/HerdrKitTests/ChatLiveReaderTests.swift, on fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatLiveReader, PaneReadGate } from "../src/shared/chat/live-reader";
import { ChatLiveScreen, liveBlock, type ChatLiveBlock } from "../src/shared/chat/live-screen";

/** A working Claude Code screen writing "The feed reads on". */
const writing = [
  "",
  "\u{276F} go on",
  "",
  "\u{23FA} The feed reads on",
  "",
  "\u{2722} Gallivanting\u{2026} (12s \u{00B7} \u{2193} 1.2k tokens)",
  "",
  "\u{2500}".repeat(64),
  "\u{276F}",
  "\u{2500}".repeat(64),
].join("\n");

/** The reads asked, the reads out at once per pane, what was delivered. */
class Pane {
  asked: string[] = [];
  out = new Map<string, number>();
  mostOut = 0;
  delivered: { pane: string; block: ChatLiveBlock | null }[] = [];
  failing = false;
  holding = false;
  private held: (() => void)[] = [];

  constructor(
    public answer: string,
    public delayMs = 0,
  ) {}

  read = async (pane: string): Promise<string> => {
    this.asked.push(pane);
    this.out.set(pane, (this.out.get(pane) ?? 0) + 1);
    this.mostOut = Math.max(this.mostOut, this.out.get(pane) ?? 0);
    if (this.holding) await new Promise<void>((resolve) => this.held.push(resolve));
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.out.set(pane, (this.out.get(pane) ?? 0) - 1);
    if (this.failing) throw new Error("timed out");
    return this.answer;
  };

  deliver = (pane: string, block: ChatLiveBlock | null): void => {
    this.delivered.push({ pane, block });
  };

  release(): void {
    this.holding = false;
    for (const resume of this.held) resume();
    this.held = [];
  }

  get waiting(): number {
    return this.held.length;
  }
}

const reader = (pane: Pane, intervalMs = 10): ChatLiveReader => new ChatLiveReader(pane.deliver, { intervalMs, read: pane.read });

/** Lets fake time pass, a millisecond at a time, until `condition` holds (fails after `limit` ms). */
async function until(condition: () => boolean, limit = 3_000): Promise<void> {
  for (let waited = 0; !condition(); waited += 1) {
    if (waited > limit) throw new Error("timed out");
    await vi.advanceTimersByTimeAsync(1);
  }
}
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the live reader", () => {
  it("the rhythm is about 400 milliseconds", () => {
    expect(ChatLiveReader.intervalMs).toBe(400);
    expect(ChatLiveScreen.readLines).toBe(80);
  });

  it("no reads while not followed", async () => {
    const pane = new Pane(writing);
    const live = reader(pane);
    await pass(80);
    live.follow(null);
    await pass(80);
    expect(pane.asked).toEqual([]);
    expect(live.reads).toBe(0);
  });

  it("the followed pane is read until it stops", async () => {
    const pane = new Pane(writing);
    const live = reader(pane);
    live.follow("w1:p2");
    await until(() => pane.delivered.length >= 3);
    expect(pane.delivered[0]?.pane).toBe("w1:p2");
    expect(pane.delivered[0]?.block).toEqual(liveBlock("The feed reads on"));
    live.follow(null);
    // A read out when it stopped may answer (and is dropped); then none.
    await pass(30);
    const stopped = pane.asked.length;
    const delivered = pane.delivered.length;
    await pass(100);
    expect(pane.asked.length, "no reads once stopped").toBe(stopped);
    expect(pane.delivered.length).toBe(delivered);
    expect(live.following).toBeNull();
  });

  it("reads wait for the answer and the interval", async () => {
    const pane = new Pane(writing, 30);
    const live = reader(pane, 40);
    live.follow("w1:p2");
    await pass(400);
    live.follow(null);
    // At most one read per 70 ms (30 ms answer + 40 ms interval): exactly so on fake time.
    expect(pane.asked.length).toBeLessThanOrEqual(Math.floor(400 / 70) + 1);
    expect(pane.asked.length).toBeGreaterThanOrEqual(3);
    expect(pane.mostOut).toBe(1);
  });

  it("the cadence: one read, then one each interval after the answer", async () => {
    const pane = new Pane(writing);
    const live = new ChatLiveReader(pane.deliver, { read: pane.read });
    live.follow("w1:p2");
    await pass(0);
    expect(pane.asked.length).toBe(1);
    await pass(399);
    expect(pane.asked.length).toBe(1);
    await pass(1);
    expect(pane.asked.length).toBe(2);
    await pass(4 * 400);
    expect(pane.asked.length).toBe(6);
    live.close();
    await pass(2_000);
    expect(pane.asked.length).toBe(6);
  });

  it("only the shown pane is read", async () => {
    const pane = new Pane(writing);
    const live = reader(pane);
    live.follow("w1:p1");
    await until(() => pane.asked.length >= 2);
    live.follow("w1:p2");
    await pass(30);
    const switched = pane.asked.length;
    await until(() => pane.asked.length >= switched + 3);
    live.follow(null);
    expect(new Set(pane.asked.slice(switched))).toEqual(new Set(["w1:p2"]));
    expect(pane.delivered.at(-1)?.pane).toBe("w1:p2");
  });

  it("at most one read of a pane is out", async () => {
    const pane = new Pane(writing);
    pane.holding = true;
    const live = reader(pane, 5);
    live.follow("w1:p2");
    await until(() => pane.waiting === 1);
    // Stopped and followed again (Chat hidden and shown, working again) while the read is out, several times.
    for (let round = 0; round < 3; round += 1) {
      live.follow(null);
      live.follow("w1:p2");
      await pass(20);
    }
    expect(pane.asked.length, "no second read while the first is out").toBe(1);
    expect(pane.waiting).toBe(1);
    pane.release();
    await until(() => pane.asked.length >= 3);
    live.follow(null);
    expect(pane.mostOut).toBe(1);
    // The held read answered for a follow since replaced: dropped, so every delivery is of a read the current follow asked.
    expect(pane.delivered.length).toBeLessThanOrEqual(pane.asked.length - 1);
  });

  it("another connection reads over it and keeps the budget", async () => {
    const old = new Pane(writing);
    const fresh = new Pane(writing);
    old.holding = true;
    const live = new ChatLiveReader(fresh.deliver, { intervalMs: 5 });
    live.follow("w1:p2", "connection 1", old.read);
    await until(() => old.waiting === 1);
    live.follow("w1:p2", "connection 2", fresh.read);
    await pass(40);
    expect(fresh.asked.length, "the pane's read on the old connection is still out").toBe(0);
    old.release();
    await until(() => fresh.asked.length >= 2);
    live.follow(null);
    expect(old.asked.length).toBe(1);
  });

  it("the same pane on the same connection goes on as it was", async () => {
    const pane = new Pane(writing);
    const live = reader(pane, 50);
    live.follow("w1:p2", "c1");
    await pass(0);
    expect(pane.asked.length).toBe(1);
    live.follow("w1:p2", "c1");
    await pass(10);
    expect(pane.asked.length, "no new read: the follow goes on").toBe(1);
    await pass(40);
    expect(pane.asked.length).toBe(2);
    live.close();
  });

  it("a reader closed stops (Swift: a reader let go)", async () => {
    const pane = new Pane(writing);
    const live = reader(pane, 20);
    live.follow("w1:p2");
    await until(() => pane.asked.length >= 2);
    live.close();
    await pass(60);
    const stopped = pane.asked.length;
    await pass(120);
    expect(pane.asked.length).toBe(stopped);
  });

  it("a failed read or an unreadable screen delivers nothing", async () => {
    const pane = new Pane("dev@mac ~ %");
    const live = reader(pane);
    live.follow("w1:p2");
    await until(() => pane.delivered.length >= 1);
    pane.failing = true;
    const before = pane.delivered.length;
    await until(() => pane.delivered.length >= before + 1);
    live.follow(null);
    expect(pane.delivered.every((each) => each.block === null), JSON.stringify(pane.delivered)).toBe(true);
  });

  it("a shared gate: two readers never read one pane at once", async () => {
    const pane = new Pane(writing);
    pane.holding = true;
    const gate = new PaneReadGate();
    const first = new ChatLiveReader(pane.deliver, { intervalMs: 5, read: pane.read, gate });
    const second = new ChatLiveReader(pane.deliver, { intervalMs: 5, read: pane.read, gate });
    first.follow("w1:p2");
    second.follow("w1:p2");
    await pass(50);
    expect(pane.asked.length).toBe(1);
    expect(gate.busy("w1:p2")).toBe(true);
    pane.release();
    await until(() => pane.asked.length >= 4);
    first.close();
    second.close();
    expect(pane.mostOut).toBe(1);
    await pass(20);
    expect(gate.busy("w1:p2")).toBe(false);
  });
});
