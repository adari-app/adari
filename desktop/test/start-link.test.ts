// Every step of a New
// agent bound to the machine and the command connection that made its pane.
// The machine link (machine-link.ts) is taken at the door before anything is
// awaited and checked right before each request: the name's agent.list, the
// tab.create or pane.split, every agent.start retry, the typed pane.send_input,
// each look's pane.read and agent.list, and the cleanup pane.close. A machine
// removed, edited, not answering or reconnected since stops with a plain line
// and nothing more is sent; never a reconnect to close an old pane id. The
// folder's `~` is read before the creation's check (New agent's tab and shell
// routes, the drawer), and the split route's guard covers the new pane's
// later calls (pane-actions.ts).
//
// The first block runs the real HerdrTuiBackend, HerdrClient,
// SshHerdrTransport and HostRegistry over in-memory SSH clients answered by
// the demo's FixtureTransport; no network, no keys, no real Herdr.

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, run: (...args: unknown[]) => unknown) => electron.handles.set(channel, run), on: () => undefined },
  protocol: {},
}));

import { FixtureTransport } from "../src/main/demo/demo-backend";
import { HerdrTuiBackend } from "../src/main/herdr/backend";
import { openDrawerShell, type DrawerShellHosts } from "../src/main/herdr/drawer-shell";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { machineLink, machineLinkTexts, type MachineLinkHosts } from "../src/main/herdr/machine-link";
import { AgentStartFailed, newAgent, newAgentTexts, type NewAgentHerdr } from "../src/main/herdr/new-agent";
import { APIError, type AgentInfo, type TabCreation, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { LayoutService, type LayoutOwner } from "../src/main/layouts";
import { newAgentInSplit } from "../src/main/pane-actions";
import { APP_ORIGIN } from "../src/main/protocol";
import { IPC, type LayoutUpdateEvent } from "../src/shared/ipc-contract";
import { paneBindingOf } from "../src/shared/pane-binding";
import type { PaneLayout } from "../src/shared/pane-layout";
import { absentStartCommands, parseStartCommands } from "../src/shared/start-commands";
import { eventually } from "./support/chat-lines";
import { LiveHerdr } from "./support/live-herdr";
import { paneTopology } from "./support/pane-topology";

const { registerIpc } = await import("../src/main/ipc");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };

beforeEach(() => electron.handles.clear());

// MARK: - The real backend, client, transport and registry

function fixtureSnapshot() {
  return {
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "fixture", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "unknown" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "fixture", focused: true, pane_count: 1, agent_status: "unknown" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "fixture-t1", workspace_id: "w1", tab_id: "w1:t1", focused: true, cwd: "/fixture/project", agent_status: "unknown", revision: 1 }],
    agents: [],
  };
}

interface Sent {
  readonly connection: number;
  readonly method: string;
  readonly pane: unknown;
}

/**
 * One SSH machine on the real backend: each SSH client it opens is an in-memory one (its number is the connection),
 * every request answered by the demo's Herdr, whose first Codex start answers `agent_pane_busy`. `onBusy` runs once,
 * right after that answer is given; `otherOwner` makes a start on a later connection answer that another agent owns
 * the pane (Herdr restarted and reused its ids).
 */
async function sshMachine() {
  const fixture = new FixtureTransport(fixtureSnapshot());
  fixture.setStartQuirks({ busy: { codex: 1 } });
  const sent: Sent[] = [];
  const clients: MemoryClient[] = [];
  const state = { onBusy: null as (() => void) | null, otherOwner: false };
  class MemoryClient extends EventEmitter {
    readonly number = clients.length + 1;
    end(): void {
      this.emit("end");
      this.emit("close");
    }
    exec(command: string, done: (error: unknown, channel: unknown) => void): void {
      const encoded = /printf '%s' '([^']+)'/.exec(command)?.[1];
      if (encoded === undefined) throw new Error("not a request");
      const line = Buffer.from(encoded, "base64").toString("utf8").trim();
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      sent.push({ connection: this.number, method: request.method, pane: request.params["pane_id"] });
      const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => undefined });
      done(undefined, channel);
      void (async () => {
        const reply =
          state.otherOwner && this.number > 1 && request.method === "agent.start"
            ? JSON.stringify({ id: request.id, error: { code: "agent_already_exists", message: "another agent owns this pane" } })
            : await fixture.roundTrip(line);
        channel.emit("data", Buffer.from(`${reply}\n`));
        if (request.method === "agent.start" && reply.includes("agent_pane_busy") && state.onBusy !== null) {
          const run = state.onBusy;
          state.onBusy = null;
          setTimeout(run, 0);
        }
      })();
    }
  }
  const backend = new HerdrTuiBackend(
    { host: "fixture.invalid", port: 22, username: "fixture", privateKeyPath: "/never-read", herdrSession: "start-link" },
    new PinningHostKeyPolicy(new MemoryPinStore()),
    {
      connect: async () => {
        const client = new MemoryClient();
        clients.push(client);
        return client as never;
      },
      relayScript: "",
    },
  );
  // A command-connection test: no event streams.
  Object.defineProperty(backend, "subscribeEvents", { value: undefined });
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture.invalid", platform: "macOS" }, backend);
  await registry.refreshAll();
  return { sent, clients, state, backend, registry, later: () => sent.filter((request) => request.connection !== 1) };
}

