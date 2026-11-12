// Chat, relay reads and uploads on a herdr-core host. The
// host's file side is the SSH host's own reader (the TUI backend's), whatever
// runs there: Chat opens on a core Claude pane from the session its argv names
// (argv is where a core pane names it), its reads ride the relay (a
// reads-only relay, no socket, on a host with herdr-core and no Herdr TUI),
// and an image upload goes over the same reader with UploadService unchanged.
// The machine is this computer's local session on a temp home (FakeMac), `hc
// connect` the fake core.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import type { CoreFollowerOptions } from "../src/main/herdr/core-follower";
import { CoreBackoff } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { relayScript } from "../src/main/herdr/relay-script";
import { HostRegistry } from "../src/main/hosts";
import { UploadService } from "../src/main/uploads/service";
import type { UploadSweepLog } from "../src/main/uploads/sweep";
import { isOwnedUploadPath } from "../src/shared/attachments";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { reply, session, user } from "./support/chat-lines";
import { eventually } from "./support/core-test-link";
import { CoreLocalMachine } from "./support/core-local-machine";
import { FakeCore } from "./support/fake-core";
import { closeFakeMacs, makeFakeMac } from "./support/this-mac-fake";

/** The fixture transcript's own session and folder (chat-lines.ts), so it is the pane's. */
const folder = "/Users/fixture/proj";
const fastFollower: CoreFollowerOptions = { heartbeatSilenceSeconds: 30, watchdogIntervalSeconds: 0.05, machinePollSeconds: 60, snapshotWaitSeconds: 2 };
const config = { host: "studio.invalid", port: 22, username: "me", privateKeyPath: "", herdrSession: "default" };

class Page implements ChatOwner {
  readonly updates: ChatUpdateEvent[] = [];
  constructor(readonly id: number) {}
  send(_channel: string, payload: ChatUpdateEvent): void {
    this.updates.push(payload);
  }
  isDestroyed(): boolean {
    return false;
  }
  get last(): ChatUpdateEvent | undefined {
    return this.updates.at(-1);
  }
}

function claudeCore(argv: string[] = ["claude", "--resume", session]): FakeCore {
  const core = new FakeCore([
    FakeCore.terminal("t1", { status: FakeCore.status("idle"), foreground: FakeCore.foreground("claude", argv, folder) }),
    FakeCore.terminal("t2", { status: FakeCore.status("idle", "codex"), foreground: FakeCore.foreground("codex", ["codex"], folder) }),
  ]);
  core.setDocument("herdr-app", FakeCore.layout([{ id: "s1", name: "App", folder, tabs: [{ id: "tA", name: "Main", terminals: ["t1", "t2"] }] }]));
  return core;
}

const backends: HerdrMachineBackend[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const backend of backends.splice(0)) backend.close();
  await closeFakeMacs();
});

function machineBackend(machine: CoreLocalMachine, relay: boolean): HerdrMachineBackend {
  const backend = new HerdrMachineBackend(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
    route: { connect: machine.connect, ...(relay ? { relayScript, relayHelloMs: 5_000 } : {}) },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: fastFollower,
  });
  backends.push(backend);
  return backend;
}

