// Grok's updates.jsonl in Chat, the desktop twin of HerdrKit's
// GrokSessionParserTests and GrokSessionLocatorTests. The fixture
// (desktop/fixtures/chat/grok-session.jsonl) is shared with the Swift tests.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { ChatFeed, standardColdLoad } from "../src/shared/chat/feed";
import {
  grokAmbiguousNote,
  grokFolderName,
  grokFolderShared,
  grokSummaryCwd,
  locateCommand,
  makeSessionRef,
  parseLocateOutput,
  sessionForPane,
  sessionFromArgv,
  sessionRefFromAgentSession,
  type TranscriptSessionRef,
} from "../src/shared/chat/locator";
import { diffCountsText, turnFooter, turnToolCalls, turnUserMessage, workedForText, type ChatTimeline, type ChatTurn } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptParseStats } from "../src/shared/chat/parser";
import { resumeCommand } from "../src/shared/pane-life";
import { FakeTranscriptReader } from "./support/chat-lines";
import { fixturesRoot } from "./support/swift-fixtures";

const fixture = readFileSync(path.join(fixturesRoot, "chat/grok-session.jsonl"), "utf8");
const sessionID = "01a19e72-280e-7291-9d2d-8c2ac0bdb217";
const grokPath = `/Users/fixture/.grok/sessions/%2FUsers%2Ffixture%2Fproj/${sessionID}/updates.jsonl`;
const grokSession: TranscriptSessionRef = makeSessionRef("grok", { kind: "id", id: sessionID })!;
/** The session's summary.json, which names its folder (info.cwd). */
const grokSummary = (reader: FakeTranscriptReader): void =>
  reader.put(grokPath.replace(/updates\.jsonl$/, "summary.json"), JSON.stringify({ info: { cwd: "/Users/fixture/proj" } }), null);

/** Line by line with offsets, as the feed reads it. */
function timeline(text: string): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("grok");
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of text.split("\n")) {
    const at = offset;
    offset += new TextEncoder().encode(line).length + 1;
    if (line === "") continue;
    builder.apply(parser.parse(line, at).events, at);
  }
  return { timeline: builder.timeline, stats: parser.stats };
}

const texts = (turn: ChatTurn | undefined): string[] =>
  (turn?.items ?? []).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));

async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return condition();
}

