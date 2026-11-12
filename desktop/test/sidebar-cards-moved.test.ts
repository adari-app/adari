// The left list has neither the Changes card nor the away card at its top.
// Both screens open from the View menu instead (While You Were Away, What Each
// Agent Changed; the window's other View items and keys as they were), one
// screen at a time as before, the away screen's Mark all seen as before. A
// digest counts as shown only while its screen is open (the line that also
// counted is gone). The real App and Sidebar on the small hooks host, a fake
// bridge; the menu template as data.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { viewMenuItems } from "../src/main/view-menu";
import { buildAwayDigest, awayActivity, type AwayDigest, type AwayViewState } from "../src/shared/away/digest";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import type { AppCommand, HostView } from "../src/shared/ipc-contract";
import { isViewCommand, nextFontSize, viewCommands, type ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { App } = await import("../src/renderer/App");
const { Sidebar } = await import("../src/renderer/components/Sidebar");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const now = Date.parse("2026-11-05T20:00:00.000Z") / 1000;

/** One machine with news: an agent that needs you and one that finished. */
function news(): AwayDigest {
  return buildAwayDigest(
    [
      {
        id: "host",
        name: "Mac mini",
        since: now - 3 * 3600,
        state: { kind: "online" },
        panes: [
          {
            pane: { paneID: "w1:p1", name: "api", kind: "claude", folder: "/srv/app", status: "blocked", statusSince: now - 600, session: null },
            transcript: { kind: "read", activity: awayActivity({ lastActivityAt: now - 300 }) },
          },
          {
            pane: { paneID: "w1:p2", name: "web", kind: "claude", folder: "/srv/app", status: "done", statusSince: now - 900, session: null },
            transcript: { kind: "read", activity: awayActivity({ turnsFinished: 1, lastTurnEndedAt: now - 900, lastActivityAt: now - 900 }) },
          },
        ],
        git: {},
      },
    ],
    now,
  );
}

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
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "blocked" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 2, agent_status: "blocked" }],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/app", agent: "claude", agent_status: "blocked", revision: 1 },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/app", agent: "claude", agent_status: "working", revision: 1 },
    ],
    layouts: [],
    agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "blocked" },
      { pane_id: "w1:p2", agent: "claude", agent_status: "working" },
    ],
  }),
};

const byName = (tree: unknown, name: string) =>
  elements(tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);

const classNames = (tree: unknown): string[] =>
  elements(tree)
    .map((element) => element.props["className"])
    .filter((name): name is string => typeof name === "string");

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function window_() {
  let view: (command: ViewCommand) => void = () => undefined;
  let command: (command: AppCommand) => void = () => undefined;
  let away: (state: AwayViewState) => void = () => undefined;
  const keys: ((event: { key: string }) => void)[] = [];
  const sent: string[] = [];
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
      awayState: async () => ({ building: false, digest: news(), seenAt: null }),
      onAwayUpdate: (listener: (state: AwayViewState) => void) => {
        away = listener;
        return () => undefined;
      },
      awayShown: () => sent.push("shown"),
      awayMarkSeen: () => sent.push("seen"),
      searchConversations: () => undefined,
      searchExpand: () => undefined,
      searchRetry: () => undefined,
      searchClose: () => undefined,
      onSearchUpdate: () => () => undefined,
    },
    addEventListener: (type: string, listener: (event: { key: string }) => void) => {
      if (type === "keydown") keys.push(listener);
    },
    removeEventListener: (type: string, listener: (event: { key: string }) => void) => {
      const index = keys.indexOf(listener);
      if (type === "keydown" && index >= 0) keys.splice(index, 1);
    },
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
  const screen = (): string => {
    for (const name of ["ChangesOverview", "AwayScreen", "SearchScreen", "MainPane", "EmptyState"]) if (byName(app.tree, name) !== undefined) return name;
    return "none";
  };
  return { app, sidebar, screen, sent, keys, view: (c: ViewCommand) => view(c), command: (c: AppCommand) => command(c), away: (s: AwayViewState) => away(s) };
}

