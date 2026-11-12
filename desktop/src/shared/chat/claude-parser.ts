// Reads a Claude Code session transcript (`<config>/projects/<slug>/<id>.jsonl`),
// one JSON object per line, as of Claude Code 2.1.316. A port of HerdrKit's
// ClaudeTranscriptParser.swift, with progress updates.
//
// Shown: `user` lines the user typed (a string or text and image blocks), a message
// they sent while the agent worked (an `attachment` line of type `queued_command`,
// at its place; once only when a `user` line carries the same input), pasted
// text as the text inside its `<pasted_content>` tags, `assistant` lines (text
// and tool_use blocks), tool results paired to their call by id, `custom-title`
// and `ai-title`, `!` shell commands as Bash rows, compaction and interrupts as
// quiet notices, and the progress updates the terminal prints between tool calls
// (thinking text on a line marked `"thinkingDisplay": "updates"`). Skipped:
// other thinking, subagent (`isSidechain`) and `isMeta` lines, bookkeeping
// types, and user strings that are not typing. A user line
// or queued command the harness wrote (by its fields, else by its wrapper tags:
// `lineAuthor`, `agentEnvelope`) is never their message.

import {
  attachment,
  backgroundTask,
  bashDetail,
  searchDetail,
  toolCall,
  toolOutput,
  userMessage,
  type ChatAttachment,
  type ChatPlanStatus,
  type ChatPlanStep,
  type ChatTaskNoticeStatus,
  type ChatToolCall,
  type ChatToolDetail,
  type ChatToolKind,
  type ChatToolOutput,
  type ChatUserMessage,
  type TranscriptEvent,
} from "./model";
import { blobParts, type ChatLineBlobs } from "./blobs";
import { asArray, asObject, asString, ChatAttachmentText, ChatDiffMaker, ChatJSON, isObject, parseChatDate, trimSpaces, type JSONObject } from "./tools";

// MARK: - line results

/** What became of one line. */
export type TranscriptLineOutcome =
  | { readonly kind: "events" }
  /** A known line the timeline does not show; carries the type name. */
  | { readonly kind: "skipped"; readonly type: string }
  /** Not a JSON object. */
  | { readonly kind: "malformed" }
  /** A JSON object of a type this parser does not know (or with no type). */
  | { readonly kind: "unknown"; readonly type: string };

export interface TranscriptLineResult {
  readonly events: TranscriptEvent[];
  readonly outcome: TranscriptLineOutcome;
}

export const LineResult = {
  skipped: (type: string): TranscriptLineResult => ({ events: [], outcome: { kind: "skipped", type } }),
  malformed: (): TranscriptLineResult => ({ events: [], outcome: { kind: "malformed" } }),
  unknown: (type: string): TranscriptLineResult => ({ events: [], outcome: { kind: "unknown", type } }),
  events: (events: TranscriptEvent[]): TranscriptLineResult => ({ events, outcome: { kind: "events" } }),
  /** `.events` when there are any, else skipped as `type`. */
  of: (events: TranscriptEvent[], orSkipped: string): TranscriptLineResult =>
    events.length === 0 ? LineResult.skipped(orSkipped) : LineResult.events(events),
};

// MARK: - the seam's memory

/** A message shown, kept to find the same input written the other way. */
export interface ShownMessage {
  /** Every id the line carries, to match on. */
  readonly keys: ReadonlySet<string>;
  /** The ids that name the input itself (a user line's ids; a queued line's source id). */
  readonly inputIDs: ReadonlySet<string>;
  readonly text: string;
  readonly attachments: readonly ChatAttachment[];
  readonly time: number | null;
  readonly queued: boolean;
  /** The timeline item it showed as. */
  readonly itemID: string;
}

/** One input as read, with what became of it as it shows now. */
export interface LoggedInput {
  readonly input: ShownMessage;
  /** Its row, to show it again. */
  readonly message: ChatUserMessage;
  /** Where its line starts in the file, when known. */
  readonly offset: number | null;
  readonly shown: boolean;
}

/**
 * What a part of the transcript read that one parse of the whole file might have
 * read otherwise, had it known the lines before: every input from its first
 * line to its last with what became of it, and the output of a `!` command it
 * read with no command of its own waiting.
 */
export interface SeamOpening {
  inputs: LoggedInput[];
  shellOutput: ChatToolOutput | null;
  shellOutputTime: number | null;
  /** A `!` command (or such an output) was read: a later output belongs to it. */
  shellSeen: boolean;
  /** The session its first line with one named, and that line's time: a seam into another session ends the work the lines before left running. */
  firstSession: string | null;
  firstSessionTime: number | null;
}

export const emptySeamOpening = (): SeamOpening => ({ inputs: [], shellOutput: null, shellOutputTime: null, shellSeen: false, firstSession: null, firstSessionTime: null });

export const copySeamOpening = (opening: SeamOpening): SeamOpening => ({ ...opening, inputs: [...opening.inputs] });

/** The part starts at `offset` now: the inputs before it go; a `!` output in it already met its command. */
export function forgetSeamOpening(opening: SeamOpening, offset: number): void {
  opening.inputs = opening.inputs.filter((input) => (input.offset ?? offset) >= offset);
  opening.shellOutput = null;
  opening.shellOutputTime = null;
  opening.shellSeen = true;
}

/** What a seam leaves for the parser reading on from the newest line. */
export interface SeamCarry {
  recent: ShownMessage[];
  pendingShellID: string | null;
  /** The sessions the lines before named: one named again later is no new session. */
  sessions: string[];
}

export const emptySeamCarry = (): SeamCarry => ({ recent: [], pendingShellID: null, sessions: [] });

/** What joining a part to the lines before it changes. */
export interface SeamJoin {
  duplicates: string[];
  restored: LoggedInput[];
  finished: TranscriptEvent[];
  opening: SeamOpening;
  carry: SeamCarry;
}

// MARK: - constants

/** Known line types that carry nothing for the timeline. */
export const bookkeeping = new Set([
  "system", "mode", "permission-mode", "atis-latch", "last-prompt", "api-request",
  "api-request-blob", "api-request-shape", "queue-operation", "tools-used",
  "summary", "agent-name", "cost-state",
]);

const taskNotificationOpen = "<task-notification>";

/** User strings that are not something the user typed. */
const notTyped = [
  "<command-name>", "<command-message>", "<command-args>", "<local-command-stdout>",
  "<local-command-stderr>", "<local-command-caveat>", "<system-reminder>", "<task-notification>",
];

