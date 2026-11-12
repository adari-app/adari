// The main process's "While you were away" (src/main/away/service.ts), ported
// from the Swift app's CompanionAwayModelTests: a visit is the window's focus;
// each connected machine is read once per visit since the user last looked (12
// hours the first time); `since` moves at the visit's end only for a digest the
// user was shown; Mark all seen makes it now and clears the cards; machines that do not
// answer get a line; leaving stops the reads. Also the since store's file and
// the SSH reader's capped command run. Fixtures only: fake machines, fake
// transcripts, a fake ssh2 channel; the store's file is in a temp folder.

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";

import { AwayService, type AwayHosts } from "../src/main/away/service";
import { FileSinceStore, MemorySinceStore, maxSinceEntries } from "../src/main/away/since-store";
import { SshTranscriptReader, cappedExec } from "../src/main/chat/ssh-reader";
import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { decodeSessionTopology, type SessionTopology } from "../src/main/herdr/wire";
import { TranscriptNotFoundError, type TranscriptFileReader } from "../src/shared/chat/feed";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import type { AwayViewState } from "../src/shared/away/digest";
import { CancelledError, withDeadline, type RemoteCommand, type RemoteCommandRunner } from "../src/shared/remote-command";
import type { HostView } from "../src/shared/ipc-contract";
import { json } from "./support/chat-lines";

const date = (iso: string): number => Date.parse(iso) / 1000;
const start = date("2026-11-02T09:00:00.000Z");
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
const transcriptPath = "/home/me/.claude/projects/-srv-app/5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f.jsonl";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** One finished exchange at `time` (the reply 30 s later). */
function exchange(time: number, index: number): string {
  return (
    json({ type: "user", uuid: `u${index}`, timestamp: iso(time), cwd: "/srv/app", isSidechain: false, message: { role: "user", content: `Question ${index}` } }) +
    "\n" +
    json({
      type: "assistant",
      uuid: `a${index}`,
      timestamp: iso(time + 30),
      isSidechain: false,
      message: { id: `msg_${index}`, role: "assistant", type: "message", stop_reason: "end_turn", content: [{ type: "text", text: `Answer ${index}` }] },
    }) +
    "\n"
  );
}

/** One workspace, one Claude agent in /srv/app, finished, its transcript named by path. */
function topology(): SessionTopology {
  return decodeSessionTopology({
    version: "0.9.5",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", number: 1, label: "app", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "done" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "done" }],
    panes: [{ pane_id: "p1", terminal_id: "t-p1", workspace_id: "w1", tab_id: "w1:t1", focused: true, cwd: "/srv/app", agent: "claude", agent_status: "done", revision: 1 }],
    layouts: [],
    agents: [
      { pane_id: "p1", agent: "claude", agent_status: "done", cwd: "/srv/app", agent_session: { source: "herdr:claude", agent: "claude", kind: "path", value: transcriptPath } },
    ],
  });
}

class FakeTranscripts implements TranscriptFileReader<TranscriptSessionRef> {
  text = "";
  locates = 0;
  /** While set, reads wait for `release`. */
  hold = false;
  private waiting: (() => void)[] = [];

  locate(): Promise<string | null> {
    this.locates += 1;
    return Promise.resolve(transcriptPath);
  }
  size(file: string): Promise<number> {
    if (file !== transcriptPath) return Promise.reject(new TranscriptNotFoundError(file));
    return Promise.resolve(Buffer.byteLength(this.text));
  }
  async read(_file: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    if (this.hold) await new Promise<void>((resolve) => this.waiting.push(resolve));
    return new Uint8Array(Buffer.from(this.text).subarray(offset, offset + maxBytes));
  }
  release(): void {
    this.hold = false;
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

class FakeGit implements RemoteCommandRunner {
  readonly commands: RemoteCommand[] = [];
  output = "";
  run(command: RemoteCommand): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    this.commands.push(command);
    return Promise.resolve({ bytes: new Uint8Array(Buffer.from(this.output)), truncated: false });
  }
}

class FakeHosts implements AwayHosts {
  readonly views = new Map<string, HostView>();
  readonly backends = new Map<string, HerdrHostBackend>();
  refreshes = 0;
  listen: () => void = () => undefined;

