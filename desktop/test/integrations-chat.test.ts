// Chat's no-session state names a missing
// or old Herdr integration with Install or Update (src/renderer/components/
// integrations.tsx, src/renderer/chat/ChatView.tsx), and a send with no session
// is never called Not sent (src/shared/chat/pending.ts). The real views on the
// small hooks host with a fake bridge; no main process, no Herdr.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { emptyTimeline } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import type { HostIntegrations, IntegrationItem, IntegrationOutcome } from "../src/shared/integrations";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { notSentLabel, PendingBackstop, PendingMessages, pendingLabel, placePending, terminalOnlyLabel } from "../src/shared/chat/pending";
import { timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView, PendingBubble } = await import("../src/renderer/chat/ChatView");
const { ChatIntegration, chatIntegrationLook, integrationNotes } = await import("../src/renderer/components/integrations");
const { pendingMessages, pendingBackstop } = await import("../src/renderer/chat/chat-state");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;
const deliver = (event: unknown): void => chatListener!(event);

function browser(bridge: Record<string, unknown>): void {
  vi.stubGlobal("window", {
    herdrDesktop: bridge,
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

/** A Codex pane Herdr names no session for (`session`: one it names). */
function topology(session: string | null = null) {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "codex", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [
      {
        pane_id: "w1:p1",
        agent: "codex",
        agent_status: "idle",
        ...(session === null ? {} : { agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: session } }),
      },
    ],
  });
}

const item = (target: string, state: IntegrationItem["state"], name: string, kind = target): IntegrationItem => ({ target, kind, name, state, available: true });

function integrations(codex: IntegrationItem["state"], outcomes: Record<string, IntegrationOutcome> = {}): HostIntegrations {
  return { incarnation: 3, connection: 5, epoch: 9, items: [item("claude", "current", "Claude Code"), item("codex", codex, "Codex")], outcomes };
}

function host(codex: IntegrationItem["state"] | null, outcomes: Record<string, IntegrationOutcome> = {}, session: string | null = null): HostView {
  return {
    id: "mini",
    name: "Mac mini",
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    topology: topology(session),
    incarnation: 3,
    connection: 5,
    epoch: 9,
    ...(codex === null ? {} : { integrations: integrations(codex, outcomes) }),
  };
}

const row = { paneID: "w1:p1", status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true, kind: "codex" } as unknown as SidebarRow;
const key = "mini/w1:p1";

const byName = (tree: unknown, name: string) =>
  elements(tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });
const buttons = (tree: unknown) => elements(tree).filter((element) => element.type === "button");

let unmount: (() => void) | null = null;

beforeEach(() => {
  integrationNotes.reset();
});

afterEach(() => {
  unmount?.();
  unmount = null;
  pendingMessages.clear();
  vi.unstubAllGlobals();
});

function chat(view: HostView, bridge: Record<string, unknown> = {}) {
  browser({
    onChatUpdate: (listener: Listener) => {
      chatListener = listener;
      return () => undefined;
    },
    openChat: () => undefined,
    closeChat: () => undefined,
    setChatFollowing: () => undefined,
    copyText: () => undefined,
    ...bridge,
  });
  const v = new HookHost(ChatView as (props: object) => unknown, { host: view, row, onShowTerminal: () => undefined });
  v.render();
  unmount = () => v.unmount();
  return v;
}

const noSession = { hostId: "mini", paneId: "w1:p1", state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline };

