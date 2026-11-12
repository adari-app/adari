// "While you were away" (a port of HerdrKit's AwayDigest.swift and
// AwayDigestBuilder.swift): what every agent did, on every machine, since you
// last looked. The digest is plain values built from
// the panes (taken through the sidebar's model, so whatever pane the sidebar
// lists joins it), each pane's transcript after `since` (read with the chat's
// own parser and timeline builder, so the ids are the chat's) and git in its
// folder. No I/O here: readers.ts gathers the inputs, the main process's
// AwayService builds and sends the digest, the page draws it.
//
// Times are seconds since 1970, as the chat model's.

import { ChatTimelineBuilder } from "../chat/builder";
import type { ChatSession } from "../chat/locator";
import { compactDuration, toolKindName, turnToolCalls, type ChatAgentText, type ChatItem, type ChatToolCall, type TranscriptEvent } from "../chat/model";
import { TranscriptParser, type TranscriptFormat } from "../chat/parser";
import { asObject, asString, ChatJSON, objects, parseChatDate } from "../chat/tools";
import type { TranscriptLine } from "../chat/follower";
import { buildSidebarModel, emptyFoldState, type AgentStatus, type SidebarInput, type SidebarRow } from "../sidebar-model";

/** The screen's four groups, in screen order. */
export type AwayGroup = "needsYou" | "finished" | "working" | "quiet";
export const awayGroups: readonly AwayGroup[] = ["needsYou", "finished", "working", "quiet"];

export function awayGroupTitle(group: AwayGroup): string {
  return { needsYou: "Needs you", finished: "Finished", working: "Still working", quiet: "Quiet" }[group];
}

/** One agent pane the digest covers. */
export interface AwayPane {
  readonly paneID: string;
  /** The name the sidebar shows (pane label, tab label, agent kind). */
  readonly name: string;
  /** `claude`, `codex`, `grok`, … */
  readonly kind: string;
  readonly folder: string | null;
  readonly status: AgentStatus;
  /** When it entered its current status, when Herdr says. */
  readonly statusSince: number | null;
  /** Which transcript is the pane's (the chat's session rule), or null when none can be read. */
  readonly session: ChatSession | null;
}

const statusSinceSeconds = (row: SidebarRow): number | null =>
  typeof row.statusSinceUnixMs === "number" && Number.isFinite(row.statusSinceUnixMs) ? row.statusSinceUnixMs / 1000 : null;

/**
 * Every agent pane the sidebar's model lists for `input`, whatever the sidebar
 * has folded or searched: the digest sees them all. `sessions` gives each
 * pane's transcript (by pane id).
 */
export function awayPanes(input: SidebarInput, sessions: Readonly<Record<string, ChatSession | null>>): AwayPane[] {
  const model = buildSidebarModel({ ...input, fold: emptyFoldState, search: "" });
  const seen = new Set<string>();
  const panes: AwayPane[] = [];
  for (const section of model.priority) {
    for (const row of section.rows) {
      if (!row.isAgent || seen.has(row.paneID)) continue;
      seen.add(row.paneID);
      panes.push({
        paneID: row.paneID,
        name: row.name,
        kind: row.kind,
        folder: row.cwd ?? null,
        status: row.status,
        statusSince: statusSinceSeconds(row),
        session: sessions[row.paneID] ?? null,
      });
    }
  }
  return panes;
}

/** The first lines of a reply (markdown, as written). */
export interface AwayReply {
  readonly lines: readonly string[];
  readonly time: number | null;
}

/** A failed command or call, or an API error, in a line. */
export interface AwayError {
  readonly text: string;
  readonly time: number | null;
}

export interface AwayCommit {
  readonly hash: string;
  readonly subject: string;
  /** The committer's time. */
  readonly time: number;
}

export const shortHash = (commit: AwayCommit): string => commit.hash.slice(0, 7);

/** What `git log` in a pane's folder gave. */
export type AwayGitResult =
  /** Commits since `since`, newest first. */
  | { readonly kind: "commits"; readonly commits: readonly AwayCommit[] }
  | { readonly kind: "notARepository" }
  | { readonly kind: "failed" }
  | { readonly kind: "timedOut" };

