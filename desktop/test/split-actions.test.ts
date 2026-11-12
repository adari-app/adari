// Split, resize, zoom, close. The requests the
// method table builds (a fake Herdr records them), the main process's pane
// actions (validated, refused past 4 panes, the layout read again and a
// snapshot after), the demo's Herdr answering them with its events, New
// agent's Where (a new tab, or a split of the focused pane, then the agent
// started in the new pane), and the page: a tile header's zoom, close (asked
// once for a working agent) and split menu, the divider sent on release only,
// the zoomed pane's Unzoom, and a tile click never sending pane.focus.

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
import { HerdrClient } from "../src/main/herdr/client";
import { newAgent, type NewAgentClock, type NewAgentHerdr } from "../src/main/herdr/new-agent";
import { paneMethods, type SplitParams } from "../src/main/herdr/pane-methods";
import type { HerdrTransport } from "../src/main/herdr/transport";
import { decodeSessionTopology, type AgentInfo, type TabCreation, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { isPaneAction, newAgentSplitRefusal, runPaneAction } from "../src/main/pane-actions";
import type { HostView, LayoutUpdateEvent, PaneAction } from "../src/shared/ipc-contract";
import { newAgentPlaces, type NewAgentPlace } from "../src/shared/new-agent";
import { decideTiles, ratioRequest, splitRefusal, type PaneLayout } from "../src/shared/pane-layout";
import { paneBindingOf, splitPathOf, splitShapeOf, type PaneBinding } from "../src/shared/pane-binding";
import { parseStartCommands } from "../src/shared/start-commands";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { HookHost, elements } from "./support/fake-hooks";

const { isNewAgentRequest } = await import("../src/main/ipc");
const { App } = await import("../src/renderer/App");
const { NewAgentDialog } = await import("../src/renderer/components/NewAgentDialog");
const { layoutStore } = await import("../src/renderer/split/layout-store");
const { startCommandsStore } = await import("../src/renderer/components/resume");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");

// MARK: - The requests the table builds

class Recorder implements HerdrTransport {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    this.sent.push({ method: request.method, params: request.params });
    const layout = { area: { x: 0, y: 0, width: 134, height: 45 }, focused_pane_id: "w1:p1", panes: [], splits: [], tab_id: "w1:t1", workspace_id: "w1", zoomed: false };
    const result =
      request.method === "pane.split"
        ? { type: "pane_info", pane: { pane_id: "w1:p9", terminal_id: "t9", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "unknown", revision: 1 } }
        : request.method === "pane.zoom"
          ? { type: "pane_zoom", zoom: { changed: true, zoom_changed: true, focus_changed: false, pane_id: "w1:p1", focused_pane_id: "w1:p1", zoomed: request.params["mode"] === "on", layout } }
          : { type: "ok" };
    return Promise.resolve(JSON.stringify({ id: request.id, result }));
  }
  close(): void {}
}

describe("the pane calls, from the one table", () => {
  it("splits right and down beside the focused pane, Herdr's focus left where it is", async () => {
    const herdr = new Recorder();
    const client = new HerdrClient(herdr);
    const right = await client.splitPane({ workspaceId: "w1", targetPaneId: "w1:p1", direction: "right", cwd: null, focus: false });
    await client.splitPane({ workspaceId: "w1", targetPaneId: "w1:p2", direction: "down", cwd: "/Users/demo/code/app", focus: false });
    expect(right).toMatchObject({ paneID: "w1:p9", tabID: "w1:t1" });
    expect(herdr.sent).toEqual([
      { method: "pane.split", params: { workspace_id: "w1", target_pane_id: "w1:p1", direction: "right", focus: false } },
      { method: "pane.split", params: { workspace_id: "w1", target_pane_id: "w1:p2", direction: "down", cwd: "/Users/demo/code/app", focus: false } },
    ]);
  });

  it("zooms on and off, and closes by pane id", async () => {
    const herdr = new Recorder();
    const client = new HerdrClient(herdr);
    await client.zoomPane("w1:p1", true);
    await client.zoomPane("w1:p1", false);
    await client.closePane("w1:p3");
    expect(herdr.sent).toEqual([
      { method: "pane.zoom", params: { pane_id: "w1:p1", mode: "on" } },
      { method: "pane.zoom", params: { pane_id: "w1:p1", mode: "off" } },
      { method: "pane.close", params: { pane_id: "w1:p3" } },
    ]);
  });

  it("names each method once, confirmed or inferred, and never sends pane.focus on a click", () => {
    expect(Object.values(paneMethods).map((entry) => [entry.method, entry.status])).toEqual([
      ["pane.layout", "confirmed"],
      ["pane.split", "confirmed"],
      ["pane.resize", "confirmed"],
      ["layout.set_split_ratio", "confirmed"],
      ["pane.zoom", "confirmed"],
      ["pane.close", "confirmed"],
      ["pane.focus", "confirmed"],
      ["pane.focus_direction", "confirmed"],
      ["pane.rename", "confirmed"],
      // A row named for its tab renames the tab.
      ["tab.rename", "confirmed"],
      ["events.subscribe", "confirmed"],
    ]);
    expect(paneMethods.focus.sentOnTileClick).toBe(false);
    // A drag sets its split's ratio; pane.resize stays unused (its amount's unit is unknown).
    expect(paneMethods.resize.used).toBe(false);
  });
});

// MARK: - The main process's pane actions over the demo's Herdr

