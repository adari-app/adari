import XCTest
@testable import HerdrKit

/// Claude Code transcripts. Fixtures are hand-built from Claude Code
/// 2.1.316's transcript records: real structure, invented content.
final class ClaudeTranscriptParserTests: XCTestCase {
    static let attachmentA = "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png"
    static let attachmentB = "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-22222222-2222-2222-2222-222222222222.jpg"

    /// Three turns: a plain exchange; Read + Edit + a failed Bash + a passing
    /// Bash with an interleaved subagent (sidechain) pair; then a message with
    /// two uploaded paths, a meta line, two malformed lines, an unknown type,
    /// a Grep and a Bash still running.
    static let session = #"""
    {"permissionMode":"auto","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","type":"permission-mode"}
    {"mode":"normal","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","type":"mode"}
    {"isSnapshotUpdate":false,"messageId":"u1","snapshot":{"messageId":"u1","timestamp":"2026-11-01T02:00:00.000Z","trackedFileBackups":{}},"type":"file-history-snapshot"}
    {"cwd":"/Users/fixture/proj","entrypoint":"cli","gitBranch":"main","isSidechain":false,"message":{"content":"What does the follower do?","role":"user"},"origin":{"kind":"user"},"parentUuid":null,"permissionMode":"auto","promptId":"p1","promptSource":"user","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:00:00.000Z","turnOrigin":"user","turnPosition":{"promptIndex":0,"turnIndex":0},"type":"user","userType":"external","uuid":"u1","version":"2.1.316"}
    {"cwd":"/Users/fixture/proj","isSidechain":false,"message":{"content":[{"signature":"c2ln","thinking":"Consider the tail.","type":"thinking"}],"id":"msg_01","model":"claude-opus-5-5","role":"assistant","stop_reason":null,"stop_sequence":null,"type":"message","usage":{"input_tokens":12,"output_tokens":4}},"parentUuid":"u1","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:00:02.000Z","type":"assistant","uuid":"a1","version":"2.1.316"}
    {"cwd":"/Users/fixture/proj","isSidechain":false,"message":{"content":[{"text":"It keeps the **partial** tail between reads.","type":"text"}],"id":"msg_01","model":"claude-opus-5-5","role":"assistant","stop_reason":"end_turn","stop_sequence":null,"type":"message"},"parentUuid":"a1","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:00:05.000Z","type":"assistant","uuid":"a2","version":"2.1.316"}
    {"aiTitle":"Explain the follower","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","type":"ai-title"}
    {"lastPrompt":"What does the follower do?","leafUuid":"a2","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","type":"last-prompt"}
    {"id":"req_1","params":{"max_tokens":32000,"model":"claude-opus-5-5"},"querySource":"repl","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:00:01.000Z","type":"api-request","version":"2.1.316"}
    {"cwd":"/Users/fixture/proj","isSidechain":false,"message":{"content":"Fix the scroll mask in View.swift","role":"user"},"parentUuid":"a2","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:00.000Z","type":"user","uuid":"u2","version":"2.1.316"}
    {"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_read","input":{"file_path":"/Users/fixture/proj/App/View.swift","limit":200,"offset":1},"name":"Read","type":"tool_use"}],"id":"msg_02","role":"assistant","stop_reason":"tool_use","type":"message"},"parentUuid":"u2","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:02.000Z","type":"assistant","uuid":"a3"}
    {"isSidechain":false,"message":{"content":[{"content":"     1→import UIKit\n     2→\n     3→final class View: UIView {\n     4→    let pan = UIPanGestureRecognizer()\n     5→}\n","is_error":false,"tool_use_id":"toolu_read","type":"tool_result"}],"role":"user"},"parentUuid":"a3","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:03.000Z","type":"user","uuid":"u3"}
    {"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_edit","input":{"file_path":"/Users/fixture/proj/App/View.swift","new_string":"    let pan = UIPanGestureRecognizer()\n    pan.allowedScrollTypesMask = .all\n    pan.maximumNumberOfTouches = 2\n}","old_string":"    let pan = UIPanGestureRecognizer()\n    pan.allowedScrollTypesMask = []\n}","replace_all":false},"name":"Edit","type":"tool_use"}],"id":"msg_03","role":"assistant","stop_reason":"tool_use","type":"message"},"parentUuid":"u3","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:05.000Z","type":"assistant","uuid":"a4"}
    {"isSidechain":false,"message":{"content":[{"content":"The file /Users/fixture/proj/App/View.swift has been updated.","is_error":false,"tool_use_id":"toolu_edit","type":"tool_result"}],"role":"user"},"parentUuid":"a4","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:06.000Z","type":"user","uuid":"u4"}
    {"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_bash1","input":{"command":"swift test --filter ViewTest","description":"Run the view tests"},"name":"Bash","type":"tool_use"}],"id":"msg_04","role":"assistant","stop_reason":"tool_use","type":"message"},"parentUuid":"u4","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:08.000Z","type":"assistant","uuid":"a5"}
    {"isSidechain":false,"message":{"content":[{"content":"Exit code 1\nerror: no tests matched 'ViewTest'\nTest run failed","is_error":true,"tool_use_id":"toolu_bash1","type":"tool_result"}],"role":"user"},"parentUuid":"a5","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:20.000Z","type":"user","uuid":"u5"}
    {"isSidechain":false,"message":{"content":[{"text":"Wrong filter; running the suite.","type":"text"}],"id":"msg_05","role":"assistant","stop_reason":null,"type":"message"},"parentUuid":"u5","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:22.000Z","type":"assistant","uuid":"a6"}
    {"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_bash2","input":{"command":"swift test --filter ViewTests","description":"Run the view tests"},"name":"Bash","type":"tool_use"}],"id":"msg_05","role":"assistant","stop_reason":"tool_use","type":"message"},"parentUuid":"a6","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:23.000Z","type":"assistant","uuid":"a7"}
    {"attachment":{"command":"lint","content":"","durationMs":12,"exitCode":0,"hookEvent":"PostToolUse","hookName":"lint","stderr":"","stdout":"","toolUseID":"toolu_bash2","type":"hook_success"},"cwd":"/Users/fixture/proj","isSidechain":false,"parentUuid":null,"sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:10:24.000Z","type":"attachment","uuid":"h1"}
    {"isSidechain":false,"message":{"content":[{"content":[{"text":"Test Suite 'ViewTests' passed at 2026-11-01 02:41:07.311.\nExecuted 6 tests, with 0 failures (0 unexpected) in 0.208 seconds","type":"text"}],"is_error":false,"tool_use_id":"toolu_bash2","type":"tool_result"}],"role":"user"},"parentUuid":"a7","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:12:30.000Z","type":"user","uuid":"u6"}
    {"isSidechain":true,"message":{"content":[{"id":"toolu_side","input":{"file_path":"/Users/fixture/proj/README.md"},"name":"Read","type":"tool_use"}],"id":"msg_s1","role":"assistant","type":"message"},"parentUuid":"s0","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:12:31.000Z","type":"assistant","uuid":"s1"}
    {"isSidechain":true,"message":{"content":[{"content":"# Proj","is_error":false,"tool_use_id":"toolu_side","type":"tool_result"}],"role":"user"},"parentUuid":"s1","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:12:32.000Z","type":"user","uuid":"s2"}
    {"isSidechain":false,"message":{"content":[{"text":"Scrolling works with two fingers and the mouse wheel.","type":"text"}],"id":"msg_06","role":"assistant","stop_reason":"end_turn","type":"message"},"parentUuid":"u6","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:12:41.000Z","type":"assistant","uuid":"a9"}
    {"isSidechain":false,"message":{"content":"Here are the two screenshots /Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png /Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-22222222-2222-2222-2222-222222222222.jpg ","role":"user"},"parentUuid":"a9","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:20:00.000Z","type":"user","uuid":"u7"}
    {"isSidechain":false,"message":{"content":[{"text":"Looking at both.","type":"text"}],"id":"msg_07","role":"assistant","stop_reason":null,"type":"message"},"parentUuid":"u7","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:20:03.000Z","type":"assistant","uuid":"a10"}
    {"isMeta":true,"isSidechain":false,"message":{"content":"<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>","role":"user"},"parentUuid":"a10","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:20:04.000Z","type":"user","uuid":"u8"}
    {"type":"assistant","message":{"content":[
    not json at all
    {"sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","type":"brand-new-record"}
    {"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_grep","input":{"output_mode":"files_with_matches","path":"App/Terminal","pattern":"allowedScrollTypesMask"},"name":"Grep","type":"tool_use"}],"id":"msg_08","role":"assistant","stop_reason":"tool_use","type":"message"},"parentUuid":"a10","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:20:06.000Z","type":"assistant","uuid":"a11"}
    {"isSidechain":false,"message":{"content":[{"content":"Found 4 files\nApp/Terminal/A.swift\nApp/Terminal/B.swift\nApp/Terminal/C.swift\nApp/Terminal/D.swift","is_error":false,"tool_use_id":"toolu_grep","type":"tool_result"}],"role":"user"},"parentUuid":"a11","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:20:07.000Z","type":"user","uuid":"u9"}
    {"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_build","input":{"command":"swift build","description":"Build"},"name":"Bash","type":"tool_use"}],"id":"msg_09","role":"assistant","stop_reason":"tool_use","type":"message"},"parentUuid":"u9","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:20:09.000Z","type":"assistant","uuid":"a12"}
    """#

    static func date(_ iso: String) -> Date { ChatDate.parse(iso)! }

    static func timeline(_ text: String, maxItems: Int = 200) -> (ChatTimeline, TranscriptParseStats) {
        var parser = TranscriptParser(format: .claude)
        var builder = ChatTimelineBuilder(maxItems: maxItems)
        builder.apply(parser.parse(text: text))
        return (builder.timeline, parser.stats)
    }

    /// One user line around `content` (a JSON value), for the small cases.
    static func userLine(_ content: String, uuid: String = "ux", extra: String = "") -> String {
        #"{"isSidechain":false,"message":{"content":"# + content + #","role":"user"},"sessionId":"s","timestamp":"2026-11-01T03:00:00.000Z","type":"user","uuid":""# + uuid + #"""# + extra + "}"
    }

    // MARK: - the whole session

    func testSessionBuildsThreeTurnsWithTitleAndCounts() {
        let (timeline, stats) = Self.timeline(Self.session)
        XCTAssertEqual(timeline.turns.count, 3)
        XCTAssertEqual(timeline.title, "Explain the follower")
        XCTAssertEqual(stats.lines, 32)
        XCTAssertEqual(stats.malformed, 2)
        XCTAssertEqual(stats.unknownTypes, ["brand-new-record": 1])
        XCTAssertEqual(stats.skippedTypes["user/sidechain"], 1)
        XCTAssertEqual(stats.skippedTypes["assistant/sidechain"], 1)
        XCTAssertEqual(stats.skippedTypes["user/meta"], 1)
        XCTAssertEqual(stats.skippedTypes["assistant/thinking"], 1)
        XCTAssertEqual(stats.skippedTypes["attachment"], 1)
        XCTAssertEqual(stats.lines, stats.linesWithEvents + stats.skipped + stats.malformed + stats.unknown)
    }

    func testPlainExchange() {
        let turn = Self.timeline(Self.session).0.turns[0]
        XCTAssertEqual(turn.userMessage?.text, "What does the follower do?")
        XCTAssertEqual(turn.userMessage?.time, Self.date("2026-11-01T02:00:00.000Z"))
        guard case .agentText(let reply) = turn.items[1] else { return XCTFail("\(turn.items)") }
        XCTAssertEqual(reply.markdown, "It keeps the **partial** tail between reads.")
        XCTAssertEqual(turn.items.count, 2, "thinking is not shown")
        XCTAssertTrue(turn.isFinished)
        XCTAssertEqual(turn.footer?.duration, 5)
    }

    func testToolTurnPairsResultsFoldsAndKeepsTheFailedBashOpen() throws {
        let turn = Self.timeline(Self.session).0.turns[1]
        XCTAssertTrue(turn.isFinished)
        XCTAssertEqual(turn.footer?.workedForText, "Worked for 2m 41s")
        let calls = turn.toolCalls
        XCTAssertEqual(calls.map(\.kind), [.read, .edit, .bash, .bash], "the sidechain Read is not here")
        XCTAssertEqual(calls[0].target, "/Users/fixture/proj/App/View.swift")
        XCTAssertEqual(calls[0].resultSummary, "5 lines")
        XCTAssertEqual(calls[1].resultSummary, "+2 \u{2212}1")
        guard case .diff(let diff) = calls[1].detail else { return XCTFail() }
        XCTAssertEqual(diff.lines, [
            ChatDiffLine(.context, "    let pan = UIPanGestureRecognizer()"),
            ChatDiffLine(.removed, "    pan.allowedScrollTypesMask = []"),
            ChatDiffLine(.added, "    pan.allowedScrollTypesMask = .all"),
            ChatDiffLine(.added, "    pan.maximumNumberOfTouches = 2"),
            ChatDiffLine(.context, "}"),
        ])
        XCTAssertEqual(calls[2].state, .failed)
        XCTAssertEqual(calls[2].resultSummary, "exit 1")
        XCTAssertEqual(calls[2].detail, .bash(ChatBashDetail(
            command: "swift test --filter ViewTest",
            outputTail: ["error: no tests matched 'ViewTest'", "Test run failed"], exitCode: 1)))
        XCTAssertEqual(calls[3].state, .ok)
        guard case .bash(let passing) = calls[3].detail else { return XCTFail() }
        XCTAssertEqual(passing.outputTail.last, "Executed 6 tests, with 0 failures (0 unexpected) in 0.208 seconds")

        XCTAssertEqual(turn.foldSummary, "Read 1 file, edited 1 file, ran 1 command")
        let rows = turn.rows
        XCTAssertEqual(rows.map(\.id), ["u2", "turn-2/folded", "toolu_bash1", "a6", "a9"])
    }

    func testMessageWithTwoUploadedPathsAndARunningTurn() throws {
        let timeline = Self.timeline(Self.session).0
        let turn = timeline.turns[2]
        let message = try XCTUnwrap(turn.userMessage)
        XCTAssertEqual(message.text, "Here are the two screenshots")
        XCTAssertEqual(message.attachments.map(\.path), [Self.attachmentA, Self.attachmentB])
        XCTAssertFalse(turn.isFinished)
        XCTAssertEqual(timeline.workingSince, Self.date("2026-11-01T02:20:00.000Z"))
        XCTAssertEqual(turn.rows.count, 4, "a running turn shows every call")
        let calls = turn.toolCalls
        XCTAssertEqual(calls[0].kind, .search)
        XCTAssertEqual(calls[0].target, "allowedScrollTypesMask")
        XCTAssertEqual(calls[0].resultSummary, "4 files")
        XCTAssertEqual(calls[0].detail, .search(ChatSearchDetail(
            pattern: "allowedScrollTypesMask",
            files: ["App/Terminal/A.swift", "App/Terminal/B.swift", "App/Terminal/C.swift", "App/Terminal/D.swift"],
            fileCount: 4)))
        XCTAssertEqual(calls[1].state, .running)
        XCTAssertEqual(calls[1].target, "swift build")
    }

    // MARK: - user lines

    func testImageBlockIsAnAttachmentWithItsMediaTypeAndNoPayload() throws {
        let line = Self.userLine(#"[{"source":{"data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB","media_type":"image/png","type":"base64"},"type":"image"},{"text":"[Image #1] What is wrong here?","type":"text"}]"#)
        let (timeline, _) = Self.timeline(line)
        let message = try XCTUnwrap(timeline.turns.first?.userMessage)
        XCTAssertEqual(message.text, "What is wrong here?")
        XCTAssertEqual(message.attachments, [ChatAttachment(mediaType: "image/png")])
        XCTAssertFalse(String(describing: timeline).contains("iVBORw0KGgo"), "the base64 payload is never kept")
    }

    func testImageSourceMarkerWithoutAnImageBlockKeepsThePath() throws {
        let line = Self.userLine(#"[{"text":"[Image: source: /Users/fixture/Desktop/shot.png]","type":"text"},{"text":"Compare with <pasted_content id=\"1\">old log</pasted_content>","type":"text"}]"#)
        let message = try XCTUnwrap(Self.timeline(line).0.turns.first?.userMessage)
        XCTAssertEqual(message.attachments, [ChatAttachment(path: "/Users/fixture/Desktop/shot.png")])
        // A pasted block shows as its text, no tags.
        XCTAssertEqual(message.text, "Compare with old log")
    }

    func testUserStringsThatAreNotTypingAreSkipped() {
        let strings = [
            #""<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>""#,
            #""<command-message>review</command-message>""#,
            #""<local-command-stdout>Cleared</local-command-stdout>""#,
            #""<local-command-caveat>Caveat: the messages below were generated by local commands.</local-command-caveat>""#,
            #""<system-reminder>Plan mode is on.</system-reminder>""#,
            // A task notification with no task id says nothing.
            #""<task-notification>\n<status>completed</status>\n</task-notification>""#,
        ]
        for content in strings {
            var parser = ClaudeTranscriptParser()
            let result = parser.parse(line: Self.userLine(content))
            XCTAssertEqual(result.events, [], content)
            XCTAssertEqual(result.outcome, .skipped("user/not-typed"), content)
        }
        var parser = ClaudeTranscriptParser()
        let meta = parser.parse(line: Self.userLine(#""Hello""#, extra: #","isMeta":true"#))
        XCTAssertEqual(meta.outcome, .skipped("user/meta"))
        // A task notification with its id is the
        // event that finishes its background agent (it shows nothing).
        var notified = ClaudeTranscriptParser()
        let task = notified.parse(line: Self.userLine(
            #""<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>""#))
        // It also says how the agent ended.
        XCTAssertEqual(task.events, [.taskNotified(id: "b1", failed: false, report: nil, time: ChatDate.parse("2026-11-01T03:00:00.000Z"), status: .done)])
    }

    func testToolResultOnlyLineIsNotAMessage() {
        var parser = ClaudeTranscriptParser()
        let result = parser.parse(line: Self.userLine(#"[{"content":"ok","is_error":false,"tool_use_id":"toolu_1","type":"tool_result"}]"#))
        XCTAssertEqual(result.events.count, 1)
        guard case .toolFinished(let id, let output, _) = result.events[0] else { return XCTFail() }
        XCTAssertEqual(id, "toolu_1")
        XCTAssertEqual(output, ChatToolOutput(text: "ok"))
    }

    func testBangShellCommandIsOneBashRowNotABubble() throws {
        let text = [
            Self.userLine(#""<bash-input>git status --short</bash-input>""#, uuid: "b1"),
            Self.userLine(#""<bash-stdout> M App/View.swift\n?? notes.md</bash-stdout><bash-stderr></bash-stderr>""#, uuid: "b2"),
        ].joined(separator: "\n")
        let (timeline, _) = Self.timeline(text)
        XCTAssertEqual(timeline.turns.count, 1)
        let turn = timeline.turns[0]
        XCTAssertNil(turn.userMessage)
        XCTAssertNil(turn.footer)
        let call = try XCTUnwrap(turn.toolCalls.first)
        XCTAssertTrue(call.isUserShell)
        XCTAssertEqual(call.kind, .bash)
        XCTAssertEqual(call.target, "git status --short")
        XCTAssertEqual(call.state, .ok)
        XCTAssertEqual(call.detail, .bash(ChatBashDetail(
            command: "git status --short", outputTail: [" M App/View.swift", "?? notes.md"])))
        XCTAssertEqual(turn.rows.count, 1, "a ! command is never folded")
    }

    func testCompactionAndInterruptAreQuietNotices() {
        let text = [
            Self.userLine(#""Run the long build""#, uuid: "u1"),
            #"{"isSidechain":false,"message":{"content":[{"id":"toolu_long","input":{"command":"make all"},"name":"Bash","type":"tool_use"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-01T03:00:01.000Z","type":"assistant","uuid":"a1"}"#,
            Self.userLine(#"[{"content":"The user doesn't want to proceed with this tool use.","is_error":true,"tool_use_id":"toolu_long","type":"tool_result"}]"#, uuid: "u2"),
            Self.userLine(#"[{"text":"[Request interrupted by user for tool use]","type":"text"}]"#, uuid: "u3"),
            Self.userLine(#""This session is being continued from a previous conversation that ran out of context. Summary: …""#, uuid: "u4"),
            Self.userLine(#""Carry on""#, uuid: "u5"),
        ].joined(separator: "\n")
        let turns = Self.timeline(text).0.turns
        XCTAssertEqual(turns.count, 3)
        XCTAssertTrue(turns[0].isFinished)
        // A stop knows how long its turn ran ("You stopped after 0s").
        var stop = ChatNotice(id: "u3", kind: .interrupted, time: Self.date("2026-11-01T03:00:00.000Z"))
        stop.ranFor = 0
        XCTAssertEqual(turns[0].items.last, .notice(stop))
        XCTAssertEqual(turns[0].rows.map(\.id), ["u1", "toolu_long", "u3"], "the refused call failed, so it stays open")
        XCTAssertEqual(turns[1].items.map(\.id), ["u4"])
        guard case .notice(let compacted) = turns[1].items[0] else { return XCTFail() }
        XCTAssertEqual(compacted.text, "Conversation compacted")
        XCTAssertEqual(turns[2].userMessage?.text, "Carry on")
    }

    func testCompactSummaryFlagIsANotice() {
        var parser = ClaudeTranscriptParser()
        let result = parser.parse(line: Self.userLine(#""Summary of the earlier work""#, extra: #","isCompactSummary":true"#))
        XCTAssertEqual(result.events, [.notice(ChatNotice(id: "ux", kind: .compacted, time: Self.date("2026-11-01T03:00:00.000Z")), endsTurn: false)])
    }

    // MARK: - tools

    func testEveryToolMapsToItsDisplayKind() {
        func kind(_ name: String, _ input: [String: Any] = [:]) -> ChatToolCall {
            ClaudeTranscriptParser.call(id: "t", name: name, input: input, time: nil)
        }
        XCTAssertEqual(kind("Read", ["file_path": "/a"]).kind, .read)
        XCTAssertEqual(kind("NotebookRead", ["notebook_path": "/n.ipynb"]).target, "/n.ipynb")
        XCTAssertEqual(kind("Write", ["file_path": "/w", "content": "a\nb\n"]).detail,
                       .diff(ChatDiff(files: ["/w"], added: 2, removed: 0,
                                      lines: [ChatDiffLine(.added, "a"), ChatDiffLine(.added, "b")], moreLines: 0)))
        let multi = kind("MultiEdit", ["file_path": "/m", "edits": [["old_string": "a", "new_string": "b"],
                                                                     ["old_string": "c", "new_string": "d\ne"]]])
        guard case .diff(let diff) = multi.detail else { return XCTFail() }
        XCTAssertEqual(diff.countsText, "+3 \u{2212}2")
        XCTAssertEqual(kind("NotebookEdit", ["notebook_path": "/n", "new_source": "x"]).kind, .edit)
        XCTAssertEqual(kind("Bash", ["command": "ls"]).kind, .bash)
        XCTAssertEqual(kind("Monitor", ["command": "tail -f log"]).target, "tail -f log")
        XCTAssertEqual(kind("Grep", ["pattern": "foo"]).kind, .search)
        XCTAssertEqual(kind("Glob", ["pattern": "**/*.swift"]).target, "**/*.swift")
        XCTAssertEqual(kind("WebFetch", ["url": "https://example.com"]).target, "https://example.com")
        XCTAssertEqual(kind("WebSearch", ["query": "swift nio"]).kind, .web)
        XCTAssertEqual(kind("Task", ["description": "Explore", "prompt": "Look around"]).target, "Explore")
        XCTAssertEqual(kind("Agent", ["description": "Review", "prompt": "p", "subagent_type": "general"]).kind, .agent)
        XCTAssertEqual(kind("ToolSearch", ["query": "select:Read"]).kind, .other("ToolSearch"))
        XCTAssertEqual(kind("ToolSearch", ["query": "select:Read"]).target, "select:Read")
        XCTAssertEqual(kind("mcp__xcode__BuildProject").kind, .other("BuildProject"))
    }

    func testTodoWriteIsOnePlanRowUpdatedInPlace() {
        func todo(_ uuid: String, _ id: String, _ statuses: [String]) -> String {
            let todos = statuses.enumerated().map { index, status in
                #"{"activeForm":"Doing step \#(index)","content":"Step \#(index)","status":"\#(status)"}"#
            }.joined(separator: ",")
            return #"{"isSidechain":false,"message":{"content":[{"id":"\#(id)","input":{"todos":[\#(todos)]},"name":"TodoWrite","type":"tool_use"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-01T03:00:01.000Z","type":"assistant","uuid":"\#(uuid)"}"#
        }
        let text = [
            Self.userLine(#""Plan it""#, uuid: "u1"),
            todo("a1", "toolu_p1", ["in_progress", "pending", "pending"]),
            Self.userLine(#"[{"content":"Todos have been modified","tool_use_id":"toolu_p1","type":"tool_result"}]"#, uuid: "u2"),
            todo("a2", "toolu_p2", ["completed", "in_progress", "pending"]),
        ].joined(separator: "\n")
        let calls = Self.timeline(text).0.turns[0].toolCalls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].kind, .plan)
        XCTAssertEqual(calls[0].target, "Doing step 1")
        XCTAssertEqual(calls[0].resultSummary, "1 of 3 done")
        XCTAssertEqual(calls[0].detail, .plan([
            ChatPlanStep(text: "Step 0", status: .completed),
            ChatPlanStep(text: "Step 1", status: .inProgress),
            ChatPlanStep(text: "Step 2", status: .pending),
        ]))
    }

    func testSubagentCallsInTheMainThreadAreAgentRows() {
        let line = #"{"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_agent","input":{"description":"Survey the transport","model":"sonnet","prompt":"Read CitadelTransport.swift","subagent_type":"Explore"},"name":"Agent","type":"tool_use"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-01T03:00:01.000Z","type":"assistant","uuid":"a1"}"#
        // The call is a subagent in its turn's
        // subagents row (ChatTimelineSubagentTests), not a tool row.
        let turn = Self.timeline(line).0.turns[0]
        XCTAssertTrue(turn.toolCalls.isEmpty)
        guard case .agents(let group)? = turn.items.first else { return XCTFail("no subagents row") }
        XCTAssertEqual(group.agents.first?.description, "Survey the transport")
        XCTAssertEqual(group.agents.first?.type, "Explore")
        XCTAssertEqual(group.agents.first?.prompt, "Read CitadelTransport.swift")
        XCTAssertEqual(group.agents.first?.background, false)
    }

    // MARK: - custom-title, agent-name, cost-state (seen in real 2.1.316 files)

    static let aiTitleLine = #"{"aiTitle":"Explain the follower","sessionId":"s","type":"ai-title"}"#
    static func customTitleLine(_ name: String) -> String {
        #"{"customTitle":""# + name + #"","sessionId":"s","type":"custom-title"}"#
    }

    func testCustomTitleAfterAnAITitleWins() {
        let text = [Self.aiTitleLine, Self.userLine(#""hi""#), Self.customTitleLine("aurora-web-mac")].joined(separator: "\n")
        let (timeline, stats) = Self.timeline(text)
        XCTAssertEqual(timeline.title, "aurora-web-mac")
        XCTAssertEqual(stats.unknown, 0)
        XCTAssertEqual(stats.linesWithEvents, 3)
    }

    func testCustomTitleBeforeAnAITitleStillWinsAndALaterOneReplacesIt() {
        let first = [Self.customTitleLine("first-name"), Self.aiTitleLine].joined(separator: "\n")
        XCTAssertEqual(Self.timeline(first).0.title, "first-name", "the name given wins over a later AI title")
        let renamed = [first, Self.customTitleLine("second-name"), Self.aiTitleLine].joined(separator: "\n")
        XCTAssertEqual(Self.timeline(renamed).0.title, "second-name", "a later custom-title replaces an earlier one")
        XCTAssertEqual(Self.timeline(Self.aiTitleLine).0.title, "Explain the follower", "the AI title when no name is given")
        let blank = [Self.aiTitleLine, Self.customTitleLine("  ")].joined(separator: "\n")
        let (blankTimeline, blankStats) = Self.timeline(blank)
        XCTAssertEqual(blankTimeline.title, "Explain the follower", "an empty name is no name")
        XCTAssertEqual(blankStats.skippedTypes, ["custom-title": 1])
    }

    func testAgentNameAndCostStateAreSkippedBookkeepingNotUnknown() {
        let text = [
            #"{"agentName":"aurora-web-chat-core","sessionId":"s","type":"agent-name"}"#,
            #"{"sessionId":"s","totalCostUSD":1.25,"totalDurationMs":81234,"type":"cost-state"}"#,
            Self.customTitleLine("aurora-web-mac"),
            #"{"agentName":"aurora-web-chat-core","sessionId":"s","type":"agent-name"}"#,
        ].joined(separator: "\n")
        let (timeline, stats) = Self.timeline(text)
        XCTAssertEqual(stats.lines, 4)
        XCTAssertEqual(stats.skipped, 3)
        XCTAssertEqual(stats.skippedTypes, ["agent-name": 2, "cost-state": 1])
        XCTAssertEqual(stats.unknown, 0)
        XCTAssertEqual(stats.unknownTypes, [:])
        XCTAssertEqual(stats.malformed, 0)
        XCTAssertEqual(stats.linesWithEvents, 1, "custom-title is known and carries the title")
        XCTAssertEqual(timeline.title, "aurora-web-mac")
        XCTAssertTrue(timeline.turns.isEmpty)
    }

    func testCwdComesFromTheFirstUserOrAssistantLineThatHasOne() {
        var parser = TranscriptParser(format: .claude)
        _ = parser.parse(line: #"{"content":"x","cwd":"/from/system","type":"system"}"#)
        XCTAssertNil(parser.cwd, "a system line does not count")
        _ = parser.parse(line: Self.userLine(#""no folder""#))
        XCTAssertNil(parser.cwd)
        _ = parser.parse(line: #"{"cwd":"/Users/fixture/proj","isSidechain":false,"message":{"content":[{"text":"hi","type":"text"}],"role":"assistant"},"type":"assistant","uuid":"a1"}"#)
        _ = parser.parse(line: #"{"cwd":"/Users/fixture/other","isSidechain":false,"message":{"content":"later","role":"user"},"type":"user","uuid":"u2"}"#)
        XCTAssertEqual(parser.cwd, "/Users/fixture/proj", "the first one stays")
        var whole = TranscriptParser(format: .claude)
        _ = whole.parse(text: Self.session)
        XCTAssertEqual(whole.cwd, "/Users/fixture/proj")
    }

    // MARK: - typed prose and garbage

    private static func jsonString(_ text: String) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed]), as: UTF8.self)
    }

    /// A bash tag anywhere in typed prose must not turn the whole
    /// message into a `!` shell row.
    func testABashTagInsideTypedProseStaysTypedText() throws {
        let typed = [
            "Please explain <bash-input>echo hello</bash-input> in this log.",
            "<bash-input>ls</bash-input> and then explain the output",
            "Hi\n<bash-input>ls</bash-input>",
            "<bash-input>ls</bash-input><bash-input>pwd</bash-input>",
            "<bash-input>unclosed ls",
            "<bash-stdout>x</bash-stdout> what does this mean?",
        ]
        for text in typed {
            let timeline = Self.timeline(Self.userLine(try Self.jsonString(text))).0
            XCTAssertEqual(timeline.turns.first?.userMessage?.text, text, text)
            XCTAssertTrue(timeline.turns.first?.toolCalls.isEmpty ?? false, text)
        }
        // The generated forms still make one Bash row: input alone (output on the next line, as in
        // testBangShellCommandIsOneBashRowNotABubble), and input with its output in one block.
        let joined = "  <bash-input>pwd</bash-input>\n<bash-stdout>/Users/fixture/proj</bash-stdout><bash-stderr></bash-stderr>\n"
        let turn = try XCTUnwrap(Self.timeline(Self.userLine(try Self.jsonString(joined))).0.turns.first)
        XCTAssertNil(turn.userMessage)
        let call = try XCTUnwrap(turn.toolCalls.first)
        XCTAssertTrue(call.isUserShell)
        XCTAssertEqual(call.target, "pwd")
        XCTAssertEqual(call.state, .ok)
        XCTAssertEqual(call.detail, .bash(ChatBashDetail(command: "pwd", outputTail: ["/Users/fixture/proj"])))
    }

    func testNothingThrowsOnGarbage() {
        var parser = TranscriptParser(format: .claude)
        let garbage = ["", "{", "[]", "42", "null", #"{"type":7}"#, #"{"type":"user"}"#, #"{"type":"user","message":"x"}"#,
                       #"{"type":"assistant","message":{"content":[1,2,{"type":"tool_use"}]}}"#,
                       #"{"type":"user","message":{"content":[{"type":"tool_result"}]}}"#, "\u{FFFD}\u{0}"]
        for line in garbage { _ = parser.parse(line: line) }
        XCTAssertEqual(parser.stats.lines, garbage.count)
        XCTAssertEqual(parser.stats.malformed, 6)
    }
}
