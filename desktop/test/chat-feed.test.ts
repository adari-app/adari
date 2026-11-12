// The feed the Chat view drives, against a fake reader (no SSH). HerdrKit
// ChatFeedTests.swift, ported.

import { describe, expect, it } from "vitest";

import { ChatFeed, ChatFolderMatch, liveFailureLimit, type ChatFeedState, type ChatFeedUpdate } from "../src/shared/chat/feed";
import { firstLoadWindow } from "../src/shared/chat/follower";
import { sessionRefFromAgentSession, type AgentSessionLike, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { emptyTimeline, timelineItemCount, turnFoldSummary, turnUserMessage, workingSince } from "../src/shared/chat/model";
import {
  claudeFixture,
  claudePath,
  claudeSession,
  codexFixture,
  codexPath,
  eventually as eventuallyIn,
  FakeTranscriptReader,
  otherSession,
} from "./support/chat-lines";

const eventually = (condition: () => boolean | Promise<boolean>, seconds = 5): Promise<boolean> => eventuallyIn(condition, seconds * 1_000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const claudeAgentSession: AgentSessionLike = { source: "herdr:claude", agent: "claude", kind: "id", value: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f" };
const codexAgentSession: AgentSessionLike = { source: "herdr:codex", agent: "codex", kind: "id", value: "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b" };
const wrongPane = "/Users/demo/code/worktrees/aurora-web-onboarding";

function makeFeed(reader: FakeTranscriptReader, maxItems = 200): ChatFeed<TranscriptSessionRef> {
  return new ChatFeed(reader, { pollIntervalMs: 5, maxItems });
}

/** A pane as Herdr's `AgentInfo` gives it (the fields the feed reads). */
interface Pane {
  readonly agent: string;
  readonly cwd?: string;
  readonly agentSession?: AgentSessionLike;
}

/** ChatFeed.start(pane:foregroundCWD:): the pane's session, checked against its cwd and foreground folder. */
function startPane(feed: ChatFeed<TranscriptSessionRef>, pane: Pane, foregroundCWD?: string): void {
  const ref = pane.agentSession === undefined ? null : sessionRefFromAgentSession(pane.agentSession);
  feed.start(ref, [pane.cwd, foregroundCWD].filter((folder): folder is string => folder !== undefined));
}

function line(text: string, uuid: string, time: string): string {
  return `{"isSidechain":false,"message":{"content":"${text}","role":"user"},"sessionId":"s","timestamp":"${time}","type":"user","uuid":"${uuid}"}\n`;
}

const isState = (state: ChatFeedState, expected: ChatFeedState): boolean =>
  state.status === expected.status && (state.status !== "unavailable" || expected.status !== "unavailable" || state.reason === expected.reason);

/** Collects published updates for assertions. */
class UpdateLog {
  readonly updates: ChatFeedUpdate[] = [];
  readonly unsubscribe: () => void;

  constructor(feed: ChatFeed<TranscriptSessionRef>) {
    this.unsubscribe = feed.subscribe((update) => this.updates.push(update));
  }

  get states(): ChatFeedState[] {
    return this.updates.map((update) => update.state);
  }
}

const unavailable = (reason: "noSession" | "notFound" | "unreadable" | "unrecognisedFormat" | "sessionMismatch" | "codexOtherFolder"): ChatFeedState => ({
  status: "unavailable",
  reason,
});

describe("ChatFeed: unavailable", () => {
  it("no usable session is unavailable without touching the reader", async () => {
    const reader = new FakeTranscriptReader();
    const feed = makeFeed(reader);
    for (const session of [
      null,
      { source: "herdr:grok", agent: "grok", kind: "id", value: "abcdefgh1234" },
      { source: "herdr:claude", agent: "claude", kind: "id", value: "bad id;" },
    ] as (AgentSessionLike | null)[]) {
      feed.start(session === null ? null : sessionRefFromAgentSession(session));
      expect(await eventually(() => isState(feed.state, unavailable("noSession"))), JSON.stringify(session)).toBe(true);
    }
    expect(reader.calls).toEqual([]);
  });

  it("a pane without a session falls back and a pane with one is followed", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, claudeFixture(), claudePath);
    const feed = makeFeed(reader);
    startPane(feed, { agent: "codex" });
    expect(await eventually(() => isState(feed.state, unavailable("noSession")))).toBe(true);
    startPane(feed, { agent: "claude", agentSession: claudeAgentSession });
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    expect(feed.path).toBe(claudePath);
    feed.stop();
  });

  it("not found when nothing matches or the file is gone", async () => {
    const reader = new FakeTranscriptReader();
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => isState(feed.state, unavailable("notFound")))).toBe(true);
    reader.setLocated(claudePath); // named, but no such file
    feed.start(claudeSession);
    expect(await eventually(() => isState(feed.state, unavailable("notFound")))).toBe(true);
  });

  it("unreadable when locating or the first load fails", async () => {
    const reader = new FakeTranscriptReader();
    reader.failLocate(true);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => isState(feed.state, unavailable("unreadable")))).toBe(true);
    reader.failLocate(false);
    reader.put(claudePath, "{}\n", claudePath);
    reader.failNextSizes(1);
    feed.start(claudeSession);
    expect(await eventually(() => isState(feed.state, unavailable("unreadable")))).toBe(true);
  });

  it("more than half unparseable is unrecognised and exactly half is not", async () => {
    const reader = new FakeTranscriptReader();
    const good = line("hello", "u1", "2026-11-01T03:00:00.000Z");
    reader.put(claudePath, "not json\n".repeat(101) + good.repeat(99), claudePath);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => isState(feed.state, unavailable("unrecognisedFormat")))).toBe(true);
    reader.put(claudePath, "not json\n".repeat(100) + good.repeat(100), claudePath);
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    feed.stop();
  });

  it("a Codex rollout read as Claude is unrecognised", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, codexFixture(), claudePath);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => isState(feed.state, unavailable("unrecognisedFormat")))).toBe(true);
  });
});

