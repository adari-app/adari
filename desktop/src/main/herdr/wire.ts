// Protocol 22 wire types and decoders, ported from HerdrKit
// (Sources/HerdrKit/Wire.swift): the same fields, the same snake_case keys, the
// same required/optional split, so a reply decodes here exactly when it decodes
// in the Swift app. Only what the desktop shell reads is ported (agents, the
// session snapshot, errors); the rest of Wire.swift follows when a screen needs it.

import { asObject, DecodingError, opt, parseJsonLine, req, type JsonObject } from "./decode";
import type { CellRect, LayoutPane, LayoutSplit, LayoutTreeNode, PaneLayout } from "../../shared/pane-layout";
import type { WideInt } from "../../shared/wide-int";

// MARK: errors

/** A server `error` object (Wire.swift `APIError`). */
export class APIError extends Error {
  constructor(
    readonly code: string,
    readonly serverMessage: string,
  ) {
    super(`${code}: ${serverMessage}`);
    this.name = "APIError";
  }
}

// MARK: agents

export interface ComposerEvidence {
  readonly provenance?: string;
  readonly region?: string;
  readonly cursor?: string;
  readonly style?: string;
  readonly frameStable?: boolean;
}

export interface ComposerState {
  readonly state?: string;
  readonly attemptID?: string;
  readonly evidence?: ComposerEvidence;
}

export interface CompletedTurn {
  readonly turn?: WideInt;
  readonly turnEpoch?: WideInt;
  readonly completedUnixMs?: WideInt;
}

export interface AgentArchivedInfo {
  readonly at?: string;
  readonly by?: string;
  readonly reason?: string;
}

export interface AgentSessionInfo {
  readonly source: string;
  readonly agent: string;
  readonly kind: string;
  readonly value: string;
}

/**
 * Never from Herdr. A session the app found by folder for a herdr-core Claude or Codex pane whose argv names none
 * (src/main/herdr/core-session-finder.ts), or its refusal: the run it was found for (`foundBy`) and the folder a
 * transcript was proved in (`foundIn`). Carried beside `agentSession` (which stays Herdr's or the argv's), so no
 * binding, Send, Stop or Restart reads it as the pane's identity; Chat, Away, Changes and search take it through
 * shared/chat/core-pane-session.ts.
 */
export interface CoreFoundSession extends AgentSessionInfo {
  readonly foundBy: string;
  readonly foundIn?: string;
}

export interface AgentSessionTransferOmissions {
  readonly toolRecords: WideInt;
  readonly reasoningRecords: WideInt;
  readonly systemRecords: WideInt;
  readonly attachmentRecords: WideInt;
  readonly metadataRecords: WideInt;
  readonly unsupportedBlocks: WideInt;
  readonly sidechainRecords: WideInt;
}

export interface AgentSessionTransferInfo {
  readonly id: string;
  /** "claude", "codex", "omp", or a value this build does not know (kept as is). */
  readonly source: string;
  readonly target: string;
  readonly targetAccount?: string;
  /** snake_case phase as sent ("verifying_cutover", …); unknown values kept. */
  readonly phase: string;
  readonly messageCount: WideInt;
  readonly omissions: AgentSessionTransferOmissions;
  readonly error?: string;
}

/** One agent (Wire.swift `AgentInfo`). `paneID` is the only required field. */
export interface AgentInfo {
  readonly agent?: string;
  readonly agentStatus?: string;
  readonly inputPending?: boolean;
  readonly inputPromptKind?: string;
  readonly name?: string;
  readonly paneID: string;
  readonly tabID?: string;
  readonly workspaceID?: string;
  readonly terminalID?: string;
  readonly terminalTitleStripped?: string;
  readonly cwd?: string;
  readonly focused?: boolean;
  readonly interactiveReady?: boolean;
  readonly launchPending?: boolean;
  readonly composer?: ComposerState;
  readonly revision?: WideInt;
  readonly stateChangeSeq?: WideInt;
  readonly statusSinceUnixMs?: WideInt;
  readonly turn?: WideInt;
  readonly turnEpoch?: WideInt;
  readonly lastCompletedTurn?: CompletedTurn;
  readonly completionSeq?: WideInt;
  readonly agentSession?: AgentSessionInfo;
  /** A herdr-core pane's session found by folder (CoreFoundSession); never from Herdr. */
  readonly coreFound?: CoreFoundSession;
  readonly machineID?: string;
  readonly reachability?: string;
  readonly lastKnownStatus?: string;
  readonly archived?: AgentArchivedInfo;
  readonly account?: string;
  readonly accountConfigDir?: string;
  readonly accountUnresolved?: boolean;
  readonly sessionTransfer?: AgentSessionTransferInfo;
}

