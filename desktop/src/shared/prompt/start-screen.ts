// An agent's own start screen that waits for the person while Herdr reports
// the pane idle. Codex 0.167.0, the first time it starts with hooks it has not
// seen (Herdr's integration just installed them), asks before it runs them (as
// read in a clean home folder, word for word):
//
//       Hooks need review
//       1 hook is new or changed.
//       Hooks can run outside the sandbox after you trust them.
//
//
//     › 1. Review hooks
//       2. Trust all and continue
//       3. Continue without trusting (hooks won't run)
//
//       enter confirm · esc skip
//
// Herdr says `idle` there, so nothing else in Adari says Codex is waiting.
// readStartScreen reads it conservatively (the whole live menu only): the
// title as a whole line, then Codex's three choices in order with their
// labels, exactly one with the selected marker,
// and Codex's footer ("enter confirm · esc skip") as the screen's last row, so
// the question is what the screen shows now, not words in the output above it.
// Only a Codex pane is read so. Adari never answers it: no key is ever sent
// (src/main/start-screens.ts reads only, and a send to the pane is refused
// while it shows). There is no other start screen with a path of its own in
// Adari (Codex's folder trust screen comes before Herdr's hooks and is not
// read anywhere), so this is the one kind.
//
// Three more agents draw their own question before their prompt while Herdr
// reports the pane idle (read live at 119 columns; the frames are the tests'
// positive controls, byte for byte):
//
// - Grok Build 1.0.77, in a folder it has not seen: "Do you trust the contents
//   of this directory?", with "Yes, proceed  y" and "No, quit  n", and its
//   version line at the bottom of the screen ("Grok Build  1.0.77 [stable]").
//   A letter y or n in a message answers it (grokTrust).
// - Cursor Agent 2026.11.05: a box with "Workspace Trust Required", "[a] Trust
//   this workspace" (marked) and "[q] Quit", and its hint "Use arrow keys to
//   navigate, Enter to select, or press the key shown". A q quits it
//   (cursorTrust).
// - Gemini CLI 0.65.0: a box with "Do you trust the files in this folder?" and
//   three numbered choices, one marked (geminiTrust); signed out, after it, a
//   box with "Get started", "How would you like to authenticate for this
//   project?", "1. Sign in with Google", "2. Use Gemini API Key", "3. Vertex
//   AI" (one marked) and its own rows under them (geminiSignIn). A Return picks
//   the marked choice.
//
// Each is read as Codex's is: the whole live question at the bottom of the
// screen (its title row, its choice rows with their labels and keys, then
// nothing but blank rows, the agent's own rows under the choices, the box's
// bottom edge or the agent's own footer), so the words quoted in a reply, a
// partial frame or other text are ordinary output. Adari never answers one.

import type { HostView } from "../ipc-contract";
import { knownAgentName } from "../agent-names";
import { agentKind, agentSession } from "../send-binding";

/**
 * The start screens read: Codex's hook review; Grok Build's folder trust, Cursor Agent's workspace trust, Gemini CLI's
 * folder trust and its sign-in picker.
 */
export type StartScreenKind = "codexHookReview" | "grokTrust" | "cursorTrust" | "geminiTrust" | "geminiSignIn";

/** One pane showing a start screen, as the main process last read it. */
export interface PaneStartScreen {
  readonly paneId: string;
  readonly kind: StartScreenKind;
  /** The pane's terminal when it was read: the page applies it only while the pane still has it. */
  readonly terminalID: string;
}

/** A machine's panes showing a start screen (HostView.startScreens), read on one entry, connection and command connection. */
export interface HostStartScreens {
  readonly incarnation: number;
  readonly connection: number;
  readonly epoch: number | null;
  readonly panes: readonly PaneStartScreen[];
}

/** How many of the pane's last lines are read (Codex). */
export const startScreenReadLines = 40;
/**
 * How many are read for Grok Build, Cursor Agent and Gemini CLI. Grok Build draws its question near the middle of the
 * screen and its version line on the last row, so on a tall pane the title sits more than 40 rows up. 200, one bounded
 * read (Herdr's snapshot names no pane height). A read whose bottom is any part of one of the kind's questions that is
 * not the whole question (a screen taller than the read, a row that will not join) is unverified, and a Send to it is
 * refused (readStartScreenState).
 */
export const tallStartScreenReadLines = 200;

