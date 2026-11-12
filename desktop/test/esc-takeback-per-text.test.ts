// Esc take-back, per text. Claude Code 2.1.322 writes one popAll line per message on Up (two queued, one Up: two
// lines in queue order, the same timestamp, each holding only its own text, about 0.14 s after the key); a take-back
// proves each text in Claude's input row by its own line and clears nothing while any is unproven; a Send's cleanup
// of a message with pictures keeps the caption's word boundaries; no cleanup key goes into a dialog. Fake screens, a
// fake session transcript (support/claude-queue-screens.ts) and a fake Herdr only; nothing is read from a real
// session.

import { describe, expect, it, vi } from "vitest";

import { beforeSend, pulledRows, takeBackQueued, type BoxRun, type ClaudeBoxSite, type TakeBackFor } from "../src/main/herdr/claude-box";
import { promptRefusal } from "../src/main/herdr/send";
import { APIError } from "../src/main/herdr/wire";
import { claudeBoxTexts, takeBackTexts, type QueuedTakeBack } from "../src/shared/claude-screen";
import { IPC } from "../src/shared/ipc-contract";
import { PendingMessages } from "../src/shared/chat/pending";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { FakeClaudeQueue, queueLine } from "./support/claude-queue-screens";

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
const dialogNote = promptRefusal(new APIError("agent_blocked", "agent is blocked"));

function siteOf(claude: FakeClaudeQueue): ClaudeBoxSite {
  return { read: async () => claude.read(), keys: async (keys) => claude.keys(keys), wait: async () => undefined };
}

const forTexts = (claude: FakeClaudeQueue, asked: readonly string[]): TakeBackFor => ({ asked, own: asked, forget: () => undefined, record: claude.record() });

const isPopAll = (line: string): boolean => (JSON.parse(line) as { operation?: string }).operation === "popAll";
const popAllOf = (text: string) => (line: string): boolean => isPopAll(line) && (JSON.parse(line) as { content?: string }).content === text;

interface Now {
  pane: TopologyPaneInfo;
  agent: AgentInfo;
}

/** A machine as main's handlers see it, its Claude pane `claude` (Herdr's agent.prompt joins text left in the row). */
function machine(claude: FakeClaudeQueue = new FakeClaudeQueue({ queued: ["abc"] }), sends: readonly string[] = ["abc"]) {
  const now: Now = {
    pane: { paneID: "w1:p1", terminalID: "t-7", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "working", revision: 1 },
    agent: { paneID: "w1:p1", agent: "claude", agentStatus: "working", terminalID: "t-7", stateChangeSeq: 12, turnEpoch: 9, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: session } },
  };
  let reads = 0;
  let afterRead: (read: number) => void = () => undefined;
  let failRead: (read: number) => boolean = () => false;
  const backend = {
    agentKeys: async (_paneID: string, keys: readonly string[]) => claude.keys(keys),
    promptIO: () => ({
      paneRead: async () => {
        reads += 1;
        if (failRead(reads)) throw new Error("pane.read did not answer");
        const screen = claude.read();
        afterRead(reads);
        return screen;
      },
      paneSendKeys: async () => undefined,
    }),
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
  /** Herdr's snapshot shows a dialog now (the pane and the agent blocked, input pending), and Claude Code draws it. */
  const dialog = (): void => {
    now.pane = { ...now.pane, agentStatus: "blocked" };
    now.agent = { ...now.agent, agentStatus: "blocked", inputPending: true };
    claude.state.dialog = true;
  };
  return {
    claude,
    now,
    backend,
    take,
    send,
    stop,
    dialog,
    afterRead: (f: (read: number) => void) => void (afterRead = f),
    failRead: (f: (read: number) => boolean) => void (failRead = f),
  };
}

