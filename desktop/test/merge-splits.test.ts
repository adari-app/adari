// Split tiles together with the features around them. An agent tile's header
// has Changes beside
// Chat and Terminal, one tile of a tab at a time (a window has one Changes
// read), and ⌃⌘C on the focused tile keeps changes' covered rule; a tile's
// box is the composer with its paperclip, picker and drop, and
// its Send is the bound Send; a Send to… into a tile showing Changes
// lands in its Chat; and Edit machine is a new entry for
// splits' pane bindings. The real App, Tile and Composer on the hooks host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import type { AppCommand, HostView, LayoutUpdateEvent, MainTab } from "../src/shared/ipc-contract";
import type { PaneLayout } from "../src/shared/pane-layout";
import type { SidebarRow } from "../src/shared/sidebar-model";
import type { ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements, find } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { App, oneChangesTile } = await import("../src/renderer/App");
const { Tile } = await import("../src/renderer/split/SplitView");
const { layoutStore } = await import("../src/renderer/split/layout-store");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");

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

// Tab w1:t1: two agents (p1, p2) and two shells (p3, p4).
const panes = [
  { id: "w1:p1", agent: "claude" },
  { id: "w1:p2", agent: "codex" },
  { id: "w1:p3" },
  { id: "w1:p4" },
];

