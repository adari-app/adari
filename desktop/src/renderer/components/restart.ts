// Restart's state per pane: the restart under way
// and the note the last one left under the header. The main process does the
// keys (src/main/herdr/restart.ts); the page asks for one on your tap only.

import { agentKind } from "../../shared/send-binding";
import { restartTexts, type RestartBinding } from "../../shared/agent-restart";
import type { RestartHolds } from "../../shared/chat/pending";
import type { HostView, RestartNoteEvent } from "../../shared/ipc-contract";

export interface RestartState {
  readonly busy: boolean;
  readonly note: string | null;
}

const idle: RestartState = { busy: false, note: null };
/** How every lock wait's lasting note begins (the resume went; the agent may still come back). */
const notResumedYet = "Not resumed yet: ";

/** The bridge's word for a restart that still runs. */
type NoteBridge = { onRestartNote?(listener: (event: RestartNoteEvent) => void): () => void };

export class AgentRestarts {
  private readonly states = new Map<string, RestartState>();
  private readonly listeners = new Set<() => void>();
  private bridge: NoteBridge | null = null;
  private detach: (() => void) | null = null;

  /** Main's notes for restarts that still run (one listener for the page's bridge). */
  attach(bridge: NoteBridge | null): void {
    if (bridge === this.bridge) return;
    this.detach?.();
    this.bridge = bridge;
    this.detach = bridge?.onRestartNote?.((event) => this.noted(`${event.hostId}|${event.paneId}`, event.note)) ?? null;
  }

  /** The restart for `key` still runs and says `note` now (the lock wait's); none runs: nothing. */
  noted(key: string, note: string): void {
    if (this.state(key).busy) this.set(key, { busy: true, note });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  state(key: string): RestartState {
    return this.states.get(key) ?? idle;
  }

  /** Starts the restart for `key` with `run` (the main process's: its note, or null when it resumed); false while one runs (one tap, one restart). */
  restart(key: string, run: () => Promise<string | null>, busyNote: string): boolean {
    if (this.state(key).busy) return false;
    this.set(key, { busy: true, note: busyNote });
    void run().then(
      (note) => this.set(key, { busy: false, note }),
      (error: unknown) => this.set(key, { busy: false, note: `Not restarted: ${error instanceof Error ? error.message : String(error)}` }),
    );
    return true;
  }

  dismiss(key: string): void {
    if (this.states.get(key)?.note != null) this.set(key, { ...this.state(key), note: null });
  }

  private set(key: string, state: RestartState): void {
    this.states.set(key, state);
    for (const listener of this.listeners) listener();
  }
}

export const agentRestarts = new AgentRestarts();

/** The restart for `paneId` as `host` shows it, with the run it shows when it shows one. */
export function restartBindingOf(host: Pick<HostView, "topology" | "incarnation" | "connection" | "epoch" | "run">, paneId: string, name: string): RestartBinding {
  const pane = host.topology?.panes.find((candidate) => candidate.paneID === paneId) ?? null;
  const agent = host.topology?.agents.find((candidate) => candidate.paneID === paneId) ?? null;
  return {
    terminalID: pane?.terminalID ?? "",
    kind: agentKind(agent, pane) ?? "agent",
    session: agent?.agentSession?.value ?? null,
    incarnation: host.incarnation ?? 0,
    connection: host.connection ?? 0,
    epoch: host.epoch ?? null,
    name,
    ...(host.run === undefined ? {} : { run: { connection: host.run.connection, arrival: host.run.arrivals[paneId] ?? 0 } }),
  };
}

/**
 * The page's restart of `paneId` on `host`, its
 * pending bubbles held (RestartHolds) while it runs and, once the resume
 * went, until the agent is back; a restart that stopped lets them go.
 */
export function restartHeld(
  restarts: AgentRestarts,
  holds: RestartHolds,
  host: Pick<HostView, "id" | "topology" | "incarnation" | "connection" | "epoch" | "run">,
  paneId: string,
  name: string,
  run: (binding: RestartBinding) => Promise<string | null>,
  now: () => number = Date.now,
): boolean {
  const binding = restartBindingOf(host, paneId, name);
  const key = `${host.id}/${paneId}`;
  return restarts.restart(
    `${host.id}|${paneId}`,
    async () => {
      holds.hold(key, { terminalID: binding.terminalID, session: binding.session }, now(), binding.kind);
      let resumed = false;
      try {
        const note = await run(binding);
        // The lock wait's notes come after the resume went.
        resumed = note === null || note === restartTexts.resumeUnconfirmed || note.startsWith(notResumedYet);
        return note;
      } finally {
        holds.ended(key, resumed, now());
      }
    },
    `Restarting ${name}…`,
  );
}
