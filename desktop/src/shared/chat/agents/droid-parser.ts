// Reads a Factory Droid CLI session (`~/.factory/sessions/<folder name>/<id>.jsonl`,
// droid-locate.ts). Its first line is `{"type":"session_start", "title", "cwd", "owner"}` and each later
// one a `{"type":"message"}` (Factory-AI/droid-sdk-python aa6fd94 src/droid_sdk/_high_level/discovery.py:132-148,
// tests/test_v5_discovery.py:25-35) holding a FactoryDroidMessage, `message` as Droid's `create_message`
// notification carries it (src/droid_sdk/schemas/cli.py:306-321; the line itself when it has the message's
// `role` and `content`): `{id, role, content: [blocks], createdAt, visibility?, isError?, hook…}` with
// Anthropic-style blocks `text`, `image` (`source: {type: "base64", data, mediaType}`), `thinking`,
// `redacted_thinking`, `tool_use` (`id`, `name`, `input`), `tool_result` (`toolUseId`, `content`, `isError`)
// and `document` (src/droid_sdk/schemas/messages.py:89-349, ported from Droid's own
// packages/common/src/sessionV2/messages/schemas.ts).
//
// Shown: the user's messages (`user` text, the user's pictures and documents as attachments; text that is one XML-like
// element, the context Droid adds, is not the user's typing), Droid's reply (`assistant` `text`, markdown), its
// thinking (`thinking`, the thinking row), tool calls (`tool_use`) folded with their results (`tool_result`,
// in a `user` or `tool` message, paired by id), mapped to the nearest row kind by Droid's tool names
// (Execute, Read, Edit, MultiEdit, Create, ApplyPatch, Grep, Glob, LS, FetchUrl, WebSearch, TodoWrite, Task:
// Factory-AI/factory 892925c docs/reference/hooks-reference.mdx:200-210, :305-330, :640-647, :736-737).
// An `assistant` message with no tool call ends the turn; one marked `isError` is its words all the same.
//
// Skipped: `system` messages, messages not for the user's eyes (`visibility: "llm_only"`, `isUserVisible: false`,
// `hiddenFromUserViews`), hook messages (`hookEventName`), and any other line type Droid writes. A line
// that is not JSON, has no type, or a `message` with no readable role and content is unknown (the
// unrecognised-format note, never a wrong chat).

