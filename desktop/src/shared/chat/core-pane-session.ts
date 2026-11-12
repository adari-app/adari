// Chat for a herdr-core Claude or Codex pane
// whose argv names no session, the iPhone app's rule (HerdrKit
// CorePaneSession.swift, GrokPaneSession.session(for:among:) with
// `followsFolder`) ported rule for rule. herdr-core never names a session, so
// such a pane's is found by its folder, as Grok's and Cursor's panes are:
// - the newest transcript of that agent the one lookup proves this run's
//   (core-folder-lookup.ts), never a session another pane names (excluded);
// - refused, with the ambiguous note, when another pane of the same agent in
//   the same folder (TUI or core, this machine's) names none: never a guess;
// - a terminal on a machine the core added is no pane of this machine's lookup.
// What the finder (src/main/herdr/core-session-finder.ts) proves goes to the
// core and comes back on the pane's agent as `coreFound`, carrying the run it
// was found for (`foundBy`) and the folder it was proved in (`foundIn`). It is
// no name for the folder rule and no agent identity: Send, Stop, Restart and
// the pane's bindings read `agentSession` only, which stays the argv's.
// Readers (Chat, Away, Changes, search) take it through `shownCoreSession`,
// against the latest delivered snapshot, while the finder catches up.

import type { AgentSessionLike } from "./locator";
import { isGrokSessionID, isUsableFolder, maxExcluded, normalisedFolder, sessionRefFromAgentSession, type TranscriptSessionRef } from "./locator";
import { transcriptSessionID, type CoreFolderFormat } from "./core-folder-lookup";
import { isCoreID } from "../core-ids";

/** A session the app found (or refused) for a herdr-core pane (`AgentSessionInfo.foundBy`, `.foundIn`). Never from Herdr. */
export interface CoreFoundSessionLike extends AgentSessionLike {
  /** The run it was found for (`<kind>:<pid>:<created_ms>`, then `:<process start>` for a transcript). */
  readonly foundBy: string;
  /** The folder it was proved in (a transcript's; a refusal has none). */
  readonly foundIn?: string;
}

/** The agents whose herdr-core panes are bound by folder. */
export const coreFolderKinds: readonly CoreFolderFormat[] = ["claude", "codex"];

/** The refusals, and their notes in Grok's and Cursor's words (GrokPaneSession). */
export const claudeAmbiguousKind = "claude-ambiguous";
export const codexAmbiguousKind = "codex-ambiguous";
export const claudeAmbiguousNote = "Two Claude sessions are open in this folder, so Chat can't tell which is this pane's";
export const codexAmbiguousNote = "Two Codex sessions are open in this folder, so Chat can't tell which is this pane's";

/** Whether `session` is a refusal (any agent's: Grok's and Cursor's too). */
export function isAmbiguousSession(session: AgentSessionLike | undefined | null): boolean {
  return session !== undefined && session !== null && ["grok-ambiguous", "cursor-ambiguous", claudeAmbiguousKind, codexAmbiguousKind].includes(session.kind);
}

export function coreRefusalKind(kind: CoreFolderFormat): string {
  return kind === "claude" ? claudeAmbiguousKind : codexAmbiguousKind;
}

/** The parts of a machine's agent the rule reads (wire AgentInfo). */
export interface CoreRuleAgent {
  readonly paneID: string;
  readonly agent?: string;
  readonly agentSession?: AgentSessionLike;
  readonly cwd?: string;
  readonly coreFound?: CoreFoundSessionLike;
}

/** The parts of a machine's pane the rule reads (wire TopologyPaneInfo). */
export interface CoreRulePane {
  readonly paneID: string;
  readonly agent?: string;
  readonly cwd?: string;
  readonly foregroundCWD?: string;
}

/** The terminal address of a core pane id (`hc:t7`, `hc:studio/t7`); undefined for a TUI id, a space, tab or machine group (CoreIDs.address). */
export function corePaneAddress(paneID: string): string | undefined {
  if (!isCoreID(paneID)) return undefined;
  const rest = paneID.slice(3);
  if (rest === "" || rest.startsWith("space:") || rest.startsWith("tab:") || rest === "machine" || rest.startsWith("machine:")) return undefined;
  return rest;
}

