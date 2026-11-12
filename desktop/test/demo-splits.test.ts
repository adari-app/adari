// The demo's split tabs. The demo Mac mini has tabs
// of 2, 3 and 4 panes. The 4-pane tab (demoSplitTab) holds two working Claude
// panes whose transcripts grow as time passes (Chat following live output) and
// two shells printing a log without end, so its tiles show two Chat and two
// Terminal. The demo Herdr answers layout, split, resize, zoom and close on it;
// the captures and the frame probe use it.

import { describe, expect, it } from "vitest";

import { demoCaptureSteps } from "../src/main/capture";
import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend, demoScriptFor, type DemoClock } from "../src/main/demo/demo-backend";
import { demoLiveStepMs } from "../src/main/demo/demo-chat";
import { demoHostIds, demoHosts, demoSplitTab } from "../src/main/demo/demo-hosts";
import { demoProbeScenarios } from "../src/main/frame-probe";
import { HostRegistry } from "../src/main/hosts";
import type { SessionTopology } from "../src/main/herdr/wire";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { decideTiles, splitRefusal } from "../src/shared/pane-layout";
import { defaultView } from "../src/shared/pane-view";
import { eventually } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

const fixtures = bundledFixturesForTests();

/** Runs scheduled work only when told to. */
class ManualClock implements DemoClock {
  now = 0;
  private tasks: { at: number; run: () => void; cancelled: boolean }[] = [];

