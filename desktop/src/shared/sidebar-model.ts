// The sidebar's model for ONE machine, ported from HerdrKit's SidebarModel
// (Sources/HerdrKit/SidebarModel.swift) so the desktop sidebar orders, names
// and marks panes exactly as the Mac and phone apps do:
//
// - Projects: one section per workspace in Herdr's order (number, then list
//   order), or in the order this Mac keeps for the machine where one is saved
//   (orderWorkspaces: the placed ones first, then the rest in Herdr's order;
//   desktop only for now, never sent to Herdr); rows in tab order (number,
//   then list order), then pane order;
//   more than five rows show five and "Show N more"; folds per machine.
// - A row's name: the pane label, else the tab label, else the agent kind,
//   else the shell; its glyph from the status (blocked = needs you).
// - Priority: Needs you, Working, Done, Idle; newest status first, rows with
//   a time before rows without, then Projects order. Shells stay out unless
//   an agent left them.
// - Search: name, workspace, activity and kind, ignoring case and accents.
//
// Pure data in, pure data out; the multi-machine layer is desktop-sidebar.ts.

import type { SessionTopology } from "../main/herdr/wire";
import { compareWide, int64Max, type WideInt } from "./wide-int";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "indefinite" | "unrecognised" | "absent";

/** AgentStatus(wire:): "unknown" is indefinite, a value this build does not know is unrecognised. */
export function agentStatusFromWire(wire: string | undefined): AgentStatus {
  if (wire === undefined) return "absent";
  switch (wire) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
      return wire;
    case "unknown":
      return "indefinite";
    default:
      return "unrecognised";
  }
}

export interface SidebarWorkspace {
  readonly id: string;
  readonly label: string;
  /** Swift Int: exact (a bigint past 2^53), so ordering stays exact. */
  readonly number: WideInt;
}

export interface SidebarTab {
  readonly id: string;
  readonly workspaceID: string;
  readonly label: string;
  /** Swift Int: exact (a bigint past 2^53), so ordering stays exact. */
  readonly number: WideInt;
}

export interface SidebarPane {
  readonly paneID: string;
  readonly tabID: string;
  readonly workspaceID: string;
  readonly cwd?: string;
  readonly label?: string;
  readonly agentKind?: string;
  readonly status: AgentStatus;
  readonly title?: string;
  readonly statusSinceUnixMs?: WideInt;
  readonly exitedAgent?: string;
}

export function paneIsAgent(pane: SidebarPane): boolean {
  return pane.agentKind !== undefined && pane.agentKind !== "";
}

export type SidebarMode = "projects" | "priority";
export type SidebarPrioritySectionKind = "needsYou" | "working" | "done" | "idle";
export const prioritySectionKinds: readonly SidebarPrioritySectionKind[] = ["needsYou", "working", "done", "idle"];

export function prioritySectionTitle(kind: SidebarPrioritySectionKind): string {
  switch (kind) {
    case "needsYou":
      return "Needs you";
    case "working":
      return "Working";
    case "done":
      return "Done";
    case "idle":
      return "Idle";
  }
}

/**
 * A workspace's place in a machine's saved order: its id and when it was last seen in Herdr's list
 * at a move (Unix ms), so the cap drops the one unseen longest first.
 */
export interface PlacedWorkspace {
  readonly id: string;
  readonly seen: number;
}

/** The most workspaces a machine's saved order keeps (a longer saved value reads as no order). */
export const workspaceOrderCap = 500;

/** Folds, keyed per machine (SidebarFoldState). Plain JSON, so it can be saved as is. */
export interface SidebarFoldState {
  readonly mode: SidebarMode;
  readonly foldedWorkspaces: Readonly<Record<string, readonly string[]>>;
  readonly expandedWorkspaces: Readonly<Record<string, readonly string[]>>;
  readonly foldedPrioritySections: readonly SidebarPrioritySectionKind[];
  /**
   * The Projects order this Mac keeps, per machine (never sent to Herdr): its workspaces placed by a
   * drag or Move up / Move down, gone ones included so they come back to their place. Absent: Herdr's order.
   */
  readonly workspaceOrder?: Readonly<Record<string, readonly PlacedWorkspace[]>>;
}

