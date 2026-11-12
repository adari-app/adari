// Progress rows (aligned with the Swift app's
// ClaudeTranscriptParserProgressTests.swift and ChatTimelineProgressTests.swift):
// Claude Code marks a line whose thinking text its terminal prints between tool
// calls with `"thinkingDisplay": "updates"`; that text shows as a progress row at
// its place, never the reply, never the turn's end. Any other thinking stays hidden.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed } from "../src/shared/chat/feed";
import { firstLoadWindow } from "../src/shared/chat/follower";
import { endingRunningTurn, runningTurn, turnFoldSummary, turnFooter, turnHasAgentOutput, turnRows, type ChatTurn } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { parseChatDate } from "../src/shared/chat/tools";
import {
  claudePath,
  claudeSession,
  eventually,
  FakeTranscriptReader,
  json,
  reply,
  result,
  session,
  shape,
  shown,
  stamp,
  text,
  timelineOf,
  tool,
  user,
  whole,
} from "./support/chat-lines";

type JSONValue = Parameters<typeof json>[0];

const investigating = "I'm investigating why that text appears in the terminal but not the app.";
const merged = "'While you were away' is merged to main; the **away** card shows it now.";

function line(
  blocks: JSONValue[],
  uuid: string,
  second: number,
  options: { display?: JSONValue | undefined; messageID?: string; blockIndex?: number; stop?: string } = {},
): string {
  const object: Record<string, JSONValue> = {
    type: "assistant",
    uuid,
    parentUuid: "p-" + uuid,
    timestamp: stamp(second),
    apiBlockIndex: options.blockIndex ?? 1,
    isSidechain: false,
    sessionId: session,
    version: "2.1.316",
    message: {
      id: options.messageID ?? "msg_" + uuid,
      role: "assistant",
      type: "message",
      model: "claude-opus-5-5",
      content: blocks,
      stop_reason: options.stop ?? null,
    },
  };
  const display = "display" in options ? options.display : "updates";
  if (display !== undefined) object.thinkingDisplay = display;
  return json(object);
}

function progress(
  textValue: string | null,
  uuid: string,
  second: number,
  options: { display?: JSONValue | undefined; messageID?: string; blockIndex?: number } = {},
): string {
  const block: Record<string, JSONValue> = { type: "thinking", signature: "sig" };
  if (textValue !== null) block.thinking = textValue;
  return line([block], uuid, second, options);
}

function events(lines: readonly string[]) {
  const parser = new TranscriptParser("claude");
  const found = lines.flatMap((value) => parser.parse(value).events);
  return { events: found, stats: parser.stats };
}

const time = (second: number): number => parseChatDate(stamp(second))!;

