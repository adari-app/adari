// Grok Build 1.0.70's approval frame as the Needs card. The frame is read on
// a Grok pane only; the card says Grok wants to run, the title and the command,
// and lists Grok's options in its order and words. An answer sends the option's
// digit, then reads: the frame gone, it took; anything else, nothing more
// (Answer in Terminal). The digit is the whole answer (a live check: `4` alone
// closed the frame); no Enter, no other key after it, ever. Any part of Grok's
// frame is prompt-like on a Grok pane only; Claude, Codex and Cursor panes go
// quiet and clear by their own rules.
// Same expected results as Tests/HerdrCompanionTests/CompanionGrokPromptTests.swift.

import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { answerPrompt, grokSettleReads, type PaneIO } from "../src/shared/prompt/answerer";
import { cardContent, cardKeyAction } from "../src/shared/prompt/card";
import { grokFrame, matchPrompt, readingMatch, sameFingerprint, type PromptMatch, type PromptReading } from "../src/shared/prompt/matcher";
import { afterRead, marked as quietMarked, promptLike } from "../src/shared/prompt/quiet";
import { needsCardShown } from "../src/renderer/chat/NeedsCard";
import type { PanePrompt } from "../src/shared/prompt/view";
import { F, G, L, Launch } from "./support/prompt-fixtures";

const pane = "w1:p1";
const words5 = [
  "Yes, and don't ask again for anything (always-approve mode)",
  "Always allow: /Users/filler/.cache/venv/bin/python /Users/demo/probe/filler/scrape_us.py probe",
  "Yes, proceed",
  "No, reject (type to add feedback)",
  "Never allow: /Users/filler/.cache/venv/bin/python /Users/demo/probe/filler/scrape_us.py",
];
const command = "/Users/filler/.cache/venv/bin/python /Users/demo/probe/filler/scrape_us.py probe";
const title = "Probe Tidbit Ad Library GraphQL scrape";

function grok(text: string): PromptMatch {
  const reading = matchPrompt(text, pane, "grok");
  const match = readingMatch(reading);
  if (match === null) throw new Error(`not matched: ${JSON.stringify(reading)}`);
  return match;
}

const marked = (match: PromptMatch): string[] => match.options.filter((option) => option.isReturnDefault).map((option) => option.key);

