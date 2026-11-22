// The fixtures both apps
// read, built here from redraw.ts and committed (test/prompt-card-words.test.ts
// fails when a committed copy drifts; HERDR_UPDATE_FIXTURES=1 rewrites them):
//
// - Tests/Fixtures/prompt-card-redraws.json: each agent's question drawn at
//   30 to 200 columns, with the Mac's reading of each (its kind and
//   fingerprint, the texts it stands for included), which readings cannot be
//   told whole, and each change that must stay another question, drawn at
//   another width than the question it changes, with the part it changes.
// - Tests/Fixtures/prompt-same-question-pairs.json: pairs of fingerprints and
//   whether they are one question (and if not, the first part that differs),
//   each pair's answer given by how it was made, never by the rule under test.
// - Tests/Fixtures/prompt-card-review-screens.json (the review's screens,
//   copied once, not built here) is read into the pair table.
//
// Neutral paths and harmless commands only.

import { readFileSync } from "node:fs";
import path from "node:path";

import { fingerprintDifference, matchPrompt, readingMatch, type PromptFingerprint, type PromptKind } from "../../src/shared/prompt/matcher";
import {
  agyCommand,
  agyCreate,
  agyEdit,
  agyFolder,
  claudeAskWords,
  claudeBash,
  claudeEdit,
  codexCommand,
  codexForm,
  drawAgyCommand,
  drawAgyCreate,
  drawAgyEdit,
  drawAgyTrust,
  drawClaudeAsk,
  drawClaudeBash,
  drawClaudeEdit,
  drawCodexCommand,
  drawCodexForm,
  drawGrok,
  grok,
  effectiveColumns,
  questions,
  widths,
} from "./redraw";
import { repoRoot } from "./swift-fixtures";

export type Part = "pane" | "kind" | "question" | "body" | "options" | "none";

export const paneID = "w1:p1";

/** The Mac's reading of a drawn screen on a pane of `agent`: its kind and fingerprint (null: no card). */
export function readingOf(text: string, agent: string, columns: number | null = null): { kind: PromptKind; fingerprint: PromptFingerprint } | null {
  const match = readingMatch(matchPrompt(text, paneID, agent, columns));
  return match === null ? null : { kind: match.kind, fingerprint: match.fingerprint };
}

/**
 * The readings with a row's end their reader cannot tell (that part has no text), with the pane's width
 * or without it: the redraw table's same question at another width is refused where one of its two readings is here
 * and their rows differ, never anywhere else. Each entry says why, in the reader's terms (the report's per-reader list).
 * Codex's command paragraph is told at every width (it wraps at blanks only, narrow51); its second
 * option's row end after `/` or `-` is not settled by the command.
 */
export const undecided: Readonly<Record<string, { readonly widths: readonly number[] | "all"; readonly why: string }>> = {
  grok: {
    widths: "all",
    why: "Grok's frame shows no width, and its rows wrap at words or at the edge (grok-1.0.70-approval-wrapped-plain): no row's end can be told; the pane's width does not say which wrapper drew a row, so Grok's reader takes none",
  },
  "codex-command": {
    widths: [30, 40, 50, 60, 80],
    why: "the second option's quoted prefix wraps after `/` (`/tmp/demo/` over `sample-folder/logs`), as textwrap breaks with no blank or at one: a cut or a blank; the command shows the one without a blank, but Codex builds the prefix from its own token list, so the command's characters do not prove it",
  },
  "agy-command": {
    widths: [80],
    why: "the edge cut falls on the blank after `|`, one cell short of the rule, and agy's own padding (not seen live) may put its edge there: a cut or a blank; the pane's width is the rule's, so it does not tell the padding either",
  },
};

/**
 * The widths where a question's reader gives no card at all (its matcher's own rules, unchanged by this round): the
 * person answers in the Terminal there. The redraw table has no reading at these widths and pairs none with them.
 */
export const noCard: Readonly<Record<string, { readonly widths: readonly number[]; readonly why: string }>> = {
  "agy-create": { widths: [30], why: "the file's row (its path and `+1`, 40 cells) wraps, and agy's reader takes a file row only whole" },
  "agy-edit": { widths: [30, 40], why: "the file's row (its path and `+1 -1`, 45 cells) wraps, and agy's reader takes a file row only whole" },
};

/** Whether `question`'s reader gives a card at `width`. */
export function hasCard(question: string, width: number): boolean {
  return !(noCard[question]?.widths.includes(width) ?? false);
}

/** Whether the reading of `question` at `width` is one `undecided` names. */
export function isUndecided(question: string, width: number): boolean {
  const entry = undecided[question];
  return entry !== undefined && (entry.widths === "all" || entry.widths.includes(width));
}

/** A fingerprint's rows as drawn, each row's end blanks off, rows of nothing but blanks left out (the redraw table's own check, not the rule's). */
function plainRows(fingerprint: PromptFingerprint): string[] {
  return [fingerprint.question, ...fingerprint.body, ...fingerprint.options].map((row) => row.replace(/ +$/u, "")).filter((row) => row.trim() !== "");
}