const host: HostView = {
  id: "host",
  name: "Mac mini",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state: "connected",
  error: null,
  fetchedAtMs: 0,
  topology: decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 4, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "workers", focused: true, pane_count: 4, agent_status: "idle" }],
    panes: panes.map((pane, index) => ({
      pane_id: pane.id,
      terminal_id: `term${index}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      cwd: "/fixture",
      ...(pane.agent === undefined ? {} : { agent: pane.agent }),
      agent_status: pane.agent === undefined ? "unknown" : "idle",
      revision: 1,
    })),
    layouts: [],
    agents: panes.filter((pane) => pane.agent !== undefined).map((pane) => ({ pane_id: pane.id, agent: pane.agent, agent_status: "idle" })),
  }),
};

const area = { x: 0, y: 0, width: 134, height: 45 };

function fourPanes(): PaneLayout {
  const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
    "w1:p1": { x: 0, y: 0, width: 67, height: 23 },
    "w1:p2": { x: 0, y: 23, width: 67, height: 22 },
    "w1:p3": { x: 67, y: 0, width: 67, height: 23 },
    "w1:p4": { x: 67, y: 23, width: 67, height: 22 },
  };
  return {
    tabId: "w1:t1",
    workspaceId: "w1",
    area,
    focusedPaneId: "w1:p1",
    panes: Object.entries(rects).map(([paneId, rect]) => ({ paneId, rect, focused: paneId === "w1:p1" })),
    splits: [
      { id: "split_0_root", direction: "right", ratio: 0.5, rect: area },
      { id: "split_1_0", direction: "down", ratio: 0.5, rect: { x: 0, y: 0, width: 67, height: 45 } },
      { id: "split_2_1", direction: "down", ratio: 0.5, rect: { x: 67, y: 0, width: 67, height: 45 } },
    ],
    zoomed: false,
  };
}

const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const one = (tree: unknown, name: string) => named(tree, name)[0];

interface TileEntryProps {
  paneId: string;
  view: MainTab;
  row: SidebarRow | null;
}
interface SplitProps {
  tiles: TileEntryProps[];
  focusedPaneId: string;
  onFocus(paneId: string, keys: boolean): void;
  onView(paneId: string, view: MainTab): void;
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  layoutStore.reset();
  composerDrafts.clear();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

async function window_() {
  const storage = new MemoryStorage();
  let layoutListener: ((event: LayoutUpdateEvent) => void) | null = null;
  let view: (command: ViewCommand) => void = () => undefined;
  let command: (command: AppCommand) => void = () => undefined;
  const bridge = {
    appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
    listHosts: async () => [host],
    onHostsChanged: () => () => undefined,
    onAppCommand: (listener: (c: AppCommand) => void) => {
      command = listener;
      return () => undefined;
    },
    onViewCommand: (listener: (c: ViewCommand) => void) => {
      view = listener;
      return () => undefined;
    },
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
    paneAction: () => Promise.resolve(),
    awayState: async () => ({ building: false, digest: null }),
    onAwayUpdate: () => () => undefined,
    onSearchUpdate: () => () => undefined,
    copyText: () => undefined,
  };
  vi.stubGlobal("window", {
    herdrDesktop: bridge,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: new Promise(() => undefined) }, querySelector: () => null });
  vi.stubGlobal("requestAnimationFrame", (run: (time: number) => void) => {
    run(0);
    return 0;
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  await flush();
  cleanup = () => app.unmount();
  const split = () => one(app.tree, "SplitView")?.props as unknown as SplitProps | undefined;
  const viewOf = (paneId: string) => split()!.tiles.find((tile) => tile.paneId === paneId)!.view;
  return {
    app,
    split,
    viewOf,
    views: () => Object.fromEntries(split()!.tiles.map((tile) => [tile.paneId, tile.view])),
    select: (paneId: string) => (one(app.tree, "Sidebar")!.props["onSelect"] as (h: string, p: string) => void)("host", paneId),
    layout: (layout: PaneLayout, paneId = "w1:p1") => layoutListener!({ hostId: "host", paneId, tabId: layout.tabId, layout, error: null }),
    /** A click on a tile's segment: its mousedown focuses the tile first, as SplitView's Tile does. */
    pickOn: (paneId: string, next: MainTab) => {
      if (split()!.focusedPaneId !== paneId) split()!.onFocus(paneId, false);
      split()!.onView(paneId, next);
    },
    view: (c: ViewCommand) => view(c),
    command: (c: AppCommand) => command(c),
  };
}

async function tiles() {
  const w = await window_();
  w.select("w1:p1");
  w.layout(fourPanes());
  expect(w.split()?.tiles).toHaveLength(4);
  return w;
}

describe("Changes in a tile", () => {
  it("is an agent tile's third view; picking it on another tile moves the first back to Chat", async () => {
    const w = await tiles();
    expect(w.views()).toEqual({ "w1:p1": "chat", "w1:p2": "chat", "w1:p3": "terminal", "w1:p4": "terminal" });
    w.pickOn("w1:p1", "changes");
    expect(w.viewOf("w1:p1")).toBe("changes");
    w.pickOn("w1:p2", "changes");
    expect(w.views()).toEqual({ "w1:p1": "chat", "w1:p2": "changes", "w1:p3": "terminal", "w1:p4": "terminal" });
    // The demoted pick is kept: the first tile shows Chat after the second leaves Changes.
    w.pickOn("w1:p2", "terminal");
    expect(w.views()).toEqual({ "w1:p1": "chat", "w1:p2": "terminal", "w1:p3": "terminal", "w1:p4": "terminal" });
  });

  it("⌃⌘C on the focused tile goes to Changes and back to the view it covered", async () => {
    const w = await tiles();
    w.pickOn("w1:p2", "terminal");
    w.view("toggle-changes");
    expect(w.viewOf("w1:p2")).toBe("changes");
    w.view("toggle-changes");
    expect(w.viewOf("w1:p2")).toBe("terminal");
    // Changes picked from the tile's segment covers the Terminal too, so ⌃⌘C goes back to it.
    w.pickOn("w1:p2", "changes");
    w.view("toggle-changes");
    expect(w.viewOf("w1:p2")).toBe("terminal");
    // A shell's tile ignores it.
    w.pickOn("w1:p3", "terminal");
    w.view("toggle-changes");
    expect(w.viewOf("w1:p3")).toBe("terminal");
  });

  it("a Send to… into a tile showing Changes lands in its Chat, where the draft shows", async () => {
    const w = await tiles();
    w.pickOn("w1:p2", "changes");
    w.pickOn("w1:p3", "terminal");
    w.command({ id: "h1", type: "open-handoff", hostId: "host", paneId: "w1:p3", text: "the build is green" });
    w.command({ id: "h2", type: "pick-handoff", hostId: "host", paneId: "w1:p2", action: "draft" });
    await flush();
    expect(w.split()!.focusedPaneId).toBe("w1:p2");
    expect(w.viewOf("w1:p2")).toBe("chat");
    expect(composerDrafts.get(draftKey("host", "w1:p2")).text).toContain("the build is green");
  });

  it("shows at most one tile in Changes, the focused one first (picks restored from an earlier run)", () => {
    const row = { isAgent: true } as SidebarRow;
    const entries = ["a", "b", "c"].map((paneId) => ({ paneId, index: 0, frame: { left: 0, top: 0, width: 1, height: 1 }, row, view: "changes" as MainTab }));
    expect(oneChangesTile(entries, "b").map((entry) => entry.view)).toEqual(["chat", "changes", "chat"]);
    expect(oneChangesTile(entries, "z").map((entry) => entry.view)).toEqual(["changes", "chat", "chat"]);
    const shell = { ...entries[0]!, row: { isAgent: false } as SidebarRow, view: "changes" as MainTab };
    expect(oneChangesTile([shell, entries[1]!], "a").map((entry) => entry.view)).toEqual(["chat", "changes"]);
  });
});

describe("a tile on the hooks host", () => {
  const rowOf = (paneID: string, isAgent: boolean): SidebarRow =>
    ({ paneID, name: paneID, kind: isAgent ? "claude" : "shell", isAgent, glyph: "idle", status: "idle", cwd: "/fixture", workspaceLabel: "app" }) as unknown as SidebarRow;
  const sends: unknown[][] = [];

  function tile(paneId: string, isAgent: boolean, view: MainTab) {
    sends.length = 0;
    vi.stubGlobal("window", {
      herdrDesktop: {
        startCommands: () => Promise.resolve({ status: { type: "absent" }, commands: {}, refused: {} }),
        sendToPane: (...args: unknown[]) => {
          sends.push(args);
          return Promise.resolve();
        },
      },
      innerHeight: 900,
    });
    const views: [string, MainTab][] = [];
    const none = (): undefined => undefined;
    const ui = new HookHost(Tile as (props: object) => unknown, {
      host,
      entry: { paneId, index: 0, frame: { left: 0, top: 0, width: 1, height: 1 }, row: rowOf(paneId, isAgent), view },
      focused: true,
      focusSignal: 0,
      fontSize: 13,
      boxShown: false,
      onBoxShown: none,
      onFocus: none,
      onView: (p: string, v: MainTab) => views.push([p, v]),
      onZoom: none,
      onClose: none,
      onSplitMenu: none,
    });
    ui.render();
    const segment = () => elements(ui.tree).filter((e) => e.type === "button" && ["Chat", "Terminal", "Claude Code", "Changes"].includes(String(e.props["aria-label"])));
    return { ui, views, segment };
  }

  // The middle tab names the agent's own screen; a shell has no switch at all.
  it("an agent's header has Chat, its own screen and Changes; a shell's has no switch", () => {
    const agent = tile("w1:p1", true, "chat");
    expect(agent.segment().map((e) => e.props["aria-label"])).toEqual(["Chat", "Claude Code", "Changes"]);
    expect(agent.segment()[1]!.props["title"]).toBe("Claude Code's own screen");
    (agent.segment()[2]!.props["onClick"] as () => void)();
    expect(agent.views).toEqual([["w1:p1", "changes"]]);
    agent.ui.unmount();
    const shell = tile("w1:p3", false, "changes");
    expect(shell.segment()).toEqual([]);
    // A shell's Changes pick shows its terminal (Changes' shownTab).
    expect(one(shell.ui.tree, "TerminalTab")).toBeDefined();
    expect(one(shell.ui.tree, "ChangesView")).toBeUndefined();
    shell.ui.unmount();
  });

  it("Changes shows the agent's ChangesView, for its pane, folder and machine", () => {
    const t = tile("w1:p1", true, "changes");
    const view = one(t.ui.tree, "ChangesView")!;
    expect(view.props).toMatchObject({ hostId: "host", paneId: "w1:p1", kind: "claude", folder: "/fixture", online: true });
    expect(one(t.ui.tree, "ChatView")).toBeUndefined();
    expect(one(t.ui.tree, "Composer"), "Changes has no message box").toBeUndefined();
    t.ui.unmount();
  });

  it("Chat is the tile's own feed over the composer, with its paperclip, picker and drop, and the bound Send", async () => {
    const t = tile("w1:p1", true, "chat");
    expect(one(t.ui.tree, "ChatView")!.props["tile"]).toBe(true);
    const composer = one(t.ui.tree, "Composer")!;
    expect(composer.props).toMatchObject({ compact: true, takesKeys: true });
    const box = new HookHost(composer.type as (props: object) => unknown, composer.props);
    box.render();
    const wrap = elements(box.tree).find((e) => e.type === "div" && String(e.props["className"]).startsWith("cmp-wrap"))!;
    expect(wrap.props["className"]).toBe("cmp-wrap compact");
    expect(typeof wrap.props["onDrop"]).toBe("function");
    expect(typeof wrap.props["onDragOver"]).toBe("function");
    const clip = elements(box.tree).find((e) => e.type === "button" && e.props["aria-label"] === "Attach files");
    expect(clip?.props["title"]).toBe("Attach images or files");
    expect(elements(box.tree).find((e) => e.type === "input" && e.props["type"] === "file")).toBeDefined();
    const field = find(box.tree, "textarea")!;
    (field.props["onChange"] as (e: unknown) => void)({ target: { value: "hello" } });
    box.render();
    (find(box.tree, "textarea")!.props["onKeyDown"] as (e: unknown) => void)({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => undefined,
    });
    await flush();
    expect(sends).toEqual([["host", "w1:p1", "hello", { terminalID: "term0", isAgent: true, kind: "claude", session: null }]]);
    box.unmount();
    t.ui.unmount();
  });
});

describe("an edited machine and splits' pane bindings", () => {
  const session = "0f2c9a6e-3b1d-4c5e-8f7a-9b0c1d2e3f4a";
  const backend = () => ({ snapshot: () => Promise.resolve(paneTopology([{ id: "p1", agent: "claude", session }])), close: () => undefined });
  const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "robin@mini.invalid:22", platform: null };

  it("is a new entry: a new incarnation and a new connection, so a binding taken before the edit no longer holds", async () => {
    const registry = new HostRegistry(() => undefined);
    registry.add(descriptor, backend() as unknown as HerdrHostBackend);
    await registry.refresh("mini");
    const before = registry.list()[0]!;
    const identity = registry.connectionIdentity("mini")!;
    registry.replace(descriptor, backend() as unknown as HerdrHostBackend);
    expect(registry.connection("mini"), "no connection until the new backend answers").toBeNull();
    await registry.refresh("mini");
    const after = registry.list()[0]!;
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(after.connection).not.toBe(before.connection);
    // The demo-like backend has no epochs (0 for its life), so only the incarnation tells the two apart.
    expect(registry.connectionIdentity("mini")).toEqual({ incarnation: after.incarnation, epoch: identity.epoch });
    expect(registry.connectionIdentity("mini")).not.toEqual(identity);
    registry.close();
  });
});
