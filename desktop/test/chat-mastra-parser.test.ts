// MastraStoreParser on synthetic lines, each part as Mastra stores it (never a real thread):
// AI SDK v4 UI parts (mastra 6dec94bc packages/core/src/agent/message-list/state/types.ts:24-130: text,
// reasoning with details, tool-invocation with state result / output-error / output-denied and errorText,
// step-start, file); Mastra Code's tool names (mastracode/sdk/src/tool-names.ts:14-45, the workspace's
// remapped names) and their inputs (packages/core/src/workspace/tools/execute-command.ts:18-22,
// edit-file.ts:39-48). The envelope around each part is MastraStoreSource's (agents/mastra-store.ts).

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";

const cwd = "/Users/fixture/project";
const t0 = 1_762_683_300_000;

const part = (id: number, role: string, index: number, t: number, d: unknown): string => JSON.stringify({ ms: 1, k: "part", role, i: index, id, t, cwd, d });
const user = (id: number, t: number): string => JSON.stringify({ ms: 1, k: "user", id, t, cwd });
const end = (id: number, t: number): string => JSON.stringify({ ms: 1, k: "end", id, t, cwd });
const tool = (callID: string, name: string, args: Record<string, unknown>, fields: Record<string, unknown>): unknown => ({
  type: "tool-invocation",
  toolInvocation: { toolCallId: callID, toolName: name, args, ...fields },
});

function timelineOf(lines: readonly string[]): { timeline: ChatTimeline; parser: TranscriptParser } {
  const parser = new TranscriptParser("mastracode");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const text of lines) {
    builder.apply(parser.parse(text, offset).events, offset);
    offset += text.length + 1;
  }
  return { timeline: builder.timeline, parser };
}

/** A normal thread: a prompt with a picture; a step of tools and the reply; a second prompt whose step failed. */
const thread: string[] = [
  part(1, "user", 0, t0, { type: "text", text: "Fix the failing test" }),
  part(1, "user", 1, t0, { type: "file", mimeType: "image/png" }),
  user(1, t0),
  part(2, "assistant", 0, t0 + 100, { type: "step-start" }),
  part(2, "assistant", 1, t0 + 100, { type: "reasoning", reasoning: "", details: [{ type: "text", text: "The test expects 3." }] }),
  part(2, "assistant", 2, t0 + 100, tool("c1", "execute_command", { command: "npm test" }, { state: "result", result: { output: "1 failed", exitCode: 1 }, isError: true, errorText: "1 failed" })),
  part(2, "assistant", 3, t0 + 100, tool("c2", "view", { path: `${cwd}/src/sum.ts` }, { state: "result", result: "export const sum = ..." })),
  part(2, "assistant", 4, t0 + 100, tool("c3", "string_replace_lsp", { path: `${cwd}/src/sum.ts`, old_string: "a - b", new_string: "a + b" }, { state: "result", result: "Edited" })),
  part(2, "assistant", 5, t0 + 100, tool("c4", "search_content", { pattern: "sum\\(", path: cwd }, { state: "result", result: "2 matches" })),
  part(2, "assistant", 6, t0 + 100, tool("c5", "mastra_workspace_write_file", { path: `${cwd}/NOTES.md`, content: "one\n" }, { state: "result", result: "Wrote" })),
  part(2, "assistant", 7, t0 + 100, tool("c6", "lsp_inspect", { path: `${cwd}/src/sum.ts` }, { state: "output-denied" })),
  part(2, "assistant", 8, t0 + 100, tool("c7", "web-search", { query: "vitest config" }, { state: "output-error", errorText: "rate limited" })),
  part(2, "assistant", 9, t0 + 100, { type: "text", text: "Fixed: `sum` now **adds**." }),
  end(2, t0 + 100),
  part(3, "user", 0, t0 + 10_000, { type: "text", text: "Now refactor it" }),
  user(3, t0 + 10_000),
  part(4, "assistant", 0, t0 + 10_100, { type: "step-start" }),
  part(4, "assistant", 1, t0 + 10_100, { type: "error", error: { name: "APICallError", message: "Overloaded" } }),
  end(4, t0 + 10_100),
];

