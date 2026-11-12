// The reply shows as it is written (a port of HerdrKit's ChatLiveScreen.swift,
// the rules as they are). While a Claude Code pane works, its screen
// shows the text the agent is writing before the transcript has the block:
// the block after the last agent bullet, above the spinner and the input box,
// wrapped at the pane's width. `ChatLiveScreen` takes that text off the screen
// (`pane.read`, ANSI stripped); `ChatLiveMerge` shows it as the turn's last row
// until the transcript's own block lands; `ChatLiveReader` (live-reader.ts)
// reads the screen.
//
// Text is measured and walked as Swift's Characters are: by grapheme cluster
// (Intl.Segmenter), with Swift's character classes (Unicode properties).
//
// Codex's screen reads too (`codexBlock`, the same as
// HerdrKit's): the reply is the "• " block directly above the "› " box. A
// screen with Claude Code's box reads as Claude Code's; any other is read as Codex's.
//
// Cursor's screen reads too (`cursorBlock`, the same as HerdrKit's): the reply
// is the block below the last tool row (or the two blank lines under your
// echoed prompt) and above the braille spinner row, while
// "ctrl+c to stop" shows at the "→" box. A screen that is neither Claude Code's
// nor Codex's is tried as Cursor's.

import { claudeBoxRules, isClaudeTopRule } from "../claude-box";
import type { ChatAgentText, ChatTimeline, ChatTurn } from "./model";

/** Whose screen drew a block: Claude Code's (none said), Codex's, whose drawing of a link differs, or Cursor's. */
export type LiveDrawing = "claude" | "codex" | "cursor";

/** The agent's text block on a Claude Code (or Codex, or Cursor) screen. */
export interface ChatLiveBlock {
  /** Its text, joined across the terminal's wraps (paragraphs kept). */
  readonly text: string;
  /** Tool rows came after it on screen: the agent went on to a tool, the block only waits for the transcript. */
  readonly finished: boolean;
  /** Read off Codex's screen ("codex") or Cursor's ("cursor"); absent for Claude Code's. */
  readonly drawing?: "codex" | "cursor";
}

export const liveBlock = (text: string, finished = false, drawing: LiveDrawing = "claude"): ChatLiveBlock =>
  drawing === "claude" ? { text, finished } : { text, finished, drawing };

// MARK: - Characters as Swift has them

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text's Characters (grapheme clusters). */
export function characters(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of graphemes.segment(text)) out.push(segment);
  return out;
}

const count = (text: string): number => characters(text).length;
const isLetter = (c: string | undefined): boolean => c !== undefined && /^\p{L}/u.test(c);
const isNumber = (c: string | undefined): boolean => c !== undefined && /^\p{N}/u.test(c);
const isWhitespace = (c: string | undefined): boolean => c !== undefined && /^\p{White_Space}/u.test(c);
const isUppercase = (c: string | undefined): boolean => c !== undefined && /^\p{Uppercase}/u.test(c);
const isPunctuation = (c: string): boolean => /^\p{P}/u.test(c);
const isSymbol = (c: string): boolean => /^\p{S}/u.test(c);
const isASCII = (c: string): boolean => c.length === 1 && c.charCodeAt(0) < 128;
/** One scalar, in the box-drawing block (U+2500 to U+257F). */
const isBox = (c: string | undefined): boolean => {
  if (c === undefined) return false;
  const scalars = Array.from(c);
  if (scalars.length !== 1) return false;
  const value = scalars[0]!.codePointAt(0)!;
  return value >= 0x2500 && value <= 0x257f;
};

/** `CharacterSet.whitespaces`: spaces (Zs) and tab. */
const isBlank = (c: string): boolean => c === "\t" || /^\p{Zs}$/u.test(c);
function trimBlanks(text: string): string {
  const chars = characters(text);
  let start = 0;
  let end = chars.length;
  while (start < end && isBlank(chars[start]!)) start += 1;
  while (end > start && isBlank(chars[end - 1]!)) end -= 1;
  return chars.slice(start, end).join("");
}

/** Drops the leading characters `test` takes. */
function dropWhile(text: string, test: (c: string) => boolean): string {
  const chars = characters(text);
  let index = 0;
  while (index < chars.length && test(chars[index]!)) index += 1;
  return chars.slice(index).join("");
}
const dropSpaces = (text: string): string => dropWhile(text, (c) => c === " ");
const dropFirst = (text: string, n = 1): string => characters(text).slice(n).join("");
const first = (text: string): string | undefined => characters(text)[0];
const second = (text: string): string | undefined => characters(text)[1];
const last = (text: string): string | undefined => characters(text).at(-1);
/** Swift's `hasPrefix`: Character by Character. */
function hasPrefix(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  const a = characters(text);
  const b = characters(prefix);
  return b.every((c, index) => a[index] === c);
}
/** Splits at each character `test` takes, empty pieces kept. */
function splitWhere(text: string, test: (c: string) => boolean): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const c of characters(text)) {
    if (test(c)) {
      pieces.push(piece);
      piece = "";
    } else {
      piece += c;
    }
  }
  pieces.push(piece);
  return pieces;
}

// MARK: - The screen

const agentBullets = new Set(["\u{23FA}", "\u{25CF}"]); // ⏺ ●
const promptMark = "\u{276F}"; // ❯
const ruleMark = "\u{2500}"; // ─
const outputMark = "\u{23BF}"; // ⎿
const ellipsis = "\u{2026}"; // …

type Kind = "agent" | "user" | "other";

/** A block: its first line at the margin, then its indented lines and blanks. */
interface Unit {
  readonly kind: Kind;
  readonly lines: string[];
}

