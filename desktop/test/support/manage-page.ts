// The window over a fake bridge (no real
// connection), for Close pane, Rename… and Rename workspace…: the page's
// actions are recorded as the bridge gets them, and the machines change as a
// new snapshot would bring them. The test file mocks "react" with fakeReact
// before importing this.

import { vi } from "vitest";

import { decodeSessionTopology } from "../../src/main/herdr/wire";
import type { ViewCommand } from "../../src/shared/view-commands";
import type { AppCommand, GhosttyAvailability, HostView, LayoutUpdateEvent, PaneAction, PaneActionResult } from "../../src/shared/ipc-contract";
import type { PaneLayout } from "../../src/shared/pane-layout";
import { parseStartCommands } from "../../src/shared/start-commands";
import { HookHost, elements } from "./fake-hooks";

type Element = ReturnType<typeof elements>[number];

export interface FixturePane {
  readonly id: string;
  readonly tab: string;
  readonly workspace?: string;
  readonly agent?: string;
  readonly status?: string;
  readonly label?: string;
}

// w1 "app": tab t1 holds p1 (Claude, working) beside p2 (a shell); t2 holds p3 (Claude, idle) alone; t3 p4 (a shell) alone.
// w2 "ops": t1 holds p5 (Codex, idle) alone. No tab has a label, so each pane is named for its kind.
export const fixturePanes: readonly FixturePane[] = [
  { id: "w1:p1", tab: "w1:t1", agent: "claude", status: "working" },
  { id: "w1:p2", tab: "w1:t1" },
  { id: "w1:p3", tab: "w1:t2", agent: "claude", status: "idle" },
  { id: "w1:p4", tab: "w1:t3" },
  { id: "w2:p5", tab: "w2:t1", workspace: "w2", agent: "codex", status: "idle" },
];

/** A machine listing `panes` (and, for each, its tab and workspace), as a snapshot gives them. */
export function machine(panes: readonly FixturePane[] = fixturePanes, extra: Partial<HostView> = {}, labels: Record<string, string> = {}): HostView {
  const workspaces = [...new Set(panes.map((pane) => pane.workspace ?? "w1"))];
  const tabs = [...new Set(panes.map((pane) => pane.tab))];
  return {
    id: "host",
    name: "Mac mini",
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    connection: 3,
    incarnation: 2,
    epoch: 5,
    topology: decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: workspaces.map((id, index) => ({
        workspace_id: id,
        number: index + 1,
        label: labels[id] ?? (id === "w1" ? "app" : "ops"),
        focused: index === 0,
        pane_count: panes.filter((pane) => (pane.workspace ?? "w1") === id).length,
        tab_count: tabs.filter((tab) => tab.startsWith(`${id}:`)).length,
        active_tab_id: tabs.find((tab) => tab.startsWith(`${id}:`)),
        agent_status: "idle",
      })),
      tabs: tabs.map((id, index) => ({
        tab_id: id,
        workspace_id: id.split(":")[0],
        number: index + 1,
        label: "",
        focused: index === 0,
        pane_count: panes.filter((pane) => pane.tab === id).length,
        agent_status: "idle",
      })),
      panes: panes.map((pane, index) => ({
        pane_id: pane.id,
        terminal_id: `term${index}`,
        workspace_id: pane.workspace ?? "w1",
        tab_id: pane.tab,
        focused: false,
        cwd: "/Users/r/code/app",
        ...(pane.label === undefined ? {} : { label: pane.label }),
        ...(pane.agent === undefined ? {} : { agent: pane.agent }),
        agent_status: pane.status ?? "unknown",
        revision: 1,
      })),
      layouts: [],
      agents: panes.filter((pane) => pane.agent !== undefined).map((pane) => ({ pane_id: pane.id, agent: pane.agent, agent_status: pane.status })),
    }),
    ...extra,
  };
}

export const host = machine();

const area = { x: 0, y: 0, width: 134, height: 45 };

/** The tab of `paneId` showing it alone (one pane). */
export function single(paneId: string, tabId: string, workspaceId = "w1"): PaneLayout {
  return { tabId, workspaceId, area, focusedPaneId: paneId, panes: [{ paneId, rect: area, focused: true }], splits: [], zoomed: false };
}

