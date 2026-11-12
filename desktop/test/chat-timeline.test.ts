// A port of HerdrKit's ChatTimelineTests.swift: the timeline model and builder
// and the helpers both parsers use.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import {
  attachment,
  attachmentFileName,
  attachmentIsImage,
  compactDuration,
  diffCountsText,
  diffLine,
  endingRunningTurn,
  foldSummaryLine,
  runningTurn,
  timelineItemCount,
  toolCall,
  toolKindName,
  toolOutput,
  turnFoldSummary,
  turnFooter,
  turnRows,
  turnToolCalls,
  turnUserMessage,
  workedForText,
  workingSince,
  type ChatToolDetail,
  type ChatToolKind,
  type TranscriptEvent,
} from "../src/shared/chat/model";
import { ChatAttachmentText, ChatDiffMaker, ChatOutputText, ChatToolResults, parseChatDate, ShellCommandClassifier } from "../src/shared/chat/tools";

const at = (seconds: number): number => 1_793_500_000 + seconds;

const user = (id: string, text: string, t: number): TranscriptEvent => ({
  type: "userMessage",
  message: { id, text, time: at(t), attachments: [] },
});

const call = (id: string, kind: ChatToolKind, target: string, t: number, detail: ChatToolDetail = { type: "none" }): TranscriptEvent => ({
  type: "toolStarted",
  call: toolCall(id, kind, toolKindName(kind), target, { detail, time: at(t) }),
});

const result = (id: string, text: string, t: number, error = false, exit: number | null = null): TranscriptEvent => ({
  type: "toolFinished",
  id,
  output: toolOutput(text, { isError: error, exitCode: exit }),
  time: at(t),
});

const agentText = (id: string, markdown: string, t: number): TranscriptEvent => ({ type: "agentText", text: { id, markdown, time: at(t) } });

describe("turns", () => {
  it("runs a turn from the user's message to end_turn with a footer", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([user("u1", "Fix it", 0), call("t1", "read", "/a/View.swift", 2), result("t1", "     1→a\n     2→b\n", 3), agentText("x1", "Done.", 161), { type: "agentStopped", time: at(161) }]);
    const { timeline } = builder;
    expect(timeline.turns.length).toBe(1);
    const turn = timeline.turns[0]!;
    expect(turn.isFinished).toBe(true);
    expect(turnFooter(turn)).toEqual({ start: at(0), end: at(161), duration: 161 });
    expect(workedForText(turnFooter(turn)!)).toBe("Worked for 2m 41s");
    expect(workingSince(timeline)).toBeNull();
    expect(runningTurn(timeline)).toBeNull();
  });

  it("does not end a turn at end_turn while a call is still waiting", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([user("u1", "Go", 0), call("t1", "bash", "make", 1), { type: "agentStopped", time: at(2) }]);
    expect(builder.timeline.turns[0]!.isFinished).toBe(false);
    builder.apply([result("t1", "ok", 3), { type: "agentStopped", time: at(4) }]);
    expect(builder.timeline.turns[0]!.isFinished).toBe(true);
    expect(builder.timeline.turns[0]!.endedAt).toBe(at(4));
  });

  it("ends the turn at its last event when the next message comes", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([user("u1", "One", 0), call("t1", "bash", "ls", 5), result("t1", "a", 9), user("u2", "Two", 30)]);
    const { turns } = builder.timeline;
    expect(turns.length).toBe(2);
    expect(turns[0]!.isFinished).toBe(true);
    expect(turns[0]!.endedAt).toBe(at(9));
    expect(turnFooter(turns[0]!)?.duration).toBe(9);
    expect(turns[1]!.isFinished).toBe(false);
    expect(workingSince(builder.timeline)).toBe(at(30));
  });

  it("makes Codex task_started then a message one turn, and uses the reported duration", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([
      { type: "turnStarted", time: at(0) },
      user("m1", "Summarise", 0.2),
      agentText("m2", "Short.", 40),
      { type: "turnCompleted", time: at(41), duration: 40.5 },
    ]);
    const { turns } = builder.timeline;
    expect(turns.length).toBe(1);
    expect(turnUserMessage(turns[0]!)?.text).toBe("Summarise");
    expect(turnFooter(turns[0]!)?.duration).toBe(40.5);
    expect(turnFooter(turns[0]!)?.start).toBe(at(0));
  });

  it("starts a partial turn for agent activity with no turn open", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([agentText("a", "mid-way", 5)]);
    expect(builder.timeline.turns[0]!.isPartial).toBe(true);
    expect(turnUserMessage(builder.timeline.turns[0]!)).toBeNull();
    expect(workingSince(builder.timeline)).toBe(at(5));
  });
});

