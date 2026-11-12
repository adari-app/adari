// A port of HerdrKit's ClaudeTranscriptParserTests.swift: Claude Code
// transcripts, fixtures hand-built from the claude-code-2.1.316 shape (real
// structure, invented content), the same expectations.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ClaudeTranscriptParser, claudeToolCall } from "../src/shared/chat/claude-parser";
import {
  attachment,
  diffCountsText,
  diffLine,
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
import { parseChatDate, type JSONObject } from "../src/shared/chat/tools";

const attachmentA =
  "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png";
const attachmentB =
  "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-22222222-2222-2222-2222-222222222222.jpg";

/**
 * Three turns: a plain exchange; Read + Edit + a failed Bash + a passing Bash
 * with an interleaved subagent (sidechain) pair; then a message with two
 * uploaded paths, a meta line, two malformed lines, an unknown type, a Grep and
 * a Bash still running.
 */
const session = String.raw`{"permissionMode":"auto","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","type":"permission-mode"}
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
{"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_build","input":{"command":"swift build","description":"Build"},"name":"Bash","type":"tool_use"}],"id":"msg_09","role":"assistant","stop_reason":"tool_use","type":"message"},"parentUuid":"u9","sessionId":"5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f","timestamp":"2026-11-01T02:20:09.000Z","type":"assistant","uuid":"a12"}`;

const date = (iso: string): number => parseChatDate(iso)!;

function timelineOf(text: string, maxItems = 200): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("claude");
  const builder = new ChatTimelineBuilder(maxItems);
  builder.apply(parser.parseText(text));
  return { timeline: builder.timeline, stats: parser.stats };
}

/** One user line around `content` (a JSON value), for the small cases. */
function userLine(content: string, uuid = "ux", extra = ""): string {
  return `{"isSidechain":false,"message":{"content":${content},"role":"user"},"sessionId":"s","timestamp":"2026-11-01T03:00:00.000Z","type":"user","uuid":"${uuid}"${extra}}`;
}

const mapOf = (map: ReadonlyMap<string, number>): Record<string, number> => Object.fromEntries(map);

