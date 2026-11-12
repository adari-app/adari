// Esc owners: the Esc that closes the sidebar's Search never stops.
// Search's field consumes its closing Escape, and the window's Stop decision
// reads where the key started (the event's target, its composed path), not
// only document.activeElement when the key reaches the window: a field that
// unmounts on Esc, or hands the focus to the body, between its own handler and
// the window's never turns the same key into Stop. A shown context
// ring card owns Esc whether hover or a click shows it; Esc closes it (both
// unpinned and unhovered), its ownership released one task later.
// The real components run on the small hooks host with a fake window that
// dispatches a key as a browser does: window capture listeners, the focused
// element's React handler, then window bubble listeners.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
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
const { ContextRing } = await import("../src/renderer/components/ContextRing");
const { Sidebar } = await import("../src/renderer/components/Sidebar");

type Listener = { type: string; fn: (event: unknown) => void; capture: boolean };

let listeners: Listener[] = [];
let stops: { hostId: string; paneId: string }[] = [];
const body = { tagName: "BODY", classList: { add: () => undefined }, closest: () => null };
let active: unknown = body;

beforeEach(() => {
  listeners = [];
  stops = [];
  active = body;
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
      onChatUpdate: () => () => undefined,
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, fn: (event: unknown) => void, options?: boolean | { capture?: boolean }) =>
      listeners.push({ type, fn, capture: options === true || (typeof options === "object" && options.capture === true) }),
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners = listeners.filter((l) => l.type !== type || l.fn !== fn);
    },
    getSelection: () => null,
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
  composerDrafts.clear();
  agentStops.clear();
  escapeOwners.reset();
});

afterEach(() => vi.unstubAllGlobals());

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A focused element as the window sees it; `tile`: inside that tile's [data-tile]. */
function element(tagName: string, options: { type?: string; tile?: string } = {}): unknown {
  const tile = options.tile === undefined ? null : { getAttribute: (name: string) => (name === "data-tile" ? options.tile! : null) };
  return {
    tagName,
    type: options.type ?? (tagName === "INPUT" ? "text" : ""),
    isContentEditable: false,
    closest: (selector: string) => (selector.includes("[data-tile]") ? tile : null),
    getAttribute: () => null,
  };
}

/** An Escape keydown that started at `target` (event.target and the composed path's first element). */
function escapeAt(target: unknown) {
  return {
    key: "Escape",
    target,
    composedPath: () => [target, body],
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation: () => undefined,
  };
}

/** The browser's dispatch, in two halves: up to and including the focused element's handler, then the window's bubble listeners. */
function capture(event: unknown, handler?: (event: unknown) => void): void {
  for (const l of listeners.filter((x) => x.type === "keydown" && x.capture)) l.fn(event);
  handler?.(event);
}
function bubble(event: unknown): void {
  for (const l of listeners.filter((x) => x.type === "keydown" && !x.capture)) l.fn(event);
}
function press(target: unknown = active): ReturnType<typeof escapeAt> {
  const event = escapeAt(target);
  capture(event);
  bubble(event);
  return event;
}

function topologyOf(status = "working", agent = "claude"): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-0", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent, agent_status: status, revision: 1 }],
    layouts: [],
    agents: [
      {
        pane_id: "w1:p1",
        agent,
        agent_status: status,
        terminal_id: "t-0",
        state_change_seq: 12,
        agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: "s-0" },
      },
    ],
  });
}

function hostOf(topology = topologyOf()): HostView {
  return { id: "mac-mini", name: "Mac mini", state: "connected", topology, connection: 3, incarnation: 1, epoch: 7 } as HostView;
}

const rowOf = (kind = "claude") =>
  ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind, status: "working", glyph: "working" }) as SidebarRow;

function chatBox(props: Record<string, unknown> = {}) {
  const ui = new HookHost<Record<string, unknown>>(Composer as (p: object) => unknown, { host: hostOf(), row: rowOf(), floating: true, stops: true, ...props });
  ui.render();
  return ui;
}