const compactedPrefix = "This session is being continued from a previous conversation";
const interruptedPrefix = "[Request interrupted by user";

/**
 * The text after a leading interrupt line, when there is
 * any ("[Request interrupted by user]\nqueued one\nqueued two" → "queued
 * one\nqueued two"); null for any other text, or the interrupt line alone.
 */
export function interruptedThen(text: string): string | null {
  const lead = dropLeadingSpace(text);
  if (!lead.startsWith(interruptedPrefix)) return null;
  const end = lead.indexOf("\n");
  if (end < 0 || !lead.slice(0, end).trimEnd().endsWith("]")) return null;
  const rest = lead.slice(end + 1);
  return rest.trim() === "" ? null : rest;
}

/** How many shown messages are kept to match against. */
export const recentMessageLimit = 16;
/** Equal text and attachments this close in time (seconds) are the same input, when one side names no input id. */
export const duplicateWindow = 120;

/** A line whose thinking text the terminal prints. */
const thinkingDisplayKey = "thinkingDisplay";
const thinkingDisplayUpdates = "updates";

const pastedOpen = "<pasted_content";
const pastedCloseName = "</pasted_content";

/** Swift's `x ?? y` on `[String: Any]` values: JSON null is a value there. */
const either = (object: JSONObject, first: string, second: string): unknown => (first in object ? object[first] : object[second]);

const dropLeadingSpace = (text: string): string => text.replace(/^[ \n\t\r]+/, "");

/**
 * Text the harness wraps (a slash command's lines, its
 * output, a reminder, a notification): it starts with one of `notTyped`'s tags
 * and that element is closed; a bare tag in prose is typing. On a line whose
 * fields mark it as typed, a `<task-notification>` is the user's words too (a slash
 * command and a reminder block are still the harness's).
 */
export const isWrapper = (text: string, typed: boolean): boolean => {
  const lead = dropLeadingSpace(text);
  const open = notTyped.find((prefix) => lead.startsWith(prefix));
  if (open === undefined || (typed && open === taskNotificationOpen)) return false;
  return lead.includes(`</${open.slice(1)}`, open.length);
};

const blocksOf = (content: unknown): JSONObject[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const array = asArray(content);
  return array === null ? [] : array.filter(isObject);
};

const sameAttachments = (a: readonly ChatAttachment[], b: readonly ChatAttachment[]): boolean =>
  a.length === b.length && a.every((value, index) => value.path === b[index]!.path && value.mediaType === b[index]!.mediaType);

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const value of a) if (b.has(value)) return true;
  return false;
};

const nonEmptyStrings = (values: readonly unknown[]): Set<string> =>
  new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0));

export class ClaudeTranscriptParser {
  /** The `!` command waiting for its `<bash-stdout>` line. */
  private pendingShellID: string | null = null;
  /** The newest envelopes read (from, kind, text), so one written both ways shows once. */
  private recentEnvelopes: string[] = [];
  /** The newest messages shown, typed or queued, so that one input written both ways shows once. */
  private recentMessages: ShownMessage[] = [];
  private serial = 0;
  private offset: number | null = null;
  private idsInLine = 0;
  /**
   * Relay v1.2: the runs a relay read left out of the line being read (each a placeholder
   * in its text) and where they are; null: none. An image block whose base64 holds them gets a blob to fetch.
   */
  lineBlobs: ChatLineBlobs | null = null;
  /** Every input read since the first line, and a `!` output read before its command (see SeamOpening). */
  opening: SeamOpening = emptySeamOpening();
  /** The session's working folder: `cwd` of the first user or assistant line that has one. */
  cwd: string | null = null;
  /** The session the newest line named (`sessionId`), and every one named. */
  private lastSession: string | null = null;
  private sessions = new Set<string>();
  /**
   * The user's newest message line (its uuid and parentUuid) and
   * whether the agent answered it since. Claude Code drops a message Esc
   * cancelled before any answer: the user's next line hangs off the same parent.
   */
  private lastAsked: { readonly uuid: string; readonly parent: string; answered: boolean } | null = null;

  /** Where the line being read starts in the file (when the caller knows): the ids a line lacks are made from it. */
  get lineOffset(): number | null {
    return this.offset;
  }

  set lineOffset(value: number | null) {
    this.offset = value;
    this.idsInLine = 0;
  }

  clone(): ClaudeTranscriptParser {
    const copy = new ClaudeTranscriptParser();
    copy.pendingShellID = this.pendingShellID;
    copy.recentEnvelopes = [...this.recentEnvelopes];
    copy.recentMessages = [...this.recentMessages];
    copy.serial = this.serial;
    copy.offset = this.offset;
    copy.idsInLine = this.idsInLine;
    copy.opening = copySeamOpening(this.opening);
    copy.cwd = this.cwd;
    copy.lastSession = this.lastSession;
    copy.sessions = new Set(this.sessions);
    copy.lastAsked = this.lastAsked === null ? null : { ...this.lastAsked };
    return copy;
  }

  parse(line: string): TranscriptLineResult {
    const object = ChatJSON.object(line);
    if (object === null) return LineResult.malformed();
    const type = asString(object.type);
    if (type === null) return LineResult.unknown("(no type)");
    const changed = this.sessionChange(object);
    const result = this.parseObject(object, type);
    if (changed === null) return result;
    // Another session's line: what ran in the one before is over, before this line's events.
    return { events: [changed, ...result.events], outcome: result.outcome.kind === "skipped" ? { kind: "events" } : result.outcome };
  }

  /**
   * A line naming a session no line before it named (a
   * new session or run written into the same file) is the event that ends
   * every task and subagent still running; null for any other. A line naming an
   * earlier session again starts nothing new; a subagent's own line (isSidechain)
   * changes nothing.
   */
  private sessionChange(object: JSONObject): TranscriptEvent | null {
    const id = asString(object.sessionId);
    if (id === null || id.length === 0 || ChatJSON.bool(object.isSidechain)) return null;
    const time = parseChatDate(object.timestamp);
    if (this.opening.firstSession === null) {
      this.opening.firstSession = id;
      this.opening.firstSessionTime = time;
    }
    const previous = this.lastSession;
    const known = this.sessions.has(id);
    this.lastSession = id;
    this.sessions.add(id);
    return previous === null || previous === id || known ? null : { type: "sessionChanged", time };
  }

