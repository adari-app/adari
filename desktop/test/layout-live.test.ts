// Following a tab's layout live: the method table
// (every Herdr method and param the splits use, confirmed or inferred), the
// `pane.layout` request, Herdr's event stream (`events.subscribe` on its own
// SSH exec, as CitadelTransport.stream does), and the window's watch: the
// shown tab's layout read once, read again on `layout.updated` and the pane
// created, closed and moved events, and when a snapshot changes the tab's
// panes; the demo's Herdr answers `pane.layout` for its tabs.

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { DemoBackend, FixtureTransport } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { HerdrClient } from "../src/main/herdr/client";
import { heldSocketCommand } from "../src/main/herdr/commands";
import { LineSplitter, classifyStreamLine, openSshEventStream, subscribeRequestLine, type EventSink } from "../src/main/herdr/events";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { layoutEventKinds, paneMethods } from "../src/main/herdr/pane-methods";
import type { HerdrTransport } from "../src/main/herdr/transport";
import { decodeSessionTopology, type SessionTopology, type TopologyPaneInfo } from "../src/main/herdr/wire";
import { LayoutService, type LayoutHosts, type LayoutOwner } from "../src/main/layouts";
import type { LayoutUpdateEvent } from "../src/shared/ipc-contract";
import type { PaneLayout } from "../src/shared/pane-layout";
import { eventually } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

class Recorder implements HerdrTransport {
  readonly lines: string[] = [];
  constructor(private readonly reply: (method: string, params: Record<string, unknown>) => unknown) {}
  roundTrip(line: string): Promise<string> {
    this.lines.push(line);
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    return Promise.resolve(JSON.stringify({ id: request.id, result: this.reply(request.method, request.params) }));
  }
  close(): void {}
  get requests(): { method: string; params: Record<string, unknown> }[] {
    return this.lines.map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  }
}

const layoutJson = (tabId: string, panes: readonly string[]) => ({
  type: "pane_layout",
  layout: {
    area: { x: 0, y: 0, width: 134, height: 45 },
    focused_pane_id: panes[0],
    panes: panes.map((pane, index) => ({ pane_id: pane, focused: index === 0, rect: { x: index * Math.floor(134 / panes.length), y: 0, width: Math.floor(134 / panes.length), height: 45 } })),
    splits: [],
    tab_id: tabId,
    workspace_id: "w7",
    zoomed: false,
  },
});

describe("the method table", () => {
  it("names every Herdr method and param the splits use, each confirmed or inferred", () => {
    const table = Object.fromEntries(Object.entries(paneMethods).map(([key, entry]) => [key, [entry.method, entry.status]]));
    expect(table).toEqual({
      layout: ["pane.layout", "confirmed"],
      split: ["pane.split", "confirmed"],
      resize: ["pane.resize", "confirmed"],
      setSplitRatio: ["layout.set_split_ratio", "confirmed"],
      zoom: ["pane.zoom", "confirmed"],
      close: ["pane.close", "confirmed"],
      focus: ["pane.focus", "confirmed"],
      focusDirection: ["pane.focus_direction", "confirmed"],
      rename: ["pane.rename", "confirmed"],
      // A row named for its tab renames the tab.
      renameTab: ["tab.rename", "confirmed"],
      subscribe: ["events.subscribe", "confirmed"],
    });
    expect(paneMethods.layout.params("w7:p4S")).toEqual({ pane_id: "w7:p4S" });
    expect(paneMethods.subscribe.params(["layout.updated"])).toEqual({ subscriptions: [{ type: "layout.updated" }] });
    expect(layoutEventKinds).toEqual(["layout.updated", "pane.created", "pane.closed", "pane.moved"]);
    for (const entry of Object.values(paneMethods)) expect(entry.basis.length).toBeGreaterThan(10);
  });

  it("pane.layout goes out with the pane and comes back as the tab's layout", async () => {
    const transport = new Recorder(() => layoutJson("w7:tZ", ["w7:p48", "w7:p4M"]));
    const layout = await new HerdrClient(transport).paneLayout("w7:p48");
    expect(transport.requests).toEqual([{ id: "herdrkit:pane.layout:1", method: "pane.layout", params: { pane_id: "w7:p48" } }]);
    expect(layout.panes.map((pane) => pane.paneId)).toEqual(["w7:p48", "w7:p4M"]);
  });
});

