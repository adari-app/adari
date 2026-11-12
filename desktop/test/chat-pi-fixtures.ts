// Synthetic Pi and omp session lines, built from the agents' own types (never a real
// session): pi-mono ea1cfcc packages/coding-agent/src/core/session-manager.ts:43-194 (the header and
// entries), packages/ai/src/types.ts:430-667 (messages and content blocks), core/messages.ts:29-66
// (`bashExecution`); oh-my-pi 21f1188 packages/coding-agent/src/session/session-entries.ts (its title
// line, header and entry types), modes/rpc/wire/rpc-wire.generated.ts:102-243 (its messages).

import { ChatTimelineBuilder } from "../src/shared/chat/builder";
import type { ChatTimeline, ChatTurn } from "../src/shared/chat/model";
import { TranscriptParser, type TranscriptFormat, type TranscriptParseStats } from "../src/shared/chat/parser";

export const piID = "019a6b2e-4c1d-7f00-8a00-0123456789ab";
export const ompID = "019a6b2e-5d2e-7f11-9b11-123456789abc";
export const otherID = "019a6b2f-0000-7000-8000-000000000001";
export const piFolder = "/Users/fixture/proj";
/** Pi's file for a session (session-manager.ts:590-594, :1079-1081). */
export const piPath = (id = piID, folder = piFolder): string =>
  `/Users/fixture/.pi/agent/sessions/--${folder.slice(1).replace(/[/\\:]/g, "-")}--/2026-11-09T09-00-00-000Z_${id}.jsonl`;
/** omp's file for a session below the home folder (session-paths.ts:46-120). */
export const ompPath = (id = ompID): string => `/Users/fixture/.omp/agent/sessions/-proj/2026-11-09T09-00-00-000Z_${id}.jsonl`;

/** The ISO time `second` seconds after 09:00:00 UTC on 9 November 2026. */
export const iso = (second: number): string => new Date(Date.UTC(2026, 10, 9, 9, 0, 0) + second * 1_000).toISOString();
/** The same as seconds since 1970. */
export const at = (second: number): number => Date.UTC(2026, 10, 9, 9, 0, 0) / 1_000 + second;

let serial = 0;
const nextID = (): string => (serial += 1).toString(16).padStart(8, "0");
let leaf: string | null = null;

/** Starts a new session's entry ids and parents. */
export function resetEntries(): void {
  serial = 0;
  leaf = null;
}

/** The header line (SessionHeader). */
export function header(fields: Record<string, unknown> = {}, id = piID, cwd = piFolder): string {
  resetEntries();
  return JSON.stringify({ type: "session", version: 3, id, timestamp: iso(0), cwd, ...fields });
}

/** An entry line (SessionEntryBase plus its own fields), a child of the one before. */
export function entry(type: string, second: number, fields: Record<string, unknown> = {}): string {
  const id = nextID();
  const line = JSON.stringify({ type, id, parentId: leaf, timestamp: iso(second), ...fields });
  leaf = id;
  return line;
}

const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A `message` entry for a UserMessage. */
export const user = (content: unknown, second: number, extra: Record<string, unknown> = {}): string =>
  entry("message", second, { message: { role: "user", content, timestamp: at(second) * 1_000, ...extra } });

/** A `message` entry for an AssistantMessage. */
export const assistant = (content: unknown[], stopReason: string, second: number, extra: Record<string, unknown> = {}): string =>
  entry("message", second, {
    message: { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", usage, stopReason, timestamp: at(second) * 1_000, ...extra },
  });

/** A `message` entry for a ToolResultMessage. */
export const result = (toolCallId: string, toolName: string, text: string, second: number, isError = false): string =>
  entry("message", second, { message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: at(second) * 1_000 } });

export const text = (value: string): Record<string, unknown> => ({ type: "text", text: value });
export const thinking = (value: string): Record<string, unknown> => ({ type: "thinking", thinking: value, thinkingSignature: "sig" });
export const call = (id: string, name: string, args: Record<string, unknown>): Record<string, unknown> => ({ type: "toolCall", id, name, arguments: args });

/** A picture's base64 of about `bytes` bytes (never decoded). */
export const picture = (bytes = 120_000): string => "iVBORw0KGgo" + "A".repeat(bytes);

