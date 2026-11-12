// The message box stays steady while the agent works. The flicker probe
// (src/main/flicker-probe.ts) checks the box's DOM, height, the chat's bottom
// inset, the ring and the chips over a live demo transcript. A backdrop-filter
// on the box would be touched on every frame: the spinners' damage covers nearly
// the whole window at 60 fps, so a blur render pass would be re-rasterized on
// every compositor frame over the chat under it. The box has an opaque fill of
// the same colour over the window's black (the raised ground, Halo #1a1b1e, at
// 80% over #000 is #151618): no render pass of its own, nothing re-blurred per
// frame. The floating box and its gradient stay.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { MainPane, Composer } = await import("../src/renderer/components/MainPane");
const { ChatView } = await import("../src/renderer/chat/ChatView");

const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = css.match(new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`));
  if (found === null) throw new Error(`no rule ${selector}`);
  return found[2]!;
}

describe("the floating box over a live chat", () => {
  it("has no backdrop-filter of its own: nothing it shows is re-blurred on every frame the chat redraws", () => {
    expect(rule(".cmp")).not.toMatch(/backdrop-filter/);
  });

  it("keeps its colour, opaque: rgba(26, 26, 28, 0.8) over the window's black", () => {
    expect(rule(".cmp")).toMatch(/background: #151618;/);
  });

  it("keeps the floating box's gradient under it", () => {
    expect(rule(".cmp-wrap.float::before")).toMatch(/linear-gradient/);
  });

  it("keeps the same Composer and Chat over live updates of the pane (no key or parent change remounts them)", () => {
    vi.stubGlobal("window", { herdrDesktop: {}, addEventListener: () => undefined, removeEventListener: () => undefined });
    const props = (n: number) => ({
      host: { id: "mac-mini", name: "Mac mini", state: "connected", topology: null, fetchedAtMs: n } as unknown as HostView,
      row: { paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status: "working", glyph: "working", time: `${n}s` } as unknown as SidebarRow,
      tab: "chat" as const,
      onTab: () => undefined,
      mac: true,
      fontSize: 13,
      boxShown: false,
      onBoxShown: () => undefined,
      ghostty: { shown: false, enabled: false, reason: "" },
      onOpenInGhostty: () => undefined,
    });
    const pane = new HookHost(MainPane as (p: object) => unknown, props(0));
    const shapes: string[] = [];
    for (let n = 0; n < 30; n += 1) {
      pane.render(props(n));
      const chat = elements(pane.tree).find((e) => e.props["className"] === "chat-area")!;
      const children = (chat.props["children"] as { type: unknown; key: string | null }[]).map((c) => `${c.type === ChatView ? "ChatView" : c.type === Composer ? "Composer" : "?"}:${c.key}`);
      shapes.push(children.join(","));
    }
    expect(new Set(shapes)).toEqual(new Set(["ChatView:mac-mini/w1:p1,Composer:null"]));
    vi.unstubAllGlobals();
  });
});
