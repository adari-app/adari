// Antigravity CLI's transcript.jsonl in Chat. Antigravity is closed source:
// the fixtures are synthetic, built only from its public readers: SpecStory's capture-based spec and parser
// (specstoryai/getspecstory 7b72bbcf specstory-cli/pkg/providers/antigravitycli: ANTIGRAVITY-FORMAT.md §3-§10, its
// examples at :240-294 and :410-464; agent_session.go; markdown_tools.go for the arguments), codeburn's fixture
// (getagentseal/codeburn bb952552 tests/fixtures/antigravity-cli-current/.../transcript.jsonl:1-2) and T3 Code's
// (pingdotgg/t3code cd87cce9 AntigravityChildWork.testkit.ts:53-74). In transcript.jsonl each argument's value is JSON
// text (ANTIGRAVITY-FORMAT.md:225-238).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { paneSessions } from "../src/main/away/service";
import { herdrSession } from "../src/main/changes/service";
import { ChatService, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed } from "../src/shared/chat/feed";
import { chatReads } from "../src/shared/chat/kinds";
import { locateCommand, makeSessionRef, paneSession, parseLocateOutput, sessionForPane } from "../src/shared/chat/locator";
import { turnToolCalls, turnUserMessage, type ChatTimeline, type ChatToolCall } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { defaultView } from "../src/shared/pane-view";
import { chatUnreadLine } from "../src/shared/chat/unread";
import { eventually, FakeTranscriptReader, shown } from "./support/chat-lines";

const conversation = "7e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const transcriptOf = (home: string, id = conversation): string => `${home}/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`;
const transcript = transcriptOf("/Users/fixture");
const ref = makeSessionRef("antigravity", { kind: "id", id: conversation })!;
const proj = "/Users/fixture/proj";
const time = (second: number): string => `2026-11-08T10:00:${String(second).padStart(2, "0")}Z`;

