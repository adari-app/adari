// The needs-you card's words (the cases of the Swift app's
// CompanionChatGlueTests: testTheCardShowsTheEditItsQuestionAndItsOptions,
// testTheCardsMacKeysWhileTheBoxIsEmpty, testTypingAnswersOnlyWhileTheCardShows),
// its keys (only while no text field has the focus), the box's "No, tell…"
// and its refusal note, and the card rendered (react-dom/server, no DOM).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { demoAskScreen } from "../src/main/demo/demo-prompts";
import { NeedsCard } from "../src/renderer/chat/NeedsCard";
import { NeedsCardStore, needsCards } from "../src/renderer/chat/needs-card-store";
import { windowEscStops } from "../src/renderer/components/agent-stop";
import { stopPossible } from "../src/shared/agent-stop";
import type { HerdrDesktopBridge, HostView } from "../src/shared/ipc-contract";
import { boxAnswer } from "../src/shared/prompt/box";
import { promptLike } from "../src/shared/prompt/quiet";
import { agentName, cardContent, cardKeyAction, diffLine, editTarget, keyHint, keptLines, moreLinesLabel, tellPlaceholder, waitingPlaceholder, type CardKey } from "../src/shared/prompt/card";
import { matchPrompt, readingForAgent, readingMatch, type PromptMatch } from "../src/shared/prompt/matcher";
import type { AnswerRequest, AnswerResult, PanePrompt } from "../src/shared/prompt/view";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { F, L, Launch } from "./support/prompt-fixtures";

/** The reading main sends the page: the agent's own (Claude's plain "No" opens its field). */
function matchPromptFor(text: string, pane: string, kind: string | null = "claude") {
  return readingForAgent(matchPrompt(text, pane), kind);
}

function match(text: string, pane = "w1:p1", kind: string | null = "claude"): PromptMatch {
  const found = readingMatch(matchPromptFor(text, pane, kind));
  if (found === null) throw new Error("expected a match");
  return found;
}

