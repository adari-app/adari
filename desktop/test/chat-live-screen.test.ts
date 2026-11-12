// The text Claude Code is writing, read off its screen
// (ChatLiveScreen.block), and the live row it makes until the transcript's
// block lands (ChatLiveMerge). The cases and fixtures match the iPhone app's
// Tests/HerdrKitTests/ChatLiveScreenTests.swift.

import { describe, expect, it } from "vitest";

import { ChatLiveMatch, ChatLiveMerge, ChatLiveScreen, liveBlock, type ChatLiveBlock, type LiveReading } from "../src/shared/chat/live-screen";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline, type ChatTurn } from "../src/shared/chat/model";
import { workerRecent, workingRecent, workingVisible } from "./support/live-fixtures";

const rule = (width: number): string => "\u{2500}".repeat(width);
const count = (text: string): number => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;

/** A working Claude Code screen with `turn` above its spinner and box, `width` columns wide (the fixtures' shape). */
function screen(turn: string[], width = 64, spinner = "\u{2722} Gallivanting\u{2026} (12s \u{00B7} \u{2193} 1.2k tokens)"): string {
  return [
    "",
    ...turn,
    "",
    spinner,
    "  \u{23BF} \u{00A0}Tip: Use /btw to ask a quick side question",
    "",
    rule(width),
    "\u{276F}",
    rule(width),
    "  Opus 5.5 | 12% ctx | tidepool-mobile",
    "  \u{23F5}\u{23F5} auto mode on",
  ].join("\n");
}

const timelineOf = (turns: ChatTurn[]): ChatTimeline => ({ ...emptyTimeline, turns });
const user = (id: string, text: string): ChatItem => ({ type: "user", value: userMessage(id, text, null) });
const agentText = (id: string, markdown: string): ChatItem => ({ type: "agentText", value: { id, markdown, time: null } });
const progress = (id: string, markdown: string): ChatItem => ({ type: "progress", value: { id, markdown, time: null } });

/** One turn: the user's "go on", then the agent's texts a1, a2… */
function timeline(texts: string[], finished = false): ChatTimeline {
  return timelineOf([makeTurn("t1", { items: [user("u1", "go on"), ...texts.map((text, index) => agentText(`a${index + 1}`, text))], isFinished: finished })]);
}

/** A turn: the user's message, then the agent's texts. */
function turn(texts: [string, string][], finished = false): ChatTimeline {
  return timelineOf([makeTurn("t", { items: [user("u", "Please check the next file too"), ...texts.map(([id, text]) => agentText(id, text))], isFinished: finished })]);
}

/** The timeline with `turns` put in front. */
const withTurnsBefore = (base: ChatTimeline, ...turns: ChatTurn[]): ChatTimeline => ({ ...base, turns: [...turns, ...base.turns] });
const earlierTurn = (): ChatTurn => makeTurn("t0", { items: [agentText("a0", "Earlier.")], isFinished: true });

/** The rows Chat shows for `timeline` with the row: the transcript's texts, then the live row's ("live: ") when there is one. */
function shown(merge: ChatLiveMerge, timeline: ChatTimeline): string[] {
  const texts = timeline.turns.flatMap((each) => each.items).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));
  const row = merge.row(timeline);
  return row === null ? texts : [...texts, `live: ${row}`];
}

/** Its own text lands: one row, the transcript's, and no live row. */
function expectSwapsOnce(merge: ChatLiveMerge, landed: ChatTimeline, own: string): void {
  expect(merge.row(landed)).toBeNull();
  const rows = shown(merge, landed);
  expect(rows.filter((row) => row === own).length, JSON.stringify(rows)).toBe(1);
  expect(rows.some((row) => row.startsWith("live: ")), JSON.stringify(rows)).toBe(false);
  expect(rows.at(-1), "in the live row's place").toBe(own);
}

/** A merge with `steps` applied in order. */
function merged(...steps: [ChatLiveBlock | null, ChatTimeline, boolean?][]): ChatLiveMerge {
  const merge = new ChatLiveMerge();
  for (const [block, on, caughtUp] of steps) merge.update(block, on, caughtUp ?? true);
  return merge;
}

/** The block as Claude Code draws it under the user's message, read back off the screen. */
function captured(text: string, width = 64): ChatLiveBlock | null {
  const body = text
    .split("\n")
    .map((line, index) => (index === 0 ? "\u{23FA} " : "  ") + line)
    .join("\n");
  return ChatLiveScreen.block(["", "\u{276F} Show the corrected patch", "", body, "", "\u{2722} Gallivanting\u{2026} (12s)", "", rule(width), "\u{276F}", rule(width)].join("\n"));
}