  add(id: string, state: HostView["state"], transcripts: FakeTranscripts | null, git: FakeGit | null = null, fetchedAtMs: number | null = start * 1000): void {
    this.views.set(id, {
      id,
      name: id === "studio" ? "Studio" : id,
      kind: "ssh",
      address: `me@${id}:22`,
      platform: "macOS",
      state,
      error: null,
      topology: state === "connected" ? topology() : null,
      fetchedAtMs,
    });
    this.backends.set(id, { transcripts: () => transcripts, commands: () => git } as unknown as HerdrHostBackend);
  }
  set(id: string, state: HostView["state"], fetchedAtMs: number | null = null): void {
    const view = this.views.get(id)!;
    this.views.set(id, { ...view, state, topology: state === "connected" ? topology() : view.topology, fetchedAtMs: fetchedAtMs ?? view.fetchedAtMs });
  }
  list(): HostView[] {
    return [...this.views.values()];
  }
  backend(id: string): HerdrHostBackend | null {
    return this.backends.get(id) ?? null;
  }
  refreshAll(): Promise<HostView[]> {
    this.refreshes += 1;
    return Promise.resolve(this.list());
  }
}

function service(hosts: FakeHosts, store = new MemorySinceStore()) {
  const clock = { now: start };
  const sent: AwayViewState[] = [];
  const away = new AwayService({ hosts, store, send: (state) => sent.push(state), now: () => clock.now });
  return { away, clock, sent, store };
}

describe("the away service's visits", () => {
  it("reads each connected machine once a visit, since 12 hours ago the first time", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 13 * 3600, 0) + exchange(start - 2 * 3600, 1) + exchange(start - 3600, 2);
    hosts.add("studio", "connected", transcripts);
    const { away, sent } = service(hosts);

    away.focus();
    expect(sent[0]).toEqual({ digest: null, building: true, seenAt: null });
    await flush();
    const state = away.state;
    expect(state.building).toBe(false);
    expect(state.digest?.cards.map((card) => [card.id, card.group, card.turnsFinished, card.lastReply?.lines])).toEqual([
      ["studio|p1", "finished", 2, ["Answer 2"]],
    ]);
    expect(hosts.refreshes).toBe(1);
    expect(transcripts.locates).toBe(1);

    away.hostsChanged();
    away.focus();
    await flush();
    expect(transcripts.locates).toBe(1);
  });

  it("moves since to the visit's end only when the user was shown the digest", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3600, 0);
    hosts.add("studio", "connected", transcripts);
    const { away, clock, store } = service(hosts);

    away.focus();
    await flush();
    clock.now = start + 600;
    away.blur();
    expect(store.get("studio")).toBeNull();

    clock.now = start + 1200;
    away.focus();
    await flush();
    expect(away.state.digest?.cards[0]?.turnsFinished).toBe(1);
    away.shown();
    clock.now = start + 1800;
    away.blur();
    expect(store.get("studio")).toBe(start + 1800);

