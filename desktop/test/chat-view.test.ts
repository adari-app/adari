// The real Chat view (src/renderer/chat/ChatView.tsx) on the small hooks host
// with a fake bridge. Pending bubbles show under the unavailable explanation
// too, a quiet line says when bubbles of the agent's previous session were
// dropped, and the App reconciles bubbles with each snapshot.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import { emptyTimeline } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView, Turn } = await import("../src/renderer/chat/ChatView");
const { App } = await import("../src/renderer/App");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

type Listener = (event: unknown) => void;

/**
 * The page listens to chat updates once for its life (chat-state's attach), so
 * the first listener registered is the one every test sends through.
 */
let chatListener: Listener | null = null;
const deliver = (event: unknown): void => chatListener!(event);
const onChatUpdate = (listener: Listener) => {
  chatListener = listener;
  return () => undefined;
};

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

function topology(session: string, terminal = "term") {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p1", terminal_id: terminal, workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: session } }],
  });
}

function host(session = "s-1", terminal = "term"): HostView {
  return { id: "host", name: "host", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology: topology(session, terminal) };
}

const row = { paneID: "w1:p1", status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true } as unknown as SidebarRow;
const key = "host/w1:p1";

const byName = (tree: unknown, name: string) =>
  elements(tree).find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const byClass = (tree: unknown, className: string) => elements(tree).find((candidate) => candidate.props["className"] === className);

function chat() {
  browser({
    onChatUpdate,
    openChat: () => undefined,
    closeChat: () => undefined,
    setChatFollowing: () => undefined,
    copyText: () => undefined,
  });
  const view = new HookHost(ChatView as (props: object) => unknown, { host: host(), row, onShowTerminal: () => undefined });
  view.render();
  return { view, send: deliver };
}

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  pendingMessages.clear();
  vi.unstubAllGlobals();
});

describe("the Chat view's pending bubbles", () => {
  it("shows a sent message's bubble under the unavailable explanation", () => {
    pendingMessages.clear();
    const c = chat();
    unmount = () => c.view.unmount();
    c.send({ hostId: "host", paneId: "w1:p1", state: { status: "unavailable", reason: "notFound" }, timeline: emptyTimeline });
    pendingMessages.add(key, "a message just sent", Date.now());
    c.view.render();
    expect(byClass(c.view.tree, "chat-empty in")).toBeDefined();
    expect(byName(c.view.tree, "PendingBubble")?.props["message"]).toMatchObject({ text: "a message just sent" });
  });

  it("says in a quiet line that bubbles of the previous session were dropped", () => {
    pendingMessages.clear();
    const c = chat();
    unmount = () => c.view.unmount();
    c.send({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: emptyTimeline });
    pendingMessages.add(key, "for the old session", Date.now(), { terminalID: "term", session: "s-1" });
    pendingMessages.reconcile(new Map([[key, { terminalID: "term", session: "s-2" }]]), () => true);
    c.view.render();
    expect(byName(c.view.tree, "PendingBubble")).toBeUndefined();
    expect(byClass(c.view.tree, "chat-quiet")?.props["children"]).toBe(
      "A message sent to the agent's previous session is no longer shown here.",
    );
  });
});

describe("newer messages waiting at the history cap", () => {
  it("shows ↓ New while newer lines wait, and its click resumes following through setChatFollowing(true)", () => {
    const following: boolean[] = [];
    browser({
      onChatUpdate,
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: (value: boolean) => following.push(value),
      copyText: () => undefined,
    });
    const view = new HookHost(ChatView as (props: object) => unknown, { host: host(), row, onShowTerminal: () => undefined });
    unmount = () => view.unmount();
    view.render();
    deliver({ hostId: "host", paneId: "w1:p1", state: { status: "loading" }, timeline: emptyTimeline });
    const scroll = { scrollHeight: 1000, scrollTop: 0, clientHeight: 200 };
    (byClass(view.tree, "chat-scroll")!.props["ref"] as { current: unknown }).current = scroll;
    const timeline = timelineOf([user("old", "u1", 0)]).timeline;
    deliver({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline });
    // The user's wheel up, then its scroll.
    (byClass(view.tree, "chat-scroll")!.props["onWheel"] as (e: unknown) => void)({ deltaY: -1000, ctrlKey: false });
    scroll.scrollTop = 0;
    (byClass(view.tree, "chat-scroll")!.props["onScroll"] as () => void)();
    expect(following).toEqual([false]);
    expect(byClass(view.tree, "chat-new")).toBeUndefined();
    // The same rows, newer lines held back: no new end id, but the feed says so.
    deliver({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: { ...timeline, newerWaiting: true } });
    const button = byClass(view.tree, "chat-new");
    expect(button).toBeDefined();
    (button!.props["onClick"] as () => void)();
    expect(following).toEqual([false, true]);
  });
});

