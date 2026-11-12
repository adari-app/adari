// The reads after an
// Esc and a newer Send are not ordered (PaneReadGate orders reads, not a whole
// read, check and write). An Esc, then a quick Send on a slow link: the Send's
// box read sees it empty and its snapshot check waits; Claude puts the
// cancelled message back; the reads after the Esc capture it in a read whose
// answer is late; the Send writes its prompt (Claude joins it to the text in
// its box); then the late read comes back. Its cleanup must write no key now:
// Ctrl+U and Backspace would take the new message out with the old. Each
// composer write counts (composerWrites), and every cleanup binding is off
// once one started after it. Production PaneReadGate, sendBound,
// cleanupBinding, boundBoxSite, SentTexts and afterStopOnce (and, below, the
// main process's IPC); only the transport and the screen's timing are fakes.

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

import { afterStopOnce, boundBoxSite, PaneTurns, SentTexts, type ClaudeBoxSite } from "../src/main/herdr/claude-box";
import { boxRunOf, cleanupBinding, sendBound, type SendSite } from "../src/main/herdr/send";
import { PaneReadGate } from "../src/shared/chat/live-reader";
import { IPC } from "../src/shared/ipc-contract";
import { claudeScreen } from "./support/claude-screens";
import { checkHerdrKeys } from "./support/herdr-keys";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

const old = "old message";
const fresh = "new message";
const binding = { terminalID: "t", isAgent: true, kind: "claude", session: "s" };

/** A promise the test lets go of. */
function held(): { promise: Promise<void>; release: () => void; started: boolean } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release, started: false };
}

async function until(what: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !what(); i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(what()).toBe(true);
}

/**
 * Claude's box on one pane: Herdr's prompt joins text left in the box (it stays there), else it is taken; a
 * Ctrl+U empties the box. Reads go through the production PaneReadGate; read `holdAt` captures the screen,
 * then answers only when `lateRead` is let go.
 */