function decodeComposer(o: JsonObject, path: string): ComposerState {
  return {
    state: opt.string(o, "state", path),
    attemptID: opt.string(o, "attempt_id", path),
    evidence: opt.object(o, "evidence", path, (e, p) => ({
      provenance: opt.string(e, "provenance", p),
      region: opt.string(e, "region", p),
      cursor: opt.string(e, "cursor", p),
      style: opt.string(e, "style", p),
      frameStable: opt.bool(e, "frame_stable", p),
    })),
  };
}

function decodeSessionTransfer(o: JsonObject, path: string): AgentSessionTransferInfo {
  const omissions = req.object(o, "omissions", path);
  const op = `${path}.omissions`;
  return {
    id: req.string(o, "id", path),
    source: req.string(o, "source", path),
    target: req.string(o, "target", path),
    targetAccount: opt.string(o, "target_account", path),
    phase: req.string(o, "phase", path),
    messageCount: req.uint64(o, "message_count", path),
    omissions: {
      toolRecords: opt.uint64(omissions, "tool_records", op) ?? 0,
      reasoningRecords: opt.uint64(omissions, "reasoning_records", op) ?? 0,
      systemRecords: opt.uint64(omissions, "system_records", op) ?? 0,
      attachmentRecords: opt.uint64(omissions, "attachment_records", op) ?? 0,
      metadataRecords: opt.uint64(omissions, "metadata_records", op) ?? 0,
      unsupportedBlocks: opt.uint64(omissions, "unsupported_blocks", op) ?? 0,
      sidechainRecords: opt.uint64(omissions, "sidechain_records", op) ?? 0,
    },
    error: opt.string(o, "error", path),
  };
}

export function decodeAgentInfo(value: unknown, path = "agent"): AgentInfo {
  const o = asObject(value, path);
  return {
    agent: opt.string(o, "agent", path),
    agentStatus: opt.string(o, "agent_status", path),
    inputPending: opt.bool(o, "input_pending", path),
    inputPromptKind: opt.string(o, "input_prompt_kind", path),
    name: opt.string(o, "name", path),
    paneID: req.string(o, "pane_id", path),
    tabID: opt.string(o, "tab_id", path),
    workspaceID: opt.string(o, "workspace_id", path),
    terminalID: opt.string(o, "terminal_id", path),
    terminalTitleStripped: opt.string(o, "terminal_title_stripped", path),
    cwd: opt.string(o, "cwd", path),
    focused: opt.bool(o, "focused", path),
    interactiveReady: opt.bool(o, "interactive_ready", path),
    launchPending: opt.bool(o, "launch_pending", path),
    composer: opt.object(o, "composer", path, decodeComposer),
    revision: opt.int64(o, "revision", path),
    stateChangeSeq: opt.uint64(o, "state_change_seq", path),
    statusSinceUnixMs: opt.uint64(o, "status_since_unix_ms", path),
    turn: opt.int64(o, "turn", path),
    turnEpoch: opt.uint64(o, "turn_epoch", path),
    lastCompletedTurn: opt.object(o, "last_completed_turn", path, (t, p) => ({
      turn: opt.int64(t, "turn", p),
      turnEpoch: opt.uint64(t, "turn_epoch", p),
      completedUnixMs: opt.int64(t, "completed_unix_ms", p),
    })),
    completionSeq: opt.uint64(o, "completion_seq", path),
    agentSession: opt.object(o, "agent_session", path, (s, p) => ({
      source: req.string(s, "source", p),
      agent: req.string(s, "agent", p),
      kind: req.string(s, "kind", p),
      value: req.string(s, "value", p),
    })),
    // Written by the core bridge only (CoreTUIWire.agent).
    coreFound: opt.object(o, "core_found", path, (s, p) => ({
      source: req.string(s, "source", p),
      agent: req.string(s, "agent", p),
      kind: req.string(s, "kind", p),
      value: req.string(s, "value", p),
      foundBy: req.string(s, "found_by", p),
      foundIn: opt.string(s, "found_in", p),
    })),
    machineID: opt.string(o, "machine_id", path),
    reachability: opt.string(o, "reachability", path),
    lastKnownStatus: opt.string(o, "last_known_status", path),
    archived: opt.object(o, "archived", path, (a, p) => ({
      at: opt.string(a, "at", p),
      by: opt.string(a, "by", p),
      reason: opt.string(a, "reason", p),
    })),
    account: opt.string(o, "account", path),
    accountConfigDir: opt.string(o, "account_config_dir", path),
    accountUnresolved: opt.bool(o, "account_unresolved", path),
    sessionTransfer: opt.object(o, "session_transfer", path, decodeSessionTransfer),
  };
}

