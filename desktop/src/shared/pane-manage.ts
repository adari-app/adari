// Close pane, Rename… and Rename
// workspace… from the pane header and the sidebar (the Swift app's pane
// header menu and sidebar rename: App/CompanionAgentScreen.swift moreMenu,
// App/CompanionSidebar.swift beginRename / commitEditing). Pure, shared by the
// page and the tests.

import type { SessionTopology } from "../main/herdr/wire";
import { buildDesktopSidebar, findRow, type DesktopSidebar, type SidebarHost } from "./desktop-sidebar";
import type { PaneBinding, WorkspaceBinding } from "./pane-binding";
import { buildSidebarModel, emptyFoldState, fold, sidebarInputFromTopology, type SidebarFoldState } from "./sidebar-model";

/** Why a menu's Close pane or Rename… is greyed while its machine does not answer. */
export function notAnswering(machineName: string): string {
  return `${machineName} is not answering`;
}

/**
 * The panes of `paneId`'s workspace in the sidebar's order (Projects: its
 * tabs in Herdr's order, then each tab's panes), whatever is folded, searched
 * or past "Show N more"; empty when the snapshot does not list the pane.
 */
export function workspacePaneOrder(topology: SessionTopology, macID: string, paneId: string): string[] {
  const workspaceId = topology.panes.find((pane) => pane.paneID === paneId)?.workspaceID;
  if (workspaceId === undefined) return [];
  const fold = { ...emptyFoldState, mode: "projects" as const, expandedWorkspaces: { [macID]: [workspaceId] } };
  const model = buildSidebarModel(sidebarInputFromTopology(topology, { macID, fold, nowUnixMs: 0 }));
  return model.projects.find((section) => section.header.workspaceID === workspaceId)?.rows.map((row) => row.paneID) ?? [];
}

/**
 * After the pane shown alone closed: the nearest row of its workspace in
 * `order` (the next one first, then the one before, then further out) that
 * `present` still lists; null when none is left (nothing selected).
 */