/** Its lines split at blank lines (the raw lines, bullet or indent and all). */
function paragraphsOf(unit: Unit): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of unit.lines) {
    if (line === "") {
      if (current.length > 0) paragraphs.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

function trimmedEnd(line: string): string {
  const chars = characters(line);
  let end = chars.length;
  while (end > 0 && isWhitespace(chars[end - 1])) end -= 1;
  return chars.slice(0, end).join("");
}

function units(lines: readonly string[], kindOf: (line: string) => Kind = claudeKind): Unit[] {
  const out: Unit[] = [];
  for (const line of lines) {
    if (line === "" || first(line) === " ") {
      // Lines before any block's start belong to one cut off above.
      if (out.length === 0) {
        if (line === "") continue;
        out.push({ kind: "other", lines: [line] });
      } else {
        out[out.length - 1]!.lines.push(line);
      }
      continue;
    }
    out.push({ kind: kindOf(line), lines: [line] });
  }
  return out;
}

/** A Claude Code block's kind by its first line. */
function claudeKind(line: string): Kind {
  const chars = characters(line).slice(0, 2);
  if (chars[0] !== undefined && agentBullets.has(chars[0]) && chars.length === 2 && chars[1] === " ") return "agent";
  if (chars[0] === promptMark) return "user";
  return "other";
}

/** The text of a block's line without its bullet or indent. */
const content = (line: string): string => dropFirst(line, 2);

function lastIndex(lines: readonly string[], before: number, test: (line: string) => boolean): number {
  for (let index = before - 1; index >= 0; index -= 1) if (test(lines[index]!)) return index;
  return -1;
}

/** A rule of the input box: its top one may hold the session's name (claude-box.ts). */
const isRule = isClaudeTopRule;

/** Claude Code's working line (the spinner row above its box), as the live row reads it. */
export function isClaudeWorkingLine(line: string): boolean {
  return isSpinner(line.trim());
}

/** The working line: a glyph, a space, then words ending "…" (the verb, or the to-do on show), then the time and tokens. */
function isSpinner(line: string): boolean {
  const chars = characters(line).slice(0, 3);
  const glyph = chars[0];
  if (chars.length !== 3 || glyph === undefined || chars[1] !== " ") return false;
  if (isLetter(glyph) || isNumber(glyph) || isWhitespace(glyph)) return false;
  if (agentBullets.has(glyph) || glyph === promptMark || glyph === ruleMark || glyph === outputMark) return false;
  if (!isLetter(chars[2])) return false;
  return line.includes(ellipsis);
}

/** The past or present of a tool's work: "Ran", "Read", "Searched", "Running", "Reading"… (a word before a count that is not one of these is text: "Two of 3 tests pass"). */
function isToolVerb(word: string): boolean {
  const lower = word.toLowerCase();
  return lower.endsWith("ed") || lower.endsWith("ing") || ["ran", "read", "wrote", "found", "made"].includes(lower);
}

/**
 * Tool rows folded into one line: "Ran 5 shell commands", "Read 1 file, ran 1
 * shell command", "Searched for 2 patterns" and, in progress, "Running 1 shell
 * command…"; a "(ctrl+o to expand)" may follow.
 */
function isSummary(paragraph: readonly string[]): boolean {
  let text = paragraph.map((line) => trimBlanks(content(line))).join(" ");
  if (text.endsWith(")")) {
    const open = text.lastIndexOf("(");
    if (open >= 0) text = trimBlanks(text.slice(0, open));
  }
  if (last(text) === ellipsis) text = characters(text).slice(0, -1).join("");
  if (!isUppercase(first(text))) return false;
  return text.split(", ").every((clause) => {
    const words = clause.split(" ");
    const number = words.findIndex((word) => word !== "" && characters(word).every(isNumber));
    if (number < 1 || number > 2) return false;
    const after = words.length - number - 1;
    if (after < 1 || after > 3) return false;
    if (!isToolVerb(words[0]!)) return false;
    if (number !== 1 && !["for", "in", "on", "to"].includes(words[1]!)) return false;
    return words.every((word, index) => index === number || (word !== "" && characters(word).every(isLetter)));
  });
}

/** A tool's row: output under it ("⎿"), a call ("Bash(ls)", "Read(file)", "server - tool (MCP)(…)"), or tool rows in progress ("Running 1 shell command…"). */
function isToolRow(unit: Unit, firstParagraph: readonly string[]): boolean {
  if (unit.lines.slice(1).some((line) => first(dropSpaces(line)) === outputMark)) return true;
  const line = unit.lines[0];
  if (line === undefined) return false;
  const text = content(line);
  if (text.includes(" (MCP)(")) return true;
  const chars = characters(text);
  let name = 0;
  while (name < chars.length && (isLetter(chars[name]) || isNumber(chars[name]) || "_:.-".includes(chars[name]!))) name += 1;
  if (name > 0 && chars[name] === "(") return true;
  return isSummary(firstParagraph);
}

/** A line whose first mark is a box character (a table's bar, a border's corner or rule). */
function isDrawnInBoxes(line: string): boolean {
  return isBox(characters(line).find((c) => c !== " "));
}

function lastWord(line: string): number {
  const chars = characters(content(line));
  let n = 0;
  while (n < chars.length && chars[chars.length - 1 - n] !== " ") n += 1;
  return n;
}

/**
 * The paragraphs' lines joined back: a line the next word would have fit on
 * broke there itself (a list, a short line: kept); a line as wide as the pane
 * whose last and next words make one too long for a line broke inside a word
 * (joined as one); any other is a wrap (joined with a space). A line
 * drawn in box characters (a table's row or border) is drawn whole, never a
 * wrap, nor is the line after it: a border is one long word, and a row may be
 * as wide as the pane.
 */
function join(paragraphs: readonly (readonly string[])[], width: number, hyphens = false): string {
  const joined: string[] = [];
  for (const lines of paragraphs) {
    let text = "";
    let previous: string | null = null;
    let cut = false;
    for (const line of lines) {
      const body = content(line);
      if (previous === null) {
        text = body;
        previous = line;
        continue;
      }
      const trimmed = dropSpaces(body);
      const word = count(trimmed.split(" ")[0] ?? "");
      const before = count(previous);
      if (isDrawnInBoxes(content(previous)) || isDrawnInBoxes(body) || before + 1 + word <= width) {
        text += `\n${body}`;
      } else if (hyphens && endsInSlash(previous)) {
        // Codex also breaks after a slash inside a path ("…/notes/" / "review.md"),
        // which reads the same as a word ending in a slash and a space: the block ends at this line
        // (a prefix of the reply), never a space guessed into a path nor one taken out of prose.
        // Checked before the full-width join, which would take a real space out at the pane's width.
        cut = true;
        break;
      } else if (before >= width && lastWord(previous) + word > width - 2) {
        text += trimmed;
      } else if (hyphens && endsInHyphen(previous)) {
        // Codex breaks a line after a word's hyphen ("command-" / "connection").
        text += trimmed;
      } else {
        text += ` ${trimmed}`;
      }
      previous = line;
    }
    joined.push(text);
    if (cut) break;
  }
  return joined.join("\n\n");
}

/** A line ending in a slash after a mark (a path's "src/"): Codex may have broken it there or at a space after it. */
function endsInSlash(line: string): boolean {
  const chars = characters(line);
  return chars.at(-1) === "/" && chars.length > 1 && !isWhitespace(chars.at(-2));
}

/** A line ending in a hyphen inside a word ("grok-"): a letter or digit before it. */
function endsInHyphen(line: string): boolean {
  const chars = characters(line);
  return chars.at(-1) === "-" && (isLetter(chars.at(-2)) || isNumber(chars.at(-2)));
}

// MARK: - Codex's screen

const codexBullet = "\u{2022}"; // •
const codexPrompt = "\u{203A}"; // ›

/** A Codex block's kind by its first line: "• " Codex's (a reply, a tool or the status), "›" your message, else another row. */
function codexKind(line: string): Kind {
  const chars = characters(line).slice(0, 2);
  if (chars[0] === codexBullet && chars[1] === " ") return "agent";
  if (chars[0] === codexPrompt) return "user";
  return "other";
}

/** Codex's input box: "› " and your draft or its placeholder (an approval's "› 1. Yes, proceed" is no box). */
function isCodexBox(line: string): boolean {
  const chars = characters(line);
  if (chars[0] !== codexPrompt || (chars.length > 1 && chars[1] !== " ")) return false;
  return !/^\u{203A} \d+[.)] /u.test(line);
}

/** The first words of Codex's tool and status rows ("• Ran npm test", "• Explored", "• Working (12s • esc to interrupt)"). */
const codexRowWords = new Set([
  "Ran", "Running", "Explored", "Exploring", "Exited", "Edited", "Editing", "Waited", "Waiting", "Working", "Reviewing",
  "Worked", "Called", "Calling", "Searched", "Searching", "Read", "Reading", "Viewed", "Interrupted", "Queued",
]);
/** A file change's row: the verb, then its counts ("• Added src/a.ts (+12 -0)"). */
const codexChangeWords = new Set(["Added", "Deleted", "Updated", "Changed", "Created", "Wrote"]);

/**
 * Not a reply: Codex's status ("esc to interrupt"), a tool's row (its verb,
 * output under "└", collapsed "+ N lines", "+ Show details"), the plan, a
 * message queued under it ("↳"), a Tip, or the turn's end ("Worked for").
 */
function isCodexRow(unit: Unit): boolean {
  const head = content(unit.lines[0] ?? "");
  if (head.includes("esc to interrupt")) return true;
  const word = head.split(" ")[0] ?? "";
  if (codexRowWords.has(word) || head === "Updated Plan") return true;
  if (codexChangeWords.has(word) && /\(\+\d+ -\d+\)/.test(head)) return true;
  return unit.lines.slice(1).some((line) => {
    const text = dropSpaces(line);
    const mark = first(text);
    if (mark === "\u{2514}" || mark === "\u{21B3}" || mark === outputMark) return true;
    return /^\+ \d+ lines?\b/.test(text) || text === "+ Show details" || text.startsWith("Tip: ") || /^Worked for \d/.test(text);
  });
}

/**
 * Reads a Codex screen (the recorded frames' shape):
 *
 *     • The text Codex writes, wrapped at the pane's width, its continuation
 *       lines indented two; a word's hyphen may end a line.
 *
 *
 *     › Ask Codex to do anything              (the box: your draft, or its placeholder)
 *
 *       gpt-model xhigh · ~/project · title   (the status lines)
 *       ? for shortcuts
 *
 * The reply is the block directly above the box; nothing while a tool's row,
 * Working, an approval's review, a queued message or "Worked for" is the last
 * thing above it, nor when your message is, nor when the reply's first line is
 * above the read (its bullet cut off). A block shows only while it is written
 * (Codex commits it, then shows the next row): never `finished`.
 */
function codexBlock(lines: readonly string[]): ChatLiveBlock | null {
  const box = lastIndex(lines, lines.length, (line) => line !== "" && first(line) !== " ");
  if (box < 0 || !isCodexBox(lines[box]!)) return null;
  const width = Math.max(...lines.map(count));
  const unit = units(lines.slice(0, box), codexKind).at(-1);
  if (unit === undefined || unit.kind !== "agent" || isCodexRow(unit)) return null;
  const text = join(paragraphsOf(unit), width, true);
  if (!characters(text).some((c) => isLetter(c) || isNumber(c))) return null;
  return liveBlock(text, false, "codex");
}

// MARK: - Cursor's screen

const cursorArrow = "\u{2192}"; // →
const cursorStop = "ctrl+c to stop";

/** A line's indent: its leading spaces. */
const indentOf = (line: string): number => count(line) - count(dropSpaces(line));

/** Every run of whitespace (line breaks, a wrap's join) one space, none at either end. */
const foldSpaces = (text: string): string => text.split(/\s+/u).filter((part) => part !== "").join(" ");

/** One braille cell (U+2800 to U+28FF): Cursor's spinner draws two. */
const isBraille = (c: string | undefined): boolean => {
  if (c === undefined || Array.from(c).length !== 1) return false;
  const value = c.codePointAt(0)!;
  return value >= 0x2800 && value <= 0x28ff;
};

/** Cursor's working row: a spinner of one or two braille cells, a space, the verb ("Working", "Thinking", "Reading"), maybe its tokens. */
function isCursorSpinner(line: string): boolean {
  const indent = indentOf(line);
  if (indent > 2) return false;
  const chars = characters(line).slice(indent);
  let cells = 0;
  while (cells < 2 && isBraille(chars[cells])) cells += 1;
  if (cells === 0 || chars[cells] !== " " || !isUppercase(chars[cells + 1])) return false;
  let end = cells + 2;
  while (end < chars.length && isLetter(chars[end])) end += 1;
  return end > cells + 2 && (end === chars.length || chars[end] === " ");
}

/**
 * A row of Cursor's own between the agent's texts, indented four: a tool's
 * ("Reading plan.md" while it runs, "Read plan.md" once done; any tool verb)
 * or a Tip.
 */
function cursorRow(paragraph: readonly string[]): CursorRow {
  const head = paragraph[0];
  if (head === undefined || indentOf(head) < 4) return "text";
  const text = dropSpaces(head);
  if (text.startsWith("Tip: ")) return "row";
  const word = text.split(" ")[0] ?? "";
  // Not a word a tool row starts with (code, a lower-case name, a mark): the reply's.
  if (!isUppercase(first(word)) || !characters(word).every(isLetter)) return "text";
  const known = cursorToolVerbs.has(word.toLowerCase());
  if (!known && !isToolVerb(word)) return "text";
  const rest = characters(text).slice(count(word));
  // The word followed by an operator or a mark ("Reading = 1", "Searched: true"): code, the reply's.
  if (rest.length >= 2 && rest[0] === " " && !isLetter(rest[1]) && !isNumber(rest[1]) && !cursorTargetStarts.has(rest[1]!)) return "text";
  // A tool row: one line, a known verb, a space, then a path or target and nothing else.
  const target = rest.slice(1);
  const clean = rest[0] === " " && target.length > 0 && target.every((c) => isLetter(c) || isNumber(c) || cursorTargetMarks.has(c));
  return known && clean && paragraph.length === 1 ? "row" : "unclear";
}

/** A four-space paragraph is Cursor's tool row, the reply's text, or may be either. */
type CursorRow = "row" | "text" | "unclear";

/** Cursor's tool rows' verbs, running and done ("Reading plan.md", "Read plan.md"; the recorded ones and their kin). */
const cursorToolVerbs: ReadonlySet<string> = new Set([
  "read", "reading", "edited", "editing", "wrote", "writing", "created", "creating", "deleted", "deleting",
  "grepped", "grepping", "searched", "searching", "listed", "listing", "globbed", "globbing", "ran", "running",
  "fetched", "fetching", "thought", "thinking",
]);
/** What a tool row's target may start with besides a letter or digit (a path's). */
const cursorTargetStarts: ReadonlySet<string> = new Set([".", "/", "~", "_"]);
/** What a tool row's target holds besides letters, digits and spaces (paths, a count, "for 2s"). */
const cursorTargetMarks: ReadonlySet<string> = new Set([" ", ".", "/", "_", "-", "~", "@", "#", "%", "+", ":", ","]);

/** Lines split at blank lines. */
function blankSplit(lines: readonly string[]): string[][] {
  return paragraphsOf({ kind: "other", lines: [...lines] });
}

/**
 * Reads a Cursor screen (cursor-agent 2026.10.22, the recorded frames' shape):
 *
 *       Read plan.md here. Reply with …        (your prompt echoed, two-space indent)
 *
 *
 *       I'll read plan.md and …                (a lead-in: the store saves it as its own message)
 *
 *         Read plan.md                         (a tool row, indented four; "Reading" while it runs)
 *
 *       The reply, two-space indent, Markdown drawn without its marks: a heading
 *       a plain line, code without its fence.
 *
 *      ⠘⠣ Working  169 tokens                  (the spinner: Working, Thinking, Reading)
 *         Tip: Type ? in the prompt bar …
 *
 *
 *       → Add a follow-up        ctrl+c to stop (the box; "ctrl+c to stop" while a turn runs)
 *
 *
 *       Grok 4.7 256K Medium · 6.8%            (the footer: the model, the folder)
 *       /Users/demo/scratch
 *
 * The reply is the block below the last tool row (or Tip), else below the two
 * blank lines under your echoed prompt, and above the spinner, while "ctrl+c to
 * stop" shows at the box; nothing while only the spinner, a tool row or your
 * prompt is there, nor when the block's start is above the read (neither a tool
 * row nor that gap in it). A block shows only while it is written: never `finished`.
 */
function cursorBlock(lines: readonly string[]): ChatLiveBlock | null {
  // The box: "→ " and the placeholder or your draft; "ctrl+c to stop" at its right while a turn runs; nothing at the margin under it.
  const box = lastIndex(lines, lines.length, (line) => first(line) === " " && first(dropSpaces(line)) === cursorArrow);
  if (box < 0 || !lines[box]!.endsWith(cursorStop)) return null;
  if (lines.slice(box + 1).some((line) => line !== "" && first(line) !== " ")) return null;
  // The spinner: the last line above the box but the rows indented under it (its Tip).
  const spinner = lastIndex(lines, box, (line) => line !== "" && indentOf(line) < 4);
  if (spinner < 0 || !isCursorSpinner(lines[spinner]!)) return null;
  // The turn's part: up from the spinner to the two blank lines under your echoed prompt (seen), or to a line at the margin or the read's top (not seen).
  let start = 0;
  let seen = false;
  for (let index = spinner - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line !== "" && first(line) !== " ") {
      start = index + 1;
      break;
    }
    if (line === "" && index > 0 && lines[index - 1] === "") {
      start = index + 1;
      seen = true;
      break;
    }
  }
  const paragraphs = blankSplit(lines.slice(start, spinner));
  // The reply is below the last tool row; a paragraph below it that may be a
  // tool row or the reply's code withholds the block (its tail is never promoted to the reply).
  let row = -1;
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const kind = cursorRow(paragraphs[index]!);
    if (kind === "unclear") return null;
    if (kind === "row") {
      row = index;
      break;
    }
  }
  if (row < 0 && !seen) return null;
  const reply = paragraphs.slice(row + 1);
  if (reply.length === 0) return null;
  // Cursor wraps its text a few columns inside the box (the box 117 wide, lines up to 111 or 112 in a 119-column pane).
  const text = join(reply, count(lines[box]!) - 5);
  if (!characters(text).some((c) => isLetter(c) || isNumber(c))) return null;
  return liveBlock(text, false, "cursor");
}

