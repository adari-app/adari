// The core client's edge cases on the Mac: routing, framing, splits, renames,
// early frames, lookups, ended panes and the guards on agent-bound sends, as the
// iPhone app's core-client tests hold them where they apply to the desktop.
// Elsewhere: exact u64 values in core-protocol and core-model; SSH link close in
// core-transport and core-machine; the event stream's credit in core-model, its
// attach half and a resize while attaching in core-terminal; the lookup channel
// becoming hc connect in core-transport.

import { describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { CoreActionText } from "../src/main/herdr/core-actions";
import { CoreConnection, CoreConnectionError, CoreRPCError, type CoreLink, type CoreStreamItem } from "../src/main/herdr/core-connection";
import { CoreFrameKind, CoreFrames } from "../src/main/herdr/core-frames";
import { member, type CoreJSON } from "../src/main/herdr/core-json";
import { CoreHostTransport } from "../src/main/herdr/core-host-transport";
import { CoreIDs, CoreModel } from "../src/main/herdr/core-model";
import { projectCore } from "../src/main/herdr/core-projection";
import { CoreSession } from "../src/main/herdr/core-session";
import { CoreLinkError } from "../src/main/herdr/core-ssh";
import { decodeCoreTerminal } from "../src/main/herdr/core-wire";
import { APIError, decodeReply } from "../src/main/herdr/wire";
import { CoreFixtures, CoreTestLink, at, eventually, pause } from "./support/core-test-link";
import { actingBridge, coreFollower, coreHost, fastFollower, ownAgent, shellAgent } from "./support/core-hosts";
import { FakeCore } from "./support/fake-core";
import { TUIFixtureTransport } from "./support/tui-fixture";

async function refusal(promise: Promise<unknown>): Promise<APIError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof APIError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

function appCore(): FakeCore {
  const core = new FakeCore([
    FakeCore.terminal("t1", { status: FakeCore.status("blocked"), foreground: FakeCore.foreground("claude", ["claude"], "/Users/me/code/app") }),
    FakeCore.terminal("t2"),
  ]);
  core.setDocument("herdr-app", FakeCore.layout([{ id: "s1", name: "App", folder: "/Users/me/code/app", tabs: [{ id: "tA", name: "Main", terminals: ["t1", "t2"] }] }]));
  return core;
}

/** A core with the bridge's actions, through HerdrClient (CoreBridgeTransport(backend:)). */
async function bridged(core: FakeCore) {
  const follower = coreFollower(core);
  await follower.snapshot();
  return { follower, client: new HerdrClient(actingBridge(follower)) };
}

const sends = (core: FakeCore): CoreJSON[] => core.calls.filter((call) => call.method === "terminal.send").map((call) => call.params);

describe("the core client: routing, framing and pane lifecycle", () => {
  it("framed mode asked for is framed mode or a refusal; plain mode asked for still opens", async () => {
    const link = new CoreTestLink(CoreFixtures.helloResult({ framed: false }));
    const error = await failure(CoreConnection.open(link));
    expect(error).toBeInstanceOf(CoreConnectionError);
    expect((error as CoreConnectionError).fault.kind).toBe("notFramed");
    expect((error as Error).message).toContain("framed");
    expect(link.isClosed).toBe(true);
    expect(CoreSession.isPermanent(error), "waiting does not change it").toBe(true);
    const plain = await CoreConnection.open(new CoreTestLink(CoreFixtures.helloResult({ framed: false })), { framed: false });
    expect(plain.framed).toBe(false);
    plain.close("test over");
  });

  it("machine names that begin with \"machine\" round-trip; the reserved group forms stay out of every decoder", () => {
    for (const address of ["machine-room/t7", "machine/t7", "machinery/t12"]) expect(CoreIDs.address(CoreIDs.pane(address))).toBe(address);
    expect(CoreIDs.tabID(CoreIDs.tab("tA", "machine-room"))).toEqual({ id: "tA", machine: "machine-room" });
    expect(CoreIDs.spaceID(CoreIDs.space("s1", "machine-room"))?.machine).toBe("machine-room");
    expect(CoreIDs.address(CoreIDs.machineGroup())).toBeUndefined();
    expect(CoreIDs.address(CoreIDs.machineGroup("studio"))).toBeUndefined();
    expect(CoreIDs.address(CoreIDs.machineGroup("machine-room"))).toBeUndefined();
    expect(CoreIDs.tabID(CoreIDs.machineTab())).toBeUndefined();
    expect(CoreIDs.tabID(CoreIDs.machineTab("machine-room"))).toBeUndefined();
  });

  it("text that looks like a core id goes to the TUI pane on a TUI-only host", async () => {
    const tui = new TUIFixtureTransport();
    const host = coreHost(tui, null);
    const client = new HerdrClient(host);
    await client.sessionTopology();
    const before = tui.requests.length;
    await client.sendInput("w7:p1", "hc: help me debug", ["Enter"]);
    expect(tui.requests.length).toBe(before + 1);
    expect(tui.methods.at(-1)).toBe("pane.send_input");
    host.follower.close();
  });

  it("text naming a core terminal stays on the TUI pane on a merged host; the id field routes", async () => {
    const tui = new TUIFixtureTransport();
    const core = appCore();
    const host = coreHost(tui, core);
    const client = new HerdrClient(host);
    await client.sessionTopology();
    const before = tui.requests.length;
    await client.prompt("w7:p1", "hc:t1 is the build; compare with it").catch(() => undefined);
    expect(tui.requests.length).toBe(before + 1);
    expect(tui.methods.at(-1)).toBe("agent.prompt");
    expect(core.sent, "nothing reached herdr-core").toEqual([]);
    await client.sendInput("hc:t2", "ls", ["Enter"]);
    expect(tui.requests.length).toBe(before + 1);
    expect(core.sent.at(-1)?.terminal).toBe("t2");
    const { refersToCore } = await import("../src/main/herdr/core-host-transport");
    expect(refersToCore({ target_pane_id: "hc:t2", text: "x" })).toBe(true);
    expect(refersToCore({ pane_id: "w7:p1", name: "hc:t1", labels: ["hc:x"] })).toBe(false);
    host.follower.close();
  });

  async function remoteSplitRun(target: string, terminals: CoreJSON[]): Promise<CoreJSON | undefined> {
    const core = new FakeCore(terminals);
    core.machines.push(FakeCore.machine("studio"));
    core.setDocument(
      "studio:herdr-app",
      FakeCore.layout([
        {
          id: "s1",
          name: "Remote",
          folder: "/tmp",
          tabs: [
            { id: "tA", name: "Build", terminals: ["t7"] },
            { id: "tB", name: "Logs", terminals: ["t8"] },
          ],
        },
      ]),
    );
    const { follower, client } = await bridged(core);
    // Refused after it is recorded: the test needs the run request only.
    core.overrides.set("terminal.run", () => FakeCore.rpcError("stopped by the test", "unavailable"));
    expect(await eventually(() => follower.layoutDocument("studio") !== undefined)).toBe(true);
    const pane = (await follower.snapshot()).topology.panes.find((each) => each.paneID === target);
    expect(pane).toBeDefined();
    await client.splitPane({ workspaceId: pane!.workspaceID, targetPaneId: target, cwd: null, direction: "down", focus: false }).catch(() => undefined);
    follower.close();
    return core.calls.filter((call) => call.method === "terminal.run").at(-1)?.params;
  }

  it("a remote split takes the target's space and tab labels", async () => {
    const run = await remoteSplitRun("hc:studio/t7", [FakeCore.terminal("studio/t7", { labels: { "herdr.space": "s1", "herdr.tab": "tA" } })]);
    expect(member(run, "on")).toBe("studio");
    expect(at(run, "labels", "herdr.space")).toBe("s1");
    expect(at(run, "labels", "herdr.tab")).toBe("tA");
  });

  it("a remote split of a terminal placed only in its machine's document", async () => {
    const run = await remoteSplitRun("hc:studio/t8", [FakeCore.terminal("studio/t8")]);
    expect(member(run, "on")).toBe("studio");
    expect(at(run, "labels", "herdr.space")).toBe("s1");
    expect(at(run, "labels", "herdr.tab")).toBe("tB");
  });

  it("a rename retried after a conflict says so; none without one", async () => {
    const core = appCore();
    const follower = coreFollower(core);
    await follower.snapshot();
    const bridge = actingBridge(follower);
    core.overrides.set("doc.set", () => {
      core.overrides.delete("doc.set");
      core.setDocumentAndNotify("herdr-app", core.document("herdr-app")?.value ?? null);
      return FakeCore.rpcError("version 2 is newer", "conflict", "read it again");
    });
    const rename = async (method: string, params: Record<string, string>): Promise<CoreJSON> =>
      decodeReply(await bridge.roundTrip(JSON.stringify({ id: "r", method, params })), (value) => value as CoreJSON);
    const renamed = await rename("workspace.rename", { workspace_id: CoreIDs.space("s1"), label: "Shipping" });
    const notice = member(renamed, "notice");
    expect(typeof notice === "string" && notice.includes("Herdr App"), String(notice)).toBe(true);
    expect(at(core.document("herdr-app")?.value, "spaces", 0, "name")).toBe("Shipping");
    expect(core.calls.filter((call) => call.method === "doc.set").length, "compare-and-set kept: one retry").toBe(2);
    const plain = await rename("tab.rename", { tab_id: CoreIDs.tab("tA"), label: "Build" });
    expect(member(plain, "notice")).toBeUndefined();
    follower.close();
  });

  describe("early frames are kept only for a stream a reply opened, within one bound", () => {
    async function openFramed(): Promise<{ connection: CoreConnection; link: CoreTestLink }> {
      const link = new CoreTestLink(CoreFixtures.helloResult());
      return { connection: await CoreConnection.open(link), link };
    }

    async function opened(connection: CoreConnection, link: CoreTestLink, channel: number): Promise<void> {
      const call = connection.call("terminal.attach", { terminal: "t1", cols: 80, rows: 24 });
      const requests = await link.waitForRequests(link.requests().length + 1);
      link.deliverJson({ jsonrpc: "2.0", id: member(requests.at(-1), "id") ?? null, result: { channel, terminal: { address: "t1" } } });
      await call;
    }

    it("CLOSE and DATA frames for channels nobody opened keep nothing", async () => {
      const { connection, link } = await openFramed();
      for (let channel = 100; channel < 200; channel += 1) link.deliverFrame(CoreFrames.close(channel));
      for (let channel = 200; channel < 210; channel += 1) link.deliverFrame(CoreFrames.data(channel, new Uint8Array()));
      await connection.call("ping", {}, 0.05).catch(() => undefined);
      expect(connection.earlyChannels, "unknown CLOSE and DATA frames retain nothing").toBe(0);
      connection.close("test over");
    });

    it("a late attach reply after its timeout is closed toward the core, not kept", async () => {
      const { connection, link } = await openFramed();
      await failure(connection.call("terminal.attach", { terminal: "t1" }, 0.02));
      const id = member(link.requests().at(-1), "id") ?? null;
      link.deliverJson({ jsonrpc: "2.0", id, result: { channel: 7, terminal: { address: "t1" } } });
      link.deliverFrame(CoreFrames.data(7, new TextEncoder().encode("first paint")));
      link.deliverFrame(CoreFrames.data(7, new TextEncoder().encode("more")));
      expect(await eventually(() => link.split().frames.some((frame) => frame.channel === 7 && frame.kind === CoreFrameKind.close))).toBe(true);
      expect(connection.earlyChannels, "the orphan's frames are not kept").toBe(0);
      connection.close("test over");
    });

    it("early frames of an opened stream wait for its reader", async () => {
      const { connection, link } = await openFramed();
      await opened(connection, link, 5);
      link.deliverFrame(CoreFrames.data(5, new TextEncoder().encode("paint")));
      await connection.call("ping", {}, 0.05).catch(() => undefined);
      const first = await connection.stream(5).take();
      expect(first?.kind === "data" ? new TextDecoder().decode(first.bytes) : first).toBe("paint");
      connection.close("test over");
    });

    it("early frames are bounded across channels and count items; an overflowed stream says so", async () => {
      const { connection, link } = await openFramed();
      await opened(connection, link, 5);
      await opened(connection, link, 6);
      const chunk = new Uint8Array(1 << 20).fill(65);
      for (let index = 0; index < 3; index += 1) link.deliverFrame(CoreFrames.data(5, chunk));
      for (let index = 0; index < 3; index += 1) link.deliverFrame(CoreFrames.data(6, chunk));
      for (let index = 0; index < CoreConnection.earlyItemLimit + 10; index += 1) link.deliverFrame(CoreFrames.data(5, new Uint8Array()));
      await connection.call("ping", {}, 0.05).catch(() => undefined);
      expect(connection.earlyKeptBytes, "one bound for all channels together").toBeLessThanOrEqual(CoreConnection.earlyLimit);
      expect(connection.earlyKeptItems, "zero-byte items count too").toBeLessThanOrEqual(CoreConnection.earlyItemLimit);
      const saw: CoreStreamItem[] = [];
      const six = await connection.stream(6).take();
      if (six !== null) saw.push(six);
      const five = await connection.stream(5).take();
      if (five !== null) saw.push(five);
      expect(saw.some((item) => item.kind === "lost")).toBe(true);
      connection.close("test over");
    });
  });

  it("a core installed after a failed lookup is found on a later refresh, at most once per recheck period", async () => {
    const core = appCore();
    let installed = false;
    let attempts = 0;
    const follower = coreFollower(core, fastFollower, () => {
      attempts += 1;
      if (!installed) throw new CoreLinkError({ kind: "notInstalled" });
      return core.makeLink();
    });
    const tui = new TUIFixtureTransport();
    const host = new CoreHostTransport(tui, actingBridge(follower), { coreGraceSeconds: 1, coreRecheckSeconds: 0.3 });
    const changes: string[] = [];
    follower.changes((change) => changes.push(change.kind));
    const client = new HerdrClient(host);
    let topology = await client.sessionTopology();
    expect(topology.panes.some((pane) => CoreIDs.isCore(pane.paneID))).toBe(false);
    expect(attempts).toBe(1);
    await client.sessionTopology();
    expect(attempts, "at most one lookup per recheck period").toBe(1);
    installed = true;
    await pause(350);
    await client.sessionTopology();
    expect(await eventually(() => attempts >= 2)).toBe(true);
    expect(await eventually(() => changes.includes("changed")), "its arrival is a change").toBe(true);
    topology = await client.sessionTopology();
    expect(topology.panes.some((pane) => pane.paneID === "hc:t1"), "the core's terminals show").toBe(true);
    expect(topology.panes.some((pane) => pane.paneID === "w7:p1"), "next to the TUI's").toBe(true);
    follower.close();
  });

  it("a refusal waiting cannot change is not looked for again", async () => {
    let made = 0;
    const follower = coreFollower(null, fastFollower, (): CoreLink => {
      made += 1;
      return new CoreTestLink(CoreFixtures.helloResult({ generation: 2 }));
    });
    const host = new CoreHostTransport(new TUIFixtureTransport(), actingBridge(follower), { coreGraceSeconds: 1, coreRecheckSeconds: 0.05 });
    const client = new HerdrClient(host);
    await client.sessionTopology();
    await pause(150);
    await client.sessionTopology();
    await pause(150);
    await client.sessionTopology();
    expect(made, "a newer generation stays refused").toBe(1);
    follower.close();
  });

  it("a finished terminal is projected as an ended pane", () => {
    const record = { ...decodeCoreTerminal(FakeCore.terminal("t1", { state: "finished" })), reason: "exited", exitCode: 2 };
    const projection = projectCore({ model: new CoreModel(1, [record]), machineName: "studio" });
    const pane = projection.topology.panes[0];
    expect(pane?.paneID).toBe("hc:t1");
    expect(pane?.agent).toBeUndefined();
    expect(pane?.title).toBe("Exited (2)");
    expect(projection.agents).toEqual([]);
  });

  it("an open agent pane keeps its ended row through a snapshot refresh; it takes no input and says why; close removes it", async () => {
    const core = new FakeCore([FakeCore.terminal("t1", { status: FakeCore.status("idle"), foreground: FakeCore.foreground("claude", ["claude"], "/Users/me/code/app") })]);
    const { follower, client } = await bridged(core);
    expect((await client.sessionTopology()).panes.find((pane) => pane.paneID === "hc:t1")?.agent).toBe("claude");
    core.finish("t1", 0);
    expect(await eventually(async () => (await client.sessionTopology()).panes.find((pane) => pane.paneID === "hc:t1")?.agent === undefined)).toBe(true);
    let pane = (await client.sessionTopology()).panes.find((each) => each.paneID === "hc:t1");
    expect(pane, "the open pane keeps its row").toBeDefined();
    expect(pane?.title).toBe("Exited (0)");
    expect((await client.agentList()).some((agent) => agent.paneID === "hc:t1")).toBe(false);
    core.missed();
    await pause(100);
    pane = (await client.sessionTopology()).panes.find((each) => each.paneID === "hc:t1");
    expect(pane?.title, "still there after the refresh").toBe("Exited (0)");
    const refused = await refusal(client.sendInput("hc:t1", "ls", ["Enter"]));
    expect(refused.code).toBe("pane_exited");
    expect(refused.serverMessage).toBe(CoreActionText.ended);
    await client.closePane("hc:t1");
    expect(core.calls.some((call) => call.method === "terminal.rm")).toBe(true);
    expect(await eventually(async () => !(await client.sessionTopology()).panes.some((each) => each.paneID === "hc:t1"))).toBe(true);
    follower.close();
  });

  it("closing a live pane ends it and removes it", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { follower, client } = await bridged(core);
    await client.closePane("hc:t1");
    expect(core.calls.filter((call) => call.method.startsWith("terminal.")).map((call) => call.method)).toEqual(["terminal.kill", "terminal.rm"]);
    expect(await eventually(async () => !(await client.sessionTopology()).panes.some((pane) => pane.paneID === "hc:t1"))).toBe(true);
    follower.close();
  });

  /** The agent leaves after the bridge's check, before the core types: its status resets and a shell is in front. */
  function exitAtTheBoundary(core: FakeCore, methods: readonly string[]): void {
    for (const method of methods) {
      core.overrides.set(method, (params) => {
        core.setStatus("t1", null);
        core.setForeground("t1", FakeCore.foreground("zsh", ["zsh"], "/tmp"));
        for (const each of methods) core.overrides.delete(each);
        return core.answer(method, params, core.liveLinks[0]!);
      });
    }
  }

  it("a prompt is not submitted to the shell if the agent exits at the send boundary", async () => {
    const core = ownAgent(FakeCore.status("idle"));
    const { follower, client } = await bridged(core);
    exitAtTheBoundary(core, ["terminal.send"]);
    await failure(client.prompt("hc:t1", "echo intended-for-agent"));
    expect(core.sent, "nothing went to the shell that replaced the agent").toEqual([]);
    expect(member(sends(core).at(-1), "if"), "the agent's status is the core's condition for typing").toBe("idle");
    follower.close();
  });

  it("the guarded Return is not pressed in the shell if the agent exits at the boundary", async () => {
    const core = ownAgent(FakeCore.status("idle"));
    const { follower, client } = await bridged(core);
    exitAtTheBoundary(core, ["terminal.send", "terminal.keys"]);
    await failure(client.agentSendKeys("hc:t1", ["Enter"]));
    expect(core.sent).toEqual([]);
    expect(core.keys).toEqual([]);
    follower.close();
  });

  it("an agent that reports no status is never sent to, but its pane still takes input", async () => {
    const core = ownAgent(undefined);
    const { follower, client } = await bridged(core);
    expect((await client.agentList()).map((agent) => agent.paneID), "an agent all the same").toEqual(["hc:t1"]);
    expect((await refusal(client.prompt("hc:t1", "hello"))).code).toBe("agent_unverified");
    expect((await refusal(client.agentSendKeys("hc:t1", ["Enter"]))).code).toBe("agent_unverified");
    expect(core.sent).toEqual([]);
    expect(core.keys).toEqual([]);
    await client.paneSendKeys("hc:t1", ["Down"]);
    expect(core.keys.at(-1)?.keys).toEqual(["down"]);
    follower.close();
  });
});

