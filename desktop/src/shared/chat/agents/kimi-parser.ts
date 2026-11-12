// Reads a Kimi Code CLI session's main agent wire,
// `~/.kimi-code/sessions/<workspace>/<session id>/agents/main/wire.jsonl` (MoonshotAI/kimi-code at
// 27bd9ba; docs/en/configuration/data-locations.md:73-83). One record per line, `{"type", …payload,
// "time"}` with the payload spread at the top level and `time` in milliseconds; the file opens with
// `{"type":"metadata","protocol_version","min_protocol_version","created_at"}`
// (packages/agent-core-v2/docs/wire-manifest.d.ts:1-20, src/wire/record.ts:44-67).
//
// Shown:
// - the user's message: `context.append_message` with `message.role` "user" and `message.origin.kind` "user"
//   (src/agent/contextMemory/types.ts:10-16; one sent while Kimi works, `origin.inTurn`, goes in the
//   running turn), its text parts less the hook and skill parts Kimi adds (`meta.source`,
//   contextMemory/hookParts.ts:3, human/agent/origin.ts:4), its pictures (`image_url`) as attachments;
//   a slash skill or plugin command shown as the user typed it, `/<name> <args>` (turnEvents.ts:98-105);
// - Kimi's reply: the loop events of `context.append_loop_event` (contextMemory/loopEventFold.ts:20-79):
//   `content.part` with a whole `text` block (markdown) or `think` block (the thinking row; one hidden or
//   only encrypted is skipped), `tool.call` (`toolCallId`, `name`, `args`) and its `tool.result`
//   (`output` text or parts, `isError`), written when each step ends (agent/loop/loopService.ts:1640-1653);
// - the turn's end: `turn.ended` (wire-manifest.d.ts:901-952): `completed` or `blocked` ends it with its
//   `durationMs`, `cancelled` is the Interrupted row, `failed` shows its error's message then ends it;
// - compaction (`context.apply_compaction`) as the compaction row.
// - An assistant or tool message written whole (`context.append_message`, roles "assistant" and "tool",
//   as wire 1.0 wrote tool calls with `function: {name, arguments}`, wire/migration/v1.1.ts) shows the same way.
//
// The session's folder: `profile.bind` / `config.update` `environmentDisclosure.cwd`
// (wire-manifest.d.ts:119-134, 575-592). Skipped and counted: every other record type the manifest lists
// (69, plus the legacy ones kimi-code's vis reader keeps, apps/vis/server/src/lib/agent-record-types.ts:111-151),
// the user's `!` shell lines, injections, reminders, task and cron prompts. A newer wire (`protocol_version`
// major other than 1, or a `min_protocol_version` above 1.5, Kimi's own reader rule,
// wire/migration/migration.ts:20-39) makes every line after its metadata unknown, so Chat says the
// format is not recognised rather than guess.

