// What Gemini CLI and Qwen Code share (Qwen Code is built on Gemini CLI): a message's
// `Content.parts` (@google/genai: `text`, `thought`, `inlineData`, `functionCall`, `functionResponse`) and
// the names both give their built-in tools, mapped to Chat's tool rows.
//
// Sources (read-only clones):
// - gemini-cli 62bab5b packages/core/src/tools/definitions/base-declarations.ts:30-138 (tool and parameter
//   names: read_file, write_file, replace, run_shell_command, grep_search, glob, list_directory,
//   google_web_search, web_fetch, read_many_files, write_todos), tools/tool-names.ts:191 (invoke_agent);
// - qwen-code d32faa2 packages/core/src/tools/tool-names.ts:21-74 (exec, edit, write_file, read_file,
//   grep_search, glob, run_shell_command, todo_write, agent, web_fetch, web_search, list_directory) and
//   :191-194 (legacy aliases search_file_content, replace, task);
// - gemini-cli packages/core/src/services/chatRecordingTypes.ts:54-67 (ToolCallRecord: id, name, args,
//   result, status, resultDisplay) and scheduler/types.ts:26-33 (statuses success, error, cancelled).

import { firstLine, otherToolName, planStatus } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { minimumLineLength, minimumPayloadLength } from "../line-scan";
import { attachment, searchDetail, toolCall, toolOutput, type ChatAttachment, type ChatToolCall, type ChatToolKind, type ChatToolOutput } from "../model";
import { asObject, asString, ChatDiffMaker, isObject, objects, type JSONObject } from "../tools";

/** A `functionCall` part. */
export interface GeminiFunctionCall {
  readonly id: string | null;
  readonly name: string;
  readonly args: JSONObject;
}

/** What a message's parts hold, as Chat reads them. */
export interface GeminiParts {
  /** The text parts that are not thoughts, joined as Gemini CLI joins them (partListUnionToString: no separator). */
  readonly text: string;
  /** Inline pictures (`inlineData` with an `image/…` type): their media type only, never their bytes. */
  readonly images: readonly ChatAttachment[];
  readonly calls: readonly GeminiFunctionCall[];
  /** `functionResponse` parts (a tool's result sent back to the model). */
  readonly responses: number;
}

/** A `PartListUnion` (a string, one part, or a list of strings and parts) read as parts. */
export function geminiParts(content: unknown): GeminiParts {
  const list = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];
  let text = "";
  const images: ChatAttachment[] = [];
  const calls: GeminiFunctionCall[] = [];
  let responses = 0;
  for (const part of list) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (!isObject(part)) continue;
    if (typeof part.text === "string") {
      if (part.thought !== true) text += part.text;
      continue;
    }
    const inline = asObject(part.inlineData);
    if (inline !== null) {
      const type = asString(inline.mimeType);
      if (type === null || type.startsWith("image/")) images.push(attachment(null, type));
      continue;
    }
    const call = asObject(part.functionCall);
    if (call !== null) {
      const name = asString(call.name);
      if (name !== null) calls.push({ id: asString(call.id), name, args: asObject(call.args) ?? {} });
      continue;
    }
    if (isObject(part.functionResponse)) responses += 1;
  }
  return { text, images, calls, responses };
}

/** Legacy names both agents still accept (qwen-code tool-names.ts:191-194). */
const aliases: Readonly<Record<string, string>> = { search_file_content: "grep_search", task: "agent" };

const stringArg = (args: JSONObject, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = asString(args[key]);
    if (value !== null && value.length > 0) return value;
  }
  return null;
};