/** The agent kinds whose start screens are read. */
export const startScreenKinds: ReadonlySet<string> = new Set(["codex", "grok", "cursor", "gemini"]);

/** The agent kind each screen belongs to. */
export const startScreenAgent: Readonly<Record<StartScreenKind, string>> = {
  codexHookReview: "codex",
  grokTrust: "grok",
  cursorTrust: "cursor",
  geminiTrust: "gemini",
  geminiSignIn: "gemini",
};

/** How many of the last lines of a pane running `kind` are read for its start screen. */
export function startScreenLines(kind: string): number {
  return kind.toLowerCase() === "codex" ? startScreenReadLines : tallStartScreenReadLines;
}

const hookTitle = "Hooks need review";
/**
 * Codex's three choices, in order, with their labels as its screen shows them
 * (its curly quote read as a plain one).
 */
const hookChoices = ["Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)"] as const;
/** Codex's footer under the choices, its spaces collapsed. */
const hookFooter = "enter confirm \u00B7 esc skip";
/** Codex's selected-choice marker. */
const selectedMarker = "\u203A";
/** A numbered choice, the selected one with Codex's marker in front (group 1: the marker, 2: its number, 3: its label). */
const choiceRow = /^(\u203A\s*)?(\d{1,2})\.\s+(\S.*)$/u;
/** At most this many rows between the title and the first choice (Codex's two description lines and blanks). */
const maxRowsBeforeChoices = 8;

/** A row as compared: no colour codes or control characters, Codex's curly quote as a plain one, the ends trimmed. */
function plain(row: string): string {
  return (
    row
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\u00A0/g, " ")
      .trim()
  );
}

/**
 * Codex's hook review as the screen shows it now (`text`: the pane's last lines), or false.
 *
 * Only the whole live menu matches, at the bottom of the screen: the title
 * "Hooks need review" as a whole line, within 8 rows the three choices in order with Codex's labels ("1. Review
 * hooks", "2. Trust all and continue", "3. Continue without trusting (hooks won't run)"), exactly one of them with
 * the selected-choice marker, then only blank rows, Codex's footer "enter confirm \u00B7 esc skip", and only blank
 * rows after it. A quotation without the marker, a partial menu, other labels, no footer or text after the footer
 * is ordinary output.
 */
export function showsCodexHookReview(text: string): boolean {
  const rows = text.split(/\r\n|\r|\n/).map(plain);
  // The last non-blank row is the footer.
  let footer = rows.length - 1;
  while (footer >= 0 && rows[footer] === "") footer -= 1;
  if (footer < 0 || rows[footer]!.replace(/\s+/g, " ") !== hookFooter) return false;
  // Above it, after blank rows only, the three choices.
  let last = footer - 1;
  while (last >= 0 && rows[last] === "") last -= 1;
  const first = last - (hookChoices.length - 1);
  if (first < 1) return false;
  let selected = 0;
  for (let index = 0; index < hookChoices.length; index += 1) {
    const found = choiceRow.exec(rows[first + index]!);
    if (found === null || Number(found[2]) !== index + 1 || found[3]!.trim() !== hookChoices[index]) return false;
    if (found[1] !== undefined) selected += 1;
  }
  if (selected !== 1) return false;
  // The title as a whole line within 8 rows above the first choice, and no other numbered or marked row between.
  for (let at = first - 1; at >= 0 && at >= first - 1 - maxRowsBeforeChoices; at -= 1) {
    const row = rows[at]!;
    if (row === hookTitle) return true;
    if (choiceRow.test(row) || row.startsWith(selectedMarker)) return false;
  }
  return false;
}

// MARK: - Grok Build, Cursor Agent and Gemini CLI