describe("the View menu opens the two screens the cards opened", () => {
  it("has While You Were Away and What Each Agent Changed, on the Mac and elsewhere", () => {
    for (const mac of [true, false]) {
      const sent: ViewCommand[] = [];
      const items = viewMenuItems((c) => sent.push(c), mac);
      const away = items.find((item) => item.label === "While You Were Away");
      const changes = items.find((item) => item.label === "What Each Agent Changed");
      expect(away, "While You Were Away").toBeDefined();
      expect(changes, "What Each Agent Changed").toBeDefined();
      (away!.click as () => void)();
      (changes!.click as () => void)();
      expect(sent).toEqual(["open-away", "open-changes"]);
      // The menu's own keys stay as they were (⌃⌘C is still the open pane's Changes).
      expect(items.find((item) => item.label === "Changes")?.accelerator).toBe(mac ? "Ctrl+Cmd+C" : "Ctrl+Alt+C");
      expect(away!.accelerator).toBeUndefined();
      expect(changes!.accelerator).toBeUndefined();
    }
  });

  it("sends commands the page knows, which leave the text size alone", () => {
    for (const c of ["open-away", "open-changes"] as const) {
      expect(isViewCommand(c)).toBe(true);
      expect(viewCommands).toContain(c);
      expect(nextFontSize(15, c)).toBe(15);
    }
  });
});

describe("the left list without the two cards", () => {
  it("draws neither the Changes card nor the away line, even when asked the old way", () => {
    const none = (): void => undefined;
    const sidebar = buildDesktopSidebar([{ ...machine, topology: machine.topology }], { nowUnixMs: now * 1000 });
    const props = {
      sidebar,
      selectedKey: null,
      search: null,
      demo: false,
      foldedHosts: new Set<string>(),
      onSelect: none,
      onRowMenu: none,
      onToggleHost: none,
      onHostMenu: none,
      onRetryHost: none,
      onMode: none,
      onToggleWorkspace: none,
      onToggleExpanded: none,
      onToggleSection: none,
      onSearch: none,
      onAddHost: none,
      onNewAgent: none,
      onWorkspaceMenu: none,
      // The props the card took (a stale caller): still nothing drawn.
      changesOpen: false,
      onOpenChanges: none,
    };
    const view = new HookHost(Sidebar as (props: object) => unknown, props);
    view.render();
    const names = classNames(view.tree);
    expect(names.some((name) => name.split(" ").includes("sb-changes"))).toBe(false);
    expect(names.some((name) => name.split(" ").includes("away-line"))).toBe(false);
    view.unmount();
  });

  it("is given no card by the window: no Changes entry, no away line above the list, and the digest is not said shown", async () => {
    const w = await window_();
    const props = w.sidebar().props;
    expect(props["onOpenChanges"]).toBeUndefined();
    expect(props["changesOpen"]).toBeUndefined();
    const top = elements(props["top"]);
    expect(top.some((element) => typeof element.type === "function" && (element.type as { name: string }).name === "AwayLine")).toBe(false);
    expect(classNames(props["top"]).some((name) => name.split(" ").includes("away-line"))).toBe(false);
    // Nothing on screen showed the digest, so leaving the window moves no `since`.
    expect(w.sent).toEqual([]);
    // The search's "all conversations" row stays above the list while searching (delete nothing else).
    (props["onSearch"] as (text: string | null) => void)("login");
    expect(classNames(w.sidebar().props["top"]).some((name) => name.split(" ").includes("search-all"))).toBe(true);
  });
});

describe("the two screens from the menu", () => {
  it("open one at a time, over search too, and Escape leaves away", async () => {
    const w = await window_();
    w.view("open-changes");
    expect(w.screen()).toBe("ChangesOverview");
    w.view("open-away");
    expect(w.screen()).toBe("AwayScreen");
    w.view("open-changes");
    expect(w.screen()).toBe("ChangesOverview");
    w.command({ id: "s", type: "search", query: "retry" });
    expect(w.screen()).toBe("SearchScreen");
    w.view("open-away");
    expect(w.screen()).toBe("AwayScreen");
    for (const key of w.keys.slice()) key({ key: "Escape" });
    expect(w.screen()).toBe("EmptyState");
    w.view("open-changes");
    (byName(w.app.tree, "ChangesOverview")!.props["onClose"] as () => void)();
    expect(w.screen()).toBe("EmptyState");
  });

  it("the away screen says its digest shown, counts it as before and marks all seen", async () => {
    const w = await window_();
    w.view("open-away");
    const screen = byName(w.app.tree, "AwayScreen")!;
    expect((screen.props["state"] as AwayViewState).digest?.cards.length).toBe(2);
    (screen.props["onShown"] as () => void)();
    (screen.props["onMarkSeen"] as () => void)();
    expect(w.sent).toEqual(["shown", "seen"]);
  });

  it("a pane opened from the sidebar leaves either screen", async () => {
    const w = await window_();
    for (const c of ["open-away", "open-changes"] as const) {
      w.view(c);
      (w.sidebar().props["onSelect"] as (h: string, p: string) => void)("host", "w1:p2");
      expect(w.screen()).toBe("MainPane");
    }
  });
});
