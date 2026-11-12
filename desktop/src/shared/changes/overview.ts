// A port of HerdrKit's AgentChangesOverview: the across-agents
// screen's rows for one Mac. Git once per folder (the first `limits.folders`
// folders) and the transcripts of the first `limits.folders` panes that have
// one, at most `limits.commandsAtOnce` at a time through the Mac's gate. A
// cancel (the signal) stops it: nothing starts after that, and it throws
// ChangesCancelled.

import { grokSessionFolder, type TranscriptFileReader } from "../chat/feed";
import { ChatFolderMatch, grokSessionOwned, type TranscriptSessionRef } from "../chat/locator";
import type { AgentChangesLimits, GitFolderRead, GitFolderStatus } from "./git";
import { ChangesCancelled, CommandGate, type AgentChangesGitReader } from "./reader";
import { readTranscriptEnd, toolChangesFromLines, transcriptFolder, type AgentToolChanges } from "./tools";

/** An agent pane the across-agents screen lists. */
export interface AgentChangesPane {
  readonly paneId: string;
  readonly name: string;
  readonly kind: string;
  readonly folder: string | null;
  /** The workspace's name, to group by. */
  readonly workspace: string;
  /** Which transcript is the pane's (none: Grok, an agent starting, a pane that names none). */
  readonly session: TranscriptSessionRef | null;
}

/** What reading a pane's transcript gave. */
export type AgentToolRead =
  | { readonly kind: "read"; readonly changes: AgentToolChanges }
  /** No transcript this app reads (Grok, no session named). */
  | { readonly kind: "noTranscript" }
  /** The file was not found, could not be read, or is another pane's. */
  | { readonly kind: "unreadable" }
  /** Past the panes read (`limits.folders`). */
  | { readonly kind: "notRead" };

/** One agent on the across-agents screen. */
export interface AgentOverviewRow {
  readonly pane: AgentChangesPane;
  /** Its folder's git (shared with the other panes in the folder); null when not read (no folder, no runner, past the folders read). */
  readonly git: GitFolderRead | null;
  readonly tools: AgentToolRead;
}

/** Files this session's own calls changed, when read. */
export const rowToolFileCount = (row: AgentOverviewRow): number | null => (row.tools.kind === "read" ? row.tools.changes.session.length : null);

export const rowGitStatus = (row: AgentOverviewRow): GitFolderStatus | null => (row.git?.kind === "repository" ? row.git.status : null);

/** Its folder holds changes, or its own calls changed files. */
export function rowHasChanges(row: AgentOverviewRow): boolean {
  const status = rowGitStatus(row);
  return (status !== null && status.files.length > 0) || (rowToolFileCount(row) ?? 0) > 0;
}

/** A workspace's agents on the across-agents screen. */
export interface AgentOverviewGroup {
  readonly workspace: string;
  readonly rows: readonly AgentOverviewRow[];
}

type Job = { readonly kind: "git"; readonly folder: string } | { readonly kind: "transcript"; readonly index: number; readonly ref: TranscriptSessionRef };

/** Every pane's row, in the order given. */
export async function collectOverview(options: {
  readonly panes: readonly AgentChangesPane[];
  readonly transcripts: TranscriptFileReader<TranscriptSessionRef> | null;
  readonly git: AgentChangesGitReader | null;
  readonly limits: AgentChangesLimits;
  readonly signal?: AbortSignal;
}): Promise<AgentOverviewRow[]> {
  const { panes, transcripts, git, limits, signal } = options;
  const check = (): void => {
    if (signal?.aborted === true) throw new ChangesCancelled();
  };
  check();
  const folders: string[] = [];
  for (const pane of panes) {
    if (pane.folder === null) continue;
    const folder = ChatFolderMatch.normalised(pane.folder);
    if (folder.length === 0 || folders.includes(folder)) continue;
    folders.push(folder);
  }
  const tools: AgentToolRead[] = panes.map(() => ({ kind: "noTranscript" }));
  const jobs: Job[] = [];
  if (git !== null) for (const folder of folders.slice(0, limits.folders)) jobs.push({ kind: "git", folder });
  let reads = 0;
  panes.forEach((pane, index) => {
    if (pane.session === null) return;
    if (transcripts === null) {
      tools[index] = { kind: "unreadable" };
    } else if (reads < limits.folders) {
      reads += 1;
      tools[index] = { kind: "notRead" };
      jobs.push({ kind: "transcript", index, ref: pane.session });
    } else {
      tools[index] = { kind: "notRead" };
    }
  });
  const gate = git?.gate ?? new CommandGate(limits.commandsAtOnce);
  const gitByFolder = new Map<string, GitFolderRead>();
  let next = 0;
  let stopped = false;
  // No more workers than the gate's window: a cancel stops what has not started.
  const worker = async (): Promise<void> => {
    while (!stopped) {
      check();
      const job = jobs[next];
      if (job === undefined) return;
      next += 1;
      try {
        if (job.kind === "git") {
          gitByFolder.set(job.folder, git === null ? { kind: "failed" } : await git.status(job.folder, signal));
        } else {
          const read = transcripts === null ? ({ kind: "unreadable" } as const) : await readToolsInGate(gate, job.ref, panes[job.index]!.folder, transcripts, limits, signal);
          tools[job.index] = read;
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limits.commandsAtOnce, jobs.length)) }, () => worker()));
  check();
  return panes.map((pane, index) => ({
    pane,
    git: pane.folder === null ? null : (gitByFolder.get(ChatFolderMatch.normalised(pane.folder)) ?? null),
    tools: tools[index]!,
  }));
}

