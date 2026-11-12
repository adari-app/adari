// Claude Code 2.1.319, while it works with
// a message queued, draws its hint inside the box ("❯ Press up to edit queued
// messages", read live on a named Claude Code pane).
// That row is no text typed in the box: the box reads empty and queued, a
// second send goes, and an Esc finds no cancelled message in it. Real text in
// the box still reads as itself, and Claude's dimmed `Try "…"` suggestion
// stays empty.

import { describe, expect, it } from "vitest";

import { afterStop, type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { sendBound, type SendSite } from "../src/main/herdr/send";
import { sendDraft, ComposerDrafts } from "../src/renderer/components/composer-drafts";
import { readClaudeScreenFacts } from "../src/shared/claude-screen";
import { claudeScreen, workingLine } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";

/** A named Claude pane's screen, its rows as read (the reply and the working line above the box). */
const hintScreen = [
  "\u{23FA} Got it. ...",
  "",
  workingLine,
  "",
  "\u{2500}".repeat(40) + " aurora-web-esc-queue-session \u{2500}",
  "\u{276F} Press up to edit queued messages",
  "\u{2500}".repeat(60),
  "  Opus 5.5 | 21% ctx | \u{2026} | v2.1.319",
  "  \u{23F5}\u{23F5} auto mode on (shift+tab to cycle)",
].join("\n");

const claudeBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: null };

function machine(screens: readonly string[], own: readonly string[] = []) {
  const log: unknown[][] = [];
  let read = 0;
  const box: ClaudeBoxSite = {
    read: async () => {
      log.push(["read"]);
      const screen = screens[Math.min(read, screens.length - 1)]!;
      read += 1;
      return screen;
    },
    keys: async (keys) => {
      checkHerdrKeys(keys);
      log.push(["keys", [...keys]]);
    },
    wait: async () => undefined,
  };
  const site: SendSite = {
    writer: {
      prompt: async (_pane, text) => void log.push(["prompt", text]),
      sendInput: async () => undefined,
      sendText: async () => undefined,
      agentKeys: async (_pane, keys) => {
        checkHerdrKeys(keys);
        log.push(["agentKeys", [...keys]]);
      },
    },
    fresh: async () => true,
    pane: () => ({ paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "working", revision: 1 }) as never,
    agent: () => ({ paneID: "w1:p1", agent: "claude", terminalID: "t1" }) as never,
    box: { site: box, own: () => own, sent: () => undefined },
  };
  return { log, site, box };
}

describe("Claude's queued-messages hint is not text in the box", () => {
  it("reads the named pane's screen as an empty box, working, with messages queued", () => {
    expect(readClaudeScreenFacts(hintScreen)).toEqual({ draft: "", working: true, queued: true });
  });

  it("reads the hint row drawn with a no-break space the same way", () => {
    const screen = hintScreen.replace("\u{276F} Press", "\u{276F}\u{00A0}Press");
    expect(readClaudeScreenFacts(screen)).toEqual({ draft: "", working: true, queued: true });
  });

  it("beforeSend on it sends the second message, and no Not sent note shows", async () => {
    const m = machine([hintScreen], ["esc doesn't work"]);
    const drafts = new ComposerDrafts();
    drafts.edit("host/w1:p1", "i have to press 3-4 times on chat pane");
    sendDraft(drafts, (_h, p, t) => sendBound(m.site, p, t, claudeBinding), "host", "w1:p1", null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.log).toEqual([["read"], ["prompt", "i have to press 3-4 times on chat pane"]]);
    expect(drafts.get("host/w1:p1").error).toBeNull();
    expect(drafts.get("host/w1:p1").text).toBe("");
  });

  it("afterStop on it finds no cancelled message and presses nothing", async () => {
    const m = machine([hintScreen]);
    expect(await afterStop(m.box, "esc doesn't work")).toEqual({ cancelled: null, cleared: false });
    expect(m.log.every((entry) => entry[0] === "read")).toBe(true);
  });

  it("a box holding real text, the hint elsewhere on screen, still reads that text", () => {
    expect(readClaudeScreenFacts(claudeScreen({ draft: "hello", working: true, queued: ["esc doesn't work"] }))).toEqual({
      draft: "hello",
      working: true,
      queued: true,
    });
    const typed = hintScreen.replace("\u{276F} Press up to edit queued messages", "\u{276F} hello");
    expect(readClaudeScreenFacts(`${workingLine}\n    Press up to edit queued messages\n${typed}`).draft).toBe("hello");
  });

  it("only the hint alone is empty: more text in the box reads as typed", () => {
    const more = hintScreen.replace("\u{276F} Press up to edit queued messages", "\u{276F} Press up to edit queued messages\n  and more");
    expect(readClaudeScreenFacts(more).draft).toBe("Press up to edit queued messages\nand more");
  });

  it("Claude's dimmed Try suggestion stays an empty box", () => {
    const suggestion = hintScreen.replace("\u{276F} Press up to edit queued messages", '\u{276F}\u{00A0}Try "how does claude-box.ts work?"');
    expect(readClaudeScreenFacts(suggestion)).toEqual({ draft: "", working: true, queued: false });
  });
});
