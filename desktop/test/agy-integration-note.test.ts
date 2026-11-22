// Antigravity CLI in Chat with Herdr's integration for it missing: the state of a
// machine where agy was signed in and opened but `herdr integration install antigravity-cli` never ran (Herdr
// 0.9.5's integration.list answers `antigravity_cli` as not_installed with `available: false`, because Herdr's
// server does not see agy's command; agent.get names no session). Chat's no-session state must say the
// integration is missing, with Install, also after a message was sent from Chat, and after an install the
// existing lines. A real HostRegistry and IntegrationService over a real HerdrClient and a fake Herdr (the request
// lines are what would go on the socket), then the real ChatView on the small hooks host. No Herdr, no socket.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { IntegrationService } from "../src/main/integrations";
import { emptyTimeline } from "../src/shared/chat/model";
import { terminalOnlyLabel } from "../src/shared/chat/pending";
import type { HostView } from "../src/shared/ipc-contract";
import { integrationTargets } from "../src/shared/integrations";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView, PendingBubble } = await import("../src/renderer/chat/ChatView");
const { ChatIntegration, integrationNotes } = await import("../src/renderer/components/integrations");
const { pendingMessages, pendingBackstop } = await import("../src/renderer/chat/chat-state");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** One agy pane Herdr names no session for (agent.get: `agent: "agy"`, no agent_session), as the samples show. */
const topology = decodeSessionTopology({
  version: "0.9.5",
  protocol: 22,
  workspaces: [{ workspace_id: "w1", number: 1, label: "demo", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
  panes: [{ pane_id: "w1:p1", terminal_id: "term_1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/tmp/demo/work", agent: "agy", agent_status: "idle", revision: 0 }],
  layouts: [],
  agents: [{ pane_id: "w1:p1", agent: "agy", agent_status: "idle", cwd: "/tmp/demo/work" }],
});

/** Herdr 0.9.5's integration.list on such a machine: every target, agy's as the samples read it. */
function list(agy: string) {
  return {
    type: "integration_list",
    integrations: integrationTargets.map((target) =>
      target === "antigravity_cli"
        ? { target, label: "antigravity-cli", command: "agy", available: false, state: agy }
        : { target, label: target, command: target, available: target === "claude", state: target === "claude" ? "current" : "not_installed" },
    ),
  };
}

function machine() {
  let agy = "not_installed";
  let available = false;
  let epoch = 1;
  /** Replaces Herdr's list reply (a throw is Herdr's error); null: the reply above. */
  let override: (() => unknown) | null = null;
  /** Runs when the list request goes (a new command connection opened for it, say). */
  let onList: () => void = () => undefined;
  const requests: string[] = [];
  const client = new HerdrClient({
    roundTrip: async (line: string) => {
      const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
      requests.push(request.method);
      if (request.method === "integration.install") {
        agy = "current";
        return JSON.stringify({ id: request.id, result: { type: "integration_install", target: "antigravity_cli", details: { messages: ["Installed the antigravity-cli hook."] } } });
      }
      onList();
      if (override !== null) return JSON.stringify({ id: request.id, result: override() });
      const reply = list(agy);
      if (available) for (const entry of reply.integrations) if (entry.target === "antigravity_cli") entry.available = true;
      return JSON.stringify({ id: request.id, result: reply });
    },
    close: () => undefined,
  });
  const backend = { kind: "herdr-tui" as const, snapshot: () => Promise.resolve(topology), connectionEpoch: () => epoch, integrations: () => client, close: () => undefined };
  return {
    descriptor: { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fixture@mini", platform: "macOS" },
    backend,
    requests,
    setAvailable: (value: boolean) => (available = value),
    setReply: (next: (() => unknown) | null) => (override = next),
    setOnList: (next: () => void) => (onList = next),
    setEpoch: (value: number) => (epoch = value),
  };
}

const registries: HostRegistry[] = [];

async function connected(m = machine()) {
  let service: IntegrationService | null = null;
  const registry = new HostRegistry(() => service?.hostsChanged());
  registries.push(registry);
  service = new IntegrationService(registry);
  registry.add(m.descriptor, m.backend as never);
  await registry.refresh(m.descriptor.id);
  await flush();
  const host = (): HostView => registry.list().find((entry) => entry.id === m.descriptor.id)!;
  return { registry, service: service!, host };
}

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;
const deliver = (event: unknown): void => chatListener!(event);
let unmount: (() => void) | null = null;

function chat(view: HostView) {
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
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  const v = new HookHost(ChatView as (props: object) => unknown, { host: view, row, onShowTerminal: () => undefined });
  v.render();
  unmount = () => v.unmount();
  return v;
}

const row = { paneID: "w1:p1", status: "idle", name: "agy", workspaceLabel: "demo", isAgent: true, kind: "agy" } as unknown as SidebarRow;
const key = "mini/w1:p1";
const noSession = { hostId: "mini", paneId: "w1:p1", state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline };
const byName = (tree: unknown, name: string) => elements(tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });

/** The view with a message already sent from Chat (Herdr took it; no session: Sent to the terminal). */
function withSentMessage(view: HostView) {
  pendingBackstop.stop(key);
  const v = chat(view);
  deliver(noSession);
  const id = pendingMessages.add(key, "Read notes.txt and tell me its second line.", Date.now());
  pendingMessages.delivered(id);
  v.render();
  v.render();
  return v;
}

beforeEach(() => integrationNotes.reset());
afterEach(() => {
  unmount?.();
  unmount = null;
  pendingMessages.clear();
  pendingBackstop.stop(key);
  vi.unstubAllGlobals();
  for (const registry of registries.splice(0)) registry.close();
});

describe("Antigravity CLI with Herdr's integration not installed (no session named)", () => {
  it("main: the machine's view lists antigravity_cli as not installed, unavailable, read on the machine's connection", async () => {
    const { host } = await connected();
    const item = host().integrations?.items.find((candidate) => candidate.target === "antigravity_cli");
    expect(item).toEqual({ target: "antigravity_cli", kind: "agy", name: "Antigravity CLI", state: "not_installed", available: false });
    expect(host().integrations?.epoch).toBe(host().epoch);
  });

  it("Chat shows the note with Install, also after a message was sent, and the sent line does not hide it", async () => {
    const { host } = await connected();
    const view = withSentMessage(host());
    const part = byName(view.tree, "ChatIntegration");
    expect(part?.props["look"]).toMatchObject({ line: "Chat needs Herdr's Antigravity CLI integration on Mac mini, and it is not installed.", button: { label: "Install", disabled: false } });
    const inner = new HookHost(ChatIntegration as (props: object) => unknown, part!.props);
    inner.render();
    expect(elements(inner.tree).filter((element) => element.type === "button").map((button) => button.props["children"])).toContain("Install");
    expect(byName(view.tree, "ChatUnavailableLine")).toBeUndefined();
    expect(texts(view.tree).join(" ")).not.toContain("Herdr names no session for this agent yet");
    // The sent message's line stays its own, under the note: Sent to the terminal.
    const bubble = byName(view.tree, "PendingBubble")!;
    const shown = new HookHost(PendingBubble as (props: object) => unknown, bubble.props);
    shown.render();
    expect(texts(shown.tree)).toContain(terminalOnlyLabel);
    // Antigravity CLI is first class: no Early line.
    expect(texts(view.tree).join(" ")).not.toContain("Chat for Antigravity CLI is early");
  });

  it("the same with available true", async () => {
    const m = machine();
    m.setAvailable(true);
    const { host } = await connected(m);
    const view = withSentMessage(host());
    expect(byName(view.tree, "ChatIntegration")?.props["look"]).toMatchObject({ button: { label: "Install" } });
  });

  it("after a successful install: the existing lines (the steps, no Install), never the not-installed note", async () => {
    const { service, host } = await connected();
    const reply = await service.install("mini", "antigravity_cli", { incarnation: host().incarnation!, connection: host().connection!, epoch: host().epoch ?? null });
    expect(reply.sent).toBe(true);
    await flush();
    expect(host().integrations?.items.find((item) => item.target === "antigravity_cli")?.state).toBe("current");
    const view = withSentMessage(host());
    const look = byName(view.tree, "ChatIntegration")?.props["look"] as { line: string; button: unknown } | undefined;
    expect(look?.line).toBe("Installed. To use it, quit Antigravity CLI in its terminal when it is done, then start it again with New agent.");
    expect(look?.button).toBeNull();
  });
});

// The reported state (an agy pane, no session, the integration not installed, a message sent) does not reproduce
// from these inputs (above: the note shows). Each way below is one by which a machine reached over SSH can have
// no `host.integrations` for agy, or none Chat shows: each leaves Chat on its plain no-session line, as seen.
// Characterised here as they are; none is changed on a guess (the report lists them).
describe("every way the note can be missing for a machine reached over SSH (as they are)", () => {
  const lookOf = (view: HostView) => byName(withSentMessage(view).tree, "ChatIntegration");

  it("1. Herdr answers integration.list with an error (an older Herdr, a refusal): nothing shown, never asked again on that connection", async () => {
    const m = machine();
    m.setReply(() => {
      throw new Error("unknown method");
    });
    const { host, registry } = await connected(m);
    expect(host().integrations).toBeUndefined();
    expect(lookOf(host())).toBeUndefined();
    await registry.refresh("mini");
    await flush();
    expect(m.requests.filter((method) => method === "integration.list")).toHaveLength(1);
  });

  it("2. one entry of the list that does not decode (any target's, not agy's) loses the whole list on that connection", async () => {
    const m = machine();
    m.setReply(() => ({ type: "integration_list", integrations: [...list("not_installed").integrations, { target: "future", label: "future", command: ["x"], available: true, state: "current" }] }));
    const { host } = await connected(m);
    expect(host().integrations).toBeUndefined();
    expect(lookOf(host())).toBeUndefined();
  });

  it("3. a state word Herdr 0.9.5's schema does not have, or another spelling of the target, leaves agy out", async () => {
    for (const entry of [
      { target: "antigravity_cli", label: "antigravity-cli", command: "agy", available: false, state: "missing" },
      { target: "antigravity-cli", label: "antigravity-cli", command: "agy", available: false, state: "not_installed" },
    ]) {
      const m = machine();
      m.setReply(() => ({ type: "integration_list", integrations: [entry] }));
      const { host } = await connected(m);
      expect(host().integrations?.items.some((item) => item.target === "antigravity_cli")).toBe(false);
      expect(lookOf(host())).toBeUndefined();
      unmount?.();
      unmount = null;
      pendingMessages.clear();
    }
  });

  it("4. the command connection changed between the snapshot and the list request: the reply is dropped and the list stays unread until a snapshot comes on the new one", async () => {
    const m = machine();
    m.setOnList(() => m.setEpoch(2));
    const { host, registry } = await connected(m);
    expect(host().integrations).toBeUndefined();
    expect(lookOf(host())).toBeUndefined();
    // The next snapshot (on epoch 2) reads it again: the note shows then.
    m.setOnList(() => undefined);
    await registry.refresh("mini");
    await flush();
    expect(host().integrations?.items.find((item) => item.target === "antigravity_cli")?.state).toBe("not_installed");
  });

  it("5. a backend with no integration calls (herdr-core) is never asked", async () => {
    const m = machine();
    const bare = { ...m.backend } as Record<string, unknown>;
    delete bare["integrations"];
    let service: IntegrationService | null = null;
    const registry = new HostRegistry(() => service?.hostsChanged());
    registries.push(registry);
    service = new IntegrationService(registry);
    registry.add(m.descriptor, bare as never);
    await registry.refresh("mini");
    await flush();
    expect(m.requests).toEqual([]);
    expect(registry.list()[0]!.integrations).toBeUndefined();
  });

  it("6. until the first list reply comes on the connection, or while the machine is not connected (the launch cache's topology), there is none", async () => {
    const m = machine();
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const original = m.backend.integrations;
    const slow = { ...m.backend, integrations: () => ({ integrationList: async () => { await gate; return original().integrationList(); }, integrationInstall: (target: string) => original().integrationInstall(target) }) };
    let service: IntegrationService | null = null;
    const registry = new HostRegistry(() => service?.hostsChanged());
    registries.push(registry);
    service = new IntegrationService(registry);
    registry.add(m.descriptor, slow as never);
    await registry.refresh("mini");
    await flush();
    expect(registry.list()[0]!.integrations).toBeUndefined();
    release();
    await flush();
    expect(registry.list()[0]!.integrations?.items.some((item) => item.target === "antigravity_cli")).toBe(true);
  });
});
