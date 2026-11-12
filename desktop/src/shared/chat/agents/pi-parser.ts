// Reads a Pi session file (pi-mono's coding agent, `pi`) and an omp session file
// (oh-my-pi, `omp`, Pi's fork): one parser for both, as they write one format. Read from the agents'
// own source (cloned read-only, pi-mono ea1cfcc, oh-my-pi 21f1188):
//
// - A session is one append-only JSONL file (pi-mono packages/coding-agent/src/core/session-manager.ts:1173
//   `_persist`: `appendFileSync` of `JSON.stringify(entry) + "\n"`; oh-my-pi
//   packages/coding-agent/src/session/session-manager.ts:1954, the same lines through its writer).
// - Its first line is the header, `{"type":"session","version":3,"id","timestamp","cwd",…}`
//   (pi session-manager.ts:43-50 `SessionHeader`, :41 `CURRENT_SESSION_VERSION = 3`; omp
//   session-entries.ts:17, :42-79). omp writes a fixed-width title line before it
//   (`{"type":"title","v":1,"title",…,"pad"}`, session-entries.ts:28-35, session-title-slot.ts), rewritten
//   in place at the same length (session-storage.ts:1048 `updateSessionTitle`).
// - Every other line is an entry `{type, id, parentId, timestamp (ISO), …}` (pi :57-62, omp :89-105).
//   `message` entries carry an agent message by `role` (pi-ai packages/ai/src/types.ts:587-667; omp
//   modes/rpc/wire/rpc-wire.generated.ts:102-243):
//   - `user`: `content` a string or `[{type:"text",text} | {type:"image",data,mimeType}]` (omp adds
//     `synthetic`, a message the agent wrote itself, and `steering`, one sent while it worked);
//   - `assistant`: `content` `[{type:"text"} | {type:"thinking",thinking,redacted?} | {type:"toolCall",id,name,arguments}]`,
//     `stopReason` `stop | length | toolUse | error | aborted | pending | deferred` (types.ts:497) and
//     `errorMessage`;
//   - `toolResult`: `{toolCallId, toolName, content:[text|image], isError}`;
//   - `bashExecution` (the user's `!command`: `command, output, exitCode, cancelled`; pi core/messages.ts:29-40),
//     omp's `pythonExecution` (`code` for `command`);
//   - `system`, omp's `developer`, `custom`, `hookMessage` (an extension's), `branchSummary`,
//     `compactionSummary`, omp's `fileMention`: not the user's words nor the agent's reply.
//   `compaction` entries are the compaction row. The rest is state the timeline does not show (model and
//   thinking changes, usage, labels, names, context edits, extension data; omp's title changes, mode and
//   tier changes, credential pins, subagent init, reset boundaries).
// - Pi's built-in tools (pi core/tools/*.ts: `read {path}`, `bash {command}`, `edit {path, edits:[{oldText,
//   newText}]}`, `write {path, content}`, `grep {pattern}`, `find {pattern}`, `ls {path}`), omp's
//   (tools/builtin-names.ts: `read`, `bash`, `edit {path, old_string, new_string}` among its modes, `write`,
//   `grep`, `glob`, `find`, `task`, `todo`, `web_search`, …) map to the nearest row kind; any other name is
//   a plain row with its own name.
//
// The file is a tree (`parentId`): after Pi's /tree the lines of the branch left stay in the file. Chat
// shows the lines in file order (a card for the active branch only). A header of a version newer than 3
// makes every line after it unknown, so the feed shows "not in a format Chat reads", never a wrong chat.

