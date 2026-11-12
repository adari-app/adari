// Reads an OpenCode or Kilo session, one row per line as OpenCodeStoreView lays it out
// (agents/opencode-store.ts: an envelope this app writes, `{"oc","k",…,"cwd","d":<the row's data>}`).
//
// V1 (OpenCode 1.x and Kilo, its fork; opencode v1.18.29 packages/schema/src/v1/session.ts):
// - the user's message: its `text` parts (not `synthetic` or `ignored`: the harness's) and image `file` parts
//   (`mime` image/…), shown whole at the line after them that closes the message (`k: "user"`); a
//   `compaction` part the compaction row;
// - the agent's: `text` its reply, `reasoning` its thinking, `tool` a tool row with its result
//   (`state` completed, or error a failed row; one shown still pending or running did not finish);
//   the message's own line (`k: "msg"`) ends the turn when its `finish` is not `tool-calls` or
//   `unknown` (prompt.ts's loop goes on only for those), or says its `error` (`MessageAbortedError`
//   the user's stop, any other the error's text);
// - a compaction's summary message (`summary: true`) and the step bookkeeping parts (`step-start`,
//   `step-finish`, `snapshot`, `patch`, `agent`, `subtask`, `retry`) are skipped and counted.
// V2 (OpenCode 2.x; opencode 2.2.5 packages/schema/src/session-message.ts), one message per line:
// `user` the user's message (text, image files), `assistant` its `content` (text, reasoning, tool with its
// `content` result) and `error`, `shell` a `!` command's row, `compaction` (completed) the
// compaction row, `idle` the turn's end (`succeeded`, `interrupted` the user's stop, `failed` the error);
// `synthetic`, `system`, `skill` and the switch markers skipped.
// A type neither version has is unknown (the feed's unrecognised-format note); the view's
// placeholders (a row too long or not JSON, one rewritten while read) are skipped and counted.

