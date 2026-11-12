// Esc take-back with repeated copies. One delivery Claude Code writes twice (its `remove` absorbed_mid_turn line
// and the user's ordinary user line) proves one delivered copy, never two: with two identical queued copies, the
// copy Up really pulled is never erased and never lost.
// A Send's cleanup of a message with pictures counts each raw image path against how many times the old send holds
// it, the chips standing for the rest: Terminal's `abc /a.png /a.png` is never Chat's `abc /a.png /b.png`. Fake
// screens, a fake session transcript (support/claude-queue-screens.ts) and a fake Herdr only; nothing is read from a
// real session.

import { describe, expect, it, vi } from "vitest";

import { beforeSend, takeBackQueued, type BoxRun, type ClaudeBoxSite, type TakeBackFor } from "../src/main/herdr/claude-box";
import { queueAccount } from "../src/shared/claude-queue-record";
import { claudeBoxTexts, showsOwnSend, takeBackTexts, type QueuedTakeBack } from "../src/shared/claude-screen";
import { IPC } from "../src/shared/ipc-contract";
import { PendingMessages } from "../src/shared/chat/pending";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { FakeClaudeQueue, queueLine, userLine } from "./support/claude-queue-screens";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { sentTexts, boxChecks } = await import("../src/main/herdr/claude-box");
const { TakeBacks } = await import("../src/renderer/chat/take-back");

const session = "esc-takeback-s1";
const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const run: BoxRun = { terminalID: "t-7", session, arrival: 2, epoch: "9" };
const binding = {
  terminalID: "t-7",
  kind: "claude",
  session,
  episode: { status: "working", seq: "12", since: null },
  incarnation: 1,
  connection: 3,
  epoch: 7,
  name: "Claude Code",
};

function siteOf(claude: FakeClaudeQueue): ClaudeBoxSite {
  return { read: async () => claude.read(), keys: async (keys) => claude.keys(keys), wait: async () => undefined };
}

const forTexts = (claude: FakeClaudeQueue, asked: readonly string[]): TakeBackFor => ({ asked, own: asked, forget: () => undefined, record: claude.record() });

const isPopAll = (line: string): boolean => (JSON.parse(line) as { operation?: string }).operation === "popAll";

const absorbed = (content: string, extra: Record<string, unknown> = {}): string => queueLine("remove", { reason: "absorbed_mid_turn", content, ...extra });

interface Now {
  pane: TopologyPaneInfo;
  agent: AgentInfo;
}

/** A machine as main's handlers see it, its Claude pane `claude` (Herdr's agent.prompt joins text left in the row). */
function machine(claude: FakeClaudeQueue, sends: readonly string[]) {
  const now: Now = {
    pane: { paneID: "w1:p1", terminalID: "t-7", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "working", revision: 1 },
    agent: { paneID: "w1:p1", agent: "claude", agentStatus: "working", terminalID: "t-7", stateChangeSeq: 12, turnEpoch: 9, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: session } },
  };
  const backend = {
    agentKeys: async (_paneID: string, keys: readonly string[]) => claude.keys(keys),
    promptIO: () => ({ paneRead: async () => claude.read(), paneSendKeys: async () => undefined }),
    prompt: async (_paneID: string, text: string) => {
      const row = claude.state.input;
      claude.state.input = "";
      claude.prompt(row + text);
    },
    sendInput: async () => undefined,
    sendText: async () => undefined,
    transcripts: () => claude.reader(),
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => now.pane,
    agent: () => now.agent,
    run: () => ({ connection: 3, arrival: 2 }),
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
    fresh: async () => true,
    current: async () => true,
    eventsLive: () => true,
    refresh: async () => undefined,
  };
  registerIpc({ hosts } as never);
  for (const text of sends) sentTexts.record(backend, "w1:p1", text, run);
  // The box was read since the last Esc: a Send reads it again only when something marks it due.
  boxChecks.checked(backend, "w1:p1");
  const take = (texts: readonly string[] = sends) => registered.handles.get(IPC.paneTakeBack)!(event, "mac-mini", "w1:p1", binding, texts) as Promise<QueuedTakeBack>;
  const send = (text: string) =>
    registered.handles.get(IPC.paneSend)!(event, "mac-mini", "w1:p1", text, { terminalID: "t-7", isAgent: true, kind: "claude", session }) as Promise<void>;
  const stop = () => registered.handles.get(IPC.paneStop)!(event, "mac-mini", "w1:p1", binding) as Promise<string | null>;
  return { claude, take, send, stop };
}

