// Boundaries of Chat's scroll gestures: a held press's pointer-up never recreates ownership after our
// own re-pin or after the drag got back to the end, and a plain click at x=999 / x=1005 in the guessed
// overlay strip grants nothing.
//
// One case is marked below: the reserved-width-0 track case. Without its extra frame it is a plain press
// and release in the overlay strip with nothing scrolled while held, which grants nothing (the same as
// x=999 and x=1005).
//
// The real ChatView runs on the small hooks host with the browser's scroller modelled as
// chat-gesture.test.ts has it; the cases deliver scroll events directly (moveOnly), without the
// harness's all-tile resize callbacks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { ChatFeed, ChatFeedUpdate } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import { timelineItemCount, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import type { ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { timelineOf, user } from "./support/chat-lines";
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
    /** The scroller's handler (none set: nothing to call). */
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

// Boundary checks with scroll events delivered directly.
// Direct scroll delivery deliberately omits the harness's unconditional all-tile resize callbacks.
const fixed = () => timelineOf(messageLines(40)).timeline;
const clock = (now: number) => vi.spyOn(performance, "now").mockReturnValue(now);
const moveOnly = (c: ReturnType<typeof chat>, top: number) => {
  c.scroll.scrollTop = top;
  c.handler("onScroll")({});
  c.scroll.moved = false;
};
const layoutUp = (c: ReturnType<typeof chat>) => moveOnly(c, c.scroll.scrollTop - 600);

describe("held-drag revocation boundaries", () => {
  it("a held stationary scrollbar press across a re-pin must not own layout after release", () => {
    const now = clock(1000);
    const c = chat({ timeline: fixed() });
    c.handler("onPointerDown")({ target: c.scroll, currentTarget: c.scroll, clientX: 1008, clientY: 700, button: 0 });
    // No pointer move or scrollbar scroll. A reply lands while the thumb is held.
    now.mockReturnValue(2000);
    deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(messageLines(41)).timeline });
    now.mockReturnValue(3000);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(3100);
    layoutUp(c);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });
  it("a thumb returned to the end must not regain the old drag's window on pointer-up", () => {
    const now = clock(1000);
    const c = chat({ timeline: fixed() });
    c.press(1008);
    layoutUp(c);
    expect(told()).toEqual([false]);
    now.mockReturnValue(1100);
    moveOnly(c, c.scroll.scrollHeight);
    expect(told()).toEqual([false, true]);
    now.mockReturnValue(1200);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1300);
    layoutUp(c);
    expect(told()).toEqual([false, true]);
    expect(c.scroll.gap()).toBe(0);
  });
  it("a stationary press across a re-pin owns nothing after 401ms from pointer-up", () => {
    const now = clock(1000);
    const c = chat({ timeline: fixed() });
    c.press(1008);
    deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(messageLines(41)).timeline });
    now.mockReturnValue(3000);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(3401);
    layoutUp(c);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });
  for (const resume of ["New", "send"] as const) {
    it(`${resume} clears a held drag and its eventual up grants nothing`, async () => {
      const now = clock(1000);
      const c = chat({ timeline: { ...fixed(), newerWaiting: true } });
      c.press(1008);
      layoutUp(c);
      now.mockReturnValue(1100);
      if (resume === "New") (elements(c.view.tree).find(e => e.props["className"] === "chat-new")!.props["onClick"] as () => void)();
      else (await import("../src/renderer/chat/chat-state")).chatSends.sent("mac/w1:p1");
      expect(told()).toEqual([false, true]);
      c.page.dispatch("pointerup", {});
      now.mockReturnValue(1200);
      layoutUp(c);
      expect(told()).toEqual([false, true]);
    });
  }
  it("a still-held real drag can move away after a re-pin", () => {
    const now = clock(1000);
    const c = chat({ timeline: fixed() });
    c.press(1008);
    deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(messageLines(41)).timeline });
    now.mockReturnValue(3000);
    layoutUp(c);
    expect(told()).toEqual([false]);
  });
});

