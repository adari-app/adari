// An answer from the card is bound to the
// question's words, not to how its rows wrap, and each refusal is recorded.
//
// - Each agent's question (Claude Code's Bash and Edit, Codex's command and
//   form, Grok's frame, Antigravity's three permission questions and its trust
//   question) read by the card at one width and again by the answer at
//   another, every pair of widths from 30 to 200: the key goes once, through
//   the real PromptService and the fake Herdr, unless a reading's row end is
//   one its reader cannot tell and the rows differ (refused, one
//   record). The same with main's last reading at a third width (the `shown`
//   place).
// - Each change that must stay another question: refused, no key, one record
//   naming the part that differed and nothing else.
// - The review's screens: a long word cut at the edge against a
//   blank there is refused with no key on every reader; a question line cut
//   mid-word is the same question as its wide drawing.
// - The pair table both apps run, the two fixtures both apps read, the
//   remembered selection, the cost, the record's fixed kinds, Report a
//   Problem's section.
// - The third review: Codex's option is never settled by the
//   command it quotes (its 80 policy-prefix and quoted-prefix screens refused,
//   no key, one record); a width above 2,000 columns, or one a row is wider
//   than, gives the no-width reading; its quote-read-cost screens read fast.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import { PromptService } from "../src/main/prompt/prompts";
import { NeedsCardStore } from "../src/renderer/chat/needs-card-store";
import { stopBindingOf } from "../src/shared/agent-stop";
import { feedbackIssueUrl, isFeedbackIssueUrl, refusalSection } from "../src/shared/feedback";
import { answerPrompt, readWithColumns } from "../src/shared/prompt/answerer";
import { fingerprintDifference, matchPrompt, readingMatch, sameFingerprint, type PromptFingerprint, type PromptMatch } from "../src/shared/prompt/matcher";
import { refusalAgent, refusalLimit, RefusalLog, refusalRecord, type PromptRefusal } from "../src/shared/prompt/refusals";
import type { AnswerRequest, PanePrompt } from "../src/shared/prompt/view";
import { fitsColumns, maxColumns, partText, type WrapFrame, type WrapSection } from "../src/shared/prompt/words";
import { changes, hasCard, longWordScreen, noCard, pairsFixture, redrawFixture, redrawSends, review2Screens, review3, reviewScreens, type Part } from "./support/card-words-fixtures";
import { A, C, F, G, L } from "./support/prompt-fixtures";
import { backend, clock, FakeHerdr, show, snapshot } from "./support/prompt-herdr";
import { codexCommand, drawAgyTrust, drawClaudeBash, drawCodexCommand, effectiveColumns, questions, widths } from "./support/redraw";
import { repoRoot } from "./support/swift-fixtures";

const update = process.env["HERDR_UPDATE_FIXTURES"] === "1";
const redrawsFile = path.join(repoRoot, "Tests/Fixtures/prompt-card-redraws.json");
const pairsFile = path.join(repoRoot, "Tests/Fixtures/prompt-same-question-pairs.json");

/** The screen each settling question shows after its digit took (the frame gone). */
const afterKey: Record<string, string> = { grok: G.liveAfter4, "codex-form": C.after };

/** A fake Herdr whose pane w1:p1 runs `agent`, blocked, showing `screen`, `columns` wide (none: no width); the PromptService read it once. */
async function setupAgent(agent: string, screen: string, columns: number[] | null = null) {
  const json = snapshot();
  const panes = json["panes"] as Record<string, unknown>[];
  const agents = json["agents"] as Record<string, unknown>[];
  panes[0]!["agent"] = agent;
  agents[0]!["agent"] = agent;
  agents[0]!["agent_session"] = { source: `herdr:${agent}`, agent, kind: "id", value: "s-1" };
  const herdr = new FakeHerdr(json, { "w1:p1": [screen], "w1:p2": [F.working] });
  herdr.columns = columns;
  const epoch = { value: 1 };
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, epoch));
  await registry.refreshAll();
  const time = clock();
  const service = new PromptService(registry, () => undefined, time);
  await service.tick();
  const prompt = (): PanePrompt => service.list().find((entry) => entry.paneId === "w1:p1")!;
  const shown = (): PromptMatch => readingMatch(prompt().reading!)!;
  const request = (key: string): AnswerRequest => ({
    hostId: "mac",
    paneId: "w1:p1",
    binding: stopBindingOf(registry.list()[0]!, "w1:p1", agent),
    fingerprint: shown().fingerprint,
    episode: prompt().episode,
    key,
  });
  return { herdr, service, time, shown, request };
}

const keysSent = (herdr: FakeHerdr): unknown[] => herdr.sent("pane.send_keys").map((entry) => entry["keys"]);

/** The key a question's answer is pressed with in these tests: its first option's (agy's trust: Return for the marked one). */
const firstKeys = (match: PromptMatch): readonly string[] => match.options[0]!.keys;