describe("Grok 1.0.70's approval frame", () => {
  it("the reference frame: Grok's title, command and five options in its order and words, 3 marked", () => {
    const match = grok(G.approval);
    expect(match.kind).toBe("grok");
    expect(match.question).toBe(title);
    expect(match.context).toEqual({ type: "command", text: command });
    expect(match.options.map((option) => option.key)).toEqual(["1", "2", "3", "4", "5"]);
    expect(match.options.map((option) => option.label)).toEqual(words5);
    expect(marked(match)).toEqual(["3"]);
    expect(match.options.map((option) => option.keys)).toEqual([["1"], ["2"], ["3"], ["4"], ["5"]]);
    // Always-approve keeps Grok's words; nothing is hidden. Session-wide: 1, 2 and 5.
    expect(match.options.filter((option) => option.isSessionWide).map((option) => option.key)).toEqual(["1", "2", "5"]);
    // Option 4 answers with no feedback: no option opens the box.
    expect(match.options.some((option) => option.opensComposer)).toBe(false);
  });

  it("the recorded frame (Grok 1.0.70, live): two spaces after the bar, a blank bar row on top, the footer cut at Esc", () => {
    const match = grok(G.liveApproval);
    expect(match.question).toBe("Print 1 with python3");
    expect(match.context).toEqual({ type: "command", text: "python3 -c 'print(1)'" });
    expect(match.options.map((option) => option.label)).toEqual([
      "Yes, and don't ask again for anything (always-approve mode)",
      "Always allow: python3 -c print(1)",
      "Yes, proceed",
      "No, reject (type to add feedback)",
      "Never allow: python3 -c",
    ]);
    expect(marked(match)).toEqual(["3"]);
    expect(cardContent(match, "grok")).toMatchObject({ header: "Grok Build wants to run", question: "Print 1 with python3", command: "python3 -c 'print(1)'" });
    // 0.3 s after `4` alone: no frame, nothing of it; then the turn cancelled.
    for (const after of [G.liveAfter4, G.liveCancelled]) {
      expect(grokFrame(after, pane)).toBeNull();
      expect(promptLike(after, "grok")).toBe(false);
    }
    expect(G.liveCancelled).toContain("Turn cancelled because a permission was denied");
  });

  it("each mark glyph: ○ ● and ◯ ◉ read the same; the fingerprint leaves the mark out", () => {
    const reference = grok(G.approval);
    const alt = grok(G.altGlyphs);
    expect(alt.options.map((option) => option.label)).toEqual(words5);
    expect(marked(alt)).toEqual(["3"]);
    expect(sameFingerprint(alt.fingerprint, reference.fingerprint)).toBe(true);
    const one = grok(G.marked1);
    const four = grok(G.marked4);
    expect(marked(one)).toEqual(["1"]);
    expect(marked(four)).toEqual(["4"]);
    expect(sameFingerprint(one.fingerprint, reference.fingerprint)).toBe(true);
    expect(sameFingerprint(four.fingerprint, reference.fingerprint)).toBe(true);
    // Another title and command is another question.
    expect(sameFingerprint(grok(G.second).fingerprint, reference.fingerprint)).toBe(false);
  });

  it("wrapped command rows (under │, or plain) and wrapped options read whole", () => {
    for (const text of [G.wrapped, G.wrappedPlain]) {
      const match = grok(text);
      expect(match.question).toBe(title);
      expect(match.context).toEqual({ type: "command", text: "/Users/filler/.cache/venv/bin/python /Users/demo/probe/fil\nler/scrape_us.py probe" });
      expect(match.options.map((option) => option.key)).toEqual(["1", "2", "3", "4", "5"]);
      expect(match.options[0]!.label).toBe("Yes, and don't ask again for anything (always-approve mode)");
      expect(match.options[1]!.label).toBe("Always allow: /Users/filler/.cache/venv/bin/python /Users/ demo/probe/filler/scrape_us.py probe");
      expect(match.options[4]!.label).toBe("Never allow: /Users/filler/.cache/venv/bin/python /Users/d emo/probe/filler/scrape_us.py");
      expect(marked(match)).toEqual(["3"]);
    }
    expect(sameFingerprint(grok(G.wrapped).fingerprint, grok(G.wrappedPlain).fingerprint)).toBe(false);
  });

  it("n = 3: three options, no scope hint, 2 marked", () => {
    const match = grok(G.three);
    expect(match.question).toBe("Clear the probe's scratch output");
    expect(match.context).toEqual({ type: "command", text: "trash /Users/demo/probe/filler/out" });
    expect(match.options.map((option) => [option.key, option.label])).toEqual([
      ["1", "Yes, and don't ask again for anything (always-approve mode)"],
      ["2", "Yes, proceed"],
      ["3", "No, reject (type to add feedback)"],
    ]);
    expect(marked(match)).toEqual(["2"]);
  });

  it("a frame partly drawn (no footer yet) is not matched, but is prompt-like", () => {
    expect(matchPrompt(G.partial, pane, "grok").type).toBe("unmatched");
    expect(grokFrame(G.partial, pane)).toBeNull();
    expect(promptLike(G.partial, "grok")).toBe(true);
  });

  it("a footer that does not count the options, or a frame cut at the top of a full read, is not matched", () => {
    expect(grokFrame(G.approval.replace("1/5:select", "1/4:select"), pane)).toBeNull();
    const rows = G.approval.split("\n");
    const cut = rows.slice(rows.findIndex((row) => row.startsWith("┃ │"))).join("\n");
    expect(cut.split("\n").length).toBeLessThan(40);
    expect(grokFrame(cut, pane)).toBeNull();
  });

  it("read on a Grok pane only: no kind, Claude, Codex or Cursor leave it unmatched", () => {
    expect(matchPrompt(G.approval, pane, "grok").type).toBe("matched");
    expect(matchPrompt(G.approval, pane, "Grok").type).toBe("matched");
    for (const kind of [null, "claude", "codex", "cursor"]) expect(matchPrompt(G.approval, pane, kind).type).toBe("unmatched");
    expect(matchPrompt(G.approval, pane).type).toBe("unmatched");
  });

  it("Claude, Codex and Cursor prompts read exactly as before, on every kind (Grok 1.0.60's menu too)", () => {
    const screens = [F.claudeEdit, F.claudeBash, F.codexCommand, F.grokMenu, F.codexYesNo, F.defaultYes, F.working, F.unsupportedApproval, L.claude2_1_303Bash, L.claude2_1_303Write, L.claude2_1_303Trust, L.codex0_163_0Dialog, L.codex0_163_0Narrow51Dialog, Launch.paywallPrompt, Launch.relayPrompt];
    for (const text of screens) {
      const before = matchPrompt(text, pane);
      for (const kind of ["claude", "codex", "cursor", "grok", null]) expect(matchPrompt(text, pane, kind)).toEqual(before);
    }
    expect(matchPrompt(F.grokMenu, pane, "grok").type).toBe("matched");
  });

  it("a Grok pane with no prompt: no frame, nothing prompt-like, no card", () => {
    expect(matchPrompt(G.noPrompt, pane, "grok").type).toBe("unmatched");
    expect(promptLike(G.noPrompt, "grok")).toBe(false);
    expect(promptLike(G.after, "grok")).toBe(false);
    expect(promptLike(G.approval, "grok")).toBe(true);
    const prompt = (reading: PromptReading | null, quiet: boolean): PanePrompt => ({ hostId: "mac", paneId: pane, episode: "e", incarnation: 1, connection: 1, epoch: 1, reading, quiet, cleared: false });
    const row = { isAgent: true, status: "blocked" as const, kind: "grok" };
    expect(needsCardShown(row, prompt(matchPrompt(G.noPrompt, pane, "grok"), true))).toBe(false);
    expect(needsCardShown(row, prompt(matchPrompt(G.approval, pane, "grok"), false))).toBe(true);
    expect(needsCardShown(row, prompt(matchPrompt(G.partial, pane, "grok"), false))).toBe(true);
    expect(needsCardShown(row, prompt(null, false))).toBe(true);
    expect(needsCardShown(row, null)).toBe(true);
    // Claude and Codex keep theirs: an unmatched quiet read still shows the card until the mark clears.
    expect(needsCardShown({ ...row, kind: "claude" }, prompt(matchPrompt(G.noPrompt, pane, "claude"), true))).toBe(true);
    expect(needsCardShown({ ...row, status: "working" }, prompt(matchPrompt(G.approval, pane, "grok"), false))).toBe(false);
  });

  it("the card: Grok wants to run, the title, the command whole, Grok's options; its digits pick", () => {
    const content = cardContent(grok(G.approval), "grok");
    expect(content.kind).toBe("run");
    expect(content.header).toBe("Grok Build wants to run");
    expect(content.question).toBe(title);
    expect(content.command).toBe(command);
    expect(content.target).toBeNull();
    expect(content.options.map((option) => option.label)).toEqual(words5);
    expect(content.returnIndex).toBe(2);
    expect(content.tellOption).toBeNull();
    expect(cardKeyAction({ key: "5", textFocused: false }, content.options, 2)).toEqual({ type: "pick", index: 4 });
    expect(cardKeyAction({ key: "Enter", textFocused: false }, content.options, 2)).toEqual({ type: "pick", index: 2 });
    // Claude's and Codex's cards carry no command block.
    expect(cardContent(readingMatch(matchPrompt(L.codex0_163_0Dialog, pane))!, "codex").command).toBeNull();
  });
});

