// Codex 0.171.0's own question in Plan mode (its request_user_input tool,
// codex-rs/tui/src/bottom_pane/request_user_input/) and its "Implement this
// plan?" list after a plan (chatwidget/plan_implementation.rs) as the Needs
// card, on a Codex pane only. The eight recorded screens and the screens built
// from their rows are the files in Tests/HerdrCompanionTests/Fixtures/
// CodexQuestion; their expected readings are that folder's codex-0.171.0-question-expected.json, the
// one table this file and Tests/HerdrCompanionTests/CompanionCodexQuestionTests.swift
// both check.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import { PromptService } from "../src/main/prompt/prompts";
import { NeedsCard } from "../src/renderer/chat/NeedsCard";
import { needsCards } from "../src/renderer/chat/needs-card-store";
import { stopBindingOf } from "../src/shared/agent-stop";
import type { HerdrDesktopBridge, HostView } from "../src/shared/ipc-contract";
import { needsPillKind } from "../src/shared/needs-pill";
import { answerPrompt, grokSettleReads, type PaneIO } from "../src/shared/prompt/answerer";
import { cardContent, codexFlowLine, codexOtherLine, codexPlanLine, codexProgressLine, keyHint } from "../src/shared/prompt/card";
import {
  codexForm,
  codexPlan,
  codexPlanTrace,
  codexQuestion,
  codexQuestionFooters,
  codexQuestionNext,
  codexQuestionTrace,
  codexUpdatePrompt,
  matchPrompt,
  readingMatch,
  sameFingerprint,
  type PromptMatch,
} from "../src/shared/prompt/matcher";
import { afterRead, marked as quietMarked, promptLike } from "../src/shared/prompt/quiet";
import { refusalRecord } from "../src/shared/prompt/refusals";
import type { AnswerRequest, PanePrompt } from "../src/shared/prompt/view";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { C, CO, CQ, codexQuestionExpected, E, F, L } from "./support/prompt-fixtures";
import { backend, clock, FakeHerdr, show, snapshot } from "./support/prompt-herdr";

const pane = "w1:p1";

function read(text: string, kind: string | null = "codex", columns: number | null = 120): PromptMatch | null {
  return readingMatch(matchPrompt(text, pane, kind, columns));
}

function matched(text: string): PromptMatch {
  const match = read(text);
  if (match === null) throw new Error("not matched");
  return match;
}

const rowOf = (text: string, start: string): number => text.split("\n").findIndex((row) => row.startsWith(start));
const fixtureName: Record<string, string> = {
  q1of2: "1of2",
  q2of2: "2of2",
  notes: "2of2-notes",
  long1of2: "long-1of2",
  long1of2Answered: "long-1of2-answered",
  long2of2: "long-2of2-after-digit",
  afterAll: "after-all-answered",
  wrappedQuestion: "built-wrapped-question",
  nine: "built-nine",
  ten: "built-ten",
  one: "built-one",
  lookalike: "built-lookalike",
  confirm: "built-confirm",
  after: "built-after",
  planAfterImplement: "built-plan-after-implement",
  planAfterFresh: "built-plan-after-fresh",
  planAfterStay: "built-plan-after-stay",
  planNarrow: "built-plan-narrow",
  permissionsList: "built-permissions-list",
};

/** A reading as the shared table writes it. */
function tableRow(match: PromptMatch | null): unknown {
  if (match === null) return null;
  const card = cardContent(match, "codex");
  return {
    kind: match.kind,
    question: match.question,
    progress: match.codexProgress ?? null,
    options: match.options.map((option) => ({ key: option.key, label: option.label, detail: option.detail, marked: option.isReturnDefault, keys: option.keys })),
    fingerprint: { question: match.fingerprint.question, body: match.fingerprint.body, options: match.fingerprint.options, words: match.fingerprint.words },
    card: { header: card.header, progress: card.progress, flow: card.flow, ownAnswer: card.ownAnswer, returnIndex: card.returnIndex },
  };
}

