// The live row on the page (src/renderer/chat/live-rows.ts,
// ChatView's LiveRow and Turn): each read's block merged with the timeline
// its Chat shows, the row growing, ended when its own transcript text lands,
// never shown beside it; a new block's row only once the feed has read to the
// end (the feed's caughtUp, carried on ChatUpdateEvent); a stop that keeps it
// at most 2 s for its text, any other stop ending it at once; events of a
// Chat no longer on screen dropped. And the row as rendered: the reply's
// Markdown, in the last turn before its footer, marked live.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatService, type ChatOwner } from "../src/main/chat/service";
import { DemoBackend } from "../src/main/demo/demo-backend";
import { demoHostIds, demoHosts } from "../src/main/demo/demo-hosts";
import { HostRegistry } from "../src/main/hosts";
import { ChatLiveScreen, liveBlock, type ChatLiveBlock } from "../src/shared/chat/live-screen";
import { emptyTimeline, makeTurn, userMessage, type ChatItem, type ChatTimeline } from "../src/shared/chat/model";
import type { ChatLiveEvent, ChatUpdateEvent } from "../src/shared/ipc-contract";
import { liveLandingMs, LiveRows } from "../src/renderer/chat/live-rows";
import { LiveRow, Turn } from "../src/renderer/chat/ChatView";
import { claudePath, claudeSession, eventually, FakeTranscriptReader, liveFeed, reply, session, text, user } from "./support/chat-lines";
import { bundledFixturesForTests } from "./support/demo-fixtures";
import { ChatFeed, type ChatFeedUpdate } from "../src/shared/chat/feed";

const agentText = (id: string, markdown: string): ChatItem => ({ type: "agentText", value: { id, markdown, time: null } });

/** The user's "go on", then the agent's texts. */
function timeline(texts: [string, string][], finished = false): ChatTimeline {
  return { ...emptyTimeline, turns: [makeTurn("t", { items: [{ type: "user", value: userMessage("u", "go on", null) }, ...texts.map(([id, markdown]) => agentText(id, markdown))], isFinished: finished })] };
}

/** The page's Chats as live-rows.ts reads them: one pane's latest update and its follows. */
class Chats {
  update: ChatUpdateEvent | null = null;
  follows = new Set<number>([1]);
  show(on: ChatTimeline, caughtUp = true): void {
    this.update = { hostId: "mac", paneId: "w1:p1", state: { status: "live" }, timeline: on, ...(caughtUp ? { caughtUp } : {}), follow: 1 };
  }
  forPane = (hostId: string, paneId: string): ChatUpdateEvent | null => (hostId === "mac" && paneId === "w1:p1" ? this.update : null);
  accepts = (event: { hostId: string; paneId: string; follow?: number }): boolean =>
    event.hostId === "mac" && event.paneId === "w1:p1" && this.follows.size > 0 && (event.follow === undefined || this.follows.has(event.follow));
  followed = (hostId: string, paneId: string): boolean => hostId === "mac" && paneId === "w1:p1" && this.follows.size > 0;
}

const block = (shown: ChatLiveBlock | null, follow = 1): ChatLiveEvent => ({ type: "block", hostId: "mac", paneId: "w1:p1", follow, block: shown });
const stop = (keeping: boolean, follow = 1): ChatLiveEvent => ({ type: "stop", hostId: "mac", paneId: "w1:p1", follow, keeping });

function setup() {
  const chats = new Chats();
  const rows = new LiveRows(chats);
  let changes = 0;
  rows.subscribe(() => (changes += 1));
  const row = (): string | null => rows.row("mac", "w1:p1", chats.update?.timeline ?? emptyTimeline);
  return { chats, rows, row, changes: () => changes };
}

