// A Kimi Code wire followed as it grows, through Chat's own follower and readers (nothing new
// reads the file): Kimi writes a step's loop events when the step ends (kimi-code 27bd9ba
// packages/agent-core-v2/src/agent/loop/loopService.ts:1640-1653), so the file grows a few lines at a time.
// The bounds are the follower's and the relay's: an over-long line dropped, at most 4 MiB a read, a replaced
// file read again, the runs a relay read leaves out kept as file ranges (blobs.ts).

import { afterEach, describe, expect, it, vi } from "vitest";

import { kimiWorkspaceKey } from "../src/shared/chat/agents/kimi-locate";
import { rebuildOmitted } from "../src/shared/chat/blobs";
import { ChatFeed, standardColdLoad, type TranscriptReadOptions } from "../src/shared/chat/feed";
import { firstLoadWindow, maxLineBytes } from "../src/shared/chat/follower";
import { makeSessionRef } from "../src/shared/chat/locator";
import type { ChatTimeline } from "../src/shared/chat/model";
import { FakeTranscriptReader, eventually, shown } from "./support/chat-lines";
import { relayOmit, runClock } from "./support/cold-link";

const cwd = "/Users/fixture/proj";
const id = "session_5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
const file = `/Users/fixture/.kimi-code/sessions/${kimiWorkspaceKey(cwd)}/${id}/agents/main/wire.jsonl`;
const session = makeSessionRef("kimi", { kind: "id", id })!;
const base = 1_793_502_000_000;

const w = (type: string, payload: Record<string, unknown>, second = 0): string => JSON.stringify({ type, ...payload, time: base + second * 1_000 });
const head = (): string[] => [
  JSON.stringify({ type: "metadata", protocol_version: "1.5", min_protocol_version: "1.5", created_at: base }),
  w("profile.bind", { environmentDisclosure: { cwd } }),
];
const said = (text: string, second: number): string => w("context.append_message", { message: { role: "user", content: [{ type: "text", text }], origin: { kind: "user" } } }, second);
const reply = (text: string, second: number): string => w("context.append_loop_event", { event: { type: "content.part", stepUuid: "s", part: { type: "text", text } } }, second);
const call = (callID: string, command: string, second: number): string =>
  w("context.append_loop_event", { event: { type: "tool.call", stepUuid: "s", toolCallId: callID, name: "Bash", args: { command } } }, second);
const result = (callID: string, output: string, second: number): string =>
  w("context.append_loop_event", { event: { type: "tool.result", toolCallId: callID, result: { output } } }, second);
const ended = (second: number): string => w("turn.ended", { reason: "completed", durationMs: 2_000 }, second);
const text = (lines: readonly string[]): string => lines.join("\n") + "\n";

/** A session of `turns` turns, each reply padded with `pad` characters. */
function session_(turns: number, pad = 0): string[] {
  const lines = head();
  for (let turn = 0; turn < turns; turn += 1) {
    const second = turn * 10;
    lines.push(said(`message ${turn}`, second), reply(`reply ${turn} ${"lorem ".repeat(Math.floor(pad / 6))}`, second + 1));
    lines.push(call(`call_${turn}`, `make step${turn}`, second + 2), result(`call_${turn}`, `built ${turn}`, second + 3));
    lines.push(reply(`Done with step ${turn}.`, second + 4), ended(second + 5));
  }
  return lines;
}

const replies = (timeline: ChatTimeline): string[] => shown(timeline).filter((entry) => entry.startsWith("agent:"));
const maxRead = (reader: FakeTranscriptReader): number =>
  Math.max(0, ...reader.calls.filter((call) => call.startsWith("read ")).map((call) => Number(call.split(" ")[2])));

describe("kimi wire: growth", () => {
  it("shows each step's lines as the wire grows; a partial last line waits for its newline", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(file, text([...head(), said("Go", 1)]), file);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(session, [cwd]);
    expect(await feed.loaded()).toBe(true);
    expect(shown(feed.timeline)).toEqual(["user:Go"]);
    reader.append(file, text([reply("First", 2), call("c1", "npm test", 2)]));
    expect(await eventually(() => shown(feed.timeline).length === 3)).toBe(true);
    expect(feed.timeline.turns.at(-1)!.isFinished).toBe(false);
    const line = new TextEncoder().encode(result("c1", "ok", 3) + "\n" + reply("Second", 4));
    reader.appendBytes(file, line.slice(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shown(feed.timeline)).toEqual(["user:Go", "agent:First", "tool:npm test"]);
    reader.appendBytes(file, line.slice(40));
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The result is whole; the reply after it is not yet.
    expect(replies(feed.timeline)).toEqual(["agent:First"]);
    reader.append(file, "\n" + ended(5) + "\n");
    expect(await eventually(() => feed.timeline.turns.at(-1)!.isFinished)).toBe(true);
    expect(replies(feed.timeline)).toEqual(["agent:First", "agent:Second"]);
    expect(feed.state).toEqual({ status: "live" });
    feed.stop();
  });

  it("drops a line longer than the follower's maximum and reads on; no read asks for more than 4 MiB", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(file, text([...head(), said("Go", 1)]), file);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(session, [cwd]);
    await feed.loaded();
    const huge = reply("x".repeat(maxLineBytes + 1_024), 2);
    reader.append(file, text([huge, reply("After the long line", 3), ended(4)]));
    expect(await eventually(() => feed.timeline.turns.at(-1)!.isFinished, 20_000)).toBe(true);
    expect(replies(feed.timeline)).toEqual(["agent:After the long line"]);
    expect(feed.state).toEqual({ status: "live" });
    expect(maxRead(reader)).toBeLessThanOrEqual(firstLoadWindow);
    feed.stop();
  }, 30_000);

  it("reads a wire replaced by a shorter one again from its start, nothing of the old one kept", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(file, text(session_(3)), file);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(session, [cwd]);
    await feed.loaded();
    expect(replies(feed.timeline)).toContain("agent:Done with step 2.");
    reader.put(file, text([...head(), said("Fresh start", 1), reply("New", 2)]), file);
    expect(await eventually(() => JSON.stringify(shown(feed.timeline)) === JSON.stringify(["user:Fresh start", "agent:New"]))).toBe(true);
    // Truncated to its head only: nothing shows, the feed stays live.
    reader.put(file, text(head()), file);
    expect(await eventually(() => shown(feed.timeline).length === 0)).toBe(true);
    expect(feed.state).toEqual({ status: "live" });
    feed.stop();
  });
});

