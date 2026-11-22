// Claude Code 2.1.325's question dialog (its AskUserQuestion tool, one
// question, one choice) as the Needs card. Read on a Claude pane or one whose
// agent is not known, never on another agent's: the top rule, one header chip,
// the question, the options numbered from 1 with their descriptions,
// `Type something.`, a rule, `Chat about this`, the footer
// `Enter to select · ↑/↓ to navigate · Esc to cancel`. Several questions,
// several choices, a cut top and anything else stay unmatched, shown as today.
// The fixtures are the Swift tests' own files (Tests/HerdrCompanionTests/
// Fixtures/ClaudeAsk, built from the one recorded read); the same cases and
// expected results as Tests/HerdrCompanionTests/CompanionClaudeAskTests.swift.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import { PromptService } from "../src/main/prompt/prompts";
import { NeedsCard, needsCardShown } from "../src/renderer/chat/NeedsCard";
import { needsCards } from "../src/renderer/chat/needs-card-store";
import { stopBindingOf } from "../src/shared/agent-stop";
import type { HerdrDesktopBridge, HostView } from "../src/shared/ipc-contract";
import { answerPrompt, grokSettleReads, type PaneIO } from "../src/shared/prompt/answerer";
import { cardContent, cardKeyAction, ownAnswerLine } from "../src/shared/prompt/card";
import {
  claudeAsk,
  claudeAskCells,
  claudeAskRowLimit,
  claudeAskTrace,
  cleanRow,
  isBorder,
  matchPrompt,
  needsTallRead,
  readingMatch,
  readRows,
  unmatchedLineCount,
  type PromptMatch,
  type PromptReading,
} from "../src/shared/prompt/matcher";
import { afterRead, marked as quietMarked, promptLike } from "../src/shared/prompt/quiet";
import type { AnswerRequest, PanePrompt } from "../src/shared/prompt/view";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { A, C, F } from "./support/prompt-fixtures";
import { backend, clock, FakeHerdr, show, snapshot } from "./support/prompt-herdr";

const pane = "w1:p1";
const question = "Q95: what should Z research next for the earning talk?";
const labels = ["Teams and T3 gaps (Recommended)", "Phone pricing only", "Nothing now"];
const details = [
  "What teams pay for in this category and where T3 Code falls short. Web only, under 300K tokens.",
  "Moshi and the SSH apps in detail. Web only, under 300K tokens.",
  "No more research until you open the earning talk.",
];
const fingerprintOptions = [
  "  1. Teams and T3 gaps (Recommended)",
  "     What teams pay for in this category and where T3 Code falls short. Web only, under 300K tokens.",
  "  2. Phone pricing only",
  "     Moshi and the SSH apps in detail. Web only, under 300K tokens.",
  "  3. Nothing now",
  "     No more research until you open the earning talk.",
  "  4. Type something.",
  "  5. Chat about this",
];
const longDescription =
  "Moshi and the SSH apps in detail: what each charges on the iPhone and the iPad, what a team plan costs, and which of them sell a lifetime licence. Web only, under 300K tokens.";
const longQuestion = "Q95: what should Z research next for the earning talk, given that the pricing notes cover only the Mac app so far?";

function ask(text: string, kind: string | null = "claude"): PromptMatch {
  const reading = matchPrompt(text, pane, kind);
  const match = readingMatch(reading);
  if (match === null) throw new Error(`not matched: ${JSON.stringify(reading)}`);
  return match;
}

/** What the card showed before this round: the general rules' unmatched reading, its last lines. */
function today(text: string): PromptReading {
  const lines = readRows(text)
    .map(cleanRow)
    .filter((row) => row !== "" && !isBorder(row))
    .slice(-unmatchedLineCount);
  return { type: "unmatched", lines };
}

const marked = (match: PromptMatch): string[] => match.options.filter((option) => option.isReturnDefault).map((option) => option.key);
const optionOf = (match: PromptMatch, key: string) => match.options.find((option) => option.key === key)!;

