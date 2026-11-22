// Antigravity CLI 1.5.13's own questions as cards (shared/prompt/matcher.ts agyTrust and agyAsk, card.ts, answerer.ts):
// test/fixtures/antigravity holds the four screens read live (pane.read, 40 lines; the trust question at 119 columns,
// the permission questions at 201), paths replaced by neutral ones of the same length. The redraws at 80 and 160
// columns move the right-hand mode line and the rule, and wrap a long choice under its words (indented five cells:
// assumed from Ink's wrapping, not seen live).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { answerPrompt, type PaneIO } from "../src/shared/prompt/answerer";
import { agyCommandLine, agyFileLine, cardContent } from "../src/shared/prompt/card";
import { agyQuestion, agyTrace, matchPrompt, readingMatch, sameFingerprint, type PromptMatch } from "../src/shared/prompt/matcher";
import { promptLike } from "../src/shared/prompt/quiet";
import { readStartScreen } from "../src/shared/prompt/start-screen";

const fixture = (name: string): string => readFileSync(path.join(__dirname, "fixtures/antigravity", name), "utf8");
const trust = fixture("trust-119.txt");
const commandAsk = fixture("command-ask.txt");
const createAsk = fixture("create-file-ask.txt");
const editAsk = fixture("edit-file-ask.txt");
const asks = { command: commandAsk, create: createAsk, edit: editAsk } as const;
const work = "/tmp/demo/sample-folder/work";
const model = "Gemini 4 Hydrogen · low";

function agy(text: string, pane = "w1:p1"): PromptMatch {
  const match = readingMatch(matchPrompt(text, pane, "agy"));
  if (match === null) throw new Error("expected agy's question");
  return match;
}
const unmatched = (text: string, kind: string | null = "agy"): boolean => matchPrompt(text, "w1:p1", kind).type === "unmatched";
const lines = (text: string): string[] => text.replace(/\n$/u, "").split("\n");
const replaceRow = (text: string, from: string, to: string): string => lines(text).map((row) => (row === from ? to : row)).join("\n") + "\n";

/** A row's words, then the right-hand words at the screen's right edge. */
const rightAligned = (left: string, right: string, width: number): string => left + " ".repeat(Math.max(2, width - left.length - [...right].length)) + right;

/** A choice row wrapped to `width` cells: its first five cells (marker, space, digit, `. `), then its words, the rows after the first indented `indent` cells. */
function wrap(first: string, indent: number, width: number): string[] {
  const rows: string[] = [];
  let row = first.slice(0, indent);
  let fresh = true;
  for (const word of first.slice(indent).split(" ")) {
    if (!fresh && row.length + 1 + word.length > width) {
      rows.push(row);
      row = " ".repeat(indent) + word;
    } else row = fresh ? row + word : `${row} ${word}`;
    fresh = false;
  }
  rows.push(row);
  return rows;
}

/** The trust question as agy draws it at `width` columns (a long path wraps by cells). */
function trustAt(width: number, folder = "/tmp/demo/sample-folder/work2", marked: 0 | 1 = 0): string {
  const paths: string[] = [];
  for (let at = 0; at < folder.length; at += width) paths.push(folder.slice(at, at + width));
  return [
    "Accessing workspace:",
    "",
    ...paths,
    "",
    "Do you trust the contents of this project?",
    "",
    "Antigravity CLI requires permission to read, edit, and execute files here.",
    "",
    `${marked === 0 ? ">" : " "} Yes, I trust this folder`,
    `${marked === 1 ? ">" : " "} No, exit`,
    "",
    "  ↑/↓ Navigate · enter Confirm",
    " ".repeat(width - [..."auto · Gemini 4 Hydrogen · low"].length) + "auto · Gemini 4 Hydrogen · low",
  ].join("\n");
}

/** A permission question redrawn at `width` columns: its frame from the title down, the rule and the last row to the width, long choices wrapped. */
function askAt(sample: string, width: number): string {
  const rows = lines(sample);
  const title = rows.findIndex((row) => row === "Command" || row === "Create file" || row === "Pending edit");
  return [
    "● Edited 1 file (ask.txt) (ctrl+o to expand)",
    "",
    ...rows.slice(title).flatMap((row) => {
      if (/^─+$/u.test(row)) return ["─".repeat(width)];
      if (row.startsWith("esc to cancel")) return [rightAligned("esc to cancel", model, width)];
      if (/^[> ] \d\. /u.test(row)) return wrap(row, 5, width);
      return [row];
    }),
  ].join("\n");
}

