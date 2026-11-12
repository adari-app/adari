// Chat confirms a Compact from the transcript (its compaction marker) when the
// session keeps background tasks running: a Monitor, a background shell and a background subagent, the
// subagent's own lines (sidechain, its own compaction too), and monitor events that start new turns before
// and after the compaction. The ring spins until the transcript shows the session's own compaction, then Chat
// says Compacted once. A hand-built transcript in Claude Code's line shapes, invented text.

import { describe, expect, it } from "vitest";

import { AgentPicks, type PickContext } from "../src/renderer/components/agent-picks";
import { AgentSettingsReader } from "../src/shared/agent-settings";
import { json, result, session, stamp, timelineOf, user } from "./support/chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

const typed = (text: string, uuid: string, second: number): string => user(text, uuid, second, { promptSource: "typed" });

const assistant = (uuid: string, second: number, content: JSONValue[], extra: Record<string, JSONValue> = {}, stop: string | null = "tool_use"): string =>
  json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid,
    effort: "high",
    message: {
      id: "msg_" + uuid,
      model: "claude-fable-5-2",
      role: "assistant",
      type: "message",
      stop_reason: stop,
      content,
      usage: { input_tokens: 12, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 300_000, output_tokens: 80 },
    },
    ...extra,
  });

const toolUse = (id: string, name: string, input: Record<string, JSONValue>): JSONValue => ({ id, input, name, type: "tool_use" });
const say = (text: string): JSONValue => ({ text, type: "text" });

/** A subagent's own line (sidechain): another model, its own usage and its own compaction never count as the session's. */
const sidechain = (uuid: string, second: number, compaction = false): string =>
  compaction
    ? json({ isSidechain: true, agentId: "a7f3c", sessionId: session, timestamp: stamp(second), type: "system", subtype: "compact_boundary", uuid, content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 150_000 } })
    : json({
        isSidechain: true,
        agentId: "a7f3c",
        sessionId: session,
        timestamp: stamp(second),
        type: "assistant",
        uuid,
        message: { id: "msg_" + uuid, model: "claude-haiku-5-5", role: "assistant", type: "message", content: [say("Reading the layout files.")], usage: { input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 40_000 } },
      });

const notification = (uuid: string, second: number, task: string, summary: string): string =>
  user(`<task-notification>\n<task-id>${task}</task-id>\n<status>running</status>\n<summary>${summary}</summary>\n</task-notification>`, uuid, second, { isMeta: true });

const boundary = (uuid: string, second: number): string =>
  json({ isSidechain: false, sessionId: session, timestamp: stamp(second), type: "system", subtype: "compact_boundary", uuid, content: "Conversation compacted", level: "info", isMeta: false, compactMetadata: { trigger: "manual", preTokens: 302_092 } });

const summary = (uuid: string, second: number): string =>
  json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "user",
    uuid,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion." },
  });

const before = [
  typed("Watch the two jobs and tell me when either ends.", "u1", 0),
  assistant("a1", 2, [say("Starting the monitors."), toolUse("toolu_m1", "Monitor", { command: "tail -f job1.log", description: "job nightly-build" })]),
  result("toolu_m1", "Monitor started. You will be told of each new line.", "r1", 3),
  assistant("a2", 4, [toolUse("toolu_m2", "Monitor", { command: "tail -f job2.log", description: "job docs-site" })]),
  result("toolu_m2", "Monitor started. You will be told of each new line.", "r2", 5),
  assistant("a3", 6, [toolUse("toolu_b1", "Bash", { command: "npm test", description: "the suite", run_in_background: true })]),
  result("toolu_b1", "Command running in background with ID: b1", "r3", 7),
  assistant("a4", 8, [toolUse("toolu_ag", "Agent", { description: "Check the phone layout", prompt: "Find out why it wraps", subagent_type: "general-purpose", run_in_background: true })]),
  result("toolu_ag", "Async agent launched successfully.\nagentId: a7f3c (internal ID, use it to message the agent)\nThe agent works in the background; you will be told when it finishes.", "r4", 9),
  sidechain("s1", 10),
  sidechain("s2", 11, true),
  assistant("a5", 12, [say("Both monitors and the background work are running.")], {}, "end_turn"),
  notification("n1", 30, "toolu_m1", "job nightly-build: step 3 of 9"),
  assistant("a6", 31, [say("Job one is at step 3.")], {}, "end_turn"),
];
const compaction = [boundary("c1", 60), summary("c2", 61)];
const after = [
  sidechain("s3", 62),
  notification("n2", 70, "toolu_m2", "job docs-site: step 5 of 7"),
  assistant("a7", 71, [say("Job two is at step 5.")], {}, "end_turn"),
  sidechain("s4", 72, true),
];

