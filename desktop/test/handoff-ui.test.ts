// Send to… in the page (the hooks): a reply's, a
// progress row's and the user's own message's menu offer Send to… (and Send
// selection to… for a selection in a reply), a code block's header has Send
// to… beside Copy; each opens the picker with what it sends; the picker's keys
// (↑ ↓ ↩ ⌘↩ Esc) and the box that takes a hand-off with its cursor at its start.
// On the hooks host with a fake bridge, as chat-view.test.ts runs the real view.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { progress, reply, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { Markdown } = await import("../src/renderer/chat/Markdown");
const { Composer } = await import("../src/renderer/components/MainPane");
const { HandoffPickerView } = await import("../src/renderer/handoff/HandoffPicker");
const { handoffStore } = await import("../src/renderer/handoff/handoff-state");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;

function browser(extra: Record<string, unknown> = {}): void {
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
    innerWidth: 1400,
    innerHeight: 900,
    ...extra,
  });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
}

function topology() {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "", focused: true, pane_count: 2, agent_status: "idle" }],
    panes: [
      { pane_id: "w1:p1", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "idle", revision: 1 },
      { pane_id: "w1:p2", terminal_id: "t2", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "codex", agent_status: "idle", revision: 1 },
    ],
    layouts: [],
    agents: [
      { pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } },
      { pane_id: "w1:p2", agent: "codex", agent_status: "idle", agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "s-2" } },
    ],
  });
}

const host: HostView = { id: "host", name: "Mac mini", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology: topology() };
const row = { paneID: "w1:p1", status: "idle", name: "claude", kind: "claude", workspaceLabel: "app", isAgent: true } as unknown as SidebarRow;

const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);
const mounted = (element: { type: unknown; props: object }) => {
  const h = new HookHost(element.type as (props: object) => unknown, element.props);
  h.render();
  return h;
};

afterEach(() => {
  handoffStore.reset();
  composerDrafts.clear();
  vi.unstubAllGlobals();
});

/** The chat's rows (ItemRow and PendingBubble) for a timeline, each mounted. */
function chatRows(lines: string[]) {
  browser();
  const view = new HookHost(ChatView as (props: object) => unknown, { host, row, onShowTerminal: () => undefined });
  view.render();
  chatListener!({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(lines).timeline });
  const items = named(view.tree, "Turn").flatMap((turn) => named(mounted(turn).tree, "ItemRow"));
  return { view, items };
}

function openMenuOf(view: { tree: unknown }, item: { props: Record<string, unknown> }) {
  const h = mounted(item as never);
  const root = elements(h.tree)[0]!;
  (root.props["onContextMenu"] as (event: unknown) => void)({ preventDefault: () => undefined, clientX: 40, clientY: 50 });
  const menu = named(view.tree, "ContextMenu")[0];
  return (menu?.props["items"] ?? []) as { label: string; onSelect(): void }[];
}

describe("Send to… in Chat", () => {
  it("is in a reply's, a progress row's and the user's own message's menu, and opens the picker with what it sends", () => {
    const { view, items } = chatRows([user("look at the build", "u1", 0), progress("Checking the log", "p1", 1), reply("The build is **green**.", "a1", 2, true)]);
    const kinds = items.map((item) => (item.props["item"] as { type: string }).type);
    expect(kinds).toEqual(["user", "progress", "agentText"]);
    for (const [index, kind] of [
      [0, "ownMessage"],
      [1, "progress"],
      [2, "reply"],
    ] as const) {
      const menu = openMenuOf(view, items[index]!);
      expect(menu.map((entry) => entry.label)).toEqual(["Copy", "Send to…"]);
      menu[1]!.onSelect();
      const picker = handoffStore.picker();
      expect(picker?.payload.kind.type).toBe(kind);
      expect(picker?.payload.source).toEqual({ hostId: "host", paneId: "w1:p1", name: "claude", kind: "claude", workspace: "app", macName: "Mac mini" });
      expect({ x: picker?.x, y: picker?.y }).toEqual({ x: 40, y: 50 });
    }
    expect(handoffStore.picker()?.payload.text).toBe("The build is **green**.");
  });

  it("offers Send selection to… for a selection in a reply, sent as prose", () => {
    const { view, items } = chatRows([reply("one two three", "a1", 2, true)]);
    const scope = { closest: () => null, querySelectorAll: () => [] };
    const range = { commonAncestorContainer: { nodeType: 1, ...scope }, startContainer: { nodeType: 1, ...scope }, endContainer: { nodeType: 1, ...scope }, intersectsNode: () => false };
    (window as unknown as { getSelection: () => unknown }).getSelection = () => ({ toString: () => "two", rangeCount: 1, isCollapsed: false, getRangeAt: () => range });
    const menu = openMenuOf(view, items[0]!);
    expect(menu.map((entry) => entry.label)).toEqual(["Copy", "Copy message", "Send selection to…", "Send to…"]);
    menu[2]!.onSelect();
    expect(handoffStore.picker()?.payload).toMatchObject({ text: "two", kind: { type: "selection", selection: { type: "prose" } } });
  });

  it("has Send to… in a code block's header beside Copy, sending the code with its language", () => {
    browser();
    const sent: unknown[] = [];
    const md = mounted({ type: Markdown, props: { source: "Run:\n\n```sh\nmake test\n```\n", onCopy: () => undefined, onSendCode: (...args: unknown[]) => sent.push(args) } });
    const block = mounted(named(md.tree, "CodeBlock")[0] as never);
    const buttons = elements(block.tree).filter((e) => e.type === "button");
    // In the header group, Send to… comes first, then Wrap and Copy.
    expect(buttons.map((b) => b.props["className"])).toEqual(["md-act md-send", "md-act", "md-act"]);
    expect(buttons.map((b) => b.props["aria-label"])).toEqual(["Send code to…", "Wrap lines", "Copy code"]);
    (buttons[0]!.props["onClick"] as (event: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({ left: 300, bottom: 120 }) } });
    expect(sent).toEqual([["sh", "make test", 300, 124]]);
    // Without a hand-off context (no onSendCode) there is no Send to….
    const plain = mounted({ type: Markdown, props: { source: "```sh\nx\n```", onCopy: () => undefined } });
    const plainBlock = mounted(named(plain.tree, "CodeBlock")[0] as never);
    expect(elements(plainBlock.tree).filter((e) => e.type === "button").map((b) => b.props["aria-label"])).toEqual(["Wrap lines", "Copy code"]);
  });
});