/** w1:t1's two panes side by side. */
export function pair(focused = "w1:p1"): PaneLayout {
  return {
    tabId: "w1:t1",
    workspaceId: "w1",
    area,
    focusedPaneId: focused,
    panes: [
      { paneId: "w1:p1", rect: { x: 0, y: 0, width: 67, height: 45 }, focused: focused === "w1:p1" },
      { paneId: "w1:p2", rect: { x: 67, y: 0, width: 67, height: 45 }, focused: focused === "w1:p2" },
    ],
    splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: area }],
    zoomed: false,
  };
}

export const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
export const one = (tree: unknown, name: string) => named(tree, name)[0];
export const text = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as { props: { children?: unknown } }).props.children);
  return "";
};

export class MemoryStorage {
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

export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface PageOptions {
  readonly hosts?: HostView[];
  readonly ghostty?: GhosttyAvailability;
  /** More bridge calls for the window (the update state and its actions). */
  readonly bridge?: Record<string, unknown>;
}

export interface MenuEntry {
  readonly label: string;
  readonly disabledReason?: string | null;
  onSelect(): void;
}

/** The window (App) over a fake bridge. */
export async function page(options: PageOptions = {}) {
  const { App } = await import("../../src/renderer/App");
  const storage = new MemoryStorage();
  const actions: [string, PaneAction][] = [];
  /** Every other bridge call the page made that a test reads (renameWorkspace, …), by name. */
  const calls: [string, ...unknown[]][] = [];
  let layoutListener: ((event: LayoutUpdateEvent) => void) | null = null;
  let hostsListener: ((hosts: HostView[]) => void) | null = null;
  let commandListener: ((command: AppCommand) => void) | null = null;
  let viewListener: ((command: ViewCommand) => void) | null = null;
  /** The window's listeners as App adds them (capture or not), latest last. */
  const listeners: { kind: string; listener: (event: KeyboardEvent) => void; capture: boolean }[] = [];
  let answer: (action: PaneAction) => Promise<PaneActionResult> = () => Promise.resolve({ paneId: null });
  let other: (name: string) => Promise<unknown> = () => Promise.resolve(null);
  const bridge = {
    appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
    listHosts: async () => options.hosts ?? [host],
    onHostsChanged: (listener: (hosts: HostView[]) => void) => {
      hostsListener = listener;
      return () => undefined;
    },
    onAppCommand: (listener: (command: AppCommand) => void) => {
      commandListener = listener;
      return () => undefined;
    },
    onViewCommand: (listener: (command: ViewCommand) => void) => {
      viewListener = listener;
      return () => undefined;
    },
    ghosttyInfo: async () => options.ghostty ?? ({ shown: false } as GhosttyAvailability),
    openInGhostty: async () => null,
    appCommandDone: () => undefined,
    onChatUpdate: () => () => undefined,
    openChat: () => undefined,
    closeChat: () => undefined,
    setChatFollowing: () => undefined,
    startCommands: () => Promise.resolve(parseStartCommands(null)),
    watchLayout: () => undefined,
    onLayoutUpdate: (listener: (event: LayoutUpdateEvent) => void) => {
      layoutListener = listener;
      return () => undefined;
    },
    paneAction: (hostId: string, action: PaneAction) => {
      actions.push([hostId, action]);
      return answer(action);
    },
    renameWorkspace: (...args: unknown[]) => {
      calls.push(["renameWorkspace", ...args]);
      return other("renameWorkspace");
    },
    copyText: () => undefined,
    ...options.bridge,
  };
  vi.stubGlobal("window", {
    herdrDesktop: bridge,
    addEventListener: (kind: string, listener: (event: KeyboardEvent) => void, options?: unknown) => {
      listeners.push({ kind, listener, capture: options === true });
    },
    removeEventListener: (kind: string, listener: (event: KeyboardEvent) => void) => {
      const at = listeners.findIndex((entry) => entry.kind === kind && entry.listener === listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
    getSelection: () => null,
    innerWidth: 1400,
    innerHeight: 900,
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: new Promise(() => undefined) }, querySelector: () => null });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  const sidebar = () => one(app.tree, "Sidebar")!.props as Record<string, unknown>;
  const main = () => one(app.tree, "MainPane")?.props as Record<string, unknown> | undefined;
  const toast = (): string | null => {
    const element = elements(app.tree).find((candidate) => candidate.props["className"] === "app-toast");
    return element === undefined ? null : text(element);
  };
  return {
    app,
    actions,
    calls,
    /** Herdr's answer to each pane action from now on. */
    answer: (next: (action: PaneAction) => Promise<PaneActionResult>) => (answer = next),
    /** The answer to the other calls (renameWorkspace) from now on. */
    answerOther: (next: (name: string) => Promise<unknown>) => (other = next),
    /** The machines as a new snapshot lists them. */
    hosts: (next: HostView[]) => hostsListener!(next),
    /** A native menu command (View, File: New Workspace…) as the main process sends it. */
    view: (command: ViewCommand) => viewListener!(command),
    /** A key pressed in the window: its capture listeners first, then the others; whether one took it (preventDefault). */
    key: (init: Partial<KeyboardEvent> & { key: string }): boolean => {
      let taken = false;
      const event = {
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        code: "",
        isComposing: false,
        defaultPrevented: false,
        target: { tagName: "INPUT" },
        ...init,
        preventDefault: () => (taken = true),
        stopPropagation: () => undefined,
      } as unknown as KeyboardEvent;
      const keys = listeners.filter((one) => one.kind === "keydown");
      for (const entry of [...keys.filter((one) => one.capture), ...keys.filter((one) => !one.capture)]) entry.listener(event);
      return taken;
    },
    /** Another window event (focusin, …) to every listener of its kind. */
    fire: (kind: string, event: unknown) => {
      for (const entry of listeners.filter((one) => one.kind === kind)) entry.listener(event as KeyboardEvent);
    },
    /** A command from the main process (the capture flag drives the window this way). */
    command: (command: AppCommand) => commandListener!(command),
    select: (paneId: string, hostId = "host") => (sidebar()["onSelect"] as (h: string, p: string) => void)(hostId, paneId),
    /** The tab's layout as the main process sends it for the shown pane. */
    layout: (layout: PaneLayout, paneId: string) => layoutListener!({ hostId: "host", paneId, tabId: layout.tabId, layout, error: null }),
    sidebar,
    main,
    selectedKey: () => sidebar()["selectedKey"] as string | null,
    /** A row's right-click (its menu opens once Ghostty's availability is read). */
    rowMenu: async (paneId: string, hostId = "host") => {
      (sidebar()["onRowMenu"] as (h: string, p: string, x: number, y: number) => void)(hostId, paneId, 120, 240);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
    workspaceMenu: (workspaceId: string, hostId = "host") =>
      (sidebar()["onWorkspaceMenu"] as (h: string, w: string, x: number, y: number) => void)(hostId, workspaceId, 120, 200),
    menu: () => one(app.tree, "ContextMenu")?.props["items"] as MenuEntry[] | undefined,
    pick: (label: string) => {
      const items = one(app.tree, "ContextMenu")?.props["items"] as MenuEntry[] | undefined;
      const item = items?.find((candidate) => candidate.label === label);
      if (item === undefined) throw new Error(`no menu item ${label}: ${JSON.stringify(items?.map((candidate) => candidate.label))}`);
      // As ContextMenu's click: the menu closes, then the item runs.
      (one(app.tree, "ContextMenu")!.props["onClose"] as () => void)();
      item.onSelect();
    },
    toast,
    unmount: () => app.unmount(),
  };
}

/** An action without its binding (each binding is checked on its own). */
export function unbound(action: PaneAction): Record<string, unknown> {
  const { binding: _binding, ...rest } = action;
  return rest;
}

const mounted: HookHost<object>[] = [];

/** Unmounts every host `mainPane` made (their store subscriptions go with them); afterEach calls it. */
export function unmountPanes(): void {
  for (const view of mounted.splice(0)) view.unmount();
}

/** MainPane with `props`, on its own host (as App gives them). */
export async function mainPane(props: Record<string, unknown>) {
  const { MainPane } = await import("../../src/renderer/components/MainPane");
  const view = new HookHost<object>(MainPane as (props: object) => unknown, props);
  mounted.push(view);
  view.render();
  return view;
}

/** The pane header's More button pressed: the menu it opens (null: no More button). */
export function moreMenu(view: HookHost<object>): MenuEntry[] | null {
  const button = elements(view.tree).find((candidate) => candidate.props["data-more"] === "pane") as Element | undefined;
  if (button === undefined) return null;
  (button.props["onClick"] as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 400, right: 428, top: 60, bottom: 84 }) } });
  return (one(view.tree, "ContextMenu")?.props["items"] as MenuEntry[] | undefined) ?? null;
}