/**
 * Reads a Claude Code screen (Claude Code 2.1, the fixtures' shape):
 *
 *     ⏺ The text the agent writes, wrapped at the pane's width, its
 *       continuation lines indented two.
 *
 *       Ran 5 shell commands                  (tool rows, collapsed)
 *     ⏺ Bash(ls)                              (a tool row)
 *       ⎿  output
 *
 *     ✢ Gallivanting… (3m 27s · ↓ 16.3k tokens)
 *       ⎿  Tip: …
 *
 *     ──────────────────────────────────────  (the input box)
 *     ❯
 *     ──────────────────────────────────────
 *       the status line
 */
export const ChatLiveScreen = {
  /**
   * What a live read asks for: the pane's recent lines, the shape the fixtures
   * were taken with (`--source recent --lines 80`): the box, the spinner and
   * some 60 lines of the turn above them.
   */
  readLines: 80,

  /**
   * The text the agent is writing now; null when the screen shows none (only
   * tool rows since your message, the turn over) or does not read as a working
   * Claude Code screen (no input box, no spinner).
   */
  block(screen: string, kind: string | null = null): ChatLiveBlock | null {
    const lines = screen.split("\n").map(trimmedEnd);
    // The pane's agent picks the reader, never the screen's
    // shape across kinds: Cursor's for a Cursor pane only, Codex's for Codex, Claude Code's for
    // Claude. No kind (a caller that does not know it): Claude Code's box, else Codex's, never Cursor's.
    if (kind === "cursor") return cursorBlock(lines);
    if (kind === "codex") return codexBlock(lines);
    // The input box: the last two rules; its rules are the pane's width. No such box: Codex's screen.
    // The bottom rule dashes only, the top one may carry the session's name (claude-box.ts).
    const rules = claudeBoxRules(lines);
    if (rules === null) return kind === "claude" ? null : codexBlock(lines);
    const { top, bottom } = rules;
    const width = Math.max(count(lines[top]!), count(lines[bottom]!));
    // The spinner: the last line at the margin above the box (its tips and to-dos stand indented under it).
    const spinner = lastIndex(lines, top, (line) => line !== "" && first(line) !== " ");
    if (spinner < 0 || !isSpinner(lines[spinner]!)) return null;
    let finished = false;
    for (const unit of units(lines.slice(0, spinner)).reverse()) {
      if (unit.kind !== "agent") return null;
      let paragraphs = paragraphsOf(unit);
      if (isToolRow(unit, paragraphs[0] ?? [])) {
        finished = true;
        continue;
      }
      // Collapsed tool rows ("Ran 5 shell commands") after the text.
      const summary = paragraphs.findIndex(isSummary);
      if (summary >= 0) {
        paragraphs = paragraphs.slice(0, summary);
        finished = true;
      }
      const text = join(paragraphs, width);
      if (!characters(text).some((c) => isLetter(c) || isNumber(c))) return null;
      return liveBlock(text, finished);
    }
    return null;
  },

  isRule,
  isSpinner,
  isSummary,
  join,
  isDrawnInBoxes,
  codexBlock,
  cursorBlock,
  isCursorSpinner,
};

