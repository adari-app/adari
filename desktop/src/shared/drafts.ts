// The drafts the main process keeps through a quit
// or a crash (src/main/drafts.ts), as both sides see them. A draft is the
// pane's text, its chips already uploaded (by their paths on the machine) and
// the names of local files that had not uploaded (they are not kept: the
// restored draft names them in its chip row).
//
// Bounds: a draft keeps at most 100,000 bytes of text (the most one Send
// carries; a longer one is kept cut, and says so) and 10 chips; the file at
// most 200 drafts and 2 MB, the least recently saved going first. Kept drafts
// (a draft whose pane was gone when its machine answered) follow the Swift
// app's Kept items bound: 50 items and 256 KB; with no room the draft stays a
// draft until there is.

export const draftSaveDelayMs = 500;
export const maxDraftTextBytes = 100_000;
export const maxDraftChips = 10;
export const maxSavedDrafts = 200;
export const maxDraftsBytes = 2 * 1_024 * 1_024;
export const keptLimit = 50;
export const keptByteLimit = 256 * 1_024;
/** The names of files not kept, at most (the same on save and on load). */
export const maxLostNames = 64;

const maxPathBytes = 4_096;
const maxNameLength = 255;
const maxIdLength = 256;

/** A chip already on the machine. */
export interface SavedChip {
  readonly path: string;
  readonly name: string;
  readonly image: boolean;
}

/** What the page sends for a pane's draft. */
export interface DraftInput {
  readonly text: string;
  readonly chips: readonly SavedChip[];
  /** Local files not uploaded: not kept, named when the draft comes back. */
  readonly lost: readonly string[];
}

export interface SavedDraft extends DraftInput {
  readonly hostId: string;
  readonly paneId: string;
  /** Kept cut to `maxDraftTextBytes`. */
  readonly cut?: boolean;
  /** The agent it is for, when known ("claude"): Kept drafts names it. */
  readonly agent?: string;
  /** When it was last saved (ms since 1970). */
  readonly savedAt: number;
}

/** A draft whose pane was gone when its machine answered. */
export interface KeptDraft {
  readonly id: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly paneId: string;
  /** The agent it was for, when known ("claude"). */
  readonly agentName: string | null;
  readonly text: string;
  readonly chips: readonly SavedChip[];
  readonly reason: string;
  readonly at: number;
}

export interface DraftsState {
  readonly drafts: readonly SavedDraft[];
  readonly kept: readonly KeptDraft[];
}

/** What the main process says when its drafts changed: all of them, and the panes whose drafts went to Kept drafts. */
export interface DraftsChangedEvent {
  readonly state: DraftsState;
  readonly gone: readonly { readonly hostId: string; readonly paneId: string }[];
}

export type KeptDraftAction = "take" | "discard";

/**
 * A typed `/compact` line held for the end of Claude's turn that did not go while your box held newer text: a
 * Kept draft of its own (main's DraftStore.keep), kept until you put it in the box or discard it.
 */
export const compactKeptReason = "Compact not sent.";
/**
 * A held typed `/compact` whose Return may have reached the agent (main could not confirm it): kept as the refused
 * one is, with a reason that never says it was not sent.
 */
export const compactUnsureReason = "Compact may have gone. Check the agent before sending it again.";

/**
 * What the page knows of a held Compact that did not confirm: refused before any key
 * went ("refused"), or its outcome not known ("unknown"). The page passes only this through IPC.draftKeep; main
 * picks the reason.
 */
export type CompactOutcome = "refused" | "unknown";

/**
 * Main's reason for a kept Compact. Only the exact value "refused" says not sent;
 * anything else from the page (a missing, misspelled or foreign value) is taken as unknown, the safer reading.
 */
export function compactReasonFor(outcome: unknown): string {
  return outcome === "refused" ? compactKeptReason : compactUnsureReason;
}

const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

export function isSavedChip(value: unknown): value is SavedChip {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isString(v["path"], maxPathBytes) && v["path"] !== "" && isString(v["name"], maxNameLength) && typeof v["image"] === "boolean";
}

/** A draft from the page (a longer text than 4× the bound is refused outright; up to it, it is cut). */
export function isDraftInput(value: unknown): value is DraftInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isString(v["text"], 2 * maxDraftTextBytes) &&
    Array.isArray(v["chips"]) &&
    v["chips"].length <= 64 &&
    v["chips"].every(isSavedChip) &&
    Array.isArray(v["lost"]) &&
    v["lost"].length <= maxLostNames &&
    v["lost"].every((name) => isString(name, maxNameLength))
  );
}

export function isId(value: unknown): value is string {
  return isString(value, maxIdLength) && value !== "";
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function isSavedDraft(value: unknown): value is SavedDraft {
  if (!isDraftInput(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return (
    isId(v["hostId"]) &&
    isId(v["paneId"]) &&
    isTime(v["savedAt"]) &&
    (v["cut"] === undefined || typeof v["cut"] === "boolean") &&
    (v["agent"] === undefined || isString(v["agent"], maxNameLength))
  );
}

export function isKeptDraft(value: unknown): value is KeptDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isId(v["id"]) &&
    isId(v["hostId"]) &&
    isString(v["hostLabel"], maxNameLength) &&
    isId(v["paneId"]) &&
    (v["agentName"] === null || isString(v["agentName"], maxNameLength)) &&
    isString(v["text"], 2 * maxDraftTextBytes) &&
    Array.isArray(v["chips"]) &&
    v["chips"].every(isSavedChip) &&
    isString(v["reason"], 400) &&
    isTime(v["at"])
  );
}

const encoder = new TextEncoder();

/** The size of `text` as UTF-8. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** `text` within `limit` bytes of UTF-8, whole characters only. */
export function cutToBytes(text: string, limit: number): string {
  if (utf8Bytes(text) <= limit) return text;
  let used = 0;
  let out = "";
  for (const character of text) {
    const size = utf8Bytes(character);
    if (used + size > limit) break;
    used += size;
    out += character;
  }
  return out;
}
