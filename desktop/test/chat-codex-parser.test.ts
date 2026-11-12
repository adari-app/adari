// Codex rollouts: a port of HerdrKit's CodexRolloutParserTests.swift. The
// session fixture (desktop/fixtures/chat/codex-session.jsonl) is the Swift
// test's `session` literal, checked against it here; the other cases' lines
// are the Swift test's literals, written as TypeScript strings. Times are
// seconds since 1970.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { CodexRolloutParser } from "../src/shared/chat/codex-parser";
import { CodexScript, Script, scriptField, scriptString, type ScriptValue } from "../src/shared/chat/codex-script";
import {
  attachment,
  bashDetail,
  diffLine,
  runningTurn,
  searchDetail,
  toolCall,
  toolOutput,
  turnFoldSummary,
  turnFooter,
  turnRows,
  turnToolCalls,
  turnUserMessage,
  rowID,
  workedForText,
  workingSince,
  type ChatTimeline,
  type ChatToolCall,
} from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { ChatToolResults, parseChatDate } from "../src/shared/chat/tools";
import { extractRawString, fixturesRoot, readRepoFile } from "./support/swift-fixtures";

const raw = String.raw;
const swiftSource = "Tests/HerdrKitTests/CodexRolloutParserTests.swift";

/** Context lines, then three turns (see the Swift test's `session`). */
const session = readFileSync(path.join(fixturesRoot, "chat/codex-session.jsonl"), "utf8");

const attachmentA =
  "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png";
const attachmentB =
  "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-22222222-2222-2222-2222-222222222222.jpg";

function date(iso: string): number {
  const value = parseChatDate(iso);
  if (value === null) throw new Error(`not a date: ${iso}`);
  return value;
}

/** The whole text through one parser and one builder. */
function timeline(text: string): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("codex");
  const builder = new ChatTimelineBuilder();
  builder.apply(parser.parseText(text));
  return { timeline: builder.timeline, stats: parser.stats };
}

/** The row a single exec script makes. */
const script = (source: string): ChatToolCall => CodexRolloutParser.customCall("c", "exec", source, null);

const finished = (source: string, rawOutput: string): ChatToolCall =>
  ChatToolResults.apply(CodexRolloutParser.parseHeaders(rawOutput), script(source), null);

const completed = "Script completed\nWall time 0.1 seconds\nOutput:\n";

const names = (source: string): string[] => CodexScript.calls(source).map((call) => call.name);

const cmd = (argument: ScriptValue | null): string | null => scriptString(scriptField(argument, "cmd"));

describe("codex fixture", () => {
  it("is the Swift test's session literal", () => {
    expect(session).toBe(extractRawString(readRepoFile(swiftSource), "static let session = "));
    expect(session.split("\n")).toHaveLength(35);
  });
});

