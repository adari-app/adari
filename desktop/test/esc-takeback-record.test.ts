// Esc take-back, main's side. A take-back says "Taken back" only on Claude Code's own record of the pull (a popAll
// of exactly the user's texts written after the baseline), and clears nothing without it; the popAll content, not
// the wrapped rows, is the ownership test; a row a take-back left pulled or unknown holds every Send back until a
// read shows it resolved. Fake
// screens and a fake session transcript (support/claude-queue-screens.ts: queue-operation lines as Claude Code
// 2.1.322 writes them) and a fake Herdr only; nothing is read from a real session.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { pulledRows, takeBackQueued, type BoxRun, type ClaudeBoxSite, type TakeBackFor } from "../src/main/herdr/claude-box";
import { claudeBoxTexts, readClaudeScreenFacts, takeBackTexts, type QueuedTakeBack } from "../src/shared/claude-screen";
import { queueAccount, queueEventOf, queuedAs } from "../src/shared/claude-queue-record";
import { IPC } from "../src/shared/ipc-contract";
import { PendingBackstop, PendingMessages } from "../src/shared/chat/pending";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { AgentInfo, TopologyPaneInfo } from "../src/main/herdr/wire";
import { FakeClaudeQueue, queueLine, queueScreen, userLine } from "./support/claude-queue-screens";

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
  const take = (texts: readonly string[] = sends, page: typeof binding = binding) =>
    registered.handles.get(IPC.paneTakeBack)!(event, "mac-mini", "w1:p1", page, texts) as Promise<QueuedTakeBack>;
  const send = (text: string) =>
    registered.handles.get(IPC.paneSend)!(event, "mac-mini", "w1:p1", text, { terminalID: "t-7", isAgent: true, kind: "claude", session }) as Promise<void>;
  const stop = () => registered.handles.get(IPC.paneStop)!(event, "mac-mini", "w1:p1", binding) as Promise<string | null>;
  return {
    claude,
    now,
    backend,
    take,
    send,
    stop,
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
  return { pending, key, text: () => text, note: () => note, take: () => new TakeBacks().run(deps, "mac-mini", "w1:p1", key, binding, items()) };
}

const user = (id: string, text: string) => ({ type: "user", value: { id, text, attachments: [], time: Date.now() / 1_000 } });

beforeEach(() => undefined);

// MARK: - Claude Code's queue record, as a take-back reads it

