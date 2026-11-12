// The automatic clean-up of
// Claude Code's box (Ctrl+U and Backspace taking our own message back out of
// it) is bound to the run it belongs to. Before a send, our message found in
// the box, the send's own checks (a fresh snapshot, its run, its pane,
// terminal, agent and session) run before any key; each key then goes only
// while the binding taken before the read still holds (the machine, the
// terminal, the session and the run, and no Terminal input since); a second
// attempt goes only while the box still holds exactly our message. Only a
// message sent to the run in the pane now is ours. The reads after an Esc
// are bound the same way. Fakes only: no SSH, no Herdr, no socket.

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

import { afterStop, beforeSend, clearClaudeBox, type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { guardTexts, sendBound, type SendSite } from "../src/main/herdr/send";
import { IPC } from "../src/shared/ipc-contract";
import { claudeBoxTexts } from "../src/shared/claude-screen";
import { runChangedText } from "../src/shared/send-binding";
import { claudeScreen } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { PaneInputs } = await import("../src/main/pane-inputs");

const ours = "esc does not work";
const theirs = "half a command typed in the terminal";
const claudeBinding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };

/** The pane as the latest snapshot shows it; tests change it between reads. */
interface Shown {
  terminalID: string;
  session: string;
  arrival: number;
  epoch: number;
  connection: number;
}

const shownPane = (now: Shown) => ({ paneID: "w1:p1", terminalID: now.terminalID, workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 });
const shownAgent = (now: Shown) => ({
  paneID: "w1:p1",
  agent: "claude",
  terminalID: now.terminalID,
  agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: now.session },
  turnEpoch: now.epoch,
});

/**
 * A Claude pane for sendBound: its screens come one per read (the last repeats), `onRead[i]` runs as read i
 * answers (the pane changing between that read and the next key); every write is logged. `own` is what the
 * box's owner says is ours; Terminal input and box marks are counted as the main process counts them.
 */
function pane(screens: readonly string[], options: { own?: readonly string[]; onRead?: Record<number, (now: Shown) => void>; run?: SendSite["run"] } = {}) {
  const log: unknown[][] = [];
  const now: Shown = { terminalID: "t1", session: "s1", arrival: 1, epoch: 7, connection: 3 };
  const counts = { inputs: 0, marks: 0 };
  let read = 0;
  const box: ClaudeBoxSite = {
    read: async () => {
      const index = read;
      read += 1;
      log.push(["read"]);
      options.onRead?.[index]?.(now);
      return screens[Math.min(index, screens.length - 1)]!;
    },
    keys: async (keys) => {
      checkHerdrKeys(keys);
      log.push(["keys", [...keys]]);
    },
    wait: async () => undefined,
  };
  const site: SendSite = {
    writer: {
      prompt: async (_pane, text) => void log.push(["prompt", text]),
      sendInput: async () => undefined,
      sendText: async () => undefined,
      agentKeys: async (_pane, keys) => void log.push(["agentKeys", [...keys]]),
    },
    fresh: async () => true,
    pane: () => shownPane(now) as never,
    agent: () => shownAgent(now) as never,
    run: options.run ?? (() => ({ connection: now.connection, arrival: now.arrival })),
    inputGeneration: () => counts.inputs,
    box: { site: box, own: () => options.own ?? [ours], sent: () => undefined, marks: () => counts.marks },
  };
  const keys = () => log.filter((entry) => entry[0] === "keys" || entry[0] === "agentKeys");
  const prompts = () => log.filter((entry) => entry[0] === "prompt");
  return { log, now, counts, site, keys, prompts };
}

const outcome = (sending: Promise<void>): Promise<string> =>
  sending.then(
    () => "sent",
    (error: Error) => error.message,
  );

describe("the send: the send's own checks refuse the target, no cleanup key is written", () => {
  it("another program in the pane by the fresh snapshot: refused with its note, no key, nothing deleted", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()], { onRead: { 0: (now) => void (now.terminalID = "t2") } });
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(guardTexts.otherProgram);
    expect(p.keys()).toEqual([]);
    expect(p.prompts()).toEqual([]);
  });

  it("no fresh snapshot came: refused with its note, no key", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()]);
    p.site.fresh = async () => false;
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(guardTexts.unchecked("claude"));
    expect(p.keys()).toEqual([]);
  });

  it("a hand-off's picked run no longer there: refused as not the one picked, no key", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()], { onRead: { 0: (now) => void (now.arrival = 2) } });
    const picked = { ...claudeBinding, run: { connection: 3, arrival: 1 } };
    expect(await outcome(sendBound(p.site, "w1:p1", "next", picked))).toBe(runChangedText(picked));
    expect(p.keys()).toEqual([]);
  });

  it("another Claude session in the same terminal: refused, no key", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()], { onRead: { 0: (now) => void (now.session = "s2") } });
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(guardTexts.changedAgent);
    expect(p.keys()).toEqual([]);
  });
});