describe("codex timeline", () => {
  it("builds three turns from the session and counts every line", () => {
    const { timeline: built, stats } = timeline(session);
    expect(built.turns).toHaveLength(3);
    expect(stats.lines).toBe(35);
    expect(stats.malformed).toBe(2);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ future_record: 1 });
    expect(stats.skippedTypes.get("message/user-context")).toBe(2);
    expect(stats.skippedTypes.get("message/developer")).toBe(2);
    expect(stats.skippedTypes.get("response_item/reasoning")).toBe(1);
    expect(stats.skippedTypes.get("event_msg/token_count")).toBe(1);
    expect(stats.skippedTypes.get("session_meta")).toBe(1);
    expect(stats.lines).toBe(stats.linesWithEvents + stats.skipped + stats.malformed + stats.unknown);
  });

  it("skips instructions in a plain exchange and uses the reported duration", () => {
    const turn = (timeline(session)).timeline.turns[0]!;
    expect(turn.items).toHaveLength(2);
    expect(turnUserMessage(turn)?.text).toBe("Summarise the README");
    const reply = turn.items[1]!;
    expect(reply.type).toBe("agentText");
    expect(reply.type === "agentText" ? reply.value.markdown : null).toBe("It is a three-line README about the proj.");
    const footer = turnFooter(turn);
    expect(footer?.duration).toBe(12);
    expect(footer?.start).toBe(date("2026-11-01T03:00:01.000Z"));
    expect(footer?.end).toBe(date("2026-11-01T03:00:13.000Z"));
  });

  it("reads, edits and keeps the failed command open in a tool turn", () => {
    const turn = (timeline(session)).timeline.turns[1]!;
    const calls = turnToolCalls(turn);
    expect(calls.map((call) => call.kind)).toEqual(["read", "edit", "bash", "bash"]);
    expect(calls[0]!.target).toBe("README.md");
    expect(calls[0]!.resultSummary).toBe("3 lines");
    expect(calls[1]!.target).toBe("/Users/fixture/proj/README.md");
    expect(calls[1]!.resultSummary).toBe("+1 −1");
    expect(calls[1]!.detail).toEqual({
      type: "diff",
      diff: {
        files: ["/Users/fixture/proj/README.md"],
        added: 1,
        removed: 1,
        lines: [diffLine("context", "# Proj"), diffLine("removed", "A smal tool."), diffLine("added", "A small tool.")],
        moreLines: 0,
      },
    });
    expect(calls[2]!.state).toBe("failed");
    expect(calls[2]!.resultSummary).toBe("exit 1");
    expect(calls[2]!.detail).toEqual({
      type: "bash",
      bash: bashDetail("swift test --filter ReadmeTest", ["error: no tests matched 'ReadmeTest'", "Test run failed"], 1),
    });
    expect(calls[3]!.target).toBe("swift test --force-resolved-versions --filter ReadmeLayoutTests");
    expect(calls[3]!.moreCalls, "the clock call does not count").toBe(0);
    expect(calls[3]!.state).toBe("ok");
    expect(calls[3]!.resultSummary).toBe("exit 0");
    expect(calls.every((call) => call.toolName === "exec")).toBe(true);

    expect(turn.isFinished).toBe(true);
    const footer = turnFooter(turn);
    expect(footer === null ? null : workedForText(footer)).toBe("Worked for 2m 41s");
    expect(turnFoldSummary(turn)).toBe("Read 1 file, edited 1 file, ran 1 command");
    expect(turnRows(turn).map(rowID)).toEqual(["m5", "turn-2/folded", "call_test1", "m6", "m7"]);
  });

  it("shows attachments, an image, a multi-call script and a running turn", () => {
    const built = (timeline(session)).timeline;
    const turn = built.turns[2]!;
    const message = turnUserMessage(turn);
    expect(message?.text).toBe("Why do these differ?");
    expect(message?.attachments).toEqual([attachment(null, "image/png"), attachment(attachmentA), attachment(attachmentB)]);
    expect(JSON.stringify(built)).not.toContain("iVBORw0KGgo");
    expect(turn.isFinished).toBe(false);
    expect(runningTurn(built)).not.toBeNull();
    expect(workingSince(built)).toBe(date("2026-11-01T03:20:00.000Z"));
    const calls = turnToolCalls(turn);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.kind).toBe("read");
    expect(calls[0]!.target).toBe("/Users/fixture/proj/before.png");
    expect(calls[0]!.moreCalls).toBe(1);
    expect(calls[0]!.resultSummary).toBe("+1 more");
    expect(calls[1]!.kind).toBe("bash");
    expect(calls[1]!.state, "Script running with cell ID: its result comes later").toBe("running");
    expect(turnRows(turn)).toHaveLength(3);
  });

  it("fails any row when the script failed", () => {
    const text = [
      raw`{"ordinal":1,"payload":{"content":[{"text":"Go","type":"input_text"}],"id":"m1","role":"user","type":"message"},"timestamp":"2026-11-01T04:00:00.000Z","type":"response_item"}`,
      raw`{"ordinal":2,"payload":{"call_id":"c1","input":"text(await tools.view_image({path:\"/p/a.png\"}));","name":"exec","type":"custom_tool_call"},"timestamp":"2026-11-01T04:00:01.000Z","type":"response_item"}`,
      raw`{"ordinal":3,"payload":{"call_id":"c1","output":[{"text":"Script failed\nWall time 0.0 seconds\nOutput:\nError: not found","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T04:00:02.000Z","type":"response_item"}`,
    ].join("\n");
    const call = turnToolCalls((timeline(text)).timeline.turns[0]!)[0]!;
    expect(call.state).toBe("failed");
    expect(call.resultSummary).toBeNull();
  });

  it("reads an older shell function call with JSON output", () => {
    const text = [
      raw`{"payload":{"content":[{"text":"Show the manifest","type":"input_text"}],"role":"user","type":"message"},"timestamp":"2026-11-01T05:00:00.000Z","type":"response_item"}`,
      raw`{"payload":{"arguments":"{\"command\":[\"bash\",\"-lc\",\"cat Package.swift\"]}","call_id":"fc1","name":"shell","type":"function_call"},"timestamp":"2026-11-01T05:00:01.000Z","type":"response_item"}`,
      raw`{"payload":{"call_id":"fc1","output":"{\"output\":\"// swift-tools-version:5.9\\nlet package = Package()\\n\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.1}}","type":"function_call_output"},"timestamp":"2026-11-01T05:00:02.000Z","type":"response_item"}`,
      raw`{"payload":{"action":{"query":"swift package manifest","type":"search"},"id":"ws1","status":"completed","type":"web_search_call"},"timestamp":"2026-11-01T05:00:03.000Z","type":"response_item"}`,
    ].join("\n");
    const calls = turnToolCalls((timeline(text)).timeline.turns[0]!);
    expect(calls.map((call) => call.kind)).toEqual(["read", "web"]);
    expect(calls[0]!.resultSummary).toBe("2 lines");
    expect(calls[1]!.target).toBe("swift package manifest");
    expect(calls[1]!.state).toBe("ok");
  });

  it("keeps a printed command result object's status through a whole transcript", () => {
    const failing = completed + raw`{"exit_code":2,"output":"command failed\n","wall_time_seconds":0.1}`;
    const lines = [
      {
        ordinal: 1,
        type: "response_item",
        timestamp: "2026-11-01T04:00:00.000Z",
        payload: { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "Build it" }] },
      },
      {
        ordinal: 2,
        type: "response_item",
        timestamp: "2026-11-01T04:00:01.000Z",
        payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "text(await tools.exec_command({cmd: 'swift build'}));" },
      },
      {
        ordinal: 3,
        type: "response_item",
        timestamp: "2026-11-01T04:00:02.000Z",
        payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: failing }] },
      },
    ];
    const text = lines.map((line) => JSON.stringify(line)).join("\n");
    const call = turnToolCalls((timeline(text)).timeline.turns[0]!)[0]!;
    expect(call.state).toBe("failed");
    expect(call.resultSummary).toBe("exit 2");
  });

  it("keeps a typed message that only looks like elements", () => {
    const line = {
      ordinal: 1,
      type: "response_item",
      timestamp: "2026-11-01T04:00:00.000Z",
      payload: { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "<b>one</b> and <b>two</b>" }] },
    };
    const turn = (timeline(JSON.stringify(line))).timeline.turns[0];
    expect(turn === undefined ? null : turnUserMessage(turn)?.text).toBe("<b>one</b> and <b>two</b>");
  });
});

