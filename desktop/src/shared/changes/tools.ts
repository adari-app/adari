// A port of HerdrKit's AgentChanges.swift
// (AgentChangesBuilder): what each agent changed, this turn and this session,
// from its own tool calls. Read the way the chat reads the transcript: the
// chat's own parser and timeline builder (the calls, their states and their
// diffs are the chat's), and the edits that count are the away digest's
// (`changedPaths`: Claude Edit, MultiEdit, Write, NotebookEdit; Codex
// apply_patch and the patch an exec script makes; only calls that went
// through). The desktop reads the transcript's end itself for this (a bounded
// backward read, the away digest's): the chat's feed closes when Changes covers
// it. Pure values here.

import { ChatTimelineBuilder } from "../chat/builder";
import type { TranscriptFileReader } from "../chat/feed";
import { TranscriptEarlierReader, type TranscriptLine } from "../chat/follower";
import { ChatFolderMatch, type TranscriptSessionRef } from "../chat/locator";
import {
  diffAllLines,
  diffAllMoreLines,
  diffFileCounts,
  turnToolCalls,
  turnUserMessage,
  type ChatDiffLine,
  type ChatTimeline,
  type ChatToolCall,
  type ChatTurn,
} from "../chat/model";
import { TranscriptParser, type TranscriptFormat } from "../chat/parser";
import { asString, ChatJSON, isObject } from "../chat/tools";
import { ChangesCancelled } from "./reader";

/** One call's change to one file. */
export interface AgentEdit {
  readonly callId: string;
  /** The tool's name as the agent wrote it: Edit, MultiEdit, Write, NotebookEdit, apply_patch, exec. */
  readonly tool: string;
  /** The file, resolved against the agent's folder. */
  readonly path: string;
  readonly turnId: string;
  /** 1 for the first turn read. */
  readonly turnNumber: number;
  /** The first line of the user's message that opened the turn ("" when none is read), at most `turnMessageCharacters`. */
  readonly turnMessage: string;
  /** When the change landed (its result), else when it was asked; seconds since 1970. */
  readonly time: number | null;
  readonly added: number;
  readonly removed: number;
  /** This file's lines of the change, in order: the chat's diff of the call (one line of context around each change). */
  readonly lines: readonly ChatDiffLine[];
  /** Lines past the ones kept (`fullDiffLineCount`). */
  readonly moreLines: number;
}

export const editID = (edit: AgentEdit): string => edit.callId + "|" + edit.path;

/** A file the agent changed, with every edit of it in order. */
export interface AgentChangedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** Oldest first. */
  readonly edits: readonly AgentEdit[];
}

export const lastEditAt = (file: AgentChangedFile): number | null => file.edits[file.edits.length - 1]?.time ?? null;

/** The files an agent's own calls changed. */
export interface AgentToolChanges {
  /** The newest turn's, newest change first. */
  readonly thisTurn: readonly AgentChangedFile[];
  /** Every turn read, newest change first. */
  readonly session: readonly AgentChangedFile[];
  readonly turnCount: number;
  /** When the first turn read began. */
  readonly firstTurnAt: number | null;
  /** The session's start was read: nothing is before these turns. */
  readonly fromSessionStart: boolean;
  /** The newest turn has not ended. */
  readonly thisTurnRunning: boolean;
  readonly thisTurnStartedAt: number | null;
}

export const emptyToolChanges: AgentToolChanges = {
  thisTurn: [],
  session: [],
  turnCount: 0,
  firstTurnAt: null,
  fromSessionStart: true,
  thisTurnRunning: false,
  thisTurnStartedAt: null,
};

/** Edit calls counted (a call over two files counts twice). */
export const editCount = (changes: AgentToolChanges): number => changes.session.reduce((n, file) => n + file.edits.length, 0);

export const turnMessageCharacters = 80;
/** The timeline builder's bound for a backward read (the away digest's `keptItems`). */
export const keptItems = 20_000;

/**
 * From the chat's timeline. `fromSessionStart`: the timeline holds the
 * session's start.
 */
