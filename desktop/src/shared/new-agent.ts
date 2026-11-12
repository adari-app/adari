// New agent's sheet (App/CompanionSidebarNewSheet.swift, CompanionNewAgentEmpty.swift):
// which workspaces it can start in (every answering machine's,
// in the sidebar's order), the folder it prefills (the workspace's own: its
// first pane's folder) and suggests (the folders its panes are in), the kinds
// (every agent the machine's Herdr can start, any other kind the Mac's
// agents.json names, and a shell) with what each will run, and the kind you
// last picked.

import type { SessionTopology } from "../main/herdr/wire";
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