describe("folding", () => {
  it("folds a finished turn's calls into one summary row and keeps a failed call open", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([
      user("u1", "Fix", 0),
      call("r1", "read", "/a/One.swift", 1),
      result("r1", "x\ny\n", 2),
      call("r2", "read", "/a/Two.swift", 3),
      result("r2", "x\n", 4),
      call("b1", "bash", "swift test --filter Nope", 5, { type: "bash", bash: { command: "swift test --filter Nope", outputTail: [], exitCode: null } }),
      result("b1", "error: no tests\nfailed", 6, true, 1),
      agentText("x1", "Retrying.", 7),
      call("b2", "bash", "swift test", 8),
      result("b2", "ok", 9, false, 0),
      agentText("x2", "Green.", 10),
      { type: "agentStopped", time: at(10) },
    ]);
    const turn = builder.timeline.turns[0]!;
    expect(turnFoldSummary(turn)).toBe("Read 2 files, ran 1 command");
    const rows = turnRows(turn);
    expect(rows.length).toBe(5);
    const [first, folded, failed, text1, text2] = rows;
    expect(first?.type === "item" && first.item.type).toBe("user");
    expect(folded?.type === "folded" ? folded.folded.calls.map((value) => value.id) : null).toEqual(["r1", "r2", "b2"]);
    expect(text1?.type === "item" && text1.item.type).toBe("agentText");
    expect(text2?.type === "item" && text2.item.type).toBe("agentText");
    const failedCall = failed?.type === "item" && failed.item.type === "toolCall" ? failed.item.value : null;
    expect(failedCall?.id).toBe("b1");
    expect(failedCall?.state).toBe("failed");
    expect(failedCall?.resultSummary).toBe("exit 1");
    expect(failedCall?.detail.type === "bash" ? failedCall.detail.bash.outputTail : null).toEqual(["error: no tests", "failed"]);
  });

  it("shows every call of a running turn", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([user("u1", "Go", 0), call("r1", "read", "/a", 1), result("r1", "a", 2), call("b1", "bash", "make", 3)]);
    const turn = builder.timeline.turns[0]!;
    expect(turnFoldSummary(turn)).toBeNull();
    expect(turnRows(turn).length).toBe(3);
    expect(turnRows(turn).every((row) => row.type === "item")).toBe(true);
  });

  it("words the summary for every kind", () => {
    const c = (id: string, kind: ChatToolKind, target = "") => toolCall(id, kind, "x", target, { state: "ok" });
    expect(foldSummaryLine([c("1", "read", "/a"), c("2", "read", "/a")])).toBe("Read 1 file");
    expect(
      foldSummaryLine([
        c("1", "edit", "/a"),
        c("2", "bash"),
        c("3", "bash"),
        c("4", "search"),
        c("5", "search"),
        c("6", "web"),
        c("7", "agent"),
        c("8", "plan"),
        c("9", { other: "ToolSearch" }),
      ]),
    ).toBe("Edited 1 file, ran 2 commands, ran 2 searches, made 1 web request, ran 1 agent, updated the plan, used 1 other tool");
    expect(foldSummaryLine([])).toBeNull();
  });

  it("updates the plan in place within a turn", () => {
    const builder = new ChatTimelineBuilder();
    const first: ChatToolDetail = {
      type: "plan",
      steps: [
        { text: "Read", status: "inProgress" },
        { text: "Fix", status: "pending" },
      ],
    };
    const second: ChatToolDetail = {
      type: "plan",
      steps: [
        { text: "Read", status: "completed" },
        { text: "Fix", status: "inProgress" },
      ],
    };
    builder.apply([
      user("u1", "Go", 0),
      call("p1", "plan", "Read", 1, first),
      result("p1", "ok", 1),
      call("b1", "bash", "ls", 2),
      result("b1", "a", 3),
      call("p2", "plan", "Fix", 4, second),
      result("p2", "ok", 4),
    ]);
    const calls = turnToolCalls(builder.timeline.turns[0]!);
    expect(calls.map((value) => value.kind)).toEqual(["plan", "bash"]);
    expect(calls[0]!.detail).toEqual(second);
    expect(calls[0]!.target).toBe("Fix");
    expect(calls[0]!.resultSummary).toBe("1 of 2 done");
    expect(calls[0]!.state).toBe("ok");
  });

  it("gives notices and ! shell rows no footer and never folds them", () => {
    const builder = new ChatTimelineBuilder();
    const shell = toolCall("s1", "bash", "!", "ls", { detail: { type: "bash", bash: { command: "ls", outputTail: [], exitCode: null } }, time: at(0) });
    builder.apply([{ type: "userShell", call: shell }, result("s1", "a\nb", 1), { type: "notice", notice: { id: "n1", kind: "compacted", time: at(2) }, endsTurn: false }]);
    const { turns } = builder.timeline;
    expect(turns.length).toBe(2);
    expect(turns.every((turn) => turn.isFinished)).toBe(true);
    expect(turnFooter(turns[0]!)).toBeNull();
    expect(turnFoldSummary(turns[0]!)).toBeNull();
    expect(turnToolCalls(turns[0]!)[0]?.isUserShell).toBe(true);
    expect(turnToolCalls(turns[0]!)[0]?.state).toBe("ok");
    expect(turns[1]!.items[0]).toEqual({ type: "notice", value: { id: "n1", kind: "compacted", time: at(2) } });
  });

  it("ends the running turn at an interrupt notice", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([
      user("u1", "Go", 0),
      call("b1", "bash", "sleep 100", 1),
      result("b1", "The user doesn't want to proceed", 5, true),
      { type: "notice", notice: { id: "n1", kind: "interrupted", time: at(5) }, endsTurn: true },
    ]);
    const turn = builder.timeline.turns[0]!;
    expect(turn.isFinished).toBe(true);
    expect(turn.endedAt).toBe(at(5));
    expect(turn.items.at(-1)?.value.id).toBe("n1");
  });

  it("ends the running turn for a pane Herdr reports idle", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([user("u1", "Go", 0), agentText("a", "hi", 3)]);
    const ended = endingRunningTurn(builder.timeline);
    expect(ended.turns[0]!.isFinished).toBe(true);
    expect(ended.turns[0]!.endedAt).toBe(at(3));
    expect(workingSince(ended)).toBeNull();
  });

  it("makes duplicate ids unique and keeps the first of a tool written twice", () => {
    const builder = new ChatTimelineBuilder();
    builder.apply([user("same", "One", 0), agentText("same", "a", 1), call("t1", "read", "/a", 2), call("t1", "bash", "ls", 3)]);
    const items = builder.timeline.turns[0]!.items;
    expect(new Set(items.map((item) => item.value.id)).size).toBe(items.length);
    expect(turnToolCalls(builder.timeline.turns[0]!).map((value) => value.kind)).toEqual(["read"]);
  });

  it("keeps the newest items and marks a cut turn partial", () => {
    const builder = new ChatTimelineBuilder(5);
    builder.apply([user("u1", "One", 0)]);
    for (let index = 0; index < 4; index += 1) builder.apply([agentText(`a${index}`, "x", index)]);
    builder.apply([{ type: "agentStopped", time: at(5) }, user("u2", "Two", 10), agentText("b", "y", 11)]);
    const { timeline } = builder;
    expect(timelineItemCount(timeline)).toBe(5);
    expect(timeline.turns.length).toBe(2);
    expect(timeline.turns[0]!.isPartial).toBe(true);
    expect(turnUserMessage(timeline.turns[0]!)).toBeNull();
    expect(timeline.turns[0]!.items.map((item) => item.value.id)).toEqual(["a1", "a2", "a3"]);
    expect(turnUserMessage(timeline.turns[1]!)?.id).toBe("u2");
  });

  it("keeps memory bounded and still pairs results after a trim", () => {
    const builder = new ChatTimelineBuilder(10);
    builder.apply([user("u0", "Go", 0)]);
    for (let index = 0; index < 100; index += 1) {
      builder.apply([call(`c${index}`, "bash", `echo ${index}`, index)]);
      builder.apply([result(`c${index}`, `${index}`, index)]);
    }
    builder.apply([call("last", "bash", "echo last", 200)]);
    builder.apply([result("last", "done", 201, false, 0)]);
    const calls = builder.timeline.turns.flatMap(turnToolCalls);
    expect(timelineItemCount(builder.timeline)).toBe(10);
    expect(calls.at(-1)?.id).toBe("last");
    expect(calls.at(-1)?.state).toBe("ok");
    expect(calls.at(-1)?.resultSummary).toBe("exit 0");
  });
});

