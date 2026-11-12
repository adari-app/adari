// A port of HerdrKit's ChatBackgroundTaskTests.swift (the same fixtures): a background Bash call and a Monitor call are tasks: the
// call's row says "running in background" until its finish notice (matched by
// task id or tool-use id; Claude Code writes one notice up to three ways, which
// count once), a TaskStop naming it, or the session ending (a new session in
// the file, the agent gone) ends it, then its outcome; a monitor keeps its
// newest event. The timeline's running list holds what runs (the strip's
// items). Built from Claude Code's recorded line shapes, ids and text
// invented.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import {
  endingRunningTurn,
  endingSession,
  runningWork,
  taskStatusText,
  turnRows,
  turnToolCalls,
  type ChatTimeline,
  type ChatToolCall,
} from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { at, json, reply, session, stamp, timelineOf, user } from "./support/chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

const typedFields: Record<string, JSONValue> = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } };
const typed = (text: string, uuid: string, second: number): string => user(text, uuid, second, typedFields);
const tasks = "/private/tmp/claude-501/-Users-fixture-proj/5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f/tasks";

function assistantTool(id: string, name: string, input: { [key: string]: JSONValue }, uuid: string, second: number, sessionID = session): string {
  return json({
    isSidechain: false,
    sessionId: sessionID,
    timestamp: stamp(second),
    type: "assistant",
    uuid,
    message: { content: [{ id, input, name, type: "tool_use" }], id: "msg_" + uuid, role: "assistant", stop_reason: "tool_use", type: "message" },
  });
}

/** A Bash call with run_in_background (the reference's input keys). */
const bash = (id: string, command: string, description: string, uuid: string, second: number, background: JSONValue = true): string =>
  assistantTool(id, "Bash", { command, description, run_in_background: background, timeout: 600_000 }, uuid, second);
const monitor = (id: string, command: string, description: string, uuid: string, second: number): string =>
  assistantTool(id, "Monitor", { command, description, timeout_ms: 1_800_000 }, uuid, second);
const taskStop = (id: string, taskID: string, uuid: string, second: number): string => assistantTool(id, "TaskStop", { task_id: taskID }, uuid, second);

function toolResult(id: string, text: string, toolUseResult: JSONValue, uuid: string, second: number, isError = false): string {
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    toolUseResult,
    type: "user",
    uuid,
    message: { content: [{ content: text, is_error: isError, tool_use_id: id, type: "tool_result" }], role: "user" },
  });
}

/** A background shell's launch result: its text and toolUseResult's backgroundTaskId. */
const launched = (id: string, taskID: string, uuid: string, second: number, withField = true): string =>
  toolResult(
    id,
    `Command running in background with ID: ${taskID}. Output is being written to: ${tasks}/${taskID}.output. You will be notified when it completes …`,
    withField ? { backgroundTaskId: taskID, interrupted: false, isImage: false, noOutputExpected: false, stderr: "", stdout: "" } : { stdout: "", stderr: "" },
    uuid,
    second,
  );
const monitorStarted = (id: string, taskID: string, uuid: string, second: number, withField = true): string =>
  toolResult(
    id,
    `Monitor started (task ${taskID}, expires in 30m unless the source ends first; events arrive as notifications)`,
    withField ? { persistent: false, taskId: taskID, timeoutMs: 1_800_000 } : {},
    uuid,
    second,
  );

function notice(fields: { task: string; toolUse: string; status?: string; summary?: string; event?: string }): string {
  const parts = ["<task-notification>", `<task-id>${fields.task}</task-id>`, `<tool-use-id>${fields.toolUse}</tool-use-id>`, `<output-file>${tasks}/${fields.task}.output</output-file>`];
  if (fields.status !== undefined) parts.push(`<status>${fields.status}</status>`);
  if (fields.summary !== undefined) parts.push(`<summary>${fields.summary}</summary>`);
  if (fields.event !== undefined) parts.push(`<event>${fields.event}</event>`);
  parts.push("</task-notification>");
  return parts.join("\n");
}

/** Copy 1: a queue-operation line. */
const queueCopy = (text: string, second: number, operation = "enqueue"): string =>
  json({ content: text, operation, sessionId: session, timestamp: stamp(second), type: "queue-operation" });
