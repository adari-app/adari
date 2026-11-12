// The Swift app's prompt matcher, ported
// (src/shared/prompt/matcher.ts), through every Swift prompt fixture with the
// Swift tests' own expectations: CompanionPromptModelTests
// (CompanionPromptMatcherTests, CompanionInputPromptTests),
// CompanionLivePromptTests, CompanionLiveCodexPromptTests,
// CompanionLiveNarrowQuestionTests and CompanionLiveNamedTests. The screens are
// read straight out of the Swift sources (test/support/prompt-fixtures.ts).

import { describe, expect, it } from "vitest";

import {
  inputPrompts,
  isWorkingMark,
  matchForAgent,
  matchPrompt,
  moreOptions,
  optionByKey,
  primaryOption,
  promptFooters,
  readingMatch,
  showsInputPrompt,
  sideBySide,
  unmatchedLineCount,
  type PromptMatch,
} from "../src/shared/prompt/matcher";
import { E, F, L, Launch, box, lastLines, lines, rowsOf } from "./support/prompt-fixtures";

function match(text: string, pane = "pane-1"): PromptMatch {
  const reading = matchPrompt(text, pane);
  if (reading.type !== "matched") throw new Error(`expected a match, got ${JSON.stringify(reading)}`);
  return reading.match;
}

function reading(text: string) {
  return matchPrompt(text, "w1:p1");
}

const keys = (m: PromptMatch) => m.options.map((option) => option.key);
const labels = (m: PromptMatch) => m.options.map((option) => option.label);

