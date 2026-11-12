// Reads a Kiro CLI V3 session's messages.jsonl (agents/kiro-locate.ts finds it and its folder).
//
// An append-only event log, one event per line (codeburn getagentseal/codeburn bb952552 src/providers/kiro.ts:686-700):
// `{id, timestamp, payload: {type, …}}` (codeburn tests/providers/kiro.test.ts:1095-1115); kiro-cli-history's demo
// lines carry the payload only (mxmehl/kiro-cli-history f96f9f05
// demo/data/kiro/sessions/workspacehash/sess_cfbd0cbbe482/messages.jsonl:1-7). The payload types read:
// - `user` {content, images, documents}: the user's message, its text (kiro-cli-history main.py:423-437 reads a text
//   `content` only; codeburn kiro.ts:813-819). Pictures and documents are not shown.
// - `assistant` {content, operationType}: `Say` the agent's text; `Reasoning` its thinking, not shown (codeburn
//   kiro.ts:829-834; kiro.test.ts:1101-1104). One with no operationType is text, as kiro-cli-history reads every
//   assistant line (main.py:423-437); any other operationType is unknown.
// - `tool_call` {toolName (codeburn reads `name` too), toolCallId}: a row named by its tool (kiro.ts:835-836). No
//   reader shows its arguments, so the row has no target and is no read, edit or command row.
// - `tool_result` {toolCallId, content, success}: the output of the call with exactly that id (`success: false` a
//   failure); one whose call is not read waits for it (the builder's orphans: an earlier load), never another's.
// - `turn_end` {stopReason}: the turn ends (kiro.ts:856-858).
// - `session_start`, `turn_start`, `session_metadata`, `usage_summary`: bookkeeping, skipped (kiro.ts:820-828,
//   :842-855; kiro.test.ts:1097-1113).
// Any other type, a line with no payload, a text that is not a string: unknown (the unrecognised note). A line whose
// `id` was read already is skipped. The lines name no folder: the session.json's, carried in (`cwd`), is the folder.

import { LineResult, otherToolName, type TranscriptLineResult } from "../claude-parser";
import { toolCall, toolOutput, userMessage } from "../model";
import { asObject, asString, ChatJSON, parseChatDate } from "../tools";

/** Line ids held to skip one read twice. */
const keptLines = 4_096;

const skippedTypes = new Set(["session_start", "turn_start", "session_metadata", "usage_summary"]);

export class KiroSessionParser {
  /** The session's folder, its session.json's `workspacePaths[0]` as the owner check read it. */
  cwd: string | null = null;
  lineOffset: number | null = null;
  private lines = new Set<string>();
  private count = 0;

  clone(): KiroSessionParser {
    const copy = new KiroSessionParser();
    copy.cwd = this.cwd;
    copy.lineOffset = this.lineOffset;
    copy.lines = new Set(this.lines);
    copy.count = this.count;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const event = ChatJSON.object(line);
    if (event === null) return LineResult.malformed();
    const payload = asObject(event.payload);
    const type = payload === null ? null : asString(payload.type);
    if (payload === null || type === null || type.length === 0) return LineResult.unknown("(no payload)");
    this.count += 1;
    const lineID = asString(event.id);
    if (lineID !== null && lineID.length > 0) {
      if (this.lines.has(lineID)) return LineResult.skipped(type);
      this.remember(lineID);
    }
    const key = lineID !== null && lineID.length > 0 ? lineID : `@${this.lineOffset ?? `n${this.count}`}`;
    const time = parseChatDate(asString(event.timestamp));
    switch (type) {
      case "user": {
        const text = asString(payload.content);
        if (text === null) return LineResult.unknown("user:content");
        if (text.trim().length === 0) return LineResult.skipped(type);
        return LineResult.events([{ type: "userMessage", message: userMessage(`kiro-${key}`, text.trim(), time) }]);
      }
      case "assistant": {
        const operation = payload.operationType === undefined ? null : asString(payload.operationType);
        if (operation === "Reasoning") return LineResult.skipped(`${type}:Reasoning`);
        if (payload.operationType !== undefined && operation !== "Say") return LineResult.unknown(`${type}:${String(operation ?? "?")}`);
        const text = asString(payload.content);
        if (text === null) return LineResult.unknown("assistant:content");
        if (text.trim().length === 0) return LineResult.skipped(type);
        return LineResult.events([{ type: "agentText", text: { id: `kiro-${key}`, markdown: text.trim(), time } }]);
      }
      case "tool_call": {
        const name = asString(payload.toolName) ?? asString(payload.name);
        if (name === null || name.length === 0) return LineResult.unknown("tool_call:name");
        const callID = asString(payload.toolCallId);
        const id = callID !== null && callID.length > 0 ? `kiro-call-${callID}` : `kiro-${key}`;
        return LineResult.events([{ type: "toolStarted", call: toolCall(id, { other: otherToolName(name) }, name, "", { time }) }]);
      }
      case "tool_result": {
        const callID = asString(payload.toolCallId);
        if (callID === null || callID.length === 0) return LineResult.unknown("tool_result:toolCallId");
        const text = asString(payload.content) ?? "";
        const output = toolOutput(text, { isError: payload.success === false });
        return LineResult.events([{ type: "toolFinished", id: `kiro-call-${callID}`, output, time }]);
      }
      case "turn_end":
        return LineResult.events([{ type: "turnCompleted", time, duration: null }]);
      default:
        return skippedTypes.has(type) ? LineResult.skipped(type) : LineResult.unknown(type);
    }
  }

  private remember(id: string): void {
    if (this.lines.size >= keptLines) {
      const oldest = this.lines.values().next().value;
      if (oldest !== undefined) this.lines.delete(oldest);
    }
    this.lines.add(id);
  }
}
