// The page's Restart: the Update ready card's main
// button and the header menu's item, on your click only.

import { useSyncExternalStore } from "react";

import { restartDisabledReason, restartSessionKnown } from "../../shared/agent-restart";
import type { HostView } from "../../shared/ipc-contract";
import { agentKind } from "../../shared/send-binding";
import type { SidebarRow } from "../../shared/sidebar-model";
import { agentName } from "./agent-kind";
import { restartHolds } from "../../shared/chat/pending";
import { agentRestarts, restartHeld } from "./restart";

export interface RestartView {
  /** Null: a click restarts now. */
  readonly disabledReason: string | null;
  /** The note under the header (the restart under way, or why it stopped). */
  readonly note: string | null;
  run(): void;
}

/**
 * The pane's agent has a resume-based Restart that can run on
 * what Herdr reports now (its kind has one, and Herdr names the session id it resumes from). Other reasons a Restart
 * waits (working, a dialog, offline) pass; this is whether one can work at all.
 */
export function restartResumes(host: Pick<HostView, "topology">, paneId: string): boolean {
  const pane = host.topology?.panes.find((candidate) => candidate.paneID === paneId) ?? null;
  const agent = host.topology?.agents.find((candidate) => candidate.paneID === paneId) ?? null;
  return restartSessionKnown(agentKind(agent, pane), agent?.agentSession ?? null);
}

export function useRestart(host: HostView, row: SidebarRow): RestartView {
  const key = `${host.id}|${row.paneID}`;
  const state = useSyncExternalStore(agentRestarts.subscribe, () => agentRestarts.state(key));
  const name = agentName(row.kind);
  const pane = host.topology?.panes.find((candidate) => candidate.paneID === row.paneID) ?? null;
  const agent = host.topology?.agents.find((candidate) => candidate.paneID === row.paneID) ?? null;
  const disabledReason = restartDisabledReason({
    isAgent: row.isAgent,
    status: agent?.agentStatus ?? pane?.agentStatus ?? "",
    dialog: agent?.agentStatus === "blocked" || agent?.inputPending === true,
    online: host.state === "connected",
    sessionKnown: restartSessionKnown(agentKind(agent, pane), agent?.agentSession ?? null),
    busy: state.busy,
    name,
    machine: host.name,
  });
  return {
    disabledReason,
    note: state.note,
    run: () => {
      if (disabledReason !== null) return;
      restartHeld(agentRestarts, restartHolds, host, row.paneID, name, (binding) => window.herdrDesktop.restartAgent(host.id, row.paneID, binding));
    },
  };
}
