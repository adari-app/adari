// Each agent's question as its recorded
// fixtures draw it, redrawn at any width, so a test can read the same
// question at two widths (the Terminal tab opened, a split, a window
// resized). Each agent wraps the way its own fixtures show:
//
// - Claude Code 2.1.303 (claude-2.1.303-bash-dialog, -write-dialog,
//   -narrow54-bash-dialog): rules to the width, its rows wrapped as Ink wraps
//   (`inkWrap`: the blank kept at a row's end or moved to the next row's
//   start, a word longer than a row cut), its text one cell in and a cell
//   short of the edge, an option's wrapped rows under its words to the edge;
// - Codex 0.163.0's command question (codex-0.163.0-dialog, -narrow51-dialog)
//   and 0.166.0's form (codex-0.166.0-form-narrow-params): wrapped at words,
//   never narrower than its footer's row (41 and 33 cells: a narrower pane
//   cannot hold it, and the frame read at 30 columns before this pass drew
//   its footer past the pane's edge);
// - Grok 1.0.70 (grok-1.0.70-approval-wrapped-plain): its command and options
//   broken at the edge, a command row's wrap two cells in under `│ `;
// - Antigravity CLI 1.5.13 (test/fixtures/antigravity): the rule and the last
//   row to the width, choices wrapped at words five cells in (prompt-agy's
//   askAt), the command and the trust path broken at the edge.
//
// Every row's end blanks are dropped, as Herdr's pane.read drops them. Only
// harmless commands (ls, cat, echo) and neutral paths.

/** The widths each question is drawn at: 30 to 200 columns (the review's eight). */
export const widths = [30, 40, 50, 60, 80, 100, 140, 200] as const;

/** Rows ending in blanks lose them (Herdr's pane.read). */
function trimEnd(row: string): string {
  return row.replace(/ +$/u, "");
}

/** `text` wrapped at words to `width`: the first row after `first`, the rest after `next`; a word too long is broken. */
export function wordWrap(text: string, width: number, first: string, next: string): string[] {
  const rows: string[] = [];
  let prefix = first;
  let row = "";
  const flush = (): void => {
    rows.push(trimEnd(prefix + row));
    prefix = next;
    row = "";
  };
  const tokens = text.split(" ");
  tokens.forEach((token, index) => {
    const piece = index === 0 ? token : ` ${token}`;
    if (row !== "" && prefix.length + row.length + piece.length > width) {
      flush();
      row = token;
    } else {
      row += row === "" && index > 0 ? token : piece;
    }
    while (prefix.length + row.length > width) {
      const room = width - prefix.length;
      const head = row.slice(0, room);
      row = row.slice(room);
      rows.push(trimEnd(prefix + head));
      prefix = next;
    }
  });
  if (row !== "" || rows.length === 0) flush();
  return rows;
}

/**
 * `text` wrapped as Codex's options wrap (textwrap with Unicode line breaking, first fit): at blanks (the blank
 * dropped), and after a `/` or `-` that follows a letter, with no blank (codex-0.163.0-narrow51-dialog's
 * `/private/tmp/` over `z-narrow2-out/n.txt`, codex-0.163.0-dialog's `results-` over `day-one/...`); a piece longer
 * than a row is broken. The first row after `first`, the rest after `next`.
 */
export function textWrap(text: string, width: number, first: string, next: string): string[] {
  const pieces: { readonly blank: boolean; readonly word: string }[] = [];
  text.split(" ").forEach((token, index) => {
    token.split(/(?<=[^\s/-][/-])(?=[^\s/-])/u).forEach((word, at) => pieces.push({ blank: index > 0 && at === 0, word }));
  });
  const rows: string[] = [];
  let prefix = first;
  let row = "";
  let started = false;
  for (const piece of pieces) {
    const joined = started ? `${row}${piece.blank ? " " : ""}${piece.word}` : piece.word;
    if (started && prefix.length + joined.length > width) {
      rows.push(trimEnd(prefix + row));
      prefix = next;
      row = piece.word;
    } else {
      row = joined;
    }
    started = true;
    while (prefix.length + row.length > width) {
      const room = width - prefix.length;
      rows.push(trimEnd(prefix + row.slice(0, room)));
      row = row.slice(room);
      prefix = next;
    }
  }
  rows.push(trimEnd(prefix + row));
  return rows;
}