/** One agent's start question as its screen draws it, row by row (each row compared as `plain` gives it). */
interface StartQuestion {
  /** The title, a whole row (inside the box: the first row in it that is not blank). */
  readonly title: RegExp;
  /** Rows that must stand between the title and the first choice, in order (each a whole row). */
  readonly between: readonly RegExp[];
  /** The choices, in order, each a whole row once the selected-choice marker is taken off; no row between them. */
  readonly choices: readonly RegExp[];
  /** The selected-choice marker, on exactly one choice (null: the screen marks the choice by colour only). */
  readonly marker: string | null;
  /**
   * The agent's own rows allowed under the choices, in this order, each at most once (blank rows anywhere).
   * `status` is the agent's one status line there, whatever it says (a few rows of text, none
   * a choice), allowed only with the row after it in this list shown under it, or as `statusKnown`.
   */
  readonly after: readonly (RegExp | "status")[];
  /** The status line's usual words (allowed even without the row after it). */
  readonly statusKnown?: RegExp;
  /** Drawn in a box: its bottom edge is the screen's last row and its top edge sits right above the title. */
  readonly boxed: boolean;
  /** A row allowed as the screen's very last one, under everything (the agent's own footer). */
  readonly footer: RegExp | null;
  /**
   * The question's own rows as the agent draws them, spaces collapsed (a choice's folder left
   * out): a read whose bottom is any part of these is never clear (partAtBottom).
   */
  readonly parts: readonly string[];
  /**
   * The row that starts the agent's own input prompt (Grok's `❯`, Cursor's `→`,
   * Gemini's `>`), with what is typed after it. No question of theirs draws one; rows from it down are typed input.
   */
  readonly input: RegExp;
}

/** At most this many rows between the title and the first choice of a question with no box (a box bounds its own). */
const maxQuestionRows = 16;
/** A known row wrapped onto at most this many more rows is read as one. */
const maxWrapRows = 6;
/** At most this many rows of the agent's status line. */
const maxStatusRows = 4;
/** A box's edges and a row inside it, as `plain` gives them. */
const boxTop = /^╭─+╮$/u;
const boxBottom = /^╰─+╯$/u;
const boxRow = /^│(.*)│$/u;
/** A row that is some menu's choice: numbered, keyed in brackets, or with a selection marker in front. */
const choiceLike = /^(?:[›▶●>❯]\s*)?(?:\d{1,2}\.|\[[a-z0-9]\])\s/u;

/** Grok Build's and Gemini CLI's own input prompt rows (Cursor's is in its entry). */
const grokInput = /^❯(?:\s|$)/u;
const geminiInput = /^>(?:\s|$)/u;

