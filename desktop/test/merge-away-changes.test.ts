// The two away and search screens (While you were away, Search conversations)
// and the across-agents Changes screen fill the same main area, one at a time; an away card or a search
// result opens its pane in Chat even when the pane's own pick
// (the per-pane views) was Changes; ⌃⌘C leaves a pane under a
// screen alone; ⇧⌘F is Search conversations beside the window's
// ⌘J, ⌘F and ⌘N. The window on the hooks host with a fake bridge.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { appShortcut } from "../src/shared/app-keys";
import type { AppCommand, HostView, MainTab } from "../src/shared/ipc-contract";
import type { ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { App } = await import("../src/renderer/App");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const machine: HostView = {
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
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 2, agent_status: "idle" }],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "working", revision: 1 },
      { pane_id: "w1:p2", terminal_id: "term2", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture/shell", agent_status: "unknown", revision: 1 },
    ],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "working" }],
  }),
};

const byName = (tree: unknown, name: string) =>
  elements(tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function window_() {
  let view: (command: ViewCommand) => void = () => undefined;
  let command: (command: AppCommand) => void = () => undefined;
  vi.stubGlobal("window", {
    herdrDesktop: {
      appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
      listHosts: async () => [machine],
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
      changesAgent: async () => null,
      changesDiff: async () => null,
      changesOverview: async () => null,
      closeChanges: () => undefined,
      copyText: () => undefined,
      awayState: async () => ({ building: false, digest: null }),
      onAwayUpdate: () => () => undefined,
      awayShown: () => undefined,
      awayMarkSeen: () => undefined,
      searchConversations: () => undefined,
      searchExpand: () => undefined,
      searchRetry: () => undefined,
      searchClose: () => undefined,
      onSearchUpdate: () => () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() }, querySelector: () => null });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  await flush();
  cleanup = () => app.unmount();
  const sidebar = () => byName(app.tree, "Sidebar")!;
  const main = () => byName(app.tree, "MainPane");
  /** The screen in the main area. */
  const screen = (): string => {
    for (const name of ["ChangesOverview", "AwayScreen", "SearchScreen", "MainPane", "EmptyState"]) if (byName(app.tree, name) !== undefined) return name;
    return "none";
  };
  return {
    app,
    screen,
    main,
    tab: () => main()?.props["tab"] as MainTab,
    select: (paneId: string) => (sidebar().props["onSelect"] as (h: string, p: string) => void)("host", paneId),
    // The sidebar has no cards; the View menu opens both screens.
    openChanges: () => view("open-changes"),
    openAway: () => view("open-away"),
    changesOpen: () => byName(app.tree, "ChangesOverview") !== undefined,
    view: (c: ViewCommand) => view(c),
    command: (c: AppCommand) => command(c),
  };
}

describe("the main area's screens, one at a time", () => {
  it("While You Were Away over the Changes screen shows away; What Each Agent Changed over away shows Changes", async () => {
    const w = await window_();
    w.openChanges();
    expect(w.screen()).toBe("ChangesOverview");
    w.openAway();
    expect(w.screen()).toBe("AwayScreen");
    expect(w.changesOpen()).toBe(false);
    w.openChanges();
    expect(w.screen()).toBe("ChangesOverview");
    // Closing Changes does not bring away back.
    (byName(w.app.tree, "ChangesOverview")!.props["onClose"] as () => void)();
    expect(w.screen()).toBe("EmptyState");
  });

  it("Search conversations over the Changes screen shows search, and the captures' commands keep it to one", async () => {
    const w = await window_();
    w.command({ id: "1", type: "set-changes-overview", shown: true });
    expect(w.screen()).toBe("ChangesOverview");
    w.command({ id: "2", type: "search", query: "retry" });
    expect(w.screen()).toBe("SearchScreen");
    expect(w.changesOpen()).toBe(false);
    w.command({ id: "3", type: "set-changes-overview", shown: true });
    expect(w.screen()).toBe("ChangesOverview");
    w.command({ id: "4", type: "show-away", shown: true });
    expect(w.screen()).toBe("AwayScreen");
    w.command({ id: "5", type: "set-changes-overview", shown: true });
    expect(w.screen()).toBe("ChangesOverview");
    w.command({ id: "6", type: "set-changes-overview", shown: false });
    w.command({ id: "7", type: "clear-selection" });
    expect(w.screen()).toBe("EmptyState");
  });

  it("an away card opens its pane in Chat when the pane's pick was Changes, and the pick stays the pane's", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.view("toggle-changes");
    expect(w.tab()).toBe("changes");
    w.select("w1:p2");
    w.openAway();
    const away = byName(w.app.tree, "AwayScreen")!;
    (away.props["onOpenCard"] as (card: object) => void)({ macID: "host", paneID: "w1:p1", firstNewItemID: null });
    expect(w.screen()).toBe("MainPane");
    expect(w.main()?.props["row"]).toMatchObject({ paneID: "w1:p1" });
    expect(w.tab()).toBe("chat");
    // Chat is now the pane's pick (the per-pane views), and ⌃⌘C from it opens Changes again.
    w.select("w1:p2");
    w.select("w1:p1");
    expect(w.tab()).toBe("chat");
    w.view("toggle-changes");
    expect(w.tab()).toBe("changes");
  });

  it("a search result opens its pane in Chat over Changes", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.view("toggle-changes");
    w.command({ id: "s", type: "search", query: "retry" });
    const search = byName(w.app.tree, "SearchScreen")!;
    (search.props["onOpen"] as (request: object) => void)({ macID: "host", paneID: "w1:p1", messageID: "m1" });
    expect(w.screen()).toBe("MainPane");
    expect(w.tab()).toBe("chat");
  });

  it("⌃⌘C leaves the pane under the away or search screen alone", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.openAway();
    w.view("toggle-changes");
    (byName(w.app.tree, "AwayScreen")!.props["onClose"] as () => void)();
    expect(w.screen()).toBe("MainPane");
    expect(w.tab()).toBe("chat");
    w.command({ id: "s", type: "search", query: "retry" });
    w.view("toggle-changes");
    (byName(w.app.tree, "SearchScreen")!.props["onClose"] as () => void)();
    expect(w.screen()).toBe("MainPane");
    expect(w.tab()).toBe("chat");
  });
});

describe("the window's shortcuts", () => {
  const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("⇧⌘F is Search conversations, beside ⌘F search, ⌘J and ⌘N", () => {
    expect(appShortcut(press("F", { metaKey: true, shiftKey: true }), true)).toBe("searchConversations");
    expect(appShortcut(press("f", { ctrlKey: true, shiftKey: true }), false)).toBe("searchConversations");
    expect(appShortcut(press("f", { metaKey: true }), true)).toBe("search");
    expect(appShortcut(press("F", { metaKey: true, shiftKey: true, altKey: true }), true)).toBeNull();
    // ⌘J is the terminal drawer; the next pane that needs you is ⇧⌘J.
    expect(appShortcut(press("j", { metaKey: true }), true)).toBe("toggleTerminal");
    expect(appShortcut(press("J", { metaKey: true, shiftKey: true }), true)).toBe("nextNeedsYou");
    expect(appShortcut(press("n", { metaKey: true }), true)).toBe("newAgent");
    // ⇧⌘N is New workspace, as in the Swift app.
    expect(appShortcut(press("N", { metaKey: true, shiftKey: true }), true)).toBe("newWorkspace");
  });
});
