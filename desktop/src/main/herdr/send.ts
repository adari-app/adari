// The Swift app's Send rule (App/CompanionComposerModel.swift:
// CompanionMessageFraming, CompanionMessageRefusal, CompanionMessageRoute,
// CompanionMessageSender.deliver; CompanionInboxStore.sendMessage), the Send
// mode only (the desktop has no Insert):
//
// - a Claude or Codex agent gets Herdr's `agent.prompt` (never a paste: Claude
//   Code takes a paste as a possible image paste);
// - any other agent gets one `pane.send_input`: the text as one bracketed
//   paste (`ESC[200~ … ESC[201~`) and exactly one Return;
// - a shell takes one line, typed plain, and its Return (a line break would run
//   each line as a command: refused with the pane-life note);
// - control characters are refused, nothing is sent, the text is kept.
//
// A command line for Claude Code or Codex (one line starting with `/` and a
// command name: src/shared/slash-command.ts) is typed (`pane.send_text`, no
// paste markers) and then its Return (`agent.send_keys`), as if the user typed
// it, never refused into a dialog; ordinary messages are unchanged.
//
// Every Send is bound to the pane as the user saw it
// (src/shared/send-binding.ts) and goes only while a fresh snapshot still shows
// it (sendBound, the Swift app's CompanionAgentGuard and liveSendRefusal).

import {
  AuthenticationFailedError,
  ConnectFailedError,
  ConnectTimedOutError,
  HerdrNotInstalledError,
  RemoteSocketFailedError,
  RequestTimedOutError,
  RequestTooLargeError,
} from "./errors";
import { agentKind, runsAgent, agentSession, isCompactCommand, notAtPromptText, paneChangedTexts, runChangedText, type SendBinding } from "../../shared/send-binding";
import { APIError, type AgentInfo, type TopologyPaneInfo } from "./wire";
import { isSlashCommand } from "../../shared/slash-command";
import { catalogAgentNames } from "../../shared/model-catalog";
import {
  afterPrompt,
  beforeSend,
  boundBoxSite,
  boxBefore,
  BoxKeysCalledOff,
  composerWrites,
  sameBoxRun,
  type BoxBefore,
  type BoxRun,
  type ClaudeBoxSite,
  type PulledRow,
  type TakeBackTurn,
} from "./claude-box";
import { claudeBoxTexts, imagePaths } from "../../shared/claude-screen";
import { startScreenKinds, startScreenNotSent, startScreenWhy } from "../../shared/prompt/start-screen";
import type { StartScreenGuard } from "../start-screens";
import {
  cursorEffortLabel,
  cursorPickRow,
  cursorPickShown,
  readCursorScreen,
  type CursorFooter,
  type CursorPick,
  type CursorScreen,
} from "../../shared/agent-settings";
import type { CursorPickResult, GrokPickResult } from "../../shared/ipc-contract";
import {
  grokFilesAgree,
  grokFilesTuple,
  grokScreenTuple,
  grokTarget,
  readGrokScreen,
  sameGrokTuple,
  type GrokFiles,
  type GrokPick,
  type GrokScreen,
  type GrokTuple,
} from "../../shared/agent-settings";

export { agentKind } from "../../shared/send-binding";

export const pasteStart = "\u001b[200~";
export const pasteEnd = "\u001b[201~";
export const returnKey = "Enter";

/** How a message reaches its pane. */
export type MessageRoute = "prompt" | "paste";

export const promptKinds: ReadonlySet<string> = new Set(["claude", "codex"]);

/** Why a message was not sent; its text stays in the composer. */
export type MessageRefusal = "empty" | "controlCharacters" | "noBracketedPaste" | "terminalNotAttached";

const refusalTexts: Record<MessageRefusal, string> = {
  empty: "Nothing to send.",
  controlCharacters: "Not sent: the text has control characters that cannot be pasted safely.",
  noBracketedPaste: "Not sent: this program has bracketed paste off, so each line would run on its own. The text is kept.",
  terminalNotAttached: "Not sent: the terminal is not attached, so the lines cannot go as one paste. The text is kept.",
};

/** CompanionMessageRefusal.text(route): a prompt is not pasted, so its note never says so. */
export function refusalText(refusal: MessageRefusal, route: MessageRoute): string {
  if (refusal === "controlCharacters" && route !== "paste") {
    return "Not sent: the text has control characters that cannot be sent safely.";
  }
  return refusalTexts[refusal];
}

/** CompanionPaneLifeBox.oneLineNote: a shell's box runs one line. */
export const oneLineNote = "Not run: a shell command is one line. The text is kept.";

/** Lines or tabs: the text goes only as one bracketed paste. */
export function needsPaste(text: string): boolean {
  return /[\n\r\t]/.test(text);
}

/**
 * CompanionMessageFraming.payload: the one write for `text`. A bracketed paste
 * when the program turned it on (true), the plain text otherwise; line breaks
 * and tabs need the paste, any other control character is refused.
 * `bracketedPaste` null: not known (no attached terminal), one plain line only.
 */
export function payload(
  text: string,
  bracketedPaste: boolean | null,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly refusal: MessageRefusal } {
  if (text === "") return { ok: false, refusal: "empty" };
  for (const character of text) {
    const value = character.codePointAt(0)!;
    if (value === 0x7f || (value >= 0x80 && value <= 0x9f)) return { ok: false, refusal: "controlCharacters" };
    if (value >= 0x20) continue;
    if (value !== 0x0a && value !== 0x0d && value !== 0x09) return { ok: false, refusal: "controlCharacters" };
    if (bracketedPaste === true) continue;
    return { ok: false, refusal: bracketedPaste === false ? "noBracketedPaste" : "terminalNotAttached" };
  }
  return { ok: true, text: bracketedPaste === true ? pasteStart + text + pasteEnd : text };
}

/** CompanionMessageRoute.route for Send. */
export function messageRoute(isAgent: boolean, kind: string | null): MessageRoute {
  return isAgent && kind !== null && promptKinds.has(kind) ? "prompt" : "paste";
}

/** What one Send does. */
export type SendPlan =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "input"; readonly text: string; readonly keys: readonly string[] }
  /** A Claude or Codex command line: typed as characters, then its Return. */
  | { readonly kind: "typed"; readonly text: string; readonly keys: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The Send for `text` to a pane. An agent's TUI (every agent Herdr knows turns
 * bracketed paste on) takes its text as one paste; a shell, one plain line. The
 * desktop has no paste-mode evidence from an attached terminal, so this is the
 * conservative reading of the Swift rule.
 */
export function planSend(text: string, target: { readonly isAgent: boolean; readonly kind: string | null }, typedCommand = false): SendPlan {
  if (text.trim() === "") return { kind: "refused", reason: refusalTexts.empty };
  if (!target.isAgent && needsPaste(text)) return { kind: "refused", reason: oneLineNote };
  const route = messageRoute(target.isAgent, target.kind);
  // An agent.prompt is never a paste, so its lines need no paste mode (CompanionMessageFraming.pasteMode).
  const framed = payload(text, route === "prompt" || target.isAgent ? true : null);
  if (!framed.ok) return { kind: "refused", reason: refusalText(framed.refusal, route) };
  if (route === "prompt" && isSlashCommand(text)) return { kind: "typed", text: text.trim(), keys: [returnKey] };
  // A model pick main made for Grok or Cursor (`/model …`) is typed as characters too, never pasted.
  if (typedCommand && target.isAgent && isSlashCommand(text) && !needsPaste(text)) return { kind: "typed", text: text.trim(), keys: [returnKey] };
  if (route === "prompt") return { kind: "prompt", text };
  return { kind: "input", text: framed.text, keys: [returnKey] };
}

