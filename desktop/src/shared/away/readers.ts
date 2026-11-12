// "While you were away"'s readers (a port of HerdrKit's AwayReaders.swift),
// over the connection the machine already has. Per pane only the transcript's
// end is read: backwards with the chat's earlier-history reader until a line
// older than `since`, capped at 2 MB; per folder one `git log` exec (5 s). At
// most 20 panes and 3 reads at once per machine; an aborted signal (the
// window or the machine changed) stops it before its next read. Nothing here
// writes on the machine: transcripts are read over SFTP, and git only reads.

import { grokSessionFolder, type TranscriptFileReader } from "../chat/feed";
import { TranscriptEarlierReader, type TranscriptLine } from "../chat/follower";
import { GrokSessionParser } from "../chat/grok-parser";
import { ChatFolderMatch, grokSessionOwned, shellQuote, type ChatSession, type TranscriptSessionRef } from "../chat/locator";
import type { TranscriptFormat } from "../chat/parser";
import { asObject, asString, ChatJSON, parseChatDate } from "../chat/tools";
import type { AgentStatus } from "../sidebar-model";
import { CancelledError, isCancelled, throwIfCancelled, withDeadline, type RemoteCommand, type RemoteCommandRunner } from "../remote-command";
import { awayActivityOf, type AwayCommit, type AwayGitResult, type AwayMacInput, type AwayPane, type AwayTranscriptState } from "./digest";

/** The digest's bounds. */
export interface AwayLimits {
  /** Bytes read from one transcript's end at most (a read that stops here before `since` marks the card "more"). */
  readonly bytesPerPane: number;
  /** Panes read on one machine; the rest are listed, not read. */
  readonly panesPerMac: number;
  /** Reads (a transcript's or a git exec) running at once on one machine. */
  readonly readsAtOnce: number;
  /** One backwards read. */
  readonly chunkBytes: number;
  readonly gitTimeoutMs: number;
  /** Commits asked of `git log` at most (a card shows five). */
  readonly gitMaxCommits: number;
  readonly gitOutputBytes: number;
}

export const defaultAwayLimits: AwayLimits = {
  bytesPerPane: 2 * 1_024 * 1_024,
  panesPerMac: 20,
  readsAtOnce: 3,
  chunkBytes: 128 * 1_024,
  gitTimeoutMs: 5_000,
  gitMaxCommits: 50,
  gitOutputBytes: 64 * 1_024,
};

/** The first look at a machine (nothing stored yet) covers this much. */
export const firstLookBackSeconds = 12 * 3600;

export const firstSince = (now: number): number => now - firstLookBackSeconds;

/** A read came back shorter than asked: the file changed under it. */
export class AwayReadChanged extends Error {
  constructor() {
    super("the transcript changed under the read");
    this.name = "AwayReadChanged";
  }
}

// MARK: - the transcript's end

/** One bounded backwards read of a transcript's end. */
export interface AwayTranscriptRead {
  /** Whole lines, oldest first, with their offsets in the file. */
  readonly lines: readonly TranscriptLine[];
  readonly bytesRead: number;
  /** The file's start was read: nothing is before these lines. */
  readonly reachedStart: boolean;
  /** The cap stopped the read before it reached `since`. */
  readonly truncated: boolean;
}

/**
 * A line's own `timestamp` (Claude Code, Codex and Grok all write one on every dated line); null for lines without one.
 * Claude Code and Codex write ISO 8601. Grok's line is dated as Chat dates it
 * (GrokSessionParser.lineTime): its `_meta.agentTimestampMs` (milliseconds), else its numeric `timestamp` by size
 * (Grok 1.0.70 writes Unix seconds).
 */
export function lineTime(line: string): number | null {
  if (!line.includes('"timestamp"') && !line.includes('"agentTimestampMs"')) return null;
  const object = ChatJSON.object(line);
  if (object === null) return null;
  return typeof object.timestamp === "string" ? parseChatDate(object.timestamp) : GrokSessionParser.lineTime(object);
}

/**
 * Reads backwards from the file's end in `chunkBytes` chunks until a chunk
 * holds a line older than `since` (its lines are kept: they hold the start of
 * a turn that spans `since`), the file's start, or `bytesPerPane`. Checks the
 * signal before and after every read.
 */
export async function readTranscriptEnd(
  reader: Pick<TranscriptFileReader, "size" | "read">,
  path: string,
  since: number,
  limits: AwayLimits = defaultAwayLimits,
  signal?: AbortSignal,
): Promise<AwayTranscriptRead> {
  const size = await reader.size(path);
  const earlier = new TranscriptEarlierReader(size, limits.chunkBytes);
  const chunks: TranscriptLine[][] = [];
  let crossed = false;
  while (earlier.bytesRead < limits.bytesPerPane) {
    const request = earlier.nextRead();
    if (request === null) break;
    throwIfCancelled(signal);
    const bytes = await reader.read(path, request.offset, request.maxBytes);
    throwIfCancelled(signal);
    const lines = earlier.consume(request.offset, bytes);
    if (lines === null) throw new AwayReadChanged();
    chunks.push(lines);
    // The chunk's oldest dated line tells whether it reached `since`.
    const oldest = lines.map((line) => lineTime(line.text)).find((time) => time !== null);
    if (oldest !== undefined && oldest !== null && oldest < since) {
      crossed = true;
      break;
    }
  }
  return {
    lines: chunks.reverse().flat(),
    bytesRead: earlier.bytesRead,
    reachedStart: earlier.reachedStart,
    truncated: !crossed && !earlier.reachedStart,
  };
}

