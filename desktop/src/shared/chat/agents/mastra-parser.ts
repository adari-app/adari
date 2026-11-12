// Reads a Mastra Code thread, one message part per line as MastraStoreSource lays it out
// (agents/mastra-store.ts: `{"ms":1,"k":"part","role","i","id","t","cwd","d":<the part>}`, then `k: "user"`
// after the user's message's parts and `k: "end"` after a settled reply).
//
// Parts are Mastra's stored message parts, AI SDK v4 UI parts (mastra packages/core/src/agent/
// message-list/state/types.ts:24-118):
// - the user's message: `text` parts and `file` parts with an image type (mastracode/tui/src/tui/mastra-tui.ts:515,
//   :526: a pasted image is a `file` part with `mimeType` or `mediaType`), shown whole at the `user` line;
// - the agent's: `text` its reply, `reasoning` its thinking (`reasoning`, or `details[].text`),
//   `tool-invocation` a tool row (`toolInvocation: {state, toolCallId, toolName, args, result, isError,
//   errorText}`, :62-82: `result` done, `output-error` failed, `output-denied` refused; one shown still `call`
//   did not finish), `error` the failure Mastra saved (`error: {name, message}`, :36-55);
// - `step-start`, `source`, `source-url`, `source-document` and `data-*` parts are bookkeeping, skipped.
// Mastra Code's tool names (mastracode/sdk/src/tool-names.ts: view, write_file, string_replace_lsp,
// find_files, search_content, execute_command, …; the workspace's own `mastra_workspace_*` names,
// packages/core/src/workspace/constants/index.ts) map to the nearest row kind. A part type neither has, or a
// message that is not format 2, is unknown (the feed's unrecognised-format note); the view's placeholders are
// skipped and counted.