/** AgentInfo.id: the pane id, else the terminal id, else the name (archived agents have no pane). */
export function agentIdentity(agent: AgentInfo): string {
  if (agent.paneID !== "") return agent.paneID;
  return agent.terminalID ?? agent.name ?? agent.paneID;
}

/** AgentInfo.displayName: the assigned name, else the stripped terminal title, else the pane id. */
export function agentDisplayName(agent: AgentInfo): string {
  return agent.name ?? agent.terminalTitleStripped ?? agent.paneID;
}

/** AgentInfo.isAwaitingMenuInput: blocked, or showing a menu that needs an on-screen choice. */
export function isAwaitingMenuInput(agent: AgentInfo): boolean {
  return agent.agentStatus === "blocked" || agent.inputPending === true;
}

export function isArchived(agent: AgentInfo): boolean {
  return agent.archived !== undefined;
}

// MARK: session topology

export interface WorkspaceInfo {
  readonly workspaceID: string;
  readonly number: WideInt;
  readonly label: string;
  readonly focused: boolean;
  readonly paneCount: WideInt;
  readonly tabCount: WideInt;
  readonly activeTabID: string;
  readonly agentStatus: string;
}

export interface TabInfo {
  readonly tabID: string;
  readonly workspaceID: string;
  readonly number: WideInt;
  readonly label: string;
  readonly focused: boolean;
  readonly paneCount: WideInt;
  readonly agentStatus: string;
}

export interface TopologyPaneInfo {
  readonly paneID: string;
  readonly terminalID: string;
  readonly workspaceID: string;
  readonly tabID: string;
  readonly focused: boolean;
  readonly cwd?: string;
  readonly foregroundCWD?: string;
  readonly label?: string;
  readonly agent?: string;
  readonly title?: string;
  readonly terminalTitleStripped?: string;
  readonly displayAgent?: string;
  readonly agentStatus: string;
  readonly revision: WideInt;
}

/** `session.snapshot`: every workspace, tab, pane and agent in one atomic view. */
export interface SessionTopology {
  readonly version: string;
  readonly protocolVersion: number;
  readonly focusedWorkspaceID?: string;
  readonly focusedTabID?: string;
  readonly focusedPaneID?: string;
  readonly workspaces: readonly WorkspaceInfo[];
  readonly tabs: readonly TabInfo[];
  readonly panes: readonly TopologyPaneInfo[];
  readonly agents: readonly AgentInfo[];
}

export function decodeWorkspaceInfo(value: unknown, path = "workspace"): WorkspaceInfo {
  const o = asObject(value, path);
  return {
    workspaceID: req.string(o, "workspace_id", path),
    number: req.int64(o, "number", path),
    label: req.string(o, "label", path),
    focused: req.bool(o, "focused", path),
    paneCount: req.int64(o, "pane_count", path),
    tabCount: req.int64(o, "tab_count", path),
    activeTabID: req.string(o, "active_tab_id", path),
    agentStatus: req.string(o, "agent_status", path),
  };
}

export function decodeTabInfo(value: unknown, path = "tab"): TabInfo {
  const o = asObject(value, path);
  return {
    tabID: req.string(o, "tab_id", path),
    workspaceID: req.string(o, "workspace_id", path),
    number: req.int64(o, "number", path),
    label: req.string(o, "label", path),
    focused: req.bool(o, "focused", path),
    paneCount: req.int64(o, "pane_count", path),
    agentStatus: req.string(o, "agent_status", path),
  };
}

