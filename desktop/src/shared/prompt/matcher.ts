// The answer layer's reading of a blocked pane's screen, ported line by line
// from the Swift app (App/CompanionPromptModel.swift: CompanionPromptMatcher,
// CompanionPromptFingerprint, CompanionPromptMatch, CompanionPromptReading and
// the agents' own text fields). Same rules:
//
// - `matchPrompt` turns a blocked pane's last lines (`pane.read`, `source:
//   recent`, plain text) into a numbered menu (`❯ 1. Yes`) or a `[y/N]`
//   question with its options, but only when the whole frame is on screen and
//   current; anything else is "unmatched" (show the lines, no buttons).
// - The fingerprint is what an answer is bound to: the pane id, every line of
//   the question, the body the frame shows (the command, or the edit and its
//   diff) and the option lines, as drawn: only the box's edges, their padding
//   and the blanks out to the edge come off, so a space inside a command or a
//   diff line's indentation is part of it. Where the cursor (`❯`) sits is not.
//   A reader that knows its frame's width and its agent's wrap also keeps each
//   part as the one text it stands for (`words`, words.ts): two readings of
//   one question at two widths are compared by those texts.
// - `showsInputPrompt` reads each supported agent kind's own empty text field:
//   the proof the text after a "No, tell…" option waits for.
// - On a Grok pane only (the pane's agent picks the reader, as the live
//   readers do), Grok Build 1.0.70's approval frame (`grokFrame`):
//   the `┃` block with a `›` title row, the command under `│`, the numbered
//   options `N (○|◯|●|◉) <words>` and the footer `1/<n>:select …`. Its answer
//   is the option's digit, then maybe Enter (answerer.ts).
// - On a Codex pane only, Codex 0.166.0's tool-call
//   question, its one-field MCP elicitation form (`codexForm`): an optional
//   `Field 1/1` row, the header (`Allow this request?` or `Allow <name> to …`),
//   optional parameter rows, the numbered options with their descriptions
//   (`Allow`, `Allow for this session`, `Always allow`, `Cancel`) and the
//   footer `enter to submit | esc to cancel`. Its answer is the digit alone.
// - On a Codex pane only, Codex's update question at
//   start (codex-rs tui/src/update_prompt.rs; update-mark.ts reads its first
//   line): "1. Update now (runs `<command>`)", "2. Skip", "3. Skip until next
//   version", one marked `›`, and its footer "enter continue · esc skip"
//   (`codexUpdate`). Its keys are only the ones its own footer names: Return
//   for the marked choice, Esc for Skip; another choice is answered in the
//   Terminal (its key is not known here).
// - On a Codex pane only, Codex 0.171.0's own question in Plan mode (its
//   request_user_input tool, `codexQuestion`): a padding row, the header
//   `Question N/M (K unanswered)`, the question's rows, a blank row, the
//   options `N. <label>  <description>` (one marked `›`) ending with Codex's
//   own `None of the above` row, a blank row and the footer the header calls
//   for. And the list after a plan (`codexPlan`): `Implement this plan?`, its
//   three choices and the footer `enter select · esc back`. Each answer is the
//   option's digit alone.
// - On a Claude pane, or one whose agent is not known, Claude Code 2.1.325's
//   question dialog (its AskUserQuestion tool, `claudeAsk`): the top rule,
//   one header chip, the question, the options numbered from 1 with their
//   descriptions, `Type something.`, a rule, `Chat about this` and the footer
//   `Enter to select · ↑/↓ to navigate · Esc to cancel`. Its answer is the
//   option's digit alone, then reads (answerer.ts).
// - Claude Code draws a command (or a diff)
//   taller than the 40 lines read whole, so its section header ("Bash
//   command") lands above the read. On a Claude pane a full read that ends in
//   Claude's options and footer under a dashed rule, with no header, rule or
//   bullet above, is a cut frame (`CutFrame`): the reader reads again with
//   `promptTallReadLines` once (`readPromptScreen`), and every rule above holds
//   for that read. A frame still cut is never matched (its rows cannot show
//   what it asks or that Claude drew it): it
//   stays unmatched with `cut`, which only says what the card and the pill may
//   show of it. A matched Bash frame keeps its command's rows and description
//   (`run`).
//
// - A Claude Code session that has a name draws its name in a rule under its
//   dialogs (`isNameRule`). Under Claude's own footers only (the menus' "Esc
//   to cancel · Tab to amend" and the question dialog's), once, among blank
//   rows and plain rules, the three Claude readers read the frame as if it
//   were not there; it is never part of a match or its fingerprint, and an
//   unmatched card never shows it. Anywhere else it is a row like any other.
//
// - On an agy pane only, Antigravity CLI 1.5.13's own questions (read live,
//   2026-11-20): its folder trust question (`agyTrust`: "Do you trust the
//   contents of this project?", two choices, one marked `>`, the footer
//   "↑/↓ Navigate · enter Confirm" and the mode line), answered with Return or
//   an arrow then Return; and its permission questions before a command, a new
//   file or an edit (`agyAsk`: the title over a rule, the command or the path
//   with its diff, the question, the numbered choices, the footer and "esc to
//   cancel"), answered with the digit alone. Each only whole at the bottom of
//   the screen; the same words anywhere else are ordinary text.
//
// Swift counts Characters; this port counts code points (the same for every
// row a supported agent draws).

import { effortPattern, modelIdPatterns } from "../model-catalog";
import { cells, edgeFromColumns, fitsColumns, partText, rowWords, sameLetters, sameRows, widest, type WrapFrame, type WrapSection } from "./words";

export { cells };

/** One answer Adari can give to a prompt it matched. */
export interface PromptOption {
  /** The digit of a numbered menu or the letter of a `[y/N]` question. */
  readonly key: string;
  readonly label: string;
  /** What Return would pick: the `❯` option of a menu, the capital of `[y/N]`. */
  readonly isReturnDefault: boolean;
  /** "allow all edits this session", "don't ask again". */
  readonly isSessionWide: boolean;
  /** "No, tell the agent what to change": the message box answers with it. */
  readonly opensComposer: boolean;
  /** What `pane.send_keys` receives: the digit for a menu, the letter and Return for a `[y/N]` line prompt. */
  readonly keys: readonly string[];
  /** Codex's description beside the label ("Run the tool and continue"), its wrapped rows joined; absent elsewhere. */
  readonly detail?: string;
  /**
   * A choice of Codex's update question whose key the app does not know for certain (neither the
   * marked one, Return, nor Skip, Esc): its button shows the Terminal, and nothing is ever sent for it (`keys` empty).
   */
  readonly inTerminal?: boolean;
}

/**
 * `grok` is Grok 1.0.70's approval frame (its digit alone).
 * `codexForm` is Codex 0.166.0's tool-call question (its digit alone).
 * `claudeAsk` is Claude Code 2.1.325's question dialog, one question, one choice (its digit alone).
 * `agyAsk` is Antigravity CLI 1.5.13's permission question (its digit alone); `agyTrust` its folder trust
 * question (Return for the marked choice, the arrow then Return for the other).
 * `codexQuestion` is Codex 0.171.0's own question in Plan mode (its request_user_input tool; its digit alone, then
 * reads); `codexPlan` its "Implement this plan?" list after a plan (its digit alone, then reads).
 */
export type PromptKind = "menu" | "yesNo" | "grok" | "codexForm" | "codexUpdate" | "codexQuestion" | "codexPlan" | "claudeAsk" | "agyAsk" | "agyTrust";

/** The one context line under the question. */
export type PromptContext =
  /** `+` and `-` lines of the change being approved. */
  | { readonly type: "diff"; readonly added: number; readonly removed: number }
  /** The command waiting to run. */
  | { readonly type: "command"; readonly text: string }
  /** The file a write would create (the name row under Claude's "Create file"). */
  | { readonly type: "file"; readonly name: string }
  /** The parameter rows under Codex's tool-call question ("Calendar: primary"), as drawn. */
  | { readonly type: "parameters"; readonly rows: readonly string[] };

/** What an answer is bound to (CompanionPromptFingerprint, rules 2). */
export interface PromptFingerprint {
  readonly rules: number;
  readonly paneID: string;
  /** The question's rows joined by a space, each as drawn. */
  readonly question: string;
  readonly body: readonly string[];
  readonly options: readonly string[];
  /**
   * Each part as the one text it stands for (words.ts `partText`), from
   * what the reader knows of its frame: its width and how its agent wraps; where a row's end cannot be told, the
   * part's rows as drawn (joined by `undecided`). A part null where the reader could not split it (a diff row with no
   * line head, an option row it did not parse). Absent where the reader does not know its frame (Grok's, `[y/N]`, a
   * boxed menu, Codex's update question): then only the same rows are the same question.
   */
  readonly words?: FingerprintWords;
}

/** A fingerprint's parts as the texts they stand for (null: not split, compared by their rows). */
export interface FingerprintWords {
  readonly question: string | null;
  readonly body: string | null;
  readonly options: string | null;
  /**
   * The question's rows as drawn (each row's end blanks off), where its text is null: the fingerprint
   * keeps the question as its rows joined by one blank, which cannot show where a row ended, so an untold question is
   * compared by these. Absent where the question is told.
   */
  readonly questionRows?: readonly string[];
}

export const fingerprintRules = 2;

export interface PromptMatch {
  readonly kind: PromptKind;
  /** The whole question, wrapped lines joined. */
  readonly question: string;
  readonly options: readonly PromptOption[];
  readonly context: PromptContext | null;
  readonly fingerprint: PromptFingerprint;
  /** Claude Code's Bash command as its frame draws it, and its description; absent elsewhere. */
  readonly run?: ClaudeRun;
  /** The header chip's text over Claude Code's question dialog ("Q95"); absent elsewhere. */
  readonly askHeader?: string;
  /** Codex's own question's header row ("Question 1/2 (2 unanswered)"), as numbers; absent elsewhere. */
  readonly codexProgress?: CodexQuestionProgress;
}

/** Where Codex's own question stands: question `index` of `total`, `unanswered` of them not answered yet. */
export interface CodexQuestionProgress {
  readonly index: number;
  readonly total: number;
  readonly unanswered: number;
}

/** A Bash command Claude Code asks to run, as its frame draws it. */
export interface ClaudeRun {
  /** The rows between the two dashed rules, as drawn: the frame's padding off, the command's own indentation and blank rows kept. */
  readonly rows: readonly string[];
  /** The description Claude draws under the header (its Tip left out), wrapped rows joined; null without one. */
  readonly description: string | null;
}

/**
 * What looks like Claude Code's approval frame with its top (the rule and the
 * section header) above what the read holds. Never answerable: only words for
 * the card and the pill.
 */
export interface CutFrame {
  /** The question, as drawn ("Do you want to proceed?"). */
  readonly question: string;
  /** The body's rows the read holds under the frame's last dashed rule above them (the command's last rows), each trimmed, blank rows dropped. */
  readonly rows: readonly string[];
  /** What an unmatched card shows of it. */
  readonly lines: readonly string[];
}

export type PromptReading =
  | { readonly type: "matched"; readonly match: PromptMatch }
  /**
   * Not a complete prompt Adari can answer: the card shows these lines and no
   * buttons. `cut` when they end Claude's frame
   * read without its header.
   */
  | { readonly type: "unmatched"; readonly lines: readonly string[]; readonly cut?: CutFrame };

export function readingMatch(reading: PromptReading | null | undefined): PromptMatch | null {
  return reading?.type === "matched" ? reading.match : null;
}

/** The part of a fingerprint where two readings first differ (`fingerprintDifference`). */
export type FingerprintPart = "pane" | "question" | "body" | "options";

/**
 * Whether two readings are the same question: the same pane, and each
 * part's text (`words`) equal, UTF-16 unit for unit; a part a reading has no text for is compared by its rows.
 * The one comparison every place uses: the answerer's fresh read, the claim, the card's shown reading, the remembered
 * selection. The Swift twin: CompanionPromptFingerprint.sameQuestion (HerdrKit's PromptWords.difference).
 */
export function sameFingerprint(a: PromptFingerprint, b: PromptFingerprint): boolean {
  return fingerprintDifference(a, b) === null;
}

/**
 * Where two readings stop being the same question, in this order: the pane, the question (and the reading rules),
 * the body, the options; null when they are the same question. Each part: when both readings hold its text
 * (`words`), the texts equal UTF-16 unit for unit and the rows' characters other than blanks the same (`sameLetters`);
 * otherwise the same rows (words.ts `sameRows`: each row's end blanks off, rows of nothing but blanks left out; the
 * question, read as its rows joined, without the blanks at its ends).
 */
export function fingerprintDifference(a: PromptFingerprint, b: PromptFingerprint): FingerprintPart | null {
  if (a.paneID !== b.paneID) return "pane";
  if (a.rules !== b.rules) return "question";
  const same = (part: keyof FingerprintWords, rows: (fingerprint: PromptFingerprint) => readonly string[]): boolean => {
    const left = a.words?.[part] ?? null;
    const right = b.words?.[part] ?? null;
    return left !== null && right !== null ? left === right && sameLetters(rows(a), rows(b)) : sameRows(rows(a), rows(b));
  };
  if (!same("question", (fingerprint) => fingerprint.words?.questionRows ?? [rowWords(fingerprint.question)])) return "question";
  if (!same("body", (fingerprint) => fingerprint.body)) return "body";
  if (!same("options", (fingerprint) => fingerprint.options)) return "options";
  return null;
}

/** A question part's words: its text, or (not told) no text and its rows as drawn (`FingerprintWords.questionRows`). */
function questionWords(sections: readonly WrapSection[], frame: WrapFrame): Pick<FingerprintWords, "question" | "questionRows"> {
  const question = partText(sections, frame);
  if (question !== null) return { question };
  return { question: null, questionRows: sections.flatMap((section) => section.rows).map((row) => row.replace(/ +$/u, "")).filter((row) => rowWords(row) !== "") };
}

/** The option a card leads with: a menu's Return pick (or first), never session-wide or "No, tell…"; none for `[y/N]`. */
export function primaryOption(match: PromptMatch): PromptOption | null {
  if (match.kind === "yesNo") return null;
  const eligible = match.options.filter((option) => !option.isSessionWide && !option.opensComposer);
  return eligible.find((option) => option.isReturnDefault) ?? eligible[0] ?? null;
}

/** Two plain options side by side (`[y/N]`, or a two-way menu with nothing session-wide). */
export function sideBySide(match: PromptMatch): boolean {
  return match.options.length <= 2 && !match.options.some((option) => option.isSessionWide);
}

/** What "N more" opens, in the menu's order. */
export function moreOptions(match: PromptMatch): PromptOption[] {
  if (sideBySide(match)) return [];
  const primary = primaryOption(match);
  return match.options.filter((option) => option.key !== primary?.key);
}

export function optionByKey(match: PromptMatch, key: string): PromptOption | null {
  return match.options.find((option) => option.key === key) ?? null;
}

/**
 * The match as the agent of `kind` (lowercased) takes its answers: on a Claude
 * menu with no option that opens the message box, a plain "No" does (Claude
 * Code 2.1.303 opens its own field after it). Every other kind keeps it plain;
 * the fingerprint and keys stay what the frame draws.
 */
export function matchForAgent(match: PromptMatch, kind: string | null | undefined): PromptMatch {
  if (kind !== "claude" || match.kind !== "menu" || match.options.some((option) => option.opensComposer)) return match;
  return {
    ...match,
    options: match.options.map((option) => (trimWhitespace(option.label).toLowerCase() === "no" ? { ...option, opensComposer: true } : option)),
  };
}

export function readingForAgent(reading: PromptReading, kind: string | null | undefined): PromptReading {
  return reading.type === "matched" ? { type: "matched", match: matchForAgent(reading.match, kind) } : reading;
}

// MARK: - the matcher

/** Lines `pane.read` asks for. A read that comes back shorter holds the whole pane. */
export const promptReadLines = 40;
/**
 * The second read's lines, when the first
 * ends in Claude's frame cut off at its top. Its body (at most this many rows)
 * stays within the 200 rows an answer's fingerprint may carry (view.ts).
 */
export const promptTallReadLines = 200;
/** Lines an unmatched reading keeps. */
export const unmatchedLineCount = 4;
/** The footers the supported menus draw under their options, compared whole and lowercased. */
export const promptFooters: ReadonlySet<string> = new Set([
  "esc to cancel",
  "esc to cancel · tab to amend",
  "press enter to confirm or esc to cancel",
  // Codex 0.166.0's approval from another thread (approval_overlay.rs approval_footer_hint).
  "press enter to confirm or esc to cancel or o to open thread",
]);
/** The menus drawn bare (no box, no footer) that are answered, by their whole option sequence, lowercased: Grok's. */
export const bareMenus: readonly (readonly string[])[] = [["yes", "yes, and don't ask again this session", "no", "no, with feedback"]];
/** Claude Code's section headers, where a prompt's body opens. */
export const sectionHeaders: ReadonlySet<string> = new Set(["bash command", "edit file", "create file"]);
/** Lines a question may wrap over. */
export const questionLineLimit = 4;
/** Cells a frame drawn without a box may keep blank at its right. */
export const unboxedMargin = 4;

interface Screen {
  readonly drawn: readonly string[];
  readonly lines: readonly string[];
  readonly complete: boolean;
  readonly width: number;
  /** The pane's width the screen was read at (`readColumns`), null when not known or a row is wider. */
  readonly columns: number | null;
}

/** The rows of a read: by line, the empty string after the last line break dropped. */
export function readRows(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  return raw;
}

/**
 * The reading of a blocked pane's screen. `agentKind`: the pane's agent; a Grok
 * pane's screen is read for Grok 1.0.70's approval frame first, a Codex pane's
 * for Codex 0.166.0's tool-call question first. Every other kind (and none) is
 * read by the general rules alone.
 */