/** What one pane's transcript says happened after `since`. */
export interface AwayActivity {
  /** Turns the agent ended after `since` (one that began before counts). */
  readonly turnsFinished: number;
  readonly lastTurnEndedAt: number | null;
  /** The newest reply after `since`: its first lines. */
  readonly lastReply: AwayReply | null;
  /** Files its own Edit, Write and patch calls changed after `since`, each once, in the order first changed. */
  readonly files: readonly string[];
  /** Failed calls (commands, tools) and API errors after `since`. */
  readonly errorCount: number;
  readonly lastError: AwayError | null;
  /** The newest event read (before `since` too). */
  readonly lastActivityAt: number | null;
  /** The first item after `since` (the chat's id for it). */
  readonly firstNewItemID: string | null;
  /** When the call the agent's last turn still waits on started (a permission menu waits on its call). */
  readonly pendingCallAt: number | null;
  /** The read stopped at its cap before it reached `since`: there is more. */
  readonly truncated: boolean;
}

export function awayActivity(fields: Partial<AwayActivity> = {}): AwayActivity {
  return {
    turnsFinished: fields.turnsFinished ?? 0,
    lastTurnEndedAt: fields.lastTurnEndedAt ?? null,
    lastReply: fields.lastReply ?? null,
    files: fields.files ?? [],
    errorCount: fields.errorCount ?? 0,
    lastError: fields.lastError ?? null,
    lastActivityAt: fields.lastActivityAt ?? null,
    firstNewItemID: fields.firstNewItemID ?? null,
    pendingCallAt: fields.pendingCallAt ?? null,
    truncated: fields.truncated ?? false,
  };
}

/** What came of reading a pane's transcript. */
export type AwayTranscriptState =
  | { readonly kind: "read"; readonly activity: AwayActivity }
  /** No transcript this app reads (Grok, an agent starting). */
  | { readonly kind: "noTranscript" }
  /** The file was not found or could not be read. */
  | { readonly kind: "unreadable" }
  /** Past the panes read on one machine (AwayLimits.panesPerMac). */
  | { readonly kind: "notRead" };

export interface AwayPaneInput {
  readonly pane: AwayPane;
  readonly transcript: AwayTranscriptState;
}

export type AwayMacState =
  | { readonly kind: "online" }
  /** It stopped answering (`since`: when it last did). */
  | { readonly kind: "offline"; readonly since: number | null }
  /** Listed but not connected (`since`: when it last was). */
  | { readonly kind: "notConnected"; readonly since: number | null };

/** One machine's inputs. */
export interface AwayMacInput {
  readonly id: string;
  readonly name: string;
  /** When you last looked at this machine. */
  readonly since: number;
  readonly state: AwayMacState;
  readonly panes: readonly AwayPaneInput[];
  /** Folder → what `git log` there gave. */
  readonly git: Readonly<Record<string, AwayGitResult>>;
}

// MARK: - output

export type AwayCardTranscript = AwayTranscriptState["kind"];

/** One agent's card. */
export interface AwayCard {
  /** `<machine id>|<pane id>`. */
  readonly id: string;
  readonly macID: string;
  readonly macName: string;
  readonly paneID: string;
  readonly name: string;
  readonly kind: string;
  readonly folder: string | null;
  readonly status: AgentStatus;
  readonly group: AwayGroup;
  readonly turnsFinished: number;
  readonly lastReply: AwayReply | null;
  /** Every file changed, and the first `shownFiles`. */
  readonly fileCount: number;
  readonly files: readonly string[];
  /** Every commit in its folder since `since`, and the newest `shownCommits`. */
  readonly commitCount: number;
  readonly commits: readonly AwayCommit[];
  /** The hashes of all `commitCount` commits (at most `git log`'s `gitMaxCommits`), so a total counts each once. */
  readonly commitHashes: readonly string[];
  readonly errorCount: number;
  readonly lastError: AwayError | null;
  /** Waiting on you since (Needs you only). */
  readonly waitingSince: number | null;
  readonly lastActivityAt: number | null;
  readonly lastFinishedAt: number | null;
  /** Where the chat should open: the first item after `since`. */
  readonly firstNewItemID: string | null;
  /** The transcript read stopped at its cap: there is more than shown. */
  readonly more: boolean;
  readonly transcript: AwayCardTranscript;
  /** Something happened since you last looked: a turn finished, files changed, a commit, or it started waiting on you. */
  readonly isNew: boolean;
}

/** "Waiting 1h 4m", for a card that waits. */
export function waitingText(card: AwayCard, now: number): string | null {
  return card.waitingSince === null ? null : "Waiting " + compactDuration(now - card.waitingSince);
}