import { firstLine, LineResult, otherToolName, planStatus, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { attachment, bashDetail, searchDetail, toolCall, toolOutput, userMessage, type ChatAttachment, type ChatToolCall, type ChatToolDetail, type ChatToolKind, type TranscriptEvent } from "../model";
import { asArray, asObject, asString, ChatDiffMaker, ChatJSON, isObject, type JSONObject } from "../tools";

const blank = (text: string): boolean => text.trim().length === 0;

const seconds = (value: unknown): number | null => {
  const ms = ChatJSON.double(value);
  return ms === null || !Number.isFinite(ms) || ms <= 0 ? null : ms / 1_000;
};

const skippedParts = new Set(["step-start", "source", "source-url", "source-document"]);

/** A tool's result as a row's text. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  const object = asObject(result);
  if (object !== null) {
    const said = asString(object.output) ?? asString(object.content) ?? asString(object.text) ?? asString(object.stdout);
    if (said !== null) return said;
  }
  try {
    return JSON.stringify(result, null, 2) ?? "";
  } catch {
    return "";
  }
}

export class MastraStoreParser {
  /** The thread's folder, as each line's envelope gives it. */
  cwd: string | null = null;
  /** The user's message whose parts are being read: its id, text and pictures. */
  private pending: { id: number; text: string[]; pictures: ChatAttachment[] } | null = null;

  clone(): MastraStoreParser {
    const copy = new MastraStoreParser();
    copy.cwd = this.cwd;
    copy.pending = this.pending === null ? null : { id: this.pending.id, text: [...this.pending.text], pictures: [...this.pending.pictures] };
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    if (ChatJSON.int(object.ms) !== 1) return LineResult.unknown("mastra line");
    const kind = asString(object.k) ?? "";
    if (kind === "bad") return LineResult.skipped(`mastra ${asString(object.bad) ?? "row"}`);
    if (kind === "unknown") return LineResult.unknown("mastra schema");
    if (kind === "version") return LineResult.unknown(`mastra format ${asString(object.v) ?? ""}`.trim());
    const cwd = asString(object.cwd);
    if (cwd !== null && cwd.length > 0) this.cwd = cwd;
    const id = ChatJSON.int(object.id) ?? 0;
    const time = seconds(object.t);
    switch (kind) {
      case "part": {
        const part = asObject(object.d);
        if (part === null) return LineResult.malformed();
        const index = ChatJSON.int(object.i) ?? 0;
        return asString(object.role) === "user" ? this.userPart(id, part) : this.agentPart(`mastra-${id}-${index}`, part, time);
      }
      case "user": {
        const pending = this.pending !== null && this.pending.id === id ? this.pending : null;
        this.pending = null;
        if (pending === null || (pending.text.length === 0 && pending.pictures.length === 0)) return LineResult.skipped("user");
        return LineResult.events([{ type: "userMessage", message: userMessage(`mastra-${id}`, pending.text.join("\n\n"), time, pending.pictures) }]);
      }
      case "end":
        return LineResult.events([{ type: "agentStopped", time }]);
      default:
        return LineResult.unknown(`mastra ${kind}`);
    }
  }

  private userPart(id: number, part: JSONObject): TranscriptLineResult {
    if (this.pending === null || this.pending.id !== id) this.pending = { id, text: [], pictures: [] };
    const type = asString(part.type) ?? "";
    if (type === "text") {
      const text = asString(part.text) ?? "";
      if (!blank(text)) this.pending.text.push(text);
      return LineResult.skipped("user part");
    }
    if (type === "file") {
      const mime = asString(part.mimeType) ?? asString(part.mediaType);
      if (mime !== null && mime.startsWith("image/")) this.pending.pictures.push(attachment(null, mime));
      return LineResult.skipped("user part");
    }
    return skippedParts.has(type) || type.startsWith("data-") ? LineResult.skipped(type) : LineResult.unknown(`part ${type}`);
  }

  private agentPart(id: string, part: JSONObject, time: number | null): TranscriptLineResult {
    const type = asString(part.type) ?? "";
    const at = seconds(part.createdAt) ?? time;
    switch (type) {
      case "text": {
        const text = asString(part.text) ?? "";
        return blank(text) ? LineResult.skipped("text") : LineResult.events([{ type: "agentText", text: { id, markdown: text, time: at } }]);
      }
      case "reasoning": {
        const details = (asArray(part.details) ?? [])
          .filter(isObject)
          .map((detail) => asString(detail.text) ?? "")
          .filter((text) => !blank(text));
        // Mastra writes `reasoning: ''` with the text in `details` (message-list/message-part-spans.ts:38-45,
        // adapters/AIV4Adapter.ts:561): the details when the string is blank.
        const own = asString(part.reasoning) ?? "";
        const text = blank(own) ? details.join("\n\n") : own;
        return blank(text) ? LineResult.skipped("reasoning") : LineResult.events([{ type: "agentProgress", text: { id, markdown: text, time: at } }]);
      }
      case "tool-invocation": {
        const invocation = asObject(part.toolInvocation) ?? {};
        const name = asString(invocation.toolName) ?? "tool";
        const callID = `mastra-call-${asString(invocation.toolCallId) ?? id}`;
        const call = MastraStoreParser.call(callID, name, asObject(invocation.args) ?? {}, at);
        const state = asString(invocation.state) ?? "";
        const errorText = asString(invocation.errorText);
        const output =
          state === "result"
            ? ChatJSON.bool(invocation.isError)
              ? toolOutput(errorText ?? resultText(invocation.result), { isError: true })
              : toolOutput(resultText(invocation.result))
            : state === "output-error"
              ? toolOutput(errorText ?? "Failed", { isError: true })
              : state === "output-denied"
                ? toolOutput("Denied", { isError: true })
                : toolOutput("Did not finish", { isError: true });
        const finished = seconds(part.updatedAt) ?? at;
        const events: TranscriptEvent[] = [
          { type: "toolStarted", call },
          { type: "toolFinished", id: callID, output, time: finished },
        ];
        return LineResult.events(events);
      }
      case "error": {
        const error = asObject(part.error) ?? {};
        const said = asString(error.message) ?? asString(error.name) ?? "Error";
        return LineResult.events([{ type: "agentText", text: { id, markdown: `Error: ${said}`, time: at } }]);
      }
      case "file":
        // A picture a tool or the model made: no row of its own in Chat.
        return LineResult.skipped("file");
      default:
        return skippedParts.has(type) || type.startsWith("data-") ? LineResult.skipped(type) : LineResult.unknown(`part ${type.length === 0 ? "?" : type}`);
    }
  }

  /** What a call is, from Mastra Code's tool name and its args. */
  static call(id: string, name: string, input: JSONObject, time: number | null): ChatToolCall {
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = asString(input[key]);
        if (value !== null && value.length > 0) return value;
      }
      return null;
    };
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall => toolCall(id, kind, name, target, { detail, time });
    const bare = name.startsWith("mastra_workspace_") ? name.slice("mastra_workspace_".length) : name;
    switch (bare) {
      case "execute_command": {
        const command = string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "view":
      case "read_file":
        return make("read", string("path") ?? "");
      case "write_file": {
        const path = string("path") ?? "";
        const content = asString(input.content);
        return content === null ? make("edit", path) : make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
      }
      case "string_replace_lsp":
      case "edit_file": {
        const path = string("path") ?? "";
        const old = asString(input.old_string);
        const replacement = asString(input.new_string);
        if (old === null || replacement === null) return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
      }
      case "ast_smart_edit":
      case "ast_edit":
      case "delete_file":
      case "delete":
        return make("edit", string("path") ?? "");
      case "apply_patch": {
        const diff = ChatDiffMaker.patch(string("patch", "input", "patchText") ?? "");
        return diff === null ? make("edit", "") : make("edit", diff.files[0] ?? "", { type: "diff", diff });
      }
      case "search_content":
      case "grep":
      case "find_files":
      case "list_files":
      case "search": {
        const pattern = string("pattern", "query", "path") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "web-search":
      case "web_search":
        return make("web", string("query") ?? "");
      case "web-extract":
      case "web_extract": {
        const urls = (asArray(input.urls) ?? []).map((url) => asString(url) ?? "").filter((url) => url.length > 0);
        return make("web", urls[0] ?? string("url") ?? "");
      }
      case "subagent":
      case "task": {
        const prompt = string("prompt", "task") ?? "";
        const target = string("description") ?? firstLine(prompt);
        return make("agent", target, prompt.length > 0 ? { type: "text", text: Array.from(prompt).slice(0, 2_000).join("") } : { type: "none" });
      }
      case "todo_write":
      case "task_write": {
        const todos = (asArray(input.todos) ?? asArray(input.tasks) ?? []).filter(isObject);
        const steps = todos.map((todo) => ({ text: asString(todo.content) ?? asString(todo.title) ?? "", status: planStatus(todo.status) }));
        const active = todos.find((todo) => planStatus(todo.status) === "inProgress");
        return make("plan", active === undefined ? "" : (asString(active.content) ?? asString(active.title) ?? ""), { type: "plan", steps });
      }
      default: {
        const target = string("command", "path", "query", "url", "pattern", "description", "name", "prompt");
        return make({ other: otherToolName(name) }, target === null ? "" : firstLine(target));
      }
    }
  }
}
