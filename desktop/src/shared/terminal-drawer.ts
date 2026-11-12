// The terminal drawer (as T3 Code's terminal drawer under its chat, ⌘J): real
// shells in an agent pane's workspace folder,
// on the machine that workspace lives on, in a drawer along the bottom of the
// open pane, the pane's own view (Chat, the agent's own screen or Changes)
// above it. Each shell is a real Herdr shell pane made as the New agent shell
// path makes one (`tab.create` alone, main/herdr/drawer-shell.ts), so it lives in Herdr:
// it outlasts an app restart and the iPhone app sees it. Its Herdr tab is
// labelled "Terminal", the drawer's tabs read "Terminal",
// "Terminal 2", … by the drawer's order, and it lives in the drawer only: the
// sidebar leaves out every shell a drawer holds (heldShells, every owner and
// machine), so it is no row, nor in Priority, the counts, search or ⇧⌘J. A
// shell no drawer holds (made in Herdr, or its drawer gone) is an ordinary row.
//
// What is kept here, per machine and agent pane across restarts, as
// pane-view.ts keeps a pane's view: which shells belong to the pane's drawer
// (in the order they were opened), the one shown, the drawer's height and
// whether it is open. A pane gone from its machine's answer drops its entry;
// a shell gone from Herdr drops out of its drawer, and so does a saved shell
// that is its owner's own pane or another workspace's (never a close target).
// Pure, so it is tested without a window.

import type { ViewStorage } from "./pane-view";

/** The drawers, as one JSON object: "<host>|<pane>" → DrawerState. */
export const terminalDrawersKey = "adari.terminalDrawers";
/** Drawers kept at most; past it the store starts again (a lost entry costs a closed drawer). */
export const terminalDrawersCapacity = 200;
/** Shells one drawer keeps at most ("+" is greyed past it). */
export const drawerShellsCapacity = 8;
/** The label a drawer shell's Herdr tab is made with (`tab.create`; herdr-core names its terminal "terminal"). */
export const drawerShellTabLabel = "Terminal";
/** The drawer's height until you drag its top edge (a double-click comes back to it). */
export const defaultDrawerHeight = 280;
export const minimumDrawerHeight = 120;
/** The pane's own view above the drawer keeps at least this much of the column. */
export const minimumViewHeight = 160;

/** One shell of a drawer: its Herdr pane, and when it was opened (a snapshot read before then may not list it yet). */
export interface DrawerShell {
  readonly paneId: string;
  readonly addedAtMs: number;
}

export interface DrawerState {
  readonly open: boolean;
  /** Dragged to (px); null: the default. */
  readonly height: number | null;
  readonly shells: readonly DrawerShell[];
  /** The shell shown (one of `shells`), or null when there is none. */
  readonly active: string | null;
}

export const closedDrawer: DrawerState = Object.freeze({ open: false, height: null, shells: Object.freeze([]), active: null });

/** The machines as pruning needs them: which panes each answering machine has, and when that answer was read. */
export interface DrawerHost {
  readonly id: string;
  readonly state: string;
  /** The launch cache's topology shown until the first snapshot: nothing in it is pruned against. */
  readonly catchingUp?: boolean;
  readonly fetchedAtMs?: number | null;
  readonly topology?: DrawerTopology | null;
}

/** The panes of a machine's snapshot as the drawer reads them: each one's workspace, when the snapshot names it. */
export interface DrawerTopology {
  readonly panes: readonly { readonly paneID: string; readonly workspaceID?: string }[];
}

/**
 * Whether `shellPaneId` may be in `ownerPaneId`'s drawer: never the owner's own pane, and never a pane the machine's
 * snapshot puts in another workspace than the owner's (a shell not listed yet is kept until a snapshot says otherwise).
 */
export function drawerShellBelongs(ownerPaneId: string, shellPaneId: string, topology: DrawerTopology | null | undefined): boolean {
  if (shellPaneId === ownerPaneId) return false;
  const panes = topology?.panes ?? [];
  const owner = panes.find((pane) => pane.paneID === ownerPaneId)?.workspaceID;
  const shell = panes.find((pane) => pane.paneID === shellPaneId)?.workspaceID;
  return owner === undefined || shell === undefined || owner === shell;
}

