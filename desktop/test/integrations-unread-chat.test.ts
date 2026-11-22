// Chat's no-session state when the machine's integration list was not read on
// this connection: today's line, then one more plain sentence saying Adari
// could not read Herdr's integrations there, and a Retry that asks the list
// again on the connection the window showed. Nothing else about the state
// changes. The real ChatView on the small hooks host with a fake bridge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { emptyTimeline } from "../src/shared/chat/model";
import type { HostView } from "../src/shared/ipc-contract";
import type { IntegrationBinding } from "../src/shared/integrations";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements } from "./support/fake-hooks";
import { paneTopology } from "./support/pane-topology";

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { IntegrationUnread, integrationNotes } = await import("../src/renderer/components/integrations");
const { pendingMessages } = await import("../src/renderer/chat/chat-state");

const noSessionLine = "Herdr names no session for this agent yet, so there is no transcript to show.";
const unreadLine = "Adari could not read Herdr's integrations on Mac mini, so it cannot tell whether this agent's integration is installed.";
const unread: IntegrationBinding = { incarnation: 3, connection: 5, epoch: 9 };

function machine(extra: Partial<HostView> = {}): HostView {
  return {
    id: "mini",
    name: "Mac mini",
    kind: "ssh",
    address: "fixture",
    platform: null,
    state: "connected",
    error: null,
    fetchedAtMs: 0,
    topology: paneTopology([{ id: "w1:p1", agent: "agy" }, { id: "w1:p2", agent: "devin" }]),
    incarnation: 3,
    connection: 5,
    epoch: 9,
    integrationsUnread: unread,
    ...extra,
  };
}

const rowOf = (paneID: string, kind: string) => ({ paneID, status: "idle", name: "fixture", workspaceLabel: "app", isAgent: true, kind }) as unknown as SidebarRow;

const texts = (tree: unknown): string[] =>
  elements(tree).flatMap((element) => {
    const children = element.props["children"];
    return (Array.isArray(children) ? children : [children]).filter((child): child is string => typeof child === "string");
  });

type Listener = (event: unknown) => void;
let chatListener: Listener | null = null;
let retries: [string, IntegrationBinding][] = [];

function browser(withRetry = true): void {
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
      ...(withRetry
        ? {
            retryIntegrations: (hostId: string, binding: IntegrationBinding) => {
              retries.push([hostId, binding]);
              return Promise.resolve();
            },
          }
        : {}),
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

/** The pane's Chat with no session named, and its not-read part drawn (if any). */
function noSessionChat(paneId: string, kind: string, host: HostView): { chat: string[]; part: HookHost<object> | null } {
  const view = mount(ChatView, { host, row: rowOf(paneId, kind), onShowTerminal: () => undefined });
  chatListener?.({ hostId: "mini", paneId, state: { status: "unavailable", reason: "noSession" }, timeline: emptyTimeline });
  view.render();
  const all = elements(view.tree);
  // Today's line (ChatUnavailableLine's text) and the rest of Chat's words.
  const line = all.find((candidate) => typeof candidate.type === "function" && (candidate.type as { name: string }).name === "ChatUnavailableLine");
  const chat = [...(line === undefined ? [] : [String(line.props["line"])]), ...texts(view.tree)];
  const element = all.find((candidate) => candidate.type === IntegrationUnread);
  return { chat, part: element === undefined ? null : mount(IntegrationUnread, element.props) };
}

beforeEach(() => {
  integrationNotes.reset();
  pendingMessages.clear();
  retries = [];
  browser();
});

afterEach(() => {
  for (const view of hosts.splice(0)) view.unmount();
  pendingMessages.clear();
  // The chat store's listener is taken once per module (kept: the next test's update goes to it).
  vi.unstubAllGlobals();
});

describe("Chat's no-session state with the list not read", () => {
  it("a shown kind: today's line and Show the terminal, then the sentence and Retry", () => {
    const { chat, part } = noSessionChat("w1:p1", "agy", machine());
    expect(chat).toContain(noSessionLine);
    expect(chat).toContain("Show the terminal");
    expect(part).not.toBeNull();
    expect(texts(part!.tree)).toEqual([unreadLine, "Retry"]);
  });

  it("Retry asks the list again for that machine, bound to the connection shown as not read", async () => {
    const { part } = noSessionChat("w1:p1", "agy", machine());
    const button = elements(part!.tree).find((element) => element.props["data-integrations-retry"] === "");
    expect(button?.props["disabled"]).toBe(false);
    (button!.props["onClick"] as () => void)();
    (button!.props["onClick"] as () => void)();
    await Promise.resolve();
    expect(retries).toEqual([["mini", unread]]);
  });

  it("a kind with no shown integration, a read list, no mark, or an offline machine: only today's line", () => {
    for (const [kind, host] of [
      ["devin", machine()],
      ["agy", machine({ integrationsUnread: undefined })],
      ["agy", machine({ integrations: { ...unread, items: [], outcomes: {} } })],
      ["agy", machine({ state: "offline" })],
    ] as const) {
      const { chat, part } = noSessionChat(kind === "devin" ? "w1:p2" : "w1:p1", kind, host);
      expect(part === null ? [] : texts(part.tree)).toEqual([]);
      expect(chat).not.toContain(unreadLine);
    }
  });

  it("an older bridge with no Retry: the sentence shows, its button greyed", () => {
    vi.unstubAllGlobals();
    browser(false);
    const { part } = noSessionChat("w1:p1", "agy", machine());
    const button = elements(part!.tree).find((element) => element.props["data-integrations-retry"] === "");
    expect(button?.props["disabled"]).toBe(true);
  });
});
