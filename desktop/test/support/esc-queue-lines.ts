// A Chat session of this shape on
// 2026-11-06 (UTC), as its event list gives it (the texts are
// the fixtures below, the rest in Claude Code 2.1.319's shapes). The twin of
// Tests/HerdrKitTests/Support/EscQueueLines.swift.
//
//   22:35:05.842  user "testing"                      (typed)
//   22:35:08.834  assistant "Got it. ..."             (the reply, already complete)
//   22:35:08.837  user "[Request interrupted by user]"   uuid P   (the first Esc)
//   22:35:14.980  user firstPending                   uuid U1, parent P, typed
//                 (the next Esc cancelled it before any answer)
//   22:35:31.030  user gluedText                      parent P

import { json, session } from "./chat-lines";

export const escTimes = {
  testing: "2026-11-06T22:35:05.842Z",
  reply: "2026-11-06T22:35:08.834Z",
  stop: "2026-11-06T22:35:08.837Z",
  u1: "2026-11-06T22:35:14.980Z",
  glued: "2026-11-06T22:35:31.030Z",
} as const;

/** Epoch ms of a fixture time. */
export const escMs = (time: string): number => Date.parse(time);

export const firstPending = "esc doesn't work";
export const secondPending = "i have to press 3-4 times on chat pane";
export const gluedText = "esc doesn't worki have to press 3-4 times on chat pane";

type Content = string | { type: string; text: string }[];

export function claudeUser(uuid: string, parent: string | null, content: Content, timestamp: string, extra: Record<string, string | { kind: string }> = {}): string {
  return json({
    cwd: "/Users/fixture/proj",
    entrypoint: "cli",
    isSidechain: false,
    message: { content, role: "user" },
    parentUuid: parent,
    sessionId: session,
    timestamp,
    type: "user",
    userType: "external",
    uuid,
    version: "2.1.319",
    ...extra,
  });
}

export function claudeReply(uuid: string, parent: string, text: string, timestamp: string): string {
  return json({
    isSidechain: false,
    parentUuid: parent,
    sessionId: session,
    timestamp,
    type: "assistant",
    uuid,
    message: { content: [{ text, type: "text" }], id: "msg_" + uuid, role: "assistant", stop_reason: "end_turn", type: "message" },
  });
}

const typed = { promptSource: "typed" };

/** The lines up to the user's second Esc (U1 sent, no answer). */
export const beforeGlued: readonly string[] = [
  claudeUser("u-testing", "a-before", "testing", escTimes.testing, typed),
  claudeReply("a-got", "u-testing", "Got it. ...", escTimes.reply),
  claudeUser("P", "a-got", [{ type: "text", text: "[Request interrupted by user]" }], escTimes.stop),
  claudeUser("U1", "P", firstPending, escTimes.u1, typed),
];

/** As it happened: the glued message hangs off P, as U1 did. */
export const gluedLines: readonly string[] = [...beforeGlued, claudeUser("U3", "P", gluedText, escTimes.glued, typed)];
