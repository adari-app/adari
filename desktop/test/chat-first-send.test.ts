// The first message in a new Pi chat shows once and is never called "Not sent" when it went.
// Pi names its session when the pane starts and writes its file with the
// first message (pi-locator.ts), so Chat holds no live transcript of the pane when you send it ("No transcript
// was found"). The sender tells the store so (noTranscript); the pane's first live transcript after the send
// already holds the message, and the bubble settles into it (within the clock slack, or with no time). Until that
// transcript comes the backstop waits (ten minutes at most). Every other send keeps main's path. Invented texts;
// fake readers and hooks, no Herdr.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { ChatFeed } from "../src/shared/chat/feed";
import { makeSessionRef } from "../src/shared/chat/locator";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline } from "../src/shared/chat/model";
import { notSentLabel, notSentWhileWorkingMs, PendingMessages, pendingLabel, pendingScopes, userMessages, type PaneScope } from "../src/shared/chat/pending";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { assistant, at, eventually, header, ompID, piFirstExchange, piFolder, piPath, piStartLines, text, timelineOf, titleLine, user as piUser } from "./chat-pi-fixtures";
import { at as claudeAt, FakeTranscriptReader, reply as claudeReply, timelineOf as claudeTimelineOf, user as claudeUser } from "./support/chat-lines";
import { elements, HookHost } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { chatUpdates, pendingMessages, sendWithPending } = await import("../src/renderer/chat/chat-state");

const key = "mini/w1:p1";
/** The pane's terminal and the session Herdr's Pi integration names at start (the file's path). */
const scope: PaneScope = { terminalID: "term", session: piPath() };
const ms = (second: number): number => at(second) * 1_000;
const ask = "hi, read the notes file first";
const answer = "Read it. The notes say to run the tests before any change.";

/** The pane as the snapshots have it, Chat showing no live transcript (Pi's file not written yet). */
function notFound(store: PendingMessages, paneScope: PaneScope = scope): void {
  store.reconcile(new Map([[key, paneScope]]), () => true);
  store.observe(key, emptyTimeline, false);
}

/** A send Herdr took, made while the pane's Chat said its transcript was not found (`noTranscript`). */
function sent(store: PendingMessages, text: string, second: number, paneScope: PaneScope | null = scope, noTranscript = true): string {
  const id = store.add(key, text, ms(second), paneScope, noTranscript);
  store.delivered(id);
  return id;
}

const user = (id: string, text: string, time: number | null): ChatItem => ({ type: "user", value: userMessage(id, text, time) });
const reply = (id: string, text: string): ChatItem => ({ type: "agentText", value: { id, markdown: text, time: null } });
const turns = (...items: ChatItem[][]): ChatTimeline => ({ ...emptyTimeline, turns: items.map((list, index) => makeTurn(`t${index}`, { items: list, isFinished: true })) });

