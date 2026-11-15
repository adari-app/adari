// A machine for the workspace-order tests: Herdr lists the given
// workspaces (id and number), each with one Claude pane of the given status
// (idle when not given), labelled "label <id>". Fixture data only, no connection.

import { decodeSessionTopology } from "../../src/main/herdr/wire";
import type { HostView } from "../../src/shared/ipc-contract";

export function reorderMachine(id: string, workspaces: readonly (readonly [string, number])[], status: Record<string, string> = {}): HostView {
  return {
    id,
    name: id,
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    connection: 1,
    incarnation: 1,
    epoch: 1,
    topology: decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: workspaces.map(([workspace, number]) => ({
        workspace_id: workspace,
        number,
        label: `label ${workspace}`,
        focused: false,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: `${workspace}:t1`,
        agent_status: "idle",
      })),
      tabs: workspaces.map(([workspace]) => ({ tab_id: `${workspace}:t1`, workspace_id: workspace, number: 1, label: "", focused: false, pane_count: 1, agent_status: "idle" })),
      panes: workspaces.map(([workspace], index) => ({
        pane_id: `${workspace}:p1`,
        terminal_id: `t${index}`,
        workspace_id: workspace,
        tab_id: `${workspace}:t1`,
        focused: false,
        cwd: "/srv",
        agent: "claude",
        agent_status: status[workspace] ?? "idle",
        revision: 1,
      })),
      layouts: [],
      agents: workspaces.map(([workspace]) => ({ pane_id: `${workspace}:p1`, agent: "claude", agent_status: status[workspace] ?? "idle" })),
    }),
  };
}
