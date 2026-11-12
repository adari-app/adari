// Codex 0.166.0's tool-call question (its MCP elicitation form,
// codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs) as the Needs card.
// The one-field approval form is read on a Codex pane only: an optional
// `Field 1/1` row, the header (`Allow this request?` or `Allow <name> to …`),
// optional parameter rows, the numbered options with their descriptions (a
// description wrapped onto rows under it joins its option), the footer
// `enter to submit | esc to cancel`. Two or more fields, message-only, boolean
// and text forms, and a clipped top stay unmatched (Answer in Terminal).
// Same expected results as Tests/HerdrCompanionTests/CompanionCodexFormTests.swift.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import { PromptService } from "../src/main/prompt/prompts";
import { NeedsCard, needsCardShown } from "../src/renderer/chat/NeedsCard";
import { NeedsCardStore, needsCards } from "../src/renderer/chat/needs-card-store";
import { stopBindingOf } from "../src/shared/agent-stop";
import type { HerdrDesktopBridge, HostView } from "../src/shared/ipc-contract";
import { answerPrompt, grokSettleReads, type PaneIO } from "../src/shared/prompt/answerer";
import { needsPillKind } from "../src/shared/needs-pill";
import { cardContent, cardKeyAction, keyHint } from "../src/shared/prompt/card";
import { codexForm, codexFormTrace, matchPrompt, readingForAgent, readingMatch, type PromptMatch } from "../src/shared/prompt/matcher";
import { afterRead, marked as quietMarked, promptLike } from "../src/shared/prompt/quiet";
import type { AnswerRequest, AnswerResult, PanePrompt } from "../src/shared/prompt/view";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { C, E, F, G, L, Launch } from "./support/prompt-fixtures";
import { backend, clock, FakeHerdr, show, snapshot } from "./support/prompt-herdr";

const pane = "w1:p1";
const labels4 = ["Allow", "Allow for this session", "Always allow", "Cancel"];
const details4 = [
  "Run the tool and continue",
  "Run the tool and remember this choice for this session",
  "Run the tool and remember this choice for future tool calls",
  "Cancel this tool call",
];
const options4Drawn = [
  "    1. Allow                   Run the tool and continue",
  "    2. Allow for this session  Run the tool and remember this choice for this session",
  "    3. Always allow            Run the tool and remember this choice for future tool calls",
  "    4. Cancel                  Cancel this tool call",
];

function form(text: string): PromptMatch {
  const reading = matchPrompt(text, pane, "codex");
  const match = readingMatch(reading);
  if (match === null) throw new Error(`not matched: ${JSON.stringify(reading)}`);
  return match;
}

const marked = (match: PromptMatch): string[] => match.options.filter((option) => option.isReturnDefault).map((option) => option.key);
const rowOf = (text: string, start: string): number => text.split("\n").findIndex((row) => row.startsWith(start));

/** `text` with Codex's mark (›) moved to option `key`. */
function markOn(text: string, key: string): string {
  return text
    .split("\n")
    .map((row) => {
      const option = /^ {2}([› ]) (\d)\. /u.exec(row);
      if (option === null) return row;
      return `  ${option[2] === key ? "›" : " "}${row.slice(3)}`;
    })
    .join("\n");
}

