// Fixture lines in Claude Code's transcript shapes, invented content, and the
// helpers HerdrKit's chat tests share (ChatQueuedMessageTests' Line helpers,
// ChatEarlierHistoryTests' whole/shape, ChatFeedTests' FakeTranscriptReader,
// ChatHistorySeamTests' coldSeam/brief/liveFeed/loadAll, SeededRandom).

import { ChatTimelineBuilder } from "../../src/shared/chat/builder";
import { ChatFeed, TranscriptNotFoundError, type TranscriptFileReader } from "../../src/shared/chat/feed";
import { firstLoadWindow } from "../../src/shared/chat/follower";
import { makeSessionRef, type TranscriptSessionRef } from "../../src/shared/chat/locator";
import { noticeText, type ChatTimeline } from "../../src/shared/chat/model";
import { TranscriptParser, type TranscriptFormat, type TranscriptParseStats } from "../../src/shared/chat/parser";
import { extractRawString, readRepoFile } from "./swift-fixtures";

export const session = "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f";
export const upload =
  "/Users/fixture/.herdr-companion-attachments-0123456789abcdef0123456789abcdef/attachment-33333333-3333-3333-3333-333333333333.png";

export const claudeSession: TranscriptSessionRef = makeSessionRef("claude", { kind: "id", id: session })!;
export const otherSession: TranscriptSessionRef = makeSessionRef("codex", { kind: "id", id: "019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b" })!;
export const claudePath = "/Users/fixture/.claude/projects/-Users-fixture-proj/5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f.jsonl";
export const codexPath = "/Users/fixture/.codex/sessions/2026/11/01/rollout-2026-11-01T03-00-00-019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b.jsonl";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/** JSON with sorted keys, as JSONSerialization's `.sortedKeys` writes it. */
export function json(value: JSONValue): string {
  const sort = (v: JSONValue): JSONValue => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: { [key: string]: JSONValue } = {};
      for (const key of Object.keys(v).sort()) out[key] = sort(v[key]!);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const two = (n: number): string => String(n).padStart(2, "0");

/** "2026-11-02T05:MM:SS.000Z". */
export function stamp(second: number): string {
  return `2026-11-02T05:${two(Math.floor(second / 60))}:${two(second % 60)}.000Z`;
}

/** Epoch seconds of `stamp(second)`. */
export function at(second: number): number {
  return Date.UTC(2026, 10, 2, 5, 0, 0) / 1000 + second;
}

export function user(text: JSONValue, uuid: string, second: number, extra: Record<string, JSONValue> = {}): string {
  return json({
    cwd: "/Users/fixture/proj",
    entrypoint: "cli",
    isSidechain: false,
    message: { content: text, role: "user" },
    parentUuid: null,
    promptId: "p-" + uuid,
    sessionId: session,
    timestamp: stamp(second),
    type: "user",
    userType: "external",
    uuid,
    version: "2.1.316",
    ...extra,
  });
}

export function queued(prompt: JSONValue, uuid: string, source: string | null, second: number, extra: Record<string, JSONValue> = {}): string {
  const attachment: { [key: string]: JSONValue } = { type: "queued_command", prompt };
  if (source !== null) attachment.source_uuid = source;
  return json({
    attachment,
    cwd: "/Users/fixture/proj",
    entrypoint: "cli",
    gitBranch: "main",
    isSidechain: false,
    parentUuid: "a-prev",
    sessionId: session,
    timestamp: stamp(second),
    type: "attachment",
    userType: "external",
    uuid,
    version: "2.1.316",
    ...extra,
  });
}

export function tool(id: string, command: string, uuid: string, second: number): string {
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid,
    message: {
      content: [{ id, input: { command }, name: "Bash", type: "tool_use" }],
      id: "msg_" + uuid,
      role: "assistant",
      stop_reason: "tool_use",
      type: "message",
    },
  });
}

export function result(id: string, output: string, uuid: string, second: number): string {
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "user",
    uuid,
    message: { content: [{ content: output, is_error: false, tool_use_id: id, type: "tool_result" }], role: "user" },
  });
}

export function failedResult(id: string, output: string, uuid: string, second: number): string {
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "user",
    uuid,
    message: { content: [{ content: output, is_error: true, tool_use_id: id, type: "tool_result" }], role: "user" },
  });
}