describe("the send: between the read and a key write the run changes or the Terminal gets new text", () => {
  for (const [what, change] of [
    ["a new agent run arrived in the pane", (now: Shown) => void (now.arrival += 1)],
    ["Herdr's generation for the pane changed (a restart behind it)", (now: Shown) => void (now.epoch += 1)],
    ["the machine reconnected", (now: Shown) => void (now.connection += 1)],
  ] as const) {
    it(`${what}: no key, nothing deleted, the send says the box still has text`, async () => {
      const p = pane([claudeScreen({ draft: ours }), claudeScreen()], { onRead: { 0: change } });
      expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(claudeBoxTexts.notSentStillHasText);
      expect(p.keys()).toEqual([]);
      expect(p.prompts()).toEqual([]);
    });
  }

  it("typing in the Terminal view meanwhile: no key, the send says the box still has text", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()]);
    p.site.box!.site.read = ((read) => async () => {
      const screen = await read();
      p.counts.inputs += 1;
      return screen;
    })(p.site.box!.site.read);
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(claudeBoxTexts.notSentStillHasText);
    expect(p.keys()).toEqual([]);
  });

  it("a Stop or Esc meanwhile (a box mark): no key", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()]);
    p.site.box!.site.read = ((read) => async () => {
      const screen = await read();
      p.counts.marks += 1;
      return screen;
    })(p.site.box!.site.read);
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(claudeBoxTexts.notSentStillHasText);
    expect(p.keys()).toEqual([]);
  });

  it("the run cannot be read (the machine not answering): no key", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()], { run: () => null });
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(claudeBoxTexts.notSentStillHasText);
    expect(p.keys()).toEqual([]);
  });

  it("the binding is asked right before each key: a change after the first key stops the second", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen({ draft: ours })], { onRead: { 1: (now) => void (now.arrival += 1) } });
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(claudeBoxTexts.notSentStillHasText);
    expect(p.keys()).toEqual([["keys", ["ctrl+u", "Backspace"]]]);
  });
});

describe("a retry deletes only text it can still prove is our message", () => {
  it("the send: after the first keys the box holds other text: it is left there, the still-has-text note", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen({ draft: theirs })]);
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe(claudeBoxTexts.notSentStillHasText);
    expect(p.keys()).toEqual([["keys", ["ctrl+u", "Backspace"]]]);
    expect(p.prompts()).toEqual([]);
  });

  it("the send: our message still there after the first keys: tried once more", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen({ draft: ours }), claudeScreen()]);
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe("sent");
    expect(p.keys()).toEqual([
      ["keys", ["ctrl+u", "Backspace"]],
      ["keys", ["ctrl+u", "Backspace"]],
    ]);
    expect(p.prompts()).toEqual([["prompt", "next"]]);
  });

  it("after an Esc: the box holds other text after the first keys: one clear only, not proved empty", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen({ draft: theirs })]);
    expect(await afterStop(p.site.box!.site, ours)).toEqual({ cancelled: ours, cleared: false });
    expect(p.keys()).toEqual([["keys", ["ctrl+u", "Backspace"]]]);
  });

  it("clearClaudeBox and beforeSend leave a part of the message or new text alone", async () => {
    const p = pane([claudeScreen({ draft: "does not work" })]);
    expect(await clearClaudeBox(p.site.box!.site, ours)).toBe(false);
    expect(p.keys()).toHaveLength(1);
    const q = pane([claudeScreen({ draft: ours }), claudeScreen({ draft: theirs })]);
    expect(await beforeSend(q.site.box!.site, [ours])).toEqual({ type: "refused", note: claudeBoxTexts.notSentStillHasText });
    expect(q.keys()).toHaveLength(1);
  });
});

describe("the normal case", () => {
  it("our own message back in the box, the same run: cleared, proved empty, then the send goes", async () => {
    const p = pane([claudeScreen({ draft: ours }), claudeScreen()]);
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe("sent");
    expect(p.log).toEqual([["read"], ["keys", ["ctrl+u", "Backspace"]], ["read"], ["prompt", "next"]]);
  });

  it("other text in the box (not ours): one prompt, no key", async () => {
    const p = pane([claudeScreen({ draft: theirs })]);
    expect(await outcome(sendBound(p.site, "w1:p1", "next", claudeBinding))).toBe("sent");
    expect(p.log).toEqual([["read"], ["prompt", "next"]]);
  });
});

// MARK: - the main process: the Send and after-Esc IPC, bound

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

