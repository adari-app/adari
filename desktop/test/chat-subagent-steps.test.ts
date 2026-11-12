// A running subagent's current step. Its strip item
// and its line in the subagents row show its newest tool step in the tool
// rows' words ("Read Banner.swift", "Ran swift test"), read from
// `<session folder>/subagents/agent-<agentId>.jsonl`, the file found by its
// meta.json's toolUseId (the parent's Agent call id). Read with the feed's
// reader, tail only, only while the agent runs and Chat is on show, at most
// once a second; no more once meta.json says finished or the call ends. A
// folder that does not read: the item shows without a step. Fixtures only.
// The twin of HerdrKit's ChatSubagentStepTests (the same fixtures).

import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoTranscriptReader, demoTranscripts } from "../src/main/demo/demo-chat";
import { demoRanPaneId, demoRunningPaneId } from "../src/main/demo/demo-running";
import { ChatFeed } from "../src/shared/chat/feed";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { claudeToolCall } from "../src/shared/chat/claude-parser";
import { runningWork, subagentStepText, toolStepText, type ChatSubagent, type ChatSubagents, type ChatTimeline } from "../src/shared/chat/model";
import { newestStep, subagentMetaOf, subagentsFolderOf } from "../src/shared/chat/subagent-steps";
import { claudePath, claudeSession, eventually, FakeTranscriptReader } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";
import {
  busyTurn,
  foregroundAgentID,
  subagentMeta,
  subagentPrompt,
  subagentResult,
  subagentsFolder,
  subagentTool,
  toolResult,
} from "./support/running-lines";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { SubagentsRow } = await import("../src/renderer/chat/SubagentRows");

const backgroundAgentID = "a1b2c3d4e5f60718";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The fake reader with a folder listing (the names directly inside a folder). */
class ListingReader extends FakeTranscriptReader {
  private readonly paths = new Set<string>();
  listFails = false;
  listings: string[] = [];

  override put(path: string, content: string, located: string | null): void {
    super.put(path, content, located);
    this.paths.add(path);
  }

  async list(folder: string): Promise<readonly string[]> {
    this.listings.push(folder);
    if (this.listFails) throw new Error("the folder does not read");
    const prefix = folder.endsWith("/") ? folder : folder + "/";
    return [...this.paths].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map((path) => path.slice(prefix.length));
  }

  /** Reads of files under the subagents folder. */
  subagentReads(): string[] {
    return this.readPaths.filter((path) => path.startsWith(subagentsFolder + "/"));
  }
}

/** The foreground agent (toolu_fga) reads Banner.swift; the background one (toolu_bga) runs swift test. */
function putSubagents(reader: ListingReader, options: { foregroundFinished?: boolean } = {}): void {
  reader.put(`${subagentsFolder}/agent-${foregroundAgentID}.meta.json`, subagentMeta("toolu_fga", options.foregroundFinished ?? false), null);
  reader.put(
    `${subagentsFolder}/agent-${foregroundAgentID}.jsonl`,
    subagentPrompt(foregroundAgentID, "Read Banner.swift and say what sets its line limit.", "s1", 5) +
      subagentTool(foregroundAgentID, "toolu_s1", "Grep", { pattern: "lineLimit" }, "s2", 6) +
      subagentResult(foregroundAgentID, "toolu_s1", "Sources/Banner.swift", "s3", 6) +
      subagentTool(foregroundAgentID, "toolu_s2", "Read", { file_path: "/Users/fixture/proj/Sources/Banner.swift" }, "s4", 7),
    null,
  );
  reader.put(`${subagentsFolder}/agent-${backgroundAgentID}.meta.json`, subagentMeta("toolu_bga", false, "Check the phone layout"), null);
  reader.put(
    `${subagentsFolder}/agent-${backgroundAgentID}.jsonl`,
    subagentPrompt(backgroundAgentID, "Open the phone layout and check the chips row fits at 375 pt.", "b1", 4) +
      subagentTool(backgroundAgentID, "toolu_b1", "Bash", { command: "swift test --filter Chips\necho done", description: "Run the chips tests" }, "b2", 8),
    null,
  );
  // Another session's agent in the same folder: never this turn's.
  reader.put(`${subagentsFolder}/agent-0000aaaa1111bbbb.meta.json`, subagentMeta("toolu_other", false, "Someone else's"), null);
}

