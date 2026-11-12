// The terminal drawer's rules, without a
// window. What a drawer keeps per machine and pane (open, height, its shells,
// the one shown) across a relaunch, and what a machine's answer prunes; its
// height within the column; its tabs' names; ⌘J taken once when the menu and
// the page both see it. A saved shell that is its owner's own pane or another
// workspace's is dropped. And the pane switch's words:
// Chat · <the agent's own name> · Changes, the stored view still "terminal".

import { describe, expect, it } from "vitest";

import { agentOwnName, agentScreenTitle } from "../src/renderer/components/agent-kind";
import { PaneViews, paneViewsKey } from "../src/shared/pane-view";
import {
  DrawerToggleGate,
  TerminalDrawers,
  closedDrawer,
  defaultDrawerHeight,
  drawerHeight,
  drawerShellLabel,
  drawerShellTabLabel,
  drawerShellsCapacity,
  withShellsBeingMade,
  minimumDrawerHeight,
  drawerShellBelongs,
  minimumViewHeight,
  terminalDrawersKey,
  type DrawerHost,
} from "../src/shared/terminal-drawer";

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

/** An answering machine's snapshot: each pane in workspace w1, unless it is named "<ws>:…" for another (w2:x1 is w2's). */
const answered = (panes: readonly string[], fetchedAtMs = 1_000, id = "mini"): DrawerHost => ({
  id,
  state: "connected",
  fetchedAtMs,
  topology: { panes: panes.map((paneID) => ({ paneID, workspaceID: paneID.split(":")[0]! })) },
});

describe("the switch's words", () => {
  it("names the agent's own screen for each kind; the stored value stays \"terminal\"", () => {
    expect(agentOwnName("claude")).toBe("Claude Code");
    expect(agentOwnName("codex")).toBe("Codex");
    // Every other kind's own name comes from agent-names.ts (Herdr's names).
    expect(agentOwnName("grok")).toBe("Grok Build");
    expect(agentOwnName("cursor")).toBe("Cursor Agent");
    expect(agentOwnName("gemini")).toBe("Gemini CLI");
    expect(agentOwnName("aider")).toBe("Aider");
    expect(agentScreenTitle("claude")).toBe("Claude Code's own screen");
    expect(agentScreenTitle("codex")).toBe("Codex's own screen");
    // Picking that tab keeps "terminal" under the Swift app's key.
    const storage = new MemoryStorage();
    new PaneViews(storage).pick("mini", { paneID: "w1:p1", isAgent: true }, "terminal");
    expect(paneViewsKey).toBe("adari.chat.paneModes");
    expect(JSON.parse(storage.getItem(paneViewsKey)!)).toEqual({ "mini|w1:p1": "terminal" });
  });

  it("restores an old saved pick: a pane kept on Terminal opens on its agent's own screen", () => {
    const storage = new MemoryStorage();
    storage.setItem(paneViewsKey, JSON.stringify({ "mini|w1:p1": "terminal", "mini|w1:p2": "chat" }));
    const views = new PaneViews(storage);
    expect(views.view("mini", { paneID: "w1:p1", isAgent: true })).toBe("terminal");
    expect(views.view("mini", { paneID: "w1:p2", isAgent: true })).toBe("chat");
  });
});

