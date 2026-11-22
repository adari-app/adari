// Antigravity CLI's input box at the bottom of its screen: what a Send to an idle or done agy pane must see before it
// writes anything (send.ts sendBoundNow). Built from agy 1.5.13's screens as `pane.read` gives them (40 lines, recent).

import { readRows, trimWhitespace, withoutEscapes } from "./prompt/matcher";

/** How long a Send to an idle or done agy pane waits for its own read (its turn at the pane's read gate included). */
export const agySendReadMs = 3_000;

/** A rule: a row of `─` only, as wide as the screen (at least this many cells). */
const ruleRow = /^─{8,}$/u;
/** The mode line at the last row's right end: two to four parts joined by " · ", plain words only. */
const modeLine = /^[\w.()/+-]+(?: [\w.()/+-]+)*(?: · [\w.()/+-]+(?: [\w.()/+-]+)*){1,3}$/u;
/** The last row's left part with an empty box ("? for shortcuts") or a draft in it (blank). */
const modeRowLeft = new Set(["", "? for shortcuts"]);
/** The box's first row: `>`, then nothing or a space and the draft (or a greyed hint). */
const boxFirst = /^>(?: .*)?$/u;
/** A longer draft's next rows: indented by two spaces. */
const boxMore = /^ {2}\S/u;

/**
 * True only when the read's very bottom is agy's input box, seen whole (the README of the samples, the last section):
 *
 *     ───────────────────────────────────────────────
 *     > the draft, a greyed hint, or nothing
 *       a longer draft's next rows, indented by two spaces
 *     ───────────────────────────────────────────────
 *     ? for shortcuts            auto · Gemini 4 Hydrogen · low
 *
 * The last row with words (blank rows under it dropped) ends in the mode line, its left part "? for shortcuts" or blank,
 * and it never starts with "esc to cancel" (agy working, or one of its questions); right above it a rule; above that
 * the box (a `>` row, then rows indented by two spaces); above the box a second rule as wide as the first. Anything else
 * is not clear: a question (its last rows are its choices, its navigation row and "esc to cancel", with no box between
 * two rules), a question drawn only through its choices, a frame cut anywhere, a screen this does not know.
 */
export function agyInputClear(text: string): boolean {
  const rows = readRows(text).map((row) => withoutEscapes(row).replace(/ /gu, " ").replace(/\s+$/u, ""));
  let last = rows.length - 1;
  while (last >= 0 && rows[last] === "") last -= 1;
  // The mode row, a rule, at least one box row, a rule.
  if (last < 3) return false;
  const modeRow = rows[last]!;
  if (trimWhitespace(modeRow).startsWith("esc to cancel")) return false;
  const parts = trimWhitespace(modeRow).split(/ {2,}/u);
  const mode = parts.at(-1)!;
  const left = parts.length === 1 ? "" : parts.slice(0, -1).join("  ");
  if (parts.length > 2 || !modeLine.test(mode) || !modeRowLeft.has(left)) return false;
  // The mode line sits at the right end: nothing but blanks after it (trimmed above), and the row starts at the edge.
  if (modeRow.startsWith(" ") && left !== "") return false;
  const lowerRule = rows[last - 1]!;
  if (!ruleRow.test(lowerRule)) return false;
  // The box, bottom up: rows indented by two spaces, then its `>` row.
  let at = last - 2;
  while (at >= 0 && boxMore.test(rows[at]!)) at -= 1;
  if (at < 1 || !boxFirst.test(rows[at]!)) return false;
  const upperRule = rows[at - 1]!;
  return ruleRow.test(upperRule) && upperRule.length === lowerRule.length;
}

// MARK: - the last row's mode, model and level (agy 1.5.14), for the chips and the picks

/** The mode words the last row's right end may start with (no word: the session asks before edits and commands). */
const agyModeWords: Readonly<Record<string, string>> = { auto: "auto", "accept-edits": "acceptEdits", plan: "plan" };

/** What the last row of an agy screen says at its right end: the mode (approval-modes.ts ids; "default": none shown), the model and its level. */
export interface AgyStatusRow {
  readonly mode: string;
  readonly model: string;
  readonly level: string | null;
}

/** The screen's rows as agyInputClear reads them, the blank rows under the last row with words dropped. */
function agyRows(text: string): string[] {
  const rows = readRows(text).map((row) => withoutEscapes(row).replace(/ /gu, " ").replace(/\s+$/u, ""));
  let last = rows.length - 1;
  while (last >= 0 && rows[last] === "") last -= 1;
  return rows.slice(0, last + 1);
}

