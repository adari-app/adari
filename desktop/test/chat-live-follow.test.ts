// The live row in the real ChatView, on the small hooks
// host, with the browser's scroller modelled as chat-send-follow.test.ts has
// it. The row the main process reads off the pane's screen shows as the last
// turn's last row (before the Working line and the needs-you card, which keep
// their places); it grows with each read; the transcript's own text landing
// ends it (one row, never both). It follows the bottom as a landed reply
// does: at the end, each read keeps the end in sight; scrolled up, the user's
// place is kept and the New pill lights; at the end again, it follows again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { liveBlock } from "../src/shared/chat/live-screen";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { ChatLiveEvent, ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { at, reply, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { liveRows } = await import("../src/renderer/chat/live-rows");

/** The browser's scroller, as far as following reads it. */
class Scroller {
  rows = 0;
  readonly inset = 105;
  readonly clientHeight = 754;
  private top = 0;
  moved = false;
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
  layout(): void {
    this.scrollTop = this.top;
  }
  gap(): number {
    return this.scrollHeight - this.top - this.clientHeight;
  }
  querySelector(): unknown {
    return null;
  }
}

let following: boolean[] = [];
let observers: (() => void)[] = [];
let deliver: ((event: ChatUpdateEvent) => void) | null = null;
let live: ((event: ChatLiveEvent) => void) | null = null;
const mounted: (() => void)[] = [];

beforeEach(() => {
  following = [];
  observers = [];
  vi.spyOn(Date, "now").mockImplementation(() => at(1_000) * 1_000);
  vi.stubGlobal("window", {
    herdrDesktop: {
      openChat: () => undefined,
      closeChat: () => undefined,
      loadEarlierChat: () => Promise.resolve(),
      setChatFollowing: (value: boolean) => following.push(value),
      copyText: () => undefined,
      onChatUpdate: (listener: (event: ChatUpdateEvent) => void) => {
        deliver = listener;
        return () => undefined;
      },
      onChatLive: (listener: (event: ChatLiveEvent) => void) => {
        live = listener;
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
  pendingMessages.clear();
  liveRows.clear();
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function topologyOf(status: string) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: status, terminal_id: "t-0", state_change_seq: 3, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-0" } },
    ],
  });
}

const hostOf = (status: string): HostView =>
  ({ id: "mac", name: "Mac mini", state: "connected", topology: topologyOf(status), connection: 1, incarnation: 1, epoch: 1 }) as unknown as HostView;
const rowOf = (status: string) =>
  ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle" }) as unknown as SidebarRow;

/** 30 finished exchanges, then the user's question the agent works on. */
const history = [
  ...Array.from({ length: 30 }, (_, i) => [user(`question ${i}`, `u${i}`, 300 + i * 20), reply(`answer ${i}`, `a${i}`, 300 + i * 20 + 5, true)]).flat(),
  user("Port the live row, please.", "u-now", 990),
];

/** The pane's Chat, working, its transcript `history` and its rows' height laid out. */
function pane() {
  const status = "working";
  const props = () => ({ host: hostOf(status), row: rowOf(status), onShowTerminal: () => undefined, bottomInset: 105, tile: false });
  const scroll = new Scroller();
  const withRefs = (p: object): unknown => {
    const tree = (ChatView as (q: object) => unknown)(p);
    for (const element of elements(tree)) {
      const ref = element.props["ref"] as { current: unknown } | undefined;
      if (ref === undefined || ref === null) continue;
      if (element.props["className"] === "chat-scroll") ref.current = scroll;
      if (element.props["className"] === "chat-col") ref.current = {};
    }
    return tree;
  };
  const view = new HookHost<Record<string, unknown>>(withRefs, props());
  view.render();
  const scroller = () => elements(view.tree).find((e) => e.props["className"] === "chat-scroll")!;
  let lines = [...history];
  const p = {
    view,
    scroll,
    /** The transcript as the feed reads it (read to its end), the rows' height laid out with it. */
    transcript(next: readonly string[], rows: number): void {
      lines = [...next];
      scroll.rows = rows;
      const read: ChatTimeline = timelineOf(lines).timeline;
      deliver!({
        hostId: "mac",
        paneId: "w1:p1",
        state: { status: "live" },
        timeline: { ...read, turns: read.turns.map((turn) => ({ ...turn, id: `turn-${turn.items[0]?.value.id ?? turn.id}` })) },
        caughtUp: true,
      });
      scroll.layout();
    },
    lines: () => lines,
    /** A read of the pane's screen: its block, the live row's height laid out with it. */
    read(text: string | null, rows: number): void {
      // Laid out before the layout effects run, as the browser does.
      scroll.rows = rows;
      live!({ type: "block", hostId: "mac", paneId: "w1:p1", block: text === null ? null : liveBlock(text) });
      scroll.layout();
    },
    frame(): void {
      if (scroll.moved) {
        scroll.moved = false;
        (scroller().props["onScroll"] as () => void)();
      }
      for (const callback of observers.slice()) callback();
      scroll.moved = false;
    },
    scrollTo(top: number): void {
      // The user's wheel event comes first (only the user's gesture lets go of the end).
      (scroller().props["onWheel"] as (e: unknown) => void)({ deltaY: top - scroll.scrollTop, ctrlKey: false });
      scroll.scrollTop = top;
      p.frame();
    },
    newPill: () => elements(view.tree).some((e) => e.props["className"] === "chat-new"),
    /** The live row's text as the last turn has it (null: none). */
    liveRow(): string | null {
      const turns = elements(view.tree).filter((e) => typeof e.type === "function" && (e.type as { name: string }).name === "Turn");
      for (const turn of turns.slice(0, -1)) expect(turn.props["live"] ?? null, "only the last turn has the live row").toBeNull();
      return (turns.at(-1)?.props["live"] as string | null | undefined) ?? null;
    },
    /** The reply rows the transcript shows of the turn the user asked in. */
    replies(): string[] {
      const turn = elements(view.tree)
        .filter((e) => typeof e.type === "function" && (e.type as { name: string }).name === "Turn")
        .at(-1)!.props["turn"] as ChatTimeline["turns"][number];
      return turn.items.flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));
    },
    unmount(): void {
      const at = mounted.indexOf(p.unmount);
      if (at >= 0) mounted.splice(at, 1);
      view.unmount();
    },
  };
  mounted.push(p.unmount);
  p.transcript(history, 6_000);
  return p;
}