describe("Herdr's event stream", () => {
  it("subscribes to the layout kinds with one request line (no pane needed: they are global)", () => {
    expect(JSON.parse(subscribeRequestLine(layoutEventKinds))).toEqual({
      id: "herdrkit:events.subscribe",
      method: "events.subscribe",
      params: {
        subscriptions: [{ type: "layout.updated" }, { type: "pane.created" }, { type: "pane.closed" }, { type: "pane.moved" }],
      },
    });
  });

  it("reads the opening acknowledgement and events in both spellings (HerdrClient.classify)", () => {
    expect(classifyStreamLine('{"id":"herdrkit:events.subscribe","result":{"type":"subscription_started"}}')).toEqual({ type: "started" });
    expect(classifyStreamLine('{"event":"layout_updated","data":{"tab_id":"w7:t13"}}')).toEqual({ type: "event", kind: "layout.updated", paneId: null });
    expect(classifyStreamLine('{"event":"pane.created","data":{"pane":{"pane_id":"w7:p9"}}}')).toEqual({ type: "event", kind: "pane.created", paneId: "w7:p9" });
    expect(classifyStreamLine('{"event":"pane_agent_status_changed","data":{"pane_id":"w7:p1"}}')).toEqual({
      type: "event",
      kind: "pane.agent_status_changed",
      paneId: "w7:p1",
    });
    expect(classifyStreamLine("not json")).toEqual({ type: "other" });
  });

  it("splits lines only at newlines, so a character split across SSH packets is kept", () => {
    const splitter = new LineSplitter();
    const bytes = new TextEncoder().encode('{"event":"pane_moved","data":{"label":"é"}}\n{"ev');
    expect(splitter.push(bytes.subarray(0, 37))).toEqual([]);
    expect(splitter.push(bytes.subarray(37))).toEqual(['{"event":"pane_moved","data":{"label":"é"}}']);
    expect(splitter.push(new TextEncoder().encode('ent":"x"}\n'))).toEqual(['{"event":"x"}']);
  });

  it("holds its own SSH exec open: nc on the session's socket, the request written, stdin left open", async () => {
    const written: string[] = [];
    let ended = 0;
    let channelClosed = 0;
    let execCommand = "";
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      write: (data: string) => written.push(data),
      end: () => (ended += 1),
      close: () => (channelClosed += 1),
    });
    let clientEnded = 0;
    const client = Object.assign(new EventEmitter(), {
      exec: (command: string, callback: (error: Error | undefined, channel: unknown) => void) => {
        execCommand = command;
        callback(undefined, channel);
      },
      end: () => (clientEnded += 1),
    });
    const seen: string[] = [];
    const sink: EventSink = {
      started: () => seen.push("started"),
      event: (kind, paneId) => seen.push(`${kind} ${paneId ?? "-"}`),
      ended: (reason) => seen.push(`ended ${reason ?? "-"}`),
    };
    const config = { host: "mini.local", port: 22, username: "robin", privateKeyPath: "/keys/none", herdrSession: "default" };
    const stream = openSshEventStream(config, new PinningHostKeyPolicy(new MemoryPinStore()), layoutEventKinds, sink, () => Promise.resolve(client as never));
    await eventually(() => written.length === 1);
    expect(execCommand).toBe(heldSocketCommand("default"));
    expect(written[0]).toBe(subscribeRequestLine(layoutEventKinds) + "\n");
    channel.emit("data", Buffer.from('{"id":"herdrkit:events.subscribe","result":{"type":"subscription_started"}}\n{"event":"layout_up'));
    channel.emit("data", Buffer.from('dated","data":{}}\n{"event":"pane_closed","data":{"pane_id":"w7:p4V"}}\n'));
    expect(seen).toEqual(["started", "layout.updated -", "pane.closed w7:p4V"]);
    expect(ended).toBe(0);
    stream.close();
    expect([channelClosed, clientEnded]).toEqual([1, 1]);
    channel.emit("close");
    expect(seen.at(-1)).toBe("pane.closed w7:p4V");
  });

  it("says when the stream ended by itself", async () => {
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write: () => true, end: () => undefined, close: () => undefined });
    const client = Object.assign(new EventEmitter(), {
      exec: (_command: string, callback: (error: Error | undefined, channel: unknown) => void) => callback(undefined, channel),
      end: () => undefined,
    });
    const reasons: (string | null)[] = [];
    const config = { host: "mini.local", port: 22, username: "robin", privateKeyPath: "/keys/none", herdrSession: "default" };
    openSshEventStream(config, new PinningHostKeyPolicy(new MemoryPinStore()), layoutEventKinds, { started: () => undefined, event: () => undefined, ended: (reason) => reasons.push(reason) }, () =>
      Promise.resolve(client as never),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    channel.stderr.emit("data", Buffer.from("__HERDR_SOCKET_MISSING__\n"));
    channel.emit("close");
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toMatch(/the session is not running or the socket path is wrong/);
  });
});

