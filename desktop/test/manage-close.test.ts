// Close from anywhere. The pane
// header's More (…) shows on every pane, agent or shell, in Chat, Terminal
// and Changes, and holds Restart (agents) and Close pane; a sidebar row's
// right-click menu holds Close pane on every row, plus Open in Ghostty where it
// is shown. Close is the existing path (askClose: ConfirmClose for a working
// agent, straight close otherwise, bound to the pane as shown; a row's close
// bound to the pane as the sidebar shows it). After a close the selection
// moves as split view's does, else to the nearest row in the same workspace,
// else nothing. Herdr closes a tab with its last pane, and a workspace with
// its last tab; the demo's Herdr does the same, and the app never closes them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { HostRegistry } from "../src/main/hosts";
import { isPaneAction, runPaneAction } from "../src/main/pane-actions";
import type { HostView, PaneAction } from "../src/shared/ipc-contract";
import { bindingTexts, rowBindingOf } from "../src/shared/pane-binding";
import { restartMenuLabel } from "../src/shared/agent-restart";
import { findRow } from "../src/shared/desktop-sidebar";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { host, machine, fixturePanes, mainPane, moreMenu, one, page, pair, settle, single, unbound, unmountPanes } from "./support/manage-page";

const { layoutStore } = await import("../src/renderer/split/layout-store");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
const { startCommandsStore } = await import("../src/renderer/components/resume");

let cleanup: (() => void) | null = null;

beforeEach(() => layoutStore.reset());

afterEach(() => {
  cleanup?.();
  cleanup = null;
  unmountPanes();
  startCommandsStore.clear();
  handoffStore.reset();
  vi.unstubAllGlobals();
});

async function open(options: Parameters<typeof page>[0] = {}) {
  const p = await page(options);
  // Every window a test opens is unmounted after it (its store subscriptions go with it).
  const before = cleanup;
  cleanup = () => {
    before?.();
    p.unmount();
  };
  return p;
}

const row = (paneId: string, on: HostView = host) => findRow([on], on.id, paneId, { nowUnixMs: 0 })!;

/** MainPane's props as App gives them, for `paneId` in `tab`. */
function paneProps(paneId: string, tab: "chat" | "terminal" | "changes", extra: Record<string, unknown> = {}) {
  vi.stubGlobal("window", { herdrDesktop: { startCommands: () => new Promise(() => undefined) }, addEventListener: () => undefined, removeEventListener: () => undefined });
  return {
    host,
    row: row(paneId),
    tab,
    onTab: () => undefined,
    mac: true,
    fontSize: 13,
    boxShown: false,
    onBoxShown: () => undefined,
    ghostty: { shown: false },
    onOpenInGhostty: () => undefined,
    ...extra,
  };
}

describe("the pane header's More", () => {
  for (const tab of ["chat", "terminal", "changes"] as const) {
    it(`shows on an agent and on a shell in ${tab}: Restart for the agent, Close pane on both`, async () => {
      const closes: string[] = [];
      const agent = await mainPane(paneProps("w1:p3", tab, { onClose: () => closes.push("w1:p3") }));
      const agentMenu = moreMenu(agent);
      expect(agentMenu?.map((item) => item.label)).toEqual([restartMenuLabel, "Close pane"]);
      agentMenu!.find((item) => item.label === "Close pane")!.onSelect();
      const shell = await mainPane(paneProps("w1:p4", tab, { onClose: () => closes.push("w1:p4") }));
      const shellMenu = moreMenu(shell);
      expect(shellMenu?.map((item) => item.label)).toEqual(["Close pane"]);
      shellMenu![0]!.onSelect();
      expect(closes).toEqual(["w1:p3", "w1:p4"]);
      // The menu closes as the item runs.
      expect(one(shell.tree, "ContextMenu")).toBeUndefined();
    });
  }

  it("greys Close pane with the reason while the machine does not answer", async () => {
    const offline = machine(undefined, { state: "offline" });
    const view = await mainPane({ ...paneProps("w1:p4", "terminal", { onClose: () => undefined }), host: offline, row: row("w1:p4", offline) });
    expect(moreMenu(view)?.map((item) => [item.label, item.disabledReason ?? null])).toEqual([["Close pane", "Mac mini is not answering"]]);
  });
});

