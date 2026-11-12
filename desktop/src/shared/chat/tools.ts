// Helpers both transcript parsers share: JSON access, timestamps, diffs, tool
// output summaries, shell command classification and attachment extraction.
// A port of HerdrKit's ChatToolSupport.swift.

import {
  attachment,
  bashDetail,
  diffCountsText,
  diffLine,
  fullDiffByteCount,
  fullDiffLineCount,
  keptDiffLineCount,
  keptOutputLines,
  keptSearchFiles,
  searchDetail,
  type ChatAttachment,
  type ChatDiff,
  type ChatDiffLine,
  type ChatPlanStep,
  type ChatToolCall,
  type ChatToolDetail,
  type ChatToolKind,
  type ChatToolOutput,
} from "./model";
import { uploadFolderPrefixes } from "../attachments";

// MARK: - text helpers (Swift's trimming sets)

/** Swift `.whitespaces`: spaces and tabs, no newlines. */
const spaces = /^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu;
export const trimSpaces = (text: string): string => text.replace(spaces, "");
/** Swift `.whitespacesAndNewlines`. */
export const trimAll = (text: string): string => text.trim();
export const isBlank = (text: string): boolean => text.trim().length === 0;

// MARK: - JSON

export type JSONObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JSONObject => typeof value === "object" && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

export const asObject = (value: unknown): JSONObject | null => (isObject(value) ? value : null);

/** Objects of an array, the others left out (Swift's `as? [[String: Any]]` fails whole; callers use this where it did not matter). */
export function objects(value: unknown): JSONObject[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isObject)) return null;
  return value;
}

export const ChatJSON = {
  /** One transcript line as a JSON object, or null when it is not one. */
  object(line: string): JSONObject | null {
    try {
      const value: unknown = JSON.parse(line);
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  },

  value(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  },

  int(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
    if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  },

  double(value: unknown): number | null {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() === value && value.length > 0) {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  },

  bool(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    return false;
  },

  /** Text of a tool result's content: a string, or blocks with `text`. */
  text(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const block of value) {
        if (typeof block === "string") parts.push(block);
        else if (isObject(block) && typeof block.text === "string") parts.push(block.text);
      }
      return parts.join("\n");
    }
    if (isObject(value) && typeof value.text === "string") return value.text;
    return "";
  },
};

// MARK: - Timestamps

/**
 * ISO 8601 as both agents write it: `2026-11-01T02:41:07.311Z`, with or without
 * fractional seconds, `Z` or a `±hh:mm` offset (no offset reads as UTC). Seconds
 * since 1970, or null.
 */
export function parseChatDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const s = value;
  let i = 0;
  const code = (at: number): number => s.charCodeAt(at);
  const number = (count: number): number | null => {
    if (i + count > s.length) return null;
    let result = 0;
    for (let n = 0; n < count; n += 1) {
      const c = code(i);
      if (c < 48 || c > 57) return null;
      result = result * 10 + (c - 48);
      i += 1;
    }
    return result;
  };
  const expect = (options: readonly number[]): boolean => {
    if (i >= s.length || !options.includes(code(i))) return false;
    i += 1;
    return true;
  };
  const year = number(4);
  if (year === null || !expect([45])) return null;
  const month = number(2);
  if (month === null || !expect([45])) return null;
  const day = number(2);
  if (day === null || !expect([84, 116, 32])) return null;
  const hour = number(2);
  if (hour === null || !expect([58])) return null;
  const minute = number(2);
  if (minute === null || !expect([58])) return null;
  const second = number(2);
  if (second === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour >= 24 || minute >= 60 || second >= 61) return null;
  let fraction = 0;
  if (i < s.length && code(i) === 46) {
    i += 1;
    let scale = 0.1;
    while (i < s.length && code(i) >= 48 && code(i) <= 57) {
      fraction += (code(i) - 48) * scale;
      scale /= 10;
      i += 1;
    }
  }
  let offset = 0;
  if (i < s.length) {
    const c = code(i);
    if (c === 90 || c === 122) {
      i += 1;
    } else if (c === 43 || c === 45) {
      const sign = c === 45 ? -1 : 1;
      i += 1;
      const hours = number(2);
      if (hours === null) return null;
      expect([58]);
      const minutes = number(2) ?? 0;
      offset = sign * (hours * 3600 + minutes * 60);
    } else {
      return null;
    }
  }
  // Days from 1970-01-01 (Howard Hinnant's days_from_civil), integer division as Swift's.
  const div = (a: number, b: number): number => Math.trunc(a / b);
  const y = month <= 2 ? year - 1 : year;
  const era = div(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = div(153 * mp + 2, 5) + day - 1;
  const doe = yoe * 365 + div(yoe, 4) - div(yoe, 100) + doy;
  const days = era * 146_097 + doe - 719_468;
  const seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset;
  return seconds + fraction;
}