/** CompanionMessageRoute.refusal: Herdr refused the prompt before any input was sent; the text stays. */
export function promptRefusal(error: APIError): string {
  switch (error.code) {
    case "agent_blocked":
    case "agent_input_pending":
      return "Not sent: Herdr says the agent is waiting for an answer in its terminal. The text is kept.";
    case "agent_not_ready":
      return "Not sent: the agent is not ready for a message yet. The text is kept.";
    case "agent_unverified":
      return (
        "Not sent: herdr-core cannot confirm the agent is still running in that terminal (it reports no status). " +
        "Type in its terminal instead. The text is kept."
      );
    case "agent_word":
    case "agent_dialog":
    case "agent_unbound":
      return `${error.serverMessage} The text is kept.`;
    case "invalid_request":
      if (error.serverMessage.toLowerCase().includes("unknown variant")) {
        return "Not sent: the Herdr on this Mac cannot take agent messages (agent.prompt). Update Herdr on the Mac. The text is kept.";
      }
      return `Not sent: Herdr refused the message (${error.code}). The text is kept.`;
    default:
      return `Not sent: Herdr refused the message (${error.code}). The text is kept.`;
  }
}

/**
 * A write that got no answer is not claimed as sent. A message sent while
 * Claude works can fail to arrive, and "Sent, but the Mac did not confirm it"
 * would hide that: the note says plainly it did not go, and the box keeps the
 * text so one press sends it again.
 */
export const notTakenText = (name: string): string => `Not sent: ${name} did not take the message. It is still in the box.`;
/** The agent's name for that note. */
const takerNames: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok", cursor: "Cursor" };
export function takerName(kind: string | null | undefined): string {
  return kind == null ? "the agent" : (takerNames[kind.toLowerCase()] ?? "the agent");
}
/**
 * CompanionMessageSender.unconfirmedText: a write whose reply was lost after it went out may have
 * landed; only an agent.prompt that ran out of time before it was written is known not taken.
 */
export const unconfirmedText = "Sent, but the Mac did not confirm it. Check the agent before sending again.";

/** What a backend needs to carry out a plan. */
export interface MessageWriter {
  prompt(paneID: string, text: string): Promise<void>;
  sendInput(paneID: string, text: string, keys: readonly string[]): Promise<void>;
}

/**
 * Carries out the plan: resolves when sent; throws an Error whose message is
 * the note to show (the composer keeps the text). A prompt Herdr refused gets
 * the Swift app's words; any other failure is not confirmed either way.
 */
export async function deliver(writer: MessageWriter, paneID: string, plan: SendPlan, kind: string | null = null): Promise<void> {
  if (plan.kind === "refused") throw new Error(plan.reason);
  try {
    if (plan.kind === "prompt") await writer.prompt(paneID, plan.text);
    else await writer.sendInput(paneID, plan.text, plan.keys);
  } catch (error) {
    throw new Error(writeFailure(error, plan.kind === "prompt", kind));
  }
}

/** The note for a write that threw: Herdr's refusal, never written, a prompt out of time (not taken, never claimed as sent), or not confirmed. */
function writeFailure(error: unknown, prompt: boolean, kind: string | null = null): string {
  if (error instanceof APIError) {
    return prompt ? promptRefusal(error) : `Not sent: Herdr refused the message (${error.code}). The text is kept.`;
  }
  // Failing before the request was written (no connection, no socket): nothing went.
  if (neverWritten(error)) return `Not sent: ${(error as Error).message}. The text is kept.`;
  // A prompt that ran out of time before it was written (never handed to SSH or the relay): not taken.
  // A reply lost after the write (a closed channel) may have landed, as may a paste. So may a
  // prompt written to the relay or handed to SSH on the exec path whose deadline passed (neither a cancel nor ending
  // the SSH client can recall it): not confirmed, never "not taken".
  return prompt && error instanceof RequestTimedOutError && !error.mayHaveLanded ? notTakenText(takerName(kind)) : unconfirmedText;
}

// MARK: - the bound Send (CompanionAgentGuard)

/** The Swift app's words for a Send that no longer fits its pane (App/CompanionComposerModel.swift, CompanionPaneLife.swift). */
export const guardTexts = {
  paneGone: paneChangedTexts.paneGone,
  otherProgram: paneChangedTexts.otherProgram,
  changedAgent: paneChangedTexts.changedAgent,
  agentStarted: paneChangedTexts.agentStarted,
  uncheckedPane: "Not sent: the app could not check the pane. The text is kept.",
  unchecked: (name: string) => `Not sent: the app could not check that ${name} is still in its pane. The text is kept.`,
  exited: paneChangedTexts.exited,
  returnRefused: (name: string) => `Typed into ${name}, but Herdr did not take its Return. Check the terminal before sending again.`,
  returnUnconfirmed: (name: string) => `Typed into ${name}, but the Mac did not confirm its Return. Check the agent before sending again.`,
  noReturn: (name: string, why: string) =>
    `Typed into ${name}, but ${why}, so no Return was pressed. Check the terminal before sending again.`,
} as const;

/** What a backend needs for a bound Send. */
export interface PaneWriter extends MessageWriter {
  /** `pane.send_text`: the text, nothing pressed. */
  sendText(paneID: string, text: string): Promise<void>;
  /** `agent.send_keys`: Herdr refuses them for a pane whose process is not an agent (gated). */
  agentKeys(paneID: string, keys: readonly string[]): Promise<void>;
}

/** The machine for one bound Send. */
export interface SendSite {
  readonly writer: PaneWriter;
  /** A snapshot asked for after this call began; false when none came. */
  fresh(): Promise<boolean>;
  /** The pane and its agent by the latest snapshot. */
  pane(): TopologyPaneInfo | null;
  agent(): AgentInfo | null;
  /** The connection and the pane's agent run by the latest snapshot (null: not answering; absent: not counted here). */
  run?(): { connection: number; arrival: number } | null;
  /**
   * Claude Code's box in the pane (read, emptied), and the messages Chat sent
   * to it lately; absent where the screen cannot be read.
   */
  box?: SendBox;
  /** The pane's Terminal input on this machine so far (PaneInputs); absent: not counted here. */
  inputGeneration?(): number;
  /**
   * Codex's hook review on the pane's screen, checked inside this Send's turn
   * (StartScreenService.sendGuard); absent where the screen is not read for it.
   */
  startScreen?(): StartScreenGuard;
}

/** What a Send to a Claude pane needs of its box. */
export interface SendBox {
  readonly site: ClaudeBoxSite;
  /** The messages Chat sent lately to `run` in the pane (its own text in Claude's box). */
  own(run: BoxRun | null): readonly string[];
  /** A message went by agent.prompt to `run` (null: not known). */
  sent(text: string, run: BoxRun | null): void;
  /** The pane's box marks so far (BoxChecks.marks: Stop, Esc, a pick, a failed send, Terminal input); absent: not counted here. */
  marks?(): number;
  /** The machine's entry still holds this Send's writer; absent: not checked here. */
  machine?(): boolean;
  /**
   * Whether this send reads the box first (Stop, Esc or a failed send since the last
   * read: BoxChecks); absent: every send reads it.
   */
  due?(): boolean;
  /** The box was read. */
  checked?(): void;
  /** The send failed: the next one reads the box. */
  failed?(): void;
  /** What a take-back left in Claude's row (PulledRows); absent: none kept here. */
  pulled?(): PulledRow | null;
  /** A read showed that row empty, or the cleanup emptied it. */
  resolved?(): void;
}

/** A picked connection and run (a hand-off's binding) still the same now; true for a binding without one. */
export function sameRun(expected: SendBinding, site: SendSite): boolean {
  if (expected.run === undefined) return true;
  const now = site.run?.() ?? null;
  return now !== null && now.connection === expected.run.connection && now.arrival === expected.run.arrival;
}

type Mismatch = "paneGone" | "otherProgram" | "exited" | "agentStarted" | "changedAgent" | "sessionUnknown";

/** Why the pane no longer fits the binding by this snapshot (the Swift liveSendRefusal and guard), or null. */
export function mismatch(expected: SendBinding, pane: TopologyPaneInfo | null, agent: AgentInfo | null): Mismatch | null {
  if (pane === null) return "paneGone";
  if (expected.terminalID !== "" && pane.terminalID !== expected.terminalID) return "otherProgram";
  const running = runsAgent(pane, agent);
  if (expected.isAgent && !running) return "exited";
  if (!expected.isAgent && running) return "agentStarted";
  if (expected.isAgent) {
    if (expected.kind !== null && agentKind(agent, pane) !== expected.kind) return "changedAgent";
    const session = agentSession(agent);
    if (expected.session !== null && session !== null && session !== expected.session) return "changedAgent";
    // A session the user saw must still be named: its absence confirms nothing.
    if (expected.session !== null && session === null) return "sessionUnknown";
  }
  return null;
}

