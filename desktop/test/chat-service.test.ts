// The main process's Chat (src/main/chat/service.ts) over the demo machine:
// the session from the snapshot, the feed's updates to the window, the
// desktop's own states, switching panes, pictures, and closing.

import { describe, expect, it } from "vitest";

import { ChatService, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import { demoShotPath } from "../src/main/demo/demo-chat";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { HostRegistry } from "../src/main/hosts";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { turnRows, type ChatTimeline } from "../src/shared/chat/model";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { eventually, user } from "./support/chat-lines";

class Page implements ChatOwner {
  readonly updates: ChatUpdateEvent[] = [];
  destroyed = false;
  constructor(readonly id: number) {}
  send(_channel: string, payload: ChatUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  get last(): ChatUpdateEvent | undefined {
    return this.updates.at(-1);
  }
}

async function setup(): Promise<{ registry: HostRegistry; service: ChatService }> {
  const registry = new HostRegistry(() => undefined);
  const fixtures = bundledFixturesForTests();
  for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures));
  await registry.refreshAll();
  return { registry, service: new ChatService(registry, "chat", { pollIntervalMs: 5 }) };
}

const kinds = (timeline: ChatTimeline): string[] =>
  timeline.turns.flatMap((turn) => turnRows(turn).map((row) => (row.type === "folded" ? "fold" : row.item.type)));