describe("transcript notices", () => {
  const css = (name: string) => readFileSync(new URL(`../src/renderer/styles/${name}`, import.meta.url), "utf8");
  /** Every rule whose selector list names `selector`, as its body. */
  const rules = (text: string, selector: string) =>
    [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector))
      .map((match) => match[2]!);

  it("stay at their place in the chat: their own class, never the app toast's fixed position", () => {
    const view = chat();
    unmount = () => view.view.unmount();
    const timeline = timelineOf([user("go", "u1", 0), user("[Request interrupted by user]", "u2", 1), user("again", "u3", 2)]).timeline;
    view.send({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline });
    const notices: unknown[] = [];
    for (const turn of elements(view.view.tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === "Turn")) {
      const turnHost = new HookHost(turn.type as (props: object) => unknown, turn.props);
      turnHost.render();
      for (const item of elements(turnHost.tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === "ItemRow")) {
        const itemHost = new HookHost(item.type as (props: object) => unknown, item.props);
        itemHost.render();
        // The stop's row says how long the turn ran ("You stopped after 1s").
        notices.push(...elements(itemHost.tree).filter((candidate) => /^(You stopped after |Stopped$)/.test(String(candidate.props["children"]))).map((e) => e.props["className"]));
      }
    }
    expect(notices).toEqual(["chat-notice"]);
    const all = css("app.css") + css("chat.css");
    expect(rules(all, ".notice")).toEqual([]);
    expect(rules(all, ".chat-notice").join(" ")).not.toMatch(/position\s*:\s*(fixed|absolute)/);
    expect(rules(all, ".app-toast").join(" ")).toMatch(/position\s*:\s*fixed/);
  });
});

describe("the App and pending bubbles", () => {
  it("reconciles the bubbles with every snapshot: a new session drops them, a closed pane forgets them", async () => {
    pendingMessages.clear();
    let onHosts: ((hosts: HostView[]) => void) | null = null;
    browser({
      appInfo: async () => ({ version: "0.0.0", platform: "darwin", demo: false, capture: false, updates: { enabled: false, feedUrl: "" } }),
      listHosts: async () => [host("s-1")],
      onHostsChanged: (listener: (hosts: HostView[]) => void) => {
        onHosts = listener;
        return () => undefined;
      },
      onAppCommand: () => () => undefined,
      onViewCommand: () => () => undefined,
      ghosttyInfo: async () => ({ shown: false }),
      appCommandDone: () => undefined,
    });
    const app = new HookHost(App as (props: object) => unknown, {});
    unmount = () => app.unmount();
    app.render();
    await flush();
    pendingMessages.add(key, "hello", Date.now(), { terminalID: "term", session: "s-1" });
    onHosts!([host("s-1")]);
    expect(pendingMessages.forPane(key)).toHaveLength(1);
    onHosts!([host("s-2")]);
    expect(pendingMessages.forPane(key)).toEqual([]);
    expect(pendingMessages.droppedFor(key)).toBe(1);
    pendingMessages.add(key, "again", Date.now(), { terminalID: "term", session: "s-2" });
    onHosts!([{ ...host("s-2"), topology: { ...host("s-2").topology!, panes: [], agents: [] } }]);
    expect(pendingMessages.keys()).toEqual([]);
  });
});

