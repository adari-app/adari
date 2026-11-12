// The sidebar row's "Update ready" mark, the real
// Sidebar rendered to static markup (the real React; update-mark.test.ts runs
// the header on the hooks host): an icon with the tooltip "Claude Code update
// installed. /exit when it's idle, then Resume." on the marked pane's row only.

import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { updateMarkWords } from "../src/renderer/components/UpdateMark";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { nowUnixMs } from "./support/sidebar-fixture";

function pane(id: string, agent: string | null): Record<string, unknown> {
  return { pane_id: id, terminal_id: `term-${id}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, ...(agent === null ? {} : { agent }), agent_status: "idle", revision: 1 };
}

const host: SidebarHost = {
  id: "mini",
  name: "Mac mini",
  platform: "macOS",
  state: "connected",
  error: null,
  topology: decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: 3, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 3, agent_status: "idle" }],
    panes: [pane("w1:p1", "claude"), pane("w1:p2", "claude"), pane("w1:p3", null)],
    layouts: [],
    agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "idle" },
      { pane_id: "w1:p2", agent: "claude", agent_status: "idle" },
    ],
  }),
  // A shell's id in the list too (it never reads as marked: only an agent's row is).
  updateReady: ["w1:p1", "w1:p3"],
};

function markup(hosts: readonly SidebarHost[]): string {
  const none = (): void => undefined;
  return renderToStaticMarkup(
    createElement(Sidebar, {
      sidebar: buildDesktopSidebar(hosts, { nowUnixMs }),
      selectedKey: null,
      search: null,
      demo: false,
      foldedHosts: new Set<string>(),
      onSelect: none,
      onRowMenu: none,
      onToggleHost: none,
      onHostMenu: none,
      onRetryHost: none,
      onMode: none,
      onToggleWorkspace: none,
      onToggleExpanded: none,
      onToggleSection: none,
      onSearch: none,
      onAddHost: none,
      onNewAgent: none,
      onWorkspaceMenu: none,
    }),
  );
}

describe("the sidebar row's Update ready mark", () => {
  it("is on the marked agent's row only, an icon with the tooltip and a VoiceOver label", () => {
    const rows = buildDesktopSidebar([host], { nowUnixMs }).hosts[0]!.model!.projects.flatMap((section) => section.rows);
    expect(rows.map((row) => [row.paneID, row.updateReady === true])).toEqual([
      ["w1:p1", true],
      ["w1:p2", false],
      ["w1:p3", false],
    ]);
    const html = markup([host]);
    const marks = [...html.matchAll(/<span class="upd"[^>]*>/g)].map((match) => match[0]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toContain(`title="${updateMarkWords}"`);
    expect(marks[0]).toContain('aria-label="Update ready"');
    expect(updateMarkWords).toBe("Claude Code update installed. /exit when it’s idle, then Resume.");
    const row = html.split('data-row="mini/w1:p1"')[1]!.split("</button>")[0]!;
    expect(row).toContain('class="upd"');
    // Beside the name, before the agent's kind.
    expect(row.indexOf('class="nm"')).toBeLessThan(row.indexOf('class="upd"'));
    expect(row.indexOf('class="upd"')).toBeLessThan(row.indexOf('class="kd"'));
  });

  it("is gone with no marks (a machine without updateReady)", () => {
    const { updateReady: _ignored, ...plain } = host;
    expect(markup([plain])).not.toContain('class="upd"');
  });

  it("the style sheet keeps it small, beside the name, in the accent ink", () => {
    const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.row \.upd \{[^}]*flex: none;[^}]*\}/);
    expect(css).toMatch(/\.row \.upd \{[^}]*color: var\(--accent-text\)/);
    expect(css).toMatch(/\.mh \.upd-card \{[^}]*position: absolute;/);
  });
});
