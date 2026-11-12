// OpenCodeStoreParser on synthetic lines, each row's data built from the agents' own
// types (never a real session): V1 (OpenCode 1.x, Kilo) from opencode v1.18.29
// packages/schema/src/v1/session.ts (messages, parts, tool states, named errors) and the tools'
// inputs (packages/opencode/src/tool/*.ts); V2 from opencode 2.2.5 packages/schema/src/session-message.ts.
// The envelope around each row is OpenCodeStoreView's (agents/opencode-store.ts).

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";

const cwd = "/Users/fixture/project";
const t0 = 1_762_680_000_000;

const v1Part = (id: string, mid: string, role: string, t: number, d: unknown): string => JSON.stringify({ oc: "v1", k: "part", id, mid, role, t, cwd, d });
const v1User = (id: string, t: number): string => JSON.stringify({ oc: "v1", k: "user", id, t, cwd });
const v1Message = (id: string, role: string, t: number, d: unknown): string => JSON.stringify({ oc: "v1", k: "msg", id, role, t, cwd, d });
const v2Message = (id: string, type: string, seq: number, t: number, d: unknown): string => JSON.stringify({ oc: "v2", k: "msg", id, type, seq, t, cwd, d });

/** A V1 assistant message (session.ts Assistant), minus its ids. */
const assistant = (created: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: "assistant",
  time: { created, completed: created + 900 },
  parentID: "msg_c0ffee0000011AAAAAAAAAAAAAA",
  modelID: "claude-sonnet-4",
  providerID: "anthropic",
  mode: "build",
  agent: "build",
  path: { cwd, root: cwd },
  cost: 0,
  tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
  ...fields,
});

const tool = (callID: string, name: string, state: Record<string, unknown>): Record<string, unknown> => ({ type: "tool", callID, tool: name, state });
const done = (input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}, start = t0 + 1_000): Record<string, unknown> => ({
  status: "completed",
  input,
  output,
  title: "",
  metadata,
  time: { start, end: start + 500 },
});

function timelineOf(format: "opencode" | "kilo", lines: readonly string[]): { timeline: ChatTimeline; parser: TranscriptParser } {
  const parser = new TranscriptParser(format);
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    builder.apply(parser.parse(line, offset).events, offset);
    offset += line.length + 1;
  }
  return { timeline: builder.timeline, parser };
}

