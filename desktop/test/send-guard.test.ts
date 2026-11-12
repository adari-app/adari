// A Send is bound to the pane as the user saw it when they
// pressed Send (its terminal, whether an agent ran there, the agent's kind and
// Herdr session). Right before writing, a fresh snapshot must still show that;
// any change refuses with the Swift app's words (App/CompanionComposerModel.swift:
// CompanionAgentGuard, liveSendRefusal, CompanionPaneLifeBox) and nothing is
// written, so the text stays in the box. A paste for an agent is checked once
// more before its Return, which goes through Herdr's gated `agent.send_keys`.
// The send IPC handler runs here for real, on fakes for the machine. There is
// no automatic ⌃C, and a session named at Send must still be named.

import { describe, expect, it, vi } from "vitest";

import { HostRegistry } from "../src/main/hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { pasteEnd, pasteStart, sendBound, type SendSite } from "../src/main/herdr/send";
import { APIError, type AgentInfo, type SessionTopology, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { IPC } from "../src/shared/ipc-contract";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

interface PaneState {
  pane: TopologyPaneInfo | null;
  agent: AgentInfo | null;
}

function pane(terminalID: string, agent?: string): TopologyPaneInfo {
  return {
    paneID: "w1:p1",
    terminalID,
    workspaceID: "w1",
    tabID: "w1:t1",
    focused: false,
    agentStatus: agent === undefined ? "unknown" : "idle",
    revision: 1n as never,
    ...(agent === undefined ? {} : { agent }),
  };
}

function agent(kind: string, session?: string, terminalID = "t1"): AgentInfo {
  return {
    paneID: "w1:p1",
    agent: kind,
    terminalID,
    ...(session === undefined ? {} : { agentSession: { source: `herdr:${kind}`, agent: kind, kind: "id", value: session } }),
  };
}

const opencode = (session?: string, terminalID = "t1"): PaneState => ({ pane: pane(terminalID, "opencode"), agent: agent("opencode", session, terminalID) });
const claude = (session?: string): PaneState => ({ pane: pane("t1", "claude"), agent: agent("claude", session) });
const shell = (terminalID = "t1"): PaneState => ({ pane: pane(terminalID), agent: null });
const closed: PaneState = { pane: null, agent: null };

const bindOpencode = { terminalID: "t1", isAgent: true, kind: "opencode", session: "s-1" };
const bindClaude = { terminalID: "t1", isAgent: true, kind: "claude", session: "s-1" };
const bindShell = { terminalID: "t1", isAgent: false, kind: null, session: null };

/**
 * One machine: `cached` is the sidebar's last snapshot, `remote` what the
 * machine has now. `fresh` takes a new snapshot (remote becomes cached); the
 * backend records every write, and `afterText` may change the machine between
 * a paste and its Return.
 */
function machine(cached: PaneState, remote: PaneState = cached, options: { freshFails?: boolean; returnRefused?: boolean; live?: boolean } = {}) {
  const state = { cached, remote };
  const log: unknown[][] = [];
  let afterText: (() => void) | null = null;
  let afterReturn: (() => void) | null = null;
  const backend = {
    sendText: async (paneID: string, text: string) => {
      log.push(["text", paneID, text]);
      afterText?.();
    },
    sendInput: async (paneID: string, text: string, keys: readonly string[]) => void log.push(["input", paneID, text, keys]),
    prompt: async (paneID: string, text: string) => void log.push(["prompt", paneID, text]),
    agentKeys: async (paneID: string, keys: readonly string[]) => {
      log.push(["agentKeys", paneID, keys]);
      afterReturn?.();
      if (options.returnRefused === true) throw new APIError("agent_not_found", "agent target w1:p1 not found");
    },
    // The writer never uses it; kept so any key sent to the pane would show in the log.
    paneKeys: async (paneID: string, keys: readonly string[]) => void log.push(["paneKeys", paneID, keys]),
  };
  const hosts = {
    backend: () => backend,
    pane: (_hostId: string, paneId: string) => (state.cached.pane?.paneID === paneId ? state.cached.pane : null),
    agent: (_hostId: string, paneId: string) => (state.cached.agent?.paneID === paneId ? state.cached.agent : null),
    refresh: async () => undefined,
    fresh: async () => {
      log.push(["fresh"]);
      if (options.freshFails === true) return false;
      state.cached = state.remote;
      return true;
    },
    // `live`: the relay's sidebar events are live: a send's check is the latest
    // snapshot (`cached`, which the events keep current), no request; otherwise the hosts have no `current`.
    ...(options.live === true ? { current: async () => (log.push(["current"]), true), eventsLive: () => true } : {}),
  };
  registerIpc({ hosts } as never);
  const send = registered.handles.get(IPC.paneSend)!;
  return {
    log,
    state,
    onPaste: (change: () => void) => {
      afterText = change;
    },
    onReturn: (change: () => void) => {
      afterReturn = change;
    },
    send: (paneId: string, text: string, binding: unknown) => send(event, "host", paneId, text, binding) as Promise<void>,
  };
}

const writes = (log: unknown[][]) => log.filter((entry) => entry[0] !== "fresh");

describe("a Send bound to the pane the user chose", () => {
  it("refuses a pane the topology does not have, and writes nothing", async () => {
    const m = machine(closed);
    await expect(m.send("gone-pane", "hello", bindShell)).rejects.toThrow("Not sent: the pane is gone");
    expect(writes(m.log)).toEqual([]);
  });

  it("takes a fresh snapshot before writing to a cached paste-route agent, and refuses the shell it left", async () => {
    const m = machine(opencode("s-1"), shell());
    await expect(m.send("w1:p1", "hello\nworld", bindOpencode)).rejects.toThrow("opencode exited; not sent");
    expect(m.log).toEqual([["fresh"]]);
  });

  it("refuses another agent in the same terminal", async () => {
    const m = machine(opencode("s-1"), { pane: pane("t1", "grok"), agent: agent("grok", "s-9") });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow("Not sent: another agent is in this pane now");
    expect(writes(m.log)).toEqual([]);
  });

  it("refuses the same agent in a new session", async () => {
    const m = machine(opencode("s-1"), opencode("s-2"));
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow("Not sent: another agent is in this pane now");
    const c = machine(claude("s-1"), claude("s-2"));
    await expect(c.send("w1:p1", "hello", bindClaude)).rejects.toThrow("Not sent: another agent is in this pane now");
    expect([...writes(m.log), ...writes(c.log)]).toEqual([]);
  });

  it("refuses another terminal in the pane and a pane closed since", async () => {
    const moved = machine(opencode("s-1"), opencode("s-1", "t2"));
    await expect(moved.send("w1:p1", "hello", bindOpencode)).rejects.toThrow("Not sent: another program is in this pane now");
    const gone = machine(opencode("s-1"), closed);
    await expect(gone.send("w1:p1", "hello", bindOpencode)).rejects.toThrow("Not sent: the pane is gone");
    expect([...writes(moved.log), ...writes(gone.log)]).toEqual([]);
  });

  it("refuses a shell command once an agent started in the pane", async () => {
    const m = machine(shell(), opencode("s-1"));
    await expect(m.send("w1:p1", "ls", bindShell)).rejects.toThrow("Not run: an agent started in this pane. The text is kept.");
    expect(writes(m.log)).toEqual([]);
  });

  it("refuses when no fresh snapshot comes, writing nothing", async () => {
    const m = machine(opencode("s-1"), opencode("s-1"), { freshFails: true });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Not sent: the app could not check that opencode is still in its pane. The text is kept.",
    );
    expect(writes(m.log)).toEqual([]);
  });

  it("sends once to an unchanged pane: a checked paste, a second check, then the gated Return", async () => {
    const m = machine(opencode("s-1"));
    await m.send("w1:p1", "hello\nworld", bindOpencode);
    expect(m.log).toEqual([
      ["fresh"],
      ["text", "w1:p1", `${pasteStart}hello\nworld${pasteEnd}`],
      ["fresh"],
      ["agentKeys", "w1:p1", ["Enter"]],
    ]);
  });

  it("sends a Claude or Codex message once as agent.prompt after the check", async () => {
    const m = machine(claude("s-1"));
    await m.send("w1:p1", "hello", bindClaude);
    expect(m.log).toEqual([["fresh"], ["prompt", "w1:p1", "hello"]]);
  });

  it("sends a shell line once after the check", async () => {
    const m = machine(shell());
    await m.send("w1:p1", "ls -la", bindShell);
    expect(m.log).toEqual([["fresh"], ["input", "w1:p1", "ls -la", ["Enter"]]]);
  });

  // A session the user saw at Send must still be named; its absence is not a
  // confirmation (a new agent of the same kind may not have published its
  // session yet). A binding that never had one is not checked for a session.
  it("refuses a Claude or Codex message when the session named at Send is missing", async () => {
    const m = machine(claude("s-1"), claude());
    await expect(m.send("w1:p1", "hello", bindClaude)).rejects.toThrow(
      "Not sent: the app could not check that claude is still in its pane. The text is kept.",
    );
    expect(writes(m.log)).toEqual([]);
  });

  it("refuses a paste before writing when the session named at Send is missing", async () => {
    const m = machine(opencode("s-1"), opencode());
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Not sent: the app could not check that opencode is still in its pane. The text is kept.",
    );
    expect(writes(m.log)).toEqual([]);
  });

  it("withholds the Return when the session goes missing between the paste and its Return", async () => {
    const m = machine(opencode("s-1"));
    m.onPaste(() => {
      m.state.remote = opencode();
    });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Typed into opencode, but the app could not check it before its Return, so no Return was pressed. Check the terminal before sending again.",
    );
    expect(writes(m.log)).toEqual([["text", "w1:p1", `${pasteStart}hello${pasteEnd}`]]);
  });

  it("checks no session for a binding that never had one", async () => {
    const unnamed = { ...bindOpencode, session: null };
    const before = machine(opencode(), opencode("s-9"));
    await before.send("w1:p1", "hello", unnamed);
    expect(writes(before.log).map((entry) => entry[0])).toEqual(["text", "agentKeys"]);
    const after = machine(opencode());
    await after.send("w1:p1", "hello", unnamed);
    expect(writes(after.log).map((entry) => entry[0])).toEqual(["text", "agentKeys"]);
  });

  // Nothing is ever cleared for the user. The app cannot tell that the line is
  // still the paste's (the user may have typed their own command since),
  // so no ⌃C: the Return is withheld and the note says to check the terminal.
  it("never presses Return or ⌃C in the shell an agent left between the paste and its Return", async () => {
    const m = machine(opencode("s-1"));
    m.onPaste(() => {
      m.state.remote = shell();
    });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Typed into opencode, but the agent left, so no Return was pressed. Check the terminal before sending again.",
    );
    expect(writes(m.log)).toEqual([["text", "w1:p1", `${pasteStart}hello${pasteEnd}`]]);
  });

  it("presses no Return when another agent took the pane between the paste and its Return", async () => {
    const m = machine(opencode("s-1"));
    m.onPaste(() => {
      m.state.remote = opencode("s-2");
    });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(/^Typed into opencode, but another agent is in this pane now/);
    expect(writes(m.log)).toEqual([["text", "w1:p1", `${pasteStart}hello${pasteEnd}`]]);
  });

  it("reports a Return Herdr refused, clearing the line when the agent turns out gone", async () => {
    const m = machine(opencode("s-1"), opencode("s-1"), { returnRefused: true });
    let calls = 0;
    m.onPaste(() => {
      calls += 1;
    });
    // The agent is still there by the next snapshot: not confirmed either way.
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Typed into opencode, but Herdr did not take its Return. Check the terminal before sending again.",
    );
    expect(calls).toBe(1);
  });

  it("clears nothing when Herdr refused the Return and the agent turns out gone", async () => {
    const m = machine(opencode("s-1"), opencode("s-1"), { returnRefused: true });
    // The agent left as its Return went; the user may be typing in that shell by now.
    m.onReturn(() => {
      m.state.remote = shell();
    });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Typed into opencode, but the agent left, so no Return was pressed. Check the terminal before sending again.",
    );
    expect(writes(m.log)).toEqual([
      ["text", "w1:p1", `${pasteStart}hello${pasteEnd}`],
      ["agentKeys", "w1:p1", ["Enter"]],
    ]);
  });

  it("refuses a request without a binding", async () => {
    const m = machine(shell());
    await expect(m.send("w1:p1", "ls", null)).rejects.toThrow("bad request");
    await expect(m.send("w1:p1", "ls", { terminalID: 3, isAgent: false, kind: null, session: null })).rejects.toThrow("bad request");
    expect(m.log).toEqual([]);
  });
});