async function demo() {
  const registry = new HostRegistry(() => undefined);
  const fixtures = bundledFixturesForTests();
  const backends: DemoBackend[] = [];
  for (const host of demoHosts(fixtures, Date.now())) {
    const backend = new DemoBackend(host, fixtures, { schedule: (run) => (run(), () => undefined) });
    backends.push(backend);
    registry.add(host.descriptor, backend);
  }
  await registry.refreshAll();
  const rereads: string[] = [];
  const accepted: PaneLayout[] = [];
  const backend = registry.backend(demoHostIds.macMini) as DemoBackend;
  // The window: it shows a pane's tab, read again after an action (or the zoom reply's), as LayoutService does.
  let shownPane: string | null = null;
  let shown: PaneLayout | null = null;
  const read = async (): Promise<void> => {
    shown = shownPane === null ? null : await backend.paneActions().paneLayout(shownPane).catch(() => shown);
  };
  const layouts = {
    reread: async (hostId: string) => {
      rereads.push(hostId);
      await read();
    },
    accept: (_hostId: string, layout: PaneLayout) => {
      accepted.push(layout);
      shown = layout;
    },
    watched: () => (shownPane === null ? null : { hostId: demoHostIds.macMini, layout: shown }),
  };
  const page = { id: 1 };
  const show = async (paneId: string): Promise<void> => {
    shownPane = paneId;
    await read();
  };
  const events: string[] = [];
  backend.subscribeEvents(["layout.updated", "pane.created", "pane.closed", "pane.moved"], {
    started: () => undefined,
    event: (kind, paneId) => events.push(`${kind} ${paneId ?? ""}`.trim()),
    ended: () => undefined,
  });
  /** The action bound to its pane as the window shows it (showing that pane's tab first if it does not). */
  const run = async (action: { readonly type: string; readonly paneId: string } & Record<string, unknown>) => {
    if (shown === null || !shown.panes.some((pane) => pane.paneId === action.paneId)) await show(action.paneId);
    const host = registry.list().find((candidate) => candidate.id === demoHostIds.macMini)!;
    const binding = paneBindingOf(host, shown, action.paneId) ?? standIn(action.paneId);
    const path = action.type === "resize" ? ((shown === null ? null : splitPathOf(shown, String(action["splitId"]))) ?? []) : null;
    const shape = action.type === "resize" ? ((shown === null ? null : splitShapeOf(shown, String(action["splitId"]))) ?? "no such split") : null;
    return runPaneAction(registry, layouts, page, demoHostIds.macMini, { ...action, binding, ...(path === null ? {} : { path, shape }) } as unknown as PaneAction);
  };
  const layout = (paneId: string) => backend.paneActions().paneLayout(paneId);
  return { registry, backend, rereads, accepted, events, run, layout, layouts, page, show };
}

/** A binding for a pane the window cannot show (unknown to the snapshot or to Herdr). */
const standIn = (paneId: string): PaneBinding => ({ connection: 1, incarnation: 1, epoch: 0, workspaceId: "w7", tabId: "w7:tK", paneId, terminalID: "", agent: null, session: null });

const tabPanes = (registry: HostRegistry, tabId: string) =>
  registry.topology(demoHostIds.macMini)!.panes.filter((pane) => pane.tabID === tabId).map((pane) => pane.paneID);

