// Main's side of taking a message back: a message of the user's still waiting in Claude Code 2.1.322's queue is taken back with
// Up, then Ctrl+U (never Escape, never Return), a screen read before (the queue shows) and after (the input row
// empty, the queued line gone). Anything else presses nothing, or leaves what it found and says so. Fake screens
// copied from a live read of Claude Code's screen (support/claude-queue-screens.ts); no real Herdr.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { boundBoxSite, SentTexts, takeBackQueued, type BoxRun, type ClaudeBoxSite, type TakeBackFor } from "../src/main/herdr/claude-box";
import { sendBound, type SendSite } from "../src/main/herdr/send";
import { pullClearKeys, readClaudeScreenFacts, takeBackTexts } from "../src/shared/claude-screen";
import { IPC } from "../src/shared/ipc-contract";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { FakeClaudeQueue, queueScreen } from "./support/claude-queue-screens";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { sentTexts } = await import("../src/main/herdr/claude-box");

function siteOf(claude: FakeClaudeQueue): ClaudeBoxSite {
  return {
    read: async () => claude.read(),
    keys: async (keys) => claude.keys(keys),
    wait: async () => undefined,
  };
}

// With the pane's queue record (Claude Code's queue-operation lines, the fake's transcript).
const forTexts = (claude: FakeClaudeQueue, asked: readonly string[], own: readonly string[] = asked, forgotten: string[] = []): TakeBackFor => ({
  asked,
  own,
  forget: (text) => void forgotten.push(text),
  record: claude.record(),
});

describe("the 2.1.322 screen", () => {
  it("reads the queue by its send-now line and the box's hint, the box empty", () => {
    expect(readClaudeScreenFacts(queueScreen({ queued: ["abc"], input: "", working: true, dialog: false }))).toEqual({ draft: "", working: true, queued: true });
  });

  it("after Up the queue is in the input row and no queue shows", () => {
    expect(readClaudeScreenFacts(queueScreen({ queued: [], input: "abc", working: true, dialog: false }))).toEqual({ draft: "abc", working: true, queued: false });
  });

  it("clears one row with Ctrl+U alone, more rows with Backspace and Ctrl+U between", () => {
    expect(pullClearKeys("abc")).toEqual(["ctrl+u"]);
    expect(pullClearKeys("abc\ndef")).toEqual(["ctrl+u", "Backspace", "ctrl+u"]);
  });
});