/** A pane whose screens the test scripts (each read takes the next; the last stays), every key kept, no waiting. */
class GrokPane {
  readonly sent: string[][] = [];
  reads = 0;
  constructor(
    private readonly screens: (string | Error)[],
    private readonly sendError: unknown = null,
  ) {}
  readonly io: PaneIO = {
    read: async () => {
      this.reads += 1;
      const next = this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    sendKeys: async (keys) => {
      this.sent.push([...keys]);
      if (this.sendError !== null && keys[0] === "Enter") throw this.sendError;
    },
    sleep: async () => undefined,
  };
}

const optionOf = (match: PromptMatch, key: string) => match.options.find((option) => option.key === key)!;

// The fingerprint keeps the command's own whitespace. Only the frame's padding
// after the bar comes off (its title row's, one or two cells, the same for
// every row); a wrapped row's leading spaces are the command's. The pair below:
// a long quoted argument wrapped before the space ahead of `world`, one payload
// space in A and two in B.
describe("the fingerprint keeps the command's own whitespace", () => {
  const layouts = [
    ["the reference's one cell after the bar", " ", ""],
    ["Grok 1.0.70's live two cells, the bar indented", "  ", "  "],
  ] as const;
  const frame = (pad: string, indent: string, command: readonly string[]): string =>
    [
      "Output above",
      "",
      `${indent}┃${pad}› Print a quoted string`,
      ...command.map((row) => `${indent}┃${pad}${row}`),
      `${indent}┃`,
      `${indent}┃${pad}1 (○) Yes, and don't ask again for anything (always-approve mode)`,
      `${indent}┃${pad}2 (●) Yes, proceed`,
      `${indent}┃${pad}3 (○) No, reject (type to add feedback)`,
      "",
      "1/3:select │ Tab:next option",
    ].join("\n");
  // Grok's wrapped row sits two cells in (under the command after `│ `); the payload's own spaces follow.
  const quoted = (spaces: number, pad: string, indent: string): string =>
    frame(pad, indent, [`│ python3 -c 'print("${"x".repeat(80)}hello`, `  ${" ".repeat(spaces)}world")'`]);
  // A heredoc whose second line is inside the loop in A and outside it in B.
  const indented = (inner: string, pad: string, indent: string): string =>
    frame(pad, indent, ["│ python3 - <<'PY'", '  for name in ("a", "b"):', `  ${inner}print(name)`, "  PY"]);
  const answerOn = async (shown: string, now: string) => {
    const match = grok(shown);
    const sent: string[][] = [];
    const io: PaneIO = { read: async () => now, sendKeys: async (keys) => void sent.push([...keys]), sleep: async () => undefined };
    return { outcome: await answerPrompt(io, match.options[1]!, match), sent };
  };

  it.each(layouts)("a wrapped row's leading spaces are the command's (%s): one payload space and two differ, and the answer sends nothing to the other", async (_name, pad, indent) => {
    const a = quoted(1, pad, indent);
    const b = quoted(2, pad, indent);
    expect(grok(a).fingerprint.body[2]).toBe(`   world")'`);
    expect(grok(b).fingerprint.body[2]).toBe(`    world")'`);
    expect(sameFingerprint(grok(a).fingerprint, grok(b).fingerprint)).toBe(false);
    const changed = await answerOn(a, b);
    expect(changed.outcome.type).toBe("changed");
    expect(changed.sent).toEqual([]);
    // The same frame still answers: its digit, nothing after it.
    expect((await answerOn(a, quoted(1, pad, indent))).sent).toEqual([["2"]]);
  });

  it.each(layouts)("an indented continuation row keeps its indentation (%s): the line inside the loop and outside it differ", async (_name, pad, indent) => {
    const inside = indented("    ", pad, indent);
    const outside = indented("", pad, indent);
    expect(grok(inside).fingerprint.body.slice(1)).toEqual(["│ python3 - <<'PY'", '  for name in ("a", "b"):', "      print(name)", "  PY"]);
    expect(sameFingerprint(grok(inside).fingerprint, grok(outside).fingerprint)).toBe(false);
    for (const [shown, now] of [[inside, outside], [outside, inside]] as const) {
      const changed = await answerOn(shown, now);
      expect(changed.outcome.type).toBe("changed");
      expect(changed.sent).toEqual([]);
    }
  });

  it("only the frame's padding comes off: the recorded frames read as before, the wrapped one keeps its two cells", () => {
    const live = grok(G.liveApproval);
    expect(live.fingerprint.body).toEqual(["›  Print 1 with python3", "│ python3 -c 'print(1)'", "← → narrow scope  ·  e edit pattern"]);
    expect(live.fingerprint.options).toEqual([
      "1 ( ) Yes, and don't ask again for anything (always-approve mode)",
      "2 ( ) Always allow: python3 -c print(1)",
      "3 ( ) Yes, proceed",
      "4 ( ) No, reject (type to add feedback)",
      "5 ( ) Never allow: python3 -c",
    ]);
    expect(grok(G.approval).fingerprint.body).toEqual([`›  ${title}`, `│ ${command}`, "← → narrow scope  ·  e edit pattern"]);
    expect(grok(G.wrappedPlain).fingerprint.body).toEqual([
      `›  ${title}`,
      "│ /Users/filler/.cache/venv/bin/python /Users/demo/probe/fil",
      "  ler/scrape_us.py probe",
      "← → narrow scope  ·  e edit pattern",
    ]);
    expect(grok(G.wrappedPlain).fingerprint.options.slice(0, 2)).toEqual(["1 ( ) Yes, and don't ask again for anything (always-approve", "mode)"]);
    for (const after of [G.liveAfter4, G.liveCancelled]) expect(grokFrame(after, pane)).toBeNull();
  });

  it("a frame whose padding cannot be told from its rows is not read", () => {
    expect(grokFrame(G.liveApproval, pane)).not.toBeNull();
    const cases = [
      // A row with less padding than the title's.
      G.liveApproval.replace("  ┃  │ python3", "  ┃ │ python3"),
      G.liveApproval.replace("  ┃  4 (○)", "  ┃ 4 (○)"),
      G.approval.replace("┃ │", "┃│"),
      // Three cells before the title: no recorded padding.
      G.liveApproval.replace("  ┃  ›", "  ┃   ›"),
      // A row whose bar is out of the block's column.
      G.liveApproval.replace("  ┃  3 (●)", " ┃  3 (●)"),
      G.liveApproval.replace("  ┃  ←", "   ┃  ←"),
    ];
    for (const text of cases) {
      expect(text).not.toBe(G.liveApproval);
      expect(grokFrame(text, pane)).toBeNull();
      expect(matchPrompt(text, pane, "grok").type).toBe("unmatched");
    }
  });
});

describe("Grok's answer: the digit alone, then reads; never Enter, never Esc", () => {
  let match: PromptMatch;
  beforeAll(() => {
    match = grok(G.approval);
  });

  it("the digit alone closes the frame: it took", async () => {
    const io = new GrokPane([G.approval, G.after]);
    expect(await answerPrompt(io.io, optionOf(match, "3"), match)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["3"]]);
  });

  it("the recorded frame: 4 alone closes it, the turn is cancelled", async () => {
    const live = grok(G.liveApproval);
    const io = new GrokPane([G.liveApproval, G.liveAfter4, G.liveCancelled]);
    expect(await answerPrompt(io.io, optionOf(live, "4"), live)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["4"]]);
  });

