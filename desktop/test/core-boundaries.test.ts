// The core link's boundaries: what an agent-bound send reaches, page credit and backlog, attach cancellation,
// the layout guard on core pane actions, a merged host losing its core, framing errors and reconnect waits.
// All links are fakes: no SSH, no herdr-core, no socket.

import type { WebContents } from "electron";
import { afterEach, describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { CoreActionText } from "../src/main/herdr/core-actions";
import { coreTerminalText } from "../src/main/herdr/core-backend";
import { coreFrameMaximumPayload, writeLE32 } from "../src/main/herdr/core-frames";
import type { CoreJSON } from "../src/main/herdr/core-json";
import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import { CoreBackoff, CoreSession } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { sendBound } from "../src/main/herdr/send";
import { HostRegistry } from "../src/main/hosts";
import { runPaneAction } from "../src/main/pane-actions";
import { TerminalSessions } from "../src/main/terminals";
import { RemoteTerminalPort } from "../src/renderer/terminal/remote-port";
import type { HerdrDesktopBridge, TerminalDataEvent } from "../src/shared/ipc-contract";
import { bindingTexts, rowBindingOf } from "../src/shared/pane-binding";
import { actingBridge, coreFollower, ownAgent } from "./support/core-hosts";
import { FakeSshHost } from "./support/core-host-ssh";
import { CoreFixtures, CoreTestLink, eventually, pause } from "./support/core-test-link";
import { FakeCore } from "./support/fake-core";
import { LiveHerdr } from "./support/live-herdr";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

const followerOptions = { heartbeatSilenceSeconds: 60, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };
const config = { host: "fixture.invalid", port: 22, username: "fixture", privateKeyPath: "", herdrSession: "default" };
const policy = (): PinningHostKeyPolicy => new PinningHostKeyPolicy(new MemoryPinStore());
const sends = (core: FakeCore): CoreJSON[] => core.calls.filter((call) => call.method === "terminal.send").map((call) => call.params);

async function bridge(core: FakeCore) {
  const follower = coreFollower(core, followerOptions);
  cleanups.push(() => follower.close());
  await follower.snapshot();
  return { follower, client: new HerdrClient(actingBridge(follower)) };
}

function machine(core: FakeCore, tui: LiveHerdr | null = null, attach?: { firstPaintSeconds: number }) {
  const remote = new FakeSshHost(tui, core);
  const backend = new HerdrMachineBackend(config, policy(), {
    route: { connect: remote.connect },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: followerOptions,
    ...(attach === undefined ? {} : { attach }),
  });
  cleanups.push(() => backend.close());
  return { remote, backend };
}

async function listed(core: FakeCore) {
  const { backend, remote } = machine(core);
  const hosts = new HostRegistry(() => undefined);
  cleanups.push(() => hosts.close());
  hosts.add({ id: "fixture", name: "Fixture", kind: "ssh", address: "fixture@fixture.invalid:22", platform: "macOS" }, backend);
  expect(await eventually(() => hosts.pane("fixture", "hc:t1") !== null)).toBe(true);
  return { backend, remote, hosts };
}

/** A replacement made at the send boundary: the checked agent's kept terminal now runs another agent, idle too. */
function replaceAtSend(core: FakeCore, argv: string[]): { replaced: () => boolean } {
  let replaced = false;
  core.overrides.set("terminal.send", (params) => {
    core.overrides.delete("terminal.send");
    core.event(
      "restarted",
      "t1",
      FakeCore.terminal("t1", { argv, pid: 6262, keep: true, foreground: FakeCore.foreground("claude", argv, "/fixture", 6262), status: FakeCore.status("idle") }),
    );
    replaced = true;
    return core.answer("terminal.send", params, core.liveLinks[0]!);
  });
  return { replaced: () => replaced };
}

describe("an agent-bound send reaches only the run the gate checked", () => {
  for (const operation of ["prompt", "Return"] as const) {
    // As in the iPhone app, a kept terminal's own-program agent is not refused: its prompt and Return go under its
    // status word (`if`). The known limit that comes with it: a same-word replacement made at the core's send
    // boundary (the fake does it in one turn; herdr-core recovers a kept terminal only after a signal death and its
    // delay) still takes the text. Status-gated, not an atomic run guarantee: an expected-run condition upstream
    // would close it.
    it(`a kept agent's ${operation} goes under its status; a same-word replacement at the send boundary still takes it`, async () => {
      const core = ownAgent(FakeCore.status("idle"), true);
      const { client } = await bridge(core);
      const replacement = replaceAtSend(core, ["claude", "--session-id", "new-session"]);
      const text = operation === "prompt" ? "only for the old agent" : "";
      await (operation === "prompt" ? client.prompt("hc:t1", text) : client.agentSendKeys("hc:t1", ["Enter"]));
      // One request, recorded twice: by replaceAtSend's override and by the answer it hands on to (FakeCore.answer).
      expect(sends(core).map((params) => (params as Record<string, CoreJSON>)["if"]), "one terminal.send, held to the word").toEqual(["idle", "idle"]);
      expect(replacement.replaced(), "the send reached the core").toBe(true);
      expect(core.sent, "the known limit: the core typed it, whichever run says idle").toEqual([{ terminal: "t1", text }]);
      expect(core.keys).toEqual([]);
    });
  }

  // As above, the bound Send goes under the status word; a same-word replacement still takes it.
  it("the normal bound Send to a kept agent goes under its status (a same-word replacement still takes it)", async () => {
    const core = ownAgent(FakeCore.status("idle"), true);
    const { backend, hosts } = await listed(core);
    const expected = { terminalID: "hc:t1", isAgent: true, kind: "claude", session: null, run: hosts.run("fixture", "hc:t1")! };
    const replacement = replaceAtSend(core, ["claude"]);
    const site = {
      writer: backend,
      fresh: () => hosts.fresh("fixture"),
      pane: () => hosts.pane("fixture", "hc:t1"),
      agent: () => hosts.agent("fixture", "hc:t1"),
      run: () => hosts.run("fixture", "hc:t1"),
    };
    const note = await sendBound(site, "hc:t1", "old run only", expected).then(
      () => "sent",
      (error: Error) => error.message,
    );
    expect(note).toBe("sent");
    expect(replacement.replaced()).toBe(true);
    expect(core.sent).toEqual([{ terminal: "t1", text: "old run only" }]);
    // One request, recorded by the override and by the answer it hands on to.
    expect(sends(core).map((params) => (params as Record<string, CoreJSON>)["if"])).toEqual(["idle", "idle"]);
  });

  it("an agent that is its terminal's own program, not kept, still takes a prompt and Return under its status", async () => {
    const core = ownAgent(FakeCore.status("idle"), false);
    const { client } = await bridge(core);
    await client.prompt("hc:t1", "run the tests");
    await client.agentSendKeys("hc:t1", ["Enter"]);
    expect(core.sent.map((entry) => entry.text)).toEqual(["run the tests", ""]);
    expect(sends(core).map((params) => (params as Record<string, CoreJSON>)["if"])).toEqual(["idle", "idle"]);
  });

  it("the stop key still reaches a kept terminal's agent (Esc carries no message)", async () => {
    const core = ownAgent(FakeCore.status("working"), true);
    const { client } = await bridge(core);
    await client.agentSendKeys("hc:t1", ["Escape"]);
    expect(core.calls.some((call) => call.method === "terminal.interrupt")).toBe(true);
    expect(core.sent).toEqual([]);
  });
});

describe("credit for what the page parsed only, with a bounded backlog", () => {
  it("a page that parses no output holds credit and has a bounded backlog", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { backend } = machine(core);
    const topology = await backend.core.snapshot();
    const unparsed: Uint8Array[] = [];
    const handle = await backend.openTerminal(topology.panes[0]!, { cols: 80, rows: 24 }, { data: (bytes) => unparsed.push(bytes), exit: () => undefined });
    cleanups.push(() => handle.close());
    const link = core.liveLinks[0]!;
    const channel = link.channelOf("t1")!;
    // Delivered in turns so a compliant core sees every CREDIT rather than hitting its own 4 MiB repaint cap.
    for (let n = 0; n < 256; n++) {
      core.output("t1", new Uint8Array(32 * 1024).fill(120));
      await pause(0);
    }
    const held = unparsed.reduce((sum, bytes) => sum + bytes.length, 0);
    expect(held, "8 MiB may not be handed to a page that has parsed zero bytes").toBeLessThanOrEqual(256 * 1024);
    expect(link.credits.get(channel) ?? 0).toBe(0);
  });

  it("a page that parses what it is given gets all of it, credited exactly, with no repaint", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { backend } = machine(core);
    const topology = await backend.core.snapshot();
    const given: Uint8Array[] = [];
    const handle = await backend.openTerminal(topology.panes[0]!, { cols: 80, rows: 24 }, { data: (bytes) => given.push(bytes), exit: () => undefined });
    cleanups.push(() => handle.close());
    const link = core.liveLinks[0]!;
    const channel = link.channelOf("t1")!;
    let parsed = 0;
    const parse = (): void => {
      for (const bytes of given.splice(0)) {
        parsed += bytes.length;
        handle.parsed?.(bytes.length);
      }
    };
    parse();
    for (let n = 0; n < 64; n++) {
      core.output("t1", new Uint8Array(32 * 1024).fill(121));
      await pause(0);
      parse();
    }
    const settled = await eventually(() => {
      parse();
      return link.queued(channel) === 0 && link.sentBytes.get(channel) === parsed;
    });
    expect(settled, "everything the core had came through").toBe(true);
    expect(await eventually(() => link.credits.get(channel) === parsed), "credited exactly what was parsed").toBe(true);
    expect(link.repaints.get(channel) ?? 0).toBe(0);
    expect(parsed).toBeGreaterThan(2 << 20);
  });

  it("the page's port tells main what its view parsed, gathered per turn, only for its open session", async () => {
    const told: [string, number][] = [];
    const data = new Set<(event: TerminalDataEvent) => void>();
    let reply: (value: { sessionId: string }) => void = () => undefined;
    const fake = {
      openTerminal: () => new Promise<{ sessionId: string }>((resolve) => (reply = resolve)),
      terminalInput: () => undefined,
      terminalResize: () => undefined,
      closeTerminal: () => undefined,
      terminalParsed: (sessionId: string, bytes: number) => told.push([sessionId, bytes]),
      onTerminalData: (listener: (event: TerminalDataEvent) => void) => {
        data.add(listener);
        return () => data.delete(listener);
      },
      onTerminalExit: () => () => undefined,
    } as unknown as HerdrDesktopBridge;
    const port = new RemoteTerminalPort(
      fake,
      "fixture",
      "hc:t1",
      () => undefined,
      () => undefined,
    );
    const unsubscribe = port.subscribe((bytes) => port.parsed(bytes.length));
    port.parsed(5);
    port.resize(80, 24);
    for (const listener of data) listener({ sessionId: "s1", data: new Uint8Array(10) });
    reply({ sessionId: "s1" });
    await pause(0);
    expect(told, "the early bytes, parsed once the session is known; nothing before").toEqual([["s1", 10]]);
    for (const listener of data) {
      listener({ sessionId: "s1", data: new Uint8Array(3) });
      listener({ sessionId: "s1", data: new Uint8Array(4) });
    }
    await pause(0);
    expect(told.at(-1), "gathered into one").toEqual(["s1", 7]);
    unsubscribe();
    for (const listener of data) listener({ sessionId: "s1", data: new Uint8Array(6) });
    await pause(0);
    expect(told.at(-1), "no view: dropped, so not held against the stream").toEqual(["s1", 6]);
    port.dispose();
    port.parsed(9);
    await pause(0);
    expect(told.length).toBe(3);
  });
});

