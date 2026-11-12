// Stop is a plain Esc to the pane on screen, as pressing Esc in its terminal. Every
// stop is one Escape: no fresh snapshot first, no status, episode or session
// check, no latch. Kept: the key goes to the terminal the page showed, on the
// machine entry it showed; a key that cannot go (offline, Herdr refuses it)
// leaves one short note. The stop IPC handler runs for real on a fake machine
// (no connection).

import { describe, expect, it, vi } from "vitest";

import { ConnectFailedError } from "../src/main/herdr/errors";
import { APIError, type AgentInfo, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { IPC } from "../src/shared/ipc-contract";
import { stopTexts } from "../src/shared/agent-stop";

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

function claude(options: { status?: string; session?: string | null; seq?: number; kind?: string; terminal?: string; pending?: boolean } = {}): PaneState {
  const status = options.status ?? "working";
  const kind = options.kind ?? "claude";
  const terminal = options.terminal ?? "t-7";
  const session = options.session === undefined ? "s-1" : options.session;
  return {
    pane: { paneID: "w1:p1", terminalID: terminal, workspaceID: "w1", tabID: "w1:t1", focused: false, agent: kind, agentStatus: status, revision: 1 },
    agent: {
      paneID: "w1:p1",
      agent: kind,
      agentStatus: status,
      terminalID: terminal,
      stateChangeSeq: options.seq ?? 12,
      statusSinceUnixMs: 1_762_000_000_000,
      ...(options.pending === true ? { inputPending: true } : {}),
      ...(session === null ? {} : { agentSession: { source: `herdr:${kind}`, agent: kind, kind: "id", value: session } }),
    },
  };
}

const shell: PaneState = {
  pane: { paneID: "w1:p1", terminalID: "t-7", workspaceID: "w1", tabID: "w1:t1", focused: false, agentStatus: "unknown", revision: 1 },
  agent: null,
};
const gone: PaneState = { pane: null, agent: null };

const shown = {
  terminalID: "t-7",
  kind: "claude",
  session: "s-1",
  episode: { status: "working", seq: "12", since: "1762000000000" },
  incarnation: 1,
  connection: 3,
  epoch: 7,
  name: "Claude",
};

interface Options {
  /** The fresh snapshot does not come; `offline`: the machine is marked offline by it. */
  freshFails?: "unanswered" | "offline";
  /** Not answering before the stop began. */
  offlineBefore?: boolean;
  /** The command connection a request sent now goes on, after the fresh snapshot (7: the one it came on). */
  epochAfter?: number | null;
  /** The machine's entry (1: the one the page showed). */
  incarnation?: number;
  /** The machine's connection number after the fresh snapshot (3: unchanged). */
  connectionAfter?: number;
  keyError?: Error;
}

function machine(remote: PaneState, options: Options = {}) {
  const log: unknown[][] = [];
  const state = { cached: claude(), remote, connection: options.offlineBefore === true ? null : (3 as number | null), epoch: 7 as number | null, snapshotEpoch: 7 };
  const backend = {
    agentKeys: async (paneID: string, keys: readonly string[]) => {
      log.push(["agentKeys", paneID, keys]);
      if (options.keyError !== undefined) throw options.keyError;
    },
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => state.cached.pane,
    agent: () => state.cached.agent,
    connection: () => state.connection,
    connectionIdentity: () => ({ incarnation: options.incarnation ?? 1, epoch: state.epoch }),
    snapshotEpoch: () => state.snapshotEpoch,
    refresh: async () => undefined,
    fresh: async () => {
      log.push(["fresh"]);
      if (options.freshFails === "offline") {
        state.connection = null;
        return false;
      }
      if (options.freshFails === "unanswered") return false;
      state.cached = state.remote;
      if (options.connectionAfter !== undefined) state.connection = options.connectionAfter;
      if (options.epochAfter !== undefined) state.epoch = options.epochAfter;
      return true;
    },
  };
  registerIpc({ hosts } as never);
  const stop = registered.handles.get(IPC.paneStop)!;
  return {
    log,
    keys: () => log.filter((entry) => entry[0] === "agentKeys"),
    stop: (binding: unknown = shown) => stop(event, "mac-mini", "w1:p1", binding) as Promise<string | null>,
    /** The machine shows `next` now, in its last snapshot and the next one. */
    show: (next: PaneState) => {
      state.cached = next;
      state.remote = next;
    },
  };
}

describe("Stop is a plain Esc", () => {
  it("sends one Escape at once, with no fresh read first", async () => {
    const m = machine(claude());
    expect(await m.stop()).toBeNull();
    expect(m.log).toEqual([["agentKeys", "w1:p1", ["Escape"]]]);
  });

  it("every stop is one Escape: a second one right after sends a second (the two-Esc case is the user's to make)", async () => {
    const m = machine(claude());
    const first = m.stop();
    const second = m.stop();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(await m.stop()).toBeNull();
    expect(m.keys()).toHaveLength(3);
  });

  it("goes with a newer state_change_seq than the page saw: no 'moved on'", async () => {
    const m = machine(claude());
    m.show(claude({ seq: 99 }));
    expect(await m.stop()).toBeNull();
    expect(m.keys()).toHaveLength(1);
  });

  it("goes whatever the status by the last snapshot: blocked, input pending, idle, another session", async () => {
    for (const state of [claude({ status: "blocked" }), claude({ pending: true }), claude({ status: "idle" }), claude({ session: "s-2" })]) {
      const m = machine(claude());
      m.show(state);
      expect(await m.stop()).toBeNull();
      expect(m.keys()).toHaveLength(1);
    }
  });

  it("says the exact texts", () => {
    expect(stopTexts.offline("Mac mini")).toBe("Esc did not go: Mac mini is offline");
    expect(stopTexts.refused("agent_not_found")).toBe("Esc did not go: Herdr refused it (agent_not_found)");
    expect(stopTexts.paneGone).toBe("Esc did not go: the pane is gone");
    expect(stopTexts.otherProgram).toBe("Esc did not go: another program is in this pane now");
  });

  it("goes only to the terminal the page showed: the pane gone, or another terminal in it, sends nothing", async () => {
    const gonePane = machine(claude());
    gonePane.show(gone);
    expect(await gonePane.stop()).toBe(stopTexts.paneGone);
    const other = machine(claude());
    other.show(claude({ terminal: "t-8" }));
    expect(await other.stop()).toBe(stopTexts.otherProgram);
    expect([...gonePane.keys(), ...other.keys()]).toEqual([]);
  });

  it("an offline machine, or one added again, sends nothing and says so", async () => {
    const offline = machine(claude(), { offlineBefore: true });
    expect(await offline.stop()).toBe("Esc did not go: Mac mini is offline");
    const again = machine(claude(), { incarnation: 2 });
    expect(await again.stop()).toBe("Esc did not go: Mac mini was added again");
    expect([...offline.keys(), ...again.keys()]).toEqual([]);
  });

  it("Herdr refusing the key, or the connection failing before it went, is one short note; a reply that never came is none", async () => {
    expect(await machine(claude(), { keyError: new APIError("agent_not_found", "no agent") }).stop()).toBe("Esc did not go: Herdr refused it (agent_not_found)");
    expect(await machine(claude(), { keyError: new ConnectFailedError("mac-mini.local", "refused") }).stop()).toBe("Esc did not go: Mac mini is offline");
    expect(await machine(claude(), { keyError: new Error("closed before the reply") }).stop()).toBeNull();
  });

  it("a shell pane keeps the terminal rule (Herdr itself refuses Esc to a pane with no agent)", async () => {
    const m = machine(claude());
    m.show(shell);
    expect(await m.stop()).toBeNull();
    expect(m.keys()).toHaveLength(1);
  });

  it("refuses a malformed request", async () => {
    const m = machine(claude());
    await expect(m.stop({ terminalID: 7 })).rejects.toThrow("bad request");
  });

  it("does not enter the send queue: it completes while the same pane's Send is still pending", async () => {
    const { stopAgent } = await import("../src/main/herdr/stop");
    const { sendBound } = await import("../src/main/herdr/send");
    const current = claude();
    const log: string[] = [];
    let finish!: () => void;
    const writer = {
      prompt: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          log.push("send waiting");
        }),
      sendInput: async () => undefined,
      sendText: async () => undefined,
      agentKeys: async () => void log.push("Escape"),
    };
    const s = { writer, fresh: async () => true, pane: () => current.pane, agent: () => current.agent };
    const pending = sendBound(s, "w1:p1", "follow up", { terminalID: "t-7", isAgent: true, kind: "claude", session: "s-1" });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(log).toEqual(["send waiting"]);
    await stopAgent({ writer, pane: () => current.pane, machine: "Mac mini", identity: () => ({ incarnation: 1, connection: 3, epoch: 7 }) }, "w1:p1", shown);
    expect(log).toEqual(["send waiting", "Escape"]);
    finish();
    await pending;
  });
});