describe("grok session: the whole fixture", () => {
  it("builds four turns and counts every line", () => {
    const { timeline: built, stats } = timeline(fixture);
    expect(stats.lines).toBe(61);
    expect(stats.malformed).toBe(2);
    expect(Object.fromEntries(stats.unknownTypes)).toEqual({ future_kind: 1 });
    for (const noise of ["hook_execution", "hook_annotation", "background_tasks", "session_recap", "retry_state", "image_compressed",
      "auto_compact_started", "compaction_checkpoint", "memory_dream_queued", "memory_dream_started", "memory_dream_completed"]) {
      expect(stats.skippedTypes.has(noise), noise).toBe(true);
    }
    const users = built.turns.map(turnUserMessage).flatMap((message) => (message === null ? [] : [message.text]));
    expect(users).toEqual(["Read the README, fix the typo and run the tests", "What is wrong here? Then build in the background.", "Now rewrite the whole README"]);
    expect(built.turns).toHaveLength(4);
    expect(built.turns.every((turn) => turn.isFinished)).toBe(true);
  });

  it("shows the thinking, the tools and the reply joined from its parts", () => {
    const turn = timeline(fixture).timeline.turns[0]!;
    const thought = turn.items[1]!;
    expect(thought.type).toBe("progress");
    expect(thought.type === "progress" ? thought.value.markdown : null).toBe("Looking at the README first. Then the tests.");
    expect(texts(turn)).toEqual(["I fixed the typo and the tests **fail** on a filter."]);
    const calls = turnToolCalls(turn);
    expect(calls.map((call) => call.kind)).toEqual(["read", "edit", "edit", "bash", "search", "web", "web", "plan", { other: "List folder" }]);
    expect(calls.map((call) => call.state)).toEqual(["ok", "ok", "ok", "failed", "ok", "ok", "ok", "ok", "failed"]);
    expect(calls[0]!.target).toBe("/Users/fixture/proj/README.md");
    expect(calls[0]!.resultSummary).toBe("3 lines");
    expect(calls[3]!.target).toBe("swift test --filter ReadmeTest");
    expect(calls[4]!.target).toBe("smal");
    expect(calls[5]!.target).toBe("https://example.com/style-guide");
    expect(calls[8]!.target).toBe("/Users/fixture/proj/grok-notes");
    const footer = turnFooter(turn);
    expect(footer === null ? null : workedForText(footer)).toBe("Worked for 1m 35s");
  });

  it("carries an edit's diff, a write's new lines, a failed tool's words and one plan row", () => {
    const calls = turnToolCalls(timeline(fixture).timeline.turns[0]!);
    const edit = calls[1]!.detail;
    const write = calls[2]!.detail;
    if (edit.type !== "diff" || write.type !== "diff") throw new Error(`${edit.type} ${write.type}`);
    expect(edit.diff.files).toEqual(["/Users/fixture/proj/README.md"]);
    expect([edit.diff.added, edit.diff.removed]).toEqual([1, 1]);
    expect(edit.diff.lines.filter((line) => line.kind === "added").map((line) => line.text)).toEqual(["A small tool."]);
    expect(edit.diff.lines.filter((line) => line.kind === "removed").map((line) => line.text)).toEqual(["A smal tool."]);
    expect([write.diff.added, write.diff.removed]).toEqual([2, 0]);
    expect(calls[1]!.resultSummary).toBe(diffCountsText(edit.diff));
    const bash = calls[3]!.detail;
    expect(bash.type === "bash" ? bash.bash.outputTail[0] : null).toBe("error: no tests matched 'ReadmeTest'");
    const plans = calls.filter((call) => call.kind === "plan");
    expect(plans).toHaveLength(1);
    const plan = plans[0]!.detail;
    if (plan.type !== "plan") throw new Error(plan.type);
    expect(plan.steps.map((step) => step.text)).toEqual(["Fix the README typo", "Run the tests"]);
    expect(plan.steps.map((step) => step.status)).toEqual(["completed", "inProgress"]);
  });

  it("makes the user's picture an attachment and never parses its bytes", () => {
    const message = turnUserMessage(timeline(fixture).timeline.turns[1]!);
    expect(message?.attachments.map((value) => value.mediaType)).toEqual(["image/png"]);
    const data = "QUJD".repeat(250_000);
    const line = `{"timestamp":1793502000000,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"image","data":"${data}","mimeType":"image/jpeg","uri":"file:///x.jpg","_meta":{"xai.dev/imageDisplayNumber":1}},"_meta":{"promptIndex":4}},"_meta":{"eventId":"e","agentTimestampMs":1793502000000}}}`;
    const parser = new TranscriptParser("grok");
    const event = parser.parse(line, 0).events[0];
    expect(event?.type).toBe("userMessage");
    expect(event?.type === "userMessage" ? event.message.attachments.map((value) => value.mediaType) : null).toEqual(["image/jpeg"]);
    expect(parser.stats.parsedChars).toBeLessThan(1_000);
  });

  it("runs a background command until its task completes", () => {
    const lines = fixture.split("\n");
    const cut = lines.findIndex((line) => line.includes('"task_completed"'));
    const before = timeline(lines.slice(0, cut).join("\n")).timeline;
    const build = turnToolCalls(before.turns[1]!)[0]!;
    expect(build.target).toBe("swift build");
    expect(build.state).toBe("running");
    const after = timeline(fixture).timeline;
    const done = turnToolCalls(after.turns[1]!)[0]!;
    expect(done.state).toBe("ok");
    if (done.detail.type !== "bash") throw new Error(done.detail.type);
    expect(done.detail.bash.exitCode).toBe(0);
    expect(done.detail.bash.outputTail.at(-1)).toBe("Build complete!");
    expect(texts(after.turns[1])).toEqual(["The picture shows a cut-off label. The build runs in the background."]);
  });

  it("makes compaction the compaction row and a stop interrupted", () => {
    const built = timeline(fixture).timeline;
    const first = built.turns[2]!.items[0]!;
    expect(first.type === "notice" ? first.value.kind : null).toBe("compacted");
    const last = built.turns.at(-1)!;
    expect(texts(last)).toEqual(["Starting on"]);
    expect(last.items.some((item) => item.type === "notice" && item.value.kind === "interrupted")).toBe(true);
    expect(last.isFinished).toBe(true);
  });

  it("gives the same line read twice the same ids", () => {
    const line = '{"timestamp":1,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}},"_meta":{}}}';
    expect(new TranscriptParser("grok").parse(line, 900).events).toEqual(new TranscriptParser("grok").parse(line, 900).events);
  });
});