type Change = "lost" | "removed" | "reused";

function change(m: Awaited<ReturnType<typeof sshMachine>>, how: Change): void {
  if (how === "lost") m.clients[0]!.end();
  else m.registry.remove("mini");
  if (how === "reused") m.state.otherOwner = true;
}

describe("the busy wait ends when its machine or connection changes", () => {
  it.each(["lost", "removed", "reused"] as const)("%s during the first 250 ms wait: no request on a new connection, the pane not closed", async (how) => {
    const m = await sshMachine();
    let time = 0;
    let changed = false;
    const clock = {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
        if (!changed) {
          changed = true;
          change(m, how);
        }
      },
    };
    try {
      const machine = { name: "Mac mini", link: machineLink(m.registry, "mini", "Mac mini") };
      const failed = await newAgent(m.backend.workspaceActions(), absentStartCommands, { workspaceId: "w1", folder: "/fixture/project", kind: "codex" }, clock, 90_000, 1_000, machine).catch(
        (error: unknown) => error,
      );
      expect(m.later()).toEqual([]);
      expect(m.clients).toHaveLength(1);
      expect(failed).toBeInstanceOf(AgentStartFailed);
      expect((failed as AgentStartFailed).paneClosed).toBe(false);
      const why = how === "lost" ? machineLinkTexts.closed("Mac mini", "since New agent began") : machineLinkTexts.removed("Mac mini", "since New agent began");
      expect((failed as Error).message).toBe(newAgentTexts.notStarted(why, "Codex", "tab"));
      // On the first connection: the name, the tab, the one busy start; nothing after.
      expect(m.sent.filter((request) => request.method !== "session.snapshot").map((request) => request.method)).toEqual(["agent.list", "tab.create", "agent.start"]);
    } finally {
      m.registry.close();
      m.backend.close();
    }
  });

  it.each(["lost", "removed", "reused"] as const)("%s at the New agent door, on a live clock: the same, nothing on a new connection", async (how) => {
    const m = await sshMachine();
    m.state.onBusy = () => change(m, how);
    registerIpc({ hosts: m.registry } as never);
    try {
      const failed = await (electron.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", folder: "/fixture/project", kind: "codex" }) as Promise<unknown>).catch(
        (error: unknown) => error,
      );
      // (The door's agents.json and home reads open the SFTP reader's own client; it carries no Herdr request.)
      expect(m.later()).toEqual([]);
      expect((failed as Error).message).toContain("Codex was not started and nothing more was sent; its new tab was left as it is.");
      expect(m.sent.some((request) => request.method === "pane.close")).toBe(false);
    } finally {
      m.registry.close();
      m.backend.close();
    }
  });

  it("the same machine on the same connection: the busy start is sent again and taken", async () => {
    const m = await sshMachine();
    registerIpc({ hosts: m.registry } as never);
    try {
      const made = (await electron.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", folder: "/fixture/project", kind: "codex" })) as { start: { type: string } };
      expect(made.start.type).toBe("herdr");
      expect(m.sent.filter((request) => request.method === "agent.start").map((request) => request.connection)).toEqual([1, 1]);
      expect(m.later()).toEqual([]);
    } finally {
      m.registry.close();
      m.backend.close();
    }
  });
});

