// SSH with ssh2 (pure JavaScript; no native module is built): a password, or a
// key file the user picked (read at connect time, never copied), the password
// or the key's passphrase read from the encrypted secret store at connect
// time (src/main/secret-store.ts), the host key pinned on first contact and
// refused on change before authentication, then
// protocol 22 exactly as CitadelTransport speaks it: one exec per request, and
// a PTY channel per attached pane on its own connection.

import { readFileSync } from "node:fs";

import { Client, type ClientChannel, type ConnectConfig, type KeyboardInteractiveCallback, type Prompt } from "ssh2";

import type { SshAuthMethod } from "../../shared/ipc-contract";
import { SecretStoreReadError } from "../secret-store";

import {
  defaultConnectTimeoutMs,
  defaultRoundTripTimeoutMs,
  herdrNotInstalledSentinel,
  officialRequestCommand,
  sessionSocketPath,
  typedAttachLine,
  type AttachTarget,
} from "./commands";
import {
  AuthenticationFailedError,
  ClosedDuringSignInError,
  ConnectFailedError,
  ConnectTimedOutError,
  HerdrNotInstalledError,
  HostUnreachableError,
  RequestTimedOutError,
  TransportError,
  redactSecrets,
  unreachableReason,
} from "./errors";
import { PinningHostKeyValidator, type PinningHostKeyPolicy } from "./host-key-pinning";
import {
  AttachReadiness,
  OrderedTerminalInput,
  clampDimensions,
  classifyAttachEnding,
  describeAttachEnding,
  plainLines,
  type TerminalDimensions,
} from "./terminal";
import { ReplyCollector, type HerdrTransport, type RoundTripOptions } from "./transport";
import { RelayClient, relayHelloMs, relayLaunchCommand } from "./relay";

export interface SshHostConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** How it signs in; a machine saved before passwords has none and uses its key file. */
  readonly auth?: SshAuthMethod;
  /** A private key file the user picked ("" for a password). Read when connecting; never stored elsewhere. */
  readonly privateKeyPath: string;
  /** Official Herdr session name; "default" is the standard unnamed session. */
  readonly herdrSession: string;
  /**
   * The saved password, or the key's passphrase, decrypted when connecting
   * (main process only; never saved with the machine), or null when none.
   */
  readonly secret?: () => string | null;
  /** Holds a sign-in refusal: once refused, no connection is tried until it is reset. */
  readonly authLatch?: AuthLatch;
}

/**
 * One machine's sign-in refusal. A refused password
 * tried again and again by the sidebar's refresh, a terminal and Chat would
 * spend the server's tries and can lock the account, so after a refusal every
 * connection for these credentials fails at once, without a client, until
 * Try again (reset) or Edit machine (new credentials, a new latch).
 */
export class AuthLatch {
  private refusal: AuthenticationFailedError | null = null;

  get refused(): AuthenticationFailedError | null {
    return this.refusal;
  }

  refuse(error: AuthenticationFailedError): void {
    this.refusal = error;
  }

  reset(): void {
    this.refusal = null;
  }
}

/** The authentication part of ssh2's connect config, and the password for keyboard-interactive. */
export interface SshAuthOptions {
  readonly connect: Pick<ConnectConfig, "password" | "privateKey" | "passphrase" | "tryKeyboard" | "agent">;
  readonly keyboardPassword: string | null;
  /** The password or passphrase in use, to take out of any error text. */
  readonly secret: string | null;
}

/**
 * What ssh2 is given for the machine's sign-in method. A password goes as
 * `password`, and keyboard-interactive is allowed so a Mac whose sshd asks
 * through PAM's prompt instead gets the same password (ssh2's default order:
 * none, password, then keyboard-interactive when tryKeyboard is set). A key
 * file goes as `privateKey`, with its passphrase when one is saved. Never an
 * agent. Throws a ConnectFailedError naming what is missing.
 */
