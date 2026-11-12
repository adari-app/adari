// A Codex rollout's header proof belongs to the file whose
// bytes are shown and is made again on every load and reload: a rollout put
// under the same name (before the first tail read, another inode on a live
// feed, a shrink, a watch's reset) shows nothing until its own header is
// checked. A header naming another session id is refused even when the pane
// has no folder. Fake rollout files with invented ids and folders only.

import { describe, expect, it } from "vitest";

import { codexHeaderVerdict } from "../src/shared/chat/codex-header";
import {
  ChatFeed,
  type TranscriptIdentityRead,
  type TranscriptReadOptions,
  type TranscriptWatch,
  type TranscriptWatchSink,
} from "../src/shared/chat/feed";
import { makeSessionRef, type TranscriptSessionRef } from "../src/shared/chat/locator";
import { eventually, FakeTranscriptReader, shown } from "./support/chat-lines";

const id = "4c7d2e91-5b3a-4f8e-9d1c-6a2b3c4d5e7f";
const otherId = "9e8d7c6b-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const path = `/Users/invented/.codex/sessions/2026/11/10/rollout-2026-11-10T10-00-00-${id}.jsonl`;
const ownFolder = "/Users/invented/trees/beacon";
const siblingFolder = "/Users/invented/trees/beacon-other";
const session: TranscriptSessionRef = makeSessionRef("codex", { kind: "id", id })!;
const secret = "SIBLING PRIVATE TEXT";

const meta = (sessionId: string, cwd: string): string =>
  JSON.stringify({ timestamp: "2026-11-10T10:00:00.000Z", type: "session_meta", payload: { id: sessionId, cwd, originator: "codex-tui", cli_version: "0.167.0" } });
const ask = (text: string, ordinal: number): string =>
  JSON.stringify({ timestamp: "2026-11-10T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", id: `q${ordinal}`, content: [{ type: "input_text", text }] } });
/** A rollout: its header, `pad` asks of 3,000 `filler` letters, then each of `asks`. */
const rollout = (sessionId: string, cwd: string, asks: readonly string[], pad = 0, filler = "p"): string =>
  [meta(sessionId, cwd), ...Array.from({ length: pad }, (_, n) => ask(filler.repeat(3_000), n)), ...asks.map((text, n) => ask(text, pad + n))].join("\n") + "\n";
/** Another session's rollout in a sibling folder, over 4 MiB, its last ask the secret. */
const sibling = (): string => rollout(otherId, siblingFolder, [secret], 1_500);
const ownRollout = (...asks: string[]): string => rollout(id, ownFolder, asks);

/** A reader that gives each read with the file's size and inode (the relay's `read`), the inode set by the test. */
class IdentityReader extends FakeTranscriptReader {
  ino = 1;
  identityReads = 0;
  /** Answers none (no relay now) while set. */
  noRelay = false;

  async readWithIdentity(file: string, offset: number, maxBytes: number, options: TranscriptReadOptions = {}): Promise<TranscriptIdentityRead | null> {
    if (this.noRelay) return null;
    this.identityReads += 1;
    const ino = this.ino;
    const size = await this.size(file);
    const start = options.tail === undefined ? offset : Math.max(0, size - options.tail);
    const data = await this.read(file, start, options.tail === undefined ? maxBytes : size - start);
    return { size, ino, data, offset: start };
  }
}

/** A plain reader (no identity) with a watch the test drives. */
class WatchingReader extends FakeTranscriptReader {
  sink: TranscriptWatchSink | null = null;

  watch(_file: string, _offset: number, sink: TranscriptWatchSink): Promise<TranscriptWatch | null> {
    this.sink = sink;
    return Promise.resolve({
      close: () => {
        this.sink = null;
      },
    });
  }
}

/** A feed on `reader` (whose file is already put) for `folders`, every text it ever showed kept. */
function follow(reader: FakeTranscriptReader, folders: readonly string[]) {
  const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
  const texts: string[] = [];
  feed.subscribe((update) => texts.push(...shown(update.timeline)));
  feed.start(session, folders);
  const leaked = (): boolean => texts.some((text) => text.includes(secret));
  return { feed, texts, leaked };
}

