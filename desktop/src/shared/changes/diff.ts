// A port of the Swift app's CompanionDiffParser
// (App/CompanionDiffView.swift): the Changes view's diff. git's unified text (a
// file's staged and unstaged parts, an untracked file against nothing, a commit
// with its stat) and an agent's own edits of a file become rows: the file, hunk
// headers, context, added and removed lines with the new side's line numbers,
// "\ No newline at end of file", and what is not shown (a binary file, text
// past its bound, rows past `maxDiffRows`). Lines are never wrapped: the view
// scrolls sideways as one, its width the widest line's (`columns`). Copy copies
// the text as read (the whole diff, or one file's when there are several).
// Pure: the renderer draws it (DiffView.tsx), only the rows in sight
// (`diffLayout`, `visibleRows`).

import type { GitText } from "./git";
import type { AgentEdit } from "./tools";

export type DiffRowKind =
  /** A part's title: Staged, Not staged, Untracked. */
  | "section"
  /** A file's name ("old → new" for a rename). */
  | "file"
  /** git's other header lines: a commit's header, message and stat, "new file mode", "rename from", "similarity index". */
  | "meta"
  /** "@@ -10,3 +10,4 @@ func", or an edit's turn, tool and time. */
  | "hunk"
  | "context"
  | "added"
  | "removed"
  /** "\ No newline at end of file". */
  | "noNewline"
  /** What is not shown, and why. */
  | "notice";

/** One line of a diff as the Changes view draws it. */
export interface DiffRow {
  readonly id: number;
  readonly kind: DiffRowKind;
  /** As drawn: without its +, - or space, tabs as spaces, cut at `displayCharacters`. */
  text: string;
  /** The new side's line number (context and added lines). */
  readonly number: number | null;
  /** The line was longer than drawn. */
  readonly cut: boolean;
  /** A file row's index in the document's files. */
  readonly file: number | null;
}

/** A file of a diff: its name, its row and its text for Copy. */
export interface DiffFile {
  name: string;
  /** Its file row (null past the rows drawn). */
  readonly row: number | null;
  /** From its `diff --git` line to the next file's, as read. */
  copyText: string;
}

/** A diff ready to draw. */
export interface DiffDocument {
  readonly rows: DiffRow[];
  readonly files: DiffFile[];
  /** Every added and removed line, also the ones past `maxDiffRows`. */
  added: number;
  removed: number;
  binary: boolean;
  /** The text stopped at its bound. */
  cut: boolean;
  /** The whole diff as read (a part's title as a `# ` line before it). */
  copyText: string;
  /** The widest monospaced row, in columns (the sideways width). */
  columns: number;
  /** The largest new-side number (the gutter's width). */
  largestNumber: number;
}

/** A line is drawn up to this many characters (Copy has all of it). */
export const displayCharacters = 2_000;
/** Rows drawn; the rest is counted in a notice. */
export const maxDiffRows = 20_000;
export const tabWidth = 4;

export const binaryNotice = "Binary file: its changes are not shown.";

export function sizeText(bytes: number): string {
  return bytes % 1_024 === 0 ? `${bytes / 1_024} KB` : `${bytes} bytes`;
}

export const cutNotice = (bound: number): string => `Longer than ${sizeText(bound)}: the rest is not shown.`;
export const moreRowsNotice = (count: number): string => `${count} more ${count === 1 ? "line" : "lines"} not shown here. Copy copies them.`;
export const editMoreNotice = (count: number): string => `⋯ ${count} more ${count === 1 ? "line" : "lines"} of this change not kept`;

export function rowSign(row: DiffRow): string {
  switch (row.kind) {
    case "added":
      return "+";
    case "removed":
      return "-";
    case "context":
      return " ";
    default:
      return "";
  }
}

/** What a screen reader reads: the line's kind first. */
export function rowAccessibilityText(row: DiffRow): string {
  switch (row.kind) {
    case "added":
      return "added line" + (row.number === null ? "" : ` ${row.number}`) + ", " + row.text;
    case "removed":
      return "removed line, " + row.text;
    case "context":
      return (row.number === null ? "unchanged line, " : `line ${row.number}, `) + row.text;
    case "hunk":
      return "hunk " + row.text;
    case "file":
      return "file " + row.text;
    case "noNewline":
      return "no newline at end of file";
    default:
      return row.text;
  }
}

// MARK: - documents

/** git's unified text, one part. */
export function documentFromText(text: string, maxRows: number = maxDiffRows): DiffDocument {
  const builder = new Builder(maxRows);
  builder.read(text);
  builder.document.copyText = text;
  return builder.finish(null);
}

