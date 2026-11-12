// The demo's Herdr answers
// pane.rename and workspace.rename as Herdr 0.9.5 does (the schema's params,
// pane_info and workspace_info replies) and emits pane.updated and
// workspace.renamed, so the demo and the tests show a rename; the captures
// (58-61) drive the window to the More menu on a shell, a row's menu, a row in
// rename and a workspace header in rename, with nothing chosen.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }));

import { manageCaptureSteps } from "../src/main/capture";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { HostRegistry } from "../src/main/hosts";
import { runPaneAction, runWorkspaceRename } from "../src/main/pane-actions";
import { findRow } from "../src/shared/desktop-sidebar";
import type { PaneAction } from "../src/shared/ipc-contract";
import { rowBindingOf, workspaceBindingOf } from "../src/shared/pane-binding";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { host, mainPane, moreMenu, one, page, settle, unmountPanes } from "./support/manage-page";

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
  const layouts = { reread: async () => undefined, accept: () => undefined, watched: () => null };
  const view = () => registry.list().find((candidate) => candidate.id === demoHostIds.macMini)!;
  const name = (paneId: string) => findRow(registry.list(), demoHostIds.macMini, paneId, { nowUnixMs: Date.now() })?.name;
  const renamePane = (paneId: string, label: string | null) =>
    runPaneAction(registry, layouts, { id: 1 }, demoHostIds.macMini, { type: "rename", paneId, label, binding: rowBindingOf(view(), paneId)! } as PaneAction);
  const renameWorkspace = (workspaceId: string, label: string) =>
    runWorkspaceRename(registry, demoHostIds.macMini, { workspaceId, label, binding: workspaceBindingOf(view(), workspaceId)! });
  const sent = (method: string) => backend.transport.requests.map((line) => JSON.parse(line) as { method: string; params: unknown }).filter((request) => request.method === method);
  return { registry, backend, events, view, name, renamePane, renameWorkspace, sent };
}

describe("the demo's Herdr renames", () => {
  it("a pane: pane.rename sets its label, pane.updated told, the row's name follows; null clears it", async () => {
    const d = await demo();
    // Notes Opus is the name of its tab (New agent names the tab); the pane has no label.
    expect(d.name("w2:p70")).toBe("Notes Opus");
    await d.renamePane("w2:p70", "Notes Opus 4.7");
    expect(d.sent("pane.rename").map((request) => request.params)).toEqual([{ pane_id: "w2:p70", label: "Notes Opus 4.7" }]);
    expect(d.events).toEqual(["pane.updated w2:p70"]);
    expect(d.registry.pane(demoHostIds.macMini, "w2:p70")?.label).toBe("Notes Opus 4.7");
    expect(d.name("w2:p70")).toBe("Notes Opus 4.7");
    // Cleared: Herdr's own name (its tab's label) again.
    await d.renamePane("w2:p70", null);
    expect(d.registry.pane(demoHostIds.macMini, "w2:p70")?.label).toBeUndefined();
    expect(d.name("w2:p70")).toBe("Notes Opus");
    // A shell alone in its tab (named by the tab) takes a name too.
    expect(d.name("w8:p1")).not.toBe("usage log");
    await d.renamePane("w8:p1", "usage log");
    expect(d.name("w8:p1")).toBe("usage log");
  });

  it("a workspace: workspace.rename sets its label, workspace.renamed told, the header and rows follow", async () => {
    const d = await demo();
    await d.renameWorkspace("w2", "Quartz app");
    expect(d.sent("workspace.rename").map((request) => request.params)).toEqual([{ workspace_id: "w2", label: "Quartz app" }]);
    expect(d.events).toEqual(["workspace.renamed"]);
    expect(d.registry.topology(demoHostIds.macMini)!.workspaces.find((workspace) => workspace.workspaceID === "w2")?.label).toBe("Quartz app");
    expect(findRow(d.registry.list(), demoHostIds.macMini, "w2:p70", { nowUnixMs: Date.now() })?.workspaceLabel).toBe("Quartz app");
  });

  it("refuses what Herdr refuses: no such pane or workspace, a label of the wrong kind, a blank workspace name", async () => {
    const d = await demo();
    const client = d.backend.paneActions();
    await expect(client.renamePane("w9:p404", "x")).rejects.toThrow("no such pane");
    await expect(client.renameWorkspace("w404", "x")).rejects.toThrow("no such workspace");
    await expect(client.renameWorkspace("w2", "   ")).rejects.toThrow("label must not be empty");
    // Herdr trims: a padded name is kept trimmed; a blank pane label clears it.
    await client.renamePane("w8:p1", "  usage log  ");
    await d.registry.refreshAll();
    expect(d.registry.pane(demoHostIds.macMini, "w8:p1")?.label).toBe("usage log");
    await client.renamePane("w8:p1", "   ");
    await d.registry.refreshAll();
    expect(d.registry.pane(demoHostIds.macMini, "w8:p1")?.label).toBeUndefined();
  });
});