describe("the screen", () => {
  it("a writing block is the text after the last agent bullet", () => {
    const text = screen(["\u{276F} why is Chat stuck on Queued?", "", "  Read 2 files", "", "\u{23FA} The screenshots confirm the gap: Terminal updates fine while", "  Chat stays stuck"]);
    expect(ChatLiveScreen.block(text)).toEqual(liveBlock("The screenshots confirm the gap: Terminal updates fine while Chat stays stuck"));
  });

  it("only the last block is taken", () => {
    const text = screen([
      "\u{276F} go on",
      "",
      "\u{23FA} Step 2 committed.",
      "",
      "  Ran 3 shell commands",
      "",
      "\u{23FA} Bash(swift test)",
      "  \u{23BF}  Test Suite 'All tests' passed",
      "",
      "\u{23FA} All green. Now step 3",
    ]);
    expect(ChatLiveScreen.block(text)).toEqual(liveBlock("All green. Now step 3"));
  });

  it("wrapped lines join as they were written", () => {
    const lines = [
      "\u{23FA} The feed reads on at once in windows",
      "  sized for it.",
      "",
      "  See /Users/demo/code/aurora-web/docs/n",
      "  otes-about-the-chat-stream.md first.",
      "",
      "  Two things:",
      "  - the feed reads on",
      "  - the scan skips images",
    ];
    expect(count(lines[0]!) + 1 + count("sized"), "a wrap: the next word did not fit in 40").toBe(44);
    expect(count(lines[3]!), "a word broken at the edge").toBe(40);
    const block = ChatLiveScreen.block(screen(lines, 40));
    expect(block?.text).toBe(
      [
        "The feed reads on at once in windows sized for it.",
        "",
        "See /Users/demo/code/aurora-web/docs/notes-about-the-chat-stream.md first.",
        "",
        "Two things:",
        "- the feed reads on",
        "- the scan skips images",
      ].join("\n"),
    );
    expect(block?.finished).toBe(false);
  });

  it("the fixtures join at their widths", () => {
    const wrapped = screen([
      "\u{276F} go on",
      "",
      "\u{23FA} Step 2 committed. Now step 3: checking that search, the away",
      "  digest and Send to\u{2026} drafts all read user text through the same",
      "  unwrap.",
    ]);
    expect(ChatLiveScreen.block(wrapped)?.text).toBe(
      "Step 2 committed. Now step 3: checking that search, the away digest and Send to\u{2026} drafts all read user text through the same unwrap.",
    );
    // The fixtures end in a tool row: the text above it, done on screen.
    expect(ChatLiveScreen.block(workerRecent)).toEqual(liveBlock("Writing the step 3 tests (search hit, away digest, Send to\u{2026} draft).", true));
    for (const fixture of [workingRecent, workingVisible]) {
      expect(ChatLiveScreen.block(fixture)).toEqual(
        liveBlock(
          "The screenshots confirm the gap: Terminal updates fine while Chat stays stuck on \"Queued.\" I'll check if an oversized new log line type is stalling the chat reader.",
          true,
        ),
      );
    }
  });

  it("tool rows are not text", () => {
    const screens = [
      // A call with its output.
      ["\u{276F} run the tests", "", "\u{23FA} Bash(swift test --filter ChatLive)", "  \u{23BF}  Running\u{2026}"],
      // Tool rows in progress, after collapsed ones.
      ["\u{276F} run the tests", "", "  Read 2 files", "", "\u{23FA} Running 1 shell command\u{2026}"],
      // An MCP call.
      ["\u{276F} build it", "", "\u{23FA} xcode - BuildProject (MCP)(scheme: \"HerdrCompanion\")"],
      ["\u{276F} build it", "", "\u{23FA} mcp__xcode__BuildProject (MCP)(scheme: \"HerdrCompanion\")"],
      // A described command, its output under it.
      ["\u{276F} capture it", "", "\u{23FA} Capturing Claude TUI screen text fixtures", "  \u{23BF}  $ mkdir -p fixtures"],
      // Collapsed rows only.
      ["\u{276F} look", "", "  Searched for 2 patterns, read 4 files (ctrl+o to expand)"],
    ];
    for (const lines of screens) expect(ChatLiveScreen.block(screen(lines)), lines.join(" / ")).toBeNull();
    expect(ChatLiveScreen.isSummary(["  Read 1 file, ran 1 shell command"])).toBe(true);
    expect(ChatLiveScreen.isSummary(["  Searched for 2 patterns, ran 4 shell commands"])).toBe(true);
    expect(ChatLiveScreen.isSummary(["  Two of 3 tests pass now"])).toBe(false);
    expect(ChatLiveScreen.isSummary(["  I read 2 files and it is the scan."])).toBe(false);
  });

  it("the status lines are not the block", () => {
    const text = screen(["\u{276F} go on", "", "\u{23FA} Writing the tests now"], 64, "\u{2736} Writing the step 3 tests\u{2026} (5m 36s \u{00B7} \u{2193} 20.9k tokens)").replaceAll(
      "  \u{23BF} \u{00A0}Tip:",
      "  \u{23BF}  \u{2610} Step 3 tests\n     \u{2610} Step 4 budgets\n  \u{23BF} \u{00A0}Tip:",
    );
    expect(ChatLiveScreen.block(text)?.text).toBe("Writing the tests now");
    expect(ChatLiveScreen.isSpinner("\u{00B7} Tomfoolering\u{2026}")).toBe(true);
    expect(ChatLiveScreen.isSpinner("\u{23FA} Running 1 shell command\u{2026}")).toBe(false);
    expect(ChatLiveScreen.isSpinner("\u{273B} Worked for 3m 2s")).toBe(false);
  });

  it("a screen that does not read shows nothing", () => {
    const turnOver = ["", "\u{276F} go on", "", "\u{23FA} Done: both items committed.", "", "\u{273B} Worked for 3m 2s", "", rule(64), "\u{276F}", rule(64)].join("\n");
    for (const text of [
      "",
      "\n\n\n",
      // Nothing but the spinner and the box.
      screen([]),
      // No box: a shell.
      "dev@mac ~ % swift test\nBuilding for debugging...",
      // The turn over: no spinner.
      turnOver,
      // The spinner, no box under it.
      "\u{23FA} The feed reads on\n\n\u{2722} Gallivanting\u{2026} (12s)",
      // The user's message last: nothing of the agent's yet.
      screen(["\u{276F} why is Chat stuck on Queued?"]),
      // The block's first line is off the top: only its tail on screen.
      screen(["  the tail of a block cut off above", "  and its last line"]),
      // Something else at the margin last (a line Claude Code prints of its own).
      screen(["\u{23FA} The feed reads on", "", "\u{203B} recap: the reader"]),
    ]) {
      expect(ChatLiveScreen.block(text), text.slice(0, 60)).toBeNull();
    }
  });
});

describe("the live row", () => {
  it("shows until the transcript's block lands", () => {
    const merge = new ChatLiveMerge();
    const before = timeline(["Step 2 committed."]);
    merge.update(liveBlock("The feed reads on"), before);
    expect(merge.row(before)).toBe("The feed reads on");
    merge.update(liveBlock("The feed reads on at once in windows sized for it."), before);
    expect(merge.row(before)).toBe("The feed reads on at once in windows sized for it.");
    // The agent goes on to a tool: the block stays until the transcript has it.
    merge.update(liveBlock("The feed reads on at once in windows sized for it.", true), before);
    expect(merge.row(before)).toBe("The feed reads on at once in windows sized for it.");
    const landed = timeline(["Step 2 committed.", "The feed reads **on at once** in windows sized for it."]);
    expect(merge.row(landed)).toBeNull();
    // The next block shows after it.
    merge.update(liveBlock("Now the scan"), landed);
    expect(merge.row(landed)).toBe("Now the scan");
  });

  it("the transcript's markdown is the same block", () => {
    const merge = new ChatLiveMerge();
    merge.update(liveBlock("See the reader (chat-feed) and its window:\n\nlet window = 4 MB"), timeline([]));
    const landed = timelineOf([
      makeTurn("t1", {
        items: [user("u1", "go on"), progress("p1", "See the [reader](https://example.com/feed) (`chat-feed`) and its _window_:\n\n```swift\nlet window = 4 MB\n```")],
      }),
    ]);
    expect(merge.row(landed)).toBeNull();
  });

  it("an older block catching up leaves the row until its own block lands", () => {
    const merge = new ChatLiveMerge();
    const stale = timelineOf([makeTurn("turn", { items: [user("u", "question")] })]);
    merge.update(liveBlock("Current answer is still streaming"), stale);
    expect(merge.row(stale)).toBe("Current answer is still streaming");
    const caughtUp = timelineOf([makeTurn("turn", { items: [user("u", "question"), agentText("old", "Earlier completed progress")] })]);
    expect(merge.row(caughtUp)).toBe("Current answer is still streaming");
    merge.update(liveBlock("Current answer is still streaming more words"), caughtUp);
    expect(merge.row(caughtUp)).toBe("Current answer is still streaming more words");
    // Older history in front changes nothing either.
    expect(merge.row(withTurnsBefore(caughtUp, earlierTurn()))).toBe("Current answer is still streaming more words");
    // Its own block lands: the row goes.
    const landed = timelineOf([
      makeTurn("turn", {
        items: [user("u", "question"), agentText("old", "Earlier completed progress"), agentText("own", "Current answer is **still streaming** more words, and done.")],
      }),
    ]);
    expect(merge.row(landed)).toBeNull();
  });

  it("a wrapped table is the same block as its markdown", () => {
    const merge = new ChatLiveMerge();
    const before = timeline(["Step 2 committed."]);
    const text = "\u{2502} it \u{2502} re \u{2502}\n\u{2502} em \u{2502} ads \u{2502}";
    merge.update(liveBlock(text), before);
    expect(merge.row(before)).not.toBeNull();
    const table = timeline(["Step 2 committed.", "| Item | Reads |\n|---|---|\n| 1 | 2 |"]);
    expect(merge.row(table), "its own text: one row, the transcript's").toBeNull();
    merge.update(liveBlock(text, true), before);
    expect(merge.row(before), "ended on screen, the transcript has nothing new yet").not.toBeNull();
    expect(merge.row(table)).toBeNull();
    // A text that was there when the row first showed never ends it.
    expect(merge.row(withTurnsBefore(before, earlierTurn()))).not.toBeNull();
  });
});

