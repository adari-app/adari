// New agent and the terminal drawer, bound to the machine and the command
// connection they began on. The link is taken at the main process's door,
// before anything is awaited: the machine's entry in the sidebar (its
// incarnation: an edit or a removal and adding it again is a new one), the
// connection it answers on (HostRegistry.connection: a new number after it
// stopped answering), and the SSH command connection its requests go on (the
// transport's epoch; pinned to the first one seen when none was held at the
// door). Each request of that New agent asks `check()` right before it is sent,
// with nothing awaited between: a machine removed, edited, not answering or
// reconnected since refuses with a plain sentence and the request is never
// sent, so no start, typed command, read or close ever goes on a connection
// opened after the pane was made (the transport would open one for it;
// pane-actions.ts sendBound's rule).

import type { ConnectionIdentity } from "../hosts";

/** What the link reads of the machines (HostRegistry has it). */
export interface MachineLinkHosts {
  /** The machine's connection while it answers; null while it does not, or when it is not listed. */
  connection(hostId: string): number | null;
  /** Its entry and the command connection a request sent now goes on; null when it is not listed. */
  connectionIdentity(hostId: string): ConnectionIdentity | null;
}

/** The machine and connection a New agent (or a drawer's shell) began on. */
export interface MachineLink {
  /** Why a request may not go now (a whole sentence), or null: it may. Called right before each request. */
  check(): string | null;
  /** Called right after a request was handed on: pins the command connection it went on when none was pinned yet. */
  sent(): void;
}

/** The link's sentences ("Mac mini reconnected since New agent began."). */
export const machineLinkTexts = {
  removed: (machine: string, since: string) => `${machine} was removed ${since}.`,
  replaced: (machine: string, since: string) => `${machine} was edited or added again ${since}.`,
  notAnswering: (machine: string, since: string) => `${machine} stopped answering ${since}.`,
  closed: (machine: string, since: string) => `${machine}'s connection closed ${since}.`,
  reconnected: (machine: string, since: string) => `${machine} reconnected ${since}.`,
} as const;

/** The link for `hostId` as the machines have it now (call it before anything is awaited). */
export function machineLink(hosts: MachineLinkHosts, hostId: string, machine: string, since = "since New agent began"): MachineLink {
  const begun = hosts.connectionIdentity(hostId);
  const answering = hosts.connection(hostId);
  let epoch = begun?.epoch ?? null;
  return {
    check: () => {
      const now = hosts.connectionIdentity(hostId);
      if (begun === null || now === null) return machineLinkTexts.removed(machine, since);
      if (now.incarnation !== begun.incarnation) return machineLinkTexts.replaced(machine, since);
      const connection = hosts.connection(hostId);
      if (answering === null || connection === null) return machineLinkTexts.notAnswering(machine, since);
      if (connection !== answering) return machineLinkTexts.reconnected(machine, since);
      if (epoch === null) {
        // None was held at the door: the first one seen is the one this New agent goes on.
        epoch = now.epoch;
        return null;
      }
      if (now.epoch === null) return machineLinkTexts.closed(machine, since);
      if (now.epoch !== epoch) return machineLinkTexts.reconnected(machine, since);
      return null;
    },
    sent: () => {
      if (epoch === null) epoch = hosts.connectionIdentity(hostId)?.epoch ?? null;
    },
  };
}
