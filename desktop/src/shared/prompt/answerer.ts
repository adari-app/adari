// Answers only the prompt the user saw (App/CompanionPromptModel.swift:
// CompanionPromptAnswerer, CompanionPaneIO, CompanionAnswerOutcome): the pane is
// read again and the option's keys go (`pane.send_keys`) only while the prompt
// on screen still has the fingerprint of the one shown and still offers that
// option, and only while the caller's gate (`beforeSend`, run with nothing in
// between it and the send) still allows it; otherwise nothing is sent and the
// outcome carries what the pane shows now.
//
// Grok 1.0.70's approval frame (kind `grok`) takes the
// option's digit, then the screen is read: the frame gone, the answer took;
// anything else sends nothing more: "unsettled", the card says Answer in
// Terminal. Never Esc (Grok's scrollback).
// The digit is the whole answer (a live
// check: `4` alone closed the frame within 0.3 s), so nothing ever follows it.
// No Enter, however the screen reads: a frame with the same fingerprint after
// the digit may be the same question still waiting or a new one drawn the same
// (or one the user opened from Terminal meanwhile), and a read cannot tell which.
//
// The caller's `read` is the card's (readPromptScreen:
// 40 lines, then once the taller read when they end in Claude's frame cut off
// at its top), so a frame is read again as it was read when shown. A frame
// still cut is unmatched, so it never answers.
//
// Codex 0.166.0's tool-call question (kind `codexForm`)
// is answered the same way: read again with Codex's reader, the fingerprint
// (header, parameter rows, option labels and descriptions, the mark left out)
// must match and the gate must allow it, then the option's digit once (Codex
// selects and submits a one-field form on it), never Enter, never Esc (Esc
// cancels the call). Then the same reads: the form gone, it took; anything
// else is "unsettled" and nothing more is sent.
//
// Codex's update question (kind `codexUpdate`) is read
// again with Codex's reader too, and answered as a menu is (the keys once, no
// reads after): Return for the marked choice, Esc for Skip. A choice with no
// keys (answered in the Terminal) never sends anything.
//
// Claude Code 2.1.325's question dialog (kind `claudeAsk`) is answered as
// Codex's form is: read again with Claude's reader, the fingerprint (header,
// question, every option's label and description, `Type something.` and
// `Chat about this`, the mark left out) must match and the option must still
// be offered, the gate must allow it, then the option's digit once (Claude's
// choice lists take the number as select and confirm, as its menus do), never
// Enter, never Esc (Esc cancels the question). Then the same reads: the
// dialog gone, it took; anything else is "unsettled" and nothing more is sent.
//
// Antigravity CLI's questions are read again with agy's reader. Its permission
// questions (kind `agyAsk`) are answered as a menu is: the fingerprint must
// match and the option must still be offered, then the digit once, no reads
// after. Its folder trust question (kind `agyTrust`) takes no digit: the
// marked choice is Return, once, as a menu's keys. The other choice is the
// arrow toward it alone; then reads (each after `grokSettleMs`, at most
// `grokSettleReads`) until one shows the same question with the marker on
// that choice, and only then, the gate asked again, Return. A read showing
// another question, none, or the marker still elsewhere after the last read
// sends nothing more: "unsettled" (Answer in Terminal).
//
// Codex 0.171.0's own question in Plan mode (kind `codexQuestion`, its
// request_user_input tool) is answered as Codex's form is: read again with
// Codex's reader, the fingerprint (the header row with its numbers, the
// question, every numbered row and its description, Codex's own "None of the
// above" row too, the mark left out) must match and the option must still be
// offered, the gate must allow it, then the option's digit once (Codex chooses
// it and shows the next question, or submits every answer on the last), never
// Return, an arrow, Tab or Esc. Then the same reads, with one more proof: the
// next question (N+1 of the same M, one fewer unanswered: `codexQuestionNext`)
// whole on screen, or no part of the frame left (`codexQuestionTrace`, its
// "Submit with unanswered questions?" confirmation too), it took. The same
// question still shown, any other question, the notes row open or the
// confirmation: "unsettled", and nothing more is sent.
// Its "Implement this plan?" list (kind `codexPlan`) the same way: the digit
// once (the list's own number keys pick the row and accept it, as mode-pick.ts
// sends on the permissions list), then reads until the list is gone.
//
// "The same question" is matcher.ts
// `sameFingerprint` (the question's words, not how its rows wrap). The
// caller's `refused` hears each refusal because the question changed, with
// its place (`fresh`: the read before the key; `trustStep`: agy's trust read
// between the arrow and Return) and the question the read showed, if any
// (refusals.ts records it).

