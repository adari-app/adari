// Antigravity CLI 1.5.13's own transcript.jsonl in Chat: test/fixtures/antigravity/transcript-real.jsonl is a real
// conversation (three turns that ran, two whose call was declined), read live, its paths replaced by neutral ones of
// the same length and nothing else changed. Its tools are `read_file`, `write_file`, `edit_file` and `run_command`,
// and every result is `GENERIC`: a planner's results follow it, one step per call, in call order (steps 6, 7 and 8 for
// step 5's three calls), and a declined call has no result step (13's call: 14 is never written; 17's: 18).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { parseInline } from "../src/shared/chat/markdown";
import { turnToolCalls, type ChatTimeline, type ChatToolCall } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { isSafeExternalUrl } from "../src/shared/external-url";
import { shown } from "./support/chat-lines";

const real = readFileSync(path.join(__dirname, "fixtures/antigravity/transcript-real.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.length > 0);
const work = "/tmp/demo/sample-folder/work";

function timeline(lines: readonly string[]): ChatTimeline {
  const parser = new TranscriptParser("antigravity");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    builder.apply(parser.parse(line, offset).events, offset);
    offset += Buffer.byteLength(line) + 1;
  }
  return builder.timeline;
}
const calls = (built: ChatTimeline): ChatToolCall[] => built.turns.flatMap((turn) => turnToolCalls(turn));
const row = (call: ChatToolCall): unknown[] => [call.toolName, call.kind, call.target, call.state, call.resultSummary];
const bash = (call: ChatToolCall) => (call.detail.type === "bash" ? call.detail.bash : null);
const diff = (call: ChatToolCall) => (call.detail.type === "diff" ? call.detail.diff : null);
/** One line of agy's, in its own shape. */
const step = (index: number, type: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ step_index: index, source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL", type, status: "DONE", created_at: `2026-11-20T02:50:${String(index).padStart(2, "0")}Z`, ...extra });
const planner = (index: number, ...tools: [string, Record<string, unknown>][]): string =>
  step(index, "PLANNER_RESPONSE", { tool_calls: tools.map(([name, args]) => ({ name, args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON.stringify(value)])) })) });