const key = "mac-a/p1";
const binding = { terminalID: "t1", isAgent: true, kind: "claude", session, run: { connection: 2, arrival: 1 } } as const;
const ctx = (status: PickContext["status"]): PickContext => ({ hostId: "mac-a", paneId: "p1", agent: "claude", status, binding });

/** The chat update's reads as the transcript grows: each whole line at its byte offset, the timeline's newest turn. */
class Reads {
  private readonly reader = new AgentSettingsReader("claude");
  private readonly lines: string[] = [];
  private offset = 0;
  add(lines: readonly string[]): { settings: ReturnType<Reads["settings"]>; turn: string | null } {
    for (const line of lines) {
      this.reader.line(line, this.offset);
      this.offset += Buffer.byteLength(line) + 1;
      this.lines.push(line);
    }
    return { settings: this.settings(), turn: timelineOf(this.lines).timeline.turns.at(-1)?.id ?? null };
  }
  settings() {
    return { ...this.reader.settings, scope: { terminalID: "t1", session } };
  }
  get all(): readonly string[] {
    return this.lines;
  }
}

describe("Compacted from a transcript with background tasks and subagent lines", () => {
  it("only the session's own compaction marker counts: a subagent's never does", () => {
    const reads = new Reads();
    const { settings } = reads.add(before);
    expect(settings.compactedAt).toBeNull();
    expect(settings.modelLabel).toBe("Fable 5.2");
    expect(settings.used).not.toBeNull();
    const at = reads.add(compaction).settings.compactedAt;
    expect(at).not.toBeNull();
    // The marker or its summary line (the newest of the two), after every line before it.
    expect(at!).toBeGreaterThanOrEqual(Buffer.byteLength(before.join("\n")) + 1);
    // A subagent compacting after it, and the monitors' turns, never move it.
    expect(reads.add(after).settings.compactedAt).toBe(at);
  });

  it("the ring spins until the compaction shows, then Chat says Compacted once, also after the next monitor turn", async () => {
    const sent: string[] = [];
    let now = 1_000;
    const picks = new AgentPicks({ send: async (_h, _p, text) => void sent.push(text), copy: () => undefined, now: () => now });
    const reads = new Reads();
    let read = reads.add(before.slice(0, 12));
    picks.receive(key, read.settings, read.turn);
    // A monitor's turn runs (Herdr: working): Compact is held.
    read = reads.add(before.slice(12, 13));
    picks.receive(key, read.settings, read.turn);
    picks.pick(ctx("working"), { kind: "compact", value: "compact", label: "Compact" });
    expect(picks.compacting(key, binding)).toBe("held");
    read = reads.add(before.slice(13));
    picks.receive(key, read.settings, read.turn);
    // The turn ends with the monitors, the shell and the subagent still running: Herdr says done.
    picks.sync(key, ctx("done"));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual(["/compact"]);
    // The subagent's own lines and its compaction come in first: still compacting.
    now += 5_000;
    read = reads.add([sidechain("s5", 40), sidechain("s6", 41, true)]);
    picks.receive(key, read.settings, read.turn);
    expect(picks.compacting(key, binding)).toBe("running");
    expect(picks.confirmations(key, read.turn)).toEqual([]);
    // Claude compacts (Herdr: working), then the marker and its summary land.
    picks.sync(key, ctx("working"));
    now += 20_000;
    read = reads.add(compaction);
    picks.receive(key, read.settings, read.turn);
    const compactedTurn = read.turn;
    expect(picks.compacting(key, binding)).toBeNull();
    expect(picks.confirmations(key, compactedTurn)).toEqual(["Compacted"]);
    // The transcript's own notice shows once too.
    const notices = (lines: readonly string[]) =>
      timelineOf(lines).timeline.turns.flatMap((turn) => turn.items.filter((item) => item.type === "notice" && item.value.kind === "compacted"));
    expect(notices(reads.all)).toHaveLength(1);
    // The next monitor's turn and more subagent lines: never a second Compacted.
    read = reads.add(after);
    picks.receive(key, read.settings, read.turn);
    expect(picks.confirmations(key, compactedTurn)).toEqual(["Compacted"]);
    expect(picks.confirmations(key, read.turn).filter((line) => line === "Compacted").length).toBeLessThanOrEqual(1);
    expect(notices(reads.all)).toHaveLength(1);
    expect(sent).toEqual(["/compact"]);
  });
});
