// A hit's line, read by offset and parsed with the agent's own parser,
// becomes the messages that match in it (who wrote each, when, its chat row's
// id and a snippet around the match), or nothing: a hit inside a tool's
// output, thinking or a field the chat does not show is dropped. The snippet
// is built from the parsed text, never from the raw JSON. A port of HerdrKit's
// ConversationSearchHits.swift; pasted text reads without its tags because
// the parser's user message is already unwrapped.

import type { ChatToolCall, TranscriptEvent } from "../chat/model";
import { TranscriptParser, type TranscriptFormat } from "../chat/parser";
import { throwIfCancelled } from "../remote-command";
import { foldText, occurrences, searchBounds, type SearchAuthor, type SearchHit, type SearchMatch, type SearchQuery, type SearchSnippet, type SearchTarget } from "./search";

/** One hit's line as read. */
export type SearchLine =
  /** The whole line (its line break and a trailing CR taken off). */
  | { readonly kind: "line"; readonly text: string }
  /** Longer than `maximumLineBytes`: "a very long message". */
  | { readonly kind: "tooLong" }
  /** Nothing at the offset any more (the file was replaced). */
  | { readonly kind: "gone" };

/** What one hit came to. */
export type SearchHitOutcome =
  | { readonly kind: "matches"; readonly matches: readonly SearchMatch[] }
  | { readonly kind: "longLine"; readonly match: SearchMatch }
  | { readonly kind: "unreadable" };

/** What a search reads of a machine's files (the chat's transcript reader). */
export interface SearchFileReader {
  /** Up to `maxBytes` of `path` from `offset`; fewer at the end of the file. */
  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array>;
}

const decoder = new TextDecoder();

function decodeLine(bytes: Uint8Array): string {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
  return decoder.decode(bytes.subarray(0, end));
}

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Reads the line that starts at `offset`: a first read of `firstRead`, then
 * (no line break yet) up to `maximum` + 1 bytes in all, enough to see the
 * break right after a line of exactly the maximum. Never more.
 */
export async function readLine(
  reader: SearchFileReader,
  path: string,
  offset: number,
  firstRead: number = searchBounds.firstLineReadBytes,
  maximum: number = searchBounds.maximumLineBytes,
  signal?: AbortSignal,
): Promise<SearchLine> {
  const parts: Uint8Array[] = [];
  let length = 0;
  let next = offset;
  let ask = Math.min(firstRead, maximum + 1);
  for (;;) {
    throwIfCancelled(signal);
    const bytes = await reader.read(path, next, ask);
    throwIfCancelled(signal);
    const newline = bytes.indexOf(0x0a);
    if (newline >= 0) {
      parts.push(bytes.subarray(0, newline));
      length += newline;
      return length > maximum ? { kind: "tooLong" } : { kind: "line", text: decodeLine(concat(parts, length)) };
    }
    parts.push(bytes);
    length += bytes.length;
    if (length > maximum) return { kind: "tooLong" };
    if (bytes.length < ask) {
      // The file's end: its last line, with no break yet.
      return length === 0 ? { kind: "gone" } : { kind: "line", text: decodeLine(concat(parts, length)) };
    }
    next += bytes.length;
    ask = maximum + 1 - length;
  }
}

/** Reads and parses one hit (`readLine`, then `lineMatches`). */
export async function hitOutcome(
  hit: SearchHit,
  path: string,
  target: SearchTarget,
  query: SearchQuery,
  reader: SearchFileReader,
  signal?: AbortSignal,
): Promise<SearchHitOutcome> {
  const line = await readLine(reader, path, hit.offset, searchBounds.firstLineReadBytes, searchBounds.maximumLineBytes, signal);
  switch (line.kind) {
    case "line":
      return { kind: "matches", matches: lineMatches(line.text, hit.offset, target.session.format, target.paneID, query) };
    case "tooLong":
      return { kind: "longLine", match: { paneID: target.paneID, lineOffset: hit.offset, messageID: null, author: null, time: null, snippet: null } };
    case "gone":
      return { kind: "matches", matches: [] };
  }
}

/**
 * The matches in one line: parsed with a parser of the agent (the ids it
 * gives the line read at `offset` are the chat's), then each message you typed
 * or sent, each reply and each command that holds the query. Tool outputs,
 * thinking, notices and titles are not searched.
 */
export function lineMatches(line: string, offset: number, format: TranscriptFormat, paneID: string, query: SearchQuery): SearchMatch[] {
  const parser = new TranscriptParser(format);
  const events = parser.parse(line, offset).events;
  const found: SearchMatch[] = [];
  for (const event of events) {
    const candidate = searchable(event);
    if (candidate === null) continue;
    const snip = snippet(candidate.text, query);
    if (snip === null) continue;
    // The input you wrote, to join with its copy written the other way.
    const input =
      candidate.author === "you" ? (parser.seamOpening.claude?.inputs.find((logged) => logged.input.itemID === candidate.id)?.input ?? null) : null;
    found.push({ paneID, lineOffset: offset, messageID: candidate.id, author: candidate.author, time: candidate.time, snippet: snip, input });
  }
  return found;
}

/** The text of an event that search looks in, with who wrote it. */
export function searchable(event: TranscriptEvent): { author: SearchAuthor; id: string; text: string; time: number | null } | null {
  switch (event.type) {
    case "userMessage":
      return { author: "you", id: event.message.id, text: event.message.text, time: event.message.time };
    case "agentText":
      return { author: "agent", id: event.text.id, text: event.text.markdown, time: event.text.time };
    case "toolStarted":
    case "userShell": {
      const command = commandText(event.call);
      return command === null ? null : { author: "command", id: event.call.id, text: command, time: event.call.time };
    }
    default:
      return null;
  }
}

