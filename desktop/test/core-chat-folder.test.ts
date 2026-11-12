// Chat on a herdr-core Claude or Codex pane
// whose argv names no session, through the app (CoreChatSessionTests'
// required cases, end to end): each snapshot HostRegistry applies is numbered
// and handed to the host's finder (HerdrMachineBackend.observeSnapshot), the
// one read-only lookup runs on the host's existing exec (the TUI backend's
// SshTranscriptReader, here this computer's local session on a temp home,
// FakeMac), the core shows what it proved (`core_found`), and Chat binds it.
// The agent's process is this test's own (`ps` reads its start); every
// transcript written since it started is dated ahead.

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { HerdrMachineBackend } from "../src/main/herdr/core-host";
import type { CoreFollowerOptions } from "../src/main/herdr/core-follower";
import { CoreBackoff } from "../src/main/herdr/core-session";
import { MemoryPinStore, PinningHostKeyPolicy } from "../src/main/herdr/host-key-pinning";
import { HostRegistry } from "../src/main/hosts";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { reply, session, user } from "./support/chat-lines";
import { eventually, pause } from "./support/core-test-link";
import { CoreLocalMachine } from "./support/core-local-machine";
import { FakeCore } from "./support/fake-core";
import { closeFakeMacs, makeFakeMac } from "./support/this-mac-fake";

/** The fixture transcript's own folder (chat-lines.ts). */
const folder = "/Users/fixture/proj";
const me = process.pid;
/** The refusal's kind (core-pane-session.ts claudeAmbiguousKind), spelled out so this file also runs where there is none. */
const claudeAmbiguousKind = "claude-ambiguous";
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

const backends: HerdrMachineBackend[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const backend of backends.splice(0)) backend.close();
  await closeFakeMacs();
});

/** A plain agent terminal: its argv names no session; its foreground is this test's process. */
function plain(address: string, kind: "claude" | "codex", pid = me): ReturnType<typeof FakeCore.terminal> {
  return FakeCore.terminal(address, { argv: [kind], cwd: folder, status: FakeCore.status("idle", kind), foreground: FakeCore.foreground(kind, [kind], folder, pid), pid });
}

function host(terminals: ReturnType<typeof FakeCore.terminal>[], write: (home: string) => void): { hosts: HostRegistry; service: ChatService; machine: CoreLocalMachine } {
  const mac = makeFakeMac({ herdr: false });
  write(mac.home);
  const core = new FakeCore(terminals);
  core.setDocument("herdr-app", FakeCore.layout([{ id: "s1", name: "App", folder, tabs: [{ id: "tA", name: "Main", terminals: terminals.map((t) => (t as { address: string }).address) }] }]));
  const machine = new CoreLocalMachine(mac, core);
  const backend = new HerdrMachineBackend(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
    route: { connect: machine.connect },
    backoff: new CoreBackoff(0.01, 0.02),
    follower: fastFollower,
  });
  backends.push(backend);
  const hosts = new HostRegistry(() => undefined);
  closers.push(() => hosts.close());
  hosts.add({ id: "studio", name: "studio", kind: "ssh", address: "me@studio.invalid:22", platform: "macOS" }, backend);
  const service = new ChatService(hosts, "chat", { pollIntervalMs: 5 });
  closers.push(() => service.closeAll());
  return { hosts, service, machine };
}

function ahead(file: string, seconds: number): void {
  const at = Date.now() / 1000 + seconds;
  utimesSync(file, at, at);
}