describe("diffs", () => {
  it("keeps context around an edit's change and counts every line", () => {
    const old = "let pan = make()\npan.mask = []\naddGestureRecognizer(pan)";
    const next = "let pan = make()\npan.mask = .all\npan.touches = 2\naddGestureRecognizer(pan)";
    const diff = ChatDiffMaker.replacement(old, next, "/a/View.swift");
    expect(diffCountsText(diff)).toBe("+2 −1");
    expect(diff.files).toEqual(["/a/View.swift"]);
    expect(diff.lines).toEqual([
      diffLine("context", "let pan = make()"),
      diffLine("removed", "pan.mask = []"),
      diffLine("added", "pan.mask = .all"),
      diffLine("added", "pan.touches = 2"),
      diffLine("context", "addGestureRecognizer(pan)"),
    ]);
    expect(diff.moreLines).toBe(0);
  });

  it("keeps the first six lines and counts the rest", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const diff = ChatDiffMaker.written(content, "/a/New.swift");
    expect(diff.added).toBe(20);
    expect(diff.removed).toBe(0);
    expect(diff.lines.length).toBe(6);
    expect(diff.moreLines).toBe(14);
  });

  it("finds separate changes with LCS", () => {
    const result = ChatDiffMaker.lineDiff(["a", "b", "c", "d", "e", "f", "g"], ["a", "B", "c", "d", "e", "F", "g"]);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
    expect(result.lines.map((line) => line.kind)).toEqual(["context", "removed", "added", "context", "context", "removed", "added", "context"]);
  });

  it("counts each edit of a MultiEdit", () => {
    const diff = ChatDiffMaker.replacements(
      [
        { old: "a", new: "b" },
        { old: "c\nd", new: "e" },
      ],
      "/x",
    );
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(3);
  });

  it("lists both files of a patch across two files and counts all", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /p/README.md",
      "@@",
      " intro",
      "-old",
      "+new",
      "+more",
      "*** Add File: /p/NOTES.md",
      "+one",
      "+two",
      "*** Delete File: /p/OLD.md",
      "*** End Patch",
    ].join("\n");
    const diff = ChatDiffMaker.patch(patch)!;
    expect(diff.files).toEqual(["/p/README.md", "/p/NOTES.md", "/p/OLD.md"]);
    expect(diffCountsText(diff)).toBe("+4 −1");
    expect(diff.lines[0]).toEqual(diffLine("file", "/p/README.md"));
    expect(diff.lines.length).toBe(6);
    expect(diff.moreLines).toBe(3);
    expect(ChatDiffMaker.patch("just words")).toBeNull();
  });
});