  it("the frame stays after the digit, the chosen option marked: no Enter, Answer in Terminal", async () => {
    const io = new GrokPane([G.approval, G.marked1]);
    const outcome = await answerPrompt(io.io, optionOf(match, "1"), match);
    expect(outcome.type).toBe("unsettled");
    if (outcome.type === "unsettled") expect(readingMatch(outcome.now!)!.fingerprint).toEqual(match.fingerprint);
    expect(io.sent).toEqual([["1"]]);
    expect(io.reads).toBe(1 + grokSettleReads);
  });

  it("the other glyphs (◉ marked after the digit): no Enter", async () => {
    const io = new GrokPane([G.approval, G.altGlyphs]);
    expect((await answerPrompt(io.io, optionOf(match, "3"), match)).type).toBe("unsettled");
    expect(io.sent).toEqual([["3"]]);
  });

  it("option 4 answers with its digit alone, no feedback, no Enter", async () => {
    const io = new GrokPane([G.approval, G.marked4, G.after]);
    expect(await answerPrompt(io.io, optionOf(match, "4"), match)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["4"]]);
  });

  it("n = 3: the digit alone closes it", async () => {
    const three = grok(G.three);
    const io = new GrokPane([G.three, G.after]);
    expect(await answerPrompt(io.io, optionOf(three, "2"), three)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["2"]]);
  });

  it("an identical second prompt right after the digit: no key for it, Answer in Terminal", async () => {
    // The digit answers A; before the first read Grok asks B, the same title, command and options, 3 marked.
    let phase: "A" | "B" | "done" = "A";
    let approvalsOfB = 0;
    const sent: string[][] = [];
    const outcome = await answerPrompt(
      {
        read: async () => (phase === "done" ? G.after : G.approval),
        sendKeys: async (keys) => {
          sent.push([...keys]);
          if (phase === "A" && keys[0] === "3") phase = "B";
          else if (phase === "B") {
            approvalsOfB += 1;
            phase = "done";
          }
        },
        sleep: async () => undefined,
      },
      optionOf(match, "3"),
      match,
    );
    expect(outcome.type).toBe("unsettled");
    expect({ approvalsOfB, sent }).toEqual({ approvalsOfB: 0, sent: [["3"]] });
  });

  it("the user's own Terminal input during the wait: nothing more goes", async () => {
    // The digit marks 1; the third read captures it marked again, and while it returns the user presses Return in
    // Terminal (A taken) and Grok asks the next question.
    let reads = 0;
    let typed = false;
    const after: string[][] = [];
    const sent: string[][] = [];
    const outcome = await answerPrompt(
      {
        read: async () => {
          reads += 1;
          if (reads === 3) typed = true;
          return reads === 1 ? G.approval : reads <= 3 ? G.marked1 : G.second;
        },
        sendKeys: async (keys) => {
          sent.push([...keys]);
          if (typed) after.push([...keys]);
        },
        sleep: async () => undefined,
      },
      optionOf(match, "1"),
      match,
    );
    expect(outcome.type).toBe("unsettled");
    expect(sent).toEqual([["1"]]);
    expect(after).toEqual([]);
  });

  it("a different second prompt after the digit: nothing more, Answer in Terminal, the card as the screen says", async () => {
    const io = new GrokPane([G.approval, G.second]);
    const outcome = await answerPrompt(io.io, optionOf(match, "3"), match);
    expect(outcome.type).toBe("unsettled");
    if (outcome.type !== "unsettled") return;
    expect(readingMatch(outcome.now!)!.question).toBe("Run the full scrape");
    expect(io.sent).toEqual([["3"]]);
  });

  it("an unread screen after the digit: nothing more, Answer in Terminal", async () => {
    const io = new GrokPane([G.approval, new Error("the pane could not be read")]);
    expect(await answerPrompt(io.io, optionOf(match, "3"), match)).toEqual({ type: "unsettled", now: null });
    expect(io.sent).toEqual([["3"]]);
  });

  it("a blank read after the digit proves nothing: nothing more", async () => {
    const io = new GrokPane([G.approval, "\n\n"]);
    expect(await answerPrompt(io.io, optionOf(match, "3"), match)).toEqual({ type: "unsettled", now: null });
    expect(io.sent).toEqual([["3"]]);
  });

  it("a frame partly drawn after the digit, then gone: it took", async () => {
    const io = new GrokPane([G.approval, G.partial, G.after]);
    expect(await answerPrompt(io.io, optionOf(match, "3"), match)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["3"]]);
  });

  it("the gate refuses before the digit: nothing sent", async () => {
    const io = new GrokPane([G.approval, G.after]);
    const outcome = await answerPrompt(io.io, optionOf(match, "3"), match, () => false);
    expect(outcome.type).toBe("withdrawn");
    expect(io.sent).toEqual([]);
  });

  it("another frame before the digit: nothing sent", async () => {
    const io = new GrokPane([G.second]);
    const outcome = await answerPrompt(io.io, optionOf(match, "3"), match);
    expect(outcome.type).toBe("changed");
    expect(io.sent).toEqual([]);
  });

  it("only the digit, in every sequence: never Enter, never Escape", async () => {
    const runs: (string | Error)[][] = [
      [G.approval, G.after],
      [G.approval, G.marked1],
      [G.approval, G.marked1, G.marked1, G.after],
      [G.approval, G.approval],
      [G.approval, G.second],
      [G.approval, new Error("x")],
      [G.approval, G.partial],
    ];
    for (const screens of runs) {
      const io = new GrokPane(screens);
      await answerPrompt(io.io, optionOf(match, "1"), match);
      expect(io.sent).toEqual([["1"]]);
    }
  });

  it("Claude's and Codex's answers are unchanged: their keys once, no read after", async () => {
    const claude = readingMatch(matchPrompt(L.claude2_1_303Bash, pane))!;
    const io = new GrokPane([L.claude2_1_303Bash, L.claude2_1_303AfterNo]);
    expect(await answerPrompt(io.io, claude.options[0]!, claude)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([claude.options[0]!.keys]);
    expect(io.reads).toBe(1);
    const codex = readingMatch(matchPrompt(L.codex0_163_0Dialog, pane))!;
    const io2 = new GrokPane([L.codex0_163_0Dialog]);
    expect(await answerPrompt(io2.io, codex.options[0]!, codex)).toEqual({ type: "sent" });
    expect(io2.reads).toBe(1);
  });
});

