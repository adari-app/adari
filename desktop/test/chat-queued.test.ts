// A port of HerdrKit's ChatQueuedMessageTests.swift: a
// message the user sends while the agent works. Claude Code writes it as an
// `attachment` line of type `queued_command`; Codex as a user `response_item`
// inside the running turn. Hand-built fixtures in those shapes.

import { describe, expect, it } from "vitest";

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import { attachment, attachmentIsImage, itemID, turnRows, turnToolCalls, type ChatTimeline, type ChatUserMessage } from "../src/shared/chat/model";
import { TranscriptParser } from "../src/shared/chat/parser";
import { parseChatDate } from "../src/shared/chat/tools";
import {
  brief,
  claudePath,
  coldSeam,
  eventually,
  FakeTranscriptReader,
  json,
  liveFeed,
  loadAll,
  queued,
  reply,
  result,
  SeededRandom,
  session,
  shape,
  shown,
  stamp,
  text,
  timelineOf,
  tool,
  upload,
  user,
  whole,
} from "./support/chat-lines";

const messagesOf = (lines: readonly string[]): ChatUserMessage[] =>
  timelineOf(lines).timeline.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "user" ? [item.value] : [])));

describe("Claude", () => {
  it("shows a queued message at its place", () => {
    const { timeline, stats } = timelineOf([
      user("Run the scroll tests", "u1", 0),
      tool("toolu_1", "swift test --filter ScrollTests", "a1", 2),
      result("toolu_1", "Executed 6 tests, with 0 failures", "u2", 20),
      queued("also check the iPad layout", "q1", "src-1", 21),
      reply("Checking the iPad layout too.", "a2", 24),
      tool("toolu_2", "swift test --filter PadLayoutTests", "a3", 25),
      result("toolu_2", "Executed 2 tests, with 0 failures", "u3", 40),
      reply("Both pass.", "a4", 42, true),
    ]);
    expect(shown(timeline)).toEqual([
      "user:Run the scroll tests",
      "tool:swift test --filter ScrollTests",
      "user:also check the iPad layout",
      "agent:Checking the iPad layout too.",
      "tool:swift test --filter PadLayoutTests",
      "agent:Both pass.",
    ]);
    const queuedMessage = timeline.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.type === "user" && item.value.text.startsWith("also"));
    expect(queuedMessage?.value.id).toBe("q1");
    expect(queuedMessage?.value.time).toBe(parseChatDate(stamp(21)));
    expect(stats.linesWithEvents).toBe(8);
    expect(stats.skippedTypes.get("attachment")).toBeUndefined();
  });

  it("gives a queued message with an image path and a marker its images", () => {
    const messages = messagesOf([
      user("Fix the header", "u1", 0),
      tool("toolu_1", "rg header", "a1", 2),
      queued(`this is how it looks now ${upload} `, "q1", "src-1", 5),
      queued("and on the phone [Image #1]", "q2", "src-2", 6),
      queued(
        [
          { type: "text", text: "the Mac's" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        ],
        "q3",
        "src-3",
        7,
      ),
    ]);
    expect(messages.map((message) => message.text)).toEqual(["Fix the header", "this is how it looks now", "and on the phone", "the Mac's"]);
    expect(messages[1]!.attachments).toEqual([attachment(upload)]);
    expect(messages[2]!.attachments).toEqual([attachment()]);
    expect(messages[3]!.attachments).toEqual([attachment(null, "image/png")]);
    expect(messages[1]!.attachments.every(attachmentIsImage)).toBe(true);
  });

  it("shows a queued message followed by its own user line once", () => {
    const { timeline, stats } = timelineOf([
      user("Run the scroll tests", "u1", 0),
      tool("toolu_1", "swift test", "a1", 2),
      queued("then commit it", "q1", "u9", 30),
      result("toolu_1", "ok", "u2", 31),
      reply("Done; committing.", "a2", 40, true),
      user("then commit it", "u9", 41),
    ]);
    expect(shown(timeline)).toEqual(["user:Run the scroll tests", "tool:swift test", "user:then commit it", "agent:Done; committing."]);
    expect(stats.skippedTypes.get("user/queued-twice")).toBe(1);
  });

  it("shows the same input matched on text and time once", () => {
    const forward = timelineOf([
      user("start", "u1", 0),
      tool("toolu_1", "make", "a1", 1),
      queued(`use the release config ${upload}`, "q1", null, 10),
      reply("Building release.", "a2", 20, true),
      user(`use the release config ${upload}`, "u7", 50),
    ]).timeline;
    expect(shown(forward)).toEqual(["user:start", "tool:make", "user:use the release config", "agent:Building release."]);
    const { timeline: reverse, stats } = timelineOf([
      user("use the release config", "u7", 0),
      queued("use the release config", "q1", "u7", 1),
      reply("Building release.", "a2", 20, true),
    ]);
    expect(shown(reverse)).toEqual(["user:use the release config", "agent:Building release."]);
    expect(stats.skippedTypes.get("attachment/queued-twice")).toBe(1);
  });

  it("shows the same words later, or queued twice, each time", () => {
    const { timeline } = timelineOf([
      user("go on", "u1", 0),
      tool("toolu_1", "make", "a1", 1),
      queued("go on", "q1", "s1", 200),
      queued("go on", "q2", "s2", 201),
      reply("Going on.", "a2", 210, true),
    ]);
    expect(shown(timeline)).toEqual(["user:go on", "tool:make", "user:go on", "user:go on", "agent:Going on."]);
  });

  it("shows the same short reply with another id twice", () => {
    const forward = timelineOf([
      user("yes", "first", 0),
      reply("Working on the first request", "a1", 1),
      queued("yes", "second-attachment", "second-input", 10),
    ]);
    expect(shown(forward.timeline)).toEqual(["user:yes", "agent:Working on the first request", "user:yes"]);
    expect(forward.stats.skippedTypes.get("attachment/queued-twice")).toBeUndefined();
    const reverse = timelineOf([
      user("start", "u0", 0),
      tool("toolu_1", "make", "a1", 1),
      queued("yes", "q1", "input-1", 10),
      reply("Done.", "a2", 20, true),
      user("yes", "input-2", 25),
    ]);
    expect(shown(reverse.timeline)).toEqual(["user:start", "tool:make", "user:yes", "agent:Done.", "user:yes"]);
    expect(reverse.stats.skippedTypes.get("user/queued-twice")).toBeUndefined();
  });

  it("shows the same short reply written both ways once", () => {
    const byID = timelineOf([
      user("start", "u0", 0),
      tool("toolu_1", "make", "a1", 1),
      queued("yes", "q1", "input-1", 10),
      reply("Done.", "a2", 20, true),
      user("yes", "input-1", 25),
    ]);
    expect(shown(byID.timeline)).toEqual(["user:start", "tool:make", "user:yes", "agent:Done."]);
    expect(byID.stats.skippedTypes.get("user/queued-twice")).toBe(1);
    const noSource = timelineOf([
      user("start", "u0", 0),
      tool("toolu_1", "make", "a1", 1),
      queued("yes", "q1", null, 10),
      reply("Done.", "a2", 20, true),
      user("yes", "input-1", 25),
    ]);
    expect(shown(noSource.timeline)).toEqual(["user:start", "tool:make", "user:yes", "agent:Done."]);
    expect(noSource.stats.skippedTypes.get("user/queued-twice")).toBe(1);
  });

  it("keeps other attachments skipped", () => {
    const hook = json({
      attachment: {
        command: "lint",
        content: "",
        durationMs: 12,
        exitCode: 0,
        hookEvent: "PostToolUse",
        hookName: "lint",
        stderr: "",
        stdout: "",
        toolUseID: "toolu_1",
        type: "hook_success",
      },
      isSidechain: false,
      parentUuid: null,
      sessionId: session,
      timestamp: stamp(3),
      type: "attachment",
      uuid: "h1",
    });
    const file = json({
      attachment: { type: "file", filename: "/Users/fixture/proj/README.md", content: { text: "# Proj" } },
      isSidechain: false,
      sessionId: session,
      timestamp: stamp(4),
      type: "attachment",
      uuid: "f1",
    });
    const { timeline, stats } = timelineOf([
      user("start", "u1", 0),
      hook,
      file,
      queued("subagent input", "q1", "s1", 5, { isSidechain: true }),
      queued("<command-name>/compact</command-name>", "q2", "s2", 6),
    ]);
    expect(shown(timeline)).toEqual(["user:start"]);
    expect(stats.skippedTypes.get("attachment")).toBe(2);
    expect(stats.skippedTypes.get("attachment/sidechain")).toBe(1);
    expect(stats.skippedTypes.get("attachment/queued_command-empty")).toBe(1);
    expect(stats.unknown).toBe(0);
  });
});

