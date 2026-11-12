// Codex's reply read off its screen (ChatLiveScreen.block
// on a Codex screen: the "• " block directly above the "› " box) and the live
// row it makes until the transcript's text lands (ChatLiveMerge), with the
// same fixtures and results as Tests/HerdrKitTests/ChatLiveCodexTests.swift.

import { describe, expect, it } from "vitest";

import { ChatLiveMerge, ChatLiveScreen, liveBlock, type ChatLiveBlock } from "../src/shared/chat/live-screen";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline } from "../src/shared/chat/model";
import { codexScreens } from "./support/live-codex-fixtures";

const screenOf = (name: string): string => {
  const found = codexScreens.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no fixture ${name}`);
  return found.screen;
};
const read = (name: string): ChatLiveBlock | null => ChatLiveScreen.block(screenOf(name));

const user = (id: string, text: string): ChatItem => ({ type: "user", value: userMessage(id, text, null) });
const agentText = (id: string, markdown: string): ChatItem => ({ type: "agentText", value: { id, markdown, time: null } });

/** The user's message, then Codex's texts. */
function turn(texts: [string, string][], finished = false): ChatTimeline {
  return { ...emptyTimeline, turns: [makeTurn("t", { items: [user("u", "Run the checks again"), ...texts.map(([id, text]) => agentText(id, text))], isFinished: finished })] };
}

/** The rows Chat shows: the transcript's texts, then the live row's ("live: "). */
function shown(merge: ChatLiveMerge, timeline: ChatTimeline): string[] {
  const texts = timeline.turns.flatMap((each) => each.items).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));
  const row = merge.row(timeline);
  return row === null ? texts : [...texts, `live: ${row}`];
}

const reportPath = "/Users/demo/projects/sample-app/output/widget-sync-chat-typecheck.txt";
/** The typecheck reply as the transcript has it once it lands: its link written as Markdown. */
const linkedReply = `Typecheck complete: FAILURES in modules 4 and 7; [full output](${reportPath}) written, status updated, worktree unchanged.`;

describe("Codex's screen", () => {
  it.each(codexScreens.map((each) => [each.name, each.what, each] as const))("%s (%s)", (_name, _what, fixture) => {
    const block = ChatLiveScreen.block(fixture.screen);
    expect(block?.text ?? null).toBe(fixture.text);
    if (block !== null) {
      expect(block.finished, "a Codex block shows only while it is written").toBe(false);
      expect(block.drawing, "read as Codex draws it").toBe("codex");
    }
  });

  it("the growing reply's frames each hold the one before", () => {
    const frames = ["reply opening", "reply growing", "link while growing", "wrapped reply"].map((name) => read(name)?.text ?? "");
    for (let index = 1; index < frames.length; index += 1) {
      expect(ChatLiveMerge.key(frames[index]!).startsWith(ChatLiveMerge.key(frames[index - 1]!)), frames[index]).toBe(true);
    }
  });

  it("a Claude Code screen never reads as Codex's, nor Codex's as Claude's", () => {
    const rule = "\u{2500}".repeat(64);
    // Codex's shape under Claude Code's box: Claude's reading only (no spinner: nothing).
    const claude = ["\u{2022} The reader keeps its place", "", "", "\u{203A} Ask Codex to do anything", "", rule, "\u{276F}", rule].join("\n");
    expect(ChatLiveScreen.block(claude)).toBeNull();
    const writing = ["\u{276F} go on", "", "\u{23FA} The feed reads on", "", "\u{2722} Working\u{2026} (12s)", "", rule, "\u{276F}", rule].join("\n");
    expect(ChatLiveScreen.block(writing)).toEqual(liveBlock("The feed reads on"));
    expect(ChatLiveScreen.block(writing)?.drawing).toBeUndefined();
  });
});

describe("Codex's live row", () => {
  it("grows with the screen, then the landed text takes its place: one row, the Markdown link's", () => {
    const empty = turn([]);
    const merge = new ChatLiveMerge();
    for (const name of ["reply opening", "reply growing", "link while growing"]) {
      merge.update(read(name), empty);
      expect(merge.row(empty)).toBe(codexScreens.find((each) => each.name === name)!.text);
    }
    merge.update(read("wrapped reply"), empty);
    expect(merge.row(empty)).toContain(`full output (${reportPath})`);
    const landed = turn([["own", linkedReply]]);
    expect(merge.row(landed), "the link drawn as Codex draws it is the landed text").toBeNull();
    expect(shown(merge, landed)).toEqual([linkedReply]);
    // Landed while the incomplete link was on show ("[full output]"): it takes the row's place too.
    const early = new ChatLiveMerge();
    early.update(read("link while growing"), empty);
    expect(shown(early, landed)).toEqual([linkedReply]);
  });

  it("committed (Worked for, or Working again): the row goes; the landed text is the one row", () => {
    const empty = turn([]);
    const merge = new ChatLiveMerge();
    merge.update(read("short reply"), empty);
    merge.update(read("short reply growing"), empty);
    expect(merge.row(empty)).toBe("FAILING: packages 5, 7, 8, 12, and 13 stop the merge; complete output written,");
    merge.update(read("committed after a short reply"), empty);
    expect(merge.row(empty)).toBeNull();
    const landed = turn([["own", "FAILING: packages 5, 7, 8, 12, and 13 stop the merge; complete output written, status updated."]]);
    expect(shown(merge, landed)).toEqual(["FAILING: packages 5, 7, 8, 12, and 13 stop the merge; complete output written, status updated."]);
    const interim = new ChatLiveMerge();
    interim.update(read("interim reply growing"), empty);
    interim.update(read("working after a reply"), empty);
    expect(interim.row(empty)).toBeNull();
  });

  it.each([0, 1, 2])("a reply already landed starts no row (opening %i): the wrapped reply, its paragraphs and list, its numbered list", (opening) => {
    const cases: [string, string][] = [
      ["wrapped reply", linkedReply],
      ["paragraphs and a list", "Both fixes are in:\n\n- The reader keeps its place\n- The row ends when the text lands\n\nTests: **24 of 24** pass."],
      ["numbered list", "Next:\n\n1. Build the desktop\n1. Run the tests"],
      ["narrow pane", "The triage is complete. Three Esc issues block approval: the arm survives a command-connection replacement or a failed send, and its 30-second eligibility check can be stale. The duration loss also occurs on the base revision. Both mutations are restored, the worktree is clean, and all 197 selected Swift tests passed. I’m writing the digest and closing the ticket."],
    ];
    for (const [name, markdown] of cases) {
      const landed = turn([["landed", markdown]]);
      const merge = new ChatLiveMerge();
      // Opening 0: once; 1: the screen read twice; 2: after an earlier block on screen.
      if (opening === 2) merge.update(liveBlock("Checking the rows", false, "codex"), turn([]));
      merge.update(read(name), landed);
      if (opening === 1) merge.update(read(name), landed);
      expect(shown(merge, landed), `${name}, opening ${opening + 1}`).toEqual([markdown]);
    }
  });

  it("its own text lands: the row goes, with the inline code, list and emphasis as Markdown writes them", () => {
    const empty = turn([]);
    const merge = new ChatLiveMerge();
    merge.update(read("inline code opening"), empty);
    expect(merge.row(empty)).toBe("The worktree is clean at `");
    const landed = turn([["own", "The worktree is clean at `9c5a104`. I’m checking each fix at the boundaries named."]]);
    expect(shown(merge, landed)).toEqual(["The worktree is clean at `9c5a104`. I’m checking each fix at the boundaries named."]);
    const list = new ChatLiveMerge();
    list.update(read("paragraphs and a list"), empty);
    const own = "Both fixes are in:\n\n- The reader keeps its place\n- The row ends when the text lands\n\nTests: **24 of 24** pass.";
    expect(shown(list, turn([["own", own]]))).toEqual([own]);
  });

  it("another text never takes its place: the row stays until its own lands", () => {
    const merge = new ChatLiveMerge();
    const before = turn([["old", "Typecheck started."]]);
    merge.update(read("wrapped reply"), before);
    const other = turn([["old", "Typecheck started."], ["other", "Typecheck complete: PASSED."]]);
    expect(merge.row(other)).toBe(read("wrapped reply")!.text);
    // A link to another file is not this reply's.
    const elsewhere = turn([["old", "Typecheck started."], ["other", linkedReply.replace(reportPath, "/Users/demo/projects/sample-app/output/widget-sync-chat-lint.txt")]]);
    expect(merge.row(elsewhere)).toBe(read("wrapped reply")!.text);
  });

  it("Claude's row is unchanged: a link's target drawn on its screen is not how Claude Code draws a link", () => {
    const merge = new ChatLiveMerge();
    const shownText = `full report (${reportPath}) written`;
    const own = turn([["own", `[full report](${reportPath}) written`]]);
    merge.update(liveBlock(shownText), turn([]));
    expect(merge.row(own)).toBe(shownText);
    const codex = new ChatLiveMerge();
    codex.update(liveBlock(shownText, false, "codex"), turn([]));
    expect(codex.row(own)).toBeNull();
  });
});

