// A message sent and then stopped must not stay at the bottom looking queued
// after the next send. A message sent while Claude works is enqueued (Claude
// Code 2.1.31x: a `queue-operation` enqueue); the user's Esc ends the turn
// ("[Request interrupted by user]") and Claude Code can take the queued text
// back, so it is never written as the user's line and nothing matches its
// bubble by text. The bubble settles at the latest when a later message of the
// user's lands; one the transcript does
// have still settles at once, at its own place. Claude transcript fixtures in
// the shapes of test/chat-queued-prompt.test.ts, invented ids and times.

import { describe, expect, it } from "vitest";

import { pendingLabel, PendingMessages, userMessages } from "../src/shared/chat/pending";
import type { ChatTimeline } from "../src/shared/chat/model";
import { at, json, reply, session, stamp, timelineOf, user } from "./support/chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

const typed: Record<string, JSONValue> = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, permissionMode: "auto" };
const queuedFields: Record<string, JSONValue> = { promptSource: "queued", turnOrigin: "human", origin: { kind: "human" }, permissionMode: "auto", turnPosition: { index: 1 } };
const enqueue = (text: string, second: number): string =>
  json({ type: "queue-operation", operation: "enqueue", timestamp: stamp(second), sessionId: session, content: text });
const takenBack = (second: number): string => json({ type: "queue-operation", operation: "remove", timestamp: stamp(second), sessionId: session });
const interrupted = (uuid: string, second: number): string => user([{ type: "text", text: "[Request interrupted by user]" }], uuid, second);

const key = "mini/w1:p1";
const ms = (second: number): number => at(second) * 1_000;
const first = "refactor the header";
const second = "only the title";
/** Claude works on the user's earlier message. */
const working = [user("Run the scroll tests", "u1", 0, typed), reply("Running them now.", "a1", 2)];

/** What Chat shows: the user's messages in the transcript, then the bubbles still waiting. */
function shownTexts(store: PendingMessages, timeline: ChatTimeline): string[] {
  return [...userMessages(timeline).map((message) => message.text), ...store.forPane(key).map((item) => `pending:${item.text}`)];
}

/** Send `text` at `second` as the page does: the bubble, then Herdr took it. */
function send(store: PendingMessages, text: string, second: number): string {
  const id = store.add(key, text, ms(second));
  store.delivered(id);
  return id;
}

describe("a stopped message does not stay at the bottom looking queued", () => {
  it("send while working, stop (the interrupt line), send again: no pending row remains, each message once, in order", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    send(store, first, 9);
    expect(pendingLabel(store.forPane(key)[0]!, true, ms(9))).toBe("Queued");
    // The user's Esc: the turn ends; Claude Code takes the queued text back (never written as the user's line).
    const stopped = [...working, enqueue(first, 9), interrupted("u2", 11), takenBack(11)];
    store.observe(key, timelineOf(stopped).timeline);
    expect(store.forPane(key).map((item) => item.text)).toEqual([first]);
    send(store, second, 20);
    const after = timelineOf([...stopped, user(second, "u3", 21, typed), reply("Only the title, then.", "a2", 24, true)]).timeline;
    store.observe(key, after);
    expect(store.forPane(key)).toEqual([]);
    expect(shownTexts(store, after)).toEqual(["Run the scroll tests", second]);
  });

  it("the stopped message the transcript does have settles at once, at its place: both once, in order", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    send(store, first, 9);
    const stopped = [...working, enqueue(first, 9), interrupted("u2", 11), user(first, "u2q", 11, queuedFields)];
    store.observe(key, timelineOf(stopped).timeline);
    expect(store.forPane(key)).toEqual([]);
    send(store, second, 20);
    const after = timelineOf([...stopped, user(second, "u3", 21, typed)]).timeline;
    store.observe(key, after);
    expect(store.forPane(key)).toEqual([]);
    expect(shownTexts(store, after)).toEqual(["Run the scroll tests", first, second]);
  });

  it("a later send still on its way keeps the older one waiting (nothing settles on a guess)", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    send(store, first, 9);
    send(store, second, 10);
    store.observe(key, timelineOf([...working, enqueue(first, 9), enqueue(second, 10)]).timeline);
    expect(store.forPane(key).map((item) => item.text)).toEqual([first, second]);
  });

  it("with no stop between, a later send landing first clears only its own (each clears its own)", () => {
    const store = new PendingMessages();
    store.observe(key, timelineOf(working).timeline);
    send(store, first, 9);
    send(store, second, 10);
    store.observe(key, timelineOf([...working, user(second, "u3", 11, queuedFields)]).timeline);
    expect(store.forPane(key).map((item) => item.text)).toEqual([first]);
  });
});
