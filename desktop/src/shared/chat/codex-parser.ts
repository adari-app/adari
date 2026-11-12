// Reads a Codex CLI session rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`),
// lines of `{ordinal, type, payload, timestamp}`, as of Codex 0.166. A port of
// HerdrKit's CodexRolloutParser.swift.
//
// Shown: `response_item` messages (user and assistant), tool calls and their
// outputs paired by `call_id` (`custom_tool_call` in code mode, and the older
// `function_call`), and turn start and end from `event_msg` task_started /
// task_complete. Skipped: developer messages, the instructions and environment
// context Codex sends as user messages, reasoning, token counts, session_meta,
// turn_context, world_state and the other bookkeeping.

import { firstLine, LineResult, otherToolName, planStatus, type TranscriptLineResult } from "./claude-parser";
import { anyString, CodexScript, firstString, scriptArray, scriptField, scriptString, scriptValueFromJSON, type ScriptValue } from "./codex-script";
import {
  attachment,
  bashDetail,
  toolCall,
  toolOutput,
  userMessage,
  type ChatAttachment,
  type ChatPlanStep,
  type ChatToolCall,
  type ChatToolDetail,
  type ChatToolKind,
  type ChatToolOutput,
  type TranscriptEvent,
} from "./model";
import { asArray, asObject, asString, ChatAttachmentText, ChatJSON, isObject, parseChatDate, ShellCommandClassifier, trimSpaces, type JSONObject } from "./tools";

const knownTypes = new Set(["session_meta", "turn_context", "world_state", "token_usage_record", "compacted"]);

/** User text that is context Codex adds, not typing. */
const contextPrefixes = ["<environment_context>", "<user_instructions>", "<permissions", "# AGENTS.md"];

/** Names that run a shell command, in code mode and in older rollouts. */
const commandTools = new Set(["exec_command", "shell", "container.exec", "local_shell", "shell_command", "exec"]);

/** The fields of a code-mode command result object: the same ones the textual header form carries. */
const commandResultKeys = new Set(["exit_code", "output", "wall_time_seconds", "session_id", "chunk_id", "original_token_count"]);

/** Swift's `x ?? y` on `[String: Any]` values: a key holding JSON null is a value there. */
const either = (object: JSONObject, first: string, second: string): unknown => (first in object ? object[first] : object[second]);

/** The first `count` characters (Swift's `String.prefix` over Characters, here code points). */
const prefixCharacters = (text: string, count: number): string => {
  const characters = Array.from(text);
  return characters.length <= count ? text : characters.slice(0, count).join("");
};

export class CodexRolloutParser {
  private serial = 0;
  private offset: number | null = null;
  private idsInLine = 0;
  /** The session's working folder: `session_meta.payload.cwd` (the first line). */
  cwd: string | null = null;

  /** Where the line being read starts in the file (when the caller knows): the ids a line lacks are made from it. */
  get lineOffset(): number | null {
    return this.offset;
  }

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  clone(): CodexRolloutParser {
    const copy = new CodexRolloutParser();
    copy.serial = this.serial;
    copy.offset = this.offset;
    copy.idsInLine = this.idsInLine;
    copy.cwd = this.cwd;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const type = asString(object.type);
    if (type === null) return LineResult.unknown("(no type)");
    const time = parseChatDate(object.timestamp);
    const payload = asObject(object.payload) ?? {};
    const ordinal = ChatJSON.int(object.ordinal);
    const folder = asString(payload.cwd);
    if (type === "session_meta" && this.cwd === null && folder !== null && folder.length > 0) this.cwd = folder;
    switch (type) {
      case "response_item":
        return this.responseItem(payload, time, ordinal);
      case "event_msg": {
        const event = asString(payload.type) ?? "?";
        switch (event) {
          case "task_started":
            return LineResult.events([{ type: "turnStarted", time }]);
          case "task_complete": {
            const ms = ChatJSON.double(payload.duration_ms);
            return LineResult.events([{ type: "turnCompleted", time, duration: ms === null ? null : ms / 1000 }]);
          }
          default:
            return LineResult.skipped("event_msg/" + event);
        }
      }
      default:
        return knownTypes.has(type) ? LineResult.skipped(type) : LineResult.unknown(type);
    }
  }

  // MARK: response items