const optionsOf = (match: PromptMatch) => match.options.map((option) => [option.label, option.keys, option.isReturnDefault, option.isSessionWide]);

describe("agy's folder trust question", () => {
  it("is read whole at its own width (119): the two choices, the marked one Return, the other the arrow then Return", () => {
    const match = agy(trust);
    expect(match.kind).toBe("agyTrust");
    expect(match.question).toBe("Do you trust the contents of this project?");
    expect(match.context).toEqual({ type: "file", name: "/tmp/demo/sample-folder/work2" });
    expect(optionsOf(match)).toEqual([
      ["Yes, I trust this folder", ["Enter"], true, false],
      ["No, exit", ["Down", "Enter"], false, false],
    ]);
    expect(match.options[1]!.detail).toBe("Antigravity CLI quits");
    expect(match.fingerprint).toEqual({
      rules: 2,
      paneID: "w1:p1",
      question: "Do you trust the contents of this project?",
      body: ["Accessing workspace:", "/tmp/demo/sample-folder/work2", "Antigravity CLI requires permission to read, edit, and execute files here."],
      options: ["Yes, I trust this folder", "No, exit"],
      // Each part as the one text it stands for (the path's rows joined with nothing, its edge known).
      words: {
        question: "Do you trust the contents of this project?",
        body: "Accessing workspace:\n/tmp/demo/sample-folder/work2\nAntigravity CLI requires permission to read, edit, and execute files here.",
        options: "Yes, I trust this folder\nNo, exit",
      },
    });
  });

  it("is the same question redrawn at 80 and 160 columns, and with a path wrapped over two rows", () => {
    for (const width of [80, 119, 160]) expect(agy(trustAt(width)).fingerprint).toEqual(agy(trust).fingerprint);
    const long = `/tmp/demo/${"deep/".repeat(18)}folder`;
    expect(agy(trustAt(80, long)).context).toEqual({ type: "file", name: long });
  });

  it("with the marker on No: Return answers No, the arrow Up reaches Yes; the fingerprint does not hold the marker, it holds the folder", () => {
    const moved = agy(trustAt(119, undefined, 1));
    expect(optionsOf(moved)).toEqual([
      ["Yes, I trust this folder", ["Up", "Enter"], false, false],
      ["No, exit", ["Enter"], true, false],
    ]);
    expect(sameFingerprint(moved.fingerprint, agy(trust).fingerprint)).toBe(true);
    expect(sameFingerprint(agy(trustAt(119, "/tmp/demo/other")).fingerprint, agy(trust).fingerprint)).toBe(false);
  });

  it("near misses stay unmatched: no footer, two markers, no marker, other words, a third row, the words quoted above another screen", () => {
    expect(unmatched(replaceRow(trust, "  ↑/↓ Navigate · enter Confirm", ""))).toBe(true);
    expect(unmatched(replaceRow(trust, "  No, exit", "> No, exit"))).toBe(true);
    expect(unmatched(replaceRow(trust, "> Yes, I trust this folder", "  Yes, I trust this folder"))).toBe(true);
    expect(unmatched(replaceRow(trust, "  No, exit", "  No, go back"))).toBe(true);
    expect(unmatched(replaceRow(trust, "  No, exit", "  No, exit\n  Maybe"))).toBe(true);
    expect(unmatched(replaceRow(trust, "Accessing workspace:", "Accessing a workspace:"))).toBe(true);
    // The question printed as output (a `cat` of a saved screen), then agy's own idle screen under it.
    const idle = ["─".repeat(119), "> ", "─".repeat(119), rightAligned("? for shortcuts", "auto · Gemini 4 Hydrogen · low", 119)].join("\n");
    expect(unmatched(`${trust}\n${idle}`)).toBe(true);
  });

  it("is agy's alone: under Codex, Grok, Cursor, Gemini CLI, Claude or no kind it is not a trust card, and no start screen answers it", () => {
    for (const kind of ["codex", "grok", "cursor", "gemini", "claude", null]) expect(readingMatch(matchPrompt(trust, "w1:p1", kind))?.kind).not.toBe("agyTrust");
    expect(readStartScreen(trust, "agy")).toBeNull();
  });
});

