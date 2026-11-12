// A pane switch shows its Chat at once, in the
// main process's Chat (src/main/chat/service.ts). A window that moves to
// another pane keeps the old one's feed paused on the shelf; switching back
// shows what it held at once and reads on from its offset; the shelf keeps
// eight panes with the one on show; panes the sidebar shows working or just
// finished are warmed, at most two at once and one warming read at a time per
// machine. One fixture machine, its transcripts built by hand, read through a
// reader paced as SFTP over a real link.

import { describe, expect, it } from "vitest";

import { ChatService, warmRetryMs, type ChatHosts, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHosts } from "../src/main/demo/demo-hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { HostRegistry } from "../src/main/hosts";
import type { TranscriptFileReader } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { eventually, reply, user } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const host = "mac-1";

class Page implements ChatOwner {
  readonly updates: ChatUpdateEvent[] = [];
  constructor(readonly id: number) {}
  send(_channel: string, payload: ChatUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return false;
  }
  get last(): ChatUpdateEvent | undefined {
    return this.updates.at(-1);
  }
}

const sessionOf = (pane: string): string => `session-${pane}`;
const pathOf = (pane: string): string => `/Users/fixture/.claude/projects/-Users-fixture-proj/${sessionOf(pane)}.jsonl`;

function transcript(pane: string, turns = 3): string {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(user(`question ${turn} on ${pane}`, `u${turn}`, turn * 10));
    lines.push(reply(`answer ${turn} on ${pane}`, `a${turn}`, turn * 10 + 1, true));
  }
  return lines.join("\n") + "\n";
}

function lastAgentText(timeline: ChatTimeline): string | null {
  const item = timeline.turns.at(-1)?.items.at(-1);
  return item?.type === "agentText" ? item.value.markdown : null;
}

/**
 * The machine's transcripts, read as SFTP reads them over a real link: each request a round trip, a read the
 * open, its chunk requests (256 KB each, 8 in flight) and the close, the bytes at 80 MB/s. It logs each call
 * by path and counts the calls in flight at once for the paths in `counted`.
 */
class Machine implements TranscriptFileReader<TranscriptSessionRef> {
  private readonly files = new Map<string, Uint8Array>();
  readonly log: { call: string; path: string }[] = [];
  readonly counted = new Set<string>();
  now = 0;
  most = 0;

  constructor(private readonly roundTripMs = 25) {}

  put(pane: string, text: string): void {
    this.files.set(pathOf(pane), new TextEncoder().encode(text));
  }

  append(pane: string, text: string): void {
    const old = this.files.get(pathOf(pane)) ?? new Uint8Array(0);
    const more = new TextEncoder().encode(text);
    const next = new Uint8Array(old.length + more.length);
    next.set(old, 0);
    next.set(more, old.length);
    this.files.set(pathOf(pane), next);
  }

  remove(pane: string): void {
    this.files.delete(pathOf(pane));
  }

  sizeOf(pane: string): number {
    return this.files.get(pathOf(pane))?.length ?? 0;
  }

  calls(pane: string): string[] {
    return this.log.filter((entry) => entry.path === pathOf(pane)).map((entry) => entry.call);
  }

  locate(session: TranscriptSessionRef): Promise<string | null> {
    const path = session.lookup.kind === "id" ? `/Users/fixture/.claude/projects/-Users-fixture-proj/${session.lookup.id}.jsonl` : "";
    return this.flight(path, "locate", 1, () => (this.files.has(path) ? path : null));
  }

  size(path: string): Promise<number> {
    return this.flight(path, "size", 1, () => this.files.get(path)?.length ?? 0);
  }

  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    const file = this.files.get(path) ?? new Uint8Array(0);
    const bytes = file.slice(Math.min(offset, file.length), Math.min(file.length, offset + maxBytes));
    const batches = Math.ceil(Math.max(1, Math.ceil(bytes.length / (256 * 1_024))) / 8);
    const transfer = bytes.length / ((80 * 1_024 * 1_024) / 1_000);
    return this.flight(path, `read ${offset}`, 2 + batches, () => bytes, transfer);
  }

  private async flight<T>(path: string, call: string, roundTrips: number, answer: () => T, extraMs = 0): Promise<T> {
    const counted = this.counted.has(path);
    if (counted) {
      this.now += 1;
      this.most = Math.max(this.most, this.now);
    }
    // Logged when asked: a call in flight when its feed stops was asked before.
    this.log.push({ call, path });
    try {
      await sleep(this.roundTripMs * roundTrips + extraMs);
      return answer();
    } finally {
      if (counted) this.now -= 1;
    }
  }
}

