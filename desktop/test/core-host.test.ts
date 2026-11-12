// The backend: one host, both kinds of Herdr, one sidebar. Ported
// from the iPhone app's CoreHostTests.swift at the transport level
// (CoreHostTransport over a TUI fixture and the fake core). The TUI event
// stream half of "a core found late" lives in core-machine.test.ts, where the
// desktop's sidebar events are; "TUI panes keep their input channel" is
// iOS-only (the Mac has no Citadel pane-input channel).

import { describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { CoreBridgeTransport } from "../src/main/herdr/core-bridge";
import { CoreFollower, type CoreFollowerChange, type CoreFollowerOptions } from "../src/main/herdr/core-follower";
import { CoreHostTransport, type CoreHostOptions } from "../src/main/herdr/core-host-transport";
import { CoreIDs } from "../src/main/herdr/core-model";
import { CoreBackoff, CoreSession } from "../src/main/herdr/core-session";
import { CoreLinkError } from "../src/main/herdr/core-ssh";
import type { CoreLink } from "../src/main/herdr/core-connection";
import { ConnectFailedError, RemoteSocketFailedError } from "../src/main/herdr/errors";
import { HostKeyRejectedError } from "../src/main/herdr/host-key-pinning";
import { socketMissingDetail } from "../src/main/herdr/transport";
import { buildSidebarModel, emptyFoldState, sidebarInputFromTopology, agentStatusFromWire } from "../src/shared/sidebar-model";
import { eventually } from "./support/core-test-link";
import { FakeCore } from "./support/fake-core";
import { nowUnixMs, topology as tuiTopology } from "./support/sidebar-fixture";
import { TUIFixtureTransport } from "./support/tui-fixture";

const fastOptions: CoreFollowerOptions = { heartbeatSilenceSeconds: 0.4, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };
const noSocket = (): RemoteSocketFailedError => new RemoteSocketFailedError(".config/herdr/herdr.sock", socketMissingDetail);

function host(tui: TUIFixtureTransport, core: FakeCore | null, options: CoreHostOptions = { coreGraceSeconds: 2 }, makeLink?: () => Promise<CoreLink>): CoreHostTransport {
  const session = new CoreSession({
    backoff: new CoreBackoff(0.01, 0.02),
    helloTimeoutSeconds: 2,
    makeLink:
      makeLink ??
      (() => {
        if (core === null) throw new CoreLinkError({ kind: "notInstalled" });
        return core.makeLink();
      }),
  });
  return new CoreHostTransport(tui, new CoreBridgeTransport(new CoreFollower(session, fastOptions)), options);
}

function appCore(): FakeCore {
  const core = new FakeCore([
    FakeCore.terminal("t1", { status: FakeCore.status("blocked"), foreground: FakeCore.foreground("claude", ["claude"], "/Users/me/code/app") }),
    FakeCore.terminal("t2"),
  ]);
  core.setDocument("herdr-app", FakeCore.layout([{ id: "s1", name: "App", folder: "/Users/me/code/app", tabs: [{ id: "tA", name: "Main", terminals: ["t1", "t2"] }] }]));
  return core;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("one host, both kinds of Herdr, one sidebar", () => {
  it("a host with both shows both sets, with distinct ids; requests go where their ids say", async () => {
    const tui = new TUIFixtureTransport();
    const transport = host(tui, appCore());
    const client = new HerdrClient(transport);

    const topology = await client.sessionTopology();
    const tuiOnly = tuiTopology();
    expect(topology.workspaces.slice(0, tuiOnly.workspaces.length), "the TUI server's workspaces come first, exactly as today").toEqual(tuiOnly.workspaces);
    expect(topology.workspaces.slice(tuiOnly.workspaces.length).map((w) => w.workspaceID)).toEqual(["hc:space:s1"]);
    expect(Number(topology.workspaces.at(-1)?.number), "numbered after the TUI server's 11").toBe(12);
    expect(topology.panes.length).toBe(tuiOnly.panes.length + 2);
    expect(new Set(topology.panes.map((pane) => pane.paneID)).size, "no id collides").toBe(topology.panes.length);
    expect(new Set(topology.panes.map((pane) => pane.terminalID)).size).toBe(topology.panes.length);
    expect(topology.panes.filter((pane) => CoreIDs.isCore(pane.paneID)).map((pane) => pane.paneID)).toEqual(["hc:t1", "hc:t2"]);
    expect(topology.version).toBe("0.9.5");
    expect(transport.sources()).toEqual({ tui: { kind: "present" }, core: { kind: "present" } });

    const agents = await client.agentList();
    expect(agents.map((agent) => agent.paneID)).toEqual(["w7:p1", "hc:t1"]);
    expect(agentStatusFromWire(agents.at(-1)?.agentStatus)).toBe("blocked");

    // The sidebar the app builds has both, needs-you included.
    const sidebar = buildSidebarModel(
      sidebarInputFromTopology(topology, { macID: "studio", needsYouSummaries: {}, seenDonePaneIDs: new Set(), fold: emptyFoldState, search: "", nowUnixMs, shellKind: "shell" }),
    );
    expect(sidebar.projects.some((project) => project.header.workspaceID === "hc:space:s1")).toBe(true);
    expect(sidebar.projects.some((project) => project.header.workspaceID === "w7")).toBe(true);
    expect(sidebar.priorityBadge, "the core's blocked agent needs you").toBe(1);

    // Requests go where their ids say.
    const before = tui.requests.length;
    await client.closePane("hc:t2").catch(() => undefined);
    expect(tui.requests.length, "a core pane's request never reaches the TUI server").toBe(before);
    await client.closePane("w8:p1").catch(() => undefined);
    expect(tui.methods.at(-1)).toBe("pane.close");
    transport.close();
    transport.follower.close();
  });

  it("a core-only host is shown fully; a request without ids goes to the core", async () => {
    const tui = new TUIFixtureTransport();
    tui.failure = noSocket();
    const transport = host(tui, appCore());
    const client = new HerdrClient(transport);
    const topology = await client.sessionTopology();
    expect(topology.workspaces.map((w) => w.workspaceID)).toEqual(["hc:space:s1"]);
    expect(Number(topology.workspaces[0]?.number)).toBe(1);
    const sources = transport.sources();
    expect(sources.core).toEqual({ kind: "present" });
    expect(sources.tui.kind).toBe("absent");
    expect(transport.routesToCoreOnly()).toBe(true);
    const asked = tui.requests.length;
    const pong = await transport.roundTrip('{"id":"p","method":"ping","params":{}}');
    expect(pong).toContain('"core":true');
    expect(tui.requests.length).toBe(asked);
    transport.follower.close();
  });

  it("a TUI-only host reads its TUI alone, and a later refresh never waits on a core that is not there", async () => {
    const tui = new TUIFixtureTransport();
    const transport = host(tui, null);
    const line = '{"id":"herdrkit:session.snapshot:1","method":"session.snapshot","params":{}}';
    const direct = await tui.roundTrip(line);
    const through = await transport.roundTrip(line);
    expect(through, "byte for byte").toBe(direct);
    expect(transport.sources().tui).toEqual({ kind: "present" });
    const started = Date.now();
    await transport.roundTrip(line);
    expect(Date.now() - started).toBeLessThan(500);
    expect(transport.sources().core.kind).toBe("absent");
    expect(transport.routesToCoreOnly()).toBe(false);
    transport.follower.close();
  });

  it("a failed host fails as today", async () => {
    for (const error of [new HostKeyRejectedError("studio", 22, "aa", "SHA256:x"), new ConnectFailedError("studio", "timed out")]) {
      const tui = new TUIFixtureTransport();
      tui.failure = error;
      const transport = host(tui, appCore());
      expect(await failure(new HerdrClient(transport).sessionTopology())).toBe(error);
      transport.follower.close();
    }
  });

  it("no Herdr at all keeps the TUI server's error", async () => {
    const tui = new TUIFixtureTransport();
    const missing = noSocket();
    tui.failure = missing;
    const transport = host(tui, null);
    expect(await failure(new HerdrClient(transport).sessionTopology())).toBe(missing);
    transport.follower.close();
  });

  it("a core found late arrives as a change; the TUI server's first sidebar does not wait (desktop grace 0)", async () => {
    const tui = new TUIFixtureTransport();
    const core = appCore();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const transport = host(tui, core, { coreGraceSeconds: 0 }, async () => {
      await gate;
      return core.makeLink();
    });
    const changes: CoreFollowerChange[] = [];
    transport.follower.changes((change) => changes.push(change));
    const client = new HerdrClient(transport);
    const started = Date.now();
    const first = await client.sessionTopology();
    expect(Date.now() - started).toBeLessThan(500);
    expect(first.panes.some((pane) => CoreIDs.isCore(pane.paneID)), "the TUI server's sidebar does not wait").toBe(false);
    open();
    expect(await eventually(() => changes.some((change) => change.kind === "changed"))).toBe(true);
    const second = await client.sessionTopology();
    expect(second.panes.some((pane) => pane.paneID === "hc:t1")).toBe(true);
    transport.follower.close();
  });

  it("a lost core line shows its panes unreachable, the last status kept", async () => {
    const tui = new TUIFixtureTransport();
    const core = appCore();
    const transport = host(tui, core);
    const client = new HerdrClient(transport);
    await client.sessionTopology();
    const changes: CoreFollowerChange[] = [];
    transport.follower.changes((change) => changes.push(change));
    core.overrides.set("events.subscribe", () => FakeCore.rpcError("stopping", "unavailable"));
    core.dropConnections();
    expect(await eventually(() => changes.some((change) => change.kind === "lost"))).toBe(true);
    const agents = await client.agentList();
    const blocked = agents.find((agent) => agent.paneID === "hc:t1");
    expect(blocked?.reachability).toBe("unreachable");
    expect(blocked?.agentStatus).toBe("unknown");
    expect(blocked?.lastKnownStatus).toBe("blocked");
    transport.follower.close();
  });

  it("the connection epoch is new when either side's connection changes", async () => {
    const tui = new TUIFixtureTransport();
    const core = appCore();
    const transport = host(tui, core);
    await new HerdrClient(transport).sessionTopology();
    const first = transport.connectionEpoch();
    expect(first).not.toBeNull();
    expect(transport.connectionEpoch()).toBe(first);
    tui.epoch = 2;
    const second = transport.connectionEpoch();
    expect(second).not.toBe(first);
    core.dropConnections();
    expect(await eventually(() => transport.follower.epoch !== null && transport.connectionEpoch() !== second)).toBe(true);
    transport.follower.close();
  });
});
