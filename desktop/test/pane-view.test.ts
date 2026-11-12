// An agent pane opens in Chat, also on reopen, as the Swift app's
// CompanionPaneModeRule and CompanionPaneModeMemory have it: Claude, Codex and
// Grok panes open in Chat, a shell in Terminal, on start, after a reconnect and
// on every open; their last pick on a pane is kept per Mac and pane across a
// restart and wins; a pane gone drops its entry; the pane open last comes back
// selected after a restart. The rules, then the window (App on the hooks host
// with a fake bridge) across a restart.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import {
  PaneViews,
  defaultView,
  lastPaneKey,
  lastPaneRestore,
  loadLastPane,
  paneViewsKey,
  saveLastPane,
} from "../src/shared/pane-view";
import { HookHost, elements } from "./support/fake-hooks";

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

function topology(panes: readonly { id: string; agent?: string }[]) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "", focused: true, pane_count: panes.length, agent_status: "idle" }],
    panes: panes.map((pane, index) => ({
      pane_id: pane.id,
      terminal_id: `t${index}`,
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
  });
}

const allPanes = [{ id: "w1:p1", agent: "claude" }, { id: "w1:p2", agent: "codex" }, { id: "w1:p3", agent: "grok" }, { id: "w1:p4" }];
const mac = (panes = allPanes, state: HostView["state"] = "connected"): HostView => ({
  id: "mini",
  name: "Mac mini",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state,
  error: null,
  fetchedAtMs: 0,
  topology: topology(panes),
});
const agent = (paneID: string) => ({ paneID, isAgent: true });
const shell = (paneID: string) => ({ paneID, isAgent: false });

describe("the view a pane opens in", () => {
  it("Claude, Codex and Grok panes open in Chat, a shell pane in Terminal", () => {
    expect(defaultView(agent("w1:p1"))).toBe("chat");
    expect(defaultView(shell("w1:p4"))).toBe("terminal");
    const views = new PaneViews(new MemoryStorage());
    expect(["w1:p1", "w1:p2", "w1:p3"].map((id) => views.view("mini", agent(id)))).toEqual(["chat", "chat", "chat"]);
    expect(views.view("mini", shell("w1:p4"))).toBe("terminal");
  });

  it("the user's pick on an agent pane is kept across a restart (per Mac and pane) and wins over Chat", () => {
    const storage = new MemoryStorage();
    new PaneViews(storage).pick("mini", agent("w1:p1"), "terminal");
    const restarted = new PaneViews(storage);
    expect(restarted.view("mini", agent("w1:p1"))).toBe("terminal");
    expect(restarted.view("mini", agent("w1:p2"))).toBe("chat");
    expect(restarted.view("other", agent("w1:p1"))).toBe("chat");
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({ "mini|w1:p1": "terminal" });
    restarted.pick("mini", agent("w1:p1"), "chat");
    expect(new PaneViews(storage).view("mini", agent("w1:p1"))).toBe("chat");
  });

  // A shell pane has no switch; it shows its terminal, a pick for it is ignored and nothing is kept.
  it("a shell pane always shows its terminal; a pick for it changes nothing and keeps nothing", () => {
    const storage = new MemoryStorage();
    const views = new PaneViews(storage);
    views.pick("mini", shell("w1:p4"), "chat");
    expect(views.view("mini", shell("w1:p4"))).toBe("terminal");
    expect(storage.getItem(paneViewsKey) === null || !storage.getItem(paneViewsKey)!.includes("w1:p4")).toBe(true);
    expect(new PaneViews(storage).view("mini", shell("w1:p4"))).toBe("terminal");
  });

  it("a closed pane's entry is dropped when its Mac answers without it; a Mac not answering keeps its entries", () => {
    const storage = new MemoryStorage();
    const views = new PaneViews(storage);
    views.pick("mini", agent("w1:p1"), "terminal");
    views.pick("mini", agent("w1:p2"), "terminal");
    expect(views.prune([mac(allPanes, "offline")])).toBe(false);
    expect(views.prune([{ ...mac(), state: "connecting", topology: null }])).toBe(false);
    expect(views.keptView("mini", "w1:p1")).toBe("terminal");
    expect(views.prune([mac(allPanes.filter((pane) => pane.id !== "w1:p1"))])).toBe(true);
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({ "mini|w1:p2": "terminal" });
    expect(views.prune([])).toBe(true);
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({});
  });

  // Changes is a view, kept per agent pane as the Swift app keeps .changes.
  it("keeps Changes as an agent pane's view, across restarts", () => {
    const storage = new MemoryStorage();
    new PaneViews(storage).pick("mini", agent("w1:p1"), "changes");
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({ "mini|w1:p1": "changes" });
    expect(new PaneViews(storage).view("mini", agent("w1:p1"))).toBe("changes");
  });

  it("unreadable or foreign entries are ignored", () => {
    const storage = new MemoryStorage();
    storage.setItem(paneViewsKey, JSON.stringify({ "mini|w1:p1": "split", "mini|w1:p2": "terminal" }));
    const views = new PaneViews(storage);
    expect(views.view("mini", agent("w1:p1"))).toBe("chat");
    expect(views.view("mini", agent("w1:p2"))).toBe("terminal");
    storage.setItem(paneViewsKey, "{not json");
    expect(new PaneViews(storage).view("mini", agent("w1:p2"))).toBe("chat");
  });

  it("the last pane open: kept, and back once its Mac shows it (dropped when it answered without it)", () => {
    const storage = new MemoryStorage();
    saveLastPane(storage, { hostId: "mini", paneId: "w1:p2" });
    const last = loadLastPane(storage)!;
    expect(last).toEqual({ hostId: "mini", paneId: "w1:p2" });
    expect(lastPaneRestore(last, [mac()])).toBe("restore");
    expect(lastPaneRestore(last, [{ ...mac(), state: "connecting", topology: null }])).toBe("wait");
    expect(lastPaneRestore(last, [mac([{ id: "w1:p1", agent: "claude" }])])).toBe("drop");
    expect(lastPaneRestore(last, [])).toBe("drop");
    saveLastPane(storage, null);
    expect(storage.getItem(lastPaneKey)).toBeNull();
    storage.setItem(lastPaneKey, "[1]");
    expect(loadLastPane(storage)).toBeNull();
  });
});

