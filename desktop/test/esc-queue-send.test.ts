// Esc and the queued send: a Chat send never joins our own message left in
// Claude Code's box. Before every send to a
// Claude pane, one fresh read of its box: our own sent message there is cleared
// (proved empty) and the send goes. Any other text in the box (Claude Code
// 2.1.319's dimmed suggested prompt at idle, or the user's own typing in the
// terminal) does not refuse the send: it goes with no key and no note, and
// that text is never cleared. An empty box sends as usual.

import { describe, expect, it } from "vitest";

import { type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { sendBound, type SendSite } from "../src/main/herdr/send";
import { sendDraft, ComposerDrafts } from "../src/renderer/components/composer-drafts";
import { claudeBoxTexts } from "../src/shared/claude-screen";
import { claudeScreen } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";

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
  const sent: string[] = [];
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
    box: { site: box, own: () => own, sent: (text) => void sent.push(text) },
  };
  return { log, site, sent };
}

describe("a send reads Claude's box first", () => {
  it("sends into an empty box (one read, then the prompt), and records what went", async () => {
    const m = machine([claudeScreen({ working: true })]);
    await sendBound(m.site, "w1:p1", "go on", claudeBinding);
    expect(m.log).toEqual([["read"], ["prompt", "go on"]]);
    expect(m.sent).toEqual(["go on"]);
  });

  it("clears our own sent message from the box, proves it empty, then sends", async () => {
    const m = machine([claudeScreen({ draft: "esc doesn't work" }), claudeScreen()], ["esc doesn't work"]);
    await sendBound(m.site, "w1:p1", "esc doesn't work\ni have to press 3-4 times", claudeBinding);
    expect(m.log).toEqual([["read"], ["keys", ["ctrl+u", "Backspace"]], ["read"], ["prompt", "esc doesn't work\ni have to press 3-4 times"]]);
  });

  it("does not send when our own message would not clear", async () => {
    const stuck = claudeScreen({ draft: "esc doesn't work" });
    const m = machine([stuck], ["esc doesn't work"]);
    await expect(sendBound(m.site, "w1:p1", "next", claudeBinding)).rejects.toThrow(claudeBoxTexts.notSentStillHasText);
    expect(m.log.some((entry) => entry[0] === "prompt")).toBe(false);
  });

  it("an idle box holding text that is not ours (a suggested prompt): one prompt, no keys, no note", async () => {
    const m = machine([claudeScreen({ draft: "run the tests again" })], ["esc doesn't work"]);
    await sendBound(m.site, "w1:p1", "test", claudeBinding);
    expect(m.log).toEqual([["read"], ["prompt", "test"]]);
    expect(m.sent).toEqual(["test"]);
  });

  it("text not ours in the box: the draft leaves our composer with no note, and the box is never cleared", async () => {
    const m = machine([claudeScreen({ draft: "half a command typed in the terminal" })], ["esc doesn't work"]);
    const drafts = new ComposerDrafts();
    drafts.edit("host/w1:p1", "please check the iPad");
    sendDraft(drafts, (_h, p, t) => sendBound(m.site, p, t, claudeBinding), "host", "w1:p1", null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.log).toEqual([["read"], ["prompt", "please check the iPad"]]);
    expect(m.log.some((entry) => entry[0] === "keys" || entry[0] === "agentKeys")).toBe(false);
    expect(drafts.get("host/w1:p1").text).toBe("");
    expect(drafts.get("host/w1:p1").error ?? null).toBeNull();
  });

  it("the refusal note for text not ours is gone", () => {
    expect(Object.keys(claudeBoxTexts)).not.toContain("foreign");
    expect(Object.values(claudeBoxTexts)).not.toContain("Not sent: Claude Code's box already has text. Open Terminal to send or clear it.");
  });

  it("reads no box for another agent", async () => {
    const m = machine([claudeScreen({ draft: "x" })]);
    m.site.pane = () => ({ paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "codex", agentStatus: "idle", revision: 1 }) as never;
    m.site.agent = () => ({ paneID: "w1:p1", agent: "codex", terminalID: "t1" }) as never;
    await sendBound(m.site, "w1:p1", "go", { ...claudeBinding, kind: "codex" });
    expect(m.log).toEqual([["prompt", "go"]]);
  });
});
