// New agent's sheet (App/CompanionSidebarNewSheet.swift, CompanionNewAgentEmpty.swift):
// which workspaces it can start in (every answering machine's,
// in the sidebar's order), the folder it prefills (the workspace's own: its
// first pane's folder) and suggests (the folders its panes are in), the kinds
// (every agent the machine's Herdr can start, any other kind the Mac's
// agents.json names, and a shell) with what each will run, and the kind you
// last picked.

import type { SessionTopology, TabInfo, TopologyPaneInfo } from "../main/herdr/wire";
import { agentKinds, knownAgentName } from "./agent-names";
import { isCoreID } from "./core-ids";
import type { PaneBinding } from "./pane-binding";
import { typedStart, type AgentStartCommands } from "./start-commands";

export interface NewAgentPlace {
  readonly hostId: string;
  readonly hostName: string;
  readonly workspaceId: string;
  readonly workspace: string;
  /** The workspace's own folder (its first pane's), or null. */
  readonly folder: string | null;
  /** Folders its panes are in, the workspace's first, at most six. */
  readonly suggestions: readonly string[];
  /** This Mac (its folders are on this disk: Choose… opens the macOS folder window); absent for any other. */
  readonly local?: true;
}

export interface NewAgentHost {
  readonly id: string;
  readonly name: string;
  /** "local" for This Mac (HostView.kind). */
  readonly kind?: "demo" | "ssh" | "local";
  readonly state: "connecting" | "connected" | "offline";
  readonly topology: SessionTopology | null;
}

const folderOf = (pane: SessionTopology["panes"][number]): string | null =>
  pane.foregroundCWD !== undefined && pane.foregroundCWD !== "" ? pane.foregroundCWD : pane.cwd !== undefined && pane.cwd !== "" ? pane.cwd : null;

/** Every workspace New agent can start in: each answering machine's, in Herdr's order. */
export function newAgentPlaces(hosts: readonly NewAgentHost[]): NewAgentPlace[] {
  const places: NewAgentPlace[] = [];
  for (const host of hosts) {
    if (host.state !== "connected" || host.topology === null) continue;
    const topology = host.topology;
    const seen = new Set<string>();
    for (const workspace of topology.workspaces) {
      if (seen.has(workspace.workspaceID)) continue;
      seen.add(workspace.workspaceID);
      const folders: string[] = [];
      for (const pane of topology.panes) {
        if (pane.workspaceID !== workspace.workspaceID) continue;
        const folder = folderOf(pane);
        if (folder !== null && !folders.includes(folder)) folders.push(folder);
      }
      places.push({
        hostId: host.id,
        hostName: host.name,
        workspaceId: workspace.workspaceID,
        workspace: workspace.label,
        folder: folders[0] ?? null,
        suggestions: folders.slice(0, 6),
        ...(host.kind === "local" ? { local: true as const } : {}),
      });
    }
  }
  return places;
}

export const placeKey = (place: Pick<NewAgentPlace, "hostId" | "workspaceId">): string => `${place.hostId}|${place.workspaceId}`;

/** Where ⌘N and the sidebar's New agent start: the selected pane's workspace, else the first one. */
export function defaultPlace(
  places: readonly NewAgentPlace[],
  wanted: { readonly hostId: string; readonly workspaceId: string } | null,
): NewAgentPlace | null {
  if (wanted !== null) {
    const found = places.find((place) => placeKey(place) === placeKey(wanted));
    if (found !== undefined) return found;
  }
  return places[0] ?? null;
}

/** One kind the sheet offers. */
export interface NewAgentKindChoice {
  readonly kind: string;
  readonly title: string;
  /** What it runs: "Runs cl", "Herdr starts claude", "A shell in its own tab". */
  readonly detail: string;
}

/**
 * New agent's rule: a kind is listed when the machine's own
 * start takes it. On a Herdr machine that is every kind Herdr reports
 * (src/shared/agent-names.ts): its `agent.start` accepts each of its labels
 * (`parse_agent_label`) and types that kind's executable into the new pane's
 * shell (Herdr's src/app/agents.rs). On a herdr-core machine (an `hc:` space)
 * the bridge's `agent.start` types `exec <kind>` for these three only
 * (src/main/herdr/core-actions.ts). Neither checks that the program is
 * installed there: a missing one prints in the new pane's shell.
 */
export const coreStartKinds = ["claude", "codex", "grok"] as const;
/**
 * Herdr App's menu order (its src/programs.rs AGENTS_FIRST); the rest follow by name. Gemini CLI is deprecated and
 * Antigravity CLI takes its place; Gemini CLI follows with the rest by name, still startable, named deprecated
 * (newAgentKindTitle).
 */
