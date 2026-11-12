// The terminal drawer's shells in the main
// process (main/herdr/drawer-shell.ts) and its two IPC doors. A shell is a real
// Herdr shell pane made by New agent's shell path: on a Herdr App machine one
// `tab.create` (focus false, the workspace's folder as cwd) and nothing else,
// so the agent's own tab and layout are never touched; on a herdr-core machine
// the same call goes over CoreHostTransport to the core (`terminal.run` of the
// machine's shell in the space), never to the TUI server. A folder not known is
// the machine's home. The tab is labelled
// "Terminal" (herdr-core: its terminal named "terminal", its names being lower
// case; a name the machine has already leaves it unnamed). Nothing here says a shell is idle:
// its screen is no proof, so × always asks in the page. Fakes only:
// no socket, no SSH.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { HerdrClient } from "../src/main/herdr/client";
import { jsonObject, jsonString, member, type CoreJSON } from "../src/main/herdr/core-json";
import type { CoreHostTransport } from "../src/main/herdr/core-host-transport";
import { CoreIDs } from "../src/main/herdr/core-model";
import * as drawerShell from "../src/main/herdr/drawer-shell";
import { openDrawerShell, type DrawerShellHosts } from "../src/main/herdr/drawer-shell";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { IPC } from "../src/shared/ipc-contract";
import { APP_ORIGIN } from "../src/main/protocol";
import { at } from "./support/core-test-link";
import { coreHost } from "./support/core-hosts";
import { FakeCore } from "./support/fake-core";
import { TUIFixtureTransport } from "./support/tui-fixture";

const { registerIpc, isDrawerShellRequest } = await import("../src/main/ipc");

/** The Herdr App machine's snapshot: workspace w1 (its folder /Users/demo/code/app), the Claude pane w1:p1 alone in tab w1:t1. */
function snapshot(extraPanes: readonly string[] = []): SessionTopology {
  const pane = (paneId: string, agent: boolean) => ({
    pane_id: paneId,
    terminal_id: `t-${paneId}`,
    workspace_id: "w1",
    tab_id: agent ? "w1:t1" : `w1:t-${paneId}`,
    focused: agent,
    cwd: "/Users/demo/code/app",
    ...(agent ? { agent: "claude" } : {}),
    agent_status: agent ? "idle" : "unknown",
    revision: 1,
  });
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1 + extraPanes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [pane("w1:p1", true), ...extraPanes.map((id) => pane(id, false))],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }],
  });
}

/** A fake Herdr App transport: records each request; answers tab.create with a shell tab, pane.read with `screens`. */
function fakeHerdr(screens: Record<string, string> = {}) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let made = 0;
  const transport = {
    roundTrip: async (line: string) => {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      requests.push({ method: request.method, params: request.params });
      if (request.method === "tab.create") {
        made += 1;
        const tabId = `w1:tn${String(made)}`;
        return JSON.stringify({
          id: request.id,
          result: {
            type: "tab_created",
            tab: { tab_id: tabId, workspace_id: "w1", number: 1 + made, label: "", focused: false, pane_count: 1, agent_status: "unknown" },
            root_pane: { pane_id: `w1:pn${String(made)}`, terminal_id: `tn${String(made)}`, workspace_id: "w1", tab_id: tabId, focused: false, cwd: request.params["cwd"], agent_status: "unknown", revision: 1 },
          },
        });
      }
      if (request.method === "pane.read") {
        const text = screens[String(request.params["pane_id"])];
        if (text === undefined) return JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "no such pane" } });
        return JSON.stringify({ id: request.id, result: { type: "pane_read", read: { pane_id: request.params["pane_id"], text } } });
      }
      return JSON.stringify({ id: request.id, error: { code: "unexpected", message: request.method } });
    },
    close: () => undefined,
  };
  return { requests, client: new HerdrClient(transport as never) };
}

interface FakeHost {
  readonly id: string;
  readonly name: string;
  state: string;
  topology: SessionTopology | null;
}