// MARK: - Diffs

/** A text's length in UTF-8 bytes, counted without encoding it (Swift's `utf8.count`). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

type Op = { readonly op: "equal" | "delete" | "insert"; readonly text: string };

export const ChatDiffMaker = {
  /** Claude Edit: `old_string` → `new_string`, with one line of context around each change. */
  replacement(old: string, replacement: string, path: string): ChatDiff {
    return ChatDiffMaker.replacements([{ old, new: replacement }], path);
  },

  /** Claude MultiEdit: each edit in turn, counted together. */
  replacements(edits: readonly { readonly old: string; readonly new: string }[], path: string): ChatDiff {
    const lines: ChatDiffLine[] = [];
    let added = 0;
    let removed = 0;
    for (const edit of edits) {
      const result = ChatDiffMaker.lineDiff(ChatDiffMaker.splitLines(edit.old), ChatDiffMaker.splitLines(edit.new));
      lines.push(...result.lines);
      added += result.added;
      removed += result.removed;
    }
    return ChatDiffMaker.make(path.length === 0 ? [] : [path], lines, added, removed);
  },

  /** Claude Write (and a notebook cell's new source): every line added. */
  written(content: string, path: string): ChatDiff {
    const lines = ChatDiffMaker.splitLines(content).map((line) => diffLine("added", line));
    return ChatDiffMaker.make(path.length === 0 ? [] : [path], lines, lines.length, 0);
  },

  /** Codex `apply_patch` sections with `+`, `-` and ` ` lines; null when the text holds no patch. */
  patch(text: string): ChatDiff | null {
    let body = text;
    const begin = text.indexOf("*** Begin Patch");
    if (begin >= 0) {
      body = text.slice(begin + "*** Begin Patch".length);
      const end = body.indexOf("*** End Patch");
      if (end >= 0) body = body.slice(0, end);
    }
    const groups: { file: string; lines: ChatDiffLine[] }[] = [];
    let added = 0;
    let removed = 0;
    let sawHeader = false;
    for (const raw of body.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.startsWith("*** ")) {
        for (const prefix of ["*** Update File: ", "*** Add File: ", "*** Delete File: "]) {
          if (line.startsWith(prefix)) {
            groups.push({ file: trimSpaces(line.slice(prefix.length)), lines: [] });
            sawHeader = true;
          }
        }
        continue;
      }
      if (line.startsWith("@@") || line.length === 0) continue;
      if (groups.length === 0) groups.push({ file: "", lines: [] });
      const group = groups[groups.length - 1]!;
      const first = line[0];
      if (first === "+") {
        group.lines.push(diffLine("added", line.slice(1)));
        added += 1;
      } else if (first === "-") {
        group.lines.push(diffLine("removed", line.slice(1)));
        removed += 1;
      } else if (first === " ") {
        group.lines.push(diffLine("context", line.slice(1)));
      }
    }
    if (!sawHeader && added + removed === 0) return null;
    const files = groups.map((group) => group.file).filter((file) => file.length > 0);
    const lines: ChatDiffLine[] = [];
    for (const group of groups) {
      if (files.length > 1 && group.file.length > 0) lines.push(diffLine("file", group.file));
      lines.push(...group.lines);
    }
    return ChatDiffMaker.make(files, lines, added, removed);
  },

  make(files: readonly string[], lines: readonly ChatDiffLine[], added: number, removed: number): ChatDiff {
    const diff: ChatDiff = {
      files: [...files],
      added,
      removed,
      lines: lines.slice(0, keptDiffLineCount),
      moreLines: Math.max(0, lines.length - keptDiffLineCount),
    };
    // The full copy, to its lines' and bytes' bound (left out where the shown lines hold them all).
    const most = Math.min(lines.length, fullDiffLineCount);
    let kept = 0;
    let bytes = 0;
    while (kept < most) {
      const size = utf8Length(lines[kept]!.text);
      if (bytes + size > fullDiffByteCount) break;
      bytes += size;
      kept += 1;
    }
    // Over several files, each one's counts and cut lines, before the bound (a file past it keeps its counts).
    const counts: { path: string | null; added: number; removed: number; omittedLines: number }[] = [];
    if (lines.some((line) => line.kind === "file")) {
      lines.forEach((line, index) => {
        if (line.kind === "file") {
          counts.push({ path: line.text, added: 0, removed: 0, omittedLines: 0 });
          return;
        }
        if (counts.length === 0) counts.push({ path: null, added: 0, removed: 0, omittedLines: 0 });
        const count = counts[counts.length - 1]!;
        if (line.kind === "added") count.added += 1;
        if (line.kind === "removed") count.removed += 1;
        if (index >= kept) count.omittedLines += 1;
      });
    }
    const whole = kept === lines.length && lines.length <= keptDiffLineCount;
    return {
      ...diff,
      ...(whole ? {} : { allLines: lines.slice(0, kept), allMoreLines: lines.length - kept }),
      ...(counts.length > 0 ? { fileCounts: counts } : {}),
    };
  },

  splitLines(text: string): string[] {
    if (text.length === 0) return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  },

  /** A line diff (longest common subsequence) with one context line around each change, removals first. */
  lineDiff(old: readonly string[], next: readonly string[]): { lines: ChatDiffLine[]; added: number; removed: number } {
    const ops = operations(old, next);
    const include = Array.from({ length: ops.length }, () => false);
    ops.forEach((op, index) => {
      if (op.op === "equal") return;
      include[index] = true;
      if (index > 0) include[index - 1] = true;
      if (index + 1 < ops.length) include[index + 1] = true;
    });
    const lines: ChatDiffLine[] = [];
    let added = 0;
    let removed = 0;
    ops.forEach((op, index) => {
      if (op.op === "equal") {
        if (include[index]) lines.push(diffLine("context", op.text));
      } else if (op.op === "delete") {
        lines.push(diffLine("removed", op.text));
        removed += 1;
      } else {
        lines.push(diffLine("added", op.text));
        added += 1;
      }
    });
    return { lines, added, removed };
  },
};

