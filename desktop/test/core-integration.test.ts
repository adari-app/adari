// The app's path against a fake herdr-core, end to end (ported from the
// iPhone app's CoreIntegrationTests.swift): connect, hello, snapshot, a
// space from Herdr App's document, attach, type, resize, credit, a status
// change to blocked (needs you, in the Mac's sidebar), finished, restarted
// and reattach, close. Then CoreHandoffRouteTests.swift:
// on a host with both kinds of Herdr, every write the box's send path makes
// to a herdr-core pane goes to herdr-core and never to the TUI server.

import { describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { CoreAttachSession, CoreTerminalError } from "../src/main/herdr/core-attach";
import { coreChangeEvents } from "../src/main/herdr/core-backend";
import { member } from "../src/main/herdr/core-json";
import { CoreIDs } from "../src/main/herdr/core-model";
import { buildDesktopSidebar } from "../src/shared/desktop-sidebar";
import { emptyFoldState } from "../src/shared/sidebar-model";
import { coreHost, noSocket, ownAgent } from "./support/core-hosts";
import { eventually } from "./support/core-test-link";
import { FakeCore } from "./support/fake-core";
import { nowUnixMs } from "./support/sidebar-fixture";
import { TUIFixtureTransport } from "./support/tui-fixture";

const attachOptions = { restartWaitSeconds: 3, settleWaitSeconds: 0.5, pollSeconds: 0.02 };

async function read(output: AsyncIterator<Uint8Array>, marker: string): Promise<string> {
  let seen = "";
  const deadline = Date.now() + 5_000;
  while (!seen.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`never saw ${JSON.stringify(marker)} in ${JSON.stringify(seen)}`);
    const next = await output.next();
    if (next.done === true) throw new Error(`ended before ${JSON.stringify(marker)}`);
    seen += new TextDecoder().decode(next.value);
  }
  return seen;
}

describe("integration: a Mac with Herdr App only, end to end (CoreIntegrationTests)", () => {
  it("connect, snapshot, attach, type, resize, credit, needs you, finished, restarted, close", async () => {
    const claude = FakeCore.foreground("claude", ["claude"], "/Users/me/code/app");
    const core = new FakeCore([
      FakeCore.terminal("t1", { labels: { "herdr.space": "s1", "herdr.tab": "tA" }, status: FakeCore.status("working"), foreground: claude, keep: true }),
      FakeCore.terminal("t2", { argv: ["make", "test"], labels: { "herdr.space": "s1", "herdr.tab": "tA" } }),
    ]);
    core.setDocument("herdr-app", FakeCore.layout([{ id: "s1", name: "App", folder: "/Users/me/code/app", tabs: [{ id: "tA", name: "Main", terminals: ["t1", "t2"] }] }]));
    const tui = new TUIFixtureTransport();
    // A Mac with Herdr App only.
    tui.failure = noSocket();
    const host = coreHost(tui, core);
    const client = new HerdrClient(host);

    // Connect, hello, snapshot: a space from the document.
    const topology = await client.sessionTopology();
    const link = core.liveLinks[0]!;
    expect(member(member(link.helloRequest, "params"), "framed")).toBe(true);
    expect(member(member(link.helloRequest, "params"), "generation")).toBe(1);
    expect(topology.workspaces.map((workspace) => workspace.label)).toEqual(["App"]);
    expect(topology.tabs.map((tab) => tab.label)).toEqual(["Main"]);
    expect(topology.panes.map((pane) => pane.paneID)).toEqual(["hc:t1", "hc:t2"]);

    // Attach (as the terminal opener does, by the pane's terminal id), type, resize.
    const address = CoreIDs.address(topology.panes[0]!.terminalID)!;
    const session = new CoreAttachSession(host.follower, address, 120, 40, attachOptions);
    const screen = session.output[Symbol.asyncIterator]();
    session.start();
    await read(screen, "$ ");
    expect(await eventually(() => session.readyForInput)).toBe(true);
    await session.sendAcknowledged(new TextEncoder().encode("fix the tests\r"));
    expect(await eventually(() => core.typedText("t1") === "fix the tests\r")).toBe(true);
    session.resize(90, 30);
    expect(await eventually(() => core.resizes.at(-1)?.cols === 90 && core.resizes.at(-1)?.rows === 30)).toBe(true);

    // Credit: more than the starting 256 KiB comes through.
    const channel = link.channelOf("t1")!;
    core.output("t1", new Uint8Array(400 * 1024).fill(0x2e));
    let got = 0;
    while (got < 400 * 1024) {
      const next = await screen.next();
      const taken = next.done === true ? 0 : next.value.length;
      // The screen feeds what it takes (that is what is credited).
      session.fed(taken);
      got += taken;
    }
    expect(await eventually(() => (link.credits.get(channel) ?? 0) >= 400 * 1024), "credited").toBe(true);

    // A status change to blocked: needs you, through the sidebar's events and the Mac's sidebar.
    const events: string[] = [];
    const subscription = coreChangeEvents(host.follower, { started: () => events.push("started"), event: (kind) => events.push(kind), ended: () => events.push("ended") });
    expect(await eventually(() => events.includes("started"))).toBe(true);
    core.setStatus("t1", FakeCore.status("blocked", "claude", "permission"));
    expect(await eventually(() => events.includes("pane.updated")), "the change refreshes the sidebar").toBe(true);
    subscription.close();
    expect((await client.agentList()).find((agent) => agent.paneID === "hc:t1")?.agentStatus).toBe("blocked");
    const sidebar = buildDesktopSidebar([{ id: "studio", name: "Studio", platform: "macOS", state: "connected", error: null, topology: await client.sessionTopology() }], {
      nowUnixMs,
      fold: emptyFoldState,
    });
    expect(sidebar.badge, "needs you").toBe(1);

    // Finished: t2's program ends; its screen ends for good; it keeps an ended row until closed.
    const make = new CoreAttachSession(host.follower, "t2", 80, 24, attachOptions);
    const makeScreen = make.output[Symbol.asyncIterator]();
    make.start();
    await read(makeScreen, "$ ");
    core.finish("t2", 0);
    let ended: unknown = null;
    try {
      while ((await makeScreen.next()).done !== true) {
        // drained
      }
    } catch (error) {
      ended = error;
    }
    expect((ended as CoreTerminalError).fault).toEqual({ kind: "finished", reason: "exited", exitCode: 0 });
    expect(await eventually(async () => (await client.sessionTopology()).panes.find((pane) => pane.paneID === "hc:t2")?.title === "Exited (0)"), "t2 shows how it ended").toBe(true);
    await client.closePane("hc:t2");
    expect(await eventually(async () => !(await client.sessionTopology()).panes.some((pane) => pane.paneID === "hc:t2")), "gone once closed").toBe(true);

    // Restarted: the kept t1 loses its program, gets a new shell, the same screen attaches again.
    core.lose("t1");
    core.paint.set("t1", new TextEncoder().encode("\u001b[2J\u001b[Hrestarted $ "));
    core.restart("t1");
    await read(screen, "restarted $ ");
    expect(await eventually(() => session.readyForInput), "ready after reattach").toBe(true);
    session.send(new TextEncoder().encode("y"));
    expect(await eventually(() => core.typedText("t1").endsWith("y")), "typed after reattach").toBe(true);

    // Close: the viewer detaches; the program runs on.
    session.close();
    expect((await screen.next()).done).toBe(true);
    expect(await eventually(() => link.viewerClosed.length >= 1), "CLOSE sent").toBe(true);
    expect(member(core.record("t1"), "state")).toBe("live");
    host.close();
    host.follower.close();
  });
});