describe("ChatFeed: live", () => {
  it("loads, then follows growth and publishes updates", async () => {
    const reader = new FakeTranscriptReader();
    // The fixture's last line has no newline; a live file's last whole line does.
    reader.put(claudePath, claudeFixture() + "\n", claudePath);
    const feed = makeFeed(reader);
    const seen = new UpdateLog(feed);

    feed.start(claudeSession);
    expect(await eventually(() => feed.timeline.turns.length === 3)).toBe(true);
    expect(workingSince(feed.timeline)).not.toBeNull();

    reader.append(
      claudePath,
      [
        '{"isSidechain":false,"message":{"content":[{"content":"Build complete!","is_error":false,"tool_use_id":"toolu_build","type":"tool_result"}],"role":"user"},"sessionId":"s","timestamp":"2026-11-01T02:21:00.000Z","type":"user","uuid":"u10"}',
        '{"isSidechain":false,"message":{"content":[{"text":"Both screenshots match now.","type":"text"}],"role":"assistant","stop_reason":"end_turn"},"sessionId":"s","timestamp":"2026-11-01T02:21:05.000Z","type":"assistant","uuid":"a13"}',
        "",
      ].join("\n"),
    );
    expect(await eventually(() => feed.timeline.turns.at(-1)?.isFinished === true)).toBe(true);
    expect(turnFoldSummary(feed.timeline.turns.at(-1)!)).toBe("Ran 1 command, ran 1 search");
    expect(feed.parseStats.lines).toBe(34);

    expect(await eventually(() => seen.states.some((s) => s.status === "loading") && seen.states.some((s) => s.status === "live"))).toBe(true);
    expect(seen.states[0]).toEqual({ status: "loading" });
    seen.unsubscribe();
    feed.stop();
  });

  it("a partial line waits for its end", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, line("first", "u1", "2026-11-01T03:00:00.000Z"), claudePath);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => timelineItemCount(feed.timeline) === 1)).toBe(true);
    const second = line("sécond 🐑", "u2", "2026-11-01T03:00:05.000Z");
    const bytes = new TextEncoder().encode(second);
    const split = bytes.indexOf(0xf0) + 2;
    reader.appendBytes(claudePath, bytes.slice(0, split));
    await sleep(40);
    expect(timelineItemCount(feed.timeline)).toBe(1);
    reader.appendBytes(claudePath, bytes.slice(split));
    expect(await eventually(() => turnUserMessage(feed.timeline.turns.at(-1)!)?.text === "sécond 🐑")).toBe(true);
    feed.stop();
  });

  it("a replaced file starts over", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, claudeFixture(), claudePath);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => feed.timeline.turns.length === 3)).toBe(true);
    reader.put(claudePath, line("fresh start", "n1", "2026-11-01T04:00:00.000Z"), claudePath);
    expect(
      await eventually(() => {
        const texts = feed.timeline.turns.map((turn) => turnUserMessage(turn)?.text);
        return texts.length === 1 && texts[0] === "fresh start";
      }),
    ).toBe(true);
    expect(feed.timeline.title, "nothing of the old file is kept").toBeNull();
    feed.stop();
  });

  it("the first load reads only the last four megabytes and keeps the newest 200 items", async () => {
    const reader = new FakeTranscriptReader();
    const padding = "x".repeat(1_000);
    const parts: string[] = [];
    let length = 0;
    let index = 0;
    while (length < 5 * 1_024 * 1_024) {
      const next = line(`message ${index} ${padding}`, `u${index}`, "2026-11-01T03:00:00.000Z");
      parts.push(next);
      length += new TextEncoder().encode(next).length;
      index += 1;
    }
    const content = parts.join("");
    reader.put(claudePath, content, claudePath);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    const reads = reader.calls.filter((call) => call.startsWith("read "));
    expect(reads[0]).toBe(`read ${length - firstLoadWindow} ${firstLoadWindow}`);
    expect(timelineItemCount(feed.timeline)).toBe(200);
    expect(turnUserMessage(feed.timeline.turns.at(-1)!)?.text).toBe(`message ${index - 1} ${padding}`);
    feed.stop();
  });

  it("one failed poll while live is tolerated and three in a row are not", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, line("hi", "u1", "2026-11-01T03:00:00.000Z"), claudePath);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    reader.failNextSizes(1);
    expect(await eventually(() => reader.pendingSizeFailures === 0)).toBe(true);
    await sleep(30);
    expect(feed.state).toEqual({ status: "live" });
    reader.failNextSizes(liveFailureLimit);
    expect(await eventually(() => isState(feed.state, unavailable("unreadable")))).toBe(true);
  });
});

