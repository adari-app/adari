// Demo mode: the fake Herdr answers through the real client and decoders, its
// two machines give the sidebar a Needs you group across both, and a demo
// terminal plays the repo's recorded streams byte for byte with their timing
// (and Ghostty shows the recorded screen at the end).

import { readFileSync } from "node:fs";
import path from "node:path";

import { Ghostty } from "ghostty-web";
import { beforeAll, describe, expect, it } from "vitest";

import { DemoBackend, FixtureTransport, ReplayTerminal, demoScriptFor, loopPauseMs, textScreen, type DemoClock } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts, type DemoFixtures, type DemoHost } from "../src/main/demo/demo-hosts";
import { HerdrClient } from "../src/main/herdr/client";
import { APIError, type SessionTopology } from "../src/main/herdr/wire";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { screenText } from "../src/shared/ghostty-screen";
import { parseReplay, replayDuration, screenLines } from "../src/shared/replay";
import { desktopRoot, fixturesRoot } from "./support/swift-fixtures";

const read = (file: string): Buffer => readFileSync(path.join(fixturesRoot, file));
const json = (file: string): unknown => JSON.parse(read(file).toString("utf8"));

const fixtures: DemoFixtures = {
  sidebarWorkspaces: json("protocol22/sidebar-workspaces.json") as unknown[],
  sidebarTabs: json("protocol22/sidebar-tabs.json") as unknown[],
  sidebarPanes: json("protocol22/sidebar-panes.json") as unknown[],
  mockAgentList: json("protocol22/mock-agent-list.json"),
  idle: new Uint8Array(read("replay/idle.hfx")),
  heavy: new Uint8Array(read("replay/heavy-excerpt.hfx")),
  bashDialog: read("replay/claude-2.1.303-bash-dialog.txt").toString("utf8"),
};

const start = 1_800_000_000_000;
const minute = 60_000;

/** Timers that run only when the test advances them. */
class FakeClock implements DemoClock {
  now = 0;
  private sequence = 0;
  private tasks: { at: number; seq: number; run: () => void; cancelled: boolean }[] = [];

  schedule(run: () => void, delayMs: number): () => void {
    const task = { at: this.now + delayMs, seq: this.sequence++, run, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.tasks.splice(this.tasks.indexOf(due), 1);
      this.now = due.at;
      due.run();
    }
    this.now = end;
  }