// MARK: - Each later step checked against the link

/** A link that holds until `changeAfter` checks have passed, then says the machine reconnected. */
function countedLink(changeAfter: number) {
  let checks = 0;
  const why = machineLinkTexts.reconnected("Mac mini", "since New agent began");
  return {
    why,
    checks: () => checks,
    link: { check: () => (++checks > changeAfter ? why : null), sent: () => undefined },
  };
}

/** A fake Herdr recording every request; `starts` answers each agent.start in turn, `texts` each pane.read. */
class StepHerdr implements NewAgentHerdr {
  readonly calls: string[] = [];
  starts: (APIError | "ok")[] = ["ok"];
  texts: string[] = [""];
  private started = 0;
  private reads = 0;

  agentList(): Promise<AgentInfo[]> {
    this.calls.push("agent.list");
    return Promise.resolve([]);
  }
  createTerminalTab(workspaceID: string, label: string | null): Promise<TabCreation> {
    this.calls.push("tab.create");
    return Promise.resolve({ tab: { tabID: "w1:tn1", workspaceID, label }, rootPane: { paneID: "w1:pn1", tabID: "w1:tn1" } } as unknown as TabCreation);
  }
  splitPane(): Promise<TopologyPaneInfo> {
    this.calls.push("pane.split");
    return Promise.resolve({ paneID: "w1:ps1", tabID: "w1:t1" } as unknown as TopologyPaneInfo);
  }
  startAgent(name: string, kind: string, paneID: string): Promise<AgentInfo> {
    this.calls.push("agent.start");
    const answer = this.starts[Math.min(this.started, this.starts.length - 1)]!;
    this.started += 1;
    return answer === "ok" ? Promise.resolve({ paneID, name, agent: kind }) : Promise.reject(answer);
  }
  closePane(): Promise<void> {
    this.calls.push("pane.close");
    return Promise.resolve();
  }
  sendInput(): Promise<void> {
    this.calls.push("pane.send_input");
    return Promise.resolve();
  }
  paneText(): Promise<string> {
    this.calls.push("pane.read");
    const text = this.texts[Math.min(this.reads, this.texts.length - 1)]!;
    this.reads += 1;
    return Promise.resolve(text);
  }
}

function stepClock() {
  let time = 0;
  return { now: () => time, sleep: (ms: number) => ((time += ms), Promise.resolve()) };
}

const typed = parseStartCommands(new TextEncoder().encode('{"codex":"cx"}'));
const codex = { workspaceId: "w1", folder: null, kind: "codex" };

