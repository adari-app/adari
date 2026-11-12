// Rename a pane. Rename… (a row's
// menu, the pane header's More) opens an inline field on the pane's sidebar
// row with its name selected (the sidebar unfolds, expands or leaves its
// search so the row shows); Return saves with one pane.rename on that
// machine's connection, bound like Close (a changed pane, a reconnect or a
// machine not answering refuses with a note and sends nothing); Esc or a click
// away cancels; an empty name sends label null, so Herdr's own name returns.
// The field owns Esc and the keys while it is open. The row and the header
// show the name the next snapshot brings: the pane's label first, as the Swift
// app's SidebarModel names a row (pane label, tab label, agent kind, shell).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { HerdrClient } from "../src/main/herdr/client";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { paneMethods } from "../src/main/herdr/pane-methods";
import type { HerdrTransport } from "../src/main/herdr/transport";
import { isPaneAction, runPaneAction, type PaneActionHosts } from "../src/main/pane-actions";
import { findRow } from "../src/shared/desktop-sidebar";
import type { DesktopSidebar } from "../src/shared/desktop-sidebar";
import type { HostView, PaneAction } from "../src/shared/ipc-contract";
import { bindingTexts, rowBindingOf } from "../src/shared/pane-binding";
import { renameLabel } from "../src/shared/pane-manage";
import { restartMenuLabel } from "../src/shared/agent-restart";
import { HookHost, elements } from "./support/fake-hooks";
import { fixturePanes, host, machine, mainPane, moreMenu, named, page, settle, single, unbound, unmountPanes } from "./support/manage-page";

const { layoutStore } = await import("../src/renderer/split/layout-store");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
const { startCommandsStore } = await import("../src/renderer/components/resume");
const { escapeOwners } = await import("../src/renderer/components/escape-owners");
const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { RenameField } = await import("../src/renderer/components/RenameField");

let cleanup: (() => void) | null = null;

beforeEach(() => {
  layoutStore.reset();
  escapeOwners.reset();
});

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

/** The Sidebar as App gives it, rendered on its own host. */
function sidebarView(props: Record<string, unknown>) {
  const view = new HookHost<object>(Sidebar as (props: object) => unknown, props);
  view.render();
  return view;
}

/** The rows' names the sidebar's model shows for the machine (Projects), in order. */
function shownNames(props: Record<string, unknown>): string[] {
  const sidebar = props["sidebar"] as DesktopSidebar;
  return sidebar.hosts.flatMap((section) => section.model?.projects.flatMap((project) => project.rows.map((candidate) => candidate.name)) ?? []);
}

/** A key event as React gives the field (what it calls is recorded). */
function key(name: string, calls: string[] = []) {
  return {
    key: name,
    nativeEvent: { isComposing: false },
    preventDefault: () => calls.push("preventDefault"),
    stopPropagation: () => calls.push("stopPropagation"),
  };
}

describe("Rename… in the menus", () => {
  it("the pane header's More: Rename…, Restart for an agent, Close pane", async () => {
    vi.stubGlobal("window", { herdrDesktop: { startCommands: () => new Promise(() => undefined) }, addEventListener: () => undefined, removeEventListener: () => undefined });
    const renames: string[] = [];
    const props = (paneId: string) => ({
      host,
      row: row(paneId),
      tab: "chat",
      onTab: () => undefined,
      mac: true,
      fontSize: 13,
      boxShown: false,
      onBoxShown: () => undefined,
      ghostty: { shown: false },
      onOpenInGhostty: () => undefined,
      onClose: () => undefined,
      onRename: () => renames.push(paneId),
    });
    const agent = moreMenu(await mainPane(props("w1:p3")))!;
    expect(agent.map((item) => item.label)).toEqual(["Rename…", restartMenuLabel, "Close pane"]);
    agent[0]!.onSelect();
    const shell = moreMenu(await mainPane(props("w1:p4")))!;
    expect(shell.map((item) => item.label)).toEqual(["Rename…", "Close pane"]);
    shell[0]!.onSelect();
    expect(renames).toEqual(["w1:p3", "w1:p4"]);
  });

  it("a row's menu: Rename… before Close pane, greyed with the reason while the machine does not answer", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    expect(p.menu()!.map((item) => item.label)).toEqual(["Rename…", "Close pane"]);
    const q = await open({ hosts: [machine(undefined, { state: "offline" })] });
    await q.rowMenu("w1:p4");
    expect(q.menu()!.map((item) => [item.label, item.disabledReason ?? null])).toEqual([
      ["Rename…", "Mac mini is not answering"],
      ["Close pane", "Mac mini is not answering"],
    ]);
    // Run anyway: no field, nothing sent, and why.
    q.menu()![0]!.onSelect();
    expect(q.sidebar()["renaming"]).toBeNull();
    expect(q.toast()).toBe("Not renamed: Mac mini is not answering.");
  });
});