describe("a sidebar row's menu", () => {
  it("holds Close pane on every row, Ghostty or not", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    expect(p.menu()?.map((item) => item.label)).toEqual(["Rename…", "Close pane"]);
    await p.rowMenu("w1:p1");
    expect(p.menu()?.map((item) => item.label)).toEqual(["Rename…", "Close pane"]);
  });

  it("keeps Open in Ghostty first where it is shown today (greyed with its reason)", async () => {
    const p = await open({ ghostty: { shown: true, enabled: false, reason: "no SSH address" } });
    await p.rowMenu("w1:p3");
    expect(p.menu()?.map((item) => [item.label, item.disabledReason ?? null])).toEqual([
      ["Open in Ghostty", "no SSH address"],
      ["Rename…", null],
      ["Close pane", null],
    ]);
  });

  it("greys Close pane while the machine does not answer, and a close asked then sends nothing", async () => {
    const p = await open({ hosts: [machine(undefined, { state: "offline" })] });
    await p.rowMenu("w1:p4");
    expect(p.menu()?.map((item) => [item.label, item.disabledReason ?? null])).toEqual([
      ["Rename…", "Mac mini is not answering"],
      ["Close pane", "Mac mini is not answering"],
    ]);
    // Run anyway (the item is greyed; the page checks again): nothing is sent, and it says why.
    p.menu()!.find((item) => item.label === "Close pane")!.onSelect();
    expect(p.actions).toEqual([]);
    expect(p.toast()).toBe("Not closed: Mac mini is not answering.");
  });
});

describe("Close pane", () => {
  it("closes a shell and an idle agent from the header with one pane.close each, bound to the pane as shown", async () => {
    const p = await open();
    p.select("w1:p4");
    p.layout(single("w1:p4", "w1:t3"), "w1:p4");
    (p.main()!["onClose"] as () => void)();
    expect(p.actions.map(([hostId, action]) => [hostId, unbound(action)])).toEqual([["host", { type: "close", paneId: "w1:p4" }]]);
    expect(p.actions[0]![1].binding).toMatchObject({ connection: 3, incarnation: 2, epoch: 5, workspaceId: "w1", tabId: "w1:t3", paneId: "w1:p4", agent: null });
    p.select("w1:p3");
    p.layout(single("w1:p3", "w1:t2"), "w1:p3");
    (p.main()!["onClose"] as () => void)();
    expect(p.actions.map(([, action]) => unbound(action))).toEqual([
      { type: "close", paneId: "w1:p4" },
      { type: "close", paneId: "w1:p3" },
    ]);
    expect(p.actions[1]![1].binding).toMatchObject({ paneId: "w1:p3", tabId: "w1:t2", agent: "claude" });
  });

  it("asks once for a working agent: Close sends one pane.close, Cancel sends nothing", async () => {
    const p = await open();
    p.select("w1:p1");
    p.layout(single("w1:p1", "w1:t1"), "w1:p1");
    (p.main()!["onClose"] as () => void)();
    expect(p.actions).toEqual([]);
    expect(one(p.app.tree, "ConfirmClose")!.props["name"]).toBe("claude");
    (one(p.app.tree, "ConfirmClose")!.props["onCancel"] as () => void)();
    expect(one(p.app.tree, "ConfirmClose")).toBeUndefined();
    expect(p.actions).toEqual([]);
    (p.main()!["onClose"] as () => void)();
    (one(p.app.tree, "ConfirmClose")!.props["onConfirm"] as () => void)();
    expect(p.actions.map(([, action]) => unbound(action))).toEqual([{ type: "close", paneId: "w1:p1" }]);
  });

  it("closes a row the main area does not show, bound to the pane as the sidebar shows it", async () => {
    const p = await open();
    p.select("w1:p4");
    p.layout(single("w1:p4", "w1:t3"), "w1:p4");
    await p.rowMenu("w2:p5");
    p.pick("Close pane");
    expect(p.actions.map(([, action]) => unbound(action))).toEqual([{ type: "close", paneId: "w2:p5", from: "row" }]);
    expect(p.actions[0]![1].binding).toEqual(rowBindingOf(host, "w2:p5"));
    expect(p.actions[0]![1].binding).toMatchObject({ workspaceId: "w2", tabId: "w2:t1", agent: "codex" });
    // The selection stays where it was.
    await settle();
    expect(p.selectedKey()).toBe("host/w1:p4");
    // A working agent's row asks first, as the header does.
    await p.rowMenu("w1:p1");
    p.pick("Close pane");
    expect(p.actions).toHaveLength(1);
    (one(p.app.tree, "ConfirmClose")!.props["onConfirm"] as () => void)();
    expect(p.actions.map(([, action]) => unbound(action)).at(-1)).toEqual({ type: "close", paneId: "w1:p1", from: "row" });
  });

  it("a refusal says why after Not closed", async () => {
    const p = await open();
    p.select("w1:p4");
    p.layout(single("w1:p4", "w1:t3"), "w1:p4");
    p.answer(() => Promise.reject(new Error("Error invoking remote method 'herdr:pane-action': Error: That pane runs another terminal now.")));
    (p.main()!["onClose"] as () => void)();
    await settle();
    expect(p.toast()).toBe("Not closed: That pane runs another terminal now.");
    expect(p.selectedKey()).toBe("host/w1:p4");
  });
});