import { firstLine, LineResult, otherToolName, planStatus, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { attachment, bashDetail, searchDetail, toolCall, toolOutput, userMessage, type ChatAttachment, type ChatToolCall, type ChatToolDetail, type ChatToolKind, type TranscriptEvent } from "../model";
import { asArray, asObject, asString, ChatDiffMaker, ChatJSON, isObject, type JSONObject } from "../tools";

const blank = (text: string): boolean => text.trim().length === 0;

/** Milliseconds as the timeline's seconds. */
const seconds = (value: unknown): number | null => {
  const ms = ChatJSON.double(value);
  return ms === null || !Number.isFinite(ms) || ms <= 0 ? null : ms / 1_000;
};

/** An image attachment of a file part or attachment with an image type; null for any other. */
const picture = (file: JSONObject): ChatAttachment | null => {
  const mime = asString(file.mime);
  return mime !== null && mime.startsWith("image/") ? attachment(null, mime) : null;
};

/** V1 assistant `finish` values after which the loop asks the model again (prompt.ts). */
const continues = new Set(["tool-calls", "unknown"]);

const v1Skipped = new Set(["step-start", "step-finish", "snapshot", "patch", "agent", "subtask", "retry"]);
const v2Skipped = new Set(["synthetic", "system", "skill", "agent-switched", "model-switched", "location-switched"]);

export class OpenCodeStoreParser {
  /** The session's folder, as each line's envelope gives it. */
  cwd: string | null = null;
  /** The V1 user message whose parts are being read: its id, text and pictures. */
  private pending: { id: string; text: string[]; pictures: ChatAttachment[] } | null = null;

  clone(): OpenCodeStoreParser {
    const copy = new OpenCodeStoreParser();
    copy.cwd = this.cwd;
    copy.pending = this.pending === null ? null : { id: this.pending.id, text: [...this.pending.text], pictures: [...this.pending.pictures] };
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const version = asString(object.oc);
    const kind = asString(object.k);
    if ((version !== "v1" && version !== "v2") || kind === null) return LineResult.unknown("opencode line");
    if (kind === "bad") return LineResult.skipped(`opencode ${asString(object.bad) ?? "row"}`);
    const cwd = asString(object.cwd);
    if (cwd !== null && cwd.length > 0) this.cwd = cwd;
    const time = seconds(object.t);
    if (version === "v1") {
      switch (kind) {
        case "part": {
          const data = asObject(object.d);
          if (data === null) return LineResult.malformed();
          return this.v1Part(asString(object.id) ?? "", asString(object.mid) ?? "", asString(object.role) ?? "", data);
        }
        case "user":
          return this.v1User(asString(object.id) ?? "", time);
        case "msg": {
          const data = asObject(object.d);
          if (data === null) return LineResult.malformed();
          return asString(object.role) === "summary" ? LineResult.skipped("summary") : this.v1Assistant(asString(object.id) ?? "", data, time);
        }
        default:
          return LineResult.unknown(`opencode ${kind}`);
      }
    }
    if (kind !== "msg") return LineResult.unknown(`opencode ${kind}`);
    const data = asObject(object.d);
    if (data === null) return LineResult.malformed();
    return this.v2Message(asString(object.id) ?? "", asString(data.type) ?? "", data, time);
  }

  // MARK: V1

  private v1Part(id: string, message: string, role: string, part: JSONObject): TranscriptLineResult {
    const type = asString(part.type) ?? "";
    if (role === "user") {
      if (type === "compaction") return LineResult.events([{ type: "notice", notice: { id: `opencode-${id}`, kind: "compacted", time: null }, endsTurn: false }]);
      if (type !== "text" && type !== "file") return v1Skipped.has(type) ? LineResult.skipped(type) : LineResult.unknown(`part ${type}`);
      if (this.pending === null || this.pending.id !== message) this.pending = { id: message, text: [], pictures: [] };
      if (type === "text") {
        const text = asString(part.text) ?? "";
        if (ChatJSON.bool(part.synthetic) || ChatJSON.bool(part.ignored)) return LineResult.skipped("synthetic");
        if (!blank(text)) this.pending.text.push(text);
      } else {
        const shown = picture(part);
        if (shown !== null) this.pending.pictures.push(shown);
      }
      return LineResult.skipped("user part");
    }
    if (role === "summary") return LineResult.skipped("summary part");
    switch (type) {
      case "text": {
        const text = asString(part.text) ?? "";
        if (blank(text) || ChatJSON.bool(part.ignored)) return LineResult.skipped("text");
        return LineResult.events([{ type: "agentText", text: { id: `opencode-${id}`, markdown: text, time: seconds(asObject(part.time)?.end) } }]);
      }
      case "reasoning": {
        const text = asString(part.text) ?? "";
        if (blank(text)) return LineResult.skipped("reasoning");
        return LineResult.events([{ type: "agentProgress", text: { id: `opencode-${id}`, markdown: text, time: seconds(asObject(part.time)?.start) } }]);
      }
      case "tool": {
        const state = asObject(part.state) ?? {};
        const name = asString(part.tool) ?? "tool";
        const callID = `opencode-${id}`;
        const times = asObject(state.time);
        const call = OpenCodeStoreParser.call(callID, name, asObject(state.input) ?? {}, seconds(times?.start));
        const metadata = asObject(state.metadata);
        const exitCode = ChatJSON.int(metadata?.exit);
        const status = asString(state.status);
        const output =
          status === "completed"
            ? toolOutput(asString(state.output) ?? "", { exitCode })
            : status === "error"
              ? toolOutput(asString(state.error) ?? "Failed", { isError: true, exitCode })
              : toolOutput("Did not finish", { isError: true });
        return LineResult.events([
          { type: "toolStarted", call },
          { type: "toolFinished", id: callID, output, time: seconds(times?.end) },
        ]);
      }
      case "file": {
        // A picture a tool or the model made: no row of its own in Chat.
        return LineResult.skipped("file");
      }
      case "compaction":
        return LineResult.skipped("compaction");
      default:
        return v1Skipped.has(type) ? LineResult.skipped(type) : LineResult.unknown(`part ${type}`);
    }
  }

  private v1User(id: string, time: number | null): TranscriptLineResult {
    const pending = this.pending !== null && this.pending.id === id ? this.pending : null;
    this.pending = null;
    if (pending === null || (pending.text.length === 0 && pending.pictures.length === 0)) return LineResult.skipped("user");
    return LineResult.events([{ type: "userMessage", message: userMessage(`opencode-${id}`, pending.text.join("\n\n"), time, pending.pictures) }]);
  }

  private v1Assistant(id: string, message: JSONObject, time: number | null): TranscriptLineResult {
    const ended = seconds(asObject(message.time)?.completed) ?? time;
    const error = asObject(message.error);
    if (error !== null) {
      const name = asString(error.name) ?? "Error";
      if (name === "MessageAbortedError") return LineResult.events([{ type: "notice", notice: { id: `opencode-${id}-stop`, kind: "interrupted", time: ended }, endsTurn: true }]);
      const said = asString(asObject(error.data)?.message) ?? name;
      return LineResult.events([
        { type: "agentText", text: { id: `opencode-${id}-error`, markdown: `Error: ${said}`, time: ended } },
        { type: "agentStopped", time: ended },
      ]);
    }
    const finish = asString(message.finish);
    if (finish === null || continues.has(finish)) return LineResult.skipped("step");
    return LineResult.events([{ type: "agentStopped", time: ended }]);
  }

  // MARK: V2

  private v2Message(id: string, type: string, message: JSONObject, time: number | null): TranscriptLineResult {
    const created = seconds(asObject(message.time)?.created) ?? time;
    switch (type) {
      case "user": {
        const text = asString(message.text) ?? "";
        const pictures = (asArray(message.files) ?? [])
          .filter(isObject)
          .map(picture)
          .filter((shown): shown is ChatAttachment => shown !== null);
        if (blank(text) && pictures.length === 0) return LineResult.skipped("user");
        return LineResult.events([{ type: "userMessage", message: userMessage(`opencode-${id}`, text, created, pictures) }]);
      }
      case "assistant":
        return this.v2Assistant(id, message, created);
      case "shell": {
        const callID = `opencode-${id}`;
        const command = (asString(message.command) ?? "").trim();
        // As Claude Code's `!` command (claude-parser.ts): a Bash row the user ran.
        const call = toolCall(callID, "bash", "!", command, { detail: { type: "bash", bash: bashDetail(command) }, time: created, isUserShell: true });
        const status = asString(message.status);
        const events: TranscriptEvent[] = [{ type: "userShell", call }];
        if (status !== null && status !== "running") {
          const exitCode = ChatJSON.int(message.exit);
          const output = asString(asObject(message.output)?.output) ?? "";
          events.push({
            type: "toolFinished",
            id: callID,
            output: toolOutput(output, { exitCode, isError: status !== "exited" || (exitCode !== null && exitCode !== 0) }),
            time: seconds(asObject(message.time)?.completed),
          });
        }
        return LineResult.events(events);
      }
      case "compaction":
        return asString(message.status) === "completed"
          ? LineResult.events([{ type: "notice", notice: { id: `opencode-${id}`, kind: "compacted", time: created }, endsTurn: false }])
          : LineResult.skipped("compaction");
      case "idle": {
        switch (asString(message.outcome)) {
          case "succeeded":
            return LineResult.events([{ type: "agentStopped", time: created }]);
          case "interrupted":
            return LineResult.events([{ type: "notice", notice: { id: `opencode-${id}`, kind: "interrupted", time: created }, endsTurn: true }]);
          default: {
            const said = asString(asObject(message.error)?.message);
            const events: TranscriptEvent[] = [];
            if (said !== null && !blank(said)) events.push({ type: "agentText", text: { id: `opencode-${id}`, markdown: `Error: ${said}`, time: created } });
            events.push({ type: "agentStopped", time: created });
            return LineResult.events(events);
          }
        }
      }
      default:
        return v2Skipped.has(type) ? LineResult.skipped(type) : LineResult.unknown(type.length === 0 ? "opencode message" : type);
    }
  }

  private v2Assistant(id: string, message: JSONObject, created: number | null): TranscriptLineResult {
    const events: TranscriptEvent[] = [];
    (asArray(message.content) ?? []).filter(isObject).forEach((part, index) => {
      const partID = `opencode-${id}-${index}`;
      switch (asString(part.type)) {
        case "text": {
          const text = asString(part.text) ?? "";
          if (!blank(text)) events.push({ type: "agentText", text: { id: partID, markdown: text, time: created } });
          break;
        }
        case "reasoning": {
          const text = asString(part.text) ?? "";
          if (!blank(text)) events.push({ type: "agentProgress", text: { id: partID, markdown: text, time: created } });
          break;
        }
        case "tool": {
          const state = asObject(part.state) ?? {};
          const times = asObject(part.time);
          const call = OpenCodeStoreParser.call(partID, asString(part.name) ?? "tool", asObject(state.input) ?? {}, seconds(times?.created));
          const said = (asArray(state.content) ?? [])
            .filter(isObject)
            .map((item) => (item.type === "text" ? (asString(item.text) ?? "") : ""))
            .filter((text) => text.length > 0)
            .join("\n");
          const exitCode = ChatJSON.int(asObject(state.metadata)?.exit);
          const status = asString(state.status);
          const output =
            status === "completed"
              ? toolOutput(said, { exitCode })
              : status === "error"
                ? toolOutput(asString(asObject(state.error)?.message) ?? (said.length > 0 ? said : "Failed"), { isError: true, exitCode })
                : toolOutput("Did not finish", { isError: true });
          events.push({ type: "toolStarted", call }, { type: "toolFinished", id: partID, output, time: seconds(times?.completed) });
          break;
        }
        default:
          break;
      }
    });
    // The user's stop is the `idle` line's (interrupted); any other error is said here.
    const error = asObject(message.error);
    const errorType = (asString(error?.type) ?? "").toLowerCase();
    const said = asString(error?.message);
    if (error !== null && said !== null && !blank(said) && !errorType.includes("abort") && !errorType.includes("interrupt")) {
      events.push({ type: "agentText", text: { id: `opencode-${id}-error`, markdown: `Error: ${said}`, time: seconds(asObject(message.time)?.completed) ?? created } });
    }
    return LineResult.of(events, "assistant");
  }

  // MARK: tools

  /** What a call is, from OpenCode's tool name (V1 and V2 names) and its input. */
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
      case "bash":
      case "shell": {
        const command = string("command") ?? "";
        const call = CodexRolloutParser.commandCall(id, name, command, time);
        if (call.kind === "bash" && call.detail.type !== "bash") return { ...call, detail: { type: "bash", bash: bashDetail(command) } };
        return call;
      }
      case "read":
        return make("read", string("filePath", "path") ?? "");
      case "write": {
        const path = string("filePath", "path") ?? "";
        const content = asString(input.content);
        return content === null ? make("edit", path) : make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
      }
      case "edit": {
        const path = string("filePath", "path") ?? "";
        const old = asString(input.oldString);
        const replacement = asString(input.newString);
        if (old === null || replacement === null) return make("edit", path);
        return make("edit", path, { type: "diff", diff: ChatDiffMaker.replacement(old, replacement, path) });
      }
      case "apply_patch":
      case "patch": {
        const diff = ChatDiffMaker.patch(string("patchText") ?? "");
        if (diff === null) return make("edit", "");
        return make("edit", diff.files[0] ?? "", { type: "diff", diff });
      }
      case "glob":
      case "grep": {
        const pattern = string("pattern") ?? "";
        return make("search", pattern, { type: "search", search: searchDetail(pattern) });
      }
      case "task":
      case "subagent": {
        const prompt = string("prompt") ?? "";
        const target = string("description") ?? firstLine(prompt);
        return make("agent", target, prompt.length > 0 ? { type: "text", text: Array.from(prompt).slice(0, 2_000).join("") } : { type: "none" });
      }
      case "webfetch":
        return make("web", string("url") ?? "");
      case "websearch":
      case "codesearch":
        return make("web", string("query") ?? "");
      case "todowrite": {
        const todos = (asArray(input.todos) ?? []).filter(isObject);
        const steps = todos.map((todo) => ({ text: asString(todo.content) ?? "", status: planStatus(todo.status) }));
        const active = todos.find((todo) => planStatus(todo.status) === "inProgress");
        return make("plan", active === undefined ? "" : (asString(active.content) ?? ""), { type: "plan", steps });
      }
      default: {
        const target = string("description", "query", "command", "filePath", "path", "url", "pattern", "name", "prompt");
        return make({ other: otherToolName(name) }, target === null ? "" : firstLine(target));
      }
    }
  }
}
