// One line in, zero or more events out, for either agent; counts every line.
// Never throws: a bad line is counted and skipped. A port of HerdrKit's
// TranscriptParsing.swift.

import {
  ClaudeTranscriptParser,
  copySeamOpening,
  emptySeamCarry,
  forgetSeamOpening,
  type LoggedInput,
  type SeamCarry,
  type SeamOpening,
  type TranscriptLineOutcome,
  type TranscriptLineResult,
} from "./claude-parser";
import { bookkeeping } from "./claude-parser";
import { CodexRolloutParser } from "./codex-parser";
import { CursorStoreParser } from "./cursor-parser";
import { GrokSessionParser, type GrokSeamOpening } from "./grok-parser";
import { isPiFormat } from "./agents/pi-locator";
import { PiSessionParser } from "./agents/pi-parser";
import { OpenCodeStoreParser } from "./agents/opencode-parser";
import { isOpenCodeFormat, type OpenCodeFormat } from "./agents/opencode-locate";
// Gemini CLI, Qwen Code and Antigravity CLI.
import { GeminiFamilyParser, isGeminiFamilyFormat, type GeminiFamilyFormat } from "./agents/gemini-family";
import { CopilotEventsParser } from "./agents/copilot-parser";
import { DroidSessionParser } from "./agents/droid-parser";
import { KimiWireParser } from "./agents/kimi-parser";
import { MakiSessionParser } from "./agents/maki-parser";
import { HermesStoreParser } from "./agents/hermes-parser";
import { MastraStoreParser } from "./agents/mastra-parser";
import { ClineStoreParser } from "./agents/cline-parser";
import type { StoreAgentFormat } from "./agents/store-agents";
import { KiroSessionParser } from "./agents/kiro-parser";
import type { KiroFormat } from "./agents/kiro-locate";
import type { ChatLineBlobs } from "./blobs";
import { minimumLineLength, scanLine } from "./line-scan";
import type { ChatUserMessage, TranscriptEvent } from "./model";

export type { TranscriptLineOutcome, TranscriptLineResult } from "./claude-parser";

/** Which agent wrote a transcript, and so which parser reads it. */
/** `grok` is Grok Build's updates.jsonl (GrokSessionParser). */
/** `cursor` is a Cursor agent chat's store.db, read as one line per root ref (CursorStoreParser). */
/** `maki` is a Maki session log (agents/maki-parser.ts). */
export type TranscriptFormat =
  | "claude"
  | "codex"
  | "grok"
  | "cursor"
  /** `pi` and `omp` are Pi's and omp's session .jsonl, one parser (agents/pi-parser.ts). */
  | "pi"
  | "omp"
  | OpenCodeFormat // `opencode` and `kilo`, a session in their SQLite store (OpenCodeStoreParser)
  /** `gemini`, `qwen`, `antigravity` (agents/gemini-family.ts). */
  | GeminiFamilyFormat
  | "copilot" // GitHub Copilot CLI's events.jsonl (agents/copilot-parser.ts)
  | "droid" // Factory Droid's session .jsonl (agents/droid-parser.ts)
  /** `kimi` is a Kimi Code session's main agent wire.jsonl (agents/kimi-parser.ts). */
  | "kimi"
  | "maki"
  | StoreAgentFormat // `hermes`, `mastracode` (their SQLite stores) and `cline` (its messages.json, read whole)
  | KiroFormat; // `kiro` is a Kiro CLI V3 session's messages.jsonl (agents/kiro-parser.ts)

/**
 * The line formats whose folder and version are in a header or early metadata that Chat's cold tail (its
 * last 512 KiB) can start past: Pi's and omp's `session` line, Copilot's `session.start` (and
 * `session.resume`), Droid's `session_start`, Kimi's `metadata` and `profile.bind` / `config.update`. The
 * feed reads the file's head once before a load shows anything (`headerBytes`) and every parser of the file
 * carries it (`TranscriptParser.carryHeader`).
 */
const headerTypes = new Map<TranscriptFormat, ReadonlySet<string>>([
  ["pi", new Set(["session"])],
  ["omp", new Set(["session"])],
  ["copilot", new Set(["session.start", "session.resume"])],
  ["droid", new Set(["session_start"])],
  ["kimi", new Set(["metadata", "profile.bind", "config.update"])],
]);

