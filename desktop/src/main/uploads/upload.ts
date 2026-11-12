// One upload to a machine, by HerdrKit's RemoteAttachmentUploadOperation
// (CitadelTransport.swift): a new private folder in the SSH account's
// canonical home, an exclusively created partial file written and closed,
// renamed to its final name, and every step checked (REALPATH is itself, the
// folder 0700, the file a regular 0600 file of the size written). Anything
// that fails takes back what it made, as far as it can, and says why in the
// Swift app's words. It runs over whatever SFTP the caller holds (the
// machine's transcript connection in the app, a fake in the tests).
//
// As RemoteAttachmentUploadOperation.run in the Swift app:
// the same requests and checks, with fewer waits for the machine. The login
// folder is the link's (asked once per link, sftp.ts `canonicalHome`); requests whose
// order does not matter are asked together (the folder's REALPATH and STAT,
// the final file's REALPATH and STAT, the file's mode beside its writes, the
// close beside the rename); the mode is set and checked again only when the
// new folder did not come out 0700, and only after its real path matched.
// Every check still happens before what it guards. × on its chip stops it
// before its next request (`signal`), and what it made goes again.
// `removeUpload` takes one upload back (× on a chip already on the machine).

import {
  attachmentText,
  isOwnedUploadPath,
  isSafeAbsolutePath,
  maxUploadBytes,
  safeUploadExtension,
  uploadLayout,
  uploadNames,
} from "../../shared/attachments";

/** An entry of a folder listing (READDIR's attributes are lstat's: a symlink is "symlink"). */
export interface UploadEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly size: number | null;
  /** Modification time, ms since 1970, or null. */
  readonly modifiedMs: number | null;
}

export interface UploadStat {
  /** The full st_mode (type and permission bits). */
  readonly mode: number;
  readonly size: number;
}

/** The SFTP requests an upload and the sweep make; an explicit absence throws UploadNotFoundError. */
export interface UploadSftp {
  realpath(path: string): Promise<string>;
  /** The canonical home (REALPATH "."), asked once per link; absent: asked each time. */
  canonicalHome?(): Promise<string>;
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** STAT (follows a symlink, as the Swift uploader's path STAT does). */
  stat(path: string): Promise<UploadStat>;
  /** Creates `path` exclusively with `mode`, writes `data`, sets `mode` again and closes it; a stop sends no further write. */
  writeNew(path: string, data: Uint8Array, mode: number, signal?: AbortSignal): Promise<void>;
  /** `writeNew`, then the close and the rename to `to` asked together once every write is answered. */
  writeNewAs?(path: string, to: string, data: Uint8Array, mode: number, signal?: AbortSignal): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  list(path: string): Promise<UploadEntry[]>;
}

/** The machine said the path is not there (SFTP NO_SUCH_FILE). */
export class UploadNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`${path} is not there`);
  }
}

/** Why an upload did not finish, in words to show. */
export class AttachmentUploadError extends Error {}

export const uploadStoppedText = "The upload was stopped.";

/** × on its chip: the upload stopped before its next request. */
export class UploadStoppedError extends AttachmentUploadError {
  constructor() {
    super(uploadStoppedText);
  }
}

export interface UploadOptions {
  /** × on its chip: no request goes after this; what it made goes again. */
  readonly signal?: AbortSignal;
}

export interface RemoteAttachment {
  readonly path: string;
  readonly byteCount: number;
}

const typeMask = 0o170000;
const directoryType = 0o040000;
const regularType = 0o100000;

const isPrivateFolder = (mode: number): boolean => (mode & typeMask) === directoryType && (mode & 0o777) === 0o700;

/** The canonical home: the link's (asked once per link) where it keeps one. */
export function homeOf(sftp: UploadSftp): Promise<string> {
  return sftp.canonicalHome?.() ?? sftp.realpath(".");
}

