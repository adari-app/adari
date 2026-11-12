// Pane and workspace management.
//
// An open menu keeps what it opened on. The header's More, a row's
// menu (taken before its Ghostty read) and a workspace header's menu take the
// machine's connection and the pane's binding (and the name shown) when they
// open; at the pick a changed pane or a reconnect is refused with the
// binding's note and nothing is sent, and ConfirmClose and the rename field
// carry that same binding to the main process.
//
// Rename follows the Swift app's target (SidebarModel.swift
// renameTarget, WorkspaceActions.swift rename, HerdrClient.swift renameTab):
// the tab when the row's shown name is its tab's label, else the pane; one
// tab.rename {tab_id, label} bound to the pane's tab, never null.
//
// While a rename field is open it owns every key. App's window
// capture listener (⌘N, ⇧⌘N, ⌘F, ⌘J, the tile keys) and the native menu's
// commands do nothing; Esc's owners still see the field.
//
// Focus goes back. After Return or Esc the field gives the
// keyboard back to the terminal or Composer it was on before the menu or the
// field took it, if it is still there; a click away leaves it where the
// user clicked; a field replaced by another gives nothing back.

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
import { findRow } from "../src/shared/desktop-sidebar";
import type { HostView, PaneAction } from "../src/shared/ipc-contract";
import { bindingTexts, rowBindingOf } from "../src/shared/pane-binding";
import { HookHost, elements } from "./support/fake-hooks";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { fixturePanes, host, machine, mainPane, moreMenu, named, one, page, single, type MenuEntry } from "./support/manage-page";

const { layoutStore } = await import("../src/renderer/split/layout-store");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
const { startCommandsStore } = await import("../src/renderer/components/resume");
const { unmountPanes } = await import("./support/manage-page");
const { Sidebar } = await import("../src/renderer/components/Sidebar");
const { RenameField } = await import("../src/renderer/components/RenameField");
const { escapeOwners, keyOwners } = await import("../src/renderer/components/escape-owners");
const focusModule = await import("../src/renderer/components/focus-return").catch(() => null);

let cleanups: (() => void)[] = [];

beforeEach(() => {
  layoutStore.reset();
  escapeOwners.reset();
  // (Optional only so a build without keyOwners still gets to its tests.)
  keyOwners?.reset();
  focusModule?.focusReturn.reset();
});

afterEach(() => {
  for (const run of cleanups.splice(0)) run();
  unmountPanes();
  startCommandsStore.clear();
  handoffStore.reset();
  vi.unstubAllGlobals();
});

async function open(options: Parameters<typeof page>[0] = {}) {
  const p = await page(options);
  cleanups.push(p.unmount);
  return p;
}

type Page = Awaited<ReturnType<typeof open>>;
const save = (p: Page, text: string) => (p.sidebar()["onRenameSave"] as (text: string) => void)(text);

/** `host` with `paneId` changed by `change` (its terminal replaced, moved to another tab). */
function changedPane(paneId: string, change: Record<string, unknown>): HostView {
  return { ...host, topology: { ...host.topology!, panes: host.topology!.panes.map((pane) => (pane.paneID === paneId ? { ...pane, ...change } : pane)) } };
}

const changes: readonly [string, HostView, string][] = [
  ["its terminal is replaced", changedPane("w1:p4", { terminalID: "replacement" }), bindingTexts.terminal],
  ["it moves to another tab", changedPane("w1:p4", { tabID: "w1:t2" }), bindingTexts.moved],
  ["the machine reconnects", { ...host, connection: 4, epoch: 6 }, bindingTexts.reconnected],
];

