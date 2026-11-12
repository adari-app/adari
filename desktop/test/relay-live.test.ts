// The real relay script (relay-script.ts, generated
// from Sources/HerdrKit/Resources/adari-relay.pl) run by /usr/bin/perl as a
// child process, its stdin and stdout the channel (stderr dropped), against the
// relay tests' fake Herdr (scripts/relay-tests/fake-herdr.pl, a Unix socket in
// a temp folder under HERDR_TEST_SCRATCH), wired into the app's own relay
// client through its seams: relay.ts's RelayPipe, and SshHerdrTransport's
// `connect` with a client whose exec runs the command locally under /bin/zsh
// (the default login shell on macOS). No SSH, no real Herdr: HOME and
// XDG_CONFIG_HOME point into the temp folder, so the launch line's socket
// setup finds the fake. Every child is stopped in afterEach.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { maxCommandBytes } from "../src/main/herdr/commands";
import { ClosedBeforeResponseError, RemoteSocketFailedError, RequestTimedOutError } from "../src/main/herdr/errors";
import { openRelayEventStream } from "../src/main/herdr/events";
import { RelayClient, relayFileLimit, relayLaunchCommand, relaySilenceMs } from "../src/main/herdr/relay";
import { relayScript } from "../src/main/herdr/relay-script";
import { SshHerdrTransport } from "../src/main/herdr/ssh";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { HostRegistry } from "../src/main/hosts";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { SshTranscriptReader } from "../src/main/chat/ssh-reader";
import { ChatFeed } from "../src/shared/chat/feed";
import { claudeLines, claudeSession, reply, shown, text, timelineOf, user } from "./support/chat-lines";
import { topology } from "./support/sidebar-fixture";

const fakeHerdr = fileURLToPath(new URL("../../scripts/relay-tests/fake-herdr.pl", import.meta.url));
const scratch = process.env["HERDR_TEST_SCRATCH"] || os.tmpdir();
const config = { host: "local.invalid", port: 22, username: "fixture", privateKeyPath: "", herdrSession: "default" };

/** Children this test started (the fake's process group, relays, shells); all stopped after each test. */
const children: ChildProcess[] = [];
const groups: number[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // Already closed.
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    } catch {
      // Gone.
    }
  }
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Gone.
    }
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
}

/** A temp world: home (the relay's $HOME), the fake Herdr's socket where the default session's setup looks, its log. */
interface World {
  readonly dir: string;
  readonly home: string;
  readonly config: string;
  readonly sock: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
}

async function world(delays = ""): Promise<World> {
  const dir = mkdtempSync(path.join(scratch, "rl-"));
  const home = path.join(dir, "home");
  const configRoot = path.join(dir, "cfg");
  mkdirSync(home);
  mkdirSync(path.join(configRoot, "herdr"), { recursive: true });
  const sock = path.join(configRoot, "herdr", "herdr.sock");
  const log = path.join(dir, "fake.log");
  // The fake makes its own process group (setpgrp); detached keeps it out of ours.
  const fake = spawn("/usr/bin/perl", [fakeHerdr, sock, log, delays], { stdio: "ignore", detached: true });
  children.push(fake);
  if (fake.pid !== undefined) groups.push(fake.pid);
  expect(await until(() => existsSync(sock))).toBe(true);
  const env = { HOME: home, XDG_CONFIG_HOME: configRoot, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
  return { dir, home, config: configRoot, sock, log, env };
}

const logLines = (w: World): string[] => (existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter((line) => line !== "") : []);

/** The relay as a child: /usr/bin/perl -e <the script> -- <socket>, or a shell running a launch line. */
interface Live {
  readonly child: ChildProcess;
  readonly client: RelayClient;
  /** Every line the client wrote. */
  readonly written: string[];
}

function relayChild(child: ChildProcess, w: World, helloMs?: number): Live {
  children.push(child);
  const written: string[] = [];
  child.stdin!.on("error", () => undefined);
  const client = new RelayClient(
    {
      write: (line) => {
        written.push(line);
        child.stdin!.write(line);
      },
      close: () => child.stdin!.end(),
    },
    w.sock,
    helloMs,
  );
  child.stdout!.on("data", (chunk: Buffer) => client.data(chunk));
  child.on("exit", () => client.finish("the relay exited"));
  closers.push(() => client.close("test over"));
  return { child, client, written };
}

function perlRelay(w: World): Live {
  return relayChild(spawn("/usr/bin/perl", ["-e", relayScript, "--", w.sock], { env: w.env, stdio: ["pipe", "pipe", "ignore"] }), w);
}

const line = (id: string, method: string, params: Record<string, unknown> = {}): string => JSON.stringify({ id, method, params });
const replyOf = (reply: string): { id: string; result: { method: string } } => JSON.parse(reply) as { id: string; result: { method: string } };

/**
 * A stand-in for an ssh2 client whose exec runs the command on this computer under /bin/zsh, with the world's
 * HOME and XDG_CONFIG_HOME: SshHerdrTransport's real launch line and exec path, locally, against the fake.
 */
class LocalExecClient extends EventEmitter {
  readonly commands: string[] = [];
  readonly spawned: ChildProcess[] = [];
  ended = false;

  constructor(private readonly w: World) {
    super();
  }

  exec(command: string, reply: (error: Error | undefined, channel: unknown) => void): void {
    this.commands.push(command);
    const child = spawn("/bin/zsh", ["-c", command], { env: this.w.env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    this.spawned.push(child);
    child.stdin.on("error", () => undefined);
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      write: (data: string | Buffer): boolean => child.stdin.write(data),
      close: (): void => {
        child.stdin.end();
      },
    });
    child.stdout.on("data", (chunk: Buffer) => channel.emit("data", chunk));
    child.stderr.on("data", (chunk: Buffer) => channel.stderr.emit("data", chunk));
    child.on("close", (code: number | null, signal: string | null) => {
      channel.emit("exit", code, signal ?? undefined);
      channel.emit("close");
    });
    queueMicrotask(() => reply(undefined, channel));
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const child of this.spawned) child.stdin?.end();
    this.emit("end");
    this.emit("close");
  }
}

