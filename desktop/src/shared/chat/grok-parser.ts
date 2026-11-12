// Reads a Grok Build session's timeline,
// `~/.grok/sessions/<cwd>/<id>/updates.jsonl` (Grok 1.0.70): one Agent Client
// Protocol `session/update` notification (or xAI's `_x.ai/session/update`) per
// line, `{timestamp, method, params: {sessionId, update: {sessionUpdate:
// <kind>, …}, _meta: {agentTimestampMs, turnStartMs, …}}}`, appended while
// Grok works. A port of HerdrKit's GrokSessionParser.swift.
//
// A line's time is `_meta.agentTimestampMs` (milliseconds),
// else its `timestamp` by size (Grok 1.0.70 writes Unix seconds; below
// 100,000,000,000 it is seconds, at or above milliseconds). A running turn's
// lines carry `_meta.turnStartMs`: when the window begins inside that turn (your
// message not read), the turn counts from it (`turnBegan`).
//
// Shown: your prompt (`user_message_chunk`: text, pictures; the parts of one
// prompt share `_meta.promptIndex` and make one message), Grok's reply
// (`agent_message_chunk`, its parts joined into one message while no other line
// that shows comes between them), its thinking (`agent_thought_chunk`, the
// thinking row), tool calls (`tool_call`, then `tool_call_update` by
// `toolCallId`), plan entries, the turn's end (`turn_completed`; a cancelled
// turn as "Interrupted"), compaction (`auto_compact_completed`) and background
// tasks (running until their `task_completed`). Skipped: hooks, hook notes, the
// background task list, recaps, retries, image compression, memory "dreams",
// the compaction's start and checkpoint, the protocol's command and mode lists.

import { firstLine, LineResult, otherToolName, planStatus, type TranscriptLineResult } from "./claude-parser";
import { CodexRolloutParser } from "./codex-parser";
import { minimumLineLength } from "./line-scan";
import {
  attachment,
  bashDetail,
  searchDetail,
  toolCall,
  toolOutput,
  userMessage,
  type ChatAttachment,
  type ChatToolCall,
  type ChatToolKind,
  type ChatToolOutput,
  type ChatUserMessage,
  type TranscriptEvent,
} from "./model";
import { asObject, asString, ChatAttachmentText, ChatDiffMaker, ChatJSON, objects, type JSONObject } from "./tools";

/** Kinds that never show anything. */
const skippedKinds = new Set([
  "hook_execution",
  "hook_annotation",
  "background_tasks",
  "auto_compact_started",
  "compaction_checkpoint",
  "session_recap",
  "retry_state",
  "image_compressed",
  "available_commands_update",
  "current_mode_update",
  "usage_update",
  "config_option_update",
  "session_info_update",
]);

/** Calls kept to revise and finish. */
const keptCalls = 512;
/** A shorter string is never a picture's payload (line-scan's own bound). */
const minimumPayloadLength = 1_024;
/** A time field below this is seconds; at or above it, milliseconds. */
const secondsBelow = 100_000_000_000;

const nonEmpty = (value: unknown): string | null => {
  const text = asString(value);
  return text !== null && text.length > 0 ? text : null;
};

/**
 * What a parser that began inside the session read first: the reply's (or the
 * thinking's) run its first shown line began, before any other line showed (`run`, null when another
 * line showed first), and the blank parts it skipped before it. At a history seam, a part that ended
 * inside a run of the same kind takes that run in (TranscriptParser.seam). A reply
 * whose parts before any shown line were blank only is that run too (its blank parts kept), even when
 * nothing of it showed.
 */
export interface GrokSeamOpening {
  run: string | null;
  thinking: boolean;
  blank: string;
}

export class GrokSessionParser {
  private serial = 0;
  private offset: number | null = null;
  private idsInLine = 0;
  /** Grok's lines name no working folder: its summary.json's (TranscriptParser.carryFolder). */
  cwd: string | null = null;
  private textRun: string | null = null;
  private thoughtRun: string | null = null;
  private runShown = new Set<string>();
  /** Your prompt being written in parts (`promptIndex`): its text so far, unchanged, and its pictures, in order. */
  private prompt: { index: number; message: ChatUserMessage; raw: string; pictures: readonly ChatAttachment[] } | null = null;
  private calls = new Map<string, ChatToolCall>();
  private backgrounded = new Set<string>();
  private taskCalls = new Map<string, string>();
  private opening: GrokSeamOpening = { run: null, thinking: false, blank: "" };
  /** Whether a line has shown something yet (the opening is known). */
  private openingSettled = false;

