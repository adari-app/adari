// A Send from the Mac to a herdr-core pane, through the
// real paneSend IPC handler and send.ts's sendBound, on a saved machine
// (HerdrMachineBackend over the host's SSH, `hc connect` bridged to the fake
// core) in the HostRegistry. Claude Code's box is read through terminal.read;
// the message goes as terminal.send with `if` (the agent's status, idle or
// working); each of the bridge's refusals shows its text and nothing is typed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreActionText } from "../src/main/herdr/core-actions";
import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import { member, type CoreJSON } from "../src/main/herdr/core-json";
import { CoreBackoff } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { guardTexts, promptRefusal } from "../src/main/herdr/send";
import { APIError } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { claudeBoxTexts } from "../src/shared/claude-screen";
import { IPC } from "../src/shared/ipc-contract";
import { claudeScreen } from "./support/claude-screens";
import { FakeSshHost } from "./support/core-host-ssh";
import { fastFollower, ownAgent, shellAgent } from "./support/core-hosts";
import { eventually } from "./support/core-test-link";
import { FakeCore } from "./support/fake-core";

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
const config = { host: "studio.invalid", port: 22, username: "me", privateKeyPath: "", herdrSession: "default" };
const descriptor = { id: "studio", name: "studio", kind: "ssh" as const, address: "me@studio.invalid:22", platform: "macOS" };
const bindClaude = { terminalID: "hc:t1", isAgent: true, kind: "claude", session: null };

const backends: HerdrMachineBackend[] = [];
const registries: HostRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const backend of backends.splice(0)) backend.close();
});

/** The core's Claude Code screen: an empty box under its last reply. */
function screened(core: FakeCore, screen = claudeScreen()): FakeCore {
  core.overrides.set("terminal.read", () => ({ result: { text: screen, complete: true, how: "screen" } }));
  return core;
}

/** A core-only machine in the registry, its Claude pane listed; `send` is the IPC handler's. */
async function studio(core: FakeCore) {
  const host = new FakeSshHost(null, core);
  const backend = new HerdrMachineBackend(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
    route: { connect: host.connect },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: fastFollower,
  });
  backends.push(backend);
  const hosts = new HostRegistry(() => undefined);
  registries.push(hosts);
  hosts.add(descriptor, backend);
  const listed = await eventually(async () => {
    await hosts.refreshAll();
    return hosts.pane("studio", "hc:t1") !== null && hosts.agent("studio", "hc:t1") !== null;
  }, 400);
  expect(listed, "the core's Claude pane is listed").toBe(true);
  registered.handles.clear();
  registerIpc({ hosts } as never);
  const handler = registered.handles.get(IPC.paneSend)!;
  return {
    host,
    hosts,
    send: (text: string, binding: unknown = bindClaude) => handler(event, "studio", "hc:t1", text, binding) as Promise<void>,
  };
}

const sends = (core: FakeCore): CoreJSON[] => core.calls.filter((call) => call.method === "terminal.send").map((call) => call.params);
const methods = (core: FakeCore): string[] => core.calls.map((call) => call.method).filter((method) => method.startsWith("terminal."));

async function refusedWith(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the Send to be refused");
}

