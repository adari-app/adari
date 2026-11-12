// Chat sends to an agent on a kept terminal with the status check, as the iPhone app (CoreBridgeActions.agentGate) does. A prompt and an
// agent-bound Return go to a kept terminal's own-program agent whose status is idle or working, under `if` with
// that word. Everything else the gate refused still refuses on a kept terminal, before any terminal.send or
// terminal.keys. This is status-gated, not an atomic run guarantee (that needs an expected-run condition in
// herdr-core). The counterfactual cases below run against the production gate with no bypass. All links are fakes: no SSH, no herdr-core, no socket.

import { afterEach, describe, expect, it } from "vitest";

import { HerdrClient } from "../src/main/herdr/client";
import { CoreActionText } from "../src/main/herdr/core-actions";
import type { CoreJSON } from "../src/main/herdr/core-json";
import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import { CoreBackoff } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { planSend, sendBound } from "../src/main/herdr/send";
import { APIError } from "../src/main/herdr/wire";
import { HostRegistry } from "../src/main/hosts";
import { actingBridge, coreFollower, ownAgent } from "./support/core-hosts";
import { FakeSshHost } from "./support/core-host-ssh";
import { eventually } from "./support/core-test-link";
import { FakeCore } from "./support/fake-core";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});

const followerOptions = { heartbeatSilenceSeconds: 60, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };
const config = { host: "fixture.invalid", port: 22, username: "fixture", privateKeyPath: "", herdrSession: "default" };

const sends = (core: FakeCore): CoreJSON[] => core.calls.filter((call) => call.method === "terminal.send").map((call) => call.params);
const conditions = (core: FakeCore): (CoreJSON | undefined)[] => sends(core).map((params) => (params as Record<string, CoreJSON>)["if"]);
const terminalInput = (core: FakeCore): string[] => core.methods().filter((method) => method === "terminal.send" || method === "terminal.keys");

async function bridge(core: FakeCore) {
  const follower = coreFollower(core, followerOptions);
  cleanups.push(() => follower.close());
  await follower.snapshot();
  return { follower, client: new HerdrClient(actingBridge(follower)) };
}

async function listed(core: FakeCore) {
  const remote = new FakeSshHost(null, core);
  const backend = new HerdrMachineBackend(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
    route: { connect: remote.connect },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: followerOptions,
  });
  cleanups.push(() => backend.close());
  const hosts = new HostRegistry(() => undefined);
  cleanups.push(() => hosts.close());
  hosts.add({ id: "fixture", name: "Fixture", kind: "ssh", address: "fixture@fixture.invalid:22", platform: "macOS" }, backend);
  expect(await eventually(() => hosts.pane("fixture", "hc:t1") !== null)).toBe(true);
  return { backend, hosts };
}

async function refusal(promise: Promise<unknown>): Promise<APIError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof APIError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const operations = ["prompt", "Return"] as const;
type Operation = (typeof operations)[number];
const textOf = (operation: Operation): string => (operation === "prompt" ? "run the tests" : "");
const act = (client: HerdrClient, operation: Operation): Promise<unknown> =>
  operation === "prompt" ? client.prompt("hc:t1", textOf(operation)) : client.agentSendKeys("hc:t1", ["Enter"]);

/** Refused before any input: no terminal.send, no terminal.keys, nothing typed or pressed. */
async function refusedBeforeInput(core: FakeCore, client: HerdrClient, operation: Operation): Promise<APIError> {
  const refused = await refusal(act(client, operation));
  expect(terminalInput(core), `${operation}: no terminal.send or terminal.keys`).toEqual([]);
  expect(core.sent).toEqual([]);
  expect(core.keys).toEqual([]);
  return refused;
}

/** A kept terminal whose own program is the shell; `claude` runs as its child (as the iPhone app's core tests' shellAgent, kept). */
function keptShellAgent(status: CoreJSON | undefined): FakeCore {
  return new FakeCore([
    FakeCore.terminal("t1", {
      argv: ["/bin/zsh", "-l"],
      ...(status === undefined ? {} : { status }),
      foreground: FakeCore.foreground("claude", ["claude"], "/tmp", 5151),
      keep: true,
      pid: 4242,
    }),
  ]);
}

