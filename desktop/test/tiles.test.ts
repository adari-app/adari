// The tiles. Selecting a pane shows its tab's layout
// with that pane focused (the sidebar marks every pane on screen); each tile
// is a full pane view, Chat or Terminal by the per-pane rule, with its own
// compact composer; the focused tile takes the keys; ⌘1–⌘4 focus a tile in
// Herdr's order and ⌃⌘ arrows move focus to the neighbouring tile; clicking a
// tile focuses it here only (pane.focus is inferred, so nothing is sent).
// A zoomed tab, a one-pane tab and a tab past 4 panes show one pane. Chat
// runs one feed per tile (ChatService slots), each pane's newest update kept.
// The real App, SplitView and tiles run on the small hooks host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoShotPath } from "../src/main/demo/demo-chat";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { HostRegistry } from "../src/main/hosts";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { tileShortcut } from "../src/shared/app-keys";
import type { ChatUpdateEvent, HostView, LayoutUpdateEvent } from "../src/shared/ipc-contract";
import { emptyTimeline } from "../src/shared/chat/model";
import { decideTiles, neighbourTile, tooManyNote, type PaneLayout } from "../src/shared/pane-layout";
import { eventually } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { App } = await import("../src/renderer/App");
const { layoutStore } = await import("../src/renderer/split/layout-store");
const { chatUpdates } = await import("../src/renderer/chat/chat-state");

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

// MARK: - The fixture: tab w1:t1 holds four panes (two agents, two shells), w1:t2 one

