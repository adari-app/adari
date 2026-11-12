// The shown Chat's Claude pane is read about every 400 ms
// while Herdr says it works (src/main/chat/live-reads.ts), through the real
// HostRegistry and HerdrClient on a fake Herdr (the demo's FixtureTransport,
// test/support/prompt-herdr.ts), on fake timers: only while working, shown and
// connected; one read in flight; stopped on each listed change; a late read
// dropped; never a read of a pane the needs-you card is reading.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveKinds, LiveReads, paneReadKey } from "../src/main/chat/live-reads";
import { ChatService, type ChatHosts, type ChatOwner, type ShownChat } from "../src/main/chat/service";
import { HostRegistry } from "../src/main/hosts";
import { PromptService } from "../src/main/prompt/prompts";
import { ChatLiveReader, PaneReadGate } from "../src/shared/chat/live-reader";
import { ChatLiveScreen, liveBlock, type ChatLiveBlock } from "../src/shared/chat/live-screen";
import type { ChatLiveEvent } from "../src/shared/ipc-contract";
import { L } from "./support/prompt-fixtures";
import { cursorScreens } from "./support/live-cursor-fixtures";
import { codexScreens } from "./support/live-codex-fixtures";
import { workerRecent, workingRecent, workingVisible } from "./support/live-fixtures";
import { backend, clock, FakeHerdr, setup as promptSetup, snapshot, type Json } from "./support/prompt-herdr";
import { readingMatch } from "../src/shared/prompt/matcher";
import { stopBindingOf } from "../src/shared/agent-stop";

/** Claude Code writing `text` (the fixtures' shape). */
function writing(text: string): string {
  const rule = "\u{2500}".repeat(64);
  return ["", "\u{276F} go on", "", `\u{23FA} ${text}`, "", "\u{2722} Gallivanting\u{2026} (12s \u{00B7} \u{2193} 1.2k tokens)", "", rule, "\u{276F}", rule, "  Opus 5.5 | 12% ctx"].join("\n");
}

/** Codex writing `text` (the recorded frames' shape). */
function codexWriting(text: string): string {
  return ["", `\u{2022} ${text}`, "", "", "\u{203A} Ask Codex to do anything", "", "  gpt-model xhigh \u{B7} ~/project", "  ? for shortcuts"].join("\n");
}

/** Cursor writing its reply (the recorded frames' shape), and the text read off it. */
const cursorWriting = cursorScreens.find((each) => each.name === "reply cut mid-line")!;

/** w1:p1 Claude working, w1:p2 Codex working, w1:p4 Claude idle. */
function liveSnapshot(): Json {
  const json = snapshot();
  const panes = json["panes"] as Json[];
  const agents = json["agents"] as Json[];
  panes[0]!["agent_status"] = "working";
  agents[0]!["agent_status"] = "working";
  panes.push({ pane_id: "w1:p4", terminal_id: "term-4", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: "claude", agent_status: "idle", revision: 1 });
  agents.push({ pane_id: "w1:p4", agent: "claude", agent_status: "idle", status_since_unix_ms: 3_000, agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "s-4" } });
  return json;
}

interface Held {
  pane: string;
  release(): void;
}

/** The fake Herdr with its pane.read replies held until the test lets each go (`holding`). */
class LiveHerdr extends FakeHerdr {
  holding = false;
  held: Held[] = [];

  override roundTrip(line: string): Promise<string> {
    const request = JSON.parse(line) as { method: string; params: Json };
    const reply = super.roundTrip(line);
    if (request.method !== "pane.read" || !this.holding) return reply;
    return new Promise((resolve, reject) => {
      this.held.push({ pane: request.params["pane_id"] as string, release: () => reply.then(resolve, reject) });
    });
  }

  reads(pane?: string): Json[] {
    return this.sent("pane.read").filter((params) => pane === undefined || params["pane_id"] === pane);
  }

  status(pane: string, status: string): void {
    this.paneEntry(pane)["agent_status"] = status;
    this.agentEntry(pane)["agent_status"] = status;
  }
}