/** Turns of: the user's prompt, thinking in parts, a 30 KB file read, the reply in parts, the end. */
function bigSession(turns: number): string {
  const file = "let value = compute(input)\n".repeat(1_200).slice(0, 30_000).split("\n").join("\\n");
  const lines: string[] = [];
  let at = 1_793_502_000_000;
  const line = (update: string): void => {
    at += 100;
    lines.push(`{"timestamp":${at},"method":"session/update","params":{"sessionId":"s","update":${update},"_meta":{"eventId":"e${at}","agentTimestampMs":${at}}}}`);
  };
  for (let index = 0; index < turns; index += 1) {
    line(`{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Step ${index}"},"_meta":{"promptIndex":${index}}}`);
    for (let part = 0; part < 4; part += 1) line(`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking ${part} "}}`);
    line(`{"sessionUpdate":"tool_call","toolCallId":"read-${index}","title":"read_file","rawInput":{"target_file":"/p/f${index}.swift"},"_meta":{"x.ai/tool":{"version":1,"name":"read_file","kind":"read","namespace":"grok_build","label":"Read","read_only":true}}}`);
    line(`{"sessionUpdate":"tool_call_update","toolCallId":"read-${index}","status":"completed","content":[{"type":"content","content":{"type":"text","text":"${file}"}}]}`);
    for (const part of ["Done", " with step", ` ${index}.`]) line(`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"${part}"}}`);
    line(`{"sessionUpdate":"turn_completed","prompt_id":"p${index}","stop_reason":"end_turn","elapsed_ms":2000}`);
  }
  return lines.join("\n") + "\n";
}

describe("grok session: budgets and the follower", () => {
  it("loads a 4 MB session cold within the window", async () => {
    const text = bigSession(120);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(4_000_000);
    const reader = new FakeTranscriptReader();
    reader.put(grokPath, text, grokPath);
    grokSummary(reader);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    feed.start(grokSession);
    expect(await feed.loaded()).toBe(true);
    expect(feed.bytesRead).toBeLessThanOrEqual(standardColdLoad.window * 2);
    expect(feed.timeline.turns.length).toBeGreaterThanOrEqual(standardColdLoad.turns);
    expect(texts(feed.timeline.turns.at(-1))).toEqual(["Done with step 119."]);
    expect(feed.timeline.earlier).toBe("available");
    feed.stop();
  });

  it("streams the reply as the file grows; a partial line waits", async () => {
    const reader = new FakeTranscriptReader();
    const prompt = '{"timestamp":1793502000000,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Go"},"_meta":{"promptIndex":0}},"_meta":{}}}\n';
    reader.put(grokPath, prompt, grokPath);
    grokSummary(reader);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(grokSession);
    await feed.loaded();
    const part = (text: string, at: number): string =>
      `{"timestamp":${1793502001000 + at},"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"${text}"}},"_meta":{"chunkId":${at}}}}`;
    reader.append(grokPath, part("First", 0) + "\n");
    expect(await eventually(() => JSON.stringify(texts(feed.timeline.turns.at(-1))) === '["First"]')).toBe(true);
    const second = new TextEncoder().encode(part(" and second", 1));
    const half = Math.floor(second.length / 2);
    reader.appendBytes(grokPath, second.slice(0, half));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(texts(feed.timeline.turns.at(-1))).toEqual(["First"]);
    reader.appendBytes(grokPath, second.slice(half));
    reader.append(grokPath, "\n");
    expect(await eventually(() => JSON.stringify(texts(feed.timeline.turns.at(-1))) === '["First and second"]')).toBe(true);
    expect(feed.state.status).toBe("live");
    feed.stop();
  });
});