describe("each later step of a New agent is checked right before it goes", () => {
  it("changed before the name is read: nothing sent, nothing made", async () => {
    const herdr = new StepHerdr();
    const l = countedLink(0);
    await expect(newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link })).rejects.toThrow(newAgentTexts.nothingMade(l.why));
    expect(herdr.calls).toEqual([]);
  });

  it("changed between the name and the tab: no tab.create", async () => {
    const herdr = new StepHerdr();
    const l = countedLink(1);
    await expect(newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link })).rejects.toThrow(newAgentTexts.nothingMade(l.why));
    expect(herdr.calls).toEqual(["agent.list"]);
  });

  it("changed after the tab was made: no agent.start, no pane.close", async () => {
    const herdr = new StepHerdr();
    const l = countedLink(2);
    const failed = await newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(AgentStartFailed);
    expect((failed as AgentStartFailed).paneClosed).toBe(false);
    expect((failed as Error).message).toBe(newAgentTexts.notStarted(l.why, "Codex", "tab"));
    expect(herdr.calls).toEqual(["agent.list", "tab.create"]);
  });

  it("changed during the busy retries: the next start is not sent and the pane is not closed", async () => {
    const herdr = new StepHerdr();
    herdr.starts = [new APIError("agent_pane_busy", "not at its prompt")];
    const l = countedLink(5);
    const failed = await newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link }).catch((error: unknown) => error);
    expect((failed as AgentStartFailed).paneClosed).toBe(false);
    expect(herdr.calls).toEqual(["agent.list", "tab.create", "agent.start", "agent.start", "agent.start"]);
  });

  it("a refused start whose machine changed before the close: the close is not sent, the line says the tab was left open", async () => {
    const herdr = new StepHerdr();
    herdr.starts = [new APIError("agent_start_failed", "codex is not installed")];
    const l = countedLink(3);
    const failed = await newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link }).catch((error: unknown) => error);
    expect((failed as AgentStartFailed).paneClosed).toBe(false);
    expect((failed as Error).message).toBe(newAgentTexts.leftOpen(newAgentTexts.refused("Codex", "codex is not installed"), l.why, "tab"));
    expect(herdr.calls).toEqual(["agent.list", "tab.create", "agent.start"]);
  });

  it("the busy wait given up on the same connection still closes its pane", async () => {
    const herdr = new StepHerdr();
    herdr.starts = [new APIError("agent_pane_busy", "not at its prompt")];
    const failed = await newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: countedLink(1_000).link }).catch((error: unknown) => error);
    expect((failed as AgentStartFailed).paneClosed).toBe(true);
    expect(herdr.calls.at(-1)).toBe("pane.close");
  });

  it("changed during the look after Herdr's start: no more reads, the agent's tab kept with the line", async () => {
    const herdr = new StepHerdr();
    const l = countedLink(4);
    const made = await newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link });
    expect(made.start).toEqual({ type: "herdr" });
    expect(made.summary).toBe(newAgentTexts.lookStopped(l.why, "tab"));
    expect(herdr.calls).toEqual(["agent.list", "tab.create", "agent.start", "pane.read"]);
  });

  it("changed before the typed command: it is not typed and the pane is not closed", async () => {
    const herdr = new StepHerdr();
    const l = countedLink(2);
    const failed = await newAgent(herdr, typed, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link }).catch((error: unknown) => error);
    expect((failed as AgentStartFailed).paneClosed).toBe(false);
    expect((failed as Error).message).toBe(newAgentTexts.notTyped(l.why, "cx", "tab"));
    expect(herdr.calls).toEqual(["agent.list", "tab.create"]);
  });

  it("changed during the typed command's wait: no more looks, the pane left open with the line", async () => {
    const herdr = new StepHerdr();
    const l = countedLink(5);
    const made = await newAgent(herdr, typed, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link: l.link });
    expect(made.start).toEqual({ type: "noAgent", command: "cx" });
    expect(made.summary).toBe(newAgentTexts.waitStopped(l.why, "Codex", "cx"));
    expect(herdr.calls).toEqual(["agent.list", "tab.create", "pane.send_input", "agent.list", "pane.read"]);
  });

  it("the link is asked right before each request, nothing awaited between", async () => {
    const herdr = new StepHerdr();
    const order: string[] = [];
    const record = <T extends unknown[], R>(name: string, call: (...args: T) => R) => (...args: T): R => {
      order.push(name);
      return call(...args);
    };
    herdr.agentList = record("agent.list", herdr.agentList.bind(herdr));
    herdr.createTerminalTab = record("tab.create", herdr.createTerminalTab.bind(herdr));
    herdr.startAgent = record("agent.start", herdr.startAgent.bind(herdr));
    herdr.paneText = record("pane.read", herdr.paneText.bind(herdr));
    const link = { check: () => (order.push("check"), null), sent: () => undefined };
    await newAgent(herdr, absentStartCommands, codex, stepClock(), 90_000, 1_000, { name: "Mac mini", link });
    for (let i = 0; i < order.length; i += 2) expect(order[i]).toBe("check");
    expect(order.filter((step) => step !== "check")).toEqual(herdr.calls);
  });
});

// MARK: - The machine link itself

