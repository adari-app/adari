// Factory Droid's session file (`~/.factory/sessions/<folder name>/<id>.jsonl`) in Chat.
// Every fixture here is synthetic, built from the SDK's own types (Factory-AI/droid-sdk-python aa6fd94:
// the first line `{"type":"session_start","title","cwd","owner"}` and `{"type":"message"}` lines,
// src/droid_sdk/_high_level/discovery.py:132-148 and tests/test_v5_discovery.py:25-35; the message,
// FactoryDroidMessage with its content blocks, src/droid_sdk/schemas/messages.py:89-349, as Droid's
// create_message notification carries it, src/droid_sdk/schemas/cli.py:306-321; tool names and inputs
// from Factory-AI/factory 892925c docs/reference/hooks-reference.mdx). No real session was read.

import { describe, expect, it } from "vitest";

import { DroidSessionParser } from "../src/shared/chat/agents/droid-parser";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed, type ChatFeedState } from "../src/shared/chat/feed";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage, type ChatTimeline, type ChatTurn } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { at, eventually, FakeTranscriptReader, stamp } from "./support/chat-lines";

const sessionID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const folder = "/Users/fixture/proj";
const filePath = `/Users/fixture/.factory/sessions/-Users-fixture-proj/${sessionID}.jsonl`;
const ref: TranscriptSessionRef = makeSessionRef("droid", { kind: "id", id: sessionID })!;

const start = (cwd = folder): string => JSON.stringify({ type: "session_start", id: sessionID, title: "Fix the typo", cwd, owner: "fixture" });
type Block = Record<string, unknown>;
/** A `message` line: the FactoryDroidMessage under `message`, its time as createdAt (ms) or the line's timestamp. */
function message(id: string, role: string, content: Block[], second: number, extra: Record<string, unknown> = {}, lineTime = false): string {
  const inner = { id, role, content, createdAt: at(second) * 1_000, ...extra };
  return JSON.stringify({ type: "message", id: `line-${id}`, ...(lineTime ? { timestamp: stamp(second) } : {}), message: inner, parentId: null });
}
const text = (value: string): Block => ({ type: "text", text: value });
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
const result = (toolUseId: string, content: unknown, isError = false): Block => ({ type: "tool_result", toolUseId, content, ...(isError ? { isError: true } : {}) });

/** The synthetic Droid session "fix the typo": two turns, every row kind this reader shows. */
function typoSession(): string[] {
  const readme = `${folder}/README.md`;
  return [
    start(),
    // Turn 1: context Droid adds, the user's words; thinking, Read, Edit, a failing Execute, the answer.
    message("u1", "user", [text("<system-reminder>\nThe date is today.\n</system-reminder>"), text("Read the README and fix the typo")], 1, {}, true),
    message("a1", "assistant", [{ type: "thinking", thinking: "Looking at the README first.", signature: "sig" }, text("I'll read it."), use("t1", "Read", { file_path: readme })], 2),
    message("r1", "user", [result("t1", [text("# Proj\nTeh readme\n")])], 3),
    message("a2", "assistant", [use("t2", "Edit", { file_path: readme, old_str: "Teh", new_str: "The" })], 4),
    message("r2", "tool", [result("t2", "File edited")], 5),
    message("sys", "system", [text("You are Droid.")], 5),
    message("hidden", "user", [text("A note for the model only")], 5, { visibility: "llm_only" }),
    message("hook", "user", [text("hook output")], 5, { hookEventName: "PostToolUse" }),
    message("a3", "assistant", [use("t3", "Execute", { command: "npm test", riskLevel: "low" })], 6),
    message("r3", "user", [result("t3", "2 tests failing", true)], 7),
    message("a4", "assistant", [text("Fixed the typo; **two tests fail**.")], 8),
    JSON.stringify({ type: "todo_state", todos: [] }),
    // Turn 2: a picture and a document; a Task; an error reply ends it.
    message("u2", "user", [
      { type: "image", source: { type: "base64", data: "iVBORw0KGgo=", mediaType: "image/png" } },
      { type: "document", source: { type: "file", path: `${folder}/spec.pdf`, mediaType: "application/pdf" } },
      text("What is in this screenshot?"),
    ], 20),
    message("a5", "assistant", [use("t4", "Task", { description: "Explore tests", prompt: "Find the failing tests\nand report", subagent_type: "explore" })], 21),
    message("r4", "user", [result("t4", "Two snapshots are stale.")], 22),
    message("a6", "assistant", [text("The model is overloaded.")], 23, { isError: true }),
  ];
}

/** Line by line with offsets, as the feed reads it. */
function timeline(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("droid");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    const here = offset;
    offset += new TextEncoder().encode(line).length + 1;
    builder.apply(parser.parse(line, here).events, here);
  }
  return { timeline: builder.timeline, stats: parser.stats };
}

const texts = (turn: ChatTurn | undefined): string[] => (turn?.items ?? []).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));

