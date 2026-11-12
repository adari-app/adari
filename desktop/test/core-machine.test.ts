// A saved machine running herdr-core, the Herdr TUI, or
// both, as the desktop shows it: HerdrMachineBackend over the host's SSH
// (an in-process fake ssh2 client per connection: Herdr requests answered by a
// LiveHerdr, `hc connect` bridged to the fake core), in the HostRegistry, in
// the desktop sidebar. Host close leaves no SSH client.

import { afterEach, describe, expect, it } from "vitest";

import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import type { CoreFollowerOptions } from "../src/main/herdr/core-follower";
import { CoreBackoff } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { HostRegistry } from "../src/main/hosts";
import type { HostView } from "../src/shared/ipc-contract";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import { eventually } from "./support/core-test-link";
import { FakeSshHost } from "./support/core-host-ssh";
import { FakeCore } from "./support/fake-core";
import { LiveHerdr } from "./support/live-herdr";
import { nowUnixMs } from "./support/sidebar-fixture";

const fastFollower: CoreFollowerOptions = { heartbeatSilenceSeconds: 30, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };
const config = (host: string) => ({ host, port: 22, username: "me", privateKeyPath: "", herdrSession: "default" });

function appCore(): FakeCore {
  const core = new FakeCore([
    FakeCore.terminal("t1", { status: FakeCore.status("blocked"), foreground: FakeCore.foreground("claude", ["claude"], "/Users/me/code/app") }),
    FakeCore.terminal("t2"),
  ]);
  core.setDocument("herdr-app", FakeCore.layout([{ id: "s1", name: "App", folder: "/Users/me/code/app", tabs: [{ id: "tA", name: "Main", terminals: ["t1", "t2"] }] }]));
  return core;
}

function tuiHerdr(): LiveHerdr {
  const herdr = new LiveHerdr();
  herdr.addTab("w1:t1", ["w1:p1", "w1:p2"], { "w1:p1": "claude" });
  return herdr;
}

const backends: HerdrMachineBackend[] = [];
const registries: HostRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const backend of backends.splice(0)) backend.close();
});

function machine(host: FakeSshHost, name: string): HerdrMachineBackend {
  const backend = new HerdrMachineBackend(config(name), new PinningHostKeyPolicy(new MemoryPinStore()), {
    route: { connect: host.connect },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: fastFollower,
  });
  backends.push(backend);
  return backend;
}

function registry(): { registry: HostRegistry; views: () => HostView[] } {
  let latest: HostView[] = [];
  const made = new HostRegistry((hosts) => {
    latest = hosts;
  });
  registries.push(made);
  return { registry: made, views: () => latest };
}

const descriptor = (id: string) => ({ id, name: id, kind: "ssh" as const, address: `me@${id}:22`, platform: "macOS" });