describe("agy's permission questions (a command, a new file, an edit)", () => {
  it("the command question at its own width: four choices by digit, the command, the settings.json choice in full", () => {
    const match = agy(commandAsk);
    expect(match.kind).toBe("agyAsk");
    expect(match.question).toBe("Run this command?");
    expect(match.context).toEqual({ type: "command", text: "date" });
    expect(optionsOf(match)).toEqual([
      ["Yes, run command", ["1"], true, false],
      ["Yes, and always allow in this conversation for commands that start with 'date'", ["2"], false, true],
      ["Yes, and always allow for commands that start with 'date' (Persist to settings.json)", ["3"], false, true],
      ["No, cancel", ["4"], false, false],
    ]);
    // Every row between the rule and the question as read, blank rows kept.
    expect(match.fingerprint.body).toEqual(["Command", "", "Requesting permission for:", "   date", ""]);
  });

  it("the file questions at their own width: the path, its counts, the diff, two choices by digit", () => {
    const create = agy(createAsk);
    expect([create.question, create.context]).toEqual(["Allow creation of this file?", { type: "file", name: `${work}/ask.txt` }]);
    expect(optionsOf(create)).toEqual([
      ["Yes, allow creation", ["1"], true, false],
      ["No, deny creation", ["2"], false, false],
    ]);
    const edit = agy(editAsk);
    expect([edit.question, edit.context]).toEqual(["Accept this file edit?", { type: "diff", added: 1, removed: 1 }]);
    expect(optionsOf(edit)).toEqual([
      ["Yes, accept this change", ["1"], true, false],
      ["No, reject this change", ["2"], false, false],
    ]);
    expect(edit.fingerprint.body).toEqual(["Pending edit", "", `${work}/notes.txt  +1 -1`, "  1  -  alpha", "  1  +  ALPHA", "", "  shift+tab to auto-approve file edits"]);
  });

  it("each redrawn at 80 and 160 columns is the same question with the same choices (a wrapped choice joined)", () => {
    for (const [name, sample] of Object.entries(asks)) {
      for (const width of [80, 160]) {
        const redrawn = askAt(sample, width);
        if (name === "command" && width === 80) expect(redrawn).toContain("\n     'date'");
        const match = agy(redrawn);
        expect([match.question, match.context, optionsOf(match)], `${name} at ${width}`).toEqual([agy(sample).question, agy(sample).context, optionsOf(agy(sample))]);
      }
    }
  });

  it("near misses stay unmatched: no footer, two markers, no marker, a fifth choice, another kind's reader, the words above a screen that goes on", () => {
    for (const sample of Object.values(asks)) {
      const footer = lines(sample).find((row) => row.startsWith("  ↑/↓ Navigate"))!;
      expect(unmatched(replaceRow(sample, footer, ""))).toBe(true);
      const second = lines(sample).find((row) => row.startsWith("  2. "))!;
      expect(unmatched(replaceRow(sample, second, `>${second.slice(1)}`))).toBe(true);
      const first = lines(sample).find((row) => row.startsWith("> 1. "))!;
      expect(unmatched(replaceRow(sample, first, ` ${first.slice(1)}`))).toBe(true);
      for (const kind of ["claude", "codex", "grok", "cursor", "gemini", null]) expect(readingMatch(matchPrompt(sample, "w1:p1", kind))?.kind).not.toBe("agyAsk");
      const idle = ["─".repeat(201), "> ", "─".repeat(201), rightAligned("? for shortcuts", "auto · Gemini 4 Hydrogen · low", 201)].join("\n");
      expect(unmatched(`${sample}${idle}`)).toBe(true);
    }
    expect(unmatched(replaceRow(commandAsk, "  4. No, cancel", "  4. No, cancel\n  5. Something else"))).toBe(true);
    expect(unmatched(replaceRow(createAsk, "  2. No, deny creation", "  2. No, deny creation\n  3. Maybe"))).toBe(true);
    expect(unmatched(replaceRow(commandAsk, "Run this command?", "Run these commands?"))).toBe(true);
    expect(unmatched(replaceRow(createAsk, "  ↑/↓ Navigate · f full diff", "  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command"))).toBe(true);
  });

  it("the fingerprint holds the title, the body and the choices, not the marker", () => {
    const moved = replaceRow(replaceRow(commandAsk, "> 1. Yes, run command", "  1. Yes, run command"), "  4. No, cancel", "> 4. No, cancel");
    expect(sameFingerprint(agy(moved).fingerprint, agy(commandAsk).fingerprint)).toBe(true);
    expect(sameFingerprint(agy(commandAsk.replaceAll("'date'", "'ls'").replace("   date\n", "   ls\n")).fingerprint, agy(commandAsk).fingerprint)).toBe(false);
  });
});

