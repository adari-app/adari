// A message the user sent while Claude
// worked, as Claude Code 2.1.31x writes it now: a `queue-operation` enqueue
// (with the text) and dequeue (without), then, after the turn ends, a `user`
// line with `promptSource: "queued"`, `origin.kind: "human"` and `turnOrigin:
// "human"` (no `queued_command` attachment). It is their message: shown at its
// place once, and the pending bubble for it clears. Lines another session or
// the harness queued stay the harness's. Hand-built in Claude Code's
// shapes, invented ids and times.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { lineAuthor } from "../src/shared/chat/claude-parser";
import { turnFooter, turnRows, workedForText, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { PendingMessages, userMessages } from "../src/shared/chat/pending";
import { at, json, queued, reply, result, session, shown, stamp, timelineOf, tool, user } from "./support/chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

const typedFields: Record<string, JSONValue> = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, permissionMode: "auto" };
const queuedFields: Record<string, JSONValue> = {
  promptSource: "queued",
  turnOrigin: "human",
  origin: { kind: "human" },
  permissionMode: "auto",
  turnPosition: { index: 1 },
};

const enqueue = (text: string, second: number): string =>
  json({ type: "queue-operation", operation: "enqueue", timestamp: stamp(second), sessionId: session, content: text });
const dequeue = (second: number): string => json({ type: "queue-operation", operation: "dequeue", timestamp: stamp(second), sessionId: session });
const system = (subtype: string, uuid: string, second: number): string =>
  json({ type: "system", subtype, uuid, timestamp: stamp(second), sessionId: session, isSidechain: false, isMeta: false });

const sent = "it works esc and sending me down";

/** The user sends "h"; nine seconds on, while that turn runs, they send `sent`; the turn ends; Claude Code writes the queued line. */
const lines = [
  user("h", "u1", 0, typedFields),
  reply("Working on h.", "a1", 2),
  enqueue(sent, 9),
  reply("Done with h.", "a2", 9, true),
  dequeue(10),
  system("stop_hook_summary", "s1", 10),
  system("turn_duration", "s2", 10),
  user(sent, "u2", 10, queuedFields),
  reply("Glad it works.", "a3", 12, true),
];

describe("a queued message is the user's", () => {
  it("reads promptSource queued with a human origin or turnOrigin as typed", () => {
    expect(lineAuthor(queuedFields as never)).toBe("typed");
    expect(lineAuthor({ promptSource: "queued", origin: { kind: "human" } })).toBe("typed");
    expect(lineAuthor({ promptSource: "queued", turnOrigin: "human" })).toBe("typed");
  });

  it("keeps the harness's queued lines the harness's", () => {
    expect(lineAuthor({ promptSource: "queued", origin: { kind: "peer" }, turnOrigin: "peer" })).toBe("harness");
    expect(lineAuthor({ promptSource: "queued", turnOrigin: "system" })).toBe("harness");
    expect(lineAuthor({ promptSource: "queued", origin: { kind: "human" }, turnOrigin: "peer" })).toBe("harness");
    expect(lineAuthor({ promptSource: "queued" })).toBe("harness");
    expect(lineAuthor({ ...queuedFields, isMeta: true } as never)).toBe("harness");
    expect(lineAuthor({ ...queuedFields, commandMode: "task-notification" } as never)).toBe("harness");
  });

  it("shows it at its place once, the transcript read cold (reload)", () => {
    const { timeline, stats } = timelineOf(lines);
    expect(shown(timeline)).toEqual(["user:h", "agent:Working on h.", "agent:Done with h.", `user:${sent}`, "agent:Glad it works."]);
    expect(timeline.turns.length).toBe(2);
    expect(stats.skippedTypes.get("queue-operation")).toBe(2);
  });

  it("does not show a queued line from another session, nor the harness's", () => {
    const peer = user("A note from another session", "m1", 10, {
      promptSource: "queued",
      turnOrigin: "peer",
      origin: { kind: "peer", from: "uds:/tmp/cc-socks/41.sock" },
    });
    const meta = user("Context for the agent", "m2", 11, { ...queuedFields, isMeta: true });
    const notified = user("Background task finished", "m3", 12, { ...queuedFields, commandMode: "task-notification" });
    expect(userMessages(timelineOf([user("h", "u1", 0, typedFields), peer, meta, notified]).timeline).map((message) => message.text)).toEqual(["h"]);
  });

  it("shows it once when it is written both as a queued_command attachment and as the queued user line", () => {
    const { timeline, stats } = timelineOf([
      user("h", "u1", 0, typedFields),
      reply("Working on h.", "a1", 2),
      queued(sent, "q1", "u2", 9),
      reply("Done with h.", "a2", 9, true),
      user(sent, "u2", 10, queuedFields),
    ]);
    expect(userMessages(timeline).map((message) => message.text)).toEqual(["h", sent]);
    expect(stats.skippedTypes.get("user/queued-twice")).toBe(1);
  });

  it("clears its pending bubble when the lines arrive (live)", () => {
    const key = "host/w1:p1";
    const store = new PendingMessages();
    const before = lines.slice(0, 2);
    store.observe(key, timelineOf(before).timeline);
    store.add(key, sent, at(9) * 1_000);
    expect(store.forPane(key).length).toBe(1);
    // The enqueue and the turn's end: nothing of the user's yet, the bubble stays.
    store.observe(key, timelineOf(lines.slice(0, 7)).timeline);
    expect(store.forPane(key).length).toBe(1);
    store.observe(key, timelineOf(lines).timeline);
    expect(store.forPane(key)).toEqual([]);
  });
});