describe("the inline field on the row", () => {
  it("opens on the row with its name, and Return sends one pane.rename with the new label", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p4", initial: "shell" });
    // The sidebar draws the field in the row's place, with the name in it.
    const drawn = sidebarView(p.sidebar());
    const fields = named(drawn.tree, "RenameField");
    expect(fields).toHaveLength(1);
    expect(fields[0]!.props["initial"]).toBe("shell");
    expect(named(drawn.tree, "Row").some((candidate) => candidate.props["rowKey"] === "host/w1:p4")).toBe(false);
    (p.sidebar()["onRenameSave"] as (text: string) => void)("  build log ");
    expect(p.actions.map(([hostId, action]) => [hostId, unbound(action)])).toEqual([["host", { type: "rename", paneId: "w1:p4", label: "build log" }]]);
    expect(p.actions[0]![1].binding).toEqual(rowBindingOf(host, "w1:p4"));
    expect(p.sidebar()["renaming"]).toBeNull();
  });

  it("an empty name sends label null (Herdr's own name returns); the same name sends nothing", async () => {
    const p = await open();
    await p.rowMenu("w1:p3");
    p.pick("Rename…");
    (p.sidebar()["onRenameSave"] as (text: string) => void)("   ");
    expect(p.actions.map(([, action]) => unbound(action))).toEqual([{ type: "rename", paneId: "w1:p3", label: null }]);
    await p.rowMenu("w1:p3");
    p.pick("Rename…");
    (p.sidebar()["onRenameSave"] as (text: string) => void)("claude");
    expect(p.actions).toHaveLength(1);
    expect(p.sidebar()["renaming"]).toBeNull();
    expect(renameLabel("  Docs Opus  ")).toBe("Docs Opus");
    expect(renameLabel(" \t ")).toBeNull();
  });

  it("Esc or a click away cancels and sends nothing", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    (p.sidebar()["onRenameCancel"] as () => void)();
    expect(p.sidebar()["renaming"]).toBeNull();
    expect(p.actions).toEqual([]);
    // The field itself: Esc is its own (prevented, stopped) and cancels; a blur cancels; once done, nothing more.
    const outcomes: string[] = [];
    const field = new HookHost<object>(RenameField as (props: object) => unknown, {
      initial: "shell",
      label: "Rename shell",
      onSave: (text: string) => outcomes.push(`save ${text}`),
      onCancel: () => outcomes.push("cancel"),
    });
    field.render();
    const input = () => elements(field.tree).find((candidate) => candidate.type === "input")!;
    const calls: string[] = [];
    (input().props["onKeyDown"] as (event: unknown) => void)(key("Escape", calls));
    expect(calls).toEqual(["stopPropagation", "preventDefault"]);
    (input().props["onBlur"] as () => void)();
    (input().props["onKeyDown"] as (event: unknown) => void)(key("Enter"));
    expect(outcomes).toEqual(["cancel"]);
    const blurred = new HookHost<object>(RenameField as (props: object) => unknown, { initial: "x", label: "Rename x", onSave: () => outcomes.push("save"), onCancel: () => outcomes.push("blur") });
    blurred.render();
    (elements(blurred.tree).find((candidate) => candidate.type === "input")!.props["onBlur"] as () => void)();
    expect(outcomes).toEqual(["cancel", "blur"]);
  });

  it("owns Esc and the keys while it is open: the terminal and the Composer get none", async () => {
    const outcomes: string[] = [];
    const field = new HookHost<object>(RenameField as (props: object) => unknown, {
      initial: "shell",
      label: "Rename shell",
      onSave: (text: string) => outcomes.push(`save ${text}`),
      onCancel: () => outcomes.push("cancel"),
    });
    field.render();
    // Held while open (the Composer's Stop on Esc and the window's Esc look here first).
    expect(escapeOwners.any()).toBe(true);
    const input = () => elements(field.tree).find((candidate) => candidate.type === "input")!;
    expect(input().props["autoFocus"]).toBe(true);
    for (const name of ["a", "ArrowLeft", "Backspace", "Tab", "c"]) {
      const calls: string[] = [];
      (input().props["onKeyDown"] as (event: unknown) => void)(key(name, calls));
      expect(calls).toEqual(["stopPropagation"]);
    }
    (input().props["onChange"] as (event: unknown) => void)({ target: { value: "build log" } });
    const calls: string[] = [];
    (input().props["onKeyDown"] as (event: unknown) => void)(key("Enter", calls));
    expect(calls).toEqual(["stopPropagation", "preventDefault"]);
    expect(outcomes).toEqual(["save build log"]);
    field.unmount();
    await settle();
    expect(escapeOwners.any()).toBe(false);
  });

  it("the header's Rename… opens the same field on the pane's row, the sidebar showing it", async () => {
    const p = await open();
    // w1 folded to its header, and a search that does not match: the row is not shown.
    (p.sidebar()["onToggleWorkspace"] as (h: string, w: string) => void)("host", "w1");
    (p.sidebar()["onSearch"] as (text: string | null) => void)("ops");
    p.select("w1:p3");
    p.layout(single("w1:p3", "w1:t2"), "w1:p3");
    (p.main()!["onRename"] as () => void)();
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p3", initial: "claude" });
    expect(p.sidebar()["search"]).toBeNull();
    const sections = (p.sidebar()["sidebar"] as DesktopSidebar).hosts[0]!.model!.projects;
    expect(sections.find((section) => section.header.workspaceID === "w1")!.rows.map((candidate) => candidate.paneID)).toContain("w1:p3");
    expect(named(sidebarView(p.sidebar()).tree, "RenameField")).toHaveLength(1);
    (p.sidebar()["onRenameSave"] as (text: string) => void)("Docs Opus");
    expect(p.actions.map(([, action]) => unbound(action))).toEqual([{ type: "rename", paneId: "w1:p3", label: "Docs Opus" }]);
  });

  it("in Priority, a shell's row is in Projects: the sidebar goes there for the field", async () => {
    const p = await open();
    (p.sidebar()["onMode"] as (mode: string) => void)("priority");
    await p.rowMenu("w1:p3");
    p.pick("Rename…");
    // An agent's row is in Priority: the field opens there.
    expect((p.sidebar()["sidebar"] as DesktopSidebar).mode).toBe("priority");
    expect(named(sidebarView(p.sidebar()).tree, "RenameField")).toHaveLength(1);
    (p.sidebar()["onRenameCancel"] as () => void)();
    p.select("w1:p4");
    p.layout(single("w1:p4", "w1:t3"), "w1:p4");
    (p.main()!["onRename"] as () => void)();
    expect((p.sidebar()["sidebar"] as DesktopSidebar).mode).toBe("projects");
    expect(named(sidebarView(p.sidebar()).tree, "RenameField")).toHaveLength(1);
  });
});