import {
  agyKind,
  agyTrust,
  claudeAsk,
  claudeAskTrace,
  codexForm,
  codexFormTrace,
  codexPlan,
  codexPlanTrace,
  codexQuestion,
  codexQuestionNext,
  codexQuestionTrace,
  grokFrame,
  grokTrace,
  matchPrompt,
  optionByKey,
  readingMatch,
  sameFingerprint,
  type PromptKind,
  type PromptMatch,
  type PromptOption,
  type PromptReading,
} from "./matcher";
import { readable } from "./quiet";

/** The two pane calls an answer needs, bound to one connection (a send that would reach another one throws instead). */
export interface PaneIO {
  read(paneID: string): Promise<string>;
  sendKeys(keys: readonly string[], paneID: string): Promise<void>;
  /** The wait between Grok's (or Codex's form's) key and the read that checks it (a timer when absent). */
  sleep?(ms: number): Promise<void>;
  /**
   * The pane's width in columns now (Herdr's `pane.layout`, its cell rectangle), null when not known: read before
   * and after each read of the screen, and given to the readers only when both agree (`readWithColumns`).
   */
  columns?(paneID: string): Promise<number | null>;
}

/** A screen as read, and the pane's width it was read at (null: not known, or it changed during the read). */
export interface ColumnsRead {
  readonly text: string;
  readonly columns: number | null;
}

/**
 * Reads the screen between two reads of the pane's width, and keeps the width only when both are the same (the
 * screen was drawn at it, unless the pane was resized and back during the read, which leaves the rows wider or
 * narrower than the frame's own text: the readers check no row is wider). A failed width read is no width.
 */
export async function readWithColumns(read: () => Promise<string>, columns: (() => Promise<number | null>) | undefined): Promise<ColumnsRead> {
  const width = async (): Promise<number | null> => {
    if (columns === undefined) return null;
    try {
      return await columns();
    } catch {
      return null;
    }
  };
  const before = await width();
  const text = await read();
  const after = before === null ? null : await width();
  return { text, columns: before !== null && before === after ? before : null };
}

/** `io`'s read of `paneID` with its width (`readWithColumns`). */
function readPane(io: PaneIO, paneID: string): Promise<ColumnsRead> {
  return readWithColumns(() => io.read(paneID), io.columns === undefined ? undefined : () => io.columns!(paneID));
}

export type AnswerOutcome =
  | { readonly type: "sent" }
  /** The pane no longer shows the prompt the answer was for. Nothing was sent. */
  | { readonly type: "changed"; readonly now: PromptReading }
  /** Nothing was sent: the pane could not be read. */
  | { readonly type: "unread"; readonly reason: string }
  /** The keys went out but the send did not confirm. */
  | { readonly type: "unconfirmed"; readonly reason: string }
  /** Nothing was sent: the caller's gate refused after the re-read (its connection changed, the answer was withdrawn). */
  | { readonly type: "withdrawn" }
  /** Nothing was sent: the machine refused the keys before pressing any, in these words. */
  | { readonly type: "refused"; readonly reason: string }
  /**
   * Grok's digit went, but the screen did not show the
   * frame gone: nothing more was sent (Answer in Terminal). `now` is what the
   * last read showed; null when none could be read.
   */
  | { readonly type: "unsettled"; readonly now: PromptReading | null };

/** Grok's time to redraw after its digit, before each read that checks it (Codex's form's too). */
export const grokSettleMs = 300;
/** The reads after Grok's digit (or Codex's form's), at most, for its frame to go. */
export const grokSettleReads = 5;

/** The prompts answered by their digit alone and then read until they go. */
type Settling = "grok" | "codexForm" | "codexQuestion" | "codexPlan" | "claudeAsk";

/** `kind`, when its answer is the digit alone and then reads; null for every other. */
function settlingReader(kind: PromptKind): Settling | null {
  return kind === "grok" || kind === "codexForm" || kind === "codexQuestion" || kind === "codexPlan" || kind === "claudeAsk" ? kind : null;
}

