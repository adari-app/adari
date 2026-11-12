// Search across conversations (a port of HerdrKit's ConversationSearch.swift):
// every conversation on a machine, searched from one field. One
// SSH exec per machine per search runs a stock `/usr/bin/grep` over the
// transcripts of the panes the sidebar lists (the files the locator's globs
// name, or the path Herdr gave); its output is where each matching line
// starts. The lines are then read by offset and parsed with the agent's own
// parser (hits.ts), so a result is a message, a reply or a command, never raw
// JSON. Nothing is written to the machine and nothing is indexed.

import { isSameInput, type ShownMessage } from "../chat/claude-parser";
import { isPiFormat } from "../chat/agents/pi-locator";
import {
  folderGlobs,
  isUsablePath,
  parseLocateOutput,
  shellQuote,
  transcriptGlobs,
  type TranscriptSessionRef,
} from "../chat/locator";
import type { RemoteCommand, RemoteSearchTarget } from "../remote-command";
import { isGeminiFamilyFormat } from "../chat/agents/gemini-family";
import { isStoreAgentFormat } from "../chat/agents/store-agents";
import { isOpenCodeFormat } from "../chat/agents/opencode-locate";

/** The numbers that bound one search on one machine (ConversationSearchBounds). */
export const searchBounds = {
  /** A query shorter than this (after trimming) searches nothing. */
  minimumCharacters: 2,
  /** A longer query is cut to this many characters. */
  maximumQueryCharacters: 200,
  /** Files (panes) searched per machine; the rest are counted as not searched. */
  maximumFiles: 30,
  /** Matching lines per file (`grep -m`). */
  maximumHitsPerFile: 50,
  /** The exec's output read at most; past it the channel is closed ("more results not shown"). */
  maximumOutputBytes: 512 * 1_024,
  /** The exec, and each line read, gets this long. */
  timeoutMs: 10_000,
  /** CPU seconds the remote command may use (`ulimit -t`). */
  remoteCPUSeconds: 20,
  /** A hit's line read at most; a longer line is "a very long message". */
  maximumLineBytes: 1_024 * 1_024,
  /** The first read of a hit's line (most lines end within it). */
  firstLineReadBytes: 64 * 1_024,
  /** Lines read at once per machine. */
  concurrentReads: 3,
  /** Typing pauses this long before a query is searched (an edit cancels the old search at once). */
  pauseMs: 300,
  /** Matching messages shown per pane before "N more in this pane". */
  shownPerPane: 5,
  /** Bytes each grep output line keeps after its file's path. */
  cutMargin: 48,
  /** Patterns given to grep at most (the query's spellings). */
  maximumPatterns: 8,
} as const;

// MARK: - folding

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text's characters (grapheme clusters), as Swift counts them. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Text folded for matching, each folded code point remembering the character it came from. */
export interface FoldedText {
  readonly characters: readonly string[];
  readonly scalars: readonly number[];
  /** For each folded scalar, the index in `characters` it came from. */
  readonly owners: readonly number[];
}

const marks = /\p{M}/gu;

/** One character lowered, its diacritics and width taken away (ASCII at once). */
export function foldCharacter(character: string): number[] {
  if (character.length === 1) {
    const code = character.charCodeAt(0);
    if (code < 128) return [code >= 65 && code <= 90 ? code + 32 : code];
  }
  const folded = character.normalize("NFKD").replace(marks, "").toLowerCase();
  return Array.from(folded, (scalar) => scalar.codePointAt(0)!);
}

export function foldText(text: string): FoldedText {
  const characters: string[] = [];
  const scalars: number[] = [];
  const owners: number[] = [];
  for (const character of graphemes(text)) {
    const index = characters.length;
    characters.push(character);
    for (const scalar of foldCharacter(character)) {
      scalars.push(scalar);
      owners.push(index);
    }
  }
  return { characters, scalars, owners };
}