/** A file's parts (Staged, Not staged, Untracked) or a commit (one untitled part); `bound` is the read's bound in bytes. */
export function documentFromGit(git: GitText, bound: number, maxRows: number = maxDiffRows): DiffDocument {
  const builder = new Builder(maxRows);
  for (const part of git.parts) {
    if (part.title.length > 0) builder.append("section", part.title);
    builder.read(part.text);
  }
  builder.document.copyText = git.parts.map((part) => (part.title.length === 0 ? part.text : "# " + part.title + "\n" + part.text)).join("\n");
  builder.document.cut = git.cut;
  return builder.finish(git.cut ? bound : null);
}

/**
 * An agent's edits of one file, oldest first: each under its turn, tool and
 * time. A Write of a whole file counts its lines from 1 (an edit's place in the
 * file is not in the transcript).
 */
export function documentFromEdits(edits: readonly AgentEdit[], timeZone?: string, maxRows: number = maxDiffRows): DiffDocument {
  const builder = new Builder(maxRows);
  const blocks: string[] = [];
  for (const edit of edits) {
    const title = editTitle(edit, timeZone);
    builder.append("hunk", title);
    let copy = "# " + title + "\n";
    const numbered = edit.tool === "Write" && edit.lines.every((line) => line.kind === "added");
    let number = 1;
    for (const line of edit.lines) {
      switch (line.kind) {
        case "added":
          builder.append("added", line.text, numbered ? number : null);
          number += 1;
          copy += "+" + line.text + "\n";
          break;
        case "removed":
          builder.append("removed", line.text);
          copy += "-" + line.text + "\n";
          break;
        case "context":
          builder.append("context", line.text);
          copy += " " + line.text + "\n";
          break;
        case "file":
          builder.append("meta", line.text);
          copy += line.text + "\n";
          break;
      }
    }
    if (edit.moreLines > 0) {
      builder.append("notice", editMoreNotice(edit.moreLines));
      copy += "# " + editMoreNotice(edit.moreLines) + "\n";
    }
    builder.document.added += edit.added;
    builder.document.removed += edit.removed;
    blocks.push(copy);
  }
  builder.document.copyText = blocks.join("\n");
  return builder.finish(null);
}

/** The time as the chat writes it: the locale's short clock. */
export function clockText(seconds: number, timeZone?: string): string {
  return new Date(seconds * 1_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(timeZone === undefined ? {} : { timeZone }) });
}

/** "Turn 3 · Edit · 14:02 · “fix the pairing test”". */
export function editTitle(edit: AgentEdit, timeZone?: string): string {
  const parts = [`Turn ${edit.turnNumber}`, edit.tool];
  if (edit.time !== null) parts.push(clockText(edit.time, timeZone));
  if (edit.turnMessage.length > 0) parts.push("“" + edit.turnMessage + "”");
  return parts.join(" · ");
}

// MARK: - lines as drawn

/** A line as drawn: a CR at its end dropped, tabs as spaces, control characters as U+FFFD, cut at `displayCharacters` with an ellipsis. */
export function displayLine(line: string): { text: string; cut: boolean } {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  let text = "";
  let count = 0;
  let cut = false;
  for (const character of body) {
    if (count >= displayCharacters) {
      cut = true;
      break;
    }
    if (character === "\t") {
      text += " ".repeat(tabWidth);
      count += tabWidth;
      continue;
    }
    const code = character.codePointAt(0)!;
    text += code < 0x20 || code === 0x7f ? "�" : character;
    count += 1;
  }
  if (cut) text += "…";
  return { text, cut };
}

const zeroWidth = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const wideRanges: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Columns one character takes: wide (East Asian, emoji) two, marks and joiners none. */
export function characterColumns(character: string): number {
  const value = character.codePointAt(0)!;
  if (value === 0x200d || (value >= 0xfe00 && value <= 0xfe0f)) return 0;
  if (zeroWidth.test(character)) return 0;
  return wideRanges.some(([low, high]) => value >= low && value <= high) ? 2 : 1;
}

/** Columns a monospaced line takes. */
export function diffColumns(text: string): number {
  let total = 0;
  for (const character of text) {
    const value = character.codePointAt(0)!;
    // Plain ASCII is one column: the common case without a regex.
    total += value >= 0x20 && value < 0x7f ? 1 : characterColumns(character);
  }
  return total;
}

// MARK: - headers

