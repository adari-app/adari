// The relay's trip budgets (one trip per request, a send, a reply appearing,
// the sidebar by events, launch from the cache, liveness), each
// counted through a fake wire. The real SshHerdrTransport, HerdrTuiBackend,
// HostRegistry, the Send IPC handler, SshTranscriptReader and ChatFeed run
// over an in-memory ssh2 whose exec answers either as today (one exec per
// request: printf | base64 | nc, about 2 round trips) or, for the relay
// launch, as a relay that follows the contract's frames (one write and one
// reply per request: 1 round trip). Every round trip waits `rtt` ms of fake
// time, so the arithmetic is the fake's: 60 ms and 245 ms links. Nothing
// leaves the process; no SSH, no Herdr, no socket.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ssh = vi.hoisted(() => ({
  wire: null as {
    exec(command: string, reply: (error: Error | undefined, channel: unknown) => void, client: unknown): void;
    connects: number;
  } | null,
  clients: [] as { ended: boolean }[],
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    ended = false;
    connect(): void {
      ssh.clients.push(this);
      ssh.wire!.connects += 1;
      queueMicrotask(() => this.emit("ready"));
    }
    end(): void {
      if (this.ended) return;
      this.ended = true;
      this.emit("end");
      this.emit("close");
    }
    exec(command: string, reply: (error: Error | undefined, channel: unknown) => void): void {
      ssh.wire!.exec(command, reply, this);
    }
  }
  return { Client };
});

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { EventEmitter } from "node:events";

import { HerdrTuiBackend } from "../src/main/herdr/backend";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { SshHerdrTransport } from "../src/main/herdr/ssh";
import { relayHelloMs, relaySilenceMs, relayWakePingMs } from "../src/main/herdr/relay";
import { relayScript } from "../src/main/herdr/relay-script";
import { HostRegistry, sidebarBackstopMs, sidebarBurstMs } from "../src/main/hosts";
import { LaunchCache, newestItems, type CacheFiles } from "../src/main/launch-cache";
import { ChatService } from "../src/main/chat/service";
import { AgentSettingsReader } from "../src/shared/agent-settings";
import { ChatFeed, watchedBackstopMs } from "../src/shared/chat/feed";
import { IPC, type ChatUpdateEvent } from "../src/shared/ipc-contract";
import { claudePath, claudeSession, reply, session, shown, text, user, whole } from "./support/chat-lines";
import { claudeScreen } from "./support/claude-screens";
import { claudeBoxTexts } from "../src/shared/claude-screen";
import { LiveHerdr } from "./support/live-herdr";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

type Json = Record<string, unknown>;

/** The fake wire: counts round trips and delays each by `rtt` ms of fake time. */
class Wire {
  rtt = 60;
  connects = 0;
  /** Round trips spent: an exec request is 2 (channel open and exec, then its reply), a relay frame 1. */
  trips = 0;
  /** Exec requests (today's path); the relay's launch is counted apart. */
  execs = 0;
  relayLaunches = 0;
  /** What the client wrote on the relay: its frame kind, or `herdr:<method>` for a request line. */
  readonly frames: string[] = [];
  /** Herdr methods answered, on either path. */
  readonly methods: string[] = [];
  /** How the relay starts: as the contract says, never saying hello, or the exec refused (no Perl). */
  mode: "ok" | "no-hello" | "exec-fails" = "ok";
  /** The relay stops answering anything (a dead link). */
  silent = false;
  /** What `pane.read` shows: a Claude pane's screen (its box, empty by default). */
  screen = claudeScreen();
  /** agent.prompt refused once with this code. */
  refusePrompt: string | null = null;
  /** Contract v1.1: the next Herdr request on the relay answered with `{"relay":"error","code":<this>}` (expired, limit). */
  retire: string | null = null;
  /** Contract v1.1: the ids the client cancelled on the relay. */
  readonly cancelled: string[] = [];
  readonly live = new LiveHerdr();
  readonly files = new Map<string, Buffer>();
  /** A file's inode as the relay's `read` gives it (7 unless set: another file took its name). */
  readonly inodes = new Map<string, number>();
  readonly relays: FakeRelay[] = [];
  /** One-way pushes from the relay (events, grew): half a trip each. */
  pushes = 0;

  /** A mark to count from. */
  mark(): { trips: number; frames: number; methods: number; execs: number } {
    return { trips: this.trips, frames: this.frames.length, methods: this.methods.length, execs: this.execs };
  }

  since(mark: ReturnType<Wire["mark"]>) {
    return {
      trips: this.trips - mark.trips,
      frames: this.frames.slice(mark.frames),
      methods: this.methods.slice(mark.methods),
      execs: this.execs - mark.execs,
    };
  }

  /** Waits `count` round trips of fake time, then runs `work`. */
  trip(count: number, work: () => void | Promise<void>): void {
    this.trips += count;
    setTimeout(() => void work(), count * this.rtt);
  }

  exec(command: string, reply: (error: Error | undefined, channel: unknown) => void): void {
    if (command.includes("/usr/bin/perl")) {
      this.relayLaunches += 1;
      if (this.mode === "exec-fails") {
        reply(new Error("exec refused"), undefined);
        return;
      }
      const relay = new FakeRelay(this);
      this.relays.push(relay);
      reply(undefined, relay.channel);
      // The launch: one exec (about 2 round trips), then the hello.
      if (this.mode === "ok") setTimeout(() => relay.out({ relay: "hello", v: 1 }), 2 * this.rtt);
      return;
    }
    this.execs += 1;
    const encoded = /printf '%s' '([^']+)'/.exec(command)?.[1] ?? "";
    const line = Buffer.from(encoded, "base64").toString("utf8").trim();
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => undefined, write: () => true });
    reply(undefined, channel);
    this.trip(2, async () => {
      channel.emit("data", Buffer.from(`${await this.answer(line)}\n`));
    });
  }

  async answer(line: string): Promise<string> {
    const request = JSON.parse(line) as { id: string; method: string; params?: Json };
    this.methods.push(request.method);
    const ok = (result: unknown): string => JSON.stringify({ id: request.id, result });
    switch (request.method) {
      case "agent.prompt":
        if (this.refusePrompt !== null) {
          const code = this.refusePrompt;
          this.refusePrompt = null;
          return JSON.stringify({ id: request.id, error: { code, message: "refused" } });
        }
        return ok({ type: "ok" });
      case "pane.send_text":
      case "agent.send_keys":
      case "pane.send_keys":
        return ok({ type: "ok" });
      case "pane.read":
        // A Claude pane's screen with its box, empty (a box read that lets the send go).
        return ok({ type: "pane_read", read: { text: this.screen } });
      default:
        return this.live.roundTrip(line);
    }
  }

  /** Herdr sends an event on every stream (a push: half a trip). */
  event(kind: string, paneId: string): void {
    for (const relay of this.relays) relay.push(kind, paneId);
  }

  /** Contract v1.1: the transcript is cut or replaced (any size): every watch of it is told `reset`. */
  rewrite(path: string, content: string): void {
    const now = Buffer.from(content, "utf8");
    this.files.set(path, now);
    for (const relay of this.relays) relay.reset(path, now.length);
  }

  /** The transcript grows: every watch of it is pushed the new bytes. */
  grow(path: string, more: string): void {
    const before = this.files.get(path) ?? Buffer.alloc(0);
    const added = Buffer.from(more, "utf8");
    this.files.set(path, Buffer.concat([before, added]));
    for (const relay of this.relays) relay.grew(path, before.length, before.length + added.length, added);
  }
}

/** A relay as the contract describes it (frames 1-5, hello first), in memory. */
class FakeRelay {
  readonly channel: EventEmitter & { stderr: EventEmitter; write(text: string): boolean; close(): void };
  private readonly streams = new Set<string>();
  private readonly watches = new Map<string, string>();
  /** Contract v1.1: requests the client gave up on; the relay sends nothing back for them. */
  private readonly cancelled = new Set<string>();
  private closed = false;
  private partial = "";

