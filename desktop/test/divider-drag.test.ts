// A divider drag belongs to its view: the machine, tab and layout are captured when it starts; one drag owner
// at a time; its window listeners, the body class and the tiles' override go
// on unmount, a tab or machine change, pointercancel and the window hidden;
// a release uses the captured machine and is refused when the tab's layout
// changed under it, never sent for the selection's machine. "Changed" is the
// tab's tree (a pane on another side of a split, the panes' order kept or not),
// and a rearranged layout reaching the view cancels the drag at once. The real App and SplitView run on the small hooks host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { HostView, LayoutUpdateEvent, PaneAction } from "../src/shared/ipc-contract";
import { splitShapeOf } from "../src/shared/pane-binding";
import type { PaneLayout } from "../src/shared/pane-layout";
import { HookHost, elements } from "./support/fake-hooks";

const { App } = await import("../src/renderer/App");
const { SplitView } = await import("../src/renderer/split/SplitView");
const { layoutStore } = await import("../src/renderer/split/layout-store");

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

// Two tabs of two shells each, on two machines with the same topology.
const panes = [
  { id: "w1:p1", tab: "w1:t1" },
  { id: "w1:p2", tab: "w1:t1" },
  { id: "w1:p3", tab: "w1:t2" },
  { id: "w1:p4", tab: "w1:t2" },
  // Fix 3 (1c): a tab of four, two columns each split down.
  { id: "w1:p5", tab: "w1:t3" },
  { id: "w1:p6", tab: "w1:t3" },
  { id: "w1:p7", tab: "w1:t3" },
  { id: "w1:p8", tab: "w1:t3" },
];
const topology = decodeSessionTopology({
  version: "0.9.5",
  protocol: 22,
  workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 8, tab_count: 3, active_tab_id: "w1:t1", agent_status: "idle" }],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "one", focused: true, pane_count: 2, agent_status: "idle" },
    { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "two", focused: false, pane_count: 2, agent_status: "idle" },
    { tab_id: "w1:t3", workspace_id: "w1", number: 3, label: "four", focused: false, pane_count: 4, agent_status: "idle" },
  ],
  panes: panes.map((pane, index) => ({
    pane_id: pane.id,
    terminal_id: `term${index}`,
    workspace_id: "w1",
    tab_id: pane.tab,
    focused: index === 0,
    cwd: "/fixture",
    agent_status: "unknown",
    revision: 1,
  })),
  layouts: [],
  agents: [],
});
const host: HostView = { id: "host", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology };
const hostB: HostView = { ...host, id: "hostB", name: "Studio" };

const area = { x: 0, y: 0, width: 134, height: 45 };

/** A tab of two panes side by side (Herdr's split_0_root). */
function pair(tabId: string, first: string, second: string, ratio = 0.5): PaneLayout {
  const width = Math.round(134 * ratio);
  return {
    tabId,
    workspaceId: "w1",
    area,
    focusedPaneId: first,
    panes: [
      { paneId: first, rect: { x: 0, y: 0, width, height: 45 }, focused: true },
      { paneId: second, rect: { x: width, y: 0, width: 134 - width, height: 45 }, focused: false },
    ],
    splits: [{ id: "split_0_root", direction: "right", ratio, rect: area }],
    zoomed: false,
  };
}

/**
 * Tab w1:t3 as Herdr arranges four panes: two columns (split_0_root), each
 * split down (split_1_0 on the left, split_2_1 on the right), the panes listed
 * in Herdr's order. `exchanged` swaps the places of the second and fourth
 * panes, the list's order kept (a delivered rearrangement).
 */
function four(exchanged = false): PaneLayout {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const places = [rect(0, 0, 67, 23), rect(0, 23, 67, 22), rect(67, 0, 67, 23), rect(67, 23, 67, 22)];
  if (exchanged) [places[1], places[3]] = [places[3]!, places[1]!];
  return {
    tabId: "w1:t3",
    workspaceId: "w1",
    area,
    focusedPaneId: "w1:p5",
    panes: ["w1:p5", "w1:p6", "w1:p7", "w1:p8"].map((paneId, index) => ({ paneId, rect: places[index]!, focused: index === 0 })),
    splits: [
      { id: "split_0_root", direction: "right", ratio: 0.5, rect: area },
      { id: "split_1_0", direction: "down", ratio: 0.5, rect: rect(0, 0, 67, 45) },
      { id: "split_2_1", direction: "down", ratio: 0.5, rect: rect(67, 0, 67, 45) },
    ],
    zoomed: false,
  };
}

