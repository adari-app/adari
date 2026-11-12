// Which panes' Done has been seen, per machine, as the Swift app's
// CompanionSidebarMemory.seenDone keeps it. A Done is seen only while the
// pane is done: opening a working pane sees nothing, and a pane that leaves
// done is forgotten on the next snapshot (SidebarModel.seenDone, keepSeenDone
// here), so its next Done shows as new. Pane ids repeat across machines, so
// each machine has its own set.

import type { SidebarHost } from "./desktop-sidebar";
import { keepSeenDone, sidebarInputFromTopology, type SidebarPane } from "./sidebar-model";

export type SeenDone = Readonly<Record<string, ReadonlySet<string>>>;

/** The machine's panes with their statuses, or null before its first snapshot. */
function panesOf(host: SidebarHost): readonly SidebarPane[] | null {
  return host.topology === null ? null : sidebarInputFromTopology(host.topology, { macID: host.id, nowUnixMs: 0 }).panes;
}

/** Sees a pane's Done, only if the pane is done now; otherwise `seen` itself. */
export function markSeenDone(seen: SeenDone, hosts: readonly SidebarHost[], hostId: string, paneId: string): SeenDone {
  if (seen[hostId]?.has(paneId) === true) return seen;
  const host = hosts.find((candidate) => candidate.id === hostId);
  const pane = host === undefined ? undefined : panesOf(host)?.find((candidate) => candidate.paneID === paneId);
  if (pane?.status !== "done") return seen;
  return { ...seen, [hostId]: new Set([...(seen[hostId] ?? []), paneId]) };
}

/**
 * On every snapshot: each machine keeps only the panes that are still done.
 * A machine without a snapshot (connecting, offline) keeps its set until it
 * has one; a machine no longer listed is dropped. `seen` itself when nothing
 * changed.
 */
export function reconcileSeenDone(seen: SeenDone, hosts: readonly SidebarHost[]): SeenDone {
  let changed = false;
  const next: Record<string, ReadonlySet<string>> = {};
  for (const [hostId, panes] of Object.entries(seen)) {
    const host = hosts.find((candidate) => candidate.id === hostId);
    if (host === undefined) {
      changed = true;
      continue;
    }
    const current = panesOf(host);
    const kept = current === null ? panes : keepSeenDone(panes, current);
    if (kept.size === panes.size) {
      next[hostId] = panes;
    } else {
      changed = true;
      next[hostId] = kept;
    }
  }
  return changed ? next : seen;
}
