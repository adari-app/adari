// The relay's send path, its start, liveness, resubscribe and launch cache.
// Fakes only: no SSH, no Herdr, no socket.

const registered = vi.hoisted(() => ({ handles: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => registered.handles.set(channel, listener),
    on: () => undefined,
  },
}));

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deliver, sendBound, unconfirmedText } from "../src/main/herdr/send";
import { RequestTimedOutError } from "../src/main/herdr/errors";
import { RelayClient } from "../src/main/herdr/relay";
import { SshHerdrTransport } from "../src/main/herdr/ssh";
import { HostRegistry } from "../src/main/hosts";
import { LaunchCache } from "../src/main/launch-cache";
import { AgentSettingsReader, tapReader } from "../src/shared/agent-settings";
import { ChatFeed } from "../src/shared/chat/feed";
import { IPC } from "../src/shared/ipc-contract";
import { claudeScreen } from "./support/claude-screens";
import { claudeSession, reply, result, shown, text, tool, user, whole } from "./support/chat-lines";

const { registerIpc } = await import("../src/main/ipc");
const { APP_ORIGIN } = await import("../src/main/protocol");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const pane = (kind = "claude", id = "w1:p1") => ({ paneID: id, terminalID: "t1", workspaceID: "w1", tabID: "w1:t1", focused: false, agent: kind, agentStatus: "idle", revision: 1 });
const agent = (kind = "claude", session = "s1") => ({ paneID: "w1:p1", agent: kind, terminalID: "t1", agentSession: { source: "herdr:" + kind, agent: kind, kind: "id", value: session } });
const binding = (kind = "claude") => ({ terminalID: "t1", isAgent: true, kind, session: "s1" });
const outcome = (sending: Promise<void>): Promise<string> =>
  sending.then(
    () => "sent",
    (error: Error) => error.message,
  );

/** A relay channel said hello; `out` feeds it a frame, `sent` what the client wrote. */
function relay() {
  const sent: Record<string, unknown>[] = [];
  const client = new RelayClient({ write: (line) => void sent.push(JSON.parse(line) as Record<string, unknown>), close: () => undefined }, "/fake/socket");
  client.data(Buffer.from('{"relay":"hello","v":1}\n'));
  return { client, sent, out: (frame: unknown) => client.data(Buffer.from(JSON.stringify(frame) + "\n")) };
}
const request = (id: string) => JSON.stringify({ id, method: "agent.list", params: {} });

describe("a refused clear of Claude's box stays due", () => {
  it("the retry reads the box again and refuses again; nothing is sent", async () => {
    const sent: string[] = [];
    let due = true;
    let reads = 0;
    const site = {
      fresh: async () => true,
      pane: () => pane(),
      agent: () => agent(),
      writer: { prompt: async (_pane: string, line: string) => void sent.push(line), sendInput: async () => undefined, sendText: async () => undefined, agentKeys: async () => undefined },
      box: {
        site: { read: async () => (reads++, claudeScreen({ draft: "old own message" })), keys: async () => undefined, wait: async () => undefined },
        own: () => ["old own message"],
        sent: () => undefined,
        due: () => due,
        checked: () => void (due = false),
        failed: () => void (due = true),
      },
    };
    const first = await outcome(sendBound(site as never, "w1:p1", "next", binding()));
    const second = await outcome(sendBound(site as never, "w1:p1", "next", binding()));
    expect(first).toContain("Not sent");
    expect({ second, sent }).toEqual({ second: expect.stringContaining("Not sent"), sent: [] });
    expect(reads).toBeGreaterThanOrEqual(6);
  });
});

describe("relay off, a send keeps today's checks", () => {
  it("a session change during the paste still prevents the Return (the fresh check before it)", async () => {
    let remote = agent("opencode");
    let cached = remote;
    const writes: string[] = [];
    const site = {
      fresh: async () => ((cached = remote), true),
      pane: () => pane("opencode"),
      agent: () => cached,
      writer: {
        prompt: async () => undefined,
        sendInput: async () => undefined,
        sendText: async () => {
          writes.push("paste");
          remote = agent("opencode", "s2");
        },
        agentKeys: async () => void writes.push("Return"),
      },
    };
    const result = await outcome(sendBound(site as never, "w1:p1", "hello", binding("opencode")));
    expect({ result, writes }).toEqual({ result: expect.stringContaining("another agent"), writes: ["paste"] });
  });

  it("the Send IPC reads Claude's box before every send while the events are not live", async () => {
    const log: string[] = [];
    const backend = {
      promptIO: () => ({ paneRead: async () => (log.push("read"), claudeScreen()) }),
      prompt: async () => void log.push("prompt"),
      agentKeys: async () => undefined,
      sendText: async () => undefined,
      sendInput: async () => undefined,
    };
    const hosts = { backend: () => backend, pane: () => pane(), agent: () => agent(), run: () => null, fresh: async () => (log.push("fresh"), true), refresh: async () => undefined };
    registerIpc({ hosts } as never);
    const send = registered.handles.get(IPC.paneSend)!;
    await send({ senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } }, "h", "w1:p1", "hello", binding());
    await send({ senderFrame: { url: APP_ORIGIN }, sender: { id: 1 } }, "h", "w1:p1", "again", binding());
    expect(log).toEqual(["read", "fresh", "prompt", "read", "fresh", "prompt"]);
  });
});