describe("the whole session", () => {
  it("builds three turns with a title and counts", () => {
    const { timeline, stats } = timelineOf(session);
    expect(timeline.turns.length).toBe(3);
    expect(timeline.title).toBe("Explain the follower");
    expect(stats.lines).toBe(32);
    expect(stats.malformed).toBe(2);
    expect(mapOf(stats.unknownTypes)).toEqual({ "brand-new-record": 1 });
    expect(stats.skippedTypes.get("user/sidechain")).toBe(1);
    expect(stats.skippedTypes.get("assistant/sidechain")).toBe(1);
    expect(stats.skippedTypes.get("user/meta")).toBe(1);
    expect(stats.skippedTypes.get("assistant/thinking")).toBe(1);
    expect(stats.skippedTypes.get("attachment")).toBe(1);
    expect(stats.lines).toBe(stats.linesWithEvents + stats.skipped + stats.malformed + stats.unknown);
  });

  it("shows a plain exchange", () => {
    const turn = timelineOf(session).timeline.turns[0]!;
    expect(turnUserMessage(turn)?.text).toBe("What does the follower do?");
    expect(turnUserMessage(turn)?.time).toBe(date("2026-11-01T02:00:00.000Z"));
    const reply = turn.items[1]!;
    expect(reply.type).toBe("agentText");
    if (reply.type === "agentText") expect(reply.value.markdown).toBe("It keeps the **partial** tail between reads.");
    expect(turn.items.length).toBe(2); // thinking is not shown
    expect(turn.isFinished).toBe(true);
    expect(turnFooter(turn)?.duration).toBe(5);
  });

  it("pairs results, folds, and keeps the failed Bash open", () => {
    const turn = timelineOf(session).timeline.turns[1]!;
    expect(turn.isFinished).toBe(true);
    expect(workedForText(turnFooter(turn)!)).toBe("Worked for 2m 41s");
    const calls = turnToolCalls(turn);
    expect(calls.map((call) => call.kind)).toEqual(["read", "edit", "bash", "bash"]); // the sidechain Read is not here
    expect(calls[0]!.target).toBe("/Users/fixture/proj/App/View.swift");
    expect(calls[0]!.resultSummary).toBe("5 lines");
    expect(calls[1]!.resultSummary).toBe("+2 −1");
    const detail = calls[1]!.detail;
    expect(detail.type).toBe("diff");
    if (detail.type === "diff") {
      expect(detail.diff.lines).toEqual([
        diffLine("context", "    let pan = UIPanGestureRecognizer()"),
        diffLine("removed", "    pan.allowedScrollTypesMask = []"),
        diffLine("added", "    pan.allowedScrollTypesMask = .all"),
        diffLine("added", "    pan.maximumNumberOfTouches = 2"),
        diffLine("context", "}"),
      ]);
    }
    expect(calls[2]!.state).toBe("failed");
    expect(calls[2]!.resultSummary).toBe("exit 1");
    expect(calls[2]!.detail).toEqual({
      type: "bash",
      bash: { command: "swift test --filter ViewTest", outputTail: ["error: no tests matched 'ViewTest'", "Test run failed"], exitCode: 1 },
    });
    expect(calls[3]!.state).toBe("ok");
    const passing = calls[3]!.detail;
    expect(passing.type === "bash" ? passing.bash.outputTail.at(-1) : null).toBe("Executed 6 tests, with 0 failures (0 unexpected) in 0.208 seconds");

    expect(turnFoldSummary(turn)).toBe("Read 1 file, edited 1 file, ran 1 command");
    expect(turnRows(turn).map(rowID)).toEqual(["u2", "turn-2/folded", "toolu_bash1", "a6", "a9"]);
  });

  it("shows a message with two uploaded paths and a running turn", () => {
    const { timeline } = timelineOf(session);
    const turn = timeline.turns[2]!;
    const message = turnUserMessage(turn)!;
    expect(message.text).toBe("Here are the two screenshots");
    expect(message.attachments.map((value) => value.path)).toEqual([attachmentA, attachmentB]);
    expect(turn.isFinished).toBe(false);
    expect(workingSince(timeline)).toBe(date("2026-11-01T02:20:00.000Z"));
    expect(turnRows(turn).length).toBe(4); // a running turn shows every call
    const calls = turnToolCalls(turn);
    expect(calls[0]!.kind).toBe("search");
    expect(calls[0]!.target).toBe("allowedScrollTypesMask");
    expect(calls[0]!.resultSummary).toBe("4 files");
    expect(calls[0]!.detail).toEqual({
      type: "search",
      search: {
        pattern: "allowedScrollTypesMask",
        files: ["App/Terminal/A.swift", "App/Terminal/B.swift", "App/Terminal/C.swift", "App/Terminal/D.swift"],
        fileCount: 4,
      },
    });
    expect(calls[1]!.state).toBe("running");
    expect(calls[1]!.target).toBe("swift build");
  });
});