/** The Swift uploader's steps, in order, on `sftp`. */
export async function uploadAttachment(
  sftp: UploadSftp,
  data: Uint8Array,
  fileExtension: string,
  randomUUID: () => string = () => crypto.randomUUID(),
  options: UploadOptions = {},
): Promise<RemoteAttachment> {
  if (data.byteLength > maxUploadBytes) throw new AttachmentUploadError(attachmentText.tooLarge);
  const extension = safeUploadExtension(fileExtension);
  if (extension === null) throw new AttachmentUploadError(attachmentText.unsupportedFormat);
  const stopped = (): void => {
    if (options.signal?.aborted === true) throw new UploadStoppedError();
  };
  stopped();
  const home = await homeOf(sftp);
  if (!isSafeAbsolutePath(home)) throw new AttachmentUploadError(attachmentText.unsafeRemoteHome);
  stopped();
  const layout = uploadLayout(home, uploadNames(randomUUID), extension);
  let madeFolder = false;
  let madePartial = false;
  let renamed = false;
  /** writeNewAs failed: the partial or the final name may be there. */
  let renameUnknown = false;
  try {
    await sftp.mkdir(layout.folder, 0o700);
    madeFolder = true;
    stopped();
    // Both read-only, so asked together; the mode is set (and checked again) only
    // when the folder did not come out 0700, and only after its real path matched.
    const [realFolder, created] = await Promise.all([sftp.realpath(layout.folder), sftp.stat(layout.folder)]);
    if (realFolder !== layout.folder) throw new AttachmentUploadError(attachmentText.privateDirectoryUnavailable);
    if (!isPrivateFolder(created.mode)) {
      await sftp.chmod(layout.folder, 0o700);
      const again = await sftp.stat(layout.folder);
      if (!isPrivateFolder(again.mode)) throw new AttachmentUploadError(attachmentText.privateDirectoryPermissions);
    }
    stopped();
    madePartial = true;
    if (sftp.writeNewAs !== undefined) {
      renameUnknown = true;
      await sftp.writeNewAs(layout.partial, layout.final, data, 0o600, options.signal);
      renameUnknown = false;
    } else {
      await sftp.writeNew(layout.partial, data, 0o600, options.signal);
      stopped();
      await sftp.rename(layout.partial, layout.final);
    }
    renamed = true;
    stopped();
    const [realFinal, file] = await Promise.all([sftp.realpath(layout.final), sftp.stat(layout.final)]);
    if (realFinal !== layout.final) throw new AttachmentUploadError(attachmentText.uploadedFileInvalid);
    if (file.size !== data.byteLength || (file.mode & typeMask) !== regularType || (file.mode & 0o777) !== 0o600) {
      throw new AttachmentUploadError(attachmentText.uploadedFileInvalid);
    }
    stopped();
    return { path: layout.final, byteCount: data.byteLength };
  } catch (error) {
    // What this upload made goes again; a step that fails here is passed by.
    const quietly = async (step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch {
        // already gone, or the link is down: nothing more to do here
      }
    };
    if ((madePartial && !renamed) || renameUnknown) await quietly(() => sftp.unlink(layout.partial));
    if (renamed || renameUnknown) await quietly(() => sftp.unlink(layout.final));
    if (madeFolder) await quietly(() => sftp.rmdir(layout.folder));
    if (error instanceof AttachmentUploadError) throw error;
    if (!madeFolder) throw new AttachmentUploadError(attachmentText.privateDirectoryUnavailable);
    throw new AttachmentUploadError(`The upload did not finish: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const notAnUploadText = "That file is not one of Adari's uploads on the machine.";
export const uploadChangedText = "The upload on the machine changed, so it was left there.";

/**
 * × on a chip already on the machine (HerdrKit's
 * removeRemoteAttachmentFiles, the sweep's checks): only exactly one of the
 * uploader's own files in its own folder under the canonical home; the folder
 * and the file checked together first (each still itself by REALPATH, a real
 * folder and a regular file: never through a symlink), then the file removed,
 * then its folder when empty. A file or folder already gone is not a failure.
 * The caller bounds the whole (one deadline).
 */
export async function removeUpload(sftp: UploadSftp, path: string): Promise<void> {
  const home = await homeOf(sftp);
  if (!isSafeAbsolutePath(home)) throw new AttachmentUploadError(attachmentText.unsafeRemoteHome);
  if (!isOwnedUploadPath(path, home)) throw new AttachmentUploadError(notAnUploadText);
  const folder = path.slice(0, path.lastIndexOf("/"));
  const [realFolder, folderStat, realFile, fileStat] = await Promise.allSettled([
    sftp.realpath(folder),
    sftp.stat(folder),
    sftp.realpath(path),
    sftp.stat(path),
  ]);
  const gone = (result: PromiseSettledResult<unknown>): boolean => result.status === "rejected" && result.reason instanceof UploadNotFoundError;
  const failed = [realFolder, folderStat, realFile, fileStat].find((result) => result.status === "rejected" && !gone(result));
  if (failed !== undefined && failed.status === "rejected") throw failed.reason;
  if (gone(realFolder) || gone(folderStat)) return;
  if (realFolder.status !== "fulfilled" || realFolder.value !== folder) throw new AttachmentUploadError(uploadChangedText);
  if (folderStat.status !== "fulfilled" || (folderStat.value.mode & typeMask) !== directoryType) throw new AttachmentUploadError(uploadChangedText);
  if (!gone(realFile) && !gone(fileStat)) {
    if (realFile.status !== "fulfilled" || realFile.value !== path) throw new AttachmentUploadError(uploadChangedText);
    if (fileStat.status !== "fulfilled" || (fileStat.value.mode & typeMask) !== regularType) throw new AttachmentUploadError(uploadChangedText);
    try {
      await sftp.unlink(path);
    } catch (error) {
      if (!(error instanceof UploadNotFoundError)) throw error;
    }
  }
  try {
    await sftp.rmdir(folder);
  } catch {
    // Not empty, or gone: the 30-day sweep's.
  }
}