const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const one = (tree: unknown, name: string) => named(tree, name)[0];

let cleanup: (() => void) | null = null;

beforeEach(() => layoutStore.reset());

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function page() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const bodyClasses = new Set<string>();
  const actions: [string, PaneAction][] = [];
  let layoutListener: ((event: LayoutUpdateEvent) => void) | null = null;
  const bridge = {
    appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
    listHosts: async () => [host, hostB],
    onHostsChanged: () => () => undefined,
    onAppCommand: () => () => undefined,
    onViewCommand: () => () => undefined,
    ghosttyInfo: async () => ({ shown: false }),
    appCommandDone: () => undefined,
    onChatUpdate: () => () => undefined,
    openChat: () => undefined,
    closeChat: () => undefined,
    setChatFollowing: () => undefined,
    startCommands: () => Promise.resolve({ status: { type: "absent" }, commands: {}, refused: {} }),
    watchLayout: () => undefined,
    onLayoutUpdate: (listener: (event: LayoutUpdateEvent) => void) => {
      layoutListener = listener;
      return () => undefined;
    },
    paneAction: (hostId: string, action: PaneAction) => {
      actions.push([hostId, action]);
      return new Promise(() => undefined);
    },
  };
  vi.stubGlobal("window", {
    herdrDesktop: bridge,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => listeners.get(type)?.delete(listener),
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    getSelection: () => null,
  });
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("document", {
    body: {
      classList: {
        add: (...names: string[]) => names.forEach((name) => bodyClasses.add(name)),
        remove: (...names: string[]) => names.forEach((name) => bodyClasses.delete(name)),
      },
    },
    fonts: { ready: new Promise(() => undefined) },
    querySelector: () => null,
    visibilityState: "visible",
  });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  cleanup = () => app.unmount();

  const splitProps = () => one(app.tree, "SplitView")?.props as Record<string, unknown> | undefined;
  /** The App's SplitView on its own host (the tiles' area measured 1000 x 800), and its first divider pressed at x = 500. */
  const mountSplit = () => {
    const view = new HookHost(SplitView as (props: object) => unknown, splitProps()!);
    view.render();
    const area = elements(view.tree).find((element) => element.props["className"] === "tiles")!;
    (area.props["ref"] as { current: unknown }).current = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
    const press = () => {
      const separator = elements(view.tree).find((element) => element.props["role"] === "separator")!;
      (separator.props["onPointerDown"] as (event: unknown) => void)({ button: 0, preventDefault: () => undefined, clientX: 500, clientY: 100 });
    };
    /** Presses the divider of `splitId` at (x, y) on the 1000 x 800 area. */
    const pressOn = (splitId: string, clientX: number, clientY: number) => {
      const index = (splitProps()!["dividers"] as { splitId: string }[]).findIndex((divider) => divider.splitId === splitId);
      const separator = elements(view.tree).filter((element) => element.props["role"] === "separator")[index]!;
      (separator.props["onPointerDown"] as (event: unknown) => void)({ button: 0, preventDefault: () => undefined, clientX, clientY });
    };
    return { view, press, pressOn, rerender: () => view.render(splitProps()!) };
  };
  const fire = (type: string, event: unknown = {}) => {
    for (const listener of Array.from(listeners.get(type) ?? [])) listener(event);
  };
  const count = (type: string) => listeners.get(type)?.size ?? 0;
  const dragListeners = () => ["pointermove", "pointerup", "pointercancel", "blur", "visibilitychange"].map(count).reduce((a, b) => a + b, 0);
  const width = () => (splitProps()?.["tiles"] as { frame: { width: number } }[] | undefined)?.[0]?.frame.width;
  const notice = () => elements(app.tree).find((element) => element.props["className"] === "app-toast")?.props["children"] ?? null;
  return {
    app,
    actions,
    listeners,
    select: (hostId: string, paneId: string) => (one(app.tree, "Sidebar")!.props["onSelect"] as (h: string, p: string) => void)(hostId, paneId),
    layout: (hostId: string, layout: PaneLayout, paneId: string) => layoutListener!({ hostId, paneId, tabId: layout.tabId, layout, error: null }),
    splitProps,
    mountSplit,
    /** The body's drag classes (the page's own, such as platform-darwin, aside). */
    resizingClasses: () => Array.from(bodyClasses).filter((name) => name.startsWith("resizing")),
    fire,
    count,
    dragListeners,
    width,
    notice,
  };
}