describe("an open menu keeps the pane, workspace and connection it opened on", () => {
  for (const [what, changed, note] of changes) {
    it(`a row's Close pane, picked after ${what}, sends nothing and says why`, async () => {
      const p = await open();
      await p.rowMenu("w1:p4");
      p.hosts([changed]);
      p.pick("Close pane");
      expect(p.actions).toEqual([]);
      expect(p.toast()).toBe(`Not closed: ${note}`);
    });

    it(`a row's Rename…, picked after ${what}, opens no field and sends nothing`, async () => {
      const p = await open();
      await p.rowMenu("w1:p4");
      p.hosts([changed]);
      p.pick("Rename…");
      expect(p.sidebar()["renaming"]).toBeNull();
      save(p, "replacement name");
      expect(p.actions).toEqual([]);
      expect(p.toast()).toBe(`Not renamed: ${note}`);
    });
  }

  it("a row's menu takes the pane before Ghostty's availability is read: a change during the read is refused", async () => {
    const p = await open();
    let answer: (() => void) | null = null;
    const bridge = (window as unknown as { herdrDesktop: Record<string, unknown> }).herdrDesktop;
    bridge["ghosttyInfo"] = () => new Promise((resolve) => (answer = () => resolve({ shown: false })));
    (p.sidebar()["onRowMenu"] as (h: string, pane: string, x: number, y: number) => void)("host", "w1:p4", 10, 10);
    await Promise.resolve();
    p.hosts([changedPane("w1:p4", { terminalID: "replacement" })]);
    answer!();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    p.pick("Close pane");
    expect(p.actions).toEqual([]);
    expect(p.toast()).toBe(`Not closed: ${bindingTexts.terminal}`);
  });

  it("a row's Rename… keeps the name shown when the menu opened and its binding, sent as kept", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p4", initial: "shell" });
    save(p, "build log");
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]![1]).toMatchObject({ type: "rename", paneId: "w1:p4", label: "build log", binding: { terminalID: "term3", tabId: "w1:t3", epoch: 5 } });
  });

  it("the field opened, a reconnect before Return refuses it as before", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    p.hosts([{ ...host, connection: 4, epoch: 6 }]);
    save(p, "build log");
    expect(p.actions).toEqual([]);
    expect(p.toast()).toBe(`Not renamed: ${bindingTexts.reconnected}`);
  });

  it("a workspace header's Rename workspace…, picked after a reconnect, opens no field and sends nothing", async () => {
    const p = await open();
    p.workspaceMenu("w1");
    p.hosts([{ ...host, connection: 4, epoch: 6 }]);
    p.pick("Rename workspace…");
    expect(p.sidebar()["renaming"]).toBeNull();
    save(p, "another workspace");
    expect(p.calls).toEqual([]);
    expect(p.toast()).toBe(`Not renamed: ${bindingTexts.reconnected}`);
  });

  it("a workspace header's menu keeps the name shown when it opened", async () => {
    const p = await open();
    p.workspaceMenu("w1");
    p.pick("Rename workspace…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "ws:host/w1", initial: "app" });
  });

  for (const [what, changed, note] of changes) {
    it(`the header's More: Close pane picked after ${what} sends nothing`, async () => {
      const p = await open();
      p.select("w1:p4");
      p.layout(single("w1:p4", "w1:t3"), "w1:p4");
      const first = p.main()!;
      const view = await mainPane(first);
      moreMenu(view);
      p.hosts([changed]);
      view.render(p.main() ?? first);
      const items = one(view.tree, "ContextMenu")!.props["items"] as MenuEntry[];
      items.find((item) => item.label === "Close pane")!.onSelect();
      expect(p.actions).toEqual([]);
      expect(p.toast()).toBe(`Not closed: ${note}`);
    });
  }

  it("the header's More: Rename… picked after the terminal is replaced opens no field", async () => {
    const p = await open();
    p.select("w1:p4");
    p.layout(single("w1:p4", "w1:t3"), "w1:p4");
    const view = await mainPane(p.main()!);
    moreMenu(view);
    p.hosts([changedPane("w1:p4", { terminalID: "replacement" })]);
    view.render(p.main()!);
    (one(view.tree, "ContextMenu")!.props["items"] as MenuEntry[]).find((item) => item.label === "Rename…")!.onSelect();
    expect(p.sidebar()["renaming"]).toBeNull();
    expect(p.toast()).toBe(`Not renamed: ${bindingTexts.terminal}`);
  });

  it("the header's More, the pane unchanged: Close pane sends the binding taken when More opened (the tab's, not a row's)", async () => {
    const p = await open();
    p.select("w1:p4");
    p.layout(single("w1:p4", "w1:t3"), "w1:p4");
    const view = await mainPane(p.main()!);
    moreMenu(view)!.find((item) => item.label === "Close pane")!.onSelect();
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]![1]).toMatchObject({ type: "close", paneId: "w1:p4", binding: { terminalID: "term3", tabId: "w1:t3" } });
    expect(p.actions[0]![1]).not.toHaveProperty("from");
  });

  it("a working agent's Close from a row's menu: ConfirmClose's yes sends the binding the menu opened on", async () => {
    const p = await open();
    await p.rowMenu("w1:p1");
    p.pick("Close pane");
    const confirm = one(p.app.tree, "ConfirmClose")!;
    p.hosts([{ ...host, epoch: 9 }]);
    (confirm.props["onConfirm"] as () => void)();
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]![1]).toMatchObject({ type: "close", paneId: "w1:p1", from: "row", binding: { epoch: 5 } });
  });

  it("the same pane id on two machines: each menu stays on its own machine", async () => {
    const other: HostView = { ...host, id: "other", name: "Other Mac" };
    const p = await open({ hosts: [host, other] });
    await p.rowMenu("w1:p4", "other");
    p.pick("Close pane");
    await p.rowMenu("w1:p4", "other");
    p.pick("Rename…");
    save(p, "other label");
    expect(p.actions.map(([id, action]) => [id, action.type])).toEqual([
      ["other", "close"],
      ["other", "rename"],
    ]);
  });
});

