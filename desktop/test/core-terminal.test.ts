// A herdr-core pane's terminal on the Mac over its attach channel
// (core-attach.ts), as the Swift app's CoreAttachTests.swift has it (first
// paint, keys, resize, focus, close; credit; a finished program; a lost kept
// terminal; refusals; early input; win32 input mode), plus credit for what the
// screen fed, a bounded buffer, a repaint when far behind, and a resize while
// attaching. Then the desktop: the page's terminal (TerminalSessions) on a
// core pane of a saved machine, its exit, and host close.

import { afterEach, describe, expect, it } from "vitest";

import type { WebContents } from "electron";

import { CoreAttachSession, CoreTerminalError, type CoreAttachOptions } from "../src/main/herdr/core-attach";
import type { CoreLink } from "../src/main/herdr/core-connection";
import type { CoreFollower, CoreFollowerOptions } from "../src/main/herdr/core-follower";
import { CoreFrameDecoder, CoreFrameKind } from "../src/main/herdr/core-frames";
import { member, tryParseCoreJSON } from "../src/main/herdr/core-json";
import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import { CoreBackoff } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { HostRegistry } from "../src/main/hosts";
import { TerminalSessions } from "../src/main/terminals";
import { IPC, type TerminalDataEvent, type TerminalExitEvent } from "../src/shared/ipc-contract";
import { FakeSshHost } from "./support/core-host-ssh";
import { coreFollower } from "./support/core-hosts";
import { eventually, pause } from "./support/core-test-link";
import { FakeCore, type FakeCoreLink } from "./support/fake-core";

const attachOptions: CoreAttachOptions = { restartWaitSeconds: 3, settleWaitSeconds: 0.5, pollSeconds: 0.02 };
const quietFollower: CoreFollowerOptions = { heartbeatSilenceSeconds: 30, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const followers: CoreFollower[] = [];
const sessions: CoreAttachSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const follower of followers.splice(0)) follower.close();
});

async function setUpCore(terminals: ReturnType<typeof FakeCore.terminal>[], makeLink?: () => CoreLink): Promise<{ core: FakeCore; follower: CoreFollower }> {
  const core = new FakeCore(terminals);
  const follower = coreFollower(core, quietFollower, makeLink);
  followers.push(follower);
  await follower.snapshot();
  return { core, follower };
}

function attach(follower: CoreFollower, address: string, cols = 80, rows = 24, options: CoreAttachOptions = attachOptions): CoreAttachSession {
  const session = new CoreAttachSession(follower, address, cols, rows, options);
  sessions.push(session);
  return session;
}

/** Reads chunks until `marker` was seen (5 s at most); the text seen. */
async function read(output: AsyncIterator<Uint8Array>, marker: string): Promise<string> {
  let seen = "";
  const deadline = Date.now() + 5_000;
  while (!seen.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`never saw ${JSON.stringify(marker)} in ${JSON.stringify(seen)}`);
    const next = await output.next();
    if (next.done === true) throw new Error(`ended before ${JSON.stringify(marker)}`);
    seen += new TextDecoder().decode(next.value);
  }
  return seen;
}

/** Reads `count` bytes without feeding them; the bytes taken. */
async function take(output: AsyncIterator<Uint8Array>, count: number): Promise<number> {
  let taken = 0;
  while (taken < count) {
    const next = await output.next();
    if (next.done === true) break;
    taken += next.value.length;
  }
  return taken;
}

/** The error the output ends with. */
async function ending(output: AsyncIterator<Uint8Array>): Promise<unknown> {
  try {
    while ((await output.next()).done !== true) {
      // drained
    }
  } catch (error) {
    return error;
  }
  return null;
}

const iterate = (session: CoreAttachSession): AsyncIterator<Uint8Array> => session.output[Symbol.asyncIterator]();

