// The terminal drawer's shells
// stay real Herdr tabs, named "Terminal", and live in the drawer only. The
// panes this app's drawers hold (TerminalDrawers.heldShells: every owner, every
// machine) are left out of the sidebar's Projects rows, Priority, the Needs you
// group and badge, the "N agents" footer count, the pane search and the ⇧⌘J
// cycle. A shell no drawer holds (one made in Herdr, or one whose drawer this
// app no longer has) shows as before. Pure: the sidebar model and the drawers'
// store, no window.

import { describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { buildDesktopSidebar, nextNeedsYou, type DesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { emptyFoldState } from "../src/shared/sidebar-model";
import { TerminalDrawers, type DrawerHost } from "../src/shared/terminal-drawer";

const nowUnixMs = 1_800_000_000_000;

interface Fixture {
  readonly id: string;
  readonly tab: string;
  readonly tabLabel: string;
  readonly agent?: string;
  readonly status?: string;
  readonly since?: number;
}

/** One machine's snapshot: workspace w1 (`label`), each pane alone in its tab, numbered in order. */
function machine(id: string, label: string, panes: readonly Fixture[]): SidebarHost & DrawerHost {
  const topology = decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label, focused: true, pane_count: panes.length, tab_count: panes.length, active_tab_id: panes[0]!.tab, agent_status: "idle" }],
    tabs: panes.map((pane, index) => ({ tab_id: pane.tab, workspace_id: "w1", number: index + 1, label: pane.tabLabel, focused: index === 0, pane_count: 1, agent_status: "idle" })),
    panes: panes.map((pane) => ({
      pane_id: pane.id,
      terminal_id: `term-${pane.id}`,
      workspace_id: "w1",
      tab_id: pane.tab,
      focused: false,
      cwd: "/Users/demo/code/app",
      ...(pane.agent === undefined ? {} : { agent: pane.agent }),
      agent_status: pane.status ?? (pane.agent === undefined ? "unknown" : "idle"),
      revision: 1,
    })),
    layouts: [],
    agents: panes
      .filter((pane) => pane.agent !== undefined)
      .map((pane) => ({ pane_id: pane.id, agent: pane.agent, agent_status: pane.status ?? "idle", ...(pane.since === undefined ? {} : { status_since_unix_ms: pane.since }) })),
  });
  return { id, name: id === "mini" ? "Mac mini" : "build-box", platform: "macOS", state: "connected", error: null, topology, fetchedAtMs: nowUnixMs };
}

// Mac mini, Tidepool: the Claude pane (its drawer holds two shells: a plain one, and one Claude was started in that is
// blocked: it needs you), and a shell the user made in Herdr whose tab is also named Terminal.
const mini = machine("mini", "Tidepool", [
  { id: "w1:p1", tab: "w1:t1", tabLabel: "claude", agent: "claude", status: "idle", since: nowUnixMs - 60_000 },
  { id: "w1:pn1", tab: "w1:t2", tabLabel: "Terminal" },
  { id: "w1:pn2", tab: "w1:t3", tabLabel: "Terminal", agent: "claude", status: "blocked", since: nowUnixMs - 30_000 },
  { id: "w1:p9", tab: "w1:t4", tabLabel: "Terminal" },
]);
// build-box, api: a Codex pane (its drawer holds one shell) and a shell numbered by Herdr ("3").
const box = machine("box", "api", [
  { id: "w1:p1", tab: "w1:t1", tabLabel: "codex", agent: "codex", status: "blocked", since: nowUnixMs - 120_000 },
  { id: "w1:pn7", tab: "w1:t2", tabLabel: "Terminal" },
  { id: "w1:p8", tab: "w1:t3", tabLabel: "3" },
]);

function drawersHolding(): TerminalDrawers {
  const drawers = new TerminalDrawers(null);
  drawers.setOpen("mini", "w1:p1", true);
  drawers.addShell("mini", "w1:p1", "w1:pn1", nowUnixMs - 10_000);
  drawers.addShell("mini", "w1:p1", "w1:pn2", nowUnixMs - 5_000);
  drawers.addShell("box", "w1:p1", "w1:pn7", nowUnixMs - 10_000);
  return drawers;
}

const projectRows = (sidebar: DesktopSidebar): string[] =>
  sidebar.hosts.flatMap((section) => section.model?.projects.flatMap((project) => project.rows.map((row) => `${section.host.id}/${row.paneID}`)) ?? []);
const priorityRows = (sidebar: DesktopSidebar): string[] => sidebar.priority.flatMap((section) => section.rows.map((entry) => entry.key));