function writeTranscript(home: string, id: string, lines: readonly string[]): string {
  const projects = path.join(home, ".claude", "projects", "-Users-fixture-proj");
  mkdirSync(projects, { recursive: true });
  const file = path.join(projects, `${id}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

async function coreOnly(backend: HerdrMachineBackend): Promise<boolean> {
  return (
    (await eventually(async () => {
      const topology = await backend.snapshot().catch(() => null);
      return topology !== null && topology.panes.length === 2 && backend.routesToCoreOnly();
    }, 1_000)) === true
  );
}

describe.skipIf(process.platform !== "darwin")("Chat on a herdr-core host", () => {
  it("Chat opens on a core Claude pane whose argv names its session; a Codex pane naming none says so", async () => {
    const mac = makeFakeMac({ herdr: false });
    writeTranscript(mac.home, session, [user("hello from the core pane", "u1", 1), reply("hi there", "a1", 2, true)]);
    const machine = new CoreLocalMachine(mac, claudeCore());
    const hosts = new HostRegistry(() => undefined);
    closers.push(() => hosts.close());
    const backend = machineBackend(machine, false);
    hosts.add({ id: "studio", name: "studio", kind: "ssh", address: "me@studio.invalid:22", platform: "macOS" }, backend);
    expect(await eventually(() => hosts.agent("studio", "hc:t1")?.agentSession?.value === session, 1_000)).toBe(true);
    expect(hosts.agent("studio", "hc:t1")?.agentSession).toEqual({ source: "herdr:claude", agent: "claude", kind: "id", value: session });

    const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
    closers.push(() => service.closeAll());
    const page = new Page(1);
    service.open(page, "studio", "hc:t1");
    expect(await eventually(() => page.last?.state.status === "live", 1_000)).toBe(true);
    const texts = page.last!.timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? [item.value.text] : [])));
    expect(texts).toEqual(["hello from the core pane"]);
    expect(page.last).toMatchObject({ hostId: "studio", paneId: "hc:t1" });
    // The file side is the host's own reader, whatever runs there.
    expect(backend.transcripts()).toBe(backend.tui.transcripts());
    expect(backend.core.transcripts()).toBe(backend.tui.transcripts());

    // A Codex pane whose argv names no session: nothing to look up.
    service.open(page, "studio", "hc:t2");
    expect(await eventually(() => page.last?.paneId === "hc:t2" && page.last.state.status === "unavailable", 1_000)).toBe(true);
    expect(page.last?.state).toEqual({ status: "unavailable", reason: "noSession" });
  });

  it("relay reads on a core-only host ride a reads-only relay (no socket); none is started while the TUI is there", async () => {
    const mac = makeFakeMac({ herdr: false });
    const file = writeTranscript(mac.home, session, [user("relay read", "u1", 1)]);
    const machine = new CoreLocalMachine(mac, claudeCore());
    const backend = machineBackend(machine, true);
    expect(await coreOnly(backend)).toBe(true);
    const reader = backend.tui.transcripts();
    const read = await reader.readWithIdentity(file, 0, 1 << 20);
    expect(read, "a relay read, not SFTP").not.toBeNull();
    expect(Buffer.from(read!.data).toString("utf8")).toBe(readFileSync(file, "utf8"));
    expect(await reader.size(file)).toBe(readFileSync(file).length);
    const launches = machine.commands.filter((command) => command.includes("/usr/bin/perl -e"));
    expect(launches.some((command) => command.endsWith('-- "$SOCKET"')), "the TUI's relay was tried").toBe(true);
    expect(launches.some((command) => command.endsWith('-- ""')), "the reads-only relay").toBe(true);
    expect(machine.clients.reduce((sum, client) => sum + client.sftpSessions, 0), "no SFTP for relay reads").toBe(0);
    // Chat's watch rides it too.
    const grew: number[] = [];
    const watch = await reader.watch(file, read!.size, { grew: (offset) => grew.push(offset), reset: () => undefined, gone: () => undefined, ended: () => undefined });
    expect(watch).not.toBeNull();
    writeFileSync(file, readFileSync(file, "utf8") + user("and more", "u2", 2) + "\n");
    expect(await eventually(() => grew.length > 0, 1_000)).toBe(true);
    watch?.close();
    backend.close();
    expect(await eventually(() => machine.openClients.length === 0, 1_000)).toBe(true);
  });

  it("a host with the Herdr TUI and herdr-core never starts the reads-only relay", async () => {
    const mac = makeFakeMac();
    await mac.serve();
    const file = writeTranscript(mac.home, session, [user("tui host", "u1", 1)]);
    const machine = new CoreLocalMachine(mac, claudeCore());
    const backend = machineBackend(machine, false);
    expect(await eventually(async () => ((await backend.snapshot().catch(() => null))?.panes.length ?? 0) === 4, 1_000)).toBe(true);
    expect(backend.routesToCoreOnly()).toBe(false);
    expect(await backend.tui.transcripts().size(file)).toBeGreaterThan(0);
    expect(machine.commands.some((command) => command.endsWith('-- ""'))).toBe(false);
  });

  it("an image upload to a core host goes over the host's reader; UploadService unchanged; × removes it", async () => {
    const mac = makeFakeMac({ herdr: false });
    const machine = new CoreLocalMachine(mac, claudeCore());
    const backend = machineBackend(machine, false);
    expect(await coreOnly(backend)).toBe(true);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    const log: UploadSweepLog = { lastSweep: () => null, noteSweep: () => undefined };
    const uploads = new UploadService({ backend: (id) => (id === "studio" ? backend : null) }, log);
    const uploaded = await uploads.upload("studio", png, "png");
    expect(uploaded.byteCount).toBe(png.length);
    expect(isOwnedUploadPath(uploaded.path, mac.home)).toBe(true);
    expect(readFileSync(uploaded.path).equals(png)).toBe(true);
    expect(uploads.names(uploaded.path)).toBe(true);
    // The same uploads as the TUI backend's (its discard included).
    expect(backend.uploads()?.machineKey).toBe("me@studio.invalid:22");
    expect(backend.core.uploads()?.machineKey).toBe("me@studio.invalid:22");
    await uploads.discard("studio", uploaded.path);
    expect(() => readFileSync(uploaded.path)).toThrow();
  });
});