// The main process and the page: a Grok pane in a fake Herdr (prompt-herdr.ts).
import { HostRegistry } from "../src/main/hosts";
import { PromptService } from "../src/main/prompt/prompts";
import { stopBindingOf } from "../src/shared/agent-stop";
import type { HostView } from "../src/shared/ipc-contract";
import type { AnswerRequest, AnswerResult } from "../src/shared/prompt/view";
import { NeedsCardStore } from "../src/renderer/chat/needs-card-store";
import { backend, clock, FakeHerdr, show, snapshot } from "./support/prompt-herdr";
import { TerminalSessions } from "../src/main/terminals";
import { F as Fixtures } from "./support/prompt-fixtures";

async function grokSetup(screens: string[]) {
  const json = snapshot();
  const panes = json["panes"] as Record<string, unknown>[];
  const agents = json["agents"] as Record<string, unknown>[];
  panes[0]!["agent"] = "grok";
  agents[0]!["agent"] = "grok";
  agents[0]!["agent_session"] = { source: "herdr:grok", agent: "grok", kind: "id", value: "g-1" };
  const herdr = new FakeHerdr(json, { "w1:p1": screens, "w1:p2": [Fixtures.working] });
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
  await registry.refreshAll();
  const time = clock();
  const service = new PromptService(registry, () => undefined, time);
  await service.tick();
  const prompt = (): PanePrompt => service.list().find((each) => each.paneId === "w1:p1")!;
  const request = (key: string): AnswerRequest => ({
    hostId: "mac",
    paneId: "w1:p1",
    binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Grok"),
    fingerprint: readingMatch(prompt().reading!)!.fingerprint,
    episode: prompt().episode,
    key,
  });
  const keys = (): string[][] => herdr.sent("pane.send_keys").map((params) => params["keys"] as string[]);
  return { herdr, registry, service, time, prompt, request, keys };
}

