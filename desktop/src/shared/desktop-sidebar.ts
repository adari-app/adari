// The desktop sidebar across SEVERAL machines, built on the one-machine model
// (sidebar-model.ts). What it adds:
//
// - a "Needs you" group FIRST, across every machine (as the phone puts what
//   needs you on top): newest first, rows with a time before rows without,
//   then machine order and each machine's own order; the rows stay in their
//   machine's tree too;
// - Priority merged across machines with the same ordering;
// - rows keyed `<hostId>/<paneID>`, since pane ids repeat across machines;
// - folds keyed per machine (the Swift model's `mac`);
// - the terminal drawers' shells left out (they
//   live in the drawer only): no row, nor in Priority, Needs you, the badge,
//   the counts, search or the ⇧⌘J cycle.

import {
  buildSidebarModel,
  emptyFoldState,
  fold as foldOps,
  priorityOrder,
  prioritySectionKinds,
  sidebarInputFromTopology,
  sidebarRow,
  type SidebarFoldState,
  type SidebarInput,
  type SidebarModel,
  type SidebarPrioritySectionKind,
  type SidebarRow,
} from "./sidebar-model";
import type { SessionTopology } from "../main/herdr/wire";

export interface SidebarHost {
  readonly id: string;
  readonly name: string;
  /** "local" for This Mac (the main process's descriptor kind); others are saved machines. */
  readonly kind?: string;
  readonly platform: string | null;
  readonly state: "connecting" | "connected" | "offline";
  readonly error: string | null;
  readonly topology: SessionTopology | null;
  /** The machine refused the sign-in (Try again shows beside the error). */
  readonly authRefused?: boolean;
  /** Its new host key was not trusted (Try again shows beside the error). */
  readonly hostKeyDeclined?: boolean;
  /** Its agent panes marked "Update ready". */
  readonly updateReady?: readonly string[];
  /** This Mac's Herdr is not running: a note with a hint under the machine, not an error. */
  readonly notRunning?: { readonly text: string; readonly hint: string };
  /** `topology` is the launch cache's until the first snapshot lands (shown dimmed, "Catching up…"). */
  readonly catchingUp?: boolean;
}

export interface DesktopRow {
  readonly key: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly row: SidebarRow;
}

export interface DesktopHostSection {
  readonly host: SidebarHost;
  /** Null until the machine's first snapshot arrives. */
  readonly model: SidebarModel | null;
}

export interface DesktopPrioritySection {
  readonly kind: SidebarPrioritySectionKind;
  readonly count: number;
  readonly isFolded: boolean;
  readonly rows: readonly DesktopRow[];
}

export interface DesktopSidebar {
  readonly mode: SidebarFoldState["mode"];
  /** Every agent needing you, across machines (search applied), newest first. */
  readonly needsYou: readonly DesktopRow[];
  readonly needsYouFolded: boolean;
  readonly hosts: readonly DesktopHostSection[];
  readonly priority: readonly DesktopPrioritySection[];
  /** Agents needing you across machines, search or not (the segment badge). */
  readonly badge: number;
  readonly agentCount: number;
  readonly isSearching: boolean;
}

export interface DesktopSidebarOptions {
  readonly fold?: SidebarFoldState;
  readonly search?: string;
  readonly nowUnixMs: number;
  readonly seenDone?: Readonly<Record<string, ReadonlySet<string>>>;
  readonly shellKind?: string;
  /**
   * Per machine, the panes this app's terminal drawers hold (TerminalDrawers.heldShells): left out of
   * everything the sidebar lists or counts. findRow still finds them (the drawer shows them).
   */
  readonly drawerShells?: Readonly<Record<string, ReadonlySet<string>>>;
}

/** The machine's sidebar input without the panes the drawers hold (the input itself when they hold none). */
function withoutDrawerShells(input: SidebarInput, held: ReadonlySet<string> | undefined): SidebarInput {
  if (held === undefined || held.size === 0) return input;
  return { ...input, panes: input.panes.filter((pane) => !held.has(pane.paneID)) };
}

export function rowKey(hostId: string, paneID: string): string {
  return `${hostId}/${paneID}`;
}

/**
 * What a folded machine keeps under its header: its rows that need you, in the
 * tree's order, each with its project. The rule folded projects follow (a needing agent is never folded away),
 * whatever the Needs you group's own fold; the machine's other rows stay folded.
 */
export function foldedMachineRows(model: SidebarModel): readonly { readonly row: SidebarRow; readonly place: string }[] {
  return model.projects.flatMap((section) =>
    section.rows.filter((row) => row.glyph === "needsYou").map((row) => ({ row, place: section.header.label })),
  );
}