export function decodeTopologyPaneInfo(value: unknown, path = "pane"): TopologyPaneInfo {
  const o = asObject(value, path);
  return {
    paneID: req.string(o, "pane_id", path),
    terminalID: req.string(o, "terminal_id", path),
    workspaceID: req.string(o, "workspace_id", path),
    tabID: req.string(o, "tab_id", path),
    focused: req.bool(o, "focused", path),
    cwd: opt.string(o, "cwd", path),
    foregroundCWD: opt.string(o, "foreground_cwd", path),
    label: opt.string(o, "label", path),
    agent: opt.string(o, "agent", path),
    title: opt.string(o, "title", path),
    terminalTitleStripped: opt.string(o, "terminal_title_stripped", path),
    displayAgent: opt.string(o, "display_agent", path),
    agentStatus: req.string(o, "agent_status", path),
    revision: req.uint64(o, "revision", path),
  };
}

/** TopologyPaneInfo.effectiveCWD: the foreground cwd, else the cwd; empty reads as none. */
export function effectiveCWD(pane: TopologyPaneInfo): string | undefined {
  if (pane.foregroundCWD !== undefined && pane.foregroundCWD !== "") return pane.foregroundCWD;
  return pane.cwd !== undefined && pane.cwd !== "" ? pane.cwd : undefined;
}

/** TopologyPaneInfo.isAgent: Herdr names an agent for the pane. */
export function isAgentPane(pane: TopologyPaneInfo): boolean {
  return pane.agent !== undefined && pane.agent !== "";
}

export function decodeSessionTopology(value: unknown, path = "snapshot"): SessionTopology {
  const o = asObject(value, path);
  return {
    version: req.string(o, "version", path),
    protocolVersion: req.uint32(o, "protocol", path),
    focusedWorkspaceID: opt.string(o, "focused_workspace_id", path),
    focusedTabID: opt.string(o, "focused_tab_id", path),
    focusedPaneID: opt.string(o, "focused_pane_id", path),
    workspaces: req.array(o, "workspaces", path, decodeWorkspaceInfo),
    tabs: req.array(o, "tabs", path, decodeTabInfo),
    panes: req.array(o, "panes", path, decodeTopologyPaneInfo),
    agents: req.array(o, "agents", path, decodeAgentInfo),
  };
}

// MARK: envelopes

/**
 * Decodes one reply line the way HerdrClient.decodeResult does: a line that
 * decodes as `{ "error": { "code", "message" } }` throws that APIError;
 * otherwise `result` is required and handed to `decode`.
 */
export function decodeReply<R>(line: string, decode: (result: unknown, path: string) => R): R {
  const root = asObject(parseJsonLine(line), "$");
  const error = root["error"];
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const e = error as JsonObject;
    if (typeof e["code"] === "string" && typeof e["message"] === "string") {
      throw new APIError(e["code"], e["message"]);
    }
  }
  opt.string(root, "id", "$");
  // Swift's keyed decode of `result` needs the key; a null value still reaches
  // the result type's decoder (JSONNull accepts it, an object type refuses it).
  if (!Object.prototype.hasOwnProperty.call(root, "result")) {
    throw new DecodingError("$.result", "missing result");
  }
  return decode(root["result"], "$.result");
}

/** `tab.create`'s result (Wire.swift TabCreation): the tab and its root pane. */
export interface TabCreation {
  readonly tab: TabInfo;
  readonly rootPane: TopologyPaneInfo;
}

export function decodeTabCreationResult(value: unknown, path: string): TabCreation {
  const o = asObject(value, path);
  return {
    tab: decodeTabInfo(req.object(o, "tab", path), `${path}.tab`),
    rootPane: decodeTopologyPaneInfo(req.object(o, "root_pane", path), `${path}.root_pane`),
  };
}

/** `workspace.create`'s result (Wire.swift WorkspaceCreation): the workspace, its first tab and that tab's shell pane. */
export interface WorkspaceCreation {
  readonly workspace: WorkspaceInfo;
  readonly tab: TabInfo;
  readonly rootPane: TopologyPaneInfo;
}

export function decodeWorkspaceCreationResult(value: unknown, path: string): WorkspaceCreation {
  const o = asObject(value, path);
  return {
    workspace: decodeWorkspaceInfo(req.object(o, "workspace", path), `${path}.workspace`),
    tab: decodeTabInfo(req.object(o, "tab", path), `${path}.tab`),
    rootPane: decodeTopologyPaneInfo(req.object(o, "root_pane", path), `${path}.root_pane`),
  };
}

/** `agent.start`'s result: the agent started. */
export function decodeAgentStartedResult(value: unknown, path: string): AgentInfo {
  return decodeAgentInfo(req.object(asObject(value, path), "agent", path), `${path}.agent`);
}

