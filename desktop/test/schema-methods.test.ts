// The pane calls against Herdr 0.9.5's own API schema (`herdr api schema --json`,
// protocol 22). SchemaHerdr is a fake built from that schema, not from the app:
// - pane.zoom {pane_id, mode: toggle|on|off}, mode toggle when left out and
//   other params ignored; it answers pane_zoom {zoom: PaneZoomResult}, whose
//   layout is the tab's PaneLayoutSnapshot.
// - pane.layout {pane_id} answers pane_layout {layout: PaneLayoutSnapshot}.
// - layout.set_split_ratio {tab_id?, pane_id?, path: [bool], ratio} sets one
//   split's ratio (the path from the root, false the first side, true the
//   second: the encoding is inferred) and answers layout_split_ratio_set
//   {layout: LayoutDescription {root: LayoutNode}}; `bounds` stands in for
//   whatever limits Herdr puts on a ratio (to show a reply that differs).
// - pane.split {workspace_id, target_pane_id, direction, cwd?, focus}
//   answers pane_info {pane}; pane.rename, pane.focus and
//   pane.focus_direction exist in the schema and are answered "ok" here, so a
//   test sees whether the app sends them.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FixtureTransport } from "../src/main/demo/demo-backend";
import { defaultTree, layoutJson, treePanes, type DemoTabLayout } from "../src/main/demo/demo-layout";
import { demoHosts } from "../src/main/demo/demo-hosts";
import { HerdrClient } from "../src/main/herdr/client";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import type { HerdrTransport } from "../src/main/herdr/transport";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { LayoutService, type LayoutHosts, type LayoutOwner } from "../src/main/layouts";
import { paneMethods } from "../src/main/herdr/pane-methods";
import { decodePaneLayout } from "../src/main/herdr/wire";
import { OnceLog, isPaneAction, runPaneAction } from "../src/main/pane-actions";
import type { LayoutUpdateEvent, PaneAction } from "../src/shared/ipc-contract";
import { paneBindingOf, splitPathOf, splitShapeOf } from "../src/shared/pane-binding";
import { decideTiles, ratioRequest, splitPath, tileTree, type PaneLayout } from "../src/shared/pane-layout";
import { eventually } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

type Json = Record<string, unknown>;

const tabId = "w1:t1";
const workspaceId = "w1";
const panes = ["w1:p1", "w1:p2", "w1:p3", "w1:p4"];

/** A fake Herdr from the 0.9.5 schema (one tab of four panes, two columns each split down). */
class SchemaHerdr implements HerdrTransport {
  readonly sent: { method: string; params: Json }[] = [];
  tab: DemoTabLayout = { root: defaultTree(panes), zoomed: false, focused: "w1:p1" };
  bounds: readonly [number, number] = [0, 1];

  roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params: Json };
    this.sent.push({ method: request.method, params: request.params });
    const answer = (result: unknown) => Promise.resolve(JSON.stringify({ id: request.id, result }));
    const refuse = (code: string, message: string) => Promise.resolve(JSON.stringify({ id: request.id, error: { code, message } }));
    const params = request.params ?? {};
    switch (request.method) {
      case "pane.layout": {
        if (!panes.includes(String(params["pane_id"]))) return refuse("pane_not_found", "no such pane");
        return answer({ type: "pane_layout", layout: this.snapshot() });
      }
      case "pane.zoom": {
        const mode = params["mode"] ?? "toggle";
        if (mode !== "toggle" && mode !== "on" && mode !== "off") return refuse("invalid_params", "mode is toggle, on or off");
        const paneId = typeof params["pane_id"] === "string" ? params["pane_id"] : this.tab.focused;
        if (!panes.includes(paneId)) return refuse("pane_not_found", "no such pane");
        const before = this.tab;
        const single = treePanes(before.root).length === 1;
        const zoomed = single ? false : mode === "toggle" ? !before.zoomed : mode === "on";
        this.tab = { ...before, zoomed, focused: paneId };
        const zoomChanged = zoomed !== before.zoomed;
        const focusChanged = paneId !== before.focused;
        return answer({
          type: "pane_zoom",
          zoom: {
            changed: zoomChanged || focusChanged,
            zoom_changed: zoomChanged,
            focus_changed: focusChanged,
            pane_id: paneId,
            focused_pane_id: paneId,
            zoomed,
            layout: this.snapshot(),
            reason: single ? "single_pane" : zoomChanged ? null : zoomed ? "already_zoomed" : "already_unzoomed",
          },
        });
      }
      case "layout.set_split_ratio": {
        const steps = params["path"];
        const ratio = params["ratio"];
        if (!Array.isArray(steps) || !steps.every((step) => typeof step === "boolean") || typeof ratio !== "number") return refuse("invalid_params", "path and ratio");
        if (params["tab_id"] !== undefined && params["tab_id"] !== null && params["tab_id"] !== tabId) return refuse("tab_not_found", "no such tab");
        const set = (node: DemoTabLayout["root"], rest: readonly boolean[]): DemoTabLayout["root"] | null => {
          if (node.type === "pane") return null;
          if (rest.length === 0) return { ...node, ratio: Math.min(this.bounds[1], Math.max(this.bounds[0], ratio)) };
          const inner = set(rest[0] ? node.second : node.first, rest.slice(1));
          if (inner === null) return null;
          return rest[0] ? { ...node, second: inner } : { ...node, first: inner };
        };
        const root = set(this.tab.root, steps as boolean[]);
        if (root === null) return refuse("invalid_params", "no split at that path");
        this.tab = { ...this.tab, root };
        const describe = (node: DemoTabLayout["root"]): Json =>
          node.type === "pane"
            ? { type: "pane", pane_id: node.paneId, cwd: null, label: null }
            : { type: "split", direction: node.direction, ratio: node.ratio, first: describe(node.first), second: describe(node.second) };
        return answer({
          type: "layout_split_ratio_set",
          layout: { workspace_id: workspaceId, tab_id: tabId, zoomed: this.tab.zoomed, focused_pane_id: this.tab.focused, root: describe(this.tab.root) },
        });
      }
      case "pane.split": {
        const target = String(params["target_pane_id"]);
        if (!panes.includes(target)) return refuse("pane_not_found", "no such pane");
        return answer({ type: "pane_info", pane: { pane_id: "w1:p9", terminal_id: "t-w1:p9", workspace_id: workspaceId, tab_id: tabId, focused: false, agent_status: "unknown", revision: 1 } });
      }
      case "tab.rename":
        // TabRenameParams { tab_id, label }: both required strings; answered tab_info { tab }.
        if (typeof params["tab_id"] !== "string" || typeof params["label"] !== "string") return refuse("invalid_params", "tab_id and label are strings");
        return answer({ type: "tab_info", tab: { tab_id: params["tab_id"], workspace_id: workspaceId, number: 1, label: params["label"], focused: true, pane_count: 1, agent_status: "idle" } });
      case "pane.rename":
      case "pane.focus":
      case "pane.focus_direction":
        return answer({ type: "ok" });
      default:
        return refuse("unknown_method", `not in this fake: ${request.method}`);
    }
  }

  snapshot(): Json {
    return layoutJson(tabId, workspaceId, this.tab);
  }

  close(): void {}
}

function topology(ids: readonly string[] = panes): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: workspaceId, number: 1, label: "app", focused: true, pane_count: ids.length, tab_count: 1, active_tab_id: tabId, agent_status: "idle" }],
    tabs: [{ tab_id: tabId, workspace_id: workspaceId, number: 1, label: "", focused: true, pane_count: ids.length, agent_status: "idle" }],
    panes: ids.map((id) => ({ pane_id: id, terminal_id: `t-${id}`, workspace_id: workspaceId, tab_id: tabId, focused: false, agent_status: "unknown", revision: 1 })),
    layouts: [],
    agents: [],
  });
}

/** An action as the page asks it, before it is bound (the helper binds it as the window shows the tab). */
type Unbound = { readonly type: string; readonly paneId: string } & Record<string, unknown>;

/**
 * The main process's pane actions over SchemaHerdr, with the layouts it
 * accepted and read again; the window shows the tab as SchemaHerdr has it, and
 * `run` binds each action to the pane as shown (the binding is checked on a
 * fresh layout read, the pane.layout before each request).
 */