/** A normal V1 session: a prompt with a picture, two steps (tools, then the reply), a second prompt the user stops. */
const v1Session: string[] = [
  v1Part("prt_01", "msg_01", "user", t0, { type: "text", text: "Fix the failing test" }),
  v1Part("prt_02", "msg_01", "user", t0, { type: "text", text: "Called the Read tool with the following input: {}", synthetic: true }),
  v1Part("prt_03", "msg_01", "user", t0, { type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,iVBORw0KGgo=" }),
  v1User("msg_01", t0),
  v1Part("prt_04", "msg_02", "assistant", t0 + 100, { type: "step-start", snapshot: "4b825dc6" }),
  v1Part("prt_05", "msg_02", "assistant", t0 + 100, { type: "reasoning", text: "The test expects 3.", time: { start: t0 + 200, end: t0 + 300 } }),
  v1Part("prt_06", "msg_02", "assistant", t0 + 100, tool("toolu_1", "bash", done({ command: "npm test", description: "Run the tests" }, "1 failed", { exit: 1 }))),
  v1Part("prt_07", "msg_02", "assistant", t0 + 100, tool("toolu_2", "read", done({ filePath: `${cwd}/src/sum.ts` }, "export const sum = ..."))),
  v1Part("prt_08", "msg_02", "assistant", t0 + 100, tool("toolu_3", "edit", done({ filePath: `${cwd}/src/sum.ts`, oldString: "a - b", newString: "a + b" }, "Edit applied"))),
  v1Part("prt_09", "msg_02", "assistant", t0 + 100, tool("toolu_4", "grep", done({ pattern: "sum\\(", path: cwd }, "2 matches"))),
  v1Part("prt_10", "msg_02", "assistant", t0 + 100, tool("toolu_5", "write", done({ filePath: `${cwd}/NOTES.md`, content: "one\ntwo\n" }, "Wrote file"))),
  v1Part("prt_11", "msg_02", "assistant", t0 + 100, tool("toolu_6", "todowrite", done({ todos: [{ content: "Fix sum", status: "completed", priority: "high" }, { content: "Run tests", status: "in_progress", priority: "high" }] }, "2 todos"))),
  v1Part("prt_12", "msg_02", "assistant", t0 + 100, tool("toolu_7", "webfetch", { status: "error", input: { url: "https://example.com" }, error: "403 Forbidden", time: { start: t0 + 1_000, end: t0 + 1_100 } })),
  v1Part("prt_13", "msg_02", "assistant", t0 + 100, tool("toolu_8", "context7_resolve", done({ query: "vitest config" }, "ok"))),
  v1Part("prt_14", "msg_02", "assistant", t0 + 100, { type: "step-finish", reason: "tool-calls", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
  v1Message("msg_02", "assistant", t0 + 100, assistant(t0 + 100, { finish: "tool-calls" })),
  v1Part("prt_15", "msg_03", "assistant", t0 + 2_000, { type: "text", text: "Fixed: `sum` now **adds**.", time: { start: t0 + 2_100, end: t0 + 2_200 } }),
  v1Message("msg_03", "assistant", t0 + 2_000, assistant(t0 + 2_000, { finish: "stop" })),
  v1Part("prt_16", "msg_04", "user", t0 + 10_000, { type: "text", text: "Now refactor it" }),
  v1User("msg_04", t0 + 10_000),
  v1Part("prt_17", "msg_05", "assistant", t0 + 10_100, tool("toolu_9", "task", { status: "running", input: { description: "Refactor sum", prompt: "Refactor sum.ts", subagent_type: "general" }, time: { start: t0 + 10_200 } })),
  v1Message("msg_05", "assistant", t0 + 10_100, assistant(t0 + 10_100, { error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } } })),
];

describe("opencode parser: V1 (OpenCode 1.x and Kilo)", () => {
  it("reads a normal session: the user's words and picture, thinking, tool rows by kind with results, the reply, the turn's end, the user's stop", () => {
    const { timeline, parser } = timelineOf("opencode", v1Session);
    expect(parser.cwd).toBe(cwd);
    expect(timeline.turns).toHaveLength(2);
    const [first, second] = timeline.turns as [ChatTimeline["turns"][number], ChatTimeline["turns"][number]];
    const message = turnUserMessage(first)!;
    expect(message.text).toBe("Fix the failing test");
    expect(message.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(message.time).toBe(t0 / 1_000);
    expect(first.items.filter((item) => item.type === "progress").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["The test expects 3."]);
    const calls = turnToolCalls(first);
    expect(calls.map((call) => call.kind)).toEqual(["bash", "read", "edit", "search", "edit", "plan", "web", { other: "context7_resolve" }]);
    expect(calls.map((call) => call.state)).toEqual(["failed", "ok", "ok", "ok", "ok", "ok", "failed", "ok"]);
    expect(calls[0]!.target).toContain("npm test");
    expect(calls[1]!.target).toBe(`${cwd}/src/sum.ts`);
    expect(calls[2]!.detail.type).toBe("diff");
    expect(calls[4]!.detail.type).toBe("diff");
    expect(calls[5]!.detail).toEqual({ type: "plan", steps: [{ text: "Fix sum", status: "completed" }, { text: "Run tests", status: "inProgress" }] });
    expect(calls[7]!.target).toBe("vitest config");
    expect(first.items.filter((item) => item.type === "agentText").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["Fixed: `sum` now **adds**."]);
    expect(first.isFinished).toBe(true);
    // The second prompt: a subagent call that did not finish, then the user's stop.
    expect(turnUserMessage(second)!.text).toBe("Now refactor it");
    const task = turnToolCalls(second)[0]!;
    expect([task.kind, task.target, task.state]).toEqual(["agent", "Refactor sum", "failed"]);
    expect(second.items.at(-1)).toMatchObject({ type: "notice", value: { kind: "interrupted" } });
    expect(second.isFinished).toBe(true);
    // Nothing it was given went unrecognised.
    expect(parser.stats.unparseable).toBe(0);
  });

  it("reads Kilo's rows the same way (the same schema; its step-finish carries a time too)", () => {
    const lines = [
      ...v1Session.slice(0, 4),
      v1Part("prt_k1", "msg_k2", "assistant", t0 + 100, { type: "text", text: "Done.", time: { start: t0 + 150, end: t0 + 160 } }),
      v1Part("prt_k2", "msg_k2", "assistant", t0 + 100, { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, time: { start: t0 + 100, end: t0 + 200, elapsed: 100 } }),
      v1Message("msg_k2", "assistant", t0 + 100, assistant(t0 + 100, { finish: "stop" })),
    ];
    const { timeline, parser } = timelineOf("kilo", lines);
    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]!.isFinished).toBe(true);
    expect(parser.stats.unparseable).toBe(0);
  });

  it("says an error the step ended with, and ends the turn", () => {
    const lines = [
      v1Part("prt_e1", "msg_e1", "user", t0, { type: "text", text: "hello" }),
      v1User("msg_e1", t0),
      v1Message("msg_e2", "assistant", t0 + 100, assistant(t0 + 100, { error: { name: "APIError", data: { message: "Overloaded", isRetryable: true } } })),
    ];
    const turn = timelineOf("opencode", lines).timeline.turns[0]!;
    expect(turn.items.at(-1)).toMatchObject({ type: "agentText", value: { markdown: "Error: Overloaded" } });
    expect(turn.isFinished).toBe(true);
  });

  it("shows a compaction as its row and skips the summary it wrote", () => {
    const lines = [
      v1Part("prt_c1", "msg_c1", "user", t0, { type: "compaction", auto: true }),
      v1User("msg_c1", t0),
      v1Part("prt_c2", "msg_c2", "summary", t0 + 100, { type: "text", text: "Summary: we fixed sum.", time: { start: t0, end: t0 + 1 } }),
      v1Message("msg_c2", "summary", t0 + 100, assistant(t0 + 100, { summary: true, finish: "stop" })),
    ];
    const { timeline, parser } = timelineOf("opencode", lines);
    const items = timeline.turns.flatMap((turn) => turn.items);
    expect(items.map((item) => item.type)).toEqual(["notice"]);
    expect(items[0]).toMatchObject({ value: { kind: "compacted" } });
    expect(parser.stats.skipped).toBe(3);
  });

  it("skips the view's placeholders and counts them; a cut-off last line is malformed; a newer envelope or part type is unknown", () => {
    const parser = new TranscriptParser("opencode");
    expect(parser.parse('{"oc":"v1","k":"bad","bad":"oversized","id":"prt_x"}').outcome).toEqual({ kind: "skipped", type: "opencode oversized" });
    expect(parser.parse('{"oc":"v1","k":"bad","bad":"notJSON","id":"prt_y"}').outcome).toEqual({ kind: "skipped", type: "opencode notJSON" });
    const whole = v1Part("prt_p", "msg_p", "assistant", t0, { type: "text", text: "partial", time: { start: t0, end: t0 + 1 } });
    expect(parser.parse(whole.slice(0, whole.length - 7)).outcome).toEqual({ kind: "malformed" });
    expect(parser.parse(JSON.stringify({ oc: "v3", k: "msg", d: {} })).outcome.kind).toBe("unknown");
    expect(parser.parse(v1Part("prt_q", "msg_q", "assistant", t0, { type: "hologram" })).outcome).toEqual({ kind: "unknown", type: "part hologram" });
    expect(parser.stats.skipped).toBe(2);
    expect(parser.stats.unparseable).toBe(3);
  });

  it("keeps a prompt's parts across a clone (a parser carried over a read's end)", () => {
    const parser = new TranscriptParser("opencode");
    parser.parse(v1Part("prt_a", "msg_a", "user", t0, { type: "text", text: "carried" }));
    const copy = parser.clone();
    const events = copy.parse(v1User("msg_a", t0)).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "userMessage", message: { text: "carried" } });
  });
});