describe("the row's own block (five subcases)", () => {
  it("1. a reply with an older reply's opening stays until its own lands", () => {
    const opening = "I'll inspect the current implementation and update the tests to cover ";
    const old = turn([["old", `${opening}the sidebar.`]]);
    const merge = new ChatLiveMerge();
    const current = `${opening}the chat shelf, which still needs work.`;
    merge.update(liveBlock(current), old);
    expect(merge.row(old), "a different reply sharing the first 48 letters is not this block landing").toBe(current);
    const landed = turn([
      ["old", `${opening}the sidebar.`],
      ["own", `${opening}the **chat shelf**, which still needs work.`],
    ]);
    expect(merge.row(landed)).toBeNull();
    expect(shown(merge, landed)).toEqual([`${opening}the sidebar.`, `${opening}the **chat shelf**, which still needs work.`]);
  });

  it("2. a short opening is not an older reply that begins the same", () => {
    const old = turn([["old", "I'll check the sidebar first."]]);
    const merge = new ChatLiveMerge();
    merge.update(liveBlock("I'll check"), old);
    expect(merge.row(old), "a newly started short block must not match an older longer reply").toBe("I'll check");
    merge.update(liveBlock("I'll check the chat shelf next"), old);
    expect(merge.row(old)).toBe("I'll check the chat shelf next");
    const landed = turn([
      ["old", "I'll check the sidebar first."],
      ["own", "I'll check the chat shelf next."],
    ]);
    expect(shown(merge, landed)).toEqual(["I'll check the sidebar first.", "I'll check the chat shelf next."]);
  });

  it("3. an ended block outlasts an older catch-up until its own text lands", () => {
    const merge = new ChatLiveMerge();
    const current = "The current reply finished; the next tool is running.";
    merge.update(liveBlock(current), turn([]));
    const caught = turn([["old", "Earlier completed progress that arrived late."]]);
    merge.update(liveBlock(current, true), caught);
    expect(merge.row(caught), "ending on screen does not identify which transcript block arrived").toBe(current);
    const landed = turn([
      ["old", "Earlier completed progress that arrived late."],
      ["own", current],
    ]);
    expect(shown(merge, landed)).toEqual(["Earlier completed progress that arrived late.", current]);
  });

  it("4. a wrapped table retires when its own transcript lands", () => {
    const before = turn([["old", "Previous reply."]]);
    const merge = new ChatLiveMerge();
    merge.update(liveBlock("\u{2502} it \u{2502} re \u{2502}\n\u{2502} em \u{2502} ads \u{2502}"), before);
    expect(merge.row(before)).not.toBeNull();
    const landed = turn([
      ["old", "Previous reply."],
      ["own", "| Item | Reads |\n|---|---|\n| 1 | 2 |"],
    ]);
    expect(merge.row(landed), "once the transcript contains this table, a second live copy must retire even before another screen read").toBeNull();
    expect(shown(merge, landed).length).toBe(2);
  });

  it("5. a code-first reply retires when its transcript lands", () => {
    const merge = new ChatLiveMerge();
    const before = turn([]);
    merge.update(liveBlock("swift\nlet value = 42"), before);
    expect(merge.row(before)).toBe("swift\nlet value = 42");
    const landed = turn([["own", "```swift\nlet value = 42\n```"]]);
    expect(merge.row(landed), "the displayed code language must not prevent the swap").toBeNull();
    expect(shown(merge, landed)).toEqual(["```swift\nlet value = 42\n```"]);
  });

  it("a growing block follows the screen until its text lands", () => {
    const merge = new ChatLiveMerge();
    let on = turn([["old", "Reading the follower."]]);
    const reads = [
      "The follower reads on",
      "The follower reads on from its offset",
      "The follower reads on from its offset in 4 MB windows,\n\n1. one size",
      "The follower reads on from its offset in 4 MB windows,\n\n1. one size\n2. then the reads",
    ];
    reads.forEach((text, index) => {
      if (index === 2) {
        on = turn([
          ["old", "Reading the follower."],
          ["late", "Reading the feed."],
        ]);
      }
      merge.update(liveBlock(text), on);
      expect(merge.row(on), `read ${index}`).toBe(text);
    });
    const landed = turn([
      ["old", "Reading the follower."],
      ["late", "Reading the feed."],
      ["own", "The follower reads on from its offset in **4 MB** windows,\n\n1. one size\n1. then the reads"],
    ]);
    expect(merge.row(landed)).toBeNull();
    expect(shown(merge, landed).filter((row) => row.startsWith("live"))).toEqual([]);
  });

  it("the block before landing late is not this block's text", () => {
    const before = turn([]);
    const merge = merged([liveBlock("Let me check."), before], [liveBlock("Let me check.", true), before], [liveBlock("Let me check the follower"), before]);
    expect(merge.row(before)).toBe("Let me check the follower");
    const late = turn([["first", "Let me check."]]);
    expect(merge.row(late), "the earlier block's text").toBe("Let me check the follower");
    const landed = turn([
      ["first", "Let me check."],
      ["own", "Let me check the follower next."],
    ]);
    expect(merge.row(landed)).toBeNull();
  });
});

