// A host's herdr-core, kept connected (the Swift client's
// CoreSession.swift). Cores restart (updates, crashes) and their programs
// survive, so a dropped link is reconnected with backoff; a refusal that
// waiting cannot change (no herdr-core, a newer generation, missing methods)
// stops it.

import { CoreConnection, CoreConnectionError, type CoreHello, type CoreLink } from "./core-connection";
import { CoreLinkError } from "./core-ssh";
import { AuthenticationFailedError } from "./errors";
import { HostKeyRejectedError, NewHostKeyError } from "./host-key-pinning";

/** The waits between attempts: doubling from `first` to `maximum` (seconds). */
export class CoreBackoff {
  static readonly standard = new CoreBackoff(1, 30);

  constructor(
    readonly first: number,
    readonly maximum: number,
  ) {}

  delay(failures: number): number {
    if (failures <= 0) return 0;
    const exponent = Math.min(failures - 1, 16);
    return Math.min(this.first * 2 ** exponent, this.maximum);
  }
}

export type CoreSessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected"; readonly hello: CoreHello }
  /** Waiting `seconds` before the next attempt, and why the last one ended. */
  | { readonly kind: "waiting"; readonly seconds: number; readonly reason: string }
  /** Not retried: why. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "closed" };

export class CoreSessionError extends Error {
  constructor(
    readonly kind: "refused" | "closed",
    reason = "The connection to herdr-core was closed",
  ) {
    super(reason);
    this.name = "CoreSessionError";
  }
}

export interface CoreSessionOptions {
  readonly backoff?: CoreBackoff;
  /** Seconds for hello (default 20). */
  readonly helloTimeoutSeconds?: number;
  /** Waits `seconds` (tests: a log). */
  readonly sleep?: (seconds: number) => Promise<void>;
  readonly makeLink: () => Promise<CoreLink> | CoreLink;
}

export class CoreSession {
  private stateNow: CoreSessionState = { kind: "idle" };
  private current: CoreConnection | null = null;
  /** The link of the attempt in flight (before its hello answered): closed with the session, so no SSH client outlives it. */
  private attempting: CoreLink | null = null;
  /** The running loop's number (null: none running). */
  private loop: number | null = null;
  private loops = 0;
  private waiters: { resolve: (connection: CoreConnection) => void; reject: (error: unknown) => void }[] = [];
  private readonly stateObservers = new Set<(state: CoreSessionState) => void>();
  private readonly connectionObservers = new Set<(connection: CoreConnection) => void>();
  private stopped = false;
  /**
   * The reconnect wait in progress, ended by close: each wait adds its own ending and
   * takes it out (and clears its timer) when either its time or close ends it, so nothing of a past wait stays.
   */
  private readonly stopWakers = new Set<() => void>();
  /**
   * The refusal is one the app may look past later: "no herdr-core here" (installing it
   * changes that), or, on the Mac, a host-key or sign-in refusal the machine's question can settle.
   */
  private recoverable: "absence" | "credentials" | null = null;
  private readonly backoff: CoreBackoff;
  private readonly sleep: ((seconds: number) => Promise<void>) | undefined;
  private readonly helloTimeoutSeconds: number;
  private readonly makeLink: () => Promise<CoreLink> | CoreLink;

  constructor(options: CoreSessionOptions) {
    this.backoff = options.backoff ?? CoreBackoff.standard;
    this.sleep = options.sleep;
    this.helloTimeoutSeconds = options.helloTimeoutSeconds ?? 20;
    this.makeLink = options.makeLink;
  }

  get state(): CoreSessionState {
    return this.stateNow;
  }

  /** The live connection now, if any (never waits). */
  get live(): CoreConnection | null {
    return this.current !== null && !this.current.isClosed ? this.current : null;
  }

  /** Starts keeping the core connected (once). */
  start(): void {
    if (this.loop !== null || this.stopped) return;
    this.loops += 1;
    const number = this.loops;
    this.loop = number;
    void this.run(number);
  }

