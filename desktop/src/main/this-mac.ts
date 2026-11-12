// "This Mac": the built-in machine for a Herdr on the same Mac,
// reached with no SSH. It is the Herdr TUI backend with its connections
// opened by the local session (herdr/local.ts) instead of connectSsh, so
// every feature runs as it does for a saved machine: requests, the event
// stream, terminals, Chat, uploads (a local copy in the same attachments
// folder layout), the 30-day sweep and Changes' git.
//
// No address, no password, no host key, no trust step: its sign-in config
// names no key and no secret, its host key policy is an in-memory one that is
// never asked (the local session has no host key), and nothing about it is
// added to hosts.json, host-secrets.json or known_hosts.json. It is listed on
// macOS only, first in the list (HostRegistry keeps a "local" entry first).
//
// Its connections share one login environment (local.ts
// LoginEnvironment: the account's login shell read once), read again when
// This Mac reconnects: a new command connection, or its Herdr found again
// after it was not running. A snapshot sends its request first, so the
// command connection is the one HostRegistry reads right after asking,
// and one deadline covers the request and the look that follows
// a failure. Herdr's socket missing, or there with nothing listening (a stale
// socket after an unclean quit), reads "Herdr is not running on
// this Mac" with a short hint (how to start Herdr when the herdr command
// resolves, how to install it when it does not), never as an error; the next
// refresh looks again. A malformed reply or Herdr's own error stays an error.
//
// The snapshot's deadline owns its request (at the deadline
// its command connection is let go of and ended, and a request still
// connecting is never sent); Open in Ghostty starts the herdr the in-app pane
// finds, with its login environment (loginEnvironment, ghostty.ts).

import net from "node:net";
import os from "node:os";
import path from "node:path";

import { HerdrTuiBackend } from "./herdr/backend";
import { defaultRoundTripTimeoutMs, defaultSessionName, herdrPresenceCommand, parseHerdrPresence } from "./herdr/commands";
import { HerdrNotRunningHereError, RemoteSocketFailedError, RequestTimedOutError } from "./herdr/errors";
import { MemoryPinStore, PinningHostKeyPolicy } from "./herdr/host-key-pinning";
import { connectLocal, LoginEnvironment, type LocalSessionOptions } from "./herdr/local";
import type { SshHostConfig } from "./herdr/ssh";
import { socketMissingDetail } from "./herdr/transport";
import type { SessionTopology } from "./herdr/wire";
import type { HostDescriptor, HostRegistry } from "./hosts";

export const thisMacId = "this-mac";

export const thisMacText = {
  name: "This Mac",
  notRunning: "Herdr is not running on this Mac",
  /** The herdr command resolves, but there is no socket. */
  startHint: "Start Herdr in a terminal; Adari looks for it every few seconds.",
  /** Neither the command nor the socket. */
  installHint: "Install Herdr or add it to your login shell's PATH, then start it.",
} as const;

/** This Mac is listed on macOS only (its terminal's PTY and the commands' spellings are macOS's). */
export function thisMacAvailable(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

/** The built-in entry: no address to reach, nothing saved. */
export function thisMacDescriptor(): HostDescriptor {
  return { id: thisMacId, name: thisMacText.name, kind: "local", address: "local", platform: "macOS" };
}

/** A machine that is built in rather than saved: no settings, never removed or written to the saved machines. */
export function isBuiltInHost(hostId: string): boolean {
  return hostId === thisMacId;
}

function accountName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "me";
  }
}

/** The config the Herdr TUI backend is built with: the default session, no key, no secret (nothing to sign in to). */
export function thisMacConfig(): SshHostConfig {
  return { host: "this Mac", port: 0, username: accountName(), privateKeyPath: "", herdrSession: defaultSessionName };
}

const isSocketMissing = (error: unknown): boolean => error instanceof RemoteSocketFailedError && error.detail === socketMissingDetail;

/**
 * The session's API socket on this Mac, as resolvedSocketSetup finds it:
 * $XDG_CONFIG_HOME (when set and not empty, from the home folder when
 * relative), else $HOME/.config; then herdr/herdr.sock, or
 * herdr/sessions/<name>/herdr.sock.
 */
export function localSocketPath(env: NodeJS.ProcessEnv, home: string, session: string): string {
  const own = env["HOME"] || home;
  const root = env["XDG_CONFIG_HOME"] ? path.resolve(own, env["XDG_CONFIG_HOME"]) : path.join(own, ".config");
  return session === defaultSessionName ? path.join(root, "herdr", "herdr.sock") : path.join(root, "herdr", "sessions", session, "herdr.sock");
}

/**
 * One connection attempt to the socket at `socketPath`:
 * "dead" when nothing listens there (refused) or it is gone, "live" when
 * something accepts (then closed at once), "unknown" otherwise or after
 * `timeoutMs`.
 */
export function probeSocket(socketPath: string, timeoutMs = 1_000): Promise<"live" | "dead" | "unknown"> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const done = (result: "live" | "dead" | "unknown"): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    socket.once("connect", () => done("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "dead" : "unknown"));
  });
}