describe("the service on a Grok pane", () => {
  it("reads Grok's frame (the pane's agent picks it) and never clears it as quiet", async () => {
    const context = await grokSetup([G.approval]);
    expect(readingMatch(context.prompt().reading!)?.kind).toBe("grok");
    context.time.t += 2_500;
    await context.service.tick();
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().cleared).toBe(false);
    expect(context.prompt().quiet).toBe(false);
  });

  it("an answer whose digit closes the frame: sent, Grok's digit only", async () => {
    const context = await grokSetup([G.approval, G.after]);
    const result = await context.service.answer(context.request("3"));
    expect(result).toEqual({ type: "sent", label: "Yes, proceed" });
    expect(context.keys()).toEqual([["3"]]);
  });

  it("another frame after the digit: Answer in Terminal, the card shows that frame, this question is answered once", async () => {
    const context = await grokSetup([G.approval, G.second]);
    const request = context.request("3");
    const result = await context.service.answer(request);
    expect(result).toEqual({ type: "unsettled", label: "Yes, proceed", note: "Answer in Terminal: Grok’s screen did not show the answer take" });
    expect(readingMatch(context.prompt().reading!)?.question).toBe("Run the full scrape");
    expect(context.keys()).toEqual([["3"]]);
    expect(await context.service.answer(request)).toMatchObject({ type: "refused" });
    expect(context.keys()).toEqual([["3"]]);
  });

  it("the recorded frame answered 4: the digit alone, sent, then nothing prompt-like (the card goes)", async () => {
    const context = await grokSetup([G.liveApproval, G.liveAfter4, G.liveCancelled]);
    expect(await context.service.answer(context.request("4"))).toEqual({ type: "sent", label: "No, reject (type to add feedback)" });
    expect(context.keys()).toEqual([["4"]]);
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().reading?.type).toBe("unmatched");
    expect(needsCardShown({ isAgent: true, status: "blocked", kind: "grok" }, context.prompt())).toBe(false);
  });

  it("the user's own Terminal input during the card's wait: no key after it (through the service and the terminal)", async () => {
    const json = snapshot();
    (json["panes"] as Record<string, unknown>[])[0]!["agent"] = "grok";
    const agent = (json["agents"] as Record<string, unknown>[])[0]!;
    agent["agent"] = "grok";
    agent["agent_session"] = { source: "herdr:grok", agent: "grok", kind: "id", value: "g-1" };
    const herdr = new FakeHerdr(json, { "w1:p1": [G.approval, G.marked1, G.after] });
    let typed = false;
    let keysAfterTyping = 0;
    herdr.beforeKeys = () => {
      if (typed) keysAfterTyping += 1;
    };
    const registry = new HostRegistry(() => undefined);
    registry.add(
      { id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" },
      {
        ...backend(herdr, { value: 1 }),
        openTerminal: async () => ({
          input: () => {
            typed = true;
            show(herdr, "w1:p1", G.second, G.after);
          },
          resize: () => undefined,
          close: () => undefined,
        }),
      },
    );
    await registry.refreshAll();
    const terminals = new TerminalSessions(registry);
    const owner = { isDestroyed: () => false, send: () => undefined } as unknown as Parameters<TerminalSessions["open"]>[0];
    const terminal = await terminals.open(owner, { hostId: "mac", paneId: "w1:p1", cols: 120, rows: 40 });
    const service = new PromptService(registry, () => undefined, clock());
    await service.tick();
    const prompt = service.list()[0]!;
    const real = herdr.roundTrip.bind(herdr);
    let answerReads = 0;
    herdr.roundTrip = async (line) => {
      const reply = await real(line);
      // The third read shows 1 marked; the user's Return in Terminal takes A and Grok asks B before it returns.
      if ((JSON.parse(line) as { method: string }).method === "pane.read" && ++answerReads === 3) terminals.input(owner, terminal.sessionId, "\r");
      return reply;
    };
    const result = await service.answer({
      hostId: "mac",
      paneId: "w1:p1",
      binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Grok"),
      fingerprint: readingMatch(prompt.reading!)!.fingerprint,
      episode: prompt.episode,
      key: "1",
    });
    terminals.closeAll();
    expect(typed).toBe(true);
    expect(keysAfterTyping).toBe(0);
    expect(herdr.sent("pane.send_keys").map((params) => params["keys"])).toEqual([["1"]]);
    expect(result.type).toBe("unsettled");
  });

  it("the Grok pane with no prompt: read, nothing prompt-like, cleared after two quiet reads (no card)", async () => {
    const context = await grokSetup([G.noPrompt]);
    expect(context.prompt().reading?.type).toBe("unmatched");
    expect(context.prompt().quiet).toBe(true);
    expect(needsCardShown({ isAgent: true, status: "blocked", kind: "grok" }, context.prompt())).toBe(false);
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().cleared).toBe(true);
  });
});

describe("the card store after Grok's unsettled answer", () => {
  const host = { id: "box", name: "Mac mini", state: "connected", topology: null, incarnation: 1, epoch: 0 } as unknown as HostView;
  const prompt = (text: string, episode = "e1"): PanePrompt => ({ hostId: "box", paneId: pane, episode, incarnation: 1, connection: 1, epoch: 1, reading: matchPrompt(text, pane, "grok"), quiet: !promptLike(text, "grok"), cleared: false });
  const bridge = (result: AnswerResult) => ({
    listPrompts: () => Promise.resolve([]),
    onPromptsChanged: () => () => undefined,
    answerPrompt: () => Promise.resolve(result),
  });

  it("keeps the card as the screen says, with the note and Answer in Terminal, until the block ends", async () => {
    const store = new NeedsCardStore();
    store.receive([prompt(G.approval)]);
    const shown = readingMatch(store.forPane("box", pane)!.reading!)!;
    const note = "Answer in Terminal: Grok’s screen did not show the answer take";
    await store.answer(bridge({ type: "unsettled", label: "Yes, proceed", note }), host, pane, "grok", shown, shown.options[2]!);
    expect(store.card("box", pane)).toMatchObject({ sent: null, note, terminal: { episode: "e1" }, busy: false });
    store.receive([prompt(G.second)]);
    expect(store.card("box", pane).terminal).toEqual({ episode: "e1" });
    store.receive([prompt(G.second, "e2")]);
    expect(store.card("box", pane)).toMatchObject({ terminal: null, note: null });
  });
});