describe("a kept terminal's own-program agent takes prompt and Return under its status word", () => {
  for (const word of ["idle", "working"]) {
    for (const operation of operations) {
      it(`${operation} when ${word}: one terminal.send with if: ${word}, no keys`, async () => {
        const core = ownAgent(FakeCore.status(word), true);
        expect(core.record("t1")?.["keep"]).toBe(true);
        const { client } = await bridge(core);
        await act(client, operation);
        expect(core.sent).toEqual([{ terminal: "t1", text: textOf(operation) }]);
        expect(conditions(core)).toEqual([word]);
        expect(core.methods().filter((method) => method === "terminal.keys")).toEqual([]);
        expect(core.calls.filter((call) => call.method === "terminal.get").length, "the gate read the terminal as it is now").toBe(1);
      });
    }
  }

  it("the box's bound Send to a kept agent goes (the draft is not kept back)", async () => {
    const core = ownAgent(FakeCore.status("idle"), true);
    const { backend, hosts } = await listed(core);
    const expected = { terminalID: "hc:t1", isAgent: true, kind: "claude", session: null, run: hosts.run("fixture", "hc:t1")! };
    const site = {
      writer: backend,
      fresh: () => hosts.fresh("fixture"),
      pane: () => hosts.pane("fixture", "hc:t1"),
      agent: () => hosts.agent("fixture", "hc:t1"),
      run: () => hosts.run("fixture", "hc:t1"),
    };
    await sendBound(site, "hc:t1", "run the tests", expected);
    expect(core.sent).toEqual([{ terminal: "t1", text: "run the tests" }]);
    expect(conditions(core)).toEqual(["idle"]);
  });

  // The typed slash-command path types the command, then its agent-bound Return goes through the same gate. On a
  // kept idle agent that Return goes under `if`, so the command's text is not left in the box there; any other
  // refusal of that Return still says so.
  it("a typed slash command to a kept idle agent types its characters, then its Return goes under the status word", async () => {
    const core = ownAgent(FakeCore.status("idle"), true);
    const { backend, hosts } = await listed(core);
    const expected = { terminalID: "hc:t1", isAgent: true, kind: "claude", session: null, run: hosts.run("fixture", "hc:t1")! };
    const site = {
      writer: backend,
      fresh: () => hosts.fresh("fixture"),
      pane: () => hosts.pane("fixture", "hc:t1"),
      agent: () => hosts.agent("fixture", "hc:t1"),
      run: () => hosts.run("fixture", "hc:t1"),
    };
    expect(planSend("/compact", expected).kind).toBe("typed");
    await sendBound(site, "hc:t1", "/compact", expected);
    expect(core.typedText("t1")).toBe("/compact");
    expect(core.sent, "its Return: an empty send").toEqual([{ terminal: "t1", text: "" }]);
    expect(conditions(core)).toEqual(["idle"]);
    expect(core.keys).toEqual([]);
  });

  it("Escape (Stop) is unchanged: terminal.interrupt, nothing sent", async () => {
    for (const word of ["idle", "working"]) {
      const core = ownAgent(FakeCore.status(word), true);
      const { follower, client } = await bridge(core);
      await client.agentSendKeys("hc:t1", ["Escape"]);
      expect(core.calls.some((call) => call.method === "terminal.interrupt"), word).toBe(true);
      expect(core.sent).toEqual([]);
      follower.close();
    }
  });
});

