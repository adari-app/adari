// A folder typed or picked
// with `~` goes to Herdr as that machine's home joined with the rest (Herdr
// does not expand `~`; a cwd it cannot use gives the home, without an error),
// an absolute path as it is, anything else refused with nothing sent; and when
// Herdr's answer puts the new shell somewhere else, the result says so. Fake
// machines with macOS and Linux homes, fake Herdrs that record each call; no
// socket, no SSH, no real home folder.

import { describe, expect, it, vi } from "vitest";

import { paneTopology } from "./support/pane-topology";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { FolderRefused, folderTexts, placedElsewhere, resolveFolderCwd, sameFolder } = await import("../src/main/herdr/folder-cwd");
const { newAgent } = await import("../src/main/herdr/new-agent");
const { newWorkspace } = await import("../src/main/herdr/new-workspace");
const { openDrawerShell } = await import("../src/main/herdr/drawer-shell");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");
const { absentStartCommands } = await import("../src/shared/start-commands");

import type { NewAgentHerdr } from "../src/main/herdr/new-agent";
import type { AgentInfo, TabCreation, TopologyPaneInfo, WorkspaceCreation } from "../src/main/herdr/wire";

const mac = { name: "Mac mini", home: async () => "/Users/fixture" };
const linux = { name: "build-box", home: async () => "/root" };
const linuxUser = { name: "lab", home: async () => "/home/sam/" };

describe("the ~ helper", () => {
  it("~ is the machine's home, ~/a and ~/a/ that home's a, on a Mac and on Linux", async () => {
    expect(await resolveFolderCwd("~", mac)).toBe("/Users/fixture");
    expect(await resolveFolderCwd("~/", mac)).toBe("/Users/fixture");
    expect(await resolveFolderCwd("~/a", mac)).toBe("/Users/fixture/a");
    expect(await resolveFolderCwd("~/a/", mac)).toBe("/Users/fixture/a");
    expect(await resolveFolderCwd("~/code/hello-app/", mac)).toBe("/Users/fixture/code/hello-app");
    expect(await resolveFolderCwd("~", linux)).toBe("/root");
    expect(await resolveFolderCwd("~/a", linux)).toBe("/root/a");
    expect(await resolveFolderCwd("~/a/", linuxUser)).toBe("/home/sam/a");
    expect(await resolveFolderCwd("~", linuxUser)).toBe("/home/sam");
    expect(await resolveFolderCwd("  ~/a  ", mac)).toBe("/Users/fixture/a");
  });

  it("an absolute path is sent as it is (the home is never read)", async () => {
    const home = vi.fn(async () => "/Users/fixture");
    for (const folder of ["/", "/srv", "/srv/", "/Volumes/Data/My Projects/app", "/a/../b"]) {
      expect(await resolveFolderCwd(folder, { name: "Mac mini", home })).toBe(folder);
    }
    expect(home).not.toHaveBeenCalled();
  });

  it("no folder is none", async () => {
    expect(await resolveFolderCwd(null, mac)).toBeNull();
    expect(await resolveFolderCwd("", mac)).toBeNull();
    expect(await resolveFolderCwd("   ", mac)).toBeNull();
  });

  it("a relative path and another account's ~name are refused in plain words", async () => {
    await expect(resolveFolderCwd("code/app", mac)).rejects.toThrow(folderTexts.relative("code/app"));
    await expect(resolveFolderCwd("./app", mac)).rejects.toThrow("“./app” is not a whole path. Type one starting with / or ~/.");
    await expect(resolveFolderCwd("~sam/code", linux)).rejects.toThrow("“~sam/code” is another account's home folder. Type the whole path, starting with /.");
    await expect(resolveFolderCwd("~root", linux)).rejects.toBeInstanceOf(FolderRefused);
  });

  it("a home that cannot be read: refused, saying whose and why", async () => {
    const broken = { name: "Mac mini", home: async () => Promise.reject(new Error("the SFTP session closed")) };
    await expect(resolveFolderCwd("~/a", broken)).rejects.toThrow("Could not read Mac mini's home folder: the SFTP session closed");
    await expect(resolveFolderCwd("~", { name: "lab" })).rejects.toThrow("Could not read lab's home folder: this machine cannot say from here");
    await expect(resolveFolderCwd("~/a", { name: "lab", home: async () => "relative" })).rejects.toThrow("Could not read lab's home folder: it did not give a whole path");
  });

  it("the same folder, trailing slashes ignored; another folder is named", () => {
    expect(sameFolder("/Users/x/code/app/", "/Users/x/code/app")).toBe(true);
    expect(sameFolder("/Users/x", "/Users/x/code")).toBe(false);
    expect(placedElsewhere("/Users/x/code/hello-app", "/Users/x/code/hello-app/")).toBeNull();
    expect(placedElsewhere("/Users/x/code/hello-app", "/Users/x")).toBe("/Users/x");
    expect(placedElsewhere("/Users/x/code/hello-app", undefined)).toBeNull();
    expect(placedElsewhere(null, "/Users/x")).toBeNull();
  });
});