describe("the Esc that closes Search never stops", () => {
  it("the sidebar's Search field closing on Esc, the field gone and the focus on the body before the window's listener, in that order", async () => {
    const chat = chatBox();
    let search: string | null = "claude";
    const props = () => ({
      sidebar: { mode: "projects", badge: 0, needsYou: [], hosts: [], sections: [] },
      selectedKey: null,
      search,
      demo: false,
      foldedHosts: new Set(),
      onSearch(value: string | null) {
        search = value;
        sidebar.render(props());
        // The field unmounts: the focus falls back to the body.
        if (value === null) active = body;
      },
      onMode() {},
      onNewAgent() {},
      onAddHost() {},
    });
    const sidebar = new HookHost<object>(Sidebar as (p: object) => unknown, props());
    sidebar.render();
    const input = elements(sidebar.tree).find((e) => e.type === "input")!;
    const field = element("INPUT");
    active = field;
    const event = escapeAt(field);
    capture(event, input.props["onKeyDown"] as (e: unknown) => void);
    await Promise.resolve();
    expect(search).toBeNull();
    expect(active).toBe(body);
    expect(elements(sidebar.tree).some((e) => e.type === "input")).toBe(false);
    bubble(event);
    expect(stops).toEqual([]);
    sidebar.unmount();
    chat.unmount();
  });

  it("a text field whose own handler closes it without consuming Esc (a rename field, a future dialog's input): the key started there, so it is not Stop", () => {
    const chat = chatBox();
    for (const field of [element("INPUT"), element("INPUT", { type: "search" }), element("TEXTAREA"), element("SELECT")]) {
      active = field;
      const event = escapeAt(field);
      capture(event);
      // Its handler removed it: the focus is on the body when the key reaches the window.
      active = body;
      bubble(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(stops).toEqual([]);
    chat.unmount();
  });

  it("a key that started inside another tile, the focus gone to the body by the time it reaches the window: nothing is stopped", () => {
    const chat = chatBox({ floating: false, compact: true, takesKeys: true });
    const event = escapeAt(element("BUTTON", { tile: "w1:p2" }));
    capture(event);
    active = body;
    bubble(event);
    expect(stops).toEqual([]);
    chat.unmount();
  });

  it("a key that started on a sidebar row or the header (not a text field) still stops, whatever has the focus when it reaches the window", () => {
    const chat = chatBox();
    const event = escapeAt(element("BUTTON"));
    capture(event);
    active = body;
    bubble(event);
    expect(stops.map((s) => s.paneId)).toEqual(["w1:p1"]);
    expect(event.defaultPrevented).toBe(true);
    chat.unmount();
  });

  it("a key whose target is the body (nothing focused) stops, and one that the focus moved into a text field for is not Stop", () => {
    const chat = chatBox();
    active = element("INPUT");
    press(body);
    expect(stops).toEqual([]);
    active = body;
    press(body);
    expect(stops).toHaveLength(1);
    chat.unmount();
  });
});

describe("a shown ring card owns Esc, hover or pinned", () => {
  const ringOf = () => {
    const ring = new HookHost<object>(ContextRing as (p: object) => unknown, { host: hostOf(), row: rowOf() });
    ring.render();
    const wrapper = () => elements(ring.tree).find((e) => typeof e.props["onMouseEnter"] === "function")!;
    return {
      ring,
      expanded: () => elements(ring.tree).find((e) => e.type === "button")?.props["aria-expanded"],
      enter: () => (wrapper().props["onMouseEnter"] as () => void)(),
      leave: () => (wrapper().props["onMouseLeave"] as () => void)(),
      click: () => (elements(ring.tree).find((e) => e.type === "button")!.props["onClick"] as () => void)(),
    };
  };

  it("a card shown by hover only: Esc closes it and stops nothing; Esc again (its hold released) stops", async () => {
    const chat = chatBox();
    const r = ringOf();
    r.enter();
    expect(r.expanded()).toBe(true);
    expect(escapeOwners.any()).toBe(true);
    press(body);
    expect(stops).toEqual([]);
    expect(r.expanded()).toBe(false);
    await tick();
    expect(escapeOwners.any()).toBe(false);
    press(body);
    expect(stops).toHaveLength(1);
    r.ring.unmount();
    chat.unmount();
  });

  it("a card hovered and pinned: one Esc closes it (both cleared) and stops nothing", async () => {
    const chat = chatBox();
    const r = ringOf();
    r.enter();
    r.click();
    expect(r.expanded()).toBe(true);
    press(body);
    expect(r.expanded()).toBe(false);
    expect(stops).toEqual([]);
    await tick();
    expect(escapeOwners.any()).toBe(false);
    expect(listeners.filter((l) => l.capture && l.type === "keydown")).toEqual([]);
    r.ring.unmount();
    chat.unmount();
  });

  it("the card going away (the pointer leaves, or its context goes) gives Esc back", async () => {
    const chat = chatBox();
    const r = ringOf();
    r.enter();
    r.leave();
    expect(r.expanded()).toBe(false);
    await tick();
    expect(escapeOwners.any()).toBe(false);
    press(body);
    expect(stops).toHaveLength(1);
    agentStops.clear();
    r.enter();
    expect(escapeOwners.any()).toBe(true);
    r.ring.render({ host: hostOf(topologyOf("working", "grok")), row: rowOf("grok") });
    expect(r.ring.tree).toBeNull();
    await tick();
    expect(escapeOwners.any()).toBe(false);
    expect(listeners.filter((l) => l.capture && l.type === "keydown")).toEqual([]);
    r.ring.unmount();
    chat.unmount();
  });
});