describe("droid session file: the synthetic typo session", () => {
  it("messages: two turns, the user's words without Droid's context, the answers, each turn ended", () => {
    const { timeline: built, stats } = timeline(typoSession());
    expect(built.turns).toHaveLength(2);
    expect(built.turns.map((turn) => turnUserMessage(turn)?.text)).toEqual(["Read the README and fix the typo", "What is in this screenshot?"]);
    expect(built.turns.every((turn) => turn.isFinished)).toBe(true);
    expect(texts(built.turns[0]), "no system, model-only or hook message").toEqual(["I'll read it.", "Fixed the typo; **two tests fail**."]);
    expect(built.turns[0]!.items.filter((item) => item.type === "user")).toHaveLength(1);
    const thinking = built.turns[0]!.items.flatMap((item) => (item.type === "progress" ? [item.value.markdown] : []));
    expect(thinking).toEqual(["Looking at the README first."]);
    expect(turnUserMessage(built.turns[0]!)?.time, "the line's timestamp").toBe(at(1));
    expect(turnUserMessage(built.turns[1]!)?.time, "createdAt in milliseconds").toBe(at(20));
    expect(stats.malformed).toBe(0);
    expect(stats.unknownTypes.size).toBe(0);
    for (const skipped of ["session_start", "todo_state", "message/system"]) expect(stats.skippedTypes.has(skipped), skipped).toBe(true);
  });

  it("tools: rows by kind, paired with their results by id", () => {
    const { timeline: built } = timeline(typoSession());
    const calls = turnToolCalls(built.turns[0]!);
    expect(calls.map((call) => call.id)).toEqual(["t1", "t2", "t3"]);
    expect(calls.map((call) => call.kind)).toEqual(["read", "edit", "bash"]);
    expect(calls.map((call) => call.state)).toEqual(["ok", "ok", "failed"]);
    expect(calls.map((call) => call.toolName)).toEqual(["Read", "Edit", "Execute"]);
    expect(calls[0]!.target).toBe(`${folder}/README.md`);
    expect(calls[1]!.detail.type, "an edit shows its diff (old_str and new_str)").toBe("diff");
    expect(calls[2]!.target).toBe("npm test");
    const bash = calls[2]!.detail;
    if (bash.type !== "bash") throw new Error(bash.type);
    expect(bash.bash.outputTail.join("\n")).toContain("2 tests failing");
    const task = turnToolCalls(built.turns[1]!);
    expect(task.map((call) => [call.kind, call.target, call.state, call.subagent === undefined])).toEqual([["agent", "Explore tests", "ok", true]]);
  });

  it("images: a picture is an attachment with its type; a document keeps its path", () => {
    const { timeline: built } = timeline(typoSession());
    expect(turnUserMessage(built.turns[1]!)?.attachments).toEqual([
      { path: null, mediaType: "image/png" },
      { path: `${folder}/spec.pdf`, mediaType: "application/pdf" },
    ]);
  });

  it("errors: a reply marked isError is shown as the agent's words and ends the turn", () => {
    const { timeline: built } = timeline(typoSession());
    expect(texts(built.turns[1])).toEqual(["The model is overloaded."]);
    expect(built.turns[1]!.isFinished).toBe(true);
  });

  it("the folder is the first line's cwd; a flat message line (role on the line) reads too", () => {
    const parser = new DroidSessionParser();
    parser.parse(start());
    parser.parse(start("/Users/fixture/later"));
    expect(parser.cwd).toBe(folder);
    const flat = JSON.stringify({ type: "message", id: "f1", role: "user", content: [text("flat line")], createdAt: at(3) });
    const events = parser.parse(flat).events;
    expect(events.map((event) => (event.type === "userMessage" ? [event.message.text, event.message.time] : null))).toEqual([["flat line", at(3)]]);
  });

  it("Droid's tool names map to the nearest row kind", () => {
    const call = (name: string, input: Record<string, unknown>) => DroidSessionParser.call("x", name, input, null);
    expect([call("Grep", { pattern: "TODO" }).kind, call("Glob", { patterns: ["*.ts"] }).kind]).toEqual(["search", "search"]);
    expect([call("Create", { file_path: "/p/new.ts", content: "a\n" }).kind, call("Create", { file_path: "/p/new.ts", content: "a\n" }).toolName]).toEqual(["edit", "Create"]);
    expect([call("FetchUrl", { url: "https://example.com" }).kind, call("FetchUrl", { url: "https://example.com" }).target]).toEqual(["web", "https://example.com"]);
    expect(call("LS", { directory_path: "/p" }).target).toBe("/p");
    expect(call("ApplyPatch", { input: "*** Begin Patch\n*** Update File: /p/a.ts\n@@\n-a\n+b\n*** End Patch" }).kind).toBe("edit");
  });

  it("unknown: a line that is not JSON is malformed; one with no type, or a message of no known shape, is unknown", () => {
    const { stats, timeline: built } = timeline([start(), "{not json", JSON.stringify({ role: "user" }), JSON.stringify({ type: "message", message: { role: "user", content: "a string" } }), message("u", "user", [text("still read")], 1)]);
    expect(stats.malformed).toBe(1);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ "(no type)": 1, message: 1 });
    expect(turnUserMessage(built.turns[0]!)?.text).toBe("still read");
    expect(timeline([start(), message("x", "narrator", [text("?")], 1)]).stats.unknownTypes.get("message/narrator")).toBe(1);
  });
});

describe("droid session file in the feed", () => {
  const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;

  it("an unknown version (messages of a shape this reader does not know) is the unrecognised-format note", async () => {
    const reader = new FakeTranscriptReader();
    const later = (id: string, said: string): string => JSON.stringify({ type: "message", message: { id, author: "user", parts: [{ kind: "text", value: said }] } });
    reader.put(filePath, [start(), later("1", "one"), later("2", "two"), later("3", "three")].join("\n") + "\n", filePath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => isUnavailable(feed.state, "unrecognisedFormat"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });

  it("a partial last line waits for its line break", async () => {
    const next = message("u9", "user", [text("and the CHANGELOG too")], 60);
    const reader = new FakeTranscriptReader();
    reader.put(filePath, typoSession().join("\n") + "\n" + next.slice(0, 30), filePath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 2)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(feed.timeline.turns, "half a line shows nothing").toHaveLength(2);
    reader.append(filePath, next.slice(30) + "\n");
    expect(await eventually(() => feed.timeline.turns.length === 3 && turnUserMessage(feed.timeline.turns[2]!)?.text === "and the CHANGELOG too")).toBe(true);
    feed.stop();
  });
});