describe("Chat's no-session state names the missing integration", () => {
  it("not installed: the line says so with the machine, and Install", () => {
    const look = chatIntegrationLook(host("not_installed"), "codex", null)!;
    expect(look.line).toBe("Chat needs Herdr's Codex integration on Mac mini, and it is not installed.");
    expect(look.button).toEqual({ label: "Install", disabled: false });
    expect(look.restart).toBe(false);
  });

  it("out of date: says Herdr can update it, and Update", () => {
    const look = chatIntegrationLook(host("outdated"), "codex", null)!;
    expect(look.line).toBe("Chat needs Herdr's Codex integration on Mac mini, and it is out of date (Herdr can update it).");
    expect(look.button?.label).toBe("Update");
  });

  it("current, or no list, or a kind not shown: today's line (no look)", () => {
    expect(chatIntegrationLook(host("current"), "codex", null)).toBeNull();
    expect(chatIntegrationLook(host(null), "codex", null)).toBeNull();
    expect(chatIntegrationLook(host("not_installed"), "devin", null)).toBeNull();
    expect(chatIntegrationLook(host("not_installed"), null, null)).toBeNull();
  });

  it("ChatView shows it in place of today's line for a no-session Codex pane, with Show the terminal", () => {
    const view = chat(host("not_installed"));
    deliver(noSession);
    const part = byName(view.tree, "ChatIntegration");
    expect(part?.props["look"]).toMatchObject({ line: "Chat needs Herdr's Codex integration on Mac mini, and it is not installed." });
    const inner = new HookHost(ChatIntegration as (props: object) => unknown, part!.props);
    inner.render();
    expect(buttons(inner.tree).map((button) => button.props["children"])).toEqual(["Install", "Show the terminal"]);
    expect(texts(view.tree).join(" ")).not.toContain("Herdr names no session for this agent yet");
    expect(byName(view.tree, "ChatUnavailableLine")).toBeUndefined(); // the line lives in this element
  });

  it("ChatView keeps its no-session line (with its Codex sentence) while the integration is current", () => {
    const view = chat(host("current"));
    deliver(noSession);
    expect(byName(view.tree, "ChatIntegration")).toBeUndefined();
    // The line is ChatUnavailableLine's (it keeps --no-daemon on one line).
    const line = (byName(view.tree, "ChatUnavailableLine")?.props["line"] as string | undefined) ?? "";
    expect(line.startsWith("Herdr names no session for this agent yet")).toBe(true);
    expect(line).toContain("Codex");
  });

  it("ChatView shows nothing of it while the pane has its session (live)", () => {
    const view = chat(host("not_installed", {}, "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84"));
    deliver({ hostId: "mini", paneId: "w1:p1", state: { status: "live" }, timeline: emptyTimeline });
    expect(byName(view.tree, "ChatIntegration")).toBeUndefined();
  });
});