export function matchPrompt(text: string, paneID: string, agentKind: string | null = null, columns: number | null = null): PromptReading {
  const kind = agentKind?.toLowerCase();
  if (kind === "grok") {
    const grok = grokFrame(text, paneID);
    if (grok !== null) return { type: "matched", match: grok };
  }
  if (kind === "codex") {
    const form = codexForm(text, paneID, columns);
    if (form !== null) return { type: "matched", match: form };
    // Its update question at start.
    const update = codexUpdatePrompt(text, paneID);
    if (update !== null) return { type: "matched", match: update };
    // Its own question in Plan mode, and "Implement this plan?" after a plan.
    const question = codexQuestion(text, paneID, columns) ?? codexPlan(text, paneID, columns);
    if (question !== null) return { type: "matched", match: question };
  }
  // Antigravity CLI's own questions: on an agy pane only, and nothing else there (below).
  if (kind === agyKind) {
    const agy = agyQuestion(text, paneID);
    if (agy !== null) return { type: "matched", match: agy };
  }
  // Claude Code's question dialog: on a Claude pane, or one whose agent is not known; never on another agent's.
  if (kind === undefined || kind === "claude") {
    const ask = claudeAsk(text, paneID);
    if (ask !== null) return { type: "matched", match: ask };
  }
  const raw = readRows(text);
  const drawn = raw.map(withoutEscapes);
  const screen: Screen = {
    drawn,
    lines: raw.map(cleanRow),
    complete: raw.length < promptReadLines,
    width: drawn.reduce((widest, row) => Math.max(widest, length(dropTrailingBlanks(row))), 0),
    columns: fitsColumns(drawn, columns),
  };
  // On an agy pane agy's own reader is the only one: a screen it rejects is never a general menu or [y/N] card.
  if (kind === agyKind) return { type: "unmatched", lines: tail(screen) };
  const menu = matchMenu(screen, paneID);
  if (menu !== null) return { type: "matched", match: menu };
  const yesNo = matchYesNo(screen, paneID);
  if (yesNo !== null) return { type: "matched", match: yesNo };
  // On a Claude pane, its frame with the header above the read (unmatched, `cut`).
  if (kind === "claude") {
    const cut = cutFrame(screen);
    if (cut !== null) return { type: "unmatched", lines: cut.lines, cut };
  }
  return { type: "unmatched", lines: tail(screen) };
}

/** The unmatched reading's cut frame; null for every other reading. */
export function readingCut(reading: PromptReading | null | undefined): CutFrame | null {
  return reading?.type === "unmatched" ? (reading.cut ?? null) : null;
}

/**
 * Whether `text`, a read of a pane of
 * `agentKind`, ends in Claude Code's approval frame cut off at its top (a full
 * read, a Claude pane only): the card reads again with `promptTallReadLines`.
 */
export function needsTallRead(text: string, agentKind: string | null | undefined): boolean {
  if (agentKind?.toLowerCase() !== "claude") return false;
  return readingCut(matchPrompt(text, "", "claude")) !== null;
}

/**
 * A blocked pane's screen as the card
 * reads it: its last `promptReadLines` lines, and once, when they end in
 * Claude's frame cut off at its top, its last `promptTallReadLines` instead.
 * The watch's reads and an answer's read take the same path, so the frame an
 * answer is bound to is read the same way again.
 */
export async function readPromptScreen(read: (lines: number) => Promise<string>, agentKind: string | null | undefined): Promise<string> {
  const text = await read(promptReadLines);
  return needsTallRead(text, agentKind) ? read(promptTallReadLines) : text;
}

// MARK: numbered menu

const optionPattern = /^(?:([❯›>▶➤▸])\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/du;
const shortcutHint = /\s*\((?:esc|tab|enter|shift\+tab|ctrl\+[a-z]|[a-z0-9])\)$/iu;

interface OptionLine {
  readonly marked: boolean;
  readonly number: number;
  readonly text: string;
  /** The row from its number on, as drawn: what the fingerprint keeps. */
  readonly drawn: string;
}

function optionLine(line: string): OptionLine | null {
  const found = optionPattern.exec(line);
  if (found === null || found.indices === undefined) return null;
  const numberAt = found.indices[2]![0];
  return { marked: found[1] !== undefined, number: Number(found[2]), text: found[3]!, drawn: line.slice(numberAt) };
}

const codexFooter = "press enter to confirm or esc to cancel";
/** The same footer when the approval comes from another thread (its `o` is never sent). */
const codexThreadFooter = "press enter to confirm or esc to cancel or o to open thread";
const claudeFooter = "esc to cancel · tab to amend";

/**
 * The name rule: a Claude Code session that has a name draws it under its
 * dialogs, in a rule (2.1.325, read from a named pane 119 cells wide: `─` × 88,
 * a space, `invoice-export-cleanup-tests`, a space, one `─`). Here: four `─` or
 * more, one space, the label, one space, exactly one `─`. The label is words one
 * space apart, of anything but rule characters (box drawing), control and
 * format characters and other spaces, at most `nameRuleLabelLimit` code points.
 * Its text is never trusted, shown or compared with a name the app knows (a
 * session renamed by hand has a name Herdr does not have). The Swift twin:
 * CompanionPromptMatcher.nameRule.
 */
const nameRulePattern = /^─{4,} ([^\u2500-\u257F\p{Cc}\p{Cf}\p{Z}]+(?: [^\u2500-\u257F\p{Cc}\p{Cf}\p{Z}]+)*) ─$/u;
/** The longest label a name rule may carry, in code points. */
export const nameRuleLabelLimit = 64;

/**
 * Whether `row`, as `suffixRow` leaves it, is the name rule: the pattern must
 * cover the whole row, checked by the match's start and length (never by an
 * anchor alone), and the label must be within the limit.
 */
export function isNameRule(row: string): boolean {
  const found = nameRulePattern.exec(row);
  return found !== null && found.index === 0 && found[0].length === row.length && [...found[1]!].length <= nameRuleLabelLimit;
}

/**
 * A row under Claude's footer as the name-rule suffix reads it, the same rule
 * on both apps (CompanionPromptMatcher.suffixRow): the row as drawn (escapes
 * already removed), each U+00A0 read as U+0020, then U+0020 removed at both
 * edges, and nothing else. Every other character, at an edge or inside (a
 * tab, U+000B to U+000D, U+0085, U+200B, U+2028, U+2029, U+FEFF, any other
 * control, format or space character), stays, so the row is neither blank, a
 * plain rule nor the name rule.
 */
function suffixRow(drawn: string): string {
  const row = [...drawn].map((character) => (character === "\u00A0" ? " " : character));
  let start = 0;
  let end = row.length;
  while (start < end && row[start] === " ") start += 1;
  while (end > start && row[end - 1] === " ") end -= 1;
  return row.slice(start, end).join("");
}

/** A plain rule under Claude's footer: U+2500 and nothing else. */
function isPlainSuffixRule(row: string): boolean {
  return row !== "" && [...row].every((character) => character === "─");
}

/**
 * Where Claude's frame ends on a named session's screen: the row of `footer`
 * (Claude's own, tested on the reader's own `rows` as before) when every row
 * under it, read by `suffixRow` from `drawn` (the same rows as drawn), is
 * blank, a plain rule or the name rule, and the name rule is there exactly
 * once. Null for any other screen (no name rule, two, or anything else under
 * the footer): each reader reads it as before. The three readers (`matchMenu`,
 * `cutFrame`, `claudeAsk`) start from this row, so the name rule is never part
 * of a match or its fingerprint.
 */
function footerOverNameRule(drawn: readonly string[], rows: readonly string[], footer: string): number | null {
  let index = drawn.length - 1;
  let named = false;
  while (index >= 0) {
    const row = suffixRow(drawn[index]!);
    if (row === "" || isPlainSuffixRule(row)) {
      index -= 1;
    } else if (isNameRule(row)) {
      if (named) return null;
      named = true;
      index -= 1;
    } else {
      break;
    }
  }
  return named && index >= 0 && normalisedLower(collapse(rows[index]!)) === footer ? index : null;
}

/** A row of a paragraph that opens with "Environment:" or "Reason:" (Codex 0.163.0): body, never the question. */
function isCodexBodyRow(lines: readonly string[], index: number): boolean {
  let start = index;
  while (start > 0 && lines[start - 1] !== "" && !isBorder(lines[start - 1]!) && optionLine(lines[start - 1]!) === null) start -= 1;
  return lines[start]!.startsWith("Environment:") || lines[start]!.startsWith("Reason:");
}

interface RunEntry {
  readonly index: number;
  readonly line: OptionLine;
  readonly more: readonly number[];
}

/**
 * The options ending at row `end`, top down, each with the rows that continue
 * it (a row under an option, indented past its number and the ".", that is not
 * an option, a footer or blank: Codex wraps a long option so). A row under the
 * last option continues it only when a footer follows (`lastMayWrap`).
 */
function optionRun(screen: Screen, end: number, lastMayWrap: boolean): RunEntry[] | null {
  const lines = screen.lines;
  if (!lastMayWrap && optionLine(lines[end]!) === null) return null;
  const run: RunEntry[] = [];
  let pending: number[] = [];
  let index = end;
  while (index >= 0) {
    const line = lines[index]!;
    const option = optionLine(line);
    if (option !== null) {
      const row = chars(framed(screen.drawn[index]!));
      const digit = row.findIndex((character) => /\p{N}/u.test(character));
      const past = (digit < 0 ? 0 : digit) + String(option.number).length + 1;
      if (!pending.every((at) => leadingSpaces(framed(screen.drawn[at]!)) >= past)) break;
      run.unshift({ index, line: option, more: [...pending].reverse() });
      pending = [];
    } else if (line !== "" && !isBorder(line) && !promptFooters.has(normalisedLower(collapse(line)))) {
      pending.push(index);
    } else {
      break;
    }
    index -= 1;
  }
  return run.length === 0 ? null : run;
}

function matchMenu(screen: Screen, paneID: string): PromptMatch | null {
  const lines = screen.lines;
  const complete = screen.complete;
  // Under the options only the frame's end may follow: blank lines, the box's
  // bottom edge, a recorded footer. Anything else means the agent moved on.
  // A named session's rows under Claude's footer (the name rule) end it too,
  // under a frame drawn without a box only.
  const named = footerOverNameRule(screen.drawn, lines, claudeFooter);
  let end = named ?? lines.length - 1;
  let closedBox = false;
  let footer: string | null = null;
  // The footer's row (the frame's last row with words).
  let menuEnd = end;
  while (end >= 0) {
    const line = lines[end]!;
    if (line === "") {
      end -= 1;
    } else if (isBorder(line)) {
      if (isBoxBottom(line)) closedBox = true;
      end -= 1;
    } else if (promptFooters.has(normalisedLower(collapse(line)))) {
      footer = normalisedLower(collapse(line));
      menuEnd = end;
      end -= 1;
    } else {
      break;
    }
  }
  if (end < 0 || (named !== null && closedBox)) return null;
  const run = optionRun(screen, end, footer !== null);
  if (run === null) return null;
  const first = run[0]!.index;
  const parsed = run.map((entry) => entry.line);
  if (parsed.length < 2 || parsed.some((line, index) => line.number !== index + 1)) return null;
  // A wrapped option's label joins its rows with one space (display only: the key stays its number).
  const labels = run.map((entry) => stripShortcut([entry.line.text, ...entry.more.map((at) => lines[at]!)].join(" ")));
  // A menu with no box or footer (Grok's) has finished drawing only as a whole recorded menu.
  if (!closedBox && footer === null && !bareMenus.some((menu) => sameList(menu, labels.map(normalisedLower)))) return null;
  // The question: the nearest line above that asks. Codex draws the command
  // between it and the options, and (0.163.0) its Environment and Reason rows.
  const codexFrame = footer === codexFooter || footer === codexThreadFooter;
  const between: number[] = [];
  let index = first - 1;
  let questionEnd: number | null = null;
  while (index >= 0) {
    const line = lines[index]!;
    if (line === "") {
      index -= 1;
      continue;
    }
    if (isBorder(line) || isBullet(line) || optionLine(line) !== null) return null;
    if (codexFrame && isCodexBodyRow(lines, index)) {
      between.push(index);
      index -= 1;
      continue;
    }
    if (line.endsWith("?") && !line.startsWith("$ ")) {
      questionEnd = index;
      break;
    }
    between.push(index);
    index -= 1;
  }
  if (questionEnd === null) return null;
  let questionStart = findQuestionStart(lines, questionEnd, complete);
  if (questionStart === null || opensBox(lines, questionStart) !== closedBox) return null;
  let top: number;
  let body: [number, number];
  if (between.length === 0) {
    const opening = bodyTop(lines, questionStart, complete, false);
    if (opening === null) return null;
    // Claude Code 2.1.303 draws a dashed rule between its body and its
    // question. Without one the rows run up to the section header: the
    // question is its own row and the rows above it are its wrap; the rest is body.
    if (footer === claudeFooter && !closedBox && isSectionHeader(lines[opening]!) && questionStart === opening + 1) {
      let start = questionEnd;
      while (start > questionStart && mayBeWrapped(screen, start - 1, start + 1)) start -= 1;
      questionStart = start;
    }
    top = opening;
    body = [opening, questionStart];
  } else {
    top = questionStart;
    body = [questionEnd + 1, first];
  }
  // Today's two recorded unboxed frames (Claude Code 2.1.303's at a section
  // header; Codex 0.163.0's) are read whole even when their body wraps.
  const wrapsAtEdge = !closedBox && (codexFrame || (footer === claudeFooter && isSectionHeader(lines[top]!)));
  if (!wrapsAtEdge && mayBeWrapped(screen, body[0], body[1])) return null;
  const question = lines.slice(questionStart, questionEnd + 1).join(" ");
  const anyMarked = parsed.some((line) => line.marked);
  const options = parsed.map((line, at): PromptOption => {
    const label = labels[at]!;
    const lower = normalisedLower(label);
    return {
      key: String(line.number),
      label,
      isReturnDefault: anyMarked ? line.marked : at === 0,
      isSessionWide: sessionWide(lower),
      opensComposer: opensComposer(lower),
      keys: [String(line.number)],
    };
  });
  // What the reader knows of its frame: Claude Code's under a section header and Codex's command question have
  // words; any other menu (a box, Grok's bare one) only its rows.
  const claudeFrame = wrapsAtEdge && footer === claudeFooter;
  const words = claudeFrame ? claudeMenuWords(screen, top, questionStart, questionEnd, run) : codexFrame && !closedBox ? codexMenuWords(screen, questionStart, questionEnd, first, menuEnd, run) : null;
  const fingerprint: PromptFingerprint = {
    rules: fingerprintRules,
    paneID,
    question,
    body: framedBody(screen, body[0], body[1]),
    options: run.flatMap((entry) => [entry.line.drawn, ...entry.more.map((at) => framed(screen.drawn[at]!))]),
    ...(words === null ? {} : { words }),
  };
  // Claude's Bash frame keeps its command's rows and its description for the card.
  const claudeRun = footer === claudeFooter && !closedBox && isBashSection(lines[top]!) ? bashRun(screen, top, questionStart) : null;
  return {
    kind: "menu",
    question,
    options,
    context: contextLine(lines, top, questionStart, questionEnd, first, codexFrame),
    fingerprint,
    ...(claudeRun === null ? {} : { run: claudeRun }),
  };
}

// MARK: Claude's frame cut off at its top

/** A dashed rule (`╌`), the kind Claude Code 2.1.303 draws around a frame's body. */
function isDashedRule(line: string): boolean {
  return isRule(line) && line.includes("╌");
}

/**
 * What looks like Claude Code's approval frame whose top is above a full read.
 * Read from the bottom: Claude's footer the last row (blank rows under it
 * allowed, or a named session's rows: `footerOverNameRule`), blank rows, its options numbered from 1, the question right above
 * option 1 (its wrapped rows up to the dashed rule that closes the body), and
 * above that rule, up to the read's top, no section header, no bullet and no
 * rule but dashed ones. Null for anything else (a read holding the whole pane,
 * too).
 *
 * Never matched: the rows on screen cannot show
 * the command above them, nor that Claude drew them (printed output can look
 * the same), so nothing is answered from it. It asks for the taller read, and
 * names what the card and the pill may show.
 */
function cutFrame(screen: Screen): CutFrame | null {
  if (screen.complete) return null;
  const lines = screen.lines;
  let end = footerOverNameRule(screen.drawn, lines, claudeFooter) ?? lines.length - 1;
  while (end >= 0 && lines[end] === "") end -= 1;
  if (end < 0 || normalisedLower(collapse(lines[end]!)) !== claudeFooter) return null;
  end -= 1;
  while (end >= 0 && lines[end] === "") end -= 1;
  if (end < 0) return null;
  const run = optionRun(screen, end, true);
  if (run === null) return null;
  const parsed = run.map((entry) => entry.line);
  if (parsed.length < 2 || parsed.some((line, index) => line.number !== index + 1)) return null;
  const questionEnd = run[0]!.index - 1;
  if (questionEnd < 1 || !lines[questionEnd]!.endsWith("?")) return null;
  const questionStart = findQuestionStart(lines, questionEnd, false);
  if (questionStart === null || questionStart < 1 || !isDashedRule(lines[questionStart - 1]!)) return null;
  const closing = questionStart - 1;
  let opening = -1;
  for (let index = 0; index < closing; index += 1) {
    const line = lines[index]!;
    if (isSectionHeader(line) || isBullet(line) || (isBorder(line) && !isDashedRule(line))) return null;
    if (isDashedRule(line)) opening = index;
  }
  const question = lines.slice(questionStart, questionEnd + 1).join(" ");
  return { question, rows: lines.slice(opening + 1, closing).filter((line) => line !== ""), lines: tail(screen) };
}

/**
 * Claude Code 2.1.303's Bash frame from its header at `top`: the command's
 * rows between the first two dashed rules under it, as drawn (the frame's
 * padding off: the indentation every row shares;
 * blank rows kept inside, dropped at its ends), and the description above the
 * first rule (paragraphs told apart by where the terminal would have wrapped;
 * the one starting "Tip:" left out). Null without the two rules.
 */
function bashRun(screen: Screen, top: number, questionStart: number): ClaudeRun | null {
  const lines = screen.lines;
  const rules: number[] = [];
  for (let index = top + 1; index < questionStart && rules.length < 2; index += 1) if (isDashedRule(lines[index]!)) rules.push(index);
  if (rules.length < 2) return null;
  let start = rules[0]! + 1;
  let end = rules[1]!;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  if (start >= end) return null;
  const drawn = screen.drawn.slice(start, end).map(framed);
  const indent = Math.min(...drawn.filter((row) => row !== "").map(leadingSpaces));
  const paragraphs: string[][] = [];
  for (let index = top + 1; index < rules[0]!; index += 1) {
    const line = lines[index]!;
    const current = paragraphs.at(-1);
    if (line === "") paragraphs.push([]);
    else if (current !== undefined && current.length > 0 && wrapsInto(screen, index - 1, index)) current.push(line);
    else paragraphs.push([line]);
  }
  const described = paragraphs.filter((rows) => rows.length > 0 && !/^tip:/iu.test(rows[0]!)).map((rows) => rows.join(" "));
  return { rows: drawn.map((row) => row.slice(indent)), description: described.length === 0 ? null : described.join(" ") };
}

/** Whether the unboxed row `index` may go on in row `next` as the terminal's wrap: the next row's first word would not have fit after it. */
function wrapsInto(screen: Screen, index: number, next: number): boolean {
  const word = cells(screen.lines[next]!.split(/\s/u)[0] ?? "");
  return cells(dropTrailingBlanks(screen.drawn[index]!)) + 1 + word > screen.width - unboxedMargin;
}

// MARK: [y/N]

const yesNoPattern = /[[(]\s*([yY])(?:es)?\s*\/\s*([nN])(?:o)?\s*[\])]\s*[:?]?\s*$/u;

function matchYesNo(screen: Screen, paneID: string): PromptMatch | null {
  const lines = screen.lines;
  const complete = screen.complete;
  // A line prompt is the last line on screen.
  const last = lastIndex(lines, (line) => line !== "");
  if (last < 0) return null;
  const line = lines[last]!;
  if (isBorder(line)) return null;
  const found = yesNoPattern.exec(line);
  if (found === null) return null;
  const yes = found[1]!;
  const no = found[2]!;
  let questionEnd = last;
  if (collapse(line.slice(0, found.index)) === "") {
    // The bracket on a line of its own: the question ends just above.
    if (last === 0 || lines[last - 1] === "" || isBorder(lines[last - 1]!)) return null;
    questionEnd = last - 1;
  }
  const questionStart = findQuestionStart(lines, questionEnd, complete);
  if (questionStart === null || opensBox(lines, questionStart)) return null;
  const top = bodyTop(lines, questionStart, complete, true);
  if (top === null || mayBeWrapped(screen, top, questionStart)) return null;
  const question = lines.slice(questionStart, last + 1).join(" ");
  const yesDefault = yes === "Y" && no === "n";
  const noDefault = no === "N" && yes === "y";
  const command = commandIn(lines, top, questionStart);
  return {
    kind: "yesNo",
    question,
    options: [
      { key: "y", label: "Allow", isReturnDefault: yesDefault, isSessionWide: false, opensComposer: false, keys: ["y", "Enter"] },
      { key: "n", label: "Deny", isReturnDefault: noDefault, isSessionWide: false, opensComposer: false, keys: ["n", "Enter"] },
    ],
    context: command === null ? null : { type: "command", text: command.text },
    fingerprint: { rules: fingerprintRules, paneID, question, body: framedBody(screen, top, questionStart), options: ["y", "n"] },
  };
}

// MARK: the frame

/**
 * The first line of the question ending at `end`: its wrapped lines run up to
 * a blank line, a box edge, a bullet, a command, a section header or an option.
 * Null when that cannot be told (too many lines, or the top of a full read).
 */
function findQuestionStart(lines: readonly string[], end: number, complete: boolean): number | null {
  let start = end;
  while (start > 0) {
    const above = lines[start - 1]!;
    if (above === "" || isBorder(above) || isBullet(above) || above.startsWith("$ ") || isSectionHeader(above) || optionLine(above) !== null) {
      return start;
    }
    start -= 1;
    if (end - start + 1 > questionLineLimit) return null;
  }
  return complete ? 0 : null;
}

/**
 * Where the body of a prompt opens, above its question: a section header, the
 * agent's bullet line, a command (`$ …`, for line prompts) or the top of a box
 * that holds the body. Lines inside nested boxes are body. Null when the
 * opening is cut off by a full read.
 */
function bodyTop(lines: readonly string[], questionStart: number, complete: boolean, commandOpens: boolean): number | null {
  let depth = 0;
  let content = false;
  for (let index = questionStart - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (isBoxBottom(line)) {
      depth += 1;
    } else if (isBoxTop(line)) {
      if (depth > 0) depth -= 1;
      else if (content) return index;
    } else if (depth === 0 && line !== "" && !isBorder(line)) {
      if (isSectionHeader(line) || isBullet(line) || (commandOpens && line.startsWith("$ "))) return index;
      content = true;
    }
  }
  return complete ? 0 : null;
}

/** Whether a box still open (its top edge without a bottom) sits above `index`, before the agent's bullet line. */
function opensBox(lines: readonly string[], index: number): boolean {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const line = lines[at]!;
    if (isBoxBottom(line)) {
      depth += 1;
    } else if (isBoxTop(line)) {
      if (depth === 0) return true;
      depth -= 1;
    } else if (depth === 0 && isBullet(line)) {
      return false;
    }
  }
  return false;
}