/** The last row's left part and right end ("? for shortcuts", "esc to cancel" or blank; the mode line), or null. */
function agyLastRow(rows: readonly string[]): { readonly left: string; readonly right: string } | null {
  if (rows.length < 2 || !ruleRow.test(rows[rows.length - 2]!)) return null;
  const row = rows[rows.length - 1]!;
  const parts = trimWhitespace(row).split(/ {2,}/u);
  if (parts.length > 2) return null;
  const right = parts.at(-1)!;
  const left = parts.length === 1 ? "" : parts[0]!;
  if (!modeLine.test(right) || !(modeRowLeft.has(left) || left === "esc to cancel")) return null;
  // The mode line sits at the right end: a row with words at its left starts at the edge.
  if (left !== "" && row.startsWith(" ")) return null;
  return { left, right };
}

/**
 * The mode, model and level at the right end of the screen's last row, right under a rule (the samples' rule): the
 * part after the mode word ("auto · Gemini 4 Hydrogen · low"), or the whole right end when no mode shows ("Gemini 4
 * Hydrogen · low": the mode that asks). Read while agy is idle or works (its left part "? for shortcuts", blank, or
 * "esc to cancel"); null when the row is not there or does not read so (a question, a frame cut, another screen).
 */
export function readAgyStatusRow(text: string): AgyStatusRow | null {
  const last = agyLastRow(agyRows(text));
  if (last === null) return null;
  const parts = last.right.split(" · ");
  const first = agyModeWords[parts[0]!];
  const mode = first ?? "default";
  const rest = first === undefined ? parts : parts.slice(1);
  if (rest.length === 0 || rest.length > 2) return null;
  const level = rest[1] ?? null;
  if (level !== null && !/^[a-z]{1,16}$/u.test(level)) return null;
  return { mode, model: rest[0]!, level };
}

/** The box's one row while it is empty: `>` alone, or its greyed hint for the mode ("Auto mode: … (shift+tab to cycle)"). */
const emptyBox = /^>(?: .*\(shift\+tab to cycle\))?$/u;

/**
 * agy idle with its box empty at the bottom: its input box seen whole (agyInputClear: never a question, a command list
 * or a working turn), the box one row that is `>` alone or its mode's hint, and the last row's left part
 * "? for shortcuts" (blank while a draft is in the box). What a typed `/model` or a Shift+Tab needs before it goes.
 */
export function agyBoxEmpty(text: string): boolean {
  if (!agyInputClear(text)) return false;
  const rows = agyRows(text);
  const last = agyLastRow(rows);
  return last !== null && last.left === "? for shortcuts" && rows.length >= 4 && emptyBox.test(rows[rows.length - 3]!) && ruleRow.test(rows[rows.length - 4]!);
}

/** The box's text when its input box is seen whole: its rows joined ("" when empty), or null. */
export function agyBoxDraft(text: string): string | null {
  if (!agyInputClear(text)) return null;
  if (agyBoxEmpty(text)) return "";
  const rows = agyRows(text);
  let at = rows.length - 3;
  const more: string[] = [];
  while (at >= 0 && boxMore.test(rows[at]!)) {
    more.unshift(rows[at]!.slice(2));
    at -= 1;
  }
  const head = rows[at]!.replace(/^> ?/u, "");
  return [head, ...more].join("\n");
}

/**
 * agy's screen after a typed `/model <id>` (`command`), for its Return: "shows" when its input box, seen whole, holds
 * exactly the command and nothing else (the last row's left part blank: a draft, no command list); "settling" while it
 * is empty or holds a beginning of it; "differs" for anything else (other text joined to it, a command list under the
 * box, agy working, a question, a read that does not show the box).
 */
export function agyTypedRead(screen: string, command: string): "shows" | "settling" | "differs" {
  const draft = agyBoxDraft(screen);
  if (draft === null) return "differs";
  if (draft === command) return "shows";
  return command.startsWith(draft) ? "settling" : "differs";
}

/** Antigravity CLI's own refusal of a `--model` id it does not know (model-unknown-1.5.14.txt's first line). */
const unknownModel = /^error: invalid model selection \(--model "[^"\n]*" --effort "[^"\n]*"\): model \S+ is not recognized\b/iu;

/**
 * That refusal's line in a pane's text (an `agy --model <id>` that ended at once with exit 1), up to "is not
 * recognized"; null when the text holds none. Only that whole shape counts.
 */
export function agyUnknownModelLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/u)) {
    const found = unknownModel.exec(raw.trim());
    if (found !== null) return found[0];
  }
  return null;
}