/** `host` with these tabs' labels (Herdr's tab names) and these panes' own labels. */
function labelled(tabs: Record<string, string>, panes: Record<string, string> = {}): HostView {
  const base = machine(fixturePanes.map((pane) => (panes[pane.id] === undefined ? pane : { ...pane, label: panes[pane.id] })));
  return { ...base, topology: { ...base.topology!, tabs: base.topology!.tabs.map((tab) => (tabs[tab.tabID] === undefined ? tab : { ...tab, label: tabs[tab.tabID]! })) } };
}

/** The open field's tip and label, as the sidebar draws it. */
function fieldShown(p: Page): { hint: unknown; label: unknown } | null {
  const view = new HookHost<object>(Sidebar as (props: object) => unknown, p.sidebar());
  view.render();
  const field = named(view.tree, "RenameField")[0];
  view.unmount();
  return field === undefined ? null : { hint: field.props["hint"], label: field.props["label"] };
}

describe("Rename renames what Herdr shows the name from (the Swift renameTarget)", () => {
  it("a row named for its tab renames the tab: one tab.rename target, the bound pane's tab, the tip says tab", async () => {
    const p = await open({ hosts: [labelled({ "w1:t3": "Docs Opus" })] });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p4", initial: "Docs Opus", target: "tab" });
    expect(fieldShown(p)).toEqual({ hint: "Return saves · Esc cancels · renames the tab in Herdr", label: "Rename tab Docs Opus" });
    save(p, "Docs Fable");
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]![1]).toMatchObject({ type: "rename", target: "tab", tabId: "w1:t3", paneId: "w1:p4", label: "Docs Fable", binding: { tabId: "w1:t3" } });
  });

  it("a pane with its own label renames the pane, in a named tab too; clearing it sends null", async () => {
    const p = await open({ hosts: [labelled({ "w1:t3": "Docs Opus" }, { "w1:p4": "build log" })] });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p4", initial: "build log" });
    expect(fieldShown(p)?.hint).toBe("Return saves · Esc cancels · renames the pane in Herdr");
    save(p, "  ");
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]![1]).toMatchObject({ type: "rename", paneId: "w1:p4", label: null });
    expect(p.actions[0]![1]).not.toHaveProperty("target");
  });

  it("an agent or a shell named for its kind (its tab unnamed) renames the pane", async () => {
    const p = await open();
    for (const paneId of ["w1:p3", "w1:p4"]) {
      await p.rowMenu(paneId);
      p.pick("Rename…");
      save(p, `${paneId} name`);
    }
    expect(p.actions.map(([, action]) => [action.paneId, "target" in action ? action.target : "pane"])).toEqual([
      ["w1:p3", "pane"],
      ["w1:p4", "pane"],
    ]);
  });

  it("two unlabelled rows of one named tab (a split) rename the same tab, each from its own row's field", async () => {
    const p = await open({ hosts: [labelled({ "w1:t1": "Pair" })] });
    await p.rowMenu("w1:p1");
    p.pick("Rename…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p1", initial: "Pair", target: "tab" });
    save(p, "Pair A");
    await p.rowMenu("w1:p2");
    p.pick("Rename…");
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p2", initial: "Pair", target: "tab" });
    save(p, "Pair B");
    expect(p.actions.map(([, action]) => [action.paneId, "tabId" in action ? action.tabId : null, action.type === "rename" ? action.label : null])).toEqual([
      ["w1:p1", "w1:t1", "Pair A"],
      ["w1:p2", "w1:t1", "Pair B"],
    ]);
  });

  it("a tab's name is never cleared: a blank name is refused with a note and nothing is sent", async () => {
    const p = await open({ hosts: [labelled({ "w1:t3": "Docs Opus" })] });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    save(p, "   ");
    expect(p.actions).toEqual([]);
    expect(p.toast()).toBe("Not renamed: a tab needs a name.");
  });

  it("a tab-named row's pane moved to another tab while the field is open: refused, nothing sent", async () => {
    const shown = labelled({ "w1:t3": "Docs Opus" });
    const p = await open({ hosts: [shown] });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    p.hosts([{ ...shown, topology: { ...shown.topology!, panes: shown.topology!.panes.map((pane) => (pane.paneID === "w1:p4" ? { ...pane, tabID: "w1:t2" } : pane)) } }]);
    save(p, "Docs Fable");
    expect(p.actions).toEqual([]);
    expect(p.toast()).toBe(`Not renamed: ${bindingTexts.moved}`);
  });

  it("main takes a tab's rename only for the bound pane's tab, with a name", () => {
    const binding = rowBindingOf(host, "w1:p4")!;
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "x", binding, target: "tab", tabId: "w1:t3" })).toBe(true);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: null, binding, target: "tab", tabId: "w1:t3" })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "x", binding, target: "tab", tabId: "w1:t1" })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "x", binding, target: "tab" })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "x", binding, target: "workspace", tabId: "w1:t3" })).toBe(false);
    expect(isPaneAction({ type: "rename", paneId: "w1:p4", label: "x", binding, tabId: "w1:t3" })).toBe(false);
  });

  it("the demo's Herdr: tab.rename {tab_id, label} renames Notes Opus's tab, tab.renamed told; an unknown tab or a blank name refused", async () => {
    const registry = new HostRegistry(() => undefined);
    const fixtures = bundledFixturesForTests();
    for (const one of demoHosts(fixtures, Date.now())) {
      registry.add(one.descriptor, new DemoBackend(one, fixtures, { schedule: (run) => (run(), () => undefined) }));
    }
    await registry.refreshAll();
    const backend = registry.backend(demoHostIds.macMini) as DemoBackend;
    const events: string[] = [];
    backend.transport.onEvent((kind) => events.push(kind));
    const view = () => registry.list().find((candidate) => candidate.id === demoHostIds.macMini)!;
    const name = (paneId: string) => findRow(registry.list(), demoHostIds.macMini, paneId, { nowUnixMs: Date.now() })!;
    expect(name("w2:p70")).toMatchObject({ name: "Notes Opus", nameSource: "tabLabel" });
    const layouts = { reread: async () => undefined, accept: () => undefined, watched: () => null };
    const binding = rowBindingOf(view(), "w2:p70")!;
    await runPaneAction(registry, layouts, { id: 1 }, demoHostIds.macMini, { type: "rename", paneId: "w2:p70", label: "Notes Opus 4.7", binding, target: "tab", tabId: binding.tabId } as PaneAction);
    const sent = backend.transport.requests.map((line) => JSON.parse(line) as { method: string; params: unknown }).filter((request) => request.method.endsWith(".rename")).map(({ method, params }) => ({ method, params }));
    expect(sent).toEqual([{ method: "tab.rename", params: { tab_id: binding.tabId, label: "Notes Opus 4.7" } }]);
    expect(events).toEqual(["tab.renamed"]);
    expect(name("w2:p70")).toMatchObject({ name: "Notes Opus 4.7", nameSource: "tabLabel" });
    await expect(backend.paneActions().renameTab!("w404:t1", "x")).rejects.toThrow("no such tab");
    await expect(backend.paneActions().renameTab!(binding.tabId, "  ")).rejects.toThrow("label must not be empty");
  });
});