describe("what a drawer keeps", () => {
  it("opens closed with nothing kept; open, height and shells are kept per machine and pane across a relaunch", () => {
    const storage = new MemoryStorage();
    const drawers = new TerminalDrawers(storage);
    expect(drawers.state("mini", "w1:p1")).toBe(closedDrawer);
    drawers.setOpen("mini", "w1:p1", true);
    drawers.addShell("mini", "w1:p1", "w1:pn1", 10);
    drawers.addShell("mini", "w1:p1", "w1:pn2", 20);
    drawers.setHeight("mini", "w1:p1", 333.4);
    expect(drawers.state("mini", "w1:p1")).toEqual({
      open: true,
      height: 333,
      shells: [
        { paneId: "w1:pn1", addedAtMs: 10 },
        { paneId: "w1:pn2", addedAtMs: 20 },
      ],
      active: "w1:pn2",
    });
    // Another pane, another machine: their own.
    expect(drawers.state("mini", "w1:p2")).toBe(closedDrawer);
    expect(drawers.state("box", "w1:p1")).toBe(closedDrawer);
    // The relaunch: a new store on the same storage.
    const again = new TerminalDrawers(storage);
    expect(again.state("mini", "w1:p1")).toEqual(drawers.state("mini", "w1:p1"));
    // Closed, it keeps its shells for next time; the default height again drops the number.
    again.setOpen("mini", "w1:p1", false);
    again.setHeight("mini", "w1:p1", null);
    expect(new TerminalDrawers(storage).state("mini", "w1:p1")).toMatchObject({ open: false, height: null, active: "w1:pn2" });
  });

  it("picks a shell, closes one (the next is shown) and closes the drawer with its last", () => {
    const drawers = new TerminalDrawers(new MemoryStorage());
    drawers.setOpen("mini", "w1:p1", true);
    drawers.addShell("mini", "w1:p1", "w1:pn1", 10);
    drawers.addShell("mini", "w1:p1", "w1:pn2", 20);
    drawers.select("mini", "w1:p1", "w1:pn1");
    expect(drawers.state("mini", "w1:p1").active).toBe("w1:pn1");
    expect(drawers.ownerOf("mini", "w1:pn2")).toBe("w1:p1");
    expect(drawers.ownerOf("mini", "w1:p1")).toBeNull();
    expect(drawers.removeShell("mini", "w1:p1", "w1:pn1")).toBe(false);
    expect(drawers.state("mini", "w1:p1")).toMatchObject({ open: true, active: "w1:pn2" });
    expect(drawers.removeShell("mini", "w1:p1", "w1:pn2")).toBe(true);
    expect(drawers.state("mini", "w1:p1")).toBe(closedDrawer);
    // The snapshot without the last shell pruned it before its close answered: the close still closes the drawer.
    drawers.setOpen("mini", "w1:p1", true);
    drawers.addShell("mini", "w1:p1", "w1:pn3", 30);
    drawers.prune([answered(["w1:p1"], 40)]);
    expect(drawers.state("mini", "w1:p1")).toMatchObject({ open: true, shells: [] });
    expect(drawers.removeShell("mini", "w1:p1", "w1:pn3")).toBe(true);
    expect(drawers.state("mini", "w1:p1")).toBe(closedDrawer);
    expect(drawers.removeShell("mini", "w1:p1", "w1:pn3")).toBe(false);
  });

  it("tells its listeners of each change, and answers the same state until one", () => {
    const drawers = new TerminalDrawers(new MemoryStorage());
    let heard = 0;
    const stop = drawers.subscribe(() => (heard += 1));
    const before = drawers.version();
    drawers.setOpen("mini", "w1:p1", true);
    const state = drawers.state("mini", "w1:p1");
    expect(drawers.state("mini", "w1:p1")).toBe(state);
    expect(heard).toBe(1);
    expect(drawers.version()).toBe(before + 1);
    stop();
    drawers.setOpen("mini", "w1:p1", false);
    expect(heard).toBe(1);
  });

  it("reads back only what is well formed", () => {
    const storage = new MemoryStorage();
    const shells = Array.from({ length: drawerShellsCapacity + 3 }, (_, index) => ({ paneId: `w1:pn${String(index)}`, addedAtMs: index }));
    storage.setItem(
      terminalDrawersKey,
      JSON.stringify({
        "mini|w1:p1": { open: true, height: -5, shells: [...shells, { paneId: 4 }, "x"], active: "nope" },
        "no-bar": { open: true },
        "mini|": { open: true },
        "mini|w1:p2": "open",
        "mini|w1:p3": { open: false, shells: [] },
      }),
    );
    const drawers = new TerminalDrawers(storage);
    const state = drawers.state("mini", "w1:p1");
    expect(state.open).toBe(true);
    expect(state.height).toBeNull();
    expect(state.shells).toHaveLength(drawerShellsCapacity);
    expect(state.active).toBe("w1:pn0");
    expect(drawers.state("mini", "w1:p2")).toBe(closedDrawer);
    expect(drawers.state("mini", "w1:p3")).toBe(closedDrawer);
    storage.setItem(terminalDrawersKey, "{not json");
    expect(new TerminalDrawers(storage).state("mini", "w1:p1")).toBe(closedDrawer);
  });
});

