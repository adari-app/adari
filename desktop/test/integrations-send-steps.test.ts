// Integrations in Chat: a send made with no usable session is
// classified from that fact as it went, so neither Chat loading, being
// switched away nor a session named before Chat's next effect can turn it
// Not sent; after an install where Restart cannot run, Chat gives the steps
// with Show the terminal instead of a greyed Restart; Herdr's real install
// lines reach Chat as text. The real views on the small hooks host with a fake
// bridge; a fake Herdr behind a real HerdrClient. No main process window, no
// real Herdr, no socket, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { IntegrationService } from "../src/main/integrations";
import { emptyTimeline } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import { integrationName, type HostIntegrations, type IntegrationItem, type IntegrationOutcome } from "../src/shared/integrations";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { notSentLabel, PendingBackstop, pendingLabel, terminalOnlyLabel } from "../src/shared/chat/pending";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView, PendingBubble } = await import("../src/renderer/chat/ChatView");
const { ChatIntegration, chatIntegrationLook, integrationNotes } = await import("../src/renderer/components/integrations");
const { pendingMessages, pendingBackstop, sendWithPending } = await import("../src/renderer/chat/chat-state");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

const sessionId = "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84";

/** One agent pane of `kind` (Herdr names `session` for it, or none), idle unless `status` says. */
function topology(kind = "codex", session: string | null = null, status = "idle") {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: status }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: status }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: kind, agent_status: status, revision: 1 }],
    layouts: [],
    agents: [
      {
        pane_id: "w1:p1",
        agent: kind,
        agent_status: status,
        ...(session === null ? {} : { agent_session: { source: `herdr:${kind}`, agent: kind, kind: "id", value: session } }),
      },
    ],
  });
}

const item = (target: string, state: IntegrationItem["state"]): IntegrationItem => ({ target, kind: target, name: integrationName(target), state, available: true });

function host(kind: string, state: IntegrationItem["state"], outcome: IntegrationOutcome | null, session: string | null = null, status = "idle"): HostView {
  const integrations: HostIntegrations = { incarnation: 3, connection: 5, epoch: 9, items: [item(kind, state)], outcomes: outcome === null ? {} : { [kind]: outcome } };
  return {
    id: "mini",
    name: "Mac mini",
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    topology: topology(kind, session, status),
    incarnation: 3,
    connection: 5,
    epoch: 9,
    integrations,
  };
}

const rowOf = (kind: string) => ({ paneID: "w1:p1", status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true, kind }) as unknown as SidebarRow;
const key = "mini/w1:p1";

