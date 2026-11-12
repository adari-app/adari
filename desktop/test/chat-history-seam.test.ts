// What a load of earlier messages joins at its seam must be what one parse of
// the whole file gives. HerdrKit ChatHistorySeamTests.swift, ported. Fixtures
// in Claude Code's line shapes, invented content.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { toolCall, toolOutput, turnToolCalls, userMessage, type ChatTimeline, type ChatUserMessage, type TranscriptEvent } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import {
  brief,
  claudePath,
  coldSeam,
  eventually,
  failedResult,
  FakeTranscriptReader,
  liveFeed,
  loadAll,
  queued,
  reply,
  result,
  SeededRandom,
  shape,
  shown,
  text,
  tool,
  user,
  whole,
} from "./support/chat-lines";

const calls = (timeline: ChatTimeline) => timeline.turns.flatMap(turnToolCalls);
const count = (values: readonly string[], value: string): number => values.filter((entry) => entry === value).length;

describe("the latest result wins across the seam", () => {
  /** A result read after the seam for a call the earlier part already finished: the newer result wins. */
  it("a newer result for a finished call wins across the seam", () => {
    const events: TranscriptEvent[] = [
      { type: "toolStarted", call: toolCall("call", "bash", "Bash", "make") },
      { type: "toolFinished", id: "call", output: toolOutput("first result"), time: null },
      { type: "toolFinished", id: "call", output: toolOutput("failed later", { isError: true }), time: null },
    ];
    const all = new ChatTimelineBuilder();
    all.apply(events);
    const older = new ChatTimelineBuilder();
    older.apply(events.slice(0, 2), 0);
    const newer = new ChatTimelineBuilder();
    newer.apply([events[2]!], 100);
    newer.prepend(older);
    expect(calls(newer.timeline).map((call) => call.state)).toEqual(["failed"]);
    expect(calls(newer.timeline)).toEqual(calls(all.timeline));
  });

  /** Three parts: the call, a first result, a later one. Loaded newest first, the later result still wins. */
  it("the latest of two leftover results wins", () => {
    const events: TranscriptEvent[] = [
      { type: "toolStarted", call: toolCall("call", "bash", "Bash", "make") },
      { type: "toolFinished", id: "call", output: toolOutput("ok at first"), time: null },
      { type: "toolFinished", id: "call", output: toolOutput("failed later", { isError: true }), time: null },
    ];
    const all = new ChatTimelineBuilder();
    all.apply(events);
    const oldest = new ChatTimelineBuilder();
    oldest.apply([events[0]!], 0);
    const middle = new ChatTimelineBuilder();
    middle.apply([events[1]!], 100);
    const newest = new ChatTimelineBuilder();
    newest.apply([{ type: "userMessage", message: userMessage("u1", "next", null) }], 150);
    newest.apply([events[2]!], 200);
    newest.prepend(middle);
    newest.prepend(oldest);
    expect(calls(newest.timeline).map((call) => call.state)).toEqual(["failed"]);
    expect(calls(newest.timeline)).toEqual(calls(all.timeline));
  });

  /** The same through the feed: a call and its first result early, a later failed result in the loaded window. */
  it("the feed shows the latest result of an earlier call", async () => {
    const lines = Array.from({ length: 220 }, (_, n) => user(`message ${n}`, `m${n}`, n));
    lines.splice(3, 0, tool("toolu_x", "make all", "tx", 5), result("toolu_x", "built", "rx1", 6));
    lines.push(failedResult("toolu_x", "make: *** [all] Error 2", "rx2", 300));
    const content = text(lines);
    const feed = await liveFeed(content, { maxItems: 20 });
    await loadAll(feed);
    const wholeCalls = calls(whole(content));
    expect(wholeCalls.map((call) => call.state)).toEqual(["failed"]);
    expect(calls(feed.timeline)).toEqual(wholeCalls);
    feed.stop();
  });
});