export const herdrAppFirst = ["claude", "codex", "pi", "opencode", "cursor", "copilot", "amp", "agy", "grok"] as const;

/** Kinds New agent and Settings still start, named deprecated there: Gemini CLI (Antigravity CLI replaces it). */
export const deprecatedStartKinds: readonly string[] = ["gemini"];

/** The kind's name in New agent's list (and Settings): its own, "Gemini CLI (deprecated)" for a deprecated kind. */
export function newAgentKindTitle(kind: string): string {
  const name = knownAgentName(kind) ?? kind.slice(0, 1).toUpperCase() + kind.slice(1);
  return deprecatedStartKinds.includes(kind) ? `${name} (deprecated)` : name;
}

/** The kinds the machine's start takes, for a workspace there (null: a Herdr machine's), in New agent's order. */
export function startableKinds(workspaceId: string | null = null): string[] {
  const kinds = workspaceId !== null && isCoreID(workspaceId) ? [...coreStartKinds] : agentKinds.map((known) => known.kind);
  const rank = (kind: string): number => {
    const index = (herdrAppFirst as readonly string[]).indexOf(kind);
    return index < 0 ? herdrAppFirst.length : index;
  };
  const name = (kind: string): string => (knownAgentName(kind) ?? kind).toLowerCase();
  return kinds.sort((a, b) => rank(a) - rank(b) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
}

/** The kinds: every one the machine's Herdr can start, any other kind agents.json names, then a shell. */
export function newAgentKinds(commands: AgentStartCommands | null, workspaceId: string | null = null): NewAgentKindChoice[] {
  const startable = startableKinds(workspaceId);
  const extra = Object.keys(commands?.commands ?? {})
    .filter((kind) => !startable.includes(kind) && /^[a-z][a-z0-9_-]{0,31}$/.test(kind))
    .sort();
  const agents = [...startable, ...extra].map((kind) => {
    const plan = commands === null ? null : typedStart(commands, kind);
    return {
      kind,
      title: newAgentKindTitle(kind),
      detail:
        plan?.type === "typed"
          ? `Runs ${plan.command}`
          : plan?.type === "herdr" && plan.notTyped !== null
            ? `Herdr starts ${kind} (its agents.json command is not plain)`
            : `Herdr starts ${kind}`,
    };
  });
  return [...agents, { kind: "shell", title: "Shell", detail: "A shell in its own tab" }];
}

export const lastKindKey = "adari.newAgent.kind";

export interface KindStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The kind you picked last (Claude Code at first). */
export function lastKind(storage: KindStorage | null): string {
  try {
    const saved = storage?.getItem(lastKindKey) ?? null;
    return saved !== null && /^[a-z][a-z0-9_-]{0,31}$/.test(saved) ? saved : "claude";
  } catch {
    return "claude";
  }
}

export function rememberKind(storage: KindStorage | null, kind: string): void {
  try {
    storage?.setItem(lastKindKey, kind);
  } catch {
    // Not kept: the next sheet starts on Claude.
  }
}

/** The last three folders ("…/demo/code/aurora-web"), as the design shows a path. */
export function shortFolder(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

/** The footer: what Return does. */
export function newAgentNote(choice: NewAgentKindChoice, place: NewAgentPlace | null, folder: string): string {
  const where = folder.trim() === "" ? (place === null ? "" : ` in ${place.workspace}`) : ` in ${shortFolder(folder.trim())}`;
  if (choice.kind === "shell") return `Opens a shell${where}`;
  return `${choice.detail.startsWith("Runs ") ? `Runs ${choice.detail.slice(5)}` : `Starts ${choice.title}`}${where}`;
}

/**
 * The pane New agent can split: the focused pane, its
 * workspace, and how many panes its tab has (a split is refused at 4).
 */
export interface NewAgentSplitTarget {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly paneId: string;
  readonly name: string;
  readonly tabPanes: number;
  /** The pane as the window showed it when the dialog or menu opened; the split is refused once it changed. */
  readonly binding: PaneBinding;
}

/** New agent's Where: a new tab, or a split of the focused pane right or down. */
export type NewAgentWhereChoice = "tab" | "right" | "down";

// What main tells the page that asked while its New agent runs (IPC
// newAgentProgress, under the id the page gave: isStartId). `step`: a line naming the step in front of the pane that
// runs now, each time that changes (the dialog shows it once that step ran about a second; null: none runs). `pane`:
// the pane exists, with Herdr's answer for it (the new tab, null for a split, and the pane), so the window shows it
// before any snapshot lists it; the rest of the start carries on behind it, and the answer comes later as before.
// The page says when the pane is on screen (IPC newAgentShown, from the window that asked and for that pane), the
// record's `shown`. `closed`: the start failed and closed the pane it told, told before its answer.

export type NewAgentProgress =
  | { readonly startId: string; readonly type: "step"; readonly words: string | null }
  | {
      readonly startId: string;
      readonly type: "pane";
      readonly paneId: string;
      readonly tabId: string;
      readonly tab: TabInfo | null;
      readonly pane: TopologyPaneInfo;
    }
  | { readonly startId: string; readonly type: "closed"; readonly paneId: string };

/** A page's id for one New agent: 8 to 64 letters, digits and dashes (a UUID). */
export function isStartId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

/** How long a step runs before the dialog names it. */
export const progressAfterMs = 1_000;

/** The lines New agent's dialog shows while a step before the pane runs. */
export const newAgentProgressTexts = {
  models: (machine: string) => `Checking the model list on ${machine}…`,
  commands: (machine: string) => `Reading the start commands on ${machine}…`,
  integration: (action: "install" | "update", name: string, machine: string) =>
    `${action === "update" ? "Updating" : "Installing"} Herdr's ${name} integration on ${machine}…`,
  list: (machine: string) => `Reading the agent list on ${machine}…`,
  pane: (place: "tab" | "pane", machine: string) => `Making the new ${place} on ${machine}…`,
} as const;

/** A fresh id for one New agent's progress (a UUID where the page has one). */
export function newStartId(): string {
  const made = globalThis.crypto?.randomUUID?.();
  return made !== undefined && isStartId(made) ? made : `na-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * How long a New agent's pane made and not listed yet is shown from Herdr's own answer, in main and in the page, at
 * most: longer than the wait for the agent (firstAgentTimeoutMs, 90 s)
 * and the refresh after it, which lists it when no events did.
 */
export const madePaneKeptMs = 120_000;

/**
 * A New agent's pane as Herdr's creation answered it, shown before a snapshot lists it (its machine's connection
 * then). `at`: when the page heard it (ms since 1970); `heard`: how many machine lists the page had then (a list sent
 * after it carries main's own memory of it, madePanes).
 */
export interface MadePane {
  readonly hostId: string;
  readonly connection: number;
  readonly tab: TabInfo | null;
  readonly pane: TopologyPaneInfo;
  readonly at: number;
  readonly heard: number;
}

/**
 * The machines with each made pane a snapshot does not list yet added to their topology from Herdr's own answer (and
 * its new tab), so the window has its row at once; nothing is asked of the machine. `kept`: the made panes still
 * shown. One goes when a snapshot lists it, its machine is on another connection or gone, madePaneKeptMs passed since
 * `at`, or a list main sent after the page heard it (`lists`, the page's count now, above `heard`) no longer carries
 * it in madePanes (main let it go: a later snapshot did not list it, or its connection changed).
 */
export function withMadePanes<
  H extends { readonly id: string; readonly connection?: number; readonly topology: SessionTopology | null; readonly madePanes?: readonly string[] },
>(hosts: readonly H[], made: readonly MadePane[], nowMs: number, lists: number): { readonly hosts: H[]; readonly kept: MadePane[] } {
  const kept: MadePane[] = [];
  const next = hosts.map((host) => {
    const topology = host.topology;
    const mine = made.filter(
      (entry) =>
        entry.hostId === host.id &&
        (host.connection === undefined || host.connection === entry.connection) &&
        nowMs - entry.at < madePaneKeptMs &&
        (lists <= entry.heard || (host.madePanes ?? []).includes(entry.pane.paneID)),
    );
    if (topology === null || mine.length === 0) return host;
    let panes = topology.panes;
    let tabs = topology.tabs;
    for (const entry of mine) {
      if (panes.some((pane) => pane.paneID === entry.pane.paneID)) continue;
      if (!topology.workspaces.some((workspace) => workspace.workspaceID === entry.pane.workspaceID)) continue;
      const tab = entry.tab;
      if (!tabs.some((candidate) => candidate.tabID === entry.pane.tabID)) {
        if (tab === null || tab.tabID !== entry.pane.tabID) continue;
        tabs = [...tabs, tab];
      }
      panes = [...panes, entry.pane];
      kept.push(entry);
    }
    return panes === topology.panes ? host : { ...host, topology: { ...topology, panes, tabs } };
  });
  return { hosts: next, kept };
}
