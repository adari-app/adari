// The pane switch's words and the terminal
// drawer in the window. The real App, MainPane, SplitView and TerminalDrawer
// run on the small hooks host with a fake bridge: the drawer's shell is
// "made" by a fake openDrawerShell that adds its pane to the machine's next
// snapshot, as Herdr's tab.create would; × closes through paneAction, the
// close confirmation always asking first (Herdr gives no authoritative idle state for a shell).
// The drawer's tabs read Terminal, Terminal 2 by the drawer's
// order, and its shells are no sidebar row, nor in Priority, the footer count,
// search or ⇧⌘J, until their drawer is gone; one that needs you is a dot on its
// owner's drawer button.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { DesktopSidebar } from "../src/shared/desktop-sidebar";
import type { HostView, LayoutUpdateEvent } from "../src/shared/ipc-contract";
import type { PaneLayout } from "../src/shared/pane-layout";
import { terminalDrawersKey } from "../src/shared/terminal-drawer";
import type { ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { App } = await import("../src/renderer/App");
const { MainPane } = await import("../src/renderer/components/MainPane");
const { SplitView } = await import("../src/renderer/split/SplitView");
const { TerminalDrawer } = await import("../src/renderer/terminal/TerminalDrawer");
const { layoutStore } = await import("../src/renderer/split/layout-store");
const { focusReturn } = await import("../src/renderer/components/focus-return");

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

// MARK: - The fixture: one workspace (its folder /code/app), an agent of each kind and a shell, each alone in its tab; tab w1:tS split in two

interface FixturePane {
  readonly id: string;
  readonly tab: string;
  readonly agent?: string;
  /** Its workspace (w1 unless given). */
  readonly ws?: string;
  /** Its agent's status (idle unless given). */
  readonly status?: string;
}

const basePanes: readonly FixturePane[] = [
  { id: "w1:p1", tab: "w1:t1", agent: "claude" },
  { id: "w1:p2", tab: "w1:t2", agent: "codex" },
  { id: "w1:p3", tab: "w1:t3", agent: "grok" },
  { id: "w1:p4", tab: "w1:t4", agent: "cursor" },
  { id: "w1:p5", tab: "w1:t5", agent: "aider" },
  { id: "w1:p6", tab: "w1:t6" },
  { id: "w1:pA", tab: "w1:tS", agent: "claude" },
  { id: "w1:pB", tab: "w1:tS", agent: "claude" },
];

function hostView(panes: readonly FixturePane[], fetchedAtMs = 0): HostView {
  const tabs = [...new Set(panes.map((pane) => pane.tab))];
  const wsOf = (pane: FixturePane | undefined): string => pane?.ws ?? "w1";
  const workspaces = [...new Set(panes.map(wsOf))];
  return {
    id: "host",
    name: "Mac mini",
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    // A connection as main names it, so a close is bound to it (pane-binding.ts).
    connection: 1,
    incarnation: 1,
    epoch: 7,
    fetchedAtMs,
    topology: decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: workspaces.map((ws, index) => ({
        workspace_id: ws,
        number: index + 1,
        label: ws === "w1" ? "app" : ws,
        focused: ws === "w1",
        pane_count: panes.filter((pane) => wsOf(pane) === ws).length,
        tab_count: tabs.filter((tab) => wsOf(panes.find((pane) => pane.tab === tab)) === ws).length,
        active_tab_id: panes.find((pane) => wsOf(pane) === ws)!.tab,
        agent_status: "idle",
      })),
      tabs: tabs.map((tab, index) => ({ tab_id: tab, workspace_id: wsOf(panes.find((pane) => pane.tab === tab)), number: index + 1, label: "", focused: index === 0, pane_count: panes.filter((pane) => pane.tab === tab).length, agent_status: "idle" })),
      panes: panes.map((pane, index) => ({
        pane_id: pane.id,
        terminal_id: `term${String(index)}`,
        workspace_id: wsOf(pane),
        tab_id: pane.tab,
        focused: false,
        cwd: "/code/app",
        ...(pane.agent === undefined ? {} : { agent: pane.agent }),
        agent_status: pane.agent === undefined ? "unknown" : (pane.status ?? "idle"),
        revision: 1,
      })),
      layouts: [],
      agents: panes.filter((pane) => pane.agent !== undefined).map((pane) => ({ pane_id: pane.id, agent: pane.agent, agent_status: pane.status ?? "idle" })),
    }),
  };
}

