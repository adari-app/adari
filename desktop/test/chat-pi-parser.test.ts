// Pi's and omp's session files in Chat, one parser (src/shared/chat/agents/pi-parser.ts), on
// the synthetic sessions of chat-pi-fixtures.ts (built from the agents' own types).

import { describe, expect, it } from "vitest";

import { PiSessionParser } from "../src/shared/chat/agents/pi-parser";
import { ChatFeed } from "../src/shared/chat/feed";
import { makeSessionRef } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage, type ChatToolCall } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import {
  agentTexts,
  assistant,
  at,
  call,
  entry,
  eventually,
  header,
  ompPath,
  ompSession,
  picture,
  piFolder,
  piPath,
  piSession,
  result,
  text,
  timelineOf,
  user,
} from "./chat-pi-fixtures";
import { FakeTranscriptReader } from "./support/chat-lines";

const callsOf = (calls: readonly ChatToolCall[]): string[] => calls.map((one) => `${typeof one.kind === "object" ? one.kind.other : one.kind} ${one.target} ${one.state} ${one.resultSummary}`);

describe("pi session: the whole fixture", () => {
  const { timeline, stats, parser } = timelineOf(piSession());

  it("builds six turns and counts every line, none unknown", () => {
    expect(timeline.turns.map((turn) => turnUserMessage(turn)?.text ?? null)).toEqual([
      "Fix the failing test in src/sum.ts",
      "What is in this picture?",
      null,
      null,
      "/skill:review the parser",
      "Try again",
    ]);
    expect(stats.lines).toBe(29);
    expect(stats.unparseable).toBe(0);
    expect(stats.malformed).toBe(0);
    expect(stats.linesWithEvents).toBe(19);
    expect(parser.cwd, "the header's folder").toBe(piFolder);
  });

  it("shows the user's words, the thinking, the reply and each call with its result", () => {
    const first = timeline.turns[0]!;
    expect(first.items.map((item) => item.type)).toEqual(["user", "progress", "agentText", "toolCall", "toolCall", "toolCall", "toolCall", "toolCall", "agentText"]);
    expect(agentTexts(first)).toEqual(["Let me look.", "Fixed: `sum` subtracted."]);
    expect(callsOf(turnToolCalls(first))).toEqual([
      "read src/sum.ts ok 2 lines",
      "bash npm test failed exit 1",
      "edit src/sum.ts ok +1 −1",
      "edit src/note.md ok +2 −0",
      "search a - b ok 0 files",
    ]);
    expect(first.isFinished, "stopReason stop ends the turn").toBe(true);
    expect(first.startedAt).toBe(at(1));
  });

  it("makes the user's picture an attachment (its media type, never its bytes)", () => {
    const message = turnUserMessage(timeline.turns[1]!)!;
    expect(message.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(JSON.stringify(timeline)).not.toContain("AAAAAAAA");
    expect(agentTexts(timeline.turns[1])).toEqual(["A cat on a mat."]);
  });

  it("makes the user's ! command a shell row with its output, and the compaction the compaction row", () => {
    const shell = turnToolCalls(timeline.turns[2]!)[0]!;
    expect(shell.isUserShell).toBe(true);
    expect(shell.target).toBe("git status");
    expect(shell.detail).toEqual({ type: "bash", bash: { command: "git status", outputTail: ["On branch main", "nothing to commit"], exitCode: 0 } });
    expect(timeline.turns[3]!.items).toEqual([{ type: "notice", value: { id: expect.stringContaining("pi-compacted-at"), kind: "compacted", time: at(40) } }]);
  });

  it("shows a skill as the user typed it, an error's first line as the reply, and a stop as interrupted", () => {
    expect(agentTexts(timeline.turns[4])).toEqual(["Error: 429 rate limit exceeded"]);
    expect(timeline.turns[4]!.isFinished).toBe(true);
    const stopped = timeline.turns[5]!;
    expect(stopped.items.at(-1)).toMatchObject({ type: "notice", value: { kind: "interrupted" } });
    expect(stopped.isFinished).toBe(true);
  });

  it("gives the same line read twice the same ids", () => {
    const again = timelineOf(piSession()).timeline;
    expect(again).toEqual(timeline);
  });
});

describe("omp session: Pi's format, read by the same parser", () => {
  const { timeline, stats, parser } = timelineOf(ompSession(), "omp");

  it("skips its title line and its own entry types, none unknown", () => {
    expect(stats.unparseable).toBe(0);
    expect([...stats.skippedTypes.keys()]).toEqual(
      expect.arrayContaining(["title", "session", "service_tier_change", "ttsr_injection", "credential_pin", "mode_change", "model_usage", "title_change", "reset_boundary"]),
    );
    expect(parser.cwd).toBe(piFolder);
  });

  it("puts a steer inside the running turn, never shows a synthetic continue or a developer message, and shows the user's Python", () => {
    const first = timeline.turns[0]!;
    expect(first.items.filter((item) => item.type === "user").map((item) => (item.type === "user" ? item.value.text : ""))).toEqual(["Rename foo to bar", "also update the docs"]);
    expect(JSON.stringify(timeline)).not.toContain("Continue.");
    expect(JSON.stringify(timeline)).not.toContain("Keep going.");
    expect(callsOf(turnToolCalls(first))).toEqual(["edit src/a.ts ok +1 −1", "agent Find callers ok null"]);
    expect(agentTexts(first)).toEqual(["Done: foo is bar now."]);
    const python = turnToolCalls(timeline.turns[1]!)[0]!;
    expect(python).toMatchObject({ kind: { other: "Python" }, target: "print(1 + 1)", isUserShell: true, state: "ok" });
  });
});

describe("pi session: lines one at a time", () => {
  it("never parses a picture's base64 (a long line is cut before its parse)", () => {
    const parser = new TranscriptParser("pi");
    parser.parse(header(), 0);
    const line = user([text("look"), { type: "image", data: picture(400_000), mimeType: "image/jpeg" }], 1);
    expect(line.length).toBeGreaterThan(400_000);
    const before = parser.stats.parsedChars;
    const events = parser.parse(line, 100).events;
    expect(parser.stats.parsedChars - before, "the line's chars handed to the JSON parser").toBeLessThan(400_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "userMessage", message: { text: "look", attachments: [{ path: null, mediaType: "image/jpeg" }] } });
  });

  it("reads a version-1 session (no version, no ids) and skips v2's hookMessage", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "old", timestamp: "2025-01-01T00:00:00.000Z", cwd: piFolder }),
      JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1735689601000 } }),
      JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "hookMessage", customType: "x", content: "y", display: true, timestamp: 1 } }),
      JSON.stringify({ type: "message", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 1 } }),
    ];
    const { timeline, stats } = timelineOf(lines.join("\n") + "\n");
    expect(stats.unparseable).toBe(0);
    expect(turnUserMessage(timeline.turns[0]!)?.text).toBe("hello");
    expect(agentTexts(timeline.turns[0])).toEqual(["hi"]);
  });

  it("makes every line after a newer version's header unknown", () => {
    const parser = new TranscriptParser("pi");
    expect(parser.parse(header({ version: 4 }), 0).outcome).toEqual({ kind: "unknown", type: "session v4" });
    expect(parser.parse(user("hello", 1), 10).outcome.kind).toBe("unknown");
    expect(parser.parse(assistant([text("hi")], "stop", 2), 20).outcome.kind).toBe("unknown");
    expect(parser.stats.unparseable).toBe(3);
  });

  it("counts a line that is not JSON as malformed, and an unknown type or role as unknown", () => {
    const parser = new TranscriptParser("pi");
    expect(parser.parse('{"type":"message",', 0).outcome).toEqual({ kind: "malformed" });
    expect(parser.parse(entry("hologram", 1), 10).outcome).toEqual({ kind: "unknown", type: "hologram" });
    expect(parser.parse(entry("message", 1, { message: { role: "oracle", content: "x" } }), 20).outcome).toEqual({ kind: "unknown", type: "message oracle" });
  });

  it("keeps a call running until its result, and pairs results by call id", () => {
    const parser = new TranscriptParser("pi");
    const started = parser.parse(assistant([call("c1", "bash", { command: "sleep 5" })], "toolUse", 1), 0).events;
    expect(started).toEqual([{ type: "toolStarted", call: expect.objectContaining({ id: "c1", kind: "bash", target: "sleep 5", state: "running" }) }]);
    expect(parser.parse(result("c1", "bash", "done", 6), 100).events).toEqual([
      { type: "toolFinished", id: "c1", output: { text: "done", isError: false, exitCode: null, isRunning: false }, time: at(6) },
    ]);
  });
});