/** The start of every non-overlapping occurrence of `query` in `text`. */
export function occurrences(query: readonly number[], text: readonly number[]): number[] {
  if (query.length === 0 || text.length < query.length) return [];
  const found: number[] = [];
  let start = 0;
  const last = text.length - query.length;
  while (start <= last) {
    let matched = true;
    for (let offset = 0; offset < query.length; offset += 1) {
      if (text[start + offset] !== query[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      found.push(start);
      start += query.length;
    } else {
      start += 1;
    }
  }
  return found;
}

// MARK: - the query

const encoder = new TextEncoder();
const hasControl = (text: string): boolean => Array.from(text).some((scalar) => scalar.codePointAt(0)! < 0x20 || scalar.codePointAt(0) === 0x7f);

/** What was typed, trimmed, and how it is matched: case and diacritics folded, the whole query as one phrase. */
export class SearchQuery {
  private constructor(
    /** The query as searched (trimmed, cut to the maximum). */
    readonly text: string,
    /** `text` folded, as matched on parsed text. */
    readonly folded: readonly number[],
  ) {}

  /** Null when fewer than `minimumCharacters` are left after trimming. */
  static make(raw: string): SearchQuery | null {
    let characters = graphemes(raw.trim());
    if (characters.length < searchBounds.minimumCharacters) return null;
    if (characters.length > searchBounds.maximumQueryCharacters) characters = characters.slice(0, searchBounds.maximumQueryCharacters);
    const text = characters.join("");
    const folded = foldText(text).scalars;
    if (folded.length === 0) return null;
    return new SearchQuery(text, folded);
  }

  /**
   * What grep looks for in the transcript's bytes (`-F -i`, `LC_ALL=C`: ASCII
   * letters fold, nothing else does): the query, its lower and upper case,
   * each composed and decomposed, and its letters without diacritics, each
   * also as JSON writes it inside a string. A spelling with a control
   * character is only searched escaped. Spellings equal under ASCII case go
   * once; at most `maximumPatterns`.
   */
  get remotePatterns(): string[] {
    const spellings: string[] = [];
    for (const spelling of [this.text, this.text.toLowerCase(), this.text.toUpperCase()]) {
      spellings.push(spelling.normalize("NFC"), spelling.normalize("NFD"));
    }
    const plain = this.text.normalize("NFD").replace(marks, "").normalize("NFC");
    spellings.push(plain, plain.toLowerCase());
    const patterns: string[] = [];
    const seen = new Set<string>();
    const add = (pattern: string): void => {
      if (pattern === "" || patterns.length >= searchBounds.maximumPatterns) return;
      const key = Array.from(encoder.encode(pattern), (byte) => (byte >= 65 && byte <= 90 ? byte + 32 : byte)).join(",");
      if (seen.has(key)) return;
      seen.add(key);
      patterns.push(pattern);
    };
    for (const spelling of spellings) {
      if (!hasControl(spelling)) add(spelling);
      add(SearchQuery.jsonEscaped(spelling));
    }
    return patterns;
  }

  /** `text` as a JSON string's body: `"` and `\` escaped, the short escapes, `\u00xx` for other control characters. */
  static jsonEscaped(text: string): string {
    let out = "";
    for (const scalar of text) {
      switch (scalar) {
        case '"':
          out += '\\"';
          break;
        case "\\":
          out += "\\\\";
          break;
        case "\n":
          out += "\\n";
          break;
        case "\r":
          out += "\\r";
          break;
        case "\t":
          out += "\\t";
          break;
        case "\b":
          out += "\\b";
          break;
        case "\f":
          out += "\\f";
          break;
        default: {
          const code = scalar.codePointAt(0)!;
          out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : scalar;
        }
      }
    }
    return out;
  }
}

// MARK: - what is searched

/** One pane's transcript to search on its machine. */
export interface SearchTarget {
  readonly paneID: string;
  readonly session: TranscriptSessionRef;
}

/** Where one matching line starts: which target's file, its line number and its byte offset (grep's `-n` and `-b`). */
export interface SearchHit {
  readonly target: number;
  readonly lineNumber: number;
  readonly offset: number;
}

/** What one exec found: each searched target's file and the hits in it, in the file's order. */
export interface SearchListing {
  /** The file found for each target index (a target with no file is absent). */
  readonly files: ReadonlyMap<number, string>;
  readonly hits: readonly SearchHit[];
  /** The output passed the cap: more matched than is listed. */
  readonly truncated: boolean;
}

const sameSession = (a: TranscriptSessionRef, b: TranscriptSessionRef): boolean => JSON.stringify(a) === JSON.stringify(b);

const fileDecoder = new TextDecoder("utf-8", { fatal: true });

/** The one remote command of a search on one machine, and how its output reads. */
export class SearchCommand {
  private constructor(
    /** `/bin/sh -c '<script>'`, every argument quoted, with what it is for. */
    readonly command: RemoteCommand,
    /** The targets searched, in the order their files are given to grep. */
    readonly targets: readonly SearchTarget[],
    /** Targets over `maximumFiles` (or naming a transcript already searched): not searched. */
    readonly skipped: readonly SearchTarget[],
  ) {}

  /** Null when there is nothing to search. */
  static make(query: SearchQuery, targets: readonly SearchTarget[]): SearchCommand | null {
    const searched: SearchTarget[] = [];
    const skipped: SearchTarget[] = [];
    for (const target of targets) {
      // Search reads Claude's and Codex's transcripts; a Grok session is not searched.
      // Nor a Cursor chat.
      // Nor a Pi or omp session (its folder lookup is not Claude's).
      if (isPiFormat(target.session.format)) {
        skipped.push(target);
        continue;
      }
      if (target.session.format === "copilot" || target.session.format === "droid") { skipped.push(target); continue; } // Not searched yet (a folder lookup would grep Claude's folder).
      if (target.session.format === "kimi") { skipped.push(target); continue; } // Nor a Kimi session.
      if (target.session.format === "kiro") { skipped.push(target); continue; } // Nor a Kiro session.
      // Nor an OpenCode or Kilo session (a folder lookup grepped Claude's project folder).
      if (isOpenCodeFormat(target.session.format)) { skipped.push(target); continue; }
      // Nor a Maki session.
      if (target.session.format === "maki") skipped.push(target);
      else if (target.session.format === "grok" || target.session.format === "cursor") skipped.push(target);
      // Nor Gemini CLI, Qwen Code or Antigravity.
      else if (isGeminiFamilyFormat(target.session.format)) skipped.push(target);
      else if (isStoreAgentFormat(target.session.format)) skipped.push(target); // Nor a Hermes, Mastra Code or Cline session.
      else if (searched.some((other) => sameSession(other.session, target.session)) || searched.length >= searchBounds.maximumFiles) skipped.push(target);
      else searched.push(target);
    }
    if (searched.length === 0) return null;
    let script = `export LC_ALL=C; ulimit -t ${searchBounds.remoteCPUSeconds} 2>/dev/null; w=0; set --; `;
    // Each file found is announced as `#<index>:<path>` and added to the
    // arguments; `w` keeps the longest path, for the cut below.
    const found = `{ printf '#%s:%s\\n' "$i" "$n"; set -- "$@" "$n"; [ "\${#n}" -gt "$w" ] && w=\${#n}; }; `;
    const newest = (globs: readonly string[]): string =>
      'n=; for f in ' + globs.join(" ") + '; do [ -f "$f" ] && { [ -z "$n" ] || [ "$f" -nt "$n" ]; } && n=$f; done; [ -n "$n" ] && ' + found;
    const intentTargets: RemoteSearchTarget[] = [];
    searched.forEach((target, index) => {
      script += `i=${index}; `;
      const lookup = target.session.lookup;
      switch (lookup.kind) {
        case "id":
          // The newest regular file the globs match, as the locator picks it.
          script += newest(transcriptGlobs(target.session.format, lookup.id));
          intentTargets.push({ index, path: null, lookup: { kind: "id", id: lookup.id, format: target.session.format === "codex" ? "codex" : "claude" } });
          break;
        case "folder":
          // Desktop addition: the newest transcript in the folder's Claude project directory.
          script += newest(folderGlobs(lookup.folder));
          intentTargets.push({ index, path: null, lookup: { kind: "folder", folder: lookup.folder } });
          break;
        case "path":
          script += "n=" + shellQuote(lookup.path) + '; [ -f "$n" ] && ' + found;
          intentTargets.push({ index, path: lookup.path, lookup: null });
          break;
      }
    });
    const patterns = query.remotePatterns;
    script += `[ "$#" -gt 0 ] || exit 0; /usr/bin/grep -F -i -a -H -b -n -s -m ${searchBounds.maximumHitsPerFile}`;
    for (const pattern of patterns) script += " -e " + shellQuote(pattern);
    script += ` -- "$@" | /usr/bin/cut -b "1-$((w + ${searchBounds.cutMargin}))"; exit 0`;
    return new SearchCommand(
      {
        text: "/bin/sh -c " + shellQuote(script),
        intent: { kind: "search", patterns, targets: intentTargets, maxHitsPerFile: searchBounds.maximumHitsPerFile },
      },
      searched,
      skipped,
    );
  }

  /**
   * Reads the command's output: the `#<index>:<path>` lines name each
   * target's file (only a file the target asked for); each grep line is
   * `<path>:<line>:<offset>:<text>` with the text cut. A path may hold colons:
   * a line belongs to the file it starts with followed by `:<digits>:<digits>:`,
   * the file grep is in or a later one, the longest such path first. With
   * `truncated` the bytes after the last line break are a line the cap cut, and go.
   */
  parse(output: Uint8Array, truncated: boolean): SearchListing {
    const files = new Map<number, string>();
    const hits: SearchHit[] = [];
    let bytes = output;
    if (truncated) {
      const lastBreak = bytes.lastIndexOf(0x0a);
      bytes = lastBreak >= 0 ? bytes.subarray(0, lastBreak + 1) : bytes.subarray(0, 0);
    }
    const paths: { index: number; bytes: Uint8Array }[] = [];
    let current = 0;
    const perFile = new Map<number, number>();
    let start = 0;
    while (start < bytes.length) {
      let end = bytes.indexOf(0x0a, start);
      if (end < 0) end = bytes.length;
      const line = bytes.subarray(start, end);
      start = end + 1;
      if (line.length === 0) continue;
      if (line[0] === 0x23) {
        // "#<index>:<path>"
        const colon = line.indexOf(0x3a);
        if (colon < 2) continue;
        const digits = new TextDecoder().decode(line.subarray(1, colon));
        if (!/^\d+$/.test(digits)) continue;
        const index = Number(digits);
        if (index >= this.targets.length || files.has(index)) continue;
        let path: string;
        try {
          path = fileDecoder.decode(line.subarray(colon + 1));
        } catch {
          continue;
        }
        if (!SearchCommand.isFile(path, this.targets[index]!.session)) continue;
        files.set(index, path);
        paths.push({ index, bytes: encoder.encode(path) });
        continue;
      }
      if (line[0] !== 0x2f) continue;
      const candidates = paths.filter((entry) => entry.index >= current).sort((a, b) => b.bytes.length - a.bytes.length);
      for (const candidate of candidates) {
        const length = candidate.bytes.length;
        if (line.length <= length + 1 || line[length] !== 0x3a || !startsWith(line, candidate.bytes)) continue;
        const numbers = SearchCommand.numbers(line.subarray(length + 1));
        if (numbers === null) continue;
        const count = perFile.get(candidate.index) ?? 0;
        if (count >= searchBounds.maximumHitsPerFile) break;
        perFile.set(candidate.index, count + 1);
        current = candidate.index;
        hits.push({ target: candidate.index, lineNumber: numbers.line, offset: numbers.offset });
        break;
      }
    }
    return { files, hits, truncated };
  }

  /** `<line>:<offset>:` at the start of `rest`. */
  private static numbers(rest: Uint8Array): { line: number; offset: number } | null {
    const digits = (from: number): { value: number; end: number } | null => {
      let index = from;
      let value = 0;
      while (index < rest.length && rest[index]! >= 48 && rest[index]! <= 57) {
        value = value * 10 + (rest[index]! - 48);
        if (!Number.isSafeInteger(value)) return null;
        index += 1;
      }
      if (index === from || index >= rest.length || rest[index] !== 0x3a) return null;
      return { value, end: index };
    };
    const line = digits(0);
    if (line === null || line.value <= 0) return null;
    const offset = digits(line.end + 1);
    if (offset === null) return null;
    return { line: line.value, offset: offset.value };
  }

  /** Whether `path` is the file `session` asked for: its path, or a transcript of its id's (or folder's) name. */
  static isFile(path: string, session: TranscriptSessionRef): boolean {
    if (!isUsablePath(path)) return false;
    if (session.lookup.kind === "path") return path === session.lookup.path;
    return parseLocateOutput(path, session) === path;
  }
}

function startsWith(line: Uint8Array, prefix: Uint8Array): boolean {
  if (line.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) if (line[index] !== prefix[index]) return false;
  return true;
}

// MARK: - results

/** Who wrote a matching message: you typed it, the agent's reply, or a command (the agent's, or your `!`). */
export type SearchAuthor = "you" | "agent" | "command";

/** The text shown for a match, its matches marked (in characters from the start). */
export interface SearchSnippet {
  readonly text: string;
  /** Character (grapheme) ranges, end exclusive. */
  readonly highlights: readonly { readonly start: number; readonly end: number }[];
}

/** One matching message. */
export interface SearchMatch {
  readonly paneID: string;
  /** Where its line starts in the transcript. */
  readonly lineOffset: number;
  /** The chat row's id; null for a line too long to read ("a very long message"). */
  readonly messageID: string | null;
  readonly author: SearchAuthor | null;
  /** Seconds since 1970. */
  readonly time: number | null;
  /** Null for a line too long to read. */
  readonly snippet: SearchSnippet | null;
  /** The input a message you wrote is (to join one input written both ways, as Chat does). */
  readonly input?: ShownMessage | null;
  readonly joined?: boolean;
}

export const matchID = (match: Pick<SearchMatch, "paneID" | "lineOffset" | "messageID">): string =>
  `${match.paneID}|${match.lineOffset}|${match.messageID ?? "long"}`;

export const isLongLine = (match: SearchMatch): boolean => match.snippet === null;

/** Newest first: by time, an unknown time after known ones, then later in the file first. */
export function newerFirst(first: SearchMatch, second: SearchMatch): boolean {
  if (first.time !== null && second.time !== null && first.time !== second.time) return first.time > second.time;
  if (first.time !== null && second.time === null) return true;
  if (first.time === null && second.time !== null) return false;
  return first.lineOffset > second.lineOffset;
}

/** One pane's matches, newest first. */
export interface SearchPaneResults {
  readonly paneID: string;
  readonly matches: readonly SearchMatch[];
  /** Matching lines found and not read yet. */
  readonly unread: number;
}

export const paneNewest = (pane: SearchPaneResults): number | null => pane.matches[0]?.time ?? null;
/** The first `shownPerPane` matches. */
export const paneShown = (pane: SearchPaneResults): readonly SearchMatch[] => pane.matches.slice(0, searchBounds.shownPerPane);
/** "N more in this pane": matches read beyond those shown (lines not read are not counted). */
export const paneMore = (pane: SearchPaneResults): number => pane.matches.length - paneShown(pane).length;

/** One machine's results by pane, the panes ordered by their newest match. */
export class SearchResults {
  private all = new Map<string, { paneID: string; matches: SearchMatch[]; unread: number }>();
  private order: Map<string, number>;
  private ordered: SearchPaneResults[] = [];

  constructor(paneOrder: readonly string[] = []) {
    this.order = new Map();
    paneOrder.forEach((pane, index) => {
      if (!this.order.has(pane)) this.order.set(pane, index);
    });
  }

  clone(): SearchResults {
    const copy = new SearchResults();
    copy.order = new Map(this.order);
    for (const [pane, entry] of this.all) copy.all.set(pane, { paneID: entry.paneID, matches: [...entry.matches], unread: entry.unread });
    copy.reorder();
    return copy;
  }

  /** Panes with at least one match, newest match first (an unknown time after known ones, then the order listed). */
  get panes(): readonly SearchPaneResults[] {
    return this.ordered;
  }

  get matchCount(): number {
    return this.ordered.reduce((sum, pane) => sum + pane.matches.length, 0);
  }

  get unread(): number {
    let sum = 0;
    for (const pane of this.all.values()) sum += pane.unread;
    return sum;
  }

  private pane(paneID: string): { paneID: string; matches: SearchMatch[]; unread: number } {
    let pane = this.all.get(paneID);
    if (pane === undefined) {
      pane = { paneID, matches: [], unread: 0 };
      this.all.set(paneID, pane);
    }
    return pane;
  }

  /** `count` lines matched in `paneID`'s file, to be read. */
  expect(count: number, paneID: string): void {
    this.pane(paneID).unread += Math.max(0, count);
    this.reorder();
  }

  /** A line read that is a match. */
  add(match: SearchMatch): void {
    this.read([match], match.paneID);
  }

  /** One line of `paneID`'s read: the matches it holds (none for a tool's output, thinking, a field not shown). */
  read(matches: readonly SearchMatch[], paneID: string): void {
    const pane = this.pane(paneID);
    if (pane.unread > 0) pane.unread -= 1;
    for (const found of matches) {
      if (found.paneID !== paneID || pane.matches.some((existing) => matchID(existing) === matchID(found))) continue;
      let match = found;
      // One input written both ways (queued and typed, Chat's rule) is one
      // result: the one earlier in the file, which is the one Chat shows.
      const input = match.input ?? null;
      if (input !== null) {
        const other = pane.matches.findIndex((candidate) => candidate.input != null && candidate.joined !== true && isSameInput(candidate.input, input));
        if (other >= 0) {
          if (pane.matches[other]!.lineOffset < match.lineOffset) match = pane.matches[other]!;
          match = { ...match, joined: true };
          pane.matches.splice(other, 1);
        }
      }
      const index = pane.matches.findIndex((existing) => newerFirst(match, existing));
      pane.matches.splice(index < 0 ? pane.matches.length : index, 0, match);
    }
    this.reorder();
  }

  /** Lines of `paneID` still to read. */
  unreadIn(paneID: string): number {
    return this.all.get(paneID)?.unread ?? 0;
  }

  /** The matches found in `paneID` so far, newest first. */
  matchesIn(paneID: string): readonly SearchMatch[] {
    return this.all.get(paneID)?.matches ?? [];
  }

  /** A line read that is no match, or one that could not be read. */
  drop(paneID: string): void {
    const pane = this.all.get(paneID);
    if (pane === undefined || pane.unread <= 0) return;
    pane.unread -= 1;
    this.reorder();
  }

  private reorder(): void {
    const order = this.order;
    this.ordered = [...this.all.values()]
      .filter((pane) => pane.matches.length > 0)
      .map((pane) => ({ paneID: pane.paneID, matches: [...pane.matches], unread: pane.unread }))
      .sort((first, second) => {
        const one = paneNewest(first);
        const two = paneNewest(second);
        if (one !== null && two !== null && one !== two) return two - one;
        if (one !== null && two === null) return -1;
        if (one === null && two !== null) return 1;
        const a = order.get(first.paneID) ?? Number.MAX_SAFE_INTEGER;
        const b = order.get(second.paneID) ?? Number.MAX_SAFE_INTEGER;
        if (a !== b) return a - b;
        return first.paneID < second.paneID ? -1 : first.paneID > second.paneID ? 1 : 0;
      });
  }
}