function fleet(panes: readonly string[], options: { roundTripMs?: number; statuses?: Record<string, string>; clock?: { now: number } } = {}) {
  const machine = new Machine(options.roundTripMs);
  for (const pane of panes) machine.put(pane, transcript(pane));
  const statuses = new Map(Object.entries(options.statuses ?? {}));
  const backend = { transcripts: () => machine } as unknown as HerdrHostBackend;
  const hosts = {
    backend: () => backend,
    pane: (_host: string, pane: string) => ({ paneID: pane, terminalID: `t-${pane}`, agent: "claude", cwd: "/Users/fixture/proj" }),
    agent: (_host: string, pane: string) => ({
      paneID: pane,
      agent: "claude",
      cwd: "/Users/fixture/proj",
      agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: sessionOf(pane) },
      agentStatus: statuses.get(pane) ?? "idle",
    }),
    agentPanes: () => panes.map((pane) => ({ hostId: host, paneId: pane })),
  } as unknown as ChatHosts;
  const clock = options.clock;
  const service = new ChatService(hosts, "chat", { pollIntervalMs: 50 }, clock === undefined ? {} : { now: () => clock.now });
  return { machine, service, statuses };
}

/** Opens `pane` in the page and waits for its chat to be live with its last answer. */
async function show(service: ChatService, page: Page, pane: string): Promise<void> {
  service.open(page, host, pane);
  expect(await eventually(() => page.last?.paneId === pane && page.last.state.status === "live" && lastAgentText(page.last.timeline) === `answer 2 on ${pane}`, 5_000)).toBe(true);
}

const keyIn = (keys: readonly string[], pane: string): string | undefined => keys.find((key) => key.includes(sessionOf(pane)));
/** The pane's key among the panes the user opened, kept. */
const keyOf = (service: ChatService, pane: string): string | undefined => keyIn(service.keptKeys, pane);
/** The pane's key among the warmed ones, kept. */
const warmedOf = (service: ChatService, pane: string): string | undefined => keyIn(service.warmedKeys, pane);
const panesOf = (keys: readonly string[], panes: readonly string[]): (string | undefined)[] =>
  keys.map((key) => panes.find((pane) => key.includes(sessionOf(pane))));