// MARK: - New workspace

/** The machines New workspace reads, one Herdr each: records the cwd sent, answers with `shellAt` (else that cwd). */
function workspaceHosts(options: { home?: () => Promise<string>; shellAt?: string; refuse?: { code: string; message: string } } = {}) {
  const sent: (string | null)[] = [];
  const actions = {
    createWorkspace: async (label: string, cwd: string | null): Promise<WorkspaceCreation> => {
      sent.push(cwd);
      if (options.refuse !== undefined) {
        const { APIError } = await import("../src/main/herdr/wire");
        throw new APIError(options.refuse.code, options.refuse.message);
      }
      const at = options.shellAt ?? cwd ?? undefined;
      return {
        workspace: { workspaceID: "wN", label },
        tab: { tabID: "wN:t1" },
        rootPane: { paneID: "wN:p1", ...(at === undefined ? {} : { cwd: at }) },
      } as unknown as WorkspaceCreation;
    },
  };
  const backend = { workspaceActions: () => actions as unknown as NewAgentHerdr, ...(options.home === undefined ? {} : { homeFolder: options.home }) };
  const view = { id: "mini", name: "Mac mini", state: "connected", topology: paneTopology([{ id: "w1:p1" }]), connection: 3, incarnation: 1, epoch: 7 };
  const hosts = {
    backend: () => backend,
    list: () => [view as never],
    fresh: async () => true,
    connection: () => 3,
    connectionIdentity: () => ({ incarnation: 1, epoch: 7 }) as never,
  };
  return { hosts, sent };
}

const binding = { connection: 3, incarnation: 1, epoch: 7 };

