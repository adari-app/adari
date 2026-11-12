// The upload and sweep requests (upload.ts UploadSftp) on an ssh2 SFTP
// session: each one request, an explicit absence (SSH_FX_NO_SUCH_FILE) as
// UploadNotFoundError. A file is created with "wx" (O_CREAT|O_EXCL: never an
// existing file, never through a name someone made meanwhile) and written in
// 32 KB requests.
//
// As HerdrKit's held upload channel (CitadelTransport.swift
// uploadLink, AttachmentWritePermits): one adapter per SFTP session, so its
// link's state is shared by every upload on it: the login folder is asked
// once per link (`canonicalHome`), and the writes go in flight together, at most 12
// slices of 32 KB for all of that link's uploads (`WriteWindow`), with the
// file's mode beside them; once every write is answered, the close and the
// rename are asked together (`writeNewAs`).

import type { SFTPWrapper } from "ssh2";

import { isSafeAbsolutePath } from "../../shared/attachments";
import { UploadNotFoundError, UploadStoppedError, type UploadEntry, type UploadSftp, type UploadStat } from "./upload";

const noSuchFile = 2;
/** One SSH_FXP_WRITE. */
export const writeChunk = 32 * 1_024;
/** The writes a link keeps in flight, all its uploads together (RemoteAttachmentUploadOperation.writeWindow). */
export const writeWindow = 12;
const typeMask = 0o170000;

/** At most `size` writes in flight; the next waits for a permit (AttachmentWritePermits). */
export class WriteWindow {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly size: number = writeWindow) {
    this.free = size;
  }

  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) next();
    else this.free += 1;
  }

  /** Writes in flight now. */
  get inFlight(): number {
    return this.size - this.free;
  }
}

function absence(error: unknown, path: string): unknown {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === noSuchFile ? new UploadNotFoundError(path) : error;
}

function call<T>(path: string, start: (done: (error: Error | undefined | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    start((error, value) => {
      if (error) reject(absence(error, path));
      else resolve(value as T);
    });
  });
}

function kindOf(mode: number): UploadEntry["kind"] {
  switch (mode & typeMask) {
    case 0o100000:
      return "file";
    case 0o040000:
      return "directory";
    case 0o120000:
      return "symlink";
    default:
      return "other";
  }
}

/** One adapter per SFTP session: its home and its write window belong to the link. */
const adapters = new WeakMap<SFTPWrapper, UploadSftp>();

export function ssh2UploadSftp(sftp: SFTPWrapper): UploadSftp {
  const known = adapters.get(sftp);
  if (known !== undefined) return known;
  const adapter = makeAdapter(sftp);
  adapters.set(sftp, adapter);
  return adapter;
}

function makeAdapter(sftp: SFTPWrapper): UploadSftp {
  const window = new WriteWindow();
  let home: Promise<string> | null = null;
  const realpath = (path: string): Promise<string> => call<string>(path, (done) => sftp.realpath(path, done));
  const close = (path: string, handle: Buffer): Promise<void> => call<void>(path, (done) => sftp.close(handle, done));
  /**
   * Creates `path` exclusively, then writes `data` in slices with the file's
   * mode beside them, each slice as soon as the window has room. A stop
   * (`signal`) or a failed slice sends no further slice; those in flight are
   * answered (or fail with the link) before this settles. The handle is left
   * open for the caller to close.
   */
  const createAndWrite = async (path: string, data: Uint8Array, mode: number, signal?: AbortSignal): Promise<Buffer> => {
    const handle = await call<Buffer>(path, (done) => sftp.open(path, "wx", { mode }, done));
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let failure: unknown = null;
    const requests: Promise<void>[] = [
      call<void>(path, (done) => sftp.fchmod(handle, mode, done)).catch((error: unknown) => {
        failure ??= error;
      }),
    ];
    for (let offset = 0; offset < buffer.length; offset += writeChunk) {
      await window.acquire();
      if (failure === null && signal?.aborted === true) failure = new UploadStoppedError();
      if (failure !== null) {
        window.release();
        break;
      }
      const length = Math.min(writeChunk, buffer.length - offset);
      const at = offset;
      requests.push(
        call<void>(path, (done) => sftp.write(handle, buffer, at, length, at, done)).then(
          () => window.release(),
          (error: unknown) => {
            failure ??= error;
            window.release();
          },
        ),
      );
    }
    await Promise.all(requests);
    if (failure !== null) {
      await close(path, handle).catch(() => undefined);
      throw failure;
    }
    return handle;
  };
  return {
    realpath,
    canonicalHome: () => {
      // Asked once per link; a failed or unsafe answer is asked again next time.
      if (home === null) {
        const asked = realpath(".");
        home = asked;
        asked.then(
          (path) => {
            if (!isSafeAbsolutePath(path) && home === asked) home = null;
          },
          () => {
            if (home === asked) home = null;
          },
        );
      }
      return home;
    },
    mkdir: (path, mode) => call<void>(path, (done) => sftp.mkdir(path, { mode }, done)),
    chmod: (path, mode) => call<void>(path, (done) => sftp.chmod(path, mode, done)),
    stat: async (path) => {
      const stats = await call<{ mode: number; size: number }>(path, (done) => sftp.stat(path, done));
      return { mode: stats.mode, size: stats.size } satisfies UploadStat;
    },
    writeNew: async (path, data, mode, signal) => {
      const handle = await createAndWrite(path, data, mode, signal);
      await close(path, handle);
    },
    writeNewAs: async (path, to, data, mode, signal) => {
      const handle = await createAndWrite(path, data, mode, signal);
      // Every write is answered: the file is whole. Its close and its rename are independent of each other.
      const [closed, renamed] = await Promise.allSettled([close(path, handle), call<void>(path, (done) => sftp.rename(path, to, done))]);
      if (renamed.status === "rejected") throw renamed.reason;
      if (closed.status === "rejected") throw closed.reason;
    },
    rename: (from, to) => call<void>(from, (done) => sftp.rename(from, to, done)),
    unlink: (path) => call<void>(path, (done) => sftp.unlink(path, done)),
    rmdir: (path) => call<void>(path, (done) => sftp.rmdir(path, done)),
    list: async (path) => {
      const list = await call<{ filename: string; attrs: { mode: number; size: number; mtime: number } }[]>(path, (done) =>
        sftp.readdir(path, done),
      );
      return list.map((entry) => ({
        name: entry.filename,
        kind: kindOf(entry.attrs.mode),
        size: Number.isFinite(entry.attrs.size) ? entry.attrs.size : null,
        modifiedMs: Number.isFinite(entry.attrs.mtime) ? entry.attrs.mtime * 1_000 : null,
      }));
    },
  };
}
