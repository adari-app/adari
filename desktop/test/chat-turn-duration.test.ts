// A port of HerdrKit's ChatTurnDurationTests.swift: a turn with a message sent
// while the agent worked reads its real length, never "Worked for 0s". Claude
// Code 2.1.316's lines around such a turn, as fixtures (never a real
// transcript). The trap: the message's own user line keeps the blank lines
// before the paste, so it is not the queued copy's text verbatim; unless the two
// are joined, it opens a second turn holding only the last reply, both at 200,
// and the turn_duration line goes unread.

import { describe, expect, it } from "vitest";

import { turnFooter, workedForText } from "../src/shared/chat/model";
import { json, queued, reply, result, session, shown, stamp, timelineOf, tool, user } from "./support/chat-lines";
import { tonight, tonightText } from "./support/pasted-tonight";

const userContent = `\n\n${tonight}`;

const system = (subtype: string, second: number, extra: Record<string, number> = {}): string =>
  json({ type: "system", subtype, timestamp: stamp(second), uuid: `sys-${subtype}-${second}`, sessionId: session, isSidechain: false, isMeta: false, level: "info", ...extra });

const queueOperation = (operation: string, second: number): string =>
  json({ type: "queue-operation", operation, content: userContent, timestamp: stamp(second), sessionId: session });

const requestBlob = (toolID: string): string =>
  json({
    type: "api-request-blob",
    sessionId: session,
    hash: "9c1f0e",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolID, content: "Executed 12 tests" },
        { type: "text", text: `The user sent a new message while you were working:\n${tonightText}\n\nIMPORTANT: ...` },
      ],
    },
  });

const imageNote = (uuid: string, second: number): string =>
  user("[Image: original 2032x1072, displayed at 2000x1055. Multiply coordinates by 1.02 to map them.]", uuid, second, { isMeta: true });

const tonightsTurn = (): string[] => [
  user("Make the chat scroll smooth", "u-open", 0),
  tool("toolu_1", "swift test", "a-1", 2),
  queueOperation("enqueue", 30),
  imageNote("meta-1", 30),
  queueOperation("remove", 90),
  queued(tonight, "q-713e", null, 90),
  result("toolu_1", "Executed 12 tests", "r-1", 90),
  requestBlob("toolu_1"),
  imageNote("meta-2", 91),
  tool("toolu_2", "swift build", "a-2", 95),
  result("toolu_2", "Build complete", "r-2", 180),
  user(userContent, "u-713e", 200),
  reply("It is the Mac build; the scroll is smooth now.", "a-3", 200, true),
  system("stop_hook_summary", 200, { hookCount: 1 }),
  system("turn_duration", 200, { durationMs: 200_189, messageCount: 14 }),
];

const footers = (lines: readonly string[]): (string | null)[] =>
  timelineOf(lines).timeline.turns.map((turn) => {
    const footer = turnFooter(turn);
    return footer === null ? null : workedForText(footer);
  });

describe("a turn's Worked for", () => {
  it("reads a turn with a message sent while it worked at its real length", () => {
    const { timeline, stats } = timelineOf(tonightsTurn());
    expect(stats.unknown).toBe(0);
    expect(footers(tonightsTurn())).toEqual(["Worked for 3m 20s"]);
    expect(turnFooter(timeline.turns[0]!)!.duration).toBeCloseTo(200.189, 3);
    expect(shown(timeline)).toEqual([
      "user:Make the chat scroll smooth",
      "tool:swift test",
      `user:${tonightText}`,
      "tool:swift build",
      "agent:It is the Mac build; the scroll is smooth now.",
    ]);
  });

  it("is first message to last line without a turn_duration line", () => {
    const lines = tonightsTurn().filter((line) => !line.includes('"turn_duration"'));
    const { timeline } = timelineOf(lines);
    expect(timeline.turns).toHaveLength(1);
    expect(turnFooter(timeline.turns[0]!)!.duration).toBeCloseTo(200, 3);
  });

  it("never shows, starts or ends a turn on the other lines", () => {
    const running = [...tonightsTurn().slice(0, 11), system("stop_hook_summary", 181), system("turn_duration", 181, { durationMs: 181_000 })];
    const { timeline, stats } = timelineOf(running);
    expect(stats.unknown).toBe(0);
    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]!.isFinished).toBe(false);
    expect(shown(timeline)).toEqual(["user:Make the chat scroll smooth", "tool:swift test", `user:${tonightText}`, "tool:swift build"]);
  });

  it("gives the measure to the turn it ends", () => {
    const lines = [...tonightsTurn(), user("now the phone", "u-next", 300), reply("Done.", "a-next", 312, true)];
    expect(footers(lines)).toEqual(["Worked for 3m 20s", "Worked for 12s"]);
  });
});