describe("a divider drag belongs to its view", () => {
  it("unmounted mid-drag (another machine selected): its listeners and class go, and a late release resizes nothing", async () => {
    const p = await page();
    p.select("host", "w1:p1");
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p2"), "w1:p1");
    const s = p.mountSplit();
    s.press();
    expect(p.count("pointermove")).toBe(1);
    expect(p.resizingClasses()).toEqual(["resizing", "resizing-right"]);
    const up = Array.from(p.listeners.get("pointerup")!)[0]!;
    p.select("hostB", "w1:p1");
    s.view.unmount();
    expect(p.dragListeners()).toBe(0);
    expect(p.resizingClasses()).toEqual([]);
    // A release that still reached the old handler: nothing goes to either machine.
    up({ clientX: 650, clientY: 100 });
    await Promise.resolve();
    expect(p.actions).toEqual([]);
  });

  it("a release goes to the machine and split it began on, once", async () => {
    const p = await page();
    p.select("host", "w1:p1");
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p2"), "w1:p1");
    const s = p.mountSplit();
    s.press();
    p.fire("pointermove", { clientX: 650, clientY: 100 });
    expect(p.width()).toBeCloseTo(0.65, 5);
    p.fire("pointerup", { clientX: 650, clientY: 100 });
    expect(p.actions).toHaveLength(1);
    const [hostId, action] = p.actions[0]!;
    expect(hostId).toBe("host");
    // Bound to the divider's first pane and its split's place as the drag began (fix 2).
    expect(action).toMatchObject({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], ratio: 0.65, binding: { paneId: "w1:p1", tabId: "w1:t1" } });
    expect(p.dragListeners()).toBe(0);
    expect(p.resizingClasses()).toEqual([]);
    // Held where the user let go until Herdr answers.
    expect(p.width()).toBeCloseTo(0.65, 5);
    s.view.unmount();
  });

  it("pointercancel ends the drag: no listeners, no class, the tiles back as Herdr has them, nothing sent", async () => {
    const p = await page();
    p.select("host", "w1:p1");
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p2"), "w1:p1");
    const s = p.mountSplit();
    s.press();
    p.fire("pointermove", { clientX: 700, clientY: 100 });
    expect(p.width()).toBeCloseTo(0.7, 5);
    p.fire("pointercancel");
    expect(p.dragListeners()).toBe(0);
    expect(p.resizingClasses()).toEqual([]);
    expect(p.width()).toBeCloseTo(0.5, 5);
    p.fire("pointerup", { clientX: 700, clientY: 100 });
    expect(p.actions).toEqual([]);
    s.view.unmount();
  });

  it("the window hidden or losing focus mid-drag ends it the same way", async () => {
    const p = await page();
    p.select("host", "w1:p1");
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p2"), "w1:p1");
    const s = p.mountSplit();
    s.press();
    p.fire("pointermove", { clientX: 700, clientY: 100 });
    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    p.fire("visibilitychange");
    expect(p.dragListeners()).toBe(0);
    expect(p.resizingClasses()).toEqual([]);
    expect(p.width()).toBeCloseTo(0.5, 5);
    (document as unknown as { visibilityState: string }).visibilityState = "visible";
    s.press();
    p.fire("blur");
    expect(p.dragListeners()).toBe(0);
    expect(p.actions).toEqual([]);
    s.view.unmount();
  });

  it("another tab shown in the same view mid-drag ends it; its override never lands on the new tab", async () => {
    const p = await page();
    p.select("host", "w1:p1");
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p2"), "w1:p1");
    const s = p.mountSplit();
    s.press();
    p.fire("pointermove", { clientX: 700, clientY: 100 });
    // The other tab, with the same split id, comes into the same SplitView.
    p.select("host", "w1:p3");
    p.layout("host", pair("w1:t2", "w1:p3", "w1:p4"), "w1:p3");
    s.rerender();
    expect(p.dragListeners()).toBe(0);
    expect(p.resizingClasses()).toEqual([]);
    expect(p.width()).toBeCloseTo(0.5, 5);
    p.fire("pointerup", { clientX: 700, clientY: 100 });
    expect(p.actions).toEqual([]);
    s.view.unmount();
  });

  it("only one drag at a time: a second press ends the first", async () => {
    const p = await page();
    p.select("host", "w1:p1");
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p2"), "w1:p1");
    const s = p.mountSplit();
    s.press();
    s.press();
    expect(p.count("pointermove")).toBe(1);
    expect(p.count("pointerup")).toBe(1);
    p.fire("pointerup", { clientX: 600, clientY: 100 });
    expect(p.actions).toHaveLength(1);
    s.view.unmount();
  });

  it("a release after the tab's layout changed under the drag is refused with a plain reason, nothing sent", async () => {
    const p = await page();
    p.select("host", "w1:p1");
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p2"), "w1:p1");
    const s = p.mountSplit();
    s.press();
    p.fire("pointermove", { clientX: 650, clientY: 100 });
    // Herdr's layout changes meanwhile: the second side is another pane now.
    p.layout("host", pair("w1:t1", "w1:p1", "w1:p9"), "w1:p1");
    p.fire("pointerup", { clientX: 650, clientY: 100 });
    expect(p.actions).toEqual([]);
    expect(String(p.notice())).toMatch(/^Not resized: /);
    expect(p.dragListeners()).toBe(0);
    s.view.unmount();
  });

  it("a delivered rearrangement with the panes' order kept: the release is refused, nothing sent", async () => {
    const p = await page();
    p.select("host", "w1:p5");
    p.layout("host", four(), "w1:p5");
    const s = p.mountSplit();
    s.pressOn("split_1_0", 100, 400);
    // Herdr's TUI exchanges p6 and p8; the layout's pane list and split ids are as before.
    p.layout("host", four(true), "w1:p5");
    p.fire("pointerup", { clientX: 100, clientY: 500 });
    await Promise.resolve();
    expect(p.actions).toEqual([]);
    expect(String(p.notice())).toMatch(/^Not resized: /);
    expect(p.dragListeners()).toBe(0);
    s.view.unmount();
  });

  it("the rearranged layout reaching the view cancels the drag at once: no listeners, no class, the tiles as Herdr has them", async () => {
    const p = await page();
    p.select("host", "w1:p5");
    p.layout("host", four(), "w1:p5");
    const s = p.mountSplit();
    s.pressOn("split_1_0", 100, 400);
    expect(p.dragListeners()).toBe(5);
    p.layout("host", four(true), "w1:p5");
    s.rerender();
    expect(p.dragListeners()).toBe(0);
    expect(p.resizingClasses()).toEqual([]);
    p.fire("pointerup", { clientX: 100, clientY: 500 });
    expect(p.actions).toEqual([]);
    s.view.unmount();
  });

  it("the same arrangement with another ratio keeps the drag; the release names the whole split as it began", async () => {
    const p = await page();
    p.select("host", "w1:p5");
    p.layout("host", four(), "w1:p5");
    const s = p.mountSplit();
    const shape = splitShapeOf(four(), "split_1_0");
    s.pressOn("split_1_0", 100, 400);
    const moved = four();
    p.layout("host", { ...moved, splits: moved.splits.map((split) => (split.id === "split_0_root" ? { ...split, ratio: 0.4 } : split)) }, "w1:p5");
    s.rerender();
    expect(p.dragListeners()).toBe(5);
    p.fire("pointerup", { clientX: 100, clientY: 500 });
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]![1]).toMatchObject({ type: "resize", paneId: "w1:p5", splitId: "split_1_0", path: [false], shape, ratio: 0.625 });
    expect(shape).toBe(JSON.stringify(["split_1_0", "down", "w1:p5", "w1:p6"]));
    s.view.unmount();
  });
});