/** The body's rows for the fingerprint, each as the frame draws it; rows of nothing but box drawing are the frame's own. */
function framedBody(screen: Screen, start: number, end: number): string[] {
  const rows: string[] = [];
  for (let index = start; index < end; index += 1) {
    if (!isRule(screen.lines[index]!)) rows.push(framed(screen.drawn[index]!));
  }
  return rows;
}

/**
 * A row as the frame draws it: each box edge on either side comes off with the
 * one cell of padding beside it, and so do the blanks out to its edge.
 * Everything else stays as drawn.
 */
export function framed(drawn: string): string {
  let row = drawn;
  let edges = 0;
  for (;;) {
    const rest = row.replace(/^ +/u, "");
    const first = rest.charAt(0);
    if (first === "" || !borders.has(first)) break;
    row = rest.slice(1);
    if (row.startsWith(" ")) row = row.slice(1);
    edges += 1;
  }
  let text = dropTrailingBlanks(row);
  while (edges > 0 && text !== "" && borders.has(text.charAt(text.length - 1))) {
    text = dropTrailingBlanks(text.slice(0, -1));
    edges -= 1;
  }
  return text;
}

// MARK: the words an answer is bound to

/** Cells `text` takes as a prefix before a part's words: one a character (a number, a blank, a mark). */
function prefixCells(text: string): number {
  return [...text].length;
}

/**
 * A numbered menu's option as a section (words.ts): its first row from its number on, the cells before it blank
 * (the mark is never part of the question), and the rows that continue its label, each its label's column in.
 * An option starts only where the reader parsed one.
 */
function menuOptionSection(screen: Screen, entry: RunEntry): WrapSection | null {
  const row = framed(screen.drawn[entry.index]!);
  const lead = leadingSpaces(row);
  const found = optionPattern.exec(row.slice(lead));
  if (found === null || found.indices === undefined) return null;
  const numberAt = lead + found.indices[2]![0];
  const labelAt = lead + found.indices[3]![0];
  return {
    rows: [" ".repeat(prefixCells(row.slice(0, numberAt))) + row.slice(numberAt), ...entry.more.map((at) => framed(screen.drawn[at]!))],
    next: prefixCells(row.slice(0, labelAt)),
    lines: false,
  };
}

/** A diff line's head in Claude Code's Edit and Create frames: its number, maybe its mark, the blank before the line. */
const claudeDiffHead = /^ *\d+(?: [-+])?(?: |$)/u;

/**
 * Claude Code's diff rows split into its lines: a row at least its line's head in continues that line (Ink wraps a
 * line under its own text); any other row starts a line with its own head. Null for a row that does neither.
 */
function claudeDiffSections(rows: readonly string[]): WrapSection[] | null {
  const sections: { rows: string[]; next: number }[] = [];
  for (const row of rows) {
    if (row.trim() === "") {
      sections.push({ rows: [], next: 0 });
      continue;
    }
    const current = sections.at(-1);
    if (current !== undefined && current.rows.length > 0 && leadingSpaces(row) >= current.next) {
      current.rows.push(row);
      continue;
    }
    const head = claudeDiffHead.exec(row);
    if (head === null) return null;
    sections.push({ rows: [row], next: prefixCells(head[0]) });
  }
  return sections.filter((section) => section.rows.length > 0).map((section) => ({ ...section, lines: false }));
}

/**
 * The words of Claude Code's unboxed frame (2.1.303's, under a section header): its width is its top rule's (the
 * `─` row over the header), its text's edge a cell short of it; its rows wrap as Ink wraps them; its text sections
 * are one cell in. Each part: the
 * question's rows; the header, then the rows between the dashed rules as the description (or, in an Edit or Create
 * frame, the file's name) and the command (or the diff, a section a line); each option. Null without the top rule.
 */
function claudeMenuWords(screen: Screen, top: number, questionStart: number, questionEnd: number, run: readonly RunEntry[]): FingerprintWords | null {
  if (top < 1) return null;
  const rule = dropTrailingBlanks(screen.drawn[top - 1]!);
  if (!/^─+$/u.test(rule)) return null;
  const width = prefixCells(rule);
  const diff = !isBashSection(screen.lines[top]!) && (isCreateSection(screen.lines[top]!) || normalisedLower(collapse(screen.lines[top]!)) === "edit file");
  const segments: string[][] = [[]];
  for (let index = top + 1; index < questionStart; index += 1) {
    if (isRule(screen.lines[index]!)) segments.push([]);
    else segments.at(-1)!.push(dropTrailingBlanks(screen.drawn[index]!));
  }
  const body: WrapSection[] = [{ rows: [dropTrailingBlanks(screen.drawn[top]!)], next: 1, lines: false }];
  for (const [at, rows] of segments.entries()) {
    if (diff && at === 1) {
      const lines = claudeDiffSections(rows);
      if (lines === null) return { question: null, body: null, options: null };
      body.push(...lines);
    } else {
      // The description and the command may hold line breaks; an Edit frame's file name does not.
      body.push({ rows, next: 1, lines: !(diff && at === 0) });
    }
  }
  const options = run.map((entry) => menuOptionSection(screen, entry));
  const question: WrapSection = { rows: screen.drawn.slice(questionStart, questionEnd + 1).map(dropTrailingBlanks), next: 1, lines: false };
  // Ink draws the text one cell in, and its right edge is one cell short of the rule (narrow39: a 37-cell row wrapped
  // with its blank kept and a 33-cell row could not take a 6-cell word, so the edge is 38 of 39), or the rule's own
  // where a text row reaches it; a cell short of that where no row says otherwise. The options reach the rule
  // (narrow54: an option row of 54 cells under a 54-cell rule).
  const textRows = [...body, question].flatMap((section) => section.rows);
  const reach = widest(textRows) >= width ? width : width - 1;
  const text: WrapFrame = { style: "ink", low: Math.max(reach - 1, widest(textRows)), high: reach };
  const optionFrame: WrapFrame = { style: "ink", low: width, high: width };
  return { ...questionWords([question], text), body: partText(body, text), options: options.some((section) => section === null) ? null : partText(options as WrapSection[], optionFrame) };
}

/**
 * The words of Codex's command question (0.163.0's, over its footer). The frame shows no width: its edge is
 * somewhere past its widest row, from the question to the footer, and with the pane's width the screen was read at
 * (where known), at most that width and at least two cells short of it (codex-0.163.0-narrow51-dialog: rows of 50 at
 * 51 columns). Its question, Reason and options wrap as textwrap wraps them (Unicode line breaking: after `/`, `-`
 * and the like with no blank, narrow51's `/private/tmp/` over `z-narrow2-out/`), two cells in; its command (the `$`
 * paragraph) at blanks only (narrow51: `$ echo narrow-codex >` over the whole path, which the other wrapper would
 * have broken after `z-narrow2-`). Each part: the question's rows; each paragraph between it and the options
 * (Environment, Reason, the command); each option. An option's row end the frame cannot tell is not settled by the
 * command it quotes: the option's prefix is drawn from Codex's own token list, so the command's
 * characters cannot rule out the other text (codex-0.163.0-dialog: `results-` over `day-one/...` has no text and is
 * compared by its rows).
 */
function codexMenuWords(screen: Screen, questionStart: number, questionEnd: number, first: number, end: number, run: readonly RunEntry[]): FingerprintWords {
  const rows = (from: number, to: number): string[] => screen.drawn.slice(from, to).map(dropTrailingBlanks);
  const frame = edgeFromColumns({ style: "textwrap", low: widest(rows(questionStart, end + 1)), high: null }, screen.columns, codexEdgeMargin);
  const paragraphs: WrapSection[] = [];
  let current: string[] = [];
  const close = (): void => {
    if (current.length > 0) paragraphs.push({ rows: current, next: 2, lines: true, ...(current[0]!.startsWith("  $ ") ? { style: "words" as const } : {}) });
    current = [];
  };
  for (const row of rows(questionEnd + 1, first)) {
    if (row.trim() === "") close();
    else current.push(row);
  }
  close();
  const options = run.map((entry) => menuOptionSection(screen, entry));
  return {
    ...questionWords([{ rows: rows(questionStart, questionEnd + 1), next: 2, lines: false }], frame),
    body: partText(paragraphs, frame),
    options: options.some((section) => section === null) ? null : partText(options as WrapSection[], frame),
  };
}

/** How far in from the pane's edge Codex's text may end, in cells (narrow51: one; one more for what was not seen). */
const codexEdgeMargin = 2;

// MARK: wrapping

const diffRow = /^(?:\d+ [ +-]|[+-](?: |$))/u;

/**
 * Whether a body row in `start..<end` may go on in the row below it as the
 * terminal's wrap rather than as a line of its own (a wrap does not show how
 * many spaces stood at the break).
 */
function mayBeWrapped(screen: Screen, start: number, end: number): boolean {
  for (let index = start; index + 1 < end; index += 1) {
    const row = screen.lines[index]!;
    const below = screen.lines[index + 1]!;
    if (row === "" || below === "" || isRule(row) || isRule(below) || startsAnew(below, row)) continue;
    const word = cells(below.split(/\s/u)[0] ?? "");
    const room = roomBeforeEdge(screen.drawn[index]!);
    if (room !== null) {
      if (word + 1 > room) return true;
    } else if (cells(dropTrailingBlanks(screen.drawn[index]!)) + 1 + word > screen.width - unboxedMargin) {
      return true;
    }
  }
  return false;
}

function startsAnew(below: string, row: string): boolean {
  if (isBullet(below) || isSectionHeader(below) || below.startsWith("$ ")) return true;
  if (isSectionHeader(row) || row.endsWith("\\")) return true;
  return diffRow.test(below) && (diffRow.test(row) || editHeader.test(row));
}

/** For a row inside a box: the blank cells before the innermost right edge, less its padding cell; null outside a box. */
function roomBeforeEdge(drawn: string): number | null {
  let rest = drawn;
  let edges = 0;
  for (;;) {
    const next = rest.replace(/^ +/u, "");
    const first = next.charAt(0);
    if (first === "" || !borders.has(first)) break;
    rest = next.slice(1);
    edges += 1;
  }
  if (edges === 0) return null;
  let row = dropTrailingBlanks(drawn);
  for (let edge = 1; edge < edges; edge += 1) {
    if (row === "" || !borders.has(row.charAt(row.length - 1))) return null;
    row = dropTrailingBlanks(row.slice(0, -1));
  }
  if (row === "" || !borders.has(row.charAt(row.length - 1))) return null;
  const inner = row.slice(0, -1);
  return inner.length - inner.replace(/ +$/u, "").length - 1;
}

/** Terminal cells: words.ts `cells` (two for a wide character, else one; counting one too wide only makes a wrap more likely). */

// MARK: context line