/** The page's take-back runner (take-back.ts) over a machine: the user's bubbles, Chat's box and its note. */
function pageFor(m: ReturnType<typeof machine>, texts: readonly string[] = ["abc"]) {
  const pending = new PendingMessages();
  const key = "mac-mini/w1:p1";
  pending.observe(key, { turns: [] } as unknown as ChatTimeline);
  for (const text of texts) pending.delivered(pending.add(key, text, Date.now(), { terminalID: "t-7", session }));
  let text = "";
  let note = "";
  const deps = {
    bridge: { takeBackQueued: () => m.take(texts) },
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
  return { pending, key, text: () => text, note: () => note, sendFromChat, take: () => new TakeBacks().run(deps, "mac-mini", "w1:p1", key, binding, items()) };
}

const user = (id: string, text: string) => ({ type: "user", value: { id, text, attachments: [], time: Date.now() / 1_000 } });

/** Where `text` still is: Chat's box, a waiting bubble, Claude's input row or queue, or what Claude received. */
function whereIs(text: string, m: ReturnType<typeof machine>, page: ReturnType<typeof pageFor>): string[] {
  const at: string[] = [];
  if (page.text().split("\n").includes(text)) at.push("chat box");
  if (page.pending.forPane(page.key).some((item) => item.text === text)) at.push("bubble");
  if (m.claude.state.input.split("\n").includes(text)) at.push("claude row");
  if (m.claude.state.queued.includes(text)) at.push("claude queue");
  if (m.claude.sent.some((sent) => sent.split("\n").includes(text))) at.push("delivered");
  return at;
}

// MARK: - the live shape: one popAll line per message

describe("live shape: two queued, one Up, one popAll line per message", () => {
  it("two popAll lines with the same timestamp a moment later: Taken back, both texts back in Chat's box in order, the rows cleared row by row", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["one", "two"] }), ["one", "two"]);
    const page = pageFor(m, ["one", "two"]);
    // The lines reach the file a moment after Up: the first read of the record past the baseline sees nothing yet.
    m.claude.late(isPopAll, 3);
    expect(await page.take()).toBe("taken");
    expect(page.note()).toBe(takeBackTexts.taken);
    expect(page.text()).toBe("one\ntwo");
    expect(page.pending.forPane(page.key)).toEqual([]);
    // Two rows in Claude's input: ctrl+u clears the cursor's row, Backspace joins the one above, ctrl+u again.
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u", "Backspace", "ctrl+u"]);
    expect(m.claude.state.input).toBe("");
    // Claude Code's record: one line per message, in queue order, each only its own text, the same timestamp.
    const pulls = m.claude.transcript.filter(isPopAll).map((line) => JSON.parse(line) as { content: string; timestamp: string });
    expect(pulls.map((pull) => pull.content)).toEqual(["one", "two"]);
    expect(new Set(pulls.map((pull) => pull.timestamp)).size).toBe(1);
    // A turn that ends with the row empty sends nothing.
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual([]);
  });

  it("the same with the second line missing at the bound: nothing cleared, not sure, the row held from every Send", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["one", "two"] }), ["one", "two"]);
    const page = pageFor(m, ["one", "two"]);
    m.claude.late(popAllOf("two"), Number.POSITIVE_INFINITY);
    expect(await page.take()).toBe("left");
    expect(page.note()).toBe(takeBackTexts.notSureTaken);
    expect(m.claude.keysSent()).toEqual(["Up"]);
    expect(m.claude.state.input).toBe("one\ntwo");
    expect(page.text()).toBe("");
    expect(page.pending.forPane(page.key).map((item) => item.text)).toEqual(["one", "two"]);
    await expect(m.send("abcd")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    expect(m.claude.state.input).toBe("one\ntwo");
    expect(pulledRows.get(m.backend, "w1:p1")).toEqual({ spare: null });
  });

  it("a single joined popAll line is still read when it is exactly the user's texts", async () => {
    const claude = new FakeClaudeQueue({ queued: ["one", "two"] });
    claude.joinedPopAll = true;
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["one", "two"]))).toEqual({ type: "taken", texts: ["one", "two"], note: takeBackTexts.taken });
    expect(claude.state.input).toBe("");
  });

  it("a popAll line for text that is not the user's (a Terminal line queued with theirs) is not proof: nothing cleared", async () => {
    const claude = new FakeClaudeQueue({ queued: ["one", "from the terminal"] });
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["one"]))).toEqual({ type: "left", note: takeBackTexts.alsoTerminal, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
    expect(claude.state.input).toBe("one\nfrom the terminal");
  });
});

// MARK: - Proof per text, never for the whole set