describe("the queue record", () => {
  it("reads popAll, absorbed_mid_turn, dequeue and the user's prompt; nothing else", () => {
    expect(queueEventOf(queueLine("popAll", { content: "abc" }))).toEqual({ kind: "popAll", content: "abc" });
    expect(queueEventOf(queueLine("remove", { reason: "absorbed_mid_turn", content: "abc" }))).toEqual({ kind: "absorbed", content: "abc" });
    expect(queueEventOf(queueLine("remove", { reason: "something else", content: "abc" }))).toBeNull();
    expect(queueEventOf(queueLine("dequeue"))).toEqual({ kind: "dequeue" });
    expect(queueEventOf(queueLine("enqueue", { content: "abc" }))).toBeNull();
    expect(queueEventOf(userLine("abc"))).toEqual({ kind: "user", text: "abc" });
    expect(queueEventOf(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "abc" }] } }))).toBeNull();
    expect(queueEventOf("not json")).toBeNull();
  });

  it("a popAll proves the user's texts only when its content is exactly them (one line per text, or one joined line)", () => {
    const pulled = (lines: string[], asked: string[]) => {
      const account = queueAccount(lines, asked);
      return account.other ? "other" : { pulled: account.pulled, newest: account.reachesNewest };
    };
    expect(pulled([queueLine("popAll", { content: "abc" })], ["abc"])).toEqual({ pulled: [0], newest: true });
    expect(pulled([queueLine("popAll", { content: "one" }), queueLine("popAll", { content: "two" })], ["one", "two"])).toEqual({ pulled: [0, 1], newest: true });
    expect(pulled([queueLine("popAll", { content: "one\ntwo" })], ["one", "two"])).toEqual({ pulled: [0, 1], newest: true });
    expect(pulled([queueLine("popAll", { content: "two" })], ["one", "two"])).toEqual({ pulled: [1], newest: true });
    // The first of two lines so far: proof for `one` only, not yet for the newest text.
    expect(pulled([queueLine("popAll", { content: "one" })], ["one", "two"])).toEqual({ pulled: [0], newest: false });
    expect(pulled([queueLine("popAll", { content: "a bc" })], ["abc"])).toBe("other");
    expect(pulled([queueLine("popAll", { content: "abc\nfrom the terminal" })], ["abc"])).toBe("other");
    expect(pulled([queueLine("popAll", { content: "abc" }), queueLine("popAll", { content: "from the terminal" })], ["abc"])).toBe("other");
    expect(pulled([queueLine("popAll", { content: "two" }), queueLine("popAll", { content: "one" })], ["one", "two"])).toBe("other");
    expect(pulled([queueLine("popAll")], ["abc"])).toBe("other");
    expect(queuedAs("look [Image #3]", ["look /fake/uploads/a.png"])).toBe(true);
    expect(queuedAs("look  [Image #3]", ["look"])).toBe(false);
  });

  it("delivery, text by text: the user's text taken mid-turn or their prompt; a bare dequeue and Terminal's absorbed line prove nothing", () => {
    const delivered = (lines: string[], asked: string[]) => queueAccount(lines, asked).delivered;
    expect(delivered([queueLine("remove", { reason: "absorbed_mid_turn", content: "abc" })], ["abc"])).toEqual([0]);
    expect(delivered([userLine("abc")], ["abc"])).toEqual([0]);
    expect(delivered([userLine("one\ntwo")], ["one", "two"])).toEqual([0, 1]);
    expect(delivered([queueLine("remove", { reason: "absorbed_mid_turn", content: "one" })], ["one", "two"])).toEqual([0]);
    expect(delivered([queueLine("dequeue")], ["abc"])).toEqual([]);
    expect(delivered([queueLine("remove", { reason: "absorbed_mid_turn", content: "from the terminal" })], ["abc"])).toEqual([]);
    expect(delivered([queueLine("enqueue", { content: "abc" })], ["abc"])).toEqual([]);
  });

  it("a popAll wins over a prompt line of the same words written late (an earlier send), and over another copy taken mid-turn", () => {
    expect(queueAccount([userLine("abc"), queueLine("popAll", { content: "abc" })], ["abc"])).toEqual({ pulled: [0], reachesNewest: true, delivered: [], other: false });
    expect(queueAccount([queueLine("remove", { reason: "absorbed_mid_turn", content: "abc" }), queueLine("popAll", { content: "abc" })], ["abc", "abc"])).toEqual({
      pulled: [1],
      reachesNewest: true,
      delivered: [0],
      other: false,
    });
  });

  it("only whole lines written past the baseline count", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const record = claude.record();
    const base = (await record.end())!;
    expect(await record.since(base)).toEqual([]);
    claude.transcript.push(queueLine("popAll", { content: "abc" }));
    expect(await record.since(base)).toEqual([queueLine("popAll", { content: "abc" })]);
    claude.recordFails = true;
    expect(await record.since(base)).toBeNull();
    expect(await record.end()).toBeNull();
  });
});

// MARK: - "Taken back" only on proof, nothing cleared without it