/** This format's folder and version are in its header. */
export const hasHeader = (format: TranscriptFormat): boolean => headerTypes.has(format);

/** The head read's bound: Kimi's `profile.bind` carries its system prompt. */
export const headerBytes = (format: TranscriptFormat): number => (format === "kimi" ? 256 * 1_024 : 64 * 1_024);

/**
 * The formats whose folder can move after the head: Copilot's latest `session.resume` and Kimi's latest
 * `config.update` (or `profile.bind`) name the session's folder now, and one can lie between the head and the cold
 * tail. Pi's, omp's and Droid's cannot: their parsers keep the first header's folder (`session`, `session_start`;
 * pi-parser.ts header, droid-parser.ts `this.cwd === null`).
 */
export const ownershipMoves = (format: TranscriptFormat): boolean => format === "copilot" || format === "kimi";

/** An unread middle is scanned for its ownership records at most this far in all (main's 4 MiB read bound). */
export const ownershipScanBytes = 4 * 1_024 * 1_024;
/** In reads of at most this. */
export const ownershipScanChunk = 1_024 * 1_024;

/** What a header read gave: its lines accepted, a version this reader doesn't know, or no header line. */
export type HeaderRead = "accepted" | "unknown" | "none";

/** The header scan's one decoder (a line is whole when it reaches it: no state carries over). */
const headerDecoder = new TextDecoder();

/** One complete line (no newline), as text when it is one of the format's header lines, else null. */
export function headerLineOf(format: TranscriptFormat, line: Uint8Array): string | null {
  const types = headerTypes.get(format);
  if (types === undefined) return null;
  const text = headerDecoder.decode(line);
  if (![...types].some((type) => text.includes(`"${type}"`))) return null;
  let type: unknown;
  try {
    type = (JSON.parse(text) as { type?: unknown } | null)?.type;
  } catch {
    return null;
  }
  return typeof type === "string" && types.has(type) ? text : null;
}

/** The header lines among `bytes`' complete lines (those a newline ends), oldest first. */
export function headerLinesOf(format: TranscriptFormat, bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let newline = bytes.indexOf(0x0a); newline >= 0; newline = bytes.indexOf(0x0a, start)) {
    const line = headerLineOf(format, bytes.subarray(start, newline));
    if (line !== null) lines.push(line);
    start = newline + 1;
  }
  return lines;
}

/** Counts over the lines read so far. */
export class TranscriptParseStats {
  lines = 0;
  linesWithEvents = 0;
  skipped = 0;
  malformed = 0;
  readonly unknownTypes = new Map<string, number>();
  readonly skippedTypes = new Map<string, number>();
  /** Lines long enough to be scanned before (or instead of) a parse (`scanLine`). */
  scanned = 0;
  /** What was handed to the JSON parser (UTF-16 code units; Swift's `parsedBytes`): a scanned line counts what is left of it with its payloads cut, a line skipped by its type nothing. */
  parsedChars = 0;

  get unknown(): number {
    let total = 0;
    for (const count of this.unknownTypes.values()) total += count;
    return total;
  }

  /** Malformed plus unknown-type lines: what "unrecognised format" counts. */
  get unparseable(): number {
    return this.malformed + this.unknown;
  }

  record(outcome: TranscriptLineOutcome): void {
    this.lines += 1;
    switch (outcome.kind) {
      case "events":
        this.linesWithEvents += 1;
        break;
      case "skipped":
        this.skipped += 1;
        this.skippedTypes.set(outcome.type, (this.skippedTypes.get(outcome.type) ?? 0) + 1);
        break;
      case "malformed":
        this.malformed += 1;
        break;
      case "unknown":
        this.unknownTypes.set(outcome.type, (this.unknownTypes.get(outcome.type) ?? 0) + 1);
        break;
    }
  }

  clone(): TranscriptParseStats {
    const copy = new TranscriptParseStats();
    copy.lines = this.lines;
    copy.linesWithEvents = this.linesWithEvents;
    copy.skipped = this.skipped;
    copy.malformed = this.malformed;
    copy.scanned = this.scanned;
    copy.parsedChars = this.parsedChars;
    for (const [key, value] of this.unknownTypes) copy.unknownTypes.set(key, value);
    for (const [key, value] of this.skippedTypes) copy.skippedTypes.set(key, value);
    return copy;
  }
}