/** One step (ANTIGRAVITY-FORMAT.md:104-121); `source` by its type (:123-151). */
function step(index: number, type: string, extra: Record<string, unknown> = {}): string {
  const source = type === "USER_INPUT" ? "USER_EXPLICIT" : ["CONVERSATION_HISTORY", "SYSTEM_MESSAGE", "CHECKPOINT"].includes(type) ? "SYSTEM" : "MODEL";
  return JSON.stringify({ step_index: index, source, type, status: "DONE", created_at: time(index % 60), ...extra });
}
/** A planner step with one call, each argument's value written as JSON text (:225-238). */
const call = (index: number, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  step(index, "PLANNER_RESPONSE", {
    tool_calls: [{ name, args: Object.fromEntries(Object.entries({ ...args, toolAction: "Acting", toolSummary: `Summary of ${name}` }).map(([key, value]) => [key, JSON.stringify(value)])) }],
    ...extra,
  });
/** The user's prompt as agy writes it (:240-259). */
const prompt = (text: string, first = true): string =>
  `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-08T05:00:00-05:00.\n</ADDITIONAL_METADATA>` +
  (first ? "\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (High).\n</USER_SETTINGS_CHANGE>" : "");

/** Two turns: every evidenced step kind, every result type (:141-151), the step gap at 4 (:296-318). */
const fixtureLines = [
  step(0, "USER_INPUT", { content: prompt("Tidy the project") }),
  step(1, "CONVERSATION_HISTORY"),
  call(2, "list_dir", { DirectoryPath: proj }, { thinking: "Look first." }),
  step(3, "LIST_DIRECTORY", { content: '{"name":"src", "isDir":true}\n{"name":"README.md", "sizeBytes":"12"}\n\nSummary: This directory contains 1 subdirectories and 1 files.' }),
  call(5, "view_file", { AbsolutePath: `${proj}/README.md` }),
  step(6, "VIEW_FILE", { content: `File Path: \`file://${proj}/README.md\`\nTotal Lines: 1\nTotal Bytes: 7\n1: # Proj` }),
  call(7, "write_to_file", { CodeContent: "hi there\n", Description: "greet", IsArtifact: false, Overwrite: true, TargetFile: `${proj}/greeting.txt` }),
  step(8, "CODE_ACTION", { content: `Created file file://${proj}/greeting.txt with requested content.\nIf relevant, proactively run terminal commands to execute this code for the USER. Don't ask for permission.` }),
  call(9, "replace_file_content", { TargetFile: `${proj}/greeting.txt`, TargetContent: "hi there", ReplacementContent: "hello there", StartLine: 1, EndLine: 1, AllowMultiple: false }),
  step(10, "CODE_ACTION", { content: `The following changes were made by the replace_file_content tool to: ${proj}/greeting.txt\n[diff_block_start]\n-hi there\n+hello there\n[diff_block_end]` }),
  call(11, "run_command", { CommandLine: "npm test", Cwd: proj, WaitMsBeforeAsync: 5000 }),
  step(12, "RUN_COMMAND", { content: "Created At: 2026-11-08T10:00:12Z\nCompleted At: 2026-11-08T10:00:12Z\n\n\t\t\t\tThe command failed with exit code: 1\n\t\t\t\tOutput:\n\t\t\t\t1 test failed" }),
  call(13, "grep_search", { Query: "TODO", SearchPath: proj, MatchPerLine: true }),
  step(14, "GREP_SEARCH", { content: `{"File":"${proj}/a.ts","LineNumber":3,"LineContent":"// TODO"}` }),
  call(15, "list_dir", { DirectoryPath: `${proj}/missing` }),
  step(16, "LIST_DIRECTORY", { status: "ERROR", content: `Encountered error in step execution: directory ${proj}/missing does not exist` }),
  step(17, "PLANNER_RESPONSE", { content: "Tidied: one TODO left in a.ts.", thinking: "Done." }),
  step(18, "USER_INPUT", { content: prompt("Look things up", false) }),
  step(19, "CONVERSATION_HISTORY"),
  call(20, "search_web", { query: "agy docs" }),
  step(21, "SEARCH_WEB", { content: 'The search for "agy docs" returned the following summary:\nIt is a CLI.' }),
  call(22, "read_url_content", { Url: "https://example.com/docs" }),
  step(23, "READ_URL_CONTENT", { content: "Title: Docs\nOG Description: The docs." }),
  call(24, "generate_image", { Prompt: "a cat", ImageName: "cat" }),
  step(25, "GENERATE_IMAGE", { content: "Using prompt: a cat\nGenerated image is saved at /Users/fixture/cat.png" }),
  call(26, "invoke_subagent", { Subagents: [{ Role: "Researcher", TypeName: "research", Prompt: "Read the docs" }] }),
  step(27, "INVOKE_SUBAGENT", { content: 'Created the following subagents:\n{"conversationId":"x"}' }),
  call(28, "ask_question", { questions: [{ question: "Which file?" }] }),
  step(29, "ASK_QUESTION", { content: "A1: a.ts" }),
  call(30, "list_permissions", {}),
  step(31, "GENERIC", { content: `- read: ${proj}` }),
  call(32, "run_command", { CommandLine: "npm run dev", Cwd: proj, WaitMsBeforeAsync: 5000 }),
  step(33, "RUN_COMMAND", { status: "RUNNING", content: "Created At: 2026-11-08T10:00:33Z\n\n\t\t\t\tThe command is still running." }),
  step(34, "SYSTEM_MESSAGE", { content: "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] content=[Notice] All your subagents finished.\n</SYSTEM_MESSAGE>" }),
  step(35, "CHECKPOINT", { content: "{{ CHECKPOINT 1 }}\nThe earlier parts of this conversation have been truncated." }),
  step(36, "PLANNER_RESPONSE", { content: "All looked up." }),
  step(36, "PLANNER_RESPONSE", { content: "All looked up." }),
];

function timeline(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("antigravity");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of lines) {
    builder.apply(parser.parse(line, offset).events, offset);
    offset += new TextEncoder().encode(line).length + 1;
  }
  return { timeline: builder.timeline, stats: parser.stats };
}
const calls = (built: ChatTimeline): ChatToolCall[] => built.turns.flatMap((turn) => turnToolCalls(turn));
const row = (call: ChatToolCall): unknown[] => [call.toolName, call.kind, call.target, call.state];

