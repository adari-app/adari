// Input typed in the Terminal view (an Escape
// restoring a message, or plain text) can change Claude's box, so it marks that
// pane's box due, bound to the terminal's own machine and pane: the next Chat
// send with live events reads the box first. Fakes only: no SSH, no Herdr, no socket.

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

import { IPC } from "../src/shared/ipc-contract";
import { claudeScreen } from "./support/claude-screens";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { TerminalSessions } = await import("../src/main/terminals");

const pane = { paneID: "w1:p1", terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: "claude", agentStatus: "idle", revision: 1 };
const agent = { paneID: "w1:p1", agent: "claude", terminalID: "t1", agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "s1" } };
const binding = { terminalID: "t1", isAgent: true, kind: "claude", session: "s1" };

/** Two machines with the same pane id, the events live on both; each logs its box reads, prompts and typed bytes. */
function machines() {
  const log: string[] = [];
  const backendOf = (host: string) => ({
    promptIO: () => ({ paneRead: async () => (log.push(`${host}:read`), claudeScreen()) }),
    prompt: async () => void log.push(`${host}:prompt`),
    agentKeys: async () => undefined,
    sendText: async () => undefined,
    sendInput: async () => undefined,
    openTerminal: async () => ({ input: (bytes: Uint8Array) => void log.push(`${host}:typed ${JSON.stringify(Buffer.from(bytes).toString("latin1"))}`), resize: () => undefined, close: () => undefined }),
  });
  const backends = new Map([
    ["a", backendOf("a")],
    ["b", backendOf("b")],
  ]);
  const hosts = {
    backend: (id: string) => backends.get(id) ?? null,
    pane: () => pane,
    agent: () => agent,
    run: () => null,
    fresh: async () => true,
    refresh: async () => undefined,
    eventsLive: () => true,
  };
  const terminals = new TerminalSessions(hosts as never);
  registerIpc({ hosts, terminals } as never);
  const sender = { id: 1, isDestroyed: () => false, send: () => undefined };
  const event = { senderFrame: { url: APP_ORIGIN }, sender };
  return {
    log,
    open: async (hostId: string) => ((await registered.handles.get(IPC.terminalOpen)!(event, { hostId, paneId: "w1:p1", cols: 80, rows: 24 })) as { sessionId: string }).sessionId,
    type: (sessionId: string, data: string | Uint8Array) => registered.ons.get(IPC.terminalInput)!(event, sessionId, data),
    send: (hostId: string, text: string) => registered.handles.get(IPC.paneSend)!(event, hostId, "w1:p1", text, binding),
  };
}

describe("Terminal Esc marks that pane's Claude box due", () => {
  it("with live events a send skips the read; after Terminal Esc the next send reads the box first, then skips again", async () => {
    const m = machines();
    await m.send("b", "one");
    const session = await m.open("b");
    m.type(session, "\x1b");
    await m.send("b", "two");
    await m.send("b", "three");
    expect(m.log).toEqual(["b:prompt", 'b:typed "\\u001b"', "b:read", "b:prompt", "b:prompt"]);
  });

  it("bound to the terminal's own machine: the same pane id on another machine stays unread", async () => {
    const m = machines();
    const session = await m.open("b");
    m.type(session, "\x1b");
    await m.send("a", "elsewhere");
    await m.send("b", "here");
    expect(m.log).toEqual(['b:typed "\\u001b"', "a:prompt", "b:read", "b:prompt"]);
  });

  // Plain typing marks it too, so its first send is not left unread.
  it("an Esc in raw bytes or leading a key's sequence marks it, and plain typing too", async () => {
    const m = machines();
    const session = await m.open("b");
    m.type(session, "ls\r");
    await m.send("b", "plain");
    m.type(session, Uint8Array.of(0x1b));
    await m.send("b", "raw");
    m.type(session, "\x1b[A");
    await m.send("b", "arrow");
    expect(m.log.filter((line) => !line.includes("typed"))).toEqual(["b:read", "b:prompt", "b:read", "b:prompt", "b:read", "b:prompt"]);
  });

  it("typed 'abc' in the Terminal, then a Chat send with live events reads the box first; only on that machine", async () => {
    const m = machines();
    await m.send("b", "before");
    const session = await m.open("b");
    m.type(session, "abc");
    await m.send("a", "elsewhere");
    await m.send("b", "after");
    await m.send("b", "again");
    expect(m.log).toEqual(["b:prompt", 'b:typed "abc"', "a:prompt", "b:read", "b:prompt", "b:prompt"]);
  });
});