const editHeader = /^(?:[●⏺•]\s*)?(?:Update|Edit|Write|Create)(?:\s|\(|$)/u;
const bashCall = /^(?:[●⏺•]\s*)?Bash\((.+)\)$/u;
const diffPattern = /^(?:\d+\s*)?([+-])(?![+-])/u;

/** The card's one line, from the frame only. */
function contextLine(
  lines: readonly string[],
  top: number,
  questionStart: number,
  questionEnd: number,
  first: number,
  codexFrame: boolean,
): PromptContext | null {
  // A command between the question and the options (Codex) is the prompt's own;
  // in Codex's frame a row right under it is its wrap: the first row and " …".
  const between = commandIn(lines, questionEnd + 1, first);
  if (between !== null) {
    const next = between.index + 1;
    const wraps = codexFrame && next < first && lines[next] !== "" && !isBorder(lines[next]!);
    return { type: "command", text: wraps ? `${between.text} …` : between.text };
  }
  // Claude Code 2.1.303 draws its Bash command between two dashed rules, under a Tip and a description.
  if (isBashSection(lines[top]!)) {
    const rows = dashedRows(lines, top + 1, questionStart);
    if (rows !== null) return rows.length === 0 ? null : { type: "command", text: rows.length > 1 ? `${rows[0]} …` : rows[0]! };
  }
  // Its Write question: the file's name, the rows under "Create file" down to the new file's dashed rule.
  if (isCreateSection(lines[top]!)) {
    const rows = nameRows(lines, top + 1, questionStart);
    if (rows !== null) return { type: "file", name: rows.length > 1 ? `${rows[0]} …` : rows[0]! };
  }
  // Above the question, whichever is nearer: the command box or the edit whose diff is shown.
  const above = commandIn(lines, top, questionStart);
  let header = -1;
  for (let index = questionStart - 1; index >= top; index -= 1) {
    if (editHeader.test(lines[index]!)) {
      header = index;
      break;
    }
  }
  if (above !== null && (header < 0 || above.index > header)) return { type: "command", text: above.text };
  if (header < 0) return null;
  let added = 0;
  let removed = 0;
  for (let index = header + 1; index < questionStart; index += 1) {
    const sign = diffPattern.exec(lines[index]!)?.[1];
    if (sign === "+") added += 1;
    else if (sign === "-") removed += 1;
  }
  return added + removed === 0 ? null : { type: "diff", added, removed };
}

/** The nearest command line in `start..<end` and its index. */
function commandIn(lines: readonly string[], start: number, end: number): { index: number; text: string } | null {
  if (start >= end) return null;
  for (let index = end - 1; index >= start; index -= 1) {
    const line = lines[index]!;
    if (line.startsWith("$ ")) return { index, text: trimWhitespace(line.slice(2)) };
    const call = bashCall.exec(line);
    if (call !== null) return { index, text: call[1]! };
    if (line.toLowerCase() === "bash command") {
      const body = lines.slice(index + 1, end).find((row) => row !== "" && !isBorder(row));
      if (body !== undefined && !body.endsWith("?")) return { index, text: body };
    }
  }
  return null;
}

/** The rows between the first two dashed rules (`╌`) in `start..<end`, blanks left out; null when there are not two. */
function dashedRows(lines: readonly string[], start: number, end: number): string[] | null {
  const rules: number[] = [];
  for (let index = start; index < Math.max(start, end); index += 1) {
    if (isRule(lines[index]!) && lines[index]!.includes("╌")) rules.push(index);
  }
  if (rules.length < 2) return null;
  return lines.slice(rules[0]! + 1, rules[1]!).filter((row) => row !== "");
}

function isBashSection(line: string): boolean {
  return normalisedLower(collapse(line)) === "bash command";
}

function isCreateSection(line: string): boolean {
  return normalisedLower(collapse(line)) === "create file";
}

/** The non-empty rows in `start..<end` above the first dashed rule; null without one. */
function nameRows(lines: readonly string[], start: number, end: number): string[] | null {
  if (start >= end) return null;
  let rule = -1;
  for (let index = start; index < end; index += 1) {
    if (isRule(lines[index]!) && lines[index]!.includes("╌")) {
      rule = index;
      break;
    }
  }
  if (rule < 0) return null;
  const rows = lines.slice(start, rule).filter((row) => row !== "");
  return rows.length === 0 ? null : rows;
}

// MARK: lines

const borders: ReadonlySet<string> = new Set(["│", "┃", "║", "╎", "┆", "▕", "▏"]);
const bullets: ReadonlySet<string> = new Set(["●", "⏺", "•"]);
// eslint-disable-next-line no-control-regex
const escapes = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

/** Space, tab and the Unicode space separators (Swift's CharacterSet.whitespaces). */
const edgeSpace = /^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu;

export function trimWhitespace(text: string): string {
  return text.replace(edgeSpace, "");
}

/** A screen line without terminal escapes and the box it is drawn in. */
export function cleanRow(raw: string): string {
  let line = trimWhitespace(withoutEscapes(raw).replace(/ /gu, " "));
  while (line !== "" && borders.has(line.charAt(0))) line = trimWhitespace(line.slice(1));
  while (line !== "" && borders.has(line.charAt(line.length - 1))) line = trimWhitespace(line.slice(0, -1));
  return line;
}

export function withoutEscapes(raw: string): string {
  return raw.includes("\u001b") ? raw.replace(escapes, "") : raw;
}

function dropTrailingBlanks(text: string): string {
  return text.replace(/\s+$/u, "");
}

/** A row of nothing but box drawing: an edge or a rule (a row of `-` or `=` is kept). */
function isRule(line: string): boolean {
  if (line === "") return false;
  for (const character of line) {
    const value = character.codePointAt(0)!;
    if (!((value >= 0x2500 && value <= 0x257f) || character === " ")) return false;
  }
  return true;
}

export function isBorder(line: string): boolean {
  if (line === "") return false;
  for (const character of line) {
    const value = character.codePointAt(0)!;
    if (!((value >= 0x2500 && value <= 0x257f) || character === " " || character === "-" || character === "=")) return false;
  }
  return true;
}

function isBoxTop(line: string): boolean {
  return isBorder(line) && (line.startsWith("╭") || line.startsWith("┌"));
}

function isBoxBottom(line: string): boolean {
  return isBorder(line) && (line.startsWith("╰") || line.startsWith("└"));
}

function isBullet(line: string): boolean {
  return line !== "" && bullets.has(chars(line)[0]!);
}

function isSectionHeader(line: string): boolean {
  return sectionHeaders.has(normalisedLower(collapse(line)));
}

/** An unmatched reading's last rows: the blank and border rows left out, and a named session's rows under Claude's footer. */
function tail(screen: Screen): string[] {
  const lines = screen.lines;
  const footer = footerOverNameRule(screen.drawn, lines, claudeFooter) ?? footerOverNameRule(screen.drawn, lines, claudeAskFooter);
  const shown = footer === null ? lines : lines.slice(0, footer + 1);
  return shown.filter((line) => line !== "" && !isBorder(line)).slice(-unmatchedLineCount);
}

export function collapse(text: string): string {
  return text
    .split(/\s+/u)
    .filter((word) => word !== "")
    .join(" ");
}

function stripShortcut(text: string): string {
  return collapse(text.replace(shortcutHint, ""));
}

export function normalisedLower(text: string): string {
  return text.toLowerCase().replace(/’/gu, "'");
}

/** "Yes, and switch to auto mode": a mode's name right after "yes, and switch to", ending the phrase. */
const modeSwitch = /^yes, and switch to (?:(?:[a-z-]+ ){1,3}mode|accept edits)(?=$|[\s·(,])/u;

function sessionWide(lower: string): boolean {
  return ["this session", "don't ask", "do not ask", "always", "allow all", "for all "].some((phrase) => lower.includes(phrase)) || modeSwitch.test(lower);
}

function opensComposer(lower: string): boolean {
  return lower.startsWith("no") && ["tell", "feedback", "differently", "instead", "what to"].some((word) => lower.includes(word));
}

function chars(text: string): string[] {
  return Array.from(text);
}

function length(text: string): number {
  return chars(text).length;
}

function leadingSpaces(text: string): number {
  return text.length - text.replace(/^ +/u, "").length;
}

function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index]!)) return index;
  return -1;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

// MARK: - Grok 1.0.70's approval frame

/** The footer under Grok's frame: `1/<n>:select`, then its other keys. */
const grokFooter = /^1\/(\d{1,2}):select(?:\s|$)/u;
/** One of Grok's options: its number, its mark (`○`/`◯` plain, `●`/`◉` the one Return takes), its words. */
const grokOption = /^(\d{1,2}) \(([○◯●◉])\) (\S.*)$/u;
const grokMarked: ReadonlySet<string> = new Set(["●", "◉"]);
/** Grok's mark as the fingerprint keeps it: where the mark sits is not part of the question. */
const grokNeutralMark = "( )";

/** Whether `row` (a read's row, escapes removed) is Grok's footer: `1/<n>:select …` at the margin. */
export function grokFooterCount(row: string): number | null {
  const found = grokFooter.exec(trimWhitespace(row));
  return found === null ? null : Number(found[1]);
}

/** A row of the frame's block as drawn: the column of its `┃` and everything after the bar (trailing blanks dropped). */
interface GrokBarRow {
  readonly column: number;
  readonly inner: string;
}

/** `row` as a row of the frame's block (a `┃` at its margin, after spaces); null for a row outside it. */
function grokBarRow(row: string): GrokBarRow | null {
  const text = row.replace(/^ +/u, "");
  if (!text.startsWith("┃")) return null;
  return { column: row.length - text.length, inner: dropTrailingBlanks(text.slice(1)) };
}

/** The frame's padding after the bar, from its title row: a recorded frame draws one cell, Grok 1.0.70 live two. */
const grokTitlePadding = /^( {1,2})›/u;

/**
 * The block's rows without the frame's own padding, everything after it kept
 * as drawn. A wrapped command row's leading spaces are part of the command, so
 * they are part of the fingerprint. The padding is the title row's, the one or
 * two cells between `┃` and `›`, and it is taken off every row the same way.
 * Every row's bar must sit in the title's column, and every row that is not
 * blank must start with the full padding. Otherwise the padding cannot be told
 * apart from the command, and the frame is not read (null).
 */
function grokBlock(drawn: readonly GrokBarRow[]): string[] | null {
  const titleRow = drawn.find((row) => row.inner !== "");
  const padding = titleRow === undefined ? undefined : grokTitlePadding.exec(titleRow.inner)?.[1];
  if (titleRow === undefined || padding === undefined) return null;
  const block: string[] = [];
  for (const row of drawn) {
    if (row.column !== titleRow.column) return null;
    if (row.inner === "") block.push("");
    else if (row.inner.startsWith(padding)) block.push(row.inner.slice(padding.length));
    else return null;
  }
  return block;
}

interface GrokOptionRow {
  readonly number: number;
  readonly marked: boolean;
  readonly words: string;
}

function grokOptionRow(row: string): GrokOptionRow | null {
  const found = grokOption.exec(row);
  return found === null ? null : { number: Number(found[1]), marked: grokMarked.has(found[2]!), words: found[3]! };
}

/**
 * Grok Build 1.0.70's approval frame at the screen's end, read whole: the
 * footer `1/<n>:select …` is the last row; above it (blank rows between) the
 * `┃` block, which opens with the `›` title row (its wrap under it; blank bar
 * rows above it, as Grok draws it live), then the command, its first row under
 * `│` (each further row of it under `│` or wrapped plain), then Grok's key
 * hints (`← → …`), blank bar rows, and the options `N (○) words` numbered 1 to
 * n (a wrapped option's rows under it), n the footer's. At most one option is
 * marked. The block's top cut off by a full read, anything else in it, or a
 * footer that does not count its options: null. The card shows Grok's options
 * in its order and words; the fingerprint keeps the block's rows as drawn,
 * the marks left out (only the frame's padding after the bar comes off, see
 * `grokBlock`).
 */
export function grokFrame(text: string, paneID: string): PromptMatch | null {
  const raw = readRows(text);
  const rows = raw.map((row) => withoutEscapes(row).replace(/\u00a0/gu, " "));
  const complete = raw.length < promptReadLines;
  let end = rows.length - 1;
  while (end >= 0 && trimWhitespace(rows[end]!) === "") end -= 1;
  if (end < 0) return null;
  const count = grokFooterCount(rows[end]!);
  if (count === null || count < 2) return null;
  let last = end - 1;
  while (last >= 0 && trimWhitespace(rows[last]!) === "") last -= 1;
  if (last < 0 || grokBarRow(rows[last]!) === null) return null;
  let first = last;
  while (first > 0 && grokBarRow(rows[first - 1]!) !== null) first -= 1;
  // The block's top must be on screen: a full read that starts inside it may have cut its title off.
  if (first === 0 && !complete) return null;
  // Only the frame's padding comes off; the rest of each row is kept as drawn.
  const block = grokBlock(rows.slice(first, last + 1).map((row) => grokBarRow(row)!));
  if (block === null) return null;
  let at = 0;
  // The live frame opens with a blank bar row above the title.
  while (at < block.length && block[at] === "") at += 1;
  // The title row (`›`), and its wrap down to the command.
  const titleRow = block[at] ?? "";
  if (!titleRow.startsWith("›")) return null;
  const title = [trimWhitespace(titleRow.slice(1))];
  const body = [titleRow];
  at += 1;
  while (at < block.length && block[at] !== "" && !block[at]!.startsWith("│") && !block[at]!.startsWith("←") && grokOptionRow(block[at]!) === null) {
    title.push(trimWhitespace(block[at]!));
    body.push(block[at]!);
    at += 1;
  }
  if (title[0] === "") return null;
  // The command: its first row under `│`, the rest under `│` or wrapped plain, down to a blank row, a hint or an option.
  if (at >= block.length || !block[at]!.startsWith("│")) return null;
  const command: string[] = [];
  while (at < block.length && block[at] !== "" && !block[at]!.startsWith("←") && grokOptionRow(block[at]!) === null) {
    const row = block[at]!;
    command.push(row.startsWith("│") ? trimWhitespace(row.slice(1)) : trimWhitespace(row));
    body.push(row);
    at += 1;
  }
  if (command.length === 0 || command[0] === "") return null;
  // Grok's key hints for the frame ("← → narrow scope · e edit pattern").
  while (at < block.length && block[at]!.startsWith("←")) {
    body.push(block[at]!);
    at += 1;
  }
  while (at < block.length && block[at] === "") at += 1;
  // The options, each with its wrapped rows; then only blank bar rows.
  const options: { row: GrokOptionRow; rows: string[] }[] = [];
  while (at < block.length && block[at] !== "") {
    const row = block[at]!;
    const option = grokOptionRow(row);
    if (option !== null) options.push({ row: option, rows: [row] });
    else if (options.length > 0) options[options.length - 1]!.rows.push(row);
    else return null;
    at += 1;
  }
  while (at < block.length && block[at] === "") at += 1;
  if (at < block.length) return null;
  if (options.length !== count || options.some((option, index) => option.row.number !== index + 1)) return null;
  if (options.filter((option) => option.row.marked).length > 1) return null;
  const question = title.join(" ");
  return {
    kind: "grok",
    question,
    options: options.map(({ row, rows: drawn }): PromptOption => {
      // Grok's words, as it draws them (a wrapped option's rows joined by one space; display only).
      const label = [row.words, ...drawn.slice(1).map(trimWhitespace)].join(" ");
      const lower = normalisedLower(label);
      return {
        key: String(row.number),
        label,
        isReturnDefault: row.marked,
        isSessionWide: sessionWide(lower) || lower.startsWith("never "),
        // "No, reject (type to add feedback)" answers with no feedback: the box never answers it.
        opensComposer: false,
        keys: [String(row.number)],
      };
    }),
    context: { type: "command", text: command.join("\n") },
    fingerprint: {
      rules: fingerprintRules,
      paneID,
      question,
      body,
      options: options.flatMap(({ rows: drawn }) => [drawn[0]!.replace(/\([○◯●◉]\)/u, grokNeutralMark), ...drawn.slice(1)]),
    },
  };
}

/**
 * Some part of Grok's frame is on screen (its footer, a
 * `┃ ›` title row or a `┃ N (○) words` option row), whole or not.
 */
export function grokTrace(text: string): boolean {
  return readRows(text).some((raw) => {
    const row = withoutEscapes(raw).replace(/\u00a0/gu, " ");
    if (grokFooterCount(row) !== null) return true;
    // Any padding: a trace keeps a mark or a read going, it is never answered.
    const inner = grokBarRow(row)?.inner.replace(/^ +/u, "") ?? null;
    return inner !== null && (inner.startsWith("›") || grokOptionRow(inner) !== null);
  });
}

// MARK: - Codex 0.166.0's tool-call question

/** The footer under Codex's one-field form, compared whole (collapsed, lowercased). */
export const codexFormFooter = "enter to submit | esc to cancel";
/** The form's progress row above its prompt: `Field i/n`, maybe `(k required unanswered)`. */
const codexFieldRow = /^Field (\d+)\/(\d+)(?: \(\d+ required unanswered\))?$/u;
/** The header of a tool call Codex asks about: `Allow this request?`, or `Allow <name> to …`. */
const codexFormHeader = /^Allow (?:this request\?|\S.*? to \S.*)$/u;
/** A tool call's options, in Codex's order: Allow first, Cancel last, the two that remember between them when offered. */
export const codexFormLabels: readonly string[] = ["Allow", "Allow for this session", "Always allow", "Cancel"];
/** Longest first, so `Allow for this session` is not read as `Allow`. */
const codexLabelsByLength = [...codexFormLabels].sort((a, b) => b.length - a.length);
/** An option row from the form's margin: the mark's cell (`›` or blank), a space, the number, `. `, the rest. */
const codexOptionPattern = /^([› ]) (\d)\. (\S.*)$/u;
/** Cells from the margin to an option's label (`› 1. `): a row under an option indented past them continues it. */
const codexOptionIndent = 5;

interface CodexOptionRow {
  readonly number: number;
  readonly marked: boolean;
  readonly label: string;
  /** The description's part on the option's own row ("" when it starts on the row below). */
  readonly detail: string;
}

/** `row` (escapes removed, trailing blanks dropped) as one of the form's option rows at `margin`; null for any other row. */
function codexOptionRow(row: string, margin: number): CodexOptionRow | null {
  if (leadingSpaces(row) < margin || row.length <= margin) return null;
  const found = codexOptionPattern.exec(row.slice(margin));
  if (found === null) return null;
  const rest = found[3]!;
  for (const label of codexLabelsByLength) {
    if (rest === label) return { number: Number(found[2]), marked: found[1] === "›", label, detail: "" };
    // The description starts at max name width + 2: two spaces or more after the label.
    if (rest.startsWith(`${label}  `)) return { number: Number(found[2]), marked: found[1] === "›", label, detail: trimWhitespace(rest.slice(label.length)) };
  }
  return null;
}

/** `row` as the form's progress row at `margin`: its field and the fields it counts; null for any other row. */
function codexField(row: string, margin: number): { readonly index: number; readonly total: number } | null {
  if (leadingSpaces(row) !== margin) return null;
  const found = codexFieldRow.exec(row.slice(margin));
  return found === null ? null : { index: Number(found[1]), total: Number(found[2]) };
}

/** The rows of a read as drawn: escapes removed, no-break spaces as spaces, trailing blanks dropped. */
function drawnRows(text: string): string[] {
  return readRows(text).map((row) => dropTrailingBlanks(withoutEscapes(row).replace(/ /gu, " ")));
}

/**
 * The rows as read, for a fingerprint: only escape sequences (none in a text read) and the carriage return of a
 * CRLF line end removed; blank rows, every space and no-break space kept.
 */
function rawRows(text: string): string[] {
  return readRows(text).map(withoutEscapes);
}

/**
 * Codex 0.166.0's tool-call question at the screen's end, read whole
 * (codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs, a one-field
 * approval form), every row at the menu's margin:
 *
 *       Field 1/1
 *       Allow Calendar to create an event
 *
 *       Calendar: primary
 *       Title: Roadmap review
 *
 *       › 1. Allow   Run the tool and continue
 *         2. Cancel  Cancel this tool call
 *       enter to submit | esc to cancel
 *
 * The footer is the last row (blank rows above it allowed: the options' area
 * may be taller than they are). Above it the options: `› N. label  description`
 * (the mark on any one, or none), numbered 1 to n, their labels a tool call's
 * in Codex's order (`Allow`, maybe `Allow for this session` and `Always allow`,
 * `Cancel`), each with a description; a row under an option indented past its
 * number continues its description (a narrow pane wraps it under its column).
 * Right above option 1 the header (`Allow this request?` or `Allow <name> to
 * …`, its wrapped rows joined), or a blank row, the parameter rows and a blank
 * row under the header. Above the header the `Field 1/1` row or, without it, a
 * blank row. Two fields or more, a message-only form (Deny), a boolean or text
 * form, a header cut off by the read, anything else in it: null.
 *
 * The fingerprint: the header, the rows down to option 1 (the parameters) and
 * the option rows, as drawn (the mark's cell left blank); the `Field` row and
 * the blank rows above the footer are not part of it.
 */