/** A built-in tool's row (kind, target, detail) from its name and arguments; any other tool's by its own name. */
export function geminiToolCall(id: string, name: string, args: JSONObject, time: number | null): ChatToolCall {
  const tool = aliases[name] ?? name;
  const path = stringArg(args, "file_path", "absolute_path", "path", "dir_path", "directory") ?? "";
  const make = (kind: ChatToolKind, target: string, detail: ChatToolCall["detail"] = { type: "none" }): ChatToolCall =>
    toolCall(id, kind, name, target, { detail, time });
  switch (tool) {
    case "read_file":
    case "list_directory":
      return make("read", path);
    case "read_many_files": {
      const include = Array.isArray(args.include) ? args.include : Array.isArray(args.paths) ? args.paths : [];
      return make("read", include.filter((value): value is string => typeof value === "string").join(", "));
    }
    case "write_file": {
      const content = asString(args.content);
      return content === null ? make("edit", path) : make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
    }
    case "replace":
    case "edit": {
      const old = asString(args.old_string);
      const replacement = asString(args.new_string);
      if (old === null || replacement === null) return make("edit", path);
      const diff = old.length === 0 ? ChatDiffMaker.written(replacement, path) : ChatDiffMaker.replacement(old, replacement, path);
      return make("edit", path, { type: "diff", diff });
    }
    case "run_shell_command":
    case "exec": {
      const command = stringArg(args, "command", "cmd");
      return command === null ? make("bash", "") : CodexRolloutParser.commandCall(id, name, command, time);
    }
    case "grep_search":
    case "glob": {
      const pattern = stringArg(args, "pattern", "query") ?? "";
      return make("search", pattern, { type: "search", search: searchDetail(pattern) });
    }
    case "google_web_search":
    case "web_search":
      return make("web", stringArg(args, "query") ?? "");
    case "web_fetch":
      return make("web", firstLine(stringArg(args, "url", "prompt") ?? ""));
    case "write_todos":
    case "todo_write": {
      const steps = (objects(args.todos) ?? []).map((todo) => ({
        text: asString(todo.description) ?? asString(todo.content) ?? "",
        status: planStatus(todo.status),
      }));
      return make("plan", steps.find((step) => step.status === "inProgress")?.text ?? "", { type: "plan", steps });
    }
    case "agent":
    case "invoke_agent":
      return make("agent", firstLine(stringArg(args, "description", "prompt", "agent_name", "subagent_type") ?? ""));
    default: {
      const target = stringArg(args, "description", "file_path", "path", "query", "url", "command", "pattern") ?? "";
      return make({ other: otherToolName(name) }, firstLine(target));
    }
  }
}

/**
 * A finished call's result: its `resultDisplay` when that is text (what the agent showed), else the text of
 * its `functionResponse` (`response.output`, else `response.error`); a FileDiff or other structured display
 * gives none (an edit's row shows its diff from the call).
 */
export function geminiToolOutput(resultDisplay: unknown, result: unknown, failed: boolean): ChatToolOutput {
  const shown = asString(resultDisplay);
  if (shown !== null) return toolOutput(shown, { isError: failed });
  const parts = Array.isArray(result) ? result : result === undefined || result === null ? [] : [result];
  for (const part of parts) {
    const response = asObject(asObject(asObject(part)?.functionResponse)?.response);
    if (response === null) continue;
    const text = asString(response.output) ?? asString(response.error) ?? asString(response.content);
    if (text !== null) return toolOutput(text, { isError: failed });
  }
  return toolOutput("", { isError: failed });
}

/**
 * A picture the user sent (or a tool read) is a part `{"inlineData":{"mimeType":"image/…","data":<base64>}}`, a line of
 * up to megabytes; the timeline needs its media type, never its bytes: each `data` string of at least
 * `minimumPayloadLength` characters with no escape or space in it is cut to "" before the parse. Null when none is.
 */
export function geminiSlimmed(line: string): string | null {
  if (line.length < minimumLineLength || !line.includes('"inlineData"')) return null;
  let text = line;
  let cut = false;
  let from = 0;
  for (;;) {
    const key = text.indexOf('"data":"', from);
    if (key < 0) break;
    const start = key + '"data":"'.length;
    const end = text.indexOf('"', start);
    if (end < 0) break;
    const payload = text.slice(start, end);
    if (payload.length >= minimumPayloadLength && !payload.includes("\\") && !payload.includes(" ")) {
      text = text.slice(0, start) + text.slice(end);
      cut = true;
      from = start + 1;
    } else {
      from = end + 1;
    }
  }
  return cut ? text : null;
}