describe("each text in Claude's row proved by its own line", () => {
  it("one absorbed just before Up, two's popAll on a later read: two comes back, and survives a later Send, Stop and Send", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["one", "two"] }), ["one", "two"]);
    const page = pageFor(m, ["one", "two"]);
    // Claude takes `one` mid-turn just before Up; Up then pulls `two`, whose popAll line reaches the file late.
    m.claude.beforeKey = (keys) => {
      if (keys[0] === "Up") m.claude.absorb(1);
    };
    m.claude.late(isPopAll, 4);
    expect(await page.take()).toBe("taken");
    expect(page.text()).toBe("two");
    expect(m.claude.state.input).toBe("");
    expect(m.claude.sent).toEqual(["one"]);
    // `one` was delivered: its bubble is not hidden.
    expect(page.pending.forPane(page.key).map((item) => item.text)).toEqual(["one"]);
    // Normal use afterwards: a Send, Stop, another Send, and the late transcript.
    await page.sendFromChat("show status");
    await m.stop();
    await page.sendFromChat("next step");
    page.pending.observe(page.key, {
      turns: [{ id: "later", items: [user("one", "one"), user("status", "show status"), { type: "notice", value: { id: "interrupted", kind: "interrupted" } }, user("next", "next step")] }],
    } as unknown as ChatTimeline);
    expect(whereIs("two", m, page)).toEqual(["chat box"]);
  });

  it("one absorbed just before Up, two's popAll never in time: two is left in Claude's row, never erased, never lost through a Send, Stop and Send", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["one", "two"] }), ["one", "two"]);
    const page = pageFor(m, ["one", "two"]);
    m.claude.beforeKey = (keys) => {
      if (keys[0] === "Up") m.claude.absorb(1);
    };
    m.claude.late(isPopAll, Number.POSITIVE_INFINITY);
    expect(await page.take()).toBe("left");
    // r3 said "already received" here and erased `two` with ctrl+u.
    expect(page.note()).toBe(takeBackTexts.notSureTaken);
    expect(m.claude.keysSent()).toEqual(["Up"]);
    expect(m.claude.state.input).toBe("two");
    await expect(page.sendFromChat("show status")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    await m.stop();
    await expect(page.sendFromChat("next step")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    page.pending.observe(page.key, { turns: [{ id: "later", items: [user("one", "one")] }] } as unknown as ChatTimeline);
    expect(whereIs("two", m, page)).toContain("claude row");
    expect(m.claude.sent).toEqual(["one"]);
  });

  it("a bare dequeue proves nothing about a text: the row is not cleared", async () => {
    const claude = new FakeClaudeQueue({ queued: ["two"] });
    claude.late(isPopAll, Number.POSITIVE_INFINITY);
    // A dequeue (no content) reaches the file as Up goes, for an earlier prompt.
    claude.beforeKey = (keys) => {
      if (keys[0] === "Up") claude.write(queueLine("dequeue"));
    };
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["one", "two"]))).toEqual({ type: "left", note: takeBackTexts.notSureTaken, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
    expect(claude.state.input).toBe("two");
  });

  it("the control: both delivered just before Up, each by its own line: Up recalled history, cleared as the user's own, already received", async () => {
    const claude = new FakeClaudeQueue({ queued: ["one", "two"] });
    claude.beforeKey = (keys) => {
      if (keys[0] === "Up") claude.absorb();
    };
    expect(await takeBackQueued(siteOf(claude), forTexts(claude, ["one", "two"]))).toEqual({ type: "left", note: takeBackTexts.alreadyGot, pressed: true });
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(claude.state.input).toBe("");
  });
});

// MARK: - Picture cleanup keeps word boundaries

/** A Claude box at idle holding `input`, as a Send's cleanup reads it. */
function idleBox(input: string) {
  const claude = new FakeClaudeQueue({ queued: [], input, working: false });
  return { claude, site: siteOf(claude) };
}

