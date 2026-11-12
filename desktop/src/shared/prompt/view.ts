// The needs-you card between the main process and the page.
// The main process reads each blocked pane's screen (src/main/prompt/prompts.ts)
// and sends the page its reading; the page answers by an option's key and the
// fingerprint it showed, and main sends that option's keys only while the
// pane still shows that question (answerer.ts), bound to the agent and the
// connection the page saw (the Stop binding, agent-stop.ts).

import type { AgentInfo, TopologyPaneInfo } from "../../main/herdr/wire";
import { agentKind, agentSession } from "../send-binding";
import { isStopBinding, type StopBinding } from "../agent-stop";
import type { PromptFingerprint, PromptReading } from "./matcher";

/** One blocked pane as main last read it. */
export interface PanePrompt {
  readonly hostId: string;
  readonly paneId: string;
  /** The block it was read in (promptEpisode). */
  readonly episode: string;
  /** The machine's entry, connection and command connection's epoch it was read on. */
  readonly incarnation: number;
  readonly connection: number;
  readonly epoch: number | null;
  /** The matcher's reading of its screen; null until the first read came. */
  readonly reading: PromptReading | null;
  /** Its last read showed nothing prompt-like (the question left the screen). */
  readonly quiet: boolean;
  /**
   * Two reads in a row, at least 1 s apart, both after
   * the block began, showed nothing prompt-like: the pane shows as working
   * until Herdr's status changes.
   */
  readonly cleared: boolean;
}

/** An answer from the card (an option's key) or from the box (the "No, tell…" option and the text). */
export interface AnswerRequest {
  readonly hostId: string;
  readonly paneId: string;
  /** The agent, its block and the connection, as the page showed them. */
  readonly binding: StopBinding;
  /** The question the page showed. */
  readonly fingerprint: PromptFingerprint;
  /** The reading it answers (PanePrompt.episode, the block main read it in). */
  readonly episode: string;
  /** The option's key ("1", "y"). */
  readonly key: string;
  /** The box's text, sent once the agent opens its text field (the tell option only). */
  readonly text?: string;
}

export type AnswerResult =
  /** The option's keys went (and the text, when there was one). */
  | { readonly type: "sent"; readonly label: string }
  /** The keys went out but did not confirm. */
  | { readonly type: "unconfirmed"; readonly label: string; readonly note: string }
  /** The option went, the text did not (it is kept). */
  | { readonly type: "answeredOnly"; readonly label: string; readonly note: string }
  /** Nothing was sent: the pane shows another question, or none. */
  | { readonly type: "changed"; readonly note: string; readonly now: PromptReading }
  /**
   * Nothing was sent, in these words. `terminal` when the answer stopped for
   * the user's own Terminal input: the card offers Answer in Terminal.
   */
  | { readonly type: "refused"; readonly note: string; readonly terminal?: true }
  /** Grok's digit went, its screen did not show the answer take: nothing more went (Answer in Terminal). */
  | { readonly type: "unsettled"; readonly label: string; readonly note: string };

export const answerTexts = {
  changed: "Not sent: the question changed",
  busy: "Not sent: an answer to this question is already going",
  /** An answer to this question went (or may have). */
  answered: "Not sent: this question was already answered",
  offline: (machine: string) => `Not sent: ${machine} is offline`,
  connectionChanged: (machine: string) => `Not sent: the connection to ${machine} changed`,
  unchecked: (name: string) => `Not sent: the app could not check that ${name} is still asking. Try again.`,
  paneGone: "Not sent: the pane is gone",
  otherAgent: "Not sent: another agent is in this pane now",
  notAsking: (name: string) => `Not sent: ${name} is no longer asking this question`,
  unread: (reason: string) => `Not sent: ${reason}`,
  unconfirmed: "Sent, but the Mac did not confirm it. Check the agent.",
  /** The digit went, the frame did not go (or another one came): nothing more is sent. */
  unsettled: (name: string) => `Answer in Terminal: ${name}’s screen did not show the answer take`,
  /** The user's Terminal input on this machine while the answer was under way: nothing went. */
  typedMeanwhile: "Answer in Terminal: there was typing in its Terminal meanwhile, so nothing was sent",
  /** A choice of Codex's update question whose key is not known here. */
  inTerminal: "Answer in Terminal: this choice's key is not known here, so nothing was sent",
  noText: (label: string) => `Not sent: “${label}” takes no text`,
  emptyText: "Not sent: the box is empty",
  textNotSent: (label: string, reason: string) => `“${label}” went, but the text was not sent: ${reason}. It is kept.`,
  textUnconfirmed: (label: string) => `“${label}” went but did not confirm, so the text was not sent. It is kept.`,
  /** The box's note when the question takes no words (the draft stays). */
  waiting: (name: string) => `Not sent: ${name} is waiting on the question above. The text is kept.`,
} as const;

/** Herdr says the pane's agent waits on the user (the sidebar's needs-you rule, sidebar-model.ts). */
export function paneBlocked(pane: Pick<TopologyPaneInfo, "agent" | "agentStatus">, agent: Pick<AgentInfo, "agentStatus" | "inputPending"> | null): boolean {
  if (pane.agentStatus === "blocked") return true;
  const isAgent = pane.agent !== undefined && pane.agent !== "";
  return isAgent && agent !== null && (agent.agentStatus === "blocked" || agent.inputPending === true);
}

const wide = (value: unknown): string | null => (typeof value === "number" || typeof value === "bigint" ? String(value) : null);

/** One block of one agent: its terminal, kind and session, Herdr's status and when it began. A change is a new block. */
export function promptEpisode(
  pane: Pick<TopologyPaneInfo, "agent" | "agentStatus" | "terminalID">,
  agent: Pick<AgentInfo, "agent" | "agentStatus" | "inputPending" | "stateChangeSeq" | "statusSinceUnixMs" | "agentSession"> | null,
): string {
  return JSON.stringify([
    pane.terminalID,
    agentKind(agent, pane),
    agentSession(agent),
    agent?.agentStatus ?? pane.agentStatus,
    agent?.inputPending === true,
    wide(agent?.stateChangeSeq),
    wide(agent?.statusSinceUnixMs),
  ]);
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isTexts = (value: unknown, count: number, max: number): boolean =>
  Array.isArray(value) && value.length <= count && value.every((item) => isText(item, max));

/** A well-formed answer from the page (anything else is refused). */
export function isAnswerRequest(value: unknown): value is AnswerRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const f = v["fingerprint"];
  if (typeof f !== "object" || f === null) return false;
  const p = f as Record<string, unknown>;
  return (
    isText(v["hostId"], 256) &&
    isText(v["paneId"], 256) &&
    isStopBinding(v["binding"]) &&
    typeof p["rules"] === "number" &&
    isText(p["paneID"], 256) &&
    isText(p["question"], 4_096) &&
    isTexts(p["body"], 200, 4_096) &&
    isTexts(p["options"], 100, 4_096) &&
    isText(v["episode"], 4_096) &&
    isText(v["key"], 4) &&
    v["key"] !== "" &&
    (v["text"] === undefined || isText(v["text"], 100_000))
  );
}