export function decodeAgentListResult(value: unknown, path: string): AgentInfo[] {
  return req.array(asObject(value, path), "agents", path, decodeAgentInfo);
}

export function decodeSessionSnapshotResult(value: unknown, path: string): SessionTopology {
  return decodeSessionTopology(req.object(asObject(value, path), "snapshot", path), `${path}.snapshot`);
}

/** `JSONNull` in HerdrKit: any result is accepted and ignored. */
export function ignoreResult(): void {}

// MARK: pane layout

function decodeCellRect(o: JsonObject, path: string): CellRect {
  return {
    x: req.uint32(o, "x", path),
    y: req.uint32(o, "y", path),
    width: req.uint32(o, "width", path),
    height: req.uint32(o, "height", path),
  };
}

function decodeRatio(o: JsonObject, key: string, path: string): number {
  const value = opt.number(o, key, path);
  if (value === undefined) throw new DecodingError(`${path}.${key}`, "missing number");
  return value;
}

/**
 * One tab's layout, as `pane.layout` answers (and `herdr pane layout --pane <id>`
 * prints): `{ area, focused_pane_id, panes: [{ pane_id, rect, focused }],
 * splits: [{ direction, id, ratio, rect }], tab_id, workspace_id, zoomed }`.
 * Rects are in cells. A pane without a rect is refused; `splits` and `zoomed`
 * read as none and false when left out.
 */
export function decodePaneLayout(value: unknown, path = "layout"): PaneLayout {
  const o = asObject(value, path);
  const panes = req.array(o, "panes", path, (entry, p): LayoutPane => {
    const pane = asObject(entry, p);
    return { paneId: req.string(pane, "pane_id", p), focused: opt.bool(pane, "focused", p) ?? false, rect: decodeCellRect(req.object(pane, "rect", p), `${p}.rect`) };
  });
  const splits =
    opt.array(o, "splits", path, (entry, p): LayoutSplit => {
      const split = asObject(entry, p);
      return {
        id: req.string(split, "id", p),
        direction: req.string(split, "direction", p),
        ratio: decodeRatio(split, "ratio", p),
        rect: decodeCellRect(req.object(split, "rect", p), `${p}.rect`),
      };
    }) ?? [];
  return {
    tabId: req.string(o, "tab_id", path),
    workspaceId: req.string(o, "workspace_id", path),
    area: decodeCellRect(req.object(o, "area", path), `${path}.area`),
    focusedPaneId: opt.string(o, "focused_pane_id", path) ?? null,
    panes,
    splits,
    zoomed: opt.bool(o, "zoomed", path) ?? false,
  };
}

/** `pane.split`'s result: `{ type: "pane_info", pane }`, the new pane (HerdrClient.splitPane). */
export function decodePaneInfoResult(value: unknown, path: string): TopologyPaneInfo {
  return decodeTopologyPaneInfo(req.object(asObject(value, path), "pane", path), `${path}.pane`);
}

/** `pane.layout`'s result: `{ type: "pane_layout", layout }`. */
export function decodePaneLayoutResult(value: unknown, path: string): PaneLayout {
  return decodePaneLayout(req.object(asObject(value, path), "layout", path), `${path}.layout`);
}

/** What `layout.set_split_ratio` answers (Herdr 0.9.5's LayoutDescription, the parts the app reads). */
export interface SplitRatioLayout {
  readonly tabId: string;
  readonly workspaceId: string;
  readonly zoomed: boolean;
  readonly focusedPaneId: string;
  readonly root: LayoutTreeNode;
}

/** Deeper than this is not a layout (a tab of 4 panes is 2 deep). */
const maxLayoutDepth = 64;

function decodeLayoutNode(value: unknown, path: string, depth: number): LayoutTreeNode {
  if (depth > maxLayoutDepth) throw new DecodingError(path, "layout tree too deep");
  const o = asObject(value, path);
  const type = req.string(o, "type", path);
  if (type === "pane") return { type: "pane", paneId: opt.string(o, "pane_id", path) ?? null };
  if (type === "split") {
    return {
      type: "split",
      direction: req.string(o, "direction", path),
      ratio: decodeRatio(o, "ratio", path),
      first: decodeLayoutNode(req.object(o, "first", path), `${path}.first`, depth + 1),
      second: decodeLayoutNode(req.object(o, "second", path), `${path}.second`, depth + 1),
    };
  }
  throw new DecodingError(`${path}.type`, `unknown layout node "${type}"`);
}

