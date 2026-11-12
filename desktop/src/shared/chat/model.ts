// The Chat view's data: an agent pane's session as a list of turns, built from
// the agent's own transcript (claude-parser.ts, codex-parser.ts) by the
// ChatTimelineBuilder (builder.ts). Plain values (they cross IPC to the
// renderer), no UI types. A port of HerdrKit's ChatTimeline.swift, with
// progress rows.
//
// Times are seconds since 1970 (fractional), as Swift's Date.timeIntervalSince1970,
// so durations and comparisons read the same as HerdrKit's; null when unknown.
//
// Model values are never changed in place once made: the builder replaces an
// item or a call with a changed copy, so a timeline handed out stays as it was.

/** What lies before the loaded part of a conversation. */
export type ChatEarlierHistory = "none" | "available" | "loading" | "failed" | "capped";

export interface ChatTimeline {
  readonly turns: readonly ChatTurn[];
  /** The newest title the agent gave the session (Claude Code's `ai-title`), the name given winning. */
  readonly title: string | null;
  readonly earlier: ChatEarlierHistory;
  /** Newer messages wait unread (you read older ones and the cap is on show). */
  readonly newerWaiting: boolean;
  /**
   * Subagents running in held items the window leaves
   * out: background ones of any turn, foreground ones of the running turn (the
   * builder sets them).
   */
  readonly hiddenRunning?: RunningSubagents;
  /**
   * The background shells, monitors and subagents
   * running (the Running strip's items), those the window leaves out and
   * those the item cap let go too, oldest first (the builder sets it).
   */
  readonly running?: readonly ChatRunningWork[];
}

/** Running subagents, background and foreground. */
export interface RunningSubagents {
  readonly background: number;
  readonly foreground: number;
}

export const emptyTimeline: ChatTimeline = { turns: [], title: null, earlier: "none", newerWaiting: false };

export interface ChatTurn {
  id: string;
  items: ChatItem[];
  /** The turn's first event: the user's message, or the agent's turn start. */
  startedAt: number | null;
  /** The newest event seen in this turn (a tool result counts). */
  lastEventAt: number | null;
  endedAt: number | null;
  isFinished: boolean;
  /** The agent's own measure of the turn (Codex `task_complete.duration_ms`), seconds. */
  reportedDuration: number | null;
  /** The turn began before the loaded window. */
  isPartial: boolean;
}

export function makeTurn(id: string, fields: Partial<Omit<ChatTurn, "id">> = {}): ChatTurn {
  return {
    id,
    items: fields.items ?? [],
    startedAt: fields.startedAt ?? null,
    lastEventAt: fields.lastEventAt ?? null,
    endedAt: fields.endedAt ?? null,
    isFinished: fields.isFinished ?? false,
    reportedDuration: fields.reportedDuration ?? null,
    isPartial: fields.isPartial ?? false,
  };
}

export type ChatItem =
  | { readonly type: "user"; readonly value: ChatUserMessage }
  | { readonly type: "agentText"; readonly value: ChatAgentText }
  | { readonly type: "toolCall"; readonly value: ChatToolCall }
  | { readonly type: "notice"; readonly value: ChatNotice }
  /** A short progress update the agent wrote between its tool calls. */
  | { readonly type: "progress"; readonly value: ChatAgentText }
  /** The subagents the turn started, one row. */
  | { readonly type: "agents"; readonly value: ChatSubagents }
  /** A subagent's report whose start is not held, or a message from another Claude session. */
  | { readonly type: "agentMessage"; readonly value: ChatAgentMessage };

export const itemID = (item: ChatItem): string => item.value.id;
export const itemTime = (item: ChatItem): number | null => item.value.time;

/** `item` under another id. */
export function itemWithID(item: ChatItem, id: string): ChatItem {
  switch (item.type) {
    case "user":
      return { type: "user", value: { ...item.value, id } };
    case "agentText":
      return { type: "agentText", value: { ...item.value, id } };
    case "toolCall":
      return { type: "toolCall", value: { ...item.value, id } };
    case "notice":
      return { type: "notice", value: { ...item.value, id } };
    case "progress":
      return { type: "progress", value: { ...item.value, id } };
    case "agents":
      return { type: "agents", value: { ...item.value, id } };
    case "agentMessage":
      return { type: "agentMessage", value: { ...item.value, id } };
  }
}

// MARK: - Subagents

/** What an Agent (Task) call asked for, beyond its description and prompt. */
export interface ChatSubagentLaunch {
  /** `subagent_type`, when given. */
  readonly type: string | null;
  /** `run_in_background`: its tool_result only says it started; its hand-back (or task notification) says it finished. */
  readonly background: boolean;
  /** `name`, when given: another way a hand-back may name it. */
  readonly name: string | null;
}

/** `done` and `failed` once its result came; `stopped` when its turn ended (an interrupt) first. */
export type ChatSubagentState = "running" | "done" | "failed" | "stopped";

/** One subagent the agent started. */
export interface ChatSubagent {
  /** The Agent call's id. */
  readonly id: string;
  readonly description: string;
  readonly type: string | null;
  readonly background: boolean;
  readonly name: string | null;
  /** The id Claude Code gave a background agent (its launch result's `agentId:`), which its hand-back names. */
  readonly agentID: string | null;
  readonly prompt: string | null;
  readonly state: ChatSubagentState;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Its final report: the foreground result, or the hand-back's text. */
  readonly report: string | null;
  /** Its newest tool step ("Read foo.ts"), from its own transcript while it runs. */
  readonly step?: string | null;
}

