// Fixture lines in the transcripts' shapes for the Changes tests: HerdrKit's
// line makers (AwayDigestBuilderTests: claudeUser, claudeText,
// claudeTool, claudeResult, codex, lines), invented content, sorted keys.

import type { TranscriptLine } from "../../src/shared/chat/follower";
import { json } from "./chat-lines";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

export const fixtureFolder = "/Users/fixture/proj";

/** Epoch seconds of an ISO time. */
export const date = (iso: string): number => Date.parse(iso) / 1000;

export function claudeUser(uuid: string, text: string, time: string, cwd: string = fixtureFolder): string {
  return json({
    type: "user",
    uuid,
    timestamp: time,
    cwd,
    isSidechain: false,
    sessionId: "5b1d7c2e-8f3a-4e6b-9c0d-1a2b3c4d5e6f",
    message: { role: "user", content: text },
  });
}

export function claudeText(uuid: string, text: string, time: string, endTurn: boolean): string {
  return json({
    type: "assistant",
    uuid,
    timestamp: time,
    isSidechain: false,
    message: { id: "msg_" + uuid, role: "assistant", type: "message", stop_reason: endTurn ? "end_turn" : null, content: [{ type: "text", text }] },
  });
}

export function claudeTool(uuid: string, id: string, name: string, input: { [key: string]: JSONValue }, time: string): string {
  return json({
    type: "assistant",
    uuid,
    timestamp: time,
    isSidechain: false,
    message: { id: "msg_" + uuid, role: "assistant", type: "message", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] },
  });
}

export function claudeResult(uuid: string, id: string, content: string, time: string, isError = false): string {
  return json({
    type: "user",
    uuid,
    timestamp: time,
    isSidechain: false,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  });
}

export function codex(ordinal: number, type: string, payload: { [key: string]: JSONValue }, time: string): string {
  return json({ ordinal, type, payload, timestamp: time });
}

/** The lines with the offsets they would have in one file. */
export function lines(texts: readonly string[]): TranscriptLine[] {
  let offset = 0;
  return texts.map((text) => {
    const line = { text, offset };
    offset += new TextEncoder().encode(text).length + 1;
    return line;
  });
}

export function edit(uuid: string, id: string, file: string, old: string, replacement: string, time: string): string {
  return claudeTool(uuid, id, "Edit", { file_path: fixtureFolder + "/" + file, old_string: old, new_string: replacement }, time);
}

export function ok(uuid: string, id: string, time: string): string {
  return claudeResult(uuid, id, "The file has been updated.", time);
}

/**
 * HerdrKit AgentChangesTests.claude. Turn 1: Edit a.swift, Write b.swift, an
 * Edit of c.swift that fails, a MultiEdit of a.swift. Turn 2: Edit a.swift, a
 * NotebookEdit, and an Edit of d.swift waiting on its permission menu (no result).
 */
export const claudeEdits: readonly string[] = [
  claudeUser("u1", "Fix the header and add tests\nsecond line", "2026-11-02T01:00:00.000Z"),
  edit("a1", "e1", "a.swift", "let x = 1\nlet y = 2", "let x = 10\nlet y = 2", "2026-11-02T01:01:00.000Z"),
  ok("r1", "e1", "2026-11-02T01:01:01.000Z"),
  claudeTool("a2", "w1", "Write", { file_path: fixtureFolder + "/b.swift", content: "one\ntwo\nthree\n" }, "2026-11-02T01:02:00.000Z"),
  ok("r2", "w1", "2026-11-02T01:02:01.000Z"),
  edit("a3", "e2", "c.swift", "q", "r", "2026-11-02T01:03:00.000Z"),
  claudeResult("r3", "e2", "String to replace not found in file.", "2026-11-02T01:03:01.000Z", true),
  claudeTool(
    "a4",
    "m1",
    "MultiEdit",
    {
      file_path: fixtureFolder + "/a.swift",
      edits: [
        { old_string: "func f() {}", new_string: "func f() { g() }" },
        { old_string: "// end", new_string: "// end\n// really" },
      ],
    },
    "2026-11-02T01:04:00.000Z",
  ),
  ok("r4", "m1", "2026-11-02T01:04:01.000Z"),
  claudeText("a5", "Done.", "2026-11-02T01:05:00.000Z", true),
  claudeUser("u2", "Now the notebook", "2026-11-02T02:00:00.000Z"),
  edit("a6", "e3", "a.swift", "let y = 2", "", "2026-11-02T02:01:00.000Z"),
  ok("r6", "e3", "2026-11-02T02:01:01.000Z"),
  claudeTool("a7", "n1", "NotebookEdit", { notebook_path: fixtureFolder + "/n.ipynb", new_source: "print(1)\nprint(2)", cell_id: "c1" }, "2026-11-02T02:02:00.000Z"),
  ok("r7", "n1", "2026-11-02T02:02:01.000Z"),
  edit("a8", "e4", "d.swift", "a", "b", "2026-11-02T02:03:00.000Z"),
];