describe("ChatFeed: stop and switching panes", () => {
  it("falling behind reads on without waiting for the poll", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, line("start", "u0", "2026-11-01T03:00:00.000Z"), claudePath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    const padding = "y".repeat(1_000);
    const parts: string[] = [];
    let length = 0;
    let index = 1;
    while (length < 3 * 1_024 * 1_024 + 500_000) {
      // more than one 1 MB poll window
      const next = line(`burst ${index} ${padding}`, `b${index}`, "2026-11-01T03:00:01.000Z");
      parts.push(next);
      length += next.length;
      index += 1;
    }
    reader.append(claudePath, parts.join(""));
    const last = `burst ${index - 1} ${padding}`;
    // One poll interval plus slack, well under the four intervals of one read a poll.
    expect(await eventually(() => turnUserMessage(feed.timeline.turns.at(-1)!)?.text === last, 2.5)).toBe(true);
    const reads = reader.calls.filter((call) => call.startsWith("read "));
    // Past one poll window the feed reads in catch-up windows of 4 MB.
    expect(reads.length, "the first load, then one catch-up read").toBe(2);
    feed.stop();
  });

  it("no reads after stop", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, claudeFixture(), claudePath);
    const feed = makeFeed(reader);
    const seen = new UpdateLog(feed);
    feed.start(claudeSession);
    expect(await eventually(() => reader.calls.filter((call) => call === "size").length >= 3), "it polls the size while live").toBe(true);
    feed.stop();
    const atStop = reader.calls.length;
    await sleep(60); // a dozen poll intervals
    expect(reader.calls.length).toBe(atStop);
    expect(feed.state).toEqual({ status: "idle" });
    expect(feed.timeline).toEqual(emptyTimeline);
    expect(
      await eventually(() => {
        const last = seen.updates.at(-1);
        return last !== undefined && last.state.status === "idle" && last.timeline === emptyTimeline;
      }),
      "stop publishes idle",
    ).toBe(true);
    seen.unsubscribe();
  });

  it("stop during a read in flight publishes nothing and reads no more", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, claudeFixture(), claudePath);
    reader.holdReads(true);
    const feed = makeFeed(reader);
    const seen = new UpdateLog(feed);
    feed.start(claudeSession);
    expect(await eventually(() => reader.readsWaiting === 1)).toBe(true);
    feed.stop();
    const atStop = reader.calls.length;
    reader.holdReads(false);
    await sleep(60);
    expect(reader.calls.length, "the read in flight finished, and nothing followed it").toBe(atStop);
    expect(feed.state).toEqual({ status: "idle" });
    expect(feed.timeline).toEqual(emptyTimeline);
    expect(seen.states.some((state) => state.status === "live"), "the stopped pane's load was never published").toBe(false);
    seen.unsubscribe();
  });

  it("restarting the same session is ignored and another session replaces it", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, claudeFixture(), claudePath);
    reader.put(codexPath, codexFixture(), null);
    const feed = makeFeed(reader);
    feed.start(claudeSession);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    feed.start(claudeSession);
    expect(reader.calls.filter((call) => call === "locate").length).toBe(1);

    reader.setLocated(codexPath);
    feed.start(otherSession);
    expect(
      await eventually(() => {
        const first = feed.timeline.turns[0];
        return first !== undefined && turnUserMessage(first)?.text === "Summarise the README";
      }),
    ).toBe(true);
    reader.clearCalls();
    await sleep(30);
    expect(reader.readPaths.includes(claudePath), "only the open pane is followed").toBe(false);
    feed.stop();
  });
});