const splitLayout: PaneLayout = {
  tabId: "w1:tS",
  workspaceId: "w1",
  area: { x: 0, y: 0, width: 120, height: 40 },
  focusedPaneId: "w1:pA",
  panes: [
    { paneId: "w1:pA", rect: { x: 0, y: 0, width: 60, height: 40 }, focused: true },
    { paneId: "w1:pB", rect: { x: 60, y: 0, width: 60, height: 40 }, focused: false },
  ],
  splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 120, height: 40 } }],
  zoomed: false,
};

// MARK: - The window

const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const one = (tree: unknown, name: string) => named(tree, name)[0];
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/** A fake focused element: the message box (a textarea), or a drawer shell's terminal. */
function focusable(kind: "box" | "drawer") {
  const element = {
    tagName: kind === "box" ? "TEXTAREA" : "DIV",
    isConnected: true,
    focus: vi.fn(),
    blur: vi.fn(),
    closest: (selector: string) => (kind === "drawer" && (selector === ".tdr" || selector === ".term-host") ? {} : null),
  };
  return element;
}

let cleanup: (() => void) | null = null;

beforeEach(() => {
  layoutStore.reset();
  focusReturn.reset();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function window_(options: { storage?: MemoryStorage; panes?: readonly FixturePane[]; answer?: Promise<void> } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  // Every row of w1 drawn (more than five: past "Show N more"), so the sidebar's rows can be read whole.
  if (storage.getItem("adari.sidebar.fold") === null) storage.setItem("adari.sidebar.fold", JSON.stringify({ expandedWorkspaces: { host: ["w1"] } }));
  let panes: FixturePane[] = [...basePanes, ...(options.panes ?? [])];
  let hostsListener: ((hosts: HostView[]) => void) | null = null;
  let viewListener: ((command: ViewCommand) => void) | null = null;
  let layoutListener: ((event: LayoutUpdateEvent) => void) | null = null;
  const keyListeners: ((event: unknown) => void)[] = [];
  const opened: { hostId: string; request: { workspaceId: string; folder: string | null } }[] = [];
  const actions: unknown[] = [];
  // A busy door answering "idle", as a screen check would for a Node REPL's "> " or output ending in "$" or "#":
  // × must neither ask it nor trust it.
  const busyAsked: string[] = [];
  let made = 0;
  // Each snapshot carries the time it was read, as main's does.
  const push = (): void => hostsListener?.([hostView(panes, Date.now())]);
  const bridge = {
    appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
    listHosts: async () => [hostView(panes, Date.now())],
    onHostsChanged: (listener: (hosts: HostView[]) => void) => {
      hostsListener = listener;
      return () => undefined;
    },
    onAppCommand: () => () => undefined,
    onViewCommand: (listener: (command: ViewCommand) => void) => {
      viewListener = listener;
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
    // Herdr's tab.create, as main answers it: a shell pane in a tab of its own, in the next snapshot.
    openDrawerShell: async (hostId: string, request: { workspaceId: string; folder: string | null }) => {
      opened.push({ hostId, request });
      made += 1;
      const paneId = `w1:s${String(made)}`;
      const tabId = `w1:ts${String(made)}`;
      panes = [...panes, { id: paneId, tab: tabId }];
      push();
      // As main does: the machine's snapshot listing the new pane is sent before the answer naming it (`answer` holds it).
      await options.answer;
      return { paneId, tabId, folder: request.folder, place: "folder" as const };
    },
    drawerShellBusy: async (_hostId: string, paneId: string) => {
      busyAsked.push(paneId);
      return false;
    },
    paneAction: async (hostId: string, action: { type: string; paneId: string }) => {
      actions.push({ hostId, ...action });
      if (action.type === "close") {
        panes = panes.filter((pane) => pane.id !== action.paneId);
        push();
      }
      return {};
    },
  };
  const doc = {
    activeElement: null as unknown,
    body: { classList: { add: () => undefined, remove: () => undefined } },
    fonts: { ready: new Promise(() => undefined) },
    querySelector: () => null,
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
  vi.stubGlobal("document", doc);
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  await settle();
  cleanup = () => app.unmount();
  const main = () => one(app.tree, "MainPane")?.props as Record<string, unknown> | undefined;
  const drawer = () => (main()?.["drawer"] ?? one(app.tree, "SplitView")?.props["drawer"] ?? null) as {
    state: { open: boolean; shells: { paneId: string }[]; active: string | null; height: number | null };
    shells: { paneId: string; label: string; row: unknown; needsYou?: boolean }[];
    needsYou?: boolean;
    wantsKeys: boolean;
    focusSignal: number;
    onToggle(): void;
    onNewShell(): void;
    onCloseShell(paneId: string): void;
    onEscape(): void;
    onHeight(height: number | null): void;
  } | null;
  return {
    app,
    storage,
    doc,
    opened,
    actions,
    busyAsked,
    panes: () => panes,
    /** Herdr's next snapshot after a change on the machine. */
    update: async (change: (current: FixturePane[]) => FixturePane[]) => {
      panes = change(panes);
      push();
      await settle();
    },
    sidebar: () => one(app.tree, "Sidebar")!.props["sidebar"] as DesktopSidebar,
    select: async (paneId: string) => {
      (one(app.tree, "Sidebar")!.props["onSelect"] as (h: string, p: string) => void)("host", paneId);
      await settle();
    },
    main,
    drawer,
    split: () => one(app.tree, "SplitView")?.props as Record<string, unknown> | undefined,
    layout: async (layout: PaneLayout, paneId: string) => {
      layoutListener!({ hostId: "host", paneId, tabId: layout.tabId, layout, error: null });
      await settle();
    },
    key: async (key: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) => {
      const event = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      for (const listener of keyListeners.slice()) listener(event);
      await settle();
      return event;
    },
    menu: async (command: ViewCommand) => {
      viewListener!(command);
      await settle();
    },
    confirm: () => one(app.tree, "ConfirmClose")?.props as { name: string; body?: string; onConfirm(): void; onCancel(): void } | undefined,
  };
}

/** A component of the tree rendered on its own hooks host. */
function render(element: { type: unknown; props: Record<string, unknown> }) {
  const host = new HookHost(element.type as (props: object) => unknown, element.props);
  host.render();
  return host;
}

/** The words a button shows (its strings and its spans' strings). */
const words = (node: unknown): string =>
  typeof node === "string" ? node : Array.isArray(node) ? node.map(words).join("") : typeof node === "object" && node !== null ? words((node as { props?: { children?: unknown } }).props?.children) : "";

/** The pane switch's buttons in a rendered MainPane: [label, title]. */
function paneSwitch(pane: { readonly tree: unknown }) {
  const seg = elements(pane.tree).find((element) => element.type === "div" && String(element.props["className"]).startsWith("seg sm"));
  if (seg === undefined) return null;
  return elements(seg).filter((element) => element.type === "button").map((button) => [words(button.props.children), button.props["title"] ?? null]);
}

const headerButton = (pane: { readonly tree: unknown }) => elements(pane.tree).find((element) => element.type === "button" && element.props["aria-label"] === "Terminal drawer");

/** The panes the sidebar draws as rows (Projects), every machine. */
const rowsOf = (sidebar: DesktopSidebar): string[] =>
  sidebar.hosts.flatMap((section) => section.model?.projects.flatMap((project) => project.rows.map((row) => row.paneID)) ?? []);
/** A small needs-you dot inside an element. */
const hasDot = (element: unknown): boolean => elements(element).some((child) => child.props?.["className"] === "tdr-ny");

describe("the pane switch", () => {
  it("reads Chat · <the agent's own name> · Changes for each kind, titled its own screen", async () => {
    const w = await window_();
    const expected: [string, string][] = [
      ["w1:p1", "Claude Code"],
      ["w1:p2", "Codex"],
      // The agent's own name comes from agent-names.ts (Herdr's names).
      ["w1:p3", "Grok Build"],
      ["w1:p4", "Cursor Agent"],
      ["w1:p5", "Aider"],
    ];
    for (const [paneId, name] of expected) {
      await w.select(paneId);
      const pane = render({ type: MainPane, props: w.main()! });
      expect(paneSwitch(pane)?.map(([label]) => label), paneId).toEqual(["Chat", name, "Changes"]);
      expect(paneSwitch(pane)?.[1]?.[1]).toBe(`${name}'s own screen`);
      pane.unmount();
    }
    // Its tab keeps "terminal" under the Swift app's key.
    await w.select("w1:p2");
    (w.main()!["onTab"] as (tab: string) => void)("terminal");
    await settle();
    expect(JSON.parse(w.storage.getItem("adari.chat.paneModes")!)).toMatchObject({ "host|w1:p2": "terminal" });
  });

  it("restores an old saved Terminal pick as the agent's own screen", async () => {
    const storage = new MemoryStorage();
    storage.setItem("adari.chat.paneModes", JSON.stringify({ "host|w1:p1": "terminal" }));
    const w = await window_({ storage });
    await w.select("w1:p1");
    expect(w.main()!["tab"]).toBe("terminal");
    const pane = render({ type: MainPane, props: w.main()! });
    const on = elements(pane.tree).find((element) => element.type === "button" && element.props["className"] === "on");
    expect(words(on?.props.children)).toBe("Claude Code");
  });

  it("is not shown on a plain shell pane: its terminal, its message box, no drawer button", async () => {
    const w = await window_();
    await w.select("w1:p6");
    expect(w.main()!["tab"]).toBe("terminal");
    const pane = render({ type: MainPane, props: w.main()! });
    expect(paneSwitch(pane)).toBeNull();
    expect(one(pane.tree, "TerminalTab")).toBeDefined();
    expect(headerButton(pane)).toBeUndefined();
    expect(w.main()!["drawer"] ?? null).toBeNull();
  });
});

describe("the drawer", () => {
  it("⌘J opens it under the pane's view and makes one shell with tab.create's path in the workspace folder; ⌘J again closes it", async () => {
    const w = await window_();
    await w.select("w1:p1");
    expect(w.drawer()!.state.open).toBe(false);
    const event = await w.key("j", { metaKey: true });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(w.drawer()!.state.open).toBe(true);
    expect(w.opened).toEqual([{ hostId: "host", request: { workspaceId: "w1", folder: "/code/app" } }]);
    expect(w.drawer()!.shells.map((shell) => [shell.paneId, shell.label, shell.row !== null])).toEqual([["w1:s1", "Terminal", true]]);
    // The agent's pane, tab and view: untouched (nothing sent for it; Chat still shown above).
    expect(w.actions).toEqual([]);
    expect(w.main()!["tab"]).toBe("chat");
    expect(w.panes().find((pane) => pane.id === "w1:p1")).toEqual({ id: "w1:p1", tab: "w1:t1", agent: "claude" });
    const pane = render({ type: MainPane, props: w.main()! });
    expect(one(pane.tree, "TerminalDrawer")?.props["drawer"]).toBeDefined();
    expect(one(pane.tree, "ChatView")).toBeDefined();
    expect(headerButton(pane)?.props["aria-pressed"]).toBe(true);
    pane.unmount();
    // ⇧⌘J is still the next pane that needs you, not the drawer.
    await w.key("J", { metaKey: true, shiftKey: true });
    expect(w.drawer()?.state.open ?? true).toBe(true);
    await w.select("w1:p1");
    // Past the gate's window, ⌘J again closes it; the shell stays for next time.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.state.open).toBe(false);
    expect(w.drawer()!.state.shells.map((shell) => shell.paneId)).toEqual(["w1:s1"]);
    // Opened again: the same shell, none made.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await w.key("j", { metaKey: true });
    expect(w.opened).toHaveLength(1);
  });

  it("the header button and View › Terminal toggle it too; one press seen by both the menu and the page toggles once", async () => {
    const w = await window_();
    await w.select("w1:p1");
    const pane = render({ type: MainPane, props: w.main()! });
    (headerButton(pane)!.props["onClick"] as () => void)();
    await settle();
    expect(w.drawer()!.state.open).toBe(true);
    await w.menu("toggle-terminal");
    expect(w.drawer()!.state.open).toBe(false);
    // The same ⌘J reaching the page right after the menu: taken once.
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.state.open).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await w.menu("toggle-terminal");
    expect(w.drawer()!.state.open).toBe(true);
  });

  it("\"+\" makes another shell, shown and focused; × always asks first (a shell's screen is no proof it is idle)", async () => {
    const w = await window_();
    await w.select("w1:p1");
    await w.key("j", { metaKey: true });
    const signal = w.drawer()!.focusSignal;
    w.drawer()!.onNewShell();
    await settle();
    expect(w.opened.map((each) => each.request)).toEqual([
      { workspaceId: "w1", folder: "/code/app" },
      { workspaceId: "w1", folder: "/code/app" },
    ]);
    expect(w.drawer()!.shells.map((shell) => shell.label)).toEqual(["Terminal", "Terminal 2"]);
    expect(w.drawer()!.state.active).toBe("w1:s2");
    expect(w.drawer()!.focusSignal).toBeGreaterThan(signal);
    // The drawer's own buttons: New shell, Close shell (the shown one), Hide.
    const drawerUi = render({ type: TerminalDrawer, props: { host: hostView(w.panes()), drawer: w.drawer(), fontSize: 13, mac: true } });
    const button = (label: string) => elements(drawerUi.tree).find((element) => element.type === "button" && element.props["aria-label"] === label)!;
    expect(elements(drawerUi.tree).filter((element) => element.props["role"] === "tab").map((tab) => words(tab.props.children))).toEqual(["Terminal", "Terminal 2"]);
    expect(button("Hide the terminal").props["title"]).toBe("Hide the terminal (⌘J)");
    expect(one(drawerUi.tree, "TerminalTab")?.props["row"]).toMatchObject({ paneID: "w1:s2" });
    // × always asks first: Herdr gives no authoritative idle state for a shell, and its screen is not one (a Node REPL's
    // "> ", output ending in "$" or "#" all look like a prompt). Cancel keeps it; nothing is sent.
    (button("Close shell").props["onClick"] as () => void)();
    await settle();
    drawerUi.unmount();
    expect(w.confirm()).toMatchObject({ name: "Terminal 2", body: "A command may be running in it. Closing the pane in Herdr ends it." });
    w.confirm()!.onCancel();
    await settle();
    expect(w.confirm()).toBeUndefined();
    expect(w.actions).toEqual([]);
    expect(w.drawer()!.state.shells.map((shell) => shell.paneId)).toEqual(["w1:s1", "w1:s2"]);
    // Close: through Herdr (its pane closed), out of the drawer.
    w.drawer()!.onCloseShell("w1:s2");
    await settle();
    w.confirm()!.onConfirm();
    await settle();
    expect(w.actions).toMatchObject([{ hostId: "host", type: "close", paneId: "w1:s2" }]);
    expect(w.drawer()!.state.shells.map((shell) => shell.paneId)).toEqual(["w1:s1"]);
    // The last one asks too; once closed, the drawer closes.
    w.drawer()!.onCloseShell("w1:s1");
    await settle();
    expect(w.confirm()).toMatchObject({ name: "Terminal" });
    w.confirm()!.onConfirm();
    await settle();
    expect(w.actions).toMatchObject([{ paneId: "w1:s2" }, { type: "close", paneId: "w1:s1" }]);
    expect(w.drawer()!.state.open).toBe(false);
    expect(w.drawer()!.state.shells).toEqual([]);
    // The screen was never read to skip the question.
    expect(w.busyAsked).toEqual([]);
  });

  it("drops a saved shell that is its owner's own pane or another workspace's: never shown, never a close target", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      terminalDrawersKey,
      JSON.stringify({
        "host|w1:p1": {
          open: true,
          height: null,
          shells: [
            { paneId: "w1:p1", addedAtMs: 1 },
            { paneId: "w2:x1", addedAtMs: 1 },
            { paneId: "w1:s9", addedAtMs: 1 },
          ],
          active: "w1:p1",
        },
      }),
    );
    const w = await window_({ storage, panes: [{ id: "w2:x1", tab: "w2:t1", ws: "w2" }, { id: "w1:s9", tab: "w1:ts9" }] });
    await w.select("w1:p1");
    expect(w.drawer()!.shells.map((shell) => shell.paneId)).toEqual(["w1:s9"]);
    expect(JSON.parse(storage.getItem(terminalDrawersKey)!)["host|w1:p1"].shells.map((shell: { paneId: string }) => shell.paneId)).toEqual(["w1:s9"]);
    // Even asked directly, neither the agent itself nor another workspace's pane is closed or asked about.
    w.drawer()!.onCloseShell("w1:p1");
    w.drawer()!.onCloseShell("w2:x1");
    await settle();
    expect(w.confirm()).toBeUndefined();
    expect(w.actions).toEqual([]);
  });

  it("gives the shell the keyboard as it opens, and gives it back where it was on ⌘J or Escape outside a shell", async () => {
    const w = await window_();
    await w.select("w1:p1");
    const box = focusable("box");
    w.doc.activeElement = box;
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.wantsKeys).toBe(true);
    const pane = render({ type: MainPane, props: w.main()! });
    const drawerUi = render(one(pane.tree, "TerminalDrawer")! as never);
    expect(one(drawerUi.tree, "TerminalTab")?.props).toMatchObject({ autoFocus: true });
    drawerUi.unmount();
    pane.unmount();
    // The shell has the keyboard; ⌘J closes the drawer and the box has it again.
    w.doc.activeElement = focusable("drawer");
    await new Promise((resolve) => setTimeout(resolve, 450));
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.state.open).toBe(false);
    expect(box.focus).toHaveBeenCalledTimes(1);
    expect(w.drawer()!.wantsKeys).toBe(false);
    // Opened again from the box; Escape from the drawer's header (not a shell) gives it back too, the drawer staying open.
    w.doc.activeElement = box;
    await new Promise((resolve) => setTimeout(resolve, 450));
    await w.key("j", { metaKey: true });
    const again = render({ type: TerminalDrawer, props: { host: hostView(w.panes()), drawer: w.drawer(), fontSize: 13, mac: true } });
    const section = elements(again.tree).find((element) => element.type === "section")!;
    const escape = { key: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { closest: () => null }, preventDefault: vi.fn() };
    (section.props["onKeyDown"] as (event: unknown) => void)(escape);
    await settle();
    again.unmount();
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(box.focus).toHaveBeenCalledTimes(2);
    expect(w.drawer()!.state.open).toBe(true);
    // Escape inside a shell is the shell's: nothing taken.
    const inShell = { ...escape, target: { closest: (selector: string) => (selector === ".term-host" ? {} : null) }, preventDefault: vi.fn() };
    const third = render({ type: TerminalDrawer, props: { host: hostView(w.panes()), drawer: w.drawer(), fontSize: 13, mac: true } });
    (elements(third.tree).find((element) => element.type === "section")!.props["onKeyDown"] as (event: unknown) => void)(inShell);
    third.unmount();
    expect(inShell.preventDefault).not.toHaveBeenCalled();
  });

  it("is kept per machine and pane across a relaunch (shells, height, open) and drops a shell gone from Herdr", async () => {
    const storage = new MemoryStorage();
    const first = await window_({ storage });
    await first.select("w1:p1");
    await first.key("j", { metaKey: true });
    first.drawer()!.onNewShell();
    await settle();
    first.drawer()!.onHeight(360);
    await settle();
    expect(JSON.parse(storage.getItem(terminalDrawersKey)!)["host|w1:p1"]).toMatchObject({ open: true, height: 360, active: "w1:s2" });
    // Another agent pane's drawer is its own: closed, no shells.
    await first.select("w1:p2");
    expect(first.drawer()!.state).toMatchObject({ open: false, shells: [] });
    cleanup?.();
    cleanup = null;
    vi.unstubAllGlobals();

    // The relaunch: shell s1 was closed in Herdr meanwhile (the new window's machine lists s2 only).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await window_({ storage, panes: [{ id: "w1:s2", tab: "w1:ts2" }] });
    await second.select("w1:p1");
    // The kept drawer comes back open at its height, without taking the keyboard; the shell gone from Herdr is dropped.
    const state = second.drawer()!.state;
    expect(state.open).toBe(true);
    expect(state.height).toBe(360);
    expect(second.drawer()!.wantsKeys).toBe(false);
    expect(state.shells.map((shell) => shell.paneId)).toEqual(["w1:s2"]);
    expect(state.active).toBe("w1:s2");
    // By the drawer's order: the one left is "Terminal".
    expect(second.drawer()!.shells[0]!.label).toBe("Terminal");
    expect(second.opened).toEqual([]);
    // Held from the launch on, so it never flashes in as a sidebar row.
    expect(rowsOf(second.sidebar())).not.toContain("w1:s2");
    expect(rowsOf(second.sidebar())).toContain("w1:p6");
    expect(JSON.parse(storage.getItem(terminalDrawersKey)!)["host|w1:p1"].shells.map((shell: { paneId: string }) => shell.paneId)).toEqual(["w1:s2"]);
  });

  // ⌘, and ⌘J are separate keys; Settings hides the pane and its drawer, ⌘J does
  // nothing under it, and closing it brings the pane, its drawer and the focus back as they were.
  it("under the Settings page: ⌘J does nothing, the drawer keeps its state, and comes back with the focus as Settings closes", async () => {
    const w = await window_();
    await w.select("w1:p1");
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.state.open).toBe(true);
    const shell = focusable("drawer");
    w.doc.activeElement = shell;
    // ⌘, opens Settings over the main area (the drawer is in it, so it is hidden with it); ⌘J is not taken for the drawer.
    const comma = await w.key(",", { metaKey: true });
    expect(comma.preventDefault).toHaveBeenCalled();
    expect((w.app.tree as { props: { className: string } }).props.className).toBe("app settings-open");
    expect(one(w.app.tree, "SettingsPage")).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 450));
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.state.open).toBe(true);
    expect(w.opened).toHaveLength(1);
    // ⌘, again: back to the pane, its drawer open as it was, the keyboard back in the drawer's shell.
    await new Promise((resolve) => setTimeout(resolve, 650));
    await w.key(",", { metaKey: true });
    expect(one(w.app.tree, "SettingsPage")).toBeUndefined();
    expect((w.app.tree as { props: { className: string } }).props.className).toBe("app");
    expect(w.drawer()!.state.open).toBe(true);
    expect(shell.focus).toHaveBeenCalledTimes(1);
    // And ⌘J works again.
    await new Promise((resolve) => setTimeout(resolve, 450));
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.state.open).toBe(false);
  });

  it("in a split: the focused agent tile's drawer, opened from its tile's button, under the tiles", async () => {
    const w = await window_();
    await w.select("w1:pA");
    await w.layout(splitLayout, "w1:pA");
    expect(w.split()).toBeDefined();
    expect(w.main()).toBeUndefined();
    const view = render({ type: SplitView, props: w.split()! });
    const tile = named(view.tree, "Tile").find((candidate) => (candidate.props["entry"] as { paneId: string }).paneId === "w1:pB")!;
    const tileUi = render(tile as never);
    const toggle = elements(tileUi.tree).find((element) => element.type === "button" && element.props["data-drawer-toggle"] !== undefined)!;
    expect(toggle.props["aria-label"]).toMatch(/^Terminal drawer for /u);
    (toggle.props["onClick"] as () => void)();
    await settle();
    tileUi.unmount();
    view.unmount();
    // The tile's button focused its tile; the drawer is that tile's, open, with its first shell.
    expect(w.split()!["focusedPaneId"]).toBe("w1:pB");
    expect(w.drawer()!.state.open).toBe(true);
    expect(w.opened).toEqual([{ hostId: "host", request: { workspaceId: "w1", folder: "/code/app" } }]);
    const again = render({ type: SplitView, props: w.split()! });
    const drawerEl = one(again.tree, "TerminalDrawer")!;
    expect(drawerEl.props["owner"]).toMatch(/^2 · /u);
    // The other tile's drawer is its own (closed).
    expect((w.split()!["tiles"] as { paneId: string; drawerOpen?: boolean }[]).map((entry) => [entry.paneId, entry.drawerOpen === true])).toEqual([
      ["w1:pA", false],
      ["w1:pB", true],
    ]);
    again.unmount();
  });
});