describe("the four cards", () => {
  it("trust: the folder, its two choices, No said to quit agy, Answer in Terminal beside them", () => {
    const card = cardContent(agy(trust), "agy");
    expect([card.kind, card.header, card.target, card.question, card.returnIndex, card.ownAnswer]).toEqual([
      "trust",
      "Antigravity CLI asks to trust this folder",
      "/tmp/demo/sample-folder/work2",
      "Do you trust the contents of this project?",
      0,
      null,
    ]);
    expect(card.options.map((option) => [option.label, option.detail ?? null])).toEqual([
      ["Yes, I trust this folder", null],
      ["No, exit", "Antigravity CLI quits"],
    ]);
  });

  it("command: the command, four choices, the settings.json label whole; Amend is the Terminal's", () => {
    const card = cardContent(agy(commandAsk), "agy");
    expect([card.kind, card.header, card.target, card.ownAnswer]).toEqual(["run", "Antigravity CLI wants to run", "date", agyCommandLine]);
    expect(card.options.map((option) => option.label)).toContain("Yes, and always allow for commands that start with 'date' (Persist to settings.json)");
    expect(JSON.stringify(card)).not.toMatch(/Amend|ctrl\+g|full diff/u);
  });

  it("create and edit: the path, the diff rows as a diff, the hint left out; the full diff is the Terminal's", () => {
    const create = cardContent(agy(createAsk), "agy");
    expect([create.kind, create.header, create.target, create.lines, create.ownAnswer]).toEqual([
      "create",
      "Antigravity CLI wants to create",
      `${work}/ask.txt`,
      [{ kind: "added", number: "1", text: "hello" }],
      agyFileLine,
    ]);
    const edit = cardContent(agy(editAsk), "agy");
    expect([edit.kind, edit.header, edit.target, edit.lines, edit.ownAnswer]).toEqual([
      "edit",
      "Antigravity CLI wants to edit",
      `${work}/notes.txt`,
      [
        { kind: "removed", number: "1", text: "alpha" },
        { kind: "added", number: "1", text: "ALPHA" },
      ],
      agyFileLine,
    ]);
    expect(JSON.stringify([create, edit])).not.toMatch(/shift\+tab|full diff ·|f full diff/u);
  });
});

describe("answering from the card", () => {
  /** The pane's screens in turn (the last one stays), every key sent, no wait between reads. */
  function pane(...screens: string[]): { io: PaneIO; sent: string[][]; reads: () => number } {
    const sent: string[][] = [];
    let reads = 0;
    return {
      sent,
      reads: () => reads,
      io: {
        read: async () => {
          reads += 1;
          return screens.length > 1 ? screens.shift()! : screens[0]!;
        },
        sendKeys: async (keys) => void sent.push([...keys]),
        sleep: async () => undefined,
      },
    };
  }

  it("the marked trust row: Return alone, after the re-read", async () => {
    const match = agy(trust);
    const fake = pane(trust);
    expect(await answerPrompt(fake.io, match.options[0]!, match)).toEqual({ type: "sent" });
    expect(fake.sent).toEqual([["Enter"]]);
  });

  it("the other trust row: the arrow, then Return only once a fresh read shows the marker there", async () => {
    const match = agy(trust);
    const fake = pane(trust, trust, trustAt(119, undefined, 1));
    expect(await answerPrompt(fake.io, match.options[1]!, match)).toEqual({ type: "sent" });
    expect(fake.sent).toEqual([["Down"], ["Enter"]]);
    expect(fake.reads()).toBe(3);
  });

  it("refused: a re-read showing another question sends nothing; after the arrow, another folder, no question or a marker that never moves sends no Return", async () => {
    const match = agy(trust);
    const before = pane(trustAt(119, "/tmp/demo/other"));
    expect((await answerPrompt(before.io, match.options[1]!, match)).type).toBe("changed");
    expect(before.sent).toEqual([]);
    for (const after of [trustAt(119, "/tmp/demo/other", 1), "Goodbye.\n", trust]) {
      const fake = pane(trust, after);
      expect((await answerPrompt(fake.io, match.options[1]!, match)).type).toBe("unsettled");
      expect(fake.sent).toEqual([["Down"]]);
    }
  });

  it("the gate asked again before Return: closed after the arrow, Return never goes", async () => {
    const match = agy(trust);
    const fake = pane(trust, trustAt(119, undefined, 1));
    let asked = 0;
    expect((await answerPrompt(fake.io, match.options[1]!, match, () => (asked += 1) === 1)).type).toBe("unsettled");
    expect(fake.sent).toEqual([["Down"]]);
    expect(asked).toBe(2);
  });

  it("a permission question: the choice's digit alone, under the same re-read", async () => {
    for (const [sample, index, key] of [
      [commandAsk, 2, "3"],
      [createAsk, 1, "2"],
      [editAsk, 0, "1"],
    ] as const) {
      const match = agy(sample);
      const fake = pane(sample);
      expect(await answerPrompt(fake.io, match.options[index]!, match)).toEqual({ type: "sent" });
      expect(fake.sent).toEqual([[key]]);
      const changed = pane(askAt(editAsk.replace("  1  +  ALPHA", "  1  +  OMEGA"), 160));
      if (sample !== editAsk) continue;
      expect((await answerPrompt(changed.io, match.options[0]!, match)).type).toBe("changed");
      expect(changed.sent).toEqual([]);
    }
  });
});

