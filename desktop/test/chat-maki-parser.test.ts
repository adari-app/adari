// A Maki session log in Chat (agents/maki-parser.ts). The fixture is synthetic, built from
// Maki's own types at tontinton/maki ac17ffe, never from a real session: the records of
// maki-storage/src/sessions.rs:755-787 (LogRecord: header, msg, out, sub_msg, frame, meta) and the message
// and block shapes of maki-providers/src/types.rs:291-336 and :505-627, with Maki's tool names and input
// fields from plugins/<tool>/init.lua and the bash result's `Exit code: N` (plugins/bash/init.lua:597-606).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MakiSessionParser, makiExitCode } from "../src/shared/chat/agents/maki-parser";
import { rebuildOmitted } from "../src/shared/chat/blobs";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed, standardColdLoad, type TranscriptReadOptions } from "../src/shared/chat/feed";
import { maxLineBytes } from "../src/shared/chat/follower";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { attachmentIsImage, turnToolCalls, turnUserMessage, type ChatTimeline, type ChatTurn } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { FakeTranscriptReader } from "./support/chat-lines";
import { relayOmit, runClock } from "./support/cold-link";

const id = "1C3vwUbZ2nGEr1q5wQ2xaY";
const folder = "/Users/fixture/maki proj";
const makiPath = `/Users/fixture/.local/state/maki/sessions/${id}.jsonl`;
const makiSession: TranscriptSessionRef = makeSessionRef("maki", { kind: "id", id })!;

const record = (value: unknown): string => JSON.stringify(value);
const header = (cwd = folder, v = 3): string => record({ t: "header", v, id, model: "anthropic/claude-sonnet-4-5", cwd, created_at: 1_793_502_000 });
const msg = (d: unknown): string => record({ t: "msg", d });
const userText = (text: string, extra: Record<string, unknown> = {}): string => msg({ role: "user", content: [{ type: "text", text }], ...extra });
const assistant = (...content: unknown[]): string => msg({ role: "assistant", content });
const results = (...content: unknown[]): string => msg({ role: "user", content });
const use = (callID: string, name: string, input: Record<string, unknown>): unknown => ({ type: "tool_use", id: callID, name, input });
const done = (callID: string, content: string, isError = false): unknown => ({ type: "tool_result", tool_use_id: callID, content, ...(isError ? { is_error: true } : {}) });
const meta = (title: string): string => record({ t: "meta", title, token_usage: { input: 10, output: 5 }, updated_at: 1_793_502_100, context_size: 0 });
const picture = "iVBORw0KGgo" + "A".repeat(4_000);