const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });
const buttons = (tree: unknown) => elements(tree).filter((element) => element.type === "button");
const labels = (tree: unknown) => buttons(tree).map((button) => button.props["children"]);
const byName = (tree: unknown, name: string) =>
  elements(tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;

function browser(bridge: Record<string, unknown> = {}): void {
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
      ...bridge,
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

beforeEach(() => {
  integrationNotes.reset();
  pendingMessages.clear();
  browser();
});

afterEach(() => {
  for (const view of hosts.splice(0)) view.unmount();
  pendingBackstop.stop(key);
  pendingMessages.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A backstop on the page's bubbles whose timers the test runs. */
function backstop() {
  const timers: (() => void)[] = [];
  const stop = new PendingBackstop(
    pendingMessages,
    (run) => {
      timers.push(run);
      return run;
    },
    (timer) => {
      const at = timers.indexOf(timer as () => void);
      if (at >= 0) timers.splice(at, 1);
    },
  );
  return { stop, timers };
}

const accepted = () => Promise.resolve();
const noSessionScope = { terminalID: "term", session: null };

describe("a send made with no usable session is never tappable Not sent", () => {
  it("switched away during the send, then a session named before Chat's next effect: still Sent to the terminal", async () => {
    const { stop, timers } = backstop();
    await sendWithPending(accepted, "mini", "w1:p1", "hello codex", true, noSessionScope);
    // Chat comes back with a session now named, and its effect says there is a session.
    pendingMessages.reconcile(new Map([[key, { terminalID: "term", session: sessionId }]]), () => true);
    pendingMessages.observe(key, emptyTimeline);
    stop.watch(key, "idle", () => Promise.resolve(false), false);
    for (const run of timers.splice(0)) run();
    await flush();
    const [bubble] = pendingMessages.forPane(key);
    expect(bubble!.state).toBe("terminalOnly");
    expect(pendingLabel(bubble!, false, Date.now())).toBe(terminalOnlyLabel);
    expect(pendingMessages.takeNotSent(bubble!.id)).toBeNull();
    stop.stop(key);
  });

  it("Chat still loading when it was taken (its effect says nothing of no session): never Not sent", async () => {
    const { stop, timers } = backstop();
    await sendWithPending(accepted, "mini", "w1:p1", "hello codex", true, noSessionScope);
    stop.watch(key, "idle", () => Promise.resolve(false), false);
    expect(timers).toEqual([]);
    expect(pendingMessages.forPane(key)[0]!.state).toBe("terminalOnly");
    expect(pendingMessages.markNotSent(key)).toBe(false);
    stop.stop(key);
  });

  it("the real ChatView, loading for 7 s after the send (past the 5 s backstop): the bubble reads Sent to the terminal, not tappable", async () => {
    vi.useFakeTimers();
    const view = mount(ChatView, { host: host("codex", "current", null), row: rowOf("codex"), onShowTerminal: () => undefined });
    await sendWithPending(accepted, "mini", "w1:p1", "Run the release checklist once more, please.", true, noSessionScope);
    view.render();
    view.render();
    vi.advanceTimersByTime(7_000);
    await flush();
    view.render();
    expect(pendingMessages.forPane(key)[0]!.state).toBe("terminalOnly");
    const bubble = byName(view.tree, "PendingBubble");
    expect(bubble, "the loading Chat shows the bubble").toBeDefined();
    if (bubble !== undefined) {
      const inner = mount(PendingBubble, bubble.props);
      const root = elements(inner.tree)[0]!;
      expect(root.props["onClick"]).toBeUndefined();
      expect(texts(inner.tree)).toContain(terminalOnlyLabel);
    }
  });

  it("a send Herdr refused: the rejection, no bubble, nothing marked", async () => {
    await expect(sendWithPending(() => Promise.reject(new Error("Herdr refused")), "mini", "w1:p1", "hello", true, noSessionScope)).rejects.toThrow("Herdr refused");
    expect(pendingMessages.forPane(key)).toEqual([]);
  });

  it("a send made with a session keeps the idle backstop: idle 5 s, nothing queued, Not sent", async () => {
    const { stop, timers } = backstop();
    await sendWithPending(accepted, "mini", "w1:p1", "hello codex", true, { terminalID: "term", session: sessionId });
    expect(pendingMessages.forPane(key)[0]!.state).toBe("sent");
    stop.watch(key, "idle", () => Promise.resolve(false), false);
    expect(timers).toHaveLength(1);
    timers[0]!();
    await flush();
    expect(pendingMessages.forPane(key)[0]!.state).toBe("notSent");
    expect(pendingLabel(pendingMessages.forPane(key)[0]!, false, Date.now())).toBe(notSentLabel);
  });

  it("a send while Chat shows the pane's transcript live (a folder-followed agent Herdr names no session for) keeps the idle backstop", async () => {
    const { stop, timers } = backstop();
    pendingMessages.observe(key, emptyTimeline, true);
    await sendWithPending(accepted, "mini", "w1:p1", "hello grok", true, noSessionScope);
    expect(pendingMessages.forPane(key)[0]!.state).toBe("sent");
    stop.watch(key, "idle", () => Promise.resolve(false), false);
    expect(timers).toHaveLength(1);
    stop.stop(key);
  });

  it("while it is still going it says Sending; once Herdr takes it, Sent to the terminal", async () => {
    let take!: () => void;
    const going = sendWithPending(() => new Promise<void>((done) => (take = done)), "mini", "w1:p1", "hello", true, noSessionScope);
    expect(pendingMessages.forPane(key)[0]!.state).toBe("sending");
    take();
    await going;
    expect(pendingMessages.forPane(key)[0]!.state).toBe("terminalOnly");
  });
});

const installedOutcome = (kind: string, messages: readonly string[] = ["Installed the hook.", "<b>Restart</b> the agent."]): IntegrationOutcome => ({
  phase: "installed",
  text: `Installed. Restart ${integrationName(kind)} so it uses it.`,
  messages,
  action: "install",
});

describe("a way forward after Install", () => {
  it("no session id to resume (the usual fresh install): the steps naming the agent, Show the terminal, no greyed Restart", () => {
    const view = host("codex", "current", installedOutcome("codex"));
    const look = chatIntegrationLook(view, "codex", null)!;
    expect(look.line).toBe("Installed. To use it, quit Codex in its terminal when it is done, then start it again with New agent.");
    expect(look.restart).toBe(false);
    const part = mount(ChatIntegration, { host: view, row: rowOf("codex"), look, onShowTerminal: () => undefined });
    expect(labels(part.tree)).toEqual(["Show the terminal"]);
    expect(texts(part.tree)).toEqual(expect.arrayContaining([look.line, "Installed the hook.", "<b>Restart</b> the agent."]));
    expect(texts(part.tree).join(" ")).not.toContain("No session id known to resume");
  });

  it("ChatView, a no-session Codex pane after Install: the steps, not a greyed Restart", () => {
    const view = mount(ChatView, { host: host("codex", "current", installedOutcome("codex")), row: rowOf("codex"), onShowTerminal: () => undefined });
    chatListener!({ hostId: "mini", paneId: "w1:p1", state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline });
    view.render();
    const part = byName(view.tree, "ChatIntegration")!;
    const inner = mount(ChatIntegration, part.props);
    expect(texts(inner.tree)).toContain("Installed. To use it, quit Codex in its terminal when it is done, then start it again with New agent.");
    expect(labels(inner.tree)).toEqual(["Show the terminal"]);
  });

  it("a kind with no resume-based Restart gets the steps too, naming that agent", () => {
    const view = mount(ChatView, { host: host("pi", "current", installedOutcome("pi"), sessionId), row: rowOf("pi"), onShowTerminal: () => undefined });
    chatListener!({ hostId: "mini", paneId: "w1:p1", state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline });
    view.render();
    const part = byName(view.tree, "ChatIntegration")!;
    expect(part.props["look"]).toMatchObject({ line: `Installed. To use it, quit ${integrationName("pi")} in its terminal when it is done, then start it again with New agent.`, restart: false });
    const inner = mount(ChatIntegration, part.props);
    expect(labels(inner.tree)).toEqual(["Show the terminal"]);
  });

  it("where Restart can work (a Codex session id Herdr names), the existing Restart shows, enabled, and runs only on a click", () => {
    const calls: unknown[][] = [];
    browser({ restartAgent: (...args: unknown[]) => (calls.push(args), Promise.resolve(null)) });
    const view = host("codex", "current", installedOutcome("codex"), sessionId);
    const look = chatIntegrationLook(view, "codex", null, true)!;
    expect(look.line).toBe("Installed. Restart Codex so it uses it.");
    expect(look.restart).toBe(true);
    const part = mount(ChatIntegration, { host: view, row: rowOf("codex"), look, onShowTerminal: () => undefined });
    expect(labels(part.tree)).toEqual(["Restart", "Show the terminal"]);
    const restart = buttons(part.tree).find((button) => button.props["children"] === "Restart")!;
    expect(restart.props["disabled"]).toBe(false);
    expect(calls).toEqual([]);
  });

  it("ChatView decides it from the pane: a Codex pane whose session id Herdr names gets Restart", () => {
    const view = mount(ChatView, { host: host("codex", "current", installedOutcome("codex"), sessionId), row: rowOf("codex"), onShowTerminal: () => undefined });
    chatListener!({ hostId: "mini", paneId: "w1:p1", state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline });
    view.render();
    const part = byName(view.tree, "ChatIntegration")!;
    expect(part.props["look"]).toMatchObject({ line: "Installed. Restart Codex so it uses it.", restart: true });
  });

  it("no em dash in any of it", () => {
    const look = chatIntegrationLook(host("claude", "current", installedOutcome("claude")), "claude", null)!;
    expect(look.line).toBe("Installed. To use it, quit Claude Code in its terminal when it is done, then start it again with New agent.");
    expect(look.line).not.toContain("—");
  });
});

describe("Herdr's real install lines reach Chat", () => {
  it("round trip: fake Herdr (details.messages) through HerdrClient, the service and the registry to Chat's lines, as text", async () => {
    let epoch = 1;
    const requests: string[] = [];
    let state = "not_installed";
    const client = new HerdrClient({
      roundTrip: (line: string) => {
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
        requests.push(request.method);
        if (request.method === "integration.list") {
          return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "integration_list", integrations: [{ target: "codex", label: "Codex", command: "codex", available: true, state }] } }));
        }
        state = "current";
        const details = { messages: ["Wrote Codex hooks to the fixture folder.", "<i>Restart</i> Codex to load them.\u0007"] };
        return Promise.resolve(JSON.stringify({ id: request.id, result: { type: "integration_install", target: request.params["target"], details } }));
      },
      close: () => undefined,
    });
    const backend = { kind: "herdr-tui", snapshot: () => Promise.resolve(topology("codex")), connectionEpoch: () => epoch, integrations: () => client, close: () => undefined };
    let service: IntegrationService | null = null;
    const registry = new HostRegistry(() => service?.hostsChanged());
    service = new IntegrationService(registry);
    registry.add({ id: "mini", name: "Mac mini", kind: "ssh", address: "fixture@mini", platform: "macOS" }, backend as never);
    await registry.refresh("mini");
    await flush();
    const view = (): HostView => registry.list()[0]!;
    expect(chatIntegrationLook(view(), "codex", null)?.button?.label).toBe("Install");
    const reply = await service.install("mini", "codex", { incarnation: view().incarnation!, connection: view().connection!, epoch: view().epoch ?? null });
    await flush();
    expect(reply.sent).toBe(true);
    expect(requests).toEqual(["integration.list", "integration.install", "integration.list"]);
    const look = chatIntegrationLook(view(), "codex", null)!;
    expect(look.messages).toEqual(["Wrote Codex hooks to the fixture folder.", "<i>Restart</i> Codex to load them."]);
    const part = mount(ChatIntegration, { host: view(), row: rowOf("codex"), look, onShowTerminal: () => undefined });
    expect(texts(part.tree)).toEqual(expect.arrayContaining(["Wrote Codex hooks to the fixture folder.", "<i>Restart</i> Codex to load them."]));
    expect(elements(part.tree).some((element) => "dangerouslySetInnerHTML" in element.props)).toBe(false);
    epoch = 2;
    registry.close();
  });
});