describe("the parser's memory across the seam", () => {
  /** A message queued just before the seam, and the user line for it just after: one message, at its queued place. */
  it("a queued message and its user line across the seam show once", async () => {
    const content = coldSeam(
      [user("Run the tests", "u1", 0), tool("toolu_1", "swift test", "t1", 1), queued("then commit it", "q1", "user1", 20)],
      [result("toolu_1", "ok", "r1", 30), reply("Done; committing.", "a2", 40, true), user("then commit it", "user1", 41)],
    );
    const feed = await liveFeed(content);
    const before = feed.timeline;
    expect(before.earlier, "the window starts at the seam").toBe("available");
    expect(brief(before).includes("user:then commit it"), "the live part shows the user line").toBe(true);
    expect(brief(before).includes("user:Run the tests")).toBe(false);
    await loadAll(feed);
    const timeline = feed.timeline;
    expect(timeline.earlier).toBe("none");
    expect(brief(timeline)).toEqual(brief(whole(content)));
    expect(brief(timeline)).toEqual(["user:Run the tests", "tool:swift test", "user:then commit it", "agent:ffff", "agent:Done; committing."]);
    feed.stop();
  }, 30_000);

  /** The user's line before the seam, the queued line for the same input after: once, at the user line's place. */
  it("a user line and its queued line across the seam show once", async () => {
    const content = coldSeam(
      [user("use the release config", "u7", 0)],
      [queued("use the release config", "q1", "u7", 1), reply("Building release.", "a2", 20, true)],
    );
    const feed = await liveFeed(content);
    await loadAll(feed);
    const timeline = feed.timeline;
    expect(brief(timeline)).toEqual(brief(whole(content)));
    expect(count(brief(timeline), "user:use the release config")).toBe(1);
    feed.stop();
  }, 30_000);

  /** The match is two loads away: the first load's part (one long reply) holds no message. */
  it("a queued copy two loads away still shows once", async () => {
    const content = coldSeam(
      [
        user("Run the tests", "u1", 0),
        tool("toolu_1", "swift test", "t1", 1),
        queued("then commit it", "q1", "user1", 20),
        reply("g".repeat(3_000_000), "long", 21),
      ],
      [result("toolu_1", "ok", "r1", 30), reply("Done; committing.", "a2", 40, true), user("then commit it", "user1", 41)],
    );
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(content, { reader });
    await feed.loadEarlier();
    const first = feed.timeline;
    expect(first.earlier, "the first load stops inside the long reply").toBe("available");
    expect(brief(first).includes("user:Run the tests")).toBe(false);
    await loadAll(feed);
    const timeline = feed.timeline;
    expect(brief(timeline)).toEqual(brief(whole(content)));
    expect(count(brief(timeline), "user:then commit it")).toBe(1);
    feed.stop();
  }, 30_000);

  /** Two lines with no uuid, one each side of the seam: both show (their ids come from their offsets). */
  it("two lines without ids across the seam both show", async () => {
    const content = coldSeam(['{"type":"user","message":{"content":"oldest"}}'], ['{"type":"user","message":{"content":"newest"}}']);
    const feed = await liveFeed(content);
    await loadAll(feed);
    const timeline = feed.timeline;
    expect(brief(timeline)).toEqual(["user:oldest", "agent:ffff", "user:newest"]);
    expect(new Set(timeline.turns.flatMap((turn) => turn.items.map((item) => item.value.id))).size).toBe(3);
    feed.stop();
  }, 30_000);

  /** The same two lines put together by two builders whose parsers read no offsets: both stay, ids distinct. */
  it("the same made-up id on two lines keeps both", () => {
    const before = '{"type":"user","message":{"content":"oldest"}}';
    const after = '{"type":"user","message":{"content":"newest"}}';
    const olderParser = new TranscriptParser("claude");
    const newerParser = new TranscriptParser("claude");
    const older = new ChatTimelineBuilder();
    const newer = new ChatTimelineBuilder();
    older.apply(olderParser.parse(before).events, 0);
    newer.apply(newerParser.parse(after).events, 100);
    newer.prepend(older);
    expect(shown(newer.timeline)).toEqual(["user:oldest", "user:newest"]);
    expect(new Set(newer.timeline.turns.flatMap((turn) => turn.items.map((item) => item.value.id))).size).toBe(2);
  });

  /** A `!` command before the seam, its output after: the command finishes with it. */
  it("a shell command's output across the seam finishes it", async () => {
    const content = coldSeam(
      [user("<bash-input>pwd</bash-input>", "command", 0)],
      [user("<bash-stdout>/fixture</bash-stdout><bash-stderr></bash-stderr>", "result", 1), user("thanks", "u2", 5)],
    );
    const feed = await liveFeed(content);
    await loadAll(feed);
    const timeline = feed.timeline;
    const wholeCalls = calls(whole(content));
    expect(wholeCalls.map((call) => call.state)).toEqual(["ok"]);
    expect(calls(timeline)).toEqual(wholeCalls);
    expect(brief(timeline)).toEqual(brief(whole(content)));
    feed.stop();
  }, 30_000);

  /** After the load the live parser reads on as one parse would. */
  it("the live parser reads on with what the seam left", async () => {
    const queuedText = coldSeam(
      [user("Run the tests", "u1", 0), tool("toolu_1", "swift test", "t1", 1), queued("then commit it", "q1", "user1", 20)],
      [result("toolu_1", "ok", "r1", 30)],
    );
    const echo = text([reply("Done; committing.", "a2", 40, true), user("then commit it", "user1", 41), reply("Committed.", "a3", 50, true)]);
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(queuedText, { reader });
    await loadAll(feed);
    reader.append(claudePath, echo);
    expect(await eventually(() => brief(feed.timeline).at(-1) === "agent:Committed.")).toBe(true);
    const timeline = feed.timeline;
    expect(brief(timeline)).toEqual(brief(whole(queuedText + echo)));
    expect(count(brief(timeline), "user:then commit it")).toBe(1);
    feed.stop();

    const command = coldSeam([user("<bash-input>make lint</bash-input>", "command", 0)], [reply("Looking at it.", "a1", 2)]);
    const output = text([user("<bash-stdout>no issues</bash-stdout><bash-stderr></bash-stderr>", "result", 3)]);
    const shellReader = new FakeTranscriptReader();
    const shellFeed = await liveFeed(command, { reader: shellReader });
    await loadAll(shellFeed);
    expect(calls(shellFeed.timeline).map((call) => call.state), "the command waits for its output").toEqual(["running"]);
    shellReader.append(claudePath, output);
    expect(await eventually(() => calls(shellFeed.timeline)[0]?.state === "ok")).toBe(true);
    expect(calls(shellFeed.timeline)).toEqual(calls(whole(command + output)));
    shellFeed.stop();
  }, 30_000);

  /** Ids a line lacks come from its offset: the same line read twice gets the same ids; without an offset they are counted. */
  it("ids a line lacks come from its offset", () => {
    const userID = (parser: TranscriptParser, line: string, offset: number | null): string | null => {
      for (const event of parser.parse(line, offset).events) if (event.type === "userMessage") return event.message.id;
      return null;
    };
    const line = '{"type":"user","message":{"content":"no uuid"}}';
    const live = new TranscriptParser("claude");
    const later = new TranscriptParser("claude");
    const first = userID(live, line, 4_096);
    expect(first).toBe("claude-user-at4096");
    expect(userID(later, line, 4_096), "the same line read again").toBe(first);
    expect(userID(live, line, 9_000), "another line").not.toBe(first);
    const counted = new TranscriptParser("claude");
    expect(userID(counted, line, null)).toBe("claude-user-1");

    const codex = '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}';
    const codexLive = new TranscriptParser("codex");
    const codexLater = new TranscriptParser("codex");
    const codexID = userID(codexLive, codex, 512);
    expect(codexID).toBe("codex-message-at512");
    expect(userID(codexLater, codex, 512)).toBe(codexID);
  });
});

