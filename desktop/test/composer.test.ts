// The composer's draft, sending state and send result
// belong to one pane on one machine. A send to pane A that completes after the
// user moved to pane B must not clear or flag B's draft; on the same pane,
// text typed while the send was in flight stays. The real Composer runs here
// on a small hooks host (test/support/fake-hooks.ts) with a fake bridge.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { HookHost, find } from "./support/fake-hooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, default: { ...actual, ...fakeReact } };
});

const { Composer } = await import("../src/renderer/components/MainPane");
const { composerDrafts } = await import("../src/renderer/components/composer-drafts");

interface Pending {
  readonly hostId: string;
  readonly paneId: string;
  readonly text: string;
  readonly binding: unknown;
  resolve(): void;
  reject(error: Error): void;
}

let sends: Pending[] = [];

beforeEach(() => {
  sends = [];
  composerDrafts.clear();
  vi.stubGlobal("window", {
    herdrDesktop: {
      sendToPane: (hostId: string, paneId: string, text: string, binding: unknown) =>
        new Promise<void>((resolve, reject) => sends.push({ hostId, paneId, text, binding, resolve, reject })),
    },
  });
});

const mac = { id: "mac-mini", name: "Mac mini" } as HostView;
const box = { id: "build-box", name: "build-box" } as HostView;
const row = (paneID: string, name: string) => ({ paneID, name, workspaceLabel: "ops" }) as SidebarRow;
const paneA = row("w1:p1", "A");
const paneB = row("w1:p2", "B");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function composer(hostView: HostView, pane: SidebarRow) {
  const ui = new HookHost(Composer, { host: hostView, row: pane });
  ui.render();
  const textarea = () => find(ui.tree, "textarea")!;
  return {
    ui,
    show: (h: HostView, p: SidebarRow) => ui.render({ host: h, row: p }),
    type: (value: string) => (textarea().props["onChange"] as (e: unknown) => void)({ target: { value } }),
    enter: () =>
      (textarea().props["onKeyDown"] as (e: unknown) => void)({
        key: "Enter",
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => undefined,
      }),
    value: () => textarea().props["value"],
    error: () => find(ui.tree, "span", "cmp-note-t")?.props["children"], // the note line under the box
  };
}

describe("the composer", () => {
  it("binds each send to the pane as shown when Send was pressed", () => {
    const topology = decodeSessionTopology({
      version: "0.9.5",
      protocol: 22,
      workspaces: [],
      tabs: [],
      panes: [{ pane_id: "w1:p1", terminal_id: "t-7", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "opencode", agent_status: "idle", revision: 1 }],
      layouts: [],
      agents: [{ pane_id: "w1:p1", agent: "opencode", agent_status: "idle", agent_session: { source: "herdr:opencode", agent: "opencode", kind: "id", value: "s-1" } }],
    });
    const c = composer({ ...mac, topology } as HostView, { ...paneA, isAgent: true } as SidebarRow);
    c.type("hello");
    c.enter();
    c.enter();
    expect(sends.map((s) => [s.paneId, s.text, s.binding])).toEqual([
      ["w1:p1", "hello", { terminalID: "t-7", isAgent: true, kind: "opencode", session: "s-1" }],
    ]);
    c.ui.unmount();
  });

  it("sends the draft and clears it when the send succeeds", async () => {
    const c = composer(mac, paneA);
    c.type("hello");
    c.enter();
    expect(sends.map((s) => [s.hostId, s.paneId, s.text])).toEqual([["mac-mini", "w1:p1", "hello"]]);
    sends[0]!.resolve();
    await flush();
    expect(c.value()).toBe("");
  });

  it("keeps the new pane's draft when an old send to another pane completes", async () => {
    const c = composer(mac, paneA);
    c.type("message for a");
    c.enter();
    c.show(mac, paneB);
    c.type("new unsent draft for b");
    sends[0]!.resolve();
    await flush();
    expect(c.value()).toBe("new unsent draft for b");
    expect(c.error()).toBeUndefined();
  });

  it("puts an old send's failure on its own pane, not on the one shown", async () => {
    const c = composer(mac, paneA);
    c.type("message for a");
    c.enter();
    c.show(mac, paneB);
    c.type("draft for b");
    sends[0]!.reject(new Error("Error invoking remote method 'herdr:pane-send': Error: not connected"));
    await flush();
    expect(c.value()).toBe("draft for b");
    expect(c.error()).toBeUndefined();
    c.show(mac, paneA);
    expect(c.value()).toBe("message for a");
    expect(c.error()).toBe("not connected");
  });

  it("keeps the draft and shows the note when a paste was typed but its Return withheld", async () => {
    const c = composer(mac, paneA);
    c.type("deploy it");
    c.enter();
    const note = "Typed into opencode, but the agent left, so no Return was pressed. Check the terminal before sending again.";
    sends[0]!.reject(new Error(`Error invoking remote method 'herdr:pane-send': Error: ${note}`));
    await flush();
    expect(c.value()).toBe("deploy it");
    expect(c.error()).toBe(note);
  });

  it("keeps text typed on the same pane while the send was in flight", async () => {
    const c = composer(mac, paneA);
    c.type("first");
    c.enter();
    c.type("first, and a second thought");
    sends[0]!.resolve();
    await flush();
    expect(c.value()).toBe("first, and a second thought");
  });

  it("lets another pane send while one send is in flight", () => {
    const c = composer(mac, paneA);
    c.type("to a");
    c.enter();
    c.show(mac, paneB);
    c.type("to b");
    c.enter();
    expect(sends.map((s) => s.paneId)).toEqual(["w1:p1", "w1:p2"]);
  });

  it("keeps the same pane id on two machines apart", async () => {
    const c = composer(mac, paneA);
    c.type("for the mac");
    c.enter();
    c.show(box, paneA);
    c.type("for the box");
    sends[0]!.resolve();
    await flush();
    expect(c.value()).toBe("for the box");
  });
});
