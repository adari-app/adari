// Through the main process: a message Esc brought back to Chat, part of it left in Claude Code's box
// (a row the clearing keys did not reach). The next Send clears that start of it first and is refused with a plain
// line while it will not clear, so it never joins the next prompt; text that is not part of it lets the Send go as
// before. Every case has blank lines in the message. Fakes only: the IPC with a fake machine, no socket.

const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => void) => registered.ons.set(channel, listener),
  },
}));

import { describe, expect, it, vi } from "vitest";

import { beforeSend, type ClaudeBoxSite, type LeftoverRun } from "../src/main/herdr/claude-box";
import { claudeBoxTexts } from "../src/shared/claude-screen";
import { IPC } from "../src/shared/ipc-contract";
import { blankLineMessages } from "./support/blank-lines";
import { FakeClaudeQueue } from "./support/claude-queue-screens";
import { claudeScreen } from "./support/claude-screens";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

const stopBinding = {
  terminalID: "t1",
  kind: "claude",
  session: "s1",
  episode: { status: "working", seq: "12", since: null },
  incarnation: 1,
  connection: 3,
  epoch: 7,
  name: "Claude Code",
};
const sendBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };

/**
 * One machine through the IPC, Claude Code's box as the queue fake draws it. Herdr's prompt types into the box and
 * presses Return, so text left there joins it. `stubborn`: the box's first row never clears (a row the keys miss).
 */
function mac(claude: FakeClaudeQueue, stubborn: string | null = null) {
  const prompts: string[] = [];
  const keys: string[][] = [];
  const backend = {
    promptIO: () => ({ paneRead: async () => claude.read(), paneSendKeys: async () => undefined }),
    prompt: async (_pane: string, text: string) => {
      prompts.push(text);
      const joined = claude.state.input + text;
      claude.state.input = "";
      claude.prompt(joined);
    },
    agentKeys: async (_pane: string, sent: readonly string[]) => {
      keys.push([...sent]);
      claude.keys(sent);
      if (stubborn !== null && claude.state.input === "") claude.state.input = stubborn;
    },
    sendText: async () => undefined,
    sendInput: async () => undefined,
  };
  const shownPane = { paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 };
  const session = { value: "s1" };
  const shownAgent = () => ({ paneID: "w1:p1", agent: "claude", agentStatus: "idle", terminalID: "t1", agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: session.value }, turnEpoch: 7 });
  const hosts = {
    backend: () => backend,
    name: () => "Fixture host",
    pane: () => shownPane,
    agent: () => shownAgent(),
    run: () => ({ connection: 3, arrival: 1 }),
    fresh: async () => true,
    refresh: async () => undefined,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
  };
  registerIpc({ hosts } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1, isDestroyed: () => false, send: () => undefined } };
  return {
    prompts,
    keys,
    /** A new agent session in the pane (a /clear, or another Claude Code started there). */
    newSession: (value: string) => void (session.value = value),
    send: (text: string) =>
      (registered.handles.get(IPC.paneSend)!(event, "fixture-host", "w1:p1", text, { ...sendBinding, session: session.value }) as Promise<unknown>).then(
        () => "sent",
        (error: Error) => error.message,
      ),
    afterStop: () => registered.handles.get(IPC.paneAfterStop)!(event, "fixture-host", "w1:p1", stopBinding) as Promise<{ cancelled: string | null; cleared: boolean }>,
  };
}