/** `studio` in `studio/t7`; undefined for this machine's terminals. */
function machineOf(address: string): string | undefined {
  const slash = address.indexOf("/");
  return slash <= 0 ? undefined : address.slice(0, slash);
}

/** Not a pane of a terminal on a machine the core added (its transcripts are there). */
const isLocal = (paneID: string): boolean => {
  const address = corePaneAddress(paneID);
  return address === undefined || machineOf(address) === undefined;
};

/**
 * A pane of a terminal on a machine this host's core
 * added (`hc:<machine>/…`). Its transcripts are on that machine, and reads go to this host: a folder rule there
 * would follow this host's transcripts of the folder, so such a pane follows only a session it names.
 */
export function isForeignCorePane(paneID: string): boolean {
  return !isLocal(paneID);
}

/** What the rule says of one pane (CorePaneSession.Lookup). */
export type CoreLookup =
  /** Not a herdr-core Claude or Codex pane of this machine, its argv names its session, or no usable folder. */
  | { readonly kind: "none" }
  /** Another pane of the agent in the folder names none (the refusal, unmarked). */
  | { readonly kind: "refused"; readonly session: AgentSessionLike }
  /** The folder to look in, the sessions other panes name skipped (lower-case). */
  | { readonly kind: "folder"; readonly folder: string; readonly format: CoreFolderFormat; readonly excluding: readonly string[] };

/** The agent of a herdr-core pane of this machine bound by folder (`claude`, `codex`), undefined for any other. */
export function coreFolderKind(paneID: string, agents: readonly CoreRuleAgent[], panes: readonly CoreRulePane[]): CoreFolderFormat | undefined {
  const address = corePaneAddress(paneID);
  if (address === undefined || machineOf(address) !== undefined) return undefined;
  const agent = (agents.find((candidate) => candidate.paneID === paneID)?.agent ?? panes.find((candidate) => candidate.paneID === paneID)?.agent)?.toLowerCase();
  return coreFolderKinds.find((kind) => kind === agent);
}

interface RulePane {
  readonly paneID: string;
  readonly kind: string | undefined;
  /** The session it names that Chat can look up (a found one is no name). */
  readonly named: AgentSessionLike | null;
  readonly folder: string | undefined;
}

/**
 * The session id a peer's ref names, for the exclusion (GrokPaneSession.peerSessionID): Claude's and Codex's
 * id, or the UUID their transcript is named by; null when it cannot be told (the rule then refuses).
 */
function peerSessionID(ref: TranscriptSessionRef): string | null {
  if (ref.format !== "claude" && ref.format !== "codex") return null;
  if (ref.lookup.kind === "id") return isGrokSessionID(ref.lookup.id) ? ref.lookup.id.toLowerCase() : null;
  if (ref.lookup.kind === "path") return transcriptSessionID(ref.lookup.path, ref.format)?.toLowerCase() ?? null;
  return null;
}

/**
 * The rule for `paneID` among the machine's agents and panes, TUI and core (CorePaneSession.lookup): each Claude
 * and Codex pane read as one that follows its folder; a found session is no name.
 */