/** One settling prompt: the agent whose reader reads it, its whole frame and any part of it, and what else proves its answer took. */
interface Settler {
  readonly agent: string;
  readonly frame: (text: string, paneID: string, columns: number | null) => PromptMatch | null;
  readonly trace: (text: string) => boolean;
  /** Another whole frame that proves the answer took (Codex's next question); absent: none does. */
  readonly next?: (answered: PromptMatch, now: PromptMatch) => boolean;
}

const settlers: Readonly<Record<Settling, Settler>> = {
  grok: { agent: "grok", frame: grokFrame, trace: grokTrace },
  codexForm: { agent: "codex", frame: codexForm, trace: codexFormTrace },
  codexQuestion: { agent: "codex", frame: codexQuestion, trace: codexQuestionTrace, next: codexQuestionNext },
  codexPlan: { agent: "codex", frame: codexPlan, trace: codexPlanTrace },
  claudeAsk: { agent: "claude", frame: claudeAsk, trace: claudeAskTrace },
};

/** The agent whose reader reads `kind`'s screens again (Codex's update question too, agy's questions); null: the general one. */
function readerOf(kind: PromptKind): string | null {
  if (kind === "agyAsk" || kind === "agyTrust") return agyKind;
  if (kind === "codexUpdate") return "codex";
  const settling = settlingReader(kind);
  return settling === null ? null : settlers[settling].agent;
}

/** The Mac's refusals that come before any key is pressed (the Swift app's refusedBeforeSending). */
export const refusedBeforeSending: ReadonlySet<string> = new Set(["agent_dialog", "agent_blocked", "agent_word", "agent_unbound", "agent_unverified"]);

/** A refusal because the question changed: where, and the question the read showed (null: none). */
export type AnswerRefused = (place: "fresh" | "trustStep", now: PromptMatch | null) => void;

/** Re-reads the pane and sends `option`'s keys only while the prompt on screen is `match` and still offers it. */
export async function answerPrompt(
  io: PaneIO,
  option: PromptOption,
  match: PromptMatch,
  beforeSend: () => boolean = () => true,
  refused: AnswerRefused = () => undefined,
): Promise<AnswerOutcome> {
  const paneID = match.fingerprint.paneID;
  let screen: ColumnsRead;
  try {
    screen = await readPane(io, paneID);
  } catch (error) {
    return { type: "unread", reason: describe(error) };
  }
  const reader = settlingReader(match.kind);
  const now = matchPrompt(screen.text, paneID, readerOf(match.kind), screen.columns);
  const current = readingMatch(now);
  const live = current === null || current.kind !== match.kind || !sameFingerprint(current.fingerprint, match.fingerprint) ? null : optionByKey(current, option.key);
  if (live === null) {
    refused("fresh", current);
    return { type: "changed", now };
  }
  // A choice answered in the Terminal has no keys here; nothing is sent.
  if (live.keys.length === 0 || live.inTerminal === true) return { type: "withdrawn" };
  if (!beforeSend()) return { type: "withdrawn" };
  // agy's trust question, the unmarked choice: the arrow, a read that shows the marker there, then Return.
  if (match.kind === "agyTrust" && !live.isReturnDefault) return arrowThenReturn(io, live, match, beforeSend, refused);
  try {
    await io.sendKeys(live.keys, paneID);
  } catch (error) {
    return outcomeOf(error);
  }
  return reader === null ? { type: "sent" } : confirmSettled(io, match, reader);
}

/** What a read after Grok's digit shows, against the frame the user answered. */
type GrokScreen =
  /** No part of Grok's frame on screen: the answer took. */
  | { readonly type: "gone" }
  /** The frame with the answered frame's fingerprint (the mark anywhere), or a frame partly drawn: not proof of anything. */
  | { readonly type: "still"; readonly now: PromptReading }
  /** Another frame (another title, command or options) whole on screen. */
  | { readonly type: "another"; readonly now: PromptReading }
  /** The frame that follows an answer that took (Codex's next question) whole on screen. */
  | { readonly type: "next" }
  | { readonly type: "unread" };