// MARK: - The window's watch

function topology(tabs: Record<string, readonly string[]>): SessionTopology {
  const panes = Object.entries(tabs).flatMap(([tab, ids]) =>
    ids.map((id) => ({ pane_id: id, terminal_id: `t-${id}`, workspace_id: "w7", tab_id: tab, focused: false, agent_status: "unknown", revision: 1 })),
  );
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w7", number: 1, label: "aurora-web", focused: true, pane_count: panes.length, tab_count: 2, active_tab_id: "w7:t13", agent_status: "idle" }],
    tabs: Object.keys(tabs).map((tab, index) => ({ tab_id: tab, workspace_id: "w7", number: index + 1, label: tab, focused: index === 0, pane_count: tabs[tab]!.length, agent_status: "idle" })),
    panes,
    layouts: [],
    agents: [],
  });
}

class Page implements LayoutOwner {
  readonly updates: LayoutUpdateEvent[] = [];
  destroyed = false;
  constructor(readonly id: number) {}
  send(_channel: string, payload: LayoutUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  get last(): LayoutUpdateEvent | undefined {
    return this.updates.at(-1);
  }
}

function fakeMachine(initial: Record<string, readonly string[]>) {
  let tabs = initial;
  let snapshot = topology(tabs);
  const reads: string[] = [];
  let sink: EventSink | null = null;
  let subscriptions = 0;
  let closed = 0;
  let refreshes = 0;
  const actions = {
    paneLayout: (paneId: string): Promise<PaneLayout> => {
      reads.push(paneId);
      const tab = Object.entries(tabs).find(([, ids]) => ids.includes(paneId));
      if (tab === undefined) return Promise.reject(new Error("pane_not_found: no such pane"));
      const answer = layoutJson(tab[0], tab[1]).layout;
      return Promise.resolve({
        tabId: answer.tab_id,
        workspaceId: answer.workspace_id,
        area: answer.area,
        focusedPaneId: answer.focused_pane_id ?? null,
        panes: answer.panes.map((pane) => ({ paneId: pane.pane_id, focused: pane.focused, rect: pane.rect })),
        splits: [],
        zoomed: false,
      });
    },
  };
  const backend = {
    paneActions: () => actions,
    subscribeEvents: (kinds: readonly string[], next: EventSink) => {
      expect(kinds).toEqual(layoutEventKinds);
      subscriptions += 1;
      sink = next;
      return { close: () => (closed += 1) };
    },
  } as unknown as HerdrHostBackend;
  const hosts: LayoutHosts = {
    backend: (id) => (id === "mini" ? backend : null),
    pane: (id, paneId): TopologyPaneInfo | null => (id === "mini" ? (snapshot.panes.find((pane) => pane.paneID === paneId) ?? null) : null),
    topology: (id) => (id === "mini" ? snapshot : null),
    refresh: () => {
      refreshes += 1;
      return Promise.resolve();
    },
  };
  return {
    hosts,
    reads,
    get sink() {
      return sink!;
    },
    get subscriptions() {
      return subscriptions;
    },
    get closed() {
      return closed;
    },
    get refreshes() {
      return refreshes;
    },
    setTabs(next: Record<string, readonly string[]>) {
      tabs = next;
      snapshot = topology(next);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the window's watch on the shown tab", () => {
  it("reads the tab's layout once and sends it; another pane of the same tab reads nothing more", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S", "w7:p4V", "w7:p4T", "w7:p4W"], "w7:t1": ["w7:p1"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 0 });
    const page = new Page(1);
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => page.last?.layout != null);
    expect(page.last).toMatchObject({ hostId: "mini", paneId: "w7:p4S", tabId: "w7:t13", error: null });
    expect(page.last!.layout!.panes.length).toBe(4);
    service.watch(page, "mini", "w7:p4W");
    await settle();
    expect(machine.reads).toEqual(["w7:p4S"]);
    expect(page.last).toMatchObject({ paneId: "w7:p4W", tabId: "w7:t13" });
    // Another tab: read again.
    service.watch(page, "mini", "w7:p1");
    await eventually(() => page.last?.tabId === "w7:t1" && page.last.layout !== null);
    expect(machine.reads).toEqual(["w7:p4S", "w7:p1"]);
    expect(machine.subscriptions).toBe(1);
    service.closeAll();
    expect(machine.closed).toBe(1);
  });

  it("reads again on layout.updated and the pane created, closed and moved events (not on others)", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S", "w7:p4V"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 0 });
    const page = new Page(1);
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => machine.reads.length === 1 && page.last?.layout != null);
    machine.sink.started();
    machine.sink.event("pane.focused", "w7:p4V");
    machine.sink.event("pane.agent_status_changed", "w7:p4V");
    await settle();
    expect(machine.reads.length).toBe(1);
    for (const [index, kind] of ["layout.updated", "pane.created", "pane.closed", "pane.moved"].entries()) {
      machine.sink.event(kind, null);
      await eventually(() => machine.reads.length === index + 2);
    }
    // The created, closed and moved events also bring a snapshot (the new pane's row).
    expect(machine.refreshes).toBe(3);
    service.closeAll();
  });

  it("a burst of events is one read", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S", "w7:p4V"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 20 });
    const page = new Page(1);
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => machine.reads.length === 1);
    machine.sink.started();
    for (let i = 0; i < 5; i += 1) machine.sink.event("layout.updated", null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(machine.reads.length).toBe(2);
    service.closeAll();
  });

  it("reads again when a snapshot changes the tab's panes; an unchanged snapshot reads nothing", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S", "w7:p4V"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 0 });
    const page = new Page(1);
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => page.last?.layout != null);
    machine.sink.started();
    service.refresh();
    await settle();
    expect(machine.reads.length).toBe(1);
    machine.setTabs({ "w7:t13": ["w7:p4S", "w7:p4V", "w7:p4T"] });
    service.refresh();
    await eventually(() => page.last?.layout?.panes.length === 3);
    expect(machine.reads.length).toBe(2);
    service.closeAll();
  });

  it("without a live event stream, every snapshot reads the layout again", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S", "w7:p4V"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 0, retryMs: 10_000 });
    const page = new Page(1);
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => machine.reads.length === 1);
    service.refresh();
    await eventually(() => machine.reads.length === 2);
    machine.sink.started();
    service.refresh();
    await settle();
    expect(machine.reads.length).toBe(2);
    service.closeAll();
  });

  it("subscribes again after the stream ends, waiting longer each time", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S", "w7:p4V"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 0, retryMs: 5, maxRetryMs: 20 });
    const page = new Page(1);
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => machine.subscriptions === 1);
    machine.sink.ended("the connection closed");
    await eventually(() => machine.subscriptions === 2);
    // It came back: the layout is read again in case something changed while it was down.
    machine.sink.started();
    await eventually(() => machine.reads.length >= 2);
    service.closeAll();
  });

  it("drops the watch (and the stream) when nothing is shown or the window goes", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S", "w7:p4V"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 0 });
    const page = new Page(1);
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => machine.reads.length === 1);
    service.watch(page, null, null);
    expect(machine.closed).toBe(1);
    machine.sink.event("layout.updated", null);
    await settle();
    expect(machine.reads.length).toBe(1);
    const other = new Page(2);
    service.watch(other, "mini", "w7:p4V");
    await eventually(() => machine.subscriptions === 2);
    service.close(other);
    expect(machine.closed).toBe(2);
  });

  it("a layout Herdr refuses shows as none, with the reason", async () => {
    const machine = fakeMachine({ "w7:t13": ["w7:p4S"] });
    const service = new LayoutService(machine.hosts, "layout", { debounceMs: 0 });
    const page = new Page(1);
    machine.setTabs({ "w7:t13": ["w7:p4S"] });
    const actions = machine.hosts.backend("mini")!.paneActions!();
    (actions as { paneLayout: (pane: string) => Promise<PaneLayout> }).paneLayout = () => Promise.reject(new Error("unknown_method: pane.layout"));
    service.watch(page, "mini", "w7:p4S");
    await eventually(() => page.last !== undefined);
    expect(page.last).toMatchObject({ layout: null, error: "unknown_method: pane.layout" });
    service.closeAll();
  });
});