describe("the picker's keys", () => {
  function picker() {
    browser();
    handoffStore.setHosts([host]);
    handoffStore.openPicker({ text: "the reply", kind: { type: "reply" }, source: { hostId: "host", paneId: "w1:p1", name: "claude", kind: "claude", workspace: "app", macName: "Mac mini" } }, 10, 10);
    const picks: [string, string][] = [];
    let closed = 0;
    const view = new HookHost(HandoffPickerView as (props: object) => unknown, {
      request: handoffStore.picker()!,
      store: handoffStore,
      recents: [],
      mac: true,
      onPick: (target: { paneId: string }, action: string) => picks.push([target.paneId, action]),
      onCopy: () => undefined,
      onClose: () => (closed += 1),
    });
    view.render();
    const key = (key: string, mods: { metaKey?: boolean } = {}) =>
      (elements(view.tree)[0]!.props["onKeyDown"] as (event: unknown) => void)({ key, metaKey: false, ctrlKey: false, ...mods, preventDefault: () => undefined, nativeEvent: { isComposing: false } });
    return { view, picks, key, closed: () => closed };
  }

  it("lists the other pane (never the one the text comes from), sends it now on ⌘Return, once", () => {
    const p = picker();
    const rows = elements(p.view.tree).filter((e) => typeof e.type === "function" && (e.type as { name: string }).name === "Row");
    expect(rows.map((r) => (r.props["target"] as { paneId: string }).paneId)).toEqual(["w1:p2"]);
    p.key("Enter", { metaKey: true });
    p.key("Enter", { metaKey: true });
    p.key("Enter");
    expect(p.picks).toEqual([["w1:p2", "sendNow"]]);
  });

  it("opens with the draft on Return, moves with ↑ ↓, closes on Escape and ⌘.", () => {
    const p = picker();
    p.key("ArrowDown");
    p.key("ArrowUp");
    p.key("Enter");
    expect(p.picks).toEqual([["w1:p2", "draft"]]);
    const q = picker();
    q.key("Escape");
    q.key(".", { metaKey: true });
    expect(q.closed()).toBe(2);
    expect(q.picks).toEqual([]);
  });
});

describe("the box that takes a hand-off", () => {
  it("takes the keys with its cursor where the hand-off starts", () => {
    browser();
    const calls: string[] = [];
    const view = new HookHost(Composer as (props: object) => unknown, { host, row: { ...row, paneID: "w1:p2", name: "codex" } });
    view.render();
    const textarea = elements(view.tree).find((e) => e.type === "textarea")!;
    (textarea.props["ref"] as { current: unknown }).current = {
      // The box grows with its text: it sets its own height.
      style: {},
      scrollHeight: 23,
      focus: () => calls.push("focus"),
      setSelectionRange: (a: number, b: number) => calls.push(`select ${a}-${b}`),
    };
    handoffStore.expectLanding("host/w1:p2", 13);
    composerDrafts.edit("host/w1:p2", "my own note\n\nFrom claude in app (Mac mini):\nthe reply");
    expect(calls).toEqual(["focus", "select 13-13"]);
    composerDrafts.edit("host/w1:p2", "typed more");
    expect(calls).toHaveLength(2);
  });
});
