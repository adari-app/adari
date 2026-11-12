// Reads an SSH machine's agent transcripts for Chat, read only: one `/bin/sh`
// exec (the locator's command, src/shared/chat/locator.ts) finds the file, then
// SFTP gives its size and bounded reads from a byte offset (the follower's
// requests, src/shared/chat/follower.ts). Its own connection, opened on first
// use, so a slow read never holds up the command connection or a terminal;
// a failure or a missed deadline drops it and the next call reconnects. Each
// call's deadline starts before connecting and the SFTP setup; the client is
// kept as soon as it exists, so a deadline, close or a dropped connection ends
// it, also when its setup finishes late. An SFTP setup that throws fails the
// call at once.

import type { Client, ClientChannel, SFTPWrapper } from "ssh2";

import { type CursorContext, type TranscriptStoreReading } from "../../shared/chat/cursor-store";
import { isStorePath, StoreViews } from "../../shared/chat/stores"; // every store format's view (the registry)
import {
  TranscriptNotFoundError,
  type TranscriptFileReader,
  type TranscriptIdentityRead,
  type TranscriptIdentityReading,
  type TranscriptReadOptions,
  type TranscriptWatch,
  type TranscriptWatchSink,
  type TranscriptWatching,
} from "../../shared/chat/feed";
import { omitBytes, rebuildOmitted, relayFrameBytes, relayGrowthBytes } from "../../shared/chat/blobs";
import {
  CancelledError,
  OutputCollector,
  type RemoteCommand,
  type RemoteCommandOutput,
  type RemoteCommandRunner,
} from "../../shared/remote-command";
import { locateCommand, parseLocateOutput, type TranscriptSessionRef } from "../../shared/chat/locator";
import { maxListedNames, type TranscriptFolderListing } from "../../shared/chat/subagent-steps";
import type { ReadOnlyCommandRunner } from "../../shared/changes/reader";
import type { PinningHostKeyPolicy } from "../herdr/host-key-pinning";
import { connectSsh, type SshHostConfig } from "../herdr/ssh";
import { RelayRefusedError, RelayReplyError, relayReadChunkBytes, type RelayClient, type RelayRead } from "../herdr/relay";

/** The locate command prints one path: more than this is not a path. */
export const maxLocateOutputBytes = 64 * 1_024;
/** No single read asks for more than this (the follower's largest is 8 MB plus a line). */
export const maxReadBytes = 16 * 1_024 * 1_024;
export const defaultOperationTimeoutMs = 20_000;
/** SFTP's "no such file" status (SSH_FX_NO_SUCH_FILE). */
const noSuchFile = 2;

interface Link {
  readonly client: Client;
  readonly sftp: SFTPWrapper;
}

/** One connection being set up or in use. */
interface Attempt {
  readonly link: Promise<Link>;
  /** Fails the setup if it has not finished and ends the client, now or when it arrives. */
  abort(reason: Error): void;
}

export interface SshTranscriptReaderOptions {
  readonly timeoutMs?: number;
  /** Opens the SSH client (a seam for the tests; the app uses connectSsh). */
  readonly connect?: (config: SshHostConfig, policy: PinningHostKeyPolicy) => Promise<Client>;
  /**
   * The command connection's relay while it is up (never opening one): sizes and reads are
   * one relay `read` each (1 trip; SFTP's stat, open, read and close are about 4), and Chat's watch rides it.
   * Absent or null: SFTP.
   */
  readonly relay?: () => Promise<RelayClient | null>;
}

