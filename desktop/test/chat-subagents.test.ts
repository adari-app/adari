// The same cases as HerdrKit's ChatTimelineSubagentTests.swift: the subagents
// a turn started are one compact row in it, each turning done with its elapsed time when its tool_result (foreground) or hand-back
// (background) lands; a hand-back with no start held is an "Agent report" row
// where it lands; another session's message is a "Message from another
// session" row; the Working line counts the subagents running. Hand-built in
// Claude Code's line shapes, invented text.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { claudeToolCall } from "../src/shared/chat/claude-parser";
import {
  runningSubagents,
  subagentElapsed,
  subagentStatusText,
  subagentsSummary,
  turnRows,
  turnToolCalls,
  workingAgentsText,
  type ChatAgentMessage,
  type ChatSubagents,
  type ChatTimeline,
} from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { userMessages } from "../src/shared/chat/pending";
import { json, queued, reply, result, session, stamp, timelineOf, tool, user } from "./support/chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

const typedFields: Record<string, JSONValue> = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } };
const peerFields: Record<string, JSONValue> = { isMeta: true, promptSource: "system", turnOrigin: "peer", origin: { kind: "peer", from: "uds:/tmp/cc-socks/41.sock" } };
const typed = (text: string, uuid: string, second: number): string => user(text, uuid, second, typedFields);
const peer = (text: string, uuid: string, second: number): string => user(text, uuid, second, peerFields);
const envelope = (body: string, from = "agent-7f3c"): string =>
  `Another Claude session sent a message:\n<agent-message from="${from}">\n${body}\n</agent-message>`;
const handBack = (report: string, from: string): string =>
  envelope("[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n\n" + report, from);

function agent(id: string, description: string, uuid: string, second: number, fields: { type?: string; background?: JSONValue; name?: string } = {}): string {
  const input: { [key: string]: JSONValue } = { description, prompt: "Find out: " + description, model: "sonnet" };
  if (fields.type !== undefined) input.subagent_type = fields.type;
  if (fields.background !== undefined) input.run_in_background = fields.background;
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid,
    message: { content: [{ id, input, name: fields.name ?? "Agent", type: "tool_use" }], id: "msg_" + uuid, role: "assistant", stop_reason: "tool_use", type: "message" },
  });
}

const launched = (id: string, agentID: string, uuid: string, second: number): string =>
  result(id, `Async agent launched successfully.\nagentId: ${agentID} (internal ID, use it to message the agent)\nThe agent works in the background; you will be told when it finishes.`, uuid, second);

const groups = (timeline: ChatTimeline): ChatSubagents[] => timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "agents" ? [item.value] : [])));
const messages = (timeline: ChatTimeline): ChatAgentMessage[] =>
  timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "agentMessage" ? [item.value] : [])));
const users = (timeline: ChatTimeline): string[] => userMessages(timeline).map((message) => message.text);

const threeAgents = [
  typed("Why does the banner wrap on the phone?", "u1", 0),
  reply("Sending three agents.", "a1", 2),
  agent("toolu_fg", "Read the banner view", "a2", 3, { type: "Explore" }),
  agent("toolu_bg1", "Check the phone layout", "a3", 4, { type: "general-purpose", background: true }),
  agent("toolu_bg2", "Look for line limits", "a4", 5, { background: "true", name: "Task" }),
];