/** `text` broken at the edge: `width - prefix` characters a row, the first after `first`, the rest after `next`. */
export function edgeBreak(text: string, width: number, first: string, next: string): string[] {
  const rows: string[] = [];
  let rest = text;
  let prefix = first;
  while (rest !== "" || rows.length === 0) {
    const room = width - prefix.length;
    rows.push(trimEnd(prefix + rest.slice(0, room)));
    rest = rest.slice(room);
    prefix = next;
  }
  return rows;
}

/**
 * `text` wrapped as Ink wraps a Text (wrap-ansi with `trim: false, hard: true`, plain text, one cell a character):
 * a line's words at blanks, the blank kept at the row's end, or at the next row's start after a word that filled its
 * row exactly; a word longer than a row cut at the edge (started on the current row when that saves a row).
 */
export function inkWrap(text: string, columns: number): string[] {
  return text.split("\n").flatMap((line) => inkLine(line, columns));
}

function inkLine(line: string, columns: number): string[] {
  const rows = [""];
  const words = line.split(" ");
  const pushWord = (word: string): void => {
    let visible = rows.at(-1)!.length;
    const characters = [...word];
    characters.forEach((character, index) => {
      if (visible + 1 <= columns) {
        rows[rows.length - 1] += character;
      } else {
        rows.push(character);
        visible = 0;
      }
      visible += 1;
      if (visible === columns && index < characters.length - 1) {
        rows.push("");
        visible = 0;
      }
    });
    if (visible === 0 && rows.at(-1)!.length > 0 && rows.length > 1) rows[rows.length - 2] += rows.pop()!;
  };
  words.forEach((word, index) => {
    let length = rows.at(-1)!.length;
    if (index !== 0) {
      if (length >= columns) {
        rows.push("");
        length = 0;
      }
      rows[rows.length - 1] += " ";
      length += 1;
    }
    if (word.length > columns) {
      const remaining = columns - length;
      const thisLine = 1 + Math.floor((word.length - remaining - 1) / columns);
      const nextLine = Math.floor((word.length - 1) / columns);
      if (nextLine < thisLine) rows.push("");
      pushWord(word);
      return;
    }
    if (length + word.length > columns && length > 0 && word.length > 0) rows.push("");
    rows[rows.length - 1] += word;
  });
  return rows;
}

/** `text` as Ink draws it in a box `columns` wide, `first` before its first row and `next` before the rest. */
function inkRows(text: string, columns: number, first: string, next: string): string[] {
  return inkWrap(text, columns).map((row, index) => trimEnd((index === 0 ? first : next) + row));
}

const history = ["Output above", "", "  ls -la /tmp/demo/sample-folder", ""];

// MARK: Claude Code 2.1.303

export interface ClaudeBashWords {
  readonly description: string;
  readonly command: string;
  readonly question: string;
  readonly options: readonly string[];
}

export const claudeBash: ClaudeBashWords = {
  description: "List the sample folder's notes and logs with line numbers, then say when the listing is done",
  command: "ls -la /tmp/demo/sample-folder/notes /tmp/demo/sample-folder/logs | cat -n | head -n 40 && echo done listing the sample folder",
  question: "Do you want to proceed?",
  options: ["Yes", "Yes, and always allow access to /tmp/demo/sample-folder from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"],
};

/**
 * Claude Code's options: the label wrapped as Ink wraps it, under its own column, to the frame's edge; a blank Ink
 * moves to the next row's start after a word that filled its row is not drawn there (claude-2.1.303-narrow54: "auto
 * mode handles" fills its row, "these prompts for you" is under the label's column, six cells in).
 */
