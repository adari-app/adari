// Subagent edge cases in the timeline, all fixtures invented.
import { describe, expect, it } from "vitest";
import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { agentEnvelope } from "../src/shared/chat/claude-parser";
import { TranscriptParser } from "../src/shared/chat/parser";
import { endingRunningTurn, runningSubagents, type ChatTimeline } from "../src/shared/chat/model";
import { sameTimeline } from "../src/shared/chat/feed";
import { userMessages } from "../src/shared/chat/pending";
import { lineMatches } from "../src/shared/search/hits";
import { SearchQuery } from "../src/shared/search/search";
import { queued, reply, result, stamp, timelineOf, user } from "./support/chat-lines";

const peer = { isMeta: true, promptSource: "system", turnOrigin: "peer", origin: { kind: "peer" } };
const back = (from: string, text: string): string => `<agent-message from="${from}">[Subagent hand-back] Header\n\n${text}</agent-message>`;
const typed = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } };
const agent = (id: string, background = false, second = 1): string =>
  JSON.stringify({
    type: "assistant",
    uuid: `a-${id}`,
    timestamp: stamp(second),
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { description: `Check ${id}`, run_in_background: background } }], stop_reason: "tool_use" },
  });
const notify = (id: string): string => `<task-notification><task-id>${id}</task-id><status>completed</status><result>All clear.</result></task-notification>`;
const groups = (t: ChatTimeline) => t.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "agents" ? [item.value] : [])));
const build = (lines: string[], cap = 200): ChatTimelineBuilder => {
  const parser = new TranscriptParser("claude");
  const builder = new ChatTimelineBuilder(cap);
  builder.apply(parser.parseText(lines.join("\n")));
  return builder;
};
const messages = (t: ChatTimeline) => t.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "agentMessage" ? [item.value] : [])));

describe("a malformed envelope", () => {
  it("stays literal text", () => {
    const text = "<agent-message </agent-message>";
    expect(agentEnvelope(text)).toBeNull();
    expect(agentEnvelope('Another Claude session sent a message:\n<agent-message from="x"</agent-message>')).toBeNull();
    const t = timelineOf([user(text, "u1", 0)]).timeline;
    expect(userMessages(t).map((m) => m.text)).toEqual([text]);
    expect(messages(t)).toEqual([]);
  });
});

describe("the user's typed text is the user's, task tags included", () => {
  it("keeps the user's typed task notification the user's: shown, searched as theirs, finishing no agent", () => {
    const line = user(notify("agent-b"), "u2", 3, typed);
    const t = timelineOf([user("Start", "u1", 0, typed), agent("b", true), result("b", "agentId: agent-b", "r1", 2), line]).timeline;
    expect(userMessages(t).map((m) => m.text)).toEqual(["Start", notify("agent-b")]);
    expect(groups(t)[0]?.agents[0]?.state).toBe("running");
    expect(lineMatches(line, 0, "claude", "p", SearchQuery.make("All clear")!).map((m) => m.author)).toEqual(["you"]);
  });

  it("pairs the user's typed queued task-tag prose once with its user line", () => {
    const text = "<task-notification> is the tag I want explained";
    const t = timelineOf([user("Start", "u1", 0), reply("Working", "a1", 1), queued(text, "q1", "u2", 3, typed), user(text, "u2", 4, typed)]).timeline;
    expect(userMessages(t).map((m) => m.text)).toEqual(["Start", text]);
  });

  it("keeps a task tag in prose the user's when the line has no fields", () => {
    const text = "<task-notification> is the tag I want explained";
    expect(userMessages(timelineOf([user(text, "u1", 0)]).timeline).map((m) => m.text)).toEqual([text]);
    const reminder = "<system-reminder> is another one";
    expect(userMessages(timelineOf([user(reminder, "u1", 0)]).timeline).map((m) => m.text)).toEqual([reminder]);
  });

  it("still hides real wrappers whatever the fields, and a no-field notification still finishes its agent", () => {
    const command = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>";
    const output = "<local-command-stdout>Set model to fixture</local-command-stdout>";
    const withReminder = user([{ type: "text", text: "My words" }, { type: "text", text: "<system-reminder>Fixture context</system-reminder>" }], "u3", 2, typed);
    expect(userMessages(timelineOf([user(command, "u1", 0, typed), user(output, "u2", 1), withReminder]).timeline).map((m) => m.text)).toEqual(["My words"]);
    const finished = timelineOf([user("Start", "u1", 0, typed), agent("b", true), result("b", "agentId: agent-b", "r1", 2), user(notify("agent-b"), "n1", 3)]).timeline;
    expect(groups(finished)[0]?.agents[0]?.state).toBe("done");
    expect(userMessages(finished).map((m) => m.text)).toEqual(["Start"]);
  });
});

describe("a report is never given to another agent by age", () => {
  it("finishes no other agent; joins its own when its launch id is known", () => {
    const lines = [user("Start", "u1", 0, typed), agent("a", true, 1), agent("b", true, 2), user(back("agent-b", "Second report"), "m1", 3, peer)];
    const early = timelineOf(lines).timeline;
    expect(groups(early)[0]?.agents.map((a) => a.state)).toEqual(["running", "running"]);
    expect(messages(early).map((m) => m.from)).toEqual(["agent-b"]);
    const t = timelineOf([...lines, result("b", "agentId: agent-b", "r2", 4), result("a", "agentId: agent-a", "r1", 5)]).timeline;
    expect(groups(t)[0]?.agents.map((a) => a.state)).toEqual(["running", "done"]);
    expect(groups(t)[0]?.agents[0]?.report).toBeNull();
    expect(groups(t)[0]?.agents[1]?.report).toBe("Second report");
    expect(messages(t)).toEqual([]);
  });

  it("keeps a report no agent is known by as an Agent report row", () => {
    const t = timelineOf([user("Start", "u1", 0, typed), agent("a", true, 1), user(back("agent-old", "Old report"), "m1", 2, peer), result("a", "agentId: agent-a", "r1", 3)]).timeline;
    expect(groups(t)[0]?.agents[0]?.state).toBe("running");
    expect(messages(t).map((m) => m.text)).toEqual(["Old report"]);
  });
});