/** Waits until the feed is unavailable or the secret shows, then says neither showed it nor stayed live. */
async function expectRefused(feed: ChatFeed<TranscriptSessionRef>, leaked: () => boolean, reason = "sessionMismatch"): Promise<void> {
  await eventually(() => feed.state.status === "unavailable" || leaked(), 5_000);
  expect(leaked(), "the sibling's text was shown").toBe(false);
  expect(feed.state).toEqual({ status: "unavailable", reason });
}

describe("a known different session id is refused without a pane folder", () => {
  it("the verdict: another id is another session's with no folder, or only empty ones", () => {
    const header = { kind: "header" as const, id: otherId, cwd: siblingFolder };
    expect(codexHeaderVerdict(header, [], id)).toEqual({ kind: "otherSession" });
    expect(codexHeaderVerdict(header, ["", "  "], id)).toEqual({ kind: "otherSession" });
    expect(codexHeaderVerdict({ ...header, cwd: null }, [], id)).toEqual({ kind: "otherSession" });
    // No contradicting id: own (nothing to compare), the id compared case-insensitively.
    expect(codexHeaderVerdict({ ...header, id: id.toUpperCase() }, [], id)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict({ ...header, id: null }, [], id)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict(header, [], null)).toEqual({ kind: "own" });
    expect(codexHeaderVerdict({ kind: "none" }, [], id)).toEqual({ kind: "own" });
  });

  it("the feed: another session's rollout at this id's path, the pane with no folder, shows nothing", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(path, rollout(otherId, siblingFolder, [secret]), path);
    const { feed, leaked } = follow(reader, []);
    try {
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("the feed: the pane's own rollout, the pane with no folder, still shows", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(path, ownRollout("Plan the beacon release"), path);
    const { feed, texts } = follow(reader, []);
    try {
      expect(await eventually(() => texts.includes("user:Plan the beacon release"), 5_000)).toBe(true);
      expect(feed.state.status).toBe("live");
    } finally {
      feed.stop();
    }
  });
});

describe("the header proof is the shown file's, made on every load and reload", () => {
  it("a plain reader: the same name replaced between the header read and the first tail read", async () => {
    class SwapReader extends FakeTranscriptReader {
      reads = 0;
      override async read(file: string, offset: number, maxBytes: number): Promise<Uint8Array> {
        const bytes = await super.read(file, offset, maxBytes);
        this.reads += 1;
        if (this.reads === 1) this.put(path, sibling(), path);
        return bytes;
      }
    }
    const reader = new SwapReader();
    reader.put(path, ownRollout("Own question"), path);
    const { feed, leaked } = follow(reader, [ownFolder]);
    try {
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("a reader with identity: replaced between the header read and the first tail read (another inode)", async () => {
    class SwapIdentityReader extends IdentityReader {
      override async readWithIdentity(file: string, offset: number, maxBytes: number, options?: TranscriptReadOptions): Promise<TranscriptIdentityRead | null> {
        const read = await super.readWithIdentity(file, offset, maxBytes, options);
        if (this.identityReads === 1) {
          this.ino = 2;
          this.put(path, sibling(), path);
        }
        return read;
      }
    }
    const reader = new SwapIdentityReader();
    reader.put(path, ownRollout("Own question"), path);
    const { feed, leaked } = follow(reader, [ownFolder]);
    try {
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("an inode change on a live feed", async () => {
    const reader = new IdentityReader();
    reader.put(path, ownRollout("Own question"), path);
    const { feed, texts, leaked } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:Own question"), 5_000)).toBe(true);
      reader.ino = 2;
      reader.put(path, sibling(), path);
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("a shrink: a shorter rollout under the same name is read again from its start, proven first", async () => {
    const reader = new FakeTranscriptReader();
    // Longer than the sibling's replacement, so the replacement is a shrink.
    reader.put(path, rollout(id, ownFolder, ["Own question"], 2_000), path);
    const { feed, texts, leaked } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:Own question"), 5_000)).toBe(true);
      reader.put(path, sibling(), path);
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("a watch's reset: the replacement is proven before any of it shows", async () => {
    const reader = new WatchingReader();
    reader.put(path, ownRollout("Own question"), path);
    const { feed, texts, leaked } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:Own question") && reader.sink !== null, 5_000)).toBe(true);
      reader.put(path, sibling(), path);
      reader.sink!.reset();
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("a watch that pushes another file's bytes with no reset: proven the same file first, so never shown", async () => {
    const reader = new WatchingReader();
    reader.put(path, ownRollout("Own question"), path);
    const { feed, texts, leaked } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:Own question") && reader.sink !== null, 5_000)).toBe(true);
      const offset = await reader.size(path);
      const replacement = new TextEncoder().encode(sibling());
      reader.put(path, sibling(), path);
      reader.sink!.grew(offset, replacement.length, replacement.slice(offset, offset + 1_024 * 1_024));
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("the pane's own rollout replaced by a newer copy of the same session (another inode) shows again once proven", async () => {
    const reader = new IdentityReader();
    reader.put(path, ownRollout("First question"), path);
    const { feed, texts } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:First question"), 5_000)).toBe(true);
      reader.ino = 2;
      reader.put(path, ownRollout("First question", "Second question"), path);
      expect(await eventually(() => feed.state.status === "live" && shown(feed.timeline).includes("user:Second question"), 5_000)).toBe(true);
      expect(shown(feed.timeline)).toContain("user:First question");
    } finally {
      feed.stop();
    }
  });

  it("a reader with identity proves once per load: following its growth reads no header again", async () => {
    const reader = new IdentityReader();
    reader.put(path, ownRollout("First question"), path);
    const { feed, texts } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:First question"), 5_000)).toBe(true);
      reader.clearCalls();
      reader.append(path, ask("Second question", 9) + "\n");
      expect(await eventually(() => texts.includes("user:Second question"), 5_000)).toBe(true);
      expect(reader.calls.filter((call) => call.startsWith("read 0 ")), "no header read while following").toEqual([]);
    } finally {
      feed.stop();
    }
  });
});

describe("a reader that cannot give file identity: checked again, nothing shown until proven", () => {
  it("a plain reader: a longer rollout under the same name while following (no shrink) is never shown", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(path, ownRollout("Own question"), path);
    const { feed, texts, leaked } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:Own question"), 5_000)).toBe(true);
      reader.put(path, sibling(), path);
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("a plain reader: the pane's own rollout growing, or a newer copy of it, still shows", async () => {
    const reader = new FakeTranscriptReader();
    reader.put(path, ownRollout("First question"), path);
    const { feed, texts } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:First question"), 5_000)).toBe(true);
      reader.append(path, ask("Second question", 7) + "\n");
      expect(await eventually(() => texts.includes("user:Second question"), 5_000)).toBe(true);
      reader.put(path, ownRollout("First question", "Second question", "Third question"), path);
      expect(await eventually(() => shown(feed.timeline).includes("user:Third question"), 5_000)).toBe(true);
      expect(feed.state.status).toBe("live");
    } finally {
      feed.stop();
    }
  });

  it("a reader with identity whose relay is down (no identity now): another file under the name is never shown", async () => {
    const reader = new IdentityReader();
    reader.noRelay = true;
    reader.put(path, ownRollout("Own question"), path);
    const { feed, texts, leaked } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:Own question"), 5_000)).toBe(true);
      reader.put(path, sibling(), path);
      await expectRefused(feed, leaked);
    } finally {
      feed.stop();
    }
  });

  it("a load of earlier messages after the file was replaced unseen shows none of the other file", async () => {
    const reader = new FakeTranscriptReader();
    // Long enough that the first load reads only its tail: earlier messages wait before it.
    reader.put(path, rollout(id, ownFolder, ["Own latest"], 1_600), path);
    const { feed, texts, leaked } = follow(reader, [ownFolder]);
    try {
      expect(await eventually(() => texts.includes("user:Own latest"), 5_000)).toBe(true);
      expect(feed.timeline.earlier).toBe("available");
      // The same size, so the follow sees no change: only a load of earlier messages reads it.
      const size = await reader.size(path);
      const replacement = rollout(otherId, siblingFolder, [], 1_700, "s").slice(0, size - 1) + "\n";
      reader.put(path, replacement, path);
      await feed.loadEarlier();
      expect(texts.some((text) => text.startsWith("user:sss")), "the earlier load showed another file's lines").toBe(false);
      expect(leaked()).toBe(false);
    } finally {
      feed.stop();
    }
  });
});