/** What Chat shows: the transcript's texts, then the live row's ("live: ") when there is one. */
function shown(rows: LiveRows, on: ChatTimeline): string[] {
  const texts = on.turns.flatMap((turn) => turn.items).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));
  const live = rows.row("mac", "w1:p1", on);
  return live === null ? texts : [...texts, `live: ${live}`];
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the live row on the page", () => {
  it("grows with each read, and ends when its own text lands: one row, never both", () => {
    const { chats, rows, row, changes } = setup();
    const before = timeline([["a1", "Item 2 committed."]]);
    chats.show(before);
    rows.receive(block(liveBlock("The feed reads on")));
    expect(row()).toBe("The feed reads on");
    rows.receive(block(liveBlock("The feed reads on at once in windows")));
    expect(row()).toBe("The feed reads on at once in windows");
    expect(changes()).toBe(2);
    // The same read again changes nothing.
    rows.receive(block(liveBlock("The feed reads on at once in windows")));
    expect(changes()).toBe(2);
    const landed = timeline([
      ["a1", "Item 2 committed."],
      ["a2", "The feed reads **on at once** in windows sized for it."],
    ]);
    chats.show(landed);
    expect(row()).toBeNull();
    expect(shown(rows, landed)).toEqual(["Item 2 committed.", "The feed reads **on at once** in windows sized for it."]);
  });

  it("a block already landed never shows; a block first seen done never shows", () => {
    const { chats, rows, row } = setup();
    chats.show(timeline([["a1", "The feed reads on at once."]]));
    rows.receive(block(liveBlock("The feed reads on at once.")));
    expect(row()).toBeNull();
    rows.receive(block(liveBlock("Writing the parser tests.", true)));
    expect(row()).toBeNull();
  });

  it("a new block's row waits until the feed has read the transcript to its end", () => {
    const { chats, rows, row } = setup();
    chats.show(timeline([]), false);
    rows.receive(block(liveBlock("I'll check")));
    expect(row()).toBeNull();
    chats.show(timeline([["old", "I'll check the sidebar first."]]), true);
    rows.receive(block(liveBlock("I'll check")));
    expect(row()).toBe("I'll check");
  });

  it("a read with no block ends the row", () => {
    const { chats, rows, row } = setup();
    chats.show(timeline([]));
    rows.receive(block(liveBlock("The feed")));
    rows.receive(block(null));
    expect(row()).toBeNull();
  });

  it("the work ended (keeping): the row stays at most 2 s for its text, and goes the moment it lands", async () => {
    const { chats, rows, row } = setup();
    chats.show(timeline([]));
    rows.receive(block(liveBlock("The feed reads on")));
    rows.receive(stop(true));
    expect(row()).toBe("The feed reads on");
    await vi.advanceTimersByTimeAsync(liveLandingMs - 1);
    expect(row()).toBe("The feed reads on");
    // Its text lands within the wait: the row goes at once.
    chats.show(timeline([["own", "The feed reads on."]]));
    expect(row()).toBeNull();
    // Not landed: gone after the wait.
    chats.show(timeline([]));
    rows.receive(block(liveBlock("Another reply")));
    rows.receive(stop(true));
    await vi.advanceTimersByTimeAsync(liveLandingMs);
    expect(row()).toBeNull();
  });

  it("a read after a keeping stop (working again) keeps the row; the wait is off", async () => {
    const { chats, rows, row } = setup();
    chats.show(timeline([]));
    rows.receive(block(liveBlock("The feed reads on")));
    rows.receive(stop(true));
    rows.receive(block(liveBlock("The feed reads on and on")));
    await vi.advanceTimersByTimeAsync(liveLandingMs * 2);
    expect(row()).toBe("The feed reads on and on");
  });

  it("any other stop ends the row at once", () => {
    const { chats, rows, row } = setup();
    chats.show(timeline([]));
    rows.receive(block(liveBlock("The feed reads on")));
    rows.receive(stop(false));
    expect(row()).toBeNull();
  });

  it("the turn's end clears a row whose text never matched", () => {
    const { chats, rows } = setup();
    chats.show(timeline([]));
    rows.receive(block(liveBlock("Some rendered text")));
    expect(rows.row("mac", "w1:p1", timeline([["final", "The turn is complete."]], true))).toBeNull();
  });

  it("events of a Chat no longer on screen, or of an earlier follow, are dropped; the Chat leaving ends the row", () => {
    const { chats, rows, row } = setup();
    chats.show(timeline([]));
    rows.receive(block(liveBlock("From an earlier follow"), 0));
    expect(row()).toBeNull();
    rows.receive(block(liveBlock("The feed reads on")));
    expect(row()).toBe("The feed reads on");
    rows.receive(stop(false, 0));
    expect(row(), "an earlier follow's stop is not this Chat's").toBe("The feed reads on");
    chats.follows.clear();
    rows.left("mac", "w1:p1");
    expect(row()).toBeNull();
    rows.receive(block(liveBlock("After it left")));
    expect(row()).toBeNull();
  });
});