describe("every other refusal still refuses on a kept terminal, before any input", () => {
  for (const operation of operations) {
    it(`a silent shell (no status): ${operation} refused`, async () => {
      const core = new FakeCore([
        FakeCore.terminal("t1", { argv: ["/bin/zsh", "-l"], foreground: FakeCore.foreground("zsh", ["-zsh"], "/tmp", 4242), keep: true, pid: 4242 }),
      ]);
      const { client } = await bridge(core);
      expect((await refusedBeforeInput(core, client, operation)).code).toBe("agent_not_found");
    });

    it(`its own-program agent with no status: ${operation} refused as unverified`, async () => {
      const core = ownAgent(undefined, true);
      const { client } = await bridge(core);
      const refused = await refusedBeforeInput(core, client, operation);
      expect([refused.code, refused.serverMessage]).toEqual(["agent_unverified", CoreActionText.agentUnverified]);
    });

    for (const word of ["done", "error"]) {
      it(`an unsupported status (${word}): ${operation} refused`, async () => {
        const core = ownAgent(FakeCore.status(word), true);
        const { client } = await bridge(core);
        const refused = await refusedBeforeInput(core, client, operation);
        expect([refused.code, refused.serverMessage]).toEqual(["agent_word", CoreActionText.agentWord(word)]);
      });
    }

    for (const word of ["idle", "working"]) {
      it(`a shell-child agent (${word}), not the terminal's own program: ${operation} refused`, async () => {
        const core = keptShellAgent(FakeCore.status(word));
        const { client } = await bridge(core);
        const refused = await refusedBeforeInput(core, client, operation);
        expect([refused.code, refused.serverMessage]).toEqual(["agent_unbound", CoreActionText.agentUnbound]);
      });
    }

    it(`a blocked dialog: ${operation} refused`, async () => {
      const core = ownAgent(FakeCore.status("blocked", "claude", "permission"), true);
      const { client } = await bridge(core);
      const refused = await refusedBeforeInput(core, client, operation);
      expect([refused.code, refused.serverMessage]).toEqual(
        operation === "prompt" ? ["agent_blocked", CoreActionText.agentBlocked] : ["agent_dialog", CoreActionText.agentDialog],
      );
    });

    it(`a finished record (its program exited with a code): ${operation} refused`, async () => {
      const core = ownAgent(FakeCore.status("idle"), true);
      const { follower, client } = await bridge(core);
      core.finish("t1", 0, "exited");
      expect(await eventually(() => follower.terminal("t1")?.state === "finished")).toBe(true);
      expect((await refusedBeforeInput(core, client, operation)).code).toBe("agent_not_found");
    });
  }
});

describe("counterfactual cases against the production gate", () => {
  for (const operation of operations) {
    it(`signal loss with its status cleared refuses ${operation}, before any input`, async () => {
      const core = ownAgent(FakeCore.status("idle"), true);
      const { follower, client } = await bridge(core);
      core.setStatus("t1", null);
      core.lose("t1");
      // A lost kept terminal stays live with no pid and no foreground (core-model.ts `lost`): no agent shows in it.
      expect(await eventually(() => follower.terminal("t1")?.reason === "signaled" && follower.terminal("t1")?.pid === undefined)).toBe(true);
      expect((await refusedBeforeInput(core, client, operation)).code).toBe("agent_not_found");
    });

    it(`a silent replacement shell refuses ${operation}, before any input`, async () => {
      const core = ownAgent(FakeCore.status("idle"), true);
      const { follower, client } = await bridge(core);
      core.setStatus("t1", null);
      core.lose("t1");
      core.restart("t1");
      expect(await eventually(() => follower.terminal("t1")?.pid === 4343 && follower.terminal("t1")?.state === "live")).toBe(true);
      const refused = await refusedBeforeInput(core, client, operation);
      expect([refused.code, refused.serverMessage]).toEqual(["agent_unverified", CoreActionText.agentUnverified]);
    });

    // The loss (and, for the shell, its silent replacement) lands at the send boundary, after the gate
    // passed. herdr-core's `if` holds it: nothing is typed or pressed.
    for (const shell of [false, true]) {
      it(`signal loss at the send boundary${shell ? ", with a silent replacement shell," : ""} types nothing for ${operation}`, async () => {
        const core = ownAgent(FakeCore.status("idle"), true);
        const { client } = await bridge(core);
        core.overrides.set("terminal.send", (params) => {
          core.overrides.delete("terminal.send");
          core.setStatus("t1", null);
          core.lose("t1");
          if (shell) core.event("restarted", "t1", FakeCore.terminal("t1", { keep: true, pid: 6262, argv: ["/bin/zsh"] }));
          return core.answer("terminal.send", params, core.liveLinks[0]!);
        });
        const refused = await refusal(act(client, operation));
        expect([refused.code, refused.serverMessage]).toEqual(["agent_not_ready", CoreActionText.agentChanged]);
        // One request: the override and the answer it hands on to each record it (FakeCore.answer).
        expect(conditions(core), "the one send carried the word").toEqual(["idle", "idle"]);
        expect(core.sent).toEqual([]);
        expect(core.keys).toEqual([]);
      });
    }
  }
});