/** A machine's line on the screen (nothing while it answers). */
export interface AwayMacLine {
  readonly id: string;
  readonly name: string;
  readonly state: AwayMacState;
}

/** Everything the screen shows. */
export interface AwayDigest {
  readonly generatedAt: number;
  /** In screen order: by group, then each group's order. */
  readonly cards: readonly AwayCard[];
  readonly macs: readonly AwayMacLine[];
}

export const emptyAwayDigest: AwayDigest = { generatedAt: 0, cards: [], macs: [] };

export const cardsIn = (digest: AwayDigest, group: AwayGroup): AwayCard[] => digest.cards.filter((card) => card.group === group);

/**
 * Commits on each machine counted once, by hash: two agents in one folder show
 * the same commits on both cards, and worktrees of one repository
 * share its history, so each worktree's log lists the same commits again. Every
 * card carries all its commits' hashes (bounded by `git log --max-count`), the
 * log already printed them: no other command runs.
 */
export function digestCommitCount(digest: AwayDigest): number {
  const seen = new Set<string>();
  for (const card of digest.cards) for (const hash of card.commitHashes) seen.add(card.macID + "|" + hash);
  return seen.size;
}

/** Something happened since you last looked. */
export const digestHasNews = (digest: AwayDigest): boolean => digest.cards.some((card) => card.isNew);

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** "6 agents: 2 need you, 3 finished, 4 commits" (counts that are 0 left out; "2 working" when nothing else is to say). */
export function digestSummaryText(digest: AwayDigest): string {
  const needsYou = cardsIn(digest, "needsYou").length;
  const finished = cardsIn(digest, "finished").length;
  const working = cardsIn(digest, "working").length;
  const commits = digestCommitCount(digest);
  const parts: string[] = [];
  if (needsYou > 0) parts.push(`${needsYou} need${needsYou === 1 ? "s" : ""} you`);
  if (finished > 0) parts.push(`${finished} finished`);
  if (commits > 0) parts.push(plural(commits, "commit", "commits"));
  if (parts.length === 0 && working > 0) parts.push(`${working} working`);
  const head = plural(digest.cards.length, "agent", "agents");
  return parts.length === 0 ? head : head + ": " + parts.join(", ");
}

// MARK: - one pane's transcript (AwayDigestBuilder.activity)

/** A card names this many changed files and commits; the rest count. */
export const shownFiles = 5;
export const shownCommits = 5;
/** A reply shows this many of its first lines. */
export const replyLineCount = 4;
const replyLineCharacters = 240;
const errorCharacters = 160;
/** The timeline built from one read keeps this many items (a 2 MB read holds far fewer). */
const keptItems = 20_000;

function bounded(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : text;
}

const later = (a: number | null, b: number): number => (a === null ? b : Math.max(a, b));

/**
 * The agent's own turns, apart from how the chat splits them on screen (where
 * any message you send opens a new turn): a run begins when the agent writes or
 * calls a tool and ends at its end of turn. `apply` returns when a run ended.
 */
export class AgentRun {
  /** The agent wrote or called a tool since the last end. */
  private active = false;
  /** Its calls with no result yet, since your last message. */
  private waiting = new Set<string>();
  /** The newest time seen, for an end that has none. */
  private lastTime: number | null = null;

