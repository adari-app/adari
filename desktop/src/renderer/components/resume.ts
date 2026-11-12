// The Resume chip's inputs in the page: the agent that
// left the pane (pane life, fed every snapshot by the App) and the machine's
// start commands (read once per connection by the main process, asked again
// after a reconnect). The chip fills the pane's box with the command; only your
// Return runs it, through the shell box's one-line Send.

import { useEffect, useSyncExternalStore } from "react";

import type { HerdrDesktopBridge, HostView } from "../../shared/ipc-contract";
import { resumeOffer, type PaneLife, type ResumeOffer } from "../../shared/pane-life";
import { isAgentStartCommands, type AgentStartCommands } from "../../shared/start-commands";
import type { SidebarRow } from "../../shared/sidebar-model";
import { handoffStore } from "../handoff/handoff-state";

/** Each machine's start commands, for the connection they were read on. */
export class StartCommandsStore {
  private readonly known = new Map<string, { connection: number; commands: AgentStartCommands }>();
  private readonly asked = new Set<string>();
  /** The saves made in Settings, per machine (a read that started before one is void). */
  private readonly saves = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The commands read on `connection`, or null while not known. */
  get(hostId: string, connection: number): AgentStartCommands | null {
    const entry = this.known.get(hostId);
    return entry !== undefined && entry.connection === connection ? entry.commands : null;
  }

  /** Asks the main process once per connection. */
  load(bridge: Pick<HerdrDesktopBridge, "startCommands">, hostId: string, connection: number): void {
    const key = `${hostId}|${connection}`;
    if (this.get(hostId, connection) !== null || this.asked.has(key)) return;
    this.asked.add(key);
    const saves = this.saves.get(hostId) ?? 0;
    void bridge.startCommands(hostId).then(
      (commands) => {
        if (!isAgentStartCommands(commands)) return;
        // A save in Settings came back while this read was on its way: the saved file stands.
        if ((this.saves.get(hostId) ?? 0) !== saves) {
          if (this.get(hostId, connection) === null) this.asked.delete(key);
          return;
        }
        this.known.set(hostId, { connection, commands });
        if (commands.status.type === "unreadable") this.asked.delete(key);
        for (const listener of this.listeners) listener();
      },
      () => this.asked.delete(key),
    );
  }

  /**
   * Settings › Chat saved a start command on the machine: the file as it is now (the main process
   * keeps the same for restart) is what New agent and the Resume chip use from now on, on this connection.
   */
  saved(hostId: string, connection: number, commands: AgentStartCommands): void {
    this.saves.set(hostId, (this.saves.get(hostId) ?? 0) + 1);
    this.known.set(hostId, { connection, commands });
    this.asked.add(`${hostId}|${connection}`);
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.known.clear();
    this.asked.clear();
    this.saves.clear();
  }
}

export const startCommandsStore = new StartCommandsStore();

/** The chip for the pane as it is now, or null. */
export function offerFor(life: PaneLife, host: HostView, row: SidebarRow, commands: AgentStartCommands | null): ResumeOffer | null {
  if (row.isAgent || host.topology === null || host.topology === undefined) return null;
  const pane = host.topology.panes.find((candidate) => candidate.paneID === row.paneID);
  if (pane === undefined) return null;
  return resumeOffer(life.exited(host, pane, host.topology), commands);
}

/** The pane's Resume chip, reading the start commands when an agent has left it. */
export function useResumeOffer(host: HostView, row: SidebarRow): ResumeOffer | null {
  const life = handoffStore.life;
  const connection = life.connection(host.id);
  const commands = useSyncExternalStore(startCommandsStore.subscribe, () => startCommandsStore.get(host.id, connection));
  const topology = row.isAgent ? null : (host.topology ?? null);
  const pane = topology?.panes.find((candidate) => candidate.paneID === row.paneID);
  const exited = topology === null || pane === undefined ? null : life.exited(host, pane, topology);
  // Grok's chip needs the start commands too.
  // Cursor's too.
  const wanted = exited !== null && (exited.kind === "claude" || exited.kind === "codex" || exited.kind === "grok" || exited.kind === "cursor");
  useEffect(() => {
    if (wanted) startCommandsStore.load(window.herdrDesktop, host.id, connection);
  }, [wanted, host.id, connection]);
  return offerFor(life, host, row, commands);
}
