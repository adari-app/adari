// In Adari's Chat, Esc stops a working agent wherever the focus is: not only
// with nothing focused or the focus inside the Chat area, but also on the
// sidebar row clicked to open the pane, the header's Chat/Terminal switch and
// its buttons. In the one pane view, Esc is Stop whenever the
// shown Chat's agent can stop, nothing on top owns Esc (escape-owners.ts) and
// the focus is not in another feature's own text field (the sidebar's search,
// a rename field, a dialog's inputs, a terminal); in a split, the focused
// tile's Chat keeps Esc while the focus is on the sidebar or the header.
// Esc's other rules stay (no auto-repeat, no modifier,
// no composition, one Escape per press). The real components run on the small
// hooks host with a fake window that dispatches a key as a browser does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { reply, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { agentStops } = await import("../src/renderer/components/agent-stop");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { ChatView } = await import("../src/renderer/chat/ChatView");
const { chatUpdates } = await import("../src/renderer/chat/chat-state");

type Listener = { type: string; fn: (event: unknown) => void; capture: boolean };

let listeners: Listener[] = [];
let stops: { hostId: string; paneId: string }[] = [];
const body = { tagName: "BODY", classList: { add: () => undefined }, closest: () => null };
let active: unknown = body;
let selection = "";

// The page listens to chat updates once for its life: the first listener attached is the one.
let deliver: ((event: ChatUpdateEvent) => void) | null = null;

beforeEach(() => {
  listeners = [];
  stops = [];
  active = body;
  selection = "";
  composerDrafts.clear();
  agentStops.clear();
  escapeOwners.reset();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      stopAgent: (hostId: string, paneId: string) => {
        stops.push({ hostId, paneId });
        return new Promise<string | null>(() => undefined);
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: () => undefined,
      onChatUpdate: (listener: (event: ChatUpdateEvent) => void) => {
        deliver = listener;
        return () => undefined;
      },
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, fn: (event: unknown) => void, options?: boolean | { capture?: boolean }) =>
      listeners.push({ type, fn, capture: options === true || (typeof options === "object" && options.capture === true) }),
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners = listeners.filter((l) => l.type !== type || l.fn !== fn);
    },
    getSelection: () => ({ isCollapsed: selection === "", toString: () => selection }),
  });
  vi.stubGlobal("document", {
    body,
    get activeElement() {
      return active;
    },
    fonts: { ready: Promise.resolve() },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

interface Keys {
  metaKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

/** A keydown as the browser delivers it: window capture listeners, the focused element's React handler, then window bubble listeners. */
function press(key: string, keys: Keys = {}, handler?: (event: unknown) => void) {
  const event = {
    key,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    ...keys,
    nativeEvent: { isComposing: keys.isComposing === true },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation: () => undefined,
  };
  for (const l of listeners.filter((x) => x.type === "keydown" && x.capture)) l.fn(event);
  handler?.(event);
  for (const l of listeners.filter((x) => x.type === "keydown" && !x.capture)) l.fn(event);
  return event;
}

function topologyOf(status = "working", panes: string[] = ["w1:p1"]): SessionTopology {
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
      state_change_seq: 12,
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: `s-${i}` },
    })),
  });
}

function hostOf(state: HostView["state"] = "connected", topology = topologyOf()): HostView {
  return { id: "mac-mini", name: "Mac mini", state, topology, connection: 3, incarnation: 1, epoch: 7 } as HostView;
}