  apply(event: TranscriptEvent): number | null {
    switch (event.type) {
      case "agentText":
        this.note(event.text.time);
        this.active = true;
        break;
      case "agentProgress":
        // A progress update alone never makes a finished turn.
        this.note(event.text.time);
        break;
      case "toolStarted":
        this.note(event.call.time);
        if (event.call.isUserShell) return null;
        this.active = true;
        if (event.call.state === "running") this.waiting.add(event.call.id);
        break;
      case "toolFinished":
        this.note(event.time);
        this.waiting.delete(event.id);
        break;
      case "userMessage":
        // Queued or typed while the agent works: the run goes on. After a
        // message you typed, calls before it no longer hold an end back.
        this.note(event.message.time);
        if (event.queued !== true) this.waiting.clear();
        break;
      case "userShell":
        this.note(event.call.time);
        break;
      case "notice":
        this.note(event.notice.time);
        // Stopped by you (an interrupt): not the agent's end.
        if (event.endsTurn) this.reset();
        break;
      case "turnStarted":
        // Codex begins a turn: one with no task_complete is over, unfinished.
        this.note(event.time);
        this.reset();
        break;
      case "turnCompleted":
        this.note(event.time);
        return this.end(event.time);
      case "agentStopped":
        this.note(event.time);
        // Claude's end_turn while a call waits ends nothing.
        if (this.waiting.size > 0) return null;
        return this.end(event.time);
      case "agentMessage":
        // Not your message, not the agent's work.
        this.note(event.message.time);
        break;
      case "taskNotified":
      case "taskStopped":
        this.note(event.time);
        break;
      case "sessionChanged":
        break;
      case "agentTextChunk":
        // A part of the reply (or of the thinking).
        this.note(event.text.time);
        if (!event.progress) this.active = true;
        break;
      case "toolRevised":
        this.note(event.call.time);
        if (!this.waiting.has(event.call.id) && event.call.state === "running" && !event.call.isUserShell) {
          this.active = true;
          this.waiting.add(event.call.id);
        }
        break;
      case "userMessageAmended":
        this.note(event.message.time);
        break;
      case "title":
      case "customTitle":
      case "turnMeasured":
      // When the running turn began says nothing of its end.
      case "turnBegan":
        break;
    }
    return null;
  }

  private end(time: number | null): number | null {
    const active = this.active;
    this.reset();
    return active ? (time ?? this.lastTime) : null;
  }

  private reset(): void {
    this.active = false;
    this.waiting.clear();
  }

  private note(time: number | null): void {
    if (time !== null) this.lastTime = this.lastTime === null ? time : Math.max(this.lastTime, time);
  }
}

/** When an item last changed: a call when its result came, anything else when it was written. */
export function changedAt(item: ChatItem): number | null {
  if (item.type === "toolCall" && item.value.finishedAt !== null) {
    const call = item.value;
    return call.time === null ? call.finishedAt : Math.max(call.time, call.finishedAt!);
  }
  return item.value.time;
}

/** The reply's first `replyLineCount` lines that are not blank, each kept to 240 characters. */
export function replyLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const raw of markdown.split(/[\n\r]/)) {
    const line = raw.trim();
    if (line === "") continue;
    lines.push(bounded(line, replyLineCharacters));
    if (lines.length === replyLineCount) break;
  }
  return lines;
}

/** The files an edit call changed: its diff's files, else its target. */
export function changedPaths(call: ChatToolCall): string[] {
  if (call.detail.type === "diff" && call.detail.diff.files.length > 0) return call.detail.diff.files.filter((file) => file !== "");
  const target = call.target.trim();
  return target === "" ? [] : [target];
}

const firstLineOf = (text: string): string => (text.split(/[\n\r]/).find(() => true) ?? "").trim();

/** "Bash swift test · exit 1": the call's verb, its target's first line and its result. */
export function errorText(call: ChatToolCall): string {
  const target = firstLineOf(call.target);
  let text = toolKindName(call.kind);
  if (target !== "") text += " " + target;
  text += " · " + (call.resultSummary !== null && call.resultSummary !== "" ? call.resultSummary : "failed");
  return bounded(text, errorCharacters);
}

function firstLineOr(text: string, fallback: string): string {
  const line = firstLineOf(text);
  return line === "" ? fallback : bounded(line, errorCharacters);
}

/**
 * An API error the agent wrote: Claude Code's reply line marked
 * `isApiErrorMessage` (written once its retries gave up), Codex's `event_msg` of
 * type `error`. Retries in progress are not counted.
 */
export function apiError(line: string, format: TranscriptFormat): AwayError | null {
  if (format === "claude") {
    if (!line.includes("isApiErrorMessage")) return null;
    const object = ChatJSON.object(line);
    if (object === null || !ChatJSON.bool(object.isApiErrorMessage)) return null;
    const message = asObject(object.message);
    let text = asString(message?.content) ?? "";
    if (text === "") {
      text = (objects(message?.content) ?? [])
        .map((block) => asString(block.text))
        .filter((part): part is string => part !== null)
        .join(" ");
    }
    return { text: firstLineOr(text, "API error"), time: parseChatDate(object.timestamp) };
  }
  if (!line.includes('"error"')) return null;
  const object = ChatJSON.object(line);
  const payload = asObject(object?.payload);
  if (object === null || asString(object.type) !== "event_msg" || payload === null || asString(payload.type) !== "error") return null;
  return { text: firstLineOr(asString(payload.message) ?? "", "Error"), time: parseChatDate(object.timestamp) };
}