describe("the main process's pane actions", () => {
  it("accepts only well-formed actions", () => {
    const binding = standIn("w7:p1G");
    expect(isPaneAction({ type: "split", paneId: "w7:p1G", direction: "right", binding })).toBe(true);
    expect(isPaneAction({ type: "split", paneId: "w7:p1G", direction: "left", binding })).toBe(false);
    const shape = JSON.stringify(["split_0_root", "right", "w7:p1G", "w7:p1H"]);
    expect(isPaneAction({ type: "resize", paneId: "w7:p1G", splitId: "split_0_root", path: [], shape, ratio: 0.4, binding })).toBe(true);
    expect(isPaneAction({ type: "resize", paneId: "w7:p1G", splitId: "split_0_root", path: [], shape, ratio: 2, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w7:p1G", splitId: 7, path: [], shape, ratio: 0.4, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w7:p1G", splitId: "split_0_root", path: [], ratio: 0.4, binding })).toBe(false);
    expect(isPaneAction({ type: "zoom", paneId: "w7:p1G", zoomed: true, binding })).toBe(true);
    expect(isPaneAction({ type: "zoom", paneId: "w7:p1G", zoomed: "yes", binding })).toBe(false);
    expect(isPaneAction({ type: "close", paneId: "w7:p1G", binding })).toBe(true);
    expect(isPaneAction({ type: "focus", paneId: "w7:p1G", binding })).toBe(false);
    expect(isPaneAction({ type: "close", paneId: "", binding })).toBe(false);
    // Bound: no binding, a binding for another pane, or a malformed one is refused.
    expect(isPaneAction({ type: "close", paneId: "w7:p1G" })).toBe(false);
    expect(isPaneAction({ type: "close", paneId: "w7:p1H", binding })).toBe(false);
    expect(isPaneAction({ type: "close", paneId: "w7:p1G", binding: { ...binding, connection: -1 } })).toBe(false);
    // The machine's entry and command connection are part of it; an unknown connection is null, not absent.
    expect(isPaneAction({ type: "close", paneId: "w7:p1G", binding: { ...binding, epoch: null } })).toBe(true);
    expect(isPaneAction({ type: "close", paneId: "w7:p1G", binding: { ...binding, epoch: undefined } })).toBe(false);
    expect(isPaneAction({ type: "close", paneId: "w7:p1G", binding: { ...binding, incarnation: 1.5 } })).toBe(false);
  });

  it("splits the pane on the demo's Herdr: a new pane beside it, the layout read again, a snapshot taken", async () => {
    const d = await demo();
    const tab = d.registry.pane(demoHostIds.macMini, "w7:p1G")!.tabID;
    const before = tabPanes(d.registry, tab);
    expect(before).toHaveLength(2);
    const result = await d.run({ type: "split", paneId: "w7:p1G", direction: "down" });
    expect(result.paneId).not.toBeNull();
    // The snapshot was taken: the sidebar has the new pane in the same tab.
    expect(tabPanes(d.registry, tab)).toEqual([...before, result.paneId]);
    expect(d.rereads).toEqual([demoHostIds.macMini]);
    expect(d.events).toEqual([`pane.created ${result.paneId!}`, "layout.updated w7:p1G"]);
    // Herdr's layout: p1G's half split down, the new pane under it.
    const layout = await d.layout("w7:p1G");
    const rect = (id: string) => layout.panes.find((pane) => pane.paneId === id)?.rect;
    expect(rect("w7:p1G")).toEqual({ x: 0, y: 0, width: 67, height: 23 });
    expect(rect(result.paneId!)).toEqual({ x: 0, y: 23, width: 67, height: 22 });
    d.registry.close();
  });

  it("refuses a split when the tab already shows 4 panes", async () => {
    const d = await demo();
    const tab = d.registry.pane(demoHostIds.macMini, "w7:p1G")!.tabID;
    await d.run({ type: "split", paneId: "w7:p1G", direction: "down" });
    await d.run({ type: "split", paneId: "w7:p1H", direction: "down" });
    expect(tabPanes(d.registry, tab)).toHaveLength(4);
    await expect(d.run({ type: "split", paneId: "w7:p1G", direction: "right" })).rejects.toThrow(splitRefusal(4)!);
    expect(tabPanes(d.registry, tab)).toHaveLength(4);
    expect(splitRefusal(3)).toBeNull();
    expect(splitRefusal(4)).toBe("This tab already shows 4 panes; Adari shows up to 4.");
    d.registry.close();
  });

  it("sets a split's ratio from the drag, zooms and closes; each answer is read back", async () => {
    const d = await demo();
    await d.run({ type: "resize", paneId: "w7:p1G", splitId: "split_0_root", ratio: 0.6 });
    let layout = await d.layout("w7:p1G");
    expect(layout.splits[0]!.ratio).toBeCloseTo(0.6, 5);
    expect(layout.panes.map((pane) => pane.rect.width)).toEqual([80, 54]);
    await d.run({ type: "resize", paneId: "w7:p1G", splitId: "split_0_root", ratio: 0.4 });
    layout = await d.layout("w7:p1G");
    expect(layout.splits[0]!.ratio).toBeCloseTo(0.4, 5);
    await d.run({ type: "zoom", paneId: "w7:p1H", zoomed: true });
    // The zoom's reply carries the layout: shown as it came.
    expect(d.accepted.at(-1)).toMatchObject({ tabId: "w7:tK", zoomed: true, focusedPaneId: "w7:p1H" });
    layout = await d.layout("w7:p1G");
    expect({ zoomed: layout.zoomed, focused: layout.focusedPaneId }).toEqual({ zoomed: true, focused: "w7:p1H" });
    expect(decideTiles(layout, "w7:p1H")).toMatchObject({ kind: "single", reason: "zoomed", zoomed: true });
    await d.run({ type: "zoom", paneId: "w7:p1H", zoomed: false });
    expect((await d.layout("w7:p1G")).zoomed).toBe(false);
    await d.run({ type: "close", paneId: "w7:p1H" });
    expect(d.registry.pane(demoHostIds.macMini, "w7:p1H")).toBeNull();
    layout = await d.layout("w7:p1G");
    expect(layout.panes).toEqual([{ paneId: "w7:p1G", rect: { x: 0, y: 0, width: 134, height: 45 }, focused: true }]);
    expect(d.events).toEqual(["layout.updated w7:p1G", "layout.updated w7:p1G", "layout.updated w7:p1H", "layout.updated w7:p1H", "pane.closed w7:p1H", "layout.updated w7:p1G"]);
    // Read again after the two resizes and the close; the zooms' replies had theirs.
    expect(d.rereads).toHaveLength(3);
    expect(d.accepted).toHaveLength(2);
    d.registry.close();
  });

  it("says why when the pane is not shown, no longer listed, or its machine is gone", async () => {
    const d = await demo();
    await expect(d.run({ type: "zoom", paneId: "w7:nope", zoomed: true })).rejects.toThrow("That pane is not shown in this window.");
    // Gone from Herdr before the sidebar knew: the fresh snapshot right before the zoom says so; nothing is sent.
    await d.show("w7:p1G");
    await d.backend.paneActions().closePane("w7:p1H");
    await expect(d.run({ type: "zoom", paneId: "w7:p1H", zoomed: true })).rejects.toThrow("That pane is no longer listed.");
    await expect(runPaneAction(d.registry, d.layouts, d.page, "nobody", { type: "close", paneId: "w7:p1G", binding: standIn("w7:p1G") })).rejects.toThrow(
      "That machine is no longer listed.",
    );
    d.registry.close();
  });
});

// MARK: - New agent's Where

