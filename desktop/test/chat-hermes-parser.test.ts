// HermesStoreParser on synthetic lines, each row as Hermes writes it (never a real session):
// the columns of hermes-agent fb45ae7a hermes_state_common.py:537-567; `content` text, or "\x00json:" and the
// JSON of a multimodal list (hermes_state_messages.py:141-170, hermes_state.py:1633); `tool_calls` the OpenAI
// list (hermes_state_messages.py:93-104); the terminal's result `{"output", "exit_code", "error"}`
// (tools/terminal_tool.py:1066); tool names and arguments from tools/file_tools.py:1153-1296 (read_file,
// patch, search_files) and tools/todo_tool.py:227-260 (todo_list); a failed turn's `display_kind`
// "failed_turn" (agent/turn_failure_copy.py:75); a compaction's summary row `_compressed_summary = 1`.
// The envelope around each row is HermesStoreSource's (agents/hermes-store.ts).

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { hermesContent } from "../src/shared/chat/agents/hermes-parser";

const cwd = "/Users/fixture/project";
const t0 = 1_762_680_000;

interface Row {
  readonly role: string;
  readonly content?: string | null;
  readonly tool_calls?: unknown;
  readonly tool_call_id?: string;
  readonly tool_name?: string;
  readonly finish?: string;
  readonly reasoning?: string;
  readonly kind?: string;
  readonly summary?: number;
}

/** One line as the view lays it out: `{"hm":1,"id","cwd","d":<json_object of the row>}`. */
const line = (id: number, at: number, row: Row): string =>
  JSON.stringify({
    hm: 1,
    id,
    cwd,
    d: {
      id,
      role: row.role,
      content: row.content ?? null,
      tool_calls: row.tool_calls === undefined ? null : JSON.stringify(row.tool_calls),
      tool_call_id: row.tool_call_id ?? null,
      tool_name: row.tool_name ?? null,
      ts: at,
      finish: row.finish ?? null,
      reasoning: row.reasoning ?? null,
      kind: row.kind ?? null,
      summary: row.summary ?? 0,
    },
  });

