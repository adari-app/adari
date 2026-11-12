// Taking back a queued Claude Code message, main's side. A message that already went is never "Taken back"; no key
// goes into a dialog, and a screen with no box is a refusal, never the "no queue" that lets Esc stop; the command
// connection is part of the binding; a Send made during a take-back never joins the pulled text; ownership keeps
// word boundaries; a read that failed, or more of the user's texts than a take-back asks for, is a refusal with its
// note. Fake screens (support/claude-queue-screens.ts) and a fake Herdr only.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { boxChecks, takeBackQueued, type BoxRun, type ClaudeBoxSite, type TakeBackFor, type TakeBackTurn } from "../src/main/herdr/claude-box";
import { claudeBoxWidth, showsExactly, takeBackTexts, type QueuedTakeBack } from "../src/shared/claude-screen";
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
  return { read: async () => claude.read(), keys: async (keys) => claude.keys(keys), wait: async () => undefined };
}

// With the pane's queue record (the fake's transcript).
const forTexts = (claude: FakeClaudeQueue, asked: readonly string[], own: readonly string[] = asked, turn?: () => TakeBackTurn): TakeBackFor => ({
  asked,
  own,
  forget: () => undefined,
  record: claude.record(),
  ...(turn === undefined ? {} : { turn }),
});

// MARK: - a machine as main's handlers see it (HostRegistry's view), its Claude pane a FakeClaudeQueue

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const run: BoxRun = { terminalID: "t-7", session: "esc-takeback-s1", arrival: 2, epoch: "9" };
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

interface Now {
  pane: TopologyPaneInfo;
  agent: AgentInfo;
  connection: number;
  epoch: number;
  arrival: number;
}

/** Herdr shows a dialog: the pane blocked, the agent blocked with a menu pending, the screen a question. */
function dialogArrives(now: Now, claude: FakeClaudeQueue): void {
  now.pane = { ...now.pane, agentStatus: "blocked" };
  now.agent = { ...now.agent, agentStatus: "blocked", inputPending: true };
  claude.state.dialog = true;
}

function machine(claude: FakeClaudeQueue = new FakeClaudeQueue({ queued: ["abc"] })) {
  const now: Now = {
    pane: { paneID: "w1:p1", terminalID: "t-7", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "working", revision: 1 },
    agent: { paneID: "w1:p1", agent: "claude", agentStatus: "working", terminalID: "t-7", stateChangeSeq: 12, turnEpoch: 9, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "esc-takeback-s1" } },
    connection: 3,
    epoch: 7,
    arrival: 2,
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
    // Herdr's agent.prompt types the text into Claude's input row and presses Return: text already in the row joins it.
    prompt: async (_paneID: string, text: string) => {
      const row = claude.state.input;
      claude.state.input = "";
      claude.prompt(row + text);
    },
    sendInput: async () => undefined,
    sendText: async () => undefined,
    // The machine's transcript reader (the fake session's file, Claude Code's queue record in it).
    transcripts: () => claude.reader(),
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => now.pane,
    agent: () => now.agent,
    run: () => ({ connection: now.connection, arrival: now.arrival }),
    connection: () => now.connection,
    connectionIdentity: () => ({ incarnation: 1, epoch: now.epoch }),
    fresh: async () => true,
    current: async () => true,
    eventsLive: () => true,
    refresh: async () => undefined,
  };
  registerIpc({ hosts } as never);
  sentTexts.record(backend, "w1:p1", "abc", run);
  const take = (texts: readonly string[] = ["abc"], page: typeof binding = binding) =>
    registered.handles.get(IPC.paneTakeBack)!(event, "mac-mini", "w1:p1", page, texts) as Promise<QueuedTakeBack>;
  const send = (text: string) =>
    registered.handles.get(IPC.paneSend)!(event, "mac-mini", "w1:p1", text, { terminalID: "t-7", isAgent: true, kind: "claude", session: "esc-takeback-s1" }) as Promise<void>;
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

beforeEach(() => undefined);

// MARK: - never "Taken back" for a message that already went

