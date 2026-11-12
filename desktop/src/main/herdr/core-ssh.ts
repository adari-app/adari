// herdr-core over SSH (the Swift client's CoreSSHLink.swift).
// `hc connect` "speaks the same protocol over stdin/stdout, so `ssh box hc
// connect` is a remote core" (herdr-core schema/README.md "Connecting"). One
// long-lived SSH exec channel runs it, on its own ssh2 client opened with the
// host's SshHostConfig and the same host-key pinning policy as the TUI link
// (connectSsh), so the core's terminal streams and their flow control never
// stall the TUI's command traffic.

import type { Client, ClientChannel } from "ssh2";
import { CoreQueue } from "./core-queue";
import { utf8Text } from "./core-json";
import type { CoreLink } from "./core-connection";
import { TransportError } from "./errors";
import { HostKeyRejectedError, HostKeyStorageError, NewHostKeyError, type PinningHostKeyPolicy } from "./host-key-pinning";
import { connectSsh, type SshHostConfig } from "./ssh";

/** Printed to stderr when no herdr-core binary is found. */
const notInstalledMarker = "__HC_NOT_INSTALLED__";

/**
 * Finds herdr-core as herdr is found: the exec shell's `command -v`, then a login shell's, then the install
 * paths. `herdr-core` is looked for in every one of those places before any `hc`: the
 * installer links `hc` beside it "only if no `hc` exists", so an `hc` may be another program. An `hc` is used
 * only when it is herdr-core: a link to a `herdr-core`, or one whose `--version` line names `hc` or
 * `herdr-core`. Only an absolute, executable path is used; `hello` then proves it is herdr-core.
 */
const resolution =
  'HC=""; hc_ok() { case "$1" in /*) [ -x "$1" ];; *) false;; esac; }; ' +
  'hc_is_core() { case "$(readlink "$1" 2>/dev/null)" in herdr-core|*/herdr-core) return 0;; esac; ' +
  'case "$("$1" --version </dev/null 2>/dev/null | head -n 1)" in "hc "*|"herdr-core "*) return 0;; esac; return 1; }; ' +
  'C=$(command -v herdr-core 2>/dev/null || true); hc_ok "$C" && HC="$C"; ' +
  "[ -n \"$HC\" ] || { C=$(\"${SHELL:-/bin/sh}\" -lc 'command -v herdr-core 2>/dev/null' </dev/null 2>/dev/null | tail -n 1); hc_ok \"$C\" && HC=\"$C\"; }; " +
  'for P in "$HOME/.local/bin/herdr-core" /opt/homebrew/bin/herdr-core /usr/local/bin/herdr-core; do [ -n "$HC" ] && break; hc_ok "$P" && HC="$P"; done; ' +
  'if [ -z "$HC" ]; then ' +
  "for C in \"$(command -v hc 2>/dev/null || true)\" \"$(\"${SHELL:-/bin/sh}\" -lc 'command -v hc 2>/dev/null' </dev/null 2>/dev/null | tail -n 1)\" \"$HOME/.local/bin/hc\" /opt/homebrew/bin/hc /usr/local/bin/hc; do " +
  '[ -n "$HC" ] && break; hc_ok "$C" && hc_is_core "$C" && HC="$C"; done; fi; ' +
  `[ -n "$HC" ] || { printf '${notInstalledMarker}\\n' >&2; exit 127; }; `;

export const CoreCommands = {
  notInstalledMarker,
  resolution,
  /** The exec line: find herdr-core, then become `hc connect`. */
  connect: resolution + 'exec "$HC" connect',
} as const;

export type CoreLinkFault = { readonly kind: "notInstalled" } | { readonly kind: "transport"; readonly detail: string };

export class CoreLinkError extends Error {
  constructor(readonly fault: CoreLinkFault) {
    super(
      fault.kind === "notInstalled"
        ? "herdr-core is not installed on this Mac. Expected herdr-core or hc on PATH, in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin."
        : fault.detail,
    );
    this.name = "CoreLinkError";
  }
}

/** The link was closed on purpose (Swift's CancellationError): not a failure. */
export class CoreCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CoreCancelledError";
  }
}

/** One exec channel with stdin (ssh2's ClientChannel in the app; a fake remote in tests). */
export interface CoreExecChannel {
  /** Queues stdin bytes; never waits (ssh2 buffers what the window does not take yet). */
  write(bytes: Uint8Array): void;
  onStdout(listener: (bytes: Uint8Array) => void): void;
  onStderr(listener: (bytes: Uint8Array) => void): void;
  /** Once: the channel ended (an error when it failed). */
  onEnd(listener: (error: unknown) => void): void;
  close(): void;
}

/** What a CoreSshLink runs on: one SSH client's exec, and the client's close. */
export interface CoreExecClient {
  exec(command: string): Promise<CoreExecChannel>;
  /** Ends the client (its connection and every channel on it). */
  close(): void;
}