async function setup() {
  const herdr = new LiveHerdr(liveSnapshot(), { "w1:p1": [writing("The feed reads on")], "w1:p2": [codexWriting("Codex text")], "w1:p3": [cursorWriting.screen], "w1:p4": [writing("Idle")] });
  const epoch = { value: 1 };
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, epoch));
  await registry.refreshAll();
  const events: ChatLiveEvent[] = [];
  let chats: ShownChat[] = [];
  const owner: ChatOwner = { id: 1, send: () => undefined, isDestroyed: () => false };
  const gate = new PaneReadGate();
  const live = new LiveReads(registry, () => chats, (_chat, event) => events.push(event), { gate });
  const show = (...shown: { paneId: string; slot?: string; follow?: number }[]): void => {
    chats = shown.map((chat) => ({ owner, slot: chat.slot ?? "", follow: chat.follow ?? 1, hostId: "mac", paneId: chat.paneId }));
    live.sync();
  };
  /** A new snapshot, as the registry's change hook does (ChatService.refresh, then the live reads). */
  const snapshotNow = async (): Promise<void> => {
    await registry.refreshAll();
    live.sync();
  };
  return { herdr, epoch, registry, events, live, gate, show, snapshotNow };
}

async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}
const blocks = (events: ChatLiveEvent[]): ChatLiveEvent[] => events.filter((event) => event.type === "block");
const stops = (events: ChatLiveEvent[]): ChatLiveEvent[] => events.filter((event) => event.type === "stop");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("when the pane is read", () => {
  it("reads the shown Chat's working Claude pane with pane.read (recent, plain text, 80 lines), and sends its block", async () => {
    const { herdr, events, live, show } = await setup();
    show({ paneId: "w1:p1", follow: 7 });
    await pass(0);
    expect(herdr.reads()).toEqual([{ pane_id: "w1:p1", source: "recent", lines: 80, format: "text", strip_ansi: true }]);
    expect(events).toEqual([{ type: "block", hostId: "mac", paneId: "w1:p1", follow: 7, block: liveBlock("The feed reads on") }]);
    live.closeAll();
  });

  it("reads nothing for a Chat not on screen, a pane not working, another agent, or a machine not answering", async () => {
    const { herdr, registry, live, show, snapshotNow } = await setup();
    // Codex's pane is read now; another agent (Grok) is not.
    herdr.paneEntry("w1:p3")["agent"] = "grok";
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    show();
    show({ paneId: "w1:p4" });
    show({ paneId: "w1:p3" });
    await pass(2_000);
    expect(herdr.reads()).toEqual([]);
    (registry as unknown as { entries: { state: string }[] }).entries[0]!.state = "offline";
    show({ paneId: "w1:p1" });
    await pass(2_000);
    expect(herdr.reads()).toEqual([]);
    expect(live.following).toEqual([]);
  });

  it("reads about every 400 ms, the next only once the last answered", async () => {
    const { herdr, live, show } = await setup();
    show({ paneId: "w1:p1" });
    await pass(0);
    expect(herdr.reads()).toHaveLength(1);
    await pass(399);
    expect(herdr.reads()).toHaveLength(1);
    await pass(1);
    expect(herdr.reads()).toHaveLength(2);
    await pass(1_600);
    expect(herdr.reads()).toHaveLength(6);
    // A slow answer: no second read while one is out.
    herdr.holding = true;
    await pass(400);
    expect(herdr.reads()).toHaveLength(7);
    await pass(5_000);
    expect(herdr.reads(), "one read in flight").toHaveLength(7);
    herdr.holding = false;
    herdr.held.shift()!.release();
    await pass(0);
    await pass(400);
    expect(herdr.reads()).toHaveLength(8);
    live.closeAll();
  });

  it("each Chat on screen with a working Claude or Codex pane is read, each pane on its own", async () => {
    const { herdr, events, live, show, snapshotNow } = await setup();
    herdr.status("w1:p4", "working");
    await snapshotNow();
    show({ paneId: "w1:p1", slot: "a", follow: 1 }, { paneId: "w1:p4", slot: "b", follow: 2 }, { paneId: "w1:p2", slot: "c", follow: 3 });
    await pass(0);
    expect(live.following).toEqual(["mac w1:p1", "mac w1:p4", "mac w1:p2"]);
    expect(blocks(events).map((event) => [event.paneId, event.follow])).toEqual([
      ["w1:p1", 1],
      ["w1:p4", 2],
      ["w1:p2", 3],
    ]);
    // Codex's reply is read off its screen too.
    expect(herdr.reads("w1:p2")).toHaveLength(1);
    live.closeAll();
  });
});