export function toolChanges(timeline: ChatTimeline, folder: string | null, fromSessionStart: boolean): AgentToolChanges {
  const turns = timeline.turns;
  if (turns.length === 0) return { ...emptyToolChanges, fromSessionStart };
  const order: string[] = [];
  const byPath = new Map<string, AgentEdit[]>();
  // Each file's newest edit, counted over every edit: newest first.
  const lastSeen = new Map<string, number>();
  let sequence = 0;
  const thisTurnPaths: string[] = [];
  turns.forEach((turn, index) => {
    const message = turnMessage(turn);
    for (const call of turnToolCalls(turn)) {
      if (call.kind !== "edit" || call.state !== "ok" || call.isUserShell) continue;
      for (const change of fileChanges(call)) {
        const path = resolvePath(change.path, folder);
        const edit: AgentEdit = {
          callId: call.id,
          tool: call.toolName,
          path,
          turnId: turn.id,
          turnNumber: index + 1,
          turnMessage: message,
          time: call.finishedAt ?? call.time,
          added: change.added,
          removed: change.removed,
          lines: change.lines,
          moreLines: change.moreLines,
        };
        const edits = byPath.get(path);
        if (edits === undefined) {
          order.push(path);
          byPath.set(path, [edit]);
        } else edits.push(edit);
        sequence += 1;
        lastSeen.set(path, sequence);
        if (index === turns.length - 1 && !thisTurnPaths.includes(path)) thisTurnPaths.push(path);
      }
    }
  });
  const files = (paths: readonly string[], turnId: string | null): AgentChangedFile[] =>
    paths
      .flatMap((path): AgentChangedFile[] => {
        const edits = (byPath.get(path) ?? []).filter((edit) => turnId === null || edit.turnId === turnId);
        if (edits.length === 0) return [];
        return [{ path, added: edits.reduce((n, e) => n + e.added, 0), removed: edits.reduce((n, e) => n + e.removed, 0), edits }];
      })
      .sort((a, b) => (lastSeen.get(b.path) ?? 0) - (lastSeen.get(a.path) ?? 0));
  const last = turns[turns.length - 1]!;
  return {
    thisTurn: files(thisTurnPaths, last.id),
    session: files(order, null),
    turnCount: turns.length,
    firstTurnAt: turns[0]!.startedAt,
    fromSessionStart,
    thisTurnRunning: !last.isFinished,
    thisTurnStartedAt: last.startedAt,
  };
}

/** From transcript lines (a bounded backward read, oldest first): the chat's parser and timeline builder, as the away digest reads them. */
export function toolChangesFromLines(lines: readonly TranscriptLine[], format: TranscriptFormat, folder: string | null, reachedStart: boolean): AgentToolChanges {
  const parser = new TranscriptParser(format);
  const builder = new ChatTimelineBuilder(keptItems, keptItems);
  for (const line of lines) builder.apply(parser.parse(line.text, line.offset).events, line.offset);
  return toolChanges(builder.timeline, folder, reachedStart);
}

/** One file's part of a call's change. */
export interface FileChange {
  path: string;
  lines: ChatDiffLine[];
  added: number;
  removed: number;
  moreLines: number;
}

/** The files a call changed (the away digest's): the diff's files, else its target. */
export function changedPaths(call: ChatToolCall): string[] {
  if (call.detail.type === "diff" && call.detail.diff.files.length > 0) return call.detail.diff.files.filter((file) => file.length > 0);
  const target = call.target.trim();
  return target.length === 0 ? [] : [target];
}

/** The files a call changed, each with its lines: a patch over several files is split at its file lines. */
export function fileChanges(call: ChatToolCall): FileChange[] {
  const paths = changedPaths(call);
  if (call.detail.type !== "diff") return paths.map((path) => ({ path, lines: [], added: 0, removed: 0, moreLines: 0 }));
  const diff = call.detail.diff;
  const allLines = diffAllLines(diff);
  if (paths.length <= 1) {
    const path = paths[0];
    if (path === undefined) return [];
    return [{ path, lines: allLines.filter((line) => line.kind !== "file"), added: diff.added, removed: diff.removed, moreLines: diffAllMoreLines(diff) }];
  }
  const changes: FileChange[] = paths.map((path) => ({ path, lines: [], added: 0, removed: 0, moreLines: 0 }));
  const indexOf = (path: string | null, current: number): number => {
    if (path === null) return current;
    const found = changes.findIndex((change) => change.path === path);
    return found < 0 ? current : found;
  };
  const fileCounts = diffFileCounts(diff);
  const counted = fileCounts.length > 0;
  let current = 0;
  for (const line of allLines) {
    if (line.kind === "file") {
      current = indexOf(line.text, current);
      continue;
    }
    const change = changes[current]!;
    change.lines.push(line);
    if (counted) continue;
    if (line.kind === "added") change.added += 1;
    if (line.kind === "removed") change.removed += 1;
  }
  if (counted) {
    // Each file's own counts and cut lines, taken before the full copy's bound.
    current = 0;
    for (const count of fileCounts) {
      current = indexOf(count.path, current);
      const change = changes[current]!;
      change.added += count.added;
      change.removed += count.removed;
      change.moreLines += count.omittedLines;
    }
  } else if (diffAllMoreLines(diff) > 0) {
    // A diff made without them (by hand): what is past the bound goes to the file the copy stopped in.
    const change = changes[current]!;
    change.moreLines = diffAllMoreLines(diff);
    change.added += Math.max(0, diff.added - changes.reduce((n, c) => n + c.added, 0));
    change.removed += Math.max(0, diff.removed - changes.reduce((n, c) => n + c.removed, 0));
  }
  // One file named twice in a patch is one file.
  const merged: FileChange[] = [];
  for (const change of changes) {
    const same = merged.find((other) => other.path === change.path);
    if (same === undefined) merged.push(change);
    else {
      same.lines.push(...change.lines);
      same.added += change.added;
      same.removed += change.removed;
      same.moreLines += change.moreLines;
    }
  }
  return merged;
}

