// ClineStoreParser on synthetic lines, each message as Cline stores it (never a real session):
// Anthropic-shaped messages with content blocks (cline 5413dc1 sdk/packages/core/docs/messages-contract-v1.md;
// sdk/packages/core/fixtures/session/session.messages.json: text, file, tool_use, tool_result); the user's text as
// the runtime wraps it (`<user_input mode="…">`, `<mode_notice>`, sdk/packages/shared/src/prompt/format.ts:134-193);
// tool names and inputs from sdk/packages/core/src/extensions/tools/schemas.ts:57-232 (read_files `files`,
// search_codebase `queries`, run_commands `commands`, fetch_web_content `requests`, editor `path`,
// `old_text`, `new_text`, `insert_line`). The envelope around each message is ClineStoreSource's
// (agents/cline-store.ts).

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { turnToolCalls, turnUserMessage, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { clineUserText } from "../src/shared/chat/agents/cline-parser";

const cwd = "/Users/fixture/project";
const t0 = 1_783_376_868_634;

let index = 0;
const message = (id: string, role: string, ts: number, content: readonly unknown[]): string => JSON.stringify({ cl: 1, i: index++, cwd, d: { id, role, content, ts } });
const use = (id: string, name: string, input: Record<string, unknown>): unknown => ({ type: "tool_use", id, name, input });
const result = (id: string, text: string, isError = false): unknown => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError });

function timelineOf(lines: readonly string[]): { timeline: ChatTimeline; parser: TranscriptParser } {
  const parser = new TranscriptParser("cline");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const text of lines) {
    builder.apply(parser.parse(text, offset).events, offset);
    offset += text.length + 1;
  }
  return { timeline: builder.timeline, parser };
}

/** A normal session: a prompt with a picture and a file, a step of tools, results, the reply; a second prompt. */
const session: string[] = [
  message("msg_1", "user", t0, [
    { type: "text", text: '<user_input mode="act">Fix the failing test</user_input>\n<mode_notice>Switched to act mode.</mode_notice>' },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    { type: "file", path: `${cwd}/src/sum.ts`, content: "export const sum = ..." },
  ]),
  message("msg_2", "assistant", t0 + 100, [
    { type: "thinking", thinking: "The test expects 3.", signature: "sig" },
    { type: "text", text: "Looking at it." },
    use("toolu_1", "run_commands", { commands: ["npm test"] }),
    use("toolu_2", "read_files", { files: [{ path: `${cwd}/src/sum.ts` }] }),
    use("toolu_3", "editor", { path: `${cwd}/src/sum.ts`, old_text: "a - b", new_text: "a + b" }),
    use("toolu_4", "search_codebase", { queries: ["sum\\("] }),
    use("toolu_5", "fetch_web_content", { requests: [{ url: "https://example.com/docs", prompt: "summarise" }] }),
    use("toolu_6", "skills", { skill: "testing" }),
  ]),
  message("msg_3", "user", t0 + 200, [
    result("toolu_1", "1 failed", true),
    result("toolu_2", "export const sum = ..."),
    result("toolu_3", "Edited"),
    result("toolu_4", "2 matches"),
    result("toolu_5", "403 Forbidden", true),
    result("toolu_6", "ok"),
  ]),
  message("msg_4", "assistant", t0 + 300, [{ type: "text", text: "Fixed: `sum` now **adds**." }]),
  message("msg_5", "user", t0 + 10_000, [{ type: "text", text: '<user_input mode="plan">Now refactor it</user_input>' }]),
];

describe("cline parser", () => {
  it("reads a normal session: the user's words (no wrapper or notice) and picture, thinking, tool rows by kind with results, the reply", () => {
    const { timeline, parser } = timelineOf(session);
    expect(parser.cwd).toBe(cwd);
    expect(timeline.turns).toHaveLength(2);
    const [first, second] = timeline.turns as [ChatTimeline["turns"][number], ChatTimeline["turns"][number]];
    const said = turnUserMessage(first)!;
    expect(said.text).toBe("Fix the failing test");
    expect(said.attachments).toEqual([{ path: null, mediaType: "image/png" }]);
    expect(said.time).toBe(t0 / 1_000);
    expect(first.items.filter((item) => item.type === "progress").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["The test expects 3."]);
    const calls = turnToolCalls(first);
    expect(calls.map((call) => call.kind)).toEqual(["bash", "read", "edit", "search", "web", { other: "skills" }]);
    expect(calls.map((call) => call.state)).toEqual(["failed", "ok", "ok", "ok", "failed", "ok"]);
    expect(calls[0]!.target).toContain("npm test");
    expect(calls[1]!.target).toBe(`${cwd}/src/sum.ts`);
    expect(calls[2]!.detail.type).toBe("diff");
    expect(calls[3]!.target).toBe("sum\\(");
    expect(calls[4]!.target).toBe("https://example.com/docs");
    expect(calls[5]!.target).toBe("testing");
    expect(first.items.filter((item) => item.type === "agentText").map((item) => (item.value as { markdown: string }).markdown)).toEqual(["Looking at it.", "Fixed: `sum` now **adds**."]);
    expect(first.isFinished).toBe(true);
    expect(turnUserMessage(second)!.text).toBe("Now refactor it");
    expect(second.isFinished).toBe(false);
    expect(parser.stats.unparseable).toBe(0);
  });

  it("strips Cline's wrappers as its own display does", () => {
    expect(clineUserText('<user_input mode="act">hello</user_input>')).toBe("hello");
    expect(clineUserText('<user_command slash="team">build it</user_command>')).toBe("build it");
    expect(clineUserText("<mode_notice>Plan mode.</mode_notice>keep this")).toBe("keep this");
    expect(clineUserText("a < b and c > d")).toBe("a < b and c > d");
  });

  it("skips the view's placeholders; malformed and too-large documents, another version, an unknown block or role are unrecognised", () => {
    const parser = new TranscriptParser("cline");
    expect(parser.parse('{"cl":1,"k":"bad","bad":"oversized"}').outcome).toEqual({ kind: "skipped", type: "cline oversized" });
    expect(parser.parse('{"cl":1,"k":"bad","bad":"changed"}').outcome).toEqual({ kind: "skipped", type: "cline changed" });
    expect(parser.parse('{"cl":1,"k":"bad","bad":"malformed"}').outcome).toEqual({ kind: "malformed" });
    expect(parser.parse('{"cl":1,"k":"bad","bad":"tooLarge"}').outcome).toEqual({ kind: "unknown", type: "cline too large" });
    expect(parser.parse('{"cl":1,"k":"version","v":"2"}').outcome).toEqual({ kind: "unknown", type: "cline version 2" });
    expect(parser.parse(message("msg_x", "assistant", t0, [{ type: "hologram" }])).outcome).toEqual({ kind: "unknown", type: "block hologram" });
    expect(parser.parse(message("msg_y", "system", t0, [{ type: "text", text: "?" }])).outcome).toEqual({ kind: "unknown", type: "system" });
    const whole = message("msg_z", "user", t0, [{ type: "text", text: "cut" }]);
    expect(parser.parse(whole.slice(0, whole.length - 3)).outcome).toEqual({ kind: "malformed" });
    expect(parser.stats.skipped).toBe(2);
  });
});