/** "@@ -a[,b] +c[,d] @@": the old side's count, the new side's start and count (a missing count is 1). Null for anything else (a combined diff's "@@@"). */
export function hunkHeader(line: string): { oldCount: number; newStart: number; newCount: number } | null {
  if (!line.startsWith("@@ -")) return null;
  const rest = line.slice(4);
  const end = rest.indexOf(" @@");
  if (end < 0) return null;
  const ranges = rest
    .slice(0, end)
    .split(" ")
    .filter((part) => part.length > 0);
  if (ranges.length !== 2 || !ranges[1]!.startsWith("+")) return null;
  const range = (text: string): { start: number; count: number } | null => {
    const fields = text.split(",");
    const integer = (value: string): number | null => (/^[+-]?\d+$/.test(value) ? Number(value) : null);
    const start = integer(fields[0]!);
    if (start === null || fields.length > 2) return null;
    if (fields.length !== 2) return { start, count: 1 };
    const count = integer(fields[1]!);
    return count === null ? null : { start, count };
  };
  const old = range(ranges[0]!);
  const fresh = range(ranges[1]!.slice(1));
  if (old === null || fresh === null) return null;
  return { oldCount: old.count, newStart: fresh.start, newCount: fresh.count };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const escapes: Readonly<Record<number, number>> = { 0x61: 7, 0x62: 8, 0x74: 9, 0x6e: 10, 0x76: 11, 0x66: 12, 0x72: 13, 0x22: 0x22, 0x5c: 0x5c };

/** A name git wrote in double quotes (a tab, a newline, a quote or a backslash in it): its C escapes undone. */
export function unquoteName(text: string): { name: string; rest: string } | null {
  const scalars = encoder.encode(text);
  if (scalars[0] !== 0x22) return null;
  const bytes: number[] = [];
  let index = 1;
  while (index < scalars.length) {
    const byte = scalars[index]!;
    if (byte === 0x22) return { name: decoder.decode(new Uint8Array(bytes)), rest: decoder.decode(scalars.subarray(index + 1)) };
    if (byte === 0x5c && index + 1 < scalars.length) {
      const next = scalars[index + 1]!;
      const plain = escapes[next];
      if (plain !== undefined) {
        bytes.push(plain);
        index += 2;
        continue;
      }
      const octal = scalars.subarray(index + 1, index + 4);
      if (octal.length === 3 && octal.every((value) => value >= 0x30 && value <= 0x37)) {
        bytes.push(octal.reduce((total, value) => total * 8 + (value - 0x30), 0) & 0xff);
        index += 4;
        continue;
      }
    }
    bytes.push(byte);
    index += 1;
  }
  return null;
}

/** A name with git's a/ or b/ before it. */
const strip = (name: string, prefix: string): string => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

/** "diff --git a/X b/Y" (either quoted), "diff --cc X": the names. */
export function gitNames(line: string): { old: string; new: string } | null {
  if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
    const afterFirst = line.slice(line.indexOf(" ") + 1);
    const space = afterFirst.indexOf(" ");
    const name = space < 0 ? "" : afterFirst.slice(space + 1);
    const plain = unquoteName(name)?.name ?? name;
    return { old: plain, new: plain };
  }
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  const first = unquoteName(rest);
  if (first !== null) {
    const tail = first.rest.replace(/^ +/, "");
    const second = unquoteName(tail)?.name ?? tail;
    return { old: strip(first.name, "a/"), new: strip(second, "b/") };
  }
  if (rest.endsWith('"')) {
    const open = rest.lastIndexOf(' "b/');
    if (open >= 0) {
      const second = unquoteName(rest.slice(open + 1));
      if (second !== null) return { old: strip(rest.slice(0, open), "a/"), new: strip(second.name, "b/") };
    }
  }
  // The same name twice ("a/X b/X", spaces in X), else at " b/".
  const characters = Array.from(rest);
  if (characters.length % 2 === 1) {
    const half = (characters.length - 1) / 2;
    const one = characters.slice(0, half).join("");
    const two = characters.slice(half + 1).join("");
    if (characters[half] === " " && one.startsWith("a/") && two.startsWith("b/") && strip(one, "a/") === strip(two, "b/")) {
      return { old: strip(one, "a/"), new: strip(two, "b/") };
    }
  }
  const split = rest.indexOf(" b/");
  if (split >= 0) return { old: strip(rest.slice(0, split), "a/"), new: rest.slice(split + 3) };
  return { old: rest, new: rest };
}

