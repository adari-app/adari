// Reads an Antigravity CLI (`agy`) conversation's transcript,
// `~/.gemini/antigravity-cli/brain/<conversation id>/.system_generated/logs/transcript.jsonl`.
//
// Antigravity is closed source. Its readers: SpecStory (specstoryai/getspecstory 7b72bbcf,
// specstory-cli/pkg/providers/antigravitycli: ANTIGRAVITY-FORMAT.md, a spec written from captures, and
// transcript_parser.go / agent_session.go, its parser), codeburn (getagentseal/codeburn bb952552,
// tests/fixtures/antigravity-cli-current/.../transcript.jsonl:1-2) and T3 Code (pingdotgg/t3code cd87cce9
// apps/server/src/provider/acp/AntigravityChildWork.ts:301-360, which lists a subagent's steps and pairs none).
//
// A step per line (ANTIGRAVITY-FORMAT.md:104-121): `{step_index, source, type, status, created_at, content?,
// thinking?, tool_calls?: [{name, args}]}`; in this file each argument's value is JSON text (:225-238;
// T3 Code AntigravityChildWork.ts:313-323). Read:
// - `USER_INPUT` from `USER_EXPLICIT` (:136, :240-259; agent_session.go:157-166): the user's message, the text inside
//   `<USER_REQUEST>`, else the content without its metadata blocks (agent_session.go:36-37, :460-468); one from
//   another source is replayed input, skipped (agent_session.go:189-193). It starts a turn (FORMAT.md:465-476).
// - `PLANNER_RESPONSE` (:140): its `content` as the agent's text (`thinking` is not shown), its `tool_calls` as
//   rows (:171-187); a reply with no call ends the turn. T3 Code's `error` (AntigravityChildWork.ts:306) stands
//   for the text when there is no content.
// - `CONVERSATION_HISTORY`, `SYSTEM_MESSAGE` and `CHECKPOINT` are scaffolding, skipped (:137-139, :261-269;
//   agent_session.go:184-187). T3 Code's `SYSTEM_MESSAGE` holding a `<USER_REQUEST>` is a subagent's launch
//   envelope (AntigravityChildWork.testkit.ts:53-60, sender = the parent's id), not this pane's root
//   conversation, and T3 Code drops it too (AntigravityChildWork.ts:337-341).
// - A tool's result, one of the eleven result types (:141-151): its call's output.
// Status (:158-169): `DONE`; `ERROR` (a failed tool step: the output is a failure); `RUNNING` (a command gone
// async: its call returned, the rest is in a task log Chat does not read, transcript_parser.go:59-64). Any other
// status, any other type, a line that is not a step: unknown (the unrecognised note), never attached.
//
// Results carry no call id (:182-187). The result of a planner step's call is the step right after it
// (:182-184; the one gap, after the first result, is between a result and the next planner, :296-318);
// SpecStory pairs by the result's tool type, then the oldest call (agent_session.go:289-338). Here a planner's
// window is its next steps, one per call. A result finishes a call
// only when, across every planner window that admits it, exactly one waiting call takes its type (:189-199:
// `run_command` → RUN_COMMAND, …; a tool with no evidenced result type takes any of the eleven), and no later planner
// step lies between that call's planner and the result (a later planner ends an earlier one's window). Every step
// between the first admitting planner and the result must have been read, so a planner not read yet cannot hide
// there; until then the result waits. Otherwise it stands alone as its own row. File order can put a result before
// its planner (transcript_parser.go:253-259): such a result stands alone, and is kept, so that once the steps around
// it are read the same rule may finish the call it fits.

import { firstLine, LineResult, otherToolName, type TranscriptLineResult } from "../claude-parser";
import { CodexRolloutParser } from "../codex-parser";
import { searchDetail, toolCall, toolOutput, userMessage, type ChatToolCall, type ChatToolKind, type ChatToolOutput, type TranscriptEvent } from "../model";
import { asString, ChatDiffMaker, ChatJSON, isObject, objects, parseChatDate, type JSONObject } from "../tools";

