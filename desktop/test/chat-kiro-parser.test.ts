// A Kiro CLI V3 session's messages.jsonl in Chat (agents/kiro-parser.ts). Kiro CLI is closed source;
// the fixtures are synthetic, built only from its public readers: codeburn's V3 fixture builder (getagentseal/codeburn
// bb952552 tests/providers/kiro.test.ts:1095-1137: `{id, timestamp, payload}` lines, session.json with
// `schemaVersion: '1.0.0'`, `dataModelVersion: 1`, `workspacePaths`) and its parser (src/providers/kiro.ts:686-870),
// and kiro-cli-history's demo session (mxmehl/kiro-cli-history f96f9f05
// demo/data/kiro/sessions/workspacehash/sess_cfbd0cbbe482/{session.json,messages.jsonl}; main.py:303-437).

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { shown } from "./support/chat-lines";

const line = (id: string | null, timestamp: string | null, payload: Record<string, unknown>): string =>
  JSON.stringify({ ...(id === null ? {} : { id }), ...(timestamp === null ? {} : { timestamp }), payload });
const at = "2026-11-08T10:00:00.000Z";

/** codeburn's shape (kiro.test.ts:1095-1115): one turn with reasoning, a call and its result, the bookkeeping lines. */
const kiroTurn = (exec: string, user: string, say: string, options: { readonly tool?: string; readonly result?: string; readonly success?: boolean; readonly resultID?: string } = {}): string[] => [
  line(`${exec}-u`, at, { type: "user", content: user, images: [], documents: [] }),
  line(`${exec}-ts`, at, { type: "turn_start", executionId: exec }),
  line(`${exec}-r`, at, { type: "assistant", operationType: "Reasoning", content: "thinking it over", executionId: exec }),
  line(`${exec}-a`, at, { type: "assistant", operationType: "Say", content: say, executionId: exec }),
  ...(options.tool === undefined
    ? []
    : [
        line(`${exec}-tc`, at, { type: "tool_call", toolName: options.tool, toolCallId: `${exec}-${options.tool}`, executionId: exec }),
        line(`${exec}-tr0`, at, { type: "tool_result", toolCallId: options.resultID ?? `${exec}-${options.tool}`, content: options.result ?? "done", success: options.success ?? true, executionId: exec }),
      ]),
  line(`${exec}-cm`, at, { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 12.5 }, executionId: exec }),
  line(`${exec}-us`, at, { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 1, usedTools: options.tool === undefined ? [] : [options.tool] }], status: "success", executionId: exec }),
  line(`${exec}-te`, at, { type: "turn_end", stopReason: "end_turn", executionId: exec }),
];
const kiroStart = line("sess-start", at, { type: "session_start", agentType: "vibe" });

function timeline(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats; parser: TranscriptParser } {
  const parser = new TranscriptParser("kiro");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const text of lines) {
    builder.apply(parser.parse(text, offset).events, offset);
    offset += new TextEncoder().encode(text).length + 1;
  }
  return { timeline: builder.timeline, stats: parser.stats, parser };
}

describe("kiro V3 messages.jsonl: codeburn's shape", () => {
  const lines = [
    kiroStart,
    ...kiroTurn("e1", "List the files", "Here they are.", { tool: "readFile", result: "a.ts\nb.ts" }),
    ...kiroTurn("e2", "Run the tests", "They fail.", { tool: "executeBash", result: "1 failed", success: false }),
    ...kiroTurn("e3", "Thanks", "You're welcome."),
  ];
  const { timeline: built, stats } = timeline(lines);

  it("shows the user's messages, the agent's Say text (not its reasoning) and a row per call, turn by turn", () => {
    expect(shown(built)).toEqual(["user:List the files", "agent:Here they are.", "tool:", "user:Run the tests", "agent:They fail.", "tool:", "user:Thanks", "agent:You're welcome."]);
    expect(built.turns.map((turn) => turn.isFinished)).toEqual([true, true, true]);
    expect(turnUserMessage(built.turns[0]!)?.time).toBe(Date.parse(at) / 1_000);
  });

  it("names a row by its tool and finishes it with the result of exactly its id; success false is a failure", () => {
    // No reader shows a call's arguments: no read, edit or command row is made of its name (no target to show).
    expect(turnToolCalls(built.turns[0]!)[0]).toMatchObject({ toolName: "readFile", kind: { other: "readFile" }, target: "", state: "ok" });
    expect(turnToolCalls(built.turns[1]!)[0]).toMatchObject({ toolName: "executeBash", kind: { other: "executeBash" }, state: "failed", resultSummary: "failed" });
  });

  it("skips the bookkeeping lines and the reasoning; nothing is unknown", () => {
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({});
    for (const type of ["session_start", "turn_start", "session_metadata", "usage_summary", "assistant:Reasoning"]) expect(stats.skippedTypes.has(type), type).toBe(true);
  });

  it("carries no folder of its own: the session.json's, carried in, is the folder", () => {
    const { parser } = timeline(lines);
    expect(parser.cwd).toBeNull();
    parser.carryFolder("/Users/fixture/proj");
    expect(parser.cwd).toBe("/Users/fixture/proj");
    expect(parser.clone().cwd).toBe("/Users/fixture/proj");
  });
});