// Codex's pane is read as Claude's is: only a shown Chat, working, connected, about every
// 400 ms, one read of the pane at a time (the gate it shares with the needs-you card), late answers dropped, and
// under the identity the reads began with (its agent included). Other agents are not read.
describe("a Codex pane is read as Claude's", () => {
  it("the shown Chat's working Codex pane: pane.read (recent, plain text, 80 lines) about every 400 ms, its reply as Codex draws it", async () => {
    const { herdr, events, live, show } = await setup();
    show({ paneId: "w1:p2", follow: 5 });
    await pass(0);
    expect(herdr.reads()).toEqual([{ pane_id: "w1:p2", source: "recent", lines: 80, format: "text", strip_ansi: true }]);
    expect(events).toEqual([{ type: "block", hostId: "mac", paneId: "w1:p2", follow: 5, block: liveBlock("Codex text", false, "codex") }]);
    await pass(399);
    expect(herdr.reads()).toHaveLength(1);
    await pass(1);
    expect(herdr.reads()).toHaveLength(2);
    herdr.holding = true;
    await pass(400);
    await pass(5_000);
    expect(herdr.reads(), "one read in flight").toHaveLength(3);
    herdr.holding = false;
    herdr.held.shift()!.release();
    await pass(400);
    expect(herdr.reads()).toHaveLength(4);
    live.closeAll();
  });

  it("not working, not shown, not connected, or another agent (Grok, none): no reads", async () => {
    const { herdr, registry, live, show, snapshotNow } = await setup();
    herdr.status("w1:p2", "idle");
    await snapshotNow();
    show({ paneId: "w1:p2" });
    await pass(2_000);
    expect(herdr.reads()).toEqual([]);
    show();
    herdr.status("w1:p2", "working");
    herdr.paneEntry("w1:p3")["agent"] = "grok";
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    show({ paneId: "w1:p3" });
    await pass(2_000);
    expect(herdr.reads(), "Grok's screen is not read").toEqual([]);
    (registry as unknown as { entries: { state: string }[] }).entries[0]!.state = "offline";
    show({ paneId: "w1:p2" });
    await pass(2_000);
    expect(herdr.reads()).toEqual([]);
    expect(live.following).toEqual([]);
  });

  it("stops when Codex stops working (keeping), or the Chat leaves (not keeping)", async () => {
    const { herdr, events, live, show, snapshotNow } = await setup();
    show({ paneId: "w1:p2" });
    await pass(0);
    herdr.status("w1:p2", "done");
    await snapshotNow();
    expect(stops(events)).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p2", follow: 1, keeping: true }]);
    const reads = herdr.reads().length;
    await pass(4_000);
    expect(herdr.reads()).toHaveLength(reads);
    herdr.status("w1:p2", "working");
    await snapshotNow();
    await pass(0);
    show();
    expect(stops(events).at(-1)).toEqual({ type: "stop", hostId: "mac", paneId: "w1:p2", follow: 1, keeping: false });
    expect(live.following).toEqual([]);
  });

  it("waits while the needs-you card's read of the pane is out", async () => {
    const { herdr, gate, live, show } = await setup();
    expect(gate.begin(paneReadKey("mac", "w1:p2"))).toBe(true);
    show({ paneId: "w1:p2" });
    await pass(2_000);
    expect(herdr.reads()).toEqual([]);
    gate.end(paneReadKey("mac", "w1:p2"));
    await pass(400);
    expect(herdr.reads()).toHaveLength(1);
    live.closeAll();
  });

  it("a late read is dropped when the Chat moved, or the pane's terminal, session, agent or connection changed meanwhile", async () => {
    for (const change of ["moved", "terminal", "session", "agent", "epoch"] as const) {
      const { herdr, epoch, events, live, show, snapshotNow } = await setup();
      herdr.holding = true;
      show({ paneId: "w1:p2" });
      await pass(0);
      expect(herdr.held, change).toHaveLength(1);
      if (change === "moved") show({ paneId: "w1:p1" });
      if (change === "terminal") herdr.paneEntry("w1:p2")["terminal_id"] = "term-9";
      if (change === "session") herdr.agentEntry("w1:p2")["agent_session"] = { source: "herdr:codex", agent: "codex", kind: "id", value: "c-9" };
      if (change === "agent") {
        herdr.paneEntry("w1:p2")["agent"] = "claude";
        herdr.agentEntry("w1:p2")["agent"] = "claude";
      }
      if (change === "epoch") epoch.value = 2;
      if (change !== "moved") await snapshotNow();
      herdr.held.shift()!.release();
      await pass(0);
      expect(blocks(events), change).toEqual([]);
      if (change !== "moved") expect(stops(events), change).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p2", follow: 1, keeping: false }]);
      live.closeAll();
    }
  });
});