describe("codex code-mode scripts", () => {
  it("finds calls in order past strings and comments", () => {
    const source = [
      '// tools.ignored("in a comment")',
      'const note = "tools.not_a_call(1)";',
      `const r = await Promise.allSettled([tools.exec_command({cmd: "rg -n 'tools.fake(' App"}), tools.write_stdin({session_id: 3, chars: "q"})]);`,
      "/* tools.also_ignored() */ text(`${await tools.clock__curr_time()}`);",
    ].join("\n");
    expect(names(source)).toEqual(["exec_command", "write_stdin", "clock__curr_time"]);
    const call = script(source);
    expect(call.kind).toBe("search");
    expect(call.target).toBe("tools.fake(");
    expect(call.moreCalls).toBe(1);
  });

  it("finds calls inside nested templates once", () => {
    const source = "text(`a ${`b ${await tools.exec_command({cmd: \"ls\"})}`} ${await tools.view_image({path: 'x.png'})}`);";
    expect(names(source)).toEqual(["exec_command", "view_image"]);
  });

  it("decodes all quotes, escapes and joins in arguments", () => {
    const BT = "`";
    const calls = CodexScript.calls(
      raw`tools.exec_command({cmd: 'echo \'hi\'\n' + "and \"more\"" + ${BT}\u{1F600}${BT}, n: 0x10, flag: true, list: [1, -2.5, null], short})`,
    );
    expect(calls[0]?.argument).toEqual(
      Script.object([
        ["cmd", Script.string("echo 'hi'\nand \"more\"\u{1F600}")],
        ["n", Script.number(16)],
        ["flag", Script.bool(true)],
        ["list", Script.array([Script.number(1), Script.number(-2.5), Script.null()])],
        ["short", Script.identifier("short")],
      ]),
    );
  });

  it("reads exec_command with a heredoc as Bash", () => {
    const call = script(raw`text(await tools.exec_command({cmd:"python3 - <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY", workdir:"/p"}));`);
    expect(call.kind).toBe("bash");
    expect(call.target).toBe("python3 - <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY");
  });

  it("maps each tool name to its row", () => {
    expect(script(raw`text(await tools.web__run({search_query:[{q:"sftp read limit"}]}));`).kind).toBe("web");
    expect(script(raw`text(await tools.web__run({find:[{ref_id:"https://example.com/a",pattern:"64"}]}));`).target).toBe("https://example.com/a");
    const stdin = script(raw`text(await tools.write_stdin({session_id: 12, chars: "y\n"}));`);
    expect(stdin.kind).toBe("bash");
    expect(stdin.target).toBe("input to a running command");
    expect(script(raw`tools.view_image({path:"/p/x.png"})`).target).toBe("/p/x.png");
    expect(script(raw`text(await tools.mcp__xcode__XcodeListWorkspaces({}));`).kind).toEqual({ other: "XcodeListWorkspaces" });
    const patch = script(raw`text(await tools.apply_patch('*** Begin Patch\n*** Add File: /p/new.md\n+# New\n+text\n*** End Patch'));`);
    expect(patch.kind).toBe("edit");
    expect(patch.target).toBe("/p/new.md");
    expect(patch.resultSummary, "the builder adds the starting summary").toBeNull();
    expect(ChatToolResults.startingSummary(patch)).toBe("+2 −0");
    const plan = script(raw`tools.update_plan({plan:[{step:"Read",status:"completed"},{step:"Fix",status:"in_progress"}]})`);
    expect(plan.kind).toBe("plan");
    expect(plan.target).toBe("Fix");
  });

  it("makes scripts it cannot read Other(script) with their first line", () => {
    const clockOnly = script("text(await tools.clock__curr_time());");
    expect(clockOnly.kind).toEqual({ other: "script" });
    expect(clockOnly.target).toBe("text(await tools.clock__curr_time());");
    const variable = script("const c = build();\ntext(await tools.exec_command(c));");
    expect(variable.kind).toEqual({ other: "script" });
    expect(variable.target).toBe("const c = build();");
    expect(script('text("hello")').kind).toEqual({ other: "script" });
    expect(script("").kind).toEqual({ other: "script" });
    expect(script('tools.exec_command({cmd: "unterminated').kind).toEqual({ other: "script" });
  });

  it("still reads the command from older exec input written as JSON", () => {
    const call = CodexRolloutParser.customCall("c", "exec", raw`{"cmd":"rg -n needle src","workdir":"/p"}`, null);
    expect(call.kind).toBe("search");
    expect(call.target).toBe("needle");
  });
});