export const emptyFoldState: SidebarFoldState = {
  mode: "projects",
  foldedWorkspaces: {},
  expandedWorkspaces: {},
  foldedPrioritySections: [],
};

/** A machine's saved order as ids (first place of an id listed twice), or undefined: none saved. */
export function savedWorkspaceOrder(state: SidebarFoldState | undefined, mac: string): readonly string[] | undefined {
  const placed = state?.workspaceOrder?.[mac];
  if (placed === undefined || placed.length === 0) return undefined;
  return [...new Set(placed.map((entry) => entry.id))];
}

/**
 * THE order of a machine's workspaces in the sidebar: Herdr's (number, then list order), then the
 * saved order on top of it: the placed ones in their saved order, then the ones never placed, in
 * Herdr's order. No saved order (undefined or empty): Herdr's order exactly.
 */
export function orderWorkspaces<T extends { readonly id: string; readonly number: WideInt }>(
  workspaces: readonly T[],
  saved?: readonly string[],
): T[] {
  const herdr = workspaces
    .map((workspace, offset) => ({ workspace, offset }))
    .sort((a, b) => compareWide(a.workspace.number, b.workspace.number) || a.offset - b.offset)
    .map((entry) => entry.workspace);
  if (saved === undefined || saved.length === 0) return herdr;
  const place = new Map<string, number>();
  saved.forEach((id, index) => {
    if (!place.has(id)) place.set(id, index);
  });
  const unplaced = saved.length;
  return herdr
    .map((workspace, offset) => ({ workspace, offset, at: place.get(workspace.id) ?? unplaced }))
    .sort((a, b) => a.at - b.at || a.offset - b.offset)
    .map((entry) => entry.workspace);
}

/** Where a workspace can go from where it is in `shown` (a machine's workspaces as the sidebar lists them). */
export function workspaceMoves(shown: readonly string[], id: string): { readonly up: boolean; readonly down: boolean } {
  const at = shown.indexOf(id);
  return { up: at > 0, down: at >= 0 && at < shown.length - 1 };
}

/**
 * The saved order after `id` is put at `slot` of `shown` (the machine's workspaces as the sidebar lists
 * them now): before `shown[slot]`, or last when `slot` is `shown.length`. The ones Herdr no longer lists
 * keep their place among the others; every listed one is stamped seen `now`; past the cap, the one
 * unseen longest goes first. A slot that leaves it where it is changes nothing (the same state back).
 */
function moveWorkspace(state: SidebarFoldState, mac: string, shown: readonly string[], id: string, slot: number, now: number): SidebarFoldState {
  const listed = [...new Set(shown)];
  const from = listed.indexOf(id);
  if (from < 0 || listed.length < 2 || !Number.isFinite(slot)) return state;
  const to = Math.max(0, Math.min(Math.trunc(slot), listed.length));
  if (to === from || to === from + 1) return state;
  const present = new Set(listed);
  const seen = new Map<string, number>();
  for (const entry of state.workspaceOrder?.[mac] ?? []) if (!seen.has(entry.id)) seen.set(entry.id, entry.seen);
  // Every workspace this Mac knows of, in the order the sidebar would list it were all of them back.
  const whole = [...seen.keys(), ...listed.filter((other) => !seen.has(other))].filter((other) => other !== id);
  const before = listed[to];
  let at: number;
  if (before !== undefined) {
    at = whole.indexOf(before);
  } else {
    // Last: right after the last listed one, so a gone one after it keeps its place.
    let last = -1;
    whole.forEach((other, index) => {
      if (present.has(other)) last = index;
    });
    at = last + 1;
  }
  whole.splice(at, 0, id);
  let placed: PlacedWorkspace[] = whole.map((other) => ({ id: other, seen: present.has(other) ? now : (seen.get(other) ?? now) }));
  while (placed.length > workspaceOrderCap) {
    let drop = -1;
    placed.forEach((entry, index) => {
      if (!present.has(entry.id) && (drop < 0 || entry.seen < placed[drop]!.seen)) drop = index;
    });
    placed = drop < 0 ? placed.slice(0, workspaceOrderCap) : placed.filter((_, index) => index !== drop);
  }
  return { ...state, workspaceOrder: { ...state.workspaceOrder, [mac]: placed } };
}