describe("a Send after an Esc's leftover (main)", () => {
  for (const [shape, text] of blankLineMessages) {
    it(`${shape}: the box's first row will not clear: the next Send is refused with a plain line and never joins it`, async () => {
      const claude = new FakeClaudeQueue({ working: false });
      const m = mac(claude, "first line");
      expect(await m.send(text)).toBe("sent");
      // Esc: Claude Code puts the message back; the clear leaves its first row.
      claude.state.input = text;
      expect(await m.afterStop()).toMatchObject({ cancelled: text, cleared: false });
      expect(claude.state.input).toBe("first line");
      expect(await m.send("the next message")).toBe(claudeBoxTexts.leftNotSent);
      expect(m.prompts).toEqual([text]);
      expect(claude.sent).toEqual([text]);
    });
  }

  it("the leftover clears on the next Send's read: it goes alone, never joined", async () => {
    const claude = new FakeClaudeQueue({ working: false });
    const text = "first line\n\nsecond line";
    let stubborn: string | null = "first line";
    const m = mac(claude, null);
    expect(await m.send(text)).toBe("sent");
    claude.state.input = text;
    // The Esc's clear misses the first row once (as a reader that dropped blank rows did).
    const original = claude.keys.bind(claude);
    claude.keys = (keys) => {
      original(keys);
      if (stubborn !== null && claude.state.input === "") {
        claude.state.input = stubborn;
        stubborn = null;
      }
    };
    const back = await m.afterStop();
    expect(back.cancelled).toBe(text);
    expect(await m.send("the next message")).toBe("sent");
    expect(claude.sent).toEqual([text, "the next message"]);
  });

  it("other text in the box (not a start of it) lets the Send go as before, with no key and no note", async () => {
    const claude = new FakeClaudeQueue({ working: false });
    const m = mac(claude, "first line");
    const text = "first line\n\nsecond line";
    expect(await m.send(text)).toBe("sent");
    claude.state.input = text;
    await m.afterStop();
    // The user cleared it in the terminal and typed their own words.
    claude.state.input = "my own words";
    expect(await m.send(" and more")).toBe("sent");
    expect(claude.sent.at(-1)).toBe("my own words and more");
  });
});

describe("beforeSend with an Esc's leftover row", () => {
  const site = (claude: FakeClaudeQueue): ClaudeBoxSite => ({ read: async () => claude.read(), keys: async (keys) => claude.keys(keys), wait: async () => undefined });
  for (const [shape, text] of blankLineMessages) {
    it(`${shape}: a start of it in the box is cleared, the row resolved, and the Send goes`, async () => {
      const claude = new FakeClaudeQueue({ input: "first line", working: false });
      let resolved = 0;
      // The row belongs to the run it came from, the pane's run now.
      const run = { terminalID: "t1", session: "s1", generation: 0 };
      const went = await beforeSend(site(claude), [], undefined, { left: { spare: [text], note: claudeBoxTexts.leftNotSent, loose: true, run }, resolved: () => void resolved++, runNow: run });
      expect(went).toEqual({ type: "go", cleared: text });
      expect(claude.state.input).toBe("");
      expect(resolved).toBe(1);
    });
  }
});