/** makiSession: three turns, every record and block kind, the noise Maki hides, a cut turn. */
const makiSessionLines: string[] = [
  header(),
  // Turn 1: the user's words with a picture; Maki thinks, reads and edits, runs a failing command, then answers.
  msg({ role: "user", content: [{ type: "text", text: "Fix the failing test" }, { type: "image", source: { type: "base64", media_type: "image/png", data: picture } }] }),
  assistant({ type: "thinking", thinking: "Look at the test first.", signature: "sig" }, { type: "text", text: "Reading the test." }, use("call_1", "read", { path: "/p/src/lib.rs", offset: 1, limit: 0 })),
  results(done("call_1", "1: fn add() {}")),
  record({ t: "out", id: "call_1", d: { text: "1: fn add() {}" } }),
  assistant(
    use("call_2", "edit", { path: "/p/src/lib.rs", old_string: "fn add() {}", new_string: "fn add(a: i32) {}" }),
    use("call_3", "bash", { command: "cargo test", description: "Run the tests" }),
  ),
  results(done("call_2", "Edited /p/src/lib.rs"), done("call_3", "test lib ... FAILED\nExit code: 101", true)),
  assistant({ type: "text", text: "The test **still fails**; it needs `a`." }),
  meta("Fix the failing test"),
  // Noise Maki keeps for the model and hides: an observation, a context update, a synthetic message, a frame, a subagent's message.
  userText("[background task 7 finished]", { kind: "observation" }),
  msg({ role: "user", content: [{ type: "text", text: "date changed" }], kind: "context_update", facts: { date: "2026-11-09" } }),
  userText("Continue with the plan.", { display_text: "" }),
  record({ t: "frame", d: { system: "prompt" } }),
  record({ t: "sub_msg", sub: "agent_1", d: { role: "user", content: [{ type: "text", text: "subagent prompt" }] } }),
  // Turn 2: what the user typed (display_text) over the expanded text; every other tool kind; the turn ends with no call.
  userText("Expanded: @src/lib.rs contents …", { display_text: "Write the docs and search for TODOs" }),
  assistant(
    use("call_4", "write", { path: "/p/README.md", content: "# Lib\n\nAdds numbers.\n" }),
    use("call_5", "multiedit", { path: "/p/src/a.rs", edits: [{ old_string: "a", new_string: "b" }] }),
    use("call_6", "grep", { pattern: "TODO", path: "/p" }),
    use("call_7", "glob", { pattern: "**/*.rs" }),
    use("call_8", "webfetch", { url: "https://example.com/docs" }),
    use("call_9", "todo_write", { todos: [{ content: "Write docs", status: "in_progress" }, { content: "Ship", status: "pending" }] }),
    use("call_10", "task", { description: "Survey the crate", prompt: "List every public function" }),
    use("call_11", "mcp__github__search", { query: "issues" }),
  ),
  results(...["call_4", "call_5", "call_6", "call_7", "call_8", "call_9", "call_10", "call_11"].map((call) => done(call, "ok"))),
  assistant({ type: "text", text: "Done." }),
  // Turn 3: the user asks, Maki starts a command, the user cuts it short (Maki's synthetic cancel marker).
  userText("Run the slow benchmark"),
  assistant(use("call_12", "bash", { command: "cargo bench" })),
  results(done("call_12", "[Cancelled by user]", true)),
  userText("[Cancelled by user]", { display_text: "" }),
  // Damage and the future: a line that is not JSON, a record type Maki does not write yet.
  "{not json",
  record({ t: "future_record", d: {} }),
];

/** Line by line with offsets, as the feed reads it. */
function timeline(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats; parser: TranscriptParser } {
  const parser = new TranscriptParser("maki");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    builder.apply(parser.parse(line, offset).events, offset);
    offset += new TextEncoder().encode(line).length + 1;
  }
  return { timeline: builder.timeline, stats: parser.stats, parser };
}

const texts = (turn: ChatTurn | undefined): string[] => (turn?.items ?? []).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));