function refusalFor(found: Mismatch, name: string): string {
  switch (found) {
    case "sessionUnknown":
      return guardTexts.unchecked(name);
    case "paneGone":
      return guardTexts.paneGone;
    case "otherProgram":
      return guardTexts.otherProgram;
    case "exited":
      return guardTexts.exited(name);
    case "agentStarted":
      return guardTexts.agentStarted;
    case "changedAgent":
      return guardTexts.changedAgent;
  }
}

export const noReturnWhy: Record<Mismatch, string> = {
  paneGone: "the pane is gone",
  otherProgram: "another program is in this pane now",
  exited: "the agent left",
  agentStarted: "the pane changed",
  changedAgent: "another agent is in this pane now",
  sessionUnknown: "the app could not check it before its Return",
};

/**
 * One Send bound to the pane the user chose. Text that cannot go is refused first;
 * then a fresh snapshot must still show the pane, terminal, agent kind and
 * session the user saw, else nothing is written and the note says why (the text
 * stays). A Claude or Codex message goes as `agent.prompt` (Herdr gates it); a
 * shell line as one `pane.send_input`; any other agent's text as one paste
 * (`pane.send_text`), checked again (`fresh`: the latest snapshot while the relay's
 * events keep it current; a fresh one otherwise), then its Return by
 * `agent.send_keys` (Herdr gates it). A paste whose pane changed before its
 * Return gets no Return and nothing else: the app cannot tell the line is still
 * the paste's (the user may have typed their own command since), so it never clears it;
 * the note says to check the terminal. Resolves when sent;
 * throws the note.
 */
export function sendBound(site: SendSite, paneID: string, text: string, expected: SendBinding, command?: TypedCommand): Promise<void> {
  return inPaneTurn(site.writer, paneID, () => sendBoundNow(site, paneID, text, expected, command));
}

/**
 * A command main made for an agent whose messages go as a paste (Grok's and Cursor's `/model …`): typed
 * as characters with its Return, under every guard of a typed pick (at the prompt only, for the run picked, never
 * into a dialog), and only after `ready`, read in the Send's own turn, says the agent's box is on its screen and
 * empty (its note otherwise: nothing is written). The snapshot's checks run again after that read.
 */
export interface TypedCommand {
  ready(): Promise<string | null>;
  /**
   * The agent's box read again after the command was typed, right before
   * its Return: "shows" only when the screen is the one Return needs (the box holding exactly `command`; for Cursor,
   * its own list for it under the box). "settling" while the screen is still plainly on
   * its way (the box not yet holding the whole command, or the command with no list yet): it is read again after
   * `pause`, at most typedReadBackReads times; "differs" for anything else (the user's text joined to it, another family
   * marked, a dialog, a failed read): no Return, at once.
   */
  shows(command: string): Promise<TypedReadBack>;
  /** The wait between two reads of the read-back (typedReadBackStepMs when not given). */
  pause?(): Promise<void>;
}

/** What a typed command's read-back saw (TypedCommand.shows). */
export type TypedReadBack = "shows" | "settling" | "differs";

/**
 * The read-back waits for the agent to draw what was typed (Cursor 2026.11.11 drew
 * neither the text nor its list 0.01 s after a write, both from 0.16 s on): reads every typedReadBackStepMs, at most
 * typedReadBackReads of them (about 2 s), then no Return.
 */
export const typedReadBackStepMs = 150;
export const typedReadBackReads = 14;

/**
 * A typed command's Return withheld because the Terminal's text changed (the user's typing since the
 * box was read empty, or the box not holding exactly the command): nothing more is written, the user's text is left alone.
 */
export const typedCommandChangedText = "Not sent: the terminal's text changed, so the model pick was not sent. Check its terminal.";

/**
 * A typed command's Return withheld after the command went into the box (its read-back did not
 * show what Return needs, or the user's typing since): the line says the app's command is still in the terminal's box.
 */
export function typedCommandLeftText(name: string, command: string, moved: boolean): string {
  const why = moved ? "the terminal's text changed after it was typed" : `${name}'s screen did not show it as expected before its Return`;
  return `Not sent: ${why}, so no Return was pressed. ${command} is still in ${name}'s box in its terminal: press Return there or clear it.`;
}

/**
 * One complete Send (its text, then its Return) at a time per pane on this
 * machine: held picks and a typed line never run into each other's line. Each checks the pane
 * again when its turn comes; a refused one does not hold up the next. A Cursor
 * pick's whole walk through its menu is one such turn.
 */
export function inPaneTurn<T>(writer: PaneWriter, paneID: string, work: () => Promise<T>): Promise<T> {
  let panes = sendQueues.get(writer);
  if (panes === undefined) {
    panes = new Map();
    sendQueues.set(writer, panes);
  }
  const queue = panes;
  const before = queue.get(paneID) ?? Promise.resolve();
  const turn = before.then(work);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  queue.set(paneID, settled);
  void settled.then(() => {
    if (queue.get(paneID) === settled) queue.delete(paneID);
  });
  return turn;
}

/** Per machine (its writer) and pane: the end of the last Send queued. */
const sendQueues = new WeakMap<PaneWriter, Map<string, Promise<void>>>();

/**
 * The agent run in the pane by the latest snapshot (BoxRun); null when the pane, its terminal
 * or (where the site counts it) the machine's answering run is not known.
 */
export function boxRunOf(site: SendSite): BoxRun | null {
  const pane = site.pane();
  const run = site.run === undefined ? { connection: 0, arrival: 0 } : site.run();
  if (pane === null || pane.terminalID === "" || run === null) return null;
  const agent = site.agent();
  const epoch = agent?.turnEpoch;
  return { terminalID: pane.terminalID, session: agentSession(agent), arrival: run.arrival, epoch: epoch === undefined ? null : String(epoch) };
}

/**
 * What a Send's cleanup of Claude's box is bound to, taken before its first read:
 * the run in the pane then (`run`: only messages sent to it are ours), and `holds`, asked right before each
 * cleanup key with nothing awaited between: the Send's own binding still fits the latest snapshot (sameRun,
 * mismatch: the pane, terminal, agent kind and session), the connection and the run (terminal, session, arrival,
 * `turn_epoch`) are the ones taken, and no Terminal input and no box mark (Stop, Esc, a pick, a failed send)
 * came since. A run that cannot be read holds nothing. Nor may any composer write to
 * the pane have started since (`composerWrites`, on `paneID`, else the pane the snapshot shows): a newer Send's text
 * may be in the box with ours, so no key goes after it (the reads after an Esc are not ordered with a Send).
 */
export function cleanupBinding(
  site: SendSite,
  expected: SendBinding,
  box: SendBox,
  paneID: string | undefined = site.pane()?.paneID,
): { readonly run: BoxRun | null; readonly holds: () => boolean } {
  const { run, holds } = bindingNow(site, expected, box, paneID);
  return { run, holds };
}

/**
 * The binding `cleanupBinding` describes, taken now; `wrote` counts a composer write of the
 * binding's own (a prompt's corrective Return), which then still holds for it (and for no binding taken before).
 */
function bindingNow(
  site: SendSite,
  expected: SendBinding,
  box: SendBox,
  paneID: string | undefined,
): { readonly run: BoxRun | null; readonly holds: () => boolean; readonly wrote: () => void } {
  const run = boxRunOf(site);
  const connection = site.run?.()?.connection;
  const inputs = site.inputGeneration?.();
  const marks = box.marks?.();
  let writes = paneID === undefined ? undefined : composerWrites.count(site.writer, paneID);
  return {
    run,
    holds: () =>
      run !== null &&
      (box.machine?.() ?? true) &&
      sameRun(expected, site) &&
      mismatch(expected, site.pane(), site.agent()) === null &&
      site.run?.()?.connection === connection &&
      sameBoxRun(boxRunOf(site), run) &&
      site.inputGeneration?.() === inputs &&
      box.marks?.() === marks &&
      paneID !== undefined &&
      composerWrites.count(site.writer, paneID) === writes,
    wrote: () => {
      if (paneID === undefined) return;
      composerWrites.wrote(site.writer, paneID);
      writes = composerWrites.count(site.writer, paneID);
    },
  };
}