describe("Taken back only with Claude Code's record of the pull", () => {
  it("same-turn steering just before Up (absorbed_mid_turn, then history recall): never Taken back, and the next abcd gives Claude only abcd", async () => {
    const m = machine();
    const page = pageFor(m);
    m.claude.beforeKey = (keys) => {
      // Claude takes the queued message mid-turn: neither Herdr's status nor its episode changes.
      if (keys[0] === "Up") m.claude.absorb();
    };
    expect(await page.take()).toBe("left");
    expect(page.note()).toBe(takeBackTexts.alreadyGot);
    // Nothing went back to Chat's box, and the bubble is not hidden.
    expect(page.text()).toBe("");
    expect(page.pending.forPane(page.key).map((item) => item.text)).toEqual(["abc"]);
    // Up recalled the delivered "abc" into Claude's row; it was exactly the user's own, so it was cleared.
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(m.claude.state.input).toBe("");
    // The late transcript arrives; then the edited message goes.
    page.pending.observe(page.key, { turns: [{ id: "t1", items: [user("delivered", "abc")] }] } as unknown as ChatTimeline);
    await m.send("abcd");
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual(["abc", "abcd"]);
  });

  it("the row cleared, then the turn ends before the confirming read: the user's abc is back in Chat's box, never lost to a later Stop and Send", async () => {
    const m = machine();
    const page = pageFor(m);
    m.afterRead((read) => {
      // The read after Ctrl+U: Claude's turn is over by Herdr's word.
      if (read !== 3) return;
      m.now.agent = { ...m.now.agent, agentStatus: "idle", stateChangeSeq: 13 };
      m.now.pane = { ...m.now.pane, agentStatus: "idle" };
      m.claude.state.working = false;
    });
    expect(await page.take()).toBe("taken");
    expect(page.text()).toBe("abc");
    expect(m.claude.state.input).toBe("");
    // Normal use before any backstop fires: a Send, its turn stopped, another Send, and a late transcript.
    const scheduled: (() => void)[] = [];
    const backstop = new PendingBackstop(page.pending, (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    }, () => undefined);
    backstop.watch(page.key, "idle", async () => false);
    await m.send("show status");
    m.claude.state.working = true;
    m.now.agent = { ...m.now.agent, agentStatus: "working", stateChangeSeq: 14 };
    m.now.pane = { ...m.now.pane, agentStatus: "working" };
    await m.stop();
    await m.send("next step");
    page.pending.observe(page.key, {
      turns: [{ id: "t2", items: [user("status", "show status"), { type: "notice", value: { id: "interrupt", kind: "interrupted" } }, user("next", "next step")] }],
    } as unknown as ChatTimeline);
    // "abc" was never delivered, and it is still in Chat's box.
    expect(m.claude.sent).not.toContain("abc");
    expect(page.text()).toBe("abc");
  });

  it("no popAll in time: nothing is cleared, the bubble stays, it says so, and no Send joins the row", async () => {
    const m = machine();
    const page = pageFor(m);
    // Claude Code writes nothing more to the record (a slow write).
    m.claude.recording = false;
    expect(await page.take()).toBe("left");
    expect(page.note()).toBe(takeBackTexts.notSureTaken);
    expect(m.claude.keysSent()).toEqual(["Up"]);
    expect(m.claude.state.input).toBe("abc");
    expect(page.pending.forPane(page.key)).toHaveLength(1);
    await expect(m.send("abcd")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    expect(m.claude.state.input).toBe("abc");
    // The user clears Claude's box in Terminal: the next Send reads it empty and goes alone.
    m.claude.state.input = "";
    await m.send("abcd");
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual(["abcd"]);
  });

  it("an old popAll before the baseline does not count", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    // An earlier pull of the same words, before this take-back's baseline.
    claude.transcript.push(queueLine("popAll", { content: "abc" }), queueLine("enqueue", { content: "abc" }));
    claude.recording = false;
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"]));
    expect(result).toEqual({ type: "left", note: takeBackTexts.notSureTaken, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
  });

  it("a pane with no session refuses before Up", async () => {
    const m = machine();
    expect(await m.take(["abc"], { ...binding, session: null as unknown as string })).toEqual({ type: "left", note: takeBackTexts.unrecorded, pressed: false });
    expect(m.claude.keysSent()).toEqual([]);
    const named = machine();
    named.now.agent = { ...named.now.agent, agentSession: undefined };
    expect((await named.take()).type).toBe("left");
    expect(named.claude.keysSent()).toEqual([]);
  });

  it("a transcript that cannot be read refuses before Up; a screen with no queue is still none", async () => {
    const m = machine();
    m.claude.recordFails = true;
    expect(await m.take()).toEqual({ type: "left", note: takeBackTexts.unrecorded, pressed: false });
    expect(m.claude.keysSent()).toEqual([]);
    const idle = machine(new FakeClaudeQueue({ queued: [] }));
    idle.claude.recordFails = true;
    expect(await idle.take()).toEqual({ type: "none" });
  });

  it("the control: a genuine pull proved by its popAll is taken back, and the next Send goes alone", async () => {
    const m = machine();
    const page = pageFor(m);
    expect(await page.take()).toBe("taken");
    expect(page.note()).toBe(takeBackTexts.taken);
    expect(page.text()).toBe("abc");
    expect(page.pending.forPane(page.key)).toEqual([]);
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    await m.send("abcd");
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual(["abcd"]);
  });
});

// MARK: - No Send into an unresolved row

describe("no Send into a row a take-back left", () => {
  it("one and two queued, the reads after Up fail: a waiting abcd never becomes one\\ntwoabcd, its draft is kept", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["one", "two"] }), ["one", "two"]);
    let sending: Promise<void> | null = null;
    m.claude.beforeKey = (keys) => {
      if (keys[0] === "Up" && sending === null) sending = m.send("abcd");
    };
    m.failRead((read) => read >= 2 && read <= 4);
    const answer = await m.take(["one", "two"]);
    expect(answer).toEqual({ type: "left", note: takeBackTexts.changed, pressed: true });
    await expect(sending!).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual([]);
    expect(m.claude.sent.join("")).not.toContain("abcd");
    expect(m.claude.state.input).toBe("one\ntwo");
    // A later Send too, until the row reads empty.
    await expect(m.send("abcd")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    expect(pulledRows.get(m.backend, "w1:p1")).toEqual({ spare: null });
  });

  it("one temporary read failure after Up: read again, both taken back, and abcd goes alone", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["one", "two"] }), ["one", "two"]);
    let sending: Promise<void> | null = null;
    m.claude.beforeKey = (keys) => {
      if (keys[0] === "Up" && sending === null) sending = m.send("abcd");
    };
    m.failRead((read) => read === 2);
    expect(await m.take(["one", "two"])).toEqual({ type: "taken", texts: ["one", "two"], note: takeBackTexts.taken });
    await sending;
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual(["abcd"]);
  });

  it("a command line (a slash command) is refused too while the row is unresolved", async () => {
    const m = machine();
    m.claude.recording = false;
    expect((await m.take()).type).toBe("left");
    await expect(m.send("/compact")).rejects.toThrow(claudeBoxTexts.pulledNotSent);
  });

  it("cleared but not seen empty: the words come back to Chat, and a Send clears only exactly them from the row", async () => {
    const m = machine();
    const original = m.claude.keys.bind(m.claude);
    let first = true;
    m.claude.keys = (keys) => {
      original(keys);
      // Ctrl+U's effect is not drawn yet when it is read: the row still shows "abc".
      if (keys[0] === "ctrl+u" && first) {
        first = false;
        m.claude.state.input = "abc";
        m.failRead((read) => read >= 3);
      }
    };
    expect(await m.take()).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.takenCheckBox });
    m.failRead(() => false);
    expect(pulledRows.get(m.backend, "w1:p1")).toEqual({ spare: ["abc"] });
    await m.send("abcd");
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual(["abcd"]);
    expect(pulledRows.get(m.backend, "w1:p1")).toBeNull();
  });
});

