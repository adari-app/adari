// Qwen Code's session file in Chat. The fixture is synthetic, built from qwen-code d32faa2's
// ChatRecord (packages/core/src/services/chatRecordingService.ts:413-625: `uuid`, `parentUuid`, `sessionId`,
// `timestamp`, `type`, `subtype`, `cwd`, `version`, `message` (Content), `toolCallResult`, `systemPayload`,
// `isSidechain`), read as its own resume reads it (packages/cli/src/ui/utils/resumeHistoryUtils.ts:292-665;
// the `turn_result` record, chatRecordingService.ts:1076-1095).

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed } from "../src/shared/chat/feed";
import { makeSessionRef } from "../src/shared/chat/locator";
import { noticeText, turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { eventually, FakeTranscriptReader, shown } from "./support/chat-lines";

const sessionID = "3d9a7c1b-2e4f-4a6b-8c0d-1e2f3a4b5c6d";
const folder = "/Users/fixture/proj";
const qwenPath = `/Users/fixture/.qwen/projects/-Users-fixture-proj/chats/${sessionID}.jsonl`;
const ref = makeSessionRef("qwen", { kind: "id", id: sessionID })!;
const at = (second: number): string => new Date(Date.UTC(2026, 10, 1, 3, 0, second)).toISOString();

let previous: string | null = null;
function record(uuid: string, type: string, second: number, extra: Record<string, unknown> = {}): string {
  const line = JSON.stringify({ uuid, parentUuid: previous, sessionId: sessionID, timestamp: at(second), type, cwd: folder, version: "0.9.0", ...extra });
  previous = uuid;
  return line;
}
const parts = (role: string, ...list: unknown[]): { message: unknown } => ({ message: { role, parts: list } });
const call = (id: string, name: string, args: Record<string, unknown>): unknown => ({ functionCall: { id, name, args } });
const response = (id: string, name: string, output: string): unknown => ({ functionResponse: { id, name, response: { output } } });

const fixtureLines = [
  record("r1", "user", 1, parts("user", { text: "Read src/app.ts and fix the bug" })),
  record("r2", "assistant", 2, parts("model", { text: "Planning the read", thought: true }, { text: "Let me read it." }, call("call_1", "read_file", { absolute_path: "/Users/fixture/proj/src/app.ts" }))),
  record("r3", "tool_result", 3, {
    ...parts("user", response("call_1", "read_file", "export const a = 1;")),
    toolCallResult: { callId: "call_1", status: "success", resultDisplay: "Read 40 lines", responseParts: [response("call_1", "read_file", "export const a = 1;")] },
  }),
  record("r4", "assistant", 4, parts("model", call("call_2", "edit", { file_path: "/Users/fixture/proj/src/app.ts", old_string: "a = 1", new_string: "a = 2" }))),
  record("r5", "tool_result", 5, { toolCallResult: { callId: "call_2", status: "error", error: { message: "old_string not found" } } }),
  record("r6", "assistant", 6, parts("model", { text: "Fixed the bug in src/app.ts." })),
  record("r7", "system", 7, { subtype: "custom_title", systemPayload: { customTitle: "Fix app bug", titleSource: "auto" } }),
  record("r8", "system", 10, { subtype: "at_command", systemPayload: { userText: "@src/app.ts what does it export?" } }),
  record("r9", "user", 10, parts("user", { text: "--- Content from referenced files ---\nexport const a = 2;" })),
  record("r10", "assistant", 11, parts("model", call("call_3", "run_shell_command", { command: "npm test" }))),
  record("r11", "user", 12, { subtype: "mid_turn_user_message", systemPayload: { displayText: "also check the tests" }, ...parts("user", { text: "also check the tests" }) }),
  record("r12", "tool_result", 13, { toolCallResult: { callId: "call_3", status: "cancelled" } }),
  record("r13", "system", 13, { subtype: "turn_result", systemPayload: { state: "cancelled" } }),
  record("r14", "user", 20, parts("user", { text: "What is in this picture?" }, { inlineData: { mimeType: "image/jpeg", data: "/9j/" + "Q".repeat(3_000) } })),
  record("r15", "assistant", 21, { ...parts("model", { text: "A subagent's own reply." }), isSidechain: true }),
  record("r16", "assistant", 21, parts("model", { text: "A diagram of the build." })),
  record("r17", "system", 22, { subtype: "chat_compression", systemPayload: { info: { originalTokenCount: 9000, newTokenCount: 1200 } } }),
  record("r18", "user", 23, { subtype: "notification", ...parts("user", { text: "Background task finished." }) }),
  record("r6", "assistant", 6, parts("model", { text: "Fixed the bug in src/app.ts." })),
  record("r19", "future_kind", 24, { payload: "A record of a later version." }),
  record("r20", "system", 25, { subtype: "slash_command", systemPayload: { command: "/stats" } }),
  '{"uuid":"r21","type":"assistant","message":{"role":"model","parts":[{"text":"cut',
];

function timeline(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats; cwd: string | null } {
  const parser = new TranscriptParser("qwen");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    builder.apply(parser.parse(line, offset).events, offset);
    offset += new TextEncoder().encode(line).length + 1;
  }
  return { timeline: builder.timeline, stats: parser.stats, cwd: parser.cwd };
}