function actions(herdr: SchemaHerdr, log = new OnceLog(() => undefined), ids: readonly string[] = panes) {
  const client = new HerdrClient(herdr);
  const backend = { paneActions: () => client } as unknown as HerdrHostBackend;
  const snapshot = topology(ids);
  const hosts = { backend: () => backend, topology: () => snapshot, refresh: () => Promise.resolve(), fresh: () => Promise.resolve(true), connection: () => 1, connectionIdentity: () => ({ incarnation: 1, epoch: 0 }) };
  const accepted: PaneLayout[] = [];
  const rereads: string[] = [];
  const shown = (): PaneLayout => decodePaneLayout(herdr.snapshot());
  const layouts = {
    reread: (hostId: string) => (rereads.push(hostId), Promise.resolve()),
    accept: (_hostId: string, layout: PaneLayout) => accepted.push(layout),
    watched: () => ({ hostId: "mini", layout: shown() }),
  };
  const page = { id: 1 };
  const run = (action: Unbound) => {
    const layout = shown();
    const binding = paneBindingOf({ connection: 1, incarnation: 1, epoch: 0, topology: snapshot }, layout, action.paneId)!;
    const path = action.type === "resize" ? (splitPathOf(layout, String(action["splitId"])) ?? []) : null;
    const shape = action.type === "resize" ? (splitShapeOf(layout, String(action["splitId"])) ?? "no such split") : null;
    return runPaneAction(hosts, layouts, page, "mini", { ...action, binding, ...(path === null ? {} : { path, shape }) } as unknown as PaneAction, log);
  };
  return { client, hosts, layouts, accepted, rereads, run };
}

// MARK: - Fix 1: zoom sends mode on or off

describe("pane.zoom as Herdr 0.9.5 takes it", () => {
  it("sends mode on or off, never a toggle, so asking twice keeps the zoom asked for", async () => {
    const herdr = new SchemaHerdr();
    const client = new HerdrClient(herdr);
    const first = await client.zoomPane("w1:p2", true);
    const again = await client.zoomPane("w1:p2", true);
    expect([first.zoomed, again.zoomed]).toEqual([true, true]);
    expect(herdr.tab.zoomed).toBe(true);
    const off = await client.zoomPane("w1:p2", false);
    const offAgain = await client.zoomPane("w1:p2", false);
    expect([off.zoomed, offAgain.zoomed]).toEqual([false, false]);
    expect(herdr.sent).toEqual([
      { method: "pane.zoom", params: { pane_id: "w1:p2", mode: "on" } },
      { method: "pane.zoom", params: { pane_id: "w1:p2", mode: "on" } },
      { method: "pane.zoom", params: { pane_id: "w1:p2", mode: "off" } },
      { method: "pane.zoom", params: { pane_id: "w1:p2", mode: "off" } },
    ]);
  });

  it("reads zoomed and the tab's layout from the reply", async () => {
    const herdr = new SchemaHerdr();
    const zoom = await new HerdrClient(herdr).zoomPane("w1:p3", true);
    expect(zoom).toMatchObject({ zoomed: true, focusedPaneId: "w1:p3" });
    expect(zoom.layout).toMatchObject({ tabId, workspaceId, zoomed: true, focusedPaneId: "w1:p3" });
    expect(zoom.layout.panes.map((pane) => pane.paneId)).toEqual(panes);
  });

  it("the zoom action shows the reply's layout, with no second read", async () => {
    const herdr = new SchemaHerdr();
    const a = actions(herdr);
    await a.run({ type: "zoom", paneId: "w1:p4", zoomed: true });
    expect(a.accepted).toHaveLength(1);
    expect(a.accepted[0]).toMatchObject({ tabId, zoomed: true, focusedPaneId: "w1:p4" });
    expect(a.rereads).toEqual([]);
    // The tab's layout read fresh to check the binding, then the zoom; no read after it.
    expect(herdr.sent.map((request) => request.method)).toEqual(["pane.layout", "pane.zoom"]);
    await a.run({ type: "zoom", paneId: "w1:p4", zoomed: false });
    expect(a.accepted.at(-1)).toMatchObject({ zoomed: false });
  });

  it("the demo's Herdr takes mode as Herdr does: on and off as asked, a toggle when left out", async () => {
    const host = demoHosts(bundledFixturesForTests(), Date.now())[0]!;
    const transport = new FixtureTransport(host.snapshot);
    const zoom = async (params: Json) => {
      const reply = JSON.parse(await transport.roundTrip(JSON.stringify({ id: "z", method: "pane.zoom", params }))) as { result: { type: string; zoom: { zoomed: boolean; layout: Json } } };
      expect(reply.result.type).toBe("pane_zoom");
      return reply.result.zoom;
    };
    expect((await zoom({ pane_id: "w7:p1H", mode: "on" })).zoomed).toBe(true);
    expect((await zoom({ pane_id: "w7:p1H", mode: "on" })).zoomed).toBe(true);
    // The old {on: true} is not Herdr's: left out, mode is a toggle.
    expect((await zoom({ pane_id: "w7:p1H", on: true })).zoomed).toBe(false);
    expect((await zoom({ pane_id: "w7:p1H" })).zoomed).toBe(true);
    const off = await zoom({ pane_id: "w7:p1H", mode: "off" });
    expect(off.zoomed).toBe(false);
    expect(off.layout).toMatchObject({ tab_id: "w7:tK", zoomed: false });
  });
});