// Cursor's pane is read as Claude's and Codex's are: only a shown Chat, working, connected,
// about every 400 ms, one read of the pane at a time (the gate it shares with the needs-you card), late answers
// dropped, under the identity the reads began with (its agent included). Herdr names no session for it.
describe("a Cursor pane is read as Claude's and Codex's", () => {
  /** w1:p3 runs Cursor (no session from Herdr, as for the user's), `status`. */
  async function cursorSetup(status = "working") {
    const context = await setup();
    context.herdr.paneEntry("w1:p3")["agent"] = "cursor";
    context.herdr.paneEntry("w1:p3")["agent_status"] = status;
    await context.snapshotNow();
    return context;
  }

  it("the agents read live: Claude, Codex and Cursor", () => {
    expect([...liveKinds].sort()).toEqual(["claude", "codex", "cursor"]);
  });

  it("the shown Chat's working Cursor pane: pane.read (recent, plain text, 80 lines) about every 400 ms, its reply as Cursor draws it", async () => {
    const { herdr, events, live, show } = await cursorSetup();
    show({ paneId: "w1:p3", follow: 4 });
    await pass(0);
    expect(herdr.reads()).toEqual([{ pane_id: "w1:p3", source: "recent", lines: 80, format: "text", strip_ansi: true }]);
    expect(events).toEqual([{ type: "block", hostId: "mac", paneId: "w1:p3", follow: 4, block: liveBlock(cursorWriting.text!, false, "cursor") }]);
    await pass(399);
    expect(herdr.reads()).toHaveLength(1);
    await pass(1);
    expect(herdr.reads()).toHaveLength(2);
    herdr.holding = true;
    await pass(400);
    await pass(5_000);
    expect(herdr.reads(), "one read in flight").toHaveLength(3);
    herdr.holding = false;
    herdr.held.shift()!.release();
    await pass(400);
    expect(herdr.reads()).toHaveLength(4);
    live.closeAll();
  });

  it("not working, not shown, or not connected: no reads", async () => {
    const { herdr, registry, live, show, snapshotNow } = await cursorSetup("idle");
    show({ paneId: "w1:p3" });
    await pass(2_000);
    expect(herdr.reads(), "idle").toEqual([]);
    show();
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    await pass(2_000);
    expect(herdr.reads(), "not shown").toEqual([]);
    (registry as unknown as { entries: { state: string }[] }).entries[0]!.state = "offline";
    show({ paneId: "w1:p3" });
    await pass(2_000);
    expect(herdr.reads(), "offline").toEqual([]);
    expect(live.following).toEqual([]);
  });

  it("stops when Cursor stops working (keeping), or the Chat leaves (not keeping)", async () => {
    const { herdr, events, live, show, snapshotNow } = await cursorSetup();
    show({ paneId: "w1:p3" });
    await pass(0);
    herdr.paneEntry("w1:p3")["agent_status"] = "done";
    await snapshotNow();
    expect(stops(events)).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p3", follow: 1, keeping: true }]);
    const reads = herdr.reads().length;
    await pass(4_000);
    expect(herdr.reads()).toHaveLength(reads);
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await snapshotNow();
    await pass(0);
    show();
    expect(stops(events).at(-1)).toEqual({ type: "stop", hostId: "mac", paneId: "w1:p3", follow: 1, keeping: false });
    expect(live.following).toEqual([]);
  });

  it("waits while the needs-you card's read of the pane is out", async () => {
    const { herdr, gate, live, show } = await cursorSetup();
    expect(gate.begin(paneReadKey("mac", "w1:p3"))).toBe(true);
    show({ paneId: "w1:p3" });
    await pass(2_000);
    expect(herdr.reads()).toEqual([]);
    gate.end(paneReadKey("mac", "w1:p3"));
    await pass(400);
    expect(herdr.reads()).toHaveLength(1);
    live.closeAll();
  });

  it("a late read is dropped when the Chat moved, or the pane's terminal, agent or connection changed meanwhile", async () => {
    for (const change of ["moved", "terminal", "agent", "epoch"] as const) {
      const { herdr, epoch, events, live, show, snapshotNow } = await cursorSetup();
      herdr.holding = true;
      show({ paneId: "w1:p3" });
      await pass(0);
      expect(herdr.held, change).toHaveLength(1);
      if (change === "moved") show({ paneId: "w1:p1" });
      if (change === "terminal") herdr.paneEntry("w1:p3")["terminal_id"] = "term-9";
      if (change === "agent") herdr.paneEntry("w1:p3")["agent"] = "claude";
      if (change === "epoch") epoch.value = 2;
      if (change !== "moved") await snapshotNow();
      herdr.held.shift()!.release();
      await pass(0);
      expect(blocks(events), change).toEqual([]);
      if (change !== "moved") expect(stops(events), change).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p3", follow: 1, keeping: false }]);
      live.closeAll();
    }
  });

  it("Claude's and Codex's panes beside it are read as before, each on its own", async () => {
    const { herdr, events, live, show } = await cursorSetup();
    show({ paneId: "w1:p1", slot: "a", follow: 1 }, { paneId: "w1:p2", slot: "b", follow: 2 }, { paneId: "w1:p3", slot: "c", follow: 3 });
    await pass(0);
    expect(live.following).toEqual(["mac w1:p1", "mac w1:p2", "mac w1:p3"]);
    expect(blocks(events)).toEqual([
      { type: "block", hostId: "mac", paneId: "w1:p1", follow: 1, block: liveBlock("The feed reads on") },
      { type: "block", hostId: "mac", paneId: "w1:p2", follow: 2, block: liveBlock("Codex text", false, "codex") },
      { type: "block", hostId: "mac", paneId: "w1:p3", follow: 3, block: liveBlock(cursorWriting.text!, false, "cursor") },
    ]);
    expect(herdr.reads("w1:p3")).toHaveLength(1);
    live.closeAll();
  });
});