const lastFollowing = (): boolean | undefined => following.at(-1);

describe("the live row in Chat", () => {
  it("at the end: grows with each read, the end kept in sight; its own text landing ends it, one row", () => {
    const p = pane();
    expect(live, "the page listens for live reads").not.toBeNull();
    expect(p.scroll.gap()).toBe(0);
    p.read("I'll port the reader", 6_060);
    expect(p.liveRow()).toBe("I'll port the reader");
    expect(p.scroll.gap()).toBe(0);
    p.frame();
    p.read("I'll port the reader first, then the merge", 6_120);
    expect(p.liveRow()).toBe("I'll port the reader first, then the merge");
    expect(p.scroll.gap()).toBe(0);
    p.frame();
    p.read("I'll port the reader first, then the merge.\n\n- the screen\n- the reads", 6_260);
    expect(p.scroll.gap()).toBe(0);
    p.frame();
    expect(p.newPill()).toBe(false);
    expect(lastFollowing()).not.toBe(false);

    // The transcript's text lands: the live row goes, the reply row takes its place; one row, never both.
    p.transcript([...p.lines(), reply("I'll port the reader first, then the merge.\n\n- the screen\n- the reads", "r-now", 1_000)], 6_260);
    expect(p.liveRow()).toBeNull();
    expect(p.replies()).toEqual(["I'll port the reader first, then the merge.\n\n- the screen\n- the reads"]);
    expect(p.scroll.gap()).toBe(0);
    // A late read of the same text shows nothing again.
    p.read("I'll port the reader first, then the merge.\n\n- the screen\n- the reads", 6_260);
    expect(p.liveRow()).toBeNull();
    p.unmount();
  });

  it("scrolled up: the user's place is kept as the row comes and grows, the New pill lit; back at the end it follows again", () => {
    const p = pane();
    p.scrollTo(1_500);
    expect(lastFollowing()).toBe(false);
    p.read("Reading the Swift tests", 6_060);
    expect(p.liveRow()).toBe("Reading the Swift tests");
    expect(p.scroll.scrollTop).toBe(1_500);
    expect(p.newPill()).toBe(true);
    p.frame();
    p.read("Reading the Swift tests and fixtures", 6_120);
    expect(p.scroll.scrollTop).toBe(1_500);
    p.frame();
    expect(p.scroll.scrollTop).toBe(1_500);

    // At the end again: the next read keeps the end in sight.
    p.scrollTo(p.scroll.scrollHeight);
    expect(lastFollowing()).toBe(true);
    expect(p.newPill()).toBe(false);
    p.read("Reading the Swift tests and fixtures, then porting", 6_200);
    expect(p.scroll.gap()).toBe(0);
    p.unmount();
  });

  it("text of this turn already landed shows no row; a read with no block ends the row", () => {
    const p = pane();
    p.transcript([...p.lines(), reply("Item 1 is committed.", "r-landed", 995)], 6_000);
    p.read("Item 1 is committed.", 6_000);
    expect(p.liveRow()).toBeNull();
    expect(p.replies()).toEqual(["Item 1 is committed."]);
    p.read("A new reply", 6_060);
    expect(p.liveRow()).toBe("A new reply");
    p.read(null, 6_000);
    expect(p.liveRow()).toBeNull();
    p.unmount();
  });

  it("the Chat leaving the pane ends its row", () => {
    const p = pane();
    p.read("A new reply", 6_060);
    expect(liveRows.row("mac", "w1:p1", timelineOf(p.lines()).timeline)).toBe("A new reply");
    p.unmount();
    expect(liveRows.merge("mac", "w1:p1")).toBeNull();
  });
});