/**
 * What the transcript lines (oldest first, with their offsets) say happened
 * after `since`. A turn counts as finished when the agent ended it (Claude's
 * end_turn with no call waiting, Codex's task_complete) after `since`,
 * wherever it began; a message you queued or typed while it ran finishes
 * nothing, nor does an interrupt. Items count when they happened after `since`
 * (a call when its result came).
 */
export function awayActivityOf(lines: readonly TranscriptLine[], format: TranscriptFormat, since: number, truncated = false): AwayActivity {
  const parser = new TranscriptParser(format);
  const builder = new ChatTimelineBuilder(keptItems, keptItems);
  const errors: AwayError[] = [];
  // Replies that are an API error, not an answer.
  const errorReplyIDs = new Set<string>();
  const errorReplyTexts = new Set<string>();
  const run = new AgentRun();
  const completions: number[] = [];
  for (const line of lines) {
    const result = parser.parse(line.text, line.offset);
    for (const event of result.events) {
      const ended = run.apply(event);
      if (ended !== null) completions.push(ended);
    }
    const error = apiError(line.text, format);
    if (error !== null) {
      if (error.time !== null && error.time >= since) errors.push(error);
      for (const event of result.events) {
        if (event.type !== "agentText") continue;
        errorReplyIDs.add(event.text.id);
        errorReplyTexts.add(event.text.markdown);
      }
    }
    builder.apply(result.events, line.offset);
  }

  let turnsFinished = 0;
  let lastTurnEndedAt: number | null = null;
  for (const ended of completions) {
    if (ended < since) continue;
    turnsFinished += 1;
    lastTurnEndedAt = later(lastTurnEndedAt, ended);
  }
  const files: string[] = [];
  const seenFiles = new Set<string>();
  let lastActivityAt: number | null = null;
  let firstNewItemID: string | null = null;
  let lastReply: ChatAgentText | null = null;
  const turns = builder.timeline.turns;
  for (const turn of turns) {
    if (turn.lastEventAt !== null) lastActivityAt = later(lastActivityAt, turn.lastEventAt);
    for (const item of turn.items) {
      const time = changedAt(item);
      if (time === null) continue;
      lastActivityAt = later(lastActivityAt, time);
      if (time < since) continue;
      firstNewItemID ??= item.value.id;
      if (item.type === "agentText") {
        const isError = errorReplyIDs.has(item.value.id) || errorReplyTexts.has(item.value.markdown);
        if (!isError && replyLines(item.value.markdown).length > 0) lastReply = item.value;
      } else if (item.type === "toolCall") {
        const call = item.value;
        if (call.isUserShell) continue;
        // Only a change that went through: an Edit waiting on a permission menu has changed nothing yet.
        if (call.kind === "edit" && call.state === "ok") {
          for (const path of changedPaths(call)) {
            if (seenFiles.has(path)) continue;
            seenFiles.add(path);
            files.push(path);
          }
        }
        if (call.state === "failed") errors.push({ text: errorText(call), time: call.finishedAt ?? call.time });
      }
    }
  }
  let pendingCallAt: number | null = null;
  const last = turns.at(-1);
  if (last !== undefined && !last.isFinished) {
    const waiting = turnToolCalls(last)
      .filter((call) => call.state === "running" && !call.isUserShell)
      .at(-1);
    if (waiting !== undefined) pendingCallAt = waiting.time ?? last.lastEventAt;
  }
  // The newest error: known times after unknown ones, a later one on a tie.
  let lastError: AwayError | null = null;
  for (const error of errors) {
    if (lastError === null || (error.time ?? -Infinity) >= (lastError.time ?? -Infinity)) lastError = error;
  }
  return {
    turnsFinished,
    lastTurnEndedAt,
    lastReply: lastReply === null ? null : { lines: replyLines(lastReply.markdown), time: lastReply.time },
    files,
    errorCount: errors.length,
    lastError,
    lastActivityAt,
    firstNewItemID,
    pendingCallAt,
    truncated,
  };
}

// MARK: - the digest (AwayDigestBuilder.build)

const latest = (...times: (number | null | undefined)[]): number | null => {
  const known = times.filter((time): time is number => typeof time === "number");
  return known.length === 0 ? null : Math.max(...known);
};