// Codex also breaks a line after a slash inside a path (".../sampled1/" then
// "sample-widget-rows-...);"), its line shorter than the status line below the
// box. The screen cannot tell that from a word ending in a slash and a space, so the block ends at
// that line: a prefix of the reply, never a space inside the path. Claude's joining is unchanged.
describe("a Codex token wrapped at a slash", () => {
  const wrappedPath = "/Users/demo/projects/sampled1/sample-widget-rows-ui-final-output.txt";
  const wrappedReply = `FAILING: three blocking packages and one nonblocking note in the complete output (${wrappedPath}); status set to exited 0, worktree clean.`;

  it("the recorded frame keeps the path's characters: no space after its slash, a prefix of the reply", () => {
    const block = read("path wrapped at a slash")!;
    expect(block.text).not.toMatch(/\/ /);
    expect(wrappedReply.startsWith(block.text)).toBe(true);
    expect(block.text.endsWith("/Users/demo/projects/sampled1/")).toBe(true);
  });

  it("as the next line grows the row stays that prefix, and the landed reply takes its place: one row", () => {
    const merge = new ChatLiveMerge();
    const lines = screenOf("path wrapped at a slash").split("\n");
    const second = lines.findIndex((line) => line.startsWith("  sample-widget-rows"));
    for (const cut of [24, 40, 60]) {
      const screen = [...lines.slice(0, second), lines[second]!.slice(0, cut), ...lines.slice(second + 1)].join("\n");
      merge.update(ChatLiveScreen.block(screen), turn([]));
      expect(merge.row(turn([]))).toBe(read("path wrapped at a slash")!.text);
    }
    expect(shown(merge, turn([["landed", wrappedReply]]))).toEqual([wrappedReply]);
  });

  // The slash ambiguity on a line as wide as the pane is checked
  // before the full-width join, which would take the real space out ("…/ne/ComponentRegistrationView.swift").
  it.each([
    ["full-width directory then a word", "/Users/demo/projects/"],
    ["full-width URL then a word", "https://example.test/"],
  ])("%s: an exact prefix of the landed reply, then the reply itself is the one row", (name, root) => {
    const landed = `Under ${root}${"nested-".repeat(12)}ne/ ComponentRegistrationView.swift is next.`;
    const block = read(name)!;
    expect(block.text).toBe(`Under ${root}${"nested-".repeat(12)}ne/`);
    expect(landed.startsWith(block.text)).toBe(true);
    const merge = new ChatLiveMerge();
    merge.update(block, turn([]));
    expect(merge.row(turn([]))).toBe(block.text);
    expect(shown(merge, turn([["landed", landed]]))).toEqual([landed]);
  });

  it("Claude's screen still joins a line ending in a slash with a space", () => {
    const rule = "\u{2500}".repeat(64);
    const screen = ["\u{276F} go on", "", "\u{23FA} The files are under /Users/demo/projects/sample-app/web/src/", "  components-and-views.ts are next.", "", "\u{2722} Working\u{2026} (12s)", "", rule, "\u{276F}", rule].join("\n");
    expect(ChatLiveScreen.block(screen)?.text).toBe("The files are under /Users/demo/projects/sample-app/web/src/ components-and-views.ts are next.");
  });
});
