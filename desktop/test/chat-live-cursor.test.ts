// Cursor's reply read off its screen
// (ChatLiveScreen.block on a Cursor screen: the block below the last tool row,
// or below the two blank lines under the user's echoed prompt, and above the braille
// spinner row while "ctrl+c to stop" shows at the box) and the live row it
// makes until the store's message lands (ChatLiveMerge), with the same
// fixtures and results as Tests/HerdrKitTests/ChatLiveCursorTests.swift.

import { describe, expect, it } from "vitest";

import { ChatLiveMerge, ChatLiveScreen, liveBlock, type ChatLiveBlock } from "../src/shared/chat/live-screen";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline } from "../src/shared/chat/model";
import { codexScreens } from "./support/live-codex-fixtures";
import { cursorLanded, cursorScreens } from "./support/live-cursor-fixtures";

const screenOf = (name: string): string => {
  const found = cursorScreens.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no fixture ${name}`);
  return found.screen;
};
const read = (name: string): ChatLiveBlock | null => ChatLiveScreen.block(screenOf(name), "cursor");
const textOf = (name: string): string | null => cursorScreens.find((each) => each.name === name)?.text ?? null;

const user = (id: string, text: string): ChatItem => ({ type: "user", value: userMessage(id, text, null) });
const agentText = (id: string, markdown: string): ChatItem => ({ type: "agentText", value: { id, markdown, time: null } });

/** The user's prompt, then the store's messages; `finished`: the turn's last message had no tool call. */
function turn(texts: [string, string][], finished = false): ChatTimeline {
  return { ...emptyTimeline, turns: [makeTurn("t", { items: [user("u", cursorLanded.prompt), ...texts.map(([id, text]) => agentText(id, text))], isFinished: finished })] };
}

/** The rows Chat shows: the store's texts, then the live row's ("live: "). */
function shown(merge: ChatLiveMerge, timeline: ChatTimeline): string[] {
  const texts = timeline.turns.flatMap((each) => each.items).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));
  const row = merge.row(timeline);
  return row === null ? texts : [...texts, `live: ${row}`];
}

describe("Cursor's screen", () => {
  it("has the recorded shapes", () => {
    expect(cursorScreens.length).toBe(19);
  });

  it.each(cursorScreens.map((each) => [each.name, each.what, each] as const))("%s (%s)", (_name, _what, fixture) => {
    const block = ChatLiveScreen.block(fixture.screen, "cursor");
    expect(block?.text ?? null).toBe(fixture.text);
    if (block !== null) {
      expect(block.finished, "a Cursor block shows only while it is written").toBe(false);
      expect(block.drawing, "read as Cursor draws it").toBe("cursor");
    }
  });

  it("the growing reply's frames each hold the one before", () => {
    const frames = ["reply cut mid-line", "reply whole while working", "reply whole, tokens on"].map((name) => read(name)?.text ?? "");
    for (let index = 1; index < frames.length; index += 1) {
      expect(ChatLiveMerge.key(frames[index]!).startsWith(ChatLiveMerge.key(frames[index - 1]!)), frames[index]).toBe(true);
    }
  });

  it("a Cursor screen never reads as Claude's or Codex's, nor theirs as Cursor's", () => {
    // The pane's agent picks the reader.
    for (const fixture of codexScreens) {
      expect(ChatLiveScreen.block(fixture.screen, "codex")?.drawing ?? "codex", fixture.name).toBe("codex");
      expect(ChatLiveScreen.block(fixture.screen, "cursor"), fixture.name).toBeNull();
    }
    const rule = "\u{2500}".repeat(64);
    const writing = ["\u{276F} go on", "", "\u{23FA} The feed reads on", "", "\u{2722} Working\u{2026} (12s)", "", rule, "\u{276F}", rule].join("\n");
    expect(ChatLiveScreen.block(writing, "claude")).toEqual(liveBlock("The feed reads on"));
    expect(ChatLiveScreen.block(writing, "cursor")).toBeNull();
    // Cursor's spinner and box under Claude Code's rules: Claude's reading only (no spinner of its own: nothing).
    const mixed = [screenOf("reply whole while working"), rule, "\u{276F}", rule].join("\n");
    expect(ChatLiveScreen.block(mixed, "claude")).toBeNull();
    expect(ChatLiveScreen.block(mixed, "cursor")).toBeNull();
  });

  it("the store's Markdown (its heading's #, the code's fence) is the same text as the screen's drawing", () => {
    const keys = ChatLiveMerge.markdownKeys(cursorLanded.reply, "cursor").map((key) => key.text);
    expect(keys).toContain(ChatLiveMerge.key(read("reply whole while working")!.text));
  });
});

describe("Cursor's live row", () => {
  it("grows with the screen, then the store's reply takes its place: one row", () => {
    const working = turn([["lead", cursorLanded.leadIn]]);
    const merge = new ChatLiveMerge();
    merge.update(read("tool done"), working);
    expect(merge.row(working), "the tool row alone: no row").toBeNull();
    merge.update(read("reply cut mid-line"), working);
    expect(merge.row(working)).toBe(textOf("reply cut mid-line"));
    merge.update(read("reply whole while working"), working);
    expect(merge.row(working)).toBe(textOf("reply whole while working"));
    const landed = turn([["lead", cursorLanded.leadIn], ["reply", cursorLanded.reply]], true);
    expect(merge.row(landed), "the landed reply is the one row").toBeNull();
    expect(shown(merge, landed)).toEqual([cursorLanded.leadIn, cursorLanded.reply]);
    // Read again with the reply still on screen and the spinner on: still one row.
    merge.update(read("reply whole, tokens on"), landed);
    expect(shown(merge, landed)).toEqual([cursorLanded.leadIn, cursorLanded.reply]);
    // Landed while only the cut reply was on show: it takes the row's place too.
    const early = new ChatLiveMerge();
    early.update(read("reply cut mid-line"), working);
    expect(shown(early, landed)).toEqual([cursorLanded.leadIn, cursorLanded.reply]);
  });

  it("the lead-in, saved as its own message, never shows twice", () => {
    const start = turn([]);
    const merge = new ChatLiveMerge();
    merge.update(read("lead-in alone"), start);
    expect(shown(merge, start)).toEqual([`live: ${cursorLanded.leadIn}`]);
    const lead = turn([["lead", cursorLanded.leadIn]]);
    expect(shown(merge, lead), "its message landed: the row goes").toEqual([cursorLanded.leadIn]);
    for (const name of ["lead-in, tool running", "tool done", "thinking after the tool"]) {
      merge.update(read(name), lead);
      expect(shown(merge, lead), name).toEqual([cursorLanded.leadIn]);
    }
    merge.update(read("reply cut mid-line"), lead);
    expect(shown(merge, lead)).toEqual([cursorLanded.leadIn, `live: ${textOf("reply cut mid-line")}`]);
    // The lead-in landing late (after the reply's row started) is not the reply's: the row stays.
    const late = new ChatLiveMerge();
    late.update(read("reply cut mid-line"), start);
    expect(shown(late, lead)).toEqual([cursorLanded.leadIn, `live: ${textOf("reply cut mid-line")}`]);
    const landed = turn([["lead", cursorLanded.leadIn], ["reply", cursorLanded.reply]], true);
    expect(shown(late, landed)).toEqual([cursorLanded.leadIn, cursorLanded.reply]);
    // Already landed when the screen shows it: no row.
    const there = new ChatLiveMerge();
    there.update(read("lead-in alone"), lead);
    expect(shown(there, lead)).toEqual([cursorLanded.leadIn]);
  });

  it("a reply already landed whole starts no row", () => {
    const landed = turn([["lead", cursorLanded.leadIn], ["reply", cursorLanded.reply]], true);
    for (const name of ["reply whole while working", "reply whole, tokens on"]) {
      const merge = new ChatLiveMerge();
      merge.update(read(name), landed);
      expect(shown(merge, landed), name).toEqual([cursorLanded.leadIn, cursorLanded.reply]);
    }
  });

  it("a block first seen over a finished turn starts no row (Cursor's turn ends with its last message): the user's next message first", () => {
    const finished = turn([["lead", cursorLanded.leadIn], ["reply", "Earlier answer."]], true);
    const merge = new ChatLiveMerge();
    merge.update(read("reply cut mid-line"), finished);
    expect(merge.row(finished)).toBeNull();
    // Claude Code's and Codex's rows still show it.
    const claude = new ChatLiveMerge();
    claude.update(liveBlock("The feed reads on"), finished);
    expect(claude.row(finished)).toBe("The feed reads on");
  });

  it("the user's own words on screen are never a Cursor row (the echoed prompt, however the screen was cut)", () => {
    const start = turn([]);
    const tail = "numbered list, and a short zsh block that counts the words in plan.md. Do not run commands or change files.";
    const merge = new ChatLiveMerge();
    merge.update(liveBlock(tail, false, "cursor"), start);
    expect(merge.row(start)).toBeNull();
    // Claude Code's and Codex's rows still show it.
    const codex = new ChatLiveMerge();
    codex.update(liveBlock(tail, false, "codex"), start);
    expect(codex.row(start)).toBe(tail);
  });
});

// The user's prompt never shows as Cursor's reply, and the reply is never cut.
// The screen's reader cannot tell the user's echoed words from a reply (both
// are drawn the same); the merge, which knows the turn's message, withholds
// the whole candidate (no row; the store's message shows when it lands) when,
// whitespace folded, it starts with the user's prompt, or holds it anywhere
// when it has 8 or more key characters; otherwise the candidate shows whole.
describe("the user's prompt never shows as Cursor's reply, and the reply is never cut", () => {
  const next = "Which step takes longest?";
  const reply = "The topcoat: it needs the full day to cure.";
  /** The recorded second-turn fixture with `prompt` (its lines as drawn) and `blanks` blank lines under it. */
  const secondTurn = (blanks: number, prompt: readonly string[] = [next]): string =>
    screenOf("second turn").replace(`  ${next}\n\n\n`, `${prompt.map((line) => `  ${line}`).join("\n")}\n${"\n".repeat(blanks)}`);
  /** The first turn (the user's prompt, its reply) finished, then the user's message `asked`, the turn running; `landed`: its reply in the store. */
  const timeline = (landed: string | null, asked = next): ChatTimeline => ({
    ...emptyTimeline,
    turns: [
      makeTurn("t1", { items: [user("u1", cursorLanded.prompt), agentText("a1", cursorLanded.reply)], isFinished: true }),
      makeTurn("t2", { items: [user("u2", asked), ...(landed === null ? [] : [agentText("a2", landed)])], isFinished: false }),
    ],
  });
  /** The row read off `screen` over the running turn, read twice; never a part of the block: the whole of it or none. */
  const rowOf = (screen: string, asked = next): string | null => {
    const block = ChatLiveScreen.block(screen, "cursor");
    const merge = new ChatLiveMerge();
    merge.update(block, timeline(null, asked));
    merge.update(ChatLiveScreen.block(screen, "cursor"), timeline(null, asked));
    const row = merge.row(timeline(null, asked));
    expect([null, block?.text ?? null], "the whole candidate or none").toContain(row);
    return row;
  };
  /** The rows once `landed` is in the store while the turn runs on. */
  const afterLanding = (screen: string, landed: string, asked = next): string[] => {
    const merge = new ChatLiveMerge();
    merge.update(ChatLiveScreen.block(screen, "cursor"), timeline(null, asked));
    merge.update(ChatLiveScreen.block(screen, "cursor"), timeline(landed, asked));
    return shown(merge, timeline(landed, asked));
  };

  for (const blanks of [2, 1, 0]) {
    it(`the second turn with ${blanks} blank line${blanks === 1 ? "" : "s"} under the prompt: ${blanks === 2 ? "the reply" : "no row"}, then the store's alone`, () => {
      // The reader's block: below the two blank lines (the recorded gap), else from the gap above the echo.
      expect(ChatLiveScreen.block(secondTurn(blanks), "cursor")?.text).toBe(blanks === 2 ? reply : `${next}\n${blanks === 1 ? "\n" : ""}${reply}`);
      expect(rowOf(secondTurn(blanks))).toBe(blanks === 2 ? reply : null);
      expect(afterLanding(secondTurn(blanks), reply)).toEqual([cursorLanded.reply, reply]);
    });
  }

  // A two-sentence prompt wrapped at the 119-column pane, its last line long enough that the reply's first word joins it.
  const wrapped = [
    "Please review the painting plan carefully and explain which step takes longest, and what precautions we need.",
    "Also explain whether we can work on another task while waiting for the paint, and how long each task takes.",
  ];
  const long = wrapped.join(" ");
  for (const blanks of [0, 1, 2]) {
    it(`a wrapped two-sentence prompt with ${blanks} blank line${blanks === 1 ? "" : "s"} under it: ${blanks === 2 ? "the reply" : "no row, never the prompt and the reply"}; landed while the turn runs: the store's alone`, () => {
      const screen = secondTurn(blanks, wrapped);
      expect(rowOf(screen, long)).toBe(blanks === 2 ? reply : null);
      expect(afterLanding(screen, reply, long)).toEqual([cursorLanded.reply, reply]);
    });
  }

  it("a reply that repeats the user's question as its own paragraph: no row until it lands, never its tail", () => {
    const screen = ["  Cursor Agent", "", "", `  ${next}`, "", "", "  Your question was:", "", `  ${next}`, "", "  The topcoat does.", "",
      " \u{2818}\u{2823} Working  169 tokens", "    Tip: Type ? in the prompt bar to show in-app hints.", "", "",
      `  \u{2192} Add a follow-up${" ".repeat(84)}ctrl+c to stop`, "", "", "  Grok 4.7 256K Medium", "  /Users/demo/project"].join("\n");
    const whole = `Your question was:\n\n${next}\n\nThe topcoat does.`;
    expect(ChatLiveScreen.block(screen, "cursor")?.text).toBe(whole);
    expect(rowOf(screen)).toBeNull();
    const merge = new ChatLiveMerge();
    merge.update(ChatLiveScreen.block(screen, "cursor"), timeline(null));
    expect(shown(merge, timeline(whole))).toEqual([cursorLanded.reply, whole]);
  });

  it("a short prompt (Why?) joined to the reply with no blank line: no row; under the recorded gap: the reply", () => {
    expect(rowOf(secondTurn(0, ["Why?"]), "Why?")).toBeNull();
    expect(rowOf(secondTurn(1, ["Why?"]), "Why?")).toBeNull();
    expect(rowOf(secondTurn(2, ["Why?"]), "Why?")).toBe(reply);
    // A short prompt inside the reply (not at its start) is the reply's.
    const merge = new ChatLiveMerge();
    merge.update(liveBlock("Here is why? The topcoat needs a day.", false, "cursor"), timeline(null, "Why?"));
    expect(merge.row(timeline(null, "Why?"))).toBe("Here is why? The topcoat needs a day.");
  });

  it("the user's prompt (8 or more key characters) anywhere in the candidate, alone, or ending it: no row", () => {
    for (const text of [`wc -w plan.md\n\n${next}\n\n${reply}`, next, `wc -w plan.md\n\n${next}`, `You asked "${next}" The topcoat does.`, `${next} The topcoat: a full day.`]) {
      const merge = new ChatLiveMerge();
      merge.update(liveBlock(text, false, "cursor"), timeline(null));
      expect(merge.row(timeline(null)), text).toBeNull();
    }
  });

  it("Claude Code's and Codex's rows still show the candidate", () => {
    for (const drawing of ["claude", "codex"] as const) {
      const merge = new ChatLiveMerge();
      merge.update(liveBlock(`${next}\n\n${reply}`, false, drawing), timeline(null));
      expect(merge.row(timeline(null)), drawing).toBe(`${next}\n\n${reply}`);
    }
  });
});

