// SidebarFixture (Tests/HerdrKitTests/SidebarFixture.swift) in TS: a recorded
// Herdr 0.9.5 server's workspaces, tabs and panes as one session snapshot.

import { decodeSessionTopology, type SessionTopology } from "../../src/main/herdr/wire";
import {
  emptyFoldState,
  sidebarInputFromTopology,
  type AgentStatus,
  type SidebarFoldState,
  type SidebarInput,
} from "../../src/shared/sidebar-model";
import { readFixture } from "./swift-fixtures";

export const nowUnixMs = 1_800_000_000_000;

export function ago(minutes: number): number {
  return nowUnixMs - minutes * 60_000;
}

export function topology(agentsJSON = "[]"): SessionTopology {
  const json =
    '{"version":"0.9.5","protocol":22,"workspaces":' +
    readFixture("protocol22/sidebar-workspaces.json") +
    ',"tabs":' +
    readFixture("protocol22/sidebar-tabs.json") +
    ',"panes":' +
    readFixture("protocol22/sidebar-panes.json") +
    ',"layouts":[],"agents":' +
    agentsJSON +
    "}";
  return decodeSessionTopology(JSON.parse(json));
}

export function input(
  options: {
    mac?: string;
    fold?: SidebarFoldState;
    search?: string;
    summaries?: Record<string, string>;
    seen?: string[];
    shellKind?: string;
  } = {},
): SidebarInput {
  return sidebarInputFromTopology(topology(), {
    macID: options.mac ?? "mac-mini",
    fold: options.fold ?? emptyFoldState,
    search: options.search ?? "",
    needsYouSummaries: options.summaries ?? {},
    seenDonePaneIDs: new Set(options.seen ?? []),
    nowUnixMs,
    shellKind: options.shellKind ?? "shell",
  });
}

/** SidebarInput.setting: some panes' status and status-since replaced. */
export function setting(base: SidebarInput, changes: Record<string, readonly [AgentStatus, number | undefined]>): SidebarInput {
  return {
    ...base,
    panes: base.panes.map((pane) => {
      const change = changes[pane.paneID];
      if (change === undefined) return pane;
      return { ...pane, status: change[0], statusSinceUnixMs: change[1], exitedAgent: undefined };
    }),
  };
}
