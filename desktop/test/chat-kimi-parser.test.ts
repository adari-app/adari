// Kimi Code's main agent wire in Chat. The fixture is synthetic, built from the record shapes in
// MoonshotAI/kimi-code at 27bd9ba: the metadata line (packages/agent-core-v2/src/wire/record.ts:44-67,
// wire/migration/migration.ts:20-39), `profile.bind`'s environmentDisclosure (docs/wire-manifest.d.ts:575-592),
// the user's `context.append_message` with its origin (src/agent/contextMemory/types.ts:10-40, human/llm/message.ts:33-34),
// the loop events (contextMemory/loopEventFold.ts:20-79), `turn.ended` (wire-manifest.d.ts:901-952),
// `context.apply_compaction`, and wire 1.0's `function: {name, arguments}` tool calls (wire/migration/v1.1.ts).

import { describe, expect, it } from "vitest";

import { kimiTime, kimiWireReadable, KimiWireParser } from "../src/shared/chat/agents/kimi-parser";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { noticeText, turnFooter, turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { shown } from "./support/chat-lines";

const cwd = "/Users/fixture/proj";
const base = 1_793_502_000_000;

/** One wire record: `{type, …payload, time}` (time in milliseconds, `second` after the fixture's start). */
const w = (type: string, payload: Record<string, unknown>, second = 0): string => JSON.stringify({ type, ...payload, time: base + second * 1_000 });
const meta = (protocol = "1.5", minimum: string | undefined = "1.5"): string =>
  JSON.stringify({ type: "metadata", protocol_version: protocol, ...(minimum === undefined ? {} : { min_protocol_version: minimum }), created_at: base });
const bind = (folder = cwd): string => w("profile.bind", { profileId: "default", systemPrompt: "You are Kimi.", environmentDisclosure: { cwd: folder, os: "macOS" } });
const said = (text: string, second: number, origin: Record<string, unknown> | null = { kind: "user" }, extra: unknown[] = []): string =>
  w("context.append_message", { message: { role: "user", content: [{ type: "text", text }, ...extra], ...(origin === null ? {} : { origin }) } }, second);
const loop = (event: Record<string, unknown>, second: number): string => w("context.append_loop_event", { event: { stepUuid: "s", ...event } }, second);
const text = (body: string, second: number): string => loop({ type: "content.part", part: { type: "text", text: body } }, second);
const think = (body: string, second: number, hidden = false): string =>
  loop({ type: "content.part", part: { type: "think", think: body, ...(hidden ? { hidden: true } : {}) } }, second);
const call = (id: string, name: string, args: unknown, second: number): string => loop({ type: "tool.call", toolCallId: id, name, args }, second);
const result = (id: string, output: unknown, second: number, isError = false): string => loop({ type: "tool.result", toolCallId: id, result: { output, isError } }, second);
const ended = (reason: string, second: number, extra: Record<string, unknown> = {}): string => w("turn.ended", { reason, durationMs: 12_000, ...extra }, second);

/** A three-turn session: a picture and a hook part, tools of each kind, a failed turn, a stopped turn, compaction, a slash skill. */
const fixture = [
  meta(),
  bind(),
  w("usage.record", { model: "kimi-k2", inputTokens: 10 }),
  said("Fix the failing test", 1, { kind: "user" }, [
    { type: "text", text: "\n<hook>lint ok</hook>", meta: { source: "user prompt submit hook" } },
    { type: "image_url", imageUrl: { url: "blobref:image/png;0123abcd" } },
  ]),
  loop({ type: "step.begin", uuid: "s1" }, 2),
  think("Looking at the test first.", 2),
  think("secret", 2, true),
  text("I'll run the tests.", 2),
  call("call_1", "Bash", { command: "npm test" }, 3),
  loop({ type: "step.end", uuid: "s1" }, 3),
  result("call_1", "1 failing", 4),
  call("call_2", "Read", { path: `${cwd}/src/a.ts` }, 5),
  call("call_3", "Edit", { path: `${cwd}/src/a.ts`, old_string: "return a;", new_string: "return b;" }, 5),
  call("call_4", "Grep", { pattern: "compute\\(" }, 5),
  call("call_5", "FetchURL", { url: "https://example.com/docs" }, 5),
  call("call_6", "Agent", { description: "Explore the repo\nthoroughly", prompt: "Look around" }, 5),
  call("call_7", "TaskList", {}, 5),
  call("call_8", "Write", { path: `${cwd}/NOTES.md`, content: "one\ntwo\n", mode: "overwrite" }, 5),
  result("call_2", [{ type: "text", text: "export const a = 1;" }], 6),
  result("call_3", "ok", 6),
  result("call_4", "src/a.ts:1", 6),
  result("call_5", "<html>", 6),
  result("call_6", "Found it", 6),
  result("call_7", "none", 6),
  result("call_8", "written", 6),
  text("Fixed: **a** is now `b`.", 7),
  ended("completed", 8),
  said("Now deploy it", 20),
  call("call_9", "Bash", { command: "make deploy" }, 21),
  result("call_9", "permission denied", 22, true),
  ended("failed", 23, { error: { code: "provider", message: "Provider returned 500" } }),
  said("Try again", 30),
  text("Trying", 31),
  said("and use sudo", 31, { kind: "user", inTurn: true }),
  ended("cancelled", 32),
  w("context.apply_compaction", { summary: "…" }, 40),
  w("context.append_message", { message: { role: "user", content: [{ type: "text", text: "<skill body>" }], origin: { kind: "skill_activation", trigger: "user-slash", activationId: "a", skillName: "review", skillArgs: "src" } } }, 41),
  w("context.append_message", { message: { role: "user", content: [{ type: "text", text: "cron fired" }], origin: { kind: "cron" } } }, 41),
  text("Reviewed.", 42),
  ended("completed", 43),
].join("\n");

/** Line by line with offsets, as the feed reads it. */
function timeline(content: string): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("kimi");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of content.split("\n")) {
    const at = offset;
    offset += new TextEncoder().encode(line).length + 1;
    if (line === "") continue;
    builder.apply(parser.parse(line, at).events, at);
  }
  return { timeline: builder.timeline, stats: parser.stats };
}