  private parseObject(object: JSONObject, type: string): TranscriptLineResult {
    switch (type) {
      case "user":
      case "assistant": {
        const folder = asString(object.cwd);
        if (this.cwd === null && folder !== null && folder.length > 0) this.cwd = folder;
        if (ChatJSON.bool(object.isSidechain)) return LineResult.skipped(type + "/sidechain");
        if (type === "assistant") {
          if (ChatJSON.bool(object.isMeta)) return LineResult.skipped(type + "/meta");
          if (this.lastAsked !== null) this.lastAsked.answered = true;
          return this.assistant(object);
        }
        return this.user(object);
      }
      case "ai-title": {
        const title = asString(either(object, "aiTitle", "title"));
        if (title === null || title.trim().length === 0) return LineResult.skipped(type);
        return LineResult.events([{ type: "title", value: title }]);
      }
      case "custom-title": {
        const title = asString(either(object, "customTitle", "title"));
        if (title === null || title.trim().length === 0) return LineResult.skipped(type);
        return LineResult.events([{ type: "customTitle", value: title }]);
      }
      case "attachment":
        if (ChatJSON.bool(object.isSidechain)) return LineResult.skipped("attachment/sidechain");
        return this.attachment(object);
      case "queue-operation": {
        // The first of the three copies of a task's notice (dedupe is the builder's: by task id).
        const notified = notificationIn(object.content, parseChatDate(object.timestamp));
        return notified === null ? LineResult.skipped(type) : LineResult.events([notified]);
      }
      case "system": {
        // The turn's own measure, read as its
        // "Worked for"; a subagent's is not the turn's.
        if (asString(object.subtype) !== "turn_duration") return LineResult.skipped(type);
        const ms = typeof object.durationMs === "number" ? object.durationMs : null;
        if (ChatJSON.bool(object.isSidechain) || ms === null || !Number.isFinite(ms) || ms < 0) return LineResult.skipped("system/turn_duration");
        return LineResult.events([{ type: "turnMeasured", duration: ms / 1000, time: parseChatDate(object.timestamp) }]);
      }
      default:
        if (bookkeeping.has(type) || type.startsWith("file-history-")) return LineResult.skipped(type);
        return LineResult.unknown(type);
    }
  }

  // MARK: user lines

  private user(object: JSONObject): TranscriptLineResult {
    const message = asObject(object.message);
    if (message === null) return LineResult.skipped("user");
    const time = parseChatDate(object.timestamp);
    const uuid = asString(object.uuid) ?? this.nextID("user");
    const blocks = blocksOf(message.content);
    if (ChatJSON.bool(object.isCompactSummary)) {
      return LineResult.events([{ type: "notice", notice: { id: uuid, kind: "compacted", time }, endsTurn: false }]);
    }
    const author = lineAuthor(object);
    const isMeta = ChatJSON.bool(object.isMeta);
    const events: TranscriptEvent[] = [];
    // The orphan rule. The user's last message had no answer and
    // this user line hangs off the same parent: Esc cancelled that message
    // before any answer and Claude Code dropped it (its text went back to the
    // box), so it is not shown as a sent message.
    const parent = asString(object.parentUuid);
    const asked = this.lastAsked;
    if (!isMeta && asked !== null) {
      if (!asked.answered && parent !== null && parent === asked.parent) events.push({ type: "userWithdrawn", id: asked.uuid });
      this.lastAsked = null;
    }
    const texts: string[] = [];
    const images: ChatAttachment[] = [];
    for (const block of blocks) {
      switch (asString(block.type)) {
        case "text": {
          const text = asString(block.text);
          if (text === null) continue;
          const envelope = author !== "typed" ? agentEnvelope(text) : null;
          if (envelope !== null) {
            // A subagent's hand-back or another session's message, never the user's.
            events.push(...this.agentMessage(envelope, uuid, time));
            break;
          }
          // The user's typing never finishes an agent.
          const notified = author !== "typed" ? taskNotification(text, time) : null;
          if (notified !== null) {
            events.push(notified);
            break;
          }
          // Context the harness gave the agent (a caveat, a reminder): nothing to show.
          if (isMeta) continue;
          // Esc with messages queued runs them at once as one prompt,
          // "[Request interrupted by user]" and then the queued texts, one per line: the
          // stop, then the user's message.
          const after = interruptedThen(text);
          if (after !== null) {
            events.push({ type: "notice", notice: { id: uuid + "/stop", kind: "interrupted", time }, endsTurn: true });
            if (author !== "harness") texts.push(unwrapPasted(after));
            break;
          }
          const handled = this.special(text, author === "typed", uuid, time);
          if (handled !== null) events.push(...handled);
          else if (author !== "harness") texts.push(unwrapPasted(text));
          break;
        }
        case "image": {
          if (author === "harness") continue;
          images.push(this.image(asObject(block.source)));
          break;
        }
        case "tool_result": {
          const id = asString(block.tool_use_id);
          if (id === null) continue;
          const raw = ChatJSON.text(block.content);
          const { code, body } = exitCode(raw);
          // A background launch's task id, as the line's toolUseResult names it.
          const used = asObject(object.toolUseResult);
          const taskID = used === null ? null : (nonEmpty(asString(used.backgroundTaskId)) ?? nonEmpty(asString(used.taskId)));
          events.push({ type: "toolFinished", id, output: toolOutput(body, { isError: ChatJSON.bool(block.is_error), exitCode: code, taskID }), time });
          break;
        }
        default:
          continue;
      }
    }
    const shown = messageFrom(texts, images, uuid, time);
    if (shown !== null && !isMeta && author !== "harness" && parent !== null) this.lastAsked = { uuid, parent, answered: false };
    if (shown !== null) {
      // A user line is the input: every id it carries is the input's.
      const keys = nonEmptyStrings([object.uuid, object.promptId, object.sourceUuid, object.source_uuid]);
      if (this.takeDuplicate(shown, keys, keys, false)) {
        if (events.length === 0) return LineResult.skipped("user/queued-twice");
      } else {
        events.push({ type: "userMessage", message: shown });
      }
    }
    return LineResult.of(events, isMeta ? "user/meta" : author === "harness" ? "user/harness" : "user/not-typed");
  }

  /**
   * An envelope as an event (a hand-back, or another
   * session's message), once: Claude Code may write the same one as a queued
   * command and as a user line.
   */
  private agentMessage(envelope: AgentEnvelope, uuid: string, time: number | null): TranscriptEvent[] {
    const key = `${envelope.from ?? ""}\u0001${envelope.isHandBack ? "r" : "p"}${envelope.body}`;
    if (this.recentEnvelopes.includes(key)) return [];
    this.recentEnvelopes.push(key);
    if (this.recentEnvelopes.length > recentEnvelopeLimit) this.recentEnvelopes.shift();
    return [{ type: "agentMessage", message: { id: uuid, kind: envelope.isHandBack ? "report" : "peer", from: envelope.from, text: envelope.body, time } }];
  }