describe("the card's words (CompanionChatCardContent)", () => {
  it("an edit: its file, six diff rows and the rest as more, the question, the options", () => {
    const pairing = match(Launch.pairingPrompt);
    const content = cardContent(pairing, "claude");
    expect(content.kind).toBe("edit");
    expect(content.header).toBe("Claude Code wants to edit");
    expect(content.target).toBe("Tests/HelperTests/PairingTests.swift");
    expect(content.lines).toHaveLength(keptLines);
    expect(content.lines[0]).toEqual({ number: "41", kind: "added", text: "   func testPairingCodeExpiresAfterTenMinutes() async {" });
    expect(content.moreLines).toBe(12);
    expect(moreLinesLabel(content.moreLines)).toBe("12 more lines");
    expect(moreLinesLabel(1)).toBe("1 more line");
    expect(moreLinesLabel(0)).toBeNull();
    expect(content.question).toBe(pairing.question);
    expect(content.options.map((option) => option.key)).toEqual(["1", "2", "3"]);
    expect(content.returnIndex).toBe(0);
    expect(content.tellOption?.key).toBe("3");
    expect(tellPlaceholder("claude", content.tellOption!)).toBe("Tell Claude Code what to do instead (answers 3)");
    expect(keyHint(content)).toBe("↑ ↓ to choose · Return picks · or type below to answer 3 in your words");
    expect(cardContent(pairing, "codex").header).toBe("Codex wants to edit");
    // A short edit: no more.
    const short = cardContent(match(Launch.pairingChangedPrompt), "claude");
    expect(short.lines.map((line) => line.kind)).toEqual(["removed", "added"]);
    expect(short.moreLines).toBe(0);
  });

  it("a run: the command in mono, no diff", () => {
    const content = cardContent(match(L.claude2_1_303Bash), "claude");
    expect(content.kind).toBe("run");
    expect(content.header).toBe("Claude Code wants to run");
    expect(content.target).toBe("echo shapes-c > /private/tmp/z-shapes/c.txt");
    expect(content.lines).toEqual([]);
    expect(content.question).toBe("Do you want to proceed?");
    expect(content.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /private/tmp/z-shapes from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
    const codex = cardContent(match(L.codex0_163_0Dialog, "w1:p1", null), "codex");
    expect(codex.header).toBe("Codex wants to run");
    expect(codex.tellOption?.label).toBe("No, and tell Codex what to do differently");
  });

  it("a create: the new file's name", () => {
    const content = cardContent(match(L.claude2_1_303Write), "claude");
    expect(content.kind).toBe("create");
    expect(content.header).toBe("Claude Code wants to create");
    expect(content.target).toBe("new.txt");
    expect(content.question).toBe("Do you want to create new.txt?");
  });

  it("asks: no file, no command, the question in the agent's words", () => {
    const content = cardContent(match(demoAskScreen), "claude");
    expect(content.kind).toBe("asks");
    expect(content.header).toBe("Claude Code asks");
    expect(content.target).toBeNull();
    expect(content.question).toBe("Which group should the rollout start with?");
    expect(content.tellOption).toBeNull();
    expect(keyHint(content)).toBe("↑ ↓ to choose · Return picks");
  });

  it("names the agent, reads diff rows and edit targets as Swift does", () => {
    expect([agentName("claude"), agentName("Codex"), agentName("grok"), agentName("agent"), agentName(""), agentName(null)]).toEqual([
      "Claude Code",
      "Codex",
      "Grok Build",
      "The agent",
      "The agent",
      "The agent",
    ]);
    expect(diffLine("      88 -  code")).toEqual({ number: "88", kind: "removed", text: " code" });
    expect(diffLine("87     context")).toEqual({ number: "87", kind: "context", text: "   context" });
    expect(diffLine("41")).toEqual({ number: "41", kind: "context", text: "" });
    expect(diffLine("4x +a")).toBeNull();
    expect(diffLine("plain")).toBeNull();
    expect(editTarget([], "Edit Tests/PairingTests.swift?")).toBe("Tests/PairingTests.swift");
    expect(editTarget([" README.md"], "Edit it?")).toBe("README.md");
    expect(editTarget([], "Do you want to proceed?")).toBeNull();
    expect(waitingPlaceholder("codex")).toBe("Codex is waiting on the question above");
  });
});

describe("the card's keys: digits, ↑ ↓ and Return, only while no text field has the focus", () => {
  const options = match(Launch.pairingPrompt).options;
  const key = (k: string, extra: Partial<CardKey> = {}): CardKey => ({ key: k, textFocused: false, ...extra });

  it("moves, picks and stops at the ends (CompanionChatCardKeys)", () => {
    expect(cardKeyAction(key("ArrowDown"), options, 0)).toEqual({ type: "select", index: 1 });
    expect(cardKeyAction(key("ArrowDown"), options, 2)).toEqual({ type: "select", index: 2 });
    expect(cardKeyAction(key("ArrowUp"), options, 2)).toEqual({ type: "select", index: 1 });
    expect(cardKeyAction(key("ArrowUp"), options, 0)).toEqual({ type: "select", index: 0 });
    expect(cardKeyAction(key("Enter"), options, 1)).toEqual({ type: "pick", index: 1 });
    expect(cardKeyAction(key("2"), options, 0)).toEqual({ type: "pick", index: 1 });
    expect(cardKeyAction(key("3"), options, 0)).toEqual({ type: "pick", index: 2 });
    expect(cardKeyAction(key("7"), options, 0)).toEqual({ type: "none" });
    expect(cardKeyAction(key("a"), options, 0)).toEqual({ type: "none" });
    expect(cardKeyAction(key("Enter", { shift: true }), options, 0)).toEqual({ type: "none" });
    expect(cardKeyAction(key("1", { meta: true }), options, 0)).toEqual({ type: "none" });
    expect(cardKeyAction(key("1", { composing: true }), options, 0)).toEqual({ type: "none" });
  });

  it("none of them while a text field has the focus", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Enter", "1", "2", "3"]) {
      expect(cardKeyAction(key(k, { textFocused: true }), options, 0), k).toEqual({ type: "none" });
    }
    // The page's rule for "a text field has the focus" (the box, a search field, a terminal, another tile).
    expect(windowEscStops({ tagName: "TEXTAREA" }, null, "w1:p1")).toBe(false);
    expect(windowEscStops({ tagName: "INPUT", type: "search" }, null, "w1:p1")).toBe(false);
    expect(windowEscStops({ tagName: "DIV", closest: (s) => (s === ".term-host" ? {} : null) }, null, "w1:p1")).toBe(false);
    expect(windowEscStops({ tagName: "DIV", closest: (s) => (s === "[data-tile]" ? { getAttribute: () => "w1:p2" } : null) }, null, "w1:p1")).toBe(false);
    expect(windowEscStops({ tagName: "BUTTON", type: "submit" }, null, "w1:p1")).toBe(true);
    expect(windowEscStops({ tagName: "DIV", closest: () => null }, null, "w1:p1")).toBe(true);
  });

  it("[y/N]: 1 and 2 pick its letters in order", () => {
    const yesNo = match(F.codexYesNo, "w1:p1", null).options;
    expect(cardKeyAction(key("2"), yesNo, 1)).toEqual({ type: "pick", index: 1 });
    expect(cardKeyAction(key("1"), yesNo, 1)).toEqual({ type: "pick", index: 0 });
    expect(cardKeyAction(key("3"), yesNo, 1)).toEqual({ type: "none" });
  });

  it("Esc on a blocked agent is not Stop", () => {
    expect(stopPossible({ isAgent: true, status: "blocked", online: true })).toBe(false);
  });
});