  constructor(private readonly wire: Wire) {
    this.channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      write: (data: string): boolean => {
        this.input(data);
        return true;
      },
      close: (): void => {
        if (this.closed) return;
        this.closed = true;
        this.channel.emit("close");
      },
    });
  }

  out(frame: Json | string): void {
    if (this.closed) return;
    this.channel.emit("data", Buffer.from(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`));
  }

  private input(data: string): void {
    const lines = (this.partial + data).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim() !== "") this.frame(line);
  }

  private frame(line: string): void {
    const frame = JSON.parse(line) as Json;
    const kind = frame["relay"];
    if (kind === undefined) {
      this.wire.frames.push(`herdr:${String(frame["method"])}`);
      if (this.wire.silent) return;
      const requestId = String(frame["id"]);
      const code = this.wire.retire;
      this.wire.retire = null;
      this.wire.trip(1, async () => {
        if (code !== null) {
          this.out({ relay: "error", id: requestId, code });
          return;
        }
        const answer = await this.wire.answer(line);
        if (!this.cancelled.has(requestId)) this.out(answer);
      });
      return;
    }
    this.wire.frames.push(String(kind));
    const id = String(frame["id"]);
    if (this.wire.silent) return;
    switch (kind) {
      case "ping":
        this.wire.trip(1, () => this.out({ relay: "pong", id }));
        return;
      case "stream": {
        const request = frame["request"] as { id: string };
        this.wire.trip(1, () => {
          this.streams.add(id);
          this.out({ relay: "event", id, data: JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) });
        });
        return;
      }
      case "close":
        this.streams.delete(id);
        return;
      case "cancel":
        // Contract v1.1: it closes that request's Herdr connection and answers nothing.
        this.cancelled.add(id);
        this.wire.cancelled.push(id);
        return;
      case "read":
        this.wire.trip(1, () => {
          if (this.cancelled.has(id)) return;
          const file = this.wire.files.get(String(frame["path"]));
          if (file === undefined) {
            this.out({ relay: "gone", id });
            return;
          }
          const offset = Number(frame["offset"]);
          const data = file.subarray(offset, offset + Number(frame["max"]));
          this.out({ relay: "read", id, size: file.length, ino: this.wire.inodes.get(String(frame["path"])) ?? 7, offset, data: data.toString("base64") });
        });
        return;
      case "watch":
        this.watches.set(id, String(frame["path"]));
        return;
      case "unwatch":
        this.watches.delete(id);
        return;
    }
  }

  push(kind: string, paneId: string): void {
    for (const id of this.streams) {
      this.wire.pushes += 1;
      setTimeout(() => this.out({ relay: "event", id, data: JSON.stringify({ event: kind, data: { pane_id: paneId } }) }), this.wire.rtt / 2);
    }
  }

  reset(path: string, size: number): void {
    for (const [id, watched] of this.watches) {
      if (watched !== path) continue;
      this.wire.pushes += 1;
      setTimeout(() => this.out({ relay: "reset", id, size, ino: 8 }), this.wire.rtt / 2);
    }
  }

  grew(path: string, offset: number, size: number, data: Buffer): void {
    for (const [id, watched] of this.watches) {
      if (watched !== path) continue;
      this.wire.pushes += 1;
      setTimeout(() => this.out({ relay: "grew", id, offset, size, data: data.toString("base64") }), this.wire.rtt / 2);
    }
  }
}

const config = { host: "fake.invalid", port: 22, username: "fixture", privateKeyPath: fileURLToPath(import.meta.url), herdrSession: "fixture" };
const descriptor = { id: "mini", name: "Mac mini", kind: "ssh" as const, address: "fixture@fake.invalid:22", platform: null };
const policy = () => new PinningHostKeyPolicy(new MemoryPinStore());
const event = { senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } };
/** The test relay script: any non-empty text turns the relay on (its body is the fake's). */
const script = "# relay";

let wire: Wire;
const registries: HostRegistry[] = [];
const backends: HerdrTuiBackend[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  wire = new Wire();
  ssh.wire = wire;
  ssh.clients.length = 0;
  // Mac mini: Claude, Codex, OpenCode and a shell, one tab.
  wire.live.addTab("w1:t1", ["w1:p1", "w1:p2", "w1:p3", "w1:p4"], { "w1:p1": "claude", "w1:p2": "codex", "w1:p3": "opencode" });
});

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const backend of backends.splice(0)) backend.close();
  vi.useRealTimers();
});

function backendOf(relay: string = script, extra: { relayHelloMs?: number } = {}): HerdrTuiBackend {
  const backend = new HerdrTuiBackend(config, policy(), { relayScript: relay, ...extra });
  backends.push(backend);
  return backend;
}

/** A machine in the sidebar over the fake wire, its first snapshot in and its sidebar events live (relay on). */
/** `promise` once fake time has run on far enough for it. */
async function settled<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

async function machine(relay: string = script) {
  const backend = backendOf(relay);
  const registry = new HostRegistry(() => undefined);
  registries.push(registry);
  registry.add(descriptor, backend);
  await vi.advanceTimersByTimeAsync(1_000);
  return { backend, registry };
}

const binding = (paneId: string, kind: string | null) => ({
  terminalID: `term-${paneId}`,
  isAgent: kind !== null,
  kind,
  session: kind === null ? null : `session-${paneId}`,
});

/** The Send IPC handler on `registry`, as the window calls it; resolves once the send settled. */
async function send(registry: HostRegistry, paneId: string, message: string, kind: string | null): Promise<void> {
  registerIpc({ hosts: registry } as never);
  const handler = registered.handles.get(IPC.paneSend)!;
  const done = handler(event, "mini", paneId, message, binding(paneId, kind)) as Promise<void>;
  let failure: unknown = null;
  done.catch((error: unknown) => {
    failure = error;
  });
  await vi.advanceTimersByTimeAsync(2_000);
  if (failure !== null) throw failure;
  await done;
}

async function stop(registry: HostRegistry, paneId: string): Promise<void> {
  registerIpc({ hosts: registry } as never);
  const handler = registered.handles.get(IPC.paneStop)!;
  const identity = registry.connectionIdentity("mini")!;
  const done = handler(event, "mini", paneId, {
    terminalID: `term-${paneId}`,
    kind: "claude",
    session: `session-${paneId}`,
    episode: { status: "working", seq: "1", since: "1" },
    incarnation: identity.incarnation,
    connection: registry.connection("mini"),
    epoch: identity.epoch,
    name: "Claude",
  });
  await vi.advanceTimersByTimeAsync(2_000);
  await done;
}

describe("one request on the relay is one trip", () => {
  it("writes the request line once and reads its one reply (1 trip; the exec path takes 2)", async () => {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script });
    const first = transport.roundTrip(JSON.stringify({ id: "a:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(wire.relayLaunches).toBe(1);
    const mark = wire.mark();
    let answered = false;
    const reply = transport.roundTrip(JSON.stringify({ id: "a:2", method: "session.snapshot", params: {} })).then((line) => {
      answered = true;
      return line;
    });
    await vi.advanceTimersByTimeAsync(wire.rtt - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBe(true);
    expect(JSON.parse(await reply)).toMatchObject({ id: "a:2", result: { type: "session_snapshot" } });
    expect(wire.since(mark)).toEqual({ trips: 1, frames: ["herdr:session.snapshot"], methods: ["session.snapshot"], execs: 0 });
    transport.close();
  });

  it("pipelines: three requests written at once all answer within one trip, matched by id", async () => {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script });
    const warm = transport.roundTrip(JSON.stringify({ id: "w:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await warm;
    const lines = ["x:1", "x:2", "x:3"].map((id) => transport.roundTrip(JSON.stringify({ id, method: "agent.list", params: {} })));
    await vi.advanceTimersByTimeAsync(wire.rtt);
    const replies = await Promise.all(lines);
    expect(replies.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["x:1", "x:2", "x:3"]);
    transport.close();
  });

  it("a deadline passing fails that request only; the relay and its connection stay", async () => {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script, roundTripTimeoutMs: 1_000 });
    const warm = transport.roundTrip(JSON.stringify({ id: "w:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await warm;
    const epoch = transport.connectionEpoch();
    wire.rtt = 5_000;
    const slow = transport.roundTrip(JSON.stringify({ id: "s:1", method: "agent.list", params: {} }));
    const caught = slow.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await caught).toBe("the host did not answer within 1 seconds");
    expect(transport.connectionEpoch()).toBe(epoch);
    wire.rtt = 60;
    const next = transport.roundTrip(JSON.stringify({ id: "s:2", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(60);
    expect(JSON.parse(await next)).toMatchObject({ id: "s:2" });
    expect(wire.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    transport.close();
  });
});

describe("contract v1.1 (cancel and retire on the relay)", () => {
  async function warmTransport(timeoutMs = 1_000): Promise<SshHerdrTransport> {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script, roundTripTimeoutMs: timeoutMs });
    const warm = transport.roundTrip(JSON.stringify({ id: "w:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await warm;
    return transport;
  }

  it("a deadline passing sends cancel for that request; the relay answers nothing for it, and the next request answers", async () => {
    const transport = await warmTransport();
    const epoch = transport.connectionEpoch();
    wire.rtt = 5_000;
    const mark = wire.mark();
    const caught = transport.roundTrip(JSON.stringify({ id: "c:1", method: "agent.list", params: {} })).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await caught).toBe("the host did not answer within 1 seconds");
    expect(wire.since(mark).frames).toEqual(["herdr:agent.list", "cancel"]);
    // The cancel names the request's own wire id (the caller's id and a serial).
    expect(wire.cancelled).toHaveLength(1);
    expect(wire.cancelled[0]).toMatch(/^c:1#r\d+$/);
    // The late answer never comes (the relay closed that Herdr connection), and nothing is torn down.
    await vi.advanceTimersByTimeAsync(5_000);
    wire.rtt = 60;
    const next = transport.roundTrip(JSON.stringify({ id: "c:2", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(60);
    expect(JSON.parse(await next)).toMatchObject({ id: "c:2" });
    expect(transport.connectionEpoch()).toBe(epoch);
    expect(wire.connects).toBe(1);
    transport.close();
  });

  it("an answered request sends no cancel", async () => {
    const transport = await warmTransport();
    const mark = wire.mark();
    const answer = transport.roundTrip(JSON.stringify({ id: "n:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(2_000);
    await answer;
    expect(wire.since(mark).frames.filter((frame) => frame !== "ping")).toEqual(["herdr:agent.list"]);
    expect(wire.cancelled).toEqual([]);
    transport.close();
  });

  it.each(["expired", "limit"])("a relay error %s fails that request as a lost reply; the relay and its connection stay", async (code) => {
    const transport = await warmTransport();
    const epoch = transport.connectionEpoch();
    wire.retire = code;
    const caught = transport.roundTrip(JSON.stringify({ id: "e:1", method: "agent.list", params: {} })).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(wire.rtt);
    expect(await caught).toBe("peer closed before sending a response line");
    const next = transport.roundTrip(JSON.stringify({ id: "e:2", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(wire.rtt);
    expect(JSON.parse(await next)).toMatchObject({ id: "e:2" });
    expect(transport.connectionEpoch()).toBe(epoch);
    expect(wire.relayLaunches).toBe(1);
    transport.close();
  });

  it("relay frames of a kind it does not know are ignored", async () => {
    const transport = await warmTransport();
    const epoch = transport.connectionEpoch();
    const relay = wire.relays[0]!;
    const pending = transport.roundTrip(JSON.stringify({ id: "u:1", method: "agent.list", params: {} }));
    relay.out({ relay: "stats", id: "u:1", open: 3 });
    relay.out({ relay: "later-kind" });
    relay.out({ id: "u:1", relay: "notice", data: "x" });
    await vi.advanceTimersByTimeAsync(wire.rtt);
    expect(JSON.parse(await pending)).toMatchObject({ id: "u:1", result: {} });
    expect(transport.connectionEpoch()).toBe(epoch);
    expect(wire.relayLaunches).toBe(1);
    transport.close();
  });

  it("a reset while still catching up on a watched transcript reads it again from its start (cut or replaced by a longer one)", async () => {
    const backend = backendOf();
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from(text([user("hello", "u1", 1), reply("Working on it.", "a1", 2)])));
    const reader = backend.transcripts();
    (reader as unknown as { locate: () => Promise<string> }).locate = async () => claudePath;
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it."]);
    // Growth pushed, and in the same moment the file replaced by a longer one: the reset comes before the
    // follow took the pushed bytes, so what was held is stale.
    wire.grow(claudePath, text([reply("Done.", "a2", 3, true)]));
    const replaced = "A new transcript in its place, longer than the old one and its growth together. ".repeat(4).trim();
    wire.rewrite(claudePath, text([user("again", "u9", 9), reply(replaced, "a9", 10, true)]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(shown(feed.timeline)).toEqual(["user:again", `agent:${replaced}`]);
    // It watches the new file again from its end.
    expect(wire.frames.filter((frame) => frame === "watch").length).toBeGreaterThanOrEqual(2);
    feed.stop();
  });
});

describe("a send", () => {
  it("Claude: exactly one request before the agent has it (agent.prompt), no box read, no snapshot", async () => {
    const { registry } = await machine();
    expect(registry.eventsLive("mini")).toBe(true);
    const mark = wire.mark();
    await send(registry, "w1:p1", "hello", "claude");
    expect(wire.since(mark).methods).toEqual(["agent.prompt"]);
    expect(wire.since(mark).trips).toBe(1);
  });

  it("Codex: exactly one request (agent.prompt)", async () => {
    const { registry } = await machine();
    const mark = wire.mark();
    await send(registry, "w1:p2", "hello", "codex");
    expect(wire.since(mark).methods).toEqual(["agent.prompt"]);
  });

  it("Claude after a Stop: one box read, then the prompt; the next send none again", async () => {
    const { registry } = await machine();
    await stop(registry, "w1:p1");
    const mark = wire.mark();
    await send(registry, "w1:p1", "again", "claude");
    expect(wire.since(mark).methods).toEqual(["pane.read", "agent.prompt"]);
    const next = wire.mark();
    await send(registry, "w1:p1", "and again", "claude");
    expect(wire.since(next).methods).toEqual(["agent.prompt"]);
  });

  // Through the real due state (the Stop's mark, the send's check): a refused clear stays due.
  it("Claude after a Stop whose box keeps our message through both clears: refused, and the retry reads and refuses again", async () => {
    const { registry } = await machine();
    await send(registry, "w1:p1", "the old message", "claude");
    await stop(registry, "w1:p1");
    // Our old message is back in Claude's box and stays there through both clearing attempts.
    wire.screen = claudeScreen({ draft: "the old message" });
    const mark = wire.mark();
    await expect(send(registry, "w1:p1", "next", "claude")).rejects.toThrow(claudeBoxTexts.notSentStillHasText);
    expect(wire.since(mark).methods.filter((method) => method === "pane.read").length).toBeGreaterThanOrEqual(3);
    const retry = wire.mark();
    await expect(send(registry, "w1:p1", "next", "claude")).rejects.toThrow(claudeBoxTexts.notSentStillHasText);
    expect(wire.since(retry).methods.filter((method) => method === "pane.read").length).toBeGreaterThanOrEqual(3);
    expect(wire.since(mark).methods).not.toContain("agent.prompt");
    // Once the box is clear, the next send reads it, goes, and the check is retired.
    wire.screen = claudeScreen();
    const clear = wire.mark();
    await send(registry, "w1:p1", "next", "claude");
    expect(wire.since(clear).methods).toEqual(["pane.read", "agent.prompt"]);
    const after = wire.mark();
    await send(registry, "w1:p1", "and again", "claude");
    expect(wire.since(after).methods).toEqual(["agent.prompt"]);
  });

  it("Claude after a failed send: one box read before the next", async () => {
    const { registry } = await machine();
    wire.refusePrompt = "agent_not_ready";
    await expect(send(registry, "w1:p1", "hello", "claude")).rejects.toThrow("Not sent: the agent is not ready for a message yet. The text is kept.");
    const mark = wire.mark();
    await send(registry, "w1:p1", "hello", "claude");
    expect(wire.since(mark).methods).toEqual(["pane.read", "agent.prompt"]);
  });

  it("another agent: send_text then send_keys, two requests, no second check", async () => {
    const { registry } = await machine();
    const mark = wire.mark();
    await send(registry, "w1:p3", "hello", "opencode");
    expect(wire.since(mark).methods).toEqual(["pane.send_text", "agent.send_keys"]);
    expect(wire.since(mark).trips).toBe(2);
  });

  it("a shell: one send_input", async () => {
    const { registry } = await machine();
    const mark = wire.mark();
    await send(registry, "w1:p4", "ls", null);
    expect(wire.since(mark).methods).toEqual(["pane.send_input"]);
  });

  it("checks on a fresh snapshot first when the latest is over 10 s old or the events are down", async () => {
    const { registry } = await machine();
    await vi.advanceTimersByTimeAsync(10_000);
    const mark = wire.mark();
    await send(registry, "w1:p2", "hello", "codex");
    expect(wire.since(mark).methods).toEqual(["session.snapshot", "agent.prompt"]);
  });

  it("relay off (today's path): a fresh snapshot, then the prompt, each an exec", async () => {
    const { registry } = await machine("");
    expect(registry.eventsLive("mini")).toBe(false);
    const mark = wire.mark();
    await send(registry, "w1:p2", "hello", "codex");
    const spent = wire.since(mark);
    // The send's two requests before the agent has it; the refresh after it (no events) is the third.
    expect(spent.methods.slice(0, 2)).toEqual(["session.snapshot", "agent.prompt"]);
    expect(spent.execs).toBe(spent.methods.length);
  });
});

describe("a reply appearing", () => {
  it("a watched transcript's grew reaches the timeline with no read; the poll is a 10 s backstop", async () => {
    const backend = backendOf();
    // The command connection (and its relay) is up.
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from(text([user("hello", "u1", 1), reply("Working on it.", "a1", 2)])));
    const reader = backend.transcripts();
    (reader as unknown as { locate: () => Promise<string> }).locate = async () => claudePath;
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it."]);
    expect(wire.frames.filter((frame) => frame === "watch")).toHaveLength(1);
    const mark = wire.mark();
    // The relay's own 5 s pings aside, what the client writes for the transcript.
    const reads = (): string[] => wire.since(mark).frames.filter((frame) => frame !== "ping");
    wire.grow(claudePath, text([reply("Done.", "a2", 3, true)]));
    // Within the push (half a trip) and the follow's own work.
    await vi.advanceTimersByTimeAsync(wire.rtt / 2 + 1);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it.", "agent:Done."]);
    expect(reads()).toEqual([]);
    // No 1 s poll while the watch is live: the backstop's one size read comes at 10 s.
    await vi.advanceTimersByTimeAsync(watchedBackstopMs - 1_000);
    expect(reads()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000 + wire.rtt);
    expect(reads()).toEqual(["read"]);
    feed.stop();
  });

  it("a read the push does not cover is one read frame (SFTP's stat, open, read and close are about 4)", async () => {
    const backend = backendOf();
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from("0123456789"));
    const mark = wire.mark();
    const reading = backend.transcripts().read(claudePath, 2, 4);
    await vi.advanceTimersByTimeAsync(wire.rtt);
    expect(Buffer.from(await reading).toString()).toBe("2345");
    expect(wire.since(mark)).toMatchObject({ trips: 1, frames: ["read"] });
  });

  // One frame, where a separate size read (max 0) and a bytes read would take 2.
  it("the backstop's poll the push does not cover is one read frame (size, inode and bytes together)", async () => {
    const backend = backendOf();
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from(text([user("hello", "u1", 1), reply("Working on it.", "a1", 2)])));
    const reader = backend.transcripts();
    (reader as unknown as { locate: () => Promise<string> }).locate = async () => claudePath;
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it."]);
    // The first backstop finds nothing new: one read frame.
    await vi.advanceTimersByTimeAsync(watchedBackstopMs + wire.rtt);
    const mark = wire.mark();
    const reads = (): string[] => wire.since(mark).frames.filter((frame) => frame !== "ping");
    // The file grows without a push (a missed grew): the backstop's one frame brings it.
    wire.files.set(claudePath, Buffer.concat([wire.files.get(claudePath)!, Buffer.from(text([reply("Done.", "a2", 3, true)]))]));
    await vi.advanceTimersByTimeAsync(watchedBackstopMs + wire.rtt);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it.", "agent:Done."]);
    expect(reads()).toEqual(["read"]);
    feed.stop();
  });

  it("the backstop's read finding another file under the name (its inode changed) reads it from its start", async () => {
    const backend = backendOf();
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from(text([user("hello", "u1", 1), reply("Working on it.", "a1", 2)])));
    const reader = backend.transcripts();
    (reader as unknown as { locate: () => Promise<string> }).locate = async () => claudePath;
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(1_000);
    // One backstop learns the inode.
    await vi.advanceTimersByTimeAsync(watchedBackstopMs + wire.rtt);
    // Replaced by a longer file, no push: the next backstop's read sees the new inode and starts over.
    wire.files.set(claudePath, Buffer.from(text([user("again from the top", "u9", 1), reply("A new file, longer than the old one.", "a9", 2)])));
    wire.inodes.set(claudePath, 8);
    await vi.advanceTimersByTimeAsync(watchedBackstopMs + 2 * wire.rtt);
    expect(shown(feed.timeline)).toEqual(["user:again from the top", "agent:A new file, longer than the old one."]);
    feed.stop();
  });

  // The inode comes with the load's own read, so a file replaced
  // before the first uncovered poll is not taken for an append (no watch, no backstop to learn it first).
  const replacedBeforeFirstPoll = async (replacement: string, expected: string[]): Promise<void> => {
    const backend = backendOf();
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from(text([user("hello", "u1", 1), reply("Working on it.", "a1", 2)])));
    const reader = backend.transcripts();
    (reader as unknown as { locate: () => Promise<string> }).locate = async () => claudePath;
    (reader as unknown as { watch: () => Promise<null> }).watch = async () => null;
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(500);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it."]);
    wire.files.set(claudePath, Buffer.from(replacement));
    wire.inodes.set(claudePath, 8);
    await vi.advanceTimersByTimeAsync(1_000 + 2 * wire.rtt);
    expect(shown(feed.timeline)).toEqual(expected);
    feed.stop();
  };

  it("a file replaced by a longer one before the first uncovered poll (no watch) is read from its start", async () => {
    await replacedBeforeFirstPoll(text([user("again from the top", "u9", 1), reply("A new file, longer than the old one.", "a9", 2)]), [
      "user:again from the top",
      "agent:A new file, longer than the old one.",
    ]);
  });

  it("a file replaced by a shorter one before the first uncovered poll (no watch) is read from its start", async () => {
    await replacedBeforeFirstPoll(text([user("short", "u9", 1)]), ["user:short"]);
  });

  it("the load's read gives the inode: the first uncovered poll of an unchanged file is one read frame, no reload", async () => {
    const backend = backendOf();
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from(text([user("hello", "u1", 1), reply("Working on it.", "a1", 2)])));
    const reader = backend.transcripts();
    (reader as unknown as { locate: () => Promise<string> }).locate = async () => claudePath;
    (reader as unknown as { watch: () => Promise<null> }).watch = async () => null;
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(500);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it."]);
    const mark = wire.mark();
    await vi.advanceTimersByTimeAsync(1_000 + 2 * wire.rtt);
    expect(wire.since(mark).frames.filter((frame) => frame !== "ping")).toEqual(["read"]);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it."]);
    feed.stop();
  });

  it("a load whose read gave no inode (relay not up for it) is not the baseline: the first combined poll reads from the start", async () => {
    const backend = backendOf();
    await settled(backend.snapshot());
    wire.files.set(claudePath, Buffer.from(text([user("hello", "u1", 1), reply("Working on it.", "a1", 2)])));
    const reader = backend.transcripts();
    const stub = reader as unknown as {
      locate: () => Promise<string>;
      watch: () => Promise<null>;
      readWithIdentity: (path: string, offset: number, max: number) => Promise<unknown>;
    };
    stub.locate = async () => claudePath;
    stub.watch = async () => null;
    // The load's read has no identity (as before the relay is up); every later one has.
    const identityRead = stub.readWithIdentity.bind(reader);
    let identityReads = 0;
    stub.readWithIdentity = async (path, offset, max) => (identityReads++ === 0 ? null : identityRead(path, offset, max));
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(500);
    expect(shown(feed.timeline)).toEqual(["user:hello", "agent:Working on it."]);
    wire.files.set(claudePath, Buffer.from(text([user("again from the top", "u9", 1), reply("A new file, longer than the old one.", "a9", 2)])));
    wire.inodes.set(claudePath, 8);
    await vi.advanceTimersByTimeAsync(1_000 + 2 * wire.rtt);
    expect(shown(feed.timeline)).toEqual(["user:again from the top", "agent:A new file, longer than the old one."]);
    feed.stop();
  });
});

// The Mac's own Chat path. ChatService hands ChatFeed its reader
// wrapped in WarmingReader and then the chips' tapReader; both now pass the read with identity on, so the
// one-frame poll and the replaced-file check run in the app as they do on the bare reader above.
describe("ChatService's reader chain keeps the read with identity", () => {
  // Claude's pane in the fake Herdr is in /fixture; its transcript says so (the feed checks the folder).
  const here = { cwd: "/fixture" };
  const original = (): string => text([user("hello", "u1", 1, here), reply("Working on it.", "a1", 2)]);

  /** Chat on Claude's pane through ChatService over the fake wire (relay up), no watch; loaded by 500 ms. */
  async function openChat() {
    // Claude's pane names the transcript's own session.
    wire.live.panes.get("w1:p1")!.session = session;
    const { backend, registry } = await machine();
    wire.files.set(claudePath, Buffer.from(original()));
    const reader = backend.transcripts();
    const stub = reader as unknown as { locate: () => Promise<string>; watch: () => Promise<null>; size: (path: string) => Promise<number> };
    stub.locate = async () => claudePath;
    stub.watch = async () => null;
    // The size asked on its own (the poll without identity asks it, then reads).
    const size = stub.size.bind(reader);
    let sizes = 0;
    stub.size = (path) => ((sizes += 1), size(path));
    const service = new ChatService(registry, "chat", { pollIntervalMs: 1_000 });
    const updates: ChatUpdateEvent[] = [];
    service.open({ id: 1, send: (_channel: string, payload: never) => updates.push(payload), isDestroyed: () => false }, "mini", "w1:p1");
    await vi.advanceTimersByTimeAsync(500);
    const timeline = (): string[] => shown(updates.at(-1)!.timeline);
    expect(timeline()).toEqual(["user:hello", "agent:Working on it."]);
    return { service, timeline, sizes: () => sizes };
  }

  it("relay up: the first uncovered poll of an unchanged file is one read frame (no size of its own); a growth comes in one frame too", async () => {
    const chat = await openChat();
    let mark = wire.mark();
    const sizes = chat.sizes();
    const reads = (): string[] => wire.since(mark).frames.filter((frame) => frame !== "ping");
    await vi.advanceTimersByTimeAsync(1_000 + 2 * wire.rtt);
    expect(reads()).toEqual(["read"]);
    expect(chat.sizes()).toBe(sizes);
    expect(chat.timeline()).toEqual(["user:hello", "agent:Working on it."]);
    // The file grows (no watch): the next poll's one frame brings the reply.
    mark = wire.mark();
    wire.files.set(claudePath, Buffer.concat([wire.files.get(claudePath)!, Buffer.from(text([reply("Done.", "a2", 3, true)]))]));
    await vi.advanceTimersByTimeAsync(1_000 + 2 * wire.rtt);
    expect(chat.timeline()).toEqual(["user:hello", "agent:Working on it.", "agent:Done."]);
    expect(reads()).toEqual(["read"]);
    expect(chat.sizes()).toBe(sizes);
    chat.service.closeAll();
  });

  it("a file replaced by a longer one before the first uncovered poll (no watch) shows only the new file, from its start", async () => {
    const chat = await openChat();
    wire.files.set(claudePath, Buffer.from(text([user("again from the top", "u9", 1, here), reply("A new file, longer than the old one.", "a9", 2)])));
    wire.inodes.set(claudePath, 8);
    await vi.advanceTimersByTimeAsync(1_000 + 2 * wire.rtt);
    expect(chat.timeline()).toEqual(["user:again from the top", "agent:A new file, longer than the old one."]);
    chat.service.closeAll();
  });
});

// The chips read what Chat reads through the same chain.
describe("the chips' tap on the read with identity, through ChatService", () => {
  const here = { cwd: "/fixture" };
  /** A Claude reply naming its model (effort high). */
  const withModel = (body: string, id: string, second: number, model: string): string => {
    const line = JSON.parse(reply(body, id, second, true)) as { effort?: string; message: { model?: string } };
    line.message.model = model;
    line.effort = "high";
    return JSON.stringify(line);
  };

  async function openChat(content: string, alter?: (reader: { [name: string]: unknown }) => void, watched = false) {
    wire.live.panes.get("w1:p1")!.session = session;
    const { backend, registry } = await machine();
    wire.files.set(claudePath, Buffer.from(content));
    const reader = backend.transcripts() as unknown as { [name: string]: unknown };
    reader["locate"] = async () => claudePath;
    if (!watched) reader["watch"] = async () => null;
    alter?.(reader);
    const service = new ChatService(registry, "chat", { pollIntervalMs: 1_000 });
    const updates: ChatUpdateEvent[] = [];
    service.open({ id: 1, send: (_channel: string, payload: never) => updates.push(payload), isDestroyed: () => false }, "mini", "w1:p1");
    await vi.advanceTimersByTimeAsync(500);
    expect(shown(updates.at(-1)!.timeline)).toEqual(shown(whole(content)));
    return { service, updates, timeline: () => shown(updates.at(-1)!.timeline), chips: () => updates.at(-1)!.settings };
  }

  /** The reader's read with identity, wrapped. */
  const wrapIdentity = (
    reader: { [name: string]: unknown },
    wrap: (read: (path: string, offset: number, max: number) => Promise<unknown>) => (path: string, offset: number, max: number) => Promise<unknown>,
  ): void => {
    const read = (reader["readWithIdentity"] as (path: string, offset: number, max: number) => Promise<unknown>).bind(reader);
    reader["readWithIdentity"] = wrap(read);
  };

  it("a watch's reset overtaking a read with identity: no null chips, one reset, the reread says the new model", async () => {
    const before = text([user("hello", "u1", 1, here), withModel("old", "a1", 2, "claude-opus-5-5")]);
    let armed = false;
    let held = false;
    let release: () => void = () => undefined;
    const chat = await openChat(
      before,
      (reader) =>
        wrapIdentity(reader, (read) => async (path, offset, max) => {
          const answer = await read(path, offset, max);
          // The backstop's poll past the old end: its reply (the old inode, a line grown) is held.
          if (armed && !held && offset === Buffer.byteLength(before)) {
            held = true;
            await new Promise<void>((resolve) => (release = resolve));
          }
          return answer;
        }),
      true,
    );
    try {
      expect(chat.chips()?.model).toBe("claude-opus-5-5");
      expect(wire.frames).toContain("watch");
      wire.files.set(claudePath, Buffer.from(before + text([user("old file grew", "uo", 3, here)])));
      armed = true;
      await vi.advanceTimersByTimeAsync(watchedBackstopMs + 1_000);
      expect(held).toBe(true);
      const resets = vi.spyOn(AgentSettingsReader.prototype, "reset");
      const mark = chat.updates.length;
      wire.inodes.set(claudePath, 8);
      wire.rewrite(claudePath, text([user("new question", "u9", 1, here), withModel("new", "a9", 2, "claude-sonnet-5-5")]));
      await vi.advanceTimersByTimeAsync(wire.rtt / 2 + 1);
      release();
      await vi.advanceTimersByTimeAsync(500);
      expect(chat.timeline()).toEqual(["user:new question", "agent:new"]);
      expect(chat.updates.slice(mark).map((update) => update.settings?.model)).not.toContain(null);
      expect(resets).toHaveBeenCalledTimes(1);
      expect(chat.chips()?.model).toBe("claude-sonnet-5-5");
      resets.mockRestore();
    } finally {
      chat.service.closeAll();
    }
  });

  it.each([
    ["inside the 1 MiB poll window (control)", 0],
    ["past the 1 MiB poll window", 1_100_000],
  ])("a line naming another model, written during the replacement's reread (%s), reaches the chips as Chat", async (_label, long) => {
    const before = text([user("hello", "u1", 1, here), withModel("old", "a1", 2, "claude-opus-5-5")]);
    let armed = false;
    let grew = false;
    let reads = 0;
    const chat = await openChat(before, (reader) =>
      wrapIdentity(reader, (read) => async (path, offset, max) => {
        if (armed) reads += 1;
        // Between the poll that finds the replacement and its reread from the start.
        if (armed && !grew && reads === 2) {
          grew = true;
          wire.files.set(claudePath, Buffer.concat([wire.files.get(claudePath)!, Buffer.from(text([withModel("grew during reread", "a8", 5, "claude-haiku-5-5")]))]));
        }
        return read(path, offset, max);
      }),
    );
    try {
      const replacement = text([withModel("new", "a9", 3, "claude-sonnet-5-5"), user("x".repeat(long === 0 ? Buffer.byteLength(before) : long), "u9", 4, here)]);
      wire.files.set(claudePath, Buffer.from(replacement));
      wire.inodes.set(claudePath, 8);
      armed = true;
      await vi.advanceTimersByTimeAsync(1_300);
      expect(grew).toBe(true);
      expect(chat.timeline()).toContain("agent:grew during reread");
      expect(chat.chips()?.model).toBe("claude-haiku-5-5");
      wire.files.set(claudePath, Buffer.concat([wire.files.get(claudePath)!, Buffer.from(text([withModel("next", "aa", 6, "claude-fable-5-1")]))]));
      await vi.advanceTimersByTimeAsync(1_300);
      expect(chat.timeline()).toContain("agent:next");
      expect(chat.chips()?.model).toBe("claude-fable-5-1");
    } finally {
      chat.service.closeAll();
    }
  });

  it("an empty Grok transcript (relay up) still reads summary.json and signals.json: the chips and the ring fill in", async () => {
    wire.live.panes.get("w1:p1")!.agent = "grok";
    wire.live.panes.get("w1:p1")!.session = session;
    const { backend, registry } = await machine();
    const path = `/fixture/.grok/sessions/x/${session}/updates.jsonl`;
    wire.files.set(path, Buffer.alloc(0));
    wire.files.set(path.replace("updates.jsonl", "summary.json"), Buffer.from(JSON.stringify({ info: { cwd: "/fixture" }, current_model_id: "grok-4.6", reasoning_effort: "high" })));
    wire.files.set(path.replace("updates.jsonl", "signals.json"), Buffer.from(JSON.stringify({ contextTokensUsed: 1800, contextWindowTokens: 256000 })));
    const reader = backend.transcripts() as unknown as { [name: string]: unknown };
    reader["locate"] = async () => path;
    reader["watch"] = async () => null;
    let identityReads = 0;
    wrapIdentity(reader, (read) => async (file, offset, max) => ((identityReads += 1), read(file, offset, max)));
    const service = new ChatService(registry, "chat", { pollIntervalMs: 1_000 });
    const updates: ChatUpdateEvent[] = [];
    try {
      service.open({ id: 1, send: (_channel: string, payload: never) => updates.push(payload), isDestroyed: () => false }, "mini", "w1:p1");
      await vi.advanceTimersByTimeAsync(500);
      expect(identityReads).toBeGreaterThan(0);
      expect(updates.at(-1)!.state.status).toBe("live");
      expect(updates.at(-1)!.settings).toMatchObject({ model: "grok-4.6", effort: "high", used: 1800, window: 256000 });
      // Later idle polls read no Grok files of their own (the throttle's 10 s apart, nothing pending).
      const mark = wire.mark();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(wire.since(mark).frames.filter((frame) => frame !== "ping")).toEqual(["read", "read", "read"]);
    } finally {
      service.closeAll();
    }
  });

  it("a load without identity, then a replacement before the first poll: the feed's start-over starts the chips over (the new file's model)", async () => {
    const before = text([user("padding".repeat(50), "u1", 1, here), withModel("old", "a1", 2, "claude-opus-5-5")]);
    const chat = await openChat(before, (reader) => {
      let first = true;
      // The load's read has no identity (as before the relay is up); every later one has.
      wrapIdentity(reader, (read) => async (path, offset, max) => {
        if (first) {
          first = false;
          return null;
        }
        return read(path, offset, max);
      });
    });
    try {
      expect(chat.chips()?.model).toBe("claude-opus-5-5");
      const after = text([withModel("new", "a9", 3, "claude-sonnet-5-5"), user("x".repeat(Buffer.byteLength(before)), "u9", 4, here)]);
      wire.files.set(claudePath, Buffer.from(after));
      wire.inodes.set(claudePath, 8);
      await vi.advanceTimersByTimeAsync(1_300);
      expect(chat.timeline()).toEqual(shown(whole(after)));
      expect(chat.chips()?.model).toBe("claude-sonnet-5-5");
    } finally {
      chat.service.closeAll();
    }
  });

  // The combined poll after a load without identity is thrown
  // away by the feed (it starts over); the chips hear nothing of it, and the held reread says the new model once.
  it.each([
    { label: "(a) a replacement after a load without identity", noIdentity: true, replacement: true },
    { label: "(b) an ordinary append after a load without identity", noIdentity: true, replacement: false },
    { label: "(c) a replacement with the inode known (control)", noIdentity: false, replacement: true },
  ])("$label, its reread held: never null chips, then the latest model", async ({ noIdentity, replacement }) => {
    const before = text([user("padding".repeat(80), "u1", 1, here), withModel("old", "a1", 2, "claude-opus-5-5")]);
    let first = true;
    let armed = false;
    let reads = 0;
    let held = false;
    let release: () => void = () => undefined;
    const chat = await openChat(before, (reader) =>
      wrapIdentity(reader, (read) => async (path, offset, max) => {
        if (first) {
          first = false;
          // The load's read: none (relay not up for it) in (a) and (b).
          if (noIdentity) return null;
        }
        // The poll answers; the reread from the start after it is held.
        if (armed && ++reads === 2) {
          held = true;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return read(path, offset, max);
      }),
    );
    try {
      expect(chat.chips()?.model).toBe("claude-opus-5-5");
      const loaded = chat.timeline();
      const prefix = text([withModel("earlier", "e1", 3, "claude-haiku-5-5")]);
      const added = text([withModel("latest", "l1", 4, "claude-sonnet-5-5")]);
      const after = replacement ? prefix + "\n".repeat(Buffer.byteLength(before) - Buffer.byteLength(prefix)) + added : before + added;
      wire.files.set(claudePath, Buffer.from(after));
      if (replacement) wire.inodes.set(claudePath, 8);
      const mark = chat.updates.length;
      armed = true;
      await vi.advanceTimersByTimeAsync(1_300);
      expect(held).toBe(true);
      expect(chat.timeline()).toEqual(loaded);
      const interim = chat.updates.slice(mark).map((update) => update.settings?.model);
      expect(interim).not.toContain(null);
      // The poll that started over said nothing: no update while the reread is out.
      expect(interim).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(500);
      expect(chat.timeline()).toEqual(shown(whole(after)));
      expect(chat.chips()?.model).toBe("claude-sonnet-5-5");
      expect(chat.updates.slice(mark).map((update) => update.settings?.model)).not.toContain(null);
    } finally {
      release();
      chat.service.closeAll();
    }
  });

  it("(d) a catch-up read with identity after a load without it is kept: the chips read it at once", async () => {
    const head = text([user("padding".repeat(80), "u1", 1, here), withModel("old", "a1", 2, "claude-opus-5-5")]);
    const content = head + text([withModel("caught up", "a2", 3, "claude-sonnet-5-5")]);
    let identityReads = 0;
    const chat = await openChat(content, (reader) => {
      wrapIdentity(reader, (read) => async (path, offset, max) => {
        // The load's read has none; the catch-up's has.
        if (identityReads++ === 0) return null;
        return read(path, offset, max);
      });
      // The load's plain read comes back short (up to the Opus line): the feed catches up at once.
      const plain = (reader["read"] as (path: string, offset: number, max: number) => Promise<Uint8Array>).bind(reader);
      let plainReads = 0;
      reader["read"] = async (path: string, offset: number, max: number) =>
        plainReads++ === 0 ? plain(path, offset, Math.min(max, Buffer.byteLength(head) - offset)) : plain(path, offset, max);
    });
    try {
      // Before the first 1 s poll: the catch-up was a read with identity, kept, and its model reached the chips.
      expect(identityReads).toBe(2);
      expect(chat.chips()?.model).toBe("claude-sonnet-5-5");
      // From the load's Opus on (the first update is the loading one, before any read), never null.
      const models = chat.updates.map((update) => update.settings?.model);
      expect(models.slice(models.indexOf("claude-opus-5-5"))).not.toContain(null);
    } finally {
      chat.service.closeAll();
    }
  });
});

describe("cold launch without the extra trip", () => {
  it("relay on: the first snapshot goes on the exec path beside the relay's launch (2 trips, as relay off); later requests ride the relay", async () => {
    const timed = async (relay: string): Promise<{ ms: number; transport: SshHerdrTransport }> => {
      const transport = new SshHerdrTransport(config, policy(), { relayScript: relay });
      const began = Date.now();
      let answeredAt: number | null = null;
      const first = transport.roundTrip(JSON.stringify({ id: "c:1", method: "session.snapshot", params: {} })).then((line) => {
        answeredAt = Date.now();
        return line;
      });
      await vi.advanceTimersByTimeAsync(5 * wire.rtt);
      expect(JSON.parse(await first)).toMatchObject({ id: "c:1", result: { type: "session_snapshot" } });
      return { ms: answeredAt! - began, transport };
    };
    const off = await timed("");
    off.transport.close();
    expect(off.ms).toBe(2 * wire.rtt);
    const execs = wire.execs;
    const on = await timed(script);
    // Today (relay off) and relay on: connect, then one exec (2 trips); waiting for the hello first would be 3.
    expect(on.ms).toBe(off.ms);
    expect(wire.execs).toBe(execs + 1);
    expect(wire.relayLaunches).toBe(1);
    expect(wire.frames).not.toContain("herdr:session.snapshot");
    const mark = wire.mark();
    const next = on.transport.roundTrip(JSON.stringify({ id: "c:2", method: "session.snapshot", params: {} }));
    await vi.advanceTimersByTimeAsync(wire.rtt);
    await next;
    expect(wire.since(mark)).toMatchObject({ trips: 1, execs: 0, frames: ["herdr:session.snapshot"] });
    on.transport.close();
  });
});

describe("the sidebar by events", () => {
  it("a burst of 20 events gives one snapshot (at most 2)", async () => {
    const { registry } = await machine();
    const mark = wire.mark();
    for (let index = 0; index < 20; index += 1) wire.event("pane.agent_status_changed", "w1:p1");
    await vi.advanceTimersByTimeAsync(wire.rtt / 2 + sidebarBurstMs + wire.rtt + 10);
    const snapshots = wire.since(mark).methods.filter((method) => method === "session.snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots.length).toBeLessThanOrEqual(2);
    expect(registry.list()[0]!.state).toBe("connected");
  });

  it("events that come while one is in flight give one more after it (the latest wins), never one each", async () => {
    await machine();
    const mark = wire.mark();
    for (let index = 0; index < 10; index += 1) wire.event("pane.agent_status_changed", "w1:p1");
    await vi.advanceTimersByTimeAsync(wire.rtt / 2 + sidebarBurstMs + 5);
    // The first snapshot is out now; ten more events land while it is.
    for (let index = 0; index < 10; index += 1) wire.event("pane.updated", "w1:p2");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wire.since(mark).methods.filter((method) => method === "session.snapshot")).toHaveLength(2);
  });

  it("the 5 s poll is a 30 s backstop while the events are live; a changed pane set asks again on the same connection", async () => {
    const { registry } = await machine();
    registry.start(5_000);
    const mark = wire.mark();
    await vi.advanceTimersByTimeAsync(sidebarBackstopMs - 6_000);
    expect(wire.since(mark).methods).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000 + wire.rtt);
    expect(wire.since(mark).methods).toEqual(["session.snapshot"]);
    // A pane appears: its event brings a snapshot, and the stream is asked again on the relay (no new SSH connection).
    wire.live.splitBehind("w1:t1", "w1:p4", "w1:p5");
    wire.event("pane.created", "w1:p5");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wire.frames.filter((frame) => frame === "stream")).toHaveLength(2);
    expect(wire.connects).toBe(1);
  });

  it("relay off: no stream is opened, and the 5 s poll runs as before", async () => {
    const { registry } = await machine("");
    expect(registry.eventsLive("mini")).toBe(false);
    registry.start(5_000);
    const mark = wire.mark();
    await vi.advanceTimersByTimeAsync(10_000 + 2 * wire.rtt);
    expect(wire.since(mark).methods).toEqual(["session.snapshot", "session.snapshot"]);
    expect(wire.connects).toBe(1);
    expect(wire.relayLaunches).toBe(0);
  });

  it("fresh() runs its own snapshot at once, never one in flight and then another", async () => {
    const { registry } = await machine();
    const mark = wire.mark();
    void registry.refresh("mini");
    let checked: boolean | null = null;
    void registry.fresh("mini").then((value) => {
      checked = value;
    });
    // Both go at once (pipelined): the check has its answer in one trip, not two back to back.
    await vi.advanceTimersByTimeAsync(wire.rtt);
    expect(checked).toBe(true);
    expect(wire.since(mark)).toMatchObject({ trips: 2, methods: ["session.snapshot", "session.snapshot"] });
  });
});

describe("launch from the cache", () => {
  function memoryFiles(): CacheFiles & { stored: Map<string, string> } {
    const stored = new Map<string, string>();
    return { stored, read: (file) => stored.get(file) ?? null, write: (file, data) => void stored.set(file, data), remove: (file) => void stored.delete(file) };
  }

  it("shows the last sidebar at once, marked as catching up, before any request is answered", async () => {
    const files = memoryFiles();
    const before = new LaunchCache(files);
    const topology = await settled(backendOf("").snapshot());
    before.noteTopology("mini", topology);
    before.flush(true);
    expect(files.stored.size).toBe(1);

    const answered = wire.methods.length;
    const cache = new LaunchCache(files);
    const views: { catchingUp?: boolean; panes: number }[] = [];
    const registry = new HostRegistry((hosts) => views.push({ ...(hosts[0]!.catchingUp === true ? { catchingUp: true } : {}), panes: hosts[0]!.topology?.panes.length ?? 0 }));
    registries.push(registry);
    registry.add(descriptor, backendOf(), cache.load("mini")?.topology ?? null);
    // On screen at once (the add's own update), with nothing answered yet.
    expect(views[0]).toEqual({ catchingUp: true, panes: 4 });
    expect(wire.methods.length).toBe(answered);
    // Nothing of it can be acted on: the pane calls read the live snapshot only.
    expect(registry.pane("mini", "w1:p1")).toBeNull();
    expect(registry.catchingUp("mini")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(registry.catchingUp("mini")).toBe(false);
    expect(views.at(-1)).toEqual({ panes: 4 });
    expect(registry.pane("mini", "w1:p1")).not.toBeNull();
  });

  it("shows the open chat's newest 60 items at once, marked as catching up, with no read", async () => {
    const cachedChat = whole(text([user("hello", "u1", 1), reply("Hi there.", "a1", 2)]));
    const registry = new HostRegistry(() => undefined);
    registries.push(registry);
    // A machine that has not answered yet (its first snapshot still on the way).
    const topology = await settled(backendOf("").snapshot());
    registry.add(descriptor, { kind: "herdr-tui", snapshot: () => new Promise(() => undefined), transcripts: () => null, close: () => undefined } as never, topology);
    const service = new ChatService(registry, "chat");
    service.useLaunchCache({ chat: () => cachedChat, catchingUp: (hostId) => registry.catchingUp(hostId), noteChat: () => undefined });
    const updates: ChatUpdateEvent[] = [];
    const answered = wire.methods.length;
    service.open({ id: 1, send: (_channel: string, payload: never) => updates.push(payload), isDestroyed: () => false }, "mini", "w1:p1");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ catchingUp: true, state: { status: "loading" } });
    expect(shown(updates[0]!.timeline)).toEqual(["user:hello", "agent:Hi there."]);
    expect(wire.methods.length).toBe(answered);
    service.closeAll();
  });

  it("keeps a bounded window: the newest 60 items", () => {
    const lines: string[] = [];
    for (let index = 0; index < 50; index += 1) lines.push(user(`q${index}`, `u${index}`, index * 2 + 1), reply(`a${index}`, `a${index}`, index * 2 + 2, true));
    const trimmed = newestItems(whole(text(lines)));
    expect(trimmed.turns.reduce((count, turn) => count + turn.items.length, 0)).toBe(60);
    expect(shown(trimmed).at(-1)).toBe("agent:a49");
  });
});

describe("liveness", () => {
  it("a silent relay is dropped after 15 s of no frame while a window is on screen", async () => {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script });
    const warm = transport.roundTrip(JSON.stringify({ id: "w:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await warm;
    const epoch = transport.connectionEpoch();
    // Measured from the last frame, exactly 15 s, not on the 5 s ping's tick.
    const last = (await transport.readyRelay())!.lastFrameAt;
    wire.silent = true;
    await vi.advanceTimersByTimeAsync(last + relaySilenceMs - 1 - Date.now());
    expect(transport.connectionEpoch()).toBe(epoch);
    expect(ssh.clients[0]!.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ssh.clients[0]!.ended).toBe(true);
    // The window is on screen: the next connection opens at once (relay first), no caller needed.
    expect(wire.connects).toBe(2);
    expect(transport.connectionEpoch()).toBe(epoch! + 1);
    // The 5 s pings went meanwhile.
    expect(wire.frames.filter((frame) => frame === "ping").length).toBeGreaterThanOrEqual(2);
    transport.close();
  });

  it("out of sight nothing is pinged and the silence is not counted", async () => {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script });
    const warm = transport.roundTrip(JSON.stringify({ id: "w:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await warm;
    transport.setActive(false);
    const pings = wire.frames.filter((frame) => frame === "ping").length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wire.frames.filter((frame) => frame === "ping").length).toBe(pings);
    expect(ssh.clients[0]!.ended).toBe(false);
    transport.close();
  });

  it("on focus a ping with no pong reconnects within 2 s (relay first)", async () => {
    const { backend } = await machine();
    expect(wire.connects).toBe(1);
    wire.silent = true;
    backend.liveness("wake");
    await vi.advanceTimersByTimeAsync(relayWakePingMs - 1);
    expect(wire.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ssh.clients[0]!.ended).toBe(true);
    expect(wire.connects).toBe(2);
    expect(wire.relayLaunches).toBe(2);
  });

  it("on focus a ping answered keeps the connection", async () => {
    const { backend } = await machine();
    backend.liveness("wake");
    await vi.advanceTimersByTimeAsync(relayWakePingMs + 100);
    expect(wire.connects).toBe(1);
    expect(ssh.clients[0]!.ended).toBe(false);
  });
});

describe("fallback: today's path runs unchanged", () => {
  it("the shipped relay script is the relay (relay on); tests that need relay off pass \"\" themselves", () => {
    const source = readFileSync(fileURLToPath(new URL("../../Sources/HerdrKit/Resources/adari-relay.pl", import.meta.url)), "utf8");
    expect(relayScript).not.toBe("");
    expect(relayScript).toBe(source);
  });

  it("an empty relay script: no relay exec, every request its own exec (2 trips)", async () => {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: "" });
    const first = transport.roundTrip(JSON.stringify({ id: "e:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    const mark = wire.mark();
    const second = transport.roundTrip(JSON.stringify({ id: "e:2", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(2 * wire.rtt);
    await second;
    expect(wire.relayLaunches).toBe(0);
    expect(wire.since(mark)).toMatchObject({ trips: 2, execs: 1, frames: [] });
    transport.close();
  });

  it("no hello within 5 s: the connection uses the exec path; the next connect tries the relay again", async () => {
    wire.mode = "no-hello";
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script });
    let answered = false;
    const first = transport.roundTrip(JSON.stringify({ id: "n:1", method: "agent.list", params: {} })).then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(relayHelloMs - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1 + 2 * wire.rtt);
    await first;
    expect(wire.execs).toBe(1);
    const mark = wire.mark();
    const second = transport.roundTrip(JSON.stringify({ id: "n:2", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(2 * wire.rtt);
    await second;
    expect(wire.since(mark)).toMatchObject({ execs: 1, frames: [] });
    expect(wire.relayLaunches).toBe(1);
    // A new connection tries the relay first again.
    transport.close();
    wire.mode = "ok";
    const third = transport.roundTrip(JSON.stringify({ id: "n:3", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await third;
    expect(wire.relayLaunches).toBe(2);
    expect(wire.frames).toContain("herdr:agent.list");
    transport.close();
  });

  it("the relay exec refused (no Perl): the exec path at once", async () => {
    wire.mode = "exec-fails";
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script });
    const first = transport.roundTrip(JSON.stringify({ id: "f:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(2 * wire.rtt);
    await first;
    expect(wire.relayLaunches).toBe(1);
    expect(wire.execs).toBe(1);
    transport.close();
  });

  it("the relay ending mid-session fails what waits as a lost connection, and the next request reconnects relay first", async () => {
    const transport = new SshHerdrTransport(config, policy(), { relayScript: script });
    const warm = transport.roundTrip(JSON.stringify({ id: "m:1", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await warm;
    wire.silent = true;
    const waiting = transport.roundTrip(JSON.stringify({ id: "m:2", method: "agent.list", params: {} })).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.frames.at(-1)).toBe("herdr:agent.list");
    wire.relays[0]!.channel.close();
    expect(await waiting).toBe("peer closed before sending a response line");
    expect(ssh.clients[0]!.ended).toBe(true);
    wire.silent = false;
    const next = transport.roundTrip(JSON.stringify({ id: "m:3", method: "agent.list", params: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    await next;
    expect(wire.connects).toBe(2);
    expect(wire.relayLaunches).toBe(2);
    transport.close();
  });

  it("This Mac's local route keeps its local path (no relay unless asked)", () => {
    const backend = new HerdrTuiBackend(config, policy(), { connect: () => new Promise(() => undefined) });
    backends.push(backend);
    expect((backend as unknown as { relayOn: boolean }).relayOn).toBe(false);
  });
});
