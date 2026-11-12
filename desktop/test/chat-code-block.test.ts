// A code block's header actions, on the small hooks
// host (test/support/fake-hooks.ts). Wrap is a pressed toggle that wraps the
// body; Copy gives the code to the clipboard and turns into a check reading
// "Copied" for 1.2 s, as T3 Code's does.

import { afterEach, describe, expect, it, vi } from "vitest";

import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { CodeBlock } = await import("../src/renderer/chat/Markdown");

afterEach(() => {
  vi.useRealTimers();
});

const button = (tree: unknown, label: string) => elements(tree).find((e) => e.type === "button" && e.props["aria-label"] === label);
const pre = (tree: unknown) => elements(tree).find((e) => e.type === "pre")!;

describe("a code block's header", () => {
  it("wraps the body while Wrap is pressed, and unwraps it again", () => {
    const ui = new HookHost(CodeBlock as (props: object) => unknown, { language: "sh", text: "echo hi", onCopy: () => undefined });
    ui.render();
    expect(pre(ui.tree).props["className"]).toBe("md-code-b");
    expect(button(ui.tree, "Wrap lines")?.props["aria-pressed"]).toBe(false);
    (button(ui.tree, "Wrap lines")!.props["onClick"] as () => void)();
    expect(button(ui.tree, "Wrap lines")?.props["aria-pressed"]).toBe(true);
    expect(pre(ui.tree).props["className"]).toBe("md-code-b wrap");
    (button(ui.tree, "Wrap lines")!.props["onClick"] as () => void)();
    expect(pre(ui.tree).props["className"]).toBe("md-code-b");
    ui.unmount();
  });

  it("copies the code, then reads Copied with a check for 1.2 s", () => {
    vi.useFakeTimers();
    const copied: string[] = [];
    const ui = new HookHost(CodeBlock as (props: object) => unknown, { language: "ts", text: "const a = 1", onCopy: (text: string) => copied.push(text) });
    ui.render();
    (button(ui.tree, "Copy code")!.props["onClick"] as () => void)();
    expect(copied).toEqual(["const a = 1"]);
    const done = button(ui.tree, "Copied");
    expect(done?.props["className"]).toBe("md-act done");
    expect(elements(done).some((e) => typeof e.type === "function" && (e.type as { name: string }).name === "CheckIcon")).toBe(true);
    vi.advanceTimersByTime(1_199);
    expect(button(ui.tree, "Copied")).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(button(ui.tree, "Copy code")).toBeDefined();
    ui.unmount();
  });
});
