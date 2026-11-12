// The Mac Chat opens a long, image-heavy Claude session at once (as the iPhone app does).
// Over a modelled link (test/support/cold-link.ts: 226 ms, 1.5 MB/s, relay on or off):
//   the launch cache stays on show until the live read holds as many items (or the whole file), also
//           across a park and a reopen; the screenful is four turns or 20 items, read back by items in reads
//           sized from the bytes per item (1-4 MiB), every byte read once, only the lines it needs parsed;
//   a folder-only change for the same session resumes (no start over), a kept chat reads on with its
//           own folders, and a chat whose transcript was not the pane's folders' looks again when they change.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HerdrHostBackend } from "../src/main/herdr/backend";
import { ChatService, holdsCache, type ChatHosts } from "../src/main/chat/service";
import { ChatFeed, coldNextRead, standardColdLoad } from "../src/shared/chat/feed";
import { TranscriptEarlierReader } from "../src/shared/chat/follower";
import type { TranscriptSessionRef } from "../src/shared/chat/locator";
import type { ChatTimeline } from "../src/shared/chat/model";
import type { ChatUpdateEvent } from "../src/shared/ipc-contract";
import { claudePath, claudeSession, FakeTranscriptReader, loadAll, reply, shown, text, user, whole } from "./support/chat-lines";
import {
  cachedChat,
  coldFeedOpen,
  coldFolder,
  coldHost,
  coldLines,
  coldPane,
  coldPath,
  coldServiceOpen,
  coldSession,
  coldSessionID,
  ColdLink,
  itemCount,
  payload,
  rereadBytes,
  runClock,
  type ColdRun,
  type LinkMode,
} from "./support/cold-link";

const modes: LinkMode[] = ["relay", "sftp"];
const imageTurns = coldSession();
const longTurns = coldSession({ textTurns: 100, imageTurns: 8, rounds: 4 });
const small = coldSession({ textTurns: 40, imageTurns: 6 });

/** Every update before the hand-over showed the cache whole; none after it held fewer items than the cache. */
function expectHeld(run: ColdRun, cached: number): void {
  const over = run.steps.findIndex((step) => !step.catchingUp);
  expect(over, "a hand-over").toBeGreaterThan(0);
  for (const step of run.steps.slice(0, over)) expect(step.items, `held at ${step.at} ms`).toBe(cached);
  for (const step of run.steps.slice(over)) {
    if (step.status !== "live") continue;
    expect(step.items >= cached || step.earlier === "none", `${step.items} items at ${step.at} ms (cached ${cached})`).toBe(true);
  }
}