describe("agent-bound sends and their status conditions", () => {
  it("the fake holds terminal.send to its schema (if is idle or working only)", async () => {
    const core = ownAgent(FakeCore.status("blocked", "claude", "permission"));
    const { follower } = await bridged(core);
    const connection = await follower.connection();
    for (const word of ["blocked", "done", "error"]) {
      const error = await failure(connection.call("terminal.send", { terminal: "t1", text: "y", if: word, force: true }));
      expect(error).toBeInstanceOf(CoreRPCError);
      expect((error as CoreRPCError).kind).toBe("invalid_params");
    }
    expect(core.sent).toEqual([]);
    follower.close();
  });

  it("idle and working are the only conditions, and nothing is forced", async () => {
    for (const word of ["idle", "working"]) {
      const core = ownAgent(FakeCore.status(word));
      const { follower, client } = await bridged(core);
      await client.prompt("hc:t1", "next step");
      await client.agentSendKeys("hc:t1", ["Enter"]);
      expect(sends(core).map((params) => member(params, "if"))).toEqual([word, word]);
      expect(sends(core).every((params) => member(params, "force") !== true), "a send never types into a dialog").toBe(true);
      expect(core.sent.map((entry) => entry.text)).toEqual(["next step", ""]);
      follower.close();
    }
  });

  it("Return to a blocked dialog is refused clearly, not sent with an invalid condition", async () => {
    const core = ownAgent(FakeCore.status("blocked", "claude", "permission"));
    const { follower, client } = await bridged(core);
    const refused = await refusal(client.agentSendKeys("hc:t1", ["Enter"]));
    expect(refused.code).toBe("agent_dialog");
    expect(refused.serverMessage).toBe(CoreActionText.agentDialog);
    expect(sends(core), "no terminal.send: `if` cannot say blocked and `force` alone has no guard").toEqual([]);
    expect(core.sent).toEqual([]);
    expect(core.keys).toEqual([]);
    follower.close();
  });

  it("a prompt to a blocked agent is refused as waiting for an answer", async () => {
    const core = ownAgent(FakeCore.status("blocked", "claude", "question"));
    const { follower, client } = await bridged(core);
    const refused = await refusal(client.prompt("hc:t1", "yes"));
    expect(refused.code).toBe("agent_blocked");
    expect(refused.serverMessage).toBe(CoreActionText.agentBlocked);
    expect(sends(core)).toEqual([]);
    follower.close();
  });

  it("a prompt or Return to a done or error agent is refused clearly, never sent unconditionally", async () => {
    for (const word of ["done", "error"]) {
      const core = ownAgent(FakeCore.status(word));
      const { follower, client } = await bridged(core);
      const prompt = await refusal(client.prompt("hc:t1", "continue"));
      expect(prompt.code).toBe("agent_word");
      expect(prompt.serverMessage).toBe(CoreActionText.agentWord(word));
      expect((await refusal(client.agentSendKeys("hc:t1", ["Enter"]))).code).toBe("agent_word");
      expect(sends(core), `${word}: no terminal.send at all`).toEqual([]);
      follower.close();
    }
  });

  async function refusedUnbound(core: FakeCore, client: HerdrClient): Promise<void> {
    const prompt = await refusal(client.prompt("hc:t1", "echo intended-for-agent"));
    expect(prompt.code).toBe("agent_unbound");
    expect(prompt.serverMessage).toBe(CoreActionText.agentUnbound);
    expect((await refusal(client.agentSendKeys("hc:t1", ["Enter"]))).code).toBe("agent_unbound");
    expect(sends(core), "no terminal.send reached the core").toEqual([]);
    expect(core.sent).toEqual([]);
    expect(core.keys).toEqual([]);
  }

  it("the foreground back to the shell with the status left live refuses prompt and Return", async () => {
    const core = shellAgent(FakeCore.status("idle"));
    const { follower, client } = await bridged(core);
    core.setForeground("t1", FakeCore.foreground("zsh", ["-zsh"], "/tmp", 4242));
    expect(await eventually(() => follower.terminal("t1")?.foreground?.name === "zsh")).toBe(true);
    expect(follower.terminal("t1")?.status?.state, "the last status stays live").toBe("idle");
    await refusedUnbound(core, client);
    follower.close();
  });

  it("the agent leaving for its shell as the send arrives never reaches the shell", async () => {
    const core = shellAgent(FakeCore.status("idle"));
    const { follower, client } = await bridged(core);
    core.overrides.set("terminal.send", (params) => {
      core.setForeground("t1", FakeCore.foreground("zsh", ["zsh"], "/tmp", 4242));
      core.overrides.delete("terminal.send");
      return core.answer("terminal.send", params, core.liveLinks[0]!);
    });
    await refusedUnbound(core, client);
    follower.close();
  });

  it("a kept terminal's replacement shell is refused whatever runs in it", async () => {
    const core = ownAgent(FakeCore.status("idle"), true);
    const { follower, client } = await bridged(core);
    core.setStatus("t1", null);
    core.lose("t1");
    core.restart("t1");
    core.setForeground("t1", FakeCore.foreground("claude", ["claude"], "/tmp", 6060));
    core.setStatus("t1", FakeCore.status("idle"));
    expect(await eventually(() => follower.terminal("t1")?.foreground?.pid === 6060)).toBe(true);
    await refusedUnbound(core, client);
    core.setForeground("t1", FakeCore.foreground("zsh", ["-zsh"], "/tmp", 4343));
    expect(await eventually(() => follower.terminal("t1")?.foreground?.pid === 4343)).toBe(true);
    await refusedUnbound(core, client);
    follower.close();
  });

  it("the normal agent path still sends, reading the terminal as it is now each time", async () => {
    // As in the iPhone app: kept or not, the terminal's own-program agent takes them under its status word
    // (status-gated, not an atomic run guarantee).
    for (const keep of [false, true]) {
      const core = ownAgent(FakeCore.status("idle"), keep);
      const { follower, client } = await bridged(core);
      await client.prompt("hc:t1", "run the tests");
      await client.agentSendKeys("hc:t1", ["Enter"]);
      expect(core.sent.map((entry) => entry.text), `keep: ${keep}`).toEqual(["run the tests", ""]);
      expect(sends(core).map((params) => member(params, "if"))).toEqual(["idle", "idle"]);
      expect(core.calls.filter((call) => call.method === "terminal.get").length, "each send reads the terminal as it is now").toBe(2);
      follower.close();
    }
    const node = new FakeCore([
      FakeCore.terminal("t1", {
        argv: ["claude"],
        status: FakeCore.status("working"),
        foreground: FakeCore.foreground("node", ["node", "/opt/homebrew/bin/claude"], "/tmp", 5151),
        pid: 5151,
      }),
    ]);
    const { follower, client } = await bridged(node);
    await client.prompt("hc:t1", "and then");
    expect(node.sent.map((entry) => entry.text), "a node-hosted claude is its terminal's program too").toEqual(["and then"]);
    follower.close();
  });
});