describe("a message that already went is never taken back", () => {
  it("the turn ends between the read and Up: Up recalls the sent message, never Taken back, and the recall is cleared", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    // The short turn ends in the moment after the read: Claude Code sends its queue, then Up recalls it (history).
    claude.beforeKey = (keys) => {
      if (keys[0] === "Up") claude.turnEnds();
    };
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"]));
    // Claude Code's record shows the dequeue: received. The row held exactly the user's own delivered
    // text (the recall), so it is cleared: nothing of theirs is left in Claude's row. No Return, no Escape.
    expect(result).toEqual({ type: "left", note: takeBackTexts.alreadyGot, pressed: true });
    expect(claude.sent).toEqual(["abc"]);
    expect(claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(claude.state.input).toBe("");
  });

  it("Herdr shows the turn ended after the first read: no Up, and it says Claude already received it", async () => {
    const m = machine();
    m.afterRead((read) => {
      if (read !== 1) return;
      m.claude.turnEnds();
      m.now.pane = { ...m.now.pane, agentStatus: "idle" };
      m.now.agent = { ...m.now.agent, agentStatus: "idle", stateChangeSeq: 13 };
    });
    expect(await m.take()).toEqual({ type: "left", note: takeBackTexts.alreadyGot, pressed: false });
    expect(m.claude.keysSent()).toEqual([]);
  });

  it("another turn began (the queued message is its prompt) by Herdr after Up: the row is not cleared", async () => {
    const m = machine();
    m.afterRead((read) => {
      if (read !== 1) return;
      // Claude Code sent its queue as the next turn's prompt; Herdr reports the new episode as Up goes.
      m.claude.beforeKey = (keys) => {
        if (keys[0] !== "Up") return;
        m.claude.turnEnds();
        m.claude.state.working = true;
        m.now.agent = { ...m.now.agent, stateChangeSeq: 14 };
      };
    });
    const result = await m.take();
    // The record's dequeue says it went; the recall of the user's own text is cleared, never put back.
    expect(result).toEqual({ type: "left", note: takeBackTexts.alreadyGot, pressed: true });
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(m.claude.sent).toEqual(["abc"]);
    expect(m.claude.state.input).toBe("");
  });

  it("Herdr shows another episode before Up (Claude works on): no Up, and it says it cannot tell", async () => {
    const m = machine();
    m.afterRead((read) => {
      if (read === 1) m.now.agent = { ...m.now.agent, stateChangeSeq: 14 };
    });
    expect(await m.take()).toEqual({ type: "left", note: takeBackTexts.notSure, pressed: false });
    expect(m.claude.keysSent()).toEqual([]);
  });

  it("Herdr shows the turn moved on as the row is cleared: Claude Code's record proved the pull, so it is taken back", async () => {
    const m = machine();
    m.afterRead((read) => {
      if (read === 3) m.now.agent = { ...m.now.agent, agentStatus: "idle", stateChangeSeq: 13 };
    });
    // The popAll says the queue went to the input row, not to Claude: once cleared, the user's words
    // come back to Chat (never nowhere), whatever Herdr says of the turn after.
    expect(await m.take()).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    expect(sentTexts.recent(m.backend, "w1:p1", run)).toEqual([]);
  });

  it("a genuine take-back still works with Herdr's same turn (the control)", async () => {
    const m = machine();
    expect(await m.take()).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    expect(m.claude.keysSent()).toEqual(["Up", "ctrl+u"]);
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual([]);
  });
});

// MARK: - never a key into a dialog

describe("never a key into a dialog, and a dialog is a refusal, not no queue", () => {
  it("a dialog in the before-read (no box, the queue hint hidden): a refusal, no key, and no stop follows", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["abc"], dialog: true }));
    const result = await m.take();
    expect(result).toEqual({ type: "left", note: takeBackTexts.noBox, pressed: false });
    expect(result.type).not.toBe("none");
    expect(m.claude.keysSent()).toEqual([]);
  });

  it("a screen with no box but the queue showing: the dialog note, no key", async () => {
    const claude = new FakeClaudeQueue({ queued: ["abc"] });
    const site = siteOf(claude);
    site.read = async () => `${queueScreen(claude.state).split("\n").slice(0, 6).join("\n")}\nDo you want to proceed?\n\u{276F} 1. Yes`;
    expect(await takeBackQueued(site, forTexts(claude, ["abc"]))).toEqual({ type: "left", note: takeBackTexts.dialog, pressed: false });
    expect(claude.keysSent()).toEqual([]);
  });

  it.each([1, 2])("a dialog arriving after read %i gets no key", async (n) => {
    const m = machine();
    const intoDialog: string[] = [];
    m.afterRead((read) => {
      if (read === n) dialogArrives(m.now, m.claude);
    });
    const original = m.claude.keys.bind(m.claude);
    m.claude.keys = (keys) => {
      if (m.claude.state.dialog) intoDialog.push(...keys);
      original(keys);
    };
    const result = await m.take();
    expect(intoDialog).toEqual([]);
    expect(result.type).toBe("left");
    expect(m.claude.keysSent()).toEqual(n === 1 ? [] : ["Up"]);
  });

  it("Herdr's input pending alone (a menu Claude's screen has not drawn yet) calls off the next key", async () => {
    const m = machine();
    m.afterRead((read) => {
      if (read === 2) m.now.agent = { ...m.now.agent, inputPending: true };
    });
    expect((await m.take()).type).toBe("left");
    expect(m.claude.keysSent()).toEqual(["Up"]);
  });
});