export function reply(text: string, uuid: string, second: number, ends = false): string {
  return json({
    isSidechain: false,
    sessionId: session,
    timestamp: stamp(second),
    type: "assistant",
    uuid,
    message: { content: [{ text, type: "text" }], id: "msg_" + uuid, role: "assistant", stop_reason: ends ? "end_turn" : null, type: "message" },
  });
}

/** A progress update line: thinking text on a line marked `"thinkingDisplay": "updates"`. */
export function progress(text: string, uuid: string, second: number): string {
  return json({
    isSidechain: false,
    sessionId: session,
    thinkingDisplay: "updates",
    timestamp: stamp(second),
    type: "assistant",
    uuid,
    message: { content: [{ signature: "s", thinking: text, type: "thinking" }], id: "msg_" + uuid, role: "assistant", type: "message" },
  });
}

/** Lines parsed and built at once (Claude). */
export function timelineOf(lines: readonly string[]): { timeline: ChatTimeline; stats: TranscriptParseStats } {
  const parser = new TranscriptParser("claude");
  const builder = new ChatTimelineBuilder();
  builder.apply(parser.parseText(lines.join("\n")));
  return { timeline: builder.timeline, stats: parser.stats };
}

/** What the timeline shows, in order: `user:<text>`, `agent:<text>`, `tool:<target>`, `notice:<text>`, `progress:<text>`. */
export function shown(timeline: ChatTimeline): string[] {
  return timeline.turns.flatMap((turn) =>
    turn.items.map((item) => {
      switch (item.type) {
        case "user":
          return "user:" + item.value.text;
        case "agentText":
          return "agent:" + item.value.markdown;
        case "toolCall":
          return "tool:" + item.value.target;
        case "notice":
          return "notice:" + noticeText(item.value.kind);
        case "progress":
          return "progress:" + item.value.markdown;
        case "agents":
          return "agents:" + item.value.agents.map((agent) => agent.description).join(",");
        case "agentMessage":
          return "agentMessage:" + item.value.text;
      }
    }),
  );
}

/** A Claude session of `turns` turns: the user's message, a reply, a Bash call, its result, a closing reply. */
export function claudeLines(turns: number, pad = 0): string[] {
  const filler = "lorem ipsum ".repeat(Math.floor(pad / 12));
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const second = (turn * 10) % 3_000;
    lines.push(user(`message ${turn}`, `u${turn}`, second));
    lines.push(reply(`reply ${turn} ${filler}`, `a${turn}`, second + 1));
    lines.push(tool(`toolu_${turn}`, `make step${turn}`, `t${turn}`, second + 2));
    lines.push(result(`toolu_${turn}`, `built ${turn}`, `r${turn}`, second + 3));
    lines.push(reply(`done ${turn} ${filler}`, `d${turn}`, second + 4, true));
  }
  return lines;
}

export const text = (lines: readonly string[]): string => lines.join("\n") + "\n";

/** The whole file parsed at once: what the loaded history must equal. */
export function whole(content: string, format: TranscriptFormat = "claude"): ChatTimeline {
  const parser = new TranscriptParser(format);
  const builder = new ChatTimelineBuilder(1_000_000, 1_000_000);
  builder.apply(parser.parseText(content));
  return builder.timeline;
}

/** Each turn's item ids and whether it finished. */
export function shape(timeline: ChatTimeline): string[] {
  return timeline.turns.map((turn) => turn.items.map((item) => item.value.id).join(",") + (turn.isFinished ? " ✓" : " …"));
}

/** A transcript whose live window (its last 4 MB) starts exactly at `after`'s first line. */
export function coldSeam(before: readonly string[], after: readonly string[]): string {
  const filler = reply("f".repeat(firstLoadWindow + 100_000), "filler", 25);
  return text([...before, filler, ...after]);
}

/** What the timeline shows, in order; a long agent text (the filler) cut to its first ten characters. */
export function brief(timeline: ChatTimeline): string[] {
  return shown(timeline).map((entry) => (entry.startsWith("agent:") && entry.length > 200 ? entry.slice(0, 10) : entry));
}

export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return condition();
}

export class ReadFailure extends Error {}

/** ChatFeedTests' fake reader: files in memory, calls recorded, failures and held reads on request. */
export class FakeTranscriptReader implements TranscriptFileReader<TranscriptSessionRef> {
  private files = new Map<string, Uint8Array>();
  private located: string | null = null;
  private locateFails = false;
  pendingSizeFailures = 0;
  calls: string[] = [];
  readPaths: string[] = [];
  private holding = false;
  private waiting: (() => void)[] = [];