describe("Install from Chat", () => {
  function integration(view: HostView, bridge: Record<string, unknown>) {
    browser(bridge);
    const look = chatIntegrationLook(view, "codex", integrationNotes.note(view.id, "codex"))!;
    const part = new HookHost(ChatIntegration as (props: object) => unknown, { host: view, row, look, onShowTerminal: () => undefined });
    part.render();
    return part;
  }

  it("one click sends one install for codex on the machine, bound to the entry, connection and command connection shown", async () => {
    const calls: unknown[][] = [];
    const bridge = { installIntegration: (...args: unknown[]) => (calls.push(args), new Promise(() => undefined)) };
    const part = integration(host("not_installed"), bridge);
    const install = buttons(part.tree).find((button) => button.props["children"] === "Install")!;
    (install.props["onClick"] as () => void)();
    (install.props["onClick"] as () => void)();
    await flush();
    expect(calls).toEqual([["mini", "codex", { incarnation: 3, connection: 5, epoch: 9 }]]);
  });

  it("a refusal (the machine reconnected or removed) shows its note; nothing else changes", async () => {
    const note = "Not installed: the connection to Mac mini changed since this showed. Nothing was sent.";
    const view = host("not_installed");
    const part = integration(view, { installIntegration: () => Promise.resolve({ sent: false, note }) });
    (buttons(part.tree).find((button) => button.props["children"] === "Install")!.props["onClick"] as () => void)();
    await flush();
    const again = integration(view, {});
    expect(texts(again.tree)).toContain(note);
    expect(buttons(again.tree).map((button) => button.props["children"])).toContain("Install");
  });

  it("while it runs the button is greyed with what is under way", () => {
    const part = integration(host("not_installed", { codex: { phase: "installing", text: "Installing Herdr's Codex integration…", messages: [], action: "install" } }), {});
    const install = buttons(part.tree).find((button) => button.props["children"] === "Install")!;
    expect(install.props["disabled"]).toBe(true);
    expect(texts(part.tree)).toContain("Installing Herdr's Codex integration…");
  });

  it("after it, with no session id to resume: the steps, Herdr's lines as text, Show the terminal, no greyed Restart, no Install", () => {
    const outcome: IntegrationOutcome = { phase: "installed", text: "Installed. Restart Codex so it uses it.", messages: ["<b>hooks</b> written", "line two"], action: "install" };
    const calls: unknown[] = [];
    const part = integration(host("current", { codex: outcome }), { restartAgent: (...args: unknown[]) => (calls.push(args), Promise.resolve(null)) });
    // Restart cannot run here, so the line says what to do instead of pointing at it.
    expect(texts(part.tree)).toEqual(
      expect.arrayContaining(["Installed. To use it, quit Codex in its terminal when it is done, then start it again with New agent.", "<b>hooks</b> written", "line two"]),
    );
    const labels = buttons(part.tree).map((button) => button.props["children"]);
    expect(labels).toEqual(["Show the terminal"]);
    expect(texts(part.tree).join(" ")).not.toContain("No session id known to resume");
    expect(calls).toEqual([]);
    expect(elements(part.tree).some((element) => "dangerouslySetInnerHTML" in element.props)).toBe(false);
  });

  it("a failure shows Herdr's words (no code) and Install again", () => {
    const part = integration(host("not_installed", { codex: { phase: "failed", text: "Not installed: could not write the hooks file", messages: [], action: "install" } }), {});
    expect(texts(part.tree)).toContain("Not installed: could not write the hooks file");
    expect(texts(part.tree).join(" ")).not.toMatch(/[a-z]+_[a-z_]+:/);
    expect(buttons(part.tree).map((button) => button.props["children"])).toContain("Install");
  });

  it("a build without the call says so and sends nothing", async () => {
    const part = integration(host("not_installed"), {});
    (buttons(part.tree).find((button) => button.props["children"] === "Install")!.props["onClick"] as () => void)();
    await flush();
    expect(integrationNotes.note("mini", "codex")).toBe("Not installed: this build cannot ask Herdr to install it.");
  });
});