describe("takeBackQueued", () => {
  it("Esc with a queued message: Up, then ctrl+u, never Escape or Return, and the text comes back", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const forgotten: string[] = [];
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"], ["abc"], forgotten));
    expect(result).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(claude.log).toEqual([["read"], ["keys", ["Up"]], ["read"], ["keys", ["ctrl+u"]], ["read"]]);
    expect(forgotten).toEqual(["abc"]);
    // The turn runs on, nothing went to Claude, its box and queue are empty.
    expect(claude.state).toMatchObject({ queued: [], input: "", working: true });
    claude.turnEnds();
    expect(claude.sent).toEqual([]);
  });

  it("no queue on screen (it was delivered mid-turn, or the turn ended): nothing pressed, Esc stops as before", async () => {
    const delivered = new FakeClaudeQueue({ queued: [] });
    expect(await takeBackQueued(siteOf(delivered), forTexts(delivered, ["abc"]))).toEqual({ type: "none" });
    expect(delivered.keysSent()).toEqual([]);
    const ended = new FakeClaudeQueue({ queued: [], working: false });
    expect(await takeBackQueued(siteOf(ended), forTexts(ended, ["abc"]))).toEqual({ type: "none" });
    expect(ended.keysSent()).toEqual([]);
  });

  it("the user's own typing in Claude's input row: no key at all, said plainly", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"], input: "typed in the terminal" });
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"]))).toEqual({ type: "left", note: takeBackTexts.boxHasText, pressed: false });
    expect(claude.keysSent()).toEqual([]);
  });

  it("the input row not empty after the pull (other text came with it): left where it is and said, never Return", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    // A line typed in the terminal and queued there too (not the user's from Chat).
    claude.state.queued.push("from the terminal");
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"]));
    // Claude Code's record shows the pull held Terminal's line too: nothing cleared.
    expect(result).toEqual({ type: "left", note: takeBackTexts.alsoTerminal, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
    expect(claude.state.input).toBe("abc\nfrom the terminal");
  });

  it("a row that will not clear and is not ours: the user's text comes back all the same, the rest is left and said, no Return", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const original = claude.keys.bind(claude);
    claude.keys = (keys) => {
      original(keys);
      // The user's keystroke in the terminal lands in the row as Ctrl+U goes: what is left is not ours.
      if (keys[0] === "ctrl+u") claude.state.input = "X";
    };
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"]));
    // Ctrl+U went after the record proved the pull: "abc" may be gone from the row,
    // so it comes back to Chat (never nowhere), and the note says to check Claude's box.
    expect(result).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.takenCheckBox });
    expect(claude.state.input).toBe("X");
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(claude.keysSent()).not.toContain("Enter");
  });

  it("a piece of ours left after Ctrl+U (a wrapped row): one more round for what is left", async () => {
    const claude = new FakeClaudeQueue({ queued: ["first half second half"] });
    let rounds = 0;
    const original = claude.keys.bind(claude);
    claude.keys = (keys) => {
      original(keys);
      // The first Ctrl+U takes only the wrapped tail.
      if (keys[0] === "ctrl+u" && rounds++ === 0) claude.state.input = "first half";
    };
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["first half second half"]));
    expect(result.type).toBe("taken");
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u", "ctrl+u"]);
  });

  it("two of the user's queued: both come back when the pull shows exactly those two", async () => {
    const claude = new FakeClaudeQueue({ queued: ["one", "two"] });
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["one", "two"]));
    expect(result).toEqual({ type: "taken", texts: ["one", "two"], note: takeBackTexts.taken });
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u", "Backspace", "ctrl+u"]);
    expect(claude.state.input).toBe("");
  });

  it("two of the user's sends, only the newer still queued (the older was delivered): the newer comes back alone", async () => {
    const claude = new FakeClaudeQueue({ queued: ["two"] });
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["one", "two"]));
    expect(result).toEqual({ type: "taken", texts: ["two"], note: takeBackTexts.taken });
  });

  it("two queued but the pull is not exactly the user's texts: nothing more is pressed and the note says why", async () => {
    const claude = new FakeClaudeQueue({ queued: ["one", "someone else's"] });
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["one", "two"]));
    expect(result).toEqual({ type: "left", note: takeBackTexts.alsoTerminal, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
  });

  it("a dialog on screen: never a key", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"], dialog: true });
    expect((await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"]))).type).not.toBe("taken");
    expect(claude.keysSent()).toEqual([]);
  });

  it("a text Chat did not send to this run: no key", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"], []))).toEqual({ type: "left", note: takeBackTexts.notOurs, pressed: false });
    expect(claude.keysSent()).toEqual([]);
  });

  it("the binding fails between Up and Ctrl+U: Ctrl+U is never written, and it says so", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    let holds = true;
    const site = boundBoxSite(siteOf(claude), () => holds);
    claude.beforeKey = (keys) => {
      if (keys[0] === "Up") holds = false;
    };
    expect(await takeBackQueued(site, forTexts(claude, ["abc"]))).toEqual({ type: "left", note: takeBackTexts.changed, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
  });

  it("then the edited text goes as one message: only abcd ever reaches Claude", async () => {
    const claude = new FakeClaudeQueue({ queued: [] });
    const sent = new SentTexts();
    const writer = {};
    const site: SendSite = {
      writer: {
        prompt: async (_pane, text) => {
          claude.prompt(text);
          sent.record(writer, "w1:p1", text);
        },
        sendInput: async () => undefined,
        sendText: async () => undefined,
        agentKeys: async (_pane, keys) => claude.keys(keys),
      },
      fresh: async () => true,
      pane: () => ({ paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "working", revision: 1 }) as never,
      agent: () => ({ paneID: "w1:p1", agent: "claude", terminalID: "t1" }) as never,
      box: { site: siteOf(claude), own: () => sent.recent(writer, "w1:p1"), sent: () => undefined },
    };
    const binding = { terminalID: "t1", isAgent: true, kind: "claude", session: null };
    await sendBound(site, "w1:p1", "abc", binding);
    expect(claude.state.queued).toEqual(["abc"]);
    const result = await takeBackQueued(siteOf(claude), { asked: ["abc"], own: sent.recent(writer, "w1:p1"), forget: (text) => void sent.forget(writer, "w1:p1", text), record: claude.record() });
    expect(result.type).toBe("taken");
    await sendBound(site, "w1:p1", "abcd", binding);
    claude.turnEnds();
    expect(claude.sent).toEqual(["abcd"]);
    expect(claude.keysSent()).not.toContain("Escape");
  });
});

