// What a Send is for: the pane as you saw it when you pressed Send. The page
// takes it from the snapshot it shows; the main process
// sends only while a fresh snapshot still shows the same (src/main/herdr/send.ts
// sendBound), as the Swift app's CompanionAgentGuard and liveSendRefusal do
// (App/CompanionComposerModel.swift). Pure, shared by both sides.

import type { AgentInfo, SessionTopology, TopologyPaneInfo } from "../main/herdr/wire";

export interface SendBinding {
  /** The terminal in the pane ("" when the snapshot named none). */
  readonly terminalID: string;
  /** An agent ran in the pane (else its shell's box). */
  readonly isAgent: boolean;
  /** The agent's kind, lowercased ("claude", "opencode"); null when not reported, so not compared. */
  readonly kind: string | null;
  /** The agent's Herdr session; null when not reported, so not compared. */
  readonly session: string | null;
  /**
   * A hand-off's pick: the main process's connection
   * generation and the pane's agent run its row showed (HostView.run). When
   * present, the main process sends only while both are the same.
   */
  readonly run?: { readonly connection: number; readonly arrival: number };
  /**
   * A hidden command (a chip's pick, Compact):
   * it goes only while the agent is at its prompt when its turn in the pane's
   * queue comes (notAtPromptText otherwise).
   */
  readonly atPromptOnly?: boolean;
  /**
   * Compact for Claude Code, held for the end of a turn: Claude Code queues a
   * `/compact` typed while it works and runs it once the turn ends, so when its turn in the pane's queue comes it
   * goes while Claude is at its prompt or working (a monitor's event may have started a new turn since the page
   * saw the turn end), never into a dialog or a pending menu. With `atPromptOnly` only; ignored for any other agent.
   * Main applies it only when the line it planned is a typed Claude
   * Compact (isCompactCommand); for anything else the flag counts for nothing.
   */
  readonly queuesWhileWorking?: boolean;
}

/**
 * A Claude Code Compact line, as typed (already trimmed): exactly
 * `/compact`, or `/compact`, a space and one line of your instructions. Shared, so the box holds only what main
 * lets through the working-state permission (`/compactor`, `/compact\nmore`, `/model opus`: never).
 */
export function isCompactCommand(text: string): boolean {
  return /^\/compact(?: [^\n\r]*)?$/.test(text);
}

/**
 * A hidden command's refusal because the agent is
 * not at its prompt when its turn comes (Working, or a dialog): the page holds
 * the pick for the next turn again (agent-picks.ts), with no note.
 */
export const notAtPromptText = "Not sent: the agent is not at its prompt now (working or waiting for an answer); held for its next turn.";

/** The refusal when the picked connection or run changed (the main process says it; the page knows it as stale). */
export function runChangedText(expected: Pick<SendBinding, "isAgent" | "kind">): string {
  const name = expected.isAgent ? (expected.kind ?? "the agent") : "the shell";
  return `Not sent: ${name} in this pane is not the one you picked (it started again or the machine reconnected)`;
}

/**
 * The main process's refusals because the pane is not the one the Send was
 * for (send.ts guardTexts uses these): the page never puts a hand-off refused
 * so in the box of what is there now.
 */
export const paneChangedTexts = {
  paneGone: "Not sent: the pane is gone",
  otherProgram: "Not sent: another program is in this pane now",
  changedAgent: "Not sent: another agent is in this pane now",
  agentStarted: "Not run: an agent started in this pane. The text is kept.",
  exited: (name: string) => `${name} exited; not sent`,
} as const;

/** A refusal because the pane changed or is not the run picked (see paneChangedTexts and runChangedText). */
export function isPaneChangedNote(note: string): boolean {
  const text = note.trim();
  return (
    text === paneChangedTexts.paneGone ||
    text === paneChangedTexts.otherProgram ||
    text === paneChangedTexts.changedAgent ||
    text === paneChangedTexts.agentStarted ||
    / exited; not sent\.?$/.test(text) ||
    /^Not sent: .+ in this pane is not the one you picked\b/.test(text)
  );
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isRun(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isCount(v["connection"]) && isCount(v["arrival"]);
}

const maxField = 512;

function optionalString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maxField);
}

export function isSendBinding(value: unknown): value is SendBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["terminalID"] === "string" &&
    v["terminalID"].length <= maxField &&
    typeof v["isAgent"] === "boolean" &&
    optionalString(v["kind"]) &&
    optionalString(v["session"]) &&
    isRun(v["run"]) &&
    (v["atPromptOnly"] === undefined || typeof v["atPromptOnly"] === "boolean") &&
    (v["queuesWhileWorking"] === undefined || typeof v["queuesWhileWorking"] === "boolean")
  );
}

/**
 * The agent kind in a pane (CompanionMessageRoute.agentKind): its agent
 * entry's, else, for an agent pane Herdr reports without one, the pane's own;
 * lowercased. Null when neither names one.
 */
export function agentKind(agent: Pick<AgentInfo, "agent"> | null, pane: Pick<TopologyPaneInfo, "agent"> | null): string | null {
  const kind = agent?.agent ?? pane?.agent;
  return kind === undefined || kind === "" ? null : kind.toLowerCase();
}

/** The agent's Herdr session, or null. */
export function agentSession(agent: Pick<AgentInfo, "agentSession"> | null): string | null {
  const value = agent?.agentSession?.value;
  return value === undefined || value === "" ? null : value;
}

/** An agent runs in the pane by this snapshot (the Swift app's runsAgent). */
export function runsAgent(pane: Pick<TopologyPaneInfo, "agent">, agent: Pick<AgentInfo, "agent"> | null): boolean {
  return (agent?.agent !== undefined && agent.agent !== "") || (pane.agent !== undefined && pane.agent !== "");
}

/** The binding for a Send to `paneId` as `topology` shows it. */
/**
 * The binding with the connection and the pane's agent
 * run the page shows (HostView.run), as the chips' picks and a typed command
 * line carry it; without a shown run, the plain binding.
 */
export function runBindingOf(
  host: { readonly topology: SessionTopology | null | undefined; readonly run?: { readonly connection: number; readonly arrivals: Readonly<Record<string, number>> } },
  paneId: string,
  isAgent: boolean,
): SendBinding {
  const base = bindingOf(host.topology, paneId, isAgent);
  const run = host.run;
  return run === undefined ? base : { ...base, run: { connection: run.connection, arrival: run.arrivals[paneId] ?? 0 } };
}

export function bindingOf(topology: SessionTopology | null | undefined, paneId: string, isAgent: boolean): SendBinding {
  const pane = topology?.panes.find((candidate) => candidate.paneID === paneId) ?? null;
  const agent = topology?.agents.find((candidate) => candidate.paneID === paneId) ?? null;
  return {
    terminalID: pane?.terminalID ?? "",
    isAgent,
    kind: isAgent ? agentKind(agent, pane) : null,
    session: isAgent ? agentSession(agent) : null,
  };
}
