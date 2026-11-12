// Stop: a plain Esc to the pane on screen (`agent.send_keys ["Escape"]`: Herdr
// refuses it for a pane whose process is not an agent), exactly as pressing Esc
// in its terminal. Every call is one Esc: no fresh snapshot first, no check of
// the agent's status or episode, no latch. Kept: the key goes to the terminal
// the page showed (the latest snapshot's pane must still hold it) on the
// machine entry it showed. Resolves with the note for a key that could not go,
// or null when it went (or may have: a reply that never came says nothing, as
// the terminal would not).

import { stopTexts, type StopBinding } from "../../shared/agent-stop";
import { neverWritten } from "./send";
import { APIError, type TopologyPaneInfo } from "./wire";

/** Escape, as Herdr names the key. */
export const escapeKey = "Escape";

/** The machine's entry and its connection now. */
export interface StopIdentity {
  /** Its entry in the sidebar (a machine edited or added again is a new one). */
  readonly incarnation: number;
  /** Its answering connection's number; null while it does not answer. */
  readonly connection: number | null;
  /** The command connection a request sent now goes on (Restart's check; Stop does not compare it). */
  readonly epoch: number | null;
}

/** The machine for one stop (HostRegistry has it all). */
export interface StopSite {
  readonly writer: { agentKeys(paneID: string, keys: readonly string[]): Promise<void> };
  /** The machine's name, for the note. */
  readonly machine: string;
  /** The pane by the latest snapshot (no new read is asked for). */
  pane(): TopologyPaneInfo | null;
  /** The machine now; null when it is no longer listed. */
  identity(): StopIdentity | null;
}

export async function stopAgent(site: StopSite, paneID: string, expected: Pick<StopBinding, "terminalID" | "incarnation">): Promise<string | null> {
  const machine = site.machine;
  const identity = site.identity();
  if (identity === null || identity.connection === null) return stopTexts.offline(machine);
  if (identity.incarnation !== expected.incarnation) return stopTexts.machineChanged(machine);
  const pane = site.pane();
  if (pane === null) return stopTexts.paneGone;
  if (expected.terminalID !== "" && pane.terminalID !== expected.terminalID) return stopTexts.otherProgram;
  try {
    await site.writer.agentKeys(paneID, [escapeKey]);
  } catch (error) {
    if (error instanceof APIError) return stopTexts.refused(error.code);
    if (neverWritten(error)) return stopTexts.offline(machine);
    // Written, no reply: it may have gone, as a key pressed in the terminal; nothing to say.
    return null;
  }
  return null;
}
