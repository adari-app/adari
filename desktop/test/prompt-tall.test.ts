// The needs-you card when Claude Code's command (or diff) is taller than the
// card's 40-line read: the card must still say what the question is. The frames
// are Claude Code 2.1.303's (test/support/tall-prompts.ts). Every test here
// goes through what main and the page already had (matchPrompt, cardContent,
// the service on a fake Herdr, the answerer, the card rendered). A frame whose
// header is above even the taller read is never answered in Chat;
// prompt-tall-headless.test.ts holds more of those cases.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NeedsCard } from "../src/renderer/chat/NeedsCard";
import { needsCards } from "../src/renderer/chat/needs-card-store";
import { bashDetail, toolCall, type ChatToolCall } from "../src/shared/chat/model";
import type { HerdrDesktopBridge, HostView } from "../src/shared/ipc-contract";
import { needsPillKinds } from "../src/shared/needs-pill";
import { answerPrompt } from "../src/shared/prompt/answerer";
import { cardContent } from "../src/shared/prompt/card";
import { fingerprintRules, matchPrompt, readingCut, readingForAgent, readingMatch, type PromptMatch, type PromptReading } from "../src/shared/prompt/matcher";
import { isAnswerRequest, type AnswerRequest, type PanePrompt } from "../src/shared/prompt/view";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { L, ScriptedPane } from "./support/prompt-fixtures";
import { setup, show } from "./support/prompt-herdr";
import { heredoc, longDiff, tail, tallBash, tallDescription, tallEdit, tallEditFile, yesAlwaysNo, yesNo } from "./support/tall-prompts";

/** The frame's last four rows: what the card shows when the header is cut off (NeedsCard's unmatched lines). */
const lastFourRows = ["Do you want to proceed?", "❯ 1. Yes", "2. No", "Esc to cancel · Tab to amend"];

/** The reading main sends the page for `text` read on a Claude pane. */
const claudeReading = (text: string): PromptReading => readingForAgent(matchPrompt(text, "w1:p1", "claude"), "claude");

function matched(reading: PromptReading): PromptMatch {
  const match = readingMatch(reading);
  if (match === null) throw new Error(`expected a match, got ${JSON.stringify(reading).slice(0, 400)}`);
  return match;
}

const labels = (match: PromptMatch): string[] => match.options.map((option) => option.label);

describe("a command taller than the 40-line read", () => {
  it("30, 60 and 120 lines: the 40 lines end in the frame's last four rows; the taller read holds the header and matches the frame whole", () => {
    for (const [count, width] of [
      [30, 80],
      [60, 131],
      [120, 131],
    ] as const) {
      const screen = tallBash(heredoc(count), yesNo, 0, width);
      // The 40 lines: the frame cut off at its top, only its last four rows left.
      const first = matchPrompt(tail(screen, 40), "w1:p1", "claude");
      expect(first.type, `${count}`).toBe("unmatched");
      expect(readingCut(first)?.lines, `${count}`).toEqual(lastFourRows);
      // The taller read: matched whole, as the 27-row live frame is.
      const whole = matched(claudeReading(tail(screen, 200)));
      expect(whole.question).toBe("Do you want to proceed?");
      expect(labels(whole)).toEqual(["Yes", "No"]);
      expect(whole.run?.rows, `${count}`).toEqual(heredoc(count));
      expect(whole.run?.description, `${count}`).toBe(tallDescription);
      expect(whole.fingerprint.body[0]).toBe(" Bash command");
    }
  });

  it("a Codex or Grok pane, or none named, reads the same 40 lines as before: unmatched, the same four rows, nothing cut", () => {
    const text = tail(tallBash(heredoc(60)), 40);
    for (const kind of ["codex", "grok", null]) {
      expect(matchPrompt(text, "w1:p1", kind), `${kind}`).toEqual({ type: "unmatched", lines: lastFourRows });
    }
  });

  it("not cut: a read holding the whole pane (fewer than 40 rows: read from its top, as before), or a bullet above the question", () => {
    const screen = tallBash(heredoc(60));
    const whole = matchPrompt(tail(screen, 39), "w1:p1", "claude");
    expect(readingCut(whole)).toBeNull();
    expect(whole).toEqual(matchPrompt(tail(screen, 39), "w1:p1"));
    const bullet = matchPrompt(["⏺ An earlier reply", ...tail(screen, 39).split("\n")].join("\n"), "w1:p1", "claude");
    expect(readingCut(bullet)).toBeNull();
  });
});

