// The Mac Chat lets go of the newest only on the user's own gesture (the T3
// Code way). A scroll event that goes up and leaves the end band is not
// enough: the browser's scroll anchoring or a clamp after the rows above
// shrank makes one with nobody touching anything. Letting go then would make
// the feed keep the top (the builder grows the shown limit by one per arrival
// up to the 2,000-item cap) and, at the cap, take the newest back and stop
// reading, so a long session's Chat would stop showing new messages. A reveal
// stops following on the tile's own feed, not the default slot's.
//
// Only the user's wheel or key up, a touch or a drag on the scrollbar (or a
// reveal, a UI command) lets go; while following, a move the user did not make
// goes back to the end. Back at the end (or the New pill, or a send) it follows
// again and the shown limit returns to `maxItems`.
//
// The real ChatView runs on the small hooks host with the browser's scroller
// modelled as chat-send-follow.test.ts has it (a scrollTop past the end is
// clamped; a frame delivers the scroll event, then the resize observers),
// plus the document its key and pointer-up listeners go on. Where a real
// ChatFeed sits behind it, setChatFollowing reaches that feed by slot as
// ipc.ts:681-682 maps it (no slot: the default "").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatFollowGate, chatScrollOutcome, editableTarget, gestureGlideMs, overlayScrollbarPx, scrollbarHit } from "../src/renderer/chat/follow-gate";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import type { ChatFeed, ChatFeedUpdate } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import { timelineItemCount, turnUserMessage, userMessage, type ChatTimeline } from "../src/shared/chat/model";
import type { ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { claudePath, eventually, FakeTranscriptReader, liveFeed, loadAll, text, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { revealRequests } = await import("../src/renderer/search/reveal");

/** `count` user lines, `message-<first>` first (one item, one turn each). */
const messageLines = (count: number, first = 0): string[] =>
  Array.from({ length: count }, (_, n) => `message-${first + n}`).map((name, n) => user(name, name, (first + n) % 3_000));
const messages = (count: number, first = 0): string => text(messageLines(count, first));
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, n) => `message-${from + n}`);
const texts = (timeline: ChatTimeline): string[] => timeline.turns.map((turn) => turnUserMessage(turn)?.text ?? "");

/** The document the Chat lives in: its key and pointer-up listeners, and its body. */
/** The window around it (its blur). */
class View {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener();
  }
}

class Page {
  readonly body = { tagName: "BODY" };
  readonly documentElement = { tagName: "HTML" };
  readonly defaultView = new View();
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: object): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
  heard(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** The browser's scroller, as far as following reads it (chat-send-follow.test.ts's model). */
class Scroller {
  rows = 0;
  inset = 0;
  readonly clientHeight = 754;
  private top = 0;
  /** Moved since the last frame: a scroll event is due. */
  moved = false;
  /** Where a reveal puts its row (scrollIntoView). */
  revealAt = 300;
  /** A message row inside the Chat (a key's target with the focus in it, a press on a row). */
  readonly row = { tagName: "DIV" };
  /** 1,015 px wide at x 0; a classic scrollbar takes 15 px of it at the right (0: an overlay one). */
  readonly clientLeft = 0;
  constructor(
    readonly ownerDocument: Page,
    readonly bar = 15,
  ) {}
  get clientWidth(): number {
    return 1_015 - this.bar;
  }
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number } {
    return { left: 0, right: 1_015, top: 0, bottom: this.clientHeight };
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
  /** Layout after the rows changed: a scrollTop past the new end is clamped. */
  layout(): void {
    this.scrollTop = this.top;
  }
  gap(): number {
    return this.scrollHeight - this.top - this.clientHeight;
  }
  contains(node: unknown): boolean {
    return node === this || node === this.row;
  }
  querySelector(): unknown {
    return { nextElementSibling: { scrollIntoView: () => (this.scrollTop = this.revealAt), classList: { add: () => undefined, remove: () => undefined } } };
  }
}

/** Each item's row height in the model. */
const itemHeight = 60;

let deliver: ((event: ChatUpdateEvent) => void) | null = null;
let following: [boolean, string | undefined][] = [];
let observers: (() => void)[] = [];
/** The feeds setChatFollowing reaches, by slot as ipc.ts maps it (none: ""). */
const feeds = new Map<string, { setFollowingNewest(value: boolean): void }>();
const mounted: (() => void)[] = [];