describe("the same question at another width: the key goes once", () => {
  for (const withColumns of [false, true]) {
  for (const question of questions) {
    for (const card of widths) {
      if (!hasCard(question.name, card)) continue;
      for (const fresh of widths) {
        if (!hasCard(question.name, fresh)) continue;
        const sends = redrawSends(question.name, card, fresh);
        const width = withColumns ? ", the pane's width given" : "";
        it(`${question.name}: the card read at ${card} columns, the answer's read at ${fresh}${width}: ${sends ? "sent" : "refused (a row's end not told)"}`, async () => {
          // With the pane's width: Herdr's layout says it before and after each read (the drawing's effective width).
          const columns = (at: number): number[] | null => (withColumns ? [effectiveColumns(question.name, at)] : null);
          const { herdr, service, shown, request } = await setupAgent(question.agent, question.draw(card), columns(card));
          const asked = request("1");
          const cardMatch = shown();
          // The pane is drawn at another width before the answer reads it (the Terminal tab opened, a split, a resize).
          herdr.columns = columns(fresh);
          show(herdr, "w1:p1", question.draw(fresh), ...(afterKey[question.name] === undefined ? [] : [afterKey[question.name]!]));
          const result = await service.answer(asked);
          if (sends) {
            expect(result.type).toBe("sent");
            expect(keysSent(herdr)).toEqual([firstKeys(cardMatch)]);
            expect(service.refusals.list()).toEqual([]);
          } else {
            expect(result.type).toBe("changed");
            expect(keysSent(herdr)).toEqual([]);
            const now = readingMatch(matchPrompt(question.draw(fresh), "w1:p1", question.agent, withColumns ? effectiveColumns(question.name, fresh) : null))!;
            expect(service.refusals.list().map((record) => [record.place, record.part])).toEqual([["fresh", fingerprintDifference(cardMatch.fingerprint, now.fingerprint)]]);
          }
        });
      }
    }
  }
  }

  it("a reader gives no card at the widths `noCard` names (the person answers in the Terminal there), and a card at every other", () => {
    for (const question of questions) {
      for (const width of widths) {
        expect(
          matchPrompt(question.draw(width), "w1:p1", question.agent) !== null && readingMatch(matchPrompt(question.draw(width), "w1:p1", question.agent)!) !== null,
          `${question.name} ${width}`,
        ).toBe(hasCard(question.name, width));
      }
    }
    expect(Object.keys(noCard).sort()).toEqual(["agy-create", "agy-edit"]);
  });

  it("main's last reading at a third width is still the card's question (the `shown` place passes)", async () => {
    for (const question of questions) {
      // Grok tells no row's end: its rows at 60, 140 and 200 differ, so its answer is refused (the table above says so).
      if (!redrawSends(question.name, 60, 140) || !redrawSends(question.name, 60, 200)) continue;
      const { herdr, service, request, time } = await setupAgent(question.agent, question.draw(60));
      const asked = request("1");
      // Main reads the pane again at 140 columns before the answer comes (its 2.5 s read), then the answer's read is at 200.
      show(herdr, "w1:p1", question.draw(140));
      time.t += 2_500;
      await service.tick();
      show(herdr, "w1:p1", question.draw(200), ...(afterKey[question.name] === undefined ? [] : [afterKey[question.name]!]));
      expect((await service.answer(asked)).type, question.name).toBe("sent");
      expect(keysSent(herdr), question.name).toHaveLength(1);
      expect(service.refusals.list(), question.name).toEqual([]);
    }
  });
});