/** Steps held to skip one read twice. */
const keptSteps = 2_048;
/** Planner steps whose calls wait for their results. */
const keptPlanners = 64;
/** Results read before their planner, kept for it. */
const keptEarly = 64;

/** The result step types (ANTIGRAVITY-FORMAT.md:141-151). */
const resultTypes = new Set([
  "RUN_COMMAND",
  "VIEW_FILE",
  "CODE_ACTION",
  "GREP_SEARCH",
  "LIST_DIRECTORY",
  "SEARCH_WEB",
  "READ_URL_CONTENT",
  "GENERATE_IMAGE",
  "INVOKE_SUBAGENT",
  "ASK_QUESTION",
  "GENERIC",
]);

/** Each tool's result type where a reader shows it (ANTIGRAVITY-FORMAT.md:141-151, :189-199). */
const resultTypeOfTool: Readonly<Record<string, string>> = {
  run_command: "RUN_COMMAND",
  view_file: "VIEW_FILE",
  write_to_file: "CODE_ACTION",
  replace_file_content: "CODE_ACTION",
  grep_search: "GREP_SEARCH",
  list_dir: "LIST_DIRECTORY",
  search_web: "SEARCH_WEB",
  read_url_content: "READ_URL_CONTENT",
  generate_image: "GENERATE_IMAGE",
  invoke_subagent: "INVOKE_SUBAGENT",
  ask_question: "ASK_QUESTION",
  list_permissions: "GENERIC",
};

const statuses = new Set(["DONE", "RUNNING", "ERROR"]);
const request = /<USER_REQUEST\b[^>]*>([\s\S]*?)<\/USER_REQUEST>/;
const metadataBlocks = /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>|<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g;
/** Filler agy appends to a result for the model (agent_session.go:366-377). */
const boilerplate = [
  "If relevant, proactively run terminal commands to execute this code for the USER. Don't ask for permission.",
  "Please note that the above snippet only shows the MODIFIED lines from the last change. It shows up to 3 lines of unchanged lines before and after the modified lines. The actual file contents may have many more lines not shown.",
  "Do not output the path of this image to show to the user since the user can already see it. However, you can embed this image in artifacts for the USER's review.",
  "The subagents will send you a message when they have completed their task or require guidance. There is no need to poll for their responses.",
  "You can use the view_file tool to read specific sections if needed.",
];

type WaitingCall = { readonly id: string; readonly name: string };
type Planner = { readonly step: number; readonly calls: WaitingCall[]; readonly count: number };
type Result = { readonly step: number; readonly type: string; readonly output: ChatToolOutput; readonly time: number | null };

/** A tool's arguments, each value read from the JSON text the runtime writes (T3 Code's toolArguments). */
function decodedArguments(args: unknown): JSONObject {
  if (!isObject(args)) return {};
  const decoded: JSONObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      decoded[key] = value;
      continue;
    }
    const parsed = ChatJSON.value(value);
    decoded[key] = parsed === undefined ? value : parsed;
  }
  return decoded;
}

/** A call takes a result of its own tool's type; a tool with no evidenced type takes any result type. */
function takes(name: string, type: string): boolean {
  const expected = resultTypeOfTool[name];
  return expected === undefined || expected === type;
}

/** The user's prompt: the `<USER_REQUEST>` text, else the content without its metadata blocks (agent_session.go:460-468). */
function promptText(content: string): string {
  const match = request.exec(content);
  if (match !== null) return (match[1] ?? "").trim();
  return content.replace(metadataBlocks, "").trim();
}

/** The common leading tabs of the non-blank lines, removed (agent_session.go:412-440). */
function withoutSharedTabs(lines: readonly string[]): string[] {
  let shared = -1;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const tabs = line.length - line.replace(/^\t+/, "").length;
    if (shared === -1 || tabs < shared) shared = tabs;
  }
  if (shared <= 0) return [...lines];
  return lines.map((line) => (line.trim().length === 0 ? "" : line.slice(shared)));
}