describe("Claude Code's question dialog, read whole", () => {
  it("the recorded read: the question, the header, three options with their labels and descriptions, 1 marked", () => {
    for (const kind of ["claude", "Claude", null]) {
      const match = ask(A.sample, kind);
      expect(match.kind).toBe("claudeAsk");
      expect(match.question).toBe(question);
      expect(match.askHeader).toBe("Q95");
      expect(match.context).toBeNull();
      expect(match.options.map((option) => option.key)).toEqual(["1", "2", "3"]);
      expect(match.options.map((option) => option.label)).toEqual(labels);
      expect(match.options.map((option) => option.detail)).toEqual(details);
      expect(marked(match)).toEqual(["1"]);
      // The digit alone answers each; none is session-wide or opens the box; Type something and Chat about this are no options.
      expect(match.options.map((option) => option.keys)).toEqual([["1"], ["2"], ["3"]]);
      expect(match.options.some((option) => option.isSessionWide || option.opensComposer || option.inTerminal === true)).toBe(false);
      // The fingerprint also keeps each part as the one text it stands for (`words`).
      const optionWords = labels.flatMap((label, index) => [`${index + 1}. ${label}`, details[index]!]);
      const words = { question, body: `☐ Q95\n${question}`, options: [...optionWords, "4. Type something.", "5. Chat about this"].join("\n") };
      expect(match.fingerprint).toEqual({ rules: 2, paneID: pane, question, body: [" ☐ Q95", question], options: fingerprintOptions, words });
    }
  });

  it("a full read (40 rows, the conversation above) reads the same, with the same fingerprint", () => {
    expect(readRows(A.full)).toHaveLength(40);
    expect(ask(A.full)).toEqual(ask(A.sample));
  });

  it("the mark on option 2 or 3: that one is Return's; the fingerprint is the same", () => {
    expect(marked(ask(A.marked2))).toEqual(["2"]);
    expect(marked(ask(A.marked3))).toEqual(["3"]);
    expect(ask(A.marked2).fingerprint).toEqual(ask(A.full).fingerprint);
    expect(ask(A.marked3).fingerprint).toEqual(ask(A.full).fingerprint);
  });

  it("an 80-cell pane: shorter rules, a description wrapped over two rows joins its option", () => {
    const match = ask(A.narrow);
    expect(match.question).toBe(question);
    expect(match.options.map((option) => option.label)).toEqual(labels);
    expect(match.options.map((option) => option.detail)).toEqual(details);
    expect(match.fingerprint.options).toEqual([
      "  1. Teams and T3 gaps (Recommended)",
      "     What teams pay for in this category and where T3 Code falls short. Web",
      "     only, under 300K tokens.",
      ...fingerprintOptions.slice(2),
    ]);
  });

  it("a description wrapped over three rows joins its option", () => {
    const match = ask(A.wrapped3);
    expect(match.options.map((option) => option.detail)).toEqual([details[0], longDescription, details[2]]);
    expect(match.fingerprint.options.filter((row) => row.startsWith("     "))).toHaveLength(6);
  });

  it("a question wrapped over two rows joins with one space", () => {
    const match = ask(A.questionWrapped);
    expect(match.question).toBe(longQuestion);
    expect(match.fingerprint.body).toEqual([" ☐ Q95", "Q95: what should Z research next for the earning talk, given that the pricing", "notes cover only the Mac app so far?"]);
  });

  it("nine real options (one digit each) read; ten stay unmatched", () => {
    const nine = ask(A.nine);
    expect(nine.options.map((option) => option.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(nine.options[8]).toMatchObject({ label: "Topic 9", detail: "Research brief number 9. Web only, under 300K tokens.", keys: ["9"] });
    expect(matchPrompt(A.ten, pane, "claude")).toEqual(today(A.ten));
  });

  it("every other shape stays unmatched, shown exactly as today", () => {
    const shapes: Record<string, string> = {
      "the footer with text after it": A.footerAfter,
      "a row between the footer and Chat about this": A.rowBetween,
      "no rule over Chat about this": A.noRule,
      "no Type something": A.noType,
      "numbers with a gap": A.gap,
      "one real option": A.oneOption,
      "ten real options": A.ten,
      "a second header chip, arrows and Submit": A.twoChips,
      "a checkbox on each option": A.checkbox,
      "a box mark on each option": A.checkboxBox,
      "the top rule above a full read": A.cutRule,
      "the header above a full read": A.cutHeader,
      "the agent's next output under it": A.nextOutput,
      "the mark on Type something": A.markedType,
      "the mark on Chat about this": A.markedChat,
      "no mark": A.noMark,
    };
    for (const [name, text] of Object.entries(shapes)) {
      for (const kind of ["claude", null]) {
        expect(matchPrompt(text, pane, kind), `${name} (${kind})`).toEqual(today(text));
        expect(claudeAsk(text, pane), name).toBeNull();
      }
    }
  });

  it("a cut top asks for no taller read (that read is for Claude's approval frame); the tall dialog read whole matches", () => {
    expect(readRows(A.cutRule)).toHaveLength(40);
    expect(readRows(A.cutHeader)).toHaveLength(40);
    expect(needsTallRead(A.cutRule, "claude")).toBe(false);
    expect(needsTallRead(A.cutHeader, "claude")).toBe(false);
    const whole = ask(A.tall);
    expect(whole.options).toHaveLength(4);
    expect(whole.question).toBe(longQuestion);
  });

  it("never on another agent's pane: Codex, Grok, Cursor and Pi show the same rows as today", () => {
    for (const kind of ["codex", "grok", "cursor", "pi", "opencode"]) {
      for (const text of [A.sample, A.full, A.narrow]) expect(matchPrompt(text, pane, kind), kind).toEqual(today(text));
    }
  });

  it("the other agents' prompts read exactly as before on a Claude pane and with no kind", () => {
    for (const text of [F.claudeInput, F.claudeEdit, C.four]) {
      const reading = matchPrompt(text, pane, null);
      expect(reading.type === "matched" ? reading.match.kind : "unmatched").not.toBe("claudeAsk");
    }
  });

  it("a part of the dialog on screen is a trace; the screen after the answer is not", () => {
    for (const text of [A.full, A.cutRule, A.twoChips, A.checkbox, A.noRule]) expect(claudeAskTrace(text)).toBe(true);
    expect(claudeAskTrace(A.after)).toBe(false);
  });
});

describe("the card, in Claude's words and order", () => {
  it("Claude Code asks: the question, each option with its description, the line on typing an own answer", () => {
    const content = cardContent(ask(A.full), "claude");
    expect(content.kind).toBe("asks");
    expect(content.header).toBe("Claude Code asks");
    expect(content.target).toBeNull();
    expect(content.command).toBeNull();
    expect(content.parameters).toEqual([]);
    expect(content.lines).toEqual([]);
    expect(content.question).toBe(question);
    expect(content.options.map((option) => [option.key, option.label, option.detail])).toEqual(labels.map((label, index) => [String(index + 1), label, details[index]]));
    expect(content.returnIndex).toBe(0);
    expect(content.tellOption).toBeNull();
    expect(content.ownAnswer).toBe("To type your own answer, use the Terminal.");
    expect(ownAnswerLine).toBe(content.ownAnswer);
    expect(cardContent(ask(A.marked3), "claude").returnIndex).toBe(2);
    expect(cardContent(ask(A.full, null), null).header).toBe("The agent asks");
  });

  it("every other card has no own-answer line", () => {
    expect(cardContent(readingMatch(matchPrompt(C.four, pane, "codex"))!, "codex").ownAnswer).toBeNull();
    expect(cardContent(readingMatch(matchPrompt(F.claudeEdit, pane, "claude"))!, "claude").ownAnswer).toBeNull();
  });

  it("the card's keys: a digit picks its option, Return the selected one", () => {
    const options = ask(A.full).options;
    expect(cardKeyAction({ key: "2", textFocused: false }, options, 0)).toEqual({ type: "pick", index: 1 });
    expect(cardKeyAction({ key: "4", textFocused: false }, options, 0)).toEqual({ type: "none" });
    expect(cardKeyAction({ key: "Enter", textFocused: false }, options, 2)).toEqual({ type: "pick", index: 2 });
  });
});

describe("the card rendered", () => {
  const host = { id: "box", name: "build-box", state: "connected" } as unknown as HostView;
  const claudeRow = { paneID: pane, isAgent: true, status: "blocked", kind: "claude", name: "tidepool" } as unknown as SidebarRow;
  const previous = (globalThis as { window?: unknown }).window;
  const bridge: Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt"> = {
    listPrompts: () => Promise.resolve([]),
    onPromptsChanged: () => () => undefined,
    answerPrompt: () => Promise.resolve({ type: "sent", label: "Phone pricing only" }),
  };
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { herdrDesktop: bridge };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = previous;
    needsCards.receive([]);
  });
  const shown = (text: string): PanePrompt => ({
    hostId: "box",
    paneId: pane,
    episode: "e1",
    incarnation: 1,
    connection: 1,
    epoch: 1,
    reading: matchPrompt(text, pane, "claude"),
    quiet: !promptLike(text, "claude"),
    cleared: false,
  });
  const render = (): string => renderToStaticMarkup(createElement(NeedsCard, { host, row: claudeRow, onShowTerminal: () => undefined }));

  it("the question, one button per real option with its description, Answer in Terminal and the own-answer line", () => {
    needsCards.receive([shown(A.full)]);
    const html = render();
    expect(html).toContain('data-needs-card="asks"');
    expect(html).toContain('<span class="nc-t">Claude Code asks</span>');
    expect(html).toContain(`<div class="nc-q">${question}</div>`);
    expect(html).toContain(`<button class="nc-opt on" data-key="1"><span class="k">1</span><span class="l wrap">${labels[0]}</span><span class="d">${details[0]}</span></button>`);
    expect(html).toContain(`<button class="nc-opt" data-key="2"><span class="k">2</span><span class="l wrap">${labels[1]}</span><span class="d">${details[1]}</span></button>`);
    expect(html).toContain(`<button class="nc-opt" data-key="3"><span class="k">3</span><span class="l wrap">${labels[2]}</span><span class="d">${details[2]}</span></button>`);
    expect([...html.matchAll(/data-key="(\d)"/gu)].map((found) => found[1])).toEqual(["1", "2", "3"]);
    // One per row (the descriptions), never side by side; Type something and Chat about this are no buttons.
    expect(html).toContain('<div class="nc-opts" role="group"');
    expect(html).not.toContain("Type something");
    expect(html).not.toContain("Chat about this");
    expect(html).toContain('<div class="nc-foot"><button class="btn sm nc-term">Answer in Terminal</button><span class="nc-hint">To type your own answer, use the Terminal.</span></div>');
  });

  it("a dialog of several questions keeps today's unmatched card", () => {
    needsCards.receive([shown(A.twoChips)]);
    const html = render();
    expect(html).toContain('data-needs-card="unmatched"');
    expect(html).toContain("Answer in Terminal");
    expect(html).not.toContain(ownAnswerLine);
  });
});