describe("the demo's Herdr", () => {
  const snapshot = () => demoHosts(bundledFixturesForTests(), 0).find((host) => host.descriptor.id === demoHostIds.macMini)!.snapshot;

  it("answers pane.layout for a tab: the workers tab as two panes side by side, a 3-pane tab as Herdr arranges it", async () => {
    const client = new HerdrClient(new FixtureTransport(snapshot()));
    const workers = await client.paneLayout("w7:p1G");
    expect(workers).toMatchObject({ tabId: "w7:tK", workspaceId: "w7", zoomed: false, area: { width: 134, height: 45 } });
    expect(workers.panes.map((pane) => [pane.paneId, pane.rect])).toEqual([
      ["w7:p1G", { x: 0, y: 0, width: 67, height: 45 }],
      ["w7:p1H", { x: 67, y: 0, width: 67, height: 45 }],
    ]);
    expect(workers.splits).toEqual([{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 134, height: 45 } }]);
    const three = await client.paneLayout("wA:pM");
    expect(three.panes.map((pane) => [pane.paneId, pane.rect.x, pane.rect.y, pane.rect.width, pane.rect.height])).toEqual([
      ["wA:pJ", 0, 0, 67, 45],
      ["wA:pM", 67, 0, 67, 23],
      ["wA:pK", 67, 23, 67, 22],
    ]);
    await expect(client.paneLayout("w7:nope")).rejects.toThrow(/pane_not_found/);
  });

  it("has an event stream the watch can follow", () => {
    const fixtures = bundledFixturesForTests();
    const host = demoHosts(fixtures, 0)[0]!;
    const backend = new DemoBackend(host, fixtures);
    const seen: string[] = [];
    const subscription = backend.subscribeEvents!(layoutEventKinds, { started: () => seen.push("started"), event: () => undefined, ended: () => undefined });
    expect(typeof subscription.close).toBe("function");
    subscription.close();
    backend.close();
  });
});