describe("refusals: nothing sent, and why", () => {
  it("the machine reconnected, the pane changed, or the machine stopped answering while the field was open", async () => {
    const p = await open();
    const cases: [HostView, string][] = [
      [{ ...host, connection: 4 }, bindingTexts.reconnected],
      [{ ...host, epoch: 6 }, bindingTexts.reconnected],
      [{ ...host, topology: { ...host.topology!, panes: host.topology!.panes.map((pane) => (pane.paneID === "w1:p4" ? { ...pane, terminalID: "another" } : pane)) } }, bindingTexts.terminal],
      [{ ...host, state: "offline" }, "Mac mini is not answering."],
    ];
    for (const [now, why] of cases) {
      p.hosts([host]);
      await p.rowMenu("w1:p4");
      p.pick("Rename…");
      p.hosts([now]);
      (p.sidebar()["onRenameSave"] as (text: string) => void)("build log");
      expect(p.actions).toEqual([]);
      expect(p.toast()).toBe(`Not renamed: ${why}`);
    }
  });

  it("the pane gone while the field is open: the field goes", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    p.hosts([machine(fixturePanes.filter((pane) => pane.id !== "w1:p4"))]);
    expect(p.sidebar()["renaming"]).toBeNull();
  });

  it("Herdr's refusal says why after Not renamed", async () => {
    const p = await open();
    p.answer(() => Promise.reject(new Error("Error invoking remote method 'herdr:pane-action': Error: That pane is no longer listed.")));
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    (p.sidebar()["onRenameSave"] as (text: string) => void)("build log");
    await settle();
    expect(p.toast()).toBe("Not renamed: That pane is no longer listed.");
  });
});