/** The field the sidebar draws for the open rename, mounted (its hooks run: it holds Esc and the keys). */
function mountField(p: Page): HookHost<object> {
  const renaming = p.sidebar()["renaming"] as { key: string; initial: string } | null;
  expect(renaming).not.toBeNull();
  // As the sidebar draws it: its save and cancel name its own slot.
  const key = renaming!.key;
  const field = new HookHost<object>(RenameField as (props: object) => unknown, {
    initial: renaming!.initial,
    label: "Rename",
    onSave: (text: string) => (p.sidebar()["onRenameSave"] as (text: string, key: string) => void)(text, key),
    onCancel: () => (p.sidebar()["onRenameCancel"] as (key: string) => void)(key),
  });
  field.render();
  cleanups.push(() => field.unmount());
  return field;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("an open rename field owns every shortcut", () => {
  it("⌘N, ⇧⌘N, ⌘F, ⇧⌘F and ⌘J do nothing while it is open (nothing taken, no dialog, no search); once it closes they work", async () => {
    const p = await open();
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    const field = mountField(p);
    expect(escapeOwners.any()).toBe(true);
    for (const key of [{ key: "n" }, { key: "N", shiftKey: true }, { key: "f" }, { key: "F", shiftKey: true }, { key: "j" }]) {
      expect(p.key({ ...key, metaKey: true })).toBe(false);
    }
    expect(one(p.app.tree, "NewAgentDialog")).toBeUndefined();
    expect(one(p.app.tree, "NewWorkspaceDialog")).toBeUndefined();
    expect(one(p.app.tree, "SearchScreen")).toBeUndefined();
    expect(p.sidebar()["search"]).toBeNull();
    expect(p.sidebar()["renaming"]).not.toBeNull();
    field.unmount();
    await tick();
    expect(p.key({ key: "n", metaKey: true })).toBe(true);
    expect(one(p.app.tree, "NewAgentDialog")).toBeDefined();
  });

  it("the tile keys (⌘1-⌘4, ⌃⌘ arrows) do nothing while it is open", async () => {
    const p = await open();
    p.select("w1:p1");
    p.layout({ ...single("w1:p1", "w1:t1"), panes: [{ paneId: "w1:p1", rect: { x: 0, y: 0, width: 67, height: 45 }, focused: true }, { paneId: "w1:p2", rect: { x: 67, y: 0, width: 67, height: 45 }, focused: false }], splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 134, height: 45 } }] }, "w1:p1");
    expect(one(p.app.tree, "SplitView")).toBeDefined();
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    const field = mountField(p);
    expect(p.key({ key: "2", metaKey: true })).toBe(false);
    expect(p.key({ key: "ArrowRight", metaKey: true, ctrlKey: true })).toBe(false);
    expect(one(p.app.tree, "SplitView")!.props["focusedPaneId"]).toBe("w1:p1");
    field.unmount();
    await tick();
    expect(p.key({ key: "2", metaKey: true })).toBe(true);
    expect(one(p.app.tree, "SplitView")!.props["focusedPaneId"]).toBe("w1:p2");
  });

  it("the native menu's commands (New Workspace…, the message box, text size, Changes) do nothing while it is open", async () => {
    const p = await open();
    p.select("w1:p3");
    p.layout(single("w1:p3", "w1:t2"), "w1:p3");
    const before = { box: p.main()!["boxShown"], font: p.main()!["fontSize"], tab: p.main()!["tab"] };
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    const field = mountField(p);
    for (const command of ["new-workspace", "toggle-box", "font-bigger", "font-smaller", "toggle-changes"] as const) p.view(command);
    expect(one(p.app.tree, "NewWorkspaceDialog")).toBeUndefined();
    expect({ box: p.main()!["boxShown"], font: p.main()!["fontSize"], tab: p.main()!["tab"] }).toEqual(before);
    field.unmount();
    await tick();
    p.view("new-workspace");
    expect(one(p.app.tree, "NewWorkspaceDialog")).toBeDefined();
  });
});