  // MARK: messages sent while the agent works

  /**
   * An `attachment` line: a `queued_command` is a message the user sent while the
   * agent worked; every other attachment is skipped.
   */
  /**
   * An inline image: its media type, and when a relay read left its base64 out, the parts to fetch on show
   * (found from the line's ranges); otherwise a frame.
   */
  private image(source: JSONObject | null): ChatAttachment {
    const mediaType = asString(source?.media_type);
    const blobs = this.lineBlobs;
    const data = blobs === null ? null : asString(source?.data);
    const parts = blobs === null || data === null ? null : blobParts(data, blobs.ranges);
    return parts === null || blobs === null ? attachment(null, mediaType) : attachment(null, mediaType, { path: blobs.path, ino: blobs.ino, parts });
  }

  private attachment(object: JSONObject): TranscriptLineResult {
    const value = asObject(object.attachment);
    if (value !== null && asString(value.type) !== "queued_command") {
      // An attachment that holds a task's notice (its rendered text): the notice, never the user's message.
      const time = parseChatDate(object.timestamp);
      for (const key of ["rendered", "content", "prompt", "text"]) {
        const notified = notificationIn(value[key], time);
        if (notified !== null) return LineResult.events([notified]);
      }
      const notified = notificationIn(object.rendered, time);
      if (notified !== null) return LineResult.events([notified]);
    }
    if (value === null || asString(value.type) !== "queued_command") return LineResult.skipped("attachment");
    const time = parseChatDate(object.timestamp);
    const source = asString(either(value, "source_uuid", "sourceUuid"));
    const uuid = asString(object.uuid) ?? source ?? this.nextID("queued");
    // The fields are the attachment's or the line's; the harness's on either is the harness's.
    const authors = [lineAuthor(value), lineAuthor(object)];
    const author: LineAuthor = authors.includes("harness") ? "harness" : authors.includes("typed") ? "typed" : "unknown";
    const events: TranscriptEvent[] = [];
    let texts: string[] = [];
    const images: ChatAttachment[] = [];
    const prompt = value.prompt;
    if (typeof prompt === "string") {
      texts = [prompt];
    } else if (Array.isArray(prompt)) {
      for (const block of prompt) {
        if (!isObject(block)) continue;
        const blockType = asString(block.type);
        if (blockType === "text") {
          const text = asString(block.text);
          if (text !== null) texts.push(text);
        } else if (blockType === "image") {
          images.push(this.image(asObject(block.source)));
        }
      }
    }
    // A queued slash command's or reminder's text is not typing; nor is another session's message.
    texts = texts
      .filter((text) => {
        const envelope = author !== "typed" ? agentEnvelope(text) : null;
        if (envelope !== null) {
          events.push(...this.agentMessage(envelope, uuid, time));
          return false;
        }
        const notified = author !== "typed" ? taskNotification(text, time) : null;
        if (notified !== null) {
          events.push(notified);
          return false;
        }
        return !isWrapper(text, author === "typed");
      })
      .map(unwrapPasted);
    if (author === "harness") return LineResult.of(events, "attachment/queued_command-harness");
    const shown = messageFrom(texts, images, uuid, time);
    if (shown === null) return LineResult.of(events, "attachment/queued_command-empty");
    // The attachment line's own uuid is the line's; the input's id is its source id.
    const keys = nonEmptyStrings([asString(object.uuid), source]);
    const inputIDs = nonEmptyStrings([source]);
    if (this.takeDuplicate(shown, keys, inputIDs, true)) return LineResult.of(events, "attachment/queued-twice");
    return LineResult.events([...events, { type: "userMessage", message: shown, queued: true }]);
  }

  /**
   * True when `message` is an input already shown the other way: an id in
   * common; or, only when one side has no input id, the same text and
   * attachments within `duplicateWindow`. The match is used up. Either way the
   * input goes in the log, in the file's order.
   */
  private takeDuplicate(message: ChatUserMessage, keys: ReadonlySet<string>, inputIDs: ReadonlySet<string>, queued: boolean): boolean {
    const shown: ShownMessage = { keys, inputIDs, text: message.text, attachments: message.attachments, time: message.time, queued, itemID: message.id };
    const duplicate = takeMatch(shown, this.recentMessages);
    this.opening.inputs.push({ input: shown, message, offset: this.offset, shown: !duplicate });
    return duplicate;
  }

  // MARK: the history seam

  /**
   * Joins `older` (the parser that read the lines just before the first line of
   * a part, to their end) to that part, read as `newer`: every input of the part
   * taken again in the file's order from the memory `older` ended with.
   */
  static seam(older: ClaudeTranscriptParser, newer: SeamOpening): SeamJoin {
    const join: SeamJoin = { duplicates: [], restored: [], finished: [], opening: emptySeamOpening(), carry: emptySeamCarry() };
    const recent = [...older.recentMessages];
    const opening = copySeamOpening(older.opening);
    for (const logged of newer.inputs) {
      const shown = !takeMatch(logged.input, recent);
      let entry = logged;
      if (shown !== logged.shown) {
        if (shown) join.restored.push(logged);
        else join.duplicates.push(logged.input.itemID);
        entry = { ...logged, shown };
      }
      opening.inputs.push(entry);
    }
    join.carry.recent = recent;
    join.carry.sessions = [...older.sessions];
    const id = older.pendingShellID;
    if (id !== null) {
      if (newer.shellOutput !== null) {
        join.finished.push({ type: "toolFinished", id, output: newer.shellOutput, time: newer.shellOutputTime });
      } else if (!newer.shellSeen) {
        join.carry.pendingShellID = id;
      }
    }
    if (!opening.shellSeen) {
      opening.shellOutput = newer.shellOutput;
      opening.shellOutputTime = newer.shellOutputTime;
      opening.shellSeen = newer.shellSeen;
    }
    // The part is another session's than the lines before: what they left running is over.
    if (older.lastSession !== null && newer.firstSession !== null && older.lastSession !== newer.firstSession && !older.sessions.has(newer.firstSession)) {
      join.finished.push({ type: "sessionChanged", time: newer.firstSessionTime });
    }
    if (opening.firstSession === null) {
      opening.firstSession = newer.firstSession;
      opening.firstSessionTime = newer.firstSessionTime;
    }
    join.opening = opening;
    return join;
  }