describe("the new name", () => {
  it("shows on the row and in the header once the snapshot after Herdr's event brings it", async () => {
    const p = await open();
    p.select("w1:p3");
    p.layout(single("w1:p3", "w1:t2"), "w1:p3");
    expect(shownNames(p.sidebar())).toEqual(["claude", "shell", "claude", "shell", "codex"]);
    (p.main()!["onRename"] as () => void)();
    (p.sidebar()["onRenameSave"] as (text: string) => void)("Docs Opus");
    // Until Herdr's answer the row keeps its name (nothing shown that Herdr has not said).
    expect(shownNames(p.sidebar())[2]).toBe("claude");
    p.hosts([machine(fixturePanes.map((pane) => (pane.id === "w1:p3" ? { ...pane, label: "Docs Opus" } : pane)))]);
    expect(shownNames(p.sidebar())[2]).toBe("Docs Opus");
    expect((p.main()!["row"] as { name: string }).name).toBe("Docs Opus");
    // The label cleared: Herdr's own name (the agent's kind here) again.
    p.hosts([host]);
    expect((p.main()!["row"] as { name: string }).name).toBe("claude");
  });

  it("a pane's label wins over its tab's label and its agent's kind, as the Swift app names a row", () => {
    const labelled = machine([{ id: "w1:p1", tab: "w1:t1", agent: "claude", status: "idle", label: "Docs Opus" }]);
    const withTab = { ...labelled, topology: { ...labelled.topology!, tabs: labelled.topology!.tabs.map((tab) => ({ ...tab, label: "workers 1" })) } };
    expect(row("w1:p1", withTab)).toMatchObject({ name: "Docs Opus", nameSource: "paneLabel" });
    const cleared = { ...withTab, topology: { ...withTab.topology, panes: withTab.topology.panes.map(({ label: _label, ...pane }) => pane) } };
    expect(row("w1:p1", cleared)).toMatchObject({ name: "workers 1", nameSource: "tabLabel" });
  });
});

// MARK: - The main process: one pane.rename on that machine's connection

