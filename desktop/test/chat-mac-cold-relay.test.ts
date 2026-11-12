// Relay contract v1.2 reads in the Mac Chat (docs/relay.md, client rules 1-7), only
// while the relay is up. Reads and watches send `omit` 1024 and a cold open's first read is a `tail` read; the
// kept bytes are rebuilt in file offsets with `\u{FFFC}blob:<offset>:<length>` placeholders; a placeholder in
// a field shown as text is put back from a plain read of its range (an elided marker when that fails); a line
// that still does not parse is read again whole; an inline picture is fetched on show by its ranges, its
// inode checked. SFTP, and a relay that refuses `omit` (or an older one), read without `omit` or placeholders.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatPlace } from "../src/main/chat/service";
import { blobMark, blobParts, blobsToRestore, elidedBlob, rebuildOmitted, restoreBlobs, type BlobRange } from "../src/shared/chat/blobs";
import { TranscriptFollower } from "../src/shared/chat/follower";
import type { ChatImageBlob, ChatTimeline, TranscriptEvent } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import {
  coldFeedOpen,
  coldHost,
  coldPath,
  coldLines,
  coldLoadEarlier,
  coldServiceOpen,
  coldSession,
  payload,
  rereadBytes,
  relayOmit,
  runClock,
  shownBlobs,
  words,
  type ColdLink,
  type LinkRead,
} from "./support/cold-link";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A hex dump's token (`[0-9a-f]`, all in a run's alphabet): `length` characters. */
const hexToken = (length: number): string => "0123456789abcdef3a7c".repeat(Math.ceil(length / 20)).slice(0, length);

/** What shows, the inline pictures' references left out (a placeholder read's timeline is the full read's but for them). */
const strip = (turns: ChatTimeline["turns"]): unknown => JSON.parse(JSON.stringify(turns, (key, value: unknown) => (key === "blob" ? undefined : value)));
const stripEvents = (events: readonly TranscriptEvent[]): unknown => JSON.parse(JSON.stringify(events, (key, value: unknown) => (key === "blob" ? undefined : value)));

/** An image's base64 from its parts, each range's bytes taken from `file`. */
const fromFile = (file: Uint8Array, blob: ChatImageBlob): string =>
  blob.parts.map((part) => (typeof part === "string" ? part : decoder.decode(file.subarray(part[0], part[0] + part[1])))).join("");

const shot = payload(5_000);
const readShot = 6_000;

/** A small Claude session with every kind of run: a pasted picture, an image read, a hex dump in a Bash output. */
function smallSession(extra: string[] = []): string {
  return (
    [
      coldLines.user("u1", "first question", 10),
      coldLines.agent("a1", "First answer. " + words(300), 11),
      coldLines.userWithShot("u2", "check this screen", shot, 20),
      coldLines.agent("a2", "The screen shows the list.", 21),
      coldLines.toolUse("t1", "toolu_1", "Read", '{"file_path":"/Users/fixture/proj/shot.png"}', 22),
      coldLines.imageReadResult("t1r", "toolu_1", readShot, 23),
      coldLines.toolUse("t2", "toolu_2", "Bash", '{"command":"xxd build.bin","description":"Dump"}', 24),
      coldLines.bashResult("t2r", "toolu_2", "dump " + hexToken(2_000) + " end", 25),
      ...extra,
      coldLines.agent("a3", "Done. " + words(200), 30),
    ].join("\n") + "\n"
  );
}

/** A line whose run is outside any string: a JSON number of 1,100 digits (rule 3's full reread). */
const numberLine = coldLines.user("u3", "the number line", 26).replace(/}$/, `,"n":${"7".repeat(1_100)}}`);

/** The relay's read frames (not a refused one's reply: the frames the client sent). */
const readFrames = (link: ColdLink): Record<string, unknown>[] => link.frames.filter((frame) => frame["relay"] === "read");
const plainReads = (link: ColdLink): LinkRead[] => link.readsOf().filter((read) => read.kind === "relay" && !read.omit);