describe("the selection after a close", () => {
  /** The machine after Herdr closed `paneId` (its tab gone when it was the tab's last). */
  const without = (paneId: string) => machine(fixturePanes.filter((pane) => pane.id !== paneId));

  it("in split view, moves to another tile of the tab (as today)", async () => {
    const p = await open();
    p.select("w1:p2");
    p.layout(pair("w1:p2"), "w1:p2");
    p.answer(async () => {
      p.hosts([without("w1:p2")]);
      return { paneId: null };
    });
    (one(p.app.tree, "SplitView")!.props["onClose"] as (paneId: string) => void)("w1:p2");
    await settle();
    expect(p.selectedKey()).toBe("host/w1:p1");
  });

  it("the last pane shown: the nearest row in the same workspace (the next, else the one before)", async () => {
    const p = await open();
    p.select("w1:p3");
    p.layout(single("w1:p3", "w1:t2"), "w1:p3");
    p.answer(async () => {
      p.hosts([without("w1:p3")]);
      return { paneId: null };
    });
    (p.main()!["onClose"] as () => void)();
    await settle();
    // w1's rows: p1, p2, p3, p4: p3 gone, p4 is next.
    expect(p.selectedKey()).toBe("host/w1:p4");
    // p4 is w1's last row: the one before it.
    p.layout(single("w1:p4", "w1:t3"), "w1:p4");
    p.answer(async () => {
      p.hosts([machine(fixturePanes.filter((pane) => pane.id !== "w1:p3" && pane.id !== "w1:p4"))]);
      return { paneId: null };
    });
    (p.main()!["onClose"] as () => void)();
    await settle();
    expect(p.selectedKey()).toBe("host/w1:p2");
  });

  it("the workspace's last pane: nothing selected (the empty main area)", async () => {
    const p = await open();
    p.select("w2:p5");
    p.layout(single("w2:p5", "w2:t1", "w2"), "w2:p5");
    p.answer(async () => {
      p.hosts([without("w2:p5")]);
      return { paneId: null };
    });
    (p.main()!["onClose"] as () => void)();
    await settle();
    expect(p.selectedKey()).toBeNull();
    expect(one(p.app.tree, "EmptyState")).toBeDefined();
  });

  it("a refused close leaves the selection", async () => {
    const p = await open();
    p.select("w1:p3");
    p.layout(single("w1:p3", "w1:t2"), "w1:p3");
    p.answer(() => Promise.reject(new Error("The machine reconnected since the pane was shown.")));
    (p.main()!["onClose"] as () => void)();
    await settle();
    expect(p.selectedKey()).toBe("host/w1:p3");
  });
});

// MARK: - The main process, over the demo's Herdr