/** "--- a/X", "+++ b/X\t": the name (null for /dev/null), up to a tab. */
export function headerName(text: string, prefix: string): string | null {
  const tab = text.indexOf("\t");
  const field = tab < 0 ? text : text.slice(0, tab);
  if (field === "/dev/null") return null;
  const quoted = unquoteName(field);
  return strip(quoted === null ? field : quoted.name, prefix);
}

// MARK: - the builder

interface OpenFile {
  readonly index: number;
  readonly start: number;
  readonly gitOld: string | null;
  readonly gitNew: string | null;
  old: string | null;
  new: string | null;
  oldMissing: boolean;
  newMissing: boolean;
  hunks: number;
}

function openFileName(file: OpenFile): string {
  const old = file.old ?? file.gitOld;
  const fresh = file.new ?? file.gitNew;
  if (file.oldMissing) return fresh ?? old ?? "";
  if (file.newMissing) return old ?? fresh ?? "";
  if (old !== null && fresh !== null && old !== fresh) return old + " → " + fresh;
  return fresh ?? old ?? "";
}

class Builder {
  readonly document: DiffDocument = { rows: [], files: [], added: 0, removed: 0, binary: false, cut: false, copyText: "", columns: 0, largestNumber: 0 };
  private hidden = 0;

  constructor(private readonly maxRows: number) {}

  append(kind: DiffRowKind, text: string, number: number | null = null, file: number | null = null): number | null {
    if (this.document.rows.length >= this.maxRows) {
      this.hidden += 1;
      return null;
    }
    return this.add(kind, text, number, file);
  }

  private add(kind: DiffRowKind, text: string, number: number | null, file: number | null): number {
    const shown = displayLine(text);
    const id = this.document.rows.length;
    this.document.rows.push({ id, kind, text: shown.text, number, cut: shown.cut, file });
    if (kind !== "section" && kind !== "notice") this.document.columns = Math.max(this.document.columns, diffColumns(shown.text));
    if (number !== null) this.document.largestNumber = Math.max(this.document.largestNumber, number);
    return id;
  }

  /** The notices past the rows: how many were not drawn, then the bound. */
  finish(cutBound: number | null): DiffDocument {
    if (this.hidden > 0) this.add("notice", moreRowsNotice(this.hidden), null, null);
    if (cutBound !== null) this.add("notice", cutNotice(cutBound), null, null);
    return this.document;
  }

  private open(line: number, names: { old: string; new: string } | null): OpenFile {
    const index = this.document.files.length;
    const file: OpenFile = { index, start: line, gitOld: names?.old ?? null, gitNew: names?.new ?? null, old: null, new: null, oldMissing: false, newMissing: false, hunks: 0 };
    const name = openFileName(file);
    const row = this.append("file", name, null, index);
    this.document.files.push({ name, row, copyText: "" });
    return file;
  }

  private rename(file: OpenFile): void {
    const entry = this.document.files[file.index]!;
    entry.name = openFileName(file);
    if (entry.row !== null) {
      const row = this.document.rows[entry.row]!;
      row.text = displayLine(entry.name).text;
      this.document.columns = Math.max(this.document.columns, diffColumns(row.text));
    }
  }

  private close(file: OpenFile | null, lines: readonly string[], end: number): void {
    if (file === null) return;
    this.document.files[file.index]!.copyText = lines.slice(file.start, end).join("\n") + "\n";
  }

