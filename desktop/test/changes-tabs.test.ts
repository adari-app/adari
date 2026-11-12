// Chat | Terminal | Changes. The ⌃⌘C rule
// (CompanionChangesHookTests testChangesIsTheSwitchsThirdView...,
// testCtrlCmdCGoesBackToTheViewItCovered, testCtrlCmdCIsChangesInTheTableAndTheMenu:
// one path, the View menu's item), and the window on the hooks host with a
// fake bridge: the third segment (an agent's only), ⌃⌘C to Changes and back to
// the view it covered, the sidebar's Changes entry opening the across-agents
// screen, a row there opening that agent in Changes, and the app commands the
// captures use.

import { afterEach, describe, expect, it, vi } from "vitest";

import { viewMenuItems } from "../src/main/view-menu";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { changesToggled, coveredAfter, shownTab } from "../src/shared/changes/tabs";
import type { AppCommand, HostView, MainTab } from "../src/shared/ipc-contract";
import { isViewCommand, nextFontSize, type ViewCommand } from "../src/shared/view-commands";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { App } = await import("../src/renderer/App");

describe("⌃⌘C", () => {
  it("opens Changes and goes back to the view it covered", () => {
    let tab: MainTab = "terminal";
    let covered: MainTab | null = null;
    const press = (): void => {
      const next = changesToggled(tab, true, covered);
      expect(next).not.toBeNull();
      covered = coveredAfter(next!, tab, covered);
      tab = next!;
    };
    press();
    expect(tab).toBe("changes");
    expect(covered).toBe("terminal");
    press();
    expect(tab, "back to Terminal, not Chat").toBe("terminal");
    expect(covered).toBeNull();
    tab = "chat";
    press();
    press();
    expect(tab).toBe("chat");
    // Opened in Changes (from the across-agents screen): Chat.
    expect(changesToggled("changes", true, null)).toBe("chat");
    // Picking Changes again from Changes keeps what it covers; another view drops it.
    expect(coveredAfter("changes", "changes", "terminal")).toBe("terminal");
    expect(coveredAfter("chat", "changes", "terminal")).toBeNull();
  });

  it("has no Changes on a plain shell", () => {
    expect(changesToggled("terminal", false, null)).toBeNull();
    expect(changesToggled("changes", false, "chat")).toBeNull();
    expect(shownTab("changes", false)).toBe("terminal");
    expect(shownTab("changes", true)).toBe("changes");
    // A shell has no switch, so it always shows its terminal.
    expect(shownTab("chat", false)).toBe("terminal");
  });

  it("is the View menu's Changes item, one path to the page", () => {
    const sent: ViewCommand[] = [];
    const item = viewMenuItems((command) => sent.push(command), true).find((candidate) => candidate.label === "Changes");
    expect(item?.accelerator).toBe("Ctrl+Cmd+C");
    (item!.click as () => void)();
    expect(sent).toEqual(["toggle-changes"]);
    expect(viewMenuItems(() => undefined, false).find((candidate) => candidate.label === "Changes")?.accelerator).toBe("Ctrl+Alt+C");
    expect(isViewCommand("toggle-changes")).toBe(true);
    expect(nextFontSize(15, "toggle-changes")).toBe(15);
  });
});

// MARK: - the window

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
  const done: string[] = [];
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
      appCommandDone: (id: string) => done.push(id),
      changesAgent: async () => null,
      changesDiff: async () => null,
      changesOverview: async () => null,
      closeChanges: () => undefined,
      copyText: () => undefined,
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
  const main = () => byName(app.tree, "MainPane");
  return {
    app,
    main,
    tab: () => main()?.props["tab"] as MainTab,
    select: (paneId: string) => (byName(app.tree, "Sidebar")!.props["onSelect"] as (h: string, p: string) => void)("host", paneId),
    view: (c: ViewCommand) => view(c),
    command: (c: AppCommand) => command(c),
    done,
  };
}

/** MainPane as App gives it, on its own host. */
function mainPane(props: Record<string, unknown>) {
  const element = { ...props };
  const type = (async () => (await import("../src/renderer/components/MainPane")).MainPane)();
  return type.then((MainPane) => {
    const host = new HookHost(MainPane as (props: object) => unknown, element);
    host.render();
    return host;
  });
}