async function demo() {
  const registry = new HostRegistry(() => undefined);
  const fixtures = bundledFixturesForTests();
  for (const machine of demoHosts(fixtures, Date.now())) {
    registry.add(machine.descriptor, new DemoBackend(machine, fixtures, { schedule: (run) => (run(), () => undefined) }));
  }
  await registry.refreshAll();
  const backend = registry.backend(demoHostIds.macMini) as DemoBackend;
  const events: string[] = [];
  backend.transport.onEvent((kind, paneId) => events.push(`${kind} ${paneId ?? ""}`.trim()));
  // The window shows nothing (a row's close needs no tile).
  const layouts = { reread: async () => undefined, accept: () => undefined, watched: () => null };
  const view = () => registry.list().find((candidate) => candidate.id === demoHostIds.macMini)!;
  const close = (paneId: string, binding = rowBindingOf(view(), paneId)!) =>
    runPaneAction(registry, layouts, { id: 1 }, demoHostIds.macMini, { type: "close", paneId, binding, from: "row" } as PaneAction);
  const sent = () => backend.transport.requests.map((line) => (JSON.parse(line) as { method: string }).method).filter((method) => method === "pane.close");
  return { registry, backend, events, view, close, sent };
}

describe("a row's close in the main process", () => {
  it("is well formed only from a row, bound to the pane it names", () => {
    const binding = rowBindingOf(host, "w1:p4")!;
    expect(isPaneAction({ type: "close", paneId: "w1:p4", binding, from: "row" })).toBe(true);
    expect(isPaneAction({ type: "close", paneId: "w1:p4", binding, from: "elsewhere" })).toBe(false);
    expect(isPaneAction({ type: "close", paneId: "w1:p3", binding, from: "row" })).toBe(false);
  });

  it("binds a row to the pane as the snapshot shows it: its workspace, tab, terminal and agent", () => {
    const p3 = host.topology!.panes.find((pane) => pane.paneID === "w1:p3")!;
    expect(rowBindingOf(host, "w1:p3")).toEqual({ connection: 3, incarnation: 2, epoch: 5, workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3", terminalID: p3.terminalID, agent: "claude", session: null });
    expect(rowBindingOf(host, "w9:p9")).toBeNull();
  });

  it("closes a pane the window does not show with one pane.close", async () => {
    const d = await demo();
    expect(d.registry.pane(demoHostIds.macMini, "w7:pS2")).not.toBeNull();
    await d.close("w7:pS2");
    expect(d.sent()).toEqual(["pane.close"]);
    expect(d.registry.pane(demoHostIds.macMini, "w7:pS2")).toBeNull();
  });

  it("refuses, sending nothing, when the pane changed or the machine reconnected", async () => {
    const d = await demo();
    const binding = rowBindingOf(d.view(), "w7:pS2")!;
    await expect(d.close("w7:pS2", { ...binding, terminalID: "another" })).rejects.toThrow(bindingTexts.terminal);
    await expect(d.close("w7:pS2", { ...binding, epoch: (binding.epoch ?? 0) + 1 })).rejects.toThrow(bindingTexts.reconnected);
    await expect(d.close("w7:pS2", { ...binding, tabId: "w7:t1" })).rejects.toThrow(bindingTexts.moved);
    expect(d.sent()).toEqual([]);
  });

  it("Herdr closes the tab with its last pane, and the workspace with its last tab; the app closes neither", async () => {
    const d = await demo();
    const topology = () => d.registry.topology(demoHostIds.macMini)!;
    // Notes Opus is w2:t28's one pane; workspace w2 keeps Notes Fable's tab.
    await d.close("w2:p70");
    expect(topology().tabs.some((tab) => tab.tabID === "w2:t28")).toBe(false);
    expect(topology().workspaces.find((workspace) => workspace.workspaceID === "w2")).toMatchObject({ label: "Quartz" });
    // Workspace w8 has one tab of one pane: both go.
    await d.close("w8:p1");
    expect(topology().tabs.some((tab) => tab.tabID === "w8:t1")).toBe(false);
    expect(topology().workspaces.some((workspace) => workspace.workspaceID === "w8")).toBe(false);
    expect(d.sent()).toEqual(["pane.close", "pane.close"]);
    expect(d.events).toEqual(["pane.closed w2:p70", "tab.closed", "pane.closed w8:p1", "tab.closed", "workspace.closed"]);
  });
});