describe("an opening attach is cancelled by the page and bounded in time", () => {
  it("closing a window before first paint releases its attach immediately", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    core.paint.set("t1", new Uint8Array());
    const { hosts, backend } = await listed(core);
    const owner = { isDestroyed: () => false, send: () => undefined } as unknown as WebContents;
    const sessions = new TerminalSessions(hosts);
    const opening = sessions.open(owner, { hostId: "fixture", paneId: "hc:t1", cols: 80, rows: 24 }).catch((error: Error) => error.message);
    expect(await eventually(() => core.liveLinks[0]?.channelOf("t1") !== undefined)).toBe(true);
    const link = core.liveLinks[0]!;
    const channel = link.channelOf("t1")!;
    sessions.closeAll(owner);
    await pause(50);
    const detached = link.viewerClosed.includes(channel) || link.isClosed;
    expect(await opening, "the open call ends too").toBe(coreTerminalText.closedWhileOpening);
    backend.close();
    expect(detached, "closing the page must cancel an opening attach too").toBe(true);
  });

  it("a first paint that never comes ends the opening after its deadline and closes the attach", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    core.paint.set("t1", new Uint8Array());
    const { backend } = machine(core, null, { firstPaintSeconds: 0.2 });
    const topology = await backend.core.snapshot();
    const exits: (string | null)[] = [];
    const started = Date.now();
    const result = await backend.openTerminal(topology.panes[0]!, { cols: 80, rows: 24 }, { data: () => undefined, exit: (reason) => exits.push(reason) }).then(
      () => "opened",
      (error: Error) => error.message,
    );
    expect(result).toBe(coreTerminalText.noFirstPaint(0.2));
    expect(Date.now() - started).toBeLessThan(2_000);
    const link = core.liveLinks[0]!;
    expect(core.methods().filter((method) => method === "terminal.attach").length).toBe(1);
    expect(await eventually(() => link.viewerClosed.length === 1), "CLOSE for the attach").toBe(true);
    expect(link.channelOf("t1"), "no attach channel left open").toBeUndefined();
    expect(exits, "a refused open has no exit too").toEqual([]);
  });

  it("a page gone before the open began asks for no attach at all", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { backend } = machine(core);
    const topology = await backend.core.snapshot();
    const abort = new AbortController();
    abort.abort();
    const result = await backend.openTerminal(topology.panes[0]!, { cols: 80, rows: 24 }, { data: () => undefined, exit: () => undefined }, abort.signal).then(
      () => "opened",
      (error: Error) => error.message,
    );
    expect(result).toBe(coreTerminalText.closedWhileOpening);
    await pause(20);
    expect(core.methods()).not.toContain("terminal.attach");
  });
});

