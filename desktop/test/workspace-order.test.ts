// The sidebar's workspace order this Mac keeps: the one function
// that makes it (sidebar-model.ts orderWorkspaces, through buildSidebarModel),
// the saved order's moves and its lenient reading, per machine.

import { describe, expect, it } from "vitest";

import {
  buildDesktopSidebar,
  dropWorkspace,
  machineWorkspaceOrder,
  nextNeedsYou,
  stepWorkspace,
  workspaceMoveReasons,
  workspaceMoveTexts,
  type SidebarHost,
} from "../src/shared/desktop-sidebar";
import {
  buildSidebarModel,
  emptyFoldState,
  fold,
  orderWorkspaces,
  savedWorkspaceOrder,
  workspaceMoves,
  workspaceOrderCap,
  type PlacedWorkspace,
  type SidebarFoldState,
} from "../src/shared/sidebar-model";
import { input, nowUnixMs, topology } from "./support/sidebar-fixture";
import { reorderMachine } from "./support/reorder-hosts";

/** The fixture's workspaces in Herdr's order (number 1 to 11). */
const herdrOrder = ["w3", "w2", "w5", "w6", "w7", "w8", "w9", "wA", "wB", "wC", "wD"];

const sections = (state: SidebarFoldState, mac = "mac-mini"): string[] =>
  buildSidebarModel(input({ fold: state, mac })).projects.map((section) => section.header.workspaceID);

const placed = (ids: readonly string[], seen = 1): PlacedWorkspace[] => ids.map((id) => ({ id, seen }));

const withOrder = (order: Record<string, readonly string[]>, base: SidebarFoldState = emptyFoldState): SidebarFoldState => ({
  ...base,
  workspaceOrder: Object.fromEntries(Object.entries(order).map(([mac, ids]) => [mac, placed(ids)])),
});

/** A machine whose Herdr lists `workspaces` (id and number), each with one agent pane of `status`. */
const machine = (id: string, workspaces: readonly (readonly [string, number])[], status: Record<string, string> = {}): SidebarHost =>
  reorderMachine(id, workspaces, status);