describe("the card says what is asked", () => {
  it("Claude wants to run, its description, the command's first six rows and N more, Yes and No side by side", () => {
    for (const [count, width] of [
      [30, 80],
      [60, 131],
      [120, 131],
    ] as const) {
      const content = cardContent(matched(claudeReading(tail(tallBash(heredoc(count), yesNo, 0, width), 200))), "claude");
      expect(content.kind).toBe("run");
      expect(content.header).toBe("Claude Code wants to run");
      expect(content.target).toBeNull();
      expect(content.description).toBe(tallDescription);
      expect(content.commandRows).toEqual(heredoc(count).slice(0, 6));
      expect(content.commandMore, `${count}`).toBe(count - 6);
      expect(content.question).toBe("Do you want to proceed?");
      expect(content.options.map((option) => option.key)).toEqual(["1", "2"]);
      expect(content.returnIndex).toBe(0);
    }
  });

  it("an Edit with a long diff: main reads it taller; its file, six diff rows and N more", async () => {
    const screen = tallEdit(longDiff(40));
    expect(matchPrompt(tail(screen, 40), "w1:p1", "claude").type).toBe("unmatched");
    const { herdr, service } = await setup(screen);
    expect(herdr.sent("pane.read").map((read) => read["lines"])).toEqual([40, 200]);
    const content = cardContent(matched(service.list()[0]!.reading!), "claude");
    expect(content.kind).toBe("edit");
    expect(content.header).toBe("Claude Code wants to edit");
    expect(content.target).toBe(tallEditFile);
    expect(content.lines).toHaveLength(6);
    expect(content.lines[1]).toEqual({ number: "41", kind: "removed", text: "  const step0 = runs[0]?.ms ?? 0;" });
    expect(content.moreLines).toBe(75);
    expect(content.question).toBe("Do you want to make this edit to summary.ts?");
  });

  it("an answer's fingerprint from the taller read is one the page may send (at most 200 body rows)", async () => {
    for (const screen of [tallBash(heredoc(120)), tallBash(heredoc(180)), tallEdit(longDiff(90))]) {
      const { service, request } = await setup(screen);
      await service.tick();
      const asked = request("1");
      expect(asked.fingerprint.body.length).toBeGreaterThan(100);
      expect(asked.fingerprint.body.length).toBeLessThanOrEqual(200);
      expect(isAnswerRequest(asked)).toBe(true);
    }
  });
});

