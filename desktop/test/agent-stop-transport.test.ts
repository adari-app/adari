// The page's connection is the one the key goes on, over the real
// SshHerdrTransport, HerdrClient, HerdrTuiBackend and HostRegistry with an
// in-memory ssh2 (every SSH operation an EventEmitter) whose exec answers from
// LiveHerdr. The SSH client the page's snapshot came on closes before the
// stop: whether the registry polled on a new client first or not, the stop
// refuses with the connection-changed note and nothing is sent. The key path is
// this test file's own bytes, never a key.

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const ssh = vi.hoisted(() => ({
  clients: [] as { end(): void }[],
  herdr: null as { roundTrip(line: string): Promise<string> } | null,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    connect(): void {
      ssh.clients.push(this);
      queueMicrotask(() => this.emit("ready"));
    }
    end(): void {
      this.emit("end");
      this.emit("close");
    }
    exec(command: string, reply: (error: Error | undefined, channel: unknown) => void): void {
      const encoded = /printf '%s' '([^']+)'/.exec(command)?.[1] ?? "";
      const request = Buffer.from(encoded, "base64").toString("utf8").trim();
      const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => undefined });
      reply(undefined, channel);
      ssh.herdr!.roundTrip(request).then(
        (answer) => channel.emit("data", Buffer.from(`${answer}\n`)),
        () => channel.emit("close"),
      );
    }
  }
  return { Client };
});

import { HerdrTuiBackend } from "../src/main/herdr/backend";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { stopAgent } from "../src/main/herdr/stop";
import { HostRegistry } from "../src/main/hosts";
import { stopBindingOf } from "../src/shared/agent-stop";
import { LiveHerdr } from "./support/live-herdr";

const config = { host: "fake.invalid", port: 22, username: "fixture", privateKeyPath: fileURLToPath(import.meta.url), herdrSession: "fixture" };
const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fake.invalid", platform: null };
const opened: HostRegistry[] = [];

/** Mac mini over SSH: tab w1:t1 holds p1 (Claude, working) and p2. */
async function machine() {
  const live = new LiveHerdr();
  live.addTab("w1:t1", ["w1:p1", "w1:p2"], { "w1:p1": "claude" });
  const original = live.roundTrip.bind(live);
  ssh.herdr = {
    roundTrip: async (line: string) => {
      const request = JSON.parse(line);
      if (request.method === "agent.send_keys") {
        live.sent.push(request);
        return JSON.stringify({ id: request.id, result: {} });
      }
      const raw = JSON.parse(await original(line));
      if (request.method === "session.snapshot") {
        for (const p of raw.result.snapshot.panes) if (p.agent) p.agent_status = "working";
        for (const a of raw.result.snapshot.agents) {
          a.agent_status = "working";
          a.state_change_seq = 12;
          a.status_since_unix_ms = 1762000000000;
        }
      }
      return JSON.stringify(raw);
    },
  };
  const registry = new HostRegistry(() => undefined);
  opened.push(registry);
  registry.add(descriptor, new HerdrTuiBackend(config, new PinningHostKeyPolicy(new MemoryPinStore())));
  await registry.refreshAll();
  return { live, registry };
}

/** The stop's machine, as the IPC handler builds it. */
function site(registry: HostRegistry) {
  return {
    writer: registry.backend("mini")!,
    machine: "Mac mini",
    pane: () => registry.pane("mini", "w1:p1"),
    identity: () => {
      const identity = registry.connectionIdentity("mini");
      return identity === null ? null : { ...identity, connection: registry.connection("mini") };
    },
  };
}

afterEach(() => {
  for (const registry of opened.splice(0)) registry.close();
  ssh.clients.length = 0;
  ssh.herdr = null;
});

describe("the stop over the real transport and registry (fake ssh2 only)", () => {
  it("sends Escape on the page's own connection", async () => {
    const m = await machine();
    const binding = stopBindingOf(m.registry.list()[0]!, "w1:p1", "Claude");
    expect(await stopAgent(site(m.registry), "w1:p1", binding)).toBeNull();
    expect(m.live.mutations()).toEqual(["agent.send_keys"]);
    expect(ssh.clients).toHaveLength(1);
  });

  it.each([false, true])("after a reconnect the Esc still goes, on the connection there is now (a poll on the new client first: %s)", async (pollFirst) => {
    const m = await machine();
    const binding = stopBindingOf(m.registry.list()[0]!, "w1:p1", "Claude");
    ssh.clients[0]!.end();
    if (pollFirst) await m.registry.refresh("mini");
    expect(await stopAgent(site(m.registry), "w1:p1", binding)).toBeNull();
    expect(m.live.mutations()).toEqual(["agent.send_keys"]);
  });

  it("a close during the key keeps the captured client: no new one opened, nothing retried", async () => {
    const m = await machine();
    const binding = stopBindingOf(m.registry.list()[0]!, "w1:p1", "Claude");
    const s = site(m.registry);
    const backend = s.writer;
    const writer = {
      agentKeys: (pane: string, keys: readonly string[]) => {
        queueMicrotask(() => ssh.clients[0]!.end());
        return backend.agentKeys(pane, keys);
      },
    };
    await stopAgent({ ...s, writer }, "w1:p1", binding);
    expect(ssh.clients).toHaveLength(1);
    expect(m.live.mutations()).toEqual(["agent.send_keys"]);
  });
});