describe("opencode parser: V2 (OpenCode 2.x)", () => {
  /** session-message.ts: User, Assistant (content: text, reasoning, tool), Shell, Compaction, Idle. */
  const v2Session: string[] = [
    v2Message("msg_v1", "model-switched", 1, t0, { id: "msg_v1", type: "model-switched", model: { providerID: "anthropic", id: "claude-sonnet-4" }, time: { created: t0 } }),
    v2Message("msg_v2", "user", 2, t0, {
      id: "msg_v2",
      type: "user",
      text: "Why is CI red?",
      files: [{ data: "iVBORw0KGgo=", mime: "image/jpeg", source: { type: "inline" }, name: "ci.jpg" }],
      time: { created: t0 },
    }),
    v2Message("msg_v3", "assistant", 3, t0 + 100, {
      id: "msg_v3",
      type: "assistant",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4" },
      content: [
        { type: "reasoning", text: "Check the log.", time: { created: t0 + 110, completed: t0 + 120 } },
        { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: { command: "gh run view --log-failed" }, content: [{ type: "text", text: "lint failed" }], metadata: { exit: 1 } }, time: { created: t0 + 130, completed: t0 + 140 } },
        { type: "tool", id: "call_2", name: "patch", state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-let x = 1\n+const x = 1\n*** End Patch" }, content: [{ type: "text", text: "applied" }] }, time: { created: t0 + 150 } },
        { type: "tool", id: "call_3", name: "subagent", state: { status: "error", input: { agent: "explore", description: "Find callers", prompt: "Find callers of x" }, error: { type: "tool", message: "cancelled" } }, time: { created: t0 + 160 } },
        { type: "text", text: "CI fails on lint; fixed `let` → `const`." },
      ],
      finish: "stop",
      time: { created: t0 + 100, completed: t0 + 900 },
    }),
    v2Message("msg_v4", "idle", 4, t0 + 950, { id: "msg_v4", type: "idle", outcome: "succeeded", time: { created: t0 + 950 } }),
    v2Message("msg_v5", "shell", 5, t0 + 5_000, { id: "msg_v5", type: "shell", shellID: "shl_1", command: "git status", status: "exited", exit: 0, output: { output: "clean", cursor: 5, size: 5, truncated: false }, time: { created: t0 + 5_000, completed: t0 + 5_100 } }),
    v2Message("msg_v6", "compaction", 6, t0 + 6_000, { id: "msg_v6", type: "compaction", status: "completed", reason: "manual", summary: "We fixed lint.", time: { created: t0 + 6_000 } }),
    v2Message("msg_v7", "user", 7, t0 + 7_000, { id: "msg_v7", type: "user", text: "Run it again", time: { created: t0 + 7_000 } }),
    v2Message("msg_v8", "assistant", 8, t0 + 7_100, { id: "msg_v8", type: "assistant", agent: "build", model: { providerID: "anthropic", id: "x" }, content: [], error: { type: "aborted", message: "Aborted" }, time: { created: t0 + 7_100, completed: t0 + 7_200 } }),
    v2Message("msg_v9", "idle", 9, t0 + 7_300, { id: "msg_v9", type: "idle", outcome: "interrupted", time: { created: t0 + 7_300 } }),
    v2Message("msg_va", "user", 10, t0 + 8_000, { id: "msg_va", type: "user", text: "Try once more", time: { created: t0 + 8_000 } }),
    v2Message("msg_vb", "idle", 11, t0 + 8_100, { id: "msg_vb", type: "idle", outcome: "failed", error: { type: "provider", message: "Rate limited" }, time: { created: t0 + 8_100 } }),
  ];

  it("reads a normal session: the user's words and picture, thinking, tools by kind, the reply, the turn's end; a `!` command; a compaction; the user's stop; a failure", () => {
    const { timeline, parser } = timelineOf("opencode", v2Session);
    expect(parser.stats.unparseable).toBe(0);
    const turns = timeline.turns;
    const first = turns[0]!;
    expect(turnUserMessage(first)).toMatchObject({ text: "Why is CI red?", attachments: [{ path: null, mediaType: "image/jpeg" }], time: t0 / 1_000 });
    const calls = turnToolCalls(first);
    expect(calls.map((call) => [call.kind, call.state])).toEqual([
      ["bash", "failed"],
      ["edit", "ok"],
      ["agent", "failed"],
    ]);
    expect(calls[1]!.target).toBe("src/a.ts");
    expect(first.items.at(-1)).toMatchObject({ type: "agentText", value: { markdown: "CI fails on lint; fixed `let` → `const`." } });
    expect(first.isFinished).toBe(true);
    const shell = turns.flatMap(turnToolCalls).find((call) => call.isUserShell)!;
    expect([shell.kind, shell.target, shell.state]).toEqual(["bash", "git status", "ok"]);
    expect(turns.flatMap((turn) => turn.items).some((item) => item.type === "notice" && item.value.kind === "compacted")).toBe(true);
    const stopped = turns.find((turn) => turnUserMessage(turn)?.text === "Run it again")!;
    // The user's stop: the stop row, not the abort's error text.
    expect(stopped.items.map((item) => item.type)).toEqual(["user", "notice"]);
    expect(stopped.isFinished).toBe(true);
    const failed = turns.at(-1)!;
    expect(failed.items.at(-1)).toMatchObject({ type: "agentText", value: { markdown: "Error: Rate limited" } });
    expect(failed.isFinished).toBe(true);
  });

  it("calls a message type it does not know unknown", () => {
    const parser = new TranscriptParser("opencode");
    expect(parser.parse(v2Message("msg_z", "hologram", 1, t0, { id: "msg_z", type: "hologram", time: { created: t0 } })).outcome).toEqual({ kind: "unknown", type: "hologram" });
    expect(parser.parse(v2Message("msg_y", "system", 2, t0, { id: "msg_y", type: "system", text: "Instructions updated", time: { created: t0 } })).outcome.kind).toBe("skipped");
  });
});