describe("the box while the card shows", () => {
  it("with a “No, tell…” option: its placeholder, and Send answers with it", () => {
    const reading = matchPromptFor(L.claude2_1_303Bash, "w1:p1");
    const box = boxAnswer({ asking: true, reading, kind: "claude", busy: false })!;
    expect(box.placeholder).toBe("Tell Claude Code what to do instead (answers 4)");
    expect(box.tell?.key).toBe("4");
    expect(box.refusal("Use the staging folder", 0)).toBeNull();
    expect(box.refusal("   ", 0)).toBe("Not sent: the box is empty");
    expect(box.refusal("text", 1)).toBe("Not sent: pictures and files cannot go with “No”. The text is kept.");
    expect(boxAnswer({ asking: true, reading, kind: "claude", busy: true })!.refusal("text", 0)).toBe(
      "Not sent: an answer to this question is already going. The text is kept.",
    );
    expect(boxAnswer({ asking: false, reading, kind: "claude", busy: false })).toBeNull();
  });

  it("without one: says the agent is waiting on the question above, and a Send keeps the draft with that note", () => {
    for (const reading of [matchPrompt(demoAskScreen, "w1:p1"), matchPrompt(F.working, "w1:p1"), null]) {
      const box = boxAnswer({ asking: true, reading, kind: "claude", busy: false })!;
      expect(box.placeholder).toBe("Claude Code is waiting on the question above");
      expect(box.tell).toBeNull();
      expect(box.refusal("Use the internal testers", 0)).toBe("Not sent: Claude Code is waiting on the question above. The text is kept.");
    }
  });
});

const host: HostView = {
  id: "box",
  name: "build-box",
  kind: "demo",
  address: "demo",
  platform: "Linux",
  state: "connected",
  error: null,
  topology: null,
  fetchedAtMs: 0,
  authRefused: false,
  connection: 1,
  incarnation: 1,
  epoch: 0,
} as unknown as HostView;

const row = (status: SidebarRow["status"] = "blocked"): SidebarRow => ({ paneID: "w1:p1", isAgent: true, status, kind: "claude", name: "beacon" }) as unknown as SidebarRow;

/** A bridge that answers as main would and keeps each request. */
function fakeBridge(results: AnswerResult[]): { bridge: Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt">; asked: AnswerRequest[] } {
  const asked: AnswerRequest[] = [];
  return {
    asked,
    bridge: {
      listPrompts: () => Promise.resolve([]),
      onPromptsChanged: () => () => undefined,
      answerPrompt: (request) => {
        asked.push(request);
        return Promise.resolve(results.shift() ?? { type: "sent", label: "?" });
      },
    },
  };
}

function prompt(text: string, episode = "e1"): PanePrompt {
  return { hostId: "box", paneId: "w1:p1", episode, incarnation: 1, connection: 1, epoch: 1, reading: matchPromptFor(text, "w1:p1"), quiet: !promptLike(text), cleared: false };
}