const startQuestions: Readonly<Record<Exclude<StartScreenKind, "codexHookReview">, StartQuestion>> = {
  // Grok Build 1.0.77 (trust-frame-grok-raw.txt): centred, no box, both choices drawn alike, its version line last.
  grokTrust: {
    title: /^Do you trust the contents of this directory\?$/,
    between: [],
    choices: [/^Yes, proceed\s+y$/, /^No, quit\s+n$/],
    marker: null,
    after: [],
    boxed: false,
    footer: /^Grok Build\s+v?\d+(?:\.\d+)+(?:\s+\[[A-Za-z0-9._-]+\])?$/,
    parts: ["Do you trust the contents of this directory?", "Grok Build may run or modify contents in this directory,", "posing security risks.", "Yes, proceed y", "No, quit n"],
    input: grokInput,
  },
  // Cursor Agent 2026.11.05 (trust-frame-cursor-raw.txt): in a box, the marked choice with a triangle, its hint under them.
  cursorTrust: {
    title: /^(?:⚠️?\s*)?Workspace Trust Required$/u,
    between: [/^Do you trust the contents of this directory\?$/],
    choices: [/^\[a\] Trust this workspace$/, /^\[q\] Quit$/],
    marker: "▶",
    after: [/^Use arrow keys to navigate, Enter to select, or press the key shown$/],
    boxed: true,
    footer: null,
    parts: [
      "Workspace Trust Required",
      "Cursor Agent can execute code and access files in this directory.",
      "Do you trust the contents of this directory?",
      "[a] Trust this workspace",
      "[q] Quit",
      "Use arrow keys to navigate, Enter to select, or press the key shown",
    ],
    input: /^→(?:\s|$)/u,
  },
  // Gemini CLI 0.65.0 (trust-frame-gemini-raw.txt): in a box, three numbered choices, the marked one with a dot.
  geminiTrust: {
    title: /^Do you trust the files in this folder\?$/,
    between: [],
    choices: [/^1\. Trust folder \(.+\)$/, /^2\. Trust parent folder \(.+\)$/, /^3\. Don't trust$/],
    marker: "●",
    after: [],
    boxed: true,
    footer: null,
    parts: [
      "Do you trust the files in this folder?",
      "Trusting a folder allows Gemini CLI to load its local configurations, including custom commands, hooks, MCP servers, agent skills, and settings. These configurations could execute code on your behalf or change the behavior of the CLI.",
      "1. Trust folder (",
      "2. Trust parent folder (",
      "3. Don't trust",
    ],
    input: geminiInput,
  },
  // Gemini CLI 0.65.0 signed out (signin-frame-gemini-raw.txt): in a box, three numbered ways in, its status line
  // ("No authentication method selected.", or an error after a failed sign-in), its Enter hint, its terms and link.
  geminiSignIn: {
    title: /^(?:\?\s+)?Get started$/,
    between: [/^How would you like to authenticate for this project\?$/],
    choices: [/^1\. Sign in with Google$/, /^2\. Use Gemini API Key$/, /^3\. Vertex AI$/],
    marker: "●",
    after: ["status", /^\(Use Enter to select\)$/, /^Terms of Services and Privacy Notice for Gemini CLI$/, /^https:\/\/geminicli\.com\/docs\/resources\/tos-privacy\/?$/],
    statusKnown: /^No authentication method selected\.$/,
    boxed: true,
    footer: null,
    parts: [
      "Get started",
      "How would you like to authenticate for this project?",
      "1. Sign in with Google",
      "2. Use Gemini API Key",
      "3. Vertex AI",
      "No authentication method selected.",
      "(Use Enter to select)",
      "Terms of Services and Privacy Notice for Gemini CLI",
      "https://geminicli.com/docs/resources/tos-privacy/",
    ],
    input: geminiInput,
  },
};

/** The last row at or above `from` that is not blank (-1: none). */
function lastFilled(rows: readonly string[], from: number): number {
  let at = from;
  while (at >= 0 && rows[at] === "") at -= 1;
  return at;
}

/** A row with the selected-choice marker taken off (`marked`: it had it). */
function unmarked(row: string, question: StartQuestion): { readonly row: string; readonly marked: boolean } {
  return question.marker !== null && row.startsWith(question.marker) ? { row: row.slice(question.marker.length).trim(), marked: true } : { row, marked: false };
}

/** Whether `row` is one of the question's own rows, whole (its title, a required row, a choice, a row under them). */
function knownRow(row: string, question: StartQuestion): boolean {
  const bare = unmarked(row, question).row;
  const patterns = [question.title, ...question.between, ...question.choices, ...question.after.filter((item): item is RegExp => item !== "status")];
  if (question.statusKnown !== undefined) patterns.push(question.statusKnown);
  if (question.footer !== null) patterns.push(question.footer);
  return patterns.some((pattern) => pattern.test(row) || pattern.test(bare));
}

/** One row as drawn: its text (trimmed) and whether it reached the width it is drawn in (a long word broken there). */
interface DrawnRow {
  readonly text: string;
  readonly full: boolean;
}

/**
 * The rows with the question's own rows that wrapped (a label, a sentence, a footer, a link or a
 * long folder name too wide for the pane) joined back: a row that is not one of them whole, joined with up to 6 rows
 * under it (no blank row between), is one when the join is (joined with a space, or with nothing after a row that
 * reached the width). Other rows stay as they are.
 */
function joinWrapped(rows: readonly DrawnRow[], question: StartQuestion): string[] {
  const out: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!.text;
    if (row === "" || knownRow(row, question)) {
      out.push(row);
      continue;
    }
    let joined: { readonly text: string; readonly used: number } | null = null;
    for (let more = 1; more <= maxWrapRows && index + more < rows.length && rows[index + more]!.text !== ""; more += 1) {
      const parts = rows.slice(index, index + more + 1);
      const byWidth = parts.reduce((text, part, at) => (at === 0 ? part.text : `${text}${parts[at - 1]!.full ? "" : " "}${part.text}`), "");
      const found = [byWidth, parts.map((part) => part.text).join(" "), parts.map((part) => part.text).join("")].find((candidate) => knownRow(candidate, question));
      if (found !== undefined) {
        joined = { text: found, used: more };
        break;
      }
    }
    if (joined === null) out.push(row);
    else {
      out.push(joined.text);
      index += joined.used;
    }
  }
  return out;
}

/**
 * Whether `text` (the pane's last lines) ends with `question` as the agent draws it now: from the
 * bottom, only blank rows and the agent's own footer; for a boxed question, the box's bottom edge, every row up to its
 * top edge inside it, the title its first row that is not blank; under the choices only blank rows and the agent's own
 * rows in order; the choices one after another with their labels and keys, exactly one marked where the screen marks
 * one; above them (within 16 rows where there is no box), after the rows that must stand between, the title as a whole
 * row, with no other choice-like row between. Anything else (a quotation with text under it, a frame missing its
 * choices or its title, another question's words) is ordinary output.
 *
 * Rows of the question that wrapped are joined back first, and Gemini's status line may say anything. A part of the
 * question at the bottom that this cannot prove whole is partAtBottom's.
 */