describe("New workspace sends the folder whole", () => {
  it("~/code/hello-app/ goes as the Mac's home joined with it; the result keeps the folder as typed", async () => {
    const m = workspaceHosts({ home: async () => "/Users/fixture" });
    const made = await newWorkspace(m.hosts, "mini", { folder: "~/code/hello-app/", name: "hello-app", binding });
    expect(m.sent).toEqual(["/Users/fixture/code/hello-app"]);
    expect(made).toMatchObject({ folder: "~/code/hello-app/", label: "hello-app", elsewhere: null });
  });

  it("an absolute folder goes as it is", async () => {
    const m = workspaceHosts({ home: async () => "/Users/fixture" });
    await newWorkspace(m.hosts, "mini", { folder: "/srv/app/", name: "app", binding });
    expect(m.sent).toEqual(["/srv/app/"]);
  });

  it("a relative folder, ~name, or a home that cannot be read: refused, nothing sent", async () => {
    const m = workspaceHosts({ home: async () => Promise.reject(new Error("permission denied")) });
    await expect(newWorkspace(m.hosts, "mini", { folder: "code/app", name: "app", binding })).rejects.toThrow("“code/app” is not a whole path.");
    await expect(newWorkspace(m.hosts, "mini", { folder: "~sam", name: "sam", binding })).rejects.toThrow("another account's home folder");
    await expect(newWorkspace(m.hosts, "mini", { folder: "~/code/app", name: "app", binding })).rejects.toThrow("Could not read Mac mini's home folder: permission denied");
    expect(m.sent).toEqual([]);
  });

  it("Herdr put the shell in the home: the result says where, and nothing is retried or closed", async () => {
    const m = workspaceHosts({ home: async () => "/Users/x", shellAt: "/Users/x" });
    const made = await newWorkspace(m.hosts, "mini", { folder: "~/code/hello-app", name: "hello-app", binding });
    expect(made.elsewhere).toBe("hello-app was made, but its shell is in /Users/x, not /Users/x/code/hello-app (Herdr could not use that folder)");
    expect(m.sent).toHaveLength(1);
  });

  it("the same folder with a trailing slash is the folder sent: no line", async () => {
    const m = workspaceHosts({ home: async () => "/Users/x", shellAt: "/Users/x/code/hello-app/" });
    const made = await newWorkspace(m.hosts, "mini", { folder: "~/code/hello-app", name: "hello-app", binding });
    expect(made.elsewhere).toBeNull();
  });

  it("Herdr's refusal reads in its words, without its code", async () => {
    const m = workspaceHosts({ home: async () => "/Users/x", refuse: { code: "invalid_params", message: "label must not be empty" } });
    const failure = (await newWorkspace(m.hosts, "mini", { folder: "/srv", name: "srv", binding }).catch((error: unknown) => error)) as Error;
    expect(failure.message).toBe("Herdr did not make srv: label must not be empty");
    expect(failure.message).not.toMatch(/[a-z]+_[a-z_]+:/);
  });
});

// MARK: - New agent: tab, split, shell

class CwdHerdr implements NewAgentHerdr {
  readonly calls: string[] = [];
  constructor(private readonly shellAt: string | null = null) {}
  agentList(): Promise<AgentInfo[]> {
    return Promise.resolve([]);
  }
  createTerminalTab(workspaceID: string, label: string | null, cwd: string | null): Promise<TabCreation> {
    this.calls.push(`tab.create cwd=${cwd}`);
    const at = this.shellAt ?? cwd;
    return Promise.resolve({ tab: { tabID: "w1:tn1", workspaceID, label }, rootPane: { paneID: "w1:pn1", tabID: "w1:tn1", ...(at === null ? {} : { cwd: at }) } } as unknown as TabCreation);
  }
  splitPane(split: { cwd: string | null }): Promise<TopologyPaneInfo> {
    this.calls.push(`pane.split cwd=${split.cwd}`);
    const at = this.shellAt ?? split.cwd;
    return Promise.resolve({ paneID: "w1:ps1", tabID: "w1:t1", ...(at === null ? {} : { cwd: at }) } as unknown as TopologyPaneInfo);
  }
  startAgent(name: string, kind: string, paneID: string): Promise<AgentInfo> {
    this.calls.push(`agent.start ${kind}`);
    return Promise.resolve({ paneID, name, agent: kind });
  }
  closePane(paneID: string): Promise<void> {
    this.calls.push(`pane.close ${paneID}`);
    return Promise.resolve();
  }
  sendInput(): Promise<void> {
    return Promise.resolve();
  }
}

const clock = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
};
const split = { type: "split", direction: "right", targetPaneId: "w1:p1" } as const;