// The shells stay real Herdr tabs (named "Terminal") and live in the drawer only.
describe("the drawer's shells and the sidebar", () => {
  it("are no sidebar row, nor in Priority, the footer count, search or ⇧⌘J; a plain shell is; one that needs you is a dot on the drawer button", async () => {
    const w = await window_();
    await w.select("w1:p1");
    const agents = w.sidebar().agentCount;
    expect(rowsOf(w.sidebar())).toContain("w1:p6");
    await w.key("j", { metaKey: true });
    w.drawer()!.onNewShell();
    await settle();
    expect(w.drawer()!.shells.map((shell) => [shell.paneId, shell.label])).toEqual([
      ["w1:s1", "Terminal"],
      ["w1:s2", "Terminal 2"],
    ]);
    // Both are panes the machine lists (real Herdr tabs), and neither is a sidebar row; the plain shell still is.
    expect(w.panes().map((pane) => pane.id)).toEqual(expect.arrayContaining(["w1:s1", "w1:s2"]));
    expect(rowsOf(w.sidebar()).filter((id) => id.startsWith("w1:s"))).toEqual([]);
    expect(rowsOf(w.sidebar())).toContain("w1:p6");
    expect(w.drawer()!.needsYou ?? false).toBe(false);
    // Claude is started in the second shell and asks something: it stays the drawer's.
    await w.update((panes) => panes.map((pane) => (pane.id === "w1:s2" ? { ...pane, agent: "claude", status: "blocked" } : pane)));
    const sidebar = w.sidebar();
    expect(rowsOf(sidebar).filter((id) => id.startsWith("w1:s"))).toEqual([]);
    expect(sidebar.agentCount).toBe(agents);
    expect(sidebar.needsYou).toEqual([]);
    expect(sidebar.badge).toBe(0);
    expect(sidebar.priority.flatMap((section) => section.rows.map((entry) => entry.row.paneID))).not.toContain("w1:s2");
    // The drawer button (and the shell's tab) shows a small dot instead.
    expect(w.drawer()!.needsYou).toBe(true);
    expect(w.drawer()!.shells.map((shell) => shell.needsYou === true)).toEqual([false, true]);
    const pane = render({ type: MainPane, props: w.main()! });
    expect(hasDot(headerButton(pane))).toBe(true);
    const drawerUi = render(one(pane.tree, "TerminalDrawer")! as never);
    expect(elements(drawerUi.tree).filter((element) => element.props["role"] === "tab").map((tab) => hasDot(tab))).toEqual([false, true]);
    drawerUi.unmount();
    pane.unmount();
    // ⇧⌘J: nothing outside the drawer needs you, so the pane stays.
    await w.key("J", { metaKey: true, shiftKey: true });
    expect(w.main()!["row"]).toMatchObject({ paneID: "w1:p1" });
    // An agent outside it that needs you is the one ⇧⌘J goes to, and the only one.
    await w.update((panes) => panes.map((each) => (each.id === "w1:p2" ? { ...each, status: "blocked" } : each)));
    await w.key("J", { metaKey: true, shiftKey: true });
    expect(w.main()!["row"]).toMatchObject({ paneID: "w1:p2" });
    await w.key("J", { metaKey: true, shiftKey: true });
    expect(w.main()!["row"]).toMatchObject({ paneID: "w1:p2" });
    expect(w.sidebar().needsYou.map((entry) => entry.row.paneID)).toEqual(["w1:p2"]);
    // The pane search: the workspace's name finds its panes and the plain shell, no drawer shell.
    (one(w.app.tree, "Sidebar")!.props["onSearch"] as (text: string | null) => void)("app");
    await settle();
    expect(w.sidebar().isSearching).toBe(true);
    expect(rowsOf(w.sidebar())).toContain("w1:p6");
    expect(rowsOf(w.sidebar()).filter((id) => id.startsWith("w1:s"))).toEqual([]);
    // The drawer itself still has both (its tabs, its terminals).
    await w.select("w1:p1");
    expect(w.drawer()!.shells.map((shell) => shell.paneId)).toEqual(["w1:s1", "w1:s2"]);
  });

  it("shows a drawer's shell again once its drawer is gone: its agent pane closed in Herdr", async () => {
    const w = await window_();
    await w.select("w1:p1");
    await w.key("j", { metaKey: true });
    expect(w.drawer()!.state.shells.map((shell) => shell.paneId)).toEqual(["w1:s1"]);
    expect(rowsOf(w.sidebar())).not.toContain("w1:s1");
    await w.update((panes) => panes.filter((pane) => pane.id !== "w1:p1"));
    expect(rowsOf(w.sidebar())).toContain("w1:s1");
    expect(JSON.parse(w.storage.getItem(terminalDrawersKey)!)).toEqual({});
  });

  // Main sends the machine's snapshot with the new pane (its refresh) before the answer that names it; for that moment
  // the drawer does not know the pane yet. It is held out of the sidebar meanwhile, so no "Terminal" row flashes in.
  it("holds a shell being made out of the sidebar while the snapshot listing it comes before its answer", async () => {
    let answer!: () => void;
    const w = await window_({ answer: new Promise<void>((done) => (answer = done)) });
    await w.select("w1:p1");
    await w.key("j", { metaKey: true });
    expect(w.panes().map((pane) => pane.id)).toContain("w1:s1");
    expect(w.drawer()!.state.shells).toEqual([]);
    expect(rowsOf(w.sidebar())).not.toContain("w1:s1");
    expect(rowsOf(w.sidebar())).toContain("w1:p6");
    answer();
    await settle();
    expect(w.drawer()!.state.shells.map((shell) => shell.paneId)).toEqual(["w1:s1"]);
    expect(rowsOf(w.sidebar())).not.toContain("w1:s1");
  });

  it("shows a pane made for a drawer whose answer failed: no drawer holds it", async () => {
    let refuse!: (error: Error) => void;
    const w = await window_({ answer: new Promise<void>((_done, fail) => (refuse = fail)) });
    await w.select("w1:p1");
    await w.key("j", { metaKey: true });
    expect(rowsOf(w.sidebar())).not.toContain("w1:s1");
    refuse(new Error("the answer was lost"));
    await settle();
    expect(w.drawer()!.state.shells).toEqual([]);
    expect(rowsOf(w.sidebar())).toContain("w1:s1");
  });
});