// MARK: - the command connection is part of the binding

describe("the command connection is part of the binding", () => {
  it("the command epoch changes after the first read: no key", async () => {
    const m = machine();
    m.afterRead((read) => {
      if (read === 1) m.now.epoch += 1;
    });
    expect((await m.take()).type).toBe("left");
    expect(m.claude.keysSent()).toEqual([]);
  });

  it("the command epoch changes after Up: no Ctrl+U", async () => {
    const m = machine();
    m.afterRead((read) => {
      if (read === 2) m.now.epoch += 1;
    });
    expect((await m.take()).type).toBe("left");
    expect(m.claude.keysSent()).toEqual(["Up"]);
  });

  it("a stale page connection: refused before any read, said", async () => {
    const m = machine();
    m.now.connection = 4;
    m.now.epoch = 8;
    expect(await m.take()).toEqual({ type: "left", note: takeBackTexts.connection, pressed: false });
    expect(m.claude.log).toEqual([]);
  });

  it("a page binding with no command epoch: refused, no key", async () => {
    const m = machine();
    expect(await m.take(["abc"], { ...binding, epoch: null as unknown as number })).toEqual({ type: "left", note: takeBackTexts.connection, pressed: false });
    expect(m.claude.keysSent()).toEqual([]);
  });
});

// MARK: - a Send never joins the pulled text

describe("a Send made during a take-back waits for it", () => {
  it("abc taken back while abcd is sent at once: Claude gets exactly abcd", async () => {
    const m = machine();
    // The box was read since the last Esc: a Send would not read it again by itself.
    boxChecks.checked(m.backend, "w1:p1");
    let sending: Promise<void> | null = null;
    m.claude.beforeKey = (keys) => {
      // The user's Send of the edited text, the moment Up has pulled the queue into Claude's input row.
      if (keys[0] === "Up" && sending === null) sending = m.send("abcd");
    };
    const taken = await m.take();
    await sending;
    expect(taken).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    expect(m.claude.state.queued).toEqual(["abcd"]);
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual(["abcd"]);
  });

  it("a Send that arrives first goes first; the take-back then reads the box as it is", async () => {
    const m = machine(new FakeClaudeQueue({ queued: [] }));
    const sending = m.send("abc");
    const taking = m.take();
    await sending;
    expect(await taking).toEqual({ type: "taken", texts: ["abc"], note: takeBackTexts.taken });
    m.claude.turnEnds();
    expect(m.claude.sent).toEqual([]);
  });
});

// MARK: - ownership is exact