const prompt = (index: number, text: string): string =>
  step(index, "USER_INPUT", { content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20T06:50:00+04:00.\n</ADDITIONAL_METADATA>` });
const generic = (index: number, content: string): string =>
  step(index, "GENERIC", { content: `Created At: 2026-11-20T06:50:00+04:00\nCompleted At: 2026-11-20T06:50:01+04:00\n${content}` });

describe("agy 1.5.13's real transcript, turn by turn", () => {
  const built = timeline(real);

  it("five turns: each user request and the final answers, nothing of the metadata, the system reminders or the thinking", () => {
    expect(built.turns).toHaveLength(5);
    expect(shown(built).filter((item) => !item.startsWith("tool:"))).toEqual([
      "user:Read notes.txt in this folder and tell me its second line in one short sentence.",
      `agent:The second line of [notes.txt](file://${work}/notes.txt#L2) is \`beta\`.`,
      "user:Do three things in this folder: run ls -la, append the line delta to notes.txt, then create hello.py that prints hi and run it with python3. Answer in two short sentences.",
      `agent:I ran \`ls -la\` (which showed only [notes.txt](file://${work}/notes.txt) initially) and appended \`delta\` to [notes.txt](file://${work}/notes.txt). I also created [hello.py](file://${work}/hello.py) and ran it with \`python3\`, which printed \`hi\`.`,
      "user:Create the file ask.txt containing the single word hello.",
      "user:Run the shell command: date",
      "user:Change the first line of notes.txt from alpha to ALPHA.",
      `agent:Updated the first line of [notes.txt](file://${work}/notes.txt#L1) from \`alpha\` to \`ALPHA\`.`,
    ]);
    const all = JSON.stringify(built);
    for (const hidden of ["Initial plan is to execute", "ADDITIONAL_METADATA", "SYSTEM_MESSAGE", "Reminder: work efficiently", "Model Selection"]) expect(all).not.toContain(hidden);
    expect(built.turns.map((turn) => turn.isFinished)).toEqual([true, true, true, true, true]);
  });

  it("every call is a row of its kind with its target, and ends: none stays running, none is a GENERIC row", () => {
    expect(calls(built).map(row)).toEqual([
      ["read_file", "read", `${work}/notes.txt`, "ok", "3 lines"],
      // `ls -la` is a search row, as every agent's `ls` is (the shell classifier's rule, tools.ts).
      ["run_command", "search", ".", "ok", "4 files"],
      ["write_file", "edit", `${work}/notes.txt`, "ok", "+2 −0"],
      ["write_file", "edit", `${work}/hello.py`, "ok", "+1 −0"],
      ["run_command", "bash", "python3 hello.py", "ok", "exit 0"],
      // Declined (no result step): settled when the next user message came.
      ["write_file", "edit", `${work}/ask.txt`, "failed", "failed"],
      ["run_command", "bash", "date", "failed", "failed"],
      ["edit_file", "edit", `${work}/notes.txt`, "ok", "+1 −1"],
    ]);
    expect(JSON.stringify(built)).not.toContain("GENERIC");
    expect(calls(built).some((call) => call.state === "running")).toBe(false);
  });

  it("each call is in its own turn", () => {
    expect(built.turns.map((turn) => turnToolCalls(turn).map((call) => call.toolName))).toEqual([
      ["read_file"],
      ["run_command", "write_file", "write_file", "run_command"],
      ["write_file"],
      ["run_command"],
      ["edit_file"],
    ]);
  });

  it("a command's exit code and output go where a command's do (the output after agy's header, carriage returns off)", () => {
    expect(bash(calls(built)[4]!)).toEqual({ command: "python3 hello.py", outputTail: ["hi"], exitCode: 0 });
    const ls = calls(built)[1]!;
    const listed = ls.detail.type === "search" ? ls.detail.search.files : [];
    expect(listed).toContain("-rw-r--r--@ 1 usr  staff   17 Nov 20 06:46 notes.txt");
    expect(JSON.stringify(ls.detail)).not.toContain("Command exited");
    expect(JSON.stringify(ls.detail)).not.toContain("\\r");
  });

  it("writes and edits show their change from the call's own arguments (Append, Overwrite, Target, Replacement)", () => {
    const pairs = (call: ChatToolCall) => diff(call)?.lines.map((line) => [line.kind, line.text]);
    expect(pairs(calls(built)[2]!)).toEqual([
      ["added", ""],
      ["added", "delta"],
    ]);
    expect(pairs(calls(built)[3]!)).toEqual([["added", 'print("hi")']]);
    expect(pairs(calls(built)[7]!)).toEqual([
      ["removed", "alpha"],
      ["added", "ALPHA"],
    ]);
  });

  it("a read counts the file's lines, never agy's Created At / Completed At or Showing lines rows", () => {
    expect(calls(built)[0]!.resultSummary).toBe("3 lines");
  });

  it("toolSummary and WaitMsBeforeAsync are never the command", () => {
    const all = JSON.stringify(calls(built));
    expect(all).not.toContain("List directory contents");
    expect(all).not.toContain("Run hello.py with python3");
    expect(all).not.toContain("5000");
  });

  it("the declined calls say they had no result", () => {
    expect(bash(calls(built)[6]!)?.outputTail).toEqual(["No result: declined or interrupted before it finished."]);
  });

  it("the links in the agent's text behave as Chat's links do: a file link reads as its text, a web link is a link", () => {
    const answer = built.turns[0]!.items.find((item) => item.type === "agentText")!;
    expect(parseInline(answer.type === "agentText" ? answer.value.markdown : "")).toEqual([
      { type: "text", text: "The second line of notes.txt is " },
      { type: "code", text: "beta" },
      { type: "text", text: "." },
    ]);
    expect(isSafeExternalUrl(`file://${work}/notes.txt#L2`)).toBe(false);
    const web = timeline([prompt(0, "go"), step(1, "PLANNER_RESPONSE", { content: "See [the docs](https://example.com/a)." })]);
    const said = web.turns[0]!.items.find((item) => item.type === "agentText")!;
    expect(parseInline(said.type === "agentText" ? said.value.markdown : "")).toContainEqual({ type: "link", href: "https://example.com/a", children: [{ type: "text", text: "the docs" }] });
  });
});