describe("the cold open over the link", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const mode of modes) {
    const relay = mode === "relay" ? "on" : "off";

    it(`keeps the launch cache on show until the live read holds as many items (relay ${relay})`, async () => {
      const cache = cachedChat(small);
      const cached = itemCount(cache);
      expect(cached).toBe(60);
      const { run, service } = await coldServiceOpen({ mode, text: small, cache });
      expect(run.steps[0]).toMatchObject({ catchingUp: true, items: 60 });
      expectHeld(run, cached);
      expect(run.handOver!.items).toBeGreaterThanOrEqual(cached);
      service.closeAll();
    });

    it(`hands the cache over at the whole file when the file holds fewer items (relay ${relay})`, async () => {
      const cache = cachedChat(imageTurns);
      const few = coldSession({ textTurns: 2, imageTurns: 1 });
      const { run, service } = await coldServiceOpen({ mode, text: few, cache, until: (steps) => steps.some((step) => !step.catchingUp) });
      expectHeld(run, itemCount(cache));
      expect(run.handOver).toMatchObject({ earlier: "none" });
      expect(run.handOver!.items).toBe(itemCount(whole(few)));
      service.closeAll();
    });

    it(`reads every byte of the cold open once (relay ${relay})`, async () => {
      const { run, feed } = await coldFeedOpen({ mode, text: imageTurns });
      expect(run.loaded).toBeDefined();
      expect(rereadBytes(run.readsBy(run.loaded!.at))).toBe(0);
      feed.stop();
    });

    it(`fills a screen of 20 items from a long agentic turn without reading back four turns (relay ${relay})`, async () => {
      const { run, feed } = await coldFeedOpen({ mode, text: longTurns });
      expect(run.fullScreen).toBeDefined();
      expect(run.fullScreen!.items).toBeGreaterThanOrEqual(20);
      // 4ad30ec6: 9.74 s (relay) / 10.93 s, then read back on to four turns: 87 items at 32.7 s / 36.3 s.
      expect(run.fullScreen!.at).toBeLessThan(8_500);
      expect(run.loaded!.items).toBeLessThan(40);
      expect(run.loaded!.at).toBeLessThan(8_500);
      feed.stop();
    });
  }

  it("sizes each read back from the bytes an item took, a quarter more, within 1-4 MiB", () => {
    const range = standardColdLoad.readBytes!;
    // 1 item in 512 KiB, 19 missing: 9.5 MiB, at most 4 MiB.
    expect(coldNextRead(range, 1, 20, 512 * 1_024)).toBe(4 * 1_024 * 1_024);
    // 18 items in 3 MiB, 2 missing: 341 KiB and a quarter, at least 1 MiB.
    expect(coldNextRead(range, 18, 20, 3 * 1_024 * 1_024)).toBe(1_024 * 1_024);
    // 10 items in 2 MiB, 10 missing: 2 MiB and a quarter.
    expect(coldNextRead(range, 10, 20, 2 * 1_024 * 1_024)).toBe(2_097_150 + 524_287);
    // By whole turns where nearer: 3 whole turns of 4 in 3 MiB: 1 MiB and a quarter.
    expect(coldNextRead(range, 10, 20, 3 * 1_024 * 1_024, { whole: 3, held: 3, want: 4 })).toBe(1_310_720);
    // The plain load: its chunk each time.
    expect(coldNextRead([2_097_152, 2_097_152], 1, 20, 1)).toBe(2_097_152);
  });

  it("holds the cache over a live read with fewer items while its screenful still reads back", () => {
    const live = (items: number, earlier: ChatTimeline["earlier"]): ChatTimeline => {
      const lines: string[] = [];
      for (let index = 0; index < items; index += 1) lines.push(user(`q${index}`, `u${index}`, index));
      return { ...whole(text(lines)), earlier };
    };
    expect(holdsCache(60, live(12, "loading"))).toBe(true);
    expect(holdsCache(60, live(60, "loading"))).toBe(false);
    expect(holdsCache(60, live(12, "none"))).toBe(false);
    expect(holdsCache(60, live(12, "failed"))).toBe(false);
    expect(holdsCache(60, live(12, "capped"))).toBe(false);
    expect(holdsCache(60, live(12, "available"))).toBe(false);
  });
});

// MARK: the window's chat across park, reopen and folder changes

/** The machine: `w1:p1` the Claude pane (its folders as `folders()` says), `w1:p2` a shell. */
function hostsOver(link: ColdLink, mode: LinkMode, answered: () => boolean, folders: () => string): ChatHosts {
  const reader = link.reader(mode);
  const backend = { transcripts: () => reader } as unknown as HerdrHostBackend;
  return {
    backend: () => backend,
    pane: (_host: string, pane: string) =>
      !answered() ? null : pane === coldPane ? { paneID: pane, terminalID: "t-1", agent: "claude", cwd: folders() } : { paneID: pane, terminalID: "t-2", cwd: "/Users/fixture" },
    agent: (_host: string, pane: string) =>
      !answered() || pane !== coldPane
        ? null
        : { paneID: pane, agent: "claude", cwd: folders(), agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: coldSessionID }, agentStatus: "idle" },
  } as unknown as ChatHosts;
}

interface Window {
  readonly service: ChatService;
  readonly link: ColdLink;
  readonly updates: ChatUpdateEvent[];
  readonly page: { readonly id: number; send(channel: string, payload: ChatUpdateEvent): void; isDestroyed(): boolean };
  feed(): ChatFeed<TranscriptSessionRef> | null;
  answer(): void;
  setFolders(folders: string): void;
}