describe("kimi wire: the fixture", () => {
  it("shows the user's messages, the thinking, the reply as markdown and the turn ends; every line is known", () => {
    const { timeline: built, stats } = timeline(fixture);
    expect(stats.malformed).toBe(0);
    expect(stats.unknown).toBe(0);
    expect(shown(built)).toEqual([
      "user:Fix the failing test",
      "progress:Looking at the test first.",
      "agent:I'll run the tests.",
      "tool:npm test",
      "tool:" + cwd + "/src/a.ts",
      "tool:" + cwd + "/src/a.ts",
      "tool:compute\\(",
      "tool:https://example.com/docs",
      "tool:Explore the repo",
      "tool:",
      "tool:" + cwd + "/NOTES.md",
      "agent:Fixed: **a** is now `b`.",
      "user:Now deploy it",
      "tool:make deploy",
      "agent:Error: Provider returned 500",
      "user:Try again",
      "agent:Trying",
      "user:and use sudo",
      "notice:" + noticeText("interrupted"),
      "notice:" + noticeText("compacted"),
      "user:/review src",
      "agent:Reviewed.",
    ]);
  });

  it("keeps the user's picture as an attachment and leaves out the hook's part", () => {
    const first = timeline(fixture).timeline.turns[0]!;
    const message = turnUserMessage(first)!;
    expect(message.text).toBe("Fix the failing test");
    expect(message.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(message.time).toBe(base / 1_000 + 1);
  });

  it("maps each tool to its nearest kind, with diffs, a failed call and an other row", () => {
    const turns = timeline(fixture).timeline.turns;
    const calls = turnToolCalls(turns[0]!);
    expect(calls.map((c) => [c.kind, c.toolName, c.state])).toEqual([
      ["bash", "Bash", "ok"],
      ["read", "Read", "ok"],
      ["edit", "Edit", "ok"],
      ["search", "Grep", "ok"],
      ["web", "FetchURL", "ok"],
      ["agent", "Agent", "ok"],
      [{ other: "TaskList" }, "TaskList", "ok"],
      ["edit", "Write", "ok"],
    ]);
    const edit = calls[2]!.detail;
    expect(edit.type === "diff" ? [edit.diff.added, edit.diff.removed] : null).toEqual([1, 1]);
    const write = calls[7]!.detail;
    expect(write.type === "diff" ? write.diff.added : null).toBe(2);
    expect(calls[0]!.detail.type).toBe("bash");
    expect(turnToolCalls(turns[1]!).map((c) => c.state)).toEqual(["failed"]);
  });

  it("ends a completed turn with its duration, a failed one after its error, a stopped one with the Interrupted row", () => {
    const turns = timeline(fixture).timeline.turns;
    // The compaction row stands alone between turns (as Claude's does), then the slash skill's turn.
    expect(turns.map((turn) => turn.isFinished)).toEqual([true, true, true, true, true]);
    expect(shown({ ...timeline(fixture).timeline, turns: [turns[2]!] })).toEqual(["user:Try again", "agent:Trying", "user:and use sudo", "notice:" + noticeText("interrupted")]);
    expect(turns[0]!.reportedDuration).toBe(12);
    expect(turnFooter(turns[0]!)).not.toBeNull();
    expect(turnFooter(turns[2]!)).toBeNull();
  });

  it("gives the same line read twice the same ids, and a clone carries the folder and a refusal", () => {
    const line = said("Hello", 1);
    const one = new TranscriptParser("kimi").parse(line, 4_096).events;
    const two = new TranscriptParser("kimi").parse(line, 4_096).events;
    expect(one).toEqual(two);
    expect(JSON.stringify(one)).toContain("kimi-prompt-at4096");
    const parser = new KimiWireParser();
    parser.parse(bind());
    expect(parser.clone().cwd).toBe(cwd);
    parser.parse(meta("2.0"));
    expect(parser.clone().parse(said("x", 1)).outcome.kind).toBe("unknown");
  });

  it("takes the folder from profile.bind or config.update only, never a relative or controlled one", () => {
    const parser = new TranscriptParser("kimi");
    expect(parser.cwd).toBeNull();
    parser.parse(w("profile.bind", { environmentDisclosure: { cwd: "relative/dir" } }), 0);
    expect(parser.cwd).toBeNull();
    parser.parse(w("profile.bind", { environmentDisclosure: { cwd: "/Users/fixture/a\u0007b" } }), 0);
    expect(parser.cwd).toBeNull();
    parser.parse(bind(cwd + "/"), 0);
    expect(parser.cwd).toBe(cwd);
    parser.parse(w("config.update", { environmentDisclosure: { cwd: "/Users/fixture/other" } }), 10);
    expect(parser.cwd).toBe("/Users/fixture/other");
  });
});

describe("kimi wire: what is left out", () => {
  it("never shows a reminder with no origin, the user's ! shell line, a cron prompt or a compaction summary as the user's", () => {
    const lines = [
      meta(),
      said("<system-reminder>be brief</system-reminder>", 1, null),
      said("ls", 2, { kind: "shell_command" }),
      said("cron fired", 3, { kind: "cron" }),
      said("Summary of earlier work", 4, { kind: "compaction_summary" }),
      said("A plugin's own prompt", 5, { kind: "plugin_command", trigger: "model", commandName: "x" }),
      said("Old wire message", 6, null),
    ].join("\n");
    expect(shown(timeline(lines).timeline)).toEqual(["user:Old wire message"]);
  });

  it("marks a message sent while Kimi works as queued", () => {
    const parsed = new KimiWireParser().parse(said("and use sudo", 1, { kind: "user", inTurn: true }));
    expect(parsed.events).toMatchObject([{ type: "userMessage", queued: true }]);
  });
});

describe("kimi wire: versions and broken lines", () => {
  it("reads 1.x wires whose minimum reader is at most 1.5", () => {
    expect(kimiWireReadable("1.5", "1.5")).toBe(true);
    expect(kimiWireReadable("1.0", undefined)).toBe(true);
    expect(kimiWireReadable("1.9", "1.4")).toBe(true);
    expect(kimiWireReadable("1.6", "1.6")).toBe(false);
    expect(kimiWireReadable("2.0", "1.0")).toBe(false);
    expect(kimiWireReadable(2, "1.0")).toBe(false);
    expect(kimiWireReadable("1.5", "x")).toBe(false);
  });

  it("makes every line after a newer wire's metadata unknown, so the format check refuses it", () => {
    const newer = [meta("2.0", "2.0"), bind(), said("Hello", 1), text("Hi", 2), ended("completed", 3)].join("\n");
    const { timeline: built, stats } = timeline(newer);
    expect(shown(built)).toEqual([]);
    expect(stats.unknown).toBe(5);
    const needsNewer = [meta("1.7", "1.6"), said("Hello", 1)].join("\n");
    expect(shown(timeline(needsNewer).timeline)).toEqual([]);
  });

  it("counts a record type it does not know as unknown, and a cut last line as malformed with nothing shown", () => {
    const parser = new TranscriptParser("kimi");
    expect(parser.parse(w("brand.new_record", {}), 0).outcome).toEqual({ kind: "unknown", type: "brand.new_record" });
    const whole = said("Hello there", 1);
    const cut = parser.parse(whole.slice(0, whole.length - 9), 100);
    expect(cut.outcome.kind).toBe("malformed");
    expect(cut.events).toEqual([]);
    expect(parser.parse("[1,2]", 200).outcome.kind).toBe("malformed");
  });

  it("reads wire 1.0's whole assistant and tool messages (function: {name, arguments})", () => {
    const old = [
      meta("1.0", undefined),
      said("List files", 1),
      w("context.append_message", { message: { role: "assistant", content: [{ type: "text", text: "Listing." }], toolCalls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"make build"}' } }] } }, 2),
      w("context.append_message", { message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "a.ts" }] } }, 3),
      ended("completed", 4),
    ].join("\n");
    const built = timeline(old).timeline;
    expect(shown(built)).toEqual(["user:List files", "agent:Listing.", "tool:make build"]);
    expect(turnToolCalls(built.turns[0]!).map((c) => [c.kind, c.state])).toEqual([["bash", "ok"]]);
  });

  it("reads times in milliseconds or seconds", () => {
    expect(kimiTime(base)).toBe(base / 1_000);
    expect(kimiTime(1_793_502_000)).toBe(1_793_502_000);
    expect(kimiTime(-1)).toBeNull();
    expect(kimiTime("1")).toBeNull();
  });
});