/**
 * What the reads after a prompt with pictures, and its one corrective Return, are bound to
 * (the Swift app's CompanionImagePrompt `holds` and `known`).
 * Taken right after the prompt's own write began (counted), from the snapshot the Send just checked, nothing
 * awaited since. `holds`: the machine, the Send's binding (pane, terminal, agent kind, session, picked run), the
 * connection and the run (terminal, session, arrival, `turn_epoch`) are the ones at the write, and no Terminal
 * input, box mark (Stop, Esc, a pick, a failed send) or other composer write came since. `known`: the run has an
 * id (`turn_epoch`) and it is the same now; without one no Return goes. `wrote`: the
 * Return, a composer write of this binding's own.
 */
export interface PromptBinding {
  readonly run: BoxRun | null;
  readonly holds: () => boolean;
  readonly known: () => boolean;
  readonly wrote: () => void;
}

export function promptBinding(site: SendSite, expected: SendBinding, box: SendBox, paneID: string): PromptBinding {
  const bound = bindingNow(site, expected, box, paneID);
  const run = bound.run;
  return {
    ...bound,
    known: () => run !== null && run.epoch !== null && sameBoxRun(boxRunOf(site), run),
  };
}

/**
 * Claude's box for the reads after a prompt with pictures: reads and waits as `box.site`; its
 * one Return goes only while `bound` holds and its run is known, checked right before the write with nothing
 * awaited between (else BoxKeysCalledOff, nothing written), and counts as this Send's own composer write.
 */
export function promptBoxSite(box: SendBox, bound: PromptBinding): ClaudeBoxSite {
  const site = box.site;
  return {
    read: () => site.read(),
    keys: (keys) => {
      if (!bound.holds() || !bound.known()) return Promise.reject(new BoxKeysCalledOff());
      bound.wrote();
      return site.keys(keys);
    },
    wait: (ms) => site.wait(ms),
    ...(site.now === undefined ? {} : { now: () => site.now!() }),
  };
}

/** Herdr said Claude was idle (or done) before the prompt, by every status the snapshot gives. */
function idleByStatus(site: SendSite): boolean {
  const statuses = [site.agent()?.agentStatus, site.pane()?.agentStatus].filter((status): status is string => status !== undefined);
  return statuses.length > 0 && statuses.every((status) => status === "idle" || status === "done");
}

/** The Send's own checks (a fresh snapshot, its run, its pane), as it runs them before its write: the note, or null. */
async function sendChecks(site: SendSite, expected: SendBinding, name: string): Promise<string | null> {
  if (!(await site.fresh())) return expected.isAgent ? guardTexts.unchecked(name) : guardTexts.uncheckedPane;
  if (!sameRun(expected, site)) return runChangedText(expected);
  const found = mismatch(expected, site.pane(), site.agent());
  return found === null ? null : refusalFor(found, found === "sessionUnknown" ? name : displayName(name));
}

