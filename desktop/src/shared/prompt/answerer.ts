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

import {
  codexForm,
  codexFormTrace,
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

/** The prompts answered by their digit alone and then read until they go, by the agent whose reader reads them. */
type Settling = "grok" | "codex";

/** The reader that reads `kind`'s screens, when its answer is the digit alone and then reads; null for every other. */
function settlingReader(kind: PromptKind): Settling | null {
  if (kind === "grok") return "grok";
  if (kind === "codexForm") return "codex";
  return null;
}

/** The agent whose reader reads `kind`'s screens again (Codex's update question too); null: the general one. */
function readerOf(kind: PromptKind): Settling | null {
  return kind === "codexUpdate" ? "codex" : settlingReader(kind);
}

/** The Mac's refusals that come before any key is pressed (the Swift app's refusedBeforeSending). */
export const refusedBeforeSending: ReadonlySet<string> = new Set(["agent_dialog", "agent_blocked", "agent_word", "agent_unbound", "agent_unverified"]);

/** Re-reads the pane and sends `option`'s keys only while the prompt on screen is `match` and still offers it. */
export async function answerPrompt(io: PaneIO, option: PromptOption, match: PromptMatch, beforeSend: () => boolean = () => true): Promise<AnswerOutcome> {
  const paneID = match.fingerprint.paneID;
  let text: string;
  try {
    text = await io.read(paneID);
  } catch (error) {
    return { type: "unread", reason: describe(error) };
  }
  const reader = settlingReader(match.kind);
  const now = matchPrompt(text, paneID, readerOf(match.kind));
  const current = readingMatch(now);
  const live = current === null || current.kind !== match.kind || !sameFingerprint(current.fingerprint, match.fingerprint) ? null : optionByKey(current, option.key);
  if (live === null) return { type: "changed", now };
  // A choice answered in the Terminal has no keys here; nothing is sent.
  if (live.keys.length === 0 || live.inTerminal === true) return { type: "withdrawn" };
  if (!beforeSend()) return { type: "withdrawn" };
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
  | { readonly type: "unread" };

/** One read after Grok's digit (or Codex's form's, read with Codex's reader). */
async function grokScreen(io: PaneIO, match: PromptMatch, reader: Settling): Promise<GrokScreen> {
  const paneID = match.fingerprint.paneID;
  let text: string;
  try {
    text = await io.read(paneID);
  } catch {
    return { type: "unread" };
  }
  // A blank or control-only read proves nothing (the quiet rule's `readable`).
  if (!readable(text)) return { type: "unread" };
  const frame = reader === "grok" ? grokFrame(text, paneID) : codexForm(text, paneID);
  const now = matchPrompt(text, paneID, reader);
  if (frame === null) return (reader === "grok" ? grokTrace(text) : codexFormTrace(text)) ? { type: "still", now } : { type: "gone" };
  return sameFingerprint(frame.fingerprint, match.fingerprint) ? { type: "still", now } : { type: "another", now };
}

const wait = (io: PaneIO, ms: number): Promise<void> => (io.sleep === undefined ? new Promise((resolve) => setTimeout(resolve, ms)) : io.sleep(ms));

/**
 * After Grok's digit: reads (each after `grokSettleMs`, at most
 * `grokSettleReads`) until the frame is gone (it took). Another whole frame
 * ends them at once; a frame with the answered frame's fingerprint, part of a frame or a
 * screen that cannot be read leaves them running. Unless the frame went:
 * "unsettled", and nothing more is ever sent (no Enter, no other key).
 * Codex's form the same way, with Codex's reader.
 */
async function confirmSettled(io: PaneIO, match: PromptMatch, reader: Settling): Promise<AnswerOutcome> {
  let last: PromptReading | null = null;
  for (let read = 0; read < grokSettleReads; read += 1) {
    await wait(io, grokSettleMs);
    const screen = await grokScreen(io, match, reader);
    if (screen.type === "gone") return { type: "sent" };
    if (screen.type === "another") return { type: "unsettled", now: screen.now };
    if (screen.type === "still") last = screen.now;
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
