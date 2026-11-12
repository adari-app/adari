// Reads a Hermes session, one row per line as HermesStoreSource lays it out
// (agents/hermes-store.ts: `{"hm":1,"id","cwd","d":<the row: id, role, content, tool_calls, tool_call_id,
// tool_name, ts, finish, reasoning, kind, summary>}`).
//
// Hermes keeps the OpenAI chat shape (hermes-agent hermes_state_common.py:537-567, hermes_state_messages.py):
// - `role` user: the user's message, `content` text, or `"\u0000json:"` and a JSON list of parts (text, `image_url`)
//   for a multimodal one (hermes_state.py:1633, hermes_state_messages.py:141-170); a context summary
//   (`summary`, `_compressed_summary`) is the compaction row; `display_kind` "hidden" rows are model-facing
//   scaffolding the gateway never paints (hermes_state_common.py:135), skipped;
// - `role` assistant: `reasoning` its thinking, `content` its reply, `tool_calls` a JSON list of
//   `{id, type: "function", function: {name, arguments}}` (hermes_state_messages.py:93-104); with none the
//   turn ends; `display_kind` "failed_turn" is the failed turn's notice (agent/turn_failure_copy.py:75,
//   agent/conversation_loop.py:1957), said as an error;
// - `role` tool: a call's result by `tool_call_id`, its `content` the tool's JSON (`{"output", "exit_code",
//   "error"}` for the terminal, tools/terminal_tool.py:1066) or text;
// - `system` and `session_meta` rows are skipped. A role neither has is unknown, as is the view's line for a
//   database without the tables or columns the reader needs (the feed's unrecognised-format note); its
//   placeholders (a row too long or not JSON, one rewritten while read) are skipped and counted.

import { firstLine, LineResult, otherToolName, planStatus, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { attachment, bashDetail, searchDetail, toolCall, toolOutput, userMessage, type ChatAttachment, type ChatToolCall, type ChatToolDetail, type ChatToolKind, type TranscriptEvent } from "../model";
import { asArray, asObject, asString, ChatDiffMaker, ChatJSON, isObject, type JSONObject } from "../tools";

const blank = (text: string): boolean => text.trim().length === 0;

/** Hermes's `timestamp` (seconds, `time.time()`) as the timeline's seconds. */
const seconds = (value: unknown): number | null => {
  const time = ChatJSON.double(value);
  return time === null || !Number.isFinite(time) || time <= 0 ? null : time;
};

/** The marker a structured `content` starts with (hermes_state.py:1633). */
const jsonContent = "\u0000json:";

/** The image type a data URL names, or "image". */
const imageType = (url: string | null): string => {
  const match = url === null ? null : /^data:(image\/[A-Za-z0-9.+-]{1,40});/.exec(url);
  return match === null ? "image" : match[1]!;
};

/** A message's text and pictures, from its `content` as Hermes stored it. */
export function hermesContent(content: unknown): { text: string; pictures: ChatAttachment[] } {
  const value = asString(content);
  if (value === null) return { text: "", pictures: [] };
  if (!value.startsWith(jsonContent)) return { text: value, pictures: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(jsonContent.length));
  } catch {
    return { text: value, pictures: [] };
  }
  if (typeof parsed === "string") return { text: parsed, pictures: [] };
  const text: string[] = [];
  const pictures: ChatAttachment[] = [];
  for (const part of asArray(parsed) ?? []) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    const type = asString(part.type);
    if (type === "text" || type === "input_text") {
      const said = asString(part.text) ?? "";
      if (!blank(said)) text.push(said);
    } else if (type === "image_url" || type === "input_image" || type === "image") {
      const url = asString(asObject(part.image_url)?.url) ?? asString(part.image_url) ?? asString(part.url);
      pictures.push(attachment(null, imageType(url)));
    }
  }
  return { text: text.join("\n\n"), pictures };
}

const skippedRoles = new Set(["system", "session_meta", "developer"]);

export class HermesStoreParser {
  /** The session's folder, as each line's envelope gives it. */
  cwd: string | null = null;

  clone(): HermesStoreParser {
    const copy = new HermesStoreParser();
    copy.cwd = this.cwd;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    if (ChatJSON.int(object.hm) !== 1) return LineResult.unknown("hermes line");
    const kind = asString(object.k);
    if (kind === "bad") return LineResult.skipped(`hermes ${asString(object.bad) ?? "row"}`);
    if (kind !== null) return LineResult.unknown(`hermes ${kind}`);
    const cwd = asString(object.cwd);
    if (cwd !== null && cwd.length > 0) this.cwd = cwd;
    const row = asObject(object.d);
    if (row === null) return LineResult.malformed();
    const id = ChatJSON.int(row.id) ?? ChatJSON.int(object.id) ?? 0;
    const role = asString(row.role) ?? "";
    const time = seconds(row.ts);
    const display = asString(row.kind);
    if (display === "hidden") return LineResult.skipped("hidden");
    switch (role) {
      case "user":
        return this.user(id, row, time);
      case "assistant":
        return this.assistant(id, row, time, display);
      case "tool":
        return this.tool(row, time);
      default:
        return skippedRoles.has(role) ? LineResult.skipped(role) : LineResult.unknown(role.length === 0 ? "hermes row" : role);
    }
  }

  private user(id: number, row: JSONObject, time: number | null): TranscriptLineResult {
    if (ChatJSON.int(row.summary) === 1) return LineResult.events([{ type: "notice", notice: { id: `hermes-${id}`, kind: "compacted", time }, endsTurn: false }]);
    const { text, pictures } = hermesContent(row.content);
    if (blank(text) && pictures.length === 0) return LineResult.skipped("user");
    return LineResult.events([{ type: "userMessage", message: userMessage(`hermes-${id}`, text, time, pictures) }]);
  }