describe("qwen session: the synthetic fixture (chatRecordingService.ts:413-625)", () => {
  const { timeline: built, stats, cwd } = timeline(fixtureLines);

  it("shows the user's prompts as typed (an @ command's own text), a message sent mid-turn, and not other users' records", () => {
    expect(shown(built).filter((entry) => entry.startsWith("user:"))).toEqual([
      "user:Read src/app.ts and fix the bug",
      "user:@src/app.ts what does it export?",
      "user:also check the tests",
      "user:What is in this picture?",
    ]);
    expect(shown(built).some((entry) => entry.includes("Background task finished"))).toBe(false);
  });

  it("shows the reply text (thoughts and a subagent's records never), each record once", () => {
    expect(shown(built).filter((entry) => entry.startsWith("agent:"))).toEqual(["agent:Let me read it.", "agent:Fixed the bug in src/app.ts.", "agent:A diagram of the build."]);
  });

  it("maps calls to rows and finishes them from tool_result records", () => {
    const calls = turnToolCalls(built.turns[0]!);
    expect(calls.map((value) => [value.id, value.kind, value.target, value.state])).toEqual([
      ["call_1", "read", "/Users/fixture/proj/src/app.ts", "ok"],
      ["call_2", "edit", "/Users/fixture/proj/src/app.ts", "failed"],
    ]);
    expect(calls[1]?.detail.type).toBe("diff");
    const shell = turnToolCalls(built.turns[1]!)[0];
    expect(shell).toMatchObject({ kind: "bash", target: "npm test", state: "failed" });
  });

  it("ends a turn on a reply with no call and on a cancelled turn_result", () => {
    expect(built.turns[0]?.isFinished).toBe(true);
    expect(shown({ ...built, turns: [built.turns[1]!] }).at(-1)).toBe("notice:" + noticeText("interrupted"));
    expect(built.turns[1]?.isFinished).toBe(true);
  });

  it("keeps a picture's type, never its bytes; the compression and the AI title show", () => {
    expect(turnUserMessage(built.turns[2]!)?.attachments).toEqual([{ path: null, mediaType: "image/jpeg" }]);
    expect(JSON.stringify(built)).not.toContain("QQQQ");
    expect(shown(built)).toContain("notice:" + noticeText("compacted"));
    expect(built.title).toBe("Fix app bug");
  });

  it("gives the records' folder, counts a later version's record as unknown and a cut last line as malformed", () => {
    expect(cwd).toBe(folder);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ future_kind: 1 });
    expect(stats.malformed).toBe(1);
    for (const skipped of ["sidechain", "notification", "at_command", "slash_command"]) expect(stats.skippedTypes.has(skipped), skipped).toBe(true);
  });
});

describe("qwen session: the feed", () => {
  const lines = (rows: readonly string[]): string => rows.join("\n") + "\n";

  it("follows the file as it grows; a partial last line waits for its end", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(qwenPath, lines(fixtureLines.slice(0, 2)), qwenPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    const next = new TextEncoder().encode(record("g1", "assistant", 3, parts("model", { text: "Grown." })) + "\n");
    reader.appendBytes(qwenPath, next.slice(0, 30));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(shown(feed.timeline).at(-1)).toBe("tool:/Users/fixture/proj/src/app.ts");
    reader.appendBytes(qwenPath, next.slice(30));
    expect(await eventually(() => shown(feed.timeline).at(-1) === "agent:Grown.")).toBe(true);
    feed.stop();
  });

  it("never shows a session whose records name another folder (sessionMismatch)", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(qwenPath, lines(fixtureLines), qwenPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, ["/Users/fixture/other"]);
    expect(await eventually(() => feed.state.status === "unavailable")).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });

  it("drops an oversized line and starts over on a replaced file", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(qwenPath, lines(fixtureLines.slice(0, 2)), qwenPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 1 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.timeline.turns.length === 1)).toBe(true);
    reader.append(qwenPath, record("big", "assistant", 4, parts("model", { text: "y".repeat(9 * 1_024 * 1_024) })) + "\n" + record("after", "user", 5, parts("user", { text: "After the long line" })) + "\n");
    expect(await eventually(() => feed.timeline.turns.length === 2, 20_000)).toBe(true);
    expect(shown(feed.timeline).some((entry) => entry.startsWith("agent:yyyy"))).toBe(false);
    reader.put(qwenPath, lines([record("n1", "user", 50, parts("user", { text: "fresh start" }))]), qwenPath);
    expect(await eventually(() => feed.timeline.turns.length === 1 && turnUserMessage(feed.timeline.turns[0]!)?.text === "fresh start")).toBe(true);
    feed.stop();
  }, 30_000);
});