/** `layout.set_split_ratio`'s result: `{ type: "layout_split_ratio_set", layout: { workspace_id, tab_id, zoomed, focused_pane_id, root } }`. */
export function decodeSplitRatioResult(value: unknown, path: string): SplitRatioLayout {
  const layout = req.object(asObject(value, path), "layout", path);
  const at = `${path}.layout`;
  return {
    tabId: req.string(layout, "tab_id", at),
    workspaceId: req.string(layout, "workspace_id", at),
    zoomed: opt.bool(layout, "zoomed", at) ?? false,
    focusedPaneId: req.string(layout, "focused_pane_id", at),
    root: decodeLayoutNode(req.object(layout, "root", at), `${at}.root`, 0),
  };
}

/** What `pane.zoom` answers (Herdr 0.9.5's PaneZoomResult, the parts the app reads). */
export interface PaneZoom {
  /** Whether the tab is zoomed now. */
  readonly zoomed: boolean;
  readonly focusedPaneId: string;
  /** The tab's layout after the zoom (a PaneLayoutSnapshot, as pane.layout answers). */
  readonly layout: PaneLayout;
}

/** `pane.zoom`'s result: `{ type: "pane_zoom", zoom: { zoomed, focused_pane_id, layout, … } }`. */
export function decodePaneZoomResult(value: unknown, path: string): PaneZoom {
  const zoom = req.object(asObject(value, path), "zoom", path);
  const at = `${path}.zoom`;
  return {
    zoomed: req.bool(zoom, "zoomed", at),
    focusedPaneId: req.string(zoom, "focused_pane_id", at),
    layout: decodePaneLayout(req.object(zoom, "layout", at), `${at}.layout`),
  };
}

// MARK: pane.read

/** `pane.read`'s text (HerdrClient.swift `PaneTextResult`: only `read.text` is read). */
export function decodePaneTextResult(value: unknown, path: string): string {
  const read = req.object(asObject(value, path), "read", path);
  return req.string(read, "text", `${path}.read`);
}

// MARK: integrations

/** Herdr 0.9.5's IntegrationInfo: an agent integration and its state on the machine. */
export interface IntegrationInfo {
  readonly target: string;
  readonly label: string;
  readonly command: string;
  readonly available: boolean;
  /** IntegrationState: not_installed, current or outdated (any other word is kept as it is and never shown). */
  readonly state: string;
}

function decodeIntegrationInfo(value: unknown, path: string): IntegrationInfo {
  const o = asObject(value, path);
  return {
    target: req.string(o, "target", path),
    label: opt.string(o, "label", path) ?? "",
    command: opt.string(o, "command", path) ?? "",
    available: opt.bool(o, "available", path) ?? false,
    state: req.string(o, "state", path),
  };
}

/**
 * `integration.list`'s result: its IntegrationInfo array, under `integrations` (as agent.list's `agents`); a bare
 * array is read the same. Anything else is a DecodingError (the machine is then taken as not answering it).
 */
export function decodeIntegrationListResult(value: unknown, path: string): IntegrationInfo[] {
  if (Array.isArray(value)) return value.map((entry, index) => decodeIntegrationInfo(entry, `${path}[${index}]`));
  return req.array(asObject(value, path), "integrations", path, decodeIntegrationInfo);
}

/**
 * `integration.install`'s result, Herdr 0.9.5's schema: `{ type: "integration_install", target, details: { messages:
 * string[] } }`, all required (the lines are under `details`). Herdr's lines, each a string. Any other shape is a
 * DecodingError (the click then shows a plain failure line, never a silent success with no lines); so is a reply naming
 * another target than `target`, when one is given.
 */
export function decodeIntegrationInstallResult(value: unknown, path: string, target?: string): string[] {
  const o = asObject(value, path);
  if (req.string(o, "type", path) !== "integration_install") throw new DecodingError(`${path}.type`, "expected integration_install");
  const named = req.string(o, "target", path);
  if (target !== undefined && named !== target) throw new DecodingError(`${path}.target`, "expected the target asked for");
  return req.array(req.object(o, "details", path), "messages", `${path}.details`, (entry, at) => {
    if (typeof entry !== "string") throw new DecodingError(at, "expected string");
    return entry;
  });
}