  /** The live connection, waiting for the attempt in flight. Throws that attempt's error (never waits through a backoff), `refused`, or `closed`. */
  connection(): Promise<CoreConnection> {
    if (this.stopped) return Promise.reject(new CoreSessionError("closed"));
    if (this.stateNow.kind === "refused") return Promise.reject(new CoreSessionError("refused", this.stateNow.reason));
    const live = this.live;
    if (live !== null) return Promise.resolve(live);
    this.start();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Every state from now on (the current one first). Returns the unsubscribe. */
  onState(listener: (state: CoreSessionState) => void): () => void {
    listener(this.stateNow);
    if (this.stopped) return () => undefined;
    this.stateObservers.add(listener);
    return () => this.stateObservers.delete(listener);
  }

  /** Every connection made from now on (the current one first, if any). Returns the unsubscribe. */
  onConnection(listener: (connection: CoreConnection) => void): () => void {
    if (this.current !== null) listener(this.current);
    if (this.stopped) return () => undefined;
    this.connectionObservers.add(listener);
    return () => this.connectionObservers.delete(listener);
  }

  /** Looks for herdr-core again after a refusal it may look past (another refusal is final). True when a new lookup started. */
  rediscover(): boolean {
    if (this.stopped || this.recoverable === null || this.stateNow.kind !== "refused") return false;
    this.recoverable = null;
    this.loop = null;
    this.set({ kind: "idle" });
    this.start();
    return true;
  }

  /** Why the refusal now may be looked past by `rediscover()` (null: no refusal, or a final one). */
  get recoverableRefusal(): "absence" | "credentials" | null {
    return this.stateNow.kind === "refused" ? this.recoverable : null;
  }

  /** "No herdr-core on the host" (it may be installed later). */
  static isAbsence(error: unknown): boolean {
    return error instanceof CoreLinkError && error.fault.kind === "notInstalled";
  }

  /** A host-key or sign-in refusal: final for this loop; on the Mac the machine's own question can settle it. */
  static isCredentialRefusal(error: unknown): boolean {
    return error instanceof HostKeyRejectedError || error instanceof NewHostKeyError || error instanceof AuthenticationFailedError;
  }

  /** Stops reconnecting and closes the connection; everything waiting ends. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.loop = null;
    for (const wake of this.stopWakers) wake();
    const held = this.current;
    this.current = null;
    held?.close("closed by the app");
    const attempt = this.attempting;
    this.attempting = null;
    attempt?.close();
    this.failWaiters(new CoreSessionError("closed"));
    this.set({ kind: "closed" });
    this.stateObservers.clear();
    this.connectionObservers.clear();
  }

  /** Whether an error from opening the core cannot change by waiting. */
  static isPermanent(error: unknown): boolean {
    if (error instanceof CoreLinkError) return error.fault.kind !== "transport";
    if (error instanceof CoreConnectionError) {
      switch (error.fault.kind) {
        case "newerGeneration":
        case "olderGeneration":
        case "missingMethods":
        case "notFramed":
          return true;
        default:
          return false;
      }
    }
    return CoreSession.isCredentialRefusal(error);
  }

  static describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // MARK: - The loop

  private async run(number: number): Promise<void> {
    let failures = 0;
    let attempt = 0;
    const running = (): boolean => !this.stopped && this.loop === number;
    while (running()) {
      attempt += 1;
      this.set({ kind: "connecting", attempt });
      let reason: string;
      try {
        const link = await this.makeLink();
        if (!running()) {
          link.close();
          return;
        }
        this.attempting = link;
        let connection: CoreConnection;
        try {
          connection = await CoreConnection.open(link, { timeoutSeconds: this.helloTimeoutSeconds });
        } finally {
          if (this.attempting === link) this.attempting = null;
        }
        if (!running()) {
          connection.close();
          return;
        }
        this.current = connection;
        failures = 0;
        attempt = 0;
        this.set({ kind: "connected", hello: connection.hello });
        const ready = this.waiters.splice(0);
        for (const waiter of ready) waiter.resolve(connection);
        for (const observer of this.connectionObservers) observer(connection);
        const ended = await connection.closed();
        if (this.current === connection) this.current = null;
        // A peer that broke the framing (an unknown kind, a frame or line over its
        // limit) is refused for good, as at the opening: no other link is made to it. Losing the line is retried.
        if (ended.fault.kind === "protocolViolation") {
          if (!running()) return;
          this.recoverable = null;
          this.failWaiters(new CoreSessionError("refused", ended.description));
          this.set({ kind: "refused", reason: ended.description });
          return;
        }
        reason = ended.description;
      } catch (error) {
        if (!running()) return;
        this.failWaiters(error);
        if (CoreSession.isPermanent(error)) {
          this.recoverable = CoreSession.isAbsence(error) ? "absence" : CoreSession.isCredentialRefusal(error) ? "credentials" : null;
          this.set({ kind: "refused", reason: CoreSession.describe(error) });
          return;
        }
        reason = CoreSession.describe(error);
      }
      if (!running()) return;
      failures += 1;
      const delay = this.backoff.delay(failures);
      this.set({ kind: "waiting", seconds: delay, reason });
      await this.pause(delay);
    }
  }

  /** One reconnect wait: over when its time is up or the session closes, whichever is first; either way its timer and ending go. */
  private pause(seconds: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const end = (): void => {
        if (!this.stopWakers.delete(end)) return;
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      this.stopWakers.add(end);
      if (this.sleep === undefined) timer = setTimeout(end, seconds * 1000);
      else void this.sleep(seconds).then(end, end);
    });
  }

  private failWaiters(error: unknown): void {
    const failed = this.waiters.splice(0);
    for (const waiter of failed) waiter.reject(error);
  }

  private set(state: CoreSessionState): void {
    this.stateNow = state;
    for (const observer of this.stateObservers) observer(state);
  }
}
