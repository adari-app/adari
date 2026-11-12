// New workspace (App/CompanionSidebarNewSheet.swift's
// Workspace tab, HerdrKit WorkspaceActions.newWorkspace): the machines it can
// make one on (every answering machine, in the sidebar's order) with the
// folders their panes are in as suggestions, the name from the folder's last
// part until you type your own, and the request the page sends: the folder,
// the name, and the machine's connection as the window shows it when you
// press Create (a reconnect or a removed machine before it goes refuses;
// main/herdr/new-workspace.ts). Pure, shared by both sides.

import type { SessionTopology } from "../main/herdr/wire";

/** The machine's connection as the page saw it (HostView.connection, incarnation, epoch). */
export interface WorkspaceBinding {
  readonly connection: number;
  readonly incarnation: number;
  readonly epoch: number | null;
}

export interface NewWorkspaceMachine {
  readonly hostId: string;
  readonly hostName: string;
  /** Folders its panes are in, in Herdr's order, at most six. */
  readonly suggestions: readonly string[];
  readonly binding: WorkspaceBinding;
  /** This Mac (its folders are on this disk: Choose… opens the macOS folder window); absent for any other. */
  readonly local?: true;
}

/** What a machine shows as the page has it (HostView fits). */
export interface NewWorkspaceHost {
  readonly id: string;
  readonly name: string;
  /** "local" for This Mac (HostView.kind). */
  readonly kind?: "demo" | "ssh" | "local";
  readonly state: "connecting" | "connected" | "offline";
  readonly topology: SessionTopology | null;
  readonly connection?: number;
  readonly incarnation?: number;
  readonly epoch?: number | null;
}

export interface NewWorkspaceRequest {
  /** A folder on that machine (a ~ path allowed), as typed. */
  readonly folder: string;
  readonly name: string;
  readonly binding: WorkspaceBinding;
}

/** What `workspace.create` made: the workspace, its first tab and that tab's shell pane. */
export interface NewWorkspaceResult {
  readonly workspaceId: string;
  readonly label: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly folder: string;
  /**
   * Where Herdr's answer put the shell, when that is not the folder sent ("hello-app was
   * made, but its shell is in …"); null when it is there (or Herdr did not say).
   */
  readonly elsewhere?: string | null;
}

const folderOf = (pane: SessionTopology["panes"][number]): string | null =>
  pane.foregroundCWD !== undefined && pane.foregroundCWD !== "" ? pane.foregroundCWD : pane.cwd !== undefined && pane.cwd !== "" ? pane.cwd : null;

/** Every answering machine, with its panes' folders (New agent's suggestions, across the machine's workspaces). */
export function newWorkspaceMachines(hosts: readonly NewWorkspaceHost[]): NewWorkspaceMachine[] {
  const machines: NewWorkspaceMachine[] = [];
  for (const host of hosts) {
    if (host.state !== "connected" || host.topology === null) continue;
    const folders: string[] = [];
    for (const workspace of host.topology.workspaces) {
      for (const pane of host.topology.panes) {
        if (pane.workspaceID !== workspace.workspaceID) continue;
        const folder = folderOf(pane);
        if (folder !== null && !folders.includes(folder)) folders.push(folder);
      }
    }
    machines.push({
      hostId: host.id,
      hostName: host.name,
      suggestions: folders.slice(0, 6),
      binding: { connection: host.connection ?? 0, incarnation: host.incarnation ?? 0, epoch: host.epoch ?? null },
      ...(host.kind === "local" ? { local: true as const } : {}),
    });
  }
  return machines;
}

/** The selected pane's machine, else the first answering one. */
export function defaultMachine(machines: readonly NewWorkspaceMachine[], wanted: string | null): NewWorkspaceMachine | null {
  return machines.find((machine) => machine.hostId === wanted) ?? machines[0] ?? null;
}

/** The folder's last path component (WorkspaceActions.defaultWorkspaceName). */
export function defaultWorkspaceName(folder: string): string {
  let path = folder.trim();
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") return "workspace";
  if (path === "/") return "/";
  return path.split("/").filter((part) => part !== "").pop() ?? path;
}