export function turnMessage(turn: ChatTurn): string {
  const text = turnUserMessage(turn)?.text;
  if (text === undefined) return "";
  const line = (text.split(/[\n\r]/).find((part) => part.length > 0) ?? "").replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
  const characters = Array.from(line);
  return characters.length > turnMessageCharacters ? characters.slice(0, turnMessageCharacters - 1).join("") + "…" : line;
}

/** A path as one file: a relative one joined to the folder, "./" dropped. */
export function resolvePath(path: string, folder: string | null): string {
  let value = path.trim();
  while (value.startsWith("./")) value = value.slice(2);
  if (value.startsWith("/") || folder === null || folder.length === 0) return value;
  const base = ChatFolderMatch.normalised(folder);
  return (base === "/" ? "" : base) + "/" + value;
}

/** A path inside the folder by its path in it; any other whole. */
export function displayPath(path: string, folder: string | null): string {
  if (folder === null || folder.length === 0) return path;
  const base = ChatFolderMatch.normalised(folder);
  const prefix = base === "/" ? "/" : base + "/";
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path;
}

// MARK: - the transcript's end

/** One bounded backwards read of a transcript's end. */
export interface TranscriptEndRead {
  /** Whole lines, oldest first, with their offsets in the file. */
  readonly lines: readonly TranscriptLine[];
  readonly bytesRead: number;
  /** The file's start was read: nothing is before these lines. */
  readonly reachedStart: boolean;
}

/** A read came back shorter than asked: the file changed under it. */
export class TranscriptChangedUnderRead extends Error {
  constructor() {
    super("The transcript changed while it was read.");
    this.name = "TranscriptChangedUnderRead";
  }
}

/**
 * Reads backwards from the file's end in `transcriptChunkBytes` chunks until
 * the file's start or `transcriptBytesPerPane` (the chat's earlier-history
 * reader: whole lines only). Checks for cancellation before and after every read.
 */
export async function readTranscriptEnd(
  reader: TranscriptFileReader<TranscriptSessionRef>,
  path: string,
  limits: { readonly transcriptBytesPerPane: number; readonly transcriptChunkBytes: number },
  signal?: AbortSignal,
): Promise<TranscriptEndRead> {
  const check = (): void => {
    if (signal?.aborted === true) throw new ChangesCancelled();
  };
  check();
  const size = await reader.size(path);
  check();
  const earlier = new TranscriptEarlierReader(size, limits.transcriptChunkBytes);
  const chunks: TranscriptLine[][] = [];
  while (earlier.bytesRead < limits.transcriptBytesPerPane) {
    const request = earlier.nextRead();
    if (request === null) break;
    check();
    const bytes = await reader.read(path, request.offset, request.maxBytes);
    check();
    const lines = earlier.consume(request.offset, bytes);
    if (lines === null) throw new TranscriptChangedUnderRead();
    chunks.push(lines);
  }
  return { lines: chunks.reverse().flat(), bytesRead: earlier.bytesRead, reachedStart: earlier.reachedStart };
}

/**
 * The newest working folder the lines name: Claude Code's `cwd` on a user or
 * assistant line (not a sidechain's), Codex's `payload.cwd` on `turn_context`
 * (and `session_meta`, at the file's start).
 */
export function transcriptFolder(lines: readonly TranscriptLine[], format: TranscriptFormat): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index]!.text;
    if (!text.includes('"cwd"')) continue;
    const object = ChatJSON.object(text);
    if (object === null) continue;
    const type = asString(object.type);
    let folder: string | null = null;
    if (format === "claude") {
      if ((type !== "user" && type !== "assistant") || object.isSidechain === true) continue;
      folder = asString(object.cwd);
    } else {
      if (type !== "turn_context" && type !== "session_meta") continue;
      const payload = object.payload;
      folder = isObject(payload) ? asString(payload.cwd) : null;
    }
    if (folder !== null && folder.length > 0) return folder;
  }
  return null;
}
