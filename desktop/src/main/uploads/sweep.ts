// The 30-day cleanup of the app's uploads on a machine, by HerdrKit's
// UploadSweep.swift: once a day per machine account, after connecting, the
// uploads older than 30 days (modification time) are removed, then their
// folders when empty (or already empty and older than 30 days). Nothing else
// is touched: exactly the uploader's own names (attachments.ts), never
// through a symlink, never a symlink itself; right before each removal the
// folder and the file are checked again; any failure stops the walk quietly,
// with the reason, and a file or folder already gone is not one. An upload
// something on this device still names (`keep`) stays, and so its folder.

import { isOwnedUploadPath, isUploadFolder } from "../../shared/attachments";
import { UploadNotFoundError, type UploadEntry, type UploadSftp } from "./upload";

/** Uploads older than this go in the daily sweep. */
export const maximumAgeMs = 30 * 24 * 60 * 60 * 1_000;
/** At most one sweep per machine in this long. */
export const sweepIntervalMs = 24 * 60 * 60 * 1_000;

export interface UploadSweepResult {
  removedFiles: number;
  removedBytes: number;
  removedFolders: number;
  /** Uploads left because something on this device still names them. */
  keptFiles: number;
  /** Why it stopped early (nothing more was touched after it), or null. */
  stopped: string | null;
}

/** When each machine's sweep last started, on this device. */
export interface UploadSweepLog {
  lastSweep(machine: string): number | null;
  noteSweep(machine: string, atMs: number): void;
}

/** Whether a machine whose sweep last started at `last` is due one at `now`; a clock set back a day makes it due. */
export function isSweepDue(last: number | null, now: number): boolean {
  if (last === null) return true;
  const since = now - last;
  return since >= sweepIntervalMs || since <= -sweepIntervalMs;
}

class Changed extends Error {
  constructor(readonly path: string) {
    super(`${path} changed during the sweep`);
  }
}

interface Folder {
  readonly home: string;
  readonly name: string;
  readonly path: string;
  readonly modifiedMs: number | null;
}

/**
 * The daily sweep for `machine` (a key per machine account): null when one
 * started less than a day ago. The start is noted before anything is touched,
 * so one that stops early tries again the next day, not sooner.
 */
export async function runSweepIfDue(
  machine: string,
  sftp: UploadSftp,
  log: UploadSweepLog,
  now: number,
  keep: (path: string) => boolean = () => false,
): Promise<UploadSweepResult | null> {
  if (!isSweepDue(log.lastSweep(machine), now)) return null;
  log.noteSweep(machine, now);
  return sweepUploads(sftp, now, maximumAgeMs, keep);
}

/**
 * Removes the uploads older than `olderThanMs` at `now` (every one when null: Settings' Delete now, as the Swift
 * sweep's `olderThan: nil`), except those `keep` names (asked before the re-checks and again after them). A folder
 * goes only once it is emptied by this walk, or already empty and older than 30 days: never one an upload under way
 * may have just made.
 */
