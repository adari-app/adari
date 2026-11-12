// Drafts on the IPC surface: the page loads the kept drafts,
// sends every change of a pane's draft, and takes or discards a kept draft;
// each machine's answer moves the drafts of its gone panes to Kept drafts and
// tells the page. The sender checks are ipc.ts's.

import { IPC, type HostView } from "../shared/ipc-contract";
import { compactReasonFor, isDraftInput, isId, maxDraftTextBytes, type DraftsChangedEvent } from "../shared/drafts";
import { handle, on } from "./ipc";
import type { DraftStore } from "./drafts";

export interface DraftsIpcDependencies {
  /** The agent in the pane now ("claude"), for Kept drafts' label; null for a shell or a pane not listed. */
  agentOf(hostId: string, paneId: string): string | null;
  /** The drafts changed in the main process: the page is told. */
  notify(event: DraftsChangedEvent): void;
  /** The machine's name for a Kept draft (absent or null: its id). */
  hostLabel?(hostId: string): string | null;
}

export function registerDraftsIpc(store: DraftStore, deps: DraftsIpcDependencies): void {
  handle(IPC.draftsLoad, () => store.state());
  on(IPC.draftSave, (_event, hostId, paneId, draft) => {
    if (!isId(hostId) || !isId(paneId) || !(draft === null || isDraftInput(draft))) return;
    store.put(hostId, paneId, draft, deps.agentOf(hostId, paneId));
  });
  handle(IPC.draftKept, (_event, id, action) => {
    if (!isId(id) || (action !== "take" && action !== "discard")) throw new Error("bad request");
    const item = store.takeKept(id);
    deps.notify({ state: store.state(), gone: [] });
    return action === "take" ? item : null;
  });
  // A held typed `/compact` that did not go, with newer text in the user's box, goes
  // to Kept drafts. Main names the reason itself; the page sends only the machine, the pane and the line,
  // and a bounded outcome; only the exact "refused" is kept as not sent,
  // anything else (absent, unknown, any other value) as a Compact that may have gone (compactReasonFor).
  handle(IPC.draftKeep, (_event, hostId, paneId, text, outcome) => {
    if (!isId(hostId) || !isId(paneId) || typeof text !== "string" || text === "" || text.length > 2 * maxDraftTextBytes) throw new Error("bad request");
    const item = store.keep(hostId, deps.hostLabel?.(hostId) ?? hostId, paneId, deps.agentOf(hostId, paneId), text, compactReasonFor(outcome));
    if (item !== null) deps.notify({ state: store.state(), gone: [] });
    return item;
  });
}

/**
 * The machines' snapshots: each one answering now (connected, with its
 * topology) moves the drafts of panes it no longer has to Kept drafts.
 */
export function draftsAnswered(store: DraftStore, hosts: readonly HostView[]): DraftsChangedEvent | null {
  const gone: { hostId: string; paneId: string }[] = [];
  for (const host of hosts) {
    if (host.state !== "connected" || host.topology === null) continue;
    gone.push(...store.hostAnswered(host.id, host.name, new Set(host.topology.panes.map((pane) => pane.paneID))));
  }
  return gone.length === 0 ? null : { state: store.state(), gone };
}