/** Claude Code's screen writing `text` (its continuation lines indented, as it draws them). */
const writingScreen = (text: string): string =>
  ["\u{276F} go on", "", `\u{23FA} ${text.replaceAll("\n", "\n  ")}`, "", "\u{2722} Working\u{2026} (12s)", "", "\u{2500}".repeat(64), "\u{276F}", "\u{2500}".repeat(64)].join("\n");

// The turn's last text already explains the list the screen draws
// (Claude Code renumbers Markdown's "1. 1." and draws a dash list with glyphs): no second, live copy of it.
describe("a list that has already landed starts no live row", () => {
  const cases: [string, string, string][] = [
    ["numbered list", "1. Build the desktop\n2. Run the tests", "1. Build the desktop\n1. Run the tests"],
    ["glyph list", "\u{2022} Build the desktop\n\u{25E6} Run the tests", "- Build the desktop\n  - Run the tests"],
  ];
  it.each(cases)("an already landed %s: no row on any of three openings, one row for it in Chat", (_name, screenText, markdown) => {
    const landed = timeline([["landed", markdown]]);
    for (let opening = 0; opening < 3; opening += 1) {
      const { chats, rows } = setup();
      chats.show(landed);
      const block = ChatLiveScreen.block(writingScreen(screenText));
      expect(block?.text).toBe(screenText);
      rows.receive({ type: "block", hostId: "mac", paneId: "w1:p1", follow: 1, block });
      expect(shown(rows, landed), `opening ${opening + 1}`).toEqual([markdown]);
      // The next distinct answer still shows.
      rows.receive({ type: "block", hostId: "mac", paneId: "w1:p1", follow: 1, block: liveBlock("The next distinct answer.") });
      expect(rows.row("mac", "w1:p1", landed)).toBe("The next distinct answer.");
    }
  });

  it("the list being written still grows and lands as one row", () => {
    const { chats, rows } = setup();
    chats.show(timeline([]));
    rows.receive(block(ChatLiveScreen.block(writingScreen("1. Build the desktop"))));
    rows.receive(block(ChatLiveScreen.block(writingScreen("1. Build the desktop\n2. Run the tests"))));
    expect(rows.row("mac", "w1:p1", timeline([]))).toBe("1. Build the desktop\n2. Run the tests");
    const landed = timeline([["own", "1. Build the desktop\n1. Run the tests"]]);
    chats.show(landed);
    expect(shown(rows, landed)).toEqual(["1. Build the desktop\n1. Run the tests"]);
  });

  // The provenance and code protections stand: what the last text cannot explain with its marks in place still shows.
  const stillShown: [string, string, string][] = [
    ["marks taken off (a list drawn bare)", "first\nsecond", "- first\n- second"],
    ["code under a language label", "1. build\n2. test\ndiff\n- old", "1. build\n1. test\n```diff\n- old\n```"],
    ["a table read across", "\u{2502} it \u{2502} re \u{2502}\n\u{2502} em \u{2502} ads \u{2502}", "| Item | Reads |\n|---|---|\n| 1 | 2 |"],
    ["another ASCII mark", "* result = value;", "- `result = value;`"],
    ["an operator, not a bullet", "+ enabled = true", "- enabled = true"],
    ["code's own operator", "- first", "```\n+ first\n```"],
  ];
  it.each(stillShown)("%s: the row shows", (_name, screenText, markdown) => {
    const { chats, rows } = setup();
    const landed = timeline([["landed", markdown]]);
    chats.show(landed);
    rows.receive(block(liveBlock(screenText)));
    expect(rows.row("mac", "w1:p1", landed)).toBe(screenText);
  });
});