export function coreLookup(paneID: string, agents: readonly CoreRuleAgent[], panes: readonly CoreRulePane[]): CoreLookup {
  const none: CoreLookup = { kind: "none" };
  const kind = coreFolderKind(paneID, agents, panes);
  if (kind === undefined) return none;
  const pane = (id: string, agent: CoreRuleAgent | undefined): RulePane => {
    const topology = panes.find((candidate) => candidate.paneID === id);
    // What Herdr or the argv names for the pane: the first of its agent entries that names one Chat can look up.
    const session = agents.find((candidate) => candidate.paneID === id && candidate.agentSession !== undefined)?.agentSession;
    const named = session !== undefined && !("foundBy" in session) && sessionRefFromAgentSession(session) !== null ? session : null;
    const folder = [agent?.cwd, topology?.foregroundCWD, topology?.cwd]
      .filter((value): value is string => value !== undefined && value !== "")
      .map(normalisedFolder)
      .find(isUsableFolder);
    return { paneID: id, kind: (agent?.agent ?? topology?.agent)?.toLowerCase(), named, folder };
  };
  const me = pane(
    paneID,
    agents.find((candidate) => candidate.paneID === paneID),
  );
  // Its argv names its session (a core pane is named no other way): as today.
  if (me.named !== null) return none;
  const seen = new Set([paneID]);
  const others: RulePane[] = [];
  for (const agent of agents) {
    if (!isLocal(agent.paneID) || seen.has(agent.paneID)) continue;
    seen.add(agent.paneID);
    others.push(pane(agent.paneID, agent));
  }
  // An agent pane the snapshot shows with no agent entry names none.
  for (const other of panes) {
    if (other.agent === undefined || other.agent === "" || !isLocal(other.paneID) || seen.has(other.paneID)) continue;
    seen.add(other.paneID);
    others.push(pane(other.paneID, undefined));
  }
  const folder = me.folder;
  if (folder === undefined) return none;
  const refused: CoreLookup = { kind: "refused", session: { source: `herdr:${kind}`, agent: kind, kind: coreRefusalKind(kind), value: folder } };
  if (others.some((other) => other.kind === kind && other.named === null && other.folder === folder)) return refused;
  const excluded = new Set<string>();
  for (const other of others) {
    if (other.kind !== kind || other.named === null) continue;
    const ref = sessionRefFromAgentSession(other.named);
    const id = ref === null || ref.format !== kind ? null : peerSessionID(ref);
    if (id === null) return refused;
    excluded.add(id);
  }
  if (excluded.size > maxExcluded) return refused;
  return { kind: "folder", folder, format: kind, excluding: [...excluded].sort() };
}

/**
 * As CorePaneSession.shown: a session the finder gave, as readers may take it from the latest
 * delivered snapshot while the finder catches up: hidden when the rule now skips it (a peer names it) or the pane
 * no longer looks by folder; the refusal when another pane of the agent in the folder names none; a refusal the rule
 * no longer gives is hidden too. A transcript only in the folder it was proved in.
 */
export function shownCoreSession(
  found: CoreFoundSessionLike,
  paneID: string,
  agents: readonly CoreRuleAgent[],
  panes: readonly CoreRulePane[],
): CoreFoundSessionLike | null {
  const lookup = coreLookup(paneID, agents, panes);
  switch (lookup.kind) {
    case "none":
      return null;
    case "refused":
      return isAmbiguousSession(found) ? found : { ...lookup.session, foundBy: found.foundBy };
    case "folder":
      if (isAmbiguousSession(found) || found.kind !== "id" || !isGrokSessionID(found.value)) return null;
      if (found.foundIn !== lookup.folder || lookup.excluding.includes(found.value.toLowerCase())) return null;
      return found;
  }
}

/**
 * What Chat, Away, Changes and search follow for a herdr-core Claude or Codex pane of this machine whose argv names
 * no session: the session the finder found as the latest snapshot allows it (an id), "ambiguous" for the refusal,
 * null for none. Undefined for any other pane (a TUI pane, one its argv names, another machine's): the rules as
 * before.
 */
export function coreChatSession(paneID: string, agents: readonly CoreRuleAgent[], panes: readonly CoreRulePane[]): AgentSessionLike | "ambiguous" | null | undefined {
  if (coreFolderKind(paneID, agents, panes) === undefined) return undefined;
  const named = agents.find((candidate) => candidate.paneID === paneID && candidate.agentSession !== undefined)?.agentSession;
  if (named !== undefined && sessionRefFromAgentSession(named) !== null) return undefined;
  // None found (yet): none, never the desktop's newest-in-the-project-folder guess.
  const found = agents.find((candidate) => candidate.paneID === paneID && candidate.coreFound !== undefined)?.coreFound;
  if (found === undefined) return null;
  const shown = shownCoreSession(found, paneID, agents, panes);
  if (shown === null) return null;
  return isAmbiguousSession(shown) ? "ambiguous" : { source: shown.source, agent: shown.agent, kind: shown.kind, value: shown.value };
}
