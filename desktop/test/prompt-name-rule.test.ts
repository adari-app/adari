// A Claude Code session that has a name draws a rule carrying that name
// under its dialogs (seen 2026-11-15: the footer
// "Esc to cancel · Tab to amend", a plain rule, then `──── pt-dec-seeds ─`).
// The name rule is one more row allowed under Claude's own footers, in all
// three readers (the menu and yes/no frames, the tall dialog's cut frame, the
// question dialog): such a screen reads exactly as the same screen without the
// row. Everywhere else the row is what it was: neither a border nor part of a
// frame, so every other screen stays as it was.
//
// The rule's shape is a recorded sample of a named Claude Code 2.1.325
// pane (119 cells: `─` × 88, a space, `invoice-export-cleanup-tests`, a space,
// one `─`). The Swift twin: Tests/HerdrCompanionTests/CompanionNameRuleTests.swift.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { answerPrompt, type PaneIO } from "../src/shared/prompt/answerer";
import { matchPrompt, needsTallRead, readingCut, readingMatch, type PromptMatch, type PromptReading } from "../src/shared/prompt/matcher";
import { promptLike } from "../src/shared/prompt/quiet";
import { A, C, F, G, L, lastLines } from "./support/prompt-fixtures";
import { repoRoot } from "./support/swift-fixtures";
import { heredoc, tail, tallBash, yesAlwaysNo, yesNo } from "./support/tall-prompts";

const pane = "w1:p1";

/** The name rule as Claude Code draws it `width` cells wide: the rule, a space, the name, a space, one more `─`. */
function nameRule(label: string, width: number): string {
  return `${"─".repeat(width - [...label].length - 3)} ${label} ─`;
}

function plainRule(width: number): string {
  return "─".repeat(width);
}

/** The sample's own row, exactly as read (119 cells). */
const sampleRow = `${"─".repeat(88)} invoice-export-cleanup-tests ─`;

/** The longest name the readers take (64 code points), and one past it. */
const longest = `worker-${"x".repeat(57)}`;
const tooLong = `${longest}y`;

const labels = {
  short: "pt-dec-seeds",
  spaces: "pricing talk notes",
  marks: "v0.1.2-rc.3_build.42",
  longest,
};

/** What may follow Claude's footer on a named session's screen (the screenshot's first). */
function layouts(label: string, width: number): (readonly string[])[] {
  const name = nameRule(label, width);
  const rule = plainRule(width);
  return [[rule, name], [name], ["", name], [name, rule], ["", rule, name, ""], [rule, "", name, "", ""]];
}

/** `screen` with `under` drawn under its last row. */
function under(screen: string, rows: readonly string[]): string {
  return [screen.replace(/\n$/u, ""), ...rows].join("\n");
}

function read(text: string, kind: string | null = "claude"): PromptReading {
  return matchPrompt(text, pane, kind);
}

function matched(text: string, kind: string | null = "claude"): PromptMatch {
  const match = readingMatch(read(text, kind));
  if (match === null) throw new Error(`not matched:\n${text.split("\n").slice(-12).join("\n")}`);
  return match;
}

