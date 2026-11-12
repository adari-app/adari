// The snapshot and every event into the model
// (herdr-core schema/README.md "Events"), the model into the sidebar's types,
// and the live follower against the fake core. Ported from the iPhone app's
// CoreModelTests.swift.

import { describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { CoreBridgeTransport, CoreTUIWire } from "../src/main/herdr/core-bridge";
import { coreChangeEvents } from "../src/main/herdr/core-backend";
import { CoreFollower, type CoreFollowerChange, type CoreFollowerOptions } from "../src/main/herdr/core-follower";
import { coreJSONString, parseCoreJSON, type CoreJSON } from "../src/main/herdr/core-json";
import { CoreIDs, CoreLayoutDocument, CoreModel } from "../src/main/herdr/core-model";
import { CoreAgentKind, CoreStatusMapping, projectCore, type CoreProjection } from "../src/main/herdr/core-projection";
import { CoreBackoff, CoreSession } from "../src/main/herdr/core-session";
import { CoreLinkError } from "../src/main/herdr/core-ssh";
import { decodeCoreMachineView, decodeCoreTerminal, parseCoreNotification, type CoreMachineView, type CoreNotification, type CoreTerminal } from "../src/main/herdr/core-wire";
import { APIError, decodeAgentListResult, decodeReply, decodeSessionSnapshotResult } from "../src/main/herdr/wire";
import { agentStatusFromWire } from "../src/shared/sidebar-model";
import { eventually, pause } from "./support/core-test-link";
import { FakeCore, type TerminalFixture } from "./support/fake-core";

const terminal = (json: CoreJSON): CoreTerminal => decodeCoreTerminal(json);

const event = (seq: number, type: string, address: string | undefined, data: CoreJSON, machine?: string): CoreNotification => ({
  kind: "event",
  seq,
  type,
  ...(address === undefined ? {} : { terminal: address }),
  ...(machine === undefined ? {} : { machine }),
  data,
});

function model(terminals: CoreJSON[], seq = 10): CoreModel {
  return new CoreModel(seq, terminals.map(terminal));
}

function fixture(address: string, options: TerminalFixture = {}): CoreJSON {
  return FakeCore.terminal(address, options);
}

describe("the README's table, row by row", () => {
  it("every event applies as the README says", () => {
    const m = model([fixture("t1", { status: FakeCore.status("idle"), turn: 2, foreground: FakeCore.foreground("claude", ["claude"], "/a"), keep: true })]);
    // created: add it.
    expect(m.apply(event(11, "created", "t2", fixture("t2")))).toEqual({ kind: "applied", changed: "t2" });
    expect(m.terminals.map((t) => t.address)).toEqual(["t1", "t2"]);
    // status: replace status, records and reported.
    m.apply(event(12, "status", "t1", { status: FakeCore.status("working"), records: { "7501": FakeCore.status("working") }, reported: true }));
    expect(m.terminal("t1")?.status?.state).toBe("working");
    expect(m.terminal("t1")?.records["7501"]?.state).toBe("working");
    // turn: set turn.
    m.apply(event(13, "turn", "t1", { turn: 3, state: "done" }));
    expect(m.terminal("t1")?.turn).toBe(3);
    // title, size, keep.
    m.apply(event(14, "title", "t1", { title: "fixing tests" }));
    m.apply(event(15, "size", "t1", { cols: 100, rows: 30 }));
    m.apply(event(16, "keep", "t1", { keep: false }));
    expect(m.terminal("t1")?.title).toBe("fixing tests");
    expect([m.terminal("t1")?.cols, m.terminal("t1")?.rows]).toEqual([100, 30]);
    expect(m.terminal("t1")?.keep).toBe(false);
    // labels: replace labels.
    m.apply(event(17, "labels", "t1", { labels: { "herdr.seen": "3" } }));
    expect(m.terminal("t1")?.labels).toEqual({ "herdr.seen": "3" });
    // foreground: set it; null clears it.
    m.apply(event(18, "foreground", "t1", FakeCore.foreground("vim", ["vim"], "/b")));
    expect(m.terminal("t1")?.foreground?.name).toBe("vim");
    m.apply(event(19, "foreground", "t1", null));
    expect(m.terminal("t1")?.foreground).toBeUndefined();
    // lost: stays live; set these, clear pid, drop foreground.
    m.apply(event(20, "foreground", "t1", FakeCore.foreground("claude", ["claude"], "/a")));
    m.apply(event(21, "lost", "t1", { reason: "signaled", exit_code: null, signal: 9, finished_ms: null }));
    expect(m.terminal("t1")?.state).toBe("live");
    expect(m.terminal("t1")?.reason).toBe("signaled");
    expect(m.terminal("t1")?.signal).toBe(9);
    expect(m.terminal("t1")?.pid).toBeUndefined();
    expect(m.terminal("t1")?.foreground).toBeUndefined();
    // restarted: replace it.
    m.apply(event(22, "restarted", "t1", fixture("t1", { pid: 777 })));
    expect(m.terminal("t1")?.pid).toBe(777);
    expect(m.terminal("t1")?.reason).toBeUndefined();
    // finished: state finished, these, foreground dropped.
    m.apply(event(23, "foreground", "t2", FakeCore.foreground("make", ["make"], "/c")));
    m.apply(event(24, "finished", "t2", { reason: "exited", exit_code: 2, signal: null, finished_ms: 5 }));
    expect(m.terminal("t2")?.state).toBe("finished");
    expect(m.terminal("t2")?.exitCode).toBe(2);
    expect(m.terminal("t2")?.finishedMs).toBe(5);
    expect(m.terminal("t2")?.foreground).toBeUndefined();
    // removed: drop it.
    expect(m.apply(event(25, "removed", "t2", {}))).toEqual({ kind: "applied", changed: "t2" });
    expect(m.terminal("t2")).toBeUndefined();
    expect(m.seq).toBe(25);
    expect(m.revisions.get("t1")).toBe(22);
  });

  it("labels with a record add the terminal", () => {
    const m = model([]);
    const outcome = m.apply(event(11, "labels", "t9", { labels: { "herdr.space": "s1" }, record: fixture("t9") }));
    expect(outcome).toEqual({ kind: "applied", changed: "t9" });
    expect(m.terminal("t9")?.labels).toEqual({ "herdr.space": "s1" });
  });

  it("seq order is checked", () => {
    const m = model([fixture("t1")], 10);
    // Not above the snapshot's seq: already in it.
    expect(m.apply(event(10, "title", "t1", { title: "old" }))).toEqual({ kind: "stale" });
    expect(m.terminal("t1")?.title).toBe("");
    // A skipped seq: a fresh snapshot is needed.
    expect(m.apply(event(12, "title", "t1", { title: "x" }))).toEqual({ kind: "gap", expected: 11, got: 12 });
    expect(m.seq).toBe(10);
    // A heartbeat ahead of us is a gap too; at our seq it is alive.
    expect(m.apply({ kind: "heartbeat", seq: 10 })).toEqual({ kind: "alive" });
    expect(m.apply({ kind: "heartbeat", seq: 11 })).toEqual({ kind: "gap", expected: 11, got: 11 });
    // missed: a fresh snapshot replaces everything.
    expect(m.apply({ kind: "missed", seq: 57, terminals: [terminal(fixture("t4"))] })).toEqual({ kind: "replaced" });
    expect(m.seq).toBe(57);
    expect(m.terminals.map((t) => t.address)).toEqual(["t4"]);
    // A doc event names its document and machine.
    expect(m.apply(event(58, "doc", undefined, { name: "herdr-app", version: 4 }, "studio"))).toEqual({ kind: "document", name: "herdr-app", machine: "studio" });
  });

  it("seq values above 2^53 stay exact", () => {
    const big = 2n ** 60n;
    const m = new CoreModel(big, [terminal(fixture("t1"))]);
    expect(m.apply(event(0, "title", "t1", { title: "x" }))).toEqual({ kind: "stale" });
    expect(m.apply({ kind: "event", seq: big + 1n, type: "title", terminal: "t1", data: { title: "y" } })).toEqual({ kind: "applied", changed: "t1" });
    expect(m.seq).toBe(big + 1n);
    expect(m.apply({ kind: "event", seq: big + 3n, type: "title", terminal: "t1", data: { title: "z" } })).toEqual({ kind: "gap", expected: big + 2n, got: big + 3n });
  });

  it("notifications parse as the README writes them", () => {
    const parsed = parseCoreNotification(parseCoreJSON('{"jsonrpc":"2.0","method":"event","params":{"seq":42,"type":"status","terminal":"t7","data":{"status":null,"records":{},"reported":true}}}'));
    expect(parsed).toEqual({ kind: "event", seq: 42, type: "status", terminal: "t7", data: { status: null, records: {}, reported: true } });
    expect(parseCoreNotification(parseCoreJSON('{"jsonrpc":"2.0","method":"heartbeat","params":{"seq":42}}'))).toEqual({ kind: "heartbeat", seq: 42 });
    expect(parseCoreNotification(parseCoreJSON('{"jsonrpc":"2.0","method":"missed","params":{"seq":57,"terminals":[]}}'))).toEqual({ kind: "missed", seq: 57, terminals: [] });
  });
});

describe("status and agent kind", () => {
  it("core statuses become ours", () => {
    const wire = (state: string | null, turn = 0, seen?: string): string =>
      CoreStatusMapping.wire(
        terminal(
          fixture("t1", {
            labels: seen === undefined ? {} : { "herdr.seen": seen },
            ...(state === null ? {} : { status: FakeCore.status(state) }),
            turn,
          }),
        ),
      );
    expect(wire("blocked")).toBe("blocked");
    expect(wire("error"), "error needs you, as blocked does (labels.md)").toBe("blocked");
    expect(wire("working")).toBe("working");
    expect(wire("idle")).toBe("idle");
    expect(wire("done")).toBe("done");
    expect(wire("idle", 4, "3"), "a turn ended since you looked").toBe("done");
    expect(wire("done", 4, "4"), "seen: nothing new").toBe("idle");
    expect(wire(null), "hc never infers status").toBe("unknown");
    expect(wire("thinking"), "an unknown word goes through for the app to place").toBe("thinking");
    expect(agentStatusFromWire(wire("blocked"))).toBe("blocked");
    expect(CoreStatusMapping.urgent(["idle", "working", "blocked"])).toBe("blocked");
    expect(CoreStatusMapping.urgent(["idle", "done"])).toBe("done");
    expect(CoreStatusMapping.urgent([])).toBe("unknown");
  });

  it("the agent kind comes from what runs", () => {
    const kind = (name: string, argv: string[], app?: string): string | undefined =>
      CoreAgentKind.detect(
        terminal(
          fixture("t1", {
            ...(app === undefined ? {} : { status: FakeCore.status("idle", app) }),
            foreground: FakeCore.foreground(name, argv, "/"),
          }),
        ),
      );
    expect(kind("claude", ["claude", "--resume", "x"])).toBe("claude");
    expect(kind("node", ["node", "/opt/lib/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe("claude");
    expect(kind("codex", ["/usr/local/bin/codex"])).toBe("codex");
    expect(kind("node", ["node", "/Users/me/.bun/bin/codex"])).toBe("codex");
    expect(kind("grok", ["grok"])).toBe("grok");
    expect(kind("zsh", ["-zsh"])).toBeUndefined();
    expect(kind("vim", ["vim", "claude.md"])).toBeUndefined();
    expect(kind("zsh", ["zsh"], "claude"), "the program's own 7501 app").toBe("claude");
  });

  it("an argv session is Chat's session", () => {
    const id = "0b9d1f3a-1111-4222-8333-944455556666";
    const claude = terminal(fixture("t1", { foreground: FakeCore.foreground("claude", ["claude", "--resume", id], "/") }));
    expect(CoreAgentKind.session(claude, "claude")).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: id });
    const codex = terminal(fixture("t1", { foreground: FakeCore.foreground("codex", ["codex", "resume", id], "/") }));
    expect(CoreAgentKind.session(codex, "codex")?.value).toBe(id);
    const bare = terminal(fixture("t1", { foreground: FakeCore.foreground("claude", ["claude"], "/") }));
    expect(CoreAgentKind.session(bare, "claude")).toBeUndefined();
  });
});

const layoutDocument = FakeCore.layout([
  {
    id: "s1",
    name: "App",
    folder: "/Users/me/code/app",
    tabs: [
      { id: "tA", name: "Build", terminals: ["t1", "t2"] },
      { id: "tB", name: "", terminals: ["t3"] },
    ],
  },
  { id: "s2", name: "", folder: "/Users/me/code/site", tabs: [{ id: "tC", name: "Main", terminals: [] }] },
]);

function project(terminals: CoreJSON[], documents: Record<string, CoreJSON> = { "": layoutDocument }, machines: Record<string, CoreMachineView> = {}): CoreProjection {
  return projectCore({
    model: model(terminals),
    documents: new Map(Object.entries(documents).map(([name, value]) => [name, CoreLayoutDocument.from(value, 1)])),
    machineName: "mini",
    version: "0.1.16",
    machines: new Map(Object.entries(machines)),
  });
}

describe("groups", () => {
  it("spaces come from the document and the labels", () => {
    const claude = FakeCore.foreground("claude", ["claude"], "/Users/me/code/app/ios");
    const p = project([
      fixture("t1", { status: FakeCore.status("blocked", "claude", "permission"), foreground: claude }),
      fixture("t2"),
      fixture("t3", { status: FakeCore.status("working", null) }),
      // Labels only: Herdr App started it in s1/tB (AGENTS.md:136-145).
      fixture("t4", { labels: { "herdr.space": "s1", "herdr.tab": "tB" } }),
      // A space the document does not have yet.
      fixture("t5", { cwd: "/Users/me/code/notes", labels: { "herdr.space": "s9" } }),
      // In no space: the machine's own group.
      fixture("t6"),
      fixture("t7", { state: "finished" }),
    ]);
    const t = p.topology;
    expect(t.workspaces.map((w) => w.workspaceID)).toEqual(["hc:space:s1", "hc:space:s2", "hc:space:s9", "hc:machine"]);
    expect(t.workspaces.map((w) => w.label)).toEqual(["App", "site", "notes", "mini"]);
    expect(t.workspaces.map((w) => Number(w.number))).toEqual([1, 2, 3, 4]);
    expect(t.tabs.filter((tab) => tab.workspaceID === "hc:space:s1").map((tab) => tab.label)).toEqual(["Build", "Tab 2"]);
    expect(t.panes.filter((pane) => pane.tabID === "hc:tab:tA").map((pane) => pane.paneID)).toEqual(["hc:t1", "hc:t2"]);
    expect(t.panes.filter((pane) => pane.tabID === "hc:tab:tB").map((pane) => pane.paneID)).toEqual(["hc:t3", "hc:t4"]);
    expect(t.panes.find((pane) => pane.paneID === "hc:t6")?.workspaceID).toBe("hc:machine");
    // A finished terminal stays, ended, until it is removed.
    expect(t.panes.find((pane) => pane.paneID === "hc:t7")?.title, "a finished terminal keeps an ended row").toBe("Exited");
    expect(t.workspaces[0]?.agentStatus).toBe("blocked");
    expect(Number(t.workspaces[1]?.paneCount), "an empty space is still a space").toBe(0);
    // The agent: kind, needs-you, cwd from the foreground.
    expect(p.agents.map((agent) => agent.paneID)).toEqual(["hc:t1"]);
    const agent = p.agents[0];
    expect(agent?.agent).toBe("claude");
    expect(agentStatusFromWire(agent?.agentStatus)).toBe("blocked");
    expect(agent?.inputPending).toBe(true);
    expect(agent?.inputPromptKind).toBe("permission");
    expect(agent?.cwd).toBe("/Users/me/code/app/ios");
    expect(agent?.terminalID).toBe("hc:t1");
    expect(t.panes[0]?.foregroundCWD).toBe("/Users/me/code/app/ios");
  });

  it("remote machines group under their name", () => {
    const p = project(
      [
        fixture("t1"),
        fixture("studio/t7", { status: FakeCore.status("working"), foreground: FakeCore.foreground("codex", ["codex"], "/srv") }),
        fixture("studio/t8", { labels: { "herdr.space": "r1" } }),
      ],
      { "": null, studio: FakeCore.layout([{ id: "r1", name: "Server", folder: "/srv", tabs: [{ id: "rt", name: "Logs", terminals: [] }] }]) },
      { studio: decodeCoreMachineView(FakeCore.machine("studio", "unreachable")) },
    );
    const t = p.topology;
    expect(t.workspaces.map((w) => w.workspaceID)).toEqual(["hc:machine", "hc:machine:studio"]);
    expect(t.workspaces.map((w) => w.label)).toEqual(["mini", "studio"]);
    expect(t.tabs.filter((tab) => tab.workspaceID === "hc:machine:studio").map((tab) => tab.label)).toEqual(["studio", "Server · Logs"]);
    expect(t.panes.find((pane) => pane.paneID === "hc:studio/t7")?.tabID).toBe("hc:tab:machine:studio");
    expect(t.panes.find((pane) => pane.paneID === "hc:studio/t8")?.tabID).toBe("hc:tab:studio/rt");
    // An unreachable machine: status unknown, the last one kept.
    const agent = p.agents.find((a) => a.paneID === "hc:studio/t7");
    expect(agent?.machineID).toBe("studio");
    expect(agent?.reachability).toBe("unreachable");
    expect(agent?.agentStatus).toBe("unknown");
    expect(agent?.lastKnownStatus).toBe("working");
  });

  it("pinned and ids carry their source", () => {
    const p = project([fixture("t1", { labels: { "herdr.pinned": "1" } }), fixture("t2", { labels: { "herdr.pinned": "" } })]);
    expect([...p.pinned]).toEqual(["hc:t1"]);
    expect(p.topology.panes.every((pane) => CoreIDs.isCore(pane.paneID) && CoreIDs.isCore(pane.workspaceID) && CoreIDs.isCore(pane.tabID))).toBe(true);
    expect(CoreIDs.address("hc:studio/t7")).toBe("studio/t7");
    expect(CoreIDs.address("w3:p1")).toBeUndefined();
    expect(CoreIDs.address("hc:space:s1")).toBeUndefined();
    expect(CoreIDs.spaceID("hc:space:studio/r1")?.id).toBe("r1");
    expect(CoreIDs.spaceID("hc:space:studio/r1")?.machine).toBe("studio");
  });

  it("the wire shape decodes back to the same topology through the desktop's own decoders", () => {
    const p = project([
      fixture("t1", {
        status: FakeCore.status("blocked"),
        turn: 3,
        title: "fix",
        foreground: FakeCore.foreground("claude", ["claude", "-r", "0b9d1f3a-1111-4222-8333-944455556666"], "/x"),
      }),
      fixture("t6", { name: "logs" }),
    ]);
    const line = coreJSONString({ id: "1", result: { snapshot: CoreTUIWire.topology(p.topology) } });
    const decoded = decodeReply(line, decodeSessionSnapshotResult);
    expect(decoded).toEqual(p.topology);
    const agentsLine = coreJSONString({ id: "2", result: { agents: p.agents.map((agent) => CoreTUIWire.agent(agent)) } });
    const agents = decodeReply(agentsLine, decodeAgentListResult);
    expect(agents).toEqual(p.agents);
    expect(agents[0]?.agentSession).toBeDefined();
  });
});

// MARK: - Live, against the fake core

const fastOptions: CoreFollowerOptions = { heartbeatSilenceSeconds: 0.4, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };

function follower(core: FakeCore, options: CoreFollowerOptions = fastOptions): CoreFollower {
  const session = new CoreSession({ backoff: new CoreBackoff(0.01, 0.02), helloTimeoutSeconds: 2, makeLink: () => core.makeLink() });
  return new CoreFollower(session, options);
}

const subscribes = (core: FakeCore): number => core.calls.filter((call) => call.method === "events.subscribe").length;

describe("the follower, live against the fake core", () => {
  it("follows the snapshot and events; credits each chunk read and nothing more", async () => {
    const core = new FakeCore([fixture("t1", { status: FakeCore.status("idle"), foreground: FakeCore.foreground("claude", ["claude"], "/a") })]);
    core.setDocument("herdr-app", layoutDocument);
    const backend = follower(core);
    const first = await backend.snapshot();
    expect(first.topology.panes.map((pane) => pane.paneID)).toEqual(["hc:t1"]);
    expect(first.topology.workspaces[0]?.label).toBe("App");
    const link = core.liveLinks[0];
    expect(link).toBeDefined();
    const channel = link?.subscriptionChannels[0] as number;
    expect(channel).toBeGreaterThan(0);
    // No opening grant; the stream's 256 KiB start is its window.
    expect(link?.credits.get(channel)).toBeUndefined();

    core.setStatus("t1", FakeCore.status("blocked"));
    expect(await eventually(() => backend.projection?.agents[0]?.agentStatus === "blocked")).toBe(true);
    // Each chunk read is credited back, and nothing more.
    expect(await eventually(() => link?.credits.get(channel) !== undefined && link.credits.get(channel) === link.sentBytes.get(channel))).toBe(true);

    // A doc event: the document is read again.
    core.setDocumentAndNotify("herdr-app", FakeCore.layout([{ id: "s1", name: "Renamed", folder: "/a", tabs: [{ id: "tA", name: "Build", terminals: ["t1"] }] }]));
    expect(await eventually(() => backend.projection?.topology.workspaces[0]?.label === "Renamed")).toBe(true);
    backend.close();
  });

  it("a gap takes a fresh snapshot on the same connection, closing the old channel", async () => {
    const core = new FakeCore([fixture("t1")]);
    // No silence limit in reach: the fresh snapshot must come from a new subscription on the same connection.
    const backend = follower(core, { ...fastOptions, heartbeatSilenceSeconds: 30 });
    await backend.snapshot();
    const link = core.liveLinks[0];
    const before = subscribes(core);
    core.skipEvent();
    core.create(fixture("t2"));
    expect(await eventually(() => subscribes(core) === before + 1)).toBe(true);
    expect(await eventually(() => backend.projection?.topology.panes.length === 2)).toBe(true);
    // The old channel was closed by the viewer.
    expect(await eventually(() => (link?.viewerClosed.length ?? 0) > 0)).toBe(true);
    expect(link?.isClosed).toBe(false);
    expect(core.liveLinks.length).toBe(1);
    backend.close();
  });

  it("missed replaces everything and rereads the documents", async () => {
    const core = new FakeCore([fixture("t1")]);
    const backend = follower(core);
    await backend.snapshot();
    const reads = core.calls.filter((call) => call.method === "doc.get").length;
    core.setDocument("herdr-app", layoutDocument);
    core.skipEvent();
    core.missed();
    expect(await eventually(() => core.calls.filter((call) => call.method === "doc.get").length > reads)).toBe(true);
    expect(await eventually(() => backend.projection?.topology.workspaces[0]?.label === "App")).toBe(true);
    backend.close();
  });

  it("silence is a lost line and reconnects", async () => {
    const core = new FakeCore([fixture("t1")]);
    const backend = follower(core);
    const changes: CoreFollowerChange[] = [];
    backend.changes((change) => changes.push(change));
    await backend.snapshot();
    const firstLink = core.liveLinks[0];
    // Heartbeats keep it alive past the silence limit.
    for (let index = 0; index < 4; index += 1) {
      await pause(150);
      core.heartbeat();
    }
    expect(firstLink?.isClosed).toBe(false);
    // Then nothing: the line is lost and a new connection subscribes again.
    const lost = await eventually(() => changes.find((change) => change.kind === "lost"), 600);
    expect(lost?.kind === "lost" && lost.reason.includes("no event or heartbeat")).toBe(true);
    expect(firstLink?.isClosed).toBe(true);
    expect(await eventually(() => core.liveLinks.length === 1 && core.liveLinks[0] !== firstLink)).toBe(true);
    await backend.snapshot();
    backend.close();
  });

  it("a closed subscription channel resubscribes", async () => {
    const core = new FakeCore([fixture("t1")]);
    const backend = follower(core, { ...fastOptions, heartbeatSilenceSeconds: 30 });
    await backend.snapshot();
    core.liveLinks[0]?.closeSubscriptions();
    expect(await eventually(() => subscribes(core) === 2)).toBe(true);
    backend.close();
  });
});

describe("through HerdrClient", () => {
  it("HerdrClient reads a core as it reads Herdr", async () => {
    const core = new FakeCore([
      fixture("t1", { status: FakeCore.status("working"), foreground: FakeCore.foreground("claude", ["claude"], "/a") }),
      fixture("t2"),
    ]);
    const backend = follower(core);
    const bridge = new CoreBridgeTransport(backend);
    const client = new HerdrClient(bridge);
    const topology = await client.sessionTopology();
    expect(topology.panes.map((pane) => pane.paneID)).toEqual(["hc:t1", "hc:t2"]);
    const agents = await client.agentList();
    expect(agents.map((agent) => agent.paneID)).toEqual(["hc:t1"]);
    expect(agentStatusFromWire(agents[0]?.agentStatus)).toBe("working");

    // The live stream: started, then a refresh on each change; a needs-you status reaches the list.
    const seen: string[] = [];
    const subscription = coreChangeEvents(backend, {
      started: () => seen.push("started"),
      event: (kind) => seen.push(kind),
      ended: (reason) => seen.push(`ended ${reason}`),
    });
    expect(await eventually(() => seen.includes("started"))).toBe(true);
    core.setStatus("t1", FakeCore.status("blocked"));
    expect(await eventually(() => seen.includes("pane.updated"))).toBe(true);
    expect(seen[0]).toBe("started");
    const after = await client.agentList();
    expect(agentStatusFromWire(after[0]?.agentStatus)).toBe("blocked");
    subscription.close();

    // A method herdr-core has no counterpart for reads like an older Herdr's refusal.
    const line = await bridge.roundTrip('{"id":"9","method":"gram.list","params":{}}');
    let refusal: unknown;
    try {
      decodeReply(line, (value) => value);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(APIError);
    expect((refusal as APIError).code).toBe("invalid_request");
    expect((refusal as APIError).serverMessage).toContain("unknown variant `gram.list`");
    backend.close();
  });

  it("a missing core says why", async () => {
    const session = new CoreSession({
      backoff: new CoreBackoff(0.01, 0.02),
      helloTimeoutSeconds: 1,
      makeLink: () => {
        throw new CoreLinkError({ kind: "notInstalled" });
      },
    });
    const backend = new CoreFollower(session, fastOptions);
    const client = new HerdrClient(new CoreBridgeTransport(backend));
    let failure: unknown;
    try {
      await client.sessionTopology();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("herdr-core");
    backend.close();
  });
});