describe("Codex", () => {
  it("shows a message sent during a turn at its place", () => {
    const lines = [
      `{"ordinal":0,"payload":{"cwd":"/Users/fixture/proj","id":"019a3c2e-7d41-7b20-9f3e-2c1d0e9f8a7b","source":"cli","timestamp":"2026-11-02T05:00:00.000Z"},"timestamp":"2026-11-02T05:00:00.000Z","type":"session_meta"}`,
      `{"ordinal":1,"payload":{"turn_id":"turn-a","type":"task_started"},"timestamp":"2026-11-02T05:00:01.000Z","type":"event_msg"}`,
      `{"ordinal":2,"payload":{"content":[{"text":"Run the tests","type":"input_text"}],"id":"m1","role":"user","type":"message"},"timestamp":"2026-11-02T05:00:01.100Z","type":"response_item"}`,
      `{"ordinal":3,"payload":{"call_id":"call_1","id":"ctc1","input":"text(await tools.exec_command({cmd:'swift test'}));","name":"exec","status":"completed","type":"custom_tool_call"},"timestamp":"2026-11-02T05:00:02.000Z","type":"response_item"}`,
      `{"ordinal":4,"payload":{"content":[{"text":"and the UI tests after","type":"input_text"}],"id":"m2","role":"user","type":"message"},"timestamp":"2026-11-02T05:00:05.000Z","type":"response_item"}`,
      String.raw`{"ordinal":5,"payload":{"call_id":"call_1","id":"ctco1","output":[{"text":"Script completed\nOutput:\nExecuted 6 tests, with 0 failures\n","type":"input_text"}],"type":"custom_tool_call_output"},"timestamp":"2026-11-02T05:00:09.000Z","type":"response_item"}`,
      `{"ordinal":6,"payload":{"content":[{"text":"Unit tests pass; running the UI tests.","type":"output_text"}],"id":"m3","role":"assistant","type":"message"},"timestamp":"2026-11-02T05:00:10.000Z","type":"response_item"}`,
      `{"ordinal":7,"payload":{"duration_ms":12000,"turn_id":"turn-a","type":"task_complete"},"timestamp":"2026-11-02T05:00:13.000Z","type":"event_msg"}`,
    ];
    const parser = new TranscriptParser("codex");
    const builder = new ChatTimelineBuilder();
    builder.apply(parser.parseText(lines.join("\n")));
    expect(shown(builder.timeline)).toEqual([
      "user:Run the tests",
      "tool:swift test",
      "user:and the UI tests after",
      "agent:Unit tests pass; running the UI tests.",
    ]);
    const swift = builder.timeline.turns.flatMap(turnToolCalls)[0];
    expect(swift?.state).toBe("ok"); // the call's result after the message still reaches it
    expect(builder.timeline.turns.every((turn) => turn.isFinished)).toBe(true);
  });
});