/** This Mac's options: the local session's, and one deadline for a request and for a snapshot with its look (default 10 s). */
export interface ThisMacOptions extends LocalSessionOptions {
  readonly requestTimeoutMs?: number;
}

/** This Mac's Herdr over the local session. */
export class ThisMacBackend extends HerdrTuiBackend {
  private readonly environment: LoginEnvironment;
  private readonly home: string;
  private readonly deadlineMs: number;
  /** The command connection the last snapshot went on (another one is a reconnect). */
  private lastEpoch: number | null = null;
  /** The last look found Herdr not running (finding it again is a reconnect). */
  private missing = false;

  constructor(options: ThisMacOptions = {}) {
    const config = thisMacConfig();
    // One login environment for every connection.
    const environment = options.environment ?? new LoginEnvironment(options);
    const local: LocalSessionOptions = { ...options, environment };
    super(config, new PinningHostKeyPolicy(new MemoryPinStore()), {
      connect: () => connectLocal(local),
      machineKey: `${config.username}@${thisMacId}`,
      ...(options.requestTimeoutMs === undefined ? {} : { roundTripTimeoutMs: options.requestTimeoutMs }),
    });
    this.environment = environment;
    this.home = options.home ?? os.homedir();
    this.deadlineMs = options.requestTimeoutMs ?? defaultRoundTripTimeoutMs;
  }

  /** The login environment This Mac's commands and terminals run in now (Open in Ghostty starts the same Herdr with it). */
  loginEnvironment(): NodeJS.ProcessEnv {
    return this.environment.current();
  }

  /** Whether the herdr command resolves and Herdr's socket is there, asked in the login environment (herdr is never run). */
  async presence(signal?: AbortSignal): Promise<{ herdr: boolean; socket: boolean }> {
    const output = await this.changesRunner().runReadOnlyCommand(herdrPresenceCommand(defaultSessionName), 4_096, signal);
    return parseHerdrPresence(output);
  }

  private notRunning(presence: { herdr: boolean }): HerdrNotRunningHereError {
    return new HerdrNotRunningHereError(thisMacText.notRunning, presence.herdr ? thisMacText.startHint : thisMacText.installHint);
  }

  /**
   * Herdr's session. The request goes first (its command connection is
   * picked or opened now, as HostRegistry expects), and one
   * deadline covers it and the look after a failure. The deadline owns the
   * request: when it passes, the request's command connection is let
   * go of and ended, a request still connecting is never sent, and nothing of
   * it can end a later one. Herdr's socket missing, or there with nothing
   * listening, is HerdrNotRunningHereError with the hint (whether the herdr
   * command resolves picks it); any other failure is itself.
   */
  override snapshot(): Promise<SessionTopology> {
    const expiry = new AbortController();
    const asking = super.snapshot({ signal: expiry.signal });
    this.noticeConnection();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timedOut = new RequestTimedOutError(Math.max(1, Math.floor(this.deadlineMs / 1_000)));
        expiry.abort(timedOut);
        reject(timedOut);
      }, this.deadlineMs);
    });
    const answer = asking.then(
      (topology) => {
        this.found();
        return topology;
      },
      (error: unknown) => this.unanswered(error, expiry.signal),
    );
    return Promise.race([answer, deadline]).finally(() => clearTimeout(timer));
  }

  /** A command connection other than the last snapshot's is a reconnect: the login environment is read again (in the background). */
  private noticeConnection(): void {
    const epoch = this.connectionEpoch();
    if (epoch === null) return;
    if (this.lastEpoch !== null && epoch !== this.lastEpoch) void this.environment.refresh();
    this.lastEpoch = epoch;
  }

  /** Herdr answered: after a look that found it not running, that is a reconnect, and the login environment is read again. */
  private found(): void {
    if (!this.missing) return;
    this.missing = false;
    void this.environment.refresh();
  }

  private async unanswered(error: unknown, signal: AbortSignal): Promise<never> {
    // Past the deadline the snapshot is over: its cancelled request says nothing about Herdr.
    if (signal.aborted) throw error;
    if (!(await this.herdrGone(error))) throw error;
    this.missing = true;
    const presence = await this.presence(signal).catch(() => ({ herdr: false, socket: false }));
    throw this.notRunning(presence);
  }

  /** Herdr's socket missing (the sentinel), or there with nothing listening: Herdr is not running. */
  private async herdrGone(error: unknown): Promise<boolean> {
    if (!(error instanceof RemoteSocketFailedError)) return false;
    if (isSocketMissing(error)) return true;
    return (await probeSocket(localSocketPath(this.environment.current(), this.home, defaultSessionName))) === "dead";
  }
}

/** Adds This Mac to the machines list (first: the registry keeps a local entry first); its backend. */
export function addThisMac(registry: HostRegistry, options: ThisMacOptions = {}): ThisMacBackend {
  const backend = new ThisMacBackend(options);
  registry.add(thisMacDescriptor(), backend);
  return backend;
}
