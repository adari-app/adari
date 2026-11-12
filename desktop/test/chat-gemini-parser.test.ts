// Gemini CLI's session log in Chat. The fixture is synthetic, built from gemini-cli 62bab5b's
// own record shapes (packages/core/src/services/chatRecordingTypes.ts:41-165; the metadata line,
// chatRecordingService.ts:869-876; a message written again whole as it changes, :1068, :1168-1265; `$set`,
// `$rewindTo`, :1436-1483; "Request cancelled.", packages/cli/src/ui/hooks/useGeminiStream.ts:747; a tool's
// response as a `functionResponse` user message, geminiChat.ts:603-607; "Please continue.", geminiChat.ts:132).

import { describe, expect, it } from "vitest";

import { blobMark, blobsToRestore, elidedBlob } from "../src/shared/chat/blobs";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed } from "../src/shared/chat/feed";
import { makeSessionRef } from "../src/shared/chat/locator";
import { noticeText, turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { eventually, FakeTranscriptReader, shown } from "./support/chat-lines";

const sessionID = "6c0d2f1e-4b3a-4e2d-9f8a-7b6c5d4e3f2a";
const geminiPath = "/Users/fixture/.gemini/tmp/proj/chats/session-2026-11-01T03-00-6c0d2f1e.jsonl";
const folder = "/Users/fixture/proj";
const ref = makeSessionRef("gemini", { kind: "folder", folder })!;
const at = (second: number): string => new Date(Date.UTC(2026, 10, 1, 3, 0, second)).toISOString();
const png = "iVBORw0KGgo" + "A".repeat(4_000);

const meta = JSON.stringify({ sessionId: sessionID, projectHash: "4f1c2b", startTime: at(0), lastUpdated: at(0), kind: "main" });
const message = (id: string, type: string, content: unknown, second: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, timestamp: at(second), type, content, ...extra });
const readCall = {
  id: "read_file-1",
  name: "read_file",
  args: { absolute_path: "/Users/fixture/proj/README.md" },
  status: "success",
  timestamp: at(3),
  result: [{ functionResponse: { id: "read_file-1", name: "read_file", response: { output: "# Proj\nTeh typo\n" } } }],
};
const replaceCall = {
  id: "replace-2",
  name: "replace",
  args: { file_path: "/Users/fixture/proj/README.md", old_string: "Teh typo", new_string: "The typo" },
  status: "success",
  timestamp: at(5),
  resultDisplay: { fileDiff: "@@ -1 +1 @@", fileName: "README.md" },
};
const shellCall = { id: "run_shell_command-5", name: "run_shell_command", args: { command: "npm test" }, status: "error", timestamp: at(21), resultDisplay: "exit code 1" };

/** One session of every record the reader handles. */
const fixtureLines = [
  meta,
  message("u1", "user", [{ text: "Fix the typo in README.md\n--- Content from referenced files ---\n# Proj" }], 1, { displayContent: [{ text: "Fix the typo in @README.md" }] }),
  message("g1", "gemini", "I'll read the README first.", 2, { thoughts: [{ subject: "Planning", description: "Read it." }], model: "gemini-2.5-pro" }),
  message("g1", "gemini", "I'll read the README first.", 2, { tokens: { input: 10, output: 5, total: 15 }, model: "gemini-2.5-pro" }),
  message("g1", "gemini", "I'll read the README first.", 2, { tokens: { input: 10, output: 5, total: 15 }, toolCalls: [readCall] }),
  message("u-fr1", "user", [{ functionResponse: { id: "read_file-1", name: "read_file", response: { output: "# Proj" } } }], 3),
  message("g2", "gemini", "", 4, { toolCalls: [{ ...replaceCall, status: "executing" }] }),
  message("g2", "gemini", "", 5, { toolCalls: [replaceCall] }),
  message("g3", "gemini", "Fixed the typo in README.md.", 6),
  JSON.stringify({ $set: { summary: "Fix the README typo" } }),
  message("u2", "user", [{ text: "What does this screenshot show?" }, { inlineData: { mimeType: "image/png", data: png } }], 10),
  message("g4", "gemini", [{ text: "Looking at the picture", thought: true }, { text: "A login form." }], 11),
  message("u3", "user", "Run the tests", 20),
  message("g5", "gemini", "", 21, { toolCalls: [shellCall] }),
  message("e1", "error", "[API Error: You exceeded your current quota]", 22),
  message("u4", "user", "Please continue.", 23),
  message("u5", "user", "Explain the build", 30),
  message("g6", "gemini", "The build runs", 31),
  message("i1", "info", "Request cancelled.", 32),
  message("i2", "info", "Switched to fallback model.", 33),
  message("w1", "warning", "Low disk space.", 34),
  JSON.stringify({ $rewindTo: "u5" }),
  message("f1", "future_kind", "A record of a later version.", 35),
  "{\"id\":\"g7\",\"timestamp\":",
];

