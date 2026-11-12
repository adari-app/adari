// Reads a Cline session, one message per line as ClineStoreSource lays it out
// (agents/cline-store.ts: `{"cl":1,"i","cwd","d":{id, role, content, ts}}`).
//
// Messages are Anthropic-shaped (cline sdk/packages/core/docs/messages-contract-v1.md): `role` user or
// assistant, `content` always a list of blocks:
// - the user's message: `text` blocks (the runtime's `<user_input mode="…">` / `<user_command …>` wrappers and its
//   `<mode_notice>` elements are not the user's words, sdk/packages/shared/src/prompt/format.ts:134-193, and are
//   left out as Cline's own display does) and `image` blocks; `tool_result` blocks (`tool_use_id`, `content`,
//   `is_error`) are the results of the agent's calls;
// - the agent's: `thinking` its thinking, `text` its reply, `tool_use` (`id`, `name`, `input`) a tool row; a
//   message with no tool_use ends the turn.
// Cline's tool names (sdk/packages/core/src/extensions/tools/definitions.ts: read_files, search_codebase,
// run_commands, fetch_web_content, apply_patch, editor, skills, ask_question, submit_and_exit; spawn_agent and
// team_* for teams) map to the nearest row kind. A block type the contract does not have, a document that is
// not version 1 or not JSON, and one too large to read (the view's line for it) are unknown or malformed
// (the feed's unrecognised-format note); the view's placeholders are skipped and counted.