/** Whether `question` read at `a` and at `b` is the same question by the redraw table: unless a reading is undecided and their rows differ. */
export function redrawSends(question: string, a: number, b: number): boolean {
  if (!isUndecided(question, a) && !isUndecided(question, b)) return true;
  const draw = questions.find((candidate) => candidate.name === question)!;
  const left = plainRows(read(draw.draw(a), draw.agent));
  const right = plainRows(read(draw.draw(b), draw.agent));
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

/** A change to a question that must stay another question: the question read at `card`, the change drawn at `width`, the part it changes first. */
export interface Change {
  readonly question: string;
  readonly name: string;
  readonly part: Part;
  readonly draw: (width: number) => string;
  /** The widths the card and the change are read at (Grok's: two where its rows are the same rows, as it cannot tell a rewrap). */
  readonly card: number;
  readonly width: number;
}

const swap = <T>(list: readonly T[], a: number, b: number): T[] => list.map((item, index) => (index === a ? list[b]! : index === b ? list[a]! : item));

type ChangeWords = Omit<Change, "card" | "width"> & Partial<Pick<Change, "card" | "width">>;
const at = (change: ChangeWords): Change => ({ card: 80, width: 140, ...change });
const grokAt = (change: ChangeWords): Change => ({ card: 140, width: 200, ...change });

/** Point 3's changes, for each agent's question. */
export const changes: readonly Change[] = [
  // Claude Code's Bash question.
  at({ question: "claude-bash", name: "another command word", part: "body", draw: (w) => drawClaudeBash(w, { ...claudeBash, command: claudeBash.command.replace("ls -la", "ls -lt") }) }),
  at({
    question: "claude-bash",
    name: "another path",
    part: "body",
    draw: (w) => drawClaudeBash(w, { ...claudeBash, command: claudeBash.command.replace("sample-folder/notes", "sample-folder/notez") }),
  }),
  at({ question: "claude-bash", name: "one character more", part: "body", draw: (w) => drawClaudeBash(w, { ...claudeBash, command: `${claudeBash.command}s` }) }),
  at({ question: "claude-bash", name: "one character fewer", part: "body", draw: (w) => drawClaudeBash(w, { ...claudeBash, command: claudeBash.command.slice(0, -1) }) }),
  at({ question: "claude-bash", name: "a blank added inside a row", part: "body", draw: (w) => drawClaudeBash(w, { ...claudeBash, command: claudeBash.command.replace("ls -la", "ls  -la") }) }),
  at({ question: "claude-bash", name: "a blank removed inside a row", part: "body", draw: (w) => drawClaudeBash(w, { ...claudeBash, command: claudeBash.command.replace("-la /tmp", "-la/tmp") }) }),
  at({ question: "claude-bash", name: "the question's words", part: "question", draw: (w) => drawClaudeBash(w, { ...claudeBash, question: "Do you want to continue?" }) }),
  at({
    question: "claude-bash",
    name: "another option word",
    part: "options",
    draw: (w) => drawClaudeBash(w, { ...claudeBash, options: claudeBash.options.map((label) => label.replace("always allow access", "always allow reads")) }),
  }),
  at({ question: "claude-bash", name: "the options in another order", part: "options", draw: (w) => drawClaudeBash(w, { ...claudeBash, options: swap(claudeBash.options, 1, 2) }) }),
  at({ question: "claude-bash", name: "one option fewer", part: "options", draw: (w) => drawClaudeBash(w, { ...claudeBash, options: claudeBash.options.filter((_, index) => index !== 2) }) }),
  // Claude Code's Edit question.
  at({
    question: "claude-edit",
    name: "another diff line",
    part: "body",
    draw: (w) => drawClaudeEdit(w, { ...claudeEdit, diff: [claudeEdit.diff[0]!, [3, "+", claudeEdit.diff[1]![2].replace("two weeks", "three weeks")]] }),
  }),
  at({
    question: "claude-edit",
    name: "another line number",
    part: "body",
    draw: (w) => drawClaudeEdit(w, { ...claudeEdit, diff: claudeEdit.diff.map(([, mark, text]) => [4, mark, text] as const) }),
  }),
  at({
    question: "claude-edit",
    name: "another file (its name in the question too)",
    part: "question",
    draw: (w) => drawClaudeEdit(w, { ...claudeEdit, file: "notes.md", question: "Do you want to make this edit to notes.md?" }),
  }),
  at({
    question: "claude-edit",
    name: "a blank added inside a diff row",
    part: "body",
    draw: (w) => drawClaudeEdit(w, { ...claudeEdit, diff: [claudeEdit.diff[0]!, [3, "+", claudeEdit.diff[1]![2].replace("echo the", "echo  the")]] }),
  }),
  // Codex's command question (its card at 60: at 80 its command row is exactly full and its end not decided).
  at({
    question: "codex-command",
    card: 60,
    name: "another command word",
    part: "body",
    draw: (w) => drawCodexCommand(w, { ...codexCommand, command: codexCommand.command.replace("head -n 40", "head -n 41") }),
  }),
  at({
    question: "codex-command",
    card: 60,
    name: "another path in the command and its option",
    part: "body",
    draw: (w) => drawCodexCommand(w, { ...codexCommand, command: codexCommand.command.replace("/logs", "/logz"), options: codexCommand.options.map((label) => label.replace("/logs", "/logz")) }),
  }),
  at({
    question: "codex-command",
    card: 60,
    name: "another option word",
    part: "options",
    draw: (w) => drawCodexCommand(w, { ...codexCommand, options: codexCommand.options.map((label) => label.replace("Yes, proceed", "Yes, go on")) }),
  }),
  // Codex's tool-call form.
  at({ question: "codex-form", name: "another tool's header", part: "question", draw: (w) => drawCodexForm(w, { ...codexForm, header: "Allow Calendar to delete an event" }) }),
  at({ question: "codex-form", name: "another parameter", part: "body", draw: (w) => drawCodexForm(w, { ...codexForm, parameters: ["Calendar: primary", "Title: Roadmap reviews"] }) }),
  at({
    question: "codex-form",
    name: "another description word",
    part: "options",
    draw: (w) => drawCodexForm(w, { ...codexForm, options: [codexForm.options[0]!, ["Cancel", codexForm.options[1]![1].replace("was not made", "was not created")]] }),
  }),
  // Grok's frame.
  grokAt({ question: "grok", name: "another title", part: "question", draw: (w) => drawGrok(w, { ...grok, title: "List the sample folders" }) }),
  grokAt({ question: "grok", name: "another command word", part: "body", draw: (w) => drawGrok(w, { ...grok, command: grok.command.replace("cat -n", "cat -b") }) }),
  grokAt({ question: "grok", name: "a blank added inside a row", part: "body", draw: (w) => drawGrok(w, { ...grok, command: grok.command.replace("ls -la", "ls  -la") }) }),
  grokAt({ question: "grok", name: "another option word", part: "options", draw: (w) => drawGrok(w, { ...grok, options: grok.options.map((label) => label.replace("Yes, proceed", "Yes, go on")) }) }),
  // Antigravity's questions.
  at({ question: "agy-command", name: "another command word", part: "body", draw: (w) => drawAgyCommand(w, { ...agyCommand, command: agyCommand.command.replace("head -n 40", "head -n 4") }) }),
  at({ question: "agy-command", name: "a blank added inside a row", part: "body", draw: (w) => drawAgyCommand(w, { ...agyCommand, command: agyCommand.command.replace("ls -la", "ls  -la") }) }),
  at({
    question: "agy-command",
    name: "another first word (in the options too)",
    part: "body",
    draw: (w) => drawAgyCommand(w, { command: agyCommand.command.replace(/^ls/u, "echo"), first: "echo" }),
  }),
  at({ question: "agy-create", name: "another path", part: "body", draw: (w) => drawAgyCreate(w, { ...agyCreate, path: agyCreate.path.replace("ask.txt", "ask.md") }) }),
  at({ question: "agy-create", name: "another line", part: "body", draw: (w) => drawAgyCreate(w, { ...agyCreate, diff: ["  1  +  hello from the sample folders"] }) }),
  at({ question: "agy-edit", name: "another diff line", part: "body", draw: (w) => drawAgyEdit(w, { ...agyEdit, diff: ["  1  -  alpha", "  1  +  ALPHA!"] }) }),
  at({ question: "agy-edit", name: "a blank added inside a diff row", part: "body", draw: (w) => drawAgyEdit(w, { ...agyEdit, diff: ["  1  -  alpha", "  1  +   ALPHA"] }) }),
  at({ question: "agy-trust", name: "another folder", part: "body", draw: (w) => drawAgyTrust(w, agyFolder.replace("work2", "work3")) }),
  at({ question: "agy-trust", name: "a folder one character longer", part: "body", draw: (w) => drawAgyTrust(w, `${agyFolder}x`) }),
];

/** The width the answer reads at, against a card read at `width`: two widths along the table. */
export const otherWidth = (width: number): number => widths[(widths.indexOf(width as (typeof widths)[number]) + 2) % widths.length]!;

/**
 * Codex's command question at 140 columns whose widest row is its command's first, 108 cells, over a word
 * of 40: the frame alone cannot tell a word cut at its edge (if its edge were 108) from a blank; the pane's width can
 * (its edge is at least 138, where the row is not full). `narrower`: a width a row is wider than (never used).
 */
export const longWord = { agent: "codex", width: 140, narrower: 100 } as const;
export const longWordScreen = (width: number = longWord.width): string =>
  drawCodexCommand(width, { question: "Run this?", reason: "Reason: list it", command: `ls /${"a".repeat(100)} ${"b".repeat(40)}`, options: ["Yes, proceed (y)", "No (esc)"] });

/** The redraws fixture: every question at every width, the undecided readings, and every change at another width than its card's. */
export function redrawFixture(): unknown {
  return {
    note: "Built by desktop/test/support/card-words-fixtures.ts (HERDR_UPDATE_FIXTURES=1 rewrites it). Each agent's question at each width (the pane's) with the Mac's reading (its fingerprint's words: the texts it stands for) without the pane's width and with it (`columns`: the drawing's effective width, Codex's footer's where the pane is narrower); the readings with a row's end their reader cannot tell; the widths with no card; each change that must stay another question, the card read at cardWidth and the change at width; every pair of widths with a card, whether the key goes and the part named if not, without and with the pane's width; `widthScreen`, the screen only the pane's width decides (read without it, with it, and with a width a row is wider than).",
    widths,
    undecided,
    noCard,
    screens: questions.flatMap((question) =>
      widths.map((width) => {
        const text = question.draw(width);
        const columns = effectiveColumns(question.name, width);
        return { question: question.name, agent: question.agent, width, columns, text, reading: readingOf(text, question.agent), readingWithColumns: readingOf(text, question.agent, columns) };
      }),
    ),
    changes: changes.map((change) => {
      const agent = questions.find((question) => question.name === change.question)!.agent;
      const text = change.draw(change.width);
      const columns = effectiveColumns(change.question, change.width);
      return {
        question: change.question,
        name: change.name,
        agent,
        part: change.part,
        cardWidth: change.card,
        width: change.width,
        columns,
        text,
        reading: readingOf(text, agent),
        readingWithColumns: readingOf(text, agent, columns),
      };
    }),
    widthScreen: {
      ...longWord,
      text: longWordScreen(),
      reading: readingOf(longWordScreen(), longWord.agent),
      readingWithColumns: readingOf(longWordScreen(), longWord.agent, longWord.width),
      readingNarrower: readingOf(longWordScreen(), longWord.agent, longWord.narrower),
    },
    // Every pair of widths with a card, the card read at `card` and the answer's read at `fresh`: whether the key goes
    // (the redraw table's own answer, `redrawSends`) and, if not, the part the Mac names.
    pairs: questions.flatMap((question) =>
      widths
        .filter((card) => hasCard(question.name, card))
        .flatMap((card) =>
          widths
            .filter((fresh) => hasCard(question.name, fresh))
            .map((fresh) => {
              const sends = redrawSends(question.name, card, fresh);
              const part = sends ? null : fingerprintDifference(read(question.draw(card), question.agent), read(question.draw(fresh), question.agent));
              const withColumns = (width: number): PromptFingerprint => read(question.draw(width), question.agent, effectiveColumns(question.name, width));
              const partWithColumns = sends ? null : fingerprintDifference(withColumns(card), withColumns(fresh));
              return { question: question.name, card, fresh, sends, part, sendsWithColumns: sends, partWithColumns };
            }),
        ),
    ),
  };
}

interface Pair {
  readonly name: string;
  readonly a: PromptFingerprint;
  readonly b: PromptFingerprint;
  readonly same: boolean;
  readonly part: Part | null;
}

const fp = (question: string, body: readonly string[], options: readonly string[], pane = paneID): PromptFingerprint => ({ rules: 2, paneID: pane, question, body, options });

export function read(text: string, agent: string, columns: number | null = null): PromptFingerprint {
  const reading = readingOf(text, agent, columns);
  if (reading === null) throw new Error(`no reading: ${text.slice(-200)}`);
  return reading.fingerprint;
}

/** The review's screens (its review-screens.json, copied verbatim). */
export interface ReviewScreen {
  readonly name: string;
  readonly agent: string;
  readonly a: string;
  readonly b: string;
}

export const reviewScreens = JSON.parse(readFileSync(path.join(repoRoot, "Tests/Fixtures/prompt-card-review-screens.json"), "utf8")) as {
  readonly observations: readonly ReviewScreen[];
  readonly strict: readonly ReviewScreen[];
};

/** The second review's named screens (its r2-boundary-screens.json, copied verbatim), with what the rule answers and why. */
export interface Review2Screen extends ReviewScreen {
  readonly sourceA: string;
  readonly sourceB: string;
  readonly same: boolean;
  readonly why: string;
}

export const review2Screens = (
  JSON.parse(readFileSync(path.join(repoRoot, "Tests/Fixtures/prompt-card-review2-screens.json"), "utf8")) as { readonly cases: readonly Review2Screen[] }
).cases;

/** The third review's screens (its policy-prefix, quoted-prefix and quote-read-cost screens, copied verbatim), with what the rule answers and why. */
export interface Review3Screen extends Review2Screen {
  readonly wa: number | null;
  readonly wb: number | null;
  /** The part the rule names (the options; the body where the command wraps otherwise too). */
  readonly part: Part;
  /** Called one question on 347f98bb (the third review's 20 policy-prefix and 40 quoted-prefix pairs). */
  readonly acceptedBefore: boolean;
}

/** The third review's Codex screens whose quote search was timed: the screen and the width it was drawn at. */
export interface Review3Cost {
  readonly name: string;
  readonly agent: string;
  readonly a: string;
  readonly columns: number;
  readonly rows: number;
  readonly commandLength: number;
}

export const review3 = JSON.parse(readFileSync(path.join(repoRoot, "Tests/Fixtures/prompt-card-review3-screens.json"), "utf8")) as {
  readonly cases: readonly Review3Screen[];
  readonly cost: readonly Review3Cost[];
};

/** Two sources that differ only in the whitespace at one place: one blank, two blanks, a line break. */
const whitespace = (between: string): string => `echo ${"a".repeat(70)}${between}echo done`;

/** A long word (65 cells, no blank) that every reader's frame cuts at 30 and 40 columns. */
const long = "a".repeat(65);

/** For each reader, a question holding `long` (`text`: the question with `long` written as given), drawn at a width. */
interface CutReader {
  readonly reader: string;
  readonly agent: string;
  readonly text: string;
  readonly draw: (width: number, text: string) => string;
  /** The two narrow widths it is drawn at (30 and 40, or the narrowest its frame is read at). */
  readonly narrow?: readonly [number, number];
}

export const cutReaders: readonly CutReader[] = [
  { reader: "claude-bash", agent: "claude", text: `ls /${long}/tmp/x`, draw: (w, t) => drawClaudeBash(w, { ...claudeBash, description: "List a folder", command: t, options: ["Yes", "No"] }) },
  { reader: "claude-edit", agent: "claude", text: `echo ${long}`, draw: (w, t) => drawClaudeEdit(w, { ...claudeEdit, diff: [[1, "+", t]] }) },
  // The dialog is read only where its footer (51 cells) fits under its rule.
  { reader: "claude-ask", agent: "claude", text: `Q95: list /tmp/${long} first?`, draw: (w, t) => drawClaudeAsk(w, { ...claudeAskWords, question: t }), narrow: [51, 53] },
  {
    reader: "codex-command",
    agent: "codex",
    text: `ls /${long}/tmp/x`,
    draw: (w, t) => drawCodexCommand(w, { ...codexCommand, reason: "Reason: List a folder", command: t, options: ["Yes, proceed (y)", "No (esc)"] }),
  },
  { reader: "codex-form", agent: "codex", text: `Title: ${long}`, draw: (w, t) => drawCodexForm(w, { ...codexForm, parameters: [t] }) },
  { reader: "grok", agent: "grok", text: `ls /${long}/tmp/x`, draw: (w, t) => drawGrok(w, { ...grok, command: t }) },
  { reader: "agy-command", agent: "agy", text: `ls /${long}/tmp/x`, draw: (w, t) => drawAgyCommand(w, { command: t, first: "ls" }) },
  { reader: "agy-create", agent: "agy", text: `  1  +  echo ${long}`, draw: (w, t) => drawAgyCreate(w, { path: "/tmp/demo/x.txt", diff: [t] }) },
  { reader: "agy-edit", agent: "agy", text: `  1  +  echo ${long}`, draw: (w, t) => drawAgyEdit(w, { path: "/tmp/demo/x.txt", diff: ["  1  -  echo", t] }) },
  { reader: "agy-trust", agent: "agy", text: `/tmp/demo/${long}/work2`, draw: (w, t) => drawAgyTrust(w, t) },
];

/** The readers whose cut long word is told at 30 and 40 columns (their frame's edge known there); the others refuse a rewrap of it. */
export const cutTold: ReadonlySet<string> = new Set(["claude-bash", "claude-edit", "agy-command", "agy-create", "agy-edit", "agy-trust"]);

/** The narrow widths a reader's long word is drawn at. */
export const narrowWidths = (reader: CutReader): readonly [number, number] => reader.narrow ?? [30, 40];

/** A drawn screen's rows, each without the blanks at its edges (where the drawing put each character, not what a row's end stands for). */
const lettersByRow = (text: string): string[] => text.split("\n").map((row) => row.trim());

/**
 * Where a blank written into `long` lands at a row's end at `width`: the text with the blank draws the same rows as the
 * text without it but for blanks at a row's edges (the case a row's end must decide). The positions in `text`.
 */
export function blankAtRowEnd(reader: CutReader, width: number): number[] {
  const start = reader.text.indexOf(long);
  const plain = lettersByRow(reader.draw(width, reader.text));
  const found: number[] = [];
  for (let index = start + 1; index < start + long.length; index += 1) {
    const withBlank = `${reader.text.slice(0, index)} ${reader.text.slice(index)}`;
    const rows = lettersByRow(reader.draw(width, withBlank));
    if (rows.length === plain.length && rows.every((row, at) => row === plain[at])) found.push(index);
  }
  if (found.length > 0) return found;
  // A drawing that moves its rows when a blank is written in (Grok's continuation indent, agy's padding): the place
  // where the narrow drawing cut the long word, counted from the first row the word reaches the end of.
  for (const row of plain) {
    const run = /a{5,}$/.exec(row);
    if (run !== null && run[0].length < long.length) return [start + run[0].length];
  }
  return found;
}

/** The review's 30 pairs (its cw-review.test.ts), as fingerprints with no texts: each compared by its rows. */
function reviewPairs(): Pair[] {
  const q = "Do you want to proceed?";
  const f = (body: string[], options = ["1. Yes", "2. No"], question = q): PromptFingerprint => fp(question, body, options);
  const trust = (folder: string): PromptFingerprint =>
    f(
      ["Accessing workspace:", folder, "Antigravity CLI requires permission to read, edit, and execute files here."],
      ["Yes, I trust this folder", "No, exit"],
      "Do you trust the contents of this project?",
    );
  const ga = f(["› Run", "│ echo a", "   b"], ["1 ( ) Yes", "2 ( ) No"], "Run");
  const gb = f(["› Run", "│ echo a", "    b"], ["1 ( ) Yes", "2 ( ) No"], "Run");
  // [name, a, b, same, part]: the rule reads a fingerprint with no texts by its rows, so a row's end is never a blank
  // or nothing for it (the review's "same" for word wrap, edge break, moved across break, all edges, long equal, astral,
  // combining split and option continuation are now another question).
  const list: [string, PromptFingerprint, PromptFingerprint, boolean, Part | null][] = [
    ["empty", f([]), f([]), true, null],
    ["blank only", f([" ", ""]), f([]), true, null],
    ["empty nonempty", f([]), f(["ls"]), false, "body"],
    ["word wrap", f(["echo a", "b"]), f(["echo a b"]), false, "body"],
    ["edge break", f(["echo a", "b"]), f(["echo ab"]), false, "body"],
    ["two blanks", f(["echo a", "b"]), f(["echo a  b"]), false, "body"],
    ["tab", f(["echo\ta"]), f(["echo a"]), false, "body"],
    ["nbsp", f(["echo a"]), f(["echo a"]), false, "body"],
    ["double", f(["echo  a"]), f(["echo a"]), false, "body"],
    ["case", f(["echo A"]), f(["echo a"]), false, "body"],
    ["leading added", f(["echo", "xabc"]), f(["echo", "abc"]), false, "body"],
    ["trailing added", f(["echoa", "bc"]), f(["echo", "bc"]), false, "body"],
    ["moved across break", f(["echo a", "bc"]), f(["echo ab", "c"]), false, "body"],
    ["moved with character changed", f(["echo a", "bc"]), f(["echo ax", "c"]), false, "body"],
    ["all edges", f(["  echo a  ", "", "  b  "]), f(["echo a b"]), false, "body"],
    ["long equal", f(["x".repeat(10000)]), f(["x".repeat(5000), "x".repeat(5000)]), false, "body"],
    ["long last differs", f(["x".repeat(10000)]), f([`${"x".repeat(9999)}y`]), false, "body"],
    ["astral", f(["echo 😀a"]), f(["echo 😀", "a"]), false, "body"],
    ["astral differs", f(["echo 😀"]), f(["echo 😁"]), false, "body"],
    ["canonical body distinct", f(["cat café"]), f(["cat café"]), false, "body"],
    ["combining split", f(["echo é"]), f(["echo e", "́"]), false, "body"],
    ["variation selector", f(["echo ☺"]), f(["echo ☺️"]), false, "body"],
    ["zwj", f(["echo 👩‍💻"]), f(["echo 👩💻"]), false, "body"],
    ["option continuation", f(["ls"], ["1. Yes allow", " this", "2. No"]), f(["ls"], ["1. Yes allow this", "2. No"]), false, "options"],
    ["option lookalike continuation", f(["ls"], ["1. Yes allow", " 2. examples", "2. No"]), f(["ls"], ["1. Yes allow 2. examples", "2. No"]), false, "options"],
    ["option order", f(["ls"], ["1. No", "2. Yes"]), f(["ls"]), false, "options"],
    ["question case", f(["ls"], undefined, "Proceed?"), f(["ls"], undefined, "proceed?"), false, "question"],
    ["trust blank", trust("/tmp/demo/a b"), trust("/tmp/demo/ab"), false, "body"],
    ["trust canonical difference", trust("/tmp/demo/café"), trust("/tmp/demo/café"), false, "body"],
    ["grok counted leading blanks", ga, gb, false, "body"],
  ];
  return list.map(([name, a, b, same, part]) => ({ name: `review: ${name}`, a, b, same, part }));
}

/** The pair table: point 2 (one question), point 3 (another), the review's pairs and screens, each reader's cut word against a blank, the rule's edges. */
export function pairsFixture(): unknown {
  const pairs: Pair[] = [];
  // Point 2: each question at two widths (refused only where `undecided` says, and its rows differ).
  for (const question of questions) {
    for (const [a, b] of [
      [30, 200],
      [40, 140],
      [50, 100],
      [60, 200],
      [80, 140],
      [100, 60],
      [140, 80],
      [200, 30],
    ] as const) {
      if (!hasCard(question.name, a) || !hasCard(question.name, b)) continue;
      const same = redrawSends(question.name, a, b);
      // Codex's command question differs first in its options (the second option's row end, `undecided`); the others in their body.
      const part: Part = question.name === "codex-command" ? "options" : "body";
      pairs.push({ name: `${question.name} at ${a} and ${b} columns`, a: read(question.draw(a), question.agent), b: read(question.draw(b), question.agent), same, part: same ? null : part });
    }
  }
  // Point 3: each change, the card at its width and the change at another.
  for (const change of changes) {
    const base = questions.find((question) => question.name === change.question)!;
    pairs.push({
      name: `${change.question}: ${change.name} (${change.card} and ${change.width} columns)`,
      a: read(base.draw(change.card), base.agent),
      b: read(change.draw(change.width), base.agent),
      same: false,
      part: change.part,
    });
  }
  // Another pane: the same rows.
  const bash = read(drawClaudeBash(80), "claude");
  pairs.push({ name: "another pane, the same rows", a: bash, b: { ...bash, paneID: "w1:p2" }, same: false, part: "pane" });
  pairs.push({ name: "another reading rules number", a: bash, b: { ...bash, rules: 3 }, same: false, part: "question" });
  // A fingerprint whose texts are another reading's but whose rows are not (one main never made): another question.
  pairs.push({
    name: "the texts of one reading over the rows of another",
    a: bash,
    b: { ...read(drawClaudeBash(80, { ...claudeBash, question: "Do you want to continue?" }), "claude"), words: bash.words! },
    same: false,
    part: "question",
  });
  // The review's 30 pairs, and its screens: each accepted pair refused, each strict pair one question.
  pairs.push(...reviewPairs());
  for (const screen of reviewScreens.observations) {
    // The review drew Codex's command at 30 columns under a footer wider than that (no width draws both): the question
    // line's wrap there would have fit, so its row's end is not decided and the question part differs first.
    const part: Part = screen.name.startsWith("codex-command") ? "question" : "body";
    pairs.push({ name: `review screens: ${screen.name} (a long word cut at the edge against a blank there)`, a: read(screen.a, screen.agent), b: read(screen.b, screen.agent), same: false, part });
  }
  for (const screen of reviewScreens.strict) {
    if (readingOf(screen.a, screen.agent) === null) continue;
    pairs.push({ name: `review screens: ${screen.name} (the same question at two widths)`, a: read(screen.a, screen.agent), b: read(screen.b, screen.agent), same: true, part: null });
  }
  // The second review's screens: its different-source pairs the rule calls one question (the remainder: the narrow
  // screen draws the other whitespace at a wrap point, where its rows are one blank's), the recorded Codex question at
  // 134 and 200 columns, and the two diff lines holding a literal U+FFFF.
  for (const screen of review2Screens) {
    const recorded = screen.name === "codex-command/recorded119-to-200/options-hyphen";
    if (!screen.same && !screen.name.includes("literal-noncharacter") && !recorded) continue;
    pairs.push({ name: `review 2: ${screen.name}: ${screen.why}`, a: read(screen.a, screen.agent), b: read(screen.b, screen.agent), same: screen.same, part: screen.same ? null : recorded ? "options" : "body" });
  }
  // The third review's Codex options: a quoted prefix with no blank at the narrow width against one with a
  // blank at 500 columns, read with the widths the review gave; the option has no text, compared by its rows.
  for (const screen of review3.cases) {
    pairs.push({ name: `review 3: ${screen.name}`, a: read(screen.a, screen.agent, screen.wa), b: read(screen.b, screen.agent, screen.wb), same: screen.same, part: screen.part });
  }
  // What the remainder is not: a line break or several blanks the reading shows (a width where they are not at a wrap
  // point) is another question against the one-blank text, both for Claude Code's command and Codex's.
  for (const [reader, draw] of [
    ["claude-bash", (width: number, command: string): PromptFingerprint => read(drawClaudeBash(width, { ...claudeBash, command }), "claude")],
    ["codex-command", (width: number, command: string): PromptFingerprint => read(drawCodexCommand(width, { ...codexCommand, command, options: ["Yes, proceed (y)", "No, and tell Codex what to do differently (esc)"] }), "codex")],
  ] as const) {
    pairs.push({ name: `${reader}: a line break the screen shows (200) against one blank (80)`, a: draw(200, whitespace("\n")), b: draw(80, whitespace(" ")), same: false, part: "body" });
    pairs.push({ name: `${reader}: two blanks the screen shows (200) against one blank (80)`, a: draw(200, whitespace("  ")), b: draw(80, whitespace(" ")), same: false, part: "body" });
    // The same source both ways, read as one blank where its two fall at a wrap point: refused, the safe side.
    pairs.push({ name: `${reader}: two blanks read as one at a wrap point (80) against the two shown (200), one source: refused`, a: draw(80, whitespace("  ")), b: draw(200, whitespace("  ")), same: false, part: "body" });
    pairs.push({ name: `${reader}: one blank at 80 and at 200: one question`, a: draw(80, whitespace(" ")), b: draw(200, whitespace(" ")), same: true, part: null });
  }
  // Each reader: a long word cut at the edge against the same text with a blank where the cut falls, both ways, at 30
  // and 40 columns against 200; and the same text at both widths (one question where the reader knows its edge).
  for (const reader of cutReaders) {
    const part: Part = reader.reader === "claude-ask" ? "question" : "body";
    for (const narrow of narrowWidths(reader)) {
      const positions = blankAtRowEnd(reader, narrow);
      let made = 0;
      for (const index of positions) {
        const withBlank = `${reader.text.slice(0, index)} ${reader.text.slice(index)}`;
        // A direction whose narrow screen gives no card (agy's trust path with a blank at a row's edge) has nothing to answer.
        for (const [name, a, b] of [
          [`${reader.reader}: a cut word at ${narrow} against a blank there at 200 (at ${index})`, reader.draw(narrow, reader.text), reader.draw(200, withBlank)],
          [`${reader.reader}: a blank at the row's end at ${narrow} against the cut word at 200 (at ${index})`, reader.draw(narrow, withBlank), reader.draw(200, reader.text)],
        ] as const) {
          if (readingOf(a, reader.agent) === null) continue;
          pairs.push({
            name,
            a: read(a, reader.agent),
            b: read(b, reader.agent),
            same: false,
            part,
          });
          made += 1;
        }
      }
      if (made === 0) throw new Error(`${reader.reader}: no pair at ${narrow}`);
      const told = cutTold.has(reader.reader);
      pairs.push({
        name: `${reader.reader}: the cut word at ${narrow} and at 200 (${told ? "its edge known" : "its edge not known: refused"})`,
        a: read(reader.draw(narrow, reader.text), reader.agent),
        b: read(reader.draw(200, reader.text), reader.agent),
        same: told,
        part: told ? null : part,
      });
    }
  }
  // `ls / tmp/x` and `ls /tmp/x` written so a row ends after `/`: one text or the other, never both.
  const blankFirst = `ls / tmp/${"x".repeat(40)}`;
  const joined = `ls /tmp/${"x".repeat(40)}`;
  const listing = (width: number, command: string): PromptFingerprint => read(drawClaudeBash(width, { ...claudeBash, description: "List a folder", command, options: ["Yes", "No"] }), "claude");
  pairs.push({ name: "ls / tmp/x at 30 (a row ends after `/`) is not ls /tmp/x at 200", a: listing(30, blankFirst), b: listing(200, joined), same: false, part: "body" });
  pairs.push({ name: "ls /tmp/x at 30 is not ls / tmp/x at 200", a: listing(30, joined), b: listing(200, blankFirst), same: false, part: "body" });
  pairs.push({ name: "ls / tmp/x at 30 and at 200: one question", a: listing(30, blankFirst), b: listing(200, blankFirst), same: true, part: null });
  // The rule's edges, by hand: a fingerprint with no texts is compared by its rows.
  const q = "Do you want to proceed?";
  const opts = ["1. Yes", "2. No"];
  pairs.push({ name: "ls / tmp/x is not ls /tmp/x (the blank inside a row)", a: fp(q, ["ls / tmp/x"], opts), b: fp(q, ["ls /tmp/x"], opts), same: false, part: "body" });
  pairs.push({ name: "no texts: ls / over tmp/x is neither ls /tmp/x nor ls / tmp/x", a: fp(q, ["ls /", "tmp/x"], opts), b: fp(q, ["ls /tmp/x"], opts), same: false, part: "body" });
  pairs.push({ name: "no texts: ls / over tmp/x against ls / tmp/x", a: fp(q, ["ls /", "tmp/x"], opts), b: fp(q, ["ls / tmp/x"], opts), same: false, part: "body" });
  pairs.push({ name: "no texts: a row's end against one blank", a: fp(q, ["ls -la /tmp/demo", "/tmp/x"], opts), b: fp(q, ["ls -la /tmp/demo /tmp/x"], opts), same: false, part: "body" });
  pairs.push({ name: "no texts: a blank row more at the body's edge", a: fp(q, ["", "ls /tmp/x", ""], opts), b: fp(q, ["ls /tmp/x"], opts), same: true, part: null });
  pairs.push({ name: "no texts: a blank row more inside the body", a: fp(q, ["echo one", "   ", "echo two"], opts), b: fp(q, ["echo one", "echo two"], opts), same: true, part: null });
  pairs.push({ name: "no texts: blanks at a row's end", a: fp(q, ["ls /tmp/x   "], ["1. Yes  ", "2. No"]), b: fp(q, ["ls /tmp/x"], opts), same: true, part: null });
  pairs.push({ name: "no texts: blanks at a row's start count", a: fp(q, ["  ls /tmp/x"], opts), b: fp(q, ["ls /tmp/x"], opts), same: false, part: "body" });
  pairs.push({ name: "a blank removed inside a row", a: fp(q, ["echo one two"], opts), b: fp(q, ["echo onetwo"], opts), same: false, part: "body" });
  pairs.push({ name: "one character more at the end", a: fp(q, ["cat notes.txt"], opts), b: fp(q, ["cat notes.txtx"], opts), same: false, part: "body" });
  pairs.push({ name: "a no-break space is not a blank", a: fp(q, ["echo one"], opts), b: fp(q, ["echo one"], opts), same: false, part: "body" });
  pairs.push({ name: "the question's words", a: fp(q, ["ls"], opts), b: fp("Do you want to continue?", ["ls"], opts), same: false, part: "question" });
  pairs.push({ name: "the question's edge blanks", a: fp(` ${q} `, ["ls"], opts), b: fp(q, ["ls"], opts), same: true, part: null });
  pairs.push({ name: "options in another order", a: fp(q, ["ls"], ["1. Yes", "2. No"]), b: fp(q, ["ls"], ["1. No", "2. Yes"]), same: false, part: "options" });
  pairs.push({ name: "two options are not one (another count)", a: fp(q, ["ls"], ["1. Yes", "2. Maybe", "3. No"]), b: fp(q, ["ls"], ["1. Yes", "2. Maybe 3. No"]), same: false, part: "options" });
  // agy's trust question as its reader reads it: the same folder at two widths; two folders a blank apart.
  const trustAt = (width: number, folder: string): PromptFingerprint => read(drawAgyTrust(width, folder), "agy");
  pairs.push({ name: "agy trust: the same folder cut at 40 and whole at 200", a: trustAt(40, agyFolder), b: trustAt(200, agyFolder), same: true, part: null });
  const spaced = `/tmp/demo/sample-folder/${"deep/".repeat(3)}de ep/work2`;
  pairs.push({ name: "agy trust: two folders that differ by a blank inside the name", a: trustAt(200, spaced), b: trustAt(200, spaced.replace("de ep", "deep")), same: false, part: "body" });
  pairs.push({ name: "agy trust: another folder", a: trustAt(80, agyFolder), b: trustAt(140, agyFolder.replace("work2", "work3")), same: false, part: "body" });
  return {
    note: "Pairs of fingerprints and whether they are one question (part: where they first differ, in the order pane, question, body, options). Built by desktop/test/support/card-words-fixtures.ts; both apps run every pair both ways.",
    pairs,
  };
}
