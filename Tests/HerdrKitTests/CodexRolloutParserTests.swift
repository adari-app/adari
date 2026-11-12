import XCTest
@testable import HerdrKit

/// Codex rollouts. Fixtures are hand-built from Codex 0.166.0's rollout
/// records (exec input is a code-mode JavaScript snippet): real structure,
/// invented content.
final class CodexRolloutParserTests: XCTestCase {
    /// Context lines, then three turns: a plain exchange; Read + Edit + a
    /// failed Bash + a passing Bash (after a clock call); then a message with
    /// two uploaded paths and an image, a developer line, two malformed lines,
    /// an unknown type, a two-call script and a build still running.
    static let session = #"""
    {"ordinal":0,"payload":{"cli_version":"0.166.0","cwd":"/Users/fixture/proj","id":"019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b","model_provider":"openai","originator":"codex_cli_rs","session_id":"019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b","source":"cli","timestamp":"2026-11-01T03:00:00.000Z"},"timestamp":"2026-11-01T03:00:00.000Z","type":"session_meta"}
    {"ordinal":1,"payload":{"content":[{"text":"<permissions instructions>\nNetwork is off.\n</permissions instructions>","type":"input_text"}],"id":"m0","role":"developer","type":"message"},"timestamp":"2026-11-01T03:00:00.010Z","type":"response_item"}
    {"ordinal":2,"payload":{"content":[{"text":"# AGENTS.md instructions for /Users/fixture/proj\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>","type":"input_text"}],"id":"m1","role":"user","type":"message"},"timestamp":"2026-11-01T03:00:00.020Z","type":"response_item"}
    {"ordinal":3,"payload":{"content":[{"text":"<environment_context>\n  <cwd>/Users/fixture/proj</cwd>\n  <shell>zsh</shell>\n</environment_context>","type":"input_text"}],"id":"m2","role":"user","type":"message"},"timestamp":"2026-11-01T03:00:00.030Z","type":"response_item"}
    {"ordinal":4,"payload":{"approval_policy":"never","cwd":"/Users/fixture/proj","effort":"high","model":"gpt-5.5-codex"},"timestamp":"2026-11-01T03:00:00.040Z","type":"turn_context"}
    {"ordinal":5,"payload":{"full":true,"state":{"model":{"instructions":"…","model":"gpt-5.5-codex"}}},"timestamp":"2026-11-01T03:00:00.050Z","type":"world_state"}
    {"ordinal":6,"payload":{"collaboration_mode_kind":"default","model_context_window":272000,"root_turn_id":"turn-a","started_at":1793502001,"turn_id":"turn-a","type":"task_started"},"timestamp":"2026-11-01T03:00:01.000Z","type":"event_msg"}
    {"ordinal":7,"payload":{"content":[{"text":"Summarise the README","type":"input_text"}],"id":"m3","role":"user","type":"message"},"timestamp":"2026-11-01T03:00:01.100Z","type":"response_item"}
    {"ordinal":8,"payload":{"encrypted_content":"gAAAAB","id":"rs1","summary":[],"type":"reasoning"},"timestamp":"2026-11-01T03:00:03.000Z","type":"response_item"}
    {"ordinal":9,"payload":{"content":[{"annotations":[],"logprobs":[],"text":"It is a three-line README about the proj.","type":"output_text"}],"id":"m4","phase":"final_answer","role":"assistant","status":"completed","type":"message"},"timestamp":"2026-11-01T03:00:12.000Z","type":"response_item"}
    {"ordinal":10,"payload":{"info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}},"type":"token_count"},"timestamp":"2026-11-01T03:00:12.100Z","type":"event_msg"}
    {"ordinal":11,"payload":{"completed_at":1793502013,"duration_ms":12000,"last_agent_message":"It is a three-line README about the proj.","root_turn_id":"turn-a","started_at":1793502001,"time_to_first_token_ms":900,"turn_id":"turn-a","type":"task_complete"},"timestamp":"2026-11-01T03:00:13.000Z","type":"event_msg"}
    {"ordinal":12,"payload":{"turn_id":"turn-b","type":"task_started"},"timestamp":"2026-11-01T03:10:00.000Z","type":"event_msg"}
    {"ordinal":13,"payload":{"content":[{"text":"Fix the typo in README and run the tests","type":"input_text"}],"id":"m5","role":"user","type":"message"},"timestamp":"2026-11-01T03:10:00.100Z","type":"response_item"}
    {"ordinal":14,"payload":{"call_id":"call_read","id":"ctc1","input":"text(await tools.exec_command({cmd:\"sed -n '1,40p' README.md\", workdir:\"/Users/fixture/proj\"}));","name":"exec","status":"completed","type":"custom_tool_call"},"timestamp":"2026-11-01T03:10:02.000Z","type":"response_item"}
    {"ordinal":15,"payload":{"call_id":"call_read","id":"ctco1","output":[{"text":"Script completed\nWall time 0.2 seconds\nOutput:\nChunk ID: 9f2c\nWall time: 0.0104 seconds\nProcess exited with code 0\nOriginal token count: 30\nOutput:\n# Proj\nA smal tool.\nMIT\n","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T03:10:03.000Z","type":"response_item"}
    {"ordinal":16,"payload":{"call_id":"call_patch","id":"ctc2","input":"text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: /Users/fixture/proj/README.md\\n@@\\n # Proj\\n-A smal tool.\\n+A small tool.\\n*** End Patch\"));","name":"exec","status":"completed","type":"custom_tool_call"},"timestamp":"2026-11-01T03:10:05.000Z","type":"response_item"}
    {"ordinal":17,"payload":{"call_id":"call_patch","id":"ctco2","output":[{"text":"Script completed\nWall time 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nM /Users/fixture/proj/README.md\n","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T03:10:06.000Z","type":"response_item"}
    {"ordinal":18,"payload":{"call_id":"call_test1","id":"ctc3","input":"text(await tools.exec_command({cmd:'swift test --filter ReadmeTest'}));","name":"exec","status":"completed","type":"custom_tool_call"},"timestamp":"2026-11-01T03:10:08.000Z","type":"response_item"}
    {"ordinal":19,"payload":{"call_id":"call_test1","id":"ctco3","output":[{"text":"Script completed\nWall time 3.1 seconds\nOutput:\nChunk ID: a1b2\nWall time: 3.0 seconds\nProcess exited with code 1\nOriginal token count: 12\nOutput:\nerror: no tests matched 'ReadmeTest'\nTest run failed\n","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T03:10:20.000Z","type":"response_item"}
    {"ordinal":20,"payload":{"content":[{"annotations":[],"logprobs":[],"text":"Wrong filter; running the layout tests.","type":"output_text"}],"id":"m6","phase":"commentary","role":"assistant","status":"completed","type":"message"},"timestamp":"2026-11-01T03:10:22.000Z","type":"response_item"}
    {"ordinal":21,"payload":{"call_id":"call_test2","id":"ctc4","input":"const t = await tools.clock__curr_time();\ntext(await tools.exec_command({cmd:`swift test --force-resolved-versions --filter ReadmeLayoutTests`}));","name":"exec","status":"completed","type":"custom_tool_call"},"timestamp":"2026-11-01T03:10:23.000Z","type":"response_item"}
    {"ordinal":22,"payload":{"call_id":"call_test2","id":"ctco4","output":[{"text":"Script completed\nWall time 9.0 seconds\nOutput:\nChunk ID: c3d4\nWall time: 8.9 seconds\nProcess exited with code 0\nOriginal token count: 40\nOutput:\nTest Suite 'ReadmeLayoutTests' passed\nExecuted 3 tests, with 0 failures (0 unexpected) in 0.010 seconds\n","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T03:12:30.000Z","type":"response_item"}
    {"ordinal":23,"payload":{"content":[{"annotations":[],"logprobs":[],"text":"Fixed the typo; the layout tests pass.","type":"output_text"}],"id":"m7","phase":"final_answer","role":"assistant","status":"completed","type":"message"},"timestamp":"2026-11-01T03:12:40.000Z","type":"response_item"}
    {"ordinal":24,"payload":{"duration_ms":161000,"last_agent_message":"Fixed the typo; the layout tests pass.","turn_id":"turn-b","type":"task_complete"},"timestamp":"2026-11-01T03:12:41.000Z","type":"event_msg"}
    {"ordinal":25,"payload":{"turn_id":"turn-c","type":"task_started"},"timestamp":"2026-11-01T03:20:00.000Z","type":"event_msg"}
    {"ordinal":26,"payload":{"content":[{"text":"Why do these differ? /Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png /Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-22222222-2222-2222-2222-222222222222.jpg","type":"input_text"},{"image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB","type":"input_image"}],"id":"m8","role":"user","type":"message"},"timestamp":"2026-11-01T03:20:00.100Z","type":"response_item"}
    {"ordinal":27,"payload":{"content":[{"text":"<collaboration_mode>default</collaboration_mode>","type":"input_text"}],"id":"m9","role":"developer","type":"message"},"timestamp":"2026-11-01T03:20:00.200Z","type":"response_item"}
    {"ordinal":28,"type":"response_item","payload":{"type":"custom_tool_call"
    not json at all
    {"ordinal":30,"payload":{},"timestamp":"2026-11-01T03:20:01.000Z","type":"future_record"}
    {"ordinal":31,"payload":{"call_id":"call_view","id":"ctc5","input":"const [a, b] = await Promise.allSettled([\n  tools.view_image({path:\"/Users/fixture/proj/before.png\"}),\n  tools.view_image({path:'/Users/fixture/proj/after.png'}),\n]);","name":"exec","status":"completed","type":"custom_tool_call"},"timestamp":"2026-11-01T03:20:02.000Z","type":"response_item"}
    {"ordinal":32,"payload":{"call_id":"call_view","id":"ctco5","output":[{"text":"Script completed\nWall time 0.3 seconds\nOutput:\n","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T03:20:03.000Z","type":"response_item"}
    {"ordinal":33,"payload":{"call_id":"call_build","id":"ctc6","input":"text(await tools.exec_command({cmd:\"swift build\", yield_time_ms: 10000}));","name":"exec","status":"completed","type":"custom_tool_call"},"timestamp":"2026-11-01T03:20:05.000Z","type":"response_item"}
    {"ordinal":34,"payload":{"call_id":"call_build","id":"ctco6","output":[{"text":"Script running with cell ID 7\nWall time 10.0 seconds\nOutput:\nCompiling HerdrKit\n","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T03:20:15.000Z","type":"response_item"}
    """#

    static func date(_ iso: String) -> Date { ChatDate.parse(iso)! }

    static func timeline(_ text: String) -> (ChatTimeline, TranscriptParseStats) {
        var parser = TranscriptParser(format: .codex)
        var builder = ChatTimelineBuilder()
        builder.apply(parser.parse(text: text))
        return (builder.timeline, parser.stats)
    }

    /// The row a single exec script makes.
    static func script(_ source: String) -> ChatToolCall {
        CodexRolloutParser.customCall(id: "c", name: "exec", input: source, time: nil)
    }

    // MARK: - the whole session

    func testSessionBuildsThreeTurnsAndCountsEveryLine() {
        let (timeline, stats) = Self.timeline(Self.session)
        XCTAssertEqual(timeline.turns.count, 3)
        XCTAssertEqual(stats.lines, 35)
        XCTAssertEqual(stats.malformed, 2)
        XCTAssertEqual(stats.unknownTypes, ["future_record": 1])
        XCTAssertEqual(stats.skippedTypes["message/user-context"], 2)
        XCTAssertEqual(stats.skippedTypes["message/developer"], 2)
        XCTAssertEqual(stats.skippedTypes["response_item/reasoning"], 1)
        XCTAssertEqual(stats.skippedTypes["event_msg/token_count"], 1)
        XCTAssertEqual(stats.skippedTypes["session_meta"], 1)
        XCTAssertEqual(stats.lines, stats.linesWithEvents + stats.skipped + stats.malformed + stats.unknown)
    }

    func testPlainExchangeSkipsInstructionsAndUsesTheReportedDuration() {
        let turn = Self.timeline(Self.session).0.turns[0]
        XCTAssertEqual(turn.items.count, 2)
        XCTAssertEqual(turn.userMessage?.text, "Summarise the README")
        guard case .agentText(let reply) = turn.items[1] else { return XCTFail() }
        XCTAssertEqual(reply.markdown, "It is a three-line README about the proj.")
        XCTAssertEqual(turn.footer?.duration, 12)
        XCTAssertEqual(turn.footer?.start, Self.date("2026-11-01T03:00:01.000Z"))
        XCTAssertEqual(turn.footer?.end, Self.date("2026-11-01T03:00:13.000Z"))
    }

    func testToolTurnReadsEditsAndKeepsTheFailedCommandOpen() {
        let turn = Self.timeline(Self.session).0.turns[1]
        let calls = turn.toolCalls
        XCTAssertEqual(calls.map(\.kind), [.read, .edit, .bash, .bash])
        XCTAssertEqual(calls[0].target, "README.md")
        XCTAssertEqual(calls[0].resultSummary, "3 lines")
        XCTAssertEqual(calls[1].target, "/Users/fixture/proj/README.md")
        XCTAssertEqual(calls[1].resultSummary, "+1 \u{2212}1")
        XCTAssertEqual(calls[1].detail, .diff(ChatDiff(
            files: ["/Users/fixture/proj/README.md"], added: 1, removed: 1,
            lines: [ChatDiffLine(.context, "# Proj"), ChatDiffLine(.removed, "A smal tool."),
                    ChatDiffLine(.added, "A small tool.")], moreLines: 0)))
        XCTAssertEqual(calls[2].state, .failed)
        XCTAssertEqual(calls[2].resultSummary, "exit 1")
        XCTAssertEqual(calls[2].detail, .bash(ChatBashDetail(
            command: "swift test --filter ReadmeTest",
            outputTail: ["error: no tests matched 'ReadmeTest'", "Test run failed"], exitCode: 1)))
        XCTAssertEqual(calls[3].target, "swift test --force-resolved-versions --filter ReadmeLayoutTests")
        XCTAssertEqual(calls[3].moreCalls, 0, "the clock call does not count")
        XCTAssertEqual(calls[3].state, .ok)
        XCTAssertEqual(calls[3].resultSummary, "exit 0")
        XCTAssertTrue(calls.allSatisfy { $0.toolName == "exec" })

        XCTAssertTrue(turn.isFinished)
        XCTAssertEqual(turn.footer?.workedForText, "Worked for 2m 41s")
        XCTAssertEqual(turn.foldSummary, "Read 1 file, edited 1 file, ran 1 command")
        XCTAssertEqual(turn.rows.map(\.id), ["m5", "turn-2/folded", "call_test1", "m6", "m7"])
    }

    func testAttachmentsImageMultiCallScriptAndARunningTurn() throws {
        let timeline = Self.timeline(Self.session).0
        let turn = timeline.turns[2]
        let message = try XCTUnwrap(turn.userMessage)
        XCTAssertEqual(message.text, "Why do these differ?")
        XCTAssertEqual(message.attachments, [
            ChatAttachment(mediaType: "image/png"),
            ChatAttachment(path: ClaudeTranscriptParserTests.attachmentA),
            ChatAttachment(path: ClaudeTranscriptParserTests.attachmentB),
        ])
        XCTAssertFalse(String(describing: timeline).contains("iVBORw0KGgo"))
        XCTAssertFalse(turn.isFinished)
        XCTAssertEqual(timeline.workingSince, Self.date("2026-11-01T03:20:00.000Z"))
        let calls = turn.toolCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].kind, .read)
        XCTAssertEqual(calls[0].target, "/Users/fixture/proj/before.png")
        XCTAssertEqual(calls[0].moreCalls, 1)
        XCTAssertEqual(calls[0].resultSummary, "+1 more")
        XCTAssertEqual(calls[1].kind, .bash)
        XCTAssertEqual(calls[1].state, .running, "Script running with cell ID: its result comes later")
        XCTAssertEqual(turn.rows.count, 3)
    }

    // MARK: - code-mode scripts

    func testScriptCallsAreFoundInOrderPastStringsAndComments() {
        let source = #"""
        // tools.ignored("in a comment")
        const note = "tools.not_a_call(1)";
        const r = await Promise.allSettled([tools.exec_command({cmd: "rg -n 'tools.fake(' App"}), tools.write_stdin({session_id: 3, chars: "q"})]);
        /* tools.also_ignored() */ text(`${await tools.clock__curr_time()}`);
        """#
        XCTAssertEqual(CodexScript.calls(in: source).map(\.name), ["exec_command", "write_stdin", "clock__curr_time"])
        let call = Self.script(source)
        XCTAssertEqual(call.kind, .search)
        XCTAssertEqual(call.target, "tools.fake(")
        XCTAssertEqual(call.moreCalls, 1)
    }

    func testCallsInsideNestedTemplatesAreFoundOnce() {
        let source = "text(`a ${`b ${await tools.exec_command({cmd: \"ls\"})}`} ${await tools.view_image({path: 'x.png'})}`);"
        XCTAssertEqual(CodexScript.calls(in: source).map(\.name), ["exec_command", "view_image"])
    }

    func testScriptArgumentsDecodeAllQuotesEscapesAndJoins() {
        let calls = CodexScript.calls(in: #"tools.exec_command({cmd: 'echo \'hi\'\n' + "and \"more\"" + `\u{1F600}`, n: 0x10, flag: true, list: [1, -2.5, null], short})"#)
        XCTAssertEqual(calls.first?.argument, .object([
            "cmd": .string("echo 'hi'\nand \"more\"\u{1F600}"),
            "n": .number(16), "flag": .bool(true), "list": .array([.number(1), .number(-2.5), .null]),
            "short": .identifier("short"),
        ]))
    }

    func testExecCommandWithAHeredocIsBash() {
        let call = Self.script(#"text(await tools.exec_command({cmd:"python3 - <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY", workdir:"/p"}));"#)
        XCTAssertEqual(call.kind, .bash)
        XCTAssertEqual(call.target, "python3 - <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY")
    }

    func testEachToolNameMapsToItsRow() {
        XCTAssertEqual(Self.script(#"text(await tools.web__run({search_query:[{q:"sftp read limit"}]}));"#).kind, .web)
        XCTAssertEqual(Self.script(#"text(await tools.web__run({find:[{ref_id:"https://example.com/a",pattern:"64"}]}));"#).target, "https://example.com/a")
        let stdin = Self.script(#"text(await tools.write_stdin({session_id: 12, chars: "y\n"}));"#)
        XCTAssertEqual(stdin.kind, .bash)
        XCTAssertEqual(stdin.target, "input to a running command")
        XCTAssertEqual(Self.script(#"tools.view_image({path:"/p/x.png"})"#).target, "/p/x.png")
        XCTAssertEqual(Self.script(#"text(await tools.mcp__xcode__XcodeListWorkspaces({}));"#).kind, .other("XcodeListWorkspaces"))
        let patch = Self.script(#"text(await tools.apply_patch('*** Begin Patch\n*** Add File: /p/new.md\n+# New\n+text\n*** End Patch'));"#)
        XCTAssertEqual(patch.kind, .edit)
        XCTAssertEqual(patch.target, "/p/new.md")
        XCTAssertEqual(patch.resultSummary, nil, "the builder adds the starting summary")
        XCTAssertEqual(ChatToolResults.startingSummary(patch), "+2 \u{2212}0")
        let plan = Self.script(#"tools.update_plan({plan:[{step:"Read",status:"completed"},{step:"Fix",status:"in_progress"}]})"#)
        XCTAssertEqual(plan.kind, .plan)
        XCTAssertEqual(plan.target, "Fix")
    }

    func testScriptsItCannotReadAreOtherScriptWithTheirFirstLine() {
        let clockOnly = Self.script("text(await tools.clock__curr_time());")
        XCTAssertEqual(clockOnly.kind, .other("script"))
        XCTAssertEqual(clockOnly.target, "text(await tools.clock__curr_time());")
        let variable = Self.script("const c = build();\ntext(await tools.exec_command(c));")
        XCTAssertEqual(variable.kind, .other("script"))
        XCTAssertEqual(variable.target, "const c = build();")
        XCTAssertEqual(Self.script(#"text("hello")"#).kind, .other("script"))
        XCTAssertEqual(Self.script("").kind, .other("script"))
        XCTAssertEqual(Self.script("tools.exec_command({cmd: \"unterminated").kind, .other("script"))
    }

    func testOlderExecInputAsJSONStillReadsTheCommand() {
        let call = CodexRolloutParser.customCall(id: "c", name: "exec", input: #"{"cmd":"rg -n needle src","workdir":"/p"}"#, time: nil)
        XCTAssertEqual(call.kind, .search)
        XCTAssertEqual(call.target, "needle")
    }

    // MARK: - outputs

    func testOutputHeadersAreParsed() {
        XCTAssertEqual(CodexRolloutParser.parseHeaders("Script failed\nWall time 0.0 seconds\nOutput:\nTypeError: tools.nope is not a function"),
                       ChatToolOutput(text: "TypeError: tools.nope is not a function", isError: true))
        XCTAssertEqual(CodexRolloutParser.parseHeaders("Script running with cell ID 9\nWall time 10.0 seconds\nOutput:\npartial"),
                       ChatToolOutput(text: "partial", isRunning: true))
        XCTAssertEqual(CodexRolloutParser.parseHeaders("Exit code: 2\nWall time: 0.3 seconds\nOutput:\nboom"),
                       ChatToolOutput(text: "boom", exitCode: 2))
        XCTAssertEqual(CodexRolloutParser.parseHeaders("plain text\nOutput:\nnot a header"),
                       ChatToolOutput(text: "plain text\nOutput:\nnot a header"))
        XCTAssertEqual(CodexRolloutParser.output(#"{"output":"a\nb\n","metadata":{"exit_code":0,"duration_seconds":0.1}}"#),
                       ChatToolOutput(text: "a\nb\n", exitCode: 0))
    }

    func testScriptFailedMakesAnyRowFailed() {
        let text = [
            #"{"ordinal":1,"payload":{"content":[{"text":"Go","type":"input_text"}],"id":"m1","role":"user","type":"message"},"timestamp":"2026-11-01T04:00:00.000Z","type":"response_item"}"#,
            #"{"ordinal":2,"payload":{"call_id":"c1","input":"text(await tools.view_image({path:\"/p/a.png\"}));","name":"exec","type":"custom_tool_call"},"timestamp":"2026-11-01T04:00:01.000Z","type":"response_item"}"#,
            #"{"ordinal":3,"payload":{"call_id":"c1","output":[{"text":"Script failed\nWall time 0.0 seconds\nOutput:\nError: not found","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-01T04:00:02.000Z","type":"response_item"}"#,
        ].joined(separator: "\n")
        let call = Self.timeline(text).0.turns[0].toolCalls[0]
        XCTAssertEqual(call.state, .failed)
        XCTAssertEqual(call.resultSummary, nil)
    }

    // MARK: - older function calls and other items

    func testFunctionCallsForAgentsPlanShellAndPatch() {
        func call(_ name: String, _ arguments: String) -> ChatToolCall {
            CodexRolloutParser.functionCall(id: "f", name: name, arguments: arguments, time: nil)
        }
        XCTAssertEqual(call("send_message", #"{"target":"agent-2","message":"Check the tests"}"#),
                       ChatToolCall(id: "f", kind: .agent, toolName: "send_message", target: "Message agent",
                                    detail: .text("Check the tests")))
        XCTAssertEqual(call("wait", #"{"seconds":30}"#).target, "Wait")
        XCTAssertEqual(call("wait_agent", #"{"id":"agent-2"}"#).target, "Wait")
        XCTAssertEqual(call("spawn_agent", #"{"task":"Review the diff"}"#).target, "Start agent")
        XCTAssertEqual(call("update_plan", #"{"plan":[{"step":"A","status":"completed"},{"step":"B","status":"pending"}]}"#).detail,
                       .plan([ChatPlanStep(text: "A", status: .completed), ChatPlanStep(text: "B", status: .pending)]))
        let shell = call("shell", #"{"command":["bash","-lc","cat Package.swift"],"workdir":"/p"}"#)
        XCTAssertEqual(shell.kind, .read)
        XCTAssertEqual(shell.target, "Package.swift")
        XCTAssertEqual(call("shell", #"{"command":["git","log","--oneline","-n","3"]}"#).target, "git log --oneline -n 3")
        XCTAssertEqual(call("apply_patch", #"{"input":"*** Begin Patch\n*** Update File: a.txt\n-x\n+y\n*** End Patch"}"#).kind, .edit)
        XCTAssertEqual(call("web_search", #"{"query":"codex rollout"}"#).target, "codex rollout")
        XCTAssertEqual(call("mcp__github__list_prs", #"{"repo":"x"}"#).kind, .other("list_prs"))
        XCTAssertEqual(call("brand_new_tool", "not json").kind, .other("brand_new_tool"))
    }

    func testOlderShellFunctionCallWithJSONOutput() {
        let text = [
            #"{"payload":{"content":[{"text":"Show the manifest","type":"input_text"}],"role":"user","type":"message"},"timestamp":"2026-11-01T05:00:00.000Z","type":"response_item"}"#,
            #"{"payload":{"arguments":"{\"command\":[\"bash\",\"-lc\",\"cat Package.swift\"]}","call_id":"fc1","name":"shell","type":"function_call"},"timestamp":"2026-11-01T05:00:01.000Z","type":"response_item"}"#,
            #"{"payload":{"call_id":"fc1","output":"{\"output\":\"// swift-tools-version:5.9\\nlet package = Package()\\n\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.1}}","type":"function_call_output"},"timestamp":"2026-11-01T05:00:02.000Z","type":"response_item"}"#,
            #"{"payload":{"action":{"query":"swift package manifest","type":"search"},"id":"ws1","status":"completed","type":"web_search_call"},"timestamp":"2026-11-01T05:00:03.000Z","type":"response_item"}"#,
        ].joined(separator: "\n")
        let calls = Self.timeline(text).0.turns[0].toolCalls
        XCTAssertEqual(calls.map(\.kind), [.read, .web])
        XCTAssertEqual(calls[0].resultSummary, "2 lines")
        XCTAssertEqual(calls[1].target, "swift package manifest")
        XCTAssertEqual(calls[1].state, .ok)
    }

    func testContextDetection() {
        XCTAssertTrue(CodexRolloutParser.isContext("<environment_context>\n<cwd>/p</cwd>\n</environment_context>"))
        XCTAssertTrue(CodexRolloutParser.isContext("  <user_instructions>be nice</user_instructions>  "))
        XCTAssertTrue(CodexRolloutParser.isContext("<permissions instructions>x</permissions instructions>"))
        XCTAssertTrue(CodexRolloutParser.isContext("<turn_aborted reason=\"user\">stopped</turn_aborted>"))
        XCTAssertTrue(CodexRolloutParser.isContext("# AGENTS.md instructions for /p\n\nrules"))
        XCTAssertFalse(CodexRolloutParser.isContext("Fix <b>bold</b> rendering"))
        XCTAssertFalse(CodexRolloutParser.isContext("<b>one</b> and <i>two</i>"), "two elements, not one")
        XCTAssertFalse(CodexRolloutParser.isContext("Why is 3 < 4 > 2?"))
    }

    func testNothingThrowsOnGarbage() {
        var parser = TranscriptParser(format: .codex)
        let garbage = ["{", "[]", "7", #"{"type":"response_item"}"#, #"{"type":"response_item","payload":{"type":"message"}}"#,
                       #"{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"x","output":7}}"#,
                       #"{"type":"event_msg","payload":7}"#, #"{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"c","name":"exec","input":"tools.exec_command({cmd: [[[[[[[[[["}}"#]
        for line in garbage { _ = parser.parse(line: line) }
        XCTAssertEqual(parser.stats.lines, garbage.count)
        XCTAssertEqual(parser.stats.malformed, 3)
    }

    func testCwdComesFromSessionMetaOnly() {
        var parser = TranscriptParser(format: .codex)
        _ = parser.parse(line: #"{"ordinal":4,"payload":{"cwd":"/from/turn/context"},"timestamp":"2026-11-01T03:00:00.040Z","type":"turn_context"}"#)
        XCTAssertNil(parser.cwd, "turn_context does not count")
        var whole = TranscriptParser(format: .codex)
        _ = whole.parse(text: Self.session)
        XCTAssertEqual(whole.cwd, "/Users/fixture/proj")
        XCTAssertEqual(whole.stats.skippedTypes["session_meta"], 1, "still counted as skipped")
    }

    // MARK: - escapes, interpolations, results and context

    /// An escape past UInt32 (`\u{FFFFFFFFF}`) must not trap. A malformed
    /// escape makes the value unextractable, so the row falls back.
    func testMalformedEscapesNeverTrapAndMakeTheValueUnextractable() throws {
        let escapes = [#"\u{FFFFFFFFF}"#, #"\u{FFFFFFFFFFFFFFFFFFFFFFFF}"#, #"\u{110000}"#, #"\u{}"#, #"\u{D800}"#,
                       #"\u{41"#, #"\u{4G}"#, #"\xZZ"#, #"\u12"#, #"\uD800x"#]
        for escape in escapes {
            let input = "tools.exec_command({cmd: 'cat \(escape)z'})"
            let calls = CodexScript.calls(in: input)
            XCTAssertEqual(calls.map(\.name), ["exec_command"], escape)
            XCTAssertNil(calls.first?.argument, escape)
            let call = CodexRolloutParser.customCall(id: "c", name: "exec", input: input, time: nil)
            XCTAssertEqual(call.kind, .other("script"), escape)
            XCTAssertEqual(call.target, input, escape)
            let template = CodexScript.calls(in: "tools.exec_command({cmd: `cat \(escape)z`})")
            XCTAssertNil(template.first?.argument, "template " + escape)
            let key = CodexScript.calls(in: "tools.exec_command({'c\(escape)': 'cat z'})")
            XCTAssertNil(key.first?.argument, "key " + escape)
        }
        let fine = CodexScript.calls(in: #"tools.exec_command({cmd: 'cat \u{000041}\u{10FFFF}\u{1F411}\x41A😀'})"#)
        XCTAssertEqual(fine.first?.argument?["cmd"]?.string, "cat A\u{10FFFF}\u{1F411}AA\u{1F600}")

        // The whole line through the parser: one fallback row, never a trap.
        let input = #"tools.exec_command({cmd: '\u{FFFFFFFFF}'})"#
        let payload: [String: Any] = ["call_id": "c9", "input": input, "name": "exec", "type": "custom_tool_call"]
        let line: [String: Any] = ["ordinal": 1, "payload": payload, "timestamp": "2026-11-01T04:00:01.000Z", "type": "response_item"]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: line), as: UTF8.self)
        var parser = TranscriptParser(format: .codex)
        let result = parser.parse(line: json)
        XCTAssertEqual(result.outcome, .events)
        guard case .toolStarted(let row)? = result.events.first else { return XCTFail("no row") }
        XCTAssertEqual(row.kind, .other("script"))
    }

    /// A `}` inside a comment does not end the interpolation early or hide
    /// the real call.
    func testCommentsInsideATemplateInterpolationDoNotHideCalls() {
        let block = #"text(`value ${ /* } tools.fake() */ await tools.exec_command({cmd:'cat a'}) }`);"#
        XCTAssertEqual(CodexScript.calls(in: block).map(\.name), ["exec_command"])
        let row = Self.script(block)
        XCTAssertEqual(row.kind, .read)
        XCTAssertEqual(row.target, "a")
        XCTAssertEqual(row.moreCalls, 0)
        let line = "text(`v ${ // } tools.fake()\n await tools.exec_command({cmd:'cat b'}) }`);\ntext(await tools.exec_command({cmd:'cat c'}));"
        let calls = CodexScript.calls(in: line)
        XCTAssertEqual(calls.map(\.name), ["exec_command", "exec_command"])
        XCTAssertEqual(calls.map { $0.argument?["cmd"]?.string }, ["cat b", "cat c"])
        // Strings and nested templates inside the interpolation still count as before.
        let nested = #"text(`a ${ "}" + `${'}'}` } ${ await tools.exec_command({cmd:'cat d'}) }`);"#
        XCTAssertEqual(CodexScript.calls(in: nested).map { $0.argument?["cmd"]?.string }, ["cat d"])
    }

    private static func finished(_ source: String, _ raw: String) -> ChatToolCall {
        var call = script(source)
        ChatToolResults.apply(CodexRolloutParser.parseHeaders(raw), to: &call, at: nil)
        return call
    }

    private static let completed = "Script completed\nWall time 0.1 seconds\nOutput:\n"

    /// `text(await tools.exec_command(...))` prints the command's result
    /// object; its exit code and output are kept.
    func testAPrintedCommandResultObjectKeepsItsStatusAndOutput() throws {
        let failing = Self.completed + #"{"exit_code":2,"output":"command failed\n","wall_time_seconds":0.1}"#
        XCTAssertEqual(CodexRolloutParser.parseHeaders(failing), ChatToolOutput(text: "command failed\n", exitCode: 2))
        let build = Self.finished("text(await tools.exec_command({cmd: 'swift build'}));", failing)
        XCTAssertEqual(build.state, .failed)
        XCTAssertEqual(build.resultSummary, "exit 2")
        guard case .bash(let detail) = build.detail else { return XCTFail("no bash detail") }
        XCTAssertEqual(detail.outputTail, ["command failed"])

        let read = Self.finished("text(await tools.exec_command({cmd: 'cat a.txt'}));",
                                 Self.completed + #"{"exit_code":0,"output":"one\ntwo\nthree\n","wall_time_seconds":0.0}"#)
        XCTAssertEqual(read.state, .ok)
        XCTAssertEqual(read.resultSummary, "3 lines", "the output's lines, not the object's")

        // A command still running in a session: its output so far, no exit code,
        // and the row is not kept running (as the textual header form).
        let running = CodexRolloutParser.parseHeaders(Self.completed + #"{"output":"Compiling 3 of 9","session_id":7,"wall_time_seconds":10.0}"#)
        XCTAssertEqual(running, ChatToolOutput(text: "Compiling 3 of 9"))
        XCTAssertEqual(CodexRolloutParser.parseHeaders(Self.completed + "Process running with session ID 7\nOutput:\nCompiling 3 of 9"), running)

        // JSON a command printed stays its output.
        for stdout in [#"{"output":"x","name":"y","exit_code":1}"#, #"{"output":"x"}"#, #"{"exit_code":"2","output":"x"}"#,
                       #"{"exit_code":2,"output":["x"]}"#, #"[{"exit_code":2,"output":"x"}]"#] {
            XCTAssertEqual(CodexRolloutParser.parseHeaders(Self.completed + stdout), ChatToolOutput(text: stdout), stdout)
        }
        let bare = #"{"exit_code":2,"output":"x","wall_time_seconds":0.1}"#
        XCTAssertEqual(CodexRolloutParser.parseHeaders(bare), ChatToolOutput(text: bare), "no script header: not a result")

        // Through a whole transcript.
        let lines: [[String: Any]] = [
            ["ordinal": 1, "type": "response_item", "timestamp": "2026-11-01T04:00:00.000Z",
             "payload": ["type": "message", "role": "user", "id": "m1", "content": [["type": "input_text", "text": "Build it"]]]],
            ["ordinal": 2, "type": "response_item", "timestamp": "2026-11-01T04:00:01.000Z",
             "payload": ["type": "custom_tool_call", "call_id": "c1", "name": "exec", "input": "text(await tools.exec_command({cmd: 'swift build'}));"]],
            ["ordinal": 3, "type": "response_item", "timestamp": "2026-11-01T04:00:02.000Z",
             "payload": ["type": "custom_tool_call_output", "call_id": "c1", "output": [["type": "input_text", "text": failing]]]],
        ]
        let text = try lines.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }.joined(separator: "\n")
        let call = try XCTUnwrap(Self.timeline(text).0.turns.first?.toolCalls.first)
        XCTAssertEqual(call.state, .failed)
        XCTAssertEqual(call.resultSummary, "exit 2")
    }

    /// A non-zero exit fails every kind of row, not only Bash: a failed
    /// `cat` (Read) or `rg` (Search) does not fold as a success.
    func testANonZeroExitFailsEveryKindAndANoMatchSearchIsExplicit() {
        let missing = Self.finished("text(await tools.exec_command({cmd: 'cat /missing/file'}));",
                                    Self.completed + "Process exited with code 1\nOutput:\ncat: /missing/file: No such file or directory")
        XCTAssertEqual(missing.kind, .read)
        XCTAssertEqual(missing.state, .failed)
        XCTAssertNil(missing.resultSummary, "no line count for a failed read")
        let object = Self.finished("text(await tools.exec_command({cmd: 'cat /missing/file'}));",
                                   Self.completed + #"{"exit_code":1,"output":"cat: /missing/file: No such file or directory\n","wall_time_seconds":0.0}"#)
        XCTAssertEqual(object.state, .failed)

        let badOption = Self.finished("text(await tools.exec_command({cmd: 'rg --bogus needle src'}));",
                                      Self.completed + "Process exited with code 2\nOutput:\nrg: unrecognized flag --bogus")
        XCTAssertEqual(badOption.kind, .search)
        XCTAssertEqual(badOption.state, .failed)
        XCTAssertEqual(badOption.resultSummary, "failed")
        let missingFolder = Self.finished("text(await tools.exec_command({cmd: 'rg needle nowhere'}));",
                                          Self.completed + "Process exited with code 1\nOutput:\nrg: nowhere: No such file or directory (os error 2)")
        XCTAssertEqual(missingFolder.state, .failed, "exit 1 with output is a failure")

        // grep and rg exit 1 when nothing matches: no output is "no matches", not a failure.
        let noMatches = Self.finished("text(await tools.exec_command({cmd: 'rg needle src'}));",
                                      Self.completed + "Process exited with code 1\nOutput:\n")
        XCTAssertEqual(noMatches.state, .ok)
        XCTAssertEqual(noMatches.resultSummary, "0 files")

        let patch = Self.finished("text(await tools.exec_command({cmd: \"apply_patch <<'EOF'\\n*** Begin Patch\\n*** Update File: a.swift\\n-old\\n+new\\n*** End Patch\\nEOF\"}));",
                                  Self.completed + "Process exited with code 1\nOutput:\nerror: patch does not apply")
        XCTAssertEqual(patch.kind, .edit)
        XCTAssertEqual(patch.state, .failed)

        let fine = Self.finished("text(await tools.exec_command({cmd: 'cat a.txt'}));", Self.completed + "Process exited with code 0\nOutput:\na\nb")
        XCTAssertEqual(fine.state, .ok)
        XCTAssertEqual(fine.resultSummary, "2 lines")
    }

    /// Separate elements with the same tag name are not one wrapping
    /// context element, so the typed message is kept.
    func testOnlyOneElementCoveringTheWholeBlockIsContext() throws {
        for typed in ["<b>one</b> and <b>two</b>", "<x>a</x><x>b</x>", "<note>a</note> trailing", "<name>a</names>",
                      "<x>a</x>\n\n<x>b</x>", "<note><note>a</note></note><note>b</note>"] {
            XCTAssertFalse(CodexRolloutParser.isContext(typed), typed)
        }
        for context in ["<turn_aborted>\nThe user interrupted\n</turn_aborted>", "<note><note>a</note></note>",
                        "  <ctx id=\"1\">a <ctxs>b</ctxs> c</ctx>\n", "<environment_context>\n<cwd>/p</cwd>\n</environment_context>"] {
            XCTAssertTrue(CodexRolloutParser.isContext(context), context)
        }
        let line: [String: Any] = ["ordinal": 1, "type": "response_item", "timestamp": "2026-11-01T04:00:00.000Z",
                                   "payload": ["type": "message", "role": "user", "id": "m1",
                                               "content": [["type": "input_text", "text": "<b>one</b> and <b>two</b>"]]]]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: line), as: UTF8.self)
        XCTAssertEqual(Self.timeline(text).0.turns.first?.userMessage?.text, "<b>one</b> and <b>two</b>")
    }

    // MARK: - exit 1 of a search

    /// ls and find also show as Search, but their exit 1
    /// is a failure; only grep-style programs use exit 1 for "no match".
    func testOnlyGrepStyleProgramsTreatASilentExitOneAsNoMatches() {
        for command in ["ls /missing/folder 2>/dev/null", "find /missing/folder 2>/dev/null", "fd needle /missing 2>/dev/null"] {
            var call = Self.script("tools.exec_command({cmd: '\(command)'})")
            XCTAssertEqual(call.kind, .search, command)
            ChatToolResults.apply(ChatToolOutput(text: "", exitCode: 1), to: &call, at: nil)
            XCTAssertEqual(call.state, .failed, command)
            XCTAssertEqual(call.resultSummary, "failed", command)
        }
        for command in ["rg needle src", "grep -rn needle src", "egrep 'a|b' file.txt", "fgrep needle file.txt",
                        "cd src && rg needle", "/usr/bin/grep needle file.txt"] {
            var call = Self.script("tools.exec_command({cmd: \"\(command)\"})")
            XCTAssertEqual(call.kind, .search, command)
            ChatToolResults.apply(ChatToolOutput(text: "", exitCode: 1), to: &call, at: nil)
            XCTAssertEqual(call.state, .ok, command)
            XCTAssertEqual(call.resultSummary, "0 files", command)
            var failed = Self.script("tools.exec_command({cmd: \"\(command)\"})")
            ChatToolResults.apply(ChatToolOutput(text: "", exitCode: 2), to: &failed, at: nil)
            XCTAssertEqual(failed.state, .failed, "exit 2 " + command)
        }
        // A Search row that is not a command (Claude Code's Grep tool) has no exit code to judge.
        var grepTool = ChatToolCall(id: "g", kind: .search, toolName: "Grep", target: "needle",
                                    detail: .search(ChatSearchDetail(pattern: "needle")))
        ChatToolResults.apply(ChatToolOutput(text: "No files found"), to: &grepTool, at: nil)
        XCTAssertEqual(grepTool.state, .ok)
    }
}