/** What a parser that began inside the transcript read that one parse of the whole file might have read otherwise. */
export interface TranscriptSeamOpening {
  claude: SeamOpening | null;
  /** Grok's (the run its first lines began). */
  grok?: GrokSeamOpening | null;
}

export function forgetTranscriptSeamOpening(opening: TranscriptSeamOpening, offset: number): void {
  if (opening.claude !== null) forgetSeamOpening(opening.claude, offset);
  // What is held starts later: its first run is not at the seam any more.
  if (opening.grok !== undefined && opening.grok !== null) opening.grok = null;
}

/** A Grok run begun after a seam (`from`) that is the earlier part's `into`. */
export interface GrokRunJoin {
  readonly from: string;
  readonly into: string;
  /** Blank parts the later part skipped before it, which one parse adds to the run. */
  readonly blank: string;
}

/** A message to show again, and where its line starts. */
export interface RestoredMessage {
  readonly message: ChatUserMessage;
  readonly offset: number | null;
  /** Sent while the agent worked (a queued line): it goes inside the turn running at its line. */
  readonly queued: boolean;
}

/** What joining a part to the lines just before it changes, so the two read as one parse of the file would. */
export interface TranscriptSeam {
  /** Items of the later part that are an input the earlier part already shows: they go. */
  duplicateItemIDs: string[];
  /** Messages of the later part its parser took as a copy, which one parse does not: they show. */
  restored: RestoredMessage[];
  /** Results the later part's first lines give to calls of the earlier part (a `!` command's output). */
  finished: TranscriptEvent[];
  /** The joined part's opening, for the seam before it. */
  opening: TranscriptSeamOpening;
  /** What the parser reading on takes on. */
  carry: SeamCarry;
  /** A Grok reply (or thinking) the seam cuts: its later part joins the earlier row. */
  grokJoin?: GrokRunJoin | null;
}

export class TranscriptParser {
  readonly format: TranscriptFormat;
  stats = new TranscriptParseStats();
  private claude = new ClaudeTranscriptParser();
  private codex = new CodexRolloutParser();
  private grok = new GrokSessionParser();
  private cursor = new CursorStoreParser();
  private pi = new PiSessionParser();
  private opencode = new OpenCodeStoreParser();
  private geminiFamily: GeminiFamilyParser | null;
  private copilot = new CopilotEventsParser();
  private droid = new DroidSessionParser();
  private kimi = new KimiWireParser();
  private maki = new MakiSessionParser();
  private hermes = new HermesStoreParser();
  private mastra = new MastraStoreParser();
  private cline = new ClineStoreParser();
  private kiro = new KiroSessionParser();

  constructor(format: TranscriptFormat) {
    this.format = format;
    this.geminiFamily = isGeminiFamilyFormat(format) ? new GeminiFamilyParser(format) : null;
  }

  clone(): TranscriptParser {
    const copy = new TranscriptParser(this.format);
    copy.stats = this.stats.clone();
    copy.claude = this.claude.clone();
    copy.codex = this.codex.clone();
    copy.grok = this.grok.clone();
    copy.cursor = this.cursor.clone();
    copy.pi = this.pi.clone();
    copy.opencode = this.opencode.clone();
    copy.geminiFamily = this.geminiFamily?.clone() ?? null;
    copy.copilot = this.copilot.clone();
    copy.droid = this.droid.clone();
    copy.kimi = this.kimi.clone();
    copy.maki = this.maki.clone();
    copy.hermes = this.hermes.clone();
    copy.mastra = this.mastra.clone();
    copy.cline = this.cline.clone();
    copy.kiro = this.kiro.clone();
    return copy;
  }

  /**
   * Grok's lines name no folder; the session's summary.json does (its
   * `info.cwd`, checked by the caller), and the parser carries it as the transcript's folder.
   */
  carryFolder(folder: string): void {
    if (this.format === "grok") this.grok.cwd = folder;
    // Cursor's blobs name no folder either; the chat's meta.json does.
    if (this.format === "cursor") this.cursor.cwd = folder;
    // A Maki session's folder, its header's cwd as the owner check read it.
    if (this.format === "maki") this.maki.cwd = folder;
    // A Kiro session's folder, its session.json's first workspace path as the owner check read it.
    if (this.format === "kiro") this.kiro.cwd = folder;
  }