  /** One part's unified text. */
  read(text: string): void {
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    let file: OpenFile | null = null;
    let oldLeft = 0;
    let newLeft = 0;
    let number: number | null = null;
    let loose = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (oldLeft > 0 || newLeft > 0 || loose) {
        const counts: { number: number | null; oldLeft: number; newLeft: number } = { number, oldLeft, newLeft };
        if (this.body(line, counts)) {
          number = counts.number;
          oldLeft = loose ? counts.oldLeft : Math.max(counts.oldLeft, 0);
          newLeft = loose ? counts.newLeft : Math.max(counts.newLeft, 0);
          continue;
        }
        oldLeft = 0;
        newLeft = 0;
        loose = false;
      }
      if (line.startsWith("\\")) {
        this.append("noNewline", line);
      } else if (line.startsWith("@@")) {
        const header = hunkHeader(line);
        if (header !== null) {
          oldLeft = header.oldCount;
          newLeft = header.newCount;
          number = header.newStart;
          loose = false;
        } else {
          number = null;
          loose = true;
        }
        if (file !== null) file.hunks += 1;
        this.append("hunk", line);
      } else if (gitNames(line) !== null) {
        this.close(file, lines, index);
        file = this.open(index, gitNames(line));
      } else if (line.startsWith("--- ") && index + 1 < lines.length && lines[index + 1]!.startsWith("+++ ")) {
        if (file === null || file.hunks > 0) {
          this.close(file, lines, index);
          file = this.open(index, null);
        }
        const name = headerName(line.slice(4), "a/");
        file.old = name;
        file.oldMissing = name === null;
        this.rename(file);
      } else if (line.startsWith("+++ ") && file !== null && index > 0 && lines[index - 1]!.startsWith("--- ")) {
        const name = headerName(line.slice(4), "b/");
        file.new = name;
        file.newMissing = name === null;
        this.rename(file);
      } else if (file !== null && line.startsWith("index ")) {
        continue;
      } else if (file !== null && ((line.startsWith("Binary files ") && line.endsWith(" differ")) || line === "GIT binary patch")) {
        this.document.binary = true;
        this.append("notice", binaryNotice);
      } else {
        if (file !== null) {
          for (const [prefix, old] of [
            ["rename from ", true],
            ["rename to ", false],
            ["copy from ", true],
            ["copy to ", false],
          ] as const) {
            if (!line.startsWith(prefix)) continue;
            const name = line.slice(prefix.length);
            const plain = unquoteName(name)?.name ?? name;
            if (old) file.old = plain;
            else file.new = plain;
            this.rename(file);
          }
        }
        this.append("meta", line);
      }
    }
    this.close(file, lines, lines.length);
  }

  /** A hunk's line; false when the line is not one (the hunk ended early). */
  private body(line: string, counts: { number: number | null; oldLeft: number; newLeft: number }): boolean {
    // An empty line is context (a tool that drops a blank line's space).
    switch (line.length === 0 ? " " : line[0]) {
      case "+":
        this.append("added", line.slice(1), counts.number);
        counts.number = counts.number === null ? null : counts.number + 1;
        counts.newLeft -= 1;
        this.document.added += 1;
        return true;
      case "-":
        this.append("removed", line.slice(1));
        counts.oldLeft -= 1;
        this.document.removed += 1;
        return true;
      case " ":
        this.append("context", line.slice(1), counts.number);
        counts.number = counts.number === null ? null : counts.number + 1;
        counts.oldLeft -= 1;
        counts.newLeft -= 1;
        return true;
      case "\\":
        this.append("noNewline", line);
        return true;
      default:
        return false;
    }
  }
}

// MARK: - layout

/** Row heights in pixels: every row is drawn at its kind's fixed height, so only the rows in sight are drawn. */
export interface DiffHeights {
  readonly line: number;
  readonly file: number;
  readonly section: number;
  readonly notice: number;
}

export const diffHeights: DiffHeights = { line: 20, file: 32, section: 36, notice: 30 };

export interface DiffLayout {
  readonly heights: DiffHeights;
  /** Each row's top. */
  readonly offsets: readonly number[];
  readonly total: number;
}

export function rowHeight(kind: DiffRowKind, heights: DiffHeights = diffHeights): number {
  switch (kind) {
    case "file":
      return heights.file;
    case "section":
      return heights.section;
    case "notice":
      return heights.notice;
    default:
      return heights.line;
  }
}

export function diffLayout(document: DiffDocument, heights: DiffHeights = diffHeights): DiffLayout {
  const offsets: number[] = [];
  let total = 0;
  for (const row of document.rows) {
    offsets.push(total);
    total += rowHeight(row.kind, heights);
  }
  return { heights, offsets, total };
}

/** The rows [start, end) a viewport of `height` at `top` shows, `overscan` more each side. */
export function visibleRows(layout: DiffLayout, top: number, height: number, overscan: number): { start: number; end: number } {
  const count = layout.offsets.length;
  if (count === 0) return { start: 0, end: 0 };
  // The first row whose bottom is below `top`.
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    const bottom = (layout.offsets[middle + 1] ?? layout.total) as number;
    if (bottom <= top) low = middle + 1;
    else high = middle;
  }
  const first = low;
  // The first row starting at or past the viewport's bottom.
  low = first;
  high = count;
  const bottom = top + Math.max(0, height);
  while (low < high) {
    const middle = (low + high) >> 1;
    if (layout.offsets[middle]! < bottom) low = middle + 1;
    else high = middle;
  }
  return { start: Math.max(0, Math.min(first, count) - overscan), end: Math.min(count, low + overscan) };
}