import { claudeToolCall, firstLine, LineResult, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { attachment, bashDetail, toolCall, toolOutput, userMessage, type ChatAttachment, type ChatToolCall, type TranscriptEvent } from "../model";
import { asArray, asObject, asString, ChatJSON, isObject, parseChatDate, ShellCommandClassifier, type JSONObject } from "../tools";

const blank = (text: string): boolean => text.trim().length === 0;

/** Droid's tool names that are Claude Code's under another name (the same inputs: `file_path`, `content`, `url`). */
const claudeNames: Readonly<Record<string, string>> = { Create: "Write", FetchUrl: "WebFetch" };

export class DroidSessionParser {
  private offset: number | null = null;
  private idsInLine = 0;
  private serial = 0;
  /** The session's working folder: its first line's `cwd`. */
  cwd: string | null = null;

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  get lineOffset(): number | null {
    return this.offset;
  }

  clone(): DroidSessionParser {
    const copy = new DroidSessionParser();
    copy.serial = this.serial;
    copy.cwd = this.cwd;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const type = asString(object.type);
    if (type === null || type.length === 0) return LineResult.unknown("(no type)");
    switch (type) {
      case "session_start": {
        const folder = asString(object.cwd);
        if (this.cwd === null && folder !== null && folder.startsWith("/")) this.cwd = folder;
        return LineResult.skipped(type);
      }
      case "message": {
        const inner = asObject(object.message);
        const message = inner ?? (asString(object.role) !== null ? object : null);
        if (message === null || asString(message.role) === null || !Array.isArray(message.content)) return LineResult.unknown("message");
        const time = parseChatDate(object.timestamp) ?? DroidSessionParser.time(message.createdAt);
        const id = asString(message.id) ?? (inner === null ? null : asString(object.id));
        return this.message(message, id, time);
      }
      default:
        // Droid's other bookkeeping lines (whatever they are named) show nothing.
        return LineResult.skipped(type);
    }
  }

  /** `createdAt`: milliseconds since 1970 (a number this large), else seconds; null when not a number. */
  static time(value: unknown): number | null {
    const number = ChatJSON.double(value);
    if (number === null || number <= 0) return null;
    return number > 100_000_000_000 ? number / 1_000 : number;
  }

  private message(message: JSONObject, ownID: string | null, time: number | null): TranscriptLineResult {
    const role = asString(message.role)!;
    if (asString(message.visibility) === "llm_only" || message.isUserVisible === false || message.hiddenFromUserViews === true) return LineResult.skipped(`message/${role}/hidden`);
    if (asString(message.hookEventName) !== null) return LineResult.skipped(`message/${role}/hook`);
    const blocks = (message.content as unknown[]).filter(isObject);
    const id = ownID ?? this.nextID(role);
    switch (role) {
      case "user":
        return this.user(blocks, id, time);
      case "assistant":
        return this.assistant(blocks, id, time);
      case "tool":
        return LineResult.of(DroidSessionParser.results(blocks, time), "message/tool");
      case "system":
        return LineResult.skipped("message/system");
      default:
        return LineResult.unknown("message/" + role);
    }
  }

  // MARK: the user's messages

  private user(blocks: readonly JSONObject[], id: string, time: number | null): TranscriptLineResult {
    const texts: string[] = [];
    const attachments: ChatAttachment[] = [];
    for (const block of blocks) {
      switch (asString(block.type)) {
        case "text": {
          const text = asString(block.text);
          if (text !== null && !blank(text) && !CodexRolloutParser.isContext(text)) texts.push(text);
          break;
        }
        case "image": {
          const source = asObject(block.source);
          const media = asString(source?.mediaType) ?? asString(source?.media_type);
          attachments.push(attachment(null, media === null || media.length === 0 ? null : media));
          break;
        }
        case "document": {
          const source = asObject(block.source);
          attachments.push(attachment(asString(source?.path), asString(source?.mediaType) ?? asString(source?.media_type)));
          break;
        }
        default:
          break;
      }
    }
    const events: TranscriptEvent[] = DroidSessionParser.results(blocks, time);
    const text = texts.join("\n\n").trim();
    if (text.length > 0 || attachments.length > 0) events.push({ type: "userMessage", message: userMessage("droid-user-" + id, text, time, attachments) });
    return LineResult.of(events, "message/user-context");
  }

  // MARK: the agent

  private assistant(blocks: readonly JSONObject[], id: string, time: number | null): TranscriptLineResult {
    const events: TranscriptEvent[] = [];
    let calls = false;
    let part = 0;
    const partID = (kind: string): string => {
      part += 1;
      return `droid-${kind}-${id}` + (part > 1 ? `-${part}` : "");
    };
    for (const block of blocks) {
      switch (asString(block.type)) {
        case "text": {
          const text = asString(block.text) ?? "";
          if (!blank(text)) events.push({ type: "agentText", text: { id: partID("text"), markdown: text, time } });
          break;
        }
        case "thinking": {
          const text = asString(block.thinking) ?? "";
          if (!blank(text)) events.push({ type: "agentProgress", text: { id: partID("thought"), markdown: text, time } });
          break;
        }
        case "tool_use": {
          const callID = asString(block.id);
          if (callID === null || callID.length === 0) break;
          calls = true;
          events.push({ type: "toolStarted", call: DroidSessionParser.call(callID, asString(block.name) ?? "", asObject(block.input) ?? {}, time) });
          break;
        }
        default:
          break;
      }
    }
    events.push(...DroidSessionParser.results(blocks, time));
    // Droid's loop goes on only while it calls tools: a message with none ends the turn.
    if (!calls) events.push({ type: "agentStopped", time });
    return events.some((event) => event.type !== "agentStopped") ? LineResult.events(events) : { events, outcome: { kind: "skipped", type: "message/assistant" } };
  }

  // MARK: tools

  /** What a call is, from Droid's tool name and its input (Claude Code's rows where the tools are alike). */
  static call(id: string, name: string, input: JSONObject, time: number | null): ChatToolCall {
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = asString(input[key]);
        if (value !== null && value.length > 0) return value;
      }
      return null;
    };
    switch (name) {
      case "Execute": {
        const command = string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "ApplyPatch": {
        const patch = string("patch", "input", "content") ?? "";
        const edit = ShellCommandClassifier.editFromPatch(patch);
        return edit === null ? toolCall(id, "edit", name, "", { time }) : toolCall(id, edit.kind, name, edit.target, { detail: edit.detail, time });
      }
      case "LS":
        return toolCall(id, "read", name, string("directory_path", "path", "file_path") ?? "", { time });
      default:
        break;
    }
    // Edit's strings by either name Droid's tools may give them.
    const normal: JSONObject = { ...input };
    if (normal.old_string === undefined && typeof input.old_str === "string") normal.old_string = input.old_str;
    if (normal.new_string === undefined && typeof input.new_str === "string") normal.new_string = input.new_str;
    if (normal.file_path === undefined && typeof input.path === "string") normal.file_path = input.path;
    const made = claudeToolCall(id, claudeNames[name] ?? name, normal, time);
    // A Task is a plain agent row here (no subagents row: Droid's subagent runs are not in this file).
    const { subagent: _subagent, task: _task, bashDescription: _description, ...plain } = made;
    return { ...plain, toolName: name, target: plain.target.length > 0 ? plain.target : firstLine(string("description", "prompt") ?? "") };
  }

  /** `tool_result` blocks: each finishes its call (`isError` a failure). */
  static results(blocks: readonly JSONObject[], time: number | null): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    for (const block of blocks) {
      if (asString(block.type) !== "tool_result") continue;
      const id = asString(block.toolUseId) ?? asString(block.tool_use_id);
      if (id === null || id.length === 0) continue;
      const failed = ChatJSON.bool(block.isError) || ChatJSON.bool(block.is_error);
      events.push({ type: "toolFinished", id, output: toolOutput(DroidSessionParser.resultText(block.content), { isError: failed }), time });
    }
    return events;
  }

  /** A result's text: a string, or its text blocks joined (pictures and documents are not text). */
  static resultText(value: unknown): string {
    if (typeof value === "string") return value;
    const parts = (asArray(value) ?? []).filter(isObject).flatMap((part) => (asString(part.type) === "text" ? [asString(part.text) ?? ""] : []));
    return parts.join("\n");
  }

  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `${prefix}-${this.serial}`;
  }
}