  get lineOffset(): number | null {
    return this.offset;
  }

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  clone(): GrokSessionParser {
    const copy = new GrokSessionParser();
    copy.serial = this.serial;
    copy.offset = this.offset;
    copy.idsInLine = this.idsInLine;
    copy.cwd = this.cwd;
    copy.textRun = this.textRun;
    copy.thoughtRun = this.thoughtRun;
    copy.runShown = new Set(this.runShown);
    copy.prompt = this.prompt;
    copy.calls = new Map(this.calls);
    copy.backgrounded = new Set(this.backgrounded);
    copy.taskCalls = new Map(this.taskCalls);
    copy.opening = { ...this.opening };
    copy.openingSettled = this.openingSettled;
    return copy;
  }

  /** What this parser read first (a copy). */
  get seamOpening(): GrokSeamOpening {
    return { ...this.opening };
  }

  /** The reply's (or the thinking's) run the lines read so far end inside, or null. */
  openRun(thinking: boolean): string | null {
    return thinking ? this.thoughtRun : this.textRun;
  }

  /** The run `from` (begun after a seam) is the earlier part's `into` now: its parts join that row. */
  adoptRun(from: string, into: string): void {
    if (this.textRun === from) this.textRun = into;
    if (this.thoughtRun === from) this.thoughtRun = into;
    // `into` is a row the earlier part shows (also when `from` was blank only).
    this.runShown.add(into);
  }

  /** What is held starts later (a trim): its first run is not at the seam any more. */
  forgetOpening(): void {
    this.opening.run = null;
  }

  parse(line: string): TranscriptLineResult {
    const result = this.parseLine(line);
    if (result.events.length > 0) this.openingSettled = true;
    return result;
  }

