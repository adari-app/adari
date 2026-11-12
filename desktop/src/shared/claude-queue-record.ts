// Claude Code's own record of its queue, read to prove a take-back. Claude Code 2.1.322 writes each change to its
// queue into the session transcript as one line, `{"type":"queue-operation","operation":...,"sessionId","timestamp",...}`
// (claude-parser.ts already reads this line type for task notices):
//
// - `enqueue` with `content`: a message queued while Claude works.
// - `popAll` with `content`: the queue pulled back into Claude's input row to edit (Up). Nothing delivered.
// - `remove` with `"reason":"absorbed_mid_turn"` and `content`: Claude took a queued message mid-turn (delivered).
// - `dequeue` (no content): the queue taken at the turn's end, as the next prompt (delivered).
//
// A take-back takes the record's end before any read or key, and after Up reads only the whole lines written past
// it (by position in the file, never by clock). Proof is per text. In Claude Code 2.1.322, two queued messages and
// one Up give two popAll lines, one per message, in queue order, with the same timestamp, each holding only its own
// text, about 0.14 s after the key; a single popAll line holding the texts joined is still read when it is exactly
// the texts. A popAll line proves its own text pulled; a delivery line holding exactly a text proves that
// text delivered; a bare `dequeue` proves nothing about any text; anything else proves nothing.

import type { TranscriptFileReader } from "./chat/feed";
import type { TranscriptSessionRef } from "./chat/locator";
import { imagePaths, showsExactly } from "./claude-screen";

/** One line of Claude Code's queue record that a take-back reads; anything else is null. */
export type QueueEvent =
  /** The queue pulled into the input row (`content` its text; null: none written). */
  | { readonly kind: "popAll"; readonly content: string | null }
  /** A queued message Claude took mid-turn (`content` its text; null: none written). */
  | { readonly kind: "absorbed"; readonly content: string | null }
  /** The queue taken at the turn's end (as the next prompt). */
  | { readonly kind: "dequeue" }
  /** A message Claude got as your prompt (its text parts, joined by newlines). */
  | { readonly kind: "user"; readonly text: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A user line's own text: a string, or its text parts joined by newlines; null for a tool result or a meta line. */
function userText(line: Record<string, unknown>): string | null {
  if (line.isMeta === true || line.toolUseResult !== undefined) return null;
  const message = line.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string);
  if (content.some((part) => isRecord(part) && part.type === "tool_result")) return null;
  return texts.length === 0 ? null : texts.join("\n");
}

/** One transcript line as a take-back reads it (null: a line it does not read, or not JSON). */
export function queueEventOf(line: string): QueueEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type === "user") {
    const text = userText(parsed);
    return text === null ? null : { kind: "user", text };
  }
  if (parsed.type !== "queue-operation") return null;
  const content = typeof parsed.content === "string" ? parsed.content : null;
  switch (parsed.operation) {
    case "popAll":
      return { kind: "popAll", content };
    case "remove":
      return parsed.reason === "absorbed_mid_turn" ? { kind: "absorbed", content } : null;
    case "dequeue":
      return { kind: "dequeue" };
    default:
      return null;
  }
}

/**
 * The queue's `content` is exactly `texts` (yours, oldest first) joined by newlines. A message with pictures may
 * show each image path as Claude Code's `[Image #N]` chip instead (word for word otherwise, `showsExactly` with no
 * wrap); a message without one must be the same string.
 */
export function queuedAs(content: string, texts: readonly string[]): boolean {
  if (texts.length === 0) return false;
  if (content === texts.join("\n")) return true;
  return texts.some((text) => imagePaths(text).length > 0) && showsExactly(content, texts, null);
}

/**
 * What the record proves of each of your asked texts after Up, text
 * by text, never for the whole set. `pulled`: the indices into `asked` (a run, oldest first) whose popAll line is
 * written past the baseline, so they sit in Claude's input row, never delivered; `reachesNewest`: that run ends at
 * your newest asked text (a pull takes the whole queue, so only then can it be all of it). `delivered`: the indices
 * proved delivered, each by a line holding exactly its text (taken mid-turn, or your prompt). `other`: a popAll line
 * that is not your texts in order (Terminal's text with yours, or no content): nothing of the pull is yours alone.
 */
export interface QueueAccount {
  readonly pulled: readonly number[];
  readonly reachesNewest: boolean;
  readonly delivered: readonly number[];
  readonly other: boolean;
}

/** Nothing proved yet. */
export const noAccount: QueueAccount = { pulled: [], reachesNewest: false, delivered: [], other: false };

const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index);

/**
 * The asked indices the popAll lines `pulls` (their contents, in file order) prove pulled, or null when they are not
 * your texts in order. Claude Code 2.1.322 writes one popAll line per message, in queue order, each holding only its
 * own text: `pulls` is then a run of `asked`, one line per text, perhaps not all written yet. A single joined line
 * (the texts joined by newlines) is kept only when it is exactly them.
 * A run that reaches your newest text comes first (two copies of the same words: the newer are the queue's).
 */
function pulledBy(pulls: readonly string[], asked: readonly string[]): number[] | null {
  const count = pulls.length;
  const runAt = (at: number): boolean => at >= 0 && at + count <= asked.length && pulls.every((content, index) => queuedAs(content, [asked[at + index]!]));
  if (count > 0 && runAt(asked.length - count)) return range(asked.length - count, count);
  for (let at = 0; at + count <= asked.length; at += 1) if (count > 0 && runAt(at)) return range(at, count);
  if (count !== 1) return null;
  for (let at = 0; at < asked.length - 1; at += 1) if (queuedAs(pulls[0]!, asked.slice(at))) return range(at, asked.length - at);
  return null;
}