function timeline(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("gemini");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    builder.apply(parser.parse(line, offset).events, offset);
    offset += new TextEncoder().encode(line).length + 1;
  }
  return { timeline: builder.timeline, stats: parser.stats };
}

describe("gemini session: the synthetic fixture (chatRecordingTypes.ts:41-165)", () => {
  const { timeline: built, stats } = timeline(fixtureLines);

  it("shows the user's messages as typed, each once, and skips what is not theirs", () => {
    expect(built.turns.map((turn) => turnUserMessage(turn)?.text)).toEqual(["Fix the typo in @README.md", "What does this screenshot show?", "Run the tests", "Explain the build"]);
    expect(shown(built).filter((entry) => entry.startsWith("user:"))).toHaveLength(4);
    expect(shown(built).some((entry) => entry.includes("Please continue"))).toBe(false);
  });

  it("shows Gemini's text once though the message is written again, its thoughts never", () => {
    expect(shown(built).filter((entry) => entry.startsWith("agent:"))).toEqual([
      "agent:I'll read the README first.",
      "agent:Fixed the typo in README.md.",
      "agent:A login form.",
      "agent:[API Error: You exceeded your current quota]",
      "agent:The build runs",
    ]);
  });

  it("maps tool calls to rows, each once, finished by the copy that gives the status", () => {
    const [read, replace] = turnToolCalls(built.turns[0]!);
    expect(turnToolCalls(built.turns[0]!)).toHaveLength(2);
    expect(read).toMatchObject({ id: "read_file-1", kind: "read", toolName: "read_file", target: "/Users/fixture/proj/README.md", state: "ok" });
    expect(replace).toMatchObject({ id: "replace-2", kind: "edit", target: "/Users/fixture/proj/README.md", state: "ok" });
    expect(replace?.detail.type).toBe("diff");
    const [shell] = turnToolCalls(built.turns[2]!);
    expect(shell).toMatchObject({ kind: "bash", target: "npm test", state: "failed" });
  });

  it("keeps a picture's type, never its bytes", () => {
    const message = turnUserMessage(built.turns[1]!);
    expect(message?.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(JSON.stringify(built)).not.toContain("iVBORw0KGgo");
  });

  it("shows Esc's cancel as Interrupted, the summary as the title, and ends each turn", () => {
    expect(shown(built.turns[3] === undefined ? built : { ...built, turns: [built.turns[3]] })).toEqual([
      "user:Explain the build",
      "agent:The build runs",
      "notice:" + noticeText("interrupted"),
    ]);
    expect(built.title).toBe("Fix the README typo");
    expect(built.turns.slice(0, 3).every((turn) => turn.isFinished)).toBe(true);
    expect(built.turns[3]?.isFinished).toBe(true);
  });

  it("counts a later version's record as unknown, a cut last line as malformed, and skips the rest by name", () => {
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ future_kind: 1 });
    expect(stats.malformed).toBe(1);
    for (const skipped of ["metadata", "toolResponse", "info", "warning", "$rewindTo"]) expect(stats.skippedTypes.has(skipped), skipped).toBe(true);
  });
});