// A second pane, the same cause: message 1, a command and a reply;
// message 2 sent while that turn ran; then a command and a reply to message 2.
// The chat is the two turns the user would see had they typed both: each bubble
// at its place, each turn's command row, one "Worked for" per turn, the replies;
// no pending bubble left, no doubled or adjacent "Worked for".
describe("a message sent while a turn runs: the whole timeline", () => {
  const second = "and the footer too";
  const measured = (sec: number, ms: number): string =>
    json({ type: "system", subtype: "turn_duration", durationMs: ms, uuid: `sys-${sec}`, timestamp: stamp(sec), sessionId: session, isSidechain: false, isMeta: false });
  const firstTurn = [user("check the header", "u1", 0, typedFields), tool("toolu_1", "swift test", "a1", 2)];
  const queuedLines = [
    ...firstTurn,
    enqueue(second, 20),
    result("toolu_1", "Executed 12 tests", "r1", 25),
    reply("The header is fine.", "a2", 30, true),
    dequeue(30),
    system("stop_hook_summary", "s1", 30),
    measured(30, 30_000),
    user(second, "u2", 30, queuedFields),
    tool("toolu_2", "swift build", "a3", 32),
    result("toolu_2", "Build complete", "r2", 40),
    reply("The footer is fine too.", "a4", 46, true),
    system("stop_hook_summary", "s2", 46),
    measured(46, 16_000),
  ];
  const typedLines = [
    ...firstTurn,
    result("toolu_1", "Executed 12 tests", "r1", 25),
    reply("The header is fine.", "a2", 30, true),
    system("stop_hook_summary", "s1", 30),
    measured(30, 30_000),
    user(second, "u2", 30, typedFields),
    tool("toolu_2", "swift build", "a3", 32),
    result("toolu_2", "Build complete", "r2", 40),
    reply("The footer is fine too.", "a4", 46, true),
    system("stop_hook_summary", "s2", 46),
    measured(46, 16_000),
  ];

  /** Every row Chat draws, turn by turn, each finished turn's "Worked for" last. */
  const rows = (timeline: ChatTimeline): string[] =>
    timeline.turns.flatMap((turn) => {
      const drawn = turnRows(turn).map((row) => {
        if (row.type === "folded") return "folded:" + row.folded.summary;
        const item = row.item;
        if (item.type === "user") return "user:" + item.value.text;
        if (item.type === "agentText") return "agent:" + item.value.markdown;
        return item.type;
      });
      const footer = turnFooter(turn);
      return footer === null ? drawn : [...drawn, workedForText(footer)];
    });

  const expected = [
    "user:check the header",
    "folded:Ran 1 command",
    "agent:The header is fine.",
    "Worked for 30s",
    "user:and the footer too",
    "folded:Ran 1 command",
    "agent:The footer is fine too.",
    "Worked for 16s",
  ];

  const noAdjacentWorkedFor = (drawn: readonly string[]): void => {
    for (let index = 1; index < drawn.length; index += 1) {
      expect(drawn[index - 1]!.startsWith("Worked for") && drawn[index]!.startsWith("Worked for")).toBe(false);
    }
  };

  it("reads the same two turns as when both are typed, cold", () => {
    const typedRows = rows(timelineOf(typedLines).timeline);
    expect(typedRows).toEqual(expected);
    const queuedRows = rows(timelineOf(queuedLines).timeline);
    expect(queuedRows).toEqual(typedRows);
    noAdjacentWorkedFor(queuedRows);
  });

  it("reads the same live, line by line, and leaves no pending bubble", () => {
    const key = "host/w1:p2";
    const store = new PendingMessages();
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    queuedLines.forEach((line, index) => {
      builder.apply(parser.parseText(line));
      store.observe(key, builder.timeline);
      // The user sends message 2 while the first command runs (before the enqueue line).
      if (index === firstTurn.length - 1) store.add(key, second, at(19) * 1_000);
      noAdjacentWorkedFor(rows(builder.timeline));
    });
    expect(rows(builder.timeline)).toEqual(expected);
    expect(store.forPane(key)).toEqual([]);
  });
});
