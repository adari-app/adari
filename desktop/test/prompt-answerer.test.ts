// The answerer (src/shared/prompt/answerer.ts), ported
// from CompanionPromptAnswererTests: the pane is read again and one key goes
// only while the question on screen is the one shown; a changed question, an
// unreadable pane or a closed gate sends nothing.

import { describe, expect, it } from "vitest";

import { answerPrompt, outcomeOf } from "../src/shared/prompt/answerer";
import { matchForAgent, matchPrompt, readingMatch, type PromptMatch } from "../src/shared/prompt/matcher";
import { F, L, Launch, ScriptedPane } from "./support/prompt-fixtures";

function shown(text: string, pane = "p"): PromptMatch {
  const match = readingMatch(matchPrompt(text, pane));
  if (match === null) throw new Error("expected a match");
  return match;
}

describe("CompanionPromptAnswererTests, ported", () => {
  it("sends the option's key once when the prompt is unchanged (the cursor moving does not count)", async () => {
    const match = shown(F.claudeEdit);
    const pane = new ScriptedPane(F.claudeEditCursorOnTwo());
    expect(await answerPrompt(pane.io, match.options[0]!, match)).toEqual({ type: "sent" });
    expect(pane.reads).toBe(1);
    expect(pane.sent).toEqual([["1"]]);
  });

  it("[y/N] sends the letter and Return", async () => {
    const match = shown(F.codexYesNo);
    const pane = new ScriptedPane(F.codexYesNo);
    expect(await answerPrompt(pane.io, match.options[1]!, match)).toEqual({ type: "sent" });
    expect(pane.sent).toEqual([["n", "Enter"]]);
  });

  it("a changed prompt sends nothing and returns what is showing", async () => {
    const match = shown(F.claudeEdit);
    const pane = new ScriptedPane(F.claudeBash);
    const outcome = await answerPrompt(pane.io, match.options[0]!, match);
    expect(outcome.type).toBe("changed");
    if (outcome.type === "changed") expect(readingMatch(outcome.now)?.question).toBe("Do you want to proceed?");
    expect(pane.sent).toEqual([]);

    const gone = new ScriptedPane(F.working);
    const goneOutcome = await answerPrompt(gone.io, match.options[0]!, match);
    expect(goneOutcome.type === "changed" && goneOutcome.now.type === "unmatched").toBe(true);
    expect(gone.sent).toEqual([]);
  });

  it("an unreadable pane sends nothing", async () => {
    const match = shown(F.claudeEdit);
    const pane = new ScriptedPane(F.claudeEdit);
    pane.readError = new Error("offline");
    expect(await answerPrompt(pane.io, match.options[0]!, match)).toEqual({ type: "unread", reason: "offline" });
    expect(pane.sent).toEqual([]);
  });
});

describe("the answerer's gates (desktop)", () => {
  it("the same question on another pane sends nothing", async () => {
    const match = shown(F.claudeEdit, "w1:p1");
    const reads: string[] = [];
    const sent: string[][] = [];
    const io = {
      read: async (paneID: string) => {
        reads.push(paneID);
        return F.claudeEdit;
      },
      sendKeys: async (keys: readonly string[]) => {
        sent.push([...keys]);
      },
    };
    expect(await answerPrompt(io, match.options[0]!, match)).toEqual({ type: "sent" });
    expect(reads).toEqual(["w1:p1"]);
    // The fingerprint binds the pane: a match read on w1:p2 is not this one.
    const elsewhere = shown(F.claudeEdit, "w1:p2");
    expect(elsewhere.fingerprint).not.toEqual(match.fingerprint);
  });

  it("a closed gate (the machine reconnected) sends nothing after the re-read", async () => {
    const match = shown(F.claudeEdit);
    const pane = new ScriptedPane(F.claudeEdit);
    let asked = 0;
    const outcome = await answerPrompt(pane.io, match.options[0]!, match, () => {
      asked += 1;
      return false;
    });
    expect(outcome).toEqual({ type: "withdrawn" });
    expect(asked).toBe(1);
    expect(pane.reads).toBe(1);
    expect(pane.sent).toEqual([]);
  });

  it("an option the prompt no longer offers sends nothing", async () => {
    const match = shown(F.claudeEdit);
    const pane = new ScriptedPane(F.claudeEdit);
    const ghost = { ...match.options[0]!, key: "9" };
    expect((await answerPrompt(pane.io, ghost, match)).type).toBe("changed");
    expect(pane.sent).toEqual([]);
  });

  it("the live option's keys go, not the shown option's", async () => {
    const match = shown(F.claudeEdit);
    const pane = new ScriptedPane(F.claudeEdit);
    const stale = { ...match.options[1]!, keys: ["x"] };
    expect(await answerPrompt(pane.io, stale, match)).toEqual({ type: "sent" });
    expect(pane.sent).toEqual([["2"]]);
  });

  it("a refusal before any key is refused; anything else is unconfirmed", async () => {
    const match = shown(F.claudeEdit);
    const pane = new ScriptedPane(F.claudeEdit);
    pane.sendError = Object.assign(new Error("Herdr refused"), { code: "agent_blocked", serverMessage: "the agent is blocked" });
    expect(await answerPrompt(pane.io, match.options[0]!, match)).toEqual({ type: "refused", reason: "the agent is blocked" });
    pane.sendError = new Error("socket closed");
    expect(await answerPrompt(pane.io, match.options[0]!, match)).toEqual({ type: "unconfirmed", reason: "socket closed" });
    expect(outcomeOf({ code: "pane_not_found" })).toEqual({ type: "unconfirmed", reason: "[object Object]" });
  });

  it("every recorded prompt still matches and sends its keys", async () => {
    const recorded = [
      F.claudeEdit,
      F.claudeBash,
      F.codexCommand,
      F.grokMenu,
      F.codexYesNo,
      F.defaultYes,
      F.bracketAlone,
      Launch.pairingPrompt,
      Launch.pairingChangedPrompt,
      Launch.paywallPrompt,
      Launch.paywallCommandPrompt,
      Launch.stringsPrompt,
      Launch.relayPrompt,
      Launch.reviewerPrompt,
      L.claude2_1_303Bash,
      L.claude2_1_303Write,
      L.claude2_1_303NamedBash,
      L.claude2_1_303Narrow39Bash,
      L.claude2_1_303Narrow54Bash,
      L.codex0_163_0Dialog,
      L.codex0_163_0Narrow51Dialog,
    ];
    for (const text of recorded) {
      const match = matchForAgent(shown(text), "claude");
      for (const option of match.options) {
        const pane = new ScriptedPane(text);
        expect(await answerPrompt(pane.io, option, match), text.slice(0, 60)).toEqual({ type: "sent" });
        expect(pane.sent).toEqual([option.keys]);
      }
    }
  });
});