describe("the card's answers (needs-card-store)", () => {
  it("answers with the option's key and the fingerprint shown; Sent stays until another question shows", async () => {
    const store = new NeedsCardStore();
    store.receive([prompt(L.claude2_1_303Bash)]);
    const shown = readingMatch(store.forPane("box", "w1:p1")!.reading!)!;
    const { bridge, asked } = fakeBridge([{ type: "sent", label: "Yes" }]);
    await store.answer(bridge, host, "w1:p1", "claude", shown, shown.options[0]!);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ hostId: "box", paneId: "w1:p1", key: "1", fingerprint: shown.fingerprint, episode: "e1" });
    expect(asked[0]!.text).toBeUndefined();
    expect(store.card("box", "w1:p1").sent?.label).toBe("Yes");
    // The same question still on screen, or a screen with none: still sent.
    store.receive([prompt(L.claude2_1_303Bash)]);
    store.receive([prompt(F.working)]);
    expect(store.card("box", "w1:p1").sent?.label).toBe("Yes");
    // Another question: the card shows it.
    store.receive([prompt(L.claude2_1_303Write)]);
    expect(store.card("box", "w1:p1").sent).toBeNull();
  });

  it("a frame the app cannot read keeps Sent (it proves no other question); the card shows its lines", async () => {
    const store = new NeedsCardStore();
    store.receive([prompt(L.claude2_1_303Bash)]);
    const shown = readingMatch(store.forPane("box", "w1:p1")!.reading!)!;
    await store.answer(fakeBridge([{ type: "sent", label: "Yes" }]).bridge, host, "w1:p1", "claude", shown, shown.options[0]!);
    store.receive([prompt(L.claude2_1_303Trust)]);
    expect(store.card("box", "w1:p1").sent?.label).toBe("Yes");
    expect(store.forPane("box", "w1:p1")!.reading!.type).toBe("unmatched");
    // A whole frame of another question ends it.
    store.receive([prompt(L.claude2_1_303Write)]);
    expect(store.card("box", "w1:p1").sent).toBeNull();
  });

  it("“Not sent: the question changed” stays on the card, which shows the new question", async () => {
    const store = new NeedsCardStore();
    store.receive([prompt(L.claude2_1_303Bash)]);
    const shown = readingMatch(store.forPane("box", "w1:p1")!.reading!)!;
    const { bridge } = fakeBridge([{ type: "changed", note: "Not sent: the question changed", now: matchPrompt(L.claude2_1_303Write, "w1:p1") }]);
    await store.answer(bridge, host, "w1:p1", "claude", shown, shown.options[0]!);
    expect(store.card("box", "w1:p1")).toMatchObject({ sent: null, note: "Not sent: the question changed", busy: false });
  });

  it("the tell option with the box's text; the box keeps its note when the text did not go", async () => {
    const store = new NeedsCardStore();
    store.receive([prompt(L.claude2_1_303Bash)]);
    const shown = readingMatch(store.forPane("box", "w1:p1")!.reading!)!;
    const note = "“No” went, but the text was not sent: Claude did not open its text field yet. It is kept.";
    const { bridge, asked } = fakeBridge([{ type: "answeredOnly", label: "No", note }]);
    await store.answer(bridge, host, "w1:p1", "claude", shown, shown.options[3]!, "Use the staging folder");
    expect(asked[0]).toMatchObject({ key: "4", text: "Use the staging folder" });
    expect(store.card("box", "w1:p1")).toMatchObject({ boxNote: note, note: null });
    expect(store.card("box", "w1:p1").sent?.label).toBe("No");
  });

  it("one answer at a time", async () => {
    const store = new NeedsCardStore();
    store.receive([prompt(L.claude2_1_303Bash)]);
    const shown = readingMatch(store.forPane("box", "w1:p1")!.reading!)!;
    const { bridge, asked } = fakeBridge([]);
    const first = store.answer(bridge, host, "w1:p1", "claude", shown, shown.options[0]!);
    expect(await store.answer(bridge, host, "w1:p1", "claude", shown, shown.options[1]!)).toBeNull();
    await first;
    expect(asked).toHaveLength(1);
  });
});

