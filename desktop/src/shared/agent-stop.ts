// Stop: Escape to the agent of the Chat you are looking at,
// ported from the iPhone and iPad app (App/CompanionChatModel.swift
// CompanionChatStop; App/CompanionComposerModel.swift CompanionInterrupt and
// `func interrupt`; App/CompanionAgentScreen.swift canInterrupt). Pure, shared
// by the page (when the square shows, what it is bound to) and the main process
// (whether the agent is still the one you saw working).

import type { AgentInfo, SessionTopology, TopologyPaneInfo } from "../main/herdr/wire";
import { agentKind, agentSession } from "./send-binding";

/** What the Stop square stands on. */
export interface StopInput {
  /** An agent runs in the pane (a shell, or a pane whose agent exited, is not one). */
  readonly isAgent: boolean;
  /** Herdr's status for the pane, as the sidebar reads it (a pending menu reads as blocked). */
  readonly status: string;
  /** The machine answers now. */
  readonly online: boolean;
  /** Text (any character) or an attachment chip in the box. */
  readonly boxHasContent: boolean;
}

/**
 * Stop is possible (CompanionChatStop.shows without the box): an agent Herdr
 * says works (an agent waiting on a dialog is "blocked", the needs-you card's)
 * on a machine that answers. Esc stops it whatever the box holds.
 */
export function stopPossible(input: Omit<StopInput, "boxHasContent">): boolean {
  return input.isAgent && input.status === "working" && input.online;
}

/** A key press as the page sees it (a KeyboardEvent, or React's). */
export interface StopKeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  /** An auto-repeat keydown: the key is held down. */
  readonly repeat?: boolean;
}

/**
 * Esc with no modifier, not ending an input method's composition (the iPad's
 * escapeStops), and pressed, not held: an auto-repeat is never Stop (a held Esc
 * that closed a menu goes on stopping nothing).
 */
export function isStopKey(event: StopKeyPress): boolean {
  return (
    event.key === "Escape" &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    event.isComposing !== true &&
    event.repeat !== true
  );
}

/** The square stands in Send's place: Stop is possible and the box is empty (typing brings Send back). */
export function stopShows(input: StopInput): boolean {
  return stopPossible(input) && !input.boxHasContent;
}

/**
 * What a stop is for: the agent as the page showed it working. The main
 * process sends Escape only while a fresh snapshot still shows it.
 */
export interface StopBinding {
  /** The terminal in the pane ("" when the snapshot named none). */
  readonly terminalID: string;
  /** The agent's kind, lowercased; null when not reported, so not compared. */
  readonly kind: string | null;
  /** The agent's Herdr session; null when not reported. */
  readonly session: string | null;
  /**
   * The prompt episode (the Swift CompanionInboxAgent.episode): the agent's
   * status with its `state_change_seq` and `status_since_unix_ms`, as decimal
   * strings (null: not reported).
   */
  readonly episode: { readonly status: string; readonly seq: string | null; readonly since: string | null };
  /** The machine's entry and connection the page showed (HostView.incarnation, connection, epoch). */
  readonly incarnation: number;
  readonly connection: number;
  readonly epoch: number | null;
  /** The agent's name for the note ("Claude Code"). */
  readonly name: string;
}

const wide = (value: unknown): string | null => (typeof value === "number" || typeof value === "bigint" ? String(value) : null);

/**
 * After a press, the square shows a spinner until
 * Herdr reports the agent not working, or this long passes. A look only: it
 * never holds a press back (each press is one Esc, as in the terminal).
 */
export const stoppingLookMs = 10_000;

/** The agent and episode a stop is for, as one key (the armed stop's; the machine's entry and connection left out). */
export function stopEpisodeKey(binding: StopBinding): string {
  const { terminalID, kind, session, episode } = binding;
  return JSON.stringify([terminalID, kind, session, episode.status, episode.seq, episode.since]);
}

/** The episode of `agent` in `pane` by one snapshot. */
export function episodeOf(pane: Pick<TopologyPaneInfo, "agentStatus"> | null, agent: AgentInfo | null): StopBinding["episode"] {
  return { status: agent?.agentStatus ?? pane?.agentStatus ?? "", seq: wide(agent?.stateChangeSeq), since: wide(agent?.statusSinceUnixMs) };
}

/** The stop for `paneId` as `host` shows it. */
export function stopBindingOf(
  host: {
    readonly topology: SessionTopology | null | undefined;
    readonly incarnation?: number;
    readonly connection?: number;
    readonly epoch?: number | null;
  },
  paneId: string,
  name: string,
): StopBinding {
  const pane = host.topology?.panes.find((candidate) => candidate.paneID === paneId) ?? null;
  const agent = host.topology?.agents.find((candidate) => candidate.paneID === paneId) ?? null;
  return {
    terminalID: pane?.terminalID ?? "",
    kind: agentKind(agent, pane),
    session: agentSession(agent),
    episode: episodeOf(pane, agent),
    incarnation: host.incarnation ?? 0,
    connection: host.connection ?? 0,
    epoch: host.epoch ?? null,
    name,
  };
}

const maxField = 512;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = maxField): value is string => typeof value === "string" && value.length <= max;
const isOptionalText = (value: unknown): boolean => value === null || isText(value);
const isDigits = (value: unknown): boolean => value === null || (isText(value, 40) && /^-?\d+$/.test(value));

/** A well-formed stop from the page (anything else is refused). */
export function isStopBinding(value: unknown): value is StopBinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const episode = v["episode"];
  if (typeof episode !== "object" || episode === null) return false;
  const e = episode as Record<string, unknown>;
  return (
    isText(v["terminalID"]) &&
    isOptionalText(v["kind"]) &&
    isOptionalText(v["session"]) &&
    isText(e["status"], 64) &&
    isDigits(e["seq"]) &&
    isDigits(e["since"]) &&
    isCount(v["incarnation"]) &&
    isCount(v["connection"]) &&
    (v["epoch"] === null || isCount(v["epoch"])) &&
    isText(v["name"], 64) &&
    v["name"] !== ""
  );
}

/**
 * Stop is a plain Esc to the pane on screen. These
 * are the only notes, for a key that could not go (on the note line under the box).
 */
export const stopTexts = {
  offline: (machine: string) => `Esc did not go: ${machine} is offline`,
  machineChanged: (machine: string) => `Esc did not go: ${machine} was added again`,
  notListed: "Esc did not go: that machine is no longer listed",
  paneGone: "Esc did not go: the pane is gone",
  otherProgram: "Esc did not go: another program is in this pane now",
  refused: (code: string) => `Esc did not go: Herdr refused it (${code})`,
  failed: (reason: string) => `Esc did not go: ${reason}`,
} as const;
