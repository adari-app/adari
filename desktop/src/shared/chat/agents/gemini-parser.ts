// Reads a Gemini CLI session, `~/.gemini/tmp/<project slug>/chats/session-<time>-<id8>.jsonl`
// (gemini-cli 62bab5b): a log of JSON records, one per line, appended while Gemini works.
//
// The records (packages/core/src/services/chatRecordingTypes.ts:41-165, read back by
// chatRecordingService.ts:271-617):
// - the session's metadata, `{sessionId, projectHash, startTime, lastUpdated, kind?}` (chatRecordingService.ts:869-876);
// - a message, `{id, timestamp, type, content, displayContent?}`, type `user`, `gemini`, `info`, `error` or
//   `warning`; a `gemini` message also `toolCalls`, `thoughts`, `tokens`, `model` (chatRecordingTypes.ts:72-87).
//   A message is written again whole, under its own id, each time it changes: its tokens arrive, or its tool
//   calls finish (recordMessageTokens, recordToolCalls: chatRecordingService.ts:1168-1265, pushMessage :1068);
//   the newest copy is the message (the reader's Map.set, :475);
// - `{$set: {…}}`, a metadata change (`summary`, the session's title, among them);
// - `{$rewindTo: <id>}` and `{$patch: {…}}`, history rewritten (a rewind, a cancelled request rolled back,
//   history repaired: :1436-1483, :1528-1750).
//
// Shown: the user's messages (`displayContent` when there is one, the text the user typed, else `content`), with their
// pictures; Gemini's reply text; its tool calls, each once, finished when a later copy of its message gives the
// call's status (success, error, cancelled); an error message as the agent's text; "Request cancelled."
// (the UI's own info record, packages/cli/src/ui/hooks/useGeminiStream.ts:747) as "Interrupted"; the
// session summary as the title. Skipped: the metadata, thoughts, token counts, other info and warning
// messages, a user message that is a tool's response (`functionResponse` parts, geminiChat.ts:603-607), the
// next-speaker "Please continue." (geminiChat.ts:132) and the hooks' context envelopes
// (utils/sessionUtils.ts:97-105). A rewind and a patch are skipped too: rows already shown stay.

import { LineResult, type TranscriptLineResult } from "../claude-parser";
import { userMessage, type TranscriptEvent } from "../model";
import { asObject, asString, ChatJSON, objects, parseChatDate, type JSONObject } from "../tools";
import { geminiParts, geminiToolCall, geminiToolOutput } from "./gemini-parts";

/** geminiChat.ts:132: what Gemini CLI sends as the next speaker when the model should go on. */
const continuePrompt = "Please continue.";
/** utils/historyHardening.ts:19-20: a model turn that never arrived. */
const interruptedPlaceholder = "[The previous response was interrupted before it completed.]";
/** useGeminiStream.ts:747: the info record the user's Esc leaves. */
const cancelledInfo = "Request cancelled.";
/** Messages held to dedupe their later copies. */
const keptMessages = 512;

/** What a message already showed. */
interface Shown {
  text: boolean;
  /** Its calls: true once finished. */
  readonly calls: Map<string, boolean>;
}

const finishedStatus = (status: string | null): "ok" | "failed" | null =>
  status === "success" ? "ok" : status === "error" || status === "cancelled" ? "failed" : null;

export class GeminiSessionParser {
  /** Gemini's lines name no folder (only its hash): the locator's `.project_root` check binds it. */
  cwd: string | null = null;
  lineOffset: number | null = null;
  private shown = new Map<string, Shown>();