// With the relay up and the sidebar's events live, a send's checks read the latest
// snapshot (hosts.current: no request; the events keep it current), the one before a paste's Return too. The
// tests above are the relay-off path: a fresh snapshot before the write and again before the Return.
describe("a Send with the relay's events live", () => {
  it("sends once to an unchanged pane: a checked paste, the check on the latest snapshot, then the gated Return", async () => {
    const m = machine(opencode("s-1"), opencode("s-1"), { live: true });
    await m.send("w1:p1", "hello\nworld", bindOpencode);
    expect(m.log).toEqual([
      ["current"],
      ["text", "w1:p1", `${pasteStart}hello\nworld${pasteEnd}`],
      ["current"],
      ["agentKeys", "w1:p1", ["Enter"]],
    ]);
  });

  it("withholds the Return when the session goes missing between the paste and its Return", async () => {
    const m = machine(opencode("s-1"), opencode("s-1"), { live: true });
    m.onPaste(() => {
      // The latest snapshot (the events') shows it.
      m.state.cached = opencode();
    });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Typed into opencode, but the app could not check it before its Return, so no Return was pressed. Check the terminal before sending again.",
    );
    expect(writes(m.log)).toEqual([["current"], ["text", "w1:p1", `${pasteStart}hello${pasteEnd}`], ["current"]]);
  });

  it("never presses Return or ⌃C in the shell an agent left between the paste and its Return", async () => {
    const m = machine(opencode("s-1"), opencode("s-1"), { live: true });
    m.onPaste(() => {
      m.state.cached = shell();
    });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(
      "Typed into opencode, but the agent left, so no Return was pressed. Check the terminal before sending again.",
    );
    expect(writes(m.log).filter((entry) => entry[0] !== "current")).toEqual([["text", "w1:p1", `${pasteStart}hello${pasteEnd}`]]);
  });

  it("presses no Return when another agent took the pane between the paste and its Return", async () => {
    const m = machine(opencode("s-1"), opencode("s-1"), { live: true });
    m.onPaste(() => {
      m.state.cached = opencode("s-2");
    });
    await expect(m.send("w1:p1", "hello", bindOpencode)).rejects.toThrow(/^Typed into opencode, but another agent is in this pane now/);
    expect(writes(m.log).filter((entry) => entry[0] !== "current")).toEqual([["text", "w1:p1", `${pasteStart}hello${pasteEnd}`]]);
  });
});