describe("the chat service", () => {
  it("follows a demo agent pane's transcript and sends each change to the window", async () => {
    const { registry, service } = await setup();
    const page = new Page(1);
    service.open(page, demoHostIds.macMini, "w7:p1G");
    await eventually(() => page.last?.state.status === "live");
    const { timeline } = page.last!;
    expect(page.last).toMatchObject({ hostId: demoHostIds.macMini, paneId: "w7:p1G" });
    // The queued message goes inside the running turn at its place, which runs on.
    expect(timeline.turns.map((turn) => turn.isFinished)).toEqual([true, false]);
    // The running turn shows each of its calls (it folds them once it finishes).
    expect(kinds(timeline)).toEqual(["user", "fold", "agentText", "agentText", "user", "toolCall", "progress", "toolCall", "user", "toolCall"]);
    service.closeAll();
    registry.close();
  });

  it("says why there is no chat: a shell, a pane with no session, a machine with no reader", async () => {
    const { registry, service } = await setup();
    const page = new Page(1);
    service.open(page, demoHostIds.buildBox, "w2:p3");
    expect(page.last?.state).toEqual({ status: "unavailable", reason: "notAgent" });
    // A Claude pane Herdr names no session for: its folder's newest transcript, and the demo has none.
    service.open(page, demoHostIds.macMini, "w9:p1");
    await eventually(() => page.last?.state.status === "unavailable");
    expect(page.last?.state).toEqual({ status: "unavailable", reason: "notFound" });
    // A Codex pane with no session: nothing to look up.
    service.open(page, demoHostIds.macMini, "wA:pM");
    expect(page.last?.state).toEqual({ status: "unavailable", reason: "noSession" });
    const backend = registry.backend(demoHostIds.macMini)!;
    const noReader: ChatHosts = {
      backend: () => ({ ...backend, kind: "herdr-core", transcripts: () => null }) as HerdrHostBackend,
      pane: (h, p) => registry.pane(h, p),
      agent: (h, p) => registry.agent(h, p),
    };
    const core = new ChatService(noReader, "chat");
    const other = new Page(2);
    core.open(other, demoHostIds.macMini, "w7:p1G");
    expect(other.last?.state).toEqual({ status: "unavailable", reason: "noAccess" });
    service.closeAll();
    registry.close();
  });

  it("switches panes and drops the old pane's updates", async () => {
    const { registry, service } = await setup();
    const page = new Page(1);
    service.open(page, demoHostIds.macMini, "w7:p1G");
    await eventually(() => page.last?.state.status === "live");
    service.open(page, demoHostIds.macMini, "w5:pH");
    await eventually(() => page.last?.paneId === "w5:pH" && page.last.state.status === "live");
    expect(page.last!.timeline.turns.length).toBe(1);
    const count = page.updates.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(page.updates.slice(count).every((update) => update.paneId === "w5:pH")).toBe(true);
    // Opening the same pane again re-sends what is shown.
    service.open(page, demoHostIds.macMini, "w5:pH");
    expect(page.updates.length).toBeGreaterThan(count);
    expect(page.last!.state.status).toBe("live");
    service.closeAll();
    registry.close();
  });

  it("shows a message sent from the box once the demo transcript has it", async () => {
    const { registry, service } = await setup();
    const page = new Page(1);
    service.open(page, demoHostIds.macMini, "w7:p1H");
    await eventually(() => page.last?.state.status === "live");
    // The interrupted request, then the finished turn (a notice in place for the captures).
    expect(page.last!.timeline.turns.length).toBe(2);
    expect(page.last!.timeline.turns[0]!.items.some((item) => item.type === "notice")).toBe(true);
    const backend = registry.backend(demoHostIds.macMini) as DemoBackend;
    backend.transcripts().record("w7:p1H", "and the iPad sizes", false, Date.now());
    await eventually(() => page.last!.timeline.turns.length === 3);
    const last = page.last!.timeline.turns.at(-1)!;
    expect(last.items[0]).toMatchObject({ type: "user", value: { text: "and the iPad sizes" } });
    service.closeAll();
    registry.close();
  });

  it("reads a picture only when a message in the window's chat carries it", async () => {
    const { registry, service } = await setup();
    const page = new Page(1);
    expect(await service.image(page, demoShotPath)).toBeNull();
    service.open(page, demoHostIds.macMini, "w7:p1G");
    await eventually(() => page.last?.state.status === "live");
    const url = await service.image(page, demoShotPath);
    expect(url?.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
    const transcript = (registry.backend(demoHostIds.macMini) as DemoBackend).transcripts();
    expect(await transcript.size(demoShotPath)).toBeGreaterThan(0);
    expect(await service.image(page, "/etc/passwd")).toBeNull();
    service.closeAll();
    registry.close();
  });

  it("stops following when the window closes or is gone", async () => {
    const { registry, service } = await setup();
    const page = new Page(1);
    service.open(page, demoHostIds.macMini, "w7:p1G");
    await eventually(() => page.last?.state.status === "live");
    service.close(page);
    const count = page.updates.length;
    service.refresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(page.updates.length).toBe(count);
    const gone = new Page(2);
    service.open(gone, demoHostIds.macMini, "w7:p1H");
    gone.destroyed = true;
    service.refresh();
    expect(await service.image(gone, demoShotPath)).toBeNull();
    service.closeAll();
    registry.close();
  });

  // A transcript that appears after Chat opened (a new
  // Claude session writes it only after its first message) loads on a later
  // snapshot; an unavailable feed is retried, at most once per interval.
  describe("a transcript that appears later", () => {
    function fixture(clock: { now: number }, retry: { afterMs?: number; maxMs?: number }) {
      const state = { exists: false, locates: 0 };
      const bytes = new TextEncoder().encode(user("hello", "u1", 0) + "\n");
      const reader = {
        locate: async () => {
          state.locates += 1;
          return state.exists ? "/fixture.jsonl" : null;
        },
        size: async () => bytes.length,
        read: async (_path: string, offset: number, length: number) => bytes.slice(offset, offset + length),
      };
      const backend = { transcripts: () => reader } as unknown as HerdrHostBackend;
      const pane = { paneID: "w1:p1", terminalID: "t", agent: "claude", cwd: "/Users/fixture/proj" };
      const agent = { paneID: "w1:p1", agent: "claude", cwd: "/Users/fixture/proj", agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "abcdefgh" } };
      const hosts = { backend: () => backend, pane: () => pane, agent: () => agent } as unknown as ChatHosts;
      const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 }, { ...retry, now: () => clock.now });
      return { state, service };
    }

    it("loads on the next snapshot once the file exists", async () => {
      const clock = { now: 0 };
      const { state, service } = fixture(clock, {});
      const page = new Page(1);
      service.open(page, "host", "w1:p1");
      await eventually(() => page.last?.state.status === "unavailable");
      expect(page.last?.state).toEqual({ status: "unavailable", reason: "notFound" });
      state.exists = true;
      service.refresh();
      await eventually(() => page.last?.state.status === "live");
      expect(page.last!.timeline.turns[0]!.items[0]).toMatchObject({ type: "user", value: { text: "hello" } });
      service.closeAll();
    });

    it("retries at most once per interval, doubling, and keeps showing why meanwhile", async () => {
      const clock = { now: 0 };
      const { state, service } = fixture(clock, { afterMs: 1_000, maxMs: 3_000 });
      const page = new Page(1);
      service.open(page, "host", "w1:p1");
      await eventually(() => page.last?.state.status === "unavailable");
      const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
      const at = async (ms: number) => {
        clock.now = ms;
        service.refresh();
        await settle();
        return state.locates;
      };
      const shown = page.updates.length;
      expect(await at(0)).toBe(2); // the first snapshot after it went unavailable retries
      expect(await at(500)).toBe(2);
      expect(await at(999)).toBe(2);
      expect(await at(1_000)).toBe(3); // then 1 s, 2 s, then at most every 3 s
      expect(await at(2_999)).toBe(3);
      expect(await at(3_000)).toBe(4);
      expect(await at(5_999)).toBe(4);
      expect(await at(6_000)).toBe(5);
      // The page kept the reason: no "loading" flicker, no repeated identical update.
      expect(page.updates.slice(shown).map((update) => update.state.status)).toEqual([]);
      service.closeAll();
    });
  });
});