function showsQuestion(text: string, question: StartQuestion): boolean {
  const plainRows = text.split(/\r\n|\r|\n/).map(plain);
  let end = lastFilled(plainRows, plainRows.length - 1);
  if (end < 0) return false;
  if (question.footer !== null && question.footer.test(plainRows[end]!)) end = lastFilled(plainRows, end - 1);
  if (end < 0) return false;
  // A box: its bottom edge last, every row up to its top edge inside it, and only what is inside counts.
  let drawn: DrawnRow[];
  if (question.boxed) {
    if (!boxBottom.test(plainRows[end]!)) return false;
    let at = end - 1;
    while (at >= 0 && boxRow.test(plainRows[at]!)) at -= 1;
    if (at < 0 || !boxTop.test(plainRows[at]!)) return false;
    drawn = boxInside(plainRows, at + 1, end);
  } else {
    drawn = plainRows.slice(0, end + 1).map((row) => ({ text: row, full: false }));
  }
  const rows = joinWrapped(drawn, question);
  end = rows.length - 1;
  // The title is the box's first row that is not blank.
  const top = question.boxed ? rows.findIndex((row) => row !== "") : -1;
  if (question.boxed && (top < 0 || !question.title.test(rows[top]!))) return false;
  // Under the choices: blank rows and the agent's own rows, in their order, each at most once; Gemini's status line.
  let last = end;
  let allowed = question.after.length - 1;
  let shownAfter = -1;
  for (;;) {
    last = lastFilled(rows, last);
    if (last < 0) return false;
    const row = rows[last]!;
    let found = -1;
    for (let index = allowed; index >= 0; index -= 1) {
      const item = question.after[index]!;
      if (item === "status") {
        const known = question.statusKnown?.test(row) === true;
        if (known || (shownAfter === index + 1 && !choiceLike.test(row) && unmarked(row, question).marked === false)) {
          found = index;
          // The status line's other rows (text, no choice, no blank row between).
          if (!known) {
            let rowsUsed = 1;
            while (rowsUsed < maxStatusRows && last - 1 >= 0 && rows[last - 1] !== "" && !choiceLike.test(rows[last - 1]!) && !unmarked(rows[last - 1]!, question).marked && !knownRow(rows[last - 1]!, question)) {
              last -= 1;
              rowsUsed += 1;
            }
          }
        }
        if (found >= 0) break;
        continue;
      }
      if (item.test(row)) {
        found = index;
        break;
      }
    }
    if (found < 0) break;
    allowed = found - 1;
    shownAfter = found;
    last -= 1;
  }
  // The choices, one after another, in order, with their labels and keys.
  const first = last - (question.choices.length - 1);
  if (first < 0) return false;
  let marked = 0;
  for (let index = 0; index < question.choices.length; index += 1) {
    const choice = unmarked(rows[first + index]!, question);
    if (choice.marked) marked += 1;
    if (!question.choices[index]!.test(choice.row)) return false;
  }
  if (question.marker !== null && marked !== 1) return false;
  // Above them: the rows that must stand between (in order, from the bottom up), then the title.
  let needed = question.between.length - 1;
  const lowest = question.boxed ? 0 : Math.max(0, first - 1 - maxQuestionRows);
  for (let at = first - 1; at >= lowest; at -= 1) {
    const row = rows[at]!;
    if (needed < 0 && question.title.test(row)) return !question.boxed || at === top;
    if (choiceLike.test(row) || (question.marker !== null && row.startsWith(question.marker))) return false;
    if (needed >= 0 && question.between[needed]!.test(row)) needed -= 1;
  }
  return false;
}

/** The rows inside a box (`from` to `to`, exclusive), as drawn: each row's text and whether it filled the box's width. */
function boxInside(rows: readonly string[], from: number, to: number): DrawnRow[] {
  return rows.slice(from, to).map((row) => {
    const inner = boxRow.exec(row)![1]!;
    return { text: inner.trim(), full: !/\s$/u.test(inner) };
  });
}

/** Spaces collapsed, the selected-choice marker taken off. */
const collapsed = (row: string, question: StartQuestion): string => unmarked(row, question).row.replace(/\s+/g, " ").trim();

