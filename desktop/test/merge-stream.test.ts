// Chat's shelf (kept paused feeds, warmed feeds, cold loads) where it meets
// the per-feed settings reader (the chips and the ring), the split view's
// tile slots and its window out of sight, and the subagents' timeline items. A kept chat
// opened again shows its chips' and ring's values at once with its timeline;
// a window out of sight keeps its tiles' feeds on the shelf and takes them back
// without a "loading"; the shelf charges a subagents row and another session's
// message by their text.

import { describe, expect, it } from "vitest";

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { HostRegistry } from "../src/main/hosts";
import { approximateBytes } from "../src/shared/chat/shelf";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { eventually, session, stamp, timelineOf, user } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

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
  return { registry, service };
}

const mac = demoHostIds.macMini;
const ready = (update: ChatUpdateEvent | undefined): boolean =>
  update?.state.status === "live" && update.settings?.modelLabel != null && typeof update.settings.used === "number" && update.settings.limits != null;

describe("a kept chat opened again", () => {
  it("shows its chips' and ring's values at once, with its timeline, from the reader it was kept with", async () => {
    const { registry, service } = await demoChats();
    const page = new Page(1);
    service.open(page, mac, "w7:p1H");
    expect(await eventually(() => ready(page.lastFor("w7:p1H")), 5_000)).toBe(true);
    const before = page.lastFor("w7:p1H")!;
    service.open(page, mac, "w7:p1G");
    expect(await eventually(() => page.lastFor("w7:p1G")?.state.status === "live", 5_000)).toBe(true);
    expect(service.keptKeys).toHaveLength(1);

    const count = page.updates.length;
    service.open(page, mac, "w7:p1H");
    // The first update, sent as it is taken back (no read yet): the chips, the ring and the user's limits as they were.
    const first = page.updates[count]!;
    expect(first.paneId).toBe("w7:p1H");
    expect(first.state.status).toBe("live");
    expect(first.timeline.turns.length).toBe(before.timeline.turns.length);
    expect(first.settings).toMatchObject({
      model: before.settings!.model,
      modelLabel: before.settings!.modelLabel,
      effort: before.settings!.effort,
      used: before.settings!.used,
      scope: before.settings!.scope,
      limits: before.settings!.limits,
    });
    // The pane it left is the one kept now.
    expect(service.keptKeys).toHaveLength(1);
    expect(service.keptKeys[0]).not.toContain(before.settings!.scope.session ?? "no session");
    service.closeAll();
    registry.close();
  });
});

describe("a window out of sight with two tiles", () => {
  it("keeps both tiles' feeds on the shelf and takes them back, chips and ring included, with no loading", async () => {
    const { registry, service } = await demoChats();
    const page = new Page(1);
    service.open(page, mac, "w7:p1G", "host/w7:p1G");
    service.open(page, mac, "w7:p1H", "host/w7:p1H");
    expect(await eventually(() => ready(page.lastFor("w7:p1G")) && ready(page.lastFor("w7:p1H")), 5_000)).toBe(true);
    const shown = { g: page.lastFor("w7:p1G")!, h: page.lastFor("w7:p1H")! };
    service.setPaused(page, true);
    expect(service.keptKeys).toHaveLength(2);
    const sent = page.updates.length;
    service.setPaused(page, false);
    expect(service.keptKeys).toEqual([]);
    const back = page.updates.slice(sent);
    expect(back.some((update) => update.state.status === "loading")).toBe(false);
    for (const [pane, was] of [["w7:p1G", shown.g], ["w7:p1H", shown.h]] as const) {
      const now = back.find((update) => update.paneId === pane)!;
      expect(now.state.status).toBe("live");
      expect(now.settings).toMatchObject({ modelLabel: was.settings!.modelLabel, used: was.settings!.used, scope: was.settings!.scope });
    }
    service.closeAll();
    registry.close();
  });
});

describe("the shelf's charge", () => {
  it("counts a subagents row's reports and another session's message", () => {
    const agent = JSON.stringify({
      isSidechain: false,
      sessionId: session,
      timestamp: stamp(1),
      type: "assistant",
      uuid: "a-1",
      message: { content: [{ id: "toolu_1", input: { description: "Read the banner", prompt: "p", subagent_type: "Explore" }, name: "Agent", type: "tool_use" }], role: "assistant", stop_reason: "tool_use" },
    });
    const report = "R".repeat(20_000);
    const result = JSON.stringify({
      isSidechain: false,
      sessionId: session,
      timestamp: stamp(9),
      type: "user",
      uuid: "r-1",
      message: { content: [{ content: report, is_error: false, tool_use_id: "toolu_1", type: "tool_result" }], role: "user" },
    });
    const peer = user('Another Claude session sent a message:\n<agent-message from="w7:p1">\n' + "P".repeat(5_000) + "\n</agent-message>", "m1", 10, {
      isMeta: true,
      promptSource: "system",
      turnOrigin: "peer",
      origin: { kind: "peer" },
    });
    const typed = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } };
    const bare = approximateBytes(timelineOf([user("Check it", "u1", 0, typed)]).timeline);
    const withAgents = timelineOf([user("Check it", "u1", 0, typed), agent, result, peer]).timeline;
    expect(withAgents.turns[0]!.items.map((item) => item.type)).toEqual(expect.arrayContaining(["agents", "agentMessage"]));
    expect(approximateBytes(withAgents) - bare).toBeGreaterThan(report.length + 5_000);
  });
});