/**
 * A result's text without its `Created At:` / `Completed At:` lines and agy's filler; a command's block loses
 * its shared indent (ANTIGRAVITY-FORMAT.md:271-294; agent_session.go:379-410).
 */
function cleanedResult(type: string, content: string): string {
  let text = content;
  for (const phrase of boilerplate) text = text.split(phrase).join("");
  let lines = text.split("\n").filter((line) => {
    const bare = line.replace(/^\t+/, "");
    return !bare.startsWith("Created At:") && !bare.startsWith("Completed At:");
  });
  if (type === "RUN_COMMAND") lines = withoutSharedTabs(lines);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A command's exit from its result's text (ANTIGRAVITY-FORMAT.md:165-169, :271-294): failed with N, or 0. */
function exitCodeOf(text: string): number | null {
  const failed = /The command failed with exit code: (-?\d+)/.exec(text);
  if (failed !== null) return Number(failed[1]);
  return /The command completed successfully\./.test(text) ? 0 : null;
}

function resultOutput(type: string, status: string | null, content: string | null, error: string | null): ChatToolOutput {
  const text = content !== null ? cleanedResult(type, content) : (error ?? "").trim();
  const failedStep = status === "ERROR" || (content === null && error !== null);
  if (type !== "RUN_COMMAND") return toolOutput(text, { isError: failedStep });
  const exitCode = exitCodeOf(text);
  return toolOutput(text, { isError: failedStep || (exitCode !== null && exitCode !== 0), exitCode });
}

/**
 * A call's row by its tool (ANTIGRAVITY-FORMAT.md:189-223, the arguments seen; SpecStory markdown_tools.go:370-700,
 * the keys its renderers read): `view_file` and `list_dir` read their path, the three edit tools show their edit,
 * `run_command` its command line (the shell classifier's row), `grep_search` its query; the web tools their query or
 * address; `invoke_subagent` its first subagent's role; any other tool by its own name and its `toolSummary`.
 */
export function antigravityToolCall(id: string, name: string, args: JSONObject, time: number | null = null): ChatToolCall {
  const string = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = asString(args[key]);
      if (value !== null && value.length > 0) return value;
    }
    return null;
  };
  const summary = firstLine(string("toolSummary") ?? "");
  const make = (kind: ChatToolKind, target: string, detail: ChatToolCall["detail"] = { type: "none" }): ChatToolCall =>
    toolCall(id, kind, name, target, { detail, time });
  switch (name) {
    case "view_file":
      return make("read", string("AbsolutePath") ?? summary);
    case "list_dir":
      return make("read", string("DirectoryPath") ?? summary);
    case "write_to_file": {
      const path = string("TargetFile") ?? "";
      const content = asString(args.CodeContent);
      return content === null ? make("edit", path || summary) : make("edit", path, { type: "diff", diff: ChatDiffMaker.written(content, path) });
    }
    case "replace_file_content": {
      const path = string("TargetFile") ?? "";
      const old = asString(args.TargetContent);
      const replacement = asString(args.ReplacementContent);
      if (old === null || replacement === null) return make("edit", path || summary);
      const diff = old.length === 0 ? ChatDiffMaker.written(replacement, path) : ChatDiffMaker.replacement(old, replacement, path);
      return make("edit", path, { type: "diff", diff });
    }
    case "multi_replace_file_content": {
      // SpecStory markdown_tools.go:485-520: `ReplacementChunks`, each `{TargetContent, ReplacementContent}`.
      const path = string("TargetFile") ?? "";
      const edits = (objects(args.ReplacementChunks) ?? []).flatMap((chunk) => {
        const old = asString(chunk.TargetContent);
        const replacement = asString(chunk.ReplacementContent);
        return old === null || replacement === null ? [] : [{ old, new: replacement }];
      });
      return edits.length === 0 ? make("edit", path || summary) : make("edit", path, { type: "diff", diff: ChatDiffMaker.replacements(edits, path) });
    }
    case "run_command": {
      const command = string("CommandLine");
      return command === null ? make("bash", summary) : CodexRolloutParser.commandCall(id, name, command, time);
    }
    case "grep_search": {
      const query = string("Query") ?? "";
      return make("search", query, { type: "search", search: searchDetail(query) });
    }
    // SpecStory markdown_tools.go:422-440: search_web's `query` (lowercase), read_url_content's `Url`.
    case "search_web":
      return make("web", string("query") ?? summary);
    case "read_url_content":
      return make("web", firstLine(string("Url") ?? summary));
    // markdown_tools.go:530-534: generate_image's `ImageName`, `Prompt`.
    case "generate_image":
      return make({ other: name }, string("ImageName") ?? firstLine(string("Prompt") ?? summary));
    // markdown_tools.go:584-602: invoke_subagent's `Subagents`, each with its `Role`.
    case "invoke_subagent": {
      const role = (objects(args.Subagents) ?? []).map((subagent) => asString(subagent.Role)).find((value) => value !== null && value.length > 0);
      return make("agent", firstLine(role ?? summary));
    }
    default:
      return make({ other: otherToolName(name) }, summary);
  }
}