describe("a question that changed: refused, no key, one record naming the part", () => {
  for (const change of changes) {
    const question = questions.find((candidate) => candidate.name === change.question)!;
    it(`${change.question}: ${change.name} (part ${change.part}; the card at ${change.card}, the change at ${change.width})`, async () => {
      const { herdr, service, shown, request, time } = await setupAgent(question.agent, question.draw(change.card));
      time.t = Date.UTC(2026, 10, 20, 7, 0, 0);
      const asked = request("1");
      const card = shown();
      show(herdr, "w1:p1", change.draw(change.width));
      const result = await service.answer(asked);
      expect(result.type).toBe("changed");
      if (result.type === "changed") expect(result.note).toBe("Not sent: the question changed");
      expect(herdr.sent("pane.send_keys")).toEqual([]);
      const records = service.refusals.list();
      expect(records).toHaveLength(1);
      const now = readingMatch(matchPrompt(change.draw(change.width), "w1:p1", question.agent))!;
      expect(records[0]).toEqual({
        at: Date.UTC(2026, 10, 20, 7, 0, 0),
        agent: question.agent,
        place: "fresh",
        part: change.part,
        shown: { rows: expect.any(Number), widest: expect.any(Number) },
        now: { rows: expect.any(Number), widest: expect.any(Number) },
      });
      expect(records[0]!.shown.rows).toBe(1 + [...card.fingerprint.body, ...card.fingerprint.options].filter((row) => row.trim() !== "").length);
      expect(records[0]!.now!.rows).toBe(1 + [...now.fingerprint.body, ...now.fingerprint.options].filter((row) => row.trim() !== "").length);
      // Nothing of the screen in the record: numbers and fixed words only.
      expect(Object.keys(records[0]!).sort()).toEqual(["agent", "at", "now", "part", "place", "shown"]);
    });
  }

  it("another kind of question (Claude's question dialog where its Bash question was): part kind", async () => {
    const { herdr, service, request } = await setupAgent("claude", drawClaudeBash(100));
    const asked = request("1");
    show(herdr, "w1:p1", A.sample);
    expect((await service.answer(asked)).type).toBe("changed");
    expect(herdr.sent("pane.send_keys")).toEqual([]);
    expect(service.refusals.list().map((record) => [record.place, record.part, record.now === null])).toEqual([["fresh", "kind", false]]);
  });

  it("no question on screen any more: part none, no reading shape", async () => {
    const { herdr, service, request } = await setupAgent("claude", drawClaudeBash(100));
    const asked = request("1");
    show(herdr, "w1:p1", F.working);
    expect((await service.answer(asked)).type).toBe("changed");
    expect(herdr.sent("pane.send_keys")).toEqual([]);
    expect(service.refusals.list().map((record) => [record.place, record.part, record.now])).toEqual([["fresh", "none", null]]);
  });

  it("the card's question against main's last reading (`shown`): another pane, another question, another block", async () => {
    const { herdr, service, request, time } = await setupAgent("claude", drawClaudeBash(80));
    const asked = request("1");
    // Another pane's fingerprint: refused before any read.
    expect((await service.answer({ ...asked, fingerprint: { ...asked.fingerprint, paneID: "w1:p9" } })).type).toBe("changed");
    // Main has since read another command (at another width).
    show(herdr, "w1:p1", changes.find((change) => change.question === "claude-bash" && change.name === "another command word")!.draw(140));
    time.t += 2_500;
    await service.tick();
    expect((await service.answer(asked)).type).toBe("changed");
    // The page's answer names a block main no longer reads.
    expect((await service.answer({ ...asked, episode: "another block" })).type).toBe("changed");
    expect(herdr.sent("pane.send_keys")).toEqual([]);
    expect(service.refusals.list().map((record) => [record.place, record.part])).toEqual([
      ["shown", "pane"],
      ["shown", "body"],
      ["shown", "none"],
    ]);
  });

  it("agy's trust question: the read between the arrow and Return shows another folder: Return never goes, one `trustStep` record", async () => {
    const { herdr, service, request } = await setupAgent("agy", drawAgyTrust(80));
    const asked = request("2");
    // The answer's read at 140 columns: the same folder; after the arrow, another folder.
    show(herdr, "w1:p1", drawAgyTrust(140), drawAgyTrust(140, "/tmp/demo/sample-folder/other"));
    const result = await service.answer(asked);
    expect(result.type).toBe("unsettled");
    expect(keysSent(herdr)).toEqual([["Down"]]);
    expect(service.refusals.list().map((record) => [record.agent, record.place, record.part])).toEqual([["agy", "trustStep", "body"]]);
  });

  it("agy's trust question: the arrow, then a read at another width with the marker moved: Return goes", async () => {
    const { herdr, service, request } = await setupAgent("agy", drawAgyTrust(80));
    const asked = request("2");
    const moved = drawAgyTrust(200).replace("> Yes, I trust this folder\n  No, exit", "  Yes, I trust this folder\n> No, exit");
    show(herdr, "w1:p1", drawAgyTrust(140), moved);
    expect((await service.answer(asked)).type).toBe("sent");
    expect(keysSent(herdr)).toEqual([["Down"], ["Enter"]]);
    expect(service.refusals.list()).toEqual([]);
  });

  it("ls / tmp/x is not ls /tmp/x: the answer for one never goes to the other", async () => {
    const one = drawClaudeBash(100, { description: "List a folder", command: "ls /tmp/x", question: "Do you want to proceed?", options: ["Yes", "No"] });
    const other = drawClaudeBash(140, { description: "List a folder", command: "ls / tmp/x", question: "Do you want to proceed?", options: ["Yes", "No"] });
    for (const [card, now] of [[one, other], [other, one]] as const) {
      const { herdr, service, request } = await setupAgent("claude", card);
      const asked = request("1");
      show(herdr, "w1:p1", now);
      expect((await service.answer(asked)).type).toBe("changed");
      expect(herdr.sent("pane.send_keys")).toEqual([]);
      expect(service.refusals.list().map((record) => record.part)).toEqual(["body"]);
    }
  });
});

describe("the review's screens (Tests/Fixtures/prompt-card-review-screens.json)", () => {
  for (const screen of reviewScreens.observations) {
    for (const [card, now, way] of [
      [screen.a, screen.b, "narrow card, wide read"],
      [screen.b, screen.a, "wide card, narrow read"],
    ] as const) {
      it(`${screen.name}: a long word cut at the edge is not the command with a blank there (${way}): refused, no key`, async () => {
        const { herdr, service, request } = await setupAgent(screen.agent, card);
        const asked = request("1");
        show(herdr, "w1:p1", now, "Listing done.\n\n");
        expect((await service.answer(asked)).type).toBe("changed");
        expect(herdr.sent("pane.send_keys")).toEqual([]);
        expect(service.refusals.list()).toHaveLength(1);
      });
    }
  }

  for (const screen of reviewScreens.strict) {
    const read = matchPrompt(screen.a, "w1:p1", screen.agent) === null ? null : readingMatch(matchPrompt(screen.a, "w1:p1", screen.agent)!);
    if (read === null) {
      it(`${screen.name}: the narrow screen gives no card (its reader's rules, unchanged)`, () => {
        expect(read).toBeNull();
        expect(screen.name).toBe("wrapped-option-like-digit");
      });
      continue;
    }
    it(`${screen.name}: the same question at 30 columns and at 200: the key goes once`, async () => {
      const { herdr, service, request, shown } = await setupAgent(screen.agent, screen.a);
      const asked = request("1");
      const card = shown();
      show(herdr, "w1:p1", screen.b, ...(screen.agent === "codex" ? [C.after] : []));
      expect((await service.answer(asked)).type).toBe("sent");
      expect(keysSent(herdr)).toEqual([firstKeys(card)]);
      expect(service.refusals.list()).toEqual([]);
    });
  }
});