// MARK: - The window across a restart

const { App } = await import("../src/renderer/App");

type Listener = (value: unknown) => void;

function window_(storage: MemoryStorage, hosts: HostView[]) {
  let hostsListener: Listener | null = null;
  const bridge = {
    appInfo: () => Promise.resolve({ platform: "darwin", demo: false, capture: false, version: "0.0.1" }),
    listHosts: () => Promise.resolve(hosts),
    onHostsChanged: (listener: Listener) => {
      hostsListener = listener;
      return () => undefined;
    },
    onViewCommand: () => () => undefined,
    onAppCommand: () => () => undefined,
    appCommandDone: () => undefined,
    ghosttyInfo: () => Promise.resolve({ shown: false }),
    onChatUpdate: () => () => undefined,
    openChat: () => undefined,
    closeChat: () => undefined,
    setChatFollowing: () => undefined,
    startCommands: () => Promise.resolve({ status: { type: "absent" }, commands: {}, refused: {} }),
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
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const view = new HookHost(App as (props: object) => unknown, {});
  view.render();
  return { view, push: (next: HostView[]) => hostsListener!(next) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const main = (tree: unknown) => named(tree, "MainPane")[0]?.props as { tab: string; row: { paneID: string }; onTab(tab: string): void } | undefined;
const sidebarOf = (tree: unknown) => named(tree, "Sidebar")[0]!.props as { onSelect(hostId: string, paneId: string): void };

afterEach(() => vi.unstubAllGlobals());

describe("the window: agent panes in Chat, across a restart", () => {
  it("each pane opens in its view; the user's pick and the open pane come back after a restart", async () => {
    const storage = new MemoryStorage();
    const first = window_(storage, [mac()]);
    await settle();
    expect(main(first.view.tree)).toBeUndefined();
    for (const [paneId, view] of [["w1:p1", "chat"], ["w1:p2", "chat"], ["w1:p3", "chat"], ["w1:p4", "terminal"]] as const) {
      sidebarOf(first.view.tree).onSelect("mini", paneId);
      expect(main(first.view.tree)).toMatchObject({ tab: view, row: { paneID: paneId } });
    }
    sidebarOf(first.view.tree).onSelect("mini", "w1:p2");
    main(first.view.tree)!.onTab("terminal");
    expect(main(first.view.tree)!.tab).toBe("terminal");
    sidebarOf(first.view.tree).onSelect("mini", "w1:p1");
    expect(main(first.view.tree)!.tab).toBe("chat");
    first.view.unmount();

    // Restart: the last pane open (Claude) is selected again, in Chat; Codex keeps the user's Terminal pick.
    const second = window_(storage, [mac()]);
    await settle();
    expect(main(second.view.tree)).toMatchObject({ tab: "chat", row: { paneID: "w1:p1" } });
    sidebarOf(second.view.tree).onSelect("mini", "w1:p2");
    expect(main(second.view.tree)!.tab).toBe("terminal");
    second.view.unmount();
  });

  it("after a reconnect an agent pane still shows Chat; a closed pane's pick is dropped", async () => {
    const storage = new MemoryStorage();
    const w = window_(storage, [mac()]);
    await settle();
    sidebarOf(w.view.tree).onSelect("mini", "w1:p3");
    w.push([mac(allPanes, "offline")]);
    w.push([mac()]);
    expect(main(w.view.tree)).toMatchObject({ tab: "chat", row: { paneID: "w1:p3" } });
    sidebarOf(w.view.tree).onSelect("mini", "w1:p2");
    main(w.view.tree)!.onTab("terminal");
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({ "mini|w1:p2": "terminal" });
    w.push([mac(allPanes.filter((pane) => pane.id !== "w1:p2"))]);
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({});
    w.view.unmount();
  });

  it("the last pane waits for its Mac to answer, then comes back", async () => {
    const storage = new MemoryStorage();
    saveLastPane(storage, { hostId: "mini", paneId: "w1:p4" });
    const w = window_(storage, [{ ...mac(), state: "connecting", topology: null }]);
    await settle();
    expect(main(w.view.tree)).toBeUndefined();
    w.push([mac()]);
    expect(main(w.view.tree)).toMatchObject({ tab: "terminal", row: { paneID: "w1:p4" } });
    w.view.unmount();
  });
});
