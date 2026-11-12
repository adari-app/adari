// The machine controls (sign-in and machine menu) under the new sidebar look.
// The host header still opens the Edit machine / Remove menu
// on a right click, Try again still shows beside a refused sign-in, and the
// machine's tree under them has the new look (the agent's glyph, rows a step
// in), all in one rendered sidebar.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import { HookHost, elements } from "./support/fake-hooks";
import { ago, nowUnixMs } from "./support/sidebar-fixture";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Sidebar } = await import("../src/renderer/components/Sidebar");

type El = { type: unknown; props: Record<string, unknown> };

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

const topology = decodeSessionTopology(
  JSON.parse(
    '{"version":"0.9.5","protocol":22,' +
      '"workspaces":[{"workspace_id":"w1","number":1,"label":"api","focused":true,"pane_count":2,"tab_count":1,"active_tab_id":"w1:t1","agent_status":"working"}],' +
      '"tabs":[{"tab_id":"w1:t1","workspace_id":"w1","number":1,"label":"main","focused":true,"pane_count":2,"agent_status":"working"}],' +
      `"panes":[${pane("w1:p1", "working", "claude")},${pane("w1:p2", "unknown", null)}],` +
      `"layouts":[],"agents":[{"pane_id":"w1:p1","agent":"claude","agent_status":"working","status_since_unix_ms":${ago(3)}}]}`,
  ),
);

/** A machine whose last snapshot is kept while its sign-in was refused. */
const host: HostView = {
  id: "mini",
  name: "Mac mini",
  kind: "ssh",
  address: "robin@mini.invalid:22",
  platform: "macOS",
  state: "offline",
  error: "The Mac refused the password. Check it in Edit machine.",
  topology,
  fetchedAtMs: nowUnixMs,
  authRefused: true,
};

function render(shown: HostView = host) {
  const menus: [string, number, number][] = [];
  const retried: string[] = [];
  const newAgents: unknown[] = [];
  const wsMenus: [string, string, number, number][] = [];
  const none = (): undefined => undefined;
  const ui = new HookHost(Sidebar, {
    sidebar: buildDesktopSidebar([shown], { nowUnixMs }),
    selectedKey: null,
    search: null,
    demo: false,
    foldedHosts: new Set<string>(),
    onSelect: none,
    onRowMenu: none,
    onToggleHost: none,
    onHostMenu: (id: string, x: number, y: number) => menus.push([id, x, y]),
    onRetryHost: (id: string) => retried.push(id),
    onMode: none,
    onToggleWorkspace: none,
    onToggleExpanded: none,
    onToggleSection: none,
    onSearch: none,
    onAddHost: none,
    onNewAgent: (place: unknown) => newAgents.push(place),
    onWorkspaceMenu: (h: string, w: string, x: number, y: number) => wsMenus.push([h, w, x, y]),
  });
  ui.render();
  return { all: elements(ui.tree) as El[], menus, retried, newAgents, wsMenus };
}

describe("the machine's controls under the new sidebar look", () => {
  it("a right click on the host header asks for the machine menu (Edit machine, Remove)", () => {
    const { all, menus } = render();
    const header = all.find((e) => e.type === "button" && e.props["className"] === "host-h");
    expect(header).toBeDefined();
    let prevented = false;
    (header!.props["onContextMenu"] as (event: unknown) => void)({
      preventDefault: () => {
        prevented = true;
      },
      clientX: 40,
      clientY: 120,
    });
    expect(prevented).toBe(true);
    expect(menus).toEqual([["mini", 40, 120]]);
  });

  it("Try again stays beside the refused sign-in, above the machine's tree", () => {
    const { all, retried } = render();
    const retry = all.find((e) => e.type === "button" && e.props["className"] === "host-retry");
    expect(retry).toBeDefined();
    (retry!.props["onClick"] as () => void)();
    expect(retried).toEqual(["mini"]);
    const order = all.map((e) => e.props["className"]);
    expect(order.indexOf("host-err")).toBeGreaterThan(order.indexOf("host-h"));
    expect(order.indexOf("ws")).toBeGreaterThan(order.indexOf("host-err"));
  });

  it("the tree under the header has the new look's agent glyph, named in its tooltip", () => {
    const { all } = render();
    // The tree's rows are the Row component; render each one's own elements.
    const rowEls = all.filter((e) => typeof e.type === "function" && typeof e.props["rowKey"] === "string");
    expect(rowEls.map((e) => e.props["rowKey"])).toEqual(["mini/w1:p1", "mini/w1:p2"]);
    const inner = rowEls.flatMap((e) => elements((e.type as (props: unknown) => unknown)(e.props)) as El[]);
    const kinds = inner.filter((e) => e.type === "span" && e.props["className"] === "kd");
    expect(kinds.map((e) => e.props["title"])).toEqual(["Claude Code"]);
  });

  it("the style sheet keeps the host header, its error and Try again beside the new row rules", () => {
    const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/button\.host-h:hover\s*\{/);
    expect(css).toMatch(/\.host-err\s*\{/);
    expect(css).toMatch(/\.host-retry/);
    expect(css).toMatch(/\.ws \.row\s*\{\s*padding-left:\s*18px/);
  });
});

// The New agent row and each workspace header's + under the new sidebar look.
describe("New agent under the new sidebar look", () => {
  const connected: HostView = { ...host, state: "connected", error: null, authRefused: false };

  it("heads the list with the New agent row, which opens for the selected pane's workspace", () => {
    const { all, newAgents } = render(connected);
    const row = all.find((e) => e.type === "button" && e.props["className"] === "sb-new")!;
    expect(row).toBeDefined();
    (row.props["onClick"] as () => void)();
    expect(newAgents).toEqual([null]);
  });

  it("keeps the project header in the new look, with its + beside it and its right-click menu", () => {
    const { all, newAgents, wsMenus } = render(connected);
    const wrap = all.find((e) => e.type === "div" && e.props["className"] === "ws-hw")!;
    expect(wrap.props["data-ws"]).toBe("w1");
    const inner = elements(wrap.props["children"]) as El[];
    expect(inner.filter((e) => e.type === "button").map((e) => e.props["className"])).toEqual(["ws-h", "ws-add"]);
    const add = inner.find((e) => e.props["className"] === "ws-add")!;
    expect(add.props["disabled"]).toBe(false);
    (add.props["onClick"] as () => void)();
    expect(newAgents).toEqual([{ hostId: "mini", workspaceId: "w1" }]);
    (wrap.props["onContextMenu"] as (event: unknown) => void)({ preventDefault: () => undefined, clientX: 5, clientY: 6 });
    expect(wsMenus).toEqual([["mini", "w1", 5, 6]]);
  });

  it("greys the + while the machine does not answer (the refused sign-in above)", () => {
    const add = render().all.find((e) => e.type === "button" && String(e.props["className"]).startsWith("ws-add"))!;
    expect(add.props["className"]).toBe("ws-add off");
    expect(add.props["disabled"]).toBe(true);
  });

  it("styles the New agent row on the new look's row radius", () => {
    const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sb-new \{[^}]*border-radius: 8px/);
    expect(css).toMatch(/\.ws-h \{[^}]*border-radius: 8px/);
  });
});
