// A saved machine is a HerdrMachineBackend: the Herdr
// TUI, herdr-core, or both, found as the iPhone app finds them, with no new
// setting. In the sidebar a herdr-core space carries the "App" tag ("Herdr
// App" to VoiceOver, as CompanionSidebar.swift has it); a TUI
// space does not.

import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import { CoreIDs } from "../src/main/herdr/core-model";
import { CoreBackoff } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import type { SessionTopology } from "../src/main/herdr/wire";
import { Sidebar, type SidebarProps } from "../src/renderer/components/Sidebar";
import { coreIDPrefix, isCoreID } from "../src/shared/core-ids";
import { buildDesktopSidebar, type SidebarHost } from "../src/shared/desktop-sidebar";
import { emptyFoldState } from "../src/shared/sidebar-model";
import { FakeSshHost } from "./support/core-host-ssh";
import { fastFollower } from "./support/core-hosts";
import { eventually } from "./support/core-test-link";
import { FakeCore } from "./support/fake-core";
import { LiveHerdr } from "./support/live-herdr";
import { nowUnixMs } from "./support/sidebar-fixture";

const backends: HerdrMachineBackend[] = [];
afterEach(() => {
  for (const backend of backends.splice(0)) backend.close();
});

function studioCore(): FakeCore {
  const core = new FakeCore([
    FakeCore.terminal("t1", { status: FakeCore.status("idle"), foreground: FakeCore.foreground("claude", ["claude"], "/Users/me/code/site") }),
    FakeCore.terminal("t2"),
  ]);
  core.setDocument("herdr-app", FakeCore.layout([{ id: "s1", name: "Website", folder: "/Users/me/code/site", tabs: [{ id: "tA", name: "Main", terminals: ["t1", "t2"] }] }]));
  return core;
}

function tuiHerdr(): LiveHerdr {
  const herdr = new LiveHerdr();
  herdr.addTab("w1:t1", ["w1:p1", "w1:p2"], { "w1:p1": "claude" });
  return herdr;
}

/** The machine's topology once both sides are in (the core arrives after the TUI's first answer). */
async function topologyOf(host: FakeSshHost, panes: number): Promise<SessionTopology> {
  const backend = new HerdrMachineBackend({ host: "both.invalid", port: 22, username: "me", privateKeyPath: "", herdrSession: "default" }, new PinningHostKeyPolicy(new MemoryPinStore()), {
    route: { connect: host.connect },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: fastFollower,
  });
  backends.push(backend);
  const topology = await eventually(async () => {
    const now = await backend.snapshot();
    return now.panes.length === panes ? now : null;
  }, 400);
  expect(topology).not.toBeNull();
  return topology!;
}

const none = (): void => undefined;
function markup(host: SidebarHost): string {
  const props: SidebarProps = {
    sidebar: buildDesktopSidebar([host], { nowUnixMs, fold: { ...emptyFoldState, mode: "projects" } }),
    selectedKey: null,
    search: null,
    demo: false,
    foldedHosts: new Set(),
    onSelect: none,
    onRowMenu: none,
    onToggleHost: none,
    onHostMenu: none,
    onRetryHost: none,
    onMode: none,
    onToggleWorkspace: none,
    onToggleExpanded: none,
    onToggleSection: none,
    onSearch: none,
    onAddHost: none,
    onNewAgent: none,
    onWorkspaceMenu: none,
  };
  return renderToStaticMarkup(createElement(Sidebar, props));
}

/** Each workspace header's id and the markup of its header button. */
function headers(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of html.matchAll(/<div class="ws-hw" data-ws="([^"]+)">(.*?)<\/button>/g)) out.set(match[1]!, match[2]!);
  return out;
}

describe("a herdr-core space in the Mac's sidebar", () => {
  it("the page's core id test is CoreIDs'", () => {
    expect(coreIDPrefix).toBe(CoreIDs.prefix);
    expect(isCoreID(CoreIDs.space("s1"))).toBe(true);
    expect(isCoreID(CoreIDs.pane("studio/t7"))).toBe(true);
    expect(isCoreID("w1")).toBe(false);
  });

  it("a host running both shows both in one entry; the core space carries the App tag, the TUI space none", async () => {
    const topology = await topologyOf(new FakeSshHost(tuiHerdr(), studioCore()), 4);
    const html = markup({ id: "both", name: "Studio", platform: "macOS", state: "connected", error: null, topology });
    const byId = headers(html);
    expect([...byId.keys()]).toEqual(["w1", "hc:space:s1"]);
    const core = byId.get("hc:space:s1")!;
    expect(core).toContain('<span class="n">Website</span>');
    expect(core).toContain('<span class="app" title="Herdr App"><span aria-hidden="true">App</span><span class="vh">Herdr App</span></span>');
    expect(byId.get("w1")).not.toContain('class="app"');
  });

  it("a core-only host's spaces carry the tag; a TUI-only host's markup is as it was", async () => {
    const core = await topologyOf(new FakeSshHost(null, studioCore()), 2);
    expect(markup({ id: "studio", name: "Studio", platform: "macOS", state: "connected", error: null, topology: core })).toContain('class="app"');
    const tui = await topologyOf(new FakeSshHost(tuiHerdr(), null), 2);
    expect(markup({ id: "mini", name: "Mac mini", platform: "macOS", state: "connected", error: null, topology: tui })).not.toContain('class="app"');
  });

  it("the tag's style: ink-3, a size under the row's; its VoiceOver words hidden from sight", () => {
    const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
    expect(css).toContain(".ws-h .app { color: var(--ink-3); font-size: var(--fs-s);");
    expect(css).toMatch(/\.ws-h \.app \.vh \{ position: absolute; width: 1px; height: 1px; overflow: hidden;/);
  });

  it("main.ts makes every saved SSH machine a HerdrMachineBackend (This Mac and Demo unchanged)", () => {
    const main = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
    expect(main).toContain("return new HerdrMachineBackend(book.connectConfig(host, latch), policy);");
    expect(main).not.toContain("new HerdrTuiBackend(");
    const thisMac = readFileSync(new URL("../src/main/this-mac.ts", import.meta.url), "utf8");
    expect(thisMac).toContain("export class ThisMacBackend extends HerdrTuiBackend");
  });
});