// MARK: - main's handler: bound to the pane, terminal, agent and run as the send was

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

function paneInfo(terminalID = "t-7"): TopologyPaneInfo {
  return { paneID: "w1:p1", terminalID, workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "working", revision: 1 };
}

function agentInfo(session = "esc-takeback-s1"): AgentInfo {
  return { paneID: "w1:p1", agent: "claude", agentStatus: "working", terminalID: "t-7", stateChangeSeq: 12, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: session } };
}

const binding = {
  terminalID: "t-7",
  kind: "claude",
  session: "esc-takeback-s1",
  episode: { status: "working", seq: "12", since: null },
  incarnation: 1,
  connection: 3,
  epoch: 7,
  name: "Claude Code",
};

function machine(claude: FakeClaudeQueue, now: { pane: TopologyPaneInfo; agent: AgentInfo; arrival: number }) {
  const backend = {
    agentKeys: async (_paneID: string, keys: readonly string[]) => claude.keys(keys),
    promptIO: () => ({ paneRead: async () => claude.read(), paneSendKeys: async () => undefined }),
    // The machine's transcript reader (the fake session's file).
    transcripts: () => claude.reader(),
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => now.pane,
    agent: () => now.agent,
    run: () => ({ connection: 3, arrival: now.arrival }),
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
    refresh: async () => undefined,
  };
  registerIpc({ hosts } as never);
  const handler = registered.handles.get(IPC.paneTakeBack)!;
  return { backend, take: (texts: readonly string[]) => handler(event, "mac-mini", "w1:p1", binding, texts) as Promise<unknown> };
}

const runOf = (arrival: number, session = "esc-takeback-s1"): BoxRun => ({ terminalID: "t-7", session, arrival, epoch: null });

describe("main's take-back handler", () => {
  beforeEach(() => undefined);

  it("takes back a send of this run", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const m = machine(claude, { pane: paneInfo(), agent: agentInfo(), arrival: 2 });
    sentTexts.record(m.backend, "w1:p1", "abc", runOf(2));
    expect(await m.take(["abc"])).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    // It is Chat's again: no longer one of the pane's sends.
    expect(sentTexts.recent(m.backend, "w1:p1", runOf(2))).toEqual([]);
  });

  it("a run changed since the send (a new agent in the pane): refused, no key", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const m = machine(claude, { pane: paneInfo(), agent: agentInfo(), arrival: 3 });
    sentTexts.record(m.backend, "w1:p1", "abc", runOf(2));
    expect(await m.take(["abc"])).toEqual({ type: "left", note: takeBackTexts.notOurs, pressed: false });
    expect(claude.keysSent()).toEqual([]);
  });

  it("a pane changed since the send (another terminal there): refused, no read and no key", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const m = machine(claude, { pane: paneInfo("t-9"), agent: agentInfo(), arrival: 2 });
    sentTexts.record(m.backend, "w1:p1", "abc", runOf(2));
    // A refusal with its note, never `none` (which would stop on the same press).
    expect(await m.take(["abc"])).toEqual({ type: "left", note: takeBackTexts.notOurs, pressed: false });
    expect(claude.log).toEqual([]);
  });

  it("another session in the pane: the keys are called off before Up", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const m = machine(claude, { pane: paneInfo(), agent: agentInfo("esc-takeback-s2"), arrival: 2 });
    sentTexts.record(m.backend, "w1:p1", "abc", runOf(2, "esc-takeback-s2"));
    const result = (await m.take(["abc"])) as { type: string };
    expect(result.type).toBe("left");
    expect(claude.keysSent()).toEqual([]);
  });

  it("refuses a malformed request", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const m = machine(claude, { pane: paneInfo(), agent: agentInfo(), arrival: 2 });
    const handler = registered.handles.get(IPC.paneTakeBack)!;
    await expect(Promise.resolve().then(() => handler(event, "mac-mini", "w1:p1", binding, "abc"))).rejects.toThrow("bad request");
    await expect(Promise.resolve().then(() => handler(event, "mac-mini", "w1:p1", binding, []))).rejects.toThrow("bad request");
    void m;
  });
});