/** ssh2's channel as a CoreExecChannel. */
export function ssh2ExecChannel(channel: ClientChannel): CoreExecChannel {
  let ended = false;
  const ends: ((error: unknown) => void)[] = [];
  const end = (error: unknown): void => {
    if (ended) return;
    ended = true;
    for (const listener of ends.splice(0)) listener(error);
  };
  channel.once("close", () => end(null));
  channel.once("error", (error: Error) => end(error));
  return {
    write: (bytes) => {
      if (!ended) channel.write(Buffer.from(bytes));
    },
    onStdout: (listener) => channel.on("data", (chunk: Buffer) => listener(new Uint8Array(chunk))),
    onStderr: (listener) => channel.stderr.on("data", (chunk: Buffer) => listener(new Uint8Array(chunk))),
    onEnd: (listener) => {
      if (ended) listener(null);
      else ends.push(listener);
    },
    close: () => {
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** ssh2's client as a CoreExecClient. */
export function ssh2ExecClient(client: Client): CoreExecClient {
  return {
    exec: (command) =>
      new Promise<CoreExecChannel>((resolve, reject) => {
        const gone = (): void => reject(new CoreLinkError({ kind: "transport", detail: "the connection closed" }));
        client.once("close", gone);
        try {
          client.exec(command, (error, channel) => {
            client.removeListener("close", gone);
            if (error) {
              reject(new CoreLinkError({ kind: "transport", detail: `exec failed: ${error.message}` }));
              return;
            }
            resolve(ssh2ExecChannel(channel));
          });
        } catch (error) {
          client.removeListener("close", gone);
          reject(error);
        }
      }),
    close: () => client.end(),
  };
}

/** The host's own SSH client for its herdr-core (its credentials and host-key pinning, unchanged). */
export function sshCoreLink(
  config: SshHostConfig,
  policy: PinningHostKeyPolicy,
  connect: (config: SshHostConfig, policy: PinningHostKeyPolicy, timeoutMs?: number) => Promise<Client> = connectSsh,
): CoreSshLink {
  return new CoreSshLink(CoreCommands.connect, async () => ssh2ExecClient(await connect(config, policy)));
}

const stderrLimit = 8192;

function isHostOrSignInError(error: unknown): boolean {
  return error instanceof TransportError || error instanceof HostKeyRejectedError || error instanceof NewHostKeyError || error instanceof HostKeyStorageError;
}

/** One SSH exec channel running `hc connect`: its stdout is `inbound`, its stdin takes `send`. Closing it ends the channel and its client. */
export class CoreSshLink implements CoreLink {
  readonly inbound = new CoreQueue<Uint8Array>();
  private closed = false;
  private ended = false;
  /** The client once made, so `close()` reaches it at once. */
  private client: CoreExecClient | null = null;
  private channel: CoreExecChannel | null = null;
  private queued: Uint8Array[] = [];
  private stderr: Uint8Array[] = [];
  private stderrBytes = 0;

  /** Starts the channel at once; bytes sent before it opens are queued. */
  constructor(command: string, makeClient: () => Promise<CoreExecClient>) {
    void this.run(command, makeClient);
  }

  send(bytes: Uint8Array): boolean {
    if (this.closed || this.ended) return false;
    if (this.channel !== null) this.channel.write(bytes);
    else this.queued.push(bytes);
    return true;
  }

  /**
   * Ends the link now: the client is closed at once, never after a write. A stdin write can wait
   * on the remote's window; closing the client ends its channels, so nothing here waits for one.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    this.client = null;
    const channel = this.channel;
    this.channel = null;
    this.queued = [];
    channel?.close();
    client?.close();
    this.end(null);
  }

  get isClosed(): boolean {
    return this.closed || this.ended;
  }

  private async run(command: string, makeClient: () => Promise<CoreExecClient>): Promise<void> {
    let client: CoreExecClient;
    try {
      client = await makeClient();
    } catch (error) {
      this.end(error);
      return;
    }
    // A client that comes after the link closed is closed with no exec opened.
    if (this.closed) {
      client.close();
      return;
    }
    this.client = client;
    let channel: CoreExecChannel;
    try {
      channel = await client.exec(command);
    } catch (error) {
      if (this.client === client) this.client = null;
      client.close();
      this.end(error);
      return;
    }
    if (this.closed) {
      channel.close();
      client.close();
      return;
    }
    this.channel = channel;
    channel.onStdout((bytes) => {
      if (!this.ended) this.inbound.push(bytes);
    });
    channel.onStderr((bytes) => this.noteStderr(bytes));
    channel.onEnd((error) => {
      this.channel = null;
      const held = this.client;
      this.client = null;
      held?.close();
      this.end(error);
    });
    for (const bytes of this.queued.splice(0)) channel.write(bytes);
  }

  private noteStderr(bytes: Uint8Array): void {
    this.stderr.push(bytes);
    this.stderrBytes += bytes.length;
    while (this.stderrBytes - (this.stderr[0]?.length ?? 0) >= stderrLimit && this.stderr.length > 1) {
      this.stderrBytes -= (this.stderr.shift() as Uint8Array).length;
    }
  }

  private stderrText(): string {
    const all = new Uint8Array(this.stderrBytes);
    let at = 0;
    for (const chunk of this.stderr) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return utf8Text(all.subarray(Math.max(0, all.length - stderrLimit)));
  }

  private end(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    // Closed here: what the client's early close made the channel report is not the link's failure.
    const reason = CoreSshLink.ending(this.stderrText(), this.closed ? null : error);
    if (reason === null) this.inbound.finish();
    else this.inbound.finish(reason);
  }

  /** Why the channel ended, from what `hc connect` (or the lookup) printed. */
  static ending(stderr: string, error: unknown): Error | null {
    if (stderr.includes(notInstalledMarker)) return new CoreLinkError({ kind: "notInstalled" });
    const trimmed = stderr.trim();
    if (error !== null && error !== undefined) {
      if (error instanceof CoreCancelledError) return null;
      if (error instanceof CoreLinkError) return error;
      if (isHostOrSignInError(error)) return error as Error;
      const detail = trimmed === "" ? (error instanceof Error ? error.message : String(error)) : trimmed;
      return new CoreLinkError({ kind: "transport", detail });
    }
    return trimmed === "" ? null : new CoreLinkError({ kind: "transport", detail: trimmed });
  }
}