/** A pane whose screens the test scripts (each read takes the next; the last stays), every key kept, no waiting. */
class ClaudePane {
  readonly sent: string[][] = [];
  reads = 0;
  constructor(private readonly screens: (string | Error)[]) {}
  readonly io: PaneIO = {
    read: async () => {
      this.reads += 1;
      const next = this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    sendKeys: async (keys) => {
      this.sent.push([...keys]);
    },
    sleep: async () => undefined,
  };
}

describe("the answer is the digit alone, then reads; never Enter, never Esc", () => {
  const match = ask(A.full);

  it("the dialog gone after the digit: sent, the tapped option's digit once and nothing else", async () => {
    for (const key of ["1", "2", "3"]) {
      const io = new ClaudePane([A.full, A.after]);
      expect(await answerPrompt(io.io, optionOf(match, key), match)).toEqual({ type: "sent" });
      expect(io.sent).toEqual([[key]]);
      expect(io.reads).toBe(2);
    }
  });

  it("the mark moved in the Terminal before the read: the tapped option still answers by its digit", async () => {
    const io = new ClaudePane([A.marked3, A.after]);
    expect(await answerPrompt(io.io, optionOf(match, "1"), match)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["1"]]);
  });

  it("the question, a label or a description changed, or the dialog gone, between the card and the tap: zero keys", async () => {
    const changed = [
      A.full.replace("what should Z research next", "what should Z research first"),
      A.full.replace("Phone pricing only", "Phone pricing first"),
      A.full.replace("Moshi and the SSH apps in detail.", "Moshi and the SSH apps in brief."),
      A.full.replace(" ☐ Q95", " ☐ Q96"),
      A.after,
      A.twoChips,
    ];
    for (const text of changed) {
      const io = new ClaudePane([text]);
      const outcome = await answerPrompt(io.io, optionOf(match, "2"), match);
      expect(outcome.type).toBe("changed");
      expect(io.sent).toEqual([]);
    }
  });

  it("the before-send gate refuses after the read: zero keys", async () => {
    const io = new ClaudePane([A.full, A.after]);
    expect(await answerPrompt(io.io, optionOf(match, "1"), match, () => false)).toEqual({ type: "withdrawn" });
    expect(io.sent).toEqual([]);
  });

  it("the dialog still there after the digit: unsettled, nothing more sent", async () => {
    const io = new ClaudePane([A.full, A.marked2]);
    const outcome = await answerPrompt(io.io, optionOf(match, "2"), match);
    expect(outcome.type).toBe("unsettled");
    if (outcome.type === "unsettled") expect(readingMatch(outcome.now!)!.fingerprint).toEqual(match.fingerprint);
    expect(io.sent).toEqual([["2"]]);
    expect(io.reads).toBe(1 + grokSettleReads);
  });

  it("another question after the digit: unsettled at once, nothing more", async () => {
    const io = new ClaudePane([A.full, A.full.replace("what should Z research next", "what should Z research first")]);
    const outcome = await answerPrompt(io.io, optionOf(match, "1"), match);
    expect(outcome.type).toBe("unsettled");
    expect(io.sent).toEqual([["1"]]);
    expect(io.reads).toBe(2);
  });

  it("a part of the dialog left: kept reading, then gone: sent; an unread screen proves nothing", async () => {
    const io = new ClaudePane([A.full, A.twoChips, A.after]);
    expect(await answerPrompt(io.io, optionOf(match, "3"), match)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["3"]]);
    const unread = new ClaudePane([A.full, new Error("the pane could not be read")]);
    expect(await answerPrompt(unread.io, optionOf(match, "1"), match)).toEqual({ type: "unsettled", now: null });
    expect(unread.sent).toEqual([["1"]]);
  });