describe("the second review's screens (Tests/Fixtures/prompt-card-review2-screens.json)", () => {
  // Each named case both ways through the service: sent once where the rule calls it one question, else refused.
  for (const screen of review2Screens) {
    for (const [card, now, way] of [
      [screen.a, screen.b, "a card, b read"],
      [screen.b, screen.a, "b card, a read"],
    ] as const) {
      it(`${screen.name} (${way}): ${screen.same ? "sent" : "refused, no key"}`, async () => {
        const { herdr, service, request, shown } = await setupAgent(screen.agent, card);
        const asked = request("1");
        const cardMatch = shown();
        // The read after the key (the question gone) for the questions whose answer is read until it goes.
        show(herdr, "w1:p1", now, "Listing done.\n\n");
        const result = await service.answer(asked);
        if (screen.same) {
          expect(result.type).toBe("sent");
          expect(keysSent(herdr)).toEqual([firstKeys(cardMatch)]);
        } else {
          expect(result.type).toBe("changed");
          expect(keysSent(herdr)).toEqual([]);
          expect(service.refusals.list()).toHaveLength(1);
        }
      });
    }
  }

  it("a literal U+FFFF in a diff line is a character, never a separator: the two lines are two questions, compared by their rows", () => {
    for (const name of ["agy-create/literal-noncharacter-boundary", "agy-edit/literal-noncharacter-boundary"]) {
      const screen = review2Screens.find((entry) => entry.name === name)!;
      const a = readingMatch(matchPrompt(screen.a, "w1:p1", "agy"))!;
      const b = readingMatch(matchPrompt(screen.b, "w1:p1", "agy"))!;
      expect(a.fingerprint.words?.body, name).toBeNull();
      expect(b.fingerprint.words?.body, name).toBeNull();
      expect(fingerprintDifference(a.fingerprint, b.fingerprint), name).toBe("body");
    }
  });

  it("the recorded Codex question at 134 columns and joined at 200: its option's row end is not settled by the command, so it is another question", () => {
    const screen = review2Screens.find((entry) => entry.name === "codex-command/recorded119-to-200/options-hyphen")!;
    const narrow = readingMatch(matchPrompt(screen.a, "w1:p1", "codex"))!;
    const wide = readingMatch(matchPrompt(screen.b, "w1:p1", "codex"))!;
    expect(narrow.fingerprint.words?.options).toBeNull();
    expect(wide.fingerprint.words?.options).toContain("results-day-one");
    expect(fingerprintDifference(narrow.fingerprint, wide.fingerprint)).toBe("options");
    // Whatever the command holds (the one text, the other, or neither), the option stays without text, compared by its rows.
    const command = (text: string, from: string, to: string): string => text.split("\n").map((row) => (row.startsWith("  $ ") ? row.replace(from, to) : row)).join("\n");
    for (const to of ["results- day-one/evidence", "results-day-two/evidence"]) {
      const reading = readingMatch(matchPrompt(command(screen.a, "results-day-one/evidence", to), "w1:p1", "codex"))!;
      expect(reading.fingerprint.words?.options, to).toBeNull();
      expect(reading.fingerprint.words?.body, to).toContain(to);
    }
  });
});

describe("the redraw helper against the recordings the second review checked", () => {
  it("Codex's options at 51 columns break after `/` as recorded (codex-0.163.0-narrow51-dialog)", () => {
    const recorded = readingMatch(matchPrompt(L.codex0_163_0Narrow51Dialog, "w1:p1", "codex"))!;
    const drawn = readingMatch(
      matchPrompt(
        drawCodexCommand(51, {
          question: "Would you like to run the following command?",
          reason: "Reason: write it",
          command: "echo narrow-codex > /private/tmp/z-narrow2-out/n.txt",
          options: ["Yes, proceed (y)", "Yes, and don't ask again for commands that start with `echo narrow-codex > /private/tmp/z-narrow2-out/n.txt` (p)", "No, and tell Codex what to do differently (esc)"],
        }),
        "w1:p1",
        "codex",
      ),
    )!;
    expect(drawn.fingerprint.options).toEqual(recorded.fingerprint.options);
    expect(recorded.fingerprint.options).toContain("     start with `echo narrow-codex > /private/tmp/");
  });

  it("Claude's option continuation rows at 54 columns are six cells in as recorded (claude-2.1.303-narrow54-bash-dialog)", () => {
    const recorded = readingMatch(matchPrompt(L.claude2_1_303Narrow54Bash, "w1:p1", "claude"))!;
    const drawn = readingMatch(
      matchPrompt(
        drawClaudeBash(54, {
          description: 'Write "narrow" to n.txt in z-narrow directory',
          command: "echo narrow > /private/tmp/z-narrow/n.txt",
          question: "Do you want to proceed?",
          options: ["Yes", "Yes, and always allow access to /private/tmp/z-narrow from this project", "Yes, and switch to auto mode \u00b7 auto mode handles these prompts for you", "No"],
        }),
        "w1:p1",
        "claude",
      ),
    )!;
    expect(drawn.fingerprint.options).toEqual(recorded.fingerprint.options);
    expect(recorded.fingerprint.options).toContain("      these prompts for you");
  });
});