// MARK: - The layout from a reply, shown at once

class Page implements LayoutOwner {
  readonly updates: LayoutUpdateEvent[] = [];
  constructor(readonly id: number) {}
  send(_channel: string, payload: LayoutUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return false;
  }
}

describe("a layout that came with a reply", () => {
  it("is sent to the windows showing its tab at once, and a read still in flight does not undo it", async () => {
    const herdr = new SchemaHerdr();
    const client = new HerdrClient(herdr);
    let holding = false;
    const held: (() => void)[] = [];
    const slow = {
      paneLayout: async (paneId: string) => {
        const layout = await client.paneLayout(paneId);
        if (holding) await new Promise<void>((resolve) => held.push(resolve));
        return layout;
      },
    };
    const snapshot = topology();
    const hosts: LayoutHosts = {
      backend: () => ({ paneActions: () => slow }) as unknown as HerdrHostBackend,
      pane: (_hostId, paneId) => snapshot.panes.find((pane) => pane.paneID === paneId) ?? null,
      topology: () => snapshot,
      refresh: () => Promise.resolve(),
    };
    const service = new LayoutService(hosts, "layout", { debounceMs: 0 });
    const page = new Page(1);
    const other = new Page(2);
    service.watch(page, "mini", "w1:p1");
    service.watch(other, "mini", "w1:p3");
    expect(await eventually(() => page.updates.at(-1)?.layout != null && other.updates.at(-1)?.layout != null)).toBe(true);
    // Reads start (unzoomed) and are held; meanwhile a zoom's reply arrives.
    holding = true;
    const reading = service.reread("mini");
    expect(await eventually(() => held.length === 2)).toBe(true);
    holding = false;
    const zoom = await client.zoomPane("w1:p3", true);
    service.accept("mini", zoom.layout);
    expect(page.updates.at(-1)?.layout).toMatchObject({ zoomed: true, focusedPaneId: "w1:p3" });
    expect(other.updates.at(-1)?.layout).toMatchObject({ zoomed: true });
    for (const release of held) release();
    await reading;
    expect(page.updates.at(-1)?.layout).toMatchObject({ zoomed: true });
    // A layout of another tab changes nothing here.
    const count = page.updates.length;
    service.accept("mini", { ...zoom.layout, tabId: "w1:t9" });
    expect(page.updates.length).toBe(count);
    service.closeAll();
  });
});

// MARK: - Fix 2: a divider drag sets that split's ratio

const fixture = (name: string): PaneLayout =>
  decodePaneLayout((JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "fixtures", "layout", `${name}.json`), "utf8")) as { result: { layout: unknown } }).result.layout);

