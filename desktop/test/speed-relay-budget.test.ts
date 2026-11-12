// The relay's and the launch cache's bounds on the Mac: the request budget, redaction of tool titles, the
// cost of a cache write, watch resets and the caller's id in a reply. The exec case is in speed-relay.test.ts.
// Fakes only: no SSH, no Herdr, no socket, no Keychain (the fake cipher).

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostStore, SavedHosts } from "../src/main/host-store";
import { RelayClient } from "../src/main/herdr/relay";
import { SshHerdrTransport } from "../src/main/herdr/ssh";
import { LaunchCache } from "../src/main/launch-cache";
import { SecretStore } from "../src/main/secret-store";
import { AgentSettingsReader, tapReader } from "../src/shared/agent-settings";
import { ChatFeed } from "../src/shared/chat/feed";
import { claudeSession, reply, shown, text, tool, user, whole } from "./support/chat-lines";
import { fakeCipher } from "./support/fake-cipher";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

const config = { host: "fake.invalid", port: 22, username: "fixture", herdrSession: "fixture" };
const request = (id: string) => JSON.stringify({ id, method: "agent.list", params: {} });
const memoryFiles = () => {
  const stored = new Map<string, string>();
  return { stored, files: { read: (file: string) => stored.get(file) ?? null, write: (file: string, body: string) => void stored.set(file, body), remove: (file: string) => void stored.delete(file) } };
};

describe("no relay write after the request's budget is gone", () => {
  it("a hello at the request deadline (the clock past it) sends nothing and fails the request unwritten", async () => {
    const writes: string[] = [];
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), write: (line: string) => (writes.push(line), true), close: () => undefined });
    const fake = Object.assign(new EventEmitter(), {
      exec: (_command: string, callback: (error: Error | undefined, channel: unknown) => void) => {
        callback(undefined, channel);
        setTimeout(() => {
          vi.setSystemTime(1025);
          channel.emit("data", Buffer.from('{"relay":"hello","v":1}\n'));
        }, 1000);
      },
      end: () => undefined,
    });
    const transport = new SshHerdrTransport(config as never, {} as never, { connect: async () => fake, relayScript: "# fake" } as never);
    const done = transport.roundTrip(request("one"), { timeoutMs: 1000 }).then(
      () => "answered",
      (error: Error & { mayHaveLanded?: boolean }) => `${error.message} landed:${String(error.mayHaveLanded)}`,
    );
    await vi.advanceTimersByTimeAsync(1001);
    expect(writes.filter((line) => line.includes("agent.list"))).toEqual([]);
    expect(await done).toBe("the host did not answer within 1 seconds landed:false");
    transport.close();
  });
});

describe("the launch cache redacts the tool title too", () => {
  it("a saved secret in a custom tool's name and kind is taken out", () => {
    const { stored, files } = memoryFiles();
    const cache = new LaunchCache(files, Date.now, (line) => line.split("fixture-secret").join("•••"));
    const raw = JSON.parse(tool("custom", "raw-target", "a1", 2)) as { message: { content: { name: string }[] } };
    raw.message.content[0]!.name = "mcp__fixture-secret__fetch";
    const timeline = whole(text([user("custom tool", "u1", 1), JSON.stringify(raw)]));
    expect(timeline.turns.flatMap((turn) => turn.items).some((item) => item.type === "toolCall" && item.value.toolName === "mcp__fixture-secret__fetch")).toBe(true);
    cache.noteChat("h", "p", timeline);
    cache.flush(true);
    const file = [...stored.values()][0]!;
    expect(file).not.toContain("fixture-secret");
    expect(file).toContain('"toolName":"mcp__•••__fetch"');
  });

  it("a custom kind's own name is redacted (the item as the timeline holds it)", () => {
    const { stored, files } = memoryFiles();
    const cache = new LaunchCache(files, Date.now, (line) => line.split("fixture-secret").join("•••"));
    const call = { id: "c", kind: { other: "fixture-secret-kind" }, toolName: "x", target: "", resultSummary: null, state: "ok", detail: { type: "none" }, time: 1, finishedAt: 2, moreCalls: 0, isUserShell: false, program: null };
    cache.noteChat("h", "p", { turns: [{ id: "t", items: [{ type: "toolCall", value: call }], startedAt: 1, lastEventAt: 2, endedAt: 2, isFinished: true, reportedDuration: 1, isPartial: false }], title: null, earlier: "none", newerWaiting: false, running: [] } as never);
    cache.flush(true);
    const file = [...stored.values()][0]!;
    expect(file).not.toContain("fixture-secret");
    expect(file).toContain('"kind":{"other":"•••-kind"}');
  });
});

