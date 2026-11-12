// The start-commands save (start-commands-write.ts) over an
// ssh2 SFTP session: the machine's own (the transcript reader's connection),
// or This Mac's LocalSftp, which answers the same calls. The new file is made
// as an upload is (sftp.ts writeNew: "wx", the mode set on the handle, 32 KB
// writes, then close), and put in place with OpenSSH's posix-rename extension
// (plain SFTP RENAME refuses a name that is there).

import type { SFTPWrapper, Stats } from "ssh2";

import { readRange } from "./chat/ssh-reader";
import type { StartCommandsFileAccess, StartFileInfo } from "./start-commands-write";
import { ssh2UploadSftp } from "./uploads/sftp";

const noSuchFile = 2;
const typeMask = 0o170000;

function infoOf(stats: Pick<Stats, "mode" | "size">): StartFileInfo {
  const type = stats.mode & typeMask;
  return {
    kind: type === 0o100000 ? "file" : type === 0o040000 ? "directory" : type === 0o120000 ? "symlink" : "other",
    mode: stats.mode & 0o7777,
    size: Number.isFinite(stats.size) ? stats.size : 0,
  };
}

const absent = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === noSuchFile;

function call<T>(start: (done: (error: Error | undefined | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    start((error, value) => {
      if (error) reject(error);
      else resolve(value as T);
    });
  });
}

export function sftpStartCommandsFiles(sftp: SFTPWrapper): StartCommandsFileAccess {
  const uploads = ssh2UploadSftp(sftp);
  return {
    home: () => call<string>((done) => sftp.realpath(".", done)),
    lstat: (path) =>
      call<Stats>((done) => sftp.lstat(path, done)).then(infoOf, (error: unknown) => {
        if (absent(error)) return null;
        throw error;
      }),
    stat: (path) => call<Stats>((done) => sftp.stat(path, done)).then(infoOf),
    realpath: (path) => call<string>((done) => sftp.realpath(path, done)),
    read: (path, limit) => readRange(sftp, path, 0, limit),
    mkdir: (path, mode) => call<void>((done) => sftp.mkdir(path, { mode }, done)),
    writeNew: (path, data, mode) => uploads.writeNew(path, data, mode),
    replace: (from, to) => call<void>((done) => sftp.ext_openssh_rename(from, to, done)),
    remove: (path) => call<void>((done) => sftp.unlink(path, done)),
  };
}