/**
 * One pane's own changes from its transcript's end: located, read backwards
 * to its start or the bound, checked to be the pane's (its folder), and built
 * as the chat builds it. Throws only ChangesCancelled.
 */
export async function readTools(
  ref: TranscriptSessionRef,
  folder: string | null,
  reader: TranscriptFileReader<TranscriptSessionRef>,
  limits: AgentChangesLimits,
  signal?: AbortSignal,
): Promise<AgentToolRead> {
  const cancelled = (): boolean => signal?.aborted === true;
  try {
    if (cancelled()) throw new ChangesCancelled();
    const path = await reader.locate(ref);
    if (cancelled()) throw new ChangesCancelled();
    if (path === null) return { kind: "unreadable" };
    // A Grok session is the pane's only when its summary.json says so.
    if (ref.format === "grok" && !grokSessionOwned(await grokSessionFolder(reader, path), ref, folder === null ? [] : [folder])) return { kind: "unreadable" };
    if (cancelled()) throw new ChangesCancelled();
    const read = await readTranscriptEnd(reader, path, limits, signal);
    if (folder !== null && ChatFolderMatch.normalised(folder).length > 0) {
      const named = transcriptFolder(read.lines, ref.format);
      if (named !== null && !ChatFolderMatch.transcript(named, [folder])) return { kind: "unreadable" };
    }
    return { kind: "read", changes: toolChangesFromLines(read.lines, ref.format, folder, read.reachedStart) };
  } catch (error) {
    if (error instanceof ChangesCancelled || cancelled()) throw new ChangesCancelled();
    return { kind: "unreadable" };
  }
}

/**
 * `readTools` through the Mac's gate, within its deadline
 * (`limits.transcriptTimeoutMs`, 10 s): past it the pane's transcript reads as
 * unreadable and the permit is returned, whether or not the SFTP request ever
 * answers (git's commands have their own, `limits.timeoutMs`). A cancel returns
 * the permit at once too. Throws only ChangesCancelled.
 */
export function readToolsInGate(
  gate: CommandGate,
  ref: TranscriptSessionRef,
  folder: string | null,
  reader: TranscriptFileReader<TranscriptSessionRef>,
  limits: AgentChangesLimits,
  signal?: AbortSignal,
): Promise<AgentToolRead> {
  return gate.run(
    () =>
      new Promise<AgentToolRead>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new ChangesCancelled());
          return;
        }
        // Ends the read's own steps (it checks between them) when the deadline or the cancel comes first.
        const inner = new AbortController();
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onCancel);
        };
        const timer = setTimeout(() => {
          done();
          inner.abort();
          resolve({ kind: "unreadable" });
        }, Math.max(0, limits.transcriptTimeoutMs));
        const onCancel = (): void => {
          done();
          inner.abort();
          reject(new ChangesCancelled());
        };
        signal?.addEventListener("abort", onCancel, { once: true });
        readTools(ref, folder, reader, limits, inner.signal).then(
          (read) => {
            done();
            resolve(read);
          },
          (error: unknown) => {
            done();
            if (inner.signal.aborted && signal?.aborted !== true) resolve({ kind: "unreadable" });
            else reject(error);
          },
        );
      }),
    signal,
  );
}

/**
 * The rows by workspace, in their first pane's order; within each, the agents
 * with changes first (the order given otherwise), and the workspaces with
 * changes before the rest.
 */
export function groupedOverview(rows: readonly AgentOverviewRow[]): AgentOverviewGroup[] {
  const order: string[] = [];
  const byWorkspace = new Map<string, AgentOverviewRow[]>();
  for (const row of rows) {
    const list = byWorkspace.get(row.pane.workspace);
    if (list === undefined) {
      order.push(row.pane.workspace);
      byWorkspace.set(row.pane.workspace, [row]);
    } else list.push(row);
  }
  const groups = order.map((workspace): AgentOverviewGroup => {
    const list = byWorkspace.get(workspace) ?? [];
    return { workspace, rows: [...list.filter(rowHasChanges), ...list.filter((row) => !rowHasChanges(row))] };
  });
  const changed = (group: AgentOverviewGroup): boolean => group.rows.some(rowHasChanges);
  return [...groups.filter(changed), ...groups.filter((group) => !changed(group))];
}

/** The other open panes in the folder (by name, in order): "Also used by codex-review". The git part is theirs too. */
export function sharingPanes(paneId: string, folder: string | null, panes: readonly AgentChangesPane[]): string[] {
  if (folder === null) return [];
  const base = ChatFolderMatch.normalised(folder);
  if (base.length === 0) return [];
  return panes.filter((pane) => pane.paneId !== paneId && pane.folder !== null && ChatFolderMatch.normalised(pane.folder) === base).map((pane) => pane.name);
}