describe("the parser", () => {
  it("makes the prompt's fixture line a progress event, and its empty twin nothing", () => {
    const parser = new TranscriptParser("claude");
    const shownLine = `{"type":"assistant","uuid":"u1","thinkingDisplay":"updates","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"I'm investigating.","signature":"s"}]}}`;
    const emptyLine = `{"type":"assistant","uuid":"u2","thinkingDisplay":"updates","message":{"id":"m2","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"s"}]}}`;
    expect(parser.parse(shownLine).events).toEqual([{ type: "agentProgress", text: { id: "u1", markdown: "I'm investigating.", time: null } }]);
    expect(parser.parse(emptyLine).events).toEqual([]);
    expect(parser.stats.skippedTypes.get("assistant/thinking")).toBe(1);
  });

  it("makes an updates line with text a progress event", () => {
    const found = events([user("Why does the away text not show in the app?", "u1", 0), progress(investigating, "a1", 2)]);
    expect(found.events.length).toBe(2);
    expect(found.events.at(-1)).toEqual({ type: "agentProgress", text: { id: "a1", markdown: investigating, time: time(2) } });
    expect(found.stats.linesWithEvents).toBe(2);
    expect(found.stats.skipped).toBe(0);
  });

  it("keeps its markdown as written", () => {
    expect(events([progress(merged, "a1", 2)]).events).toEqual([{ type: "agentProgress", text: { id: "a1", markdown: merged, time: time(2) } }]);
  });

  it("keeps empty thinking hidden", () => {
    const found = events([progress("", "a1", 1), progress("  \n\t ", "a2", 2), progress(null, "a3", 3)]);
    expect(found.events).toEqual([]);
    expect(found.stats.skippedTypes.get("assistant/thinking")).toBe(3);
  });

  it("keeps thinking without updates hidden", () => {
    const found = events([
      progress("Consider the tail.", "a1", 1, { display: undefined }),
      progress("Consider the tail.", "a2", 2, { display: "summarized" }),
      progress("Consider the tail.", "a3", 3, { display: "Updates" }),
      progress("Consider the tail.", "a4", 4, { display: true }),
      progress("Consider the tail.", "a5", 5, { display: ["updates"] }),
    ]);
    expect(found.events).toEqual([]);
    expect(found.stats.skippedTypes.get("assistant/thinking")).toBe(5);
  });

  it("keeps redacted thinking hidden", () => {
    const found = events([line([{ type: "redacted_thinking", data: "ZW5jcnlwdGVk" }], "a1", 1)]);
    expect(found.events).toEqual([]);
    expect(found.stats.skippedTypes.get("assistant/redacted_thinking")).toBe(1);
  });

  it("keeps progress at its place among tool calls", () => {
    const { timeline } = timelineOf([
      user("Why does the away text not show?", "u1", 0),
      tool("toolu_1", "rg 'While you were away'", "t1", 1),
      result("toolu_1", "App/CompanionAwayView.swift", "r1", 2),
      progress(investigating, "p1", 3),
      tool("toolu_2", "git log --oneline -3", "t2", 4),
      result("toolu_2", "aec7776 Merge", "r2", 5),
      progress(merged, "p2", 6),
      reply("Both lines show in the app now.", "a1", 7, true),
    ]);
    expect(shown(timeline)).toEqual([
      "user:Why does the away text not show?",
      "tool:rg 'While you were away'",
      "progress:" + investigating,
      "tool:git log --oneline -3",
      "progress:" + merged,
      "agent:Both lines show in the app now.",
    ]);
    expect(timeline.turns.length).toBe(1);
    expect(timeline.turns[0]!.isFinished).toBe(true);
  });

  it("shows two updates in one message", () => {
    const oneLine = timelineOf([
      user("Go on", "u1", 0),
      line(
        [
          { type: "thinking", thinking: "Reading the parser first.", signature: "s1" },
          { type: "thinking", thinking: "Then the timeline.", signature: "s2" },
        ],
        "a1",
        1,
      ),
    ]).timeline;
    expect(shown(oneLine)).toEqual(["user:Go on", "progress:Reading the parser first.", "progress:Then the timeline."]);
    expect(oneLine.turns[0]!.items.map((item) => item.value.id)).toEqual(["u1", "a1", "a1/1"]);

    const lines = timelineOf([
      user("Go on", "u1", 0),
      progress("Reading the parser first.", "a1", 1, { messageID: "msg_x", blockIndex: 1 }),
      tool("toolu_1", "sed -n 1,80p Parser.swift", "a2", 2),
      result("toolu_1", "import Foundation", "r1", 3),
      progress("Then the timeline.", "a3", 4, { messageID: "msg_x", blockIndex: 3 }),
    ]).timeline;
    expect(shown(lines)).toEqual(["user:Go on", "progress:Reading the parser first.", "tool:sed -n 1,80p Parser.swift", "progress:Then the timeline."]);
  });

  it("keeps the order of an update and text in one line", () => {
    const found = events([
      line(
        [
          { type: "thinking", thinking: "Checking the build.", signature: "s1" },
          { type: "text", text: "The build passes." },
        ],
        "a1",
        1,
      ),
    ]);
    expect(found.events).toEqual([
      { type: "agentProgress", text: { id: "a1", markdown: "Checking the build.", time: time(1) } },
      { type: "agentText", text: { id: "a1/1", markdown: "The build passes.", time: time(1) } },
    ]);
  });

  it("leaves the turn running after a progress row", () => {
    const { timeline } = timelineOf([
      user("Go on", "u1", 0),
      tool("toolu_1", "swift test", "t1", 1),
      result("toolu_1", "passed", "r1", 2),
      progress(investigating, "p1", 3),
    ]);
    const running = runningTurn(timeline);
    expect(running).not.toBeNull();
    expect(running?.items.at(-1)?.value.id).toBe("p1");
    expect(turnFooter(running!)).toBeNull();
  });
});

