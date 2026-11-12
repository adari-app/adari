// What a pane action is for: the pane as you saw it in the tab the window
// shows, as the bound Send is for the pane as you saw it (send-binding.ts).
// The page takes it from the machine's snapshot and the tab's layout it shows
// when you act (and keeps it through
// the close confirmation, or from a divider drag's start); the main process
// carries the action out only while the sender's window still shows that pane
// in that tab and a snapshot and layout read right before the request still
// show the same: the same connection, workspace, tab, terminal and agent (and,
// for a divider, the same split at the same place). Pure, shared by both sides.
//
// The connection is the machine's
// entry (incarnation) and the command connection its snapshot came on (the
// SSH transport's epoch), checked after the fresh reads and again right before
// the request, besides the failed-snapshot counter; a session you saw must
// still be reported; a divider is its whole split as shown, its direction and
// both sides' panes in order, in the sender's shown layout and in Herdr's read
// now.

import type { AgentInfo, SessionTopology, TopologyPaneInfo } from "../main/herdr/wire";
import { tileTree, splitPath, splitShape, treeShape, type PaneLayout, type TileNode } from "./pane-layout";
import { agentKind, agentSession } from "./send-binding";

export interface PaneBinding {
  /** The machine's connection the page saw it on (HostView.connection; 0: none seen): a new number after a failed snapshot. */
  readonly connection: number;
  /** The machine's entry in the sidebar (HostView.incarnation; 0: none seen): a new number when it is added again. */
  readonly incarnation: number;
  /** The command connection its snapshot came on (HostView.epoch; null: not known, so refused). */
  readonly epoch: number | null;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  /** The terminal in the pane ("" when the snapshot named none). */
  readonly terminalID: string;
  /** The agent running there, lowercased ("claude"); null for a shell. */
  readonly agent: string | null;
  /** The agent's Herdr session; null when not reported (then not compared). A session given here must still be reported. */
  readonly session: string | null;
}

/** A divider's split as the tab showed it: its path from the root (false the first side, true the second). */
export type SplitPath = readonly boolean[];

const maxField = 512;
const maxPath = 64;

const isText = (value: unknown, empty = false): value is string =>
  typeof value === "string" && (empty || value.length > 0) && value.length <= maxField;
const isOptionalText = (value: unknown): value is string | null => value === null || isText(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function isPaneBinding(value: unknown): value is PaneBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isCount(v["connection"]) &&
    isCount(v["incarnation"]) &&
    (v["epoch"] === null || isCount(v["epoch"])) &&
    isText(v["workspaceId"]) &&
    isText(v["tabId"]) &&
    isText(v["paneId"]) &&
    isText(v["terminalID"], true) &&
    isOptionalText(v["agent"]) &&
    isOptionalText(v["session"])
  );
}

export function isSplitPath(value: unknown): value is SplitPath {
  return Array.isArray(value) && value.length <= maxPath && value.every((step) => typeof step === "boolean");
}

/** The longest split shape taken from the page (a few panes' ids and splits; up to 4 panes are tiled). */
const maxShape = 8_192;

export function isSplitShape(value: unknown): value is SplitShape {
  return typeof value === "string" && value.length > 0 && value.length <= maxShape;
}

/** What a machine shows as the page has it (HostView fits). */
export interface BindingHost {
  readonly connection?: number;
  readonly incarnation?: number;
  readonly epoch?: number | null;
  readonly topology: SessionTopology | null;
}

/** The binding for an action on `paneId` as the window shows it: the machine's snapshot and the tab's layout; null when they do not show it. */
export function paneBindingOf(host: BindingHost, layout: PaneLayout | null, paneId: string): PaneBinding | null {
  const pane = host.topology?.panes.find((candidate) => candidate.paneID === paneId) ?? null;
  if (pane === null || layout === null || pane.tabID !== layout.tabId || !layout.panes.some((candidate) => candidate.paneId === paneId)) return null;
  const agent = host.topology?.agents.find((candidate) => candidate.paneID === paneId) ?? null;
  return {
    connection: host.connection ?? 0,
    incarnation: host.incarnation ?? 0,
    epoch: host.epoch ?? null,
    workspaceId: pane.workspaceID,
    tabId: layout.tabId,
    paneId,
    terminalID: pane.terminalID ?? "",
    agent: agentKind(agent, pane),
    session: agentSession(agent),
  };
}

/**
 * The binding for an action on `paneId` as the sidebar shows
 * it (a row's Close pane, Rename…): the machine's snapshot alone, its tab the
 * snapshot's; null when the snapshot does not list it. The main process checks
 * it as it checks a tile's (bindingRefusal), without asking that the window
 * show the pane in a tile.
 */