describe("maki session: the synthetic fixture (makiSessionLines)", () => {
  it("builds three turns, the user's words as typed, and counts every line", () => {
    const { timeline: built, stats, parser } = timeline(makiSessionLines);
    expect(parser.cwd).toBe(folder);
    expect(built.title).toBe("Fix the failing test");
    expect(built.turns.map((turn) => turnUserMessage(turn)?.text ?? null)).toEqual(["Fix the failing test", "Write the docs and search for TODOs", "Run the slow benchmark"]);
    expect(built.turns.every((turn) => turn.isFinished)).toBe(true);
    expect(stats.lines).toBe(makiSessionLines.length);
    expect(stats.malformed).toBe(1);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ future_record: 1 });
    for (const noise of ["header", "out", "frame", "sub_msg", "msg/observation", "msg/context_update", "msg/synthetic"]) expect(stats.skippedTypes.has(noise), noise).toBe(true);
    // Nothing Maki hides reaches the timeline.
    const all = JSON.stringify(built);
    for (const hidden of ["background task 7", "date changed", "Continue with the plan", "subagent prompt", "Look at the test first", "Expanded: @src"]) expect(all.includes(hidden), hidden).toBe(false);
  });

  it("shows the reply as markdown, the picture as an attachment, and ends a turn at a reply with no call", () => {
    const { timeline: built } = timeline(makiSessionLines);
    const first = built.turns[0]!;
    expect(texts(first)).toEqual(["Reading the test.", "The test **still fails**; it needs `a`."]);
    const message = turnUserMessage(first)!;
    expect(message.attachments).toHaveLength(1);
    expect(attachmentIsImage(message.attachments[0]!)).toBe(true);
    expect(message.attachments[0]!.mediaType).toBe("image/png");
    expect(texts(built.turns[1])).toEqual(["Done."]);
  });

  it("maps Maki's tools to the nearest kind under their own names, finished by their results", () => {
    const { timeline: built } = timeline(makiSessionLines);
    const calls = built.turns.flatMap(turnToolCalls);
    const row = (callID: string) => calls.find((call) => call.id === callID)!;
    expect(row("call_1")).toMatchObject({ kind: "read", toolName: "read", target: "/p/src/lib.rs", state: "ok" });
    expect(row("call_2")).toMatchObject({ kind: "edit", toolName: "edit", target: "/p/src/lib.rs", state: "ok" });
    expect(row("call_2").detail.type).toBe("diff");
    expect(row("call_3")).toMatchObject({ kind: "bash", toolName: "bash", target: "cargo test", state: "failed" });
    expect(row("call_3").detail.type === "bash" ? row("call_3").detail : null).toMatchObject({ bash: { exitCode: 101 } });
    expect(row("call_4")).toMatchObject({ kind: "edit", toolName: "write", target: "/p/README.md" });
    expect(row("call_5")).toMatchObject({ kind: "edit", toolName: "multiedit", target: "/p/src/a.rs" });
    expect(row("call_6")).toMatchObject({ kind: "search", toolName: "grep", target: "TODO" });
    expect(row("call_7")).toMatchObject({ kind: "search", toolName: "glob", target: "**/*.rs" });
    expect(row("call_8")).toMatchObject({ kind: "web", toolName: "webfetch", target: "https://example.com/docs" });
    expect(row("call_9")).toMatchObject({ kind: "plan", toolName: "todo_write", target: "Write docs" });
    expect(row("call_10")).toMatchObject({ kind: "agent", toolName: "task", target: "Survey the crate" });
    expect(row("call_10").subagent).toBeUndefined();
    expect(row("call_11")).toMatchObject({ kind: { other: "search" }, toolName: "mcp__github__search", target: "issues" });
    expect(calls.filter((call) => call.state === "running")).toEqual([]);
  });

  it("makes Maki's cancel marker an interrupted turn and its cut command failed", () => {
    const { timeline: built } = timeline(makiSessionLines);
    const last = built.turns[2]!;
    expect(last.items.some((item) => item.type === "notice" && item.value.kind === "interrupted")).toBe(true);
    expect(turnToolCalls(last)[0]).toMatchObject({ toolName: "bash", target: "cargo bench", state: "failed" });
  });

  it("reads a bash result's exit code off its last line only", () => {
    expect(makiExitCode("ok\nExit code: 2")).toEqual({ code: 2, body: "ok" });
    expect(makiExitCode("Exit code: 0")).toEqual({ code: 0, body: "" });
    expect(makiExitCode("Exit code: 1 was printed\nthen more")).toEqual({ code: null, body: "Exit code: 1 was printed\nthen more" });
  });

  it("gives the same line read twice the same ids", () => {
    const line = makiSessionLines[2]!;
    const one = new MakiSessionParser();
    const two = new MakiSessionParser();
    one.lineOffset = 512;
    two.lineOffset = 512;
    expect(JSON.stringify(one.parse(line).events)).toBe(JSON.stringify(two.parse(line).events));
  });

  it("refuses a log of a format it does not know whole, as Maki does (v1 and v4)", () => {
    for (const version of [1, 4]) {
      const { timeline: built, stats } = timeline([header(folder, version), ...makiSessionLines.slice(1, 9)]);
      expect(built.turns, `v${version}`).toEqual([]);
      expect(stats.unparseable).toBe(9);
    }
  });
});

