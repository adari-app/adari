// The New agent request at the main process's door: a folder with a line break, NUL or any other control or
// invisible character is refused, and so is a workspace that is not one of the
// named machine's workspaces as it answers now, before agents.json is read or
// anything is created. Real registerIpc with Electron's ipcMain faked; a fake
// Herdr records every call.

import { describe, expect, it, vi } from "vitest";

import { paneTopology } from "./support/pane-topology";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { isNewAgentRequest, registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const request = { workspaceId: "w1", folder: null, kind: "claude" };

describe("the folder New agent starts in", () => {
  it.each(["~/code\nnext", "/fixture\u0000x", "/fixture\rx", "/fixture\tx", "/fixture\u001b[2J", "/fixture\u0085x", "/fixture x", "/fixture‮x", "/fixture​x", "/fixture\u007fx"])(
    "%j is refused",
    (folder) => {
      expect(isNewAgentRequest({ ...request, folder })).toBe(false);
    },
  );

  it("absolute folders anywhere, ~ paths, spaces, accents and .. are taken as they are", () => {
    for (const folder of ["/Volumes/Data/project", "~/code", "~", "~/My Projects/app", "/Users/fixture/código", "/Volumes/Data/a/../b", null]) {
      expect(isNewAgentRequest({ ...request, folder })).toBe(true);
    }
  });
});

describe("the workspace New agent starts in", () => {
  function main(state: "connected" | "offline" = "connected") {
    const calls: string[] = [];
    const herdr = {
      agentList: async () => (calls.push("agent.list"), []),
      createTerminalTab: async (workspace: string) => {
        calls.push(`tab.create ${workspace}`);
        return { tab: { tabID: "w1:tn1", workspaceID: workspace }, rootPane: { paneID: "w1:pn1", workspaceID: workspace } };
      },
      startAgent: async (name: string, kind: string, pane: string) => (calls.push(`agent.start ${kind}`), { paneID: pane, name, agent: kind }),
      closePane: async () => undefined,
      sendInput: async () => undefined,
    };
    const backend = {
      workspaceActions: () => herdr,
      readStartCommandsFile: async () => (calls.push("read agents.json"), null),
    };
    const view = { id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state, error: null, fetchedAtMs: 0, topology: paneTopology([{ id: "w1:p1" }]) };
    registered.handles.clear();
    registerIpc({
      hosts: {
        backend: (id: string) => (id === "mini" ? backend : null),
        list: () => [view],
        refresh: async () => undefined,
        connection: () => 1,
        connectionIdentity: () => ({ incarnation: 1, epoch: 1 }),
      },
    } as never);
    const start = (hostId: string, body: unknown) => registered.handles.get(IPC.newAgent)!(event, hostId, body) as Promise<unknown>;
    return { calls, start };
  }

  it("a workspace the machine has: started", async () => {
    const m = main();
    await expect(m.start("mini", request)).resolves.toMatchObject({ kind: "claude", start: { type: "herdr" } });
    expect(m.calls).toEqual(["read agents.json", "agent.list", "tab.create w1", "agent.start claude"]);
  });

  it("a workspace the machine does not have: refused before agents.json is read or anything made", async () => {
    const m = main();
    await expect(m.start("mini", { ...request, workspaceId: "unknown-workspace" })).rejects.toThrow("That workspace is not on Mac mini now.");
    expect(m.calls).toEqual([]);
  });

  it("a machine not answering: refused, nothing made", async () => {
    const m = main("offline");
    await expect(m.start("mini", request)).rejects.toThrow("Mac mini is not answering.");
    expect(m.calls).toEqual([]);
  });

  it("a control character in the folder: a bad request, nothing made", async () => {
    const m = main();
    await expect(m.start("mini", { ...request, folder: "/fixture\nrm" })).rejects.toThrow("bad request");
    expect(m.calls).toEqual([]);
  });
});