function turnLines(n = 1, start = 0, ends = true, pad = 0): string[] {
  const filler = pad > 0 ? " " + "lorem ipsum ".repeat(Math.floor(pad / 12)) : "";
  const lines = [
    user(`Why is the away text missing? (${n})`, `u${n}`, start),
    tool(`toolu_${n}a`, `rg away ${n}`, `t${n}a`, start + 1),
    result(`toolu_${n}a`, "App/CompanionAwayView.swift", `r${n}a`, start + 2),
    tool(`toolu_${n}b`, `git log ${n}`, `t${n}b`, start + 3),
    result(`toolu_${n}b`, "aec7776", `r${n}b`, start + 4),
    progress(`Investigating ${n}.`, `p${n}a`, start + 5),
    tool(`toolu_${n}c`, `swift test ${n}`, `t${n}c`, start + 6),
    result(`toolu_${n}c`, "passed", `r${n}c`, start + 7),
    progress(`Merged ${n}.`, `p${n}b`, start + 8),
  ];
  if (ends) lines.push(reply(`Both show now (${n}).${filler}`, `a${n}`, start + 9, true));
  return lines;
}

function rows(turn: ChatTurn): string[] {
  return turnRows(turn).map((row) => {
    if (row.type === "folded") {
      const id = row.folded.id.startsWith(turn.id + "/") ? "turn" + row.folded.id.slice(turn.id.length) : row.folded.id;
      return `fold:${id}=${row.folded.summary}`;
    }
    const item = row.item;
    switch (item.type) {
      case "user":
        return "user";
      case "toolCall":
        return "tool:" + item.value.id;
      case "progress":
        return "progress:" + item.value.id;
      case "agentText":
        return "agent:" + item.value.id;
      case "notice":
        return "notice:" + item.value.id;
      case "agents":
        return "agents:" + item.value.id;
      case "agentMessage":
        return "agentMessage:" + item.value.id;
    }
  });
}

describe("the timeline", () => {
  it("shows each progress row between its tool rows in a running turn", () => {
    const turn = runningTurn(timelineOf(turnLines(1, 0, false)).timeline)!;
    expect(rows(turn)).toEqual(["user", "tool:toolu_1a", "tool:toolu_1b", "progress:p1a", "tool:toolu_1c", "progress:p1b"]);
  });

  it("folds the calls on each side of an update apart in a finished turn", () => {
    const turn = timelineOf(turnLines()).timeline.turns[0]!;
    expect(turn.isFinished).toBe(true);
    expect(rows(turn)).toEqual([
      "user",
      "fold:turn/folded=Ran 2 commands",
      "progress:p1a",
      "fold:turn/folded/toolu_1c=Ran 1 command",
      "progress:p1b",
      "agent:a1",
    ]);
    const foldIDs = turnRows(turn).flatMap((row) => (row.type === "folded" ? [row.folded.id] : []));
    expect(foldIDs).toEqual([turn.id + "/folded", turn.id + "/folded/toolu_1c"]);
    expect(turnFoldSummary(turn)).toBe("Ran 3 commands");
    expect(turnFooter(turn)).not.toBeNull();
  });

  it("still folds a turn without updates into one line", () => {
    const turn = timelineOf([
      user("Go", "u1", 0),
      tool("toolu_1", "make a", "t1", 1),
      result("toolu_1", "ok", "r1", 2),
      reply("Halfway.", "a0", 3),
      tool("toolu_2", "make b", "t2", 4),
      result("toolu_2", "ok", "r2", 5),
      reply("Done.", "a1", 6, true),
    ]).timeline.turns[0]!;
    expect(rows(turn)).toEqual(["user", "fold:turn/folded=Ran 2 commands", "agent:a0", "agent:a1"]);
  });

  it("keeps a failed call open between updates", () => {
    const turn = timelineOf([
      user("Go", "u1", 0),
      tool("toolu_1", "make a", "t1", 1),
      result("toolu_1", "ok", "r1", 2),
      progress("Building next.", "p1", 3),
      tool("toolu_2", "make b", "t2", 4),
      json({
        isSidechain: false,
        sessionId: session,
        timestamp: stamp(5),
        type: "user",
        uuid: "r2",
        message: { content: [{ content: "Exit code 2\nerror", is_error: true, tool_use_id: "toolu_2", type: "tool_result" }], role: "user" },
      }),
      tool("toolu_3", "make c", "t3", 6),
      result("toolu_3", "ok", "r3", 7),
      reply("One step failed.", "a1", 8, true),
    ]).timeline.turns[0]!;
    expect(rows(turn)).toEqual(["user", "fold:turn/folded=Ran 1 command", "progress:p1", "tool:toolu_2", "fold:turn/folded/toolu_3=Ran 1 command", "agent:a1"]);
  });

  it("counts updates as output but never as the turn's end", () => {
    const { timeline } = timelineOf([user("Go", "u1", 0), progress("Looking.", "p1", 1)]);
    const turn = runningTurn(timeline)!;
    expect(turnHasAgentOutput(turn)).toBe(true);
    expect(turnFooter(endingRunningTurn(timeline).turns[0]!)).not.toBeNull();
  });
});