  private assistant(id: number, row: JSONObject, time: number | null, display: string | null): TranscriptLineResult {
    if (ChatJSON.int(row.summary) === 1) return LineResult.events([{ type: "notice", notice: { id: `hermes-${id}`, kind: "compacted", time }, endsTurn: false }]);
    const events: TranscriptEvent[] = [];
    const reasoning = asString(row.reasoning) ?? "";
    if (!blank(reasoning)) events.push({ type: "agentProgress", text: { id: `hermes-${id}-reasoning`, markdown: reasoning, time } });
    const { text } = hermesContent(row.content);
    if (display === "failed_turn") {
      events.push({ type: "agentText", text: { id: `hermes-${id}`, markdown: `Error: ${blank(text) ? "the turn failed" : text}`, time } });
      events.push({ type: "agentStopped", time });
      return LineResult.events(events);
    }
    if (!blank(text)) events.push({ type: "agentText", text: { id: `hermes-${id}`, markdown: text, time } });
    let calls: unknown[] = [];
    const raw = asString(row.tool_calls);
    if (raw !== null && raw.trim().length > 0) {
      try {
        calls = asArray(JSON.parse(raw)) ?? [];
      } catch {
        calls = [];
      }
    }
    calls.filter(isObject).forEach((call, index) => {
      const fn = asObject(call.function) ?? {};
      const name = asString(fn.name) ?? asString(call.name) ?? "tool";
      const callID = HermesStoreParser.callID(asString(call.id) ?? `${id}-${index}`);
      let input: JSONObject = {};
      const args = fn.arguments ?? call.arguments;
      if (typeof args === "string") {
        try {
          input = asObject(JSON.parse(args)) ?? {};
        } catch {
          input = {};
        }
      } else input = asObject(args) ?? {};
      events.push({ type: "toolStarted", call: HermesStoreParser.call(callID, name, input, time) });
    });
    if (calls.length === 0 && (asString(row.finish) ?? "") !== "tool_calls") events.push({ type: "agentStopped", time });
    return LineResult.of(events, "assistant");
  }

  private tool(row: JSONObject, time: number | null): TranscriptLineResult {
    const callID = asString(row.tool_call_id);
    if (callID === null || callID.length === 0) return LineResult.skipped("tool");
    const content = asString(row.content) ?? "";
    let text = content;
    let exitCode: number | null = null;
    let isError = false;
    let parsed: unknown = null;
    if (content.trimStart().startsWith("{")) {
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = null;
      }
    }
    const result = asObject(parsed);
    if (result !== null) {
      exitCode = ChatJSON.int(result.exit_code);
      const error = result.error;
      const said = asString(error) ?? asString(asObject(error)?.message);
      isError = (said !== null && !blank(said)) || result.success === false || (exitCode !== null && exitCode !== 0);
      const output = asString(result.output) ?? asString(result.content) ?? asString(result.result);
      text = output !== null && !blank(output) ? output : said !== null && !blank(said) ? said : content;
    }
    return LineResult.events([{ type: "toolFinished", id: HermesStoreParser.callID(callID), output: toolOutput(text, { exitCode, isError }), time }]);
  }

  static callID(id: string): string {
    return `hermes-call-${id}`;
  }

  /** What a call is, from Hermes's tool name (tools/*.py registry names) and its arguments. */
  static call(id: string, name: string, input: JSONObject, time: number | null): ChatToolCall {
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = asString(input[key]);
        if (value !== null && value.length > 0) return value;
      }
      return null;
    };
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall => toolCall(id, kind, name, target, { detail, time });
    switch (name) {
      case "terminal": {
        const command = string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "read_file":
        return make("read", string("path") ?? "");
      case "write_file": {
        const path = string("path") ?? "";
        const content = asString(input.content);
        return content === null ? make("edit", path) : make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
      }
      case "patch": {
        const path = string("path") ?? "";
        const old = asString(input.old_string);
        const replacement = asString(input.new_string);
        if (old !== null && replacement !== null) return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
        const diff = ChatDiffMaker.patch(string("patch") ?? "");
        return diff === null ? make("edit", path) : make("edit", diff.files[0] ?? path, { type: "diff", diff });
      }
      case "search_files": {
        const pattern = string("pattern") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "web_search":
      case "x_search":
        return make("web", string("query") ?? "");
      case "web_extract": {
        const urls = (asArray(input.urls) ?? []).map((url) => asString(url) ?? "").filter((url) => url.length > 0);
        return make("web", urls[0] ?? string("url") ?? "");
      }
      case "delegate_task": {
        const goal = string("goal") ?? "";
        return make("agent", firstLine(goal), goal.length > 0 ? { type: "text", text: Array.from(goal).slice(0, 2_000).join("") } : { type: "none" });
      }
      case "todo_list":
      case "todo": {
        const todos = (asArray(input.todos) ?? []).filter(isObject);
        const steps = todos.map((todo) => ({ text: asString(todo.content) ?? "", status: planStatus(todo.status) }));
        const active = todos.find((todo) => planStatus(todo.status) === "inProgress");
        return make("plan", active === undefined ? "" : (asString(active.content) ?? ""), { type: "plan", steps });
      }
      default: {
        const target = string("command", "path", "query", "url", "pattern", "goal", "name", "code");
        return make({ other: otherToolName(name) }, target === null ? "" : firstLine(target));
      }
    }
  }
}
