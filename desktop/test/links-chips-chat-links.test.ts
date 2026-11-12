// A link in a chat reply opens in the default browser.
// An http or https link is a focusable anchor whose click, or Return on it,
// calls the bridge's openLink (main opens it with the system, never in the
// app's window; the page never follows it). Any other address is text in the
// reply's colour, not clickable, its address as its title. Main checks the
// address again at its door: http and https only.

import { afterEach, describe, expect, it, vi } from "vitest";

import { HookHost, elements } from "./support/fake-hooks";

const registered = vi.hoisted(() => ({ on: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: () => undefined,
    on: (channel: string, listener: (...args: unknown[]) => unknown) => registered.on.set(channel, listener),
  },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Markdown, linkElement } = await import("../src/renderer/chat/Markdown");
const { openLink } = await import("../src/renderer/open-link");
const { isSafeExternalUrl } = await import("../src/shared/external-url");
const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");
const { IPC } = await import("../src/shared/ipc-contract");

type Handler = (event: unknown) => void;

/** The page's bridge as the preload gives it, recording each open. */
function withBridge(selected = ""): string[] {
  const opened: string[] = [];
  (globalThis as { window?: unknown }).window = {
    herdrDesktop: { openLink: (url: string) => opened.push(url) },
    getSelection: () => ({ isCollapsed: selected === "", toString: () => selected }),
  };
  return opened;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** A click as the user's mouse makes it: its default (following the link) recorded when prevented. */
function click(): { prevented: boolean; preventDefault(): void } {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}
function key(name: string): { key: string; prevented: boolean; preventDefault(): void } {
  return {
    key: name,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

function rendered(source: string) {
  const ui = new HookHost(Markdown as (props: object) => unknown, { source, onCopy: () => undefined });
  ui.render();
  return ui;
}

describe("a chat reply's links", () => {
  it("a reply's https link is an anchor: a click opens it through the bridge and the page does not follow it", () => {
    const opened = withBridge();
    const ui = rendered("Blog slot 2 is live: https://example.invalid/blog/slot-2");
    const anchor = elements(ui.tree).find((e) => e.type === "a")!;
    expect(anchor).toBeDefined();
    expect(anchor.props["className"]).toBe("md-link");
    expect(anchor.props["href"]).toBe("https://example.invalid/blog/slot-2");
    expect(anchor.props["title"]).toBe("https://example.invalid/blog/slot-2");
    expect(anchor.props["draggable"]).toBe(false);
    const event = click();
    (anchor.props["onClick"] as Handler)(event);
    expect(event.prevented).toBe(true);
    expect(opened).toEqual(["https://example.invalid/blog/slot-2"]);
    ui.unmount();
  });

  it("http links and [text](url) links open the same way", () => {
    const opened = withBridge();
    const ui = rendered("See [the pull request](http://example.invalid/pr/41) for **details**.");
    const anchor = elements(ui.tree).find((e) => e.type === "a")!;
    (anchor.props["onClick"] as Handler)(click());
    expect(opened).toEqual(["http://example.invalid/pr/41"]);
    ui.unmount();
  });

  it("Return on the focused link opens it once (the browser's own click for Return is prevented); other keys do nothing", () => {
    const opened = withBridge();
    const anchor = elements(linkElement(0, "https://example.invalid/a", "a")).find((e) => e.type === "a")!;
    // An anchor with an href is in the Tab order.
    expect(typeof anchor.props["href"]).toBe("string");
    const space = key(" ");
    (anchor.props["onKeyDown"] as Handler)(space);
    (anchor.props["onKeyDown"] as Handler)(key("Tab"));
    expect(opened).toEqual([]);
    expect(space.prevented).toBe(false);
    const enter = key("Enter");
    (anchor.props["onKeyDown"] as Handler)(enter);
    expect(enter.prevented).toBe(true);
    expect(opened).toEqual(["https://example.invalid/a"]);
  });

  it("a click that ends a text selection across the link selects, it does not open", () => {
    const opened = withBridge("live: https://exa");
    const anchor = elements(linkElement(0, "https://example.invalid/a", "a")).find((e) => e.type === "a")!;
    const event = click();
    (anchor.props["onClick"] as Handler)(event);
    expect(event.prevented).toBe(true);
    expect(opened).toEqual([]);
  });

  it("any other scheme is text, not clickable, its address the tooltip", () => {
    const opened = withBridge();
    for (const href of ["file:///etc/hosts", "javascript:alert(1)", "./src/a.ts", "mailto:a@b.invalid", "ftp://example.invalid/x", "not a url"]) {
      const tree = linkElement(0, href, "words");
      const all = elements(tree);
      expect(all.some((e) => e.type === "a")).toBe(false);
      const span = all[0]!;
      expect(span.type).toBe("span");
      expect(span.props["className"]).toBe("md-link-off");
      expect(span.props["title"]).toBe(href);
      expect(span.props["onClick"]).toBeUndefined();
      expect(span.props["onKeyDown"]).toBeUndefined();
      expect(span.props["tabIndex"]).toBeUndefined();
    }
    expect(opened).toEqual([]);
  });

  it("the parser's other links stay its text (no new autolink pass)", () => {
    withBridge();
    const ui = rendered("[file](./src/a.ts) and [run](javascript:alert(1)) and www.example.invalid");
    expect(elements(ui.tree).some((e) => e.type === "a")).toBe(false);
    ui.unmount();
  });
});

describe("the open-link path", () => {
  it("the renderer's openLink sends only http and https", () => {
    const sent: string[] = [];
    const bridge = { openLink: (url: string) => void sent.push(url) };
    expect(openLink("https://example.invalid/x", bridge)).toBe(true);
    expect(openLink("http://example.invalid/y", bridge)).toBe(true);
    expect(openLink("javascript:alert(1)", bridge)).toBe(false);
    expect(openLink("file:///etc/passwd", bridge)).toBe(false);
    expect(openLink("adari://open", bridge)).toBe(false);
    expect(openLink("https://example.invalid/z", {})).toBe(false);
    expect(sent).toEqual(["https://example.invalid/x", "http://example.invalid/y"]);
  });

  it("the shared guard: http and https only, never too long", () => {
    expect(isSafeExternalUrl("https://example.invalid")).toBe(true);
    expect(isSafeExternalUrl("HTTP://EXAMPLE.INVALID")).toBe(true);
    expect(isSafeExternalUrl("file:///")).toBe(false);
    expect(isSafeExternalUrl("javascript:void(0)")).toBe(false);
    expect(isSafeExternalUrl("/relative")).toBe(false);
    expect(isSafeExternalUrl(`https://example.invalid/${"a".repeat(9_000)}`)).toBe(false);
  });

  it("main's door opens http and https from the app's own page only", () => {
    const opened: string[] = [];
    registered.on.clear();
    registerIpc({ hosts: { backend: () => null, list: () => [], refresh: async () => undefined }, openLink: (url: string) => opened.push(url) } as never);
    const door = registered.on.get(IPC.openLink)!;
    const page = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
    door(page, "https://example.invalid/ok");
    door(page, "http://example.invalid/ok2");
    door(page, "javascript:alert(1)");
    door(page, "file:///etc/passwd");
    door(page, 42);
    door(page, { href: "https://example.invalid" });
    door({ senderFrame: { url: "https://evil.invalid" }, sender: { id: 2 } }, "https://example.invalid/from-elsewhere");
    expect(opened).toEqual(["https://example.invalid/ok", "http://example.invalid/ok2"]);
  });
});