describe("offsets rebuilt and placeholders (client rules 2-4)", () => {
  it("frames cut at every byte of a session: each line parses to the full line's items once its runs are put back or fetched", () => {
    const text = [
      coldLines.user("u1", "hello \\/ there \\u00e9", 1),
      coldLines.userWithShot("u2", "a screen", payload(1_500), 2),
      coldLines.bashResult("b1", "toolu_b", "dump " + hexToken(1_100) + " end", 3),
      // A run right after an escaping backslash stays whole (the relay's escape exception).
      coldLines.user("u3", "\\/" + payload(1_200), 4),
      numberLine,
      coldLines.agent("a1", "Done.", 5),
    ].join("\n") + "\n";
    const file = encoder.encode(text);
    const fullParser = new TranscriptParser("claude");
    const lineStarts: number[] = [];
    const full: unknown[] = [];
    for (let at = 0; at < file.length; ) {
      const end = file.indexOf(0x0a, at);
      lineStarts.push(at);
      full.push(stripEvents(fullParser.parse(decoder.decode(file.subarray(at, end)), at).events));
      at = end + 1;
    }
    let blobsSeen = 0;
    let wholes = 0;
    let restored = 0;
    for (let cut = 1; cut < file.length; cut += 1) {
      const follower = new TranscriptFollower();
      const frames: [number, number][] = [
        [0, cut],
        [cut, file.length],
      ];
      const lines = [];
      for (const [index, [from, to]] of frames.entries()) {
        const request = follower.nextRead(to);
        expect(request?.offset).toBe(from);
        const left = relayOmit(file, from, file.subarray(from, to), 1_024);
        const rebuilt = rebuildOmitted(from, left.kept, left.omitted);
        expect(rebuilt).not.toBeNull();
        expect(rebuilt!.length).toBe(to - from);
        // Kept bytes where they were; a run left out is filler (`A`).
        let at = from;
        for (const [offset, length] of left.omitted) {
          expect(decoder.decode(rebuilt!.subarray(at - from, offset - from))).toBe(decoder.decode(file.subarray(at, offset)));
          expect(rebuilt!.subarray(offset - from, offset - from + length).every((byte) => byte === 0x41)).toBe(true);
          at = offset + length;
        }
        lines.push(...follower.consumeLines(from, rebuilt!, left.omitted));
        expect(follower.offset, `frame ${index}`).toBe(to);
      }
      expect(lines.map((line) => line.offset)).toEqual(lineStarts);
      const parser = new TranscriptParser("claude");
      for (const [index, line] of lines.entries()) {
        let lineText = line.text;
        let ranges: readonly BlobRange[] = [];
        if (line.blobs !== undefined) {
          const plan = blobsToRestore(line.text, line.blobs);
          if (plan.whole) {
            wholes += 1;
            lineText = decoder.decode(file.subarray(line.offset, line.end));
          } else {
            restored += plan.restore.length;
            lineText = restoreBlobs(line.text, plan.restore, (range) => file.subarray(range[0], range[0] + range[1]));
            ranges = line.blobs.filter((range) => !plan.restore.includes(range));
          }
        }
        const events = parser.parse(lineText, line.offset, ranges.length === 0 ? null : { path: coldPath, ino: 1, ranges }).events;
        expect(stripEvents(events), `cut ${cut}, line ${index}`).toEqual(full[index]);
        for (const event of events) {
          if (event.type !== "userMessage") continue;
          for (const attachment of event.message.attachments) {
            if (attachment.blob === undefined) continue;
            blobsSeen += 1;
            expect(fromFile(file, attachment.blob)).toBe(payload(1_500));
          }
        }
      }
    }
    // Every kind was met: pictures by reference, text fields put back, the number line read whole.
    expect(blobsSeen).toBeGreaterThan(file.length / 2);
    expect(restored).toBeGreaterThan(0);
    expect(wholes).toBeGreaterThan(file.length / 2);
  });

  it("rule 4: a placeholder's end comes from its range, not its digits (kept base64 after it may begin with a digit)", () => {
    const value = blobMark([72_032, 547]) + "4HtZ" + blobMark([72_583, 2_000]);
    expect(blobParts(value, [[72_032, 547], [72_583, 2_000]])).toEqual([[72_032, 547], "4HtZ", [72_583, 2_000]]);
    // Two touching ranges (a run cut by a frame edge), nothing between.
    expect(blobParts(blobMark([10, 1_024]) + blobMark([1_034, 1_100]), [[10, 1_024], [1_034, 1_100]])).toEqual([[10, 1_024], [1_034, 1_100]]);
    // A placeholder of no range of the line is not this client's: no picture to fetch.
    expect(blobParts(blobMark([5, 1_024]), [[6, 1_024]])).toBeNull();
    expect(elidedBlob([0, 2_000])).toBe("[2,000 bytes of data not shown]");
  });
});