/** Copy 2: an attachment line holding the same text (a queued command the harness wrote, with its rendered text). */
const attachmentCopy = (text: string, uuid: string, second: number): string =>
  json({
    attachment: { commandMode: "task-notification", prompt: text, rendered: text, renderedRole: "user", type: "queued_command" },
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "attachment",
    uuid,
  });
/** Copy 2, the other way: an attachment of another type whose rendered text is the notice. */
const renderedCopy = (text: string, uuid: string, second: number): string =>
  json({ attachment: { rendered: text, renderedRole: "user", type: "task_notification" }, isSidechain: false, sessionId: session, timestamp: stamp(second), type: "attachment", uuid });
/** Copy 3: a user line the harness wrote. */
const userCopy = (text: string, uuid: string, second: number): string =>
  user(text, uuid, second, {
    origin: { kind: "task-notification", producer: "session-task", runId: "run-1" },
    promptSource: "system",
    turnOrigin: "task-notification",
  });

const calls = (timeline: ChatTimeline): ChatToolCall[] => timeline.turns.flatMap(turnToolCalls);
const callNamed = (timeline: ChatTimeline, id: string): ChatToolCall => calls(timeline).find((call) => call.id === id)!;

const devServer = [
  typed("Start the dev server and keep going", "u1", 0),
  bash("toolu_bg", "npm run dev\n# port 5173", "Start the dev server", "a1", 2),
  launched("toolu_bg", "b7k2q9", "r1", 3),
  reply("The server runs in the background.", "a2", 4, true),
];
const devDone = notice({ task: "b7k2q9", toolUse: "toolu_bg", status: "completed", summary: 'Background command "Start the dev server" completed (exit code 0)' });