describe("no false Not sent (the backstop with no session)", () => {
  function backstop() {
    const store = new PendingMessages();
    const timers: { run: () => void; ms: number }[] = [];
    const stop = new PendingBackstop(
      store,
      (run, ms) => {
        const timer = { run, ms };
        timers.push(timer);
        return timer;
      },
      (timer) => {
        const at = timers.indexOf(timer as never);
        if (at >= 0) timers.splice(at, 1);
      },
    );
    return { store, stop, timers };
  }

  it("a send Herdr took for a pane with no session reads Sent to the terminal, with no timer and never Not sent", () => {
    const { store, stop, timers } = backstop();
    const id = store.add(key, "hello codex", Date.now());
    store.delivered(id);
    stop.watch(key, "idle", () => Promise.resolve(false), true);
    expect(timers).toEqual([]);
    const [bubble] = store.forPane(key);
    expect(bubble!.state).toBe("terminalOnly");
    expect(pendingLabel(bubble!, false, Date.now())).toBe("Sent to the terminal. Chat cannot show the reply without a session.");
    expect(pendingLabel(bubble!, true, Date.now())).toBe(terminalOnlyLabel);
    expect(store.markNotSent(key)).toBe(false);
    expect(store.takeNotSent(id)).toBeNull();
    // A session named later does not turn it Not sent either.
    stop.watch(key, "idle", () => Promise.resolve(false), false);
    expect(timers).toEqual([]);
    expect(store.forPane(key)[0]!.state).toBe("terminalOnly");
  });

  it("with a session the backstop is as it was: idle 5 s, nothing queued, Not sent", async () => {
    const { store, stop, timers } = backstop();
    const id = store.add(key, "hello codex", Date.now());
    store.delivered(id);
    stop.watch(key, "idle", () => Promise.resolve(false), false);
    expect(timers).toHaveLength(1);
    timers[0]!.run();
    await flush();
    expect(store.forPane(key)[0]!.state).toBe("notSent");
    expect(pendingLabel(store.forPane(key)[0]!, false, Date.now())).toBe(notSentLabel);
  });

  it("a send Herdr refused keeps today's handling: no bubble, nothing marked", () => {
    const { store, stop, timers } = backstop();
    const id = store.add(key, "hello codex", Date.now());
    store.failed(id);
    stop.watch(key, "idle", () => Promise.resolve(false), true);
    expect(store.forPane(key)).toEqual([]);
    expect(timers).toEqual([]);
  });

  it("a send still going (not yet taken) is not marked until Herdr takes it", () => {
    const { store, stop } = backstop();
    const id = store.add(key, "hello codex", Date.now());
    stop.watch(key, "idle", () => Promise.resolve(false), true);
    expect(store.forPane(key)[0]!.state).toBe("sending");
    store.delivered(id);
    stop.watch(key, "idle", () => Promise.resolve(false), true);
    expect(store.forPane(key)[0]!.state).toBe("terminalOnly");
  });

  it("such a bubble stands at its place in time once a transcript shows (never below newer turns), and still matches its message", () => {
    const store = new PendingMessages();
    const sentAt = Date.now();
    const id = store.add(key, "hello codex", sentAt);
    store.delivered(id);
    store.markTerminalOnly(key);
    const timeline = timelineOf([user("later", "u9", sentAt / 1_000 + 60)]).timeline;
    const placed = placePending(store.forPane(key), timeline);
    expect(placed.waiting).toEqual([]);
    expect([...placed.placed.values()].flat().map((message) => message.id)).toEqual([id]);
    store.observe(key, emptyTimeline);
    store.observe(key, timelineOf([user("hello codex", "u1", sentAt / 1_000 + 1)]).timeline);
    expect(store.forPane(key)).toEqual([]);
  });

  it("ChatView passes the no-session state to the backstop: the bubble reads Sent to the terminal, not tappable", () => {
    pendingBackstop.stop(key);
    const view = chat(host("current"));
    deliver(noSession);
    const id = pendingMessages.add(key, "run the checklist", Date.now());
    pendingMessages.delivered(id);
    view.render();
    view.render();
    expect(pendingMessages.forPane(key)[0]!.state).toBe("terminalOnly");
    const bubble = byName(view.tree, "PendingBubble")!;
    const inner = new HookHost(PendingBubble as (props: object) => unknown, bubble.props);
    inner.render();
    const root = elements(inner.tree)[0]!;
    expect(root.props["role"]).toBeUndefined();
    expect(root.props["onClick"]).toBeUndefined();
    expect(texts(inner.tree)).toContain(terminalOnlyLabel);
    pendingBackstop.stop(key);
  });

  it("ChatView with a session leaves the backstop as it was (the bubble waits, then the 5 s timer decides)", () => {
    pendingBackstop.stop(key);
    const view = chat(host("current", {}, "0b6f2a4e-8c1d-4f3a-9e2b-7d5c1a0e9f84"));
    deliver({ hostId: "mini", paneId: "w1:p1", state: { status: "live" }, timeline: emptyTimeline });
    const id = pendingMessages.add(key, "run the checklist", Date.now());
    pendingMessages.delivered(id);
    view.render();
    expect(pendingMessages.forPane(key)[0]!.state).toBe("sent");
    pendingBackstop.stop(key);
  });
});