describe("the Mac Chat's reads with the relay up (v1.2)", () => {
  it("a cold open is one tail read with omit (no size first); the timeline is the SFTP open's; each picture is fetched once, by range, ino checked", async () => {
    const text = smallSession();
    const sftp = await coldFeedOpen({ mode: "sftp", text });
    const { run, feed } = await coldFeedOpen({ mode: "relay", text });
    const link = run.link;
    const first = readFrames(link)[0]!;
    expect(first).toMatchObject({ relay: "read", path: coldPath, tail: 512 * 1_024, max: 512 * 1_024, omit: 1_024 });
    expect(first["offset"]).toBeUndefined();
    expect(link.readsOf()[0]).toMatchObject({ omit: true, offset: 0, covered: link.file.length });
    // Far less on the wire than the file: the pictures and the hex dump were left out.
    expect(link.readsOf()[0]!.kept).toBeLessThan(link.file.length / 2);
    expect(strip(feed.timeline.turns)).toEqual(strip(sftp.feed.timeline.turns));
    const blobs = shownBlobs(feed.timeline);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!).toMatchObject({ path: coldPath, ino: link.ino });
    expect(shownBlobs(sftp.feed.timeline)).toEqual([]);

    // Fetched on show: plain reads (no omit) of exactly its ranges.
    const before = link.readsOf().length;
    let got: string | null = null;
    void feed.fetchImage(blobs[0]!).then((value) => (got = value));
    await runClock(() => got !== null, 10_000);
    expect(got).toBe(shot);
    const fetches = link.readsOf().slice(before);
    const ranges = blobs[0]!.parts.filter((part): part is readonly [number, number] => typeof part !== "string");
    expect(fetches.map((read) => [read.offset, read.covered, read.omit])).toEqual(ranges.map(([offset, length]) => [offset, length, false]));
    // Nothing was sent twice: the open left the picture out, the fetch sent it once.
    expect(rereadBytes(link.readsOf())).toBe(0);

    // Another file under the name: the fetch is refused by its inode.
    link.ino = 777_002;
    let refused: string | null | undefined;
    void feed.fetchImage(blobs[0]!).then((value) => (refused = value));
    await runClock(() => refused !== undefined, 10_000);
    expect(refused).toBeNull();
    feed.stop();
    sftp.feed.stop();
  });

  it("a placeholder in a field shown as text is put back from a plain read of its range; one that cannot be read shows elided", async () => {
    const text = smallSession();
    const { run, feed } = await coldFeedOpen({ mode: "relay", text });
    const outputOf = (timeline: ChatTimeline): string =>
      JSON.stringify(timeline.turns.flatMap((turn) => turn.items).filter((item) => item.type === "toolCall"));
    expect(outputOf(feed.timeline)).toContain(hexToken(2_000));
    // Its own read: no omit, its range only (the output's and the toolUseResult's copy, each once).
    const hexAt = text.indexOf(hexToken(2_000));
    expect(hexAt).toBeGreaterThan(0);
    expect(plainReads(run.link).filter((read) => read.covered === 2_000).map((read) => read.offset)).toEqual([hexAt, text.indexOf(hexToken(2_000), hexAt + 1)]);
    feed.stop();

    const failing = await coldFeedOpen({ mode: "relay", text, link: (link) => (link.plainReadsFail = true) });
    expect(outputOf(failing.feed.timeline)).not.toContain(hexToken(2_000));
    expect(outputOf(failing.feed.timeline)).toContain("dump [2,000 bytes of data not shown] end");
    failing.feed.stop();
  });

  it("a line that still does not parse (a run outside any string) is read again in full with a plain read of its range", async () => {
    const text = smallSession([numberLine]);
    const sftp = await coldFeedOpen({ mode: "sftp", text });
    const { run, feed } = await coldFeedOpen({ mode: "relay", text });
    const lineAt = text.indexOf(numberLine);
    expect(plainReads(run.link).some((read) => read.offset === lineAt && read.covered === encoder.encode(numberLine).length)).toBe(true);
    expect(JSON.stringify(feed.timeline)).toContain("the number line");
    expect(strip(feed.timeline.turns)).toEqual(strip(sftp.feed.timeline.turns));
    feed.stop();
    sftp.feed.stop();
  });

  it("a long session: read backs and Load earlier read with omit (offsets rebuilt, the carried tail's runs kept); the timeline is the SFTP open's", async () => {
    const text = coldSession({ textTurns: 12, imageTurns: 6 });
    const sftp = await coldFeedOpen({ mode: "sftp", text });
    const relay = await coldFeedOpen({ mode: "relay", text });
    expect(strip(relay.feed.timeline.turns)).toEqual(strip(sftp.feed.timeline.turns));
    // The open sent no byte twice (its read backs carry the line tail they ended inside).
    expect(relay.run.link.readsOf().length).toBeGreaterThan(1);
    expect(rereadBytes(relay.run.link.readsOf())).toBe(0);
    await coldLoadEarlier(sftp.run.link, sftp.feed);
    await coldLoadEarlier(relay.run.link, relay.feed);
    expect(strip(relay.feed.timeline.turns)).toEqual(strip(sftp.feed.timeline.turns));
    // Every transcript read with the relay up asked to leave runs out (no range to put back here).
    expect(relay.run.link.readsOf().every((read) => read.omit)).toBe(true);
    // Each picture on show comes whole from its ranges.
    for (const blob of shownBlobs(relay.feed.timeline)) expect(fromFile(relay.run.link.file, blob)).toBe(payload(fromFile(relay.run.link.file, blob).length));
    relay.feed.stop();
    sftp.feed.stop();
  });

  it("rule 7: a picture written while watched comes in grew frames of 256 KB, its run in touching parts; fetched, it is whole", async () => {
    const text = smallSession();
    const { run, feed } = await coldFeedOpen({ mode: "relay", text });
    const big = payload(600_000);
    run.link.append(coldLines.userWithShot("u9", "the new screen", big, 40) + "\n");
    const newest = (): ChatImageBlob | undefined => shownBlobs(feed.timeline).at(-1);
    await runClock(() => newest()?.parts.length !== undefined && newest()!.parts.length > 1, 30_000);
    const blob = newest()!;
    const ranges = blob.parts.filter((part): part is readonly [number, number] => typeof part !== "string");
    expect(ranges.length).toBeGreaterThan(1);
    for (let index = 1; index < ranges.length; index += 1) expect(ranges[index]![0]).toBe(ranges[index - 1]![0] + ranges[index - 1]![1]);
    expect(run.link.frames.some((frame) => frame["relay"] === "watch" && frame["omit"] === 1_024)).toBe(true);
    let got: string | null = null;
    void feed.fetchImage(blob).then((value) => (got = value));
    await runClock(() => got !== null, 10_000);
    expect(got).toBe(big);
    feed.stop();
  });
});

