// Claude Code's approval frames taller than the card's 40-line read, drawn
// as Claude Code 2.1.303 draws them (the live fixtures' shape:
// Tests/HerdrCompanionTests/Fixtures/Live/
// claude-2.1.303-bash-dialog.txt and claude-2.1.303-write-dialog.txt, 131
// cells wide): the transcript above, the full-width rule, the section header,
// the Tip and the description (Bash) or the file (Edit), the body between two
// dashed rules, the question, the options, a blank row and the footer.
//
// A screen ends on its last row, no line break after it: the demo's fake
// `pane.read` (FixtureTransport) slices the text by line, so a final break
// would make its full read one row short (a short read holds the whole pane).
//
// The Bash body is a heredoc command: `cd …; python3 -I - <<'EOF'`,
// the script, `EOF`, every row different so a frame that moves shows. The
// Edit body is a diff drawn as the Write dialog draws its new file's rows.

/** The live fixtures' width. */
export const tallWidth = 131;

const tip = ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below';

/**
 * `row` as a pane `width` cells wide draws it: word-wrapped as Ink wraps the
 * frame's text, each further row under the frame's one cell of padding.
 */
export function wrapRow(row: string, width: number): string[] {
  if ([...row].length <= width) return [row];
  const pad = /^ */u.exec(row)![0];
  const words = row.slice(pad.length).split(" ");
  const rows: string[] = [];
  let current = pad + words[0]!;
  for (const word of words.slice(1)) {
    if ([...current].length + 1 + [...word].length <= width) current += ` ${word}`;
    else {
      rows.push(current);
      current = ` ${word}`;
    }
  }
  rows.push(current);
  return rows;
}

/** The frame's rows at `width`: its rules the pane's width, every other row wrapped. */
function drawn(rows: readonly (string | "rule" | "dashes")[], width: number): string[] {
  return rows.flatMap((row) => (row === "rule" ? ["─".repeat(width)] : row === "dashes" ? ["╌".repeat(width)] : wrapRow(row, width)));
}

export const tallDescription = "Fold the probe runs into one summary file";
export const tallFirstLine = "cd /Users/demo/work/probes; python3 -I - <<'EOF'";

/** A heredoc command of `count` lines in all (at least 3): the `cd …; python3` line, the script, `EOF`. */
export function heredoc(count: number): string[] {
  const script = ["import json, pathlib", "rows = []", 'for name in sorted(pathlib.Path("runs").glob("*.json")):', "    data = json.loads(name.read_text())"];
  const body: string[] = [];
  for (let index = 0; index < count - 2; index += 1) {
    body.push(index < script.length ? script[index]! : `    rows.append({"step": ${index}, "probe": "p-${index}", "ok": data.get("ok-${index}")})`);
  }
  return [tallFirstLine, ...body, "EOF"];
}

/** Claude's two options for a command it cannot remember a rule for. */
export const yesNo = ["Yes", "No"];
/** Its three for a command it can. */
export const yesAlwaysNo = ["Yes", "Yes, and don't ask again for python3 commands in /Users/demo/work/probes", "No"];
/** An edit's three. */
export const editOptions = ["Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", "No"];

function optionRows(options: readonly string[], marked = 0): string[] {
  return options.map((label, index) => `${index === marked ? " ❯ " : "   "}${index + 1}. ${label}`);
}

/** The screen above the frame (the live fixture's top rows, then the user's message and the call's row). */
function above(callRow: string, firstLine: string): string[] {
  return [
    "  Updated to latest. Got 8 features, 37 bugfixes, and 6 other changes.",
    "  code.claude.com/docs/en/changelog for details",
    "",
    "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
    "",
    "⏺ Remote Control is disabled by your organization's policy. Contact your organization admin for access.",
    "",
    "❯ Fold the probe runs into one summary and tell me how many there were",
    "",
    `  ${callRow}`,
    `  ⎿  ${firstLine}`,
    "",
  ];
}

/**
 * Claude Code 2.1.303 asking to run `command` (its lines), as the whole pane
 * shows it, `width` cells wide: at 131 cells the frame is 11 rows more than
 * the command (taller than a 40-line read past 29 lines); at 80 the Tip wraps.
 */
export function tallBash(command: readonly string[], options: readonly string[] = yesNo, marked = 0, width = tallWidth): string {
  return [
    ...drawn(above("Folding the probe runs into one summary file", `$ ${command[0]!}`), width),
    ...drawn(["rule", " Bash command", tip, ` ${tallDescription}`, "dashes", ...command.map((line) => ` ${line}`), "dashes", " Do you want to proceed?"], width),
    ...optionRows(options, marked),
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
}

export const tallEditFile = "desktop/src/probe/summary.ts";

/** The diff's rows: `count` pairs of a removed and an added row under one context row, numbered from 40. */
export function longDiff(count: number): string[] {
  const rows = [`  40   export function summary(runs: readonly Run[]): Summary {`];
  for (let index = 0; index < count; index += 1) {
    rows.push(`  ${41 + index} -   const step${index} = runs[${index}]?.ms ?? 0;`);
    rows.push(`  ${41 + index} +   const step${index} = runs.at(${index})?.ms ?? Number.NaN;`);
  }
  return rows;
}

/** Claude Code 2.1.303 asking to edit `tallEditFile` with `diff` (the Write dialog's shape, "Edit file" over it). */
export function tallEdit(diff: readonly string[], options: readonly string[] = editOptions): string {
  return [
    ...above(`Update(${tallEditFile})`, "Updating summary.ts"),
    ...drawn(["rule", " Edit file", ` ${tallEditFile}`, "dashes", ...diff, "dashes", " Do you want to make this edit to summary.ts?"], tallWidth),
    ...optionRows(options),
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
}

/** The last `count` rows of a screen, as `pane.read` (source recent) returns them. */
export function tail(screen: string, count: number): string {
  const rows = screen.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.slice(-count).join("\n");
}
