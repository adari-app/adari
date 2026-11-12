// The needs-you mark clears when the question is gone.
// Herdr can go on saying an agent is blocked after its question left the
// screen (answered in the terminal, or by the card while Herdr's status lags).
// While Herdr says blocked, main reads that pane every 2.5 s; two reads in a
// row, at least 1 s apart, both begun after the app saw the block begin, both
// showing nothing prompt-like (no question the matcher reads, and none it does
// not), and the pane shows as working (no Needs you count, no red mark, no
// needs-you sort) until Herdr's status changes. A read showing a prompt again
// brings the mark back at once; a read that fails or proves nothing keeps
// Herdr's mark.

import type { HostView } from "../ipc-contract";
import { cleanRow, grokTrace, isBorder, matchPrompt, normalisedLower, readRows, sectionHeaders } from "./matcher";
import { paneBlocked, promptEpisode, type PanePrompt } from "./view";

/** The least time between the two quiet reads. */
export const quietGapMs = 1_000;

export interface QuietState {
  /** When the last read that showed nothing prompt-like began (null: the last read showed a prompt, failed, or none came). */
  readonly lastQuietAt: number | null;
  /** The mark is cleared: the pane shows as working. */
  readonly cleared: boolean;
}

export const marked: QuietState = { lastQuietAt: null, cleared: false };

const yesNo = /\[(?:y\/n|y\/n\/a|yes\/no)\]/iu;
/** A menu's marked row ("❯ 1. Yes", "› 2. No"): a cursor on a numbered option. */
const markedOption = /^[❯›>▶➤▸]\s*\d{1,2}[.)]\s/u;
/** A numbered option with no cursor ("1. Yes", "2) No"). */
const numberedOption = /^\s*(\d{1,2})[.)]\s+\S/u;
/** Footers the agents draw under a question they wait on, the recorded ones and the ones the matcher does not answer. */
const footerWords = ["esc to cancel", "enter to confirm", "enter to select", "press enter to continue"];

/**
 * The screen shows something prompt-like: a question the matcher reads, or
 * one it does not (a [y/N] at the end, a question on the last row, a
 * question's footer, a menu's marked option, a Claude dialog's section
 * header; on a Grok pane, any part of Grok 1.0.70's approval frame, its
 * `1/<n>:select` footer, title row or option rows).
 *
 * `agentKind` is the pane's agent. Only a Grok pane counts Grok's frame rows,
 * so a partly drawn frame keeps its mark. On any other pane (Claude, Codex,
 * Cursor, none) a stale or quoted `┃ ›` row counts for nothing.
 */
export function promptLike(text: string, agentKind: string | null = null): boolean {
  if (matchPrompt(text, "").type === "matched") return true;
  if (agentKind?.toLowerCase() === "grok" && grokTrace(text)) return true;
  const rows = readRows(text)
    .map(cleanRow)
    .filter((row) => row !== "" && !isBorder(row));
  const last = (count: number): string[] => rows.slice(-count);
  if (last(3).some((row) => yesNo.test(row))) return true;
  // A question on the last row ("A custom approval? Type CONFIRM or CANCEL"); Codex's "? for shortcuts" footer is not one.
  const end = rows.at(-1);
  if (end !== undefined && end.indexOf("?") > 0) return true;
  if (last(6).some((row) => footerWords.some((words) => normalisedLower(row).includes(words)))) return true;
  if (last(15).some((row) => markedOption.test(row))) return true;
  if (last(15).some((row) => sectionHeaders.has(normalisedLower(row)))) return true;
  return questionWithOptions(last(15));
}

/**
 * A question line with numbered options under it, no
 * cursor or footer needed ("Do you want to run this command?" … "1. Yes",
 * "2. No"): an unsupported or partly drawn menu.
 */
function questionWithOptions(rows: readonly string[]): boolean {
  const question = rows.findIndex((row) => row.includes("?"));
  if (question < 0) return false;
  const numbers = rows.slice(question + 1).flatMap((row) => {
    const found = numberedOption.exec(row);
    return found === null ? [] : [Number(found[1])];
  });
  return numbers.includes(1) && numbers.includes(2);
}

/**
 * The read has something to read: anything left once
 * escape sequences, control characters and white space are taken out. A
 * blank or control-only read proves nothing.
 */
export function readable(text: string): boolean {
  const plain = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[P^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
  return plain.trim() !== "";
}

/**
 * The state after one read of a blocked pane: `text` null when the read
 * failed or proves nothing (another connection); `startedAt` when it was
 * asked for; `blockSeenAt` when the app first saw this block; `agentKind`
 * the pane's agent (Grok's frame rows count on a Grok pane only).
 */
export function afterRead(
  state: QuietState,
  read: { readonly startedAt: number; readonly text: string | null },
  blockSeenAt: number,
  agentKind: string | null = null,
): QuietState {
  if (read.text === null) return marked;
  // A blank or control-only read is no evidence the question left; it counts as a failed one.
  if (!readable(read.text)) return marked;
  if (promptLike(read.text, agentKind)) return marked;
  // A read begun before the block was seen says nothing of this block.
  if (read.startedAt < blockSeenAt) return state;
  const cleared = state.cleared || (state.lastQuietAt !== null && read.startedAt - state.lastQuietAt >= quietGapMs);
  return { lastQuietAt: read.startedAt, cleared };
}

const keyOf = (hostId: string, paneId: string): string => `${hostId}\u0000${paneId}`;

/**
 * The machines as the page shows them: each cleared pane (and its agent)
 * working, so the sidebar row, the Needs you group, the tile header and the
 * sort read it as working. Everything else as Herdr said it.
 *
 * Only while the host update still shows the block and
 * connection that were cleared: the pane blocked in the same promptEpisode
 * (terminal, kind, session, status and its change), on the same machine
 * entry, connection and epoch. Anything else drops the override at once.
 */
export function applyCleared(hosts: readonly HostView[], prompts: readonly PanePrompt[]): HostView[] {
  const cleared = new Map(prompts.filter((prompt) => prompt.cleared).map((prompt) => [keyOf(prompt.hostId, prompt.paneId), prompt]));
  if (cleared.size === 0) return [...hosts];
  return hosts.map((host) => {
    const topology = host.topology;
    if (topology === null) return host;
    const still = new Set(
      topology.panes
        .filter((pane) => {
          const prompt = cleared.get(keyOf(host.id, pane.paneID));
          if (prompt === undefined) return false;
          const agent = topology.agents.find((candidate) => candidate.paneID === pane.paneID) ?? null;
          return (
            (host.incarnation ?? 0) === prompt.incarnation &&
            (host.connection ?? 0) === prompt.connection &&
            (host.epoch ?? null) === prompt.epoch &&
            paneBlocked(pane, agent) &&
            promptEpisode(pane, agent) === prompt.episode
          );
        })
        .map((pane) => pane.paneID),
    );
    if (still.size === 0) return host;
    return {
      ...host,
      topology: {
        ...topology,
        panes: topology.panes.map((pane) => (still.has(pane.paneID) ? { ...pane, agentStatus: "working" } : pane)),
        agents: topology.agents.map((agent) => (still.has(agent.paneID) ? { ...agent, agentStatus: "working", inputPending: false } : agent)),
      },
    };
  });
}
