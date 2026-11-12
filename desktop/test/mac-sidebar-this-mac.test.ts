// This Mac only when it is useful. While Herdr is not
// running on this Mac and another machine is listed, the sidebar leaves This
// Mac out: no header, no card, nothing in its place, in Projects and in
// Priority, and nothing of it in search, the Needs you group, the counts, ⌘J
// or a selection that pointed into it. It comes back by itself, first, when
// its Herdr answers the next look. Alone (a first run) it stays, with its card
// and hint. A This Mac that is not running never shows a pane count: its last
// snapshot goes when it stops (hosts.ts), so a folded header never counts a
// stale snapshot's panes.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { addThisMac, thisMacId, thisMacText } from "../src/main/this-mac";
import { Sidebar, type SidebarProps } from "../src/renderer/components/Sidebar";
import { buildDesktopSidebar, nextNeedsYou, type DesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { emptyFoldState, fold } from "../src/shared/sidebar-model";
import { ago, nowUnixMs } from "./support/sidebar-fixture";
import { closeFakeMacs, makeFakeMac } from "./support/this-mac-fake";

interface PaneSpec {
  readonly id: string;
  readonly status: string;
  readonly agent: string | null;
  readonly label?: string;
}

/** One workspace, one tab, these panes (an agent's status since `ago(n)` minutes). */
function topology(label: string, panes: readonly PaneSpec[]): SessionTopology {
  const pane = (spec: PaneSpec) => ({
    pane_id: spec.id,
    terminal_id: `term-${spec.id}`,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    cwd: `/srv/${label}`,
    ...(spec.label === undefined ? {} : { label: spec.label }),
    ...(spec.agent === null ? {} : { agent: spec.agent }),
    agent_status: spec.status,
    revision: 1,
  });
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label, focused: true, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: panes.length, agent_status: "working" }],
    panes: panes.map(pane),
    layouts: [],
    agents: panes
      .filter((spec) => spec.agent !== null)
      .map((spec, index) => ({ pane_id: spec.id, agent: spec.agent, agent_status: spec.status, status_since_unix_ms: ago(index + 1) })),
  });
}

const miniTopology = topology("api", [
  { id: "w1:p1", status: "blocked", agent: "claude", label: "api-review" },
  { id: "w1:p2", status: "working", agent: "codex", label: "api-build" },
]);
const macTopology = topology("aurora-web", [
  { id: "w1:p1", status: "blocked", agent: "claude", label: "this-mac-agent" },
  { id: "w1:p2", status: "working", agent: "claude", label: "this-mac-worker" },
  { id: "w1:p3", status: "unknown", agent: null },
]);

const mini: SidebarHost & { kind: string } = { id: "mini", name: "Mac mini", kind: "ssh", platform: "macOS", state: "connected", error: null, topology: miniTopology };
const notRunning = { text: thisMacText.notRunning, hint: thisMacText.startHint };
const macRunning: SidebarHost & { kind: string } = { id: thisMacId, name: "This Mac", kind: "local", platform: "macOS", state: "connected", error: null, topology: macTopology };
const macNotRunning: SidebarHost & { kind: string } = { ...macRunning, state: "offline", topology: null, notRunning };
/** Not running with its last snapshot still on it (a registry that kept it after the stop). */
const macStale: SidebarHost & { kind: string } = { ...macRunning, state: "offline", notRunning };
const macConnecting: SidebarHost & { kind: string } = { ...macRunning, state: "connecting", topology: null };

const none = (): void => undefined;
function markup(sidebar: DesktopSidebar, extra: Partial<SidebarProps> = {}): string {
  const props: SidebarProps = {
    sidebar,
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

const ids = (sidebar: DesktopSidebar): string[] => sidebar.hosts.map((section) => section.host.id);
const priority = { ...emptyFoldState, mode: "priority" as const };

const registries: HostRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) registry.close();
  await closeFakeMacs();
});

/** A saved machine that answers with the Mac mini's snapshot. */
function answering(snapshot: SessionTopology): HerdrHostBackend {
  return {
    kind: "demo",
    snapshot: async () => snapshot,
    sendInput: async () => undefined,
    prompt: async () => undefined,
    sendText: async () => undefined,
    agentKeys: async () => undefined,
    transcripts: () => null,
    openTerminal: () => Promise.reject(new Error("none")),
    close: () => undefined,
  };
}

