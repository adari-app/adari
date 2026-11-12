// Builds the timeline from parser events: turns, tool calls paired with their
// results, the item cap, and earlier history put in front at a seam. No I/O; the
// feed owns one per followed file. A port of HerdrKit's ChatTimelineBuilder.swift,
// with progress rows for live work.

import {
  agentWork,
  backgroundTask,
  endingTask,
  itemID,
  itemTime,
  itemWithID,
  makeTurn,
  runningIn,
  stoppingAllWork,
  stoppingForegroundAgents,
  taskWork,
  turnHasAgentOutput,
  turnToolCalls,
  turnUserMessage,
  type ChatAgentMessage,
  type ChatAgentText,
  type ChatItem,
  type ChatRunningWork,
  type ChatSubagent,
  type ChatSubagents,
  type ChatTaskNoticeStatus,
  type ChatTimeline,
  type ChatToolCall,
  type ChatToolOutput,
  type ChatTurn,
  type ChatUserMessage,
  type TranscriptEvent,
  withTaskShown,
} from "./model";
import { ChatToolResults } from "./tools";

export const defaultMaxItems = 200;
/** The most items held once earlier history is loaded (`prepend`); past it the oldest go. */
export const defaultHistoryCap = 2_000;
/** Tool results and dropped calls kept to finish calls read later. */
const keptForLaterCalls = 256;
/**
 * Background work (task calls, subagents) a trim let go is kept apart from ordinary calls: one
 * still running is never let go for room (only past this many in all, which no session reaches); one that ended,
 * the oldest first, past the history cap (as much as Load earlier can bring back), so its start read again never
 * runs again.
 */
const keptRunningWorkCeiling = 8_192;

interface Position {
  readonly turn: number;
  readonly item: number;
}

interface Orphan {
  readonly output: ChatToolOutput;
  readonly time: number | null;
}

/** What `prepend` did. */
export interface PrependResult {
  /** Items added before the held ones. */
  readonly added: number;
  /** Items of `older` left out because the cap was reached. */
  readonly droppedForCap: number;
  /** Where the earliest held line now starts (null without offsets). */
  readonly start: number | null;
}

const copyTurn = (turn: ChatTurn): ChatTurn => ({ ...turn, items: [...turn.items] });
const isUser = (item: ChatItem): boolean => item.type === "user";
const isPlan = (item: ChatItem): boolean => item.type === "toolCall" && item.value.kind === "plan";

// MARK: - subagents

