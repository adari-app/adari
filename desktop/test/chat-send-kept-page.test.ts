// The page's side of a review's fixes, with main's real
// DraftStore (on a memory file) standing in for drafts.json and the Send IPC's kept copy (as ipc.ts keeps it at the
// Return), the page's real stores (sendWithPending, PendingMessages, composerDrafts, TakeBacks) and the real
// PendingBubble and ChatView on the small hooks host. Fakes only.
//
// 1. An unproved message survives a page reload, a renderer crash and an app quit and start: it comes back as its
//    bubble (still checking before the bound, else "could not confirm" with its actions), never into the composer;
//    its kept copy goes when the transcript settles it, on Put back or on Dismiss. A new session in the pane turns it
//    "could not confirm" at once. A pane gone: main moves it to Kept drafts.
// 6. A picture message past its Return with its check still running is a candidate for Esc's take-back.
// 7. The page's bound runs on its own clock from the receipt; a late answer applies only while the bubble is there.
// 8. Show the terminal on the bubbles shown while Chat is unavailable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DraftStore, MemoryDraftFiles } from "../src/main/drafts";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { notConfirmedLabel, pendingLabel } from "../src/shared/chat/pending";
import { emptyTimeline } from "../src/shared/chat/model";
import { sendProofBoundMs, takeBackTexts } from "../src/shared/claude-screen";
import { unprovedNoRoomText } from "../src/shared/drafts";
import type { HostView, SendCheck, SendReceipt } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { claudeReply, claudeUser } from "./support/esc-queue-lines";
import { timelineOf } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView, PendingBubble } = await import("../src/renderer/chat/ChatView");
const { composerDrafts, draftKey, sendDraft } = await import("../src/renderer/components/composer-drafts");
const { attachSendKeeping, pendingMessages, restoreUnproved, sendWithPending } = await import("../src/renderer/chat/chat-state");
const { queuedSends, TakeBacks } = await import("../src/renderer/chat/take-back");

const picture = "/fake/.adari-attachments-0123/attachment-11111111-1111-1111-1111-111111111111.png";
const caption = "kept caption";
const message = `${caption} ${picture}`;
const host = "fixture-host";
const key = draftKey(host, "p1");
const scope = { terminalID: "t1", session: "s1" };
const sentAt = Date.parse("2026-11-20T10:00:00.000Z");
const earlier = [claudeUser("u-0", null, "earlier", "2026-11-20T09:59:00.000Z", { promptSource: "typed" }), claudeReply("a-0", "u-0", "ok", "2026-11-20T09:59:05.000Z")];
const landed = (time = "2026-11-20T10:00:20.000Z") => timelineOf([...earlier, claudeUser("u-1", "a-0", message, time, { promptSource: "typed" })]).timeline;

const tick = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};
const states = (): string[] => pendingMessages.forPane(key).map((bubble) => bubble.state);
const draftNow = () => {
  const draft = composerDrafts.get(key);
  return { text: draft.text, chips: draft.chips.length };
};
const buttons = (tree: unknown) => elements(tree).filter((element) => element.type === "button");
const bubbleButtons = (index = 0): { names: unknown[]; press: (name: string) => void } => {
  const ui = new HookHost(PendingBubble as (props: object) => unknown, { message: pendingMessages.forPane(key)[index]!, working: false, now: sentAt, onMenu: () => undefined, onShowTerminal: () => undefined });
  ui.render();
  const found = buttons(ui.tree);
  return { names: found.map((button) => button.props["children"]), press: (name) => (found.find((button) => button.props["children"] === name)!.props["onClick"] as () => void)() };
};

/**
 * Main: its DraftStore (drafts.json) and the Send IPC as ipc.ts runs it for a picture message: the copy kept at the
 * Return, then the receipt with the check's id and the copy's id; the check answers when `answer` is called.
 */