/** The question dialog at `width`, built from the recorded one (A.sample). */
function askDialog(width: number): string {
  return [
    "● The pricing notes cover the Mac app only.",
    "",
    plainRule(width),
    " ☐ Q95",
    "",
    "Q95: what should Z research next for the earning talk?",
    "",
    "❯ 1. Teams and T3 gaps (Recommended)",
    "     What teams pay for in this category.",
    "  2. Phone pricing only",
    "     Moshi and the SSH apps in detail.",
    "  3. Type something.",
    plainRule(width),
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
}

/** Every Claude frame a named session may show, each matched without the rule, by name and width. */
function frames(): { readonly name: string; readonly screen: string; readonly width: number; readonly kind: string }[] {
  const list: { name: string; screen: string; width: number; kind: string }[] = [];
  for (const width of [80, 160]) {
    list.push({ name: `yes/no frame at ${width}`, screen: tallBash(heredoc(3), yesNo, 0, width), width, kind: "menu" });
    list.push({ name: `Bash frame, three options, at ${width}`, screen: tallBash(heredoc(5), yesAlwaysNo, 1, width), width, kind: "menu" });
    list.push({ name: `question dialog at ${width}`, screen: askDialog(width), width, kind: "claudeAsk" });
  }
  list.push({ name: "live Bash frame (131)", screen: L.claude2_1_303Bash, width: 131, kind: "menu" });
  list.push({ name: "live named Bash frame (131)", screen: L.claude2_1_303NamedBash, width: 131, kind: "menu" });
  list.push({ name: "live Write permission menu (131)", screen: L.claude2_1_303Write, width: 131, kind: "menu" });
  list.push({ name: "live narrow Bash frame (54)", screen: L.claude2_1_303Narrow54Bash, width: 54, kind: "menu" });
  list.push({ name: "recorded question dialog (201)", screen: A.full, width: 201, kind: "claudeAsk" });
  list.push({ name: "recorded question dialog (80)", screen: A.narrow, width: 80, kind: "claudeAsk" });
  return list;
}

describe("a named session's Claude frame reads as the same frame without the name rule", () => {
  for (const frame of frames()) {
    it(`${frame.name}: every name, every layout, Claude's pane and an unknown one`, () => {
      for (const kind of ["claude", null]) {
        const plain = read(lastLines(frame.screen), kind);
        expect(readingMatch(plain)?.kind).toBe(frame.kind);
        const fitting = Object.values(labels).filter((label) => [...label].length + 7 <= frame.width);
        for (const label of fitting) {
          for (const rows of layouts(label, frame.width)) {
            expect(read(lastLines(under(frame.screen, rows)), kind), `${label} ${JSON.stringify(rows.map((row) => row.length))}`).toEqual(plain);
          }
        }
      }
    });
  }

  it("the screenshot's case: 1. Yes / 2. No, a plain rule and the sample's own name rule (119 cells)", () => {
    const screen = tallBash(heredoc(3), yesNo, 0, 119);
    const named = matched(under(screen, [plainRule(119), sampleRow]));
    expect(named).toEqual(matched(screen));
    expect(named.question).toBe("Do you want to proceed?");
    expect(named.options.map((option) => [option.key, option.label, option.keys])).toEqual([
      ["1", "Yes", ["1"]],
      ["2", "No", ["2"]],
    ]);
  });

  it("the question dialog under the sample's own name rule", () => {
    const named = matched(under(askDialog(119), [plainRule(119), sampleRow]));
    expect(named).toEqual(matched(askDialog(119)));
    expect(named.kind).toBe("claudeAsk");
    expect(named.options.map((option) => option.keys)).toEqual([["1"], ["2"]]);
  });
});

describe("the tall dialog: a cut frame under the name rule asks for the taller read, and reads whole there", () => {
  for (const width of [80, 160]) {
    it(`a 60-line command at ${width}`, () => {
      const screen = tallBash(heredoc(60), yesNo, 0, width);
      const plainCut = readingCut(read(tail(screen, 40)));
      expect(plainCut).not.toBeNull();
      for (const label of Object.values(labels)) {
        // A layout ending in blank rows makes the 40-row text one row short (a short read holds the whole pane).
        for (const rows of layouts(label, width).filter((layout) => layout.at(-1) !== "")) {
          const named = under(screen, rows);
          const first = tail(named, 40);
          expect(needsTallRead(first, "claude")).toBe(true);
          const cut = readingCut(read(first));
          expect(cut?.question).toBe(plainCut!.question);
          // The read starts lower by the rows under the footer; the card's rows are the same.
          expect(cut?.lines).toEqual(plainCut!.lines);
          expect(cut?.rows).toEqual(plainCut!.rows.slice(plainCut!.rows.length - cut!.rows.length));
          expect(cut?.rows.at(-1)).toBe("EOF");
          expect(read(tail(named, 200))).toEqual(read(tail(screen, 200)));
        }
      }
    });
  }

  it("the cut frame's card rows never show the name rule", () => {
    const screen = tallBash(heredoc(60), yesNo, 0, 131);
    const cut = readingCut(read(tail(under(screen, [plainRule(131), nameRule("pt-dec-seeds", 131)]), 40)));
    expect(cut?.lines).toEqual(["Do you want to proceed?", "❯ 1. Yes", "2. No", "Esc to cancel · Tab to amend"]);
  });
});

describe("nowhere else: the name rule outside Claude's footers leaves every screen as it was", () => {
  const label = "pt-dec-seeds";
  const yesNoFrame = tallBash(heredoc(3), yesNo, 0, 80);

  function unmatched(text: string, kind: string | null = "claude"): void {
    expect(read(text, kind).type, text.split("\n").slice(-3).join("\n")).toBe("unmatched");
  }

  it("under a Codex frame, a Codex form, a Grok frame, a [y/N] line and a bare Grok menu", () => {
    for (const kind of ["codex", "claude", null]) unmatched(under(F.codexCommand, [nameRule(label, 80)]), kind);
    unmatched(under(C.four, [nameRule(label, 80)]), "codex");
    for (const kind of ["grok", null]) unmatched(under(G.approval, [nameRule(label, 80)]), kind);
    unmatched(under(F.grokMenu, [nameRule(label, 80)]), "grok");
    unmatched(under(F.codexYesNo, [nameRule(label, 80)]), "codex");
    unmatched(under(F.defaultYes, [plainRule(80), nameRule(label, 80)]), null);
  });

  it("under a boxed menu, with or without Claude's footer under the box", () => {
    unmatched(under(F.claudeEdit, [plainRule(80), nameRule(label, 80)]));
    const footed = under(F.claudeEdit, ["", " Esc to cancel · Tab to amend"]);
    expect(readingMatch(read(footed))?.kind).toBe("menu");
    unmatched(under(footed, [plainRule(80), nameRule(label, 80)]));
  });

  it("under another footer (Esc to cancel alone)", () => {
    expect(readingMatch(read(F.claudeBash))?.kind).toBe("menu");
    unmatched(under(F.claudeBash, [plainRule(80), nameRule(label, 80)]));
  });

  it("above the footer, between two options, twice, or followed by text", () => {
    const rows = yesNoFrame.split("\n");
    const footer = rows.length - 1;
    const above = [...rows.slice(0, footer), nameRule(label, 80), ...rows.slice(footer)].join("\n");
    unmatched(above);
    unmatched(under(above, [plainRule(80)]));
    const between = rows.map((row) => (row === "   2. No" ? `${nameRule(label, 80)}\n${row}` : row)).join("\n");
    expect(between).not.toBe(yesNoFrame);
    unmatched(between);
    unmatched(under(yesNoFrame, [nameRule(label, 80), nameRule(label, 80)]));
    unmatched(under(yesNoFrame, [nameRule(label, 80), plainRule(80), nameRule("other", 80)]));
    unmatched(under(yesNoFrame, [plainRule(80), nameRule(label, 80), "  Opus 5.5 | 7% ctx | desktop"]));
    unmatched(under(yesNoFrame, [nameRule(label, 80), "❯"]));
    unmatched(under(yesNoFrame, [nameRule(label, 80), "╰────╯"]));
  });

  it("the question dialog: above its footer, twice, followed by text", () => {
    const rows = askDialog(80).split("\n");
    const footer = rows.length - 1;
    unmatched([...rows.slice(0, footer), nameRule(label, 80), ...rows.slice(footer)].join("\n"));
    unmatched([...rows.slice(0, footer - 1), nameRule(label, 80), ...rows.slice(footer - 1)].join("\n"));
    unmatched(under(askDialog(80), [nameRule(label, 80), nameRule(label, 80)]));
    unmatched(under(askDialog(80), [nameRule(label, 80), "more output"]));
  });

  it("a row that only looks like it: the rule on one side, a rule character in the name, too long, a control character", () => {
    const lookalikes = [
      `${"─".repeat(60)} ${label}`,
      `${label} ${"─".repeat(60)}`,
      `─ ${label} ${"─".repeat(60)}`,
      `${"─".repeat(60)} ${label} ──`,
      `${"─".repeat(60)}  ${label} ─`,
      `${"─".repeat(60)} ${label}  ─`,
      `${"─".repeat(60)} pt─dec ─`,
      `${"─".repeat(60)} pt╌dec ─`,
      `${"─".repeat(60)} pt dec  seeds ─`,
      `${"─".repeat(3)} ${label} ─`,
      nameRule(tooLong, 80),
      nameRule("pt\u0007dec", 80),
      nameRule("pt\u200bdec", 80),
      `${"─".repeat(60)} ${label}\t─`,
      `${"━".repeat(60)} ${label} ━`,
      `${"═".repeat(60)} ${label} ═`,
      `${"-".repeat(60)} ${label} -`,
    ];
    for (const row of lookalikes) {
      unmatched(under(yesNoFrame, [plainRule(80), row]));
      unmatched(under(askDialog(80), [plainRule(80), row]));
      unmatched(tail(under(tallBash(heredoc(60), yesNo, 0, 80), [plainRule(80), row]), 40));
    }
  });

  it("printed output above the options holding such a row: matched as it always was, the row in the body", () => {
    const command = ["cd /tmp/probe; cat banner.txt", nameRule(label, 60), "EOF"];
    const screen = tallBash(command, yesNo, 0, 80);
    const match = matched(screen);
    expect(match.run?.rows).toEqual(command);
    expect(match.fingerprint.body).toContain(` ${nameRule(label, 60)}`);
  });

  it("the same frame with the name rule under its footer too: the same match, the body's row kept", () => {
    const command = ["cd /tmp/probe; cat banner.txt", nameRule(label, 60), "EOF"];
    const screen = tallBash(command, yesNo, 0, 80);
    expect(matched(under(screen, [plainRule(80), nameRule(label, 80)]))).toEqual(matched(screen));
  });
});

describe("the unmatched card: a trailing name rule is never one of its rows", () => {
  it("a Claude frame the app cannot read (options 1 and 3) shows the same rows with or without it", () => {
    const gap = tallBash(heredoc(3), yesNo, 0, 80).replace("   2. No", "   3. No");
    const plain = read(gap);
    expect(plain.type).toBe("unmatched");
    for (const rows of layouts("pt-dec-seeds", 80)) expect(read(under(gap, rows))).toEqual(plain);
  });

  it("a question dialog the app cannot read (two chips) shows the same rows with or without it", () => {
    const plain = read(A.twoChips);
    expect(plain.type).toBe("unmatched");
    expect(read(under(A.twoChips, [plainRule(201), nameRule("pt-dec-seeds", 201)]))).toEqual(plain);
  });
});

describe("the quiet rule: a named session's dialog is prompt-like, as it was", () => {
  it("prompt-like under the name rule, every frame", () => {
    for (const frame of frames()) expect(promptLike(under(frame.screen, [plainRule(frame.width), nameRule("pt-dec-seeds", frame.width)]), "claude")).toBe(true);
  });

  it("the sample's idle field is not", () => {
    const idle = [sampleRow, "❯", plainRule(119), "  Opus 5.5 | 7% ctx | desktop | invoice-export-cleanup-tests | v2.1.325", "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    expect(promptLike(idle, "claude")).toBe(false);
  });
});

/** A pane whose reads return `screens` in turn (the last one again), then the keys sent. */
class Pane {
  reads = 0;
  readonly sent: string[][] = [];
  constructor(private readonly screens: string[]) {}
  readonly io: PaneIO = {
    read: async () => {
      this.reads += 1;
      return this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
    },
    sendKeys: async (keys) => {
      this.sent.push([...keys]);
    },
    sleep: async () => undefined,
  };
}

describe("the answer: the option's own key, only while the fingerprint holds; the name is outside it", () => {
  const width = 80;
  const screen = tallBash(heredoc(3), yesNo, 0, width);
  const named = (label: string): string => under(screen, [plainRule(width), nameRule(label, width)]);

  it("the named frame's fingerprint is the unnamed frame's", () => {
    expect(matched(named("pt-dec-seeds")).fingerprint).toEqual(matched(screen).fingerprint);
  });

  it("sends the tapped option's digit once", async () => {
    const match = matched(named("pt-dec-seeds"));
    for (const key of ["1", "2"]) {
      const io = new Pane([named("pt-dec-seeds")]);
      expect(await answerPrompt(io.io, match.options.find((option) => option.key === key)!, match)).toEqual({ type: "sent" });
      expect(io.sent).toEqual([[key]]);
    }
  });

  it("renamed between the read and the answer (or the name rule drawn or gone): the same question, so the same key", async () => {
    const match = matched(named("pt-dec-seeds"));
    for (const now of [named("pt-dec-seeds-2"), named("renamed by hand"), screen]) {
      const io = new Pane([now]);
      expect(await answerPrompt(io.io, match.options[1]!, match)).toEqual({ type: "sent" });
      expect(io.sent).toEqual([["2"]]);
    }
    const fromPlain = matched(screen);
    const io = new Pane([named("pt-dec-seeds")]);
    expect(await answerPrompt(io.io, fromPlain.options[0]!, fromPlain)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["1"]]);
  });

  it("a changed question under the same name, or a name the reader does not take: nothing is sent", async () => {
    const match = matched(named("pt-dec-seeds"));
    const changed = [
      named("pt-dec-seeds").replace("Do you want to proceed?", "Do you want to proceed now?"),
      named("pt-dec-seeds").replace("   2. No", "   2. No, and stop"),
      named("pt-dec-seeds").replace("import json, pathlib", "import json, os"),
      named(tooLong),
      under(screen, [plainRule(width), nameRule("pt-dec-seeds", width), "more output"]),
    ];
    for (const now of changed) {
      expect(now).not.toBe(named("pt-dec-seeds"));
      const io = new Pane([now]);
      const outcome = await answerPrompt(io.io, match.options[0]!, match);
      expect(outcome.type).toBe("changed");
      expect(io.sent).toEqual([]);
    }
  });

  it("the question dialog: its digit, then reads until it goes; renamed meanwhile, the same digit", async () => {
    const ask = (label: string): string => under(askDialog(width), [plainRule(width), nameRule(label, width)]);
    const match = matched(ask("pt-dec-seeds"));
    expect(match.fingerprint).toEqual(matched(askDialog(width)).fingerprint);
    const idle = [nameRule("pt-dec-seeds", width), "❯", plainRule(width)].join("\n");
    for (const now of [ask("pt-dec-seeds"), ask("another name")]) {
      const io = new Pane([now, idle]);
      expect(await answerPrompt(io.io, match.options[1]!, match)).toEqual({ type: "sent" });
      expect(io.sent).toEqual([["2"]]);
    }
    const io = new Pane([ask("pt-dec-seeds").replace("Phone pricing only", "Phone pricing first"), idle]);
    expect((await answerPrompt(io.io, match.options[1]!, match)).type).toBe("changed");
    expect(io.sent).toEqual([]);
  });
});

// From a review: the rows under Claude's footer are read by one explicit rule on
// both apps (suffixRow: U+00A0 read as U+0020, then U+0020 removed at both edges, nothing else; the name rule
// covers the whole row). The table is shared with the Swift tests (CompanionNameRuleTests.swift): the review's
// 167 rows under a plain rule, and the same 32 scalars on a blank row and on a plain rule over a valid name rule.
// Its expected results come from the spec's rule (the round's evidence script), not from either app.

interface Vector {
  readonly id: string;
  readonly under: readonly string[];
  readonly reads: boolean;
}

const vectors = (
  JSON.parse(readFileSync(path.join(repoRoot, "Tests/HerdrCompanionTests/Fixtures/NameRule/name-rule-vectors.json"), "utf8")) as {
    vectors: Vector[];
  }
).vectors;

/** The review's ten screens on which the two apps disagreed (exact-unicode.log). */
const reviewDisagreements = [
  "space-000B-trailing/menu",
  "space-000C-trailing/menu",
  "space-000D-trailing/menu",
  "space-0085-trailing/menu",
  "space-0085-trailing/ask",
  "space-200B-leading/menu",
  "space-200B-trailing/menu",
  "space-2028-trailing/menu",
  "space-2029-trailing/menu",
  "space-FEFF-trailing/ask",
];

describe("the rows under Claude's footer read by one rule, the shared table", () => {
  const width = 119;
  const bases = { menu: tallBash(heredoc(3), yesNo, 0, width), ask: A.full };
  const valid = (base: string): string => under(base, [plainRule(width), nameRule("valid-name", width)]);

  it("the table holds the review's 167 rows and the 160 blank and plain-rule rows", () => {
    expect(vectors.length).toBe(327);
    expect(vectors.filter((vector) => vector.id.startsWith("blank-") || vector.id.startsWith("plain-")).length).toBe(160);
    for (const id of reviewDisagreements) expect(vectors.find((vector) => vector.id === id.split("/")[0])?.reads, id).toBe(false);
  });

  for (const [name, base] of Object.entries(bases)) {
    it(`under the ${name}: each row reads as the table says (as the frame without it, or unmatched)`, () => {
      const plain = read(base);
      expect(readingMatch(plain)).not.toBeNull();
      const wrong = vectors.filter((vector) => {
        const reading = read(under(base, vector.under));
        return vector.reads ? JSON.stringify(reading) !== JSON.stringify(plain) : reading.type !== "unmatched";
      });
      expect(wrong.map((vector) => vector.id)).toEqual([]);
    });

    it(`under the ${name}: the answer sends the digit only where the row reads`, async () => {
      const card = matched(valid(base));
      const idle = [nameRule("valid-name", width), "❯", plainRule(width)].join("\n");
      const wrong: string[] = [];
      for (const vector of vectors) {
        const io = new Pane([under(base, vector.under), idle]);
        const outcome = await answerPrompt(io.io, card.options[0]!, card);
        const sent = JSON.stringify(io.sent);
        if (vector.reads ? outcome.type !== "sent" || sent !== '[["1"]]' : outcome.type !== "changed" || sent !== "[]") wrong.push(vector.id);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("the review's ten screens: unmatched, and no key goes", async () => {
    for (const id of reviewDisagreements) {
      const [row, name] = id.split("/") as [string, "menu" | "ask"];
      const base = name === "menu" ? bases.menu : bases.ask;
      const vector = vectors.find((candidate) => candidate.id === row)!;
      const text = under(base, vector.under);
      expect(read(text).type, id).toBe("unmatched");
      const card = matched(valid(base));
      const io = new Pane([text]);
      expect((await answerPrompt(io.io, card.options[0]!, card)).type, id).toBe("changed");
      expect(io.sent, id).toEqual([]);
    }
  });

  it("ordinary padding still reads: spaces out to the pane's width, a leading margin, NBSP", () => {
    for (const base of Object.values(bases)) {
      const plain = read(base);
      const name = nameRule("pt-dec-seeds", 100);
      for (const rows of [
        [`${plainRule(width)}   `, `${name}${" ".repeat(19)}`],
        [plainRule(width), ` ${name}`],
        ["   ", `  ${name}  `, "  "],
        ["\u00A0", name.replace(/ /gu, "\u00A0")],
      ]) {
        expect(read(under(base, rows)), JSON.stringify(rows)).toEqual(plain);
      }
    }
  });
});