describe("only rendering is normalized; the block before is its own", () => {
  it("comparison operators do not make different code the same block", () => {
    const old = "```swift\nreturn count < 10\n```";
    const before = turn([["old", old]]);
    const merge = new ChatLiveMerge();
    const current = "swift\nreturn count > 10";
    merge.update(liveBlock(current), before);
    expect(merge.row(before)).toBe(current);
    const own = "```swift\nreturn count > 10\n```";
    expectSwapsOnce(
      merge,
      turn([
        ["old", old],
        ["own", own],
      ]),
      own,
    );
  });

  it("a decimal point does not turn a different number into the same block", () => {
    const before = turn([["old", "The timeout is 1.5 seconds."]]);
    const merge = new ChatLiveMerge();
    const current = "The timeout is 15 seconds.";
    merge.update(liveBlock(current), before);
    expect(merge.row(before)).toBe(current);
    expectSwapsOnce(
      merge,
      turn([
        ["old", "The timeout is 1.5 seconds."],
        ["own", current],
      ]),
      current,
    );
    // 1,000 and 10:30 keep their separators too.
    expect(ChatLiveMerge.key("1,000 at 10:30")).not.toBe(ChatLiveMerge.key("1000 at 1030"));
  });

  it("different digits keep the live row", () => {
    const before = turn([["old", "Retry 3 times."]]);
    const merge = new ChatLiveMerge();
    merge.update(liveBlock("Retry 5 times."), before);
    expect(merge.row(before)).toBe("Retry 5 times.");
    expectSwapsOnce(
      merge,
      turn([
        ["old", "Retry 3 times."],
        ["own", "Retry 5 times."],
      ]),
      "Retry 5 times.",
    );
  });

  it("a late previous longer block does not retire a new short opening", () => {
    const before = turn([]);
    const previous = "I'll check the sidebar first.";
    const merge = merged([liveBlock(previous), before], [liveBlock(previous, true), before], [liveBlock("I'll check"), before]);
    const late = turn([["previous", previous]]);
    expect(merge.row(late)).toBe("I'll check");
    merge.update(liveBlock("I'll check the chat shelf next."), late);
    expect(merge.row(late)).toBe("I'll check the chat shelf next.");
    expectSwapsOnce(
      merge,
      turn([
        ["previous", previous],
        ["own", "I'll check the chat shelf next."],
      ]),
      "I'll check the chat shelf next.",
    );
  });

  it("an ended block with a different operator starts a new block", () => {
    const before = turn([]);
    const merge = merged([liveBlock("return count < 10"), before], [liveBlock("return count < 10", true), before], [liveBlock("return count > 10"), before]);
    const previous = "```swift\nreturn count < 10\n```";
    const late = turn([["previous", previous]]);
    expect(merge.row(late)).toBe("return count > 10");
    const own = "```swift\nreturn count > 10\n```";
    expectSwapsOnce(
      merge,
      turn([
        ["previous", previous],
        ["own", own],
      ]),
      own,
    );
  });

  it("a long shared status with different counts is not the previous block landing", () => {
    const prefix =
      "I have inspected the transcript follower, the parser, the timeline builder, the companion controller, and the live screen reader. The checks cover catch-up windows, earlier history, retained panes, and rendered replies. The result is ";
    const old = `${prefix}12 tests passed.`;
    const current = `${prefix}13 tests passed.`;
    const before = turn([]);
    const merge = merged([liveBlock(old), before], [liveBlock(old, true), before], [liveBlock(current), before]);
    const late = turn([["previous", old]]);
    expect(merge.row(late)).toBe(current);
    expectSwapsOnce(
      merge,
      turn([
        ["previous", old],
        ["own", current],
      ]),
      current,
    );
  });

  it("ending the turn clears an unmatched block", () => {
    const merge = new ChatLiveMerge();
    merge.update(liveBlock("Some rendered text"), turn([]));
    expect(merge.row(turn([["final", "The turn is complete."]], true))).toBeNull();
  });

  it("only rendering is normalized", () => {
    const same: [string, string][] = [
      ["The feed reads on at once", "The feed reads **on at once**"],
      ["Open the docs", "Open [the docs](https://example.invalid/docs)"],
      ["See https://example.invalid/a", "See <https://example.invalid/a>"],
      ["Title", "## Title"],
      ["quoted words", "> quoted words"],
      ["first\nsecond", "- first\n- second"],
      ["let total = a * b", "```\nlet total = a * b\n```"],
      ["call x*y now", "call `x*y` now"],
      ["2 * 3 = 6", "2 * 3 = 6"],
      ["a * literal", "a \\* literal"],
    ];
    for (const [text, markdown] of same) expect(ChatLiveMerge.same(ChatLiveMerge.screenKeys(text), ChatLiveMerge.markdownKeys(markdown)), markdown).toBe(true);
    const different: [string, string][] = [
      ["return count > 10", "return count < 10"],
      ["x != y", "x == y"],
      ["a + b", "a - b"],
      ["The timeout is 15 seconds.", "The timeout is 1.5 seconds."],
      ["at 1030", "at 10:30"],
    ];
    for (const [text, markdown] of different) expect(ChatLiveMerge.same(ChatLiveMerge.screenKeys(text), ChatLiveMerge.markdownKeys(markdown)), markdown).toBe(false);
  });
});

