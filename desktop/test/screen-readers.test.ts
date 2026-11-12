// Four live panes stay cheap. Each tile's reader
// (its Chat feed, or its terminal's attach) runs only while the tile is on
// screen: it ends with the tile (another tab, a zoom, a close) and with its
// view (Chat and Terminal swap readers). A window out of sight (minimized or
// hidden) pauses its Chat feeds until it is back, showing what it had; its
// terminals stay attached. And the frame probe: its flag and its numbers.

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  const hooks = { ...fakeReact, useLayoutEffect: fakeReact.useEffect };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { followWindowSight } from "../src/main/window-sight";
import { HostRegistry } from "../src/main/hosts";
import { parseLaunchOptions } from "../src/main/launch-options";
import { decodeSessionTopology } from "../src/main/herdr/wire";
import { frameStats } from "../src/shared/frame-probe";
import type { ChatUpdateEvent, HostView } from "../src/shared/ipc-contract";
import type { SidebarRow } from "../src/shared/sidebar-model";
import { eventually } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { HookHost, elements } from "./support/fake-hooks";

const { ChatView } = await import("../src/renderer/chat/ChatView");
const { TerminalTab } = await import("../src/renderer/components/MainPane");

// MARK: - A tile's readers end with it

const host: HostView = {
  id: "host",
  name: "Mac mini",
  kind: "ssh",
  address: "fixture",
  platform: null,
  state: "connected",
  error: null,
  fetchedAtMs: 0,
  topology: decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [{ pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/fixture", agent: "claude", agent_status: "idle", revision: 1 }],
    layouts: [],
    agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }],
  }),
};
const row = { paneID: "w1:p1", status: "idle", name: "claude", kind: "claude", workspaceLabel: "app", isAgent: true } as unknown as SidebarRow;