class OperationTimedOut extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${Math.round(ms / 1000)} seconds`);
  }
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === noSuchFile;

/** The most one relay `read` frame returns (docs/relay.md). */
const relayReadMaxBytes = relayFrameBytes;

/** A relay refusal that SFTP may still answer (a path the relay will not read, a frame it would not take). */
const sftpMayAnswer = (error: unknown): boolean => error instanceof RelayRefusedError && error.code !== "io";

export class SshTranscriptReader
  implements
    TranscriptFileReader<TranscriptSessionRef>,
    TranscriptFolderListing,
    ReadOnlyCommandRunner,
    RemoteCommandRunner,
    TranscriptStoreReading,
    TranscriptWatching,
    TranscriptIdentityReading
{
  private attempt: Attempt | null = null;
  /**
   * Sessions kept in a store (Cursor, OpenCode and the other store formats) read as JSONL views (shared/chat/stores.ts),
   * each made on first use: their queries are read-only sqlite3 execs, their stamps SFTP stats, a document's read this reader's own.
   */
  private readonly stores = new StoreViews((entry) => ({
    query: (command, maxOutputBytes) => this.withLink(entry.activity, (link) => execBounded(link.client, command, maxOutputBytes)),
    stamp: (path) => this.fileStamp(path),
    notFound: (path) => new TranscriptNotFoundError(path),
    readFile: (path, offset, maxBytes) => this.fileRead(path, Math.max(0, Math.floor(offset)), Math.max(0, Math.min(Math.floor(maxBytes), maxReadBytes))),
  }));
  private closed = false;
  private readonly timeoutMs: number;
  private readonly connect: (config: SshHostConfig, policy: PinningHostKeyPolicy) => Promise<Client>;
  /** The relay, when this machine's command connection starts one (null: SFTP only). */
  private readonly relay: (() => Promise<RelayClient | null>) | null;
  /**
   * Relay contract v1.2: reads and watches ask the relay to leave base64 runs out (`omit`) and a
   * cold open reads its tail (`tail`). False once a relay refused `omit` or answered without `omitted` (an older
   * relay, which ignores fields it does not know): from then on it reads without them.
   */
  private omits = true;

  constructor(
    private readonly config: SshHostConfig,
    private readonly policy: PinningHostKeyPolicy,
    options: SshTranscriptReaderOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? defaultOperationTimeoutMs;
    this.connect = options.connect ?? ((config, policy) => connectSsh(config, policy));
    const relay = options.relay;
    this.relay = relay === undefined ? null : () => relay().catch(() => null);
  }

  /** `work` on the relay while it is up; null when it is not (or refused what SFTP may still answer). */
  private async onRelay<T>(work: (relay: RelayClient) => Promise<T>): Promise<{ value: T } | null> {
    if (this.closed || this.relay === null) return null;
    const relay = await this.relay();
    if (relay === null) return null;
    try {
      return { value: await work(relay) };
    } catch (error) {
      if (sftpMayAnswer(error)) return null;
      throw error;
    }
  }

  /** Up to `length` bytes from `offset` in relay reads written at once (one trip), in order up to a short one. */
  private async relayRange(relay: RelayClient, path: string, offset: number, length: number): Promise<Uint8Array> {
    const asks: { at: number; length: number }[] = [];
    for (let at = 0; at < length; at += relayReadChunkBytes) asks.push({ at, length: Math.min(relayReadChunkBytes, length - at) });
    const answers = await Promise.all(asks.map((ask) => relay.read(path, offset + ask.at, ask.length, this.timeoutMs)));
    const parts: Uint8Array[] = [];
    for (const [index, answer] of answers.entries()) {
      if (answer === null) throw new TranscriptNotFoundError(path);
      parts.push(answer.data);
      // The end of the file (or what was asked after it no longer lines up: the next read asks from there).
      if (answer.data.length < asks[index]!.length) break;
    }
    return parts.length === 1 ? parts[0]! : new Uint8Array(Buffer.concat(parts));
  }

  /**
   * The file's growth from `offset`, pushed by the relay (grew, reset, gone); null while
   * the relay is not up (the feed polls instead). Cursor's store views are never watched.
   */
  async watch(path: string, offset: number, sink: TranscriptWatchSink): Promise<TranscriptWatch | null> {
    if (this.closed || this.relay === null || isStorePath(path)) return null;
    const relay = await this.relay();
    if (relay === null || !relay.up) return null;
    // Client rule 7 (docs/relay.md): each `grew` is judged on its own bytes; rebuilt as a read is. The relay
    // client took only a `grew` that fits its watch; the rebuild is held to a
    // frame's 256 KB again before it allocates, and one that does not fit ends the watch (the feed reads instead).
    const omit = this.omits;
    const handle = relay.watch(
      path,
      offset,
      {
        grew: (at, size, data, omitted) => {
          if (omitted === undefined) {
            if (omit) this.omits = false;
            sink.grew(at, size, data);
            return;
          }
          const bytes = rebuildOmitted(at, data, omitted, relayGrowthBytes);
          if (bytes === null) {
            handle.close();
            sink.ended();
            return;
          }
          if (omitted.length === 0) sink.grew(at, size, bytes);
          else sink.grew(at, size, bytes, omitted);
        },
        reset: () => sink.reset(),
        gone: () => sink.gone(),
        ended: () => sink.ended(),
        refused: (code) => {
          if (omit && code === "bad_frame") this.omits = false;
        },
      },
      omit ? omitBytes : undefined,
    );
    return { close: () => handle.close() };
  }

  /**
   * One relay `read` frame: the file's size and inode and up to `maxBytes` from
   * `offset` (at most the relay's 4 MiB); null while the relay is not up (the feed asks the size and reads
   * over SFTP) or for a Cursor store's view. TranscriptNotFoundError when the file is gone.
   */
  async readWithIdentity(path: string, offset: number, maxBytes: number, options: TranscriptReadOptions = {}): Promise<TranscriptIdentityRead | null> {
    if (isStorePath(path) || this.relay === null) return null;
    const max = Math.max(0, Math.min(Math.floor(maxBytes), relayReadMaxBytes));
    const from = Math.max(0, Math.floor(offset));
    const tail = options.tail === undefined ? undefined : Math.max(0, Math.min(Math.floor(options.tail), relayReadMaxBytes));
    const relayed = await this.onRelay(async (relay) => {
      // Relay v1.2, client rules 1 and 2: base64 runs left out, the bytes rebuilt in file offsets.
      if (options.omit === true && this.omits) {
        const omitted = await this.omitRead(relay, path, from, max, tail);
        if (omitted !== undefined) return omitted;
      }
      if (tail !== undefined) {
        // A plain tail read: the size, then the read from where the tail starts.
        const sized = await relay.read(path, 0, 0, this.timeoutMs);
        if (sized === null) throw new TranscriptNotFoundError(path);
        return this.tailFrom(relay, path, sized.size, tail);
      }
      const answer = await relay.read(path, from, max, this.timeoutMs);
      if (answer === null) throw new TranscriptNotFoundError(path);
      return { size: answer.size, ino: answer.ino, data: answer.data };
    });
    return relayed === null ? null : relayed.value;
  }

  /**
   * One `read` with `omit` (and `tail`): its kept bytes rebuilt into the file's (blobs.ts), the
   * runs listed; undefined when the relay refused the fields (bad_frame), answered a `tail` read with no offset,
   * or answered as an older relay does (no `omitted`) and nothing of it can stand: it reads without them from now
   * on. Any other reply it cannot describe is a failed read.
   */
  private async omitRead(relay: RelayClient, path: string, from: number, max: number, tail: number | undefined): Promise<TranscriptIdentityRead | undefined> {
    let answer: RelayRead | null;
    try {
      answer = await relay.read(path, from, tail ?? max, this.timeoutMs, { omit: omitBytes, ...(tail === undefined ? {} : { tail }) });
    } catch (error) {
      // Only a refused frame or a `tail` reply with no offset; any other reply it cannot describe
      // (no size, `omitted` not ranges) is a failed read, omit kept on.
      const refused = error instanceof RelayRefusedError && error.code === "bad_frame";
      const undescribed = tail !== undefined && error instanceof RelayReplyError && error.noOffset;
      if (!refused && !undescribed) throw error;
      this.omits = false;
      return undefined;
    }
    if (answer === null) throw new TranscriptNotFoundError(path);
    if (answer.omitted === undefined) {
      // An older relay: it ignored `omit` (its bytes are a plain read's) and `tail` (it read from the file's start).
      this.omits = false;
      if (tail === undefined) return { size: answer.size, ino: answer.ino, data: answer.data };
      return this.tailFrom(relay, path, answer.size, tail);
    }
    // Held to what was asked (the relay client checked it too) before it allocates.
    const data = rebuildOmitted(answer.offset, answer.data, answer.omitted, tail ?? max);
    if (data === null) throw new RelayReplyError("the relay sent a read it could not describe");
    return { size: answer.size, ino: answer.ino, data, offset: answer.offset, ...(answer.omitted.length === 0 ? {} : { omitted: answer.omitted }) };
  }

  /** A plain read of the last `tail` bytes of a file of `size` (said with its start). */
  private async tailFrom(relay: RelayClient, path: string, size: number, tail: number): Promise<TranscriptIdentityRead> {
    const start = Math.max(0, size - tail);
    const answer = await relay.read(path, start, tail, this.timeoutMs);
    if (answer === null) throw new TranscriptNotFoundError(path);
    return { size: answer.size, ino: answer.ino, data: answer.data, offset: start };
  }

  /** The current connection, or a new one being set up. */
  private linked(): Attempt {
    if (this.attempt !== null) return this.attempt;
    let client: Client | null = null;
    let aborted = false;
    let fail: (reason: Error) => void = () => undefined;
    const link = new Promise<Link>((resolve, reject) => {
      fail = reject;
      const gone = (): void => reject(new Error("the transcript connection closed"));
      this.connect(this.config, this.policy).then((connected) => {
        if (aborted) {
          connected.end();
          return;
        }
        client = connected;
        connected.on("error", (error: Error) => reject(error));
        connected.once("close", gone);
        connected.once("end", gone);
        try {
          connected.sftp((error, wrapper) => {
            if (aborted) return;
            if (error) {
              connected.end();
              reject(error);
              return;
            }
            resolve({ client: connected, sftp: wrapper });
          });
        } catch (error) {
          // ssh2 throws "Not connected" when the socket is already gone: the
          // setup fails now, with that error, and the abort below ends the
          // client.
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, reject);
    });
    const attempt: Attempt = {
      link,
      abort: (reason) => {
        if (this.attempt === attempt) this.attempt = null;
        if (aborted) return;
        aborted = true;
        fail(reason);
        client?.end();
      },
    };
    // A failed setup, or the connection closing later, drops it: the next call reconnects.
    link.then(
      ({ client: connected }) => {
        const drop = (): void => {
          if (this.attempt === attempt) this.attempt = null;
        };
        connected.once("close", drop);
        connected.once("end", drop);
        connected.once("error", drop);
      },
      () => attempt.abort(new Error("the transcript connection failed")),
    );
    this.attempt = attempt;
    return attempt;
  }

  /** Runs `work` on the link under the deadline, which covers connecting too; a miss drops the connection. */
  private async withLink<T>(what: string, work: (link: Link) => Promise<T>, timeoutMs: number = this.timeoutMs): Promise<T> {
    if (this.closed) throw new Error("the transcript reader is closed");
    const attempt = this.linked();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const missed = new OperationTimedOut(what, timeoutMs);
        attempt.abort(missed);
        reject(missed);
      }, timeoutMs);
    });
    try {
      return await Promise.race([attempt.link.then(work), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async locate(ref: TranscriptSessionRef): Promise<string | null> {
    if (ref.lookup.kind === "path") {
      const path = ref.lookup.path;
      try {
        await this.size(path);
        return path;
      } catch (error) {
        if (error instanceof TranscriptNotFoundError) return null;
        throw error;
      }
    }
    const command = locateCommand(ref);
    if (command === null) return null;
    const output = await this.withLink("Finding the transcript", (link) => execOutput(link.client, command));
    return parseLocateOutput(output, ref);
  }

  /** A regular file's size and modification time as one string, or null when it is not there. */
  private fileStamp(path: string): Promise<string | null> {
    return this.withLink(
      "Reading the Cursor chat's size",
      (link) =>
        new Promise<string | null>((resolve, reject) => {
          link.sftp.stat(path, (error, stats) => {
            if (error) {
              if (isNotFound(error)) resolve(null);
              else reject(error);
            } else if (!stats.isFile()) resolve(null);
            else resolve(`${stats.size}:${stats.mtime}`);
          });
        }),
    );
  }

  storeRevision(path: string): Promise<number> {
    return this.stores.of(path)?.storeRevision(path) ?? Promise.resolve(0);
  }

  storeContext(path: string): Promise<CursorContext | null> {
    return this.stores.of(path)?.storeContext(path) ?? Promise.resolve(null);
  }

  size(path: string): Promise<number> {
    const store = this.stores.of(path);
    if (store !== null) return store.size(path);
    // One relay read (its size) while the relay is up; SFTP's stat otherwise (relay off: at once).
    if (this.relay !== null) {
      return this.onRelay(async (relay) => {
        const answer = await relay.read(path, 0, 0, this.timeoutMs);
        if (answer === null) throw new TranscriptNotFoundError(path);
        return answer.size;
      }).then((relayed) => (relayed !== null ? relayed.value : this.sftpSize(path)));
    }
    return this.sftpSize(path);
  }

  private sftpSize(path: string): Promise<number> {
    return this.withLink(
      "Reading the transcript's size",
      (link) =>
        new Promise<number>((resolve, reject) => {
          link.sftp.stat(path, (error, stats) => {
            if (error) reject(isNotFound(error) ? new TranscriptNotFoundError(path) : error);
            else resolve(stats.size);
          });
        }),
    );
  }

  /**
   * The names directly inside `folder` (a session's subagents folder), read only
   * (one SFTP readdir, at most `maxListedNames`); TranscriptNotFoundError when it is missing.
   */
  list(folder: string): Promise<readonly string[]> {
    return this.withLink(
      "Listing the subagents' transcripts",
      (link) =>
        new Promise<readonly string[]>((resolve, reject) => {
          link.sftp.readdir(folder, (error, entries) => {
            if (error) reject(isNotFound(error) ? new TranscriptNotFoundError(folder) : error);
            else resolve(entries.slice(0, maxListedNames).map((entry) => entry.filename).filter((name) => name !== "." && name !== ".." && !name.includes("/")));
          });
        }),
    );
  }

  /** The login folder (SFTP's realpath of "."), or null when it does not answer. */
  home(): Promise<string | null> {
    return this.realpath(".");
  }

  /** Where `path` really is (symlinks followed), or null when it is missing or does not resolve. */
  realpath(path: string): Promise<string | null> {
    return this.withLink(
      "Checking a settings file",
      (link) =>
        new Promise<string | null>((resolve) => {
          link.sftp.realpath(path, (error, real) => resolve(error || typeof real !== "string" ? null : real));
        }),
    ).catch(() => null);
  }

  read(path: string, offset: number, maxBytes: number): Promise<Uint8Array> {
    const length = Math.max(0, Math.min(Math.floor(maxBytes), maxReadBytes));
    if (length === 0) return Promise.resolve(new Uint8Array(0));
    const from = Math.max(0, Math.floor(offset));
    const store = this.stores.of(path);
    if (store !== null) return store.read(path, from, length);
    return this.fileRead(path, from, length);
  }

  /** A file's bytes from `from`, at most `length` (SFTP, or relay reads while the relay is up); a Cline document's whole read too. */
  private fileRead(path: string, from: number, length: number): Promise<Uint8Array> {
    if (length === 0) return Promise.resolve(new Uint8Array(0));
    const sftp = (): Promise<Uint8Array> => this.withLink("Reading the transcript", (link) => readRange(link.sftp, path, from, length));
    // Relay reads (one trip) while the relay is up; SFTP otherwise.
    if (this.relay === null) return sftp();
    return this.onRelay((relay) => this.relayRange(relay, path, from, length)).then((relayed) => (relayed !== null ? relayed.value : sftp()));
  }

  /**
   * Runs `work` on this connection's SFTP session (an upload, the upload
   * sweep: src/main/uploads), under its own deadline, which covers connecting.
   */
  withSftp<T>(what: string, work: (sftp: SFTPWrapper) => Promise<T>, timeoutMs: number): Promise<T> {
    return this.withLink(what, (link) => work(link.sftp), timeoutMs);
  }

  /**
   * A small file read only (the Mac's agents.json): at most `limit` bytes, null
   * when there is none. Nothing is written, made or removed.
   */
  readSmallFile(path: string, limit: number): Promise<Uint8Array | null> {
    return this.withLink("Reading the start commands", async (link) => {
      try {
        return await readRange(link.sftp, path, 0, limit);
      } catch (error) {
        if (error instanceof TranscriptNotFoundError) return null;
        throw error;
      }
    });
  }

  /**
   * As the Swift transport's runReadOnlyCommand: one read-only
   * command (Changes' git, shared/changes/git.ts) on this connection, its
   * stdout up to `maxOutputBytes`, stderr ignored. The signal ends it: the
   * channel is closed and the call rejects. The operation deadline still
   * bounds it.
   *
   * The wait for the link (SSH connecting, SFTP opening)
   * ends at once when the signal fires, and right before the exec the signal
   * and the deadline are checked again: a command cancelled or timed out
   * while the link was being made is never sent. Changes' gate releases its
   * permit after the signal has fired (shared/changes/reader.ts), so once it
   * does, this command can no longer start.
   */
  runReadOnlyCommand(command: string, maxOutputBytes: number, signal?: AbortSignal): Promise<string> {
    const cancelled = (): Error => new Error("the command was cancelled");
    if (signal?.aborted === true) return Promise.reject(cancelled());
    const what = "Running git";
    const deadline = Date.now() + this.timeoutMs;
    let ended = false;
    const running = this.withLink(what, (link) => {
      if (ended || signal?.aborted === true) return Promise.reject(cancelled());
      if (Date.now() >= deadline) return Promise.reject(new OperationTimedOut(what, this.timeoutMs));
      return execBounded(link.client, command, maxOutputBytes, signal);
    });
    if (signal === undefined) return running;
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        ended = true;
        reject(cancelled());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      running.then(
        (text) => {
          signal.removeEventListener("abort", onAbort);
          resolve(text);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * One read-only command (away digest's git log, a search's grep) on this
   * connection, its output capped. A command cancelled (or past its deadline)
   * while the link is being made settles then and is never sent; the link,
   * which Chat shares, is left to finish.
   */
  run(command: RemoteCommand, maxOutputBytes: number, signal?: AbortSignal): Promise<RemoteCommandOutput> {
    if (signal?.aborted === true) return Promise.reject(new CancelledError());
    const work = this.withLink("Running a command", (link) => cappedExec(link.client, command.text, maxOutputBytes, signal));
    if (signal === undefined) return work;
    return new Promise<RemoteCommandOutput>((resolve, reject) => {
      const cancel = (): void => reject(new CancelledError());
      signal.addEventListener("abort", cancel, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }

  close(): void {
    this.closed = true;
    this.attempt?.abort(new Error("the transcript reader is closed"));
    this.attempt = null;
  }
}

/** One exec's stdout, bounded; the locate command always exits 0. */
export function execOutput(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let over = false;
      channel.on("data", (chunk: Buffer) => {
        if (over) return;
        bytes += chunk.length;
        if (bytes > maxLocateOutputBytes) {
          over = true;
          channel.close();
          return;
        }
        chunks.push(chunk);
      });
      channel.stderr.on("data", () => undefined);
      channel.on("close", () => {
        if (over) reject(new Error("the transcript search printed more than a path"));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  });
}

/**
 * One exec's stdout, at most `maxBytes` (past it the channel is
 * closed and what came is the answer); a failure after some output keeps that
 * output (the Swift runner's rule). The signal closes the channel and rejects;
 * a signal that has already fired sends nothing.
 */
export function execBounded(client: Client, command: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("the command was cancelled"));
      return;
    }
    let settled = false;
    let open: ClientChannel | null = null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      if (error !== null && bytes === 0) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      open?.close();
      reject(new Error("the command was cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const limit = Math.max(0, Math.floor(maxBytes));
    client.exec(command, (error, channel) => {
      if (error) {
        finish(error);
        return;
      }
      if (settled) {
        channel.close();
        return;
      }
      open = channel;
      let full = false;
      channel.on("data", (chunk: Buffer) => {
        if (full || settled) return;
        const room = limit - bytes;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          bytes = limit;
          full = true;
          channel.close();
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });
      channel.stderr.on("data", () => undefined);
      channel.on("error", (channelError: unknown) => finish(channelError));
      channel.on("close", () => finish(null));
    });
  });
}

/** One exec's stdout up to `limit` bytes (past it the channel closes); stderr ignored; an abort closes the channel. */
export function cappedExec(client: Client, command: string, limit: number, signal?: AbortSignal): Promise<RemoteCommandOutput> {
  // Cancelled before it is sent (the link took its time): nothing goes to the machine.
  if (signal?.aborted === true) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      const collector = new OutputCollector(limit);
      let cancelled = false;
      const abort = (): void => {
        cancelled = true;
        channel.close();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
      channel.on("data", (chunk: Buffer) => {
        if (!collector.append(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length))) channel.close();
      });
      channel.stderr.on("data", () => undefined);
      channel.on("close", () => {
        signal?.removeEventListener("abort", abort);
        if (cancelled) reject(new CancelledError());
        else resolve(collector.output);
      });
    });
  });
}

/**
 * One SFTP read request asks at most this much (ssh2's
 * read limit on OpenSSH: a 256 KB packet less 2 KB of overhead; a longer ask
 * is split by ssh2 into requests one after another)…
 */
export const transcriptReadChunk = 254 * 1_024;
/** …and this many go out at once (about 2 MB), as HerdrKit's CitadelTransport.transcriptReadDepth. */
export const transcriptReadDepth = 8;

/**
 * Up to `length` bytes from `offset`, fewer at the end of the file. The chunk
 * requests go `transcriptReadDepth` at once (a 4 MB catch-up window is two
 * round trips of chunks, not sixteen); their answers are
 * kept in order up to an empty one (the end of the file) or a short one (what
 * was asked after it no longer lines up: the next batch asks from there).
 */
export function readRange(sftp: SFTPWrapper, path: string, offset: number, length: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    sftp.open(path, "r", (openError, handle) => {
      if (openError) {
        reject(isNotFound(openError) ? new TranscriptNotFoundError(path) : openError);
        return;
      }
      const buffer = Buffer.alloc(length);
      let filled = 0;
      const finish = (error: unknown): void => {
        sftp.close(handle, () => {
          if (error) reject(error);
          else resolve(new Uint8Array(buffer.buffer, buffer.byteOffset, filled));
        });
      };
      const batch = (): void => {
        if (filled >= length) {
          finish(null);
          return;
        }
        const asks: { at: number; length: number }[] = [];
        for (let at = filled; asks.length < transcriptReadDepth && at < length; ) {
          const ask = Math.min(length - at, transcriptReadChunk);
          asks.push({ at, length: ask });
          at += ask;
        }
        const answers: number[] = Array.from({ length: asks.length }, () => 0);
        let waiting = asks.length;
        let failure: unknown = null;
        asks.forEach((ask, index) => {
          sftp.read(handle, buffer, ask.at, ask.length, offset + ask.at, (error, bytesRead) => {
            if (error) failure ??= error;
            else answers[index] = bytesRead;
            waiting -= 1;
            if (waiting > 0) return;
            if (failure !== null) {
              finish(failure);
              return;
            }
            for (const [at, answer] of answers.entries()) {
              // The end of the file.
              if (answer <= 0) {
                finish(null);
                return;
              }
              filled += answer;
              // A short answer: what was asked after it no longer lines up.
              if (answer < asks[at]!.length) break;
            }
            batch();
          });
        });
      };
      batch();
    });
  });
}