describe("code keeps its leading operators", () => {
  it("fenced diff signs cannot hide the current patch", () => {
    const old = "```diff\n-    enabled = true\n```";
    const text = "diff\n+    enabled = true";
    const own = "```diff\n+    enabled = true\n```";
    const before = turn([["old", old]]);
    const capture = captured(text);
    expect(capture?.text).toBe(text);
    const merge = merged([capture, before]);
    expect(merge.row(before), "adding the indented configuration line differs from deleting it").toBe(text);
    const empty = turn([]);
    const lateMerge = merged([capture, empty]);
    expect(lateMerge.row(empty)).toBe(text);
    expect(lateMerge.row(before), "an older deletion arriving late cannot retire the current addition").toBe(text);
    const landed = turn([
      ["old", old],
      ["own", own],
    ]);
    expectSwapsOnce(merge, landed, own);
    expectSwapsOnce(lateMerge, landed, own);
  });

  it("the unary pointer operator cannot hide the current code", () => {
    const old = "```c\nresult = value;\n```";
    const text = "c\n* result = value;";
    const own = "```c\n* result = value;\n```";
    const before = turn([["old", old]]);
    const capture = captured(text);
    expect(capture?.text).toBe(text);
    const merge = merged([capture, before]);
    expect(merge.row(before)).toBe(text);
    const lateMerge = merged([capture, turn([])]);
    expect(lateMerge.row(before), "the older code landing late is not this code").toBe(text);
    const landed = turn([
      ["old", old],
      ["own", own],
    ]);
    expectSwapsOnce(merge, landed, own);
    expectSwapsOnce(lateMerge, landed, own);
  });

  it("a leading operator the screen cannot place keeps the row", () => {
    const cases: [string, string, string][] = [
      ["+ enabled = true", "```\n- enabled = true\n```", "```\n+ enabled = true\n```"],
      ["* result = value;", "```\nresult = value;\n```", "```\n* result = value;\n```"],
      ["result = value;", "```\n* result = value;\n```", "```\nresult = value;\n```"],
      ["c\nresult = value;", "```c\n* result = value;\n```", "```c\nresult = value;\n```"],
      ["- first", "```\nfirst\n```", "- first"],
    ];
    for (const [text, old, own] of cases) {
      const before = turn([["old", old]]);
      const merge = merged([liveBlock(text), before]);
      expect(merge.row(before), `first look: ${old}`).toBe(text);
      const lateMerge = merged([liveBlock(text), turn([])]);
      expect(lateMerge.row(before), `landing late: ${old}`).toBe(text);
      const landed = turn([
        ["old", old],
        ["own", own],
      ]);
      expectSwapsOnce(merge, landed, own);
      expectSwapsOnce(lateMerge, landed, own);
    }
  });

  it("a bullet meets a bullet and an operator its own operator", () => {
    const same: [string, string][] = [
      ["- first\n- second", "- first\n- second"],
      ["+ first\n* second", "+ first\n* second"],
      ["\u{2022} first\n\u{25E6} second", "- first\n  - second"],
      ["\u{2022} result = value;", "* `result = value;`"],
      ["first\nsecond", "- first\n- second"],
      ["diff\n+    enabled = true", "```diff\n+    enabled = true\n```"],
      ["* result = value;", "```\n* result = value;\n```"],
      ["- name: build", "```yaml\n- name: build\n```"],
      ["> 5 files", "```\n> 5 files\n```"],
      ["1. first", "```\n1. first\n```"],
      ["Steps:\n\n- build it\n\ndiff\n- old line\n+ new line", "Steps:\n\n- build it\n\n```diff\n- old line\n+ new line\n```"],
      ["- x is the flag", "`- x` is the flag"],
    ];
    for (const [text, markdown] of same) expect(ChatLiveMerge.same(ChatLiveMerge.screenKeys(text), ChatLiveMerge.markdownKeys(markdown)), markdown).toBe(true);
    const different: [string, string][] = [
      ["diff\n+    enabled = true", "```diff\n-    enabled = true\n```"],
      ["c\n* result = value;", "```c\nresult = value;\n```"],
      ["* result = value;", "```\nresult = value;\n```"],
      ["result = value;", "```\n* result = value;\n```"],
      ["- first", "```\nfirst\n```"],
      ["first", "```\n- first\n```"],
      ["- first", "```\n+ first\n```"],
      ["Steps:\n\n- build it\n\ndiff\n+ old line", "Steps:\n\n- build it\n\n```diff\n- old line\n```"],
      // A bullet read off one ASCII mark meets only a list written with the same one.
      ["* result = value;", "- `result = value;`"],
      ["+ first\n* second", "* first\n- second"],
      ["- first", "* first"],
      ["+ enabled = true", "- enabled = true"],
      // A text's own characters never take a mark's place.
      ["* result = value;", "- `* result = value;`"],
      ["* result = value;", "> `* result = value;`"],
      ["* result = value;", "1. `* result = value;`"],
      ["+ enabled = true", "\u{2022} `+ enabled = true`"],
    ];
    for (const [text, markdown] of different) {
      expect(ChatLiveMerge.same(ChatLiveMerge.screenKeys(text), ChatLiveMerge.markdownKeys(markdown)), markdown).toBe(false);
      expect(ChatLiveMerge.isLastText(text, turn([["old", markdown]]).turns.at(-1) ?? null), markdown).toBe(false);
    }
  });
});

describe("the bullet reading proves nothing on its own", () => {
  it("an older prose list cannot hide the current unlabelled pointer assignment", () => {
    const text = "* result = value;";
    const old = "- `result = value;`";
    const own = "```\n* result = value;\n```";
    const capture = captured(text);
    expect(capture?.text).toBe(text);
    const before = turn([["old", old]]);
    const merge = merged([capture, before]);
    expect(merge.row(before), "already landed? an older list with another mark is not this code").toBe(text);
    const empty = turn([]);
    const lateMerge = merged([capture, empty]);
    expect(lateMerge.row(empty)).toBe(text);
    expect(lateMerge.row(before), "the older list landing late cannot retire the current code").toBe(text);
    const landed = turn([
      ["old", old],
      ["own", own],
    ]);
    expectSwapsOnce(merge, landed, own);
    expectSwapsOnce(lateMerge, landed, own);
  });

  it("a bullet reading with another mark never ends the row", () => {
    const cases: [string, string, string][] = [
      ["* result = value;", "- `result = value;`", "```\n* result = value;\n```"],
      ["+ result = value;", "* `result = value;`", "```\n+ result = value;\n```"],
      ["- result = value;", "+ `result = value;`", "```\n- result = value;\n```"],
      ["- the reader", "* the reader", "- the reader"],
      ["\u{2022} the reader", "```\n* the reader\n```", "* the reader"],
    ];
    for (const [text, old, own] of cases) {
      // The block before it, ended, then this one; the one before's text (and only it) lands late.
      const empty = turn([]);
      const merge = merged([liveBlock("Earlier block."), empty], [liveBlock("Earlier block.", true), empty], [liveBlock(text), empty]);
      const late = turn([["old", old]]);
      expect(merge.row(late), `late: ${old}`).toBe(text);
      const first = merged([liveBlock(text), late]);
      expect(first.row(late), `first look: ${old}`).toBe(text);
      const landed = turn([
        ["old", old],
        ["own", own],
      ]);
      expectSwapsOnce(merge, landed, own);
      expectSwapsOnce(first, landed, own);
    }
  });
});

