// Late Chat updates for a tile no longer shown are dropped. The page keeps updates only for the Chats it
// follows now: a Chat registers when it mounts and unregisters before its slot
// closes; each follow has a generation the main process echoes, so an update
// queued by an earlier follow of the same pane (closed and reopened) is not
// taken for the new one.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatService, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { emptyTimeline, type ChatTimeline } from "../src/shared/chat/model";
import type { ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { chatUpdates, pendingMessages } = await import("../src/renderer/chat/chat-state");
const { ChatView } = await import("../src/renderer/chat/ChatView");

// The page listens once for its life: the first listener attached is the one every case delivers through.
let deliver: ((event: ChatUpdateEvent) => void) | null = null;
chatUpdates.attach({
  onChatUpdate: (listener: (event: ChatUpdateEvent) => void) => {
    deliver = listener;
    return () => undefined;
  },
} as never);

const timeline = (title: string): ChatTimeline => ({ ...emptyTimeline, title }) as ChatTimeline;
const update = (paneId: string, title: string, follow?: number): ChatUpdateEvent => ({
  hostId: "A",
  paneId,
  state: { status: "live" },
  timeline: timeline(title),
  ...(follow === undefined ? {} : { follow }),
});

afterEach(() => {
  pendingMessages.clear();
  vi.unstubAllGlobals();
});

describe("the page keeps only the Chats it follows now", () => {
  it("100 departed panes with queued updates leave none cached", () => {
    let notified = 0;
    const stop = chatUpdates.subscribe(() => (notified += 1));
    for (let i = 0; i < 100; i += 1) {
      const pane = `departed-${i}`;
      const follow = chatUpdates.follow("A", pane);
      deliver!(update(pane, `shown ${i}`, follow));
      expect(chatUpdates.forPane("A", pane)?.timeline.title).toBe(`shown ${i}`);
      // The tile leaves the screen: it unregisters, then its slot closes.
      chatUpdates.unfollow("A", pane, follow);
      // A main-to-renderer update queued before the main process handled the close.
      deliver!(update(pane, `late ${i}`, follow));
    }
    const retained = Array.from({ length: 100 }, (_, i) => chatUpdates.forPane("A", `departed-${i}`)).filter(Boolean).length;
    expect(retained).toBe(0);
    // The late ones were not even announced to the page.
    expect(notified).toBe(100);
    stop();
  });

  it("an update for a pane never followed is dropped (no update, no pending baseline)", () => {
    const observe = vi.spyOn(pendingMessages, "observe");
    deliver!(update("never-shown", "stray"));
    expect(chatUpdates.forPane("A", "never-shown")).toBeNull();
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();
  });

  it("the same pane closed and reopened: the old follow's late update is not the new one's", () => {
    const first = chatUpdates.follow("A", "again");
    deliver!(update("again", "first follow", first));
    chatUpdates.unfollow("A", "again", first);
    const second = chatUpdates.follow("A", "again");
    expect(second).not.toBe(first);
    // Queued by the first follow's feed, delivered after the reopen.
    deliver!(update("again", "first follow, late", first));
    expect(chatUpdates.forPane("A", "again")).toBeNull();
    deliver!(update("again", "second follow", second));
    expect(chatUpdates.forPane("A", "again")?.timeline.title).toBe("second follow");
    // A stale unregister (the first follow's) leaves the second alone.
    chatUpdates.unfollow("A", "again", first);
    expect(chatUpdates.forPane("A", "again")?.timeline.title).toBe("second follow");
    chatUpdates.unfollow("A", "again", second);
    expect(chatUpdates.forPane("A", "again")).toBeNull();
  });

  it("two follows of one pane overlapping (an old view not yet gone): the update stays until the last one leaves", () => {
    const old = chatUpdates.follow("A", "overlap");
    const shown = chatUpdates.follow("A", "overlap");
    deliver!(update("overlap", "from the shown one", shown));
    chatUpdates.unfollow("A", "overlap", old);
    expect(chatUpdates.forPane("A", "overlap")?.timeline.title).toBe("from the shown one");
    deliver!(update("overlap", "old, late", old));
    expect(chatUpdates.forPane("A", "overlap")?.timeline.title).toBe("from the shown one");
    chatUpdates.unfollow("A", "overlap", shown);
    expect(chatUpdates.forPane("A", "overlap")).toBeNull();
  });
});

function topology() {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } }],
  });
}

