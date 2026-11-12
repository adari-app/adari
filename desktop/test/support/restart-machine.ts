// A fake machine for Restart's tests (its writes,
// its snapshots, its clock).

import type { RestartSite } from "../../src/main/herdr/restart";
import type { AgentInfo, AgentSessionInfo, TopologyPaneInfo } from "../../src/main/herdr/wire";
import type { RestartBinding } from "../../src/shared/agent-restart";
import { startCommandsWith } from "../../src/shared/start-commands";

export const claudeID = "0b6f3c1e-8a2d-4f7b-9c11-2e5d7a9b3f40";
export const grokID = "grok_9f2c41ab77";

export interface PaneState {
  pane: TopologyPaneInfo | null;
  agent: AgentInfo | null;
}

export function agentState(options: { kind?: string; status?: string; session?: AgentSessionInfo | null; terminal?: string; pending?: boolean } = {}): PaneState {
  const kind = options.kind ?? "claude";
  const status = options.status ?? "idle";
  const terminal = options.terminal ?? "t-7";
  const session = options.session === undefined ? { source: `herdr:${kind}`, agent: kind, kind: "id", value: claudeID } : options.session;
  return {
    pane: { paneID: "w1:p1", terminalID: terminal, workspaceID: "w1", tabID: "w1:t1", focused: false, agent: kind, agentStatus: status, revision: 1 },
    agent: {
      paneID: "w1:p1",
      agent: kind,
      agentStatus: status,
      terminalID: terminal,
      ...(options.pending === true ? { inputPending: true } : {}),
      ...(session === null ? {} : { agentSession: session }),
    },
  };
}

export function shellState(terminal = "t-7"): PaneState {
  return {
    pane: { paneID: "w1:p1", terminalID: terminal, workspaceID: "w1", tabID: "w1:t1", focused: false, agentStatus: "unknown", revision: 2 },
    agent: null,
  };
}

export function bindingFor(state: PaneState, name = "Claude"): RestartBinding {
  return {
    terminalID: state.pane?.terminalID ?? "",
    kind: state.agent?.agent ?? "claude",
    session: state.agent?.agentSession?.value ?? null,
    incarnation: 1,
    connection: 3,
    epoch: 7,
    name,
  };
}

export interface MachineOptions {
  /** Snapshots after the /exit's Return before the shell shows (null: the agent never leaves). */
  leavesAfter?: number | null;
  /** What the pane shows once the agent left (the shell in the same terminal by default). */
  after?: PaneState;
  commands?: ReturnType<typeof startCommandsWith>;
}

/** A fake machine: its writes, its snapshots, its clock. */
export function fakeMachine(start: PaneState, options: MachineOptions = {}) {
  const writes: unknown[][] = [];
  let clock = 1_000_000;
  let state = start;
  let exitAsked = false;
  let polls = 0;
  const leavesAfter = options.leavesAfter === undefined ? 2 : options.leavesAfter;
  const commands = options.commands ?? startCommandsWith({ type: "read" }, { claude: "cl" });
  const identity = { incarnation: 1, connection: 3 as number | null, epoch: 7 as number | null };
  const site: RestartSite = {
    writer: {
      sendText: async (pane, text) => {
        writes.push(["sendText", pane, text]);
        if (text === "/exit") exitAsked = true;
      },
      agentKeys: async (pane, keys) => {
        writes.push(["agentKeys", pane, [...keys]]);
      },
      sendInput: async (pane, text, keys) => {
        writes.push(["sendInput", pane, text, [...keys]]);
      },
    },
    machine: "Mac mini",
    fresh: async () => {
      if (exitAsked && leavesAfter !== null) {
        polls += 1;
        if (polls >= leavesAfter) state = options.after ?? shellState(start.pane?.terminalID);
      }
      return true;
    },
    pane: () => state.pane,
    agent: () => state.agent,
    identity: () => (identity.connection === null ? null : { incarnation: identity.incarnation, connection: identity.connection, epoch: identity.epoch }),
    snapshotEpoch: () => identity.epoch,
    startCommands: async () => commands,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return {
    site,
    writes,
    identity,
    elapsed: () => clock - 1_000_000,
    show: (next: PaneState) => {
      state = next;
    },
  };
}