describe("when the reads stop", () => {
  it("the pane stops working: no more reads, and the row may stay a moment (keeping)", async () => {
    const { herdr, events, live, show, snapshotNow } = await setup();
    show({ paneId: "w1:p1" });
    await pass(0);
    herdr.status("w1:p1", "done");
    await snapshotNow();
    expect(stops(events)).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p1", follow: 1, keeping: true }]);
    const reads = herdr.reads().length;
    await pass(4_000);
    expect(herdr.reads()).toHaveLength(reads);
    expect(live.following).toEqual([]);
  });

  it("the pane asks a question (blocked): the reads stop, keeping", async () => {
    const { herdr, events, show, snapshotNow } = await setup();
    show({ paneId: "w1:p1" });
    await pass(0);
    herdr.status("w1:p1", "blocked");
    await snapshotNow();
    expect(stops(events).at(-1)).toMatchObject({ keeping: true });
  });

  it("the Chat closes, shows another pane, or the window goes out of sight: the reads stop, the row goes", async () => {
    for (const change of ["closed", "another pane", "hidden"] as const) {
      const { herdr, events, live, show } = await setup();
      show({ paneId: "w1:p1" });
      await pass(0);
      if (change === "another pane") show({ paneId: "w1:p4" });
      else show();
      expect(stops(events), change).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p1", follow: 1, keeping: false }]);
      const reads = herdr.reads().length;
      await pass(4_000);
      expect(herdr.reads(), change).toHaveLength(reads);
      expect(live.following, change).toEqual([]);
    }
  });

  it("the machine goes (offline, or no connection): the reads stop, the row goes", async () => {
    const { herdr, registry, events, live, show } = await setup();
    show({ paneId: "w1:p1" });
    await pass(0);
    (registry as unknown as { entries: { state: string }[] }).entries[0]!.state = "offline";
    live.sync();
    expect(stops(events)).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p1", follow: 1, keeping: false }]);
    const reads = herdr.reads().length;
    await pass(4_000);
    expect(herdr.reads()).toHaveLength(reads);
  });

  it("another terminal, session or connection: the old reads stop (the row goes) and the new ones begin", async () => {
    for (const change of ["terminal", "session", "epoch"] as const) {
      const { herdr, epoch, events, live, show, snapshotNow } = await setup();
      show({ paneId: "w1:p1" });
      await pass(0);
      if (change === "terminal") herdr.paneEntry("w1:p1")["terminal_id"] = "term-9";
      if (change === "session") herdr.agentEntry("w1:p1")["agent_session"] = { source: "herdr:claude", agent: "claude", kind: "id", value: "s-9" };
      if (change === "epoch") epoch.value = 2;
      await snapshotNow();
      expect(stops(events), change).toEqual([{ type: "stop", hostId: "mac", paneId: "w1:p1", follow: 1, keeping: false }]);
      expect(live.following, change).toEqual(["mac w1:p1"]);
      live.closeAll();
    }
  });

  it("the same Chat on the same pane re-opened (a new follow number) goes on, its blocks with the new number", async () => {
    const { herdr, events, live, show } = await setup();
    show({ paneId: "w1:p1", follow: 3 });
    await pass(0);
    show({ paneId: "w1:p1", follow: 4 });
    expect(stops(events)).toEqual([]);
    await pass(400);
    expect(herdr.reads()).toHaveLength(2);
    expect(blocks(events).at(-1)).toMatchObject({ follow: 4 });
    live.closeAll();
  });
});