export function rowBindingOf(host: BindingHost, paneId: string): PaneBinding | null {
  const pane = host.topology?.panes.find((candidate) => candidate.paneID === paneId) ?? null;
  if (pane === null) return null;
  const agent = host.topology?.agents.find((candidate) => candidate.paneID === paneId) ?? null;
  return {
    connection: host.connection ?? 0,
    incarnation: host.incarnation ?? 0,
    epoch: host.epoch ?? null,
    workspaceId: pane.workspaceID,
    tabId: pane.tabID,
    paneId,
    terminalID: pane.terminalID ?? "",
    agent: agentKind(agent, pane),
    session: agentSession(agent),
  };
}

/** A divider's path in the layout shown; null when Herdr's tree does not place it (read off the rects alone, or gone). */
export function splitPathOf(layout: PaneLayout, splitId: string): SplitPath | null {
  const tree = tileTree(layout);
  return tree === null ? null : splitPath(tree, splitId);
}

/**
 * A divider's whole split as the layout shows it: its id,
 * direction and both sides' panes in order, nested splits included
 * (pane-layout splitShape); null when the tree has no such split.
 */
export type SplitShape = string;

export function splitShapeOf(layout: PaneLayout, splitId: string): SplitShape | null {
  const tree = tileTree(layout);
  return tree === null ? null : splitShape(tree, splitId);
}

/**
 * What a workspace's Rename workspace… is for: the machine's
 * connection as the page saw it (as a pane binding's) and the workspace.
 */
export interface WorkspaceBinding {
  readonly connection: number;
  readonly incarnation: number;
  readonly epoch: number | null;
  readonly workspaceId: string;
}

export function isWorkspaceBinding(value: unknown): value is WorkspaceBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isCount(v["connection"]) && isCount(v["incarnation"]) && (v["epoch"] === null || isCount(v["epoch"])) && isText(v["workspaceId"]);
}

/** The binding for a workspace as the sidebar shows it (null: the snapshot does not list it). */
export function workspaceBindingOf(host: BindingHost, workspaceId: string): WorkspaceBinding | null {
  if (host.topology?.workspaces.some((workspace) => workspace.workspaceID === workspaceId) !== true) return null;
  return { connection: host.connection ?? 0, incarnation: host.incarnation ?? 0, epoch: host.epoch ?? null, workspaceId };
}

/** Why the page will not send a workspace's rename (null: it may): its machine's connection now, the workspace in its snapshot. */
export function workspaceRefusal(expected: WorkspaceBinding, host: BindingHost & { readonly state: string }): string | null {
  const connection = connectionRefusal(expected, {
    connection: host.state === "connected" ? (host.connection ?? 0) : null,
    incarnation: host.incarnation ?? 0,
    epoch: host.epoch ?? null,
  });
  if (connection !== null) return connection;
  return host.topology?.workspaces.some((workspace) => workspace.workspaceID === expected.workspaceId) === true ? null : bindingTexts.workspaceGone;
}

/** The machine's connection as the main process has it now (read again right before the request). */
export interface ConnectionNow {
  /** The machine's connection while it answers (null: not answering, or not listed). */
  readonly connection: number | null;
  /** Its entry in the sidebar (null: not listed). */
  readonly incarnation: number | null;
  /** The command connection a request sent now goes on (null: none held). */
  readonly epoch: number | null;
}

/** What the main process reads right before acting: the connection, a fresh snapshot and the tab's layout read now. */
export interface BindingNow extends ConnectionNow {
  readonly topology: SessionTopology | null;
  readonly layout: PaneLayout;
}

/** The refusals, as the toast puts them after "Not closed: " (or zoomed, split, resized). */
export const bindingTexts = {
  notShown: "That pane is not shown in this window.",
  reconnected: "The machine reconnected since the pane was shown.",
  readded: "The machine was removed and added again since the pane was shown.",
  machineGone: "That machine is no longer listed.",
  connectionClosed: "The machine's connection closed while the pane was checked.",
  notAnswering: "The machine is not answering, so the pane could not be checked.",
  gone: "That pane is no longer listed.",
  moved: "That pane is in another tab now.",
  terminal: "That pane runs another terminal now.",
  agentLeft: (kind: string) => `The ${kind} agent in that pane has left.`,
  agentCame: (kind: string) => `That pane runs ${kind} now.`,
  agentReplaced: (now: string, was: string) => `That pane runs ${now} now, not ${was}.`,
  session: (kind: string) => `That pane runs another ${kind} session now.`,
  sessionUnreported: (kind: string) => `That pane's ${kind} session is no longer reported, so it could not be checked.`,
  layout: "Herdr's layout of the tab changed since it was shown.",
  divider: "Herdr's layout no longer has that divider where it was shown.",
  workspaceGone: "That workspace is no longer listed.",
} as const;