describe("ChatFeed: the transcript's folder must be the pane's", () => {
  // A Codex rollout's own header names another folder: codexOtherFolder (the line names it).
  async function assertMismatchShowsNothing(reader: FakeTranscriptReader, start: (feed: ChatFeed<TranscriptSessionRef>) => void, reason: "sessionMismatch" | "codexOtherFolder" = "sessionMismatch"): Promise<void> {
    const feed = makeFeed(reader);
    const seen = new UpdateLog(feed);
    start(feed);
    expect(await eventually(() => isState(feed.state, unavailable(reason)))).toBe(true);
    expect(await eventually(() => seen.states.length > 0 && isState(seen.states.at(-1)!, unavailable(reason)))).toBe(true);
    expect(seen.updates.some((update) => update.state.status === "live"), "never live").toBe(false);
    expect(seen.updates.every((update) => update.timeline.turns.length === 0 && update.timeline.title === null), "no timeline published").toBe(true);
    expect(feed.timeline).toEqual(emptyTimeline);
    expect(feed.transcriptFolder).toBe("/Users/fixture/proj");
    await sleep(30);
    expect(isState(feed.state, unavailable(reason)), "it stops following").toBe(true);
    seen.unsubscribe();
  }

  it("a Codex rollout from another folder is a mismatch and shows nothing", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(codexPath, codexFixture(), codexPath);
    await assertMismatchShowsNothing(reader, (feed) => startPane(feed, { agent: "codex", cwd: wrongPane, agentSession: codexAgentSession }), "codexOtherFolder");
    expect(reader.calls.filter((call) => call.startsWith("read ")).length, "no polling after the mismatch").toBe(1);
  });

  it("a Claude session from another folder is a mismatch and shows nothing", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, claudeFixture() + "\n", claudePath);
    await assertMismatchShowsNothing(reader, (feed) => startPane(feed, { agent: "claude", cwd: "/Users/dev/Desktop/Studio", agentSession: claudeAgentSession }));
  });

  it("a folder first given after going live is checked before its lines show", async () => {
    const reader = new FakeTranscriptReader();
    const bookkeeping = '{"mode":"normal","sessionId":"s","type":"mode"}\n';
    reader.put(claudePath, bookkeeping, claudePath);
    const feed = makeFeed(reader);
    const seen = new UpdateLog(feed);
    feed.start(claudeSession, [wrongPane]);
    expect(await eventually(() => feed.state.status === "live"), "no folder in the file yet: live, as before").toBe(true);
    reader.append(
      claudePath,
      '{"cwd":"/Users/dev/Desktop/Studio","isSidechain":false,"message":{"content":"secret plan","role":"user"},"sessionId":"s","timestamp":"2026-11-01T03:00:00.000Z","type":"user","uuid":"u1"}\n',
    );
    expect(await eventually(() => isState(feed.state, unavailable("sessionMismatch")))).toBe(true);
    expect(seen.updates.every((update) => timelineItemCount(update.timeline) === 0), "the other pane's message never showed").toBe(true);
    seen.unsubscribe();
  });

  it("subfolders either way round and a trailing slash match", async () => {
    for (const folders of [["/Users/fixture"], ["/Users/fixture/proj/App/Views"], ["/Users/fixture/proj/"], ["/Users/fixture/proj//"]]) {
      const reader = new FakeTranscriptReader();
      reader.put(codexPath, codexFixture(), codexPath);
      const feed = makeFeed(reader);
      feed.start(otherSession, folders);
      expect(
        await eventually(() => {
          const first = feed.timeline.turns[0];
          return first !== undefined && turnUserMessage(first)?.text === "Summarise the README";
        }),
        JSON.stringify(folders),
      ).toBe(true);
      feed.stop();
    }
  });

  it("the foreground folder matches when the cwd does not", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(codexPath, codexFixture(), codexPath);
    const feed = makeFeed(reader);
    startPane(feed, { agent: "codex", cwd: wrongPane, agentSession: codexAgentSession }, "/Users/fixture/proj");
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    feed.stop();
  });

  it("a folder sharing only a prefix is a mismatch", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(codexPath, codexFixture(), codexPath);
    const feed = makeFeed(reader);
    feed.start(otherSession, ["/Users/fixture/project"]);
    expect(await eventually(() => isState(feed.state, unavailable("codexOtherFolder")))).toBe(true);
  });

  it("without pane folders or a transcript folder nothing is checked", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(codexPath, codexFixture(), codexPath);
    const feed = makeFeed(reader);
    feed.start(otherSession);
    expect(await eventually(() => feed.state.status === "live"), "start with no pane goes live as before").toBe(true);
    expect(feed.transcriptFolder).toBe("/Users/fixture/proj");
    feed.stop();

    const noMeta = codexFixture()
      .split("\n")
      .filter((entry) => entry.length > 0 && !entry.includes('"type":"session_meta"'))
      .join("\n");
    reader.put(codexPath, noMeta, codexPath);
    // A Codex rollout whose first line is no session_meta proves no folder: with pane folders known
    // it is not shown; with none, nothing is checked.
    const other = makeFeed(reader);
    other.start(otherSession, [wrongPane]);
    expect(await eventually(() => isState(other.state, unavailable("unrecognisedFormat"))), "no header: not shown").toBe(true);
    expect(other.timeline.turns.length).toBe(0);
    other.stop();
    const none = makeFeed(reader);
    none.start(otherSession);
    expect(
      await eventually(() => {
        const first = none.timeline.turns[0];
        return first !== undefined && turnUserMessage(first)?.text === "Summarise the README";
      }),
      "no pane folders: live, as before",
    ).toBe(true);
    none.stop();
  });

  it("restarting with other pane folders is a new follow", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(codexPath, codexFixture(), codexPath);
    const feed = makeFeed(reader);
    feed.start(otherSession, ["/Users/fixture/proj"]);
    expect(await eventually(() => feed.state.status === "live")).toBe(true);
    feed.start(otherSession, ["/Users/fixture/proj"]);
    expect(reader.calls.filter((call) => call === "locate").length, "the same session and folders is ignored").toBe(1);
    feed.start(otherSession, [wrongPane]);
    expect(await eventually(() => isState(feed.state, unavailable("codexOtherFolder")))).toBe(true);
  });

  it("the folder rule", () => {
    expect(ChatFolderMatch.matches("/a/b", "/a/b")).toBe(true);
    expect(ChatFolderMatch.matches("/a/b/", "/a/b")).toBe(true);
    expect(ChatFolderMatch.matches("/a/b", "/a/b/c")).toBe(true);
    expect(ChatFolderMatch.matches("/a/b/c", "/a/b")).toBe(true);
    expect(ChatFolderMatch.matches("/", "/a"), "everything is inside the root").toBe(true);
    expect(ChatFolderMatch.matches("/a/b", "/a/bc")).toBe(false);
    expect(ChatFolderMatch.matches("/a/bc", "/a/b")).toBe(false);
    expect(ChatFolderMatch.matches("/a/b", "/x/b")).toBe(false);
    expect(ChatFolderMatch.matches("", "/a")).toBe(false);
    expect(ChatFolderMatch.normalised("/a/b///")).toBe("/a/b");
    expect(ChatFolderMatch.normalised("/")).toBe("/");
    expect(ChatFolderMatch.transcript("/a", [])).toBe(false);
    expect(ChatFolderMatch.transcript("/a", ["/x", "/a/"])).toBe(true);
  });
});
