// The desktop sidebar across machines: the Needs you group comes first and
// spans every machine, newest first; Priority merges machines the same way;
// rows are keyed per machine; a machine without a snapshot yet adds nothing.

import { describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { buildDesktopSidebar, nextNeedsYou, rowKey, type SidebarHost } from "../src/shared/desktop-sidebar";
import { emptyFoldState, fold } from "../src/shared/sidebar-model";
import { ago, nowUnixMs, topology } from "./support/sidebar-fixture";

// Mac mini: The user's 0.9.5 server; w2:p70 shows a menu (needs you, 3 minutes),
// w5:p1 is blocked (10 minutes), w3:p1 blocked with no time.
const macMini: SidebarHost = {
  id: "mac-mini",
  name: "Mac mini",
  platform: "macOS",
  state: "connected",
  error: null,
  topology: topology(
    "[" +
      `{"pane_id":"w2:p70","agent":"claude","agent_status":"idle","input_pending":true,"status_since_unix_ms":${ago(3)}},` +
      `{"pane_id":"w5:p1","agent":"claude","agent_status":"blocked","status_since_unix_ms":${ago(10)}},` +
      '{"pane_id":"w3:p1","agent":"claude","agent_status":"blocked"}' +
      "]",
  ),
};

function pane(id: string, status: string, agent: string | null): string {
  return JSON.stringify({
    pane_id: id,
    terminal_id: `term-${id}`,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    cwd: "/srv/app",
    ...(agent === null ? {} : { agent }),
    agent_status: status,
    revision: 1,
  });
}

// A Linux box: one agent blocked a minute ago, one working, a shell.
const linuxBox: SidebarHost = {
  id: "linux-box",
  name: "build-box",
  platform: "Linux",
  state: "connected",
  error: null,
  topology: decodeSessionTopology(
    JSON.parse(
      '{"version":"0.9.5","protocol":22,' +
        '"workspaces":[{"workspace_id":"w1","number":1,"label":"api","focused":true,"pane_count":3,"tab_count":1,"active_tab_id":"w1:t1","agent_status":"blocked"}],' +
        '"tabs":[{"tab_id":"w1:t1","workspace_id":"w1","number":1,"label":"main","focused":true,"pane_count":3,"agent_status":"blocked"}],' +
        `"panes":[${pane("w1:p1", "blocked", "codex")},${pane("w1:p2", "working", "claude")},${pane("w1:p3", "unknown", null)}],` +
        `"layouts":[],"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"blocked","status_since_unix_ms":${ago(1)}},` +
        `{"pane_id":"w1:p2","agent":"claude","agent_status":"working","status_since_unix_ms":${ago(20)}}]}`,
    ),
  ),
};

const connecting: SidebarHost = {
  id: "studio",
  name: "Studio",
  platform: null,
  state: "connecting",
  error: null,
  topology: null,
};

describe("the Needs you group", () => {
  it("comes first, across machines, newest first, then rows without a time", () => {
    const sidebar = buildDesktopSidebar([macMini, linuxBox, connecting], { nowUnixMs });
    expect(sidebar.needsYou.map((r) => r.key)).toEqual([
      "linux-box/w1:p1",
      "mac-mini/w2:p70",
      "mac-mini/w5:p1",
      "mac-mini/w3:p1",
    ]);
    expect(sidebar.needsYou.map((r) => r.hostName)).toEqual(["build-box", "Mac mini", "Mac mini", "Mac mini"]);
    expect(sidebar.needsYou[0]?.row.time).toBe("1m");
    expect(sidebar.badge).toBe(4);
  });

  it("keeps the rows in their machine's tree too", () => {
    const sidebar = buildDesktopSidebar([macMini, linuxBox], { nowUnixMs });
    const mini = sidebar.hosts[0]!.model!;
    const quartz = mini.projects.find((s) => s.header.label === "Quartz")!;
    expect(quartz.header.needsYou).toBe(true);
    expect(quartz.rows.map((r) => r.paneID)).toContain("w2:p70");
  });

  it("is the first Priority section, merged across machines in the same order", () => {
    const sidebar = buildDesktopSidebar([macMini, linuxBox], {
      nowUnixMs,
      fold: { ...emptyFoldState, mode: "priority" },
    });
    expect(sidebar.mode).toBe("priority");
    expect(sidebar.priority[0]?.kind).toBe("needsYou");
    expect(sidebar.priority[0]?.rows.map((r) => r.key)).toEqual(sidebar.needsYou.map((r) => r.key));
    const working = sidebar.priority.find((s) => s.kind === "working")!;
    // build-box's agent has a time (20m); the Mac mini's two working rows have none.
    expect(working.rows.map((r) => r.key)).toEqual(["linux-box/w1:p2", "mac-mini/w7:p1", "mac-mini/w7:p1G"]);
  });

  it("does not depend on machine order for timed rows", () => {
    const one = buildDesktopSidebar([macMini, linuxBox], { nowUnixMs }).needsYou.map((r) => r.key);
    const other = buildDesktopSidebar([linuxBox, macMini], { nowUnixMs }).needsYou.map((r) => r.key);
    expect(other).toEqual(one);
  });

  it("narrows with search; the badge does not", () => {
    const sidebar = buildDesktopSidebar([macMini, linuxBox], { nowUnixMs, search: "codex" });
    expect(sidebar.needsYou.map((r) => r.key)).toEqual(["linux-box/w1:p1"]);
    expect(sidebar.badge).toBe(4);
  });

  it("folds", () => {
    const sidebar = buildDesktopSidebar([macMini, linuxBox], { nowUnixMs, fold: fold.toggleSection(emptyFoldState, "needsYou") });
    expect(sidebar.needsYouFolded).toBe(true);
  });
});

describe("machines", () => {
  it("each keep their own tree, counts and folds", () => {
    const folded = fold.toggleWorkspace(emptyFoldState, "w1", "linux-box");
    const sidebar = buildDesktopSidebar([macMini, linuxBox, connecting], { nowUnixMs, fold: folded });
    expect(sidebar.hosts.map((h) => h.host.id)).toEqual(["mac-mini", "linux-box", "studio"]);
    expect(sidebar.hosts[2]?.model).toBeNull();
    expect(sidebar.hosts[1]?.model?.projects[0]?.header.isFolded).toBe(true);
    // The Mac mini's w1? It has none; its folds are its own.
    expect(sidebar.hosts[0]?.model?.projects.every((s) => !s.header.isFolded)).toBe(true);
    expect(sidebar.agentCount).toBe(18 + 2);
  });

  it("key rows by machine, since pane ids repeat", () => {
    expect(rowKey("mac-mini", "w1:p1")).not.toBe(rowKey("linux-box", "w1:p1"));
  });

  it("jump to the next row needing you, wrapping", () => {
    const sidebar = buildDesktopSidebar([macMini, linuxBox], { nowUnixMs });
    expect(nextNeedsYou(sidebar, null)?.key).toBe("linux-box/w1:p1");
    expect(nextNeedsYou(sidebar, "linux-box/w1:p1")?.key).toBe("mac-mini/w2:p70");
    expect(nextNeedsYou(sidebar, "mac-mini/w3:p1")?.key).toBe("linux-box/w1:p1");
    expect(nextNeedsYou(sidebar, "not-listed")?.key).toBe("linux-box/w1:p1");
  });
});