/** Common prefix and suffix first; the middle by LCS when it is small enough, else removed and added whole. */
function operations(old: readonly string[], next: readonly string[]): Op[] {
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix += 1;
  }
  const a = old.slice(prefix, old.length - suffix);
  const b = next.slice(prefix, next.length - suffix);
  let middle: Op[] = [];
  if (a.length === 0 || b.length === 0 || a.length * b.length > 250_000) {
    middle = [...a.map((text): Op => ({ op: "delete", text })), ...b.map((text): Op => ({ op: "insert", text }))];
  } else {
    const width = b.length + 1;
    const lengths = new Int32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          a[i] === b[j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    let deletes: Op[] = [];
    let inserts: Op[] = [];
    const flush = (): void => {
      middle.push(...deletes, ...inserts);
      deletes = [];
      inserts = [];
    };
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        flush();
        middle.push({ op: "equal", text: a[i]! });
        i += 1;
        j += 1;
      } else if (j >= b.length || (i < a.length && lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
        deletes.push({ op: "delete", text: a[i]! });
        i += 1;
      } else {
        inserts.push({ op: "insert", text: b[j]! });
        j += 1;
      }
    }
    flush();
  }
  return [
    ...old.slice(0, prefix).map((text): Op => ({ op: "equal", text })),
    ...middle,
    ...old.slice(old.length - suffix).map((text): Op => ({ op: "equal", text })),
  ];
}

// MARK: - Tool output

const isAsciiDigit = (c: string): boolean => c >= "0" && c <= "9";