describe("main reads the pane taller once and answers only the frame it showed", () => {
  it("a 60-line command: 40 lines, then 200; matched whole; Yes sends 1 after the same two reads", async () => {
    const { herdr, service, request } = await setup(tallBash(heredoc(60)), [L.claude2_1_303AfterNo]);
    expect(herdr.sent("pane.read").map((read) => read["lines"])).toEqual([40, 200]);
    const match = matched(service.list()[0]!.reading!);
    expect(cardContent(match, "claude").header).toBe("Claude Code wants to run");
    expect(await service.answer(request("1"))).toEqual({ type: "sent", label: "Yes" });
    expect(herdr.sent("pane.send_keys")).toEqual([{ pane_id: "w1:p1", keys: ["1"] }]);
    expect(herdr.sent("pane.read").map((read) => read["lines"])).toEqual([40, 200, 40, 200]);
  });

  it("a frame that moved between the card and the answer sends nothing", async () => {
    const { herdr, service, request } = await setup(tallBash(heredoc(60)));
    const asked = request("1");
    show(herdr, "w1:p1", tallBash(heredoc(61)));
    expect((await service.answer(asked)).type).toBe("changed");
    expect(herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("the header scrolled away (250 lines): unmatched however often it is read, Claude's own Yes/No too; its rows kept for the card", async () => {
    const { herdr, service } = await setup(tallBash(heredoc(250)), [L.claude2_1_303AfterNo]);
    for (let read = 0; read < 3; read += 1) {
      const reading = service.list()[0]!.reading!;
      expect(reading.type, `read ${read}`).toBe("unmatched");
      expect(readingCut(reading)?.question).toBe("Do you want to proceed?");
      expect(readingCut(reading)?.lines).toEqual(lastFourRows);
      await service.tick();
    }
    expect(herdr.sent("pane.read").map((read) => read["lines"])).toEqual([40, 200, 40, 200, 40, 200, 40, 200]);
    expect(herdr.sent("pane.send_keys")).toEqual([]);
  });

  it("the header scrolled away and three options: unmatched however often it is read (Answer in Terminal)", async () => {
    const { service } = await setup(tallBash(heredoc(250), yesAlwaysNo));
    await service.tick();
    await service.tick();
    const reading = service.list()[0]!.reading!;
    expect(reading.type).toBe("unmatched");
    expect(reading.type === "unmatched" ? reading.cut?.lines : null).toEqual([
      "❯ 1. Yes",
      `2. ${yesAlwaysNo[1]}`,
      "3. No",
      "Esc to cancel · Tab to amend",
    ]);
  });

  it("a Codex or Grok pane is read once, 40 lines, as before", async () => {
    for (const kind of ["codex", "grok"]) {
      const { herdr, registry, service } = await setup(tallBash(heredoc(60)));
      herdr.agentEntry("w1:p1")["agent"] = kind;
      herdr.paneEntry("w1:p1")["agent"] = kind;
      await registry.refreshAll();
      const before = herdr.sent("pane.read").length;
      await service.tick();
      expect(herdr.sent("pane.read").slice(before).map((read) => read["lines"]), kind).toEqual([40]);
      expect(service.list()[0]!.reading, kind).toEqual({ type: "unmatched", lines: lastFourRows });
    }
  });

  it("the answerer sends nothing to a frame read without its header, whatever request names its rows", async () => {
    const text = tail(tallBash(heredoc(250)), 200);
    const cut = readingCut(matchPrompt(text, "p", "claude"))!;
    const yes = { key: "1", label: "Yes", isReturnDefault: true, isSessionWide: false, opensComposer: false, keys: ["1"] };
    const rows: PromptMatch = {
      kind: "menu",
      question: cut.question,
      options: [yes, { ...yes, key: "2", label: "No", isReturnDefault: false, keys: ["2"] }],
      context: null,
      fingerprint: { rules: fingerprintRules, paneID: "p", question: cut.question, body: cut.rows, options: ["❯ 1. Yes", "2. No"] },
    };
    const same = new ScriptedPane(text);
    expect((await answerPrompt(same.io, rows.options[0]!, rows)).type).toBe("changed");
    expect(same.sent).toEqual([]);
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

const row = { paneID: "w1:p1", isAgent: true, status: "blocked", kind: "claude", name: "beacon" } as unknown as SidebarRow;

function prompt(reading: PromptReading): PanePrompt {
  return { hostId: "box", paneId: "w1:p1", episode: "e1", incarnation: 1, connection: 1, epoch: 1, reading, quiet: false, cleared: false };
}

/** Chat's running Bash row (the transcript's last tool_use with no result yet). */
function bashCall(command: string, description: string | null = tallDescription): ChatToolCall {
  const call = toolCall("toolu_1", "bash", "Bash", command, { detail: { type: "bash", bash: bashDetail(command) } });
  return description === null ? call : { ...call, bashDescription: description };
}

function editCall(file: string): ChatToolCall {
  return toolCall("toolu_2", "edit", "Edit", file);
}

/** Text as react-dom/server writes it. */
const html = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

type Bridge = Pick<HerdrDesktopBridge, "listPrompts" | "onPromptsChanged" | "answerPrompt">;

function fakeBridge(): { bridge: Bridge; asked: AnswerRequest[] } {
  const asked: AnswerRequest[] = [];
  return {
    asked,
    bridge: {
      listPrompts: () => Promise.resolve([]),
      onPromptsChanged: () => () => undefined,
      answerPrompt: (request) => {
        asked.push(request);
        return Promise.resolve({ type: "sent", label: "Yes" });
      },
    },
  };
}

describe("the card rendered", () => {
  const previous = (globalThis as { window?: unknown }).window;
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { herdrDesktop: fakeBridge().bridge };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = previous;
    needsCards.receive([]);
  });
  const render = (pending: readonly ChatToolCall[] = []): string =>
    renderToStaticMarkup(createElement(NeedsCard, { host, row, onShowTerminal: () => undefined, pending } as Parameters<typeof NeedsCard>[0]));

  it("the 60-line command read whole: what Claude wants to run, its description, six rows and 54 more lines, Yes and No", () => {
    needsCards.receive([prompt(claudeReading(tail(tallBash(heredoc(60)), 200)))]);
    const page = render();
    expect(page).toContain('data-needs-card="run"');
    expect(page).toContain('<span class="nc-t">Claude Code wants to run</span>');
    expect(page).not.toContain("nc-target");
    expect(page).toContain(`<div class="nc-desc">${tallDescription}</div>`);
    expect(page).toContain(`<pre class="nc-cmd">${html(heredoc(60).slice(0, 6).join("\n"))}</pre>`);
    expect(page).toContain('<div class="nc-more">54 more lines</div>');
    expect(page).toContain('<div class="nc-q">Do you want to proceed?</div>');
    expect(page).toMatch(/<button class="nc-opt on" data-key="1"><span class="k">1<\/span><span class="l">Yes<\/span><\/button>/);
    expect(page).toMatch(/<button class="nc-opt" data-key="2"><span class="k">2<\/span><span class="l">No<\/span><\/button>/);
    expect(page).not.toContain("Answer in Terminal");
  });

  it("the header scrolled away: Chat's running command under its label (not read from the question), the screen's rows, Answer in Terminal", () => {
    needsCards.receive([prompt(claudeReading(tail(tallBash(heredoc(250)), 200)))]);
    const page = render([bashCall(heredoc(250).join("\n"))]);
    expect(page).toContain('data-needs-card="unmatched"');
    expect(page).toContain('data-subject="run"');
    expect(page).toContain('<span class="nc-t">Claude Code needs you</span>');
    expect(page).not.toContain("wants to run");
    expect(page).toContain('<div class="nc-from">Chat’s running call, not read from the question:</div>');
    expect(page).toContain(`<div class="nc-desc">Bash: ${tallDescription}</div>`);
    expect(page).toContain(`<pre class="nc-cmd">${html(heredoc(250).slice(0, 6).join("\n"))}</pre>`);
    expect(page).toContain('<div class="nc-more">244 more lines</div>');
    expect(page).toContain(`<pre class="nc-lines">${html(lastFourRows.join("\n"))}</pre>`);
    expect(page).toContain("Answer in Terminal");
    expect(page).not.toContain("nc-opt");
  });

  it("nothing names it (no running call, another command, an edit): the screen's rows and Answer in Terminal, no options", () => {
    needsCards.receive([prompt(claudeReading(tail(tallBash(heredoc(250)), 200)))]);
    for (const pending of [[], [bashCall("echo another command")], [bashCall(heredoc(251).join("\n"))], [editCall(tallEditFile)]]) {
      const page = render(pending);
      expect(page, pending[0]?.target ?? "none").toContain('data-needs-card="unmatched"');
      expect(page).toContain('<span class="nc-t">Claude Code needs you</span>');
      expect(page).not.toContain("nc-subj");
      expect(page).toContain(`<pre class="nc-lines">${html(lastFourRows.join("\n"))}</pre>`);
      expect(page).toContain("Answer in Terminal");
      expect(page).not.toContain("nc-opt");
    }
  });

  it("the header scrolled away with three options: Chat's call under its label, and Answer in Terminal", () => {
    needsCards.receive([prompt(claudeReading(tail(tallBash(heredoc(250), yesAlwaysNo), 200)))]);
    const page = render([bashCall(heredoc(250).join("\n"))]);
    expect(page).toContain('<span class="nc-t">Claude Code needs you</span>');
    expect(page).toContain("nc-from");
    expect(page).toContain("Answer in Terminal");
    expect(page).not.toContain("nc-opt");
  });

  it("an Edit with a long diff: read whole, its file and diff rows; its header scrolled away, Chat's Edit under its label, the file's name only", () => {
    needsCards.receive([prompt(claudeReading(tail(tallEdit(longDiff(40)), 200)))]);
    let page = render();
    expect(page).toContain('<span class="nc-t">Claude Code wants to edit</span>');
    expect(page).toContain(`<code class="nc-target" title="${tallEditFile}">`);
    expect(page.match(/class="dl removed"/g)).toHaveLength(3);
    expect(page).toContain('<div class="dl more">75 more lines</div>');
    needsCards.receive([prompt(claudeReading(tail(tallEdit(longDiff(150)), 200)))]);
    page = render([editCall(tallEditFile)]);
    expect(page).toContain('data-needs-card="unmatched"');
    expect(page).toContain('data-subject="edit"');
    expect(page).toContain('<span class="nc-t">Claude Code needs you</span>');
    expect(page).toContain('<div class="nc-desc">Edit <code class="nc-file">summary.ts</code></div>');
    expect(page).not.toContain(tallEditFile);
    expect(page).toContain("Answer in Terminal");
    expect(page).not.toContain("nc-opt");
  });

  it("the sidebar's pill: Claude's frame read without its header is an approval (it answers nothing)", () => {
    const cut = claudeReading(tail(tallBash(heredoc(250)), 200));
    const three = claudeReading(tail(tallBash(heredoc(250), yesAlwaysNo), 200));
    const pills = needsPillKinds([prompt(cut), { ...prompt(three), paneId: "w1:p2" }, { ...prompt({ type: "unmatched", lines: ["?"] }), paneId: "w1:p3" }]);
    expect([pills.get("box/w1:p1"), pills.get("box/w1:p2"), pills.get("box/w1:p3")]).toEqual(["approval", "approval", "input"]);
  });
});