export async function sweepUploads(
  sftp: UploadSftp,
  now: number,
  olderThanMs: number | null,
  keep: (path: string) => boolean = () => false,
): Promise<UploadSweepResult> {
  const result: UploadSweepResult = { removedFiles: 0, removedBytes: 0, removedFolders: 0, keptFiles: 0, stopped: null };
  try {
    await walk(sftp, async (folder, entries) => {
      let left = 0;
      for (const entry of entries) {
        const path = `${folder.path}/${entry.name}`;
        if (entry.kind !== "file" || !isOwnedUploadPath(path, folder.home)) {
          left += 1;
          continue;
        }
        const due = olderThanMs === null || (entry.modifiedMs !== null && now - entry.modifiedMs > olderThanMs);
        if (!due || keep(path)) {
          if (due) result.keptFiles += 1;
          left += 1;
          continue;
        }
        try {
          await verify(folder, entry.name, sftp);
          // Asked again after the re-checks: a send that began naming it meanwhile keeps it.
          if (keep(path)) {
            result.keptFiles += 1;
            left += 1;
            continue;
          }
          await sftp.unlink(path);
          result.removedFiles += 1;
          result.removedBytes += entry.size ?? 0;
        } catch (error) {
          if (!(error instanceof UploadNotFoundError)) throw error;
        }
      }
      if (left > 0) return;
      const emptied = entries.length > 0;
      const longEmpty = folder.modifiedMs !== null && now - folder.modifiedMs > maximumAgeMs;
      if (!emptied && !longEmpty) return;
      try {
        await verify(folder, null, sftp);
        await sftp.rmdir(folder.path);
        result.removedFolders += 1;
      } catch (error) {
        if (!(error instanceof UploadNotFoundError)) throw error;
      }
    });
  } catch (error) {
    result.stopped = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/** The upload folders a count lists at once (each one REALPATH and one READDIR, asked together). */
export const inventoryLanes = 32;

/** A count stopped (a Delete now on the machine supersedes it). */
export class InventoryStoppedError extends Error {
  constructor() {
    super("the count was stopped");
  }
}

export interface InventoryOptions {
  /** Folders listed at once (default inventoryLanes). */
  readonly lanes?: number;
  /** What is counted so far, after each folder. */
  readonly progress?: (counted: { readonly files: number; readonly bytes: number }) => void;
  /** Stops it before its next request (InventoryStoppedError). */
  readonly signal?: AbortSignal;
  /**
   * The first failure, as it happens. The count itself settles only once every folder listing
   * under way has settled (no lane takes another folder after a failure), then fails with this same error.
   */
  readonly failed?: (error: unknown) => void;
}

/**
 * The app's uploads on the machine, counted, as UploadSweep.inventory (the files `sweepUploads` could
 * remove: the uploader's own names in its own folders, never through a symlink). Read only.
 *
 * Every upload is a folder of its own in the home, so walking them one by one would cost two waits for the machine
 * per upload, one after another (a few hundred uploads: tens of seconds over a home network). Instead: one listing
 * of the home, then the upload folders `lanes` at a time, each folder's REALPATH and READDIR asked together: a few
 * hundred uploads are about ten waits. The same rules as the sweep: the home's listing (lstat's kinds) names the
 * folders, a folder whose REALPATH is not itself is passed by (a symlink), one gone meanwhile is passed by, only the
 * uploader's own file names count, and any other failure fails the count. After a failure no lane takes another
 * folder, and the count fails (with the first error) once the listings under way have settled, so a count started
 * after it never runs beside it.
 */
export async function inventoryUploads(sftp: UploadSftp, options: InventoryOptions = {}): Promise<{ files: number; bytes: number }> {
  const { signal } = options;
  const stopped = (): void => {
    if (signal?.aborted === true) throw new InventoryStoppedError();
  };
  stopped();
  const home = await sftp.realpath(".");
  stopped();
  const folders = (await sftp.list(home))
    .filter((entry) => entry.kind === "directory")
    .map((entry) => `${home === "/" ? "" : home}/${entry.name}`)
    .filter((path) => isUploadFolder(path, home));
  const counted = { files: 0, bytes: 0 };
  let next = 0;
  // The first failure; after it no lane takes another folder.
  let failure: { readonly error: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (failure === null && next < folders.length) {
      stopped();
      const path = folders[next]!;
      next += 1;
      // Never through a symlink: the folder must still be itself (its listing is read only, and dropped if not).
      // Both requests settle before the lane goes on or stops; a folder gone meanwhile is passed by.
      const [real, listed] = await Promise.allSettled([sftp.realpath(path), sftp.list(path)]);
      const errors = [real, listed].flatMap((answer) => (answer.status === "rejected" ? [answer.reason as unknown] : []));
      if (errors.some((error) => error instanceof UploadNotFoundError)) continue;
      if (errors.length > 0) throw errors[0];
      if (real.status !== "fulfilled" || listed.status !== "fulfilled" || real.value !== path) continue;
      for (const entry of listed.value) {
        if (entry.kind !== "file" || entry.name.includes("/") || !isOwnedUploadPath(`${path}/${entry.name}`, home)) continue;
        counted.files += 1;
        counted.bytes += entry.size ?? 0;
      }
      options.progress?.({ files: counted.files, bytes: counted.bytes });
    }
  };
  const lanes = Math.max(1, Math.min(options.lanes ?? inventoryLanes, folders.length));
  await Promise.all(
    Array.from({ length: lanes }, () =>
      lane().catch((error: unknown) => {
        if (failure !== null) return;
        failure = { error };
        options.failed?.(error);
      }),
    ),
  );
  if (failure !== null) throw (failure as { readonly error: unknown }).error;
  stopped();
  return counted;
}

/**
 * Right before each removal: the folder is still a real folder in the home by
 * the home's listing and REALPATH gives its own path; for a file, it is still
 * a regular file in that folder by the folder's listing and REALPATH of its
 * path is itself. Anything else, gone included, stops the walk.
 */
async function verify(folder: Folder, name: string | null, sftp: UploadSftp): Promise<void> {
  const target = name === null ? folder.path : `${folder.path}/${name}`;
  try {
    const inHome = await sftp.list(folder.home);
    if (inHome.find((entry) => entry.name === folder.name)?.kind !== "directory" || (await sftp.realpath(folder.path)) !== folder.path) {
      throw new Changed(target);
    }
    if (name === null) return;
    const inFolder = await sftp.list(folder.path);
    if (inFolder.find((entry) => entry.name === name)?.kind !== "file" || (await sftp.realpath(target)) !== target) {
      throw new Changed(target);
    }
  } catch (error) {
    if (error instanceof UploadNotFoundError) throw new Changed(target);
    throw error;
  }
}

/** Each upload folder in the home, in name order, with its entries; one that went away meanwhile is passed by. */
async function walk(sftp: UploadSftp, visit: (folder: Folder, entries: UploadEntry[]) => Promise<void>): Promise<void> {
  const home = await sftp.realpath(".");
  const candidates = (await sftp.list(home)).filter((entry) => entry.kind === "directory").sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const candidate of candidates) {
    const path = `${home === "/" ? "" : home}/${candidate.name}`;
    if (!isUploadFolder(path, home)) continue;
    let entries: UploadEntry[];
    try {
      // Never through a symlink: the folder must still be itself.
      if ((await sftp.realpath(path)) !== path) continue;
      entries = (await sftp.list(path)).filter((entry) => entry.name !== "." && entry.name !== ".." && !entry.name.includes("/"));
    } catch (error) {
      if (error instanceof UploadNotFoundError) continue;
      throw error;
    }
    await visit({ home, name: candidate.name, path, modifiedMs: candidate.modifiedMs }, entries);
  }
}