export function sshAuthOptions(config: SshHostConfig, readKey: (path: string) => Buffer = readFileSync): SshAuthOptions {
  let secret: string | null;
  try {
    secret = config.secret?.() ?? null;
  } catch (error) {
    // The secret store says why it could not be read; never the secret.
    if (error instanceof SecretStoreReadError) throw new ConnectFailedError(config.host, `could not read the saved password (${error.reason})`);
    throw new ConnectFailedError(config.host, describe(error));
  }
  if (config.auth === "password") {
    if (secret === null || secret === "") {
      throw new ConnectFailedError(config.host, "No password is saved for this machine. Enter it again in Edit machine");
    }
    return { connect: { password: secret, tryKeyboard: true, agent: undefined }, keyboardPassword: secret, secret };
  }
  let privateKey: Buffer;
  try {
    privateKey = readKey(config.privateKeyPath);
  } catch (error) {
    throw new ConnectFailedError(config.host, `cannot read the key file (${describe(error)})`);
  }
  const passphrase = secret === null || secret === "" ? {} : { passphrase: secret };
  return { connect: { privateKey, ...passphrase, tryKeyboard: false, agent: undefined }, keyboardPassword: null, secret };
}

/**
 * Answers keyboard-interactive with the password: its hidden prompts, once
 * per connection (a second round means it was refused; asking again only
 * spends the server's tries). A round with no prompts (instructions only) is
 * answered with nothing.
 */
function keyboardResponder(password: string) {
  let answered = false;
  return (_name: string, _instructions: string, _lang: string, prompts: Prompt[], finish: KeyboardInteractiveCallback): void => {
    if (prompts.length === 0) {
      finish([]);
      return;
    }
    if (answered) {
      finish([]);
      return;
    }
    answered = true;
    finish(prompts.map((prompt) => (prompt.echo === true ? "" : password)));
  };
}

/**
 * ssh2's connection error, in fixed words only (never ssh2's or the
 * server's text): a refused sign-in, a timeout, an address not found or not
 * reachable, another network failure by its code, and anything else as
 * closed during sign-in.
 */
function connectError(config: SshHostConfig, error: Error & { level?: string; code?: string }): TransportError {
  if (error.level === "client-authentication") {
    return new AuthenticationFailedError(config.host, config.auth === "password" ? "password" : "key");
  }
  if (error.level === "client-timeout") return new ConnectTimedOutError(config.host);
  const unreachable = unreachableReason(error.code);
  if (unreachable !== null) return new HostUnreachableError(config.host, config.port, unreachable);
  if (error.level === "client-socket" && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)) {
    return new ConnectFailedError(config.host, `the network connection failed (${error.code})`);
  }
  return new ClosedDuringSignInError(config.host);
}

/** ssh2's key parse failure, in words when it is the passphrase. */
function keyProblem(detail: string): string {
  if (/no passphrase given/i.test(detail)) return "the key file needs its passphrase. Enter it in Edit machine.";
  if (/bad passphrase/i.test(detail)) return "the key file's passphrase is wrong. Check it in Edit machine.";
  return detail;
}

/** Seams for the tests: the ssh2 client and the key file read. */
export interface SshConnectSeams {
  readonly makeClient?: () => Client;
  readonly readKey?: (path: string) => Buffer;
}