// Indented reply code is never a tool row. A four-space line is a tool row only with a tool row's shape (a known
// verb, then a path or target, nothing else); code (the word followed by an
// operator or a mark) is the reply's; a line that may be either withholds the
// block rather than cut the reply at it.
describe("indented reply code is never a tool row", () => {
  /** A working Cursor screen with `body` between the user's echoed prompt and the spinner. */
  const screen = (body: string[]): string =>
    [
      "  Cursor Agent",
      "",
      "",
      "  A question",
      "",
      "",
      ...body,
      "",
      " \u{2818}\u{2823} Working  169 tokens",
      "    Tip: Type ? in the prompt bar to show in-app hints.",
      "",
      "",
      `  \u{2192} Add a follow-up${" ".repeat(84)}ctrl+c to stop`,
      "",
      "",
      "  Grok 4.7 256K Medium",
      "  /Users/demo/project",
    ].join("\n");
  const reply = "The script writes the result:\n\n  Reading = 1\n\nIt returns the count.";
  const codeReply = screen(["    Read plan.md", "", "  The script writes the result:", "", "    Reading = 1", "", "  It returns the count."]);

  it("the whole reply, its code line kept (two in from the reply)", () => {
    expect(ChatLiveScreen.block(codeReply, "cursor")).toEqual(liveBlock(reply, false, "cursor"));
  });

  it("as it grows: the row only grows; the store's reply (the code fenced) takes its place while the turn runs", () => {
    const frames = [
      screen(["    Read plan.md", "", "  The script writes the result:"]),
      screen(["    Read plan.md", "", "  The script writes the result:", "", "    Reading = 1"]),
      codeReply,
    ];
    const start: ChatTimeline = { ...emptyTimeline, turns: [makeTurn("t", { items: [user("u", "Show the script.")], isFinished: false })] };
    const merge = new ChatLiveMerge();
    const rows: string[] = [];
    for (const frame of frames) {
      merge.update(ChatLiveScreen.block(frame, "cursor"), start);
      rows.push(merge.row(start)!);
    }
    expect(rows).toEqual(["The script writes the result:", "The script writes the result:\n\n  Reading = 1", reply]);
    const landed: ChatTimeline = {
      ...emptyTimeline,
      turns: [makeTurn("t", { items: [user("u", "Show the script."), agentText("a", "The script writes the result:\n\n```python\n  Reading = 1\n```\n\nIt returns the count.")], isFinished: false })],
    };
    expect(merge.row(landed)).toBeNull();
  });

  it("code that starts with a tool's word is the reply's: an operator or a mark after the word", () => {
    for (const code of ["    Reading = 1", "    Read += 2", "    Running(count)", "    Searched: true", "    Wrote -> done", "    Listing[0]"]) {
      const block = ChatLiveScreen.block(screen(["    Read plan.md", "", "  Before.", "", code, "", "  After."]), "cursor");
      expect(block?.text, code).toBe(`Before.\n\n  ${code.trim()}\n\nAfter.`);
    }
  });

  it("the recorded rows stay tool rows: Reading notes.md, Read notes.md, a Tip", () => {
    for (const row of ["    Reading notes.md", "    Read notes.md", "    Read Tests/KiteTests/RateLimiterTests.swift", "    Tip: Type ? in the prompt bar."]) {
      expect(ChatLiveScreen.block(screen(["  Lead-in.", "", row, "", "  The reply."]), "cursor")?.text, row).toBe("The reply.");
    }
  });

  it("a line that may be a tool row or code withholds the block (never its tail promoted)", () => {
    for (const unclear of [
      ["    Refactored the limiter"],
      ["    Reading"],
      ["    Read plan.md; rm notes.md"],
      ["    Read plan.md", "    and the notes"],
    ]) {
      const block = ChatLiveScreen.block(screen(["    Read plan.md", "", "  Before.", "", ...unclear, "", "  After."]), "cursor");
      expect(block, unclear.join(" / ")).toBeNull();
    }
    // Above the last tool row it does not matter: the reply is below that row.
    expect(ChatLiveScreen.block(screen(["    Refactored the limiter", "", "    Read plan.md", "", "  After."]), "cursor")?.text).toBe("After.");
  });
});