  private responseItem(payload: JSONObject, time: number | null, ordinal: number | null): TranscriptLineResult {
    const itemType = asString(payload.type) ?? "?";
    // Made before the item's own id is looked at, as HerdrKit does (a count moves even when unused).
    const fallbackID = ordinal === null ? this.nextID(itemType) : `codex-${ordinal}`;
    const ownID = asString(payload.id);
    const id = ownID !== null && ownID.length > 0 ? ownID : fallbackID;
    switch (itemType) {
      case "message":
        return CodexRolloutParser.message(payload, id, time);
      case "custom_tool_call": {
        const callID = asString(payload.call_id);
        if (callID === null) return LineResult.skipped("custom_tool_call");
        const name = asString(payload.name) ?? "";
        const input = asString(payload.input) ?? "";
        return LineResult.events([{ type: "toolStarted", call: CodexRolloutParser.customCall(callID, name, input, time) }]);
      }
      case "function_call": {
        const callID = asString(payload.call_id);
        if (callID === null) return LineResult.skipped("function_call");
        const name = asString(payload.name) ?? "";
        const argumentsText = asString(payload.arguments) ?? "";
        return LineResult.events([{ type: "toolStarted", call: CodexRolloutParser.functionCall(callID, name, argumentsText, time) }]);
      }
      case "local_shell_call": {
        const callID = asString(payload.call_id) ?? asString(payload.id);
        if (callID === null) return LineResult.skipped("local_shell_call");
        const action = scriptValueFromJSON(payload.action);
        const command = (action === null ? null : CodexRolloutParser.command(action)) ?? "";
        return LineResult.events([{ type: "toolStarted", call: CodexRolloutParser.commandCall(callID, "local_shell", command, time) }]);
      }
      case "custom_tool_call_output":
      case "function_call_output": {
        const callID = asString(payload.call_id);
        if (callID === null) return LineResult.skipped(itemType);
        return LineResult.events([{ type: "toolFinished", id: callID, output: CodexRolloutParser.output(payload.output), time }]);
      }
      case "web_search_call": {
        const action = scriptValueFromJSON(payload.action);
        const query = firstString(action, ["query", "q", "url"]) ?? "";
        const events: TranscriptEvent[] = [{ type: "toolStarted", call: toolCall(id, "web", "web_search", query, { time }) }];
        const status = asString(payload.status);
        if (status !== null && status !== "in_progress") {
          events.push({ type: "toolFinished", id, output: toolOutput("", { isError: status === "failed" }), time });
        }
        return LineResult.events(events);
      }
      default:
        return LineResult.skipped("response_item/" + itemType);
    }
  }

  private static message(payload: JSONObject, id: string, time: number | null): TranscriptLineResult {
    const role = asString(payload.role) ?? "?";
    const blocks = (asArray(payload.content) ?? []).filter(isObject);
    switch (role) {
      case "user": {
        const texts: string[] = [];
        const images: ChatAttachment[] = [];
        for (const block of blocks) {
          switch (asString(block.type)) {
            case "input_text":
            case "text":
            case "output_text": {
              const text = asString(block.text);
              if (text === null || CodexRolloutParser.isContext(text)) continue;
              texts.push(text);
              break;
            }
            case "input_image":
            case "image":
              images.push(attachment(null, CodexRolloutParser.mediaType(either(block, "image_url", "url"))));
              break;
            default:
              continue;
          }
        }
        const extracted = ChatAttachmentText.extract(texts.join("\n\n"));
        const attachments: ChatAttachment[] = [...images];
        for (let n = images.length; n < extracted.imageMarkers; n += 1) attachments.push(attachment());
        attachments.push(...extracted.attachments);
        if (extracted.text.length === 0 && attachments.length === 0) return LineResult.skipped("message/user-context");
        return LineResult.events([{ type: "userMessage", message: userMessage(id, extracted.text, time, attachments) }]);
      }
      case "assistant": {
        const text = blocks
          .flatMap((block) => {
            const type = asString(block.type);
            if (type === null || !["output_text", "text", "input_text"].includes(type)) return [];
            const value = asString(block.text);
            return value === null ? [] : [value];
          })
          .join("\n\n");
        if (text.trim().length === 0) return LineResult.skipped("message/assistant-empty");
        return LineResult.events([{ type: "agentText", text: { id, markdown: text, time } }]);
      }
      default:
        return LineResult.skipped("message/" + role);
    }
  }