  /**
   * The file's header lines, read into this parser before any line of a load: the folder, the version, nothing
   * shown, so a cold tail is parsed as the whole file would be (Copilot's latest `session.resume` in the tail still
   * wins): the lines (`headerLinesOf`) of the head and, for a format whose folder moves (`ownershipMoves`), of the
   * unread middle, oldest first, so the latest is this parser's folder; "unknown" when one names a version this
   * reader doesn't know (every later line would be unknown), "none" when there is no header line (the feed fails
   * closed for a long file).
   */
  carryHeader(lines: readonly string[]): HeaderRead {
    if (!headerTypes.has(this.format) || lines.length === 0) return "none";
    let read: HeaderRead = "accepted";
    for (const line of lines) {
      const result =
        this.format === "copilot" ? this.copilot.parse(line)
        : this.format === "droid" ? this.droid.parse(line)
        : this.format === "kimi" ? this.kimi.parse(line)
        : this.pi.parse(line);
      if (result.outcome.kind === "unknown") read = "unknown";
    }
    return read;
  }

  /** The transcript's working folder, once a line has given it. */
  get cwd(): string | null {
    if (this.format === "cursor") return this.cursor.cwd;
    if (isPiFormat(this.format)) return this.pi.cwd;
    if (isOpenCodeFormat(this.format)) return this.opencode.cwd;
    if (this.geminiFamily !== null) return this.geminiFamily.cwd;
    if (this.format === "copilot") return this.copilot.cwd;
    if (this.format === "droid") return this.droid.cwd;
    if (this.format === "kimi") return this.kimi.cwd; // its profile.bind's folder
    if (this.format === "maki") return this.maki.cwd;
    if (this.format === "hermes") return this.hermes.cwd;
    if (this.format === "mastracode") return this.mastra.cwd;
    if (this.format === "cline") return this.cline.cwd;
    if (this.format === "kiro") return this.kiro.cwd;
    return this.format === "claude" ? this.claude.cwd : this.format === "codex" ? this.codex.cwd : this.grok.cwd;
  }

  /**
   * One line, read at `offset` when known: the ids a line lacks are made from
   * it, so the same line read twice gets the same ids and two lines never share one.
   *
   * `blobs` (relay v1.2): the runs a relay read left out of it that are still placeholders
   * in its text (an image's base64, a field nothing reads); a Claude image block over them gets a blob to fetch.
   */
  parse(line: string, offset: number | null = null, blobs: ChatLineBlobs | null = null): TranscriptLineResult {
    this.claude.lineOffset = offset;
    this.claude.lineBlobs = blobs;
    this.codex.lineOffset = offset;
    this.grok.lineOffset = offset;
    this.cursor.lineOffset = offset;
    this.pi.lineOffset = offset;
    if (this.geminiFamily !== null) this.geminiFamily.lineOffset = offset;
    this.copilot.lineOffset = offset;
    this.droid.lineOffset = offset;
    this.kimi.lineOffset = offset;
    this.maki.lineOffset = offset;
    this.maki.lineBlobs = blobs;
    this.kiro.lineOffset = offset;
    try {
      let text = line;
      // A long line costs a scan, not a parse. A type this agent shows
      // nothing of is skipped by its name alone; any other is parsed with its image payloads cut.
      const scan = line.length >= minimumLineLength ? scanLine(line) : null;
      if (scan !== null) {
        this.stats.scanned += 1;
        if (scan.type !== null && this.skipsUnparsed(scan.type)) {
          const skipped: TranscriptLineResult = { events: [], outcome: { kind: "skipped", type: scan.type } };
          this.stats.record(skipped.outcome);
          return skipped;
        }
        if (scan.slimmed !== null) text = scan.slimmed;
      }
      // A picture's base64 in Grok's own block shape.
      if (this.format === "grok") text = GrokSessionParser.slimmed(text) ?? text;
      if (isPiFormat(this.format)) text = GrokSessionParser.slimmed(text) ?? text; // Pi's picture block is Grok's shape
      if (this.geminiFamily !== null) text = this.geminiFamily.slimmed(text) ?? text;
      this.stats.parsedChars += text.length;
      const result =
        this.geminiFamily !== null ? this.geminiFamily.parse(text)
        : this.format === "maki" ? this.maki.parse(text)
        : this.format === "claude" ? this.claude.parse(text)
        : this.format === "codex" ? this.codex.parse(text)
        : this.format === "kimi" ? this.kimi.parse(text)
        : this.format === "cursor" ? this.cursor.parse(text)
        : isPiFormat(this.format) ? this.pi.parse(text)
        : isOpenCodeFormat(this.format) ? this.opencode.parse(text)
        : this.format === "hermes" ? this.hermes.parse(text)
        : this.format === "mastracode" ? this.mastra.parse(text)
        : this.format === "cline" ? this.cline.parse(text)
        : this.format === "copilot" ? this.copilot.parse(text)
        : this.format === "droid" ? this.droid.parse(text)
        : this.format === "kiro" ? this.kiro.parse(text)
        : this.grok.parse(text);
      this.stats.record(result.outcome);
      return result;
    } finally {
      this.claude.lineBlobs = null;
      this.claude.lineOffset = null;
      this.codex.lineOffset = null;
      this.grok.lineOffset = null;
      this.cursor.lineOffset = null;
      this.pi.lineOffset = null;
      if (this.geminiFamily !== null) this.geminiFamily.lineOffset = null;
      this.copilot.lineOffset = null;
      this.droid.lineOffset = null;
      this.kimi.lineOffset = null;
      this.maki.lineOffset = null;
      this.maki.lineBlobs = null;
      this.kiro.lineOffset = null;
    }
  }