describe("the pane's width, tied to the read", () => {
  /** The screen only the pane's width decides (`longWordScreen`, in the redraws fixture as `widthScreen`). */
  const longWord = longWordScreen;

  it("the width decides what the frame cannot, and a width the rows contradict is never used: the reading is the no-width reading", () => {
    const text = longWord(140);
    const none = readingMatch(matchPrompt(text, "w1:p1", "codex"))!;
    const given = readingMatch(matchPrompt(text, "w1:p1", "codex", 140))!;
    expect(none.fingerprint.words?.body).toBeNull();
    expect(given.fingerprint.words?.body).toContain(`${"a".repeat(100)} ${"b".repeat(40)}`);
    // Narrower than a row: not the width the screen was drawn at.
    expect(matchPrompt(text, "w1:p1", "codex", 100)).toEqual(matchPrompt(text, "w1:p1", "codex"));
  });

  it("readWithColumns: the width read before and after the screen, kept only when both agree and both were read", async () => {
    const reads = (...widths: (number | null | Error)[]) => {
      const queue = [...widths];
      return async (): Promise<number | null> => {
        const next = queue.shift()!;
        if (next instanceof Error) throw next;
        return next;
      };
    };
    expect(await readWithColumns(async () => "screen", reads(100, 100))).toEqual({ text: "screen", columns: 100 });
    expect(await readWithColumns(async () => "screen", reads(100, 120))).toEqual({ text: "screen", columns: null });
    expect(await readWithColumns(async () => "screen", reads(100, new Error("gone")))).toEqual({ text: "screen", columns: null });
    expect(await readWithColumns(async () => "screen", reads(null))).toEqual({ text: "screen", columns: null });
    expect(await readWithColumns(async () => "screen", undefined)).toEqual({ text: "screen", columns: null });
  });

  it("through the service: the card read with its width, a width that changed during the answer's read gives the no-width reading", async () => {
    const { herdr, service, shown, request } = await setupAgent("codex", longWord(140), [140]);
    expect(shown().fingerprint.words?.body).not.toBeNull();
    // Changed between the two layout reads around the answer's read: no width, the body compared by its rows (the same rows): sent.
    herdr.columns = [140, 120];
    show(herdr, "w1:p1", longWord(140));
    const asked = request("1");
    expect((await service.answer(asked)).type).toBe("sent");
    expect(herdr.sent("pane.layout").length).toBeGreaterThanOrEqual(4);
  });

  it("no layout call for a pane whose reader takes no width", async () => {
    const { herdr } = await setupAgent("claude", drawClaudeBash(80), [80]);
    expect(herdr.sent("pane.layout")).toEqual([]);
  });
});

describe("the answerer's own refusals (answerPrompt's `refused`)", () => {
  it("says `fresh` and the question the read showed, once per refusal; nothing for a key that went", async () => {
    const card = readingMatch(matchPrompt(drawClaudeBash(60), "w1:p1", "claude"))!;
    const heard: [string, PromptMatch | null][] = [];
    const sent: string[][] = [];
    const io = (text: string) => ({ read: async () => text, sendKeys: async (keys: readonly string[]) => void sent.push([...keys]) });
    expect((await answerPrompt(io(drawClaudeBash(200)), card.options[0]!, card, () => true, (place, now) => heard.push([place, now]))).type).toBe("sent");
    expect(heard).toEqual([]);
    const changed = changes.find((change) => change.question === "claude-bash" && change.name === "one character more")!.draw(100);
    expect((await answerPrompt(io(changed), card.options[0]!, card, () => true, (place, now) => heard.push([place, now]))).type).toBe("changed");
    expect(heard.map(([place, now]) => [place, now?.kind])).toEqual([["fresh", "menu"]]);
    expect(sent).toEqual([["1"]]);
  });
});

describe("the remembered selection (the card's arrows)", () => {
  const prompt = (text: string, agent: string): PanePrompt => ({
    hostId: "box",
    paneId: "w1:p1",
    episode: "e1",
    incarnation: 1,
    connection: 1,
    epoch: 1,
    reading: matchPrompt(text, "w1:p1", agent),
    quiet: false,
    cleared: false,
  });

  for (const question of questions) {
    // Grok tells no row's end: two widths where its rows are the same rows.
    // Codex's command question: two widths where its second option's row end is told (not at 60).
    const [narrow, wide] = question.name === "grok" ? [140, 200] : question.name === "codex-command" ? [100, 200] : [60, 200];
    it(`${question.name}: survives a redraw at another width (${narrow} and ${wide}), not another question`, () => {
      const store = new NeedsCardStore();
      store.receive([prompt(question.draw(narrow), question.agent)]);
      const at60 = readingMatch(store.forPane("box", "w1:p1")!.reading!)!;
      const last = at60.options.length - 1;
      store.select("box", "w1:p1", at60, last);
      store.receive([prompt(question.draw(wide), question.agent)]);
      const at200 = readingMatch(store.forPane("box", "w1:p1")!.reading!)!;
      expect(store.selection("box", "w1:p1", at200, 0)).toBe(last);
      const change = changes.find((candidate) => candidate.question === question.name)!;
      const other = readingMatch(matchPrompt(change.draw(140), "w1:p1", question.agent))!;
      expect(store.selection("box", "w1:p1", other, 0)).toBe(0);
    });
  }
});

describe("the fixtures both apps read", () => {
  const check = (file: string, value: unknown): void => {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (update) writeFileSync(file, text);
    expect(readFileSync(file, "utf8")).toBe(text);
  };

  it("prompt-card-redraws.json is the drawers' output, with the Mac's reading of each screen", () => {
    check(redrawsFile, redrawFixture());
  });

  it("prompt-same-question-pairs.json is the pair table as built", () => {
    check(pairsFile, pairsFixture());
  });

  it("every redrawn screen is read (a card at every width but `noCard`'s), and every change is read too", () => {
    const fixture = JSON.parse(readFileSync(redrawsFile, "utf8")) as { screens: { question: string; width: number; reading: unknown }[]; changes: { reading: unknown }[] };
    expect(fixture.screens).toHaveLength(questions.length * widths.length);
    expect(fixture.screens.every((screen) => (screen.reading !== null) === hasCard(screen.question, screen.width))).toBe(true);
    expect(fixture.changes.every((change) => change.reading !== null)).toBe(true);
  });
});