describe("the quiet rule on an agy pane", () => {
  it("a whole question, or its footer alone, is prompt-like; agy's idle screen is not", () => {
    for (const sample of [trust, commandAsk, createAsk, editAsk]) expect(promptLike(sample, "agy")).toBe(true);
    expect(agyTrace("  ↑/↓ Navigate · f full diff\nesc to cancel")).toBe(true);
    const idle = ["─".repeat(80), "> ", "─".repeat(80), rightAligned("? for shortcuts", "auto · Gemini 4 Hydrogen · low", 80)].join("\n");
    expect(promptLike(idle, "agy")).toBe(false);
    expect(agyQuestion(idle, "w1:p1")).toBeNull();
  });
});

// An answer goes only to the question exactly as it was drawn.
describe("an answer is bound to the question exactly as drawn", () => {
  /** answerPrompt for `shown`'s first choice while the pane now shows `now`: what went. */
  async function answerWhile(shown: string, now: string): Promise<[string, string[][]]> {
    const match = agy(shown);
    const sent: string[][] = [];
    const outcome = await answerPrompt({ read: async () => now, sendKeys: async (keys) => void sent.push([...keys]) }, match.options[0]!, match);
    return [outcome.type, sent];
  }

  // The same-question rule (rows of nothing but blanks, and blanks at a row's end, do not count):
  // these were another question before it; a blank inside a row still is.
  it("a command that differs only by a blank row, or by spaces at a row's end, is the same question; a blank inside a row is not", async () => {
    const one = commandAsk.replaceAll("'date'", "'printf'").replace("   date\n", "   printf '%s' 'one\n   \n   two'\n");
    const two = one.replace("'one\n   \n   two'", "'one\n   two'");
    expect(agy(one).context).toEqual({ type: "command", text: "printf '%s' 'one\n\ntwo'" });
    expect(sameFingerprint(agy(one).fingerprint, agy(two).fingerprint)).toBe(true);
    expect(await answerWhile(one, two)).toEqual(["sent", [["1"]]]);
    const spaced = commandAsk.replace("   date\n", "   date  \n");
    expect(sameFingerprint(agy(spaced).fingerprint, agy(commandAsk).fingerprint)).toBe(true);
    expect(await answerWhile(commandAsk, spaced)).toEqual(["sent", [["1"]]]);
    // A blank inside the row: another command, nothing sent.
    const inner = one.replace("printf '%s' 'one", "printf  '%s' 'one");
    expect(sameFingerprint(agy(one).fingerprint, agy(inner).fingerprint)).toBe(false);
    expect(await answerWhile(one, inner)).toEqual(["changed", []]);
    // The same screen read again is the same question.
    expect(await answerWhile(one, one)).toEqual(["sent", [["1"]]]);
  });

  it("a folder path with a space at a row's edge cannot be told from padding: unmatched, and an answer for the plain path sends nothing", async () => {
    const trailing = trust.replace("/tmp/demo/sample-folder/work2\n", "/tmp/demo/sample-folder/work2 \n");
    const leading = trust.replace("/tmp/demo/sample-folder/work2\n", " /tmp/demo/sample-folder/work2\n");
    expect(unmatched(trailing)).toBe(true);
    expect(unmatched(leading)).toBe(true);
    expect(await answerWhile(trust, trailing)).toEqual(["changed", []]);
  });

  it("a wrapped path is read only when it wraps at the screen's right edge; its rows as read are in the fingerprint", () => {
    const long = `/tmp/demo/${"deep/".repeat(18)}folder`;
    const atEdge = agy(trustAt(80, long));
    expect(atEdge.fingerprint.body).toEqual(["Accessing workspace:", long.slice(0, 80), long.slice(80), "Antigravity CLI requires permission to read, edit, and execute files here."]);
    // The same path wrapped one cell short of the edge could be two names joined or one: unmatched.
    const short = trustAt(80, long).replace(`${long.slice(0, 80)}\n${long.slice(80)}`, `${long.slice(0, 79)}\n${long.slice(79)}`);
    expect(unmatched(short)).toBe(true);
    // A space inside the path stays part of it.
    expect(agy(trust.replace("sample-folder/work2", "sample folder/work2")).context).toEqual({ type: "file", name: "/tmp/demo/sample folder/work2" });
  });

  it("the four samples still match with the same options and keys", () => {
    expect([trust, commandAsk, createAsk, editAsk].map((sample) => [agy(sample).kind, agy(sample).options.map((option) => [option.key, option.keys])])).toEqual([
      ["agyTrust", [["1", ["Enter"]], ["2", ["Down", "Enter"]]]],
      ["agyAsk", [["1", ["1"]], ["2", ["2"]], ["3", ["3"]], ["4", ["4"]]]],
      ["agyAsk", [["1", ["1"]], ["2", ["2"]]]],
      ["agyAsk", [["1", ["1"]], ["2", ["2"]]]],
    ]);
  });
});