describe("codex outputs", () => {
  it("parses output headers", () => {
    expect(CodexRolloutParser.parseHeaders("Script failed\nWall time 0.0 seconds\nOutput:\nTypeError: tools.nope is not a function")).toEqual(
      toolOutput("TypeError: tools.nope is not a function", { isError: true }),
    );
    expect(CodexRolloutParser.parseHeaders("Script running with cell ID 9\nWall time 10.0 seconds\nOutput:\npartial")).toEqual(
      toolOutput("partial", { isRunning: true }),
    );
    expect(CodexRolloutParser.parseHeaders("Exit code: 2\nWall time: 0.3 seconds\nOutput:\nboom")).toEqual(toolOutput("boom", { exitCode: 2 }));
    expect(CodexRolloutParser.parseHeaders("plain text\nOutput:\nnot a header")).toEqual(toolOutput("plain text\nOutput:\nnot a header"));
    expect(CodexRolloutParser.output(raw`{"output":"a\nb\n","metadata":{"exit_code":0,"duration_seconds":0.1}}`)).toEqual(
      toolOutput("a\nb\n", { exitCode: 0 }),
    );
  });

  it("keeps a printed command result object's status and output", () => {
    const failing = completed + raw`{"exit_code":2,"output":"command failed\n","wall_time_seconds":0.1}`;
    expect(CodexRolloutParser.parseHeaders(failing)).toEqual(toolOutput("command failed\n", { exitCode: 2 }));
    const build = finished("text(await tools.exec_command({cmd: 'swift build'}));", failing);
    expect(build.state).toBe("failed");
    expect(build.resultSummary).toBe("exit 2");
    expect(build.detail.type === "bash" ? build.detail.bash.outputTail : null).toEqual(["command failed"]);

    const read = finished(
      "text(await tools.exec_command({cmd: 'cat a.txt'}));",
      completed + raw`{"exit_code":0,"output":"one\ntwo\nthree\n","wall_time_seconds":0.0}`,
    );
    expect(read.state).toBe("ok");
    expect(read.resultSummary, "the output's lines, not the object's").toBe("3 lines");

    // A command still running in a session: its output so far, no exit code, and the row is not kept running.
    const running = CodexRolloutParser.parseHeaders(completed + raw`{"output":"Compiling 3 of 9","session_id":7,"wall_time_seconds":10.0}`);
    expect(running).toEqual(toolOutput("Compiling 3 of 9"));
    expect(CodexRolloutParser.parseHeaders(completed + "Process running with session ID 7\nOutput:\nCompiling 3 of 9")).toEqual(running);

    // JSON a command printed stays its output.
    for (const stdout of [
      raw`{"output":"x","name":"y","exit_code":1}`,
      raw`{"output":"x"}`,
      raw`{"exit_code":"2","output":"x"}`,
      raw`{"exit_code":2,"output":["x"]}`,
      raw`[{"exit_code":2,"output":"x"}]`,
    ]) {
      expect(CodexRolloutParser.parseHeaders(completed + stdout), stdout).toEqual(toolOutput(stdout));
    }
    const bare = raw`{"exit_code":2,"output":"x","wall_time_seconds":0.1}`;
    expect(CodexRolloutParser.parseHeaders(bare), "no script header: not a result").toEqual(toolOutput(bare));
  });

  it("fails every kind on a non-zero exit, and a no-match search is explicit", () => {
    const missing = finished(
      "text(await tools.exec_command({cmd: 'cat /missing/file'}));",
      completed + "Process exited with code 1\nOutput:\ncat: /missing/file: No such file or directory",
    );
    expect(missing.kind).toBe("read");
    expect(missing.state).toBe("failed");
    expect(missing.resultSummary, "no line count for a failed read").toBeNull();
    const object = finished(
      "text(await tools.exec_command({cmd: 'cat /missing/file'}));",
      completed + raw`{"exit_code":1,"output":"cat: /missing/file: No such file or directory\n","wall_time_seconds":0.0}`,
    );
    expect(object.state).toBe("failed");

    const badOption = finished(
      "text(await tools.exec_command({cmd: 'rg --bogus needle src'}));",
      completed + "Process exited with code 2\nOutput:\nrg: unrecognized flag --bogus",
    );
    expect(badOption.kind).toBe("search");
    expect(badOption.state).toBe("failed");
    expect(badOption.resultSummary).toBe("failed");
    const missingFolder = finished(
      "text(await tools.exec_command({cmd: 'rg needle nowhere'}));",
      completed + "Process exited with code 1\nOutput:\nrg: nowhere: No such file or directory (os error 2)",
    );
    expect(missingFolder.state, "exit 1 with output is a failure").toBe("failed");

    // grep and rg exit 1 when nothing matches: no output is "no matches", not a failure.
    const noMatches = finished("text(await tools.exec_command({cmd: 'rg needle src'}));", completed + "Process exited with code 1\nOutput:\n");
    expect(noMatches.state).toBe("ok");
    expect(noMatches.resultSummary).toBe("0 files");

    const patch = finished(
      "text(await tools.exec_command({cmd: \"apply_patch <<'EOF'\\n*** Begin Patch\\n*** Update File: a.swift\\n-old\\n+new\\n*** End Patch\\nEOF\"}));",
      completed + "Process exited with code 1\nOutput:\nerror: patch does not apply",
    );
    expect(patch.kind).toBe("edit");
    expect(patch.state).toBe("failed");

    const fine = finished("text(await tools.exec_command({cmd: 'cat a.txt'}));", completed + "Process exited with code 0\nOutput:\na\nb");
    expect(fine.state).toBe("ok");
    expect(fine.resultSummary).toBe("2 lines");
  });

  it("treats a silent exit 1 as no matches only for grep-style programs", () => {
    for (const command of ["ls /missing/folder 2>/dev/null", "find /missing/folder 2>/dev/null", "fd needle /missing 2>/dev/null"]) {
      const call = script(`tools.exec_command({cmd: '${command}'})`);
      expect(call.kind, command).toBe("search");
      const applied = ChatToolResults.apply(toolOutput("", { exitCode: 1 }), call, null);
      expect(applied.state, command).toBe("failed");
      expect(applied.resultSummary, command).toBe("failed");
    }
    for (const command of ["rg needle src", "grep -rn needle src", "egrep 'a|b' file.txt", "fgrep needle file.txt", "cd src && rg needle", "/usr/bin/grep needle file.txt"]) {
      const call = script(`tools.exec_command({cmd: "${command}"})`);
      expect(call.kind, command).toBe("search");
      const applied = ChatToolResults.apply(toolOutput("", { exitCode: 1 }), call, null);
      expect(applied.state, command).toBe("ok");
      expect(applied.resultSummary, command).toBe("0 files");
      const failed = ChatToolResults.apply(toolOutput("", { exitCode: 2 }), script(`tools.exec_command({cmd: "${command}"})`), null);
      expect(failed.state, "exit 2 " + command).toBe("failed");
    }
    // A Search row that is not a command (Claude Code's Grep tool) has no exit code to judge.
    const grepTool = toolCall("g", "search", "Grep", "needle", { detail: { type: "search", search: searchDetail("needle") } });
    expect(ChatToolResults.apply(toolOutput("No files found"), grepTool, null).state).toBe("ok");
  });
});

