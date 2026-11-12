// Reads a Qwen Code session, `~/.qwen/projects/<cwd, every character but A–Z, a–z, 0–9 as
// "-">/chats/<session id>.jsonl` (qwen-code d32faa2): one ChatRecord per line, appended, never rewritten
// (packages/core/src/services/chatRecordingService.ts:1222-1231, :1466-1481; config/storage.ts:619-623;
// utils/paths.ts:388-392).
//
// A record (chatRecordingService.ts:413-625): `{uuid, parentUuid, sessionId, timestamp, type, subtype?, cwd,
// version, message?: Content, toolCallResult?, systemPayload?, isSidechain?}`, type `user`, `assistant`,
// `tool_result` or `system`. Its `message` is the model's own Content (`role`, `parts`), the parts Gemini CLI
// uses (gemini-parts.ts). Read as Qwen Code's own resume reads it (packages/cli/src/ui/utils/resumeHistoryUtils.ts:292-665):
// - `user` with no subtype: the user's prompt, `systemPayload.displayText` when the payload is the prompt's
//   (transcript-records.ts:230-260), else the text the user typed for a pending `@` command (`at_command`'s
//   `userText`), else the message's text; `mid_turn_user_message`: a message sent while Qwen worked
//   (queued); other subtypes (notifications, cron, agent mentions and messages, goals) and mod prompts are not the user's;
// - `assistant`: Qwen's text (thought parts skipped) and its `functionCall`s; a reply with no call ends the turn;
// - `tool_result`: `toolCallResult` (`callId`, `status` success, error or cancelled, `resultDisplay`) finishes its call;
// - `system`: `chat_compression` is "Conversation compacted", `custom_title` the title (`titleSource` auto: the
//   AI title, else the user's own), `turn_result` with state `cancelled` "Interrupted" (:1076-1095); the rest is skipped.
// A subagent's records (`isSidechain`) are not this chat's. A record's `cwd` is the transcript's folder.

import { LineResult, type TranscriptLineResult } from "../claude-parser";
import { userMessage, type TranscriptEvent } from "../model";
import { asObject, asString, ChatJSON, parseChatDate, type JSONObject } from "../tools";
import { geminiParts, geminiToolCall, geminiToolOutput } from "./gemini-parts";

/** Records held to dedupe a record written twice. */
const keptRecords = 1_024;

const finishedStatus = (status: string | null): "ok" | "failed" =>
  status === "error" || status === "cancelled" || status === "canceled" ? "failed" : "ok";

export class QwenSessionParser {
  /** The newest folder a record names. */
  cwd: string | null = null;
  lineOffset: number | null = null;
  private seen = new Set<string>();
  /** `@` commands' text, waiting for the prompt record they go with. */
  private atCommands: string[] = [];

  clone(): QwenSessionParser {
    const copy = new QwenSessionParser();
    copy.cwd = this.cwd;
    copy.lineOffset = this.lineOffset;
    copy.seen = new Set(this.seen);
    copy.atCommands = [...this.atCommands];
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const record = ChatJSON.object(line);
    if (record === null) return LineResult.malformed();
    const type = asString(record.type);
    const uuid = asString(record.uuid);
    if (type === null || uuid === null || uuid.length === 0) return LineResult.unknown(type ?? "(no type)");
    const cwd = asString(record.cwd);
    if (cwd !== null && cwd.startsWith("/") && record.isSidechain !== true) this.cwd = cwd;
    if (record.isSidechain === true) return LineResult.skipped("sidechain");
    if (this.seen.has(uuid)) return LineResult.skipped(type);
    const result = this.record(record, type, uuid, parseChatDate(record.timestamp));
    if (result.events.length > 0) this.remember(uuid);
    return result;
  }

