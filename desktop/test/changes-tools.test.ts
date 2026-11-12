// What an agent changed through its own tool calls (HerdrKit AgentChangesTests
// and AgentChangesChatLiveSeamTests), per turn and in the
// session, from fixtures in the transcripts' shapes. The chat's own parser and
// timeline builder read them, so the calls, their states and their diffs are
// the chat's; the chat keeps showing 6 lines a call while Changes gets every
// line to its bound (and the chat's window is sent none of that copy). The
// transcript's end is read backwards to its bound, the way the away digest
// reads it.

import { describe, expect, it } from "vitest";

import { claudeToolCall } from "../src/shared/chat/claude-parser";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import {
  diffAllLines,
  diffAllMoreLines,
  diffLine,
  fullDiffLineCount,
  keptDiffLineCount,
  turnToolCalls,
  withoutFullDiffs,
  type ChatDiff,
  type ChatToolCall,
} from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptFormat } from "../src/shared/chat/parser";
import { ChatDiffMaker } from "../src/shared/chat/tools";
import { ChangesCancelled } from "../src/shared/changes/reader";
import {
  displayPath,
  editCount,
  emptyToolChanges,
  fileChanges,
  readTranscriptEnd,
  resolvePath,
  toolChanges,
  toolChangesFromLines,
  transcriptFolder,
  type AgentToolChanges,
} from "../src/shared/changes/tools";
import * as Line from "./support/chat-lines";
import { FakeTranscriptReader } from "./support/chat-lines";
import { claudeEdits, claudeResult, claudeText, claudeTool, claudeUser, codex, date, fixtureFolder as folder, lines } from "./support/changes-lines";

function changes(texts: readonly string[], options: { format?: TranscriptFormat; folder?: string | null; reachedStart?: boolean } = {}): AgentToolChanges {
  return toolChangesFromLines(lines(texts), options.format ?? "claude", options.folder === undefined ? folder : options.folder, options.reachedStart ?? true);
}

function diffOf(call: ChatToolCall): ChatDiff {
  if (call.detail.type !== "diff") throw new Error("no diff");
  return call.detail.diff;
}