describe("the card rendered", () => {
  const previous = (globalThis as { window?: unknown }).window;
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { herdrDesktop: fakeBridge([]).bridge };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = previous;
    needsCards.receive([]);
  });
  const render = (status: SidebarRow["status"] = "blocked"): string =>
    renderToStaticMarkup(createElement(NeedsCard, { host, row: row(status), onShowTerminal: () => undefined }));

  it("a run: header, command, question, options with the one Return picks filled, the key hint", () => {
    needsCards.receive([prompt(L.claude2_1_303Bash)]);
    const html = render();
    expect(html).toContain('data-needs-card="run"');
    expect(html).toContain('<span class="nc-t">Claude Code wants to run</span>');
    expect(html).toContain('<code class="nc-target" title="echo shapes-c &gt; /private/tmp/z-shapes/c.txt">');
    expect(html).toContain('<div class="nc-q">Do you want to proceed?</div>');
    expect(html.match(/class="nc-opt on"/g)).toHaveLength(1);
    expect(html).toMatch(/<button class="nc-opt on" data-key="1"><span class="k">1<\/span><span class="l">Yes<\/span><\/button>/);
    expect(html).toContain("or type below to answer 4 in your words");
  });

  it("an edit: its diff rows and N more", () => {
    needsCards.receive([prompt(Launch.pairingPrompt)]);
    const html = render();
    expect(html).toContain('<span class="nc-t">Claude Code wants to edit</span>');
    expect(html.match(/class="dl added"/g)).toHaveLength(6);
    expect(html).toContain('<div class="dl more">12 more lines</div>');
  });

  it("unmatched: the lines and Answer in Terminal; before the first read: Reading the question", () => {
    needsCards.receive([{ hostId: "box", paneId: "w1:p1", episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading: { type: "unmatched", lines: ["Allow Codex to overwrite src/config.ts?", "Press enter to confirm or esc to cancel"] }, quiet: false, cleared: false }]);
    let html = render();
    expect(html).toContain('data-needs-card="unmatched"');
    expect(html).toContain("Claude Code needs you");
    expect(html).toContain('<pre class="nc-lines">Allow Codex to overwrite src/config.ts?\nPress enter to confirm or esc to cancel</pre>');
    expect(html).toContain("Answer in Terminal");
    expect(html).not.toContain("nc-opt");
    needsCards.receive([]);
    html = render();
    expect(html).toContain("Reading the question on build-box…");
  });

  it("after an answer: Sent: Yes in the options' place; a pane not blocked shows no card", async () => {
    needsCards.receive([prompt(L.claude2_1_303Bash)]);
    const shown = readingMatch(needsCards.forPane("box", "w1:p1")!.reading!)!;
    await needsCards.answer(fakeBridge([{ type: "sent", label: "Yes" }]).bridge, host, "w1:p1", "claude", shown, shown.options[0]!);
    const html = render();
    expect(html).toContain('<div class="nc-sent" data-sent="Yes">Sent: Yes</div>');
    expect(html).not.toContain("nc-opt");
    expect(render("working")).toBe("");
  });

  it("“Not sent: the question changed” shows on an unmatched card too", async () => {
    needsCards.receive([prompt(L.claude2_1_303Bash)]);
    const shown = readingMatch(needsCards.forPane("box", "w1:p1")!.reading!)!;
    // The re-read found a custom approval the app cannot read: nothing sent, main pushes the new reading.
    const now = matchPromptFor(F.unsupportedApproval, "w1:p1");
    await needsCards.answer(fakeBridge([{ type: "changed", note: "Not sent: the question changed", now }]).bridge, host, "w1:p1", "claude", shown, shown.options[0]!);
    needsCards.receive([prompt(F.unsupportedApproval)]);
    expect(needsCards.card("box", "w1:p1").note).toBe("Not sent: the question changed");
    const html = render();
    expect(html).toContain('data-needs-card="unmatched"');
    expect(html).toContain("A custom approval? Type CONFIRM or CANCEL");
    expect(html).toContain('<div class="nc-note">Not sent: the question changed</div>');
  });
});