import { firstLine, LineResult, otherToolName, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { attachment, bashDetail, searchDetail, toolCall, toolOutput, userMessage, type ChatAttachment, type ChatToolCall, type ChatToolDetail, type ChatToolKind, type TranscriptEvent } from "../model";
import { asArray, asObject, asString, ChatDiffMaker, ChatJSON, isObject, type JSONObject } from "../tools";

/** The wire version this reader knows (Kimi Code's WIRE_PROTOCOL_VERSION at 27bd9ba). */
export const kimiWireVersion = "1.5";

/** Record types that never show anything (the manifest's index and the legacy kinds). */
const quietTypes = new Set([
  "changeNotifier.snapshot",
  "context.clear",
  "context.undo",
  "cron.add",
  "cron.cursor",
  "cron.delete",
  "environment.set_binding",
  "file_history.checkpoint",
  "file_history.tracked",
  "forked",
  "full_compaction.begin",
  "full_compaction.cancel",
  "full_compaction.complete",
  "goal.clear",
  "goal.create",
  "goal.update",
  "interaction.request",
  "interaction.resolved",
  "interruptionReminder.recorded",
  "llm.request",
  "llm.tools_snapshot",
  "mcp.server_failed",
  "mcp.server_failure_resolved",
  "mcp.tools_discovered",
  "permission.record_approval_result",
  "permission.set_mode",
  "plan_mode.cancel",
  "plan_mode.enter",
  "plan_mode.exit",
  "plan.revision",
  "plugin.session_start",
  "prompt.aborted",
  "prompt.accepted",
  "prompt.completed",
  "prompt.steered",
  "subagent.cancelled",
  "subagent.completed",
  "subagent.failed",
  "subagent.spawned",
  "subagent.started",
  "swarm_mode.enter",
  "swarm_mode.exit",
  "task.started",
  "task.terminated",
  "task.waitDelivered",
  "token_counting.measured",
  "token_counting.rebased",
  "token_counting.truncated",
  "token_counting.turn_recorded",
  "tool_select.initialized",
  "tool_select.tools_changed",
  "tools.register_user_tool",
  "tools.reset_active_tools",
  "tools.set_active_tools",
  "tools.unregister_user_tool",
  "tools.update_store",
  "tower_mode.enter",
  "tower_mode.exit",
  "turn.cancel",
  "turn.prompt",
  "turn.steer",
  "turn.step.interrupted",
  "turn.step.retrying",
  "usage.record",
  "context.update_token_count",
  "micro_compaction.apply",
  "staleGuard.recorded",
  "staleGuard.cleared",
  "agent.switched",
  "agent.message.appended",
  "agent.turn.started",
  "agent.turn.ended",
]);

/** Text parts Kimi adds to the user's message that the user did not type (their `meta.source`). */
const addedSources = new Set(["user prompt submit hook", "skill activation"]);

const blank = (text: string): boolean => text.trim().length === 0;

/** "1.5" → [1, 5]; null when it is not dotted digits. */
function versionParts(value: unknown): number[] | null {
  if (typeof value !== "string" || !/^\d+(\.\d+)*$/.test(value)) return null;
  return value.split(".").map(Number);
}

/** a < b: negative; equal: 0; a > b: positive (missing parts are 0, as Kimi's compareWireVersions). */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether this reader may read a wire whose metadata says `protocol` and `minimum`: a 1.x wire whose
 * minimum reader version (when given) is at most this reader's.
 */
export function kimiWireReadable(protocol: unknown, minimum: unknown): boolean {
  const written = versionParts(protocol);
  if (written === null || written[0] !== 1) return false;
  if (minimum === undefined) return true;
  const needs = versionParts(minimum);
  return needs !== null && compareVersions(needs, versionParts(kimiWireVersion)!) <= 0;
}

/** A record's `time` in seconds since 1970 (Kimi writes milliseconds; a small value is seconds, its own normalizeTimestampMs). */
export function kimiTime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? value / 1_000 : value;
}

/** An absolute folder of at most 4,096 bytes with no control characters, its trailing slash dropped; else null. */
function usableFolder(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || new TextEncoder().encode(value).length > 4_096) return null;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return null;
  }
  let folder = value;
  while (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
  return folder;
}