// MARK: - The live row

/**
 * How a text was read for a key: the match says which readings agree,
 * and only `written` on both sides ends the row against an old text.
 * - written: the screen as drawn; the transcript as written (its fences as the screen draws code: gone, or their language).
 * - bullet: a list's bullet with its ASCII mark (a glyph as the bullet mark), no quote marks, no list numbers.
 * - glyph: the transcript's list drawn with a glyph.
 * - removed: the transcript's list drawn with no mark.
 * - labelled: the screen's bullets above a language label, as drawn from it down.
 * - across: the screen's table, its cells read across the lines they wrap onto.
 * - table: a table identified whole on both sides (on screen: closed by a
 *   bottom border, each row the lines between two rules), its cells and rows
 *   reflowed, the text around it as written. It meets only itself, whole, and
 *   counts as written.
 */
export type LiveReading = "written" | "bullet" | "glyph" | "removed" | "labelled" | "across" | "table";

/** A key and how it was read. */
export interface LiveKey {
  readonly reading: LiveReading;
  readonly text: string;
}

/** A screen reading and a transcript reading whose keys agree. */
export interface LivePair {
  readonly screen: LiveReading;
  readonly markdown: LiveReading;
}

/**
 * Which readings of a block on screen and of a transcript text agree, and so
 * what the text may do to the live row: the one place the rule above
 * (`LiveReading`: only `written` on both sides ends the row against an old
 * text) is kept.
 */
export class ChatLiveMatch {
  private readonly found = new Map<string, LivePair>();

  constructor(pairs: readonly LivePair[] = []) {
    for (const pair of pairs) this.insert(pair);
  }

  insert(pair: LivePair): void {
    this.found.set(`${pair.screen}|${pair.markdown}`, pair);
  }

  get pairs(): LivePair[] {
    return [...this.found.values()];
  }

  has(screen: LiveReading, markdown: LiveReading): boolean {
    return this.found.has(`${screen}|${markdown}`);
  }

  /** The screen as drawn agrees with the text as written (or a whole table on screen, reflowed, with the text's whole table). */
  get asWritten(): boolean {
    return this.has("written", "written") || this.has("table", "table");
  }

  /**
   * The turn's last text explains the block on screen,
   * its list as the screen draws it, so no row starts for it: as written; or
   * with each list mark, quote mark and list number in its place on both
   * sides, the screen's own mark or the glyph the screen draws for the text's
   * (a list renumbered, a dash list drawn with bullets). A reading that takes
   * a mark off ("removed"), code under a label and a table read across
   * explain nothing; another ASCII mark, an operator and code keep their own
   * codes, so they never meet.
   */
  get explainsList(): boolean {
    return this.asWritten || this.has("bullet", "bullet") || this.has("written", "glyph") || this.has("bullet", "glyph");
  }

  /**
   * Whether the text ends the row: an old text (there before the row: the
   * turn's last text when the block first showed, or the block shown before,
   * landing late) only as written; its own new text by any reading.
   */
  ends(text: "old" | "own"): boolean {
    return text === "old" ? this.asWritten : this.found.size > 0;
  }
}

/**
 * How a line's leading mark reads.
 * - bullet: a list's bullet: its ASCII mark's own code; a bullet glyph is the
 *   bullet mark; a quote mark and a list number their own codes.
 * - glyph: a list's bullet drawn as a glyph (any mark written): the bullet mark
 *   alone; quote marks left out; a list number its code; the transcript's prose only.
 * - removed: a list's bullet and quote marks left out; a list number its code;
 *   the transcript's prose only.
 * - written: as written: code, where `+ - *` are operators and a quote mark or a
 *   number is code too. Only a bullet glyph (never an operator) is the bullet mark.
 */