describe("the stop through the real machine registry", () => {
  it("sends Escape on every stop, by the registry's last snapshot, with no read between", async () => {
    const { HostRegistry } = await import("../src/main/hosts");
    const { decodeSessionTopology } = await import("../src/main/herdr/wire");
    const topology = decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "working", revision: 1 }],
      layouts: [],
      agents: [
        {
          pane_id: "w1:p1",
          agent: "claude",
          agent_status: "working",
          terminal_id: "t-7",
          state_change_seq: 12,
          status_since_unix_ms: 1_762_000_000_000,
          agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" },
        },
      ],
    });
    const keys: unknown[] = [];
    let reads = 0;
    const backend = {
      kind: "herdr-tui",
      snapshot: async () => {
        reads += 1;
        return topology;
      },
      connectionEpoch: () => 7,
      agentKeys: async (paneID: string, sent: readonly string[]) => void keys.push([paneID, sent, reads]),
      close: () => undefined,
    };
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "mac-mini", name: "Mac mini", kind: "ssh", address: "mac-mini.local", platform: null }, backend as never);
    await registry.refresh("mac-mini");
    const view = registry.list()[0]!;
    registerIpc({ hosts: registry } as never);
    const stop = registered.handles.get(IPC.paneStop)!;
    const { stopBindingOf } = await import("../src/shared/agent-stop");
    const binding = stopBindingOf(view, "w1:p1", "Claude");
    const before = reads;
    const first = stop(event, "mac-mini", "w1:p1", binding);
    const second = stop(event, "mac-mini", "w1:p1", binding);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    // Both keys went with no snapshot read before them.
    expect(keys).toEqual([
      ["w1:p1", ["Escape"], before],
      ["w1:p1", ["Escape"], before],
    ]);
  });
});