/** The machines as drawer-shell.ts sees them (HostRegistry's backend, list, refresh and its connection). */
function machines(host: FakeHost, backend: ReturnType<DrawerShellHosts["backend"]>) {
  const refreshed: string[] = [];
  const hosts: DrawerShellHosts = {
    backend: (id) => (id === host.id ? backend : null),
    list: () => [host],
    connection: (id) => (id === host.id && host.state === "connected" ? 1 : null),
    connectionIdentity: (id) => (id === host.id ? { incarnation: 1, epoch: 1 } : null),
    refresh: async (id) => {
      refreshed.push(id);
    },
  };
  return { hosts, refreshed };
}

const home = (folder: string | null) => () => ({ home: async () => folder });

describe("a Herdr App machine", () => {
  it("makes the drawer's shell with one tab.create labelled Terminal in the workspace's folder, focus left alone; the agent's tab untouched", async () => {
    const herdr = fakeHerdr();
    const { hosts, refreshed } = machines({ id: "mini", name: "Mac mini", state: "connected", topology: snapshot() }, { workspaceActions: () => herdr.client });
    const made = await openDrawerShell(hosts, "mini", { workspaceId: "w1", folder: "/Users/demo/code/app" });
    expect(made).toEqual({ paneId: "w1:pn1", tabId: "w1:tn1", folder: "/Users/demo/code/app", place: "folder" });
    expect(herdr.requests).toEqual([{ method: "tab.create", params: { workspace_id: "w1", focus: false, cwd: "/Users/demo/code/app", label: "Terminal" } }]);
    // Nothing names the agent's pane or tab: no split, focus, layout, zoom or close of it.
    expect(JSON.stringify(herdr.requests)).not.toMatch(/w1:p1|w1:t1"/u);
    expect(refreshed).toEqual(["mini"]);
    // "+": another, its own tab.
    expect((await openDrawerShell(hosts, "mini", { workspaceId: "w1", folder: "/Users/demo/code/app" })).paneId).toBe("w1:pn2");
    expect(herdr.requests.map((request) => [request.method, request.params["label"]])).toEqual([
      ["tab.create", "Terminal"],
      ["tab.create", "Terminal"],
    ]);
  });

  it("opens in the machine's home when the folder is not known, else where Herdr opens a tab, and says which", async () => {
    const herdr = fakeHerdr();
    const host: FakeHost = { id: "mini", name: "Mac mini", state: "connected", topology: snapshot() };
    const withHome = machines(host, { workspaceActions: () => herdr.client, transcripts: home("/Users/demo") });
    expect(await openDrawerShell(withHome.hosts, "mini", { workspaceId: "w1", folder: null })).toMatchObject({ folder: "/Users/demo", place: "home" });
    expect(herdr.requests.at(-1)!.params).toEqual({ workspace_id: "w1", focus: false, cwd: "/Users/demo", label: "Terminal" });
    // A home that cannot be read, or is not a plain absolute path: no cwd at all (Herdr's own start folder).
    for (const reader of [home(null), home("relative/dir"), home("/Users/demo\u0007"), () => null, () => ({ home: async () => Promise.reject(new Error("sftp")) })]) {
      const { hosts } = machines(host, { workspaceActions: () => herdr.client, transcripts: reader });
      expect(await openDrawerShell(hosts, "mini", { workspaceId: "w1", folder: "  " })).toMatchObject({ folder: null, place: "default" });
      expect(herdr.requests.at(-1)!.params).toEqual({ workspace_id: "w1", focus: false, label: "Terminal" });
    }
  });

  it("refuses before anything is sent: a machine not listed or not answering, a workspace it does not have, no way to make one", async () => {
    const herdr = fakeHerdr();
    const host: FakeHost = { id: "mini", name: "Mac mini", state: "connected", topology: snapshot() };
    const { hosts } = machines(host, { workspaceActions: () => herdr.client });
    await expect(openDrawerShell(hosts, "box", { workspaceId: "w1", folder: null })).rejects.toThrow("no longer listed");
    await expect(openDrawerShell(hosts, "mini", { workspaceId: "w9", folder: null })).rejects.toThrow("not on Mac mini");
    host.state = "offline";
    await expect(openDrawerShell(hosts, "mini", { workspaceId: "w1", folder: null })).rejects.toThrow("not answering");
    host.state = "connected";
    await expect(openDrawerShell(machines(host, {}).hosts, "mini", { workspaceId: "w1", folder: null })).rejects.toThrow("cannot open a shell");
    expect(herdr.requests).toEqual([]);
  });
});

describe("no idle answer for ×", () => {
  // A screen check would take a Node REPL's "> " and output ending in "$" or "#" for an empty
  // prompt, and × would close them at once. Herdr gives no authoritative idle state for a shell, so main gives none at all.
  it("main has no busy door and reads no screen for it: a Node REPL, output ending in $ or #, any screen", async () => {
    const screens = { "w1:pn1": "> ", "w1:pn2": "build finished in 4s $", "w1:pn3": "Removing build/ #", "w1:pn4": "demo@mini app % " };
    const herdr = fakeHerdr(screens);
    const host: FakeHost = { id: "mini", name: "Mac mini", state: "connected", topology: snapshot(Object.keys(screens)) };
    const { hosts } = machines(host, { workspaceActions: () => herdr.client });
    registered.handles.clear();
    registerIpc({ hosts } as never);
    expect(registered.handles.has("herdr:drawer-shell-busy")).toBe(false);
    expect([...registered.handles.keys()].filter((channel) => channel.startsWith("herdr:drawer-shell"))).toEqual([IPC.drawerShellOpen]);
    expect(Object.keys(drawerShell).filter((name) => /busy|prompt/iu.test(name))).toEqual([]);
    expect("drawerShellBusy" in IPC).toBe(false);
    expect(herdr.requests).toEqual([]);
  });
});

describe("a herdr-core machine", () => {
  let core: FakeCore;
  let tui: TUIFixtureTransport;
  let transport: CoreHostTransport;
  let client: HerdrClient;

  beforeEach(async () => {
    core = new FakeCore([
      FakeCore.terminal("t1", {
        argv: ["claude"],
        labels: { "herdr.space": "s1", "herdr.tab": "tA" },
        status: FakeCore.status("idle"),
        foreground: FakeCore.foreground("claude", ["claude"], "/Users/me/code/app", 5151),
        pid: 5151,
      }),
    ]);
    const document: CoreJSON = { spaces: [{ id: "s1", name: "App", folder: "/Users/me/code/app", color: "teal", tabs: [{ id: "tA", name: "Main", root: { terminal: "t1" } }] }], focus: { space: "s1" } };
    core.setDocument("herdr-app", document, 7);
    tui = new TUIFixtureTransport();
    transport = coreHost(tui, core);
    client = new HerdrClient(transport);
  });

  afterEach(() => {
    transport.close();
    transport.follower.close();
  });

  const runs = (): (CoreJSON | undefined)[] => core.calls.filter((call) => call.method === "terminal.run").map((call) => call.params);

  it("goes through the core's shell path: terminal.run of the machine's shell in the space, in the folder; never the TUI server", async () => {
    const topology = await client.sessionTopology();
    const workspaceId = topology.workspaces.find((workspace) => workspace.workspaceID.startsWith("hc:"))!.workspaceID;
    const host: FakeHost = { id: "core", name: "Studio", state: "connected", topology };
    const { hosts } = machines(host, { workspaceActions: () => client, transcripts: home("/Users/me") });
    const made = await openDrawerShell(hosts, "core", { workspaceId, folder: "/Users/me/code/app" });
    expect(CoreIDs.isCore(made.paneId)).toBe(true);
    expect(made.place).toBe("folder");
    expect(runs()).toHaveLength(1);
    const run = runs()[0];
    expect(member(run, "argv"), "the machine's own shell").toBeUndefined();
    expect(member(run, "cwd")).toBe("/Users/me/code/app");
    expect(at(run, "labels", "herdr.space")).toBe("s1");
    expect(at(run, "labels", "herdr.tab"), "a tab of its own, not the agent's").not.toBe("tA");
    expect(tui.methods.filter((method) => method === "tab.create")).toEqual([]);
    // The folder not known: the machine's home.
    expect(await openDrawerShell(hosts, "core", { workspaceId, folder: null })).toMatchObject({ folder: "/Users/me", place: "home" });
    expect(member(runs().at(-1), "cwd")).toBe("/Users/me");
  });

  // Herdr App's tab label "Terminal" is, on herdr-core, the terminal's name (core-actions newTab), which
  // herdr-core takes in lower case only: "terminal". A name a terminal on the machine already has is refused
  // (name_taken), and runShell starts it again unnamed: that shell has no name of its own there.
  it("names the shell's terminal \"terminal\" (herdr-core's names are lower case); one the machine already has: unnamed", async () => {
    const topology = await client.sessionTopology();
    const workspaceId = topology.workspaces.find((workspace) => workspace.workspaceID.startsWith("hc:"))!.workspaceID;
    const host: FakeHost = { id: "core", name: "Studio", state: "connected", topology };
    const { hosts } = machines(host, { workspaceActions: () => client });
    const first = await openDrawerShell(hosts, "core", { workspaceId, folder: "/Users/me/code/app" });
    expect(runs().map((run) => member(run, "name"))).toEqual(["terminal"]);
    const listed = (await client.sessionTopology()).panes.find((pane) => pane.paneID === first.paneId);
    expect(listed?.label).toBe("terminal");
    // The machine has a terminal named so: refused once, then made without a name.
    let fresh = 90;
    core.overrides.set("terminal.run", (params) => {
      if (member(params, "name") !== undefined) return FakeCore.rpcError("a terminal is named terminal", "name_taken");
      fresh += 1;
      const labels: Record<string, string> = {};
      for (const [key, value] of Object.entries(jsonObject(member(params, "labels")) ?? {})) if (typeof value === "string") labels[key] = value;
      const record = FakeCore.terminal(`t${String(fresh)}`, { argv: ["/bin/zsh", "-l"], cwd: jsonString(member(params, "cwd")) ?? "/Users/me", labels, keep: true });
      core.create(record);
      return { result: record };
    });
    const second = await openDrawerShell(hosts, "core", { workspaceId, folder: "/Users/me/code/app" });
    expect(runs().map((run) => member(run, "name"))).toEqual(["terminal", "terminal", undefined]);
    expect(second.paneId).not.toBe(first.paneId);
    expect(tui.methods.filter((method) => method === "tab.create")).toEqual([]);
  });
});

describe("the IPC doors", () => {
  const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

  it("take only a host and a request of a workspace and a folder, nothing after; open through the machines", async () => {
    expect(isDrawerShellRequest({ workspaceId: "w1", folder: null })).toBe(true);
    expect(isDrawerShellRequest({ workspaceId: "w1", folder: "/Users/demo/app" })).toBe(true);
    expect(isDrawerShellRequest({ workspaceId: "w1", folder: "/a\nb" })).toBe(false);
    expect(isDrawerShellRequest({ workspaceId: "", folder: null })).toBe(false);
    expect(isDrawerShellRequest({ workspaceId: "w1", folder: null, start: "rm -rf /" })).toBe(false);
    expect(isDrawerShellRequest(null)).toBe(false);

    const herdr = fakeHerdr();
    const host: FakeHost = { id: "mini", name: "Mac mini", state: "connected", topology: snapshot() };
    const { hosts } = machines(host, { workspaceActions: () => herdr.client });
    registered.handles.clear();
    registerIpc({ hosts } as never);
    const open = registered.handles.get(IPC.drawerShellOpen)!;
    expect(await open(event, "mini", { workspaceId: "w1", folder: "/Users/demo/code/app" })).toMatchObject({ paneId: "w1:pn1", place: "folder" });
    await expect(Promise.resolve().then(() => open(event, "mini", { workspaceId: "w1", folder: null, kind: "claude" }))).rejects.toThrow();
    // Extra positional arguments are refused before anything is made, as uploads-count's are.
    const made = herdr.requests.length;
    for (const tail of [[undefined], ["extra"], [{ workspaceId: "w2", folder: "/" }], [1, 2]]) {
      await expect(Promise.resolve().then(() => open(event, "mini", { workspaceId: "w1", folder: null }, ...tail)), JSON.stringify(tail)).rejects.toThrow("bad request");
    }
    expect(herdr.requests.length).toBe(made);
    // A page from elsewhere is refused before anything is read or made.
    const before = herdr.requests.length;
    await expect(Promise.resolve().then(() => open({ senderFrame: { url: "https://example.com" }, sender: { id: 1 } }, "mini", { workspaceId: "w1", folder: null }))).rejects.toThrow();
    expect(herdr.requests.length).toBe(before);
  });
});