describe("the first message in a new Pi chat", () => {
  it("Pi's first transcript holds the message and its answer: one message, no bubble, nothing turns Not sent", () => {
    const store = new PendingMessages();
    notFound(store);
    const id = sent(store, ask, 100);
    expect(store.forPane(key)[0]!.noTranscript).toBe(true);
    expect(pendingLabel(store.forPane(key)[0]!, true, ms(101))).toBe("Queued");
    // The retry still finds no file while Pi works.
    store.observe(key, emptyTimeline, false);
    expect(store.forPane(key).map((bubble) => bubble.id)).toEqual([id]);
    const first = timelineOf(piFirstExchange(ask, 101, answer, 104)).timeline;
    expect(userMessages(first).map((message) => [message.text, message.time])).toEqual([[ask, at(101)]]);
    store.observe(key, first);
    expect(store.forPane(key)).toEqual([]);
    expect(store.markNotSent(key)).toBe(false);
    expect(store.droppedFor(key)).toBe(0);
  });

  it("settles on a message Pi stamped a fraction after the send, at the send's second, or within the clock slack before it", () => {
    for (const [second, label] of [
      [100.25, "after"],
      [100, "the same second"],
      [99, "one second behind"],
      [100 - 120, "the whole slack behind"],
    ] as const) {
      const store = new PendingMessages();
      notFound(store);
      sent(store, ask, 100);
      store.observe(key, timelineOf(piFirstExchange(ask, second, answer, 103)).timeline);
      expect(store.forPane(key), label).toEqual([]);
    }
  });

  it("settles on a message with no time (the file did not exist at the send: no history before it)", () => {
    const store = new PendingMessages();
    notFound(store);
    sent(store, ask, 100);
    store.observe(key, turns([user("u1", ask, null), reply("a1", answer)]));
    expect(store.forPane(key)).toEqual([]);
  });

  it("never takes a message timed more than the clock slack before the send: it is the baseline, and Not sent with the tap if nothing later", () => {
    const store = new PendingMessages();
    notFound(store);
    const id = sent(store, ask, 100);
    store.observe(key, timelineOf(piFirstExchange(ask, 100 - 120.5, answer, 103)).timeline);
    expect(store.forPane(key)).toHaveLength(1);
    expect(store.markNotSent(key, null, ms(106))).toBe(true);
    expect(pendingLabel(store.forPane(key)[0]!, false, ms(106))).toBe(notSentLabel);
    expect(store.takeNotSent(id)).toBe(ask);
  });

  it("settles while Herdr has not answered the send yet (still Sending)", () => {
    const store = new PendingMessages();
    notFound(store);
    store.add(key, ask, ms(100), scope, true);
    store.observe(key, timelineOf(piFirstExchange(ask, 101, answer, 104)).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("the backstop waits for the pane's first live transcript, at most ten minutes; one it called Not sent after that still settles", () => {
    const store = new PendingMessages();
    notFound(store);
    sent(store, ask, 100);
    expect(store.awaitsTranscript(key, ms(105))).toBe(true);
    expect(store.markNotSent(key, null, ms(105))).toBe(false);
    expect(store.forPane(key)[0]!.state).toBe("sent");
    // Ten minutes and no transcript: Not sent.
    expect(store.awaitsTranscript(key, ms(100) + notSentWhileWorkingMs)).toBe(false);
    expect(store.markNotSent(key, null, ms(100) + notSentWhileWorkingMs)).toBe(true);
    expect(store.forPane(key)[0]!.state).toBe("notSent");
    // The transcript then comes holding it: one message, nothing to tap.
    store.observe(key, timelineOf(piFirstExchange(ask, 101, answer, 104)).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("once the pane's first live transcript came without it, main's rules run: Not sent at the next backstop, with the tap", () => {
    const store = new PendingMessages();
    notFound(store);
    const id = sent(store, ask, 100);
    store.observe(key, timelineOf(piFirstExchange("typed in the terminal", 101, answer, 104)).timeline);
    expect(store.awaitsTranscript(key, ms(105))).toBe(false);
    expect(store.markNotSent(key, null, ms(105))).toBe(true);
    const bubble = store.forPane(key)[0]!;
    expect(bubble.state).toBe("notSent");
    expect(pendingLabel(bubble, false, ms(106))).toBe(notSentLabel);
    expect(store.takeNotSent(id)).toBe(ask);
  });

  it("a later message of yours after that baseline still settles it, as on main", () => {
    const store = new PendingMessages();
    notFound(store);
    sent(store, ask, 100);
    const first = turns([user("u0", "typed in the terminal", at(101)), reply("a0", answer)]);
    store.observe(key, first);
    store.observe(key, { ...first, turns: [...first.turns, makeTurn("t9", { items: [user("u1", ask, at(110))], isFinished: true })] });
    expect(store.forPane(key)).toEqual([]);
  });

  it("two identical first sends settle one each, in order", () => {
    const store = new PendingMessages();
    notFound(store);
    const first = sent(store, "yes", 100);
    const second = sent(store, "yes", 101);
    store.observe(key, turns([user("u1", "yes", at(102)), reply("a1", "Going on.")]));
    expect(store.forPane(key).map((bubble) => bubble.id)).toEqual([second]);
    expect(store.forPane(key).map((bubble) => bubble.id)).not.toContain(first);
    store.observe(key, turns([user("u1", "yes", at(102)), reply("a1", "Going on.")], [user("u2", "yes", at(110)), reply("a2", "Again.")]));
    expect(store.forPane(key)).toEqual([]);
    // Both at once in the first transcript: each takes its own, and Esc's take-back hides the newer.
    const both = new PendingMessages();
    notFound(both);
    sent(both, "yes", 100);
    sent(both, "yes", 101);
    both.observe(key, turns([user("u1", "yes", at(102))], [user("u2", "yes", at(103))]));
    expect(both.forPane(key)).toEqual([]);
    expect(both.takeBack(key, "yes")).toBe(true);
    expect([...both.takenBackFor(key)]).toEqual(["u2"]);
  });

  it("an identical message from long before the send is never taken; the send settles into its own later", () => {
    const store = new PendingMessages();
    notFound(store);
    sent(store, "yes", 3_700);
    store.observe(key, turns([user("u0", "yes", at(100)), reply("a0", "ok")]));
    expect(store.forPane(key)).toHaveLength(1);
    store.observe(key, turns([user("u0", "yes", at(100)), reply("a0", "ok")], [user("u1", "yes", at(3_702))]));
    expect(store.forPane(key)).toEqual([]);
    expect(store.takeBack(key, "yes")).toBe(true);
    expect([...store.takenBackFor(key)]).toEqual(["u1"]);
  });

  it("history an hour old is no proof of anything: a send that never arrived is Not sent, as on main", () => {
    const store = new PendingMessages();
    notFound(store);
    const id = sent(store, "yes", 3_700);
    store.observe(key, turns([user("u0", "yes", at(100)), reply("a0", "ok")]));
    expect(store.markNotSent(key, null, ms(3_705))).toBe(true);
    expect(store.forPane(key)[0]!.state).toBe("notSent");
    expect(store.takeNotSent(id)).toBe("yes");
  });

  it("what remains: the same words typed in the terminal within the slack, in a file written in the retry gap, are taken", () => {
    // The file appeared just before the send (Chat had not retried yet) holding "yes" typed in the terminal 30 s
    // earlier; the send of "yes" from Chat settles into it. Not handled yet.
    const store = new PendingMessages();
    notFound(store);
    sent(store, "yes", 100);
    store.observe(key, turns([user("terminal", "yes", at(70)), reply("a0", "ok")]));
    expect(store.forPane(key)).toEqual([]);
  });

  it("a session that changes between the send and the transcript: the bubble goes with the quiet line, the new one takes nothing", () => {
    const store = new PendingMessages();
    notFound(store);
    sent(store, ask, 100);
    const next = { terminalID: "term", session: piPath("019a6b2f-0000-7000-8000-000000000001") };
    store.reconcile(new Map([[key, next]]), () => true);
    expect(store.forPane(key)).toEqual([]);
    expect(store.droppedFor(key)).toBe(1);
    store.observe(key, timelineOf(piFirstExchange(ask, 101, answer, 104)).timeline);
    expect(store.forPane(key)).toEqual([]);
    expect(store.takenBackFor(key).size).toBe(0);
    // Herdr naming the session only after a send with none keeps main's no-session path, which settles as before.
    const named = new PendingMessages();
    notFound(named, { terminalID: "term", session: null });
    sent(named, ask, 100, { terminalID: "term", session: null });
    expect(named.forPane(key)[0]!.noTranscript).toBeUndefined();
    expect(named.forPane(key)[0]!.state).toBe("terminalOnly");
    named.reconcile(new Map([[key, scope]]), () => true);
    named.observe(key, timelineOf(piFirstExchange(ask, 101, answer, 104)).timeline);
    expect(named.forPane(key)).toEqual([]);
  });

  it("the flag never applies to a send Chat follows the live transcript for", () => {
    const store = new PendingMessages();
    store.reconcile(new Map([[key, scope]]), () => true);
    // A Pi file that holds only its start lines reads as a live chat with no turns.
    store.observe(key, timelineOf(piStartLines().join("\n") + "\n").timeline);
    sent(store, ask, 100, scope, true);
    expect(store.forPane(key)[0]!.noTranscript).toBeUndefined();
    store.observe(key, turns([user("u1", ask, at(100))]));
    expect(store.forPane(key)).toEqual([]);
  });
});

// The other kinds whose session is named before their transcript holds a message (Claude Code writes its file only
// after the first message, service.ts; omp as Pi), each through its own parser: the same settle.
describe("the other kinds named before their first message", () => {
  it("Claude Code and omp: the first transcript after the send holds it, one message", () => {
    const claude = new PendingMessages();
    notFound(claude, { terminalID: "term", session: "claude-session" });
    sent(claude, ask, claudeAt(100) - at(0), { terminalID: "term", session: "claude-session" });
    claude.observe(key, claudeTimelineOf([claudeUser(ask, "u1", 101), claudeReply(answer, "a1", 103, true)]).timeline);
    expect(claude.forPane(key)).toEqual([]);
    const omp = new PendingMessages();
    notFound(omp, { terminalID: "term", session: "omp-session" });
    sent(omp, ask, 100, { terminalID: "term", session: "omp-session" });
    const file = [titleLine("New"), header({ title: "New" }, ompID, piFolder), piUser(ask, 101), assistant([text(answer)], "stop", 103)].join("\n") + "\n";
    omp.observe(key, timelineOf(file, "omp").timeline);
    expect(omp.forPane(key)).toEqual([]);
  });
});

// MARK: - through the real follower

describe("through the real follower", () => {
  const ref = makeSessionRef("pi", { kind: "path", path: piPath() })!;

  it("no file before the first message (notFound); the retry finds it holding the message and the answer: one message", async () => {
    const store = new PendingMessages();
    store.reconcile(new Map([[key, scope]]), () => true);
    const reader = new FakeTranscriptReader();
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.subscribe((update) => store.observe(key, update.timeline, update.state.status === "live"));
    feed.start(ref, [piFolder]);
    expect(await eventually(() => feed.state.status === "unavailable")).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "notFound" });
    sent(store, ask, 100);
    reader.put(piPath(), piFirstExchange(ask, 101, answer, 104), piPath());
    // The service's retry starts the same session again.
    feed.start(ref, [piFolder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    expect(userMessages(feed.timeline).map((message) => message.text)).toEqual([ask]);
    expect(store.forPane(key)).toEqual([]);
    expect(store.markNotSent(key)).toBe(false);
    feed.stop();
  });

  it("a file that holds only the start lines is live with no turns; the message then appended settles the bubble", async () => {
    const store = new PendingMessages();
    store.reconcile(new Map([[key, scope]]), () => true);
    const reader = new FakeTranscriptReader();
    reader.put(piPath(), piStartLines().join("\n") + "\n", piPath());
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.subscribe((update) => store.observe(key, update.timeline, update.state.status === "live"));
    feed.start(ref, [piFolder]);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    expect(feed.timeline.turns).toEqual([]);
    sent(store, ask, 100);
    reader.put(piPath(), piFirstExchange(ask, 101, answer, 104), piPath());
    expect(await eventually(() => feed.timeline.turns.length === 1)).toBe(true);
    expect(store.forPane(key)).toEqual([]);
    feed.stop();
  });
});

// MARK: - the real ChatView

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;

function browser(): void {
  vi.stubGlobal("window", {
    herdrDesktop: {
      onChatUpdate: (listener: Listener) => {
        chatListener = listener;
        return () => undefined;
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => null,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
}

const topology = paneTopology([{ id: "w1:p1", agent: "pi", session: piPath(), sessionKind: "path", terminal: "term" }]);
const host = {
  id: "mini",
  name: "Mac mini",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state: "connected",
  error: null,
  fetchedAtMs: 0,
  topology,
  incarnation: 3,
  connection: 5,
  epoch: 9,
} as unknown as HostView;
const row = { paneID: "w1:p1", status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true, kind: "pi" } as unknown as SidebarRow;

const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });
/** The unavailable line ChatView draws (ChatUnavailableLine's text). */
const unavailableLines = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => (typeof element.type === "function" && (element.type as { name: string }).name === "ChatUnavailableLine" ? [String(element.props["line"])] : []));
const bubbles = (tree: unknown) =>
  elements(tree).filter((element) => typeof element.type === "function" && (element.type as { name: string }).name === "PendingBubble");

const views: HookHost<object>[] = [];
function chat(): HookHost<object> {
  const view = new HookHost<object>(ChatView as unknown as (props: object) => unknown, { host, row, onShowTerminal: () => undefined });
  views.push(view);
  view.render();
  return view;
}
const update = (state: unknown, timeline: ChatTimeline): void => chatListener?.({ hostId: "mini", paneId: "w1:p1", state, timeline });

describe("the real ChatView", () => {
  beforeEach(() => {
    pendingMessages.clear();
    browser();
  });
  afterEach(() => {
    for (const view of views.splice(0)) view.unmount();
    pendingMessages.clear();
    // The page listens once (chatUpdates.attach): the listener stays for the next test.
    vi.unstubAllGlobals();
  });

  it("a new Pi pane, a send, then the first transcript: one bubble while Pi works, none once the transcript has it", async () => {
    const view = chat();
    update({ status: "unavailable", reason: "notFound" }, emptyTimeline);
    view.render();
    expect(unavailableLines(view.tree)).toEqual(["No transcript was found for this agent's session."]);
    const scopes = pendingScopes([{ id: "mini", topology }]);
    pendingMessages.reconcile(scopes.scopes, scopes.covers);
    // As MainPane sends: the pane's own Chat says not found as the message goes.
    expect(chatUpdates.transcriptNotFound("mini", "w1:p1")).toBe(true);
    const now = Date.now();
    await sendWithPending(() => Promise.resolve(), "mini", "w1:p1", ask, true, scopes.scopes.get(key)!, () => now, chatUpdates.transcriptNotFound("mini", "w1:p1"));
    view.render();
    expect(bubbles(view.tree).map((element) => (element.props["message"] as { state: string; noTranscript?: true }).noTranscript)).toEqual([true]);
    expect(bubbles(view.tree).map((element) => (element.props["message"] as { state: string }).state)).toEqual(["sent"]);
    // Pi stamped it a second behind this Mac's clock: still the one message.
    update({ status: "live" }, turns([user("u1", ask, now / 1_000 - 1), reply("a1", answer)]));
    view.render();
    expect(bubbles(view.tree)).toEqual([]);
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(chatUpdates.transcriptNotFound("mini", "w1:p1")).toBe(false);
  });

  it("loading, live, or another reason is not 'not found': such a send keeps main's path", () => {
    chat();
    update({ status: "loading" }, emptyTimeline);
    expect(chatUpdates.transcriptNotFound("mini", "w1:p1")).toBe(false);
    update({ status: "unavailable", reason: "unreadable" }, emptyTimeline);
    expect(chatUpdates.transcriptNotFound("mini", "w1:p1")).toBe(false);
    update({ status: "unavailable", reason: "notFound" }, emptyTimeline);
    expect(chatUpdates.transcriptNotFound("mini", "w1:p1")).toBe(true);
    // Another pane's Chat is not on screen: never not found.
    expect(chatUpdates.transcriptNotFound("mini", "w1:p9")).toBe(false);
    // The pane's Chat closed (its tab left): not found no longer.
    for (const view of views.splice(0)) view.unmount();
    expect(chatUpdates.transcriptNotFound("mini", "w1:p1")).toBe(false);
  });

  it("a Pi session whose file holds no message yet says No messages yet.", () => {
    const view = chat();
    update({ status: "live" }, timelineOf(piStartLines().join("\n") + "\n").timeline);
    view.render();
    expect(texts(view.tree)).toContain("No messages yet.");
    expect(unavailableLines(view.tree)).toEqual([]);
  });
});