describe("a Send's cleanup of a message with pictures keeps the caption's word boundaries", () => {
  const asked = "abc /fake/uploads/a.png";

  it("Terminal's a bc [Image #18] beside Chat's abc with a picture and a waiting Send: no ctrl+u, no Backspace", async () => {
    const native = "a bc [Image #18]";
    const m = machine(new FakeClaudeQueue({ queued: [asked], input: native }), [asked]);
    const taking = m.take([asked]);
    const sending = m.send("abcd");
    expect(await taking).toEqual({ type: "left", note: takeBackTexts.boxHasText, pressed: false });
    await sending;
    expect(m.claude.keysSent()).toEqual([]);
    // Terminal's words were never erased (other text is left alone and the send goes as before).
    expect(m.claude.state.queued.some((text) => text.startsWith(native))).toBe(true);
  });

  it("Claude Code's own layouts are still ours: chips first, in place, and a path still going in", async () => {
    const two = "abc /fake/uploads/a.png /fake/uploads/b.png";
    for (const draft of ["[Image #11] [Image #12]abc", "abc [Image #11] [Image #12]", "[Image #11]abc/fake/uploads/b.png", "[Image #11] abc /fake/uploads/b.png", two]) {
      const { claude, site } = idleBox(draft);
      expect(await beforeSend(site, [two])).toEqual({ type: "go", cleared: two });
      expect(claude.keysSent()).toEqual(["ctrl+u", "Backspace"]);
    }
  });

  it("a caption with other word boundaries, or a picture missing, is never ours: no key", async () => {
    const two = "abc /fake/uploads/a.png /fake/uploads/b.png";
    for (const draft of ["[Image #11] [Image #12]a bc", "a bc [Image #11] [Image #12]", "[Image #11]a bc/fake/uploads/b.png", "[Image #11]ab c /fake/uploads/b.png", "[Image #11]abc"]) {
      const { claude, site } = idleBox(draft);
      expect(await beforeSend(site, [two])).toEqual({ type: "go", cleared: null });
      expect(claude.keysSent()).toEqual([]);
    }
  });
});

// MARK: - No cleanup key into a dialog

describe("no cleanup key from a Send goes into a dialog", () => {
  it("the spare-row cleanup with the pane turning blocked and input pending before the key: no key, the spare mark and the draft kept", async () => {
    const m = machine();
    const original = m.claude.keys.bind(m.claude);
    let first = true;
    m.claude.keys = (keys) => {
      original(keys);
      // Ctrl+U's effect is not drawn yet when it is read, and the read after it fails: taken, not seen empty.
      if (keys[0] === "ctrl+u" && first) {
        first = false;
        m.claude.state.input = "abc";
        m.failRead((read) => read >= 3);
      }
    };
    expect(await m.take()).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.takenCheckBox });
    expect(pulledRows.get(m.backend, "w1:p1")).toEqual({ spare: ["abc"] });
    m.failRead(() => false);
    // The Send reads the spare row (read 4); right after it Herdr shows a dialog.
    m.afterRead((read) => {
      if (read === 4) m.dialog();
    });
    const intoDialog: string[] = [];
    m.claude.beforeKey = (keys) => {
      if (m.claude.state.dialog) intoDialog.push(...keys);
    };
    const refused = await m.send("abcd").then(() => null, (error: unknown) => (error as Error).message);
    expect(intoDialog).toEqual([]);
    expect(pulledRows.get(m.backend, "w1:p1")).toEqual({ spare: ["abc"] });
    expect(m.claude.state.input).toBe("abc");
    // Refused (the draft stays in Chat's box), with the note that a question is open.
    expect(refused).toBe(dialogNote);
  });

  it("the ordinary cleanup of our own leftover message with a dialog shown after the read: no key, the Send refused with its draft kept", async () => {
    const m = machine(new FakeClaudeQueue({ queued: [], input: "abc", working: false }), ["abc"]);
    m.now.pane = { ...m.now.pane, agentStatus: "idle" };
    m.now.agent = { ...m.now.agent, agentStatus: "idle" };
    boxChecks.mark(m.backend, "w1:p1");
    m.afterRead((read) => {
      if (read === 1) m.dialog();
    });
    const refused = await m.send("abcd").then(() => null, (error: unknown) => (error as Error).message);
    expect(m.claude.keysSent()).toEqual([]);
    expect(m.claude.state.input).toBe("abc");
    expect(refused).toBe(dialogNote);
  });

  it("the control: the same cleanup with no dialog clears our leftover and the Send goes alone", async () => {
    const m = machine(new FakeClaudeQueue({ queued: [], input: "abc", working: false }), ["abc"]);
    m.now.pane = { ...m.now.pane, agentStatus: "idle" };
    m.now.agent = { ...m.now.agent, agentStatus: "idle" };
    boxChecks.mark(m.backend, "w1:p1");
    await m.send("abcd");
    expect(m.claude.keysSent()).toEqual(["ctrl+u", "Backspace"]);
    expect(m.claude.sent).toEqual(["abcd"]);
  });
});
