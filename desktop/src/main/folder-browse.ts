// One folder on a machine, listed for New workspace's and New
// agent's folder field (T3 Code's `filesystem.browse`, apps/server/src/
// workspace/WorkspaceEntries.ts:208: the folder typed, its folders only,
// sorted). Read only and never recursive: one stat of the folder, one listing
// of at most `maxReadEntries` entries, and a stat of at most
// `maxLinksFollowed` links in it to see which are folders (a link to a folder
// is one the user can start in). It runs over the machine's existing connection:
// the transcript reader's SFTP session for a saved machine, This Mac's
// LocalSftp (herdr/local.ts) for This Mac, a fake tree for the demo. Nothing
// is written, made or removed.

import path from "node:path";

import type { SFTPWrapper, Stats } from "ssh2";

import { maxLinksFollowed, maxReadEntries, sortFolderNames, type FolderListing } from "../shared/folder-browse";

/** One entry of a folder as the listing gives it (a link is itself, as SFTP's READDIR has it). */
export interface FolderEntry {
  readonly name: string;
  readonly kind: "folder" | "link" | "other";
}

/** What listing a folder needs of a machine. Errors carry SFTP's status on `code` (2: no such file, 3: permission denied). */
export interface FolderReader {
  /** The login (home) folder. */
  home(): Promise<string>;
  /** What `target` is, links followed: null when nothing is there. */
  kind(target: string): Promise<"folder" | "other" | null>;
  /** The entries directly in `folder`, at most `limit` (`truncated`: it holds more). */
  list(folder: string, limit: number): Promise<{ readonly entries: readonly FolderEntry[]; readonly truncated: boolean }>;
}

/** How long one listing may take, connecting included. */
export const folderBrowseTimeoutMs = 8_000;

const status = { eof: 1, noSuchFile: 2, permissionDenied: 3 } as const;
const codeOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);
const reasonOf = (error: unknown): string => {
  if (codeOf(error) === status.permissionDenied) return "permission denied";
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() === "" ? "it did not say why" : text.trim().slice(0, 160);
};

/**
 * The folder `directory` names on the machine (as typed, ending in "/"; "~/" is the machine's home), resolved, with
 * its folders. A folder that is not there, a file, or one the machine will not read is said so, never thrown.
 */
export async function browseFolder(reader: FolderReader, directory: string): Promise<FolderListing> {
  const rest = directory.startsWith("~/") ? directory.slice(2) : null;
  let folder: string;
  try {
    folder = rest === null ? path.posix.normalize(directory) : path.posix.join(await reader.home(), rest);
  } catch (error) {
    return { type: "unreadable", folder: directory, reason: reasonOf(error) };
  }
  if (folder.length > 1 && folder.endsWith("/")) folder = folder.slice(0, -1);
  let kind: "folder" | "other" | null;
  try {
    kind = await reader.kind(folder);
  } catch (error) {
    return { type: "unreadable", folder, reason: reasonOf(error) };
  }
  if (kind === null) return { type: "missing", folder };
  if (kind !== "folder") return { type: "not-folder", folder };
  let listed: Awaited<ReturnType<FolderReader["list"]>>;
  try {
    listed = await reader.list(folder, maxReadEntries);
  } catch (error) {
    if (codeOf(error) === status.noSuchFile) return { type: "missing", folder };
    return { type: "unreadable", folder, reason: reasonOf(error) };
  }
  const usable = (name: string): boolean => name !== "" && name !== "." && name !== ".." && !name.includes("/");
  const names = listed.entries.filter((entry) => entry.kind === "folder" && usable(entry.name)).map((entry) => entry.name);
  const links = listed.entries.filter((entry) => entry.kind === "link" && usable(entry.name)).slice(0, maxLinksFollowed);
  const linked = await Promise.all(
    links.map((entry) =>
      reader.kind(path.posix.join(folder, entry.name)).then(
        (target) => (target === "folder" ? entry.name : null),
        () => null,
      ),
    ),
  );
  for (const name of linked) if (name !== null) names.push(name);
  return { type: "listed", folder, names: sortFolderNames(names), truncated: listed.truncated };
}

const typeMask = 0o170000;
const kindOfMode = (mode: number): FolderEntry["kind"] => ((mode & typeMask) === 0o040000 ? "folder" : (mode & typeMask) === 0o120000 ? "link" : "other");

type DirectoryEntry = { readonly filename: string; readonly attrs: Pick<Stats, "mode"> };
/** The calls the reader makes: ssh2's SFTPWrapper has them all; This Mac's LocalSftp has every one but the handle-based listing. */
type FolderSftp = Pick<SFTPWrapper, "realpath" | "stat"> & {
  readdir(where: string | Buffer, done: (error: Error | undefined, list: DirectoryEntry[]) => void): void;
  opendir?(target: string, done: (error: Error | undefined, handle: Buffer) => void): void;
  close?(handle: Buffer, done: (error?: Error | null) => void): void;
};

function call<T>(start: (done: (error: Error | undefined | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    start((error, value) => {
      if (error) reject(error);
      else resolve(value as T);
    });
  });
}

/**
 * A folder reader over an SFTP session (ssh2's, or This Mac's LocalSftp). On ssh2 the folder is read a batch at a
 * time and the read stops at `limit` entries (the handle closed); LocalSftp lists the folder in one call, cut to the
 * same limit.
 */
export function sftpFolderReader(sftp: FolderSftp): FolderReader {
  const entryOf = (entry: DirectoryEntry): FolderEntry => ({ name: entry.filename, kind: kindOfMode(entry.attrs.mode) });
  return {
    home: () => call<string>((done) => sftp.realpath(".", done)),
    kind: (target) =>
      call<Pick<Stats, "mode">>((done) => sftp.stat(target, done)).then(
        (stats) => (kindOfMode(stats.mode) === "folder" ? "folder" : "other"),
        (error: unknown) => {
          if (codeOf(error) === status.noSuchFile) return null;
          throw error;
        },
      ),
    list: async (folder, limit) => {
      const { opendir, close } = sftp;
      if (opendir === undefined || close === undefined) {
        const all = await call<DirectoryEntry[]>((done) => sftp.readdir(folder, done));
        return { entries: all.slice(0, limit).map(entryOf), truncated: all.length > limit };
      }
      const handle = await call<Buffer>((done) => opendir.call(sftp, folder, done));
      const entries: FolderEntry[] = [];
      try {
        for (;;) {
          let batch: DirectoryEntry[];
          try {
            batch = await call<DirectoryEntry[]>((done) => sftp.readdir(handle, done));
          } catch (error) {
            if (codeOf(error) === status.eof) return { entries, truncated: false };
            throw error;
          }
          if (!Array.isArray(batch)) return { entries, truncated: false };
          for (const entry of batch) {
            if (entry.filename === "." || entry.filename === "..") continue;
            if (entries.length === limit) return { entries, truncated: true };
            entries.push(entryOf(entry));
          }
        }
      } finally {
        await call<void>((done) => close.call(sftp, handle, done)).catch(() => undefined);
      }
    },
  };
}

/** A machine that can list a folder for the folder field. */
export interface FolderBrowsing {
  browseFolder?(directory: string): Promise<FolderListing>;
}
