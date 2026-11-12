// A port of HerdrKit's ClaudeTranscriptParserHarnessTests.swift:
// a user line the harness wrote (a subagent's
// hand-back, another session's message, a task notification, local command
// output) is not the user's message: no bubble, no pairing with a pending or queued
// message, no turn of its own, nothing the user wrote in search. Decided by the
// line's fields first, by the wrapper tags when they are
// absent. Hand-built in those shapes, invented text.

import { describe, expect, it } from "vitest";

import { userMessages } from "../src/shared/chat/pending";
import { lineMatches } from "../src/shared/search/hits";
import { SearchQuery } from "../src/shared/search/search";
import { queued, reply, result, timelineOf, tool, user } from "./support/chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

const typedFields: Record<string, JSONValue> = { promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } };
const peerFields: Record<string, JSONValue> = {
  isMeta: true,
  promptSource: "system",
  turnOrigin: "peer",
  origin: { kind: "peer", from: "uds:/tmp/cc-socks/41.sock" },
};

const handBackBody = [
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. Read it and carry on.",
  "",
  "The lighthouse banner wraps because its label has no line limit.",
  "- Banner.swift:12 sets no lineLimit",
].join("\n");

const envelope = (body: string, from = "agent-7f3c"): string =>
  `Another Claude session sent a message:\n<agent-message from="${from}">\n${body}\n</agent-message>`;

const typed = (text: string, uuid: string, second: number): string => user(text, uuid, second, typedFields);
const peer = (text: string, uuid: string, second: number, fields: Record<string, JSONValue> = peerFields): string =>
  user(text, uuid, second, fields);

const users = (lines: readonly string[]): string[] => userMessages(timelineOf(lines).timeline).map((message) => message.text);

describe("the line's fields", () => {
  it("never shows a hand-back with the peer fields as the user's message, nor starts a turn with it", () => {
    const { timeline } = timelineOf([
      typed("Check why the banner wraps", "u1", 0),
      reply("Sending a subagent.", "a1", 2),
      peer(envelope(handBackBody), "m1", 30),
      reply("The label has no line limit.", "a2", 32, true),
    ]);
    expect(userMessages(timeline).map((message) => message.text)).toEqual(["Check why the banner wraps"]);
    expect(timeline.turns.length).toBe(1);
  });

  it("keeps a peer line without isMeta from being the user's", () => {
    const fields = { ...peerFields };
    delete fields.isMeta;
    expect(users([typed("Start", "u1", 0), peer("A plain note from a session with no envelope", "m1", 5, fields)])).toEqual(["Start"]);
  });

  it("keeps the user's typed message that is a whole envelope the user's", () => {
    const text = envelope("Pasted here to ask about it");
    expect(users([typed(text, "u1", 0)])).toEqual([text]);
  });
});

describe("the wrapper tags (fields absent)", () => {
  it("does not show an envelope with no fields as the user's", () => {
    const { timeline } = timelineOf([
      user("Start", "u1", 0),
      reply("Working.", "a1", 1),
      user(envelope(handBackBody), "m1", 20),
      user('<agent-message from="agent-1">\nA bare envelope\n</agent-message>', "m2", 21),
    ]);
    expect(userMessages(timeline).map((message) => message.text)).toEqual(["Start"]);
    expect(timeline.turns.length).toBe(1);
  });

  it("keeps the user's messages quoting the tags the user's", () => {
    const quoted = "Chat showed a bubble ending in </agent-message>, why?";
    const leading = '<agent-message from="x"> is what the subagent\'s report starts with, right?';
    expect(users([user(quoted, "u1", 0), user(leading, "u2", 10), typed(quoted + " (typed)", "u3", 20)])).toEqual([
      quoted,
      leading,
      quoted + " (typed)",
    ]);
  });

  it("does not show a task notification or local commands as the user's", () => {
    const notification =
      '<task-notification>\n<task-id>bg-42</task-id>\n<status>completed</status>\n<summary>Background command "Build" completed</summary>\n</task-notification>';
    expect(
      users([
        user("Start", "u1", 0),
        user(notification, "n1", 3),
        user("<command-name>/model</command-name>\n<command-message>model</command-message>", "c1", 4),
        user("<local-command-stdout>Set model to Opus</local-command-stdout>", "c2", 5),
        user("<local-command-caveat>Caveat: local.</local-command-caveat>", "c3", 6, { isMeta: true }),
      ]),
    ).toEqual(["Start"]);
  });
});

describe("the queued path", () => {
  it("does not show a hand-back queued while it works as a queued message", () => {
    const { timeline } = timelineOf([
      typed("Check the banner", "u1", 0),
      tool("toolu_1", "swift build", "a1", 2),
      queued(envelope(handBackBody), "q1", "s-q1", 20, { origin: { kind: "peer" } }),
      queued(envelope("A note from another session", "w7:p1"), "q2", "s-q2", 21),
      result("toolu_1", "Build complete", "r1", 22),
    ]);
    expect(userMessages(timeline).map((message) => message.text)).toEqual(["Check the banner"]);
    expect(timeline.turns.length).toBe(1);
  });

  it("does not show a queued task notification with its command mode", () => {
    expect(
      users([
        typed("Start", "u1", 0),
        reply("Working.", "a1", 1),
        queued("Background command finished: see the log", "q1", "s-q1", 9, {
          attachment: { type: "queued_command", commandMode: "task-notification", prompt: "Background command finished: see the log" },
        }),
      ]),
    ).toEqual(["Start"]);
  });
});

describe("pending and search", () => {
  it("leaves nothing for a pending message to pair with when a hand-back quoting it lands; the user's own line does", () => {
    const start = [typed("Check the banner", "u1", 0), reply("Working.", "a1", 1)];
    expect(users([...start, peer(envelope("Also check the footer"), "m1", 12)])).toEqual(["Check the banner"]);
    expect(users([...start, peer(envelope("Also check the footer"), "m1", 12), queued("Also check the footer", "q1", "u2", 13)])).toEqual([
      "Check the banner",
      "Also check the footer",
    ]);
  });

  it("never counts a hand-back in search as something the user wrote", () => {
    const query = SearchQuery.make("lighthouse")!;
    for (const line of [peer(envelope(handBackBody), "m1", 0), user(envelope(handBackBody), "m2", 1), queued(envelope(handBackBody), "q1", "s-q1", 2)]) {
      expect(lineMatches(line, 0, "claude", "p", query).some((match) => match.author === "you")).toBe(false);
    }
    expect(lineMatches(typed("Where is the lighthouse banner?", "u1", 3), 0, "claude", "p", query).map((match) => match.author)).toEqual(["you"]);
  });
});