describe("only as written ends the row against an old text", () => {
  it("an older list of pointer code cannot hide a new list of plain assignments", () => {
    const text = "* result = value;";
    const old = "- `* result = value;`";
    const own = "* `result = value;`";
    const capture = captured(text);
    expect(capture?.text).toBe(text);
    const empty = turn([]);
    const before = turn([["old", old]]);
    const first = merged([capture, before]);
    const late = merged([capture, empty]);
    expect(late.row(empty)).toBe(text);
    for (const [name, merge] of [
      ["first look", first],
      ["landing late", late],
    ] as const) {
      expect(merge.row(before), `${name}: the older pointer code is not the current plain assignment`).toBe(text);
      expectSwapsOnce(
        merge,
        turn([
          ["old", old],
          ["own", own],
        ]),
        own,
      );
    }
  });

  it("no reading lets a text's own characters take a mark's place", () => {
    const cases: [string, string, string][] = [
      ["* result = value;", "- `* result = value;`", "* `result = value;`"],
      ["* result = value;", "> `* result = value;`", "* `result = value;`"],
      ["* result = value;", "1. `* result = value;`", "```\n* result = value;\n```"],
      ["- the reader", "+ `- the reader`", "- the reader"],
      ["+ enabled = true", "\u{2022} `+ enabled = true`", "```\n+ enabled = true\n```"],
      ["Steps:\n* result = value;", "Steps:\n- `* result = value;`", "Steps:\n* `result = value;`"],
    ];
    for (const [text, old, own] of cases) {
      const empty = turn([]);
      const before = turn([["old", old]]);
      const first = merged([liveBlock(text), before]);
      expect(first.row(before), `first look: ${old}`).toBe(text);
      const late = merged([liveBlock(text), empty]);
      expect(late.row(before), `landing late: ${old}`).toBe(text);
      const after = merged([liveBlock("Earlier block."), empty], [liveBlock("Earlier block.", true), empty], [liveBlock(text), empty]);
      expect(after.row(before), `after a block: ${old}`).toBe(text);
      const landed = turn([
        ["old", old],
        ["own", own],
      ]);
      for (const merge of [first, late, after]) expectSwapsOnce(merge, landed, own);
    }
  });

  /** The matrix's texts: how the block before it showed, the block on screen, and a text that is the same block only through `reading` (never as written; `written`: as written too). */
  const readings: { reading: string; before: string; shown: string; text: string }[] = [
    { reading: "bullet", before: "1. build", shown: "1. build\n2. test", text: "1. build\n1. test" },
    { reading: "glyph", before: "- first", shown: "\u{2022} first\n\u{25E6} second", text: "- first\n  - second" },
    { reading: "removed", before: "- first", shown: "first\nsecond", text: "- first\n- second" },
    { reading: "labelled", before: "1. build", shown: "1. build\n2. test\ndiff\n- old", text: "1. build\n1. test\n```diff\n- old\n```" },
    { reading: "across", before: "\u{2502} Item \u{2502}", shown: "\u{2502} it \u{2502} re \u{2502}\n\u{2502} em \u{2502} ads \u{2502}", text: "| Item | Reads |\n|---|---|\n| 1 | 2 |" },
    { reading: "written", before: "- first", shown: "- first\n- second", text: "- first\n- second" },
  ];

  it("only as written ends the row against an old text", () => {
    for (const test of readings) {
      const empty = turn([]);
      const there = turn([["old", test.text]]);
      const first = merged([liveBlock(test.shown), there]);
      const after = merged([liveBlock(test.before), empty], [liveBlock(test.before, true), empty], [liveBlock(test.shown), empty]);
      expect(after.row(empty), test.reading).toBe(test.shown);
      const late = turn([["before", test.text]]);
      // There first, its list in place (a list renumbered, or drawn with glyphs),
      // it explains the block and no row starts, as Swift's testOnlyAsWrittenEndsTheRowAgainstAnOldText expects.
      if (test.reading === "written" || test.reading === "bullet" || test.reading === "glyph") {
        expect(first.row(there), `there first, ${test.reading}: it never shows`).toBeNull();
      } else {
        expect(first.row(there), `there first, ${test.reading}: the row shows`).toBe(test.shown);
      }
      if (test.reading === "written") {
        expect(after.row(late), "the block before's text holds this block as written").toBeNull();
      } else {
        expect(after.row(late), `the block before, ${test.reading}: the row stays`).toBe(test.shown);
      }
      const own = merged([liveBlock(test.shown), empty]);
      expect(own.row(empty), test.reading).toBe(test.shown);
      expectSwapsOnce(own, turn([["own", test.text]]), test.text);
    }
  });

  it("the match says which readings agree", () => {
    for (const test of readings) {
      const reading = test.reading as LiveReading;
      expect(ChatLiveMerge.readings).toContain(reading);
      const found = ChatLiveMerge.match(ChatLiveMerge.screenKeys(test.shown), ChatLiveMerge.markdownKeys(test.text), ChatLiveMerge.matches);
      expect(
        found.pairs.some((pair) => pair.screen === reading || pair.markdown === reading),
        `${test.reading}: ${JSON.stringify(found.pairs)}`,
      ).toBe(true);
      expect(found.asWritten, test.reading).toBe(reading === "written");
      expect(found.ends("own"), test.reading).toBe(true);
      expect(found.ends("old"), test.reading).toBe(reading === "written");
    }
    expect(new ChatLiveMatch().ends("own")).toBe(false);
    expect(new ChatLiveMatch().ends("old")).toBe(false);
    // A glyph's list never reads as an ASCII one, whatever its text begins with; an ASCII mark meets only itself.
    const star = ChatLiveMerge.screenKeys("* result = value;");
    expect(ChatLiveMerge.same(star, ChatLiveMerge.markdownKeys("- `* result = value;`"))).toBe(false);
    expect(ChatLiveMerge.match(star, ChatLiveMerge.markdownKeys("* `result = value;`"), ChatLiveMerge.matches).asWritten).toBe(true);
    expect(ChatLiveMerge.same(ChatLiveMerge.screenKeys("\u{2022} * result = value;"), ChatLiveMerge.markdownKeys("- `* result = value;`")), "drawn with a glyph, it is that list").toBe(true);
  });
});

