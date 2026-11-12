// Names first. A machine's name keeps its full text
// before its platform, status and pane count: the badges sit in a box that
// takes only what the name leaves and gives way first (the platform goes
// whole, then the status is cut). On a row the agent's or pane's name keeps
// the row before its second text (its activity, or where it lives), with no
// fixed cap; the second text keeps the few characters the row kept it before.
// Every row, header and project shows its full text in its tooltip. The older
// rule stays: a row that needs you keeps its pill, glyphs and time whole. The
// layout itself is measured in the captures (101-105).

import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { Sidebar, type SidebarProps } from "../src/renderer/components/Sidebar";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { emptyFoldState } from "../src/shared/sidebar-model";
import { ago, nowUnixMs } from "./support/sidebar-fixture";

const longName = "aurora-web-sidebar-redesign-mac · claude-xhigh";
const longTitle = "Tidepool narration weekly status review";
const longProject = "Session logs and CLAUDE.md cleanup";

const host: SidebarHost = {
  id: "mini",
  name: "Mac mini",
  platform: "macOS",
  state: "offline",
  error: null,
  topology: decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: longProject, focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "blocked" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 2, agent_status: "blocked" }],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/notes", label: longName, terminal_title_stripped: longTitle, agent: "claude", agent_status: "working", revision: 1 },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/srv/notes", label: "quartz-api-batch-scripts · codex-xhigh", agent: "codex", agent_status: "blocked", revision: 1 },
    ],
    layouts: [],
    agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "working", status_since_unix_ms: ago(5) },
      { pane_id: "w1:p2", agent: "codex", agent_status: "blocked", status_since_unix_ms: ago(1) },
    ],
  }),
};

const none = (): void => undefined;
function markup(extra: Partial<SidebarProps> = {}, sidebarHost: SidebarHost = host, mode: "projects" | "priority" = "projects"): string {
  const props: SidebarProps = {
    sidebar: buildDesktopSidebar([sidebarHost], { nowUnixMs, fold: { ...emptyFoldState, mode } }),
    selectedKey: null,
    search: null,
    demo: false,
    foldedHosts: new Set(),
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
    ...extra,
  };
  return renderToStaticMarkup(createElement(Sidebar, props));
}

const decode = (text: string): string => text.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">");

/** Each row button's data-row and title, in order (the Needs you group's first, then the tree's). */
function rowTitles(html: string): { key: string; title: string | null }[] {
  return [...html.matchAll(/<button class="row[^"]*" data-row="([^"]+)"([^>]*)>/g)].map((m) => ({
    key: m[1]!,
    title: m[2]!.match(/ title="([^"]*)"/)?.[1] === undefined ? null : decode(m[2]!.match(/ title="([^"]*)"/)![1]!),
  }));
}

const sheet = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
/** The declarations of the rule whose whole selector is `selector`. */
function rule(selector: string): string {
  const bodies = [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.trim() === selector).map((m) => m[2]!);
  return bodies.join(";");
}

describe("a row's full text on hover", () => {
  it("is in the row's tooltip: its name, its second text, then its folder", () => {
    const rows = rowTitles(markup());
    const tree = rows.filter((row) => row.key === "mini/w1:p1");
    expect(tree.length).toBe(1);
    expect(tree[0]!.title).toBe(`${longName} · ${longTitle}\n/srv/notes`);
    // In the Needs you group (and Priority) the second text is where it lives.
    const needing = rows.filter((row) => row.key === "mini/w1:p2");
    expect(needing.length).toBe(2);
    expect(needing[0]!.title).toBe(`quartz-api-batch-scripts · codex-xhigh · ${longProject} · Mac mini\n/srv/notes`);
    for (const row of rowTitles(markup({}, host, "priority"))) expect(row.title).toContain(" · Mac mini\n/srv/notes");
  });

  it("is in a project header's and a machine header's tooltip", () => {
    const html = decode(markup({ foldedHosts: new Set() }));
    expect(html).toMatch(new RegExp(`<button class="ws-h" title="${longProject}">`));
    const folded = decode(markup({ foldedHosts: new Set(["mini"]) }));
    expect(folded).toContain('<button class="host-h" title="Mac mini · macOS · Offline · last known · 2 panes">');
    const priority = decode(markup({}, host, "priority"));
    expect(priority).toContain('<div class="host-h" title="Mac mini · macOS · Offline · last known">');
  });
});

