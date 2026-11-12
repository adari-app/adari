// The sidebar at T3 Code's density and hierarchy. The
// project (a workspace) heads its agents, which sit a step in under it; the
// selected row is a card; the time stays on the right; the agent's kind is a
// small glyph (named in its tooltip) in place of the word; the counts stay.
// The real Sidebar rendered to static markup, and the style sheet's contract.

import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { Sidebar, type SidebarProps } from "../src/renderer/components/Sidebar";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { ago, nowUnixMs } from "./support/sidebar-fixture";

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

// One machine, one project: a Codex agent blocked a minute ago (needs you), a
// Claude agent working for 20 minutes, a shell.
const box: SidebarHost = {
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

function markup(selectedKey: string | null = null): string {
  const none = (): void => undefined;
  const props: SidebarProps = {
    sidebar: buildDesktopSidebar([box], { nowUnixMs }),
    selectedKey,
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
  };
  return renderToStaticMarkup(createElement(Sidebar, props));
}

interface RenderedRow {
  readonly className: string;
  readonly key: string;
  readonly inner: string;
}

/** Every pane row (a button with data-row; rows hold no buttons of their own). */
function rows(html: string): RenderedRow[] {
  return [...html.matchAll(/<button class="(row[^"]*)" data-row="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({
    className: m[1]!,
    key: m[2]!,
    inner: m[3]!,
  }));
}

/** The rows of the machine's tree (the Needs you group repeats some first). */
function treeRows(html: string): RenderedRow[] {
  return rows(html.slice(html.indexOf('data-host="linux-box"')));
}

const sheet = ["tokens.css", "app.css"].map((name) => readFileSync(new URL(`../src/renderer/styles/${name}`, import.meta.url), "utf8")).join("\n");

/** The declarations of every rule whose selector list holds `selector` exactly. */
function body(selector: string): string {
  return [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector))
    .map((match) => match[2]!)
    .join(";");
}

describe("the agent's kind", () => {
  it("is a small glyph named in its tooltip, not the word", () => {
    const tree = treeRows(markup());
    const codex = tree.find((r) => r.key === "linux-box/w1:p1")!;
    const claude = tree.find((r) => r.key === "linux-box/w1:p2")!;
    expect(codex.inner).toMatch(/<span class="kd" title="Codex"><svg class="ag-g ag-codex"/);
    expect(claude.inner).toMatch(/<span class="kd" title="Claude Code"><svg class="ag-g ag-claude"/);
    expect(codex.inner).not.toMatch(/>codex</);
    expect(claude.inner).not.toMatch(/>claude</);
  });

  it("shows nothing for a shell (its status glyph already says shell)", () => {
    const shell = treeRows(markup()).find((r) => r.key === "linux-box/w1:p3")!;
    expect(shell.inner).not.toMatch(/class="kd"/);
  });

  it("shows in the Needs you group too", () => {
    const html = markup();
    const group = rows(html.slice(0, html.indexOf('data-host="linux-box"')));
    expect(group.map((r) => r.key)).toEqual(["linux-box/w1:p1"]);
    expect(group[0]!.inner).toMatch(/<svg class="ag-g ag-codex"/);
  });

  it("is a quiet 12 px glyph in the row's faint ink", () => {
    expect(body(".row .kd")).toMatch(/display:\s*flex/);
    expect(body(".row .kd")).toMatch(/color:\s*var\(--ink-4\)/);
    expect(body(".row .kd")).not.toMatch(/font-family/);
    expect(body(".row.sel .kd")).toMatch(/color:\s*var\(--ink-3\)/);
  });
});

describe("the time", () => {
  it("is the row's last item, pushed to the right edge, in tabular digits", () => {
    const timed = treeRows(markup()).filter((r) => r.inner.includes('class="tm"'));
    expect(timed.length).toBe(2);
    for (const row of timed) expect(row.inner).toMatch(/<span class="tm">[^<]+<\/span>$/);
    expect(body(".row .tm")).toMatch(/margin-left:\s*auto/);
    expect(body(".row .tm")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});

describe("the selected row", () => {
  it("is a card: a raised fill, a hairline, a soft shadow, radius 8", () => {
    const html = markup("linux-box/w1:p2");
    expect(treeRows(html).find((r) => r.key === "linux-box/w1:p2")!.className.split(" ")).toContain("sel");
    const card = body(".row.sel");
    expect(card).toMatch(/background:\s*var\(--sel-card\)/);
    expect(card).toMatch(/border-radius:\s*8px/);
    expect(card).toMatch(/box-shadow:[^;]*inset[^;]*/);
    expect(body(":root")).toMatch(/--sel-card:\s*rgba\(255,\s*255,\s*255,\s*0\.0[6-9]\)/);
  });
});

describe("project then agents", () => {
  it("keeps the project's pane count and the Needs you count", () => {
    const html = markup();
    expect(html).toMatch(/<span class="n">api<\/span><span class="sp"><\/span><i class="ny"><\/i><span class="c">3<\/span>/);
    expect(html).toMatch(/<span>Needs you<\/span><span class="c">1<\/span>/);
  });

  it("heads its agents: the project in medium weight at 90% ink, its rows a step in, 8 px between projects", () => {
    expect(body(".ws-h")).toMatch(/font-weight:\s*500/);
    expect(body(".ws-h")).toMatch(/color:\s*var\(--ink-head\)/);
    expect(body(":root")).toMatch(/--ink-head:\s*rgba\(237,\s*237,\s*235,\s*0\.9\)/);
    expect(body(".ws .row")).toMatch(/padding-left:\s*18px/);
    expect(body(".ws + .ws")).toMatch(/margin-top:\s*8px/);
    expect(body(".ws-h .c")).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it("lets rows that do not need you recede: normal weight, and medium only for one that needs you", () => {
    expect(body(".row .nm")).toMatch(/font-weight:\s*400/);
    expect(body(".row.ny .nm")).toMatch(/font-weight:\s*500/);
  });
});
