// Every composer note (send, stop,
// restart, the card's box notes from prompt/view.ts, a pick's) shows on the one
// note line under the message box, in full and wrapping, never in the chip row;
// the chips keep their sizes. A note clears when the agent's status changes, on
// the next send, or after 8 s. The real Composer runs on the small hooks host.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements } from "./support/fake-hooks";

type Element = ReturnType<typeof elements>[number];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops } = await import("../src/renderer/components/agent-stop");
const { agentRestarts } = await import("../src/renderer/components/restart");

let stops: { resolve(note: string | null): void }[] = [];
let sends: { reject(error: Error): void; resolve(): void }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  stops = [];
  sends = [];
  composerDrafts.clear();
  agentStops.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => new Promise<void>((resolve, reject) => sends.push({ resolve, reject })),
      stopAgent: () => new Promise<string | null>((resolve) => stops.push({ resolve })),
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", { body: {}, activeElement: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function topologyOf(status: string): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [],
    tabs: [],
    panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: status, revision: 1 }],
    layouts: [],
    agents: [
      {
        pane_id: "w1:p1",
        agent: "claude",
        agent_status: status,
        terminal_id: "t-7",
        state_change_seq: 12,
        agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" },
      },
    ],
  });
}

const hostOf = (status: string): HostView =>
  ({ id: "mac-mini", name: "Mac mini", state: "connected", topology: topologyOf(status), connection: 3, incarnation: 1, epoch: 7 }) as HostView;
const rowOf = (status: string): SidebarRow =>
  ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "aurora-web", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle" }) as SidebarRow;

const textOf = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node !== null && "props" in node) return textOf((node as Element).props["children"]);
  return "";
};

function box(status = "working") {
  const props = { host: hostOf(status), row: rowOf(status), floating: true, stops: true };
  const ui = new HookHost(Composer as (p: object) => unknown, props);
  ui.render();
  const all = () => elements(ui.tree);
  const byClass = (name: string) => all().find((e) => String(e.props["className"] ?? "").split(" ").includes(name));
  return {
    ui,
    bar: () => byClass("cmp-bar")!,
    boxEl: () => byClass("cmp")!,
    note: () => byClass("cmp-note"),
    noteText: () => {
      const n = byClass("cmp-note");
      return n === undefined ? null : textOf(n.props["children"]);
    },
    press: () => (all().find((e) => e.type === "button" && e.props["aria-label"] === "Stop")!.props["onClick"] as () => void)(),
    type: (value: string) => (all().find((e) => e.type === "textarea")!.props["onChange"] as (e: unknown) => void)({ target: { value } }),
    send: () => (all().find((e) => e.type === "button" && e.props["aria-label"] === "Send")!.props["onClick"] as () => void)(),
    show: (next: string) => ui.render({ ...props, host: hostOf(next), row: rowOf(next) }),
    /** The chip row's chips as (class, title): the folder's and the machine's included. */
    chips: () => elements(byClass("cmp-bar")!).filter((e) => String(e.props["className"] ?? "").split(" ").includes("chip")).map((e) => [e.props["className"], e.props["title"]]),
  };
}

const key = draftKey("mac-mini", "w1:p1");
const long = "Esc did not go: another program is in this pane now";

describe("the note line under the box", () => {
  it("a stop's note shows in full on its own line, outside the chip row; the chips stay as they were", async () => {
    const c = box();
    const before = c.chips();
    c.press();
    stops[0]!.resolve(long);
    await flush();
    c.ui.render();
    expect(c.noteText()).toBe(long);
    expect(textOf(c.bar().props["children"])).not.toContain("Esc did not go");
    expect(elements(c.boxEl()).includes(c.note()!)).toBe(false);
    expect(c.chips()).toEqual(before);
    expect(before.map((chip) => chip[1])).toEqual(expect.arrayContaining(["The workspace", "The machine"]));
    c.ui.unmount();
  });

  it("the pane gone: the same, its full text", async () => {
    const c = box();
    c.press();
    stops[0]!.resolve("Esc did not go: the pane is gone");
    await flush();
    c.ui.render();
    expect(c.noteText()).toBe("Esc did not go: the pane is gone");
    c.ui.unmount();
  });

  it("a send's note shows there too, never in the chip row", async () => {
    const c = box("idle");
    c.type("ship it");
    c.send();
    sends[0]!.reject(new Error("Not sent: Claude Code did not take the message. It is still in the box."));
    await flush();
    c.ui.render();
    expect(c.noteText()).toBe("Not sent: Claude Code did not take the message. It is still in the box.");
    expect(textOf(c.bar().props["children"])).not.toContain("Not sent");
    c.ui.unmount();
  });

  it("a restart's note shows there too", () => {
    const c = box("idle");
    agentRestarts.restart("mac-mini|w1:p1", () => new Promise(() => undefined), "Restarting Claude…");
    c.ui.render();
    expect(c.noteText()).toBe("Restarting Claude…");
    agentRestarts.dismiss("mac-mini|w1:p1");
    c.ui.unmount();
  });

  it("the stylesheet lets the note wrap in full", () => {
    const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
    const rule = css.split("\n").find((line) => line.startsWith(".cmp-note {")) ?? "";
    expect(rule).toContain("white-space: normal");
    expect(rule).not.toContain("ellipsis");
  });
});

describe("a note clears", () => {
  const noted = async () => {
    const c = box();
    c.press();
    stops[0]!.resolve(long);
    await flush();
    c.ui.render();
    expect(c.noteText()).toBe(long);
    return c;
  };

  it("when the agent's status changes", async () => {
    const c = await noted();
    c.show("idle");
    c.ui.render();
    expect(c.noteText()).toBeNull();
    expect(agentStops.note(key)).toBeNull();
    c.ui.unmount();
  });

  it("on the next send", async () => {
    const c = await noted();
    c.type("go on");
    c.ui.render();
    (elements(c.ui.tree).find((e) => e.type === "button" && e.props["aria-label"] === "Send")!.props["onClick"] as () => void)();
    c.ui.render();
    expect(c.noteText()).toBeNull();
    c.ui.unmount();
  });

  it("after 8 s", async () => {
    const c = await noted();
    vi.advanceTimersByTime(7_900);
    c.ui.render();
    expect(c.noteText()).toBe(long);
    vi.advanceTimersByTime(200);
    c.ui.render();
    expect(c.noteText()).toBeNull();
    c.ui.unmount();
  });
});
