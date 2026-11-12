// Every way of hiding the message box over the
// terminal (the header button, Escape in the box, ⇧⌘T and the View menu, the
// app command) hands the keyboard back to the terminal, once. The real App and
// MainPane run on the small hooks host with a fake bridge: App's MainPane
// element is rendered in its own host with the props App gives it.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { AppCommand, HostView } from "../src/shared/ipc-contract";
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

const host: HostView = {
  id: "host",
  name: "host",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state: "connected",
  error: null,
  fetchedAtMs: 0,
  topology: decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }],
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
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  await flush();
  (byName(app.tree, "Sidebar")!.props["onSelect"] as (h: string, p: string) => void)("host", "w1:p1");
  const mainElement = () => byName(app.tree, "MainPane")!;
  // A Claude pane opens in Chat: the user picks Terminal, where the box is.
  expect(mainElement().props["tab"]).toBe("chat");
  (mainElement().props["onTab"] as (tab: string) => void)("terminal");
  const main = new HookHost(mainElement().type as (props: object) => unknown, mainElement().props);
  main.render();
  cleanup = () => {
    main.unmount();
    app.unmount();
  };
  const sync = () => main.render(mainElement().props);
  return {
    sync,
    shown: () => mainElement().props["boxShown"] as boolean,
    focusSignal: () => byName(main.tree, "TerminalTab")!.props["focusSignal"] as number,
    view: (c: ViewCommand) => {
      view(c);
      sync();
    },
    command: (c: AppCommand) => {
      command(c);
      sync();
    },
    button: () => {
      const button = elements(main.tree).find((candidate) => candidate.props["aria-pressed"] !== undefined)!;
      (button.props["onClick"] as () => void)();
      sync();
    },
    escape: () => {
      const composer = byName(main.tree, "Composer")!;
      (composer.props["onDismiss"] as () => void)();
      sync();
    },
  };
}

describe("hiding the message box over the terminal", () => {
  it("gives the terminal the keyboard back when ⇧⌘T (the View menu) hides it", async () => {
    const w = await window_();
    expect(w.focusSignal()).toBe(0);
    w.view("toggle-box");
    expect(w.shown()).toBe(true);
    expect(w.focusSignal()).toBe(0);
    w.view("toggle-box");
    expect(w.shown()).toBe(false);
    expect(w.focusSignal()).toBe(1);
  });

  it("hands focus back once for the button, Escape and the app command too", async () => {
    const w = await window_();
    w.button();
    w.button();
    expect(w.focusSignal()).toBe(1);
    w.view("toggle-box");
    w.escape();
    expect(w.shown()).toBe(false);
    expect(w.focusSignal()).toBe(2);
    w.command({ id: "c1", type: "set-box", shown: true });
    w.command({ id: "c2", type: "set-box", shown: false });
    expect(w.focusSignal()).toBe(3);
    // Showing it, or hiding a box that is not shown, takes nothing from the terminal.
    w.command({ id: "c3", type: "set-box", shown: false });
    expect(w.focusSignal()).toBe(3);
  });
});