/**
 * Whether `row` is a recognisable part of `question`: one of its rows whole, a row holding one of its parts (at
 * least 12 characters: a choice whose folder would not join), or 12 characters or more out of one of its parts (a
 * piece of a row that wrapped). `wrappedEnd`: also the end of one of its parts, however short (the last piece of a row
 * that wrapped, the read starting inside it).
 */
function isPart(row: string, question: StartQuestion, wrappedEnd: boolean): boolean {
  if (row === "") return false;
  if (knownRow(row, question)) return true;
  const text = collapsed(row, question);
  return question.parts.some((part) => (part.length >= 12 && text.includes(part)) || (text.length >= 12 && part.includes(text)) || (wrappedEnd && part.endsWith(text)));
}

/**
 * Whether the bottom of `text` is a part of `question` with no ordinary prompt of the agent under it. From the bottom,
 * past blank rows and the agent's own footer: for a boxed question, a box's bottom edge, and in that box (up to its
 * top edge, or up to the top of the read when the read starts inside it) one of the question's parts; for Grok's, the
 * last row (joined with the rows it wrapped from) one of its parts. An agent's prompt under the question (its input
 * row, its box with the line under it) is not: that is a quotation or an answered question, and stays clear.
 *
 * The agent's own input at the bottom is never a part, whatever words are typed in it: for Grok, the rows from its `❯`
 * prompt row down (no blank row between) to the last row; for Cursor and Gemini, a bottom box holding their prompt row
 * (their input box). Their questions never draw that prompt.
 *
 * An input box is the box's real layout only: its top edge read and its prompt row its first row that is not blank (a
 * folder name's `>` wrapped onto a row deeper in a question's box is not input). Grok's input may hold empty
 * paragraphs: its `❯` row is found across blank rows as long as no row between it and the last paragraph is a part of
 * the question, and that last paragraph does not hold all of its choices (an older prompt above a live question keeps
 * the question's rows under it, so it is not input).
 */
function partAtBottom(text: string, question: StartQuestion): boolean {
  const rows = text.split(/\r\n|\r|\n/).map(plain);
  let end = lastFilled(rows, rows.length - 1);
  if (end >= 0 && question.footer !== null && question.footer.test(rows[end]!)) end = lastFilled(rows, end - 1);
  if (end < 0) return false;
  if (question.boxed) {
    if (!boxBottom.test(rows[end]!)) return false;
    let at = end - 1;
    while (at >= 0 && boxRow.test(rows[at]!)) at -= 1;
    const inside = boxInside(rows, at + 1, end);
    const first = inside.find((row) => row.text !== "");
    if (at >= 0 && boxTop.test(rows[at]!) && first !== undefined && question.input.test(first.text)) return false;
    return joinWrapped(inside, question).some((row) => isPart(row, question, false));
  }
  if (grokInputAtBottom(rows, end, question)) return false;
  const block: DrawnRow[] = [];
  for (let at = end; at >= 0 && rows[at] !== "" && block.length <= maxWrapRows; at -= 1) block.unshift({ text: rows[at]!, full: false });
  const joined = joinWrapped(block, question);
  return isPart(joined[joined.length - 1]!, question, false) || isPart(rows[end]!, question, true);
}

/**
 * Whether the rows up to `end` end with Grok's own input: its `❯` row with the rows under it, either with no blank row
 * between, or across empty paragraphs when no row between the `❯` row and the last paragraph is a part of the question
 * and the last paragraph does not hold all of its choices.
 */
function grokInputAtBottom(rows: readonly string[], end: number, question: StartQuestion): boolean {
  let top = end;
  while (top > 0 && rows[top - 1] !== "") top -= 1;
  let crossed = false;
  for (let at = end; at >= 0; at -= 1) {
    const row = rows[at]!;
    if (row === "") {
      crossed = true;
      continue;
    }
    if (question.input.test(row)) {
      if (!crossed) return true;
      const last = joinWrapped(
        rows.slice(top, end + 1).map((text) => ({ text, full: false })),
        question,
      ).map((joined) => unmarked(joined, question).row);
      return !question.choices.every((choice) => last.some((joined) => choice.test(joined)));
    }
    if (crossed && isPart(row, question, false)) return false;
  }
  return false;
}

/** Grok Build's folder trust question as its screen shows it now. */
export function showsGrokTrust(text: string): boolean {
  return showsQuestion(text, startQuestions.grokTrust);
}

