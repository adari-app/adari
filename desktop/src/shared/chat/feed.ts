// Follows the open pane's transcript for the Chat view: `start` locates the
// file, loads its end, then polls its size about once a second and reads the
// new bytes; every change publishes a timeline snapshot. `stop` cancels at
// once. `loadEarlier` reads backwards from the loaded part's first line and puts
// what it read in front, joined at the seam as one parse of the file would read
// it. A port of HerdrKit's ChatFeed.swift (an actor there; here one object on
// one event loop, every await followed by the same "still current" checks).
//
// A feed not on show is paused, not stopped (`pause`, `resume`): nothing is
// read while paused, its follower, parser and timeline stay, and `resume`
// reads on at once from its offset (the catch-up). With `cold`, a first load
// reads only the end's first window, then earlier only until it holds a
// screenful of turns plus one (`ChatColdLoad`); `loaded()` waits for that.

import {
  blobLineText,
  blobsToRestore,
  clipBlobs,
  fetchImageBase64,
  fetchRange,
  isBase64Run,
  keptLength,
  restoreBlobs,
  type BlobRange,
  type ChatLineBlobs,
  type RangeReading,
} from "./blobs";
import { ChatTimelineBuilder, defaultHistoryCap, defaultMaxItems } from "./builder";
import { defaultEarlierChunkBytes, maxLineBytes, pollWindow, startsOver, TranscriptEarlierReader, TranscriptFollower, type TranscriptLine } from "./follower";
import { cursorMetaFolder, cursorMetaPath, isTranscriptStoreReading, maxCursorMetaBytes } from "./cursor-store";
import { isStoreFormat } from "./stores"; // the store registry (Cursor, OpenCode, Kilo, Hermes, Mastra Code, Cline)
import { isMakiSessionPath, MakiLogFormatError, makiHeaderFolder, maxMakiHeaderBytes } from "./agents/maki-session";
import { KiroSessionFormatError, kiroSessionFolder, kiroSessionJSONPath, maxKiroSessionBytes } from "./agents/kiro-locate";
import { codexHeaderVerdict, readCodexHeader, sameCodexHeader, type CodexHeader } from "./codex-header";
import { ChatFolderMatch, grokLookupExcludes, grokSessionOwned, grokSummaryFolder, grokSummaryPath, maxGrokSummaryBytes, type TranscriptSessionRef } from "./locator";
import { emptyTimeline, sameRunning, type ChatEarlierHistory, type ChatImageBlob, type ChatSubagent, type ChatTimeline } from "./model";
import { defaultStepIntervalMs, stepPassMs, SubagentSteps, type SubagentStepReader } from "./subagent-steps";
import { forgetTranscriptSeamOpening, hasHeader, headerBytes, headerLineOf, headerLinesOf, ownershipMoves, ownershipScanBytes, ownershipScanChunk, TranscriptParser, TranscriptParseStats, type TranscriptFormat, type TranscriptLineResult, type TranscriptSeam, type TranscriptSeamOpening } from "./parser";

/** Why a pane's chat cannot be shown; the UI falls back to Terminal. */
export type ChatUnavailableReason =
  /** Herdr reports no usable `agent_session` for the pane. */
  | "noSession"
  /** No transcript file matches the session. */
  | "notFound"
  /** The file could not be read (SSH or SFTP failed). */
  | "unreadable"
  /** More than half of the first 200 lines are not this agent's format. */
  | "unrecognisedFormat"
  /** The transcript's working folder is not the pane's: Herdr gave the pane another pane's session. */
  | "sessionMismatch"
  /** Two Grok panes in one folder name no session, so neither can be told from the other. */
  | "ambiguousSession"
  /**
   * The Codex session Herdr names for the pane is another folder's by its own header (the state's
   * `folder`): Codex 0.167's shared background server reported it for the wrong pane.
   */
  | "codexOtherFolder";

export type ChatFeedState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "live" }
  | {
      readonly status: "unavailable";
      readonly reason: ChatUnavailableReason;
      /** With `codexOtherFolder`, the folder the session's header names. */
      readonly folder?: string;
    };

export interface ChatFeedUpdate {
  readonly state: ChatFeedState;
  readonly timeline: ChatTimeline;
  /**
   * Live (Swift's ChatFeedUpdate.caughtUp) and read to the file's end as its
   * size was last asked (no catch-up under way, nothing newer waiting).
   * Chat's live row starts only then.
   */
  readonly caughtUp?: boolean;
}

/** What the feed follows: at least which agent wrote it; the reader knows how to find it. */
export interface FeedSession {
  readonly format: TranscriptFormat;
}

/** The file's size or read failed because it is gone. */
export class TranscriptNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`No transcript at ${path}`);
    this.name = "TranscriptNotFoundError";
  }
}

/** Reads transcripts on the agent's machine, read only. */
export interface TranscriptFileReader<S extends FeedSession = FeedSession> {
  /** The transcript's path, or null when no file matches. */
  locate(session: S): Promise<string | null>;
  /** The file's size in bytes; throws TranscriptNotFoundError when it is gone. */
  size(path: string): Promise<number>;
  /** Up to `maxBytes` from `offset`; fewer at the end of the file. */
  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array>;
}

/** A watch on a transcript (the relay's `watch`), ended by close(). */
export interface TranscriptWatch {
  close(): void;
}

/** What a watch pushes: the file's growth (the bytes from `offset`), a shrink or replacement, the file gone, or its end. */
export interface TranscriptWatchSink {
  /**
   * Relay v1.2, client rule 7: `omitted`, the base64 runs the relay left out of this frame; `data` is
   * the file's bytes it covered all the same, each run filled (blobs.ts), so offsets stay the file's.
   */
  grew(offset: number, size: number, data: Uint8Array, omitted?: readonly BlobRange[]): void;
  reset(): void;
  gone(): void;
  ended(): void;
}

/** A reader whose machine can push a file's growth; null when it cannot now (the feed polls instead). */
export interface TranscriptWatching {
  watch(path: string, offset: number, sink: TranscriptWatchSink): Promise<TranscriptWatch | null>;
}

export function isTranscriptWatching(reader: unknown): reader is TranscriptWatching {
  return typeof (reader as Partial<TranscriptWatching>).watch === "function";
}

/** One combined read: the file's size and inode now, and the bytes from `offset`. */
export interface TranscriptIdentityRead {
  readonly size: number;
  readonly ino: number;
  /** The file's bytes from the read's start (a run left out filled, blobs.ts; `omitted` lists them). */
  readonly data: Uint8Array;
  /** Where the read started (a `tail` read's start); absent: the offset asked for. */
  readonly offset?: number;
  /** Relay v1.2: the base64 runs left out of `data` (file ranges, ascending); absent: none. */
  readonly omitted?: readonly BlobRange[];
}

/** Relay v1.2, client rule 1: what a read with identity may also ask. */
export interface TranscriptReadOptions {
  /** Leave base64 runs of 1,024 or more bytes out (`omit`); a relay that cannot gives plain reads. */
  readonly omit?: boolean;
  /** Read the file's last `tail` bytes (no size first); the reply's `offset` says where it started. */
  readonly tail?: number;
}

/**
 * A reader (HerdrKit's TranscriptIdentityReading) that can read with the file's size
 * and inode in one trip (the relay's `read` frame); null when it cannot now (no relay): the feed asks the size,
 * then reads. Throws TranscriptNotFoundError when the file is gone.
 */
export interface TranscriptIdentityReading {
  readWithIdentity(path: string, offset: number, maxBytes: number, options?: TranscriptReadOptions): Promise<TranscriptIdentityRead | null>;
}

export function isTranscriptIdentityReading(reader: unknown): reader is TranscriptIdentityReading {
  return typeof (reader as Partial<TranscriptIdentityReading>).readWithIdentity === "function";
}

/**
 * Relay v1.2: a reader that reads with identity past anything its own reads feed (the chips'
 * settings tap): a fetch on show (rule 5), a line read again whole (rule 3), the look-back's reads. Null when it
 * cannot now (no relay).
 */
export interface TranscriptRangeReading {
  readRange(path: string, offset: number, maxBytes: number, options?: TranscriptReadOptions): Promise<TranscriptIdentityRead | null>;
}

function isRangeReading(reader: unknown): reader is TranscriptRangeReading {
  return typeof (reader as Partial<TranscriptRangeReading>).readRange === "function";
}

/**
 * A line as it is parsed: what had to be put back is, and the runs still left out (null: none).
 * `unread` when its whole-line reread failed: the line is not parsed; the read stops there.
 */
interface ReadyLine {
  readonly text: string;
  readonly offset: number;
  readonly blobs: ChatLineBlobs | null;
  readonly unread?: true;
}

/** A read's bytes (the file's, each run left out filled) and the runs left out. */
interface LeftOutRead {
  readonly data: Uint8Array;
  readonly omitted: readonly BlobRange[];
}

/**
 * A reader that hears when the feed reads a file again from its start, before that read: `replaced` when the
 * feed found another file under the name (another inode, or one still unknown after a load), which no inode the
 * reader saw may tell it. The chips' settings tap uses it so its framing follows the feed's reread and its
 * values start over with a replaced file.
 */
export interface TranscriptStartOverListening {
  startingOver(path: string, replaced: boolean): void;
  /**
   * The feed keeps the bytes of the read with identity just answered (a byte read it applies). Said at once,
   * before the reader is asked anything else; a read with identity not said kept before the next call is thrown
   * away (a poll that starts over, a reply planned again).
   */
  keptIdentityRead(path: string): void;
}

function isStartOverListening(reader: unknown): reader is TranscriptStartOverListening {
  return (
    typeof (reader as Partial<TranscriptStartOverListening>).startingOver === "function" &&
    typeof (reader as Partial<TranscriptStartOverListening>).keptIdentityRead === "function"
  );
}

/** While a watch is live the poll is a backstop this far apart (the 1 s poll otherwise). */
export const watchedBackstopMs = 10_000;
/** Pushed bytes held for the follow at most; past it the watch ends and the follow polls and reads. */
export const maxPushedBytes = 8 * 1_024 * 1_024;

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** One watch of the followed file and the bytes it pushed that the follow has not taken yet. */
interface Watched {
  readonly path: string;
  handle: TranscriptWatch | null;
  /** The offset of the first byte held. */
  start: number;
  chunks: Uint8Array[];
  length: number;
  /** Relay v1.2, rule 7: the runs left out of the bytes held (file ranges, ascending). */
  omitted: BlobRange[];
  /** The size the last `grew` gave, not yet used by the follow (null: none since). */
  size: number | null;
  /** Ended (reset, gone, its end, or too much held): the follow polls and reads until it watches again. */
  over: boolean;
}

/**
 * The folder a located Grok session belongs to, its summary.json's `info.cwd`
 * (one bounded read), or null when there is no summary or it names none. Chat, Away and Changes
 * check it (grokSessionOwned) before reading the session. Throws when the read fails otherwise.
 */
export async function grokSessionFolder(reader: Pick<TranscriptFileReader, "read">, transcript: string): Promise<string | null> {
  // A Maki session's folder is its first line's (its header's) cwd; a log format it does not know throws MakiLogFormatError.
  if (isMakiSessionPath(transcript)) return makiHeaderFolder(await reader.read(transcript, 0, maxMakiHeaderBytes));
  // A Kiro V3 session's folder is its session.json's first workspace path (one bounded read); a data
  // model it does not know throws KiroSessionFormatError; no session.json, none.
  const kiro = kiroSessionJSONPath(transcript);
  if (kiro !== null) {
    try {
      return kiroSessionFolder(await reader.read(kiro, 0, maxKiroSessionBytes));
    } catch (error) {
      if (error instanceof TranscriptNotFoundError) return null;
      throw error;
    }
  }
  // A Cursor chat's folder is its meta.json's `cwd` (the same rule over Cursor's file).
  const meta = cursorMetaPath(transcript);
  if (meta !== null) {
    try {
      return cursorMetaFolder(await reader.read(meta, 0, maxCursorMetaBytes));
    } catch (error) {
      if (error instanceof TranscriptNotFoundError) return null;
      throw error;
    }
  }
  const summary = grokSummaryPath(transcript);
  if (summary === null) return null;
  try {
    return grokSummaryFolder(await reader.read(summary, 0, maxGrokSummaryBytes));
  } catch (error) {
    if (error instanceof TranscriptNotFoundError) return null;
    throw error;
  }
}

