// The connection binding follows the real SSH connection. A pane action is bound to the machine's
// incarnation in the sidebar (a new one each time it is added) and to the
// command connection its snapshot came on (SshHerdrTransport's epoch: a new
// number for every SSH client, also one that succeeds on its first request
// after the old one closed); both are checked after the fresh reads and right
// before the request. The failed-snapshot counter stays as an extra refusal.
// The real SshHerdrTransport, HerdrClient, HerdrTuiBackend and HostRegistry
// run here over an in-memory ssh2 (every SSH operation replaced by an
// EventEmitter) whose exec answers from LiveHerdr. The key path is this test
// file's own bytes, never a key.

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
import { HerdrClient } from "../src/main/herdr/client";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { SshHerdrTransport } from "../src/main/herdr/ssh";
import { HostRegistry } from "../src/main/hosts";
import { runPaneAction, type PaneActionLayouts } from "../src/main/pane-actions";
import { paneBindingOf, type PaneBinding } from "../src/shared/pane-binding";
import { LiveHerdr } from "./support/live-herdr";

const config = { host: "fake.invalid", port: 22, username: "fixture", privateKeyPath: fileURLToPath(import.meta.url), herdrSession: "fixture" };
const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fake.invalid", platform: null };
const policy = () => new PinningHostKeyPolicy(new MemoryPinStore());
const opened: HostRegistry[] = [];

/** Mac mini over SSH: tab w1:t1 holds p1 (Claude) and p2; the window shows that tab. */
async function machine() {
  const live = new LiveHerdr();
  live.addTab("w1:t1", ["w1:p1", "w1:p2"], { "w1:p1": "claude" });
  ssh.herdr = live;
  const registry = new HostRegistry(() => undefined);
  opened.push(registry);
  registry.add(descriptor, new HerdrTuiBackend(config, policy()));
  await registry.refreshAll();
  const shown = await registry.backend("mini")!.paneActions!().paneLayout("w1:p1");
  const page = { id: 10 };
  const layouts: PaneActionLayouts = {
    reread: () => Promise.resolve(),
    accept: () => undefined,
    watched: (owner) => (owner.id === page.id ? { hostId: "mini", layout: shown } : null),
  };
  /** The pane as the window shows it now. */
  const bind = (paneId: string): PaneBinding => paneBindingOf(registry.list()[0]!, shown, paneId)!;
  const close = (paneId: string, binding: PaneBinding) => runPaneAction(registry, layouts, page, "mini", { type: "close", paneId, binding });
  return { live, registry, bind, close };
}

afterEach(() => {
  for (const registry of opened.splice(0)) registry.close();
  ssh.clients.length = 0;
  ssh.herdr = null;
});

describe("a pane action is bound to the machine's real connection", () => {
  it("an idle SSH close between polls and a reconnect that succeeds on its first request: the earlier binding refuses", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    expect(ssh.clients).toHaveLength(1);
    // The peer closes between polls; the next snapshot makes a second client and succeeds (no failed snapshot).
    ssh.clients[0]!.end();
    await m.registry.refresh("mini");
    expect(ssh.clients).toHaveLength(2);
    expect(m.registry.list()[0]!.state).toBe("connected");
    await expect(m.close("w1:p1", binding)).rejects.toThrow("The machine reconnected since the pane was shown.");
    expect(m.live.mutations()).toEqual([]);
    // Bound again on the new connection, it goes.
    await m.close("w1:p1", m.bind("w1:p1"));
    expect(m.live.mutations()).toEqual(["pane.close"]);
  });

  it("the connection closes after the fresh reads: refused, nothing sent on a new connection", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    m.live.afterAnswer = (method) => {
      if (method !== "pane.layout") return;
      m.live.afterAnswer = null;
      ssh.clients.at(-1)!.end();
    };
    await expect(m.close("w1:p1", binding)).rejects.toThrow("The machine's connection closed while the pane was checked.");
    expect(m.live.mutations()).toEqual([]);
    expect(ssh.clients).toHaveLength(1);
  });

  it("a machine removed and added again: a binding from before refuses, though the new connection has the same number", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    m.registry.remove("mini");
    m.registry.add(descriptor, new HerdrTuiBackend(config, policy()));
    await m.registry.refreshAll();
    expect(m.registry.list()[0]!.epoch).toBe(binding.epoch);
    await expect(m.close("w1:p1", binding)).rejects.toThrow("The machine was removed and added again since the pane was shown.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("one failed snapshot still refuses an earlier binding though the SSH client never changed (the failed-snapshot counter kept)", async () => {
    const m = await machine();
    const binding = m.bind("w1:p1");
    m.live.offline = true;
    await m.registry.refresh("mini");
    expect(m.registry.list()[0]!.state).toBe("offline");
    m.live.offline = false;
    await m.registry.refresh("mini");
    expect(ssh.clients).toHaveLength(1);
    await expect(m.close("w1:p1", binding)).rejects.toThrow("The machine reconnected since the pane was shown.");
    expect(m.live.mutations()).toEqual([]);
  });

  it("SshHerdrTransport numbers every SSH client it opens, and holds none after a close", async () => {
    const live = new LiveHerdr();
    live.addTab("w1:t1", ["w1:p1"]);
    ssh.herdr = live;
    const transport = new SshHerdrTransport(config, policy());
    const client = new HerdrClient(transport);
    expect(transport.connectionEpoch()).toBeNull();
    await client.sessionTopology();
    expect(transport.connectionEpoch()).toBe(1);
    await client.sessionTopology();
    expect(transport.connectionEpoch()).toBe(1);
    ssh.clients[0]!.end();
    expect(transport.connectionEpoch()).toBeNull();
    await client.sessionTopology();
    expect(transport.connectionEpoch()).toBe(2);
    transport.close();
    expect(transport.connectionEpoch()).toBeNull();
    expect(ssh.clients).toHaveLength(2);
  });
});