// MARK: - The popAll content is the ownership test

describe("ownership is the popAll content, not the wrapped rows", () => {
  it("a 78-character line with a hard break beside a one-line Chat message: not taken, nothing cleared", async () => {
    const first = "node scripts/build.mjs --release --platform=mac --arch=arm64 --log-level=debug";
    expect(first).toHaveLength(78);
    const native = `${first}\nopen artifacts/report.html`;
    const asked = `${first} open artifacts/report.html`;
    const claude = new FakeClaudeQueue({ queued: [native] });
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, [asked]));
    expect(result).toEqual({ type: "left", note: takeBackTexts.alsoTerminal, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
    expect(claude.state.input).toBe(native);
  });

  it("Terminal's a bc beside Chat's abc with a Send waiting: only Up, and the Send never erases Terminal's line", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["a bc"] }));
    let sending: Promise<void> | null = null;
    m.claude.beforeKey = (keys) => {
      if (keys[0] === "Up" && sending === null) sending = m.send("abcd");
    };
    expect(await m.take()).toEqual({ type: "left", note: takeBackTexts.alsoTerminal, pressed: true });
    await expect(sending!).rejects.toThrow(claudeBoxTexts.pulledNotSent);
    expect(m.claude.keysSent()).toEqual(["Up"]);
    expect(m.claude.state.input).toBe("a bc");
    expect(m.claude.sent).toEqual([]);
  });

  it("a long message that wraps on screen is taken back on its popAll", async () => {
    const long = "please rerun the whole build with the release flags and then open the report in the browser when it is done";
    const claude = new FakeClaudeQueue({ queued: [long], wrap: 78 });
    // On screen the pulled message takes two rows; the rows alone cannot say that break is a wrap.
    expect(readClaudeScreenFacts(queueScreen({ ...claude.state, queued: [], input: long })).draft).toContain("\n");
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, [long]));
    expect(result).toEqual({ type: "taken", texts: [long], note: takeBackTexts.taken });
    expect(claude.state.input).toBe("");
    claude.turnEnds();
    expect(claude.sent).toEqual([]);
  });

  it("the Send's cleanup keeps word boundaries: Terminal's a bc in the box is never cleared as Chat's abc", async () => {
    const m = machine(new FakeClaudeQueue({ queued: [], input: "a bc", working: false }));
    boxChecks.mark(m.backend, "w1:p1");
    await m.send("abcd");
    // Other text is left alone and the send goes as before; no clearing key went.
    expect(m.claude.keysSent()).toEqual([]);
  });
});
