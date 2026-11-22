// The one rule for "the same question" (the Swift twin: HerdrKit's
// PromptWords, line by line). An answer
// is bound to the question's words, not to how its rows wrap: when the pane is
// drawn at another width (the Terminal tab opened, a split, a window resized),
// the same question wraps differently, and it is still the same question.
//
// A row's end is decided, never guessed. Each reader that knows its own frame
// turns each part of its reading (the question, the body, the options) into
// the one text it stands for (`partText`, kept in the fingerprint's `words`).
// What a row's end stands for is found from what the agent's wrapper can draw
// there (`WrapStyle`) and where the frame's edge can be (`WrapFrame`):
// - nothing, where the agent cut a word at the edge (the row reaches it);
// - one blank, where the agent wrapped at a blank (the row ends short of the
//   edge, or the blank went to the next row's start);
// - a line break, where no wrap could have drawn the rows (the next row's
//   first word would have fit) and the part's own text may break (`lines`:
//   a command, a description, the parameters), and always between two items
//   the reader knows (a header and a command, two diff lines, two options).
//   A line break where a wrap could also have broken reads as that wrap: the
//   rule reads a row's end by where it ends.
// When wraps of two kinds could have drawn the same rows (the edge not known
// closely enough, a row exactly full, a wide character at the edge), that row's
// end is not guessed: the part has no text (null: never a string
// with a separator, which a screen could hold itself), and it is compared by
// its rows as drawn, so it equals only a reading of the same rows. A reader
// may settle such a section with what else its screen shows (`settle`), only
// where exactly one of the section's possible texts agrees with it. None does
// here: Codex's option quotes a prefix built from its own token list,
// which the command's characters cannot prove.
// What the rows cannot show stays as read: a row that
// ends where the agent wrapped at a blank reads as one blank, whether the
// source had one blank, several, or a line break there; a line break or blanks
// a reading does show (another width) are another question against it.
// Two readings are one question when each part's texts are equal UTF-16 unit
// for unit (`sameRows` where a reading has no text: each row's end blanks
// off, rows of nothing but blanks left out, every other character as drawn). Rows of
// nothing but blanks inside a part read as one line break; at its edges, as
// nothing. A blank is U+0020 only; any other character (a no-break space, a
// tab, a box edge, a mark) counts as itself.

const blank = 0x20;

/** At most this many possible texts of one section are tried against a reader's `settle` (two row ends a cut or a blank each: four). */
const settleLimit = 16;

/** How the agent wraps a part's rows. */
export type WrapStyle =
  /**
   * Claude Code (Ink: wrap-ansi with `trim: false, hard: true`): breaks at blanks, the blank kept at the row's end
   * (Herdr's read trims it) or, when the word before it fills the row exactly, moved to the next row's start; a word
   * longer than a row is cut at the edge.
   */
  | "ink"
  /** Codex (textwrap with Unicode line breaking): breaks at blanks (the blank dropped) and after `-`, `/` and the like without one; a word longer than a row is cut. */
  | "textwrap"
  /** A word wrapper whose blank at a break is dropped or moved (agy's choices): breaks at blanks; a word longer than a row is cut. */
  | "words"
  /** Either cut at the edge whatever the character, or Ink's (agy's command, file and trust rows). */
  | "either";

/** What a reader knows of its frame. */
export interface WrapFrame {
  /** How the agent wraps the part (a section may wrap its own way: `WrapSection.style`). */
  readonly style: WrapStyle;
  /** The narrowest the frame's right edge can be, in cells (a row the agent drew is never past it). */
  readonly low: number;
  /** The widest it can be; null when the frame does not show it. */
  readonly high: number | null;
}

/** A section's rows (one item the reader knows: a description, a command, an option), as drawn, each continuation row `next` cells in. */
export interface WrapSection {
  readonly rows: readonly string[];
  /** The blank cells the agent draws before each of the section's continuation rows. */
  readonly next: number;
  /** Whether the section's own text may hold line breaks (a command, a description, the parameters); false for one line (a question, a label, a diff line, a path). */
  readonly lines: boolean;
  /** The section's own wrapper where it is not the frame's (Codex's command, wrapped at blanks only). */
  readonly style?: WrapStyle;
}

/**
 * The frame's edge from the pane's width, `columns` (the width the screen was read at, `readColumns`), where the
 * reader knows how far in from the pane's edge its text can end: `margin` cells at most. Null columns,
 * or a row wider than them (the width is not the one the screen was drawn at): the reader's own `low` and `high`.
 */
export function edgeFromColumns(frame: WrapFrame, columns: number | null, margin: number): WrapFrame {
  if (columns === null || frame.low > columns) return frame;
  const high = frame.high === null ? columns : Math.min(frame.high, columns);
  const low = Math.max(frame.low, columns - margin);
  return low > high ? frame : { style: frame.style, low, high };
}