// As in the Swift app: a message Claude
// takes while it works (a `queued_command`) goes inside the running turn at its
// place. The turn keeps its start, its open calls and its Working timer, and
// finishes only on a real completion; a message after a finished turn still
// opens one.
describe("a queued follow-up stays inside the running turn", () => {
  it("keeps the turn running with its Bash call open, no footer, the same start", () => {
    const { timeline } = timelineOf([
      user("Run the scroll tests", "u1", 0),
      tool("toolu_1", "swift test --filter ScrollTests", "a1", 2),
      queued("also check the iPad layout", "q1", "src-1", 5),
    ]);
    expect(timeline.turns).toHaveLength(1);
    const turn = timeline.turns[0]!;
    expect(turn.items.map((item) => item.type)).toEqual(["user", "toolCall", "user"]);
    expect(turn.isFinished).toBe(false);
    expect(turn.endedAt).toBeNull();
    expect(turn.startedAt).toBe(parseChatDate(stamp(0)));
    expect(turn.lastEventAt).toBe(parseChatDate(stamp(5)));
    expect(turnToolCalls(turn).map((call) => call.state)).toEqual(["running"]);
  });

  it("finishes one turn when the follow-up's reply ends it", () => {
    const { timeline } = timelineOf([
      user("Run the scroll tests", "u1", 0),
      tool("toolu_1", "swift test --filter ScrollTests", "a1", 2),
      queued("also check the iPad layout", "q1", "src-1", 5),
      result("toolu_1", "Executed 6 tests, with 0 failures", "u2", 9),
      reply("Both pass.", "a2", 12, true),
    ]);
    expect(shape(timeline)).toEqual(["u1,toolu_1,q1,a2 ✓"]);
    const turn = timeline.turns[0]!;
    expect(turn.startedAt).toBe(parseChatDate(stamp(0)));
    expect(turn.endedAt).toBe(parseChatDate(stamp(12)));
    expect(turnToolCalls(turn).map((call) => call.state)).toEqual(["ok"]);
  });

  it("keeps a follow-up between the calls it came between once the turn folds them", () => {
    const { timeline } = timelineOf([
      user("Run the scroll tests", "u1", 0),
      tool("toolu_1", "swift test --filter ScrollTests", "a1", 2),
      result("toolu_1", "Executed 6 tests, with 0 failures", "u2", 4),
      queued("also check the iPad layout", "q1", "src-1", 5),
      tool("toolu_2", "swift test --filter PadLayoutTests", "a2", 6),
      result("toolu_2", "Executed 2 tests, with 0 failures", "u3", 8),
      reply("Both pass.", "a3", 9, true),
    ]);
    expect(timeline.turns).toHaveLength(1);
    const rows = turnRows(timeline.turns[0]!).map((row) =>
      row.type === "folded" ? `fold:${row.folded.calls.map((call) => call.id).join(",")}` : itemID(row.item),
    );
    expect(rows).toEqual(["u1", "fold:toolu_1", "q1", "fold:toolu_2", "a3"]);
  });

  it("opens a new turn after a finished one, queued or typed", () => {
    const { timeline } = timelineOf([
      user("first", "u1", 0),
      reply("one", "a1", 1, true),
      queued("second", "q1", "src-1", 5),
      reply("two", "a2", 6, true),
      user("third", "u2", 10),
    ]);
    expect(shape(timeline)).toEqual(["u1,a1 ✓", "q1,a2 ✓", "u2 …"]);
    expect(timeline.turns[1]!.startedAt).toBe(parseChatDate(stamp(5)));
  });

  it("a typed message while the agent works still ends its turn", () => {
    const { timeline } = timelineOf([user("first", "u1", 0), tool("toolu_1", "swift test", "a1", 2), user("stop, do this instead", "u2", 5)]);
    expect(shape(timeline)).toEqual(["u1,toolu_1 ✓", "u2 …"]);
  });

  it("Load earlier joins a follow-up at the seam as one parse does", async () => {
    const content = coldSeam(
      [user("Run the scroll tests", "u1", 0), tool("toolu_1", "swift test --filter ScrollTests", "a1", 2)],
      [queued("also check the iPad layout", "q1", "src-1", 30), result("toolu_1", "Executed 6 tests, with 0 failures", "u2", 31), reply("Both pass.", "a2", 33, true)],
    );
    const all = whole(content);
    expect(shape(all)).toEqual(["u1,toolu_1,filler,q1,a2 ✓"]);
    const feed = await liveFeed(content);
    expect(feed.timeline.earlier).toBe("available");
    await loadAll(feed);
    const joined = feed.timeline;
    expect(joined.earlier).toBe("none");
    expect(brief(joined)).toEqual(brief(all));
    expect(shape(joined)).toEqual(shape(all));
    expect(joined.turns[0]!.startedAt).toBe(all.turns[0]!.startedAt);
    expect(joined.turns[0]!.endedAt).toBe(all.turns[0]!.endedAt);
    expect(joined.turns.flatMap(turnToolCalls).map((call) => call.state)).toEqual(["ok"]);
    feed.stop();
  }, 30_000);

  it("Load earlier joins a follow-up still running at the seam as one parse does", async () => {
    const content = coldSeam(
      [user("Run the scroll tests", "u1", 0), tool("toolu_1", "swift test --filter ScrollTests", "a1", 2)],
      [queued("also check the iPad layout", "q1", "src-1", 30), reply("Checking that too.", "a2", 31)],
    );
    const all = whole(content);
    expect(shape(all)).toEqual(["u1,toolu_1,filler,q1,a2 …"]);
    const feed = await liveFeed(content);
    await loadAll(feed);
    expect(shape(feed.timeline)).toEqual(shape(all));
    expect(feed.timeline.turns[0]!.startedAt).toBe(all.turns[0]!.startedAt);
    expect(feed.timeline.turns.flatMap(turnToolCalls).map((call) => call.state)).toEqual(["running"]);
    feed.stop();
  }, 30_000);

  /**
   * Bash calls, their results, queued and typed messages and replies, across a
   * cold seam and trims, against one parse (seeded). As Claude writes them: every
   * result before the reply that ends the turn.
   */
  it("joins running turns with follow-ups across seams and trims as one parse does", async () => {
    // Each turn's items, whether it finished, its start and its calls' states. (Its end
    // is left out: a result read after the seam does not move the older turn's last
    // event time, the seam as it was.)
    const turns = (timeline: ChatTimeline) =>
      timeline.turns.map((turn) => [shape({ ...timeline, turns: [turn] })[0], turn.startedAt, turnToolCalls(turn).map((call) => call.state).join(",")]);
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = new SeededRandom(seed);
      let clock = 0;
      let serial = 0;
      const open: string[] = [];
      const lines = (n: number): string[] => {
        const out: string[] = [];
        for (let i = 0; i < n; i += 1) {
          clock += [1, 3, 10, 40][random.next(4)]!;
          serial += 1;
          switch (random.next(6)) {
            case 0:
              out.push(user(`typed ${serial}`, `u${seed}-${serial}`, clock));
              break;
            case 1:
              out.push(queued(`queued ${serial}`, `q${seed}-${serial}`, random.next(2) === 0 ? null : `s${seed}-${serial}`, clock));
              break;
            case 2: {
              const id = `toolu_${seed}_${serial}`;
              open.push(id);
              out.push(tool(id, `swift test ${serial}`, `t${seed}-${serial}`, clock));
              break;
            }
            case 3:
              if (open.length > 0) out.push(result(open.splice(random.next(open.length), 1)[0]!, `out ${serial}`, `r${seed}-${serial}`, clock));
              break;
            default: {
              // Claude writes every result before the reply that ends its turn.
              const ends = random.next(3) === 0;
              if (ends) for (const id of open.splice(0)) out.push(result(id, `out ${serial}`, `r${seed}-${serial}-${id}`, clock));
              out.push(reply(`r${serial}`, `a${seed}-${serial}`, clock, ends));
            }
          }
        }
        return out;
      };
      const content = coldSeam(lines(3 + random.next(8)), lines(3 + random.next(10)));
      const reader = new FakeTranscriptReader();
      const feed = await liveFeed(content, { maxItems: [3, 200][seed % 2]!, reader });
      await loadAll(feed);
      const all = whole(content);
      expect(feed.timeline.earlier, `seed ${seed}`).toBe("none");
      expect(brief(feed.timeline), `seed ${seed}`).toEqual(brief(all));
      expect(turns(feed.timeline), `seed ${seed} turns`).toEqual(turns(all));

      const more = text([...lines(2 + random.next(6)), reply(`end-${seed}`, `end-${seed}`, clock + 1)]);
      reader.append(claudePath, more);
      expect(await eventually(() => brief(feed.timeline).at(-1) === `agent:end-${seed}`), `seed ${seed}`).toBe(true);
      const wholeEnd = whole(content + more);
      expect(brief(feed.timeline), `seed ${seed}`).toEqual(brief(wholeEnd));
      expect(turns(feed.timeline), `seed ${seed} turns`).toEqual(turns(wholeEnd));
      feed.stop();
    }
  }, 120_000);
});
