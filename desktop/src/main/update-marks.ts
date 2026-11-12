// The main process's reads for "Update ready". Each
// time the machines' snapshots change (HostRegistry's onChange, every 5 s),
// every connected machine's agent panes go through its UpdateWatch
// (src/shared/update-mark.ts): the panes due are read once each, a short
// `pane.read` of the last lines, and the panes showing Claude Code's
// "Update installed" line go on the machine's HostView (`updateReady`),
// and so do the Codex panes showing Codex's "Update available!"
// notice (readAgentUpdate picks the reader by the pane's agent).
// Nothing is ever written to a pane; an offline machine is never read.

import { PaneReadGate } from "../shared/chat/live-reader";
import type { HostView } from "../shared/ipc-contract";
import { paneReadKey } from "./chat/live-reads";
import { UpdateWatch, updateReadLines, type UpdateWatchPane } from "../shared/update-mark";
import type { SessionTopology } from "./herdr/wire";

/** What the service needs of the machines (HostRegistry has it). */
export interface UpdateMarkHosts {
  list(): readonly HostView[];
  /** The machine's backend: its `pane.read` (absent: it cannot read a pane). */
  backend(id: string): { paneText?(paneId: string, lines: number): Promise<string> } | null;
  /** The panes marked on the machine now (HostView.updateReady). */
  setUpdateReady(hostId: string, panes: readonly string[]): void;
}

/** Each pane of the snapshot as the watch takes it: its agent, its session, idle or done. */
export function updateWatchPanes(topology: SessionTopology): UpdateWatchPane[] {
  return topology.panes.map((pane) => {
    const agent = topology.agents.find((candidate) => candidate.paneID === pane.paneID);
    const kind = pane.agent !== undefined && pane.agent !== "" ? pane.agent.toLowerCase() : null;
    const session = agent?.agentSession === undefined ? "" : `${agent.agentSession.agent}:${agent.agentSession.kind}:${agent.agentSession.value}`;
    return {
      id: pane.paneID,
      kind,
      identity: [kind ?? "", pane.terminalID, session].join("|"),
      settled: pane.agentStatus === "idle" || pane.agentStatus === "done",
      exited: kind === null,
    };
  });
}

export class UpdateMarkService {
  private readonly watches = new Map<string, { incarnation: number | undefined; watch: UpdateWatch; shown: string }>();
  /** Reads asked so far (for the budget's tests). */
  reads = 0;

  constructor(
    private readonly hosts: UpdateMarkHosts,
    private readonly now: () => number = Date.now,
    /** The per-pane read gate main shares with the needs-you card and Chat's live reads. */
    private readonly gate: PaneReadGate = new PaneReadGate(),
  ) {}

  /** A change heard while one is handled (a mark set tells the registry, which tells this again): handled after it. */
  private busy = false;
  private again = false;

  hostsChanged(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        this.pass();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private pass(): void {
    const listed = this.hosts.list();
    for (const id of this.watches.keys()) if (!listed.some((host) => host.id === id)) this.watches.delete(id);
    for (const host of listed) {
      let held = this.watches.get(host.id);
      if (held === undefined || held.incarnation !== host.incarnation) {
        held = { incarnation: host.incarnation, watch: new UpdateWatch(), shown: "" };
        this.watches.set(host.id, held);
      }
      const panes = host.topology === null ? [] : updateWatchPanes(host.topology);
      const backend = this.hosts.backend(host.id);
      const online = host.state === "connected" && backend?.paneText !== undefined;
      const due = held.watch.due(panes, this.now(), online);
      this.publish(host.id, held);
      for (const paneId of due) {
        const identity = panes.find((pane) => pane.id === paneId)!.identity;
        // The answer belongs to this entry's lifetime.
        const token = held.watch.token(paneId) ?? -1;
        this.reads += 1;
        const watch = held.watch;
        const owner = held;
        const paneText = backend!.paneText!.bind(backend);
        void this.gate.reading(paneReadKey(host.id, paneId), () => paneText(paneId, updateReadLines)).then(
          (text) => this.answer(host.id, owner, watch, paneId, identity, token, text),
          () => this.answer(host.id, owner, watch, paneId, identity, token, null),
        );
      }
    }
  }

  private answer(hostId: string, held: { watch: UpdateWatch; shown: string }, watch: UpdateWatch, paneId: string, identity: string, token: number, text: string | null): void {
    // A machine removed or added again since the read went out: its answer is dropped.
    if (this.watches.get(hostId) !== held || held.watch !== watch) return;
    watch.observe(paneId, identity, token, text, this.now());
    this.publish(hostId, held);
  }

  private publish(hostId: string, held: { watch: UpdateWatch; shown: string }): void {
    const marked = [...held.watch.marked()].sort();
    const key = marked.join("\n");
    if (key === held.shown) return;
    held.shown = key;
    this.hosts.setUpdateReady(hostId, marked);
  }
}