describe("a Send from the Mac to a herdr-core pane", () => {
  it("sends with `if`, never forced; after a failed send, reads Claude Code's box through terminal.read first", async () => {
    const core = screened(ownAgent(FakeCore.status("done")));
    const { host, send } = await studio(core);
    // With the machine's sidebar events live, the box is read after a failed send (or Stop, Esc).
    await refusedWith(send("run the tests"));
    expect(sends(core)).toEqual([]);
    core.setStatus("t1", FakeCore.status("idle"));
    core.calls.length = 0;
    await send("run the tests");
    const order = methods(core);
    const read = order.indexOf("terminal.read");
    expect(read, "the box was read first").toBeGreaterThanOrEqual(0);
    expect(order.indexOf("terminal.send")).toBeGreaterThan(read);
    const params = sends(core).at(-1);
    expect(member(params, "terminal")).toBe("t1");
    expect(member(params, "text")).toBe("run the tests");
    expect(member(params, "if")).toBe("idle");
    expect(member(params, "force")).toBeUndefined();
    expect(core.sent.map((entry) => entry.text)).toEqual(["run the tests"]);
    expect(host.tui, "no Herdr TUI on this machine").toBeNull();
  });

  it("a working agent is sent to with `if` working", async () => {
    const core = screened(ownAgent(FakeCore.status("working")), claudeScreen({ working: true }));
    const { send } = await studio(core);
    await send("and then the docs");
    expect(member(sends(core).at(-1), "if")).toBe("working");
    expect(core.sent.map((entry) => entry.text)).toEqual(["and then the docs"]);
  });

  it("our own message back in Claude Code's box (read through terminal.read) is not cleared on a core pane: refused, nothing typed", async () => {
    const core = screened(ownAgent(FakeCore.status("idle")));
    const { send } = await studio(core);
    await send("first message");
    // A failed send makes the next one read the box.
    core.setStatus("t1", FakeCore.status("done"));
    await refusedWith(send("second message"));
    core.setStatus("t1", FakeCore.status("idle"));
    screened(core, claudeScreen({ draft: "first message" }));
    core.calls.length = 0;
    const note = await refusedWith(send("second message"));
    expect(member(core.calls.find((call) => call.method === "terminal.read")?.params, "terminal")).toBe("t1");
    // Clearing takes keys herdr-core holds to no agent (agent.send_keys is Esc and Enter only), so the box keeps it.
    expect(note).toBe(claudeBoxTexts.notSentStillHasText);
    expect(core.sent.map((entry) => entry.text), "nothing joined the text in the box").toEqual(["first message"]);
    expect(core.keys, "no key went to the terminal").toEqual([]);
  });

  it("an agent that reports no status: agent_unverified, its text shown, nothing typed", async () => {
    const core = screened(ownAgent(undefined));
    const { send } = await studio(core);
    expect(await refusedWith(send("hello"))).toBe(promptRefusal(new APIError("agent_unverified", "")));
    expect(core.sent).toEqual([]);
  });

  it("the agent left for its shell with its status left live: agent_unbound, its text shown", async () => {
    const core = screened(shellAgent(FakeCore.status("idle")));
    const { hosts, send } = await studio(core);
    core.setForeground("t1", FakeCore.foreground("zsh", ["-zsh"], "/tmp", 4242));
    // The sidebar still shows Claude (its status names it); the core's own check refuses.
    await hosts.refreshAll();
    expect(hosts.agent("studio", "hc:t1")?.agent).toBe("claude");
    expect(await refusedWith(send("echo intended-for-agent"))).toBe(`${CoreActionText.agentUnbound} The text is kept.`);
    expect(sends(core)).toEqual([]);
    expect(core.sent).toEqual([]);
  });

  it("a blocked agent: agent_blocked, waiting for an answer, nothing typed", async () => {
    const core = screened(ownAgent(FakeCore.status("blocked", "claude", "question")));
    const { send } = await studio(core);
    expect(await refusedWith(send("yes"))).toBe(promptRefusal(new APIError("agent_blocked", CoreActionText.agentBlocked)));
    expect(sends(core)).toEqual([]);
  });

  it("a done or error agent: agent_word, its text shown", async () => {
    for (const word of ["done", "error"]) {
      const core = screened(ownAgent(FakeCore.status(word)));
      const { send } = await studio(core);
      expect(await refusedWith(send("continue")), word).toBe(`${CoreActionText.agentWord(word)} The text is kept.`);
      expect(sends(core)).toEqual([]);
    }
  });

  it("a dialog shown between a typed command and its Return: agent_dialog, the Return not pressed", async () => {
    const core = screened(ownAgent(FakeCore.status("idle")));
    const { hosts, send } = await studio(core);
    const run = hosts.run("studio", "hc:t1");
    expect(run).not.toBeNull();
    let dialogs = 0;
    // The dialog shows on the core when the command is typed; the Mac's next snapshot has not seen it yet.
    core.overrides.set("terminal.attach", (params) => {
      core.overrides.delete("terminal.attach");
      // One read (the bridge's, before the Return) sees the dialog.
      core.overrides.set("terminal.get", (get) => {
        core.overrides.delete("terminal.get");
        dialogs += 1;
        const answer = core.answer("terminal.get", get, core.liveLinks[0]!) as { result: Record<string, unknown> };
        return { result: { ...answer.result, status: FakeCore.status("blocked", "claude", "permission") } };
      });
      return core.answer("terminal.attach", params, core.liveLinks[0]!);
    });
    const note = await refusedWith(send("/compact", { ...bindClaude, run }));
    expect(dialogs, "the bridge read the terminal before the Return").toBeGreaterThan(0);
    // The Mac says what iOS says for a Return not taken (CompanionComposerModel.returnRefusedText).
    expect(note).toBe(guardTexts.returnRefused("claude"));
    expect(core.sent, "no Return sent: `if` cannot say blocked").toEqual([]);
    expect(core.keys).toEqual([]);
  });
});