describe("cache write cost: the saved secrets are read once per write, not once per text", () => {
  it("the redactor is made once per flush, and SavedHosts.redactor decrypts each secret once", () => {
    const dir = mkdtempSync(path.join(process.env["HERDR_TEST_SCRATCH"] ?? process.env["TMPDIR"] ?? "/tmp", "herdr-cache-"));
    const cipher = fakeCipher();
    let decrypts = 0;
    const decrypt = cipher.decryptString.bind(cipher);
    cipher.decryptString = (sealed: Buffer) => ((decrypts += 1), decrypt(sealed));
    const saved = new SavedHosts(new HostStore(path.join(dir, "hosts.json")), new SecretStore(path.join(dir, "s.json"), cipher), () => true);
    saved.add({ name: "A", host: "a.invalid", port: 22, username: "robin", auth: "password", keyPath: "", herdrSession: "default", secret: "SYNTHETIC-pass-A" });
    saved.add({ name: "B", host: "b.invalid", port: 22, username: "robin", auth: "password", keyPath: "", herdrSession: "default", secret: "SYNTHETIC-pass-B" });
    let made = 0;
    const { stored, files } = memoryFiles();
    const cache = new LaunchCache(files, Date.now, (line) => saved.redact(line), () => ((made += 1), saved.redactor()));
    const lines = Array.from({ length: 20 }, (_, n) => (n % 2 === 0 ? user(`u${n} SYNTHETIC-pass-A`, `u${n}`, n + 1) : reply(`a${n} SYNTHETIC-pass-B`, `a${n}`, n + 1, true)));
    cache.noteChat("h1", "p", whole(text(lines)));
    cache.noteChat("h2", "p", whole(text(lines)));
    decrypts = 0;
    cache.flush(true);
    expect(made).toBe(1);
    expect(decrypts).toBe(2);
    const bodies = [...stored.values()];
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toContain("SYNTHETIC-pass");
      expect(body).toContain("u0 •••");
    }
    // Nothing dirty: no secrets read.
    cache.flush(true);
    expect(made).toBe(1);
  });
});

describe("a watch reset is said once, with the reread", () => {
  it("no null/null notification before the replacement's settings", async () => {
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
    const heard: { model: string | null; effort: string | null }[] = [];
    const feed = new ChatFeed(tapReader(reader as never, settings, () => void heard.push({ model: settings.settings.model, effort: settings.settings.effort })), { pollIntervalMs: 1000 });
    feed.start(claudeSession, []);
    await vi.advanceTimersByTimeAsync(1100);
    heard.length = 0;
    bytes = Buffer.from(text([user("new", "u2", 3), assistant("new", "a2", 4, "claude-sonnet-5-5", "low")]) + "\n".repeat(5000));
    sink!.reset();
    await vi.advanceTimersByTimeAsync(1200);
    expect(shown(feed.timeline)).toEqual(["user:new", "agent:new"]);
    expect(heard).toEqual([{ model: "claude-sonnet-5-5", effort: "low" }]);
    feed.stop();
  });
});

describe("a reset notifies only a net change from the settings last notified", () => {
  it("resetting and rereading the identical transcript notifies nothing", async () => {
    const line = JSON.parse(reply("answer", "a1", 2, true)) as { effort?: string; message: { model?: string } };
    line.effort = "max";
    line.message.model = "claude-opus-5-5";
    const bytes = Buffer.from(text([user("question", "u1", 1), JSON.stringify(line)]));
    let sink: { reset(): void } | null = null;
    const reader = {
      locate: async () => "/fake/one.jsonl",
      size: async () => bytes.length,
      read: async (_path: string, offset: number, length: number) => bytes.subarray(offset, offset + length),
      watch: async (_path: string, _offset: number, follower: { reset(): void }) => ((sink = follower), { close: () => undefined }),
    };
    const settings = new AgentSettingsReader("claude");
    let notified = 0;
    const tapped = tapReader(reader as never, settings, () => void (notified += 1));
    await tapped.read("/fake/one.jsonl", 0, bytes.length);
    expect(settings.settings).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
    await (tapped as unknown as { watch(path: string, offset: number, sink: unknown): Promise<unknown> }).watch("/fake/one.jsonl", bytes.length, { reset: () => undefined });
    const before = { ...settings.settings };
    notified = 0;
    sink!.reset();
    await tapped.read("/fake/one.jsonl", 0, bytes.length);
    expect(settings.settings).toEqual(before);
    expect(notified).toBe(0);
    // A real change after that still notifies (the baseline was used once).
    sink!.reset();
    expect(notified).toBe(0);
    await tapped.read("/fake/one.jsonl", 0, 0);
    expect(settings.settings.model).toBeNull();
    expect(notified).toBe(1);
  });
});

describe("the caller's id is restored whatever its position in the reply", () => {
  function relay() {
    const sent: Record<string, unknown>[] = [];
    const client = new RelayClient({ write: (line) => void sent.push(JSON.parse(line) as Record<string, unknown>), close: () => undefined }, "/fake/socket");
    client.data(Buffer.from('{"relay":"hello","v":1}\n'));
    return { client, sent, out: (line: string) => client.data(Buffer.from(line + "\n")) };
  }

  it("id after the result: restored, every other byte kept (wide integers intact)", async () => {
    const r = relay();
    const asked = r.client.request(request("original"), 1000);
    const wire = JSON.stringify(String(r.sent[0]!["id"]));
    r.out(`{"result":{"seq":9007199254740993,"note":"a \\"quoted\\" {brace}","id":${wire}}, "id" : ${wire}}`);
    expect(await asked).toBe(`{"result":{"seq":9007199254740993,"note":"a \\"quoted\\" {brace}","id":${wire}}, "id" : "original"}`);
    r.client.close();
  });

  it("a reply that does not parse keeps the leading-id splice (a malformed duplicate id gets the caller's id)", async () => {
    const r = relay();
    const asked = r.client.request(request("caller"), 1000);
    const wire = JSON.stringify(String(r.sent[0]!["id"]));
    r.out(`{"id":${wire},"result":oops,"id":"other"}`);
    expect(await asked).toBe('{"id":"caller","result":oops,"id":"other"}');
    r.client.close();
  });

  it("id first still works; a nested id equal to the wire id is left alone", async () => {
    const r = relay();
    const asked = r.client.request(request("first"), 1000);
    const wire = JSON.stringify(String(r.sent[0]!["id"]));
    r.out(`{"id":${wire},"result":[1,{"id":${wire}}]}`);
    expect(await asked).toBe(`{"id":"first","result":[1,{"id":${wire}}]}`);
    r.client.close();
  });
});
