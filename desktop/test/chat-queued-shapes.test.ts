// Claude Code 2.1.31x's
// lines around a message sent while the agent works, rebuilt from the
// redacted dump of a real session (section A: "h" typed, a
// message queued during that turn and delivered after it as a promptSource
// "queued" user line, then its turn, then a typed message whose turn takes two
// more messages mid-turn as queued_command attachments). Every line, its order
// and fields kept; each text is filler of its length
// (desktop/fixtures/chat/claude-queued-shapes.jsonl). Read cold and live, the
// chat shows each message once at its place, a "Worked for" once per finished
// turn, never two together, no turn ending between a command and its reply,
// and no pending bubble left.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { turnFooter, turnRows, workedForText, type ChatTimeline } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { PendingMessages } from "../src/shared/chat/pending";
import { claudePath, eventually, FakeTranscriptReader, liveFeed, loadAll } from "./support/chat-lines";
import { readRepoFile } from "./support/swift-fixtures";

const lines = readRepoFile("desktop/fixtures/chat/claude-queued-shapes.jsonl").split("\n").filter((line) => line !== "");

/** Every row Chat draws, turn by turn, each finished turn's "Worked for" last; texts as their length. */
export function rows(timeline: ChatTimeline): string[] {
  return timeline.turns.flatMap((turn) => {
    const drawn = turnRows(turn).map((row) => {
      if (row.type === "folded") return "folded:" + row.folded.summary;
      const item = row.item;
      if (item.type === "user") return `user[${item.value.text.length}]`;
      if (item.type === "agentText") return `agent[${item.value.markdown.length}]`;
      if (item.type === "toolCall") return "tool:" + item.value.target;
      return item.type;
    });
    const footer = turnFooter(turn);
    return [...drawn, ...(footer === null ? [] : [workedForText(footer)])];
  });
}

const expected = [
  "user[1]",
  "folded:Ran 1 command",
  "agent[866]",
  "Worked for 10s",
  "user[32]",
  "folded:Ran 1 command",
  "agent[958]",
  "Worked for 25s",
  "user[207]",
  "agent[170]",
  "tool:swift test",
  "tool:swift test",
  "agent[121]",
  "tool:swift test",
  "user[220]",
  "tool:/Users/fixture/proj/README.md",
  "tool:swift test",
  "user[324]",
];

const noAdjacentWorkedFor = (drawn: readonly string[]): boolean =>
  drawn.every((row, index) => index === 0 || !(row.startsWith("Worked for") && drawn[index - 1]!.startsWith("Worked for")));

describe("the real line shapes of a message sent while Claude works", () => {
  it("reads cold as each message once at its place and one Worked for per finished turn", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    builder.apply(parser.parseText(lines.join("\n")));
    const drawn = rows(builder.timeline);
    expect(drawn).toEqual(expected);
    expect(noAdjacentWorkedFor(drawn)).toBe(true);
    expect(builder.timeline.turns.map((turn) => turn.isFinished)).toEqual([true, true, false]);
  });

  it("reads the same live, line by line, and every pending bubble clears", () => {
    const parser = new TranscriptParser("claude");
    const builder = new ChatTimelineBuilder();
    const store = new PendingMessages();
    const key = "host/w7:p1";
    for (const line of lines) {
      builder.apply(parser.parseText(line));
      store.observe(key, builder.timeline);
      const object = JSON.parse(line) as { type: string; operation?: string; content?: string; timestamp?: string };
      // The user sent it when Claude Code enqueued it (the page's send comes just before).
      if (object.type === "queue-operation" && object.operation === "enqueue") store.add(key, object.content!, Date.parse(object.timestamp!) - 200);
      expect(noAdjacentWorkedFor(rows(builder.timeline))).toBe(true);
    }
    expect(rows(builder.timeline)).toEqual(expected);
    expect(store.forPane(key)).toEqual([]);
  });

  it("reads the same through the feed: appended as Claude Code writes it, and loaded in windows", async () => {
    // Appended a line at a time after each cut (the follower's live reads).
    for (const cut of [1, 10, 17, 21, 30, 45, 60]) {
      const reader = new FakeTranscriptReader();
      const feed = await liveFeed(lines.slice(0, cut).join("\n") + "\n", { reader });
      for (const line of lines.slice(cut)) {
        reader.append(claudePath, line + "\n");
        await eventually(() => noAdjacentWorkedFor(rows(feed.timeline)) === false, 15);
        expect(noAdjacentWorkedFor(rows(feed.timeline))).toBe(true);
      }
      expect(await eventually(() => rows(feed.timeline).join("|") === expected.join("|"))).toBe(true);
      feed.stop();
    }
    // Opened with a small window, then every earlier part loaded.
    for (const maxItems of [1, 2, 3, 5, 8, 12]) {
      const feed = await liveFeed(lines.join("\n") + "\n", { maxItems });
      expect(noAdjacentWorkedFor(rows(feed.timeline))).toBe(true);
      await loadAll(feed);
      expect(rows(feed.timeline)).toEqual(expected);
      feed.stop();
    }
  });
});