describe("antigravity transcript: each evidenced step kind (SpecStory's spec and parser)", () => {
  const { timeline: built, stats } = timeline(fixtureLines);

  it("shows the user's request (only the USER_REQUEST text, with its time), the planner's text, and each call once", () => {
    expect(shown(built).filter((item) => !item.startsWith("tool:"))).toEqual(["user:Tidy the project", "agent:Tidied: one TODO left in a.ts.", "user:Look things up", "agent:All looked up."]);
    expect(turnUserMessage(built.turns[0]!)?.time).toBe(Date.parse(time(0)) / 1_000);
    expect(built.turns.map((turn) => turn.isFinished)).toEqual([true, true]);
  });

  it("finishes each call with the result step after it, by its tool's result type", () => {
    expect(calls(built).map(row)).toEqual([
      ["list_dir", "read", proj, "ok"],
      ["view_file", "read", `${proj}/README.md`, "ok"],
      ["write_to_file", "edit", `${proj}/greeting.txt`, "ok"],
      ["replace_file_content", "edit", `${proj}/greeting.txt`, "ok"],
      ["run_command", "bash", "npm test", "failed"],
      ["grep_search", "search", "TODO", "ok"],
      ["list_dir", "read", `${proj}/missing`, "failed"],
      ["search_web", "web", "agy docs", "ok"],
      ["read_url_content", "web", "https://example.com/docs", "ok"],
      ["generate_image", { other: "generate_image" }, "cat", "ok"],
      ["invoke_subagent", "agent", "Researcher", "ok"],
      ["ask_question", { other: "ask_question" }, "Summary of ask_question", "ok"],
      ["list_permissions", { other: "list_permissions" }, "Summary of list_permissions", "ok"],
      ["run_command", "bash", "npm run dev", "ok"],
    ]);
  });

  it("a failed command is its exit code (status DONE, §3.3); an ERROR step is a failure; a RUNNING command returned", () => {
    const failed = calls(built)[4]!;
    expect(failed.resultSummary).toBe("exit 1");
    expect(failed.detail.type === "bash" ? failed.detail.bash : null).toMatchObject({ exitCode: 1 });
    expect(JSON.stringify(failed.detail)).toContain("1 test failed");
    expect(JSON.stringify(failed.detail)).not.toContain("Created At:");
    expect(JSON.stringify(failed.detail)).not.toContain("\\t\\t\\t\\tOutput");
    expect(calls(built)[6]!.state).toBe("failed");
    expect(calls(built)[13]!.state).toBe("ok");
  });

  it("shows the edits from the call's own content (the arguments decoded from their JSON text)", () => {
    const [written, replaced] = [calls(built)[2]!, calls(built)[3]!];
    expect(written.detail.type === "diff" ? [written.detail.diff.added, written.detail.diff.removed] : null).toEqual([1, 0]);
    expect(replaced.detail.type === "diff" ? [replaced.detail.diff.added, replaced.detail.diff.removed] : null).toEqual([1, 1]);
  });

  it("skips the scaffolding (history, system notices, checkpoints), a step read again, and nothing is unknown", () => {
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({});
    for (const type of ["CONVERSATION_HISTORY", "SYSTEM_MESSAGE", "CHECKPOINT", "PLANNER_RESPONSE"]) expect(stats.skippedTypes.has(type), type).toBe(true);
    expect(stats.malformed).toBe(0);
  });

  it("carries no folder: Herdr's conversation id binds it", () => {
    const parser = new TranscriptParser("antigravity");
    for (const line of fixtureLines) parser.parse(line);
    expect(parser.cwd).toBeNull();
  });

  it("reads codeburn's current-CLI fixture (a root USER_INPUT, a planner reply with thinking)", () => {
    const { timeline: small } = timeline([
      '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-06-21T13:32:13Z","content":"<USER_REQUEST>sanitized fixture prompt</USER_REQUEST>"}',
      '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-06-21T13:32:14Z","content":"sanitized fixture response","thinking":"sanitized fixture reasoning"}',
    ]);
    expect(shown(small)).toEqual(["user:sanitized fixture prompt", "agent:sanitized fixture response"]);
  });
});