/**
 * Why the machine's connection is not the one `expected` was taken on (null:
 * it is): the same entry, the same command connection (its epoch, so a
 * reconnect between snapshots counts), and no failed snapshot since.
 */
export function connectionRefusal(expected: Pick<PaneBinding, "connection" | "incarnation" | "epoch">, now: ConnectionNow): string | null {
  if (now.incarnation === null) return bindingTexts.machineGone;
  if (now.incarnation !== expected.incarnation) return bindingTexts.readded;
  if (now.connection === null) return bindingTexts.notAnswering;
  if (now.epoch === null) return bindingTexts.connectionClosed;
  if (expected.epoch === null || now.epoch !== expected.epoch || now.connection !== expected.connection) return bindingTexts.reconnected;
  return null;
}

/** Why the pane is no longer what `expected` says by what was read now (null: it is). */
export function bindingRefusal(expected: PaneBinding, now: BindingNow): string | null {
  const connection = connectionRefusal(expected, now);
  if (connection !== null) return connection;
  const pane = paneRefusal(expected, now.topology);
  if (pane !== null) return pane;
  if (now.layout.tabId !== expected.tabId || !now.layout.panes.some((candidate) => candidate.paneId === expected.paneId)) return bindingTexts.layout;
  return null;
}

/**
 * Why the page will not send a row's action bound to `expected`
 * (null: it may): the machine as the page has it now (its connection, its
 * entry, its command connection, answering or not) and the pane in its last
 * snapshot. The main process checks again on a fresh read before sending.
 */
export function rowRefusal(expected: PaneBinding, host: BindingHost & { readonly state: string }): string | null {
  const connection = connectionRefusal(expected, {
    connection: host.state === "connected" ? (host.connection ?? 0) : null,
    incarnation: host.incarnation ?? 0,
    epoch: host.epoch ?? null,
  });
  return connection ?? paneRefusal(expected, host.topology);
}

/** Why the pane in `topology` is no longer the one `expected` names (its place, terminal, agent and session; null: it is). */
function paneRefusal(expected: PaneBinding, topology: SessionTopology | null): string | null {
  const pane: TopologyPaneInfo | null = topology?.panes.find((candidate) => candidate.paneID === expected.paneId) ?? null;
  if (pane === null) return bindingTexts.gone;
  if (pane.workspaceID !== expected.workspaceId || pane.tabID !== expected.tabId) return bindingTexts.moved;
  if ((pane.terminalID ?? "") !== expected.terminalID) return bindingTexts.terminal;
  const agent: AgentInfo | null = topology?.agents.find((candidate) => candidate.paneID === expected.paneId) ?? null;
  const kind = agentKind(agent, pane);
  if (kind !== expected.agent) {
    if (kind === null) return bindingTexts.agentLeft(expected.agent!);
    return expected.agent === null ? bindingTexts.agentCame(kind) : bindingTexts.agentReplaced(kind, expected.agent);
  }
  // A session you saw must still be reported, and be the same; a binding taken
  // when the snapshot reported none is not compared (Herdr may report it later).
  const session = agentSession(agent);
  if (expected.session !== null && session === null) return bindingTexts.sessionUnreported(kind ?? "agent");
  if (expected.session !== null && session !== expected.session) return bindingTexts.session(kind ?? "agent");
  return null;
}

/**
 * Whether `layout` (the sender's shown layout, or Herdr's read now) has the
 * divider as it was dragged: the split `splitId` at `path`, of the same shape
 * (its direction and both sides' panes in order, nested splits included; fix
 * pass 3, 1c), with the bound pane on its first side. A missing shape never stands.
 */
export function dividerStands(layout: PaneLayout, splitId: string, path: SplitPath, shape: SplitShape | undefined, paneId: string): boolean {
  const tree = tileTree(layout);
  const found = tree === null ? null : splitPath(tree, splitId);
  if (tree === null || found === null || found.length !== path.length || found.some((step, index) => step !== path[index])) return false;
  let node: TileNode = tree;
  for (const step of path) {
    if (node.type !== "split") return false;
    node = step ? node.second : node.first;
  }
  if (node.type !== "split" || node.id !== splitId || shape === undefined || treeShape(node) !== shape) return false;
  const panes = (side: TileNode): string[] => (side.type === "pane" ? [side.paneId] : [...panes(side.first), ...panes(side.second)]);
  return panes(node.first).includes(paneId);
}