describe("Chat | Terminal | Changes", () => {
  it("shows the third segment on an agent pane only, and Changes as the agent's Changes view", async () => {
    const w = await window_();
    w.select("w1:p1");
    const pane = await mainPane(w.main()!.props);
    const segments = elements(pane.tree).filter((e) => e.type === "button" && (e.props["className"] === "on" || e.props["className"] === ""));
    // The middle tab names the agent's own screen (its words in a span).
    const words = (node: unknown): string =>
      typeof node === "string" ? node : Array.isArray(node) ? node.map(words).join("") : typeof node === "object" && node !== null ? words((node as { props?: { children?: unknown } }).props?.children) : "";
    const labels = segments.map((e) => words(e.props.children));
    expect(labels).toEqual(["Chat", "Claude Code", "Changes"]);
    const tabs: MainTab[] = [];
    pane.render({ ...w.main()!.props, onTab: (t: MainTab) => tabs.push(t) });
    const changes = elements(pane.tree).find((e) => e.type === "button" && Array.isArray(e.props.children) && e.props.children.includes("Changes"))!;
    (changes.props["onClick"] as () => void)();
    expect(tabs).toEqual(["changes"]);
    pane.render({ ...w.main()!.props, tab: "changes" });
    const view = byName(pane.tree, "ChangesView");
    expect(view?.props).toMatchObject({ hostId: "host", paneId: "w1:p1", kind: "claude", folder: "/fixture", working: true });
    expect(byName(pane.tree, "TerminalTab")).toBeUndefined();
    expect(byName(pane.tree, "Composer"), "Changes has no message box").toBeUndefined();

    w.select("w1:p2");
    const shell = await mainPane({ ...w.main()!.props, tab: "changes" });
    const shellLabels = elements(shell.tree).filter((e) => e.type === "button" && Array.isArray(e.props.children) && e.props.children.includes("Changes"));
    expect(shellLabels).toEqual([]);
    expect(byName(shell.tree, "ChangesView")).toBeUndefined();
    expect(byName(shell.tree, "TerminalTab")).toBeDefined();
  });

  it("⌃⌘C goes to Changes and back to the view it covered; a shell ignores it", async () => {
    const w = await window_();
    w.select("w1:p1");
    // An agent pane opens in Chat (the per-pane views).
    expect(w.tab()).toBe("chat");
    w.view("toggle-changes");
    expect(w.tab()).toBe("changes");
    w.view("toggle-changes");
    expect(w.tab()).toBe("chat");
    (w.main()!.props["onTab"] as (t: MainTab) => void)("terminal");
    w.view("toggle-changes");
    expect(w.tab()).toBe("changes");
    w.view("toggle-changes");
    expect(w.tab()).toBe("terminal");
    // A shell opens in its terminal and ignores ⌃⌘C.
    w.select("w1:p2");
    w.view("toggle-changes");
    expect(w.tab()).toBe("terminal");
  });

  // Changes follows the per-pane view rule (the Swift app's CompanionPaneModeMemory keeps .changes).
  it("keeps Changes as the pane's view; another pane keeps its own; coming back, what it covered is not known", async () => {
    const w = await window_();
    w.select("w1:p1");
    (w.main()!.props["onTab"] as (t: MainTab) => void)("terminal");
    w.view("toggle-changes");
    expect(w.tab()).toBe("changes");
    w.select("w1:p2");
    expect(w.tab()).toBe("terminal");
    w.select("w1:p1");
    expect(w.tab(), "the pane's pick kept").toBe("changes");
    // As the Swift app's loadPaneMode: opening the pane again forgets what Changes covered, so ⌃⌘C goes to Chat.
    w.view("toggle-changes");
    expect(w.tab()).toBe("chat");
  });

  it("opens the across-agents screen from the View menu, and a row opens that agent in Changes", async () => {
    const w = await window_();
    // The sidebar has no Changes card; View > What Each Agent Changed opens the screen.
    w.view("open-changes");
    const overview = byName(w.app.tree, "ChangesOverview");
    expect(overview).toBeDefined();
    expect(w.main()).toBeUndefined();
    (overview!.props["onOpenAgent"] as (h: string, p: string) => void)("host", "w1:p1");
    expect(byName(w.app.tree, "ChangesOverview")).toBeUndefined();
    expect(w.main()?.props["row"]).toMatchObject({ paneID: "w1:p1" });
    expect(w.tab()).toBe("changes");
    // ⌃⌘C from there: Chat (what it covered is not known).
    w.view("toggle-changes");
    expect(w.tab()).toBe("chat");
    w.view("open-changes");
    (byName(w.app.tree, "ChangesOverview")!.props["onClose"] as () => void)();
    expect(byName(w.app.tree, "ChangesOverview")).toBeUndefined();
    expect(w.main()).toBeDefined();
    // Selecting a pane in the sidebar leaves the screen.
    w.view("open-changes");
    w.select("w1:p1");
    expect(byName(w.app.tree, "ChangesOverview")).toBeUndefined();
  });

  // Send to… opens its target in its view; Changes has no message box, so a draft lands in Chat.
  it("lands a hand-off for a pane showing Changes in its Chat, where the draft shows", async () => {
    const w = await window_();
    w.select("w1:p1");
    w.view("toggle-changes");
    expect(w.tab()).toBe("changes");
    w.select("w1:p2");
    w.command({ id: "h1", type: "open-handoff", hostId: "host", paneId: "w1:p2", text: "the build is green" });
    w.command({ id: "h2", type: "pick-handoff", hostId: "host", paneId: "w1:p1", action: "draft" });
    await flush();
    expect(w.main()?.props["row"]).toMatchObject({ paneID: "w1:p1" });
    expect(w.tab()).toBe("chat");
    expect(byName(w.app.tree, "MainPane")).toBeDefined();
  });

  it("takes the captures' commands: the screen shown or not, and Changes as a tab", async () => {
    const w = await window_();
    w.command({ id: "1", type: "set-changes-overview", shown: true });
    expect(byName(w.app.tree, "ChangesOverview")).toBeDefined();
    w.command({ id: "2", type: "set-changes-overview", shown: false });
    expect(byName(w.app.tree, "ChangesOverview")).toBeUndefined();
    w.command({ id: "3", type: "select-pane", hostId: "host", paneId: "w1:p1" });
    // The agent pane opens in Chat; Terminal picked first, so Changes covers it.
    w.command({ id: "3b", type: "set-tab", tab: "terminal" });
    w.command({ id: "4", type: "set-tab", tab: "changes" });
    expect(w.tab()).toBe("changes");
    w.view("toggle-changes");
    expect(w.tab(), "back to the Terminal it covered").toBe("terminal");
    await flush();
    expect(w.done).toEqual(expect.arrayContaining(["1", "2", "3", "4"]));
  });
});