    // The next visit reads since then: nothing new.
    clock.now = start + 3600;
    away.focus();
    await flush();
    expect(away.state.digest?.cards.map((card) => [card.turnsFinished, card.isNew])).toEqual([[0, false]]);
  });

  it("a digest that arrives after the user was shown the last one waits to be shown again", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3600, 0);
    hosts.add("studio", "connected", transcripts);
    const { away, store } = service(hosts);
    away.focus();
    // Shown before any digest: nothing to acknowledge.
    away.shown();
    await flush();
    away.blur();
    expect(store.get("studio")).toBeNull();
  });

  it("Mark all seen makes since now and clears the cards", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3600, 0);
    hosts.add("studio", "connected", transcripts);
    const { away, clock, store, sent } = service(hosts);
    away.focus();
    await flush();
    clock.now = start + 60;
    away.markAllSeen();
    expect(store.get("studio")).toBe(start + 60);
    expect(away.state.digest?.cards).toEqual([]);
    expect(away.state.seenAt).toBe(start + 60);
    expect(sent.at(-1)).toBe(away.state);
    // Leaving later keeps it (the user saw nothing more).
    clock.now = start + 120;
    away.blur();
    expect(store.get("studio")).toBe(start + 120);
  });

  it("acknowledges a machine that stops answering only through when it stopped", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3600, 0);
    hosts.add("studio", "connected", transcripts);
    hosts.add("laptop", "connected", new FakeTranscripts());
    const { away, clock, store } = service(hosts);
    away.focus();
    await flush();
    expect(away.state.digest?.cards[0]?.isNew).toBe(true);
    away.shown();
    // Studio goes offline at +20 s while the window keeps focus; Laptop keeps answering.
    clock.now = start + 20;
    hosts.set("studio", "offline");
    away.hostsChanged();
    // The old offline digest stays on screen but knows nothing after the disconnect.
    away.shown();
    clock.now = start + 40;
    away.blur();
    expect(store.get("studio")).toBe(start + 20);
    expect(store.get("laptop")).toBe(start + 40);
  });

  it("a machine that reconnects in the same visit keeps the boundary where it stopped; Mark all seen does not pass it", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3600, 0);
    hosts.add("studio", "connected", transcripts);
    const { away, clock, store } = service(hosts);
    away.focus();
    await flush();
    away.shown();
    clock.now = start + 20;
    hosts.set("studio", "connecting");
    away.hostsChanged();
    clock.now = start + 30;
    hosts.set("studio", "connected");
    away.hostsChanged();
    await flush();
    // Read once a visit: the work after +20 s has not been read.
    expect(transcripts.locates).toBe(1);
    clock.now = start + 50;
    away.markAllSeen();
    expect(store.get("studio")).toBe(start + 20);
    clock.now = start + 60;
    away.blur();
    expect(store.get("studio")).toBe(start + 20);
  });

  it("a machine that stops answering while it is still being read is acknowledged only through then", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3600, 0);
    transcripts.hold = true;
    hosts.add("studio", "connected", transcripts);
    const { away, clock, store } = service(hosts);
    away.focus();
    await flush();
    clock.now = start + 20;
    hosts.set("studio", "offline");
    away.hostsChanged();
    transcripts.release();
    await flush();
    away.shown();
    clock.now = start + 40;
    away.blur();
    expect(store.get("studio")).not.toBe(start + 40);
  });

  it("a digest first shown after its machine stopped answering is not acknowledged", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3600, 0);
    hosts.add("studio", "connected", transcripts);
    const store = new MemorySinceStore();
    store.set("studio", start - 7200);
    const { away, clock } = service(hosts, store);
    away.focus();
    await flush();
    clock.now = start + 20;
    hosts.set("studio", "offline");
    away.hostsChanged();
    away.shown();
    clock.now = start + 40;
    away.blur();
    expect(store.get("studio")).toBe(start - 7200);
  });

  it("uses the stored since: turns before it are not news", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 3 * 3600, 0) + exchange(start - 600, 1);
    hosts.add("studio", "connected", transcripts);
    const store = new MemorySinceStore();
    store.set("studio", start - 3600);
    const { away } = service(hosts, store);
    away.focus();
    await flush();
    expect(away.state.digest?.cards[0]?.turnsFinished).toBe(1);
  });

  it("reads git in the agents' folders with the machine's runner", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    const git = new FakeGit();
    git.output = `abcdef0123456789abcdef0123456789abcdef01\u001f${start - 300}\u001fFix the login\u001e`;
    hosts.add("studio", "connected", transcripts, git);
    const { away } = service(hosts);
    away.focus();
    await flush();
    expect(git.commands.map((command) => command.intent)).toEqual([{ kind: "git-log", folder: "/srv/app", since: start - 12 * 3600, maxCount: 50 }]);
    const card = away.state.digest!.cards[0]!;
    expect([card.commitCount, card.commits.map((commit) => commit.subject), card.group]).toEqual([1, ["Fix the login"], "finished"]);
  });

  it("gives an offline machine a line, and reads one that connects later in the visit", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 600, 0);
    hosts.add("studio", "offline", transcripts, null, (start - 7200) * 1000);
    hosts.add("lab", "connecting", new FakeTranscripts(), null, null);
    const { away } = service(hosts);
    away.focus();
    await flush();
    expect(away.state.building).toBe(true);
    expect(away.state.digest?.macs).toEqual([{ id: "studio", name: "Studio", state: { kind: "offline", since: start - 7200 } }]);

    hosts.set("studio", "connected", start * 1000);
    hosts.set("lab", "offline");
    away.hostsChanged();
    await flush();
    expect(away.state.building).toBe(false);
    expect(away.state.digest?.cards.map((card) => card.id)).toEqual(["studio|p1"]);
    expect(away.state.digest?.macs.map((line) => [line.id, line.state.kind])).toEqual([
      ["studio", "online"],
      ["lab", "notConnected"],
    ]);
  });

  it("leaving stops the reads: what was on its way is not shown", async () => {
    const hosts = new FakeHosts();
    const transcripts = new FakeTranscripts();
    transcripts.text = exchange(start - 600, 0);
    transcripts.hold = true;
    hosts.add("studio", "connected", transcripts);
    const { away, store } = service(hosts);
    away.focus();
    await flush();
    expect(away.state.building).toBe(true);
    away.shown();
    away.blur();
    expect(away.state.building).toBe(false);
    transcripts.release();
    await flush();
    expect(away.state.digest).toBeNull();
    expect(store.get("studio")).toBeNull();
  });
});

