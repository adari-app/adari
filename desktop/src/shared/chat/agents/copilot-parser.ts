// Reads a GitHub Copilot CLI session's event log
// (`~/.copilot/session-state/<id>/events.jsonl`, copilot-locate.ts), one session event per line:
// `{id, timestamp, parentId, type, data, agentId?, ephemeral?}` (github/copilot-sdk d1e6021,
// nodejs/src/generated/session-events.ts: the SessionEvent union, :12-200; the envelope, StartEvent
// :2077-2112; event log schema `version` 1, go/session_event_serialization_test.go:23).
//
// Shown:
// - the user's message: `user.message` `data.content` (:6483-6560), its file and image attachments
//   (`file` path, `blob` media type; AttachmentFile, AttachmentBlob); one with an origin `source` that
//   is not the user's (a skill's injection, another agent's prompt, an autopilot continuation) is skipped;
//   `delivery: "steering"` (taken while the agent worked) goes inside the running turn (:UserMessageDelivery);
// - the reply: `assistant.message` `data.content` (:7952-8040), markdown; one with no `toolRequests`
//   ends the turn (the loop goes on only while it calls tools);
// - its thinking: `assistant.reasoning` `data.content` (:7728-7760), the thinking row;
// - tool calls: `tool.execution_start` (`toolCallId`, `toolName`, `arguments`, :9589-9660) and
//   `tool.execution_complete` (`success`, `result.content`, `error.message`, :9940-10010), paired by id,
//   mapped to the nearest row kind by name (bash, view, edit, create, grep, glob, web_fetch, task, …);
//   `report_intent` (the status line's words) shows no row;
// - notices: `abort` (:9489) the stopped row, ending the turn; a successful `session.compaction_complete`
//   the compaction row; `session.error` (:2483) its message as the agent's words, ending the turn.
// - the folder: `session.start` / `session.resume` `data.context.cwd` (:2205, :2315).
//
// Skipped: a sub-agent's own events (`agentId`, or the deprecated `parentToolCallId`), and every other
// known event (session bookkeeping, usage, hooks, permissions, MCP, …). A line that is not JSON, has no
// type, or whose type is from no Copilot namespace is unknown; so is every line after a `session.start`
// of a later schema `version` (the unrecognised-format note, never a wrong chat).

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
import { asArray, asObject, asString, ChatDiffMaker, ChatJSON, isObject, parseChatDate, ShellCommandClassifier, type JSONObject } from "../tools";

/** The event log schema this reader knows (StartData.version). */
export const copilotLogVersion = 1;

/** The namespaces of Copilot's session events (session-events.ts's `type` values); any other type is unknown. */
const namespaces = new Set([
  "session",
  "assistant",
  "user",
  "tool",
  "tool_search",
  "subagent",
  "hook",
  "system",
  "permission",
  "skill",
  "model",
  "mcp",
  "mcp_app",
  "command",
  "commands",
  "capabilities",
  "external_tool",
  "elicitation",
  "sampling",
  "user_input",
  "pending_messages",
  "auto_mode_switch",
  "auto_mode_recovery",
  "auto_mode_recovery_consent",
  "session_limits_exhausted",
  "exit_plan_mode",
  "workflow",
  "instruction",
  "ui",
  "human_response",
]);

/** Origins of a `user.message` that are not the user's typing (UserMessageData.source's examples: `skill-pdf`, `agent-<id>`). */
const notHisSource = (source: string): boolean => source.startsWith("skill-") || source.startsWith("agent-") || source === "system" || source === "autopilot";

/** `assistant.message` phases that are not the final answer (AssistantMessageData.phase: "thinking vs. response phases"). */
const thinkingPhases = new Set(["thinking", "commentary", "analysis", "reasoning"]);

/** Tools whose call is the status line, not work: no row. */
const hiddenTools = new Set(["report_intent"]);

/** How many hidden call ids are remembered (their results are skipped too). */
const maxHidden = 256;

const blank = (text: string): boolean => text.trim().length === 0;

export class CopilotEventsParser {
  private offset: number | null = null;
  private idsInLine = 0;
  private serial = 0;
  /** A `session.start` of a later schema version was read: every line is unknown from then on. */
  private newerVersion = false;
  /** Calls that show no row (`report_intent`), so their results show none either. */
  private hidden: string[] = [];
  /** The session's working folder: `session.start`'s `data.context.cwd`, then the latest `session.resume`'s. */
  cwd: string | null = null;

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  get lineOffset(): number | null {
    return this.offset;
  }

