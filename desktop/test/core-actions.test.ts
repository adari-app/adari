// The app's actions on herdr-core panes, through HerdrClient as the app
// calls it, on a host with both kinds of Herdr. The cases of the iPhone
// app's CoreActionTests.swift.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { CoreActionText, coreKey, coreSeenMethod } from "../src/main/herdr/core-actions";
import { jsonArray, jsonObject, member, type CoreJSON } from "../src/main/herdr/core-json";
import type { CoreHostTransport } from "../src/main/herdr/core-host-transport";
import { CoreIDs } from "../src/main/herdr/core-model";
import { newAgent, type NewAgentClock } from "../src/main/herdr/new-agent";
import { APIError, decodeReply } from "../src/main/herdr/wire";
import { absentStartCommands } from "../src/shared/start-commands";
import { at, eventually } from "./support/core-test-link";
import { coreHost, noSocket } from "./support/core-hosts";
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

let core: FakeCore;
let tui: TUIFixtureTransport;
let host: CoreHostTransport;
let client: HerdrClient;

beforeEach(async () => {
  core = new FakeCore([
    // t1: Claude, the terminal's own program (`hc run -- claude`), reporting status.
    FakeCore.terminal("t1", {
      argv: ["claude"],
      labels: { "herdr.space": "s1", "herdr.tab": "tA" },
      status: FakeCore.status("idle"),
      turn: 4,
      foreground: FakeCore.foreground("claude", ["claude"], "/Users/me/code/app", 5151),
      pid: 5151,
    }),
    // t2: a plain shell.
    FakeCore.terminal("t2", { labels: { "herdr.space": "s1", "herdr.tab": "tA" }, foreground: FakeCore.foreground("zsh", ["-zsh"], "/Users/me/code/app") }),
  ]);
  const document: CoreJSON = {
    spaces: [
      {
        id: "s1",
        name: "App",
        folder: "/Users/me/code/app",
        color: "teal",
        tabs: [{ id: "tA", name: "Main", root: { split: { children: [{ terminal: "t1" }, { terminal: "t2" }] } } }],
      },
    ],
    focus: { space: "s1" },
  };
  core.setDocument("herdr-app", document, 7);
  tui = new TUIFixtureTransport();
  host = coreHost(tui, core);
  client = new HerdrClient(host);
  await client.sessionTopology();
});

afterEach(() => {
  host.close();
  host.follower.close();
});

const lastCall = (method: string): CoreJSON | undefined => core.calls.filter((call) => call.method === method).at(-1)?.params;