describe("Codex's tool-call question, read on a Codex pane", () => {
  it("four options: Codex's header, its labels and descriptions in its order, 1 marked", () => {
    const match = form(C.four);
    expect(match.kind).toBe("codexForm");
    expect(match.question).toBe("Allow this request?");
    expect(match.context).toBeNull();
    expect(match.options.map((option) => option.key)).toEqual(["1", "2", "3", "4"]);
    expect(match.options.map((option) => option.label)).toEqual(labels4);
    expect(match.options.map((option) => option.detail)).toEqual(details4);
    expect(marked(match)).toEqual(["1"]);
    // The digit alone answers each.
    expect(match.options.map((option) => option.keys)).toEqual([["1"], ["2"], ["3"], ["4"]]);
    // Always allow keeps Codex's words; the two that remember are session-wide; none opens the box.
    expect(match.options.filter((option) => option.isSessionWide).map((option) => option.key)).toEqual(["2", "3"]);
    expect(match.options.some((option) => option.opensComposer)).toBe(false);
    // The fingerprint: the header rows and the option rows as drawn, the mark left out.
    expect(match.fingerprint).toEqual({ rules: 2, paneID: pane, question: "Allow this request?", body: ["  Allow this request?"], options: options4Drawn });
  });

  it("two options (Allow, Cancel)", () => {
    const match = form(C.two);
    expect(match.options.map((option) => [option.key, option.label, option.detail])).toEqual([
      ["1", "Allow", "Run the tool and continue"],
      ["2", "Cancel", "Cancel this tool call"],
    ]);
    expect(marked(match)).toEqual(["1"]);
    expect(match.fingerprint.options).toEqual(["    1. Allow   Run the tool and continue", "    2. Cancel  Cancel this tool call"]);
  });

  it("the mark on each option: that one is Return's; the fingerprint is the same", () => {
    const first = form(C.four);
    for (const key of ["1", "2", "3", "4"]) {
      const match = form(markOn(C.four, key));
      expect(marked(match)).toEqual([key]);
      expect(match.fingerprint).toEqual(first.fingerprint);
      expect(match.options.map((option) => option.label)).toEqual(labels4);
    }
    // No mark at all (a cleared selection) still reads; two marks do not.
    expect(marked(form(markOn(C.four, "none")))).toEqual([]);
    const two = E.row(markOn(C.four, "1"), rowOf(C.four, "    3. Always"), (row) => `  ›${row.slice(3)}`);
    expect(codexForm(two, pane)).toBeNull();
  });

  it("blank rows between the options and the footer (the snapshots' taller area) read the same", () => {
    expect(form(C.fourGap)).toEqual(form(C.four));
  });

  it("a narrow pane: each description wrapped under its column joins its option", () => {
    const match = form(C.narrow);
    expect(match.question).toBe("Allow this request?");
    expect(match.options.map((option) => option.label)).toEqual(labels4);
    expect(match.options.map((option) => option.detail)).toEqual(details4);
    expect(marked(match)).toEqual(["1"]);
    // The rows as drawn, each continuation row kept under its option.
    expect(match.fingerprint.options).toEqual([
      "    1. Allow                   Run the tool and",
      "                               continue",
      "    2. Allow for this session  Run the tool and",
      "                               remember this choice for",
      "                               this session",
      "    3. Always allow            Run the tool and",
      "                               remember this choice for",
      "                               future tool calls",
      "    4. Cancel                  Cancel this tool call",
    ]);
    // The user's last rows: "remember this choice for", "future tool calls", "4. Cancel   Cancel this tool call".
    const rows = C.narrow.trimEnd().split("\n").map((row) => row.trim());
    expect(rows.slice(-4)).toEqual(["remember this choice for", "future tool calls", "4. Cancel                  Cancel this tool call", "enter to submit | esc to cancel"]);
  });

  it("parameter rows: Allow Calendar to create an event, its three rows, two options", () => {
    const match = form(C.params);
    expect(match.question).toBe("Allow Calendar to create an event");
    expect(match.context).toEqual({
      type: "parameters",
      rows: ["Calendar: primary", "Title: Roadmap review", "Notes: This is a deliberately long note that should truncate bef..."],
    });
    expect(match.options.map((option) => option.label)).toEqual(["Allow", "Cancel"]);
    expect(match.fingerprint.body).toEqual([
      "  Allow Calendar to create an event",
      "",
      "  Calendar: primary",
      "  Title: Roadmap review",
      "  Notes: This is a deliberately long note that should truncate bef...",
      "",
    ]);
  });

  it("a narrower pane: the header and a parameter wrap; the header joins, the rows stay as drawn", () => {
    const match = form(C.narrowParams);
    expect(match.question).toBe("Allow Calendar to create an event");
    expect(match.context).toEqual({
      type: "parameters",
      rows: ["Calendar: primary", "Title: Roadmap review", "Notes: This is a deliberately", "long note that should truncate", "bef..."],
    });
    expect(match.options.map((option) => [option.label, option.detail])).toEqual([
      ["Allow", "Run the tool and continue"],
      ["Cancel", "Cancel this tool call"],
    ]);
  });

  it("the Field row may be absent (a blank row above the header); with it or without, one fingerprint", () => {
    const field = rowOf(C.four, "  Field 1/1");
    expect(form(E.row(C.four, field, () => "")).fingerprint).toEqual(form(C.four).fingerprint);
    expect(form(E.row(C.four, field, () => "  Field 1/1 (1 required unanswered)")).fingerprint).toEqual(form(C.four).fingerprint);
  });

  it("two fields or more stay unmatched (Answer in Terminal)", () => {
    expect(matchPrompt(C.twoFields, pane, "codex").type).toBe("unmatched");
    const field = rowOf(C.four, "  Field 1/1");
    for (const other of ["  Field 1/2", "  Field 2/2", "  Field 1/3 (3 required unanswered)"]) {
      expect(codexForm(E.row(C.four, field, () => other), pane)).toBeNull();
    }
  });

  it("message-only (Allow, Deny, Cancel), boolean and text forms stay unmatched", () => {
    for (const text of [C.messageOnly, C.boolean, C.text]) {
      expect(codexForm(text, pane)).toBeNull();
      expect(matchPrompt(text, pane, "codex").type).toBe("unmatched");
    }
  });

  it("a clipped top (the header or the options cut off by a full read) stays unmatched", () => {
    expect(C.clipped.split("\n").length).toBeGreaterThanOrEqual(40);
    expect(C.clipped.startsWith("  Allow this request?")).toBe(true);
    for (const text of [C.clipped, C.clippedOptions]) {
      expect(codexForm(text, pane)).toBeNull();
      expect(matchPrompt(text, pane, "codex").type).toBe("unmatched");
    }
  });

  it("anything else around the options or the footer leaves it unmatched", () => {
    // Options hidden (Codex's "option 1/4" before the footer), an unknown label, a row under the options
    // not indented past their numbers, rows below the footer, a header not Codex's.
    const footer = rowOf(C.four, "  enter to submit");
    expect(codexForm(E.row(C.four, footer, () => "  option 1/4 | enter to submit | esc to cancel"), pane)).toBeNull();
    expect(codexForm(C.four.replace("4. Cancel                  Cancel this tool call", "4. Deny                    Decline this request"), pane)).toBeNull();
    expect(codexForm(E.inserting(C.four, ["    loose row"], footer), pane)).toBeNull();
    expect(codexForm(E.inserting(C.four, ["  • Working (1s • esc to interrupt)"], footer + 1), pane)).toBeNull();
    expect(codexForm(C.four.replace("  Allow this request?", "  Please confirm this request"), pane)).toBeNull();
    // Options out of order (Cancel before Allow) or a description missing.
    expect(codexForm(C.two.replace("1. Allow   Run the tool and continue", "1. Cancel  Run the tool and continue"), pane)).toBeNull();
    expect(codexForm(C.two.replace("  Cancel this tool call", ""), pane)).toBeNull();
  });

  it("read on a Codex pane only: no kind, Claude, Grok or Cursor leave it as before (unmatched)", () => {
    expect(matchPrompt(C.four, pane, "codex").type).toBe("matched");
    expect(matchPrompt(C.four, pane, "Codex").type).toBe("matched");
    for (const kind of [null, "claude", "grok", "cursor"]) expect(matchPrompt(C.four, pane, kind)).toEqual(matchPrompt(C.four, pane));
    expect(matchPrompt(C.four, pane)).toEqual({
      type: "unmatched",
      lines: ["2. Allow for this session  Run the tool and remember this choice for this session", "3. Always allow            Run the tool and remember this choice for future tool calls", "4. Cancel                  Cancel this tool call", "enter to submit | esc to cancel"],
    });
  });

  it("Claude, Grok, Cursor and Codex command prompts read exactly as before on a Codex pane", () => {
    const screens = [F.claudeEdit, F.claudeBash, F.codexCommand, F.grokMenu, F.codexYesNo, F.defaultYes, F.working, F.unsupportedApproval, L.claude2_1_303Bash, L.claude2_1_303Write, L.claude2_1_303Trust, L.codex0_163_0Dialog, L.codex0_163_0Narrow51Dialog, L.codex0_163_0AfterNo, L.codex0_163_0IdleField, Launch.paywallPrompt, Launch.relayPrompt, Launch.pairingPrompt, G.approval, G.liveApproval];
    for (const text of screens) {
      expect(codexForm(text, pane)).toBeNull();
      expect(matchPrompt(text, pane, "codex")).toEqual(matchPrompt(text, pane));
    }
    // Codex's command approval keeps its menu.
    expect(readingMatch(matchPrompt(L.codex0_163_0Dialog, pane, "codex"))?.kind).toBe("menu");
  });
});