describe("a core terminal over its attach channel (CoreAttachTests)", () => {
  it("first paint, then bytes; keys as DATA in order, the grid as RESIZE once per change, FOCUS, and CLOSE", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1")]);
    core.paint.set("t1", text("\u001b[2J\u001b[H$ ready\u001b[?9001l"));
    const session = attach(follower, "t1", 100, 30);
    const output = iterate(session);
    session.start();
    const paint = await read(output, "$ ready");
    expect(paint.startsWith("\u001b[2J"), "the first paint comes first").toBe(true);
    const asked = core.calls.find((call) => call.method === "terminal.attach")?.params;
    expect(member(asked, "cols")).toBe(100);
    expect(member(asked, "rows")).toBe(30);
    expect(await eventually(() => session.readyForInput)).toBe(true);
    expect(session.win32InputMode).toBe(false);

    core.output("t1", "hello from the program\r\n");
    await read(output, "hello from the program");

    session.send(text("ls"));
    await session.sendAcknowledged(text("\r"));
    expect(await eventually(() => core.typedText("t1") === "ls\r")).toBe(true);

    session.resize(80, 24);
    session.resize(80, 24);
    expect(await eventually(() => core.resizes.length === 1)).toBe(true);
    expect(core.resizes[0]).toMatchObject({ cols: 80, rows: 24 });
    expect(core.focuses[0]?.gained, "FOCUS when it came on screen").toBe(true);

    const link = core.liveLinks[0]!;
    session.close();
    expect(await eventually(() => link.viewerClosed.length > 0), "CLOSE sent").toBe(true);
    expect((await output.next()).done, "the output ends cleanly").toBe(true);
  });

  it("bytes are credited as the screen takes them: never stalls past the stream's 256 KiB start", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1")]);
    const session = attach(follower, "t1");
    const output = iterate(session);
    session.start();
    await read(output, "$ ");
    const link = core.liveLinks[0]!;
    const channel = link.channelOf("t1")!;
    const big = new Uint8Array(300 * 1024).fill(0x78);
    core.output("t1", big);
    let received = 0;
    while (received < big.length) {
      const next = await output.next();
      if (next.done === true) throw new Error("ended");
      received += next.value.length;
      // Credited once the screen fed it, not when taken.
      session.fed(next.value.length);
    }
    expect(received).toBe(big.length);
    expect(await eventually(() => (link.credits.get(channel) ?? 0) >= big.length), "credited").toBe(true);
    expect(link.queued(channel)).toBe(0);
  });

  it("a finished program ends the session for good", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1")]);
    const session = attach(follower, "t1");
    const output = iterate(session);
    session.start();
    await read(output, "$ ");
    core.finish("t1", 3);
    const error = await ending(output);
    expect(error).toBeInstanceOf(CoreTerminalError);
    expect((error as CoreTerminalError).fault).toEqual({ kind: "finished", reason: "exited", exitCode: 3 });
    expect((error as CoreTerminalError).isRetryable).toBe(false);
    expect((error as Error).message).toBe("The program exited (code 3).");
  });

  it("a lost kept terminal is attached again after its restart, on the same screen", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1", { keep: true })]);
    const session = attach(follower, "t1");
    const output = iterate(session);
    session.start();
    await read(output, "$ ");
    core.lose("t1");
    await pause(100);
    expect(core.calls.filter((call) => call.method === "terminal.attach").length, "no attach while it waits for its new shell").toBe(1);
    core.paint.set("t1", text("\u001b[2J\u001b[Hnew shell $ "));
    core.restart("t1");
    await read(output, "new shell $ ");
    expect(session.attachCount).toBe(2);
    expect(await eventually(() => session.readyForInput), "ready again").toBe(true);
    session.send(text("pwd\r"));
    expect(await eventually(() => core.typedText("t1") === "pwd\r"), "typed into the new shell").toBe(true);
  });

  it("attach refusals are final (gone, finished) or retryable (a dropped line)", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1"), FakeCore.terminal("t2", { state: "finished" })]);
    const missing = attach(follower, "t9");
    missing.start();
    const gone = await ending(iterate(missing));
    expect((gone as CoreTerminalError).fault).toEqual({ kind: "gone" });
    const finished = attach(follower, "t2");
    finished.start();
    expect(((await ending(iterate(finished))) as CoreTerminalError).isRetryable).toBe(false);
    // A dropped line: retryable, so the app attaches again by itself.
    const live = attach(follower, "t1");
    const output = iterate(live);
    live.start();
    await read(output, "$ ");
    core.dropConnections();
    const line = (await ending(output)) as CoreTerminalError;
    expect(line.fault.kind).toBe("line");
    expect(line.isRetryable).toBe(true);
  });

  it("input before the first paint waits for it", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1")]);
    const session = attach(follower, "t1");
    session.send(text("early"));
    const output = iterate(session);
    session.start();
    await read(output, "$ ");
    expect(await eventually(() => core.typedText("t1") === "early"), "early keys delivered after the paint").toBe(true);
  });

  it("win32-input-mode is noticed", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1")]);
    core.paint.set("t1", text("C:\\> \u001b[?9001h"));
    const session = attach(follower, "t1");
    const output = iterate(session);
    session.start();
    await read(output, "C:\\>");
    expect(session.win32InputMode).toBe(true);
  });
});