/**
 * The machines the sidebar lists. This Mac only when it is useful: while its Herdr is not running
 * (or its first look is still out, so a This Mac that is not running never flashes in at launch) and another
 * machine is saved, it is left out: no header, no card, nothing in its place, and nothing of it in search,
 * Priority, the Needs you group, the counts or ⌘J. The registry's next look that finds Herdr brings it back, first
 * (it is the registry's first entry). Alone (a first run) it stays, with its card and hint.
 */
export function listedHosts<T extends SidebarHost>(hosts: readonly T[]): readonly T[] {
  if (!hosts.some((host) => host.kind !== "local")) return hosts;
  return hosts.filter((host) => host.kind !== "local" || (host.notRunning === undefined && host.state !== "connecting"));
}

export function buildDesktopSidebar(hosts: readonly SidebarHost[], options: DesktopSidebarOptions): DesktopSidebar {
  const state = options.fold ?? emptyFoldState;
  const sections: DesktopHostSection[] = listedHosts(hosts).map((host) => ({
    host,
    model:
      host.topology === null
        ? null
        : buildSidebarModel(
            withoutDrawerShells(
              sidebarInputFromTopology(host.topology, {
                macID: host.id,
                fold: state,
                search: options.search,
                nowUnixMs: options.nowUnixMs,
                seenDonePaneIDs: options.seenDone?.[host.id],
                updateReadyPaneIDs: host.updateReady === undefined ? undefined : new Set(host.updateReady),
                shellKind: options.shellKind,
              }),
              options.drawerShells?.[host.id],
            ),
          ),
  }));

  // Every Priority row across machines, with its machine order and own order.
  const candidates: { entry: DesktopRow; hostIndex: number; position: number }[] = [];
  sections.forEach((section, hostIndex) => {
    section.model?.priorityRows.forEach((row, position) => {
      candidates.push({
        entry: { key: rowKey(section.host.id, row.paneID), hostId: section.host.id, hostName: section.host.name, row },
        hostIndex,
        position,
      });
    });
  });
  const total = candidates.length + 1;
  candidates.sort(
    priorityOrder(
      (c) => c.entry.row.statusSinceUnixMs,
      (c) => c.hostIndex * total + c.position,
    ),
  );

  const isSearching = sections.some((section) => section.model?.isSearching === true);
  const priority: DesktopPrioritySection[] = [];
  for (const kind of prioritySectionKinds) {
    const rows = candidates.filter((c) => c.entry.row.prioritySection === kind).map((c) => c.entry);
    if (rows.length === 0) continue;
    const isFolded = !isSearching && foldOps.isFoldedSection(state, kind);
    priority.push({ kind, count: rows.length, isFolded, rows: isFolded ? [] : rows });
  }

  return {
    mode: state.mode,
    needsYou: candidates.filter((c) => c.entry.row.glyph === "needsYou").map((c) => c.entry),
    needsYouFolded: !isSearching && foldOps.isFoldedSection(state, "needsYou"),
    hosts: sections,
    priority,
    badge: sections.reduce((sum, section) => sum + (section.model?.priorityBadge ?? 0), 0),
    agentCount: sections.reduce((sum, section) => sum + (section.model?.agentCount ?? 0), 0),
    isSearching,
  };
}

/** The next row needing you after `currentKey` (wrapping), for the jump shortcut. */
export function nextNeedsYou(sidebar: DesktopSidebar, currentKey: string | null): DesktopRow | null {
  const rows = sidebar.needsYou;
  if (rows.length === 0) return null;
  const index = currentKey === null ? -1 : rows.findIndex((row) => row.key === currentKey);
  return rows[(index + 1) % rows.length] ?? null;
}

/** One pane's row on one machine, whatever is folded or searched (for the main pane's header). */
export function findRow(
  hosts: readonly SidebarHost[],
  hostId: string,
  paneID: string,
  options: Pick<DesktopSidebarOptions, "nowUnixMs" | "seenDone" | "shellKind">,
): SidebarRow | null {
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (host === undefined || host.topology === null) return null;
  const input = sidebarInputFromTopology(host.topology, {
    macID: host.id,
    nowUnixMs: options.nowUnixMs,
    seenDonePaneIDs: options.seenDone?.[host.id],
    updateReadyPaneIDs: host.updateReady === undefined ? undefined : new Set(host.updateReady),
    shellKind: options.shellKind,
  });
  const pane = input.panes.find((candidate) => candidate.paneID === paneID);
  if (pane === undefined) return null;
  const label = input.workspaces.find((workspace) => workspace.id === pane.workspaceID)?.label ?? pane.workspaceID;
  return sidebarRow(pane, label, input.tabs.find((tab) => tab.id === pane.tabID), input);
}
