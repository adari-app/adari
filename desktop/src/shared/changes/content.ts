// A port of the Swift app's CompanionChangesText and
// CompanionChangesContent (App/CompanionChangesModel.swift): the words, an
// agent's Changes as rows (this turn, this session, its folder now, the
// commits this session) in every state, and the across-agents screen's rows
// (each machine, then each workspace with its agents, changes first). Shared:
// the main process reads, the page draws these rows.

import type { SessionTopology } from "../../main/herdr/wire";
import { clockText, documentFromGit, type DiffDocument } from "./diff";
import {
  changedCount,
  changeKind,
  isFolder,
  isMerge,
  isStaged,
  isUnstaged,
  isUntracked,
  shortHash,
  statusAdded,
  statusRemoved,
  untrackedCount,
  type AgentCommit,
  type AgentCommitsRead,
  type GitChangeKind,
  type GitFileChange,
  type GitFolderRead,
  type GitFolderStatus,
  type GitHead,
  type GitText,
  type GitTextResult,
} from "./git";
import { rowHasChanges, type AgentOverviewGroup, type AgentOverviewRow, type AgentToolRead } from "./overview";
import { displayPath, editCount, type AgentChangedFile, type AgentToolChanges } from "./tools";

// MARK: - the words

export const changesText = {
  title: "Changes",
  entrySubtitle: "What each agent changed",
  readingGit: "Reading git…",
  readingTranscript: "Reading what it changed…",
  readingDiff: "Reading the diff…",
  readingEveryAgent: "Reading every agent's folder…",
  /** A machine's read failed: said on it, never a spinner left turning. */
  overviewFailed: "This machine's folders could not be read. Refresh to try again.",
  /** The desktop lists any SSH machine, not only Macs: "The machine". */
  offline: "The machine is offline: its folders can't be read now.",
  /** The desktop reads the transcript over the same connection: offline, nothing of it is read. */
  toolsOffline: "Its own changes can't be read while the machine is offline.",
  /** A filter git would run is not run from here. */
  runsAFilter: "This folder's git setup runs a filter; open it in a terminal.",
  failed: "git could not be read.",
  timedOut: "git did not answer within 5 seconds.",
  commitsFailed: "The commits could not be read.",
  detailNotARepository: "The folder is not a git repository.",
  detailNoFolder: "The folder is not there.",
} as const;

export function noTranscriptText(kind: string): string {
  if (kind.toLowerCase() === "cursor") return "Cursor's chat isn't read here: this shows its folder's git only.";
  return kind.toLowerCase() === "grok"
    ? "Grok's transcript isn't read here: this shows its folder's git only."
    : "No transcript is read for this agent: this shows its folder's git only.";
}

/** "Also used by Review and Ops: the folder's changes are theirs too." */
export function sharingText(names: readonly string[]): string {
  if (names.length === 0) return "";
  const list = names.length === 1 ? names[0]! : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]!;
  return "Also used by " + list + ": the folder's changes are theirs too.";
}

export const countsText = (added: number, removed: number): string => `+${added} −${removed}`;