describe("user lines", () => {
  it("keeps an image block as an attachment with its media type and no payload", () => {
    const line = userLine(
      String.raw`[{"source":{"data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB","media_type":"image/png","type":"base64"},"type":"image"},{"text":"[Image #1] What is wrong here?","type":"text"}]`,
    );
    const { timeline } = timelineOf(line);
    const message = turnUserMessage(timeline.turns[0]!)!;
    expect(message.text).toBe("What is wrong here?");
    expect(message.attachments).toEqual([attachment(null, "image/png")]);
    expect(JSON.stringify(timeline)).not.toContain("iVBORw0KGgo"); // the base64 payload is never kept
  });

  it("keeps the path of an image source marker without an image block", () => {
    const line = userLine(
      String.raw`[{"text":"[Image: source: /Users/fixture/Desktop/shot.png]","type":"text"},{"text":"Compare with <pasted_content id=\"1\">old log</pasted_content>","type":"text"}]`,
    );
    const message = turnUserMessage(timelineOf(line).timeline.turns[0]!)!;
    expect(message.attachments).toEqual([attachment("/Users/fixture/Desktop/shot.png")]);
    // A pasted block shows as its text, no tags.
    expect(message.text).toBe("Compare with old log");
  });

  it("skips user strings that are not typing", () => {
    const strings = [
      String.raw`"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"`,
      String.raw`"<command-message>review</command-message>"`,
      String.raw`"<local-command-stdout>Cleared</local-command-stdout>"`,
      String.raw`"<local-command-caveat>Caveat: the messages below were generated by local commands.</local-command-caveat>"`,
      String.raw`"<system-reminder>Plan mode is on.</system-reminder>"`,
      // A task notification with no task id says nothing.
      String.raw`"<task-notification>\n<status>completed</status>\n</task-notification>"`,
    ];
    for (const content of strings) {
      const result = new ClaudeTranscriptParser().parse(userLine(content));
      expect(result.events, content).toEqual([]);
      expect(result.outcome, content).toEqual({ kind: "skipped", type: "user/not-typed" });
    }
    const meta = new ClaudeTranscriptParser().parse(userLine(`"Hello"`, "ux", `,"isMeta":true`));
    expect(meta.outcome).toEqual({ kind: "skipped", type: "user/meta" });
    // A task notification with its id is the event that finishes its background agent (it shows nothing).
    const task = new ClaudeTranscriptParser().parse(userLine(String.raw`"<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"`));
    // It also says how it ended (no tool-use id, event or exit code here).
    expect(task.events).toEqual([
      { type: "taskNotified", id: "b1", failed: false, report: null, time: parseChatDate("2026-11-01T03:00:00.000Z"), toolUseID: null, status: "done", event: null, exitCode: null },
    ]);
  });

  it("does not make a message of a tool-result-only line", () => {
    const result = new ClaudeTranscriptParser().parse(userLine(`[{"content":"ok","is_error":false,"tool_use_id":"toolu_1","type":"tool_result"}]`));
    expect(result.events.length).toBe(1);
    const event = result.events[0]!;
    expect(event.type).toBe("toolFinished");
    if (event.type === "toolFinished") {
      expect(event.id).toBe("toolu_1");
      expect(event.output).toEqual(toolOutput("ok"));
    }
  });

  it("makes a ! shell command one Bash row, not a bubble", () => {
    const text = [
      userLine(`"<bash-input>git status --short</bash-input>"`, "b1"),
      userLine(String.raw`"<bash-stdout> M App/View.swift\n?? notes.md</bash-stdout><bash-stderr></bash-stderr>"`, "b2"),
    ].join("\n");
    const { timeline } = timelineOf(text);
    expect(timeline.turns.length).toBe(1);
    const turn = timeline.turns[0]!;
    expect(turnUserMessage(turn)).toBeNull();
    expect(turnFooter(turn)).toBeNull();
    const call = turnToolCalls(turn)[0]!;
    expect(call.isUserShell).toBe(true);
    expect(call.kind).toBe("bash");
    expect(call.target).toBe("git status --short");
    expect(call.state).toBe("ok");
    expect(call.detail).toEqual({ type: "bash", bash: { command: "git status --short", outputTail: [" M App/View.swift", "?? notes.md"], exitCode: null } });
    expect(turnRows(turn).length).toBe(1); // a ! command is never folded
  });

  it("shows compaction and an interrupt as quiet notices", () => {
    const text = [
      userLine(`"Run the long build"`, "u1"),
      `{"isSidechain":false,"message":{"content":[{"id":"toolu_long","input":{"command":"make all"},"name":"Bash","type":"tool_use"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-01T03:00:01.000Z","type":"assistant","uuid":"a1"}`,
      userLine(`[{"content":"The user doesn't want to proceed with this tool use.","is_error":true,"tool_use_id":"toolu_long","type":"tool_result"}]`, "u2"),
      userLine(`[{"text":"[Request interrupted by user for tool use]","type":"text"}]`, "u3"),
      userLine(`"This session is being continued from a previous conversation that ran out of context. Summary: …"`, "u4"),
      userLine(`"Carry on"`, "u5"),
    ].join("\n");
    const { turns } = timelineOf(text).timeline;
    expect(turns.length).toBe(3);
    expect(turns[0]!.isFinished).toBe(true);
    expect(turns[0]!.items.at(-1)).toEqual({ type: "notice", value: { id: "u3", kind: "interrupted", time: date("2026-11-01T03:00:00.000Z") } });
    expect(turnRows(turns[0]!).map(rowID)).toEqual(["u1", "toolu_long", "u3"]); // the refused call failed, so it stays open
    expect(turns[1]!.items.map((item) => item.value.id)).toEqual(["u4"]);
    expect(turns[1]!.items[0]).toMatchObject({ type: "notice", value: { kind: "compacted" } });
    expect(turnUserMessage(turns[2]!)?.text).toBe("Carry on");
  });

  it("makes the compact summary flag a notice", () => {
    const result = new ClaudeTranscriptParser().parse(userLine(`"Summary of the earlier work"`, "ux", `,"isCompactSummary":true`));
    expect(result.events).toEqual([{ type: "notice", notice: { id: "ux", kind: "compacted", time: date("2026-11-01T03:00:00.000Z") }, endsTurn: false }]);
  });
});