describe("a machine's name before its badges", () => {
  it("puts the name first and every badge in a box after it", () => {
    const html = markup({ foldedHosts: new Set(["mini"]) });
    expect(html).toMatch(
      /<span class="hn">Mac mini<\/span><span class="hb"><span class="hg"><span class="hs off">Offline · last known<\/span><i class="ny"><\/i><span class="pc">2 panes<\/span><\/span><span class="pf">macOS<\/span><\/span><span class="chev">/,
    );
    // A connected, open machine: its needs-you dot, then its platform; with nothing else to show, only its platform.
    expect(markup({}, { ...host, state: "connected" })).toMatch(/<span class="hn">Mac mini<\/span><span class="hb"><span class="hg"><i class="ny"><\/i><\/span><span class="pf">macOS<\/span><\/span>/);
    expect(markup({}, { ...host, state: "connected", topology: null })).toMatch(/<span class="hn">Mac mini<\/span><span class="hb"><span class="pf">macOS<\/span><\/span>/);
  });

  it("lets the badges give way first: the box takes only what the name leaves, the platform goes whole, the status is cut", () => {
    const name = rule(".host-h .hn");
    expect(name).toMatch(/flex: 0 1 auto/);
    expect(name).toMatch(/min-width: 0/);
    expect(name).toMatch(/text-overflow: ellipsis/);
    const box = rule(".host-h .hb");
    expect(box).toMatch(/flex: 1 1 0/);
    expect(box).toMatch(/min-width: 0/);
    expect(box).toMatch(/flex-flow: row-reverse wrap/);
    expect(box).toMatch(/overflow: hidden/);
    expect(rule(".host-h .hb > *")).toMatch(/height: 32px/);
    expect(rule(".host-h")).toMatch(/height: 32px/);
    const status = rule(".host-h .hs");
    expect(status).toMatch(/min-width: 0/);
    expect(status).toMatch(/text-overflow: ellipsis/);
    expect(rule(".host-h .hg")).toMatch(/min-width: 0/);
  });
});

describe("a row's name before its second text", () => {
  it("has no fixed cap and gives way only when the row runs out; the second text keeps its 4ch", () => {
    const nameRule = rule(".row .nm");
    expect(nameRule).toMatch(/flex: 0 1 auto/);
    expect(nameRule).toMatch(/min-width: 0/);
    expect(nameRule).not.toMatch(/max-width/);
    expect(rule(".row .act")).toMatch(/flex: 1 1 0/);
    expect(rule(".row .act")).toMatch(/min-width: 4ch/);
    // Rows that show where they live: the name no longer stops at 45%, the place takes what is left.
    expect(rule(".row.placed .nm")).not.toMatch(/max-width/);
    expect(rule(".row.placed .nm")).toMatch(/flex: 0 1 auto/);
    expect(rule(".row .ws2")).toMatch(/flex: 1 1 0/);
    expect(rule(".row .ws2")).toMatch(/min-width: 4ch/);
    expect(sheet).not.toMatch(/max-width: 150px/);
    expect(sheet).not.toMatch(/max-width: 45%/);
  });

  it("keeps the needs-you rule: a row that needs you keeps its pill, glyphs and time whole; its title goes before a letter shows", () => {
    for (const selector of [".row .pill", ".row .tm", ".row .st", ".row .kd"]) expect(rule(selector), selector).toMatch(/flex: none/);
    expect(sheet).toMatch(/\.row\.ny \.act, \.row\.ny \.ws2 \{[^}]*flex: 1 1 0;[^}]*min-width: 0;[^}]*container-type: inline-size/);
    expect(sheet).toMatch(/@container \(max-width: 4ch\) \{ \.row\.ny \.fit \{ display: none; \} \}/);
  });
});