describe("codex older function calls and other items", () => {
  it("maps function calls for agents, the plan, the shell and patches", () => {
    const call = (name: string, args: string): ChatToolCall => CodexRolloutParser.functionCall("f", name, args, null);
    expect(call("send_message", raw`{"target":"agent-2","message":"Check the tests"}`)).toEqual(
      toolCall("f", "agent", "send_message", "Message agent", { detail: { type: "text", text: "Check the tests" } }),
    );
    expect(call("wait", raw`{"seconds":30}`).target).toBe("Wait");
    expect(call("wait_agent", raw`{"id":"agent-2"}`).target).toBe("Wait");
    expect(call("spawn_agent", raw`{"task":"Review the diff"}`).target).toBe("Start agent");
    expect(call("update_plan", raw`{"plan":[{"step":"A","status":"completed"},{"step":"B","status":"pending"}]}`).detail).toEqual({
      type: "plan",
      steps: [
        { text: "A", status: "completed" },
        { text: "B", status: "pending" },
      ],
    });
    const shell = call("shell", raw`{"command":["bash","-lc","cat Package.swift"],"workdir":"/p"}`);
    expect(shell.kind).toBe("read");
    expect(shell.target).toBe("Package.swift");
    expect(call("shell", raw`{"command":["git","log","--oneline","-n","3"]}`).target).toBe("git log --oneline -n 3");
    expect(call("apply_patch", raw`{"input":"*** Begin Patch\n*** Update File: a.txt\n-x\n+y\n*** End Patch"}`).kind).toBe("edit");
    expect(call("web_search", raw`{"query":"codex rollout"}`).target).toBe("codex rollout");
    expect(call("mcp__github__list_prs", raw`{"repo":"x"}`).kind).toEqual({ other: "list_prs" });
    expect(call("brand_new_tool", "not json").kind).toEqual({ other: "brand_new_tool" });
  });

  it("detects context", () => {
    expect(CodexRolloutParser.isContext("<environment_context>\n<cwd>/p</cwd>\n</environment_context>")).toBe(true);
    expect(CodexRolloutParser.isContext("  <user_instructions>be nice</user_instructions>  ")).toBe(true);
    expect(CodexRolloutParser.isContext("<permissions instructions>x</permissions instructions>")).toBe(true);
    expect(CodexRolloutParser.isContext('<turn_aborted reason="user">stopped</turn_aborted>')).toBe(true);
    expect(CodexRolloutParser.isContext("# AGENTS.md instructions for /p\n\nrules")).toBe(true);
    expect(CodexRolloutParser.isContext("Fix <b>bold</b> rendering")).toBe(false);
    expect(CodexRolloutParser.isContext("<b>one</b> and <i>two</i>"), "two elements, not one").toBe(false);
    expect(CodexRolloutParser.isContext("Why is 3 < 4 > 2?")).toBe(false);
  });

  it("takes only one element covering the whole block as context", () => {
    for (const typed of ["<b>one</b> and <b>two</b>", "<x>a</x><x>b</x>", "<note>a</note> trailing", "<name>a</names>", "<x>a</x>\n\n<x>b</x>", "<note><note>a</note></note><note>b</note>"]) {
      expect(CodexRolloutParser.isContext(typed), typed).toBe(false);
    }
    for (const context of [
      "<turn_aborted>\nThe user interrupted\n</turn_aborted>",
      "<note><note>a</note></note>",
      '  <ctx id="1">a <ctxs>b</ctxs> c</ctx>\n',
      "<environment_context>\n<cwd>/p</cwd>\n</environment_context>",
    ]) {
      expect(CodexRolloutParser.isContext(context), context).toBe(true);
    }
  });

  it("throws nothing on garbage", () => {
    const parser = new TranscriptParser("codex");
    const garbage = [
      "{",
      "[]",
      "7",
      raw`{"type":"response_item"}`,
      raw`{"type":"response_item","payload":{"type":"message"}}`,
      raw`{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"x","output":7}}`,
      raw`{"type":"event_msg","payload":7}`,
      raw`{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c","name":"exec","input":"tools.exec_command({cmd: [[[[[[[[[["}}`,
    ];
    for (const line of garbage) parser.parse(line);
    expect(parser.stats.lines).toBe(garbage.length);
    expect(parser.stats.malformed).toBe(3);
  });

  it("takes the folder from session_meta only", () => {
    const parser = new TranscriptParser("codex");
    parser.parse(raw`{"ordinal":4,"payload":{"cwd":"/from/turn/context"},"timestamp":"2026-11-01T03:00:00.040Z","type":"turn_context"}`);
    expect(parser.cwd, "turn_context does not count").toBeNull();
    const whole = new TranscriptParser("codex");
    whole.parseText(session);
    expect(whole.cwd).toBe("/Users/fixture/proj");
    expect(whole.stats.skippedTypes.get("session_meta"), "still counted as skipped").toBe(1);
  });

  it("makes the ids a line lacks from its offset (ChatHistorySeamTests, Codex part)", () => {
    const userID = (parser: TranscriptParser, line: string, offset: number | null): string | null => {
      for (const event of parser.parse(line, offset).events) if (event.type === "userMessage") return event.message.id;
      return null;
    };
    const codex = raw`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}`;
    const live = new TranscriptParser("codex");
    const later = new TranscriptParser("codex");
    const id = userID(live, codex, 512);
    expect(id).toBe("codex-message-at512");
    expect(userID(later, codex, 512)).toBe(id);
    expect(userID(live, codex, 9_000)).not.toBe(id);
    expect(userID(new TranscriptParser("codex"), codex, null)).toBe("codex-message-1");
  });
});