export class AntigravityTranscriptParser {
  /** The transcript names no folder: Herdr's report for the pane binds it. */
  cwd: string | null = null;
  lineOffset: number | null = null;
  private steps = new Set<number>();
  /** The planner steps read (with or without calls): each ends the windows of the planners before it. */
  private plannerSteps = new Set<number>();
  private planners: Planner[] = [];
  private early: Result[] = [];

  clone(): AntigravityTranscriptParser {
    const copy = new AntigravityTranscriptParser();
    copy.cwd = this.cwd;
    copy.lineOffset = this.lineOffset;
    copy.steps = new Set(this.steps);
    copy.plannerSteps = new Set(this.plannerSteps);
    copy.planners = this.planners.map((planner) => ({ ...planner, calls: [...planner.calls] }));
    copy.early = [...this.early];
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const step = ChatJSON.object(line);
    if (step === null) return LineResult.malformed();
    const index = ChatJSON.int(step.step_index);
    const type = asString(step.type);
    if (index === null || index < 0 || type === null || type.length === 0) return LineResult.unknown("(no step)");
    const status = step.status === undefined ? null : asString(step.status);
    if (step.status !== undefined && (status === null || !statuses.has(status))) return LineResult.unknown(`${type}:${String(status ?? "?")}`);
    if (this.steps.has(index)) return LineResult.skipped(type);
    const time = parseChatDate(asString(step.created_at));
    const content = asString(step.content);
    const error = asString(step.error);
    switch (type) {
      case "USER_INPUT": {
        this.remember(index);
        const source = asString(step.source);
        // A step read fills its place, so a result kept for the steps around it may now be decided.
        if (source !== null && source !== "USER_EXPLICIT") return LineResult.of(this.settle(), `${type}:${source}`);
        const text = promptText(content ?? "");
        if (text.length === 0) return LineResult.of(this.settle(), type);
        this.planners = [];
        return LineResult.events([{ type: "userMessage", message: userMessage(`agy-${index}`, text, time) }]);
      }
      case "PLANNER_RESPONSE": {
        if (status !== null && status !== "DONE") return LineResult.unknown(`${type}:${status}`);
        this.remember(index, true);
        return LineResult.of([...this.planner(index, step, (content ?? "").trim(), (error ?? "").trim(), time), ...this.settle()], type);
      }
      case "CONVERSATION_HISTORY":
      case "SYSTEM_MESSAGE":
      case "CHECKPOINT":
        this.remember(index);
        return LineResult.of(this.settle(), type);
      default: {
        if (!resultTypes.has(type)) return LineResult.unknown(type);
        this.remember(index);
        const result: Result = { step: index, type, output: resultOutput(type, status, content, error), time };
        return LineResult.events([...this.result(result), ...this.settle(result)]);
      }
    }
  }