/** The feed's session is the locator's ref (the app's), not only a format. */
const isSessionRef = (session: FeedSession): session is TranscriptSessionRef => "lookup" in session;

export const defaultPollIntervalMs = 1_000;
/** The format check covers this many lines from the first load. */
export const formatCheckLines = 200;
/** While live, this many failed polls in a row make the chat unavailable. */
export const liveFailureLimit = 3;
/** One load of earlier messages reads this much at a time… */
export const defaultEarlierStepBytes = 2 * 1_024 * 1_024;
/** …and reads on (up to this many steps) while it finds nothing to show. */
export const earlierStepsWhileEmpty = 4;

/**
 * How a cold first load reads: the end's first `window`, then earlier in
 * `chunkBytes` reads (one pipelined SFTP read each) only until the timeline holds `turns` turns (a
 * screenful, three, and one more) or the file's start; Load earlier goes on from there.
 */
export interface ChatColdLoad {
  readonly window: number;
  readonly turns: number;
  readonly chunkBytes: number;
  /**
   * As in the iOS app, a screenful is `turns` turns or `items` display items,
   * whichever comes first (a long agentic turn full of screenshots fills the screen long before four of your
   * messages); absent: turns only.
   */
  readonly items?: number;
  /**
   * How much one read back of the screenful reads, `[least, most]` (at most one relay `read` frame): sized by
   * what was read so far (the bytes an item has taken, times the items still missing, or the same by whole
   * turns where that is nearer, a quarter more); absent: `chunkBytes` each.
   */
  readonly readBytes?: readonly [number, number];
  /** The screenful's read backs read every byte once: the tail of a line one ends inside waits for the next. */
  readonly readsOnce?: boolean;
}

/**
 * 512 KB first, then a screenful (four turns or 20 items) read back in reads of 1 to 4 MB (`relayReadMax`:
 * one relay frame each); 2 MB reads where a line's start is looked for.
 */
export const standardColdLoad: ChatColdLoad = {
  window: 512 * 1_024,
  turns: 4,
  items: 20,
  chunkBytes: 2 * 1_024 * 1_024,
  readBytes: [1_024 * 1_024, 4 * 1_024 * 1_024],
  readsOnce: true,
};

/** A cold load as the feed runs it (every field given). */
interface ColdLoad {
  readonly window: number;
  readonly turns: number;
  readonly chunkBytes: number;
  /** `Infinity`: turns only. */
  readonly items: number;
  readonly readBytes: readonly [number, number];
  readonly readsOnce: boolean;
}

function coldLoad(cold: ChatColdLoad): ColdLoad {
  const chunkBytes = Math.max(1, cold.chunkBytes);
  const range = cold.readBytes ?? [chunkBytes, chunkBytes];
  const least = Math.max(1, range[0]);
  return {
    window: Math.max(1, cold.window),
    turns: Math.max(1, cold.turns),
    chunkBytes,
    items: cold.items === undefined ? Infinity : Math.max(1, cold.items),
    readBytes: [least, Math.max(least, range[1])],
    readsOnce: cold.readsOnce === true,
  };
}

/**
 * The read back that should complete a screenful of `want` items, the `held` ones having
 * taken `spanned` bytes up to the end read; with `turns` (`held` of `want`, `whole` of them begun with your
 * message), the nearer of the two: the screenful is whichever comes first. A quarter more, within `readBytes`.
 */
export function coldNextRead(
  readBytes: readonly [number, number],
  held: number,
  want: number,
  spanned: number,
  turns: { readonly whole: number; readonly held: number; readonly want: number } | null = null,
): number {
  const [least, most] = readBytes;
  if (least >= most) return least;
  const bytes = (per: number, missing: number): number => Math.floor(spanned / Math.max(1, per)) * Math.max(1, missing);
  let estimate = bytes(held, want - held);
  if (turns !== null && turns.whole > 0) estimate = Math.min(estimate, bytes(turns.whole, turns.want - turns.held));
  const padded = estimate + Math.floor(estimate / 4);
  return Math.min(Math.max(Number.isFinite(padded) ? padded : most, least), most);
}

/**
 * What a first load reads on for, once its screenful is in, without showing it: the
 * Model and Effort chips' values when nothing read so far named them (a screenful of your messages after a
 * picture longer than the window, say). Lines go to `line` oldest first in each chunk, chunk by chunk back
 * from where the loaded part starts, while `wants()` says so, at most `lookBackBytes`.
 */
export interface ChatLookBack {
  wants(): boolean;
  line(text: string, offset: number): void;
}

/**
 * A reader whose own reads feed something (the chips' settings tap) and that can also
 * read without feeding it: the look-back reads that way, so only the lines its guard lets through reach
 * the settings, through `ChatLookBack.line`.
 */
export interface TranscriptUntappedReading {
  readUntapped(path: string, offset: number, maxBytes: number): Promise<Uint8Array>;
}

function isUntappedReading(reader: unknown): reader is TranscriptUntappedReading {
  return typeof (reader as Partial<TranscriptUntappedReading>).readUntapped === "function";
}

/** `first` then `second`, one array. */
function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first, 0);
  joined.set(second, first.length);
  return joined;
}

/** How far back a look-back reads at most (past the per-line bound three times). */
export const lookBackBytes = 24 * 1_024 * 1_024;
/** How long a look-back reads on at most (active time; a pause stops its clock). */
export const lookBackMs = 10_000;

export interface ChatFeedOptions {
  readonly pollIntervalMs?: number;
  readonly maxItems?: number;
  readonly historyCap?: number;
  readonly earlierStepBytes?: number;
  readonly earlierChunkBytes?: number;
  /** How a first load reads (absent: the last 4 MB). */
  readonly cold?: ChatColdLoad;
  /**
   * What a running subagent's step is read with (absent: the feed's reader). The app
   * gives the reader under its settings tap, so the chips' tap sees the transcript's reads only.
   */
  readonly subagentReader?: SubagentStepReader;
  /** Whether Chat is on show (absent: while not paused); not on show, no step is read. */
  readonly stepsShown?: () => boolean;
  /**
   * How many times Chat was hidden (absent: never counted): a pass begun before a later hide is
   * over even when Chat shows again before the feed looks (the twin of Swift's `ChatStepsShown.revision`).
   */
  readonly stepsRevision?: () => number;
  /** At most one read of the steps per this (absent: a second). */
  readonly stepIntervalMs?: number;
  /** The chips' look-back after a first load (absent: none). */
  readonly lookBack?: ChatLookBack;
  /** The look-back's time budget (absent: `lookBackMs`). */
  readonly lookBackMs?: number;
}

/** The folder rule lives with the locator (one copy); re-exported here as the Swift ChatFeed.swift names it. */
export { ChatFolderMatch };

/** Two snapshots show the same (items are never changed in place, so identity is enough). */
export function sameTimeline(a: ChatTimeline, b: ChatTimeline): boolean {
  if (a === b) return true;
  if (a.title !== b.title || a.earlier !== b.earlier || a.newerWaiting !== b.newerWaiting || a.turns.length !== b.turns.length) return false;
  // The running subagents out of the window count too (absent: none), so the Working line's count follows them.
  if ((a.hiddenRunning?.background ?? 0) !== (b.hiddenRunning?.background ?? 0) || (a.hiddenRunning?.foreground ?? 0) !== (b.hiddenRunning?.foreground ?? 0)) return false;
  // What runs (the Running strip's items) counts too.
  if (!sameRunning(a.running, b.running)) return false;
  return a.turns.every((turn, index) => {
    const other = b.turns[index]!;
    return (
      turn.id === other.id &&
      turn.startedAt === other.startedAt &&
      turn.lastEventAt === other.lastEventAt &&
      turn.endedAt === other.endedAt &&
      turn.isFinished === other.isFinished &&
      turn.reportedDuration === other.reportedDuration &&
      turn.isPartial === other.isPartial &&
      turn.items.length === other.items.length &&
      turn.items.every((item, at) => item === other.items[at])
    );
  });
}

const sameState = (a: ChatFeedState, b: ChatFeedState): boolean =>
  a.status === b.status && (a.status !== "unavailable" || b.status !== "unavailable" || (a.reason === b.reason && a.folder === b.folder));

interface Follow<S> {
  readonly session: S;
  readonly paneFolders: readonly string[];
}

interface Work {
  cancelled: boolean;
}