describe("malformed and hidden tool input", () => {
  it("never traps on malformed escapes and makes the value unextractable", () => {
    const escapes = [
      "\\u{FFFFFFFFF}",
      "\\u{FFFFFFFFFFFFFFFFFFFFFFFF}",
      "\\u{110000}",
      "\\u{}",
      "\\u{D800}",
      "\\u{41",
      "\\u{4G}",
      "\\xZZ",
      "\\u12",
      "\\uD800x",
    ];
    for (const escape of escapes) {
      const input = `tools.exec_command({cmd: 'cat ${escape}z'})`;
      const calls = CodexScript.calls(input);
      expect(calls.map((call) => call.name), escape).toEqual(["exec_command"]);
      expect(calls[0]?.argument ?? null, escape).toBeNull();
      const call = CodexRolloutParser.customCall("c", "exec", input, null);
      expect(call.kind, escape).toEqual({ other: "script" });
      expect(call.target, escape).toBe(input);
      const template = CodexScript.calls("tools.exec_command({cmd: `cat " + escape + "z`})");
      expect(template[0]?.argument ?? null, "template " + escape).toBeNull();
      const key = CodexScript.calls(`tools.exec_command({'c${escape}': 'cat z'})`);
      expect(key[0]?.argument ?? null, "key " + escape).toBeNull();
    }
    const fine = CodexScript.calls("tools.exec_command({cmd: 'cat \\u{000041}\\u{10FFFF}\\u{1F411}\\x41A😀'})");
    expect(cmd(fine[0]?.argument ?? null)).toBe("cat A\u{10FFFF}\u{1F411}AA\u{1F600}");

    // The whole line through the parser: one fallback row, never a trap.
    const input = raw`tools.exec_command({cmd: '\u{FFFFFFFFF}'})`;
    const line = JSON.stringify({
      ordinal: 1,
      payload: { call_id: "c9", input, name: "exec", type: "custom_tool_call" },
      timestamp: "2026-11-01T04:00:01.000Z",
      type: "response_item",
    });
    const result = new TranscriptParser("codex").parse(line);
    expect(result.outcome).toEqual({ kind: "events" });
    const first = result.events[0];
    expect(first?.type).toBe("toolStarted");
    expect(first?.type === "toolStarted" ? first.call.kind : null).toEqual({ other: "script" });
  });

  it("does not let comments inside a template interpolation hide calls", () => {
    const block = "text(`value ${ /* } tools.fake() */ await tools.exec_command({cmd:'cat a'}) }`);";
    expect(names(block)).toEqual(["exec_command"]);
    const row = script(block);
    expect(row.kind).toBe("read");
    expect(row.target).toBe("a");
    expect(row.moreCalls).toBe(0);
    const line = "text(`v ${ // } tools.fake()\n await tools.exec_command({cmd:'cat b'}) }`);\ntext(await tools.exec_command({cmd:'cat c'}));";
    const calls = CodexScript.calls(line);
    expect(calls.map((call) => call.name)).toEqual(["exec_command", "exec_command"]);
    expect(calls.map((call) => cmd(call.argument))).toEqual(["cat b", "cat c"]);
    // Strings and nested templates inside the interpolation still count as before.
    const nested = "text(`a ${ \"}\" + `${'}'}` } ${ await tools.exec_command({cmd:'cat d'}) }`);";
    expect(CodexScript.calls(nested).map((call) => cmd(call.argument))).toEqual(["cat d"]);
  });
});