describe("a fresh snapshot", () => {
  function topology(): SessionTopology {
    return { version: "0.9.5", protocolVersion: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] } as unknown as SessionTopology;
  }

  it("is one requested after the check began: a snapshot already in flight does not count", async () => {
    const answers: (() => void)[] = [];
    const backend = {
      snapshot: () => new Promise<SessionTopology>((resolve) => answers.push(() => resolve(topology()))),
      close: () => undefined,
    } as unknown as HerdrHostBackend;
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "host", name: "host", kind: "ssh", address: "fixture", platform: null }, backend);
    expect(answers).toHaveLength(1); // the add's own refresh, in flight
    let checked: boolean | null = null;
    void registry.fresh("host").then((value) => {
      checked = value;
    });
    await Promise.resolve();
    answers[0]!();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(checked).toBeNull();
    expect(answers).toHaveLength(2); // a new one, asked after the check began
    answers[1]!();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(checked).toBe(true);
  });

  it("is false when the machine does not answer or is gone", async () => {
    const backend = { snapshot: () => Promise.reject(new Error("offline")), close: () => undefined } as unknown as HerdrHostBackend;
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "host", name: "host", kind: "ssh", address: "fixture", platform: null }, backend);
    expect(await registry.fresh("host")).toBe(false);
    expect(await registry.fresh("nobody")).toBe(false);
  });
});