// The card says Codex wants to use a tool, then Codex's own words in
// Codex's order: the header as the question, the parameter rows, and each
// option's label with its description. Always allow keeps its words
// ("Run the tool and remember this choice for future tool calls").
describe("the card, in Codex's words and order", () => {
  it("the four-option card: header, question, no target or command, options with their descriptions", () => {
    const content = cardContent(form(C.four), "codex");
    expect(content.kind).toBe("tool");
    expect(content.header).toBe("Codex wants to use a tool");
    expect(content.target).toBeNull();
    expect(content.command).toBeNull();
    expect(content.parameters).toEqual([]);
    expect(content.lines).toEqual([]);
    expect(content.question).toBe("Allow this request?");
    expect(content.options.map((option) => [option.key, option.label, option.detail])).toEqual([
      ["1", "Allow", "Run the tool and continue"],
      ["2", "Allow for this session", "Run the tool and remember this choice for this session"],
      ["3", "Always allow", "Run the tool and remember this choice for future tool calls"],
      ["4", "Cancel", "Cancel this tool call"],
    ]);
    expect(content.returnIndex).toBe(0);
    expect(content.tellOption).toBeNull();
    expect(keyHint(content)).toBe("↑ ↓ to choose · Return picks");
    // The card's digits and Return pick in the card (the answer sends the digit alone).
    expect(cardKeyAction({ key: "3", textFocused: false }, content.options, 0)).toEqual({ type: "pick", index: 2 });
    expect(cardKeyAction({ key: "Enter", textFocused: false }, content.options, 1)).toEqual({ type: "pick", index: 1 });
    // The mark moved in the pane: Return's option follows it.
    expect(cardContent(form(markOn(C.four, "3")), "codex").returnIndex).toBe(2);
  });

  it("parameter rows under the question, in Codex's order", () => {
    const content = cardContent(form(C.params), "codex");
    expect(content.question).toBe("Allow Calendar to create an event");
    expect(content.parameters).toEqual(["Calendar: primary", "Title: Roadmap review", "Notes: This is a deliberately long note that should truncate bef..."]);
    expect(content.options.map((option) => [option.label, option.detail])).toEqual([
      ["Allow", "Run the tool and continue"],
      ["Cancel", "Cancel this tool call"],
    ]);
    // The user's narrow pane: the wrapped descriptions joined, word for word.
    expect(cardContent(form(C.narrow), "codex").options.map((option) => option.detail)).toEqual(details4);
  });

  it("the sidebar pill reads Pending Approval", () => {
    expect(needsPillKind(form(C.four))).toBe("approval");
    expect(needsPillKind(form(C.params))).toBe("approval");
  });

  it("Claude's, Codex's command and Grok's cards are as before: no parameters, no descriptions", () => {
    const claude = cardContent(readingMatch(readingForAgent(matchPrompt(L.claude2_1_303Bash, pane), "claude"))!, "claude");
    expect(claude.kind).toBe("run");
    expect(claude.parameters).toEqual([]);
    expect(claude.options.every((option) => option.detail === undefined)).toBe(true);
    const codex = cardContent(readingMatch(matchPrompt(L.codex0_163_0Dialog, pane, "codex"))!, "codex");
    expect(codex.kind).toBe("run");
    expect(codex.header).toBe("Codex wants to run");
    expect(codex.parameters).toEqual([]);
    expect(codex.options.every((option) => option.detail === undefined)).toBe(true);
    const grok = cardContent(readingMatch(matchPrompt(G.approval, pane, "grok"))!, "grok");
    expect(grok.header).toBe("Grok Build wants to run");
    expect(grok.parameters).toEqual([]);
    expect(grok.options.every((option) => option.detail === undefined)).toBe(true);
  });
});