function claudeTranscript(home: string, id: string, lines: readonly string[], seconds: number): string {
  const projects = path.join(home, ".claude", "projects", "-Users-fixture-proj");
  mkdirSync(projects, { recursive: true });
  const file = path.join(projects, `${id}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  ahead(file, seconds);
  return file;
}

const texts = (page: Page): string[] =>
  page.last?.timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? [item.value.text] : []))) ?? [];

describe.skipIf(process.platform !== "darwin")("Chat on a plain herdr-core agent pane", () => {
  it("a plain Claude pane gets Chat with its folder's newest Claude transcript, found on the host's read-only exec", async () => {
    const { hosts, service, machine } = host([plain("t1", "claude")], (home) => {
      claudeTranscript(home, session, [user("hello from the plain core pane", "u1", 1), reply("hi there", "a1", 2, true)], 10);
    });
    expect(await eventually(() => hosts.agent("studio", "hc:t1")?.coreFound !== undefined, 1_000)).toBe(true);
    const agent = hosts.agent("studio", "hc:t1");
    expect(agent?.coreFound).toMatchObject({ source: "herdr:claude", agent: "claude", kind: "id", value: session, foundIn: folder });
    expect(agent?.agentSession, "identity (Send, Stop, Restart) stays the argv's").toBeUndefined();
    // The one lookup on the existing exec, no other remote primitive.
    expect(machine.commands.some((command) => command.startsWith("/usr/bin/perl -e ") && command.includes("lstart=") && command.includes(` -- 'claude' '${me}' '${folder}'`))).toBe(true);

    const page = new Page(1);
    service.open(page, "studio", "hc:t1");
    expect(await eventually(() => page.last?.state.status === "live", 1_000)).toBe(true);
    expect(texts(page)).toEqual(["hello from the plain core pane"]);
  });

  it("a plain Codex pane gets Chat with its folder's newest rollout", async () => {
    const id = "019a3c2f-8e52-7c31-8a4f-3d2e1f0a9b8c";
    const { hosts, service } = host([plain("t2", "codex")], (home) => {
      const day = path.join(home, ".codex/sessions/2026/11/08");
      mkdirSync(day, { recursive: true });
      const file = path.join(day, `rollout-2026-11-08T21-00-00-${id}.jsonl`);
      writeFileSync(
        file,
        [
          JSON.stringify({ payload: { cli_version: "0.166.0", cwd: folder, id, originator: "codex_cli_rs", source: "cli", timestamp: "2026-11-08T21:00:00.000Z" }, timestamp: "2026-11-08T21:00:00.000Z", type: "session_meta" }),
          JSON.stringify({ payload: { turn_id: "turn-a", type: "task_started" }, timestamp: "2026-11-08T21:00:01.000Z", type: "event_msg" }),
          JSON.stringify({ payload: { content: [{ text: "the newest in the folder", type: "input_text" }], id: "m1", role: "user", type: "message" }, timestamp: "2026-11-08T21:00:01.100Z", type: "response_item" }),
        ].join("\n") + "\n",
      );
      ahead(file, 20);
    });
    expect(await eventually(() => hosts.agent("studio", "hc:t2")?.coreFound?.value === id, 1_000)).toBe(true);
    const page = new Page(1);
    service.open(page, "studio", "hc:t2");
    expect(await eventually(() => page.last?.state.status === "live", 1_000)).toBe(true);
  });

  it("two plain Claude panes in one folder: no guess, Chat says why", async () => {
    const { hosts, service, machine } = host([plain("t1", "claude"), plain("t2", "claude", process.ppid)], (home) => {
      claudeTranscript(home, session, [user("one of theirs", "u1", 1)], 10);
    });
    expect(await eventually(() => hosts.agent("studio", "hc:t1")?.coreFound?.kind === claudeAmbiguousKind && hosts.agent("studio", "hc:t2")?.coreFound?.kind === claudeAmbiguousKind, 1_000)).toBe(true);
    expect(machine.commands.some((command) => command.includes("lstart=")), "nothing looked up").toBe(false);
    const page = new Page(1);
    service.open(page, "studio", "hc:t1");
    expect(await eventually(() => page.last?.state.status === "unavailable", 1_000)).toBe(true);
    expect(page.last?.state).toEqual({ status: "unavailable", reason: "ambiguousClaudeSession" });
  });

  // A pane on a machine the core added, its argv naming no
  // session, never shows this host's Claude transcript of the same folder; it says no session until reads go there.
  it("a foreign core Claude pane naming no session never shows the saved host's transcript of its folder", async () => {
    const { hosts, service, machine } = host([plain("other/t1", "claude")], (home) => {
      claudeTranscript(home, session, [user("connected host transcript, not foreign machine", "u1", 1)], 10);
    });
    expect(await eventually(() => hosts.agent("studio", "hc:other/t1") !== null, 1_000)).toBe(true);
    const page = new Page(1);
    service.open(page, "studio", "hc:other/t1");
    expect(await eventually(() => page.last?.state.status === "unavailable", 1_000)).toBe(true);
    expect(page.last?.state).toEqual({ status: "unavailable", reason: "noSession" });
    // And it stays so: no later read takes up this host's transcript.
    await pause(200);
    expect(page.updates.some((update) => update.state.status === "live")).toBe(false);
    expect(texts(page)).toEqual([]);
    expect(hosts.agent("studio", "hc:other/t1")?.coreFound).toBeUndefined();
    expect(machine.commands.some((command) => command.includes("lstart=")), "no lookup for another machine's pane").toBe(false);
  });
});