describe("the order function (orderWorkspaces, in buildSidebarModel)", () => {
  it("no saved order is today's order exactly: Herdr's number, then list order", () => {
    expect(sections(emptyFoldState)).toEqual(herdrOrder);
    // Another machine's order, an empty one and a fold without any change nothing here.
    expect(sections(withOrder({ studio: ["wD", "w7"] }))).toEqual(herdrOrder);
    expect(sections({ ...emptyFoldState, workspaceOrder: { "mac-mini": [] } })).toEqual(herdrOrder);
    expect(buildSidebarModel(input({ fold: withOrder({ studio: ["wD"] }) }))).toEqual(buildSidebarModel(input()));
    const list = [
      { id: "b", number: 2 },
      { id: "a", number: 1 },
      { id: "c", number: 2 },
    ];
    expect(orderWorkspaces(list).map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(orderWorkspaces(list, []).map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(orderWorkspaces(list, undefined).map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("follows a saved order, and puts the workspaces never placed after it, in Herdr's order", () => {
    const state = withOrder({ "mac-mini": ["wD", "w7", "w3"] });
    expect(sections(state)).toEqual(["wD", "w7", "w3", "w2", "w5", "w6", "w8", "w9", "wA", "wB", "wC"]);
    // A new workspace Herdr lists later comes after the placed ones too.
    expect(orderWorkspaces([{ id: "new", number: 0 }, { id: "x", number: 5 }, { id: "y", number: 1 }], ["x"]).map((w) => w.id)).toEqual(["x", "new", "y"]);
  });

  it("a workspace gone from Herdr keeps its slot in the saved order and returns to it", () => {
    let state = withOrder({ "mac-mini": ["w7", "gone", "w3"] });
    expect(sections(state)).toEqual(["w7", "w3", "w2", "w5", "w6", "w8", "w9", "wA", "wB", "wC", "wD"]);
    // Moved while it is gone: w2 goes before w3; gone stays between w7 and w2.
    state = fold.moveWorkspace(state, "mac-mini", sections(state), "w2", 1, 50);
    expect(savedWorkspaceOrder(state, "mac-mini")?.slice(0, 4)).toEqual(["w7", "gone", "w2", "w3"]);
    expect(state.workspaceOrder?.["mac-mini"]?.find((entry) => entry.id === "gone")?.seen).toBe(1);
    // Back (a machine that was offline): in its place, whatever its number.
    const back = orderWorkspaces([...herdrOrder.map((id, index) => ({ id, number: index + 1 })), { id: "gone", number: 99 }], savedWorkspaceOrder(state, "mac-mini"));
    expect(back.map((w) => w.id).slice(0, 5)).toEqual(["w7", "gone", "w2", "w3", "w5"]);
    // Moved last: after the last listed one. The gone one keeps its place between b and c (c was never
    // placed, so it came after every placed one, the gone one too).
    let tail = withOrder({ m: ["a", "b", "gone"] });
    const host = machine("m", [["a", 1], ["b", 2], ["c", 3]]);
    tail = dropWorkspace(tail, host, "a", null, 9);
    expect(savedWorkspaceOrder(tail, "m")).toEqual(["b", "gone", "c", "a"]);
    expect(machineWorkspaceOrder(host, tail)).toEqual(["b", "c", "a"]);
    // A gone one after the last listed one stays after it when a workspace goes last.
    let after = withOrder({ m: ["a", "b", "c", "gone"] });
    after = dropWorkspace(after, host, "a", null, 9);
    expect(savedWorkspaceOrder(after, "m")).toEqual(["b", "c", "a", "gone"]);
  });

  it("a workspace listed twice shows once: Herdr's list, or the saved order (its first place wins)", () => {
    const twice = { ...input({ fold: withOrder({ "mac-mini": ["w7", "w2", "w7"] }) }) };
    const doubled = { ...twice, workspaces: [...twice.workspaces, twice.workspaces.find((w) => w.id === "w2")!] };
    const ids = buildSidebarModel(doubled).projects.map((section) => section.header.workspaceID);
    expect(ids.slice(0, 3)).toEqual(["w7", "w2", "w3"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(savedWorkspaceOrder(withOrder({ m: ["a", "b", "a"] }), "m")).toEqual(["a", "b"]);
    // A move on a list given with a repeat counts it once.
    const moved = fold.moveWorkspace(emptyFoldState, "m", ["a", "b", "b", "c"], "c", 0, 1);
    expect(savedWorkspaceOrder(moved, "m")).toEqual(["c", "a", "b"]);
  });

  it("two machines keep separate orders", () => {
    const mini = machine("mini", [["a", 1], ["b", 2], ["c", 3]]);
    const studio = machine("studio", [["a", 1], ["b", 2], ["c", 3]]);
    let state = dropWorkspace(emptyFoldState, mini, "c", "a", 5);
    state = dropWorkspace(state, studio, "a", null, 6);
    expect(machineWorkspaceOrder(mini, state)).toEqual(["c", "a", "b"]);
    expect(machineWorkspaceOrder(studio, state)).toEqual(["b", "c", "a"]);
    const sidebar = buildDesktopSidebar([mini, studio], { fold: state, nowUnixMs });
    expect(sidebar.hosts.map((section) => section.model!.projects.map((p) => p.header.workspaceID))).toEqual([
      ["c", "a", "b"],
      ["b", "c", "a"],
    ]);
  });

  it("caps a machine's saved order at 500: the workspace unseen longest goes first", () => {
    // 500 gone ones (seen at 1000 + i, except one seen at 1), plus the 11 listed now.
    const gone: PlacedWorkspace[] = Array.from({ length: workspaceOrderCap }, (_, i) => ({ id: `g${i}`, seen: i === 250 ? 1 : 1000 + i }));
    const state: SidebarFoldState = { ...emptyFoldState, workspaceOrder: { "mac-mini": gone } };
    expect(sections(state)).toEqual(herdrOrder);
    const moved = fold.moveWorkspace(state, "mac-mini", herdrOrder, "wD", 0, 99_999);
    const kept = moved.workspaceOrder!["mac-mini"]!;
    expect(kept).toHaveLength(workspaceOrderCap);
    const ids = new Set(kept.map((entry) => entry.id));
    for (const dropped of ["g250", "g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9"]) expect(ids.has(dropped)).toBe(false);
    expect(ids.has("g10")).toBe(true);
    for (const listed of herdrOrder) expect(ids.has(listed)).toBe(true);
    expect(kept.filter((entry) => herdrOrder.includes(entry.id)).every((entry) => entry.seen === 99_999)).toBe(true);
    expect(sections(moved)[0]).toBe("wD");
    // Saved and read back, it is still an order (at the cap, not past it).
    expect(sections(fold.decode(JSON.parse(JSON.stringify(moved))))[0]).toBe("wD");
  });

  it("a malformed or too long saved value reads as no order (for that machine only)", () => {
    const good = [{ id: "wD", seen: 1 }];
    const read = (workspaceOrder: unknown): SidebarFoldState => fold.decode({ mode: "projects", workspaceOrder });
    for (const bad of [
      "wD",
      42,
      null,
      ["wD"],
      { "mac-mini": "wD" },
      { "mac-mini": ["wD"] },
      { "mac-mini": [{ id: "wD" }] },
      { "mac-mini": [{ id: 7, seen: 1 }] },
      { "mac-mini": [{ id: "", seen: 1 }] },
      { "mac-mini": [{ id: "wD", seen: "1" }] },
      { "mac-mini": [{ id: "wD", seen: 1 }, null] },
      { "mac-mini": [[{ id: "wD", seen: 1 }]] },
      { "mac-mini": Array.from({ length: workspaceOrderCap + 1 }, (_, i) => ({ id: `x${i}`, seen: 1 })) },
    ]) {
      const state = read(bad);
      expect(sections(state)).toEqual(herdrOrder);
      expect(state.workspaceOrder).toBeUndefined();
    }
    // One machine's bad value leaves another's good one.
    const mixed = read({ "mac-mini": good, studio: [{ id: 3 }] });
    expect(sections(mixed)[0]).toBe("wD");
    expect(Object.keys(mixed.workspaceOrder ?? {})).toEqual(["mac-mini"]);
    // No order saved: decode gives the fold it gave before workspaces could be reordered (no workspaceOrder key).
    expect(fold.decode({})).toEqual(emptyFoldState);
    expect(Object.keys(fold.decode({}))).not.toContain("workspaceOrder");
    // A saved order round-trips with its folds.
    const state = fold.toggleWorkspace(withOrder({ "mac-mini": ["wD", "w7"] }), "w7", "mac-mini");
    expect(fold.decode(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});

describe("moving", () => {
  it("puts a workspace at the slot, and a slot that leaves it where it is changes nothing", () => {
    const shown = ["a", "b", "c", "d"];
    expect(savedWorkspaceOrder(fold.moveWorkspace(emptyFoldState, "m", shown, "a", 3, 1), "m")).toEqual(["b", "c", "a", "d"]);
    expect(savedWorkspaceOrder(fold.moveWorkspace(emptyFoldState, "m", shown, "a", 4, 1), "m")).toEqual(["b", "c", "d", "a"]);
    expect(savedWorkspaceOrder(fold.moveWorkspace(emptyFoldState, "m", shown, "d", 0, 1), "m")).toEqual(["d", "a", "b", "c"]);
    expect(savedWorkspaceOrder(fold.moveWorkspace(emptyFoldState, "m", shown, "c", 1, 1), "m")).toEqual(["a", "c", "b", "d"]);
    for (const slot of [1, 2]) expect(fold.moveWorkspace(emptyFoldState, "m", shown, "b", slot, 1)).toBe(emptyFoldState);
    expect(fold.moveWorkspace(emptyFoldState, "m", shown, "zz", 0, 1)).toBe(emptyFoldState);
    expect(fold.moveWorkspace(emptyFoldState, "m", ["a"], "a", 0, 1)).toBe(emptyFoldState);
    expect(fold.moveWorkspace(emptyFoldState, "m", shown, "a", Number.NaN, 1)).toBe(emptyFoldState);
    // Out of range slots are held to the ends.
    expect(savedWorkspaceOrder(fold.moveWorkspace(emptyFoldState, "m", shown, "a", 99, 1), "m")).toEqual(["b", "c", "d", "a"]);
    expect(savedWorkspaceOrder(fold.moveWorkspace(emptyFoldState, "m", shown, "d", -3, 1), "m")).toEqual(["d", "a", "b", "c"]);
  });

  it("Move up and Move down: one place, greyed at either end and while searching", () => {
    const host = machine("m", [["a", 1], ["b", 2], ["c", 3]]);
    expect(workspaceMoves(["a", "b", "c"], "a")).toEqual({ up: false, down: true });
    expect(workspaceMoves(["a", "b", "c"], "b")).toEqual({ up: true, down: true });
    expect(workspaceMoves(["a", "b", "c"], "c")).toEqual({ up: true, down: false });
    expect(workspaceMoveReasons(host, emptyFoldState, false, "a")).toEqual({ up: workspaceMoveTexts.top, down: null });
    expect(workspaceMoveReasons(host, emptyFoldState, false, "c")).toEqual({ up: null, down: workspaceMoveTexts.bottom });
    expect(workspaceMoveReasons(host, emptyFoldState, true, "b")).toEqual({ up: workspaceMoveTexts.searching, down: workspaceMoveTexts.searching });
    let state = stepWorkspace(emptyFoldState, host, "a", 1, 1);
    expect(machineWorkspaceOrder(host, state)).toEqual(["b", "a", "c"]);
    state = stepWorkspace(state, host, "a", 1, 2);
    expect(machineWorkspaceOrder(host, state)).toEqual(["b", "c", "a"]);
    expect(stepWorkspace(state, host, "a", 1, 3)).toBe(state);
    state = stepWorkspace(state, host, "b", -1, 4);
    expect(stepWorkspace(state, host, "b", -1, 4)).toBe(state);
    expect(machineWorkspaceOrder(host, state)).toEqual(["b", "c", "a"]);
    expect(workspaceMoveReasons(host, state, false, "b")).toEqual({ up: workspaceMoveTexts.top, down: null });
    expect(workspaceMoveReasons(host, state, false, "a")).toEqual({ up: null, down: workspaceMoveTexts.bottom });
  });

  it("folds stay with their workspace, and the agents inside keep their order", () => {
    let state = fold.toggleWorkspace(emptyFoldState, "w2", "mac-mini");
    const before = buildSidebarModel(input({ fold: state }));
    state = fold.moveWorkspace(state, "mac-mini", herdrOrder, "w2", herdrOrder.length, 1);
    const after = buildSidebarModel(input({ fold: state }));
    const w2 = after.projects.at(-1)!;
    expect(w2.header.workspaceID).toBe("w2");
    expect(w2.header.isFolded).toBe(true);
    expect(w2).toEqual(before.projects.find((section) => section.header.workspaceID === "w2"));
    for (const section of after.projects) {
      expect(section).toEqual(before.projects.find((other) => other.header.workspaceID === section.header.workspaceID));
    }
  });

  it("Priority's last tie-break, the Needs you group and ⇧⌘J follow the new order", () => {
    const host = machine("m", [["a", 1], ["b", 2], ["c", 3]], { a: "blocked", c: "blocked" });
    const plain = buildDesktopSidebar([host], { nowUnixMs });
    expect(plain.needsYou.map((row) => row.row.workspaceID)).toEqual(["a", "c"]);
    expect(plain.priority.find((s) => s.kind === "idle")!.rows.map((row) => row.row.workspaceID)).toEqual(["b"]);
    const state = dropWorkspace(emptyFoldState, host, "c", "a", 1);
    const moved = buildDesktopSidebar([host], { fold: state, nowUnixMs });
    expect(moved.needsYou.map((row) => row.row.workspaceID)).toEqual(["c", "a"]);
    expect(moved.priority.find((s) => s.kind === "needsYou")!.rows.map((row) => row.row.workspaceID)).toEqual(["c", "a"]);
    expect(nextNeedsYou(moved, null)?.row.workspaceID).toBe("c");
    expect(nextNeedsYou(moved, nextNeedsYou(moved, null)!.key)?.row.workspaceID).toBe("a");
    // The same shapes as before.
    expect(Object.keys(nextNeedsYou(moved, null)!)).toEqual(["key", "hostId", "hostName", "row"]);
    expect(topology().workspaces).toHaveLength(herdrOrder.length);
  });
});