  clone(): GeminiSessionParser {
    const copy = new GeminiSessionParser();
    copy.cwd = this.cwd;
    copy.lineOffset = this.lineOffset;
    for (const [id, held] of this.shown) copy.shown.set(id, { text: held.text, calls: new Map(held.calls) });
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const record = ChatJSON.object(line);
    if (record === null) return LineResult.malformed();
    const id = asString(record.id);
    if (id === null || id.length === 0) {
      if (typeof record.$rewindTo === "string") return LineResult.skipped("$rewindTo");
      if (asObject(record.$patch) !== null) return LineResult.skipped("$patch");
      const set = asObject(record.$set);
      if (set !== null) {
        const summary = asString(set.summary)?.trim() ?? "";
        return summary.length > 0 ? LineResult.events([{ type: "title", value: summary }]) : LineResult.skipped("$set");
      }
      if (typeof record.sessionId === "string" && typeof record.projectHash === "string") return LineResult.skipped("metadata");
      return LineResult.unknown("(no id)");
    }
    const type = asString(record.type) ?? "";
    const time = parseChatDate(record.timestamp);
    switch (type) {
      case "user":
        return this.user(record, id, time);
      case "gemini":
        return this.gemini(record, id, time);
      case "info": {
        const text = geminiParts(record.content).text.trim();
        if (text !== cancelledInfo || this.shown.has(id)) return LineResult.skipped("info");
        this.hold(id);
        return LineResult.events([{ type: "notice", notice: { id: `gemini-${id}`, kind: "interrupted", time }, endsTurn: true }]);
      }
      case "error": {
        const text = geminiParts(record.content).text.trim();
        if (text.length === 0 || this.shown.has(id)) return LineResult.skipped("error");
        this.hold(id);
        return LineResult.events([{ type: "agentText", text: { id: `gemini-${id}`, markdown: text, time } }]);
      }
      case "warning":
        return LineResult.skipped("warning");
      default:
        return LineResult.unknown(type.length === 0 ? "(no type)" : type);
    }
  }

  private user(record: JSONObject, id: string, time: number | null): TranscriptLineResult {
    const content = geminiParts(record.content);
    if (content.responses > 0) return LineResult.skipped("toolResponse");
    if (this.shown.has(id)) return LineResult.skipped("user");
    const shown = record.displayContent === undefined || record.displayContent === null ? content : geminiParts(record.displayContent);
    const text = shown.text.trim();
    const ignored = text === continuePrompt || text.startsWith("<session_context>") || text.startsWith("<hook_context>");
    if (ignored || (text.length === 0 && content.images.length === 0)) return LineResult.skipped("user");
    this.hold(id);
    return LineResult.events([{ type: "userMessage", message: userMessage(`gemini-${id}`, text, time, content.images) }]);
  }

  private gemini(record: JSONObject, id: string, time: number | null): TranscriptLineResult {
    const held = this.hold(id);
    const events: TranscriptEvent[] = [];
    const text = geminiParts(record.content).text.trim();
    if (!held.text && text.length > 0 && text !== interruptedPlaceholder) {
      held.text = true;
      events.push({ type: "agentText", text: { id: `gemini-${id}`, markdown: text, time } });
    }
    for (const call of objects(record.toolCalls) ?? []) {
      const callID = asString(call.id);
      const name = asString(call.name);
      if (callID === null || callID.length === 0 || name === null) continue;
      const callTime = parseChatDate(call.timestamp) ?? time;
      if (!held.calls.has(callID)) {
        held.calls.set(callID, false);
        events.push({ type: "toolStarted", call: geminiToolCall(callID, name, asObject(call.args) ?? {}, callTime) });
      }
      const finished = finishedStatus(asString(call.status));
      if (finished !== null && held.calls.get(callID) === false) {
        held.calls.set(callID, true);
        events.push({ type: "toolFinished", id: callID, output: geminiToolOutput(call.resultDisplay, call.result, finished === "failed"), time: callTime });
      }
    }
    return LineResult.of(events, "gemini");
  }

  /** The message's record of what it showed, kept (the oldest forgotten past `keptMessages`). */
  private hold(id: string): Shown {
    let held = this.shown.get(id);
    if (held === undefined) {
      if (this.shown.size >= keptMessages) {
        const oldest = this.shown.keys().next().value;
        if (oldest !== undefined) this.shown.delete(oldest);
      }
      held = { text: false, calls: new Map() };
      this.shown.set(id, held);
    }
    return held;
  }
}
