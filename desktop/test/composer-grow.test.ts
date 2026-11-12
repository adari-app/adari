// The message box grows with its text,
// line by line, from one line to ten (or 40% of the window, whichever is
// less), then scrolls inside; it shrinks back after Send; the chat above keeps
// its end pinned while the box grows. The sizing rule (composer-size.ts) and
// the real Composer and ChatView on the small hooks host with fake elements.

import { afterEach, describe, expect, it, vi } from "vitest";

import { boxMaxLines, fitBox } from "../src/renderer/components/composer-size";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { timelineOf, user } from "./support/chat-lines";
import { HookHost, elements, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");
const { ChatView } = await import("../src/renderer/chat/ChatView");

const line = 22.75;

afterEach(() => {
  composerDrafts.clear();
  vi.unstubAllGlobals();
});

describe("the box's height", () => {
  it("is one line for 1, three for 3, ten for 10, and ten with a scroll for 30 (a 900 px window)", () => {
    expect(boxMaxLines).toBe(10);
    expect(fitBox(1 * line, line, 900)).toEqual({ height: line, scrolls: false });
    expect(fitBox(3 * line, line, 900)).toEqual({ height: 3 * line, scrolls: false });
    expect(fitBox(10 * line, line, 900)).toEqual({ height: 10 * line, scrolls: false });
    expect(fitBox(30 * line, line, 900)).toEqual({ height: 10 * line, scrolls: true });
  });

  it("stops at 40% of a short window, and is never under one line", () => {
    expect(fitBox(10 * line, line, 500)).toEqual({ height: 200, scrolls: true });
    expect(fitBox(3 * line, line, 500)).toEqual({ height: 3 * line, scrolls: false });
    expect(fitBox(0, line, 900)).toEqual({ height: line, scrolls: false });
    expect(fitBox(5 * line, line, 40)).toEqual({ height: line, scrolls: true });
  });
});

/** A textarea whose content is `lines` lines tall, as the page measures it. */
function fakeTextarea() {
  const element = { style: {} as Record<string, string>, lines: 1, get scrollHeight() { return this.lines * line; } };
  return element;
}

const host = { id: "mac-mini", name: "Mac mini" } as HostView;
const row = { paneID: "w1:p1", name: "Opus", workspaceLabel: "aurora-web", kind: "claude", isAgent: true } as unknown as SidebarRow;

function composer() {
  const sends: (() => void)[] = [];
  vi.stubGlobal("window", {
    innerHeight: 900,
    herdrDesktop: { sendToPane: () => new Promise<void>((resolve) => sends.push(resolve)) },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("getComputedStyle", () => ({ lineHeight: `${line}px` }));
  const heights: number[] = [];
  const ui = new HookHost(Composer as (props: object) => unknown, { host, row, floating: true, onHeight: (h: number) => heights.push(h) });
  ui.render();
  const box = fakeTextarea();
  const wrap = { offsetHeight: 0 };
  (find(ui.tree, "textarea")!.props["ref"] as { current: unknown }).current = box;
  (elements(ui.tree)[0]!.props["ref"] as { current: unknown }).current = wrap;
  const type = (value: string): void => {
    box.lines = value.split("\n").length;
    wrap.offsetHeight = 74 + Math.min(box.lines, 10) * line;
    (find(ui.tree, "textarea")!.props["onChange"] as (e: unknown) => void)({ target: { value } });
  };
  const enter = (): void =>
    (find(ui.tree, "textarea")!.props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => undefined });
  return { ui, box, heights, type, enter, sends };
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("the composer grows with its text", () => {
  it("sizes the box to 1, 3 and 10 lines, then scrolls inside at 30 (a paste shows whole up to the cap)", () => {
    const c = composer();
    c.type("one line");
    expect(c.box.style).toMatchObject({ height: `${line}px`, overflowY: "hidden" });
    c.type(lines(3));
    expect(c.box.style).toMatchObject({ height: `${3 * line}px`, overflowY: "hidden" });
    c.type(lines(10));
    expect(c.box.style).toMatchObject({ height: `${10 * line}px`, overflowY: "hidden" });
    c.type(lines(30));
    expect(c.box.style).toMatchObject({ height: `${10 * line}px`, overflowY: "auto" });
    c.ui.unmount();
  });

  it("tells the chat its new height in the same event, so the chat can pin its end before the next paint", () => {
    const c = composer();
    c.heights.length = 0;
    c.type(lines(3));
    expect(c.heights.at(-1)).toBe(74 + 3 * line);
    c.ui.unmount();
  });

  it("shrinks back to one line after Send", async () => {
    const c = composer();
    c.type(lines(6));
    expect(c.box.style["height"]).toBe(`${6 * line}px`);
    // The box empties on the press, so it measures one line from then (before the send ends).
    c.box.lines = 1;
    c.enter();
    expect(composerDrafts.get("mac-mini/w1:p1").text).toBe("");
    expect(c.box.style["height"]).toBe(`${line}px`);
    c.sends[0]!();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(composerDrafts.get("mac-mini/w1:p1").text).toBe("");
    expect(c.box.style["height"]).toBe(`${line}px`);
    c.ui.unmount();
  });
});

describe("the chat keeps its end pinned while the box grows", () => {
  type Listener = (event: unknown) => void;
  // The page listens to chat updates once for its life (chat-state's attach): the first listener is the one.
  let listener: Listener | null = null;

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
    const props = { host: { id: "host", name: "host" }, row: { paneID: "w1:p1", status: "idle", isAgent: true }, onShowTerminal: () => undefined, bottomInset: 100 };
    const view = new HookHost(ChatView as (props: object) => unknown, props);
    view.render();
    const scroll = { scrollHeight: 1000, scrollTop: 0, clientHeight: 400 };
    (elements(view.tree).find((e) => e.props["className"] === "chat-scroll")!.props["ref"] as { current: unknown }).current = scroll;
    listener!({ hostId: "host", paneId: "w1:p1", state: { status: "live" }, timeline: timelineOf([user("hello", "u1", 0)]).timeline });
    return { view, scroll, props, inset: () => elements(view.tree).find((e) => e.props["className"] === "chat-inset")!.props["style"] };
  }

  it("moves the end with the box while following, the inset growing with it", () => {
    const c = chat();
    expect(c.scroll.scrollTop).toBe(1000);
    expect(c.inset()).toEqual({ height: 100 });
    c.scroll.scrollHeight = 1200;
    c.view.render({ ...c.props, bottomInset: 300 });
    expect(c.inset()).toEqual({ height: 300 });
    expect(c.scroll.scrollTop).toBe(1200);
    c.view.unmount();
  });

  it("leaves the view where it is when the user has scrolled up", () => {
    const c = chat();
    // The user's wheel up, then its scroll.
    (elements(c.view.tree).find((e) => e.props["className"] === "chat-scroll")!.props["onWheel"] as (e: unknown) => void)({ deltaY: -900, ctrlKey: false });
    c.scroll.scrollTop = 100;
    (elements(c.view.tree).find((e) => e.props["className"] === "chat-scroll")!.props["onScroll"] as () => void)();
    c.scroll.scrollHeight = 1300;
    c.view.render({ ...c.props, bottomInset: 400 });
    expect(c.scroll.scrollTop).toBe(100);
    c.view.unmount();
  });
});