describe("core pane actions pass the desktop's layout guard", () => {
  it("the desktop row's Close reaches the implemented core close action", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { hosts } = await listed(core);
    await hosts.refresh("fixture");
    const view = hosts.list().find((host) => host.id === "fixture")!;
    const binding = rowBindingOf(view, "hc:t1")!;
    const result = await runPaneAction(
      hosts,
      { reread: async () => undefined, accept: () => undefined, watched: () => null },
      { id: 1 },
      "fixture",
      { type: "close", paneId: "hc:t1", binding, from: "row" },
    ).then(
      () => "closed",
      (error: Error) => error.message,
    );
    expect(result).toBe("closed");
    expect(core.methods()).toContain("terminal.kill");
    expect(core.methods()).toContain("terminal.rm");
  });

  it("a row's tab Rename reaches Herdr App's document; a terminal rename and a zoom are still refused", async () => {
    const core = new FakeCore([FakeCore.terminal("t1", { labels: { "herdr.space": "s1", "herdr.tab": "tA" } })]);
    core.setDocument("herdr-app", { spaces: [{ id: "s1", name: "App", tabs: [{ id: "tA", name: "Main", root: { terminal: "t1" } }] }] }, 3);
    const { hosts } = await listed(core);
    const placed = await eventually(async () => {
      await hosts.refresh("fixture");
      return hosts.pane("fixture", "hc:t1")?.tabID === "hc:tab:tA";
    });
    expect(placed).toBe(true);
    const layouts = { reread: async () => undefined, accept: () => undefined, watched: () => null };
    const binding = rowBindingOf(hosts.list().find((host) => host.id === "fixture")!, "hc:t1")!;
    const run = (action: Parameters<typeof runPaneAction>[4]): Promise<string> =>
      runPaneAction(hosts, layouts, { id: 1 }, "fixture", action).then(
        () => "done",
        (error: Error) => error.message,
      );
    expect(await run({ type: "rename", paneId: "hc:t1", label: "Build", binding, target: "tab", tabId: binding.tabId })).toBe("done");
    expect(core.methods()).toContain("doc.set");
    expect(await run({ type: "rename", paneId: "hc:t1", label: "logs", binding })).toBe(`unsupported: ${CoreActionText.renameTerminal}`);
    expect(await run({ type: "zoom", paneId: "hc:t1", zoomed: true, binding })).toBe(bindingTexts.notShown);
    expect(core.methods().filter((method) => method.startsWith("terminal.") && method !== "terminal.get")).toEqual([]);
  });

  it("a row's Close of a pane the fresh snapshot no longer lists is refused, nothing sent", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { hosts } = await listed(core);
    await hosts.refresh("fixture");
    const binding = rowBindingOf(hosts.list().find((host) => host.id === "fixture")!, "hc:t1")!;
    const backend = hosts.backend("fixture") as HerdrMachineBackend;
    core.event("removed", "t1", {});
    expect(await eventually(() => backend.core.follower.terminal("t1") === undefined), "the core's own view has it gone").toBe(true);
    const result = await runPaneAction(
      hosts,
      { reread: async () => undefined, accept: () => undefined, watched: () => null },
      { id: 1 },
      "fixture",
      { type: "close", paneId: "hc:t1", binding, from: "row" },
    ).then(
      () => "closed",
      (error: Error) => error.message,
    );
    expect(result).toBe(bindingTexts.gone);
    expect(core.methods()).not.toContain("terminal.kill");
  });
});