describe("tools", () => {
  const kind = (name: string, input: JSONObject = {}): ChatToolCall => claudeToolCall("t", name, input, null);

  it("maps every tool to its display kind", () => {
    expect(kind("Read", { file_path: "/a" }).kind).toBe("read");
    expect(kind("NotebookRead", { notebook_path: "/n.ipynb" }).target).toBe("/n.ipynb");
    expect(kind("Write", { file_path: "/w", content: "a\nb\n" }).detail).toEqual({
      type: "diff",
      diff: { files: ["/w"], added: 2, removed: 0, lines: [diffLine("added", "a"), diffLine("added", "b")], moreLines: 0 },
    });
    const multi = kind("MultiEdit", {
      file_path: "/m",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d\ne" },
      ],
    });
    expect(multi.detail.type === "diff" ? diffCountsText(multi.detail.diff) : null).toBe("+3 −2");
    expect(kind("NotebookEdit", { notebook_path: "/n", new_source: "x" }).kind).toBe("edit");
    expect(kind("Bash", { command: "ls" }).kind).toBe("bash");
    expect(kind("Monitor", { command: "tail -f log" }).target).toBe("tail -f log");
    expect(kind("Grep", { pattern: "foo" }).kind).toBe("search");
    expect(kind("Glob", { pattern: "**/*.swift" }).target).toBe("**/*.swift");
    expect(kind("WebFetch", { url: "https://example.com" }).target).toBe("https://example.com");
    expect(kind("WebSearch", { query: "swift nio" }).kind).toBe("web");
    expect(kind("Task", { description: "Explore", prompt: "Look around" }).target).toBe("Explore");
    expect(kind("Agent", { description: "Review", prompt: "p", subagent_type: "general" }).kind).toBe("agent");
    expect(kind("ToolSearch", { query: "select:Read" }).kind).toEqual({ other: "ToolSearch" });
    expect(kind("ToolSearch", { query: "select:Read" }).target).toBe("select:Read");
    expect(kind("mcp__xcode__BuildProject").kind).toEqual({ other: "BuildProject" });
  });

  it("makes TodoWrite one Plan row updated in place", () => {
    const todo = (uuid: string, id: string, statuses: string[]): string => {
      const todos = statuses.map((status, index) => `{"activeForm":"Doing step ${index}","content":"Step ${index}","status":"${status}"}`).join(",");
      return `{"isSidechain":false,"message":{"content":[{"id":"${id}","input":{"todos":[${todos}]},"name":"TodoWrite","type":"tool_use"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-01T03:00:01.000Z","type":"assistant","uuid":"${uuid}"}`;
    };
    const text = [
      userLine(`"Plan it"`, "u1"),
      todo("a1", "toolu_p1", ["in_progress", "pending", "pending"]),
      userLine(`[{"content":"Todos have been modified","tool_use_id":"toolu_p1","type":"tool_result"}]`, "u2"),
      todo("a2", "toolu_p2", ["completed", "in_progress", "pending"]),
    ].join("\n");
    const calls = turnToolCalls(timelineOf(text).timeline.turns[0]!);
    expect(calls.length).toBe(1);
    expect(calls[0]!.kind).toBe("plan");
    expect(calls[0]!.target).toBe("Doing step 1");
    expect(calls[0]!.resultSummary).toBe("1 of 3 done");
    expect(calls[0]!.detail).toEqual({
      type: "plan",
      steps: [
        { text: "Step 0", status: "completed" },
        { text: "Step 1", status: "inProgress" },
        { text: "Step 2", status: "pending" },
      ],
    });
  });

  it("shows subagent calls in the main thread as Agent rows", () => {
    const line = `{"isSidechain":false,"message":{"content":[{"caller":{"type":"direct"},"id":"toolu_agent","input":{"description":"Survey the transport","model":"sonnet","prompt":"Read CitadelTransport.swift","subagent_type":"Explore"},"name":"Agent","type":"tool_use"}],"role":"assistant"},"sessionId":"s","timestamp":"2026-11-01T03:00:01.000Z","type":"assistant","uuid":"a1"}`;
    // The call is a subagent in its turn's subagents row (chat-subagents.test.ts), not a tool row.
    const turn = timelineOf(line).timeline.turns[0]!;
    expect(turnToolCalls(turn)).toEqual([]);
    const first = turn.items[0];
    expect(first?.type).toBe("agents");
    if (first?.type !== "agents") return;
    expect(first.value.agents.map((agent) => [agent.description, agent.type, agent.prompt, agent.background])).toEqual([
      ["Survey the transport", "Explore", "Read CitadelTransport.swift", false],
    ]);
  });
});