  /** The parser reading on from the newest line takes on a seam joined before what it read. */
  adopt(carry: SeamCarry, joined: SeamOpening): void {
    this.recentMessages = [...carry.recent];
    // The sessions the earlier lines named are known (the newest one this parser read stays).
    for (const id of carry.sessions ?? []) this.sessions.add(id);
    if (carry.pendingShellID !== null && this.pendingShellID === null && !this.opening.shellSeen) this.pendingShellID = carry.pendingShellID;
    const merged = copySeamOpening(joined);
    if (!merged.shellSeen && this.opening.shellSeen) {
      merged.shellOutput = this.opening.shellOutput;
      merged.shellOutputTime = this.opening.shellOutputTime;
      merged.shellSeen = true;
    }
    this.opening = merged;
  }

  /** The part this parser read starts at `offset` now (a trim). */
  forgetInputs(offset: number): void {
    forgetSeamOpening(this.opening, offset);
  }

  /** A text block that is not typing: null when it is a message, else what it stands for. */
  private special(text: string, typed: boolean, uuid: string, time: number | null): TranscriptEvent[] | null {
    const lead = dropLeadingSpace(text);
    if (isWrapper(text, typed)) return [];
    if (lead.startsWith(compactedPrefix)) return [{ type: "notice", notice: { id: uuid, kind: "compacted", time }, endsTurn: false }];
    if (lead.startsWith(interruptedPrefix)) return [{ type: "notice", notice: { id: uuid, kind: "interrupted", time }, endsTurn: true }];
    const shell = shellBlock(text);
    if (shell === null) return null;
    if (shell.input !== null) {
      this.opening.shellSeen = true;
      const trimmed = shell.input.trim();
      const events: TranscriptEvent[] = [
        {
          type: "userShell",
          call: toolCall(uuid, "bash", "!", trimmed, { detail: { type: "bash", bash: bashDetail(trimmed) }, time, isUserShell: true }),
        },
      ];
      if (shell.output !== null) events.push({ type: "toolFinished", id: uuid, output: shell.output, time });
      else this.pendingShellID = uuid;
      return events;
    }
    const id = this.pendingShellID;
    if (id === null || shell.output === null) {
      if (shell.output !== null && !this.opening.shellSeen) {
        // Its command is before this parser's first line.
        this.opening.shellOutput = shell.output;
        this.opening.shellOutputTime = time;
        this.opening.shellSeen = true;
      }
      return [];
    }
    this.pendingShellID = null;
    return [{ type: "toolFinished", id, output: shell.output, time }];
  }

  // MARK: assistant lines

  private assistant(object: JSONObject): TranscriptLineResult {
    const message = asObject(object.message);
    if (message === null) return LineResult.skipped("assistant");
    const time = parseChatDate(object.timestamp);
    const uuid = asString(object.uuid) ?? this.nextID("assistant");
    const blocks = blocksOf(message.content);
    const events: TranscriptEvent[] = [];
    const kinds: string[] = [];
    const showsUpdates = asString(object[thinkingDisplayKey]) === thinkingDisplayUpdates;
    blocks.forEach((block, index) => {
      const blockType = asString(block.type) ?? "?";
      kinds.push(blockType);
      const id = index === 0 ? uuid : `${uuid}/${index}`;
      if (blockType === "text") {
        const text = asString(block.text);
        if (text === null || text.trim().length === 0) return;
        events.push({ type: "agentText", text: { id, markdown: text, time } });
      } else if (blockType === "thinking" && showsUpdates) {
        // What the terminal prints between tool calls; a signature only prints nothing.
        const text = asString(block.thinking);
        if (text === null || text.trim().length === 0) return;
        events.push({ type: "agentProgress", text: { id, markdown: text, time } });
      } else if (blockType === "tool_use") {
        const callID = asString(block.id);
        const name = asString(block.name);
        if (callID === null || name === null) return;
        const input = asObject(block.input) ?? {};
        events.push({ type: "toolStarted", call: claudeToolCall(callID, name, input, time) });
        // A TaskStop ends the task it names.
        const stopped = stoppedTaskID(name, input);
        if (stopped !== null) events.push({ type: "taskStopped", id: stopped, time });
      }
      // Thinking on a line that does not show updates, redacted thinking, server tool blocks: nothing.
    });
    if (asString(message.stop_reason) === "end_turn") events.push({ type: "agentStopped", time });
    return LineResult.of(events, "assistant/" + (kinds[0] ?? "empty"));
  }

  /** An id for a line that has none: from where the line is in the file when known, else a count. */
  private nextID(prefix: string): string {
    if (this.offset !== null) {
      this.idsInLine += 1;
      return `claude-${prefix}-at${this.offset}` + (this.idsInLine > 1 ? `-${this.idsInLine}` : "");
    }
    this.serial += 1;
    return `claude-${prefix}-${this.serial}`;
  }
}

// MARK: - who wrote a user line

/** The user typed it; the harness wrote it; or the line does not say (older Claude Code: its text decides). */
export type LineAuthor = "typed" | "harness" | "unknown";

/** The values of promptSource, origin.kind and turnOrigin that mean the user wrote it ("user" too: an earlier build's, never the harness's). */
const typedValues = new Set(["typed", "human", "user"]);
/** promptSource of a message sent while the agent worked: when, not who. */
const queuedSource = "queued";

/**
 * Claude Code 2.1.3xx: the user's typing carries `promptSource:
 * "typed"`, `origin.kind: "human"`, `turnOrigin: "human"`; another session's
 * message `isMeta`, `promptSource: "system"`, `origin.kind: "peer"`,
 * `turnOrigin: "peer"`. `isMeta` is the harness's; else the first of
 * promptSource, origin.kind and turnOrigin that is there decides; with none of
 * them the line does not say. A queued command's `commandMode` of
 * `task-notification` is the harness's too.
 *
 * Claude Code 2.1.31x: a message the user sent while
 * the agent worked comes back after the turn as a user line with `promptSource:
 * "queued"` and `origin.kind` / `turnOrigin` "human" (and no `queued_command`
 * attachment). "queued" says when, not who: such a line is the user's when origin.kind
 * and turnOrigin, those of them there, all say the user wrote it; else (another
 * session's, the harness's, or neither there) it is the harness's.
 */