/** One read after Grok's digit (or Codex's form's, read with Codex's reader; Claude's question dialog's with Claude's). */
async function grokScreen(io: PaneIO, match: PromptMatch, reader: Settling): Promise<GrokScreen> {
  const paneID = match.fingerprint.paneID;
  let read: ColumnsRead;
  try {
    read = await readPane(io, paneID);
  } catch {
    return { type: "unread" };
  }
  const text = read.text;
  // A blank or control-only read proves nothing (the quiet rule's `readable`).
  if (!readable(text)) return { type: "unread" };
  const settler = settlers[reader];
  const frame = settler.frame(text, paneID, read.columns);
  const now = matchPrompt(text, paneID, settler.agent, read.columns);
  if (frame === null) return settler.trace(text) ? { type: "still", now } : { type: "gone" };
  if (sameFingerprint(frame.fingerprint, match.fingerprint)) return { type: "still", now };
  return settler.next?.(match, frame) === true ? { type: "next" } : { type: "another", now };
}

const wait = (io: PaneIO, ms: number): Promise<void> => (io.sleep === undefined ? new Promise((resolve) => setTimeout(resolve, ms)) : io.sleep(ms));

/**
 * After Grok's digit: reads (each after `grokSettleMs`, at most
 * `grokSettleReads`) until the frame is gone (it took). Another whole frame
 * ends them at once; a frame with the answered frame's fingerprint, part of a frame or a
 * screen that cannot be read leaves them running. Unless the frame went:
 * "unsettled", and nothing more is ever sent (no Enter, no other key).
 * Codex's form the same way, with Codex's reader, and Claude's question dialog with Claude's.
 */
async function confirmSettled(io: PaneIO, match: PromptMatch, reader: Settling): Promise<AnswerOutcome> {
  let last: PromptReading | null = null;
  for (let read = 0; read < grokSettleReads; read += 1) {
    await wait(io, grokSettleMs);
    const screen = await grokScreen(io, match, reader);
    if (screen.type === "gone" || screen.type === "next") return { type: "sent" };
    if (screen.type === "another") return { type: "unsettled", now: screen.now };
    if (screen.type === "still") last = screen.now;
  }
  return { type: "unsettled", now: last };
}

/**
 * agy's trust question, the choice the marker is not on (`option.keys`: the arrow toward it, then Return): the arrow
 * alone, then reads until one shows this question (its fingerprint) with the marker on `option`; then, the gate asked
 * again with nothing awaited after it, Return. Another question or none on screen, a gate that refuses, or the marker
 * still elsewhere after the last read: nothing more goes ("unsettled": the arrow went, Answer in Terminal).
 */
async function arrowThenReturn(io: PaneIO, option: PromptOption, match: PromptMatch, beforeSend: () => boolean, refused: AnswerRefused): Promise<AnswerOutcome> {
  const paneID = match.fingerprint.paneID;
  const arrow = option.keys[0];
  if (option.keys.length !== 2 || (arrow !== "Down" && arrow !== "Up") || option.keys[1] !== "Enter") return { type: "withdrawn" };
  try {
    await io.sendKeys([arrow], paneID);
  } catch (error) {
    return outcomeOf(error);
  }
  let last: PromptReading | null = null;
  for (let read = 0; read < grokSettleReads; read += 1) {
    await wait(io, grokSettleMs);
    let text: string;
    try {
      text = await io.read(paneID);
    } catch {
      continue;
    }
    if (!readable(text)) continue;
    last = matchPrompt(text, paneID, agyKind);
    const now = agyTrust(text, paneID);
    // Another question, or none: the arrow went, Return never does.
    if (now === null || !sameFingerprint(now.fingerprint, match.fingerprint)) {
      refused("trustStep", now ?? readingMatch(last));
      return { type: "unsettled", now: last };
    }
    if (optionByKey(now, option.key)?.isReturnDefault !== true) continue;
    if (!beforeSend()) return { type: "unsettled", now: last };
    try {
      await io.sendKeys(["Enter"], paneID);
    } catch (error) {
      return outcomeOf(error);
    }
    return { type: "sent" };
  }
  return { type: "unsettled", now: last };
}

/** A key send that failed: a refusal the machine gave before pressing anything says why (nothing went); anything else may have gone. */
export function outcomeOf(error: unknown): AnswerOutcome {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  if (typeof code === "string" && refusedBeforeSending.has(code)) {
    const message = (error as { serverMessage?: unknown }).serverMessage;
    return { type: "refused", reason: typeof message === "string" ? message : describe(error) };
  }
  return { type: "unconfirmed", reason: describe(error) };
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