describe("the relay's start is bounded", () => {
  function stalled() {
    const fake = Object.assign(new EventEmitter(), {
      exec: () => undefined,
      end: () => {
        fake.emit("end");
        fake.emit("close");
      },
    });
    return fake;
  }

  it("a request's deadline settles it when the relay exec never opens, and close leaves nothing pending", async () => {
    const fake = stalled();
    const transport = new SshHerdrTransport({ host: "fake.invalid", port: 22, username: "fixture", herdrSession: "fixture" } as never, {} as never, {
      connect: async () => fake,
      relayScript: "# fake",
      roundTripTimeoutMs: 1000,
    } as never);
    let result = "pending";
    void transport.roundTrip(request("deadline")).then(
      () => (result = "answered"),
      (error: Error) => (result = error.message),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBe("the host did not answer within 1 seconds");
    let ready = "pending";
    void transport.readyRelay().then((held) => (ready = held === null ? "none" : "relay"));
    transport.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe("none");
  });

  it("the hello's 5 s run from the exec-open attempt; a channel after that is closed", async () => {
    let answer: ((error: Error | undefined, channel: unknown) => void) | null = null;
    const fake = Object.assign(stalled(), { exec: (_command: string, callback: (error: Error | undefined, channel: unknown) => void) => void (answer = callback) });
    const transport = new SshHerdrTransport({ host: "fake.invalid", port: 22, username: "fixture", herdrSession: "fixture" } as never, {} as never, {
      connect: async () => fake,
      relayScript: "# fake",
    } as never);
    let relay = "pending";
    void transport.openRelay().then((held) => (relay = held === null ? "exec path" : "relay"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(relay).toBe("exec path");
    let closed = 0;
    answer!(undefined, Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write: () => true, close: () => void (closed += 1) }));
    expect(closed).toBe(1);
    transport.close();
  });

  it("the connection closing settles the start (the exec path) at once", async () => {
    const fake = stalled();
    const transport = new SshHerdrTransport({ host: "fake.invalid", port: 22, username: "fixture", herdrSession: "fixture" } as never, {} as never, {
      connect: async () => fake,
      relayScript: "# fake",
    } as never);
    let relay = "pending";
    void transport.openRelay().then((held) => (relay = held === null ? "exec path" : "relay"));
    await vi.advanceTimersByTimeAsync(10);
    fake.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(relay).toBe("exec path");
    transport.close();
  });
});

describe("a prompt written to the relay whose deadline passed is not confirmed either way", () => {
  it("lands after its deadline: the note never says the agent did not take it", async () => {
    const r = relay();
    let applied = false;
    let note = "pending";
    const sending = deliver(
      {
        prompt: async () => {
          setTimeout(() => {
            applied = true;
            r.out({ id: String(r.sent.at(-1)!["id"]), result: {} });
          }, 200);
          await r.client.request(JSON.stringify({ id: "prompt", method: "agent.prompt", params: { target: "p", text: "hello" } }), 100);
        },
        sendInput: async () => undefined,
      },
      "p",
      { kind: "prompt", text: "hello" },
      "claude",
    ).catch((error: Error) => void (note = error.message));
    await vi.advanceTimersByTimeAsync(100);
    await sending;
    await vi.advanceTimersByTimeAsync(100);
    expect(applied).toBe(true);
    expect(note).toBe(unconfirmedText);
    r.client.close();
  });

  // Only a prompt proved unwritten keeps the definite note.
  it("a prompt that never left the app (unwritten) keeps the definite note", async () => {
    const note = await outcome(deliver({ prompt: async () => Promise.reject(new RequestTimedOutError(60)), sendInput: async () => undefined }, "p", { kind: "prompt", text: "hello" }, "claude"));
    expect(note).toBe("Not sent: Claude Code did not take the message. It is still in the box.");
  });

  it("a prompt handed to SSH on the exec path whose deadline passed is not confirmed, though its client is ended", async () => {
    let applied = 0;
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write: () => true, close: () => undefined });
    const fake = Object.assign(new EventEmitter(), {
      ended: false,
      exec: (command: string, callback: (error: Error | undefined, channel: unknown) => void) => {
        const encoded = /printf '%s' '([^']+)'/.exec(command)?.[1] ?? "";
        expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toMatchObject({ method: "agent.prompt", params: { target: "p", text: "hello" } });
        applied += 1;
        callback(undefined, channel);
      },
      end: () => {
        if (fake.ended) return;
        fake.ended = true;
        fake.emit("end");
        fake.emit("close");
      },
    });
    const transport = new SshHerdrTransport({ host: "fake.invalid", port: 22, username: "fixture", herdrSession: "fixture" } as never, {} as never, {
      connect: async () => fake,
      relayScript: "",
    } as never);
    const writer = {
      prompt: async () => void (await transport.roundTrip(JSON.stringify({ id: "p", method: "agent.prompt", params: { target: "p", text: "hello" } }), { timeoutMs: 60_000 })),
      sendInput: async () => undefined,
    };
    const note = outcome(deliver(writer, "p", { kind: "prompt", text: "hello" }, "claude"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.ended).toBe(true);
    expect(await note).toBe(unconfirmedText);
    expect(applied).toBe(1);
    transport.close();
  });
});