/** A machine's saved order as it was saved, or undefined: malformed or past the cap reads as no order. */
function decodePlaced(raw: unknown): PlacedWorkspace[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > workspaceOrderCap) return undefined;
  const out: PlacedWorkspace[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const { id, seen } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id === "" || typeof seen !== "number" || !Number.isFinite(seen)) return undefined;
    out.push({ id, seen });
  }
  return out;
}

function toggleIn(map:Readonly<Record<string, readonly string[]>>, mac: string, id: string): Record<string, readonly string[]> {
  const ids = new Set(map[mac] ?? []);
  if (!ids.delete(id)) ids.add(id);
  const next: Record<string, readonly string[]> = { ...map };
  if (ids.size === 0) delete next[mac];
  else next[mac] = [...ids].sort();
  return next;
}

export const fold = {
  isFoldedWorkspace: (state: SidebarFoldState, workspace: string, mac: string): boolean =>
    state.foldedWorkspaces[mac]?.includes(workspace) ?? false,
  isExpandedWorkspace: (state: SidebarFoldState, workspace: string, mac: string): boolean =>
    state.expandedWorkspaces[mac]?.includes(workspace) ?? false,
  isFoldedSection: (state: SidebarFoldState, section: SidebarPrioritySectionKind): boolean =>
    state.foldedPrioritySections.includes(section),
  toggleWorkspace: (state: SidebarFoldState, workspace: string, mac: string): SidebarFoldState => ({
    ...state,
    foldedWorkspaces: toggleIn(state.foldedWorkspaces, mac, workspace),
  }),
  toggleExpanded: (state: SidebarFoldState, workspace: string, mac: string): SidebarFoldState => ({
    ...state,
    expandedWorkspaces: toggleIn(state.expandedWorkspaces, mac, workspace),
  }),
  toggleSection: (state: SidebarFoldState, section: SidebarPrioritySectionKind): SidebarFoldState => ({
    ...state,
    foldedPrioritySections: state.foldedPrioritySections.includes(section)
      ? state.foldedPrioritySections.filter((s) => s !== section)
      : [...state.foldedPrioritySections, section],
  }),
  /** Puts a workspace at `slot` of its machine's list as the sidebar shows it (moveWorkspace above). */
  moveWorkspace,
  /** One place up or down in `shown`, or the same state where it cannot go further. */
  stepWorkspace: (state: SidebarFoldState, mac: string, shown: readonly string[], id: string, step: -1 | 1, now: number): SidebarFoldState => {
    const at = shown.indexOf(id);
    return at < 0 ? state : moveWorkspace(state, mac, shown, id, step < 0 ? at - 1 : at + 2, now);
  },
  /** Lenient decoding (SidebarFoldState.init(from:)): unknown or wrong-typed values fall back. */
  decode: (value: unknown): SidebarFoldState => {
    const o = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const map = (raw: unknown): Record<string, readonly string[]> => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
      const out: Record<string, readonly string[]> = {};
      for (const [mac, ids] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) out[mac] = ids as string[];
      }
      return out;
    };
    const sections = Array.isArray(o["foldedPrioritySections"]) ? (o["foldedPrioritySections"] as unknown[]) : [];
    // Each machine's order on its own: one malformed or too long reads as no order for that machine only.
    const order: Record<string, readonly PlacedWorkspace[]> = {};
    const rawOrder = o["workspaceOrder"];
    if (typeof rawOrder === "object" && rawOrder !== null && !Array.isArray(rawOrder)) {
      for (const [mac, placed] of Object.entries(rawOrder as Record<string, unknown>)) {
        const decoded = decodePlaced(placed);
        if (decoded !== undefined) order[mac] = decoded;
      }
    }
    return {
      mode: o["mode"] === "priority" ? "priority" : "projects",
      foldedWorkspaces: map(o["foldedWorkspaces"]),
      expandedWorkspaces: map(o["expandedWorkspaces"]),
      foldedPrioritySections: prioritySectionKinds.filter((kind) => sections.includes(kind)),
      ...(Object.keys(order).length === 0 ? {} : { workspaceOrder: order }),
    };
  },
};