describe("a mark the screen's reading takes off needs that mark in the text", () => {
  it("a quote reading cannot hide the current shell truncation command", () => {
    const text = "> report.txt";
    const old = "`report.txt`";
    const own = "```\n> report.txt\n```";
    const capture = captured(text);
    expect(capture?.text).toBe(text);
    const empty = turn([]);
    const before = turn([["old", old]]);
    const first = merged([capture, before]);
    const late = merged([capture, empty]);
    expect(late.row(empty)).toBe(text);
    expect(ChatLiveMerge.same(ChatLiveMerge.screenKeys(text), ChatLiveMerge.markdownKeys(old))).toBe(false);
    for (const [name, merge] of [
      ["first look", first],
      ["landing late", late],
    ] as const) {
      expect(merge.row(before), `${name}: a file's name is not the command that empties it`).toBe(text);
      expectSwapsOnce(
        merge,
        turn([
          ["old", old],
          ["own", own],
        ]),
        own,
      );
    }
  });

  it("a mark the screen reading takes off needs that mark in the text", () => {
    const kept: [string, string, string][] = [
      ["> report.txt", "`report.txt`", "```\n> report.txt\n```"],
      ["> 5 files", "5 files", "```\n> 5 files\n```"],
      ["5. Retry 3 times.", "Retry 3 times.", "5. Retry 3 times."],
      ["1) step one", "step one", "```\n1) step one\n```"],
      ["Steps:\n> report.txt", "Steps:\n`report.txt`", "Steps:\n```\n> report.txt\n```"],
      ["> - first", "- first", "> - first"],
    ];
    for (const [text, old, own] of kept) {
      const empty = turn([]);
      const before = turn([["old", old]]);
      const first = merged([liveBlock(text), before]);
      expect(first.row(before), `first look: ${old}`).toBe(text);
      const late = merged([liveBlock(text), empty]);
      expect(late.row(before), `landing late: ${old}`).toBe(text);
      const after = merged([liveBlock("Earlier block."), empty], [liveBlock("Earlier block.", true), empty], [liveBlock(text), empty]);
      expect(after.row(before), `after a block: ${old}`).toBe(text);
      const landed = turn([
        ["old", old],
        ["own", own],
      ]);
      for (const merge of [first, late, after]) expectSwapsOnce(merge, landed, own);
    }
    const swaps: [string, string][] = [
      ["> quoted words", "> quoted words"],
      ["quoted words", "> quoted words"],
      ["> 5 files", "> 5 files"],
      ["1. build\n2. test", "1. build\n1. test"],
      ["5. Retry 3 times.", "1. Retry 3 times."],
      ["1. Read the file\n2. Run 12 tests", "1. Read the file\n1. Run 12 tests"],
      ["1. read\n   \u{2022} the file", "1. read\n   - the file"],
      ["> - first", "> - first"],
      ["- first\n- second", "- first\n- second"],
      ["\u{2022} first\n\u{25E6} second", "- first\n  - second"],
      ["first\nsecond", "- first\n- second"],
    ];
    for (const [text, own] of swaps) {
      const empty = turn([]);
      const merge = merged([liveBlock(text), empty]);
      expect(merge.row(empty)).toBe(text);
      expectSwapsOnce(merge, turn([["own", own]]), own);
    }
  });
});

describe("a complete wrapped table is the text as written", () => {
  /** A complete table, its first cells wrapped on screen. */
  const componentTable = "| Component | Behaviour |\n|---|---|\n| Transcript follower | Reads once per second |";
  const wrappedComponentTable =
    "\u{2502} Component     \u{2502} Behaviour    \u{2502}\n" +
    "\u{251C}" +
    "\u{2500}".repeat(15) +
    "\u{253C}" +
    "\u{2500}".repeat(14) +
    "\u{2524}\n" +
    "\u{2502} Transcript    \u{2502} Reads once   \u{2502}\n\u{2502} follower      \u{2502} per second   \u{2502}\n" +
    "\u{2514}" +
    "\u{2500}".repeat(15) +
    "\u{2534}" +
    "\u{2500}".repeat(14) +
    "\u{2518}";

  it("the Swift test's table, as written there", () => {
    // The Swift literal: 15 rules, a cross, 14 rules; the same at the bottom.
    expect(
      wrappedComponentTable.startsWith(
        "\u{2502} Component     \u{2502} Behaviour    \u{2502}\n\u{251C}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{253C}",
      ),
    ).toBe(true);
  });

  it("a realistic wrapped table is the text when already landed", () => {
    const text = wrappedComponentTable;
    const own = componentTable;
    for (const width of [120, 64, 34]) expect(captured(text, width)?.text, `width ${width}`).toBe(text);
    const capture = captured(text, 120);
    expect(capture?.text).toBe(text);
    const match = ChatLiveMerge.match(ChatLiveMerge.screenKeys(text), ChatLiveMerge.markdownKeys(own), ChatLiveMerge.matches);
    expect(match.pairs.some((pair) => pair.screen === "across")).toBe(true);
    expect(match.asWritten, "the complete table reflowed is the text as written").toBe(true);
    const old = turn([["own", own]]);
    const first = merged([capture, old]);
    expect(first.row(old), "already landed: it never shows").toBeNull();
    expect(first.block).toBeNull();
    const late = merged([capture, turn([])]);
    expect(late.row(turn([]))).toBe(text);
    expectSwapsOnce(late, old, own);
  });

  it("only a complete table the same cell for cell is the text as written", () => {
    const rows =
      "\u{250C}" + "\u{2500}".repeat(9) + "\u{252C}" + "\u{2500}".repeat(7) + "\u{2510}\n" +
      "\u{2502} Name    \u{2502} Count \u{2502}\n" +
      "\u{251C}" + "\u{2500}".repeat(9) + "\u{253C}" + "\u{2500}".repeat(7) + "\u{2524}\n" +
      "\u{2502} unit    \u{2502} 12    \u{2502}\n\u{2502} tests   \u{2502}       \u{2502}\n" +
      "\u{251C}" + "\u{2500}".repeat(9) + "\u{253C}" + "\u{2500}".repeat(7) + "\u{2524}\n" +
      "\u{2502} ui      \u{2502} 5     \u{2502}\n\u{2502} tests   \u{2502}       \u{2502}\n" +
      "\u{2514}" + "\u{2500}".repeat(9) + "\u{2534}" + "\u{2500}".repeat(7) + "\u{2518}";
    const tableRule = "\u{251C}" + "\u{2500}".repeat(11) + "\u{253C}" + "\u{2500}".repeat(4) + "\u{2524}";
    const bottom = "\u{2514}" + "\u{2500}".repeat(11) + "\u{2534}" + "\u{2500}".repeat(4) + "\u{2518}";
    const operators = `\u{2502} Value     \u{2502} Op \u{2502}\n${tableRule}\n\u{2502} one less  \u{2502} -1 \u{2502}\n\u{2502} than this \u{2502}    \u{2502}\n${bottom}`;
    const prose = `Results:\n\n\u{2502} Test   \u{2502} Count \u{2502}\n${tableRule}\n\u{2502} unit   \u{2502} 12    \u{2502}\n\u{2502} tests  \u{2502}       \u{2502}\n${bottom}\n\nAll pass.`;
    const unruled = `\u{2502} a     \u{2502} b    \u{2502}\n${tableRule}\n\u{2502} one   \u{2502} 1    \u{2502}\n\u{2502} two   \u{2502} 2    \u{2502}\n\u{2502} three \u{2502} 3    \u{2502}\n${bottom}`;
    const open = `\u{2502} Component     \u{2502} Behaviour    \u{2502}\n${tableRule}\n\u{2502} Transcript    \u{2502} Reads once   \u{2502}\n\u{2502} follower      \u{2502} per second   \u{2502}`;
    const same: [string, string][] = [
      [wrappedComponentTable, componentTable],
      [rows, "| Name | Count |\n|---|---|\n| unit tests | 12 |\n| ui tests | 5 |"],
      [operators, "| Value | Op |\n|---|---|\n| one less than this | -1 |"],
      [prose, "Results:\n\n| Test | Count |\n|---|---|\n| unit tests | 12 |\n\nAll pass."],
      [unruled, "| a | b |\n|---|---|\n| one | 1 |\n| two | 2 |\n| three | 3 |"],
    ];
    for (const [text, markdown] of same) {
      const there = turn([["old", markdown]]);
      expect(merged([liveBlock(text), there]).row(there), `already landed: ${markdown}`).toBeNull();
    }
    const other: [string, string][] = [
      [operators, "| Value | Op |\n|---|---|\n| one less than this | +1 |"],
      [prose, "Results:\n\n| Test | Count |\n|---|---|\n| unit | tests 12 |\n\nAll pass."],
      [rows, "| Name | Count |\n|---|---|\n| ui tests | 5 |\n| unit tests | 12 |"],
      [wrappedComponentTable, `${componentTable}\n| Parser | Reads lines |`],
      [prose, "Results:\n\n| Test | Count |\n|---|---|\n| unit tests | 12 |\n\nAll fail."],
      [open, componentTable],
      [unruled, "| a | b |\n|---|---|\n| one two | 1 2 |\n| three | 3 |"],
      ["\u{2502} it \u{2502} re \u{2502}\n\u{2502} em \u{2502} ads \u{2502}", "| Item | Reads |\n|---|---|\n| 1 | 2 |"],
    ];
    for (const [text, markdown] of other) {
      const there = turn([["old", markdown]]);
      expect(merged([liveBlock(text), there]).row(there), `there first: ${markdown}`).toBe(text);
    }
    for (const [text, markdown] of same) expectSwapsOnce(merged([liveBlock(text), turn([])]), turn([["own", markdown]]), markdown);
  });

  it("every pair but written and whole tables is own only", () => {
    const all: LiveReading[] = ["written", "bullet", "glyph", "removed", "labelled", "across", "table"];
    for (const screenReading of all) {
      for (const markdownReading of all) {
        const match = new ChatLiveMatch([{ screen: screenReading, markdown: markdownReading }]);
        expect(match.ends("own"), `${screenReading}, ${markdownReading}`).toBe(true);
        expect(match.ends("old"), `${screenReading}, ${markdownReading}`).toBe(screenReading === markdownReading && (screenReading === "written" || screenReading === "table"));
      }
    }
    const keys = ChatLiveMerge.screenKeys(wrappedComponentTable);
    const found = ChatLiveMerge.match(keys, ChatLiveMerge.markdownKeys(componentTable), ChatLiveMerge.matches);
    expect(found.has("table", "table"), JSON.stringify(found.pairs)).toBe(true);
    expect(found.pairs.some((pair) => (pair.screen === "table") !== (pair.markdown === "table")), JSON.stringify(found.pairs)).toBe(false);
    const longer = ChatLiveMerge.markdownKeys(`${componentTable}\n| Parser | Reads lines |`);
    expect(ChatLiveMerge.match(keys, longer, ChatLiveMerge.matches).pairs.some((pair) => pair.screen === "table"), "a table holding the screen's is not it: whole only").toBe(false);
    expect(ChatLiveMerge.screenKeys("\u{2502} it \u{2502} re \u{2502}\n\u{2502} em \u{2502} ads \u{2502}").every((key) => key.reading !== "table"), "not closed: no whole table").toBe(true);
  });
});