describe("gemini session: a picture's base64 in a long line", () => {
  it("is cut before the parse, and a relay's placeholder or elided marker in it shows the same message", () => {
    const big = "iVBORw0KGgo" + "B".repeat(200_000);
    const line = message("u9", "user", [{ text: "Look" }, { inlineData: { mimeType: "image/jpeg", data: big } }], 40);
    const parser = new TranscriptParser("gemini");
    const result = parser.parse(line, 0);
    expect(result.events).toEqual([{ type: "userMessage", message: { id: "gemini-u9", text: "Look", time: Date.parse(at(40)) / 1_000, attachments: [{ path: null, mediaType: "image/jpeg" }] } }]);
    expect(parser.stats.parsedChars).toBeLessThan(1_000);
    // A relay read leaves the run out (omit 1024): its placeholder is in a string, so it is put back from a plain
    // read of its range (or the elided marker when that fails) before the parse; either way the message is the same.
    const start = line.indexOf(big);
    const range = [start, big.length] as const;
    const placed = line.slice(0, start) + blobMark(range) + line.slice(start + big.length);
    expect(blobsToRestore(placed, [range])).toEqual({ restore: [range], whole: false });
    for (const text of [placed, line.slice(0, start) + elidedBlob(range) + line.slice(start + big.length)]) {
      expect(new TranscriptParser("gemini").parse(text, 0).events).toEqual(result.events);
    }
  });
});

describe("gemini session: the feed", () => {
  const lines = (rows: readonly string[]): string => rows.join("\n") + "\n";

  it("follows the file as it grows; a partial last line waits for its end", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(geminiPath, lines(fixtureLines.slice(0, 3)), geminiPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    const next = new TextEncoder().encode(message("g8", "gemini", "Second part.", 3) + "\n");
    reader.appendBytes(geminiPath, next.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(shown(feed.timeline)).toEqual(["user:Fix the typo in @README.md", "agent:I'll read the README first."]);
    reader.appendBytes(geminiPath, next.slice(20));
    expect(await eventually(() => shown(feed.timeline).at(-1) === "agent:Second part.")).toBe(true);
    feed.stop();
  });

  it("drops an oversized line and reads on after it", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(geminiPath, lines(fixtureLines.slice(0, 3)), geminiPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 1 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.timeline.turns.length === 1)).toBe(true);
    reader.append(geminiPath, message("g9", "gemini", "x".repeat(9 * 1_024 * 1_024), 4) + "\n" + message("u10", "user", "After the long line", 5) + "\n");
    expect(await eventually(() => feed.timeline.turns.length === 2, 20_000)).toBe(true);
    expect(turnUserMessage(feed.timeline.turns[1]!)?.text).toBe("After the long line");
    expect(shown(feed.timeline).some((entry) => entry.startsWith("agent:xxxx"))).toBe(false);
    feed.stop();
  }, 30_000);

  it("starts over when the file is replaced by a shorter one", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(geminiPath, lines(fixtureLines), geminiPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.timeline.turns.length === 4)).toBe(true);
    reader.put(geminiPath, lines([meta, message("n1", "user", "fresh start", 50)]), geminiPath);
    expect(await eventually(() => feed.timeline.turns.length === 1 && turnUserMessage(feed.timeline.turns[0]!)?.text === "fresh start")).toBe(true);
    expect(feed.timeline.title, "nothing of the old file is kept").toBeNull();
    feed.stop();
  });

  it("shows the unrecognised-format note for a log of another version, never a wrong chat", async () => {
    const reader = new FakeTranscriptReader();
    const future = Array.from({ length: 6 }, (_, index) => JSON.stringify({ v: 2, record: { kind: "message", text: `line ${index}` } }));
    reader.put(geminiPath, lines(future), geminiPath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [folder]);
    expect(await eventually(() => feed.state.status === "unavailable")).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
    expect(feed.timeline.turns).toHaveLength(0);
    feed.stop();
  });
});