const entry = (hostId: string, paneId: string): string => `${hostId}|${paneId}`;

const isHeight = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100_000;

/** A saved drawer of `ownerPaneId`, checked (null: not one); a shell that is the owner's own pane is not read back. */
function decodeState(value: unknown, ownerPaneId: string): DrawerState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const shells: DrawerShell[] = [];
  if (Array.isArray(saved["shells"])) {
    for (const shell of saved["shells"]) {
      if (typeof shell !== "object" || shell === null) continue;
      const { paneId, addedAtMs } = shell as Record<string, unknown>;
      if (typeof paneId !== "string" || paneId === "" || paneId.length > 256 || paneId === ownerPaneId || shells.some((kept) => kept.paneId === paneId)) continue;
      shells.push({ paneId, addedAtMs: typeof addedAtMs === "number" && Number.isFinite(addedAtMs) ? addedAtMs : 0 });
      if (shells.length >= drawerShellsCapacity) break;
    }
  }
  const active = typeof saved["active"] === "string" && shells.some((shell) => shell.paneId === saved["active"]) ? saved["active"] : (shells[0]?.paneId ?? null);
  return { open: saved["open"] === true, height: isHeight(saved["height"]) ? Math.round(saved["height"]) : null, shells, active };
}

/** Nothing to keep: closed, no shells, the default height. */
const isEmpty = (state: DrawerState): boolean => !state.open && state.shells.length === 0 && state.height === null;

/**
 * Every agent pane's drawer, kept in the window's localStorage. A store for
 * useSyncExternalStore: `state` answers the same object until it changes.
 */
export class TerminalDrawers {
  private kept: Record<string, DrawerState>;
  private readonly listeners = new Set<() => void>();
  private versionValue = 0;

  constructor(private readonly storage: ViewStorage | null) {
    this.kept = this.load();
  }

