// Update on an agent CLI (src/shared/agent-update.ts says what the
// person sees), in the main process.
//
// One Update, in order, stopping at the first refusal with a plain sentence:
// 1. the door the drawer's shell has (drawer-shell.ts shellDoor): the machine
//    listed and answering, the workspace one it has now, its shell calls; the
//    machine link (machine-link.ts) taken there, before anything is awaited;
// 2. the machine's entry, connection and command connection are the ones
//    the question showed (the request's binding, taken when it opened), or
//    nothing is read or sent;
// 3. one Update per machine and CLI at a time (a second click while one opens
//    is refused, nothing sent);
// 4. the machine's file read afresh (start-commands.ts
//    freshStartCommandsOf, one read, never the cached one): its update command
//    for the CLI must be exactly the one the question showed; another one is
//    answered back so the window asks again with it, and one gone, refused or
//    unreadable is said; nothing is sent then;
// 5. the link checked, then `tab.create` labelled "Update <CLI>" (New agent's
//    shell path: a new tab, focus unchanged, Herdr's own start folder). Herdr
//    refusing it says Herdr's words; no answer in time says an
//    "Update <CLI>" tab may have opened with nothing typed, reads the snapshot
//    once, and never asks for the tab again;
// 6. the link checked again, then the command and Return in one
//    `pane.send_input`, exactly as saved (quotes, spaces, `;` as written). A
//    machine changed between the two leaves the tab with nothing typed, and
//    says so. Typing that got no answer is never sent again.
// Nothing is read from the tab, nothing closed, no result judged. The
// machine's snapshot is read again before it answers, so the window can show
// the tab's terminal.

import { agentUpdateTexts, sameUpdateBinding, updateCliName, updateTabLabel, type AgentUpdateAnswer, type AgentUpdateRequest } from "../../shared/agent-update";
import { updateCommandFor, updateCommandKey, type AgentStartCommands } from "../../shared/start-commands";
import { shellDoor, type DrawerShellHosts } from "./drawer-shell";
import { errorWords } from "./new-agent";
import { APIError } from "./wire";

/** The Updates being opened now, per machine and CLI. */
const opening = new Set<string>();

/**
 * Runs the Update `request` on `hostId`; `read` reads the machine's start commands afresh (start-commands.ts
 * freshStartCommandsOf), once. The tab, or the file no longer holding the question's command.
 */
export async function runAgentUpdate(
  hosts: DrawerShellHosts,
  hostId: string,
  request: AgentUpdateRequest,
  read: (backend: unknown) => Promise<AgentStartCommands>,
): Promise<AgentUpdateAnswer> {
  const { backend, name, actions, link } = shellDoor(hosts, hostId, request.workspaceId, "since Update was asked for");
  // The machine as the question showed it, compared with nothing awaited since the door.
  const identity = hosts.connectionIdentity(hostId);
  const now = identity === null ? null : { incarnation: identity.incarnation, connection: hosts.connection(hostId) ?? 0, epoch: identity.epoch };
  if (now === null || !sameUpdateBinding(now, request.binding)) throw new Error(agentUpdateTexts.machineChanged(name));
  const cli = updateCliName(request.kind);
  const key = `${hostId}\u0000${request.kind}`;
  if (opening.has(key)) throw new Error(agentUpdateTexts.running(cli, name));
  opening.add(key);
  try {
    // The file as it is now, one read on this click.
    const fresh = await read(backend);
    if (fresh.status.type === "unreadable" || fresh.status.type === "malformed") {
      return { stale: { command: null, note: agentUpdateTexts.unreadable(name, fresh.status.reason), commands: null } };
    }
    const there = updateCommandFor(fresh, request.kind);
    if (there !== request.command) {
      if (there !== null) return { stale: { command: there, note: null, commands: fresh } };
      const refused = Object.hasOwn(fresh.refused, updateCommandKey(request.kind)) ? fresh.refused[updateCommandKey(request.kind)]! : null;
      return { stale: { command: null, note: refused === null ? agentUpdateTexts.gone(cli, name) : agentUpdateTexts.refusedNow(cli, name, refused), commands: fresh } };
    }
    const before = link.check();
    if (before !== null) throw new Error(`${before} Nothing was sent.`);
    const making = actions.createTerminalTab(request.workspaceId, updateTabLabel(request.kind), null);
    link.sent();
    let made: Awaited<typeof making>;
    try {
      made = await making;
    } catch (error) {
      // Herdr refused it: its words, as before. No answer in time: it may have been made; the snapshot
      // is read once so it shows, and the tab is never asked for again.
      if (error instanceof APIError) throw error;
      await hosts.refresh(hostId).catch(() => undefined);
      throw new Error(agentUpdateTexts.mayHaveOpened(cli, name, errorWords(error)));
    }
    const paneId = made.rootPane.paneID;
    const after = link.check();
    if (after !== null) {
      await hosts.refresh(hostId).catch(() => undefined);
      throw new Error(agentUpdateTexts.notTyped(after));
    }
    try {
      const typing = actions.sendInput(paneId, request.command, ["Enter"]);
      link.sent();
      await typing;
    } catch (error) {
      await hosts.refresh(hostId).catch(() => undefined);
      // Herdr refused it: not typed. No answer: it may have arrived; the tab shows which, and it is never typed again.
      throw new Error(error instanceof APIError ? agentUpdateTexts.notTyped(errorWords(error)) : agentUpdateTexts.unanswered(errorWords(error)));
    }
    await hosts.refresh(hostId).catch(() => undefined);
    return { paneId, tabId: made.tab.tabID };
  } finally {
    opening.delete(key);
  }
}