const call = (id: string, name: string, args: Record<string, unknown>): unknown => ({ id, call_id: id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const result = (callID: string, name: string, content: string): Row => ({ role: "tool", tool_call_id: callID, tool_name: name, content });

function timelineOf(lines: readonly string[]): { timeline: ChatTimeline; parser: TranscriptParser } {
  const parser = new TranscriptParser("hermes");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const text of lines) {
    builder.apply(parser.parse(text, offset).events, offset);
    offset += text.length + 1;
  }
  return { timeline: builder.timeline, parser };
}

/** A normal session: a prompt with a picture, a tool step (five calls), the reply; a second prompt, a failed turn. */
const session: string[] = [
  line(1, t0, { role: "user", content: "\u0000json:" + JSON.stringify([{ type: "text", text: "Fix the failing test" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }]) }),
  line(2, t0 + 1, {
    role: "assistant",
    content: "",
    reasoning: "The test expects 3.",
    finish: "tool_calls",
    tool_calls: [
      call("call_1", "terminal", { command: "npm test" }),
      call("call_2", "read_file", { path: `${cwd}/src/sum.ts` }),
      call("call_3", "patch", { mode: "replace", path: `${cwd}/src/sum.ts`, old_string: "a - b", new_string: "a + b" }),
      call("call_4", "search_files", { pattern: "sum\\(", path: cwd }),
      call("call_5", "todo_list", { todos: [{ id: "1", content: "Fix sum", status: "completed" }, { id: "2", content: "Run tests", status: "in_progress" }] }),
      call("call_6", "skill_view", { name: "testing" }),
    ],
  }),
  line(3, t0 + 2, result("call_1", "terminal", JSON.stringify({ output: "1 failed", exit_code: 1, error: null }))),
  line(4, t0 + 2, result("call_2", "read_file", JSON.stringify({ content: "export const sum = ...", total_lines: 1 }))),
  line(5, t0 + 2, result("call_3", "patch", JSON.stringify({ success: true, diff: "..." }))),
  line(6, t0 + 2, result("call_4", "search_files", JSON.stringify({ total_count: 2, matches: [] }))),
  line(7, t0 + 2, result("call_5", "todo_list", JSON.stringify({ todos: [] }))),
  line(8, t0 + 2, result("call_6", "skill_view", "Skill not found")),
  line(9, t0 + 3, { role: "assistant", content: "Fixed: `sum` now **adds**.", finish: "stop" }),
  line(10, t0 + 10, { role: "user", content: "Now refactor it" }),
  line(11, t0 + 11, { role: "assistant", content: "The provider is overloaded.", kind: "failed_turn", finish: "stop" }),
];

describe("hermes parser", () => {
  it("reads a normal session: the user's words and picture, thinking, tool rows by kind with results, the reply, a failed turn", () => {
    const { timeline, parser } = timelineOf(session);
    expect(parser.cwd).toBe(cwd);
    expect(timeline.turns).toHaveLength(2);
    const [first, second] = timeline.turns as [ChatTimeline["turns"][number], ChatTimeline["turns"][number]];
    const message = turnUserMessage(first)!;
    expect(message.text).toBe("Fix the failing test");
    expect(message.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(message.time).toBe(t0);
    expect(first.items.filter((item) => item.type === "progress").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["The test expects 3."]);
    const calls = turnToolCalls(first);
    expect(calls.map((entry) => entry.kind)).toEqual(["bash", "read", "edit", "search", "plan", { other: "skill_view" }]);
    expect(calls.map((entry) => entry.state)).toEqual(["failed", "ok", "ok", "ok", "ok", "ok"]);
    expect(calls[0]!.target).toContain("npm test");
    expect(calls[1]!.target).toBe(`${cwd}/src/sum.ts`);
    expect(calls[2]!.detail.type).toBe("diff");
    expect(calls[4]!.detail).toEqual({ type: "plan", steps: [{ text: "Fix sum", status: "completed" }, { text: "Run tests", status: "inProgress" }] });
    expect(calls[5]!.target).toBe("testing");
    expect(first.items.filter((item) => item.type === "agentText").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["Fixed: `sum` now **adds**."]);
    expect(first.isFinished).toBe(true);
    expect(turnUserMessage(second)!.text).toBe("Now refactor it");
    expect(second.items.at(-1)).toMatchObject({ type: "agentText", value: { markdown: "Error: The provider is overloaded." } });
    expect(second.isFinished).toBe(true);
    expect(parser.stats.unparseable).toBe(0);
  });

  it("a step that calls tools does not end the turn; its results come by call id; one still running stays running", () => {
    const { timeline } = timelineOf([
      line(1, t0, { role: "user", content: "Run it" }),
      line(2, t0 + 1, { role: "assistant", content: "Running.", finish: "tool_calls", tool_calls: [call("call_a", "terminal", { command: "sleep 60" })] }),
    ]);
    const turn = timeline.turns[0]!;
    expect(turn.isFinished).toBe(false);
    expect(turnToolCalls(turn).map((entry) => entry.state)).toEqual(["running"]);
  });

  it("shows a compaction's summary as its row; hidden, system and session_meta rows are skipped", () => {
    const { timeline, parser } = timelineOf([
      line(1, t0, { role: "user", content: "[CONTEXT COMPACTION] Earlier turns were summarised: ...", summary: 1 }),
      line(2, t0 + 1, { role: "system", content: "You are Hermes." }),
      line(3, t0 + 1, { role: "session_meta", content: "{}" }),
      line(4, t0 + 1, { role: "user", content: "Continue from here.", kind: "hidden" }),
      line(5, t0 + 2, { role: "user", content: "And the docs" }),
    ]);
    const items = timeline.turns.flatMap((turn) => turn.items);
    expect(items[0]).toMatchObject({ type: "notice", value: { kind: "compacted" } });
    expect(timeline.turns.map((turn) => turnUserMessage(turn)?.text ?? null)).toContain("And the docs");
    expect(parser.stats.skipped).toBe(3);
    expect(parser.stats.unparseable).toBe(0);
  });

  it("skips the view's placeholders; a cut-off line is malformed; a database it can't read, another envelope or role is unknown", () => {
    const parser = new TranscriptParser("hermes");
    expect(parser.parse('{"hm":1,"k":"bad","bad":"oversized"}').outcome).toEqual({ kind: "skipped", type: "hermes oversized" });
    expect(parser.parse('{"hm":1,"k":"bad","bad":"changed"}').outcome).toEqual({ kind: "skipped", type: "hermes changed" });
    const whole = line(1, t0, { role: "user", content: "hi" });
    expect(parser.parse(whole.slice(0, whole.length - 5)).outcome).toEqual({ kind: "malformed" });
    expect(parser.parse('{"hm":1,"k":"unknown","why":"no messages.active"}').outcome.kind).toBe("unknown");
    expect(parser.parse(JSON.stringify({ hm: 2, id: 1, d: {} })).outcome.kind).toBe("unknown");
    expect(parser.parse(line(2, t0, { role: "critic", content: "?" })).outcome).toEqual({ kind: "unknown", type: "critic" });
    expect(parser.stats.skipped).toBe(2);
  });

  it("decodes Hermes's content: plain text, the reserved-prefix JSON list, a wrapped literal, a bad marker as text", () => {
    expect(hermesContent("plain")).toEqual({ text: "plain", pictures: [] });
    expect(hermesContent("\u0000json:" + JSON.stringify([{ type: "text", text: "a" }, { type: "text", text: "b" }]))).toEqual({ text: "a\n\nb", pictures: [] });
    // A literal string with the prefix is stored JSON-string-wrapped (hermes_state_messages.py:149-151).
    expect(hermesContent("\u0000json:" + JSON.stringify("\u0000json:not structure")).text).toBe("\u0000json:not structure");
    expect(hermesContent("\u0000json:{bad").text).toBe("\u0000json:{bad");
    expect(hermesContent(null)).toEqual({ text: "", pictures: [] });
  });
});