describe("kiro V3 messages.jsonl: the edges", () => {
  it("never gives a result to another call: one whose id matches no call read leaves the calls running", () => {
    const { timeline: built } = timeline([kiroStart, ...kiroTurn("e1", "Go", "On it.", { tool: "readFile", resultID: "someone-else" })]);
    expect(turnToolCalls(built.turns[0]!).map((call) => call.state)).toEqual(["running"]);
  });

  it("a result whose call is not read shows on no row (it waits for an earlier load's call, by its id)", () => {
    const { timeline: built } = timeline([
      line("u", at, { type: "user", content: "Go" }),
      line("c0", at, { type: "tool_call", toolName: "grep", toolCallId: "c0" }),
      line("r", at, { type: "tool_result", toolCallId: "c1", content: "out", success: true }),
    ]);
    expect(turnToolCalls(built.turns[0]!).map((call) => [call.toolName, call.state])).toEqual([["grep", "running"]]);
  });

  it("reads kiro-cli-history's demo lines (payload only, no ids): text, a call, the usage line", () => {
    // demo/data/kiro/sessions/workspacehash/sess_cfbd0cbbe482/messages.jsonl:1-7 (shortened texts).
    const demo = [
      JSON.stringify({ payload: { type: "user", content: "I have a FastAPI app that I want to deploy to ECS Fargate." } }),
      JSON.stringify({ payload: { type: "assistant", content: "Sure! Let me look at your project structure first." } }),
      JSON.stringify({ payload: { type: "tool_call", toolName: "tools: fs_read" } }),
      JSON.stringify({ payload: { type: "assistant", content: "I can see your FastAPI app with a Dockerfile." } }),
      JSON.stringify({ payload: { type: "user", content: "Sounds good." } }),
      JSON.stringify({ payload: { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", usage: 1.25 }] } }),
    ];
    const { timeline: built, stats } = timeline(demo);
    expect(shown(built)).toEqual([
      "user:I have a FastAPI app that I want to deploy to ECS Fargate.",
      "agent:Sure! Let me look at your project structure first.",
      "tool:",
      "agent:I can see your FastAPI app with a Dockerfile.",
      "user:Sounds good.",
    ]);
    expect(turnToolCalls(built.turns[0]!)[0]?.toolName).toBe("tools: fs_read");
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({});
  });

  it("skips a line whose id was read already", () => {
    const user = line("u1", at, { type: "user", content: "Once" });
    const { timeline: built, stats } = timeline([user, user]);
    expect(shown(built)).toEqual(["user:Once"]);
    expect(stats.skippedTypes.has("user")).toBe(true);
  });

  it("counts what it does not know as unknown, never shown: another type, another operation, no payload, a text that is not a string", () => {
    const { timeline: built, stats } = timeline([
      line("a", at, { type: "user", content: "Hello" }),
      line("b", at, { type: "compaction_summary", content: "a later version's line" }),
      line("c", at, { type: "assistant", operationType: "Plan", content: "a plan" }),
      JSON.stringify({ kind: "Prompt", data: { content: [{ kind: "text", data: "2.x classic line" }] } }),
      line("d", at, { type: "user", content: [{ type: "text", text: "blocks" }] }),
      line("e", at, { type: "tool_result", content: "no id" }),
      '{"id":"f","payload":{"type":"user","content":"cut',
    ]);
    expect(shown(built)).toEqual(["user:Hello"]);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ compaction_summary: 1, "assistant:Plan": 1, "(no payload)": 1, "user:content": 1, "tool_result:toolCallId": 1 });
    expect(stats.malformed).toBe(1);
  });
});