describe("This Mac beside another machine", () => {
  it("is left out while Herdr is not running there: no header, no card, nothing in its place, in Projects and Priority", () => {
    const sidebar = buildDesktopSidebar([macNotRunning, mini], { nowUnixMs });
    expect(ids(sidebar)).toEqual(["mini"]);
    for (const html of [markup(sidebar), markup(buildDesktopSidebar([macNotRunning, mini], { nowUnixMs, fold: priority }))]) {
      expect(html).not.toContain(`data-host="${thisMacId}"`);
      expect(html).not.toContain("This Mac");
      expect(html).not.toContain(thisMacText.notRunning);
      expect(html).not.toContain("host-note");
      expect(html).not.toContain("Not running");
    }
    // Nothing takes its place: the list is the one a sidebar without This Mac draws.
    expect(markup(sidebar)).toBe(markup(buildDesktopSidebar([mini], { nowUnixMs })));
  });

  it("is not there for search, Priority, the Needs you group, the counts, ⌘J or a selection that pointed into it", () => {
    // Even with a snapshot still on it (the registry no longer keeps one; this holds whatever the source).
    for (const options of [
      { nowUnixMs },
      { nowUnixMs, fold: priority },
      { nowUnixMs, search: "this-mac" },
      { nowUnixMs, search: "api" },
      { nowUnixMs, fold: fold.toggleSection(emptyFoldState, "needsYou") },
    ]) {
      expect(buildDesktopSidebar([macStale, mini], options)).toEqual(buildDesktopSidebar([mini], options));
    }
    const sidebar = buildDesktopSidebar([macStale, mini], { nowUnixMs });
    expect(sidebar.needsYou.map((row) => row.key)).toEqual(["mini/w1:p1"]);
    expect(sidebar.agentCount).toBe(2);
    expect(sidebar.badge).toBe(1);
    // ⌘J from a pane of This Mac goes to the first that needs you, as from nothing selected.
    expect(nextNeedsYou(sidebar, `${thisMacId}/w1:p1`)?.key).toBe("mini/w1:p1");
    // The selection that pointed into it draws no selected row.
    expect(markup(sidebar, { selectedKey: `${thisMacId}/w1:p1` })).not.toMatch(/class="row[^"]* sel/);
  });

  it("is not drawn while its first look is out (no flash at launch), and stays listed for an error that is not 'not running'", () => {
    expect(ids(buildDesktopSidebar([macConnecting, mini], { nowUnixMs }))).toEqual(["mini"]);
    const failing = { ...macRunning, state: "offline" as const, topology: null, error: "Herdr did not answer in 10 s." };
    expect(ids(buildDesktopSidebar([failing, mini], { nowUnixMs }))).toEqual([thisMacId, "mini"]);
  });

  it("is first, with its panes, while its Herdr answers", () => {
    const sidebar = buildDesktopSidebar([macRunning, mini], { nowUnixMs });
    expect(ids(sidebar)).toEqual([thisMacId, "mini"]);
    expect(markup(sidebar)).toContain("this-mac-worker");
  });
});

describe("This Mac alone (a first run)", () => {
  it("is listed with its card and hint, and only then", () => {
    const alone = buildDesktopSidebar([macNotRunning], { nowUnixMs });
    expect(ids(alone)).toEqual([thisMacId]);
    for (const html of [markup(alone), markup(buildDesktopSidebar([macNotRunning], { nowUnixMs, fold: priority }))]) {
      expect(html).toContain('<div class="host-note"><span class="nt">Herdr is not running on this Mac</span>');
      expect(html).toContain(`<span class="hint">${thisMacText.startHint}</span>`);
      expect(html).toContain('<span class="hs">Not running</span>');
    }
    expect(ids(buildDesktopSidebar([macConnecting], { nowUnixMs }))).toEqual([thisMacId]);
    // One saved machine is enough to leave it out.
    expect(ids(buildDesktopSidebar([macNotRunning, mini], { nowUnixMs }))).toEqual(["mini"]);
  });
});

describe("no pane count while not running", () => {
  it("never on a folded This Mac that is not running", () => {
    const html = markup(buildDesktopSidebar([macStale], { nowUnixMs }), { foldedHosts: new Set([thisMacId]) });
    expect(html).toContain("Not running");
    expect(html).not.toMatch(/\d+ panes?/);
  });
});

describe.skipIf(process.platform !== "darwin")("This Mac on the registry (the fake This Mac in the scratch folder)", () => {
  it("keeps no panes once its Herdr stops: the last snapshot goes, so a folded header counts nothing", async () => {
    const fake = makeFakeMac();
    await fake.serve();
    const registry = new HostRegistry(() => undefined);
    registries.push(registry);
    addThisMac(registry, fake.options());
    await registry.refreshAll();
    expect(registry.list()[0]).toMatchObject({ id: thisMacId, state: "connected" });
    expect(registry.list()[0]?.topology?.panes.length).toBeGreaterThan(0);

    await fake.close();
    await registry.refreshAll();
    const stopped = registry.list()[0]!;
    expect(stopped).toMatchObject({ id: thisMacId, state: "offline", error: null, notRunning: { text: thisMacText.notRunning } });
    expect(stopped.topology).toBeNull();
    expect(registry.topology(thisMacId)).toBeNull();
    const html = markup(buildDesktopSidebar(registry.list(), { nowUnixMs }), { foldedHosts: new Set([thisMacId]) });
    expect(html).toContain("Not running");
    expect(html).not.toMatch(/\d+ panes?/);
  });

  it("comes back by itself, first, when Herdr starts, and goes again when it stops", async () => {
    const fake = makeFakeMac();
    const registry = new HostRegistry(() => undefined);
    registries.push(registry);
    addThisMac(registry, fake.options());
    registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "me@mini:22", platform: "macOS" }, answering(miniTopology));
    await registry.refreshAll();
    expect(registry.list().map((host) => host.id)).toEqual([thisMacId, "mini"]);
    expect(ids(buildDesktopSidebar(registry.list(), { nowUnixMs }))).toEqual(["mini"]);

    // Herdr starts: the same backend's next look (the registry's every few seconds) finds it.
    await fake.serve();
    await registry.refreshAll();
    const back = buildDesktopSidebar(registry.list(), { nowUnixMs });
    expect(ids(back)).toEqual([thisMacId, "mini"]);
    expect(back.hosts[0]?.model?.projects.length).toBeGreaterThan(0);

    await fake.close();
    await registry.refreshAll();
    expect(ids(buildDesktopSidebar(registry.list(), { nowUnixMs }))).toEqual(["mini"]);
  });
});