  schedule(run: () => void, delayMs: number): () => void {
    const task = { at: this.now + delayMs, run, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((task) => !task.cancelled && task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.now = due.at;
      due.run();
    }
    this.now = end;
  }
}

function macMini(now: () => number = Date.now, clock: DemoClock = new ManualClock()) {
  const host = demoHosts(fixtures, Date.now()).find((candidate) => candidate.descriptor.id === demoHostIds.macMini)!;
  const backend = new DemoBackend(host, fixtures, clock, now);
  return { host, backend, client: backend.paneActions() };
}

const tabPanes = (topology: SessionTopology, tabId: string): string[] =>
  topology.panes.filter((pane) => pane.tabID === tabId).map((pane) => pane.paneID);

describe("the demo Mac mini's split tabs", () => {
  it("has tabs of 2, 3 and 4 panes, each shown as that many tiles", async () => {
    const { backend, client } = macMini();
    const topology = await backend.snapshot();
    const counts = new Map<string, number>();
    for (const pane of topology.panes) counts.set(pane.tabID, (counts.get(pane.tabID) ?? 0) + 1);
    const split = Array.from(counts).filter(([, count]) => count > 1);
    expect(new Map(split)).toEqual(new Map([["w7:tK", 2], ["wA:t6", 3], [demoSplitTab.tabId, 4]]));
    for (const [tabId, count] of split) {
      const first = tabPanes(topology, tabId)[0]!;
      const decision = decideTiles(await client.paneLayout(first), first);
      expect(decision.kind).toBe("tiles");
      if (decision.kind === "tiles") expect(decision.tiles).toHaveLength(count);
    }
    // The tab is listed in its workspace, its counts with it.
    expect(topology.tabs.find((tab) => tab.tabID === demoSplitTab.tabId)).toMatchObject({ workspaceID: demoSplitTab.workspaceId, paneCount: 4 });
  });

  it("shows the 4-pane tab as two columns: two working Claude panes in Chat, two shells in Terminal", async () => {
    const { backend, client } = macMini();
    const topology = await backend.snapshot();
    expect(tabPanes(topology, demoSplitTab.tabId)).toEqual([...demoSplitTab.panes]);
    const decision = decideTiles(await client.paneLayout(demoSplitTab.panes[0]), demoSplitTab.panes[0]);
    if (decision.kind !== "tiles") throw new Error("not tiles");
    expect(decision.tiles.map((tile) => tile.paneId)).toEqual([...demoSplitTab.panes]);
    const [topLeft, bottomLeft, topRight, bottomRight] = decision.tiles.map((tile) => tile.frame);
    expect([topLeft!.left, topLeft!.top, bottomLeft!.left, topRight!.top]).toEqual([0, 0, 0, 0]);
    expect(bottomLeft!.top).toBeCloseTo(0.5, 1);
    expect(topRight!.left).toBeCloseTo(0.5, 1);
    expect(bottomRight!.left).toBeCloseTo(0.5, 1);
    expect(bottomRight!.top).toBeCloseTo(0.5, 1);
    const views = demoSplitTab.panes.map((paneId) => {
      const pane = topology.panes.find((candidate) => candidate.paneID === paneId)!;
      return defaultView({ paneID: paneId, isAgent: pane.agent !== undefined && pane.agent !== "" });
    });
    expect(views).toEqual(["chat", "terminal", "chat", "terminal"]);
    expect([...demoSplitTab.chats, ...demoSplitTab.terminals].sort()).toEqual([...demoSplitTab.panes].sort());
    for (const paneId of demoSplitTab.chats) {
      expect(topology.panes.find((pane) => pane.paneID === paneId)).toMatchObject({ agent: "claude", agentStatus: "working" });
    }
    // At 4 panes, splitting it is refused (the app's rule; Herdr itself has none).
    expect(splitRefusal(4)).not.toBeNull();
  });

  it("answers zoom, a split's ratio and close on the 4-pane tab", async () => {
    const { backend, client } = macMini();
    const [first, , third, fourth] = demoSplitTab.panes;
    await client.zoomPane(third, true);
    expect(decideTiles(await client.paneLayout(third), third)).toMatchObject({ kind: "single", reason: "zoomed", zoomed: true });
    await client.zoomPane(third, false);
    expect(decideTiles(await client.paneLayout(third), third).kind).toBe("tiles");
    await client.setSplitRatio(demoSplitTab.tabId, [], 0.6);
    const resized = decideTiles(await client.paneLayout(first), first);
    if (resized.kind !== "tiles") throw new Error("not tiles");
    expect(resized.tiles[0]!.frame.width).toBeCloseTo(0.6, 1);
    await client.closePane(fourth);
    const after = await backend.snapshot();
    expect(tabPanes(after, demoSplitTab.tabId)).toEqual(demoSplitTab.panes.slice(0, 3));
    const three = decideTiles(await client.paneLayout(first), first);
    expect(three.kind === "tiles" ? three.tiles.length : 0).toBe(3);
  });
});

describe("the demo's live panes", () => {
  it("grows its working Claude panes' transcripts as time passes, a step at a time", async () => {
    let now = Date.now();
    const { host, backend } = macMini(() => now);
    const reader = backend.transcripts();
    for (const paneId of demoSplitTab.chats) {
      const transcript = host.transcripts.find((candidate) => candidate.paneID === paneId)!;
      expect(transcript).toMatchObject({ agent: "claude", working: true });
      const first = await reader.size(transcript.path);
      expect(await reader.size(transcript.path)).toBe(first);
      now += demoLiveStepMs * 3;
      const grown = await reader.size(transcript.path);
      expect(grown).toBeGreaterThan(first);
      const added = new TextDecoder()
        .decode(await reader.read(transcript.path, first, grown - first))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { sessionId: string; uuid: string; type: string });
      expect(added).toHaveLength(3);
      expect(added.every((line) => line.sessionId === transcript.sessionID)).toBe(true);
      // Each line is new: no uuid repeats the transcript's own.
      const all = new TextDecoder().decode(await reader.read(transcript.path, 0, grown)).trim().split("\n");
      const uuids = all.map((line) => (JSON.parse(line) as { uuid: string }).uuid);
      expect(new Set(uuids).size).toBe(uuids.length);
    }
    // The other transcripts do not grow.
    const done = host.transcripts.find((candidate) => candidate.paneID === "w7:p1H")!;
    const size = await reader.size(done.path);
    now += demoLiveStepMs * 5;
    expect(await reader.size(done.path)).toBe(size);
  });

  it("is followed live by Chat: the running turn takes the new steps", async () => {
    let now = Date.now();
    const registry = new HostRegistry(() => undefined);
    for (const demo of demoHosts(fixtures, now)) registry.add(demo.descriptor, new DemoBackend(demo, fixtures, new ManualClock(), () => now));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const updates: ChatUpdateEvent[] = [];
    const page: ChatOwner = { id: 1, send: (_channel: string, payload: ChatUpdateEvent) => updates.push(payload), isDestroyed: () => false };
    const paneId = demoSplitTab.chats[0];
    service.open(page, demoHostIds.macMini, paneId, `${demoHostIds.macMini}/${paneId}`);
    const last = () => updates.filter((update) => update.paneId === paneId).at(-1);
    expect(await eventually(() => last()?.state.status === "live")).toBe(true);
    const before = JSON.stringify(last()!.timeline.turns.at(-1)).length;
    now += demoLiveStepMs * 4;
    expect(await eventually(() => JSON.stringify(last()!.timeline.turns.at(-1)).length > before)).toBe(true);
    service.closeAll();
    registry.close();
  });

  it("prints a log without end in its two shells", async () => {
    const clock = new ManualClock();
    const { host, backend } = macMini(Date.now, clock);
    const topology = await backend.snapshot();
    const pane = (paneId: string) => topology.panes.find((candidate) => candidate.paneID === paneId)!;
    for (const paneId of demoSplitTab.terminals) {
      expect(demoScriptFor(host.snapshot, pane(paneId), fixtures, host.printing)).toMatchObject({ kind: "replay", loop: true });
    }
    // A shell elsewhere still plays its idle screen once.
    expect(demoScriptFor(host.snapshot, pane("w8:p1"), fixtures, host.printing)).toMatchObject({ kind: "replay", loop: false });
    const received: Uint8Array[] = [];
    const handle = await backend.openTerminal(pane(demoSplitTab.terminals[0]), { cols: 80, rows: 24 }, { data: (bytes) => received.push(bytes), exit: () => undefined });
    clock.advance(120_000);
    const firstPass = received.length;
    expect(firstPass).toBeGreaterThan(10);
    clock.advance(120_000);
    expect(received.length).toBeGreaterThan(firstPass);
    handle.close();
    const closed = received.length;
    clock.advance(120_000);
    expect(received.length).toBe(closed);
  });
});