describe("the card rendered", () => {
  const host = { id: "box", name: "build-box", state: "connected" } as unknown as HostView;
  const codexRow = { paneID: "w1:p1", isAgent: true, status: "blocked", kind: "codex", name: "tidepool" } as unknown as SidebarRow;
  const previous = (globalThis as { window?: unknown }).window;
  const bridge: Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt"> = {
    listPrompts: () => Promise.resolve([]),
    onPromptsChanged: () => () => undefined,
    answerPrompt: () => Promise.resolve({ type: "sent", label: "Allow" }),
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
    paneId: "w1:p1",
    episode: "e1",
    incarnation: 1,
    connection: 1,
    epoch: 1,
    reading: matchPrompt(text, "w1:p1", "codex"),
    quiet: !promptLike(text),
    cleared: false,
  });
  const render = (): string => renderToStaticMarkup(createElement(NeedsCard, { host, row: codexRow, onShowTerminal: () => undefined }));

  it("the header, Codex's question, each option's label and description, Always allow among them", () => {
    needsCards.receive([shown(C.four)]);
    const html = render();
    expect(html).toContain('data-needs-card="tool"');
    expect(html).toContain('<span class="nc-t">Codex wants to use a tool</span>');
    expect(html).toContain('<div class="nc-q">Allow this request?</div>');
    expect(html).not.toContain("nc-params");
    expect(html).not.toContain("nc-target");
    expect(html).toMatch(/<button class="nc-opt on" data-key="1"><span class="k">1<\/span><span class="l">Allow<\/span><span class="d">Run the tool and continue<\/span><\/button>/);
    expect(html).toContain('<span class="k">2</span><span class="l">Allow for this session</span><span class="d">Run the tool and remember this choice for this session</span>');
    expect(html).toContain('<span class="k">3</span><span class="l">Always allow</span><span class="d">Run the tool and remember this choice for future tool calls</span>');
    expect(html).toContain('<span class="k">4</span><span class="l">Cancel</span><span class="d">Cancel this tool call</span>');
    // Codex's order: 1 to 4, top to bottom, none left out.
    expect([...html.matchAll(/data-key="(\d)"/gu)].map((found) => found[1])).toEqual(["1", "2", "3", "4"]);
    expect(html).not.toContain("Answer in Terminal");
  });

  it("the parameter rows under the question; two options listed one per row with their descriptions", () => {
    needsCards.receive([shown(C.params)]);
    const html = render();
    expect(html).toContain('<div class="nc-q">Allow Calendar to create an event</div><pre class="nc-params">Calendar: primary\nTitle: Roadmap review\nNotes: This is a deliberately long note that should truncate bef...</pre>');
    expect(html).toContain('<div class="nc-opts" role="group"');
    expect(html).toContain('<span class="l">Cancel</span><span class="d">Cancel this tool call</span>');
  });

  it("a two-field form keeps Answer in Terminal (unmatched)", () => {
    needsCards.receive([shown(C.twoFields)]);
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
  };
}

