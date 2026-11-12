// Claude Code 2.1.319 draws the session's name in its prompt box's top rule:
// a run of `─`, one space, the name, one trailing space; the bottom rule stays
// `─` only (as read from a 200-column pane):
//
//     ──────────────────── … ──────────────────── Weekly docs status
//     ❯ 1, sent
//     ──────────────────── … ────────────────────────────────────────
//       Opus 5.5 | 24% ctx | app | main | Weekly docs status | v2.1.319
//       ⏵⏵ auto mode on (shift+tab to cycle)
//
// Every reader that finds the box by its rules reads it: the mode chip and
// draft (approval-modes.ts), the live row (chat/live-screen.ts), the update
// mark (update-mark.ts) and the empty-field proof (prompt/matcher.ts). 2.1.318's
// plain rules read as before; a bottom rule with a label is no box; a ruled
// transcript line above the box never becomes it. The same cases as
// Tests/HerdrKitTests/ClaudeTitledBoxTests.swift and
// Tests/HerdrCompanionTests/CompanionClaudeTitledBoxTests.swift.

import { describe, expect, it } from "vitest";

import { readClaudeModeScreen } from "../src/shared/approval-modes";
import { ChatLiveScreen } from "../src/shared/chat/live-screen";
import { claudeBoxRules, isClaudeBottomRule, isClaudeTopRule } from "../src/shared/claude-box";
import { showsInputPrompt } from "../src/shared/prompt/matcher";
import { readUpdateLine } from "../src/shared/update-mark";

const width = 200;
const dashes = (count: number): string => "\u{2500}".repeat(count);
const cells = (text: string): number => [...text].length;
const plain = dashes(width);
/** 2.1.319's top rule as drawn: dashes, a space, the name, a space. */
const titled = (name: string): string => `${dashes(width - cells(name) - 2)} ${name} `;
/** A name in the middle of the rule, dashes either side. */
const middle = (name: string, rest = 10): string => `${dashes(width - cells(name) - 2 - rest)} ${name} ${dashes(rest)}`;
/** A ruled line in the conversation ("──── Results ────"). */
const results = `${dashes(4)} Results ${dashes(4)}`;

const name = "Weekly docs status";
const statusLine = `  Opus 5.5 | 24% ctx | app | main | ${name} | v2.1.319`;
const statusLine318 = "  Opus 5.5 | 24% ctx | app | main | v2.1.318";
const autoRow = "  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)";
const shellRow = "  \u{23F5}\u{23F5} auto mode on \u{00B7} 1 shell";
const empty = "\u{276F}\u{00A0}";
const spinner = "\u{2722} Gallivanting\u{2026} (12s \u{00B7} \u{2193} 1.2k tokens)";
const updateLine = "\u{2714} Update installed \u{00B7} Restart to update";
/** Right-aligned against the rule's right end, as Claude Code draws its update line and hints. */
const right = (text: string, short = 1): string => " ".repeat(width - cells(text) - short) + text;

/** The box under a top rule: the prompt rows, the plain bottom rule, the status line and the mode row. */
const box = (top: string, prompt: readonly string[] = [empty], mode = autoRow, status = statusLine): string[] => [top, ...prompt, plain, status, mode];
const join = (rows: readonly string[]): string => rows.join("\n");

/** A 2.1.319 pane as read: a reply, then the titled box. */
const read319 = ["\u{23FA} Sent.", "", ...box(titled(name), ["\u{276F} 1, sent"])];

/** The names: a long one cut with "…", one with punctuation and digits, one in the middle of the rule, as Claude Code draws them. */
const namedTops: readonly [string, string][] = [
  ["2.1.319", titled(name)],
  ["cut", titled("aurora-web-titled-box-42 reads Claude Code's titled prompt box rule in both tw\u{2026}")],
  ["punctuation and digits", titled("fix #42: v2.1.319 (r1), done!")],
  ["in the middle", middle("z-named-shapes")],
  ["2.1.303's trailing dash", `${dashes(width - 16)} z-named-shapes \u{2500}`],
];

const box318 = (prompt: readonly string[] = [empty], mode = autoRow): string[] => [plain, ...prompt, plain, statusLine318, mode];