export type LiveMarks = "bullet" | "glyph" | "removed" | "written";

/** A list item's glyph in keys: it meets only another list item's. */
const bulletMark = "\u{2022}";
/** A list item's ASCII mark in keys, one code each (private use): it meets only the same mark. */
const markCode: Readonly<Record<string, string>> = { "-": "\u{E02D}", "*": "\u{E02A}", "+": "\u{E02B}" };
/** A quote mark and a list number in keys (private use). */
const quoteCode = "\u{E03E}";
const numberCode = "\u{E023}";
/** A table's cell and row boundaries in keys (private use). */
const cellCode = "\u{E07C}";
const rowCode = "\u{E00A}";
const markCodes = new Set([...Object.values(markCode), quoteCode, numberCode, cellCode, rowCode]);

/** Kept besides letters and digits: what changes what a text says and drawing never changes. */
const operators = new Set(["<", ">", "=", "!", "+", "-", "*", "/"]);
/** Kept between two digits: 1.5, 1,000, 10:30. */
const separators = new Set([".", ",", ":"]);

/** A list item's mark as markdown writes it (and the screen may draw it): in code, an operator. */
const writtenBullets = new Set(["-", "*", "+"]);
/** A list item's mark only the drawing makes: never an operator. */
const glyphBullets = new Set(["\u{2022}", "\u{25E6}", "\u{25AA}", "\u{2023}", "\u{00B7}"]);

/** A border's rules and its bottom corners. */
const horizontals = new Set(["\u{2500}", "\u{2501}", "\u{2550}"]);
const bottomCorners = new Set(["\u{2514}", "\u{2518}", "\u{2570}", "\u{256F}", "\u{255A}", "\u{255D}", "\u{2517}", "\u{251B}"]);
/** A table's bars and borders on screen. */
const tableBars = new Set(["\u{2502}", "\u{2503}", "|", "\u{251C}", "\u{2524}", "\u{253C}", "\u{250C}", "\u{2510}", "\u{2514}", "\u{2518}", "\u{252C}", "\u{2534}"]);

/** A rule, a border or an alignment row: its characters only. */
const isRuleCharacter = (c: string): boolean => "-=_*|:+".includes(c) || isBox(c);

const sameKey = (a: LiveKey, b: LiveKey): boolean => a.reading === b.reading && a.text === b.text;
function addKey(keys: LiveKey[], key: LiveKey): void {
  if (!keys.some((kept) => sameKey(kept, key))) keys.push(key);
}

/**
 * The live row: the block on screen until the transcript has it.
 *
 * The row is the block being written now,
 * and only its own transcript text retires it.
 * - It starts when its block first shows still being written (one seen first
 *   already done, a tool after it, is the transcript's by now and never shows)
 *   and the chat has read its transcript to the end (`caughtUp`). The last
 *   turn's items then are its baseline: none of them ever retires it, and a
 *   block that is already that turn's last text never shows.
 * - It goes when a text of that turn after the baseline is the same block
 *   (`same`): one normalized text holds the other whole or, both longer than
 *   `span`, the other's first `span` characters. The normalizing takes
 *   out only what drawing changes; operators and the separators between digits
 *   stay. Code keeps its leading operators; a leading `+ - *` on screen
 *   reads both ways and counts only where the transcript reads the same.
 *   A bullet read off an ASCII mark keeps that character. Against a text
 *   that was there before the row only the screen as drawn against the text as
 *   written counts (`ChatLiveMatch.ends`); no reading lets a text's own
 *   characters take a mark's place. A mark the screen's reading takes off
 *   proves the row's own text only where that text has the same mark there; a
 *   whole table on both sides, reflowed, counts as written.
 * - The block before it on screen may land after it started (the feed reads
 *   once a second). A new text that matches that block is that block's,
 *   and never retires this one, unless it holds this block's text whole where
 *   the block before does not. When it is not sure, the row stays: a missing
 *   answer is worse than a brief duplicate.
 * - The screen showing the block ended (tool rows after it) changes nothing: a
 *   different new text never retires it.
 * - The turn's end clears it: the transcript has the turn over (the app also
 *   lets it go once the pane stops working).
 *
 * Swift's is a value; this one changes in place (`update`), `clone` copies it.
 */
export class ChatLiveMerge {
  /** Both texts longer than this: their first `span` characters decide. */
  static readonly span = 160;
  /** The texts since the baseline it is compared with, newest first. */
  static readonly recentTexts = 6;
  /** Every reading, as Swift's enum lists them. */
  static readonly readings: readonly LiveReading[] = ["written", "bullet", "glyph", "removed", "labelled", "across", "table"];

  /** The block on screen (null: none). */
  private shown: ChatLiveBlock | null = null;
  /** The last turn when the block first showed, its items then, and whether it was over then. */
  private baseTurn: string | null = null;
  private baseItems = new Set<string>();
  private baseTurnFinished = false;
  /** The block on screen before this one (its keys), and the last block shown. */
  private previous: LiveKey[] = [];
  private lastText: string | null = null;

  get block(): ChatLiveBlock | null {
    return this.shown;
  }

  clone(): ChatLiveMerge {
    const copy = new ChatLiveMerge();
    copy.shown = this.shown;
    copy.baseTurn = this.baseTurn;
    copy.baseItems = new Set(this.baseItems);
    copy.baseTurnFinished = this.baseTurnFinished;
    copy.previous = [...this.previous];
    copy.lastText = this.lastText;
    return copy;
  }

  /** Swift's Equatable. */
  equals(other: ChatLiveMerge): boolean {
    return (
      this.shown?.text === other.shown?.text &&
      this.shown?.finished === other.shown?.finished &&
      this.shown?.drawing === other.shown?.drawing &&
      this.baseTurn === other.baseTurn &&
      this.baseTurnFinished === other.baseTurnFinished &&
      this.lastText === other.lastText &&
      this.baseItems.size === other.baseItems.size &&
      [...this.baseItems].every((id) => other.baseItems.has(id)) &&
      this.previous.length === other.previous.length &&
      this.previous.every((key, index) => sameKey(key, other.previous[index]!))
    );
  }

  /**
   * The screen read now (null: no block). `caughtUp`: the chat has read its
   * transcript to the end (the feed's update says so); a new block's row waits for it.
   */
  update(read: ChatLiveBlock | null, timeline: ChatTimeline, caughtUp = true): void {
    // Your words never show as Cursor's reply.
    const screen = read !== null && read.drawing === "cursor" ? ChatLiveMerge.cursorFenced(read, timeline.turns.at(-1) ?? null) : read;
    if (screen === null) {
      this.shown = null;
      return;
    }
    const block = this.shown;
    if (block !== null) {
      const before = ChatLiveMerge.key(block.text);
      const now = ChatLiveMerge.key(screen.text);
      // The same block, written on (or ended: tool rows after it). A block shown ended does not grow: more text is the next block.
      if (before !== "" && hasPrefix(now, before) && (!block.finished || now === before)) {
        this.shown = screen;
        this.lastText = screen.text;
        return;
      }
    }
    const turn = timeline.turns.at(-1) ?? null;
    if (screen.finished || !caughtUp || ChatLiveMerge.isLastText(screen.text, turn, screen.drawing) || ChatLiveMerge.cursorWaits(screen, turn)) {
      this.shown = null;
      return;
    }
    this.previous = this.lastText === null ? [] : ChatLiveMerge.screenKeys(this.lastText);
    this.shown = screen;
    this.lastText = screen.text;
    this.baseTurn = turn?.id ?? null;
    this.baseItems = new Set(turn?.items.map((item) => item.value.id) ?? []);
    this.baseTurnFinished = turn?.isFinished ?? false;
  }

