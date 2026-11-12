// A Claude frame whose
// header is above even the taller read is never answerable in Chat: main
// keeps it unmatched however often it reads it, the card is Answer in
// Terminal with no buttons, and an answer sent for it all the same gets no key
// to the pane. What the card may say of it is Chat's running call, under a
// label that says so, and only when exactly one call agrees with the screen.
// Every command, transcript and pane here is invented; the service runs on a
// fake Herdr.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { NeedsCard } from "../src/renderer/chat/NeedsCard";
import { needsCards } from "../src/renderer/chat/needs-card-store";
import { stopBindingOf } from "../src/shared/agent-stop";
import { bashDetail, makeTurn, toolCall, type ChatItem, type ChatToolCall } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import { fingerprintRules, readingCut, readingMatch, type PromptReading } from "../src/shared/prompt/matcher";
import { pendingToolCalls } from "../src/shared/prompt/subject";
import type { AnswerRequest } from "../src/shared/prompt/view";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { setup, show } from "./support/prompt-herdr";
import { heredoc, longDiff, tallBash, tallDescription, tallEdit, yesNo } from "./support/tall-prompts";

const commandA = heredoc(250);
/** The same command with another first line: the last 200 rows of its frame are commandA's. */
const commandB = ["cd /synthetic/other-target; python3 -I - <<'EOF'", ...commandA.slice(1)];
const frameA = tallBash(commandA);

/** Printed output shaped like Claude's frame cut off at its top: command-like rows, a dashed rule, the question, Yes/No, the footer. */
const printed = [...commandA.map((row) => ` ${row}`), "╌".repeat(131), " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\n");

const bash = (rows: readonly string[], fields: Partial<ChatToolCall> = {}): ChatToolCall => {
  const command = rows.join("\n");
  return { ...toolCall(`toolu_${command.length}`, "bash", "Bash", command, { detail: { type: "bash", bash: bashDetail(command) } }), ...fields };
};
const edit = (file: string): ChatToolCall => toolCall(`toolu_${file}`, "edit", "Edit", file);
const item = (value: ChatToolCall): ChatItem => ({ type: "toolCall", value });

type Setup = Awaited<ReturnType<typeof setup>>;

/** The pane shows `screen`; main reads it three times (592d00b4 offered a cut Yes/No after two alike). */
async function readThrice(screen: string): Promise<Setup> {
  const context = await setup(screen);
  await context.service.tick();
  await context.service.tick();
  return context;
}

const reading = (context: Setup): PromptReading => context.service.list().find((prompt) => prompt.paneId === "w1:p1")!.reading!;

/**
 * The answer a page could send for what it was shown: a matched card's request
 * (592d00b4's cut Yes/No), or, with no match to answer, one bound to the
 * screen's rows as that Yes/No's was, so the service is asked all the same.
 */
function answerFor(context: Setup, key: string): AnswerRequest {
  if (readingMatch(reading(context)) !== null) return context.request(key);
  const prompt = context.service.list().find((each) => each.paneId === "w1:p1")!;
  const cut = readingCut(prompt.reading)!;
  return {
    hostId: "mac",
    paneId: "w1:p1",
    binding: stopBindingOf(context.registry.list()[0]!, "w1:p1", "Claude"),
    fingerprint: { rules: fingerprintRules, paneID: "w1:p1", question: cut.question, body: cut.rows, options: ["❯ 1. Yes", "2. No"] },
    episode: prompt.episode,
    key,
  };
}

/** Unmatched after three reads, and an answer for it sends no key (after `change`, if any). */
async function neverAnswered(screen: string, change: ((context: Setup) => void) | null = null): Promise<Setup> {
  const context = await readThrice(screen);
  expect(reading(context).type).toBe("unmatched");
  const asked = answerFor(context, "1");
  change?.(context);
  const result = await context.service.answer(asked);
  expect(result.type).not.toBe("sent");
  expect(context.herdr.sent("pane.send_keys")).toEqual([]);
  return context;
}

const host = { id: "mac", name: "Mac mini", state: "connected" } as unknown as HostView;
const row = { paneID: "w1:p1", isAgent: true, status: "blocked", kind: "claude", name: "beacon" } as unknown as SidebarRow;

/** The card as the page draws it for `shown`, with Chat's running calls `pending`. */
function card(shown: PromptReading, pending: readonly ChatToolCall[]): string {
  (globalThis as { window?: unknown }).window = { herdrDesktop: { listPrompts: () => Promise.resolve([]), onPromptsChanged: () => () => undefined } };
  needsCards.receive([{ hostId: "mac", paneId: "w1:p1", episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading: shown, quiet: false, cleared: false }]);
  return renderToStaticMarkup(createElement(NeedsCard, { host, row, onShowTerminal: () => undefined, pending }));
}

/** Answer in Terminal under "Claude Code needs you", no option buttons, never "wants to". */
function terminalOnly(page: string): void {
  expect(page).toContain('data-needs-card="unmatched"');
  expect(page).toContain('<span class="nc-t">Claude Code needs you</span>');
  expect(page).toContain("Answer in Terminal");
  expect(page).not.toContain("nc-opt");
  expect(page).not.toContain("wants to");
}

