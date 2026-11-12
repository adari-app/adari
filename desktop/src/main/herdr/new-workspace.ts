// New workspace in the main process (the app's HerdrKit
// WorkspaceActions.newWorkspace): one `workspace.create` on the machine the
// user asked, at the folder with the name, focus left alone. Herdr makes the
// workspace with one tab holding a shell at the folder (Wire.swift
// WorkspaceCreation: workspace, tab, root_pane; the Swift app says "with a
// shell in its first tab"). Bound to the machine and the connection the window
// showed when the user pressed Create: a machine no longer listed, not
// answering, removed and added again, or reconnected since (a new connection,
// or a new command connection) refuses with a note and sends nothing. The
// connection is checked right before the request with nothing awaited between
// (pane-actions.ts sendBound's rule), so it goes on the connection the user
// asked on. Never retried: Herdr's refusal comes back as Herdr says it. The
// machine is read again after, so the sidebar has the new workspace when the
// page gets the answer: a read that began after the create (HostRegistry.fresh:
// a read already under way may predate it and is followed by a new one).
//
// The folder goes as a whole path on that machine (folder-cwd.ts: `~` and `~/…`
// read as its home, before the connection check, so nothing is awaited between
// that check and the request); the result keeps the folder as typed (recent
// folders, the main area). When Herdr's answer puts the shell somewhere else (a
// folder it could not use falls back to the home, without an error), the result
// says so.

import type { HostView } from "../../shared/ipc-contract";
import {
  newWorkspaceTexts,
  workspaceConnectionRefusal,
  workspaceNameSent,
  type NewWorkspaceRequest,
  type NewWorkspaceResult,
} from "../../shared/new-workspace";
import type { ConnectionIdentity } from "../hosts";
import type { HerdrHostBackend } from "./backend";
import { placedElsewhere, resolveFolderCwd } from "./folder-cwd";
import { errorWords } from "./new-agent";
import { APIError } from "./wire";

/** What New workspace reads from the machines in the sidebar (HostRegistry has it). */
export interface NewWorkspaceHosts {
  backend(hostId: string): Pick<HerdrHostBackend, "workspaceActions" | "homeFolder"> | null;
  list(): readonly HostView[];
  /** A snapshot asked for after this call began (HostRegistry.fresh); false when none came. */
  fresh(hostId: string): Promise<boolean>;
  /** The machine's connection while it answers; null while it does not. */
  connection(hostId: string): number | null;
  /** Its entry and the command connection a request sent now goes on. */
  connectionIdentity(hostId: string): ConnectionIdentity | null;
}

export async function newWorkspace(hosts: NewWorkspaceHosts, hostId: string, request: NewWorkspaceRequest): Promise<NewWorkspaceResult> {
  const backend = hosts.backend(hostId);
  const host = hosts.list().find((candidate) => candidate.id === hostId);
  if (backend === null || host === undefined) throw new Error(newWorkspaceTexts.machineGone);
  if (host.state !== "connected" || host.topology === null) throw new Error(newWorkspaceTexts.notAnswering(host.name));
  const actions = backend.workspaceActions?.();
  const create = actions?.createWorkspace;
  if (actions === undefined || create === undefined) throw new Error(newWorkspaceTexts.cannot(host.name));
  const folder = request.folder.trim();
  const label = workspaceNameSent(folder, { text: request.name, edited: true });
  const home = backend.homeFolder?.bind(backend);
  const cwd = await resolveFolderCwd(folder, { name: host.name, ...(home === undefined ? {} : { home }) });
  // The connection the user asked on, read right before the request (nothing awaited between).
  const identity = hosts.connectionIdentity(hostId);
  const refusal = workspaceConnectionRefusal(
    request.binding,
    { connection: hosts.connection(hostId), incarnation: identity?.incarnation ?? null, epoch: identity?.epoch ?? null },
    host.name,
  );
  if (refusal !== null) throw new Error(refusal);
  let made: Awaited<ReturnType<typeof create>>;
  try {
    made = await create.call(actions, label, cwd);
  } catch (error) {
    // Herdr's refusal in its words, never its code.
    if (error instanceof APIError) throw new Error(newWorkspaceTexts.refused(label, errorWords(error)));
    throw error;
  }
  const elsewhere = placedElsewhere(cwd, made.rootPane.cwd);
  try {
    // Never the create again: only reads, at most the registry's few.
    await hosts.fresh(hostId);
  } catch {
    // The next read shows it.
  }
  return {
    workspaceId: made.workspace.workspaceID,
    label: made.workspace.label,
    tabId: made.tab.tabID,
    paneId: made.rootPane.paneID,
    folder,
    elsewhere: elsewhere === null || cwd === null ? null : newWorkspaceTexts.elsewhere(made.workspace.label, elsewhere, cwd),
  };
}