describe("the path to a split, as layout.set_split_ratio takes it", () => {
  it("is the sides from the root to the split (false the first, true the second), as Herdr's ids name the last one", () => {
    const four = tileTree(fixture("layout-four-panes"))!;
    expect([splitPath(four, "split_0_root"), splitPath(four, "split_1_0"), splitPath(four, "split_2_1")]).toEqual([[], [false], [true]]);
    const three = tileTree(fixture("layout-three-panes"))!;
    expect([splitPath(three, "split_0_root"), splitPath(three, "split_1_1")]).toEqual([[], [true]]);
    expect(splitPath(tileTree(fixture("layout-workers-tab"))!, "split_0_root")).toEqual([]);
  });

  it("is none for a split Herdr did not name, or one whose id says another side", () => {
    const layout = fixture("layout-four-panes");
    const four = tileTree(layout)!;
    expect(splitPath(four, "split_9_1")).toBeNull();
    // Rebuilt from the rects alone: the tree's splits are not Herdr's.
    const bare = tileTree({ ...layout, splits: [] })!;
    expect(bare.type === "split" ? splitPath(bare, bare.id) : "pane").toBeNull();
    // An id naming the first side for a split on the second: the path is not trusted.
    const odd = tileTree({ ...layout, splits: layout.splits.map((split) => (split.id === "split_2_1" ? { ...split, id: "split_2_0" } : split)) })!;
    expect(splitPath(odd, "split_2_0")).toBeNull();
  });

  it("a release reads into the split and its new ratio; under half a cell is no move", () => {
    const decision = decideTiles(fixture("layout-four-panes"), "w7:p4S");
    if (decision.kind !== "tiles") throw new Error("expected tiles");
    const [root, left] = decision.dividers;
    expect(ratioRequest(root!, 0.4)).toEqual({ paneId: "w7:p4S", splitId: "split_0_root", ratio: 0.4 });
    expect(ratioRequest(left!, 0.66667)).toEqual({ paneId: "w7:p4S", splitId: "split_1_0", ratio: 0.6667 });
    expect(ratioRequest(root!, root!.at + 0.4 / root!.extent)).toBeNull();
  });

  it("the page's action names the split, its path as shown and the ratio, bound to its pane", () => {
    const binding = { connection: 1, incarnation: 1, epoch: 0, workspaceId, tabId, paneId: "w1:p1", terminalID: "t-w1:p1", agent: null, session: null };
    const shape = JSON.stringify(["split_0_root", "right", "w1:p1", "w1:p2"]);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], shape, ratio: 0.4, binding })).toBe(true);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], shape, ratio: 1.2, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", shape, ratio: 0.4, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [1], shape, ratio: 0.4, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], shape, ratio: 0.4 })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", path: [], shape, ratio: 0.4, binding })).toBe(false);
    // Fix 3 (1c): the whole split as shown is part of it.
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], ratio: 0.4, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], shape: "", ratio: 0.4, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", path: [], shape: "x".repeat(9000), ratio: 0.4, binding })).toBe(false);
    expect(isPaneAction({ type: "resize", paneId: "w1:p1", direction: "right", delta: 0.1, extent: 134, binding })).toBe(false);
  });
});