// An Esc's loose leftover row belongs to the run it came from (the pane's terminal,
// its agent session, its Terminal input count). From another run, or with none kept, it is stale: dropped, it never
// refuses a Send and never authorizes a clear, so the person's own words that happen to start the same way stay.
describe("a leftover belongs to its run (fix 4)", () => {
  const old = "old caption\nsecond";
  const run: LeftoverRun = { terminalID: "t1", session: "s1", generation: 0 };
  /** The box shows `draft`; every key is kept, a key empties it. */
  const box = (draft: string) => {
    const state = { draft, keys: [] as string[][] };
    const site: ClaudeBoxSite = { read: async () => claudeScreen({ draft: state.draft }), keys: async (keys) => void (state.keys.push([...keys]), (state.draft = "")), wait: async () => undefined };
    return { state, site };
  };
  const stale: [string, LeftoverRun | undefined, LeftoverRun | null | undefined][] = [
    ["a new session in the pane", run, { ...run, session: "s2" }],
    ["another terminal", run, { ...run, terminalID: "t2" }],
    ["typing in the Terminal since (its input count moved)", run, { ...run, generation: 1 }],
    ["a row with no run kept (the reviewer's case)", undefined, undefined],
    ["the pane's run not known now", run, null],
  ];
  for (const [name, from, now] of stale) {
    it(`${name}: the row is dropped, nothing is cleared, the Send goes`, async () => {
      const { state, site } = box("old caption");
      let resolved = 0;
      const left = { spare: [old], note: claudeBoxTexts.leftNotSent, loose: true as const, ...(from === undefined ? {} : { run: from }) };
      const went = await beforeSend(site, [], undefined, { left, resolved: () => void resolved++, ...(now === undefined ? {} : { runNow: now }) });
      expect(went).toEqual({ type: "go", cleared: null });
      expect(state.keys).toEqual([]);
      expect(state.draft).toBe("old caption");
      expect(resolved).toBe(1);
    });
  }

  it("the same run: a start of it is still cleared first (as before)", async () => {
    const { state, site } = box("old caption");
    const went = await beforeSend(site, [], undefined, { left: { spare: [old], note: claudeBoxTexts.leftNotSent, loose: true, run }, resolved: () => undefined, runNow: run });
    expect(went).toEqual({ type: "go", cleared: old });
    expect(state.keys.length).toBeGreaterThan(0);
  });

  it("through the IPC: Esc leaves a row, a new session starts, the person's own words that start the same way are never cleared nor refused", async () => {
    const claude = new FakeClaudeQueue({ working: false });
    const m = mac(claude, "first line");
    const text = "first line\n\nsecond line";
    expect(await m.send(text)).toBe("sent");
    claude.state.input = text;
    expect(await m.afterStop()).toMatchObject({ cancelled: text, cleared: false });
    expect(claude.state.input).toBe("first line");
    // Same run: refused with the leftover line.
    expect(await m.send("the next message")).toBe(claudeBoxTexts.leftNotSent);
    m.newSession("s2");
    const before = m.keys.length;
    expect(await m.send(" and more")).toBe("sent");
    expect(m.keys.slice(before)).toEqual([]);
    expect(claude.sent.at(-1)).toBe("first line and more");
  });
});

// A message stuck in Claude's box after its corrective Return that shows only its
// start (its caption, without its chip or path) still refuses another message, before the other-text branch, so it is
// never joined. The same words sent again replace it; a read of the box without it drops its mark; text that is not
// the app's is never cleared.
describe("a stuck message that shows only its start still refuses (fix 5)", () => {
  const picture = "/fake/.adari-attachments-0123/attachment-11111111-1111-1111-1111-111111111111.png";
  const text = `review caption ${picture}`;
  const box = (draft: string) => {
    const state = { draft, keys: [] as string[][] };
    const site: ClaudeBoxSite = { read: async () => claudeScreen({ draft: state.draft }), keys: async (keys) => void (state.keys.push([...keys]), (state.draft = "")), wait: async () => undefined };
    return { state, site };
  };
  for (const shown of ["review caption", "[Image #1] review caption", "review", "review caption [Image #1]"]) {
    it(`the box shows ${JSON.stringify(shown)}: another message is refused, nothing cleared (the reviewer's case)`, async () => {
      const { state, site } = box(shown);
      const gone: string[] = [];
      expect(await beforeSend(site, [text], undefined, undefined, { texts: [text], sending: "other", gone: (one) => void gone.push(one) })).toEqual({ type: "refused", note: claudeBoxTexts.stuckNotSent });
      expect(state.keys).toEqual([]);
      expect(gone).toEqual([]);
    });
  }

  it("the same words sent again: the start is cleared first and the Send goes", async () => {
    const { state, site } = box("review caption");
    expect(await beforeSend(site, [text], undefined, undefined, { texts: [text], sending: text })).toEqual({ type: "go", cleared: text });
    expect(state.keys.length).toBeGreaterThan(0);
  });

  it("a read without it drops its mark: an empty box, or the person's own words; theirs are never cleared", async () => {
    for (const draft of ["", "my own words"]) {
      const { state, site } = box(draft);
      const gone: string[] = [];
      expect(await beforeSend(site, [text], undefined, undefined, { texts: [text], sending: "other", gone: (one) => void gone.push(one) })).toEqual({ type: "go", cleared: null });
      expect(gone).toEqual([text]);
      expect(state.keys).toEqual([]);
    }
  });
});