describe("completion survives history windows", () => {
  it("keeps a finished agent done after Load earlier when its notification was read first", () => {
    const older = build([user("Start", "u1", 0, typed), agent("a", true), result("a", "agentId: agent-a", "r1", 2)]);
    const newer = build([user(notify("agent-a"), "n1", 30), reply("Done", "a2", 31, true)]);
    newer.prepend(older);
    expect(groups(newer.timeline)[0]?.agents[0]?.state).toBe("done");
    expect(groups(newer.timeline)[0]?.agents[0]?.report).toBe("All clear.");
    expect(runningSubagents(newer.timeline)).toBe(0);
  });

  it("keeps the end of a finished agent a trim let go", () => {
    const lines = [user("Start", "u1", 0), agent("a"), reply("Progress 2", "p2", 2), reply("Progress 3", "p3", 3), result("a", "All clear", "r1", 4), reply("Progress 5", "p5", 5)];
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder(2);
    lines.forEach((line, i) => builder.apply(parser.parse(line, i * 10).events, i * 10));
    // The result at 40 is after the kept start: the older read stops before it.
    expect(builder.keptStart).toBe(30);
    expect(groups(builder.timeline)).toEqual([]);
    builder.prepend(build(lines.slice(0, 3)));
    expect(groups(builder.timeline)[0]?.agents[0]?.state).toBe("done");
    expect(groups(builder.timeline)[0]?.agents[0]?.report).toBe("All clear");
  });
});

describe("every turn ending stops its foreground agents", () => {
  it("stops foreground agents when the pane goes idle; background ones run on", () => {
    const t = endingRunningTurn(timelineOf([user("Start", "u1", 0, typed), agent("a"), agent("b", true, 2)]).timeline);
    expect(groups(t)[0]?.agents.map((a) => a.state)).toEqual(["stopped", "running"]);
    expect(groups(t)[0]?.agents[0]?.finishedAt).toBe(Date.parse(stamp(2)) / 1000);
    expect(runningSubagents(t)).toBe(1);
  });

  it("stops the foreground agent of a turn Load earlier ends at the user's next message", () => {
    const older = build([user("Start", "u1", 0, typed), agent("a")]);
    const newer = build([user("New turn", "u2", 60, typed)]);
    newer.prepend(older);
    expect(groups(newer.timeline)[0]?.agents[0]?.state).toBe("stopped");
    expect(groups(newer.timeline)[0]?.agents[0]?.finishedAt).toBe(Date.parse(stamp(1)) / 1000);
    expect(runningSubagents(newer.timeline)).toBe(0);
  });
});

describe("the Working count reads what is held, not the window", () => {
  it("counts running agents whose row is out of the window", () => {
    const builder = build([user("Start", "u1", 0, typed), agent("a", true, 1), agent("b", false, 2)], 2);
    for (let i = 1; i <= 2; i++) builder.apply([{ type: "agentProgress", text: { id: `p${i}`, markdown: "Progress", time: null } }]);
    expect(builder.heldItemCount).toBe(4);
    expect(groups(builder.timeline)).toEqual([]);
    expect(runningSubagents(builder.timeline)).toBe(2);
    // The pane gone idle: the hidden foreground one stopped with its turn.
    expect(runningSubagents(endingRunningTurn(builder.timeline))).toBe(1);
  });
});

describe("the seam into an already finished partial turn", () => {
  it("stops the older half's foreground agent at the end an interrupt already gave the turn", () => {
    const older = build([user("Start", "u1", 0, typed), agent("a", false, 1), agent("b", true, 2)]);
    const newer = build([reply("Still checking", "p1", 20), user("[Request interrupted by user]", "n1", 30)]);
    expect(newer.timeline.turns[0]?.isFinished).toBe(true);
    expect(newer.timeline.turns[0]?.isPartial).toBe(true);
    newer.prepend(older);
    const t = endingRunningTurn(newer.timeline);
    expect(t.turns.length).toBe(1);
    expect(groups(t)[0]?.agents.map((a) => a.state)).toEqual(["stopped", "running"]);
    expect(groups(t)[0]?.agents[0]?.finishedAt).toBe(Date.parse(stamp(30)) / 1000);
    expect(runningSubagents(t)).toBe(1);
  });
});

describe("a hidden-only change to the running count is published", () => {
  it("tells two snapshots apart when only an agent out of the window finished", () => {
    const builder = build([user("Start", "u1", 0, typed), agent("a", true), result("a", "agentId: agent-a", "r1", 2)], 2);
    for (let i = 1; i <= 2; i++) builder.apply([{ type: "agentProgress", text: { id: `p${i}`, markdown: "Progress", time: null } }]);
    const before = builder.timeline;
    expect(groups(before)).toEqual([]);
    expect(runningSubagents(before)).toBe(1);
    builder.apply([{ type: "taskNotified", id: "agent-a", failed: false, report: "Finished", time: 30 }]);
    const after = builder.timeline;
    expect(runningSubagents(after)).toBe(0);
    expect(sameTimeline(before, after)).toBe(false);
    expect(sameTimeline(after, builder.timeline)).toBe(true);
    // Absent counts are zero.
    expect(sameTimeline({ ...after, hiddenRunning: undefined }, after)).toBe(true);
  });
});