describe("credit for what the screen fed, a bounded buffer, a repaint when far behind", () => {
  async function attached(): Promise<{ core: FakeCore; session: CoreAttachSession; link: FakeCoreLink; channel: number; output: AsyncIterator<Uint8Array> }> {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1")]);
    const session = attach(follower, "t1");
    const output = iterate(session);
    session.start();
    expect(await eventually(() => session.readyForInput), "attached").toBe(true);
    const link = core.liveLinks[0]!;
    return { core, session, link, channel: link.channelOf("t1")!, output };
  }

  it("output taken but not fed is not credited; fed output is, exactly", async () => {
    const { core, session, link, channel, output } = await attached();
    const paint = await take(output, 1);
    core.output("t1", new Uint8Array(100 * 1024).fill(120));
    const taken = await take(output, 100 * 1024);
    await pause(100);
    expect(link.credits.get(channel) ?? 0, "taken off the pipe is not fed to the screen").toBe(0);
    session.fed(paint);
    session.fed(60 * 1024);
    expect(await eventually(() => link.credits.get(channel) === paint + 60 * 1024), "credited").toBe(true);
    session.fed(taken - 60 * 1024);
    // More than it was given: never credited.
    session.fed(500 * 1024);
    expect(await eventually(() => link.credits.get(channel) === paint + taken), "all credited").toBe(true);
    await pause(100);
    expect(link.credits.get(channel), "never more than received").toBe(link.sentBytes.get(channel));
  });

  it("a screen that is behind holds the credit until it catches up", async () => {
    const { core, session, link, channel, output } = await attached();
    const paint = await take(output, 1);
    session.fed(paint);
    expect(await eventually(() => link.credits.get(channel) === paint), "paint credited").toBe(true);
    session.parserBacklogged(true);
    core.output("t1", new Uint8Array(64 * 1024).fill(120));
    const taken = await take(output, 64 * 1024);
    session.fed(taken);
    await pause(100);
    expect(link.credits.get(channel), "held while the screen is behind").toBe(paint);
    session.parserBacklogged(false);
    expect(await eventually(() => link.credits.get(channel) === paint + taken), "released").toBe(true);
  });

  it("a slow screen holds the core back, and gets a repaint when far behind", async () => {
    const { core, session, link, channel, output } = await attached();
    core.paint.set("t1", text("\u001b[2J\u001b[HREPAINT $ "));
    let seen = await take(output, 1);
    session.fed(seen);
    // 5 MiB from a fast program while the screen feeds nothing more.
    const chunk = new Uint8Array(64 * 1024).fill(120);
    for (let index = 0; index < 80; index += 1) core.output("t1", chunk);
    await pause(200);
    expect(session.unfedBytes, "the app holds no more than the stream's window").toBeLessThanOrEqual(256 * 1024);
    expect(link.repaints.get(channel), "more than 4 MiB behind: a repaint instead of the backlog").toBe(1);
    let tail = "";
    let repainted = false;
    const deadline = Date.now() + 5_000;
    while (!repainted && Date.now() < deadline) {
      const next = await output.next();
      if (next.done === true) break;
      seen += next.value.length;
      session.fed(next.value.length);
      const piece = tail + new TextDecoder().decode(next.value);
      repainted = piece.includes("REPAINT $ ");
      tail = piece.slice(-16);
    }
    expect(repainted).toBe(true);
    expect(seen, "the backlog was replaced, not delivered").toBeLessThan(600 * 1024);
    expect(await eventually(() => link.credits.get(channel) === seen), "credited what it fed").toBe(true);
    expect(link.credits.get(channel) ?? 0, "never more than received").toBeLessThanOrEqual(link.sentBytes.get(channel) ?? 0);
  });
});