describe("the recorded and built screens, read on a Codex pane at 120 columns: the shared table", () => {
  it("every file has its row, and every row is what the reader reads", () => {
    expect(Object.keys(codexQuestionExpected).sort()).toEqual(Object.values(fixtureName).sort());
    for (const [key, name] of Object.entries(fixtureName)) {
      expect({ name, row: tableRow(read(CQ[key as keyof typeof CQ])) }).toEqual({ name, row: codexQuestionExpected[name] });
    }
  });

  it("question 1 of 2: the question, three asked options with their descriptions, Codex's own last row not among them", () => {
    const match = matched(CQ.q1of2);
    expect(match.kind).toBe("codexQuestion");
    expect(match.question).toBe("Which name should the tiny note file have?");
    expect(match.codexProgress).toEqual({ index: 1, total: 2, unanswered: 2 });
    expect(match.options.map((option) => [option.key, option.label, option.detail])).toEqual([
      ["1", "note (Recommended)", "Use the simple base name “note”."],
      ["2", "quick-note", "Use the base name “quick-note”."],
      ["3", "memo", "Use the base name “memo”."],
    ]);
    expect(match.options.some((option) => option.label === "None of the above")).toBe(false);
    // The digit alone answers each; none opens the box or lasts.
    expect(match.options.map((option) => option.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(match.options.some((option) => option.isSessionWide || option.opensComposer)).toBe(false);
    // The fingerprint keeps Codex's own last row (the frame's rows, the mark left out).
    expect(match.fingerprint.options).toEqual([
      "    1. note (Recommended)  Use the simple base name “note”.",
      "    2. quick-note          Use the base name “quick-note”.",
      "    3. memo                Use the base name “memo”.",
      "    4. None of the above   Optionally, add details in notes (tab)",
    ]);
    expect(match.fingerprint.body).toEqual(["  Question 1/2 (2 unanswered)", "  Which name should the tiny note file have?"]);
  });

  it("long descriptions: each one's wrapped rows join its option, word for word (general-purpose kept whole)", () => {
    const match = matched(CQ.long1of2);
    expect(match.options.map((option) => option.detail)).toEqual([
      "Use the simple base name “note” to make the file easy to recognize as a small, general-purpose note. This name leaves the subject open and works well when the file contains just a few lines of text.",
      "Use the base name “quick-note” to emphasize that the file is meant for a brief thought, reminder, or observation. It gives the file a clear purpose while keeping the name short and easy to scan in a folder.",
      "Use the base name “scratchpad” to suggest a casual place for temporary thoughts, rough wording, or small reminders. This name suits a tiny note that can evolve freely without implying a polished document.",
    ]);
    expect(match.fingerprint.options).toHaveLength(10);
  });

  it("the answered question (the cursor on 2, one unanswered) reads as question 1 again, nothing marking it answered", () => {
    const answered = matched(CQ.long1of2Answered);
    const fresh = matched(CQ.long1of2);
    expect(answered.kind).toBe("codexQuestion");
    expect(answered.question).toBe(fresh.question);
    expect(answered.options.map((option) => [option.label, option.detail])).toEqual(fresh.options.map((option) => [option.label, option.detail]));
    // Only Codex's cursor (Return's) and its count differ; the count is part of the question it is bound to.
    expect(answered.options.filter((option) => option.isReturnDefault).map((option) => option.key)).toEqual(["2"]);
    expect(answered.codexProgress).toEqual({ index: 1, total: 2, unanswered: 1 });
    expect(sameFingerprint(answered.fingerprint, fresh.fingerprint)).toBe(false);
    expect(cardContent(answered, "codex").progress).toBe("Question 1 of 2");
  });

  it("the notes row open is not matched (a digit would be typed into the notes)", () => {
    expect(codexQuestion(CQ.notes, pane, 120)).toBeNull();
    expect(matchPrompt(CQ.notes, pane, "codex", 120).type).toBe("unmatched");
    // Its footer alone on the question frame, or the notes row alone, is not matched either.
    const footer = rowOf(CQ.q2of2, "  tab to add notes");
    expect(codexQuestion(E.row(CQ.q2of2, footer, () => "  tab or esc to clear notes | enter to submit all"), pane)).toBeNull();
    expect(codexQuestion(E.inserting(CQ.q2of2, ["  › Add notes", ""], footer), pane)).toBeNull();
  });

  it("after the last answer: the plan question matches, and nothing above it (the answered questions) is read as one", () => {
    const match = matched(CQ.afterAll);
    expect(match.kind).toBe("codexPlan");
    expect(codexQuestion(CQ.afterAll, pane, 120)).toBeNull();
    expect(match.question).toBe("Implement this plan?");
    expect(match.options.map((option) => [option.key, option.label, option.detail, option.keys])).toEqual([
      ["1", "Yes, implement this plan", "Switch to Default and start coding", ["1"]],
      ["2", "Yes, clear context and implement", "Start a fresh thread (current context: 4% used)", ["2"]],
      ["3", "No, stay in Plan mode", "Continue planning with the model", ["3"]],
    ]);
    expect(match.fingerprint.body).toEqual(["  Implement this plan?"]);
  });

  it("a question wrapped over two rows is read whole; two options; nine rows; a look-alike list above the frame", () => {
    expect(matched(CQ.wrappedQuestion).question).toBe(
      "Which name should the tiny note file have, given that it holds a short reminder you will read again tomorrow morning before the stand-up meeting and then throw away once the day is over?",
    );
    expect(matched(CQ.q2of2).options.map((option) => option.label)).toEqual(["Markdown (Recommended)", "Plain text"]);
    expect(matched(CQ.nine).options.map((option) => option.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    const look = matched(CQ.lookalike);
    expect(look.options.map((option) => option.label)).toEqual(["note (Recommended)", "quick-note", "memo"]);
    expect(look.fingerprint).toEqual(matched(CQ.q1of2).fingerprint);
  });

  it("ten rows (Codex numbers the tenth 10.), one asked option, a clipped header, a footer one character off: unmatched", () => {
    expect(codexQuestion(CQ.ten, pane)).toBeNull();
    // One asked option (and Codex's own row): not the two the frame needs.
    const q2 = CQ.q2of2;
    const one = E.removing(q2, rowOf(q2, "    2. Plain text"), rowOf(q2, "    2. Plain text") + 1).replace("    3. None of the above", "    2. None of the above");
    expect(codexQuestion(one, pane)).toBeNull();
    // No Codex row, or a row out of order.
    expect(codexQuestion(q2.replace("    3. None of the above       Optionally, add details in notes (tab)", "    3. Other                   Optionally, add details in notes (tab)"), pane)).toBeNull();
    expect(codexQuestion(q2.replace("    2. Plain text", "    3. Plain text"), pane)).toBeNull();
    // The header pushed off the top: the read starts at the question, or at the header itself (its padding row cut).
    const rows = CQ.q1of2.split("\n");
    const header = rows.findIndex((row) => row.startsWith("  Question 1/2"));
    expect(codexQuestion(rows.slice(header + 1).join("\n"), pane)).toBeNull();
    expect(codexQuestion(rows.slice(header).join("\n"), pane)).toBeNull();
    // The footer one character off, another footer for this question, or a row under it.
    const footer = rowOf(CQ.q1of2, "  tab to add notes");
    for (const other of [
      "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt.",
      "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interupt",
      "  Tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
      `  ${codexQuestionFooters.last}`,
      `  ${codexQuestionFooters.only}`,
      "  option 1/4 | tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
    ]) {
      expect(codexQuestion(E.row(CQ.q1of2, footer, () => other), pane)).toBeNull();
    }
    expect(codexQuestion(`${CQ.q1of2}  • Working (1s • esc to interrupt)\n`, pane)).toBeNull();
    // The header without its count (every question answered), or numbers that cannot be.
    for (const other of ["  Question 1/2", "  Question 3/2 (1 unanswered)", "  Question 1/2 (3 unanswered)", "  Question 1/2 (0 unanswered)"]) {
      expect(codexQuestion(E.row(CQ.q1of2, header, () => other), pane)).toBeNull();
    }
    // Two marks, or none (Codex then draws no "tab to add notes").
    expect(codexQuestion(CQ.q1of2.replace("    2. quick-note", "  › 2. quick-note"), pane)).toBeNull();
    expect(codexQuestion(CQ.q1of2.replace("  › 1. note", "    1. note"), pane)).toBeNull();
  });

  it("one question asked alone (Codex's source: no ←/→ in its footer): matched, said once", () => {
    const match = matched(CQ.one);
    expect(match.codexProgress).toEqual({ index: 1, total: 1, unanswered: 1 });
    const content = cardContent(match, "codex");
    expect(content.progress).toBeNull();
    expect(content.flow).toBe("Your answer goes to Codex at once.");
    // The two-question footer under one question alone is not its frame.
    expect(codexQuestion(CQ.one.replace(codexQuestionFooters.only, codexQuestionFooters.next), pane)).toBeNull();
  });

  it("read on a Codex pane only: the same rows on a Claude Code, Antigravity, Shell, Cursor or unknown pane are not matched", () => {
    for (const text of [CQ.q1of2, CQ.q2of2, CQ.long1of2, CQ.afterAll, CQ.one]) {
      expect(read(text)).not.toBeNull();
      for (const kind of ["claude", "agy", "shell", "cursor", "grok", null]) {
        const reading = matchPrompt(text, pane, kind, 120);
        expect(reading.type).toBe("unmatched");
      }
    }
  });

  it("the plan question: only under its own title, its words and order; the permissions list and other lists stay unmatched", () => {
    expect(codexPlan(CQ.permissionsList, pane)).toBeNull();
    expect(read(CQ.permissionsList)).toBeNull();
    expect(matched(CQ.planNarrow).options.map((option) => option.detail)).toEqual(matched(CQ.afterAll).options.map((option) => option.detail));
    const title = rowOf(CQ.afterAll, "  Implement this plan?");
    for (const other of ["  Update Model Permissions", "  Implement this plan", "  Implement the plan?"]) {
      expect(codexPlan(E.row(CQ.afterAll, title, () => other), pane)).toBeNull();
    }
    // A row disabled by Codex is drawn without its number; a description or label not Codex's; two marks.
    expect(codexPlan(CQ.afterAll.replace("  2. Yes, clear context", "     Yes, clear context"), pane)).toBeNull();
    expect(codexPlan(CQ.afterAll.replace("Switch to Default and start coding", "Switch to Default and start codin"), pane)).toBeNull();
    expect(codexPlan(CQ.afterAll.replace("  3. No, stay in Plan mode", "› 3. No, stay in Plan mode"), pane)).toBeNull();
    // The other description Codex draws for option 2 (no context use known).
    expect(codexPlan(CQ.afterAll.replace("Start a fresh thread (current context: 4% used)", "Fresh thread with this plan"), pane)?.options[1]?.detail).toBe("Fresh thread with this plan");
    // The footer one character off, three blank rows between the title and the rows, a row under the footer.
    const footer = rowOf(CQ.afterAll, "  enter select");
    expect(codexPlan(E.row(CQ.afterAll, footer, () => "  enter select · esc bac"), pane)).toBeNull();
    expect(codexPlan(E.inserting(CQ.afterAll, [""], title + 1), pane)).toBeNull();
    expect(codexPlan(`${CQ.afterAll}  • Working (1s • esc to interrupt)\n`, pane)).toBeNull();
  });

  it("the cursor moved (an arrow pressed in the Terminal): the same question, Return's option where the mark is", () => {
    const plan = matched(CQ.afterAll);
    const moved = matched(CQ.afterAll.replace("› 1. Yes, implement", "  1. Yes, implement").replace("  3. No, stay in Plan mode", "› 3. No, stay in Plan mode"));
    expect(moved.kind).toBe("codexPlan");
    expect(moved.options.filter((option) => option.isReturnDefault).map((option) => option.key)).toEqual(["3"]);
    expect(moved.fingerprint).toEqual(plan.fingerprint);
    const question = matched(CQ.q1of2);
    const down = matched(CQ.q1of2.replace("  › 1. note", "    1. note").replace("    3. memo", "  › 3. memo"));
    expect(down.options.filter((option) => option.isReturnDefault).map((option) => option.key)).toEqual(["3"]);
    expect(down.fingerprint).toEqual(question.fingerprint);
  });

  it("every existing Codex frame reads as before: neither reader takes it", () => {
    const screens = [...Object.values(C), ...Object.values(CO), L.codex0_163_0Dialog, L.codex0_163_0Narrow51Dialog, L.codex0_163_0AfterNo, L.codex0_163_0IdleField, F.codexCommand, F.codexYesNo, F.codexInput];
    for (const text of screens) {
      expect(codexQuestion(text, pane)).toBeNull();
      expect(codexPlan(text, pane)).toBeNull();
    }
    expect(readingMatch(matchPrompt(C.four, pane, "codex"))?.kind).toBe("codexForm");
    expect(readingMatch(matchPrompt(L.codex0_163_0Dialog, pane, "codex"))?.kind).toBe("menu");
    // And the new screens are none of the old frames.
    for (const text of Object.values(CQ)) {
      expect(codexForm(text, pane)).toBeNull();
      expect(codexUpdatePrompt(text, pane)).toBeNull();
    }
  });
});

describe("the card, in Codex's words", () => {
  it("question 1 of 2: Codex asks, where it stands, its options with descriptions, where the answer goes, None of the above in the Terminal", () => {
    const content = cardContent(matched(CQ.q1of2), "codex");
    expect(content.kind).toBe("asks");
    expect(content.header).toBe("Codex asks");
    expect(content.progress).toBe("Question 1 of 2");
    expect(content.question).toBe("Which name should the tiny note file have?");
    expect(content.flow).toBe("Your answer moves Codex on to question 2.");
    expect(content.ownAnswer).toBe(codexOtherLine);
    expect(content.options.map((option) => option.label)).toEqual(["note (Recommended)", "quick-note", "memo"]);
    expect(content.returnIndex).toBe(0);
    expect(keyHint(content)).toBe("↑ ↓ to choose · Return picks");
    expect(needsPillKind(matched(CQ.q1of2))).toBe("input");
  });

  it("the last question with one unanswered says what is true whichever question that is", () => {
    const line = "This answers question 2. Codex then sends all 2 answers, or asks in the Terminal first if another question still has no answer.";
    // This question is the one unanswered (question 1 answered by its digit): the recorded screen.
    expect(cardContent(matched(CQ.long2of2), "codex").flow).toBe(line);
    // Question 1 is the one unanswered (skipped with →) and this one was answered, then Esc from Codex's
    // confirmation: the same header, the cursor on the chosen row.
    const answeredBefore = CQ.long2of2.replace("  › 1. Plain text", "    1. Plain text").replace("    2. Markdown   ", "  › 2. Markdown   ");
    expect(answeredBefore).not.toBe(CQ.long2of2);
    expect(matched(answeredBefore).codexProgress).toEqual({ index: 2, total: 2, unanswered: 1 });
    expect(cardContent(matched(answeredBefore), "codex").flow).toBe(line);
    expect(codexFlowLine({ index: 3, total: 3, unanswered: 1 })).toBe(
      "This answers question 3. Codex then sends all 3 answers, or asks in the Terminal first if another question still has no answer.",
    );
  });

  it("the last question says the tap answers it and Codex then sends them all or asks first, or (another unanswered) that Codex asks in the Terminal first", () => {
    // One unanswered may be this question or an earlier one (this one answered before); the line says both.
    expect(cardContent(matched(CQ.long2of2), "codex").flow).toBe(
      "This answers question 2. Codex then sends all 2 answers, or asks in the Terminal first if another question still has no answer.",
    );
    expect(cardContent(matched(CQ.q2of2), "codex").flow).toBe("Another question has no answer yet: Codex will ask in the Terminal before it sends.");
    expect(codexProgressLine({ index: 3, total: 4, unanswered: 2 })).toBe("Question 3 of 4");
    expect(codexFlowLine({ index: 3, total: 4, unanswered: 2 })).toBe("Your answer moves Codex on to question 4.");
  });

  it("the plan question: both Yes choices said to start the work; an input pill", () => {
    const content = cardContent(matched(CQ.afterAll), "codex");
    expect(content.header).toBe("Codex asks");
    expect(content.question).toBe("Implement this plan?");
    expect(content.flow).toBe(codexPlanLine);
    expect(codexPlanLine).toBe("Either Yes starts the work now. No keeps Codex in Plan mode.");
    expect(content.progress).toBeNull();
    expect(content.ownAnswer).toBeNull();
    expect(needsPillKind(matched(CQ.afterAll))).toBe("input");
  });
});

describe("the card rendered", () => {
  const host = { id: "box", name: "build-box", state: "connected" } as unknown as HostView;
  const codexRow = { paneID: "w1:p1", isAgent: true, status: "blocked", kind: "codex", name: "tidepool" } as unknown as SidebarRow;
  const previous = (globalThis as { window?: unknown }).window;
  const bridge: Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt"> = {
    listPrompts: () => Promise.resolve([]),
    onPromptsChanged: () => () => undefined,
    answerPrompt: () => Promise.resolve({ type: "sent", label: "quick-note" }),
  };
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { herdrDesktop: bridge };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = previous;
    needsCards.receive([]);
  });
  const shown = (text: string): PanePrompt => ({ hostId: "box", paneId: "w1:p1", episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading: matchPrompt(text, "w1:p1", "codex", 120), quiet: !promptLike(text, "codex"), cleared: false });
  const render = (): string => renderToStaticMarkup(createElement(NeedsCard, { host, row: codexRow, onShowTerminal: () => undefined }));

  it("question 1 of 2 with long descriptions: where it stands, each option whole, where it goes, Answer in Terminal for None of the above", () => {
    needsCards.receive([shown(CQ.long1of2)]);
    const html = render();
    expect(html).toContain('data-needs-card="asks"');
    expect(html).toContain('<span class="nc-t">Codex asks</span>');
    expect(html).toContain('<div class="nc-progress">Question 1 of 2</div><div class="nc-q">Which name should the tiny note file have?</div>');
    expect(html).toContain('<span class="k">1</span><span class="l wrap">note (Recommended)</span><span class="d">Use the simple base name “note” to make the file easy to recognize as a small, general-purpose note.');
    expect([...html.matchAll(/data-key="(\d)"/gu)].map((found) => found[1])).toEqual(["1", "2", "3"]);
    expect(html).not.toContain("None of the above</span>");
    expect(html).toContain('<div class="nc-flow">Your answer moves Codex on to question 2.</div>');
    expect(html).toContain("Answer in Terminal");
    expect(html).toContain(`<span class="nc-hint">${codexOtherLine}</span>`);
  });

  it("the plan question: three choices with descriptions and the line saying Yes starts the work; no Terminal line", () => {
    needsCards.receive([shown(CQ.afterAll)]);
    const html = render();
    expect(html).toContain('<div class="nc-q">Implement this plan?</div>');
    expect(html).toContain('<span class="l">Yes, implement this plan</span><span class="d">Switch to Default and start coding</span>');
    expect(html).toContain('<div class="nc-flow">Either Yes starts the work now. No keeps Codex in Plan mode.</div>');
    expect(html).not.toContain("nc-progress");
    expect(html).not.toContain("Answer in Terminal");
  });

  it("the notes row open: the unmatched card and Answer in Terminal, as before", () => {
    needsCards.receive([shown(CQ.notes)]);
    const html = render();
    expect(html).toContain('data-needs-card="unmatched"');
    expect(html).toContain("Answer in Terminal");
  });
});

/** A pane whose screens the test scripts (each read takes the next; the last stays), every key kept, no waiting. */
class CodexPane {
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
    columns: async () => 120,
  };
}