function claudeOptions(options: readonly string[], width: number, marked = 0): string[] {
  return options.flatMap((label, index) => {
    const head = `${index === marked ? " ❯ " : "   "}${index + 1}. `;
    const indent = " ".repeat(head.length);
    return inkWrap(label, width - head.length).map((row, at) => trimEnd(at === 0 ? head + row : indent + row.replace(/^ /u, "")));
  });
}

/** Claude Code's text rows (the description, the command, the question): one cell in, a cell short of the frame's edge (narrow54's rows). */
function claudeText(text: string, width: number): string[] {
  return inkRows(text, width - 2, " ", " ");
}

/** Claude Code 2.1.303's Bash question at `width` columns (claude-2.1.303-bash-dialog's frame). */
export function drawClaudeBash(width: number, words: ClaudeBashWords = claudeBash): string {
  return [
    ...history,
    "─".repeat(width),
    " Bash command",
    ...claudeText(words.description, width),
    "╌".repeat(width),
    ...claudeText(words.command, width),
    "╌".repeat(width),
    ...claudeText(words.question, width),
    ...claudeOptions(words.options, width),
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
}

export interface ClaudeEditWords {
  readonly file: string;
  /** The diff's rows: line number, mark (`-` or `+`), the line. */
  readonly diff: readonly (readonly [number, "-" | "+", string])[];
  readonly question: string;
  readonly options: readonly string[];
}

export const claudeEdit: ClaudeEditWords = {
  file: "notes.txt",
  diff: [
    [3, "-", "echo the sample folder holds the notes and the logs of the first week of the trial"],
    [3, "+", "echo the sample folder holds the notes, the logs and the listings of the first two weeks of the trial"],
  ],
  question: "Do you want to make this edit to notes.txt?",
  options: ["Yes", "Yes, allow all edits during this session (shift+tab)", "No"],
};

/** Claude Code 2.1.303's Edit question at `width` (its Create file frame's shape: the name, the diff between dashed rules). */
export function drawClaudeEdit(width: number, words: ClaudeEditWords = claudeEdit): string {
  return [
    ...history,
    "─".repeat(width),
    " Edit file",
    ` ${words.file}`,
    "╌".repeat(width),
    ...words.diff.flatMap(([line, mark, text]) => {
      const head = `  ${line} ${mark} `;
      return inkRows(text, width - 1 - head.length, head, " ".repeat(head.length));
    }),
    "╌".repeat(width),
    ...claudeText(words.question, width),
    ...claudeOptions(words.options, width),
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
}

// MARK: Claude Code 2.1.325's question dialog

export interface ClaudeAskWords {
  readonly header: string;
  readonly question: string;
  readonly options: readonly (readonly [string, string])[];
}

export const claudeAskWords: ClaudeAskWords = {
  header: "Q95",
  question: "Q95: which folder should the listing cover first?",
  options: [
    ["The notes folder", "List the sample folder's notes with line numbers, newest first."],
    ["The logs folder", "List the sample folder's logs and say how many there are."],
  ],
};

/** Claude Code 2.1.325's question dialog at `width` (claude-2.1.325-ask-sample's frame): the question and each description wrapped as Ink wraps them. */
export function drawClaudeAsk(width: number, words: ClaudeAskWords = claudeAskWords): string {
  const count = words.options.length;
  return [
    ...history,
    "─".repeat(width),
    ` ☐ ${words.header}`,
    "",
    ...inkRows(words.question, width - 2, "", ""),
    "",
    ...words.options.flatMap(([label, detail], index) => [`${index === 0 ? "❯" : " "} ${index + 1}. ${label}`, ...inkRows(detail, width - 6, "     ", "     ")]),
    `  ${count + 1}. Type something.`,
    "─".repeat(width),
    `  ${count + 2}. Chat about this`,
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
}

// MARK: Codex

/** The cells of the footer row under Codex's command question and under its form: the narrowest each frame is drawn. */
const codexFooterCells = "  Press enter to confirm or esc to cancel".length;
const codexFormFooterCells = "  enter to submit | esc to cancel".length;

/**
 * The width a question is drawn at for a pane `columns` wide: the pane's, except where the agent never draws its frame
 * narrower than its footer (Codex's command and form: a narrower pane is drawn as the footer's width, so their 30 and
 * 40 are one drawing). The pane's width a read of that drawing gives its reader.
 */
export function effectiveColumns(question: string, columns: number): number {
  // Codex's command question ends its rows a cell short of the pane, its footer's too.
  if (question === "codex-command") return Math.max(columns, codexFooterCells + 1);
  if (question === "codex-form") return Math.max(columns, codexFormFooterCells);
  return columns;
}

export interface CodexCommandWords {
  readonly question: string;
  readonly reason: string;
  readonly command: string;
  readonly options: readonly string[];
}

export const codexCommand: CodexCommandWords = {
  question: "Would you like to run the following command?",
  reason: "Reason: Do you approve listing the sample folder's notes and logs with line numbers for the report?",
  command: "ls -la /tmp/demo/sample-folder/notes /tmp/demo/sample-folder/logs | cat -n | head -n 40",
  options: [
    "Yes, proceed (y)",
    "Yes, and don't ask again for commands that start with `ls -la /tmp/demo/sample-folder/notes /tmp/demo/sample-folder/logs` (p)",
    "No, and tell Codex what to do differently (esc)",
  ],
};

/** Codex 0.163.0's command question at `width` (codex-0.163.0-dialog, -narrow51-dialog: wrapped at words). */
export function drawCodexCommand(drawn: number, words: CodexCommandWords = codexCommand): string {
  // Codex never draws its frame narrower than its footer's row (a narrower pane cannot hold the footer whole): the
  // drawing's effective width (`effectiveColumns`). Its rows end a cell short of it (codex-0.163.0-narrow51-dialog:
  // rows of 50 at 51 columns; codex-0.163.0-dialog, read in a pane of 134 as this machine's single-pane layout
  // recording shows: `results-` ends a row of 130 where `day-` would make 134).
  const width = effectiveColumns("codex-command", drawn) - 1;
  return [
    ...history,
    "",
    ...textWrap(words.question, width, "  ", "  "),
    "",
    "  Environment: local",
    "",
    ...textWrap(words.reason, width, "  ", "  "),
    "",
    // The command at blanks only (narrow51: `$ echo narrow-codex >` over the whole path).
    ...words.command.split("\n").flatMap((line, index) => wordWrap(index === 0 ? `$ ${line}` : line, width, "  ", "  ")),
    "",
    "",
    ...words.options.flatMap((label, index) => textWrap(label, width, `${index === 0 ? "›" : " "} ${index + 1}. `, "     ")),
    "",
    "  Press enter to confirm or esc to cancel",
  ].join("\n");
}

export interface CodexFormWords {
  readonly header: string;
  readonly parameters: readonly string[];
  readonly options: readonly (readonly [string, string])[];
}

export const codexForm: CodexFormWords = {
  header: "Allow Calendar to create an event",
  parameters: ["Calendar: primary", "Title: Roadmap review"],
  options: [
    ["Allow", "Run the tool and continue with the event as the request describes it"],
    ["Cancel", "Cancel this tool call and tell the agent the event was not made"],
  ],
};

/** Codex 0.166.0's tool-call form at `width` (codex-0.166.0-form-narrow-params: the descriptions wrapped at words under their column). */
export function drawCodexForm(drawn: number, words: CodexFormWords = codexForm): string {
  const width = effectiveColumns("codex-form", drawn);
  const name = Math.max(...words.options.map(([label]) => label.length)) + 2;
  return [
    ...history,
    "",
    "  Field 1/1",
    ...wordWrap(words.header, width, "  ", "  "),
    "",
    // A parameter's value wraps at the margin (codex-0.166.0-form-narrow-params).
    ...words.parameters.flatMap((row) => wordWrap(row, width, "  ", "  ")),
    "",
    ...words.options.flatMap(([label, detail], index) => {
      const head = `  ${index === 0 ? "›" : " "} ${index + 1}. ${label.padEnd(name)}`;
      return wordWrap(detail, width, head, " ".repeat(head.length));
    }),
    "  enter to submit | esc to cancel",
  ].join("\n");
}

// MARK: Grok 1.0.70

export interface GrokWords {
  readonly title: string;
  readonly command: string;
  readonly options: readonly string[];
}

export const grok: GrokWords = {
  title: "List the sample folder",
  command: "ls -la /tmp/demo/sample-folder/notes /tmp/demo/sample-folder/logs | cat -n | head -n 40",
  options: [
    "Yes, and don't ask again for anything (always-approve mode)",
    "Always allow: ls -la /tmp/demo/sample-folder/notes /tmp/demo/sample-folder/logs",
    "Yes, proceed",
    "No, reject (type to add feedback)",
    "Never allow: ls -la",
  ],
};

/** Grok 1.0.70's approval frame at `width` (grok-1.0.70-live-approval's two cells after the bar, -approval-wrapped-plain's breaks). */
export function drawGrok(width: number, words: GrokWords = grok): string {
  const bar = "  ┃  ";
  const room = width - bar.length;
  const footer = "  1/5:select  │  Tab:next option  │  ←/→:scope  │  e:edit pattern  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc";
  const options = words.options.map((label, index) => `${index + 1} (${index === 2 ? "●" : "○"}) ${label}`);
  return [
    ...history,
    "  ┃",
    `${bar}›  ${words.title}`,
    ...edgeBreak(`│ ${words.command}`, room, "", "  ").map((row) => trimEnd(bar + row)),
    `${bar}← → narrow scope  ·  e edit pattern`,
    "  ┃",
    ...options.flatMap((option) => edgeBreak(option, room, "", "").map((row) => trimEnd(bar + row))),
    "  ┃",
    "",
    trimEnd(footer.slice(0, width)).replace(/1\/5/u, `1/${words.options.length}`),
  ].join("\n");
}

// MARK: Antigravity CLI 1.5.13

const agyModel = "Gemini 4 Hydrogen · low";

function rightAligned(left: string, right: string, width: number): string {
  return `${left}${" ".repeat(Math.max(2, width - [...left].length - [...right].length))}${right}`;
}

function agyChoices(labels: readonly string[], width: number): string[] {
  return labels.flatMap((label, index) => wordWrap(label, width, `${index === 0 ? ">" : " "} ${index + 1}. `, "     "));
}

export interface AgyCommandWords {
  readonly command: string;
  readonly first: string;
}

export const agyCommand: AgyCommandWords = {
  command: "ls -la /tmp/demo/sample-folder/notes /tmp/demo/sample-folder/logs | cat -n | head -n 40",
  first: "ls",
};

/** agy's command question at `width` (command-ask.txt's frame; the command broken at the edge, three cells in). */
export function drawAgyCommand(width: number, words: AgyCommandWords = agyCommand): string {
  return [
    "● Ran (ls) (ctrl+o to expand)",
    "",
    "Command",
    "─".repeat(width),
    "",
    "Requesting permission for:",
    ...edgeBreak(words.command, width, "   ", "   "),
    "",
    "Run this command?",
    ...agyChoices(
      [
        "Yes, run command",
        `Yes, and always allow in this conversation for commands that start with '${words.first}'`,
        `Yes, and always allow for commands that start with '${words.first}' (Persist to settings.json)`,
        "No, cancel",
      ],
      width,
    ),
    "",
    "  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command",
    rightAligned("esc to cancel", agyModel, width),
  ].join("\n");
}

export interface AgyFileWords {
  readonly path: string;
  readonly diff: readonly string[];
}

export const agyCreate: AgyFileWords = { path: "/tmp/demo/sample-folder/work/ask.txt", diff: ["  1  +  hello from the sample folder"] };
export const agyEdit: AgyFileWords = { path: "/tmp/demo/sample-folder/work/notes.txt", diff: ["  1  -  alpha", "  1  +  ALPHA"] };

/** agy's create question at `width` (create-file-ask.txt; its path, diff and hint rows broken at the edge with no indent, as the review drew a diff row). */
export function drawAgyCreate(width: number, words: AgyFileWords = agyCreate): string {
  return [
    "● Edited 1 file (ask.txt) (ctrl+o to expand)",
    "",
    "Create file",
    "─".repeat(width),
    "",
    ...edgeBreak(`${words.path}  +${words.diff.length}`, width, "", ""),
    ...words.diff.flatMap((row) => edgeBreak(row, width, "", "")),
    "",
    "Allow creation of this file?",
    ...agyChoices(["Yes, allow creation", "No, deny creation"], width),
    "",
    "  ↑/↓ Navigate · f full diff",
    rightAligned("esc to cancel", agyModel, width),
  ].join("\n");
}

/** agy's edit question at `width` (edit-file-ask.txt; its rows broken as the create question's). */
export function drawAgyEdit(width: number, words: AgyFileWords = agyEdit): string {
  const added = words.diff.filter((row) => /^ +\d+ +\+/u.test(row)).length;
  const removed = words.diff.filter((row) => /^ +\d+ +-/u.test(row)).length;
  return [
    "● Edited 1 file (notes.txt) (ctrl+o to expand)",
    "",
    "Pending edit",
    "─".repeat(width),
    "",
    ...edgeBreak(`${words.path}  +${added} -${removed}`, width, "", ""),
    ...words.diff.flatMap((row) => edgeBreak(row, width, "", "")),
    "",
    ...edgeBreak("  shift+tab to auto-approve file edits", width, "", ""),
    "Accept this file edit?",
    ...agyChoices(["Yes, accept this change", "No, reject this change"], width),
    "",
    "  ↑/↓ Navigate · f full diff",
    rightAligned("esc to cancel", agyModel, width),
  ].join("\n");
}

export const agyFolder = `/tmp/demo/sample-folder/${"deep/".repeat(16)}work2`;

/** agy's trust question at `width` (prompt-agy's trustAt: the path broken exactly at the edge, the mode line to the width). */
export function drawAgyTrust(width: number, folder: string = agyFolder): string {
  return [
    "Accessing workspace:",
    "",
    ...edgeBreak(folder, width, "", ""),
    "",
    "Do you trust the contents of this project?",
    "",
    "Antigravity CLI requires permission to read, edit, and execute files here.",
    "",
    "> Yes, I trust this folder",
    "  No, exit",
    "",
    "  ↑/↓ Navigate · enter Confirm",
    " ".repeat(width - [..."auto · Gemini 4 Hydrogen · low"].length) + "auto · Gemini 4 Hydrogen · low",
  ].join("\n");
}

/** Each agent's question this round redraws: its agent kind (the reader), its name, and how to draw it. */
export const questions = [
  { agent: "claude", name: "claude-bash", draw: (width: number) => drawClaudeBash(width) },
  { agent: "claude", name: "claude-edit", draw: (width: number) => drawClaudeEdit(width) },
  { agent: "codex", name: "codex-command", draw: (width: number) => drawCodexCommand(width) },
  { agent: "codex", name: "codex-form", draw: (width: number) => drawCodexForm(width) },
  { agent: "grok", name: "grok", draw: (width: number) => drawGrok(width) },
  { agent: "agy", name: "agy-command", draw: (width: number) => drawAgyCommand(width) },
  { agent: "agy", name: "agy-create", draw: (width: number) => drawAgyCreate(width) },
  { agent: "agy", name: "agy-edit", draw: (width: number) => drawAgyEdit(width) },
  { agent: "agy", name: "agy-trust", draw: (width: number) => drawAgyTrust(width) },
] as const;
