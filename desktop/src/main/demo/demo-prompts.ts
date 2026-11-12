// What the demo's blocked panes show to `pane.read`, screen by
// screen: each `pane.send_keys` to the pane moves it to its next screen (the
// last one stays). Drawn as the Swift app's prompt fixtures draw them (the
// boxed frames of App/CompanionLaunchFixture.swift; Claude Code 2.1.303's Bash
// dialog read live), so the card in the demo is the matcher's real reading:
//
// - Mac mini, Quartz sync retry rollout (w2:p70): an edit with a diff (nine
//   rows: six shown and "3 more"), then a question with four options (an
//   AskUserQuestion menu, drawn boxed), then the rollout started (no question);
// - build-box, beacon (w1:p1): Claude Code's Bash dialog (the fixture the
//   demo's terminal plays), then the command run (no question);
// - build-box, bookshop (w1:p2): a Codex question the matcher does not answer
//   (no numbered options): the card shows its lines and Answer in Terminal;
// - Mac mini, tidepool-narration (wD:pK): Grok 1.0.70's
//   approval frame (an invented command), then the
//   command run (no frame): its digit closes the frame.
// - Mac mini, lumen-onboarding-perf (wA:pM): Codex
//   0.166.0's tool-call question (its MCP elicitation form, a computer-use app
//   request, invented), then the call running (no form): its digit closes it.

/** `rows` in a box, each padded to the widest (one space inside each edge). */
function boxed(rows: readonly string[], indent = ""): string[] {
  const width = Math.max(...rows.map((row) => [...row].length));
  const edge = "─".repeat(width + 2);
  return [`${indent}╭${edge}╮`, ...rows.map((row) => `${indent}│ ${row}${" ".repeat(width - [...row].length)} │`), `${indent}╰${edge}╯`];
}

const editDiff = [
  "18      export const syncRetry = {",
  "19 -      requestsPerMin: 120,",
  "19 +      requestsPerMin: 60,",
  "20 +      // The rollout: half the rate until errors settle under 4%.",
  '21 +      rolledOutAt: "2026-11-04",',
  '22        backoff: "exponential-2x",',
  '23 -      endpoints: ["v3-items", "v3-users"],',
  '23 +      endpoints: ["v4-items", "v4-users", "v4-files"],',
  "24 +      pauseIfErrorPct: 6,",
];

const editFile = "src/sync/retry-config.ts";

/** The Mac mini's Quartz pane: Claude asking to edit the sync's retry config, the diff's box inside the dialog's. */
function editFrame(): string {
  const inner = boxed([editFile, "", ...editDiff]);
  const outer = boxed(["Edit file", ...inner, `Edit ${editFile}?`, "❯ 1. Yes", "  2. Yes, allow all edits this session", "  3. No, and tell Claude what to do differently (esc)"]);
  return [
    "⏺ The sync rolls out at half its rate, on the v4 endpoints, and pauses itself above 6% errors.",
    "",
    `⏺ Update(${editFile})`,
    ...outer,
  ].join("\n");
}

/** The edit with its question and options (what `pane.read` returns first). */
export const demoEditScreen = editFrame();

/** Then Claude asks which group to start with (an AskUserQuestion menu). */
export const demoAskScreen = [
  `⏺ Update(${editFile})`,
  `  ⎿  Updated ${editFile} with 5 additions and 2 removals`,
  "",
  "⏺ The rollout can start with a few groups; the choice changes the first week's load.",
  "",
  ...boxed([
    "☐ Rollout",
    "",
    "Which group should the rollout start with?",
    "",
    "❯ 1. Internal testers from the last beta",
    "  2. Everyone, with v3 as the fallback",
    "  3. Accounts active in the last 30 days",
    "  4. Type something",
  ]),
].join("\n");

/** Then the rollout started: no question on screen. */
export const demoQuartzDone = [
  `⏺ Update(${editFile})`,
  `  ⎿  Updated ${editFile} with 5 additions and 2 removals`,
  "",
  "⏺ Rolling out to the internal testers. The rollout's first report lands tomorrow at 9:00.",
  "",
  "✻ Worked for 12s",
  "",
].join("\n");

/** build-box's beacon after its Bash dialog was answered: the screen above the dialog, then the command's result. */
export function demoBashDone(bashDialog: string): string {
  const rows = bashDialog.replace(/\r\n/g, "\n").split("\n");
  const rule = rows.findIndex((row) => /^─{20,}$/u.test(row));
  const above = rule < 0 ? [] : rows.slice(0, rule);
  return [
    ...above,
    "⏺ Bash(echo shapes-c > /private/tmp/z-shapes/c.txt)",
    "  ⎿  (No output)",
    "",
    "⏺ Done: c.txt in z-shapes holds shapes-c.",
    "",
    "✻ Worked for 4s",
    "",
  ].join("\n");
}