  private load(): Record<string, DrawerState> {
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(terminalDrawersKey) ?? "{}");
      if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return {};
      const out: Record<string, DrawerState> = {};
      for (const [key, value] of Object.entries(saved)) {
        const bar = key.indexOf("|");
        const state = bar <= 0 ? null : decodeState(value, key.slice(bar + 1));
        if (bar <= 0 || bar === key.length - 1 || state === null || isEmpty(state)) continue;
        out[key] = state;
      }
      return out;
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(terminalDrawersKey, JSON.stringify(this.kept));
    } catch {
      // Not kept: the drawer opens closed next time (its shells stay in Herdr, and show in the sidebar again).
    }
  }

  private changed(): void {
    this.versionValue += 1;
    this.save();
    for (const listener of Array.from(this.listeners)) listener();
  }

  private put(hostId: string, paneId: string, next: DrawerState): void {
    const key = entry(hostId, paneId);
    if (isEmpty(next)) {
      if (!(key in this.kept)) return;
      delete this.kept[key];
    } else {
      if (Object.keys(this.kept).length >= terminalDrawersCapacity && !(key in this.kept)) this.kept = {};
      this.kept[key] = next;
    }
    this.changed();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly version = (): number => this.versionValue;

  /** The pane's drawer (closed with nothing in it when nothing was kept). */
  state(hostId: string, paneId: string): DrawerState {
    return this.kept[entry(hostId, paneId)] ?? closedDrawer;
  }

  setOpen(hostId: string, paneId: string, open: boolean): void {
    const state = this.state(hostId, paneId);
    if (state.open !== open) this.put(hostId, paneId, { ...state, open });
  }

  /** The height you dragged it to (null: back to the default, the double-click). */
  setHeight(hostId: string, paneId: string, height: number | null): void {
    const state = this.state(hostId, paneId);
    const next = height === null || !isHeight(height) ? null : Math.round(height);
    if (state.height !== next) this.put(hostId, paneId, { ...state, height: next });
  }

  /** A shell made for the pane's drawer: kept after the others, and shown. */
  addShell(hostId: string, paneId: string, shellId: string, nowMs: number): void {
    if (shellId === paneId) return;
    const state = this.state(hostId, paneId);
    if (state.shells.some((shell) => shell.paneId === shellId)) {
      this.select(hostId, paneId, shellId);
      return;
    }
    const shells = [...state.shells, { paneId: shellId, addedAtMs: nowMs }].slice(-drawerShellsCapacity);
    this.put(hostId, paneId, { ...state, shells, active: shellId });
  }

  /** A shell closed (or gone): out of the drawer; the one beside it is shown. The last one closes the drawer. True when it was the last. */
  removeShell(hostId: string, paneId: string, shellId: string): boolean {
    const state = this.state(hostId, paneId);
    const at = state.shells.findIndex((shell) => shell.paneId === shellId);
    if (at < 0) {
      // Already out (the machine's snapshot without it came before the close answered): the last one closes it still.
      if (!state.open || state.shells.length > 0) return false;
      this.put(hostId, paneId, { ...state, open: false });
      return true;
    }
    const shells = state.shells.filter((shell) => shell.paneId !== shellId);
    const active = state.active !== shellId ? state.active : (shells[Math.min(at, shells.length - 1)]?.paneId ?? null);
    const last = shells.length === 0;
    this.put(hostId, paneId, { ...state, shells, active, open: last ? false : state.open });
    return last;
  }

  select(hostId: string, paneId: string, shellId: string): void {
    const state = this.state(hostId, paneId);
    if (state.active === shellId || !state.shells.some((shell) => shell.paneId === shellId)) return;
    this.put(hostId, paneId, { ...state, active: shellId });
  }

  /**
   * The panes the drawers hold, per machine (every owner): the sidebar leaves them out. A
   * shell held only when it may be its drawer's (drawerShellBelongs against the machine's snapshot), so a saved entry
   * naming its owner or another workspace's pane never hides that pane. One not listed yet is held already, so a shell
   * just made does not show as a row while it lands. A drawer pruned (its owner gone, its machine no longer listed)
   * holds nothing: its shells are rows again.
   */
  heldShells(hosts: readonly DrawerHost[]): Readonly<Record<string, ReadonlySet<string>>> {
    const listed = new Map(hosts.map((host) => [host.id, host]));
    const held: Record<string, Set<string>> = {};
    for (const [key, state] of Object.entries(this.kept)) {
      const bar = key.indexOf("|");
      const hostId = key.slice(0, bar);
      const host = listed.get(hostId);
      if (host === undefined) continue;
      const owner = key.slice(bar + 1);
      for (const shell of state.shells) {
        if (!drawerShellBelongs(owner, shell.paneId, host.topology)) continue;
        (held[hostId] ??= new Set()).add(shell.paneId);
      }
    }
    return held;
  }

  /** The agent pane whose drawer holds `shellId` on the machine, or null. */
  ownerOf(hostId: string, shellId: string): string | null {
    for (const [key, state] of Object.entries(this.kept)) {
      if (key.startsWith(`${hostId}|`) && state.shells.some((shell) => shell.paneId === shellId)) return key.slice(hostId.length + 1);
    }
    return null;
  }

  /**
   * Drops what is gone, as pane-view.ts prunes its views: the drawer of a pane
   * its machine answered without (or of a machine no longer listed), and every
   * shell a machine's answer read after the shell was opened does not list. A
   * machine not answering, or still showing its launch cache, keeps
   * everything. True when something was dropped.
   */
  prune(hosts: readonly DrawerHost[]): boolean {
    const listed = new Map(hosts.map((host) => [host.id, host]));
    let dropped = false;
    const next: Record<string, DrawerState> = {};
    for (const [key, state] of Object.entries(this.kept)) {
      const bar = key.indexOf("|");
      const host = listed.get(key.slice(0, bar));
      if (host === undefined) {
        dropped = true;
        continue;
      }
      const topology = host.topology ?? null;
      const answered = host.state === "connected" && topology !== null && host.catchingUp !== true;
      if (!answered) {
        next[key] = state;
        continue;
      }
      const present = new Set(topology.panes.map((pane) => pane.paneID));
      if (!present.has(key.slice(bar + 1))) {
        dropped = true;
        continue;
      }
      const readAt = host.fetchedAtMs ?? null;
      const owner = key.slice(bar + 1);
      const shells = state.shells.filter(
        (shell) => drawerShellBelongs(owner, shell.paneId, topology) && (present.has(shell.paneId) || readAt === null || readAt < shell.addedAtMs),
      );
      if (shells.length === state.shells.length) {
        next[key] = state;
        continue;
      }
      dropped = true;
      const active = shells.some((shell) => shell.paneId === state.active) ? state.active : (shells[0]?.paneId ?? null);
      const pruned: DrawerState = { ...state, shells, active };
      if (!isEmpty(pruned)) next[key] = pruned;
    }
    if (dropped) {
      this.kept = next;
      this.changed();
    }
    return dropped;
  }
}