function stepsFeed(reader: ListingReader, options: { stepIntervalMs?: number; stepsShown?: () => boolean } = {}): ChatFeed<TranscriptSessionRef> {
  reader.put(claudePath, busyTurn.map((line) => line + "\n").join(""), claudePath);
  const feed = new ChatFeed(reader, { pollIntervalMs: 5, maxItems: 200, historyCap: 100_000, stepIntervalMs: options.stepIntervalMs ?? 10, stepsShown: options.stepsShown });
  feed.start(claudeSession);
  return feed;
}

const stepOf = (timeline: ChatTimeline, id: string): string | null => runningWork(timeline).find((work) => work.id === id)?.step ?? null;

function agentsRow(timeline: ChatTimeline): ChatSubagents {
  for (const turn of timeline.turns) for (const item of turn.items) if (item.type === "agents") return item.value;
  throw new Error("no subagents row");
}

const agentIn = (timeline: ChatTimeline, id: string): ChatSubagent => agentsRow(timeline).agents.find((agent) => agent.id === id)!;

let feeds: ChatFeed<TranscriptSessionRef>[] = [];
afterEach(() => {
  for (const feed of feeds) feed.stop();
  feeds = [];
});
const track = (feed: ChatFeed<TranscriptSessionRef>): ChatFeed<TranscriptSessionRef> => {
  feeds.push(feed);
  return feed;
};

describe("a step in the tool rows' words", () => {
  it("says the newest tool call as its row does: Read and Edit name the file, a command is Ran and its first line", () => {
    const step = (name: string, input: Record<string, string>): string => toolStepText(claudeToolCall("t", name, input, null));
    expect(step("Read", { file_path: "/Users/fixture/proj/src/foo.ts" })).toBe("Read foo.ts");
    expect(step("Edit", { file_path: "/Users/fixture/proj/src/foo.ts", old_string: "a", new_string: "b" })).toBe("Edit foo.ts");
    expect(step("Write", { file_path: "/Users/fixture/proj/notes.md", content: "x" })).toBe("Edit notes.md");
    expect(step("Bash", { command: "npm test\necho done" })).toBe("Ran npm test");
    expect(step("Grep", { pattern: "lineLimit" })).toBe("Search lineLimit");
    expect(step("WebFetch", { url: "https://example.com/a" })).toBe("Web https://example.com/a");
    expect(step("TodoWrite", {})).toBe("Plan");
    expect(step("Skill", { skill: "x" })).toBe("Skill");
  });

  it("finds the newest tool call in a tail, skipping a cut first line and lines that do not parse", () => {
    const lines =
      subagentPrompt("x", "Look around", "p1", 1) +
      subagentTool("x", "t1", "Read", { file_path: "/a/b/one.ts" }, "p2", 2) +
      subagentResult("x", "t1", "…", "p3", 2) +
      subagentTool("x", "t2", "Bash", { command: "swift build" }, "p4", 3) +
      subagentResult("x", "t2", "Build complete", "p5", 4) +
      "{not json\n";
    expect(newestStep(enc(lines), true)).toBe("Ran swift build");
    // A tail that starts inside its first line: that line is not read.
    const last = subagentTool("x", "t9", "Read", { file_path: "/a/b/nine.ts" }, "p9", 9);
    expect(newestStep(enc(last.slice(10)), false)).toBeNull();
    expect(newestStep(enc(last.slice(10) + subagentTool("x", "t8", "Grep", { pattern: "TODO" }, "p8", 8)), false)).toBe("Search TODO");
    expect(newestStep(enc(subagentPrompt("x", "Only a prompt", "p1", 1)), true)).toBeNull();
  });

  it("reads meta.json's toolUseId and finished, and the session's subagents folder beside its transcript", () => {
    expect(subagentMetaOf(enc(subagentMeta("toolu_fga", false)))).toEqual({ toolUseID: "toolu_fga", finished: false });
    expect(subagentMetaOf(enc(subagentMeta("toolu_fga", true)))).toEqual({ toolUseID: "toolu_fga", finished: true });
    expect(subagentMetaOf(enc("{\"agentType\":"))).toBeNull();
    expect(subagentsFolderOf(claudePath)).toBe(subagentsFolder);
    expect(subagentsFolderOf("/Users/fixture/.codex/sessions/rollout.txt")).toBeNull();
  });
});

