// A send takes the user to the bottom. Away from the end (following off), a
// new pending bubble alone would only light the New pill; instead, anything
// they send from this Mac in this Chat that adds a row (a message,
// pictures, a typed / command's row) takes the Chat to its end and it follows
// again, wherever they were scrolled; the New pill clears; it stays at the end as
// the transcript's row replaces the pending bubble and as the reply streams in.
// At the end, the box shrinking after a multi-line draft is sent never leaves
// the end short of the bottom, also when a row grew under the end before the
// browser delivered the pin's scroll event. A send in another tile does not
// move this one. Load earlier and a search or away reveal keep their place
// until they send.
//
// The real ChatView and Composer run on the small hooks host. The chat's
// scroller is a model of the browser's: its height is the rows' plus the
// box's inset, a scrollTop set past the end is clamped, and a frame delivers
// the scroll event (if it moved) before the resize observers, as Chromium
// orders them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { at, reply, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { ChatView } = await import("../src/renderer/chat/ChatView");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { commandRows } = await import("../src/renderer/chat/command-rows");
const { revealRequests } = await import("../src/renderer/search/reveal");

/** The browser's scroller, as far as following reads it. */
class Scroller {
  rows: number;
  inset: number;
  readonly clientHeight = 754;
  private top = 0;
  /** Moved since the last frame: a scroll event is due. */
  moved = false;
  /** Where a reveal puts its row (scrollIntoView). */
  revealAt = 900;
  constructor(rows: number, inset: number) {
    this.rows = rows;
    this.inset = inset;
  }
  get scrollHeight(): number {
    return this.rows + this.inset;
  }
  get scrollTop(): number {
    return this.top;
  }
  set scrollTop(value: number) {
    const next = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    if (next === this.top) return;
    this.top = next;
    this.moved = true;
  }
  /** Layout after the rows or the inset changed: a scrollTop past the new end is clamped. */
  layout(): void {
    this.scrollTop = this.top;
  }
  gap(): number {
    return this.scrollHeight - this.top - this.clientHeight;
  }
  /** A reveal's anchor: the row after it scrolls to the middle. */
  querySelector(): unknown {
    return { nextElementSibling: { scrollIntoView: () => (this.scrollTop = this.revealAt), classList: { add: () => undefined, remove: () => undefined } } };
  }
}

let deliver: ((event: ChatUpdateEvent) => void) | null = null;
let following: [boolean, string | undefined][] = [];
let sends: { paneId: string; text: string; done(): void }[] = [];
let observers: (() => void)[] = [];
let earlierAsked = 0;
const mounted: (() => void)[] = [];

beforeEach(() => {
  following = [];
  sends = [];
  observers = [];
  earlierAsked = 0;
  vi.spyOn(Date, "now").mockImplementation(() => at(1_000) * 1_000);
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: (_hostId: string, paneId: string, text: string) =>
        new Promise<void>((resolve) => {
          sends.push({ paneId, text, done: resolve });
        }),
      uploadAttachment: () => Promise.reject(new Error("no uploads here")),
      stopAgent: () => Promise.resolve(null),
      openChat: () => undefined,
      closeChat: () => undefined,
      loadEarlierChat: () => {
        earlierAsked += 1;
        return Promise.resolve();
      },
      setChatFollowing: (value: boolean, slot?: string) => following.push([value, slot]),
      copyText: () => undefined,
      onChatUpdate: (listener: (event: ChatUpdateEvent) => void) => {
        deliver = listener;
        return () => undefined;
      },
    },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => null,
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined, contains: () => false } }, activeElement: null, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        observers.push(this.callback);
      }
      disconnect(): void {
        observers = observers.filter((callback) => callback !== this.callback);
      }
    },
  );
  composerDrafts.clear();
  pendingMessages.clear();
  commandRows.clear();
  revealRequests.clear();
});