  /** Instructions and environment context: a known prefix, or a text that is one XML-like element and nothing else. */
  static isContext(text: string): boolean {
    const trimmed = text.trim();
    if (contextPrefixes.some((prefix) => trimmed.startsWith(prefix))) return true;
    if (!trimmed.startsWith("<") || !trimmed.endsWith(">")) return false;
    const afterOpen = Array.from(trimmed.slice(1));
    let length = 0;
    while (length < afterOpen.length && /^[\p{L}\p{N}_\-.:]$/u.test(afterOpen[length]!)) length += 1;
    const first = afterOpen[0];
    if (length === 0 || first === undefined || !(/^\p{L}$/u.test(first) || first === "_")) return false;
    const next = afterOpen[length];
    if (!(next === ">" || next === " " || next === "\n" || next === "\t")) return false;
    return CodexRolloutParser.isOneElement(trimmed, afterOpen.slice(0, length).join(""));
  }

  /** True when the element `name` opened at the start of `text` closes at its very end, same-name elements inside nested. */
  static isOneElement(text: string, name: string): boolean {
    const open = `<${name}`;
    const close = `</${name}>`;
    let depth = 0;
    let index = 0;
    while (index < text.length) {
      if (text.startsWith(close, index)) {
        depth -= 1;
        index += close.length;
        if (depth <= 0) return depth === 0 && index === text.length;
        continue;
      }
      if (text.startsWith(open, index)) {
        const after = text[index + open.length];
        if (after === ">" || after === " " || after === "\n" || after === "\t") depth += 1;
      }
      index += 1;
    }
    return false;
  }

  static mediaType(value: unknown): string | null {
    const url = asString(value);
    if (url === null || !url.startsWith("data:")) return null;
    const rest = url.slice(5);
    const end = rest.search(/[;,]/);
    const type = end < 0 ? rest : rest.slice(0, end);
    return type.length === 0 ? null : type;
  }

  // MARK: tool calls

  /** A `custom_tool_call`: `exec` holds a code-mode script (or an older JSON object with the command); `apply_patch` a patch. */
  static customCall(id: string, name: string, input: string, time: number | null): ChatToolCall {
    if (name === "exec") {
      const trimmed = input.trim();
      if (trimmed.startsWith("{")) {
        const json = scriptValueFromJSON(ChatJSON.value(trimmed));
        const command = json === null ? null : CodexRolloutParser.command(json);
        if (command !== null) return CodexRolloutParser.commandCall(id, name, command, time);
      }
      return CodexRolloutParser.scriptCall(id, input, time);
    }
    const mapped = CodexRolloutParser.mapped(id, name, scriptValueFromJSON(ChatJSON.value(input)), input, time);
    if (mapped !== null) return mapped;
    return toolCall(id, { other: CodexRolloutParser.otherName(name) }, name, firstLine(input), { time });
  }

  /** An older `function_call`: `arguments` is a JSON string. */
  static functionCall(id: string, name: string, argumentsText: string, time: number | null): ChatToolCall {
    const argument = scriptValueFromJSON(ChatJSON.value(argumentsText));
    const mapped = CodexRolloutParser.mapped(id, name, argument, argumentsText, time);
    if (mapped !== null) return mapped;
    const text = anyString(argument);
    return toolCall(id, { other: CodexRolloutParser.otherName(name) }, name, text === null ? "" : firstLine(text), { time });
  }

  /** One row per script, named by its first meaningful call; "+N more" counts the rest. Unreadable: Other("script"). */
  static scriptCall(id: string, script: string, time: number | null): ChatToolCall {
    const calls = CodexScript.calls(script).filter((call) => call.name !== "clock__curr_time");
    const first = calls[0];
    const found = first === undefined ? null : CodexRolloutParser.mapped(id, first.name, first.argument, null, time);
    const call =
      found ??
      toolCall(id, { other: "script" }, "exec", firstLine(script), { detail: { type: "text", text: prefixCharacters(script, 4_000) }, time });
    return { ...call, toolName: "exec", moreCalls: Math.max(0, calls.length - 1) };
  }