beforeEach(() => {
  following = [];
  observers = [];
  feeds.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      openChat: () => undefined,
      closeChat: () => undefined,
      loadEarlierChat: () => Promise.resolve(),
      setChatFollowing: (value: boolean, slot?: string) => {
        following.push([value, slot]);
        feeds.get(slot ?? "")?.setFollowingNewest(value);
      },
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
  vi.stubGlobal("document", { body: { classList: { add: () => undefined, remove: () => undefined, contains: () => false } }, activeElement: null, fonts: { ready: Promise.resolve() } });
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
  pendingMessages.clear();
  revealRequests.clear();
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function topologyOf(panes: readonly string[]) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: panes.map((pane_id, i) => ({ pane_id, terminal_id: `t-${i}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", revision: 1 })),
    layouts: [],
    agents: panes.map((pane_id, i) => ({
      pane_id,
      agent: "claude",
      agent_status: "idle",
      terminal_id: `t-${i}`,
      state_change_seq: 3,
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: `s-${i}` },
    })),
  });
}

const hostOf = (panes: readonly string[]): HostView =>
  ({ id: "mac", name: "Mac mini", state: "connected", topology: topologyOf(panes), connection: 1, incarnation: 1, epoch: 1 }) as unknown as HostView;

const rowOf = (paneID: string) =>
  ({ paneID, name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status: "idle", glyph: "idle" }) as unknown as SidebarRow;

/**
 * One pane's Chat (the one pane view's, or a tile's), showing a real feed's
 * updates or a fixed timeline, each item `itemHeight` tall.
 */
function chat(
  options: { paneId?: string; panes?: readonly string[]; tile?: boolean; feed?: ChatFeed<TranscriptSessionRef>; timeline?: ChatTimeline; page?: Page; keysActive?: boolean; bar?: number } = {},
) {
  const paneId = options.paneId ?? "w1:p1";
  const page = options.page ?? new Page();
  let scroll = new Scroller(page, options.bar);
  let props = { host: hostOf(options.panes ?? [paneId]), row: rowOf(paneId), onShowTerminal: () => undefined, bottomInset: 0, tile: options.tile === true, keysActive: options.keysActive ?? true };
  const column = {};
  const withRefs = (p: object): unknown => {
    const tree = (ChatView as (p: object) => unknown)(p);
    for (const element of elements(tree)) {
      const ref = element.props["ref"] as { current: unknown } | undefined;
      if (ref === undefined || ref === null) continue;
      if (element.props["className"] === "chat-scroll") ref.current = scroll;
      if (element.props["className"] === "chat-col") ref.current = column;
    }
    return tree;
  };
  const view = new HookHost<Record<string, unknown>>(withRefs, props);
  view.render();
  const scroller = () => elements(view.tree).find((e) => e.props["className"] === "chat-scroll")!;
  const show = (timeline: ChatTimeline): void => {
    scroll.rows = timelineItemCount(timeline) * itemHeight;
    deliver!({ hostId: "mac", paneId, state: { status: "live" }, timeline });
    scroll.layout();
  };
  let stopFeed = (): void => undefined;
  if (options.feed !== undefined) {
    const feed = options.feed;
    stopFeed = feed.subscribe((update: ChatFeedUpdate) => {
      if (update.state.status === "live") show(update.timeline);
    });
    show(feed.timeline);
  } else if (options.timeline !== undefined) show(options.timeline);
  const c = {
    view,
    get scroll(): Scroller {
      return scroll;
    },
    page,
    /** React gives the Chat another scroller element (its rows laid out the same). */
    replaceScroller(): Scroller {
      const next = new Scroller(page, scroll.bar);
      next.rows = scroll.rows;
      next.scrollTop = scroll.scrollTop;
      next.moved = false;
      scroll = next;
      view.render();
      return next;
    },
    /** SplitView's focus moving (keysActive). */
    keysActive(value: boolean): void {
      props = { ...props, keysActive: value };
      view.render(props);
    },
    /** A press on the scroller at x (1,008: its classic scrollbar; 10: the blank gutter left of the column). */
    press(x: number): void {
      c.handler("onPointerDown")({ target: scroll, currentTarget: scroll, clientX: x, clientY: 200, button: 0 });
    },
    /** The scroller's handler for a gesture (none: nothing to call). */
    handler: (name: string) => (event: unknown): void => (scroller().props[name] as ((event: unknown) => void) | undefined)?.(event),
    /** A frame: the scroll event if it moved, then the resize observers (Chromium's order). */
    frame(): void {
      if (scroll.moved) {
        scroll.moved = false;
        c.handler("onScroll")({});
      }
      for (const callback of observers.slice()) callback();
      scroll.moved = false;
    },
    /** A move nobody made (the browser's scroll anchoring, a clamp): the chat at `top`, its event delivered. */
    movedTo(top: number): void {
      scroll.scrollTop = top;
      c.frame();
    },
    wheel(deltaY: number, ctrlKey = false): void {
      c.handler("onWheel")({ deltaY, ctrlKey });
    },
    /** The user's wheel: its event, then the chat at `top` and its scroll event. */
    wheelTo(top: number): void {
      c.wheel(top - scroll.scrollTop);
      c.movedTo(top);
    },
    key(key: string, target: unknown, shiftKey = false): void {
      page.dispatch("keydown", { key, shiftKey, isComposing: false, target });
    },
    /** The user messages of the turns on show. */
    shown(): string[] {
      return elements(view.tree)
        .filter((e) => typeof e.type === "function" && (e.type as { name: string }).name === "Turn")
        .map((e) => turnUserMessage(e.props["turn"] as ChatTimeline["turns"][number])?.text ?? "");
    },
    newPill: () => elements(view.tree).some((e) => e.props["className"] === "chat-new"),
    unmount(): void {
      const at = mounted.indexOf(c.unmount);
      if (at >= 0) mounted.splice(at, 1);
      stopFeed();
      view.unmount();
    },
  };
  mounted.push(c.unmount);
  return c;
}

const told = (slot?: string): boolean[] => following.filter(([, s]) => s === slot).map(([value]) => value);

describe("the gate: only the user's gesture makes a scroll the user's own (T3 timelineViewport.ts:36-46, :178-203)", () => {
  it("a wheel up, a key up, a touch or a scrollbar drag arm it for the glide; a wheel down, a zoom, a key in a field or a press on a row do not", () => {
    const gate = new ChatFollowGate();
    expect(gate.ownScroll(0)).toBe(false);
    gate.heard({ source: "wheel", deltaY: 120, ctrlKey: false }, 0);
    gate.heard({ source: "wheel", deltaY: -120, ctrlKey: true }, 0);
    gate.heard({ source: "key", key: "PageDown", shiftKey: false, editable: false, composing: false }, 0);
    gate.heard({ source: "key", key: "ArrowUp", shiftKey: false, editable: true, composing: false }, 0);
    gate.heard({ source: "key", key: "PageUp", shiftKey: false, editable: false, composing: true }, 0);
    gate.heard({ source: "key", key: " ", shiftKey: false, editable: false, composing: false }, 0);
    gate.heard({ source: "pointerDown", onScrollbar: false }, 0);
    gate.heard({ source: "pointerUp" }, 0);
    expect(gate.ownScroll(0), "nothing that scrolls up armed it").toBe(false);

    gate.heard({ source: "wheel", deltaY: -120, ctrlKey: false }, 1_000);
    expect(gate.ownScroll(1_000 + gestureGlideMs)).toBe(true);
    expect(gate.ownScroll(1_001 + gestureGlideMs), "the glide is over").toBe(false);
    for (const key of ["PageUp", "Home", "ArrowUp"]) {
      gate.heard({ source: "key", key, shiftKey: false, editable: false, composing: false }, 5_000);
      expect(gate.ownScroll(5_000 + gestureGlideMs), key).toBe(true);
      expect(gate.ownScroll(5_001 + gestureGlideMs), key).toBe(false);
    }
    gate.heard({ source: "key", key: " ", shiftKey: true, editable: false, composing: false }, 6_000);
    expect(gate.ownScroll(6_000), "Shift-Space pages up").toBe(true);
    gate.heard({ source: "touch" }, 7_000);
    expect(gate.ownScroll(7_000 + gestureGlideMs)).toBe(true);
    expect(gate.ownScroll(7_001 + gestureGlideMs)).toBe(false);

    // A drag on the scrollbar: the user's for as long as it lasts, then the glide.
    gate.heard({ source: "pointerDown", onScrollbar: true }, 10_000);
    expect(gate.ownScroll(60_000)).toBe(true);
    gate.heard({ source: "pointerUp" }, 60_000);
    expect(gate.ownScroll(60_000 + gestureGlideMs)).toBe(true);
    expect(gate.ownScroll(60_001 + gestureGlideMs)).toBe(false);
  });

  it("a scroll event: at the end it follows; away from it, following lets go only on the user's own move up that is no clamp, else goes back to the end; let go, nothing changes", () => {
    const base = { following: true, atEnd: false, wentUp: true, shrank: false, own: true };
    expect(chatScrollOutcome(base)).toBe("release");
    expect(chatScrollOutcome({ ...base, own: false }), "a move up nobody made").toBe("pin");
    expect(chatScrollOutcome({ ...base, shrank: true }), "a clamp after a shrink").toBe("pin");
    expect(chatScrollOutcome({ ...base, wentUp: false }), "a row grew under the end").toBe("pin");
    expect(chatScrollOutcome({ ...base, atEnd: true })).toBe("follow");
    expect(chatScrollOutcome({ ...base, following: false, atEnd: true }), "back at the end").toBe("follow");
    expect(chatScrollOutcome({ ...base, following: false })).toBe("stay");
    expect(chatScrollOutcome({ ...base, following: false, own: false })).toBe("stay");
  });

  it("a field is a key's own target", () => {
    expect(editableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(editableTarget({ tagName: "INPUT" })).toBe(true);
    expect(editableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(editableTarget({ tagName: "DIV" })).toBe(false);
    expect(editableTarget({ tagName: "BODY" })).toBe(false);
    expect(editableTarget(null)).toBe(false);
  });
});

describe("a move the user did not make keeps following, and new lines keep showing past the cap", () => {
  it("the browser's scroll anchoring moves the Chat up 600 px with nobody touching it: still following, and 60 new lines past the 50-item cap all show", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(30), { maxItems: 20, historyCap: 50, reader });
    feeds.set("", feed);
    const c = chat({ feed });
    expect(c.scroll.gap()).toBe(0);
    expect(c.shown().at(-1)).toBe("message-29");

    c.movedTo(c.scroll.scrollTop - 600);

    reader.append(claudePath, messages(60, 30));
    expect(await eventually(() => c.shown().at(-1) === "message-89", 3_000), "the newest line shows (on 13fcfce9 the feed stopped at the cap)").toBe(true);
    expect(told(), "the feed is never told to stop following").toEqual([]);
    c.frame();
    expect(c.shown()).toEqual(range(70, 89));
    expect(feed.timeline.newerWaiting).toBe(false);
    expect(c.newPill()).toBe(false);
    expect(c.scroll.gap()).toBe(0);
    expect(told()).toEqual([]);
    feed.stop();
  });

  it("rows above get shorter during the user's wheel glide (a tick that did not move it) and the browser moves it up: a clamp, not the user's move; still following", () => {
    const c = chat({ timeline: timelineOf(messageLines(40)).timeline });
    expect(c.scroll.gap()).toBe(0);
    c.wheel(-4);
    // 300 px of rows above fold away; the browser keeps a row in view by moving up 500 px.
    c.scroll.rows -= 300;
    c.movedTo(c.scroll.scrollTop - 500);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
    // The user's next tick that does move it up lets go.
    c.wheelTo(c.scroll.scrollTop - 400);
    expect(told()).toEqual([false]);
  });
});

describe("the user's own gesture lets go and keeps their place; back at the end it follows again and shows everything", () => {
  it("a wheel up lets go; lines arriving go below what the user reads (the place kept) until the cap, then wait with New lit; back at the end: all of them, the newest 20 on show", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(30), { maxItems: 20, historyCap: 50, reader });
    feeds.set("", feed);
    const c = chat({ feed });
    expect(c.shown()).toEqual(range(10, 29));

    c.wheelTo(200);
    expect(told()).toEqual([false]);
    reader.append(claudePath, messages(40, 30));
    expect(await eventually(() => feed.timeline.newerWaiting, 3_000), "at the cap the newer lines wait").toBe(true);
    c.frame();
    expect(c.scroll.scrollTop, "the user's place").toBe(200);
    expect(c.shown(), "what the user reads stays; what came goes below it").toEqual(range(10, 59));
    expect(c.newPill()).toBe(true);

    // Back at the end (the user's wheel down): following again; every waiting line shows, the window back to 20.
    c.wheelTo(c.scroll.scrollHeight);
    expect(told()).toEqual([false, true]);
    expect(await eventually(() => c.shown().at(-1) === "message-69", 3_000)).toBe(true);
    c.frame();
    expect(c.shown()).toEqual(range(50, 69));
    expect(feed.timeline.newerWaiting).toBe(false);
    expect(c.newPill()).toBe(false);
    expect(c.scroll.gap()).toBe(0);
    feed.stop();
  });

  const gestures: { readonly name: string; readonly lets: boolean; readonly act: (c: ReturnType<typeof chat>) => void }[] = [
    { name: "PageUp on the page (after a click on a message's text)", lets: true, act: (c) => c.key("PageUp", c.page.body) },
    { name: "ArrowUp with the focus in the Chat", lets: true, act: (c) => c.key("ArrowUp", c.scroll.row) },
    { name: "Shift-Space on the page", lets: true, act: (c) => c.key(" ", c.page.body, true) },
    { name: "a touch moving", lets: true, act: (c) => c.handler("onTouchMove")({}) },
    { name: "a drag on the scrollbar", lets: true, act: (c) => c.press(1_008) },
    { name: "ArrowUp in the message box", lets: false, act: (c) => c.key("ArrowUp", { tagName: "TEXTAREA" }) },
    { name: "PageDown on the page", lets: false, act: (c) => c.key("PageDown", c.page.body) },
    { name: "a press on a row (not the scrollbar)", lets: false, act: (c) => c.handler("onPointerDown")({ target: c.scroll.row, currentTarget: c.scroll }) },
    { name: "a pinch (Ctrl-wheel, zoom)", lets: false, act: (c) => c.wheel(-300, true) },
    { name: "a wheel down", lets: false, act: (c) => c.wheel(300) },
  ];
  for (const gesture of gestures) {
    it(`${gesture.name}, then the Chat moving up 600 px: ${gesture.lets ? "lets go, the place kept" : "still following, back at the end"}`, () => {
      const c = chat({ timeline: timelineOf(messageLines(40)).timeline });
      const top = c.scroll.scrollTop;
      gesture.act(c);
      c.movedTo(top - 600);
      if (gesture.lets) {
        expect(told()).toEqual([false]);
        expect(c.scroll.scrollTop).toBe(top - 600);
      } else {
        expect(told()).toEqual([]);
        expect(c.scroll.gap()).toBe(0);
      }
    });
  }

  it("the document's listeners go with the Chat", () => {
    const c = chat({ timeline: timelineOf(messageLines(5)).timeline });
    expect(c.page.heard("keydown")).toBe(1);
    expect(c.page.heard("pointerup")).toBe(1);
    expect(c.page.heard("pointercancel")).toBe(1);
    c.unmount();
    expect(c.page.heard("keydown")).toBe(0);
    expect(c.page.heard("pointerup")).toBe(0);
    expect(c.page.heard("pointercancel")).toBe(0);
  });
});

describe("a slotted chat's reveal stops its own slot's feed only", () => {
  it("a search hit opening the left tile at a message: the left tile's feed lets go; the default slot's and the right tile's keep following", () => {
    const panes = ["w1:p1", "w1:p2"];
    const feedOf = () => ({ following: true, setFollowingNewest(value: boolean) { this.following = value; } });
    const defaultFeed = feedOf();
    const leftFeed = feedOf();
    const rightFeed = feedOf();
    feeds.set("", defaultFeed);
    feeds.set("mac/w1:p1", leftFeed);
    feeds.set("mac/w1:p2", rightFeed);
    const timeline = timelineOf(messageLines(40)).timeline;
    const left = chat({ paneId: "w1:p1", panes, tile: true, timeline });
    const right = chat({ paneId: "w1:p2", panes, tile: true, timeline });

    revealRequests.ask("mac", "w1:p1", timeline.turns[3]!.items[0]!.value.id);
    left.view.render();
    left.frame();
    right.frame();
    expect(following).toEqual([[false, "mac/w1:p1"]]);
    expect(leftFeed.following).toBe(false);
    expect(defaultFeed.following, "no slot's feed is told").toBe(true);
    expect(rightFeed.following).toBe(true);
    expect(left.scroll.scrollTop, "the row where the reveal put it").toBe(300);
    expect(right.scroll.gap()).toBe(0);
  });
});

describe("the shown limit comes back down when following resumes (builder.ts:998)", () => {
  const add = (builder: ChatTimelineBuilder, from: number, to: number): void => {
    for (let n = from; n <= to; n += 1) builder.applyEvent({ type: "userMessage", message: userMessage(`u${n}`, `message-${n}`, null) });
  };

  it("the builder: read up, the limit grows one per arrival (the top kept); following again, back to maxItems", () => {
    const builder = new ChatTimelineBuilder(3, 10);
    add(builder, 0, 2);
    builder.keepsTop = true;
    add(builder, 3, 6);
    expect(builder.limit).toBe(7);
    expect(texts(builder.timeline)).toEqual(range(0, 6));
    builder.followNewest();
    expect(builder.limit).toBe(3);
    expect(builder.keepsTop).toBe(false);
    expect(texts(builder.timeline)).toEqual(range(4, 6));
    // Following, what arrives moves the top (the window stays 3).
    add(builder, 7, 7);
    expect(texts(builder.timeline)).toEqual(range(5, 7));
  });

  it("the builder: earlier history the user loaded stays on show", () => {
    const builder = new ChatTimelineBuilder(3, 10);
    add(builder, 0, 5);
    builder.showHeld();
    builder.keepsTop = true;
    add(builder, 6, 7);
    builder.followNewest();
    expect(texts(builder.timeline)).toEqual(range(0, 7));
  });

  it("the feed: read up with 10 arrivals (30 on show); following again, the newest 20 show at once; a second read-up starts from there", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(30), { maxItems: 20, historyCap: 50, reader });
    const updates: ChatFeedUpdate[] = [];
    const stop = feed.subscribe((update) => updates.push(update));
    feed.setFollowingNewest(false);
    reader.append(claudePath, messages(10, 30));
    expect(await eventually(() => texts(feed.timeline).at(-1) === "message-39", 3_000)).toBe(true);
    expect(texts(feed.timeline)).toEqual(range(10, 39));

    const before = updates.length;
    feed.setFollowingNewest(true);
    expect(texts(feed.timeline)).toEqual(range(20, 39));
    expect(updates.length, "published at once").toBe(before + 1);
    expect(texts(updates.at(-1)!.timeline)).toEqual(range(20, 39));
    expect(feed.timeline.earlier).toBe("available");

    feed.setFollowingNewest(false);
    reader.append(claudePath, messages(5, 40));
    expect(await eventually(() => texts(feed.timeline).at(-1) === "message-44", 3_000)).toBe(true);
    expect(texts(feed.timeline), "the top kept from the window, not the ceiling").toEqual(range(20, 44));
    expect(feed.timeline.newerWaiting).toBe(false);
    stop();
    feed.stop();
  });

  it("the feed: after Load earlier to the cap, following again keeps it on show", async () => {
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(messages(80), { maxItems: 20, historyCap: 50, reader });
    await loadAll(feed);
    expect(timelineItemCount(feed.timeline)).toBe(50);
    feed.setFollowingNewest(false);
    feed.setFollowingNewest(true);
    expect(timelineItemCount(feed.timeline)).toBe(50);
    expect(feed.timeline.earlier).toBe("capped");
    feed.stop();
  });
});

describe("a gesture's ownership ends with the navigation", () => {
  const clock = (now: number) => vi.spyOn(performance, "now").mockReturnValue(now);
  const fixed = () => timelineOf(messageLines(40)).timeline;

  it("the gate: revoke ends the glide and the drag and grants nothing; keepsHeldDrag keeps a drag still held", () => {
    const gate = new ChatFollowGate();
    gate.heard({ source: "wheel", deltaY: -50, ctrlKey: false }, 1_000);
    gate.revoke();
    expect(gate.ownScroll(1_000)).toBe(false);
    gate.heard({ source: "pointerDown", onScrollbar: true }, 2_000);
    gate.revoke({ keepsHeldDrag: true });
    expect(gate.ownScroll(9_000), "the drag still held").toBe(true);
    gate.heard({ source: "wheel", deltaY: -50, ctrlKey: false }, 9_000);
    gate.revoke({ keepsHeldDrag: true });
    expect(gate.ownScroll(9_001), "the drag, not the wheel's window").toBe(true);
    gate.revoke();
    expect(gate.ownScroll(9_001)).toBe(false);
    gate.heard({ source: "pointerUp" }, 9_002);
    expect(gate.ownScroll(9_002), "an up after a revoked drag grants no glide").toBe(false);
  });

  for (const resume of ["the end", "New", "a send"] as const) {
    it(`following again on ${resume} 100 ms into a wheel's window: an anchoring move 100 ms later stays following`, async () => {
      const now = clock(1_000);
      const c = chat({ timeline: fixed() });
      c.wheelTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([false]);
      now.mockReturnValue(1_100);
      if (resume === "the end") c.wheelTo(c.scroll.scrollHeight);
      else if (resume === "New") {
        deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: { ...fixed(), newerWaiting: true } });
        (elements(c.view.tree).find((e) => e.props["className"] === "chat-new")!.props["onClick"] as () => void)();
      } else {
        const { chatSends } = await import("../src/renderer/chat/chat-state");
        chatSends.sent("mac/w1:p1");
      }
      expect(told()).toEqual([false, true]);
      expect(c.scroll.gap()).toBe(0);
      now.mockReturnValue(1_200);
      c.movedTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([false, true]);
      expect(c.scroll.gap()).toBe(0);
    });
  }

  it("our own re-pin (a reply landing) ends a wheel tick's window that stayed inside the band", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.wheel(-20);
    c.scroll.scrollTop -= 20;
    c.handler("onScroll")({});
    // A reply lands: rows grow and the layout effect pins (no frame's resize observer).
    deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(messageLines(41)).timeline });
    expect(c.scroll.gap()).toBe(0);
    now.mockReturnValue(1_100);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });

  it("a cancelled scrollbar press ends its ownership at once (no glide)", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.press(1_008);
    now.mockReturnValue(1_050);
    c.page.dispatch("pointercancel", {});
    now.mockReturnValue(1_100);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
  });

  it("the window losing focus ends a scrollbar press's ownership at once (no glide)", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.press(1_008);
    now.mockReturnValue(1_050);
    c.page.defaultView.dispatch("blur");
    now.mockReturnValue(1_100);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
  });

  it("the scroller replaced mid-drag: the new one is not the user's; its document's listeners move with it", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.press(1_008);
    const next = c.replaceScroller();
    expect(c.page.heard("keydown"), "one set, on the new scroller").toBe(1);
    now.mockReturnValue(10_000);
    c.movedTo(next.scrollTop - 600);
    expect(told()).toEqual([]);
    expect(next.gap()).toBe(0);
    // The user's gestures on the new one still let go.
    c.wheelTo(next.scrollTop - 600);
    expect(told()).toEqual([false]);
  });

  it("a scrollbar drag still held through our own re-pin still lets go (the navigation still going on); back at the end and released there, it owns nothing after", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.press(1_008);
    // A reply lands and pins while the thumb is held.
    deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(messageLines(41)).timeline });
    now.mockReturnValue(3_000);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([false]);
    // Back to the end by the same drag, released there: no glide (the return to the end revoked it; the
    // block below checks inside the first 400 ms), and nothing after.
    c.movedTo(c.scroll.scrollHeight);
    expect(told()).toEqual([false, true]);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(3_000 + gestureGlideMs + 1);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([false, true]);
    expect(c.scroll.gap()).toBe(0);
  });

  it("a track click (press and up at once): its scroll animation within the glide lets go", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.press(1_008);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1_150);
    c.movedTo(c.scroll.scrollTop - 754);
    expect(told()).toEqual([false]);
  });

  it("smooth scrolling: one wheel notch from the end, its first frame inside the band and the next ones out of it, lets go", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.wheel(-100);
    const top = c.scroll.scrollTop;
    for (const [at, moved] of [[1_016, 12], [1_033, 40], [1_050, 75], [1_066, 100]] as const) {
      now.mockReturnValue(at);
      c.scroll.scrollTop = top - moved;
      c.handler("onScroll")({});
    }
    expect(told()).toEqual([false]);
    expect(c.scroll.scrollTop).toBe(top - 100);
  });

  it("trackpad momentum: wheel events keep coming (each renews the window), so the glide 900 ms after the first tick still lets go", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    const top = c.scroll.scrollTop;
    for (let tick = 0; tick <= 9; tick += 1) {
      now.mockReturnValue(1_000 + tick * 100);
      c.wheel(-4);
    }
    now.mockReturnValue(1_900);
    c.scroll.scrollTop = top - 60;
    c.handler("onScroll")({});
    expect(told()).toEqual([false]);
  });
});

