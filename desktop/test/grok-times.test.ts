// Grok's times. Grok Build 1.0.70 writes each updates.jsonl
// line's `timestamp` in Unix seconds (10 digits) and `params._meta.agentTimestampMs`
// in milliseconds (13 digits); a running turn's lines carry `_meta.turnStartMs`
// (milliseconds) too. agentTimestampMs is read first; else `timestamp` by its size
// (below 100,000,000,000 seconds, at or above milliseconds). The twin of HerdrKit's
// GrokTimesTests; the fixture (desktop/fixtures/chat/grok-session-recorded.jsonl,
// the recorded shape with invented text) is shared with them.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { lineTime } from "../src/shared/away/readers";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { GrokSessionParser } from "../src/shared/chat/grok-parser";
import { turnFooter, turnUserMessage, workedForText, workingSince, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { workingLine } from "../src/renderer/chat/ChatView";
import { fixturesRoot } from "./support/swift-fixtures";

const recorded = readFileSync(path.join(fixturesRoot, "chat/grok-session-recorded.jsonl"), "utf8");
/** 2026-11-05T20:30:00Z, the fixture's first second. */
const base = 1_793_910_600;

function build(lines: readonly string[]): ChatTimeline {
  const parser = new TranscriptParser("grok");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    const at = offset;
    offset += new TextEncoder().encode(line).length + 1;
    builder.apply(parser.parse(line, at).events, at);
  }
  return builder.timeline;
}

const lines = recorded.split("\n").filter((line) => line !== "");

/** One Grok line: a user message chunk with the given `timestamp` and `_meta`. */
function grokLine(timestamp: unknown, meta: Record<string, unknown>): string {
  const object: Record<string, unknown> = {
    method: "session/update",
    params: { sessionId: "01a19e72-280e-7291-9d2d-8c2ac0bdb217", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hello" } }, _meta: meta },
  };
  if (timestamp !== undefined) object.timestamp = timestamp;
  return JSON.stringify(object);
}

function messageTime(line: string): number | null {
  const turn = build([line]).turns[0];
  return turn === undefined ? null : (turnUserMessage(turn)?.time ?? null);
}

describe("a Grok line's time", () => {
  it("reads agentTimestampMs first, else timestamp by its size; the recorded shape reads 2026, not 1970", () => {
    // Both fields, as recorded: agentTimestampMs (13 digits) wins over timestamp (10 digits).
    expect(messageTime(grokLine(base, { agentTimestampMs: base * 1_000 + 123 }))).toBeCloseTo(base + 0.123, 6);
    // Both fields disagreeing: still agentTimestampMs.
    expect(messageTime(grokLine(base + 50, { agentTimestampMs: base * 1_000 + 123 }))).toBeCloseTo(base + 0.123, 6);
    // 10 digits only: seconds.
    expect(messageTime(grokLine(base, {}))).toBe(base);
    // 13 digits only (the older fixtures' shape): milliseconds.
    expect(messageTime(grokLine(base * 1_000 + 250, {}))).toBeCloseTo(base + 0.25, 6);
    // Neither: no time.
    expect(messageTime(grokLine(undefined, {}))).toBeNull();
    expect(messageTime(grokLine("soon", {}))).toBeNull();
    // The size rule's edge: 99,999,999,999 is seconds, 100,000,000,000 milliseconds.
    expect(GrokSessionParser.time(99_999_999_999)).toBe(99_999_999_999);
    expect(GrokSessionParser.time(100_000_000_000)).toBe(100_000_000);
    expect(GrokSessionParser.time(0)).toBeNull();
    expect(GrokSessionParser.time(-5)).toBeNull();
  });

  it("dates the recorded session's messages, Worked for and the running turn's Working line from the real times", () => {
    const timeline = build(lines);
    expect(timeline.turns).toHaveLength(2);
    const [first, running] = timeline.turns as [NonNullable<ChatTimeline["turns"][number]>, NonNullable<ChatTimeline["turns"][number]>];
    // The user's messages' clock times.
    expect(turnUserMessage(first)?.time).toBeCloseTo(base + 0.123, 6);
    expect(turnUserMessage(running)?.time).toBeCloseTo(base + 60.321, 6);
    expect(new Date(turnUserMessage(first)!.time! * 1_000).toISOString()).toBe("2026-11-05T20:30:00.123Z");
    // Every item of both turns is dated inside the session (never 1970).
    for (const turn of timeline.turns) {
      expect(turn.startedAt).toBeGreaterThanOrEqual(base);
      expect(turn.lastEventAt).toBeLessThan(base + 120);
    }
    // Worked for: Grok's own measure (elapsed_ms), and an end in the session.
    expect(first.isFinished).toBe(true);
    expect(first.endedAt).toBeCloseTo(base + 10, 6);
    const footer = turnFooter(first);
    expect(footer === null ? null : workedForText(footer)).toBe("Worked for 10s");
    // The running turn (Grok waits on its approval): the Working line counts from the user's message.
    expect(running.isFinished).toBe(false);
    expect(workingSince(timeline)).toBeCloseTo(base + 60.321, 6);
    expect(workingLine(workingSince(timeline)!, base + 60.321 + 125, 0)).toBe("Working for 2m 5s");
  });

  it("a window that begins inside the running turn counts its Working line from the turn's start (turnStartMs)", () => {
    // Load earlier's seam: the window's first line is the running turn's thinking, after the user's message.
    const from = lines.findIndex((line) => line.includes('"promptIndex":1'));
    const window = build(lines.slice(from + 1));
    expect(window.turns).toHaveLength(1);
    expect(window.turns[0]!.isPartial).toBe(true);
    expect(workingSince(window)).toBeCloseTo(base + 60.35, 6);
    // The whole session, read whole: the user's message's time.
    expect(workingSince(build(lines))).toBeCloseTo(base + 60.321, 6);
    // Load earlier: the earlier lines then the window, as one read: still the user's message's time.
    expect(workingSince(build([...lines.slice(0, from + 1), ...lines.slice(from + 1)]))).toBeCloseTo(base + 60.321, 6);
  });

  it("Away's backward read dates a Grok line the same way", () => {
    expect(lineTime(lines[1]!)).toBeCloseTo(base + 0.123, 6);
    expect(lineTime(grokLine(base, {}))).toBe(base);
    expect(lineTime(grokLine(base * 1_000 + 250, {}))).toBeCloseTo(base + 0.25, 6);
    expect(lineTime(grokLine(base + 50, { agentTimestampMs: base * 1_000 + 123 }))).toBeCloseTo(base + 0.123, 6);
    // Claude Code and Codex: ISO.
    expect(lineTime(JSON.stringify({ type: "user", timestamp: "2026-11-05T20:30:00.250Z" }))).toBe(Date.parse("2026-11-05T20:30:00.250Z") / 1_000);
    expect(lineTime(JSON.stringify({ type: "user" }))).toBeNull();
  });
});