/** build-box's bookshop: Codex asking in a frame the matcher does not answer (no numbered options). */
export const demoUnmatchedScreen = [
  "• Merging the staging settings into src/config.ts.",
  "",
  "  Codex wants to overwrite src/config.ts (412 lines) with the merged settings.",
  "",
  "  › Overwrite      Keep mine      Show the diff",
  "",
  "  Press enter to confirm or esc to cancel",
  "",
].join("\n");

/** The Grok pane's pending command (the transcript's pending tool call, the frame's title and command). */
export const demoGrokTitle = "Render scene 3's narration check";
export const demoGrokCommand = "python3 scripts/narrate.py --scene 3 --out /tmp/narration-check.wav";

/** Grok's running row above its frame (the tool's title, its clock, the turn's clock and tokens). */
function grokRunning(clock: string, total: string): string {
  const left = `◆ ${demoGrokTitle}…  ${clock}`;
  const right = `${total} ↓48k [↓][stop]`;
  return `${left}${" ".repeat(Math.max(2, 116 - [...left].length - [...right].length))}${right}`;
}

const grokAbove = [
  "  ⎿ Read scripts/narrate.py (64 lines)",
  "",
  "  The fade now starts at each scene's own end. Rendering scene 3 to hear the last word land inside it.",
  "",
];

/** The Grok pane's approval frame, as Grok Build 1.0.70 draws it. */
export const demoGrokScreen = [
  ...grokAbove,
  grokRunning("17m8s", "21m50s"),
  "",
  `┃ ›  ${demoGrokTitle}`,
  `┃ │ ${demoGrokCommand}`,
  "┃ ← → narrow scope  ·  e edit pattern",
  "┃",
  "┃ 1 (○) Yes, and don't ask again for anything (always-approve mode)",
  `┃ 2 (○) Always allow: ${demoGrokCommand}`,
  "┃ 3 (●) Yes, proceed",
  "┃ 4 (○) No, reject (type to add feedback)",
  "┃ 5 (○) Never allow: python3 scripts/narrate.py",
  "",
  "1/5:select │ Tab:next option │ ←/→:scope │ e:edit pattern │ Ctrl+o:always-approve │ Ctrl+c:cancel │ Esc:scrollback",
  "",
].join("\n");

/** Then the command runs: the frame gone. */
export const demoGrokDone = [
  ...grokAbove,
  grokRunning("17m12s", "21m54s"),
  "",
  `  ⎿ Run ${demoGrokCommand}`,
  "     scene 3: 41.2 s of speech, the last word ends 0.31 s into the fade",
  "",
].join("\n");

/** The Codex pane's tool-call question (a computer-use app request, invented). */
export const demoCodexAskHeader = "Allow Computer Use to control Google Chrome";
export const demoCodexAskParameters = ["app: Google Chrome", "task: Open the onboarding build and time its first paint"];

const codexAskAbove = [
  "› Time the onboarding screen's first paint in Chrome, cold and warm.",
  "",
  "• I'll open the onboarding build in Chrome with the computer-use tool and time its first paint.",
  "",
];

/** Codex's form as Codex 0.166.0 draws it (mcp_server_elicitation.rs): the menu's 2-cell inset. */
export const demoCodexAskScreen = [
  ...codexAskAbove,
  "  Field 1/1",
  `  ${demoCodexAskHeader}`,
  "",
  ...demoCodexAskParameters.map((row) => `  ${row}`),
  "",
  "  › 1. Allow                   Run the tool and continue",
  "    2. Allow for this session  Run the tool and remember this choice for this session",
  "    3. Always allow            Run the tool and remember this choice for future tool calls",
  "    4. Cancel                  Cancel this tool call",
  "  enter to submit | esc to cancel",
  "",
].join("\n");

/** Then the call runs: the form gone. */
export const demoCodexAskDone = [
  ...codexAskAbove,
  "• Calling computer-use.open_app",
  "  └ Google Chrome: the onboarding build, cold start",
  "",
  "• Working (4s • esc to interrupt)",
  "",
  "› Ask Codex to do anything",
  "",
].join("\n");

/** The screens each demo pane shows, by machine: the first now, each later one after a key is sent. */
export function demoPromptScreens(bashDialog: string): { macMini: Record<string, string[]>; buildBox: Record<string, string[]> } {
  return {
    macMini: {
      "w2:p70": [demoEditScreen, demoAskScreen, demoQuartzDone],
      "wD:pK": [demoGrokScreen, demoGrokDone],
      "wA:pM": [demoCodexAskScreen, demoCodexAskDone],
    },
    buildBox: { "w1:p1": [bashDialog, demoBashDone(bashDialog)], "w1:p2": [demoUnmatchedScreen] },
  };
}