/** The page's take-back runner (take-back.ts) over a machine: the user's bubbles, Chat's box and its note; main's answers kept. */
function pageFor(m: ReturnType<typeof machine>, texts: readonly string[]) {
  const pending = new PendingMessages();
  const key = "mac-mini/w1:p1";
  pending.observe(key, { turns: [] } as unknown as ChatTimeline);
  for (const text of texts) pending.delivered(pending.add(key, text, Date.now(), { terminalID: "t-7", session }));
  let text = "";
  let note = "";
  const answers: QueuedTakeBack[] = [];
  const deps = {
    bridge: {
      takeBackQueued: async () => {
        const answer = await m.take(texts);
        answers.push(answer);
        return answer;
      },
    },
    pending,
    drafts: { get: () => ({ text }), edit: (_: string, next: string) => void (text = next) },
    landing: () => undefined,
    note: (_: string, next: string) => void (note = next),
  };
  const items = () => pending.forPane(key);
  /** A Send from Chat: its bubble, then main's Send. */
  const sendFromChat = async (next: string) => {
    const id = pending.add(key, next, Date.now(), { terminalID: "t-7", session });
    await m.send(next);
    pending.delivered(id);
  };
  return { pending, key, answers, text: () => text, note: () => note, sendFromChat, take: () => new TakeBacks().run(deps, "mac-mini", "w1:p1", key, binding, items()) };
}

const user = (id: string, text: string) => ({ type: "user", value: { id, text, attachments: [], time: Date.now() / 1_000 } });

/** How many copies of `text` are anywhere: Chat's box, a waiting bubble, Claude's row or queue, or what Claude received. */
function copiesOf(text: string, m: ReturnType<typeof machine>, page: ReturnType<typeof pageFor>): number {
  const lines = (value: string): number => value.split("\n").filter((line) => line === text).length;
  return (
    lines(page.text()) +
    page.pending.forPane(page.key).filter((item) => item.text === text).length +
    lines(m.claude.state.input) +
    m.claude.state.queued.reduce((sum, queued) => sum + lines(queued), 0) +
    m.claude.sent.reduce((sum, sent) => sum + lines(sent), 0)
  );
}

// MARK: - one delivery is one proof

describe("one delivered text represented twice in the record is one delivery", () => {
  it("one delivered text represented twice (its remove and its user line) proves one copy, not two", () => {
    const asked = ["repeat", "repeat"];
    expect(queueAccount([absorbed("repeat"), userLine("repeat")], asked).delivered).toEqual([0]);
    // The queue event's ids, and the order of the two lines, change nothing.
    expect(queueAccount([absorbed("repeat", { commandUuid: "only-one", deliveryId: "only-one" }), userLine("repeat")], asked).delivered).toEqual([0]);
    expect(queueAccount([userLine("repeat"), absorbed("repeat")], asked).delivered).toEqual([0]);
  });

  it("the larger count of either kind, never their sum", () => {
    const asked = ["repeat", "repeat", "repeat"];
    expect(queueAccount([absorbed("repeat"), userLine("repeat"), absorbed("repeat")], asked).delivered).toEqual([0, 1]);
    expect(queueAccount([absorbed("repeat"), userLine("repeat"), userLine("repeat")], asked).delivered).toEqual([0, 1]);
    expect(queueAccount([absorbed("repeat"), userLine("repeat"), absorbed("repeat"), userLine("repeat")], asked).delivered).toEqual([0, 1]);
    // A turn-end prompt holding both copies joined proves both (one line, two texts).
    expect(queueAccount([queueLine("dequeue"), userLine("repeat\nrepeat")], ["repeat", "repeat"]).delivered).toEqual([0, 1]);
  });

  it("the controls: different texts each written twice are each delivered; a popAll still wins over a delivery", () => {
    expect(queueAccount([absorbed("one"), userLine("one"), absorbed("two"), userLine("two")], ["one", "two"]).delivered).toEqual([0, 1]);
    expect(queueAccount([absorbed("one"), userLine("two")], ["one", "two"]).delivered).toEqual([0, 1]);
    expect(queueAccount([absorbed("repeat"), userLine("repeat"), queueLine("popAll", { content: "repeat" })], ["repeat", "repeat"])).toEqual({
      pulled: [1],
      reachesNewest: true,
      delivered: [0],
      other: false,
    });
  });
});