function window(mode: LinkMode, content: string, cache: ChatTimeline | null, folders = coldFolder): Window {
  const link = new ColdLink(coldPath, content);
  let answered = cache === null;
  let now = folders;
  const service = new ChatService(hostsOver(link, mode, () => answered, () => now), "chat");
  if (cache !== null) service.useLaunchCache({ chat: (_host, pane) => (pane === coldPane ? cache : null), catchingUp: () => !answered, noteChat: () => undefined });
  const updates: ChatUpdateEvent[] = [];
  const page = { id: 1, send: (_channel: string, payload: ChatUpdateEvent) => void updates.push(payload), isDestroyed: () => false };
  const windows = (service as unknown as { windows: Map<string, { feed: ChatFeed<TranscriptSessionRef> | null }> }).windows;
  return {
    service,
    link,
    updates,
    page,
    feed: () => [...windows.values()][0]?.feed ?? null,
    answer: () => {
      answered = true;
      service.refresh();
    },
    setFolders: (folders: string) => {
      now = folders;
    },
  };
}

const paneUpdates = (updates: readonly ChatUpdateEvent[], from = 0): ChatUpdateEvent[] => updates.slice(from).filter((update) => update.paneId === coldPane);

describe("park, reopen and folders", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const mode of modes) {
    const relay = mode === "relay" ? "on" : "off";

    it(`holds the launch cache across a park and a reopen until the live read holds as many (relay ${relay})`, async () => {
      const cache = cachedChat(small);
      const w = window(mode, small, cache);
      w.service.open(w.page, coldHost, coldPane);
      w.answer();
      const feed = w.feed()!;
      // The live read has its first window (fewer items than cached; its screenful reads back).
      await runClock(() => feed.state.status === "live", 30_000);
      expect(itemCount(feed.timeline)).toBeLessThan(60);
      expect(paneUpdates(w.updates).every((update) => update.catchingUp === true && itemCount(update.timeline) === 60)).toBe(true);
      // Another pane (a shell), then this one again: its kept feed shows the cache it held, catching up.
      w.service.open(w.page, coldHost, "w1:p2");
      expect(w.updates.at(-1)).toMatchObject({ paneId: "w1:p2", state: { status: "unavailable" } });
      expect(w.updates.at(-1)!.catchingUp).toBeUndefined();
      const reopened = w.updates.length;
      w.service.open(w.page, coldHost, coldPane);
      expect(w.feed()).toBe(feed);
      expect(w.updates[reopened]).toMatchObject({ paneId: coldPane, catchingUp: true });
      expect(itemCount(w.updates[reopened]!.timeline)).toBe(60);
      await runClock(() => w.updates.slice(reopened).some((update) => update.paneId === coldPane && update.catchingUp !== true), 60_000);
      const after = paneUpdates(w.updates, reopened);
      const over = after.findIndex((update) => update.catchingUp !== true);
      expect(over).toBeGreaterThan(0);
      for (const update of after.slice(0, over)) expect(itemCount(update.timeline)).toBe(60);
      expect(itemCount(after[over]!.timeline)).toBeGreaterThanOrEqual(60);
      w.service.closeAll();
    });

    it(`resumes on a folder-only change for the same session: no start over (relay ${relay})`, async () => {
      const w = window(mode, small, null);
      w.service.open(w.page, coldHost, coldPane);
      const feed = w.feed()!;
      let loaded = false;
      void feed.loaded().then(() => (loaded = true));
      await runClock(() => loaded, 60_000);
      const reads = w.link.readsOf().length;
      const sent = w.updates.length;
      // Herdr names the foreground process's folder now (same session).
      w.setFolders(`${coldFolder}/Sources`);
      w.service.refresh();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(w.feed()).toBe(feed);
      expect(feed.state.status).toBe("live");
      expect(w.updates.slice(sent).some((update) => update.state.status === "loading")).toBe(false);
      // Nothing read again: only what follows the end.
      expect(w.link.readsOf().slice(reads).every((read) => read.offset >= w.link.file.length)).toBe(true);
      w.service.closeAll();
    });

    it(`reads on with a kept chat's own folders when it is taken back after the folders changed (relay ${relay})`, async () => {
      const w = window(mode, small, null);
      w.service.open(w.page, coldHost, coldPane);
      const feed = w.feed()!;
      let loaded = false;
      void feed.loaded().then(() => (loaded = true));
      await runClock(() => loaded, 60_000);
      w.service.open(w.page, coldHost, "w1:p2");
      w.setFolders(`${coldFolder}/Sources`);
      const reads = w.link.readsOf().length;
      const sent = w.updates.length;
      w.service.open(w.page, coldHost, coldPane);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(w.feed()).toBe(feed);
      expect(feed.state.status).toBe("live");
      expect(paneUpdates(w.updates, sent).some((update) => update.state.status === "loading")).toBe(false);
      expect(w.link.readsOf().slice(reads).every((read) => read.offset >= w.link.file.length)).toBe(true);
      w.service.closeAll();
    });

    it(`looks again at once when a chat whose transcript was not the pane's folders' gets other folders (relay ${relay})`, async () => {
      const w = window(mode, small, null, "/Users/fixture/elsewhere");
      w.service.open(w.page, coldHost, coldPane);
      await runClock(() => w.updates.at(-1)?.state.status === "unavailable", 60_000);
      expect(w.updates.at(-1)!.state).toEqual({ status: "unavailable", reason: "sessionMismatch" });
      // A snapshot with the same folders: its retry runs (the first is at once) and finds the same.
      w.service.refresh();
      await vi.advanceTimersByTimeAsync(1);
      await runClock(() => w.feed()?.state.status === "unavailable", 60_000);
      // Other folders, the transcript's: it looks again at once (not after the retry's wait), and reads.
      w.setFolders(coldFolder);
      w.service.refresh();
      await runClock(() => w.updates.at(-1)?.state.status === "live", 4_000);
      expect(w.updates.at(-1)!.state.status).toBe("live");
      w.service.closeAll();
    });
  }
});