describe("a merged host tells the sidebar when its core goes", () => {
  it("a core disappearing while the TUI stays live publishes a sidebar change", async () => {
    const core = ownAgent(FakeCore.status("idle"));
    const tui = new LiveHerdr();
    tui.addTab("w1:t1", ["w1:p1"], {});
    const { backend } = machine(core, tui);
    await backend.core.snapshot();
    await backend.snapshot();
    // Controlled TUI stream: live, stays up. No real relay or socket.
    backend.tui.subscribeSidebar = (_kinds, _panes, sink) => {
      sink.started();
      return { close: () => undefined };
    };
    const events: string[] = [];
    let ended = false;
    const stream = backend.subscribeSidebar([], [], {
      started: () => undefined,
      event: (kind) => events.push(kind),
      ended: () => {
        ended = true;
      },
    });
    cleanups.push(() => stream.close());
    events.length = 0;
    backend.core.session.close();
    await pause(50);
    expect(events, "the merged stream must invalidate the core rows when its link is lost").toContain("pane.updated");
    expect(ended, "the TUI stream stays live").toBe(false);
  });
});

describe("a peer that breaks the framing stays refused", () => {
  for (const kind of ["unknown", "oversize"] as const) {
    it(`keeps a ${kind} frame refusal final at the host session, rather than opening another link`, async () => {
      const links: CoreTestLink[] = [];
      const session = new CoreSession({
        backoff: new CoreBackoff(0.01, 0.01),
        makeLink: () => {
          const link = new CoreTestLink(CoreFixtures.helloResult());
          links.push(link);
          return link;
        },
      });
      cleanups.push(() => session.close());
      await session.connection();
      const bytes = new Uint8Array(9);
      if (kind === "unknown") bytes[4] = 255;
      else writeLE32(bytes, 5, coreFrameMaximumPayload + 1);
      links[0]!.deliver(bytes);
      await pause(80);
      expect(links.length, "a malformed peer must remain refused").toBe(1);
      expect(session.state.kind).toBe("refused");
      expect(session.recoverableRefusal, "final: no rediscovery looks past it").toBeNull();
      await expect(session.connection()).rejects.toMatchObject({ kind: "refused" });
    });
  }

  it("an ordinary loss of the line is still retried", async () => {
    const links: CoreTestLink[] = [];
    const session = new CoreSession({
      backoff: new CoreBackoff(0.01, 0.01),
      makeLink: () => {
        const link = new CoreTestLink(CoreFixtures.helloResult());
        links.push(link);
        return link;
      },
    });
    cleanups.push(() => session.close());
    await session.connection();
    links[0]!.end();
    expect(await eventually(() => links.length === 2 && session.state.kind === "connected")).toBe(true);
  });
});

