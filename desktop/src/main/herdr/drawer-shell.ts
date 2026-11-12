// The terminal drawer's shells, in the main process.
//
// Open: a real Herdr shell pane in the agent pane's workspace, made as New
// agent's own shell path makes one (new-agent.ts: `tab.create` alone, focus
// false, the folder as cwd), so the agent's tab and layout are never touched,
// and labelled "Terminal" (no tab is named by its number; the sidebar leaves
// drawer shells out, shared/terminal-drawer.ts). On a Herdr App machine that is
// Herdr's `tab.create` with `label`; on a herdr-core machine HerdrClient's same
// call goes over the host's CoreHostTransport to the core (core-actions.ts
// `tab.create`: `terminal.run` of the machine's shell in the space), the core's
// New agent shell path, where the label is the terminal's name, in herdr-core's
// lower case: "terminal" (a name a terminal there already has is refused, and
// runShell starts it again unnamed). A folder that is not known is the
// machine's home (the SFTP login folder its transcript reader names) when it
// can be read, else none (Herdr's own start folder); the page says which. A
// folder it is given goes through the same helper as New agent's
// (folder-cwd.ts: `~` read as the machine's home, an absolute path as it is,
// anything else refused). The machine and its connection are taken when the
// shell is asked for, before anything is awaited, and checked again right
// before `tab.create` (nothing awaited between): a machine removed, edited, not
// answering or reconnected meanwhile opens nothing.
//
// Closing one (the drawer's ×) is the page's pane close, and it always asks
// first: Herdr gives no authoritative idle state for a shell, and its screen is
// no proof (a Node REPL's "> ", output ending in "$" or "#"), so nothing here
// says a shell is idle.

import { drawerShellTabLabel } from "../../shared/terminal-drawer";
import { resolveFolderCwd } from "./folder-cwd";
import { machineLink, type MachineLinkHosts } from "./machine-link";
import type { NewAgentHerdr } from "./new-agent";
import type { SessionTopology } from "./wire";

/** The page's request: the agent pane's workspace, and its folder (null: not known). */
export interface DrawerShellRequest {
  readonly workspaceId: string;
  readonly folder: string | null;
}

/** Where the shell opened: the folder asked, the machine's home (the folder was not known), or Herdr's default (neither known). */
export type DrawerShellPlace = "folder" | "home" | "default";

export interface DrawerShellResult {
  readonly paneId: string;
  readonly tabId: string;
  /** The folder it opened in, or null (Herdr's default). */
  readonly folder: string | null;
  readonly place: DrawerShellPlace;
}

/** What opening a drawer shell needs of a machine's backend (HerdrHostBackend has it). */
export interface DrawerShellBackend {
  workspaceActions?(): NewAgentHerdr;
  transcripts?(): unknown;
  /** The machine's home, for a `~` folder (folder-cwd.ts). */
  homeFolder?(): Promise<string>;
}

/** What it needs of the machines (HostRegistry has it). */
export interface DrawerShellHosts extends MachineLinkHosts {
  backend(hostId: string): DrawerShellBackend | null;
  list(): readonly { readonly id: string; readonly name: string; readonly state: string; readonly topology: SessionTopology | null }[];
  refresh(hostId: string): Promise<unknown>;
}

/** An absolute path on one line, no control or invisible character: a folder that may go to Herdr as cwd. */
function plainFolder(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4_096 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value : null;
}

/** The machine's home: its transcript reader's login folder (SFTP's realpath of "."), or null when it cannot say. */
async function machineHome(backend: DrawerShellBackend): Promise<string | null> {
  try {
    const reader = backend.transcripts?.() as { home?: () => Promise<string | null> } | null | undefined;
    if (reader === null || reader === undefined || typeof reader.home !== "function") return null;
    return plainFolder(await reader.home());
  } catch {
    return null;
  }
}

/** Opens a shell for the drawer of a pane in `request.workspaceId`; the machine's snapshot is read again before it answers. */
export async function openDrawerShell(hosts: DrawerShellHosts, hostId: string, request: DrawerShellRequest): Promise<DrawerShellResult> {
  const backend = hosts.backend(hostId);
  const host = hosts.list().find((candidate) => candidate.id === hostId);
  if (backend === null || host === undefined) throw new Error("That machine is no longer listed.");
  if (host.state !== "connected" || host.topology === null) throw new Error(`${host.name} is not answering.`);
  // The workspace is one the machine has as it answers now, before anything is read or made.
  if (!host.topology.workspaces.some((workspace) => workspace.workspaceID === request.workspaceId)) {
    throw new Error(`That workspace is not on ${host.name} now.`);
  }
  const actions = backend.workspaceActions?.();
  if (actions === undefined) throw new Error("This machine cannot open a shell from here.");
  const link = machineLink(hosts, hostId, host.name, "since the terminal was asked for");
  const readHome = backend.homeFolder?.bind(backend);
  const asked = await resolveFolderCwd(request.folder, { name: host.name, ...(readHome === undefined ? {} : { home: readHome }) });
  const home = asked === null ? await machineHome(backend) : null;
  const folder = asked ?? home;
  const place: DrawerShellPlace = asked !== null ? "folder" : home !== null ? "home" : "default";
  // New agent's shell tab (new-agent.ts `place`), with the drawer's label; the label is not New agent's request (its
  // IPC door would pass one through), so the tab is made here.
  const changed = link.check();
  if (changed !== null) throw new Error(`${changed} No terminal was opened.`);
  const making = actions.createTerminalTab(request.workspaceId, drawerShellTabLabel, folder);
  link.sent();
  const made = await making;
  await hosts.refresh(hostId).catch(() => undefined);
  return { paneId: made.rootPane.paneID, tabId: made.tab.tabID, folder, place };
}