describe("custom-title, agent-name, cost-state", () => {
  const aiTitleLine = `{"aiTitle":"Explain the follower","sessionId":"s","type":"ai-title"}`;
  const customTitleLine = (name: string): string => `{"customTitle":"${name}","sessionId":"s","type":"custom-title"}`;

  it("lets a custom title after an AI title win", () => {
    const { timeline, stats } = timelineOf([aiTitleLine, userLine(`"hi"`), customTitleLine("aurora-web-mac")].join("\n"));
    expect(timeline.title).toBe("aurora-web-mac");
    expect(stats.unknown).toBe(0);
    expect(stats.linesWithEvents).toBe(3);
  });

  it("lets a custom title before an AI title still win, and a later one replace it", () => {
    const first = [customTitleLine("first-name"), aiTitleLine].join("\n");
    expect(timelineOf(first).timeline.title).toBe("first-name");
    const renamed = [first, customTitleLine("second-name"), aiTitleLine].join("\n");
    expect(timelineOf(renamed).timeline.title).toBe("second-name");
    expect(timelineOf(aiTitleLine).timeline.title).toBe("Explain the follower");
    const { timeline, stats } = timelineOf([aiTitleLine, customTitleLine("  ")].join("\n"));
    expect(timeline.title).toBe("Explain the follower"); // an empty name is no name
    expect(mapOf(stats.skippedTypes)).toEqual({ "custom-title": 1 });
  });

  it("skips agent-name and cost-state as bookkeeping, not unknown", () => {
    const text = [
      `{"agentName":"aurora-web-chat-core","sessionId":"s","type":"agent-name"}`,
      `{"sessionId":"s","totalCostUSD":1.25,"totalDurationMs":81234,"type":"cost-state"}`,
      customTitleLine("aurora-web-mac"),
      `{"agentName":"aurora-web-chat-core","sessionId":"s","type":"agent-name"}`,
    ].join("\n");
    const { timeline, stats } = timelineOf(text);
    expect(stats.lines).toBe(4);
    expect(stats.skipped).toBe(3);
    expect(mapOf(stats.skippedTypes)).toEqual({ "agent-name": 2, "cost-state": 1 });
    expect(stats.unknown).toBe(0);
    expect(mapOf(stats.unknownTypes)).toEqual({});
    expect(stats.malformed).toBe(0);
    expect(stats.linesWithEvents).toBe(1); // custom-title is known and carries the title
    expect(timeline.title).toBe("aurora-web-mac");
    expect(timeline.turns).toEqual([]);
  });

  it("takes cwd from the first user or assistant line that has one", () => {
    const parser = new TranscriptParser("claude");
    parser.parse(`{"content":"x","cwd":"/from/system","type":"system"}`);
    expect(parser.cwd).toBeNull(); // a system line does not count
    parser.parse(userLine(`"no folder"`));
    expect(parser.cwd).toBeNull();
    parser.parse(`{"cwd":"/Users/fixture/proj","isSidechain":false,"message":{"content":[{"text":"hi","type":"text"}],"role":"assistant"},"type":"assistant","uuid":"a1"}`);
    parser.parse(`{"cwd":"/Users/fixture/other","isSidechain":false,"message":{"content":"later","role":"user"},"type":"user","uuid":"u2"}`);
    expect(parser.cwd).toBe("/Users/fixture/proj"); // the first one stays
    const whole = new TranscriptParser("claude");
    whole.parseText(session);
    expect(whole.cwd).toBe("/Users/fixture/proj");
  });
});