const panes = [
  { id: "w1:p1", tab: "w1:t1", agent: "claude" },
  { id: "w1:p2", tab: "w1:t1", agent: "codex" },
  { id: "w1:p3", tab: "w1:t1" },
  { id: "w1:p4", tab: "w1:t1" },
  { id: "w1:p5", tab: "w1:t2", agent: "claude" },
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
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 5, tab_count: 2, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "workers", focused: true, pane_count: 4, agent_status: "idle" },
      { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "solo", focused: false, pane_count: 1, agent_status: "idle" },
    ],
    panes: panes.map((pane, index) => ({
      pane_id: pane.id,
      terminal_id: `term${index}`,
      workspace_id: "w1",
      tab_id: pane.tab,
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

/** The four-panes fixture's shape (two columns, each split down) over w1:p1..p4. */
function fourPanes(options: { zoomed?: boolean; focused?: string } = {}): PaneLayout {
  const focused = options.focused ?? "w1:p1";
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
    focusedPaneId: focused,
    panes: Object.entries(rects).map(([paneId, rect]) => ({ paneId, rect, focused: paneId === focused })),
    splits: [
      { id: "split_0_root", direction: "right", ratio: 0.5, rect: area },
      { id: "split_1_0", direction: "down", ratio: 0.5, rect: { x: 0, y: 0, width: 67, height: 45 } },
      { id: "split_2_1", direction: "down", ratio: 0.5, rect: { x: 67, y: 0, width: 67, height: 45 } },
    ],
    zoomed: options.zoomed ?? false,
  };
}

/** Five panes in the tab (Herdr lets a tab hold more than the desktop shows). */
function fivePanes(): PaneLayout {
  const four = fourPanes();
  return {
    ...four,
    panes: [
      ...four.panes.map((pane) => (pane.paneId === "w1:p4" ? { ...pane, rect: { x: 67, y: 23, width: 34, height: 22 } } : pane)),
      { paneId: "w1:p9", rect: { x: 101, y: 23, width: 33, height: 22 }, focused: false },
    ],
    splits: [...four.splits, { id: "split_3_1", direction: "right", ratio: 0.5, rect: { x: 67, y: 23, width: 67, height: 22 } }],
  };
}

// MARK: - The window

interface Key {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const one = (tree: unknown, name: string) => named(tree, name)[0];

interface TileEntryProps {
  paneId: string;
  index: number;
  view: string;
  row: { paneID: string; isAgent: boolean } | null;
}
interface SplitProps {
  tiles: TileEntryProps[];
  focusedPaneId: string;
  focusSignal: number;
  onFocus(paneId: string, keys: boolean): void;
  onView(paneId: string, view: string): void;
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  layoutStore.reset();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function window_(platform: "darwin" | "linux" = "darwin") {
  const storage = new MemoryStorage();
  const watched: [string | null, string | null][] = [];
  const sent: string[] = [];
  let layoutListener: ((event: LayoutUpdateEvent) => void) | null = null;
  const keyListeners: ((event: unknown) => void)[] = [];
  const bridge = {
    appInfo: async () => ({ version: "0.0.0", platform, demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
    listHosts: async () => [host],
    onHostsChanged: () => () => undefined,
    onAppCommand: () => () => undefined,
    onViewCommand: () => () => undefined,
    ghosttyInfo: async () => ({ shown: false }),
    appCommandDone: () => undefined,
    onChatUpdate: () => () => undefined,
    openChat: () => sent.push("openChat"),
    closeChat: () => sent.push("closeChat"),
    setChatFollowing: () => undefined,
    startCommands: () => Promise.resolve({ status: { type: "absent" }, commands: {}, refused: {} }),
    watchLayout: (hostId: string | null, paneId: string | null) => watched.push([hostId, paneId]),
    onLayoutUpdate: (listener: (event: LayoutUpdateEvent) => void) => {
      layoutListener = listener;
      return () => undefined;
    },
    // Present so a call would show: clicking a tile must not ask Herdr to focus it.
    paneAction: (...args: unknown[]) => {
      sent.push(`paneAction ${JSON.stringify(args)}`);
      return Promise.resolve();
    },
  };
  vi.stubGlobal("window", {
    herdrDesktop: bridge,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "keydown") keyListeners.push(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      const at = keyListeners.indexOf(listener);
      if (type === "keydown" && at >= 0) keyListeners.splice(at, 1);
    },
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: new Promise(() => undefined) }, querySelector: () => null });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  cleanup = () => app.unmount();
  const split = () => one(app.tree, "SplitView")?.props as unknown as SplitProps | undefined;
  return {
    app,
    storage,
    watched,
    sent,
    select: (paneId: string) => (one(app.tree, "Sidebar")!.props["onSelect"] as (h: string, p: string) => void)("host", paneId),
    layout: (layout: PaneLayout | null, paneId = "w1:p1", error: string | null = null) =>
      layoutListener!({ hostId: "host", paneId, tabId: layout?.tabId ?? null, layout, error }),
    split,
    main: () => one(app.tree, "MainPane")?.props as { row: { paneID: string }; note?: string | null; zoomed?: boolean } | undefined,
    sidebar: () => one(app.tree, "Sidebar")!.props as { selectedKey: string | null; shownKeys?: ReadonlySet<string> },
    key: (key: Key) => {
      const event = {
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...key,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      for (const listener of keyListeners.slice()) listener(event);
      return event;
    },
  };
}

describe("selecting a pane shows its tab's tiles", () => {
  it("lays out the tab Herdr gave with the selected pane focused; the sidebar marks every pane on screen", async () => {
    const w = await window_();
    w.select("w1:p1");
    expect(w.watched.at(-1)).toEqual(["host", "w1:p1"]);
    // Until the layout comes, the pane alone.
    expect(w.main()?.row.paneID).toBe("w1:p1");
    w.layout(fourPanes());
    const split = w.split()!;
    expect(split).toBeDefined();
    expect(w.main()).toBeUndefined();
    expect(split.tiles.map((tile) => tile.paneId)).toEqual(["w1:p1", "w1:p2", "w1:p3", "w1:p4"]);
    expect(split.tiles.map((tile) => tile.index)).toEqual([0, 1, 2, 3]);
    expect(split.focusedPaneId).toBe("w1:p1");
    expect(w.sidebar().selectedKey).toBe("host/w1:p1");
    expect(Array.from(w.sidebar().shownKeys ?? []).sort()).toEqual(["host/w1:p1", "host/w1:p2", "host/w1:p3", "host/w1:p4"]);
  });

  it("a tab Herdr zoomed shows its zoomed pane: selection, sidebar marks, view and reader follow it, also a zoom from Herdr's TUI", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.layout(fourPanes());
    expect(w.split()?.tiles).toHaveLength(4);
    // Herdr's TUI zooms w1:p3 (a shell): the layout update says so.
    w.layout(fourPanes({ zoomed: true, focused: "w1:p3" }));
    expect(w.split()).toBeUndefined();
    expect(w.main()?.row.paneID).toBe("w1:p3");
    expect(w.main()?.zoomed).toBe(true);
    expect(w.sidebar().selectedKey).toBe("host/w1:p3");
    expect(Array.from(w.sidebar().shownKeys ?? [])).toEqual(["host/w1:p3"]);
    // The window now watches the zoomed pane, and its view is the shell's (Terminal).
    expect(w.watched.at(-1)).toEqual(["host", "w1:p3"]);
    expect((w.main() as unknown as { tab: string }).tab).toBe("terminal");
    // Selecting another pane of the zoomed tab still shows the zoomed one.
    w.select("w1:p2");
    w.layout(fourPanes({ zoomed: true, focused: "w1:p3" }), "w1:p2");
    expect(w.main()?.row.paneID).toBe("w1:p3");
    expect(w.sidebar().selectedKey).toBe("host/w1:p3");
    // Unzoom asks Herdr about the zoomed pane.
    (one(w.app.tree, "MainPane")!.props["onUnzoom"] as () => void)();
    await Promise.resolve();
    expect(w.sent.filter((line) => line.startsWith("paneAction")).at(-1)).toContain('"type":"zoom","paneId":"w1:p3","zoomed":false');
    // Herdr unzooms: the tiles come back with the zoomed pane focused.
    w.layout(fourPanes({ focused: "w1:p3" }), "w1:p3");
    expect(w.split()?.tiles).toHaveLength(4);
    expect(w.split()?.focusedPaneId).toBe("w1:p3");
  });

  it("selecting another pane of the shown tab keeps the tiles and moves the focus", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.layout(fourPanes());
    w.select("w1:p4");
    expect(w.split()?.focusedPaneId).toBe("w1:p4");
    expect(w.sidebar().selectedKey).toBe("host/w1:p4");
    expect(w.sidebar().shownKeys?.size).toBe(4);
  });

  it("shows one pane for a one-pane tab, a zoomed tab and a tab past 4 panes (with the quiet line)", async () => {
    const w = await window_();
    w.select("w1:p5");
    w.layout({ ...fourPanes(), tabId: "w1:t2", panes: [{ paneId: "w1:p5", rect: area, focused: true }], splits: [], focusedPaneId: "w1:p5" }, "w1:p5");
    expect(w.split()).toBeUndefined();
    expect(w.main()?.row.paneID).toBe("w1:p5");
    expect(w.main()?.note ?? null).toBeNull();
    expect(Array.from(w.sidebar().shownKeys ?? [])).toEqual(["host/w1:p5"]);

    w.select("w1:p2");
    w.layout(fourPanes({ zoomed: true, focused: "w1:p2" }), "w1:p2");
    expect(w.split()).toBeUndefined();
    expect(w.main()?.row.paneID).toBe("w1:p2");
    expect(w.main()?.zoomed).toBe(true);

    w.layout(fivePanes(), "w1:p2");
    expect(w.split()).toBeUndefined();
    expect(w.main()?.row.paneID).toBe("w1:p2");
    expect(w.main()?.note).toBe(tooManyNote(5));
    expect(w.main()?.note).toBe("This tab has 5 panes; Adari shows up to 4. Zoom or close one in Herdr.");
  });

  it("ignores a layout of another tab (a pane of another tab was selected since)", async () => {
    const w = await window_();
    w.select("w1:p5");
    w.layout(fourPanes());
    expect(w.split()).toBeUndefined();
    expect(w.main()?.row.paneID).toBe("w1:p5");
  });
});

describe("each tile is a full pane view", () => {
  // A shell tile has no switch; it always shows its terminal.
  it("opens agents in Chat and shells in Terminal, and keeps an agent's pick per pane", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.layout(fourPanes());
    expect(w.split()!.tiles.map((tile) => tile.view)).toEqual(["chat", "chat", "terminal", "terminal"]);
    w.split()!.onView("w1:p3", "chat");
    w.split()!.onView("w1:p2", "terminal");
    expect(w.split()!.tiles.map((tile) => tile.view)).toEqual(["chat", "terminal", "terminal", "terminal"]);
    // The agent pane's pick is kept across restarts (the Swift key); a shell's is not a pick.
    expect(JSON.parse(w.storage.getItem("adari.chat.paneModes") ?? "{}")).toEqual({ "host|w1:p2": "terminal" });
    // Away to another tab and back: the pick still holds.
    w.select("w1:p5");
    w.select("w1:p1");
    expect(w.split()!.tiles.map((tile) => tile.view)).toEqual(["chat", "terminal", "terminal", "terminal"]);
  });

  it("gives each tile its own header, view and composer; the focused one takes the keys", async () => {
    const { SplitView } = await import("../src/renderer/split/SplitView");
    const w = await window_();
    w.select("w1:p1");
    w.layout(fourPanes());
    const view = new HookHost(SplitView as (props: object) => unknown, one(w.app.tree, "SplitView")!.props);
    view.render();
    const tiles = named(view.tree, "Tile");
    expect(tiles.map((tile) => tile.props["focused"])).toEqual([true, false, false, false]);
    const tileOf = (index: number) => {
      const host_ = new HookHost(tiles[index]!.type as (props: object) => unknown, tiles[index]!.props);
      host_.render();
      return host_;
    };
    // The focused Chat tile: the transcript, and its compact composer taking the keys.
    const chat = tileOf(0);
    expect(one(chat.tree, "ChatView")?.props["row"]).toMatchObject({ paneID: "w1:p1" });
    const composer = one(chat.tree, "Composer")!.props;
    expect(composer["compact"]).toBe(true);
    expect(composer["takesKeys"]).toBe(true);
    // A Chat tile not focused: its composer waits.
    expect(one(tileOf(1).tree, "Composer")!.props["takesKeys"]).toBe(false);
    // A Terminal tile not focused: the terminal does not take the keys.
    const terminal = tileOf(2);
    expect(one(terminal.tree, "TerminalTab")?.props["autoFocus"]).toBe(false);
    expect(one(terminal.tree, "Composer")).toBeUndefined();
    // The slim header: the number and the name; a shell's tile has no switch and no drawer button.
    const header = elements(terminal.tree).filter((element) => element.props["aria-pressed"] !== undefined);
    expect(header).toEqual([]);
    // An agent's tile (w1:p2 is Codex's): Chat, the agent's own screen (named for it), Changes, and its drawer button.
    const agentHeader = elements(tileOf(1).tree).filter((element) => element.props["aria-pressed"] !== undefined);
    expect(agentHeader.map((button) => [button.props["aria-label"], button.props["aria-pressed"]])).toEqual([
      ["Chat", true],
      ["Codex", false],
      ["Changes", false],
      [expect.stringMatching(/^Terminal drawer for /), false],
    ]);
    view.unmount();
  });

  it("focuses a clicked tile here only: the selection moves, nothing is sent to Herdr", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.layout(fourPanes());
    const signal = w.split()!.focusSignal;
    w.split()!.onFocus("w1:p3", false);
    expect(w.split()!.focusedPaneId).toBe("w1:p3");
    expect(w.sidebar().selectedKey).toBe("host/w1:p3");
    // A click on the tile's own field keeps where the user clicked; a click elsewhere on it hands it the keys.
    expect(w.split()!.focusSignal).toBe(signal);
    w.split()!.onFocus("w1:p4", true);
    expect(w.split()!.focusSignal).toBe(signal + 1);
    expect(w.sent.filter((call) => call.startsWith("paneAction"))).toEqual([]);
  });
});

describe("keys that move between tiles", () => {
  it("⌘1–⌘4 focus a tile in Herdr's order; ⌃⌘ arrows move focus to the neighbouring tile", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.layout(fourPanes());
    const signal = w.split()!.focusSignal;
    const three = w.key({ key: "3", metaKey: true });
    expect(three.preventDefault).toHaveBeenCalled();
    expect(w.split()!.focusedPaneId).toBe("w1:p3");
    expect(w.split()!.focusSignal).toBe(signal + 1);
    w.key({ key: "4", metaKey: true });
    expect(w.split()!.focusedPaneId).toBe("w1:p4");
    w.key({ key: "ArrowLeft", metaKey: true, ctrlKey: true });
    expect(w.split()!.focusedPaneId).toBe("w1:p2");
    w.key({ key: "ArrowUp", metaKey: true, ctrlKey: true });
    expect(w.split()!.focusedPaneId).toBe("w1:p1");
    // No tile above: the focus stays, the key is still the window's.
    const none = w.key({ key: "ArrowUp", metaKey: true, ctrlKey: true });
    expect(none.preventDefault).toHaveBeenCalled();
    expect(w.split()!.focusedPaneId).toBe("w1:p1");
    w.key({ key: "ArrowRight", metaKey: true, ctrlKey: true });
    expect(w.split()!.focusedPaneId).toBe("w1:p3");
    w.key({ key: "ArrowDown", metaKey: true, ctrlKey: true });
    expect(w.split()!.focusedPaneId).toBe("w1:p4");
    // Past the tiles shown: not a tile key.
    const five = w.key({ key: "5", metaKey: true });
    expect(five.preventDefault).not.toHaveBeenCalled();
    expect(w.sidebar().selectedKey).toBe("host/w1:p4");
  });

  it("leaves ⌘1–⌘4 alone while one pane shows", async () => {
    const w = await window_();
    w.select("w1:p5");
    const two = w.key({ key: "2", metaKey: true });
    expect(two.preventDefault).not.toHaveBeenCalled();
    expect(w.sidebar().selectedKey).toBe("host/w1:p5");
  });

  it("reads the keys per platform", () => {
    const key = (k: Key) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k });
    expect(tileShortcut(key({ key: "1", metaKey: true }), true)).toEqual({ type: "tile", index: 0 });
    expect(tileShortcut(key({ key: "4", metaKey: true }), true)).toEqual({ type: "tile", index: 3 });
    expect(tileShortcut(key({ key: "5", metaKey: true }), true)).toBeNull();
    expect(tileShortcut(key({ key: "1", metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(tileShortcut(key({ key: "1", ctrlKey: true }), true)).toBeNull();
    expect(tileShortcut(key({ key: "ArrowLeft", metaKey: true, ctrlKey: true }), true)).toEqual({ type: "move", direction: "left" });
    expect(tileShortcut(key({ key: "ArrowDown", metaKey: true, ctrlKey: true }), true)).toEqual({ type: "move", direction: "down" });
    expect(tileShortcut(key({ key: "ArrowLeft", metaKey: true }), true)).toBeNull();
    // Elsewhere: Ctrl+1–4, Ctrl+Alt arrows.
    expect(tileShortcut(key({ key: "2", ctrlKey: true }), false)).toEqual({ type: "tile", index: 1 });
    expect(tileShortcut(key({ key: "ArrowUp", ctrlKey: true, altKey: true }), false)).toEqual({ type: "move", direction: "up" });
    expect(tileShortcut(key({ key: "2", metaKey: true }), false)).toBeNull();
  });

  it("finds the neighbouring tile as Herdr moves focus", () => {
    const decision = decideTiles(fourPanes(), "w1:p1");
    if (decision.kind !== "tiles") throw new Error("expected tiles");
    const tiles = decision.tiles;
    expect(neighbourTile(tiles, "w1:p1", "right")).toBe("w1:p3");
    expect(neighbourTile(tiles, "w1:p1", "down")).toBe("w1:p2");
    expect(neighbourTile(tiles, "w1:p1", "left")).toBeNull();
    expect(neighbourTile(tiles, "w1:p1", "up")).toBeNull();
    expect(neighbourTile(tiles, "w1:p4", "left")).toBe("w1:p2");
    expect(neighbourTile(tiles, "w1:p4", "up")).toBe("w1:p3");
    // Three panes: the left column is one tall pane; from it, right goes to the top one of the right column.
    const three: PaneLayout = {
      ...fourPanes(),
      panes: [
        { paneId: "w1:p1", rect: { x: 0, y: 0, width: 67, height: 45 }, focused: true },
        { paneId: "w1:p3", rect: { x: 67, y: 0, width: 67, height: 23 }, focused: false },
        { paneId: "w1:p4", rect: { x: 67, y: 23, width: 67, height: 22 }, focused: false },
      ],
      splits: [fourPanes().splits[0]!, { id: "split_1_1", direction: "down", ratio: 0.5, rect: { x: 67, y: 0, width: 67, height: 45 } }],
    };
    const threeDecision = decideTiles(three, "w1:p1");
    if (threeDecision.kind !== "tiles") throw new Error("expected tiles");
    expect(neighbourTile(threeDecision.tiles, "w1:p1", "right")).toBe("w1:p3");
    expect(neighbourTile(threeDecision.tiles, "w1:p4", "left")).toBe("w1:p1");
  });
});

// MARK: - One Chat feed per tile

class Page implements ChatOwner {
  readonly updates: ChatUpdateEvent[] = [];
  constructor(readonly id: number) {}
  send(_channel: string, payload: ChatUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return false;
  }
  lastFor(paneId: string): ChatUpdateEvent | undefined {
    return this.updates.filter((update) => update.paneId === paneId).at(-1);
  }
}

describe("Chat in tiles", () => {
  it("follows two panes in one window, each in its own slot; closing one keeps the other", async () => {
    const registry = new HostRegistry(() => undefined);
    const fixtures = bundledFixturesForTests();
    for (const demo of demoHosts(fixtures, Date.now())) registry.add(demo.descriptor, new DemoBackend(demo, fixtures));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const page = new Page(1);
    service.open(page, demoHostIds.macMini, "w7:p1G", "host/w7:p1G");
    service.open(page, demoHostIds.macMini, "w7:p1H", "host/w7:p1H");
    await eventually(() => page.lastFor("w7:p1G")?.state.status === "live" && page.lastFor("w7:p1H")?.state.status === "live");
    // The picture is in p1G's transcript: it is read while that tile's Chat shows it.
    expect((await service.image(page, demoShotPath))?.startsWith("data:image/png")).toBe(true);
    service.close(page, "host/w7:p1G");
    expect(await service.image(page, demoShotPath)).toBeNull();
    // p1H still follows: a new line shows.
    const backend = registry.backend(demoHostIds.macMini) as DemoBackend;
    const before = page.lastFor("w7:p1H")!.timeline.turns.length;
    const closedCount = page.updates.filter((update) => update.paneId === "w7:p1G").length;
    backend.transcripts().record("w7:p1H", "one more for the second tile", false, Date.now());
    await eventually(() => page.lastFor("w7:p1H")!.timeline.turns.length === before + 1);
    expect(page.updates.filter((update) => update.paneId === "w7:p1G").length).toBe(closedCount);
    // Without a slot the window's one chat (the single pane view).
    service.open(page, demoHostIds.macMini, "w7:p1G");
    await eventually(() => page.lastFor("w7:p1G")?.state.status === "live");
    // close() with no slot ends every chat of the window.
    service.close(page);
    const count = page.updates.length;
    backend.transcripts().record("w7:p1H", "nobody follows this", false, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(page.updates.length).toBe(count);
    service.closeAll();
    registry.close();
  });

  it("keeps each pane's newest update on the page", () => {
    let listener: ((event: ChatUpdateEvent) => void) | null = null;
    chatUpdates.attach({
      onChatUpdate: (next: (event: ChatUpdateEvent) => void) => {
        listener = next;
        return () => undefined;
      },
    } as never);
    const live = { status: "live" } as const;
    // Each tile's Chat follows its pane (updates are kept only for the Chats followed now).
    const p1 = chatUpdates.follow("host", "w1:p1");
    const p2 = chatUpdates.follow("host", "w1:p2");
    listener!({ hostId: "host", paneId: "w1:p1", state: live, timeline: emptyTimeline, follow: p1 });
    listener!({ hostId: "host", paneId: "w1:p2", state: { status: "loading" }, timeline: emptyTimeline, follow: p2 });
    listener!({ hostId: "host", paneId: "w1:p3", state: live, timeline: emptyTimeline });
    expect(chatUpdates.forPane("host", "w1:p1")?.state).toEqual(live);
    expect(chatUpdates.forPane("host", "w1:p2")?.state).toEqual({ status: "loading" });
    expect(chatUpdates.forPane("host", "w1:p3")).toBeNull();
    chatUpdates.unfollow("host", "w1:p1", p1);
    expect(chatUpdates.forPane("host", "w1:p1")).toBeNull();
    chatUpdates.unfollow("host", "w1:p2", p2);
  });
});