async function sendBoundNow(site: SendSite, paneID: string, text: string, expected: SendBinding, command?: TypedCommand): Promise<void> {
  const typedCommand = command !== undefined;
  const early = planSend(text, { isAgent: expected.isAgent, kind: expected.kind }, typedCommand);
  if (typedCommand && early.kind !== "typed") throw new Error("Not sent: that command cannot be typed.");
  if (early.kind === "refused") throw new Error(early.reason);
  // A message never joins text already in Claude Code's box.
  const box = early.kind === "prompt" && expected.isAgent && expected.kind === "claude" ? site.box : undefined;
  const name = expected.kind ?? "the agent";
  // A take-back left text in Claude's row: a command line typed into it
  // would join it, so none goes; a prompt goes only once its read below shows the row resolved.
  const pulled = expected.isAgent && expected.kind === "claude" ? (site.box?.pulled?.() ?? null) : null;
  if (pulled !== null && box === undefined) throw new Error(claudeBoxTexts.pulledNotSent);
  // The box is read only when due (Stop, Esc or a failed send since its last read).
  if (box !== undefined && ((box.due?.() ?? true) || pulled !== null)) {
    // Bound before the read; our own message (sent to this run) found there, the
    // Send's own checks run before any key, and each key goes only while the binding holds (cleanupBinding).
    const bound = cleanupBinding(site, expected, box, paneID);
    // Every cleanup key (a take-back's spare row, or our own message left
    // in the box) also checks the take-back's dialog gate, synchronously right before the write, nothing awaited
    // between: the pane or the agent blocked, or input pending, by the latest snapshot. Refused: no key, the
    // spare mark and this Send's draft are kept, and the note says why.
    let intoDialog = false;
    const keysHold = (): boolean => {
      if (dialogShown(site.pane(), site.agent())) {
        intoDialog = true;
        return false;
      }
      return bound.holds();
    };
    const allowed = await beforeSend(
      boundBoxSite(box.site, keysHold),
      box.own(bound.run),
      () => sendChecks(site, expected, name),
      pulled === null ? undefined : { left: pulled, resolved: () => box.resolved?.() },
    );
    if (allowed.type === "refused") throw new Error(intoDialog ? promptRefusal(new APIError("agent_blocked", "agent is blocked")) : allowed.note);
    // Only a read that lets the send go retires the check; a refusal (thrown above) or a box
    // not read stays due, so the next send reads it again.
    if (allowed.unverified !== true) box.checked?.();
  }
  // A prompt to Claude that carries pictures reads its box (readingBoxBefore in the Swift app)
  // once more right before the write, after any cleanup: its chips and queued hint then are the baseline. Only
  // chips not there stand for this prompt's pictures; not read (null), no Return can go.
  // The baseline is bound before its read (bindingNow: the machine, the Send's
  // binding, the connection, the run with its `turn_epoch`, session and arrival, Terminal input, box marks and
  // composer writes) and kept only while that binding still holds at the write, checked below with nothing
  // awaited before the write: another run's chips (an earlier message of a run found by the fresh snapshot) never
  // stand as this prompt's baseline. Changed: no baseline, so no Return goes and the send ends unconfirmed
  // unless the reads see it taken.
  const pictured = box !== undefined && imagePaths(text).length > 0;
  const baselineBound = pictured ? bindingNow(site, expected, box, paneID) : null;
  let baseline: BoxBefore | null = pictured ? await boxBefore(box.site) : null;
  if (!(await site.fresh())) throw new Error(expected.isAgent ? guardTexts.unchecked(name) : guardTexts.uncheckedPane);
  // Nothing awaited between this check and the write (the hook review's read below checks it again after).
  const checkNow = (): Exclude<SendPlan, { readonly kind: "refused" }> => {
    if (!sameRun(expected, site)) throw new Error(runChangedText(expected));
    const found = mismatch(expected, site.pane(), site.agent());
    if (found !== null) throw new Error(refusalFor(found, found === "sessionUnknown" ? name : displayName(name)));
    const planned = planSend(text, { isAgent: expected.isAgent, kind: agentKind(site.agent(), site.pane()) }, typedCommand);
    if (planned.kind === "refused") throw new Error(planned.reason);
    return planned;
  };
  let plan = checkNow();
  // The agent's box read in this turn (on its screen, empty), then the snapshot's checks again.
  // The Terminal's input is bound before that read; any of the user's typing since stops the command
  // before each write (nothing written, or no Return), as a pick's keys stop (pickCheck).
  const typedInputs = command === undefined ? undefined : site.inputGeneration?.();
  const typedMoved = (): boolean => command !== undefined && site.inputGeneration?.() !== typedInputs;
  if (command !== undefined) {
    if (expected.atPromptOnly === true && !atPrompt(site.pane(), site.agent())) throw new Error(notAtPromptText);
    const why = await command.ready();
    if (why !== null) throw new Error(why);
    if (typedMoved()) throw new Error(typedCommandChangedText);
    plan = checkNow();
  }
  // A Codex pane with no session may show Codex's hook review while Herdr says
  // idle, where a Return picks a choice (and Grok Build's, Cursor Agent's or Gemini CLI's own
  // start question, where a letter in the text or its Return answers it). Its screen is read now, in this Send's
  // turn after the fresh snapshot; it showing the question, the read failing or the connection changing refuses the
  // Send (nothing written, the text kept).
  const screen = startScreenGuard(site, expected);
  if (screen !== null) {
    if (!(await screen.guard.read(screen.kind, screen.terminalID))) throw new Error(screenRefusal(screen));
    // The read was awaited: the snapshot's checks again, nothing awaited from here to the write.
    plan = checkNow();
  }
  // The run (or its input) changed between the baseline read and this snapshot: not its baseline.
  if (baselineBound !== null && !baselineBound.holds()) baseline = null;
  if (plan.kind === "prompt" || !expected.isAgent) {
    // The run the message goes to, by the snapshot just checked (its own message for that run only).
    const sentRun = box === undefined ? null : boxRunOf(site);
    let pictures: { readonly bound: PromptBinding; readonly idleBefore: boolean } | null = null;
    // The latest read of the pane still shows no hook review (nothing awaited before the write).
    if (screen !== null && !screen.guard.clear()) throw new Error(screenRefusal(screen));
    try {
      // This write starts now: a cleanup bound before it writes no more keys.
      composerWrites.wrote(site.writer, paneID);
      // A prompt with pictures is bound now, by the snapshot just checked, this write counted.
      if (pictured && plan.kind === "prompt" && box !== undefined) {
        pictures = { bound: promptBinding(site, expected, box, paneID), idleBefore: idleByStatus(site) };
      }
      await deliver(site.writer, paneID, plan, agentKind(site.agent(), site.pane()));
    } catch (error) {
      box?.failed?.();
      throw error;
    }
    if (plan.kind === "prompt") box?.sent(plan.text, sentRun);
    if (pictures !== null && box !== undefined) await confirmPictures(site, box, plan.text, baseline, pictures.bound, pictures.idleBefore);
    return;
  }
  // A hidden command (a pick, Compact) goes only while the agent is at its prompt now:
  // a send queued before it (Compact's Return) may have started work. Nothing is typed.
  // A held Compact for Claude goes while it works too (Claude queues it), never into a dialog,
  // and only for the line main itself planned being a typed `/compact`
  // (with or without one line of instructions); the page's flag alone admits nothing else while it works.
  const compactQueues = expected.queuesWhileWorking === true && plan.kind === "typed" && isCompactCommand(plan.text) && claudeQueues(site.pane(), site.agent());
  if (expected.atPromptOnly === true && !atPrompt(site.pane(), site.agent()) && !compactQueues) {
    throw new Error(notAtPromptText);
  }
  // A command line goes only for the run it was picked on (the page sends the run it showed).
  if (plan.kind === "typed" && expected.run === undefined) throw new Error(runChangedText(expected));
  // A command typed into a dialog would answer it: refused as Herdr refuses a prompt there.
  if (plan.kind === "typed" && waitsForAnswer(site.agent())) throw new Error(promptRefusal(new APIError("agent_blocked", "agent is blocked")));

  // The latest read of the pane still shows no hook review (nothing awaited before the write).
  if (screen !== null && !screen.guard.clear()) throw new Error(screenRefusal(screen));
  // The user's Terminal input since the box was read empty: nothing is typed.
  if (typedMoved()) throw new Error(typedCommandChangedText);
  try {
    composerWrites.wrote(site.writer, paneID);
    await site.writer.sendText(paneID, plan.text);
  } catch (error) {
    throw new Error(writeFailure(error, false));
  }
  // A newer read of the pane asked for since (the watch's) is waited for
  // here, before the snapshot and the checks below; one that failed, or is still out at the check, takes no Return.
  if (screen !== null) await screen.guard.settle();
  // The same check between the paste and its Return. `fresh` is the send's check: with the
  // relay up and the sidebar's events live (hosts.current), the latest snapshot they keep current (no request);
  // otherwise, and while an event's snapshot is still due, a fresh snapshot.
  if (!(await site.fresh())) throw new Error(guardTexts.noReturn(name, "the app could not check it before its Return"));
  // For Grok Build, Cursor Agent and Gemini CLI, a read of the pane asked
  // for during that snapshot's await (the watch's) is waited for too, so an ordinary prompt gets its Return; one that
  // failed, crossed a reconnect or is still out after it still takes none. Codex's path does not wait here.
  if (screen !== null && screen.kind.toLowerCase() !== "codex") await screen.guard.settle();
  // The checks right before the Return, on the latest snapshot, nothing awaited in them.
  const returnChecks = (): void => {
    if (!sameRun(expected, site)) throw new Error(guardTexts.noReturn(name, "it is not the one picked any more"));
    const after = mismatch(expected, site.pane(), site.agent());
    if (after !== null) throw new Error(guardTexts.noReturn(name, noReturnWhy[after]));
    // A dialog or menu shown since the text went (the agent's or the pane's word) would take
    // this Return as its answer: none is pressed, now or later.
    if (waitsForAnswer(site.agent()) || site.pane()?.agentStatus === "blocked") {
      throw new Error(guardTexts.noReturn(name, `${name} is waiting for an answer now`));
    }
    // A hook review read since the text went takes no Return (nothing awaited before the key).
    if (screen !== null && !screen.guard.clear()) throw new Error(guardTexts.noReturn(name, screenNoReturnWhy(screen)));
    // A typed command's Return only at the prompt and with no Terminal input since its read.
    if (command !== undefined) {
      if (typedMoved()) throw new Error(typedCommandLeftText(typedAgentName(expected.kind), plan.text, true));
      if (expected.atPromptOnly === true && !atPrompt(site.pane(), site.agent())) throw new Error(guardTexts.noReturn(name, "it started working"));
    }
  };
  // A typed command's box read back, the last await before its Return: exactly the command,
  // nothing joined to it. The checks below then run again on the latest snapshot with nothing awaited before the key.
  // The command is in the box by now: a refusal's line says so. It is read again while the
  // agent is still drawing it (at most typedReadBackReads reads), with every check before each read.
  if (command !== undefined) {
    const pause = command.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, typedReadBackStepMs)));
    for (let reads = 1; ; reads += 1) {
      returnChecks();
      const seen = await command.shows(plan.text);
      if (seen === "shows") break;
      if (seen === "differs" || reads >= typedReadBackReads) throw new Error(typedCommandLeftText(typedAgentName(expected.kind), plan.text, typedMoved()));
      await pause();
    }
  }
  returnChecks();
  try {
    composerWrites.wrote(site.writer, paneID);
    await site.writer.agentKeys(paneID, [returnKey]);
  } catch (error) {
    if (!(error instanceof APIError)) throw new Error(guardTexts.returnUnconfirmed(name));
    // Herdr refused the Return: say so, and why when the pane shows it.
    const gone = (await site.fresh()) ? mismatch(expected, site.pane(), site.agent()) : null;
    throw new Error(gone === null ? guardTexts.returnRefused(name) : guardTexts.noReturn(name, noReturnWhy[gone]));
  }
}

/** Why no Return went after the text (guardTexts.noReturn). */
export const hookReviewWhy = "Codex is asking whether to trust Herdr's hook in its terminal";

/** The note for a Send the start-screen check refused (Codex's names the hook review; the others name the screen). */
function screenRefusal(screen: { readonly guard: StartScreenGuard; readonly kind: string }): string {
  return startScreenNotSent(screen.kind, screen.guard.shown?.() ?? null);
}

/**
 * Why no Return went after the text, for a start screen read since the text went: Codex's hook review
 * (hookReviewWhy); for Grok Build, Cursor Agent and Gemini CLI (their text and its Return are two writes), the question the
 * newest read showed, or that it could not be checked.
 */
function screenNoReturnWhy(screen: { readonly guard: StartScreenGuard; readonly kind: string }): string {
  if (screen.kind.toLowerCase() === "codex") return hookReviewWhy;
  return startScreenWhy(screen.kind, screen.guard.shown?.() ?? null);
}

/**
 * The hook review's check for this Send, by the snapshot just checked: an agent
 * Send to a pane running a kind whose start screen is read (Codex, Grok Build, Cursor Agent,
 * Gemini CLI) with no session Herdr names, where the site reads screens. Null: no check.
 */