async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return condition();
}

const fileOf = (lines: readonly string[]): string => lines.join("\n") + "\n";

describe("maki session: the feed", () => {
  it("follows the log as it grows; a partial last line waits", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(makiPath, fileOf([header(), userText("Go")]), makiPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makiSession, [folder]);
    expect(await feed.loaded()).toBe(true);
    reader.append(makiPath, assistant({ type: "text", text: "First" }, use("c1", "read", { path: "/p/a" })) + "\n");
    expect(await eventually(() => JSON.stringify(texts(feed.timeline.turns.at(-1))) === '["First"]')).toBe(true);
    reader.append(makiPath, results(done("c1", "contents")) + "\n");
    const line = new TextEncoder().encode(assistant({ type: "text", text: "Second" }));
    const half = Math.floor(line.length / 2);
    reader.appendBytes(makiPath, line.slice(0, half));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(texts(feed.timeline.turns.at(-1))).toEqual(["First"]);
    reader.appendBytes(makiPath, line.slice(half));
    reader.append(makiPath, "\n");
    expect(await eventually(() => JSON.stringify(texts(feed.timeline.turns.at(-1))) === '["First","Second"]')).toBe(true);
    expect(feed.timeline.turns.at(-1)!.isFinished).toBe(true);
    expect(feed.state.status).toBe("live");
    feed.stop();
  });

  it("starts over when Maki rewrites its log shorter (a compaction, a rewind, the 512-append rewrite)", async () => {
    const reader = new FakeTranscriptReader();
    const long = [header(), userText("One"), assistant({ type: "text", text: "Answer one" }), meta("t"), meta("t"), meta("t"), userText("Two"), assistant({ type: "text", text: "Answer two" })];
    reader.put(makiPath, fileOf(long), makiPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makiSession, [folder]);
    await feed.loaded();
    expect(feed.timeline.turns.map((turn) => turnUserMessage(turn)?.text)).toEqual(["One", "Two"]);
    // The rewrite: the same messages, the stale meta records gone, then a new turn; renamed over the old file.
    reader.put(makiPath, fileOf([header(), userText("Two"), assistant({ type: "text", text: "Answer two" })]), makiPath);
    expect(await eventually(() => JSON.stringify(feed.timeline.turns.map((turn) => turnUserMessage(turn)?.text)) === '["Two"]')).toBe(true);
    reader.append(makiPath, fileOf([userText("Three"), assistant({ type: "text", text: "Answer three" })]));
    expect(await eventually(() => JSON.stringify(feed.timeline.turns.map((turn) => turnUserMessage(turn)?.text)) === '["Two","Three"]')).toBe(true);
    feed.stop();
  });

  it("drops a line over the line bound and counts it; the next line shows", async () => {
    const reader = new FakeTranscriptReader();
    const huge = userText("x".repeat(maxLineBytes + 16));
    reader.put(makiPath, fileOf([header(), userText("Before"), huge, userText("After")]), makiPath);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    feed.start(makiSession, [folder]);
    expect(await feed.loaded()).toBe(true);
    const shownTexts = feed.timeline.turns.map((turn) => turnUserMessage(turn)?.text);
    expect(shownTexts).toContain("After");
    expect(shownTexts.some((value) => (value ?? "").startsWith("xxxx"))).toBe(false);
    feed.stop();
  });

  it("refuses a session whose header names another folder (sessionMismatch), and one of a newer format (unrecognisedFormat)", async () => {
    const elsewhere = new FakeTranscriptReader();
    elsewhere.put(makiPath, fileOf([header("/Users/fixture/elsewhere"), userText("Not yours")]), makiPath);
    const mismatched = new ChatFeed(elsewhere, { pollIntervalMs: 5 });
    mismatched.start(makiSession, [folder]);
    await mismatched.loaded();
    expect(mismatched.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    expect(mismatched.timeline.turns).toEqual([]);
    mismatched.stop();
    const newer = new FakeTranscriptReader();
    newer.put(makiPath, fileOf([header(folder, 4), userText("From a newer Maki")]), makiPath);
    const refused = new ChatFeed(newer, { pollIntervalMs: 5 });
    refused.start(makiSession, [folder]);
    await refused.loaded();
    expect(refused.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
    refused.stop();
    // A header-less file (not Maki's) is not the pane's either.
    const headless = new FakeTranscriptReader();
    headless.put(makiPath, fileOf([userText("No header")]), makiPath);
    const none = new ChatFeed(headless, { pollIntervalMs: 5 });
    none.start(makiSession, [folder]);
    await none.loaded();
    expect(none.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
    none.stop();
  });

  it("knows the folder from the header in a cold window that starts after it", async () => {
    const reader = new FakeTranscriptReader();
    const filler = Array.from({ length: 400 }, (_, index) => [userText(`Question ${index} ` + "q".repeat(2_000)), assistant({ type: "text", text: `Answer ${index}` })]).flat();
    reader.put(makiPath, fileOf([header(), ...filler]), makiPath);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    feed.start(makiSession, [folder]);
    expect(await feed.loaded()).toBe(true);
    expect(feed.bytesRead).toBeLessThanOrEqual(standardColdLoad.window * 2 + 64 * 1_024);
    expect(feed.timeline.earlier).toBe("available");
    expect(feed.transcriptFolder).toBe(folder);
    expect(texts(feed.timeline.turns.at(-1))).toEqual(["Answer 399"]);
    feed.stop();
  });
});

class OmitReader extends FakeTranscriptReader {
  async readWithIdentity(path: string, at: number, max: number, options: TranscriptReadOptions = {}) {
    const size = await super.size(path);
    const full = await super.read(path, 0, size);
    const start = options.tail === undefined ? at : Math.max(0, size - options.tail);
    const raw = full.subarray(start, start + max);
    const out = options.omit ? relayOmit(full, start, raw, 1024) : { kept: raw, omitted: [] };
    return { size, ino: 77, offset: start, data: rebuildOmitted(start, out.kept, out.omitted)!, omitted: out.omitted };
  }
}

describe("maki session: a relay read that leaves base64 out", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps every word and id, and the user's picture becomes one to fetch on show", async () => {
    const question = "question " + "A".repeat(2_000);
    const answer = "answer " + "B".repeat(2_000);
    const lines = [
      header(),
      msg({ role: "user", content: [{ type: "text", text: question }, { type: "image", source: { type: "base64", media_type: "image/png", data: "C".repeat(200_000) } }] }),
      assistant({ type: "text", text: answer }),
    ];
    const plain = new FakeTranscriptReader();
    const omitted = new OmitReader();
    for (const reader of [plain, omitted]) reader.put(makiPath, fileOf(lines), makiPath);
    const feeds = [new ChatFeed(plain, { cold: standardColdLoad }), new ChatFeed(omitted, { cold: standardColdLoad })];
    let finished = 0;
    for (const feed of feeds) {
      feed.start(makiSession, [folder]);
      void feed.loaded().then(() => finished++);
    }
    await runClock(() => finished === 2, 10_000);
    expect(feeds[1]!.state).toEqual({ status: "live" });
    const words = (feed: ChatFeed<TranscriptSessionRef>): unknown => feed.timeline.turns.map((turn) => [turnUserMessage(turn)?.text, texts(turn)]);
    expect(words(feeds[1]!)).toEqual(words(feeds[0]!));
    expect(JSON.stringify(words(feeds[1]!))).toContain(answer);
    const pictureOf = (feed: ChatFeed<TranscriptSessionRef>) => turnUserMessage(feed.timeline.turns[0]!)!.attachments[0]!;
    expect(pictureOf(feeds[0]!).blob).toBeUndefined();
    expect(pictureOf(feeds[1]!).blob?.path).toBe(makiPath);
    expect(pictureOf(feeds[1]!).mediaType).toBe("image/png");
    for (const feed of feeds) feed.stop();
  });
});