describe("a pairing the seam changes", () => {
  /** The user's "yes" before the seam; a queued "yes" with no source id after, then a user line "yes" with an id of its own. */
  it("a pairing the seam changes shows the message it hid", async () => {
    const content = coldSeam([user("yes", "first", 0)], [queued("yes", "queue-without-source", null, 30), user("yes", "second", 40)]);
    const all = whole(content);
    expect(brief(all)).toEqual(["user:yes", "agent:ffff", "user:yes"]);
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(content, { reader });
    await loadAll(feed);
    const joined = feed.timeline;
    expect(joined.earlier).toBe("none");
    expect(brief(joined)).toEqual(brief(all));
    expect(shape(joined)).toEqual(shape(all));

    const echo = text([queued("yes", "queue-late", null, 60), reply("noted", "noted", 61, true)]);
    reader.append(claudePath, echo);
    expect(await eventually(() => brief(feed.timeline).at(-1) === "agent:noted")).toBe(true);
    const afterEcho = feed.timeline;
    expect(brief(afterEcho)).toEqual(brief(whole(content + echo)));
    expect(shape(afterEcho)).toEqual(shape(whole(content + echo)));

    const third = text([user("yes", "third", 70), reply("finished", "done", 71)]);
    reader.append(claudePath, third);
    expect(await eventually(() => brief(feed.timeline).at(-1) === "agent:finished")).toBe(true);
    const end = feed.timeline;
    const wholeEnd = whole(content + echo + third);
    expect(brief(end)).toEqual(brief(wholeEnd));
    expect(count(brief(end), "user:yes")).toBe(3);
    expect(shape(end)).toEqual(shape(wholeEnd));
    feed.stop();
  }, 30_000);

  /** The same pairing when a trim moved the loaded start inside the live part. */
  it("after a trim the seam still shows the message it hid", async () => {
    const content = coldSeam(
      [user("yes", "first", 0)],
      [
        queued("yes", "queue-without-source", null, 30),
        reply("a", "a", 31),
        reply("b", "b", 32),
        reply("c", "c", 33),
        reply("d", "d", 34),
        user("yes", "second", 40),
        reply("e", "e", 41),
      ],
    );
    const all = whole(content);
    expect(brief(all)).toEqual(["user:yes", "agent:ffff", "agent:a", "agent:b", "agent:c", "agent:d", "user:yes", "agent:e"]);
    const reader = new FakeTranscriptReader();
    const feed = await liveFeed(content, { maxItems: 2, reader });
    expect(brief(feed.timeline), "trimmed: the queued row is gone, the second hidden").toEqual(["agent:d", "agent:e"]);
    await loadAll(feed);
    const joined = feed.timeline;
    expect(joined.earlier).toBe("none");
    expect(brief(joined)).toEqual(brief(all));
    expect(shape(joined)).toEqual(shape(all));

    const echo = text([queued("yes", "queue-late", null, 60), reply("noted", "noted", 61, true)]);
    reader.append(claudePath, echo);
    expect(await eventually(() => brief(feed.timeline).at(-1) === "agent:noted")).toBe(true);
    expect(brief(feed.timeline)).toEqual(brief(whole(content + echo)));
    feed.stop();
  }, 30_000);

  /** Many pairings at once, across a cold seam and trims, against one parse of the whole file (seeded). */
  it("pairings across seams and trims are one parse's", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = new SeededRandom(seed);
      let clock = 0;
      let serial = 0;
      const users: string[] = [];
      const promised: string[] = [];
      const lines = (n: number): string[] => {
        const out: string[] = [];
        for (let i = 0; i < n; i += 1) {
          clock += [3, 10, 40, 90, 200][random.next(5)]!;
          serial += 1;
          const value = random.next(3) === 0 ? "no" : "yes";
          switch (random.next(6)) {
            case 0:
            case 1: {
              const uuid = promised.length === 0 || random.next(2) === 0 ? `u${seed}-${serial}` : promised.shift()!;
              users.push(uuid);
              out.push(user(value, uuid, clock));
              break;
            }
            case 2:
              out.push(queued(value, `q${seed}-${serial}`, null, clock));
              break;
            case 3: {
              const source = `u${seed}-p${serial}`;
              promised.push(source);
              out.push(queued(value, `q${seed}-${serial}`, source, clock));
              break;
            }
            case 4: {
              const source = users.length === 0 ? `u${seed}-none` : users[random.next(users.length)]!;
              out.push(queued(value, `q${seed}-${serial}`, source, clock));
              break;
            }
            default:
              out.push(reply(`r${serial}`, `a${seed}-${serial}`, clock, random.next(2) === 0));
          }
        }
        return out;
      };
      const before = lines(3 + random.next(6));
      const after = lines(3 + random.next(8));
      const content = coldSeam(before, after);
      const reader = new FakeTranscriptReader();
      const feed = await liveFeed(content, { maxItems: [3, 200][seed % 2]!, reader });
      await loadAll(feed);
      const joined = feed.timeline;
      expect(joined.earlier, `seed ${seed}`).toBe("none");
      const all = whole(content);
      expect(brief(joined), `seed ${seed}`).toEqual(brief(all));
      expect(shape(joined), `seed ${seed} turns`).toEqual(shape(all));

      const more = text([...lines(2 + random.next(6)), reply(`end-${seed}`, `end-${seed}`, clock + 1)]);
      reader.append(claudePath, more);
      expect(await eventually(() => brief(feed.timeline).at(-1) === `agent:end-${seed}`), `seed ${seed}`).toBe(true);
      const end = feed.timeline;
      const wholeEnd = whole(content + more);
      expect(brief(end), `seed ${seed}`).toEqual(brief(wholeEnd));
      expect(shape(end), `seed ${seed} turns`).toEqual(shape(wholeEnd));
      feed.stop();
    }
  }, 120_000);

  /** The builder puts a message shown again where its line is, as `apply` would have had it. */
  it("a message shown again opens a turn where its line is", () => {
    const message = (id: string, second: number): ChatUserMessage => userMessage(id, id, second);
    const agent = (id: string, second: number): TranscriptEvent => ({ type: "agentText", text: { id, markdown: id, time: second } });
    const builder = new ChatTimelineBuilder();
    builder.apply([{ type: "userMessage", message: message("m1", 0) }], 0);
    builder.apply([agent("a", 1)], 10);
    builder.apply([agent("b", 3)], 30);
    builder.apply([{ type: "agentStopped", time: 4 }], 40);
    builder.apply([agent("c", 6)], 60);
    builder.apply([{ type: "userMessage", message: message("m2", 8) }], 80);
    expect(shape(builder.timeline)).toEqual(["m1,a,b ✓", "c ✓", "m2 …"]);

    const inside = builder.clone();
    inside.restore(message("r", 2), 20);
    expect(shape(inside.timeline)).toEqual(["m1,a ✓", "r,b ✓", "c ✓", "m2 …"]);
    expect(inside.timeline.turns[0]!.endedAt).toBe(1);

    const beforeAgent = builder.clone();
    beforeAgent.restore(message("r", 5), 50);
    expect(shape(beforeAgent.timeline)).toEqual(["m1,a,b ✓", "r,c ✓", "m2 …"]);

    const beforeMessage = builder.clone();
    beforeMessage.restore(message("r", 7), 70);
    expect(shape(beforeMessage.timeline)).toEqual(["m1,a,b ✓", "c ✓", "r ✓", "m2 …"]);

    const last = builder.clone();
    last.restore(message("r", 9), 90);
    expect(shape(last.timeline)).toEqual(["m1,a,b ✓", "c ✓", "m2 ✓", "r …"]);

    // What one parse of the same events gives, message in its place.
    const all = new ChatTimelineBuilder();
    all.apply([{ type: "userMessage", message: message("m1", 0) }], 0);
    all.apply([agent("a", 1)], 10);
    all.apply([{ type: "userMessage", message: message("r", 2) }], 20);
    all.apply([agent("b", 3)], 30);
    all.apply([{ type: "agentStopped", time: 4 }], 40);
    all.apply([agent("c", 6)], 60);
    all.apply([{ type: "userMessage", message: message("m2", 8) }], 80);
    expect(shape(inside.timeline)).toEqual(shape(all.timeline));
  });
});