export function nearestAfterClose(order: readonly string[], closed: string, present: (paneId: string) => boolean): string | null {
  const at = order.indexOf(closed);
  if (at < 0) return null;
  for (let distance = 1; distance < order.length; distance += 1) {
    for (const index of [at + distance, at - distance]) {
      const candidate = order[index];
      if (candidate !== undefined && candidate !== closed && present(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * What a pane's menu (the header's More, a row's menu) is about, taken when it
 * opens and kept until an item is picked: the pane as
 * the window showed it then (in its tab, else as the sidebar did: `from:
 * "row"`) and the name shown. At the pick a changed pane or a reconnect is
 * refused with the binding's note; ConfirmClose and the rename field carry it
 * on to the main process.
 */
export interface PaneMenuContext {
  readonly hostId: string;
  readonly paneId: string;
  readonly binding: PaneBinding;
  readonly from?: "row";
  /** The name shown when it opened (Rename… opens with it). */
  readonly name: string;
  /**
   * What Rename… renames, as the Swift SidebarRow.renameTarget does: the pane's tab ("tab", its tab
   * the binding's) when the name shown is the tab's label, else the pane.
   */
  readonly target: RenameTarget;
}

/** What a row's Rename… renames (HerdrKit SidebarRenameTarget .pane / .tab; a header's is its workspace). */
export type RenameTarget = "pane" | "tab";

/** The Swift rule (SidebarModel.swift renameTarget): `.tab(tabID)` only when the shown name's source is the tab's label. */
export function renameTargetOf(row: { readonly nameSource: string }): RenameTarget {
  return row.nameSource === "tabLabel" ? "tab" : "pane";
}

/** The same for a workspace header's menu: its machine's connection then, and the name shown. */
export interface WorkspaceMenuContext {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly binding: WorkspaceBinding;
  readonly name: string;
}

/** The longest name Rename… sends (the field takes no more; main refuses a longer one). */
export const maxLabelLength = 256;

/**
 * What Rename… sends for the text in the field: trimmed (Herdr trims too);
 * empty is null, which clears the pane's label so Herdr's own name returns.
 */
export function renameLabel(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/** The slot an inline rename is drawn in: a pane's row or a workspace's header (the Swift app's CompanionSidebarEditing slot). */
export function paneRenameKey(hostId: string, paneId: string): string {
  return `pane:${hostId}/${paneId}`;
}

export function workspaceRenameKey(hostId: string, workspaceId: string): string {
  return `ws:${hostId}/${workspaceId}`;
}

/** What the sidebar shows: its fold (and mode), the machines folded to their header, the search. */
export interface SidebarView {
  readonly fold: SidebarFoldState;
  readonly foldedHosts: ReadonlySet<string>;
  readonly search: string | null;
}

interface SidebarRead {
  readonly nowUnixMs: number;
  readonly seenDone?: Readonly<Record<string, ReadonlySet<string>>>;
}

/** Whether the sidebar draws the pane's row where its rename field goes: its workspace's rows in Projects, its section in Priority. */
export function rowShown(sidebar: DesktopSidebar, foldedHosts: ReadonlySet<string>, hostId: string, paneId: string): boolean {
  if (sidebar.mode === "priority") return sidebar.priority.some((section) => section.rows.some((entry) => entry.hostId === hostId && entry.row.paneID === paneId));
  if (foldedHosts.has(hostId) && !sidebar.isSearching) return false;
  const model = sidebar.hosts.find((section) => section.host.id === hostId)?.model ?? null;
  return model?.projects.some((section) => section.rows.some((row) => row.paneID === paneId)) === true;
}

/** Whether the sidebar draws the workspace's header (Projects, its machine not folded). */
export function workspaceShown(sidebar: DesktopSidebar, foldedHosts: ReadonlySet<string>, hostId: string, workspaceId: string): boolean {
  if (sidebar.mode === "priority" || (foldedHosts.has(hostId) && !sidebar.isSearching)) return false;
  const model = sidebar.hosts.find((section) => section.host.id === hostId)?.model ?? null;
  return model?.projects.some((section) => section.header.workspaceID === workspaceId) === true;
}

/**
 * The sidebar as it must be for a rename's field to show on its row (the
 * header's Rename… opens it there, as the Swift app's beginRowRename does,
 * and the sidebar shows the row first): a search that hides it ends; in
 * Priority its section unfolds, or, for a row Priority does not list (a
 * shell), the sidebar goes to Projects; in Projects its machine, its
 * workspace and "Show N more" open. `view` itself when it already shows.
 */
export function revealRow(hosts: readonly SidebarHost[], view: SidebarView, read: SidebarRead, hostId: string, paneId: string): SidebarView {
  const shown = (next: SidebarView): boolean =>
    rowShown(buildDesktopSidebar(hosts, { fold: next.fold, search: next.search ?? "", ...read }), next.foldedHosts, hostId, paneId);
  if (shown(view)) return view;
  const row = findRow(hosts, hostId, paneId, read);
  if (row === null) return view;
  let next: SidebarView = view.search === null || view.search === "" ? view : { ...view, search: null };
  if (shown(next)) return next;
  if (next.fold.mode === "priority") {
    const section = row.prioritySection;
    if (section !== undefined && fold.isFoldedSection(next.fold, section)) {
      next = { ...next, fold: fold.toggleSection(next.fold, section) };
      if (shown(next)) return next;
    }
    next = { ...next, fold: { ...next.fold, mode: "projects" } };
  }
  return revealInProjects(next, hostId, row.workspaceID, (candidate) => shown(candidate), true);
}

/** The sidebar as it must be for a workspace header's rename field (Projects, its machine open, its search ended). */
export function revealWorkspace(hosts: readonly SidebarHost[], view: SidebarView, read: SidebarRead, hostId: string, workspaceId: string): SidebarView {
  const shown = (next: SidebarView): boolean =>
    workspaceShown(buildDesktopSidebar(hosts, { fold: next.fold, search: next.search ?? "", ...read }), next.foldedHosts, hostId, workspaceId);
  if (shown(view)) return view;
  let next: SidebarView = view.search === null || view.search === "" ? view : { ...view, search: null };
  if (next.fold.mode === "priority") next = { ...next, fold: { ...next.fold, mode: "projects" } };
  return revealInProjects(next, hostId, workspaceId, shown, false);
}

function revealInProjects(view: SidebarView, hostId: string, workspaceId: string, shown: (view: SidebarView) => boolean, rows: boolean): SidebarView {
  let next = view;
  if (next.foldedHosts.has(hostId)) {
    const opened = new Set(next.foldedHosts);
    opened.delete(hostId);
    next = { ...next, foldedHosts: opened };
  }
  if (shown(next) || !rows) return next;
  if (fold.isFoldedWorkspace(next.fold, workspaceId, hostId)) next = { ...next, fold: fold.toggleWorkspace(next.fold, workspaceId, hostId) };
  if (shown(next)) return next;
  if (!fold.isExpandedWorkspace(next.fold, workspaceId, hostId)) next = { ...next, fold: fold.toggleExpanded(next.fold, workspaceId, hostId) };
  return next;
}
