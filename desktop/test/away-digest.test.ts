// A port of HerdrKit's AwayDigestBuilderTests.swift and
// AwayDigestProgressTests.swift: the
// "While you were away" digest from fixtures. Transcripts are hand-built in
// the parsers' line shapes, invented content. `since` is 01:00 UTC on 2 November.

import { describe, expect, it } from "vitest";

import { makeSessionRef } from "../src/shared/chat/locator";
import type { TranscriptLine } from "../src/shared/chat/follower";
import type { TranscriptFormat } from "../src/shared/chat/parser";
import {
  awayActivity,
  awayActivityOf,
  awayPanes,
  buildAwayDigest,
  cardsIn,
  digestCommitCount,
  digestHasNews,
  digestSummaryText,
  waitingText,
  type AwayActivity,
  type AwayCommit,
  type AwayGitResult,
  type AwayMacInput,
  type AwayPane,
  type AwayPaneInput,
  type AwayTranscriptState,
} from "../src/shared/away/digest";
import { ago as agoText, cardStats, macLineText, replyLine, transcriptNote } from "../src/shared/away/text";
import { emptyFoldState, type AgentStatus, type SidebarInput } from "../src/shared/sidebar-model";
import { json, progress, queued, reply, result, tool, user } from "./support/chat-lines";
import { tonight } from "./support/pasted-tonight";

const date = (iso: string): number => Date.parse(iso) / 1000;
const since = date("2026-11-02T01:00:00.000Z");
const now = date("2026-11-02T03:00:00.000Z");

type J = string | number | boolean | null | J[] | { [key: string]: J };