describe("output text", () => {
  it("counts numbered Read lines and ignores reminders", () => {
    expect(ChatOutputText.readLineCount("     1→a\n     2→\n     3→c\n<system-reminder>\nnote\n</system-reminder>")).toBe(3);
    expect(ChatOutputText.readLineCount("a\nb\n\nd\n")).toBe(4);
  });

  it("reads Claude Grep, rg matches and plain lists", () => {
    expect(ChatOutputText.matchedFiles("Found 4 files\n/a/1.swift\n/a/2.swift\n/a/3.swift\n/a/4.swift").count).toBe(4);
    const rg = ChatOutputText.matchedFiles("App/A.swift:12:  let x\nApp/A.swift:30:  y\nApp/B.swift:4:z\n");
    expect(rg.files).toEqual(["App/A.swift", "App/B.swift"]);
    expect(rg.count).toBe(2);
    expect(ChatOutputText.matchedFiles("No files found").count).toBe(0);
    expect(ChatOutputText.matchedFiles("./a\n./b\n./c").files).toEqual(["./a", "./b", "./c"]);
  });

  it("drops escapes and blank lines from the last lines", () => {
    expect(ChatOutputText.lastLines("one\n\u001b[32mtwo\u001b[0m\n\nthree   \nfour\n\n")).toEqual(["two", "three", "four"]);
  });
});

describe("dates", () => {
  it("reads ISO dates with and without fractions and offsets", () => {
    const base = parseChatDate("2026-11-01T02:41:07Z");
    expect(base).toBe(1_793_500_867);
    expect(parseChatDate("2026-11-01T02:41:07.311Z")!).toBeCloseTo(1_793_500_867.311, 4);
    expect(parseChatDate("2026-11-01T06:41:07+04:00")).toBe(base);
    expect(parseChatDate("2026-11-01T02:41:07")).toBe(base);
    expect(parseChatDate("2024-02-29T00:00:00Z")).toBe(1_709_164_800);
    expect(parseChatDate("yesterday")).toBeNull();
    expect(parseChatDate("2026-13-01T00:00:00Z")).toBeNull();
    expect(parseChatDate(42)).toBeNull();
  });
});

