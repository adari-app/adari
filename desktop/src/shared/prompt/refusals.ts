// Each answer not sent because the question changed, recorded
// (the Swift twin: HerdrKit's
// PromptRefusalRecord and the phone's CompanionPromptRefusals). One record
// per refusal: when, the agent's kind, which place refused, which part of the
// two readings differed, and each reading's row count and widest row in
// cells. Never any screen text, command, path, pane title or machine name:
// the record's fields are numbers and words from fixed lists only.
//
// The places on the Mac:
// - `shown`: main's last reading of the pane against the reading the card
//   showed (PromptService.answerNow, before anything is read again);
// - `fresh`: the answerer's fresh read right before the key (answerPrompt);
// - `trustStep`: agy's trust question, the read between the arrow and Return
//   that shows another question or none (Return never goes).
// The phone's twins (HerdrKit's PromptRefusalRecord): `shown` (the card's
// block against the latest snapshot's, before the read: its card is its own
// last reading, so only the block can differ there), `fresh` (a card's
// answer: the read before its key, and its last gate), `key` (a quick key
// under the card), `queued` (an answer queued while the Mac was offline, at
// its send) and `trustStep`.
//
// Kept in memory, the last `refusalLimit` (the app has no list it keeps across
// a restart for such things). Report a Problem carries them (feedback.ts).

import { agentKindEntry } from "../agent-names";
import { fingerprintDifference, type PromptFingerprint, type PromptKind } from "./matcher";
import { rowShape } from "./words";

export type RefusalPlace = "shown" | "fresh" | "trustStep" | "key" | "queued";
/** Which part differed; `none`: no question was shown (another block, or nothing matched). */
export type RefusalPart = "pane" | "kind" | "question" | "body" | "options" | "none";

/** One reading as a record holds it: how many rows count (the question's one, the body's, the options') and the widest in cells. */
export interface ReadingShape {
  readonly rows: number;
  readonly widest: number;
}

export interface PromptRefusal {
  /** Milliseconds since 1970. */
  readonly at: number;
  /** The agent's kind ("claude", "codex", "grok", "agy"...), `unknown` when Herdr did not say, `other` for anything not a plain kind word. */
  readonly agent: string;
  readonly place: RefusalPlace;
  readonly part: RefusalPart;
  /** The reading the answer was for. */
  readonly shown: ReadingShape;
  /** The reading that refused it; null when no question was shown. */
  readonly now: ReadingShape | null;
}

/** How many records are kept (the oldest goes first). */
export const refusalLimit = 50;

/** A reading's side of a comparison: its kind and fingerprint. */
export interface ReadingSide {
  readonly kind: PromptKind;
  readonly fingerprint: PromptFingerprint;
}

/** The part where `now` stops being the question `shown` was; `none` when no question is shown. */
export function refusalPart(shown: ReadingSide, now: ReadingSide | null): RefusalPart {
  if (now === null) return "none";
  if (shown.fingerprint.paneID !== now.fingerprint.paneID) return "pane";
  if (shown.kind !== now.kind) return "kind";
  // The same question, and still refused: the option asked for is not among its options.
  return fingerprintDifference(shown.fingerprint, now.fingerprint) ?? "options";
}

/** A fingerprint's shape: its question's row, its body's and options' rows that count, the widest of them in cells. */
export function readingShape(fingerprint: PromptFingerprint): ReadingShape {
  return rowShape([fingerprint.question, ...fingerprint.body, ...fingerprint.options]);
}

/**
 * The agent's kind as a record keeps it, from a fixed set: a kind in the known agent kinds (agent-names.ts
 * `agentKinds`, the kinds Herdr reports; an alias as the kind it names), `unknown` for none or an empty one, else
 * `other`. A kind word outside the set never reaches a record (it could name a project or a person).
 */
export function refusalAgent(kind: string | null | undefined): string {
  if (kind === null || kind === undefined || kind === "") return "unknown";
  return agentKindEntry(kind)?.kind ?? "other";
}

/** The record of one refusal. */
export function refusalRecord(at: number, agent: string | null | undefined, place: RefusalPlace, shown: ReadingSide, now: ReadingSide | null): PromptRefusal {
  return { at, agent: refusalAgent(agent), place, part: refusalPart(shown, now), shown: readingShape(shown.fingerprint), now: now === null ? null : readingShape(now.fingerprint) };
}

/** The last `refusalLimit` records, oldest first. */
export class RefusalLog {
  private readonly records: PromptRefusal[] = [];

  record(refusal: PromptRefusal): void {
    this.records.push(refusal);
    if (this.records.length > refusalLimit) this.records.splice(0, this.records.length - refusalLimit);
  }

  list(): readonly PromptRefusal[] {
    return [...this.records];
  }
}

/** A record's time as the report writes it: UTC to the second. */
function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

/** How a record is written in Report a Problem: counts and fixed words only. The Swift twin writes it the same. */
export function refusalLine(refusal: PromptRefusal): string {
  const now = refusal.now;
  const rows = `${refusal.shown.rows}/${now === null ? "-" : now.rows}`;
  const widest = `${refusal.shown.widest}/${now === null ? "-" : now.widest}`;
  return `- ${stamp(refusal.at)} ${refusal.agent} ${refusal.place} ${refusal.part}, rows ${rows}, widest ${widest}`;
}

/** The line over them: how many are kept, and by part (in the parts' order). */
export function refusalSummary(refusals: readonly PromptRefusal[]): string {
  const parts: readonly RefusalPart[] = ["pane", "kind", "question", "body", "options", "none"];
  const counts = parts.map((part) => [part, refusals.filter((refusal) => refusal.part === part).length] as const).filter(([, count]) => count > 0);
  return `- Kept: ${refusals.length} (the last ${refusalLimit}). By part: ${counts.map(([part, count]) => `${part} ${count}`).join(", ")}.`;
}