const optionOf = (match: PromptMatch, key: string) => match.options.find((option) => option.key === key)!;

// One key: the option's digit, after a fresh read shows the same frame. Then
// reads: the next question (N+1 of M, one fewer unanswered) or no part of the
// frame left proves it took; anything else is unsettled and nothing more goes.
describe("answering Codex's question: the digit once, then reads; never Return, an arrow, Tab or Esc", () => {
  it("question 1 answered: the next question (2 of 2, one unanswered) proves it", async () => {
    const match = matched(CQ.long1of2);
    for (const key of ["1", "2", "3"]) {
      const io = new CodexPane([CQ.long1of2, CQ.long2of2]);
      expect(await answerPrompt(io.io, optionOf(match, key), match)).toEqual({ type: "sent" });
      expect(io.sent).toEqual([[key]]);
      expect(io.reads).toBe(2);
    }
    expect(codexQuestionNext(match, matched(CQ.long2of2))).toBe(true);
  });

  it("the last question answered: the frame gone proves it (the plan question next, or Codex at work)", async () => {
    const last = matched(CQ.long2of2);
    for (const after of [CQ.afterAll, CQ.after]) {
      expect(codexQuestionTrace(after)).toBe(false);
      const io = new CodexPane([CQ.long2of2, after]);
      expect(await answerPrompt(io.io, optionOf(last, "2"), last)).toEqual({ type: "sent" });
      expect(io.sent).toEqual([["2"]]);
    }
    const one = matched(CQ.one);
    const io = new CodexPane([CQ.one, CQ.after]);
    expect(await answerPrompt(io.io, optionOf(one, "3"), one)).toEqual({ type: "sent" });
  });

  it("the same question still shown after the reads: unsettled (unknown, said), the digit once", async () => {
    const match = matched(CQ.long1of2);
    const io = new CodexPane([CQ.long1of2, CQ.long1of2]);
    const outcome = await answerPrompt(io.io, optionOf(match, "2"), match);
    expect(outcome.type).toBe("unsettled");
    if (outcome.type === "unsettled") expect(readingMatch(outcome.now!)?.fingerprint).toEqual(match.fingerprint);
    expect(io.sent).toEqual([["2"]]);
    expect(io.reads).toBe(1 + grokSettleReads);
  });

  it("another question that is not the next one answered (no count lower, or another M): unsettled at once", async () => {
    // Question 2 with both still unanswered (what Right shows, not a digit), and an answered question 1 answered again.
    const first = matched(CQ.q1of2);
    const io = new CodexPane([CQ.q1of2, CQ.q2of2]);
    expect((await answerPrompt(io.io, optionOf(first, "1"), first)).type).toBe("unsettled");
    expect(io.reads).toBe(2);
    const again = matched(CQ.long1of2Answered);
    const io2 = new CodexPane([CQ.long1of2Answered, CQ.long2of2]);
    expect((await answerPrompt(io2.io, optionOf(again, "3"), again)).type).toBe("unsettled");
    expect(io2.sent).toEqual([["3"]]);
  });

  it("Codex's confirmation, the notes row or a part of the frame after the digit is not proof: unsettled, nothing more", async () => {
    expect(codexQuestionTrace(CQ.confirm)).toBe(true);
    expect(codexQuestionTrace(CQ.notes)).toBe(true);
    const last = matched(CQ.q2of2);
    for (const after of [CQ.confirm, CQ.notes]) {
      const io = new CodexPane([CQ.q2of2, after]);
      expect((await answerPrompt(io.io, optionOf(last, "1"), last)).type).toBe("unsettled");
      expect(io.sent).toEqual([["1"]]);
      expect(io.reads).toBe(1 + grokSettleReads);
    }
    // Part of the frame, then the frame gone: kept reading, then sent.
    const io = new CodexPane([CQ.q2of2, CQ.confirm, CQ.after]);
    expect((await answerPrompt(io.io, optionOf(last, "1"), last)).type).toBe("sent");
  });

  it("the frame changed before the key (another question, the notes row opened, the frame gone): nothing sent, the refusal recorded", async () => {
    const match = matched(CQ.q2of2);
    for (const now of [CQ.q1of2, CQ.long2of2, CQ.notes, CQ.after, CQ.afterAll]) {
      const io = new CodexPane([now]);
      const heard: (PromptMatch | null)[] = [];
      const outcome = await answerPrompt(io.io, optionOf(match, "1"), match, () => true, (place, shownNow) => {
        expect(place).toBe("fresh");
        heard.push(shownNow);
      });
      expect(outcome.type).toBe("changed");
      expect(io.sent).toEqual([]);
      expect(heard).toHaveLength(1);
      const record = refusalRecord(0, "codex", "fresh", match, heard[0] ?? null);
      expect(record.part).toBe(heard[0] === null ? "none" : heard[0]!.kind === "codexQuestion" ? "question" : "kind");
    }
  });

  it("the gate refuses after the read: nothing sent", async () => {
    const match = matched(CQ.q1of2);
    const io = new CodexPane([CQ.q1of2, CQ.after]);
    expect(await answerPrompt(io.io, optionOf(match, "1"), match, () => false)).toEqual({ type: "withdrawn" });
    expect(io.sent).toEqual([]);
  });

  it("only the digit, in every sequence", async () => {
    const match = matched(CQ.q1of2);
    const runs: (string | Error)[][] = [
      [CQ.q1of2, CQ.after],
      [CQ.q1of2, CQ.q1of2],
      [CQ.q1of2, CQ.q2of2],
      [CQ.q1of2, CQ.notes],
      [CQ.q1of2, CQ.confirm],
      [CQ.q1of2, new Error("x")],
      [CQ.notes],
      [CQ.afterAll],
    ];
    for (const screens of runs) {
      const io = new CodexPane(screens);
      await answerPrompt(io.io, optionOf(match, "2"), match);
      expect(io.sent.length).toBeLessThanOrEqual(1);
      for (const keys of io.sent) expect(keys).toEqual(["2"]);
    }
  });
});