describe("the captures", () => {
  it("58-61: More on a shell, a row's menu, a row in rename, a workspace header in rename", () => {
    const steps = manageCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["58-more-menu-shell", "59-row-menu", "60-row-rename", "61-workspace-rename"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: "w8:p1" });
    expect(steps[0]!.after?.commands).toEqual([{ type: "click", selector: '.main [data-more="pane"]' }]);
    expect(steps[1]!.commands).toContainEqual({ type: "open-row-menu", hostId: demoHostIds.macMini, paneId: "w2:p70" });
    expect(steps[2]!.commands).toEqual([{ type: "rename-pane", hostId: demoHostIds.macMini, paneId: "w2:p70" }]);
    expect(steps[3]!.commands).toEqual([{ type: "rename-workspace", hostId: demoHostIds.macMini, workspaceId: "w2" }]);
    // Nothing is chosen: the only click opens More; no step picks a menu item, types or presses a key.
    const types = steps.flatMap((step) => [...step.commands, ...(step.after?.commands ?? [])]).map((command) => command.type);
    expect(new Set(types)).toEqual(new Set(["set-mode", "set-host-folded", "select-pane", "set-tab", "set-box", "click", "open-row-menu", "rename-pane", "rename-workspace"]));
  });

  it("the window's rename-pane and rename-workspace open the fields as the menu items do; a replaced field's late blur ends nothing", async () => {
    const p = await page();
    cleanup = p.unmount;
    p.command({ id: "c1", type: "rename-pane", hostId: "host", paneId: "w1:p4" });
    await settle();
    expect(p.sidebar()["renaming"]).toEqual({ key: "pane:host/w1:p4", initial: "shell" });
    p.command({ id: "c2", type: "rename-workspace", hostId: "host", workspaceId: "w1" });
    await settle();
    expect(p.sidebar()["renaming"]).toEqual({ key: "ws:host/w1", initial: "app" });
    // The row's field, gone, blurs late: the header's stays open.
    (p.sidebar()["onRenameCancel"] as (key: string) => void)("pane:host/w1:p4");
    (p.sidebar()["onRenameSave"] as (text: string, key: string) => void)("x", "pane:host/w1:p4");
    expect(p.sidebar()["renaming"]).toEqual({ key: "ws:host/w1", initial: "app" });
    expect(p.actions).toEqual([]);
    (p.sidebar()["onRenameCancel"] as (key: string) => void)("ws:host/w1");
    expect(p.sidebar()["renaming"]).toBeNull();
    await settle();
    await settle();
  });

  it("More closes when another pane is shown (it is about the pane it opened on)", async () => {
    vi.stubGlobal("window", { herdrDesktop: { startCommands: () => new Promise(() => undefined) }, addEventListener: () => undefined, removeEventListener: () => undefined });
    const row = (paneId: string) => findRow([host], host.id, paneId, { nowUnixMs: 0 })!;
    const props = { host, row: row("w1:p4"), tab: "terminal", onTab: () => undefined, mac: true, fontSize: 13, boxShown: false, onBoxShown: () => undefined, ghostty: { shown: false }, onOpenInGhostty: () => undefined, onClose: () => undefined, onRename: () => undefined };
    const view = await mainPane(props);
    expect(moreMenu(view)?.map((item) => item.label)).toEqual(["Rename…", "Close pane"]);
    view.render({ ...props, row: row("w1:p3") });
    expect(one(view.tree, "ContextMenu")).toBeUndefined();
  });
});