describe("identical copies, the first absorbed (remove and user line) just before Up, the second pulled", () => {
  it("the second's popAll on a later read: it comes back to Chat's box, and nothing is lost through Send, Stop and Send", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["repeat", "repeat"] }), ["repeat", "repeat"]);
    const page = pageFor(m, ["repeat", "repeat"]);
    m.claude.beforeKey = (keys) => {
      if (keys[0] === "Up") m.claude.absorb(1, true);
    };
    m.claude.late(isPopAll, 4);
    expect(await page.take()).toBe("taken");
    // r4 answered `left` ("already received") here and erased the second copy with ctrl+u.
    expect(page.answers.map((answer) => answer.type)).toEqual(["taken"]);
    expect(page.note()).toBe(takeBackTexts.taken);
    expect(page.text()).toBe("repeat");
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(m.claude.state.input).toBe("");
    expect(m.claude.sent).toEqual(["repeat"]);
    // The first copy was delivered: its bubble stays until the timeline shows it.
    expect(page.pending.forPane(page.key).map((item) => item.text)).toEqual(["repeat"]);
    await page.sendFromChat("show status");
    await m.stop();
    await page.sendFromChat("next step");
    page.pending.observe(page.key, {
      turns: [{ id: "later", items: [user("first", "repeat"), user("status", "show status"), { type: "notice", value: { id: "interrupted", kind: "interrupted" } }, user("next", "next step")] }],
    } as unknown as ChatTimeline);
    // Both copies: one Claude received, one in Chat's box.
    expect(page.text()).toBe("repeat");
    expect(copiesOf("repeat", m, page)).toBe(2);
  });

  it("the second's popAll never in time: left in Claude's input with the Not sure note, never erased, never lost through Send, Stop and Send", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["repeat", "repeat"] }), ["repeat", "repeat"]);
    const page = pageFor(m, ["repeat", "repeat"]);
    m.claude.beforeKey = (keys) => {
      if (keys[0] === "Up") m.claude.absorb(1, true);
    };
    m.claude.late(isPopAll, Number.POSITIVE_INFINITY);
    expect(await page.take()).toBe("left");
    expect(page.answers).toEqual([{ type: "left", note: takeBackTexts.notSureTaken, pressed: true }]);
    expect(page.note()).toBe(takeBackTexts.notSureTaken);
    expect(m.claude.keysSent()).toEqual(["Up"]);
    expect(m.claude.state.input).toBe("repeat");
    await expect(page.sendFromChat("show status")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    await m.stop();
    await expect(page.sendFromChat("next step")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    page.pending.observe(page.key, { turns: [{ id: "later", items: [user("first", "repeat")] }] } as unknown as ChatTimeline);
    expect(m.claude.state.input).toBe("repeat");
    expect(m.claude.sent).toEqual(["repeat"]);
    expect(copiesOf("repeat", m, page)).toBeGreaterThanOrEqual(2);
  });
});

describe("controls: deliveries written twice and copies pulled", () => {
  it("two distinct copies each absorbed with remove and user lines: both delivered, Up recalled history, already received", async () => {
    const claude = new FakeClaudeQueue({ queued: ["one", "two"] });
    claude.beforeKey = (keys) => {
      if (keys[0] === "Up") claude.absorb(2, true);
    };
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["one", "two"]))).toEqual({ type: "left", note: takeBackTexts.alreadyGot, pressed: true });
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(claude.state.input).toBe("");
  });

  it("two identical copies each absorbed with remove and user lines: both delivered, already received", async () => {
    const claude = new FakeClaudeQueue({ queued: ["repeat", "repeat"] });
    claude.beforeKey = (keys) => {
      if (keys[0] === "Up") claude.absorb(2, true);
    };
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["repeat", "repeat"]))).toEqual({ type: "left", note: takeBackTexts.alreadyGot, pressed: true });
    expect(claude.sent).toEqual(["repeat", "repeat"]);
    expect(claude.state.input).toBe("");
  });

  it("two identical copies both pulled: both come back, in order, no collapse", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["repeat", "repeat"] }), ["repeat", "repeat"]);
    const page = pageFor(m, ["repeat", "repeat"]);
    m.claude.late(isPopAll, 3);
    expect(await page.take()).toBe("taken");
    expect(page.text()).toBe("repeat\nrepeat");
    expect(page.pending.forPane(page.key)).toEqual([]);
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u", "Backspace", "ctrl+u"]);
    expect(m.claude.state.input).toBe("");
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual([]);
  });
});