describe("antigravity transcript: never attached to the wrong call", () => {
  const opening = [step(0, "USER_INPUT", { content: prompt("Go") }), step(1, "CONVERSATION_HISTORY")];

  it("an unknown step kind is unknown (the unrecognised count), never a call's result: the call keeps running", () => {
    const { timeline: built, stats } = timeline([...opening, call(2, "browser_open", { Url: "https://example.com" }), step(3, "BROWSER_ACTION", { content: "opened" })]);
    expect(calls(built).map(row)).toEqual([["browser_open", { other: "browser_open" }, "Summary of browser_open", "running"]]);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ BROWSER_ACTION: 1 });
  });

  it("an unknown status is unknown, on a result or a planner step, never attached", () => {
    const { timeline: built, stats } = timeline([
      ...opening,
      call(2, "view_file", { AbsolutePath: `${proj}/a.ts` }),
      step(3, "VIEW_FILE", { status: "CANCELLED", content: "1: a" }),
      step(5, "PLANNER_RESPONSE", { status: "STREAMING", content: "half a reply" }),
    ]);
    expect(calls(built).map((call) => call.state)).toEqual(["running"]);
    expect(shown(built)).not.toContain("agent:half a reply");
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ "VIEW_FILE:CANCELLED": 1, "PLANNER_RESPONSE:STREAMING": 1 });
  });

  it("a result with no call it fits stands alone as its own finished row: no planner, another tool's type, a later step", () => {
    const { timeline: built } = timeline([
      ...opening,
      step(2, "RUN_COMMAND", { content: "\t\t\t\tThe command completed successfully.\n\t\t\t\tOutput:\n\t\t\t\tok" }),
      call(3, "run_command", { CommandLine: "ls" }),
      step(4, "VIEW_FILE", { content: "1: not ls output" }),
      call(5, "view_file", { AbsolutePath: `${proj}/b.ts` }),
      step(7, "VIEW_FILE", { content: "1: b, but two steps on" }),
    ]);
    expect(calls(built).map(row)).toEqual([
      ["RUN_COMMAND", { other: "run_command" }, "", "ok"],
      ["run_command", "search", ".", "running"], // `ls` is a search row by the shell classifier (tools.ts)
      ["VIEW_FILE", { other: "view_file" }, "", "ok"],
      ["view_file", "read", `${proj}/b.ts`, "running"],
      ["VIEW_FILE", { other: "view_file" }, "", "ok"],
    ]);
  });

  it("several calls in one planner step: each result by its own type; two calls of one type are neither's", () => {
    const two = (index: number, names: readonly [string, Record<string, unknown>][]): string =>
      step(index, "PLANNER_RESPONSE", { tool_calls: names.map(([name, args]) => ({ name, args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON.stringify(value)])) })) });
    const { timeline: built } = timeline([
      ...opening,
      two(2, [["run_command", { CommandLine: "make" }], ["view_file", { AbsolutePath: `${proj}/a.ts` }]]),
      step(3, "VIEW_FILE", { content: "1: a" }),
      step(4, "RUN_COMMAND", { content: "\t\tThe command completed successfully.\n\t\tOutput:\n\t\tbuilt" }),
      two(5, [["view_file", { AbsolutePath: `${proj}/x.ts` }], ["view_file", { AbsolutePath: `${proj}/y.ts` }]]),
      step(6, "VIEW_FILE", { content: "1: which?" }),
    ]);
    expect(calls(built).map((call) => [call.toolName, call.target, call.state])).toEqual([
      ["run_command", "make", "ok"],
      ["view_file", `${proj}/a.ts`, "ok"],
      ["view_file", `${proj}/x.ts`, "running"],
      ["view_file", `${proj}/y.ts`, "running"],
      ["VIEW_FILE", "", "ok"],
    ]);
    expect(calls(built)[0]!.resultSummary).toBe("exit 0");
  });

  // A result finishes a call only when exactly one waiting call takes
  // it across every planner window that admits it, and no later planner step lies between that call's planner and it.
  const many = (index: number, names: readonly [string, Record<string, unknown>][]): string =>
    step(index, "PLANNER_RESPONSE", { tool_calls: names.map(([name, args]) => ({ name, args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON.stringify(value)])) })) });
  const states = (built: ChatTimeline): Record<string, string> => Object.fromEntries(calls(built).map((call) => [`${call.toolName} ${call.target}`, call.state]));

  it("two planner windows admit a VIEW_FILE and each has a view_file waiting: it stands alone, both calls stay running, in any file order", () => {
    const planner2 = many(2, [["view_file", { AbsolutePath: `${proj}/a.ts` }], ["run_command", { CommandLine: "make" }]]);
    const planner3 = call(3, "view_file", { AbsolutePath: `${proj}/b.ts` });
    const result4 = step(4, "VIEW_FILE", { content: "1: a or b?" });
    for (const order of [
      [planner2, planner3, result4],
      [planner2, result4, planner3], // the result flushed before the later planner
      [result4, planner2, planner3], // before both
    ]) {
      const { timeline: built } = timeline([...opening, ...order]);
      expect(states(built), order.join("\n")).toEqual({ [`view_file ${proj}/a.ts`]: "running", "run_command make": "running", [`view_file ${proj}/b.ts`]: "running", "VIEW_FILE ": "ok" });
      expect(calls(built).length).toBe(4);
    }
  });

  it("a later planner step ends an earlier planner's window: a result after it is not the earlier planner's", () => {
    const { timeline: built } = timeline([
      ...opening,
      many(2, [["view_file", { AbsolutePath: `${proj}/a.ts` }], ["run_command", { CommandLine: "make" }]]),
      step(3, "PLANNER_RESPONSE", { content: "Thinking it over." }),
      step(4, "VIEW_FILE", { content: "1: not after a later planner" }),
    ]);
    expect(states(built)).toEqual({ [`view_file ${proj}/a.ts`]: "running", "run_command make": "running", "VIEW_FILE ": "ok" });
  });

  it("a result whose earlier steps are not read yet stands alone and waits; once they are read it finishes the call it alone fits", () => {
    const { timeline: built } = timeline([
      ...opening,
      many(2, [["view_file", { AbsolutePath: `${proj}/a.ts` }], ["run_command", { CommandLine: "make" }]]),
      step(4, "RUN_COMMAND", { content: "\tThe command completed successfully.\n\tOutput:\n\tbuilt" }), // step 3 not read yet: it could be a planner
      step(3, "VIEW_FILE", { content: "1: a" }),
    ]);
    expect(calls(built).map((call) => [call.toolName, call.target, call.state])).toEqual([
      ["view_file", `${proj}/a.ts`, "ok"],
      ["run_command", "make", "ok"],
      ["RUN_COMMAND", "", "ok"], // its own row while it waited (shown twice)
    ]);
  });

  it("a result written before its planner step (agy's async flush, transcript_parser.go:253-259) stands alone, then finishes the call it fits", () => {
    const { timeline: built } = timeline([...opening, step(3, "RUN_COMMAND", { content: "\tThe command completed successfully.\n\tOutput:\n\tdone" }), call(2, "run_command", { CommandLine: "make test" })]);
    expect(calls(built).map((call) => [call.toolName, call.state])).toEqual([
      ["RUN_COMMAND", "ok"],
      ["run_command", "ok"],
    ]);
  });

  it("a USER_INPUT another source wrote is not the user's (agent_session.go:189-193); a line that is not a step is unknown; a cut line malformed", () => {
    const { timeline: built, stats } = timeline([
      ...opening,
      JSON.stringify({ step_index: 2, source: "SYSTEM", type: "USER_INPUT", status: "DONE", content: prompt("replayed") }),
      JSON.stringify({ kind: "a later version's line" }),
      '{"step_index":9,"type":"PLANNER_RESPONSE","content":"cut',
    ]);
    expect(shown(built)).toEqual(["user:Go"]);
    expect(stats.skippedTypes.has("USER_INPUT:SYSTEM")).toBe(true);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ "(no step)": 1 });
    expect(stats.malformed).toBe(1);
  });
});