  /** A top-level type whose line the parser skips whatever it holds (Claude Code's bookkeeping, the Claude parser's rule); Codex has none. */
  skipsUnparsed(type: string): boolean {
    return this.format === "claude" && skipsUnparsedClaude(type);
  }

  /** Parses every line of a whole file's text (tests and the local check). */
  parseText(text: string): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      events.push(...this.parse(trimmed).events);
    }
    return events;
  }

  /** What this parser read that one parse of the whole file might have read otherwise. */
  get seamOpening(): TranscriptSeamOpening {
    return { claude: this.format === "claude" ? copySeamOpening(this.claude.opening) : null, grok: this.format === "grok" ? this.grok.seamOpening : null };
  }

  /** Joins `older` (the parser that read the lines just before a part) to that part, read as `newer`. */
  static seam(older: TranscriptParser, newer: TranscriptSeamOpening): TranscriptSeam {
    const seam: TranscriptSeam = { duplicateItemIDs: [], restored: [], finished: [], opening: { claude: null }, carry: emptySeamCarry() };
    // A Grok run the seam cuts is one run (the later part's joins the earlier's).
    if (older.format === "grok") {
      seam.opening = older.seamOpening;
      const later = newer.grok ?? null;
      const into = later === null || later.run === null ? null : older.grok.openRun(later.thinking);
      if (later !== null && later.run !== null && into !== null) seam.grokJoin = { from: later.run, into, blank: later.thinking ? "" : later.blank };
      return seam;
    }
    if (older.format !== "claude" || newer.claude === null) {
      seam.opening = older.seamOpening;
      return seam;
    }
    const joined = ClaudeTranscriptParser.seam(older.claude, newer.claude);
    seam.duplicateItemIDs = joined.duplicates;
    seam.restored = joined.restored.map((logged: LoggedInput) => ({ message: logged.message, offset: logged.offset, queued: logged.input.queued }));
    seam.finished = joined.finished;
    seam.opening = { claude: joined.opening };
    seam.carry = joined.carry;
    return seam;
  }

  /** The parser reading on from the part's last line takes on `seam`. */
  adopt(seam: TranscriptSeam): void {
    if (this.format === "grok" && seam.grokJoin !== undefined && seam.grokJoin !== null) this.grok.adoptRun(seam.grokJoin.from, seam.grokJoin.into);
    if (this.format !== "claude" || seam.opening.claude === null) return;
    this.claude.adopt(seam.carry, seam.opening.claude);
  }

  /** The part this parser read starts at `offset` now (a trim). */
  forgetInputs(offset: number): void {
    if (this.format === "grok") this.grok.forgetOpening();
    if (this.format !== "claude") return;
    this.claude.forgetInputs(offset);
  }
}

/** The Claude parser skips a line of this type whatever it holds (its default case, the same rule). */
export function skipsUnparsedClaude(type: string): boolean {
  return bookkeeping.has(type) || type.startsWith("file-history-");
}