/** One machine through the IPC: its box's screen as set (`screens`, one per read, the last repeating), `onRead` hooks per read. */
function mac() {
  const log: unknown[][] = [];
  const now: Shown = { terminalID: "t1", session: "s1", arrival: 1, epoch: 7, connection: 3 };
  let screens: readonly string[] = [claudeScreen()];
  let reads = 0;
  let onRead: Record<number, () => void> = {};
  const backend = {
    promptIO: () => ({
      paneRead: async () => {
        const index = reads;
        reads += 1;
        log.push(["read"]);
        onRead[index]?.();
        return screens[Math.min(index, screens.length - 1)]!;
      },
      paneSendKeys: async () => undefined,
    }),
    prompt: async (_pane: string, text: string) => void log.push(["prompt", text]),
    agentKeys: async (_pane: string, keys: readonly string[]) => {
      checkHerdrKeys(keys);
      log.push(["keys", [...keys]]);
    },
    sendText: async () => undefined,
    sendInput: async () => undefined,
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => shownPane(now),
    agent: () => shownAgent(now),
    run: () => ({ connection: now.connection, arrival: now.arrival }),
    fresh: async () => true,
    refresh: async () => undefined,
    connection: () => now.connection,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
  };
  const paneInputs = new PaneInputs();
  registerIpc({ hosts, paneInputs } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1, isDestroyed: () => false, send: () => undefined } };
  return {
    log,
    now,
    paneInputs,
    show(next: readonly string[], hooks: Record<number, () => void> = {}) {
      screens = next;
      reads = 0;
      onRead = hooks;
      log.length = 0;
    },
    send: (text: string) => outcome(registered.handles.get(IPC.paneSend)!(event, "mini", "w1:p1", text, claudeBinding) as Promise<void>),
    afterStop: () => registered.handles.get(IPC.paneAfterStop)!(event, "mini", "w1:p1", stopBinding) as Promise<{ cancelled: string | null; cleared: boolean }>,
    keys: () => log.filter((entry) => entry[0] === "keys"),
  };
}

describe("in main: the Send IPC", () => {
  it("our message sent to this run, back in the box: cleared, then the next send goes alone", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.show([claudeScreen({ draft: ours }), claudeScreen()]);
    expect(await m.send("next")).toBe("sent");
    expect(m.log).toEqual([["read"], ["keys", ["ctrl+u", "Backspace"]], ["read"], ["prompt", "next"]]);
  });

  it("the same words in the box of a later run in the pane are not ours: no key, the send goes as for text not ours", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.now.arrival = 2;
    m.show([claudeScreen({ draft: ours })]);
    expect(await m.send("next")).toBe("sent");
    expect(m.keys()).toEqual([]);
  });

  it("a restart behind the pane (Herdr's generation) makes it another run's too: no key", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.now.epoch = 8;
    m.show([claudeScreen({ draft: ours })]);
    expect(await m.send("next")).toBe("sent");
    expect(m.keys()).toEqual([]);
  });

  it("typing in this app's Terminal between the read and the key: no key, nothing deleted, not sent", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.show([claudeScreen({ draft: ours }), claudeScreen()], { 0: () => m.paneInputs.bump("mini", "w1:p1") });
    expect(await m.send("next")).toBe(claudeBoxTexts.notSentStillHasText);
    expect(m.keys()).toEqual([]);
    expect(m.log.filter((entry) => entry[0] === "prompt")).toEqual([]);
  });

  it("the send's own check refuses the pane (another program now): its note, no key", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.show([claudeScreen({ draft: ours }), claudeScreen()], { 0: () => void (m.now.terminalID = "t2") });
    expect(await m.send("next")).toBe(guardTexts.otherProgram);
    expect(m.keys()).toEqual([]);
  });
});

describe("in main: the reads after an Esc", () => {
  it("our last send back in the box, the same run: cleared and proved empty", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.show([claudeScreen({ draft: ours }), claudeScreen()]);
    expect(await m.afterStop()).toMatchObject({ cancelled: ours, cleared: true });
    expect(m.keys()).toEqual([["keys", ["ctrl+u", "Backspace"]]]);
  });

  it("the last send went to an earlier run: the same words now are not taken back, no key", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.now.arrival = 2;
    m.show([claudeScreen({ draft: ours })]);
    expect(await m.afterStop()).toMatchObject({ cancelled: null, cleared: false });
    expect(m.keys()).toEqual([]);
  });

  it("another program in the pane between the read and the key: no key, the message back in Chat with its note", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.show([claudeScreen({ draft: ours }), claudeScreen()], { 0: () => void (m.now.terminalID = "t2") });
    expect(await m.afterStop()).toMatchObject({ cancelled: ours, cleared: false });
    expect(m.keys()).toEqual([]);
  });

  it("typing in this app's Terminal between the read and the key: no key", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.show([claudeScreen({ draft: ours }), claudeScreen()], { 0: () => m.paneInputs.bump("mini", "w1:p1") });
    expect(await m.afterStop()).toMatchObject({ cancelled: ours, cleared: false });
    expect(m.keys()).toEqual([]);
  });

  it("other text after the first keys: left in the box (one clear only)", async () => {
    const m = mac();
    expect(await m.send(ours)).toBe("sent");
    m.show([claudeScreen({ draft: ours }), claudeScreen({ draft: theirs })]);
    expect(await m.afterStop()).toMatchObject({ cancelled: ours, cleared: false });
    expect(m.keys()).toEqual([["keys", ["ctrl+u", "Backspace"]]]);
  });
});