export const ChatOutputText = {
  /** Removes terminal escape sequences (colours, cursor moves, titles). */
  strippingEscapes(text: string): string {
    if (!text.includes("\u001b")) return text;
    const scalars = Array.from(text);
    let out = "";
    let i = 0;
    while (i < scalars.length) {
      const scalar = scalars[i++]!;
      if (scalar !== "\u001b") {
        out += scalar;
        continue;
      }
      if (i >= scalars.length) break;
      const next = scalars[i++]!;
      if (next === "[") {
        while (i < scalars.length) {
          const c = scalars[i++]!.codePointAt(0)!;
          if (c >= 0x40 && c <= 0x7e) break;
        }
      } else if (next === "]") {
        let previous = " ";
        while (i < scalars.length) {
          const c = scalars[i++]!;
          if (c === "\u0007" || (previous === "\u001b" && c === "\\")) break;
          previous = c;
        }
      }
    }
    return out;
  },

  /** Drops `<system-reminder>…</system-reminder>` blocks Claude Code adds to tool results. */
  strippingSystemReminders(text: string): string {
    let result = text;
    for (;;) {
      const open = result.indexOf("<system-reminder>");
      if (open < 0) return result;
      const close = result.indexOf("</system-reminder>", open + "<system-reminder>".length);
      result = close >= 0 ? result.slice(0, open) + result.slice(close + "</system-reminder>".length) : result.slice(0, open);
    }
  },

  lines(text: string): string[] {
    const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    while (lines.length > 0 && trimSpaces(lines[lines.length - 1]!).length === 0) lines.pop();
    return lines;
  },

  /** The last `count` non-empty lines, escapes removed. */
  lastLines(text: string, count: number = keptOutputLines): string[] {
    const clean = ChatOutputText.strippingEscapes(text);
    const kept = ChatOutputText.lines(clean)
      .map((line) => line.replace(/[ \t]+$/, ""))
      .filter((line) => line.length > 0);
    return kept.slice(Math.max(0, kept.length - count));
  },

  /** Lines a Read returned: Claude's numbered `   12→text` lines when it numbers them, else every line. */
  readLineCount(text: string): number {
    const all = ChatOutputText.lines(ChatOutputText.strippingSystemReminders(text));
    const numbered = all.filter(isNumberedLine).length;
    return numbered > 0 ? numbered : all.length;
  },

  /** Files a search printed, and the stated file count ("Found N files") or the distinct files listed. */
  matchedFiles(text: string): { files: string[]; count: number } {
    let lines = ChatOutputText.lines(ChatOutputText.strippingEscapes(ChatOutputText.strippingSystemReminders(text)))
      .map(trimSpaces)
      .filter((line) => line.length > 0 && line !== "--");
    let stated: number | null = null;
    const first = lines[0];
    if (first !== undefined) {
      if (first.startsWith("No files found") || first.startsWith("No matches found")) return { files: [], count: 0 };
      const words = first.split(" ").filter((word) => word.length > 0);
      const n = words[1] !== undefined && /^[+-]?\d+$/.test(words[1]) ? Number(words[1]) : null;
      const unit = words[2] ?? "";
      if (words.length >= 3 && words[0] === "Found" && n !== null && (unit.startsWith("file") || unit.startsWith("match") || unit.startsWith("line"))) {
        if (unit.startsWith("file")) stated = n;
        lines = lines.slice(1);
      }
    }
    const files: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.startsWith("(Results are truncated")) continue;
      let file = line;
      const colon = line.indexOf(":");
      if (colon >= 0) {
        const head = line.slice(0, colon);
        if (head.length > 0 && (head.includes("/") || head.includes("."))) file = head;
      }
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
    return { files: files.slice(0, keptSearchFiles), count: stated ?? files.length };
  },
};

function isNumberedLine(line: string): boolean {
  let sawDigit = false;
  for (const character of line) {
    if (character === " " && !sawDigit) continue;
    if (isAsciiDigit(character)) {
      sawDigit = true;
      continue;
    }
    return sawDigit && (character === "→" || character === "\t");
  }
  return false;
}

// MARK: - Results onto calls

const noMatchPrograms = new Set(["grep", "egrep", "fgrep", "rg"]);

export const ChatToolResults = {
  /** What a row shows before its result: an edit's counts, a plan's progress. */
  startingSummary(call: ChatToolCall): string | null {
    let base: string | null = null;
    if (call.detail.type === "diff") base = diffCountsText(call.detail.diff);
    else if (call.detail.type === "plan" && call.detail.steps.length > 0) base = ChatToolResults.planProgress(call.detail.steps);
    return ChatToolResults.withMore(base, call.moreCalls);
  },

  planProgress(steps: readonly ChatPlanStep[]): string {
    return `${steps.filter((step) => step.status === "completed").length} of ${steps.length} done`;
  },

  withMore(summary: string | null, more: number): string | null {
    if (more <= 0) return summary;
    const extra = `+${more} more`;
    if (summary === null || summary.length === 0) return extra;
    return summary + " · " + extra;
  },

  /** grep, rg and friends exit 1 when nothing matched: with no output that is not a failure. */
  isNoMatchSearch(call: ChatToolCall, exitCode: number, output: ChatToolOutput): boolean {
    if (call.kind !== "search" || exitCode !== 1 || call.program === null || !noMatchPrograms.has(call.program)) return false;
    return ChatOutputText.strippingEscapes(output.text).trim().length === 0;
  },

  /** `call` with `output` applied. */
  apply(output: ChatToolOutput, call: ChatToolCall, time: number | null): ChatToolCall {
    let state: ChatToolCall["state"];
    if (output.isRunning) state = "running";
    else if (output.isError) state = "failed";
    else if (output.exitCode !== null && output.exitCode !== 0 && !ChatToolResults.isNoMatchSearch(call, output.exitCode, output)) state = "failed";
    else state = "ok";
    const failed = state === "failed";
    let detail: ChatToolDetail = call.detail;
    let summary: string | null = null;
    const kind = call.kind;
    if (kind === "read") {
      const count = ChatOutputText.readLineCount(output.text);
      if (!failed && !output.isRunning && count > 0) summary = count === 1 ? "1 line" : `${count} lines`;
    } else if (kind === "edit") {
      if (failed) summary = "failed";
      else if (call.detail.type === "diff") summary = diffCountsText(call.detail.diff);
    } else if (kind === "bash") {
      const command = call.detail.type === "bash" ? call.detail.bash.command : call.target;
      detail = { type: "bash", bash: bashDetail(command, ChatOutputText.lastLines(output.text), output.exitCode) };
      if (output.exitCode !== null) summary = `exit ${output.exitCode}`;
      else if (failed) summary = "failed";
    } else if (kind === "search") {
      if (failed) {
        summary = "failed";
      } else if (!output.isRunning) {
        const found = ChatOutputText.matchedFiles(output.text);
        const pattern = call.detail.type === "search" ? call.detail.search.pattern : call.target;
        detail = { type: "search", search: searchDetail(pattern, found.files, found.count) };
        summary = found.count === 1 ? "1 file" : `${found.count} files`;
      }
    } else if (kind === "plan") {
      if (failed) summary = "failed";
      else if (call.detail.type === "plan" && call.detail.steps.length > 0) summary = ChatToolResults.planProgress(call.detail.steps);
    } else if (failed) {
      summary = "failed";
    }
    return { ...call, finishedAt: time, state, detail, resultSummary: ChatToolResults.withMore(summary, call.moreCalls) };
  },
};