export class ChatFeed<S extends FeedSession = FeedSession> {
  private readonly reader: TranscriptFileReader<S>;
  private readonly pollIntervalMs: number;
  private readonly maxItems: number;
  private readonly historyCap: number;
  private readonly earlierStepBytes: number;
  private readonly earlierChunkBytes: number;
  private readonly listeners = new Set<(update: ChatFeedUpdate) => void>();
  private work: Work | null = null;
  private generation = 0;
  private followed: Follow<S> | null = null;
  private readonly sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; wake: (goOn: boolean) => void }>();
  /** The followed file's watch, while one is asked for or live. */
  private watched: Watched | null = null;
  /** Relay contract v1.1: a watch's `reset` (the file shrank or was replaced): the follow reads it again from its start. */
  private rereadFile: string | null = null;
  /** How a first load reads (null: the last 4 MB). */
  private readonly cold: ColdLoad | null;
  private readonly lookBack: ChatLookBack | null;
  private readonly lookBackBudgetMs: number;
  /** The look-back now running (a newer number, or a new follow, ends it). */
  private lookBackRun = 0;
  /** Where a first load's look-back starts, once that load is done (null: none due). */
  private lookBackFrom: number | null = null;
  /** A look-back a pause stopped: read on from here after the resume. */
  private lookBackHeld: { readonly file: string; readonly from: number; readonly bytesLeft: number; readonly current: number } | null = null;
  /** The look-back is reading (a read in flight, maybe). */
  private lookBackLive = false;
  /** Its clock: the active time left as of `lookBackSince` (null: stopped, by a pause). */
  private lookBackLeftMs = 0;
  private lookBackSince: number | null = null;
  private paused = false;
  private readonly pauseWaiters = new Set<() => void>();
  /** The follow's first load (with its cold reads) has finished. */
  private firstLoadDone = false;
  /**
   * As in the iOS app: a cold first load still has less than a screenful and reads it back (earlier history
   * shows as loading meanwhile); a pause leaves it to the read after the resume.
   */
  private screenToFill = false;
  /**
   * The items a cold first load reads back to at least (the launch cache's on show while it
   * does, so the screen never holds fewer), beside its screenful; 0: the screenful alone.
   */
  private fillItems = 0;
  /**
   * The screenful's reader between its read backs (the tail of the line its last read ended
   * inside, read once), for the history it read (`windowRevision`) and only while what is held starts where
   * it left off.
   */
  private fillCarry: { readonly reader: TranscriptEarlierReader; readonly revision: number } | null = null;
  /**
   * Where the cold load's reads reach back to (its first window's start, then each read
   * back's), and the end it read to: the bytes its items took, for the next read's size.
   */
  private coldSpan: { from: number; readonly to: number } | null = null;
  private loadWaiters: ((live: boolean) => void)[] = [];

  private builder: ChatTimelineBuilder;
  private format: TranscriptFormat | null = null;
  private paneFolders: readonly string[] = [];
  private folderChecked = true;
  /**
   * This follow ended because a line it read while following moved the transcript's folder out of the pane's (the
   * check in follow). A cold load's or a start-over's mismatch is not this. A new follow (start) clears it; the chat
   * service keeps such a follow ended for its binding.
   */
  private moved = false;
  /** Where the timeline's earliest line starts: what is before it is unread. */
  private historyStart: number | null = null;
  /** Counts new timelines and trims of the loaded start: a load of earlier lines begun before one is dropped. */
  private windowRevision = 0;
  private seenTrims = 0;
  private earlierLoading = false;
  private earlierFailed = false;
  private earlierLoadSerial = 0;
  /** The opening of what is held, from `historyStart` to the live parser's last line. */
  private earliestOpening: TranscriptSeamOpening | null = null;
  /** Seams joined since the live parser last read: it takes them on before it reads on. */
  private seamsToAdopt: TranscriptSeam[] = [];
  private followsNewest = true;
  private newerWaiting = false;
  /** What the follow knows of `caughtUp`, and what the last update said. */
  private caught = false;
  private publishedCaught = false;

  state: ChatFeedState = { status: "idle" };
  timeline: ChatTimeline = emptyTimeline;
  /** Line counts for the followed file (diagnostics). */
  parseStats = new TranscriptParseStats();
  /** The followed file's path, once found. */
  path: string | null = null;
  /** The followed file's inode as the last read with identity gave it (null: not known). */
  private fileInode: number | null = null;
  /** The transcript's working folder, once a line has given it. */
  transcriptFolder: string | null = null;
  /** The followed Grok session's folder (its summary.json's info.cwd). */
  private grokFolder: string | null = null;
  /**
   * The followed file's header lines, as its header-format load read them (null:
   * none), with the unread middle's ownership records after the head's, oldest first.
   */
  private header: readonly string[] | null = null;
  /**
   * What the followed Codex rollout's header was proven to say on this load, and the file it was read from (its inode;
   * null: not known). Bytes are shown only from that file; a load, a reload or a reset proves it again first.
   */
  private codexProof: { readonly header: CodexHeader; readonly ino: number | null } | null = null;
  /** Lines over the line bound that loads of earlier messages read through and dropped. */
  earlierLongLines = 0;
  /** Bytes read from the transcript so far (diagnostics, tests). */
  bytesRead = 0;
  /** The subagents' step reads. */
  private readonly subagentReader: SubagentStepReader;
  private readonly stepsShown: () => boolean;
  private readonly stepsRevision: () => number;
  private readonly stepIntervalMs: number;
  private steps: SubagentSteps;
  /** The step pass now current (a newer number ends it), and whether one is reading. */
  private stepRun = 0;
  private stepLive = false;
  /** `stepsRevision` when the pass in flight began. */
  private stepShownRevision = 0;

  constructor(reader: TranscriptFileReader<S>, options: ChatFeedOptions = {}) {
    this.reader = reader;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.maxItems = options.maxItems ?? defaultMaxItems;
    this.historyCap = Math.max(this.maxItems, options.historyCap ?? defaultHistoryCap);
    this.earlierStepBytes = Math.max(1, options.earlierStepBytes ?? defaultEarlierStepBytes);
    this.earlierChunkBytes = Math.max(1, options.earlierChunkBytes ?? defaultEarlierChunkBytes);
    this.cold = options.cold === undefined ? null : coldLoad(options.cold);
    this.lookBack = options.lookBack ?? null;
    this.lookBackBudgetMs = Math.max(0, options.lookBackMs ?? lookBackMs);
    this.builder = new ChatTimelineBuilder(this.maxItems, this.historyCap);
    this.subagentReader = options.subagentReader ?? reader;
    this.stepsShown = options.stepsShown ?? (() => true);
    this.stepsRevision = options.stepsRevision ?? (() => 0);
    this.stepIntervalMs = Math.max(1, options.stepIntervalMs ?? defaultStepIntervalMs);
    this.steps = new SubagentSteps(this.stepIntervalMs);
  }

  // MARK: a running subagent's step

  /**
   * The running subagents' newest steps, read with the feed's reader (tail only) at most once a
   * `stepIntervalMs`, only while on show and not paused; a read that fails leaves the agent without a step and
   * the chat as it was. A pass runs beside the follow, after its load is published (never
   * holding up a load or a live poll), one at a time, issuing no request after `stepPassMs`; what it read is
   * published as it ends. It ends with its follow (stop, a new follow, a start-over, a pause, the
   * follow's end) and with Chat hidden, checked before and after every request. Chat hidden ends
   * the pass for good, shown again or not (seen by the follow's polls, by the pass itself, and by `stepsRevision`
   * when Chat was hidden and shown again between two looks), and so does `endSession`; showing again lets a fresh
   * pass start.
   */
  private scheduleSteps(file: string, current: number): void {
    if (this.stepLive || this.paused || !this.steps.due) return;
    const revision = this.stepsRevision();
    if (!this.stepsShown()) return;
    this.stepRun += 1;
    this.stepLive = true;
    this.stepShownRevision = revision;
    void this.stepPass(this.stepRun, current, file, this.steps, this.builder.runningSubagents());
  }

  /** Chat hidden since the pass in flight began (now, or hidden and shown again) ends it for good. */
  private endHiddenSteps(): void {
    if (this.stepLive && !(this.stepsShown() && this.stepsRevision() === this.stepShownRevision)) this.retireSteps();
  }

  /** The pass `run` may go on: its follow current, not paused, Chat on show all along since it began (else it is ended for good). */
  private stepGoing(run: number, current: number): boolean {
    if (!this.isCurrent(current) || run !== this.stepRun || this.paused) return false;
    if (this.stepsShown() && this.stepsRevision() === this.stepShownRevision) return true;
    this.retireSteps();
    return false;
  }

  private async stepPass(run: number, current: number, file: string, steps: SubagentSteps, agents: readonly ChatSubagent[]): Promise<void> {
    const started = performance.now();
    const going = (): boolean => this.stepGoing(run, current);
    // With a call id, that call still runs; without one (the folder's discovery), one of the pass's agents does.
    const alive = (callID?: string): boolean =>
      going() &&
      performance.now() - started < stepPassMs &&
      (callID === undefined ? agents.some((agent) => this.builder.subagentRuns(agent.id)) : this.builder.subagentRuns(callID));
    try {
      const found = await steps.read(this.subagentReader, file, agents, alive);
      if (!going()) return;
      let changed = false;
      for (const [id, step] of found) if (this.builder.setSubagentStep(id, step)) changed = true;
      if (changed && this.state.status === "live") this.publish(this.state, this.snapshot);
    } finally {
      if (run === this.stepRun) this.stepLive = false;
    }
  }

  /** The step pass in flight is over: nothing it reads later is kept or shown. */
  private retireSteps(): void {
    this.stepRun += 1;
    this.stepLive = false;
  }

  /** How many subagents the step reads remember (diagnostics, tests). */
  get subagentStepsKnown(): number {
    return this.steps.known;
  }

  // MARK: paused while not on show

  /** Paused: nothing is read until `resume`. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Nothing more is read until `resume`; what is held stays. */
  pause(): void {
    this.paused = true;
    // A step pass ends with the pause (the next one starts after the resume).
    this.retireSteps();
    // The look-back's clock stops, a read in flight or not.
    this.stopLookBackClock();
  }

  /** Reads on at once from where it was. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // The file grew meanwhile, maybe: caught up again only once read (the next read says so,
    // as an update even when nothing else changed: its follower was told false meanwhile).
    this.caught = false;
    this.publishedCaught = false;
    this.wakeAll(true);
    // A look-back the pause stopped reads on (in the active time it has left);
    // one whose read was in flight goes on with its clock running again.
    const held = this.lookBackHeld;
    this.lookBackHeld = null;
    if (held !== null && this.isCurrent(held.current)) this.scheduleLookBack(held.file, held.from, held.bytesLeft, this.lookBackLeftMs, held.current);
    else if (this.lookBackLive && this.lookBackSince === null) this.lookBackSince = performance.now();
  }

  /** Waits until the follow's first load (with its cold reads) is done: true when live, false when it ended or stopped first. */
  loaded(): Promise<boolean> {
    if (this.firstLoadDone) return Promise.resolve(this.state.status === "live");
    if (this.work === null || (this.state.status !== "loading" && this.state.status !== "live")) return Promise.resolve(false);
    return new Promise((resolve) => this.loadWaiters.push(resolve));
  }

  private finishLoadWaiters(live: boolean): void {
    const waiters = this.loadWaiters;
    this.loadWaiters = [];
    for (const waiter of waiters) waiter(live);
  }

  /** Ends the poll's waits (`goOn`: the follow reads on) and the waits while paused. */
  private wakeAll(goOn: boolean): void {
    for (const sleeper of this.sleepers) {
      clearTimeout(sleeper.timer);
      sleeper.wake(goOn);
    }
    this.sleepers.clear();
    for (const waiter of this.pauseWaiters) waiter();
    this.pauseWaiters.clear();
  }

  /** The follow's sleep ends now (a pushed `grew`, or the watch's end); a pause still holds it. */
  private wakeSleepers(): void {
    for (const sleeper of this.sleepers) {
      clearTimeout(sleeper.timer);
      sleeper.wake(true);
    }
    this.sleepers.clear();
  }

  /** A live watch on `file` (pushed bytes may stand in for reads). */
  private watchLive(file: string): Watched | null {
    const watched = this.watched;
    return watched !== null && watched.path === file && watched.handle !== null && !watched.over ? watched : null;
  }

  private closeWatch(): void {
    const watched = this.watched;
    this.watched = null;
    if (watched === null) return;
    watched.over = true;
    watched.chunks = [];
    watched.length = 0;
    watched.omitted = [];
    watched.handle?.close();
    watched.handle = null;
  }

  /**
   * Watches `file` from `offset` once the follow reached its end (not a Cursor store's
   * view); a watch already asked for the file stands. A `grew` wakes the follow at once with its bytes;
   * `reset` and `gone` end the watch and wake the follow, whose next size takes the usual paths (a shrink, a
   * missing file).
   */
  private ensureWatch(file: string, offset: number, current: number): void {
    if (!isTranscriptWatching(this.reader) || isStoreFormat(this.format)) return;
    const now = this.watched;
    if (now !== null && now.path === file && !now.over) return;
    this.closeWatch();
    const watched: Watched = { path: file, handle: null, start: offset, chunks: [], length: 0, omitted: [], size: null, over: false };
    this.watched = watched;
    const ended = (): void => {
      if (this.watched !== watched) return;
      this.closeWatch();
      if (this.isCurrent(current)) this.wakeSleepers();
    };
    void this.reader
      .watch(file, offset, {
        grew: (at, size, data, omitted) => {
          if (this.watched !== watched || watched.over) return;
          // Bytes that do not follow what is held start the hold again from them.
          if (at !== watched.start + watched.length) {
            watched.chunks = [];
            watched.length = 0;
            watched.omitted = [];
            watched.start = at;
          }
          if (data.length > 0) {
            watched.chunks.push(data);
            watched.length += data.length;
            // Relay rule 7: each grew's runs, judged on its own bytes (a run across two comes in parts).
            if (omitted !== undefined && omitted.length > 0) watched.omitted.push(...clipBlobs(omitted, at, at + data.length));
          }
          watched.size = size;
          if (watched.length > maxPushedBytes) {
            ended();
            return;
          }
          if (this.isCurrent(current)) this.wakeSleepers();
        },
        // Contract v1.1: a reset can come while the follow is still catching up on bytes it read or was
        // pushed before; what is held is dropped and the file is read again from its start.
        reset: () => {
          if (this.watched !== watched) return;
          this.rereadFile = file;
          ended();
        },
        gone: ended,
        ended,
      })
      .then(
        (handle) => {
          if (this.watched !== watched || watched.over) {
            handle?.close();
            return;
          }
          if (handle === null) this.watched = null;
          else watched.handle = handle;
        },
        () => {
          if (this.watched === watched) this.watched = null;
        },
      );
  }

  /**
   * The bytes a follow read asks for, when the watch pushed them all from its offset, with the runs left out
   * of them; null otherwise.
   */
  private pushedBytes(file: string, offset: number, maxBytes: number): { readonly data: Uint8Array; readonly omitted: readonly BlobRange[] } | null {
    const watched = this.watchLive(file);
    if (watched === null || offset < watched.start || offset >= watched.start + watched.length) return null;
    const joined = joinChunks(watched.chunks);
    watched.chunks = [joined];
    const from = offset - watched.start;
    const data = joined.subarray(from, Math.min(joined.length, from + maxBytes));
    return { data, omitted: clipBlobs(watched.omitted, offset, offset + data.length) };
  }

  /** What the follow took is let go of (it reads on from `offset`). */
  private dropPushedBefore(file: string, offset: number): void {
    const watched = this.watchLive(file);
    if (watched === null || offset <= watched.start) return;
    const joined = joinChunks(watched.chunks);
    const cut = Math.min(joined.length, offset - watched.start);
    const rest = joined.subarray(cut);
    watched.chunks = rest.length === 0 ? [] : [rest];
    watched.length = rest.length;
    watched.start += cut;
    if (watched.omitted.length > 0) watched.omitted = clipBlobs(watched.omitted, watched.start, Infinity);
  }

  private async waitWhilePaused(current: number): Promise<void> {
    while (this.paused && this.isCurrent(current)) {
      await new Promise<void>((resolve) => this.pauseWaiters.add(resolve));
    }
  }

  /**
   * After a cold first load, earlier messages are read until the timeline holds `cold.turns`
   * turns, the file's start or the cap is reached, a read fails, or the feed is paused.
   */
  /**
   * Where the line that holds `offset` starts (just after the last line break before it; 0 at the
   * file's start), read back in chunks and never parsed; null when it is longer than a line may be
   * (`maxLineBytes`: dropped anyway), a read comes back short (the file changed) or the follow is over.
   */
  private async unfinishedLineStart(file: string, offset: number, current: number): Promise<number | null> {
    const chunk = this.cold?.chunkBytes ?? this.earlierChunkBytes;
    let cursor = offset;
    while (cursor > 0) {
      if (offset - cursor >= maxLineBytes) return null;
      const start = Math.max(0, cursor - chunk);
      // Relay rule 1: with runs left out while the relay is up (every line break is kept).
      const read = await this.readLeavingOut(file, start, cursor - start, this.fileInode);
      if (!this.isCurrent(current) || read === null || read.data.length !== cursor - start) return null;
      const bytes = read.data;
      const lastBreak = bytes.lastIndexOf(0x0a);
      if (lastBreak >= 0) return start + lastBreak + 1;
      cursor = start;
    }
    return 0;
  }

  /**
   * The look-back starts after the first load is done (`loaded()` has resolved), as work
   * of its own beside the follow: live reads go on at their cadence while it reads.
   */
  private scheduleLookBack(file: string, from: number, bytes: number, budgetMs: number, current: number): void {
    this.lookBackRun += 1;
    const run = this.lookBackRun;
    this.lookBackLive = true;
    this.lookBackLeftMs = budgetMs;
    this.lookBackSince = this.paused ? null : performance.now();
    setTimeout(() => void this.readBackForLookBack(run, file, from, bytes, current), 0);
  }

  /** The look-back's active time left. */
  private lookBackRemainingMs(): number {
    if (this.lookBackSince === null) return this.lookBackLeftMs;
    return Math.max(0, this.lookBackLeftMs - (performance.now() - this.lookBackSince));
  }

  private stopLookBackClock(): void {
    if (this.lookBackSince === null) return;
    this.lookBackLeftMs = this.lookBackRemainingMs();
    this.lookBackSince = null;
  }

  /**
   * The look-back ends with the follow, on every path (stop, a new follow, a start-over,
   * the follow ending unavailable): its run is no longer current, so a read in flight is dropped when it
   * returns and no more are made; one a pause held is let go.
   */
  private retireLookBack(): void {
    this.lookBackRun += 1;
    this.lookBackLive = false;
    this.lookBackHeld = null;
    this.lookBackFrom = null;
    this.lookBackLeftMs = 0;
    this.lookBackSince = null;
  }

  /**
   * Reads back from `from` (the loaded part's start) for the look-back, whole lines
   * only (the earlier reader's framing: a chunk boundary never drops a line, one over the per-line bound is
   * passed over), never parsed for the timeline. One chunk, then on only while it still wants (a live line
   * that names the model ends it); ends at the file's start, after `bytes` or its active time (a pause stops
   * the clock, a read in flight or not), on a failed or short read, a newer look-back or when the follow is
   * over; a pause holds it. Every read's answer passes the guard (this follow and run, time left, the
   * model still wanted) when it returns, before anything reads it: it is read past the settings tap, and
   * only the guarded lines reach the settings, through the hook.
   */
  private async readBackForLookBack(run: number, file: string, from: number, bytes: number, current: number): Promise<void> {
    const hook = this.lookBack;
    if (hook === null || from <= 0) return;
    const going = (): boolean => this.isCurrent(current) && run === this.lookBackRun && this.lookBackRemainingMs() > 0 && hook.wants();
    const reader = this.reader;
    // Relay rule 1: past the tap with runs left out while the relay is up (the chips read no
    // base64; a run's bytes stay filler), else an untapped read where the reader has one. What
    // came over the link is counted.
    const read = async (offset: number, maxBytes: number): Promise<Uint8Array> => {
      const leftOut = isRangeReading(reader) && !isStoreFormat(this.format) ? await reader.readRange(file, offset, maxBytes, { omit: true }) : null;
      if (leftOut !== null) {
        this.bytesRead += keptLength(leftOut.data.length, leftOut.omitted);
        return leftOut.data;
      }
      const bytes = await (isUntappedReading(reader) ? reader.readUntapped(file, offset, maxBytes) : reader.read(file, offset, maxBytes));
      this.bytesRead += bytes.length;
      return bytes;
    };
    const earlier = new TranscriptEarlierReader(from, this.cold?.chunkBytes ?? this.earlierChunkBytes);
    try {
      while (going() && earlier.bytesRead < bytes) {
        if (this.paused) {
          this.lookBackHeld = { file, from: earlier.end, bytesLeft: bytes - earlier.bytesRead, current };
          return;
        }
        const next = earlier.nextRead();
        if (next === null) return;
        let chunk: Uint8Array;
        try {
          chunk = await read(next.offset, next.maxBytes);
        } catch {
          return;
        }
        if (!going()) return;
        const lines = earlier.consume(next.offset, chunk);
        if (lines === null) return;
        for (const line of lines) hook.line(line.text, line.offset);
      }
    } finally {
      if (run === this.lookBackRun) this.lookBackLive = false;
    }
  }

  // MARK: relay v1.2 reads

  /** What fetches the transcript's ranges (rule 5): past the chips' tap when the reader has one; null: none. */
  private rangeReader(): RangeReading | null {
    const reader = this.reader;
    if (isRangeReading(reader)) return { readWithIdentity: (path, offset, maxBytes) => reader.readRange(path, offset, maxBytes) };
    return isTranscriptIdentityReading(reader) ? { readWithIdentity: (path, offset, maxBytes) => reader.readWithIdentity(path, offset, maxBytes) } : null;
  }

  /**
   * Rule 1: a read with base64 runs left out while the relay is up (the file's bytes, each run filled, and the
   * runs), else a plain read; null when the reply is another file's than `ino` (replaced: the follow
   * reads it again). A relay that refuses `omit` gets plain reads (the reader learns it once).
   */
  private async readLeavingOut(file: string, offset: number, maxBytes: number, ino: number | null): Promise<LeftOutRead | null> {
    const reader = this.reader;
    if (!isStoreFormat(this.format) && isTranscriptIdentityReading(reader)) {
      const read = await reader.readWithIdentity(file, offset, maxBytes, { omit: true });
      if (read !== null) {
        if (ino !== null && read.ino !== ino) return null;
        // Kept at once: the chips' tap applies a read it held.
        if (isStartOverListening(reader)) reader.keptIdentityRead(file);
        this.bytesRead += keptLength(read.data.length, read.omitted);
        return { data: read.data, omitted: read.omitted ?? [] };
      }
    }
    const data = await reader.read(file, offset, maxBytes);
    this.bytesRead += data.length;
    return { data, omitted: [] };
  }

  /**
   * Rules 3, 5 and 6: lines read with runs left out, ready to parse. A placeholder in an image's payload or in a
   * field nothing reads stays (the parser gets its range: an image fetched on show); one in any other string is
   * put back from a plain read of its range, or an elided marker when that fails; a line whose placeholders the
   * scan cannot place (a run outside any string) is read again whole with a plain read of its range. Every read
   * goes at once (one trip), each reply checked against `ino`.
   *
   * A whole-line reread that fails (no relay now, the file replaced) is a failed read of that
   * line: it comes back `unread`, never parsed with its placeholders; the caller keeps its cursor there.
   */
  private async readyLines(file: string, lines: readonly TranscriptLine[], ino: number | null): Promise<ReadyLine[]> {
    const plans = lines.map((line) => (line.blobs === undefined || line.blobs.length === 0 ? null : blobsToRestore(line.text, line.blobs)));
    const wanted = plans.some((plan) => plan !== null && (plan.whole || plan.restore.length > 0));
    const reader = wanted ? this.rangeReader() : null;
    const fetched = await Promise.all(
      lines.map((line, index) => {
        const plan = plans[index];
        if (reader === null || plan === null || plan === undefined) return Promise.resolve([]);
        const ranges: BlobRange[] = plan.whole ? [[line.offset, (line.end ?? line.offset) - line.offset]] : plan.restore;
        return Promise.all(ranges.map((range) => fetchRange(reader, file, range, ino)));
      }),
    );
    return lines.map((line, index): ReadyLine => {
      const plan = plans[index];
      const blobs = line.blobs ?? [];
      if (plan === null || plan === undefined) return { text: line.text, offset: line.offset, blobs: null };
      const got = fetched[index] ?? [];
      for (const bytes of got) if (bytes !== null) this.bytesRead += bytes.length;
      if (plan.whole) {
        const whole = got[0] ?? null;
        const text = whole === null ? null : blobLineText(whole, line.offset, []);
        if (text === null) return { text: line.text, offset: line.offset, blobs: null, unread: true };
        return { text, offset: line.offset, blobs: null };
      }
      const put = new Map<BlobRange, Uint8Array | null>();
      for (const [at, range] of plan.restore.entries()) {
        const bytes = got[at] ?? null;
        put.set(range, bytes !== null && isBase64Run(bytes) ? bytes : null);
      }
      const text = plan.restore.length === 0 ? line.text : restoreBlobs(line.text, plan.restore, (range) => put.get(range) ?? null);
      const left = blobs.filter((range) => !put.has(range));
      return { text, offset: line.offset, blobs: left.length === 0 ? null : { path: file, ino, ranges: left } };
    });
  }

  /**
   * Relay rule 5: an image's base64 fetched on show: only from the file followed now (its path and
   * inode), with plain relay reads; null otherwise, or when a read fails or the file changed under it.
   */
  async fetchImage(blob: ChatImageBlob): Promise<string | null> {
    if (this.path === null || blob.path !== this.path || (blob.ino !== null && this.fileInode !== null && blob.ino !== this.fileInode)) return null;
    const reader = this.rangeReader();
    if (reader === null) return null;
    return fetchImageBase64(reader, { ...blob, ino: blob.ino ?? this.fileInode });
  }

  private async fillScreen(cold: ColdLoad, current: number): Promise<void> {
    let last: number | null = null;
    for (;;) {
      const start = this.historyStart;
      if (!this.isCurrent(current) || this.paused || !this.needsFill(cold)) break;
      if (start === null || start <= 0 || start === last || this.builder.isAtHistoryCap) break;
      last = start;
      // Sized by the items and whole turns read so far (the plain load: `chunkBytes`); the
      // cache's items to reach (`fillItems`): by the items only.
      const held = this.shownItemCount;
      const want = Math.max(this.fillItems, cold.items === Infinity ? held + 1 : cold.items);
      const spanned = this.coldSpan === null ? 0 : Math.max(0, this.coldSpan.to - this.coldSpan.from);
      const shown = this.builder.timeline.turns;
      const turns = held < this.fillItems ? null : { whole: shown.filter((turn) => !turn.isPartial).length, held: shown.length, want: cold.turns };
      const bytes = coldNextRead(cold.readBytes, held, want, spanned, turns);
      // Twice the items missing are parsed at most (the seam may take a few).
      const target = Math.max(this.fillItems, cold.items);
      const parse = cold.readsOnce && Number.isFinite(target) ? 2 * Math.max(1, target - held) : null;
      await this.loadEarlierIn(bytes, bytes, cold.readsOnce, parse);
      if (this.earlierFailed) break;
    }
    // Paused, it reads on after the resume; else the screenful is done (or cannot be: the file's start, the
    // cap, a failed read).
    if (!this.isCurrent(current) || this.paused) return;
    this.screenToFill = false;
    this.fillCarry = null;
    if (this.state.status === "live" && !sameTimeline(this.snapshot, this.timeline)) this.publish({ status: "live" }, this.snapshot);
  }

  /** The display items on show. */
  private get shownItemCount(): number {
    return this.builder.timeline.turns.reduce((count, turn) => count + turn.items.length, 0);
  }

  /**
   * A cold first load reads earlier while the timeline holds less than a screenful
   * (`cold.turns` turns or `cold.items` items) or fewer items than `fillItems`.
   */
  private needsFill(cold: ColdLoad): boolean {
    const items = this.shownItemCount;
    return (this.builder.timeline.turns.length < cold.turns && items < cold.items) || items < this.fillItems;
  }

  /** Snapshots as they change. Returns the unsubscribe. */
  subscribe(listener: (update: ChatFeedUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Follows `session`; null (no usable session on the pane) is unavailable at
   * once. `paneFolders` are the pane's working folders; empty skips the folder
   * check. Starting what is already followed is ignored while loading or live.
   *
   * `fillItems`: the items its cold first load reads back to at least (the launch cache's
   * on show), beside its screenful.
   */
  start(session: S | null, paneFolders: readonly string[] = [], fillItems = 0): void {
    const folders = paneFolders.filter((folder) => ChatFolderMatch.normalised(folder).length > 0);
    const follow = session === null ? null : { session, paneFolders: folders };
    if (
      follow !== null &&
      this.followed !== null &&
      sameFollow(follow, this.followed) &&
      this.work !== null &&
      (this.state.status === "loading" || this.state.status === "live")
    ) {
      return;
    }
    this.cancelWork();
    this.moved = false;
    this.fillItems = Math.max(0, fillItems);
    this.followed = follow;
    const current = this.generation;
    this.publish({ status: "loading" }, emptyTimeline);
    const work: Work = { cancelled: false };
    this.work = work;
    void this.follow(session, folders, current);
  }

  /**
   * The follow ended (sessionMismatch) because a line it read while following moved the transcript's folder
   * out of the pane's; false for any other end, and once a follow starts again.
   */
  get ownershipMoved(): boolean {
    return this.moved;
  }

  /** Whether the chat on show follows its newest message (pinned to the bottom). */
  setFollowingNewest(following: boolean): void {
    if (following === this.followsNewest) return;
    this.followsNewest = following;
    this.builder.keepsTop = false;
    if (!following) return;
    // Following again, the shown limit returns to `maxItems` (shown at once).
    this.builder.followNewest();
    if (this.state.status === "live") this.publish(this.state, this.snapshot);
  }

  /**
   * The session it follows ended (the agent exited, or
   * a new run started in the pane): every task and subagent still running is
   * stopped at `time` (seconds; now when null), and stays so whatever is read later.
   */
  endSession(time: number | null = null): void {
    // The step pass in flight ends with the session, for good.
    this.retireSteps();
    if (this.followed === null) return;
    this.builder.endSession(time ?? Date.now() / 1_000);
    if (this.state.status === "live") this.publish(this.state, this.snapshot);
  }

  /** Cancels all work and publishes idle with an empty timeline. */
  stop(): void {
    this.cancelWork();
    this.parseStats = new TranscriptParseStats();
    this.publish({ status: "idle" }, emptyTimeline);
  }

  private cancelWork(): void {
    this.generation += 1;
    if (this.work !== null) this.work.cancelled = true;
    this.work = null;
    this.followed = null;
    this.path = null;
    this.fileInode = null;
    this.codexProof = null;
    this.transcriptFolder = null;
    this.wakeAll(false);
    this.closeWatch();
    this.rereadFile = null;
    this.firstLoadDone = false;
    this.finishLoadWaiters(false);
    // The follow's look-back ends with it.
    this.retireLookBack();
    this.startOver(null, []);
  }

  /** A new timeline: a new file, or the file replaced. */
  private startOver(format: TranscriptFormat | null, paneFolders: readonly string[]): void {
    // A new timeline (a new file, or the file replaced) watches again from its end.
    this.closeWatch();
    this.builder = new ChatTimelineBuilder(this.maxItems, this.historyCap);
    this.format = format;
    this.paneFolders = paneFolders;
    this.folderChecked = paneFolders.length === 0;
    this.historyStart = null;
    this.windowRevision += 1;
    this.seenTrims = 0;
    this.earlierLoading = false;
    this.earlierFailed = false;
    this.screenToFill = false;
    this.fillCarry = null;
    this.coldSpan = null;
    this.earliestOpening = null;
    this.seamsToAdopt = [];
    this.newerWaiting = false;
    // A step pass of the timeline before ends with it.
    this.retireSteps();
    this.steps = new SubagentSteps(this.stepIntervalMs);
  }

  /** What lies before what is on show: lines not read yet, or items read and held but not shown. */
  private get earlierState(): ChatEarlierHistory {
    if (!((this.historyStart ?? 0) > 0 || this.builder.hiddenItemCount > 0)) return "none";
    // A cold first load's screenful still due is loading too.
    if (this.earlierLoading || this.screenToFill) return "loading";
    if (this.builder.isAtHistoryCap) return "capped";
    return this.earlierFailed ? "failed" : "available";
  }

  private get snapshot(): ChatTimeline {
    return { ...this.builder.timeline, earlier: this.earlierState, newerWaiting: this.newerWaiting };
  }

  /** After lines were applied: whether a trim moved the loaded start. */
  private noteTrims(): boolean {
    if (this.builder.trimSerial === this.seenTrims) return false;
    this.seenTrims = this.builder.trimSerial;
    this.windowRevision += 1;
    if (this.builder.keptStart !== null) this.historyStart = Math.max(this.historyStart ?? 0, this.builder.keptStart);
    return true;
  }

  // MARK: following

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** Waits the poll interval (the 10 s backstop while a watch is live); false when the follow was cancelled meanwhile. */
  private sleep(generation: number, takePushed = true): Promise<boolean> {
    const watched = this.path === null ? null : this.watchLive(this.path);
    // A grew that came while the follow read is taken at once.
    if (takePushed && watched !== null && watched.size !== null) return Promise.resolve(this.isCurrent(generation));
    const interval = watched === null ? this.pollIntervalMs : Math.max(this.pollIntervalMs, watchedBackstopMs);
    return new Promise((resolve) => {
      const sleeper = {
        timer: setTimeout(() => {
          this.sleepers.delete(sleeper);
          resolve(this.isCurrent(generation));
        }, interval),
        wake: (goOn: boolean) => resolve(goOn && this.isCurrent(generation)),
      };
      this.sleepers.add(sleeper);
    });
  }

  /** A Cursor store's revision (TranscriptStoreReading); 0 for any other reader. */
  private storeRevision(path: string): Promise<number> {
    return isTranscriptStoreReading(this.reader) ? this.reader.storeRevision(path) : Promise.resolve(0);
  }

  /**
   * The ownership records (the format's header lines) of the unread middle, oldest first: from `from` (past the
   * head's last whole line) through the line the cold tail starts inside of (`to` is its first byte; the follower
   * drops that line's bytes there, and it is earlier history after). Read forward with the reader's own reads of at
   * most `ownershipScanChunk`, `ownershipScanBytes` in all; null when that is not enough (the middle alone longer:
   * nothing read) or the load is no longer current.
   */
  private async middleOwnership(file: string, format: TranscriptFormat, from: number, to: number, size: number, current: number): Promise<string[] | null> {
    if (to - from > ownershipScanBytes) return null;
    const lines: string[] = [];
    let carry: Uint8Array = new Uint8Array(0);
    let at = from;
    let total = 0;
    while (at < size) {
      const room = ownershipScanBytes - total;
      if (room <= 0) return null;
      const bytes = await this.reader.read(file, at, Math.min(ownershipScanChunk, room, at < to ? to - at : headerBytes(format), size - at));
      if (!this.isCurrent(current)) return null;
      if (bytes.length === 0) break;
      total += bytes.length;
      const joined = carry.length === 0 ? bytes : concatBytes(carry, bytes);
      const base = at - carry.length;
      let start = 0;
      for (let newline = joined.indexOf(0x0a); newline >= 0; newline = joined.indexOf(0x0a, start)) {
        const line = headerLineOf(format, joined.subarray(start, newline));
        if (line !== null) lines.push(line);
        start = newline + 1;
        if (base + newline >= to) return lines;
      }
      carry = joined.slice(start);
      at += bytes.length;
    }
    // The line the tail starts inside of runs to the end of the file (still being written): nothing of it is parsed yet.
    return lines;
  }

  /** A parser for this file: a Grok session's carries the folder its summary.json gave. */
  private newParser(format: TranscriptFormat): TranscriptParser {
    const parser = new TranscriptParser(format);
    if (this.grokFolder !== null) parser.carryFolder(this.grokFolder);
    // And a header format's, its header (the folder and version a tail misses).
    if (this.header !== null) parser.carryHeader(this.header);
    return parser;
  }

  /**
   * The Codex rollout's header (codex-header.ts, the same bounds), read with the file's identity when the reader
   * gives it (past the chips' tap), and the inode its reads came from: null when one read had none (no relay now);
   * `mixed` when its reads came from different files (not one file's header).
   */
  private async readCodexHeaderOf(file: string): Promise<{ readonly header: CodexHeader; readonly ino: number | null; readonly mixed: boolean }> {
    const reader = this.reader;
    const identity = this.rangeReader();
    let ino: number | null | undefined;
    let mixed = false;
    const header = await readCodexHeader(async (offset, maxBytes) => {
      const read = identity === null ? null : await identity.readWithIdentity(file, offset, maxBytes);
      if (read === null) {
        ino = null;
        return isUntappedReading(reader) ? reader.readUntapped(file, offset, maxBytes) : reader.read(file, offset, maxBytes);
      }
      if (ino === undefined) ino = read.ino;
      else if (ino !== null && ino !== read.ino) mixed = true;
      return read.data;
    });
    return { header, ino: ino ?? null, mixed };
  }

  /**
   * Proves the Codex rollout at `file` the pane's by its header before a load or reload shows
   * anything of it: "proven" (the proof kept, with the inode it was read from), "wait" (no whole first line yet, or
   * its reads crossed a replacement: asked again after the poll's wait), or "over" (the follow ended: another folder's,
   * another session's, no header Chat reads, or no longer current). A read that fails throws (the follow's failure).
   */
  private async proveCodexHeader(file: string, session: S, paneFolders: readonly string[], current: number): Promise<"proven" | "wait" | "over"> {
    this.codexProof = null;
    const read = await this.readCodexHeaderOf(file);
    if (!this.isCurrent(current)) return "over";
    if (read.mixed || read.header.kind === "pending") return "wait";
    const lookup = isSessionRef(session) ? session.lookup : null;
    const verdict = codexHeaderVerdict(read.header, paneFolders, lookup !== null && lookup.kind === "id" ? lookup.id : null);
    if (verdict.kind === "otherFolder") {
      this.transcriptFolder = verdict.folder;
      this.end("codexOtherFolder", current, verdict.folder);
      return "over";
    }
    if (verdict.kind === "otherSession") {
      this.end("sessionMismatch", current);
      return "over";
    }
    if (verdict.kind === "unproven") {
      this.end("unrecognisedFormat", current);
      return "over";
    }
    this.codexProof = { header: read.header, ino: read.ino };
    return "proven";
  }

  /**
   * Whether bytes read from `file` (from inode `ino`; null: not known) are the proven file's. Both inodes known:
   * they are the same. Otherwise, conservatively, the file is asked again: its inode now (one read of no bytes)
   * when the proof has one, else its header read again, which must say the same as the proof's (and, when that read
   * has an inode, be the bytes' file). Throws as the reads do.
   */
  private async codexBytesProven(file: string, ino: number | null, current: number): Promise<boolean> {
    const proof = this.codexProof;
    if (proof === null) return false;
    if (ino !== null && proof.ino !== null) return ino === proof.ino;
    if (proof.ino !== null) {
      const identity = this.rangeReader();
      const now = identity === null ? null : await identity.readWithIdentity(file, 0, 0);
      if (!this.isCurrent(current)) return false;
      if (now !== null) return now.ino === proof.ino;
    }
    const again = await this.readCodexHeaderOf(file);
    if (!this.isCurrent(current) || this.codexProof !== proof || again.mixed) return false;
    if (!sameCodexHeader(again.header, proof.header)) return false;
    if (again.ino !== null && ((proof.ino !== null && again.ino !== proof.ino) || (ino !== null && again.ino !== ino))) return false;
    // The bytes' file and the header's are now one known file: later bytes from it need no read again.
    if (proof.ino === null && again.ino !== null && ino !== null) this.codexProof = { header: proof.header, ino: again.ino };
    return true;
  }

  /** The Codex rollout's bytes were not the proven file's: dropped, read again from its start (proven first). */
  private codexReplaced(follower: TranscriptFollower, file: string): void {
    this.codexProof = null;
    follower.reset();
    if (isStartOverListening(this.reader)) this.reader.startingOver(file, true);
  }

  private async follow(session: S | null, paneFolders: readonly string[], current: number): Promise<void> {
    if (session === null) return this.end("noSession", current);
    let found: string | null;
    try {
      found = await this.reader.locate(session);
    } catch {
      if (!this.isCurrent(current)) return;
      return this.end("unreadable", current);
    }
    if (!this.isCurrent(current)) return;
    if (found === null) return this.end("notFound", current);
    // A session the lookup excludes (a peer's, an earlier run's) is never followed.
    if (isSessionRef(session) && grokLookupExcludes(session, found)) return this.end("notFound", current);
    const file = found;
    const format = session.format;
    // A Grok session is the pane's only when its summary.json says so.
    this.grokFolder = null;
    this.header = null;
    // A Cursor chat is the pane's only when its meta.json says so (the same rule).
    // A Maki session is the pane's only when its header says so.
    // A Kiro session is the pane's only when its session.json says so (the same rule).
    if (format === "grok" || format === "cursor" || format === "maki" || format === "kiro") {
      let owner: string | null;
      try {
        owner = await grokSessionFolder(this.reader, file);
      } catch (error) {
        if (!this.isCurrent(current)) return;
        // A Maki log of a format this reader does not know is refused whole.
        if (error instanceof MakiLogFormatError) return this.end("unrecognisedFormat", current);
        if (error instanceof KiroSessionFormatError) return this.end("unrecognisedFormat", current);
        return this.end("unreadable", current);
      }
      if (!this.isCurrent(current)) return;
      if (!isSessionRef(session) || !grokSessionOwned(owner, session, paneFolders)) return this.end("sessionMismatch", current);
      this.grokFolder = owner;
    }
    // A Codex session is the pane's only when its header (the rollout's first line, session_meta)
    // says so, checked on every load and reload (below, as each starts over),
    // bound to the file the shown bytes come from.
    this.codexProof = null;
    this.path = file;

    const follower = new TranscriptFollower();
    if (this.cold !== null) follower.firstLoadBytes = this.cold.window;
    let parser = this.newParser(format);
    this.startOver(format, paneFolders);
    let formatChecked = false;
    let failures = 0;
    let loaded = false;
    // The size a catch-up reads to. A follow read that left the end the
    // size gave unread reads on at once, from that size: the size is asked again only once read to.
    let readingTo: number | null = null;
    // The store's revision the timeline was read at; when it moves (its root lists other
    // messages, not more), the view is read again from its end as a first load.
    let readRevision: number | null = null;
    // The followed file's inode as the last combined read gave it (null: not known).
    let inode: number | null = null;
    // A first load's look-back waits for its screenful (one a pause cut short reads on later).
    let lookBackDue = false;
    while (this.isCurrent(current)) {
      // Not on show, nothing is read.
      await this.waitWhilePaused(current);
      if (!this.isCurrent(current)) return;
      // A follow read that left the file's end unread reads again at once.
      let behind = false;
      let startedOver = false;
      // A line of this read could not be read again whole: read again after the wait.
      let unread = false;
      const known: number | null = readingTo;
      readingTo = null;
      // Newer messages wait in the file while you read with the most kept on show.
      if (this.newerWaiting && !this.followsNewest) {
        if (!(await this.sleep(current, false))) return;
        continue;
      }
      try {
        // A watch's grew gives the size (no request); the backstop asks for it.
        const watched = known === null && !isStoreFormat(format) ? this.watchLive(file) : null;
        const pushedSize = watched?.size ?? null;
        if (watched !== null) watched.size = null;
        // A poll the push does not cover is one combined read (bytes, size and inode
        // together) from the offset the follow reads next; without one (no relay), the size and then a read.
        let polled: { readonly offset: number; readonly data: Uint8Array; readonly omitted: readonly BlobRange[] } | null = null;
        // Relay v1.2, rule 1: a cold first load's read is a `tail` read: the size, the inode and
        // the window's bytes in one trip (no size first). The reader hears the reread before it.
        let tailRead: TranscriptIdentityRead | null = null;
        // A tail read answered none: no relay now; this pass asks the size, then makes a plain read.
        let noRelay = false;
        let size: number;
        if (known !== null) size = known;
        else if (pushedSize !== null) size = pushedSize;
        else {
          const reader = this.reader;
          if (!isStoreFormat(format) && !follower.hasLoaded && this.cold !== null && this.rereadFile !== file && isTranscriptIdentityReading(reader)) {
            if (isStartOverListening(reader)) reader.startingOver(file, false);
            tailRead = await reader.readWithIdentity(file, 0, follower.firstLoadBytes, { omit: true, tail: follower.firstLoadBytes });
            if (!this.isCurrent(current)) return;
            noRelay = tailRead === null;
          }
          const combined =
            tailRead === null && !isStoreFormat(format) && follower.hasLoaded && this.rereadFile !== file && isTranscriptIdentityReading(reader)
              ? await reader.readWithIdentity(file, follower.offset, pollWindow, { omit: true })
              : null;
          if (!this.isCurrent(current)) return;
          if (tailRead !== null) size = tailRead.size;
          else if (combined !== null) {
            // Another file took its name: read it from its start (a shrink is the follower's own reload).
            // The load's own read gave the inode; one still unknown here (the bytes came
            // without it, e.g. before the relay was up) is not taken as the baseline: read from the start.
            if (inode === null || inode !== combined.ino) {
              follower.reset();
              if (isStartOverListening(reader)) reader.startingOver(file, true);
            } else if (combined.size >= follower.offset) polled = { offset: follower.offset, data: combined.data, omitted: combined.omitted ?? [] };
            inode = combined.ino;
            size = combined.size;
          } else size = await this.reader.size(file);
        }
        if (!this.isCurrent(current)) return;
        if (this.rereadFile === file) {
          this.rereadFile = null;
          follower.reset();
          inode = null;
          polled = null;
          tailRead = null;
        }
        if (isStoreFormat(format)) {
          const revision = await this.storeRevision(file);
          if (!this.isCurrent(current)) return;
          if (readRevision !== null && readRevision !== revision) follower.reset();
          readRevision = revision;
        }
        const request = follower.nextRead(size);
        // The tail read is the first load's read when it starts where the load does (a reader
        // that took no `tail` read from 0).
        const tailed = tailRead !== null && request !== null && startsOver(request) && (tailRead.offset ?? 0) === request.offset ? tailRead : null;
        if (request !== null) {
          if (startsOver(request)) {
            // A format whose folder and version are in its header (Pi/omp, Copilot, Droid, Kimi) reads the file's
            // head first, one bounded read, before a line of this load is parsed or shown: a version it doesn't know
            // is unrecognisedFormat, and every parser of the file carries the header, so the load's first lines
            // check its folder (sessionMismatch before anything shows) as a short file's do, a Copilot resume among
            // them still the latest. Read again on each reload.
            if (hasHeader(format)) {
              const head = await this.reader.read(file, 0, headerBytes(format));
              if (!this.isCurrent(current)) return;
              const lines = headerLinesOf(format, head);
              // A load whose tail starts past the file's start needs the header within
              // its bound (no header line there: unrecognisedFormat, never a tail with no folder proof).
              const pastStart = request.offset > 0;
              if (pastStart && lines.length === 0) return this.end("unrecognisedFormat", current);
              // Copilot's and Kimi's folder can move after the head: the unread middle's ownership
              // records too (to the line the tail starts inside of), so the latest of head, middle and tail is the
              // folder; a middle past the scan's cap is unrecognisedFormat, never the head's folder.
              const headEnd = head.lastIndexOf(0x0a) + 1;
              if (pastStart && ownershipMoves(format) && request.offset >= headEnd) {
                const later = await this.middleOwnership(file, format, headEnd, request.offset, size, current);
                if (!this.isCurrent(current)) return;
                if (later === null) return this.end("unrecognisedFormat", current);
                lines.push(...later);
              }
              const probe = new TranscriptParser(format);
              if (probe.carryHeader(lines) === "unknown") return this.end("unrecognisedFormat", current);
              // And its folder (the header's, or the middle's latest record).
              if (pastStart && probe.cwd === null) return this.end("unrecognisedFormat", current);
              this.header = lines;
            }
            // A Codex rollout's header (its first line, session_meta) is checked before anything of this load or reload
            // shows: its cwd one of the pane's folders (ChatFolderMatch), its id the one looked up. So a long rollout's
            // tail (whose window has no session_meta) never shows another folder's turns, nor does a file put under the
            // same name (another inode, a watch's reset, a shrink). A file with no whole first line yet is asked again
            // after the poll's wait.
            if (format === "codex") {
              const proof = await this.proveCodexHeader(file, session, paneFolders, current);
              if (proof === "over") return;
              if (proof === "wait") {
                follower.reset();
                inode = null;
                if (!(await this.sleep(current, false))) return;
                continue;
              }
            }
            // The reader hears the reread before it is asked for (the tail read's: before it).
            if (tailed === null && isStartOverListening(this.reader)) this.reader.startingOver(file, false);
            // A look-back of what was read before ends.
            this.retireLookBack();
            parser = this.newParser(format);
            this.startOver(format, paneFolders);
            formatChecked = false;
            this.transcriptFolder = null;
            startedOver = true;
          }
          // The watch's pushed bytes stand in for a follow read they cover (no request),
          // or the combined read that gave the size (no second request),
          // each with the runs left out of it.
          const watchedBytes = request.kind === "follow" ? this.pushedBytes(file, request.offset, request.maxBytes) : null;
          const pushed: LeftOutRead | null =
            request.kind === "follow"
              ? (watchedBytes ??
                (polled !== null && polled.offset === request.offset ? { data: polled.data.subarray(0, request.maxBytes), omitted: polled.omitted } : null))
              : null;
          let bytes: Uint8Array;
          let omitted: readonly BlobRange[] = [];
          const reader = this.reader;
          const identified =
            pushed === null && !noRelay && !isStoreFormat(format) && isTranscriptIdentityReading(reader)
              ? (tailed ?? (await reader.readWithIdentity(file, request.offset, request.maxBytes, { omit: true })))
              : null;
          if (pushed !== null) {
            bytes = pushed.data;
            omitted = pushed.omitted;
          } else if (identified !== null) {
            // Every read with the relay up carries the size and the inode with the bytes (first load
            // and reload too), so the follower knows the file it read.
            if (!this.isCurrent(current)) return;
            if (!startsOver(request) && inode !== null && inode !== identified.ino) {
              // Replaced since the size: from its start, next pass.
              follower.reset();
              inode = null;
              if (isStartOverListening(reader)) reader.startingOver(file, true);
              continue;
            }
            inode = identified.ino;
            // Shorter than the size this read was planned from (truncated in place) or than its offset: the
            // bytes are dropped and the next pass plans again from the reply's size.
            if (identified.size < size || identified.size < request.offset) {
              readingTo = identified.size;
              continue;
            }
            size = identified.size;
            bytes = identified.data;
            omitted = identified.omitted ?? [];
            // A Codex rollout's bytes come from the file whose header was proven,
            // or none of them shows: the file is read again from its start, its header checked first.
            if (format === "codex" && !(await this.codexBytesProven(file, identified.ino, current))) {
              if (!this.isCurrent(current)) return;
              this.codexReplaced(follower, file);
              inode = null;
              continue;
            }
            if (!this.isCurrent(current)) return;
            // Kept: the reader may now apply what it held of this read.
            if (isStartOverListening(reader)) reader.keptIdentityRead(file);
          } else bytes = await this.reader.read(file, request.offset, request.maxBytes);
          if (!this.isCurrent(current)) return;
          // Bytes a watch pushed or a plain read gave carry no inode (a combined
          // read's are its inode's, the one the follow read): the file is proven the same before they show.
          if (format === "codex" && identified === null && !(await this.codexBytesProven(file, watchedBytes === null && pushed !== null ? inode : null, current))) {
            if (!this.isCurrent(current)) return;
            this.codexReplaced(follower, file);
            inode = null;
            continue;
          }
          this.fileInode = inode;
          this.bytesRead += keptLength(bytes.length, omitted);
          // Laid out again while this read was out: read it again.
          if (isStoreFormat(format) && (await this.storeRevision(file)) !== readRevision) {
            if (!this.isCurrent(current)) return;
            continue;
          }
          let checked = 0;
          let unparseable = 0;
          // Relay rules 3, 5, 6: what a line needs put back is, before it is parsed.
          const consumed = follower.consumeLines(request.offset, bytes, omitted);
          let ready: readonly ReadyLine[] = consumed.some((line) => line.blobs !== undefined) ? await this.readyLines(file, consumed, inode) : consumed.map((line) => ({ text: line.text, offset: line.offset, blobs: null }));
          if (!this.isCurrent(current)) return;
          // A line whose whole-line reread failed is a failed read: what is before it is parsed,
          // the follow's cursor goes back to it, and it is read again after the wait (a failure of the follow's).
          const unreadAt = ready.findIndex((line) => line.unread === true);
          if (unreadAt >= 0) {
            follower.rewind(ready[unreadAt]!.offset);
            ready = ready.slice(0, unreadAt);
            unread = true;
          }
          for (const seam of this.seamsToAdopt) parser.adopt(seam);
          this.seamsToAdopt = [];
          // You read away from the newest: what arrives goes below what is on show; a line that
          // would move its top (the cap reached) is taken back whole and waits in the file.
          const keepsTop = !startsOver(request) && !this.followsNewest;
          this.builder.keepsTop = keepsTop;
          this.newerWaiting = false;
          for (const line of ready) {
            let result: TranscriptLineResult;
            // The folder the parse had before this line.
            const folderBefore = parser.cwd;
            if (keepsTop) {
              const parserBefore = parser.clone();
              const builderBefore = this.builder.clone();
              result = parser.parse(line.text, line.offset, line.blobs);
              this.builder.apply(result.events, line.offset);
              if (this.builder.topMoves !== builderBefore.topMoves) {
                parser = parserBefore;
                this.builder = builderBefore;
                follower.rewind(line.offset);
                this.newerWaiting = true;
                break;
              }
            } else {
              result = parser.parse(line.text, line.offset, line.blobs);
              this.builder.apply(result.events, line.offset);
            }
            // Once the folder was checked, a line that moves it (a Copilot session.resume or a Kimi config.update
            // appended while followed, a Qwen record's cwd) is checked before this batch shows. One out of the pane's
            // folders ends the follow here, so nothing of the batch shows (end empties the timeline); one in them (the
            // same folder, one inside it, back into it) goes on.
            const folderNow = parser.cwd;
            if (this.folderChecked && paneFolders.length > 0 && folderNow !== null && folderNow !== folderBefore && !ChatFolderMatch.transcript(folderNow, paneFolders)) {
              // Said with the end (ownershipMoved), so the service starts this follow no more.
              this.moved = true;
              return this.end("sessionMismatch", current);
            }
            if (!formatChecked && checked < formatCheckLines) {
              checked += 1;
              if (result.outcome.kind === "malformed" || result.outcome.kind === "unknown") unparseable += 1;
            }
          }
          if (!formatChecked && checked > 0) {
            formatChecked = true;
            if (unparseable * 2 > checked) return this.end("unrecognisedFormat", current);
          }
          const folder = parser.cwd;
          if (folder !== null) {
            this.transcriptFolder = folder;
            if (!this.folderChecked) {
              this.folderChecked = true;
              if (!ChatFolderMatch.transcript(folder, paneFolders)) return this.end("sessionMismatch", current);
            }
          }
          this.parseStats = parser.stats;
          behind = request.offset + bytes.length < size && bytes.length > 0 && !this.newerWaiting && !unread;
          if (behind) readingTo = size;
          // A first window that starts inside a line still being written holds no line break.
          // That line's start is found reading back (its bytes not parsed); the follower reads on from there (the
          // line parsed once it is whole), and what is before it is earlier history (a cold load's screenful).
          if (startsOver(request) && follower.windowHoldsNoLineStart) {
            const lineStart = await this.unfinishedLineStart(file, request.offset, current);
            if (!this.isCurrent(current)) return;
            if (lineStart !== null) {
              follower.restart(lineStart);
              this.historyStart = lineStart;
              behind = true;
              readingTo = size;
            }
          }
          if (this.historyStart === null && follower.windowStart !== null) this.historyStart = follower.windowStart;
          // The bytes the first window's items took (from where it read, or the line start read
          // back to, to its end); the tail of the line it began inside is the screenful's first read back's (not
          // read again).
          if (startsOver(request)) {
            this.coldSpan = { from: Math.min(request.offset, this.historyStart ?? request.offset), to: request.offset + bytes.length };
            const windowStart = follower.windowStart;
            if (
              this.cold !== null &&
              this.cold.readsOnce &&
              windowStart !== null &&
              windowStart > request.offset &&
              windowStart - request.offset <= bytes.length &&
              this.historyStart === windowStart
            ) {
              const tail = bytes.subarray(0, windowStart - request.offset);
              const tailBlobs = clipBlobs(omitted, request.offset, windowStart);
              this.fillCarry = { reader: new TranscriptEarlierReader(windowStart, this.cold.chunkBytes, tail, tailBlobs), revision: this.windowRevision };
            }
          }
          // A trim: what is held starts at its earliest held line, and is joined from there.
          if (this.noteTrims() && this.historyStart !== null) parser.forgetInputs(this.historyStart);
          this.earliestOpening = parser.seamOpening;
        }
        // A line not read again counts as a failed read (the limit ends the follow as unreadable).
        if (unread) {
          failures += 1;
          if (failures >= liveFailureLimit) return this.end("unreadable", current);
        } else failures = 0;
        // A cold first load that has less than a screenful reads earlier next;
        // till then earlier history is loading.
        if (startedOver && this.cold !== null) {
          this.screenToFill = this.needsFill(this.cold) && (this.historyStart ?? 0) > 0 && !this.builder.isAtHistoryCap;
          if (!this.screenToFill) this.fillCarry = null;
        }
        const snapshot = this.snapshot;
        // Read to the end the size gave, nothing waiting.
        const reachedEnd = !behind && !this.newerWaiting && !unread;
        // What the follow took is let go of; at the end, the file is watched from there.
        this.dropPushedBefore(file, follower.offset);
        if (reachedEnd && !isStoreFormat(format)) this.ensureWatch(file, follower.offset, current);
        if (!loaded || !sameTimeline(snapshot, this.timeline) || reachedEnd !== this.caught) {
          loaded = true;
          this.caught = reachedEnd;
          this.publish({ status: "live" }, snapshot);
        }
        // A cold first load reads earlier only as far as a screenful of turns plus one;
        // one a pause cut short reads on after the resume.
        if (this.screenToFill && this.cold !== null) {
          await this.fillScreen(this.cold, current);
          if (!this.isCurrent(current)) return;
        }
        // What the screenful did not name, read on for (the chips only): once
        // the load is done, beside the follow (never holding it up), from where the
        // screenful ended, once it has (never the bytes it is still to read).
        if (startedOver) lookBackDue = true;
        if (lookBackDue && !this.screenToFill) {
          lookBackDue = false;
          this.lookBackFrom = this.historyStart;
        }
        if (!this.firstLoadDone && this.state.status === "live") {
          this.firstLoadDone = true;
          this.finishLoadWaiters(true);
        }
        if (this.lookBackFrom !== null && this.firstLoadDone) {
          const from = this.lookBackFrom;
          this.lookBackFrom = null;
          this.scheduleLookBack(file, from, lookBackBytes, this.lookBackBudgetMs, current);
        }
        // A Claude session's running subagents' steps (never a failure of the chat's),
        // once the load is done, beside the follow; a pass Chat was hidden during ends first.
        this.endHiddenSteps();
        if (format === "claude" && !this.newerWaiting && this.firstLoadDone) this.scheduleSteps(file, current);
      } catch (error) {
        if (!this.isCurrent(current)) return;
        if (error instanceof TranscriptNotFoundError) return this.end("notFound", current);
        failures += 1;
        if (!loaded || failures >= liveFailureLimit) return this.end("unreadable", current);
      }
      if (behind) continue;
      if (!(await this.sleep(current))) return;
    }
  }

  // MARK: earlier messages

  /**
   * Reads the messages before the loaded ones and puts them in front: backwards
   * from the loaded part's first line in bounded chunks, whole lines only, parsed
   * with a parser of the same agent, joined at the seam. Only while live with
   * something before what is loaded, below the cap, and one at a time.
   */
  loadEarlier(): Promise<void> {
    return this.loadEarlierIn(this.earlierStepBytes, this.earlierChunkBytes);
  }

  /**
   * `loadEarlier` in steps and chunks of these sizes (a cold load's reads are bigger: one pipelined read each).
   *
   * `resume`: a cold screenful's read back: it takes on the reader the one before it left
   * (when what is held still starts where that one ended), so the tail of the line it ended inside is not read
   * again, and leaves its own for the next. `parseItems`: a read back that parses only as many of its newest
   * lines as hold that many items.
   */
  private async loadEarlierIn(stepBytes: number, chunkBytes: number, resume = false, parseItems: number | null = null): Promise<void> {
    if (this.state.status !== "live" || this.earlierLoading || this.builder.isAtHistoryCap) return;
    const file = this.path;
    const format = this.format;
    const start = this.historyStart;
    if (file === null || format === null || start === null || start <= 0) {
      // Nothing unread before: what is held and hidden shows.
      if (this.builder.hiddenItemCount <= 0) return;
      this.builder.showHeld();
      this.earlierFailed = false;
      this.publish({ status: "live" }, this.snapshot);
      return;
    }
    const current = this.generation;
    const revision = this.windowRevision;
    this.earlierLoadSerial += 1;
    const load = this.earlierLoadSerial;
    this.earlierLoading = true;
    this.earlierFailed = false;
    this.publish({ status: "live" }, this.snapshot);

    // A store laid out again meanwhile drops this load (the follow reads it again).
    const layout = isStoreFormat(format) ? await this.storeRevision(file) : 0;
    let earlierReader = new TranscriptEarlierReader(start, chunkBytes);
    const carry = this.fillCarry;
    if (resume && carry !== null && carry.revision === revision && carry.reader.end === start) {
      earlierReader = carry.reader;
      earlierReader.chunkBytes = chunkBytes;
    }
    this.fillCarry = null;
    const oversizedBefore = earlierReader.oversizedLines;
    let lines: TranscriptLine[] = [];
    /** The first of `lines` parsed (those before it are left unread). */
    let parsedFrom = 0;
    /** Lines read with runs left out, as parsed (what they needed put back, put back). */
    const ready = new Map<TranscriptLine, ReadyLine>();
    let older = new ChatTimelineBuilder(this.historyCap, this.historyCap);
    let parser = this.newParser(format);
    let steps = 0;
    for (;;) {
      steps += 1;
      const stepLines: TranscriptLine[][] = [];
      const stepStart = earlierReader.bytesRead;
      while (earlierReader.bytesRead - stepStart < stepBytes) {
        const read = earlierReader.nextRead();
        if (read === null) break;
        let got: LeftOutRead | null;
        try {
          // Relay rule 1: with runs left out while the relay is up; another file: a failed read.
          got = await this.readLeavingOut(file, read.offset, read.maxBytes, this.fileInode);
        } catch {
          return this.earlierEnded(load, current, revision, true);
        }
        if (!this.isEarlierLoadCurrent(current, revision)) return this.earlierEnded(load, current, revision);
        if (got === null) return this.earlierEnded(load, current, revision, true);
        if (resume && this.coldSpan !== null) this.coldSpan.from = Math.min(this.coldSpan.from, read.offset);
        const chunk = earlierReader.consume(read.offset, got.data, got.omitted);
        // Fewer bytes than asked: the file changed under the read.
        if (chunk === null) return this.earlierEnded(load, current, revision, true);
        stepLines.push(chunk);
      }
      lines = [...stepLines.reverse().flat(), ...lines];
      // The same parser and builder as the live part, from the earliest line read. A
      // screenful's read back (`parseItems`) parses its newest lines only, in batches doubling from 64, until
      // they hold that many items (a big read landing deep in short turns would otherwise parse thousands);
      // not after a line too long was dropped.
      const bounded = parseItems !== null && earlierReader.oversizedLines === oversizedBefore;
      let count = bounded ? Math.min(lines.length, 64) : lines.length;
      for (;;) {
        parsedFrom = lines.length - count;
        // Relay rules 3, 5, 6: the lines about to be parsed, what they need put back put back (once).
        const due = lines.slice(parsedFrom).filter((line) => line.blobs !== undefined && !ready.has(line));
        if (due.length > 0) {
          const made = await this.readyLines(file, due, this.fileInode);
          if (!this.isEarlierLoadCurrent(current, revision)) return this.earlierEnded(load, current, revision);
          // A line not read again whole is a failed read: nothing of this load is kept (what is
          // held still starts where it did, so the next load reads it again).
          if (made.some((line) => line.unread === true)) return this.earlierEnded(load, current, revision, true);
          for (const [index, line] of due.entries()) ready.set(line, made[index]!);
        }
        older = new ChatTimelineBuilder(this.historyCap, this.historyCap);
        parser = this.newParser(format);
        for (let index = parsedFrom; index < lines.length; index += 1) {
          const line = lines[index]!;
          const made = ready.get(line);
          older.apply(parser.parse(made?.text ?? line.text, line.offset, made?.blobs ?? null).events, line.offset);
        }
        if (!bounded || parseItems === null || parsedFrom <= 0 || older.heldItemCount >= parseItems) break;
        count = Math.min(lines.length, count * 2);
      }
      // A load ends with something to show, at the file's start, or after its steps,
      // but never before a whole line was read past.
      if (older.heldItemCount > 0 || earlierReader.reachedStart) break;
      if (steps >= earlierStepsWhileEmpty && earlierReader.end < start) break;
      // A screenful's read back stops at a pause between its reads (nothing is read while
      // paused, and its steps are one read each); its reader is carried, the resume reads on.
      if (resume && this.paused) break;
    }
    if (!this.isEarlierLoadCurrent(current, revision)) return this.earlierEnded(load, current, revision);
    if (isStoreFormat(format) && (await this.storeRevision(file)) !== layout) return this.earlierEnded(load, current, revision);
    if (!this.isEarlierLoadCurrent(current, revision)) return this.earlierEnded(load, current, revision);
    // Earlier lines of a Codex rollout show only while it is the file proven (a read without identity proves
    // nothing of its own); otherwise this load fails and the follow finds the change.
    if (format === "codex") {
      let proven: boolean;
      try {
        proven = await this.codexBytesProven(file, null, current);
      } catch {
        return this.earlierEnded(load, current, revision, true);
      }
      if (!this.isEarlierLoadCurrent(current, revision)) return this.earlierEnded(load, current, revision);
      if (!proven) return this.earlierEnded(load, current, revision, true);
    }
    const folder = parser.cwd;
    if (folder !== null) {
      if (this.transcriptFolder === null) this.transcriptFolder = folder;
      if (!this.folderChecked) {
        this.folderChecked = true;
        if (!ChatFolderMatch.transcript(folder, this.paneFolders)) {
          // The follow stops with it: nothing of this file shows.
          const following = this.work;
          this.earlierLoading = false;
          this.end("sessionMismatch", current);
          if (following !== null) following.cancelled = true;
          this.generation += 1;
          return;
        }
      }
    }
    // The seam: join these lines to what is held as one parse of the file reads them.
    let seam: TranscriptSeam | null = null;
    let opening = parser.seamOpening;
    if (this.earliestOpening !== null) {
      const joined = TranscriptParser.seam(parser, this.earliestOpening);
      // A Grok reply the seam cut: its later part joins the earlier row, as one parse reads it.
      const join = joined.grokJoin ?? null;
      if (join !== null) {
        // A later part that showed nothing of the run (blank parts only) still joins:
        // its blank goes on the earlier row, and the parser reading on continues that row.
        const later = this.builder.textOf(join.from);
        if (older.textOf(join.into) !== null) {
          older.extendText(join.into, join.blank + (later ?? ""));
          if (later !== null) this.builder.remove(new Set([join.from]));
        } else {
          joined.grokJoin = null;
        }
      }
      older.apply(joined.finished);
      this.builder.remove(new Set(joined.duplicateItemIDs));
      for (const restored of joined.restored) this.builder.restore(restored.message, restored.offset, restored.queued);
      opening = joined.opening;
      seam = joined;
    }
    const result = this.builder.prepend(older);
    // Lines read but not parsed (a bounded read back) are still earlier history: what is held
    // starts at the first parsed.
    const leftUnread = parsedFrom > 0 ? lines[parsedFrom]!.offset : null;
    this.historyStart = result.start ?? leftUnread ?? earlierReader.end;
    this.earlierLongLines += earlierReader.oversizedLines - oversizedBefore;
    // The next read back of the screenful reads on from here (not when the cap or a trim moved
    // what is held, nor past lines left unread); the bytes its items took start there.
    if (resume && result.start === null && leftUnread === null) this.fillCarry = { reader: earlierReader, revision };
    if (resume && leftUnread !== null && this.coldSpan !== null) this.coldSpan.from = leftUnread;
    // The cap (or the loaded part's own trim) left its start out: what is held starts later.
    if (result.start !== null) forgetTranscriptSeamOpening(opening, result.start);
    this.earliestOpening = opening;
    if (seam !== null) this.seamsToAdopt.push({ ...seam, opening });
    this.seenTrims = this.builder.trimSerial;
    this.earlierLoading = false;
    this.publish({ status: "live" }, this.snapshot);
  }

  /** Whether a load begun at `current`/`revision` may still change what is on show. */
  private isEarlierLoadCurrent(current: number, revision: number): boolean {
    return this.isCurrent(current) && revision === this.windowRevision && this.state.status === "live";
  }

  /** A load of earlier messages that did not finish: the timeline stays as it was. */
  private earlierEnded(load: number, current: number, revision: number, failed = false): void {
    if (load !== this.earlierLoadSerial) return;
    this.earlierLoading = false;
    if (current !== this.generation || this.state.status !== "live") return;
    if (revision === this.windowRevision) this.earlierFailed = failed;
    this.publish({ status: "live" }, this.snapshot);
  }

  /** Unavailable carries an empty timeline; a load of earlier messages in flight is dropped. */
  private end(reason: ChatUnavailableReason, current: number, folder?: string): void {
    if (current !== this.generation) return;
    this.work = null;
    // The look-back ends with the follow.
    this.retireLookBack();
    // And a step pass.
    this.retireSteps();
    this.windowRevision += 1;
    this.earlierLoading = false;
    this.publish(folder === undefined ? { status: "unavailable", reason } : { status: "unavailable", reason, folder }, emptyTimeline);
    this.finishLoadWaiters(false);
  }

  /** Live and read to the end (Swift's `caughtUp`). */
  get caughtUp(): boolean {
    return this.caught;
  }

  private publish(state: ChatFeedState, timeline: ChatTimeline): void {
    if (state.status !== "live") this.caught = false;
    const caughtUp = this.caught;
    const unchanged = sameState(state, this.state) && sameTimeline(timeline, this.timeline) && caughtUp === this.publishedCaught;
    this.state = state;
    this.timeline = timeline;
    this.publishedCaught = caughtUp;
    if (unchanged && state.status !== "loading") return;
    const update = { state, timeline, caughtUp };
    for (const listener of this.listeners) listener(update);
  }
}

function sameFollow<S>(a: Follow<S>, b: Follow<S>): boolean {
  return JSON.stringify(a.session) === JSON.stringify(b.session) && a.paneFolders.length === b.paneFolders.length && a.paneFolders.every((folder, i) => folder === b.paneFolders[i]);
}