  clone(): CopilotEventsParser {
    const copy = new CopilotEventsParser();
    copy.serial = this.serial;
    copy.newerVersion = this.newerVersion;
    copy.hidden = [...this.hidden];
    copy.cwd = this.cwd;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const type = asString(object.type);
    if (type === null || type.length === 0) return LineResult.unknown("(no type)");
    if (this.newerVersion) return LineResult.unknown(type);
    const data = asObject(object.data);
    if (data === null) return namespaces.has(type.split(".")[0]!) || type === "abort" ? LineResult.skipped(type) : LineResult.unknown(type);
    const agent = asString(object.agentId);
    if (agent !== null && agent.length > 0) return LineResult.skipped("subagent " + type);
    const time = parseChatDate(object.timestamp);
    const eventID = asString(object.id);
    switch (type) {
      case "session.start": {
        const version = ChatJSON.int(data.version);
        if (version !== null && version > copilotLogVersion) {
          this.newerVersion = true;
          return LineResult.unknown(`session.start v${version}`);
        }
        this.takeFolder(data);
        return LineResult.skipped(type);
      }
      case "session.resume":
        this.takeFolder(data);
        return LineResult.skipped(type);
      case "user.message":
        return this.user(data, eventID, time);
      case "assistant.message":
        return this.assistant(data, eventID, time);
      case "assistant.reasoning": {
        const text = asString(data.content) ?? "";
        if (blank(text) || asString(data.parentToolCallId) !== null) return LineResult.skipped(type);
        const id = asString(data.reasoningId) ?? eventID ?? this.nextID("thought");
        return LineResult.events([{ type: "agentProgress", text: { id: "copilot-thought-" + id, markdown: text, time } }]);
      }
      case "tool.execution_start":
        return this.started(data, time);
      case "tool.execution_complete":
        return this.finished(data, time);
      case "abort":
        return LineResult.events([{ type: "notice", notice: { id: this.nextID("interrupted", eventID), kind: "interrupted", time }, endsTurn: true }]);
      case "session.compaction_complete":
        if (!ChatJSON.bool(data.success)) return LineResult.skipped(type);
        return LineResult.events([{ type: "notice", notice: { id: this.nextID("compacted", eventID), kind: "compacted", time }, endsTurn: false }]);
      case "session.error": {
        const message = asString(data.message) ?? "";
        if (blank(message)) return LineResult.skipped(type);
        return LineResult.events([
          { type: "agentText", text: { id: this.nextID("error", eventID), markdown: "**Error:** " + message, time } },
          { type: "agentStopped", time },
        ]);
      }
      default:
        return namespaces.has(type.split(".")[0]!) ? LineResult.skipped(type) : LineResult.unknown(type);
    }
  }

  private takeFolder(data: JSONObject): void {
    const folder = asString(asObject(data.context)?.cwd);
    if (folder !== null && folder.startsWith("/")) this.cwd = folder;
  }

  // MARK: the user's messages

  private user(data: JSONObject, eventID: string | null, time: number | null): TranscriptLineResult {
    const source = asString(data.source);
    if ((source !== null && notHisSource(source)) || ChatJSON.bool(data.isAutopilotContinuation)) return LineResult.skipped("user.message/" + (source ?? "autopilot"));
    const text = asString(data.content) ?? "";
    const attachments: ChatAttachment[] = [];
    for (const item of (asArray(data.attachments) ?? []).filter(isObject)) {
      const media = asString(item.mimeType);
      switch (asString(item.type)) {
        case "file":
          attachments.push(attachment(asString(item.path), media));
          break;
        case "blob":
          attachments.push(attachment(null, media));
          break;
        default:
          break;
      }
    }
    if (blank(text) && attachments.length === 0) return LineResult.skipped("user.message/empty");
    const id = "copilot-user-" + (asString(data.messageId) ?? eventID ?? this.nextID("prompt"));
    const queued = asString(data.delivery) === "steering";
    const event: TranscriptEvent = { type: "userMessage", message: userMessage(id, text.trim(), time, attachments), ...(queued ? { queued: true } : {}) };
    return LineResult.events([event]);
  }

  // MARK: the agent

  private assistant(data: JSONObject, eventID: string | null, time: number | null): TranscriptLineResult {
    if (asString(data.parentToolCallId) !== null) return LineResult.skipped("assistant.message/subagent");
    const events: TranscriptEvent[] = [];
    const text = asString(data.content) ?? "";
    const id = asString(data.messageId) ?? eventID ?? this.nextID("text");
    if (!blank(text)) events.push({ type: "agentText", text: { id: "copilot-text-" + id, markdown: text, time } });
    const requests = (asArray(data.toolRequests) ?? []).filter(isObject);
    // Copilot's loop goes on only while it calls tools: a message with none ends the turn, unless more of
    // the same response follows (`chunkIndex` before `chunkCount - 1`) or it is a thinking phase's.
    const chunks = ChatJSON.int(data.chunkCount);
    const chunk = ChatJSON.int(data.chunkIndex);
    const more = chunks !== null && chunk !== null && chunk < chunks - 1;
    const phase = asString(data.phase);
    const thinking = phase !== null && thinkingPhases.has(phase);
    if (requests.length === 0 && !more && !thinking) events.push({ type: "agentStopped", time });
    return events.some((event) => event.type !== "agentStopped") ? LineResult.events(events) : { events, outcome: { kind: "skipped", type: "assistant.message" } };
  }