describe("antigravity: binding by Herdr's conversation id only", () => {
  const scratch = realpathSync(process.env["HERDR_TEST_SCRATCH"] || os.tmpdir());
  const run = (command: string, home: string): string => execFileSync("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000 });
  const put = (file: string, modified: number): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, step(0, "USER_INPUT", { content: prompt("x") }) + "\n");
    utimesSync(file, modified, modified);
  };
  const report = (value: string) => ({ source: "herdr:antigravity_cli", agent: "agy", kind: "id", value });

  it("is read: its own Chat, no fallback line", () => {
    expect(chatReads("agy")).toBe(true);
    expect(defaultView({ paneID: "a", isAgent: true, kind: "agy" })).toBe("chat");
    expect(chatUnreadLine(true, "agy")).toBeNull();
  });

  it("finds exactly the reported conversation's transcript, never another's (one literal path: no copies to choose from)", () => {
    const home = mkdtempSync(path.join(scratch, "hc-agy-locate-"));
    const mine = transcriptOf(home);
    put(mine, 100);
    put(transcriptOf(home, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"), 200);
    put(`${home}/.gemini/antigravity-cli/brain/${conversation}/.system_generated/logs/transcript_full.jsonl`, 300);
    const bound = sessionForPane({ agent: "agy", agentSession: report(conversation), cwd: proj });
    expect(bound?.ref).toEqual(ref);
    expect(parseLocateOutput(run(locateCommand(ref)!, home), ref)).toBe(mine);
    const other = makeSessionRef("antigravity", { kind: "id", id: "11111111-2222-4333-8444-555555555555" })!;
    expect(parseLocateOutput(run(locateCommand(other)!, home), other)).toBeNull();
  });

  it("a rejected or missing id is no session (no folder rule); Away and Changes skip it", () => {
    for (const value of ["../../x'; $(touch NEVER); #", conversation + "/..", "a b"]) expect(sessionForPane({ agent: "agy", agentSession: report(value), cwd: proj }), value).toBeNull();
    // An id of a session id's shape that is not a conversation id (a UUID) gives no command: nothing is found.
    const shaped = sessionForPane({ agent: "agy", agentSession: report("not-a-uuid"), cwd: proj });
    expect(shaped === null ? null : locateCommand(shaped.ref)).toBeNull();
    expect(sessionForPane({ agent: "agy", cwd: proj })).toBeNull();
    expect(paneSession({ agents: [{ paneID: "a", agent: "agy", cwd: proj }], panes: [{ paneID: "a", agent: "agy", cwd: proj }] }, "a")).toBeNull();
    const topology = { agents: [{ paneID: "a", agent: "agy", cwd: proj, agentSession: report(conversation) }], panes: [{ paneID: "a", agent: "agy", cwd: proj }] };
    expect(paneSessions(topology as never)).toEqual({ a: null });
    expect(herdrSession(topology as never, "a")).toBeNull();
  });
});

describe("antigravity transcript: the feed and the service", () => {
  const lines = (rows: readonly string[]): string => rows.join("\n") + "\n";

  it("follows the file as it grows; a partial last line waits; a replaced file starts over", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(transcript, lines(fixtureLines.slice(0, 3)), transcript);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(ref, [proj]);
    expect(await eventually(() => feed.state.status === "live" && feed.timeline.turns.length === 1)).toBe(true);
    const next = new TextEncoder().encode(fixtureLines[3] + "\n" + fixtureLines[16] + "\n");
    reader.appendBytes(transcript, next.slice(0, 25));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(turnToolCalls(feed.timeline.turns[0]!)[0]?.state).toBe("running");
    reader.appendBytes(transcript, next.slice(25));
    expect(await eventually(() => shown(feed.timeline).at(-1) === "agent:Tidied: one TODO left in a.ts.")).toBe(true);
    expect(turnToolCalls(feed.timeline.turns[0]!)[0]?.state).toBe("ok");
    reader.put(transcript, lines([step(0, "USER_INPUT", { content: prompt("fresh start") })]), transcript);
    expect(await eventually(() => feed.timeline.turns.length === 1 && turnUserMessage(feed.timeline.turns[0]!)?.text === "fresh start")).toBe(true);
    feed.stop();
  });

  it("shows the unrecognised-format note for lines that are not steps, or steps it does not know", async () => {
    for (const rows of [
      Array.from({ length: 5 }, (_, index) => JSON.stringify({ event: "message", index })),
      Array.from({ length: 5 }, (_, index) => step(index, "TRAJECTORY_V2", { content: "x" })),
    ]) {
      const reader = new FakeTranscriptReader();
      reader.put(transcript, lines(rows), transcript);
      const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
      feed.start(ref, [proj]);
      expect(await eventually(() => feed.state.status === "unavailable")).toBe(true);
      expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
      feed.stop();
    }
  });

  it("an agy pane Herdr names a conversation for passes the service gate and shows it", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(transcript, lines(fixtureLines.slice(0, 4)), transcript);
    const agent = { paneID: "g", agent: "agy", cwd: proj, agentSession: { source: "herdr:antigravity_cli", agent: "agy", kind: "id", value: conversation } };
    const backend = { kind: "herdr", transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts: ChatHosts = { backend: () => backend, pane: () => ({ paneID: "g", agent: "agy", cwd: proj }) as never, agent: () => agent as never, hostAgentPanes: () => ["g"] };
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    const updates: ChatUpdateEvent[] = [];
    const page: ChatOwner = { id: 1, send: (_channel: string, payload: ChatUpdateEvent) => updates.push(payload), isDestroyed: () => false } as unknown as ChatOwner;
    try {
      service.open(page, "mac", "g");
      expect(await eventually(() => updates.at(-1)?.state.status === "live" && shown(updates.at(-1)!.timeline).length > 0)).toBe(true);
      expect(shown(updates.at(-1)!.timeline)).toEqual(["user:Tidy the project", `tool:${proj}`]);
    } finally {
      service.closeAll();
    }
  });
});