// MARK: - each raw path against its own allowance

/** A Claude box at idle holding `input`, as a Send's cleanup reads it. */
function idleBox(input: string) {
  const claude = new FakeClaudeQueue({ queued: [], input, working: false });
  return { claude, site: siteOf(claude) };
}

describe("a Send's cleanup counts each picture path against the old send's own", () => {
  const sent = "abc /fake/uploads/a.png /fake/uploads/b.png";
  const native = "abc /fake/uploads/a.png /fake/uploads/a.png";

  it("Terminal's abc /a.png /a.png is never Chat's abc /a.png /b.png: no ctrl+u, no Backspace, the draft kept", async () => {
    const { claude, site } = idleBox(native);
    expect(await beforeSend(site, [sent])).toEqual({ type: "go", cleared: null });
    expect(claude.keysSent()).toEqual([]);
    expect(claude.state.input).toBe(native);
  });

  it("the registered handlers: a refused take-back, then the waiting Send, never clear the different Terminal draft", async () => {
    const m = machine(new FakeClaudeQueue({ queued: [sent], input: native }), [sent]);
    const taking = m.take([sent]);
    const sending = m.send("next");
    expect(await taking).toEqual({ type: "left", note: takeBackTexts.boxHasText, pressed: false });
    await sending;
    expect(m.claude.keysSent()).toEqual([]);
    // Other text is left alone and the Send goes as before (Herdr's agent.prompt joins it).
    expect(m.claude.state.queued).toContain(`${native}next`);
  });

  it("a path repeated past its count, or a path that is not the send's, is no match in any layout", () => {
    for (const draft of [
      native,
      "abc /fake/uploads/b.png /fake/uploads/b.png",
      "/fake/uploads/a.png abc /fake/uploads/a.png",
      "/fake/uploads/a.png abc/fake/uploads/a.png",
      "[Image #11] abc /fake/uploads/c.png",
      "abc /fake/uploads/a.png",
      "[Image #11] [Image #12] abc /fake/uploads/a.png",
    ]) {
      expect(showsOwnSend(draft, sent, null), draft).toBe(false);
    }
  });

  it("the controls: each path within its allowance, the chips standing for the rest, is still ours", () => {
    for (const draft of [
      sent,
      "[Image #11] [Image #12]abc",
      "abc [Image #11] [Image #12]",
      "[Image #11]abc/fake/uploads/b.png",
      "[Image #11] abc /fake/uploads/a.png",
      "/fake/uploads/b.png abc /fake/uploads/a.png",
    ]) {
      expect(showsOwnSend(draft, sent, null), draft).toBe(true);
    }
    // A send that holds one path twice allows it twice.
    const twice = "abc /fake/uploads/a.png /fake/uploads/a.png";
    expect(showsOwnSend(twice, twice, null)).toBe(true);
    expect(showsOwnSend("[Image #11] abc /fake/uploads/a.png", twice, null)).toBe(true);
    expect(showsOwnSend("/fake/uploads/a.png abc /fake/uploads/a.png", twice, null)).toBe(true);
  });

  it("a cleanup of Claude Code's own path-still-going-in layout still clears, row and all", async () => {
    const { claude, site } = idleBox("[Image #11]abc/fake/uploads/b.png");
    expect(await beforeSend(site, [sent])).toEqual({ type: "go", cleared: sent });
    expect(claude.keysSent()).toEqual(["ctrl+u", "Backspace"]);
    expect(claude.state.input).toBe("");
  });
});