// The quiet rule reads Grok's traces on a Grok pane only. The cases: an old
// Grok title row above twenty finished rows, and a reply quoting Grok's frame
// rows, with no live prompt.
describe("the quiet rule: any part of Grok's frame counts on a Grok pane only", () => {
  const stale = ["┃ › Historical tool title", ...Array.from({ length: 20 }, (_, index) => `completed output ${index}`), "Work continues"].join("\n");
  const quoted = [
    "⏺ Grok asked this in the other pane:",
    "",
    "  ┃  ›  Run the full scrape",
    "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
    "  ┃  3 (●) Yes, proceed",
    "  1/5:select  │  Tab:next option",
    "",
    "⏺ I left it for you; the scrape script is unchanged.",
    "",
    "✻ Worked for 4s",
  ].join("\n");
  const twoReads = (text: string, kind: string | null) => afterRead(afterRead(quietMarked, { startedAt: 2_000, text }, 1_000, kind), { startedAt: 4_500, text }, 1_000, kind);

  it.each(["claude", "codex", "cursor", "Claude"])("on a %s pane a stale or quoted Grok row is not prompt-like: two reads 2.5 s apart clear the mark", (kind) => {
    for (const text of [stale, quoted, G.partial]) {
      expect(promptLike(text, kind)).toBe(false);
      expect(twoReads(text, kind).cleared).toBe(true);
    }
  });

  it("on a Grok pane any part of its frame keeps the mark (a partly drawn frame, an old title row)", () => {
    for (const text of [stale, quoted, G.partial, G.approval, G.marked1]) {
      expect(promptLike(text, "grok")).toBe(true);
      expect(promptLike(text, "Grok")).toBe(true);
      expect(twoReads(text, "grok")).toEqual(quietMarked);
    }
    expect(promptLike(G.after, "grok")).toBe(false);
    expect(twoReads(G.after, "grok").cleared).toBe(true);
  });

  const kindSetup = async (kind: string, screen: string) => {
    const json = snapshot();
    (json["panes"] as Record<string, unknown>[])[0]!["agent"] = kind;
    const agent = (json["agents"] as Record<string, unknown>[])[0]!;
    agent["agent"] = kind;
    agent["agent_session"] = { source: `herdr:${kind}`, agent: kind, kind: "id", value: "s-1" };
    const herdr = new FakeHerdr(json, { "w1:p1": [screen], "w1:p2": [Fixtures.working] });
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
    await registry.refreshAll();
    const time = clock();
    const service = new PromptService(registry, () => undefined, time);
    await service.tick();
    return {
      step: async () => {
        time.t += 2_500;
        await service.tick();
      },
      cleared: () => service.list().find((each) => each.paneId === "w1:p1")!.cleared,
    };
  };

  it.each(["claude", "codex", "cursor"])("the service: a blocked %s pane showing an old Grok title row clears after two reads", async (kind) => {
    for (const screen of [stale, quoted]) {
      const context = await kindSetup(kind, screen);
      expect(context.cleared()).toBe(false);
      await context.step();
      expect(context.cleared()).toBe(true);
    }
  });

  it("the service: a blocked Grok pane showing part of its frame stays in Needs you", async () => {
    for (const screen of [stale, G.partial]) {
      const context = await kindSetup("grok", screen);
      for (let index = 0; index < 3; index += 1) await context.step();
      expect(context.cleared()).toBe(false);
    }
  });
});

// The desktop demo's Grok pane (Mac mini, wD:pK).
import { grokCardCaptureSteps, cursorLiveCaptureSteps } from "../src/main/capture";
import { demoGrokTurnMs, demoTranscripts } from "../src/main/demo/demo-chat";
import { demoHostIds } from "../src/main/demo/demo-hosts";
import { demoGrokCommand, demoGrokDone, demoGrokScreen, demoGrokTitle, demoPromptScreens } from "../src/main/demo/demo-prompts";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { workingSince } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { workingLine } from "../src/renderer/chat/ChatView";
import { readGrokScreen } from "../src/shared/agent-settings";
import { buildDesktopSidebar, rowKey, type DesktopRow } from "../src/shared/desktop-sidebar";
import { needsPill, needsPillKinds } from "../src/shared/needs-pill";
import { applyCleared } from "../src/shared/prompt/quiet";
import { emptyFoldState, type SidebarFoldState } from "../src/shared/sidebar-model";