describe("a read that comes back late", () => {
  it("is dropped when the Chat closed, moved, or the pane's terminal, session or connection changed meanwhile", async () => {
    for (const change of ["closed", "moved", "terminal", "session", "epoch", "stopped working"] as const) {
      const { herdr, epoch, events, live, show, snapshotNow } = await setup();
      herdr.holding = true;
      show({ paneId: "w1:p1" });
      await pass(0);
      expect(herdr.held, change).toHaveLength(1);
      if (change === "closed") show();
      if (change === "moved") show({ paneId: "w1:p4" });
      if (change === "terminal") herdr.paneEntry("w1:p1")["terminal_id"] = "term-9";
      if (change === "session") herdr.agentEntry("w1:p1")["agent_session"] = { source: "herdr:claude", agent: "claude", kind: "id", value: "s-9" };
      if (change === "epoch") epoch.value = 2;
      if (change === "stopped working") herdr.status("w1:p1", "done");
      if (change !== "closed" && change !== "moved") {
        // The epoch changes with no snapshot yet (the backend's own); the others come with one.
        if (change !== "epoch") await snapshotNow();
      }
      herdr.holding = false;
      herdr.held.shift()!.release();
      await pass(0);
      expect(blocks(events), change).toEqual([]);
      live.closeAll();
    }
  });
});

describe("one read of a pane at a time, with the needs-you card's", () => {
  it("a live read waits while the card's read of the pane is out", async () => {
    const { herdr, gate, live, show } = await setup();
    expect(gate.begin(paneReadKey("mac", "w1:p1"))).toBe(true);
    show({ paneId: "w1:p1" });
    await pass(2_000);
    expect(herdr.reads()).toEqual([]);
    gate.end(paneReadKey("mac", "w1:p1"));
    await pass(400);
    expect(herdr.reads()).toHaveLength(1);
    live.closeAll();
  });

  it("the card's round leaves a pane whose live read is out (the real PromptService on the same gate)", async () => {
    vi.useRealTimers();
    const herdr = new FakeHerdr(snapshot(), { "w1:p1": [L.claude2_1_303Bash] });
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "mac", name: "Mac mini", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
    await registry.refreshAll();
    const gate = new PaneReadGate();
    const service = new PromptService(registry, () => undefined, clock(), gate);
    expect(gate.begin(paneReadKey("mac", "w1:p1"))).toBe(true);
    await service.tick();
    expect(herdr.sent("pane.read")).toEqual([]);
    gate.end(paneReadKey("mac", "w1:p1"));
    await service.tick();
    expect(herdr.sent("pane.read")).toHaveLength(1);
    expect(gate.busy(paneReadKey("mac", "w1:p1"))).toBe(false);
  });
});