describe("a background shell", () => {
  it("runs in the background: its row says so, it stays out of the fold, and the running list has it", () => {
    const { timeline } = timelineOf(devServer);
    const call = callNamed(timeline, "toolu_bg");
    expect(call.task?.kind).toBe("shell");
    expect(call.task?.taskID).toBe("b7k2q9");
    expect(call.task?.description).toBe("Start the dev server");
    expect(call.task?.state).toBe("running");
    expect(call.task?.startedAt).toBe(at(2));
    expect(call.resultSummary).toBe("running in background");
    expect(call.state).toBe("ok");
    // The turn ended while it runs: the row is its own, not a count in "Ran N commands".
    const turn = timeline.turns.at(-1)!;
    expect(turn.isFinished).toBe(true);
    expect(turnRows(turn).some((row) => row.type === "item" && row.item.type === "toolCall" && row.item.value.id === "toolu_bg")).toBe(true);
    expect(turnRows(turn).some((row) => row.type === "folded")).toBe(false);
    expect(runningWork(timeline).map((work) => [work.kind, work.id, work.title, work.detail, work.startedAt])).toEqual([
      ["shell", "toolu_bg", "Start the dev server", "npm run dev\n# port 5173", at(2)],
    ]);
  });

  for (const [name, copy] of [
    ["a queue-operation line", queueCopy(devDone, 60)],
    ["an attachment line", attachmentCopy(devDone, "n2", 60)],
    ["a rendered attachment", renderedCopy(devDone, "n2", 60)],
    ["a user line", userCopy(devDone, "n3", 60)],
  ] as const) {
    it(`ends at its notice written as ${name}, then shows its outcome and folds`, () => {
      const { timeline } = timelineOf([...devServer, copy]);
      const call = callNamed(timeline, "toolu_bg");
      expect(call.task?.state).toBe("done");
      expect(call.task?.finishedAt).toBe(at(60));
      expect(call.resultSummary).toBe("done · 58s");
      expect(runningWork(timeline)).toEqual([]);
      const turn = timeline.turns.at(-1)!;
      expect(turnRows(turn).filter((row) => row.type === "folded").map((row) => (row.type === "folded" ? row.folded.summary : ""))).toEqual(["Ran 1 command"]);
      // A notice is never the user's message, nor a row.
      expect(timeline.turns.flatMap((t) => t.items).filter((item) => item.type === "user").map((item) => item.value.id)).toEqual(["u1"]);
    });
  }

  it("ends once when the notice comes all three ways", () => {
    const { timeline } = timelineOf([...devServer, queueCopy(devDone, 60), attachmentCopy(devDone, "n2", 61), userCopy(devDone, "n3", 62)]);
    const call = callNamed(timeline, "toolu_bg");
    expect(call.task?.state).toBe("done");
    expect(call.task?.finishedAt).toBe(at(60));
    expect(runningWork(timeline)).toEqual([]);
    expect(timeline.turns.flatMap((t) => t.items).map((item) => item.type)).toEqual(["user", "toolCall", "agentText"]);
  });

  it("is matched by its tool-use id when the launch result named no id", () => {
    const lines = [devServer[0]!, devServer[1]!, toolResult("toolu_bg", "Started.", { stdout: "" }, "r1", 3), devServer[3]!];
    let timeline = timelineOf(lines).timeline;
    expect(callNamed(timeline, "toolu_bg").task?.taskID).toBe(null);
    expect(runningWork(timeline).length).toBe(1);
    timeline = timelineOf([...lines, userCopy(devDone, "n3", 60)]).timeline;
    expect(callNamed(timeline, "toolu_bg").task?.state).toBe("done");
  });

  it("takes its id from the result text when toolUseResult has none", () => {
    const { timeline } = timelineOf([devServer[0]!, devServer[1]!, launched("toolu_bg", "b7k2q9", "r1", 3, false), queueCopy(devDone, 60)]);
    expect(callNamed(timeline, "toolu_bg").task?.taskID).toBe("b7k2q9");
    expect(callNamed(timeline, "toolu_bg").task?.state).toBe("done");
  });

  it("says failed with its exit code, or killed", () => {
    const failed = notice({ task: "b7k2q9", toolUse: "toolu_bg", status: "failed", summary: 'Background command "Start the dev server" failed with exit code 1' });
    let timeline = timelineOf([...devServer, userCopy(failed, "n3", 6)]).timeline;
    let call = callNamed(timeline, "toolu_bg");
    expect(call.task?.state).toBe("failed");
    expect(call.task?.exitCode).toBe(1);
    expect(call.state).toBe("failed");
    expect(call.resultSummary).toBe("exit 1 · 4s");
    const killed = notice({ task: "b7k2q9", toolUse: "toolu_bg", status: "killed", summary: 'Background command "Start the dev server" was killed' });
    timeline = timelineOf([...devServer, queueCopy(killed, 64)]).timeline;
    call = callNamed(timeline, "toolu_bg");
    expect(call.task?.state).toBe("killed");
    expect(call.resultSummary).toBe("killed · 1m 2s");
    expect(runningWork(timeline)).toEqual([]);
  });

  it("is stopped by a TaskStop naming it", () => {
    const { timeline } = timelineOf([...devServer, typed("Stop the server", "u2", 30), taskStop("toolu_stop", "b7k2q9", "a3", 31), reply("Stopped.", "a4", 33, true)]);
    const call = callNamed(timeline, "toolu_bg");
    expect(call.task?.state).toBe("stopped");
    expect(call.task?.finishedAt).toBe(at(31));
    expect(call.resultSummary).toBe("stopped");
    expect(runningWork(timeline)).toEqual([]);
    // A later notice of its end changes nothing.
    const later = timelineOf([...devServer, taskStop("toolu_stop", "b7k2q9", "a3", 31), userCopy(notice({ task: "b7k2q9", toolUse: "toolu_bg", status: "killed" }), "n3", 32)]).timeline;
    expect(callNamed(later, "toolu_bg").task?.state).toBe("stopped");
  });

  it("is stopped when a new session starts in the file", () => {
    const next = json({
      isSidechain: false,
      message: { content: "Carry on", role: "user" },
      promptSource: "typed",
      sessionId: "9f9e8d7c-0000-4000-8000-000000000001",
      timestamp: stamp(90),
      type: "user",
      uuid: "u2",
    });
    const { timeline } = timelineOf([...devServer, next]);
    expect(callNamed(timeline, "toolu_bg").task?.state).toBe("stopped");
    expect(callNamed(timeline, "toolu_bg").task?.finishedAt).toBe(at(90));
    expect(runningWork(timeline)).toEqual([]);
  });

  it("is stopped when the agent is gone (the session ended), and running turns' foreground work with it", () => {
    const { timeline } = timelineOf(devServer.slice(0, 3));
    expect(runningWork(timeline).length).toBe(1);
    const ended = endingSession(timeline);
    expect(callNamed(ended, "toolu_bg").task?.state).toBe("stopped");
    expect(callNamed(ended, "toolu_bg").resultSummary).toBe("stopped");
    expect(runningWork(ended)).toEqual([]);
    expect(ended.turns.at(-1)!.isFinished).toBe(true);
    // Only a turn ended (the pane idle): the background shell runs on.
    expect(runningWork(endingRunningTurn(timeline)).length).toBe(1);
    // The builder told the session ended (a new run in the pane): stopped for good, a notice after it changes nothing.
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    builder.apply(parser.parseText(devServer.join("\n")));
    builder.endSession(at(70));
    expect(callNamed(builder.timeline, "toolu_bg").task?.state).toBe("stopped");
    expect(callNamed(builder.timeline, "toolu_bg").task?.finishedAt).toBe(at(70));
    builder.apply(parser.parse(userCopy(devDone, "n3", 75)).events);
    expect(callNamed(builder.timeline, "toolu_bg").task?.state).toBe("stopped");
    expect(runningWork(builder.timeline)).toEqual([]);
  });

  it("is a task once a plain Bash call's result says it was moved to the background", () => {
    const lines = [
      typed("Run the tests", "u1", 0),
      bash("toolu_fg", "npm test", "Run the tests", "a1", 1, false),
      launched("toolu_fg", "b0fg11", "r1", 5),
    ];
    const { timeline } = timelineOf(lines);
    expect(callNamed(timeline, "toolu_fg").task?.state).toBe("running");
    expect(callNamed(timeline, "toolu_fg").task?.taskID).toBe("b0fg11");
    // A foreground Bash with a plain result is no task.
    const plain = timelineOf([typed("Run", "u1", 0), bash("toolu_x", "ls", "List", "a1", 1, false), toolResult("toolu_x", "a\nb", { stdout: "a\nb" }, "r1", 2)]).timeline;
    expect(callNamed(plain, "toolu_x").task).toBeUndefined();
    expect(runningWork(plain)).toEqual([]);
  });

  it("fails when its launch failed", () => {
    const { timeline } = timelineOf([devServer[0]!, devServer[1]!, toolResult("toolu_bg", "Permission denied", "Error: Permission denied", "r1", 3, true)]);
    expect(callNamed(timeline, "toolu_bg").task?.state).toBe("failed");
    expect(callNamed(timeline, "toolu_bg").state).toBe("failed");
    expect(runningWork(timeline)).toEqual([]);
  });
});

