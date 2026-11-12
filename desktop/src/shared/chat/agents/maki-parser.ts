// Reads a Maki session log, `<state>/maki/sessions/<id>.jsonl` (Maki at tontinton/maki
// ac17ffe, log format 3; agents/maki-session.ts finds it). One record per line, tagged by `t`
// (maki-storage/src/sessions.rs:755-787 LogRecord):
// - `header` {v, id, model, cwd, created_at}: the first line; its `cwd` is the session's folder. A
//   format other than 2 or 3 is refused whole, as Maki refuses it (sessions.rs:1273-1284): that line and
//   every later one count as unknown, so Chat says the format is not one it reads.
// - `msg` {d: Message}: a message, flat `{role, content, display_text?, kind?, …}`
//   (maki-providers/src/types.rs:505-627), content blocks tagged by `type` (types.rs:291-336): `text`,
//   `thinking`, `redacted_thinking`, `tool_use` {id, name, input}, `tool_result` {tool_use_id, content,
//   is_error}, `image` {source: {type: "base64", media_type, data}} (types.rs:110-131).
// - `meta` {title, …}: rewritten after every append (the last one wins); its title is the chat's.
// - `out`, `sub_msg`, `frame`: a tool's display output, a subagent's messages, the prompt prefix: skipped.
//
// Shown: the user's message (a `user` message of kind turn: its `display_text` when set, else its text blocks;
// its images); Maki's reply (`assistant` `text` blocks, markdown); tool calls (`tool_use`, Maki's tool
// names mapped to the nearest kind: read, write and edit, multiedit, bash, glob and grep, webfetch,
// websearch, todo_write, task; any other a plain row) finished by their `tool_result` (a bash result's
// trailing `Exit code: N` its exit code); a cancelled turn (Maki's synthetic `[Cancelled by user]`
// marker) as interrupted. An assistant message with no tool call ends the turn: Maki's loop goes on only
// while the model calls tools. Skipped and counted: thinking, synthetic messages (`display_text: ""`),
// observations and context updates (`kind`, hidden from Maki's own views, types.rs:410-440), and the
// records above. Maki's messages carry no time, so no row has one.

import { claudeToolCall, firstLine, LineResult, type TranscriptLineResult } from "../claude-parser";
import { blobParts, type ChatLineBlobs } from "../blobs";
import { attachment, toolCall, toolOutput, userMessage, type ChatAttachment, type ChatToolCall, type TranscriptEvent } from "../model";
import { asArray, asObject, asString, ChatJSON, isObject, type JSONObject } from "../tools";
import { makiLogVersions } from "./maki-session";

/** The markers Maki writes as a synthetic user message when a turn is cut short (maki-agent/src/agent/history.rs:19-20). */
const cancelMarkers = new Set(["[Cancelled by user]", "[Cancelled by your parent agent or a plugin, not the user]"]);

/** Maki's name for a session it has not titled yet (sessions.rs:50). */
const untitled = "New session";

/** Maki's own tool names (plugins/<tool>/init.lua) and the Claude Code tool each reads as, with its input's fields renamed. */
const claudeNames: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todo_write: "TodoWrite",
};

const blank = (text: string): boolean => text.trim().length === 0;

/** A bash result's trailing `Exit code: N` (plugins/bash/init.lua:597-606): the code, and the output before it. */
export function makiExitCode(text: string): { code: number | null; body: string } {
  const match = /(?:^|\n)Exit code: (\d+)$/.exec(text);
  if (match === null) return { code: null, body: text };
  return { code: Number(match[1]), body: text.slice(0, match.index) };
}

export class MakiSessionParser {
  private offset: number | null = null;
  private idsInLine = 0;
  private serial = 0;
  /** The session's folder: its header's `cwd` (or the owner check's, TranscriptParser.carryFolder). */
  cwd: string | null = null;
  /** A header of a format this reader does not know was read: every later line is unknown. */
  private foreign = false;
  /** The runs a relay read left out of the line being read (an image's base64). */
  lineBlobs: ChatLineBlobs | null = null;

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  get lineOffset(): number | null {
    return this.offset;
  }

  clone(): MakiSessionParser {
    const copy = new MakiSessionParser();
    copy.serial = this.serial;
    copy.cwd = this.cwd;
    copy.foreign = this.foreign;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const tag = asString(object.t);
    if (tag === null) return LineResult.unknown("(no t)");
    if (this.foreign) return LineResult.unknown(tag);
    switch (tag) {
      case "header": {
        const version = ChatJSON.int(object.v);
        if (version === null || !makiLogVersions.includes(version)) {
          this.foreign = true;
          return LineResult.unknown(`header v${version ?? "?"}`);
        }
        const folder = asString(object.cwd);
        if (this.cwd === null && folder !== null && folder.length > 0) this.cwd = folder;
        return LineResult.skipped("header");
      }
      case "msg": {
        const message = asObject(object.d);
        if (message === null) return LineResult.skipped("msg");
        const role = asString(message.role);
        if (role === "user") return this.user(message);
        if (role === "assistant") return this.assistant(message);
        return LineResult.unknown(`msg/${role ?? "?"}`);
      }
      case "meta": {
        const title = asString(object.title)?.trim() ?? "";
        if (title.length === 0 || title === untitled) return LineResult.skipped("meta");
        return LineResult.events([{ type: "title", value: title }]);
      }
      case "out":
      case "sub_msg":
      case "frame":
        return LineResult.skipped(tag);
      default:
        return LineResult.unknown(tag);
    }
  }