describe("a divider released", () => {
  it("sends one layout.set_split_ratio for its split (the tab, the path, the ratio) and shows Herdr's layout after", async () => {
    const herdr = new SchemaHerdr();
    const a = actions(herdr);
    await a.run({ type: "resize", paneId: "w1:p3", splitId: "split_2_1", ratio: 0.3 });
    expect(herdr.sent.map((request) => request.method)).toEqual(["pane.layout", "layout.set_split_ratio"]);
    expect(herdr.sent[1]!.params).toEqual({ tab_id: tabId, path: [true], ratio: 0.3 });
    expect(a.rereads).toEqual(["mini"]);
    const after = await a.client.paneLayout("w1:p3");
    expect(after.splits.find((split) => split.id === "split_2_1")!.ratio).toBeCloseTo(0.3, 5);
    expect(after.panes.find((pane) => pane.paneId === "w1:p3")!.rect.height).toBe(Math.round(45 * 0.3));
    await a.run({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", ratio: 0.6 });
    expect(herdr.sent.at(-1)!.params).toEqual({ tab_id: tabId, path: [], ratio: 0.6 });
    expect(herdr.sent.some((request) => request.method === "pane.resize")).toBe(false);
  });

  it("settles to Herdr's layout when the reply has another ratio, and logs that once", async () => {
    const herdr = new SchemaHerdr();
    herdr.bounds = [0.2, 0.8];
    const lines: string[] = [];
    const a = actions(herdr, new OnceLog((line) => lines.push(line)));
    await a.run({ type: "resize", paneId: "w1:p1", splitId: "split_0_root", ratio: 0.1 });
    await a.run({ type: "resize", paneId: "w1:p1", splitId: "split_1_0", ratio: 0.9 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/layout\.set_split_ratio/);
    expect(lines[0]).toMatch(/0\.1/);
    expect(lines[0]).toMatch(/0\.2/);
    // Read again each time: the window shows what Herdr kept.
    expect(a.rereads).toEqual(["mini", "mini"]);
    expect((await a.client.paneLayout("w1:p1")).splits[0]!.ratio).toBeCloseTo(0.2, 5);
  });

  it("refuses a split Herdr's layout no longer has, sending nothing", async () => {
    const herdr = new SchemaHerdr();
    const a = actions(herdr);
    await expect(a.run({ type: "resize", paneId: "w1:p1", splitId: "split_7_1", ratio: 0.4 })).rejects.toThrow("Herdr's layout no longer has that divider where it was shown.");
    // Refused on the window's shown layout first: nothing is even read.
    expect(herdr.sent.map((request) => request.method)).toEqual([]);
  });

  it("the demo's Herdr sets a split's ratio by its path and answers with the layout tree", async () => {
    const host = demoHosts(bundledFixturesForTests(), Date.now())[0]!;
    const transport = new FixtureTransport(host.snapshot);
    const call = async (method: string, params: Json) => JSON.parse(await transport.roundTrip(JSON.stringify({ id: "r", method, params }))) as { result?: Json & { layout: Json }; error?: { code: string } };
    const set = await call("layout.set_split_ratio", { tab_id: "w7:tK", path: [], ratio: 0.3 });
    expect(set.result).toMatchObject({ type: "layout_split_ratio_set", layout: { tab_id: "w7:tK", root: { type: "split", direction: "right", ratio: 0.3 } } });
    const layout = await call("pane.layout", { pane_id: "w7:p1G" });
    expect(layout.result!.layout).toMatchObject({ splits: [{ id: "split_0_root", ratio: 0.3 }] });
    // The second side is a pane: no split there.
    expect((await call("layout.set_split_ratio", { tab_id: "w7:tK", path: [true], ratio: 0.3 })).error?.code).toBe("invalid_params");
  });

  it("the table: layout.set_split_ratio with its path's encoding inferred; pane.resize kept, unused, its amount's unit unknown", () => {
    expect(paneMethods.setSplitRatio.method).toBe("layout.set_split_ratio");
    expect(paneMethods.setSplitRatio.params("w1:t1", [true, false], 0.25)).toEqual({ tab_id: "w1:t1", path: [true, false], ratio: 0.25 });
    expect(paneMethods.setSplitRatio.pathEncoding).toMatch(/^inferred/);
    expect(paneMethods.resize).toMatchObject({ method: "pane.resize", used: false, amountUnit: "unknown" });
  });
});

// MARK: - Fix 3: rename and focus in the table, not sent

describe("pane.rename, pane.focus and pane.focus_direction", () => {
  it("are in the table as the schema has them: rename used (the Rename… action), focus and focus_direction not sent", () => {
    expect(paneMethods.rename).toMatchObject({ method: "pane.rename", status: "confirmed", used: true });
    expect(paneMethods.rename.params("w1:p9", "build")).toEqual({ pane_id: "w1:p9", label: "build" });
    expect(paneMethods.rename.params("w1:p9", null)).toEqual({ pane_id: "w1:p9", label: null });
    // tab.rename, TabRenameParams { tab_id, label } (a string, never null).
    expect(paneMethods.renameTab).toMatchObject({ method: "tab.rename", status: "confirmed", used: true });
    expect(paneMethods.renameTab.params("w1:t2", "build notes")).toEqual({ tab_id: "w1:t2", label: "build notes" });
    expect(paneMethods.focus).toMatchObject({ method: "pane.focus", status: "confirmed", sentOnTileClick: false });
    expect(paneMethods.focus.params("w1:p2")).toEqual({ pane_id: "w1:p2" });
    expect(paneMethods.focusDirection).toMatchObject({ method: "pane.focus_direction", status: "confirmed", used: false });
    expect(paneMethods.focusDirection.params("w1:p2", "left")).toEqual({ pane_id: "w1:p2", direction: "left" });
  });

  it("tab.rename goes out as the schema has it, {tab_id, label}, and its tab_info answer is taken", async () => {
    const herdr = new SchemaHerdr();
    await new HerdrClient(herdr).renameTab("w1:t1", "Notes Fable");
    expect(herdr.sent).toEqual([{ method: "tab.rename", params: { tab_id: "w1:t1", label: "Notes Fable" } }]);
  });

  it("a split from the menu sends pane.split alone: no label, no focus", async () => {
    const herdr = new SchemaHerdr();
    herdr.tab = { root: defaultTree(panes.slice(0, 3)), zoomed: false, focused: "w1:p1" };
    const a = actions(herdr, undefined, panes.slice(0, 3));
    const result = await a.run({ type: "split", paneId: "w1:p2", direction: "down" });
    expect(result.paneId).toBe("w1:p9");
    // The tab's layout read fresh first (the four-pane limit on fresh state), then the split alone.
    expect(herdr.sent.map((request) => request.method)).toEqual(["pane.layout", "pane.split"]);
    expect(herdr.sent[1]!.params).toEqual({ workspace_id: workspaceId, target_pane_id: "w1:p2", direction: "down", focus: false });
  });
});