function main(files = new MemoryDraftFiles(), now = () => sentAt, refuse = false) {
  const store = new DraftStore(files, { now });
  const ended: string[] = [];
  let answer: (outcome: SendCheck) => void = () => undefined;
  const checked = new Promise<SendCheck>((resolve) => (answer = resolve));
  const send = async (hostId: string, paneId: string, text: string): Promise<SendReceipt> => {
    // Main's Send IPC with no room for the copy: refused before any key.
    if (refuse) throw new Error(`Error invoking remote method 'herdr:pane-send': Error: ${unprovedNoRoomText}`);
    const kept = store.keepUnproved({ hostId, paneId, text, terminalID: "t1", session: "s1" });
    return { check: "check-1", ...(kept === null ? {} : { kept }) };
  };
  const bridge = {
    unprovedRelease: async (id: string) => void store.releaseUnproved(id),
    sendCheckEnd: async (id: string) => void ended.push(id),
    unprovedHistory: async (id: string, anchor: string | null) => void store.unprovedHistory(id, { anchor }),
  };
  return {
    store,
    files,
    ended,
    bridge,
    answer: (outcome: SendCheck) => {
      answer(outcome);
      const id = store.state().unproved?.[0]?.id;
      if (id !== undefined && outcome !== "unknown") store.unprovedOutcome(id, outcome);
    },
    press: (wait: (ms: number) => Promise<void> = () => new Promise(() => undefined)) => {
      composerDrafts.restore(key, caption, [{ path: picture, name: "Picture 1", image: true }], []);
      let going: Promise<void> | null = null;
      sendDraft(composerDrafts, (h, p, t) => (going = sendWithPending(send, h, p, t, true, scope, () => sentAt, false, { check: () => checked, wait })), host, "p1", null);
      return (going as unknown as Promise<void>).catch(() => undefined);
    },
  };
}