function browser(calls: string[]): void {
  vi.stubGlobal("window", {
    herdrDesktop: {
      onChatUpdate: () => () => undefined,
      openChat: (hostId: string, paneId: string, slot?: string) => calls.push(`openChat ${hostId} ${paneId} ${slot ?? "-"}`),
      closeChat: (slot?: string) => calls.push(`closeChat ${slot ?? "-"}`),
      setChatFollowing: () => undefined,
      copyText: () => undefined,
      openTerminal: (request: { paneId: string }) => {
        calls.push(`openTerminal ${request.paneId}`);
        return Promise.resolve({ sessionId: "s1" });
      },
      closeTerminal: (sessionId: string) => calls.push(`closeTerminal ${sessionId}`),
      terminalResize: () => undefined,
      terminalInput: () => undefined,
      onTerminalData: () => () => undefined,
      onTerminalExit: () => () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => null,
  });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("a tile's readers run only while it is on screen", () => {
  it("a tile's Chat follows its pane in its own slot and stops when the tile goes", () => {
    const calls: string[] = [];
    browser(calls);
    const view = new HookHost(ChatView as (props: object) => unknown, { host, row, tile: true, onShowTerminal: () => undefined });
    view.render();
    expect(calls).toEqual(["openChat host w1:p1 host/w1:p1"]);
    view.unmount();
    expect(calls).toEqual(["openChat host w1:p1 host/w1:p1", "closeChat host/w1:p1"]);
  });

  it("a tile's terminal attaches when laid out and detaches when the tile goes", async () => {
    const calls: string[] = [];
    browser(calls);
    const view = new HookHost(TerminalTab as (props: object) => unknown, { host, row, fontSize: 13, focusSignal: 0, autoFocus: false });
    view.render();
    const terminal = elements(view.tree).find((element) => typeof element.type === "function" && (element.type as { name: string }).name === "TerminalView")!;
    expect(terminal.props["autoFocus"]).toBe(false);
    // Nothing attaches before the view lays the terminal out.
    expect(calls).toEqual([]);
    (terminal.props["port"] as { resize(cols: number, rows: number): void }).resize(80, 24);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(calls).toEqual(["openTerminal w1:p1"]);
    view.unmount();
    expect(calls).toEqual(["openTerminal w1:p1", "closeTerminal s1"]);
  });
});

// MARK: - A window out of sight pauses its Chat feeds

class Page implements ChatOwner {
  readonly updates: ChatUpdateEvent[] = [];
  constructor(readonly id: number) {}
  send(_channel: string, payload: ChatUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return false;
  }
  lastFor(paneId: string): ChatUpdateEvent | undefined {
    return this.updates.filter((update) => update.paneId === paneId).at(-1);
  }
}

async function demoChats() {
  const registry = new HostRegistry(() => undefined);
  const fixtures = bundledFixturesForTests();
  for (const demo of demoHosts(fixtures, Date.now())) registry.add(demo.descriptor, new DemoBackend(demo, fixtures));
  await registry.refreshAll();
  const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
  const backend = registry.backend(demoHostIds.macMini) as DemoBackend;
  return { registry, service, backend };
}

describe("a window out of sight", () => {
  it("pauses its tiles' Chat feeds, keeps what they showed, and catches up when it is back", async () => {
    const { registry, service, backend } = await demoChats();
    const page = new Page(1);
    const other = new Page(2);
    service.open(page, demoHostIds.macMini, "w7:p1G", "host/w7:p1G");
    service.open(page, demoHostIds.macMini, "w7:p1H", "host/w7:p1H");
    service.open(other, demoHostIds.macMini, "w7:p1H", "host/w7:p1H");
    await eventually(() => ["w7:p1G", "w7:p1H"].every((pane) => page.lastFor(pane)?.state.status === "live") && other.lastFor("w7:p1H")?.state.status === "live");
    const turns = page.lastFor("w7:p1H")!.timeline.turns.length;
    service.setPaused(page, true);
    expect(service.paused(page)).toBe(true);
    const sent = page.updates.length;
    backend.transcripts().record("w7:p1H", "written while the window was minimized", false, Date.now());
    // The other window, in sight, follows on.
    await eventually(() => other.lastFor("w7:p1H")!.timeline.turns.length === turns + 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Nothing reached the paused window: no idle, no empty timeline, no new line.
    expect(page.updates.length).toBe(sent);
    // A snapshot while paused starts nothing.
    service.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.updates.length).toBe(sent);
    service.setPaused(page, false);
    await eventually(() => page.lastFor("w7:p1H")!.timeline.turns.length === turns + 1);
    // Back without a "loading" flash: it showed the old timeline until the new one came.
    expect(page.updates.slice(sent).some((update) => update.state.status === "loading")).toBe(false);
    expect(page.lastFor("w7:p1G")?.state.status).toBe("live");
    service.closeAll();
    registry.close();
  });

  it("a Chat opened while out of sight starts when the window is back", async () => {
    const { registry, service } = await demoChats();
    const page = new Page(1);
    service.setPaused(page, true);
    service.open(page, demoHostIds.macMini, "w7:p1G", "host/w7:p1G");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(page.lastFor("w7:p1G")?.state.status ?? "none").not.toBe("live");
    service.setPaused(page, false);
    await eventually(() => page.lastFor("w7:p1G")?.state.status === "live");
    service.closeAll();
    registry.close();
  });

  it("follows the window: minimized or hidden pauses, restored or shown resumes", () => {
    const window = new EventEmitter() as EventEmitter & { isMinimized(): boolean; isVisible(): boolean };
    let minimized = false;
    let visible = true;
    window.isMinimized = () => minimized;
    window.isVisible = () => visible;
    const states: boolean[] = [];
    const stop = followWindowSight(window, (paused) => states.push(paused));
    minimized = true;
    window.emit("minimize");
    minimized = false;
    window.emit("restore");
    visible = false;
    window.emit("hide");
    visible = true;
    window.emit("show");
    expect(states).toEqual([true, false, true, false]);
    stop();
    window.emit("minimize");
    expect(states).toHaveLength(4);
  });
});

// MARK: - The frame probe

describe("the frame probe", () => {
  it("has its own flag, which runs the demo", () => {
    expect(parseLaunchOptions(["--splits-probe=/tmp/z/probe.json"])).toMatchObject({ demo: true, probeFile: "/tmp/z/probe.json" });
    expect(parseLaunchOptions(["--demo"]).probeFile).toBeNull();
  });

  it("reads frame times and long tasks into fps, percentiles and a verdict", () => {
    const smooth = frameStats(Array(600).fill(1000 / 60), [], 10_000);
    expect(smooth).toMatchObject({ frames: 600, fps: 60, p50Ms: 16.7, p95Ms: 16.7, maxMs: 16.7, slowFrames: 0, longTasks: 0, longestTaskMs: 0, smooth: true });
    const janky = frameStats([...Array(500).fill(1000 / 60), ...Array(20).fill(70)], [{ durationMs: 64 }, { durationMs: 40 }], 10_000);
    expect(janky).toMatchObject({ frames: 520, fps: 52, maxMs: 70, slowFrames: 20, longTasks: 2, longTasksOver50: 1, longestTaskMs: 64, smooth: false });
    expect(janky.p95Ms).toBe(16.7);
    expect(janky.p99Ms).toBe(70);
  });
});