describe("pi session: its tools to the nearest row", () => {
  const made = (name: string, args: Record<string, unknown>): ChatToolCall => PiSessionParser.call("c", name, args, null);

  it("maps Pi's and omp's built-in tools", () => {
    expect(made("read", { path: "a.ts", offset: 10 })).toMatchObject({ kind: "read", target: "a.ts" });
    expect(made("find", { pattern: "*.ts" })).toMatchObject({ kind: "search", target: "*.ts" });
    expect(made("glob", { path: "src/**/*.ts" })).toMatchObject({ kind: "search", target: "src/**/*.ts" });
    expect(made("ls", { path: "src" })).toMatchObject({ kind: { other: "ls" }, target: "src" });
    expect(made("powershell", { command: "Get-ChildItem" })).toMatchObject({ kind: "bash" });
    expect(made("web_search", { query: "pi agent" })).toMatchObject({ kind: "web", target: "pi agent" });
    expect(made("fetch", { url: "https://example.com" })).toMatchObject({ kind: "web", target: "https://example.com" });
    expect(made("task", { tasks: [{ name: "scan", task: "look" }] })).toMatchObject({ kind: "agent", target: "scan" });
    expect(made("todo", { op: "view" })).toMatchObject({ kind: { other: "todo" }, target: "view" });
    expect(made("mcp__github__search", { query: "x" })).toMatchObject({ kind: { other: "search" }, target: "x" });
  });

  it("gives an edit its diff: Pi's edits (one or several), its older single edit, omp's replace; omp's patch modes the row alone", () => {
    expect(made("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }).detail.type).toBe("diff");
    const several = made("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c\nd", newText: "e" }] });
    expect(several.detail.type === "diff" ? [several.detail.diff.added, several.detail.diff.removed] : null).toEqual([2, 3]);
    expect(made("edit", { path: "a.ts", oldText: "x", newText: "y" }).detail.type).toBe("diff");
    expect(made("edit", { path: "a.ts", old_string: "x", new_string: "y" }).detail.type).toBe("diff");
    expect(made("edit", { input: "*** Begin Patch\n*** End Patch" })).toMatchObject({ kind: "edit", target: "", detail: { type: "none" } });
    expect(made("write", { path: "n.md", content: "a\nb\n" })).toMatchObject({ kind: "edit", target: "n.md", detail: { type: "diff" } });
  });

  it("shows the user's /skill as typed", () => {
    expect(PiSessionParser.typed('<skill name="git" location="/s/SKILL.md">\nbody\n</skill>')).toBe("/skill:git");
    expect(PiSessionParser.typed('<skill name="git" location="/s/SKILL.md">\nbody\n</skill>\n\ncommit it')).toBe("/skill:git commit it");
    expect(PiSessionParser.typed("<skill> is a word the user typed")).toBe("<skill> is a word the user typed");
  });
});

describe("pi session: a newer version in the feed", () => {
  it("shows the unrecognised-format note, never a wrong chat", async () => {
    const path = piPath();
    const lines = [header({ version: 4 })];
    for (let n = 0; n < 6; n += 1) lines.push(user(`hello ${n}`, n + 1), assistant([text(`hi ${n}`)], "stop", n + 1));
    const reader = new FakeTranscriptReader();
    reader.put(path, lines.join("\n") + "\n", path);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makeSessionRef("pi", { kind: "path", path })!, [piFolder]);
    expect(await eventually(() => feed.state.status === "unavailable")).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
    feed.stop();
  });

  it("reads an omp session by its path", async () => {
    const path = ompPath();
    const reader = new FakeTranscriptReader();
    reader.put(path, ompSession(), path);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(makeSessionRef("omp", { kind: "path", path })!, [piFolder]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 2)).toBe(true);
    expect(agentTexts(feed.timeline.turns[0])).toEqual(["Done: foo is bar now."]);
    feed.stop();
  });
});