describe("CompanionPromptMatcherTests, ported", () => {
  it("reads Claude's edit menu in its box", () => {
    const m = match(F.claudeEdit);
    expect(m.kind).toBe("menu");
    expect(m.question).toBe("Edit Tests/HelperTests/PairingTests.swift?");
    expect(keys(m)).toEqual(["1", "2", "3"]);
    expect(labels(m)).toEqual(["Yes", "Yes, allow all edits this session", "No, tell the agent what to change"]);
    expect(m.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(primaryOption(m)?.key).toBe("1");
    expect(m.options[0]!.isReturnDefault).toBe(true);
    expect(m.options[1]!.isSessionWide).toBe(true);
    expect(m.options[2]!.opensComposer).toBe(true);
    expect(sideBySide(m)).toBe(false);
    expect(moreOptions(m).map((o) => o.key)).toEqual(["2", "3"]);
    expect(m.context).toEqual({ type: "diff", added: 6, removed: 0 });
  });

  it("finds the command of Claude's unboxed Bash menu", () => {
    const m = match(F.claudeBash);
    expect(m.question).toBe("Do you want to proceed?");
    expect(m.context).toEqual({ type: "command", text: "git push origin fix/relay-timeout" });
    expect(m.options).toHaveLength(3);
    expect(m.options[1]!.isSessionWide).toBe(true);
    expect(m.options[2]!.label).toBe("No, and tell Claude what to do differently");
    expect(m.options[2]!.opensComposer).toBe(true);
    expect(primaryOption(m)?.label).toBe("Yes");
  });

  it("reads Codex's approval menu", () => {
    const m = match(F.codexCommand);
    expect(m.question).toBe("Would you like to run the following command?");
    expect(m.context).toEqual({ type: "command", text: "xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'" });
    expect(labels(m)).toEqual(["Yes, proceed", "Yes, and don't ask again for this command", "No, and tell Codex what to do differently"]);
    expect(m.options[0]!.isReturnDefault).toBe(true);
    expect(m.options[1]!.isSessionWide).toBe(true);
    expect(primaryOption(m)?.key).toBe("1");
  });

  it("reads Grok's four options", () => {
    const m = match(F.grokMenu);
    expect(m.question).toBe("Do you want to proceed with this operation?");
    expect(keys(m)).toEqual(["1", "2", "3", "4"]);
    expect(m.options[1]!.isSessionWide).toBe(true);
    expect(m.options[2]!.opensComposer).toBe(false);
    expect(m.options[3]!.opensComposer).toBe(true);
    expect(m.context).toEqual({ type: "diff", added: 2, removed: 1 });
    expect(moreOptions(m).map((o) => o.key)).toEqual(["2", "3", "4"]);
  });

  it("[y/N] fills nothing and marks the Return default", () => {
    const m = match(F.codexYesNo);
    expect(m.kind).toBe("yesNo");
    expect(m.question).toBe("Allow command? [y/N]");
    expect(primaryOption(m)).toBeNull();
    expect(sideBySide(m)).toBe(true);
    expect(labels(m)).toEqual(["Allow", "Deny"]);
    expect(m.options.map((o) => o.keys)).toEqual([
      ["y", "Enter"],
      ["n", "Enter"],
    ]);
    expect(m.options.map((o) => o.isReturnDefault)).toEqual([false, true]);
    expect(m.context).toEqual({ type: "command", text: "xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'" });
  });

  it("[Y/n] defaults to Yes; a bracket on its own line", () => {
    const yes = match(F.defaultYes);
    expect(yes.options.map((o) => o.isReturnDefault)).toEqual([true, false]);
    expect(match(F.bracketAlone).question).toBe("Overwrite App/Resources/en.lproj/Localizable.strings? [y/N]");
  });

  it("unmatched shows the last lines and no buttons", () => {
    const working = matchPrompt(F.working, "p");
    expect(working.type).toBe("unmatched");
    if (working.type !== "unmatched") return;
    expect(working.lines).toHaveLength(unmatchedLineCount);
    expect(working.lines.at(-1)).toBe("›");
    expect(readingMatch(matchPrompt(F.staleList, "p"))).toBeNull();
    expect(readingMatch(matchPrompt("", "p"))).toBeNull();
  });

  it("the fingerprint ignores the cursor but not the question or the pane", () => {
    const original = match(F.claudeEdit);
    const moved = match(F.claudeEditCursorOnTwo());
    expect(moved.fingerprint).toEqual(original.fingerprint);
    expect(primaryOption(moved)?.key).toBe("1");
    expect(match(F.claudeEdit.replace("Edit Tests/HelperTests/PairingTests.swift?", "Edit Sources/Helper/Pairing.swift?")).fingerprint).not.toEqual(
      original.fingerprint,
    );
    expect(match(F.claudeEdit, "pane-2").fingerprint).not.toEqual(original.fingerprint);
    expect(match(F.claudeEdit.replace("allow all edits this session", "allow edits to this file")).fingerprint).not.toEqual(original.fingerprint);
  });

  it("a reading survives JSON (it crosses IPC)", () => {
    const value = matchPrompt(F.claudeEdit, "p");
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it("a changed command under the same question changes the fingerprint", () => {
    const shown = readingMatch(reading(F.codexCommand))!;
    const pushed = F.codexCommand.replace("xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'", "git push origin main");
    expect(readingMatch(reading(pushed))!.fingerprint).not.toEqual(shown.fingerprint);
    const yesNo = readingMatch(reading(F.codexYesNo))!;
    const yesNoPushed = readingMatch(reading(F.codexYesNo.replace("xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'", "git push origin main")))!;
    expect(yesNo.fingerprint).not.toEqual(yesNoPushed.fingerprint);
  });

  it("the same diff counts with a different edit change the fingerprint", () => {
    const boxed = Launch.pairingPrompt;
    const boxedOther = boxed.replace("func testPairingCodeExpiresAfterTenMinutes() async {", "func testPairingCodeNeverExpires() async {   ");
    const a = readingMatch(reading(boxed))!;
    const b = readingMatch(reading(boxedOther))!;
    expect(a.context).toEqual(b.context);
    expect(a.fingerprint).not.toEqual(b.fingerprint);
    const above = readingMatch(reading(F.claudeEdit))!;
    const aboveOther = readingMatch(reading(F.claudeEdit.replace("let clock = TestClock()", "let clock = WallClock()")))!;
    expect(above.context).toEqual(aboveOther.context);
    expect(above.fingerprint).not.toEqual(aboveOther.fingerprint);
    const grok = readingMatch(reading(F.grokMenu))!;
    const grokOther = readingMatch(reading(F.grokMenu.replace("+ - 3 issues closed", "+ - 4 issues closed")))!;
    expect(grok.fingerprint).not.toEqual(grokOther.fingerprint);
  });

  it("wrapped questions bind every line", () => {
    const boxed = box(["Edit App/One/", "Localizable.strings?", "❯ 1. Yes", "  2. No"], 30);
    const one = readingMatch(reading(boxed))!;
    const two = readingMatch(reading(boxed.replace("App/One/", "App/Two/")))!;
    expect(one.question).toBe("Edit App/One/ Localizable.strings?");
    expect(one.fingerprint).not.toEqual(two.fingerprint);
    const grok = F.grokMenu.replace("Do you want to proceed with this operation?", "Do you want to write\ndocs/plans/one.md?");
    const grokOne = readingMatch(reading(grok))!;
    const grokTwo = readingMatch(reading(grok.replace("Do you want to write", "Do you want to erase")))!;
    expect(grokOne.question).toBe("Do you want to write docs/plans/one.md?");
    expect(grokOne.fingerprint).not.toEqual(grokTwo.fingerprint);
    expect(readingMatch(reading("Edit App/One/\nLocalizable.strings?\n1. Yes\n2. No"))).toBeNull();
  });

  it("a clipped frame top or body is unmatched (partial frames)", () => {
    const longEdit =
      "● Update App/Big.swift\n" +
      lines(45, (i) => `  ${i + 1} +let value${i} = ${i}`) +
      "\n\n╭────────────────────────────╮\n│ Edit App/Big.swift?         │\n│ ❯ 1. Yes                    │\n│   2. No                     │\n╰────────────────────────────╯";
    expect(readingMatch(reading(longEdit))).not.toBeNull();
    expect(readingMatch(reading(lastLines(longEdit)))).toBeNull();
    const tallBox =
      "⏺ Update(App/Big.swift)\n╭────────────╮\n│ Edit file  │\n" +
      lines(45, (i) => `│ ${i + 1} +let value${i} = ${i} │`) +
      "\n│            │\n│ Edit App/Big.swift? │\n│ ❯ 1. Yes │\n│   2. No │\n╰────────────╯";
    expect(readingMatch(reading(tallBox))).not.toBeNull();
    expect(readingMatch(reading(lastLines(tallBox)))).toBeNull();
    const longCommand =
      "• Building the app.\n\nWould you like to run the following command?\n\n  $ ./build.sh \\\n" +
      lines(45, (i) => `      --flag-${i} \\`) +
      "\n      --last\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel";
    expect(readingMatch(reading(longCommand))).not.toBeNull();
    expect(readingMatch(reading(lastLines(longCommand)))).toBeNull();
  });

  it("a running status below an old menu is unmatched", () => {
    expect(readingMatch(reading(`${F.claudeEdit}\n✻ Running tests… (1m 12s · esc to interrupt)\n`))).toBeNull();
    expect(readingMatch(reading(`${F.claudeBash}\n✻ Running… (3s · esc to interrupt)`))).toBeNull();
  });

  it("a trailing numbered plan is unmatched", () => {
    expect(readingMatch(reading("Here is the plan:\n1. Read the source\n2. Run the suite"))).toBeNull();
    expect(readingMatch(reading("Which should I do first?\n1. Read the source\n2. Run the suite"))).toBeNull();
    const menuThenPlan = `${F.claudeBash.replace("\n Esc to cancel", "")}\n● Plan:\n1. Push the branch\n2. Open the pull request\n3. Ask for review`;
    expect(readingMatch(reading(menuThenPlan))).toBeNull();
  });

  it("a menu with only options one and two drawn is unmatched", () => {
    expect(readingMatch(reading("Do you want to proceed?\n1. Yes\n2. Yes, allow all edits this session"))).toBeNull();
    const boxedPartial = F.claudeEdit.split("\n").slice(0, 15).join("\n");
    expect(boxedPartial).toContain("2. Yes, allow all edits");
    expect(readingMatch(reading(boxedPartial))).toBeNull();
    expect(readingMatch(reading(F.codexCommand.split("\n").slice(0, 8).join("\n")))).toBeNull();
  });

  it("a quoted argument whose inner spacing changes changes the fingerprint", () => {
    const command = "xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'";
    const twoSpaces = F.codexCommand.replace(command, "printf 'a  b'");
    const oneSpace = twoSpaces.replace("'a  b'", "'a b'");
    const shown = readingMatch(reading(twoSpaces))!;
    expect(readingMatch(reading(oneSpace))!.fingerprint).not.toEqual(shown.fingerprint);
    expect(shown.context).toEqual({ type: "command", text: "printf 'a  b'" });
    const yesNo = F.codexYesNo.replace(command, "printf 'a  b'");
    expect(readingMatch(reading(yesNo))!.fingerprint).not.toEqual(readingMatch(reading(yesNo.replace("'a  b'", "'a b'")))!.fingerprint);
    const bash = F.claudeBash.replace("git push origin fix/relay-timeout", "git commit -m 'a  b'");
    expect(readingMatch(reading(bash))!.fingerprint).not.toEqual(readingMatch(reading(bash.replace("'a  b'", "'a b'")))!.fingerprint);
  });

  it("a diff line whose indentation changes changes the fingerprint", () => {
    expect(readingMatch(reading(F.claudeEdit))!.fingerprint).not.toEqual(
      readingMatch(reading(F.claudeEdit.replace("89 +  let clock", "89 +    let clock")))!.fingerprint,
    );
    const boxed = Launch.pairingPrompt;
    const boxedShifted = boxed.replace("42 +        let clock = TestClock()  ", "42 +      let clock = TestClock()    ");
    expect(boxedShifted).not.toBe(boxed);
    expect(readingMatch(reading(boxed))!.fingerprint).not.toEqual(readingMatch(reading(boxedShifted))!.fingerprint);
    expect(readingMatch(reading(F.grokMenu))!.fingerprint).not.toEqual(readingMatch(reading(F.grokMenu.replace("  + ## Sweep", "  +   ## Sweep")))!.fingerprint);
  });

  it("a row that may be wrapped is unmatched (wrapped frames)", () => {
    const long = `printf '${"a".repeat(72)}`;
    const codex = (command: string) => F.codexCommand.replace("$ xcodebuild test -scheme Quartz -destination 'platform=iOS Simulator'", command);
    const wrapped = codex(`$ ${long}\n  b'`);
    expect(readingMatch(reading(wrapped))?.context).toEqual({ type: "command", text: `${long} …` });
    expect(readingMatch(reading(wrapped.replace("Press enter to confirm or esc to cancel", "Esc to cancel")))).toBeNull();
    expect(readingMatch(reading(codex(`$ ${long}' \\\n      'b'`)))).not.toBeNull();
    const rows = ["Bash command", "", "  swift test --filter PairingTests", "  --parallel", "  Run the pairing tests", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No"];
    expect(readingMatch(reading(box(rows, 34)))).toBeNull();
    expect(readingMatch(reading(box(rows, 50)))).not.toBeNull();
  });

  it("the first three of Grok's four options is unmatched", () => {
    const rows = F.grokMenu.split("\n");
    const firstThree = rows.slice(0, -1).join("\n");
    expect(firstThree.endsWith("3. No")).toBe(true);
    expect(readingMatch(reading(firstThree))).toBeNull();
    expect(readingMatch(reading(rows.slice(0, -2).join("\n")))).toBeNull();
    expect(readingMatch(reading("Do you want to proceed?\n❯ 1. Yes\n  2. No"))).toBeNull();
  });
});

describe("CompanionInputPromptTests, ported (the agents' own empty fields)", () => {
  it("reads each kind's recorded field", () => {
    const recorded: [string, string][] = [
      ["claude", F.claudeInput],
      ["claude", F.claudeInputRuled],
      ["codex", F.codexInput],
      ["grok", F.grokInput],
      ["claude", Launch.pairingFeedbackField],
      ["codex", Launch.reviewerFeedbackField],
    ];
    for (const [kind, text] of recorded) {
      expect(showsInputPrompt(text, kind), text).toBe(true);
      expect(showsInputPrompt(text, kind[0]!.toUpperCase() + kind.slice(1))).toBe(true);
      expect(readingMatch(matchPrompt(text, "pane-1"))).toBeNull();
    }
    const drawn = `\u001b[2m${F.claudeInput.replace(/\n/g, "\r\n")}\u001b[0m\r\n\r\n`;
    expect(showsInputPrompt(drawn, "claude")).toBe(true);
  });

  it("empty, partial, typed and unknown frames prove nothing", () => {
    const unproved: [string, string][] = [
      ["empty", ""],
      ["blank rows", "\n\n  \n"],
      ["partial approval", F.claudeEdit.slice(0, 100)],
      ["whole approval", F.claudeEdit],
      ["unsupported approval", F.unsupportedApproval],
      ["field still drawing", F.claudeInputPartial],
      ["text in the field", F.claudeInputTyped],
      ["output under the field", `${F.claudeInput}\n● Read Sources/Helper/Pairing.swift`],
      ["unrecorded footer", `${F.grokInput}\n  ≋ some hint`],
      ["still working", F.claudeInput.replace("  ⎿  Interrupted · What should Claude do instead?", "✻ Thinking… (4s · esc to interrupt)")],
    ];
    expect(F.claudeInputTyped).not.toBe(F.claudeInput);
    for (const [name, text] of unproved) {
      for (const kind of ["claude", "codex", "grok"]) expect(showsInputPrompt(text, kind), `${name} (${kind})`).toBe(false);
    }
    expect(showsInputPrompt(F.working, "codex")).toBe(false);
  });

  it("a field counts only for its own kind", () => {
    expect(showsInputPrompt(F.claudeInput, "codex")).toBe(false);
    expect(showsInputPrompt(F.claudeInput, "grok")).toBe(false);
    expect(showsInputPrompt(F.grokInput, "claude")).toBe(false);
    expect(showsInputPrompt(F.codexInput, "claude")).toBe(false);
    for (const kind of ["gemini", "cursor", "", "constructor", "__proto__"]) expect(showsInputPrompt(F.claudeInput, kind), kind).toBe(false);
    expect(showsInputPrompt(F.claudeInput, null)).toBe(false);
    expect(Object.keys(inputPrompts).sort()).toEqual(["claude", "codex", "grok"]);
  });
});

describe("CompanionLiveClaudePromptTests, ported (Claude Code 2.1.303 read live)", () => {
  it("the Bash question matches with its options and its frame's fingerprint", () => {
    const m = match(L.claude2_1_303Bash, "w7:p9");
    expect(m.kind).toBe("menu");
    expect(m.question).toBe("Do you want to proceed?");
    expect(keys(m)).toEqual(["1", "2", "3", "4"]);
    expect(labels(m)).toEqual([
      "Yes",
      "Yes, and always allow access to /private/tmp/z-shapes from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
    expect(m.options.map((o) => o.isReturnDefault)).toEqual([true, false, false, false]);
    expect(m.options.map((o) => o.isSessionWide)).toEqual([false, true, true, false]);
    expect(m.options.map((o) => o.opensComposer)).toEqual([false, false, false, false]);
    expect(matchForAgent(m, "claude").options.map((o) => o.opensComposer)).toEqual([false, false, false, true]);
    expect(matchForAgent(m, "codex")).toEqual(m);
    expect(m.context).toEqual({ type: "command", text: "echo shapes-c > /private/tmp/z-shapes/c.txt" });
    expect(primaryOption(m)?.key).toBe("1");
    expect(moreOptions(m).map((o) => o.key)).toEqual(["2", "3", "4"]);
    expect(m.fingerprint).toEqual({
      rules: 2,
      paneID: "w7:p9",
      question: "Do you want to proceed?",
      body: [
        " Bash command",
        ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
        " Write shapes-c to c.txt in z-shapes directory",
        " echo shapes-c > /private/tmp/z-shapes/c.txt",
      ],
      options: [
        "1. Yes",
        "2. Yes, and always allow access to /private/tmp/z-shapes from this project",
        "3. Yes, and switch to auto mode · auto mode handles these prompts for you",
        "4. No",
      ],
    });
  });

  it("the Bash fingerprint follows the frame", () => {
    const m = match(L.claude2_1_303Bash, "w7:p9");
    const body: [string, string][] = [
      ["the command", E.row(L.claude2_1_303Bash, 17, (r) => r.replace("c.txt", "d.txt"))],
      ["the Tip", E.row(L.claude2_1_303Bash, 14, (r) => r.replace("below", "belov"))],
      ["the description", E.row(L.claude2_1_303Bash, 15, (r) => r.replace("Write", "Wrote"))],
      ["an option row", E.row(L.claude2_1_303Bash, 21, (r) => r.replace("z-shapes", "z-other"))],
    ];
    for (const [name, text] of body) expect(match(text, "w7:p9").fingerprint, name).not.toEqual(m.fingerprint);
    expect(readingMatch(matchPrompt(E.removing(L.claude2_1_303Bash, 24, 26), "w7:p9"))).toBeNull();
    const moved = E.row(
      E.row(L.claude2_1_303Bash, 20, (r) => r.replace("❯", " ")),
      23,
      (r) => r.replace("  4. No", "❯ 4. No"),
    );
    expect(match(moved, "w7:p9").fingerprint).toEqual(m.fingerprint);
  });

  it("the Write question matches; its card line is the file's name row", () => {
    const m = match(L.claude2_1_303Write, "w7:p9");
    expect(m.question).toBe("Do you want to create new.txt?");
    expect(labels(m)).toEqual([
      "Yes",
      "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session",
      "No",
    ]);
    expect(m.options.map((o) => o.isSessionWide)).toEqual([false, true, false]);
    expect(m.context).toEqual({ type: "file", name: "new.txt" });
    expect(m.fingerprint.body).toEqual([" Create file", " new.txt", "  1 hello shapes"]);
    expect(match(E.row(L.claude2_1_303Write, 22, (r) => r.replace("hello", "hullo")), "w7:p9").fingerprint).not.toEqual(m.fingerprint);
    expect(readingMatch(matchPrompt(E.removing(L.claude2_1_303Write, 28, 30), "w7:p9"))).toBeNull();
    const wrapped = E.inserting(
      E.row(L.claude2_1_303Write, 20, () => " /private/tmp/z-shapes/deeply/nested/fold"),
      [" er/new.txt"],
      21,
    );
    expect(match(wrapped, "w7:p9").context).toEqual({ type: "file", name: "/private/tmp/z-shapes/deeply/nested/fold …" });
    expect(match(E.inserting(L.claude2_1_303Write, ["  2 second line"], 23), "w7:p9").context).toEqual({ type: "file", name: "new.txt" });
    const ruleless = E.removing(E.removing(L.claude2_1_303Write, 23, 24), 21, 22);
    expect(ruleless).not.toContain("╌");
    const bare = match(ruleless, "w7:p9");
    expect(bare.context).toBeNull();
    expect(bare.question).toBe("Do you want to create new.txt?");
  });

  it("a Bash command over several rows shows its first row", () => {
    const two = E.inserting(L.claude2_1_303Bash, [" cat /private/tmp/z-shapes/c.txt"], 18);
    expect(match(two, "w7:p9").context).toEqual({ type: "command", text: "echo shapes-c > /private/tmp/z-shapes/c.txt …" });
    const wide = ` echo ${"a".repeat(124)}`;
    const wrapped = E.inserting(
      E.row(L.claude2_1_303Bash, 17, () => wide),
      [" bbb"],
      18,
    );
    const m = match(wrapped, "w7:p9");
    expect(m.context).toEqual({ type: "command", text: `echo ${"a".repeat(124)} …` });
    expect(m.fingerprint.body).toContain(wide);
    expect(m.fingerprint.body).toContain(" bbb");
  });

  it("switching the session's mode is session-wide; naming a file is not", () => {
    const sessionWide = (label: string) => optionByKey(match(E.row(L.claude2_1_303Bash, 22, () => `   3. ${label}`), "w7:p9"), "3")!.isSessionWide;
    expect(sessionWide("Yes, and switch to auto mode · auto mode handles these prompts for you")).toBe(true);
    expect(sessionWide("Yes, and switch to plan mode")).toBe(true);
    expect(sessionWide("Yes, and switch to accept edits (shift+tab)")).toBe(true);
    expect(sessionWide("Yes, and edit docs/switch to auto mode.md")).toBe(false);
    expect(sessionWide("Yes, and switch to auto mode.md")).toBe(false);
    expect(sessionWide("Yes, and open ~/switch to auto mode/notes")).toBe(false);
    expect(sessionWide("Yes, and switch to ./plan mode")).toBe(false);
    expect(sessionWide("Yes")).toBe(false);
  });

  it("the folder trust question stays unmatched", () => {
    const value = matchPrompt(L.claude2_1_303Trust, "w7:p9");
    expect(value.type).toBe("unmatched");
    if (value.type === "unmatched") expect(value.lines.at(-1)).toBe("Enter to confirm · Esc to cancel");
    expect(promptFooters.has("enter to confirm · esc to cancel")).toBe(false);
  });

  it("older Claude frames match exactly as before, fingerprints included", () => {
    const bash = match(F.claudeBash, "p");
    expect(bash.fingerprint).toEqual({
      rules: 2,
      paneID: "p",
      question: "Do you want to proceed?",
      body: [" Bash command", "", "   git push origin fix/relay-timeout", "   Push the fix branch to origin", ""],
      options: ["1. Yes", "2. Yes, and don't ask again for git push commands in /Users/fixture/code/aurora-web", "3. No, and tell Claude what to do differently (esc)"],
    });
    const edit = match(F.claudeEdit, "p");
    expect(edit.fingerprint).toEqual({
      rules: 2,
      paneID: "p",
      question: "Edit Tests/HelperTests/PairingTests.swift?",
      body: [
        "● Update Tests/HelperTests/PairingTests.swift",
        "      88 +func testExpiredTokenIsRejected() {",
        "      89 +  let clock = TestClock()",
        "      90 +  let token = issuer.issue(at: clock.now)",
        "      91 +  clock.advance(by: .minutes(6))",
        "      92 +  XCTAssertThrowsError(try verify(token))",
        "      93 +}",
        "",
      ],
      options: ["1. Yes", "2. Yes, allow all edits this session", "3. No, tell the agent what to change"],
    });
  });
});

describe("CompanionLiveCodexPromptTests, ported (Codex 0.163.0 read live)", () => {
  const command = "echo shapes-3 > /Users/demo/code/notes/aurora-web-codex-probe-results-day-one/evidence/shapes/codex-probe-out.txt";

  it("the question matches with its wrapped option and Environment and Reason rows", () => {
    const m = match(L.codex0_163_0Dialog, "w7:p9");
    expect(m.question).toBe("Would you like to run the following command?");
    expect(labels(m)).toEqual([
      "Yes, proceed",
      "Yes, and don't ask again for commands that start with `echo shapes-3 > /Users/demo/code/notes/aurora-web-codex-probe-results- day-one/evidence/shapes/codex-probe-out.txt`",
      "No, and tell Codex what to do differently",
    ]);
    expect(m.options.map((o) => o.opensComposer)).toEqual([false, false, true]);
    expect(m.context).toEqual({ type: "command", text: command });
    expect(matchForAgent(m, "codex")).toEqual(m);
    expect(m.fingerprint).toEqual({
      rules: 2,
      paneID: "w7:p9",
      question: "Would you like to run the following command?",
      body: ["", "  Environment: local", "", "  Reason: Do you approve running this exact command to write shapes-3 to codex-probe-out.txt?", "", `  $ ${command}`, "", ""],
      options: [
        "1. Yes, proceed (y)",
        "2. Yes, and don't ask again for commands that start with `echo shapes-3 > /Users/demo/code/notes/aurora-web-codex-probe-results-",
        "     day-one/evidence/shapes/codex-probe-out.txt` (p)",
        "3. No, and tell Codex what to do differently (esc)",
      ],
    });
  });

  it("the fingerprint follows the frame; no footer is still drawing", () => {
    const m = match(L.codex0_163_0Dialog, "w7:p9");
    const changes: [string, string][] = [
      ["the command", E.row(L.codex0_163_0Dialog, 31, (r) => r.replace("shapes-3", "shapes-4"))],
      ["the Reason", E.row(L.codex0_163_0Dialog, 29, (r) => r.replace("exact", "exakt"))],
      ["the Environment", E.row(L.codex0_163_0Dialog, 27, (r) => r.replace("local", "remote"))],
      ["the wrapped option row", E.row(L.codex0_163_0Dialog, 36, (r) => r.replace("probe", "proof"))],
      ["an option row", E.row(L.codex0_163_0Dialog, 37, (r) => r.replace("Codex", "Kodex"))],
    ];
    for (const [name, text] of changes) expect(match(text, "w7:p9").fingerprint, name).not.toEqual(m.fingerprint);
    expect(readingMatch(matchPrompt(E.removing(L.codex0_163_0Dialog, 38, 40), "w7:p9"))).toBeNull();
  });

  it("the Reason is never the question in Codex's frame", () => {
    const wrapped = E.inserting(
      E.row(L.codex0_163_0Dialog, 29, () => "  Reason: Do you approve running this exact command"),
      ["  to write shapes-3 to codex-probe-out.txt?"],
      30,
    );
    expect(match(wrapped).question).toBe("Would you like to run the following command?");
    expect(match(E.row(L.codex0_163_0Dialog, 27, () => "  Environment: local?")).question).toBe("Would you like to run the following command?");
    expect(match(E.row(L.codex0_163_0Dialog, 39, () => "  Esc to cancel")).question).toBe(
      "Reason: Do you approve running this exact command to write shapes-3 to codex-probe-out.txt?",
    );
  });

  it("a wrapped option row must sit past its number", () => {
    expect(readingMatch(matchPrompt(E.row(L.codex0_163_0Dialog, 36, (r) => r.replace("     day-one", "   day-one")), "w7:p9"))).toBeNull();
    const last = E.inserting(
      E.row(L.codex0_163_0Dialog, 37, () => "  3. No, and tell Codex what to do"),
      ["     differently (esc)"],
      38,
    );
    const m = match(last);
    expect(labels(m).at(-1)).toBe("No, and tell Codex what to do differently");
    expect(m.options.at(-1)!.opensComposer).toBe(true);
    expect(m.fingerprint.options.slice(-2)).toEqual(["3. No, and tell Codex what to do", "     differently (esc)"]);
    expect(readingMatch(matchPrompt(E.inserting(E.removing(L.codex0_163_0Dialog, 38, 40), ["     • Working (1s)"], 38), "w7:p9"))).toBeNull();
    expect(readingMatch(matchPrompt(E.inserting(L.codex0_163_0Dialog, [""], 36), "w7:p9"))).toBeNull();
  });

  it("the hand-written Codex command still matches", () => {
    const m = match(F.codexCommand, "p");
    expect(m.fingerprint.options).toEqual(["1. Yes, proceed (y)", "2. Yes, and don't ask again for this command (a)", "3. No, and tell Codex what to do differently (esc)"]);
  });
});

describe("CompanionLiveNarrowQuestionTests, ported (wrapped bodies at narrow widths)", () => {
  /** Rows `start...end` (one paragraph the terminal wrapped) drawn as one row. */
  function unwrapped(text: string, start: number, end: number): string {
    const rows = text.split("\n");
    rows[start] = rows
      .slice(start, end + 1)
      .map((row, index) => (index === 0 ? row : row.trim()))
      .join(" ");
    rows.splice(start + 1, end - start);
    return rows.join("\n");
  }

  it("the narrow Claude questions match with their buttons", () => {
    for (const [width, text, command] of [
      [54, L.claude2_1_303Narrow54Bash, "echo mid > /private/tmp/z-narrow/m.txt"],
      [39, L.claude2_1_303Narrow39Bash, "echo narrow > …"],
    ] as const) {
      const m = match(text, "w7:p9");
      expect(m.question, `${width}`).toBe("Do you want to proceed?");
      expect(labels(m), `${width}`).toEqual([
        "Yes",
        "Yes, and always allow access to /private/tmp/z-narrow from this project",
        "Yes, and switch to auto mode · auto mode handles these prompts for you",
        "No",
      ]);
      expect(m.options.map((o) => o.isSessionWide)).toEqual([false, true, true, false]);
      expect(matchForAgent(m, "claude").options.map((o) => o.opensComposer)).toEqual([false, false, false, true]);
      expect(m.context).toEqual({ type: "command", text: command });
    }
    const at39 = match(L.claude2_1_303Narrow39Bash, "w7:p9");
    expect(at39.fingerprint.body).toEqual([
      " Bash command",
      " Tip: auto mode handles these prompts",
      ' for you — choose "switch to auto',
      ' mode" below',
      ' Write "narrow" to n.txt in z-narrow',
      " directory",
      " echo narrow >",
      " /private/tmp/z-narrow/n.txt",
    ]);
    expect(at39.fingerprint.options).toEqual([
      "1. Yes",
      "2. Yes, and always allow access to",
      "      /private/tmp/z-narrow from this",
      "      project",
      "3. Yes, and switch to auto mode ·",
      "      auto mode handles these prompts",
      "      for you",
      "4. No",
    ]);
  });

  it("the narrow Codex question matches with its options", () => {
    const m = match(L.codex0_163_0Narrow51Dialog, "w7:p9");
    expect(m.question).toBe("Would you like to run the following command?");
    expect(labels(m)).toEqual([
      "Yes, proceed",
      "Yes, and don't ask again for commands that start with `echo narrow-codex > /private/tmp/ z-narrow2-out/n.txt`",
      "No, and tell Codex what to do differently",
    ]);
    expect(m.context).toEqual({ type: "command", text: "echo narrow-codex > …" });
    expect(m.fingerprint.body).toEqual(["", "  Environment: local", "", "  Reason: Allow writing the requested text to", "  /private/tmp/z-narrow2-out/n.txt?", "", "  $ echo narrow-codex >", "  /private/tmp/z-narrow2-out/n.txt", "", ""]);
    const one = E.removing(E.row(L.codex0_163_0Narrow51Dialog, 28, () => "  $ echo narrow-codex > n.txt"), 29, 30);
    expect(match(one).context).toEqual({ type: "command", text: "echo narrow-codex > n.txt" });
  });

  it("the same question at two widths has two fingerprints", () => {
    const narrow = match(L.claude2_1_303Narrow54Bash, "w7:p9");
    const wide = match(unwrapped(L.claude2_1_303Narrow54Bash, 18, 19), "w7:p9");
    expect(labels(wide)).toEqual(labels(narrow));
    expect(wide.context).toEqual(narrow.context);
    expect(wide.fingerprint).not.toEqual(narrow.fingerprint);
    const codexWide = match(unwrapped(unwrapped(L.codex0_163_0Narrow51Dialog, 28, 29), 25, 26), "w7:p9");
    expect(codexWide.context).toEqual({ type: "command", text: "echo narrow-codex > /private/tmp/z-narrow2-out/n.txt" });
    expect(codexWide.fingerprint).not.toEqual(match(L.codex0_163_0Narrow51Dialog, "w7:p9").fingerprint);
  });

  it("every wide live read keeps its card line", () => {
    expect(match(L.claude2_1_303NamedBash, "w7:p9").context).toEqual({ type: "command", text: "echo named > /private/tmp/z-shapes2/n.txt" });
    expect(readingMatch(matchPrompt(L.claude2_1_303Trust, "w7:p9"))).toBeNull();
  });

  it("a wrapped body outside the two frames stays unmatched", () => {
    const rows = rowsOf(L.claude2_1_303Narrow54Bash);
    const footer = rows.findLastIndex((row) => row.includes("Esc to cancel · Tab to amend"));
    expect(readingMatch(matchPrompt(E.row(L.claude2_1_303Narrow54Bash, footer, () => " Esc to cancel"), "w7:p9"))).toBeNull();
    const header = rows.findIndex((row) => row === " Bash command");
    expect(readingMatch(matchPrompt(E.row(L.claude2_1_303Narrow54Bash, header, () => "⏺ Bash"), "w7:p9"))).toBeNull();
    const codexRows = rowsOf(L.codex0_163_0Narrow51Dialog);
    const codexFooter = codexRows.findLastIndex((row) => row.includes("Press enter to confirm"));
    expect(readingMatch(matchPrompt(E.row(L.codex0_163_0Narrow51Dialog, codexFooter, () => " Esc to cancel · Tab to amend"), "w7:p9"))).toBeNull();
  });

  it("an older Claude frame with a wrapped body stays unmatched", () => {
    const rows = ["Bash command", "", "  swift test --filter PairingTests", "  --parallel", "  Run the pairing tests", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No"];
    const full = `${box(rows, 34)}\n   Esc to cancel`;
    const roomy = `${box(rows, 50)}\n   Esc to cancel`;
    expect(readingMatch(matchPrompt(full, "p"))).toBeNull();
    expect(readingMatch(matchPrompt(roomy, "p"))).not.toBeNull();
    for (const footer of ["Esc to cancel · Tab to amend", "Press enter to confirm or esc to cancel"]) {
      expect(readingMatch(matchPrompt(full.replace("   Esc to cancel", `   ${footer}`), "p"))).toBeNull();
      expect(readingMatch(matchPrompt(roomy.replace("   Esc to cancel", `   ${footer}`), "p"))).not.toBeNull();
    }
  });

  it("a wrapped question row behaves as before", () => {
    const rows = rowsOf(L.claude2_1_303Narrow54Bash);
    const question = rows.findIndex((row) => row.trim() === "Do you want to proceed?");
    const two = E.inserting(E.row(L.claude2_1_303Narrow54Bash, question, () => " Do you want to proceed with this"), [" command?"], question + 1);
    expect(match(two).question).toBe("Do you want to proceed with this command?");
    const five = E.inserting(E.row(L.claude2_1_303Narrow54Bash, question, () => " Do you"), [" want", " to", " proceed", " now?"], question + 1);
    expect(readingMatch(matchPrompt(five, "w7:p9"))).toBeNull();
  });
});

describe("CompanionLiveNamedTests, ported (a named session; spinner rows)", () => {
  const rule = (count: number) => "─".repeat(count);
  const top = (middle: string) => rule(131 - middle.length - 1) + middle + rule(1);

  it("a named session's empty field is proved, for Claude only", () => {
    expect(showsInputPrompt(L.claude2_1_303NamedAfterNo, "claude")).toBe(true);
    expect(showsInputPrompt(L.claude2_1_303NamedIdleField, "claude")).toBe(true);
    for (const text of [L.claude2_1_303NamedAfterNo, L.claude2_1_303NamedIdleField]) {
      for (const kind of ["codex", "grok", "gemini", null]) expect(showsInputPrompt(text, kind)).toBe(false);
    }
    expect(showsInputPrompt(E.row(L.claude2_1_303NamedAfterNo, 35, () => top(" my named session ")), "claude")).toBe(true);
  });

  it("a named field with text or an odd rule is not proved", () => {
    const a = L.claude2_1_303NamedAfterNo;
    const cases: [string, string][] = [
      ["text after ❯", E.row(a, 36, () => "❯ typed text here")],
      ["the placeholder", E.row(a, 36, () => '❯ Try "fix lint errors"')],
      ["labelled top and bottom", E.row(a, 37, () => `${rule(114)} z-named-shapes ${rule(1)}`)],
      ["two labels", E.row(a, 35, () => `${rule(110)} one ${rule(10)} two ${rule(1)}`)],
      ["a box character in the label", E.row(a, 35, () => top(" z│named "))],
      ["no space before the label", E.row(a, 35, () => top("z-named-shapes "))],
      ["the bottom rule cut off", E.removing(a, 37, 41)],
      ["the labelled top rule cut off", E.removing(a, 35, 36)],
    ];
    for (const [name, text] of cases) expect(showsInputPrompt(text, "claude"), name).toBe(false);
    expect(showsInputPrompt(E.row(a, 35, () => top("  ")), "claude")).toBe(true);
    // Claude Code 2.1.319 draws the name with no rule after it ("──── name ", its trailing space trimmed).
    expect(showsInputPrompt(E.row(a, 35, () => `${rule(116)} z-named-shapes `), "claude"), "no rule after the label (2.1.319)").toBe(true);
  });

  it("a named session's Bash question matches with its buttons", () => {
    const m = match(L.claude2_1_303NamedBash, "w7:p9");
    expect(labels(m)).toEqual(["Yes", "Yes, and always allow access to /private/tmp/z-shapes2 from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    expect(m.fingerprint.body).toEqual([
      " Bash command",
      ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
      ' Write "named" into n.txt in z-shapes2 directory',
      " echo named > /private/tmp/z-shapes2/n.txt",
    ]);
    expect(match(E.row(L.claude2_1_303NamedBash, 14, (r) => r.replace("n.txt", "m.txt")), "w7:p9").fingerprint).not.toEqual(m.fingerprint);
  });

  it("spinner rows are working marks", () => {
    for (const row of ["✽ Flambéing… (1m 4s · ↓ 5.1k tokens · thought for 8s)", "✶ Mulling… (1h 2m 3s)", "· Café-hopping… (2s)", "✢ Überlegen… (5s)", "✽ Fiddle-faddling… (1s · thinking)"]) {
      expect(isWorkingMark(row), row).toBe(true);
    }
    for (const row of ["✻ Cogitated for 1h 51m 57s · done 3:20 PM", "✽ Flambéing…", "✽ Flambé ing… (1s)", "✽ Flambéing… (1h)", "✽ Flambé1ng… (1s)", "✽ -Flambéing… (1s)"]) {
      expect(isWorkingMark(row), row).toBe(false);
    }
    expect(showsInputPrompt(E.row(L.claude2_1_303NamedAfterNo, 31, () => "✽ Flambéing… (1m 4s · ↓ 5.1k tokens · thought for 8s)"), "claude")).toBe(false);
  });

  it("every live field Swift proves is proved here, and the after-No reads match nothing", () => {
    for (const [kind, text] of [
      ["claude", L.claude2_1_303AfterNo],
      ["claude", L.claude2_1_303ClearedANSI],
      ["claude", L.claude2_1_303Narrow39AfterNo],
      ["claude", L.claude2_1_303Narrow54AfterNo],
      ["claude", L.claude2_1_303Narrow54ClearedAfterNo],
      ["codex", L.codex0_163_0AfterNo],
      ["codex", L.codex0_163_0IdleField],
      ["codex", L.codex0_163_0Narrow51After3],
      ["grok", L.grok1_0_60IdleField],
    ] as const) {
      expect(showsInputPrompt(text, kind), kind).toBe(true);
      expect(readingMatch(matchPrompt(text, "w7:p9"))).toBeNull();
    }
    for (const [kind, text] of [
      ["claude", L.claude2_1_303Typed],
      ["claude", L.claude2_1_303IdleField],
      ["claude", L.claude2_1_303Narrow54IdleField],
      ["claude", L.claude2_1_303Narrow54Cleared],
      ["claude", L.claude2_1_303WorkingEarly],
      ["codex", L.codex0_163_0Typed],
      ["codex", L.codex0_163_0Working],
      ["grok", L.grok1_0_60Typed],
    ] as const) {
      expect(showsInputPrompt(text, kind), kind).toBe(false);
    }
  });
});

describe("CompanionLiveFieldTests, ported (today's fields read live)", () => {
  const proved = (text: string, kind: string | null) => showsInputPrompt(text, kind);
  const refusedForEveryOtherKind = (text: string, own: string) => {
    for (const kind of ["claude", "codex", "grok", "gemini", "CLAUDE", "Codex"]) {
      if (kind.toLowerCase() !== own) expect(proved(text, kind), `${own}'s field for ${kind}`).toBe(false);
    }
    expect(proved(text, null)).toBe(false);
  };

  it("Claude 2.1.303's empty field is proved", () => {
    const a = L.claude2_1_303AfterNo;
    expect(proved(a, "claude")).toBe(true);
    expect(proved(a, "Claude")).toBe(true);
    expect(proved(L.claude2_1_303ClearedANSI, "claude")).toBe(true);
    expect(proved(E.row(a, 34, () => ""), "claude"), "no hint row").toBe(true);
    expect(proved(E.removing(a, 39, 40), "claude"), "one statusline row").toBe(true);
    expect(proved(E.removing(a, 38, 40), "claude"), "no statusline").toBe(true);
    expect(proved(E.inserting(a, ["  anything Robin configures"], 40), "claude"), "three statusline rows").toBe(true);
    refusedForEveryOtherKind(a, "claude");
    refusedForEveryOtherKind(L.claude2_1_303ClearedANSI, "claude");
  });

  it("Claude 2.1.303's typed or placeholder field is not proved", () => {
    expect(proved(L.claude2_1_303Typed, "claude")).toBe(false);
    expect(proved(L.claude2_1_303IdleField, "claude")).toBe(false);
    expect(proved(E.row(L.claude2_1_303AfterNo, 36, () => "❯ x"), "claude")).toBe(false);
  });

  it("Claude 2.1.303's partial or other frames are not proved", () => {
    const a = L.claude2_1_303AfterNo;
    const cases: [string, string][] = [
      ["the bottom rule and below cut off", E.removing(a, 37, 41)],
      ["the bottom rule cut off", E.removing(a, 37, 38)],
      ["the top rule cut off", E.removing(a, 35, 36)],
      ["four rows under the rule", E.inserting(a, ["  one", "  two"], 40)],
      ["a rule under the field", E.inserting(a, ["─".repeat(131)], 39)],
      ["an option row under the field", E.row(a, 39, () => "  1. Yes")],
      ["a working mark under the field", E.row(a, 39, () => "  esc to interrupt")],
      ["text right above the top rule", E.row(a, 34, () => "Some output")],
      ["a hint that is not right-aligned", E.row(a, 34, () => "  ◐ medium · /effort")],
      ["two hint rows", E.row(a, 33, () => `${" ".repeat(111)}◐ medium · /effort`)],
      ["text right above the hint", E.row(a, 33, () => "Some output")],
      ["a box, not rules", E.row(E.row(a, 35, () => `╭${"─".repeat(129)}╮`), 37, () => `╰${"─".repeat(129)}╯`)],
      ["the question still on screen", L.claude2_1_303Bash],
      ["the Write question", L.claude2_1_303Write],
      ["the trust question", L.claude2_1_303Trust],
      ["an empty read", ""],
    ];
    for (const [name, text] of cases) expect(proved(text, "claude"), name).toBe(false);
  });

  it("Claude's working screen needs Herdr's status; its spinner row is a working mark", () => {
    expect(proved(L.claude2_1_303Working, "claude")).toBe(true);
    expect(proved(L.claude2_1_303WorkingEarly, "claude")).toBe(false);
    for (const row of ["✽ Fiddle-faddling… (1s · thinking)", "✻ Pondering… (12s · ↓ 2.1k tokens)", "· Cooking… (3s)", "✢ Spelunking… (1m 12s · esc to interrupt)", "* Thinking… (40s)"]) {
      expect(isWorkingMark(row), row).toBe(true);
    }
    for (const row of [
      "✽ Fiddle-faddling…",
      "✽ Two words… (1s)",
      "- Fiddle… (1s)",
      "✻ Worked for 12s",
      "✻ Cogitated for 1m 3s",
      "* Reading… (see the docs)",
      "The build… (12s)",
      "✽ Done… (thinking)",
      "● Ran tests… (12s)",
      "✽ Fiddle-faddling… 1s",
      "  ⎿  Tip: Use ctrl+v to paste images from your clipboard",
    ]) {
      expect(isWorkingMark(row), row).toBe(false);
    }
    expect(proved(E.row(L.claude2_1_303AfterNo, 31, () => "* Reading… (see the docs)"), "claude")).toBe(true);
    expect(proved(E.row(L.claude2_1_303AfterNo, 31, () => "✽ Fiddle-faddling… (1s · thinking)"), "claude")).toBe(false);
  });

  it("Codex 0.163.0's empty field is proved; typed, working or partial is not", () => {
    const a = L.codex0_163_0AfterNo;
    expect(proved(a, "codex")).toBe(true);
    expect(proved(L.codex0_163_0IdleField, "codex")).toBe(true);
    expect(proved(E.row(a, 39, () => "  ? for shortcuts"), "codex")).toBe(true);
    refusedForEveryOtherKind(a, "codex");
    refusedForEveryOtherKind(L.codex0_163_0IdleField, "codex");
    const cases: [string, string][] = [
      ["typed", L.codex0_163_0Typed],
      ["working", L.codex0_163_0Working],
      ["the footer cut off", E.removing(a, 39, 41)],
      ["no blank row", E.removing(a, 37, 38)],
      ["no statusline", E.removing(a, 38, 39)],
      ["two statusline rows", E.inserting(a, ["  more status"], 39)],
      ["no › row", E.row(a, 36, () => "Ask Codex to do anything")],
      ["a footer with more after it", E.row(a, 39, () => "  ? for shortcutsX")],
      ["a footer with one space before more", E.row(a, 39, () => "  ? for shortcuts ⚠ 2 warnings")],
      ["the question still on screen", L.codex0_163_0Dialog],
    ];
    for (const [name, text] of cases) expect(proved(text, "codex"), name).toBe(false);
  });

  it("Grok 1.0.60's empty field is proved; typed or partial is not", () => {
    const a = L.grok1_0_60IdleField;
    expect(proved(a, "grok")).toBe(true);
    expect(proved(E.row(a, 36, () => `  ╰${"─".repeat(125)}╯`), "grok")).toBe(true);
    refusedForEveryOtherKind(a, "grok");
    const cases: [string, string][] = [
      ["typed", L.grok1_0_60Typed],
      ["typed text, idle footer", E.row(L.grok1_0_60Typed, 38, () => "  Shift+Tab:mode  │  Ctrl+.:shortcuts")],
      ["the bottom edge cut off", E.removing(a, 36, 37)],
      ["the top edge cut off", E.removing(a, 34, 35)],
      ["the footer cut off", E.removing(a, 38, 40)],
      ["no blank row", E.removing(a, 37, 38)],
      ["two labels", E.row(a, 36, () => "  ╰── a ── b ─╯")],
    ];
    for (const [name, text] of cases) expect(proved(text, "grok"), name).toBe(false);
  });

  it("a labelled bottom edge does not end a menu", () => {
    const rows = F.claudeEdit.split("\n");
    const bottom = rows.findLastIndex((row) => row.includes("╰"));
    rows[bottom] = "╰──────────────────────────────────── Grok 4.7 Fast (high) ─╯";
    expect(readingMatch(matchPrompt(rows.join("\n"), "p"))).toBeNull();
  });
});

describe("CompanionLiveNarrowTests, ported (Claude's hint row at 39 and 54 columns)", () => {
  const proved = (text: string, kind: string | null = "claude") => showsInputPrompt(text, kind);
  const hint = (row: string) => E.row(L.claude2_1_303Narrow54AfterNo, 34, () => row);
  const ending = (text: string, end: number, cells?: number) => " ".repeat(end - (cells ?? [...text].length)) + text;

  it("the narrow after-No fields are proved, for Claude only", () => {
    for (const text of [L.claude2_1_303Narrow54AfterNo, L.claude2_1_303Narrow54ClearedAfterNo, L.claude2_1_303Narrow39AfterNo]) {
      expect(proved(text)).toBe(true);
      for (const kind of ["codex", "grok", "gemini", null]) expect(proved(text, kind)).toBe(false);
    }
    expect(proved(L.claude2_1_303Narrow54IdleField)).toBe(false);
    expect(proved(L.claude2_1_303Narrow54Cleared)).toBe(false);
  });

  it("the hint is right-aligned against its rule", () => {
    const effort = "◐ medium · /effort";
    for (const end of [51, 52, 53]) expect(proved(hint(ending(effort, end))), `ends at ${end}`).toBe(true);
    for (const end of [48, 49, 50, 54]) expect(proved(hint(ending(effort, end))), `ends at ${end}`).toBe(false);
    expect(proved(hint(effort + " ".repeat(40)))).toBe(false);
    for (const row of ["  ◐ medium · /effort", "◐ medium · /effort", "  Ctrl+Y to paste deleted text"]) expect(proved(hint(row)), row).toBe(false);
    expect(proved(hint(` ${"x".repeat(51)}`))).toBe(false);
    expect(proved(hint(`  ${"x".repeat(50)}`))).toBe(true);
    expect(proved(hint(ending("1. Yes", 52)))).toBe(false);
    expect(proved(hint(ending("设置 · /effort", 52, 14)))).toBe(true);
    expect(proved(hint(ending("设置 · /effort", 52, 12)))).toBe(false);
    expect(proved(E.row(L.claude2_1_303Narrow54AfterNo, 35, () => "─".repeat(54)))).toBe(true);
    expect(proved(E.row(L.claude2_1_303Narrow54AfterNo, 35, () => "─".repeat(50)))).toBe(false);
    const cleared = "Ctrl+Y to paste deleted text";
    expect(proved(hint(ending(cleared, 52)))).toBe(true);
    expect(proved(E.row(L.claude2_1_303Narrow39AfterNo, 34, () => ending(cleared, 37)))).toBe(true);
  });

  it("one hint row only, with blank above", () => {
    const a = L.claude2_1_303Narrow54AfterNo;
    expect(proved(E.row(a, 33, () => ending("Ctrl+Y to paste deleted text", 52)))).toBe(false);
    expect(proved(E.row(a, 33, () => ending("◐ medium · /effort", 52)))).toBe(false);
    expect(proved(E.row(a, 33, () => "✻ Cogitated for 1s · done 5:11 PM"))).toBe(false);
    expect(proved(E.row(a, 34, () => "✻ Cogitated for 1s · done 5:11 PM"))).toBe(false);
    expect(proved(E.removing(a, 0, 34))).toBe(true);
  });
});