class FakeHerdr implements NewAgentHerdr {
  readonly calls: string[] = [];
  startError: Error | null = null;
  agentList(): Promise<AgentInfo[]> {
    this.calls.push("agent.list");
    return Promise.resolve([{ paneID: "w1:p1", name: "claude", agent: "claude" } as AgentInfo]);
  }
  createTerminalTab(workspaceID: string, label: string | null, cwd: string | null): Promise<TabCreation> {
    this.calls.push(`tab.create ${workspaceID} label=${label} cwd=${cwd}`);
    return Promise.resolve({ tab: { tabID: "w1:tn1", workspaceID, label: label ?? "" }, rootPane: { paneID: "w1:pn1", workspaceID, tabID: "w1:tn1" } } as unknown as TabCreation);
  }
  splitPane(params: SplitParams): Promise<TopologyPaneInfo> {
    this.calls.push(`pane.split ${params.workspaceId} ${params.targetPaneId} ${params.direction} cwd=${params.cwd} focus=${params.focus}`);
    return Promise.resolve({ paneID: "w1:p9", workspaceID: params.workspaceId, tabID: "w1:t1" } as unknown as TopologyPaneInfo);
  }
  startAgent(name: string, kind: string, paneID: string): Promise<AgentInfo> {
    this.calls.push(`agent.start ${name} ${kind} ${paneID}`);
    return this.startError === null ? Promise.resolve({ paneID, name, agent: kind } as AgentInfo) : Promise.reject(this.startError);
  }
  closePane(paneID: string): Promise<void> {
    this.calls.push(`pane.close ${paneID}`);
    return Promise.resolve();
  }
  sendInput(pane: string, text: string, keys: readonly string[]): Promise<void> {
    this.calls.push(`pane.send_input ${pane} ${JSON.stringify(text)} ${keys.join(",")}`);
    return Promise.resolve();
  }
}

const clock: NewAgentClock = { now: () => 0, sleep: () => Promise.resolve() };
const noCommands = parseStartCommands(null);

describe("New agent's Where", () => {
  it("a split of the focused pane (right or down), then the agent started in the new pane as New agent does", async () => {
    const herdr = new FakeHerdr();
    const result = await newAgent(
      herdr,
      noCommands,
      { workspaceId: "w1", folder: "/Users/demo/code/app", kind: "codex", where: { type: "split", direction: "down", targetPaneId: "w1:p1" } },
      clock,
    );
    expect(herdr.calls).toEqual(["agent.list", "pane.split w1 w1:p1 down cwd=/Users/demo/code/app focus=false", "agent.start codex codex w1:p9"]);
    expect(result).toMatchObject({ paneId: "w1:p9", tabId: "w1:t1", kind: "codex", start: { type: "herdr" } });
    // A shell: the split alone.
    const shell = new FakeHerdr();
    const plain = await newAgent(shell, noCommands, { workspaceId: "w1", folder: null, kind: "shell", where: { type: "split", direction: "right", targetPaneId: "w1:p1" } }, clock);
    expect(shell.calls).toEqual(["pane.split w1 w1:p1 right cwd=null focus=false"]);
    expect(plain.paneId).toBe("w1:p9");
    // A new tab, as before.
    const tab = new FakeHerdr();
    await newAgent(tab, noCommands, { workspaceId: "w1", folder: null, kind: "shell", where: { type: "tab" } }, clock);
    expect(tab.calls).toEqual(["tab.create w1 label=null cwd=null"]);
  });

  it("a refused start closes the split pane it made", async () => {
    const herdr = new FakeHerdr();
    herdr.startError = new Error("agent refused");
    await expect(
      newAgent(herdr, noCommands, { workspaceId: "w1", folder: null, kind: "codex", where: { type: "split", direction: "right", targetPaneId: "w1:p1" } }, clock),
    ).rejects.toThrow("agent refused");
    expect(herdr.calls.at(-1)).toBe("pane.close w1:p9");
  });

  it("the request carries Where; a split past 4 panes is refused before anything is sent", async () => {
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "claude", where: { type: "tab" } })).toBe(true);
    const bound = { ...standIn("w1:p1"), workspaceId: "w1", tabId: "w1:t1" };
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "claude", where: { type: "split", direction: "right", targetPaneId: "w1:p1", binding: bound } })).toBe(true);
    // Bound to its pane: without the binding, or with another pane's, refused.
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "claude", where: { type: "split", direction: "right", targetPaneId: "w1:p1" } })).toBe(false);
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "claude", where: { type: "split", direction: "right", targetPaneId: "w1:p2", binding: bound } })).toBe(false);
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "claude", where: { type: "split", direction: "left", targetPaneId: "w1:p1" } })).toBe(false);
    expect(isNewAgentRequest({ workspaceId: "w1", folder: null, kind: "claude", where: { type: "split", direction: "down" } })).toBe(false);
    const d = await demo();
    const topology = d.registry.topology(demoHostIds.macMini)!;
    const split = (targetPaneId: string) => ({ workspaceId: "w7", folder: null, kind: "claude", where: { type: "split" as const, direction: "right" as const, targetPaneId } });
    expect(newAgentSplitRefusal(topology, split("w7:p1G"))).toBeNull();
    expect(newAgentSplitRefusal(topology, split("w7:gone"))).toBe("The pane to split is no longer listed.");
    expect(newAgentSplitRefusal(topology, { ...split("w7:p1G"), workspaceId: "w1" })).toBe("The pane to split is in another workspace.");
    await d.run({ type: "split", paneId: "w7:p1G", direction: "down" });
    await d.run({ type: "split", paneId: "w7:p1H", direction: "down" });
    expect(newAgentSplitRefusal(d.registry.topology(demoHostIds.macMini)!, split("w7:p1G"))).toBe(splitRefusal(4));
    d.registry.close();
  });
});

