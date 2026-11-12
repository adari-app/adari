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
// Swift counts Characters; this port counts code points (the same for every
// row a supported agent draws).

import { effortPattern, modelIdPatterns } from "../model-catalog";

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
 */
export type PromptKind = "menu" | "yesNo" | "grok" | "codexForm" | "codexUpdate";

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

export function sameFingerprint(a: PromptFingerprint, b: PromptFingerprint): boolean {
  return (
    a.rules === b.rules &&
    a.paneID === b.paneID &&
    a.question === b.question &&
    a.body.length === b.body.length &&
    a.body.every((row, index) => row === b.body[index]) &&
    a.options.length === b.options.length &&
    a.options.every((row, index) => row === b.options[index])
  );
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
export function matchPrompt(text: string, paneID: string, agentKind: string | null = null): PromptReading {
  const kind = agentKind?.toLowerCase();
  if (kind === "grok") {
    const grok = grokFrame(text, paneID);
    if (grok !== null) return { type: "matched", match: grok };
  }
  if (kind === "codex") {
    const form = codexForm(text, paneID);
    if (form !== null) return { type: "matched", match: form };
    // Its update question at start.
    const update = codexUpdatePrompt(text, paneID);
    if (update !== null) return { type: "matched", match: update };
  }
  const raw = readRows(text);
  const drawn = raw.map(withoutEscapes);
  const screen: Screen = {
    drawn,
    lines: raw.map(cleanRow),
    complete: raw.length < promptReadLines,
    width: drawn.reduce((widest, row) => Math.max(widest, length(dropTrailingBlanks(row))), 0),
  };
  const menu = matchMenu(screen, paneID);
  if (menu !== null) return { type: "matched", match: menu };
  const yesNo = matchYesNo(screen, paneID);
  if (yesNo !== null) return { type: "matched", match: yesNo };
  // On a Claude pane, its frame with the header above the read (unmatched, `cut`).
  if (kind === "claude") {
    const cut = cutFrame(screen);
    if (cut !== null) return { type: "unmatched", lines: cut.lines, cut };
  }
  return { type: "unmatched", lines: tail(screen.lines) };
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
  let end = lines.length - 1;
  let closedBox = false;
  let footer: string | null = null;
  while (end >= 0) {
    const line = lines[end]!;
    if (line === "") {
      end -= 1;
    } else if (isBorder(line)) {
      if (isBoxBottom(line)) closedBox = true;
      end -= 1;
    } else if (promptFooters.has(normalisedLower(collapse(line)))) {
      footer = normalisedLower(collapse(line));
      end -= 1;
    } else {
      break;
    }
  }
  if (end < 0) return null;
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
  const fingerprint: PromptFingerprint = {
    rules: fingerprintRules,
    paneID,
    question,
    body: framedBody(screen, body[0], body[1]),
    options: run.flatMap((entry) => [entry.line.drawn, ...entry.more.map((at) => framed(screen.drawn[at]!))]),
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
 * allowed), blank rows, its options numbered from 1, the question right above
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
  let end = lines.length - 1;
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
  return { question, rows: lines.slice(opening + 1, closing).filter((line) => line !== ""), lines: tail(lines) };
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

/** Terminal cells `text` takes: two for a wide character, else one. Counting one too wide only makes a wrap more likely. */
export function cells(text: string): number {
  let total = 0;
  for (const character of text) {
    const value = character.codePointAt(0)!;
    const wide =
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
      (value >= 0x20000 && value <= 0x3fffd);
    total += wide ? 2 : 1;
  }
  return total;
}

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

function tail(lines: readonly string[]): string[] {
  return lines.filter((line) => line !== "" && !isBorder(line)).slice(-unmatchedLineCount);
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
export function codexForm(text: string, paneID: string): PromptMatch | null {
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
    },
  };
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