  /** The row for one named call, or null when its argument cannot be read. */
  static mapped(id: string, name: string, argument: ScriptValue | null, raw: string | null, time: number | null): ChatToolCall | null {
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall =>
      toolCall(id, kind, name, target, { detail, time });
    if (commandTools.has(name)) {
      const command = argument === null ? null : CodexRolloutParser.command(argument);
      return command === null ? null : CodexRolloutParser.commandCall(id, name, command, time);
    }
    switch (name) {
      case "apply_patch": {
        const text = scriptString(argument) ?? scriptString(scriptField(argument, "input")) ?? scriptString(scriptField(argument, "patch")) ?? raw;
        const edit = text === null ? null : ShellCommandClassifier.editFromPatch(text);
        return edit === null ? null : make(edit.kind, edit.target, edit.detail);
      }
      case "view_image":
        return make("read", scriptString(scriptField(argument, "path")) ?? scriptString(argument) ?? "");
      case "write_stdin": {
        const label = "input to a running command";
        return make("bash", label, { type: "bash", bash: bashDetail(label) });
      }
      case "update_plan": {
        const steps: ChatPlanStep[] = (scriptArray(scriptField(argument, "plan")) ?? []).map((step) => ({
          text: scriptString(scriptField(step, "step")) ?? scriptString(step) ?? "",
          status: planStatus(scriptString(scriptField(step, "status"))),
        }));
        const active = steps.find((step) => step.status === "inProgress")?.text ?? "";
        return make("plan", active, { type: "plan", steps });
      }
      case "send_message":
        return make("agent", "Message agent", CodexRolloutParser.agentDetail(argument));
      case "wait":
      case "wait_agent":
        return make("agent", "Wait");
      case "spawn_agent":
        return make("agent", "Start agent", CodexRolloutParser.agentDetail(argument));
      default:
        break;
    }
    if (name === "web_search" || name.startsWith("web__") || name.startsWith("web.")) {
      const target = firstString(argument, ["q", "query", "url", "ref_id", "location", "pattern"]) ?? scriptString(argument) ?? "";
      return make("web", target);
    }
    const text = anyString(argument);
    return make({ other: CodexRolloutParser.otherName(name) }, text === null ? "" : firstLine(text));
  }

  private static agentDetail(argument: ScriptValue | null): ChatToolDetail {
    const text = firstString(argument, ["message", "prompt", "task", "text", "input"]);
    return text === null ? { type: "none" } : { type: "text", text: prefixCharacters(text, 2_000) };
  }

  static commandCall(id: string, name: string, command: string, time: number | null): ChatToolCall {
    const classified = ShellCommandClassifier.classify(command);
    return toolCall(id, classified.kind, name, classified.target, { detail: classified.detail, time, program: classified.program });
  }

  /** `cmd`, `command` (a string or an argv array) or `argv`. */
  static command(value: ScriptValue): string | null {
    for (const key of ["cmd", "command", "argv"]) {
      const field = scriptField(value, key);
      const string = scriptString(field);
      if (string !== null && string.length > 0) return string;
      const array = scriptArray(field);
      if (array !== null) {
        const argv = array.flatMap((item) => {
          const text = scriptString(item);
          return text === null ? [] : [text];
        });
        if (argv.length > 0) return CodexRolloutParser.fromArgv(argv);
      }
    }
    return null;
  }

  /** `["bash", "-lc", "<script>"]` is the script; any other argv is joined, quoted where needed. */
  static fromArgv(argv: readonly string[]): string {
    const shells = new Set(["bash", "sh", "zsh"]);
    const program = (argv[0] ?? "").split("/").filter((part) => part.length > 0).at(-1);
    if (argv.length >= 3 && program !== undefined && shells.has(program) && ["-c", "-lc", "-lic", "-ic", "-cl"].includes(argv[1]!)) {
      return argv[2]!;
    }
    const special = " \t\n'\"$`\\|&;<>()*?";
    return argv
      .map((arg) => (Array.from(arg).some((c) => special.includes(c)) ? "'" + arg.split("'").join("'\\''") + "'" : arg))
      .join(" ");
  }

  /** `mcp__<server>__<tool>` shows as `<tool>`. */
  static otherName(name: string): string {
    return otherToolName(name.length === 0 ? "tool" : name);
  }

  // MARK: outputs