describe("GENERIC results by their place (never a call they may not belong to)", () => {
  it("a planner's GENERIC results finish its calls in call order, whatever their tools; a failed command is its exit code", () => {
    const built = timeline([
      prompt(0, "go"),
      planner(1, ["write_file", { Path: "/tmp/demo/a.txt", Content: "a\n", Overwrite: true }], ["run_command", { CommandLine: "make", WaitMsBeforeAsync: 5000, toolSummary: "Build" }]),
      generic(2, "Created file."),
      generic(3, "Command exited with code 2.\n\nCommand output:\nmake: *** No rule\r\n"),
    ]);
    expect(calls(built).map(row)).toEqual([
      ["write_file", "edit", "/tmp/demo/a.txt", "ok", "+1 −0"],
      ["run_command", "bash", "make", "failed", "exit 2"],
    ]);
    expect(bash(calls(built)[1]!)?.outputTail).toEqual(["make: *** No rule"]);
  });

  it("a result past its planner's calls, or after another planner step, stands as its own plain row", () => {
    const built = timeline([
      prompt(0, "go"),
      planner(1, ["read_file", { Path: "/tmp/demo/a.txt" }]),
      generic(2, "Showing lines 1-1 of 1\n1: a"),
      generic(3, "Created file."),
      step(4, "PLANNER_RESPONSE", { content: "Thinking." }),
      generic(5, "Created file."),
    ]);
    expect(calls(built).map(row)).toEqual([
      ["read_file", "read", "/tmp/demo/a.txt", "ok", "1 line"],
      ["Tool result", { other: "tool result" }, "Created file.", "ok", null],
      ["Tool result", { other: "tool result" }, "Created file.", "ok", null],
    ]);
  });

  it("a step missing between a planner and a result (a call skipped, or a planner not read yet): the result is not placed", () => {
    const built = timeline([
      prompt(0, "go"),
      planner(1, ["write_file", { Path: "/tmp/demo/a.txt", Content: "a\n" }], ["write_file", { Path: "/tmp/demo/b.txt", Content: "b\n" }]),
      // Step 2 is never written; step 3 may be the second call's result, or not: it stands alone.
      generic(3, "Created file."),
      prompt(4, "next"),
    ]);
    expect(calls(built).map(row)).toEqual([
      // Its own result step never came: settled with the next message.
      ["write_file", "edit", "/tmp/demo/a.txt", "failed", "failed"],
      // Its step holds a result that may be its own: left as it is.
      ["write_file", "edit", "/tmp/demo/b.txt", "running", "+1 −0"],
      ["Tool result", { other: "tool result" }, "Created file.", "ok", null],
    ]);
  });

  it("a call with no result settles once a planner step past its window is read; a later planner inside its window settles nothing", () => {
    const inside = timeline([prompt(0, "go"), planner(1, ["run_command", { CommandLine: "date" }]), planner(2, ["read_file", { Path: "/tmp/demo/a.txt" }])]);
    expect(calls(inside).map((call) => [call.target, call.state])).toEqual([
      ["date", "running"],
      ["/tmp/demo/a.txt", "running"],
    ]);
    const past = timeline([prompt(0, "go"), planner(1, ["run_command", { CommandLine: "date" }]), generic(3, "Created file."), planner(4, ["read_file", { Path: "/tmp/demo/a.txt" }])]);
    expect(calls(past).map((call) => [call.target, call.state])).toEqual([
      ["date", "failed"],
      ["Created file.", "ok"],
      ["/tmp/demo/a.txt", "running"],
    ]);
  });

  it("an interrupted call settles before the next user message, in its own turn", () => {
    const built = timeline([prompt(0, "go"), planner(1, ["edit_file", { Path: "/tmp/demo/a.txt", Target: "a", Replacement: "b" }]), prompt(3, "stop that")]);
    expect(built.turns.map((turn) => turnToolCalls(turn).map((call) => call.state))).toEqual([["failed"], []]);
  });
});

// No step number can make the reader loop. Run in a
// child process with a timeout, so a loop fails the test instead of holding it.
describe("a far step number", () => {
  it("a planner at step 1, then a result at step 1000000000000: read at once; the result stands alone, the call settles on the next message", () => {
    const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/shared/chat/agents/antigravity-parser.ts")], bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0]!.text;
    const lines = [planner(1, ["read_file", { Path: "/tmp/demo/a.txt" }]), generic(1_000_000_000_000, "Created file."), prompt(1_000_000_000_001, "next")];
    const script = [
      bundle,
      "const parser = new module.exports.AntigravityTranscriptParser();",
      "const started = performance.now();",
      `const events = ${JSON.stringify(lines)}.flatMap((line) => parser.parse(line).events);`,
      "const ms = performance.now() - started;",
      "process.stdout.write(JSON.stringify({ ms, finished: events.filter((event) => event.type === 'toolFinished').map((event) => [event.id, event.output.isError === true]) }));",
    ].join("\n");
    const run = spawnSync(process.execPath, ["-e", script], { timeout: 3_000, encoding: "utf8" });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    const { ms, finished } = JSON.parse(run.stdout) as { ms: number; finished: [string, boolean][] };
    expect(ms).toBeLessThan(100);
    // The read call (agy-1-0) failed when the message came; the far result is its own row (not attached to it).
    expect(finished).toContainEqual(["agy-1-0", true]);
    expect(finished.filter(([id]) => id === "agy-1-0")).toHaveLength(1);
  });

  it("a step number past the safe integers is not a step", () => {
    const parser = new TranscriptParser("antigravity");
    for (const index of [2 ** 53, 1e300]) expect(parser.parse(JSON.stringify({ step_index: index, source: "MODEL", type: "GENERIC", status: "DONE", content: "x" }), 0).events).toEqual([]);
  });
});