describe("the rule helper (claude-box.ts)", () => {
  it("a bottom rule is dashes only; a top rule is that or one label", () => {
    expect(isClaudeBottomRule(plain)).toBe(true);
    expect(isClaudeBottomRule(dashes(7))).toBe(false);
    expect(isClaudeTopRule(plain)).toBe(true);
    for (const [label, top] of namedTops) {
      expect(isClaudeTopRule(top), label).toBe(true);
      expect(isClaudeTopRule(top.trimEnd()), label).toBe(true);
      expect(isClaudeBottomRule(top.trimEnd()), label).toBe(false);
    }
    expect(isClaudeTopRule(results)).toBe(true);
  });

  it("not a top rule: no dashes before the label, fewer than four, no space, two labels, two spaces", () => {
    for (const line of [
      `${name} ${dashes(40)}`,
      `${dashes(3)} ${name} ${dashes(40)}`,
      `${dashes(40)}${name}`,
      `${dashes(40)} one ${dashes(10)} two ${dashes(1)}`,
      `${dashes(40)}  ${name}`,
      "\u{276F} 1, sent",
    ]) {
      expect(isClaudeTopRule(line.trimEnd()), line).toBe(false);
    }
  });

  it("the box: the last rule plain, the nearest rule above it its top", () => {
    const rows = read319.map((row) => row.trimEnd());
    expect(claudeBoxRules(rows)).toEqual({ top: 2, bottom: 4 });
    expect(claudeBoxRules(["x", results, "y", ...box(titled(name))].map((row) => row.trimEnd()))).toEqual({ top: 3, bottom: 5 });
    expect(claudeBoxRules([plain, empty, middle("Results")])).toBeNull();
    expect(claudeBoxRules([plain])).toBeNull();
  });
});

describe("the mode chip and the draft (readClaudeModeScreen)", () => {
  it("reads 2.1.319's box: mode auto; the read's own row is a draft, an empty row none", () => {
    expect(readClaudeModeScreen(join(read319))).toEqual({ draft: "1, sent", empty: false, mode: "auto" });
    expect(readClaudeModeScreen(join(["\u{23FA} Sent.", "", ...box(titled(name))]))).toEqual({ draft: "", empty: true, mode: "auto" });
  });

  it("reads the mode row with a background shell's suffix", () => {
    expect(readClaudeModeScreen(join(box(titled(name), [empty], shellRow)))).toEqual({ draft: "", empty: true, mode: "auto" });
  });

  it("returns a draft of two lines inside a titled box", () => {
    const rows = box(titled(name), ["\u{276F} first line of the draft", "  and its second line"]);
    expect(readClaudeModeScreen(join(rows))).toEqual({ draft: "first line of the draft\nand its second line", empty: false, mode: "auto" });
  });

  it("reads every name's rule", () => {
    for (const [label, top] of namedTops) expect(readClaudeModeScreen(join(box(top))), label).toEqual({ draft: "", empty: true, mode: "auto" });
  });

  it("2.1.318's plain box reads as before", () => {
    expect(readClaudeModeScreen(join(box318()))).toEqual({ draft: "", empty: true, mode: "auto" });
    expect(readClaudeModeScreen(join(box318(["\u{276F}\u{00A0}draft"])))).toEqual({ draft: "draft", empty: false, mode: "auto" });
  });

  it("a ruled transcript line above the box is not the box; a labelled bottom rule is no box", () => {
    const transcript = ["\u{23FA} The table:", "", results, "  ok", ""];
    expect(readClaudeModeScreen(join([...transcript, ...box(titled(name), ["\u{276F} go on"])]))).toEqual({ draft: "go on", empty: false, mode: "auto" });
    expect(readClaudeModeScreen(join([...transcript, ...box318(["\u{276F} go on"])]))).toEqual({ draft: "go on", empty: false, mode: "auto" });
    expect(readClaudeModeScreen(join([titled(name), empty, titled(name), statusLine, autoRow]))).toBeNull();
    expect(readClaudeModeScreen(join([...box(titled(name)), results]))).toBeNull();
  });
});

