// Reads a Cursor agent chat's messages, one store blob per line in the
// root's order (`CursorStoreView`, cursor-store.ts): `{role, content, id?, providerOptions?}`
// (Cursor agent 2026.10.22). A port of HerdrKit's CursorStoreParser.swift.
//
// Shown: the user's message (a `user` message's `<user_query>` text, timed by its `<timestamp>`, the
// user's local time with its UTC offset; one after a harness `<system_notification>` is the user's too, `anchored`),
// Cursor's reply (`assistant` `text` parts), its reasoning (`reasoning` with text, the thinking
// row), tool calls (`tool-call`) folded with their results by `toolCallId` (`tool` messages'
// `tool-result`; `providerOptions.cursor.highLevelToolCallResult.isError` a failure): Read, Shell
// (its command), Grep and Glob as search, StrReplace an edit with its diff, Write a new file, any
// other name a plain row; the compaction summary (`<conversation_summary>`) the compaction row.
// An `assistant` message with no tool call ends the turn.
//
// Skipped and counted: the system prompt, the context pack, `<system_reminder>`, a notification
// with no `user_query`, role-less blobs and the view's placeholders (a missing ref, a blob that is
// not JSON, too long, or with bad hex).

import { firstLine, LineResult, otherToolName, type TranscriptLineResult } from "./claude-parser";
import { CodexRolloutParser } from "./codex-parser";
import {
  attachment,
  bashDetail,
  searchDetail,
  toolCall,
  toolOutput,
  userMessage,
  type ChatAttachment,
  type ChatToolCall,
  type ChatToolDetail,
  type ChatToolKind,
  type TranscriptEvent,
} from "./model";
import { asArray, asObject, asString, ChatDiffMaker, ChatJSON, isObject, type JSONObject } from "./tools";

const blank = (text: string): boolean => text.trim().length === 0;

const queryOpen = "<user_query>";
const queryClose = "</user_query>";