function localTransport(w: World, script: string = relayScript, extra: { relayHelloMs?: number } = {}) {
  const clients: LocalExecClient[] = [];
  const transport = new SshHerdrTransport(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
    relayScript: script,
    ...extra,
    connect: async () => {
      const client = new LocalExecClient(w);
      clients.push(client);
      return client as never;
    },
  });
  closers.push(() => transport.close());
  return { transport, clients };
}

describe("the launch line, for real", () => {
  const launch = relayLaunchCommand("default", relayScript);

  it("fits the 120,000-byte command limit with the socket setup included", () => {
    const bytes = Buffer.byteLength(launch, "utf8");
    console.log(`relay-live: desktop launch line ${bytes} bytes (script ${Buffer.byteLength(relayScript, "utf8")} bytes; limit ${maxCommandBytes})`);
    expect(launch.startsWith("unset HERDR_SOCKET_PATH; CONFIG_ROOT=")).toBe(true);
    expect(launch.endsWith(`| /usr/bin/base64 -D)" -- "$SOCKET"`)).toBe(true);
    // Item 9: the soft file limit raised after the socket setup, right before the exec of Perl.
    expect(launch).toContain(`exit 66; }; ${relayFileLimit}exec /usr/bin/perl -e `);
    expect(bytes).toBeLessThanOrEqual(maxCommandBytes);
    expect(bytes).toBeLessThan(60_000);
  });

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it(`under ${shell} -c: the hello arrives and a request gets its reply`, async () => {
      const w = await world();
      const live = relayChild(spawn(shell, ["-c", launch], { env: w.env, stdio: ["pipe", "pipe", "ignore"] }), w);
      expect(await live.client.hello).toBe(true);
      const answer = replyOf(await live.client.request(line("adari:1", "agent.list"), 5_000));
      expect(answer).toMatchObject({ id: "adari:1", result: { method: "agent.list" } });
      expect(logLines(w)).toContainEqual(expect.stringMatching(/^conn agent\.list adari:1#r\d+$/));
    });
  }

  it("SshHerdrTransport's own launch, run under /bin/zsh: the relay says hello and carries the requests", async () => {
    const w = await world();
    const { transport, clients } = localTransport(w);
    const answer = replyOf(await transport.roundTrip(line("t:1", "agent.list")));
    expect(answer.result.method).toBe("agent.list");
    expect(clients[0]!.commands).toEqual([launch]);
    const relay = await transport.readyRelay();
    expect(relay?.up).toBe(true);
  });
});

describe("the real script with the real client, no SSH", () => {
  it("hello within 5 s", async () => {
    const w = await world();
    const began = Date.now();
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    const ms = Date.now() - began;
    console.log(`relay-live: desktop hello after ${ms} ms`);
    expect(ms).toBeLessThan(5_000);
  });

  it("requests are pipelined and matched by id (wire ids unique); a slow request does not hold a fast one", async () => {
    const w = await world("slow=1");
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    const order: string[] = [];
    const slow = live.client.request(line("q:slow", "slow"), 5_000).then((answer) => {
      order.push("slow");
      return answer;
    });
    const fast = live.client.request(line("q:fast", "fast"), 5_000).then((answer) => {
      order.push("fast");
      return answer;
    });
    // The same caller id twice: each its own wire id, each answered under the caller's id.
    const twinA = live.client.request(line("q:twin", "twin.a"), 5_000);
    const twinB = live.client.request(line("q:twin", "twin.b"), 5_000);
    // All four written before any reply came.
    expect(live.written).toHaveLength(4);
    expect(replyOf(await fast)).toMatchObject({ id: "q:fast", result: { method: "fast" } });
    expect(order).toEqual(["fast"]);
    expect(replyOf(await twinA)).toMatchObject({ id: "q:twin", result: { method: "twin.a" } });
    expect(replyOf(await twinB)).toMatchObject({ id: "q:twin", result: { method: "twin.b" } });
    expect(replyOf(await slow)).toMatchObject({ id: "q:slow", result: { method: "slow" } });
    expect(order).toEqual(["fast", "slow"]);
    const wireIds = live.written.map((written) => (JSON.parse(written) as { id: string }).id);
    expect(new Set(wireIds).size).toBe(wireIds.length);
    expect(wireIds.every((id) => /#r\d+$/.test(id))).toBe(true);
  });

  it("stream: events, ended when Herdr closes it, close from the client", async () => {
    const w = await world();
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    const lines: string[] = [];
    let ended: string | null = null;
    live.client.stream(line("sub:1", "subscribe", { count: 3, every: 0.01 }), { line: (text) => lines.push(text), ended: (reason) => (ended = reason) });
    expect(await until(() => ended !== null)).toBe(true);
    expect(lines.map((text) => (JSON.parse(text) as { event: number }).event)).toEqual([1, 2, 3]);
    expect(ended).toBe("the event stream closed");
    // One held open: close from this side closes Herdr's connection (the fake sees its peer go), no ended.
    const held: string[] = [];
    let heldEnded = false;
    const handle = live.client.stream(line("sub:2", "subscribe", { hold: true, every: 0.02 }), { line: (text) => held.push(text), ended: () => (heldEnded = true) });
    expect(await until(() => held.length >= 2)).toBe(true);
    handle.close();
    expect(await until(() => logLines(w).includes("peer-closed sub:2"))).toBe(true);
    await sleep(100);
    expect(heldEnded).toBe(false);
  });

  it("the sidebar: a burst of 20 events on the relay stream gives one coalesced snapshot (at most 2)", async () => {
    const w = await world();
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    let snapshots = 0;
    const backend = {
      kind: "herdr-tui",
      connectionEpoch: () => 1,
      snapshot: async () => {
        snapshots += 1;
        await live.client.request(line(`snap:${snapshots}`, "session.snapshot"), 5_000);
        return topology();
      },
      subscribeSidebar: (_kinds: readonly string[], _panes: unknown, sink: Parameters<typeof openRelayEventStream>[2]) =>
        openRelayEventStream(
          async () => live.client,
          line("sidebar", "subscribe", { count: 20, every: 0.002, kind: "pane.agent_status_changed", pane: "w1:p1" }),
          sink,
        ),
      close: () => undefined,
    } as unknown as HerdrHostBackend;
    const registry = new HostRegistry(() => undefined);
    closers.push(() => registry.close());
    registry.add({ id: "local", name: "Fake", kind: "ssh", address: "fixture@local.invalid:22", platform: null }, backend);
    // The first snapshot, then the stream; its 20 events come within about 40 ms.
    expect(await until(() => registry.eventsLive("local"))).toBe(true);
    await sleep(800);
    const fromEvents = snapshots - 1;
    const asked = logLines(w).filter((entry) => entry.startsWith("conn session.snapshot")).length;
    console.log(`relay-live: desktop sidebar, 20 events gave ${fromEvents} snapshot(s)`);
    expect(fromEvents).toBeGreaterThanOrEqual(1);
    expect(fromEvents).toBeLessThanOrEqual(2);
    expect(asked).toBe(snapshots);
  });

  it("read: size, the file's real inode (the same across reads of an unchanged file), data; max 0 answers the size only; gone", async () => {
    const w = await world();
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    const file = path.join(w.home, "t.jsonl");
    writeFileSync(file, "hello\nworld\n");
    const inode = Number(statSync(file).ino);
    const first = await live.client.read(file, 6, 100, 5_000);
    expect(first).not.toBeNull();
    expect({ size: first!.size, ino: first!.ino, offset: first!.offset, data: Buffer.from(first!.data).toString() }).toEqual({ size: 12, ino: inode, offset: 6, data: "world\n" });
    const again = await live.client.read(file, 0, 5, 5_000);
    expect(again!.ino).toBe(inode);
    expect(Buffer.from(again!.data).toString()).toBe("hello");
    const sizeOnly = await live.client.read(file, 0, 0, 5_000);
    expect({ size: sizeOnly!.size, ino: sizeOnly!.ino, bytes: sizeOnly!.data.length }).toEqual({ size: 12, ino: inode, bytes: 0 });
    // Truncated in place (same inode): the new size.
    truncateSync(file, 6);
    const cut = await live.client.read(file, 0, 100, 5_000);
    expect({ size: cut!.size, ino: cut!.ino }).toEqual({ size: 6, ino: inode });
    // `~/` is the relay's $HOME.
    const home = await live.client.read("~/t.jsonl", 0, 100, 5_000);
    expect(home!.ino).toBe(inode);
    expect(await live.client.read(path.join(w.home, "none.jsonl"), 0, 10, 5_000)).toBeNull();
  });

  it("watch: grew in order across a 256 KB split, reset on shrink and on replace, gone", async () => {
    const w = await world();
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    const file = path.join(w.home, "w.jsonl");
    writeFileSync(file, "a\n");
    const events: { kind: string; offset?: number; size?: number; ino?: number; data?: Buffer }[] = [];
    let gone = false;
    live.client.watch(file, 2, {
      grew: (offset, size, data) => events.push({ kind: "grew", offset, size, data: Buffer.from(data) }),
      reset: (size, ino) => events.push({ kind: "reset", size, ino }),
      gone: () => (gone = true),
      ended: (reason) => events.push({ kind: `ended:${reason}` }),
    });
    await sleep(150);
    const added = Buffer.alloc(300_000);
    for (let index = 0; index < added.length; index += 1) added[index] = 0x61 + (index % 26);
    appendFileSync(file, added);
    expect(await until(() => events.filter((e) => e.kind === "grew").reduce((total, e) => total + e.data!.length, 0) >= added.length)).toBe(true);
    const grew = events.filter((e) => e.kind === "grew");
    expect(grew.length).toBeGreaterThanOrEqual(2);
    expect(grew[0]!.offset).toBe(2);
    let at = 2;
    for (const frame of grew) {
      expect(frame.offset).toBe(at);
      expect(frame.data!.length).toBeLessThanOrEqual(262_144);
      at += frame.data!.length;
    }
    expect(Buffer.concat(grew.map((frame) => frame.data!)).equals(added)).toBe(true);
    // Shrink: reset with the new size, same inode.
    const inode = Number(statSync(file).ino);
    truncateSync(file, 10);
    expect(await until(() => events.some((e) => e.kind === "reset"))).toBe(true);
    expect(events.find((e) => e.kind === "reset")).toMatchObject({ size: 10, ino: inode });
    // Replace: another file takes the name.
    const other = path.join(w.home, "w.next");
    writeFileSync(other, "replaced\n");
    const replacedInode = Number(statSync(other).ino);
    renameSync(other, file);
    expect(await until(() => events.filter((e) => e.kind === "reset").length >= 2)).toBe(true);
    expect(events.filter((e) => e.kind === "reset")[1]).toMatchObject({ size: 9, ino: replacedInode });
    unlinkSync(file);
    expect(await until(() => gone)).toBe(true);
    expect(events.some((e) => e.kind.startsWith("ended"))).toBe(false);
  });

  it("Chat (ChatFeed over the transcript reader on the relay) shows pushed bytes across a 256 KB split with no gap or duplicate", async () => {
    const w = await world();
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    const file = path.join(w.home, "chat.jsonl");
    const first = [user("hello", "u-start", 1), reply("Working on it.", "a-start", 2)];
    writeFileSync(file, text(first));
    const reader = new SshTranscriptReader(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
      relay: async () => live.client,
      connect: () => Promise.reject(new Error("no SFTP in this test: everything rides the relay")),
    });
    closers.push(() => reader.close());
    (reader as unknown as { locate: () => Promise<string> }).locate = async () => file;
    const feed = new ChatFeed(reader, { pollIntervalMs: 1_000 });
    closers.push(() => feed.stop());
    feed.start(claudeSession, []);
    expect(await until(() => shown(feed.timeline).length === 2)).toBe(true);
    // Watched from its end; then 36 turns (about 580 KB) in one write: several grew frames.
    expect(await until(() => live.written.some((written) => written.includes('"relay":"watch"')))).toBe(true);
    const more = claudeLines(36, 8_000);
    const writtenBefore = live.written.length;
    appendFileSync(file, text(more));
    expect(Buffer.byteLength(text(more))).toBeGreaterThan(2 * 262_144);
    const expected = shown(timelineOf([...first, ...more]).timeline);
    expect(await until(() => shown(feed.timeline).length >= expected.length, 8_000)).toBe(true);
    expect(shown(feed.timeline)).toEqual(expected);
    // The push carried the bytes (the follow may read the rest of a push still arriving once: the same bytes,
    // taken in order, never twice in the timeline).
    const asked = live.written.slice(writtenBefore).filter((written) => written.includes('"relay":"read"'));
    console.log(`relay-live: desktop chat, ${Buffer.byteLength(text(more))} bytes appended at once, ${asked.length} read frame(s) beside the push`);
    expect(asked.length).toBeLessThanOrEqual(2);
  });

  it("cancel after a missed deadline: the relay closes Herdr's connection, and a late reply never settles another request", async () => {
    const w = await world("late=1");
    const live = perlRelay(w);
    expect(await live.client.hello).toBe(true);
    // The fake holds the reply (hang): the deadline passes, the client cancels, the relay closes it.
    await expect(live.client.request(line("x:hang", "hang"), 300)).rejects.toBeInstanceOf(RequestTimedOutError);
    const cancel = live.written.map((written) => JSON.parse(written) as { relay?: string; id: string }).find((frame) => frame.relay === "cancel");
    expect(cancel?.id).toMatch(/^x:hang#r\d+$/);
    expect(await until(() => logLines(w).includes(`peer-closed ${cancel!.id}`))).toBe(true);
    // A late reply (1 s) to a request given up at 300 ms, then a new request under the same caller id: it gets its own.
    await expect(live.client.request(line("x:1", "late"), 300)).rejects.toBeInstanceOf(RequestTimedOutError);
    const next = live.client.request(line("x:1", "after"), 5_000);
    expect(replyOf(await next)).toMatchObject({ id: "x:1", result: { method: "after" } });
    await sleep(1_000);
    const again = replyOf(await live.client.request(line("x:1", "again"), 5_000));
    expect(again.result.method).toBe("again");
    expect(live.client.up).toBe(true);
  });

  it(
    "limit: the 257th open request gets the app's lost-reply error; once some finish, requests are answered again",
    async () => {
      const w = await world();
      const live = perlRelay(w);
      expect(await live.client.hello).toBe(true);
      // In batches of 64: the fake forks per connection and macOS clamps a listen backlog to 128
      // (kern.ipc.somaxconn), so 256 connects at once would see some refused (socket_failed) before it accepts them.
      const held: Promise<unknown>[] = [];
      for (let batch = 0; batch < 4; batch += 1) {
        for (let index = batch * 64; index < (batch + 1) * 64; index += 1) {
          held.push(live.client.request(line(`h:${index}`, "hang"), 8_000).catch((error: unknown) => error));
        }
        const opened = (batch + 1) * 64;
        expect(await until(() => logLines(w).filter((entry) => entry.startsWith("conn hang")).length === opened, 5_000)).toBe(true);
      }
      expect(logLines(w).filter((entry) => entry.startsWith("peer-closed"))).toEqual([]);
      await expect(live.client.request(line("over", "agent.list"), 5_000)).rejects.toBeInstanceOf(ClosedBeforeResponseError);
      // Their deadlines pass: each is cancelled, the relay frees its room.
      const outcomes = await Promise.all(held);
      expect(outcomes.every((outcome) => outcome instanceof RequestTimedOutError)).toBe(true);
      await sleep(200);
      expect(replyOf(await live.client.request(line("back", "agent.list"), 5_000)).result.method).toBe("agent.list");
      expect(live.client.up).toBe(true);
    },
    30_000,
  );

  it(
    "ping and pong; no frame for 15 s (the relay stopped) drops the channel",
    async () => {
      const w = await world();
      const live = perlRelay(w);
      expect(await live.client.hello).toBe(true);
      expect(await live.client.ping(2_000)).toBe(true);
      const pong = live.written.map((written) => JSON.parse(written) as { relay?: string }).filter((frame) => frame.relay === "ping");
      expect(pong).toHaveLength(1);
      let droppedAt: number | null = null;
      live.client.keepAlive(
        () => true,
        () => (droppedAt = Date.now()),
      );
      // A last frame now, then the relay stops answering anything.
      expect(await live.client.ping(2_000)).toBe(true);
      const lastFrame = live.client.lastFrameAt;
      live.child.kill("SIGSTOP");
      expect(await until(() => droppedAt !== null, relaySilenceMs + 3_000)).toBe(true);
      const silence = droppedAt! - lastFrame;
      console.log(`relay-live: desktop silence drop after ${silence} ms of no frame`);
      expect(silence).toBeGreaterThanOrEqual(relaySilenceMs);
      expect(silence).toBeLessThan(relaySilenceMs + 1_500);
      live.child.kill("SIGCONT");
    },
    30_000,
  );

  it("stdin closed: the child exits; the transport falls back on the next request (a new connection, relay first)", async () => {
    const w = await world();
    const { transport, clients } = localTransport(w);
    expect(replyOf(await transport.roundTrip(line("s:1", "agent.list"))).result.method).toBe("agent.list");
    const relayChildProcess = clients[0]!.spawned[0]!;
    let exited = false;
    relayChildProcess.on("exit", () => (exited = true));
    // The channel's stdin closes (as when sshd closes it): the relay exits.
    relayChildProcess.stdin!.end();
    expect(await until(() => exited, 3_000)).toBe(true);
    expect(await until(() => clients[0]!.ended, 3_000)).toBe(true);
    const next = replyOf(await transport.roundTrip(line("s:2", "agent.list")));
    expect(next.result.method).toBe("agent.list");
    expect(clients).toHaveLength(2);
    expect(clients[1]!.commands[0]).toBe(relayLaunchCommand("default", relayScript));
    expect((await transport.readyRelay())?.up).toBe(true);
  });

  it("a relay that never says hello: the exec path answers (printf | base64 -D | nc -U, locally)", async () => {
    const w = await world();
    const { transport, clients } = localTransport(w, "exit 3;\n", { relayHelloMs: 1_000 });
    const answer = replyOf(await transport.roundTrip(line("e:1", "agent.list")));
    expect(answer).toMatchObject({ id: "e:1", result: { method: "agent.list" } });
    expect(clients[0]!.commands).toHaveLength(2);
    expect(clients[0]!.commands[1]).toContain("/usr/bin/nc -U");
  });
});

describe("the launch line raises the Mac's soft file limit (256 over a non-interactive ssh exec)", () => {
  const launch = relayLaunchCommand("default", relayScript);

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    it(
      `${shell} -c "ulimit -S -n 256; <the launch line>": 256 held requests all get a Herdr connection, and the 257th gets limit, not socket_failed`,
      async () => {
        const w = await world();
        // The Mac's measured limits: soft 256, hard unlimited (`-S`: bash's plain `ulimit -n` lowers the hard limit too).
        const live = relayChild(spawn(shell, ["-c", `ulimit -S -n 256; ${launch}`], { env: w.env, stdio: ["pipe", "pipe", "ignore"] }), w);
        expect(await live.client.hello).toBe(true);
        const early: unknown[] = [];
        const held: Promise<unknown>[] = [];
        // In batches of 64 (the fake's listen backlog is clamped to 128 by kern.ipc.somaxconn).
        for (let batch = 0; batch < 4; batch += 1) {
          for (let index = batch * 64; index < (batch + 1) * 64; index += 1) {
            held.push(
              live.client.request(line(`h:${index}`, "hang"), 20_000).catch((error: unknown) => {
                early.push(error);
                return error;
              }),
            );
          }
          const opened = (batch + 1) * 64;
          expect(await until(() => logLines(w).filter((entry) => entry.startsWith("conn hang")).length === opened, 5_000)).toBe(true);
        }
        expect(early).toEqual([]);
        const over = await live.client.request(line("over", "agent.list"), 5_000).catch((error: unknown) => error);
        expect(over).not.toBeInstanceOf(RemoteSocketFailedError);
        expect(over).toBeInstanceOf(ClosedBeforeResponseError);
        expect(early).toEqual([]);
        expect(logLines(w).filter((entry) => entry.startsWith("conn hang"))).toHaveLength(256);
        live.client.close("test over");
        await Promise.all(held);
      },
      30_000,
    );
  }
});