function startScreenGuard(site: SendSite, expected: SendBinding): { readonly guard: StartScreenGuard; readonly kind: string; readonly terminalID: string } | null {
  if (site.startScreen === undefined || !expected.isAgent) return null;
  const pane = site.pane();
  const agent = site.agent();
  const kind = agentKind(agent, pane);
  if (pane === null || kind === null || !startScreenKinds.has(kind.toLowerCase()) || agentSession(agent) !== null) return null;
  return { guard: site.startScreen(), kind, terminalID: pane.terminalID };
}

/**
 * As the Swift app's CompanionInboxStore.confirm: after Herdr took a prompt that carries pictures,
 * Claude's box is read on a steady clock (claude-box.ts afterPrompt) and its one corrective Return goes only
 * once every picture shows as a chip new since the write, Claude idle, the binding holding and the run known
 * (checked again on a fresh snapshot right before the key). Sent (resolves) only when the reads say it went;
 * anything else (still in the box, a piece of it, the user's text, nothing read, no run id) throws the unconfirmed
 * note: the composer keeps the text and the pictures, Chat's bubble goes, nothing is sent again by itself, and
 * the next Send reads the box first.
 */
async function confirmPictures(
  site: SendSite,
  box: SendBox,
  sent: string,
  before: BoxBefore | null,
  bound: PromptBinding,
  idleBefore: boolean,
): Promise<void> {
  const found = await afterPrompt(promptBoxSite(box, bound), sent, {
    idleBefore,
    before,
    holds: bound.holds,
    mayPress: async () => (await site.fresh()) && bound.known(),
  });
  // Sent only on what the reads saw take it; a box empty all along is not.
  if (found === "taken") return;
  box.failed?.();
  throw new Error(guardTexts.returnUnconfirmed(takerName("claude")));
}

/** At its prompt by this snapshot: the pane idle or done, the agent not working and no dialog. */
export function atPrompt(pane: TopologyPaneInfo | null, agent: AgentInfo | null): boolean {
  if (pane === null || (pane.agentStatus !== "idle" && pane.agentStatus !== "done")) return false;
  if (agent === null) return true;
  return agent.agentStatus !== "working" && !waitsForAnswer(agent);
}

/**
 * Claude Code takes a typed command line now and runs it, at once at its prompt
 * or queued for the end of its turn while it works: Claude by this snapshot, the pane idle, done or working, and
 * no dialog or pending menu (the agent's word or the pane's).
 */
export function claudeQueues(pane: TopologyPaneInfo | null, agent: AgentInfo | null): boolean {
  if (pane === null || agentKind(agent, pane) !== "claude") return false;
  if (pane.agentStatus !== "idle" && pane.agentStatus !== "done" && pane.agentStatus !== "working") return false;
  return !waitsForAnswer(agent);
}

/**
 * The turn a take-back is for (`expected`: the page's episode,
 * as it showed Claude working) by this snapshot: `dialog` while the agent or the pane shows a dialog or a pending
 * menu; `ended` once either status is not working (Claude Code sent its queue then); `moved` while it works in
 * another episode (a new turn, its queue maybe its prompt, or a dialog answered since); else `on`.
 */
export function takeBackTurn(
  expected: { readonly episode: { readonly status: string; readonly seq: string | null } },
  pane: TopologyPaneInfo | null,
  agent: AgentInfo | null,
): TakeBackTurn {
  if (dialogShown(pane, agent)) return "dialog";
  const statuses = [agent?.agentStatus, pane?.agentStatus].filter((status): status is string => status !== undefined);
  if (expected.episode.status !== "working" || statuses.length === 0 || statuses.some((status) => status !== "working")) return "ended";
  const seq = agent?.stateChangeSeq;
  if (expected.episode.seq !== null && seq !== undefined && String(seq) !== expected.episode.seq) return "moved";
  return "on";
}

/**
 * The take-back's dialog gate, by this snapshot: the agent blocked or with input pending
 * (a dialog or a pending menu), or the pane blocked. No key from Claude's box steps goes while it shows.
 */
export function dialogShown(pane: TopologyPaneInfo | null, agent: AgentInfo | null): boolean {
  return waitsForAnswer(agent) || pane?.agentStatus === "blocked";
}

/** The agent shows a dialog or a pending menu by this snapshot. */
function waitsForAnswer(agent: AgentInfo | null): boolean {
  return agent !== null && (agent.agentStatus === "blocked" || agent.inputPending === true);
}

/** A typed command's agent as its line names it (Grok, Cursor). */
function typedAgentName(kind: string | null | undefined): string {
  const known = kind === undefined || kind === null ? undefined : (catalogAgentNames as Readonly<Record<string, string>>)[kind.toLowerCase()];
  return known ?? "The agent";
}

/** The agent's name at the start of a sentence. */
function displayName(name: string): string {
  return name === "the agent" ? "The agent" : name;
}

/** Failed before the request was written (no connection, no socket): nothing went. */
export function neverWritten(error: unknown): boolean {
  return (
    error instanceof ConnectFailedError ||
    error instanceof ConnectTimedOutError ||
    error instanceof AuthenticationFailedError ||
    error instanceof HerdrNotInstalledError ||
    error instanceof RemoteSocketFailedError ||
    error instanceof RequestTooLargeError
  );
}

// MARK: - a Cursor pick through its own menu

/** Herdr's key names for Cursor's menu (`pane.send_keys`). */
export const cursorKeys = { enter: "Enter", escape: "Escape", tab: "Tab", up: "Up", down: "Down", backspace: "Backspace" } as const;
/** What a pick types first: Cursor's own command for its model menu. */
export const cursorModelCommand = "/model";

/** A Cursor pick's words (the chip's note). */
export const cursorPickTexts = {
  noFooter: "Not set: Cursor's footer does not show its model now. Check its terminal.",
  noWindow: "Not set: Cursor's footer shows no context window for this model.",
  draft: "Not set: Cursor's box has text in it. Send or clear it, then pick again.",
  unexpected: "Not set: Cursor's menu did not show what was expected, so it was closed with Esc.",
  stuck: "Not set: Cursor's menu did not close by itself. Check its terminal.",
  /** A screen that is not a menu this pick opened: no key went after it. */
  elsewhere: "Not set: Cursor showed something else, so nothing more was pressed. Check Terminal.",
  unanswered: "Not set: the pane did not answer. Check its terminal.",
  stopped: (why: string) => `Not set: ${why}. Check its terminal.`,
  notShown: (footer: CursorFooter) => `Not set: Cursor's footer says ${describeCursorFooter(footer)}.`,
} as const;

/** "Grok 4.7 256K High Fast". */
export function describeCursorFooter(footer: CursorFooter): string {
  return [footer.model, footer.window, cursorEffortLabel(footer.effort), footer.fast ? "Fast" : null].filter((part) => part !== null).join(" ");
}

/** The pane's screen and keys for one pick, and the check before each write. */
export interface CursorMenuIO {
  /** `pane.read` (recent, plain text). */
  read(): Promise<string>;
  /** `pane.send_text`: the text, nothing pressed. */
  type(text: string): Promise<void>;
  /** `pane.send_keys`. */
  keys(keys: readonly string[]): Promise<void>;
  /** Right before each write, by the latest snapshot (nothing awaited): null while it is still the pane, terminal, agent and run picked; else why not. */
  check(): string | null;
}

class CursorStop extends Error {
  constructor(readonly why: string) {
    super(why);
  }
}

/**
 * Drives Cursor's own menu for one pick, reading the screen after every key
 * and checking it is the one expected (never counting keys): `/model`, its
 * command list with `/model` highlighted, Enter, the selector with the
 * arrow on the footer's model, (the Model chip stops here: the selector is
 * the user's) Tab, that model's Edit Parameters, the arrow moved row by row to the
 * target (each key one row), Enter (unless it is already so), Esc to the
 * selector, Esc to the box, whose footer must then say the pick. Any other
 * screen backs out: Esc until the box shows again (the typed `/model` taken
 * back with six Backspaces, only when the box holds exactly that), and the
 * note says so; the chip then shows what the footer says. Each Esc goes only after a fresh read shows a menu
 * this pick opened (its `/model` list while typed, the selector after its
 * Enter, its model's Edit Parameters after its Tab); any other screen
 * (unknown, another menu, unreadable) stops with no key and the note says to
 * check Terminal. Nothing goes
 * unless the first screen is Cursor's box, empty, idle, under a footer that
 * reads. `check` runs before every write; a refusal stops all keys.
 * Resolves with the result and the last screen read (null: none).
 */