// The needs-you card's answer reads its pane too (the fingerprint
// before the keys, then the agent's field before the text): through the same gate, waiting its turn.
describe("an answer shares the pane's one read", () => {
  it("the gate: a read waits while another is out, goes next (before any new read), and lets go even when it fails", async () => {
    const gate = new PaneReadGate();
    const order: string[] = [];
    expect(gate.begin("p")).toBe(true);
    const waiting = gate.reading("p", async () => {
      order.push("answer read");
      return "screen";
    });
    await pass(0);
    expect(order).toEqual([]);
    gate.end("p");
    expect(gate.begin("p"), "the waiting read goes first").toBe(false);
    expect(await waiting).toBe("screen");
    expect(order).toEqual(["answer read"]);
    expect(gate.busy("p")).toBe(false);
    await expect(gate.reading("p", () => Promise.reject(new Error("no answer")))).rejects.toThrow("no answer");
    expect(gate.busy("p"), "released in finally").toBe(false);
    expect(gate.begin("p")).toBe(true);
    gate.end("p");
  });

  it("a live read still out after the pane went blocked, then an answer: one pane.read in flight", async () => {
    class HeldLive extends FakeHerdr {
      holdNext = false;
      release: (() => void) | null = null;
      out = 0;
      most = 0;
      override async roundTrip(line: string): Promise<string> {
        if ((JSON.parse(line) as { method: string }).method !== "pane.read") return super.roundTrip(line);
        this.out += 1;
        this.most = Math.max(this.most, this.out);
        const reply = super.roundTrip(line);
        if (this.holdNext) {
          this.holdNext = false;
          await new Promise<void>((resolve) => (this.release = resolve));
        }
        try {
          return await reply;
        } finally {
          this.out -= 1;
        }
      }
    }
    // No episode stamps: the brief working spell does not end the question's episode.
    const json = snapshot();
    delete (json["agents"] as Json[])[0]!["status_since_unix_ms"];
    const herdr = new HeldLive(json, { "w1:p1": [L.claude2_1_303Bash] });
    const registry = new HostRegistry(() => undefined);
    registry.add({ id: "mac", name: "Mac", kind: "demo", address: "demo", platform: "macOS" }, backend(herdr, { value: 1 }));
    await registry.refreshAll();
    const gate = new PaneReadGate();
    const prompts = new PromptService(registry, () => undefined, clock(), gate);
    await prompts.tick();
    const prompt = prompts.list().find((p) => p.paneId === "w1:p1")!;
    const match = readingMatch(prompt.reading!)!;
    const owner: ChatOwner = { id: 9, send: () => undefined, isDestroyed: () => false };
    const live = new LiveReads(registry, () => [{ owner, slot: "tile", follow: 1, hostId: "mac", paneId: "w1:p1" }], () => undefined, { gate });
    for (const entry of [herdr.paneEntry("w1:p1"), herdr.agentEntry("w1:p1")]) entry["agent_status"] = "working";
    await registry.refreshAll();
    herdr.holdNext = true;
    live.sync();
    await pass(0);
    expect(herdr.out).toBe(1);
    for (const entry of [herdr.paneEntry("w1:p1"), herdr.agentEntry("w1:p1")]) entry["agent_status"] = "blocked";
    await registry.refreshAll();
    live.sync();
    expect(live.following).toEqual([]);
    const answer = prompts.answer({
      hostId: "mac",
      paneId: "w1:p1",
      binding: stopBindingOf(registry.list()[0]!, "w1:p1", "Claude"),
      fingerprint: match.fingerprint,
      episode: prompt.episode,
      key: match.options[0]!.key,
    });
    await pass(0);
    expect(herdr.sent("pane.send_keys"), "the answer waits for the live read").toEqual([]);
    herdr.release?.();
    expect((await answer).type).toBe("sent");
    expect(herdr.most, "one read of the pane in flight, the answer's included").toBe(1);
    await pass(0);
    expect(gate.busy(paneReadKey("mac", "w1:p1"))).toBe(false);
    live.closeAll();
    registry.close();
  });

  it("every read of an answer with text (its fingerprint, then the field) goes out holding the pane's gate", async () => {
    const { herdr, service, request } = await promptSetup(L.claude2_1_303Bash, [L.claude2_1_303AfterNo]);
    const gate = (service as unknown as { gate: PaneReadGate }).gate;
    const held: boolean[] = [];
    const roundTrip = herdr.roundTrip.bind(herdr);
    herdr.roundTrip = (line: string): Promise<string> => {
      if ((JSON.parse(line) as { method: string }).method === "pane.read") held.push(gate.busy(paneReadKey("mac", "w1:p1")));
      return roundTrip(line);
    };
    herdr.beforeKeys = () => {
      herdr.agentEntry("w1:p1")["agent_status"] = "idle";
      herdr.paneEntry("w1:p1")["agent_status"] = "idle";
    };
    expect(await service.answer(request("4", "Use the staging folder instead"))).toEqual({ type: "sent", label: "No" });
    expect(herdr.sent("agent.prompt")).toEqual([{ target: "w1:p1", text: "Use the staging folder instead" }]);
    expect(held.length, "the fingerprint's read and the field's").toBeGreaterThanOrEqual(2);
    expect(held.every(Boolean)).toBe(true);
    expect(gate.busy(paneReadKey("mac", "w1:p1"))).toBe(false);
  });
});

describe("the Chats on screen (ChatService)", () => {
  it("lists the Chats followed in windows in sight, and says when they may have changed", () => {
    const hosts: ChatHosts = { backend: () => null, pane: () => null, agent: () => null };
    const service = new ChatService(hosts, "chat");
    let changes = 0;
    service.onShownChange(() => (changes += 1));
    const page: ChatOwner = { id: 1, send: () => undefined, isDestroyed: () => false };
    service.open(page, "A", "w1:p1", "A/w1:p1", 7);
    expect(service.shown()).toEqual([{ owner: page, slot: "A/w1:p1", follow: 7, hostId: "A", paneId: "w1:p1" }]);
    expect(changes).toBe(1);
    service.setPaused(page, true);
    expect(service.shown()).toEqual([]);
    expect(changes).toBe(2);
    service.setPaused(page, false);
    expect(service.shown()).toHaveLength(1);
    service.refresh();
    expect(changes).toBe(4);
    service.close(page, "A/w1:p1");
    expect(service.shown()).toEqual([]);
    expect(changes).toBe(5);
  });
});