/** The widest pane a width is taken from, in cells: a wider one no terminal has, so it is no width. */
export const maxColumns = 2000;

/**
 * `columns` when it is a width the screen can have been drawn at: a whole number from 1 to `maxColumns`, and no row of
 * the screen wider (the narrowest drawing a reader can read is its own widest row). Else null, the no-width reading.
 */
export function fitsColumns(rows: readonly string[], columns: number | null): number | null {
  if (columns === null || !Number.isInteger(columns) || columns <= 0 || columns > maxColumns) return null;
  return rows.every((row) => cells(trimEnd(row)) <= columns) ? columns : null;
}

/** Terminal cells `text` takes: two for a wide character, else one. */
export function cells(text: string): number {
  let total = 0;
  for (const character of text) total += wide(character) ? 2 : 1;
  return total;
}

function wide(character: string): boolean {
  const value = character.codePointAt(0)!;
  return (
    (value >= 0x1100 && value <= 0x115f) ||
    (value >= 0x2300 && value <= 0x23ff) ||
    (value >= 0x2600 && value <= 0x27bf) ||
    (value >= 0x2e80 && value <= 0xa4cf) ||
    (value >= 0xac00 && value <= 0xd7a3) ||
    (value >= 0xf900 && value <= 0xfaff) ||
    (value >= 0xfe30 && value <= 0xfe4f) ||
    (value >= 0xff00 && value <= 0xff60) ||
    (value >= 0xffe0 && value <= 0xffe6) ||
    (value >= 0x1f300 && value <= 0x1faff) ||
    (value >= 0x20000 && value <= 0x3fffd)
  );
}

/**
 * A character's cells where every terminal draws it so: 1 for ASCII, Latin, Greek and Cyrillic letters, general
 * punctuation and box drawing; 2 for CJK, kana, Hangul and the fullwidth forms. Null for anything else (an emoji, a
 * combining or zero-width mark, a symbol a terminal may draw one or two cells wide): a row holding one is never
 * measured against the edge.
 */
function sureCells(character: string): number | null {
  const value = character.codePointAt(0)!;
  if (
    (value >= 0x20 && value <= 0x7e) ||
    (value >= 0xa0 && value <= 0x2ff && value !== 0xad) ||
    (value >= 0x370 && value <= 0x52f && !(value >= 0x483 && value <= 0x489)) ||
    (value >= 0x2010 && value <= 0x2027) ||
    (value >= 0x2030 && value <= 0x205e) ||
    (value >= 0x20a0 && value <= 0x20c0) ||
    (value >= 0x2500 && value <= 0x257f)
  ) {
    return 1;
  }
  if (
    (value >= 0x1100 && value <= 0x115f) ||
    (value >= 0x2e80 && value <= 0x303e) ||
    (value >= 0x3041 && value <= 0xa4cf) ||
    (value >= 0xac00 && value <= 0xd7a3) ||
    (value >= 0xf900 && value <= 0xfaff) ||
    (value >= 0xfe30 && value <= 0xfe4f) ||
    (value >= 0xff00 && value <= 0xff60) ||
    (value >= 0xffe0 && value <= 0xffe6) ||
    (value >= 0x20000 && value <= 0x3fffd)
  ) {
    return 2;
  }
  return null;
}

/** `text`'s cells where every character's are certain (`sureCells`), else null. */
function sureWidth(text: string): number | null {
  let total = 0;
  for (const character of text) {
    const width = sureCells(character);
    if (width === null) return null;
    total += width;
  }
  return total;
}

/** `row` without the blanks at its end. */
function trimEnd(row: string): string {
  let end = row.length;
  while (end > 0 && row.charCodeAt(end - 1) === blank) end -= 1;
  return end === row.length ? row : row.slice(0, end);
}

/** `row` without the blanks at its start and end. */
export function rowWords(row: string): string {
  let start = 0;
  let end = row.length;
  while (start < end && row.charCodeAt(start) === blank) start += 1;
  while (end > start && row.charCodeAt(end - 1) === blank) end -= 1;
  return start === 0 && end === row.length ? row : row.slice(start, end);
}

function isBlankRow(row: string): boolean {
  return rowWords(row) === "";
}

function leadingBlanks(row: string): number {
  let at = 0;
  while (at < row.length && row.charCodeAt(at) === blank) at += 1;
  return at;
}

/** The first word of `row` (up to its first blank). */
function firstWord(row: string): string {
  const at = row.indexOf(" ");
  return at < 0 ? row : row.slice(0, at);
}

/** The last word of `row` (after its last blank). */
function lastWord(row: string): string {
  return row.slice(row.lastIndexOf(" ") + 1);
}