describe("ownership keeps word boundaries", () => {
  it("a bc queued from Terminal beside Chat's abc is not taken: only Up, the row left, said", async () => {
    const claude = new FakeClaudeQueue({ queued: ["a bc"] });
    const result = await takeBackQueued(siteOf(claude), forTexts(claude, ["abc"]));
    expect(result).toEqual({ type: "left", note: takeBackTexts.alsoTerminal, pressed: true });
    expect(claude.keysSent()).toEqual(["Up"]);
    expect(claude.state.input).toBe("a bc");
  });

  it("the same through main's handler: Terminal's line is never erased", async () => {
    const m = machine(new FakeClaudeQueue({ queued: ["a bc"] }));
    expect((await m.take()).type).toBe("left");
    expect(m.claude.keysSent()).toEqual(["Up"]);
    expect(m.claude.state.input).toBe("a bc");
  });

  it("matches words with their boundaries, a row break only where the screen wraps", () => {
    expect(showsExactly("abc", ["abc"], 80)).toBe(true);
    expect(showsExactly("a bc", ["abc"], 80)).toBe(false);
    expect(showsExactly("abc", ["a bc"], 80)).toBe(false);
    // A short row then another: a newline, not a wrap.
    expect(showsExactly("ab\nc", ["abc"], 80)).toBe(false);
    expect(showsExactly("one\ntwo", ["one two"], 80)).toBe(false);
    expect(showsExactly("one\ntwo", ["one", "two"], 80)).toBe(true);
    expect(showsExactly("one\ntwo", ["one\ntwo"], 80)).toBe(true);
    // Spaces as many as the user typed read as one boundary; the box trims each row.
    expect(showsExactly("fix  the build", ["fix the build"], 80)).toBe(true);
  });

  it("a long message wrapped at the box's width is the user's (at a space, and inside a long word)", () => {
    const words = "careful message ".repeat(12).trim();
    const rows: string[] = [];
    let row = "";
    for (const word of words.split(" ")) {
      if (row !== "" && row.length + 1 + word.length > 78) {
        rows.push(row);
        row = word;
      } else row = row === "" ? word : `${row} ${word}`;
    }
    rows.push(row);
    expect(rows.length).toBeGreaterThan(1);
    expect(showsExactly(rows.join("\n"), [words], 80)).toBe(true);
    // The same rows in an unknown box: every break reads as a newline, so it is not claimed.
    expect(showsExactly(rows.join("\n"), [words], null)).toBe(false);
    const long = "x".repeat(100);
    expect(showsExactly(`${long.slice(0, 78)}\n${long.slice(78)}`, [long], 80)).toBe(true);
    expect(showsExactly(`${long.slice(0, 40)}\n${long.slice(40)}`, [long], 80)).toBe(false);
  });

  it("pictures as their paths, as chips in place, or chips first", () => {
    const sent = "look /fake/uploads/a.png";
    expect(showsExactly("look /fake/uploads/a.png", [sent], 80)).toBe(true);
    expect(showsExactly("look [Image #18]", [sent], 80)).toBe(true);
    expect(showsExactly("[Image #18]look", [sent], 80)).toBe(true);
    expect(showsExactly("[Image #18] [Image #19]look", [sent], 80)).toBe(false);
    expect(showsExactly("[Image #18]lo ok", [sent], 80)).toBe(false);
  });

  it("the box's width comes from its bottom rule", () => {
    expect(claudeBoxWidth(queueScreen({ queued: ["abc"], input: "", working: true, dialog: false }))).toBe(80);
    expect(claudeBoxWidth(queueScreen({ queued: ["abc"], input: "", working: true, dialog: true }))).toBeNull();
  });
});

// MARK: - an unknown read is not "no queue"

describe("a read that failed, or a request refused, is a refusal", () => {
  it("a failed first read: a refusal with its note, no key; a Stop pressed after it is the next Esc's", async () => {
    const m = machine();
    m.failRead((read) => read === 1);
    const result = await m.take();
    expect(result).toEqual({ type: "left", note: takeBackTexts.unread, pressed: false });
    expect(m.claude.keysSent()).toEqual([]);
    expect(m.claude.sent).toEqual([]);
    expect(m.claude.state.queued).toEqual(["abc"]);
  });

  it("nine queued texts (more than sentTexts keeps): a refusal with the limit in words, no read, no key", async () => {
    const m = machine();
    const nine = Array.from({ length: 9 }, (_, index) => `message ${index}`);
    const result = await m.take(nine);
    expect(result).toEqual({ type: "left", note: takeBackTexts.tooMany, pressed: false });
    expect(takeBackTexts.tooMany).toContain("more than 8");
    expect(m.claude.log).toEqual([]);
  });

  it("a read of the screen that shows no queue is still none (Esc stops the turn)", async () => {
    const m = machine(new FakeClaudeQueue({ queued: [] }));
    expect(await m.take()).toEqual({ type: "none" });
    expect(m.claude.keysSent()).toEqual([]);
  });

  it("no note in a take-back has an em dash", () => {
    for (const note of Object.values(takeBackTexts)) expect(note).not.toContain("\u{2014}");
  });
});
