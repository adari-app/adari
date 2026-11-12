// A Chat send while Claude works arrives the first time. It goes as one
// agent.prompt (send.ts sendBound → deliver → HerdrClient.prompt). Herdr
// answers it only when the agent has taken the text, which can be slower than
// the 10 s round-trip budget of other requests (ssh.ts
// defaultRoundTripTimeoutMs); ending the SSH client at that deadline would end
// the remote request in flight, and the note would claim "Sent, but the Mac
// did not confirm it". The prompt has its own budget (commands.ts
// promptRoundTripTimeoutMs), and a prompt that still gets no answer says
// plainly it did not go. Over the real SshHerdrTransport, HerdrClient,
// HerdrTuiBackend and HostRegistry, with an in-memory ssh2 only (as
// agent-stop-transport.test.ts); the key path is this file's own bytes.

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const ssh = vi.hoisted(() => ({
  clients: [] as { end(): void; ended: boolean }[],
  herdr: null as { roundTrip(line: string): Promise<string> } | null,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    ended = false;
    connect(): void {
      ssh.clients.push(this);
      queueMicrotask(() => this.emit("ready"));
    }
    end(): void {
      this.ended = true;
      this.emit("end");
      this.emit("close");
    }
    exec(command: string, reply: (error: Error | undefined, channel: unknown) => void): void {
      const encoded = /printf '%s' '([^']+)'/.exec(command)?.[1] ?? "";
      const request = Buffer.from(encoded, "base64").toString("utf8").trim();
      const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => undefined });
      reply(undefined, channel);
      ssh.herdr!.roundTrip(request).then(
        (answer) => {
          // A request whose SSH client was ended dies with it: its answer never comes back.
          if (!this.ended) channel.emit("data", Buffer.from(`${answer}\n`));
        },
        () => channel.emit("close"),
      );
    }
  }
  return { Client };
});

import { HerdrTuiBackend } from "../src/main/herdr/backend";
import { HerdrClient } from "../src/main/herdr/client";
import { RequestTimedOutError } from "../src/main/herdr/errors";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { deliver, planSend, sendBound } from "../src/main/herdr/send";
import { SshHerdrTransport } from "../src/main/herdr/ssh";
import type { HerdrTransport } from "../src/main/herdr/transport";
import { HostRegistry } from "../src/main/hosts";
import { LiveHerdr } from "./support/live-herdr";

const config = { host: "fake.invalid", port: 22, username: "fixture", privateKeyPath: fileURLToPath(import.meta.url), herdrSession: "fixture" };
const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fake.invalid", platform: null };
const opened: HostRegistry[] = [];
/** How long Claude Code, working, takes before Herdr answers the prompt (longer than the 10 s budget of other requests). */
const takesMs = 12_000;

/** Mac mini over SSH: tab w1:t1 holds p1 (Claude, working); agent.prompt answers after `takesMs`. */
async function machine() {
  const live = new LiveHerdr();
  live.addTab("w1:t1", ["w1:p1", "w1:p2"], { "w1:p1": "claude" });
  const original = live.roundTrip.bind(live);
  const prompts: string[] = [];
  ssh.herdr = {
    roundTrip: async (line: string) => {
      const request = JSON.parse(line);
      if (request.method === "agent.prompt") {
        await new Promise((resolve) => setTimeout(resolve, takesMs));
        prompts.push(request.params.text);
        return JSON.stringify({ id: request.id, result: {} });
      }
      const raw = JSON.parse(await original(line));
      if (request.method === "session.snapshot") {
        for (const p of raw.result.snapshot.panes) if (p.agent) p.agent_status = "working";
        for (const a of raw.result.snapshot.agents) a.agent_status = "working";
      }
      return JSON.stringify(raw);
    },
  };
  const registry = new HostRegistry(() => undefined);
  opened.push(registry);
  registry.add(descriptor, new HerdrTuiBackend(config, new PinningHostKeyPolicy(new MemoryPinStore())));
  await registry.refreshAll();
  return { registry, prompts };
}

afterEach(() => {
  vi.useRealTimers();
  for (const registry of opened.splice(0)) registry.close();
  ssh.clients.length = 0;
  ssh.herdr = null;
});

describe("a Chat send while Claude works arrives the first time", () => {
  it("agent.prompt asks the transport for its own, longer budget", async () => {
    const asked: unknown[] = [];
    const transport: HerdrTransport = {
      roundTrip: (line: string, ...rest: unknown[]) => {
        asked.push(rest[0]);
        return Promise.resolve(JSON.stringify({ id: JSON.parse(line).id, result: {} }));
      },
    } as HerdrTransport;
    await new HerdrClient(transport).prompt("w1:p1", "hello");
    expect(asked).toEqual([{ timeoutMs: 60_000 }]);
  });

  it("the SSH transport waits out a prompt answered after 12 s and keeps its client", async () => {
    const m = await machine();
    vi.useFakeTimers();
    const transport = new SshHerdrTransport(config, new PinningHostKeyPolicy(new MemoryPinStore()));
    // Its own client first (a snapshot), so the prompt's deadline is the only timer that matters.
    const client = new HerdrClient(transport);
    const sent = client.prompt("w1:p1", "first try").then(
      () => "answered",
      (error: unknown) => (error as Error).message,
    );
    await vi.advanceTimersByTimeAsync(takesMs + 100);
    expect(await sent).toBe("answered");
    expect(m.prompts).toEqual(["first try"]);
    expect(ssh.clients.at(-1)!.ended).toBe(false);
    transport.close();
  });

  it("a Chat send while Claude works ends with no note, the text taken once, no resend needed", async () => {
    const m = await machine();
    const pane = m.registry.pane("mini", "w1:p1")!;
    expect(pane.agent).toBe("claude");
    vi.useFakeTimers();
    const sent = sendBound(
      {
        writer: m.registry.backend("mini")!,
        fresh: async () => true,
        pane: () => m.registry.pane("mini", "w1:p1"),
        agent: () => m.registry.agent("mini", "w1:p1"),
      },
      "w1:p1",
      "look at the tests too",
      { terminalID: pane.terminalID, isAgent: true, kind: "claude", session: null },
    ).then(
      () => null,
      (error: unknown) => (error as Error).message,
    );
    await vi.advanceTimersByTimeAsync(takesMs + 100);
    expect(await sent).toBeNull();
    expect(m.prompts).toEqual(["look at the tests too"]);
    expect(ssh.clients.filter((c) => c.ended)).toEqual([]);
  });

  it("a prompt that still gets no answer is never claimed as sent: the note says Claude Code did not take it", async () => {
    const writer = {
      prompt: () => Promise.reject(new RequestTimedOutError(60)),
      sendInput: () => Promise.resolve(),
    };
    const plan = planSend("look at the tests too", { isAgent: true, kind: "claude" });
    expect(plan.kind).toBe("prompt");
    const note = await deliver(writer, "w1:p1", plan, "claude").then(
      () => null,
      (error: unknown) => (error as Error).message,
    );
    expect(note).toBe("Not sent: Claude Code did not take the message. It is still in the box.");
    expect(note).not.toMatch(/^Sent/);
  });
});