const rowOf = (paneID = "w1:p1", status = "working") =>
  ({ paneID, name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle" }) as SidebarRow;

/**
 * A focused element as the window sees it: where it sits (the Chat area, a
 * tile, the sidebar, the header), its tag and input type, and `closest` for
 * the ancestors the app asks about ([data-tile], .term-host).
 */
interface Place {
  readonly tag: string;
  readonly inChat?: boolean;
  readonly tile?: string;
  readonly type?: string;
  readonly editable?: boolean;
  readonly terminal?: boolean;
}

function focusOn(place: Place): unknown {
  const tile = place.tile === undefined ? null : { getAttribute: (name: string) => (name === "data-tile" ? place.tile! : null) };
  const element = {
    tagName: place.tag,
    type: place.type ?? (place.tag === "INPUT" ? "text" : ""),
    isContentEditable: place.editable === true,
    inChat: place.inChat === true,
    closest: (selector: string): unknown => {
      if (selector.includes("[data-tile]") && tile !== null) return tile;
      if (selector.includes(".term-host") && place.terminal === true) return element;
      return null;
    },
    getAttribute: () => null,
  };
  return element;
}

/** The Chat area around the box: what the box's wrap's parent contains (its ref attached as the DOM would). */
const chatArea = { contains: (element: unknown) => element === body || (element as { inChat?: boolean } | null)?.inChat === true };

function chatBox(props: Record<string, unknown> = {}) {
  const ui = new HookHost<Record<string, unknown>>(Composer as (p: object) => unknown, { host: hostOf(), row: rowOf(), floating: true, stops: true, ...props });
  ui.render();
  const textarea = elements(ui.tree).find((e) => e.type === "textarea")!;
  const box = { tagName: "TEXTAREA", type: "textarea", isContentEditable: false, inChat: true, closest: () => null };
  (textarea.props["ref"] as { current: unknown }).current = box;
  (elements(ui.tree)[0]!.props["ref"] as { current: unknown }).current = { parentElement: chatArea };
  return { ui, box, keyInBox: (event: unknown) => (textarea.props["onKeyDown"] as (e: unknown) => void)(event) };
}

/** The pane's Chat beside the box, scrolled up or at its end. */
function chatScrolled(where: "up" | "end") {
  const view = new HookHost(ChatView as (p: object) => unknown, { host: hostOf(), row: rowOf(), onShowTerminal: () => undefined, bottomInset: 120 });
  view.render();
  const scroll = { scrollHeight: 4000, scrollTop: 0, clientHeight: 600 };
  (elements(view.tree).find((e) => e.props["className"] === "chat-scroll")!.props["ref"] as { current: unknown }).current = scroll;
  const lines = Array.from({ length: 30 }, (_, i) => [user(`question ${i}`, `u${i}`, i * 10), reply(`answer ${i}`, `a${i}`, i * 10 + 5)]).flat();
  chatUpdates.follow("mac-mini", "w1:p1");
  deliver!({ hostId: "mac-mini", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(lines).timeline });
  if (where === "up") {
    // The user's wheel up, then its scroll.
    (elements(view.tree).find((e) => e.props["className"] === "chat-scroll")!.props["onWheel"] as (e: unknown) => void)({ deltaY: -3200, ctrlKey: false });
    scroll.scrollTop = 800;
    (elements(view.tree).find((e) => e.props["className"] === "chat-scroll")!.props["onScroll"] as () => void)();
  }
  return { view, scroll, newPill: () => elements(view.tree).some((e) => e.props["className"] === "chat-new") };
}

/** Each place the focus can be while a working agent's Chat is on screen. */
const places: { readonly name: string; readonly focus: () => unknown; readonly selection?: string }[] = [
  { name: "the sidebar row that opened the pane", focus: () => focusOn({ tag: "BUTTON" }) },
  { name: "another sidebar row", focus: () => focusOn({ tag: "BUTTON" }) },
  { name: "the New agent row", focus: () => focusOn({ tag: "BUTTON" }) },
  { name: "the header's Chat/Terminal switch", focus: () => focusOn({ tag: "BUTTON" }) },
  { name: "a header button (Split, Open in Ghostty)", focus: () => focusOn({ tag: "BUTTON" }) },
  { name: "a link in the conversation", focus: () => focusOn({ tag: "A", inChat: true }) },
  { name: "a button in the conversation (a message's Copy)", focus: () => focusOn({ tag: "BUTTON", inChat: true }) },
  { name: "a code block's Wrap or Copy", focus: () => focusOn({ tag: "BUTTON", inChat: true }) },
  { name: "the New pill", focus: () => focusOn({ tag: "BUTTON", inChat: true }) },
  { name: "the chips row (the Model chip, closed)", focus: () => focusOn({ tag: "BUTTON", inChat: true }) },
  { name: "the context ring (its card closed)", focus: () => focusOn({ tag: "BUTTON", inChat: true }) },
  { name: "a text selection in the conversation", focus: () => body, selection: "a few words of the reply" },
  { name: "a text selection made after a sidebar row was clicked", focus: () => focusOn({ tag: "BUTTON" }), selection: "a few words" },
  { name: "the window just focused, nothing focused", focus: () => body },
  { name: "the window just focused, no active element", focus: () => null },
];

describe("Esc stops a working agent wherever the focus is (the one pane view)", () => {
  for (const where of ["up", "end"] as const) {
    for (const place of places) {
      it(`${place.name}, the Chat ${where === "up" ? "scrolled up" : "at its end"}: exactly one Escape`, () => {
        const chat = chatScrolled(where);
        const c = chatBox();
        active = place.focus();
        selection = place.selection ?? "";
        const event = press("Escape");
        expect(stops.map((s) => [s.hostId, s.paneId])).toEqual([["mac-mini", "w1:p1"]]);
        expect(event.defaultPrevented).toBe(true);
        // A second press is a second Escape, as in the terminal.
        press("Escape");
        expect(stops).toHaveLength(2);
        c.ui.unmount();
        chat.view.unmount();
      });
    }
  }

  it("in the box itself: once, by the box's own handler (the window's listener does not add a second)", () => {
    const c = chatBox();
    active = c.box;
    press("Escape", {}, c.keyInBox);
    expect(stops).toHaveLength(1);
    c.ui.unmount();
  });
});

describe("Esc that is not Stop", () => {
  it("the agent not working, or its machine offline", () => {
    active = focusOn({ tag: "BUTTON" });
    const idle = chatBox({ host: hostOf("connected", topologyOf("idle")), row: rowOf("w1:p1", "idle") });
    press("Escape");
    idle.ui.unmount();
    const offline = chatBox({ host: hostOf("offline") });
    press("Escape");
    offline.ui.unmount();
    expect(stops).toEqual([]);
  });

  it("something on top owns Esc (a menu, the picture viewer, a dialog, Search's screen)", () => {
    const c = chatBox();
    active = focusOn({ tag: "BUTTON" });
    const release = escapeOwners.hold();
    const event = press("Escape");
    expect(stops).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    release();
    c.ui.unmount();
  });

  it("the focus in the sidebar's search field, a rename field, a dialog's input or a contenteditable", () => {
    const c = chatBox();
    for (const field of [
      focusOn({ tag: "INPUT" }),
      focusOn({ tag: "INPUT", type: "search" }),
      focusOn({ tag: "TEXTAREA" }),
      focusOn({ tag: "SELECT" }),
      focusOn({ tag: "DIV", editable: true }),
    ]) {
      active = field;
      const event = press("Escape");
      expect(event.defaultPrevented).toBe(false);
    }
    expect(stops).toEqual([]);
    c.ui.unmount();
  });

  it("the focus in a terminal (its helper textarea, or anything in .term-host)", () => {
    const c = chatBox();
    active = focusOn({ tag: "TEXTAREA", terminal: true });
    press("Escape");
    active = focusOn({ tag: "DIV", terminal: true });
    press("Escape");
    expect(stops).toEqual([]);
    c.ui.unmount();
  });

  it("with ⌘, ⌥, ⌃ or ⇧, an auto-repeat, or ending a composition", () => {
    const c = chatBox();
    active = focusOn({ tag: "BUTTON" });
    for (const keys of [{ metaKey: true }, { altKey: true }, { ctrlKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }]) press("Escape", keys);
    expect(stops).toEqual([]);
    c.ui.unmount();
  });

  it("a checkbox or a button-like input is not a text field: Esc stops", () => {
    const c = chatBox();
    active = focusOn({ tag: "INPUT", type: "checkbox" });
    press("Escape");
    expect(stops).toHaveLength(1);
    c.ui.unmount();
  });
});

describe("a split: the focused tile's Chat keeps Esc", () => {
  const two = () => hostOf("connected", topologyOf("working", ["w1:p1", "w1:p2"]));
  const tile = (paneId: string, focused: boolean) => chatBox({ host: two(), row: rowOf(paneId), floating: false, compact: true, takesKeys: focused });

  it("with the focus on the sidebar or the header, Esc stops only the focused tile's agent", () => {
    const left = tile("w1:p1", false);
    const right = tile("w1:p2", true);
    active = focusOn({ tag: "BUTTON" });
    press("Escape");
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p2"]);
    agentStops.clear();
    // The user clicks the left tile: it is the focused one now; the focus goes on to the sidebar.
    left.ui.render({ host: two(), row: rowOf("w1:p1"), floating: false, compact: true, stops: true, takesKeys: true });
    right.ui.render({ host: two(), row: rowOf("w1:p2"), floating: false, compact: true, stops: true, takesKeys: false });
    active = focusOn({ tag: "BUTTON" });
    press("Escape");
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p2", "w1:p1"]);
    left.ui.unmount();
    right.ui.unmount();
  });

  it("with the focus on a control in the focused tile (its header switch, its conversation), Esc stops that tile's agent", () => {
    const left = tile("w1:p1", false);
    const right = tile("w1:p2", true);
    // Inside the tile's own .tile-in (the box's wrap's parent), as the DOM has it.
    active = focusOn({ tag: "BUTTON", tile: "w1:p2", inChat: true });
    press("Escape");
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p2"]);
    left.ui.unmount();
    right.ui.unmount();
  });

  it("with the focus inside another tile (moved there by the keyboard, the tile not focused), nothing is stopped", () => {
    const left = tile("w1:p1", false);
    const right = tile("w1:p2", true);
    active = focusOn({ tag: "BUTTON", tile: "w1:p1" });
    press("Escape");
    expect(stops).toEqual([]);
    left.ui.unmount();
    right.ui.unmount();
  });

  it("the box of the tile not focused still stops its own agent from inside it", () => {
    const left = tile("w1:p1", false);
    const right = tile("w1:p2", true);
    active = left.box;
    press("Escape", {}, left.keyInBox);
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p1"]);
    left.ui.unmount();
    right.ui.unmount();
  });
});
