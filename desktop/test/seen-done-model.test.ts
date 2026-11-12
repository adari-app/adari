// The seen-Done helpers behind the App: marking sees
// only a current Done; a snapshot keeps only panes still done (keepSeenDone),
// per machine; nothing changed means the same object (no extra render).

import { describe, expect, it } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { SidebarHost } from "../src/shared/desktop-sidebar";
import { markSeenDone, reconcileSeenDone, type SeenDone } from "../src/shared/seen-done";

function host(id: string, statuses: Record<string, string> | null): SidebarHost {
  const ids = Object.keys(statuses ?? {});
  return {
    id,
    name: id,
    platform: "Linux",
    state: statuses === null ? "offline" : "connected",
    error: null,
    topology:
      statuses === null
        ? null
        : decodeSessionTopology({
            version: "0.9.5",
            protocol: 22,
            workspaces: [
              { workspace_id: "w1", number: 1, label: "api", focused: true, pane_count: ids.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" },
            ],
            tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: ids.length, agent_status: "idle" }],
            panes: ids.map((id) => ({ pane_id: id, terminal_id: `t-${id}`, workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: statuses[id], revision: 1 })),
            layouts: [],
            agents: ids.map((id) => ({ pane_id: id, agent: "claude", agent_status: statuses[id] })),
          }),
  };
}

const sorted = (seen: SeenDone): Record<string, string[]> =>
  Object.fromEntries(Object.entries(seen).map(([id, panes]) => [id, [...panes].sort()]));

describe("markSeenDone", () => {
  const hosts = [host("mac", { "w1:p1": "done", "w1:p2": "working" }), host("box", { "w1:p1": "working" })];

  it("sees a pane that is done now, on its own machine only", () => {
    expect(sorted(markSeenDone({}, hosts, "mac", "w1:p1"))).toEqual({ mac: ["w1:p1"] });
  });

  it("sees nothing for a working pane, an unknown pane or machine, or a machine without a snapshot", () => {
    const seen: SeenDone = {};
    expect(markSeenDone(seen, hosts, "mac", "w1:p2")).toBe(seen);
    expect(markSeenDone(seen, hosts, "box", "w1:p1")).toBe(seen);
    expect(markSeenDone(seen, hosts, "mac", "w9:p9")).toBe(seen);
    expect(markSeenDone(seen, hosts, "gone", "w1:p1")).toBe(seen);
    expect(markSeenDone(seen, [host("mac", null)], "mac", "w1:p1")).toBe(seen);
  });

  it("returns the same object when the Done is already seen", () => {
    const seen: SeenDone = { mac: new Set(["w1:p1"]) };
    expect(markSeenDone(seen, hosts, "mac", "w1:p1")).toBe(seen);
  });
});

describe("reconcileSeenDone", () => {
  it("forgets panes that left done, per machine", () => {
    const seen: SeenDone = { mac: new Set(["w1:p1", "w1:p2"]), box: new Set(["w1:p1"]) };
    const next = reconcileSeenDone(seen, [host("mac", { "w1:p1": "working", "w1:p2": "done" }), host("box", { "w1:p1": "done" })]);
    expect(sorted(next)).toEqual({ mac: ["w1:p2"], box: ["w1:p1"] });
    expect(next["box"]).toBe(seen["box"]);
  });

  it("forgets a pane that is gone", () => {
    expect(sorted(reconcileSeenDone({ mac: new Set(["w1:p1"]) }, [host("mac", { "w1:p2": "done" })]))).toEqual({ mac: [] });
  });

  it("keeps a machine's set while it has no snapshot, and drops a machine no longer listed", () => {
    const seen: SeenDone = { mac: new Set(["w1:p1"]), removed: new Set(["w1:p1"]) };
    expect(sorted(reconcileSeenDone(seen, [host("mac", null)]))).toEqual({ mac: ["w1:p1"] });
  });

  it("returns the same object when nothing changed", () => {
    const seen: SeenDone = { mac: new Set(["w1:p1"]) };
    expect(reconcileSeenDone(seen, [host("mac", { "w1:p1": "done" })])).toBe(seen);
  });
});