// MARK: the bounded parse and the carried reader (the feed alone)

describe("a read back parses only the lines its screenful needs", () => {
  it("parses the newest lines of a big read back into a long turn; Load earlier goes on from the first parsed, nothing lost", async () => {
    // One long agentic turn of short replies (8,000 items), then a picture of almost the first window's size:
    // the window holds a few of the replies and the picture's turn.
    const lines: string[] = [user("go on", "u0", 0)];
    for (let index = 0; index < 8_000; index += 1) lines.push(reply(`step ${index}`, `a${index}`, 1 + index));
    lines.push(coldLines.userWithShot("shot", "this screen", payload(522_000), 9_000), reply("done", "last", 9_001, true));
    const content = text(lines);
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, content, claudePath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5, maxItems: 1_000_000, historyCap: 2_000_000, cold: standardColdLoad });
    feed.start(claudeSession);
    expect(await feed.loaded()).toBe(true);
    const items = itemCount(feed.timeline);
    // A screenful (20 items) and the lines its last read back parsed (64 at first), not the thousands it read.
    expect(items).toBeGreaterThanOrEqual(20);
    expect(items).toBeLessThan(100);
    expect(feed.timeline.earlier).toBe("available");
    await loadAll(feed, 200);
    expect(feed.timeline.earlier).toBe("none");
    expect(shown(feed.timeline)).toEqual(shown(whole(content)));
    feed.stop();
  });

  it("takes on the tail of the line a read ended inside: the next read ends where it begins", () => {
    const content = new TextEncoder().encode("one\ntwo two\nthree\n");
    // `three` starts at 12; the tail of `two two` (from 6) was read already.
    const reader = new TranscriptEarlierReader(12, 4, content.subarray(6, 12));
    const first = reader.nextRead()!;
    expect(first).toEqual({ offset: 2, maxBytes: 4 });
    expect(reader.consume(first.offset, content.subarray(2, 6))).toEqual([{ text: "two two", offset: 4 }]);
    // A tail with a line break inside, or none at its end, is not taken.
    expect(new TranscriptEarlierReader(12, 4, content.subarray(2, 12)).nextRead()).toEqual({ offset: 8, maxBytes: 4 });
    expect(new TranscriptEarlierReader(12, 4, content.subarray(6, 11)).nextRead()).toEqual({ offset: 8, maxBytes: 4 });
    // A reader taken on reads its next chunk at the size set.
    reader.chunkBytes = 2;
    expect(reader.nextRead()).toEqual({ offset: 0, maxBytes: 2 });
  });
});