export async function driveCursorPick(io: CursorMenuIO, pick: CursorPick): Promise<{ readonly result: CursorPickResult; readonly screen: string | null }> {
  let last: string | null = null;
  const look = async (): Promise<CursorScreen> => {
    last = await io.read();
    return readCursorScreen(last);
  };
  const done = (result: CursorPickResult): { result: CursorPickResult; screen: string | null } => ({ result, screen: last });
  const refused = (note: string, footer: CursorFooter | null) => done({ type: "refused", note, footer });
  let screen: CursorScreen;
  try {
    screen = await look();
  } catch {
    return refused(cursorPickTexts.unanswered, null);
  }
  if (screen.kind !== "box" || screen.footer === null) return refused(cursorPickTexts.noFooter, null);
  if (screen.working) return done({ type: "busy" });
  if (!screen.empty) return refused(cursorPickTexts.draft, screen.footer);
  const footer = screen.footer;
  if (cursorPickShown(pick, footer)) return done({ type: "set", footer });
  if (pick.kind === "context" && footer.window === null) return refused(cursorPickTexts.noWindow, footer);
  const write = async (action: () => Promise<void>): Promise<void> => {
    const why = io.check();
    if (why !== null) throw new CursorStop(why);
    await action();
  };
  let typed = false;
  /** The menus this pick has opened so far (the selector after its Enter, Edit Parameters after its Tab). */
  let openedSelector = false;
  let openedParameters = false;
  /** A menu this pick opened, on the screen just read: Esc may go to it; nothing else gets a key. */
  const ownMenu = (read: CursorScreen): boolean => {
    switch (read.kind) {
      case "commands":
        return typed && read.draft === cursorModelCommand;
      case "models":
        return openedSelector;
      case "parameters":
        return openedParameters && read.model === footer.model;
      default:
        return false;
    }
  };
  /** Esc until the box shows again; the `/model` typed taken back (six Backspaces) only when the box holds exactly that. */
  const backOut = async (): Promise<{ result: CursorPickResult; screen: string | null }> => {
    for (let round = 0; round < 5; round += 1) {
      if (screen.kind === "box") {
        if (typed && screen.draft === cursorModelCommand) {
          typed = false;
          await write(() => io.keys(Array.from({ length: cursorModelCommand.length }, () => cursorKeys.backspace)));
          screen = await look();
          continue;
        }
        return screen.empty ? refused(cursorPickTexts.unexpected, screen.footer) : refused(cursorPickTexts.stuck, screen.footer);
      }
      if (!ownMenu(screen)) return refused(cursorPickTexts.elsewhere, null);
      await write(() => io.keys([cursorKeys.escape]));
      screen = await look();
    }
    return refused(cursorPickTexts.stuck, null);
  };
  try {
    const listShown = (read: CursorScreen): boolean => read.kind === "commands" && read.draft === cursorModelCommand && read.highlighted === cursorModelCommand;
    await write(() => io.type(cursorModelCommand));
    typed = true;
    screen = await look();
    if (!listShown(screen)) return await backOut();
    // Read again right before Enter: the box holds exactly `/model` (its list up), nothing else.
    screen = await look();
    if (!listShown(screen)) return await backOut();
    await write(() => io.keys([cursorKeys.enter]));
    openedSelector = true;
    screen = await look();
    if (screen.kind !== "models" || screen.current !== footer.model) return await backOut();
    typed = false;
    if (pick.kind === "model") return done({ type: "opened" });
    const target = cursorPickRow(pick)!;
    await write(() => io.keys([cursorKeys.tab]));
    openedParameters = true;
    screen = await look();
    if (screen.kind !== "parameters" || screen.model !== footer.model) return await backOut();
    const shape = (rows: readonly { section: string; label: string }[]): string => rows.map((row) => `${row.section}/${row.label}`).join("|");
    const rows = shape(screen.rows);
    const goal = screen.rows.findIndex((row) => row.section === target.section && row.label === target.label);
    const arrowAt = (read: CursorScreen): number => {
      if (read.kind !== "parameters") return -1;
      const marked = read.rows.filter((row) => row.cursor);
      return marked.length === 1 ? read.rows.indexOf(marked[0]!) : -1;
    };
    let at = arrowAt(screen);
    if (goal < 0 || at < 0) return await backOut();
    for (let steps = 0; at !== goal; steps += 1) {
      if (steps > screen.rows.length) return await backOut();
      const down = goal > at;
      await write(() => io.keys([down ? cursorKeys.down : cursorKeys.up]));
      screen = await look();
      if (screen.kind !== "parameters" || screen.model !== footer.model || shape(screen.rows) !== rows) return await backOut();
      const next = arrowAt(screen);
      if (next !== at + (down ? 1 : -1)) return await backOut();
      at = next;
    }
    const wanted = pick.kind === "fast" ? pick.value : true;
    if (screen.kind === "parameters" && screen.rows[goal]!.chosen !== wanted) {
      // Read again right before Enter: the same rows, the arrow on the target, not yet chosen.
      screen = await look();
      if (screen.kind !== "parameters" || screen.model !== footer.model || shape(screen.rows) !== rows || arrowAt(screen) !== goal || screen.rows[goal]!.chosen === wanted) {
        return await backOut();
      }
      await write(() => io.keys([cursorKeys.enter]));
      screen = await look();
      // The model the pick started from (another model's menu goes to backOut, which refuses it).
      if (screen.kind !== "parameters" || screen.model !== footer.model || shape(screen.rows) !== rows || screen.rows[goal]!.chosen !== wanted) return await backOut();
    }
    // Every Esc of the pick, the normal cleanup's too, only to a menu it opened.
    if (!ownMenu(screen)) return await backOut();
    await write(() => io.keys([cursorKeys.escape]));
    screen = await look();
    if (screen.kind !== "models" || !ownMenu(screen)) return await backOut();
    await write(() => io.keys([cursorKeys.escape]));
    screen = await look();
    if (screen.kind !== "box" || screen.footer === null) return await backOut();
    if (!cursorPickShown(pick, screen.footer)) return refused(cursorPickTexts.notShown(screen.footer), screen.footer);
    return done({ type: "set", footer: screen.footer });
  } catch (error) {
    if (error instanceof CursorStop) return refused(cursorPickTexts.stopped(error.why), null);
    return refused(cursorPickTexts.unanswered, null);
  }
}

/** What a bound Cursor pick needs of its machine. */
export interface CursorPickSite extends SendSite {
  /** The pane's screen and keys (`pane.read`, `pane.send_keys`). */
  readonly calls: { paneRead(pane: string, lines: number): Promise<string>; paneSendKeys(pane: string, keys: readonly string[]): Promise<void> };
  /** One read of the pane at a time (the gate the live and needs-you reads share). */
  reading?<T>(read: () => Promise<T>): Promise<T>;
  /** The pane's Terminal input on this machine so far (PaneInputs); absent: not counted here. */
  inputGeneration?(): number;
}

/** Why a pick's next key may not go (the pane, its run, the user's Terminal input since it began), or null. */
export function pickCheck(site: CursorPickSite, expected: SendBinding, started: number | undefined, atPromptOnly: boolean): () => string | null {
  return () => {
    if (!sameRun(expected, site)) return "the agent in the pane started again";
    const now = mismatch(expected, site.pane(), site.agent());
    if (now !== null) return noReturnWhy[now];
    if (started !== undefined && site.inputGeneration?.() !== started) return pickTypedMeanwhile;
    if (atPromptOnly && !atPrompt(site.pane(), site.agent())) return "it started working";
    return null;
  };
}

/** A pick stopped by the user's Terminal input (the note's middle). */
export const pickTypedMeanwhile = "there was typing in its Terminal meanwhile";

/** How many lines a pick reads: the live reads' (the menus are some 30 lines under the box). */
export const cursorPickReadLines = 80;