/** A picture's media type from its URL: `blobref:<mime>;<hash>` (Kimi's blob store) or `data:<mime>;base64,…`. */
function pictureType(url: string | null): string | null {
  if (url === null) return null;
  const match = /^(?:blobref|data):([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)[;,]/.exec(url);
  return match === null ? null : match[1]!;
}

export class KimiWireParser {
  /** Where the line being read starts in the file, when the caller knows: ids are made from it. */
  private offset: number | null = null;
  private idsInLine = 0;
  private serial = 0;
  /** The session's working folder, once a `profile.bind` or `config.update` line gave it. */
  cwd: string | null = null;
  /** A newer wire's metadata was read: every later line is unknown. */
  private refused: string | null = null;

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  get lineOffset(): number | null {
    return this.offset;
  }

  clone(): KimiWireParser {
    const copy = new KimiWireParser();
    copy.serial = this.serial;
    copy.cwd = this.cwd;
    copy.refused = this.refused;
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const record = ChatJSON.object(line);
    if (record === null) return LineResult.malformed();
    const type = asString(record.type);
    if (type === null) return LineResult.malformed();
    if (this.refused !== null) return LineResult.unknown(this.refused);
    const time = kimiTime(record.time);
    switch (type) {
      case "metadata": {
        if (kimiWireReadable(record.protocol_version, record.min_protocol_version)) return LineResult.skipped("metadata");
        this.refused = `kimi wire ${asString(record.protocol_version) ?? "?"}`;
        return LineResult.unknown(this.refused);
      }
      case "profile.bind":
      case "config.update": {
        const folder = usableFolder(asObject(record.environmentDisclosure)?.cwd);
        if (folder !== null) this.cwd = folder;
        return LineResult.skipped(type);
      }
      case "context.append_message":
        return this.message(asObject(record.message), time);
      case "context.append_loop_event":
        return this.loopEvent(asObject(record.event), time);
      case "context.apply_compaction":
        return LineResult.events([{ type: "notice", notice: { id: this.nextID("compacted"), kind: "compacted", time }, endsTurn: false }]);
      case "turn.ended":
        return this.turnEnded(record, time);
      default:
        return quietTypes.has(type) ? LineResult.skipped(type) : LineResult.unknown(type);
    }
  }

  // MARK: whole messages

  private message(message: JSONObject | null, time: number | null): TranscriptLineResult {
    if (message === null) return LineResult.malformed();
    const role = asString(message.role);
    switch (role) {
      case "user":
        return this.user(message, time);
      case "assistant":
        return this.assistant(message, time);
      case "tool": {
        const id = asString(message.toolCallId);
        if (id === null || id.length === 0) return LineResult.skipped("tool");
        const output = toolOutput(ChatJSON.text(message.content), { isError: ChatJSON.bool(message.isError) });
        return LineResult.events([{ type: "toolFinished", id, output, time }]);
      }
      case "system":
        return LineResult.skipped("system");
      default:
        return LineResult.unknown(`message ${role ?? "?"}`);
    }
  }

  private user(message: JSONObject, time: number | null): TranscriptLineResult {
    const origin = asObject(message.origin);
    const kind = origin === null ? "user" : asString(origin.kind);
    if (kind === "compaction_summary") return LineResult.skipped("compaction_summary");
    let said: string;
    const pictures: ChatAttachment[] = [];
    const parts = asArray(message.content) ?? [];
    if (kind === "skill_activation" || kind === "plugin_command") {
      // The user's `/name args`, never the skill's or command's body Kimi put in the message.
      if (asString(origin?.trigger) !== "user-slash") return LineResult.skipped(kind);
      const name = asString(kind === "skill_activation" ? origin?.skillName : origin?.commandName) ?? "";
      const args = asString(kind === "skill_activation" ? origin?.skillArgs : origin?.commandArgs) ?? "";
      if (name.length === 0) return LineResult.skipped(kind);
      said = `/${name}` + (args.length > 0 ? ` ${args}` : "");
    } else if (kind === "user") {
      const texts: string[] = [];
      for (const part of parts.filter(isObject)) {
        if (part.type === "text") {
          const source = asString(asObject(part.meta)?.source);
          if (source !== null && addedSources.has(source)) continue;
          texts.push(asString(part.text) ?? "");
        } else if (part.type === "image_url") {
          pictures.push(attachment(null, pictureType(asString(asObject(part.imageUrl)?.url))));
        }
      }
      said = texts.join("");
      // A wire that names no origin (older ones) never shows a reminder Kimi wrote as the user's.
      if (origin === null && said.trimStart().startsWith("<system")) return LineResult.skipped("reminder");
    } else {
      return LineResult.skipped(`user ${kind ?? "?"}`);
    }
    said = said.trim();
    if (said.length === 0 && pictures.length === 0) return LineResult.skipped("user");
    const queued = origin !== null && origin.inTurn === true;
    const event: TranscriptEvent = { type: "userMessage", message: userMessage(this.nextID("prompt"), said, time, pictures), ...(queued ? { queued: true } : {}) };
    return LineResult.events([event]);
  }

  private assistant(message: JSONObject, time: number | null): TranscriptLineResult {
    const events: TranscriptEvent[] = [];
    for (const part of (asArray(message.content) ?? []).filter(isObject)) events.push(...this.part(part, time));
    for (const call of (asArray(message.toolCalls) ?? []).filter(isObject)) {
      const id = asString(call.id);
      if (id === null || id.length === 0) continue;
      // Wire 1.0 kept the name and arguments under `function`.
      const fn = asObject(call.function);
      const name = asString(call.name) ?? asString(fn?.name) ?? "tool";
      const args = call.arguments !== undefined ? call.arguments : fn?.arguments;
      events.push({ type: "toolStarted", call: KimiWireParser.call(id, name, args, time) });
    }
    return LineResult.of(events, "assistant");
  }

  // MARK: loop events

  private loopEvent(event: JSONObject | null, time: number | null): TranscriptLineResult {
    if (event === null) return LineResult.malformed();
    const type = asString(event.type);
    switch (type) {
      case "step.begin":
      case "step.end":
        return LineResult.skipped(type);
      case "content.part": {
        const part = asObject(event.part);
        return part === null ? LineResult.skipped(type) : LineResult.of(this.part(part, time), type);
      }
      case "tool.call": {
        const id = asString(event.toolCallId);
        if (id === null || id.length === 0) return LineResult.skipped(type);
        return LineResult.events([{ type: "toolStarted", call: KimiWireParser.call(id, asString(event.name) ?? "tool", event.args, time) }]);
      }
      case "tool.result": {
        const id = asString(event.toolCallId);
        const result = asObject(event.result);
        if (id === null || id.length === 0 || result === null) return LineResult.skipped(type);
        const output = toolOutput(ChatJSON.text(result.output), { isError: ChatJSON.bool(result.isError) });
        return LineResult.events([{ type: "toolFinished", id, output, time }]);
      }
      default:
        return LineResult.unknown(`loop ${type ?? "?"}`);
    }
  }

  /** A text block (the reply, markdown) or a think block (the thinking row); nothing for a blank, hidden or encrypted-only one. */
  private part(part: JSONObject, time: number | null): TranscriptEvent[] {
    if (part.type === "text") {
      const text = asString(part.text) ?? "";
      return blank(text) ? [] : [{ type: "agentText", text: { id: this.nextID("text"), markdown: text, time } }];
    }
    if (part.type === "think") {
      const text = asString(part.think) ?? "";
      if (part.hidden === true || blank(text)) return [];
      return [{ type: "agentProgress", text: { id: this.nextID("thought"), markdown: text, time } }];
    }
    return [];
  }

  /** What a call is, from Kimi Code's tool name and its arguments (an object, or JSON text). */
  static call(id: string, name: string, rawArgs: unknown, time: number | null): ChatToolCall {
    const parsed = typeof rawArgs === "string" ? ChatJSON.value(rawArgs) : rawArgs;
    const args = asObject(parsed) ?? {};
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = asString(args[key]);
        if (value !== null && value.length > 0) return value;
      }
      return null;
    };
    const make = (kind: ChatToolKind, target: string, detail: ChatToolDetail = { type: "none" }): ChatToolCall => toolCall(id, kind, name, target, { detail, time });
    switch (name) {
      case "Read":
      case "ReadMediaFile":
        return make("read", string("path", "file_path") ?? "");
      case "Bash": {
        const command = string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "Grep":
      case "Glob": {
        const pattern = string("pattern") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "Edit": {
        const path = string("path", "file_path") ?? "";
        const old = asString(args.old_string);
        const replacement = asString(args.new_string);
        if (old === null || replacement === null) return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
      }
      case "Write": {
        const path = string("path", "file_path") ?? "";
        const content = asString(args.content);
        if (content === null || args.mode === "append") return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
      }
      case "FetchURL":
        return make("web", string("url") ?? "");
      case "WebSearch":
        return make("web", string("query") ?? "");
      case "Agent":
        return make("agent", firstLine(string("description", "prompt") ?? ""));
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

  // MARK: the turn's end

  private turnEnded(record: JSONObject, time: number | null): TranscriptLineResult {
    const ms = ChatJSON.double(record.durationMs);
    const duration = ms === null || ms < 0 ? null : ms / 1_000;
    switch (asString(record.reason)) {
      case "cancelled":
        return LineResult.events([{ type: "notice", notice: { id: this.nextID("stopped"), kind: "interrupted", time }, endsTurn: true }]);
      case "failed": {
        const message = asString(asObject(record.error)?.message);
        const events: TranscriptEvent[] = [];
        if (message !== null && !blank(message)) events.push({ type: "agentText", text: { id: this.nextID("error"), markdown: `Error: ${message}`, time } });
        events.push({ type: "turnCompleted", time, duration });
        return LineResult.events(events);
      }
      case "completed":
      case "blocked":
        return LineResult.events([{ type: "turnCompleted", time, duration }]);
      default:
        return LineResult.skipped("turn.ended");
    }
  }

  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `kimi-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `kimi-${prefix}-${this.serial}`;
  }
}
