// GitHub Copilot CLI's event log (`~/.copilot/session-state/<id>/events.jsonl`) in Chat.
// Every fixture here is synthetic, built from the SDK's own types (github/copilot-sdk d1e6021,
// nodejs/src/generated/session-events.ts: the envelope `{id, timestamp, parentId, type, data}`,
// SessionStartData, UserMessageData with AttachmentFile / AttachmentBlob, AssistantMessageData with
// toolRequests, AssistantReasoningData, ToolExecutionStartData / ToolExecutionCompleteData, AbortData,
// SessionErrorData, SessionCompactionCompleteData). No real session was read.

import { describe, expect, it } from "vitest";

import { CopilotEventsParser, copilotLogVersion } from "../src/shared/chat/agents/copilot-parser";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed, type ChatFeedState } from "../src/shared/chat/feed";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage, type ChatTimeline, type ChatTurn } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { at, eventually, FakeTranscriptReader, stamp } from "./support/chat-lines";

const sessionID = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const folder = "/Users/fixture/proj";
const logPath = `/Users/fixture/.copilot/session-state/${sessionID}/events.jsonl`;
const ref: TranscriptSessionRef = makeSessionRef("copilot", { kind: "id", id: sessionID })!;

let serial = 0;
/** One session event as Copilot writes it (session-events.ts's envelope). */
function event(type: string, data: Record<string, unknown>, second: number, extra: Record<string, unknown> = {}): string {
  serial += 1;
  return JSON.stringify({ id: `ev-${serial}`, timestamp: stamp(second), parentId: serial > 1 ? `ev-${serial - 1}` : null, type, data, ...extra });
}

const start = (second = 0, version: number | undefined = copilotLogVersion, cwd = folder): string =>
  event(
    "session.start",
    { sessionId: sessionID, ...(version === undefined ? {} : { version }), producer: "copilot-agent", copilotVersion: "1.0.0", startTime: stamp(second), context: { cwd, gitRoot: cwd, branch: "main" } },
    second,
  );
const prompt = (content: string, second: number, extra: Record<string, unknown> = {}): string => event("user.message", { content, ...extra }, second);
const reply = (messageId: string, content: string, second: number, toolRequests: { toolCallId: string; name: string; arguments: unknown }[] = [], extra: Record<string, unknown> = {}): string =>
  event("assistant.message", { messageId, content, toolRequests, ...extra }, second);
const toolStart = (toolCallId: string, toolName: string, args: unknown, second: number, extra: Record<string, unknown> = {}): string =>
  event("tool.execution_start", { toolCallId, toolName, arguments: args, ...extra }, second);
const toolDone = (toolCallId: string, content: string, second: number, extra: Record<string, unknown> = {}): string =>
  event("tool.execution_complete", { toolCallId, success: true, result: { content }, ...extra }, second);
const toolFailed = (toolCallId: string, message: string, second: number): string =>
  event("tool.execution_complete", { toolCallId, success: false, error: { message, code: "failure" } }, second);