const topologyOf = (panes = [pane("claude", "p")]) => ({ version: "fake", protocolVersion: 22, workspaces: [], tabs: [], panes, agents: [] });
function fakeHost() {
  let epoch = 1;
  let asks = 0;
  let value = topologyOf();
  const streams: { sink: { started(): void; event(kind: string, pane?: string): void; ended(reason: string): void }; closed: boolean }[] = [];
  const backend = {
    kind: "herdr-tui",
    snapshot: async () => ((asks += 1), value),
    connectionEpoch: () => epoch,
    subscribeSidebar: (_kinds: unknown, _panes: unknown, sink: (typeof streams)[number]["sink"]) => {
      const item = { sink, closed: false };
      streams.push(item);
      return { close: () => void (item.closed = true) };
    },
    close: () => undefined,
  };
  const registry = new HostRegistry(() => undefined);
  registry.add({ id: "h", name: "fake", kind: "ssh", address: "fake.invalid", platform: null }, backend as never);
  return { registry, streams, asks: () => asks, set: (next: typeof value) => void (value = next), epoch: (next: number) => void (epoch = next) };
}

describe("a resubscribe claims no coverage until the new subscription starts", () => {
  it("not live during the handover; the new start bridges the gap with one snapshot; one subscriber after", async () => {
    const h = fakeHost();
    await vi.advanceTimersByTimeAsync(0);
    h.streams[0]!.sink.started();
    expect(h.registry.eventsLive("h")).toBe(true);
    h.set(topologyOf([pane("claude", "p"), pane("claude", "new")]));
    await h.registry.refresh("h");
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0]!.closed).toBe(true);
    expect(h.registry.eventsLive("h")).toBe(false);
    const before = h.asks();
    h.streams[1]!.sink.started();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.registry.eventsLive("h")).toBe(true);
    expect(h.asks()).toBe(before + 1);
    expect(h.streams.filter((stream) => !stream.closed)).toHaveLength(1);
    h.registry.close();
  });
});

describe("relay liveness", () => {
  it("15 s of silence is measured from the last frame, without another 5 s tick", async () => {
    const r = relay();
    let died = false;
    r.client.keepAlive(
      () => true,
      () => {
        died = true;
        r.client.close();
      },
    );
    await vi.advanceTimersByTimeAsync(2345);
    r.out({ relay: "notice" });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(died).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(died).toBe(true);
  });

  it("the silence drop starts a replacement connection without waiting for another caller", async () => {
    let connects = 0;
    const connect = async () => {
      connects += 1;
      const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write: () => true, close: () => void channel.emit("close") });
      const client = Object.assign(new EventEmitter(), {
        exec: (_command: string, callback: (error: Error | undefined, channel: unknown) => void) => {
          callback(undefined, channel);
          queueMicrotask(() => channel.emit("data", Buffer.from('{"relay":"hello","v":1}\n')));
        },
        end: () => {
          client.emit("end");
          client.emit("close");
        },
      });
      return client;
    };
    const transport = new SshHerdrTransport({ host: "fake.invalid", port: 22, username: "fixture", herdrSession: "fixture" } as never, {} as never, { connect, relayScript: "# fake" } as never);
    await transport.openRelay();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connects).toBe(2);
    transport.close();
  });
});