describe("a key on the page is the focused tile's", () => {
  const clock = (now: number) => vi.spyOn(performance, "now").mockReturnValue(now);
  const fixed = () => timelineOf(messageLines(40)).timeline;

  it("PageUp on the page arms only the focused tile; when the focus moves, only the newly focused one; a key inside a tile's own scroller arms that tile", () => {
    const now = clock(1_000);
    const page = new Page();
    const panes = ["w1:p1", "w1:p2"];
    const left = chat({ page, panes, paneId: "w1:p1", tile: true, keysActive: true, timeline: fixed() });
    const right = chat({ page, panes, paneId: "w1:p2", tile: true, keysActive: false, timeline: fixed() });
    left.key("PageUp", page.body);
    // (The focused tile first: a frame here runs every tile's resize observer, so the right one's would pin the left.)
    left.movedTo(left.scroll.scrollTop - 600);
    expect(told("mac/w1:p1"), "the focused tile").toEqual([false]);
    right.movedTo(right.scroll.scrollTop - 600);
    expect(told("mac/w1:p2"), "the unfocused tile").toEqual([]);

    // The focus moves to the right tile (SplitView's keysActive).
    left.keysActive(false);
    right.keysActive(true);
    now.mockReturnValue(5_000);
    right.key("PageUp", page.body);
    right.movedTo(right.scroll.scrollTop - 600);
    expect(told("mac/w1:p2")).toEqual([false]);

    // The left tile, unfocused, back at the end: a key with the focus in its own scroller still arms it.
    left.wheelTo(left.scroll.scrollHeight);
    expect(told("mac/w1:p1")).toEqual([false, true]);
    now.mockReturnValue(9_000);
    left.key("ArrowUp", left.scroll.row);
    left.movedTo(left.scroll.scrollTop - 600);
    expect(told("mac/w1:p1")).toEqual([false, true, false]);
  });
});