describe("a monitor", () => {
  const watch = [
    typed("Watch the build log", "u1", 0),
    monitor("toolu_mon", "tail -f build.log | grep --line-buffered ERROR", "Watch the build for errors", "a1", 1),
    monitorStarted("toolu_mon", "m4x8", "r1", 2),
    reply("Watching.", "a2", 3, true),
  ];
  const event = (text: string, second: number): string => queueCopy(notice({ task: "m4x8", toolUse: "toolu_mon", status: "running", event: text }), second);

  it("keeps its newest event while it runs, then ends", () => {
    let timeline = timelineOf(watch).timeline;
    let call = callNamed(timeline, "toolu_mon");
    expect(call.task?.kind).toBe("monitor");
    expect(call.task?.taskID).toBe("m4x8");
    expect(call.resultSummary).toBe("running in background");
    expect(runningWork(timeline).map((work) => [work.kind, work.title, work.lastEvent])).toEqual([["monitor", "Watch the build for errors", null]]);

    const lines = [...watch, event("ERROR src/a.ts: missing semicolon", 20), userCopy(notice({ task: "m4x8", toolUse: "toolu_mon", event: "ERROR src/b.ts: type mismatch" }), "n1", 40)];
    timeline = timelineOf(lines).timeline;
    call = callNamed(timeline, "toolu_mon");
    expect(call.task?.state).toBe("running");
    expect(call.task?.lastEvent).toBe("ERROR src/b.ts: type mismatch");
    expect(runningWork(timeline).map((work) => work.lastEvent)).toEqual(["ERROR src/b.ts: type mismatch"]);
    // The same event written three ways keeps it once.
    const thrice = timelineOf([...watch, event("ERROR one", 20), attachmentCopy(notice({ task: "m4x8", toolUse: "toolu_mon", status: "running", event: "ERROR one" }), "n2", 21)]).timeline;
    expect(callNamed(thrice, "toolu_mon").task?.lastEvent).toBe("ERROR one");

    const ended = notice({ task: "m4x8", toolUse: "toolu_mon", status: "completed", summary: 'Monitor "Watch the build for errors" stream ended', event: "ERROR src/c.ts: last one" });
    timeline = timelineOf([...lines, queueCopy(ended, 61), userCopy(ended, "n9", 62)]).timeline;
    call = callNamed(timeline, "toolu_mon");
    expect(call.task?.state).toBe("done");
    expect(call.task?.lastEvent).toBe("ERROR src/c.ts: last one");
    expect(call.resultSummary).toBe("ended · 1m 0s");
    expect(taskStatusText(call.task!)).toBe("ended · 1m 0s");
    expect(runningWork(timeline)).toEqual([]);
  });

  it("is stopped by a TaskStop and timed out as stopped", () => {
    let timeline = timelineOf([...watch, taskStop("toolu_stop", "m4x8", "a3", 9)]).timeline;
    expect(callNamed(timeline, "toolu_mon").task?.state).toBe("stopped");
    timeline = timelineOf([...watch, queueCopy(notice({ task: "m4x8", toolUse: "toolu_mon", status: "timed out" }), 1_802)]).timeline;
    expect(callNamed(timeline, "toolu_mon").task?.state).toBe("stopped");
    expect(runningWork(timeline)).toEqual([]);
  });
});