describe("typed bash tags and malformed lines", () => {
  it("keeps a bash tag inside typed prose as typed text", () => {
    const typed = [
      "Please explain <bash-input>echo hello</bash-input> in this log.",
      "<bash-input>ls</bash-input> and then explain the output",
      "Hi\n<bash-input>ls</bash-input>",
      "<bash-input>ls</bash-input><bash-input>pwd</bash-input>",
      "<bash-input>unclosed ls",
      "<bash-stdout>x</bash-stdout> what does this mean?",
    ];
    for (const text of typed) {
      const { timeline } = timelineOf(userLine(JSON.stringify(text)));
      expect(turnUserMessage(timeline.turns[0]!)?.text, text).toBe(text);
      expect(turnToolCalls(timeline.turns[0]!), text).toEqual([]);
    }
    // The generated forms still make one Bash row: input with its output in one block.
    const joined = "  <bash-input>pwd</bash-input>\n<bash-stdout>/Users/fixture/proj</bash-stdout><bash-stderr></bash-stderr>\n";
    const turn = timelineOf(userLine(JSON.stringify(joined))).timeline.turns[0]!;
    expect(turnUserMessage(turn)).toBeNull();
    const call = turnToolCalls(turn)[0]!;
    expect(call.isUserShell).toBe(true);
    expect(call.target).toBe("pwd");
    expect(call.state).toBe("ok");
    expect(call.detail).toEqual({ type: "bash", bash: { command: "pwd", outputTail: ["/Users/fixture/proj"], exitCode: null } });
  });

  it("throws on no garbage", () => {
    const parser = new TranscriptParser("claude");
    const garbage = [
      "",
      "{",
      "[]",
      "42",
      "null",
      `{"type":7}`,
      `{"type":"user"}`,
      `{"type":"user","message":"x"}`,
      `{"type":"assistant","message":{"content":[1,2,{"type":"tool_use"}]}}`,
      `{"type":"user","message":{"content":[{"type":"tool_result"}]}}`,
      "�\u0000",
    ];
    for (const line of garbage) parser.parse(line);
    expect(parser.stats.lines).toBe(garbage.length);
    expect(parser.stats.malformed).toBe(6);
  });
});

describe("progress updates", () => {
  it("shows a thinking block on a line marked thinkingDisplay updates as a progress event", () => {
    const line = `{"type":"assistant","uuid":"u1","thinkingDisplay":"updates","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"I'm investigating.","signature":"s"}]}}`;
    const result = new ClaudeTranscriptParser().parse(line);
    expect(result.outcome).toEqual({ kind: "events" });
    expect(result.events).toEqual([{ type: "agentProgress", text: { id: "u1", markdown: "I'm investigating.", time: null } }]);
  });

  it("keeps an empty thinking block (a signature only) hidden", () => {
    const line = `{"type":"assistant","uuid":"u1","thinkingDisplay":"updates","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"s"}]}}`;
    const result = new ClaudeTranscriptParser().parse(line);
    expect(result.events).toEqual([]);
    expect(result.outcome).toEqual({ kind: "skipped", type: "assistant/thinking" });
  });
});