describe("a watch reset starts the settings over", () => {
  it("a longer replacement shows its own model and effort", async () => {
    const assistant = (body: string, id: string, n: number, model: string, effort: string) => {
      const line = JSON.parse(reply(body, id, n, true)) as { effort?: string; message: { model?: string } };
      line.effort = effort;
      line.message.model = model;
      return JSON.stringify(line);
    };
    let bytes = Buffer.from(text([user("x".repeat(3000), "u1", 1), assistant("old", "a1", 2, "claude-opus-5-5", "max")]));
    let sink: { reset(): void } | null = null;
    const reader = {
      locate: async () => "/fake/one.jsonl",
      size: async () => bytes.length,
      read: async (_path: string, offset: number, length: number) => bytes.subarray(offset, offset + length),
      watch: async (_path: string, _offset: number, follower: { reset(): void }) => ((sink = follower), { close: () => undefined }),
    };
    const settings = new AgentSettingsReader("claude");
    let notified = 0;
    const feed = new ChatFeed(tapReader(reader as never, settings, () => void (notified += 1)), { pollIntervalMs: 1000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(1100);
    expect(settings.settings.model).toBe("claude-opus-5-5");
    const before = notified;
    bytes = Buffer.from(text([user("new", "u9", 9), assistant("new", "a9", 10, "claude-sonnet-5-5", "low")]) + "\n".repeat(5000));
    sink!.reset();
    // The reset is said once, with the reread (no blank chips in between).
    expect(notified).toBe(before);
    await vi.advanceTimersByTimeAsync(1200);
    expect(shown(feed.timeline)).toEqual(["user:new", "agent:new"]);
    expect(settings.settings).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
    expect(notified).toBe(before + 1);
    feed.stop();
  });
});

describe("the launch cache keeps display text only", () => {
  it("no tool arguments or outputs; messages and the tool row's title stay", () => {
    const stored = new Map<string, string>();
    const cache = new LaunchCache({ read: (file) => stored.get(file) ?? null, write: (file, body) => void stored.set(file, body), remove: (file) => void stored.delete(file) });
    const timeline = whole(text([user("check deployment", "u1", 1), tool("tool", "FAKE_TOKEN=fixture-only-secret run-tests", "a1", 2), result("tool", "fixture-only-password", "r1", 3)]));
    cache.noteChat("h", "p", timeline);
    cache.flush(true);
    const file = [...stored.values()][0]!;
    expect(file).not.toContain("fixture-only-secret");
    expect(file).not.toContain("fixture-only-password");
    expect(file).toContain("check deployment");
    expect(file).toContain('"toolName":"Bash"');
  });

  it("takes the saved secrets out of message text", () => {
    const stored = new Map<string, string>();
    const cache = new LaunchCache(
      { read: (file) => stored.get(file) ?? null, write: (file, body) => void stored.set(file, body), remove: (file) => void stored.delete(file) },
      Date.now,
      (line) => line.split("fixture-saved-password").join("•••"),
    );
    cache.noteChat("h", "p", whole(text([user("my password is fixture-saved-password", "u1", 1), reply("noted", "a1", 2, true)])));
    cache.flush(true);
    const file = [...stored.values()][0]!;
    expect(file).not.toContain("fixture-saved-password");
    expect(file).toContain("my password is •••");
  });
});

describe("current() trusts a snapshot only from the connection used now", () => {
  it("a changed epoch asks a fresh snapshot", async () => {
    const h = fakeHost();
    await vi.advanceTimersByTimeAsync(0);
    h.streams[0]!.sink.started();
    const before = h.asks();
    expect(await h.registry.current("h")).toBe(true);
    expect(h.asks()).toBe(before);
    h.epoch(2);
    await h.registry.current("h");
    expect(h.asks()).toBe(before + 1);
    h.registry.close();
  });
});

describe("every relay request has its own wire id", () => {
  it("a late reply after a cancel never settles a later request with the same caller id", async () => {
    const r = relay();
    const first = r.client.request(request("same"), 100).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toContain("did not answer");
    expect(r.sent.at(-1)!["relay"]).toBe("cancel");
    const oldWire = String(r.sent.at(-1)!["id"]);
    let answer = "pending";
    const second = r.client.request(request("same"), 1000).then((line) => {
      const parsed = JSON.parse(line) as { id: string; result: string };
      answer = `${parsed.id}:${parsed.result}`;
    });
    const newWire = String(r.sent.at(-1)!["id"]);
    expect(newWire).not.toBe(oldWire);
    r.out({ id: "same", result: "late-old-reply" });
    r.out({ id: oldWire, result: "late-old-reply" });
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe("pending");
    r.out({ id: newWire, result: "new-reply" });
    await second;
    // The caller's own id is back in the reply line.
    expect(answer).toBe("same:new-reply");
    r.client.close();
  });
});