/** The subagents one turn started: one compact row. `time` is when the first started. */
export interface ChatSubagents {
  readonly id: string;
  readonly agents: readonly ChatSubagent[];
  readonly time: number | null;
}

/** A message another Claude session wrote into this one: a subagent's report whose start is not held, or any other session's message. */
export interface ChatAgentMessage {
  readonly id: string;
  /** `report`: a subagent's hand-back; `peer`: another session's message. */
  readonly kind: "report" | "peer";
  readonly from: string | null;
  readonly text: string;
  readonly time: number | null;
}

export const agentMessageTitle = (message: ChatAgentMessage): string => (message.kind === "report" ? "Agent report" : "Message from another session");

/** How long it ran, once it finished. */
export function subagentElapsed(agent: ChatSubagent): number | null {
  if (agent.state === "running" || agent.startedAt === null || agent.finishedAt === null) return null;
  return Math.max(0, agent.finishedAt - agent.startedAt);
}

/** The line's name: its description, else its type, else "Agent". */
export const subagentTitle = (agent: ChatSubagent): string => (agent.description.length > 0 ? agent.description : (agent.type ?? "Agent"));

/** "running", "done · 1m 12s", "failed · 4s", "stopped". */
export function subagentStatusText(agent: ChatSubagent): string {
  if (agent.state === "running" || agent.state === "stopped") return agent.state;
  const elapsed = subagentElapsed(agent);
  return elapsed === null ? agent.state : `${agent.state} · ${compactDuration(elapsed)}`;
}

export const subagentsRunning = (group: ChatSubagents): number => group.agents.filter((agent) => agent.state === "running").length;

/** "2 agents running", "2 agents running · 1 done", "3 agents done", "1 agent done · 1 failed". */
export function subagentsSummary(group: ChatSubagents): string {
  const parts: string[] = [];
  for (const state of ["running", "done", "failed", "stopped"] as const) {
    const count = group.agents.filter((agent) => agent.state === state).length;
    if (count === 0) continue;
    parts.push(parts.length === 0 ? `${counted(count, "agent")} ${state}` : `${count} ${state}`);
  }
  return parts.join(" · ");
}

/** The subagents running in any turn held (a background one runs on after its turn): the Working line counts them. */
export function runningSubagents(timeline: ChatTimeline): number {
  const shown = runningIn(timeline.turns);
  const hidden = timeline.hiddenRunning;
  return shown.background + shown.foreground + (hidden?.background ?? 0) + (hidden?.foreground ?? 0);
}

/** The running subagents of `turns`, background and foreground. */
export function runningIn(turns: readonly ChatTurn[]): RunningSubagents {
  let background = 0;
  let foreground = 0;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== "agents") continue;
      for (const agent of item.value.agents) {
        if (agent.state !== "running") continue;
        if (agent.background) background += 1;
        else foreground += 1;
      }
    }
  }
  return { background, foreground };
}

/** The Working line's words for `running` subagents ("2 agents"); null for none. */
export const workingAgentsText = (running: number): string | null => (running > 0 ? counted(running, "agent") : null);

// MARK: - Background tasks

/** A Bash call run in the background (or moved there) is a shell; a Monitor call a monitor. */
export type ChatTaskKind = "shell" | "monitor";

/**
 * `done`, `failed`, `killed`: its finish notice said so (a non-zero exit code
 * is `failed`); `stopped`: a TaskStop, a notice saying stopped, cancelled or
 * timed out, or the session ended (the agent gone, a new session or run).
 */
export type ChatTaskState = "running" | "done" | "failed" | "killed" | "stopped";

/** What runs on in the background after its call returned. */
export interface ChatBackgroundTask {
  readonly kind: ChatTaskKind;
  /** The id Claude Code gave it (toolUseResult's backgroundTaskId or taskId, else its result's text): its notices name it. */
  readonly taskID: string | null;
  /** The call's description, else its command's first line. */
  readonly description: string;
  readonly state: ChatTaskState;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** A monitor's newest event (its notices before its end, or the end's own). */
  readonly lastEvent: string | null;
  /** The exit code its notice gave. */
  readonly exitCode: number | null;
}

export function backgroundTask(kind: ChatTaskKind, description: string, startedAt: number | null): ChatBackgroundTask {
  return { kind, taskID: null, description, state: "running", startedAt, finishedAt: null, lastEvent: null, exitCode: null };
}

/** How long it ran, once it ended. */
export function taskElapsed(task: ChatBackgroundTask): number | null {
  if (task.state === "running" || task.startedAt === null || task.finishedAt === null) return null;
  return Math.max(0, task.finishedAt - task.startedAt);
}

/** The row's words: "running in background", then "done · 1m 2s" ("ended" for a monitor), "exit 1 · 4s", "failed · 4s", "killed · 9s", "stopped". */
export function taskStatusText(task: ChatBackgroundTask): string {
  if (task.state === "running") return "running in background";
  if (task.state === "stopped") return "stopped";
  let word: string = task.state;
  if (task.state === "done" && task.kind === "monitor") word = "ended";
  if (task.state === "failed" && task.exitCode !== null && task.exitCode !== 0) word = `exit ${task.exitCode}`;
  const elapsed = taskElapsed(task);
  return elapsed === null ? word : `${word} · ${compactDuration(elapsed)}`;
}