describe("a tile's Chat registers on mount and unregisters before its slot closes", () => {
  it("opens with its follow, drops late updates after unmount, and a remount is a new follow", () => {
    const calls: string[] = [];
    const opened: (number | undefined)[] = [];
    vi.stubGlobal("window", {
      herdrDesktop: {
        onChatUpdate: () => () => undefined,
        openChat: (_host: string, paneId: string, slot?: string, follow?: number) => {
          calls.push(`open ${paneId} ${slot}`);
          opened.push(follow);
        },
        closeChat: (slot?: string) => {
          // The page has stopped following before the main process is told.
          calls.push(`close ${slot} cached=${chatUpdates.forPane("A", "w1:p1") !== null}`);
        },
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
    vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
    const host: HostView = { id: "A", name: "A", kind: "ssh", address: "fixture", platform: null, state: "connected", error: null, fetchedAtMs: 0, topology: topology() };
    const row = { paneID: "w1:p1", status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true } as unknown as SidebarRow;
    const props = { host, row, onShowTerminal: () => undefined, tile: true };

    const view = new HookHost(ChatView as (props: object) => unknown, props);
    view.render();
    expect(calls).toEqual(["open w1:p1 A/w1:p1"]);
    const follow = opened[0]!;
    expect(typeof follow).toBe("number");
    deliver!(update("w1:p1", "on screen", follow));
    expect(chatUpdates.forPane("A", "w1:p1")?.timeline.title).toBe("on screen");

    view.unmount();
    expect(calls.at(-1)).toBe("close A/w1:p1 cached=false");
    deliver!(update("w1:p1", "late", follow));
    expect(chatUpdates.forPane("A", "w1:p1")).toBeNull();

    // The same pane's tile again: a new follow; the old one's late update is dropped.
    const again = new HookHost(ChatView as (props: object) => unknown, props);
    again.render();
    const next = opened[1]!;
    expect(next).not.toBe(follow);
    deliver!(update("w1:p1", "old feed, late", follow));
    expect(chatUpdates.forPane("A", "w1:p1")).toBeNull();
    deliver!(update("w1:p1", "new feed", next));
    expect(chatUpdates.forPane("A", "w1:p1")?.timeline.title).toBe("new feed");
    again.unmount();
    expect(chatUpdates.forPane("A", "w1:p1")).toBeNull();
  });
});

describe("the main process echoes the follow", () => {
  it("each update of a chat carries the follow it was opened with; a reopen carries the new one", () => {
    const hosts: ChatHosts = { backend: () => null, pane: () => null, agent: () => null };
    const service = new ChatService(hosts, "chat");
    const sent: ChatUpdateEvent[] = [];
    const page: ChatOwner = { id: 1, send: (_channel, payload) => sent.push(payload), isDestroyed: () => false };
    service.open(page, "A", "w1:p1", "A/w1:p1", 7);
    expect(sent.at(-1)).toMatchObject({ hostId: "A", paneId: "w1:p1", follow: 7 });
    service.close(page, "A/w1:p1");
    service.open(page, "A", "w1:p1", "A/w1:p1", 8);
    expect(sent.at(-1)).toMatchObject({ follow: 8 });
    // The same pane asked again by the same follow re-sends what is shown, still with its follow.
    service.open(page, "A", "w1:p1", "A/w1:p1", 8);
    expect(sent.at(-1)).toMatchObject({ follow: 8 });
    service.closeAll();
  });
});