describe("subagents as their own row", () => {
  it("shows one foreground and two background subagents as one row that runs, then finishes", () => {
    const lines = [...threeAgents];
    let timeline = timelineOf(lines).timeline;
    expect(groups(timeline).length).toBe(1);
    let group = groups(timeline)[0]!;
    expect(group.agents.map((a) => a.description)).toEqual(["Read the banner view", "Check the phone layout", "Look for line limits"]);
    expect(group.agents.map((a) => a.type)).toEqual(["Explore", "general-purpose", null]);
    expect(group.agents.map((a) => a.background)).toEqual([false, true, true]);
    expect(subagentsSummary(group)).toBe("3 agents running");
    expect(runningSubagents(timeline)).toBe(3);
    expect(turnToolCalls(timeline.turns[0]!)).toEqual([]);

    lines.push(launched("toolu_bg1", "agent-b1", "r1", 6), launched("toolu_bg2", "agent-b2", "r2", 6));
    lines.push(result("toolu_fg", "Banner.swift sets no lineLimit.", "r3", 75));
    timeline = timelineOf(lines).timeline;
    group = groups(timeline)[0]!;
    expect(group.agents.map((a) => a.state)).toEqual(["done", "running", "running"]);
    expect(subagentElapsed(group.agents[0]!)).toBe(72);
    expect(subagentStatusText(group.agents[0]!)).toBe("done · 1m 12s");
    expect(group.agents[0]!.report).toBe("Banner.swift sets no lineLimit.");
    expect(subagentStatusText(group.agents[1]!)).toBe("running");
    expect(subagentsSummary(group)).toBe("2 agents running · 1 done");
    expect(runningSubagents(timeline)).toBe(2);
    expect(workingAgentsText(2)).toBe("2 agents");
    expect(workingAgentsText(1)).toBe("1 agent");
    expect(workingAgentsText(0)).toBeNull();

    lines.push(
      reply("Two agents still run; I will report when they finish.", "a5", 80, true),
      peer(handBack("The phone layout clips at 390 points.", "agent-b1"), "m1", 130),
      queued(handBack("No other line limits.", "agent-b2"), "q1", "s-q1", 140, { origin: { kind: "peer" } }),
    );
    timeline = timelineOf(lines).timeline;
    expect(timeline.turns.length).toBe(1);
    expect(users(timeline)).toEqual(["Why does the banner wrap on the phone?"]);
    expect(messages(timeline)).toEqual([]);
    group = groups(timeline)[0]!;
    expect(group.agents.map((a) => a.state)).toEqual(["done", "done", "done"]);
    expect(group.agents[1]!.report).toBe("The phone layout clips at 390 points.");
    expect(subagentElapsed(group.agents[1]!)).toBe(126);
    expect(group.agents[2]!.report).toBe("No other line limits.");
    expect(subagentsSummary(group)).toBe("3 agents done");
    expect(runningSubagents(timeline)).toBe(0);
    expect(turnRows(timeline.turns[0]!).some((row) => row.type === "item" && row.item.type === "agents")).toBe(true);
  });

  it("finishes a hand-back written both ways once and shows nothing else", () => {
    const back = handBack("Done.", "agent-b1");
    const { timeline } = timelineOf([
      typed("Go", "u1", 0),
      agent("toolu_bg1", "Background check", "a1", 1, { background: true }),
      launched("toolu_bg1", "agent-b1", "r1", 2),
      queued(back, "q1", "s-q1", 30),
      peer(back, "m1", 30),
    ]);
    expect(groups(timeline)[0]!.agents.map((a) => a.state)).toEqual(["done"]);
    expect(messages(timeline)).toEqual([]);
    expect(users(timeline)).toEqual(["Go"]);
  });

  it("shows a hand-back with no start held as an Agent report row where it lands", () => {
    const { timeline } = timelineOf([typed("Carry on", "u1", 0), reply("Working.", "a1", 1), peer(handBack("An older report.", "agent-old"), "m1", 5)]);
    expect(timeline.turns.length).toBe(1);
    expect(messages(timeline).map((m) => [m.kind, m.text])).toEqual([["report", "An older report."]]);
    expect(timeline.turns[0]!.items.at(-1)?.type).toBe("agentMessage");
  });

  it("finishes the start Load earlier brings with the report that landed after it", () => {
    const older = [
      typed("Start the check", "u1", 0),
      agent("toolu_bg1", "Background check", "a1", 1, { background: true }),
      launched("toolu_bg1", "agent-b1", "r1", 2),
      reply("It runs in the background.", "a2", 3, true),
    ];
    const newer = [typed("Anything else?", "u2", 60), reply("Waiting on the check.", "a3", 61), peer(handBack("The check passed.", "agent-b1"), "m1", 90)];
    const build = (lines: readonly string[]): ChatTimelineBuilder => {
      const parser = new TranscriptParser("claude");
      const builder = new ChatTimelineBuilder();
      builder.apply(parser.parseText(lines.join("\n")));
      return builder;
    };
    const newerBuilder = build(newer);
    expect(messages(newerBuilder.timeline).map((m) => m.kind)).toEqual(["report"]);
    const olderBuilder = build(older);
    expect(runningSubagents(olderBuilder.timeline)).toBe(1);
    newerBuilder.prepend(olderBuilder);
    const timeline = newerBuilder.timeline;
    expect(groups(timeline)[0]!.agents.map((a) => a.state)).toEqual(["done"]);
    expect(groups(timeline)[0]!.agents[0]!.report).toBe("The check passed.");
    expect(messages(timeline).length).toBe(1);
    expect(runningSubagents(timeline)).toBe(0);
  });

  it("shows a message from another session as its own row while the turn goes on", () => {
    const { timeline } = timelineOf([
      typed("Build it", "u1", 0),
      tool("toolu_1", "swift build", "a1", 1),
      peer(envelope("Please pause the deploy until 03:00.", "w7:p1"), "m1", 4),
      result("toolu_1", "Build complete", "r1", 9),
    ]);
    expect(timeline.turns.length).toBe(1);
    expect(timeline.turns[0]!.isFinished).toBe(false);
    expect(messages(timeline).map((m) => [m.kind, m.from, m.text])).toEqual([["peer", "w7:p1", "Please pause the deploy until 03:00."]]);
    expect(users(timeline)).toEqual(["Build it"]);
  });

  it("finishes an agent by its task notification and otherwise shows nothing", () => {
    const notification = (id: string, status: string): string =>
      `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Agent "Background check" ${status}</summary>\n<result>All clear.</result>\n</task-notification>`;
    const { timeline } = timelineOf([
      typed("Go", "u1", 0),
      agent("toolu_bg1", "Background check", "a1", 1, { background: true }),
      launched("toolu_bg1", "agent-b1", "r1", 2),
      agent("toolu_bg2", "Second check", "a2", 3, { background: true }),
      launched("toolu_bg2", "agent-b2", "r2", 3),
      user(notification("bg-shell-9", "completed"), "n0", 10),
      user(notification("agent-b1", "completed"), "n1", 20),
      queued(notification("agent-b2", "failed"), "q1", "s-q1", 21),
    ]);
    const group = groups(timeline)[0]!;
    expect(group.agents.map((a) => a.state)).toEqual(["done", "failed"]);
    expect(group.agents[0]!.report).toBe("All clear.");
    expect(subagentsSummary(group)).toBe("1 agent done · 1 failed");
    expect(messages(timeline)).toEqual([]);
    expect(users(timeline)).toEqual(["Go"]);
  });

  it("stops a foreground agent at an interrupt and says a failed one failed", () => {
    const { timeline } = timelineOf([
      typed("Go", "u1", 0),
      agent("toolu_fg", "Long read", "a1", 1),
      agent("toolu_fg2", "Broken read", "a2", 1),
      json({
        isSidechain: false,
        sessionId: session,
        timestamp: stamp(4),
        type: "user",
        uuid: "r1",
        message: { content: [{ content: "Agent failed: no such type", is_error: true, tool_use_id: "toolu_fg2", type: "tool_result" }], role: "user" },
      }),
      user("[Request interrupted by user for tool use]", "i1", 8),
    ]);
    const group = groups(timeline)[0]!;
    expect(group.agents.map((a) => a.state)).toEqual(["stopped", "failed"]);
    expect(subagentStatusText(group.agents[0]!)).toBe("stopped");
    expect(runningSubagents(timeline)).toBe(0);
  });

  it("waits at end_turn for a running foreground agent", () => {
    const { timeline } = timelineOf([typed("Go", "u1", 0), agent("toolu_fg", "Read it", "a1", 1), reply("Meanwhile.", "a2", 2, true)]);
    expect(timeline.turns[0]!.isFinished).toBe(false);
  });

  it("shows the user's message quoting the tag with no agent rows", () => {
    const text = "Why did Chat show </agent-message> under my message?";
    const { timeline } = timelineOf([user(text, "u1", 0)]);
    expect(users(timeline)).toEqual([text]);
    expect(groups(timeline)).toEqual([]);
    expect(messages(timeline)).toEqual([]);
  });

  it("leaves a pending message to pair while a hand-back lands and its row shows", () => {
    const start = [...threeAgents.slice(0, 4), launched("toolu_bg1", "agent-b1", "r1", 6)];
    const { timeline } = timelineOf([...start, peer(handBack("The phone layout clips at 390 points.", "agent-b1"), "m1", 101)]);
    expect(users(timeline)).toEqual(["Why does the banner wrap on the phone?"]);
    expect(groups(timeline)[0]!.agents.map((a) => a.state)).toEqual(["running", "done"]);
  });

  it("reads an Agent call as a subagent launch", () => {
    expect(claudeToolCall("t", "Agent", { description: "d", subagent_type: "Explore", run_in_background: "true" }, null).subagent).toEqual({
      type: "Explore",
      background: true,
      name: null,
    });
    expect(claudeToolCall("t", "Bash", {}, null).subagent).toBeUndefined();
  });
});