/** The strip's kinds: a background shell, a monitor, a subagent. */
export type ChatRunningKind = ChatTaskKind | "agent";

/** One thing running, as the Running strip shows it. */
export interface ChatRunningWork {
  /** The call's id (the Bash, Monitor or Agent call). */
  readonly id: string;
  readonly kind: ChatRunningKind;
  /** Its description (else its command's or prompt's first line, else its type). */
  readonly title: string;
  /** The command, or the subagent's prompt. */
  readonly detail: string;
  readonly startedAt: number | null;
  /** A monitor's newest event. */
  readonly lastEvent: string | null;
  /** A subagent run in the background (a foreground one is part of its turn). */
  readonly background: boolean;
  /** A subagent's newest tool step. */
  readonly step: string | null;
}

export const runningWork = (timeline: ChatTimeline): readonly ChatRunningWork[] => timeline.running ?? [];

/** A running task's call as the strip shows it. */
export function taskWork(call: ChatToolCall): ChatRunningWork | null {
  const task = call.task;
  if (task === undefined || task.state !== "running") return null;
  const command = call.detail.type === "bash" ? call.detail.bash.command : call.target;
  const title = task.description.length > 0 ? task.description : call.toolName === "Monitor" ? "Monitor" : "Background command";
  return { id: call.id, kind: task.kind, title, detail: command, startedAt: task.startedAt ?? call.time, lastEvent: task.lastEvent, background: true, step: null };
}

/** A running subagent as the strip shows it. */
export function agentWork(agent: ChatSubagent): ChatRunningWork | null {
  if (agent.state !== "running") return null;
  return {
    id: agent.id,
    kind: "agent",
    title: subagentTitle(agent),
    detail: agent.prompt ?? "",
    startedAt: agent.startedAt,
    lastEvent: null,
    background: agent.background,
    step: agent.step ?? null,
  };
}