export function codexForm(text: string, paneID: string, columns: number | null = null): PromptMatch | null {
  const rows = drawnRows(text);
  let end = rows.length - 1;
  while (end >= 0 && rows[end] === "") end -= 1;
  if (end < 0) return null;
  const margin = leadingSpaces(rows[end]!);
  if (normalisedLower(collapse(rows[end]!)) !== codexFormFooter) return null;
  // The options: blank rows above the footer, then one block of rows down from option 1.
  let last = end - 1;
  while (last >= 0 && rows[last] === "") last -= 1;
  if (last < 0) return null;
  let top = last;
  while (top > 0 && rows[top - 1] !== "") top -= 1;
  let first = -1;
  for (let index = top; index <= last; index += 1) {
    if (codexOptionRow(rows[index]!, margin) !== null) {
      first = index;
      break;
    }
  }
  if (first < 0) return null;
  const options: { row: CodexOptionRow; details: string[]; drawn: string[] }[] = [];
  for (let index = first; index <= last; index += 1) {
    const row = rows[index]!;
    const option = codexOptionRow(row, margin);
    if (option !== null) {
      options.push({ row: option, details: option.detail === "" ? [] : [option.detail], drawn: [row.slice(0, margin) + " " + row.slice(margin + 1)] });
    } else if (leadingSpaces(row) >= margin + codexOptionIndent) {
      // A description's wrapped row, under its option.
      options[options.length - 1]!.details.push(trimWhitespace(row));
      options[options.length - 1]!.drawn.push(row);
    } else {
      return null;
    }
  }
  if (options.length < 2 || options.some((option, index) => option.row.number !== index + 1)) return null;
  if (options.filter((option) => option.row.marked).length > 1) return null;
  if (options.some((option) => option.details.length === 0)) return null;
  // A tool call's labels, in Codex's order: Allow first, Cancel last, each after the one before.
  const order = options.map((option) => codexFormLabels.indexOf(option.row.label));
  if (order[0] !== 0 || order[order.length - 1] !== codexFormLabels.length - 1 || order.some((at, index) => index > 0 && at <= order[index - 1]!)) return null;
  // Above option 1: the header right above it, or a blank row, the parameter rows, a blank row, then the header.
  let parameters: string[] = [];
  let headerEnd = first - 1;
  if (headerEnd >= 0 && rows[headerEnd] === "") {
    const parameterEnd = first - 2;
    if (parameterEnd < 0 || rows[parameterEnd] === "") return null;
    let parameterTop = parameterEnd;
    while (parameterTop > 0 && rows[parameterTop - 1] !== "") parameterTop -= 1;
    parameters = rows.slice(parameterTop, parameterEnd + 1);
    headerEnd = parameterTop - 2;
    if (parameterTop === 0 || headerEnd < 0 || rows[headerEnd] === "") return null;
  }
  if (headerEnd < 0) return null;
  let headerTop = headerEnd;
  while (headerTop > 0 && rows[headerTop - 1] !== "" && codexField(rows[headerTop - 1]!, margin) === null) headerTop -= 1;
  // Codex draws a row above the header (the Field row, or the menu's padding): a read that starts on it may have cut it.
  if (headerTop === 0) return null;
  const above = rows[headerTop - 1]!;
  if (above !== "") {
    const field = codexField(above, margin);
    if (field === null || field.index !== 1 || field.total !== 1) return null;
  }
  const header = rows.slice(headerTop, headerEnd + 1);
  if ([...header, ...parameters].some((row) => leadingSpaces(row) !== margin || codexField(row, margin) !== null)) return null;
  const question = header.map(trimWhitespace).join(" ");
  if (!codexFormHeader.test(question)) return null;
  return {
    kind: "codexForm",
    question,
    options: options.map(({ row, details }): PromptOption => ({
      key: String(row.number),
      label: row.label,
      detail: details.join(" "),
      isReturnDefault: row.marked,
      isSessionWide: sessionWide(normalisedLower(row.label)),
      opensComposer: false,
      keys: [String(row.number)],
    })),
    context: parameters.length === 0 ? null : { type: "parameters", rows: parameters.map(trimWhitespace) },
    fingerprint: {
      rules: fingerprintRules,
      paneID,
      question,
      body: rows.slice(headerTop, first),
      options: options.flatMap((option) => option.drawn),
      words: codexFormWords(rows, headerTop, headerEnd, parameters, options, end, margin, fitsColumns(rows, columns)),
    },
  };
}

/**
 * The words of Codex's tool-call form: the frame shows no width, so its edge is somewhere past its widest row, from
 * the header to the footer; its rows wrap as textwrap wraps them, at the menu's margin. The header (the question);
 * the parameters, a line each (a long value wraps at the margin, so where one parameter ends is told only where
 * the next row's first word would have fit); each option, its description's rows under its column.
 */
function codexFormWords(
  rows: readonly string[],
  headerTop: number,
  headerEnd: number,
  parameters: readonly string[],
  options: readonly { readonly row: CodexOptionRow; readonly drawn: readonly string[] }[],
  end: number,
  margin: number,
  columns: number | null,
): FingerprintWords {
  // The frame shows no width; with the pane's width the screen was read at, its edge is at most that and at least
  // two cells short of it, as Codex's command question.
  const frame = edgeFromColumns({ style: "textwrap", low: widest(rows.slice(headerTop, end + 1)), high: null }, columns, codexEdgeMargin);
  const header: WrapSection = { rows: rows.slice(headerTop, headerEnd + 1), next: margin, lines: false };
  const sections = options.map((option): WrapSection => {
    const first = option.drawn[0]!;
    // The description's column: where its words start on the option's row.
    const column = prefixCells(first) - prefixCells(option.row.detail);
    return { rows: option.drawn, next: column, lines: false };
  });
  return { ...questionWords([header], frame), body: partText([header, { rows: parameters, next: margin, lines: true }], frame), options: partText(sections, frame) };
}

// MARK: - Codex's update question

/** The footer under Codex's update question, compared whole (collapsed, lowercased): its keys, Return and Esc. */
export const codexUpdateFooter = "enter continue \u00B7 esc skip";
/** Its first choice: the update and the command it runs, in Codex's words. */
const codexUpdateNow = /^Update now \(runs `[^`]+`\)$/u;
/** Its choices, after the first, in its order. */
const codexUpdateRest: readonly string[] = ["Skip", "Skip until next version"];
/** A choice row, trimmed: Codex's mark maybe, the number, its words. */
const codexUpdateChoice = /^(\u203A\s*)?(\d)\.\s+(\S.*)$/u;
/** Its first line (update-mark.ts reads the same): an optional sparkle, "Update available!", the two versions. */
const codexUpdateNotice = /^(?:\u2728\uFE0F?\s*)?(Update available!\s+v?\d+(?:\.\d+)+\S*\s+->\s+v?\d+(?:\.\d+)+\S*)$/u;
/** At most this many rows above the choices are looked at for its first line. */
const codexUpdateNoticeRows = 8;
/** The one row Codex draws between its first line and the choices (blank rows aside). */
const codexUpdateReleaseNotes = /^Release notes: https:\/\/\S+$/u;
/**
 * The rows a real start shows above the prompt, the only ones allowed there; any
 * other row (a reply or quote mark, a speaker's line or its continuation, a lead-in, a user prompt row, a fence of any
 * delimiter and length, open or closed, or anything that cannot be told apart from those) is conversation.
 *
 * - The shell's prompt with the command that started Codex: the prompt's own words (user, host, folder: no quote, no
 *   backtick, no colon followed by a space), its sign (`%`, `$`, `#`, `❯`), then `codex` (by path or not) and its
 *   plain arguments. `demo@mac ~ % codex`, `user@host:~/code$ codex --yolo`, `$ /opt/homebrew/bin/codex`.
 *   Also the app's own launch forms: an optional `exec` before the program (herdr-core's
 *   agent.start types `exec codex --no-daemon`, core-actions.ts), and New agent's model and effort flags as its checked
 *   builders type them (model-choices.ts startFlags, typedFlags, coreStartWords): `-m '<model>'` with a value of
 *   Codex's model id pattern and `-c 'model_reasoning_effort=<level>'` with a value of the effort pattern, each value
 *   single-quoted and holding only what those patterns allow (never a quote, a backtick, `$` or a line break).
 */
const codexUpdateModelWord = `'${modelIdPatterns.codex.source.slice(1, -1)}'`;
const codexUpdateEffortWord = `'model_reasoning_effort=${effortPattern.source.slice(1, -1)}'`;
const codexUpdateShellRow = new RegExp(
  String.raw`^(?:[\w.@~/+\-[\]()]+(?::[\w.~/+-]*)?\s+)*[\w.@~/+\-[\]()]*(?::[\w.~/+-]*)?\s*[%$#❯]\s+(?:exec\s+)?(?:[\w.~/+-]*\/)?codex` +
    String.raw`(?:\s+(?:-m\s+${codexUpdateModelWord}|-c\s+${codexUpdateEffortWord}|[\w.=/~+-]+))*$`,
  "u",
);
/** The terminal's own first row in a new window: `Last login: <date> on ttys001`. */
const codexUpdateLastLogin = /^Last login: [\w :]+ on [\w/]+$/u;
/** Codex's start cell: its top and bottom rules, and its rows (`│ … │`). */
const codexUpdateCellTop = /^\u256D\u2500+\u256E$/u;
const codexUpdateCellBottom = /^\u2570\u2500+\u256F$/u;
const codexUpdateCellRow = /^\u2502(.*)\u2502$/u;
/** What the start cell holds: its title with the version, the model and folder rows, blank rows. */
const codexUpdateCellText = /^(?:>_ OpenAI Codex \(v\d+(?:\.\d+)+[\w.-]*\)|model:\s+[\w./ -]+|directory:\s+[\w.~/ -]+)?$/u;

/** Every row above Codex's update prompt in the read is one a real start shows there (none is conversation). */
function codexUpdateStartRows(above: readonly string[]): boolean {
  let inCell = false;
  for (const row of above) {
    if (inCell) {
      if (codexUpdateCellBottom.test(row)) {
        inCell = false;
        continue;
      }
      const cell = codexUpdateCellRow.exec(row);
      if (cell === null || !codexUpdateCellText.test(trimWhitespace(cell[1]!))) return false;
      continue;
    }
    if (row === "" || codexUpdateShellRow.test(row) || codexUpdateLastLogin.test(row)) continue;
    if (codexUpdateCellTop.test(row)) {
      inCell = true;
      continue;
    }
    return false;
  }
  return !inCell;
}

/**
 * Codex's update question at the screen's end, its rows as Codex draws them at start:
 *
 *       ✨ Update available! 0.167.0 -> 0.168.0
 *
 *       Release notes: https://github.com/openai/codex/releases/latest
 *
 *     › 1. Update now (runs `npm install -g @openai/codex`)
 *       2. Skip
 *       3. Skip until next version
 *
 *       enter continue · esc skip
 *
 * The footer is the last row with words; above it (blank rows allowed) exactly the three choices, numbered 1 to 3,
 * in Codex's words, exactly one marked `›`, none wrapped. A word different anywhere in them: null.
 * Only the prompt's own screen. Its first line ("Update available! A -> B", the row itself,
 * never quoted) is required, within eight rows above the choices with only blank rows and its Release notes row
 * between; the row above it is blank or the read's first.
 * Every row above it in the read, not only the nearest, is one a real start shows
 * there (blank rows, the shell's prompt with the command that started Codex, the terminal's Last login row, Codex's
 * start cell: codexUpdateStartRows); any other row is conversation.
 * Anything else (a transcript or a code block quoting these lines, a read too short to tell): null, the unmatched card,
 * nothing sent. The re-read before a key goes reads with this same rule.
 *
 * Its keys are the ones its own footer names: Return answers the marked choice ("enter continue"), Esc answers Skip
 * ("esc skip"). Another choice (Skip until next version, or Update now while the mark is elsewhere) is answered in the
 * Terminal: `inTerminal`, no keys. The fingerprint keeps the mark (where it sits picks what Return answers).
 */
export function codexUpdatePrompt(text: string, paneID: string): PromptMatch | null {
  const rows = drawnRows(text);
  let end = rows.length - 1;
  while (end >= 0 && trimWhitespace(rows[end]!) === "") end -= 1;
  if (end < 0 || normalisedLower(collapse(trimWhitespace(rows[end]!))) !== codexUpdateFooter) return null;
  let last = end - 1;
  while (last >= 0 && trimWhitespace(rows[last]!) === "") last -= 1;
  const first = last - 2;
  if (first < 0) return null;
  const choices = rows.slice(first, last + 1).map((row) => codexUpdateChoice.exec(trimWhitespace(row)));
  if (choices.some((found) => found === null)) return null;
  const found = choices as RegExpExecArray[];
  if (found.some((match, index) => Number(match[2]) !== index + 1)) return null;
  const labels = found.map((match) => collapse(match[3]!));
  if (!codexUpdateNow.test(labels[0]!) || labels[1] !== codexUpdateRest[0] || labels[2] !== codexUpdateRest[1]) return null;
  const marked = found.map((match) => match[1] !== undefined);
  if (marked.filter(Boolean).length !== 1) return null;
  // Its first line, a few rows up: only blanks and its Release notes row (once) between it and the choices.
  let top = -1;
  let notes = false;
  for (let index = first - 1; index >= Math.max(0, first - codexUpdateNoticeRows); index -= 1) {
    const row = trimWhitespace(rows[index]!);
    if (row === "") continue;
    if (!notes && codexUpdateReleaseNotes.test(row)) {
      notes = true;
      continue;
    }
    if (codexUpdateNotice.test(row)) top = index;
    break;
  }
  if (top < 0) return null;
  // Above it: the row right above blank or none, and every row above it one a real start shows there.
  if (top > 0 && trimWhitespace(rows[top - 1]!) !== "") return null;
  if (!codexUpdateStartRows(rows.slice(0, top).map(trimWhitespace))) return null;
  const question = codexUpdateNotice.exec(trimWhitespace(rows[top]!))![1]!.replace(/\s+/gu, " ");
  const options = labels.map((label, index): PromptOption => {
    const key = String(index + 1);
    const base = { key, label, isReturnDefault: marked[index]!, isSessionWide: false, opensComposer: false };
    if (marked[index]) return { ...base, keys: ["Enter"] };
    if (label === "Skip") return { ...base, keys: ["Escape"] };
    return { ...base, keys: [], inTerminal: true, detail: "Answered in the Terminal" };
  });
  return {
    kind: "codexUpdate",
    question,
    options,
    context: null,
    fingerprint: {
      rules: fingerprintRules,
      paneID,
      question,
      body: rows.slice(top, first).map(trimWhitespace).filter((row) => row !== ""),
      options: rows.slice(first, last + 1).map(trimWhitespace),
    },
  };
}

/** A tool call's option row, trimmed: the mark maybe, the number, a known label, then its description or nothing. */
const codexTraceOption = /^(?:› )?\d\. (?:Allow for this session|Always allow|Allow|Cancel)(?: {2}.*)?$/u;

/**
 * Some part of Codex's form is on screen, whole or not:
 * a footer with "enter to submit" and "esc to cancel" (any form's), a `Field`
 * row, or an option row of a tool call's. After the digit a read showing one
 * is not proof the answer took (the form may be redrawing, or another form is
 * up): only a screen without any is.
 */
export function codexFormTrace(text: string): boolean {
  return drawnRows(text).some((row) => {
    const line = normalisedLower(collapse(row));
    if (line.includes("enter to submit") && line.includes("esc to cancel")) return true;
    const trimmed = trimWhitespace(row);
    return codexFieldRow.test(trimmed) || codexTraceOption.test(trimmed);
  });
}

// MARK: - Codex 0.171.0's own question (request_user_input) and "Implement this plan?"

/**
 * The footers under Codex's own question, compared whole as drawn (from the margin, trailing blanks off): on a
 * question before the last (`next`), on the last of several (`last`), and on a question asked alone (`only`: Codex
 * 0.171.0's source, request_user_input/mod.rs footer_tips; not sampled live). Codex draws "←/→ to navigate questions"
 * only with two questions or more.
 */
export const codexQuestionFooters = {
  next: "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
  last: "tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt",
  only: "tab to add notes | enter to submit answer | esc to interrupt",
} as const;
/** Its header row: `Question N/M (K unanswered)`. Without the count (every question answered) it is not read. */
const codexQuestionHeader = /^Question ([1-9][0-9]{0,2})\/([1-9][0-9]{0,2}) \(([1-9][0-9]{0,2}) unanswered\)$/u;
/** The row Codex adds under the asked options, in its words: the way out, never an answer the card sends. */
export const codexOtherLabel = "None of the above";
export const codexOtherDetail = "Optionally, add details in notes (tab)";
/** Rows a digit can name (the asked options and Codex's own last row); a tenth is drawn without a number. */
export const codexQuestionRowLimit = 9;
/** A numbered row from the frame's margin: the mark's cell (`›` or blank), a space, the digit, `. `, the rest. */
const codexQuestionRow = /^([› ]) ([1-9])\. (\S.*)$/u;
/** Cells from the margin to a row's label (`› 1. `). */
const codexQuestionLabelAt = 5;

/** A row of code points with the cell each starts at. */
function cellColumns(row: string): { readonly characters: string[]; readonly at: number[] } {
  const characters = [...row];
  const at: number[] = [];
  let column = 0;
  for (const character of characters) {
    at.push(column);
    column += cells(character);
  }
  return { characters, at };
}

/**
 * The cells in a numbered row where a description may start: a word after two blanks or more, past `from`. The
 * selection list pads every label to one column (the longest label and two blanks), so the description's column is
 * one of these on every row.
 */
function descriptionStarts(row: string, from: number): number[] {
  const { characters, at } = cellColumns(row);
  const starts: number[] = [];
  for (let index = 2; index < characters.length; index += 1) {
    if (at[index]! > from && characters[index] !== " " && characters[index - 1] === " " && characters[index - 2] === " ") starts.push(at[index]!);
  }
  return starts;
}

/** The text of `row` from cell `from` on (`from` a cell where a code point starts). */
function fromCell(row: string, from: number): string {
  const { characters, at } = cellColumns(row);
  const index = at.indexOf(from);
  return index < 0 ? "" : characters.slice(index).join("");
}

/** The text of `row` before cell `to`. */
function beforeCell(row: string, to: number): string {
  const { characters, at } = cellColumns(row);
  return characters.filter((_, index) => at[index]! < to).join("");
}