describe("shell classification", () => {
  it("classifies shell commands by their first program", () => {
    const kind = (command: string) => ShellCommandClassifier.classify(command).kind;
    const target = (command: string) => ShellCommandClassifier.classify(command).target;
    expect(kind("cat /p/SKILL.md")).toBe("read");
    expect(target("cat /p/SKILL.md")).toBe("/p/SKILL.md");
    expect(target("sed -n '1,200p' App/View.swift")).toBe("App/View.swift");
    expect(kind("sed -i '' 's/a/b/' x")).toBe("bash");
    expect(kind("sed 's/a/b/' x")).toBe("bash");
    expect(target("head -n 40 README.md")).toBe("README.md");
    expect(target("tail -n 5 log.txt 2>/dev/null")).toBe("log.txt");
    expect(kind("nl -ba file.swift")).toBe("read");
    expect(kind("bat file.swift")).toBe("read");
    expect(kind("cat > out.txt <<'EOF'\nhi\nEOF")).toBe("bash");
    expect(kind("rg -n 'scrollMask' App")).toBe("search");
    expect(target("rg -n -g '*.swift' scrollMask App")).toBe("scrollMask");
    expect(target("grep -rn -e needle src")).toBe("needle");
    expect(target("find . -name '*.jsonl' -mtime -1")).toBe("*.jsonl");
    expect(target("fd -e swift Chat")).toBe("Chat");
    expect(kind("ls -la App")).toBe("search");
    expect(target("ls -la App")).toBe("App");
    expect(target("cd /p/proj && rg TODO")).toBe("TODO");
    expect(kind("FOO=1 cat x")).toBe("read");
    expect(kind("/usr/bin/grep x y")).toBe("search");
    expect(kind("swift test --filter X")).toBe("bash");
    expect(target("  swift build  ")).toBe("swift build");
    expect(kind("python3 - <<'PY'\nprint(1)\nPY")).toBe("bash");
    expect(kind("git status && cat x")).toBe("bash");
    const patch = ShellCommandClassifier.classify("apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: /p/a.txt\n+hi\n*** End Patch\nEOF");
    expect(patch.kind).toBe("edit");
    expect(patch.target).toBe("/p/a.txt");
  });
});