// MARK: - Shell commands

export interface ClassifiedCommand {
  readonly kind: ChatToolKind;
  readonly target: string;
  readonly detail: ChatToolDetail;
  /** The first program (basename) when the command is a Read or Search. */
  readonly program: string | null;
}

export type ShellToken = { readonly word: string } | { readonly op: string };

const isWord = (token: ShellToken): token is { readonly word: string } => "word" in token;

/**
 * Classifies a shell command by its first program, the rule for Codex
 * `exec_command` and older `shell` calls: cat, sed -n, head, tail, nl and bat
 * read; rg, grep, find, fd and ls search; apply_patch edits; anything else is
 * Bash. A leading `cd <dir> &&` and `VAR=value` words are skipped.
 */
export const ShellCommandClassifier = {
  classify(command: string): ClassifiedCommand {
    const trimmed = command.trim();
    const bash: ClassifiedCommand = { kind: "bash", target: trimmed, detail: { type: "bash", bash: bashDetail(trimmed) }, program: null };
    const first = ShellCommandClassifier.firstCommand(ShellCommandClassifier.tokenize(trimmed));
    const { program, args, redirectsOut, heredoc } = first;
    if (program === null) return bash;
    switch (program) {
      case "cat":
      case "head":
      case "tail":
      case "nl":
      case "bat": {
        const file = positionals(args, new Set(["-n", "-c"])).at(-1);
        if (redirectsOut || heredoc || file === undefined) return bash;
        return { kind: "read", target: file, detail: { type: "none" }, program };
      }
      case "sed": {
        const flags = args.filter((arg) => arg.startsWith("-") && !arg.startsWith("--"));
        if (redirectsOut || flags.some((flag) => flag.slice(1).includes("i"))) return bash;
        if (!(flags.some((flag) => flag.slice(1).includes("n")) || args.includes("--quiet"))) return bash;
        const rest = positionals(args, new Set(["-e", "-f"]));
        return { kind: "read", target: rest.length >= 2 ? rest[rest.length - 1]! : (rest[0] ?? ""), detail: { type: "none" }, program };
      }
      case "rg":
      case "grep":
      case "egrep":
      case "fgrep":
      case "fd": {
        const pattern = searchPattern(args, program);
        return { kind: "search", target: pattern, detail: { type: "search", search: searchDetail(pattern) }, program };
      }
      case "find": {
        let target: string | null = null;
        for (let index = 0; index < args.length; index += 1) {
          if (["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"].includes(args[index]!) && index + 1 < args.length) {
            target = args[index + 1]!;
            break;
          }
        }
        const pattern = target ?? args.find((arg) => !arg.startsWith("-")) ?? ".";
        return { kind: "search", target: pattern, detail: { type: "search", search: searchDetail(pattern) }, program };
      }
      case "ls": {
        const path = args.find((arg) => !arg.startsWith("-")) ?? ".";
        return { kind: "search", target: path, detail: { type: "search", search: searchDetail(path) }, program };
      }
      case "apply_patch":
      case "applypatch":
        return ShellCommandClassifier.editFromPatch(trimmed) ?? bash;
      default:
        return bash;
    }
  },

  editFromPatch(text: string): ClassifiedCommand | null {
    const diff = ChatDiffMaker.patch(text);
    if (diff === null) return null;
    return { kind: "edit", target: diff.files[0] ?? "", detail: { type: "diff", diff }, program: null };
  },

  /** The program (basename) and arguments of the first simple command, and whether it writes to a file or reads a heredoc. */
  firstCommand(tokens: readonly ShellToken[]): { program: string | null; args: string[]; redirectsOut: boolean; heredoc: boolean } {
    const commands: ShellToken[][] = [[]];
    const separators: string[] = [];
    for (const token of tokens) {
      if (!isWord(token) && ["&&", "||", ";", "|", "\n", "&"].includes(token.op)) {
        commands.push([]);
        separators.push(token.op);
      } else {
        commands[commands.length - 1]!.push(token);
      }
    }
    for (let index = 0; index < commands.length; index += 1) {
      const words = commands[index]!.filter(isWord).map((token) => token.word);
      let skip = 0;
      while (skip < words.length && isAssignment(words[skip]!)) skip += 1;
      const rest = words.slice(skip);
      if (rest.length === 0) continue;
      if (rest[0] === "cd" && index < separators.length && ["&&", ";", "\n"].includes(separators[index]!)) continue;
      const args: string[] = [];
      let redirectsOut = false;
      let heredoc = false;
      let skipNext = false;
      let sawProgram = false;
      let program: string | null = null;
      for (const token of commands[index]!) {
        if (!isWord(token)) {
          const op = token.op;
          if (op === ">" || op === ">>" || op === "1>" || op === "1>>") redirectsOut = true;
          if (op === "<<" || op === "<<<") heredoc = true;
          skipNext = true;
          continue;
        }
        const word = token.word;
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (!sawProgram) {
          if (isAssignment(word)) continue;
          sawProgram = true;
          const parts = word.split("/").filter((part) => part.length > 0);
          program = parts[parts.length - 1] ?? word;
        } else {
          args.push(word);
        }
      }
      return { program, args, redirectsOut, heredoc };
    }
    return { program: null, args: [], redirectsOut: false, heredoc: false };
  },

  /** A small POSIX shell tokenizer: quotes, backslashes, and the operators that end a command or redirect. */
  tokenize(command: string): ShellToken[] {
    const tokens: ShellToken[] = [];
    let word = "";
    let inWord = false;
    const chars = [...Array.from(command), " "];
    const endWord = (): void => {
      if (inWord) tokens.push({ word });
      word = "";
      inWord = false;
    };
    let i = 0;
    while (i < chars.length) {
      const c = chars[i]!;
      switch (c) {
        case "'":
          inWord = true;
          i += 1;
          while (i < chars.length - 1 && chars[i] !== "'") word += chars[i++]!;
          break;
        case '"':
          inWord = true;
          i += 1;
          while (i < chars.length - 1 && chars[i] !== '"') {
            if (chars[i] === "\\" && i + 1 < chars.length - 1 && '"\\$`'.includes(chars[i + 1]!)) i += 1;
            word += chars[i]!;
            i += 1;
          }
          break;
        case "\\":
          inWord = true;
          if (i + 1 < chars.length - 1) {
            i += 1;
            if (chars[i] !== "\n") word += chars[i]!;
          }
          break;
        case " ":
        case "\t":
        case "\r":
          endWord();
          break;
        case "\n":
        case ";":
        case "|":
        case "&":
        case ">":
        case "<": {
          let descriptor = "";
          if ((c === ">" || c === "<") && inWord && word.length > 0 && /^\p{N}+$/u.test(word)) {
            descriptor = word;
            word = "";
            inWord = false;
          }
          endWord();
          let op = c;
          if (i + 1 < chars.length) {
            const next = chars[i + 1]!;
            if (
              (c === "&" && next === "&") ||
              (c === "|" && next === "|") ||
              (c === ">" && next === ">") ||
              (c === "<" && next === "<") ||
              (c === "&" && next === ">") ||
              (c === ">" && next === "&")
            ) {
              op += next;
              i += 1;
              if (op === "<<" && i + 1 < chars.length && chars[i + 1] === "<") {
                op += "<";
                i += 1;
              }
            }
          }
          if (op === "&>") op = ">";
          tokens.push({ op: descriptor + op });
          break;
        }
        default:
          inWord = true;
          word += c;
      }
      i += 1;
    }
    return tokens;
  },
};