describe("the pair table (both apps run it with equal results)", () => {
  const table = JSON.parse(readFileSync(pairsFile, "utf8")) as { pairs: { name: string; a: PromptFingerprint; b: PromptFingerprint; same: boolean; part: Part | null }[] };

  it("holds at least 60 pairs, both kinds", () => {
    expect(table.pairs.length).toBeGreaterThanOrEqual(60);
    expect(table.pairs.filter((pair) => pair.same).length).toBeGreaterThanOrEqual(25);
    expect(table.pairs.filter((pair) => !pair.same).length).toBeGreaterThanOrEqual(25);
  });

  for (const pair of table.pairs) {
    it(`${pair.name}: ${pair.same ? "one question" : `another (${pair.part})`}`, () => {
      expect(sameFingerprint(pair.a, pair.b)).toBe(pair.same);
      expect(sameFingerprint(pair.b, pair.a)).toBe(pair.same);
      expect(fingerprintDifference(pair.a, pair.b)).toBe(pair.part);
      expect(fingerprintDifference(pair.b, pair.a)).toBe(pair.part);
    });
  }
});

describe("the cost of one comparison", () => {
  const time = (run: () => boolean): number => {
    run();
    const start = performance.now();
    for (let round = 0; round < 5; round += 1) run();
    return (performance.now() - start) / 5;
  };
  /** A fingerprint whose body is `rows`, its texts as a reader at `frame` makes them (each row its own section, or one section). */
  const reading = (rows: readonly string[], frame: WrapFrame, oneSection: boolean): PromptFingerprint => {
    const sections: WrapSection[] = oneSection ? [{ rows, next: 0, lines: false }] : rows.map((row) => ({ rows: [row], next: 0, lines: false }));
    const question: WrapSection = { rows: ["Do you want to proceed?"], next: 0, lines: false };
    const options: WrapSection = { rows: ["1. Yes", "2. No"], next: 0, lines: false };
    return {
      rules: 2,
      paneID: "w1:p1",
      question: "Do you want to proceed?",
      body: rows,
      options: ["1. Yes", "2. No"],
      words: { question: partText([question], frame), body: partText(sections, frame), options: partText([options], frame) },
    };
  };

  it("two readings of 200 rows of 500 characters, the second cut at 250 columns: read and compared well under 5 ms", () => {
    const rows = Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(497)}`);
    const wide = (): PromptFingerprint => reading(rows, { style: "either", low: 500, high: 500 }, false);
    const cut = (): PromptFingerprint => {
      const sections = rows.map((row): WrapSection => ({ rows: [row.slice(0, 250), row.slice(250)], next: 0, lines: false }));
      const fingerprint = reading(
        rows.flatMap((row) => [row.slice(0, 250), row.slice(250)]),
        { style: "either", low: 250, high: 250 },
        false,
      );
      return { ...fingerprint, words: { ...fingerprint.words!, body: partText(sections, { style: "either", low: 250, high: 250 }) } };
    };
    expect(sameFingerprint(wide(), cut())).toBe(true);
    expect(time(() => sameFingerprint(wide(), cut()))).toBeLessThan(5);
  });

  it("slow patterns (one row of 100,000 characters, a long run of blanks, a row's end at every turn): well under 5 ms", () => {
    const frame: WrapFrame = { style: "ink", low: 50, high: 52 };
    // One long row of "a b " against the same but its last word.
    const long = (): PromptFingerprint => reading(["a b ".repeat(25_000)], frame, true);
    const lastWord = (): PromptFingerprint => reading([`${"a b ".repeat(24_999)}a c `], frame, true);
    expect(sameFingerprint(long(), lastWord())).toBe(false);
    expect(time(() => sameFingerprint(long(), lastWord()))).toBeLessThan(5);
    // A run of 100,000 blanks before the one letter that differs.
    const blanks = (letter: string) => (): PromptFingerprint => reading([`echo ${" ".repeat(100_000)}${letter}`], frame, true);
    expect(sameFingerprint(blanks("a")(), blanks("b")())).toBe(false);
    expect(time(() => sameFingerprint(blanks("a")(), blanks("b")()))).toBeLessThan(5);
    // 2,000 rows of 50 cells, one section: a row's end decided (or not) 1,999 times.
    const rows = Array.from({ length: 2_000 }, (_, index) => `${"w".repeat(45)} ${String(index).padStart(3, "0")}`.slice(0, 50));
    expect(sameFingerprint(reading(rows, frame, true), reading(rows, frame, true))).toBe(true);
    expect(time(() => sameFingerprint(reading(rows, frame, true), reading(rows, frame, true)))).toBeLessThan(5);
  });

  it("a row's end not told: the part has no text, and is compared by its rows", () => {
    // A row exactly full at an edge the frame does not show (textwrap, no high), ending in `|`: a blank, or a break after `|`.
    const frame: WrapFrame = { style: "textwrap", low: 13, high: null };
    const text = (rows: readonly string[]): string | null => partText([{ rows, next: 0, lines: false }], frame);
    expect(text(["ls /tmp | cat |", "head"])).toBeNull();
    expect(text(["ls /tmp | cat | head"])).toBe("ls /tmp | cat | head");
    // A reader that settles it: exactly one of the two texts agrees with what else its screen shows.
    const settled = (rows: readonly string[], shown: string): string | null => partText([{ rows, next: 0, lines: false }], frame, (one) => shown.includes(one));
    expect(settled(["ls /tmp | cat |", "head"], "$ ls /tmp | cat | head")).toBe("ls /tmp | cat | head");
    expect(settled(["ls /tmp | cat |", "head"], "$ ls /tmp | cat |head")).toBe("ls /tmp | cat |head");
    // Both agree, or neither: not settled.
    expect(settled(["ls /tmp | cat |", "head"], "ls /tmp | cat |head and ls /tmp | cat | head")).toBeNull();
    expect(settled(["ls /tmp | cat |", "head"], "cat")).toBeNull();
  });
});

describe("the record and Report a Problem", () => {
  const details = { version: "0.1.2", signedRelease: true, macOS: "15.1.0", chip: "Apple silicon" };
  const repo = { owner: "example", repo: "app" };
  const bash = readingMatch(matchPrompt(drawClaudeBash(80), "w1:p1", "claude"))!;
  const record = (at: number, agent: string | null = "claude"): PromptRefusal => refusalRecord(at, agent, "fresh", bash, null);

  it("keeps the last 50, oldest first", () => {
    const log = new RefusalLog();
    for (let index = 0; index < 60; index += 1) log.record(record(index));
    expect(refusalLimit).toBe(50);
    expect(log.list().map((entry) => entry.at)).toEqual(Array.from({ length: 50 }, (_, index) => index + 10));
  });

  it("the agent's kind is one of a fixed set: a known kind (agent-names.ts), else `other`; none or empty is `unknown`", () => {
    expect(record(0, "Claude").agent).toBe("claude");
    expect(record(0, "codex").agent).toBe("codex");
    expect(record(0, "github-copilot").agent).toBe("copilot");
    expect(record(0, null).agent).toBe("unknown");
    expect(refusalAgent(undefined)).toBe("unknown");
    expect(refusalAgent("")).toBe("unknown");
    expect(record(0, "/Users/someone/bin/agent").agent).toBe("other");
    // The review's case: a plain word Herdr may report that names no known agent (a project, a person) never reaches the record.
    expect(refusalAgent("private-project")).toBe("other");
    const url = feedbackIssueUrl("problem", details, repo, [record(0, "private-project")]);
    expect(new URL(url).searchParams.get("body")).not.toContain("private-project");
    expect(new URL(url).searchParams.get("body")).toContain(" other fresh none");
  });

  it("Report a Problem carries the count, the parts and the newest records, counts and fixed words only", () => {
    const other = changes.find((change) => change.question === "claude-bash" && change.name === "another command word")!.draw(200);
    const refusals = [refusalRecord(Date.UTC(2026, 10, 18, 19, 5, 0), "claude", "fresh", bash, readingMatch(matchPrompt(other, "w1:p1", "claude"))), record(Date.UTC(2026, 10, 18, 19, 6, 0))];
    const url = feedbackIssueUrl("problem", details, repo, refusals);
    expect(isFeedbackIssueUrl(url, repo)).toBe(true);
    const body = new URL(url).searchParams.get("body")!;
    expect(body).toContain(`### ${refusalSection}\n\n- Kept: 2 (the last 50). By part: body 1, none 1.\n`);
    // The card's reading at 80 columns: its question's row, 9 rows of body and options, the widest 76 cells.
    expect(body).toContain("- 2026-11-18T19:06:00Z claude fresh none, rows 10/-, widest 76/-\n");
    expect(body).toMatch(/- 2026-11-18T19:05:00Z claude fresh body, rows 10\/\d+, widest 76\/\d+\n/u);
    // The newest first.
    expect(body.indexOf("19:06:00Z")).toBeLessThan(body.indexOf("19:05:00Z"));
    // Nothing of the screen: no command, path or option words.
    for (const word of ["ls", "/tmp", "sample", "Yes", "proceed"]) expect(body.slice(body.indexOf(refusalSection))).not.toContain(word);
    // Send Feedback carries none; nor does Report a Problem without refusals.
    expect(new URL(feedbackIssueUrl("feedback", details, repo, refusals)).searchParams.get("body")).not.toContain(refusalSection);
    expect(new URL(feedbackIssueUrl("problem", details, repo, [])).searchParams.get("body")).not.toContain(refusalSection);
  });

  it("fifty records stay under 2,000 characters: the oldest left out first, the count line kept", () => {
    const fifty = Array.from({ length: 50 }, (_, index) => record(Date.UTC(2026, 10, 18, 19, index, 0)));
    const url = feedbackIssueUrl("problem", details, repo, fifty);
    expect(url.length).toBeLessThan(2_000);
    expect(isFeedbackIssueUrl(url, repo)).toBe(true);
    const body = new URL(url).searchParams.get("body")!;
    expect(body).toContain("- Kept: 50 (the last 50). By part: none 50.");
    expect(body).toContain("19:49:00Z");
    expect(body).not.toContain("19:00:00Z");
  });
});