const claudeUser = (uuid: string, text: string, time: string): string =>
  json({ type: "user", uuid, timestamp: time, cwd: "/Users/fixture/proj", isSidechain: false, sessionId: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f", message: { role: "user", content: text } });

function claudeText(uuid: string, text: string, time: string, endTurn: boolean, apiError = false): string {
  const object: { [key: string]: J } = {
    type: "assistant",
    uuid,
    timestamp: time,
    isSidechain: false,
    message: { id: "msg_" + uuid, role: "assistant", type: "message", stop_reason: endTurn ? "end_turn" : null, content: [{ type: "text", text }] },
  };
  if (apiError) object.isApiErrorMessage = true;
  return json(object);
}

const claudeTool = (uuid: string, id: string, name: string, input: { [key: string]: J }, time: string): string =>
  json({
    type: "assistant",
    uuid,
    timestamp: time,
    isSidechain: false,
    message: { id: "msg_" + uuid, role: "assistant", type: "message", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
  });

const claudeResult = (uuid: string, id: string, content: string, time: string, isError = false): string =>
  json({ type: "user", uuid, timestamp: time, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

const codex = (ordinal: number, type: string, payload: { [key: string]: J }, time: string): string => json({ ordinal, type, payload, timestamp: time });

/** The lines with the offsets they would have in one file. */
function lines(texts: readonly string[]): TranscriptLine[] {
  let offset = 0;
  return texts.map((text) => {
    const line = { text, offset };
    offset += new TextEncoder().encode(text).length + 1;
    return line;
  });
}

/** Dev (Claude): a turn begun before `since` that ends after it with two more edits, a commit and its reply; then a failing test run and the last reply. */
const devTranscript = [
  claudeUser("u1", "Ship the pairing retry", "2026-11-02T00:50:00.000Z"),
  claudeTool("a1", "toolu_e1", "Edit", { file_path: "/Users/fixture/proj/Pairing.swift", old_string: "a", new_string: "b" }, "2026-11-02T00:55:00.000Z"),
  claudeResult("u2", "toolu_e1", "The file /Users/fixture/proj/Pairing.swift has been updated.", "2026-11-02T00:55:01.000Z"),
  claudeTool("a2", "toolu_e2", "Edit", { file_path: "/Users/fixture/proj/PairingCoordinator.swift", old_string: "x", new_string: "y" }, "2026-11-02T01:05:00.000Z"),
  claudeResult("u3", "toolu_e2", "The file /Users/fixture/proj/PairingCoordinator.swift has been updated.", "2026-11-02T01:05:01.000Z"),
  claudeTool("a3", "toolu_w1", "Write", { file_path: "/Users/fixture/proj/Tests/PairingRetryTests.swift", content: "import XCTest\n" }, "2026-11-02T01:06:00.000Z"),
  claudeResult("u4", "toolu_w1", "File created successfully at: /Users/fixture/proj/Tests/PairingRetryTests.swift", "2026-11-02T01:06:01.000Z"),
  claudeTool("a4", "toolu_b1", "Bash", { command: "git commit -am 'Retry pairing once'", description: "Commit" }, "2026-11-02T01:10:00.000Z"),
  claudeResult("u5", "toolu_b1", "[main 1a2b3c4] Retry pairing once\n 2 files changed, 40 insertions(+)", "2026-11-02T01:10:02.000Z"),
  claudeText("a5", "Pairing now retries once.\n\n- `PairingCoordinator` retries a refused key once\n- Tests added", "2026-11-02T01:12:00.000Z", true),
  claudeUser("u6", "Run the full suite", "2026-11-02T01:20:00.000Z"),
  claudeTool("a6", "toolu_b2", "Bash", { command: "swift test", description: "Tests" }, "2026-11-02T01:21:00.000Z"),
  claudeResult("u7", "toolu_b2", "Exit code 1\nerror: 2 tests failed", "2026-11-02T01:25:00.000Z", true),
  claudeText(
    "a7",
    "Two tests fail in **PairingTests**.\nBoth expect the old timeout.\n\nI left them for you to decide.\nSay the word and I update them.\nOne more line that is cut.",
    "2026-11-02T01:30:00.000Z",
    true,
  ),
];

/** Review (Codex): one turn after `since` with an apply_patch and a failed command. */
const reviewRollout = [
  codex(0, "session_meta", { cwd: "/Users/fixture/proj", id: "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b" }, "2026-11-02T00:00:00.000Z"),
  codex(1, "event_msg", { type: "task_started", turn_id: "turn-a" }, "2026-11-02T01:40:00.000Z"),
  codex(2, "response_item", { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "Fix the README typo and test" }] }, "2026-11-02T01:40:00.100Z"),
  codex(
    3,
    "response_item",
    {
      type: "custom_tool_call",
      call_id: "call_patch",
      id: "ctc1",
      name: "exec",
      status: "completed",
      input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /Users/fixture/proj/README.md\\n@@\\n-A smal tool.\\n+A small tool.\\n*** End Patch"));',
    },
    "2026-11-02T01:41:00.000Z",
  ),
  codex(
    4,
    "response_item",
    {
      type: "custom_tool_call_output",
      call_id: "call_patch",
      id: "ctco1",
      output: [{ type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nM /Users/fixture/proj/README.md\n" }],
    },
    "2026-11-02T01:41:01.000Z",
  ),
  codex(
    5,
    "response_item",
    { type: "custom_tool_call", call_id: "call_test", id: "ctc2", name: "exec", status: "completed", input: "text(await tools.exec_command({cmd:'swift test --filter ReadmeTest'}));" },
    "2026-11-02T01:42:00.000Z",
  ),
  codex(
    6,
    "response_item",
    {
      type: "custom_tool_call_output",
      call_id: "call_test",
      id: "ctco2",
      output: [
        {
          type: "input_text",
          text: "Script completed\nWall time 3.1 seconds\nOutput:\nChunk ID: a1b2\nWall time: 3.0 seconds\nProcess exited with code 1\nOriginal token count: 12\nOutput:\nerror: no tests matched 'ReadmeTest'\n",
        },
      ],
    },
    "2026-11-02T01:42:03.000Z",
  ),
  codex(
    7,
    "response_item",
    { type: "message", role: "assistant", id: "m2", phase: "final_answer", content: [{ type: "output_text", text: "Fixed the typo; the README test filter matched nothing." }] },
    "2026-11-02T01:43:00.000Z",
  ),
  codex(8, "event_msg", { type: "task_complete", duration_ms: 180000, turn_id: "turn-a" }, "2026-11-02T01:43:01.000Z"),
];

/** Tidepool (Claude): asks to edit a file (a permission menu): the Edit has no result yet. */
const waitingTranscript = [
  claudeUser("u1", "Change the paywall copy", "2026-11-02T01:50:00.000Z"),
  claudeTool("a1", "toolu_wait", "Edit", { file_path: "/Users/fixture/tidepool/PaywallView.swift", old_string: "Start", new_string: "Try" }, "2026-11-02T01:58:00.000Z"),
];

/** Ops (Claude): nothing since 00:10. */
const quietTranscript = [claudeUser("u1", "Status?", "2026-11-02T00:09:00.000Z"), claudeText("a1", "All green.", "2026-11-02T00:10:00.000Z", true)];

/** Bench (Codex): working, a command running since 02:50. */
const workingRollout = [
  codex(0, "event_msg", { type: "task_started", turn_id: "turn-b" }, "2026-11-02T02:40:00.000Z"),
  codex(1, "response_item", { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "Run the benchmarks" }] }, "2026-11-02T02:40:00.100Z"),
  codex(
    2,
    "response_item",
    { type: "custom_tool_call", call_id: "call_bench", id: "ctc1", name: "exec", status: "completed", input: "text(await tools.exec_command({cmd:'swift run -c release bench'}));" },
    "2026-11-02T02:50:00.000Z",
  ),
];

const activity = (texts: readonly string[], format: TranscriptFormat, truncated = false): AwayActivity => awayActivityOf(lines(texts), format, since, truncated);

function pane(id: string, name: string, kind: string, status: AgentStatus, folder = "/Users/fixture/proj", statusSince: number | null = null): AwayPane {
  return { paneID: id, name, kind, folder, status, statusSince, session: null };
}

const read = (value: AwayActivity): AwayTranscriptState => ({ kind: "read", activity: value });

const commit: AwayCommit = { hash: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", subject: "Retry pairing once", time: date("2026-11-02T01:10:01.000Z") };

function twoMacs(): AwayMacInput[] {
  return [
    {
      id: "studio",
      name: "Studio Mac",
      since,
      state: { kind: "online" },
      panes: [
        { pane: pane("w7:p1", "Dev", "claude", "done"), transcript: read(activity(devTranscript, "claude")) },
        { pane: pane("w7:p2", "Review", "codex", "idle"), transcript: read(activity(reviewRollout, "codex")) },
        { pane: pane("w2:p1", "Tidepool", "claude", "blocked", "/Users/fixture/tidepool", date("2026-11-02T02:00:00.000Z")), transcript: read(activity(waitingTranscript, "claude")) },
      ],
      git: { "/Users/fixture/proj": { kind: "commits", commits: [commit] }, "/Users/fixture/tidepool": { kind: "notARepository" } },
    },
    {
      id: "mini",
      name: "Mac mini",
      since,
      state: { kind: "online" },
      panes: [
        { pane: pane("w3:p1", "Ops", "claude", "idle", "/Users/fixture/ops"), transcript: read(activity(quietTranscript, "claude")) },
        { pane: pane("w3:p2", "Bench", "codex", "working", "/Users/fixture/bench"), transcript: read(activity(workingRollout, "codex")) },
      ],
      git: {},
    },
  ];
}

const oneMac = (panes: AwayMacInput["panes"], git: AwayMacInput["git"] = {}): AwayMacInput[] => [{ id: "studio", name: "Studio Mac", since, state: { kind: "online" }, panes, git }];

describe("one transcript at a time", () => {
  it("reads a Claude transcript with edits, a commit and a final reply", () => {
    const dev = activity(devTranscript, "claude");
    // The turn that spans `since` ended after it, and the second turn.
    expect(dev.turnsFinished).toBe(2);
    expect(dev.lastTurnEndedAt).toBe(date("2026-11-02T01:30:00.000Z"));
    // Only the edits made after `since`: Pairing.swift was edited before.
    expect(dev.files).toEqual(["/Users/fixture/proj/PairingCoordinator.swift", "/Users/fixture/proj/Tests/PairingRetryTests.swift"]);
    expect(dev.errorCount).toBe(1);
    expect(dev.lastError?.text).toContain("swift test");
    expect(dev.lastReply?.lines).toEqual([
      "Two tests fail in **PairingTests**.",
      "Both expect the old timeout.",
      "I left them for you to decide.",
      "Say the word and I update them.",
    ]);
    expect(dev.lastReply?.time).toBe(date("2026-11-02T01:30:00.000Z"));
    expect(dev.firstNewItemID).toBe("toolu_e2");
    expect(dev.lastActivityAt).toBe(date("2026-11-02T01:30:00.000Z"));
    expect(dev.truncated).toBe(false);

    const digest = buildAwayDigest(oneMac([{ pane: pane("w7:p1", "Dev", "claude", "done"), transcript: read(dev) }], { "/Users/fixture/proj": { kind: "commits", commits: [commit] } }), now);
    const card = digest.cards[0]!;
    expect(card.group).toBe("finished");
    expect(card.commits.map((c) => c.subject)).toEqual(["Retry pairing once"]);
    expect(card.commitCount).toBe(1);
    expect(card.fileCount).toBe(2);
    expect(card.isNew).toBe(true);
    expect(card.macName).toBe("Studio Mac");
    expect(card.folder).toBe("/Users/fixture/proj");
    expect(digestSummaryText(digest)).toBe("1 agent: 1 finished, 1 commit");
  });

  it("reads a Codex rollout with an apply_patch and a failed command", () => {
    const review = activity(reviewRollout, "codex");
    expect(review.turnsFinished).toBe(1);
    expect(review.files).toEqual(["/Users/fixture/proj/README.md"]);
    expect(review.errorCount).toBe(1);
    expect(review.lastError?.text).toContain("swift test --filter ReadmeTest");
    // When it failed: its result's time.
    expect(review.lastError?.time).toBe(date("2026-11-02T01:42:03.000Z"));
    expect(review.lastReply?.lines).toEqual(["Fixed the typo; the README test filter matched nothing."]);
    expect(review.firstNewItemID).toBe("m1");
  });

  it("dates an agent waiting on a permission menu", () => {
    const waiting = activity(waitingTranscript, "claude");
    // The Edit waits on the user's answer: no file changed yet, no turn ended.
    expect(waiting.files).toEqual([]);
    expect(waiting.turnsFinished).toBe(0);
    expect(waiting.pendingCallAt).toBe(date("2026-11-02T01:58:00.000Z"));
    const blockedSince = date("2026-11-02T02:00:00.000Z");
    const card = (statusSince: number | null) =>
      buildAwayDigest(oneMac([{ pane: pane("w2:p1", "Tidepool", "claude", "blocked", "/Users/fixture/proj", statusSince), transcript: read(waiting) }]), now).cards[0]!;
    const blocked = card(blockedSince);
    expect(blocked.group).toBe("needsYou");
    expect(blocked.waitingSince).toBe(blockedSince);
    expect(waitingText(blocked, now)).toBe("Waiting 1h 0m");
    expect(blocked.isNew).toBe(true);
    // A server that gives no status time: the call it waits on dates it.
    expect(card(null).waitingSince).toBe(date("2026-11-02T01:58:00.000Z"));
    // Waiting since before the user last looked, and nothing else: not new.
    expect(card(date("2026-11-02T00:30:00.000Z")).isNew).toBe(false);
  });

  it("finds nothing new in a quiet agent", () => {
    const quiet = activity(quietTranscript, "claude");
    expect(quiet).toEqual(awayActivity({ lastActivityAt: date("2026-11-02T00:10:00.000Z") }));
    const digest = buildAwayDigest([{ id: "mini", name: "Mac mini", since, state: { kind: "online" }, panes: [{ pane: pane("w3:p1", "Ops", "claude", "idle"), transcript: read(quiet) }], git: {} }], now);
    expect(digest.cards.map((c) => c.group)).toEqual(["quiet"]);
    expect(digestHasNews(digest)).toBe(false);
    expect(digest.cards[0]!.lastReply).toBeNull();
  });

  it("counts a turn that spans since once, also read from its middle", () => {
    const texts = [
      claudeUser("u1", "Rename the module", "2026-11-02T00:40:00.000Z"),
      claudeTool("a1", "toolu_old", "Edit", { file_path: "/Users/fixture/proj/Old.swift", old_string: "a", new_string: "b" }, "2026-11-02T00:59:00.000Z"),
      claudeResult("u2", "toolu_old", "The file has been updated.", "2026-11-02T00:59:30.000Z"),
      claudeTool("a2", "toolu_new", "Edit", { file_path: "/Users/fixture/proj/New.swift", old_string: "a", new_string: "b" }, "2026-11-02T01:00:30.000Z"),
      claudeResult("u3", "toolu_new", "The file has been updated.", "2026-11-02T01:00:31.000Z"),
      claudeText("a3", "Renamed.", "2026-11-02T01:01:00.000Z", true),
    ];
    const whole = activity(texts, "claude");
    expect(whole.turnsFinished).toBe(1);
    expect(whole.files).toEqual(["/Users/fixture/proj/New.swift"]);
    expect(whole.firstNewItemID).toBe("toolu_new");
    expect(whole.lastReply?.lines).toEqual(["Renamed."]);
    const cut = awayActivityOf(lines(texts).slice(2), "claude", since);
    expect(cut.turnsFinished).toBe(1);
    expect(cut.files).toEqual(["/Users/fixture/proj/New.swift"]);
  });

  it("marks more when the 2 MB cap stopped the read", () => {
    const truncated = activity(devTranscript, "claude", true);
    expect(truncated.truncated).toBe(true);
    const digest = buildAwayDigest(oneMac([{ pane: pane("w7:p1", "Dev", "claude", "done"), transcript: read(truncated) }]), now);
    expect(digest.cards[0]!.more).toBe(true);
    expect(transcriptNote(digest.cards[0]!)).toBe("More happened before this: only the last 2 MB were read.");
    expect(buildAwayDigest(twoMacs(), now).cards.some((card) => card.more)).toBe(false);
  });

  it("counts an API error and never quotes it as the last reply", () => {
    const texts = [
      claudeUser("u1", "Go on", "2026-11-02T01:10:00.000Z"),
      claudeText("a1", "Starting.", "2026-11-02T01:11:00.000Z", false),
      claudeText("a2", "API Error: 529 Overloaded", "2026-11-02T01:12:00.000Z", true, true),
    ];
    const claude = activity(texts, "claude");
    expect(claude.errorCount).toBe(1);
    expect(claude.lastError?.text).toBe("API Error: 529 Overloaded");
    expect(claude.lastReply?.lines).toEqual(["Starting."]);
    const codexError = [
      codex(1, "event_msg", { type: "task_started" }, "2026-11-02T01:10:00.000Z"),
      codex(2, "event_msg", { type: "error", message: "stream disconnected before completion" }, "2026-11-02T01:11:00.000Z"),
    ];
    const codexActivity = activity(codexError, "codex");
    expect(codexActivity.errorCount).toBe(1);
    expect(codexActivity.lastError?.text).toBe("stream disconnected before completion");
  });
});

describe("the digest", () => {
  it("groups and orders two machines' agents", () => {
    const digest = buildAwayDigest(twoMacs(), now);
    expect(digest.cards.map((c) => c.name)).toEqual(["Tidepool", "Review", "Dev", "Bench", "Ops"]);
    expect(digest.cards.map((c) => c.group)).toEqual(["needsYou", "finished", "finished", "working", "quiet"]);
    expect(digest.cards.map((c) => c.macName)).toEqual(["Studio Mac", "Studio Mac", "Studio Mac", "Mac mini", "Mac mini"]);
    expect(cardsIn(digest, "finished").map((c) => c.name)).toEqual(["Review", "Dev"]);
    expect(digest.cards.length).toBe(5);
    expect(digestCommitCount(digest)).toBe(1);
    expect(digestHasNews(digest)).toBe(true);
    expect(digestSummaryText(digest)).toBe("5 agents: 1 needs you, 2 finished, 1 commit");
    // Only Dev's folder has commits; the waiting agent's is no repository.
    expect(digest.cards.find((c) => c.name === "Review")?.commitCount).toBe(1);
    expect(digest.cards.find((c) => c.name === "Tidepool")?.commitCount).toBe(0);
    expect(digest.cards.find((c) => c.name === "Bench")?.lastActivityAt).toBe(date("2026-11-02T02:50:00.000Z"));
    expect(digest.macs.map((m) => m.name)).toEqual(["Studio Mac", "Mac mini"]);
    expect(digest.macs.map((m) => macLineText(m, now, "UTC")).filter((t) => t !== null)).toEqual([]);
  });

  it("orders Needs you by the longest wait, Finished by the newest, Still working by activity", () => {
    const early = date("2026-11-02T01:30:00.000Z");
    const late = date("2026-11-02T02:30:00.000Z");
    const digest = buildAwayDigest(
      oneMac([
        { pane: pane("p1", "A", "claude", "blocked", "/Users/fixture/proj", late), transcript: { kind: "noTranscript" } },
        { pane: pane("p2", "B", "claude", "blocked", "/Users/fixture/proj", early), transcript: { kind: "noTranscript" } },
        { pane: pane("p3", "C", "claude", "idle"), transcript: read(awayActivity({ turnsFinished: 1, lastTurnEndedAt: early, lastActivityAt: early })) },
        { pane: pane("p4", "D", "claude", "done"), transcript: read(awayActivity({ turnsFinished: 1, lastTurnEndedAt: late, lastActivityAt: late })) },
        { pane: pane("p5", "E", "codex", "working"), transcript: read(awayActivity({ lastActivityAt: early })) },
        { pane: pane("p6", "F", "codex", "working"), transcript: read(awayActivity({ lastActivityAt: late })) },
        { pane: pane("p7", "G", "grok", "idle"), transcript: { kind: "noTranscript" } },
      ]),
      now,
    );
    expect(digest.cards.map((c) => c.name)).toEqual(["B", "A", "D", "C", "F", "E", "G"]);
    const grok = digest.cards.find((c) => c.name === "G")!;
    expect(grok.transcript).toBe("noTranscript");
    expect(transcriptNote(grok)).toBe("No transcript to read for this agent: its status only.");
  });

  it("shows an offline machine's line", () => {
    const offline = { id: "mini", name: "Mac mini", state: { kind: "offline", since: date("2026-11-02T03:10:00.000Z") } } as const;
    expect(macLineText(offline, date("2026-11-02T05:00:00.000Z"), "UTC")).toBe("Mac mini: offline since 03:10");
    expect(macLineText(offline, date("2026-11-03T05:00:00.000Z"), "UTC")).toBe("Mac mini: offline since 2 Nov 03:10");
    expect(macLineText({ id: "x", name: "Mac mini", state: { kind: "offline", since: null } }, now, "UTC")).toBe("Mac mini: offline");
    expect(macLineText({ id: "x", name: "Laptop", state: { kind: "notConnected", since: date("2026-11-02T00:05:00.000Z") } }, now, "UTC")).toBe(
      "Laptop: not connected since 00:05",
    );
    expect(macLineText({ id: "x", name: "Studio Mac", state: { kind: "online" } }, now, "UTC")).toBeNull();

    const macs = twoMacs();
    macs[1] = { id: "mini", name: "Mac mini", since, state: { kind: "offline", since: date("2026-11-02T03:10:00.000Z") }, panes: [], git: {} };
    const digest = buildAwayDigest(macs, now);
    expect(digest.cards.map((c) => c.macName)).toEqual(["Studio Mac", "Studio Mac", "Studio Mac"]);
    expect(digest.macs.map((m) => macLineText(m, now, "UTC")).filter((t) => t !== null)).toEqual(["Mac mini: offline since 03:10"]);
  });

  it("counts commits once per machine and shows five", () => {
    const commits: AwayCommit[] = Array.from({ length: 7 }, (_, index) => ({
      hash: String(index).repeat(40),
      subject: `Commit ${index}`,
      time: date(`2026-11-02T01:1${index}:00.000Z`),
    }));
    const digest = buildAwayDigest(
      oneMac(
        [
          { pane: pane("p1", "One", "claude", "idle"), transcript: read(awayActivity()) },
          { pane: pane("p2", "Two", "codex", "idle"), transcript: read(awayActivity()) },
        ],
        { "/Users/fixture/proj": { kind: "commits", commits } },
      ),
      now,
    );
    // Two agents in one folder: each card shows the folder's commits (newest first, five), the summary counts them once.
    expect(digest.cards[0]!.commitCount).toBe(7);
    expect(digest.cards[0]!.commits.map((c) => c.subject)).toEqual(["Commit 6", "Commit 5", "Commit 4", "Commit 3", "Commit 2"]);
    expect(digestCommitCount(digest)).toBe(7);
    expect(digest.cards.map((c) => c.group)).toEqual(["finished", "finished"]);
    expect(digestSummaryText(digest)).toBe("2 agents: 2 finished, 7 commits");
  });

  it("counts each commit once across worktrees of one repository (70, not 520)", () => {
    // Ten agents, each in its own worktree of one repository: 50 commits they share since `since`, and 2 of each worktree's own.
    const hash = (n: number): string => n.toString(16).padStart(40, "0");
    const shared: AwayCommit[] = Array.from({ length: 50 }, (_, i) => ({ hash: hash(1_000 + i), subject: `Shared ${i}`, time: since + 60 + i }));
    const git: Record<string, AwayGitResult> = {};
    const panes: AwayPaneInput[] = [];
    for (let w = 0; w < 10; w += 1) {
      const folder = `/Users/fixture/worktrees/r1-${w}`;
      const own: AwayCommit[] = [0, 1].map((i) => ({ hash: hash(5_000 + w * 10 + i), subject: `Own ${w}.${i}`, time: since + 600 + w * 10 + i }));
      git[folder] = { kind: "commits", commits: [...own, ...shared] };
      panes.push({ pane: pane(`w1:p${w}`, `agent-${w}`, "claude", "done", folder), transcript: read(awayActivity()) });
    }
    const digest = buildAwayDigest(oneMac(panes, git), now);
    // Each card still counts its own folder's commits.
    expect(digest.cards.every((card) => card.commitCount === 52)).toBe(true);
    expect(digestCommitCount(digest)).toBe(70);
    expect(digestSummaryText(digest)).toBe("10 agents: 10 finished, 70 commits");
    // The same hashes on another machine are that machine's own commits.
    const twin = buildAwayDigest([...oneMac(panes, git), { ...oneMac(panes, git)[0]!, id: "mini", name: "Mac mini" }], now);
    expect(digestCommitCount(twin)).toBe(140);
  });

  it("shows five files with their count", () => {
    const texts = [claudeUser("u0", "Touch them all", "2026-11-02T01:01:00.000Z")];
    for (let index = 0; index < 7; index += 1) {
      texts.push(claudeTool(`a${index}`, `toolu_${index}`, "Write", { file_path: `/p/File${index}.swift`, content: "x" }, `2026-11-02T01:0${index + 2}:00.000Z`));
      texts.push(claudeResult(`r${index}`, `toolu_${index}`, "ok", `2026-11-02T01:0${index + 2}:01.000Z`));
    }
    // The same file twice counts once.
    texts.push(claudeTool("a9", "toolu_9", "Edit", { file_path: "/p/File0.swift", old_string: "x", new_string: "y" }, "2026-11-02T01:20:00.000Z"));
    texts.push(claudeResult("r9", "toolu_9", "ok", "2026-11-02T01:20:01.000Z"));
    const touched = activity(texts, "claude");
    expect(touched.files.length).toBe(7);
    const card = buildAwayDigest(oneMac([{ pane: pane("p1", "One", "claude", "idle"), transcript: read(touched) }]), now).cards[0]!;
    expect(card.fileCount).toBe(7);
    expect(card.files).toEqual(["/p/File0.swift", "/p/File1.swift", "/p/File2.swift", "/p/File3.swift", "/p/File4.swift"]);
    expect(card.group).toBe("finished");
    expect(cardStats(card)).toBe("7 files changed");
  });

  it("takes the panes through the sidebar's model, folded and searched or not", () => {
    const input: SidebarInput = {
      macID: "studio",
      workspaces: [{ id: "w1", label: "App", number: 1 }],
      tabs: [
        { id: "t1", workspaceID: "w1", label: "Dev", number: 1 },
        { id: "t2", workspaceID: "w1", label: "", number: 2 },
      ],
      panes: [
        { paneID: "p1", tabID: "t1", workspaceID: "w1", cwd: "/a", agentKind: "claude", status: "done", statusSinceUnixMs: 1_000 },
        { paneID: "p2", tabID: "t2", workspaceID: "w1", cwd: "/b", label: "Reviewer", agentKind: "codex", status: "blocked", statusSinceUnixMs: 2_000 },
        { paneID: "p3", tabID: "t2", workspaceID: "w1", cwd: "/c", status: "absent" },
      ],
      // Folded and searched in the sidebar: the digest still sees every agent.
      fold: { ...emptyFoldState, mode: "priority", foldedWorkspaces: { studio: ["w1"] }, foldedPrioritySections: ["needsYou", "working", "done", "idle"] },
      search: "nothing matches this",
      nowUnixMs: 10_000,
    };
    const session = { ref: makeSessionRef("claude", { kind: "id", id: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f" })!, source: "herdr:claude" as const, paneFolders: ["/a"] };
    const panes = awayPanes(input, { p1: session });
    expect(panes.map((p) => p.paneID).sort()).toEqual(["p1", "p2"]);
    const dev = panes.find((p) => p.paneID === "p1")!;
    expect(dev.name).toBe("Dev");
    expect(dev.kind).toBe("claude");
    expect(dev.folder).toBe("/a");
    expect(dev.session).toBe(session);
    expect(dev.statusSince).toBe(1);
    const reviewer = panes.find((p) => p.paneID === "p2")!;
    expect(reviewer.name).toBe("Reviewer");
    expect(reviewer.status).toBe("blocked");
    expect(reviewer.session).toBeNull();
  });
});

describe("a turn finishes only on the agent's end of turn", () => {
  it("does not count a queued message as a finished turn", () => {
    const texts = [
      user('<pasted_content id="p">start</pasted_content>', "queue-u", 0),
      tool("queue-tool", "swift test", "queue-t", 1),
      queued('<pasted_content id="q">also the phone</pasted_content>', "queue-q", "queue-src", 2),
      result("queue-tool", "passed", "queue-r", 3),
      reply("Done.", "queue-a", 4, true),
    ];
    const run = activity(texts, "claude");
    expect(run.turnsFinished).toBe(1);
    expect(run.lastTurnEndedAt).toBe(date("2026-11-02T05:00:04.000Z"));
  });

  it("does not count queued messages and their user lines", () => {
    const texts = [
      user("Run the tests", "q-u1", 0),
      tool("q-tool", "swift test", "q-t", 1),
      reply("Running them.", "q-a1", 2),
      queued("and the UI tests", "q-q1", "q-src1", 3),
      queued("then commit", "q-q2", "q-src2", 4),
      user("and the UI tests", "q-src1", 5),
      result("q-tool", "passed", "q-r", 6),
    ];
    expect(activity(texts, "claude").turnsFinished).toBe(0);
    texts.push(reply("All green; committed.", "q-a2", 9, true));
    expect(activity(texts, "claude").turnsFinished).toBe(1);
  });

  it("counts a Codex turn with a message sent during it once, at task_complete", () => {
    const texts = [
      codex(1, "event_msg", { type: "task_started", turn_id: "turn-a" }, "2026-11-02T05:00:01.000Z"),
      codex(2, "response_item", { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "Run the tests" }] }, "2026-11-02T05:00:01.100Z"),
      codex(3, "response_item", { type: "message", role: "assistant", id: "m2", content: [{ type: "output_text", text: "Running them." }] }, "2026-11-02T05:00:02.000Z"),
      codex(4, "response_item", { type: "message", role: "user", id: "m3", content: [{ type: "input_text", text: "and the UI tests after" }] }, "2026-11-02T05:00:05.000Z"),
      codex(5, "response_item", { type: "message", role: "assistant", id: "m4", content: [{ type: "output_text", text: "Both pass." }] }, "2026-11-02T05:00:10.000Z"),
      codex(6, "event_msg", { type: "task_complete", duration_ms: 9000, turn_id: "turn-a" }, "2026-11-02T05:00:11.000Z"),
    ];
    expect(activity(texts, "codex").turnsFinished).toBe(1);
    expect(activity(texts.slice(0, -1), "codex").turnsFinished).toBe(0);
  });

  it("does not count an interrupted turn", () => {
    const texts = [
      claudeUser("i-u1", "Refactor the store", "2026-11-02T01:10:00.000Z"),
      claudeText("i-a1", "Starting with the cache.", "2026-11-02T01:11:00.000Z", false),
      claudeUser("i-u2", "[Request interrupted by user]", "2026-11-02T01:12:00.000Z"),
      claudeUser("i-u3", "Just the cache, please", "2026-11-02T01:13:00.000Z"),
      claudeText("i-a2", "Done with the cache.", "2026-11-02T01:20:00.000Z", true),
    ];
    const run = activity(texts, "claude");
    expect(run.turnsFinished).toBe(1);
    expect(run.lastTurnEndedAt).toBe(date("2026-11-02T01:20:00.000Z"));
  });
});

describe("tool results crossing since", () => {
  it("counts an edit and a failure invoked before since and landed after it, once", () => {
    const texts = [
      claudeUser("cross-u", "Edit then test", "2026-11-02T00:58:00.000Z"),
      claudeTool("cross-e", "cross-edit", "Edit", { file_path: "/Users/fixture/proj/Crossing.swift", old_string: "a", new_string: "b" }, "2026-11-02T00:59:00.000Z"),
      claudeTool("cross-b", "cross-bash", "Bash", { command: "swift test" }, "2026-11-02T00:59:30.000Z"),
      claudeResult("cross-er", "cross-edit", "updated", "2026-11-02T01:01:00.000Z"),
      claudeResult("cross-br", "cross-bash", "Exit code 1", "2026-11-02T01:02:00.000Z", true),
      claudeText("cross-a", "The edit went in; the tests fail.", "2026-11-02T01:03:00.000Z", true),
    ];
    const crossing = activity(texts, "claude");
    expect(crossing.files).toEqual(["/Users/fixture/proj/Crossing.swift"]);
    expect(crossing.errorCount).toBe(1);
    expect(crossing.lastError?.time).toBe(date("2026-11-02T01:02:00.000Z"));
    expect(crossing.firstNewItemID).toBe("cross-edit");
    expect(crossing.turnsFinished).toBe(1);
    const before = awayActivityOf(lines(texts), "claude", date("2026-11-02T01:02:30.000Z"));
    expect(before.files).toEqual([]);
    expect(before.errorCount).toBe(0);
    const between = awayActivityOf(lines(texts), "claude", date("2026-11-02T01:01:30.000Z"));
    expect(between.files).toEqual([]);
    expect(between.errorCount).toBe(1);
    const edited = awayActivityOf(lines(texts), "claude", date("2026-11-02T01:00:30.000Z"));
    expect(edited.files).toEqual(["/Users/fixture/proj/Crossing.swift"]);
    expect(edited.errorCount).toBe(1);
  });
});

describe("progress updates and pasted messages", () => {
  it("quotes the reply, not an update", () => {
    const texts = [user("Go", "p-u", 0), progress("Looking at the store first", "p-p", 1), reply("The store is fixed.", "p-a", 2, true)];
    expect(activity(texts, "claude").lastReply?.lines).toEqual(["The store is fixed."]);
    const after = [...texts.slice(0, 3), progress("an update after the reply", "p-p2", 3)];
    expect(activity(after, "claude").lastReply?.lines).toEqual(["The store is fixed."]);
    const alone = activity([user("Go", "p-u", 0), progress("only an update", "p-p", 1)], "claude");
    expect(alone.turnsFinished).toBe(0);
    expect(alone.lastReply).toBeNull();
  });

  it("reads a paste closed with its id as one turn and no tags", () => {
    const run = activity([user(tonight, "wrap-u", 0), reply("It is the Mac build.", "wrap-a", 4, true)], "claude");
    expect(run.turnsFinished).toBe(1);
    expect(run.lastReply?.lines).toEqual(["It is the Mac build."]);
    expect(JSON.stringify(run)).not.toContain("pasted_content");
  });
});

describe("the card's words", () => {
  it("says how long ago and what happened", () => {
    expect(agoText(now - 30, now)).toBe("just now");
    expect(agoText(now - 47 * 60 - 57, now)).toBe("47m ago");
    expect(agoText(now - (3600 + 52 * 60), now)).toBe("1h 52m ago");
    expect(replyLine("- a list item")).toBe("• a list item");
    expect(replyLine("## A heading")).toBe("A heading");
    const card = buildAwayDigest(twoMacs(), now).cards.find((c) => c.name === "Dev")!;
    expect(cardStats(card)).toBe("2 turns finished · 2 files changed · 1 commit · 1 error");
  });
});