/** One numbered row of a selection list and the rows that continue its description. */
interface CodexListEntry {
  readonly number: number;
  readonly marked: boolean;
  readonly label: string;
  /** The description, its rows joined (`joinWrapped`). */
  readonly detail: string;
  /** Its rows as drawn, the mark's cell blank. */
  readonly drawn: readonly string[];
  /** The cell its description starts at. */
  readonly column: number;
}

/**
 * The numbered rows of a Codex selection list in `rows` (top to bottom, no blank row among them), at `margin`:
 * `› N. label  description` (the mark on one), numbered from 1 with no gap, every label padded to one column (the
 * description's, the same on every row, the longest label two blanks short of it), each with a description, and a
 * row under one whose words start exactly at that column continuing its description. Null for anything else (a row
 * not numbered, two columns that fit, a label that wraps, a row without a description).
 */
function codexListRows(rows: readonly string[], margin: number): CodexListEntry[] | null {
  // The mark's cell is blank on every row but one: a numbered row has the margin's blanks, then the cell, then its number.
  const numbered = rows.map((row) => (leadingSpaces(row) >= margin ? codexQuestionRow.exec(row.slice(margin)) : null));
  const heads = rows.flatMap((_, index) => (numbered[index] === null ? [] : [index]));
  if (heads.length === 0 || heads[0] !== 0) return null;
  const labelAt = margin + codexQuestionLabelAt;
  // The description's column: a word after two blanks on every numbered row, right after the longest label.
  const shared = heads.map((index) => descriptionStarts(rows[index]!, labelAt)).reduce((left, right) => left.filter((column) => right.includes(column)));
  const columns = shared.filter((column) => heads.some((index) => beforeCell(rows[index]!, column).slice(-3, -2) !== " "));
  if (columns.length !== 1) return null;
  const column = columns[0]!;
  const entries: { number: number; marked: boolean; label: string; details: string[]; drawn: string[] }[] = [];
  for (const [index, row] of rows.entries()) {
    const found = numbered[index];
    if (found !== null && found !== undefined) {
      const label = trimWhitespace(beforeCell(row, column).slice(labelAt));
      if (label === "" || /\s{2}/u.test(label)) return null;
      entries.push({ number: Number(found[2]), marked: found[1] === "›", label, details: [trimWhitespace(fromCell(row, column))], drawn: [`${row.slice(0, margin)} ${row.slice(margin + 1)}`] });
    } else if (leadingSpaces(row) === column && entries.length > 0) {
      entries.at(-1)!.details.push(trimWhitespace(row));
      entries.at(-1)!.drawn.push(row);
    } else {
      return null;
    }
  }
  if (entries.some((entry, at) => entry.number !== at + 1 || entry.details[0] === "")) return null;
  return entries.map((entry) => ({ number: entry.number, marked: entry.marked, label: entry.label, detail: joinWrapped(entry.details), drawn: entry.drawn, column }));
}

/**
 * A description's wrapped rows as the card shows them: joined by one blank, but with none after a row that ends in a
 * letter and a hyphen when the next starts with a letter (textwrap broke the word there: "general-" over "purpose").
 * Display only: what an answer is bound to is the fingerprint.
 */
function joinWrapped(rows: readonly string[]): string {
  return rows.reduce((text, row) => (/\p{L}-$/u.test(text) && /^\p{L}/u.test(row) ? text + row : `${text} ${row}`));
}

/** The progress Codex's header row shows, at `margin`; null for any other row. */
function codexQuestionProgress(row: string, margin: number): CodexQuestionProgress | null {
  if (leadingSpaces(row) !== margin) return null;
  const found = codexQuestionHeader.exec(row.slice(margin));
  if (found === null) return null;
  const progress = { index: Number(found[1]), total: Number(found[2]), unanswered: Number(found[3]) };
  return progress.index > progress.total || progress.unanswered > progress.total ? null : progress;
}

/** The footer a question at `progress` draws. */
function codexQuestionFooter(progress: CodexQuestionProgress): string {
  if (progress.total === 1) return codexQuestionFooters.only;
  return progress.index < progress.total ? codexQuestionFooters.next : codexQuestionFooters.last;
}

/**
 * Codex 0.171.0's own question in Plan mode (its request_user_input tool,
 * codex-rs/tui/src/bottom_pane/request_user_input/) at the screen's end, read
 * whole, every row at the frame's margin, as recorded at 120 columns:
 *
 *       Question 1/2 (2 unanswered)
 *       Which name should the tiny note file have?
 *
 *       › 1. note (Recommended)  Use the simple base name “note”.
 *         2. quick-note          Use the base name “quick-note”.
 *         3. memo                Use the base name “memo”.
 *         4. None of the above   Optionally, add details in notes (tab)
 *
 *       tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt
 *
 * Read from the bottom: the footer the last row with words, exactly the one its header calls for (a question before
 * the last, the last of several, or one alone: `codexQuestionFooters`); one blank row over it; one block of numbered
 * rows (`codexListRows`): at least two asked options and Codex's own last row (`None of the above` and its words), nine
 * rows at most, exactly one marked `›`; one blank row; the question's rows (none indented, at least one); the header
 * row `Question N/M (K unanswered)` right above them (N and K at most M); and over it a blank row (Codex's menu
 * padding: a read that starts at the header may have cut it). The notes row open (its footer is another), a header
 * cut off, a tenth row, no options, a footer that is not one of these, anything else in these rows: null.
 *
 * The match: the question (its rows joined by one blank), the asked options with their labels as Codex wrote them
 * ("(Recommended)" kept) and their descriptions, and the header's numbers (`codexProgress`); Codex's own last row is
 * never an option (the card's way out is the Terminal, where notes are typed). Each option's answer is its digit
 * alone (a digit chooses it and moves on, or submits on the last question). The fingerprint: the header row and the
 * question's rows (body), every numbered row and its description's rows (Codex's own last row too), as drawn, the
 * mark's cell blank.
 */
export function codexQuestion(text: string, paneID: string, columns: number | null = null): PromptMatch | null {
  const rows = drawnRows(text);
  let end = rows.length - 1;
  while (end >= 0 && rows[end] === "") end -= 1;
  if (end < 6) return null;
  const margin = leadingSpaces(rows[end]!);
  const footer = rows[end]!.slice(margin);
  if (!Object.values(codexQuestionFooters).includes(footer as never)) return null;
  // One blank row over the footer, then the numbered rows up to one blank row.
  if (rows[end - 1] !== "") return null;
  const last = end - 2;
  if (rows[last] === "") return null;
  let top = last;
  while (top > 0 && rows[top - 1] !== "") top -= 1;
  const entries = codexListRows(rows.slice(top, last + 1), margin);
  if (entries === null || entries.length < 3 || entries.length > codexQuestionRowLimit) return null;
  const other = entries.at(-1)!;
  if (other.label !== codexOtherLabel || other.detail !== codexOtherDetail) return null;
  if (entries.filter((entry) => entry.marked).length !== 1) return null;
  // Over the options: one blank row, the question's rows, the header right above them, a blank row over it.
  const questionEnd = top - 2;
  if (questionEnd < 0 || rows[top - 1] !== "" || rows[questionEnd] === "") return null;
  let headerRow = questionEnd;
  while (headerRow >= 0 && rows[headerRow] !== "" && codexQuestionProgress(rows[headerRow]!, margin) === null) headerRow -= 1;
  if (headerRow < 1 || headerRow === questionEnd || rows[headerRow] === "" || rows[headerRow - 1] !== "") return null;
  const progress = codexQuestionProgress(rows[headerRow]!, margin)!;
  if (footer !== codexQuestionFooter(progress)) return null;
  const questionRows = rows.slice(headerRow + 1, questionEnd + 1);
  if (questionRows.some((row) => leadingSpaces(row) !== margin)) return null;
  const question = questionRows.map(trimWhitespace).join(" ");
  const asked = entries.slice(0, -1);
  return {
    kind: "codexQuestion",
    question,
    options: asked.map(
      (entry): PromptOption => ({
        key: String(entry.number),
        label: entry.label,
        detail: entry.detail,
        isReturnDefault: entry.marked,
        isSessionWide: false,
        opensComposer: false,
        keys: [String(entry.number)],
      }),
    ),
    context: null,
    fingerprint: {
      rules: fingerprintRules,
      paneID,
      question,
      body: [rows[headerRow]!, ...questionRows],
      options: entries.flatMap((entry) => entry.drawn),
      words: codexListWords(rows.slice(headerRow, end + 1), [rows[headerRow]!], questionRows, entries, margin, fitsColumns(rows, columns)),
    },
    codexProgress: progress,
  };
}

/**
 * The words of Codex's own question and its plan question: the frame shows no width, so its edge is somewhere past
 * its widest row (`frameRows`, from the header or title to the footer), and with the pane's width the screen was read
 * at, at most that and at least two cells short of it (as Codex's other frames: the samples' edge is the 120-column
 * pane's less two). Its rows wrap as textwrap wraps them. The question (its own text may hold line breaks); the
 * header or title row and the question (the body); each numbered row, its description's rows under its column.
 */
function codexListWords(
  frameRows: readonly string[],
  head: readonly string[],
  questionRows: readonly string[],
  entries: readonly CodexListEntry[],
  margin: number,
  columns: number | null,
): FingerprintWords {
  const frame = edgeFromColumns({ style: "textwrap", low: widest(frameRows), high: null }, columns, codexEdgeMargin);
  const question: WrapSection = { rows: questionRows, next: margin, lines: true };
  // The plan's title is its question and its whole body: one section, not two.
  const parts: WrapSection[] = head === questionRows ? [question] : [{ rows: head, next: margin, lines: false }, question];
  const options = entries.map((entry): WrapSection => ({ rows: entry.drawn, next: entry.column, lines: false }));
  return { ...questionWords([question], frame), body: partText(parts, frame), options: partText(options, frame) };
}

/** A row of Codex's own question, trimmed: its header row, its own last row, or one of its footers (the notes one too). */
const codexQuestionTraceRow = new RegExp(
  [
    String.raw`^Question [0-9]+\/[0-9]+(?: \([0-9]+ unanswered\))?$`,
    String.raw`^(?:› )?[0-9]+\. None of the above +Optionally, add details in notes \(tab\)$`,
    String.raw`navigate questions`,
    String.raw`^tab (?:or esc )?to (?:add|clear) notes`,
    String.raw`enter to submit (?:answer|all)`,
    // Its confirmation when the last question's answer leaves another unanswered (request_user_input/mod.rs).
    String.raw`^Submit with unanswered questions\?$`,
  ].join("|"),
  "u",
);

/**
 * Some part of Codex's own question is on screen, whole or not: its header row, its own last row, one of its footers
 * (with the notes row open too), or its "Submit with unanswered questions?" confirmation. After the digit a read
 * showing one is not proof the answer took (the frame may be redrawing, the notes row open, or Codex asking to
 * confirm): only a screen without any, or the next question (`codexQuestionNext`), is.
 */
export function codexQuestionTrace(text: string): boolean {
  return drawnRows(text).some((row) => codexQuestionTraceRow.test(trimWhitespace(row)));
}

/**
 * Whether `now` is the question that follows the answered one: question N+1 of the same M, with one fewer
 * unanswered. What Codex shows after a digit on a question that is not the last (question-long-2of2-after-digit).
 */
export function codexQuestionNext(answered: PromptMatch, now: PromptMatch): boolean {
  const before = answered.codexProgress;
  const after = now.codexProgress;
  if (answered.kind !== "codexQuestion" || now.kind !== "codexQuestion" || before === undefined || after === undefined) return false;
  return after.total === before.total && after.index === before.index + 1 && after.unanswered === before.unanswered - 1;
}

/** The footer under Codex's selection lists (its permissions list too), compared whole (collapsed, lowercased). */
export const codexPlanFooter = "enter select · esc back";
/** The title of the list Codex shows after a plan (chatwidget/plan_implementation.rs PLAN_IMPLEMENTATION_TITLE). */
export const codexPlanTitle = "Implement this plan?";
/** Its three rows in Codex's order: the label and the description's words (the second's names how much context is used). */
export const codexPlanRows: readonly { readonly label: string; readonly detail: RegExp }[] = [
  { label: "Yes, implement this plan", detail: /^Switch to Default and start coding$/u },
  { label: "Yes, clear context and implement", detail: /^(?:Start a fresh thread \(current context: [^()]+\)|Fresh thread with this plan)$/u },
  { label: "No, stay in Plan mode", detail: /^Continue planning with the model$/u },
];
/** Blank rows Codex draws between the title and the rows (two at 120 columns); more is not its frame. */
const codexPlanGap = 2;

/**
 * Codex 0.171.0's question after a plan in Plan mode (chatwidget/plan_implementation.rs, a selection list) at the
 * screen's end, read whole, as recorded at 120 columns:
 *
 *       Implement this plan?
 *
 *
 *     › 1. Yes, implement this plan          Switch to Default and start coding
 *       2. Yes, clear context and implement  Start a fresh thread (current context: 4% used)
 *       3. No, stay in Plan mode             Continue planning with the model
 *
 *       enter select · esc back
 *
 * Read from the bottom: the footer `enter select · esc back` the last row with words; one blank row over it; exactly
 * the three rows numbered 1 to 3 (`codexListRows`, from the screen's margin), Codex's labels in its order and its
 * descriptions (the second's context use any words in its brackets), exactly one marked `›`; one or two blank rows;
 * the title, exactly `Implement this plan?`; and over it a blank row. A row disabled by Codex is drawn without its
 * number, so all three numbered means each digit picks its own row. Anything else (the permissions list and every
 * other list under this footer, a word different, the title cut off): null.
 *
 * Each option's answer is its digit alone: the list's own number keys choose the row and accept it (as mode-pick.ts
 * sends on the permissions list, the same list frame; list_selection_view.rs auto_number_shortcuts). The
 * fingerprint: the title (body) and the three rows with their descriptions' rows, as drawn, the mark's cell blank.
 */
export function codexPlan(text: string, paneID: string, columns: number | null = null): PromptMatch | null {
  const rows = drawnRows(text);
  let end = rows.length - 1;
  while (end >= 0 && rows[end] === "") end -= 1;
  if (end < 6 || normalisedLower(collapse(rows[end]!)) !== codexPlanFooter || rows[end - 1] !== "") return null;
  const last = end - 2;
  if (rows[last] === "") return null;
  let top = last;
  while (top > 0 && rows[top - 1] !== "") top -= 1;
  const block = rows.slice(top, last + 1);
  // The list's margin: the marked row's (every other row has the mark's blank cell and a blank more, or is deeper).
  const entries = codexListRows(block, Math.min(...block.map(leadingSpaces)));
  if (entries === null || entries.length !== codexPlanRows.length) return null;
  if (entries.some((entry, at) => entry.label !== codexPlanRows[at]!.label || !codexPlanRows[at]!.detail.test(entry.detail))) return null;
  if (entries.filter((entry) => entry.marked).length !== 1) return null;
  // The title over one or two blank rows, and a blank row over it.
  let title = top - 1;
  while (title >= 0 && rows[title] === "") title -= 1;
  if (title < 1 || top - 1 - title < 1 || top - 1 - title > codexPlanGap) return null;
  if (trimWhitespace(rows[title]!) !== codexPlanTitle || rows[title - 1] !== "") return null;
  const titleRows = [rows[title]!];
  return {
    kind: "codexPlan",
    question: codexPlanTitle,
    options: entries.map(
      (entry): PromptOption => ({
        key: String(entry.number),
        label: entry.label,
        detail: entry.detail,
        isReturnDefault: entry.marked,
        isSessionWide: false,
        opensComposer: false,
        keys: [String(entry.number)],
      }),
    ),
    context: null,
    fingerprint: {
      rules: fingerprintRules,
      paneID,
      question: codexPlanTitle,
      body: [rows[title]!],
      options: entries.flatMap((entry) => entry.drawn),
      words: codexListWords(rows.slice(title, end + 1), titleRows, titleRows, entries, leadingSpaces(rows[title]!), fitsColumns(rows, columns)),
    },
  };
}

/**
 * Some part of Codex's plan question is on screen: a selection list's footer as the last row with words, or its
 * title among the last rows. After the digit a read showing one is not proof the answer took: only a screen without
 * any is.
 */
export function codexPlanTrace(text: string): boolean {
  const rows = drawnRows(text)
    .map(trimWhitespace)
    .filter((row) => row !== "");
  return normalisedLower(collapse(rows.at(-1) ?? "")) === codexPlanFooter || rows.slice(-12).includes(codexPlanTitle);
}

// MARK: - Claude Code 2.1.325's question dialog

/** The footer under Claude Code's question dialog, compared whole (collapsed, lowercased). */
export const claudeAskFooter = "enter to select \u00B7 \u2191/\u2193 to navigate \u00B7 esc to cancel";
/**
 * One of its numbered rows from the margin: the mark's cell (`❯` or blank), a
 * space, the number, `. `, the words. The number is one or two digits with no
 * leading zero, and at most `claudeAskRowLimit`: nine real options, then the two
 * fixed rows. Any other number is not a row of this dialog.
 */
const claudeAskRow = /^([❯ ]) ([1-9][0-9]?)\. (\S.*)$/u;
/** A description's row under its option: five cells in, then its words. */
const claudeAskDescription = /^ {5}\S/u;
/** The header row: one space, the chip's box, one space, the question's short header. */
const claudeAskHeaderRow = /^ ☐ (\S.*)$/u;
/** In the header's text, what a dialog of several questions draws (another chip, a done mark, the arrows, chips apart). */
const claudeAskMoreChips = /[☐☑☒✓✔←→]| {2}/u;
/** An option's label opening with a checkbox (a question of several choices). */
const claudeAskCheckbox = /^(?:\[[ xX✓✔]\]|[☐☑☒✓✔✗◯◉○●])(?:\s|$)/u;
/** The two rows after the options, in Claude's words: never options of the match. */
const claudeAskTypeRow = "Type something.";
const claudeAskChatRow = "Chat about this";
/** Real options a digit can name. */
export const claudeAskOptionLimit = 9;
/** The highest row number the dialog can draw: the last real option's, then Type something's, then Chat about this's. */
export const claudeAskRowLimit = claudeAskOptionLimit + 2;

interface ClaudeAskRow {
  readonly marked: boolean;
  readonly number: number;
  readonly words: string;
}

function claudeAskRowOf(row: string): ClaudeAskRow | null {
  const found = claudeAskRow.exec(row);
  if (found === null) return null;
  const number = Number(found[2]);
  return number < 1 || number > claudeAskRowLimit ? null : { marked: found[1] === "❯", number, words: found[3]! };
}