/** A link that holds the first terminal.attach request until released (HeldAttachLink). */
class HeldAttachLink implements CoreLink {
  private held: Uint8Array | null = null;
  private holdNext = true;
  constructor(private readonly inner: FakeCoreLink) {}

  get inbound() {
    return this.inner.inbound;
  }

  get isHolding(): boolean {
    return this.held !== null;
  }

  send(bytes: Uint8Array): boolean {
    if (this.holdNext) {
      let frames: ReturnType<CoreFrameDecoder["push"]> = [];
      try {
        frames = new CoreFrameDecoder().push(bytes);
      } catch {
        frames = [];
      }
      const frame = frames[0];
      if (frame !== undefined && frame.channel === 0 && frame.kind === CoreFrameKind.data && member(tryParseCoreJSON(frame.payload), "method") === "terminal.attach") {
        this.holdNext = false;
        this.held = bytes;
        return true;
      }
    }
    return this.inner.send(bytes);
  }

  release(): void {
    const bytes = this.held;
    this.held = null;
    if (bytes !== null) this.inner.send(bytes);
  }

  close(): void {
    this.inner.close();
  }
}

describe("a resize while attaching reaches the core", () => {
  it("a resize while the attach is in flight is sent after the reply; early input once, in order", async () => {
    let held: HeldAttachLink | null = null;
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const follower = coreFollower(core, quietFollower, () => {
      held = new HeldAttachLink(core.makeLink());
      return held;
    });
    followers.push(follower);
    await follower.snapshot();
    const session = attach(follower, "t1", 80, 24, {});
    session.send(text("a"));
    session.send(text("b"));
    session.start();
    expect(await eventually(() => held?.isHolding === true), "attach request held").toBe(true);
    session.resize(100, 30);
    held!.release();
    expect(await eventually(() => session.readyForInput), "paint").toBe(true);
    expect(await eventually(() => core.typedText("t1") === "ab"), "early input once, in order").toBe(true);
    expect(await eventually(() => core.resizes.at(-1)?.cols === 100), "the new grid").toBe(true);
    expect(core.resizes.at(-1)?.rows).toBe(30);
    expect(core.resizes.length, "one RESIZE, for the grid that changed").toBe(1);
  });

  it("no resize when the grid did not change while attaching", async () => {
    const { core, follower } = await setUpCore([FakeCore.terminal("t1")]);
    const session = attach(follower, "t1", 80, 24, {});
    session.start();
    expect(await eventually(() => session.readyForInput), "paint").toBe(true);
    await pause(50);
    expect(core.resizes).toEqual([]);
  });
});

// MARK: - The Mac's terminal on a core pane

class Page {
  readonly data: TerminalDataEvent[] = [];
  readonly exits: TerminalExitEvent[] = [];
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, payload: TerminalDataEvent | TerminalExitEvent): void {
    if (channel === IPC.terminalData) this.data.push(payload as TerminalDataEvent);
    if (channel === IPC.terminalExit) this.exits.push(payload as TerminalExitEvent);
  }
  shown(): string {
    return this.data.map((event) => new TextDecoder().decode(event.data)).join("");
  }
}

const backends: HerdrMachineBackend[] = [];
const registries: HostRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const backend of backends.splice(0)) backend.close();
});