function isAssignment(word: string): boolean {
  const equals = word.indexOf("=");
  if (equals <= 0) return false;
  return /^[\p{L}\p{N}_]+$/u.test(word.slice(0, equals));
}

function positionals(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const result: string[] = [];
  let skip = false;
  let afterDashes = false;
  for (const arg of args) {
    if (skip) {
      skip = false;
      continue;
    }
    if (afterDashes) {
      result.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashes = true;
      continue;
    }
    if (arg.startsWith("-") && Array.from(arg).length > 1) {
      if (valueFlags.has(arg)) skip = true;
      continue;
    }
    result.push(arg);
  }
  return result;
}

const fdValueFlags = new Set([
  "-e", "--extension", "-t", "--type", "-d", "--max-depth", "-E", "--exclude", "-j", "--threads",
  "-x", "--exec", "-X", "--exec-batch", "-S", "--size", "--changed-within", "--changed-before",
]);
const grepValueFlags = new Set([
  "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "-f", "--file", "-A", "-B", "-C",
  "--after-context", "--before-context", "--context", "-m", "--max-count", "-j", "--threads",
  "-M", "--max-columns", "-d", "--max-depth", "--include", "--exclude", "--exclude-dir",
  "--type-add", "-r", "--replace",
]);

function searchPattern(args: readonly string[], program: string): string {
  const valueFlags = program === "fd" ? fdValueFlags : grepValueFlags;
  let index = 0;
  let afterDashes = false;
  while (index < args.length) {
    const arg = args[index]!;
    if (afterDashes) return arg;
    if (program !== "fd" && (arg === "-e" || arg === "--regexp") && index + 1 < args.length) return args[index + 1]!;
    if (program !== "fd" && arg.startsWith("--regexp=")) return arg.slice("--regexp=".length);
    if (arg === "--") {
      afterDashes = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("-") && Array.from(arg).length > 1) {
      index += valueFlags.has(arg) ? 2 : 1;
      continue;
    }
    return arg;
  }
  if (args.includes("--files")) return "files";
  return "";
}