  private record(record: JSONObject, type: string, uuid: string, time: number | null): TranscriptLineResult {
    const subtype = asString(record.subtype);
    const payload = asObject(record.systemPayload);
    switch (type) {
      case "user":
        return this.user(record, subtype, payload, uuid, time);
      case "assistant": {
        const parts = geminiParts(asObject(record.message)?.parts);
        const events: TranscriptEvent[] = [];
        const text = parts.text.trim();
        if (text.length > 0) events.push({ type: "agentText", text: { id: `qwen-${uuid}`, markdown: text, time } });
        parts.calls.forEach((call, index) => {
          const id = call.id !== null && call.id.length > 0 ? call.id : `qwen-${uuid}-call-${index}`;
          events.push({ type: "toolStarted", call: geminiToolCall(id, call.name, call.args, time) });
        });
        if (parts.calls.length === 0 && text.length > 0) events.push({ type: "agentStopped", time });
        return LineResult.of(events, "assistant");
      }
      case "tool_result": {
        const result = asObject(record.toolCallResult);
        const callID = asString(result?.callId);
        if (result === null || callID === null || callID.length === 0) return LineResult.skipped("tool_result");
        const failed = finishedStatus(asString(result.status)) === "failed";
        const display = result.resultDisplay ?? (failed ? asString(asObject(result.error)?.message) : null);
        const output = geminiToolOutput(display, result.responseParts ?? asObject(record.message)?.parts, failed);
        return LineResult.events([{ type: "toolFinished", id: callID, output, time }]);
      }
      case "system":
        return this.system(subtype, payload, uuid, time);
      default:
        return LineResult.unknown(type);
    }
  }

  private user(record: JSONObject, subtype: string | null, payload: JSONObject | null, uuid: string, time: number | null): TranscriptLineResult {
    const kind = subtype ?? "user";
    const queued = subtype === "mid_turn_user_message";
    if ((subtype !== null && !queued) || record.provenance === "mod_prompt") return LineResult.skipped(kind);
    const parts = geminiParts(asObject(record.message)?.parts);
    if (parts.responses > 0 && parts.text.trim().length === 0) return LineResult.skipped("toolResponse");
    // transcript-records.ts:242-248: the payload's displayText is the prompt as the user wrote it when the payload is the prompt's.
    const isPrompt = payload !== null && typeof payload.hookContext === "string";
    const display = queued || isPrompt ? asString(payload?.displayText) : null;
    const typed = queued ? undefined : this.atCommands.shift();
    const text = (display !== null && display.length > 0 ? display : typed !== undefined && typed.length > 0 ? typed : parts.text).trim();
    if (text.length === 0 && parts.images.length === 0) return LineResult.skipped(kind);
    return LineResult.events([{ type: "userMessage", message: userMessage(`qwen-${uuid}`, text, time, parts.images), ...(queued ? { queued: true } : {}) }]);
  }

  private system(subtype: string | null, payload: JSONObject | null, uuid: string, time: number | null): TranscriptLineResult {
    switch (subtype) {
      case "chat_compression":
        return LineResult.events([{ type: "notice", notice: { id: `qwen-${uuid}`, kind: "compacted", time }, endsTurn: false }]);
      case "custom_title": {
        const title = asString(payload?.customTitle)?.trim() ?? "";
        if (title.length === 0) return LineResult.skipped(subtype);
        return LineResult.events([payload?.titleSource === "auto" ? { type: "title", value: title } : { type: "customTitle", value: title }]);
      }
      case "turn_result":
        if (payload?.state !== "cancelled") return LineResult.skipped(subtype);
        return LineResult.events([{ type: "notice", notice: { id: `qwen-${uuid}`, kind: "interrupted", time }, endsTurn: true }]);
      case "at_command": {
        const typed = asString(payload?.userText);
        if (typed !== null) this.atCommands = [...this.atCommands.slice(-7), typed];
        return LineResult.skipped(subtype);
      }
      default:
        return LineResult.skipped(subtype ?? "system");
    }
  }

  private remember(uuid: string): void {
    if (this.seen.size >= keptRecords) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(uuid);
  }
}

