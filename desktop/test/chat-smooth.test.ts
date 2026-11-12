// The quiet header and smooth scrolling. The header is
// T3 Code's breadcrumb (project / title, 14 px medium, the project muted), with
// no line under it: the chat fades out under it over 24 px instead. While an
// agent works the chat's clock ticks once a second; the tick must not rebuild
// the turns (each would parse its markdown again on the page's main thread
// while you scroll): their elements are kept until the timeline changes, so
// React skips them. The real ChatView and MainPane on the small hooks host.

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GhosttyAvailability, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { reply, timelineOf, user } from "./support/chat-lines";
import { HookHost, elements, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ChatView, Turn } = await import("../src/renderer/chat/ChatView");
const { MainPane } = await import("../src/renderer/components/MainPane");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Listener = (event: unknown) => void;
// The page listens to chat updates once for its life (chat-state's attach): the first listener is the one.
let listener: Listener | null = null;

const lines = [user("hello", "u1", 0), reply("**Hi.** Here is `code`.", "a1", 5, true), user("and now?", "u2", 60), reply("Working on it.", "a2", 65)];

function chat() {
  vi.stubGlobal("window", {
    herdrDesktop: {
      onChatUpdate: (l: Listener) => {
        listener = l;
        return () => undefined;
      },
      openChat: () => undefined,
      closeChat: () => undefined,
      setChatFollowing: () => undefined,
      copyText: () => undefined,
    },
    getSelection: () => null,
  });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  const props = { host: { id: "host", name: "host" }, row: { paneID: "w1:p1", status: "working", isAgent: true }, onShowTerminal: () => undefined };
  const view = new HookHost(ChatView as (props: object) => unknown, props);
  view.render();
  listener!({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf(lines).timeline });
  const turns = () => elements(view.tree).filter((e) => e.type === Turn);
  return { view, turns };
}

describe("the working clock's tick", () => {
  it("re-renders the chat but keeps each turn's element, so React skips the turns", () => {
    vi.useFakeTimers();
    const c = chat();
    const before = c.turns();
    const tree = c.view.tree;
    expect(before.length).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(c.view.tree).not.toBe(tree);
    const after = c.turns();
    expect(after.length).toBe(2);
    after.forEach((element, i) => expect(element).toBe(before[i]));
    c.view.unmount();
  });

  it("rebuilds them when the timeline changes", () => {
    const c = chat();
    const before = c.turns();
    listener!({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf([...lines, reply("Done.", "a3", 90, true)]).timeline });
    const after = c.turns();
    expect(after.length).toBe(2);
    expect(after[1]).not.toBe(before[1]);
    c.view.unmount();
  });
});

describe("the quiet header", () => {
  const ghostty: GhosttyAvailability = { shown: false };
  const host = { id: "mac-mini", name: "Mac mini" } as HostView;
  const row = { paneID: "w1:p1", name: "Docs Opus", workspaceLabel: "Tidepool", kind: "claude", isAgent: true, glyph: "working", status: "working", cwd: "/Users/f/tidepool" } as unknown as SidebarRow;

  function header() {
    vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined }, innerHeight: 900 });
    const props = { host, row, tab: "terminal", onTab: () => undefined, mac: true, fontSize: 13, boxShown: false, onBoxShown: () => undefined, ghostty, onOpenInGhostty: () => undefined };
    const main = new HookHost(MainPane as (props: object) => unknown, props);
    main.render();
    return find(main.tree, "div", "mh")!;
  }

  it("is a breadcrumb: the project, a slash, the agent's name", () => {
    const crumb = find(header(), "span", "crumb")!;
    const parts = (crumb.props.children as { props: Record<string, unknown> }[]).map((child) => [child.props["className"], child.props["children"]]);
    expect(parts).toEqual([
      ["proj", "Tidepool"],
      ["sl", "/"],
      ["nm", "Docs Opus"],
    ]);
    expect(find(header(), "span", "who")).toBeUndefined();
  });

  const sheet = ["app.css", "chat.css"].map((name) => readFileSync(new URL(`../src/renderer/styles/${name}`, import.meta.url), "utf8")).join("\n");
  const body = (selector: string) =>
    [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector))
      .map((match) => match[2]!)
      .join(";");

  it("is 14 px medium, the project muted, with no line under it", () => {
    expect(body(".mh .crumb")).toMatch(/font-size:\s*14px/);
    expect(body(".mh .nm")).toMatch(/font-weight:\s*500/);
    expect(body(".mh .proj")).toMatch(/color:\s*var\(--ink-3\)/);
    expect(body(".mh .sl")).toMatch(/color:\s*var\(--ink-4\)/);
    expect(body(".mh")).not.toMatch(/border-bottom/);
  });

  it("lets the chat fade out under it over 24 px", () => {
    const fade = body(".chat-area::before");
    expect(fade).toMatch(/height:\s*24px/);
    expect(fade).toMatch(/linear-gradient\(/);
    expect(fade).toMatch(/pointer-events:\s*none/);
  });
});