describe("an agent's own changes", () => {
  it("reads Claude's edits by turn and session, newest first, without failed or waiting calls", () => {
    const read = changes(claudeEdits);
    expect(read.turnCount).toBe(2);
    expect(read.fromSessionStart).toBe(true);
    expect(read.thisTurnRunning, "the Edit of d.swift still waits").toBe(true);
    expect(read.firstTurnAt).toBe(date("2026-11-02T01:00:00.000Z"));
    expect(read.thisTurn.map((f) => f.path)).toEqual([folder + "/n.ipynb", folder + "/a.swift"]);
    expect(read.session.map((f) => f.path)).toEqual([folder + "/n.ipynb", folder + "/a.swift", folder + "/b.swift"]);
    expect(read.session.some((f) => f.path.endsWith("c.swift")), "the failed Edit changed nothing").toBe(false);
    expect(read.session.some((f) => f.path.endsWith("d.swift")), "the waiting Edit changed nothing yet").toBe(false);

    const a = read.session[1]!;
    expect(a.edits.map((e) => e.tool)).toEqual(["Edit", "MultiEdit", "Edit"]);
    expect(a.edits.map((e) => e.turnNumber)).toEqual([1, 1, 2]);
    expect(a.edits.map((e) => e.turnMessage)).toEqual(["Fix the header and add tests", "Fix the header and add tests", "Now the notebook"]);
    expect(a.edits[0]!.lines).toEqual([diffLine("removed", "let x = 1"), diffLine("added", "let x = 10"), diffLine("context", "let y = 2")]);
    expect(a.edits[0]!.time, "when its result came").toBe(date("2026-11-02T01:01:01.000Z"));
    expect(a.added).toBe(1 + 2 + 0);
    expect(a.removed).toBe(1 + 1 + 1);
    expect(read.thisTurn[1]!.edits.length, "this turn holds this turn's edits only").toBe(1);
    expect(read.thisTurn[1]!.added).toBe(0);
    expect(read.thisTurn[1]!.removed).toBe(1);

    const b = read.session[2]!;
    expect(b.added).toBe(3);
    expect(b.edits[0]!.lines.map((l) => l.kind)).toEqual(["added", "added", "added"]);
    expect(read.session[0]!.edits[0]!.tool).toBe("NotebookEdit");
    expect(read.session[0]!.added).toBe(2);
    expect(editCount(read)).toBe(5);
  });

  it("splits Codex patches by file with relative paths resolved", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/x.swift\n@@\n-old x\n+new x\n+more x\n" + "*** Add File: /Users/fixture/proj/y.md\n+# Y\n*** End Patch";
    const rollout = [
      codex(0, "session_meta", { cwd: folder, id: "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b" }, "2026-11-02T00:00:00.000Z"),
      codex(1, "event_msg", { type: "task_started", turn_id: "t1" }, "2026-11-02T01:00:00.000Z"),
      codex(2, "response_item", { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "Patch both" }] }, "2026-11-02T01:00:00.100Z"),
      codex(3, "response_item", { type: "custom_tool_call", call_id: "p1", id: "c1", name: "apply_patch", status: "completed", input: patch }, "2026-11-02T01:01:00.000Z"),
      codex(
        4,
        "response_item",
        { type: "custom_tool_call_output", call_id: "p1", id: "o1", output: [{ type: "input_text", text: "Success. Updated the following files:\nM src/x.swift\nA y.md\n" }] },
        "2026-11-02T01:01:01.000Z",
      ),
      codex(
        5,
        "response_item",
        {
          type: "custom_tool_call",
          call_id: "p2",
          id: "c2",
          name: "exec",
          status: "completed",
          input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: ./src/x.swift\\n@@\\n-more x\\n*** End Patch"));',
        },
        "2026-11-02T01:02:00.000Z",
      ),
      codex(
        6,
        "response_item",
        { type: "custom_tool_call_output", call_id: "p2", id: "o2", output: [{ type: "input_text", text: "Script completed\nOutput:\nSuccess.\n" }] },
        "2026-11-02T01:02:01.000Z",
      ),
      codex(7, "event_msg", { type: "task_complete", turn_id: "t1" }, "2026-11-02T01:03:00.000Z"),
    ];
    const read = changes(rollout, { format: "codex" });
    expect(read.session.map((f) => f.path)).toEqual([folder + "/src/x.swift", folder + "/y.md"]);
    const x = read.session[0]!;
    expect(x.edits.map((e) => e.tool)).toEqual(["apply_patch", "exec"]);
    expect(x.edits[0]!.lines).toEqual([diffLine("removed", "old x"), diffLine("added", "new x"), diffLine("added", "more x")]);
    expect(x.edits[0]!.added).toBe(2);
    expect(x.edits[0]!.removed).toBe(1);
    expect(x.added).toBe(2);
    expect(x.removed).toBe(2);
    expect(read.session[1]!.edits[0]!.lines).toEqual([diffLine("added", "# Y")]);
    expect(read.session[1]!.added).toBe(1);
    expect(read.thisTurnRunning).toBe(false);
  });

  it("gives from the chat's timeline what its lines give", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    for (const line of lines(claudeEdits)) builder.apply(parser.parse(line.text, line.offset).events, line.offset);
    expect(toolChanges(builder.timeline, folder, true)).toEqual(changes(claudeEdits));
  });

  it("keeps every line of a call to 4,000 for Changes while the chat shows 6", () => {
    const content = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join("\n");
    const diff = diffOf(claudeToolCall("w", "Write", { file_path: "/p/big.txt", content }, null));
    expect(diff.lines.length).toBe(keptDiffLineCount);
    expect(diff.moreLines).toBe(5_000 - keptDiffLineCount);
    expect(diffAllLines(diff).length).toBe(fullDiffLineCount);
    expect(diffAllMoreLines(diff)).toBe(1_000);
    expect(diff.added).toBe(5_000);

    const transcript = [
      claudeUser("u1", "Write it", "2026-11-02T01:00:00.000Z"),
      claudeTool("a1", "w", "Write", { file_path: "/p/big.txt", content }, "2026-11-02T01:01:00.000Z"),
      claudeResult("r1", "w", "File created successfully at: /p/big.txt", "2026-11-02T01:01:01.000Z"),
    ];
    const edit = changes(transcript, { folder: "/p" }).session[0]?.edits[0];
    expect(edit?.lines.length).toBe(4_000);
    expect(edit?.moreLines).toBe(1_000);
    expect(edit?.added, "counted over every line").toBe(5_000);
  });

  it("stops the full copy at its bytes (256 KB a call)", () => {
    const long = "x".repeat(100_000);
    const diff = diffOf(claudeToolCall("w", "Write", { file_path: "/p/l.txt", content: [long, long, long, long].join("\n") }, null));
    expect(diffAllLines(diff).length).toBe(2);
    expect(diffAllMoreLines(diff)).toBe(2);
  });

  it("keeps each file's counts of a patch over several files past the full copy", () => {
    const split = (patch: string) => {
      const diff = ChatDiffMaker.patch(patch);
      if (diff === null) throw new Error("no patch");
      const call = claudeToolCall("p", "Edit", { file_path: "a", old_string: "", new_string: "a" }, null);
      return fileChanges({ ...call, detail: { type: "diff", diff } });
    };
    const two = split("*** Begin Patch\n*** Add File: a\n" + "+a\n".repeat(4_100) + "*** Add File: b\n+b\n*** End Patch");
    expect(two.map((c) => c.path)).toEqual(["a", "b"]);
    expect(two.map((c) => c.added), "each file's own count").toEqual([4_100, 1]);
    expect(two.map((c) => c.lines.length)).toEqual([3_999, 0]);
    expect(two.map((c) => c.moreLines), "b says its diff was cut").toEqual([101, 1]);

    const three = split(
      "*** Begin Patch\n*** Update File: a\n" +
        "+a\n".repeat(10) +
        "-a\n".repeat(5) +
        "*** Add File: b\n" +
        "+b\n".repeat(4_000) +
        "*** Update File: c\n+c\n+c\n-c\n-c\n-c\n*** End Patch",
    );
    expect(three.map((c) => c.path)).toEqual(["a", "b", "c"]);
    expect(three.map((c) => c.added)).toEqual([10, 4_000, 2]);
    expect(three.map((c) => c.removed)).toEqual([5, 0, 3]);
    expect(three.map((c) => c.lines.length)).toEqual([15, 3_983, 0]);
    expect(three.map((c) => c.moreLines)).toEqual([0, 17, 5]);
  });

  it("takes a diff made with its shown lines only as its full copy", () => {
    const diff: ChatDiff = { files: ["/w"], added: 1, removed: 0, lines: [diffLine("added", "a")], moreLines: 3 };
    expect(diffAllLines(diff)).toEqual([diffLine("added", "a")]);
    expect(diffAllMoreLines(diff)).toBe(3);
  });

  it("leaves a small diff as the chat had it, and sends the chat's window no full copy", () => {
    const small = ChatDiffMaker.written("a\nb\n", "/w");
    expect(small).toEqual({ files: ["/w"], added: 2, removed: 0, lines: [diffLine("added", "a"), diffLine("added", "b")], moreLines: 0 });
    const content = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    const transcript = [
      claudeUser("u1", "Write it", "2026-11-02T01:00:00.000Z"),
      claudeTool("a1", "w", "Write", { file_path: "/p/f.txt", content }, "2026-11-02T01:01:00.000Z"),
      claudeResult("r1", "w", "File created successfully at: /p/f.txt", "2026-11-02T01:01:01.000Z"),
    ];
    for (const line of lines(transcript)) builder.apply(parser.parse(line.text, line.offset).events, line.offset);
    const held = diffOf(turnToolCalls(builder.timeline.turns[0]!)[0]!);
    expect(diffAllLines(held).length).toBe(50);
    const sent = withoutFullDiffs(builder.timeline);
    const diff = diffOf(turnToolCalls(sent.turns[0]!)[0]!);
    expect(Object.keys(diff).sort()).toEqual(["added", "files", "lines", "moreLines", "removed"]);
    expect(diff.lines.length).toBe(keptDiffLineCount);
    expect(diff.moreLines).toBe(44);
    expect(JSON.stringify(sent).length).toBeLessThan(JSON.stringify(builder.timeline).length);
  });

  it("resolves paths against the folder and shows them inside it", () => {
    expect(resolvePath("src/a.swift", "/r")).toBe("/r/src/a.swift");
    expect(resolvePath("./src/a.swift", "/r/")).toBe("/r/src/a.swift");
    expect(resolvePath("/abs/a.swift", "/r")).toBe("/abs/a.swift");
    expect(resolvePath("src/a.swift", null)).toBe("src/a.swift");
    expect(displayPath("/r/src/a.swift", "/r")).toBe("src/a.swift");
    expect(displayPath("/elsewhere/a.swift", "/r")).toBe("/elsewhere/a.swift");
  });

  it("is empty when nothing is read, and a read that missed the start says so", () => {
    expect(changes([])).toEqual(emptyToolChanges);
    const cut = changes(claudeEdits, { reachedStart: false });
    expect(cut.fromSessionStart).toBe(false);
    expect(cut.session.length).toBe(3);
  });

  it("leaves This turn empty for a turn without edits", () => {
    const transcript = [
      ...claudeEdits.slice(0, 10),
      claudeUser("u9", "Just answer", "2026-11-02T03:00:00.000Z"),
      claudeText("a9", "Sure.", "2026-11-02T03:00:05.000Z", true),
    ];
    const read = changes(transcript);
    expect(read.thisTurn).toEqual([]);
    expect(read.session.length).toBe(2);
    expect(read.thisTurnRunning).toBe(false);
    expect(read.turnCount).toBe(2);
  });
});