describe("a hand-off to a herdr-core pane on a host with both (CoreHandoffRouteTests)", () => {
  const handoff = "From pairing-helper in aurora-web (Studio Mac):\nTotals match; ship it.";

  async function both() {
    const tui = new TUIFixtureTransport();
    const core = ownAgent(FakeCore.status("idle"));
    const host = coreHost(tui, core);
    const client = new HerdrClient(host);
    const topology = await client.sessionTopology();
    expect(topology.panes.some((pane) => pane.paneID === "hc:t1"), "the core terminal is on the host").toBe(true);
    expect(topology.panes.some((pane) => pane.paneID === "w7:p1"), "and the TUI server's panes").toBe(true);
    return { host, tui, core, client };
  }

  it("the hand-off's own write to a core Claude terminal: herdr-core types it, the TUI server sees nothing", async () => {
    const { host, tui, core, client } = await both();
    const before = tui.requests.length;
    await client.prompt("hc:t1", handoff);
    expect(tui.requests.length, `nothing for hc:t1 reaches the TUI server: ${tui.methods.slice(-2).join(", ")}`).toBe(before);
    expect(core.sent.map((entry) => entry.terminal)).toEqual(["t1"]);
    expect(core.sent[0]?.text).toBe(handoff);
    host.close();
    host.follower.close();
  });

  it("every other write of the box's send path to a core pane skips the TUI server; to a TUI pane it goes there", async () => {
    const { host, tui, client } = await both();
    const writes: [string, (pane: string) => Promise<unknown>][] = [
      ["pane.send_input", (pane) => client.sendInput(pane, "y", ["Enter"])],
      ["pane.send_text", (pane) => client.sendText(pane, "y")],
      ["pane.send_keys", (pane) => client.paneSendKeys(pane, ["Enter"])],
      ["agent.send_keys", (pane) => client.agentSendKeys(pane, ["Enter"])],
      ["agent.prompt", (pane) => client.prompt(pane, "y")],
    ];
    for (const [method, write] of writes) {
      const before = tui.requests.length;
      await write("hc:t1").catch(() => undefined);
      expect(tui.requests.length, `${method} to hc:t1 never reaches the TUI server`).toBe(before);
      await write("w7:p1").catch(() => undefined);
      expect(tui.methods.at(-1), `${method} to w7:p1 goes to the TUI server`).toBe(method);
    }
    host.close();
    host.follower.close();
  });
});