const optionOf = (match: PromptMatch, key: string) => match.options.find((option) => option.key === key)!;

// The answer is the digit alone, as on Grok. The screen is read again; the
// fingerprint (the header, the parameter rows, the option labels and
// descriptions, the mark left out) must match and the before-send gate must
// allow it; then the digit goes once, never Enter or any other key, never
// Esc. Then reads as on Grok: the form gone means sent; anything else is
// unsettled (Answer in Terminal, nothing more sent).
describe("the answer is the digit alone, then reads; never Enter, never Esc", () => {
  let match: PromptMatch;
  beforeAll(() => {
    match = form(C.four);
  });

  it("the digit closes the form: sent, the digit alone", async () => {
    for (const key of ["1", "2", "3", "4"]) {
      const io = new CodexPane([C.four, C.after]);
      expect(await answerPrompt(io.io, optionOf(match, key), match)).toEqual({ type: "sent" });
      expect(io.sent).toEqual([[key]]);
      expect(io.reads).toBe(2);
    }
    const params = form(C.params);
    const io = new CodexPane([C.params, C.after]);
    expect(await answerPrompt(io.io, optionOf(params, "2"), params)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["2"]]);
  });

  it("the mark moved in the pane before the read (the same question): the digit still answers", async () => {
    const io = new CodexPane([markOn(C.four, "4"), C.after]);
    expect(await answerPrompt(io.io, optionOf(match, "1"), match)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["1"]]);
  });

  it("the fingerprint changed between the card and the before-send read: zero keys", async () => {
    const changed = [
      // Another tool call (header, parameters and options), a description changed, a parameter changed,
      // two options instead of four, a second field, the form gone.
      C.second,
      C.four.replace("Run the tool and remember this choice for future tool calls", "Run the tool and remember this choice for all tool calls"),
      C.params.replace("Title: Roadmap review", "Title: Roadmap reviews"),
      C.two,
      E.row(C.four, rowOf(C.four, "  Field 1/1"), () => "  Field 1/2"),
      C.after,
    ];
    for (const text of changed) {
      const target = text === C.params.replace("Title: Roadmap review", "Title: Roadmap reviews") ? form(C.params) : match;
      const io = new CodexPane([text]);
      const outcome = await answerPrompt(io.io, optionOf(target, "1"), target);
      expect(outcome.type).toBe("changed");
      expect(io.sent).toEqual([]);
    }
  });

  it("the before-send gate refuses after the read: zero keys", async () => {
    const io = new CodexPane([C.four, C.after]);
    expect(await answerPrompt(io.io, optionOf(match, "1"), match, () => false)).toEqual({ type: "withdrawn" });
    expect(io.sent).toEqual([]);
  });

  it("the form still shown after the reads: unsettled, nothing more sent", async () => {
    const io = new CodexPane([C.four, markOn(C.four, "3")]);
    const outcome = await answerPrompt(io.io, optionOf(match, "3"), match);
    expect(outcome.type).toBe("unsettled");
    if (outcome.type === "unsettled") expect(readingMatch(outcome.now!)!.fingerprint).toEqual(match.fingerprint);
    expect(io.sent).toEqual([["3"]]);
    expect(io.reads).toBe(1 + grokSettleReads);
  });

  it("another form after the digit: unsettled at once, the card as the screen says, nothing more", async () => {
    const io = new CodexPane([C.four, C.second]);
    const outcome = await answerPrompt(io.io, optionOf(match, "1"), match);
    expect(outcome.type).toBe("unsettled");
    if (outcome.type === "unsettled") expect(readingMatch(outcome.now!)!.question).toBe("Allow Calendar to create an event");
    expect(io.sent).toEqual([["1"]]);
    expect(io.reads).toBe(2);
  });

  it("a part of the form left (clipped, or a two-field form next): kept reading, then gone: sent", async () => {
    expect(codexFormTrace(C.clipped)).toBe(true);
    expect(codexFormTrace(C.twoFields)).toBe(true);
    expect(codexFormTrace(C.after)).toBe(false);
    const io = new CodexPane([C.four, C.clipped, C.after]);
    expect(await answerPrompt(io.io, optionOf(match, "2"), match)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([["2"]]);
    const stays = new CodexPane([C.four, C.twoFields]);
    expect((await answerPrompt(stays.io, optionOf(match, "2"), match)).type).toBe("unsettled");
    expect(stays.sent).toEqual([["2"]]);
  });

  it("an unread or blank screen after the digit proves nothing: unsettled, nothing more", async () => {
    const unread = new CodexPane([C.four, new Error("the pane could not be read")]);
    expect(await answerPrompt(unread.io, optionOf(match, "1"), match)).toEqual({ type: "unsettled", now: null });
    expect(unread.sent).toEqual([["1"]]);
    const blank = new CodexPane([C.four, "\n\n"]);
    expect(await answerPrompt(blank.io, optionOf(match, "1"), match)).toEqual({ type: "unsettled", now: null });
    expect(blank.sent).toEqual([["1"]]);
  });

  it("only the digit, in every sequence: never Enter, never Escape", async () => {
    const runs: (string | Error)[][] = [
      [C.four, C.after],
      [C.four, C.four],
      [C.four, markOn(C.four, "4"), C.after],
      [C.four, C.second],
      [C.four, new Error("x")],
      [C.four, C.clipped],
      [C.four, C.twoFields],
      [C.second],
    ];
    for (const screens of runs) {
      const io = new CodexPane(screens);
      await answerPrompt(io.io, optionOf(match, "4"), match);
      expect(io.sent.length).toBeLessThanOrEqual(1);
      for (const keys of io.sent) expect(keys).toEqual(["4"]);
    }
  });

  it("Claude's and Codex's command answers are unchanged: their keys once, no read after", async () => {
    const claude = readingMatch(matchPrompt(L.claude2_1_303Bash, pane))!;
    const io = new CodexPane([L.claude2_1_303Bash, L.claude2_1_303AfterNo]);
    expect(await answerPrompt(io.io, claude.options[0]!, claude)).toEqual({ type: "sent" });
    expect(io.sent).toEqual([claude.options[0]!.keys]);
    expect(io.reads).toBe(1);
    const codex = readingMatch(matchPrompt(L.codex0_163_0Dialog, pane, "codex"))!;
    expect(codex.kind).toBe("menu");
    const io2 = new CodexPane([L.codex0_163_0Dialog, L.codex0_163_0AfterNo]);
    expect(await answerPrompt(io2.io, codex.options[0]!, codex)).toEqual({ type: "sent" });
    expect(io2.sent).toEqual([codex.options[0]!.keys]);
    expect(io2.reads).toBe(1);
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

describe("the service on a Codex pane", () => {
  it("reads Codex's form (the pane's agent picks it) and never clears it as quiet", async () => {
    const context = await codexSetup([C.four]);
    expect(readingMatch(context.prompt().reading!)?.kind).toBe("codexForm");
    context.time.t += 2_500;
    await context.service.tick();
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().cleared).toBe(false);
    expect(context.prompt().quiet).toBe(false);
  });

  it("an answer whose digit closes the form: sent, the digit only", async () => {
    const context = await codexSetup([C.four, C.after]);
    expect(await context.service.answer(context.request("3"))).toEqual({ type: "sent", label: "Always allow" });
    expect(context.keys()).toEqual([["3"]]);
  });

  it("another form after the digit: Answer in Terminal, the card shows that form, this question is answered once", async () => {
    const context = await codexSetup([C.four, C.second]);
    const request = context.request("1");
    expect(await context.service.answer(request)).toEqual({ type: "unsettled", label: "Allow", note: "Answer in Terminal: Codex’s screen did not show the answer take" });
    expect(readingMatch(context.prompt().reading!)?.question).toBe("Allow Calendar to create an event");
    expect(context.keys()).toEqual([["1"]]);
    expect(await context.service.answer(request)).toMatchObject({ type: "refused" });
    expect(context.keys()).toEqual([["1"]]);
  });

  it("the form still shown after the reads: unsettled, the digit once", async () => {
    const context = await codexSetup([C.four, C.four]);
    expect(await context.service.answer(context.request("4"))).toMatchObject({ type: "unsettled", label: "Cancel" });
    expect(context.keys()).toEqual([["4"]]);
  });

  it("the question changed before the digit: Not sent, zero keys", async () => {
    const context = await codexSetup([C.four]);
    const request = context.request("1");
    show(context.herdr, "w1:p1", C.second);
    expect(await context.service.answer(request)).toMatchObject({ type: "changed" });
    expect(context.keys()).toEqual([]);
  });

  it("the form is prompt-like on a Codex pane: the quiet rule keeps the mark", () => {
    for (const text of [C.four, C.params, C.narrow]) {
      expect(promptLike(text, "codex")).toBe(true);
      const once = afterRead(quietMarked, { startedAt: 2_000, text }, 1_000, "codex");
      expect(afterRead(once, { startedAt: 4_500, text }, 1_000, "codex")).toEqual(quietMarked);
    }
    expect(needsCardShown({ isAgent: true, status: "blocked", kind: "codex" }, null)).toBe(true);
  });
});

describe("the card store after Codex's unsettled answer", () => {
  const host = { id: "box", name: "Mac mini", state: "connected", topology: null, incarnation: 1, epoch: 0 } as unknown as HostView;
  const prompt = (text: string, episode = "e1"): PanePrompt => ({ hostId: "box", paneId: pane, episode, incarnation: 1, connection: 1, epoch: 1, reading: matchPrompt(text, pane, "codex"), quiet: !promptLike(text, "codex"), cleared: false });
  const bridge = (result: AnswerResult) => ({
    listPrompts: () => Promise.resolve([]),
    onPromptsChanged: () => () => undefined,
    answerPrompt: () => Promise.resolve(result),
  });

  it("keeps the card as the screen says, with the note and Answer in Terminal, until the block ends", async () => {
    const store = new NeedsCardStore();
    store.receive([prompt(C.four)]);
    const shown = readingMatch(store.forPane("box", pane)!.reading!)!;
    const note = "Answer in Terminal: Codex’s screen did not show the answer take";
    await store.answer(bridge({ type: "unsettled", label: "Allow", note }), host, pane, "codex", shown, shown.options[0]!);
    expect(store.card("box", pane)).toMatchObject({ sent: null, note, terminal: { episode: "e1" }, busy: false });
    store.receive([prompt(C.second, "e2")]);
    expect(store.card("box", pane)).toMatchObject({ terminal: null, note: null });
  });
});

// The desktop demo's Codex pane (Mac mini, wA:pM) blocked on Codex's tool-call
// question (a computer-use app request), and captures 88-90 after the sidebar's 86-87.
import { readFileSync } from "node:fs";
import path from "node:path";
import { codexAskCaptureSteps, sidebarFoldedCaptureSteps } from "../src/main/capture";
import { demoHostIds } from "../src/main/demo/demo-hosts";
import { demoCodexAskDone, demoCodexAskHeader, demoCodexAskParameters, demoCodexAskScreen, demoPromptScreens } from "../src/main/demo/demo-prompts";

describe("the demo's Codex pane", () => {
  it("waits on Codex's tool-call question: the card reads its header, parameters and four options; the answer leaves no form", () => {
    expect(demoPromptScreens("").macMini["wA:pM"]).toEqual([demoCodexAskScreen, demoCodexAskDone]);
    const match = form(demoCodexAskScreen);
    expect(match.kind).toBe("codexForm");
    expect(match.question).toBe(demoCodexAskHeader);
    expect(demoCodexAskHeader).toBe("Allow Computer Use to control Google Chrome");
    expect(match.context).toEqual({ type: "parameters", rows: demoCodexAskParameters });
    expect(match.options.map((option) => option.label)).toEqual(labels4);
    expect(match.options.map((option) => option.detail)).toEqual(details4);
    expect(marked(match)).toEqual(["1"]);
    const content = cardContent(match, "codex");
    expect(content.header).toBe("Codex wants to use a tool");
    expect(content.parameters).toEqual(demoCodexAskParameters);
    expect(needsPillKind(match)).toBe("approval");
    expect(codexForm(demoCodexAskDone, pane)).toBeNull();
    expect(codexFormTrace(demoCodexAskDone)).toBe(false);
    expect(promptLike(demoCodexAskDone, "codex")).toBe(false);
  });

  it("a pick on the demo's screens: the digit alone, the form gone (sent), then cleared as working", async () => {
    const context = await codexSetup([demoCodexAskScreen, demoCodexAskDone]);
    expect(readingMatch(context.prompt().reading!)?.question).toBe(demoCodexAskHeader);
    expect(await context.service.answer(context.request("1"))).toEqual({ type: "sent", label: "Allow" });
    expect(context.keys()).toEqual([["1"]]);
    context.time.t += 2_500;
    await context.service.tick();
    context.time.t += 2_500;
    await context.service.tick();
    expect(context.prompt().cleared).toBe(true);
  });

  it("the demo backend: Herdr says blocked; the pane shows the form until its digit, then the call running", async () => {
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHosts } = await import("../src/main/demo/demo-hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const fixtures = bundledFixturesForTests();
    const host = demoHosts(fixtures, Date.now()).find((each) => each.descriptor.id === demoHostIds.macMini)!;
    const agents = host.snapshot["agents"] as Record<string, unknown>[];
    expect(agents.find((agent) => agent["pane_id"] === "wA:pM")).toMatchObject({ agent: "codex", agent_status: "blocked" });
    const panes = host.snapshot["panes"] as Record<string, unknown>[];
    expect(panes.find((each) => each["pane_id"] === "wA:pM")).toMatchObject({ agent: "codex", agent_status: "blocked", label: "lumen-onboarding-perf · codex" });
    const backend = new DemoBackend(host, fixtures);
    expect(form(await backend.paneText("wA:pM", 80)).question).toBe(demoCodexAskHeader);
    await backend.promptIO().paneSendKeys("wA:pM", ["1"]);
    const after = await backend.paneText("wA:pM", 80);
    expect(codexForm(after, pane)).toBeNull();
    expect(codexFormTrace(after)).toBe(false);
    backend.close();
  });

  it("captures 88-90 come after the sidebar's 86-87, on the Codex pane; only the modes' 91-96, the drawer's, the agents' 121-125 and the ring's 126-130 follow them", () => {
    expect(sidebarFoldedCaptureSteps(demoHostIds).at(-1)!.name).toBe("87-folded-machine-needs");
    const main = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
    const at = (call: string): number => main.indexOf(`...${call}(demoHostIds)`);
    expect(at("codexAskCaptureSteps")).toBeGreaterThan(at("sidebarFoldedCaptureSteps"));
    // The Permissions captures 91-96 follow 88-90; the terminal drawer's captures after them;
    // then the agents' 121-125.
    expect(main.slice(at("codexAskCaptureSteps") + 1).match(/\.\.\.\w+CaptureSteps\(demoHostIds\)/gu)).toEqual([
      "...modesCaptureSteps(demoHostIds)",
      "...terminalDrawerCaptureSteps(demoHostIds)",
      "...agentsCaptureSteps(demoHostIds)",
      // The ring's 126-130.
      "...ringCaptureSteps(demoHostIds)",
      // Cursor's Model chip read only 200 last (the steps between take callbacks).
      "...cursorPickCaptureSteps(demoHostIds)",
      // The three Early kinds' badge, a Claude Code pane without it 230-233 (last).
      "...twotierCaptureSteps(demoHostIds)",
    ]);
    const steps = codexAskCaptureSteps(demoHostIds);
    expect(steps.map((step) => step.name)).toEqual(["88-codex-ask-card", "89-codex-ask-terminal", "90-codex-ask-after"]);
    expect(steps[0]!.commands).toContainEqual({ type: "select-pane", hostId: demoHostIds.macMini, paneId: "wA:pM" });
    expect(steps[0]!.commands).toContainEqual({ type: "zoom-pane", hostId: demoHostIds.macMini, paneId: "wA:pM", zoomed: true });
    expect(steps[0]!.commands).toContainEqual({ type: "set-tab", tab: "chat" });
    expect(steps[1]!.commands).toContainEqual({ type: "set-tab", tab: "terminal" });
    expect(steps[2]!.commands).toContainEqual({ type: "click", selector: '.ncard .nc-opt[data-key="1"]' });
  });
});