export const filesText = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`;

export const editsText = (count: number): string => `${count} ${count === 1 ? "edit" : "edits"}`;

export function headText(head: GitHead): string {
  switch (head.kind) {
    case "branch":
      return head.name;
    case "detached":
      return "detached at " + head.hash;
    case "unborn":
      return head.name + ", no commits yet";
    case "unknown":
      return "git";
  }
}

const letters: Readonly<Record<GitChangeKind, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "?",
  conflicted: "U",
};

export const statusLetter = (kind: GitChangeKind): string => letters[kind];

const kindWords: Readonly<Record<GitChangeKind, string>> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  typeChanged: "type changed",
  untracked: "untracked",
  conflicted: "conflicted",
};

export const kindWord = (kind: GitChangeKind): string => kindWords[kind];

/** "modified · staged and not staged". */
export function fileSubtitle(change: GitFileChange): string {
  const parts = [kindWord(changeKind(change))];
  if (isStaged(change) && isUnstaged(change)) parts.push("staged and not staged");
  else if (isStaged(change)) parts.push("staged");
  else if (!isUntracked(change)) parts.push("not staged");
  if (isFolder(change)) parts.push("a folder: its files are not listed");
  return parts.join(" · ");
}

/** "modified, a.swift, 3 added, 1 removed" (a row's label). */
export function fileLabel(change: GitFileChange): string {
  let label = kindWord(changeKind(change)) + ", " + change.path;
  if (change.added !== null && change.removed !== null) label += `, ${change.added} added, ${change.removed} removed`;
  else if (change.binary) label += ", binary";
  return label;
}

/** A folder file's title: "old → new" for a rename. */
export const fileTitle = (change: GitFileChange): string => (change.originalPath === null ? change.path : `${change.originalPath} → ${change.path}`);

/** "4f1c2a9 · 9:12 PM · 1 file". */
export function commitMeta(commit: AgentCommit, timeZone?: string): string {
  const parts = [shortHash(commit), clockText(commit.time, timeZone)];
  if (isMerge(commit)) parts.push("merge");
  else if (commit.files !== null) parts.push(filesText(commit.files));
  return parts.join(" · ");
}

/** "main · 3 files +165 −3 · 1 untracked". */
export function gitSummary(status: GitFolderStatus): string {
  if (status.files.length === 0) return headText(status.head) + " · clean";
  const parts = [headText(status.head)];
  const changed = changedCount(status);
  if (changed > 0) parts.push(filesText(changed) + " " + countsText(statusAdded(status), statusRemoved(status)));
  const untracked = untrackedCount(status);
  if (untracked > 0) parts.push(`${untracked} untracked`);
  return parts.join(" · ");
}

/** The across-agents row's git words. */
export function gitLine(read: GitFolderRead | null): string {
  if (read === null) return "git not read";
  switch (read.kind) {
    case "repository":
      return gitSummary(read.status);
    case "notARepository":
      return "not a git repository";
    case "noFolder":
      return "folder not there";
    case "runsAFilter":
      return "git runs a filter here";
    case "failed":
      return "git could not be read";
    case "timedOut":
      return "git did not answer";
  }
}

/** The across-agents row's own-calls words. */
export function toolsLine(tools: AgentToolRead, kind: string): string {
  switch (tools.kind) {
    case "read": {
      const count = tools.changes.session.length;
      return count === 0 ? "no files by its own calls" : filesText(count) + " by its own calls";
    }
    case "noTranscript":
      return kind.toLowerCase() === "grok" || kind.toLowerCase() === "cursor" ? "git only" : "no transcript";
    case "unreadable":
      return "transcript not read";
    case "notRead":
      return "transcript not read (20 at a time)";
  }
}

/** An across-agents row's line: "main · 1 file +3 −1 · 2 files by its own calls". */
export const agentLine = (row: AgentOverviewRow): string => gitLine(row.git) + " · " + toolsLine(row.tools, row.pane.kind);

// MARK: - one agent's states

/** What the agent's own calls changed, as the view has it. */
export type ChangesToolsState =
  | { readonly kind: "loading" }
  | { readonly kind: "read"; readonly changes: AgentToolChanges }
  /** None read (Grok, no transcript named or readable): git only. */
  | { readonly kind: "none"; readonly reason: string };

export type ChangesGitState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "read"; readonly read: GitFolderRead }
  /** No folder is known for the pane. */
  | { readonly kind: "noFolder" }
  | { readonly kind: "offline" };

export type ChangesCommitsState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "read"; readonly read: AgentCommitsRead }
  | { readonly kind: "noFolder" }
  | { readonly kind: "offline" };

export type ChangesScope = "This turn" | "This session";

/** Everything an agent's Changes shows, to make its rows. */
export interface ChangesInput {
  readonly kind: string;
  readonly folder: string | null;
  readonly online: boolean;
  readonly tools: ChangesToolsState;
  readonly canLoadEarlier: boolean;
  readonly git: ChangesGitState;
  readonly commits: ChangesCommitsState;
  /** The start of the commits read (seconds since 1970). */
  readonly commitsSince: number | null;
  /** That start is the session's (else the last 12 hours). */
  readonly sinceKnown: boolean;
  readonly sharing: readonly string[];
}

export type ChangesTone = "plain" | "problem";

export type ChangesItemKind =
  | { readonly type: "header"; readonly title: string; readonly detail: string | null }
  | { readonly type: "note"; readonly text: string; readonly tone: ChangesTone }
  | { readonly type: "retry"; readonly text: string }
  | { readonly type: "loading"; readonly text: string }
  | { readonly type: "toolFile"; readonly file: AgentChangedFile; readonly scope: ChangesScope; readonly shown: string }
  | { readonly type: "gitFile"; readonly change: GitFileChange }
  | { readonly type: "commit"; readonly commit: AgentCommit }
  | { readonly type: "loadEarlier" };

/** One row of an agent's Changes. */
export interface ChangesItem {
  readonly id: string;
  readonly kind: ChangesItemKind;
}

/** The folder's files shown at most (the rest counted). */
export const maxGitFiles = 300;
/** Without the session's start, the commits of the last 12 hours (AwayLimits.firstSince). */
export const fallbackSinceSeconds = 12 * 60 * 60;

const folderHeader = "In its folder now";

/**
 * Newest first: the files its calls changed this turn and this session, the
 * folder now, the commits since the session began.
 */
export function changesItems(input: ChangesInput, timeZone?: string): ChangesItem[] {
  const items: ChangesItem[] = [];
  const add = (id: string, kind: ChangesItemKind): void => {
    items.push({ id, kind });
  };
  const header = (title: string, detail: string | null = null): ChangesItemKind => ({ type: "header", title, detail });
  const note = (text: string, tone: ChangesTone = "plain"): ChangesItemKind => ({ type: "note", text, tone });
  const clock = (seconds: number): string => clockText(seconds, timeZone);
  if (input.sharing.length > 0) add("sharing", note(sharingText(input.sharing)));
  if (!input.online) add("offline", note(changesText.offline, "problem"));

  const tools = input.tools;
  switch (tools.kind) {
    case "loading":
      add("turn", header("This turn"));
      add("tools-loading", { type: "loading", text: changesText.readingTranscript });
      break;
    case "none":
      add("tools", header("Its own changes"));
      add("tools-none", note(tools.reason));
      break;
    case "read": {
      const changes = tools.changes;
      const turnDetail = changes.thisTurnRunning ? "working" : changes.thisTurnStartedAt === null ? null : clock(changes.thisTurnStartedAt);
      add("turn", header("This turn", turnDetail));
      if (changes.thisTurn.length === 0) add("turn-empty", note("No files changed by its own calls this turn."));
      for (const file of changes.thisTurn) {
        add("turn|" + file.path, { type: "toolFile", file, scope: "This turn", shown: displayPath(file.path, input.folder) });
      }
      const edits = editCount(changes);
      add("session", header("This session", changes.session.length === 0 ? null : filesText(changes.session.length) + " · " + editsText(edits)));
      if (changes.session.length === 0) add("session-empty", note("No files changed by its own calls yet."));
      for (const file of changes.session) {
        add("session|" + file.path, { type: "toolFile", file, scope: "This session", shown: displayPath(file.path, input.folder) });
      }
      if (!changes.fromSessionStart) {
        const since = changes.firstTurnAt === null ? "" : ` (from ${clock(changes.firstTurnAt)})`;
        add("session-partial", note(`Only the turns read so far${since}.`));
        if (input.canLoadEarlier) add("load-earlier", { type: "loadEarlier" });
      }
      break;
    }
  }

  let repository = true;
  const git = input.git;
  switch (git.kind) {
    case "idle":
    case "loading":
      add("git", header(folderHeader));
      add("git-loading", { type: "loading", text: changesText.readingGit });
      break;
    case "noFolder":
      add("git", header(folderHeader));
      add("git-none", note("No folder is known for this pane."));
      repository = false;
      break;
    case "offline":
      repository = false;
      break;
    case "read": {
      const read = git.read;
      switch (read.kind) {
        case "repository": {
          const status = read.status;
          add("git", header(folderHeader, gitSummary(status)));
          if (status.files.length === 0) add("git-clean", note("Nothing changed in the folder."));
          for (const change of status.files.slice(0, maxGitFiles)) add("git|" + change.path, { type: "gitFile", change });
          if (status.files.length > maxGitFiles) add("git-more", note(`${maxGitFiles} of ${status.files.length} files shown.`));
          if (status.cut) add("git-cut", note("git's list was longer than 256 KB: the rest is not shown."));
          break;
        }
        case "notARepository":
          add("git", header(folderHeader));
          add("git-none", note(`${input.folder ?? "Its folder"} is not a git repository.`));
          repository = false;
          break;
        case "noFolder":
          add("git", header(folderHeader));
          add("git-none", note(`${input.folder ?? "Its folder"} is not there.`, "problem"));
          repository = false;
          break;
        case "runsAFilter":
          add("git", header(folderHeader));
          add("git-none", note(changesText.runsAFilter));
          break;
        case "failed":
          add("git", header(folderHeader));
          add("git-retry", { type: "retry", text: changesText.failed });
          break;
        case "timedOut":
          add("git", header(folderHeader));
          add("git-retry", { type: "retry", text: changesText.timedOut });
          break;
      }
      break;
    }
  }

  if (!repository) return items;
  const since = input.commitsSince === null ? null : clock(input.commitsSince);
  const title = input.sinceKnown || input.commitsSince === null ? "Commits this session" : "Commits, last 12 hours";
  const commits = input.commits;
  switch (commits.kind) {
    case "idle":
    case "loading":
      add("commits", header(title));
      add("commits-loading", { type: "loading", text: changesText.readingGit });
      break;
    case "noFolder":
    case "offline":
      break;
    case "read": {
      const read = commits.read;
      switch (read.kind) {
        case "commits":
          add("commits", header(title, since === null ? null : "since " + since));
          if (read.commits.length === 0) add("commits-empty", note(`No commits${since === null ? "" : " since " + since}.`));
          for (const commit of read.commits) add("commit|" + commit.hash, { type: "commit", commit });
          break;
        case "notARepository":
          break;
        case "failed":
          add("commits", header(title));
          add("commits-retry", { type: "retry", text: changesText.commitsFailed });
          break;
        case "timedOut":
          add("commits", header(title));
          add("commits-retry", { type: "retry", text: changesText.timedOut });
          break;
      }
      break;
    }
  }
  return items;
}

/**
 * The tools to show: the chat's (its newest turn, live); for the session, a
 * backward read of the transcript when it holds more turns than the chat (the
 * chat does not hold the session's start). The desktop reads the transcript
 * itself (no chat timeline is passed today: `chat` null).
 */
export function changesTools(chat: AgentToolChanges | null, read: AgentToolChanges | null, chatLoading: boolean, kind: string): ChangesToolsState {
  if (chat === null) {
    if (read !== null) return { kind: "read", changes: read };
    return chatLoading ? { kind: "loading" } : { kind: "none", reason: noTranscriptText(kind) };
  }
  if (chat.fromSessionStart || read === null || read.turnCount <= chat.turnCount) return { kind: "read", changes: chat };
  return {
    kind: "read",
    changes: { ...read, thisTurn: chat.thisTurn, thisTurnRunning: chat.thisTurnRunning, thisTurnStartedAt: chat.thisTurnStartedAt },
  };
}

// MARK: - every agent

export type ChangesOverviewState = "idle" | "loading" | "read" | "offline" | "failed";

/** One machine on the across-agents screen. */
export interface ChangesOverviewHost {
  readonly hostId: string;
  readonly name: string;
  readonly state: ChangesOverviewState;
  readonly groups: readonly AgentOverviewGroup[];
}

export type ChangesOverviewItemKind =
  | { readonly type: "mac"; readonly name: string; readonly detail: string | null }
  | { readonly type: "workspace"; readonly name: string }
  | { readonly type: "agent"; readonly hostId: string; readonly row: AgentOverviewRow }
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "loading" };

export interface ChangesOverviewItem {
  readonly id: string;
  readonly kind: ChangesOverviewItemKind;
}

/** One machine: the machine, then each workspace with its agents (changes first). */
export function overviewItems(state: ChangesOverviewState, macName: string, groups: readonly AgentOverviewGroup[], hostId = ""): ChangesOverviewItem[] {
  const items: ChangesOverviewItem[] = [];
  if (state === "offline") {
    items.push({ id: "offline", kind: { type: "note", text: changesText.offline } });
    return items;
  }
  if (state === "failed") {
    items.push({ id: "failed", kind: { type: "note", text: changesText.overviewFailed } });
    return items;
  }
  if ((state === "idle" || state === "loading") && groups.length === 0) {
    items.push({ id: "loading", kind: { type: "loading" } });
    return items;
  }
  const rows = groups.flatMap((group) => group.rows);
  const changed = rows.filter(rowHasChanges).length;
  items.push({
    id: "mac",
    kind: { type: "mac", name: macName, detail: rows.length === 0 ? null : `${changed} of ${rows.length} ${rows.length === 1 ? "agent" : "agents"} with changes` },
  });
  if (rows.length === 0) items.push({ id: "empty", kind: { type: "note", text: "No agents on this machine." } });
  for (const group of groups) {
    items.push({ id: "workspace|" + group.workspace, kind: { type: "workspace", name: group.workspace } });
    for (const row of group.rows) items.push({ id: "agent|" + row.pane.paneId, kind: { type: "agent", hostId, row } });
  }
  return items;
}

/**
 * Every machine in the sidebar, one after another (the desktop lists several):
 * each machine's rows as `overviewItems` makes them, its ids prefixed with the
 * machine's; an offline one keeps its name above its note.
 */
export function overviewHostsItems(hosts: readonly ChangesOverviewHost[]): ChangesOverviewItem[] {
  const items: ChangesOverviewItem[] = [];
  for (const host of hosts) {
    const own = overviewItems(host.state, host.name, host.groups, host.hostId);
    if (own[0]?.kind.type !== "mac") items.push({ id: host.hostId + "|mac", kind: { type: "mac", name: host.name, detail: null } });
    for (const item of own) items.push({ id: host.hostId + "|" + item.id, kind: item.kind });
  }
  if (hosts.length === 0) items.push({ id: "none", kind: { type: "note", text: "No machines are listed." } });
  return items;
}

/** A pane that was working is there and no longer is. */
export function turnFinished(old: Readonly<Record<string, boolean>>, now: Readonly<Record<string, boolean>>): boolean {
  return Object.entries(old).some(([pane, working]) => working && now[pane] === false);
}

// MARK: - the page's own

/** What an agent's Changes shows before its first read answers. */
export function loadingInput(kind: string, folder: string | null): ChangesInput {
  const known = folder !== null && folder.trim().length > 0;
  return {
    kind,
    folder: known ? folder : null,
    online: true,
    tools: { kind: "loading" },
    canLoadEarlier: false,
    git: known ? { kind: "loading" } : { kind: "noFolder" },
    commits: known ? { kind: "loading" } : { kind: "noFolder" },
    commitsSince: null,
    sinceKnown: false,
    sharing: [],
  };
}

/**
 * The machine offline as the sidebar has it: the service's
 * offline answer, shown without asking it (nothing can be read there now).
 */
export function offlineInput(kind: string, folder: string | null): ChangesInput {
  const known = folder !== null && folder.trim().length > 0;
  return {
    kind,
    folder: known ? folder : null,
    online: false,
    tools: { kind: "none", reason: changesText.toolsOffline },
    canLoadEarlier: false,
    git: { kind: "offline" },
    commits: { kind: "offline" },
    commitsSince: null,
    sinceKnown: false,
    sharing: [],
  };
}

/**
 * The pane's agent session as Herdr names it, as one string (a new
 * session in the same pane is a new context for an open Changes); null when
 * Herdr names none (then the agent and its folder are the context).
 */
export function agentSessionKey(topology: SessionTopology | null, paneId: string): string | null {
  const agent = topology?.agents.find((candidate) => candidate.paneID === paneId);
  // Or, for a herdr-core Claude or Codex pane whose argv names none, the one found by folder.
  const session = agent?.agentSession ?? agent?.coreFound;
  return session === undefined ? null : JSON.stringify([session.source, session.agent, session.kind, session.value]);
}

/** A read's rows' input (Load earlier is the chat's: not offered here). */
export function readInput(result: Omit<ChangesInput, "canLoadEarlier">): ChangesInput {
  return { ...result, canLoadEarlier: false };
}

/** A diff opened from the list, as the page shows it. */
export type ChangesDetailState =
  | { readonly kind: "loading" }
  | { readonly kind: "shown"; readonly document: DiffDocument }
  | { readonly kind: "message"; readonly text: string; readonly retry: boolean };

/** A diff read's answer as the detail shows it (the Swift detail view's messages). */
export function detailState(result: GitTextResult | { readonly kind: "text"; readonly text: GitText; readonly bound: number } | { readonly kind: "offline" }, bound: number): ChangesDetailState {
  switch (result.kind) {
    case "text":
      return { kind: "shown", document: documentFromGit(result.text, "bound" in result ? result.bound : bound) };
    case "notARepository":
      return { kind: "message", text: changesText.detailNotARepository, retry: false };
    case "noFolder":
      return { kind: "message", text: changesText.detailNoFolder, retry: false };
    case "runsAFilter":
      return { kind: "message", text: changesText.runsAFilter, retry: false };
    case "failed":
      return { kind: "message", text: changesText.failed, retry: true };
    case "timedOut":
      return { kind: "message", text: changesText.timedOut, retry: true };
    case "offline":
      return { kind: "message", text: changesText.offline, retry: false };
  }
}

/** A machine as the page has it: its panes' Herdr status. */
export interface WorkingHost {
  readonly id: string;
  readonly state: string;
  readonly topology: { readonly panes: readonly { readonly paneID: string; readonly agent?: string; readonly agentStatus?: string }[] } | null;
}

/** Each agent pane of the machines that answer, working or not, by "hostId|paneId". */
export function workingPanes(hosts: readonly WorkingHost[]): Record<string, boolean> {
  const working: Record<string, boolean> = {};
  for (const host of hosts) {
    if (host.state === "offline" || host.topology === null) continue;
    for (const pane of host.topology.panes) {
      if (pane.agent === undefined || pane.agent === "") continue;
      working[host.id + "|" + pane.paneID] = pane.agentStatus === "working";
    }
  }
  return working;
}