describe("the sidebar without the drawers' shells", () => {
  it("before: every drawer shell is a row of its workspace, and the one running Claude counts, needs you and is in ⇧⌘J", () => {
    const sidebar = buildDesktopSidebar([mini, box], { nowUnixMs });
    expect(projectRows(sidebar)).toEqual(["mini/w1:p1", "mini/w1:pn1", "mini/w1:pn2", "mini/w1:p9", "box/w1:p1", "box/w1:pn7", "box/w1:p8"]);
    expect(sidebar.needsYou.map((entry) => entry.key)).toEqual(["mini/w1:pn2", "box/w1:p1"]);
    expect(sidebar.agentCount).toBe(3);
  });

  it("leaves them out of Projects, Priority, Needs you, the badge, the footer count and the workspace's count, every owner and machine", () => {
    const drawers = drawersHolding();
    const sidebar = buildDesktopSidebar([mini, box], { nowUnixMs, drawerShells: drawers.heldShells([mini, box]) });
    expect(projectRows(sidebar)).toEqual(["mini/w1:p1", "mini/w1:p9", "box/w1:p1", "box/w1:p8"]);
    // The user's own shells stay, named as before (the one in Herdr's numbered tab still reads "3").
    const rows = sidebar.hosts.flatMap((section) => section.model!.projects.flatMap((project) => project.rows));
    expect(rows.filter((row) => !row.isAgent).map((row) => row.name)).toEqual(["Terminal", "3"]);
    expect(sidebar.hosts.map((section) => section.model!.projects[0]!.header.paneCount)).toEqual([2, 2]);
    expect(sidebar.needsYou.map((entry) => entry.key)).toEqual(["box/w1:p1"]);
    expect(sidebar.badge).toBe(1);
    expect(sidebar.agentCount).toBe(2);
    expect(priorityRows(sidebar)).toEqual(["box/w1:p1", "mini/w1:p1"]);
    // Priority mode lists the same.
    const priority = buildDesktopSidebar([mini, box], { nowUnixMs, fold: { ...emptyFoldState, mode: "priority" }, drawerShells: drawers.heldShells([mini, box]) });
    expect(priorityRows(priority)).toEqual(["box/w1:p1", "mini/w1:p1"]);
  });

  it("leaves them out of the pane search: Terminal finds only the user's own shell", () => {
    const drawers = drawersHolding();
    const before = buildDesktopSidebar([mini, box], { nowUnixMs, search: "terminal" });
    expect(projectRows(before)).toEqual(["mini/w1:pn1", "mini/w1:pn2", "mini/w1:p9", "box/w1:pn7"]);
    const sidebar = buildDesktopSidebar([mini, box], { nowUnixMs, search: "terminal", drawerShells: drawers.heldShells([mini, box]) });
    expect(sidebar.isSearching).toBe(true);
    expect(projectRows(sidebar)).toEqual(["mini/w1:p9"]);
    // A search that matches the workspace: its rows but no drawer shell.
    expect(projectRows(buildDesktopSidebar([mini, box], { nowUnixMs, search: "tidepool", drawerShells: drawers.heldShells([mini, box]) }))).toEqual(["mini/w1:p1", "mini/w1:p9"]);
  });

  it("leaves them out of the ⇧⌘J cycle", () => {
    const drawers = drawersHolding();
    const before = buildDesktopSidebar([mini, box], { nowUnixMs });
    expect(nextNeedsYou(before, "box/w1:p1")?.key).toBe("mini/w1:pn2");
    const sidebar = buildDesktopSidebar([mini, box], { nowUnixMs, drawerShells: drawers.heldShells([mini, box]) });
    expect(nextNeedsYou(sidebar, null)?.key).toBe("box/w1:p1");
    expect(nextNeedsYou(sidebar, "box/w1:p1")?.key).toBe("box/w1:p1");
    expect(nextNeedsYou(sidebar, "mini/w1:p1")?.key).toBe("box/w1:p1");
  });

  it("shows a drawer shell again once its drawer is gone (its owner closed), and a shell no drawer holds as before", () => {
    const drawers = drawersHolding();
    // The Claude pane closes in Herdr: the machine answers without it, its drawer is pruned, its shells are no one's.
    const closed = machine("mini", "Tidepool", [
      { id: "w1:pn1", tab: "w1:t2", tabLabel: "Terminal" },
      { id: "w1:pn2", tab: "w1:t3", tabLabel: "Terminal", agent: "claude", status: "blocked", since: nowUnixMs - 30_000 },
      { id: "w1:p9", tab: "w1:t4", tabLabel: "Terminal" },
    ]);
    expect(drawers.prune([closed, box])).toBe(true);
    const sidebar = buildDesktopSidebar([closed, box], { nowUnixMs, drawerShells: drawers.heldShells([closed, box]) });
    expect(projectRows(sidebar)).toEqual(["mini/w1:pn1", "mini/w1:pn2", "mini/w1:p9", "box/w1:p1", "box/w1:p8"]);
    expect(sidebar.needsYou.map((entry) => entry.key)).toEqual(["mini/w1:pn2", "box/w1:p1"]);
    // No drawers at all: the sidebar as it was.
    const none = buildDesktopSidebar([mini, box], { nowUnixMs, drawerShells: new TerminalDrawers(null).heldShells([mini, box]) });
    expect(projectRows(none)).toEqual(projectRows(buildDesktopSidebar([mini, box], { nowUnixMs })));
  });
});