  private parseLine(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const params = asObject(object.params);
    const update = asObject(params?.update);
    const kind = asString(update?.sessionUpdate);
    if (params === null || update === null || kind === null) {
      const method = asString(object.method);
      return LineResult.unknown(method === null ? "(no sessionUpdate)" : `(${method} with no update)`);
    }
    const meta = asObject(params._meta);
    const time = GrokSessionParser.lineTime(object);
    if (skippedKinds.has(kind) || kind.startsWith("memory_dream_")) return LineResult.skipped(kind);
    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        return GrokSessionParser.withTurnStart(this.chunk(update, kind === "agent_thought_chunk", time), meta);
      case "user_message_chunk":
        return this.userChunk(update, time);
      case "tool_call":
      case "tool_call_update":
        return GrokSessionParser.withTurnStart(this.endsRuns(this.tool(update, kind === "tool_call", time), kind), meta);
      case "plan":
        return this.endsRuns(this.plan(update, time), kind);
      case "turn_completed": {
        const events: TranscriptEvent[] = [];
        const reason = (asString(update.stop_reason) ?? "").toLowerCase();
        if (reason.startsWith("cancel")) {
          events.push({ type: "notice", notice: { id: this.nextID("interrupted"), kind: "interrupted", time }, endsTurn: false });
        }
        const ms = ChatJSON.double(update.elapsed_ms);
        events.push({ type: "turnCompleted", time, duration: ms === null ? null : ms / 1_000 });
        this.prompt = null;
        return this.endsRuns(events, kind);
      }
      case "auto_compact_completed":
        return this.endsRuns([{ type: "notice", notice: { id: this.nextID("compacted"), kind: "compacted", time }, endsTurn: false }], kind);
      case "task_backgrounded": {
        const callID = nonEmpty(update.tool_call_id);
        if (callID === null) return LineResult.skipped(kind);
        const task = nonEmpty(update.task_id);
        if (task !== null) this.taskCalls.set(task, callID);
        this.backgrounded.add(callID);
        return this.endsRuns([{ type: "toolFinished", id: callID, output: toolOutput("", { isRunning: true }), time }], kind);
      }
      case "task_completed": {
        const snapshot = asObject(update.task_snapshot) ?? {};
        const task = asString(snapshot.task_id);
        const callID = task === null ? undefined : this.taskCalls.get(task);
        if (task === null || callID === undefined) return LineResult.skipped(kind);
        this.backgrounded.delete(callID);
        this.taskCalls.delete(task);
        const code = ChatJSON.int(snapshot.exit_code);
        const killed = ChatJSON.bool(snapshot.explicitly_killed);
        const output = toolOutput(asString(snapshot.output) ?? "", { isError: killed && code === null, exitCode: code });
        return this.endsRuns([{ type: "toolFinished", id: callID, output, time }], kind);
      }
      default:
        return LineResult.unknown(kind);
    }
  }

  /** A line that shows something other than the reply ends the reply's (and the thinking's) run. */
  private endsRuns(events: TranscriptEvent[], kind: string): TranscriptLineResult {
    if (events.length > 0) {
      this.textRun = null;
      this.thoughtRun = null;
    }
    return LineResult.of(events, kind);
  }

  // MARK: text

  private chunk(update: JSONObject, thinking: boolean, time: number | null): TranscriptLineResult {
    const kind = thinking ? "agent_thought_chunk" : "agent_message_chunk";
    const text = asString(asObject(update.content)?.text);
    if (text === null || text.length === 0) return LineResult.skipped(kind);
    let id: string;
    if (thinking) {
      this.textRun = null;
      if (this.thoughtRun === null) this.thoughtRun = this.nextID("thought");
      id = this.thoughtRun;
    } else {
      this.thoughtRun = null;
      if (this.textRun === null) this.textRun = this.nextID("text");
      id = this.textRun;
    }
    // A run's first part with nothing but blank space waits for the next.
    if (!thinking && text.trim().length === 0 && !this.runShown.has(id)) {
      // The run has its identity from its blank part on, so at a seam the blank
      // joins the earlier reply it continues (and the parser reading on continues that reply).
      if (!this.openingSettled) this.opening = { run: id, thinking: false, blank: this.opening.blank + text };
      return LineResult.skipped(kind);
    }
    // The run the first lines began: the first shown one, or the blank-only reply before it.
    if (!this.openingSettled && this.opening.run === null) this.opening = { run: id, thinking, blank: "" };
    this.runShown.add(id);
    if (this.runShown.size > 64) this.runShown = new Set([id]);
    this.prompt = null;
    return LineResult.events([{ type: "agentTextChunk", text: { id, markdown: text, time }, progress: thinking }]);
  }

  private userChunk(update: JSONObject, time: number | null): TranscriptLineResult {
    const content = asObject(update.content) ?? {};
    const index = ChatJSON.int(asObject(update._meta)?.promptIndex);
    const amended = index !== null && this.prompt !== null && this.prompt.index === index;
    const base = amended ? this.prompt!.message : userMessage(index === null ? this.nextID("prompt") : `grok-prompt-${index}`, "", time);
    // The parts join in order with nothing added, and markers and paths come out of the whole text.
    let raw = amended ? this.prompt!.raw : "";
    let pictures = amended ? this.prompt!.pictures : [];
    switch (asString(content.type)) {
      case "text":
        raw += asString(content.text) ?? "";
        break;
      case "image":
        pictures = [...pictures, attachment(null, nonEmpty(content.mimeType))];
        break;
      default:
        return LineResult.skipped("user_message_chunk");
    }
    const extracted = ChatAttachmentText.extract(raw);
    // "[Image #1]" in the text: a place for each picture not read yet; the pictures take the places in order.
    const places = Math.max(extracted.imageMarkers, pictures.length);
    const attachments: ChatAttachment[] = [];
    for (let place = 0; place < places; place += 1) attachments.push(pictures[place] ?? attachment());
    const message = userMessage(base.id, extracted.text, base.time, [...attachments, ...extracted.attachments]);
    this.textRun = null;
    this.thoughtRun = null;
    this.prompt = index === null ? null : { index, message, raw, pictures };
    if (message.text.length === 0 && message.attachments.length === 0) return LineResult.skipped("user_message_chunk");
    return LineResult.events([amended ? { type: "userMessageAmended", message } : { type: "userMessage", message }]);
  }

  // MARK: tools

  private tool(update: JSONObject, isStart: boolean, time: number | null): TranscriptEvent[] {
    const id = nonEmpty(update.toolCallId);
    if (id === null) return [];
    const events: TranscriptEvent[] = [];
    const xai = asObject(asObject(update._meta)?.["x.ai/tool"]);
    // A diff in the content (a completed edit's, without kind, title or input) revises the call too.
    const describes = "kind" in update || "rawInput" in update || "title" in update || GrokSessionParser.hasDiff(update);
    if (isStart || describes) {
      const held = this.calls.get(id) ?? null;
      const call = GrokSessionParser.call(id, update, xai, held, held?.time ?? time);
      this.keep(call);
      // think's first line has no todos yet: its row waits for them.
      const waitsForTodos = call.kind === "plan" && (call.detail.type !== "plan" || call.detail.steps.length === 0);
      if (!waitsForTodos) events.push(held === null && isStart ? { type: "toolStarted", call } : { type: "toolRevised", call });
    }
    const status = asString(update.status);
    if (status === "completed" || status === "failed") {
      let output = GrokSessionParser.output(update, status === "failed");
      if (this.backgrounded.has(id) && status === "completed") output = { ...output, isRunning: true };
      events.push({ type: "toolFinished", id, output, time });
    }
    return events;
  }

  private keep(call: ChatToolCall): void {
    if (!this.calls.has(call.id) && this.calls.size >= keptCalls) {
      const oldest = this.calls.keys().next().value;
      if (oldest !== undefined) this.calls.delete(oldest);
    }
    this.calls.set(call.id, call);
  }

  /** What a call is, from its `kind` (or the tool's own) and its input, over what an earlier line of it said. */
  static call(id: string, update: JSONObject, xai: JSONObject | null, held: ChatToolCall | null, time: number | null): ChatToolCall {
    const input = asObject(update.rawInput) ?? {};
    const title = nonEmpty(update.title);
    const name = nonEmpty(xai?.name) ?? held?.toolName ?? "tool";
    const label = nonEmpty(xai?.label);
    // A completed edit names no kind; its diff says it is an edit.
    const kind = asString(update.kind) ?? asString(xai?.kind) ?? (GrokSessionParser.hasDiff(update) ? "edit" : "");
    const locations = (objects(update.locations) ?? []).map((location) => asString(location.path)).filter((path): path is string => path !== null);
    const string = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = nonEmpty(input[key]);
        if (value !== null) return value;
      }
      return null;
    };
    const make = (toolKind: ChatToolKind, target: string, detail: ChatToolCall["detail"] = { type: "none" }): ChatToolCall =>
      toolCall(id, toolKind, name, target, { detail, time });
    switch (kind) {
      case "read":
        return make("read", string("target_file", "file_path", "path") ?? locations[0] ?? held?.target ?? title ?? "");
      case "execute": {
        const command = string("command", "cmd");
        if (command === null) return held ?? make("bash", title ?? "", { type: "bash", bash: bashDetail(title ?? "") });
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        return call.kind === "bash" && call.detail.type !== "bash" ? { ...call, detail: { type: "bash", bash: bashDetail(command) } } : call;
      }
      case "search": {
        const backend = ChatJSON.bool(input.backend) || ChatJSON.bool(asObject(update._meta)?.backend);
        if (backend) return make("web", string("query", "q") ?? title ?? held?.target ?? "");
        const pattern = string("pattern", "query", "glob_pattern") ?? held?.target ?? title ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "edit": {
        const diffs = (objects(update.content) ?? []).filter((block) => block.type === "diff");
        const path = string("file_path", "target_file", "path") ?? asString(diffs[0]?.path) ?? locations[0] ?? held?.target ?? title ?? "";
        if (diffs.length > 0) {
          const edits = diffs.map((block) => ({ old: asString(block.oldText) ?? "", new: asString(block.newText) ?? "" }));
          if (edits.length === 1 && edits[0]!.old.length === 0) return make("edit", path, { type: "diff", diff: ChatDiffMaker.written(edits[0]!.new, path) });
          return make("edit", path, {
            type: "diff",
            diff: edits.length === 1 ? ChatDiffMaker.replacement(edits[0]!.old, edits[0]!.new, path) : ChatDiffMaker.replacements(edits, path),
          });
        }
        const content = asString(input.content);
        if (content !== null) return make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
        const old = string("old_string", "old_str");
        const replacement = asString(input.new_string) ?? asString(input.new_str);
        if (old !== null && replacement !== null) return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
        if (held !== null && held.kind === "edit" && held.detail.type !== "none") return held;
        return make("edit", path);
      }
      case "fetch":
        return make("web", string("url", "query") ?? title ?? held?.target ?? "");
      case "think": {
        const steps = (objects(input.todos) ?? []).map((todo) => ({ text: asString(todo.content) ?? "", status: planStatus(todo.status) }));
        return make("plan", steps.find((step) => step.status === "inProgress")?.text ?? "", { type: "plan", steps });
      }
      case "":
        return held ?? make({ other: label ?? otherToolName(name) }, title ?? "");
      default: {
        let target = title ?? "";
        for (const key of ["target_directory", "directory", "path", "query", "url", "command", "description", "file_path"]) {
          const value = nonEmpty(input[key]);
          if (value !== null) {
            target = firstLine(value);
            break;
          }
        }
        return make({ other: label ?? otherToolName(name) }, target);
      }
    }
  }

  /** Whether the update's content carries a diff. */
  static hasDiff(update: JSONObject): boolean {
    return (objects(update.content) ?? []).some((block) => block.type === "diff");
  }

  /** A finished call's result: its content's text, else the text its raw output holds. */
  static output(update: JSONObject, failed: boolean): ChatToolOutput {
    let texts = (objects(update.content) ?? [])
      .filter((block) => block.type === "content")
      .map((block) => asString(asObject(block.content)?.text))
      .filter((text): text is string => text !== null);
    const raw = asObject(update.rawOutput);
    if (texts.length === 0 && raw !== null) {
      const type = asString(raw.type) ?? "";
      const value = raw[type];
      if (typeof value === "string") texts = [value];
      else {
        const inner = asObject(value);
        if (inner !== null) {
          for (const key of ["content", "raw_output", "tool_output_for_prompt", "output", "message"]) {
            const text = asString(inner[key]);
            if (text !== null) {
              texts = [text];
              break;
            }
          }
        }
      }
    }
    return toolOutput(texts.join("\n"), { isError: failed });
  }

  // MARK: plan

  private plan(update: JSONObject, time: number | null): TranscriptEvent[] {
    const entries = objects(update.entries) ?? [];
    if (entries.length === 0) return [];
    const steps = entries.map((entry) => ({ text: asString(entry.content) ?? "", status: planStatus(entry.status) }));
    const id = this.nextID("plan");
    const call = toolCall(id, "plan", "plan", steps.find((step) => step.status === "inProgress")?.text ?? "", { detail: { type: "plan", steps }, time });
    return [
      { type: "toolStarted", call },
      { type: "toolFinished", id, output: toolOutput(""), time },
    ];
  }

  // MARK: helpers

  /**
   * A Grok time field by its size, as seconds since 1970: below
   * 100,000,000,000 it is seconds (Grok 1.0.70's `timestamp`, 10 digits), at or
   * above milliseconds (13 digits). Null for none, zero or less.
   */
  static time(value: unknown): number | null {
    const stamp = ChatJSON.double(value);
    if (stamp === null || !(stamp > 0)) return null;
    return stamp < secondsBelow ? stamp : stamp / 1_000;
  }

  /** A line's time: `params._meta.agentTimestampMs` (milliseconds), else its `timestamp` by size. */
  static lineTime(object: JSONObject): number | null {
    const meta = asObject(asObject(object.params)?._meta);
    const ms = ChatJSON.double(meta?.agentTimestampMs);
    if (ms !== null && ms > 0) return ms / 1_000;
    return GrokSessionParser.time(object.timestamp);
  }

  /**
   * A running turn's line that shows something says when its
   * turn began (`_meta.turnStartMs`, milliseconds): the builder takes it for a turn
   * the window began inside (`turnBegan`), after the line's own events.
   */
  private static withTurnStart(result: TranscriptLineResult, meta: JSONObject | null): TranscriptLineResult {
    const ms = ChatJSON.double(meta?.turnStartMs);
    if (result.events.length === 0 || ms === null || !(ms > 0)) return result;
    return { ...result, events: [...result.events, { type: "turnBegan", time: ms / 1_000 }] };
  }

  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `grok-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `grok-${prefix}-${this.serial}`;
  }

  /**
   * A picture you sent is a line of up to a megabyte (`{"type":"image","data":<base64>,…}`);
   * the timeline needs its media type, never its bytes: the `data` of an image block is cut to
   * "" before the parse. Null when there is none.
   */
  static slimmed(line: string): string | null {
    if (line.length < minimumLineLength || !line.includes('"type":"image"')) return null;
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
}