describe("a reconnect wait leaves nothing behind", () => {
  // The waits close() can end are one set, counted here (the session keeps no private stop promise to count).
  it("reconnect waits do not retain one stop listener per completed wait", async () => {
    let attempts = 0;
    const session = new CoreSession({
      backoff: new CoreBackoff(0, 0),
      sleep: () => (attempts < 50 ? Promise.resolve() : new Promise<void>(() => undefined)),
      makeLink: () => {
        attempts++;
        throw new Error("fixture disconnected");
      },
    });
    cleanups.push(() => session.close());
    const waits = (session as unknown as { stopWakers: Set<() => void> }).stopWakers;
    session.start();
    expect(await eventually(() => attempts === 50)).toBe(true);
    await pause(0);
    expect(waits.size, "only the current wait should subscribe to close").toBeLessThanOrEqual(1);
    session.close();
    expect(waits.size).toBe(0);
  });

  it("close ends a real backoff wait at once and leaves no timer", async () => {
    let attempts = 0;
    const session = new CoreSession({
      backoff: new CoreBackoff(60, 60),
      makeLink: () => {
        attempts++;
        throw new Error("fixture disconnected");
      },
    });
    session.start();
    expect(await eventually(() => session.state.kind === "waiting")).toBe(true);
    const waits = (session as unknown as { stopWakers: Set<() => void> }).stopWakers;
    expect(waits.size).toBe(1);
    session.close();
    expect(waits.size).toBe(0);
    await pause(20);
    expect(attempts).toBe(1);
    expect(session.state.kind).toBe("closed");
  });
});