  /** The live row's text over this timeline (null: none). */
  row(timeline: ChatTimeline): string | null {
    const block = this.shown;
    if (block === null || ChatLiveMerge.key(block.text) === "") return null;
    const turn = timeline.turns.at(-1);
    if (turn === undefined) return block.text;
    // The turn over since the row started: it goes.
    if (turn.isFinished && (turn.id !== this.baseTurn || !this.baseTurnFinished)) return null;
    const screen = ChatLiveMerge.screenKeys(block.text);
    for (const text of this.newTexts(turn)) {
      const markdown = ChatLiveMerge.markdownKeys(text.markdown, block.drawing);
      if (!ChatLiveMerge.match(screen, markdown, ChatLiveMerge.matches).ends("own")) continue;
      // The block before it, landed late, is not this one's, unless, as written, it holds this block whole.
      if (ChatLiveMerge.same(this.previous, markdown) && !ChatLiveMerge.proves(screen, markdown, this.previous).ends("old")) continue;
      return null;
    }
    return block.text;
  }

  /**
   * The turn's texts after its baseline, newest first: in the baseline turn,
   * those after its last item then (earlier history loaded in front never
   * counts); in a turn since, all of them.
   */
  newTexts(turn: ChatTurn): ChatAgentText[] {
    const texts: ChatAgentText[] = [];
    for (let index = turn.items.length - 1; index >= 0; index -= 1) {
      const item = turn.items[index]!;
      if (turn.id === this.baseTurn && this.baseItems.has(item.value.id)) break;
      if (item.type !== "agentText" && item.type !== "progress") continue;
      texts.push(item.value);
      if (texts.length === ChatLiveMerge.recentTexts) break;
    }
    return texts;
  }

  /**
   * The block is already the turn's last item: its text, the same whole (or, a
   * long block, as far as the screen has it). That text was there first,
   * so only as written, or its list as the screen draws it, every mark in its
   * place (`ChatLiveMatch.explainsList`). Only a row's start asks this: what
   * ends a row is unchanged. The text is read as `drawing`'s screen draws it.
   */
  static isLastText(text: string, turn: ChatTurn | null, drawing: LiveDrawing = "claude"): boolean {
    const item = turn?.items.at(-1);
    if (item === undefined || (item.type !== "agentText" && item.type !== "progress")) return false;
    return ChatLiveMerge.match(ChatLiveMerge.screenKeys(text), ChatLiveMerge.markdownKeys(item.value.markdown, drawing), (shown, markdown) => {
      return shown === markdown || (count(shown) > ChatLiveMerge.span && hasPrefix(markdown, shown));
    }).explainsList;
  }

  /**
   * A block on Cursor's screen starts no row (it waits) over a finished turn
   * (Cursor's turn ends with its last message, the reply: a block first seen
   * then is that reply, or the next turn's before your message has landed),
   * nor when your own words in the turn hold it (your prompt echoed, however
   * the screen was cut). This applies to Cursor's screen only.
   */
  static cursorWaits(screen: ChatLiveBlock, turn: ChatTurn | null): boolean {
    if (screen.drawing !== "cursor" || turn === null) return false;
    if (turn.isFinished) return true;
    const shown = ChatLiveMerge.key(screen.text);
    return turn.items.some((item) => item.type === "user" && ChatLiveMerge.key(item.value.text).includes(shown));
  }

  /** Your prompt's key characters from which the candidate holding it anywhere withholds it. */
  static readonly echoAnywhere = 8;

  /**
   * A Cursor candidate fenced against your prompt in the turn, never cut.
   * Cursor draws your echoed prompt as it draws its reply (two-space indent), so
   * a read whose gap under the echo is not the recorded two blank lines can hold
   * your prompt joined to the reply (a wrap joins them into one line). With
   * whitespace folded (line breaks and wraps one space): a candidate that starts
   * with your prompt, or holds it anywhere when it has `echoAnywhere` or more key
   * characters, is withheld whole (null: no row; the store's message shows
   * when it lands); else it shows whole. A hidden row is fine; wrong text is not.
   */
  static cursorFenced(screen: ChatLiveBlock, turn: ChatTurn | null): ChatLiveBlock | null {
    if (turn === null) return screen;
    const shown = foldSpaces(screen.text);
    for (const item of turn.items) {
      if (item.type !== "user") continue;
      const prompt = foldSpaces(item.value.text);
      if (prompt === "") continue;
      if (shown.startsWith(prompt)) return null;
      if (count(ChatLiveMerge.key(prompt)) >= ChatLiveMerge.echoAnywhere && shown.includes(prompt)) return null;
    }
    return screen;
  }

  // MARK: the same block

  /** The readings of a screen text and a transcript text that agree (`agree`: a screen key, a transcript key). */
  static match(screen: readonly LiveKey[], markdown: readonly LiveKey[], agree: (shown: string, markdown: string) => boolean): ChatLiveMatch {
    const found = new ChatLiveMatch();
    for (const shown of screen) {
      for (const text of markdown) {
        // A whole table meets only a whole table, all of it.
        const tables = shown.reading === "table" || text.reading === "table";
        if (!agree(shown.text, text.text)) continue;
        if (tables && !(shown.reading === text.reading && shown.text === text.text)) continue;
        found.insert({ screen: shown.reading, markdown: text.reading });
      }
    }
    return found;
  }

  /** One screen key and one transcript key match, by any reading. */
  static same(screen: readonly LiveKey[], markdown: readonly LiveKey[]): boolean {
    return ChatLiveMerge.match(screen, markdown, ChatLiveMerge.matches).ends("own");
  }

  /**
   * The readings by which the transcript's text holds this block's screen text
   * whole, from its start, where the block before does not (by any of its
   * readings): it is this block's.
   */
  static proves(screen: readonly LiveKey[], markdown: readonly LiveKey[], previous: readonly LiveKey[]): ChatLiveMatch {
    return ChatLiveMerge.match(screen, markdown, (shown, text) => hasPrefix(text, shown) && !previous.some((key) => hasPrefix(key.text, shown)));
  }

  /**
   * One holds the other whole from its start; both longer than `span`, their
   * first `span` characters are the same. From its start, never from
   * inside it: a block and its text begin together.
   */
  static matches(this: void, a: string, b: string): boolean {
    if (a === "" || b === "") return false;
    const ca = characters(a);
    const cb = characters(b);
    const span = ChatLiveMerge.span;
    if (ca.length <= span || cb.length <= span) return ca.length <= cb.length ? hasPrefix(b, a) : hasPrefix(a, b);
    return ca.slice(0, span).join("") === cb.slice(0, span).join("");
  }

  // MARK: keys

  /**
   * Letters and digits, lowercased, with the operators, the bullet mark, the
   * ASCII marks' codes and the separators between digits; whitespace, wraps and
   * other marks drop out.
   */
  static key(text: string): string {
    const chars = characters(text.toLowerCase());
    let key = "";
    chars.forEach((c, index) => {
      if (isLetter(c) || isNumber(c) || operators.has(c) || c === bulletMark || markCodes.has(c)) {
        key += c;
      } else if (separators.has(c) && index > 0 && index + 1 < chars.length && isNumber(chars[index - 1]) && isNumber(chars[index + 1])) {
        key += c;
      }
    });
    return key;
  }

  /**
   * A line as the drawing leaves it, on either side: its leading mark read as
   * `marks` says, and (but as written) no quote mark or list number at its
   * start; null for a rule, a border or an alignment row.
   */
  static drawn(line: string, marks: LiveMarks): string | null {
    const parts = ChatLiveMerge.drawnParts(line, marks);
    return parts === null ? null : parts.lead + parts.body;
  }