describe("the machine link", () => {
  function registryLike() {
    const now = { listed: true, incarnation: 1, connection: 3 as number | null, epoch: 7 as number | null };
    const hosts: MachineLinkHosts = {
      connection: () => (now.listed ? now.connection : null),
      connectionIdentity: () => (now.listed ? { incarnation: now.incarnation, epoch: now.epoch } : null),
    };
    return { now, hosts };
  }

  it("holds while the entry, its answering connection and its command connection are the ones it began on", () => {
    const m = registryLike();
    expect(machineLink(m.hosts, "mini", "Mac mini").check()).toBeNull();
  });

  it.each([
    ["removed", (n: ReturnType<typeof registryLike>["now"]) => (n.listed = false), machineLinkTexts.removed("Mac mini", "since New agent began")],
    ["edited or added again", (n: ReturnType<typeof registryLike>["now"]) => (n.incarnation = 2), machineLinkTexts.replaced("Mac mini", "since New agent began")],
    ["not answering", (n: ReturnType<typeof registryLike>["now"]) => (n.connection = null), machineLinkTexts.notAnswering("Mac mini", "since New agent began")],
    ["answering again on a new connection", (n: ReturnType<typeof registryLike>["now"]) => (n.connection = 4), machineLinkTexts.reconnected("Mac mini", "since New agent began")],
    ["a new command connection", (n: ReturnType<typeof registryLike>["now"]) => (n.epoch = 8), machineLinkTexts.reconnected("Mac mini", "since New agent began")],
    ["its command connection closed", (n: ReturnType<typeof registryLike>["now"]) => (n.epoch = null), machineLinkTexts.closed("Mac mini", "since New agent began")],
  ])("%s: refused in words", (_name, changeIt, text) => {
    const m = registryLike();
    const link = machineLink(m.hosts, "mini", "Mac mini");
    changeIt(m.now);
    expect(link.check()).toBe(text);
  });

  it("with no command connection held at the door, the first one a request goes on is the one it keeps", () => {
    const m = registryLike();
    m.now.epoch = null;
    const link = machineLink(m.hosts, "mini", "Mac mini");
    expect(link.check()).toBeNull();
    // The request opened connection 8.
    m.now.epoch = 8;
    link.sent();
    expect(link.check()).toBeNull();
    m.now.epoch = 9;
    expect(link.check()).toBe(machineLinkTexts.reconnected("Mac mini", "since New agent began"));
  });

  it("no text has a dash of any kind or a raw code", () => {
    for (const text of Object.values(machineLinkTexts).map((make) => make("Mac mini", "since New agent began"))) {
      expect(text).not.toMatch(/[\u2014\u2013]/);
      expect(text).not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+:/);
    }
  });
});

// MARK: - The folder read before the creation's check

/** A machine at the door whose home read can remove it or reconnect it meanwhile. */
function doorMachine() {
  const sent: unknown[][] = [];
  const state = { listed: true, epoch: 1 };
  const herdr: NewAgentHerdr = {
    createTerminalTab: async (...args: unknown[]) => {
      sent.push(["tab.create", ...args]);
      return { tab: { tabID: "w1:tn1" }, rootPane: { paneID: "w1:pn1" } } as unknown as TabCreation;
    },
    agentList: async () => (sent.push(["agent.list"]), []),
    startAgent: async () => (sent.push(["agent.start"]), { paneID: "w1:pn1" }),
    closePane: async () => void sent.push(["pane.close"]),
    sendInput: async () => void sent.push(["pane.send_input"]),
  };
  let duringHome: () => void = () => undefined;
  const backend = {
    workspaceActions: () => herdr,
    readStartCommandsFile: async () => null,
    homeFolder: async () => {
      duringHome();
      return "/fixture/home";
    },
  };
  const host = { id: "mini", name: "Mac mini", kind: "ssh", address: "fixture.invalid", platform: "macOS", state: "connected", error: null, fetchedAtMs: 0, topology: paneTopology([{ id: "w1:p1" }]) };
  const hosts: DrawerShellHosts = {
    backend: () => (state.listed ? backend : null),
    list: () => (state.listed ? [host] : []),
    refresh: async () => undefined,
    connection: () => (state.listed ? 1 : null),
    connectionIdentity: () => (state.listed ? { incarnation: 1, epoch: state.epoch } : null),
  };
  return {
    sent,
    hosts,
    onHome: (run: () => void) => (duringHome = run),
    remove: () => (state.listed = false),
    reconnect: () => (state.epoch += 1),
  };
}