// Terminal ownership: the user types their own command in the visible terminal
// while a check is pending; nothing the app does afterwards may clear it.
describe("the user's own command line", () => {
  const binding = { terminalID: "t1", isAgent: true, kind: "grok", session: "s1" };
  const grok = (): PaneState => ({ pane: pane("t1", "grok"), agent: agent("grok", "s1") });

  /**
   * A machine whose command line the user can type into; any key sent to the pane clears it.
   * `onPaste` runs right after the paste (the live path: the latest snapshot the events keep changes there).
   */
  function site(
    onCheck: (check: number, state: { now: PaneState; typed: (line: string) => void }) => void,
    refuseReturn = false,
    onPaste: (state: { now: PaneState; typed: (line: string) => void }) => void = () => undefined,
  ) {
    let now = grok();
    let line = "";
    let checks = 0;
    const writes: unknown[][] = [];
    const site: SendSite = {
      fresh: async () => {
        checks += 1;
        const state = {
          get now() {
            return now;
          },
          set now(value: PaneState) {
            now = value;
          },
          typed: (typedLine: string) => {
            line = typedLine;
          },
        };
        onCheck(checks, state);
        return true;
      },
      pane: () => now.pane,
      agent: () => now.agent,
      writer: {
        sendText: async (...args: unknown[]) => {
          writes.push(["text", ...args]);
          onPaste({
            get now() {
              return now;
            },
            set now(value: PaneState) {
              now = value;
            },
            typed: (typedLine: string) => {
              line = typedLine;
            },
          });
        },
        sendInput: async (...args: unknown[]) => void writes.push(["input", ...args]),
        prompt: async (...args: unknown[]) => void writes.push(["prompt", ...args]),
        agentKeys: async (...args: unknown[]) => {
          writes.push(["agentKeys", ...args]);
          if (refuseReturn) {
            line = "echo my unfinished command";
            throw new APIError("agent_not_found", "gone");
          }
        },
        paneKeys: async (...args: unknown[]) => {
          writes.push(["paneKeys", ...args]);
          line = "";
        },
      } as SendSite["writer"],
    };
    return { site, writes, line: () => line };
  }

  it("keeps the line the user typed after the paste when the second check reports a shell", async () => {
    const m = site((check, state) => {
      if (check === 2) {
        state.now = shell();
        state.typed("git status --short");
      }
    });
    await expect(sendBound(m.site, "w1:p1", "hello", binding)).rejects.toThrow(/^Typed into grok, but the agent left, so no Return was pressed/);
    expect(m.line()).toBe("git status --short");
    expect(m.writes.map((entry) => entry[0])).toEqual(["text"]);
  });

  it("keeps it on the refused-Return path too", async () => {
    const m = site((check, state) => {
      if (check === 3) state.now = shell();
    }, true);
    await expect(sendBound(m.site, "w1:p1", "hello", binding)).rejects.toThrow(/^Typed into grok, but the agent left, so no Return was pressed/);
    expect(m.line()).toBe("echo my unfinished command");
    expect(m.writes.map((entry) => entry[0])).toEqual(["text", "agentKeys"]);
  });

  // With the relay's events live, the check before the Return reads the latest snapshot the events keep
  // current (no request: `fresh` changes nothing); a shell it shows keeps the user's line.
  it("live events: keeps the line the user typed after the paste when the latest snapshot reports a shell", async () => {
    const m = site(
      () => undefined,
      false,
      (state) => {
        state.now = shell();
        state.typed("git status --short");
      },
    );
    await expect(sendBound(m.site, "w1:p1", "hello", binding)).rejects.toThrow(/^Typed into grok, but the agent left, so no Return was pressed/);
    expect(m.line()).toBe("git status --short");
    expect(m.writes.map((entry) => entry[0])).toEqual(["text"]);
  });
});

describe("a session named at Send", () => {
  it("fails closed when the fresh state no longer names it", async () => {
    const writes: unknown[] = [];
    const site: SendSite = {
      fresh: async () => true,
      pane: () => pane("t1", "grok"),
      agent: () => agent("grok"),
      writer: {
        sendText: async (...args: unknown[]) => void writes.push(["text", ...args]),
        sendInput: async (...args: unknown[]) => void writes.push(["input", ...args]),
        prompt: async (...args: unknown[]) => void writes.push(["prompt", ...args]),
        agentKeys: async (...args: unknown[]) => void writes.push(["agentKeys", ...args]),
      },
    };
    await expect(sendBound(site, "w1:p1", "hello", { terminalID: "t1", isAgent: true, kind: "grok", session: "s1" })).rejects.toThrow();
    expect(writes).toEqual([]);
  });
});