describe("plain reads without v1.2", () => {
  it("relay off (SFTP): no relay frame, plain SFTP reads, pictures as frames (nothing to fetch)", async () => {
    const text = smallSession();
    const { run, feed } = await coldFeedOpen({ mode: "sftp", text });
    expect(run.link.frames).toEqual([]);
    expect(run.link.readsOf().every((read) => read.kind === "sftp" && read.omitted.length === 0)).toBe(true);
    // The window from the file's start (smaller than 512 KB), read whole in SFTP reads.
    expect(run.link.readsOf().reduce((total, read) => total + read.covered, 0)).toBe(run.link.file.length);
    expect(shownBlobs(feed.timeline)).toEqual([]);
    const blob: ChatImageBlob = { path: coldPath, ino: null, parts: [[100, 2_000]] };
    expect(await feed.fetchImage(blob)).toBeNull();
    feed.stop();
  });

  it("a relay that refuses omit: one refused frame, then every frame is v1.1's (no omit, no tail); the timeline is SFTP's, nothing to fetch", async () => {
    const text = smallSession();
    const sftp = await coldFeedOpen({ mode: "sftp", text });
    const { run, feed } = await coldFeedOpen({ mode: "relay", text, relayKind: "refusesOmit" });
    const frames = run.link.frames.filter((frame) => frame["relay"] === "read" || frame["relay"] === "watch");
    expect(frames[0]).toMatchObject({ omit: 1_024, tail: 512 * 1_024 });
    for (const frame of frames.slice(1)) {
      expect(frame["omit"]).toBeUndefined();
      expect(frame["tail"]).toBeUndefined();
      expect(Object.keys(frame).every((key) => ["relay", "id", "path", "offset", "max"].includes(key))).toBe(true);
    }
    expect(strip(feed.timeline.turns)).toEqual(strip(sftp.feed.timeline.turns));
    expect(shownBlobs(feed.timeline)).toEqual([]);
    feed.stop();
    sftp.feed.stop();
  });

  it("an older relay (v1.1: unknown fields ignored): no omitted, so it reads without placeholders; the timeline is SFTP's", async () => {
    const text = smallSession();
    const sftp = await coldFeedOpen({ mode: "sftp", text });
    const { run, feed } = await coldFeedOpen({ mode: "relay", text, relayKind: "v1.1" });
    const frames = readFrames(run.link);
    expect(frames[0]).toMatchObject({ omit: 1_024, tail: 512 * 1_024 });
    for (const frame of frames.slice(1)) expect(frame["omit"]).toBeUndefined();
    expect(strip(feed.timeline.turns)).toEqual(strip(sftp.feed.timeline.turns));
    expect(shownBlobs(feed.timeline)).toEqual([]);
    feed.stop();
    sftp.feed.stop();
  });
});

