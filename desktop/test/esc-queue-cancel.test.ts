// A message Esc cancelled before any
// answer comes back to Chat's box, as the terminal puts it back in Claude's:
// its bubble leaves the timeline, its text goes first in our box (then a
// newline and what the user had typed, the cursor at the end), and Claude's box is
// emptied (Ctrl+U, Backspace, per row; a fresh read proves it, once more if
// not, else the note). The transcript's orphan rule keeps such a message out
// of the timeline later. Detection: the screen after our Esc (main).

import { describe, expect, it } from "vitest";

import { afterStop, beforeSend, clearClaudeBox, type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { sendBound } from "../src/main/herdr/send";
import { PendingMessages, withoutTakenBack } from "../src/shared/chat/pending";
import { claudeBoxTexts, readClaudeScreenFacts } from "../src/shared/claude-screen";
import { takeBackAfterStop } from "../src/renderer/chat/esc-back";
import { shown, timelineOf } from "./support/chat-lines";
import { claudeScreen } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";
import { beforeGlued, escMs, escTimes, firstPending, gluedLines, gluedText } from "./support/esc-queue-lines";

/** A pane whose screens come one per read (the last repeats); keys are logged. */
function boxSite(screens: readonly string[], log: unknown[][] = []): ClaudeBoxSite & { log: unknown[][] } {
  let read = 0;
  return {
    log,
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
}

function drafts(initial = "") {
  const texts = new Map<string, string>();
  const landings: [string, number][] = [];
  return {
    landings,
    get: (key: string) => ({ text: texts.get(key) ?? initial }),
    edit: (key: string, text: string) => void texts.set(key, text),
  };
}

const key = "host/w1:p1";

describe("Claude's box after our Esc (main)", () => {
  it("reads Claude Code's box draft off the screen", () => {
    expect(readClaudeScreenFacts(claudeScreen({ draft: firstPending })).draft).toBe(firstPending);
    expect(readClaudeScreenFacts(claudeScreen()).draft).toBe("");
  });

  it("finds Chat's last send put back in the box, and empties it with Ctrl+U and Backspace, proved by a fresh read", async () => {
    const site = boxSite([claudeScreen({ draft: firstPending }), claudeScreen()]);
    expect(await afterStop(site, firstPending)).toEqual({ cancelled: firstPending, cleared: true });
    expect(site.log).toEqual([["read"], ["keys", ["ctrl+u", "Backspace"]], ["read"]]);
  });

  it("empties a box of two rows with two of each", async () => {
    const site = boxSite([claudeScreen({ draft: "first line\nsecond line" }), claudeScreen()]);
    expect(await afterStop(site, "first line\nsecond line")).toEqual({ cancelled: "first line\nsecond line", cleared: true });
    expect(site.log).toContainEqual(["keys", ["ctrl+u", "Backspace", "ctrl+u", "Backspace"]]);
  });

  it("tries once more, then leaves the box and says so", async () => {
    const stuck = claudeScreen({ draft: firstPending });
    const site = boxSite([stuck, stuck, stuck]);
    expect(await afterStop(site, firstPending)).toEqual({ cancelled: firstPending, cleared: false });
    expect(site.log.filter((entry) => entry[0] === "keys").length).toBe(2);
    expect(await clearClaudeBox(boxSite([stuck]), firstPending)).toBe(false);
  });

  it("does nothing when the box stays empty (an answer had begun) or holds other text", async () => {
    const empty = boxSite([claudeScreen()]);
    expect(await afterStop(empty, firstPending)).toEqual({ cancelled: null, cleared: false });
    expect(empty.log.every((entry) => entry[0] === "read")).toBe(true);
    const other = boxSite([claudeScreen({ draft: "typed in the terminal" })]);
    expect(await afterStop(other, firstPending)).toEqual({ cancelled: null, cleared: false });
    expect(other.log.every((entry) => entry[0] === "read")).toBe(true);
    expect(await afterStop(boxSite([claudeScreen({ draft: firstPending })]), null)).toEqual({ cancelled: null, cleared: false });
  });
});

describe("the message back in Chat's box (page)", () => {
  it("removes its bubble and puts its text in the empty box, the cursor at the end", () => {
    const pending = new PendingMessages();
    pending.add(key, firstPending, escMs(escTimes.u1) - 200);
    const box = drafts();
    const notes: string[] = [];
    const took = takeBackAfterStop(
      { drafts: box, pending, landing: (k, at) => box.landings.push([k, at]), note: (_k, text) => notes.push(text) },
      key,
      { cancelled: firstPending, cleared: true },
    );
    expect(took).toBe(true);
    expect(pending.forPane(key)).toEqual([]);
    expect(box.get(key).text).toBe(firstPending);
    expect(box.landings).toEqual([[key, firstPending.length]]);
    expect(notes).toEqual([]);
  });

  it("puts it first, then a newline, then what the user had typed; the note when Claude's box would not empty", () => {
    const pending = new PendingMessages();
    const box = drafts("and also this");
    const notes: string[] = [];
    takeBackAfterStop({ drafts: box, pending, landing: (k, at) => box.landings.push([k, at]), note: (_k, text) => notes.push(text) }, key, {
      cancelled: firstPending,
      cleared: false,
    });
    expect(box.get(key).text).toBe(`${firstPending}\nand also this`);
    expect(box.landings).toEqual([[key, `${firstPending}\nand also this`.length]]);
    expect(notes).toEqual([claudeBoxTexts.stillHasText]);
    expect(claudeBoxTexts.stillHasText).toBe("Claude Code's box still has text. Open Terminal to clear it.");
  });

  it("hides the message its bubble had already settled into", () => {
    const pending = new PendingMessages();
    pending.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    pending.add(key, firstPending, escMs(escTimes.u1) - 200);
    const withU1 = timelineOf(beforeGlued).timeline;
    pending.observe(key, withU1);
    expect(pending.forPane(key)).toEqual([]);
    expect(pending.takeBack(key, firstPending)).toBe(true);
    expect(shown(withoutTakenBack(withU1, pending.takenBackFor(key)))).toEqual(["user:testing", "agent:Got it. ...", "notice:Interrupted"]);
  });
});

describe("the transcript's orphan rule", () => {
  it("keeps U1 (a typed line with no answer whose next user line has the same parent) out of the timeline", () => {
    expect(shown(timelineOf(gluedLines).timeline)).toEqual(["user:testing", "agent:Got it. ...", "notice:Interrupted", `user:${gluedText}`]);
  });

  it("shows U1 until the next user line says it was dropped", () => {
    expect(shown(timelineOf(beforeGlued).timeline)).toContain(`user:${firstPending}`);
  });
});

describe("the whole flow", () => {
  it("send, Esc before any answer, the text back in our box, Claude's box emptied, the next send arrives alone", async () => {
    const pending = new PendingMessages();
    pending.observe(key, timelineOf(beforeGlued.slice(0, 3)).timeline);
    // 1. send the first message (firstPending)
    const sentAt = escMs(escTimes.u1) - 200;
    const id = pending.add(key, firstPending, sentAt);
    pending.delivered(id);
    // 2. Esc lands before any answer: Claude's box shows firstPending.
    const after = boxSite([claudeScreen({ draft: firstPending }), claudeScreen()]);
    const found = await afterStop(after, firstPending);
    expect(after.log).toEqual([["read"], ["keys", ["ctrl+u", "Backspace"]], ["read"]]);
    // 3. the text is back in our box, the bubble is gone.
    const box = drafts();
    takeBackAfterStop({ drafts: box, pending, landing: () => undefined, note: () => undefined }, key, found);
    expect(box.get(key).text).toBe(firstPending);
    expect(pending.forPane(key)).toEqual([]);
    // 4. a fresh read shows Claude's box empty.
    expect(readClaudeScreenFacts(await after.read()).draft).toBe("");
    // 5. the next send arrives alone.
    box.edit(key, `${firstPending}\ni have to press 3-4 times on chat pane`);
    const prompts: string[] = [];
    const keys: unknown[] = [];
    const site = {
      writer: {
        prompt: async (_pane: string, text: string) => void prompts.push(text),
        sendInput: async () => undefined,
        sendText: async () => undefined,
        agentKeys: async (_pane: string, k: readonly string[]) => {
          checkHerdrKeys(k);
          keys.push(k);
        },
      },
      fresh: async () => true,
      pane: () => ({ paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 }) as never,
      agent: () => ({ paneID: "w1:p1", agent: "claude", terminalID: "t1" }) as never,
      box: { site: boxSite([claudeScreen()]), own: () => [], sent: () => undefined },
    };
    await sendBound(site, "w1:p1", box.get(key).text, { terminalID: "t1", isAgent: true, kind: "claude", session: null });
    expect(prompts).toEqual([`${firstPending}\ni have to press 3-4 times on chat pane`]);
    expect(keys).toEqual([]);
    expect(await beforeSend(boxSite([claudeScreen()]), [firstPending])).toEqual({ type: "go", cleared: null });
  });
});