/** What a user message's text is, by the anchors Cursor writes (`CursorStoreParser.anchored`). */
export type Anchored =
  | { readonly kind: "words"; readonly words: string; readonly stamp: string | null }
  | { readonly kind: "compacted" }
  | { readonly kind: "skipped"; readonly type: string }
  | { readonly kind: "unknown" };

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const timePattern =
  /^\s*[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*\(\s*(?:UTC|GMT)\s*(?:([+-])(\d{1,2})(?:([:.])(\d{1,2}))?)?\s*\)\s*$/;

export class CursorStoreParser {
  /** Where the line being read starts in the view, when the caller knows: ids are made from it. */
  private offset: number | null = null;
  private idsInLine = 0;
  private serial = 0;
  /** Cursor's messages name no folder; the chat's meta.json does (`TranscriptParser.carryFolder`). */
  cwd: string | null = null;

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  get lineOffset(): number | null {
    return this.offset;
  }

  clone(): CursorStoreParser {
    const copy = new CursorStoreParser();
    copy.serial = this.serial;
    copy.cwd = this.cwd;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const placeholder = asString(object.cursorRef);
    if (placeholder !== null && Object.keys(object).length === 1) return LineResult.skipped(`cursor ${placeholder} ref`);
    const role = asString(object.role);
    if (role === null) return LineResult.skipped("no role");
    switch (role) {
      case "system":
        return LineResult.skipped("system");
      case "user":
        return this.user(object.content);
      case "assistant":
        return this.assistant(object.content);
      case "tool":
        return this.tool(object);
      default:
        return LineResult.unknown(role);
    }
  }

  // MARK: the user's messages

  private user(content: unknown): TranscriptLineResult {
    let text = "";
    const pictures: ChatAttachment[] = [];
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content.filter(isObject)) {
        if (part.type === "text") text += (text.length === 0 ? "" : "\n") + (asString(part.text) ?? "");
        else if (part.type === "image") {
          const type = asString(part.mimeType) ?? asString(part.mediaType);
          pictures.push(attachment(null, type === null || type.length === 0 ? null : type));
        }
      }
    } else {
      return LineResult.skipped("user");
    }
    // The recorded anchors decide; nothing between them is read
    // for tags.
    const anchored = CursorStoreParser.anchored(text);
    switch (anchored.kind) {
      case "compacted":
        return LineResult.events([{ type: "notice", notice: { id: this.nextID("compacted"), kind: "compacted", time: null }, endsTurn: false }]);
      case "skipped":
        return LineResult.skipped(anchored.type);
      case "unknown":
        return LineResult.unknown("user envelope");
      case "words": {
        const said = anchored.words.trim();
        if (said.length === 0 && pictures.length === 0) return LineResult.skipped("user_query");
        const time = anchored.stamp === null ? null : CursorStoreParser.time(anchored.stamp);
        return LineResult.events([{ type: "userMessage", message: userMessage(this.nextID("prompt"), said, time, pictures) }]);
      }
    }
  }

  /** The context pack's openers (its first element is one of these). */
  static readonly contextOpeners = ["<user_info>", "<git_status>", "<agent_transcripts>", "<rules>"];

  /**
   * Cursor's recorded user messages are anchored. The trimmed text starts with one known envelope
   * and the user's words run to the end, so a tag inside the user's words or
   * inside harness text is never structure:
   * - a context pack or `<system_reminder>`: skipped, whatever follows;
   * - `<conversation_summary>`: the compaction row once it closes (the harness text after its close
   *   is not shown; an unclosed one is skipped);
   * - `<timestamp>` (its text up to the first `</timestamp>`), then `<user_query>`, the user's words; or
   *   `<system_notification>` whose close is followed by `<user_query>` with the text ending
   *   `</user_query>`, the user's words; a notification without that is skipped; anything else unknown;
   * - `<user_query>`: the user's words from the opener to a final `</user_query>`, or to the end when cut off;
   * - plain text: the user's as is; any other opening tag: unknown.
   */
  static anchored(raw: string): Anchored {
    const text = raw.trim();
    if (!text.startsWith("<")) return { kind: "words", words: text, stamp: null };
    if (CursorStoreParser.contextOpeners.some((opener) => text.startsWith(opener))) return { kind: "skipped", type: "context" };
    if (text.startsWith("<system_reminder>")) return { kind: "skipped", type: "system_reminder" };
    if (text.startsWith("<conversation_summary>")) {
      return text.includes("</conversation_summary>") ? { kind: "compacted" } : { kind: "skipped", type: "conversation_summary" };
    }
    if (text.startsWith(queryOpen)) return { kind: "words", words: CursorStoreParser.query(text), stamp: null };
    const stampEnd = text.startsWith("<timestamp>") ? text.indexOf("</timestamp>") : -1;
    if (stampEnd < 0) return { kind: "unknown" };
    const stamp = text.slice("<timestamp>".length, stampEnd);
    const rest = text.slice(stampEnd + "</timestamp>".length).trimStart();
    if (rest.startsWith(queryOpen)) return { kind: "words", words: CursorStoreParser.query(rest), stamp };
    if (!rest.startsWith("<system_notification>")) return { kind: "unknown" };
    if (!rest.endsWith(queryClose)) return { kind: "skipped", type: "system_notification" };
    const notificationClose = "</system_notification>";
    for (let close = rest.indexOf(notificationClose); close >= 0; close = rest.indexOf(notificationClose, close + notificationClose.length)) {
      const after = rest.slice(close + notificationClose.length).trimStart();
      if (after.startsWith(queryOpen)) return { kind: "words", words: CursorStoreParser.query(after), stamp };
    }
    return { kind: "skipped", type: "system_notification" };
  }

  /** The user's words in a text that starts `<user_query>`: up to the final `</user_query>` when the text ends with one, else to the end. */
  static query(text: string): string {
    const body = text.slice(queryOpen.length);
    return body.endsWith(queryClose) ? body.slice(0, body.length - queryClose.length) : body;
  }

  /**
   * The user's local time as Cursor writes it, `Tuesday, Nov 4, 2026, 8:43 AM (UTC+5:30)` (the weekday
   * and month may be written out; the offset `+N`, `+N:MM` or `+N.5`, or none): seconds since 1970.
   */
  static time(value: string): number | null {
    const match = timePattern.exec(value);
    if (match === null) return null;
    const month = months.indexOf((match[1] ?? "").toLowerCase().slice(0, 3));
    const day = Number(match[2]);
    const year = Number(match[3]);
    let hour = Number(match[4]);
    const minute = Number(match[5]);
    const meridiem = (match[6] ?? "").toLowerCase();
    if (month < 0 || hour < 1 || hour > 12 || minute > 59) return null;
    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;
    let offset = 0;
    if (match[7] !== undefined && match[8] !== undefined) {
      let minutes = 0;
      const part = match[10];
      if (part !== undefined) minutes = match[9] === "." ? Math.trunc(Number(`0.${part}`) * 60) : Number(part);
      offset = (Number(match[8]) * 3_600 + minutes * 60) * (match[7] === "-" ? -1 : 1);
    }
    return Date.UTC(year, month, day, hour, minute) / 1_000 - offset;
  }

  // MARK: the agent

  private assistant(content: unknown): TranscriptLineResult {
    if (!Array.isArray(content)) {
      if (typeof content === "string" && !blank(content)) {
        return LineResult.events([
          { type: "agentText", text: { id: this.nextID("text"), markdown: content, time: null } },
          { type: "agentStopped", time: null },
        ]);
      }
      return LineResult.skipped("assistant");
    }
    const events: TranscriptEvent[] = [];
    let calls = false;
    for (const part of content.filter(isObject)) {
      switch (part.type) {
        case "reasoning": {
          const text = asString(part.text) ?? "";
          if (!blank(text)) events.push({ type: "agentProgress", text: { id: this.nextID("thought"), markdown: text, time: null } });
          break;
        }
        case "text": {
          const text = asString(part.text) ?? "";
          if (!blank(text)) events.push({ type: "agentText", text: { id: this.nextID("text"), markdown: text, time: null } });
          break;
        }
        case "tool-call": {
          const id = asString(part.toolCallId);
          if (id === null || id.length === 0) break;
          calls = true;
          const args = asObject(part.args) ?? asObject(part.input) ?? {};
          events.push({ type: "toolStarted", call: CursorStoreParser.call(id, asString(part.toolName) ?? "tool", args) });
          break;
        }
        default:
          break;
      }
    }
    // Cursor's loop goes on only while it calls tools: a message with none ends the turn.
    if (!calls) events.push({ type: "agentStopped", time: null });
    const shows = events.some((event) => event.type !== "agentStopped");
    return shows ? LineResult.events(events) : { events, outcome: { kind: "skipped", type: "assistant" } };
  }

  /** What a call is, from Cursor's tool name and its arguments. */
  static call(id: string, name: string, args: JSONObject): ChatToolCall {
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = asString(args[key]);
        if (value !== null && value.length > 0) return value;
      }
      return null;
    };
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall =>
      toolCall(id, kind, name, target, { detail });
    switch (name) {
      case "Read":
        return make("read", string("path", "target_file", "file_path") ?? "");
      case "Shell": {
        const command = string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, null);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "Grep": {
        const pattern = string("pattern") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "Glob": {
        const pattern = string("glob_pattern", "pattern") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "StrReplace": {
        const path = string("path", "file_path") ?? "";
        const old = asString(args.old_string);
        const replacement = asString(args.new_string);
        if (old === null || replacement === null) return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
      }
      case "Write": {
        const path = string("path", "file_path") ?? "";
        const contents = asString(args.contents) ?? asString(args.content);
        if (contents === null) return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.written(contents, path) });
      }
      case "GetDynamicTools":
      case "CallDynamicTool":
        return make({ other: name }, [string("namespace"), string("toolName")].filter((part) => part !== null).join("/"));
      default: {
        let target = "";
        for (const key of ["path", "target_directory", "command", "pattern", "query", "url", "description"]) {
          const value = asString(args[key]);
          if (value !== null && value.length > 0) {
            target = firstLine(value);
            break;
          }
        }
        return make({ other: otherToolName(name) }, target);
      }
    }
  }

  // MARK: tool results

  private tool(object: JSONObject): TranscriptLineResult {
    const list = asArray(object.content);
    if (list === null) return LineResult.skipped("tool");
    const parts = list.filter(isObject);
    const cursor = asObject(asObject(object.providerOptions)?.cursor);
    const high = asObject(cursor?.highLevelToolCallResult);
    const failed = ChatJSON.bool(high?.isError);
    const success = asObject(asObject(high?.output)?.success);
    const exitCode = ChatJSON.int(success?.exitCode);
    const events: TranscriptEvent[] = [];
    for (const part of parts) {
      if (part.type !== "tool-result") continue;
      const id = asString(part.toolCallId);
      if (id === null || id.length === 0) continue;
      let text = asString(part.result) ?? "";
      if (text.length === 0) text = ChatJSON.text(part.experimental_content);
      events.push({ type: "toolFinished", id, output: toolOutput(text, { isError: failed, exitCode }), time: null });
    }
    return LineResult.of(events, "tool");
  }

  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `cursor-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `cursor-${prefix}-${this.serial}`;
  }
}