  /**
   * A `custom_tool_call_output` (a list of `{type: input_text, text}`) or a
   * `function_call_output` (a string, sometimes JSON with `output` and `metadata.exit_code`).
   */
  static output(value: unknown): ChatToolOutput {
    let text = ChatJSON.text(value);
    let exitFromJSON: number | null = null;
    if (typeof value === "string" && value.startsWith("{")) {
      const object = asObject(ChatJSON.value(value));
      const inner = object === null ? null : asString(object.output);
      if (object !== null && inner !== null) {
        text = inner;
        exitFromJSON = ChatJSON.int(asObject(object.metadata)?.exit_code);
      }
    }
    const parsed = CodexRolloutParser.parseHeaders(text);
    return parsed.exitCode === null ? { ...parsed, exitCode: exitFromJSON } : parsed;
  }

  /**
   * Peels the header blocks Codex puts before a result: the script's (`Script
   * completed` / `Script failed` / `Script running with cell ID …`, `Wall time N
   * seconds`, `Output:`) and the command's inside it (`Process exited with code
   * N`, `Exit code: N`, `Chunk ID`, `Wall time`).
   */
  static parseHeaders(text: string): ChatToolOutput {
    let body = text;
    let failed = false;
    let running = false;
    let scriptHeader = false;
    let exitCode: number | null = null;
    for (let pass = 0; pass < 3; pass += 1) {
      const lines = body.split("\n");
      let outputAt: number | null = null;
      let headerLines = 0;
      for (const [index, raw] of lines.slice(0, 14).entries()) {
        const line = trimSpaces(raw);
        if (line.startsWith("Script completed")) {
          scriptHeader = true;
        } else if (line.startsWith("Script failed")) {
          failed = true;
          scriptHeader = true;
        } else if (line.startsWith("Script running with cell ID")) {
          running = true;
          scriptHeader = true;
        } else {
          const code = numberAfter("Process exited with code ", line) ?? numberAfter("Exit code: ", line) ?? numberAfter("Exit code ", line);
          if (code !== null) {
            exitCode = code;
          } else if (
            line.startsWith("Wall time") ||
            line.startsWith("Chunk ID") ||
            line.startsWith("Original token count") ||
            line.startsWith("Process running with session ID") ||
            line.startsWith("Total output lines")
          ) {
            // a header line
          } else if (line === "Output:") {
            outputAt = index;
            break;
          } else if (line.length === 0 && headerLines > 0) {
            // a blank line inside the headers
          } else {
            break;
          }
        }
        headerLines = index + 1;
      }
      if (outputAt !== null) {
        body = lines.slice(outputAt + 1).join("\n");
      } else if (headerLines > 0) {
        body = lines.slice(headerLines).join("\n");
        break;
      } else {
        break;
      }
    }
    // `text(await tools.exec_command(...))` prints the command's result object.
    if (scriptHeader) {
      const result = CodexRolloutParser.commandResult(body);
      if (result !== null) {
        body = result.output;
        if (result.exitCode !== null) exitCode = result.exitCode;
      }
    }
    return toolOutput(body, { isError: failed, exitCode, isRunning: running && !failed });
  }

  /**
   * A printed command result: one JSON object with a string `output`, a numeric
   * `exit_code` or a `session_id`, and no field outside `commandResultKeys`.
   * Anything else stays the output as written.
   */
  static commandResult(text: string): { output: string; exitCode: number | null } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    const object = asObject(ChatJSON.value(trimmed));
    if (object === null) return null;
    const output = asString(object.output);
    if (output === null || !Object.keys(object).every((key) => commandResultKeys.has(key))) return null;
    let exitCode: number | null = null;
    if ("exit_code" in object && object.exit_code !== null) {
      if (typeof object.exit_code !== "number") return null;
      const code = ChatJSON.int(object.exit_code);
      if (code === null) return null;
      exitCode = code;
    }
    const session = "session_id" in object && object.session_id !== null;
    if (exitCode === null && !session) return null;
    return { output, exitCode };
  }

  /** An id for an item that has none (nor an ordinal): from where its line is in the file when known, else a count. */
  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `codex-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `codex-${prefix}-${this.serial}`;
  }
}

/** Swift's `Int(line.dropFirst(prefix.count).prefix { $0.isNumber || $0 == "-" })` after `prefix`. */
function numberAfter(prefix: string, line: string): number | null {
  if (!line.startsWith(prefix)) return null;
  const digits = /^[\p{N}-]*/u.exec(line.slice(prefix.length))?.[0] ?? "";
  if (!/^[+-]?\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}