/** The name field: what you typed (once you typed), else the folder's last part. */
export interface TypedName {
  readonly text: string;
  readonly edited: boolean;
}

/** The name sent: your own when you typed one, else the folder's last part (newWorkspace's empty name). */
export function workspaceNameSent(folder: string, typed: TypedName): string {
  const own = typed.edited ? typed.text.trim() : "";
  return own === "" ? defaultWorkspaceName(folder) : own;
}

const maxFolderBytes = 4_096;
const maxNameLength = 256;
/** A control, line-separator or invisible formatting character (New agent's folder rule). */
const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isBinding(value: unknown): value is WorkspaceBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isCount(v["connection"]) && isCount(v["incarnation"]) && (v["epoch"] === null || isCount(v["epoch"]));
}

/** A well-formed request: a folder on one line, a name, and the connection it was asked on. */
export function isNewWorkspaceRequest(value: unknown): value is NewWorkspaceRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const folder = v["folder"];
  const name = v["name"];
  return (
    typeof folder === "string" &&
    folder.trim() !== "" &&
    new TextEncoder().encode(folder).byteLength <= maxFolderBytes &&
    !unsafe.test(folder) &&
    typeof name === "string" &&
    name.trim() !== "" &&
    name.length <= maxNameLength &&
    !unsafe.test(name) &&
    isBinding(v["binding"])
  );
}

/** The machine's connection now, as the main process has it (null: not answering, or not listed). */
export interface WorkspaceConnectionNow {
  readonly connection: number | null;
  readonly incarnation: number | null;
  readonly epoch: number | null;
}

export const newWorkspaceTexts = {
  machineGone: "That machine is no longer listed.",
  notAnswering: (machine: string) => `${machine} is not answering.`,
  readded: (machine: string) => `${machine} was removed and added again since you asked; nothing was made.`,
  reconnected: (machine: string) => `${machine} reconnected since you asked; nothing was made.`,
  cannot: (machine: string) => `${machine} cannot make a workspace from here.`,
  reconnectedOpen: (machine: string) => `${machine} reconnected since this dialog opened; open New workspace again.`,
  readdedOpen: (machine: string) => `${machine} was removed and added again since this dialog opened; open New workspace again.`,
  refused: (label: string, message: string) => `Herdr did not make ${label}: ${message}`,
  elsewhere: (label: string, shell: string, sent: string) => `${label} was made, but its shell is in ${shell}, not ${sent} (Herdr could not use that folder)`,
} as const;

/**
 * Why the dialog cannot create on `opened` (the machine
 * as it was when the dialog opened) by the machines as the window shows them
 * now (null: it can). The dialog sends the binding it opened with, never a
 * newer one; once the machine's identity changed it stays refused until New
 * workspace is opened again. Main checks again before sending.
 */
export function workspaceOpenRefusal(opened: NewWorkspaceMachine, hosts: readonly NewWorkspaceHost[]): string | null {
  const host = hosts.find((candidate) => candidate.id === opened.hostId);
  if (host === undefined) return newWorkspaceTexts.machineGone;
  if ((host.incarnation ?? 0) !== opened.binding.incarnation) return newWorkspaceTexts.readdedOpen(opened.hostName);
  if (host.state !== "connected" || host.topology === null) return newWorkspaceTexts.notAnswering(opened.hostName);
  if ((host.connection ?? 0) !== opened.binding.connection || (host.epoch ?? null) !== opened.binding.epoch) {
    return newWorkspaceTexts.reconnectedOpen(opened.hostName);
  }
  return null;
}

/** Why the machine's connection is not the one you asked on (null: it is); pane-binding.ts connectionRefusal's rule. */
export function workspaceConnectionRefusal(expected: WorkspaceBinding, now: WorkspaceConnectionNow, machine: string): string | null {
  if (now.incarnation === null) return newWorkspaceTexts.machineGone;
  if (now.incarnation !== expected.incarnation) return newWorkspaceTexts.readded(machine);
  if (now.connection === null) return newWorkspaceTexts.notAnswering(machine);
  if (now.epoch === null || expected.epoch === null || now.epoch !== expected.epoch || now.connection !== expected.connection) {
    return newWorkspaceTexts.reconnected(machine);
  }
  return null;
}