// MARK: - The page

type Element = { type: unknown; props: Record<string, unknown> };
const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name) as Element[];
const one = (tree: unknown, name: string) => named(tree, name)[0];
const text = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object" && node !== null && "props" in node) return text((node as Element).props["children"]);
  return "";
};

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

// Tab w1:t1: p1 (Claude, working) and p2 (a shell); tab w1:t2: p3..p6 (four panes); workspace w2: p7.
// The tabs have no labels, so the panes are named for their kind ("claude", "shell").
const fixturePanes = [
  { id: "w1:p1", tab: "w1:t1", agent: "claude", status: "working" },
  { id: "w1:p2", tab: "w1:t1" },
  { id: "w1:p3", tab: "w1:t2", agent: "claude", status: "idle" },
  { id: "w1:p4", tab: "w1:t2", agent: "codex", status: "idle" },
  { id: "w1:p5", tab: "w1:t2" },
  { id: "w1:p6", tab: "w1:t2" },
  { id: "w2:p7", tab: "w2:t1", workspace: "w2" },
];

const host: HostView = {
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
    workspaces: [
      { workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 6, tab_count: 2, active_tab_id: "w1:t1", agent_status: "working" },
      { workspace_id: "w2", number: 2, label: "ops", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "unknown" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "", focused: true, pane_count: 2, agent_status: "working" },
      { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "", focused: false, pane_count: 4, agent_status: "idle" },
      { tab_id: "w2:t1", workspace_id: "w2", number: 1, label: "", focused: false, pane_count: 1, agent_status: "unknown" },
    ],
    panes: fixturePanes.map((pane, index) => ({
      pane_id: pane.id,
      terminal_id: `term${index}`,
      workspace_id: pane.workspace ?? "w1",
      tab_id: pane.tab,
      focused: false,
      cwd: "/Users/demo/code/app",
      ...(pane.agent === undefined ? {} : { agent: pane.agent }),
      agent_status: pane.status ?? "unknown",
      revision: 1,
    })),
    layouts: [],
    agents: fixturePanes
      .filter((pane) => pane.agent !== undefined)
      .map((pane) => ({ pane_id: pane.id, agent: pane.agent, agent_status: pane.status })),
  }),
};

const area = { x: 0, y: 0, width: 134, height: 45 };

/** Two panes side by side (w1:t1). */
const pair = (zoomed = false, focused = "w1:p1"): PaneLayout => ({
  tabId: "w1:t1",
  workspaceId: "w1",
  area,
  focusedPaneId: focused,
  panes: [
    { paneId: "w1:p1", rect: { x: 0, y: 0, width: 67, height: 45 }, focused: focused === "w1:p1" },
    { paneId: "w1:p2", rect: { x: 67, y: 0, width: 67, height: 45 }, focused: focused === "w1:p2" },
  ],
  splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: area }],
  zoomed,
});

/** The four-panes shape over w1:t2. */
const workers = (): PaneLayout => ({
  tabId: "w1:t2",
  workspaceId: "w1",
  area,
  focusedPaneId: "w1:p3",
  panes: [
    { paneId: "w1:p3", rect: { x: 0, y: 0, width: 67, height: 23 }, focused: true },
    { paneId: "w1:p4", rect: { x: 0, y: 23, width: 67, height: 22 }, focused: false },
    { paneId: "w1:p5", rect: { x: 67, y: 0, width: 67, height: 23 }, focused: false },
    { paneId: "w1:p6", rect: { x: 67, y: 23, width: 67, height: 22 }, focused: false },
  ],
  splits: [
    { id: "split_0_root", direction: "right", ratio: 0.5, rect: area },
    { id: "split_1_0", direction: "down", ratio: 0.5, rect: { x: 0, y: 0, width: 67, height: 45 } },
    { id: "split_2_1", direction: "down", ratio: 0.5, rect: { x: 67, y: 0, width: 67, height: 45 } },
  ],
  zoomed: false,
});

let cleanup: (() => void) | null = null;

beforeEach(() => layoutStore.reset());

afterEach(() => {
  cleanup?.();
  cleanup = null;
  startCommandsStore.clear();
  handoffStore.reset();
  vi.unstubAllGlobals();
});