/** The synthetic Copilot session "fix the typo": three turns, every row kind this reader shows. */
function typoSession(): string[] {
  serial = 0;
  const readme = `${folder}/README.md`;
  return [
    start(0),
    // Turn 1: a prompt with a file attached; thinking, a hidden report_intent, view, edit, a failing bash, the answer.
    prompt("Read the README and fix the typo", 1, { messageId: "u1", attachments: [{ type: "file", path: readme, displayName: "README.md" }] }),
    event("assistant.turn_start", { turnId: "0", interactionId: "i1" }, 2),
    event("assistant.reasoning", { reasoningId: "r1", content: "Looking at the README first." }, 2),
    reply("m1", "I'll read it.", 3, [
      { toolCallId: "c0", name: "report_intent", arguments: { intent: "Reading README" } },
      { toolCallId: "c1", name: "view", arguments: { path: readme } },
    ]),
    toolStart("c0", "report_intent", { intent: "Reading README" }, 3),
    toolDone("c0", "Intent logged", 3),
    toolStart("c1", "view", { path: readme }, 4),
    toolDone("c1", "1. # Proj\n2. Teh readme\n", 5),
    reply("m2", "", 6, [{ toolCallId: "c2", name: "edit", arguments: { path: readme, old_str: "Teh", new_str: "The" } }]),
    toolStart("c2", "edit", { path: readme, old_str: "Teh", new_str: "The" }, 6),
    toolDone("c2", "File edited", 7),
    prompt("Use the skill's template", 7, { source: "skill-pdf" }),
    reply("m3", "", 8, [{ toolCallId: "c3", name: "bash", arguments: { command: "npm test", description: "Run tests" } }]),
    toolStart("c3", "bash", { command: "npm test", description: "Run tests" }, 8),
    toolFailed("c3", "2 tests failing", 9),
    event("assistant.usage", { model: "gpt-5", inputTokens: 10, outputTokens: 5 }, 9),
    reply("m4", "Fixed the typo; **two tests fail**.", 10),
    event("assistant.turn_end", { turnId: "0" }, 10),
    // Turn 2: a pasted picture; a task (its sub-agent's own events skipped); steering while it runs; Esc.
    prompt("What is in this screenshot?", 20, { messageId: "u2", attachments: [{ type: "blob", data: "iVBORw0KGgo=", mimeType: "image/png", displayName: "shot.png" }] }),
    reply("m5", "", 21, [{ toolCallId: "c4", name: "task", arguments: { description: "Explore tests", prompt: "Find the failing tests\nand report" } }]),
    toolStart("c4", "task", { description: "Explore tests", prompt: "Find the failing tests\nand report", agent_type: "explore" }, 21),
    event("subagent.started", { toolCallId: "c4", agentName: "explore", agentDisplayName: "Explore" }, 22),
    reply("s1", "The sub-agent's own words", 22, [], { parentToolCallId: "c4" }),
    toolStart("s-c1", "grep", { pattern: "snapshot" }, 22, { parentToolCallId: "c4" }),
    event("assistant.message", { messageId: "s2", content: "A sub-agent reply by agent id", toolRequests: [] }, 23, { agentId: "agent-7" }),
    prompt("also update the snapshot", 24, { messageId: "u3", delivery: "steering" }),
    toolDone("c4", "Two snapshots are stale.", 25),
    event("abort", { reason: "user initiated" }, 26),
    // Turn 3: compaction, then an error ends it.
    prompt("Compact and carry on", 40, { messageId: "u4" }),
    event("session.compaction_start", {}, 41),
    event("session.compaction_complete", { success: true, preCompactionTokens: 9000 }, 42),
    event("session.error", { errorType: "rate_limit", message: "Rate limited, try again later" }, 43),
  ];
}

