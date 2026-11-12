// Stop is a plain Esc. Each press of the square, and each Esc in Chat, sends one Esc to the
// pane on screen at once, as pressing Esc in its terminal: no fresh snapshot,
// no refusal, no episode check, no latch, no blocking window. A second press
// sends a second Esc. The square shows a spinner ("Stopping…") after a press
// until Herdr reports the agent not working, or 10 s pass: a look only. The
// real Composer runs on the small hooks host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { HookHost, elements } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts, draftKey } = await import("../src/renderer/components/composer-drafts");
const { agentStops } = await import("../src/renderer/components/agent-stop");

interface StopCall {
  readonly binding: { readonly episode: { readonly seq: string | null } };
  resolve(note: string | null): void;
}
let stops: StopCall[] = [];
let listeners: { type: string; fn: (event: unknown) => void }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  stops = [];
  listeners = [];
  composerDrafts.clear();
  agentStops.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: () => Promise.resolve(),
      stopAgent: (_h: string, _p: string, binding: StopCall["binding"]) => new Promise<string | null>((resolve) => stops.push({ binding, resolve })),
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.push({ type, fn }),
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners = listeners.filter((l) => l.type !== type || l.fn !== fn);
    },
  });
  vi.stubGlobal("document", { body: {}, activeElement: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function topologyOf(status: string, seq = 12): SessionTopology {
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
        state_change_seq: seq,
        status_since_unix_ms: 1_762_000_000_000,
        agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-1" },
      },
    ],
  });
}

const hostOf = (status = "working", seq = 12): HostView =>
  ({ id: "mac-mini", name: "Mac mini", state: "connected", topology: topologyOf(status, seq), connection: 3, incarnation: 1, epoch: 7 }) as HostView;
const rowOf = (status = "working"): SidebarRow =>
  ({ paneID: "w1:p1", name: "claude 1", workspaceLabel: "ops", isAgent: true, kind: "claude", status, glyph: status === "working" ? "working" : "idle" }) as SidebarRow;

function box(status = "working") {
  const props = { host: hostOf(status), row: rowOf(status), floating: true, stops: true };
  const ui = new HookHost(Composer as (p: object) => unknown, props);
  ui.render();
  const button = (label: string) => elements(ui.tree).find((e) => e.type === "button" && e.props["aria-label"] === label);
  const esc = () => {
    const event = { key: "Escape", metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, preventDefault() {}, target: null };
    for (const l of listeners.filter((x) => x.type === "keydown")) l.fn(event);
  };
  return {
    ui,
    esc,
    stop: () => button("Stop"),
    send: () => button("Send"),
    press: () => (button("Stop")!.props["onClick"] as () => void)(),
    show: (next: string, seq = 12) => ui.render({ ...props, host: hostOf(next, seq), row: rowOf(next) }),
  };
}

const key = draftKey("mac-mini", "w1:p1");

describe("the two-Esc case", () => {
  it("one press sends one Esc at once; a second press 2.5 s later, still working, sends a second (as the terminal would)", async () => {
    const c = box();
    c.press();
    expect(stops).toHaveLength(1);
    stops[0]!.resolve(null);
    await flush();
    vi.advanceTimersByTime(2_500);
    c.ui.render();
    c.press();
    expect(stops).toHaveLength(2);
    expect(agentStops.note(key)).toBeNull();
    c.ui.unmount();
  });

  it("Esc in Chat is one Esc per press too", () => {
    const c = box();
    c.esc();
    c.esc();
    expect(stops).toHaveLength(2);
    c.ui.unmount();
  });

  it("after a press the square shows Stopping… with a spinner; status idle gives Send back and no note", async () => {
    const c = box();
    c.press();
    stops[0]!.resolve(null);
    await flush();
    c.ui.render();
    expect(c.stop()?.props["title"]).toBe("Stopping…");
    expect(c.stop()?.props["aria-busy"]).toBe(true);
    c.show("idle");
    expect(c.stop()).toBeUndefined();
    expect(c.send()).toBeDefined();
    expect(agentStops.isStopping(key)).toBe(false);
    expect(agentStops.note(key)).toBeNull();
    c.ui.unmount();
  });

  it("the spinner is a look only: 10 s still working brings the square back, and every press meanwhile sent", async () => {
    const c = box();
    c.press();
    vi.advanceTimersByTime(9_000);
    c.ui.render();
    expect(c.stop()?.props["aria-busy"]).toBe(true);
    c.press();
    expect(stops).toHaveLength(2);
    vi.advanceTimersByTime(10_001);
    c.ui.render();
    expect(c.stop()?.props["aria-busy"]).toBe(false);
    expect(c.stop()?.props["title"]).toBe("Stop (Esc)");
    c.press();
    expect(stops).toHaveLength(3);
    c.ui.unmount();
  });
});

describe("moved on", () => {
  it("working with a newer state_change_seq than the page saw: Esc goes, no note", async () => {
    const c = box();
    c.show("working", 40);
    c.press();
    expect(stops).toHaveLength(1);
    stops[0]!.resolve(null);
    await flush();
    expect(agentStops.note(key)).toBeNull();
    c.ui.unmount();
  });
});

describe("a key that cannot go", () => {
  it("leaves one short note and ends the spinner", async () => {
    const c = box();
    c.press();
    stops[0]!.resolve("Esc did not go: Mac mini is offline");
    await flush();
    expect(agentStops.note(key)).toBe("Esc did not go: Mac mini is offline");
    expect(agentStops.isStopping(key)).toBe(false);
    c.ui.unmount();
  });
});