describe("on an agy pane only agy's reader reads", () => {
  const bareCancel = (text: string): string => text.replace(/^esc to cancel.*$/mu, "esc to cancel");
  const noFooter = (text: string): string => lines(text).filter((row) => !row.includes("↑/↓ Navigate")).join("\n") + "\n";

  it("with the model words at the cancel row's right and without: no footer, no marker, two markers or other words is unmatched, never a menu", async () => {
    for (const sample of [commandAsk, createAsk, editAsk]) {
      for (const shape of [sample, bareCancel(sample)]) {
        expect(agy(shape).kind).toBe("agyAsk");
        for (const bad of [noFooter(shape), shape.replace("> 1.", "  1."), shape.replace("  2.", "> 2."), shape.replace("Yes,", "Perhaps,")]) {
          const reading = matchPrompt(bad, "w1:p1", "agy");
          expect(reading.type).toBe("unmatched");
          const sent: string[][] = [];
          const outcome = await answerPrompt({ read: async () => bad, sendKeys: async (keys) => void sent.push([...keys]) }, agy(shape).options[0]!, agy(shape));
          expect([outcome.type, sent]).toEqual(["changed", []]);
        }
      }
    }
  });

  it("the unmatched card still shows the screen's last rows", () => {
    const reading = matchPrompt(noFooter(bareCancel(commandAsk)), "w1:p1", "agy");
    expect(reading.type === "unmatched" && reading.lines.length > 0).toBe(true);
  });

  it("other kinds keep what they had: the footerless frame is still the general reader's menu with no kind", () => {
    expect(readingMatch(matchPrompt(noFooter(bareCancel(commandAsk)), "w1:p1", null))?.kind).toBe("menu");
  });
});

describe("a grant that lasts is never the agy command card's first selection", () => {
  it("the terminal's marker on 2 or 3: the card starts on 1; on 4: on 4", () => {
    for (const [digit, first] of [
      ["2", 0],
      ["3", 0],
      ["4", 3],
    ] as const) {
      const moved = commandAsk.replace("> 1.", "  1.").replace(`  ${digit}.`, `> ${digit}.`);
      const card = cardContent(agy(moved), "agy");
      expect(card.returnIndex).toBe(first);
      expect(card.options[card.returnIndex]!.isSessionWide).toBe(false);
    }
  });
});