describe("mastra parser", () => {
  it("reads a normal thread: the user's words and picture, thinking, tool rows by kind and state, the reply, a failed step", () => {
    const { timeline, parser } = timelineOf(thread);
    expect(parser.cwd).toBe(cwd);
    expect(timeline.turns).toHaveLength(2);
    const [first, second] = timeline.turns as [ChatTimeline["turns"][number], ChatTimeline["turns"][number]];
    const message = turnUserMessage(first)!;
    expect(message.text).toBe("Fix the failing test");
    expect(message.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(message.time).toBe(t0 / 1_000);
    expect(first.items.filter((item) => item.type === "progress").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["The test expects 3."]);
    const calls = turnToolCalls(first);
    expect(calls.map((call) => call.kind)).toEqual(["bash", "read", "edit", "search", "edit", { other: "lsp_inspect" }, "web"]);
    expect(calls.map((call) => call.state)).toEqual(["failed", "ok", "ok", "ok", "ok", "failed", "failed"]);
    expect(calls[0]!.target).toContain("npm test");
    expect(calls[1]!.target).toBe(`${cwd}/src/sum.ts`);
    expect(calls[2]!.detail.type).toBe("diff");
    expect(calls[4]!.detail.type).toBe("diff");
    expect(calls[6]!.target).toBe("vitest config");
    expect(first.items.filter((item) => item.type === "agentText").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["Fixed: `sum` now **adds**."]);
    expect(first.isFinished).toBe(true);
    expect(turnUserMessage(second)!.text).toBe("Now refactor it");
    expect(second.items.at(-1)).toMatchObject({ type: "agentText", value: { markdown: "Error: Overloaded" } });
    expect(second.isFinished).toBe(true);
    expect(parser.stats.unparseable).toBe(0);
  });

  it("a reply without its end line has not ended; a call shown still `call` did not finish", () => {
    const { timeline } = timelineOf([
      part(1, "user", 0, t0, { type: "text", text: "Run it" }),
      user(1, t0),
      part(2, "assistant", 0, t0 + 1, { type: "text", text: "Running." }),
      part(2, "assistant", 1, t0 + 1, tool("c1", "execute_command", { command: "sleep 1" }, { state: "call" })),
    ]);
    const turn = timeline.turns[0]!;
    expect(turn.isFinished).toBe(false);
    expect(turnToolCalls(turn).map((call) => call.state)).toEqual(["failed"]);
  });

  it("skips the view's placeholders and bookkeeping parts; a cut-off line is malformed; an unknown schema, format or part type is unknown", () => {
    const parser = new TranscriptParser("mastracode");
    expect(parser.parse('{"ms":1,"k":"bad","bad":"oversized"}').outcome).toEqual({ kind: "skipped", type: "mastra oversized" });
    expect(parser.parse('{"ms":1,"k":"bad","bad":"notJSON"}').outcome).toEqual({ kind: "skipped", type: "mastra notJSON" });
    expect(parser.parse(part(5, "assistant", 0, t0, { type: "source-url", url: "https://example.com" })).outcome.kind).toBe("skipped");
    expect(parser.parse(part(5, "assistant", 1, t0, { type: "data-progress", data: {} })).outcome.kind).toBe("skipped");
    const whole = part(5, "assistant", 2, t0, { type: "text", text: "cut" });
    expect(parser.parse(whole.slice(0, whole.length - 4)).outcome).toEqual({ kind: "malformed" });
    expect(parser.parse('{"ms":1,"k":"unknown","why":"no mastra_threads.metadata"}').outcome.kind).toBe("unknown");
    expect(parser.parse(JSON.stringify({ ms: 1, k: "version", v: "3", id: 6, t: t0, cwd })).outcome).toEqual({ kind: "unknown", type: "mastra format 3" });
    expect(parser.parse(part(6, "assistant", 0, t0, { type: "hologram" })).outcome).toEqual({ kind: "unknown", type: "part hologram" });
    expect(parser.parse(JSON.stringify({ ms: 2, k: "part" })).outcome.kind).toBe("unknown");
  });
});