// MARK: - Attachments in message text

/** The uploader's safe extensions (HerdrKit RemoteAttachment.safeExtension). */
export function safeAttachmentExtension(value: string): string | null {
  switch (value.toLowerCase()) {
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpg";
    case "pdf":
      return "pdf";
    case "txt":
    case "text":
      return "txt";
    case "log":
      return "log";
    case "md":
    case "markdown":
      return "md";
    case "json":
      return "json";
    case "csv":
      return "csv";
    case "zip":
      return "zip";
    default:
      return null;
  }
}

interface Range {
  readonly location: number;
  readonly length: number;
}

const units = (characters: string): ReadonlySet<number> => new Set(Array.from({ length: characters.length }, (_, i) => characters.charCodeAt(i)));
const SLASH = 47;
const BACKSLASH = 92;
const quotes = units("\"'`");
const openers = units("<([{");
const closers = units(">)]}");
/** What may follow an upload path's extension. */
const afterPath = units("\"'`)]}>,;:.!?");
const isSpaceUnit = (unit: number): boolean => unit === 32 || unit === 9 || unit === 10 || unit === 13;
const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const overlaps = (range: Range, others: readonly Range[]): boolean =>
  others.some((other) => Math.max(range.location, other.location) < Math.min(range.location + range.length, other.location + other.length));

/**
 * Moves attachments out of a typed message: the Mac paths the app appends (a
 * path containing `.adari-attachments-`, or the old `.herdr-companion-attachments-`), Claude Code's
 * `[Image: source: <path>]` markers, and its `[Image #N]` markers (counted).
 * Indices are UTF-16 units, as NSString's.
 */