/** A text field in the window (the terminal's or the Composer's), recording each focus() on it. */
function textField(tagName: "TEXTAREA" | "INPUT", within: string | null = null) {
  const focused: string[] = [];
  return {
    tagName,
    type: "text",
    isConnected: true,
    focus: () => focused.push("focus"),
    closest: (selector: string) => (within !== null && selector.includes(within) ? {} : null),
    focused,
  };
}

/** The field's input, as React gives its keys and blur. */
function input(field: HookHost<object>) {
  const element = elements(field.tree).find((candidate) => candidate.type === "input")!;
  const press = (key: string) =>
    (element.props["onKeyDown"] as (event: unknown) => void)({ key, nativeEvent: { isComposing: false }, preventDefault: () => undefined, stopPropagation: () => undefined });
  return { press, blur: () => (element.props["onBlur"] as () => void)(), type: (text: string) => (element.props["onChange"] as (event: unknown) => void)({ target: { value: text } }) };
}

describe("the keyboard goes back where it was", () => {
  it("opened from the terminal (its text field noted by the window's focusin): Esc gives it the focus back", async () => {
    const p = await open();
    const terminal = textField("TEXTAREA", ".term-host");
    p.fire("focusin", { target: terminal });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    const field = mountField(p);
    input(field).press("Escape");
    expect(p.sidebar()["renaming"]).toBeNull();
    expect(terminal.focused).toEqual(["focus"]);
  });

  it("opened from the Composer (focused as the field opens): Return saves and gives it the focus back", async () => {
    const p = await open();
    const composer = textField("TEXTAREA");
    (document as unknown as { activeElement: unknown }).activeElement = composer;
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    const field = mountField(p);
    const keys = input(field);
    keys.type("build log");
    field.render();
    input(field).press("Enter");
    expect(p.actions.map(([, action]) => action.type)).toEqual(["rename"]);
    expect(composer.focused).toEqual(["focus"]);
  });

  it("a click away cancels and leaves the focus where the user clicked", async () => {
    const p = await open();
    const terminal = textField("TEXTAREA", ".term-host");
    p.fire("focusin", { target: terminal });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    input(mountField(p)).blur();
    expect(p.sidebar()["renaming"]).toBeNull();
    expect(terminal.focused).toEqual([]);
  });

  it("an owner no longer in the window gets nothing (the pane it was in closed)", async () => {
    const p = await open();
    const terminal = { ...textField("TEXTAREA", ".term-host"), isConnected: true };
    p.fire("focusin", { target: terminal });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    const field = mountField(p);
    terminal.isConnected = false;
    input(field).press("Escape");
    expect(terminal.focused).toEqual([]);
  });

  it("a field replaced by another gives nothing back; the new one gives it back on its own Esc", async () => {
    const p = await open();
    const terminal = textField("TEXTAREA", ".term-host");
    p.fire("focusin", { target: terminal });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    const first = mountField(p);
    await p.rowMenu("w1:p3");
    p.pick("Rename…");
    // The first field loses the focus to the menu and goes: its blur and its removal give nothing back.
    input(first).blur();
    first.unmount();
    expect(terminal.focused).toEqual([]);
    expect(p.sidebar()["renaming"]).toMatchObject({ key: "pane:host/w1:p3" });
    input(mountField(p)).press("Escape");
    expect(terminal.focused).toEqual(["focus"]);
  });

  it("a rename field's own input is never where the focus goes back to", async () => {
    const p = await open();
    const terminal = textField("TEXTAREA", ".term-host");
    p.fire("focusin", { target: terminal });
    p.fire("focusin", { target: textField("INPUT", "[data-rename]") });
    await p.rowMenu("w1:p4");
    p.pick("Rename…");
    input(mountField(p)).press("Escape");
    expect(terminal.focused).toEqual(["focus"]);
  });
});