describe("a picture fetched on show through ChatService", () => {
  it("only a picture a message on show carries, from the live chat's transcript, once (kept for a show again)", async () => {
    const text = smallSession();
    const { run, service } = await coldServiceOpen({ mode: "relay", text, cache: null });
    const windows = (service as unknown as { windows: Map<string, { timeline: ChatTimeline }> }).windows;
    const timeline = [...windows.values()][0]!.timeline;
    const blob = shownBlobs(timeline)[0]!;
    const owner = { id: 1 };
    // Asked of the chat on show: its machine and slot ("" the one pane view's).
    const ask = async (wanted: ChatImageBlob, from: { readonly id: number } = owner, place: ChatPlace = { hostId: coldHost, slot: "" }): Promise<string | null> => {
      let got: string | null | undefined;
      void service.blobImage(from, wanted, place).then((value) => (got = value));
      // What needs no read answers before the clock moves (a poll would read).
      for (let turn = 0; turn < 20 && got === undefined; turn += 1) await Promise.resolve();
      await runClock(() => got !== undefined, 10_000);
      return got!;
    };
    const before = run.link.readsOf().length;
    expect(await ask(blob)).toBe(`data:image/png;base64,${shot}`);
    const afterFirst = run.link.readsOf().length;
    expect(afterFirst).toBeGreaterThan(before);
    // Shown again: no read.
    expect(await ask(JSON.parse(JSON.stringify(blob)) as ChatImageBlob)).toBe(`data:image/png;base64,${shot}`);
    expect(run.link.readsOf().length).toBe(afterFirst);
    // A range no message on show carries, or another window: nothing read.
    expect(await ask({ ...blob, parts: [[0, 4_096]] })).toBeNull();
    expect(await ask(blob, { id: 2 })).toBeNull();
    // Another machine, or a slot with no chat: nothing read.
    expect(await ask(blob, owner, { hostId: "other", slot: "" })).toBeNull();
    expect(await ask(blob, owner, { hostId: coldHost, slot: "tile" })).toBeNull();
    expect(run.link.readsOf().length).toBe(afterFirst);
    service.closeAll();
  });
});