describe("the chat service: a pane switch shows its Chat at once", () => {
  it("switches back to a kept pane at once (under 100 ms) and reads on from where it was", async () => {
    const { machine, service } = fleet(["p1", "p2"]);
    const page = new Page(1);
    await show(service, page, "p1");
    await show(service, page, "p2");
    expect(service.keptKeys).toHaveLength(1);
    expect(keyOf(service, "p1")?.startsWith(`${host}|`)).toBe(true);

    // Kept paused: written to while away, it reads nothing.
    const offset = machine.sizeOf("p1");
    const before = machine.calls("p1").length;
    machine.append("p1", reply("written while away", "w1", 99, true) + "\n");
    await sleep(250);
    expect(machine.calls("p1").slice(before), "a kept feed reads nothing").toEqual([]);

    const count = page.updates.length;
    const switched = performance.now();
    service.open(page, host, "p1");
    const back = await eventually(() => page.last?.paneId === "p1" && page.last.state.status === "live", 5_000);
    const took = performance.now() - switched;
    console.log(`pane switch (desktop): back to a kept pane in ${took.toFixed(2)} ms`);
    expect(back).toBe(true);
    expect(took, `back to the kept pane in ${took} ms`).toBeLessThan(100);
    const first = page.updates[count]!;
    expect(first.paneId).toBe("p1");
    expect(first.state.status, "its chat as it was kept, not a load").toBe("live");
    expect(lastAgentText(first.timeline)).toBe("answer 2 on p1");

    // It reads on at once from its offset.
    expect(await eventually(() => lastAgentText(page.last!.timeline) === "written while away", 2_000)).toBe(true);
    const reads = machine.calls("p1").slice(before).filter((call) => call.startsWith("read"));
    expect(reads[0], reads.join(", ")).toBe(`read ${offset}`);
    expect(machine.calls("p1").slice(before), "no new lookup: the same feed").not.toContain("locate");
    // The pane it left is kept now.
    expect(keyOf(service, "p2")).toBeDefined();
    expect(keyOf(service, "p1")).toBeUndefined();
    service.closeAll();
    expect(service.keptKeys).toEqual([]);
  });

  it("keeps the last seven panes besides the one on show: the oldest goes, stopped", async () => {
    const panes = Array.from({ length: 9 }, (_, index) => `p${index}`);
    const { machine, service } = fleet(panes, { roundTripMs: 2 });
    const page = new Page(1);
    for (const pane of panes) await show(service, page, pane);
    expect(service.keptKeys).toHaveLength(7);
    expect(keyOf(service, "p0"), "the oldest went").toBeUndefined();
    for (const pane of panes.slice(1, 8)) expect(keyOf(service, pane), pane).toBeDefined();

    // A kept one is on show at once; the one that went loads again.
    let count = page.updates.length;
    service.open(page, host, "p7");
    expect(page.updates[count]?.state.status).toBe("live");
    count = page.updates.length;
    const located = machine.calls("p0").filter((call) => call === "locate").length;
    service.open(page, host, "p0");
    expect(page.updates[count]?.state.status).toBe("loading");
    expect(await eventually(() => page.last?.paneId === "p0" && page.last.state.status === "live", 5_000)).toBe(true);
    expect(machine.calls("p0").filter((call) => call === "locate").length).toBe(located + 1);
    expect(service.keptKeys).toHaveLength(7);
    service.closeAll();
  });

  it("warms the panes shown working or just finished, at most two at once, one read at a time on the machine", async () => {
    const panes = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const { machine, service, statuses } = fleet(panes, {
      statuses: { p1: "working", p2: "done", p3: "idle", p4: "working", p5: "blocked", p6: "working" },
    });
    for (const pane of panes.slice(1)) machine.counted.add(pathOf(pane));
    const page = new Page(1);
    await show(service, page, "p1");

    service.refresh();
    expect(panesOf(service.warmingKeys, panes), "two at once, in the sidebar's order").toEqual(["p2", "p4"]);
    let most = service.warmingKeys.length;
    const settled = await eventually(() => {
      most = Math.max(most, service.warmingKeys.length + service.warmedKeys.length);
      return service.warmingKeys.length === 0 && service.warmedKeys.length === 2;
    }, 5_000);
    expect(settled).toBe(true);
    expect(panesOf(service.warmedKeys, panes)).toEqual(["p2", "p4"]);
    expect(most, "two warm at most, warming or warmed").toBeLessThanOrEqual(2);
    expect(machine.most, "one warming read in flight on the machine").toBe(1);
    expect(machine.calls("p3"), "idle: not warmed").toEqual([]);
    expect(machine.calls("p5"), "blocked: not warmed").toEqual([]);
    expect(machine.calls("p6"), "no room yet").toEqual([]);
    expect(service.keptKeys, "warmed ones are not the user's panes").toEqual([]);

    // Warmed and kept: paused, reading nothing.
    const quiet = machine.log.length;
    await sleep(200);
    expect(machine.log.slice(quiet).filter((entry) => entry.path !== pathOf("p1"))).toEqual([]);

    // A warmed pane is on show at once; its room goes to the next working pane.
    let count = page.updates.length;
    let switched = performance.now();
    service.open(page, host, "p4");
    let took = performance.now() - switched;
    console.log(`pane switch (desktop): a warmed pane on show in ${took.toFixed(2)} ms`);
    expect(page.updates[count]?.state.status).toBe("live");
    expect(lastAgentText(page.updates[count]!.timeline)).toBe("answer 2 on p4");
    expect(took).toBeLessThan(100);
    expect(keyOf(service, "p1"), "the pane the user left is theirs, kept").toBeDefined();
    // On show, p4 reads straight through: only the warming reads are counted.
    machine.counted.delete(pathOf("p4"));
    machine.most = machine.now;
    service.refresh();
    expect(panesOf(service.warmingKeys, panes)).toEqual(["p6"]);
    expect(await eventually(() => warmedOf(service, "p6") !== undefined, 5_000)).toBe(true);
    expect(machine.most).toBe(1);

    // A warmed pane no longer working or just finished goes on the next snapshot.
    statuses.set("p2", "idle");
    service.refresh();
    expect(panesOf(service.warmedKeys, panes)).toEqual(["p6"]);
    count = page.updates.length;
    switched = performance.now();
    service.open(page, host, "p6");
    took = performance.now() - switched;
    expect(page.updates[count]?.state.status).toBe("live");
    expect(took).toBeLessThan(100);

    service.closeAll();
    expect(service.keptKeys).toEqual([]);
    expect(service.warmedKeys).toEqual([]);
    const after = machine.log.length;
    await sleep(150);
    expect(machine.log.length, "everything stopped").toBe(after);
  });

  it("does not warm again at once a pane whose warm found no chat, nor push out a pane the user opened", async () => {
    const clock = { now: 0 };
    const panes = Array.from({ length: 10 }, (_, index) => `p${index}`);
    const { machine, service, statuses } = fleet(panes, { roundTripMs: 2, clock });
    // A new session: Herdr names it, its transcript is not written yet.
    machine.remove("p8");
    statuses.set("p8", "working");
    service.refresh();
    expect(await eventually(() => service.warmingKeys.length === 0, 2_000)).toBe(true);
    await sleep(30);
    expect(machine.calls("p8"), "tried once").toEqual(["locate"]);
    service.refresh();
    clock.now = warmRetryMs - 1;
    service.refresh();
    await sleep(30);
    expect(machine.calls("p8"), "not again before the wait is over").toEqual(["locate"]);
    clock.now = warmRetryMs;
    service.refresh();
    await sleep(30);
    expect(machine.calls("p8")).toEqual(["locate", "locate"]);

    // The user opened seven panes and shows an eighth: the shelf is full.
    const page = new Page(1);
    for (const pane of panes.slice(0, 8)) await show(service, page, pane);
    expect(service.keptKeys).toHaveLength(7);
    const kept = [...service.keptKeys];
    // Two working panes the user has not opened warm beside theirs, pushing none of them out.
    machine.put("p8", transcript("p8"));
    statuses.set("p9", "working");
    clock.now = 3 * warmRetryMs;
    service.refresh();
    expect(await eventually(() => service.warmingKeys.length === 0 && service.warmedKeys.length === 2, 2_000)).toBe(true);
    expect(panesOf(service.warmedKeys, panes)).toEqual(["p8", "p9"]);
    expect(service.keptKeys, "the panes the user opened stay").toEqual(kept);
    // Panes the user opened that work now are kept already: nothing more warms.
    for (const pane of panes.slice(0, 7)) statuses.set(pane, "working");
    service.refresh();
    expect(service.warmingKeys).toEqual([]);
    service.closeAll();
  });

  it("warms from the machine list: its agent panes, machine by machine, at most two at once", async () => {
    const registry = new HostRegistry(() => undefined);
    const fixtures = bundledFixturesForTests();
    for (const demo of demoHosts(fixtures, Date.now())) registry.add(demo.descriptor, new DemoBackend(demo, fixtures));
    await registry.refreshAll();
    const listed = registry.list().flatMap((entry) => (entry.topology?.agents ?? []).map((agent) => ({ hostId: entry.id, paneId: agent.paneID })));
    expect(listed.length).toBeGreaterThan(2);
    expect(registry.agentPanes()).toEqual(listed);
    const working = listed.filter(({ hostId, paneId }) => ["working", "done"].includes(registry.agent(hostId, paneId)?.agentStatus ?? ""));
    expect(working.length, "the demo has panes to warm").toBeGreaterThan(0);
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    service.refresh();
    expect(service.warmingKeys.length).toBeGreaterThan(0);
    expect(service.warmingKeys.length).toBeLessThanOrEqual(2);
    expect(await eventually(() => service.warmingKeys.length === 0, 5_000)).toBe(true);
    expect(service.warmedKeys.length).toBeLessThanOrEqual(2);
    service.closeAll();
    expect(service.warmedKeys).toEqual([]);
    registry.close();
  });

  it("takes a pane still warming as it is when a window opens it: one feed, its reads past the gate", async () => {
    const { machine, service } = fleet(["p1", "p2", "p3"], { statuses: { p2: "working", p3: "working" } });
    machine.counted.add(pathOf("p2"));
    machine.counted.add(pathOf("p3"));
    service.refresh();
    expect(service.warmingKeys).toHaveLength(2);
    const page = new Page(1);
    service.open(page, host, "p3");
    expect(panesOf(service.warmingKeys, ["p2", "p3"]), "the one opened is no longer warming").toEqual(["p2"]);
    expect(await eventually(() => page.last?.paneId === "p3" && lastAgentText(page.last.timeline) === "answer 2 on p3", 5_000)).toBe(true);
    expect(machine.calls("p3").filter((call) => call === "locate"), "one feed: looked up once").toHaveLength(1);
    expect(await eventually(() => service.warmingKeys.length === 0 && warmedOf(service, "p2") !== undefined, 5_000)).toBe(true);
    expect(warmedOf(service, "p3")).toBeUndefined();
    expect(keyOf(service, "p3")).toBeUndefined();
    // Written to while on show: it follows.
    machine.append("p3", reply("more on p3", "m3", 98, true) + "\n");
    expect(await eventually(() => lastAgentText(page.last!.timeline) === "more on p3", 2_000)).toBe(true);
    service.closeAll();
    expect(service.warmingKeys).toEqual([]);
  });
});