/** Line by line with offsets, as the feed reads it. */
function timeline(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("copilot");
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
const users = (turn: ChatTurn | undefined): string[] => (turn?.items ?? []).flatMap((item) => (item.type === "user" ? [item.value.text] : []));
const notices = (turn: ChatTurn | undefined): string[] => (turn?.items ?? []).flatMap((item) => (item.type === "notice" ? [item.value.kind] : []));

describe("copilot events.jsonl: the synthetic typo session", () => {
  it("messages: three turns, the user's words with their attachments, the answers, each turn ended", () => {
    const { timeline: built, stats } = timeline(typoSession());
    expect(built.turns).toHaveLength(3);
    expect(built.turns.map((turn) => turnUserMessage(turn)?.text)).toEqual(["Read the README and fix the typo", "What is in this screenshot?", "Compact and carry on"]);
    expect(built.turns.every((turn) => turn.isFinished)).toBe(true);
    expect(texts(built.turns[0]), "the skill's injected prompt is not the user's").toEqual(["I'll read it.", "Fixed the typo; **two tests fail**."]);
    expect(users(built.turns[0])).toEqual(["Read the README and fix the typo"]);
    const thinking = built.turns[0]!.items.filter((item) => item.type === "progress");
    expect(thinking.map((item) => (item.type === "progress" ? item.value.markdown : ""))).toEqual(["Looking at the README first."]);
    expect(turnUserMessage(built.turns[0]!)?.time).toBe(at(1));
    expect(stats.malformed).toBe(0);
    expect(stats.unknownTypes.size).toBe(0);
    for (const known of ["session.start", "assistant.turn_start", "assistant.turn_end", "assistant.usage", "subagent.started", "session.compaction_start"]) {
      expect(stats.skippedTypes.has(known), known).toBe(true);
    }
  });

  it("tools: rows by kind, paired with their results; report_intent shows none", () => {
    const { timeline: built } = timeline(typoSession());
    const calls = turnToolCalls(built.turns[0]!);
    expect(calls.map((call) => call.id)).toEqual(["c1", "c2", "c3"]);
    expect(calls.map((call) => call.kind)).toEqual(["read", "edit", "bash"]);
    expect(calls.map((call) => call.state)).toEqual(["ok", "ok", "failed"]);
    expect(calls[0]!.target).toBe(`${folder}/README.md`);
    expect(calls[1]!.detail.type, "an edit shows its diff").toBe("diff");
    expect(calls[2]!.target).toBe("npm test");
    const bash = calls[2]!.detail;
    if (bash.type !== "bash") throw new Error(bash.type);
    expect(bash.bash.outputTail.join("\n")).toContain("2 tests failing");
    const task = turnToolCalls(built.turns[1]!);
    expect(task.map((call) => [call.kind, call.target, call.state])).toEqual([["agent", "Explore tests", "ok"]]);
  });

  it("images: a pasted picture is an attachment with its type; a file attachment keeps its path", () => {
    const { timeline: built } = timeline(typoSession());
    expect(turnUserMessage(built.turns[0]!)?.attachments).toEqual([{ path: `${folder}/README.md`, mediaType: null }]);
    expect(turnUserMessage(built.turns[1]!)?.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
  });

  it("a sub-agent's own events are skipped; steering goes inside the running turn; Esc ends it", () => {
    const { timeline: built } = timeline(typoSession());
    const turn = built.turns[1]!;
    expect(texts(turn), "neither sub-agent reply").toEqual([]);
    expect(users(turn)).toEqual(["What is in this screenshot?", "also update the snapshot"]);
    expect(notices(turn)).toEqual(["interrupted"]);
    expect(turn.isFinished).toBe(true);
  });

  it("errors: compaction is a row; session.error is the agent's words and ends the turn", () => {
    const { timeline: built } = timeline(typoSession());
    const turn = built.turns[2]!;
    expect(notices(turn)).toEqual(["compacted"]);
    expect(texts(turn)).toEqual(["**Error:** Rate limited, try again later"]);
    expect(turn.isFinished).toBe(true);
  });

  it("the folder: session.start's context.cwd, then the latest session.resume's", () => {
    const parser = new CopilotEventsParser();
    parser.parse(start(0));
    expect(parser.cwd).toBe(folder);
    parser.parse(event("session.resume", { resumeTime: stamp(5), eventCount: 3, context: { cwd: "/Users/fixture/proj/sub" } }, 5));
    expect(parser.cwd).toBe("/Users/fixture/proj/sub");
    parser.parse(event("session.resume", { context: { cwd: "relative/path" } }, 6));
    expect(parser.cwd, "a relative folder is not taken").toBe("/Users/fixture/proj/sub");
    expect(parser.clone().cwd).toBe("/Users/fixture/proj/sub");
  });

  it("a non-final chunk and a thinking phase do not end the turn; a reply with no calls does", () => {
    serial = 0;
    const lines = [start(0), prompt("hi", 1), reply("a", "part one", 2, [], { chunkIndex: 0, chunkCount: 2 }), reply("b", "planning…", 3, [], { phase: "thinking" })];
    expect(timeline(lines).timeline.turns[0]!.isFinished).toBe(false);
    expect(timeline([...lines, reply("c", "done", 4, [], { chunkIndex: 1, chunkCount: 2 })]).timeline.turns[0]!.isFinished).toBe(true);
  });

  it("tool names map to the nearest row kind", () => {
    const call = (name: string, args: unknown) => CopilotEventsParser.call("x", name, name, args, null);
    expect([call("grep", { pattern: "TODO" }).kind, call("grep", { pattern: "TODO" }).target]).toEqual(["search", "TODO"]);
    expect(call("glob", { pattern: "**/*.ts" }).kind).toBe("search");
    expect([call("web_fetch", { url: "https://example.com" }).kind, call("web_fetch", { url: "https://example.com" }).target]).toEqual(["web", "https://example.com"]);
    expect(call("create", { path: "/p/new.ts", file_text: "a\nb\n" }).detail.type).toBe("diff");
    expect(call("read_bash", { shellId: "1" }).kind).toBe("bash");
    const other = call("github-mcp-server-list_issues", { query: "label:bug" });
    expect(typeof other.kind === "object" ? other.target : null).toBe("label:bug");
  });

  it("report_intent's ids are remembered at most 256 deep", () => {
    const parser = new CopilotEventsParser();
    for (let index = 0; index < 300; index += 1) parser.parse(toolStart(`i${index}`, "report_intent", { intent: "x" }, 1));
    expect(parser.parse(toolDone("i299", "ok", 2)).events, "a recent one is still hidden").toEqual([]);
    expect(parser.parse(toolDone("i0", "ok", 2)).events.map((event) => event.type), "the oldest fell out: its result is an orphan").toEqual(["toolFinished"]);
  });

  it("unknown: a line that is not JSON is malformed; a type from no Copilot namespace is unknown", () => {
    serial = 0;
    const { stats, timeline: built } = timeline([start(0), "{not json", event("nebula.drift", { x: 1 }, 1), JSON.stringify({ data: {} }), prompt("still read", 2)]);
    expect(stats.malformed).toBe(1);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ "nebula.drift": 1, "(no type)": 1 });
    expect(turnUserMessage(built.turns[0]!)?.text).toBe("still read");
  });

  it("an unknown version: a later schema's session.start makes every line unknown", () => {
    serial = 0;
    const { stats, timeline: built } = timeline([start(0, copilotLogVersion + 1), prompt("not trusted", 1), reply("m", "nor this", 2)]);
    expect(built.turns).toHaveLength(0);
    expect(stats.unknownTypes.get("session.start v2")).toBe(1);
    expect(stats.unknownTypes.get("user.message")).toBe(1);
    serial = 0;
    expect(timeline([start(0, undefined), prompt("no version is version 1", 1)]).timeline.turns).toHaveLength(1);
  });
});

describe("copilot events.jsonl in the feed", () => {
  const isUnavailable = (state: ChatFeedState, reason: string): boolean => state.status === "unavailable" && state.reason === reason;

  it("an unknown version is the unrecognised-format note, never a wrong chat", async () => {
    serial = 0;
    const reader = new FakeTranscriptReader();
    reader.put(logPath, [start(0, 7), prompt("one", 1), reply("a", "two", 2), prompt("three", 3)].join("\n") + "\n", logPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => isUnavailable(feed.state, "unrecognisedFormat"))).toBe(true);
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });

  it("a partial last line waits for its line break", async () => {
    const lines = typoSession();
    const whole = lines.join("\n") + "\n";
    const next = prompt("and the CHANGELOG too", 60, { messageId: "u9" });
    const reader = new FakeTranscriptReader();
    reader.put(logPath, whole + next.slice(0, 30), logPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 3)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(feed.timeline.turns, "half a line shows nothing").toHaveLength(3);
    reader.append(logPath, next.slice(30) + "\n");
    expect(await eventually(() => feed.timeline.turns.length === 4 && turnUserMessage(feed.timeline.turns[3]!)?.text === "and the CHANGELOG too")).toBe(true);
    feed.stop();
  });
});