/**
 * Wide code points for this dialog's width checks (the same list as the phone's
 * `claudeAskWide`): Hangul Jamo, CJK and kana, Hangul syllables, CJK
 * compatibility and its forms, fullwidth forms, emoji and symbols, the CJK
 * extensions.
 */
const claudeAskWide: readonly (readonly [number, number])[] = [
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

/**
 * A row's cells as this dialog's reader counts them, the same on both apps:
 * every code point 1, one in `claudeAskWide` 2. A joiner or a combining mark
 * counts 1, so a row may count wider than the terminal draws it, never narrower:
 * a screen in doubt is unmatched.
 */
export function claudeAskCells(row: string): number {
  let cells = 0;
  for (const scalar of row) {
    const code = scalar.codePointAt(0)!;
    cells += claudeAskWide.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
  }
  return cells;
}

/** A rule of `─` only (no corner, no other line). */
function isAskRule(row: string): boolean {
  return /^─+$/u.test(row);
}

/** A numbered row with its mark's cell left blank: where the mark sits is not part of the question. */
function askUnmarked(row: string): string {
  return ` ${row.slice(1)}`;
}

/**
 * Claude Code 2.1.325's question dialog (the AskUserQuestion tool, one
 * question, one choice) at the screen's end, read whole, as recorded:
 *
 *     ──────────────────────────────── (the whole width)
 *      ☐ Q95
 *
 *     Q95: what should Z research next for the earning talk?
 *
 *     ❯ 1. Teams and T3 gaps (Recommended)
 *          What teams pay for in this category and where T3 Code falls short.
 *       2. Phone pricing only
 *          Moshi and the SSH apps in detail.
 *       3. Type something.
 *     ────────────────────────────────
 *       4. Chat about this
 *
 *     Enter to select · ↑/↓ to navigate · Esc to cancel
 *
 * Read from the bottom: the footer (compared whole) the last row with words
 * (or over a named session's rows: `footerOverNameRule`), one blank row over it, `N+1. Chat about this`, a rule, `N. Type something.`
 * (neither marked), and over them one block of the real options numbered 1 to
 * N-1 with no gap (2 to 9 of them, one digit each), each label row followed
 * by its description's rows five cells in (at least one; a label row that may
 * have wrapped into the row under it is not read), exactly one marked `❯`, no
 * label opening with a checkbox. Over option 1 one blank row, the question's
 * rows (none indented), one blank row, the header row (one chip: no second
 * chip, arrow, done mark or Submit) and the top rule, `─` only, as long as the
 * middle one; no row wider than the rules. A read that ends before the top
 * rule (its top cut off) or anything else in these rows: null.
 *
 * The match: the question (its rows joined by one space), the header chip's
 * text, the real options with their labels as drawn and their descriptions
 * (rows joined by one space). The fingerprint: the header row and the
 * question's rows (body), every real option's rows and the two fixed rows, as
 * drawn, the mark's cell left blank; the rules, the footer and a name rule
 * under it are not part of it.
 */
export function claudeAsk(text: string, paneID: string): PromptMatch | null {
  const rows = drawnRows(text);
  let end = footerOverNameRule(readRows(text).map(withoutEscapes), rows, claudeAskFooter) ?? rows.length - 1;
  while (end >= 0 && rows[end] === "") end -= 1;
  if (end < 4 || normalisedLower(collapse(rows[end]!)) !== claudeAskFooter) return null;
  // Over the footer: one blank row, "Chat about this", the rule, "Type something.", none of them marked.
  if (rows[end - 1] !== "") return null;
  const chat = claudeAskRowOf(rows[end - 2]!);
  if (chat === null || chat.marked || chat.words !== claudeAskChatRow) return null;
  const rule = rows[end - 3]!;
  if (!isAskRule(rule)) return null;
  const typed = claudeAskRowOf(rows[end - 4]!);
  if (typed === null || typed.marked || typed.words !== claudeAskTypeRow || typed.number + 1 !== chat.number) return null;
  // The real options: one block up to a blank row, each label row and its description's rows.
  const last = end - 5;
  let blank = last;
  while (blank >= 0 && rows[blank] !== "") blank -= 1;
  if (blank < 0 || blank === last) return null;
  const options: { readonly row: ClaudeAskRow; readonly at: number; readonly details: number[] }[] = [];
  for (let index = blank + 1; index <= last; index += 1) {
    const row = rows[index]!;
    const option = claudeAskRowOf(row);
    if (option !== null) options.push({ row: option, at: index, details: [] });
    else if (options.length > 0 && claudeAskDescription.test(row)) options[options.length - 1]!.details.push(index);
    else return null;
  }
  if (options.length < 2 || options.length > claudeAskOptionLimit || typed.number !== options.length + 1) return null;
  if (options.some((option, index) => option.row.number !== index + 1 || option.details.length === 0)) return null;
  if (options.filter((option) => option.row.marked).length !== 1) return null;
  if (options.some((option) => claudeAskCheckbox.test(option.row.words))) return null;
  const width = claudeAskCells(rule);
  // A label row the terminal may have wrapped into the row under it: its label cannot be told from its description.
  for (const option of options) {
    const word = trimWhitespace(rows[option.details[0]!]!).split(/\s/u)[0] ?? "";
    if (claudeAskCells(rows[option.at]!) + 1 + claudeAskCells(word) > width - unboxedMargin) return null;
  }
  // Over option 1: one blank row, the question's rows, one blank row, the header row, the top rule.
  const questionEnd = blank - 1;
  if (questionEnd < 0 || rows[questionEnd] === "") return null;
  let questionTop = questionEnd;
  while (questionTop > 0 && rows[questionTop - 1] !== "") questionTop -= 1;
  if (questionTop < 3 || rows[questionTop - 1] !== "") return null;
  const header = claudeAskHeaderRow.exec(rows[questionTop - 2]!);
  if (header === null || claudeAskMoreChips.test(header[1]!)) return null;
  if (rows[questionTop - 3] !== rule) return null;
  const questionRows = rows.slice(questionTop, questionEnd + 1);
  if (questionRows.some((row) => leadingSpaces(row) > 0)) return null;
  if (rows.slice(questionTop - 3, end + 1).some((row) => claudeAskCells(row) > width)) return null;
  const question = questionRows.map(trimWhitespace).join(" ");
  return {
    kind: "claudeAsk",
    question,
    options: options.map(
      ({ row, details }): PromptOption => ({
        key: String(row.number),
        label: row.words,
        detail: details.map((at) => trimWhitespace(rows[at]!)).join(" "),
        isReturnDefault: row.marked,
        isSessionWide: false,
        opensComposer: false,
        keys: [String(row.number)],
      }),
    ),
    context: null,
    fingerprint: {
      rules: fingerprintRules,
      paneID,
      question,
      body: [rows[questionTop - 2]!, ...questionRows],
      options: [
        ...options.flatMap((option) => [askUnmarked(rows[option.at]!), ...option.details.map((at) => rows[at]!)]),
        askUnmarked(rows[end - 4]!),
        askUnmarked(rows[end - 2]!),
      ],
      words: claudeAskWords(rows, questionTop, questionRows, options, end, width),
    },
    askHeader: header[1]!,
  };
}

/**
 * The words of Claude Code's question dialog: its width is its rules' (`─` rows as wide as the screen draws them);
 * its rows wrap as Ink wraps them, the question none in and each description five cells in, with the frame's padding
 * a cell or two short of the rule. The question (its own text may hold line breaks); the header chip's row and the
 * question (the body); each option: its label row, then its description, a line each, and the two fixed rows.
 */
function claudeAskWords(
  rows: readonly string[],
  questionTop: number,
  questionRows: readonly string[],
  options: readonly { readonly at: number; readonly details: readonly number[] }[],
  end: number,
  width: number,
): FingerprintWords {
  // The text's rows (the question, the options and their descriptions, the two fixed rows), never the rule under the options.
  const textRows = [...questionRows, ...options.flatMap((option) => [rows[option.at]!, ...option.details.map((at) => rows[at]!)]), rows[end - 4]!, rows[end - 2]!];
  const frame: WrapFrame = { style: "ink", low: Math.max(width - 2, widest(textRows)), high: width };
  const question: WrapSection = { rows: questionRows, next: 0, lines: true };
  const sections = options.flatMap((option): WrapSection[] => [
    { rows: [askUnmarked(rows[option.at]!)], next: 0, lines: false },
    { rows: option.details.map((at) => rows[at]!), next: 5, lines: true },
  ]);
  return {
    ...questionWords([question], frame),
    body: partText([{ rows: [rows[questionTop - 2]!], next: 0, lines: false }, question], frame),
    options: partText([...sections, { rows: [askUnmarked(rows[end - 4]!)], next: 0, lines: false }, { rows: [askUnmarked(rows[end - 2]!)], next: 0, lines: false }], frame),
  };
}

/** A row of the dialog's own, trimmed: its footer's words, or `Type something.` and `Chat about this` with their numbers. */
const claudeAskTraceRow = /^(?:❯ )?[0-9]+\. (?:Type something\.|Chat about this)$/u;

/**
 * Some part of Claude Code's question dialog is on screen, whole or not: a
 * footer with "enter to select" and "esc to cancel", or one of its two fixed
 * rows. After the digit a read showing one is not proof the answer took (the
 * dialog may be redrawing, or another question is up): only a screen without any is.
 */
export function claudeAskTrace(text: string): boolean {
  return drawnRows(text).some((row) => {
    const line = normalisedLower(collapse(row));
    if (line.includes("enter to select") && line.includes("esc to cancel")) return true;
    return claudeAskTraceRow.test(trimWhitespace(row));
  });
}

// MARK: - the agent's text field

/** The empty text field each supported agent kind draws at the bottom of its pane when it takes prose. */
export type InputField =
  /** A box: its top edge, one row holding only the marker, its bottom edge. */
  | { readonly type: "boxed"; readonly marker: string }
  /** One row holding only the marker between two rules. */
  | { readonly type: "ruled"; readonly marker: string }
  /** The marker alone on the last row. */
  | { readonly type: "bare"; readonly marker: string }
  /** Claude Code 2.1.303: a rule, the marker alone, a rule; up to three statusline rows under it; a hint row above. */
  | { readonly type: "ruledWithStatusline"; readonly marker: string }
  /** Codex 0.163.0: a footer row, one statusline row, a blank row, a row starting with the marker. */
  | { readonly type: "footed"; readonly marker: string; readonly footer: string }
  /** Grok 1.0.60: the footer row, a blank row, a box around the marker whose bottom edge may carry a label. */
  | { readonly type: "labelledBox"; readonly marker: string; readonly footer: string };

export interface InputPrompt {
  readonly fields: readonly InputField[];
  /** Lines the agent may draw under its field, compared whole and lowercased. */
  readonly footers: ReadonlySet<string>;
}

/** The recorded fields by Herdr's agent kind (lowercased); a kind's shapes prove only its own field. */
export const inputPrompts: Readonly<Record<string, InputPrompt>> = {
  claude: {
    fields: [
      { type: "boxed", marker: ">" },
      { type: "ruled", marker: ">" },
      { type: "ruledWithStatusline", marker: "❯" },
    ],
    footers: new Set(["? for shortcuts"]),
  },
  codex: {
    fields: [
      { type: "bare", marker: "›" },
      { type: "footed", marker: "›", footer: "? for shortcuts" },
    ],
    footers: new Set(["? for shortcuts"]),
  },
  grok: {
    fields: [
      { type: "boxed", marker: "❯" },
      { type: "labelledBox", marker: "❯", footer: "shift+tab:mode │ ctrl+.:shortcuts" },
    ],
    footers: new Set(),
  },
};

/** A row that says the agent is still at work, wherever it is. */
export const workingMarks: readonly string[] = ["esc to interrupt"];

/** Claude Code's spinner row while it works ("✽ Fiddle-faddling… (1s · thinking)"). */
const spinnerRow = /^[·✢✳✶✻✽*] \p{L}+(?:-\p{L}+)*… \((?:\d+h )?(?:\d+m )?\d+s(?:\)| ·)/u;

export function isWorkingMark(row: string): boolean {
  return workingMarks.some((mark) => normalisedLower(row).includes(mark)) || spinnerRow.test(row);
}

/**
 * Whether `text` (a `pane.read`) ends in `kind`'s own text field, empty. The
 * screen alone never proves it: the text after an option also waits for Herdr
 * to report the agent idle or done.
 */
export function showsInputPrompt(text: string, kind: string | null | undefined): boolean {
  if (kind === null || kind === undefined) return false;
  const lower = kind.toLowerCase();
  const prompt = Object.prototype.hasOwnProperty.call(inputPrompts, lower) ? inputPrompts[lower] : undefined;
  if (prompt === undefined) return false;
  const drawn = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((row) => withoutEscapes(row).replace(/ /gu, " "));
  while (drawn.length > 0 && trimWhitespace(drawn[drawn.length - 1]!) === "") drawn.pop();
  const all = drawn.map(trimWhitespace);
  if (all.some(isWorkingMark)) return false;
  const rows = [...all];
  while (rows.length > 0 && (rows[rows.length - 1] === "" || prompt.footers.has(normalisedLower(collapse(rows[rows.length - 1]!))))) rows.pop();
  const last3 = rows.slice(-3);
  return prompt.fields.some((field) => {
    switch (field.type) {
      case "bare":
        return rows.length > 0 && rows[rows.length - 1] === field.marker;
      case "boxed":
        return (
          last3.length === 3 &&
          isBoxTop(last3[0]!) &&
          isBoxBottom(last3[2]!) &&
          last3[1] !== "" &&
          borders.has(last3[1]!.charAt(0)) &&
          cleanRow(last3[1]!) === field.marker
        );
      case "ruled":
        return last3.length === 3 && isRule(last3[0]!) && isRule(last3[2]!) && !isBoxTop(last3[0]!) && !isBoxBottom(last3[2]!) && last3[1] === field.marker;
      case "ruledWithStatusline":
        return showsRuledField(all, drawn, field.marker);
      case "footed":
        return showsFootedField(all, field.marker, field.footer);
      case "labelledBox":
        return showsLabelledBox(all, field.marker, field.footer);
    }
  });
}

function isPlainRule(row: string): boolean {
  return isRule(row) && !isBoxTop(row) && !isBoxBottom(row);
}

/**
 * A named Claude session's top rule: at least four dashes, one space, one label (words of anything but box
 * drawing, one space apart), then a space and more dashes (2.1.303) or nothing (2.1.319 draws the
 * name, then one trailing space, which the rows' trim takes off).
 */
const labelledTopRule = /^─{4,} [^─-╿ ]+(?: [^─-╿ ]+)*(?: ─+)?$/u;

/** Claude's hint over its field: after two or more spaces, ending 2 cells short of the rule under it, give or take one cell. */
function isHint(row: string, rule: string): boolean {
  const hint = dropTrailingBlanks(row);
  const leading = leadingSpaces(hint);
  return leading >= 2 && leading < length(hint) && Math.abs(cells(hint) - (cells(dropTrailingBlanks(rule)) - 2)) <= 1;
}

function showsRuledField(rows: readonly string[], drawn: readonly string[], marker: string): boolean {
  // The bottom rule: the lowest rule, with at most three rows under it.
  const bottom = lastIndex(rows, isRule);
  if (bottom < 0 || rows.length - 1 - bottom > 3 || bottom < 2) return false;
  const under = rows.slice(bottom + 1);
  if (under.some((row) => isRule(row) || labelledTopRule.test(row) || optionLine(row) !== null || isWorkingMark(row))) return false;
  if (!isPlainRule(rows[bottom]!) || rows[bottom - 1] !== marker || !(isPlainRule(rows[bottom - 2]!) || labelledTopRule.test(rows[bottom - 2]!))) {
    return false;
  }
  // Above the top rule: blank, the read's top, or one hint row right-aligned against it.
  let above = bottom - 3;
  if (above >= 0 && rows[above] !== "") {
    if (!isHint(drawn[above]!, drawn[bottom - 2]!) || optionLine(rows[above]!) !== null) return false;
    above -= 1;
  }
  return above < 0 || rows[above] === "";
}

function showsFootedField(rows: readonly string[], marker: string, footer: string): boolean {
  if (rows.length < 4) return false;
  const n = rows.length;
  const last = normalisedLower(rows[n - 1]!);
  if (!last.startsWith(footer)) return false;
  const rest = last.slice(footer.length);
  if (rest !== "" && !rest.startsWith("  ")) return false;
  const status = rows[n - 2]!;
  if (status === "" || isBorder(status) || optionLine(status) !== null) return false;
  return rows[n - 3] === "" && rows[n - 4]!.startsWith(marker);
}

/** A box's bottom edge, bare or with one label in it (Grok 1.0.60). */
const labelledBottom = /^╰─+(?: [^─╭╮╰╯│]+ ─+)?╯$/u;

function showsLabelledBox(rows: readonly string[], marker: string, footer: string): boolean {
  if (rows.length < 5) return false;
  const n = rows.length;
  const field = rows[n - 4]!;
  if (
    normalisedLower(collapse(rows[n - 1]!)) !== footer ||
    rows[n - 2] !== "" ||
    !labelledBottom.test(rows[n - 3]!) ||
    field === "" ||
    !borders.has(field.charAt(0)) ||
    !borders.has(field.charAt(field.length - 1)) ||
    cleanRow(field) !== marker
  ) {
    return false;
  }
  return isBoxTop(rows[n - 5]!);
}

// MARK: - Antigravity CLI 1.5.13's questions

/** Herdr's kind for Antigravity CLI: only a pane of it is read for its questions. */
export const agyKind = "agy";

/** The footer under agy's folder trust question, compared whole (collapsed, lowercased). */
export const agyTrustFooter = "↑/↓ navigate · enter confirm";
/** The footers under its permission questions: a command's, and a file's (create or edit). */
export const agyCommandFooter = "↑/↓ navigate · tab amend · ctrl+g edit/expand command";
export const agyFileFooter = "↑/↓ navigate · f full diff";
/** Its last row under a permission question: "esc to cancel", then maybe the model line at the right edge. */
const agyCancelRow = /^esc to cancel(?: {2,}(\S.*))?$/u;
/** The mode line's words ("auto · Gemini 4 Hydrogen · low"): one to four parts joined by " · ", plain words only. */
const agyModeWords = /^[\w.()/+-]+(?: [\w.()/+-]+)*(?: · [\w.()/+-]+(?: [\w.()/+-]+)*){0,3}$/u;
/** A choice row of the trust question: the marker's cell (`>` or blank), a space, the words. */
const agyTrustChoice = /^([> ]) (\S.*)$/u;
/** A numbered choice row of a permission question: the marker's cell, a space, the digit, `. `, the words. */
const agyAskChoice = /^([> ]) ([1-9])\. (\S.*)$/u;
/** A wrapped choice's next row: indented two to five cells, then words (assumed from Ink's wrapping; not seen live). */
const agyAskWrapped = /^ {2,5}(\S.*)$/u;
/** The rule under a permission question's title. */
const agyRule = /^─{4,}$/u;
/** The subject of a file question: the path, two spaces, "+N" and maybe " -N". */
const agySubject = /^(\S.*?) {2}\+(\d+)(?: -(\d+))?$/u;
/** agy's hint over the edit question, not part of the change. */
export const agyEditHint = "shift+tab to auto-approve file edits";

/** Its trust question's rows, word for word (the path between the title and the question). */
const agyTrustTitle = "Accessing workspace:";
const agyTrustQuestion = "Do you trust the contents of this project?";
const agyTrustWhy = "Antigravity CLI requires permission to read, edit, and execute files here.";
const agyTrustLabels = ["Yes, I trust this folder", "No, exit"] as const;
/** The trust question's path may wrap over this many rows. */
const agyPathRows = 4;
/** What the card says under "No, exit": agy quits on it. */
export const agyExitDetail = "Antigravity CLI quits";

/** The three permission questions: title, question, footer and the choices' words (a pattern where a command's prefix varies). */
const agyAsks = [
  {
    kind: "command",
    title: "Command",
    question: "Run this command?",
    footer: agyCommandFooter,
    labels: [/^Yes, run command$/u, /^Yes, and always allow in this conversation for commands that start with '.+'$/u, /^Yes, and always allow for commands that start with '.+' \(Persist to settings\.json\)$/u, /^No, cancel$/u],
  },
  { kind: "create", title: "Create file", question: "Allow creation of this file?", footer: agyFileFooter, labels: [/^Yes, allow creation$/u, /^No, deny creation$/u] },
  { kind: "edit", title: "Pending edit", question: "Accept this file edit?", footer: agyFileFooter, labels: [/^Yes, accept this change$/u, /^No, reject this change$/u] },
] as const;

export type AgyAskKind = (typeof agyAsks)[number]["kind"];

/** The last non-blank row at or above `from` (-1: none). */
function lastWords(rows: readonly string[], from: number): number {
  let index = from;
  while (index >= 0 && trimWhitespace(rows[index]!) === "") index -= 1;
  return index;
}

/**
 * Antigravity CLI's folder trust question at the screen's end, as agy 1.5.13 draws it before anything else:
 *
 *     Accessing workspace:
 *
 *     /path/to/folder
 *
 *     Do you trust the contents of this project?
 *
 *     Antigravity CLI requires permission to read, edit, and execute files here.
 *
 *     > Yes, I trust this folder
 *       No, exit
 *
 *       ↑/↓ Navigate · enter Confirm
 *                                                    auto · Gemini 4 Hydrogen · low
 *
 * Read whole at the bottom: the mode line the last row with words, the footer right above it (blank rows between
 * allowed), then (blank rows allowed) exactly the two choices in agy's words and order, exactly one marked `>`, then the
 * explanation, the question, the path (one to four rows, joined: a long path wraps) and the title, each with only blank
 * rows between, and the title the read's first row or under a blank one. Anything else: null.
 *
 * Its keys are the ones its footer names, never a digit (a digit does nothing there): Return answers the marked choice;
 * the other is reached with the arrow toward it, and Return goes only after a fresh read shows the marker there
 * (answerer.ts). The fingerprint holds the title, the path's rows as read (rawRows: nothing but escapes and a CRLF's
 * carriage return removed), the explanation, the question and the two choices' words, not where the marker sits. A
 * path row with a space at either edge (it cannot be told from padding), or a path that wraps short of the screen's
 * right edge (the mode line's end: it could be read two ways), leaves the screen unmatched.
 */
export function agyTrust(text: string, paneID: string): PromptMatch | null {
  const rows = drawnRows(text);
  const raw = rawRows(text);
  const mode = lastWords(rows, rows.length - 1);
  if (mode < 0 || !agyModeWords.test(trimWhitespace(rows[mode]!))) return null;
  const footer = lastWords(rows, mode - 1);
  if (footer < 0 || normalisedLower(collapse(trimWhitespace(rows[footer]!))) !== agyTrustFooter) return null;
  const second = lastWords(rows, footer - 1);
  const first = second - 1;
  if (first < 0) return null;
  const choices = [rows[first]!, rows[second]!].map((row) => agyTrustChoice.exec(row));
  if (choices.some((found) => found === null)) return null;
  const found = choices as RegExpExecArray[];
  if (found.some((match, index) => match[2] !== agyTrustLabels[index])) return null;
  const marked = found.map((match) => match[1] === ">");
  if (marked.filter(Boolean).length !== 1) return null;
  const why = lastWords(rows, first - 1);
  if (why < 0 || trimWhitespace(rows[why]!) !== agyTrustWhy) return null;
  const question = lastWords(rows, why - 1);
  if (question < 0 || trimWhitespace(rows[question]!) !== agyTrustQuestion) return null;
  // The path: one to four rows with words right above the question's blank row, then the title over a blank row.
  const pathEnd = lastWords(rows, question - 1);
  if (pathEnd < 0 || pathEnd === question - 1) return null;
  let pathStart = pathEnd;
  while (pathStart - 1 >= 0 && trimWhitespace(rows[pathStart - 1]!) !== "") pathStart -= 1;
  if (pathEnd - pathStart + 1 > agyPathRows) return null;
  // The path's rows as read. A space at a row's edge cannot be told from the terminal's padding or a wrap, and a
  // row that wraps short of the screen's right edge (the mode line's end) could be read two ways: unmatched.
  const pathRows = raw.slice(pathStart, pathEnd + 1);
  if (pathRows.some((row) => /^\s|\s$/u.test(row))) return null;
  const width = cells(rows[mode]!);
  if (pathRows.slice(0, -1).some((row) => cells(row) !== width)) return null;
  const path = pathRows.join("");
  if (!path.startsWith("/") && !path.startsWith("~")) return null;
  const title = lastWords(rows, pathStart - 1);
  if (title < 0 || title === pathStart - 1 || trimWhitespace(rows[title]!) !== agyTrustTitle) return null;
  if (title > 0 && trimWhitespace(rows[title - 1]!) !== "") return null;
  const markedIndex = marked.indexOf(true);
  const options = agyTrustLabels.map((label, index): PromptOption => {
    const base = { key: String(index + 1), label, isReturnDefault: marked[index]!, isSessionWide: false, opensComposer: false };
    const keys = marked[index] ? ["Enter"] : [index > markedIndex ? "Down" : "Up", "Enter"];
    return index === 1 ? { ...base, keys, detail: agyExitDetail } : { ...base, keys };
  });
  return {
    kind: "agyTrust",
    question: agyTrustQuestion,
    options,
    context: { type: "file", name: path },
    fingerprint: { rules: fingerprintRules, paneID, question: agyTrustQuestion, body: [agyTrustTitle, ...pathRows, agyTrustWhy], options: [...agyTrustLabels], words: agyTrustWords(pathRows, width) },
  };
}

/**
 * The words of agy's trust question: its width is the mode line's (it ends at the screen's right edge); the path's
 * rows are cut at that edge (or wrapped as Ink wraps, the same for a path with no blank), none in from the left. The
 * question, the title, the explanation and the labels are agy's own words.
 */
function agyTrustWords(pathRows: readonly string[], width: number): FingerprintWords {
  const frame: WrapFrame = { style: "either", low: width, high: width };
  const path = partText([{ rows: pathRows, next: 0, lines: false }], frame);
  // A folder whose row end is not told: no body text, the body compared by its rows.
  return { question: agyTrustQuestion, body: path === null ? null : [agyTrustTitle, path, agyTrustWhy].join("\n"), options: agyTrustLabels.join("\n") };
}

/** One numbered choice of a permission question, its wrapped rows joined. */
interface AgyChoice {
  readonly marked: boolean;
  readonly number: number;
  readonly label: string;
  /** Its rows as drawn, the marker's cell blank. */
  readonly drawn: readonly string[];
}

/**
 * Antigravity CLI's permission questions at the screen's end (agy 1.5.13, asked before a command, a new file or an
 * edit), read whole at the bottom:
 *
 *     Command                            Create file                       Pending edit
 *     ────────────                       ────────────                      ────────────
 *
 *     Requesting permission for:         /path/ask.txt  +1                 /path/notes.txt  +1 -1
 *        date                              1  +  hello                       1  -  alpha
 *                                                                            1  +  ALPHA
 *     Run this command?                  Allow creation of this file?
 *     > 1. Yes, run command              > 1. Yes, allow creation            shift+tab to auto-approve file edits
 *       2. Yes, and always allow …         2. No, deny creation            Accept this file edit?
 *       3. Yes, and always allow … (Persist to settings.json)               > 1. Yes, accept this change
 *       4. No, cancel                                                         2. No, reject this change
 *
 *       ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command      (a file's: ↑/↓ Navigate · f full diff)
 *     esc to cancel                                        Gemini 4 Hydrogen · low
 *
 * The last row with words is "esc to cancel" (the model line at its right maybe); the footer right above it; then
 * (blank rows allowed) the numbered choices from 1, in agy's words for that question, exactly one marked `>`, a choice's
 * wrapped rows joined; the question right above them; the body above it up to the rule; the title over the rule, the
 * read's first row or under a blank one. The command's body opens with "Requesting permission for:" and holds the
 * command; a file's opens with its path and counts. Anything else (another word, a fifth choice, a missing footer, two
 * markers or none, the frame with more rows under it): null.
 *
 * A choice's answer is its digit alone (a digit answers at once there). The fingerprint holds the title, every row
 * between the rule and the question and the choices' rows, each as read (rawRows: blank rows and spaces kept), not
 * where the marker sits. On an agy pane nothing else reads the screen (matchPrompt): a frame this rejects is unmatched.
 */
export function agyAsk(text: string, paneID: string): PromptMatch | null {
  const rows = drawnRows(text);
  const raw = rawRows(text);
  const cancel = lastWords(rows, rows.length - 1);
  if (cancel < 0 || !agyCancelRow.test(trimWhitespace(rows[cancel]!))) return null;
  const tail = agyCancelRow.exec(trimWhitespace(rows[cancel]!))![1];
  if (tail !== undefined && !agyModeWords.test(tail)) return null;
  const footerRow = cancel - 1;
  if (footerRow < 0) return null;
  const footer = normalisedLower(collapse(trimWhitespace(rows[footerRow]!)));
  const end = lastWords(rows, footerRow - 1);
  if (end < 0) return null;
  // The choices, bottom up: a choice row, or a wrapped row joined to the choice above it.
  const choices: AgyChoice[] = [];
  let wrapped: string[] = [];
  let wrappedRaw: string[] = [];
  let index = end;
  for (; index >= 0; index -= 1) {
    const row = rows[index]!;
    const choice = agyAskChoice.exec(row);
    if (choice !== null) {
      const label = [choice[3]!, ...wrapped.map(trimWhitespace)].join(" ");
      choices.unshift({ marked: choice[1] === ">", number: Number(choice[2]), label, drawn: [` ${raw[index]!.slice(1)}`, ...wrappedRaw] });
      wrapped = [];
      wrappedRaw = [];
      continue;
    }
    // At most three wrapped rows under a choice.
    if (agyAskWrapped.test(row) && wrapped.length < 3) {
      wrapped.unshift(row);
      wrappedRaw.unshift(raw[index]!);
      continue;
    }
    break;
  }
  if (wrapped.length > 0 || choices.length === 0) return null;
  if (choices.some((choice, at) => choice.number !== at + 1)) return null;
  if (choices.filter((choice) => choice.marked).length !== 1) return null;
  const questionRow = index;
  if (questionRow < 0) return null;
  const question = trimWhitespace(rows[questionRow]!);
  const ask = agyAsks.find((candidate) => candidate.question === question && candidate.footer === footer);
  if (ask === undefined || choices.length !== ask.labels.length) return null;
  if (choices.some((choice, at) => !ask.labels[at]!.test(choice.label))) return null;
  // The title over the rule, above the body.
  let rule = questionRow - 1;
  while (rule >= 0 && !agyRule.test(trimWhitespace(rows[rule]!))) rule -= 1;
  const title = rule - 1;
  if (title < 0 || rows[title] !== ask.title) return null;
  if (title > 0 && trimWhitespace(rows[title - 1]!) !== "") return null;
  // The body's rows with words, to read it; the fingerprint holds every row as read (below).
  const body = rows.slice(rule + 1, questionRow).filter((row) => trimWhitespace(row) !== "");
  let context: PromptContext;
  let run: ClaudeRun | undefined;
  if (ask.kind === "command") {
    if (body.length < 2 || trimWhitespace(body[0]!) !== "Requesting permission for:") return null;
    // The command's rows under it, its own blank rows inside kept (the frame's blank rows around it left out).
    let first = rows.indexOf(body[0]!, rule + 1) + 1;
    let last = questionRow - 1;
    while (first <= last && trimWhitespace(rows[first]!) === "") first += 1;
    while (last >= first && trimWhitespace(rows[last]!) === "") last -= 1;
    const lines = rows.slice(first, last + 1).map((row) => row.replace(/^ {1,3}/u, ""));
    context = { type: "command", text: lines.join("\n") };
    if (lines.length > 1) run = { rows: lines, description: null };
  } else {
    const subject = agySubject.exec(trimWhitespace(body[0] ?? ""));
    if (subject === null) return null;
    if (ask.kind === "edit" && body.slice(1, -1).some((row) => trimWhitespace(row) === agyEditHint)) return null;
    context = ask.kind === "create" ? { type: "file", name: subject[1]! } : { type: "diff", added: Number(subject[2]), removed: Number(subject[3] ?? "0") };
  }
  const options = choices.map(
    (choice, at): PromptOption => ({
      key: String(choice.number),
      label: choice.label,
      isReturnDefault: choice.marked,
      // "Yes, and always allow …": for this conversation, or kept in settings.json.
      isSessionWide: ask.kind === "command" && (at === 1 || at === 2),
      opensComposer: false,
      keys: [String(choice.number)],
    }),
  );
  return {
    kind: "agyAsk",
    question,
    options,
    context,
    // Every row between the rule and the question as read: blank rows and spaces are part of the question.
    fingerprint: {
      rules: fingerprintRules,
      paneID,
      question,
      body: [raw[title]!, ...raw.slice(rule + 1, questionRow)],
      options: choices.flatMap((choice) => choice.drawn),
      words: agyAskWords(ask.kind, raw, title, rule, questionRow, choices, cells(trimWhitespace(rows[rule]!))),
    },
    ...(run === undefined ? {} : { run }),
  };
}

/** A diff row's start in agy's file questions: its line number, then its mark. */
const agyDiffStart = /^ +\d+ +[+-]/u;

/**
 * The words of agy's three permission questions: the frame's width is its rule's (a full row of `─`), and agy's own
 * padding may keep its rows a cell or two short of it (a row that reaches the rule says it does not). The command's rows are three cells in and may hold line
 * breaks; a file question's subject row and each diff line (a row that starts with its number and mark, and the
 * rows under it) are one line each; the rows are cut at the edge or wrapped as Ink wraps ("either"). The choices
 * wrap at blanks five cells in ("words").
 */
function agyAskWords(kind: AgyAskKind, raw: readonly string[], title: number, rule: number, questionRow: number, choices: readonly AgyChoice[], width: number): FingerprintWords {
  const rows = raw.slice(rule + 1, questionRow).map(dropTrailingBlanks);
  // The edge: the rule's, or up to two cells short of it (agy's own padding, not seen live), and never short of a row.
  const frame: WrapFrame = { style: "either", low: Math.max(width - 2, widest(rows)), high: width };
  const body: WrapSection[] = [{ rows: [dropTrailingBlanks(raw[title]!)], next: 0, lines: false }];
  if (kind === "command") {
    const at = rows.findIndex((row) => trimWhitespace(row) !== "");
    body.push({ rows: [rows[at]!], next: 0, lines: false }, { rows: rows.slice(at + 1), next: 3, lines: true });
  } else {
    let current: string[] | null = null;
    for (const row of rows) {
      if (trimWhitespace(row) === "") {
        current = null;
      } else if (current === null || agyDiffStart.test(row)) {
        current = [row];
        body.push({ rows: current, next: 0, lines: false });
      } else {
        current.push(row);
      }
    }
  }
  const options = choices.map((choice): WrapSection => ({ rows: choice.drawn.map(dropTrailingBlanks), next: 5, lines: false }));
  const choiceRows = options.flatMap((section) => section.rows);
  return {
    ...questionWords([{ rows: [raw[questionRow]!], next: 0, lines: false }], frame),
    body: partText(body, frame),
    options: partText(options, { style: "words", low: Math.max(width - 2, widest(choiceRows)), high: width }),
  };
}

/** Which of agy's permission questions a match is ("command", "create", "edit"); null for any other match. */
export function agyAskKind(match: Pick<PromptMatch, "kind" | "question">): AgyAskKind | null {
  if (match.kind !== "agyAsk") return null;
  return agyAsks.find((ask) => ask.question === match.question)?.kind ?? null;
}

/** Antigravity CLI's question at the screen's end: its folder trust question, else a permission question; null for none. */
export function agyQuestion(text: string, paneID: string): PromptMatch | null {
  return agyTrust(text, paneID) ?? agyAsk(text, paneID);
}

/**
 * Some part of an agy question at the screen's end: one of its footers among the last rows with words. Counts the
 * screen as prompt-like on an agy pane (quiet.ts), so a question partly drawn keeps its mark.
 */
export function agyTrace(text: string): boolean {
  const rows = drawnRows(text)
    .map((row) => normalisedLower(collapse(trimWhitespace(row))))
    .filter((row) => row !== "");
  return rows.slice(-3).some((row) => row === agyTrustFooter || row === agyCommandFooter || row === agyFileFooter);
}