/**
 * What `lines` (whole lines written after the baseline, in file order) prove of `asked` (your queued texts, oldest
 * first), text by text. The popAll lines are matched first, as a run of your texts (`pulledBy`); then each delivery
 * line holding exactly one of your texts not yet proved (or several of them in order, joined, as one prompt) proves
 * those delivered, the oldest first. A popAll for a text wins over a delivery of the same words (a prompt line of the
 * same words written late, or another copy taken mid-turn, never stands for this queue). A bare `dequeue` has no
 * content and proves nothing about any text; another text Claude took (Terminal's queued line) says nothing either.
 *
 * One delivery may be written twice, as its `remove`
 * absorbed_mid_turn line and as your ordinary user line. The two kinds are counted apart (`deliveredBy`, each over
 * the texts not pulled), and each asked text is proved delivered as many times as the larger of the two counts for
 * its words, never their sum: with ["repeat", "repeat"], one remove and one user line of `repeat` prove one copy.
 */
export function queueAccount(lines: readonly string[], asked: readonly string[]): QueueAccount {
  const events = lines.map(queueEventOf).filter((event): event is QueueEvent => event !== null);
  const pulls = events.filter((event) => event.kind === "popAll");
  if (pulls.some((event) => event.content === null)) return { ...noAccount, other: true };
  const pulled = pulls.length === 0 ? [] : pulledBy(pulls.map((event) => event.content!), asked);
  if (pulled === null) return { ...noAccount, other: true };
  const removed = deliveredBy(events.map((event) => (event.kind === "absorbed" ? event.content : null)), asked, pulled);
  const prompted = deliveredBy(events.map((event) => (event.kind === "user" ? event.text : null)), asked, pulled);
  const delivered: number[] = [];
  for (const text of new Set(asked)) {
    const count = (indices: readonly number[]): number => indices.filter((index) => asked[index] === text).length;
    const copies = Math.max(count(removed), count(prompted));
    const open = asked.flatMap((each, index) => (each === text && !pulled.includes(index) ? [index] : []));
    delivered.push(...open.slice(0, copies));
  }
  return { pulled, reachesNewest: pulled.length > 0 && pulled.at(-1) === asked.length - 1, delivered: delivered.sort((a, b) => a - b), other: false };
}

/**
 * The asked indices one kind of delivery line proves (`contents`, null for a line of another kind), each line taking
 * the oldest run of asked texts it is exactly and none of them pulled or proved yet by this kind.
 */
function deliveredBy(contents: readonly (string | null)[], asked: readonly string[], pulled: readonly number[]): number[] {
  const proved = new Set(pulled);
  const delivered: number[] = [];
  for (const content of contents) {
    if (content === null) continue;
    for (const index of deliveredRun(content, asked, proved)) {
      proved.add(index);
      delivered.push(index);
    }
  }
  return delivered;
}

/** The oldest run of asked texts, none proved yet, that `content` is exactly (one, or several joined); [] for none. */
function deliveredRun(content: string, asked: readonly string[], proved: ReadonlySet<number>): number[] {
  for (let from = 0; from < asked.length; from += 1) {
    for (let to = from + 1; to <= asked.length; to += 1) {
      if (proved.has(to - 1)) break;
      if (queuedAs(content, asked.slice(from, to))) return range(from, to - from);
    }
  }
  return [];
}

/** The session transcript as a take-back reads it: where it ends, and the whole lines written past a point. */
export interface QueueRecord {
  /** The record's length now, in bytes (the baseline); null when it cannot be read. */
  end(): Promise<number | null>;
  /** The whole lines written from `from` on (a bounded read); null when it cannot be read or shrank below `from`. */
  since(from: number): Promise<readonly string[] | null>;
}

/** The most a take-back reads past its baseline in one read (a turn's lines in a few seconds are far fewer). */
export const queueRecordReadBytes = 1_024 * 1_024;

/**
 * The session `ref`'s transcript on `reader` as a QueueRecord: located once (null: no file, so no record), then
 * its size and the bytes past the baseline; a failed read is null, never an empty record.
 */
export function transcriptQueueRecord(reader: TranscriptFileReader<TranscriptSessionRef>, ref: TranscriptSessionRef): QueueRecord {
  let located: Promise<string | null> | null = null;
  const path = (): Promise<string | null> => {
    located ??= reader.locate(ref).catch(() => null);
    return located;
  };
  return {
    end: async () => {
      try {
        const at = await path();
        return at === null ? null : await reader.size(at);
      } catch {
        return null;
      }
    },
    since: async (from) => {
      try {
        const at = await path();
        if (at === null) return null;
        const size = await reader.size(at);
        if (size < from) return null;
        if (size === from) return [];
        const bytes = await reader.read(at, from, Math.min(size - from, queueRecordReadBytes));
        const text = new TextDecoder().decode(bytes);
        const whole = text.lastIndexOf("\n");
        return whole < 0 ? [] : text.slice(0, whole).split("\n").filter((line) => line.trim() !== "");
      } catch {
        return null;
      }
    },
  };
}