describe("the demo's Grok pane", () => {
  it("waits on Grok's approval frame: the card reads its title, command and options; its digit closes it", () => {
    expect(demoPromptScreens("").macMini["wD:pK"]).toEqual([demoGrokScreen, demoGrokDone]);
    const match = grok(demoGrokScreen);
    expect(match.question).toBe(demoGrokTitle);
    expect(match.context).toEqual({ type: "command", text: demoGrokCommand });
    expect(match.options.map((option) => option.label)).toEqual([
      "Yes, and don't ask again for anything (always-approve mode)",
      `Always allow: ${demoGrokCommand}`,
      "Yes, proceed",
      "No, reject (type to add feedback)",
      "Never allow: python3 scripts/narrate.py",
    ]);
    expect(marked(match)).toEqual(["3"]);
    expect(grokFrame(demoGrokDone, pane)).toBeNull();
    expect(promptLike(demoGrokDone, "grok")).toBe(false);
  });

  it("its transcript's running turn starts at Grok's turn start: the Working line counts from there", () => {
    const start = 1_793_910_600_000;
    const narration = demoTranscripts(start).find((transcript) => transcript.paneID === "wD:pK")!;
    const parser = new TranscriptParser("grok");
    const builder = new ChatTimelineBuilder();
    narration.lines.forEach((line, index) => builder.apply(parser.parse(line, index * 1_000).events, index * 1_000));
    const timeline = builder.timeline;
    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[1]!.isFinished).toBe(false);
    expect(workingSince(timeline)).toBeCloseTo((start - demoGrokTurnMs) / 1_000, 3);
    expect(workingLine(workingSince(timeline)!, start / 1_000 + 5, 0)).toBe("Working for 17m 13s");
    // The pending call is the frame's command.
    const calls = timeline.turns[1]!.items.flatMap((item) => (item.type === "toolCall" ? [item.value] : []));
    expect(JSON.stringify(calls.at(-1))).toContain(demoGrokCommand);
  });

  it("a pick on the demo's screens: the digit alone, the frame gone, then cleared as working (no card)", async () => {
    const context = await grokSetup([demoGrokScreen, demoGrokDone]);
    expect(readingMatch(context.prompt().reading!)?.question).toBe(demoGrokTitle);
    expect(await context.service.answer(context.request("3"))).toEqual({ type: "sent", label: "Yes, proceed" });
    expect(context.keys()).toEqual([["3"]]);
    context.time.t += 2_500;
    await context.service.tick();
    expect(needsCardShown({ isAgent: true, status: "blocked", kind: "grok" }, context.prompt())).toBe(false);
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().cleared).toBe(true);
  });

  // The demo backend also draws this pane as Grok's box at its prompt (demo-grok-pane.ts).
  // While its approval waits, the pane shows the frame; once the digit answers it, Grok's box again.
  it("the merged demo backend shows the frame over Grok's box until its digit answers it", async () => {
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHosts } = await import("../src/main/demo/demo-hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const fixtures = bundledFixturesForTests();
    const host = demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!;
    const backend = new DemoBackend(host, fixtures);
    const waiting = await backend.paneText("wD:pK", 80);
    expect(grok(waiting).question).toBe(demoGrokTitle);
    expect(readGrokScreen(waiting)).toBeNull();
    await backend.promptIO().paneSendKeys("wD:pK", ["3"]);
    const after = await backend.paneText("wD:pK", 80);
    expect(grokFrame(after, pane)).toBeNull();
    expect(promptLike(after, "grok")).toBe(false);
    // The border's mode word reads too.
    expect(readGrokScreen(after)).toEqual({ draft: "", borderModel: "Grok 4.7", borderEffort: "high", window: "256k", mode: "alwaysApprove" });
    backend.close();
  });

  // The sidebar's pill, as App.tsx reads it (needsPillKinds and applyCleared over main's readings).
  it("the sidebar's pill: Pending Approval in its row, the Needs you group and Priority; gone once its digit answers it", async () => {
    const context = await grokSetup([demoGrokScreen, demoGrokDone]);
    const key = rowKey("mac", "w1:p1");
    const shown = (fold: SidebarFoldState) => {
      const prompts = context.service.list();
      const kind = needsPillKinds(prompts).get(key);
      const sidebar = buildDesktopSidebar(applyCleared(context.registry.list(), prompts), { nowUnixMs: context.time.t, fold });
      const ours = (rows: readonly DesktopRow[]) => rows.filter((each) => each.row.paneID === "w1:p1");
      const projects = sidebar.hosts.flatMap((host) => host.model?.projects.flatMap((section) => section.rows) ?? []).filter((row) => row.paneID === "w1:p1");
      return {
        kind,
        row: projects.map((row) => needsPill(row, kind)?.label ?? null),
        needsYou: ours(sidebar.needsYou).map((each) => needsPill(each.row, kind)?.label ?? null),
        priority: sidebar.priority.filter((section) => section.kind === "needsYou").flatMap((section) => ours(section.rows).map((each) => needsPill(each.row, kind)?.label ?? null)),
      };
    };
    const priority = { ...emptyFoldState, mode: "priority" as const };
    expect(shown(emptyFoldState)).toMatchObject({ kind: "approval", row: ["Pending Approval"], needsYou: ["Pending Approval"] });
    expect(shown(priority).priority).toEqual(["Pending Approval"]);
    expect(await context.service.answer(context.request("3"))).toEqual({ type: "sent", label: "Yes, proceed" });
    context.time.t += 2_500;
    await context.service.tick();
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().cleared).toBe(true);
    expect(shown(emptyFoldState)).toMatchObject({ row: [null], needsYou: [] });
    expect(shown(priority).priority).toEqual([]);
  });

  it("captures 80-83 follow the Grok chips captures (71-73) and come before the folded sidebar's 86-87, on the Grok pane", () => {
    expect(cursorLiveCaptureSteps(demoHostIds).at(-1)!.name).toBe("67-cursor-live-landed");
    const main = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
    const at = (call: string): number => main.indexOf(`...${call}(demoHostIds)`);
    expect(at("grokChipsCaptureSteps")).toBeGreaterThan(at("cursorChipsCaptureSteps"));
    expect(at("grokCardCaptureSteps")).toBeGreaterThan(at("grokChipsCaptureSteps"));
    expect(at("sidebarFoldedCaptureSteps")).toBeGreaterThan(at("grokCardCaptureSteps"));
    const steps = grokCardCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["80-grok-card", "81-grok-terminal", "82-grok-after-pick", "83-grok-working"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: "wD:pK" });
    expect(steps[2]!.commands).toContainEqual({ type: "click", selector: '.ncard .nc-opt[data-key="3"]' });
  });
});
