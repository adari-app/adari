// Boundaries of Chat's scroll gestures:
// 1. a gesture's ownership ends with the navigation: after following again (the
//    end, New, a send), after a wheel inside the end band and a pin, after a
//    cancelled or blurred scrollbar press, and across the scroller's removal,
//    an anchoring move nobody made does not let go again;
// 2. a key on the page arms only the focused split tile, never every tile;
// 3. a click in the blank gutter beside the column is not a scrollbar press.
// The others guard fields, IME, the keys, momentum, a long
// drag, the 48 px band, the listeners' life, the windows' isolation, and the
// limit's reset keeping item identity and order.
//
// The harness is chat-gesture.test.ts's (the real ChatView on the hooks host,
// the browser's scroller modelled) with a shared document, blur listeners, the
// scroller ref cleared when it leaves, focus values and a controlled clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { ChatFeed, ChatFeedUpdate } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import { timelineItemCount, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import type { ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { claudePath, eventually, FakeTranscriptReader, liveFeed, text, timelineOf, user } from "./support/chat-lines";
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
class WindowEvents {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, f: () => void): void { const set = this.listeners.get(type) ?? new Set(); set.add(f); this.listeners.set(type,set); }
  removeEventListener(type: string, f: () => void): void { this.listeners.get(type)?.delete(f); }
  dispatch(type: string): void { for (const f of this.listeners.get(type) ?? []) f(); }
  heard(type: string): number { return this.listeners.get(type)?.size ?? 0; }
}
class Page {
  readonly body = { tagName: "BODY" };
  readonly documentElement = { tagName: "HTML" };
  readonly defaultView = new WindowEvents();
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
  constructor(public ownerDocument: Page) {}
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
function chat(options: { page?: Page; keysActive?: boolean; paneId?: string; panes?: readonly string[]; tile?: boolean; feed?: ChatFeed<TranscriptSessionRef>; timeline?: ChatTimeline } = {}) {
  const paneId = options.paneId ?? "w1:p1";
  const page = options.page ?? new Page();
  const scroll = new Scroller(page);
  const props = { host: hostOf(options.panes ?? [paneId]), row: rowOf(paneId), onShowTerminal: () => undefined, bottomInset: 0, tile: options.tile === true, keysActive: options.keysActive ?? true };
  const column = {};
  let previousScrollerRef: { current: unknown } | undefined;
  const withRefs = (p: object): unknown => {
    let hasScroller = false;
    const tree = (ChatView as (p: object) => unknown)(p);
    for (const element of elements(tree)) {
      const ref = element.props["ref"] as { current: unknown } | undefined;
      if (ref === undefined || ref === null) continue;
      if (element.props["className"] === "chat-scroll") { ref.current = scroll; previousScrollerRef = ref; hasScroller = true; }
      if (element.props["className"] === "chat-col") ref.current = column;
    }
    if (!hasScroller && previousScrollerRef) previousScrollerRef.current = null;
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
    scroll,
    page,
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


const fixed = () => timelineOf(messageLines(40)).timeline;
const clockAt = (now: number) => vi.spyOn(performance, "now").mockReturnValue(now);
const pageMove = (c: ReturnType<typeof chat>, key: string, extra: object = {}) => c.page.dispatch("keydown", { key, shiftKey: false, isComposing: false, target: c.page.body, ...extra });

describe("ownership after the user's gesture has ended", () => {
  for (const resume of ["end", "pill", "send"] as const) {
    it(`resuming on ${resume} clears an earlier wheel's ownership before a layout move`, async () => {
      const now = clockAt(1000);
      const c = chat({ timeline: fixed() });
      c.wheelTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([false]);
      now.mockReturnValue(1100);
      if (resume === "end") c.wheelTo(c.scroll.scrollHeight);
      else if (resume === "pill") {
        deliver!({ hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: { ...fixed(), newerWaiting: true } });
        (elements(c.view.tree).find(e => e.props["className"] === "chat-new")!.props["onClick"] as () => void)();
      } else {
        const { chatSends } = await import("../src/renderer/chat/chat-state");
        chatSends.sent("mac/w1:p1");
      }
      expect(told()).toEqual([false, true]);
      now.mockReturnValue(1200);
      c.movedTo(c.scroll.scrollTop - 600); // scroll anchoring, no new input and unchanged height
      expect(told()).toEqual([false, true]);
      expect(c.scroll.gap()).toBe(0);
    });
  }
  it("a wheel that stayed inside the band cannot own a later layout move", () => {
    const now = clockAt(1000);
    const c = chat({ timeline: fixed() });
    c.wheelTo(c.scroll.scrollTop - 20);
    expect(told()).toEqual([]);
    now.mockReturnValue(1100);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });
  it("after 401 ms the same anchoring move remains following", () => {
    const now = clockAt(1000);
    const c = chat({ timeline: fixed() });
    c.wheel(-1);
    now.mockReturnValue(1401);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
    expect(c.scroll.gap()).toBe(0);
  });
  it("cancelling a scrollbar drag clears its ownership immediately", () => {
    const now = clockAt(1000);
    const c = chat({ timeline: fixed() });
    c.handler("onPointerDown")({ target: c.scroll, currentTarget: c.scroll });
    now.mockReturnValue(1100);
    c.page.dispatch("pointercancel", {});
    now.mockReturnValue(1200);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
  });
  it("window blur clears rather than extends a scrollbar drag's ownership", () => {
    const now = clockAt(1000);
    const c = chat({ timeline: fixed() });
    c.handler("onPointerDown")({ target: c.scroll, currentTarget: c.scroll });
    now.mockReturnValue(1100);
    c.page.defaultView.dispatch("blur");
    now.mockReturnValue(1200);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
  });
});

describe("fields, IME, keys and genuine navigation", () => {
  for (const key of ["PageUp", "Home", "ArrowUp", " "]) {
    it(`${key} scroll outside a field releases only after the scroll`, () => {
      clockAt(1000);
      const c = chat({ timeline: fixed() });
      pageMove(c,key,{ shiftKey: key === " " });
      expect(told()).toEqual([]);
      c.movedTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([false]);
    });
  }
  for (const target of [{tagName:"TEXTAREA"},{tagName:"INPUT"},{tagName:"SELECT"},{tagName:"DIV",isContentEditable:true}]) {
    it(`${target.tagName} field does not arm the chat`, () => {
      clockAt(1000);
      const c = chat({ timeline: fixed() });
      // Put the field inside the scroller, so rejection is the editable guard, not target containment.
      c.scroll.contains = (node: unknown) => node === target;
      c.key("Home",target);
      c.movedTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([]);
    });
  }
  it("an IME composition key in the Chat does not arm", () => {
    clockAt(1000);
    const c = chat({ timeline: fixed() });
    pageMove(c,"PageUp",{target:c.scroll.row,isComposing:true});
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
  });
  for (const target of ["row","link"]) {
    it(`a ${target} press does not arm`, () => {
      const c = chat({ timeline: fixed() });
      c.handler("onPointerDown")({target:target === "row" ? c.scroll.row : {tagName:"A"},currentTarget:c.scroll});
      c.movedTo(c.scroll.scrollTop - 600);
      expect(told()).toEqual([]);
    });
  }
  it("a wheel down and Ctrl-wheel do not arm", () => {
    const c = chat({ timeline: fixed() });
    c.wheel(200);
    c.wheel(-200,true);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
  });
  it("trackpad momentum continues owning scrolls while wheel events arrive", () => {
    const now = clockAt(1000);
    const c = chat({ timeline: fixed() });
    c.wheel(-10);
    now.mockReturnValue(1350);
    c.wheel(-10);
    now.mockReturnValue(1700);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([false]);
  });
  it("touch and a long scrollbar drag can release", () => {
    const now = clockAt(1000);
    const c = chat({ timeline: fixed() });
    c.handler("onPointerDown")({target:c.scroll,currentTarget:c.scroll});
    now.mockReturnValue(10000);
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([false]);
    c.wheelTo(c.scroll.scrollHeight);
    now.mockReturnValue(20000);
    c.handler("onTouchMove")({});
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([false,true,false]);
  });
  it("48 px is outside the band and 47 px resumes; subsequent idle events do not loop", () => {
    const c = chat({ timeline: fixed() });
    c.wheelTo(c.scroll.scrollTop - 48);
    expect(told()).toEqual([false]);
    c.wheelTo(c.scroll.scrollHeight - c.scroll.clientHeight - 47);
    expect(told()).toEqual([false,true]);
    for (let n=0;n<10;n++) c.handler("onScroll")({});
    expect(told()).toEqual([false,true]);
  });
});

describe("listener ownership and tile/window isolation", () => {
  it("ordinary rerenders keep one listener set; unmount removes keys, up, cancel and blur", () => {
    const c = chat({ timeline: fixed() });
    for (let n=0;n<5;n++) c.view.render();
    for (const type of ["keydown","pointerup","pointercancel"]) expect(c.page.heard(type)).toBe(1);
    expect(c.page.defaultView.heard("blur")).toBe(1);
    c.unmount();
    for (const type of ["keydown","pointerup","pointercancel"]) expect(c.page.heard(type)).toBe(0);
    expect(c.page.defaultView.heard("blur")).toBe(0);
  });
  it("unavailable detaches the old document, returning live attaches the new scroller's document", () => {
    const c = chat({ timeline: fixed() });
    const old=c.page;
    deliver!({hostId:"mac",paneId:"w1:p1",state:{status:"unavailable",reason:"notFound"},timeline:fixed()});
    expect(old.heard("keydown")).toBe(0);
    expect(old.defaultView.heard("blur")).toBe(0);
    const fresh=new Page();
    c.scroll.ownerDocument=fresh;
    deliver!({hostId:"mac",paneId:"w1:p1",state:{status:"live"},timeline:fixed()});
    expect(fresh.heard("keydown")).toBe(1);
    expect(fresh.defaultView.heard("blur")).toBe(1);
    c.unmount();
    expect(fresh.heard("keydown")).toBe(0);
    expect(fresh.defaultView.heard("blur")).toBe(0);
  });
  it("a drag cannot survive scroller removal and release its replacement seconds later", () => {
    const now = clockAt(1000);
    const c = chat({ timeline: fixed() });
    c.handler("onPointerDown")({target:c.scroll,currentTarget:c.scroll});
    deliver!({hostId:"mac",paneId:"w1:p1",state:{status:"unavailable",reason:"notFound"},timeline:fixed()});
    now.mockReturnValue(2000);
    c.page.dispatch("pointerup",{}); // old listeners correctly detached, so this is not heard
    now.mockReturnValue(10000);
    deliver!({hostId:"mac",paneId:"w1:p1",state:{status:"live"},timeline:fixed()});
    c.movedTo(c.scroll.scrollTop - 600);
    expect(told()).toEqual([]);
  });
  it("a body PageUp does not grant a sibling tile ownership of a later layout move", () => {
    const now=clockAt(1000);
    const page=new Page();
    const panes=["w1:p1","w1:p2"];
    const left=chat({page,panes,paneId:panes[0],tile:true,keysActive:true,timeline:fixed()});
    const right=chat({page,panes,paneId:panes[1],tile:true,keysActive:false,timeline:fixed()});
    left.key("PageUp",page.body);
    left.movedTo(left.scroll.scrollTop - 600);
    expect(told("mac/w1:p1")).toEqual([false]);
    now.mockReturnValue(1100);
    right.movedTo(right.scroll.scrollTop - 600);
    expect(told("mac/w1:p2")).toEqual([]);
  });
  it("a wheel and key in one tile cannot own another tile's move; documents isolate windows", () => {
    clockAt(1000);
    const panes=["w1:p1","w1:p2"];
    const page=new Page();
    const left=chat({page,panes,paneId:panes[0],tile:true,keysActive:true,timeline:fixed()});
    const right=chat({page,panes,paneId:panes[1],tile:true,keysActive:false,timeline:fixed()});
    left.wheel(-100);
    left.key("PageUp",left.scroll.row);
    right.movedTo(right.scroll.scrollTop-600);
    expect(told("mac/w1:p2")).toEqual([]);
    const separate=chat({paneId:"w1:p3",tile:true,timeline:fixed()});
    page.dispatch("keydown",{key:"Home",shiftKey:false,isComposing:false,target:page.body});
    separate.movedTo(separate.scroll.scrollTop-600);
    expect(told("mac/w1:p3")).toEqual([]);
  });
});

describe("limit reset preserves item identity, order and recoverability", () => {
  it("repeated read-up/resume windows have unique IDs and contiguous tails; Load earlier restores the held prefix", async () => {
    const reader=new FakeTranscriptReader();
    const feed=await liveFeed(messages(30),{maxItems:20,historyCap:50,reader});
    const ids=(t:ChatTimeline)=>t.turns.flatMap(turn=>turn.items.map(item=>item.value.id));
    for (let cycle=0;cycle<3;cycle++) {
      const start=30+cycle*7;
      const before=texts(feed.timeline);
      const beforeIDs=ids(feed.timeline);
      feed.setFollowingNewest(false);
      reader.append(claudePath,messages(7,start));
      expect(await eventually(()=>texts(feed.timeline).at(-1)===`message-${start+6}`)).toBe(true);
      expect(texts(feed.timeline)).toEqual([...before,...range(start,start+6)]);
      const heldIDs=ids(feed.timeline);
      expect(heldIDs.slice(0,beforeIDs.length)).toEqual(beforeIDs);
      expect(new Set(heldIDs).size).toBe(heldIDs.length);
      feed.setFollowingNewest(true);
      expect(texts(feed.timeline)).toEqual(range(start-13,start+6));
      expect(ids(feed.timeline)).toEqual(heldIDs.slice(-20));
    }
    await feed.loadEarlier();
    const all=texts(feed.timeline);
    expect(all).toEqual(range(1,50));
    expect(new Set(ids(feed.timeline)).size).toBe(all.length);
    feed.stop();
  });
});

describe("a content gutter is not a scrollbar", () => {
  it("clicking the empty left gutter cannot own a later anchoring move", () => {
    const now=clockAt(1000);
    const c=chat({timeline:fixed()});
    // chat.css:8-9: a full-width scroller surrounds a narrower centered chat-col.
    // A hit at x=10 is on the scroller's empty left content gutter, not its right scrollbar.
    Object.assign(c.scroll,{clientWidth:1000,offsetWidth:1015,getBoundingClientRect:()=>({left:0,right:1015,top:0,bottom:754})});
    c.handler("onPointerDown")({target:c.scroll,currentTarget:c.scroll,clientX:10,clientY:200,button:0,pointerType:"mouse"});
    c.page.dispatch("pointerup",{});
    now.mockReturnValue(1100);
    c.movedTo(c.scroll.scrollTop-600);
    expect(told()).toEqual([]);
  });
});
