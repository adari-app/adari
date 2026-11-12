// The first Chat after Install, from a clean home, works without a wrong line.
// A pane Adari's New agent started after the integration was in place
// is told "Chat shows Codex's replies after your first message.", an older
// pane keeps the steps. A no-session send whose adopted session's first
// transcript already holds it is one bubble. A fresh read that says missing
// after Installed brings Install back. A real HostRegistry and
// IntegrationService with a fake Herdr behind a real HerdrClient; the real views on the small hooks host; the real
// registerIpc with Electron's ipcMain faked. No real Herdr, no socket, no
// network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { HerdrClient } from "../src/main/herdr/client";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { IntegrationService } from "../src/main/integrations";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import { integrationName, integrationTexts, type HostIntegrations, type IntegrationItem, type IntegrationOutcome } from "../src/shared/integrations";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { PendingMessages, terminalOnlyLabel } from "../src/shared/chat/pending";
import { HookHost, elements } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { ChatIntegration, chatIntegrationLook, integrationNotes } = await import("../src/renderer/components/integrations");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

const firstMessage = "Chat shows Codex's replies after your first message.";
const steps = "Installed. To use it, quit Codex in its terminal when it is done, then start it again with New agent.";

// MARK: - a fake Herdr on a real registry and service

const emptyTopology = decodeSessionTopology({ version: "0.9.5", protocol: 22, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] });
const info = (target: string, state: string) => ({ target, label: target, command: target, available: true, state });

function machine(initial: Record<string, string> = { codex: "not_installed" }) {
  const states = new Map(Object.entries(initial));
  const requests: string[] = [];
  /** A list reply held back until the test lets it go (null: answered at once). */
  let hold: Promise<void> | null = null;
  let epoch = 1;
  const transport = {
    async roundTrip(line: string): Promise<string> {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      requests.push(request.method);
      if (request.method === "integration.list") {
        const snapshot = [...states].map(([target, state]) => info(target, state));
        if (hold !== null) await hold;
        return JSON.stringify({ id: request.id, result: { type: "integration_list", integrations: snapshot } });
      }
      if (request.method === "integration.install") {
        const target = String(request.params["target"]);
        states.set(target, "current");
        return JSON.stringify({ id: request.id, result: { type: "integration_install", target, details: { messages: [`installed ${target} integration hook`] } } });
      }
      return JSON.stringify({ id: request.id, error: { code: "unknown_method", message: "no such method" } });
    },
    close: () => undefined,
  };
  const client = new HerdrClient(transport);
  const backend = { kind: "herdr-tui" as const, snapshot: () => Promise.resolve(emptyTopology), connectionEpoch: () => epoch, integrations: () => client, close: () => undefined };
  return {
    descriptor: { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "dev@mini", platform: "macOS" },
    backend,
    states,
    requests,
    holdLists: () => {
      let release!: () => void;
      hold = new Promise<void>((done) => (release = done));
      return () => {
        hold = null;
        release();
      };
    },
    setEpoch: (value: number) => {
      epoch = value;
    },
  };
}

async function world(initial?: Record<string, string>) {
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  service = new IntegrationService(registry);
  const m = machine(initial);
  registry.add(m.descriptor, m.backend as never);
  await registry.refresh("mini");
  await flush();
  const host = (): HostView => registry.list().find((entry) => entry.id === "mini")!;
  const binding = () => ({ incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null });
  return { registry, service: service!, m, host, binding };
}

// MARK: - the views

const sessionId = "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84";
const item = (target: string, state: IntegrationItem["state"]): IntegrationItem => ({ target, kind: target, name: integrationName(target), state, available: true });
const installed: IntegrationOutcome = { phase: "installed", text: integrationTexts.installed("Codex"), messages: ["installed codex integration hook"], action: "install" };

function viewHost(state: IntegrationItem["state"], outcome: IntegrationOutcome | null, startedAfter?: readonly string[]): HostView {
  const integrations: HostIntegrations = {
    incarnation: 3,
    connection: 5,
    epoch: 9,
    items: [item("codex", state)],
    outcomes: outcome === null ? {} : { codex: outcome },
    ...(startedAfter === undefined ? {} : { startedAfter: { codex: startedAfter } }),
  };
  return {
    id: "mini",
    name: "Mac mini",
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    topology: decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 2, tab_count: 2, active_tab_id: "w1:t1", agent_status: "idle" }],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "old", focused: true, pane_count: 1, agent_status: "idle" },
        { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "new", focused: false, pane_count: 1, agent_status: "idle" },
      ],
      panes: [
        { pane_id: "w1:old", terminal_id: "t-old", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "codex", agent_status: "idle", revision: 1 },
        { pane_id: "w1:new", terminal_id: "t-new", workspace_id: "w1", tab_id: "w1:t2", focused: false, cwd: "/fixture", agent: "codex", agent_status: "idle", revision: 1 },
      ],
      layouts: [],
      agents: [
        { pane_id: "w1:old", agent: "codex", agent_status: "idle" },
        { pane_id: "w1:new", agent: "codex", agent_status: "idle" },
      ],
    }),
    incarnation: 3,
    connection: 5,
    epoch: 9,
    integrations,
  };
}