export interface SshOptions {
  readonly connectTimeoutMs?: number;
  readonly roundTripTimeoutMs?: number;
  /**
   * Opens the client its requests go on (default connectSsh);
   * This Mac's local session (local.ts connectLocal) for the built-in entry.
   */
  readonly connect?: (config: SshHostConfig, policy: PinningHostKeyPolicy, timeoutMs?: number) => Promise<Client>;
  /**
   * The relay script (relay-script.ts) started on each new command connection; empty or absent,
   * relay off: every request is its own exec. This Mac's local session never passes one.
   */
  readonly relayScript?: string;
  /** How long the relay has to say hello (default relayHelloMs; tests). */
  readonly relayHelloMs?: number;
  /** The relay's launch line (default relayLaunchCommand; a herdr-core host's reads relay: relayReadsLaunchCommand). */
  readonly relayLaunch?: (session: string, script: string) => string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens one authenticated ssh2 client, mapping failures to TransportErrors. */
export function connectSsh(
  config: SshHostConfig,
  policy: PinningHostKeyPolicy,
  timeoutMs = defaultConnectTimeoutMs,
  seams: SshConnectSeams = {},
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const refused = config.authLatch?.refused ?? null;
    if (refused !== null) {
      reject(refused);
      return;
    }
    let auth: SshAuthOptions;
    try {
      auth = sshAuthOptions(config, seams.readKey);
    } catch (error) {
      reject(error);
      return;
    }
    const validator = new PinningHostKeyValidator(config.host, config.port, policy);
    const client = seams.makeClient?.() ?? new Client();
    let settled = false;
    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) {
        resolve(client);
      } else {
        client.end();
        reject(error);
      }
    };
    const timer = setTimeout(() => settle(new ConnectTimedOutError(config.host)), timeoutMs);
    client.once("ready", () => settle(null));
    client.on("error", (error: Error & { level?: string; code?: string }) => {
      // A changed host key first, in today's words (host-key-pinning.ts).
      if (validator.lastRejection !== null) {
        settle(validator.lastRejection);
        return;
      }
      const failure = connectError(config, error);
      if (failure instanceof AuthenticationFailedError) config.authLatch?.refuse(failure);
      settle(failure);
    });
    client.once("close", () => settle(new ConnectFailedError(config.host, "the connection closed")));
    if (auth.keyboardPassword !== null) client.on("keyboard-interactive", keyboardResponder(auth.keyboardPassword));
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: timeoutMs,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 2,
      // No hostHash: ssh2 hands the raw wire-format key to the verifier.
      hostVerifier: validator.verify,
      // The machine's own method only: its password, or its key file. Never an agent.
      ...auth.connect,
    };
    try {
      client.connect(connectConfig);
    } catch (error) {
      // ssh2 throws here when it cannot use the key (a passphrase missing or wrong).
      settle(new ConnectFailedError(config.host, redactSecrets(keyProblem(describe(error)), [auth.secret])));
    }
  });
}

/** Runs one exec and collects its single reply line (CitadelTransport.roundTrip). */
export function execReply(client: Client, command: string, remoteSocketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) {
        reject(new TransportError(`exec failed: ${error.message}`));
        return;
      }
      const collector = new ReplyCollector(remoteSocketPath);
      let exitCode: number | null = null;
      let done = false;
      const finish = (outcome: { reply: string } | { error: unknown }): void => {
        if (done) return;
        done = true;
        if ("reply" in outcome) resolve(outcome.reply);
        else reject(outcome.error instanceof Error ? outcome.error : new TransportError(String(outcome.error)));
      };
      channel.on("data", (chunk: Buffer) => {
        try {
          const reply = collector.stdout(chunk);
          if (reply !== null) {
            finish({ reply });
            channel.close();
          }
        } catch (failure) {
          finish({ error: failure });
          channel.close();
        }
      });
      channel.stderr.on("data", (chunk: Buffer) => collector.stderrChunk(chunk));
      channel.on("exit", (code: number | null, signal?: string) => {
        exitCode = code ?? (signal === undefined ? null : 1);
      });
      channel.on("close", () => {
        try {
          finish({ reply: collector.finish(exitCode) });
        } catch (failure) {
          finish({ error: failure });
        }
      });
    });
  });
}

/** The request line asks for `session.snapshot`. */
function isSnapshotRequest(requestLine: string): boolean {
  try {
    const parsed: unknown = JSON.parse(requestLine);
    return typeof parsed === "object" && parsed !== null && (parsed as { method?: unknown }).method === "session.snapshot";
  } catch {
    return false;
  }
}