  get readsWaiting(): number {
    return this.waiting.length;
  }

  put(path: string, content: string, located: string | null): void {
    this.files.set(path, new TextEncoder().encode(content));
    if (located !== null) this.located = located;
  }

  append(path: string, content: string): void {
    this.appendBytes(path, new TextEncoder().encode(content));
  }

  appendBytes(path: string, bytes: Uint8Array): void {
    const old = this.files.get(path) ?? new Uint8Array(0);
    const next = new Uint8Array(old.length + bytes.length);
    next.set(old, 0);
    next.set(bytes, old.length);
    this.files.set(path, next);
  }

  setLocated(path: string | null): void {
    this.located = path;
  }

  failLocate(fails: boolean): void {
    this.locateFails = fails;
  }

  failNextSizes(count: number): void {
    this.pendingSizeFailures = count;
  }

  clearCalls(): void {
    this.calls = [];
    this.readPaths = [];
  }

  holdReads(hold: boolean): void {
    this.holding = hold;
    if (!hold) {
      const resumed = this.waiting;
      this.waiting = [];
      for (const resume of resumed) resume();
    }
  }

  async locate(_session: TranscriptSessionRef): Promise<string | null> {
    this.calls.push("locate");
    if (this.locateFails) throw new ReadFailure();
    return this.located;
  }

  async size(path: string): Promise<number> {
    this.calls.push("size");
    if (this.pendingSizeFailures > 0) {
      this.pendingSizeFailures -= 1;
      throw new ReadFailure();
    }
    const file = this.files.get(path);
    if (file === undefined) throw new TranscriptNotFoundError(path);
    return file.length;
  }

  async read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    this.calls.push(`read ${offset} ${maxBytes}`);
    this.readPaths.push(path);
    if (this.holding) await new Promise<void>((resolve) => this.waiting.push(resolve));
    const file = this.files.get(path);
    if (file === undefined) throw new TranscriptNotFoundError(path);
    const start = Math.min(offset, file.length);
    const end = Math.min(file.length, offset + maxBytes);
    return file.slice(start, end);
  }
}

/** A live feed on `content` (a 5 ms poll; `maxItems` shown). */
export async function liveFeed(
  content: string,
  options: { maxItems?: number; historyCap?: number; reader?: FakeTranscriptReader } = {},
): Promise<ChatFeed<TranscriptSessionRef>> {
  const reader = options.reader ?? new FakeTranscriptReader();
  reader.put(claudePath, content, claudePath);
  const feed = new ChatFeed(reader, { pollIntervalMs: 5, maxItems: options.maxItems ?? 200, historyCap: options.historyCap ?? 100_000 });
  feed.start(claudeSession);
  await eventually(() => feed.state.status === "live");
  return feed;
}

/** Loads earlier messages until none are offered (at most `limit` loads). */
export async function loadAll(feed: ChatFeed<TranscriptSessionRef>, limit = 50): Promise<void> {
  for (let loads = 0; loads < limit; loads += 1) {
    if (feed.timeline.earlier !== "available") return;
    await feed.loadEarlier();
  }
}

/** A small deterministic generator (SplitMix64) for seeded fixtures. */
export class SeededRandom {
  private state: bigint;

  constructor(seed: number) {
    this.state = BigInt(seed);
  }

  /** A number in 0..<bound. */
  next(bound: number): number {
    const mask = (1n << 64n) - 1n;
    this.state = (this.state + 0x9e3779b97f4a7c15n) & mask;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    z ^= z >> 31n;
    return Number(z % BigInt(bound));
  }
}

// MARK: - fixtures read from the Swift tests (verbatim raw string literals)

/** ClaudeTranscriptParserTests.session: a 32-line Claude Code session (no final newline). */
export function claudeFixture(): string {
  return extractRawString(readRepoFile("Tests/HerdrKitTests/ClaudeTranscriptParserTests.swift"), "static let session = ");
}

/** CodexRolloutParserTests.session: a Codex rollout (no final newline). */
export function codexFixture(): string {
  return extractRawString(readRepoFile("Tests/HerdrKitTests/CodexRolloutParserTests.swift"), "static let session = ");
}