describe("Load earlier", () => {
  it("keeps updates in place at the seam", () => {
    const lines = [...turnLines(1, 0), ...turnLines(2, 20), ...turnLines(3, 40)];
    const split = lines.findIndex((value) => value.includes('"t2c"'));
    const newerParser = new TranscriptParser("claude");
    const newer = new ChatTimelineBuilder();
    lines.forEach((value, index) => {
      if (index >= split) newer.apply(newerParser.parse(value).events, index);
    });
    expect(newer.timeline.turns[0]!.isPartial).toBe(true);
    const olderParser = new TranscriptParser("claude");
    const older = new ChatTimelineBuilder(2_000);
    lines.forEach((value, index) => {
      if (index < split) older.apply(olderParser.parse(value).events, index);
    });
    newer.prepend(older);
    const all = whole(text(lines));
    expect(shape(newer.timeline)).toEqual(shape(all));
    expect(newer.timeline.turns.map(rows)).toEqual(all.turns.map(rows));
    expect(rows(newer.timeline.turns[1]!)).toEqual([
      "user",
      "fold:turn/folded=Ran 2 commands",
      "progress:p2a",
      "fold:turn/folded/toolu_2c=Ran 1 command",
      "progress:p2b",
      "agent:a2",
    ]);
  });

  it("keeps every update when loading earlier messages", async () => {
    const lines: string[] = [];
    for (let n = 1; n <= 60; n += 1) lines.push(...turnLines(n, (n * 10) % 3_000, true, 90_000));
    const content = text(lines);
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(firstLoadWindow);
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, content, claudePath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5, earlierStepBytes: 256 * 1_024, earlierChunkBytes: 64 * 1_024 });
    feed.start(claudeSession);
    await eventually(() => feed.state.status === "live");
    let timeline = feed.timeline;
    expect(timeline.earlier).toBe("available");
    let loads = 0;
    while (timeline.earlier === "available" && loads < 40) {
      await feed.loadEarlier();
      loads += 1;
      timeline = feed.timeline;
    }
    expect(timeline.earlier).toBe("none");
    expect(loads).toBeGreaterThan(1);
    const all = whole(content);
    expect(shape(timeline)).toEqual(shape(all));
    expect(timeline.turns.map(rows)).toEqual(all.turns.map(rows));
    expect(timeline.turns.flatMap((turn) => turn.items).filter((item) => item.type === "progress").length).toBe(120);
    feed.stop();
  }, 60_000);
});