/** The `agentId:` a background launch's result names. */
export function launchedAgentID(text: string): string | null {
  for (const key of ["agentId:", "agent_id:", 'agentId":', "agentId ="]) {
    const at = text.indexOf(key);
    if (at < 0) continue;
    const match = /^[ "]*([\p{L}\p{N}._-]+)/u.exec(text.slice(at + key.length));
    if (match !== null) return match[1]!;
  }
  return null;
}

/** A foreground result as its report: without the trailing `agentId:` line and what Claude Code writes after it. */
export function subagentReport(text: string): string {
  const trimmed = text.trim();
  const marker = trimmed.indexOf("\nagentId:");
  if (marker < 0) return trimmed;
  const kept = trimmed.slice(0, marker).trim();
  return kept.length === 0 ? trimmed : kept;
}

/** A foreground agent's result is its report and its end; a background one's only says it started (and its id). */
function subagentResult(output: ChatToolOutput, agent: ChatSubagent, time: number | null): ChatSubagent {
  if (agent.background && !output.isError) return agent.agentID === null ? { ...agent, agentID: launchedAgentID(output.text) } : agent;
  if (agent.state !== "running") return agent;
  return { ...agent, state: output.isError ? "failed" : "done", finishedAt: time ?? agent.finishedAt, report: subagentReport(output.text) };
}

/** A task notification as the builder keeps it. */
interface Notified {
  readonly failed: boolean;
  readonly report: string | null;
  readonly time: number | null;
  /** What it says of a background task (a monitor's event, or its end). */
  readonly status: ChatTaskNoticeStatus;
  readonly event: string | null;
  readonly exitCode: number | null;
}

/** A task notification ends its (running) subagent. */
function subagentNotified(notified: Notified, agent: ChatSubagent): ChatSubagent {
  if (agent.state !== "running" || notified.status === "event") return agent;
  if (notified.status === "stopped" || notified.status === "killed") return { ...agent, state: "stopped", finishedAt: notified.time ?? agent.finishedAt };
  return {
    ...agent,
    state: notified.failed ? "failed" : "done",
    finishedAt: notified.time ?? agent.finishedAt,
    report: agent.report === null || agent.report.length === 0 ? notified.report : agent.report,
  };
}

/** A hand-back ends its subagent and is its report. */
function subagentHandBack(message: ChatAgentMessage, agent: ChatSubagent): ChatSubagent {
  let next = agent;
  if (next.state === "running") next = { ...next, state: "done", finishedAt: message.time ?? next.finishedAt };
  if (next.report === null || next.report.length === 0) next = { ...next, report: message.text };
  return next;
}

// MARK: background tasks

/** A launch result's task id in its text: `… with ID: <id>.` or `Monitor started (task <id>, …)`. */
export function taskIDInText(text: string): string | null {
  for (const pattern of [/\bID: ([\p{L}\p{N}_-]+)/u, /\(task ([\p{L}\p{N}_-]+)[,)]/u, /\btask ([\p{L}\p{N}_-]+)[,).]/u]) {
    const match = pattern.exec(text);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** A task call's launch result: the call returned (ok, or failed with its task), the task runs on under the id it names. */
function taskLaunched(output: ChatToolOutput, call: ChatToolCall, time: number | null): ChatToolCall {
  let next = ChatToolResults.apply(output, call, time);
  let task = call.task;
  // A Bash call Claude Code moved to the background (its result names a task) is a task now,
  // titled by its description as run_in_background's, else its command's first line.
  if (task === undefined && call.toolName === "Bash" && !output.isError && output.taskID != null) {
    task = backgroundTask("shell", call.bashDescription ?? call.target.split("\n")[0]!.trim(), call.time);
  }
  if (task === undefined) return next;
  if (next.state === "failed") return withTaskShown({ ...next, task: { ...task, state: "failed", finishedAt: time ?? task.finishedAt, exitCode: output.exitCode } });
  const taskID = task.taskID ?? output.taskID ?? taskIDInText(output.text);
  // The launch's words are not its command's output.
  const command = call.detail.type === "bash" ? call.detail.bash.command : call.target;
  if (next.detail.type === "bash") next = { ...next, detail: { type: "bash", bash: { ...next.detail.bash, command, outputTail: [], exitCode: null } } };
  return withTaskShown({ ...next, state: "ok", task: { ...task, taskID } });
}

/** A notice for `call`'s task: a monitor's event keeps its newest, an end ends it; a task already ended stays as it was. */
function taskNotified(notified: Notified, call: ChatToolCall): ChatToolCall {
  const task = call.task;
  if (task === undefined || task.state !== "running") return call;
  if (notified.status === "event") return notified.event === null ? call : withTaskShown({ ...call, task: { ...task, lastEvent: notified.event } });
  return endingTask(call, notified.status, notified.time, { lastEvent: notified.event, exitCode: notified.exitCode });
}

/** Whether `call`'s task is the one a notice or a TaskStop names. */
const namesTask = (call: ChatToolCall, keys: readonly string[]): boolean =>
  call.task !== undefined && keys.some((key) => key === call.id || (call.task!.taskID !== null && key === call.task!.taskID));

/**
 * `work` by its start, the oldest first. Ties and unknown starts keep the order they
 * came in (`order`: each call's ordinal, first seen; one without goes after those, in the timeline's order); an
 * unknown start counts as the one that came in before it (none before, it goes first).
 */
function oldestFirst(work: readonly ChatRunningWork[], order: (id: string) => number | undefined): ChatRunningWork[] {
  const arrived = work
    .map((item, index) => ({ item, ordinal: order(item.id) ?? Number.POSITIVE_INFINITY, index }))
    .sort((a, b) => (a.ordinal === b.ordinal ? a.index - b.index : a.ordinal - b.ordinal));
  let carried = -Infinity;
  const keyed = arrived.map((entry, rank) => {
    if (entry.item.startedAt !== null) carried = entry.item.startedAt;
    return { item: entry.item, at: carried, rank };
  });
  keyed.sort((a, b) => (a.at === b.at ? a.rank - b.rank : a.at - b.at));
  return keyed.map((entry) => entry.item);
}

/**
 * `order` (oldest first) with the ended ones past `endedCap` let go, the oldest first (`drop`), and,
 * past `keptRunningWorkCeiling` in all, the oldest whatever it is; one running never goes for an ended one.
 */
function keptWork(order: readonly string[], runs: (id: string) => boolean, endedCap: number, drop: (id: string) => void): string[] {
  let ended = order.reduce((n, id) => (runs(id) ? n : n + 1), 0);
  let excess = Math.max(0, order.length - keptRunningWorkCeiling);
  if (ended <= endedCap && excess === 0) return [...order];
  const kept: string[] = [];
  for (const id of order) {
    if (excess > 0) {
      excess -= 1;
      if (!runs(id)) ended -= 1;
      drop(id);
      continue;
    }
    if (ended > endedCap && !runs(id)) {
      ended -= 1;
      drop(id);
      continue;
    }
    kept.push(id);
  }
  return kept;
}

/** A foreground subagent of the turn is still running: its call waits. */
const hasForegroundRunning = (turn: ChatTurn): boolean =>
  turn.items.some((item) => item.type === "agents" && item.value.agents.some((agent) => !agent.background && agent.state === "running"));
const minOf = (values: Iterable<number>): number | null => {
  let min: number | null = null;
  for (const value of values) if (min === null || value < min) min = value;
  return min;
};

/** The newest `maxItems` items, whole turns where they fit; the oldest kept turn may lose its first items and is then partial. */
export function newestTurns(turns: readonly ChatTurn[], maxItems: number): ChatTurn[] {
  let remaining = maxItems;
  const kept: ChatTurn[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.items.length <= remaining) {
      kept.push(copyTurn(turn));
      remaining -= turn.items.length;
      if (remaining === 0) break;
    } else {
      const cut: ChatTurn = { ...turn, items: turn.items.slice(turn.items.length - remaining), isPartial: true };
      if (cut.items.length > 0) kept.push(cut);
      break;
    }
  }
  return kept.reverse();
}

export class ChatTimelineBuilder {
  /** The timeline keeps the newest `maxItems` items; older ones fall off the top. */
  readonly maxItems: number;
  /** The most items it ever keeps, earlier history loaded. */
  readonly historyCap: number;
  /** The items shown: `maxItems` until earlier history is prepended, then all held up to `historyCap`. */
  limit: number;
  /** Counts the trims: each moves `keptStart`. */
  trimSerial = 0;
  /** After a trim, the offset of the earliest line still in the timeline. */
  keptStart: number | null = null;
  /** You read away from the newest: what arrives is added below what is shown, which grows instead of its top moving. */
  keepsTop = false;
  /** Counts arrivals that moved the top of what is shown. */
  topMoves = 0;

  private turns: ChatTurn[] = [];
  private callPositions = new Map<string, Position>();
  /** Each subagent's row (by its call's id). */
  private agentPositions = new Map<string, Position>();
  private itemIDs = new Set<string>();
  private aiTitle: string | null = null;
  private customTitle: string | null = null;
  private turnSerial = 0;
  private itemSerial = 0;
  /** Where each held item's line starts (when the feed gave offsets). */
  private itemOffsets = new Map<string, number>();
  /** The line being applied. */
  private currentOffset: number | null = null;
  /** Results whose call is not held: they finish it when earlier history brings it. */
  private orphanResults = new Map<string, Orphan>();
  private orphanOrder: string[] = [];
  /** Finished calls a trim let go: a later read of their lines gets their end back. */
  private droppedCalls = new Map<string, ChatToolCall>();
  /** The ordinary calls in `droppedCalls`, oldest first (at most `keptForLaterCalls`). */
  private droppedOrder: string[] = [];
  /** The task calls in `droppedCalls`, oldest first: never let go for the ordinary ones. */
  private droppedTaskOrder: string[] = [];
  /**
   * Task notifications naming no held subagent (by task
   * id), and finished subagents a trim let go (by call id): a later read of
   * their starts gets their end back, as calls do.
   */
  private orphanNotifications = new Map<string, Notified>();
  private orphanNotificationOrder: string[] = [];
  private droppedAgents = new Map<string, ChatSubagent>();
  private droppedAgentOrder: string[] = [];
  /**
   * Each Bash, Monitor and Agent call's insertion ordinal, given when first seen and kept across
   * its row's grouping, trims and Load earlier (the older part's go first): the Running strip's order for equal or
   * unknown starts. An ordinary call's goes once it returns no task, a dropped one's once it is let go.
   */
  private workOrder = new Map<string, number>();
  private nextWorkOrder = 0;
  private firstWorkOrder = 0;
  /** The earliest session end read or told: work older lines left running is over by then. */
  private sessionEndedAt: number | null = null;
  private sessionEnded = false;
  private prependSerial = 0;
  /** Where the line that ended each finished turn starts (by turn id). */
  private finishedBy = new Map<string, number>();
  /**
   * The items of queued messages. One that opens a turn was
   * read with no turn running: earlier history that ends in a running turn
   * takes it in, as one parse of the file would have.
   */
  private queuedItems = new Set<string>();
  private showsAllHeld = false;

  constructor(maxItems: number = defaultMaxItems, historyCap: number = defaultHistoryCap) {
    this.maxItems = Math.max(1, maxItems);
    this.historyCap = Math.max(this.maxItems, historyCap);
    this.limit = this.maxItems;
  }

  /** A copy that changes on its own (Swift's value semantics). */
  clone(): ChatTimelineBuilder {
    const copy = new ChatTimelineBuilder(this.maxItems, this.historyCap);
    copy.limit = this.limit;
    copy.trimSerial = this.trimSerial;
    copy.keptStart = this.keptStart;
    copy.keepsTop = this.keepsTop;
    copy.topMoves = this.topMoves;
    copy.turns = this.turns.map(copyTurn);
    copy.callPositions = new Map(this.callPositions);
    copy.agentPositions = new Map(this.agentPositions);
    copy.itemIDs = new Set(this.itemIDs);
    copy.aiTitle = this.aiTitle;
    copy.customTitle = this.customTitle;
    copy.turnSerial = this.turnSerial;
    copy.itemSerial = this.itemSerial;
    copy.itemOffsets = new Map(this.itemOffsets);
    copy.currentOffset = this.currentOffset;
    copy.orphanResults = new Map(this.orphanResults);
    copy.orphanOrder = [...this.orphanOrder];
    copy.droppedCalls = new Map(this.droppedCalls);
    copy.droppedOrder = [...this.droppedOrder];
    copy.droppedTaskOrder = [...this.droppedTaskOrder];
    copy.orphanNotifications = new Map(this.orphanNotifications);
    copy.orphanNotificationOrder = [...this.orphanNotificationOrder];
    copy.droppedAgents = new Map(this.droppedAgents);
    copy.droppedAgentOrder = [...this.droppedAgentOrder];
    copy.workOrder = new Map(this.workOrder);
    copy.nextWorkOrder = this.nextWorkOrder;
    copy.firstWorkOrder = this.firstWorkOrder;
    copy.sessionEndedAt = this.sessionEndedAt;
    copy.sessionEnded = this.sessionEnded;
    copy.prependSerial = this.prependSerial;
    copy.finishedBy = new Map(this.finishedBy);
    copy.queuedItems = new Set(this.queuedItems);
    copy.showsAllHeld = this.showsAllHeld;
    return copy;
  }

  /** The newest `limit` items as a timeline. */
  get timeline(): ChatTimeline {
    const turns = newestTurns(this.turns, this.limit);
    // What runs out of the window counts too.
    const held = runningIn(this.turns);
    const shown = runningIn(turns);
    const hiddenRunning = { background: held.background - shown.background, foreground: held.foreground - shown.foreground };
    return { turns, title: this.customTitle ?? this.aiTitle, earlier: "none", newerWaiting: false, hiddenRunning, running: this.runningWork() };
  }

  /**
   * Every task and subagent running, held or let go by a trim, oldest first: the Running strip's items,
   * by their start; ties and unknown starts in the order they came in (`oldestFirst`).
   */
  runningWork(): ChatRunningWork[] {
    const work: ChatRunningWork[] = [];
    const seen = new Set<string>();
    const add = (item: ChatRunningWork | null): void => {
      if (item === null || seen.has(item.id)) return;
      seen.add(item.id);
      work.push(item);
    };
    for (const id of this.droppedTaskOrder) {
      const call = this.droppedCalls.get(id);
      if (call !== undefined) add(taskWork(call));
    }
    for (const id of this.droppedAgentOrder) {
      const agent = this.droppedAgents.get(id);
      if (agent !== undefined) add(agentWork(agent));
    }
    for (const turn of this.turns) {
      for (const item of turn.items) {
        if (item.type === "toolCall") add(taskWork(item.value));
        else if (item.type === "agents") for (const agent of item.value.agents) add(agentWork(agent));
      }
    }
    return oldestFirst(work, (id) => this.workOrder.get(id));
  }

  /** Every item held, shown or not. */
  get heldItemCount(): number {
    return this.turns.reduce((n, turn) => n + turn.items.length, 0);
  }

  /** Items held but not shown (older than the newest `limit`). */
  get hiddenItemCount(): number {
    return Math.max(0, this.heldItemCount - this.limit);
  }

  /** Whether everything held shows: the limit grows with what arrives. */
  get hasEarlierHistory(): boolean {
    return this.showsAllHeld;
  }

  /** Shows every item held (up to the cap); from now on what arrives shows with them. */
  showHeld(): void {
    this.showsAllHeld = true;
    this.limit = Math.min(this.historyCap, Math.max(this.limit, this.heldItemCount));
  }

  /**
   * You follow the newest again. What the shown limit grew by while you read up
   * (`keepsTop`, one item per arrival up to `historyCap`) goes: back to `maxItems`, so a long session
   * neither holds the ceiling on show while following nor starts your next read-up at it. Earlier history
   * you loaded (or a cold load's screenful) stays on show.
   */
  followNewest(): void {
    this.keepsTop = false;
    if (!this.showsAllHeld) this.limit = this.maxItems;
  }

  /** Whether no more earlier history fits. */
  get isAtHistoryCap(): boolean {
    return this.limit >= this.historyCap;
  }

  /** One transcript line's events, read at `offset` (or events with no line, `offset` null). */
  apply(events: readonly TranscriptEvent[], offset: number | null = null): void {
    this.currentOffset = offset;
    try {
      for (const event of events) this.applyEvent(event);
    } finally {
      this.currentOffset = null;
    }
  }

  applyEvent(event: TranscriptEvent): void {
    switch (event.type) {
      case "userMessage":
        this.open(event.message, event.queued === true);
        break;
      case "userWithdrawn":
        this.remove(new Set([event.id]));
        break;
      case "agentText": {
        const index = this.ensureRunningTurn(event.text.time);
        this.append({ type: "agentText", value: event.text }, index, event.text.time);
        break;
      }
      case "agentProgress": {
        const index = this.ensureRunningTurn(event.text.time);
        this.append({ type: "progress", value: event.text }, index, event.text.time);
        break;
      }
      case "toolStarted": {
        let call = event.call;
        this.noteWork(call);
        if (call.subagent !== undefined) {
          // In its turn's subagents row.
          if (this.agentPositions.has(call.id) || this.callPositions.has(call.id)) return;
          this.startSubagent(call);
          break;
        }
        if (this.callPositions.has(call.id)) return; // written twice: keep the first
        if (call.resultSummary === null) call = { ...call, resultSummary: ChatToolResults.startingSummary(call) };
        const running = this.runningIndex;
        if (call.kind === "plan" && running !== null) {
          const items = this.turns[running]!.items;
          const planIndex = items.findLastIndex(isPlan);
          if (planIndex >= 0) {
            // The checklist is updated in place: one Plan row per turn.
            const item = items[planIndex]!;
            if (item.type !== "toolCall") return;
            const plan: ChatToolCall = {
              ...item.value,
              detail: call.detail,
              target: call.target,
              resultSummary: call.resultSummary,
              state: "running",
              time: call.time ?? item.value.time,
            };
            items[planIndex] = { type: "toolCall", value: plan };
            this.callPositions.set(call.id, { turn: running, item: planIndex });
            this.touch(running, call.time);
            return;
          }
        }
        const index = this.ensureRunningTurn(call.time);
        this.append({ type: "toolCall", value: call }, index, call.time);
        break;
      }
      case "toolFinished": {
        const position = this.callPositions.get(event.id);
        const item = position === undefined ? undefined : this.turns[position.turn]?.items[position.item];
        if (position === undefined || item === undefined || item.type !== "toolCall") {
          if (!this.finishSubagent(event.id, event.output, event.time)) this.keepOrphan(event.id, { output: event.output, time: event.time });
          return;
        }
        // A task's launch result: its call returned, the task runs on (ended already by a notice read first: it stays so).
        let finished = taskLaunched(event.output, item.value, event.time);
        // An ordinary call that returned no task needs no place among the running.
        if (finished.task === undefined) this.workOrder.delete(finished.id);
        if (finished.task !== undefined && finished.task.state === "running") finished = this.withKeptNotice(finished);
        this.turns[position.turn]!.items[position.item] = { type: "toolCall", value: finished };
        if (position.turn === this.runningIndex) this.touch(position.turn, event.time);
        break;
      }
      case "userShell": {
        const call: ChatToolCall = { ...event.call, isUserShell: true };
        const running = this.runningIndex;
        if (running !== null) {
          this.append({ type: "toolCall", value: call }, running, call.time);
        } else {
          const index = this.openTurn(call.time, false);
          this.append({ type: "toolCall", value: call }, index, call.time);
          this.finish(index, call.time, null);
        }
        break;
      }
      case "notice": {
        const { notice } = event;
        const running = this.runningIndex;
        if (running !== null) {
          this.append({ type: "notice", value: notice }, running, notice.time);
          if (event.endsTurn) this.finish(running, notice.time, null);
        } else if (notice.kind === "interrupted" && this.turns.length > 0 && this.turns.at(-1)!.items.length > 0) {
          // Your Esc landed as the reply was already complete: the turn it
          // stopped ends with the stop, its "Worked for" giving way to the stopped row.
          const index = this.turns.length - 1;
          this.turns[index] = copyTurn(this.turns[index]!);
          this.append({ type: "notice", value: notice }, index, notice.time);
        } else {
          const index = this.openTurn(notice.time, false);
          this.append({ type: "notice", value: notice }, index, notice.time);
          this.finish(index, notice.time, null);
        }
        break;
      }
      case "turnStarted": {
        const running = this.runningIndex;
        if (running !== null) {
          if (!turnHasAgentOutput(this.turns[running]!)) return;
          this.finish(running, null, null);
        }
        this.openTurn(event.time, false);
        break;
      }
      case "turnCompleted": {
        const running = this.runningIndex;
        if (running === null) return;
        this.finish(running, event.time, event.duration);
        break;
      }
      case "turnBegan": {
        // Only a turn the window began inside takes it (one your message opened keeps that time).
        const running = this.runningIndex;
        if (running === null) return;
        const turn = this.turns[running]!;
        if (turn.isPartial && (turn.startedAt === null || event.time < turn.startedAt)) turn.startedAt = event.time;
        break;
      }
      case "agentStopped": {
        const running = this.runningIndex;
        if (running === null) return;
        const waiting =
          turnToolCalls(this.turns[running]!).some((call) => call.state === "running" && !call.isUserShell) || hasForegroundRunning(this.turns[running]!);
        if (waiting) return;
        this.finish(running, event.time, null);
        break;
      }
      case "turnMeasured": {
        // The turn it measures: the newest (ended just before it; one with no
        // end read yet keeps it for when it ends).
        const last = this.turns.length - 1;
        if (last < 0 || event.duration < 0) return;
        this.turns[last]!.reportedDuration = event.duration;
        break;
      }
      case "title": {
        const trimmed = event.value.trim();
        if (trimmed.length > 0) this.aiTitle = trimmed;
        break;
      }
      case "customTitle": {
        const trimmed = event.value.trim();
        if (trimmed.length > 0) this.customTitle = trimmed;
        break;
      }
      case "agentMessage": {
        const { message } = event;
        const id = message.kind === "report" ? this.subagentNamed(message.from) : null;
        if (id !== null) {
          this.updateSubagent(id, (agent) => subagentHandBack(message, agent));
          const position = this.agentPositions.get(id);
          if (position !== undefined && position.turn === this.runningIndex) this.touch(position.turn, message.time);
          return;
        }
        // Never your message: it starts no turn (the window's first item aside, which has none to land in) and ends none.
        const index = this.runningIndex ?? (this.turns.length > 0 ? this.turns.length - 1 : this.openTurn(message.time, true));
        this.append({ type: "agentMessage", value: message }, index, message.time);
        break;
      }
      case "agentTextChunk": {
        // A part of the reply (or the thinking) joins the running turn's newest item of its id.
        const { text, progress } = event;
        const index = this.ensureRunningTurn(text.time);
        const items = this.turns[index]!.items;
        const last = items[items.length - 1];
        if (last !== undefined && last.value.id === text.id && last.type === (progress ? "progress" : "agentText")) {
          const held = last.value as ChatAgentText;
          items[items.length - 1] = { type: last.type, value: { ...held, markdown: held.markdown + text.markdown } } as ChatItem;
          this.touch(index, text.time);
          return;
        }
        this.append(progress ? { type: "progress", value: text } : { type: "agentText", value: text }, index, text.time);
        break;
      }
      case "userMessageAmended": {
        // Your message with more of it, where it is.
        const { message } = event;
        for (let turn = this.turns.length - 1; turn >= 0; turn -= 1) {
          const items = this.turns[turn]!.items;
          const at = items.findIndex((item) => item.value.id === message.id);
          const item = items[at];
          if (item === undefined || item.type !== "user") continue;
          items[at] = { type: "user", value: { ...item.value, text: message.text, attachments: message.attachments } };
          return;
        }
        this.applyEvent({ type: "userMessage", message });
        return;
      }
      case "toolRevised": {
        // More of what a started call is; a call not held starts.
        const revised = event.call;
        const position = this.callPositions.get(revised.id);
        const item = position === undefined ? undefined : this.turns[position.turn]?.items[position.item];
        if (position === undefined || item === undefined || item.type !== "toolCall") {
          this.applyEvent({ type: "toolStarted", call: revised });
          return;
        }
        const held = item.value;
        // A finished command keeps the output its result gave it.
        const keepsOutput = held.detail.type === "bash" && held.state !== "running";
        let call: ChatToolCall = {
          ...held,
          kind: revised.kind,
          toolName: revised.toolName,
          target: revised.target,
          program: revised.program,
          detail: revised.detail.type !== "none" && !keepsOutput ? revised.detail : held.detail,
        };
        if (call.state === "running") call = { ...call, resultSummary: ChatToolResults.startingSummary(call) };
        this.turns[position.turn]!.items[position.item] = { type: "toolCall", value: call };
        break;
      }
      case "taskNotified": {
        const notified: Notified = {
          failed: event.failed,
          report: event.report,
          time: event.time,
          status: event.status ?? (event.failed ? "failed" : "done"),
          event: event.event ?? null,
          exitCode: event.exitCode ?? null,
        };
        const keys = [event.id, event.toolUseID ?? null].filter((key): key is string => key !== null && key.length > 0);
        const id = this.subagentExactly(event.id) ?? (event.toolUseID == null ? null : this.subagentExactly(event.toolUseID));
        if (id !== null) {
          this.updateSubagent(id, (agent) => subagentNotified(notified, agent));
          break;
        }
        // A background task's notice (the second and third copies find it ended and change nothing).
        if (this.updateTask(keys, (call) => taskNotified(notified, call))) break;
        if (this.updateDroppedAgent(keys, (agent) => subagentNotified(notified, agent))) return;
        for (const key of keys) this.keepNotification(key, notified);
        return;
      }
      case "taskStopped": {
        const stopped: Notified = { failed: false, report: null, time: event.time, status: "stopped", event: null, exitCode: null };
        if (this.updateTask([event.id], (call) => endingTask(call, "stopped", event.time))) break;
        const id = this.subagentExactly(event.id);
        if (id !== null) {
          this.updateSubagent(id, (agent) => (agent.background ? subagentNotified(stopped, agent) : agent));
          break;
        }
        if (this.updateDroppedAgent([event.id], (agent) => (agent.background ? subagentNotified(stopped, agent) : agent))) return;
        this.keepNotification(event.id, stopped);
        return;
      }
      case "sessionChanged": {
        this.stopAllWork(event.time);
        return;
      }
    }
    this.trimIfNeeded();
  }

  // MARK: background tasks

  /**
   * Changes the task call a notice or TaskStop names (by its task id or call
   * id), held or let go by a trim, newest first; false when none is.
   */
  private updateTask(keys: readonly string[], change: (call: ChatToolCall) => ChatToolCall): boolean {
    for (let turnIndex = this.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const items = this.turns[turnIndex]!.items;
      for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const item = items[itemIndex]!;
        if (item.type !== "toolCall" || !namesTask(item.value, keys)) continue;
        items[itemIndex] = { type: "toolCall", value: change(item.value) };
        return true;
      }
    }
    for (const [id, call] of this.droppedCalls) {
      if (!namesTask(call, keys)) continue;
      this.droppedCalls.set(id, change(call));
      return true;
    }
    return false;
  }

  /** A subagent a trim let go while it ran: a notice or TaskStop naming it still ends it. */
  private updateDroppedAgent(keys: readonly string[], change: (agent: ChatSubagent) => ChatSubagent): boolean {
    for (const [id, agent] of this.droppedAgents) {
      if (!keys.some((key) => key === agent.id || key === agent.agentID || key === agent.name)) continue;
      this.droppedAgents.set(id, change(agent));
      return true;
    }
    return false;
  }

  /** A task call with the notice read before its id was known (held for its task id or call id) applied. */
  private withKeptNotice(call: ChatToolCall): ChatToolCall {
    const keys = [call.id, call.task?.taskID ?? null].filter((key): key is string => key !== null);
    let next = call;
    for (const key of keys) {
      const notified = this.orphanNotifications.get(key);
      if (notified === undefined) continue;
      next = taskNotified(notified, next);
      this.orphanNotifications.delete(key);
      this.orphanNotificationOrder = this.orphanNotificationOrder.filter((id) => id !== key);
    }
    return next;
  }

  /** Every task and subagent running stops at `time`: the session ended (a new one in the file, or the agent gone). */
  private stopAllWork(time: number | null): void {
    if (!this.sessionEnded || (time !== null && (this.sessionEndedAt === null || time < this.sessionEndedAt))) this.sessionEndedAt = time ?? this.sessionEndedAt;
    this.sessionEnded = true;
    this.turns.forEach((turn, index) => {
      const running = turn.items.some((item) => (item.type === "toolCall" && item.value.task?.state === "running") || (item.type === "agents" && item.value.agents.some((agent) => agent.state === "running")));
      if (running) this.turns[index] = { ...turn, items: stoppingAllWork(turn, time) };
    });
    for (const [id, call] of this.droppedCalls) if (call.task?.state === "running") this.droppedCalls.set(id, endingTask(call, "stopped", time));
    for (const [id, agent] of this.droppedAgents) if (agent.state === "running") this.droppedAgents.set(id, { ...agent, state: "stopped", finishedAt: time ?? agent.finishedAt });
  }

  /**
   * The session ended (the agent exited, or a new run
   * started in the pane): its running turn ends, and every task and subagent
   * still running is stopped at `time`; a notice read after it changes nothing.
   */
  endSession(time: number | null): void {
    const running = this.runningIndex;
    if (running !== null) this.finish(running, time ?? this.turns[running]!.lastEventAt, null);
    this.stopAllWork(time);
  }

  // MARK: subagents

  /** An Agent call joins its turn's subagents row (made where the first started). */
  private startSubagent(call: ChatToolCall): void {
    const launch = call.subagent;
    if (launch === undefined) return;
    const agent: ChatSubagent = {
      id: call.id,
      description: call.target,
      type: launch.type,
      background: launch.background,
      name: launch.name,
      agentID: null,
      prompt: call.detail.type === "text" ? call.detail.text : null,
      state: "running",
      startedAt: call.time,
      finishedAt: null,
      report: null,
    };
    const index = this.ensureRunningTurn(call.time);
    const turn = this.turns[index]!;
    const itemIndex = turn.items.findIndex((item) => item.type === "agents");
    const existing = turn.items[itemIndex];
    if (existing !== undefined && existing.type === "agents") {
      turn.items[itemIndex] = { type: "agents", value: { ...existing.value, agents: [...existing.value.agents, agent] } };
      this.agentPositions.set(call.id, { turn: index, item: itemIndex });
      if (this.currentOffset !== null && !this.itemOffsets.has(existing.value.id)) this.itemOffsets.set(existing.value.id, this.currentOffset);
      this.touch(index, call.time);
    } else {
      const group: ChatSubagents = { id: "agents-" + call.id, agents: [agent], time: call.time };
      this.append({ type: "agents", value: group }, index, call.time);
    }
    this.joinHeldReport(call.id);
  }

  /**
   * A report row held for a sender this subagent is now
   * known by (its launch id, its name, its call id) joins it: it ends the agent
   * and is its report, and the row goes.
   */
  private joinHeldReport(id: string): void {
    const position = this.agentPositions.get(id);
    if (position === undefined) return;
    const group = this.turns[position.turn]?.items[position.item];
    if (group === undefined || group.type !== "agents") return;
    const agent = group.value.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) return;
    const names = new Set([agent.agentID, agent.name, agent.id].filter((name): name is string => name !== null));
    for (let turnIndex = 0; turnIndex < this.turns.length; turnIndex += 1) {
      const turn = this.turns[turnIndex]!;
      const itemIndex = turn.items.findIndex((item) => item.type === "agentMessage" && item.value.kind === "report" && item.value.from !== null && names.has(item.value.from));
      const item = turn.items[itemIndex];
      if (item === undefined || item.type !== "agentMessage") continue;
      this.updateSubagent(id, (current) => subagentHandBack(item.value, current));
      turn.items.splice(itemIndex, 1);
      if (turn.items.length === 0) this.turns.splice(turnIndex, 1);
      this.reindex();
      return;
    }
  }

  /** The subagents running, held or let go by a trim (their steps are read for these). */
  runningSubagents(): ChatSubagent[] {
    const agents: ChatSubagent[] = [];
    const seen = new Set<string>();
    const add = (agent: ChatSubagent): void => {
      if (agent.state !== "running" || seen.has(agent.id)) return;
      seen.add(agent.id);
      agents.push(agent);
    };
    for (const id of this.droppedAgentOrder) {
      const agent = this.droppedAgents.get(id);
      if (agent !== undefined) add(agent);
    }
    for (const turn of this.turns) for (const item of turn.items) if (item.type === "agents") item.value.agents.forEach(add);
    return agents;
  }

  /** Whether the subagent of call `id` still runs (held, or let go by a trim). */
  subagentRuns(id: string): boolean {
    const position = this.agentPositions.get(id);
    const item = position === undefined ? undefined : this.turns[position.turn]?.items[position.item];
    const held = item?.type === "agents" ? item.value.agents.find((agent) => agent.id === id) : undefined;
    return (held ?? this.droppedAgents.get(id))?.state === "running";
  }

  /** A running subagent's newest step (null: none); false when it changed nothing. */
  setSubagentStep(id: string, step: string | null): boolean {
    const differs = (agent: ChatSubagent): boolean => agent.state === "running" && (agent.step ?? null) !== step;
    const position = this.agentPositions.get(id);
    const item = position === undefined ? undefined : this.turns[position.turn]?.items[position.item];
    const held = item?.type === "agents" ? item.value.agents.find((agent) => agent.id === id) : undefined;
    if (held !== undefined) {
      if (!differs(held)) return false;
      return this.updateSubagent(id, (agent) => ({ ...agent, step }));
    }
    const dropped = this.droppedAgents.get(id);
    if (dropped === undefined || !differs(dropped)) return false;
    this.droppedAgents.set(id, { ...dropped, step });
    return true;
  }

  /** Changes the subagent of call `id` where it is held; false when none is. */
  private updateSubagent(id: string, change: (agent: ChatSubagent) => ChatSubagent): boolean {
    const position = this.agentPositions.get(id);
    if (position === undefined) return false;
    const item = this.turns[position.turn]?.items[position.item];
    if (item === undefined || item.type !== "agents") return false;
    const index = item.value.agents.findIndex((agent) => agent.id === id);
    if (index < 0) return false;
    const agents = [...item.value.agents];
    agents[index] = change(agents[index]!);
    this.turns[position.turn]!.items[position.item] = { type: "agents", value: { ...item.value, agents } };
    return true;
  }

  /** An Agent call's result: false when no subagent of that id is held. */
  private finishSubagent(id: string, output: ChatToolOutput, time: number | null): boolean {
    if (!this.updateSubagent(id, (agent) => subagentResult(output, agent, time))) {
      // One a trim let go while it ran ends too (and stays kept for Load earlier).
      const dropped = this.droppedAgents.get(id);
      if (dropped === undefined || dropped.state !== "running") return false;
      this.droppedAgents.set(id, subagentResult(output, dropped, time));
      return true;
    }
    const position = this.agentPositions.get(id);
    if (position !== undefined && position.turn === this.runningIndex) this.touch(position.turn, time);
    this.joinHeldReport(id);
    return true;
  }

  /**
   * The subagent a hand-back from `from` is: the one whose id, name or call id
   * it is (in any state), never one guessed by age; an
   * unknown sender's report is a row of its own until its agent is known by
   * that name (`joinHeldReport`).
   */
  private subagentNamed(from: string | null): string | null {
    return from === null ? null : this.subagentExactly(from);
  }

  private subagentExactly(from: string): string | null {
    for (let turnIndex = this.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      for (const item of this.turns[turnIndex]!.items) {
        if (item.type !== "agents") continue;
        const agent = item.value.agents.find((candidate) => candidate.agentID === from || candidate.name === from || candidate.id === from);
        if (agent !== undefined) return agent.id;
      }
    }
    return null;
  }

  // MARK: turns

  /**
   * Your message opens a turn. One the agent took while it worked (`queued`)
   * goes inside the running turn at its place: the turn keeps its start, its
   * open calls and its timer, and only a real completion finishes it.
   */
  private open(message: ChatUserMessage, queued = false): void {
    const running = this.runningIndex;
    let item: ChatItem;
    if (running !== null && (queued || (turnUserMessage(this.turns[running]!) === null && !turnHasAgentOutput(this.turns[running]!)))) {
      // Queued while it works, or a turn the agent opened (Codex task_started) that nothing has happened in yet.
      item = this.append({ type: "user", value: message }, running, message.time);
    } else {
      if (running !== null) this.finish(running, null, null);
      const index = this.openTurn(message.time, false);
      item = this.append({ type: "user", value: message }, index, message.time);
    }
    if (queued) this.queuedItems.add(itemID(item));
  }

  /** A queued message opened the turn: none was running when it was read. */
  private openedByQueue(turn: ChatTurn): boolean {
    const first = turn.items[0];
    return first !== undefined && first.type === "user" && this.queuedItems.has(itemID(first));
  }

  private get runningIndex(): number | null {
    const last = this.turns.length - 1;
    if (last < 0 || this.turns[last]!.isFinished) return null;
    return last;
  }

  private openTurn(time: number | null, partial: boolean): number {
    this.turnSerial += 1;
    this.turns.push(makeTurn(`turn-${this.turnSerial}`, { startedAt: time, lastEventAt: time, isPartial: partial }));
    return this.turns.length - 1;
  }

  /** The running turn, or a new one when the agent acts with no turn open (the window's first began before it). */
  private ensureRunningTurn(time: number | null): number {
    const running = this.runningIndex;
    if (running !== null) return running;
    return this.openTurn(time, this.turns.length === 0);
  }

  private finish(index: number, time: number | null, duration: number | null): void {
    const turn = this.turns[index]!;
    if (this.currentOffset !== null) this.finishedBy.set(turn.id, this.currentOffset);
    // A foreground subagent still running when its turn ends (an interrupt) stopped with it.
    if (hasForegroundRunning(turn)) turn.items = stoppingForegroundAgents(turn, time);
    turn.isFinished = true;
    if (time !== null) this.touch(index, time);
    turn.endedAt = time ?? turn.lastEventAt ?? turn.startedAt;
    // A measure read before its end (turnMeasured) stays when the end brings none.
    turn.reportedDuration = duration ?? turn.reportedDuration;
  }

  private touch(index: number, time: number | null): void {
    if (time === null) return;
    const turn = this.turns[index]!;
    if (turn.startedAt === null) turn.startedAt = time;
    if (turn.lastEventAt !== null && turn.lastEventAt >= time) return;
    turn.lastEventAt = time;
  }

  private append(item: ChatItem, index: number, time: number | null): ChatItem {
    const hiddenBefore = this.hiddenItemCount;
    const unique = this.uniqued(item);
    const turn = this.turns[index]!;
    turn.items.push(unique);
    if (unique.type === "toolCall") this.callPositions.set(unique.value.id, { turn: index, item: turn.items.length - 1 });
    if (unique.type === "agents") for (const agent of unique.value.agents) this.agentPositions.set(agent.id, { turn: index, item: turn.items.length - 1 });
    if (this.currentOffset !== null) this.itemOffsets.set(itemID(unique), this.currentOffset);
    this.touch(index, time);
    if (this.hasEarlierHistory) {
      this.limit = Math.min(this.historyCap, Math.max(this.limit, this.heldItemCount));
    } else if (this.keepsTop && this.heldItemCount > this.limit) {
      this.limit = Math.min(this.historyCap, this.limit + 1);
    }
    if (this.hiddenItemCount > hiddenBefore) this.topMoves += 1;
    return unique;
  }

  /** Gives an item a fresh id when its own is empty or already used, so the UI's identity stays unique. */
  private uniqued(item: ChatItem): ChatItem {
    const original = itemID(item);
    let id = original;
    if (id.length === 0 || this.itemIDs.has(id)) {
      do {
        this.itemSerial += 1;
        id = (original.length === 0 ? "item" : original) + `#${this.itemSerial}`;
      } while (this.itemIDs.has(id));
    }
    this.itemIDs.add(id);
    return id === original ? item : itemWithID(item, id);
  }

  /** The markdown of the held reply (or thinking) row `id`, or null. */
  textOf(id: string): string | null {
    for (const turn of this.turns) {
      for (const item of turn.items) {
        if ((item.type === "agentText" || item.type === "progress") && item.value.id === id) return item.value.markdown;
      }
    }
    return null;
  }

  /** `markdown` added to the end of the held reply (or thinking) row `id` (a run a seam cut). */
  extendText(id: string, markdown: string): void {
    for (const turn of this.turns) {
      turn.items = turn.items.map((item) =>
        (item.type === "agentText" || item.type === "progress") && item.value.id === id
          ? ({ type: item.type, value: { ...item.value, markdown: item.value.markdown + markdown } } as ChatItem)
          : item,
      );
    }
  }

  /**
   * Takes held items out (the later copy of an input an earlier part shows,
   * found at a history seam), as if its line had never been read: a message
   * that ended the turn before it gives that turn back its run; else its turn
   * is the agent's, begun with what came after it, or it goes when nothing did.
   */
  remove(ids: ReadonlySet<string>): void {
    if (ids.size === 0 || this.turns.length === 0) return;
    let index = 0;
    while (index < this.turns.length) {
      const turn = this.turns[index]!;
      const opener = turn.items[0];
      const count = turn.items.length;
      turn.items = turn.items.filter((item) => !ids.has(itemID(item)));
      if (turn.items.length >= count) {
        index += 1;
        continue;
      }
      const lostOpener = opener !== undefined && ids.has(itemID(opener)) && isUser(opener);
      const openerOffset = opener === undefined ? undefined : this.itemOffsets.get(itemID(opener));
      if (lostOpener && index > 0 && openerOffset !== undefined && this.finishedBy.get(this.turns[index - 1]!.id) === openerOffset) {
        // The message ended the turn before it: that turn runs on.
        const [removed] = this.turns.splice(index, 1);
        const previous = copyTurn(this.turns[index - 1]!);
        previous.items.push(...removed!.items);
        previous.isFinished = removed!.isFinished;
        previous.endedAt = removed!.endedAt;
        previous.reportedDuration = removed!.reportedDuration;
        if (removed!.lastEventAt !== null && (previous.lastEventAt ?? -Infinity) < removed!.lastEventAt) previous.lastEventAt = removed!.lastEventAt;
        const end = this.finishedBy.get(removed!.id);
        if (end === undefined) this.finishedBy.delete(previous.id);
        else this.finishedBy.set(previous.id, end);
        this.turns[index - 1] = previous;
        continue;
      }
      if (turn.items.length === 0) {
        this.turns.splice(index, 1);
        continue;
      }
      if (lostOpener) {
        if (index === 0) turn.isPartial = true;
        const first = turn.items[0];
        turn.startedAt = (first === undefined ? null : itemTime(first)) ?? turn.startedAt;
      }
      index += 1;
    }
    this.reindex();
  }

  /**
   * Shows `message` again (a history seam found it is not a copy after all)
   * where its line, at `offset`, puts it, as `apply` would have had it there.
   * A `queued` one goes inside the turn running at its line.
   */
  restore(message: ChatUserMessage, offset: number | null, queued = false): void {
    let place: Position | null = null;
    if (offset !== null) {
      search: for (let turnIndex = 0; turnIndex < this.turns.length; turnIndex += 1) {
        const items = this.turns[turnIndex]!.items;
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          const itemOffset = this.itemOffsets.get(itemID(items[itemIndex]!));
          if (itemOffset !== undefined && itemOffset > offset) {
            place = { turn: turnIndex, item: itemIndex };
            break search;
          }
        }
      }
    }
    const previous = place === null ? this.turns.length - 1 : place.item > 0 ? place.turn : place.turn - 1;
    const endedLater = ((): number | null => {
      if (offset === null || previous < 0 || !this.turns[previous]!.isFinished) return null;
      const end = this.finishedBy.get(this.turns[previous]!.id);
      return end !== undefined && end > offset ? end : null;
    })();
    if (place === null && endedLater === null) {
      // After everything held: as a new message.
      this.currentOffset = offset;
      try {
        this.open(message, queued);
      } finally {
        this.currentOffset = null;
      }
      return;
    }
    const item = this.uniqued({ type: "user", value: message });
    if (offset !== null) this.itemOffsets.set(itemID(item), offset);
    if (queued) this.queuedItems.add(itemID(item));
    const runningAt = queued ? (place !== null && place.item > 0 ? place : endedLater !== null ? { turn: previous, item: this.turns[previous]!.items.length } : null) : null;
    if (runningAt !== null) {
      // Queued while the agent worked: inside the turn running at its line, which runs on as it did.
      const turn = copyTurn(this.turns[runningAt.turn]!);
      turn.items.splice(runningAt.item, 0, item);
      if (message.time !== null && (turn.lastEventAt ?? -Infinity) < message.time) turn.lastEventAt = message.time;
      this.turns[runningAt.turn] = turn;
    } else if (place !== null && place.item > 0) {
      // It ends the turn it falls in; what came after is its turn's.
      const turn = this.turns[place.turn]!;
      const before = copyTurn(turn);
      before.items = turn.items.slice(0, place.item);
      const times = before.items.map(itemTime).filter((time): time is number => time !== null);
      const end = times.length > 0 ? Math.max(...times) : before.startedAt;
      before.isFinished = true;
      before.lastEventAt = end ?? before.lastEventAt;
      before.endedAt = end ?? before.lastEventAt;
      before.reportedDuration = null;
      this.turnSerial += 1;
      const after: ChatTurn = {
        ...turn,
        id: `turn-${this.turnSerial}`,
        items: [item, ...turn.items.slice(place.item)],
        startedAt: message.time ?? itemTime(turn.items[place.item]!) ?? turn.startedAt,
        isPartial: false,
      };
      const turnEnd = this.finishedBy.get(turn.id);
      if (turnEnd !== undefined) this.finishedBy.set(after.id, turnEnd);
      this.finishedBy.set(turn.id, offset!);
      this.turns[place.turn] = before;
      this.turns.splice(place.turn + 1, 0, after);
    } else if (endedLater !== null) {
      // The turn before ran past the message's line: the message ends it, and its own turn ends where that turn did.
      const ended = this.turns[previous]!;
      this.finishedBy.set(ended.id, offset!);
      this.turnSerial += 1;
      const own = makeTurn(`turn-${this.turnSerial}`, {
        items: [item],
        startedAt: message.time,
        lastEventAt: message.time,
        endedAt: ended.endedAt ?? message.time,
        isFinished: true,
      });
      this.finishedBy.set(own.id, endedLater);
      this.turns.splice(previous + 1, 0, own);
    } else if (place !== null && this.turns[place.turn]!.items[0] !== undefined && isUser(this.turns[place.turn]!.items[0]!) && !this.openedByQueue(this.turns[place.turn]!)) {
      // Before a turn another message opened: a turn of its own, which that message ends.
      const first = this.turns[place.turn]!.items[0]!;
      this.turnSerial += 1;
      const own = makeTurn(`turn-${this.turnSerial}`, {
        items: [item],
        startedAt: message.time,
        lastEventAt: message.time,
        endedAt: message.time,
        isFinished: true,
      });
      const firstOffset = this.itemOffsets.get(itemID(first));
      if (firstOffset !== undefined) this.finishedBy.set(own.id, firstOffset);
      this.turns.splice(place.turn, 0, own);
    } else if (place !== null) {
      // Before what the agent did with no message of its own, or a queued one that opened it: it opens that turn.
      const turn = copyTurn(this.turns[place.turn]!);
      turn.items.unshift(item);
      turn.startedAt = message.time ?? turn.startedAt;
      turn.isPartial = false;
      this.turns[place.turn] = turn;
    }
    this.reindex();
    if (this.showsAllHeld) this.limit = Math.min(this.historyCap, Math.max(this.limit, this.heldItemCount));
  }

  // MARK: the item cap

  /**
   * Memory stays bounded: once `maxItems` more than the limit are held, the
   * builder drops back to the newest `limit` items; never more than `historyCap`.
   */
  private trimIfNeeded(): void {
    const count = this.heldItemCount;
    if (count <= Math.min(this.historyCap, this.limit + this.maxItems)) return;
    const kept = newestTurns(this.turns, this.limit);
    const keptIDs = new Set(kept.flatMap((turn) => turn.items.map(itemID)));
    for (const turn of this.turns) {
      for (const item of turn.items) {
        if (item.type === "toolCall" && !keptIDs.has(item.value.id) && item.value.state !== "running") this.keepDropped(item.value);
        // One still running too: the running list keeps it and its end still finds it.
        if (item.type === "agents" && !keptIDs.has(item.value.id)) for (const agent of item.value.agents) this.keepDroppedAgent(agent);
      }
    }
    this.turns = kept;
    this.reindex();
    this.trimSerial += 1;
    this.keptStart = minOf(this.itemOffsets.values());
  }

  /** Positions, ids and offsets again from `turns`. */
  private reindex(): void {
    const turnIDs = new Set(this.turns.map((turn) => turn.id));
    // Deleting the entry being visited is safe while iterating a Map.
    for (const id of this.finishedBy.keys()) if (!turnIDs.has(id)) this.finishedBy.delete(id);
    this.callPositions.clear();
    this.agentPositions.clear();
    this.itemIDs.clear();
    const offsets = new Map<string, number>();
    this.turns.forEach((turn, turnIndex) => {
      turn.items.forEach((item, itemIndex) => {
        const id = itemID(item);
        this.itemIDs.add(id);
        const offset = this.itemOffsets.get(id);
        if (offset !== undefined) offsets.set(id, offset);
        if (item.type === "toolCall") this.callPositions.set(item.value.id, { turn: turnIndex, item: itemIndex });
        if (item.type === "agents") for (const agent of item.value.agents) this.agentPositions.set(agent.id, { turn: turnIndex, item: itemIndex });
      });
    });
    for (const id of this.queuedItems) if (!this.itemIDs.has(id)) this.queuedItems.delete(id);
    this.itemOffsets = offsets;
  }

  private keepOrphan(id: string, orphan: Orphan): void {
    if (!this.orphanResults.has(id)) this.orphanOrder.push(id);
    this.orphanResults.set(id, orphan);
    while (this.orphanOrder.length > keptForLaterCalls) this.orphanResults.delete(this.orphanOrder.shift()!);
  }

  private keepNotification(id: string, notified: Notified): void {
    const held = this.orphanNotifications.get(id);
    // The first end read is the end (a notice's other copies come later); a monitor's newest event stays with it.
    if (held !== undefined && held.status !== "event") return;
    if (held !== undefined && notified.status !== "event" && notified.event === null && held.event !== null) notified = { ...notified, event: held.event };
    if (held === undefined) this.orphanNotificationOrder.push(id);
    this.orphanNotifications.set(id, notified);
    while (this.orphanNotificationOrder.length > keptForLaterCalls) this.orphanNotifications.delete(this.orphanNotificationOrder.shift()!);
  }

  /** A subagent a trim let go: one running is kept; ended ones go, the oldest first, past the history cap. */
  private keepDroppedAgent(agent: ChatSubagent): void {
    if (!this.droppedAgents.has(agent.id)) this.droppedAgentOrder.push(agent.id);
    this.droppedAgents.set(agent.id, agent);
    this.droppedAgentOrder = keptWork(this.droppedAgentOrder, (id) => this.droppedAgents.get(id)?.state === "running", this.historyCap, (id) => {
      this.droppedAgents.delete(id);
      this.workOrder.delete(id);
    });
  }

  /** A call a trim let go: an ordinary one among the newest `keptForLaterCalls`; a task call kept as subagents are. */
  private keepDropped(call: ChatToolCall): void {
    const known = this.droppedCalls.has(call.id);
    this.droppedCalls.set(call.id, call);
    if (call.task !== undefined) {
      if (!known) this.droppedTaskOrder.push(call.id);
      this.droppedTaskOrder = keptWork(this.droppedTaskOrder, (id) => this.droppedCalls.get(id)?.task?.state === "running", this.historyCap, (id) => {
        this.droppedCalls.delete(id);
        this.workOrder.delete(id);
      });
      return;
    }
    if (!known) this.droppedOrder.push(call.id);
    while (this.droppedOrder.length > keptForLaterCalls) {
      const gone = this.droppedOrder.shift()!;
      this.droppedCalls.delete(gone);
      this.workOrder.delete(gone);
    }
  }

  /** A Bash, Monitor or Agent call's ordinal, when first seen. */
  private noteWork(call: ChatToolCall): void {
    if (this.workOrder.has(call.id)) return;
    if (call.subagent === undefined && call.task === undefined && call.toolName !== "Bash") return;
    this.workOrder.set(call.id, this.nextWorkOrder);
    this.nextWorkOrder += 1;
  }

  /** The older part's ordinals, put ahead of this builder's (one both saw: the older's, its first sight). */
  private adoptWorkOrder(older: ChatTimelineBuilder): void {
    const shift = this.firstWorkOrder - older.nextWorkOrder;
    for (const [id, order] of older.workOrder) this.workOrder.set(id, order + shift);
    this.firstWorkOrder = older.firstWorkOrder + shift;
  }

  /** A call a trim let go is held again (Load earlier brought it): it leaves the dropped ones. */
  private takeDropped(id: string): void {
    this.droppedCalls.delete(id);
    this.droppedOrder = this.droppedOrder.filter((each) => each !== id);
    this.droppedTaskOrder = this.droppedTaskOrder.filter((each) => each !== id);
  }

  // MARK: earlier history

  /**
   * Puts `older` (a builder that read the lines just before this one's first)
   * in front of what is held: an item already held is not added again, a turn
   * that ran across the seam is one turn, calls whose result this builder read
   * early (or whose end a trim let go) are finished, and the newer title wins.
   * The limit grows to show all of it, at most `historyCap` items.
   */
  prepend(older: ChatTimelineBuilder): PrependResult {
    this.prependSerial += 1;
    this.adoptWorkOrder(older);
    this.showsAllHeld = true;
    let olderTurns = older.turns.map(copyTurn);
    const olderOffsets = older.itemOffsets;
    // The reports held whose start was not (the hand-backs that landed as their own rows), by who sent them.
    const heldReports = new Map<string, ChatAgentMessage>();
    for (const turn of this.turns) {
      for (const item of turn.items) {
        if (item.type === "agentMessage" && item.value.kind === "report" && item.value.from !== null && !heldReports.has(item.value.from)) {
          heldReports.set(item.value.from, item.value);
        }
      }
    }
    // Calls this builder read more of: the latest result wins, whatever the older part made of the call.
    for (const turn of olderTurns) {
      turn.items.forEach((item, itemIndex) => {
        if (item.type === "agents") {
          // Its subagents' results and hand-backs this builder read.
          const agents = item.value.agents.map((start) => {
            let agent = start;
            // One a trim let go was read whole up to the trim.
            const dropped = this.droppedAgents.get(agent.id);
            if (dropped !== undefined) {
              this.droppedAgents.delete(agent.id);
              this.droppedAgentOrder = this.droppedAgentOrder.filter((id) => id !== start.id);
              agent = dropped;
            }
            const orphan = this.orphanResults.get(agent.id);
            if (orphan !== undefined) {
              this.orphanResults.delete(agent.id);
              this.orphanOrder = this.orphanOrder.filter((id) => id !== start.id);
              agent = subagentResult(orphan.output, agent, orphan.time);
            }
            const keys = [agent.agentID, agent.name, agent.id].filter((key): key is string => key !== null);
            const notifiedKey = keys.find((key) => this.orphanNotifications.has(key));
            if (notifiedKey !== undefined) {
              agent = subagentNotified(this.orphanNotifications.get(notifiedKey)!, agent);
              this.orphanNotifications.delete(notifiedKey);
              this.orphanNotificationOrder = this.orphanNotificationOrder.filter((id) => id !== notifiedKey);
            }
            const report = keys.map((key) => heldReports.get(key)).find((found) => found !== undefined);
            if (report !== undefined) agent = subagentHandBack(report, agent);
            // Begun before a session end this builder read: stopped with it.
            if (this.sessionEnded && agent.state === "running") agent = { ...agent, state: "stopped", finishedAt: this.sessionEndedAt ?? agent.finishedAt };
            return agent;
          });
          turn.items[itemIndex] = { type: "agents", value: { ...item.value, agents } };
          return;
        }
        if (item.type !== "toolCall") return;
        let call = item.value;
        let changed = false;
        const dropped = this.droppedCalls.get(call.id);
        if (dropped !== undefined) {
          this.takeDropped(call.id);
          call = dropped;
          changed = true;
        }
        const orphan = this.orphanResults.get(call.id);
        if (orphan !== undefined) {
          this.orphanResults.delete(call.id);
          this.orphanOrder = this.orphanOrder.filter((id) => id !== call.id);
          call = taskLaunched(orphan.output, call, orphan.time);
          changed = true;
        }
        // A task's notices this builder read (its end: no ghost running item), then the session end it read.
        if (call.task?.state === "running") {
          const kept = this.withKeptNotice(call);
          if (this.sessionEnded && kept.task?.state === "running") call = endingTask(kept, "stopped", this.sessionEndedAt);
          else call = kept;
          changed = true;
        }
        if (changed) turn.items[itemIndex] = { type: "toolCall", value: call };
      });
    }
    // Nothing twice: an item is held already when it has a held one's id, unless
    // both lines' offsets are known and differ (then it stays, under an id of its own).
    const renamedOffsets = new Map<string, number>();
    const queuedFromOlder: string[] = [];
    const olderIDs = new Set(olderTurns.flatMap((turn) => turn.items.map(itemID)));
    for (const turn of olderTurns) {
      turn.items = turn.items.flatMap((item): ChatItem[] => {
        const id = itemID(item);
        if (!this.itemIDs.has(id)) {
          if (older.queuedItems.has(id)) queuedFromOlder.push(id);
          return [item];
        }
        if (item.type === "toolCall" || item.type === "agents") return [];
        const olderOffset = olderOffsets.get(id);
        const heldOffset = this.itemOffsets.get(id);
        if (olderOffset === undefined || heldOffset === undefined || olderOffset === heldOffset) return [];
        let renamed = id;
        do {
          this.itemSerial += 1;
          renamed = id + `#e${this.itemSerial}`;
        } while (this.itemIDs.has(renamed) || olderIDs.has(renamed));
        this.itemIDs.add(renamed);
        renamedOffsets.set(renamed, olderOffset);
        if (older.queuedItems.has(id)) queuedFromOlder.push(renamed);
        return [itemWithID(item, renamed)];
      });
    }
    olderTurns = olderTurns.filter((turn) => turn.items.length > 0);

    // The cap: the oldest of `older` stay out.
    const held = this.heldItemCount;
    const room = Math.max(0, this.historyCap - held);
    const count = (turns: readonly ChatTurn[]): number => turns.reduce((n, turn) => n + turn.items.length, 0);
    const olderCount = count(olderTurns);
    let droppedForCap = 0;
    if (olderCount > room) {
      olderTurns = newestTurns(olderTurns, room);
      droppedForCap = olderCount - count(olderTurns);
    }

    // The seam (nothing held: the older running turn is the live one).
    let endedAtSeam = false;
    const last = olderTurns[olderTurns.length - 1];
    const firstHeld = this.turns[0];
    if (last !== undefined && !last.isFinished && firstHeld !== undefined) {
      if (firstHeld.isPartial || this.openedByQueue(firstHeld) || (turnUserMessage(last) === null && !turnHasAgentOutput(last))) {
        // One turn across the seam (a queued message that opens what is held goes in the older running turn): the newer turn's id, its end, both halves' items.
        const first = copyTurn(firstHeld);
        first.items = [...last.items, ...first.items];
        first.startedAt = last.startedAt ?? first.startedAt;
        if (last.lastEventAt !== null && (first.lastEventAt ?? -Infinity) < last.lastEventAt) first.lastEventAt = last.lastEventAt;
        first.isPartial = last.isPartial;
        // A turn the newer part already ended (an interrupt read there) stops the older half's foreground subagents at that end, as `finish` does.
        if (first.isFinished) first.items = stoppingForegroundAgents(first, first.endedAt);
        this.turns[0] = first;
        olderTurns.pop();
      } else {
        // The newer turn opened with your message: the older one ended at its last event.
        last.isFinished = true;
        last.endedAt = last.lastEventAt ?? last.startedAt;
        // Its foreground subagents with it.
        last.items = stoppingForegroundAgents(last, last.endedAt);
        endedAtSeam = true;
      }
    } else if (olderTurns.length > 0 && firstHeld?.isPartial === true) {
      // What came before is known now.
      this.turns[0] = { ...copyTurn(firstHeld), isPartial: false };
    }
    olderTurns.forEach((turn, index) => {
      const id = `turn-e${this.prependSerial}-${index + 1}`;
      const end = older.finishedBy.get(turn.id);
      if (end !== undefined) this.finishedBy.set(id, end);
      turn.id = id;
    });
    const opener = this.turns[0]?.items[0];
    const lastOlder = olderTurns[olderTurns.length - 1];
    if (endedAtSeam && lastOlder !== undefined && opener !== undefined) {
      const offset = this.itemOffsets.get(itemID(opener));
      // Ended by the message that opens what is held.
      if (offset !== undefined) this.finishedBy.set(lastOlder.id, offset);
    }
    for (const [id, offset] of olderOffsets) if (!this.itemOffsets.has(id)) this.itemOffsets.set(id, offset);
    for (const [id, offset] of renamedOffsets) this.itemOffsets.set(id, offset);
    for (const id of queuedFromOlder) this.queuedItems.add(id);
    this.turns = [...olderTurns, ...this.turns];
    const added = this.heldItemCount - held;
    this.reindex();
    if (this.customTitle === null) this.customTitle = older.customTitle;
    if (this.aiTitle === null) this.aiTitle = older.aiTitle;
    // The older part's results for calls before it, unless this builder read a later one for the same call.
    for (const id of older.orphanOrder) {
      if (this.callPositions.has(id) || this.orphanResults.has(id)) continue;
      const orphan = older.orphanResults.get(id);
      if (orphan !== undefined) this.keepOrphan(id, orphan);
    }
    // An older session end ended nothing held (the held lines are newer); its time stays the earliest.
    if (older.sessionEnded && (!this.sessionEnded || (older.sessionEndedAt !== null && (this.sessionEndedAt === null || older.sessionEndedAt < this.sessionEndedAt)))) {
      this.sessionEndedAt = older.sessionEndedAt;
    }
    this.sessionEnded = this.sessionEnded || older.sessionEnded;
    // The older part's notifications for agents, ahead of this builder's.
    for (const id of older.orphanNotificationOrder) {
      if (this.orphanNotifications.has(id) || this.subagentExactly(id) !== null) continue;
      const notified = older.orphanNotifications.get(id);
      if (notified !== undefined) this.keepNotification(id, notified);
    }
    this.limit = Math.min(this.historyCap, Math.max(this.limit, this.heldItemCount));
    const start = droppedForCap > 0 || older.trimSerial > 0 ? minOf(this.itemOffsets.values()) : null;
    return { added, droppedForCap, start };
  }
}