import { firstLine, LineResult, otherToolName, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { attachment, bashDetail, searchDetail, toolCall, toolOutput, userMessage, type ChatAttachment, type ChatToolCall, type ChatToolDetail, type ChatToolKind, type TranscriptEvent } from "../model";
import { asArray, asObject, asString, ChatDiffMaker, ChatJSON, isObject, type JSONObject } from "../tools";

const blank = (text: string): boolean => text.trim().length === 0;

const seconds = (value: unknown): number | null => {
  const ms = ChatJSON.double(value);
  return ms === null || !Number.isFinite(ms) || ms <= 0 ? null : ms / 1_000;
};

/** `<tag>…</tag>` elements removed, content included (indexOf, as Cline's own removeTagElements). */
function withoutElements(input: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let result = input;
  let start = result.indexOf(open);
  while (start !== -1) {
    const end = result.indexOf(close, start + open.length);
    if (end === -1) break;
    result = result.slice(0, start) + result.slice(end + close.length);
    start = result.indexOf(open, start);
  }
  return result;
}

/** The user's words as Cline shows them: the runtime's wrappers and mode notices left out (format.ts:134-193). */
export function clineUserText(input: string): string {
  let text = withoutElements(input, "mode_notice");
  for (const tag of ["user_input", "user_command"]) text = text.replace(new RegExp(`</?${tag}(?:\\s[^>]*)?>`, "g"), "");
  return text.trim();
}

/** A tool result's `content` as text: a string, or its text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = asArray(content);
  if (blocks !== null) {
    return blocks
      .map((block) => (typeof block === "string" ? block : isObject(block) && block.type === "text" ? (asString(block.text) ?? "") : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content, null, 2) ?? "";
  } catch {
    return "";
  }
}

const knownBlocks = new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image", "document", "file"]);

export class ClineStoreParser {
  /** The session's folder, as each line's envelope gives it. */
  cwd: string | null = null;

  clone(): ClineStoreParser {
    const copy = new ClineStoreParser();
    copy.cwd = this.cwd;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    if (ChatJSON.int(object.cl) !== 1) return LineResult.unknown("cline line");
    const kind = asString(object.k);
    if (kind === "bad") {
      const why = asString(object.bad) ?? "row";
      if (why === "malformed") return LineResult.malformed();
      if (why === "tooLarge") return LineResult.unknown("cline too large");
      return LineResult.skipped(`cline ${why}`);
    }
    if (kind === "version") return LineResult.unknown(`cline version ${asString(object.v) ?? ""}`.trim());
    if (kind !== null) return LineResult.unknown(`cline ${kind}`);
    const cwd = asString(object.cwd);
    if (cwd !== null && cwd.length > 0) this.cwd = cwd;
    const message = asObject(object.d);
    if (message === null) return LineResult.malformed();
    const index = ChatJSON.int(object.i) ?? 0;
    const id = `cline-${asString(message.id) ?? String(index)}`;
    const time = seconds(message.ts);
    const blocks = asArray(message.content);
    if (blocks === null) return LineResult.unknown("cline content");
    const unknown = blocks.filter(isObject).map((block) => asString(block.type) ?? "").find((type) => !knownBlocks.has(type));
    if (unknown !== undefined) return LineResult.unknown(`block ${unknown.length === 0 ? "?" : unknown}`);
    switch (asString(message.role)) {
      case "user":
        return this.user(id, blocks.filter(isObject), time);
      case "assistant":
        return this.assistant(id, blocks.filter(isObject), time);
      default:
        return LineResult.unknown(asString(message.role) ?? "cline message");
    }
  }

  private user(id: string, blocks: JSONObject[], time: number | null): TranscriptLineResult {
    const events: TranscriptEvent[] = [];
    const text: string[] = [];
    const pictures: ChatAttachment[] = [];
    for (const block of blocks) {
      switch (asString(block.type)) {
        case "text": {
          const said = clineUserText(asString(block.text) ?? "");
          if (!blank(said)) text.push(said);
          break;
        }
        case "image": {
          const source = asObject(block.source);
          const mime = asString(source?.media_type) ?? asString(block.mediaType) ?? "image";
          pictures.push(attachment(null, mime.startsWith("image/") ? mime : "image"));
          break;
        }
        case "tool_result": {
          const callID = asString(block.tool_use_id);
          if (callID === null) break;
          const isError = ChatJSON.bool(block.is_error);
          events.push({ type: "toolFinished", id: ClineStoreParser.callID(callID), output: toolOutput(resultText(block.content), { isError }), time });
          break;
        }
        default:
          break;
      }
    }
    if (text.length > 0 || pictures.length > 0) events.push({ type: "userMessage", message: userMessage(id, text.join("\n\n"), time, pictures) });
    return LineResult.of(events, "user");
  }

  private assistant(id: string, blocks: JSONObject[], time: number | null): TranscriptLineResult {
    const events: TranscriptEvent[] = [];
    let calls = 0;
    blocks.forEach((block, index) => {
      switch (asString(block.type)) {
        case "thinking": {
          const said = asString(block.thinking) ?? "";
          if (!blank(said)) events.push({ type: "agentProgress", text: { id: `${id}-${index}`, markdown: said, time } });
          break;
        }
        case "text": {
          const said = asString(block.text) ?? "";
          if (!blank(said)) events.push({ type: "agentText", text: { id: `${id}-${index}`, markdown: said, time } });
          break;
        }
        case "tool_use": {
          calls += 1;
          const callID = ClineStoreParser.callID(asString(block.id) ?? `${id}-${index}`);
          events.push({ type: "toolStarted", call: ClineStoreParser.call(callID, asString(block.name) ?? "tool", asObject(block.input) ?? {}, time) });
          break;
        }
        default:
          break;
      }
    });
    if (calls === 0) events.push({ type: "agentStopped", time });
    return LineResult.of(events, "assistant");
  }

  static callID(id: string): string {
    return `cline-call-${id}`;
  }

  /** What a call is, from Cline's tool name and input (extensions/tools/schemas.ts). */
  static call(id: string, name: string, input: JSONObject, time: number | null): ChatToolCall {
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = asString(input[key]);
        if (value !== null && value.length > 0) return value;
      }
      return null;
    };
    const first = (key: string, ...fields: string[]): string | null => {
      const value = input[key];
      const list = asArray(value) ?? (value === undefined ? [] : [value]);
      for (const item of list) {
        if (typeof item === "string" && item.length > 0) return item;
        if (isObject(item)) {
          for (const field of fields) {
            const said = asString(item[field]);
            if (said !== null && said.length > 0) return said;
          }
        }
      }
      return null;
    };
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall => toolCall(id, kind, name, target, { detail, time });
    switch (name) {
      case "run_commands": {
        const command = first("commands", "command") ?? string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "read_files":
        return make("read", first("files", "path", "file_path", "filePath") ?? first("paths", "path") ?? first("file_paths") ?? "");
      case "editor": {
        const path = string("path") ?? "";
        const old = asString(input.old_text);
        const replacement = asString(input.new_text);
        if (old !== null && replacement !== null) return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
        if (replacement !== null && (input.insert_line === undefined || input.insert_line === null)) return make("edit", path, { type: "diff", diff: ChatDiffMaker.written(replacement, path) });
        return make("edit", path);
      }
      case "apply_patch": {
        const diff = ChatDiffMaker.patch(string("input", "patch") ?? (typeof input === "string" ? input : ""));
        return diff === null ? make("edit", "") : make("edit", diff.files[0] ?? "", { type: "diff", diff });
      }
      case "search_codebase": {
        const pattern = first("queries", "query") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "fetch_web_content":
        return make("web", first("requests", "url") ?? string("url") ?? "");
      case "spawn_agent":
      case "team_spawn_teammate":
      case "team_run_task": {
        const prompt = string("task", "prompt", "description", "message") ?? "";
        return make("agent", firstLine(prompt), prompt.length > 0 ? { type: "text", text: Array.from(prompt).slice(0, 2_000).join("") } : { type: "none" });
      }
      default: {
        const target = string("path", "command", "query", "url", "skill", "question", "task", "name");
        return make({ other: otherToolName(name) }, target === null ? "" : firstLine(target));
      }
    }
  }
}