describe("the since store", () => {
  it("keeps at most 64 machines, the most recent", () => {
    const store = new MemorySinceStore();
    for (let i = 0; i < maxSinceEntries + 3; i += 1) store.set(`m${i}`, i);
    expect(store.get("m0")).toBeNull();
    expect(store.get("m2")).toBeNull();
    expect(store.get("m3")).toBe(3);
    expect(store.entries.size).toBe(maxSinceEntries);
  });

  it("saves to its file (owner only) and reads it back; a broken file is empty", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "away-since-"));
    const file = path.join(folder, "away-since.json");
    new FileSinceStore(file).set("studio", 1234.5);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ studio: 1234.5 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new FileSinceStore(file).get("studio")).toBe(1234.5);
    expect(new FileSinceStore(path.join(folder, "none.json")).get("studio")).toBeNull();
  });
});

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

describe("the SSH reader's command run", () => {
  function client(chunks: string[]) {
    const channel = new FakeChannel();
    const fake = {
      commands: [] as string[],
      exec(command: string, cb: (error: Error | undefined, channel: FakeChannel) => void) {
        fake.commands.push(command);
        cb(undefined, channel);
        queueMicrotask(() => {
          for (const chunk of chunks) if (!channel.closed) channel.emit("data", Buffer.from(chunk));
          channel.close();
        });
      },
    };
    return { fake, channel, asClient: fake as unknown as Client };
  }

  it("gives stdout up to the cap and closes the channel past it", async () => {
    const { fake, channel, asClient } = client(["hello ", "world, and more"]);
    const output = await cappedExec(asClient, "/bin/sh -c 'x'", 8);
    expect(Buffer.from(output.bytes).toString()).toBe("hello wo");
    expect(output.truncated).toBe(true);
    expect(channel.closed).toBe(true);
    expect(fake.commands).toEqual(["/bin/sh -c 'x'"]);
  });

  it("gives all of a short output", async () => {
    const { asClient } = client(["a\n", "b\n"]);
    const output = await cappedExec(asClient, "true", 64);
    expect([Buffer.from(output.bytes).toString(), output.truncated]).toEqual(["a\nb\n", false]);
  });

  it("an abort closes the channel and rejects", async () => {
    const channel = new FakeChannel();
    const asClient = { exec: (_: string, cb: (error: undefined, channel: FakeChannel) => void) => cb(undefined, channel) } as unknown as Client;
    const abort = new AbortController();
    const running = cappedExec(asClient, "sleep 9", 64, abort.signal);
    abort.abort();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(channel.closed).toBe(true);
  });
});

/** An SSH client whose SFTP setup waits until the test lets it finish. */
class HeldSsh extends EventEmitter {
  readonly commands: string[] = [];
  ended = false;
  private ready: ((error: Error | undefined, sftp: object) => void) | null = null;
  sftp(cb: (error: Error | undefined, sftp: object) => void): void {
    this.ready = cb;
  }
  get waiting(): boolean {
    return this.ready !== null;
  }
  finishSetup(): void {
    this.ready?.(undefined, {});
  }
  exec(command: string, cb: (error: Error | undefined, channel: FakeChannel) => void): void {
    this.commands.push(command);
    const channel = new FakeChannel();
    cb(undefined, channel);
    queueMicrotask(() => {
      if (!channel.closed) channel.emit("data", Buffer.from("out"));
      channel.close();
    });
  }
  end(): void {
    this.ended = true;
  }
}