  it("only the digit, in every sequence: never Enter, never Escape", async () => {
    const runs = [
      [A.full, A.after],
      [A.full, A.full],
      [A.full, A.twoChips],
      [A.marked2, A.after],
    ];
    for (const screens of runs) {
      const io = new ClaudePane(screens);
      await answerPrompt(io.io, optionOf(match, "2"), match);
      expect(io.sent).toEqual([["2"]]);
    }
  });
});

async function claudeSetup(screens: string[]) {
  const herdr = new FakeHerdr(snapshot(), { "w1:p1": screens, "w1:p2": [F.working] });
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
    binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Claude"),
    fingerprint: readingMatch(prompt().reading!)!.fingerprint,
    episode: prompt().episode,
    key,
  });
  const keys = (): string[][] => herdr.sent("pane.send_keys").map((params) => params["keys"] as string[]);
  return { herdr, registry, service, time, prompt, request, keys };
}

describe("the service on a Claude pane", () => {
  it("reads the dialog and never clears it as quiet", async () => {
    const context = await claudeSetup([A.full]);
    expect(readingMatch(context.prompt().reading!)?.kind).toBe("claudeAsk");
    context.time.t += 2_500;
    await context.service.tick();
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().cleared).toBe(false);
    expect(context.prompt().quiet).toBe(false);
    for (const text of [A.full, A.narrow]) {
      const once = afterRead(quietMarked, { startedAt: 2_000, text }, 1_000, "claude");
      expect(afterRead(once, { startedAt: 4_500, text }, 1_000, "claude")).toEqual(quietMarked);
    }
    expect(needsCardShown({ isAgent: true, status: "blocked", kind: "claude" }, null)).toBe(true);
  });

  it("an answer whose digit closes the dialog: sent, the digit only", async () => {
    const context = await claudeSetup([A.full, A.after]);
    expect(await context.service.answer(context.request("2"))).toEqual({ type: "sent", label: "Phone pricing only" });
    expect(context.keys()).toEqual([["2"]]);
  });

  it("the dialog still shown after the reads: Answer in Terminal, the digit once, this question answered once", async () => {
    const context = await claudeSetup([A.full, A.full]);
    const request = context.request("1");
    expect(await context.service.answer(request)).toEqual({
      type: "unsettled",
      label: labels[0],
      note: "Answer in Terminal: Claude’s screen did not show the answer take",
    });
    expect(context.keys()).toEqual([["1"]]);
    expect(await context.service.answer(request)).toMatchObject({ type: "refused" });
    expect(context.keys()).toEqual([["1"]]);
  });

  it("the question changed before the digit: Not sent, zero keys", async () => {
    const context = await claudeSetup([A.full]);
    const request = context.request("1");
    show(context.herdr, "w1:p1", A.full.replace("Phone pricing only", "Phone pricing first"));
    expect(await context.service.answer(request)).toMatchObject({ type: "changed" });
    expect(context.keys()).toEqual([]);
  });
});