/**
 * A Cursor pick bound to the pane the user chose, in the pane's send turn: a fresh
 * snapshot must still show the pane, terminal, Cursor and run the user saw, at its
 * prompt, else nothing is written; then driveCursorPick, every write checked
 * on the latest snapshot (the same pane, terminal, agent, session and run).
 */
export function pickCursorBound(site: CursorPickSite, paneID: string, pick: CursorPick, expected: SendBinding): Promise<{ readonly result: CursorPickResult; readonly screen: string | null }> {
  return inPaneTurn(site.writer, paneID, async () => {
    const refused = (note: string) => ({ result: { type: "refused", note, footer: null } as CursorPickResult, screen: null });
    if (expected.kind !== "cursor" || !expected.isAgent || expected.run === undefined) return refused(runChangedText(expected));
    if (!(await site.fresh())) return refused("Not set: the app could not check that Cursor is still in its pane.");
    if (!sameRun(expected, site)) return refused(runChangedText(expected));
    const found = mismatch(expected, site.pane(), site.agent());
    if (found !== null) return refused(`Not set: ${noReturnWhy[found]}.`);
    if (!atPrompt(site.pane(), site.agent())) return { result: { type: "busy" } as CursorPickResult, screen: null };
    // The user's Terminal input from here on stops the pick.
    const started = site.inputGeneration?.();
    const read = (): Promise<string> => site.calls.paneRead(paneID, cursorPickReadLines);
    return driveCursorPick(
      {
        read: () => (site.reading === undefined ? read() : site.reading(read)),
        type: (text) => site.writer.sendText(paneID, text),
        keys: (keys) => site.calls.paneSendKeys(paneID, keys),
        check: pickCheck(site, expected, started, false),
      },
      pick,
    );
  });
}

// MARK: - a Grok pick, one typed command

export const grokPickTexts = {
  noBox: "Not set: Grok's box is not on its screen now (a dialog or a list). Check its terminal.",
  draft: "Not set: Grok's box has text in it. Send or clear it, then pick again.",
  unknown: "Not set: Grok's model, window or effort is not known yet.",
  disagree: "Not set: Grok's summary.json or signals.json does not say what its screen shows (model, window or effort), so nothing was sent. Try again in a moment.",
  moved: "Not set: Grok's model, window or effort changed on its screen before Enter, so its command was taken back.",
  unexpected: "Not set: Grok's box did not show the command as typed, so nothing was sent and its box was left as it is. Check its terminal.",
  notShown: "Not set: Grok's screen did not show the change, so the chip shows what its summary.json says.",
  unanswered: "Not set: the pane did not answer. Check its terminal.",
  stopped: (why: string) => `Not set: ${why}. Check its terminal.`,
} as const;

/** Reads after Enter before a pick that does not show is given up. */
export const grokSettleReads = 5;

/**
 * Types a Grok pick's one command and Enter, reading the screen before (its box on screen and empty) and
 * after. The command is built from that first read, in the pane's turn: the model and
 * effort on the box's border, the window on its top line, all known; summary.json and signals.json (`files`)
 * only when they agree with it (an unread part says nothing), else nothing is typed; the pick changes only
 * its trait. The command is read back in the box twice, the second right before Enter: not
 * exactly the command, the box is left as it is (no Backspace); exactly it but the screen's
 * model, window or effort moved meanwhile, its own command is taken back. Enter, then up to grokSettleReads
 * reads (`wait` between) for the screen, or `confirm` (a fresh read of the files), to show the
 * whole resulting tuple. The Model chip's `/model` and Enter leave Grok's list open for the user.
 * The same steps as Sources/HerdrKit GrokPickDriver.
 */
export async function driveGrokPick(
  io: CursorMenuIO,
  pick: GrokPick,
  files: GrokFiles,
  wait: () => Promise<void>,
  confirm?: () => Promise<GrokFiles | null>,
): Promise<{ readonly result: GrokPickResult; readonly screen: string | null }> {
  let last: string | null = null;
  const look = async (): Promise<GrokScreen | null> => {
    last = await io.read();
    return readGrokScreen(last);
  };
  const done = (result: GrokPickResult) => ({ result, screen: last });
  const refused = (note: string) => done({ type: "refused", note });
  const write = async (action: () => Promise<void>): Promise<void> => {
    const why = io.check();
    if (why !== null) throw new CursorStop(why);
    await action();
  };
  try {
    const first = await look();
    if (first === null) return refused(grokPickTexts.noBox);
    if (first.draft !== "") return refused(grokPickTexts.draft);
    let shown: GrokTuple | null = null;
    let target: GrokTuple | null = null;
    let command = "/model";
    if (pick.kind !== "model") {
      shown = grokScreenTuple(first);
      if (shown === null) return refused(grokPickTexts.unknown);
      if (!grokFilesAgree(files, shown)) return refused(grokPickTexts.disagree);
      target = grokTarget(pick, shown);
      if (sameGrokTuple(target, shown)) return done({ type: "set", effort: shown.effort, window: shown.window });
      command = `/model ${target.model} ${target.window} ${target.effort}`;
    }
    await write(() => io.type(command));
    // What is in the box now is not known to be the pick's: it is left as it is (no Backspace).
    const typed = await look();
    if (typed === null || typed.draft !== command) return refused(grokPickTexts.unexpected);
    // Read again right before Enter: the box holds exactly the command, nothing else.
    const ready = await look();
    if (ready === null || ready.draft !== command) return refused(grokPickTexts.unexpected);
    if (shown !== null && !sameGrokTuple(grokScreenTuple(ready), shown)) {
      // Exactly its own command in the box (just read), the screen's tuple moved: taken back, checked like every write.
      await write(() => io.keys(Array<string>(command.length).fill(cursorKeys.backspace)));
      return refused(grokPickTexts.moved);
    }
    await write(() => io.keys([cursorKeys.enter]));
    if (target === null) return done({ type: "opened" });
    for (let read = 0; read < grokSettleReads; read += 1) {
      const now = await look();
      const seen = now === null ? null : grokScreenTuple(now);
      if (sameGrokTuple(seen, target)) return done({ type: "set", effort: target.effort, window: target.window });
      if (confirm !== undefined && sameGrokTuple(grokFilesTuple(await confirm()), target)) return done({ type: "set", effort: target.effort, window: target.window });
      await wait();
    }
    return refused(grokPickTexts.notShown);
  } catch (error) {
    if (error instanceof CursorStop) return refused(grokPickTexts.stopped(error.why));
    return refused(grokPickTexts.unanswered);
  }
}

/** A Grok pick bound to the pane the user chose, in the pane's send turn, under pickCursorBound's rules. */
export function pickGrokBound(
  site: CursorPickSite,
  paneID: string,
  pick: GrokPick,
  files: GrokFiles,
  expected: SendBinding,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 600)),
  confirm?: () => Promise<GrokFiles | null>,
): Promise<{ readonly result: GrokPickResult; readonly screen: string | null }> {
  return inPaneTurn(site.writer, paneID, async () => {
    const refused = (note: string) => ({ result: { type: "refused", note } as GrokPickResult, screen: null });
    if (expected.kind !== "grok" || !expected.isAgent || expected.run === undefined) return refused(runChangedText(expected));
    if (!(await site.fresh())) return refused("Not set: the app could not check that Grok is still in its pane.");
    if (!sameRun(expected, site)) return refused(runChangedText(expected));
    const found = mismatch(expected, site.pane(), site.agent());
    if (found !== null) return refused(`Not set: ${noReturnWhy[found]}.`);
    if (!atPrompt(site.pane(), site.agent())) return { result: { type: "busy" } as GrokPickResult, screen: null };
    // The user's Terminal input from here on stops the pick.
    const started = site.inputGeneration?.();
    const read = (): Promise<string> => site.calls.paneRead(paneID, cursorPickReadLines);
    return driveGrokPick(
      {
        read: () => (site.reading === undefined ? read() : site.reading(read)),
        type: (text) => site.writer.sendText(paneID, text),
        keys: (keys) => site.calls.paneSendKeys(paneID, keys),
        check: pickCheck(site, expected, started, true),
      },
      pick,
      files,
      wait,
      confirm,
    );
  });
}