describe("the SSH reader's command run during link setup", () => {
  const config = { host: "box", port: 22, username: "me", privateKeyPath: "/k", herdrSession: "default" };
  const grep: RemoteCommand = { text: "/bin/sh -c 'grep needle'", intent: { kind: "git-log", folder: "/srv", since: 0, maxCount: 1 } };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it("a command cancelled while the link is made settles at once, is never sent, and leaves the link to Chat", async () => {
    const ssh = new HeldSsh();
    const reader = new SshTranscriptReader(config, {} as never, { timeoutMs: 60_000, connect: async () => ssh as unknown as Client });
    const abort = new AbortController();
    const running = reader.run(grep, 64, abort.signal).catch((error: unknown) => error);
    await settle();
    expect(ssh.waiting).toBe(true);
    abort.abort();
    expect(await running).toBeInstanceOf(CancelledError);
    ssh.finishSetup();
    await settle();
    expect(ssh.commands).toEqual([]);
    expect(ssh.ended).toBe(false);
    // The same link runs the next command.
    const next = await reader.run(grep, 64);
    expect(Buffer.from(next.bytes).toString()).toBe("out");
    expect(ssh.commands).toEqual([grep.text]);
    reader.close();
  });

  it("a command whose deadline passed while the link was made is never sent", async () => {
    const ssh = new HeldSsh();
    const reader = new SshTranscriptReader(config, {} as never, { timeoutMs: 60_000, connect: async () => ssh as unknown as Client });
    const result = await withDeadline(
      5,
      (signal) => reader.run(grep, 64, signal),
      () => new Error("deadline"),
    ).catch((error: unknown) => error);
    expect((result as Error).message).toBe("deadline");
    ssh.finishSetup();
    await settle();
    expect(ssh.commands).toEqual([]);
    reader.close();
  });

  it("cappedExec sends nothing for a signal already aborted", async () => {
    const ssh = new HeldSsh();
    const abort = new AbortController();
    abort.abort();
    await expect(cappedExec(ssh as unknown as Client, "true", 64, abort.signal)).rejects.toBeInstanceOf(CancelledError);
    expect(ssh.commands).toEqual([]);
  });
});

describe("the demo machines", () => {
  it("give a digest of their demo agents, with the fixture commits git log would print", async () => {
    const { HostRegistry } = await import("../src/main/hosts");
    const { DemoBackend } = await import("../src/main/demo/demo-backend");
    const { demoHosts } = await import("../src/main/demo/demo-hosts");
    const { bundledFixturesForTests } = await import("./support/demo-fixtures");
    const fixtures = bundledFixturesForTests();
    const startMs = Date.UTC(2026, 10, 2, 9, 0, 0);
    let away: AwayService | null = null;
    const registry = new HostRegistry(() => away?.hostsChanged());
    for (const host of demoHosts(fixtures, startMs)) registry.add(host.descriptor, new DemoBackend(host, fixtures, undefined, () => startMs));
    await registry.refreshAll();
    away = new AwayService({ hosts: registry, store: new MemorySinceStore(), send: () => undefined, now: () => startMs / 1000 });
    away.focus();
    for (let i = 0; i < 20 && (away.state.building || away.state.digest === null); i += 1) await flush();
    const digest = away.state.digest!;
    const mac = digest.cards.find((card) => card.folder === "/Users/demo/code/worktrees/aurora-web-mac" && card.commitCount > 0)!;
    expect(mac.commits.map((commit) => commit.subject)).toEqual([
      "Mac app: the sidebar keeps its folds across launches",
      "Mac app: pane titles follow Herdr's labels",
    ]);
    const read = digest.cards.filter((card) => card.transcript === "read");
    // The demo's chats include a fourth one (a Mac mini pane with code in many languages), the 4-pane tab's two
    // live ones (w7:pS1 and w7:pS3, working), Mac mini's Grok pane (wD:pK), found by its folder, and its two
    // background-work panes (wB:p1 running, wD:p1 ended).
    expect(read.length).toBe(9);
    expect(read.some((card) => card.paneID === "wB:p1") && read.some((card) => card.paneID === "wD:p1")).toBe(true);
    expect(read.some((card) => card.paneID === "wD:pK")).toBe(true);
    expect(read.some((card) => card.paneID === "w6:p1")).toBe(true);
    expect(read.filter((card) => card.paneID === "w7:pS1" || card.paneID === "w7:pS3")).toHaveLength(2);
    expect(read.some((card) => card.lastReply !== null)).toBe(true);
    expect(digest.cards.length).toBeGreaterThan(10);
    away.close();
    registry.close();
  });
});