describe("Load earlier", () => {
  it("brings in a task's start after its end was read: no ghost running item", () => {
    const older = [...devServer];
    const newer = [typed("Anything else?", "u2", 30), reply("All quiet.", "a3", 31, true), queueCopy(devDone, 60), userCopy(devDone, "n3", 61)];
    const newerParser = new TranscriptParser("claude");
    const newerBuilder = new ChatTimelineBuilder();
    newerBuilder.apply(newerParser.parseText(newer.join("\n")));
    expect(runningWork(newerBuilder.timeline)).toEqual([]);
    const olderParser = new TranscriptParser("claude");
    const olderBuilder = new ChatTimelineBuilder();
    olderBuilder.apply(olderParser.parseText(older.join("\n")));
    expect(runningWork(olderBuilder.timeline).length).toBe(1);
    newerBuilder.prepend(olderBuilder);
    const timeline = newerBuilder.timeline;
    expect(callNamed(timeline, "toolu_bg").task?.state).toBe("done");
    expect(callNamed(timeline, "toolu_bg").task?.finishedAt).toBe(at(60));
    expect(runningWork(timeline)).toEqual([]);
  });

  it("brings in a task begun before a session the held part ended: stopped, not running", () => {
    const newerBuilder = new ChatTimelineBuilder();
    newerBuilder.apply(new TranscriptParser("claude").parseText([typed("Next", "u2", 30), reply("Ok.", "a3", 31, true)].join("\n")));
    newerBuilder.endSession(at(40));
    const olderBuilder = new ChatTimelineBuilder();
    olderBuilder.apply(new TranscriptParser("claude").parseText(devServer.join("\n")));
    newerBuilder.prepend(olderBuilder);
    expect(callNamed(newerBuilder.timeline, "toolu_bg").task?.state).toBe("stopped");
    expect(runningWork(newerBuilder.timeline)).toEqual([]);
  });

  it("keeps a running task the item cap let go in the running list, and its notice still ends it", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder(10, 40);
    builder.apply(parser.parseText(devServer.join("\n")));
    const filler: string[] = [];
    for (let n = 0; n < 30; n += 1) filler.push(typed(`message ${n}`, `fu${n}`, 10 + n), reply(`reply ${n}`, `fa${n}`, 10 + n, true));
    builder.apply(parser.parseText(filler.join("\n")));
    expect(calls(builder.timeline).some((call) => call.id === "toolu_bg")).toBe(false);
    expect(runningWork(builder.timeline).map((work) => work.id)).toEqual(["toolu_bg"]);
    builder.apply(parser.parse(queueCopy(devDone, 80)).events);
    expect(runningWork(builder.timeline)).toEqual([]);
  });
});