/** Cursor Agent's workspace trust question as its screen shows it now. */
export function showsCursorTrust(text: string): boolean {
  return showsQuestion(text, startQuestions.cursorTrust);
}

/** Gemini CLI's folder trust question as its screen shows it now. */
export function showsGeminiTrust(text: string): boolean {
  return showsQuestion(text, startQuestions.geminiTrust);
}

/** Gemini CLI's sign-in picker as its screen shows it now. */
export function showsGeminiSignIn(text: string): boolean {
  return showsQuestion(text, startQuestions.geminiSignIn);
}

/** The start screen a pane running `kind` shows now (`text`: its last lines), or null. Only its own screens are read. */
export function readStartScreen(text: string, kind: string | null | undefined): StartScreenKind | null {
  if (kind === null || kind === undefined || !startScreenKinds.has(kind.toLowerCase())) return null;
  switch (kind.toLowerCase()) {
    case "codex":
      return showsCodexHookReview(text) ? "codexHookReview" : null;
    case "grok":
      return showsGrokTrust(text) ? "grokTrust" : null;
    case "cursor":
      return showsCursorTrust(text) ? "cursorTrust" : null;
    case "gemini":
      return showsGeminiTrust(text) ? "geminiTrust" : showsGeminiSignIn(text) ? "geminiSignIn" : null;
    default:
      return null;
  }
}

/**
 * What one read of a pane running `kind` says, asked for `lines` lines: the start screen it shows, "unverified" when
 * the read may be one of the kind's questions but does not prove it (a Send must not go, the watch keeps its last
 * mark), or null. Codex's is read by readStartScreen alone.
 *
 * One rule for Grok Build, Cursor Agent and Gemini CLI: a read whose bottom is any part of one
 * of the kind's questions with no ordinary prompt of the agent under it is unverified when the whole question is not
 * proven (a choice that will not join, a box of the question with a row not known, a read starting inside the question,
 * one choice and the footer), whether or not the read came back full; and a full Grok read of only blank rows and its
 * version line is unverified too.
 */
export function readStartScreenState(text: string, kind: string | null | undefined, lines: number): StartScreenKind | "unverified" | null {
  const read = readStartScreen(text, kind);
  if (read !== null || kind === null || kind === undefined) return read;
  const agent = kind.toLowerCase();
  if (agent === "codex" || !startScreenKinds.has(agent)) return null;
  const rows = text.split(/\r\n|\r|\n/);
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  const full = rows.length >= lines - 1;
  // Grok Build's centred question on a screen far taller than the read: only blank rows and its version line came back
  // (its ordinary screen always has its input row there), so the question may be above.
  if (agent === "grok" && full) {
    const filled = rows.map(plain).filter((row) => row !== "");
    if (filled.every((row) => startQuestions.grokTrust.footer!.test(row))) return "unverified";
  }
  const kinds: readonly Exclude<StartScreenKind, "codexHookReview">[] = agent === "grok" ? ["grokTrust"] : agent === "cursor" ? ["cursorTrust"] : ["geminiTrust", "geminiSignIn"];
  return kinds.some((screen) => partAtBottom(text, startQuestions[screen])) ? "unverified" : null;
}

/** What Chat and the needs-you card say for a start screen, and the note a send to the pane gets. */
export const startScreenTexts = {
  codexHookReview: "Codex is asking whether to trust Herdr's hook. Choose Trust all and continue in its terminal.",
  /** A send to a pane showing it: nothing went (a Return there would pick a choice). */
  notSent: "Not sent: Codex is asking whether to trust Herdr's hook in its terminal. The text is kept.",
  // One plain line per screen; Adari never answers one.
  grokTrust: "Grok Build is asking whether to trust this folder. Answer it in its terminal.",
  cursorTrust: "Cursor Agent is asking whether to trust this workspace. Answer it in its terminal.",
  geminiTrust: "Gemini CLI is asking whether to trust this folder. Answer it in its terminal.",
  geminiSignIn: "Gemini CLI is asking you to sign in. Answer it in its terminal.",
} as const;

/** The agent's name in the notes below (agent-names.ts's display name). */
const screenAgentName = (kind: string): string => knownAgentName(kind.toLowerCase()) ?? "the agent";

/**
 * The note a send to a pane of agent `kind` gets when its start-screen check refused it: Codex's own note (whatever
 * the read said); for the others, the screen's own line when a read showed it (`shown`), and
 * otherwise that the screen could not be checked (a read failed, crossed a reconnect or is still out).
 */