/** A call's command: a shell command's text, or for one read as a read or a search (`cat`, `rg`) its program and target. */
export function commandText(call: ChatToolCall): string | null {
  if (call.detail.type === "bash" && call.detail.bash.command !== "") return call.detail.bash.command;
  if (call.kind === "bash" && call.target !== "") return call.target;
  if (call.program !== null && call.target !== "") return call.program + " " + call.target;
  return null;
}

// MARK: - the snippet

/** Characters of context kept before the match, at most. */
export const snippetBefore = 60;
/** Characters a snippet holds at most (the match always whole). */
export const snippetLength = 220;
/** A cut moves this far, at most, to fall between words. */
export const wordSlack = 16;

const newlines = new Set(["\n", "\r", "\r\n", "\u000b", "\u000c", "\u0085", " ", " "]);
const space = /^\s+$/u;

/**
 * A few lines of `text` around its first match, cut between characters (never
 * inside one), between words where it can, "…" where text was left out, runs
 * of blank space made one space or one line break; every match highlighted.
 * Null when `text` does not hold the query (case and diacritics folded).
 */
export function snippet(text: string, query: SearchQuery): SearchSnippet | null {
  const folded = foldText(text);
  const starts = occurrences(query.folded, folded.scalars);
  const first = starts[0];
  if (first === undefined) return null;
  const characters = folded.characters;
  const count = characters.length;
  const length = query.folded.length;
  const ranges = starts.map((at) => ({ lower: folded.owners[at]!, upper: folded.owners[at + length - 1]! }));
  const match = ranges[0]!;

  const isBreak = (index: number): boolean => newlines.has(characters[index]!);
  const isSpace = (index: number): boolean => space.test(characters[index]!);
  const lineStart = (index: number): number => {
    let at = index;
    while (at > 0 && !isBreak(at - 1)) at -= 1;
    return at;
  };
  const lineEnd = (index: number): number => {
    let at = index;
    while (at < count && !isBreak(at)) at += 1;
    return at;
  };
  const firstSpace = (from: number, to: number): number | null => {
    for (let index = from; index < to; index += 1) if (isSpace(index)) return index;
    return null;
  };

  // The start: the line before the match's (blank lines passed over) while it
  // fits in `snippetBefore`, else the match's line, else a cut moved forward to a word's start.
  const ownLine = lineStart(match.lower);
  let start = ownLine;
  if (match.lower - ownLine > snippetBefore) {
    start = match.lower - snippetBefore;
    const found = firstSpace(start, Math.min(start + wordSlack, match.lower));
    if (found !== null) start = found + 1;
  } else if (ownLine > 0) {
    let previous = ownLine - 1;
    while (previous > 0 && isSpace(previous - 1)) previous -= 1;
    const previousStart = lineStart(previous);
    if (match.lower - previousStart <= snippetBefore) {
      start = previousStart;
    } else if (match.lower - previous < snippetBefore) {
      start = match.lower - snippetBefore;
      const found = firstSpace(start, Math.min(start + wordSlack, previous));
      if (found !== null) start = found + 1;
    }
  }

  // The end: the match's line and the one after it while they fit in
  // `snippetLength`, else a cut moved back to a word's end.
  const limit = Math.max(match.upper + 1, start + snippetLength);
  let end = lineEnd(match.upper);
  if (end < count) {
    let next = end;
    while (next < count && isSpace(next)) next += 1;
    if (next < count) end = lineEnd(next);
  }
  if (end > limit) {
    end = Math.min(limit, count);
    const floor = Math.max(match.upper + 1, end - wordSlack);
    for (let index = end - 1; index > floor; index -= 1) {
      if (isSpace(index)) {
        end = index;
        break;
      }
    }
  }

  // Blank space folded: a run with a line break is one break, any other run one space.
  const shown: string[] = [];
  const origin: number[] = [];
  let run: { start: number; hasBreak: boolean } | null = null;
  for (let index = start; index < end; index += 1) {
    if (isSpace(index)) {
      run ??= { start: index, hasBreak: false };
      if (isBreak(index)) run.hasBreak = true;
      continue;
    }
    if (run !== null && shown.length > 0) {
      shown.push(run.hasBreak ? "\n" : " ");
      origin.push(run.start);
    }
    run = null;
    shown.push(characters[index]!);
    origin.push(index);
  }
  let cutStart = false;
  for (let index = 0; index < start; index += 1) {
    if (!isSpace(index)) {
      cutStart = true;
      break;
    }
  }
  let cutEnd = false;
  for (let index = end; index < count; index += 1) {
    if (!isSpace(index)) {
      cutEnd = true;
      break;
    }
  }
  const shift = cutStart ? 1 : 0;
  const highlights: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const low = origin.findIndex((at) => at >= range.lower);
    let high = -1;
    for (let index = origin.length - 1; index >= 0; index -= 1) {
      if (origin[index]! <= range.upper) {
        high = index;
        break;
      }
    }
    if (low < 0 || high < 0 || low > high || origin[low]! > range.upper) continue;
    highlights.push({ start: low + shift, end: high + 1 + shift });
  }
  let out = shown.join("");
  if (cutStart) out = "…" + out;
  if (cutEnd) out += "…";
  return { text: out, highlights };
}
