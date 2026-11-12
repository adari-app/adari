// Which view a pane opens in (the Swift app's CompanionPaneModeRule and
// CompanionPaneModeMemory): an agent pane (Claude,
// Codex, Grok, any agent) opens in Chat and a shell pane in Terminal, on app
// start, after a reconnect and every time it is opened; the view you last
// picked on an agent pane is kept per Mac and pane across restarts and wins
// over that default (a pane gone from its Mac's answer drops its entry). A
// shell pane has nothing kept: it shows its terminal, always, with no switch
// (the Swift app gives it none, nor does the desktop). The pane you had open
// last comes back selected after a restart. An agent whose kind Chat doesn't read
// (src/shared/chat/kinds.ts) opens on its own screen (Terminal) instead; a
// kept pick still wins.

import { chatReads } from "./chat/kinds";
import type { MainTab } from "./ipc-contract";

export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The Swift app's key (its entries are "<host>|<pane>" → "chat" | "terminal" | "changes"). */
export const paneViewsKey = "adari.chat.paneModes";
/** Entries kept at most; past it the store starts again (a lost entry costs a default view). */
export const paneViewsCapacity = 400;
export const lastPaneKey = "adari.lastPane";

export interface ViewPane {
  readonly paneID: string;
  readonly isAgent: boolean;
  /** The agent's kind as Herdr reports it (absent: not given; the pane opens in Chat). */
  readonly kind?: string | null;
}

/** What a pane opens in when nothing was picked on it: Chat for an agent Chat reads, else Terminal (its own screen; a shell's). */
export function defaultView(pane: ViewPane): MainTab {
  if (!pane.isAgent) return "terminal";
  return pane.kind === undefined || chatReads(pane.kind) ? "chat" : "terminal";
}

const entry = (hostId: string, paneId: string): string => `${hostId}|${paneId}`;
// Changes is kept per pane too, as the Swift app's CompanionPaneModeMemory keeps .changes.
const isView = (value: unknown): value is MainTab => value === "chat" || value === "terminal" || value === "changes";

/** The hosts as pruning needs them: which panes each answering Mac has. */
export interface ViewHost {
  readonly id: string;
  readonly state: string;
  readonly topology?: { readonly panes: readonly { readonly paneID: string }[] } | null;
}

export class PaneViews {
  private kept: Record<string, MainTab>;

  constructor(private readonly storage: ViewStorage | null) {
    this.kept = this.load();
  }

  private load(): Record<string, MainTab> {
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(paneViewsKey) ?? "{}");
      if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return {};
      const out: Record<string, MainTab> = {};
      for (const [key, value] of Object.entries(saved)) if (isView(value)) out[key] = value;
      return out;
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(paneViewsKey, JSON.stringify(this.kept));
    } catch {
      // Not kept: the pane opens in its default next time.
    }
  }

  /** The view the pane shows: your pick on an agent pane, else the default for its kind (a shell: its terminal, always). */
  view(hostId: string, pane: ViewPane): MainTab {
    if (!pane.isAgent) return "terminal";
    return this.kept[entry(hostId, pane.paneID)] ?? defaultView(pane);
  }

  /** The kept pick for a pane (for tests). */
  keptView(hostId: string, paneId: string): MainTab | null {
    return this.kept[entry(hostId, paneId)] ?? null;
  }

  /** You picked `view` on an agent pane: kept across restarts. A shell pane has no switch: nothing is kept. */
  pick(hostId: string, pane: ViewPane, view: MainTab): void {
    const key = entry(hostId, pane.paneID);
    if (!pane.isAgent) return;
    if (this.kept[key] === view) return;
    if (Object.keys(this.kept).length >= paneViewsCapacity && !(key in this.kept)) this.kept = {};
    this.kept[key] = view;
    this.save();
  }

  /**
   * Drops the entries of panes gone: a Mac that answered without the pane, or
   * a Mac no longer listed. A Mac not answering keeps its entries (its panes
   * are not known to be gone). True when something was dropped.
   */
  prune(hosts: readonly ViewHost[]): boolean {
    const listed = new Map(hosts.map((host) => [host.id, host]));
    let dropped = false;
    for (const key of Object.keys(this.kept)) {
      const bar = key.indexOf("|");
      const host = listed.get(key.slice(0, bar));
      const paneId = key.slice(bar + 1);
      const answered = host !== undefined && host.state === "connected" && host.topology !== null && host.topology !== undefined;
      if (host === undefined || (answered && !host.topology!.panes.some((pane) => pane.paneID === paneId))) {
        delete this.kept[key];
        dropped = true;
      }
    }
    if (dropped) this.save();
    return dropped;
  }
}

export interface PaneRef {
  readonly hostId: string;
  readonly paneId: string;
}

/** The pane open when the app last ran, or null. */
export function loadLastPane(storage: ViewStorage | null): PaneRef | null {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(lastPaneKey) ?? "null");
    if (typeof saved !== "object" || saved === null) return null;
    const { hostId, paneId } = saved as Record<string, unknown>;
    return typeof hostId === "string" && typeof paneId === "string" && hostId !== "" && paneId !== "" ? { hostId, paneId } : null;
  } catch {
    return null;
  }
}

export function saveLastPane(storage: ViewStorage | null, pane: PaneRef | null): void {
  try {
    if (pane === null) storage?.removeItem(lastPaneKey);
    else storage?.setItem(lastPaneKey, JSON.stringify({ hostId: pane.hostId, paneId: pane.paneId }));
  } catch {
    // Not kept: the next start opens with nothing selected.
  }
}

/**
 * At start, the last pane comes back once its Mac shows it: "restore" it,
 * "wait" while its Mac is not answering yet, "drop" when the Mac answered
 * without it or is no longer listed.
 */
export function lastPaneRestore(last: PaneRef, hosts: readonly ViewHost[]): "restore" | "wait" | "drop" {
  const host = hosts.find((candidate) => candidate.id === last.hostId);
  if (host === undefined) return "drop";
  const topology = host.topology ?? null;
  if (topology !== null && topology.panes.some((pane) => pane.paneID === last.paneId)) return "restore";
  return host.state === "connected" && topology !== null ? "drop" : "wait";
}