describe("a herdr-core machine in the desktop sidebar", () => {
  it("a core host sits next to a TUI host, and a host with both shows both in one entry", async () => {
    const mini = new FakeSshHost(tuiHerdr(), null);
    const studio = new FakeSshHost(null, appCore());
    const both = new FakeSshHost(tuiHerdr(), appCore());
    const { registry: hosts } = registry();
    hosts.add(descriptor("mini"), machine(mini, "mini"));
    hosts.add(descriptor("studio"), machine(studio, "studio"));
    hosts.add(descriptor("both"), machine(both, "both"));
    // The first look of a host with both does not wait for its core (desktop grace 0): ask until it is in.
    const ready = await eventually(async () => {
      const views = await hosts.refreshAll();
      const byId = new Map(views.map((view) => [view.id, view]));
      const panes = (id: string) => byId.get(id)?.topology?.panes.map((pane) => pane.paneID) ?? [];
      return panes("mini").length === 2 && panes("studio").length === 2 && panes("both").length === 4 ? views : null;
    }, 400);
    expect(ready).not.toBeNull();
    const views = ready as HostView[];
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get("mini")?.topology?.workspaces.map((w) => w.workspaceID)).toEqual(["w1"]);
    expect(byId.get("studio")?.topology?.workspaces.map((w) => w.workspaceID)).toEqual(["hc:space:s1"]);
    expect(byId.get("studio")?.topology?.workspaces.map((w) => w.label)).toEqual(["App"]);
    expect(byId.get("both")?.topology?.workspaces.map((w) => [w.workspaceID, Number(w.number)])).toEqual([
      ["w1", 1],
      ["hc:space:s1", 2],
    ]);
    for (const view of views) expect(view.state).toBe("connected");

    // The sidebar has all three machines; the core's blocked Claude needs you on each machine that has it.
    const sidebar = buildDesktopSidebar(views, { nowUnixMs });
    expect(sidebar.hosts.map((section) => section.host.id)).toEqual(["mini", "studio", "both"]);
    const projects = (id: string) => sidebar.hosts.find((section) => section.host.id === id)?.model?.projects.map((project) => project.header.workspaceID);
    expect(projects("mini")).toEqual(["w1"]);
    expect(projects("studio")).toEqual(["hc:space:s1"]);
    expect(projects("both")).toEqual(["w1", "hc:space:s1"]);
    const badge = (id: string) => sidebar.hosts.find((section) => section.host.id === id)?.model?.priorityBadge;
    expect(badge("studio")).toBe(1);
    expect(badge("both")).toBe(1);
    expect(badge("mini")).toBe(0);

    // A TUI-only machine never ran anything but Herdr requests and one `hc connect` lookup; requests for its own
    // panes never touch a core.
    expect(mini.coreClients.length).toBeGreaterThanOrEqual(1);
    expect(mini.core).toBeNull();
  });

  it("a core-only host's sidebar events come from its core: a change refreshes without the timer", async () => {
    const core = appCore();
    const studio = new FakeSshHost(null, core);
    const { registry: hosts } = registry();
    const backend = machine(studio, "studio");
    hosts.add(descriptor("studio"), backend);
    expect(await eventually(() => (hosts.topology("studio")?.panes.length ?? 0) === 2 && backend.routesToCoreOnly(), 400)).toBe(true);
    // A refresh after the core-only route is known starts the core's event stream.
    await hosts.refresh("studio");
    expect(await eventually(() => hosts.eventsLive("studio"), 400)).toBe(true);
    core.create(FakeCore.terminal("t3", { labels: { "herdr.space": "s1", "herdr.tab": "tA" } }));
    expect(await eventually(() => hosts.topology("studio")?.panes.some((pane) => pane.paneID === "hc:t3"), 400)).toBe(true);
  });

  it("host close leaves no SSH client: the TUI's, the core's hc connect and the reads relay's all end", async () => {
    const core = appCore();
    const both = new FakeSshHost(tuiHerdr(), core);
    const backend = machine(both, "both");
    expect(await eventually(async () => ((await backend.snapshot()).panes.length === 4 ? true : null), 400)).toBe(true);
    expect(both.coreClients.length).toBe(1);
    expect(core.liveLinks.length).toBe(1);
    expect(both.openClients.length).toBeGreaterThanOrEqual(2);
    backend.close();
    expect(both.coreClients.every((client) => client.ended), "the hc connect client ends at once").toBe(true);
    // The TUI's command connection ends as it always has (on its pending client's next turn).
    expect(await eventually(() => both.openClients.length === 0), "every SSH client made is ended").toBe(true);
    expect(await eventually(() => core.liveLinks.length === 0)).toBe(true);
    // Nothing reconnects after close.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(both.openClients.length).toBe(0);
    expect(both.coreClients.length).toBe(1);
  });

  it("host close while hc connect is still being answered ends that SSH client too", async () => {
    const core = appCore();
    const studio = new FakeSshHost(null, core);
    studio.holdCore = true;
    const backend = machine(studio, "studio");
    void backend.snapshot().catch(() => undefined);
    expect(await eventually(() => studio.coreClients.length === 1 && studio.coreClients[0]?.channels.length === 1)).toBe(true);
    expect(studio.coreClients[0]?.ended).toBe(false);
    backend.close();
    expect(studio.coreClients[0]?.ended, "the attempt's client ends at once").toBe(true);
    expect(await eventually(() => studio.openClients.length === 0)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(studio.openClients.length).toBe(0);
    expect(studio.coreClients.length, "no new attempt after close").toBe(1);
  });

  it("the registry's remove closes the machine and its SSH clients", async () => {
    const both = new FakeSshHost(tuiHerdr(), appCore());
    const { registry: hosts } = registry();
    hosts.add(descriptor("both"), machine(both, "both"));
    expect(await eventually(() => both.coreClients.length === 1 && (hosts.topology("both")?.panes.length ?? 0) >= 2, 400)).toBe(true);
    hosts.remove("both");
    expect(both.coreClients.every((client) => client.ended)).toBe(true);
    expect(await eventually(() => both.openClients.length === 0)).toBe(true);
  });
});