describe("subagents", () => {
  const typedFields = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } };
  const agentLine = (id: string, description: string, second: number, background: boolean): string =>
    JSON.stringify({
      isSidechain: false,
      sessionId: "s",
      timestamp: `2026-11-02T05:00:${String(second).padStart(2, "0")}.000Z`,
      type: "assistant",
      uuid: "a-" + id,
      message: {
        content: [{ id, input: { description, prompt: "p", subagent_type: "Explore", run_in_background: background }, name: "Agent", type: "tool_use" }],
        role: "assistant",
        stop_reason: "tool_use",
      },
    });
  const resultLine = (id: string, text: string, second: number): string =>
    JSON.stringify({
      isSidechain: false,
      sessionId: "s",
      timestamp: `2026-11-02T05:00:${String(second).padStart(2, "0")}.000Z`,
      type: "user",
      uuid: "r-" + id,
      message: { content: [{ content: text, is_error: false, tool_use_id: id, type: "tool_result" }], role: "user" },
    });
  const peerLine = (text: string, second: number): string =>
    user(text, "m" + second, second, { isMeta: true, promptSource: "system", turnOrigin: "peer", origin: { kind: "peer" } });
  const texts = (tree: unknown): string[] => elements(tree).flatMap((e) => (typeof e.props["children"] === "string" ? [e.props["children"] as string] : []));
  const named = (tree: unknown, name: string) =>
    elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
  const host = (element: { type: unknown; props: object }) => {
    const made = new HookHost(element.type as (props: object) => unknown, element.props);
    made.render();
    return made;
  };

  it("gives a grouped report its own menu: its text, Send to… as a reply, the group's menu not reached", () => {
    const timeline = timelineOf([user("Check it", "u1", 0, typedFields), agentLine("toolu_fg", "Read the banner", 1, false), resultLine("toolu_fg", "Full report text", 13)]).timeline;
    const calls: unknown[][] = [];
    const turn = host({ type: Turn, props: { turn: timeline.turns[0]!, onCopy: () => {}, onMenu: (...args: unknown[]) => calls.push(args) } });
    const group = named(turn.tree, "ItemRow").map(host).flatMap((row) => named(row.tree, "SubagentsRow")).map(host)[0]!;
    const line = named(group.tree, "SubagentLine").map(host)[0]!;
    (elements(line.tree).find((e) => e.type === "button")!.props["onClick"] as () => void)();
    line.render();
    const report = named(line.tree, "ReplyText").map(host)[0]!;
    let stopped = false;
    const event = { stopPropagation: () => (stopped = true), preventDefault: () => undefined };
    (elements(report.tree).find((e) => e.props["onContextMenu"] !== undefined)!.props["onContextMenu"] as (e: unknown) => void)(event);
    expect(calls.map((args) => args.slice(1))).toEqual([["Full report text", { type: "reply" }]]);
    expect(stopped).toBe(true);
  });

  it("says how many run on the Working line", async () => {
    const { workingLine } = await import("../src/renderer/chat/ChatView");
    expect(workingLine(0, 130, 2)).toBe("Working for 2m 10s · 2 agents");
    expect(workingLine(0, 5, 1)).toBe("Working for 5s · 1 agent");
    expect(workingLine(0, 5, 0)).toBe("Working for 5s");
  });

  it("draws the turn's subagents as one row whose done line opens to its report, and a peer message folded", () => {
    const timeline = timelineOf([
      user("Check it", "u1", 0, typedFields),
      agentLine("toolu_fg", "Read the banner", 1, false),
      agentLine("toolu_bg", "Check the phone", 2, true),
      resultLine("toolu_fg", "Banner.swift sets no lineLimit.", 13),
      peerLine('Another Claude session sent a message:\n<agent-message from="w7:p1">\nPause the deploy.\n</agent-message>', 14),
    ]).timeline;
    const turn = host({ type: Turn, props: { turn: timeline.turns[0]!, onCopy: () => {}, onMenu: () => {} } });
    const rows = named(turn.tree, "ItemRow").map(host);
    const groups = rows.flatMap((row) => named(row.tree, "SubagentsRow")).map(host);
    expect(groups.length).toBe(1);
    expect(texts(groups[0]!.tree)).toContain("1 agent running · 1 done");
    const lines = named(groups[0]!.tree, "SubagentLine").map(host);
    expect(lines.map((line) => texts(line.tree))).toEqual([
      ["Read the banner", "Explore", "done · 12s"],
      ["Check the phone", "Explore", "running"],
    ]);
    const button = elements(lines[0]!.tree).find((e) => e.type === "button")!;
    (button.props["onClick"] as () => void)();
    lines[0]!.render();
    expect(elements(lines[0]!.tree).some((e) => e.props["className"] === "sub-report")).toBe(true);
    const message = rows.flatMap((row) => named(row.tree, "AgentMessageRow")).map(host);
    expect(message.map((row) => texts(row.tree))).toEqual([["Message from another session", "w7:p1"]]);
    expect(elements(message[0]!.tree).some((e) => e.props["className"] === "sub-report")).toBe(false);
  });
});

describe("Working with only background agents left", () => {
  const agent = JSON.stringify({ type: "assistant", uuid: "abg", timestamp: "2026-11-02T05:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "bg", name: "Agent", input: { description: "Background", run_in_background: true } }], stop_reason: "tool_use" } });
  const result = JSON.stringify({ type: "user", uuid: "rbg", timestamp: "2026-11-02T05:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bg", content: "agentId: agent-bg" }] } });
  const done = JSON.stringify({ type: "assistant", uuid: "done", timestamp: "2026-11-02T05:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "Background started" }], stop_reason: "end_turn" } });
  const shown = (status: Partial<SidebarRow>) => {
    browser({ onChatUpdate, openChat: () => undefined, closeChat: () => undefined, setChatFollowing: () => undefined, copyText: () => undefined });
    const view = new HookHost(ChatView as (props: object) => unknown, { host: host(), row: { ...row, status: "working", ...status }, onShowTerminal: () => undefined });
    unmount = () => view.unmount();
    view.render();
    deliver({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf([user("Start", "u1", 0), agent, result, done]).timeline });
    view.render();
    return byClass(view.tree, "working-t")?.props["children"];
  };

  it("shows the line and its count from when Herdr says the pane began working", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-02T05:02:10Z"), toFake: ["Date"] });
    try {
      expect(shown({ statusSinceUnixMs: Date.parse("2026-11-02T05:00:00Z") })).toBe("Working for 2m 10s · 1 agent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows it from when the view first saw the pane working when Herdr gives no time", () => {
    expect(shown({})).toMatch(/^Working for \d+s · 1 agent$/);
  });
});