export const ChatAttachmentText = {
  /** The upload folder names, the new one first (src/shared/attachments.ts). */
  uploadMarkers: uploadFolderPrefixes,

  extract(text: string): { text: string; attachments: ChatAttachment[]; imageMarkers: number } {
    const removals: { range: Range; attachment: ChatAttachment | null }[] = [];
    let imageMarkers = 0;
    for (const match of text.matchAll(/\[Image: source: ([^\]\n]+)\]/g)) {
      const path = trimSpaces(match[1] ?? "");
      removals.push({ range: { location: match.index, length: match[0].length }, attachment: attachment(path) });
    }
    for (const match of text.matchAll(/\[Image #\p{Nd}+\]/gu)) {
      const range = { location: match.index, length: match[0].length };
      if (overlaps(range, removals.map((removal) => removal.range))) continue;
      imageMarkers += 1;
      removals.push({ range, attachment: null });
    }
    // One pass for every folder name: find the end they share, then the name before it.
    const tail = "-attachments-";
    let from = 0;
    for (;;) {
      const at = text.indexOf(tail, from);
      if (at < 0) break;
      const end = at + tail.length;
      let next = end;
      const marker = ChatAttachmentText.uploadMarkers.find((name) => end - name.length >= 0 && text.startsWith(name, end - name.length));
      const upload = marker === undefined ? null : uploadPath(text, { location: end - marker.length, length: marker.length });
      if (upload !== null && !overlaps(upload.range, removals.map((removal) => removal.range))) {
        removals.push({ range: upload.range, attachment: attachment(upload.path) });
        next = upload.range.location + upload.range.length;
      }
      from = next;
      if (text.length - from <= 0) break;
    }
    if (removals.length === 0) return { text, attachments: [], imageMarkers: 0 };
    removals.sort((a, b) => a.range.location - b.range.location);
    let out = "";
    let cursor = 0;
    for (const removal of removals) {
      out += text.slice(cursor, removal.range.location);
      out = out.replace(/[ \t]+$/, "");
      cursor = removal.range.location + removal.range.length;
      if (out.length === 0 || out.endsWith("\n")) {
        while (cursor < text.length && (text.charCodeAt(cursor) === 32 || text.charCodeAt(cursor) === 9)) cursor += 1;
        if (out.length > 0 && cursor < text.length && text.charCodeAt(cursor) === 10) cursor += 1;
      }
    }
    out += text.slice(cursor);
    const attachments = removals.flatMap((removal) => (removal.attachment === null ? [] : [removal.attachment]));
    return { text: out.trim(), attachments, imageMarkers };
  },
};

/** The whole upload path around `marker` and the text to remove with it; null when it cannot be established. */
function uploadPath(ns: string, marker: Range): { path: string; range: Range } | null {
  const end = uploadPathEnd(ns, marker.location + marker.length);
  if (end === null) return null;
  const at = (index: number): number => ns.charCodeAt(index);
  if (end < ns.length && quotes.has(at(end))) {
    const mark = at(end);
    let quote = marker.location - 1;
    while (quote >= 0 && at(quote) !== mark && at(quote) !== 10 && at(quote) !== 13) quote -= 1;
    if (quote >= 0 && at(quote) === mark && at(quote + 1) === SLASH) {
      return { path: ns.slice(quote + 1, end), range: { location: quote, length: end + 1 - quote } };
    }
  }
  let start = marker.location;
  while (start > 0) {
    const unit = at(start - 1);
    if (isSpaceUnit(unit)) {
      if (!(unit === 32 && start >= 2 && at(start - 2) === BACKSLASH)) break;
      start -= 2;
      continue;
    }
    start -= 1;
  }
  let pathStart = start;
  while (pathStart < marker.location && openers.has(at(pathStart))) pathStart += 1;
  if (!(pathStart < marker.location && at(pathStart) === SLASH)) return null;
  const path = ns.slice(pathStart, end).split("\\ ").join(" ");
  let removalEnd = end;
  let unclosed = pathStart - start;
  while (unclosed > 0 && removalEnd < ns.length && closers.has(at(removalEnd))) {
    removalEnd += 1;
    unclosed -= 1;
  }
  return { path, range: { location: start, length: removalEnd - start } };
}

/** Where an upload path ends: 32 hex digits, `/attachment-`, a UUID, `.`, a safe extension, then an end. */
function uploadPathEnd(ns: string, index: number): number | null {
  const length = ns.length;
  let at = index;
  if (at + 32 > length) return null;
  for (let offset = 0; offset < 32; offset += 1) {
    const unit = ns.charCodeAt(at + offset);
    if (!((unit >= 48 && unit <= 57) || (unit >= 97 && unit <= 102))) return null;
  }
  at += 32;
  const fileStart = "/attachment-";
  if (!(at + fileStart.length + 36 + 2 <= length) || ns.slice(at, at + fileStart.length) !== fileStart) return null;
  at += fileStart.length;
  if (!uuidPattern.test(ns.slice(at, at + 36))) return null;
  at += 36;
  if (ns.charCodeAt(at) !== 46) return null;
  at += 1;
  const extensionStart = at;
  while (at < length && at - extensionStart < 10 && /^[A-Za-z0-9]$/.test(ns[at]!)) at += 1;
  if (safeAttachmentExtension(ns.slice(extensionStart, at)) === null) return null;
  if (!(at === length || isSpaceUnit(ns.charCodeAt(at)) || afterPath.has(ns.charCodeAt(at)))) return null;
  return at;
}