describe("the feed says when it has read the transcript to its end", () => {
  it("caught up once live and read to the end; not after a resume until it reads again", async () => {
    vi.useRealTimers();
    const feed = await liveFeed(text([user("go on", "u1", 1), reply("Item 2 committed.", "a1", 2)]));
    const updates: ChatFeedUpdate[] = [];
    feed.subscribe((update) => updates.push(update));
    expect(await eventually(() => feed.caughtUp)).toBe(true);
    feed.pause();
    feed.resume();
    expect(feed.caughtUp).toBe(false);
    expect(await eventually(() => feed.caughtUp)).toBe(true);
    expect(updates.at(-1)?.caughtUp).toBe(true);
    feed.stop();
    expect(feed.caughtUp).toBe(false);
    expect(updates.at(-1)?.caughtUp).toBe(false);
  });

  it("not caught up while a catch-up reads on (the file's end left unread)", async () => {
    vi.useRealTimers();
    const reader = new FakeTranscriptReader();
    reader.put(claudePath, text([user("go on", "u1", 1), reply("Item 2 committed.", "a1", 2)]), claudePath);
    const feed = new ChatFeed(reader, { pollIntervalMs: 5 });
    const updates: ChatFeedUpdate[] = [];
    feed.subscribe((update) => updates.push(update));
    feed.start(claudeSession);
    expect(await eventually(() => feed.caughtUp)).toBe(true);
    // A burst past one 4 MB catch-up window: the first read leaves the end unread.
    const padding = "y".repeat(1_000);
    const burst: string[] = [];
    for (let index = 0, length = 0; length < 4_700_000; index += 1) {
      const next = reply(`burst ${index} ${padding}`, `b${index}`, 3);
      burst.push(next);
      length += next.length + 1;
    }
    const before = updates.length;
    reader.append(claudePath, text(burst));
    expect(await eventually(() => feed.caughtUp && updates.length > before)).toBe(true);
    const during = updates.slice(before);
    expect(during.some((update) => update.state.status === "live" && update.caughtUp === false), "the window read with the end unread").toBe(true);
    expect(during.at(-1)?.caughtUp).toBe(true);
    feed.stop();
  });

  it("the service tells the page once its feed has caught up", async () => {
    vi.useRealTimers();
    const registry = new HostRegistry(() => undefined);
    const fixtures = bundledFixturesForTests();
    for (const host of demoHosts(fixtures, Date.now())) registry.add(host.descriptor, new DemoBackend(host, fixtures));
    await registry.refreshAll();
    const service = new ChatService(registry, "chat", { pollIntervalMs: 5 });
    const sent: ChatUpdateEvent[] = [];
    const page: ChatOwner = { id: 1, send: (_channel, payload) => sent.push(payload), isDestroyed: () => false };
    service.open(page, demoHostIds.macMini, "w7:p1H");
    expect(await eventually(() => sent.some((event) => event.state.status === "live" && event.caughtUp === true))).toBe(true);
    expect(sent.filter((event) => event.state.status !== "live").every((event) => event.caughtUp === undefined)).toBe(true);
    // The window out of sight and back: its kept feed is not caught up until it has read again, and then says so.
    service.setPaused(page, true);
    const back = sent.length;
    service.setPaused(page, false);
    expect(sent[back]?.caughtUp, "shown as kept, not yet read").toBeUndefined();
    expect(await eventually(() => sent.slice(back + 1).some((event) => event.caughtUp === true))).toBe(true);
    service.closeAll();
  });
});