async function page() {
  const storage = new MemoryStorage();
  const actions: [string, PaneAction][] = [];
  const newAgents: [string, unknown][] = [];
  let layoutListener: ((event: LayoutUpdateEvent) => void) | null = null;
  let hostsListener: ((hosts: HostView[]) => void) | null = null;
  let answer: () => Promise<{ paneId: string | null }> = () => Promise.resolve({ paneId: null });
  const bridge = {
    appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
    listHosts: async () => [host],
    onHostsChanged: (listener: (hosts: HostView[]) => void) => {
      hostsListener = listener;
      return () => undefined;
    },
    onAppCommand: () => () => undefined,
    onViewCommand: () => () => undefined,
    ghosttyInfo: async () => ({ shown: false }),
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
      return answer();
    },
    newAgent: (hostId: string, request: unknown) => {
      newAgents.push([hostId, request]);
      return new Promise(() => undefined);
    },
  };
  vi.stubGlobal("window", {
    herdrDesktop: bridge,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
    getSelection: () => null,
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: new Promise(() => undefined) }, querySelector: () => null });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const app = new HookHost(App as (props: object) => unknown, {});
  app.render();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  cleanup = () => app.unmount();
  const split = () => one(app.tree, "SplitView")?.props as Record<string, unknown> | undefined;
  /** The tile for `paneId`, rendered on its own host. */
  const tile = (paneId: string) => {
    const view = new HookHost(one(app.tree, "SplitView")!.type as (props: object) => unknown, split()!);
    view.render();
    const element = named(view.tree, "Tile").find((candidate) => (candidate.props["entry"] as { paneId: string }).paneId === paneId)!;
    const rendered = new HookHost(element.type as (props: object) => unknown, element.props);
    rendered.render();
    return rendered;
  };
  const button = (tree: unknown, label: string) => elements(tree).find((candidate) => candidate.props["aria-label"] === label) as Element | undefined;
  return {
    app,
    actions,
    newAgents,
    answer: (next: () => Promise<{ paneId: string | null }>) => (answer = next),
    /** The machines as a new snapshot lists them. */
    hosts: (next: HostView[]) => hostsListener!(next),
    /** The actions without their bindings (each binding checked on its own). */
    plain: () => actions.map(([hostId, action]) => [hostId, unbound(action)]),
    select: (paneId: string) => (one(app.tree, "Sidebar")!.props["onSelect"] as (h: string, p: string) => void)("host", paneId),
    layout: (layout: PaneLayout, paneId: string) => layoutListener!({ hostId: "host", paneId, tabId: layout.tabId, layout, error: null }),
    split,
    tile,
    button,
    click: (element: Element | undefined) =>
      (element!.props["onClick"] as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 400, right: 428, top: 60, bottom: 84 }) }, stopPropagation: () => undefined }),
    menu: () => one(app.tree, "ContextMenu")?.props["items"] as { label: string; disabledReason?: string | null; onSelect(): void }[] | undefined,
    main: () => one(app.tree, "MainPane")?.props as Record<string, unknown> | undefined,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An action without its binding (the page binds every action to the pane as shown). */
function unbound(action: PaneAction): Record<string, unknown> {
  const { binding: _binding, ...rest } = action;
  return rest;
}