describe("kimi wire: cold load and relay reads", () => {
  afterEach(() => vi.useRealTimers());

  it("loads a session over 4 MB cold within the window, earlier turns offered", async () => {
    const content = text(session_(120, 40_000));
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(4_000_000);
    const reader = new FakeTranscriptReader();
    reader.put(file, content, file);
    const feed = new ChatFeed(reader, { cold: standardColdLoad });
    feed.start(session, [cwd]);
    expect(await feed.loaded()).toBe(true);
    expect(feed.state).toEqual({ status: "live" });
    expect(feed.bytesRead).toBeLessThanOrEqual(standardColdLoad.window * 2);
    expect(feed.timeline.turns.length).toBeGreaterThanOrEqual(standardColdLoad.turns);
    expect(replies(feed.timeline).at(-1)).toBe("agent:Done with step 119.");
    expect(feed.timeline.earlier).toBe("available");
    expect(maxRead(reader)).toBeLessThanOrEqual(firstLoadWindow);
    feed.stop();
  });

  it("keeps the user's and Kimi's text and the item ids when a relay read leaves base64-like runs out", async () => {
    vi.useFakeTimers();
    class OmitReader extends FakeTranscriptReader {
      leftOut = 0;
      async readWithIdentity(at: string, offset: number, max: number, options: TranscriptReadOptions = {}) {
        const size = await super.size(at);
        const full = await super.read(at, 0, size);
        const start = options.tail === undefined ? offset : Math.max(0, size - options.tail);
        const raw = full.subarray(start, start + max);
        const out = options.omit === true ? relayOmit(full, start, raw, 1_024) : { kept: raw, omitted: [] as [number, number][] };
        this.leftOut += out.omitted.length;
        return { size, ino: 77, offset: start, data: rebuildOmitted(start, out.kept, out.omitted)!, omitted: out.omitted };
      }
    }
    const question = "question " + "A".repeat(2_000);
    const answer = "answer " + "B".repeat(2_000);
    const picture = w("context.append_message", { message: { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", imageUrl: { url: "data:image/png;base64," + "C".repeat(4_000) } }], origin: { kind: "user" } } }, 5);
    const content = text([...head(), said(question, 1), reply(answer, 2), ended(3), picture, reply("A picture.", 6), ended(7)]);
    const plain = new FakeTranscriptReader();
    const omitting = new OmitReader();
    const feeds = [plain, omitting].map((reader) => {
      reader.put(file, content, file);
      return new ChatFeed(reader, { cold: standardColdLoad });
    });
    let done = 0;
    for (const feed of feeds) {
      feed.start(session, [cwd]);
      void feed.loaded().then(() => (done += 1));
    }
    await runClock(() => done === 2, 10_000);
    expect(omitting.leftOut).toBeGreaterThanOrEqual(3);
    expect(feeds[1]!.state).toEqual({ status: "live" });
    expect(feeds[1]!.timeline).toEqual(feeds[0]!.timeline);
    expect(shown(feeds[1]!.timeline)).toEqual(["user:" + question, "agent:" + answer, "user:see", "agent:A picture."]);
    const message = feeds[1]!.timeline.turns[1]!.items[0]!;
    expect(message.type === "user" ? message.value.attachments.map((a) => a.mediaType) : null).toEqual(["image/png"]);
    for (const feed of feeds) feed.stop();
  });

  it("says a newer wire's format is not recognised rather than show it", async () => {
    const reader = new FakeTranscriptReader();
    const newer = [JSON.stringify({ type: "metadata", protocol_version: "2.0", min_protocol_version: "2.0", created_at: base }), ...session_(2).slice(1)];
    reader.put(file, text(newer), file);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    feed.start(session, [cwd]);
    expect(await eventually(() => feed.state.status === "unavailable")).toBe(true);
    expect(feed.state).toEqual({ status: "unavailable", reason: "unrecognisedFormat" });
    expect(feed.timeline.turns).toEqual([]);
    feed.stop();
  });
});