  /**
   * A line as `marks` reads it, its body drawn as prose (the transcript's,
   * outside code) or as it is (the screen's). A reading that takes a mark
   * off never leaves the line starting as a mark does; that line reads as written.
   */
  static read(line: string, marks: LiveMarks, drawsProse: boolean, links = false): string | null {
    const parts = ChatLiveMerge.drawnParts(line, marks);
    if (parts === null) return null;
    const body = drawsProse ? ChatLiveMerge.prose(parts.body, links) : parts.body;
    if (parts.tookOff && ChatLiveMerge.startsAsAMark(body)) return ChatLiveMerge.read(line, "written", drawsProse, links);
    return parts.lead + body;
  }

  /**
   * `drawn` in two: the leading marks as they read (codes for `bullet`'s quote
   * marks and list mark, the bullet mark for a glyph, the number's code for a
   * list number; "" for none) and the rest; `tookOff`: a mark came off and none
   * stands for it. The lead is never prose, and no
   * screen reading takes a mark off with nothing in its place.
   */
  static drawnParts(line: string, marks: LiveMarks): { lead: string; body: string; tookOff: boolean } | null {
    let body = dropWhile(line, (c) => c === " " || c === "\t");
    if (body === "") return { lead: "", body, tookOff: false };
    if (characters(body).every((c) => isRuleCharacter(c) || c === " ")) return null;
    const isMark = (set: Set<string>): boolean => {
      const mark = first(body);
      if (mark === undefined || !set.has(mark)) return false;
      const next = second(body);
      return next === undefined || next === " ";
    };
    if (marks === "written") {
      if (!isMark(glyphBullets)) return { lead: "", body, tookOff: false };
      return { lead: `${bulletMark} `, body: dropSpaces(dropFirst(body)), tookOff: false };
    }
    let lead = "";
    let tookOff = false;
    while (first(body) === ">" && (second(body) === undefined || second(body) === " ")) {
      body = dropSpaces(dropFirst(body));
      if (marks === "bullet") lead += quoteCode;
      else tookOff = true;
    }
    const mark = first(body);
    if (mark !== undefined && (isMark(writtenBullets) || isMark(glyphBullets))) {
      body = dropSpaces(dropFirst(body));
      if (marks === "bullet" && !glyphBullets.has(mark)) lead += markCode[mark] ?? bulletMark;
      else if (marks === "removed") tookOff = true;
      else lead += bulletMark;
    }
    const rest = ChatLiveMerge.unnumbered(body);
    if (count(rest) !== count(body)) {
      lead += numberCode;
      body = rest;
    }
    return { lead: lead === "" ? "" : `${lead} `, body, tookOff };
  }

  /** What reads as a mark at a line's start: a list's mark or a quote mark (a space or nothing after it), or a list number. */
  static startsAsAMark(text: string): boolean {
    const body = dropWhile(text, (c) => c === " " || c === "\t");
    const mark = first(body);
    if (mark === undefined) return false;
    if (writtenBullets.has(mark) || glyphBullets.has(mark) || mark === ">") {
      const next = second(body);
      return next === undefined || next === " ";
    }
    return count(ChatLiveMerge.unnumbered(body)) !== count(body);
  }

  /** A line that may be code's language label as the screen draws it ("diff", "swift", "c++"). */
  static isLanguageLabel(line: string): boolean {
    const body = characters(dropSpaces(line));
    const mark = body[0];
    if (mark === undefined || !isASCII(mark) || !isLetter(mark) || body.length > 24) return false;
    return body.every((c) => isASCII(c) && (isLetter(c) || isNumber(c) || "_+#.-".includes(c)));
  }

  /**
   * The screen's text as keys: each way its leading marks may read (as drawn; a
   * list's bullets; as drawn from a language label down, the code under it),
   * and with a table's cells read across the lines they wrap onto (a table row
   * between its border lines), when it has a table. Each key says how it was read.
   */
  static screenKeys(text: string): LiveKey[] {
    const lines = text.split("\n");
    const readAll = (from: readonly string[], marks: LiveMarks): string[] =>
      from.flatMap((line) => {
        const drawn = ChatLiveMerge.read(line, marks, false);
        return drawn === null ? [] : [drawn];
      });
    const readings: [LiveReading, string[]][] = [
      ["written", readAll(lines, "written")],
      ["bullet", readAll(lines, "bullet")],
    ];
    const label = lines.findIndex((line) => ChatLiveMerge.isLanguageLabel(line));
    if (label > 0) readings.push(["labelled", [...readAll(lines.slice(0, label), "bullet"), ...readAll(lines.slice(label), "written")]]);
    const keys: LiveKey[] = [];
    for (const [reading, drawn] of readings) addKey(keys, { reading, text: ChatLiveMerge.key(drawn.join("\n")) });
    const shown: string[] = [];
    let row: string[][] = [];
    let hasTable = false;
    const endRow = (): void => {
      if (row.length === 0) return;
      const columns = Math.max(...row.map((cells) => cells.length));
      const cells: string[] = [];
      for (let column = 0; column < columns; column += 1) cells.push(row.map((each) => (column < each.length ? each[column]! : "")).join(""));
      shown.push(cells.join(" "));
      row = [];
    };
    for (const line of lines) {
      const trimmed = dropSpaces(line);
      const mark = first(trimmed);
      if (mark !== undefined && tableBars.has(mark)) {
        hasTable = true;
        if (characters(trimmed).every((c) => isRuleCharacter(c) || c === " ")) {
          endRow();
          continue;
        }
        row.push(splitWhere(trimmed, (c) => tableBars.has(c)).slice(1));
      } else {
        endRow();
        const drawn = ChatLiveMerge.read(line, "bullet", false);
        if (drawn !== null) shown.push(drawn);
      }
    }
    endRow();
    if (hasTable) {
      addKey(keys, { reading: "across", text: ChatLiveMerge.key(shown.join("\n")) });
      const table = ChatLiveMerge.wholeTables(lines);
      if (table !== null) keys.push({ reading: "table", text: ChatLiveMerge.key(table) });
    }
    return keys;
  }

  /**
   * The screen's text with each table reflowed whole and the rest as
   * drawn; null unless every table on it is identified whole (closed by a
   * bottom border; each row the lines between two rules, every line of a row
   * with the same cells and its closing bar).
   */
  static wholeTables(lines: readonly string[]): string | null {
    const isTable = (line: string): boolean => {
      const mark = characters(line).find((c) => c !== " ");
      return mark !== undefined && tableBars.has(mark);
    };
    const shown: string[] = [];
    let tables = 0;
    let index = 0;
    while (index < lines.length) {
      if (!isTable(lines[index]!)) {
        const line = ChatLiveMerge.read(lines[index]!, "written", false);
        if (line !== null) shown.push(line);
        index += 1;
        continue;
      }
      let end = index;
      while (end < lines.length && isTable(lines[end]!)) end += 1;
      const table = reflowed(lines.slice(index, end));
      if (table === null) return null;
      shown.push(table);
      tables += 1;
      index = end;
    }
    return tables > 0 ? shown.join("\n") : null;
  }