describe("grok session: which session is the pane's", () => {
  it("reads -r, --resume and --resume= and refuses a title", () => {
    for (const argv of [["grok", "-r", sessionID], ["grok", "--resume", sessionID], ["grok", `--resume=${sessionID}`]]) {
      expect(sessionFromArgv(argv, "grok"), argv.join(" ")).toEqual({ source: "herdr:grok", agent: "grok", kind: "id", value: sessionID });
    }
    expect(sessionFromArgv(["grok", "--resume", "refactoring"], "grok")).toBeNull();
    expect(sessionFromArgv(["grok"], "grok")).toBeNull();
  });

  it("takes Herdr's session, else the pane's folder", () => {
    const named = sessionRefFromAgentSession({ source: "herdr:grok", agent: "grok", kind: "id", value: sessionID });
    expect(named?.format).toBe("grok");
    expect(sessionRefFromAgentSession({ source: "herdr:grok", agent: "grok", kind: "id", value: "a title" })).toBeNull();
    const session = sessionForPane({ agent: "grok", cwd: "/Users/fixture/my proj" });
    expect(session?.ref).toEqual({ format: "grok", lookup: { kind: "folder", folder: "/Users/fixture/my proj" } });
    expect(sessionForPane({ agent: "codex", cwd: "/Users/fixture/proj" })).toBeNull();
  });

  it("looks in the folder Grok files the sessions in, checks summary.json and parses only its own paths", () => {
    expect(grokFolderName("/Users/fixture/my proj/")).toBe("%2FUsers%2Ffixture%2Fmy%20proj");
    expect(grokFolderName("/a/b-c_d.e~f")).toBe("%2Fa%2Fb-c_d.e~f");
    expect(grokSummaryCwd('/a/"q"')).toEqual(['"cwd":"/a/\\"q\\""', '"cwd": "/a/\\"q\\""']);
    const ref = makeSessionRef("grok", { kind: "folder", folder: "/Users/fixture/proj" })!;
    const command = locateCommand(ref)!;
    expect(command).toContain("%2FUsers%2Ffixture%2Fproj");
    expect(command).toContain("summary.json");
    expect(command).toContain("grep -qsF");
    expect(parseLocateOutput(grokPath + "\n", ref)).toBe(grokPath);
    expect(parseLocateOutput(`/Users/fixture/.grok/sessions/%2Fother/${sessionID}/updates.jsonl\n`, ref)).toBeNull();
    expect(parseLocateOutput(`/Users/fixture/.grok/sessions/%2FUsers%2Ffixture%2Fproj/not-an-id/updates.jsonl\n`, ref)).toBeNull();
    const byID = locateCommand(grokSession)!;
    expect(byID).toContain(".grok");
    expect(parseLocateOutput(grokPath + "\n", grokSession)).toBe(grokPath);
  });

  it("refuses two Grok panes in one folder that name no session", () => {
    const session = sessionForPane({ agent: "grok", cwd: "/Users/fixture/proj" })!;
    const peers = [
      { paneID: "p1", agent: "grok", cwd: "/Users/fixture/proj" },
      { paneID: "p2", agent: "grok", cwd: "/Users/fixture/proj/" },
    ];
    expect(grokFolderShared(session, "p1", peers)).toBe(true);
    expect(grokFolderShared(session, "p1", [peers[0]!, { ...peers[1]!, cwd: "/Users/fixture/other" }])).toBe(false);
    expect(grokFolderShared(session, "p1", [peers[0]!, { ...peers[1]!, agent: "claude" }])).toBe(false);
    const named = { ...peers[1]!, agentSession: { source: "herdr:grok", agent: "grok", kind: "id", value: sessionID } };
    expect(grokFolderShared(session, "p1", [peers[0]!, named])).toBe(false);
    expect(grokAmbiguousNote).toBe("Two Grok sessions are open in this folder, so Chat can't tell which is this pane's");
  });

  it("offers grok --resume <id> on the Resume chip", () => {
    const memory = { kind: "grok", title: "Grok", terminalID: "t", session: { source: "herdr:grok", agent: "grok", kind: "id", value: sessionID } };
    const absent = { status: { type: "absent" }, commands: {}, refused: {} } as const;
    expect(resumeCommand(memory as never, absent as never)).toBe(`grok --resume ${sessionID}`);
    const byPath = { ...memory, session: { source: "herdr:grok", agent: "grok", kind: "path", value: grokPath } };
    expect(resumeCommand(byPath as never, absent as never)).toBe(`grok --resume ${sessionID}`);
  });
});

describe("grok session: the demo capture", () => {
  it("is step 51, after the needs-you card's 45-50 and before update-ready's 52 and the live row's 53-54, on the demo's Grok pane in Chat", async () => {
    const { demoCaptureSteps, grokCaptureSteps, liveRowCaptureSteps, needsCardCaptureSteps, sendCaptureSteps, updateMarkCaptureSteps } = await import("../src/main/capture");
    const { demoHostIds } = await import("../src/main/demo/demo-hosts");
    // main.ts's order (merge pass 2): the demo's, the send's (41-44), needs-card (45-50), this (51), update-ready (52), the live row (53-54).
    const all = [
      ...demoCaptureSteps(demoHostIds),
      ...sendCaptureSteps(demoHostIds),
      ...needsCardCaptureSteps(demoHostIds),
      ...grokCaptureSteps(demoHostIds),
      ...updateMarkCaptureSteps(demoHostIds),
      ...liveRowCaptureSteps(demoHostIds),
    ];
    const numbers = all.map((step) => Number(/^(\d{2})-/.exec(step.name)?.[1]));
    expect(numbers).toEqual(Array.from({ length: 54 }, (_, i) => i + 1));
    const at = all.findIndex((step) => step.name === "51-grok-chat");
    expect(all[at - 1]!.name).toBe("50-needs-card-gone-sidebar");
    expect(all[at + 1]!.name).toBe("52-update-ready");
    const grok = grokCaptureSteps(demoHostIds);
    expect(grok.map((step) => step.name)).toEqual(["51-grok-chat"]);
    expect(grok[0]!.commands).toEqual([
      { type: "select-pane", hostId: demoHostIds.macMini, paneId: "wD:pK" },
      { type: "set-tab", tab: "chat" },
    ]);
  });
});