describe("New agent sends the folder whole", () => {
  it("a tab, a split and a shell each get the machine's home joined with the ~ folder", async () => {
    for (const [where, kind, expected] of [
      [undefined, "codex", "tab.create cwd=/Users/fixture/code/app"],
      [split, "codex", "pane.split cwd=/Users/fixture/code/app"],
      [undefined, "shell", "tab.create cwd=/Users/fixture/code/app"],
      [split, "shell", "pane.split cwd=/Users/fixture/code/app"],
    ] as const) {
      const herdr = new CwdHerdr();
      const result = await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: "~/code/app/", kind, ...(where === undefined ? {} : { where }) }, clock(), 90_000, 1_000, mac);
      expect(herdr.calls[0]).toBe(expected);
      expect(result.summary).toBeNull();
    }
  });

  it("on Linux, ~ alone is /root", async () => {
    const herdr = new CwdHerdr();
    await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: "~", kind: "shell" }, clock(), 90_000, 1_000, linux);
    expect(herdr.calls).toEqual(["tab.create cwd=/root"]);
  });

  it("a relative folder: refused before anything is made", async () => {
    const herdr = new CwdHerdr();
    await expect(newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: "code/app", kind: "codex" }, clock(), 90_000, 1_000, mac)).rejects.toThrow("“code/app” is not a whole path.");
    expect(herdr.calls).toEqual([]);
  });

  it("Herdr put the new tab in the home: the agent still starts, and the line says where", async () => {
    const herdr = new CwdHerdr("/Users/fixture");
    const result = await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: "~/code/hello-app", kind: "codex" }, clock(), 90_000, 1_000, mac);
    expect(herdr.calls).toEqual(["tab.create cwd=/Users/fixture/code/hello-app", "agent.start codex"]);
    expect(result.summary).toBe("Codex started, but its tab is in /Users/fixture, not /Users/fixture/code/hello-app (Herdr could not use that folder).");
  });

  it("a split and a shell say it the same way", async () => {
    const herdr = new CwdHerdr("/Users/fixture");
    const shell = await newAgent(herdr, absentStartCommands, { workspaceId: "w1", folder: "/Users/fixture/gone", kind: "shell", where: split }, clock(), 90_000, 1_000, mac);
    expect(shell.summary).toBe("The shell was made, but its pane is in /Users/fixture, not /Users/fixture/gone (Herdr could not use that folder).");
  });
});

// MARK: - The drawer's shell and New agent's IPC door

describe("every other sender of a folder", () => {
  it("the terminal drawer's shell resolves a ~ folder the same way", async () => {
    const herdr = new CwdHerdr();
    const hosts = {
      backend: () => ({ workspaceActions: () => herdr, homeFolder: async () => "/Users/fixture" }),
      list: () => [{ id: "mini", name: "Mac mini", state: "connected", topology: paneTopology([{ id: "w1:p1" }]) }],
      refresh: async () => undefined,
      connection: () => 1,
      connectionIdentity: () => ({ incarnation: 1, epoch: 1 }),
    };
    const opened = await openDrawerShell(hosts, "mini", { workspaceId: "w1", folder: "~/code/app" });
    expect(herdr.calls).toEqual(["tab.create cwd=/Users/fixture/code/app"]);
    expect(opened.folder).toBe("/Users/fixture/code/app");
  });

  it("New agent's IPC door passes the machine's name and home to the start", async () => {
    const herdr = new CwdHerdr();
    const backend = { workspaceActions: () => herdr, readStartCommandsFile: async () => null, homeFolder: async () => "/Users/fixture" };
    const view = { id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology: paneTopology([{ id: "w1:p1" }]) };
    registered.handles.clear();
    registerIpc({ hosts: { backend: () => backend, list: () => [view], refresh: async () => undefined, connection: () => 1, connectionIdentity: () => ({ incarnation: 1, epoch: 1 }) } } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    await registered.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", folder: "~/code/app", kind: "codex" });
    expect(herdr.calls).toEqual(["tab.create cwd=/Users/fixture/code/app", "agent.start codex"]);
    const refused = (registered.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", folder: "~sam/app", kind: "codex" }) as Promise<unknown>).catch((error: unknown) => error);
    expect(((await refused) as Error).message).toContain("another account's home folder");
    expect(herdr.calls).toHaveLength(2);
  });
});