/** A shell being made for a drawer: its machine, its workspace, and the panes the machine listed as it was asked for. */
export interface DrawerShellMaking {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly known: ReadonlySet<string>;
}

/** The machines as withShellsBeingMade reads them: each pane's workspace, and its agent when one runs in it. */
export interface MakingHost {
  readonly id: string;
  readonly topology?: { readonly panes: readonly { readonly paneID: string; readonly workspaceID?: string; readonly agent?: string }[] } | null;
}

/**
 * What the sidebar leaves out while drawer shells are being made: `held`, and each new shell pane (no agent)
 * in a making drawer's workspace that its machine did not list as it was asked for. Main sends the snapshot listing
 * the new pane before its answer names it; this keeps a "Terminal" row from flashing in meanwhile. Once the answer
 * lands the drawer holds it; if it fails, the pane is no drawer's and is an ordinary row.
 */
export function withShellsBeingMade(
  held: Readonly<Record<string, ReadonlySet<string>>>,
  hosts: readonly MakingHost[],
  making: Iterable<DrawerShellMaking>,
): Readonly<Record<string, ReadonlySet<string>>> {
  let out: Record<string, ReadonlySet<string>> | null = null;
  for (const made of making) {
    const panes = hosts.find((host) => host.id === made.hostId)?.topology?.panes ?? [];
    const fresh = panes.filter((pane) => pane.workspaceID === made.workspaceId && (pane.agent ?? "") === "" && !made.known.has(pane.paneID));
    if (fresh.length === 0) continue;
    out ??= { ...held };
    out[made.hostId] = new Set([...(out[made.hostId] ?? []), ...fresh.map((pane) => pane.paneID)]);
  }
  return out ?? held;
}

/** The drawer's height in a column `columnHeight` tall: what you dragged it to (or the default), within the bounds. */
export function drawerHeight(height: number | null, columnHeight: number): number {
  const wanted = height ?? defaultDrawerHeight;
  const most = Math.max(minimumDrawerHeight, columnHeight - minimumViewHeight);
  return Math.round(Math.min(most, Math.max(minimumDrawerHeight, wanted)));
}

/** A drawer tab's name by its place in the drawer: "Terminal", then "Terminal 2", "Terminal 3", … (never Herdr's tab number or label). */
export function drawerShellLabel(index: number): string {
  return index === 0 ? drawerShellTabLabel : `${drawerShellTabLabel} ${String(index + 1)}`;
}

/**
 * ⌘J reaches the page twice on the Mac when both the menu's key and the
 * page's key handler see it (view-menu.ts's New Workspace… notes the same);
 * the second, from the other path within `windowMs`, is the same press. A
 * toggle taken twice would do nothing, so it is taken once.
 */
export class DrawerToggleGate {
  private last: { readonly source: "key" | "menu"; readonly atMs: number } | null = null;

  constructor(private readonly windowMs = 400) {}

  /** True: act on this press. */
  take(source: "key" | "menu", nowMs: number): boolean {
    const last = this.last;
    if (last !== null && last.source !== source && nowMs - last.atMs >= 0 && nowMs - last.atMs < this.windowMs) {
      this.last = null;
      return false;
    }
    this.last = { source, atMs: nowMs };
    return true;
  }
}