  /**
   * A markdown text's keys as the screen may show it: no fence lines, and fence
   * lines as their language (the screen may label the code); as written (its
   * list's marks as the characters written), and its list's bullets drawn
   * with the mark written, as a glyph, and unmarked. Code is kept as
   * written, its leading `+ - *` and all; outside it the marks drawing takes
   * away go (`prose`, which keeps inline code as written). Each key says how it was read.
   * For Codex's screen, also with each link as Codex draws it,
   * "label (target)" (Claude Code draws the label alone).
   */
  static markdownKeys(markdown: string, drawing: LiveDrawing = "claude"): LiveKey[] {
    const lines = markdown.split("\n");
    const keys: LiveKey[] = [];
    for (const marks of ["written", "bullet", "glyph", "removed"] as const) {
      // How Cursor draws a link is not recorded: both ways, as Codex's.
      for (const links of drawing === "claude" ? [false] : [false, true]) {
        let bare = "";
        let labelled = "";
        let fenced = false;
        for (const line of lines) {
          const trimmed = dropSpaces(line);
          if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
            if (!fenced) labelled += `${dropWhile(trimmed, (c) => c === "`" || c === "~")}\n`;
            fenced = !fenced;
            continue;
          }
          const shown = fenced ? ChatLiveMerge.drawn(line, "written") : ChatLiveMerge.read(line, marks, true, links);
          if (shown === null) continue;
          bare += `${shown}\n`;
          labelled += `${shown}\n`;
        }
        for (const text of [ChatLiveMerge.key(bare), ChatLiveMerge.key(labelled)]) addKey(keys, { reading: marks, text });
      }
    }
    for (const text of ChatLiveMerge.wholeMarkdownTables(lines)) addKey(keys, { reading: "table", text: ChatLiveMerge.key(text) });
    return keys;
  }

  /**
   * The text as written with each pipe table reflowed whole (a header
   * line, its alignment row, its rows), without its fence lines and with them
   * as their language; none when it has no table. (Swift's `wholeTables(markdown:)`.)
   */
  static wholeMarkdownTables(lines: readonly string[]): string[] {
    const bare: string[] = [];
    const labelled: string[] = [];
    let fenced = false;
    let tables = 0;
    let index = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      const trimmed = dropSpaces(line);
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        if (!fenced) labelled.push(dropWhile(trimmed, (c) => c === "`" || c === "~"));
        fenced = !fenced;
        index += 1;
        continue;
      }
      const table = fenced ? null : pipeTable(lines, index);
      if (table !== null) {
        bare.push(table.text);
        labelled.push(table.text);
        tables += 1;
        index = table.end;
        continue;
      }
      const shown = fenced ? ChatLiveMerge.drawn(line, "written") : ChatLiveMerge.read(line, "written", true);
      if (shown !== null) {
        bare.push(shown);
        labelled.push(shown);
      }
      index += 1;
    }
    return tables > 0 ? [bare.join("\n"), labelled.join("\n")] : [];
  }

  /**
   * A markdown line outside code as the screen draws it: inline code as written
   * (its backticks gone); emphasis stars, an image's `!`, link targets, an
   * autolink's brackets and escapes' backslashes gone. A star with a space on
   * each side is a star. With `links`, a link's target kept as
   * Codex draws it, after its label: "label (target)".
   */
  static prose(line: string, links = false): string {
    const chars = characters(line);
    let shown = "";
    let index = 0;
    let codeRun = 0;
    const run = (mark: string, start: number): number => {
      let end = start;
      while (end < chars.length && chars[end] === mark) end += 1;
      return end - start;
    };
    while (index < chars.length) {
      const c = chars[index]!;
      const next = chars[index + 1];
      if (c === "`") {
        const length = run("`", index);
        if (codeRun === 0) codeRun = length;
        else if (length === codeRun) codeRun = 0;
        index += length;
        continue;
      }
      if (codeRun > 0) {
        shown += c;
        index += 1;
        continue;
      }
      if (c === "\\") {
        if (next !== undefined && (isPunctuation(next) || isSymbol(next))) {
          shown += next;
          index += 2;
        } else {
          index += 1;
        }
      } else if (c === "!" && next === "[") {
        index += 1;
      } else if (c === "]" && next === "(") {
        const close = chars.indexOf(")", index + 2);
        if (links && close >= 0) shown += ` (${chars.slice(index + 2, close).join("")})`;
        index = close >= 0 ? close + 1 : index + 1;
      } else if (c === "<") {
        const rest = chars.slice(index + 1).join("");
        const close = chars.indexOf(">", index + 1);
        if (["http://", "https://", "mailto:", "ftp://"].some((scheme) => rest.startsWith(scheme)) && close >= 0 && !chars.slice(index + 1, close).includes(" ")) {
          shown += chars.slice(index + 1, close).join("");
          index = close + 1;
        } else {
          shown += c;
          index += 1;
        }
      } else if (c === "*") {
        const length = run("*", index);
        const before = index > 0 ? chars[index - 1]! : " ";
        const after = index + length < chars.length ? chars[index + length]! : " ";
        if (isWhitespace(before) && isWhitespace(after)) shown += "*".repeat(length);
        index += length;
      } else {
        shown += c;
        index += 1;
      }
    }
    return shown;
  }

  /** A line without its list number ("1. ", "2) "): the screen numbers a list as it draws it. */
  static unnumbered(line: string): string {
    const body = characters(dropSpaces(line));
    let digits = 0;
    while (digits < body.length && isASCII(body[digits]!) && isNumber(body[digits])) digits += 1;
    if (digits < 1 || digits > 3) return line;
    const mark = body[digits];
    if ((mark !== "." && mark !== ")") || body[digits + 1] !== " ") return line;
    return body.slice(digits + 2).join("");
  }
}

/** One table on screen, its cells and rows reflowed; null unless it is whole. */
function reflowed(lines: readonly string[]): string | null {
  const isTableRule = (line: string): boolean => {
    const chars = characters(line);
    return chars.every((c) => c === " " || isBox(c)) && chars.some((c) => horizontals.has(c));
  };
  const closing = lines.at(-1);
  if (closing === undefined || !isTableRule(closing) || !characters(closing).some((c) => bottomCorners.has(c))) return null;
  const rows: string[] = [];
  let row: string[][] = [];
  const endRow = (): boolean => {
    const columns = row[0]?.length;
    if (columns === undefined) return true;
    if (!row.every((cells) => cells.length === columns)) return false;
    const cells: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      cells.push(
        row
          .map((each) => trimBlanks(each[column]!))
          .filter((cell) => cell !== "")
          .join(" "),
      );
    }
    rows.push(cells.join(cellCode));
    row = [];
    return true;
  };
  for (const line of lines) {
    const drawn = trimBlanks(line);
    if (isTableRule(drawn)) {
      if (!endRow()) return null;
      continue;
    }
    const close = last(drawn);
    if (close === undefined || !tableBars.has(close)) return null;
    const cells = splitWhere(drawn, (c) => tableBars.has(c));
    if (cells.length < 3) return null;
    row.push(cells.slice(1, -1));
  }
  if (!endRow() || rows.length === 0) return null;
  return rows.join(rowCode);
}

/**
 * The pipe table starting at `start` (its header line, then its alignment
 * row), its cells and rows reflowed as `reflowed` does a screen's, every cell
 * drawn as prose; and the line after it.
 */
function pipeTable(lines: readonly string[], start: number): { text: string; end: number } | null {
  const isRow = (line: string): boolean => first(dropSpaces(line)) === "|";
  const isAlignment = (line: string): boolean => isRow(line) && line.includes("-") && characters(line).every((c) => "|-: ".includes(c));
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let cell = "";
    let escaped = false;
    for (const c of characters(dropFirst(dropSpaces(line)))) {
      if (c === "|" && !escaped) {
        out.push(cell);
        cell = "";
      } else {
        cell += c;
      }
      escaped = c === "\\" && !escaped;
    }
    if (!characters(cell).every((c) => c === " ")) out.push(cell);
    return out.map((each) => trimBlanks(ChatLiveMerge.prose(trimBlanks(each))));
  };
  if (start + 1 >= lines.length || !isRow(lines[start]!) || !isAlignment(lines[start + 1]!)) return null;
  const header = cells(lines[start]!);
  const rows = [header];
  let end = start + 2;
  while (end < lines.length && isRow(lines[end]!)) {
    rows.push(cells(lines[end]!));
    end += 1;
  }
  const text = rows.map((row) => header.map((_, index) => row[index] ?? "").join(cellCode)).join(rowCode);
  return { text, end };
}