describe("a follow-up inside the running turn (chat-live)", () => {
  const seamEdit = (id: string, file: string, uuid: string, second: number): string =>
    Line.json({
      isSidechain: false,
      sessionId: Line.session,
      timestamp: Line.stamp(second),
      type: "assistant",
      uuid,
      message: {
        content: [{ id, name: "Edit", type: "tool_use", input: { file_path: folder + "/" + file, old_string: "let x = 1", new_string: "let x = 2" } }],
        id: "msg_" + uuid,
        role: "assistant",
        stop_reason: "tool_use",
        type: "message",
      },
    });
  const running = [
    Line.user("Fix the parser", "u1", 0),
    Line.progress("Reading the parser first.", "p1", 2),
    seamEdit("e1", "Parser.swift", "a1", 4),
    Line.result("e1", "The file has been updated.", "r1", 5),
    Line.queued("also update its tests", "q1", "src-1", 6),
    Line.progress("Updating the tests as asked.", "p2", 8),
    seamEdit("e2", "ParserTests.swift", "a2", 10),
    Line.result("e2", "The file has been updated.", "r2", 11),
  ];

  it("keeps one This turn, and updates are no edits", () => {
    const { timeline } = Line.timelineOf(running);
    expect(timeline.turns.length, "the follow-up stays inside the running turn").toBe(1);
    const items = timeline.turns[0]!.items;
    expect(items.filter((i) => i.type === "progress").length, "both updates are rows").toBe(2);
    expect(items.filter((i) => i.type === "user").length, "the user's request and the follow-up").toBe(2);

    const read = toolChanges(timeline, folder, true);
    expect(read.turnCount, "no turn of the follow-up's own").toBe(1);
    expect(read.thisTurnRunning, "This turn is working").toBe(true);
    expect(read.thisTurnStartedAt, "from the user's first request").toBe(Line.at(0));
    expect(read.thisTurn.map((f) => f.path), "the edits before and after the follow-up, newest first").toEqual([
      folder + "/ParserTests.swift",
      folder + "/Parser.swift",
    ]);
    expect(read.session.map((f) => f.path)).toEqual(read.thisTurn.map((f) => f.path));
    const edits = read.session.flatMap((f) => f.edits);
    expect(edits.map((e) => e.callId).sort(), "only the Edits: no update, no follow-up").toEqual(["e1", "e2"]);
    expect(new Set(edits.map((e) => e.turnNumber))).toEqual(new Set([1]));
    expect(new Set(edits.map((e) => e.turnMessage)), "named by the message that opened it").toEqual(new Set(["Fix the parser"]));
    expect(editCount(read)).toBe(2);

    const fromLines = toolChangesFromLines(lines(running), "claude", folder, true);
    expect(fromLines.turnCount).toBe(1);
    expect(fromLines.thisTurn.map((f) => f.path)).toEqual(read.thisTurn.map((f) => f.path));
  });

  it("opens the next This turn with a message after the turn ended", () => {
    const { timeline } = Line.timelineOf([...running, Line.reply("Fixed the parser and its tests.", "a3", 14, true), Line.user("Now the docs", "u2", 60)]);
    expect(timeline.turns.length).toBe(2);
    const read = toolChanges(timeline, folder, true);
    expect(read.turnCount).toBe(2);
    expect(read.thisTurn, "nothing changed in the new turn yet").toEqual([]);
    expect(read.session.length).toBe(2);
    expect(new Set(read.session.flatMap((f) => f.edits).map((e) => e.turnNumber))).toEqual(new Set([1]));
  });
});