class Recorder implements HerdrTransport {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  constructor(private readonly view: () => HostView) {}
  roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    this.sent.push({ method: request.method, params: request.params });
    const pane = this.view().topology!.panes.find((candidate) => candidate.paneID === request.params["pane_id"]);
    const area = { x: 0, y: 0, width: 134, height: 45 };
    const result =
      request.method === "pane.layout" && pane !== undefined
        ? { type: "pane_layout", layout: { area, focused_pane_id: pane.paneID, panes: [{ pane_id: pane.paneID, focused: true, rect: area }], splits: [], tab_id: pane.tabID, workspace_id: pane.workspaceID, zoomed: false } }
        : request.method === "pane.rename"
          ? { type: "pane_info", pane: { pane_id: request.params["pane_id"], workspace_id: "w1", tab_id: "w1:t3", focused: false, agent_status: "unknown", revision: 2 } }
          : { type: "ok" };
    return Promise.resolve(JSON.stringify({ id: request.id, result }));
  }
  close(): void {}
}

function machineHosts(options: { answering?: boolean; epoch?: number } = {}) {
  let view = host;
  const recorder = new Recorder(() => view);
  const client = new HerdrClient(recorder);
  const refreshes: string[] = [];
  const answering = options.answering ?? true;
  const hosts: PaneActionHosts = {
    backend: () => ({ paneActions: () => client }) as unknown as HerdrHostBackend,
    topology: () => view.topology,
    refresh: async (hostId) => {
      refreshes.push(hostId);
    },
    fresh: async () => answering,
    connection: () => (answering ? (view.connection ?? 0) : null),
    connectionIdentity: () => ({ incarnation: view.incarnation ?? 0, epoch: options.epoch ?? view.epoch ?? null }),
  };
  const layouts = { reread: async () => undefined, accept: () => undefined, watched: () => null };
  const rename = (paneId: string, label: string | null, binding = rowBindingOf(host, paneId)!) =>
    runPaneAction(hosts, layouts, { id: 1 }, "host", { type: "rename", paneId, label, binding } as PaneAction);
  const renames = () => recorder.sent.filter((request) => request.method === "pane.rename");
  return { hosts, recorder, refreshes, rename, renames, change: (next: HostView) => (view = next) };
}

describe("main's pane.rename", () => {
  it("is one request from the method table: pane_id and label, null to clear", async () => {
    const m = machineHosts();
    await m.rename("w1:p4", "build log");
    await m.rename("w1:p4", null);
    expect(m.renames()).toEqual([
      { method: "pane.rename", params: { pane_id: "w1:p4", label: "build log" } },
      { method: "pane.rename", params: { pane_id: "w1:p4", label: null } },
    ]);
    expect(paneMethods.rename).toMatchObject({ method: "pane.rename", status: "confirmed", used: true });
    // The snapshot is read again after each, so the row's new name shows.
    expect(m.refreshes).toEqual(["host", "host"]);
  });

  it("accepts only a well-formed rename bound to the pane it names", () => {
    const binding = rowBindingOf(host, "w1:p4")!;
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "build log", binding })).toBe(true);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: null, binding })).toBe(true);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "", binding })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "x".repeat(257), binding })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: 7, binding })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", binding })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p3", label: "x", binding })).toBe(false);
  });

  it("refuses, sending nothing, when the pane changed, the machine reconnected or does not answer", async () => {
    const changed = machineHosts();
    const binding = rowBindingOf(host, "w1:p4")!;
    await expect(changed.rename("w1:p4", "x", { ...binding, terminalID: "another" })).rejects.toThrow(bindingTexts.terminal);
    await expect(changed.rename("w1:p4", "x", { ...binding, agent: "claude" })).rejects.toThrow(bindingTexts.agentLeft("claude"));
    changed.change(machine(fixturePanes.filter((pane) => pane.id !== "w1:p4")));
    await expect(changed.rename("w1:p4", "x", binding)).rejects.toThrow(bindingTexts.gone);
    expect(changed.renames()).toEqual([]);
    const reconnected = machineHosts({ epoch: 6 });
    await expect(reconnected.rename("w1:p4", "x")).rejects.toThrow(bindingTexts.reconnected);
    expect(reconnected.renames()).toEqual([]);
    const offline = machineHosts({ answering: false });
    await expect(offline.rename("w1:p4", "x")).rejects.toThrow("The machine did not answer, so the pane could not be checked.");
    expect(offline.recorder.sent).toEqual([]);
  });
});