/** Two running lists show the same. */
export function sameRunning(a: readonly ChatRunningWork[] | undefined, b: readonly ChatRunningWork[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((work, index) => {
    const other = right[index]!;
    return (
      work.id === other.id &&
      work.kind === other.kind &&
      work.title === other.title &&
      work.detail === other.detail &&
      work.startedAt === other.startedAt &&
      work.lastEvent === other.lastEvent &&
      work.background === other.background &&
      work.step === other.step
    );
  });
}

/** `call` with its task's state shown: its row's words, failed when the task failed, its detail's last lines a monitor's newest event. */
export function withTaskShown(call: ChatToolCall): ChatToolCall {
  const task = call.task;
  if (task === undefined) return call;
  let next: ChatToolCall = { ...call, resultSummary: taskStatusText(task) };
  if (task.state === "failed") next = { ...next, state: "failed" };
  if (task.lastEvent !== null && next.detail.type === "bash") {
    const lines = task.lastEvent.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
    next = { ...next, detail: { type: "bash", bash: { ...next.detail.bash, outputTail: lines.slice(-keptOutputLines) } } };
  }
  return next;
}

/** `call` with its running task ended as `state` at `time` (a task already ended stays as it was). */
export function endingTask(call: ChatToolCall, state: Exclude<ChatTaskState, "running">, time: number | null, fields: { lastEvent?: string | null; exitCode?: number | null } = {}): ChatToolCall {
  const task = call.task;
  if (task === undefined || task.state !== "running") return call;
  return withTaskShown({
    ...call,
    task: {
      ...task,
      state,
      finishedAt: time ?? task.finishedAt,
      lastEvent: fields.lastEvent ?? task.lastEvent,
      exitCode: fields.exitCode ?? task.exitCode,
    },
  });
}

/** The items with every running task and subagent stopped at `time` (else its turn's last event): the session ended. */
export function stoppingAllWork(turn: ChatTurn, time: number | null): ChatItem[] {
  const stoppedAt = time ?? turn.lastEventAt;
  return turn.items.map((item): ChatItem => {
    if (item.type === "toolCall" && item.value.task?.state === "running") return { type: "toolCall", value: endingTask(item.value, "stopped", stoppedAt) };
    if (item.type !== "agents" || !item.value.agents.some((agent) => agent.state === "running")) return item;
    const agents = item.value.agents.map((agent): ChatSubagent => (agent.state === "running" ? { ...agent, state: "stopped", finishedAt: stoppedAt } : agent));
    return { type: "agents", value: { ...item.value, agents } };
  });
}

/**
 * The same timeline once the agent is gone (Herdr
 * reports it stopped): its running turn ended at its last event, and every
 * task and subagent still running stopped with the session; nothing runs.
 */
export function endingSession(timeline: ChatTimeline): ChatTimeline {
  const ended = endingRunningTurn(timeline);
  const last = ended.turns.at(-1)?.lastEventAt ?? null;
  const turns = ended.turns.map((turn) => {
    const running = turn.items.some((item) => (item.type === "toolCall" && item.value.task?.state === "running") || (item.type === "agents" && item.value.agents.some((agent) => agent.state === "running")));
    return running ? { ...turn, items: stoppingAllWork(turn, turn.lastEventAt ?? last) } : turn;
  });
  return { ...ended, turns, hiddenRunning: { background: 0, foreground: 0 }, running: [] };
}

/** What the user typed, without the attachment paths the app appends. */
export interface ChatUserMessage {
  readonly id: string;
  readonly text: string;
  readonly time: number | null;
  readonly attachments: readonly ChatAttachment[];
}

export function userMessage(id: string, text: string, time: number | null, attachments: readonly ChatAttachment[] = []): ChatUserMessage {
  return { id, text, time, attachments };
}

/**
 * Relay v1.2: an inline image whose base64 a relay read left out, as
 * the transcript's parts: kept base64 text, or a file range (`[offset, length]`) fetched on show by a plain
 * relay `read` of `path`, checked against `ino` (null: not known).
 */
export interface ChatImageBlob {
  readonly path: string;
  readonly ino: number | null;
  readonly parts: readonly (string | readonly [offset: number, length: number])[];
}

/** An image or file sent with a message: its Mac path when the transcript names one, else its media type. */
export interface ChatAttachment {
  readonly path: string | null;
  readonly mediaType: string | null;
  /** An inline image left out of the read, fetched on show; absent: none to fetch (a frame). */
  readonly blob?: ChatImageBlob;
}

export function attachment(path: string | null = null, mediaType: string | null = null, blob?: ChatImageBlob): ChatAttachment {
  return blob === undefined ? { path, mediaType } : { path, mediaType, blob };
}

export function attachmentFileName(value: ChatAttachment): string | null {
  const { path } = value;
  if (path === null) return null;
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/** True for an inline image, an `image/…` media type or an image path. */
export function attachmentIsImage(value: ChatAttachment): boolean {
  if (value.mediaType !== null) return value.mediaType.startsWith("image/");
  if (value.path === null) return true;
  const lower = value.path.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"].some((suffix) => lower.endsWith(suffix));
}

/** The agent's reply text (markdown), or a progress update's text. */
export interface ChatAgentText {
  readonly id: string;
  readonly markdown: string;
  readonly time: number | null;
}

export type ChatNoticeKind = "compacted" | "interrupted";

export interface ChatNotice {
  readonly id: string;
  readonly kind: ChatNoticeKind;
  readonly time: number | null;
}

export function noticeText(kind: ChatNoticeKind): string {
  return kind === "compacted" ? "Conversation compacted" : "Interrupted";
}

/**
 * As T3 Code's stopped row: the quiet row a turn your Esc
 * stopped ends with, "You stopped after 12s" by the turn's length (from its
 * start to the interrupt line); "Stopped" when that is not known.
 */
export function stoppedText(turn: Pick<ChatTurn, "startedAt">, notice: Pick<ChatNotice, "time">): string {
  const start = turn.startedAt;
  const end = notice.time;
  if (start === null || end === null || end < start) return "Stopped";
  return "You stopped after " + compactDuration(end - start);
}

/** The turn ends with your stop (its last item the interrupt line). */
export function turnStopped(turn: Pick<ChatTurn, "items">): boolean {
  const last = turn.items.at(-1);
  return last !== undefined && last.type === "notice" && last.value.kind === "interrupted";
}

/** The words of a notice row in `turn`: a stop says how long the turn ran. */
export function noticeRowText(notice: ChatNotice, turn: Pick<ChatTurn, "startedAt"> | null): string {
  return notice.kind === "interrupted" && turn !== null ? stoppedText(turn, notice) : noticeText(notice.kind);
}

// MARK: - Tool calls

/** How a call is shown, the same for Claude Code and Codex; `{ other }` carries the tool's own name. */
export type ChatToolKind = "read" | "edit" | "bash" | "search" | "web" | "agent" | "plan" | { readonly other: string };

export function toolKindName(kind: ChatToolKind): string {
  if (typeof kind === "object") return kind.other;
  return { read: "Read", edit: "Edit", bash: "Bash", search: "Search", web: "Web", agent: "Agent", plan: "Plan" }[kind];
}

export type ChatToolState = "running" | "ok" | "failed";

export interface ChatToolCall {
  readonly id: string;
  readonly kind: ChatToolKind;
  /** The tool's name as the agent wrote it (`Read`, `exec_command`, `exec`). */
  readonly toolName: string;
  /** A file path, the command, the pattern, a URL or query, a description. */
  readonly target: string;
  /** The row's right-hand text: "74 lines", "4 files", "+9 −2", "exit 1". */
  readonly resultSummary: string | null;
  readonly state: ChatToolState;
  readonly detail: ChatToolDetail;
  readonly time: number | null;
  readonly finishedAt: number | null;
  /** Further tool calls made by the same Codex script, beyond the one shown. */
  readonly moreCalls: number;
  /** A `!` command the user typed in Claude Code, not something the agent ran. */
  readonly isUserShell: boolean;
  /** The program a classified shell command runs (basename), else null. */
  readonly program: string | null;
  /** A Claude Agent (Task) call: shown in its turn's subagents row, not as a tool row. */
  readonly subagent?: ChatSubagentLaunch;
  /** A Bash call run in the background, or a Monitor call: what runs on after it returned. */
  readonly task?: ChatBackgroundTask;
  /** An ordinary Bash call's description (its first line): its task's title if Claude Code moves it to the background. */
  readonly bashDescription?: string;
}

export function toolCall(
  id: string,
  kind: ChatToolKind,
  toolName: string,
  target: string,
  fields: Partial<Omit<ChatToolCall, "id" | "kind" | "toolName" | "target">> = {},
): ChatToolCall {
  return {
    id,
    kind,
    toolName,
    target,
    resultSummary: fields.resultSummary ?? null,
    state: fields.state ?? "running",
    detail: fields.detail ?? { type: "none" },
    time: fields.time ?? null,
    finishedAt: fields.finishedAt ?? null,
    moreCalls: fields.moreCalls ?? 0,
    isUserShell: fields.isUserShell ?? false,
    program: fields.program ?? null,
  };
}

/** What the row opens to. */
export type ChatToolDetail =
  | { readonly type: "none" }
  | { readonly type: "diff"; readonly diff: ChatDiff }
  | { readonly type: "bash"; readonly bash: ChatBashDetail }
  | { readonly type: "search"; readonly search: ChatSearchDetail }
  | { readonly type: "plan"; readonly steps: readonly ChatPlanStep[] }
  | { readonly type: "text"; readonly text: string };

export const keptDiffLineCount = 6;

export interface ChatDiff {
  readonly files: readonly string[];
  /** Counted over every line of the change, not only the kept ones. */
  readonly added: number;
  readonly removed: number;
  /** The first `keptDiffLineCount` lines. */
  readonly lines: readonly ChatDiffLine[];
  readonly moreLines: number;
  /**
   * Every line of the change for the Changes view, up to
   * `fullDiffLineCount` lines and `fullDiffByteCount` bytes of text; left out
   * where `lines` hold them all (read through `diffAllLines`). Never sent to the
   * chat's window (`withoutFullDiffs`).
   */
  readonly allLines?: readonly ChatDiffLine[];
  /** Lines past the full copy's bound. */
  readonly allMoreLines?: number;
  /** A change over several files: each file's own counts over every line, taken before the full copy's bound (left out for one file). */
  readonly fileCounts?: readonly ChatDiffFileCount[];
}

/** One file's part of a change over several files. */
export interface ChatDiffFileCount {
  /** Its file line's text; null for lines before the first file line. */
  readonly path: string | null;
  readonly added: number;
  readonly removed: number;
  /** Its lines past the full copy's bound. */
  readonly omittedLines: number;
}

export const fullDiffLineCount = 4_000;
export const fullDiffByteCount = 256 * 1_024;

/** Every line kept for the Changes view (a diff made with its shown lines only keeps those). */
export const diffAllLines = (diff: ChatDiff): readonly ChatDiffLine[] => diff.allLines ?? diff.lines;
export const diffAllMoreLines = (diff: ChatDiff): number => diff.allMoreLines ?? (diff.allLines === undefined ? diff.moreLines : 0);
export const diffFileCounts = (diff: ChatDiff): readonly ChatDiffFileCount[] => diff.fileCounts ?? [];

/** The diff as the chat shows it: no full copy. */
export function chatShownDiff(diff: ChatDiff): ChatDiff {
  if (diff.allLines === undefined && diff.allMoreLines === undefined && diff.fileCounts === undefined) return diff;
  return { files: diff.files, added: diff.added, removed: diff.removed, lines: diff.lines, moreLines: diff.moreLines };
}

/** The timeline the chat's window is sent: its diffs without their full copies (the chat shows 6 lines). */
export function withoutFullDiffs(timeline: ChatTimeline): ChatTimeline {
  let changed = false;
  const turns = timeline.turns.map((turn) => {
    let turnChanged = false;
    const items = turn.items.map((item): ChatItem => {
      if (item.type !== "toolCall" || item.value.detail.type !== "diff") return item;
      const shown = chatShownDiff(item.value.detail.diff);
      if (shown === item.value.detail.diff) return item;
      turnChanged = true;
      return { type: "toolCall", value: { ...item.value, detail: { type: "diff", diff: shown } } };
    });
    if (!turnChanged) return turn;
    changed = true;
    return { ...turn, items };
  });
  return changed ? { ...timeline, turns } : timeline;
}

/** "+9 −2" (U+2212 minus, as the design draws it). */
export const diffCountsText = (diff: ChatDiff): string => `+${diff.added} −${diff.removed}`;

export type ChatDiffLineKind = "context" | "added" | "removed" | "file";

export interface ChatDiffLine {
  readonly kind: ChatDiffLineKind;
  readonly text: string;
}

export const diffLine = (kind: ChatDiffLineKind, text: string): ChatDiffLine => ({ kind, text });

export const keptOutputLines = 3;

export interface ChatBashDetail {
  readonly command: string;
  /** The last 3 non-empty output lines, escape sequences removed. */
  readonly outputTail: readonly string[];
  readonly exitCode: number | null;
}

export const bashDetail = (command: string, outputTail: readonly string[] = [], exitCode: number | null = null): ChatBashDetail => ({
  command,
  outputTail,
  exitCode,
});

export const keptSearchFiles = 50;

export interface ChatSearchDetail {
  readonly pattern: string;
  readonly files: readonly string[];
  /** Every matched file, when the tool said how many. */
  readonly fileCount: number | null;
}

export const searchDetail = (pattern: string, files: readonly string[] = [], fileCount: number | null = null): ChatSearchDetail => ({
  pattern,
  files,
  fileCount,
});

export type ChatPlanStatus = "pending" | "inProgress" | "completed";

export interface ChatPlanStep {
  readonly text: string;
  readonly status: ChatPlanStatus;
}

// MARK: - Events

/** A tool's result as a parser read it, before it is shown. */
export interface ChatToolOutput {
  readonly text: string;
  readonly isError: boolean;
  readonly exitCode: number | null;
  /** The call returned but its work goes on (Codex "Script running with cell ID …"). */
  readonly isRunning: boolean;
  /** The background task id Claude Code's result line names (toolUseResult's backgroundTaskId or taskId). */
  readonly taskID?: string | null;
}

export const toolOutput = (text: string, fields: Partial<Omit<ChatToolOutput, "text">> = {}): ChatToolOutput => ({
  text,
  isError: fields.isError ?? false,
  exitCode: fields.exitCode ?? null,
  isRunning: fields.isRunning ?? false,
  ...(fields.taskID === undefined || fields.taskID === null ? {} : { taskID: fields.taskID }),
});

/**
 * What a `<task-notification>` says of its task:
 * `event` (a monitor's notice while it runs: status running, or an event with
 * no status), else how it ended.
 */
export type ChatTaskNoticeStatus = "event" | Exclude<ChatTaskState, "running">;

/** What a parser makes of one transcript line. Agent-neutral: the builder turns these into a timeline. */
export type TranscriptEvent =
  /**
   * Something the user typed: starts a turn. One `queued` (a message the agent took
   * while it worked, Claude's `queued_command`) goes inside the running turn at
   * its place instead; with no turn running it starts one too.
   */
  | { readonly type: "userMessage"; readonly message: ChatUserMessage; readonly queued?: boolean }
  /** Your message `id` was cancelled before any answer (the orphan rule): it goes from the timeline. */
  | { readonly type: "userWithdrawn"; readonly id: string }
  | { readonly type: "agentText"; readonly text: ChatAgentText }
  /** A progress update between tool calls; it never ends the turn. */
  | { readonly type: "agentProgress"; readonly text: ChatAgentText }
  | { readonly type: "toolStarted"; readonly call: ChatToolCall }
  /** Pairs with `toolStarted` by call id. */
  | { readonly type: "toolFinished"; readonly id: string; readonly output: ChatToolOutput; readonly time: number | null }
  /** A `!` command the user ran in Claude Code: a Bash row, not a bubble. */
  | { readonly type: "userShell"; readonly call: ChatToolCall }
  | { readonly type: "notice"; readonly notice: ChatNotice; readonly endsTurn: boolean }
  /** Codex `task_started`. */
  | { readonly type: "turnStarted"; readonly time: number | null }
  /** Codex `task_complete`: the turn ends here. */
  | { readonly type: "turnCompleted"; readonly time: number | null; readonly duration: number | null }
  /**
   * When the running turn began (Grok's `_meta.turnStartMs`). It
   * starts and ends no turn and shows nothing: a turn the window began inside (its
   * first message not read) counts from it.
   */
  | { readonly type: "turnBegan"; readonly time: number }
  /** Claude `stop_reason: end_turn`: the turn ends unless a call is waiting. */
  | { readonly type: "agentStopped"; readonly time: number | null }
  /**
   * Claude's `system` `turn_duration` line,
   * written after a turn's end: the agent's own measure of the turn it ended
   * (`durationMs`), its "Worked for". It shows nothing and starts or ends no turn.
   */
  | { readonly type: "turnMeasured"; readonly duration: number; readonly time: number | null }
  /** Claude `ai-title`. */
  | { readonly type: "title"; readonly value: string }
  /** Claude `custom-title`: wins over any AI title. */
  | { readonly type: "customTitle"; readonly value: string }
  /**
   * A message another Claude session wrote into this
   * one (a subagent's hand-back, kind `report`, or any other): it finishes the
   * subagent it names, else shows as its own row. It starts and ends no turn.
   */
  | { readonly type: "agentMessage"; readonly message: ChatAgentMessage }
  /**
   * Claude Code's `<task-notification>` for task `id`: it finishes the background subagent of that id, if any,
   * or the background task of that id, or of its tool-use id (the call's id); the same notice read again changes nothing.
   */
  | {
      readonly type: "taskNotified";
      readonly id: string;
      readonly failed: boolean;
      readonly report: string | null;
      readonly time: number | null;
      readonly toolUseID?: string | null;
      readonly status?: ChatTaskNoticeStatus;
      readonly event?: string | null;
      readonly exitCode?: number | null;
    }
  /** A TaskStop (KillShell) call naming task `id`: that task (or background subagent) stopped. */
  | { readonly type: "taskStopped"; readonly id: string; readonly time: number | null }
  /** A line of another session than the lines before it: every task and subagent running is over. */
  | { readonly type: "sessionChanged"; readonly time: number | null }
  /**
   * A part of the agent's reply (`progress`: of its thinking) written in parts on
   * lines of their own (Grok's `agent_message_chunk` / `agent_thought_chunk`): added to the item of
   * its id while that is the running turn's newest, else a new item.
   */
  | { readonly type: "agentTextChunk"; readonly text: ChatAgentText; readonly progress: boolean }
  /** Your message again, with more of it: the held message of its id takes it, where it is; one not held opens a turn. */
  | { readonly type: "userMessageAmended"; readonly message: ChatUserMessage }
  /** More of what a started call is (kind, target, detail): a held call takes them, keeping its state and result; one not held starts. */
  | { readonly type: "toolRevised"; readonly call: ChatToolCall };

// MARK: - Turn views

export function turnUserMessage(turn: ChatTurn): ChatUserMessage | null {
  for (const item of turn.items) if (item.type === "user") return item.value;
  return null;
}

export function turnToolCalls(turn: ChatTurn): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  for (const item of turn.items) if (item.type === "toolCall") calls.push(item.value);
  return calls;
}

/** Whether the agent did anything in this turn (text, progress, a call of its own). */
export function turnHasAgentOutput(turn: ChatTurn): boolean {
  return turn.items.some((item) => {
    switch (item.type) {
      case "agentText":
      case "progress":
      case "agents":
        return true;
      case "toolCall":
        return !item.value.isUserShell;
      default:
        return false;
    }
  });
}

export interface ChatTurnFooter {
  readonly start: number;
  readonly end: number;
  /** Seconds. */
  readonly duration: number;
}

/** "Worked for 2m 41s": only for a finished turn in which the agent worked. */
export function turnFooter(turn: ChatTurn): ChatTurnFooter | null {
  const start = turn.startedAt;
  if (!turn.isFinished || !turnHasAgentOutput(turn) || start === null) return null;
  // A turn your Esc stopped ends with its one stopped row instead.
  if (turnStopped(turn)) return null;
  const end = turn.endedAt ?? turn.lastEventAt ?? start;
  // A turn nothing gives an end after its start (Cursor's blobs carry no times but your
  // message's) has no "Worked for": its length is not known.
  if (turn.reportedDuration === null && end <= start) return null;
  const duration = turn.reportedDuration ?? Math.max(0, end - start);
  return { start, end, duration };
}

export const workedForText = (footer: ChatTurnFooter): string => "Worked for " + compactDuration(footer.duration);

/** A call whose background task still runs keeps its own row. */
const folds = (call: ChatToolCall): boolean => call.state !== "failed" && !call.isUserShell && call.task?.state !== "running";

/** Calls a finished turn folds: everything the agent ran that did not fail. */
export function turnFoldedCalls(turn: ChatTurn): ChatToolCall[] {
  if (!turn.isFinished) return [];
  return turnToolCalls(turn).filter(folds);
}

export function turnFoldSummary(turn: ChatTurn): string | null {
  return foldSummaryLine(turnFoldedCalls(turn));
}

export interface ChatFoldedCalls {
  readonly id: string;
  readonly summary: string;
  readonly calls: readonly ChatToolCall[];
}

export type ChatTurnRow = { readonly type: "item"; readonly item: ChatItem } | { readonly type: "folded"; readonly folded: ChatFoldedCalls };

export const rowID = (row: ChatTurnRow): string => (row.type === "item" ? itemID(row.item) : row.folded.id);

/** Calls on either side of it fold apart. */
const parts = (item: ChatItem): boolean => item.type === "progress" || item.type === "user";

/**
 * What the UI draws, in order. A running turn shows every item. A finished turn
 * folds its calls into summary rows; a progress update parts them (the calls
 * before it fold into one row, the calls after it into another, each where its
 * first call was) and stays a row of its own, and so does a
 * message you sent while the agent worked.
 */
export function turnRows(turn: ChatTurn): ChatTurnRow[] {
  const asItems = (): ChatTurnRow[] => turn.items.map((item) => ({ type: "item", item }));
  if (!turn.isFinished) return asItems();
  const groups: ChatToolCall[][] = [[]];
  for (const item of turn.items) {
    const current = groups[groups.length - 1]!;
    if (item.type === "toolCall" && folds(item.value)) current.push(item.value);
    else if (parts(item) && current.length > 0) groups.push([]);
  }
  if (!groups.some((group) => group.length > 0)) return asItems();
  const rows: ChatTurnRow[] = [];
  let group = 0;
  let placed = false;
  for (const item of turn.items) {
    if (item.type === "toolCall" && folds(item.value)) {
      const calls = groups[group] ?? [];
      const summary = foldSummaryLine(calls);
      if (!placed && summary !== null) {
        const first = calls[0]!;
        rows.push({
          type: "folded",
          folded: { id: group === 0 ? turn.id + "/folded" : turn.id + "/folded/" + first.id, summary, calls },
        });
        placed = true;
      }
      continue;
    }
    if (parts(item) && placed) {
      group += 1;
      placed = false;
    }
    rows.push({ type: "item", item });
  }
  return rows;
}

// MARK: - Timeline views

export function runningTurn(timeline: ChatTimeline): ChatTurn | null {
  const last = timeline.turns[timeline.turns.length - 1];
  return last === undefined || last.isFinished ? null : last;
}

export const workingSince = (timeline: ChatTimeline): number | null => runningTurn(timeline)?.startedAt ?? null;

export const timelineItemCount = (timeline: ChatTimeline): number => timeline.turns.reduce((n, turn) => n + turn.items.length, 0);

/**
 * A foreground subagent still
 * running when its turn ends (an interrupt, the pane gone idle, your next
 * message) stopped with it, at `time` (else the turn's last event); a
 * background one runs on. The turn's items with that done.
 */
export function stoppingForegroundAgents(turn: ChatTurn, time: number | null): ChatItem[] {
  const stoppedAt = time ?? turn.lastEventAt;
  return turn.items.map((item): ChatItem => {
    if (item.type !== "agents" || !item.value.agents.some((agent) => !agent.background && agent.state === "running")) return item;
    const agents = item.value.agents.map((agent): ChatSubagent => (!agent.background && agent.state === "running" ? { ...agent, state: "stopped", finishedAt: stoppedAt } : agent));
    return { type: "agents", value: { ...item.value, agents } };
  });
}

/** The same timeline with its running turn treated as ended at its last event (its foreground subagents stopped). */
export function endingRunningTurn(timeline: ChatTimeline): ChatTimeline {
  const last = timeline.turns[timeline.turns.length - 1];
  if (last === undefined || last.isFinished) return timeline;
  const endedAt = last.lastEventAt ?? last.startedAt;
  const ended: ChatTurn = { ...last, isFinished: true, endedAt, items: stoppingForegroundAgents(last, endedAt) };
  const hidden = timeline.hiddenRunning === undefined ? {} : { hiddenRunning: { ...timeline.hiddenRunning, foreground: 0 } };
  // Its foreground subagents leave the running list with it; background work runs on.
  const running = timeline.running === undefined ? {} : { running: timeline.running.filter((work) => !(work.kind === "agent" && !work.background)) };
  return { ...timeline, ...hidden, ...running, turns: [...timeline.turns.slice(0, -1), ended] };
}

// MARK: - Wording

function counted(n: number, singular: string, plural?: string): string {
  return `${n} ` + (n === 1 ? singular : (plural ?? singular + "s"));
}

/** The folded line for a finished turn: "Read 2 files, ran 1 command". */
export function foldSummaryLine(calls: readonly ChatToolCall[]): string | null {
  if (calls.length === 0) return null;
  const reads = new Set<string>();
  const edits = new Set<string>();
  let readsUnnamed = 0;
  let editsUnnamed = 0;
  let commands = 0;
  let searches = 0;
  let web = 0;
  let agents = 0;
  let others = 0;
  let plan = false;
  for (const call of calls) {
    const kind = call.kind;
    if (typeof kind === "object") {
      others += 1;
      continue;
    }
    switch (kind) {
      case "read":
        if (call.target.length === 0) readsUnnamed += 1;
        else reads.add(call.target);
        break;
      case "edit": {
        let files: readonly string[] = call.detail.type === "diff" ? call.detail.diff.files : [];
        if (files.length === 0 && call.target.length > 0) files = [call.target];
        if (files.length === 0) editsUnnamed += 1;
        else for (const file of files) edits.add(file);
        break;
      }
      case "bash":
        commands += 1;
        break;
      case "search":
        searches += 1;
        break;
      case "web":
        web += 1;
        break;
      case "agent":
        agents += 1;
        break;
      case "plan":
        plan = true;
        break;
    }
  }
  const parts: string[] = [];
  const readCount = reads.size + readsUnnamed;
  const editCount = edits.size + editsUnnamed;
  if (readCount > 0) parts.push(`read ${counted(readCount, "file")}`);
  if (editCount > 0) parts.push(`edited ${counted(editCount, "file")}`);
  if (commands > 0) parts.push(`ran ${counted(commands, "command")}`);
  if (searches > 0) parts.push(`ran ${counted(searches, "search", "searches")}`);
  if (web > 0) parts.push(`made ${counted(web, "web request")}`);
  if (agents > 0) parts.push(`ran ${counted(agents, "agent")}`);
  if (plan) parts.push("updated the plan");
  if (others > 0) parts.push(`used ${counted(others, "other tool")}`);
  const first = parts[0];
  if (first === undefined) return null;
  parts[0] = first.slice(0, 1).toUpperCase() + first.slice(1);
  return parts.join(", ");
}

/** Swift's `TimeInterval.rounded()`: half away from zero. */
function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** "12s", "2m 41s", "1h 4m". */
export function compactDuration(seconds: number): string {
  const total = Math.max(0, roundHalfAway(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// MARK: - A subagent's current step

const stepBaseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
};

/** The first non-empty line of `text`, trimmed. */
const stepFirstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";

/** A step is one line: at most this many characters. */
export const maxStepCharacters = 120;

/**
 * A tool call in a few words, as its row says it (ToolRows' label and target): "Read foo.ts",
 * "Edit foo.ts", "Search lineLimit"; a shell command is "Ran" and its first line ("Ran npm test").
 */
export function toolStepText(call: ChatToolCall): string {
  const kind = call.kind;
  let label: string;
  let target: string;
  switch (kind) {
    case "read":
      [label, target] = ["Read", stepBaseName(call.target)];
      break;
    case "edit":
      [label, target] = ["Edit", stepBaseName(call.target)];
      break;
    case "bash":
      [label, target] = [call.toolName === "Bash" || call.toolName === "" ? "Ran" : call.toolName, stepFirstLine(call.target)];
      break;
    case "search":
      [label, target] = ["Search", call.target];
      break;
    case "web":
      [label, target] = ["Web", call.target];
      break;
    case "agent":
      [label, target] = ["Agent", call.target];
      break;
    case "plan":
      [label, target] = ["Plan", call.target];
      break;
    default:
      [label, target] = [call.toolName === "" ? kind.other : call.toolName, call.target];
  }
  const text = (target.trim().length > 0 ? `${label} ${stepFirstLine(target)}` : label).trim();
  const characters = Array.from(text);
  return characters.length > maxStepCharacters ? characters.slice(0, maxStepCharacters - 1).join("") + "…" : text;
}

/** What a running subagent is doing now: its newest step, or null (not running, or none read). */
export function subagentStepText(agent: ChatSubagent): string | null {
  if (agent.state !== "running") return null;
  const step = agent.step ?? null;
  return step === null || step.trim().length === 0 ? null : step;
}