describe("the transcript's end, read backwards", () => {
  const path = "/t/s.jsonl";
  const text = claudeEdits.join("\n") + "\n";
  const bytes = new TextEncoder().encode(text).length;

  it("reads to the start within its bound, whole lines only", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(path, text, path);
    const read = await readTranscriptEnd(reader, path, { transcriptBytesPerPane: 2 * 1_024 * 1_024, transcriptChunkBytes: 700 });
    expect(read.reachedStart).toBe(true);
    expect(read.lines.map((l) => l.text)).toEqual([...claudeEdits]);
    expect(read.lines.map((l) => l.offset)).toEqual(lines(claudeEdits).map((l) => l.offset));
    expect(read.bytesRead).toBe(bytes);
    expect(transcriptFolder(read.lines, "claude")).toBe(folder);
  });

  it("stops at its bound and says the start was not reached", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(path, text, path);
    const read = await readTranscriptEnd(reader, path, { transcriptBytesPerPane: 1_000, transcriptChunkBytes: 500 });
    expect(read.reachedStart).toBe(false);
    expect(read.bytesRead).toBe(1_000);
    expect(read.lines.length).toBeGreaterThan(0);
    expect(read.lines.length).toBeLessThan(claudeEdits.length);
    expect(read.lines[read.lines.length - 1]!.text).toBe(claudeEdits[claudeEdits.length - 1]);
    const partial = toolChangesFromLines(read.lines, "claude", folder, read.reachedStart);
    expect(partial.fromSessionStart).toBe(false);
  });

  it("stops when cancelled", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(path, text, path);
    const cancel = new AbortController();
    cancel.abort();
    await expect(readTranscriptEnd(reader, path, { transcriptBytesPerPane: 1_000, transcriptChunkBytes: 500 }, cancel.signal)).rejects.toBeInstanceOf(ChangesCancelled);
    expect(reader.calls.filter((c) => c.startsWith("read"))).toEqual([]);
  });

  it("names the newest working folder: Claude's user and assistant lines, Codex's turn context", () => {
    const claude = lines([
      claudeUser("u1", "a", "2026-11-02T01:00:00.000Z", "/old"),
      claudeUser("u2", "b", "2026-11-02T01:01:00.000Z", "/new"),
      Line.json({ type: "user", cwd: "/side", isSidechain: true, message: { role: "user", content: "x" } }),
      Line.json({ type: "system", cwd: "/system" }),
    ]);
    expect(transcriptFolder(claude, "claude")).toBe("/new");
    const rollout = lines([
      codex(0, "session_meta", { cwd: "/first" }, "2026-11-02T00:00:00.000Z"),
      codex(1, "turn_context", { cwd: "/later" }, "2026-11-02T01:00:00.000Z"),
      codex(2, "response_item", { type: "message", cwd: "/no" }, "2026-11-02T01:00:01.000Z"),
    ]);
    expect(transcriptFolder(rollout, "codex")).toBe("/later");
    expect(transcriptFolder([], "codex")).toBeNull();
  });
});
