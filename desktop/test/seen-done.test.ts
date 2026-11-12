// A pane's Done is "seen" only while it is done. Opening
// a pane that is working must not see the Done it reaches later, and a pane
// that leaves done (done -> working -> done) must show its new Done as unseen.
// Each machine's set is its own (pane ids repeat across machines). The real
// App runs here on the small hooks host with a fake bridge; snapshots arrive
// as the main process sends them (onHostsChanged) and panes are opened the way
// the sidebar opens them (its onSelect).

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { DesktopSidebar } from "../src/shared/desktop-sidebar";
import type { HostView } from "../src/shared/ipc-contract";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { App } = await import("../src/renderer/App");
const { Sidebar } = await import("../src/renderer/components/Sidebar");

type Statuses = Record<string, "working" | "done" | "idle" | "blocked">;

/** One workspace, one tab, one Claude agent per pane, in the given statuses. */
function topology(statuses: Statuses): SessionTopology {
  const ids = Object.keys(statuses);
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [
      { workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: ids.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" },
    ],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: ids.length, agent_status: "idle" }],
    panes: ids.map((id) => ({
      pane_id: id,
      terminal_id: `term-${id}`,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      cwd: "/srv/app",
      agent: "claude",
      agent_status: statuses[id],
      revision: 1,
    })),
    layouts: [],
    agents: ids.map((id) => ({ pane_id: id, agent: "claude", agent_status: statuses[id] })),
  });
}

function host(id: string, statuses: Statuses): HostView {
  return {
    id,
    name: id,
    kind: "ssh",
    address: `dev@${id}:22`,
    platform: "Linux",
    state: "connected",
    error: null,
    topology: topology(statuses),
    fetchedAtMs: 0,
  } as HostView;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

let mounted: HookHost<object> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});

async function app(initial: HostView[]) {
  let onHosts: ((hosts: HostView[]) => void) | null = null;
  vi.stubGlobal("window", {
    herdrDesktop: {
      appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
      listHosts: async () => initial,
      onHostsChanged: (listener: (hosts: HostView[]) => void) => {
        onHosts = listener;
        return () => undefined;
      },
      onAppCommand: () => () => undefined,
      onViewCommand: () => () => undefined,
      ghosttyInfo: async () => ({ shown: false }),
      appCommandDone: () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  const ui = new HookHost(App as (props: object) => unknown, {});
  mounted = ui;
  ui.render();
  await flush();
  const sidebarProps = () => {
    const element = elements(ui.tree).find((candidate) => candidate.type === Sidebar);
    if (element === undefined) throw new Error("the sidebar is not shown");
    return element.props;
  };
  return {
    /** A new snapshot of every machine, as the main process sends it. */
    snapshot: (hosts: HostView[]) => onHosts!(hosts),
    /** Opens a pane the way the sidebar does. */
    open: (hostId: string, paneId: string) => (sidebarProps()["onSelect"] as (h: string, p: string) => void)(hostId, paneId),
    /** The pane's dot in its machine's tree: "doneUnseen" is the solid Done dot, "idle" a seen Done. */
    glyph: (hostId: string, paneId: string) =>
      (sidebarProps()["sidebar"] as DesktopSidebar).hosts
        .find((section) => section.host.id === hostId)
        ?.model?.projects.flatMap((project) => project.rows)
        .find((row) => row.paneID === paneId)?.glyph,
  };
}

describe("seen Done", () => {
  it("working -> done: opening a working pane does not see the Done it reaches later", async () => {
    const a = await app([host("mac", { "w1:p1": "working", "w1:p2": "idle" })]);
    a.open("mac", "w1:p1");
    a.open("mac", "w1:p2");
    a.snapshot([host("mac", { "w1:p1": "done", "w1:p2": "idle" })]);
    expect(a.glyph("mac", "w1:p1")).toBe("doneUnseen");
  });

  it("done -> working -> done: a Done after the pane worked again is unseen", async () => {
    const a = await app([host("mac", { "w1:p1": "done", "w1:p2": "idle" })]);
    expect(a.glyph("mac", "w1:p1")).toBe("doneUnseen");
    a.open("mac", "w1:p1");
    expect(a.glyph("mac", "w1:p1")).toBe("idle");
    a.open("mac", "w1:p2");
    a.snapshot([host("mac", { "w1:p1": "working", "w1:p2": "idle" })]);
    expect(a.glyph("mac", "w1:p1")).toBe("working");
    a.snapshot([host("mac", { "w1:p1": "done", "w1:p2": "idle" })]);
    expect(a.glyph("mac", "w1:p1")).toBe("doneUnseen");
  });

  it("keeps the same pane id on two machines apart", async () => {
    const a = await app([host("mac", { "w1:p1": "done", "w1:p2": "idle" }), host("box", { "w1:p1": "working", "w1:p2": "idle" })]);
    a.open("mac", "w1:p1");
    a.open("box", "w1:p1");
    a.open("box", "w1:p2");
    expect(a.glyph("mac", "w1:p1")).toBe("idle");
    expect(a.glyph("box", "w1:p1")).toBe("working");

    // The box's pane finishes: opening it while it worked saw nothing; the Mac's stays seen.
    a.snapshot([host("mac", { "w1:p1": "done", "w1:p2": "idle" }), host("box", { "w1:p1": "done", "w1:p2": "idle" })]);
    expect(a.glyph("mac", "w1:p1")).toBe("idle");
    expect(a.glyph("box", "w1:p1")).toBe("doneUnseen");

    // Seen on the box; then the Mac's pane works and finishes again: only the Mac's is new.
    a.open("box", "w1:p1");
    a.open("box", "w1:p2");
    a.snapshot([host("mac", { "w1:p1": "working", "w1:p2": "idle" }), host("box", { "w1:p1": "done", "w1:p2": "idle" })]);
    a.snapshot([host("mac", { "w1:p1": "done", "w1:p2": "idle" }), host("box", { "w1:p1": "done", "w1:p2": "idle" })]);
    expect(a.glyph("mac", "w1:p1")).toBe("doneUnseen");
    expect(a.glyph("box", "w1:p1")).toBe("idle");
  });

  it("a pane that turns done while open keeps its Done dot on screen and is seen once you leave it", async () => {
    const a = await app([host("mac", { "w1:p1": "working", "w1:p2": "idle" })]);
    a.open("mac", "w1:p1");
    a.snapshot([host("mac", { "w1:p1": "done", "w1:p2": "idle" })]);
    expect(a.glyph("mac", "w1:p1")).toBe("doneUnseen");
    a.open("mac", "w1:p2");
    expect(a.glyph("mac", "w1:p1")).toBe("idle");
  });
});