describe("when the row starts and ends", () => {
  it("starts once caught up, and only a new text ends it", () => {
    const merge = new ChatLiveMerge();
    const stale = turn([]);
    merge.update(liveBlock("I'll check"), stale, false);
    expect(merge.row(stale), "not caught up: the row has not started").toBeNull();
    expect(merge.block).toBeNull();
    // Caught up: an older reply of the turn beginning the same is there.
    const caught = turn([["old", "I'll check the sidebar first."]]);
    merge.update(liveBlock("I'll check"), caught, true);
    expect(merge.row(caught)).toBe("I'll check");
    // Started, it stays through a catch-up later (a burst).
    merge.update(liveBlock("I'll check the reader"), caught, false);
    expect(merge.row(caught)).toBe("I'll check the reader");
    const landed = turn([
      ["old", "I'll check the sidebar first."],
      ["own", "I'll check the reader."],
    ]);
    expect(merge.row(landed)).toBeNull();
  });

  it("the turn's end clears the row", () => {
    const merge = new ChatLiveMerge();
    const running = turn([]);
    merge.update(liveBlock("Done: \u{2502} a \u{2502}"), running);
    expect(merge.row(running)).not.toBeNull();
    expect(merge.row(turn([["own", "Something drawn otherwise."]], true))).toBeNull();
  });

  it("a block already in the transcript never shows", () => {
    let merge = new ChatLiveMerge();
    const landed = timeline(["The feed reads on at once."]);
    merge.update(liveBlock("The feed reads on at once."), landed);
    expect(merge.row(landed)).toBeNull();
    merge = new ChatLiveMerge();
    const before = timeline(["Step 2 committed."]);
    merge.update(liveBlock("Writing the step 3 tests.", true), before);
    expect(merge.row(before)).toBeNull();
    expect(merge.block).toBeNull();
  });

  it("no block, no row", () => {
    const merge = new ChatLiveMerge();
    const before = timeline([]);
    merge.update(liveBlock("The feed"), before);
    merge.update(null, before);
    expect(merge.row(before)).toBeNull();
    merge.update(liveBlock("\u{2026}"), before);
    expect(merge.row(before), "nothing to read").toBeNull();
  });

  it("a copy goes on as the merge was, and the two never share a change", () => {
    const merge = new ChatLiveMerge();
    const before = timeline([]);
    merge.update(liveBlock("The feed reads on"), before);
    const copy = merge.clone();
    expect(copy.equals(merge)).toBe(true);
    copy.update(liveBlock("The feed reads on at once"), before);
    expect(merge.row(before)).toBe("The feed reads on");
    expect(copy.row(before)).toBe("The feed reads on at once");
    expect(copy.equals(merge)).toBe(false);
  });
});