describe("the live row (ChatLiveScreen.block)", () => {
  const working = (top: string, mode = autoRow): string => join(["\u{23FA} I am writing this reply now.", "", spinner, ...box(top, [empty], mode)]);

  it("reads the text over a spinner above a titled box", () => {
    for (const kind of ["claude", null]) expect(ChatLiveScreen.block(working(titled(name)), kind)?.text).toBe("I am writing this reply now.");
    expect(ChatLiveScreen.block(working(titled(name), shellRow), "claude")?.text).toBe("I am writing this reply now.");
  });

  it("reads under every name's rule, and 2.1.318's plain box as before", () => {
    for (const [label, top] of namedTops) expect(ChatLiveScreen.block(working(top), "claude")?.text, label).toBe("I am writing this reply now.");
    expect(ChatLiveScreen.block(working(plain), "claude")?.text).toBe("I am writing this reply now.");
  });

  it("a ruled transcript line is not the box; a labelled bottom rule is no box", () => {
    const rows = ["\u{23FA} Earlier text.", results, "\u{23FA} Writing the next part.", "", spinner, ...box(titled(name))];
    expect(ChatLiveScreen.block(join(rows), "claude")?.text).toBe("Writing the next part.");
    expect(ChatLiveScreen.block(join(["\u{23FA} Text.", "", spinner, titled(name), empty, titled(name), statusLine]), "claude")).toBeNull();
  });
});

describe("the update mark (readUpdateLine)", () => {
  const reply = ["\u{23FA} The last reply.", ""];

  it("reads the line under a titled box's top rule", () => {
    expect(readUpdateLine(join([...reply, right(updateLine), ...box(titled(name))]))).toBe(true);
    expect(readUpdateLine(join([...reply, ...box(titled(name))]))).toBe(false);
    expect(readUpdateLine(join([...reply, right(updateLine), ...box(titled(name), [empty], shellRow)]))).toBe(true);
  });

  it("reads under every name's rule, and over 2.1.318's plain box as before", () => {
    for (const [label, top] of namedTops) expect(readUpdateLine(join([...reply, right(updateLine), ...box(top)])), label).toBe(true);
    expect(readUpdateLine(join([...reply, right(updateLine), ...box318()]))).toBe(true);
    expect(readUpdateLine(join([...reply, ...box318()]))).toBe(false);
  });

  it("a ruled transcript line is not the box; a labelled bottom rule is no box", () => {
    expect(readUpdateLine(join([...reply, right(updateLine), results, "\u{23FA} Later.", "", ...box(titled(name))]))).toBe(false);
    expect(readUpdateLine(join([...reply, right(updateLine), titled(name), empty, titled(name), statusLine]))).toBeNull();
  });
});

describe("the empty field (showsInputPrompt)", () => {
  const done = ["\u{23FA} Done.", ""];

  it("proves 2.1.319's empty field, never its draft", () => {
    expect(showsInputPrompt(join([...done, ...box(titled(name))]), "claude")).toBe(true);
    expect(showsInputPrompt(join([...done, ...box(titled(name), [empty], shellRow)]), "claude")).toBe(true);
    expect(showsInputPrompt(join(read319), "claude")).toBe(false);
    expect(showsInputPrompt(join([...done, ...box(titled(name), ["\u{276F} first line", "  second line"])]), "claude")).toBe(false);
    for (const kind of ["codex", "grok", null]) expect(showsInputPrompt(join([...done, ...box(titled(name))]), kind)).toBe(false);
  });

  it("proves every name's rule, a hint above it, and 2.1.318's plain box as before", () => {
    for (const [label, top] of namedTops) expect(showsInputPrompt(join([...done, ...box(top)]), "claude"), label).toBe(true);
    expect(showsInputPrompt(join(["\u{23FA} Done.", "", right("\u{25D0} medium \u{00B7} /effort", 2), ...box(titled(name))]), "claude")).toBe(true);
    expect(showsInputPrompt(join([...done, ...box318()]), "claude")).toBe(true);
  });

  it("a ruled transcript line is not the field; a labelled rule under the box is no field", () => {
    expect(showsInputPrompt(join([results, "", ...box(titled(name))]), "claude")).toBe(true);
    expect(showsInputPrompt(join([...done, plain, empty, middle("Results")]), "claude")).toBe(false);
    expect(showsInputPrompt(join([...done, titled(name), empty, plain, statusLine, middle("Results")]), "claude")).toBe(false);
  });
});