describe("attachments", () => {
  it("moves uploaded paths out of the text", () => {
    const a = "/Users/f/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png";
    const b = "/Users/f/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-22222222-2222-2222-2222-222222222222.jpg";
    const extracted = ChatAttachmentText.extract(`Look at these two\nplease ${a} ${b} `);
    expect(extracted.text).toBe("Look at these two\nplease");
    expect(extracted.attachments).toEqual([attachment(a), attachment(b)]);
    expect(extracted.attachments.every(attachmentIsImage)).toBe(true);
    expect(attachmentFileName(extracted.attachments[0]!)).toBe("attachment-11111111-1111-1111-1111-111111111111.png");
    expect(ChatAttachmentText.extract(`before ${a} after`).text).toBe("before after");
    expect(ChatAttachmentText.extract(`line one\n${a}\nline two`).text).toBe("line one\nline two");
  });

  it("takes upload paths with spaces whole or leaves them alone", () => {
    const tail = "/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png";
    const spaced = "/Volumes/User Homes/me" + tail;
    for (const quote of ['"', "'"]) {
      const quoted = ChatAttachmentText.extract(`See this ${quote}${spaced}${quote}`);
      expect(quoted.text, quote).toBe("See this");
      expect(quoted.attachments, quote).toEqual([attachment(spaced)]);
      const inside = ChatAttachmentText.extract(`Compare ${quote}${spaced}${quote} with the old one`);
      expect(inside.text, quote).toBe("Compare with the old one");
      expect(inside.attachments, quote).toEqual([attachment(spaced)]);
    }
    const escaped = ChatAttachmentText.extract(String.raw`See /Volumes/User\ Homes/me` + tail + " please");
    expect(escaped.text).toBe("See please");
    expect(escaped.attachments).toEqual([attachment(spaced)]);

    // Unquoted with a bare space: the start cannot be known, so nothing is touched.
    const ambiguous = `See this ${spaced} please`;
    const untouched = ChatAttachmentText.extract(ambiguous);
    expect(untouched.text).toBe(ambiguous);
    expect(untouched.attachments).toEqual([]);
    for (const broken of [
      `See "${spaced}`,
      `Homes/me${tail}`,
      "/a/.herdr-companion-attachments-0123/attachment-1.png",
      "/a/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-not-a-uuid.png",
      "/a/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.exe",
      `/a${tail}x`,
    ]) {
      const extracted = ChatAttachmentText.extract(broken);
      expect(extracted.text, broken).toBe(broken);
      expect(extracted.attachments, broken).toEqual([]);
    }
    const plain = "/Users/f" + tail;
    const bracketed = ChatAttachmentText.extract(`it's here (${plain}) ok`);
    expect(bracketed.text).toBe("it's here ok");
    expect(bracketed.attachments).toEqual([attachment(plain)]);
    const apostrophe = ChatAttachmentText.extract("/Users/O'Brien" + tail);
    expect(apostrophe.attachments).toEqual([attachment("/Users/O'Brien" + tail)]);
    expect(apostrophe.text).toBe("");
  });

  it("does not take a search's line or match total for a file total", () => {
    const lines = ChatOutputText.matchedFiles("Found 3 lines\nApp/A.swift:1:a\nApp/A.swift:2:b\nApp/B.swift:1:c");
    expect(lines.files).toEqual(["App/A.swift", "App/B.swift"]);
    expect(lines.count).toBe(2);
    expect(ChatOutputText.matchedFiles("Found 5 matches\nApp/A.swift:1:a\nApp/A.swift:9:b\nApp/C.swift:4:c").count).toBe(2);
    expect(ChatOutputText.matchedFiles("Found 1 line\nApp/A.swift:1:a").count).toBe(1);
    const files = ChatOutputText.matchedFiles("Found 4 files\nApp/A.swift\nApp/B.swift\n(Results are truncated. Consider using a more specific path or pattern.)");
    expect(files.files).toEqual(["App/A.swift", "App/B.swift"]);
    expect(files.count).toBe(4);
    expect(ChatOutputText.matchedFiles("Found 1 file\nApp/A.swift").count).toBe(1);

    const grep = toolCall("g", "search", "Grep", "needle", { detail: { type: "search", search: { pattern: "needle", files: [], fileCount: null } } });
    const applied = ChatToolResults.apply(toolOutput("Found 3 lines\nApp/A.swift:1:a\nApp/A.swift:2:b\nApp/B.swift:1:c"), grep, null);
    expect(applied.resultSummary).toBe("2 files");
  });

  it("takes an upload path in backticks", () => {
    const tail = "/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-1111-1111-111111111111.png";
    for (const home of ["/Users/f", "/Volumes/User Homes/me"]) {
      const path = home + tail;
      const extracted = ChatAttachmentText.extract("See `" + path + "` please");
      expect(extracted.attachments, home).toEqual([attachment(path)]);
      expect(extracted.text, home).toBe("See please");
    }
    const singleQuoted = "See '/Users/O'Brien" + tail + "' please";
    expect(ChatAttachmentText.extract(singleQuoted).text).toBe(singleQuoted);
    for (const mark of ["`", '"']) {
      const path = "/Users/O'Brien" + tail;
      const extracted = ChatAttachmentText.extract("See " + mark + path + mark + " please");
      expect(extracted.attachments, mark).toEqual([attachment(path)]);
      expect(extracted.text, mark).toBe("See please");
    }
    for (const broken of [`See \`/Volumes/User Homes/me${tail} please`, `See \`/Volumes/User Homes/me${tail}" please`]) {
      const extracted = ChatAttachmentText.extract(broken);
      expect(extracted.text, broken).toBe(broken);
      expect(extracted.attachments, broken).toEqual([]);
    }
  });

  it("strips and counts image markers", () => {
    const extracted = ChatAttachmentText.extract("[Image #1] [Image #2] Why is this blank?\n[Image: source: /Users/f/Desktop/shot.png]");
    expect(extracted.text).toBe("Why is this blank?");
    expect(extracted.imageMarkers).toBe(2);
    expect(extracted.attachments).toEqual([attachment("/Users/f/Desktop/shot.png")]);
    const plain = ChatAttachmentText.extract("no attachments here");
    expect(plain.text).toBe("no attachments here");
    expect(plain.attachments).toEqual([]);
  });

  it("words durations", () => {
    expect(compactDuration(12)).toBe("12s");
    expect(compactDuration(161)).toBe("2m 41s");
    expect(compactDuration(3840)).toBe("1h 4m");
    expect(compactDuration(-5)).toBe("0s");
  });
});