  // MARK: tools

  private started(data: JSONObject, time: number | null): TranscriptLineResult {
    const id = asString(data.toolCallId);
    const name = asString(data.toolName) ?? "";
    if (id === null || id.length === 0 || asString(data.parentToolCallId) !== null) return LineResult.skipped("tool.execution_start");
    if (hiddenTools.has(name)) {
      this.hidden.push(id);
      if (this.hidden.length > maxHidden) this.hidden.shift();
      return LineResult.skipped("tool.execution_start/" + name);
    }
    const shown = asString(data.mcpToolName) ?? name;
    return LineResult.events([{ type: "toolStarted", call: CopilotEventsParser.call(id, name, shown, data.arguments, time) }]);
  }

  private finished(data: JSONObject, time: number | null): TranscriptLineResult {
    const id = asString(data.toolCallId);
    if (id === null || id.length === 0 || asString(data.parentToolCallId) !== null) return LineResult.skipped("tool.execution_complete");
    if (this.hidden.includes(id)) return LineResult.skipped("tool.execution_complete/hidden");
    const success = data.success !== false;
    const result = asObject(data.result);
    const error = asObject(data.error);
    const said = asString(result?.content) ?? asString(result?.detailedContent) ?? "";
    const text = success ? said : (asString(error?.message) ?? said);
    return LineResult.events([{ type: "toolFinished", id, output: toolOutput(text, { isError: !success }), time }]);
  }

  /** What a call is, from Copilot's tool name and its arguments (an object, or a string for a grammar tool). */
  static call(id: string, name: string, shown: string, value: unknown, time: number | null): ChatToolCall {
    const args = asObject(value) ?? {};
    const raw = asString(value);
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const found = asString(args[key]);
        if (found !== null && found.length > 0) return found;
      }
      return null;
    };
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall => toolCall(id, kind, name, target, { detail, time });
    switch (name) {
      case "bash":
      case "powershell":
      case "shell": {
        const command = string("command") ?? raw ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "read_bash":
      case "write_bash":
      case "stop_bash":
      case "read_powershell":
      case "write_powershell":
      case "stop_powershell": {
        const label = name.startsWith("read_") ? "output of a running command" : name.startsWith("write_") ? "input to a running command" : "stop a running command";
        return make("bash", label, { type: "bash", bash: bashDetail(label) });
      }
      case "view":
      case "read_file":
      case "show_file":
        return make("read", string("path", "file_path") ?? "");
      case "edit":
      case "str_replace":
      case "str_replace_editor": {
        const path = string("path", "file_path") ?? "";
        const old = asString(args.old_str) ?? asString(args.old_string);
        const replacement = asString(args.new_str) ?? asString(args.new_string);
        if (old === null || replacement === null) return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
      }
      case "create":
      case "write_file": {
        const path = string("path", "file_path") ?? "";
        const contents = asString(args.file_text) ?? asString(args.content) ?? asString(args.contents);
        if (contents === null) return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.written(contents, path) });
      }
      case "apply_patch": {
        const patch = raw ?? string("input", "patch") ?? "";
        const edit = ShellCommandClassifier.editFromPatch(patch);
        return edit === null ? make("edit", "") : make(edit.kind, edit.target, edit.detail);
      }
      case "grep":
      case "rg":
      case "glob": {
        const pattern = string("pattern", "query") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "web_fetch":
      case "fetch":
        return make("web", string("url") ?? "");
      case "web_search":
        return make("web", string("query", "q") ?? "");
      case "task": {
        const prompt = string("prompt") ?? "";
        const target = string("description", "name") ?? firstLine(prompt);
        return make("agent", target, prompt.length > 0 ? { type: "text", text: Array.from(prompt).slice(0, 2_000).join("") } : { type: "none" });
      }
      case "update_todo":
      case "todo_write": {
        const todos = (asArray(args.todos) ?? []).filter(isObject);
        if (todos.length === 0) break;
        const steps: ChatPlanStep[] = todos.map((todo) => ({ text: asString(todo.content) ?? asString(todo.title) ?? "", status: planStatus(todo.status) }));
        return make("plan", steps.find((step) => step.status === "inProgress")?.text ?? "", { type: "plan", steps });
      }
      default:
        break;
    }
    let target = "";
    for (const key of ["description", "intent", "command", "path", "pattern", "query", "url", "prompt"]) {
      const found = asString(args[key]);
      if (found !== null && found.length > 0) {
        target = firstLine(found);
        break;
      }
    }
    if (target.length === 0 && raw !== null) target = firstLine(raw);
    return toolCall(id, { other: otherToolName(shown.length === 0 ? "tool" : shown) }, name, target, { time });
  }

  /** An id for an item the log gives none: its event's id when known, else from where its line is, else a count. */
  private nextID(prefix: string, eventID: string | null = null): string {
    if (eventID !== null && eventID.length > 0) return `copilot-${prefix}-${eventID}`;
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `copilot-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `copilot-${prefix}-${this.serial}`;
  }
}