import { firstLine, LineResult, otherToolName, planStatus, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import {
  attachment,
  bashDetail,
  searchDetail,
  toolCall,
  toolOutput,
  userMessage,
  type ChatAttachment,
  type ChatPlanStep,
  type ChatToolCall,
  type ChatToolDetail,
  type ChatToolKind,
  type TranscriptEvent,
} from "../model";
import { asArray, asObject, asString, ChatAttachmentText, ChatDiffMaker, ChatJSON, isObject, type JSONObject } from "../tools";

/** The session version this reader knows (pi session-manager.ts:41, omp session-entries.ts:17). */
export const piSessionVersion = 3;

/** Entry types that show nothing (pi session-manager.ts:183-194, omp session-entries.ts:385-401). */
const skippedTypes = new Set([
  "title",
  "thinking_level_change",
  "model_change",
  "usage",
  "branch_summary",
  "custom",
  "custom_message",
  "context_edit",
  "label",
  "session_info",
  "model_usage",
  "service_tier_change",
  "title_change",
  "ttsr_injection",
  "credential_pin",
  "session_init",
  "mode_change",
  "reset_boundary",
]);

/** Message roles that are neither the user's words nor the agent's reply. */
const skippedRoles = new Set(["system", "developer", "custom", "hookMessage", "branchSummary", "fileMention"]);

/** Pi's `/skill:name args`, as its prompt expands it (pi core/agent-session.ts:192, :2312). */
const skillBlock = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** The words pi's bash tool ends a failed command's output with (pi core/tools/bash.ts:436). */
const exitLine = /Command exited with code (-?\d+)\s*$/;

const blank = (text: string): boolean => text.trim().length === 0;

export class PiSessionParser {
  private offset: number | null = null;
  private idsInLine = 0;
  private serial = 0;
  /** The session's working folder, from its header (`cwd`). */
  cwd: string | null = null;
  /** A header of a newer version was read: nothing after it is read. */
  private foreign = false;

  get lineOffset(): number | null {
    return this.offset;
  }

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  clone(): PiSessionParser {
    const copy = new PiSessionParser();
    copy.offset = this.offset;
    copy.idsInLine = this.idsInLine;
    copy.serial = this.serial;
    copy.cwd = this.cwd;
    copy.foreign = this.foreign;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    // A picture is `{"type":"image","data":<base64>,"mimeType"}`, Grok's block shape: TranscriptParser cuts its bytes first.
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const type = asString(object.type);
    if (type === null) return LineResult.unknown("(no type)");
    if (type === "session") return this.header(object);
    if (this.foreign) return LineResult.unknown(`${type} (newer session)`);
    const time = PiSessionParser.time(object.timestamp);
    if (type === "message") return this.message(object, time);
    if (type === "compaction") return LineResult.events([{ type: "notice", notice: { id: this.nextID("compacted"), kind: "compacted", time }, endsTurn: false }]);
    if (skippedTypes.has(type)) return LineResult.skipped(type);
    return LineResult.unknown(type);
  }

  /** The header: its folder; a version newer than this reader's makes the rest unknown. */
  private header(object: JSONObject): TranscriptLineResult {
    const version = object.version === undefined ? 1 : ChatJSON.int(object.version);
    if (version === null || version > piSessionVersion) {
      this.foreign = true;
      return LineResult.unknown(`session v${String(object.version)}`);
    }
    const cwd = asString(object.cwd);
    if (cwd !== null && cwd.startsWith("/") && this.cwd === null) this.cwd = cwd;
    return LineResult.skipped("session");
  }

  private message(entry: JSONObject, entryTime: number | null): TranscriptLineResult {
    const message = asObject(entry.message);
    const role = asString(message?.role);
    if (message === null || role === null) return LineResult.unknown("message (no role)");
    const time = entryTime ?? PiSessionParser.time(message.timestamp);
    switch (role) {
      case "user":
        return this.user(message, time);
      case "assistant":
        return this.assistant(message, time);
      case "toolResult":
        return PiSessionParser.toolResult(message, time);
      case "bashExecution":
      case "pythonExecution":
        return this.shell(message, role === "pythonExecution", time);
      case "compactionSummary":
        return LineResult.events([{ type: "notice", notice: { id: this.nextID("compacted"), kind: "compacted", time }, endsTurn: false }]);
      default:
        return skippedRoles.has(role) ? LineResult.skipped(`message ${role}`) : LineResult.unknown(`message ${role}`);
    }
  }

  // MARK: the user's messages

  private user(message: JSONObject, time: number | null): TranscriptLineResult {
    // omp: a message the agent wrote itself (an automatic continue), never the user's.
    if (ChatJSON.bool(message.synthetic)) return LineResult.skipped("message user synthetic");
    let raw = "";
    const pictures: ChatAttachment[] = [];
    const content = message.content;
    if (typeof content === "string") {
      raw = content;
    } else if (Array.isArray(content)) {
      for (const part of content.filter(isObject)) {
        if (part.type === "text") raw += (raw.length === 0 ? "" : "\n") + (asString(part.text) ?? "");
        else if (part.type === "image") {
          const type = asString(part.mimeType);
          pictures.push(attachment(null, type === null || type.length === 0 ? null : type));
        }
      }
    } else {
      return LineResult.skipped("message user");
    }
    const extracted = ChatAttachmentText.extract(PiSessionParser.typed(raw));
    const text = extracted.text.trim();
    const attachments = [...pictures, ...extracted.attachments];
    if (text.length === 0 && attachments.length === 0) return LineResult.skipped("message user");
    const said = userMessage(this.nextID("prompt"), text, time, attachments);
    // omp: one sent while the agent worked goes inside the running turn.
    return LineResult.events([ChatJSON.bool(message.steering) ? { type: "userMessage", message: said, queued: true } : { type: "userMessage", message: said }]);
  }

  /** What the user typed: a skill Pi expanded is `/skill:<name>` and its words again. */
  static typed(text: string): string {
    const skill = skillBlock.exec(text);
    if (skill === null) return text;
    const args = skill[2]?.trim() ?? "";
    return `/skill:${skill[1]}` + (args.length === 0 ? "" : ` ${args}`);
  }

  // MARK: the agent

  private assistant(message: JSONObject, time: number | null): TranscriptLineResult {
    const events: TranscriptEvent[] = [];
    for (const part of (asArray(message.content) ?? []).filter(isObject)) {
      switch (part.type) {
        case "text": {
          const text = asString(part.text) ?? "";
          if (!blank(text)) events.push({ type: "agentText", text: { id: this.nextID("text"), markdown: text, time } });
          break;
        }
        case "thinking": {
          const text = asString(part.thinking) ?? "";
          if (!ChatJSON.bool(part.redacted) && !blank(text)) events.push({ type: "agentProgress", text: { id: this.nextID("thought"), markdown: text, time } });
          break;
        }
        case "toolCall": {
          const id = asString(part.id);
          if (id === null || id.length === 0) break;
          events.push({ type: "toolStarted", call: PiSessionParser.call(id, asString(part.name) ?? "tool", asObject(part.arguments) ?? {}, time) });
          break;
        }
        default:
          // redacted thinking, an image the model made, a provider's own blocks: nothing to show.
          break;
      }
    }
    switch (asString(message.stopReason)) {
      case "stop":
      case "length":
        events.push({ type: "agentStopped", time });
        break;
      case "aborted":
        events.push({ type: "notice", notice: { id: this.nextID("interrupted"), kind: "interrupted", time }, endsTurn: true });
        break;
      case "error": {
        const error = asString(message.errorMessage) ?? "";
        events.push({ type: "agentText", text: { id: this.nextID("error"), markdown: "Error: " + (blank(error) ? "the request failed" : firstLine(error)), time } });
        events.push({ type: "agentStopped", time });
        break;
      }
      default:
        // toolUse: the turn goes on with the calls' results; pending and deferred: not finished yet.
        break;
    }
    const shows = events.some((event) => event.type !== "agentStopped");
    return shows ? LineResult.events(events) : { events, outcome: { kind: "skipped", type: "message assistant" } };
  }

  /** What a call is, from its tool's name and arguments. */
  static call(id: string, name: string, args: JSONObject, time: number | null): ChatToolCall {
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = asString(args[key]);
        if (value !== null && value.length > 0) return value;
      }
      return null;
    };
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall => toolCall(id, kind, name, target, { detail, time });
    switch (name.toLowerCase()) {
      case "read":
        return make("read", string("path", "file_path") ?? "");
      case "bash":
      case "powershell": {
        const command = string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        return call.kind === "bash" && call.detail.type !== "bash" ? { ...call, detail: { type: "bash", bash: bashDetail(command) } } : call;
      }
      case "edit": {
        const path = string("path", "file_path") ?? "";
        const edits = (asArray(args.edits) ?? [])
          .filter(isObject)
          .map((edit) => ({ old: asString(edit.oldText), new: asString(edit.newText) }))
          .filter((edit): edit is { old: string; new: string } => edit.old !== null && edit.new !== null);
        if (edits.length > 1) return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacements(edits, path) });
        const old = edits[0]?.old ?? asString(args.oldText) ?? asString(args.old_string);
        const replacement = edits[0]?.new ?? asString(args.newText) ?? asString(args.new_string);
        if (old !== null && replacement !== null) return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
        // omp's patch, hashline and apply-patch modes: the row without its diff.
        return make("edit", path);
      }
      case "write": {
        const path = string("path", "file_path") ?? "";
        const content = asString(args.content);
        return content === null ? make("edit", path) : make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
      }
      case "grep":
      case "find":
      case "glob":
      case "ast_grep": {
        const pattern = string("pattern", "query", "path") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "web_search":
        return make("web", string("query", "q") ?? "");
      case "fetch":
      case "web_fetch":
        return make("web", string("url") ?? "");
      case "task": {
        const tasks = (asArray(args.tasks) ?? []).filter(isObject);
        const first = tasks[0] ?? args;
        const target = asString(first.name) ?? asString(first.description) ?? asString(first.task) ?? "";
        return make("agent", firstLine(target));
      }
      case "todo":
      case "todo_write": {
        const steps: ChatPlanStep[] = (asArray(args.todos) ?? []).filter(isObject).map((todo) => ({ text: asString(todo.content) ?? "", status: planStatus(todo.status) }));
        return steps.length === 0 ? make({ other: name }, string("op", "task") ?? "") : make("plan", steps.find((step) => step.status === "inProgress")?.text ?? "", { type: "plan", steps });
      }
      default: {
        let target = "";
        for (const key of ["path", "command", "pattern", "query", "url", "description"]) {
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

  /** A call's result, by its call's id; a failed bash call's exit code from the words pi ends it with. */
  static toolResult(message: JSONObject, time: number | null): TranscriptLineResult {
    const id = asString(message.toolCallId);
    if (id === null || id.length === 0) return LineResult.skipped("message toolResult");
    const text = PiSessionParser.text(message.content);
    const isError = ChatJSON.bool(message.isError);
    const name = (asString(message.toolName) ?? "").toLowerCase();
    let exitCode: number | null = null;
    if (isError && name === "bash") {
      const match = exitLine.exec(text);
      if (match !== null) exitCode = Number(match[1]);
    }
    return LineResult.events([{ type: "toolFinished", id, output: toolOutput(text, { isError, exitCode }), time }]);
  }

  /** The user's `!command` (omp: `$code` too): a shell row with its output. */
  private shell(message: JSONObject, python: boolean, time: number | null): TranscriptLineResult {
    const source = (asString(python ? message.code : message.command) ?? "").trim();
    const type = python ? "message pythonExecution" : "message bashExecution";
    if (source.length === 0) return LineResult.skipped(type);
    const id = this.nextID("shell");
    const call = python
      ? toolCall(id, { other: "Python" }, "$", firstLine(source), { time, isUserShell: true })
      : toolCall(id, "bash", "!", source, { detail: { type: "bash", bash: bashDetail(source) }, time, isUserShell: true });
    const output = toolOutput(asString(message.output) ?? "", { exitCode: ChatJSON.int(message.exitCode), isError: ChatJSON.bool(message.cancelled) });
    return LineResult.events([
      { type: "userShell", call },
      { type: "toolFinished", id, output, time },
    ]);
  }

  // MARK: helpers

  /** A content's text: a string, or its text blocks joined. */
  static text(content: unknown): string {
    if (typeof content === "string") return content;
    return (asArray(content) ?? [])
      .filter(isObject)
      .flatMap((part) => (part.type === "text" ? [asString(part.text) ?? ""] : []))
      .join("\n");
  }

  /** An entry's ISO `timestamp`, or a message's Unix milliseconds, as seconds since 1970; null for none. */
  static time(value: unknown): number | null {
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return Number.isFinite(ms) && ms > 0 ? ms / 1_000 : null;
    }
    const ms = ChatJSON.double(value);
    return ms !== null && ms > 0 ? ms / 1_000 : null;
  }

  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `pi-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `pi-${prefix}-${this.serial}`;
  }
}
