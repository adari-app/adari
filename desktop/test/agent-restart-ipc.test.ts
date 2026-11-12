// The restart IPC handler runs for real on a fake
// machine (its backend's writes, its snapshots): the keys in order on the
// pane's backend, the resume command from the machine's own start commands
// (~/.adari/agents.json: {"claude": "cl"}), a bad request refused.

import { describe, expect, it, vi } from "vitest";

import { IPC } from "../src/shared/ipc-contract";
import { agentState, bindingFor, claudeID, shellState, type PaneState } from "./support/restart-machine";

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

function machine(start: PaneState) {
  const writes: unknown[][] = [];
  let state = start;
  let exited = false;
  const backend = {
    sendText: async (pane: string, text: string) => void writes.push(["sendText", pane, text]),
    agentKeys: async (pane: string, keys: readonly string[]) => {
      writes.push(["agentKeys", pane, [...keys]]);
      exited = true;
    },
    sendInput: async (pane: string, text: string, keys: readonly string[]) => void writes.push(["sendInput", pane, text, [...keys]]),
    readStartCommandsFile: async () => new TextEncoder().encode(JSON.stringify({ claude: "cl" })),
  };
  const hosts = {
    backend: () => backend,
    name: () => "Mac mini",
    pane: () => state.pane,
    agent: () => state.agent,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }),
    snapshotEpoch: () => 7,
    run: () => ({ connection: 3, arrival: 1 }), // the run checked before each key
    refresh: async () => undefined,
    fresh: async () => {
      if (exited) state = shellState();
      return true;
    },
  };
  registerIpc({ hosts } as never);
  return { writes, restart: (binding: unknown) => registered.handles.get(IPC.paneRestart)!(event, "mac-mini", "w1:p1", binding) as Promise<string | null> };
}

describe("the restart IPC", () => {
  it("exits and resumes the same session with the machine's own start command", async () => {
    const m = machine(agentState());
    expect(await m.restart(bindingFor(agentState()))).toBeNull();
    expect(m.writes).toEqual([
      ["sendText", "w1:p1", "/exit"],
      ["agentKeys", "w1:p1", ["Enter"]],
      ["sendInput", "w1:p1", `cl --resume ${claudeID}`, ["Enter"]],
    ]);
  });

  it("refuses a malformed request and types nothing", async () => {
    const m = machine(agentState());
    await expect(m.restart({ kind: "claude" })).rejects.toThrow("bad request");
    expect(m.writes).toEqual([]);
  });
});