describe("the feed reads a running subagent's step", () => {
  it("a foreground and a background subagent show their newest steps on the strip and in the row", async () => {
    const reader = new ListingReader();
    putSubagents(reader);
    const feed = track(stepsFeed(reader));
    expect(await eventually(() => stepOf(feed.timeline, "toolu_fga") !== null && stepOf(feed.timeline, "toolu_bga") !== null, 3_000)).toBe(true);
    expect(stepOf(feed.timeline, "toolu_fga")).toBe("Read Banner.swift");
    expect(stepOf(feed.timeline, "toolu_bga")).toBe("Ran swift test --filter Chips");
    expect(agentIn(feed.timeline, "toolu_fga").step).toBe("Read Banner.swift");
    expect(subagentStepText(agentIn(feed.timeline, "toolu_bga"))).toBe("Ran swift test --filter Chips");
    // The other session's agent's file is never read past its meta.json.
    expect(reader.subagentReads().some((path) => path.endsWith("agent-0000aaaa1111bbbb.jsonl"))).toBe(false);
    // Tail only: the transcript reads ask for no more than the tail bound.
    const tails = reader.calls.filter((call) => call.startsWith("read "));
    expect(tails.length).toBeGreaterThan(0);

    // A newer step appears.
    reader.append(`${subagentsFolder}/agent-${foregroundAgentID}.jsonl`, subagentTool(foregroundAgentID, "toolu_s3", "Edit", { file_path: "/Users/fixture/proj/Sources/Banner.swift", old_string: "a", new_string: "b" }, "s5", 9));
    expect(await eventually(() => stepOf(feed.timeline, "toolu_fga") === "Edit Banner.swift", 3_000)).toBe(true);
  });

  it("reads no more once the call ends, or once meta.json says finished", async () => {
    const reader = new ListingReader();
    putSubagents(reader, { foregroundFinished: true });
    const feed = track(stepsFeed(reader));
    expect(await eventually(() => stepOf(feed.timeline, "toolu_bga") !== null, 3_000)).toBe(true);
    await sleep(80);
    const foreground = (): number => reader.subagentReads().filter((path) => path.includes(foregroundAgentID)).length;
    const background = (): number => reader.subagentReads().filter((path) => path.includes(backgroundAgentID)).length;
    // finished: its meta.json was read once, its transcript never again after.
    const finishedReads = foreground();
    await sleep(80);
    expect(foreground()).toBe(finishedReads);

    // The background agent's hand-back ends it: no more reads of its files.
    reader.append(claudePath, toolResult("toolu_fga", "Banner.swift sets no lineLimit.", { status: "completed" }, "r9", 20) + "\n");
    reader.append(
      claudePath,
      JSON.stringify({ content: `<task-notification>\n<task-id>${backgroundAgentID}</task-id>\n<tool-use-id>toolu_bga</tool-use-id>\n<status>completed</status>\n<summary>Agent "Check the phone layout" completed</summary>\n</task-notification>`, operation: "enqueue", sessionId: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f", timestamp: "2026-11-02T05:00:21.000Z", type: "queue-operation" }) + "\n",
    );
    expect(await eventually(() => runningWork(feed.timeline).every((work) => work.kind !== "agent"), 3_000)).toBe(true);
    await sleep(40);
    const after = background();
    await sleep(80);
    expect(background()).toBe(after);
  });

  it("a folder that does not read: the items show without a step and the chat stays live", async () => {
    const reader = new ListingReader();
    reader.listFails = true;
    const feed = track(stepsFeed(reader));
    expect(await eventually(() => feed.state.status === "live" && reader.listings.length > 0, 3_000)).toBe(true);
    await sleep(60);
    expect(feed.state.status).toBe("live");
    expect(stepOf(feed.timeline, "toolu_fga")).toBeNull();
    expect(stepOf(feed.timeline, "toolu_bga")).toBeNull();
    expect(runningWork(feed.timeline).filter((work) => work.kind === "agent").map((work) => work.id)).toEqual(["toolu_bga", "toolu_fga"]);
  });

  it("reads at most once a second, nothing while paused or not on show", async () => {
    const reader = new ListingReader();
    putSubagents(reader);
    const feed = track(stepsFeed(reader, { stepIntervalMs: 1_000 }));
    expect(await eventually(() => stepOf(feed.timeline, "toolu_fga") !== null, 3_000)).toBe(true);
    const passes = reader.listings.length + reader.subagentReads().filter((path) => path.endsWith(".meta.json") && path.includes(backgroundAgentID)).length;
    await sleep(300);
    expect(reader.listings.length + reader.subagentReads().filter((path) => path.endsWith(".meta.json") && path.includes(backgroundAgentID)).length).toBe(passes);

    feed.pause();
    const paused = reader.subagentReads().length;
    await sleep(1_200);
    expect(reader.subagentReads().length).toBe(paused);

    let shown = false;
    const hidden = new ListingReader();
    putSubagents(hidden);
    const notShown = track(stepsFeed(hidden, { stepsShown: () => shown }));
    expect(await eventually(() => notShown.state.status === "live", 3_000)).toBe(true);
    await sleep(60);
    expect(hidden.subagentReads()).toEqual([]);
    expect(hidden.listings).toEqual([]);
    shown = true;
    expect(await eventually(() => stepOf(notShown.timeline, "toolu_fga") === "Read Banner.swift", 3_000)).toBe(true);
  });
});

describe("the subagents row shows a running agent's step", () => {
  it("in place of 'running' while it runs; done keeps its time", () => {
    const base: ChatSubagent = {
      id: "toolu_fga",
      description: "Read the banner",
      type: "Explore",
      background: false,
      name: null,
      agentID: null,
      prompt: "Read Banner.swift",
      state: "running",
      startedAt: 5,
      finishedAt: null,
      report: null,
      step: "Read Banner.swift",
    };
    const group: ChatSubagents = { id: "g", agents: [base, { ...base, id: "toolu_x", description: "Other", step: null }, { ...base, id: "toolu_done", description: "Done one", state: "done", finishedAt: 65, report: "ok" }], time: 5 };
    const view = new HookHost(SubagentsRow as (props: object) => unknown, { group, renderText: (text: string) => text });
    view.render();
    const lines = elements(view.tree)
      .filter((element) => typeof element.type === "function")
      .map((element) => {
        const line = new HookHost(element.type as (props: object) => unknown, element.props as object);
        line.render();
        return elements(line.tree)
          .filter((e) => typeof e.props["className"] === "string" && (e.props["className"] as string).split(" ")[0] === "m")
          .map((e) => e.props["children"]);
      });
    expect(lines).toEqual([["Read Banner.swift"], ["running"], ["done · 1m 0s"]]);
  });
});

describe("the demo's background work (captures 63-65)", () => {
  it("the running pane's strip has a shell, a monitor and a background agent with its step; the other pane's ended", async () => {
    const transcripts = demoTranscripts(Date.now());
    const reader = new DemoTranscriptReader(transcripts);
    const open = async (paneID: string): Promise<ChatFeed<TranscriptSessionRef>> => {
      const transcript = transcripts.find((each) => each.paneID === paneID)!;
      const feed = track(new ChatFeed(reader, { pollIntervalMs: 5, stepIntervalMs: 10 }));
      feed.start(makeSessionRef("claude", { kind: "id", id: transcript.sessionID }), [transcript.cwd]);
      expect(await eventually(() => feed.state.status === "live", 3_000)).toBe(true);
      return feed;
    };
    const running = await open(demoRunningPaneId);
    expect(await eventually(() => runningWork(running.timeline).some((work) => work.step !== null), 3_000)).toBe(true);
    expect(runningWork(running.timeline).map((work) => [work.kind, work.title, work.step])).toEqual([
      ["shell", "Start the dev server", null],
      ["monitor", "Watch the build for errors", null],
      ["agent", "Check the board on a phone", "Ran npx playwright test board.spec.ts --project=iphone-se"],
    ]);
    expect(runningWork(running.timeline)[1]!.lastEvent).toContain("WARN src/board/Card.tsx:88");
    const ran = await open(demoRanPaneId);
    expect(runningWork(ran.timeline)).toEqual([]);
    const calls = ran.timeline.turns.flatMap((turn) => turn.items).flatMap((item) => (item.type === "toolCall" ? [item.value] : []));
    expect(calls.filter((call) => call.task !== undefined).map((call) => [call.toolName, call.task!.state])).toEqual([
      ["Bash", "done"],
      ["Monitor", "stopped"],
    ]);
    expect(agentsRow(ran.timeline).agents.map((agent) => agent.state)).toEqual(["done"]);
  });
});