/**
 * `waiting`, unless the request's deadline (`budget` ms; it was never written)
 * or its signal comes first.
 */
function withinBudget<T>(waiting: Promise<T>, budget: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const abort = (): void => finish(() => reject(signal?.reason));
    const finish = (then: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      then();
    };
    timer = setTimeout(() => finish(() => reject(new RequestTimedOutError(Math.max(1, Math.floor(budget / 1000))))), budget);
    signal?.addEventListener("abort", abort, { once: true });
    waiting.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * The shared command connection for one host. A missed deadline drops the
 * client so the next request reconnects instead of queueing behind a dead
 * socket; terminals own their own connections and are left alone.
 *
 * Every SSH client it opens takes the next epoch, also one a request opens
 * after the old client closed between requests, so a pane action can be bound
 * to the connection its snapshot came on.
 */
export class SshHerdrTransport implements HerdrTransport {
  private client: Promise<Client> | null = null;
  /** The held client's epoch (null: none held). */
  private epoch: number | null = null;
  /** SSH clients opened so far. */
  private opened = 0;
  /**
   * The held client's relay (null when the relay is off, failed, or did not say hello in 5 s:
   * that connection uses the exec path). It belongs to its client's epoch: when it ends, the client goes too.
   */
  private relay: Promise<RelayClient | null> | null = null;
  /** Settles the held client's relay start at once (null) while it is still starting. */
  private relayStop: (() => void) | null = null;
  /** A window is on screen: the relay is pinged every 5 s (T3's liveness). */
  private active = true;

  constructor(
    private readonly config: SshHostConfig,
    private readonly policy: PinningHostKeyPolicy,
    private readonly options: SshOptions = {},
  ) {}

  /** The epoch of the SSH client a request sent now goes on (null: none held; the next request opens one with a new number). */
  connectionEpoch(): number | null {
    return this.epoch;
  }

  private connected(): Promise<Client> {
    if (this.client === null) {
      const pending = (this.options.connect ?? connectSsh)(this.config, this.policy, this.options.connectTimeoutMs);
      this.opened += 1;
      this.client = pending;
      this.epoch = this.opened;
      const script = this.options.relayScript ?? "";
      this.relay = script === "" ? null : this.startRelay(pending, script);
      const drop = (): void => this.drop(pending);
      pending.then(
        (client) => {
          client.once("close", drop);
          client.once("end", drop);
        },
        drop,
      );
    }
    return this.client;
  }

  /**
   * One exec runs the relay on the client; its hello within 5 s makes it this connection's
   * relay, otherwise (no hello, the exec refused, no Perl) null: the exec path, tried again on the next connect.
   */
  private startRelay(pending: Promise<Client>, script: string): Promise<RelayClient | null> {
    return new Promise<RelayClient | null>((resolve) => {
      // The start settles once: the relay after its hello, or null (the exec path) when the
      // hello's 5 s from the exec-open attempt pass, the exec fails, or the connection closes, ends or is let go
      // first. A channel or a relay that comes after that is closed.
      let settled = false;
      let starting: RelayClient | null = null;
      let timer: NodeJS.Timeout | null = null;
      const settle = (relay: RelayClient | null): void => {
        if (settled) {
          relay?.close("no hello");
          return;
        }
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (this.relayStop === stop) this.relayStop = null;
        if (relay === null) starting?.close("no hello");
        resolve(relay);
      };
      const stop = (): void => settle(null);
      this.relayStop = stop;
      pending.then((client) => {
        if (settled) return;
        client.once("close", stop);
        client.once("end", stop);
        let command: string;
        try {
          command = (this.options.relayLaunch ?? relayLaunchCommand)(this.config.herdrSession, script);
        } catch {
          stop();
          return;
        }
        timer = setTimeout(stop, this.options.relayHelloMs ?? relayHelloMs);
        try {
          client.exec(command, (error, channel) => {
            if (error) {
              stop();
              return;
            }
            if (settled) {
              channel.close();
              return;
            }
            const relay = new RelayClient(
              { write: (text) => channel.write(text), close: () => channel.close() },
              sessionSocketPath(this.config.herdrSession),
              this.options.relayHelloMs,
            );
            starting = relay;
            channel.on("data", (chunk: Buffer) => relay.data(chunk));
            // stderr is diagnostics only (contract "Launch").
            channel.stderr.on("data", () => undefined);
            channel.on("close", () => relay.finish("the relay closed"));
            void relay.hello.then((ok) => {
              if (!ok || settled) {
                relay.close("no hello");
                stop();
                return;
              }
              // Contract rule 4: the relay ending mid-session ends its connection; the next request reconnects, relay first.
              relay.onEnd(() => this.lose(pending));
              relay.keepAlive(
                () => this.active,
                () => {
                  // A silent relay ends its connection, and while a window is on screen the
                  // next one opens at once (relay first), without waiting for another request.
                  this.lose(pending);
                  if (this.active && this.client === null) void this.connected().catch(() => undefined);
                },
              );
              settle(relay);
            });
          });
        } catch {
          stop();
        }
      }, stop);
    });
  }

  /** Lets go of `pending` while it is the held client (the next request opens a new one). */
  private drop(pending: Promise<Client>): void {
    if (this.client !== pending) return;
    const relay = this.relay;
    const stop = this.relayStop;
    this.client = null;
    this.epoch = null;
    this.relay = null;
    this.relayStop = null;
    // A relay still starting settles now (null), so nothing waits on it.
    stop?.();
    void relay?.then((held) => held?.close("the connection closed"));
  }

  /** The relay of `pending` is gone or dead: the connection goes with it (its epoch ends). */
  private lose(pending: Promise<Client>): void {
    if (this.client !== pending) return;
    this.drop(pending);
    pending.then(
      (client) => client.end(),
      () => undefined,
    );
  }

  /**
   * The held relay, once it said hello; null while none is (relay off, the exec path, or no
   * connection held). Never opens a connection.
   */
  async readyRelay(): Promise<RelayClient | null> {
    const relay = this.relay;
    if (relay === null) return null;
    const held = await relay;
    return held !== null && held.up ? held : null;
  }

  /** The relay now, opening the connection (relay first) when none is held; null on the exec path. */
  async openRelay(): Promise<RelayClient | null> {
    await this.connected();
    return this.readyRelay();
  }

  /** A window on screen or not (the 5 s pings run only while one is). */
  setActive(active: boolean): void {
    this.active = active;
  }

  /**
   * Window focus or system wake: a ping with a 2 s deadline; no pong drops the
   * connection and opens the next at once (relay first). Resolves true when the relay answered or none is held.
   */
  async wake(): Promise<boolean> {
    const pending = this.client;
    const relay = this.relay;
    if (pending === null || relay === null) return true;
    const held = await relay;
    if (held === null || this.client !== pending) return true;
    if (await held.wakeCheck()) return true;
    if (this.client === pending) {
      this.lose(pending);
      void this.connected().catch(() => undefined);
    }
    return false;
  }

  async roundTrip(requestLine: string, options: RoundTripOptions = {}): Promise<string> {
    // Relay off: the command is built (and a too-large one refused) before any connection.
    const early = (this.options.relayScript ?? "") === "" ? officialRequestCommand(requestLine, this.config.herdrSession) : null;
    const { signal } = options;
    signal?.throwIfAborted();
    const pending = this.connected();
    // Cold launch without the extra trip: a `session.snapshot` while this connection's relay
    // still starts goes on the exec path at once, beside the relay's launch, not after its hello (the first live
    // snapshot costs no more trips than relay off). Requests after the hello ride the relay.
    const relayed = this.relayStop !== null && isSnapshotRequest(requestLine) ? null : this.relay;
    // The caller's deadline lets go of this request's connection, if it is still the held one, and ends it.
    const cancel = (): void => {
      if (this.client !== pending) return;
      this.drop(pending);
      pending.then(
        (client) => client.end(),
        () => undefined,
      );
    };
    const budget = options.timeoutMs ?? this.options.roundTripTimeoutMs ?? defaultRoundTripTimeoutMs;
    const seconds = Math.max(1, Math.floor(budget / 1000));
    /** The request's deadline, counted as on the exec path from its connection (null: not yet). */
    let began: number | null = null;
    if (relayed !== null) {
      // On the relay a request is one write and one reply; its deadline fails it alone (contract rule 2).
      // Its deadline and signal run while the relay still starts too (bounded by its hello's 5 s,
      // settled when the connection goes); a deadline passing there fails it unwritten.
      await pending.catch(() => undefined);
      began = Date.now();
      const relay = await withinBudget(relayed, budget, signal);
      if (relay !== null && relay.up) {
        // The rest of the budget, counted once after startup; none left fails it unwritten (never a write).
        const rest = budget - (Date.now() - began);
        if (rest <= 0) throw new RequestTimedOutError(seconds);
        return relay.request(requestLine, rest, signal, budget);
      }
    }
    const command = early ?? officialRequestCommand(requestLine, this.config.herdrSession);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const client = await pending;
      // A request whose deadline passed while it connected is never sent.
      signal?.throwIfAborted();
      const left = began === null ? budget : budget - (Date.now() - began);
      if (left <= 0) throw new RequestTimedOutError(seconds);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (this.client === pending) {
            this.drop(pending);
            client.end();
          }
          // The command was handed to SSH: it may have reached Herdr, and ending the client cannot
          // recall it, so its result is unknown (never "not taken").
          reject(new RequestTimedOutError(seconds, true));
        }, left);
      });
      try {
        return await Promise.race([execReply(client, command, sessionSocketPath(this.config.herdrSession)), deadline]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  close(): void {
    const pending = this.client;
    const relay = this.relay;
    const stop = this.relayStop;
    this.client = null;
    this.epoch = null;
    this.relay = null;
    this.relayStop = null;
    stop?.();
    void relay?.then((held) => held?.close("closed"));
    pending?.then(
      (client) => client.end(),
      () => undefined,
    );
  }
}

export interface TerminalSink {
  data(bytes: Uint8Array): void;
  /** The attach ended; `reason` says why when it was not a plain finish. */
  exit(reason: string | null): void;
}

/** The attach target the app picks for a pane (CompanionApp: the terminal id, else the agent's pane). */
export function attachTargetFor(pane: { paneID: string; terminalID: string; agent?: string }): AttachTarget | null {
  if (pane.paneID === "") return null;
  if (pane.terminalID !== "") return { kind: "terminal", terminalID: pane.terminalID };
  if (pane.agent !== undefined && pane.agent !== "") return { kind: "agent", paneID: pane.paneID };
  return null;
}

const startupProbeLimit = 8_192;
const endingProbeLimit = 1_024;

/**
 * One attached pane: its own SSH connection, a PTY (xterm-256color), the
 * quoted `herdr ... attach` line written before any user key can reach the
 * login shell (printable ASCII only, checked before connecting: see
 * typedAttachLine), then bytes both ways. Keys typed before Herdr's first frame are
 * dropped in order (see OrderedTerminalInput).
 */
export class SshTerminalSession {
  private client: Client | null = null;
  private channel: ClientChannel | null = null;
  private readonly readiness = new AttachReadiness();
  private readonly input = new OrderedTerminalInput();
  private dimensions: TerminalDimensions;
  private startupProbe = Buffer.alloc(0);
  private endingProbe = Buffer.alloc(0);
  private exitCode: number | null = null;
  private closed = false;

  constructor(
    private readonly config: SshHostConfig,
    private readonly policy: PinningHostKeyPolicy,
    private readonly target: AttachTarget,
    size: TerminalDimensions,
    private readonly sink: TerminalSink,
    /** Opens the SSH client (a seam for the boundary tests; the app always uses connectSsh). */
    private readonly connect: (config: SshHostConfig, policy: PinningHostKeyPolicy) => Promise<Client> = connectSsh,
  ) {
    this.dimensions = clampDimensions(size.cols, size.rows);
  }

  async start(): Promise<void> {
    // Checked before connecting; exactly these bytes are typed.
    const line = typedAttachLine(this.target, this.config.herdrSession);
    const client = await this.connect(this.config, this.policy);
    if (this.closed) {
      client.end();
      return;
    }
    this.client = client;
    client.once("close", () => this.finish());
    await new Promise<void>((resolve, reject) => {
      client.shell(
        { term: "xterm-256color", cols: this.dimensions.cols, rows: this.dimensions.rows, width: 0, height: 0 },
        (error, channel) => {
          if (error) {
            reject(new TransportError(`PTY request failed: ${error.message}`));
            return;
          }
          channel.write(line);
          this.channel = channel;
          const onOutput = (chunk: Buffer): void => {
            this.recordProbes(chunk);
            if (this.readiness.record(chunk)) this.drain();
            this.sink.data(new Uint8Array(chunk));
          };
          channel.on("data", onOutput);
          channel.stderr.on("data", onOutput);
          channel.on("exit", (code: number | null) => {
            this.exitCode = code;
          });
          channel.on("close", () => this.finish());
          resolve();
        },
      );
    });
  }

  private recordProbes(chunk: Buffer): void {
    this.endingProbe = Buffer.concat([this.endingProbe, chunk.subarray(Math.max(0, chunk.length - endingProbeLimit))]);
    if (this.endingProbe.length > endingProbeLimit) {
      this.endingProbe = this.endingProbe.subarray(this.endingProbe.length - endingProbeLimit);
    }
    if (this.startupProbe.length < startupProbeLimit) {
      this.startupProbe = Buffer.concat([
        this.startupProbe,
        chunk.subarray(0, startupProbeLimit - this.startupProbe.length),
      ]);
    }
  }

  /** Keys from the terminal view. The ticket is taken now, so order is the user's. */
  send(data: Uint8Array): void {
    if (this.closed || data.length === 0) return;
    const ticket = this.input.issue();
    this.input.accept(ticket, data, this.readiness.isReady);
    this.drain();
  }

  private drain(): void {
    const channel = this.channel;
    if (channel === null || !this.readiness.isReady || this.closed) return;
    for (let next = this.input.takeNext(); next !== undefined; next = this.input.takeNext()) {
      if (next.length > 0) channel.write(Buffer.from(next));
    }
  }

  resize(cols: number, rows: number): void {
    this.dimensions = clampDimensions(cols, rows);
    this.channel?.setWindow(this.dimensions.rows, this.dimensions.cols, 0, 0);
  }

  private endingReason(): string | null {
    const ending = classifyAttachEnding(this.endingProbe.toString("utf8"));
    if (ending !== null) return describeAttachEnding(ending);
    const printedMissing = plainLines(this.startupProbe.toString("utf8")).includes(herdrNotInstalledSentinel);
    if (printedMissing) return new HerdrNotInstalledError(this.config.host).message;
    if (this.exitCode !== null && this.exitCode !== 0) {
      return "Herdr could not attach to this agent. It may have exited or changed identity.";
    }
    return null;
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.clear();
    const reason = this.endingReason();
    this.channel = null;
    this.client?.end();
    this.client = null;
    this.sink.exit(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.clear();
    this.channel?.close();
    this.channel = null;
    this.client?.end();
    this.client = null;
  }
}