  private planner(index: number, step: JSONObject, text: string, error: string, time: number | null): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    const shown = text.length > 0 ? text : error;
    if (shown.length > 0) events.push({ type: "agentText", text: { id: `agy-${index}`, markdown: shown, time } });
    const calls: WaitingCall[] = [];
    (objects(step.tool_calls) ?? []).forEach((call, number) => {
      const name = asString(call.name);
      if (name === null || name.length === 0) return;
      const id = `agy-${index}-${number}`;
      events.push({ type: "toolStarted", call: antigravityToolCall(id, name, decodedArguments(call.args), time) });
      calls.push({ id, name });
    });
    if (calls.length === 0) {
      if (events.length > 0) events.push({ type: "agentStopped", time });
      return events;
    }
    // A result read before this step (transcript_parser.go:253-259) is decided by settle(), with the rest.
    this.planners = [...this.planners.slice(-(keptPlanners - 1)), { step: index, calls, count: calls.length }];
    return events;
  }

  private result(result: Result): TranscriptEvent[] {
    const decision = this.decide(result);
    if (typeof decision === "object") return [this.finish(decision, result)];
    // No call fits it alone yet: its own row, finished; one the steps not read yet may still decide is kept for it.
    if (decision === "wait") this.early = [...this.early.slice(-(keptEarly - 1)), result];
    const id = `agy-${result.step}`;
    return [
      { type: "toolStarted", call: toolCall(id, { other: otherToolName(result.type.toLowerCase()) }, result.type, "", { time: result.time }) },
      { type: "toolFinished", id, output: result.output, time: result.time },
    ];
  }

  /**
   * The results kept for steps not read yet, decided again in step order now that another step is read
   * (`just`, the result this line read, was decided already): each finishes the call it alone fits, is dropped
   * when none or more than one can, or waits on.
   */
  private settle(just?: Result): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    for (const result of [...this.early].sort((a, b) => a.step - b.step)) {
      if (result === just) continue;
      const decision = this.decide(result);
      if (decision === "wait") continue;
      this.early = this.early.filter((held) => held !== result);
      if (typeof decision === "object") events.push(this.finish(decision, result));
    }
    return events;
  }

  /**
   * The one waiting call this result finishes; "never" when no call or more
   * than one can, or a later planner step lies between the call's planner and it; "wait" when no planner read yet
   * admits it, or a step between the first planner that does and it is not read yet (it could be a planner).
   */
  private decide(result: Result): { readonly planner: Planner; readonly call: WaitingCall } | "never" | "wait" {
    const admitting = this.planners.filter((planner) => result.step > planner.step && result.step <= planner.step + planner.count);
    if (admitting.length === 0) return "wait";
    const fits = admitting.flatMap((planner) => planner.calls.filter((call) => takes(call.name, result.type)).map((call) => ({ planner, call })));
    if (fits.length > 1) return "never";
    const first = Math.min(...admitting.map((planner) => planner.step));
    for (let index = first + 1; index < result.step; index += 1) if (!this.steps.has(index)) return "wait";
    if (fits.length === 0) return "never";
    const only = fits[0]!;
    for (let index = only.planner.step + 1; index < result.step; index += 1) if (this.plannerSteps.has(index)) return "never";
    return only;
  }

  /** Takes the call from those waiting and finishes it with the result. */
  private finish({ planner, call }: { readonly planner: Planner; readonly call: WaitingCall }, result: Result): TranscriptEvent {
    planner.calls.splice(planner.calls.indexOf(call), 1);
    if (planner.calls.length === 0) this.planners = this.planners.filter((held) => held !== planner);
    return { type: "toolFinished", id: call.id, output: result.output, time: result.time };
  }

  private remember(index: number, planner = false): void {
    if (this.steps.size >= keptSteps) {
      const oldest = this.steps.values().next().value;
      if (oldest !== undefined) {
        this.steps.delete(oldest);
        this.plannerSteps.delete(oldest);
      }
    }
    this.steps.add(index);
    if (planner) this.plannerSteps.add(index);
  }
}