export function lineAuthor(object: JSONObject): LineAuthor {
  if (ChatJSON.bool(object.isMeta)) return "harness";
  if (asString(object.commandMode) === "task-notification") return "harness";
  const source = asString(object.promptSource);
  const origins = [asString(asObject(object.origin)?.kind), asString(object.turnOrigin)];
  if (source === queuedSource) {
    // Sent while the agent worked; who sent it is in origin.kind and turnOrigin.
    const said = origins.filter((candidate): candidate is string => candidate !== null && candidate.length > 0);
    return said.length > 0 && said.every((candidate) => typedValues.has(candidate)) ? "typed" : "harness";
  }
  const value = [source, ...origins].find((candidate): candidate is string => candidate !== null && candidate.length > 0);
  if (value === undefined) return "unknown";
  return typedValues.has(value) ? "typed" : "harness";
}

/** A message from another Claude session as Claude Code writes it into this one. */
export interface AgentEnvelope {
  readonly from: string | null;
  /** The text inside, without the hand-back's opening line. */
  readonly body: string;
  readonly isHandBack: boolean;
}

const peerIntro = "Another Claude session sent a message:";
const agentMessageOpen = "<agent-message";
const agentMessageClose = "</agent-message>";
const handBackMark = "[Subagent hand-back]";

/**
 * `Another Claude session sent a message:` (optional), then `<agent-message
 * from="…">`, the text, `</agent-message>`: the whole block and nothing else
 * (space around aside), else null (a tag in prose, or text around the block, is
 * typing). A subagent's hand-back is one whose text starts `[Subagent hand-back]`.
 */
export function agentEnvelope(text: string): AgentEnvelope | null {
  let rest = text.trim();
  if (rest.startsWith(peerIntro)) rest = rest.slice(peerIntro.length).replace(/^\s+/, "");
  if (!rest.startsWith(agentMessageOpen) || !rest.endsWith(agentMessageClose)) return null;
  const afterName = agentMessageOpen.length;
  // The opening tag ends before the closing tag starts (`<agent-message </agent-message>` is text).
  const closeStart = rest.length - agentMessageClose.length;
  const next = rest[afterName];
  const tagEnd = rest.indexOf(">", afterName);
  if (afterName > closeStart || next === undefined || !(next === ">" || /\s/.test(next)) || tagEnd < 0 || tagEnd >= closeStart) return null;
  const inner = rest.slice(tagEnd + 1, closeStart);
  const from = tagAttribute("from", rest.slice(afterName, tagEnd));
  let body = inner.trim();
  const isHandBack = body.startsWith(handBackMark);
  if (isHandBack) {
    // The opening line says what it is; the report is what follows.
    const firstBreak = body.search(/[\n\r]/);
    body = firstBreak < 0 ? "" : body.slice(firstBreak).trim();
  }
  return { from, body, isHandBack };
}

/** How many envelopes are kept to find one written twice. */
const recentEnvelopeLimit = 16;

const taskNotificationClose = "</task-notification>";

/**
 * A `<task-notification>` naming a task (a background
 * agent's id, among others) and its status: the event that finishes that agent,
 * when it is one; null for any other text.
 *
 * Its shape: `<task-id>`,
 * `<tool-use-id>` (the Bash, Monitor or Agent call's id), `<status>`,
 * `<summary>` (`… completed (exit code 0)`) and a monitor's `<event>`. A status
 * of running, or an event with no status, is a monitor's event (its task runs
 * on); any other status ends it (completed, failed or error, killed; stopped,
 * cancelled, timed out and any other value as stopped); no status is completed.
 * A non-zero exit code in the summary is a failure.
 */
export function taskNotification(text: string, time: number | null): TranscriptEvent | null {
  const lead = text.replace(/^\s+/, "");
  if (!lead.startsWith(taskNotificationOpen) || !lead.includes(taskNotificationClose)) return null;
  const element = (name: string): string | null => {
    const open = lead.indexOf(`<${name}>`);
    if (open < 0) return null;
    const start = open + name.length + 2;
    const close = lead.indexOf(`</${name}>`, start);
    if (close < 0) return null;
    const value = lead.slice(start, close).trim();
    return value.length === 0 ? null : value;
  };
  const toolUseID = element("tool-use-id");
  const id = element("task-id") ?? toolUseID;
  if (id === null) return null;
  const written = element("status")?.toLowerCase() ?? null;
  const status = written ?? "completed";
  const failed = ["failed", "error", "killed", "cancelled", "canceled"].includes(status);
  const summary = element("summary");
  const event = element("event");
  const code = summary === null ? null : /exit code (-?\d+)/i.exec(summary);
  const exitCode = code === null ? null : Number(code[1]);
  let noticeStatus: ChatTaskNoticeStatus;
  if (written === "running" || (written === null && event !== null && summary === null)) noticeStatus = "event";
  else if (["failed", "error"].includes(status) || (exitCode !== null && exitCode !== 0)) noticeStatus = "failed";
  else if (status === "killed") noticeStatus = "killed";
  else if (["completed", "complete", "done", "success", "succeeded"].includes(status)) noticeStatus = "done";
  else noticeStatus = "stopped";
  return {
    type: "taskNotified",
    id,
    failed,
    report: element("result"),
    time,
    toolUseID,
    status: noticeStatus,
    event: event === null ? null : Array.from(event).slice(0, 2_000).join(""),
    exitCode,
  };
}

/** The notice a line's value holds (a string, or text blocks), or null. */
function notificationIn(value: unknown, time: number | null): TranscriptEvent | null {
  const texts: string[] = typeof value === "string" ? [value] : (asArray(value) ?? []).filter(isObject).map((block) => asString(block.text) ?? "");
  for (const text of texts) {
    const notified = taskNotification(text, time);
    if (notified !== null) return notified;
  }
  return null;
}

const nonEmpty = (value: string | null): string | null => (value === null || value.trim().length === 0 ? null : value.trim());

/** The task a TaskStop (or the older KillShell, KillBash) call names, or null. */
export function stoppedTaskID(name: string, input: JSONObject): string | null {
  if (name !== "TaskStop" && name !== "KillShell" && name !== "KillBash") return null;
  for (const key of ["task_id", "taskId", "shell_id", "bash_id", "id"]) {
    const value = nonEmpty(asString(input[key]));
    if (value !== null) return value;
  }
  return null;
}