const rowOf = (paneID: string) => ({ paneID, status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true, kind: "codex" }) as unknown as SidebarRow;

const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;

function browser(): void {
  vi.stubGlobal("window", {
    herdrDesktop: {
      onChatUpdate: (listener: Listener) => {
        chatListener = listener;
        return () => undefined;
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => null,
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  vi.stubGlobal("document", { body: { classList: { add: () => undefined } }, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
}

const hosts: HookHost<object>[] = [];
function mount(component: unknown, props: object): HookHost<object> {
  const view = new HookHost(component as (props: object) => unknown, props);
  hosts.push(view);
  view.render();
  return view;
}

/** The pane's Chat with no session named (as the main process says it). */
function noSessionChat(paneId: string, host: HostView): HookHost<object> {
  const view = mount(ChatView, { host, row: rowOf(paneId), onShowTerminal: () => undefined });
  chatListener?.({ hostId: "mini", paneId, state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline });
  view.render();
  return view;
}

/** ChatView's integration part, drawn. */
function inner(view: HookHost<object>): unknown {
  const part = elements(view.tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === "ChatIntegration");
  expect(part, "Chat shows the integration part").toBeDefined();
  return mount(ChatIntegration, part!.props).tree;
}

beforeEach(() => {
  integrationNotes.reset();
  pendingMessages.clear();
  registered.handles.clear();
  browser();
});

afterEach(() => {
  for (const view of hosts.splice(0)) view.unmount();
  pendingMessages.clear();
  chatListener = null;
  vi.unstubAllGlobals();
});

// MARK: - a pane started after the install

describe("a pane started after the install is not told to restart", () => {
  it("Install, then New agent's Codex on the same connection: that pane is listed as started after it; the old pane is not", async () => {
    const { service, host, binding } = await world();
    expect(service.startToken("mini", "codex"), "before the install: not in place").toBeNull();
    const reply = await service.install("mini", "codex", binding());
    expect(reply.sent).toBe(true);
    await flush();
    const token = service.startToken("mini", "codex");
    expect(token).not.toBeNull();
    service.agentStarted(token!, "w1:new", "codex");
    await flush();
    expect(host().integrations?.startedAfter).toEqual({ codex: ["w1:new"] });
  });

  it("Herdr already lists the integration current when New agent starts it: the pane is listed too", async () => {
    const { service, host } = await world({ codex: "current" });
    const token = service.startToken("mini", "codex");
    expect(token).not.toBeNull();
    service.agentStarted(token!, "w1:new", "codex");
    expect(host().integrations?.startedAfter?.["codex"]).toEqual(["w1:new"]);
  });

  it("a token taken before the install (not in place) marks nothing; another kind marks nothing; a new command connection drops the token", async () => {
    const { registry, service, m, host, binding } = await world({ codex: "not_installed", claude: "current" });
    expect(service.startToken("mini", "codex")).toBeNull();
    const claude = service.startToken("mini", "claude")!;
    service.agentStarted(claude, "w1:new", "codex");
    expect(host().integrations?.startedAfter).toBeUndefined();
    await service.install("mini", "codex", binding());
    await flush();
    const token = service.startToken("mini", "codex")!;
    m.setEpoch(2);
    await registry.refresh("mini");
    await flush();
    service.agentStarted(token, "w1:new", "codex");
    await flush();
    expect(host().integrations?.startedAfter).toBeUndefined();
  });

  it("Chat for the new pane: the first-message line with Show the terminal, no steps, no Install; the older pane keeps the steps", () => {
    const shown = viewHost("current", installed, ["w1:new"]);
    const fresh = chatIntegrationLook(shown, "codex", null, false, "w1:new");
    expect(fresh?.line).toBe(firstMessage);
    expect(fresh?.button).toBeNull();
    expect(fresh?.restart).toBe(false);
    expect(fresh?.messages).toEqual([]);
    const older = chatIntegrationLook(shown, "codex", null, false, "w1:old");
    expect(older?.line).toBe(steps);
    expect(firstMessage.includes("\u2014")).toBe(false);
  });

  it("the real ChatView: the new pane says the first-message line, the older one the steps", () => {
    const shown = viewHost("current", installed, ["w1:new"]);
    const fresh = inner(noSessionChat("w1:new", shown));
    expect(texts(fresh)).toContain(firstMessage);
    expect(texts(fresh)).not.toContain(steps);
    expect(texts(fresh)).toContain("Show the terminal");
    expect(texts(fresh)).not.toContain("Install");
    const older = inner(noSessionChat("w1:old", shown));
    expect(texts(older)).toContain(steps);
    expect(texts(older)).not.toContain(firstMessage);
  });

  it("current with no install here and a pane Adari did not start after it: today's line stays (the conservative one)", () => {
    expect(chatIntegrationLook(viewHost("current", null), "codex", null, false, "w1:old")).toBeNull();
    expect(chatIntegrationLook(viewHost("current", null, ["w1:new"]), "codex", null, false, "w1:new")?.line).toBe(firstMessage);
  });

  it("New agent through the real IPC: the token is taken before anything is sent and the pane marked once its agent started; a shell or a refused start marks nothing", async () => {
    const calls: string[] = [];
    let refuse = false;
    const herdr = {
      agentList: async () => (calls.push("agent.list"), []),
      createTerminalTab: async (workspace: string) => {
        calls.push("tab.create");
        return { tab: { tabID: "w1:tn1", workspaceID: workspace }, rootPane: { paneID: "w1:pn1", workspaceID: workspace } };
      },
      startAgent: async (name: string, kind: string, pane: string) => {
        calls.push(`agent.start ${kind}`);
        if (refuse) throw new Error("refused");
        return { paneID: pane, name, agent: kind };
      },
      closePane: async () => undefined,
      sendInput: async () => undefined,
    };
    const backend = { workspaceActions: () => herdr, readStartCommandsFile: async () => null };
    const view = { id: "mini", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology: paneTopology([{ id: "w1:p1" }]) };
    const marks: string[] = [];
    registerIpc({
      hosts: {
        backend: (id: string) => (id === "mini" ? backend : null),
        list: () => [view],
        refresh: async () => undefined,
        connection: () => 1,
        connectionIdentity: () => ({ incarnation: 1, epoch: 1 }),
      },
      integrations: {
        install: () => Promise.resolve({ sent: false, note: "n" }),
        refresh: () => Promise.resolve(),
        startToken: (hostId: string, kind: string) => (calls.push(`token ${kind}`), { hostId, target: kind, read: null }),
        agentStarted: (_token: unknown, paneId: string, kind: string) => void marks.push(`${paneId} ${kind}`),
      },
    } as never);
    const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    const start = (body: unknown) => registered.handles.get(IPC.newAgent)!(event, "mini", body) as Promise<unknown>;
    await start({ workspaceId: "w1", folder: null, kind: "codex" });
    expect(calls).toEqual(["token codex", "agent.list", "tab.create", "agent.start codex"]);
    expect(marks).toEqual(["w1:pn1 codex"]);
    await start({ workspaceId: "w1", folder: null, kind: "shell" });
    refuse = true;
    await expect(start({ workspaceId: "w1", folder: null, kind: "codex" })).rejects.toThrow();
    expect(marks).toEqual(["w1:pn1 codex"]);
  });
});

// MARK: - one message for a no-session send

const user = (id: string, text: string, time: number | null): ChatItem => ({ type: "user", value: userMessage(id, text, time) });
const reply = (id: string, text: string): ChatItem => ({ type: "agentText", value: { id, markdown: text, time: null } });
const timelineOf = (...turns: ChatItem[][]): ChatTimeline => ({ ...emptyTimeline, turns: turns.map((items, index) => makeTurn(`t${index}`, { items, isFinished: true })) });
const key = "mini/w1:p1";
const noSessionScope = { terminalID: "term", session: null };
const adopted = new Map([[key, { terminalID: "term", session: sessionId }]]);

describe("one message, not two", () => {
  it("a no-session send, then a session whose first transcript holds it: the bubble settles into the transcript's message, no note", () => {
    const store = new PendingMessages();
    const now = Date.now();
    const id = store.add(key, "Reply with exactly: hello from chat", now, noSessionScope);
    store.delivered(id);
    expect(store.forPane(key)[0]!.state).toBe("terminalOnly");
    store.reconcile(adopted, () => true);
    store.observe(key, timelineOf([user("u1", "Reply with exactly: hello from chat", now / 1_000 + 1), reply("a1", "hello from chat")]));
    expect(store.forPane(key)).toEqual([]);
    expect(store.droppedFor(key)).toBe(0);
  });

  it("the same while Herdr has not answered the send yet (still Sending): one message", () => {
    const store = new PendingMessages();
    const now = Date.now();
    store.add(key, "hello", now, noSessionScope);
    // Strictly after the send; equal time is no proof.
    store.observe(key, timelineOf([user("u1", "hello", now / 1_000 + 0.1)]));
    expect(store.forPane(key)).toEqual([]);
  });

  it("an older identical message in the session's history never settles the new send", () => {
    const store = new PendingMessages();
    const now = Date.now();
    const id = store.add(key, "hello", now, noSessionScope);
    store.delivered(id);
    store.reconcile(adopted, () => true);
    store.observe(key, timelineOf([user("u0", "hello", now / 1_000 - 3_600), reply("a0", "hi")]));
    expect(store.forPane(key).map((bubble) => bubble.state)).toEqual(["terminalOnly"]);
    // Nor one typed seconds before it (the existing baseline rule's case: 5 s earlier, inside the clock slack).
    const close = new PendingMessages();
    close.delivered(close.add(key, "yes", now, noSessionScope));
    close.reconcile(adopted, () => true);
    close.observe(key, timelineOf([user("u0", "yes", now / 1_000 - 5)]));
    expect(close.forPane(key)).toHaveLength(1);
    // It still settles into its own message when a later transcript shows it.
    store.observe(key, timelineOf([user("u0", "hello", now / 1_000 - 3_600), reply("a0", "hi")], [user("u1", "hello", now / 1_000 + 2)]));
    expect(store.forPane(key)).toEqual([]);
  });

  it("a message with no time, another text, or other attachments in the first transcript does not settle it", () => {
    const store = new PendingMessages();
    const now = Date.now();
    store.delivered(store.add(key, "hello", now, noSessionScope));
    store.reconcile(adopted, () => true);
    store.observe(key, timelineOf([user("u0", "hello", null)], [user("u1", "hello there", now / 1_000)]));
    expect(store.forPane(key)).toHaveLength(1);
    expect(store.forPane(key)[0]!.state).toBe("terminalOnly");
  });

  it("a send made with a session keeps today's baseline rule (the first transcript after it is its baseline)", () => {
    const store = new PendingMessages();
    const now = Date.now();
    store.delivered(store.add(key, "hello", now, { terminalID: "term", session: sessionId }));
    store.observe(key, timelineOf([user("u1", "hello", now / 1_000)]));
    expect(store.forPane(key).map((bubble) => bubble.state)).toEqual(["sent"]);
  });

  it("a send Herdr refused leaves no bubble, as today", () => {
    const store = new PendingMessages();
    const id = store.add(key, "hello", Date.now(), noSessionScope);
    store.failed(id);
    expect(store.forPane(key)).toEqual([]);
  });

  it("the page's store: after the settle no Sent to the terminal label is left", () => {
    const now = Date.now();
    pendingMessages.delivered(pendingMessages.add(key, "Reply with exactly: hello from chat", now, noSessionScope));
    pendingMessages.reconcile(adopted, () => true);
    pendingMessages.observe(key, timelineOf([user("u1", "Reply with exactly: hello from chat", now / 1_000 + 0.1), reply("a1", "hello from chat")]));
    expect(pendingMessages.forPane(key).filter((bubble) => bubble.state === "terminalOnly")).toEqual([]);
    expect(terminalOnlyLabel).not.toContain("\u2014");
  });
});

// MARK: - a fresh read after Installed

describe("a fresh read that says missing after Installed brings Install back", () => {
  it("on the same connection, Settings' fresh read says not installed: the Installed outcome goes and Chat's Install button is back", async () => {
    const { service, m, host, binding } = await world();
    await service.install("mini", "codex", binding());
    await flush();
    expect(host().integrations?.outcomes["codex"]?.phase).toBe("installed");
    m.states.set("codex", "not_installed");
    await service.refresh();
    await flush();
    expect(host().integrations?.outcomes["codex"]).toBeUndefined();
    const look = chatIntegrationLook(host(), "codex", null, false, "w1:old");
    expect(look?.line).toBe("Chat needs Herdr's Codex integration on Mac mini, and it is not installed.");
    expect(look?.button).toEqual({ label: "Install", disabled: false });
  });

  it("out of date on the fresh read: Update is back; the panes marked as started after it are no longer so", async () => {
    const { service, m, host, binding } = await world();
    await service.install("mini", "codex", binding());
    await flush();
    service.agentStarted(service.startToken("mini", "codex")!, "w1:new", "codex");
    m.states.set("codex", "outdated");
    await service.refresh();
    await flush();
    expect(host().integrations?.startedAfter).toBeUndefined();
    expect(chatIntegrationLook(host(), "codex", null, false, "w1:new")?.button).toEqual({ label: "Update", disabled: false });
  });

  it("a list asked before the install ended (still out) does not undo it: Installed stays until a later read", async () => {
    const { service, m, host, binding } = await world();
    const release = m.holdLists();
    const early = service.refresh();
    // The early read is out with Herdr's answer from before the install (not installed).
    await flush();
    const done = service.install("mini", "codex", binding());
    await flush();
    release();
    await early;
    await done;
    await flush();
    expect(host().integrations?.outcomes["codex"]?.phase).toBe("installed");
    expect(host().integrations?.items.find((entry) => entry.target === "codex")?.state).toBe("current");
  });
});