describe("pruning", () => {
  const kept = (): { storage: MemoryStorage; drawers: TerminalDrawers } => {
    const storage = new MemoryStorage();
    const drawers = new TerminalDrawers(storage);
    drawers.setOpen("mini", "w1:p1", true);
    drawers.addShell("mini", "w1:p1", "w1:pn1", 100);
    drawers.addShell("mini", "w1:p1", "w1:pn2", 200);
    return { storage, drawers };
  };

  it("keeps everything while a machine is not answering, or shows its launch cache", () => {
    const { drawers } = kept();
    expect(drawers.prune([{ id: "mini", state: "offline", topology: { panes: [] } }])).toBe(false);
    expect(drawers.prune([{ id: "mini", state: "connecting", topology: null }])).toBe(false);
    expect(drawers.prune([{ ...answered([]), catchingUp: true }])).toBe(false);
    expect(drawers.state("mini", "w1:p1").shells).toHaveLength(2);
  });

  it("drops a shell gone from Herdr, kept across a relaunch; a shell newer than the answer stays", () => {
    const { storage, drawers } = kept();
    // An answer read at 150 lists neither shell: pn1 (opened at 100) is gone; pn2 (opened at 200) was not made yet.
    expect(drawers.prune([answered(["w1:p1"], 150)])).toBe(true);
    expect(drawers.state("mini", "w1:p1")).toMatchObject({ shells: [{ paneId: "w1:pn2", addedAtMs: 200 }], active: "w1:pn2" });
    expect(new TerminalDrawers(storage).state("mini", "w1:p1").shells.map((shell) => shell.paneId)).toEqual(["w1:pn2"]);
    // An answer that lists it keeps it.
    expect(drawers.prune([answered(["w1:p1", "w1:pn2"], 300)])).toBe(false);
  });

  it("drops a shell that is its owner's own pane or another workspace's, read back or pruned; never adds one", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      terminalDrawersKey,
      JSON.stringify({
        "mini|w1:p1": {
          open: true,
          shells: [
            { paneId: "w1:p1", addedAtMs: 1 },
            { paneId: "w2:x1", addedAtMs: 1 },
            { paneId: "w1:pn1", addedAtMs: 1 },
          ],
          active: "w1:p1",
        },
      }),
    );
    const drawers = new TerminalDrawers(storage);
    // Read back: the owner's own pane is gone at once (no snapshot needed); the shown one moves to what is left.
    expect(drawers.state("mini", "w1:p1")).toMatchObject({ shells: [{ paneId: "w2:x1" }, { paneId: "w1:pn1" }], active: "w2:x1" });
    // While the machine shows only its launch cache, nothing is pruned, but the shell is no drawer's in the window.
    expect(drawerShellBelongs("w1:p1", "w2:x1", answered(["w1:p1", "w2:x1"]).topology)).toBe(false);
    expect(drawerShellBelongs("w1:p1", "w1:p1", null)).toBe(false);
    expect(drawerShellBelongs("w1:p1", "w1:pn1", answered(["w1:p1", "w1:pn1"]).topology)).toBe(true);
    expect(drawerShellBelongs("w1:p1", "w1:pn1", null), "not listed yet: kept until a snapshot says otherwise").toBe(true);
    // The first answer: another workspace's pane is dropped though it is listed.
    expect(drawers.prune([answered(["w1:p1", "w2:x1", "w1:pn1"], 50)])).toBe(true);
    expect(drawers.state("mini", "w1:p1")).toMatchObject({ shells: [{ paneId: "w1:pn1" }], active: "w1:pn1" });
    // addShell never takes the owner's own pane.
    drawers.addShell("mini", "w1:p1", "w1:p1", 60);
    expect(drawers.state("mini", "w1:p1").shells.map((shell) => shell.paneId)).toEqual(["w1:pn1"]);
  });

  it("drops the drawer of a pane its machine answered without, and of a machine no longer listed", () => {
    const { storage, drawers } = kept();
    drawers.setOpen("box", "w2:p1", true);
    expect(drawers.prune([answered(["w1:pn1", "w1:pn2"], 300)])).toBe(true);
    expect(drawers.state("mini", "w1:p1")).toBe(closedDrawer);
    expect(drawers.state("box", "w2:p1")).toBe(closedDrawer);
    expect(JSON.parse(storage.getItem(terminalDrawersKey)!)).toEqual({});
  });
});