const label = '<div class="nc-from">Chat’s running call, not read from the question:</div>';

describe("a frame whose header is off screen is never answered in Chat", () => {
  const previous = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    needsCards.receive([]);
    (globalThis as { window?: unknown }).window = previous;
  });

  it("hidden-head change: the command's first line changes above the 200 rows read; no key goes", async () => {
    const context = await neverAnswered(frameA, ({ herdr }) => show(herdr, "w1:p1", tallBash(commandB)));
    terminalOnly(card(reading(context), [bash(commandA)]));
  });

  it("a failed read between two alike does not make it answerable", async () => {
    const context = await setup(frameA);
    context.herdr.readFails = true;
    await context.service.tick();
    context.herdr.readFails = false;
    await context.service.tick();
    await context.service.tick();
    expect(reading(context).type).toBe("unmatched");
    expect((await context.service.answer(answerFor(context, "1"))).type).not.toBe("sent");
    expect(context.herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("printed output shaped like a cut approval: Answer in Terminal, no key", async () => {
    const context = await neverAnswered(printed);
    // It looks like Claude's frame, so the pill says approval and Chat's agreeing call may be shown, labelled; it answers nothing.
    const page = card(reading(context), [bash(commandA)]);
    terminalOnly(page);
    expect(page).toContain(label);
  });

  it("a printed code block whose opening scrolled away above the read: Answer in Terminal, no key", async () => {
    const context = await neverAnswered(["⏺ Example, printed as source:", "```text", printed].join("\n"));
    terminalOnly(card(reading(context), [bash(commandA)]));
  });

  it("Claude's own two-option edit frame cut off at its top: Answer in Terminal, no key", async () => {
    const context = await neverAnswered(tallEdit(longDiff(150), yesNo));
    terminalOnly(card(reading(context), [edit("desktop/src/probe/summary.ts")]));
  });
});

describe("what the card says of it, and from where", () => {
  const previous = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    needsCards.receive([]);
    (globalThis as { window?: unknown }).window = previous;
  });

  it("the one agreeing call: under its label, its description and first lines over the screen's rows; never buttons", async () => {
    const context = await neverAnswered(frameA);
    const page = card(reading(context), [bash(commandA, { bashDescription: tallDescription })]);
    terminalOnly(page);
    expect(page).toContain(label);
    expect(page).toContain(`<div class="nc-desc">Bash: ${tallDescription}</div>`);
    expect(page).toContain('<div class="nc-more">244 more lines</div>');
  });

  it("wrong-subject head: Chat runs another command with the same last rows; shown only as Chat's call, never as what is asked", async () => {
    const context = await neverAnswered(frameA, ({ herdr }) => show(herdr, "w1:p1", tallBash(commandB)));
    const page = card(reading(context), [bash(commandB)]);
    terminalOnly(page);
    expect(page).toContain(label);
    expect(page).toContain("cd /synthetic/other-target");
  });

  it("quoted whitespace: Chat's print(\"ab\") does not name a screen showing print(\"a b\")", async () => {
    const onScreen = [...commandA.slice(0, -1), 'print("a b")', "EOF"];
    const pending = [...commandA.slice(0, -1), 'print("ab")', "EOF"];
    const context = await neverAnswered(tallBash(onScreen));
    const page = card(reading(context), [bash(pending)]);
    terminalOnly(page);
    expect(page).not.toContain("nc-subj");
    expect(card(reading(context), [bash(onScreen)])).toContain(label);
  });

  it("two running calls that both agree: no subject", async () => {
    const context = await neverAnswered(frameA);
    const both = pendingToolCalls({ turns: [makeTurn("t0", { items: [item(bash(commandA, { id: "first" })), item(bash(commandB, { id: "second" }))] })] });
    expect(both.map((call) => call.id)).toEqual(["first", "second"]);
    const page = card(reading(context), both);
    terminalOnly(page);
    expect(page).not.toContain("nc-subj");
  });

  it("a basename substring names nothing; another folder's file shows only the name the question gives", async () => {
    const context = await neverAnswered(tallEdit(longDiff(150), yesNo));
    const substring = card(reading(context), [edit("/synthetic/mary.ts")]);
    terminalOnly(substring);
    expect(substring).not.toContain("nc-subj");
    const folder = card(reading(context), [edit("/synthetic/other/summary.ts")]);
    terminalOnly(folder);
    expect(folder).toContain('<div class="nc-desc">Edit <code class="nc-file">summary.ts</code></div>');
    expect(folder).not.toContain("/synthetic/other");
  });

  it("a finished newest turn lends no call (an interrupted one left running); no earlier turn is looked at", async () => {
    const stale = bash(commandA);
    const turns = { turns: [makeTurn("t0", { items: [item(stale)] }), makeTurn("t1", { isFinished: true, endedAt: 1_000, items: [item(stale)] })] };
    expect(pendingToolCalls(turns)).toEqual([]);
    const context = await neverAnswered(frameA);
    const page = card(reading(context), pendingToolCalls(turns));
    terminalOnly(page);
    expect(page).not.toContain("nc-subj");
  });
});