describe("overlay content clicks", () => {
  for (const x of [999, 1005]) {
    it(`a plain content click at overlay x=${x} must not own a later layout move`, () => {
      const now = clock(1000);
      const c = chat({ timeline: fixed(), bar: 0 });
      // 1015px content width, no reserved scrollbar space. No actual scroll/drag occurs.
      c.press(x);
      c.page.dispatch("pointerup", {});
      now.mockReturnValue(1100);
      layoutUp(c);
      expect(told()).toEqual([]);
      expect(c.scroll.gap()).toBe(0);
    });
  }
  it("a plain overlay content click just outside the strip stays following", () => {
    const now = clock(1000);
    const c = chat({ timeline: fixed(), bar: 0 });
    c.press(998);
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1100);
    layoutUp(c);
    expect(told()).toEqual([]);
  });
  it("no overflow means an edge click grants nothing", () => {
    const now = clock(1000);
    const c = chat({ timeline: timelineOf(messageLines(1)).timeline, bar: 0 });
    c.press(1005);
    c.page.dispatch("pointerup", {});
    c.scroll.rows = 2400;
    moveOnly(c, c.scroll.scrollHeight);
    now.mockReturnValue(1100);
    layoutUp(c);
    expect(told()).toEqual([]);
  });
  it("a no-clientX synthetic gutter press retains the documented target-only fallback", () => {
    const now = clock(1000);
    const c = chat({ timeline: fixed() });
    c.handler("onPointerDown")({ target: c.scroll, currentTarget: c.scroll });
    c.page.dispatch("pointerup", {});
    now.mockReturnValue(1100);
    layoutUp(c);
    expect(told()).toEqual([false]);
  });
  for (const bar of [15, 0]) {
    it(`a real bar drag and track animation with reserved width ${bar} still release`, () => {
      const now = clock(1000);
      const c = chat({ timeline: fixed(), bar });
      c.press(1008);
      // On the overlay bar (width 0) a press in the strip is only a candidate,
      // so here its track animation's first frame lands while the button is held (12 px, inside the band).
      // Without that frame this press is the x=999/x=1005 plain click above, and it grants nothing.
      if (bar === 0) moveOnly(c, c.scroll.scrollTop - 12);
      c.page.dispatch("pointerup", {});
      now.mockReturnValue(1100);
      layoutUp(c);
      expect(told()).toEqual([false]);
    });
  }
});

describe("split focus with independent scroll callbacks", () => {
  for (const keyTarget of ["body", "documentElement"] as const) {
    for (const first of ["active", "inactive"] as const) {
      it(`${keyTarget} arms only the focused tile, before/after focus moves, ${first} scroll first`, () => {
        const now = clock(1000);
        const page = new Page();
        const panes = ["w1:p1", "w1:p2"];
        const left = chat({ page, panes, paneId: panes[0], tile: true, keysActive: true, timeline: fixed() });
        const right = chat({ page, panes, paneId: panes[1], tile: true, keysActive: false, timeline: fixed() });
        for (let phase = 0; phase < 2; phase++) {
          const active = phase === 0 ? left : right;
          const inactive = phase === 0 ? right : left;
          active.keysActive(true);
          inactive.keysActive(false);
          now.mockReturnValue(1000 + phase * 1000);
          active.key("PageUp", page[keyTarget]);
          for (const c of first === "active" ? [active, inactive] : [inactive, active]) layoutUp(c);
          expect(told(phase === 0 ? "mac/w1:p1" : "mac/w1:p2")).toEqual([false]);
          expect(told(phase === 0 ? "mac/w1:p2" : "mac/w1:p1")).toEqual(phase === 0 ? [] : [false, true]);
          moveOnly(active, active.scroll.scrollHeight);
        }
      });
    }
  }
  it("an own-scroller key arms that tile even when keysActive is false", () => {
    clock(1000);
    const c = chat({ timeline: fixed(), tile: true, keysActive: false });
    c.key("Home", c.scroll.row);
    layoutUp(c);
    expect(told("mac/w1:p1")).toEqual([false]);
  });
});
