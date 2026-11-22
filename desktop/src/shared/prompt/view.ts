// The needs-you card between the main process and the page.
// The main process reads each blocked pane's screen (src/main/prompt/prompts.ts)
// and sends the page its reading; the page answers by an option's key and the
// fingerprint it showed, and main sends that option's keys only while the
// pane still shows that question (answerer.ts), bound to the agent and the
// connection the page saw (the Stop binding, agent-stop.ts).

import type { AgentInfo, SessionTopology, TopologyPaneInfo } from "../../main/herdr/wire";
import type { HostView } from "../ipc-contract";
import { agentKind, agentSession } from "../send-binding";
import { isStopBinding, type StopBinding } from "../agent-stop";
import { agyKind, readingMatch, type PromptFingerprint, type PromptReading } from "./matcher";

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
  /**
   * Read while Herdr says the pane is done or idle, not blocked: an agy pane
   * showing one of Antigravity CLI's own questions (agy 1.5.13 reports `done`
   * while its file questions show), or a Codex pane showing its "Implement
   * this plan?" list (Codex 0.171.0 reports `done` then). Listed only while the
   * reading is one of them; the page shows the pane as needing you then
   * (applyAgyQuestions).
   */
  readonly whileNotBlocked?: true;
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

/**
 * A pane of `kind` Herdr says is done or idle (not working, not blocked), with both of Herdr's records agreeing:
 * neither the agent's nor the pane's says working, and neither names another kind.
 */
function doneOrIdlePane(
  kind: string,
  pane: Pick<TopologyPaneInfo, "agent" | "agentStatus">,
  agent: Pick<AgentInfo, "agent" | "agentStatus" | "inputPending"> | null,
): boolean {
  if (agentKind(agent, pane) !== kind || paneBlocked(pane, agent)) return false;
  const kinds = [agent?.agent, pane.agent].filter((name): name is string => name !== undefined && name !== "");
  if (kinds.some((name) => name.toLowerCase() !== kind)) return false;
  if (agent?.agentStatus === "working" || pane.agentStatus === "working") return false;
  const status = agent?.agentStatus ?? pane.agentStatus;
  return status === "done" || status === "idle";
}

/**
 * An agy pane Herdr says is done or idle (not working, not blocked): Antigravity CLI 1.5.13's create and edit
 * questions show while Herdr reports `done`, so its screen is read for them (prompts.ts). Both of Herdr's records
 * must agree: neither the agent's nor the pane's says working, and neither names another kind.
 */
export function agyAskingPane(
  pane: Pick<TopologyPaneInfo, "agent" | "agentStatus">,
  agent: Pick<AgentInfo, "agent" | "agentStatus" | "inputPending"> | null,
): boolean {
  return doneOrIdlePane(agyKind, pane, agent);
}

/**
 * A Codex pane Herdr says is done or idle, by the same rule. Codex
 * 0.171.0 marks its turn done before it draws "Implement this plan?", and that list reports no blocking, so the pane
 * is read for that one list (prompts.ts; matcher.ts `codexPlan`), nothing else.
 */
export function codexPlanPane(
  pane: Pick<TopologyPaneInfo, "agent" | "agentStatus">,
  agent: Pick<AgentInfo, "agent" | "agentStatus" | "inputPending"> | null,
): boolean {
  return doneOrIdlePane("codex", pane, agent);
}

/** A done or idle pane read for its agent's own question: agy's questions, or Codex's plan list. */
export function doneAskingPane(
  pane: Pick<TopologyPaneInfo, "agent" | "agentStatus">,
  agent: Pick<AgentInfo, "agent" | "agentStatus" | "inputPending"> | null,
): boolean {
  return agyAskingPane(pane, agent) || codexPlanPane(pane, agent);
}

/** The reading is one of Antigravity CLI's own questions, read whole. */
export function showsAgyQuestion(reading: PromptReading | null): boolean {
  const match = readingMatch(reading);
  return match !== null && (match.kind === "agyAsk" || match.kind === "agyTrust");
}

/**
 * The reading is what a done or idle pane is read for (`doneAskingPane`), read whole: one of agy's questions, or
 * Codex's "Implement this plan?" list (each reader runs only on its own agent's pane).
 */
export function showsDoneQuestion(reading: PromptReading | null): boolean {
  return showsAgyQuestion(reading) || readingMatch(reading)?.kind === "codexPlan";
}

/**
 * The machines as the page shows them: an agy pane main read while Herdr says it is done or idle, showing one of
 * Antigravity CLI's questions, or a Codex pane so read showing its "Implement this plan?" list
 * (on the machine's entry, connection and epoch now, the pane in the same block: promptEpisode), shows
 * as needing you, as a blocked pane's question does: its agent with input pending, so the
 * sidebar, Priority, the header, the notification and the card follow. Its status stays Herdr's (an answer is bound
 * to it). Every other pane is as given.
 */
export function applyAgyQuestions<H extends Pick<HostView, "id" | "topology" | "incarnation" | "connection" | "epoch">>(hosts: readonly H[], prompts: readonly PanePrompt[]): H[] {
  const asking = prompts.filter((prompt) => prompt.whileNotBlocked === true && showsDoneQuestion(prompt.reading));
  if (asking.length === 0) return [...hosts];
  return hosts.map((host) => {
    const topology: SessionTopology | null = host.topology;
    if (topology === null) return host;
    const still = new Set(
      asking
        .filter((prompt) => {
          if (prompt.hostId !== host.id || prompt.incarnation !== (host.incarnation ?? 0) || prompt.connection !== (host.connection ?? 0) || prompt.epoch !== (host.epoch ?? null)) return false;
          const pane = topology.panes.find((candidate) => candidate.paneID === prompt.paneId);
          const agent = topology.agents.find((candidate) => candidate.paneID === prompt.paneId) ?? null;
          return pane !== undefined && agent !== null && doneAskingPane(pane, agent) && promptEpisode(pane, agent) === prompt.episode;
        })
        .map((prompt) => prompt.paneId),
    );
    if (still.size === 0) return host;
    return { ...host, topology: { ...topology, agents: topology.agents.map((agent) => (still.has(agent.paneID) ? { ...agent, inputPending: true } : agent)) } };
  });
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

/** A fingerprint's `words` (matcher.ts `FingerprintWords`): absent, or each part a text no longer than its rows, or null. */
function isFingerprintWords(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const w = value as Record<string, unknown>;
  const part = (item: unknown, max: number): boolean => item === null || isText(item, max);
  const rows = w["questionRows"];
  return part(w["question"], 4_096) && part(w["body"], 201 * 4_097) && part(w["options"], 101 * 4_097) && (rows === undefined || isTexts(rows, 200, 4_096));
}

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
    isFingerprintWords(p["words"]) &&
    isText(v["episode"], 4_096) &&
    isText(v["key"], 4) &&
    v["key"] !== "" &&
    (v["text"] === undefined || isText(v["text"], 100_000))
  );
}