describe("a tile's header: zoom, close, split", () => {
  it("zoom asks Herdr to zoom that pane; the zoomed pane alone has Unzoom", async () => {
    const p = await page();
    p.select("w1:p1");
    p.layout(pair(), "w1:p1");
    p.click(p.button(p.tile("w1:p2").tree, "Zoom shell"));
    expect(p.plain()).toEqual([["host", { type: "zoom", paneId: "w1:p2", zoomed: true }]]);
    // Bound to w1:p2 as the window shows it: its workspace, tab, terminal, no agent.
    const p2 = host.topology!.panes.find((pane) => pane.paneID === "w1:p2")!;
    expect(p.actions[0]![1].binding).toEqual({ connection: 3, incarnation: 2, epoch: 5, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", terminalID: p2.terminalID, agent: null, session: null });
    // Herdr's answer: p2 zoomed (and focused).
    p.select("w1:p2");
    p.layout(pair(true, "w1:p2"), "w1:p2");
    expect(p.split()).toBeUndefined();
    expect(p.main()?.["zoomed"]).toBe(true);
    (p.main()!["onUnzoom"] as () => void)();
    expect(p.plain().at(-1)).toEqual(["host", { type: "zoom", paneId: "w1:p2", zoomed: false }]);
  });

  it("close: a shell or an idle agent at once; a working agent asks once", async () => {
    const p = await page();
    p.select("w1:p1");
    p.layout(pair(), "w1:p1");
    p.click(p.button(p.tile("w1:p2").tree, "Close shell"));
    expect(p.plain()).toEqual([["host", { type: "close", paneId: "w1:p2" }]]);
    // p1's Claude is working: one question first.
    p.click(p.button(p.tile("w1:p1").tree, "Close claude"));
    expect(p.actions).toHaveLength(1);
    const ask = one(p.app.tree, "ConfirmClose")!;
    expect(ask.props["name"]).toBe("claude");
    (ask.props["onConfirm"] as () => void)();
    expect(p.plain().at(-1)).toEqual(["host", { type: "close", paneId: "w1:p1" }]);
    expect(p.actions).toHaveLength(2);
    expect(one(p.app.tree, "ConfirmClose")).toBeUndefined();
    // Cancel sends nothing.
    p.click(p.button(p.tile("w1:p1").tree, "Close claude"));
    (one(p.app.tree, "ConfirmClose")!.props["onCancel"] as () => void)();
    expect(p.actions).toHaveLength(2);
  });

  it("the close confirmation keeps the binding taken when Close was pressed: a pane changed meanwhile is not taken for it", async () => {
    const p = await page();
    p.select("w1:p1");
    p.layout(pair(), "w1:p1");
    const before = host.topology!.panes.find((pane) => pane.paneID === "w1:p1")!;
    // p1's Claude is working: Close asks first.
    p.click(p.button(p.tile("w1:p1").tree, "Close claude"));
    expect(p.actions).toHaveLength(0);
    // While the user is asked, a snapshot shows another terminal in w1:p1.
    const changed = { ...host.topology!, panes: host.topology!.panes.map((pane) => (pane.paneID === "w1:p1" ? { ...pane, terminalID: "term-new" } : pane)) };
    p.hosts([{ ...host, topology: changed }]);
    (one(p.app.tree, "ConfirmClose")!.props["onConfirm"] as () => void)();
    expect(p.plain()).toEqual([["host", { type: "close", paneId: "w1:p1" }]]);
    // The binding is the one the user confirmed: the terminal they saw, not the one now (the main process refuses it).
    expect(p.actions[0]![1].binding).toMatchObject({ paneId: "w1:p1", tabId: "w1:t1", terminalID: before.terminalID, agent: "claude" });
    expect(before.terminalID).not.toBe("term-new");
  });

  it("an action on a pane the window does not show as Herdr has it is not sent, with a plain reason", async () => {
    const p = await page();
    p.select("w1:p1");
    // No layout yet: the tab is not shown as Herdr has it, so nothing can be bound: no split menu, no zoom.
    (p.main()!["onSplitMenu"] as (x: number, y: number) => void)(300, 40);
    expect(p.menu()).toBeUndefined();
    (p.main()!["onUnzoom"] as () => void)();
    expect(p.actions).toEqual([]);
    const toast = elements(p.app.tree).find((element) => element.props["className"] === "app-toast");
    expect(text(toast)).toBe("Not unzoomed: That pane is not shown in this window.");
  });

  it("closing the focused tile focuses another of the tab", async () => {
    const p = await page();
    p.select("w1:p2");
    p.layout(pair(false, "w1:p2"), "w1:p2");
    p.click(p.button(p.tile("w1:p2").tree, "Close shell"));
    await settle();
    expect(one(p.app.tree, "Sidebar")!.props["selectedKey"]).toBe("host/w1:p1");
  });

  it("the split menu: Split right, Split down, and New agent there; all refused with a note when the tab shows 4", async () => {
    const p = await page();
    p.select("w1:p1");
    p.layout(pair(), "w1:p1");
    p.click(p.button(p.tile("w1:p2").tree, "Split shell"));
    expect(p.menu()!.map((item) => [item.label, item.disabledReason ?? null])).toEqual([
      ["Split right", null],
      ["Split down", null],
      ["New agent to the right…", null],
      ["New agent below…", null],
    ]);
    p.menu()![1]!.onSelect();
    expect(p.plain()).toEqual([["host", { type: "split", paneId: "w1:p2", direction: "down" }]]);
    expect(p.actions[0]![1].binding).toMatchObject({ paneId: "w1:p2", tabId: "w1:t1", workspaceId: "w1" });
    // New agent below…: the dialog, its Where set to a split down of that pane.
    p.click(p.button(p.tile("w1:p2").tree, "Split shell"));
    p.menu()![3]!.onSelect();
    const dialog = one(p.app.tree, "NewAgentDialog")!;
    expect(dialog.props["initialWhere"]).toBe("down");
    expect(dialog.props["splitTarget"]).toMatchObject({ hostId: "host", workspaceId: "w1", paneId: "w1:p2", tabPanes: 2, binding: { paneId: "w1:p2", tabId: "w1:t1" } });
    expect(dialog.props["wanted"]).toEqual({ hostId: "host", workspaceId: "w1" });
    // The four-pane tab: every split refused, with the note.
    p.select("w1:p3");
    p.layout(workers(), "w1:p3");
    p.click(p.button(p.tile("w1:p5").tree, "Split shell"));
    expect(p.menu()!.map((item) => item.disabledReason)).toEqual(Array(4).fill(splitRefusal(4)));
  });

  it("a one-pane tab splits from its header too", async () => {
    const p = await page();
    p.select("w2:p7");
    p.layout({ ...pair(), tabId: "w2:t1", workspaceId: "w2", panes: [{ paneId: "w2:p7", rect: area, focused: true }], splits: [], focusedPaneId: "w2:p7" }, "w2:p7");
    (p.main()!["onSplitMenu"] as (x: number, y: number) => void)(300, 40);
    expect(p.menu()!.map((item) => item.label)).toEqual(["Split right", "Split down", "New agent to the right…", "New agent below…"]);
    p.menu()![0]!.onSelect();
    expect(p.plain()).toEqual([["host", { type: "split", paneId: "w2:p7", direction: "right" }]]);
  });
});

describe("dragging a divider", () => {
  it("moves the tiles while dragging and sends the split's ratio once on release; Herdr's answer redraws it", async () => {
    const p = await page();
    p.select("w1:p1");
    p.layout(pair(), "w1:p1");
    const divider = (p.split()!["dividers"] as { splitId: string; at: number; firstPaneId: string }[])[0]!;
    expect(divider).toMatchObject({ splitId: "split_0_root", at: 0.5, firstPaneId: "w1:p1" });
    let release: (value: { paneId: null }) => void = () => undefined;
    p.answer(() => new Promise((resolve) => (release = resolve)));
    // The drag as SplitView captures it at its start: the machine, the tab's layout, the divider.
    // Bound at its start to the divider's first pane and its split's place.
    const shownLayout = p.split()!["layout"] as PaneLayout;
    const drag = {
      hostId: "host",
      layout: shownLayout,
      divider,
      binding: paneBindingOf(host, shownLayout, divider.firstPaneId),
      path: splitPathOf(shownLayout, divider.splitId),
      shape: splitShapeOf(shownLayout, divider.splitId),
    };
    (p.split()!["onResizing"] as (d: unknown, at: number) => void)(drag, 0.6);
    (p.split()!["onResizing"] as (d: unknown, at: number) => void)(drag, 0.65);
    expect(p.actions).toEqual([]);
    const width = () => (p.split()!["tiles"] as { frame: { width: number } }[])[0]!.frame.width;
    expect(width()).toBeCloseTo(0.65, 5);
    (p.split()!["onResize"] as (d: unknown, at: number) => void)(drag, 0.6);
    expect(p.actions).toHaveLength(1);
    const [hostId, action] = p.actions[0]!;
    expect(hostId).toBe("host");
    expect(unbound(action)).toEqual({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], shape: drag.shape, ratio: 0.6 });
    expect(action.binding).toMatchObject({ paneId: "w1:p1", tabId: "w1:t1" });
    // Held where the user let go until Herdr answers, then Herdr's layout.
    expect(width()).toBeCloseTo(0.6, 5);
    p.layout({ ...pair(), splits: [{ ...pair().splits[0]!, ratio: 0.6 }], panes: [{ ...pair().panes[0]!, rect: { x: 0, y: 0, width: 80, height: 45 } }, { ...pair().panes[1]!, rect: { x: 80, y: 0, width: 54, height: 45 } }] }, "w1:p1");
    release({ paneId: null });
    await settle();
    expect(width()).toBeCloseTo(80 / 134, 5);
  });

  it("reads a release into the split and its new ratio", () => {
    const decision = decideTiles(pair(), "w1:p1");
    if (decision.kind !== "tiles") throw new Error("expected tiles");
    const divider = decision.dividers[0]!;
    expect(ratioRequest(divider, 0.4)).toEqual({ paneId: "w1:p1", splitId: "split_0_root", ratio: 0.4 });
    expect(ratioRequest(divider, 0.5)).toBeNull();
    // Under half a cell: nothing to send.
    expect(ratioRequest(divider, 0.5 + 0.4 / 134)).toBeNull();
    const four = decideTiles(workers(), "w1:p3");
    if (four.kind !== "tiles") throw new Error("expected tiles");
    const down = four.dividers.find((candidate) => candidate.splitId === "split_2_1")!;
    expect(ratioRequest(down, 0.7)).toEqual({ paneId: "w1:p5", splitId: "split_2_1", ratio: 0.7 });
  });
});

describe("New agent's Where in the dialog", () => {
  const mini: HostView = { ...host, id: "mini" };
  const places = newAgentPlaces([mini]);

  function dialog(props: Record<string, unknown>) {
    vi.stubGlobal("window", { herdrDesktop: { startCommands: () => Promise.resolve(parseStartCommands(null)) } });
    const starts: unknown[][] = [];
    const view = new HookHost(NewAgentDialog as (props: object) => unknown, {
      places,
      wanted: { hostId: "mini", workspaceId: "w1" },
      storage: new MemoryStorage(),
      start: (...args: unknown[]) => {
        starts.push(args);
        return new Promise(() => undefined);
      },
      onStarted: () => undefined,
      onClose: () => undefined,
      ...props,
    });
    view.render();
    const wheres = () => elements(view.tree).filter((candidate) => candidate.props["data-where"] !== undefined) as Element[];
    const enter = () =>
      ((elements(view.tree).find((candidate) => candidate.props["role"] === "dialog") as Element).props["onKeyDown"] as (event: unknown) => void)({
        key: "Enter",
        shiftKey: false,
        target: { tagName: "INPUT" },
        nativeEvent: { isComposing: false },
        preventDefault: () => undefined,
      });
    return { view, starts, wheres, enter, note: () => text(elements(view.tree).find((candidate) => candidate.props["role"] === "status")) };
  }

  const target = (tabPanes: number) => ({ hostId: "mini", workspaceId: "w1", paneId: "w1:p1", name: "claude", tabPanes });

  it("offers New tab, Split right and Split down beside the focused pane; the pick goes with the start", () => {
    const d = dialog({ splitTarget: target(2), initialWhere: "right" });
    expect(d.wheres().map((candidate) => [candidate.props["data-where"], candidate.props["aria-checked"], candidate.props["disabled"]])).toEqual([
      ["tab", false, false],
      ["right", true, false],
      ["down", false, false],
    ]);
    (d.wheres()[2]!.props["onClick"] as () => void)();
    d.enter();
    expect((d.starts[0] as unknown[])[3]).toEqual({ type: "split", direction: "down", targetPaneId: "w1:p1" });
    expect((d.starts[0] as unknown[])[0]).toMatchObject({ hostId: "mini", workspaceId: "w1" } satisfies Partial<NewAgentPlace>);
  });

  it("refuses a split with a note when the tab already shows 4 panes; a new tab still starts", () => {
    const d = dialog({ splitTarget: target(4), initialWhere: "right" });
    expect(d.wheres().map((candidate) => [candidate.props["data-where"], candidate.props["aria-checked"], candidate.props["disabled"]])).toEqual([
      ["tab", true, false],
      ["right", false, true],
      ["down", false, true],
    ]);
    expect(d.note()).toContain(splitRefusal(4)!);
    d.enter();
    expect((d.starts[0] as unknown[])[3]).toEqual({ type: "tab" });
  });

  it("only a new tab in another workspace, or with no pane focused", () => {
    const other = dialog({ splitTarget: target(2), wanted: { hostId: "mini", workspaceId: "w2" } });
    expect(other.wheres().map((candidate) => candidate.props["data-where"])).toEqual(["tab"]);
    other.enter();
    expect((other.starts[0] as unknown[])[3]).toEqual({ type: "tab" });
    const none = dialog({ splitTarget: null });
    expect(none.wheres().map((candidate) => candidate.props["data-where"])).toEqual(["tab"]);
  });
});