describe("the captures and the probe on the split tabs", () => {
  const steps = demoCaptureSteps(demoHostIds);
  const step = (name: string) => steps.find((candidate) => candidate.name === name);
  const mac = demoHostIds.macMini;

  it("capture 2 panes side by side, 4 panes, the split menu at 4, a zoomed pane, the split menu and New agent's Where", () => {
    // After the look, attach, Send to, Changes and Away search steps (01-29) the split steps are 30-35.
    // The terminal copy step (36) follows them, and the two model steps (37, 38) follow that
    // (test/terminal-copy.test.ts, test/agent-chips.test.ts, test/context-ring.test.ts).
    expect(steps.map((candidate) => candidate.name).slice(29, 35)).toEqual([
      "30-two-panes",
      "31-four-panes",
      "32-split-menu-full",
      "33-zoomed-pane",
      "34-split-menu",
      "35-new-agent-where",
    ]);
    expect(step("30-two-panes")!.commands).toContainEqual({ type: "select-pane", hostId: mac, paneId: "w7:p1G" });
    // The Changes steps leave that pane in Changes; step 30 picks its Terminal again (as at step 06).
    expect(step("30-two-panes")!.commands).toContainEqual({ type: "set-tab", tab: "terminal" });
    expect(step("31-four-panes")!.commands).toContainEqual({ type: "select-pane", hostId: mac, paneId: demoSplitTab.panes[0] });
    expect(step("32-split-menu-full")!.commands).toContainEqual({ type: "open-split-menu", hostId: mac, paneId: demoSplitTab.panes[0] });
    expect(step("33-zoomed-pane")!.commands).toContainEqual({ type: "zoom-pane", hostId: mac, paneId: demoSplitTab.chats[1], zoomed: true });
    expect(step("34-split-menu")!.commands).toEqual([
      { type: "zoom-pane", hostId: mac, paneId: demoSplitTab.chats[1], zoomed: false },
      { type: "select-pane", hostId: mac, paneId: "w7:p1H" },
      { type: "open-split-menu", hostId: mac, paneId: "w7:p1H" },
    ]);
    expect(step("35-new-agent-where")!.commands).toContainEqual({ type: "open-new-agent", hostId: mac, workspaceId: "w7", where: { paneId: "w7:p1H", direction: "right" } });
    for (const candidate of steps.slice(29, 35)) expect(candidate.what.length).toBeGreaterThan(40);
  });

  it("say where the earlier captures' pane is now a tile of its two-pane tab", () => {
    for (const candidate of steps.slice(0, 14)) {
      const shows = candidate.commands.some((command) => "paneId" in command && command.paneId === "w7:p1G");
      if (shows) expect(candidate.what).toMatch(/tile/);
    }
  });

  it("probe the 4-pane tab: two Chats following live output and two terminals printing", () => {
    const [scenario] = demoProbeScenarios(demoHostIds);
    expect(scenario!.commands).toContainEqual({ type: "select-pane", hostId: mac, paneId: demoSplitTab.panes[0] });
    expect(scenario!.what).toMatch(/four tiles/i);
    expect(scenario!.durationMs).toBe(10_000);
  });
});