  get pending(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function topologies(): Promise<{ host: DemoHost; backend: DemoBackend; topology: SessionTopology }[]> {
  return Promise.all(
    demoHosts(fixtures, start).map(async (host) => {
      const backend = new DemoBackend(host, fixtures, new FakeClock());
      return { host, backend, topology: await backend.snapshot() };
    }),
  );
}

describe("the demo's fake Herdr", () => {
  it("answers session.snapshot through the real client and decoders", async () => {
    const [mac, box] = await topologies();
    expect(mac?.topology.protocolVersion).toBe(22);
    expect(mac?.topology.panes.length).toBe(23);
    expect(mac?.topology.workspaces.length).toBe(11);
    expect(box?.topology.workspaces.map((w) => [w.label, w.agentStatus])).toEqual([
      ["clients", "blocked"],
      ["herdr", "working"],
      ["research", "idle"],
      ["calls", "done"],
    ]);
    expect(box?.topology.panes.map((p) => p.label)).toEqual([
      "beacon",
      "bookshop",
      "trendline",
      "herdr-tools",
      "crm-sync",
      "stock-screener",
      "discovery",
      "bank-check",
      "build",
    ]);
    expect(JSON.parse(mac?.backend.transport.requests[0] ?? "{}")).toMatchObject({ method: "session.snapshot" });
  });

  it("answers agent.list and a sent line; refuses what it does not know", async () => {
    const [host] = demoHosts(fixtures, start);
    const transport = new FixtureTransport(host!.snapshot);
    const client = new HerdrClient(transport);
    expect((await client.agentList()).find((a) => a.paneID === "w2:p70")?.inputPending).toBe(true);
    await client.sendLine("w2:p70", "yes");
    expect(JSON.parse(transport.requests.at(-1)!)).toMatchObject({
      method: "pane.send_input",
      params: { pane_id: "w2:p70", text: "yes", keys: ["Enter"] },
    });
    await expect(client.sendText("w2:p70", "x").then(() => "ok")).resolves.toBe("ok");
    const reply = await transport.roundTrip('{"id":"x","method":"server.stop","params":{}}');
    expect(() => {
      throw new APIError("unknown_method", JSON.parse(reply).error.message);
    }).toThrow(APIError);
    expect(JSON.parse(reply).error.code).toBe("unknown_method");
  });

  it("gives the sidebar two machines, Needs you first across both", async () => {
    const hosts: SidebarHost[] = (await topologies()).map(({ host, topology }) => ({
      id: host.descriptor.id,
      name: host.descriptor.name,
      platform: host.descriptor.platform,
      state: "connected",
      error: null,
      topology,
    }));
    const sidebar = buildDesktopSidebar(hosts, { nowUnixMs: start + minute / 2 });
    // Mac mini's Grok pane waits on its approval frame; its Codex pane on Codex's tool-call question.
    expect(sidebar.needsYou.map((row) => [row.key, row.row.name, row.row.time])).toEqual([
      [`${demoHostIds.macMini}/wD:pK`, "tidepool-narration · grok", "1m"],
      [`${demoHostIds.buildBox}/w1:p1`, "beacon", "1m"],
      [`${demoHostIds.macMini}/w2:p70`, "Notes Opus", "2m"],
      [`${demoHostIds.buildBox}/w1:p2`, "bookshop", "7m"],
      [`${demoHostIds.macMini}/wA:pM`, "lumen-onboarding-perf · codex", "12m"],
    ]);
    expect(sidebar.badge).toBe(5);
    const glyphs = new Set(sidebar.hosts.flatMap((h) => h.model?.projects.flatMap((p) => p.rows.map((r) => r.glyph)) ?? []));
    expect([...glyphs].sort()).toEqual(["doneUnseen", "idle", "needsYou", "shell", "working"]);
    expect(sidebar.hosts.map((h) => h.host.name)).toEqual(["Mac mini", "build-box"]);
  });

  it("picks the dialog for a pane needing you, the stream for a working one, idle for the rest", async () => {
    const [mac, box] = await topologies();
    const pane = (t: SessionTopology | undefined, id: string) => t!.panes.find((p) => p.paneID === id)!;
    expect(demoScriptFor(mac!.host.snapshot, pane(mac?.topology, "w2:p70"), fixtures).kind).toBe("text");
    expect(demoScriptFor(mac!.host.snapshot, pane(mac?.topology, "w7:p1G"), fixtures)).toMatchObject({ kind: "replay", loop: true });
    expect(demoScriptFor(mac!.host.snapshot, pane(mac?.topology, "w9:p1"), fixtures)).toMatchObject({ kind: "replay", loop: false });
    expect(demoScriptFor(box!.host.snapshot, pane(box?.topology, "w2:p3"), fixtures)).toMatchObject({ kind: "replay", loop: false });
  });
});

describe("demo replay", () => {
  let ghostty: Ghostty;

  beforeAll(async () => {
    const wasm = readFileSync(path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm"));
    const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
    ghostty = new Ghostty(instance);
  });

  function show(bytes: Uint8Array, cols: number, rows: number): string[] {
    const terminal = ghostty.createTerminal(cols, rows);
    try {
      terminal.write(bytes);
      terminal.update();
      return screenLines(screenText(terminal, rows), rows);
    } finally {
      terminal.free();
    }
  }

  it("plays a recording byte for byte with its own timing, then stops", () => {
    const clock = new FakeClock();
    const recording = parseReplay(fixtures.idle);
    const received: { at: number; bytes: Uint8Array }[] = [];
    const terminal = new ReplayTerminal({ kind: "replay", recording, loop: false }, { data: (bytes) => received.push({ at: clock.now, bytes }), exit: () => undefined }, clock);
    terminal.start();
    expect(received).toEqual([]);
    clock.advance(60_000);
    expect(received.length).toBe(recording.chunks.length);
    expect(concat(received.map((r) => r.bytes))).toEqual(concat(recording.chunks.map((c) => c.bytes)));
    expect(received.at(-1)!.at).toBeCloseTo(Math.round(replayDuration(recording) * 1000), -2);
    expect(clock.pending).toBe(0);

    const expected = JSON.parse(read("replay/idle.expected.json").toString("utf8")) as { checkpoints: { lines: string[] }[] };
    expect(show(concat(received.map((r) => r.bytes)), recording.cols, recording.rows)).toEqual(expected.checkpoints.at(-1)!.lines);
  });

  it("loops a working pane's stream after a pause, and stops when closed", () => {
    const clock = new FakeClock();
    const recording = parseReplay(fixtures.heavy);
    let chunks = 0;
    const terminal = new ReplayTerminal({ kind: "replay", recording, loop: true }, { data: () => (chunks += 1), exit: () => undefined }, clock);
    terminal.start();
    const pass = Math.round(replayDuration(recording) * 1000) + loopPauseMs;
    clock.advance(pass + 1);
    expect(chunks).toBeGreaterThan(recording.chunks.length);
    terminal.close();
    const after = chunks;
    clock.advance(pass * 3);
    expect(chunks).toBe(after);
    expect(clock.pending).toBe(0);
  });

  it("shows the needs-you dialog as one cleared screen, cut (not wrapped) at the edge", () => {
    const bytes = textScreen(fixtures.bashDialog);
    const lines = show(bytes, 120, 40);
    const source = fixtures.bashDialog.replace(/\r?\n$/, "").split(/\r?\n/).map((l) => l.replace(/ +$/, ""));
    expect(lines.slice(0, source.length)).toEqual(source.map((l) => l.slice(0, 120)));
  });

  it("closes every terminal with its machine", async () => {
    const clock = new FakeClock();
    const [host] = demoHosts(fixtures, start);
    const backend = new DemoBackend(host!, fixtures, clock);
    const topology = await backend.snapshot();
    let chunks = 0;
    await backend.openTerminal(topology.panes.find((p) => p.paneID === "w7:p1G")!, { cols: 80, rows: 24 }, { data: () => (chunks += 1), exit: () => undefined });
    clock.advance(500);
    expect(chunks).toBeGreaterThan(0);
    backend.close();
    const after = chunks;
    clock.advance(20_000);
    expect(chunks).toBe(after);
  });
});