/** A whole Pi session: two turns with tools, a picture, the user's `!` command, a compaction, a skill, an error and a stop. */
export function piSession(): string {
  return (
    [
      header(),
      entry("model_change", 0, { provider: "anthropic", modelId: "claude-sonnet-4-5" }),
      entry("thinking_level_change", 0, { thinkingLevel: "medium" }),
      user("Fix the failing test in src/sum.ts", 1),
      assistant([thinking("The test fails on a sign."), text("Let me look."), call("toolu_read", "read", { path: "src/sum.ts" })], "toolUse", 2),
      result("toolu_read", "read", "export const sum = (a, b) => a - b;\nexport const one = 1;", 3),
      assistant([call("toolu_bash", "bash", { command: "npm test" })], "toolUse", 4),
      result("toolu_bash", "bash", "FAIL src/sum.test.ts\n\nCommand exited with code 1", 5, true),
      assistant([call("toolu_edit", "edit", { path: "src/sum.ts", edits: [{ oldText: "a - b", newText: "a + b" }] })], "toolUse", 6),
      result("toolu_edit", "edit", "Successfully replaced 1 block(s) in src/sum.ts.", 7),
      assistant([call("toolu_write", "write", { path: "src/note.md", content: "# Note\nsum adds\n" }), call("toolu_grep", "grep", { pattern: "a - b" })], "toolUse", 8),
      result("toolu_write", "write", "Successfully wrote 17 bytes to src/note.md", 9),
      result("toolu_grep", "grep", "No matches found", 9),
      assistant([text("Fixed: `sum` subtracted.")], "stop", 10),
      entry("usage", 10, { kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-4-5", usage }),
      user([text("What is in this picture?"), { type: "image", data: picture(), mimeType: "image/png" }], 20),
      assistant([text("A cat on a mat.")], "stop", 21),
      entry("message", 30, { message: { role: "bashExecution", command: "git status", output: "On branch main\nnothing to commit", exitCode: 0, cancelled: false, truncated: false, timestamp: at(30) * 1_000 } }),
      entry("compaction", 40, { summary: "They fixed sum.", firstKeptEntryId: "00000004", tokensBefore: 50_000 }),
      user('<skill name="review" location="/Users/fixture/.pi/agent/skills/review/SKILL.md">\nReferences are relative to /Users/fixture/.pi/agent/skills/review.\n\nReview the code.\n</skill>\n\nthe parser', 50),
      assistant([], "error", 51, { errorMessage: "429 rate limit exceeded\nretry later" }),
      user("Try again", 60),
      assistant([text("Working on it")], "aborted", 61),
      entry("label", 62, { targetId: "00000004", label: "start" }),
      entry("session_info", 62, { name: "Fix sum" }),
      entry("custom", 62, { customType: "ext", data: { a: 1 } }),
      entry("custom_message", 62, { customType: "ext", content: "hidden", display: false }),
      entry("context_edit", 62, { targetId: "00000005", replacement: null }),
      entry("branch_summary", 62, { fromId: "00000004", summary: "a branch" }),
    ].join("\n") + "\n"
  );
}

/** omp's fixed-width title line (session-entries.ts:28-35, 256 bytes with its newline). */
export function titleLine(title: string): string {
  const bare = JSON.stringify({ type: "title", v: 1, title, source: "auto", updatedAt: iso(0), pad: "" });
  return JSON.stringify({ type: "title", v: 1, title, source: "auto", updatedAt: iso(0), pad: " ".repeat(255 - bare.length) });
}

/** A whole omp session: its title line, header, its own entry types, a steer, a synthetic continue and the user's Python. */
export function ompSession(title = "Rename foo"): string {
  return (
    [
      titleLine(title),
      header({ title }, ompID, piFolder),
      entry("model_change", 0, { model: "anthropic/claude-sonnet-4-5", role: "default" }),
      entry("service_tier_change", 0, { serviceTier: null }),
      entry("ttsr_injection", 0, { injectedRules: [] }),
      entry("credential_pin", 0, { provider: "anthropic", hash: "abc" }),
      entry("mode_change", 0, { mode: "none" }),
      user("Rename foo to bar", 1),
      assistant([{ type: "redactedThinking", data: "opaque" }, call("call_edit", "edit", { path: "src/a.ts", old_string: "foo", new_string: "bar" })], "toolUse", 2),
      result("call_edit", "edit", "Edited src/a.ts", 3),
      user("also update the docs", 4, { steering: true }),
      assistant([call("call_task", "task", { agent: "task", name: "Find callers", task: "Find every caller of foo", solutionSpace: "src" })], "toolUse", 5),
      result("call_task", "task", "3 callers", 6),
      entry("model_usage", 6, { purpose: "title", api: "x", provider: "anthropic", model: "haiku", usage, stopReason: "stop" }),
      entry("message", 7, { message: { role: "developer", content: "Keep going.", timestamp: at(7) * 1_000 } }),
      user("Continue.", 7, { synthetic: true }),
      assistant([text("Done: foo is bar now.")], "stop", 8),
      entry("message", 9, { message: { role: "pythonExecution", code: "print(1 + 1)", output: "2", exitCode: 0, cancelled: false, truncated: false, timestamp: at(9) * 1_000 } }),
      entry("title_change", 10, { title: "Rename", source: "auto" }),
      entry("reset_boundary", 11),
    ].join("\n") + "\n"
  );
}

/** Line by line with byte offsets, as the feed reads it. */
export function timelineOf(textOfFile: string, format: TranscriptFormat = "pi"): { timeline: ChatTimeline; stats: TranscriptParseStats; parser: TranscriptParser } {
  const parser = new TranscriptParser(format);
  const builder = new ChatTimelineBuilder();
  let offset = 0;
  for (const line of textOfFile.split("\n")) {
    const lineAt = offset;
    offset += new TextEncoder().encode(line).length + 1;
    if (line === "") continue;
    builder.apply(parser.parse(line, lineAt).events, lineAt);
  }
  return { timeline: builder.timeline, stats: parser.stats, parser };
}

export const agentTexts = (turn: ChatTurn | undefined): string[] => (turn?.items ?? []).flatMap((item) => (item.type === "agentText" ? [item.value.markdown] : []));

export async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return condition();
}
