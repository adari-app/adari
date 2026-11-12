// The message box as T3 Code's composer. It floats at
// the bottom of the chat column (the chat scrolls under it and keeps its last
// row clear by the box's height), its controls sit in one row (the agent's
// chip, the workspace and the machine, attach, Send), and its placeholder asks
// "Ask for changes, send follow-ups, or attach images". The real Composer and
// MainPane run on the small hooks host (test/support/fake-hooks.ts).

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GhosttyAvailability, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer, MainPane } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");

beforeEach(() => {
  composerDrafts.clear();
  vi.stubGlobal("window", { herdrDesktop: { sendToPane: async () => undefined }, innerHeight: 900 });
});

const host = { id: "mac-mini", name: "Mac mini" } as HostView;
const agent = { paneID: "w1:p1", name: "Notes Opus", workspaceLabel: "aurora-web", kind: "claude", isAgent: true, glyph: "working", status: "working" } as unknown as SidebarRow;
const codex = { ...agent, kind: "codex" } as SidebarRow;
const shell = { ...agent, name: "build", kind: "zsh", isAgent: false, glyph: "shell" } as unknown as SidebarRow;

const text = (node: unknown): string =>
  elements(node)
    .map((e) => e.props.children)
    .flat()
    .filter((child): child is string => typeof child === "string")
    .join("");

function composer(row: SidebarRow, props: Record<string, unknown> = {}) {
  const ui = new HookHost(Composer as (props: object) => unknown, { host, row, ...props });
  ui.render();
  return ui;
}

describe("the composer's look", () => {
  it("asks for changes, follow-ups or images in an agent's box, and for a command in a shell's", () => {
    expect(find(composer(agent).tree, "textarea")?.props["placeholder"]).toBe("Ask for changes, send follow-ups, or attach images");
    expect(find(composer(shell).tree, "textarea")?.props["placeholder"]).toBe("Type a command for build");
  });

  it("puts its controls in one row under the text: the agent, the workspace, the machine, then attach and Send", () => {
    const tree = composer(agent).tree;
    const bar = find(tree, "div", "cmp-bar")!;
    // The hidden file input (the attach picker) sits beside attach; it shows nothing.
    const row = (bar.props.children as unknown[])
      .flat()
      .filter((child) => child !== null && child !== false && (child as { type?: unknown }).type !== "input") as { props: Record<string, unknown> }[];
    // The Model and Effort chips right after the agent (test/agent-chips.test.ts draws them);
    // the context ring just left of the paperclip (test/context-ring.test.ts).
    expect(row.map((child) => child.props["className"] ?? (child as unknown as { type: { name?: string } }).type.name)).toEqual([
      "chip agent",
      "AgentChips",
      "chip",
      "chip",
      "sp",
      "ContextRing",
      "cmp-ib",
      "send off",
    ]);
    expect(text(row[0])).toBe("Claude Code");
    expect(text(row[2])).toBe("aurora-web");
    expect(text(row[3])).toBe("Mac mini");
    expect(row[6]!.props["aria-label"]).toBe("Attach files");
    expect(row[7]!.props["aria-label"]).toBe("Send");
    // No chip strip above the box any more: the row carries it.
    expect(elements(tree).some((e) => e.props["className"] === "strip")).toBe(false);
    expect(text(find(composer(codex).tree, "span", "chip agent"))).toBe("Codex");
  });

  it("shows the error in the row in place of nothing, and keeps the Send key hint in Send's tooltip", () => {
    const ui = composer(agent);
    expect(find(ui.tree, "button", "send off")?.props["title"]).toBe("Send (Return) · Shift-Return for a new line");
    expect(find(ui.tree, "span", "hint")).toBeUndefined();
  });

  // The paperclip opens the picker.
  it("attaches: the paperclip opens the picker for images and files", () => {
    const tree = composer(agent).tree;
    const clip = find(tree, "button", "cmp-ib")!;
    expect(clip.props["aria-disabled"]).toBeUndefined();
    expect(clip.props["title"]).toBe("Attach images or files");
    const input = elements(tree).find((e) => e.type === "input" && e.props["type"] === "file")!;
    expect(input.props["hidden"]).toBe(true);
    expect(input.props["multiple"]).toBe(true);
    const clicked: string[] = [];
    (input.props["ref"] as { current: unknown }).current = { click: () => clicked.push("picker") };
    (clip.props["onClick"] as () => void)();
    expect(clicked).toEqual(["picker"]);
  });
});

describe("the box floats over the chat", () => {
  const ghostty: GhosttyAvailability = { shown: false };

  it("sits in the chat area with the chat, which keeps its end clear by the box's height", () => {
    const props = { host, row: agent, tab: "chat", onTab: () => undefined, mac: true, fontSize: 13, boxShown: false, onBoxShown: () => undefined, ghostty, onOpenInGhostty: () => undefined };
    const main = new HookHost(MainPane as (props: object) => unknown, props);
    main.render();
    const area = find(main.tree, "div", "chat-area")!;
    const named = (name: string) => elements(area).find((e) => typeof e.type === "function" && (e.type as { name: string }).name === name)!;
    expect(named("Composer").props["floating"]).toBe(true);
    expect(named("ChatView").props["bottomInset"]).toBe(0);
    (named("Composer").props["onHeight"] as (height: number) => void)(152);
    expect(elements(find(main.tree, "div", "chat-area")).find((e) => typeof e.type === "function" && (e.type as { name: string }).name === "ChatView")!.props["bottomInset"]).toBe(152);
    main.unmount();
  });

  // Opaque, not frosted: a blur would be re-rasterized on every frame (a flicker).
  it("is a card at T3's shape over the bottom of the column", () => {
    const sheet = ["app.css", "chat.css"].map((name) => readFileSync(new URL(`../src/renderer/styles/${name}`, import.meta.url), "utf8")).join("\n");
    const body = (selector: string) =>
      [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter((match) => match[1]!.split(",").some((part) => part.trim() === selector))
        .map((match) => match[2]!)
        .join(";");
    expect(body(".cmp-wrap.float")).toMatch(/position:\s*absolute/);
    expect(body(".cmp-wrap.float")).toMatch(/bottom:\s*0/);
    expect(body(".cmp")).toMatch(/border-radius:\s*16px/);
    expect(body(".cmp")).not.toMatch(/backdrop-filter/);
    expect(body(".cmp")).toMatch(/background:\s*#151618/);
  });
});