/** An attribute's value (quoted with `"` or `'`, or bare to a space); null when the tag has none. */
function tagAttribute(name: string, attributes: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"?|'([^']*)'?|([^\\s/]*))`).exec(attributes);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/** The rule of `takeDuplicate` on `recent`: true (match used up) when `message` is in it written the other way, else remembered. */
function takeMatch(message: ShownMessage, recent: ShownMessage[]): boolean {
  const index = matchIndex(message, recent);
  if (index !== null) {
    recent.splice(index, 1);
    return true;
  }
  recent.push(message);
  if (recent.length > recentMessageLimit) recent.shift();
  return false;
}

/** One input written both ways (queued and typed), by the rule above: search joins its two results. */
export function isSameInput(shown: ShownMessage, message: ShownMessage): boolean {
  return matchIndex(message, [shown]) !== null;
}

function matchIndex(message: ShownMessage, recent: readonly ShownMessage[]): number | null {
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const shown = recent[index]!;
    if (shown.queued === message.queued) continue;
    if (intersects(shown.keys, message.keys)) return index;
    if (!(shown.inputIDs.size === 0 || message.inputIDs.size === 0)) continue;
    if (shown.text !== message.text || !sameAttachments(shown.attachments, message.attachments)) continue;
    if (shown.time === null || message.time === null) continue;
    if (Math.abs(message.time - shown.time) <= duplicateWindow) return index;
  }
  return null;
}

/**
 * Claude Code 2.1.316's user line can start
 * with blank lines before the paste ("\n\n<pasted_content …>"): the user's message is
 * the text without the blank lines before it and the space after it (a first
 * line's own indent stays), so it is the same text as the queued copy of the
 * same input and the text the user sent.
 */
export function withoutBlankLinesAround(text: string): string {
  let start = 0;
  let index = 0;
  while (index < text.length && /\s/.test(text[index]!)) {
    if (text[index] === "\n" || text[index] === "\r") start = index + 1;
    index += 1;
  }
  let end = text.length;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

/** The user's message from its text blocks and images; null when nothing is left. */
export function messageFrom(texts: readonly string[], images: readonly ChatAttachment[], id: string, time: number | null): ChatUserMessage | null {
  if (texts.length === 0 && images.length === 0) return null;
  const extracted = ChatAttachmentText.extract(withoutBlankLinesAround(texts.join("\n\n")));
  const attachments: ChatAttachment[] = [...images];
  for (let n = images.length; n < extracted.imageMarkers; n += 1) attachments.push(attachment());
  attachments.push(...extracted.attachments);
  if (extracted.text.length === 0 && attachments.length === 0) return null;
  return userMessage(id, extracted.text, time, attachments);
}

// MARK: - pasted text

const breakLength = (text: string, at: number): number => (text.startsWith("\r\n", at) ? 2 : text[at] === "\n" ? 1 : 0);
const breakBefore = (text: string, end: number, start: number): number => {
  if (end - 2 >= start && text.slice(end - 2, end) === "\r\n") return 2;
  return end - 1 >= start && text[end - 1] === "\n" ? 1 : 0;
};

/**
 * Claude Code writes text that reached it as a paste inside
 * `<pasted_content id="…">…</pasted_content>`: the user's message is the text inside,
 * the tags gone (one line break just inside each tag goes with it). Tags pair as
 * nested elements: each close closes the nearest open still open. Claude Code
 * 2.1.316 writes the close with the id too (`</pasted_content id="713e">`):
 * a close is the name then `>` or a space to its `>`; one with
 * an id closes the nearest open of that id still open (an open inside it, never
 * closed, stays as typed), and one whose id no open still open carries stays as
 * typed. An open never closed, a close never opened, or a name that only starts
 * the same is left as typed.
 */
export function unwrapPasted(text: string): string {
  if (!text.includes(pastedOpen)) return text;
  type Tag = { start: number; end: number; isOpen: boolean; id: string | null };
  const tags: Tag[] = [];
  let from = 0;
  while (from < text.length) {
    const open = text.indexOf(pastedOpen, from);
    const close = text.indexOf(pastedCloseName, from);
    let isOpen: boolean;
    let start: number;
    let afterName: number;
    if (close >= 0 && (open < 0 || close < open)) {
      [isOpen, start, afterName] = [false, close, close + pastedCloseName.length];
    } else if (open >= 0) {
      [isOpen, start, afterName] = [true, open, open + pastedOpen.length];
    } else {
      break;
    }
    const next = text[afterName];
    const tagEnd = text.indexOf(">", afterName);
    if (next === undefined || !(next === ">" || /\s/.test(next)) || tagEnd < 0) {
      from = afterName;
      continue;
    }
    from = tagEnd + 1;
    tags.push({ start, end: from, isOpen, id: pastedID(text.slice(afterName, tagEnd)) });
  }
  const opens: Tag[] = [];
  const cuts: { start: number; end: number }[] = [];
  for (const tag of tags) {
    if (tag.isOpen) {
      opens.push(tag);
      continue;
    }
    let open: Tag | undefined;
    if (tag.id !== null) {
      let index = opens.length - 1;
      while (index >= 0 && opens[index]!.id !== tag.id) index -= 1;
      if (index < 0) continue;
      open = opens[index];
      opens.length = index;
    } else {
      open = opens.pop();
    }
    if (open === undefined) continue;
    let contentStart = open.end;
    if (contentStart < tag.start) contentStart += breakLength(text, contentStart);
    let contentEnd = tag.start;
    if (contentEnd > contentStart) contentEnd -= breakBefore(text, contentEnd, contentStart);
    cuts.push({ start: open.start, end: contentStart });
    cuts.push({ start: contentEnd, end: tag.end });
  }
  if (cuts.length === 0) return text;
  let out = "";
  let kept = 0;
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    if (kept < cut.start) out += text.slice(kept, cut.start);
    kept = Math.max(kept, cut.end);
  }
  return out + text.slice(kept);
}

/**
 * A tag's `id` attribute (what follows its name, to its `>`): quoted with `"`
 * or `'`, or bare to a space; null when it has none.
 */
export function pastedID(attributes: string): string | null {
  const match = /(?:^|\s)id=(?:"([^"]*)"?|'([^']*)'?|([^\s/]*))/.exec(attributes);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

// MARK: - `!` commands

/**
 * The message Claude Code writes for a `!` command: `<bash-input>…</bash-input>`,
 * or its `<bash-stdout>` and `<bash-stderr>`, or both in that order, each once
 * and closed, with only whitespace between. Anything else is null: typed text.
 */