describe("a press in the blank gutter is not a scrollbar press", () => {
  const clock = (now: number) => vi.spyOn(performance, "now").mockReturnValue(now);
  const fixed = () => timelineOf(messageLines(40)).timeline;

  it("scrollbarHit: a classic bar's own area (either side), an overlay bar's strip; never the gutter, never with nothing to scroll", () => {
    const classic = { left: 100, width: 1_015, clientLeft: 0, clientWidth: 1_000, overflows: true };
    expect(scrollbarHit(100 + 1_000, classic)).toBe(true);
    expect(scrollbarHit(100 + 1_014, classic)).toBe(true);
    expect(scrollbarHit(100 + 999, classic), "the right gutter's last pixel").toBe(false);
    expect(scrollbarHit(100 + 10, classic), "the left gutter").toBe(false);
    expect(scrollbarHit(100 + 1_000, { ...classic, overflows: false }), "nothing to scroll: no bar").toBe(false);
    // Right to left: the bar on the left, inside clientLeft.
    const rtl = { left: 0, width: 1_015, clientLeft: 15, clientWidth: 1_000, overflows: true };
    expect(scrollbarHit(5, rtl)).toBe(true);
    expect(scrollbarHit(20, rtl)).toBe(false);
    expect(scrollbarHit(1_010, rtl)).toBe(false);
    // Overlay (macOS): no room taken; its strip at the right edge.
    const overlay = { left: 0, width: 1_015, clientLeft: 0, clientWidth: 1_015, overflows: true };
    expect(scrollbarHit(1_015 - overlayScrollbarPx, overlay)).toBe(true);
    expect(scrollbarHit(1_014, overlay)).toBe(true);
    expect(scrollbarHit(1_015 - overlayScrollbarPx - 1, overlay)).toBe(false);
    expect(scrollbarHit(10, overlay)).toBe(false);
  });

  for (const [name, x, bar] of [
    ["the left gutter", 10, 15],
    ["the right gutter, beside the bar", 990, 15],
    ["the left gutter, overlay scrollbars", 10, 0],
  ] as const) {
    it(`a click in ${name}: a later anchoring move stays following`, () => {
      const now = clock(1_000);
      const c = chat({ timeline: fixed(), bar });
      c.press(x);
      c.page.dispatch("pointerup", {});
      now.mockReturnValue(1_100);
      c.movedTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([]);
      expect(c.scroll.gap()).toBe(0);
    });
  }

  for (const [name, x, bar] of [
    ["the classic scrollbar", 1_008, 15],
    ["the overlay scrollbar's strip", 1_010, 0],
  ] as const) {
    it(`a drag on ${name} lets go on the scroll that follows`, () => {
      clock(1_000);
      const c = chat({ timeline: fixed(), bar });
      c.press(x);
      c.movedTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([false]);
    });
  }
});