describe("a parked feed's shelf charge follows its snapshot", () => {
  /**
   * P1 opened, its first read still out when the window moves to p2, so it is kept charged what
   * it holds then (nothing); then that read lands.
   */
  async function parkWhileLoading(byteBudget: number) {
    const machine = new Machine(5);
    machine.put("p1", transcript("p1"));
    machine.put("p2", transcript("p2"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstReads = 0;
    const reader: TranscriptFileReader<TranscriptSessionRef> = {
      locate: (session) => machine.locate(session),
      size: (path) => machine.size(path),
      read: async (path, offset, maxBytes) => {
        if (path === pathOf("p1") && firstReads++ === 0) await held;
        return machine.read(path, offset, maxBytes);
      },
    };
    const backend = { transcripts: () => reader } as unknown as HerdrHostBackend;
    const hosts = {
      backend: () => backend,
      pane: (_host: string, pane: string) => ({ paneID: pane, terminalID: `t-${pane}`, agent: "claude", cwd: "/Users/fixture/proj" }),
      agent: (_host: string, pane: string) => ({
        paneID: pane,
        agent: "claude",
        cwd: "/Users/fixture/proj",
        agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: sessionOf(pane) },
        agentStatus: "idle",
      }),
      agentPanes: () => [],
    } as unknown as ChatHosts;
    const service = new ChatService(hosts, "chat", { pollIntervalMs: 50 }, {}, { byteBudget });
    const page = new Page(1);
    service.open(page, host, "p1");
    expect(await eventually(() => firstReads === 1, 2_000)).toBe(true);
    await show(service, page, "p2");
    expect(panesOf(service.keptKeys, ["p1"]), "kept while it loads").toEqual(["p1"]);
    expect(service.keptBytes, "charged what it holds: nothing yet").toBe(0);
    release();
    return { machine, service };
  }

  it("charges a parked feed what it holds once its outstanding read lands", async () => {
    const { service } = await parkWhileLoading(1_000_000);
    expect(await eventually(() => service.keptBytes > 0, 2_000), "charged what it holds now").toBe(true);
    expect(service.keptBytes).toBeGreaterThan(128);
    expect(panesOf(service.keptKeys, ["p1"])).toEqual(["p1"]);
    service.closeAll();
  });

  it("trims the shelf to its budget when a parked feed's late snapshot does not fit, and stops that feed", async () => {
    const { machine, service } = await parkWhileLoading(128);
    expect(await eventually(() => service.keptKeys.length === 0, 2_000), "trimmed to the budget").toBe(true);
    expect(service.keptBytes).toBeLessThanOrEqual(128);
    const calls = machine.calls("p1").length;
    await sleep(250);
    expect(machine.calls("p1").slice(calls), "its feed stopped").toEqual([]);
    service.closeAll();
  });
});