function pane(holdAt: number | null) {
  let draft = "";
  let reads = 0;
  const log: string[] = [];
  const gate = new PaneReadGate();
  const lateRead = held();
  const checkWaits = held();
  const writer = {
    prompt: async (_pane: string, text: string) => {
      log.push(`prompt:${text}`);
      if (draft !== "") draft += text;
    },
    sendInput: async () => undefined,
    sendText: async () => undefined,
    agentKeys: async (_pane: string, keys: readonly string[]) => {
      checkHerdrKeys(keys);
      log.push(`clear:${draft}`);
      draft = "";
    },
  };
  const box: ClaudeBoxSite = {
    read: () =>
      gate.reading("synthetic:p", async () => {
        const index = reads;
        reads += 1;
        const screen = claudeScreen({ draft });
        log.push(`read:${draft}`);
        if (index === holdAt) {
          lateRead.started = true;
          await lateRead.promise;
        }
        return screen;
      }),
    keys: (keys) => writer.agentKeys("p", keys),
    wait: async () => undefined,
  };
  const sent = new SentTexts();
  const site: SendSite = {
    writer,
    fresh: async () => {
      checkWaits.started = true;
      await checkWaits.promise;
      return true;
    },
    pane: () => ({ paneID: "p", terminalID: "t", workspaceID: "w", tabID: "tab", focused: false, agent: "claude", agentStatus: "idle", revision: 1 }) as never,
    agent: () => ({ paneID: "p", terminalID: "t", agent: "claude", turnEpoch: 1, agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s" } }) as never,
    run: () => ({ connection: 1, arrival: 1 }),
    inputGeneration: () => 0,
    box: { site: box, own: (run) => sent.recent(writer, "p", run), sent: (text, run) => sent.record(writer, "p", text, run), marks: () => 1, machine: () => true },
  };
  sent.record(writer, "p", old, boxRunOf(site));
  return {
    log,
    site,
    box,
    sent,
    writer,
    lateRead,
    checkWaits,
    get draft() {
      return draft;
    },
    restore() {
      draft = old;
      log.push("Claude puts the cancelled message back");
    },
    /** The reads after the Esc, bound as the main process binds them. */
    afterEsc() {
      const bound = cleanupBinding(site, binding, site.box!);
      return afterStopOnce(writer, "p", boundBoxSite(box, bound.holds), sent, new PaneTurns(), undefined, bound.run);
    },
  };
}

describe("the reads after an Esc never clear a newer Send's text", () => {
  it("the slow-link interleaving: read empty, Claude restores the old message, the late read sees it, the prompt goes, then no clear", async () => {
    const p = pane(1);
    const sending = sendBound(p.site, "p", fresh, binding);
    await until(() => p.checkWaits.started);
    p.restore();
    const after = p.afterEsc();
    await until(() => p.lateRead.started);
    p.checkWaits.release();
    await sending;
    expect(p.draft).toBe(old + fresh);
    p.lateRead.release();
    expect(await after).toEqual({ cancelled: old, cleared: false });
    expect(p.log).toEqual([`read:`, "Claude puts the cancelled message back", `read:${old}`, `prompt:${fresh}`]);
    expect(p.draft).toBe(old + fresh);
  });

  it("the reads after the Esc that end before the Send's write still take our message out (the normal case)", async () => {
    const p = pane(null);
    const sending = sendBound(p.site, "p", fresh, binding);
    await until(() => p.checkWaits.started);
    p.restore();
    expect(await p.afterEsc()).toEqual({ cancelled: old, cleared: true });
    p.checkWaits.release();
    await sending;
    expect(p.log).toEqual([`read:`, "Claude puts the cancelled message back", `read:${old}`, `clear:${old}`, "read:", `prompt:${fresh}`]);
  });

  it("a cleanup is called off by a composer write that starts after it, not by its own keys", async () => {
    const p = pane(null);
    const bound = cleanupBinding(p.site, binding, p.site.box!);
    expect(bound.holds()).toBe(true);
    await p.writer.agentKeys("p", ["ctrl+u", "Backspace"]);
    expect(bound.holds()).toBe(true);
    p.checkWaits.release();
    await sendBound(p.site, "p", fresh, binding);
    expect(bound.holds()).toBe(false);
    expect(cleanupBinding(p.site, binding, p.site.box!).holds()).toBe(true);
  });
});

// MARK: - the same, through the main process (paneSend, paneAfterStop) and the panes' shared read gate

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

function mac() {
  let draft = "";
  let reads = 0;
  let holdAt: number | null = null;
  const log: string[] = [];
  const lateRead = held();
  const checkWaits = held();
  let checkHeld = false;
  const backend = {
    promptIO: () => ({
      paneRead: async () => {
        const index = reads;
        reads += 1;
        const screen = claudeScreen({ draft });
        log.push(`read:${draft}`);
        if (index === holdAt) {
          lateRead.started = true;
          await lateRead.promise;
        }
        return screen;
      },
      paneSendKeys: async () => undefined,
    }),
    prompt: async (_pane: string, text: string) => {
      log.push(`prompt:${text}`);
      if (draft !== "") draft += text;
    },
    agentKeys: async (_pane: string, keys: readonly string[]) => {
      checkHerdrKeys(keys);
      log.push(`clear:${draft}`);
      draft = "";
    },
    sendText: async () => undefined,
    sendInput: async () => undefined,
  };
  const shownPane = { paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 };
  const shownAgent = { paneID: "w1:p1", agent: "claude", terminalID: "t1", agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s1" }, turnEpoch: 7 };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => shownPane,
    agent: () => shownAgent,
    run: () => ({ connection: 3, arrival: 1 }),
    fresh: async () => {
      if (checkHeld) {
        checkWaits.started = true;
        await checkWaits.promise;
      }
      return true;
    },
    refresh: async () => undefined,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
  };
  registerIpc({ hosts, cursorReads: { gate: new PaneReadGate(), noteScreen: () => undefined, notePick: () => undefined } } as never);
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1, isDestroyed: () => false, send: () => undefined } };
  const outcome = (sending: Promise<void>): Promise<string> =>
    sending.then(
      () => "sent",
      (error: Error) => error.message,
    );
  return {
    log,
    lateRead,
    checkWaits,
    get draft() {
      return draft;
    },
    restore() {
      draft = old;
      log.push("Claude puts the cancelled message back");
    },
    /** From here: the Send's snapshot check waits until let go; read `index` (from 0, counted from now) is late. */
    next(index: number | null) {
      reads = 0;
      holdAt = index;
      checkHeld = true;
      log.length = 0;
    },
    send: (text: string) => outcome(registered.handles.get(IPC.paneSend)!(event, "mini", "w1:p1", text, sendBinding) as Promise<void>),
    afterStop: () => registered.handles.get(IPC.paneAfterStop)!(event, "mini", "w1:p1", stopBinding) as Promise<{ cancelled: string | null; cleared: boolean }>,
  };
}

describe("main: paneAfterStop and a newer paneSend on the shared read gate", () => {
  it("the late after-Esc read comes back after the Send's prompt: no key, the new message stays", async () => {
    const m = mac();
    expect(await m.send(old)).toBe("sent");
    m.next(1);
    const sending = m.send(fresh);
    await until(() => m.checkWaits.started);
    m.restore();
    const after = m.afterStop();
    await until(() => m.lateRead.started);
    m.checkWaits.release();
    expect(await sending).toBe("sent");
    m.lateRead.release();
    expect(await after).toMatchObject({ cancelled: old, cleared: false });
    expect(m.log).toEqual([`read:`, "Claude puts the cancelled message back", `read:${old}`, `prompt:${fresh}`]);
    expect(m.draft).toBe(old + fresh);
  });

  it("an after-Esc cleanup that ends before the Send's write still clears, then the Send goes (the normal case)", async () => {
    const m = mac();
    expect(await m.send(old)).toBe("sent");
    m.next(null);
    const sending = m.send(fresh);
    await until(() => m.checkWaits.started);
    m.restore();
    expect(await m.afterStop()).toMatchObject({ cancelled: old, cleared: true });
    m.checkWaits.release();
    expect(await sending).toBe("sent");
    expect(m.log).toEqual([`read:`, "Claude puts the cancelled message back", `read:${old}`, `clear:${old}`, "read:", `prompt:${fresh}`]);
    expect(m.draft).toBe("");
  });
});