/** ASCII letters and digits, and the symbols Unicode reads as letters (no break before or after them but at a blank). */
const letterLike = /^[A-Za-z0-9`=*@#&<>~_^]$/u;
/** Unicode's prefix and postfix signs (`$`, `+`, `\`, `%`): no break between them and a letter. */
const signs = /^[$+\\%]$/u;
/** Opening brackets: no break between a letter and one. */
const opening = /^[([{]$/u;
/** Infix separators (`,` `.` `:` `;`): no break between one and a letter after it. */
const infix = /^[,.:;]$/u;
/** Closing brackets: no break between one and a letter or digit after it. */
const closing = /^[)\]]$/u;
/** Quotes: no break before or after one. */
const quote = /^["']$/u;
/** What may start the next row with no break before it after a letter: letters, signs, quotes, `/`, `-`, separators, closings, `!`, `?`, `|`, openings. */
const afterLetter = /^[A-Za-z0-9`=*@#&<>~_^$+\\%"'/\-,.:;)\]}!?|([{]$/u;

/**
 * Whether Unicode's line breaking (UAX #14, as textwrap applies it) allows no break between `last` and `first`
 * without a blank: then a row ending in `last` over a row starting with `first` was wrapped at a blank. Anything not
 * known so (a `-`, `/`, `|`, `?` or `}` at the row's end, a character beyond ASCII) is not.
 */
function noBreakBetween(last: string, first: string): boolean {
  if (last === "" || first === "") return false;
  if (quote.test(last) || quote.test(first)) return /^[\x21-\x7e]$/u.test(last) && /^[\x21-\x7e]$/u.test(first);
  if (letterLike.test(last) || signs.test(last)) return afterLetter.test(first) && (!opening.test(first) || letterLike.test(last));
  if (infix.test(last)) return /^[A-Za-z]$/u.test(first);
  if (closing.test(last)) return /^[A-Za-z0-9]$/u.test(first);
  return false;
}

/**
 * What the end of row `row` may stand for before the next row `rest` (the section's `next` cells of indent off, its
 * own blanks kept), by what the wrapper can draw there: "" (nothing: a word cut at the edge, or the blank went to
 * `rest`'s start), " " (one blank, dropped or trimmed at the row's end), or "\n" (a line break: no wrap draws these
 * rows, and the part may hold one). One: decided; several: wraps of two kinds could draw them; none: nothing could
 * (or a width is not certain).
 */
function endCandidates(row: string, rest: string, section: WrapSection, frame: WrapFrame): readonly string[] {
  const lead = leadingBlanks(rest);
  // Only a row whose width is certain is measured against the edge, and the next row's first word with it.
  const used = sureWidth(row);
  const word = sureWidth(firstWord(rest.slice(lead)));
  const first = sureCells(String.fromCodePoint(rest.codePointAt(lead) ?? blank));
  if (used === null || word === null || first === null) return [];
  const low = frame.low;
  const high = frame.high ?? Number.POSITIVE_INFINITY;
  if (used > high) return [];
  const style = section.style ?? frame.style;
  // Ink's way at a row it filled exactly: the blank goes to the next row's start (Claude Code; agy maybe; agy's choices maybe).
  const moves = style !== "textwrap";
  const ends = new Set<string>();
  // The row may reach the edge (the edge may be right after its last cell).
  const full = used >= low;
  if (lead > 0) {
    // A blank at the next row's start: the break fell at a blank there (Ink moved it after a word that filled the row,
    // or the edge cut right before it); the blanks are the text's own.
    if (full && moves) ends.add("");
  } else {
    // A word cut at the edge: only a word longer than a row is cut by a word wrapper (the cut word's two pieces,
    // together, would not fit on a row of this width); anything is, by an edge cut.
    const joined = sureWidth(lastWord(row))! + word;
    const cut = full && (style === "either" || joined > used - section.next);
    if (cut) ends.add("");
    // A wide character that did not fit in the row's last cell: a cut one cell short of the edge.
    if (first === 2 && used + 1 >= low && used + 1 <= high) ends.add("");
    // A wrap at a blank: the next word would not have fit on the row at some edge the frame allows. Ink keeps the
    // blank in the row (the edge at least one past the row's last cell); a wrapper that drops it may fill the row.
    const keep = style === "ink" || style === "either" ? 1 : 0;
    if (Math.max(low, used + keep) <= Math.min(high, used + word)) ends.add(" ");
    // An edge cut that fell on a blank in the row's last cell (Herdr trims it).
    if (style === "either" && used + 1 >= low && used + 1 <= high) ends.add(" ");
    // Ink never fills a row and leaves the next row starting with a word that would have fit beside the last one: that
    // row was not cut, so its end is a blank (a wrapper that drops the blank at a row it filled exactly).
    if (style === "ink" && full && !cut) ends.add(" ");
    // textwrap breaks without a blank after `-`, `/` and the like.
    if (style === "textwrap" && !noBreakBetween(row.slice(-1), rest.charAt(0))) ends.add("");
  }
  // No wrap draws these rows: a line break, where the part may hold one (the rule reads a line break where a wrap
  // could also have broken as that wrap).
  if (ends.size === 0) return section.lines ? ["\n"] : [];
  return [...ends];
}

/**
 * One run of a section's rows (no row of nothing but blanks among them) as the texts it may stand for: one when
 * every row's end is told; up to `limit` when some are not (each end's possibilities in turn); none when a row's end
 * stands for nothing a wrapper draws, or there would be more than `limit`.
 */
function runTexts(rows: readonly string[], section: WrapSection, frame: WrapFrame, limit: number): string[] {
  let texts = [trimEnd(rows[0]!)];
  for (let index = 1; index < rows.length; index += 1) {
    const row = trimEnd(rows[index - 1]!);
    const next = trimEnd(rows[index]!);
    if (leadingBlanks(next) < section.next) return [];
    const rest = next.slice(section.next);
    const ends = endCandidates(row, rest, section, frame);
    if (ends.length === 0 || texts.length * ends.length > limit) return [];
    texts = texts.flatMap((text) => ends.map((end) => text + end + rest));
  }
  return texts;
}

/** A section's runs (split at rows of nothing but blanks) as the texts it may stand for, each run trimmed, the runs joined by line breaks. */
function sectionTexts(section: WrapSection, frame: WrapFrame, limit: number): string[] {
  let texts = [""];
  let first = true;
  let run: string[] = [];
  const flush = (): boolean => {
    if (run.length === 0) return true;
    const runs = runTexts(run, section, frame, limit);
    run = [];
    if (runs.length === 0 || texts.length * runs.length > limit) return false;
    texts = texts.flatMap((text) => runs.map((one) => (first ? rowWords(one) : `${text}\n${rowWords(one)}`)));
    first = false;
    return true;
  };
  for (const row of section.rows) {
    if (!isBlankRow(row)) run.push(row);
    else if (!flush()) return [];
  }
  if (!flush()) return [];
  return first ? [] : texts;
}

/**
 * A part's sections as the one text they stand for: each section's runs, each run's blanks at either end off, one
 * line each, the lines joined by line breaks. Null where a section's row end cannot be told (no text at
 * all, so the part is compared by its rows), unless `settle` accepts exactly one of that section's possible texts
 * (what else the reader's screen shows; no reader passes one).
 */
export function partText(sections: readonly WrapSection[], frame: WrapFrame, settle?: (text: string) => boolean): string | null {
  const texts: string[] = [];
  for (const section of sections) {
    if (section.rows.every(isBlankRow)) continue;
    const told = sectionTexts(section, frame, 1);
    if (told.length === 1) {
      texts.push(told[0]!);
      continue;
    }
    if (settle === undefined) return null;
    const agreed = sectionTexts(section, frame, settleLimit).filter(settle);
    if (agreed.length !== 1) return null;
    texts.push(agreed[0]!);
  }
  return texts.join("\n");
}

/** The widest of `rows` in cells, each without its end blanks. */
export function widest(rows: readonly string[]): number {
  return rows.reduce((most, row) => Math.max(most, cells(trimEnd(row))), 0);
}

/** Whether two readings' rows are the same rows: each row's end blanks off, rows of nothing but blanks left out. */
export function sameRows(a: readonly string[], b: readonly string[]): boolean {
  const left = a.map(trimEnd).filter((row) => !isBlankRow(row));
  const right = b.map(trimEnd).filter((row) => !isBlankRow(row));
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

/**
 * Whether two readings' rows hold the same characters other than blanks, in the same order: what every two readings
 * of one question share however they wrap (a row's end adds only a blank, a line break or nothing). Checked beside
 * the texts, so a fingerprint whose rows and texts disagree (one main never made) is never the same question.
 */
export function sameLetters(a: readonly string[], b: readonly string[]): boolean {
  const letters = (rows: readonly string[]): string => rows.join("").replaceAll(" ", "");
  return letters(a) === letters(b);
}

/** The rows as a record counts them: how many hold more than blanks, and the widest in cells (each without its edge blanks). */
export function rowShape(rows: readonly string[]): { readonly rows: number; readonly widest: number } {
  const kept = rows.map(rowWords).filter((row) => row !== "");
  return { rows: kept.length, widest: kept.reduce((most, row) => Math.max(most, cells(row)), 0) };
}