// The pane's agent picks the reader. The
// same Cursor-shaped screen on a Claude, a Codex, a Cursor, a Grok and a shell
// pane gives a Cursor block only on the Cursor pane; a screen's shape alone
// never opts a pane into another agent's reader.
describe("only a Cursor pane is read as Cursor", () => {
  for (const kind of ["claude", "codex", "cursor", "grok", ""] as const) {
    it(`the Cursor screen on a ${kind || "shell"} pane: ${kind === "cursor" ? "its reply" : kind === "claude" || kind === "codex" ? "read, no block" : "not read"}`, async () => {
      const context = await setup();
      const { herdr, events, live, show } = context;
      const pane = herdr.paneEntry("w1:p3");
      if (kind === "") delete pane["agent"];
      else pane["agent"] = kind;
      pane["agent_status"] = "working";
      await context.snapshotNow();
      show({ paneId: "w1:p3", follow: 2 });
      await pass(1_200);
      const read = blocks(events);
      if (kind === "grok" || kind === "") {
        expect(herdr.reads("w1:p3"), "not read").toEqual([]);
        expect(read).toEqual([]);
      } else if (kind === "cursor") {
        expect(read.length).toBeGreaterThan(0);
        for (const event of read) expect(event).toEqual({ type: "block", hostId: "mac", paneId: "w1:p3", follow: 2, block: liveBlock(cursorWriting.text!, false, "cursor") });
      } else {
        expect(herdr.reads("w1:p3").length, "read").toBeGreaterThan(0);
        expect(read.map((event) => (event.type === "block" ? event.block : "stop")), "no Cursor block on a non-Cursor pane").toEqual(read.map(() => null));
      }
      live.closeAll();
    });
  }

  it("a pane whose agent becomes Cursor reads as Cursor from then on; one that stops being Cursor stops reading as Cursor", async () => {
    const context = await setup();
    const { herdr, events, live, show } = context;
    herdr.paneEntry("w1:p3")["agent"] = "codex";
    herdr.paneEntry("w1:p3")["agent_status"] = "working";
    await context.snapshotNow();
    show({ paneId: "w1:p3" });
    await pass(800);
    expect(blocks(events).every((event) => event.type === "block" && event.block === null)).toBe(true);
    herdr.paneEntry("w1:p3")["agent"] = "cursor";
    await context.snapshotNow();
    events.length = 0;
    await pass(800);
    expect(blocks(events).some((event) => event.type === "block" && event.block?.drawing === "cursor")).toBe(true);
    herdr.paneEntry("w1:p3")["agent"] = "claude";
    await context.snapshotNow();
    events.length = 0;
    await pass(800);
    expect(blocks(events).length).toBeGreaterThan(0);
    expect(blocks(events).every((event) => event.type === "block" && event.block === null)).toBe(true);
    live.closeAll();
  });

  it("Claude's and Codex's screens on their own panes read as before (Claude's and Codex's shapes, kind given or not)", () => {
    for (const screen of [workingRecent, workingVisible, workerRecent]) {
      expect(ChatLiveScreen.block(screen, "claude")).toEqual(ChatLiveScreen.block(screen));
      expect(ChatLiveScreen.block(screen, "claude")).not.toBeNull();
    }
    for (const fixture of codexScreens) expect(ChatLiveScreen.block(fixture.screen, "codex"), fixture.name).toEqual(ChatLiveScreen.block(fixture.screen));
    // A screen's shape alone: no Cursor reading without the Cursor kind.
    for (const fixture of cursorScreens) {
      expect(ChatLiveScreen.block(fixture.screen), fixture.name).toBeNull();
      expect(ChatLiveScreen.block(fixture.screen, "claude"), fixture.name).toBeNull();
      expect(ChatLiveScreen.block(fixture.screen, "codex"), fixture.name).toBeNull();
      expect(ChatLiveScreen.block(fixture.screen, "cursor")?.text ?? null, fixture.name).toEqual(fixture.text);
    }
  });

  it("the reader passes the kind it follows to the screen's reading", async () => {
    const delivered: (ChatLiveBlock | null)[] = [];
    const reader = new ChatLiveReader((_pane, block) => delivered.push(block), { intervalMs: 50 });
    reader.follow("w1:p3", "k-claude", async () => cursorWriting.screen, "claude");
    await pass(0);
    reader.follow("w1:p3", "k-cursor", async () => cursorWriting.screen, "cursor");
    await pass(0);
    reader.close();
    expect(delivered).toEqual([null, liveBlock(cursorWriting.text!, false, "cursor")]);
  });
});