describe("answering Implement this plan?: the digit once, then reads until the list is gone", () => {
  const plan = (): PromptMatch => matched(CQ.afterAll);

  it("each option's digit, the list gone after it: sent", async () => {
    for (const [key, after] of [
      ["1", CQ.planAfterImplement],
      // Option 2 starts a fresh thread, its own after-screen.
      ["2", CQ.planAfterFresh],
      ["3", CQ.planAfterStay],
    ] as const) {
      expect(codexPlanTrace(after)).toBe(false);
      const io = new CodexPane([CQ.afterAll, after]);
      expect(await answerPrompt(io.io, optionOf(plan(), key), plan())).toEqual({ type: "sent" });
      expect(io.sent).toEqual([[key]]);
    }
  });

  it("the list still shown: unsettled, the digit once; a narrow pane's reading of the same list is the same question", async () => {
    const io = new CodexPane([CQ.afterAll, CQ.afterAll]);
    expect((await answerPrompt(io.io, optionOf(plan(), "1"), plan())).type).toBe("unsettled");
    expect(io.sent).toEqual([["1"]]);
    expect(sameFingerprint(matched(CQ.planNarrow).fingerprint, plan().fingerprint)).toBe(false);
  });

  it("a changed frame before the key (the permissions list, another description, a question): nothing sent", async () => {
    for (const now of [CQ.permissionsList, CQ.afterAll.replace("4% used", "5% used"), CQ.q1of2, CQ.planAfterStay]) {
      const io = new CodexPane([now]);
      expect((await answerPrompt(io.io, optionOf(plan(), "2"), plan())).type).toBe("changed");
      expect(io.sent).toEqual([]);
    }
  });
});