/**
 * The newest working folder the lines name: Claude Code's `cwd` on a user or
 * assistant line, Codex's `payload.cwd` on `turn_context` (and `session_meta`).
 */
export function transcriptFolder(lines: readonly TranscriptLine[], format: TranscriptFormat): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]!.text;
    if (!text.includes('"cwd"')) continue;
    const object = ChatJSON.object(text);
    if (object === null) continue;
    const type = asString(object.type);
    let folder: string | null;
    if (format === "claude") {
      if ((type !== "user" && type !== "assistant") || ChatJSON.bool(object.isSidechain)) continue;
      folder = asString(object.cwd);
    } else {
      if (type !== "turn_context" && type !== "session_meta") continue;
      folder = asString(asObject(object.payload)?.cwd);
    }
    if (folder !== null && folder !== "") return folder;
  }
  return null;
}

// MARK: - git

/** Printed instead of a log where the folder is not a repository (or is gone, or git refuses it). */
export const notARepositoryMarker = "HERDR-AWAY-NOT-A-REPOSITORY";
/** Hash, committer time, subject; unit and record separators. */
const gitFormat = "%H%x1f%ct%x1f%s%x1e";

/** "2026-11-02T01:00:00Z". */
export const isoSeconds = (since: number): string => new Date(Math.floor(since) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * `git -C <folder> log --since=<iso>`, run by `/bin/sh` whatever the login
 * shell, after a `rev-parse` that prints the marker for a folder that is not a
 * repository. Read only: `--no-optional-locks`, no pager, no colour, no signatures.
 */
export function gitLogCommand(folder: string, since: number, maxCount: number): RemoteCommand {
  const quoted = shellQuote(folder);
  const count = Math.max(1, Math.floor(maxCount));
  const script =
    "git -C " +
    quoted +
    " rev-parse --is-inside-work-tree >/dev/null 2>&1" +
    " || { echo " +
    notARepositoryMarker +
    "; exit 0; }; " +
    "exec git --no-optional-locks --no-pager -c log.showSignature=false -C " +
    quoted +
    " log --no-color --since=" +
    shellQuote(isoSeconds(since)) +
    " --max-count=" +
    String(count) +
    " --format=" +
    shellQuote(gitFormat);
  return { text: "/bin/sh -c " + shellQuote(script), intent: { kind: "git-log", folder, since, maxCount: count } };
}

const isHash = (text: string): boolean => (text.length === 40 || text.length === 64) && /^[0-9a-fA-F]+$/.test(text);

/** The commits made at or after `since`, newest first; records that do not read (a cut end) are skipped. */
export function parseGitLog(output: string, since: number): AwayGitResult {
  if (output.includes(notARepositoryMarker) && !output.includes("\u001f")) return { kind: "notARepository" };
  const commits: { index: number; commit: AwayCommit }[] = [];
  for (const record of output.split("\u001e")) {
    const trimmed = record.trim();
    const first = trimmed.indexOf("\u001f");
    const second = first < 0 ? -1 : trimmed.indexOf("\u001f", first + 1);
    if (second < 0) continue;
    const hash = trimmed.slice(0, first);
    const seconds = trimmed.slice(first + 1, second);
    if (!isHash(hash) || !/^\d+$/.test(seconds)) continue;
    const time = Number(seconds);
    if (!Number.isFinite(time) || time < since) continue;
    commits.push({ index: commits.length, commit: { hash, subject: trimmed.slice(second + 1), time } });
  }
  commits.sort((a, b) => (a.commit.time !== b.commit.time ? b.commit.time - a.commit.time : a.index - b.index));
  return { kind: "commits", commits: commits.map((entry) => entry.commit) };
}

class GitTimedOut extends Error {}

export async function gitLog(
  folder: string,
  since: number,
  runner: RemoteCommandRunner,
  limits: AwayLimits = defaultAwayLimits,
  signal?: AbortSignal,
): Promise<AwayGitResult> {
  const command = gitLogCommand(folder, since, limits.gitMaxCommits);
  try {
    const output = await withDeadline(
      limits.gitTimeoutMs,
      (inner) => runner.run(command, limits.gitOutputBytes, inner),
      () => new GitTimedOut(),
      signal,
    );
    return parseGitLog(new TextDecoder().decode(output.bytes), since);
  } catch (error) {
    if (isCancelled(error, signal)) throw new CancelledError();
    return error instanceof GitTimedOut ? { kind: "timedOut" } : { kind: "failed" };
  }
}

// MARK: - one machine

/** What the digest reads on one machine. */
export interface AwayMacSource {
  readonly id: string;
  readonly name: string;
  readonly since: number;
  /** The machine's agent panes (awayPanes). */
  readonly panes: readonly AwayPane[];
  /** The transcripts' reader; null reads none. */
  readonly reader: TranscriptFileReader<TranscriptSessionRef> | null;
  /** The git runner; null runs none. */
  readonly runner: RemoteCommandRunner | null;
}

function rank(status: AgentStatus): number {
  switch (status) {
    case "blocked":
      return 0;
    case "working":
      return 1;
    case "done":
      return 2;
    case "idle":
      return 3;
    default:
      return 4;
  }
}

/**
 * One pane's activity, or unreadable: no file, a failed read, or a transcript
 * whose folder is not the pane's (Herdr gave it another pane's session, the
 * chat's sessionMismatch).
 */
export async function readPane(
  pane: AwayPane,
  session: ChatSession,
  reader: TranscriptFileReader<TranscriptSessionRef>,
  since: number,
  limits: AwayLimits = defaultAwayLimits,
  signal?: AbortSignal,
): Promise<AwayTranscriptState> {
  try {
    throwIfCancelled(signal);
    const path = await reader.locate(session.ref);
    throwIfCancelled(signal);
    if (path === null) return { kind: "unreadable" };
    const paneFolders = session.paneFolders.length > 0 ? session.paneFolders : pane.folder === null ? [] : [pane.folder];
    // A Grok session is the pane's only when its summary.json says so.
    if (session.ref.format === "grok" && !grokSessionOwned(await grokSessionFolder(reader, path), session.ref, paneFolders)) return { kind: "unreadable" };
    throwIfCancelled(signal);
    const read = await readTranscriptEnd(reader, path, since, limits, signal);
    const folder = transcriptFolder(read.lines, session.ref.format);
    if (paneFolders.some((candidate) => ChatFolderMatch.normalised(candidate) !== "") && folder !== null && !ChatFolderMatch.transcript(folder, paneFolders)) {
      return { kind: "unreadable" };
    }
    return { kind: "read", activity: awayActivityOf(read.lines, session.ref.format, since, read.truncated) };
  } catch (error) {
    if (isCancelled(error, signal)) throw new CancelledError();
    return { kind: "unreadable" };
  }
}

type Job = { readonly kind: "transcript"; readonly index: number; readonly session: ChatSession } | { readonly kind: "git"; readonly folder: string };

/**
 * Reads the panes' transcripts (those that need you, work or finished first,
 * then the most recent: `panesPerMac` of them; the rest are `notRead`) and runs
 * `git log` once per folder, at most `readsAtOnce` at a time. Rejects with a
 * CancelledError when the signal aborts: no read starts after that.
 */
export async function collectAway(source: AwayMacSource, limits: AwayLimits = defaultAwayLimits, signal?: AbortSignal): Promise<AwayMacInput> {
  throwIfCancelled(signal);
  const states: AwayTranscriptState[] = [];
  const readable: { index: number; session: ChatSession }[] = [];
  source.panes.forEach((pane, index) => {
    if (pane.session !== null) {
      states.push({ kind: "notRead" });
      readable.push({ index, session: pane.session });
    } else {
      states.push({ kind: "noTranscript" });
    }
  });
  readable.sort((a, b) => {
    const pa = source.panes[a.index]!;
    const pb = source.panes[b.index]!;
    if (rank(pa.status) !== rank(pb.status)) return rank(pa.status) - rank(pb.status);
    const x = pa.statusSince;
    const y = pb.statusSince;
    if (x !== null && y !== null && x !== y) return y - x;
    if (x !== null && y === null) return -1;
    if (x === null && y !== null) return 1;
    return a.index - b.index;
  });
  const chosen = readable.slice(0, Math.max(1, limits.panesPerMac));
  const jobs: Job[] = [];
  if (source.reader !== null) {
    for (const pick of chosen) jobs.push({ kind: "transcript", index: pick.index, session: pick.session });
  } else {
    for (const pick of chosen) states[pick.index] = { kind: "unreadable" };
  }
  const git: Record<string, AwayGitResult> = {};
  if (source.runner !== null) {
    const folders: string[] = [];
    for (const pane of source.panes) {
      if (pane.folder === null || pane.folder === "" || folders.includes(pane.folder)) continue;
      folders.push(pane.folder);
    }
    for (const folder of folders.slice(0, Math.max(1, limits.panesPerMac))) jobs.push({ kind: "git", folder });
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      throwIfCancelled(signal);
      const job = jobs[next]!;
      next += 1;
      if (job.kind === "transcript") {
        states[job.index] = await readPane(source.panes[job.index]!, job.session, source.reader!, source.since, limits, signal);
      } else {
        git[job.folder] = await gitLog(job.folder, source.since, source.runner!, limits, signal);
      }
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limits.readsAtOnce), jobs.length) }, () => worker());
  await Promise.all(workers);
  throwIfCancelled(signal);
  return {
    id: source.id,
    name: source.name,
    since: source.since,
    state: { kind: "online" },
    panes: source.panes.map((pane, index) => ({ pane, transcript: states[index]! })),
    git,
  };
}