export function startScreenNotSent(kind: string, shown: StartScreenKind | null): string {
  const agent = kind.toLowerCase();
  if (agent === "codex") return startScreenTexts.notSent;
  if (shown !== null && shown !== "codexHookReview") return `Not sent: ${startScreenTexts[shown]} The text is kept.`;
  return `Not sent: the app could not check whether ${screenAgentName(agent)} is asking a question in its terminal. The text is kept.`;
}

/** What each question asks, as the reason in "Typed into ..., but <why>, so no Return was pressed." */
const startScreenAsks: Readonly<Record<Exclude<StartScreenKind, "codexHookReview">, string>> = {
  grokTrust: "Grok Build is asking whether to trust this folder in its terminal",
  cursorTrust: "Cursor Agent is asking whether to trust this workspace in its terminal",
  geminiTrust: "Gemini CLI is asking whether to trust this folder in its terminal",
  geminiSignIn: "Gemini CLI is asking you to sign in in its terminal",
};

/**
 * Why no Return went after a Send's text to a pane of agent `kind` (not Codex: send.ts keeps its
 * hookReviewWhy): the question the newest read showed, or that it could not be checked.
 */
export function startScreenWhy(kind: string, shown: StartScreenKind | null): string {
  if (shown !== null && shown !== "codexHookReview") return startScreenAsks[shown];
  return `the app could not check whether ${screenAgentName(kind)} is asking a question in its terminal`;
}

/** The note at main's door for a pane whose screen the watch read (for Codex, its own note). */
export function startScreenRefusal(shown: StartScreenKind): string {
  return startScreenNotSent(startScreenAgent[shown], shown);
}

/** The pane's start screen on `host` as shown now (null: none). */
export function startScreenOf(host: { readonly startScreens?: HostStartScreens }, paneId: string): PaneStartScreen | null {
  return host.startScreens?.panes.find((pane) => pane.paneId === paneId) ?? null;
}

/**
 * The note Chat's box gives a Send to a pane showing Grok Build's, Cursor Agent's or Gemini CLI's
 * start question (the screen's own words; nothing goes to main). Null: none of these (Codex's hook review keeps the
 * box's "waiting on the question above").
 */
export function boxStartScreenNote(host: { readonly startScreens?: HostStartScreens }, paneId: string): string | null {
  const screen = startScreenOf(host, paneId);
  return screen === null || screen.kind === "codexHookReview" ? null : startScreenRefusal(screen.kind);
}

/**
 * The machines as the page shows them: a pane main read showing a start screen (on the machine's entry, connection
 * and command connection now, in the same terminal, still the same kind with no session, not working) shows as
 * needing you, as a pane Herdr reports blocked does: the sidebar, the header and the Needs you list follow from it.
 * Every other pane is as Herdr sent it.
 */
export function applyStartScreens<H extends Pick<HostView, "id" | "topology" | "incarnation" | "connection" | "epoch" | "startScreens">>(hosts: readonly H[]): H[] {
  return hosts.map((host) => {
    const screens = host.startScreens;
    const topology = host.topology;
    if (screens === undefined || topology === null) return host;
    if (screens.incarnation !== (host.incarnation ?? 0) || screens.connection !== (host.connection ?? 0) || screens.epoch !== (host.epoch ?? null)) return host;
    const still = new Set(
      screens.panes
        .filter((screen) => {
          const pane = topology.panes.find((candidate) => candidate.paneID === screen.paneId);
          if (pane === undefined || pane.terminalID !== screen.terminalID) return false;
          const agent = topology.agents.find((candidate) => candidate.paneID === pane.paneID) ?? null;
          const kind = agentKind(agent, pane);
          const status = agent?.agentStatus ?? pane.agentStatus;
          // And the screen is one of the pane's own agent's.
          return kind !== null && startScreenKinds.has(kind) && startScreenAgent[screen.kind] === kind && agentSession(agent) === null && status !== "working";
        })
        .map((screen) => screen.paneId),
    );
    if (still.size === 0) return host;
    return {
      ...host,
      topology: {
        ...topology,
        panes: topology.panes.map((pane) => (still.has(pane.paneID) ? { ...pane, agentStatus: "blocked" } : pane)),
        agents: topology.agents.map((agent) => (still.has(agent.paneID) ? { ...agent, agentStatus: "blocked" } : agent)),
      },
    };
  });
}