// From a review: a row number
// is 1 to 11 or the screen is unmatched; one cell count for this reader on both
// apps; the card's labels break inside it. The same fixtures and expected
// readings as CompanionClaudeAskFixPassTests in CompanionClaudeAskTests.swift.
describe("row numbers, one width rule, whole labels", () => {
  it("a row number outside 1 to 11 is no row of the dialog: unmatched, shown as today (the huge one included)", () => {
    expect(claudeAskRowLimit).toBe(11);
    const shapes: Record<string, string> = {
      "9223372036854775807 on Type something and Chat about this": A.overflowNumber,
      "100 and 101": A.numberThreeDigit,
      "12 and 13": A.numberTwelve,
      "options from 0": A.numberZero,
    };
    for (const [name, text] of Object.entries(shapes)) {
      expect(claudeAsk(text, pane), name).toBeNull();
      for (const kind of ["claude", null]) expect(matchPrompt(text, pane, kind), `${name} (${kind})`).toEqual(today(text));
    }
  });

  it("the cell count: every code point 1, a wide one 2; a joiner and a combining mark 1 each, never fewer than drawn", () => {
    expect(claudeAskCells("─".repeat(80))).toBe(80);
    expect(claudeAskCells("Choice 2")).toBe(8);
    expect(claudeAskCells("界")).toBe(2);
    expect(claudeAskCells("\u{1F469}\u200D\u{1F4BB}")).toBe(5);
    expect(claudeAskCells("e\u0301")).toBe(2);
    expect(claudeAskCells("한")).toBe(2);
    expect(claudeAskCells("Ａ")).toBe(2);
    expect(claudeAskCells("\u{20000}")).toBe(2);
    expect(claudeAskCells("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe(49);
  });

  it("joined emoji, combining marks and a wide label over a five-cell row: unmatched, the same reading as the phone's", () => {
    for (const [name, text] of Object.entries({ zwj: A.zwjWidth, combining: A.combiningWidth, wide: A.wideLabelWrap })) {
      expect(claudeAsk(text, pane), name).toBeNull();
      expect(matchPrompt(text, pane, "claude").type, name).toBe("unmatched");
      expect(matchPrompt(text, pane, null).type, name).toBe("unmatched");
    }
  });

  it("two long labels that differ only at their end: both whole in the match", () => {
    const match = ask(A.longLabels);
    expect(match.options.map((option) => option.label)).toEqual([
      "Deploy the current build after applying the queued migrations and restarting the affected background workers in the staging environment",
      "Deploy the current build after applying the queued migrations and restarting the affected background workers in the production environment",
      "Nothing now",
    ]);
    expect(ask(A.longUnbroken).options.map((option) => option.label)).toEqual(["a".repeat(140) + "STAGING", "a".repeat(140) + "PRODUCTION", "Nothing now"]);
  });
});

describe("the card's labels break inside it, this kind's only", () => {
  const host = { id: "box", name: "build-box", state: "connected" } as unknown as HostView;
  const rowOf = (kind: string): SidebarRow => ({ paneID: pane, isAgent: true, status: "blocked", kind, name: "tidepool" }) as unknown as SidebarRow;
  const previous = (globalThis as { window?: unknown }).window;
  const bridge: Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt"> = {
    listPrompts: () => Promise.resolve([]),
    onPromptsChanged: () => () => undefined,
    answerPrompt: () => Promise.resolve({ type: "sent", label: "Nothing now" }),
  };
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { herdrDesktop: bridge };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = previous;
    needsCards.receive([]);
  });
  const render = (text: string, kind: string): string => {
    needsCards.receive([{ hostId: "box", paneId: pane, episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading: matchPrompt(text, pane, kind), quiet: false, cleared: false }]);
    return renderToStaticMarkup(createElement(NeedsCard, { host, row: rowOf(kind), onShowTerminal: () => undefined }));
  };

  it("Claude's question dialog: every label carries the wrap class, the long unbroken ones whole", () => {
    const html = render(A.longUnbroken, "claude");
    expect(html).toContain(`<span class="l wrap">${"a".repeat(140)}STAGING</span>`);
    expect(html).toContain(`<span class="l wrap">${"a".repeat(140)}PRODUCTION</span>`);
    expect(html).toContain('<span class="l wrap">Nothing now</span>');
    expect(html).not.toContain('<span class="l">');
  });

  it("every other kind's card: the label span exactly as before, no wrap class", () => {
    for (const [text, kind] of [[F.claudeEdit, "claude"], [F.claudeBash, "claude"], [F.grokMenu, "grok"], [C.four, "codex"]] as const) {
      const html = render(text, kind);
      expect(html, kind).toContain('<span class="l">');
      expect(html, kind).not.toContain("l wrap");
    }
  });
});