describe("the third review's screens (Tests/Fixtures/prompt-card-review3-screens.json)", () => {
  it("holds the review's 40 policy-prefix and 40 quoted-prefix pairs, 60 of them sent on 347f98bb", () => {
    expect(review3.cases.filter((screen) => screen.name.startsWith("shell-policy-prefix/"))).toHaveLength(40);
    expect(review3.cases.filter((screen) => screen.name.startsWith("quoted-prefix-boundary/"))).toHaveLength(40);
    expect(review3.cases.filter((screen) => screen.acceptedBefore)).toHaveLength(60);
    expect(review3.cases.every((screen) => !screen.same)).toBe(true);
  });

  const option = (quote: string): string => `Yes, and don't ask again for commands that start with \`${quote}\` (p)`;
  const options = (quote: string): string[] => ["Yes, proceed (y)", option(quote), "No, and tell Codex what to do differently (esc)"];
  const codex = (width: number, command: string, quote: string): string =>
    drawCodexCommand(width, { ...codexCommand, reason: "Reason: List a folder", command, options: options(quote) });
  const optionsText = (text: string, columns: number | null = null): string | null | undefined =>
    readingMatch(matchPrompt(text, "w1:p1", "codex", columns))!.fingerprint.words?.options;

  // Each policy-prefix and quoted-prefix pair, the card at the review's narrow width (with its width or
  // none) and the answer's read at 500 columns: refused, no key, one record naming the part (60 of them sent before).
  for (const screen of review3.cases) {
    it(`${screen.name}: refused, no key, one ${screen.part} record${screen.acceptedBefore ? " (sent on 347f98bb)" : ""}`, async () => {
      const { herdr, service, request } = await setupAgent("codex", screen.a, screen.wa === null ? null : [screen.wa]);
      const asked = request("1");
      herdr.columns = screen.wb === null ? null : [screen.wb];
      show(herdr, "w1:p1", screen.b, "Listing done.\n\n");
      expect((await service.answer(asked)).type).toBe("changed");
      expect(keysSent(herdr)).toEqual([]);
      const records = service.refusals.list();
      expect(records).toHaveLength(1);
      expect(records[0]!.part).toBe(screen.part);
    });
  }

  it("the lasting option (digit 2) of shell-policy-prefix/80/12/80 never goes either", async () => {
    const screen = review3.cases.find((entry) => entry.name === "shell-policy-prefix/80/12/80")!;
    const card = readingMatch(matchPrompt(screen.a, "w1:p1", "codex", 80))!;
    const keys: (readonly string[])[] = [];
    const result = await answerPrompt({ read: async () => screen.b, columns: async () => 500, sendKeys: async (sent) => void keys.push(sent) }, card.options[1]!, card);
    expect(result.type).toBe("changed");
    expect(keys).toEqual([]);
  });

  it("an option's row end is never settled by the command it quotes: each way the command can hold the quote, as before where it held none", () => {
    const stem = `echo ${"a".repeat(12)}`;
    // The quote is in the command only with its quoting removed, and the other text is there too: no text.
    expect(optionsText(codex(80, `${stem}\\-b; ${stem}- b`, `${stem}-b`), 80)).toBeNull();
    // The other text is absent with and without quoting (the one the option quotes is there): no text either.
    expect(optionsText(codex(80, `${stem}-b`, `${stem}-b`), 80)).toBeNull();
    expect(optionsText(codex(80, `${stem}- b`, `${stem}- b`), 80)).toBeNull();
    // As before: no quote in backticks, a quote of text not in the command, a command that is itself undecided.
    const plainAt = (n: number): string =>
      drawCodexCommand(80, { ...codexCommand, reason: "Reason: List a folder", command: `echo ${"a".repeat(n)}-b`, options: ["Yes, proceed (y)", `Yes, and don't ask again for echo ${"a".repeat(n)}-b (p)`, "No (esc)"] });
    const n = Array.from({ length: 70 }, (_, index) => index + 1).find((count) => plainAt(count).includes(`echo ${"a".repeat(count)}-\n`))!;
    expect(n).toBeDefined();
    expect(optionsText(plainAt(n), 80)).toBeNull();
    expect(optionsText(codex(80, "echo done", `${stem}-b`), 80)).toBeNull();
    const undecidedCommand = codex(80, `echo ${"z".repeat(240)}`, `${stem}-b`);
    expect(readingMatch(matchPrompt(undecidedCommand, "w1:p1", "codex"))!.fingerprint.words?.body).toBeNull();
    expect(optionsText(undecidedCommand)).toBeNull();
    // An option that does not wrap, or wraps at a blank the frame tells, still has its text.
    expect(optionsText(codex(200, `${stem}-b`, `${stem}-b`), 200)).toContain(`\`${stem}-b\``);
  });

  it("a width above 2,000 columns, or one a row is wider than, gives exactly the no-width reading", () => {
    const screens = [JSON.parse(readFileSync(redrawsFile, "utf8")).widthScreen as { text: string; agent: string }, { text: longWordScreen(140), agent: "codex" }];
    for (const screen of screens) {
      const none = matchPrompt(screen.text, "w1:p1", screen.agent);
      for (const columns of [0, -5, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maxColumns + 1, 1e9, Number.MAX_SAFE_INTEGER]) {
        expect(fitsColumns(screen.text.split("\n"), columns), String(columns)).toBeNull();
        expect(matchPrompt(screen.text, "w1:p1", screen.agent, columns), String(columns)).toEqual(none);
      }
    }
    expect(fitsColumns(["a".repeat(140)], maxColumns)).toBe(maxColumns);
    expect(fitsColumns(["a".repeat(140)], 139)).toBeNull();
  });

  it("through the service: a pane 1,000,000,000 columns wide is read with no width", async () => {
    const { shown } = await setupAgent("codex", longWordScreen(140), [1e9]);
    expect(shown().fingerprint).toEqual(readingMatch(matchPrompt(longWordScreen(140), "w1:p1", "codex"))!.fingerprint);
  });

  // The review's screens whose quoted prefix was searched for in the command (the 34-row one: 43,203
  // characters of command), read whole by Codex's reader with their width and without: tens of milliseconds.
  for (const screen of review3.cost) {
    it(`${screen.name} (${screen.rows} rows, a ${screen.commandLength}-character command): read in tens of milliseconds`, () => {
      for (const columns of [screen.columns, null]) {
        readingMatch(matchPrompt(screen.a, "w1:p1", "codex", columns));
        const start = performance.now();
        const match = readingMatch(matchPrompt(screen.a, "w1:p1", "codex", columns));
        const ms = performance.now() - start;
        expect(match, String(columns)).not.toBeNull();
        expect(match!.fingerprint.words?.options, String(columns)).toBeNull();
        expect(ms, `${columns}: ${ms} ms`).toBeLessThan(50);
      }
    });
  }
});