let detach: (() => void) | null = null;
beforeEach(() => {
  pendingMessages.clear();
  composerDrafts.clear();
});
afterEach(() => {
  detach?.();
  detach = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The pane's snapshot (its terminal and session) and its live transcript before the Send, as Chat shows it. */
function shown(timeline = timelineOf(earlier).timeline): void {
  pendingMessages.reconcile(new Map([[key, scope]]), () => true);
  pendingMessages.observe(key, timeline);
}

/** A page reload or a renderer crash: the page's memory is gone; main and drafts.json stay. */
function reload(): void {
  detach?.();
  pendingMessages.clear();
  composerDrafts.clear();
}

describe("an unproved message survives the page and the app (fix 1)", () => {
  it("a reload with the message unproved: back as its bubble, still checking, then could not confirm at its bound; never in the composer", async () => {
    const m = main();
    detach = attachSendKeeping(m.bridge);
    await m.press();
    expect(draftNow()).toEqual({ text: "", chips: 0 });
    expect(states()).toEqual(["sending"]);
    reload();
    detach = attachSendKeeping(m.bridge);
    let bound: () => void = () => undefined;
    const waits: number[] = [];
    restoreUnproved(m.store.state().unproved!, true, () => sentAt + 5_000, (ms) => {
      waits.push(ms);
      return new Promise((resolve) => (bound = resolve));
    });
    expect(states()).toEqual(["sending"]);
    expect(pendingMessages.forPane(key)[0]).toMatchObject({ text: message, checking: true, restored: true, scope });
    expect(waits).toEqual([sendProofBoundMs - 5_000]);
    expect(draftNow()).toEqual({ text: "", chips: 0 });
    bound();
    await tick();
    expect(states()).toEqual(["unconfirmed"]);
    expect(pendingLabel(pendingMessages.forPane(key)[0]!, false, sentAt)).toBe(notConfirmedLabel);
    const actions = bubbleButtons();
    expect(actions.names).toEqual(["Show the terminal", "Put back", "Dismiss"]);
    // Put back, the person's act: the text and its picture as a chip, and the copy leaves drafts.json.
    actions.press("Put back");
    await tick();
    expect(draftNow()).toEqual({ text: caption, chips: 1 });
    expect(m.store.state().unproved).toBeUndefined();
  });

  it("a reload with the message proved meanwhile by the record: back as sent, never Not sent; the transcript settles it and its copy goes", async () => {
    const m = main();
    detach = attachSendKeeping(m.bridge);
    shown();
    await m.press();
    await tick();
    // Where the transcript stood went to main with the copy.
    expect(m.store.state().unproved![0]!.history).toEqual({ anchor: "a-0" });
    reload();
    // Main's check answered while the page was gone.
    m.answer("taken");
    detach = attachSendKeeping(m.bridge);
    restoreUnproved(m.store.state().unproved!, true, () => sentAt + 5_000);
    expect(pendingMessages.forPane(key).map((bubble) => [bubble.state, bubble.proved])).toEqual([["sent", true]]);
    pendingMessages.markNotSent(key);
    expect(states()).toEqual(["sent"]);
    // The first live transcript already holds it, after where the transcript stood: the bubble settles into it.
    shown(landed());
    expect(pendingMessages.forPane(key)).toEqual([]);
    await tick();
    expect(m.store.state().unproved).toBeUndefined();
  });

  it("a reload with the message proved meanwhile by the transcript: its own message, after where the transcript stood, settles the restored bubble", async () => {
    const m = main();
    detach = attachSendKeeping(m.bridge);
    shown();
    await m.press();
    await tick();
    reload();
    detach = attachSendKeeping(m.bridge);
    restoreUnproved(m.store.state().unproved!, true, () => sentAt + 40_000);
    expect(states()).toEqual(["unconfirmed"]);
    shown(landed("2026-11-20T10:00:25.000Z"));
    expect(pendingMessages.forPane(key)).toEqual([]);
    await tick();
    expect(m.store.state().unproved).toBeUndefined();
    // An identical message from before the send (by more than the clock slack) is never taken for it.
    const n = main();
    detach = attachSendKeeping(n.bridge);
    shown();
    await n.press();
    await tick();
    reload();
    restoreUnproved(n.store.state().unproved!, true, () => sentAt + 40_000);
    shown(landed("2026-11-20T09:50:00.000Z"));
    expect(states()).toEqual(["unconfirmed"]);
  });

  it("a quit and a start past the bound: back as could not confirm, with its actions; Dismiss lets it go", async () => {
    const files = new MemoryDraftFiles();
    const m = main(files);
    detach = attachSendKeeping(m.bridge);
    await m.press();
    // The app quits: its memory is gone; drafts.json was written at the Return.
    reload();
    const started = new DraftStore(files);
    const bridge = { unprovedRelease: async (id: string) => void started.releaseUnproved(id), sendCheckEnd: async () => undefined };
    detach = attachSendKeeping(bridge);
    restoreUnproved(started.state().unproved!, true, () => sentAt + 3_600_000);
    expect(states()).toEqual(["unconfirmed"]);
    expect(draftNow()).toEqual({ text: "", chips: 0 });
    const actions = bubbleButtons();
    expect(actions.names).toEqual(["Show the terminal", "Put back", "Dismiss"]);
    actions.press("Dismiss");
    await tick();
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(draftNow()).toEqual({ text: "", chips: 0 });
    expect(started.state().unproved).toBeUndefined();
  });

  it("a quit and a start with the message unproved and proved meanwhile: still checking, then main's word", async () => {
    const files = new MemoryDraftFiles();
    const m = main(files);
    await m.press();
    reload();
    const started = new DraftStore(files);
    restoreUnproved(started.state().unproved!, true, () => sentAt + 2_000, () => new Promise(() => undefined));
    expect(states()).toEqual(["sending"]);
    // Main's newer word (drafts-changed) for the bubble shown: taken.
    started.unprovedOutcome(started.state().unproved![0]!.id, "taken");
    restoreUnproved(started.state().unproved!, false);
    expect(pendingMessages.forPane(key).map((bubble) => [bubble.state, bubble.proved])).toEqual([["sent", true]]);
    // A change of main's never adds a bubble the page does not show (a receipt still on its way is never shown twice).
    reload();
    restoreUnproved(started.state().unproved!, false);
    expect(pendingMessages.forPane(key)).toEqual([]);
  });

  it("a new session in the pane: the bubble says could not confirm at once instead of going; its copy stays", async () => {
    const m = main();
    detach = attachSendKeeping(m.bridge);
    await m.press();
    expect(states()).toEqual(["sending"]);
    pendingMessages.reconcile(new Map([[key, { terminalID: "t1", session: "s2" }]]), () => true);
    expect(states()).toEqual(["unconfirmed"]);
    expect(m.store.state().unproved).toHaveLength(1);
    // A later snapshot of the same new session keeps it.
    pendingMessages.reconcile(new Map([[key, { terminalID: "t1", session: "s2" }]]), () => true);
    expect(states()).toEqual(["unconfirmed"]);
  });

  it("a pane gone: the bubble goes with the pane and main moves the copy to Kept drafts (released by nobody)", async () => {
    const m = main();
    detach = attachSendKeeping(m.bridge);
    await m.press();
    pendingMessages.reconcile(new Map(), () => true);
    expect(pendingMessages.forPane(key)).toEqual([]);
    await tick();
    expect(m.store.state().unproved).toHaveLength(1);
    m.store.hostAnswered(host, "Fixture host", new Set());
    expect(m.store.state().kept).toMatchObject([{ paneId: "p1", text: caption, chips: [{ path: picture }], reason: "Adari could not confirm Claude Code got this. Its pane is gone." }]);
    expect(m.store.state().unproved).toBeUndefined();
  });
});

describe("the second review's cases on the page", () => {
  it("no room for its copy: refused before any key; its text and picture stay in the composer with the words; no bubble", async () => {
    const m = main(new MemoryDraftFiles(), () => sentAt, true);
    detach = attachSendKeeping(m.bridge);
    await m.press();
    await tick();
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(draftNow()).toEqual({ text: caption, chips: 1 });
    expect(composerDrafts.get(key).error).toBe(unprovedNoRoomText);
    expect(m.store.state().unproved).toBeUndefined();
  });

  it("still in the box, then a new session: could not confirm with Show the terminal, Put back and Dismiss (fix 5)", async () => {
    const m = main();
    detach = attachSendKeeping(m.bridge);
    shown();
    await m.press();
    m.answer("stillInBox");
    await tick();
    expect(states()).toEqual(["inBox"]);
    expect(bubbleButtons().names).toEqual(["Show the terminal", "Dismiss"]);
    pendingMessages.reconcile(new Map([[key, { terminalID: "t1", session: "s2" }]]), () => true);
    expect(states()).toEqual(["unconfirmed"]);
    const actions = bubbleButtons();
    expect(actions.names).toEqual(["Show the terminal", "Put back", "Dismiss"]);
    // The new session's identical message, after the Send, never settles it nor lets its copy go (fix 3).
    pendingMessages.observe(key, timelineOf([claudeUser("u-9", null, message, "2026-11-20T10:00:20.000Z", { promptSource: "typed" })]).timeline);
    await tick();
    expect(states()).toEqual(["unconfirmed"]);
    expect(m.store.state().unproved).toHaveLength(1);
    // Put back is the person's own act: its text and picture in the composer, its copy gone.
    actions.press("Put back");
    await tick();
    expect(draftNow()).toEqual({ text: caption, chips: 1 });
    expect(m.store.state().unproved).toBeUndefined();
  });
});

describe("Esc takes back a message whose check is running (fix 6)", () => {
  it("past its Return, its check pending: labelled Queued while Claude works and a take-back candidate; not before its Return", async () => {
    const m = main();
    await m.press();
    const bubble = pendingMessages.forPane(key)[0]!;
    expect(pendingLabel(bubble, true, sentAt)).toBe("Queued");
    expect(queuedSends(pendingMessages.forPane(key), "t1").map((item) => item.text)).toEqual([message]);
    // A bubble whose keys have not gone yet is not one.
    pendingMessages.add(key, "still on its way", sentAt, scope);
    expect(queuedSends(pendingMessages.forPane(key), "t1").map((item) => item.text)).toEqual([message]);
  });

  it("taken back by the record's word: the bubble goes, its copy and its check end, its text and picture back in the box", async () => {
    const m = main();
    detach = attachSendKeeping(m.bridge);
    await m.press();
    const takeBacks = new TakeBacks();
    const notes: string[] = [];
    const asked: string[][] = [];
    const end = await takeBacks.run(
      {
        bridge: { takeBackQueued: async (_h, _p, _b, texts) => (asked.push([...texts]), { type: "taken", texts: [...texts], note: takeBackTexts.taken }) },
        drafts: composerDrafts,
        pending: pendingMessages,
        landing: () => undefined,
        note: (_key, text) => void notes.push(text),
      },
      host,
      "p1",
      key,
      {} as never,
      queuedSends(pendingMessages.forPane(key), "t1"),
    );
    expect(end).toBe("taken");
    expect(asked).toEqual([[message]]);
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(draftNow()).toEqual({ text: caption, chips: 1 });
    await tick();
    expect(m.store.state().unproved).toBeUndefined();
    expect(m.ended).toEqual(["check-1"]);
  });

  it("nothing queued on Claude's screen: the take-back answers none, so Esc stops as today", async () => {
    const m = main();
    await m.press();
    const end = await new TakeBacks().run(
      { bridge: { takeBackQueued: async () => ({ type: "none" }) }, drafts: composerDrafts, pending: pendingMessages, landing: () => undefined, note: () => undefined },
      host,
      "p1",
      key,
      {} as never,
      queuedSends(pendingMessages.forPane(key), "t1"),
    );
    expect(end).toBe("none");
    expect(states()).toEqual(["sending"]);
  });
});

describe("the bound runs on its own clock", () => {
  it("a check that never answers: could not confirm at the bound from the receipt", async () => {
    vi.useFakeTimers();
    await sendWithPending(async () => ({ check: "check-1" }), host, "p1", message, true, scope, Date.now, false, { check: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(sendProofBoundMs - 1);
    expect(states()).toEqual(["sending"]);
    await vi.advanceTimersByTimeAsync(2);
    expect(states()).toEqual(["unconfirmed"]);
  });

  it("a late answer applies only while the bubble is there", async () => {
    vi.useFakeTimers();
    let answer: (outcome: SendCheck) => void = () => undefined;
    await sendWithPending(async () => ({ check: "check-1" }), host, "p1", message, true, scope, Date.now, false, { check: () => new Promise((resolve) => (answer = resolve)) });
    await vi.advanceTimersByTimeAsync(sendProofBoundMs + 1);
    expect(states()).toEqual(["unconfirmed"]);
    answer("taken");
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingMessages.forPane(key).map((bubble) => [bubble.state, bubble.proved])).toEqual([["sent", true]]);
    // Put back first, then the late word: nothing comes back.
    pendingMessages.clear();
    let late: (outcome: SendCheck) => void = () => undefined;
    await sendWithPending(async () => ({ check: "check-2" }), host, "p1", message, true, scope, Date.now, false, { check: () => new Promise((resolve) => (late = resolve)) });
    await vi.advanceTimersByTimeAsync(sendProofBoundMs + 1);
    expect(pendingMessages.takeNotSent(pendingMessages.forPane(key)[0]!.id)).toBe(message);
    late("taken");
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingMessages.forPane(key)).toEqual([]);
  });
});

describe("Show the terminal where Chat is unavailable", () => {
  it("a bubble shown under the unavailable explanation has Show the terminal", () => {
    let listener: ((event: unknown) => void) | null = null;
    vi.stubGlobal("window", {
      herdrDesktop: { onChatUpdate: (l: (event: unknown) => void) => ((listener = l), () => undefined), openChat: () => undefined, closeChat: () => undefined, setChatFollowing: () => undefined, copyText: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      getSelection: () => null,
      sessionStorage: { getItem: () => null, setItem: () => undefined },
    });
    vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => (callback(0), 0));
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {}
    });
    const topology = decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
      panes: [{ pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "idle", revision: 1 }],
      layouts: [],
      agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s1" } }],
    });
    const view: HostView = { id: "host", name: "host", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology };
    const row = { paneID: "w1:p1", status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true } as unknown as SidebarRow;
    let shown = 0;
    const chat = new HookHost(ChatView as (props: object) => unknown, { host: view, row, onShowTerminal: () => void shown++ });
    chat.render();
    listener!({ hostId: "host", paneId: "w1:p1", state: { status: "unavailable", reason: "notFound" }, timeline: emptyTimeline });
    const id = pendingMessages.add("host/w1:p1", message, Date.now(), { terminalID: "t1", session: "s1" });
    pendingMessages.unconfirmed(id);
    chat.render();
    const bubble = elements(chat.tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === "PendingBubble");
    expect(bubble?.props["message"]).toMatchObject({ state: "unconfirmed" });
    expect(bubble?.props["onShowTerminal"]).toBeTypeOf("function");
    (bubble!.props["onShowTerminal"] as () => void)();
    expect(shown).toBe(1);
    chat.unmount();
  });
});