// As the Swift app's CompanionChatLiveTests.testAdoptingAStillWarmingCaughtUpFeedDoesNotWaitForEarlierHistory, a
// feed still warming that has read its newest to the end keeps its caughtUp when a Chat adopts it, while its
// earlier history is still being read;
// only a paused feed resumed waits for its next read (the control above, "the window out of sight and back").
describe("adopting a feed that is still warming", () => {
  it("caught up on its newest while its earlier history is still out: the Chat says so at once", async () => {
    const question = `${user("Current question", "u-current", 3)}\n`;
    const earlier = text([user("Earlier question", "u-old", 1), reply("Earlier reply", "a-old", 2, true)]);
    class HeldHistory extends FakeTranscriptReader {
      held = false;
      release: (() => void) | null = null;
      override async read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
        if (offset === 0 && this.release === null) {
          this.held = true;
          await new Promise<void>((resolve) => (this.release = resolve));
        }
        return super.read(path, offset, maxBytes);
      }
    }
    const reader = new HeldHistory();
    reader.put(claudePath, `${earlier}${" ".repeat(1_024)}\n${question}`, claudePath);
    const machine = { kind: "demo", transcripts: () => reader };
    const hosts = {
      backend: () => machine,
      pane: () => ({ paneID: "p", terminalID: "t", agent: "claude", agentStatus: "working" }),
      agent: () => ({ agent: "claude", agentStatus: "working", agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: session } }),
      connection: () => 1,
      agentPanes: () => [{ hostId: "mac", paneId: "p" }],
    } as unknown as ConstructorParameters<typeof ChatService>[0];
    const service = new ChatService(hosts, "chat", { cold: { window: question.length + 1, turns: 2, chunkBytes: 4_096 }, pollIntervalMs: 100 });
    service.prefetch();
    await vi.advanceTimersByTimeAsync(0);
    const warming = [...(service as unknown as { warming: Map<string, { feed: ChatFeed<typeof claudeSession> }> }).warming.values()];
    expect(warming).toHaveLength(1);
    expect(reader.held, "the earlier history's read is out").toBe(true);
    expect(warming[0]!.feed.caughtUp, "the newest read to its end").toBe(true);
    const updates: ChatUpdateEvent[] = [];
    service.open({ id: 21, send: (_channel, event) => updates.push(event), isDestroyed: () => false }, "mac", "p");
    expect(warming[0]!.feed.isPaused, "adopted while still warming, never paused").toBe(false);
    expect(warming[0]!.feed.state.status).toBe("live");
    expect(updates.at(-1)?.caughtUp, "adopted as it is: caught up").toBe(true);
    // The live row may start now: a block over the adopted timeline shows.
    const rows = new LiveRows({ forPane: () => updates.at(-1) ?? null, accepts: () => true, followed: () => true });
    rows.receive({ type: "block", hostId: "mac", paneId: "p", block: liveBlock("Reading the current question") });
    expect(rows.row("mac", "p", updates.at(-1)!.timeline)).toBe("Reading the current question");
    reader.release?.();
    await vi.advanceTimersByTimeAsync(0);
    service.closeAll();
  });
});

describe("the row as rendered", () => {
  const noop = (): void => undefined;

  it("the reply's Markdown, marked live, labelled for VoiceOver", () => {
    const html = renderToStaticMarkup(createElement(LiveRow, { text: "The feed reads **on at once**:\n\n- one\n- two", onCopy: noop }));
    expect(html).toContain('class="msg-a live"');
    expect(html).toContain('aria-label="Writing now: The feed reads **on at once**:');
    expect(html).toContain('<span class="live-dot" aria-hidden="true"></span>');
    expect(html).toContain("<strong>on at once</strong>");
    expect(html).toContain("<li>");
  });

  it("the last turn's last row, before its footer", () => {
    const turn = makeTurn("t", {
      items: [{ type: "user", value: userMessage("u", "go on", 1_000) }, agentText("a1", "Item 2 committed.")],
      isFinished: true,
      startedAt: 1_000,
      lastEventAt: 1_060,
      endedAt: 1_060,
    });
    const html = renderToStaticMarkup(createElement(Turn, { turn, onCopy: noop, onMenu: noop, live: "Now the scan" }));
    const reply = html.indexOf("Item 2 committed.");
    const live = html.indexOf('class="msg-a live"');
    const footer = html.indexOf('class="worked"');
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(live).toBeGreaterThan(reply);
    expect(footer).toBeGreaterThan(live);
    // No live text: no live row.
    expect(renderToStaticMarkup(createElement(Turn, { turn, onCopy: noop, onMenu: noop }))).not.toContain("msg-a live");
  });
});