// A press gives the glide after its release only when the press itself is known to navigate: a hit on a
// classic scrollbar, or a held press that moved the Chat up (since it began, our own last pin, or its
// return to the end). More held-press cases are in chat-gesture-held-drag.test.ts. Every check here lands
// inside the first 400 ms after the release (the held-drag test above waits 401 ms and misses that window).
describe("a press gives the glide after its release only when it is known to navigate", () => {
  const clock = (now: number) => vi.spyOn(performance, "now").mockReturnValue(now);
  const fixed = () => timelineOf(messageLines(40)).timeline;
  /** A scroll event at `top` with no frame's resize observers (nothing changed size: a real one stays quiet). */
  const scrolledTo = (c: ReturnType<typeof chat>, top: number): void => {
    c.scroll.scrollTop = top;
    c.scroll.moved = false;
    c.handler("onScroll")({});
  };
  /** A reply lands while following: a row more, our own pin to the new end, its scroll event. */
  const replyLands = (c: ReturnType<typeof chat>, count: number): void => {
    c.scroll.rows = count * itemHeight;
    deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(messageLines(count)).timeline });
    c.frame();
  };

  it("the gate: a press's release gives the glide only if it is known to navigate: a sure hit, or it moved the Chat up since it began or since the last revoke", () => {
    const gate = new ChatFollowGate();
    // A sure hit (a classic bar), let go at once: the glide (a track click's animation).
    gate.heard({ source: "pointerDown", onScrollbar: true }, 1_000);
    gate.heard({ source: "pointerUp" }, 1_010);
    expect(gate.ownScroll(1_010 + gestureGlideMs)).toBe(true);
    // The same press, our own pin while held: still the user's while held; its release gives nothing.
    gate.heard({ source: "pointerDown", onScrollbar: true }, 2_000);
    gate.revoke({ keepsHeldDrag: true });
    expect(gate.ownScroll(2_500), "held").toBe(true);
    gate.heard({ source: "pointerUp" }, 3_000);
    expect(gate.ownScroll(3_000), "released after a revoke, not moved since").toBe(false);
    // ... unless it moved the Chat up again after the revoke.
    gate.heard({ source: "pointerDown", onScrollbar: true }, 4_000);
    gate.revoke({ keepsHeldDrag: true });
    gate.movedUp();
    gate.heard({ source: "pointerUp" }, 4_100);
    expect(gate.ownScroll(4_100 + gestureGlideMs)).toBe(true);
    // A strip candidate (an overlay bar): the user's while held; released without moving the Chat up, nothing.
    gate.heard({ source: "pointerDown", onScrollbar: true, candidate: true }, 5_000);
    expect(gate.ownScroll(5_050), "held").toBe(true);
    gate.heard({ source: "pointerUp" }, 5_100);
    expect(gate.ownScroll(5_100)).toBe(false);
    // ... moved up while held, then released: the glide.
    gate.heard({ source: "pointerDown", onScrollbar: true, candidate: true }, 6_000);
    gate.movedUp();
    gate.heard({ source: "pointerUp" }, 6_100);
    expect(gate.ownScroll(6_100 + gestureGlideMs)).toBe(true);
    expect(gate.ownScroll(6_101 + gestureGlideMs)).toBe(false);
    // A move up with no press held proves nothing about the next press.
    gate.movedUp();
    gate.heard({ source: "pointerDown", onScrollbar: true, candidate: true }, 7_000);
    gate.heard({ source: "pointerUp" }, 7_100);
    expect(gate.ownScroll(7_100)).toBe(false);
  });

  it("a thumb held still through our own re-pin (a reply landing), then let go: an anchoring move 100 ms later stays following", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.press(1_008);
    now.mockReturnValue(2_000);
    replyLands(c, 41);
    expect(c.scroll.gap()).toBe(0);
    now.mockReturnValue(3_000);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(3_100);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told(), "on 9d6b4416 the pointer-up gave the held press a fresh glide").toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });

  it("a drag away from the end and back to it, let go there: an anchoring move 100 ms later stays following", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    const end = c.scroll.scrollTop;
    c.press(1_008);
    now.mockReturnValue(1_100);
    c.movedTo(end - 600);
    expect(told()).toEqual([false]);
    now.mockReturnValue(1_200);
    c.movedTo(end);
    expect(told()).toEqual([false, true]);
    now.mockReturnValue(1_300);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1_400);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told(), "on 9d6b4416 the pointer-up gave the finished drag a fresh glide").toEqual([false, true]);
    expect(c.scroll.gap()).toBe(0);
  });

  it("a held press that moves the Chat up again after our re-pin (a track click's animation) keeps its glide: the frame after the release lets go", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    c.press(1_008);
    replyLands(c, 41);
    const end = c.scroll.scrollTop;
    now.mockReturnValue(1_050);
    scrolledTo(c, end - 20);
    expect(told(), "its first frame, inside the band").toEqual([]);
    now.mockReturnValue(1_080);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1_150);
    scrolledTo(c, end - 754);
    expect(told()).toEqual([false]);
    expect(c.scroll.scrollTop, "the place kept").toBe(end - 754);
  });

  // The overlay scrollbar (macOS) takes no room: the guessed strip at the right edge (x 999 to 1,014 here) is
  // the bar or the content under it. A press there owns scrolls while it is held; its release gives nothing
  // unless it moved the Chat up.
  for (const x of [999, 1_005, 1_008, 1_014]) {
    it(`a plain click at x=${x} in the overlay strip, nothing scrolled while held: an anchoring move 100 ms later stays following`, () => {
      const now = clock(1_000);
      const c = chat({ timeline: fixed(), bar: 0 });
      c.press(x);
      now.mockReturnValue(1_060);
      c.page.dispatch("pointerup", {});
      now.mockReturnValue(1_160);
      c.movedTo(c.scroll.scrollTop - 600);
      expect(told(), "on 9d6b4416 the strip counted as the bar: its release gave a glide").toEqual([]);
      expect(c.scroll.gap()).toBe(0);
    });
  }

  it("a plain click at x=998, just left of the strip, is no press on the bar at all: still following", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed(), bar: 0 });
    c.press(998);
    now.mockReturnValue(1_060);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1_160);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });

  it("a drag on the overlay bar moves the Chat while held: it lets go, the place kept", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed(), bar: 0 });
    const end = c.scroll.scrollTop;
    c.press(1_008);
    now.mockReturnValue(1_200);
    c.movedTo(end - 600);
    expect(told()).toEqual([false]);
    now.mockReturnValue(1_300);
    c.page.dispatch("pointerup", {});
    expect(c.scroll.scrollTop, "the place kept").toBe(end - 600);
    expect(told()).toEqual([false]);
  });

  it("an overlay track click whose animation's first frame lands while held (inside the band): its frames after a quick release let go", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed(), bar: 0 });
    const end = c.scroll.scrollTop;
    c.press(1_008);
    now.mockReturnValue(1_016);
    scrolledTo(c, end - 12);
    expect(told(), "the first frame, inside the band").toEqual([]);
    now.mockReturnValue(1_040);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1_060);
    scrolledTo(c, end - 300);
    expect(told()).toEqual([false]);
  });

  it("the classic scrollbar is a confirmed hit: a track click let go at once, its page animation after the release lets go", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed() });
    const end = c.scroll.scrollTop;
    c.press(1_008);
    now.mockReturnValue(1_010);
    c.page.dispatch("pointerup", {});
    for (const [at, moved] of [
      [1_026, 12],
      [1_043, 90],
      [1_060, 300],
      [1_100, 754],
    ] as const) {
      now.mockReturnValue(at);
      scrolledTo(c, end - moved);
    }
    expect(told()).toEqual([false]);
    expect(c.scroll.scrollTop, "the place kept").toBe(end - 754);
  });

  // The release also counts a move up the browser has made but not yet told (its scroll event comes in a
  // later frame; more release-order cases are in chat-gesture-release-order.test.ts).
  // These two keep what must stay revoked on that path.
  /** The scroll event the browser still owes for the move it already made. */
  const owedScroll = (c: ReturnType<typeof chat>): void => {
    c.scroll.moved = false;
    c.handler("onScroll")({});
  };

  it("rows above shrink while an overlay press is held and the Chat is clamped up, its event still owed at the release: a clamp, no glide; a layout move later stays following", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed(), bar: 0 });
    c.press(1_008);
    now.mockReturnValue(1_100);
    c.scroll.rows -= 300;
    c.scroll.layout();
    expect(c.scroll.moved, "clamped up 300 px, its event owed").toBe(true);
    now.mockReturnValue(1_110);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1_116);
    owedScroll(c);
    now.mockReturnValue(1_200);
    scrolledTo(c, c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });

  it("a drag away from the end and back to it, released before the return's event: that event follows again, and a layout move 100 ms later stays following", () => {
    const now = clock(1_000);
    const c = chat({ timeline: fixed(), bar: 0 });
    const end = c.scroll.scrollTop;
    c.press(1_008);
    now.mockReturnValue(1_100);
    scrolledTo(c, end - 600);
    expect(told()).toEqual([false]);
    now.mockReturnValue(1_200);
    c.scroll.scrollTop = end;
    now.mockReturnValue(1_210);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1_216);
    owedScroll(c);
    expect(told()).toEqual([false, true]);
    now.mockReturnValue(1_300);
    scrolledTo(c, end - 600);
    expect(told()).toEqual([false, true]);
    expect(c.scroll.gap()).toBe(0);
  });
});
