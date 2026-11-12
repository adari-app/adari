// Captures 131-132: Claude Code 2.1.303 asking, in a frame taller than the
// card's 40-line read, to run a 60-line command (`cd …; python3 -I - <<'EOF'`,
// the script, `EOF`) and to make an edit with a long diff. Drawn as the live
// frames are (fixtures/replay/claude-2.1.303-bash-dialog.txt, 131 cells
// wide): the rule, the section header, the Tip and the description or the
// file, the body between two dashed rules, the question, the options, a blank
// row and the footer. Invented; the captures show them on build-box's beacon pane.
// Each screen ends on its last row: FixtureTransport slices `pane.read` by
// line, so a final line break would make a full read one row short.

const width = 131;
const rule = "─".repeat(width);
const dashes = "╌".repeat(width);

/** The rows above the frame: the user's message and the call's row. */
function above(callRow: string, firstLine: string): string[] {
  return [
    "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
    "",
    "❯ Fold last night's probe runs into one summary and tell me how many failed",
    "",
    `⏺ ${callRow}`,
    `  ⎿  ${firstLine}`,
    "",
  ];
}

/** The command: `cd …; python3 -I - <<'EOF'`, a 58-line script, `EOF`. */
export const demoTallCommand: readonly string[] = (() => {
  const script = [
    "import json, pathlib",
    "rows = []",
    'for name in sorted(pathlib.Path("runs").glob("*.json")):',
    "    data = json.loads(name.read_text())",
  ];
  for (let index = script.length; index < 57; index += 1) {
    script.push(`    rows.append({"probe": "p-${index}", "ok": data.get("ok-${index}"), "ms": data.get("ms-${index}")})`);
  }
  script.push('pathlib.Path("summary.json").write_text(json.dumps(rows, indent=2))');
  return ["cd ~/probes/nightly; python3 -I - <<'EOF'", ...script, "EOF"];
})();

export const demoTallDescription = "Fold the nightly probe runs into one summary file";

/** Claude Code asking to run `demoTallCommand` (78 rows: the card's 40-line read starts in its command). */
export const demoTallBashScreen = [
  ...above("Folding the nightly probe runs into one summary file", `$ ${demoTallCommand[0]!}`),
  rule,
  " Bash command",
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  ` ${demoTallDescription}`,
  dashes,
  ...demoTallCommand.map((line) => ` ${line}`),
  dashes,
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

export const demoTallEditFile = "src/probe/summary.ts";

/** Claude Code asking to edit `demoTallEditFile`: a context row and 40 removed and added pairs (81 diff rows, 99 in all). */
export const demoTallEditScreen = (() => {
  const diff = ["  40   export function summary(runs: readonly Run[]): Summary {"];
  for (let index = 0; index < 40; index += 1) {
    diff.push(`  ${41 + index} -   const step${index} = runs[${index}]?.ms ?? 0;`);
    diff.push(`  ${41 + index} +   const step${index} = runs.at(${index})?.ms ?? Number.NaN;`);
  }
  return [
    ...above(`Update(${demoTallEditFile})`, "Updating summary.ts"),
    rule,
    " Edit file",
    ` ${demoTallEditFile}`,
    dashes,
    ...diff,
    dashes,
    " Do you want to make this edit to summary.ts?",
    " ❯ 1. Yes",
    "   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
})();

// Capture 133: a frame whose header is above even the card's
// 200-line read: Claude Code asking to run a 250-line command on the Mac
// mini's sundial pane, whose transcript gets the same call, still running
// (Chat's running call: the card shows it under its label, and Answer in
// Terminal).

/** The 250-line command: `cd …; python3 -I - <<'EOF'`, a 248-line script, `EOF`. */
export const demoTallCutCommand: readonly string[] = (() => {
  const script = ["import json, pathlib", "rows = []", 'for name in sorted(pathlib.Path("runs").glob("*.json")):', "    data = json.loads(name.read_text())"];
  for (let index = script.length; index < 247; index += 1) {
    script.push(`    rows.append({"probe": "p-${index}", "ok": data.get("ok-${index}"), "ms": data.get("ms-${index}")})`);
  }
  script.push('pathlib.Path("week.json").write_text(json.dumps(rows, indent=2))');
  return ["cd ~/probes/weekly; python3 -I - <<'EOF'", ...script, "EOF"];
})();

export const demoTallCutDescription = "Fold the week's probe runs into one summary file";

/** Claude Code asking to run `demoTallCutCommand` (268 rows: its header is above a 200-line read). */
export const demoTallCutScreen = [
  ...above("Folding the week's probe runs into one summary file", `$ ${demoTallCutCommand[0]!}`),
  rule,
  " Bash command",
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  ` ${demoTallCutDescription}`,
  dashes,
  ...demoTallCutCommand.map((line) => ` ${line}`),
  dashes,
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

/** A tool call as Claude Code writes it in its transcript (its tool_use), still running: no result yet. */
export interface DemoRunningCall {
  /** The user's message that starts the turn. */
  readonly ask: string;
  readonly id: string;
  readonly name: string;
  readonly input: { readonly [key: string]: string };
}

/** The call behind `demoTallCutScreen`, as Chat reads it from the transcript. */
export const demoTallCutCall: DemoRunningCall = {
  ask: "Fold the week's probe runs into one summary and tell me how many failed",
  id: "toolu_demo_tall_cut",
  name: "Bash",
  input: { command: demoTallCutCommand.join("\n"), description: demoTallCutDescription },
};
