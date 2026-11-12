// One workspace's panes and agents as a protocol 22 snapshot (pane-life and Resume tests).

import { decodeSessionTopology } from "../../src/main/herdr/wire";

export function paneTopology(panes: readonly { id: string; agent?: string; session?: string; sessionKind?: string; terminal?: string; display?: string }[]) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "", focused: true, pane_count: panes.length, agent_status: "idle" }],
    panes: panes.map((pane) => ({
      pane_id: pane.id,
      terminal_id: pane.terminal ?? "t1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      cwd: "/fixture",
      ...(pane.agent === undefined ? {} : { agent: pane.agent }),
      ...(pane.display === undefined ? {} : { display_agent: pane.display }),
      agent_status: pane.agent === undefined ? "unknown" : "idle",
      revision: 1,
    })),
    layouts: [],
    agents: panes
      .filter((pane) => pane.agent !== undefined)
      .map((pane) => ({
        pane_id: pane.id,
        agent: pane.agent,
        agent_status: "idle",
        terminal_id: pane.terminal ?? "t1",
        ...(pane.session === undefined
          ? {}
          : { agent_session: { source: `herdr:${pane.agent}`, agent: pane.agent, kind: pane.sessionKind ?? "id", value: pane.session } }),
      })),
  });
}