export interface SidebarInput {
  readonly macID: string;
  readonly workspaces: readonly SidebarWorkspace[];
  readonly tabs: readonly SidebarTab[];
  readonly panes: readonly SidebarPane[];
  readonly needsYouSummaries?: Readonly<Record<string, string>>;
  readonly seenDonePaneIDs?: ReadonlySet<string>;
  /** The agent panes whose Claude Code has an update installed. */
  readonly updateReadyPaneIDs?: ReadonlySet<string>;
  readonly fold?: SidebarFoldState;
  readonly search?: string;
  readonly nowUnixMs: number;
  readonly shellKind?: string;
}

/** statusAnchorUnixMs: status-since, else the last completed turn. */
export function statusAnchorUnixMs(statusSinceUnixMs?: WideInt, lastCompletedUnixMs?: WideInt): WideInt | undefined {
  return statusSinceUnixMs ?? lastCompletedUnixMs;
}

/** compactTimeInState: minutes under an hour (never seconds), hours under a day, then days. */
export function compactTimeInState(sinceUnixMs: WideInt | undefined, nowUnixMs: number): string | undefined {
  if (sinceUnixMs === undefined || nowUnixMs < sinceUnixMs) return undefined;
  // A bigint here is more than 2^53 ms (285,000 years) before now: in days, exactly.
  if (typeof sinceUnixMs === "bigint") return `${(BigInt(nowUnixMs) - sinceUnixMs) / 86_400_000n}d`;
  const seconds = Math.floor((nowUnixMs - sinceUnixMs) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** SidebarInput(topology:): a pane's agent with a pending menu reads as blocked. */
export function sidebarInputFromTopology(
  topology: SessionTopology,
  options: Omit<SidebarInput, "workspaces" | "tabs" | "panes">,
): SidebarInput {
  const agentsByPane = new Map<string, SessionTopology["agents"][number]>();
  for (const agent of topology.agents) {
    if (agent.paneID !== "" && !agentsByPane.has(agent.paneID)) agentsByPane.set(agent.paneID, agent);
  }
  const panes = topology.panes.map((pane): SidebarPane => {
    const agent = agentsByPane.get(pane.paneID);
    const kind = pane.agent?.toLowerCase();
    const isAgent = pane.agent !== undefined && pane.agent !== "";
    let status = agentStatusFromWire(pane.agentStatus);
    if (isAgent && agent !== undefined && (agent.agentStatus === "blocked" || agent.inputPending === true)) {
      status = "blocked";
    }
    const anchor =
      agent === undefined ? undefined : statusAnchorUnixMs(agent.statusSinceUnixMs, agent.lastCompletedTurn?.completedUnixMs);
    const cwd =
      pane.foregroundCWD !== undefined && pane.foregroundCWD !== ""
        ? pane.foregroundCWD
        : pane.cwd !== undefined && pane.cwd !== ""
          ? pane.cwd
          : undefined;
    return {
      paneID: pane.paneID,
      tabID: pane.tabID,
      workspaceID: pane.workspaceID,
      cwd,
      label: pane.label,
      agentKind: kind,
      status,
      title: pane.terminalTitleStripped,
      statusSinceUnixMs: anchor !== undefined && anchor >= 0 ? anchor : undefined,
    };
  });
  return {
    ...options,
    workspaces: topology.workspaces.map((w) => ({ id: w.workspaceID, label: w.label, number: w.number })),
    tabs: topology.tabs.map((t) => ({ id: t.tabID, workspaceID: t.workspaceID, label: t.label, number: t.number })),
    panes,
  };
}

export type SidebarGlyph = "needsYou" | "working" | "doneUnseen" | "idle" | "unknown" | "shell";
export type SidebarNameSource = "paneLabel" | "tabLabel" | "agentKind" | "shell";

export interface SidebarRow {
  readonly paneID: string;
  readonly tabID: string;
  readonly workspaceID: string;
  readonly workspaceLabel: string;
  readonly cwd?: string;
  readonly name: string;
  readonly nameSource: SidebarNameSource;
  readonly kind: string;
  readonly isAgent: boolean;
  readonly status: AgentStatus;
  readonly activity?: string;
  readonly time?: string;
  readonly glyph: SidebarGlyph;
  readonly isDimmed: boolean;
  readonly prioritySection?: SidebarPrioritySectionKind;
  readonly statusSinceUnixMs?: WideInt;
  readonly exitedAgent?: string;
  /** Its Claude Code has an update installed ("Update ready"); absent: none. */
  readonly updateReady?: true;
}

export interface SidebarWorkspaceHeader {
  readonly workspaceID: string;
  readonly label: string;
  readonly number: WideInt;
  readonly paneCount: number;
  readonly needsYou: boolean;
  /** Its agents that need you (a folded project's header shows the count beside the dot). */
  readonly needsYouCount: number;
  readonly isEmpty: boolean;
  readonly isFolded: boolean;
}

export interface SidebarProjectSection {
  readonly header: SidebarWorkspaceHeader;
  readonly rows: readonly SidebarRow[];
  readonly hiddenCount: number;
  readonly canShowLess: boolean;
}

export interface SidebarPrioritySection {
  readonly kind: SidebarPrioritySectionKind;
  readonly count: number;
  readonly isFolded: boolean;
  readonly rows: readonly SidebarRow[];
}

export interface SidebarModel {
  readonly mode: SidebarMode;
  readonly projects: readonly SidebarProjectSection[];
  readonly priority: readonly SidebarPrioritySection[];
  /** Every agent needing you, searched or not. */
  readonly priorityBadge: number;
  readonly agentCount: number;
  readonly isSearching: boolean;
  /** Every row that has a Priority section, in Priority order (search applied), for the cross-machine merge. */
  readonly priorityRows: readonly SidebarRow[];
}

export const collapsedRowLimit = 5;

function nonEmpty(text: string | undefined): string | undefined {
  return text !== undefined && text.trim() !== "" ? text : undefined;
}

/** Case- and diacritic-insensitive folding for search. */
export function searchFold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function sidebarRow(pane: SidebarPane, workspaceLabel: string, tab: SidebarTab | undefined, input: SidebarInput): SidebarRow {
  const shellKind = input.shellKind ?? "shell";
  const isAgent = paneIsAgent(pane);
  const kind = isAgent ? pane.agentKind!.toLowerCase() : shellKind;
  let name: string;
  let nameSource: SidebarNameSource;
  const paneLabel = nonEmpty(pane.label);
  const tabLabel = nonEmpty(tab?.label);
  if (paneLabel !== undefined) {
    name = paneLabel;
    nameSource = "paneLabel";
  } else if (tabLabel !== undefined) {
    name = tabLabel;
    nameSource = "tabLabel";
  } else if (isAgent) {
    name = kind;
    nameSource = "agentKind";
  } else {
    name = shellKind;
    nameSource = "shell";
  }

  let glyph: SidebarGlyph;
  if (!isAgent) {
    glyph = "shell";
  } else {
    switch (pane.status) {
      case "blocked":
        glyph = "needsYou";
        break;
      case "working":
        glyph = "working";
        break;
      case "done":
        glyph = input.seenDonePaneIDs?.has(pane.paneID) === true ? "idle" : "doneUnseen";
        break;
      case "idle":
        glyph = "idle";
        break;
      default:
        glyph = "unknown";
    }
  }
  const exited = isAgent ? undefined : nonEmpty(pane.exitedAgent);
  let prioritySection: SidebarPrioritySectionKind | undefined;
  switch (glyph) {
    case "needsYou":
      prioritySection = "needsYou";
      break;
    case "working":
      prioritySection = "working";
      break;
    case "doneUnseen":
      prioritySection = "done";
      break;
    case "idle":
    case "unknown":
      prioritySection = "idle";
      break;
    case "shell":
      prioritySection = exited === undefined ? undefined : "idle";
  }
  const title = nonEmpty(pane.title);
  const activity =
    exited !== undefined
      ? `${exited} exited`
      : glyph === "needsYou"
        ? (nonEmpty(input.needsYouSummaries?.[pane.paneID]) ?? title)
        : title;
  return {
    paneID: pane.paneID,
    tabID: pane.tabID,
    workspaceID: pane.workspaceID,
    workspaceLabel,
    cwd: pane.cwd,
    name,
    nameSource,
    kind,
    isAgent,
    status: pane.status,
    activity,
    time: compactTimeInState(pane.statusSinceUnixMs, input.nowUnixMs),
    glyph,
    isDimmed: glyph === "idle",
    prioritySection,
    statusSinceUnixMs: pane.statusSinceUnixMs,
    exitedAgent: exited,
    ...(isAgent && input.updateReadyPaneIDs?.has(pane.paneID) === true ? { updateReady: true as const } : {}),
  };
}

/** The Priority comparator: newest status first, a time before none, then position. */
export function priorityOrder<T>(
  since: (item: T) => WideInt | undefined,
  position: (item: T) => number,
): (a: T, b: T) => number {
  return (a, b) => {
    const x = since(a);
    const y = since(b);
    if (x !== undefined && y !== undefined && x !== y) return compareWide(y, x);
    if (x !== undefined && y === undefined) return -1;
    if (x === undefined && y !== undefined) return 1;
    return position(a) - position(b);
  };
}

export function buildSidebarModel(input: SidebarInput): SidebarModel {
  const state = input.fold ?? emptyFoldState;
  const query = (input.search ?? "").trim();
  const searching = query !== "";
  const folded = searchFold(query);

  // The one place the order is made: Herdr's, with this Mac's saved order for the machine on top.
  const workspaceOrder = orderWorkspaces(input.workspaces, savedWorkspaceOrder(state, input.macID));
  const workspaceLabels = new Map<string, string>();
  for (const workspace of input.workspaces) {
    if (!workspaceLabels.has(workspace.id)) workspaceLabels.set(workspace.id, workspace.label);
  }
  const tabs = new Map<string, SidebarTab>();
  const tabRank = new Map<string, readonly [WideInt, number]>();
  input.tabs.forEach((tab, index) => {
    if (tabs.has(tab.id)) return;
    tabs.set(tab.id, tab);
    tabRank.set(tab.id, [tab.number, index]);
  });

  const rows = input.panes.map((pane) =>
    sidebarRow(pane, workspaceLabels.get(pane.workspaceID) ?? pane.workspaceID, tabs.get(pane.tabID), input),
  );
  const indexed = rows.map((row, offset) => ({ row, offset }));
  // Swift's (Int.max, Int.max).
  const unranked = [int64Max, Number.MAX_SAFE_INTEGER] as const;
  const ordered = (some: typeof indexed): SidebarRow[] =>
    [...some]
      .sort((a, b) => {
        const ra = tabRank.get(a.row.tabID) ?? unranked;
        const rb = tabRank.get(b.row.tabID) ?? unranked;
        if (ra[0] !== rb[0]) return compareWide(ra[0], rb[0]);
        if (ra[1] !== rb[1]) return ra[1] - rb[1];
        return a.offset - b.offset;
      })
      .map((entry) => entry.row);
  const rowsByWorkspace = new Map<string, SidebarRow[]>();
  for (const workspace of workspaceOrder) {
    if (!rowsByWorkspace.has(workspace.id)) {
      rowsByWorkspace.set(workspace.id, ordered(indexed.filter((entry) => entry.row.workspaceID === workspace.id)));
    }
  }

  const matches = (row: SidebarRow): boolean =>
    [row.name, row.workspaceLabel, row.activity ?? "", row.kind].some((field) => searchFold(field).includes(folded));

  const projects: SidebarProjectSection[] = [];
  const seenWorkspaces = new Set<string>();
  for (const workspace of workspaceOrder) {
    if (seenWorkspaces.has(workspace.id)) continue;
    seenWorkspaces.add(workspace.id);
    const all = rowsByWorkspace.get(workspace.id) ?? [];
    const needsYouCount = all.filter((row) => row.glyph === "needsYou").length;
    const needsYou = needsYouCount > 0;
    const isFolded = !searching && fold.isFoldedWorkspace(state, workspace.id, input.macID);
    let shown: SidebarRow[];
    let hiddenCount = 0;
    let canShowLess = false;
    if (searching) {
      shown = all.filter(matches);
      if (shown.length === 0) continue;
    } else if (isFolded) {
      // An agent that needs you is never folded away; its neighbours are.
      shown = all.filter((row) => row.glyph === "needsYou");
    } else if (all.length > collapsedRowLimit) {
      // Nor is it ever under "Show N more": the first five and every one that needs you.
      const collapsed = all.filter((row, index) => index < collapsedRowLimit || row.glyph === "needsYou");
      if (fold.isExpandedWorkspace(state, workspace.id, input.macID)) {
        shown = all;
        canShowLess = collapsed.length < all.length;
      } else {
        shown = collapsed;
        hiddenCount = all.length - collapsed.length;
      }
    } else {
      shown = all;
    }
    projects.push({
      header: {
        workspaceID: workspace.id,
        label: workspace.label,
        number: workspace.number,
        paneCount: all.length,
        needsYou,
        needsYouCount,
        isEmpty: all.length === 0,
        isFolded,
      },
      rows: shown,
      hiddenCount,
      canShowLess,
    });
  }

  const projectOrder = workspaceOrder.flatMap((workspace) => rowsByWorkspace.get(workspace.id) ?? []);
  // A workspace listed twice contributes its rows once (projectOrder may repeat; positions keep the first).
  const listed = new Set(projectOrder.map((row) => row.paneID));
  const orphans = rows.filter((row) => !listed.has(row.paneID));
  const everyRow = [...projectOrder, ...orphans];
  const position = new Map<string, number>();
  everyRow.forEach((row, index) => {
    if (!position.has(row.paneID)) position.set(row.paneID, index);
  });
  const agents = everyRow.filter((row) => row.prioritySection !== undefined);
  const candidates = (searching ? agents.filter(matches) : agents).sort(
    priorityOrder(
      (row) => row.statusSinceUnixMs,
      (row) => position.get(row.paneID) ?? 0,
    ),
  );
  const priority: SidebarPrioritySection[] = [];
  for (const kind of prioritySectionKinds) {
    const inSection = candidates.filter((row) => row.prioritySection === kind);
    if (inSection.length === 0) continue;
    const isFolded = !searching && fold.isFoldedSection(state, kind);
    priority.push({ kind, count: inSection.length, isFolded, rows: isFolded ? [] : inSection });
  }

  return {
    mode: state.mode,
    projects,
    priority,
    priorityBadge: agents.filter((row) => row.glyph === "needsYou").length,
    agentCount: agents.filter((row) => row.isAgent).length,
    isSearching: searching,
    priorityRows: candidates,
  };
}

/** SidebarModel.seenDone: forget panes that are no longer done. */
export function keepSeenDone(seen: ReadonlySet<string>, panes: readonly SidebarPane[]): Set<string> {
  const done = new Set(panes.filter((pane) => pane.status === "done").map((pane) => pane.paneID));
  return new Set([...seen].filter((id) => done.has(id)));
}