// The panes the drawers hold, every owner on every machine, which the sidebar leaves out.
describe("the shells the drawers hold", () => {
  it("lists every drawer's shells per machine, every owner; none for a drawer state that is gone", () => {
    const storage = new MemoryStorage();
    const drawers = new TerminalDrawers(storage);
    drawers.addShell("mini", "w1:p1", "w1:pn1", 100);
    drawers.addShell("mini", "w1:p1", "w1:pn2", 200);
    drawers.addShell("mini", "w1:p5", "w1:pn3", 300);
    drawers.addShell("box", "w1:p1", "w1:pn1", 100);
    const hosts = [answered(["w1:p1", "w1:p5", "w1:pn1", "w1:pn2", "w1:pn3"], 400), answered(["w1:p1", "w1:pn1"], 400, "box")];
    const held = drawers.heldShells(hosts);
    expect(Object.keys(held).sort()).toEqual(["box", "mini"]);
    expect([...held["mini"]!].sort()).toEqual(["w1:pn1", "w1:pn2", "w1:pn3"]);
    expect([...held["box"]!]).toEqual(["w1:pn1"]);
    // Read back after a relaunch: the same (the store is the drawers' own).
    expect([...new TerminalDrawers(storage).heldShells(hosts)["mini"]!].sort()).toEqual(["w1:pn1", "w1:pn2", "w1:pn3"]);
    // A shell made a moment ago that the machine does not list yet is held already (no row flashes in as it lands).
    expect([...drawers.heldShells([answered(["w1:p1", "w1:p5"], 50)])["mini"]!].sort()).toEqual(["w1:pn1", "w1:pn2", "w1:pn3"]);
    // Its owner gone from the machine: the drawer is pruned and its shells are no one's.
    drawers.prune([answered(["w1:p5", "w1:pn1", "w1:pn2", "w1:pn3"], 500), answered(["w1:p1", "w1:pn1"], 500, "box")]);
    expect([...drawers.heldShells(hosts)["mini"]!]).toEqual(["w1:pn3"]);
    // A machine no longer listed: none of its drawers.
    drawers.prune([answered(["w1:p5", "w1:pn3"], 600)]);
    expect(drawers.heldShells(hosts)["box"]).toBeUndefined();
  });

  it("never holds the owner's own pane or another workspace's pane, even from a saved state not pruned yet", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      terminalDrawersKey,
      JSON.stringify({ "mini|w1:p1": { open: true, shells: [{ paneId: "w1:p1" }, { paneId: "w2:x1" }, { paneId: "w1:pn1" }], active: null } }),
    );
    const drawers = new TerminalDrawers(storage);
    // The machine on its launch cache: nothing pruned, but another workspace's agent is not hidden by it.
    const cache: DrawerHost = { ...answered(["w1:p1", "w2:x1", "w1:pn1"]), catchingUp: true };
    expect(drawers.prune([cache])).toBe(false);
    expect([...drawers.heldShells([cache])["mini"]!]).toEqual(["w1:pn1"]);
    // No snapshot yet: nothing to check against, and the sidebar lists nothing of that machine.
    expect([...drawers.heldShells([{ id: "mini", state: "connecting", topology: null }])["mini"]!].sort()).toEqual(["w1:pn1", "w2:x1"]);
  });
});

describe("a shell being made", () => {
  // Main's snapshot listing the new pane comes before the answer naming it.
  it("holds a new shell pane of the making drawer's workspace until the answer: not one listed before, another workspace's, or an agent", () => {
    const held = { box: new Set(["w1:pn7"]) };
    const hosts = [
      { id: "mini", topology: { panes: [{ paneID: "w1:p1", workspaceID: "w1", agent: "claude" }, { paneID: "w1:p9", workspaceID: "w1" }, { paneID: "w1:pn1", workspaceID: "w1" }, { paneID: "w1:pn2", workspaceID: "w1", agent: "claude" }, { paneID: "w2:pn3", workspaceID: "w2" }] } },
      { id: "box", topology: null },
    ];
    const making = [{ hostId: "mini", workspaceId: "w1", known: new Set(["w1:p1", "w1:p9"]) }];
    const out = withShellsBeingMade(held, hosts, making);
    expect([...out["mini"]!]).toEqual(["w1:pn1"]);
    expect(out["box"]).toBe(held.box);
    // Nothing being made, or nothing new yet: the held set itself.
    expect(withShellsBeingMade(held, hosts, [])).toBe(held);
    expect(withShellsBeingMade(held, hosts, [{ hostId: "mini", workspaceId: "w1", known: new Set(["w1:p1", "w1:p9", "w1:pn1"]) }])).toBe(held);
    expect(withShellsBeingMade(held, hosts, [{ hostId: "gone", workspaceId: "w1", known: new Set() }])).toBe(held);
  });
});

describe("its height, names and gate", () => {
  it("is the default until dragged, within the column, the pane's view keeping its minimum", () => {
    expect(drawerHeight(null, 900)).toBe(defaultDrawerHeight);
    expect(drawerHeight(500, 900)).toBe(500);
    expect(drawerHeight(800, 900)).toBe(900 - minimumViewHeight);
    expect(drawerHeight(40, 900)).toBe(minimumDrawerHeight);
    expect(drawerHeight(null, 200)).toBe(minimumDrawerHeight);
  });

  // "Terminal", then "Terminal 2", "Terminal 3", by the drawer's order, never Herdr's tab
  // number or the label the shell has in Herdr.
  it("names its tabs Terminal, Terminal 2, Terminal 3 by the drawer's order", () => {
    expect([0, 1, 2, 7].map((index) => drawerShellLabel(index))).toEqual(["Terminal", "Terminal 2", "Terminal 3", "Terminal 8"]);
    expect(drawerShellTabLabel).toBe("Terminal");
  });

  it("takes ⌘J once when the menu and the page both see the same press; two presses are two", () => {
    const gate = new DrawerToggleGate(400);
    expect(gate.take("key", 1_000)).toBe(true);
    expect(gate.take("menu", 1_010)).toBe(false);
    expect(gate.take("key", 1_500)).toBe(true);
    expect(gate.take("key", 1_600)).toBe(true);
    expect(gate.take("menu", 2_500)).toBe(true);
  });
});