describe("a machine changed while its home is read: nothing is made", () => {
  it.each([
    ["removed", "shell"],
    ["reconnected", "shell"],
    ["removed", "codex"],
    ["reconnected", "codex"],
  ] as const)("New agent's %s machine (%s): no request, a plain line", async (how, kind) => {
    const m = doorMachine();
    m.onHome(how === "removed" ? m.remove : m.reconnect);
    registerIpc({ hosts: m.hosts } as never);
    const refused = await (electron.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", kind, folder: "~/project" }) as Promise<unknown>).catch((error: unknown) => error);
    expect(m.sent).toEqual([]);
    const why = how === "removed" ? machineLinkTexts.removed("Mac mini", "since New agent began") : machineLinkTexts.reconnected("Mac mini", "since New agent began");
    expect((refused as Error).message).toContain(newAgentTexts.nothingMade(why));
  });

  it.each(["removed", "reconnected"] as const)("the drawer's shell on a %s machine: no tab.create, a plain line", async (how) => {
    const m = doorMachine();
    m.onHome(how === "removed" ? m.remove : m.reconnect);
    const refused = await openDrawerShell(m.hosts, "mini", { workspaceId: "w1", folder: "~/project" }).catch((error: unknown) => error);
    expect(m.sent).toEqual([]);
    const since = "since the terminal was asked for";
    expect((refused as Error).message).toBe(`${how === "removed" ? machineLinkTexts.removed("Mac mini", since) : machineLinkTexts.reconnected("Mac mini", since)} No terminal was opened.`);
  });

  it("the same machine throughout: the drawer's shell and New agent's shell are made at the home's folder", async () => {
    const m = doorMachine();
    registerIpc({ hosts: m.hosts } as never);
    await electron.handles.get(IPC.newAgent)!(event, "mini", { workspaceId: "w1", kind: "shell", folder: "~/project" });
    await openDrawerShell(m.hosts, "mini", { workspaceId: "w1", folder: "~/project" });
    expect(m.sent.map((call) => [call[0], call.at(-1)])).toEqual([
      ["tab.create", "/fixture/home/project"],
      ["tab.create", "/fixture/home/project"],
    ]);
  });
});

// MARK: - The split route: the guarded split's binding covers the new pane's later calls

async function splitMachine() {
  const live = new LiveHerdr();
  live.addTab("w1:t1", ["w1:p1", "w1:p2"]);
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null }, live.backend());
  await registry.refreshAll();
  const service = new LayoutService(registry, "layout");
  const layouts = {
    reread: (hostId: string) => service.reread(hostId),
    accept: (hostId: string, layout: PaneLayout) => service.accept(hostId, layout),
    watched: (owner: { readonly id: number }) => service.watched(owner),
  };
  const updates: LayoutUpdateEvent[] = [];
  const page: LayoutOwner = { id: 10, send: (_channel, payload) => updates.push(payload), isDestroyed: () => false };
  service.watch(page, "mini", "w1:p1");
  await eventually(() => updates.at(-1)?.layout != null);
  const binding = paneBindingOf(registry.list()[0]!, updates.at(-1)!.layout, "w1:p1")!;
  const request = { workspaceId: "w1", folder: null, kind: "codex", where: { type: "split" as const, direction: "right" as const, targetPaneId: "w1:p1", binding } };
  return { live, registry, layouts, page, request };
}

describe("New agent's split: every call after pane.split goes on the binding's connection or not at all", () => {
  it("a new command connection right after the split: no agent.start, no pane.close (pane-actions.ts alone, no link)", async () => {
    const m = await splitMachine();
    m.live.afterAnswer = (method) => {
      if (method === "pane.split") m.live.epoch = 2;
    };
    const failed = await newAgentInSplit(m.registry, m.layouts, m.page, "mini", m.request, m.live.client, (herdr) =>
      newAgent(herdr, absentStartCommands, m.request, stepClock(), 90_000, 1_000, { name: "Mac mini" }),
    ).catch((error: unknown) => error);
    const methods = m.live.sent.map((request) => request.method);
    expect(methods).toContain("pane.split");
    expect(methods.slice(methods.indexOf("pane.split"))).not.toContain("agent.start");
    expect(methods).not.toContain("pane.close");
    expect((failed as AgentStartFailed).paneClosed).toBe(false);
    expect((failed as Error).message).toContain("The machine reconnected since the pane was shown.");
  });

  it("the same connection throughout: the agent is started in the new pane", async () => {
    const m = await splitMachine();
    const made = await newAgentInSplit(m.registry, m.layouts, m.page, "mini", m.request, m.live.client, (herdr) =>
      newAgent(herdr, absentStartCommands, m.request, stepClock(), 90_000, 1_000, { name: "Mac mini" }),
    );
    expect(made.start).toEqual({ type: "herdr" });
    expect(m.live.sent.map((request) => request.method)).toContain("agent.start");
  });
});