export function shellBlock(text: string): { input: string | null; output: ChatToolOutput | null } | null {
  let rest = text.trim();
  const parts = new Map<string, string>();
  let first: string | null = null;
  while (rest.length > 0) {
    const name = ["bash-input", "bash-stdout", "bash-stderr"].find((candidate) => rest.startsWith(`<${candidate}>`));
    if (name === undefined || parts.has(name) || (name === "bash-input" && parts.size > 0)) return null;
    const body = rest.slice(name.length + 2);
    const close = body.indexOf(`</${name}>`);
    if (close < 0) return null;
    parts.set(name, body.slice(0, close));
    first = first ?? name;
    rest = dropLeadingSpace(body.slice(close + name.length + 3));
  }
  if (first === null) return null;
  const stdout = parts.get("bash-stdout");
  const stderr = parts.get("bash-stderr");
  let output: ChatToolOutput | null = null;
  if (stdout !== undefined || stderr !== undefined) {
    output = toolOutput([stdout ?? "", stderr ?? ""].filter((part) => part.length > 0).join("\n"));
  }
  return { input: parts.get("bash-input") ?? null, output };
}

/** Claude Code starts a failed Bash result with "Exit code N". */
export function exitCode(text: string): { code: number | null; body: string } {
  const prefix = "Exit code ";
  if (!text.startsWith(prefix)) return { code: null, body: text };
  const rest = text.slice(prefix.length);
  const digits = /^[\p{N}-]*/u.exec(rest)?.[0] ?? "";
  if (!/^[+-]?\d+$/.test(digits)) return { code: null, body: text };
  let body = rest.slice(digits.length);
  if (body.startsWith("\n")) body = body.slice(1);
  return { code: Number(digits), body };
}

// MARK: - tools

export function claudeToolCall(id: string, name: string, input: JSONObject, time: number | null): ChatToolCall {
  const string = (key: string): string => asString(input[key]) ?? "";
  let kind: ChatToolKind;
  let target = "";
  let detail: ChatToolDetail = { type: "none" };
  switch (name) {
    case "Read":
    case "NotebookRead":
      kind = "read";
      target = [string("file_path"), string("notebook_path"), string("path")].find((value) => value.length > 0) ?? "";
      break;
    case "Edit":
      kind = "edit";
      target = string("file_path");
      detail = { type: "diff", diff: ChatDiffMaker.replacement(string("old_string"), string("new_string"), target) };
      break;
    case "MultiEdit": {
      kind = "edit";
      target = string("file_path");
      const edits = (asArray(input.edits) ?? []).filter(isObject).map((edit) => ({
        old: asString(edit.old_string) ?? "",
        new: asString(edit.new_string) ?? "",
      }));
      detail = { type: "diff", diff: ChatDiffMaker.replacements(edits, target) };
      break;
    }
    case "Write":
      kind = "edit";
      target = string("file_path");
      detail = { type: "diff", diff: ChatDiffMaker.written(string("content"), target) };
      break;
    case "NotebookEdit":
      kind = "edit";
      target = string("notebook_path");
      detail = {
        type: "diff",
        diff: string("edit_mode") === "delete" ? ChatDiffMaker.make([target], [], 0, 0) : ChatDiffMaker.written(string("new_source"), target),
      };
      break;
    case "Bash":
    case "Monitor": {
      kind = "bash";
      target = string("command");
      detail = { type: "bash", bash: bashDetail(target) };
      // A Monitor call, or a Bash call run in the background, is a task that runs on after its result.
      const background = ChatJSON.bool(input.run_in_background) || asString(input.run_in_background)?.toLowerCase() === "true";
      const described = string("description").trim().length > 0 ? firstLine(string("description")) : null;
      if (name === "Monitor" || background) {
        return { ...toolCall(id, kind, name, target, { detail, time }), task: backgroundTask(name === "Monitor" ? "monitor" : "shell", described ?? firstLine(target), time) };
      }
      // Kept for a Bash call Claude Code moves to the background (its result names a task).
      if (described !== null) return { ...toolCall(id, kind, name, target, { detail, time }), bashDescription: described };
      break;
    }
    case "Grep":
    case "Glob":
      kind = "search";
      target = string("pattern");
      detail = { type: "search", search: searchDetail(target) };
      break;
    case "WebFetch":
      kind = "web";
      target = string("url");
      break;
    case "WebSearch":
      kind = "web";
      target = string("query");
      break;
    case "Task":
    case "Agent": {
      kind = "agent";
      const prompt = string("prompt");
      target = string("description").length === 0 ? firstLine(prompt) : string("description");
      if (prompt.length > 0) detail = { type: "text", text: Array.from(prompt).slice(0, 2_000).join("") };
      // run_in_background is a bool or the string "true".
      const background = ChatJSON.bool(input.run_in_background) || asString(input.run_in_background)?.toLowerCase() === "true";
      return {
        ...toolCall(id, kind, name, target, { detail, time }),
        subagent: { type: string("subagent_type") || null, background, name: string("name") || null },
      };
    }
    case "TodoWrite": {
      kind = "plan";
      const todos = (asArray(input.todos) ?? []).filter(isObject);
      const steps: ChatPlanStep[] = todos.map((todo) => ({ text: asString(todo.content) ?? "", status: planStatus(todo.status) }));
      detail = { type: "plan", steps };
      const active = todos.find((todo) => planStatus(todo.status) === "inProgress");
      if (active !== undefined) target = asString(active.activeForm) ?? asString(active.content) ?? "";
      break;
    }
    default:
      kind = { other: otherToolName(name) };
      for (const key of ["description", "query", "command", "file_path", "path", "url", "pattern", "prompt"]) {
        const value = asString(input[key]);
        if (value !== null && value.length > 0) {
          target = firstLine(value);
          break;
        }
      }
  }
  return toolCall(id, kind, name, target, { detail, time });
}

/** `mcp__<server>__<tool>` shows as its tool name, like Codex's. */
export function otherToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : name;
}

export function planStatus(value: unknown): ChatPlanStatus {
  switch (asString(value)) {
    case "completed":
    case "done":
      return "completed";
    case "in_progress":
    case "in-progress":
    case "active":
      return "inProgress";
    default:
      return "pending";
  }
}

/** The first non-empty line, trimmed, cut at 200 characters. */
export function firstLine(text: string): string {
  const stripped = text.replace(/^\n+/, "");
  const newline = stripped.indexOf("\n");
  const line = newline < 0 ? stripped : stripped.slice(0, newline);
  const trimmed = Array.from(trimSpaces(line));
  return trimmed.length > 200 ? trimmed.slice(0, 200).join("") + "…" : trimmed.join("");
}