afterEach(() => {
  // A case that failed half way leaves nothing mounted for the next (its store subscriptions, its follows).
  for (const unmount of mounted.splice(0)) unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function topologyOf(status: string, panes: readonly string[]) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: panes.map((pane_id, i) => ({ pane_id, terminal_id: `t-${i}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 })),
    layouts: [],
    agents: panes.map((pane_id, i) => ({
      pane_id,
      agent: "claude",
      agent_status: status,
      terminal_id: `t-${i}`,
      state_change_seq: 3,
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: `s-${i}` },
    })),
  });
}

const hostOf = (status = "idle", panes: readonly string[] = ["w1:p1"]): HostView =>
  ({ id: "mac", name: "Mac mini", state: "connected", topology: topologyOf(status, panes), connection: 1, incarnation: 1, epoch: 1 }) as unknown as HostView;

const rowOf = (paneID = "w1:p1", status = "idle") =>
  ({ paneID, name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle" }) as unknown as SidebarRow;

/** 30 finished exchanges, then whatever the test adds. */
const history = Array.from({ length: 30 }, (_, i) => [user(`question ${i}`, `u${i}`, 300 + i * 20), reply(`answer ${i}`, `a${i}`, 300 + i * 20 + 5, true)]).flat();

/**
 * One pane's Chat (the one pane view's, or a tile's) and its box, as MainPane
 * and a Tile put them together: the floating box's height is the Chat's bottom
 * inset.
 */
function pane(paneId = "w1:p1", options: { tile?: boolean; panes?: readonly string[] } = {}) {
  const panes = options.panes ?? [paneId];
  let status = "idle";
  let inset = options.tile === true ? 0 : 105;
  const chatProps = () => ({ host: hostOf(status, panes), row: rowOf(paneId, status), onShowTerminal: () => undefined, bottomInset: inset, tile: options.tile === true });
  const scroll = new Scroller(0, inset);
  // The DOM's refs attached as React attaches them: after the render, before its effects.
  const column = {};
  const withRefs = (props: object): unknown => {
    const tree = (ChatView as (p: object) => unknown)(props);
    for (const element of elements(tree)) {
      const ref = element.props["ref"] as { current: unknown } | undefined;
      if (ref === undefined || ref === null) continue;
      if (element.props["className"] === "chat-scroll") ref.current = scroll;
      if (element.props["className"] === "chat-col") ref.current = column;
    }
    return tree;
  };
  const view = new HookHost<Record<string, unknown>>(withRefs, chatProps());
  view.render();
  const scroller = () => elements(view.tree).find((e) => e.props["className"] === "chat-scroll")!;
  const box = new HookHost<Record<string, unknown>>(Composer as (p: object) => unknown, {
    host: hostOf(status, panes),
    row: rowOf(paneId, status),
    floating: options.tile !== true,
    compact: options.tile === true,
    stops: true,
    takesKeys: true,
  });
  box.render();
  const textarea = () => elements(box.tree).find((e) => e.type === "textarea")!;
  let lines = [...history];
  const show = (timeline: ChatTimeline): void => deliver!({ hostId: "mac", paneId, state: { status: "live" }, timeline });
  const p = {
    view,
    box,
    scroll,
    key: draftKey("mac", paneId),
    /** The transcript as the feed reads it, the rows' height laid out with it. */
    transcript(next: readonly string[], rows: number, extra: Partial<ChatTimeline> = {}): void {
      lines = [...next];
      scroll.rows = rows;
      const read = timelineOf(lines).timeline;
      // The feed's turns keep their ids as earlier ones go in above (the test parser numbers them from the top).
      show({ ...read, turns: read.turns.map((turn) => ({ ...turn, id: `turn-${turn.items[0]?.value.id ?? turn.id}` })), ...extra });
      scroll.layout();
    },
    lines: () => lines,
    /** A frame: the scroll event if it moved, then the resize observers (Chromium's order). */
    frame(): void {
      if (scroll.moved) {
        scroll.moved = false;
        (scroller().props["onScroll"] as () => void)();
      }
      for (const callback of observers.slice()) callback();
      scroll.moved = false;
    },
    /** The user's wheel: the chat scrolled to `top`, its event delivered. */
    scrollTo(top: number): void {
      // The wheel's own event comes first (only the user's gesture lets go of the end).
      (scroller().props["onWheel"] as (e: unknown) => void)({ deltaY: top - scroll.scrollTop, ctrlKey: false });
      scroll.scrollTop = top;
      p.frame();
    },
    type(text: string): void {
      (textarea().props["onChange"] as (e: unknown) => void)({ target: { value: text } });
    },
    /** Return in the box; `rows` is the height the new row adds (laid out in the same commit). */
    enter(rows: number): void {
      scroll.rows += rows;
      const event = { key: "Enter", shiftKey: false, metaKey: false, altKey: false, ctrlKey: false, repeat: false, defaultPrevented: false, nativeEvent: { isComposing: false }, preventDefault() {} };
      (textarea().props["onKeyDown"] as (e: unknown) => void)(event);
    },
    /** The floating box's new height (MainPane's onHeight to the Chat's bottomInset). */
    boxHeight(height: number): void {
      inset = height;
      scroll.inset = height;
      scroll.layout();
      view.render(chatProps());
    },
    /** Herdr's status for the pane (the Working line shows while working); `rows`: what that adds. */
    status(next: string, rows: number): void {
      status = next;
      scroll.rows += rows;
      view.render(chatProps());
      box.render({ host: hostOf(status, panes), row: rowOf(paneId, status), floating: options.tile !== true, compact: options.tile === true, stops: true, takesKeys: true });
    },
    newPill: () => elements(view.tree).some((e) => e.props["className"] === "chat-new"),
    /** "Load earlier messages" (the Earlier row's button calls its onLoad). */
    loadEarlier(): void {
      const earlier = elements(view.tree).find((e) => typeof e.type === "function" && (e.type as { name: string }).name === "Earlier")!;
      (earlier.props["onLoad"] as () => void)();
    },
    pending: () => pendingMessages.forPane(draftKey("mac", paneId)).length,
    unmount(): void {
      const at = mounted.indexOf(p.unmount);
      if (at >= 0) mounted.splice(at, 1);
      box.unmount();
      view.unmount();
    },
  };
  mounted.push(p.unmount);
  p.transcript(history, 6_000);
  return p;
}

const lastFollowing = (slot?: string): boolean | undefined => following.filter(([, s]) => s === slot).at(-1)?.[0];

describe("a send from mid-history takes the user to the end", () => {
  it("a message: to the end, following again, the New pill gone; it stays there as the transcript's row replaces the bubble and the reply streams in", async () => {
    const p = pane();
    expect(p.scroll.gap()).toBe(0);
    p.scrollTo(1_500);
    expect(lastFollowing()).toBe(false);
    // A row lands while the user reads history: their place is kept, the New pill lights.
    p.transcript([...history, user("from the iPhone", "u-phone", 900)], 6_100);
    expect(p.scroll.scrollTop).toBe(1_500);
    expect(p.newPill()).toBe(true);

    p.type("Can you check the release notes once more?");
    p.enter(80);
    expect(p.pending()).toBe(1);
    expect(p.scroll.gap()).toBe(0);
    expect(p.newPill()).toBe(false);
    expect(lastFollowing()).toBe(true);
    p.frame();
    expect(p.scroll.gap()).toBe(0);

    // The send lands (the box empties), the feed reads it, then the transcript has the user's message: the bubble goes, its row stays.
    sends[0]!.done();
    await flush();
    p.transcript(p.lines(), 6_180);
    p.transcript([...p.lines(), user("Can you check the release notes once more?", "u-sent", 1_001)], 6_180);
    expect(p.pending()).toBe(0);
    p.frame();
    expect(p.scroll.gap()).toBe(0);
    // The reply streams in, row by row, and the Working line comes.
    p.status("working", 48);
    p.frame();
    expect(p.scroll.gap()).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      p.transcript([...p.lines(), reply(`part ${i} of the answer`, `r${i}`, 1_005 + i)], p.scroll.rows + 220);
      expect(p.scroll.gap()).toBe(0);
      p.frame();
      expect(p.scroll.gap()).toBe(0);
    }
    expect(p.newPill()).toBe(false);
    expect(lastFollowing()).toBe(true);
    p.unmount();
  });

  it("pictures (an attachment, no text): to the end", () => {
    const p = pane();
    p.scrollTo(1_200);
    composerDrafts.restore(p.key, "", [{ path: "/tmp/herdr-uploads/shot.png", name: "shot.png", image: true }], []);
    p.box.render();
    p.enter(140);
    expect(sends).toHaveLength(1);
    expect(p.pending()).toBe(1);
    expect(p.scroll.gap()).toBe(0);
    expect(lastFollowing()).toBe(true);
    p.unmount();
  });

  it("a typed / command's row: to the end", () => {
    const p = pane();
    p.scrollTo(1_200);
    p.type("/compact");
    p.enter(40);
    expect(sends.map((s) => s.text)).toEqual(["/compact"]);
    expect(commandRows.forPane(p.key)).toHaveLength(1);
    expect(p.scroll.gap()).toBe(0);
    expect(p.newPill()).toBe(false);
    expect(lastFollowing()).toBe(true);
    p.unmount();
  });

  it("nothing to send (an empty box) moves nothing", () => {
    const p = pane();
    p.scrollTo(1_200);
    p.enter(0);
    expect(sends).toEqual([]);
    expect(p.scroll.scrollTop).toBe(1_200);
    p.unmount();
  });
});

describe("a send at the end with a multi-line draft", () => {
  const draft = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: check the release notes against the tests.`).join("\n");

  it("stays at the end after the box shrinks (the bubble first, the box after the send lands)", async () => {
    const p = pane();
    p.type(draft);
    p.boxHeight(310);
    expect(p.scroll.gap()).toBe(0);
    p.enter(250);
    expect(p.scroll.gap()).toBe(0);
    p.frame();
    sends[0]!.done();
    await flush();
    expect(composerDrafts.get(p.key).text).toBe("");
    p.boxHeight(105);
    expect(p.scroll.gap()).toBe(0);
    p.frame();
    p.transcript([...p.lines(), user(draft, "u-sent", 1_001)], p.scroll.rows);
    p.transcript([...p.lines(), reply("Checked: two are missing.", "r0", 1_004)], p.scroll.rows + 160);
    p.frame();
    expect(p.scroll.gap()).toBe(0);
    expect(lastFollowing()).not.toBe(false);
    p.unmount();
  });

  it("stays at the end when a row grows under it before the browser delivers the pin's scroll event (the Working line), then the box shrinks and the reply streams in", async () => {
    const p = pane();
    p.type(draft);
    p.boxHeight(310);
    p.enter(250);
    // Herdr says working in the same frame: the Working line (not a new end row) lands before the scroll event.
    p.status("working", 60);
    p.frame();
    expect(p.scroll.gap()).toBe(0);
    sends[0]!.done();
    await flush();
    p.boxHeight(105);
    p.frame();
    expect(p.scroll.gap()).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      p.transcript([...p.lines(), reply(`part ${i}`, `r${i}`, 1_004 + i)], p.scroll.rows + 200);
      p.frame();
      expect(p.scroll.gap()).toBe(0);
    }
    expect(p.newPill()).toBe(false);
    p.unmount();
  });

  it("the user's own scroll up still leaves the end (following off, the New pill on a new row)", () => {
    const p = pane();
    p.status("working", 60);
    p.frame();
    p.scrollTo(p.scroll.scrollTop - 300);
    expect(lastFollowing()).toBe(false);
    p.transcript([...p.lines(), reply("more", "r-more", 1_002)], p.scroll.rows + 200);
    p.frame();
    expect(p.scroll.gap()).toBeGreaterThan(400);
    expect(p.newPill()).toBe(true);
    p.unmount();
  });
});

describe("a split: a send in another tile does not move this one", () => {
  it("only the tile the user sent from goes to its end", () => {
    const panes = ["w1:p1", "w1:p2"];
    const left = pane("w1:p1", { tile: true, panes });
    const right = pane("w1:p2", { tile: true, panes });
    left.scrollTo(1_000);
    right.scrollTo(1_300);
    right.type("and the right one?");
    right.enter(80);
    left.frame();
    right.frame();
    expect(right.scroll.gap()).toBe(0);
    expect(lastFollowing("mac/w1:p2")).toBe(true);
    expect(left.scroll.scrollTop).toBe(1_000);
    expect(lastFollowing("mac/w1:p1")).toBe(false);
    left.unmount();
    right.unmount();
  });
});

describe("Load earlier and a reveal keep their place until the user sends", () => {
  it("Load earlier keeps what was on screen; a send before the earlier rows arrive ends at the end, and their arrival does not pull the user back", () => {
    const p = pane();
    p.transcript(history, 6_000, { earlier: "available" });
    p.scrollTo(800);
    p.loadEarlier();
    expect(earlierAsked).toBe(1);
    // Without a send: the earlier rows go in above and what the user read stays where it was.
    const older = [user("older question", "u-old", 100), reply("older answer", "a-old", 105, true)];
    p.transcript([...older, ...history], 7_000);
    expect(p.scroll.scrollTop).toBe(1_800);
    // Again, and this time the user sends before they arrive.
    p.transcript([...older, ...history], 7_000, { earlier: "available" });
    p.loadEarlier();
    p.type("never mind the history");
    p.enter(80);
    expect(p.scroll.gap()).toBe(0);
    const oldest = [user("oldest question", "u-oldest", 50), reply("oldest answer", "a-oldest", 55, true)];
    p.transcript([...oldest, ...older, ...history], 8_080);
    p.frame();
    expect(p.scroll.gap()).toBe(0);
    p.unmount();
  });

  it("a search or away reveal keeps its row where it put it as rows land, until the user sends", () => {
    const p = pane();
    // Search's hit: an early message of the user's (its id as the timeline has it).
    const hit = timelineOf(history).timeline.turns[3]!.items[0]!.value.id;
    revealRequests.ask("mac", "w1:p1", hit);
    p.view.render();
    p.frame();
    expect(p.scroll.scrollTop).toBe(900);
    expect(lastFollowing()).toBe(false);
    p.transcript([...history, reply("a new line", "r-new", 900)], 6_200);
    p.frame();
    expect(p.scroll.scrollTop).toBe(900);
    expect(p.newPill()).toBe(true);
    p.type("thanks");
    p.enter(60);
    expect(p.scroll.gap()).toBe(0);
    expect(p.newPill()).toBe(false);
    p.unmount();
  });
});

describe("the demo capture pair (main.ts takes them after demoCaptureSteps' 40)", () => {
  it("scrolled up with a draft before Send, then Send; at the end with a 10-line draft, then Send; each measured", async () => {
    const { demoCaptureSteps, sendCaptureSteps } = await import("../src/main/capture");
    const { demoHostIds } = await import("../src/main/demo/demo-hosts");
    const steps = sendCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["41-scrolled-up-before-send", "42-after-send-at-end", "43-multiline-draft-at-end", "44-multiline-sent-at-end"]);
    expect(demoCaptureSteps(demoHostIds).at(-1)!.name).toBe("40-new-workspace-made");
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: "w6:p1" });
    expect(steps[1]!.commands).toEqual([{ type: "click", selector: ".cmp-bar .send.on" }]);
    expect(steps[3]!.commands).toEqual([{ type: "click", selector: ".cmp-bar .send.on" }]);
    expect(steps.every((step) => step.measure?.includes("gapToEnd") === true)).toBe(true);
  });
});
