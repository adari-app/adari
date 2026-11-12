// Text pastes into the box as text; copy works in
// Chat. Every message (the user's and the agent's) has Copy under it, as the Swift
// app's Mac Chat (CompanionChatMessageCopy: a hover button, a check once
// copied), code blocks keep theirs, right-click on a message offers Copy, and
// all of Chat's text can be selected for ⌘C (the Edit menu's Copy).

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { userMessage, type ChatItem } from "../src/shared/chat/model";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { ItemRow, CopyMessage } = await import("../src/renderer/chat/ChatView");
const { pasteTakesFiles } = await import("../src/renderer/components/attachments");

afterEach(() => vi.useRealTimers());

const path = "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-11111111-1111-4111-8111-111111111111.png";
const userItem: ChatItem = { type: "user", value: userMessage("u1", "Check the layout", 0, [{ path, mediaType: "image/png" }]) };
const reply: ChatItem = { type: "agentText", value: { id: "a1", markdown: "Done: **two** files.", time: 1 } } as ChatItem;

const byComponent = (tree: unknown, component: unknown) => elements(tree).filter((element) => element.type === component);

describe("Copy in Chat", () => {
  it("puts Copy under the user's message and under the agent's reply, with the message's text", () => {
    const copied: string[] = [];
    for (const [item, text] of [
      [userItem, "Check the layout"],
      [reply, "Done: **two** files."],
    ] as const) {
      const row = new HookHost(ItemRow as (props: object) => unknown, { item, onCopy: (t: string) => copied.push(t), onMenu: () => undefined });
      row.render();
      const buttons = byComponent(row.tree, CopyMessage);
      expect(buttons.map((button) => button.props["text"])).toEqual([text]);
    }
  });

  it("copies on click and says so for a moment (a check, then Copy again)", () => {
    vi.useFakeTimers();
    const copied: string[] = [];
    const button = new HookHost(CopyMessage as (props: object) => unknown, { text: "Check the layout", onCopy: (t: string) => copied.push(t) });
    button.render();
    const element = () => elements(button.tree).find((e) => e.type === "button")!;
    expect(element().props["aria-label"]).toBe("Copy message");
    (element().props["onClick"] as () => void)();
    expect(copied).toEqual(["Check the layout"]);
    expect(element().props["aria-label"]).toBe("Copied");
    vi.advanceTimersByTime(1_600);
    expect(element().props["aria-label"]).toBe("Copy message");
  });

  it("offers Copy on right-click of a message", () => {
    const menus: string[] = [];
    const row = new HookHost(ItemRow as (props: object) => unknown, {
      item: reply,
      onCopy: () => undefined,
      onMenu: (_event: unknown, text: string) => menus.push(text),
    });
    row.render();
    const target = elements(row.tree).find((e) => e.props["className"] === "msg-a")!;
    (target.props["onContextMenu"] as (e: unknown) => void)({ preventDefault: () => undefined });
    expect(menus).toEqual(["Done: **two** files."]);
  });

  it("lets all of Chat's text be selected for ⌘C, and keeps the Edit menu's Copy and Paste", () => {
    const css = readFileSync(new URL("../src/renderer/styles/chat.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.chat-col \{[^}]*user-select: text/);
    const menu = readFileSync(new URL("../src/main/menu.ts", import.meta.url), "utf8");
    expect(menu).toContain('{ role: "editMenu" }');
  });
});

describe("a paste into the box", () => {
  const data = (types: string[], text = "", files: unknown[] = []) => ({ types, files, getData: (type: string) => (type === "text/plain" ? text : "") });

  it("is text when it is text, multi-line kept by the box itself", () => {
    expect(pasteTakesFiles(data(["text/plain"], "line one\nline two"))).toBe(false);
  });

  it("is text when a rich text copy also carries a picture of itself", () => {
    expect(pasteTakesFiles(data(["text/plain", "text/html", "Files"], "Quarterly numbers\nline two", [{}]))).toBe(false);
    expect(pasteTakesFiles(data(["text/plain", "text/html", "Files"], "A heading", [{}]))).toBe(false);
  });

  it("is files for an image, a browser's Copy Image and a Finder copy", () => {
    expect(pasteTakesFiles(data(["Files"], "", [{}]))).toBe(true);
    expect(pasteTakesFiles(data(["text/html", "Files"], "", [{}]))).toBe(true);
    expect(pasteTakesFiles(data(["text/plain", "Files"], "report.pdf", [{}]))).toBe(true);
  });
});
