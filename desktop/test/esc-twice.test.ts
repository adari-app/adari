// A message Esc cancels comes back to the box once, not twice. Two Escs (two
// presses, or the armed stop and a press, or the live stop and stopIfWorking)
// can each run main's reads after an Esc (paneAfterStop); if both saw the
// message in Claude's box before the clear landed, both would answer
// cancelled and the page would put it back for each, so our box would hold it
// twice.
//
// Main runs those reads one at a time per pane and claims the send as the box
// matches it (before the clear); the page puts a send back once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { afterStop, afterStopOnce, PaneTurns, SentTexts, type AfterStop } from "../src/main/herdr/claude-box";
import { PendingMessages, withoutTakenBack } from "../src/shared/chat/pending";
import { putBackInBox, takeBackAfterStop } from "../src/renderer/chat/esc-back";
import { shown, timelineOf } from "./support/chat-lines";
import { beforeGlued, escMs, escTimes, firstPending } from "./support/esc-queue-lines";
import { timedBox, type TimedBox } from "./support/timed-box";

const key = "host/w1:p1";
const paneID = "w1:p1";

/** One Mac's main process and one page: what an Esc to the pane does end to end. */
function rig() {
  const writer = {};
  const sent = new SentTexts();
  const turns = new PaneTurns();
  const pending = new PendingMessages();
  const texts = new Map<string, string>();
  const drafts = { get: (k: string) => ({ text: texts.get(k) ?? "" }), edit: (k: string, t: string) => void texts.set(k, t) };
  const answers: AfterStop[] = [];
  const page = { drafts, pending, landing: () => undefined, note: () => undefined };
  return {
    sent,
    pending,
    drafts,
    answers,
    /** Chat sends `text` to the pane: main records it, the page shows its bubble. */
    send(text: string): string {
      sent.record(writer, paneID, text);
      const id = pending.add(key, text, Date.now());
      pending.delivered(id);
      return id;
    },
    /** An Esc went: main's reads (ipc paneAfterStop), then the page's take-back. */
    esc(site: TimedBox): Promise<void> {
      return afterStopOnce(writer, paneID, site, sent, turns).then((found) => {
        answers.push(found);
        takeBackAfterStop(page, key, found);
      });
    },
  };
}

const cancelled = (answers: readonly AfterStop[]) => answers.filter((answer) => answer.cancelled !== null).map((answer) => answer.cancelled);