describe("the app's actions on herdr-core panes", () => {
  it("the box's Send pastes, then Enter, never to the TUI server", async () => {
    await client.sendInput("hc:t2", "\u001b[200~ls -la\nwc -l\u001b[201~", ["Enter"]);
    expect(core.sent.at(-1)?.terminal).toBe("t2");
    expect(core.sent.at(-1)?.text, "terminal.send pastes by itself").toBe("ls -la\nwc -l");
    expect(tui.requests.some((line) => line.includes("hc:t2")), "never to the TUI server").toBe(false);
  });

  it("Insert types without Enter on a short attach at the terminal's own size, closed after", async () => {
    await client.sendText("hc:t2", "git status");
    expect(await eventually(() => core.typedText("t2") === "git status")).toBe(true);
    expect(core.sent, "nothing submitted").toEqual([]);
    const attach = lastCall("terminal.attach");
    expect(member(attach, "cols"), "the terminal's own size: nothing resizes").toBe(120);
    expect(member(attach, "rows")).toBe(40);
    const link = core.liveLinks[0];
    expect(await eventually(() => (link?.viewerClosed.length ?? 0) > 0)).toBe(true);
    const connection = await host.follower.connection();
    expect(await eventually(() => connection.earlyChannels === 0)).toBe(true);
  });

  it("keys map to herdr-core's names", async () => {
    await client.paneSendKeys("hc:t2", ["Up", "Down", "Enter", "C-c", "y", "BSpace", "Tab"]);
    expect(core.keys.at(-1)?.keys).toEqual(["up", "down", "enter", "ctrl+c", "y", "backspace", "tab"]);
    expect(coreKey("M-x")).toBe("alt+x");
    expect(coreKey("F5")).toBe("f5");
    expect(coreKey("Escape")).toBe("esc");
    expect(coreKey("BTab")).toBe("shift+tab");
  });

  it("interrupt is the stop key: terminal.interrupt for a program that reports status, esc for a shell", async () => {
    await client.paneSendKeys("hc:t1", ["Escape"]);
    expect(member(lastCall("terminal.interrupt"), "terminal")).toBe("t1");
    await client.paneSendKeys("hc:t2", ["Escape"]);
    expect(core.keys.at(-1)?.keys).toEqual(["esc"]);
    expect(core.calls.filter((call) => call.method === "terminal.interrupt").length).toBe(1);
  });

  it("a prompt goes as terminal.send with if; blocked is waiting for an answer; no agent is refused as Herdr refuses it", async () => {
    await client.prompt("hc:t1", "run the tests");
    expect(core.sent.at(-1)?.text).toBe("run the tests");
    expect(member(lastCall("terminal.send"), "if")).toBe("idle");
    expect(member(lastCall("terminal.send"), "force"), "never answers a dialog by itself").toBeUndefined();

    core.overrides.set("terminal.send", () => FakeCore.rpcError("t1 is blocked", "blocked", "answer it first"));
    expect((await refusal(client.prompt("hc:t1", "x"))).code).toBe("agent_input_pending");
    core.overrides.delete("terminal.send");
    const before = core.sent.length;
    expect((await refusal(client.prompt("hc:t2", "x"))).code).toBe("agent_not_found");
    expect((await refusal(client.agentSendKeys("hc:t2", ["Enter"]))).code, "agent.send_keys never reaches a bare shell").toBe("agent_not_found");
    expect(core.sent.length).toBe(before);
    expect(core.keys).toEqual([]);
  });

  it("agent.send_keys takes Esc and Enter only", async () => {
    await client.agentSendKeys("hc:t1", ["Escape"]);
    expect(member(lastCall("terminal.interrupt"), "terminal")).toBe("t1");
    await client.agentSendKeys("hc:t1", ["Enter"]);
    expect(core.sent.at(-1)).toEqual({ terminal: "t1", text: "" });
    expect(member(lastCall("terminal.send"), "if")).toBe("idle");
    for (const keys of [["Down"], ["C-c"], ["Enter", "Enter"], ["Tab"]]) {
      const refused = await refusal(client.agentSendKeys("hc:t1", keys));
      expect(refused.code).toBe("unsupported");
      expect(refused.serverMessage).toBe(CoreActionText.agentKeys);
    }
    expect(core.keys, "no terminal.keys bound to an agent").toEqual([]);
  });

  it("read and close: terminal.read, then terminal.kill and terminal.rm", async () => {
    const text = await client.paneText("hc:t2", 40);
    expect(text).toContain("README.md");
    expect(member(lastCall("terminal.read"), "lines")).toBe(40);
    // The Claude box read (paneRead) goes the same way.
    expect(await client.paneRead("hc:t1", 60)).toContain("README.md");
    expect(member(lastCall("terminal.read"), "terminal")).toBe("t1");
    await client.closePane("hc:t2");
    expect(member(lastCall("terminal.kill"), "terminal")).toBe("t2");
    expect(member(lastCall("terminal.rm"), "terminal")).toBe("t2");
    expect(await eventually(async () => !(await client.sessionTopology()).panes.some((pane) => pane.paneID === "hc:t2"))).toBe(true);
  });

  it("New tab starts this machine's shell in the space", async () => {
    const created = await client.createTerminalTab("hc:space:s1", "build", "/Users/me/code/app/ios");
    const run = lastCall("terminal.run");
    expect(member(run, "argv"), "this machine's own shell").toBeUndefined();
    expect(member(run, "cwd")).toBe("/Users/me/code/app/ios");
    expect(at(run, "labels", "herdr.space")).toBe("s1");
    const tabID = at(run, "labels", "herdr.tab") as string;
    expect(typeof tabID).toBe("string");
    expect(member(run, "keep")).toBe(true);
    expect(at(run, "env", "TERM")).toBe("xterm-256color");
    expect(member(run, "name")).toBe("build");
    expect(created.tab.tabID).toBe(`hc:tab:${tabID}`);
    expect(created.tab.workspaceID).toBe("hc:space:s1");
    expect(created.tab.label).toBe("build");
    expect(CoreIDs.isCore(created.rootPane.paneID)).toBe(true);
    expect(tui.methods.filter((method) => method === "tab.create").length).toBe(0);
  });

  it("a split starts beside its pane, in its space and tab", async () => {
    const pane = await client.splitPane({ workspaceId: "hc:space:s1", targetPaneId: "hc:t2", cwd: null, direction: "down", focus: false });
    const run = lastCall("terminal.run");
    expect(at(run, "labels", "herdr.space")).toBe("s1");
    expect(at(run, "labels", "herdr.tab")).toBe("tA");
    expect(member(run, "cwd")).toBe("/Users/me/code/app");
    expect(pane.tabID).toBe("hc:tab:tA");
  });

  it("New agent starts the shell in the space and types `exec <kind>`, so the agent is the terminal's own program", async () => {
    // The Mac: once "exec claude" is typed into the new shell, Claude replaces it (the terminal's pid, 4242) and says idle.
    const watcher = (async () => {
      for (let index = 0; index < 500; index += 1) {
        const typed = core.sent.find((entry) => entry.text === "exec claude");
        if (typed !== undefined) {
          core.setForeground(typed.terminal, FakeCore.foreground("claude", ["claude"], "/Users/me/code/app", 4242));
          core.setStatus(typed.terminal, FakeCore.status("idle"));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const clock: NewAgentClock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))) };
    const result = await newAgent(client, absentStartCommands, { workspaceId: "hc:space:s1", folder: "/Users/me/code/app", kind: "claude" }, clock, 5_000, 20);
    await watcher;
    const address = CoreIDs.address(result.paneId);
    expect(address).toBeDefined();
    expect(core.sent.map((entry) => entry.text)).toEqual(["exec claude"]);
    expect(core.sent.every((entry) => entry.terminal === address)).toBe(true);
    expect(at(lastCall("terminal.run"), "labels", "herdr.space")).toBe("s1");
    expect(member(lastCall("terminal.run"), "cwd")).toBe("/Users/me/code/app");
    // Its shell is kept (as Herdr App keeps its terminals). As in the iPhone app, the first message to it goes
    // once it shows as an agent, held to its status word (`if`). Status-gated, not an atomic run guarantee.
    expect(await eventually(async () => (await client.agentList()).some((agent) => agent.paneID === result.paneId && agent.agentStatus === "idle"))).toBe(true);
    expect(member(lastCall("terminal.run"), "keep")).toBe(true);
    await client.prompt(result.paneId, "hello");
    expect(core.sent.at(-1)).toEqual({ terminal: address, text: "hello" });
    expect(member(lastCall("terminal.send"), "if")).toBe("idle");
  });

  it("Codex's start types `exec codex --no-daemon`; another kind's args, or any other word, are refused, never typed", async () => {
    await client.startAgent("codex", "codex", "hc:t2", ["--no-daemon"]);
    expect(core.sent.at(-1)).toEqual({ terminal: "t2", text: "exec codex --no-daemon" });
    await client.startAgent("claude", "claude", "hc:t2");
    expect(core.sent.at(-1)).toEqual({ terminal: "t2", text: "exec claude" });
    const typed = core.sent.length;
    expect((await refusal(client.startAgent("claude", "claude", "hc:t2", ["--no-daemon"]))).code).toBe("invalid_request");
    expect((await refusal(client.startAgent("codex", "codex", "hc:t2", ["--no-daemon; rm -r ~"]))).code).toBe("invalid_request");
    expect(core.sent.length, "nothing typed for a refused start").toBe(typed);
  });

  it("a rename writes Herdr App's document with its version; a conflict reads it again once; a terminal or the machine group is refused", async () => {
    await client.renameWorkspace("hc:space:s1", "  iOS app ");
    const set = lastCall("doc.set");
    expect(member(set, "version")).toBe(7);
    expect(member(set, "name")).toBe("herdr-app");
    const written = core.document("herdr-app")?.value;
    expect(at(written, "spaces", 0, "name")).toBe("iOS app");
    expect(at(written, "spaces", 0, "color"), "what it does not know is written back as read").toBe("teal");
    expect(member(written, "focus")).toEqual({ space: "s1" });
    expect(jsonArray(at(written, "spaces", 0, "tabs", 0, "root", "split", "children"))?.length).toBe(2);
    expect(await eventually(async () => (await client.sessionTopology()).workspaces.find((w) => w.workspaceID === "hc:space:s1")?.label === "iOS app")).toBe(true);

    let conflicted = false;
    core.overrides.set("doc.set", () => {
      conflicted = true;
      core.overrides.delete("doc.set");
      return FakeCore.rpcError("version 9 is newer", "conflict");
    });
    await client.renameTab("hc:tab:tA", "Build");
    expect(conflicted).toBe(true);
    expect(at(core.document("herdr-app")?.value, "spaces", 0, "tabs", 0, "name")).toBe("Build");

    expect((await refusal(client.renamePane("hc:t2", "logs"))).serverMessage).toBe(CoreActionText.renameTerminal);
    expect((await refusal(client.renameWorkspace("hc:machine", "x"))).code).toBe("unsupported");
  });

  it("seen rises once per turn (hc.mark_seen); a Herdr pane's sends nothing anywhere", async () => {
    const markSeen = async (paneID: string): Promise<void> => {
      decodeReply(await host.roundTrip(JSON.stringify({ id: "s", method: coreSeenMethod, params: { pane_id: paneID } })), (value) => value);
    };
    const before = (await client.agentList()).find((agent) => agent.paneID === "hc:t1");
    expect(before?.agentStatus, "no herdr.seen label: the core's own word").toBe("idle");
    await markSeen("hc:t1");
    expect(member(lastCall("terminal.label"), "labels")).toEqual({ "herdr.seen": "4" });
    expect(await eventually(() => jsonObject(core.record("t1")?.["labels"])?.["herdr.seen"] === "4")).toBe(true);
    expect(await eventually(() => host.follower.terminal("t1")?.labels["herdr.seen"] === "4")).toBe(true);
    await markSeen("hc:t1");
    expect(core.calls.filter((call) => call.method === "terminal.label").length, "never twice for one turn").toBe(1);
    // A new turn ends: done again until seen.
    core.endTurn("t1", 5);
    expect(await eventually(async () => (await client.agentList()).find((agent) => agent.paneID === "hc:t1")?.agentStatus === "done")).toBe(true);
  });

  it("New space is made in Herdr App (a core-only host)", async () => {
    const only = new TUIFixtureTransport();
    only.failure = noSocket();
    const onlyHost = coreHost(only, core);
    const onlyClient = new HerdrClient(onlyHost);
    await onlyClient.sessionTopology();
    expect((await refusal(onlyClient.createWorkspace("x", null))).serverMessage).toBe(CoreActionText.newSpace);
    onlyHost.follower.close();
  });
});