async function studio(core: FakeCore) {
  const host = new FakeSshHost(null, core);
  const backend = new HerdrMachineBackend({ host: "studio.invalid", port: 22, username: "me", privateKeyPath: "", herdrSession: "default" }, new PinningHostKeyPolicy(new MemoryPinStore()), {
    route: { connect: host.connect },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: quietFollower,
    attach: attachOptions,
  });
  backends.push(backend);
  const hosts = new HostRegistry(() => undefined);
  registries.push(hosts);
  hosts.add({ id: "studio", name: "studio", kind: "ssh", address: "me@studio.invalid:22", platform: "macOS" }, backend);
  const listed = await eventually(async () => {
    await hosts.refreshAll();
    return hosts.pane("studio", "hc:t1") !== null;
  }, 400);
  expect(listed).toBe(true);
  const terminals = new TerminalSessions(hosts);
  const page = new Page();
  const owner = page as unknown as WebContents;
  return { host, backend, hosts, terminals, page, owner };
}

describe("the Mac's terminal on a herdr-core pane", () => {
  it("opens over the attach channel: the page gets the first paint and output; keys, resize and close reach the core", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    core.paint.set("t1", text("\u001b[2J\u001b[Hcore $ "));
    const { terminals, page, owner } = await studio(core);
    const { sessionId } = await terminals.open(owner, { hostId: "studio", paneId: "hc:t1", cols: 120, rows: 40 });
    expect(page.shown(), "opened at the first paint").toContain("core $ ");
    const asked = core.calls.find((call) => call.method === "terminal.attach")?.params;
    expect([member(asked, "terminal"), member(asked, "cols"), member(asked, "rows")]).toEqual(["t1", 120, 40]);
    core.output("t1", "from the program\r\n");
    expect(await eventually(() => page.shown().includes("from the program"))).toBe(true);
    terminals.input(owner, sessionId, "ls\r");
    expect(await eventually(() => core.typedText("t1") === "ls\r")).toBe(true);
    terminals.resize(owner, sessionId, 100, 30);
    expect(await eventually(() => core.resizes.at(-1)?.cols === 100)).toBe(true);
    const link = core.liveLinks[0]!;
    const channel = link.channelOf("t1")!;
    // Credited only as the page says its terminal parsed it.
    await pause(20);
    expect(link.credits.get(channel) ?? 0, "handed to the page is not parsed").toBe(0);
    terminals.parsed(owner, sessionId, link.sentBytes.get(channel)!);
    expect(await eventually(() => (link.credits.get(channel) ?? 0) === link.sentBytes.get(channel))).toBe(true);
    terminals.close(owner, sessionId);
    expect(await eventually(() => link.viewerClosed.includes(channel)), "CLOSE: the program runs on").toBe(true);
    expect(page.exits, "closed by the page: no exit event").toEqual([]);
  });

  it("a program that ends shows why on the page", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { terminals, page, owner } = await studio(core);
    const { sessionId } = await terminals.open(owner, { hostId: "studio", paneId: "hc:t1", cols: 80, rows: 24 });
    core.finish("t1", 3);
    expect(await eventually(() => page.exits.length === 1)).toBe(true);
    expect(page.exits[0]).toEqual({ sessionId, reason: "The program exited (code 3)." });
  });

  it("a terminal removed meanwhile does not open: the attach's refusal is the error", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { terminals, owner } = await studio(core);
    core.overrides.set("terminal.attach", () => FakeCore.rpcError("no terminal t1", "not_found"));
    await expect(terminals.open(owner, { hostId: "studio", paneId: "hc:t1", cols: 80, rows: 24 })).rejects.toThrow("This terminal is gone.");
  });

  it("host close with a terminal open: the terminal ends, and no SSH client is left", async () => {
    const core = new FakeCore([FakeCore.terminal("t1")]);
    const { host, backend, terminals, page, owner } = await studio(core);
    await terminals.open(owner, { hostId: "studio", paneId: "hc:t1", cols: 80, rows: 24 });
    const link = core.liveLinks[0]!;
    const channel = link.channelOf("t1")!;
    backend.close();
    expect(await eventually(() => link.viewerClosed.includes(channel) || link.isClosed)).toBe(true);
    expect(await eventually(() => host.openClients.length === 0), "no SSH client left").toBe(true);
    expect(page.exits.length).toBeLessThanOrEqual(1);
  });
});