async function codexSetup(screens: string[]) {
  const json = snapshot();
  const panes = json["panes"] as Record<string, unknown>[];
  const agents = json["agents"] as Record<string, unknown>[];
  panes[0]!["agent"] = "codex";
  agents[0]!["agent"] = "codex";
  agents[0]!["agent_session"] = { source: "herdr:codex", agent: "codex", kind: "id", value: "c-1" };
  const herdr = new FakeHerdr(json, { "w1:p1": screens, "w1:p2": [F.working] });
  herdr.columns = [120];
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
    binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Codex"),
    fingerprint: readingMatch(prompt().reading!)!.fingerprint,
    episode: prompt().episode,
    key,
  });
  const keys = (): string[][] => herdr.sent("pane.send_keys").map((params) => params["keys"] as string[]);
  return { herdr, registry, service, time, prompt, request, keys };
}

describe("the service on a Codex pane (the fake Herdr)", () => {
  it("reads the question, answers question 1 with its digit, then question 2 arrives as its own card and is answered", async () => {
    const context = await codexSetup([CQ.long1of2, CQ.long2of2, CQ.after]);
    expect(readingMatch(context.prompt().reading!)?.kind).toBe("codexQuestion");
    expect(await context.service.answer(context.request("2"))).toEqual({ type: "sent", label: "quick-note" });
    expect(context.keys()).toEqual([["2"]]);
    context.time.t += 2_500;
    await context.service.tick();
    const next = readingMatch(context.prompt().reading!)!;
    expect(next.codexProgress).toEqual({ index: 2, total: 2, unanswered: 1 });
    expect(await context.service.answer(context.request("1"))).toEqual({ type: "sent", label: "Plain text (Recommended)" });
    expect(context.keys()).toEqual([["2"], ["1"]]);
  });

  it("the question changed before the digit: Not sent, zero keys, the refusal recorded for Report a Problem", async () => {
    const context = await codexSetup([CQ.q1of2]);
    const request = context.request("1");
    show(context.herdr, "w1:p1", CQ.notes);
    expect(await context.service.answer(request)).toMatchObject({ type: "changed" });
    expect(context.keys()).toEqual([]);
    expect(context.service.refusals.list().map((refusal) => [refusal.agent, refusal.part])).toContainEqual(["codex", "none"]);
  });

  it("the same question after the digit: Answer in Terminal said, one key, and a second tap sends nothing", async () => {
    const context = await codexSetup([CQ.q1of2, CQ.q1of2]);
    const request = context.request("3");
    expect(await context.service.answer(request)).toEqual({ type: "unsettled", label: "memo", note: "Answer in Terminal: Codex’s screen did not show the answer take" });
    expect(await context.service.answer(request)).toMatchObject({ type: "refused" });
    expect(context.keys()).toEqual([["3"]]);
  });

  it("Implement this plan? from the card: the digit, the list gone", async () => {
    const context = await codexSetup([CQ.afterAll, CQ.planAfterImplement]);
    expect(readingMatch(context.prompt().reading!)?.kind).toBe("codexPlan");
    expect(await context.service.answer(context.request("1"))).toEqual({ type: "sent", label: "Yes, implement this plan" });
    expect(context.keys()).toEqual([["1"]]);
  });

  it("the question and the plan list keep the needs-you mark on a Codex pane (the quiet rule)", () => {
    for (const text of [CQ.q1of2, CQ.long1of2, CQ.notes, CQ.afterAll, CQ.confirm]) {
      expect(promptLike(text, "codex")).toBe(true);
      const once = afterRead(quietMarked, { startedAt: 2_000, text }, 1_000, "codex");
      expect(afterRead(once, { startedAt: 4_500, text }, 1_000, "codex")).toEqual(quietMarked);
    }
    expect(promptLike(CQ.after, "codex")).toBe(false);
  });
});