export function awayCard(input: AwayPaneInput, mac: AwayMacInput): AwayCard {
  const pane = input.pane;
  const activity = input.transcript.kind === "read" ? input.transcript.activity : null;
  let commits: AwayCommit[] = [];
  const git = pane.folder === null ? undefined : mac.git[pane.folder];
  if (git?.kind === "commits") commits = git.commits.filter((commit) => commit.time >= mac.since).sort((a, b) => b.time - a.time);
  const turns = activity?.turnsFinished ?? 0;
  const files = activity?.files ?? [];
  const errors = activity?.errorCount ?? 0;
  const blocked = pane.status === "blocked";
  const waitingSince = blocked ? (pane.statusSince ?? activity?.pendingCallAt ?? activity?.lastActivityAt ?? null) : null;
  let group: AwayGroup;
  if (pane.status === "blocked") group = "needsYou";
  else if (pane.status === "working") group = "working";
  else group = turns > 0 || files.length > 0 || commits.length > 0 || errors > 0 ? "finished" : "quiet";
  const startedWaiting = blocked && waitingSince !== null && waitingSince >= mac.since;
  return {
    id: mac.id + "|" + pane.paneID,
    macID: mac.id,
    macName: mac.name,
    paneID: pane.paneID,
    name: pane.name,
    kind: pane.kind,
    folder: pane.folder,
    status: pane.status,
    group,
    turnsFinished: turns,
    lastReply: activity?.lastReply ?? null,
    fileCount: files.length,
    files: files.slice(0, shownFiles),
    commitCount: commits.length,
    commits: commits.slice(0, shownCommits),
    commitHashes: commits.map((commit) => commit.hash),
    errorCount: errors,
    lastError: activity?.lastError ?? null,
    waitingSince,
    lastActivityAt: latest(activity?.lastActivityAt, commits[0]?.time),
    lastFinishedAt: latest(activity?.lastTurnEndedAt, commits[0]?.time),
    firstNewItemID: activity?.firstNewItemID ?? null,
    more: activity?.truncated ?? false,
    transcript: input.transcript.kind,
    isNew: turns > 0 || files.length > 0 || commits.length > 0 || startedWaiting,
  };
}

/** Known times before unknown ones; null on a tie. */
function compare(a: number | null, b: number | null, newestFirst: boolean): boolean | null {
  if (a !== null && b !== null && a !== b) return newestFirst ? a > b : a < b;
  if (a !== null && b === null) return true;
  if (a === null && b !== null) return false;
  return null;
}

/** Whether `a` goes before `b`; null when they tie. */
export function precedes(a: AwayCard, b: AwayCard): boolean | null {
  const ga = awayGroups.indexOf(a.group);
  const gb = awayGroups.indexOf(b.group);
  if (ga !== gb) return ga < gb;
  switch (a.group) {
    case "needsYou":
      return compare(a.waitingSince, b.waitingSince, false);
    case "finished":
      return compare(a.lastFinishedAt ?? a.lastActivityAt, b.lastFinishedAt ?? b.lastActivityAt, true);
    case "working":
    case "quiet":
      return compare(a.lastActivityAt, b.lastActivityAt, true);
  }
}

/**
 * The cards of every machine, grouped (Needs you, Finished, Still working,
 * Quiet) and ordered: Needs you by the longest wait, Finished by the most
 * recent (a turn's end or a commit), Still working and Quiet by the most recent
 * activity; ties keep the order given.
 */
export function buildAwayDigest(macs: readonly AwayMacInput[], now: number): AwayDigest {
  const cards: { index: number; card: AwayCard }[] = [];
  for (const mac of macs) for (const input of mac.panes) cards.push({ index: cards.length, card: awayCard(input, mac) });
  cards.sort((a, b) => {
    const before = precedes(a.card, b.card);
    if (before === null) return a.index - b.index;
    return before ? -1 : 1;
  });
  return {
    generatedAt: now,
    cards: cards.map((entry) => entry.card),
    macs: macs.map((mac) => ({ id: mac.id, name: mac.name, state: mac.state })),
  };
}

// MARK: - what the page is sent

/** "While you were away" as the page shows it (the main process's AwayService sends it on every change). */
export interface AwayViewState {
  /** The digest of this visit; null until a machine has been read. */
  readonly digest: AwayDigest | null;
  /** A read runs (the first, or a machine that connected since). */
  readonly building: boolean;
  /** When you chose Mark all seen this visit, or null. */
  readonly seenAt: number | null;
}

export const initialAwayViewState: AwayViewState = { digest: null, building: false, seenAt: null };