describe("one take-back per sent message", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("two Escs 300 ms apart after one send: our box ends 'test' once, one bubble removed", async () => {
    const r = rig();
    r.send("test");
    // Claude Code puts "test" back at 450 ms; a clear lands 150 ms after its keys.
    const box = timedBox(150);
    box.show("test", 450);
    const first = r.esc(box);
    await vi.advanceTimersByTimeAsync(300);
    const second = r.esc(box);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second]);
    expect(r.drafts.get(key).text).toBe("test");
    expect(cancelled(r.answers)).toEqual(["test"]);
    expect(r.answers).toContainEqual({ cancelled: null, cleared: false });
    expect(r.pending.forPane(key)).toEqual([]);
    // Only the first Esc's reads cleared Claude's box; it is empty.
    expect(box.keyLog.every(([at]) => at < 1000)).toBe(true);
    expect(box.draft()).toBe("");
  });

  it("two concurrent reads after an Esc (main): one returns the text, the other none", async () => {
    const r = rig();
    r.send("test");
    const box = timedBox(150);
    box.show("test", 0);
    const writer = {};
    const sent = new SentTexts();
    sent.record(writer, paneID, "test");
    const turns = new PaneTurns();
    const both = Promise.all([afterStopOnce(writer, paneID, box, sent, turns), afterStopOnce(writer, paneID, box, sent, turns)]);
    await vi.advanceTimersByTimeAsync(3000);
    const answers = await both;
    expect(cancelled(answers)).toEqual(["test"]);
    expect(answers.filter((answer) => answer.cancelled === null)).toHaveLength(1);
  });

  it("the send is claimed as the box matches it, before the clear: a concurrent read never matches it again", async () => {
    const writer = {};
    const sent = new SentTexts();
    sent.record(writer, paneID, "test");
    const box = timedBox(150);
    box.show("test", 0);
    const seenAtKeys: (readonly string[])[] = [];
    const watched = { ...box, keys: async (keys: readonly string[]) => void (seenAtKeys.push(sent.recent(writer, paneID)), await box.keys(keys)) };
    // Without the one-at-a-time turns, side by side: the claim alone keeps it to one.
    const both = Promise.all([afterStop(watched, sent.claims(writer, paneID)), afterStop(watched, sent.claims(writer, paneID))]);
    await vi.advanceTimersByTimeAsync(3000);
    const answers = await both;
    expect(cancelled(answers)).toEqual(["test"]);
    expect(seenAtKeys[0]).toEqual([]);
    // A claim that finds the send gone: nothing, and no keys.
    const other = timedBox(150);
    other.show("test", 0);
    const none = afterStop(other, { last: () => "test", claim: () => false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await none).toEqual({ cancelled: null, cleared: false });
    expect(other.keyLog).toEqual([]);
  });

  it("the reads run one at a time per pane, other panes and machines side by side", async () => {
    const turns = new PaneTurns();
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${name} end`);
      return name;
    };
    const mac = {};
    const other = {};
    const runs = Promise.all([
      turns.run(mac, paneID, job("a", 500)),
      turns.run(mac, paneID, job("b", 100)),
      turns.run(mac, "w1:p2", job("c", 100)),
      turns.run(other, paneID, job("d", 100)),
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await runs).toEqual(["a", "b", "c", "d"]);
    expect(log.indexOf("b start")).toBeGreaterThan(log.indexOf("a end"));
    expect(log.indexOf("c start")).toBeLessThan(log.indexOf("a end"));
    expect(log.indexOf("d start")).toBeLessThan(log.indexOf("a end"));
    // A failed turn does not stop the next.
    const after = Promise.all([turns.run(mac, paneID, () => Promise.reject(new Error("read failed"))).catch(() => "failed"), turns.run(mac, paneID, async () => "next")]);
    expect(await after).toEqual(["failed", "next"]);
  });

  it("two different sends, each cancelled by its own Esc, come back one after the other: 'first', then 'second' on top, each once", async () => {
    const r = rig();
    r.send("first");
    const box = timedBox(150);
    box.show("first", 450);
    const one = r.esc(box);
    await vi.advanceTimersByTimeAsync(2000);
    await one;
    expect(r.drafts.get(key).text).toBe("first");
    r.send("second");
    box.show("second", 2450);
    const two = r.esc(box);
    await vi.advanceTimersByTimeAsync(300);
    const again = r.esc(box);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([two, again]);
    expect(r.drafts.get(key).text).toBe("second\nfirst");
    expect(cancelled(r.answers)).toEqual(["first", "second"]);
    expect(r.pending.forPane(key)).toEqual([]);
  });

  it("a real second message of the same words, sent and cancelled later, comes back on its own Esc", async () => {
    const r = rig();
    r.send("test");
    const box = timedBox(150);
    box.show("test", 450);
    const one = r.esc(box);
    await vi.advanceTimersByTimeAsync(2000);
    await one;
    expect(r.drafts.get(key).text).toBe("test");
    // The user sends it again from our box (the send empties it), and Esc cancels it again.
    r.drafts.edit(key, "");
    r.send("test");
    box.show("test", 2450);
    const two = r.esc(box);
    await vi.advanceTimersByTimeAsync(2000);
    await two;
    expect(r.drafts.get(key).text).toBe("test");
    expect(cancelled(r.answers)).toEqual(["test", "test"]);
    expect(r.pending.forPane(key)).toEqual([]);
  });
});

describe("the page puts a send back once", () => {
  const page = (pending: PendingMessages) => {
    const texts = new Map<string, string>();
    const drafts = { get: (k: string) => ({ text: texts.get(k) ?? "" }), edit: (k: string, t: string) => void texts.set(k, t) };
    return { drafts, deps: { drafts, pending, landing: () => undefined, note: () => undefined } };
  };

  it("a second answer for the same send changes nothing", () => {
    const pending = new PendingMessages();
    pending.add(key, "test", 0);
    const { drafts, deps } = page(pending);
    expect(takeBackAfterStop(deps, key, { cancelled: "test", cleared: true })).toBe(true);
    expect(takeBackAfterStop(deps, key, { cancelled: "test", cleared: true })).toBe(false);
    expect(drafts.get(key).text).toBe("test");
  });

  it("a repeat answer hides no older message of the same words", () => {
    const pending = new PendingMessages();
    pending.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    // An older send of the same words, answered: settled into U1.
    pending.add(key, firstPending, escMs(escTimes.u1) - 200);
    const withU1 = timelineOf(beforeGlued).timeline;
    pending.observe(key, withU1);
    // The new send of the same words, cancelled: its bubble comes back; a repeat answer leaves U1 shown.
    pending.add(key, firstPending, escMs(escTimes.u1) + 60_000);
    const { drafts, deps } = page(pending);
    takeBackAfterStop(deps, key, { cancelled: firstPending, cleared: true });
    takeBackAfterStop(deps, key, { cancelled: firstPending, cleared: true });
    expect(drafts.get(key).text).toBe(firstPending);
    expect(shown(withoutTakenBack(withU1, pending.takenBackFor(key)))).toContain(`user:${firstPending}`);
  });

  it("a 'Not sent' bubble tapped back, then main's answer for the same send: once", () => {
    const pending = new PendingMessages();
    const id = pending.add(key, "test", 0);
    pending.delivered(id);
    pending.markNotSent(key);
    const { drafts, deps } = page(pending);
    const tapped = pending.takeNotSent(id);
    expect(tapped).toBe("test");
    putBackInBox(drafts, () => undefined, key, tapped!);
    expect(takeBackAfterStop(deps, key, { cancelled: "test", cleared: true })).toBe(false);
    expect(drafts.get(key).text).toBe("test");
  });

  it("main's answer first, then a tap: the bubble is gone, nothing more comes back", () => {
    const pending = new PendingMessages();
    const id = pending.add(key, "test", 0);
    pending.delivered(id);
    const { drafts, deps } = page(pending);
    takeBackAfterStop(deps, key, { cancelled: "test", cleared: true });
    pending.markNotSent(key);
    expect(pending.takeNotSent(id)).toBeNull();
    expect(drafts.get(key).text).toBe("test");
  });

  it("a first answer with no bubble left (the page reloaded) still comes back, once", () => {
    const pending = new PendingMessages();
    const { drafts, deps } = page(pending);
    expect(takeBackAfterStop(deps, key, { cancelled: "test", cleared: true })).toBe(true);
    expect(takeBackAfterStop(deps, key, { cancelled: "test", cleared: true })).toBe(false);
    expect(drafts.get(key).text).toBe("test");
  });
});