  // MARK: the user's messages, and the results Maki sends back as the user's

  private user(message: JSONObject): TranscriptLineResult {
    const blocks = (asArray(message.content) ?? []).filter(isObject);
    const events: TranscriptEvent[] = [];
    // Tool results first: they finish the calls of the turn they belong to.
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const id = asString(block.tool_use_id);
      if (id === null || id.length === 0) continue;
      const { code, body } = makiExitCode(ChatJSON.text(block.content));
      events.push({ type: "toolFinished", id, output: toolOutput(body, { isError: ChatJSON.bool(block.is_error), exitCode: code }), time: null });
    }
    // An observation or context update (a bare tag, or the older nested `{"context_update": …}`), and a
    // background notice (`settles`, `partial`): from the host, never the user's typing.
    const kind = message.kind;
    if (kind !== undefined && kind !== null && kind !== "turn") return LineResult.of(events, `msg/${asString(kind) ?? "kind"}`);
    if (message.settles !== undefined || message.partial !== undefined) return LineResult.of(events, "msg/notice");
    const texts = blocks.flatMap((block) => (block.type === "text" ? [asString(block.text) ?? ""] : []));
    const display = asString(message.display_text);
    if (display !== null && display.length === 0) {
      // Synthetic: sent to the model, hidden from the user (types.rs:1-4); a cancel marker ends the turn.
      if (texts.length === 1 && cancelMarkers.has(texts[0]!.trim())) {
        events.push({ type: "notice", notice: { id: this.nextID("stop"), kind: "interrupted", time: null }, endsTurn: true });
      }
      return LineResult.of(events, "msg/synthetic");
    }
    const pictures: ChatAttachment[] = blocks.filter((block) => block.type === "image").map((block) => this.image(asObject(block.source)));
    const text = (display ?? texts.join("\n")).trim();
    if (text.length > 0 || pictures.length > 0) {
      events.push({ type: "userMessage", message: userMessage(this.nextID("prompt"), text, null, pictures) });
    }
    return LineResult.of(events, "msg/user");
  }

  /** An image block's media type, and when a relay read left its base64 out, the parts to fetch on show. */
  private image(source: JSONObject | null): ChatAttachment {
    const mediaType = asString(source?.media_type);
    const blobs = this.lineBlobs;
    const data = blobs === null ? null : asString(source?.data);
    const parts = blobs === null || data === null ? null : blobParts(data, blobs.ranges);
    return parts === null || blobs === null ? attachment(null, mediaType) : attachment(null, mediaType, { path: blobs.path, ino: blobs.ino, parts });
  }

  // MARK: Maki

  private assistant(message: JSONObject): TranscriptLineResult {
    const blocks = (asArray(message.content) ?? []).filter(isObject);
    const events: TranscriptEvent[] = [];
    let calls = false;
    for (const block of blocks) {
      switch (block.type) {
        case "text": {
          const text = asString(block.text) ?? "";
          if (!blank(text)) events.push({ type: "agentText", text: { id: this.nextID("text"), markdown: text, time: null } });
          break;
        }
        case "tool_use": {
          const id = asString(block.id);
          if (id === null || id.length === 0) break;
          calls = true;
          events.push({ type: "toolStarted", call: MakiSessionParser.call(id, asString(block.name) ?? "tool", asObject(block.input) ?? {}) });
          break;
        }
        default:
          break;
      }
    }
    if (!calls) events.push({ type: "agentStopped", time: null });
    const shows = events.some((event) => event.type !== "agentStopped");
    return shows ? LineResult.events(events) : { events, outcome: { kind: "skipped", type: "msg/assistant" } };
  }

  /** A Maki tool call as a row: its tool read as the Claude Code tool it matches, under its own name. */
  static call(id: string, name: string, input: JSONObject): ChatToolCall {
    const path = asString(input.path) ?? asString(input.file_path);
    if (name === "task") {
      const prompt = asString(input.prompt) ?? "";
      const description = asString(input.description) ?? "";
      const detail = prompt.length > 0 ? ({ type: "text", text: Array.from(prompt).slice(0, 2_000).join("") } as const) : ({ type: "none" } as const);
      return toolCall(id, "agent", name, description.length > 0 ? firstLine(description) : firstLine(prompt), { detail });
    }
    if (name === "edit_lines") return toolCall(id, "edit", name, path ?? "");
    const claude = claudeNames[name];
    if (claude === undefined) return { ...claudeToolCall(id, name, input, null), toolName: name };
    const renamed: JSONObject = path === null ? input : { ...input, file_path: path };
    return { ...claudeToolCall(id, claude, renamed, null), toolName: name };
  }

  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `maki-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `maki-${prefix}-${this.serial}`;
  }
}
