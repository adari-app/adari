// The iPhone's rows-confirmed rule: the launch cache's rows on show (catching up)
// cannot be acted on until the live read confirms them: no Copy, no Send to… or code send, no context menu,
// no Load earlier. Once live, the same rows act as usual. The real Chat view on the small hooks host.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { reply, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView } = await import("../src/renderer/chat/ChatView");

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;

function browser(bridge: Record<string, unknown>): void {
  vi.stubGlobal("window", {
    herdrDesktop: bridge,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => ({ toString: () => "" }),
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

const host: HostView = {
  id: "host",
  name: "host",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state: "connected",
  error: null,
  fetchedAtMs: 0,
  topology: decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" } }],
  }),
};
const row = { paneID: "w1:p1", status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true } as unknown as SidebarRow;

const named = (tree: unknown, name: string) =>
  elements(tree).filter((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === name);

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

describe("the launch cache's rows", () => {
  it("cannot be acted on while catching up, and act as usual once the live read confirms them", () => {
    const copied: string[] = [];
    const loads: string[] = [];
    browser({
      onChatUpdate: (listener: Listener) => {
        chatListener = listener;
        return () => undefined;
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: (text: string) => void copied.push(text),
      loadEarlier: () => {
        loads.push("load");
        return Promise.resolve();
      },
    });
    const view = new HookHost(ChatView as (props: object) => unknown, { host, row, onShowTerminal: () => undefined });
    unmount = () => view.unmount();
    view.render();
    const lines = [user("first", "u1", 0), reply("```sh\nmake\n```", "a1", 1, true), user("second", "u2", 2), reply("Done.", "a2", 3, true)];
    const timeline = { ...timelineOf(lines).timeline, earlier: "available" as const };
    chatListener!({ hostId: "host", paneId: "w1:p1", state: { status: "loading" }, timeline, catchingUp: true });
    const event = { preventDefault: () => undefined, clientX: 10, clientY: 10 };
    const cached = named(view.tree, "Turn");
    expect(cached).toHaveLength(2);
    for (const turn of cached) {
      expect(turn.props["onSendCode"]).toBeUndefined();
      (turn.props["onCopy"] as (text: string) => void)("first");
      (turn.props["onMenu"] as (event: unknown, text: string) => void)(event, "first");
    }
    view.render();
    expect(copied).toEqual([]);
    expect(named(view.tree, "ContextMenu")).toHaveLength(0);
    expect(named(view.tree, "Earlier")).toHaveLength(0);
    expect(elements(view.tree).some((element) => element.props["className"] === "chat-col catching")).toBe(true);

    // The live read confirms them: the same rows act.
    chatListener!({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline });
    const live = named(view.tree, "Turn");
    expect(live).toHaveLength(2);
    expect(live[0]!.props["onSendCode"]).toBeTypeOf("function");
    (live[0]!.props["onCopy"] as (text: string) => void)("first");
    expect(copied).toEqual(["first"]);
    (live[0]!.props["onMenu"] as (event: unknown, text: string) => void)(event, "first");
    view.render();
    expect(named(view.tree, "ContextMenu")).toHaveLength(1);
    expect(named(view.tree, "Earlier")).toHaveLength(1);
  });
});
