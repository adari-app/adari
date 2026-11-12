// One host's herdr-core, followed live (the Swift client's
// CoreBackend.swift). On every connection (CoreSession reconnects):
// `events.subscribe` for the snapshot, the event channel credited as it is
// read, every event applied (CoreModel), Herdr App's layout documents read
// after subscribing and again on a `doc` event or `missed` ("Subscribe before
// reading", herdr-core schema/README.md "Documents"), the machines this core
// added read now and then. A skipped `seq` takes a fresh snapshot; 45 s
// without an event or a heartbeat (one comes every 15 s) is a lost line: the
// connection is closed and CoreSession makes a new one.

import { CoreFrames, CoreLineSplitter } from "./core-frames";
import { coreJSONString, jsonArray, jsonU64, member, tryParseCoreJSON, type CoreJSON } from "./core-json";
import type { CoreConnection, CoreHello } from "./core-connection";
import { CoreLayoutDocument, CoreModel } from "./core-model";
import { projectCore, sameProjection, type CoreProjection } from "./core-projection";
import { CoreSession, CoreSessionError } from "./core-session";
import { coreMachineOf, decodeCoreMachineView, decodeCoreSubscribeResult, parseCoreNotification, type CoreMachineView, type CoreSubscribeResult, type CoreTerminal } from "./core-wire";
import type { CoreSessionPublication } from "./core-session-finder";
import type { CoreFoundSession } from "./wire";

export type CoreFollowerChange =
  /** The terminals, a document or a machine changed: read `snapshot()` again. */
  | { readonly kind: "changed" }
  /** The line to the core went (why); the next connection sends `changed`. */
  | { readonly kind: "lost"; readonly reason: string };

export class CoreFollowerError extends Error {
  constructor(
    readonly kind: "unavailable" | "closed",
    reason = "The connection to herdr-core was closed",
  ) {
    super(reason);
    this.name = "CoreFollowerError";
  }
}

export interface CoreFollowerOptions {
  /** Silence that counts as a lost line (the README's heartbeat is 15 s). */
  readonly heartbeatSilenceSeconds?: number;
  /** How often the silence is checked. */
  readonly watchdogIntervalSeconds?: number;
  /** How often the machines this core added are read. */
  readonly machinePollSeconds?: number;
  /** How long `snapshot()` waits for a first snapshot. */
  readonly snapshotWaitSeconds?: number;
}

/** What this core shows now, without waiting. */
export type CoreAvailability =
  /** The live subscription's view. */
  | { readonly kind: "live"; readonly projection: CoreProjection }
  /** No live subscription (why); `last` is the last view with every terminal marked unreachable, null when there never was one. */
  | { readonly kind: "waiting"; readonly last: CoreProjection | null; readonly why: string | null }
  /** It cannot work on this host (no herdr-core, a newer generation...). */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "closed" };

interface SnapshotWaiter {
  readonly resolve: (projection: CoreProjection) => void;
  readonly reject: (error: unknown) => void;
  timer: NodeJS.Timeout | null;
}

export class CoreFollower {
  private readonly heartbeatSilence: number;
  private readonly watchdogInterval: number;
  private readonly machinePoll: number;
  private readonly snapshotWait: number;
  private model: CoreModel | null = null;
  private hello: CoreHello | null = null;
  private documents = new Map<string, CoreLayoutDocument>();
  private machines = new Map<string, CoreMachineView>();
  /** Sessions found by folder (CoreSessionFinder), and the process start verified for each. */
  private readonly sessions = new Map<string, CoreFoundSession>();
  private readonly generations = new Map<string, string>();
  private current: CoreProjection | null = null;
  /** The last projection a live subscription gave, kept through a drop. */
  lastProjection: CoreProjection | null = null;
  private live: CoreConnection | null = null;
  private lastHeard = Date.now();
  private started = false;
  private following: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(change: CoreFollowerChange) => void>();
  private readonly snapshotWaiters = new Set<SnapshotWaiter>();
  private lastFailure: string | null = null;
  private closedForGood = false;
  /** Connections followed so far (the backend's epoch). */
  private connectionNumber = 0;
  private liveNumber: number | null = null;

  constructor(
    readonly session: CoreSession,
    options: CoreFollowerOptions = {},
  ) {
    this.heartbeatSilence = options.heartbeatSilenceSeconds ?? 45;
    this.watchdogInterval = options.watchdogIntervalSeconds ?? 5;
    this.machinePoll = options.machinePollSeconds ?? 30;
    this.snapshotWait = options.snapshotWaitSeconds ?? 20;
  }

  /** Starts following the core (once). */
  start(): void {
    if (this.started || this.closedForGood) return;
    this.started = true;
    this.session.start();
    // One connection at a time, in order (Swift's `for await connection in session.connections()`).
    this.unsubscribe = this.session.onConnection((connection) => {
      this.following = this.following.then(() => this.followAndMourn(connection));
    });
  }

  close(): void {
    if (this.closedForGood) return;
    this.closedForGood = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session.close();
    this.live = null;
    this.liveNumber = null;
    this.current = null;
    this.failSnapshotWaiters(new CoreFollowerError("closed"));
    this.listeners.clear();
  }

  get isClosed(): boolean {
    return this.closedForGood;
  }

  // MARK: - Reading

  /**
   * The core's terminals in the app's types, from the live subscription. Waits for the first snapshot of a
   * connection in progress; throws why there is none (a refusal, a failed attempt, no answer in time).
   */
  async snapshot(): Promise<CoreProjection> {
    if (this.current !== null) return this.current;
    if (this.closedForGood) throw new CoreFollowerError("closed");
    this.start();
    // Throws the attempt's error (or a refusal) rather than waiting through backoff.
    await this.session.connection();
    if (this.current !== null) return this.current;
    if (this.closedForGood) throw new CoreFollowerError("closed");
    return new Promise<CoreProjection>((resolve, reject) => {
      const waiter: SnapshotWaiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (!this.snapshotWaiters.delete(waiter)) return;
        reject(new CoreFollowerError("unavailable", this.lastFailure ?? "herdr-core gave no snapshot in time"));
      }, this.snapshotWait * 1000);
      this.snapshotWaiters.add(waiter);
    });
  }

  availability(): CoreAvailability {
    if (this.closedForGood) return { kind: "closed" };
    if (this.current !== null) return { kind: "live", projection: this.current };
    const state = this.session.state;
    if (state.kind === "refused") return { kind: "refused", reason: state.reason };
    if (this.model === null) return { kind: "waiting", last: null, why: this.lastFailure };
    const down = projectCore({
      model: this.model,
      documents: this.documents,
      machineName: this.hello?.core.name ?? "",
      version: this.hello?.version ?? "",
      machines: this.machines,
      sessions: this.sessions,
      generations: this.generations,
      lineDown: this.lastFailure ?? "herdr-core is reconnecting",
    });
    return { kind: "waiting", last: down, why: this.lastFailure };
  }

  /** Looks for herdr-core again when it was not there; a refusal waiting cannot change stays. True when a lookup started. */
  rediscover(): boolean {
    if (this.closedForGood) return false;
    this.start();
    return this.session.rediscover();
  }

  /** The live connection (for calls and attach streams). */
  async connection(): Promise<CoreConnection> {
    if (this.closedForGood) throw new CoreFollowerError("closed");
    this.start();
    if (this.live !== null && !this.live.isClosed) return this.live;
    return this.session.connection();
  }

  /** The live connection now, if any (never waits). */
  get liveConnection(): CoreConnection | null {
    return this.live !== null && !this.live.isClosed ? this.live : null;
  }

  /** The number of the connection followed now (null: none): a new number for each connection. */
  get epoch(): number | null {
    return this.liveConnection === null ? null : this.liveNumber;
  }

  /** A terminal as the live subscription has it. */
  terminal(address: string): CoreTerminal | undefined {
    return this.model?.terminal(address);
  }

  /** The herdr-app layout document as last read for a machine (undefined: this one). */
  layoutDocument(machine?: string): CoreLayoutDocument | undefined {
    return this.documents.get(machine ?? "");
  }

  /** The terminals now (live subscription only). */
  get terminals(): readonly CoreTerminal[] {
    return this.model?.terminals ?? [];
  }

  /** What this core calls itself. */
  get machineName(): string | undefined {
    return this.hello?.core.name;
  }

  /** The projection now, live only (never waits). */
  get projection(): CoreProjection | null {
    return this.current;
  }

  /** Changes from now on. Returns the unsubscribe. */
  changes(listener: (change: CoreFollowerChange) => void): () => void {
    if (this.closedForGood) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * As the Swift client's CoreBackend.setSession: a session
   * found for a terminal by its folder (or none), applied only inside `publication.apply`: when no newer snapshot
   * was delivered than the one it was decided on and the terminal still runs the run it was found for, with the
   * process start the finder verified. The change is synchronous and short; the view is published after it.
   * False: not applied (what the core shows stays).
   */
  setSession(publication: CoreSessionPublication, address: string): boolean {
    let changed = false;
    const applied = publication.apply(this.model?.terminal(address), () => {
      const { session, generation } = publication;
      changed = coreJSONString(this.sessions.get(address) ?? null) !== coreJSONString(session) || (this.generations.get(address) ?? null) !== generation;
      if (session === null) this.sessions.delete(address);
      else this.sessions.set(address, session);
      if (generation === null) this.generations.delete(address);
      else this.generations.set(address, generation);
    });
    if (changed && applied) this.publish();
    return applied;
  }

  // MARK: - Following

  private async followAndMourn(connection: CoreConnection): Promise<void> {
    if (this.closedForGood) return;
    await this.follow(connection);
    if (this.closedForGood) return;
    const reason = connection.isClosed ? (await connection.closed()).description : "the subscription ended";
    if (this.live === connection) {
      this.live = null;
      this.liveNumber = null;
    }
    this.current = null;
    this.lastFailure = reason;
    this.notify({ kind: "lost", reason });
  }

  private async follow(connection: CoreConnection): Promise<void> {
    this.live = connection;
    this.connectionNumber += 1;
    this.liveNumber = this.connectionNumber;
    this.hello = connection.hello;
    const watchdog = setInterval(() => {
      if (Date.now() - this.lastHeard > this.heartbeatSilence * 1000) {
        clearInterval(watchdog);
        connection.close(`no event or heartbeat for ${Math.trunc(this.heartbeatSilence)} seconds`);
      }
    }, this.watchdogInterval * 1000);
    let polling = false;
    const poller = setInterval(() => {
      if (connection.isClosed || polling) return;
      polling = true;
      const before = coreJSONString(Object.fromEntries(this.machines));
      void this.readMachines(connection)
        .then(() => {
          if (!this.closedForGood && coreJSONString(Object.fromEntries(this.machines)) !== before) this.publish();
        })
        .finally(() => {
          polling = false;
        });
    }, this.machinePoll * 1000);
    try {
      while (!this.closedForGood && !connection.isClosed) {
        const resync = await this.subscribeOnce(connection);
        if (!resync) return;
      }
    } finally {
      clearInterval(watchdog);
      clearInterval(poller);
    }
  }

  /** One subscription: snapshot, then events until the stream ends. Returns true when a fresh snapshot is needed (a gap, the core closed it). */
  private async subscribeOnce(connection: CoreConnection): Promise<boolean> {
    let result: CoreSubscribeResult;
    try {
      result = await connection.callAs("events.subscribe", {}, (value) => decodeCoreSubscribeResult(value));
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      this.failSnapshotWaiters(new CoreFollowerError("unavailable", this.lastFailure));
      connection.close(`events.subscribe failed: ${this.lastFailure}`);
      return false;
    }
    const channel = result.channel;
    if (channel === undefined) {
      connection.close("events.subscribe gave no channel on a framed connection");
      return false;
    }
    // Credit is for bytes read, below, and nothing else: the stream's own 256 KiB start is
    // its window.
    const stream = connection.stream(channel);
    this.model = CoreModel.fromSnapshot(result);
    this.lastHeard = Date.now();
    await this.readDocuments(connection, null);
    await this.readMachines(connection);
    if (this.closedForGood) return false;
    this.publish();

    const lines = new CoreLineSplitter();
    let resync = false;
    for (;;) {
      const item = await stream.take();
      if (item === null) break;
      if (this.closedForGood) return false;
      if (item.kind === "resize") continue;
      if (item.kind === "lost") return false;
      if (item.kind === "closed") {
        resync = true;
        break;
      }
      this.lastHeard = Date.now();
      let parsed: Uint8Array[];
      try {
        parsed = lines.push(item.bytes);
      } catch {
        resync = true;
        break;
      }
      connection.send(CoreFrames.credit(channel, Math.min(item.bytes.length, 0xffffffff)));
      let changed = false;
      const documentMachines = new Set<string>();
      let everything = false;
      let gap = false;
      for (const line of parsed) {
        if (line.length === 0) continue;
        const json = tryParseCoreJSON(line);
        const note = json === undefined ? null : parseCoreNotification(json);
        const model = this.model;
        if (note === null || model === null) continue;
        const outcome = model.apply(note);
        if (outcome.kind === "applied") changed = changed || outcome.changed !== undefined;
        else if (outcome.kind === "gap") {
          gap = true;
          break;
        } else if (outcome.kind === "replaced") {
          changed = true;
          everything = true;
        } else if (outcome.kind === "document" && outcome.name === CoreLayoutDocument.documentName) {
          documentMachines.add(outcome.machine ?? "");
        }
      }
      if (gap) {
        resync = true;
        break;
      }
      if (everything) {
        await this.readDocuments(connection, null);
        await this.readMachines(connection);
      } else if (documentMachines.size > 0) {
        await this.readDocuments(connection, documentMachines);
        changed = true;
      }
      if (this.closedForGood) return false;
      if (changed || everything) this.publish();
    }
    connection.forget(channel);
    if (resync && !connection.isClosed) {
      connection.send(CoreFrames.close(channel));
      return true;
    }
    return false;
  }

  /**
   * Reads `herdr-app` here and on each machine named (null: here and every machine with terminals in the model).
   * A machine whose read fails keeps no document: its terminals group under it.
   */
  private async readDocuments(connection: CoreConnection, wanted: ReadonlySet<string> | null): Promise<void> {
    const targets = new Set(wanted ?? [""]);
    if (wanted === null) {
      for (const terminal of this.model?.terminals ?? []) {
        const machine = coreMachineOf(terminal.address);
        if (machine !== undefined) targets.add(machine);
      }
    }
    for (const machine of [...targets].sort()) {
      const params: Record<string, CoreJSON> = { name: CoreLayoutDocument.documentName };
      if (machine !== "") params["on"] = machine;
      try {
        const result = await connection.call("doc.get", params);
        this.documents.set(machine, CoreLayoutDocument.from(member(result, "value"), jsonU64(member(result, "version")) ?? 0));
      } catch {
        this.documents.delete(machine);
      }
    }
  }

  private async readMachines(connection: CoreConnection): Promise<void> {
    if (!connection.hello.methods.includes("machine.list")) return;
    let result: CoreJSON;
    try {
      result = await connection.call("machine.list");
    } catch {
      return;
    }
    const found = new Map<string, CoreMachineView>();
    for (const machine of jsonArray(member(result, "machines")) ?? []) {
      try {
        const view = decodeCoreMachineView(machine);
        found.set(view.name, view);
      } catch {
        // Skipped: not a MachineView.
      }
    }
    this.machines = found;
  }

  // MARK: - Publishing

  private publish(): void {
    const model = this.model;
    if (model === null || this.closedForGood) return;
    const projection = projectCore({
      model,
      documents: this.documents,
      machineName: this.hello?.core.name ?? "",
      version: this.hello?.version ?? "",
      machines: this.machines,
      sessions: this.sessions,
      generations: this.generations,
    });
    const changed = !sameProjection(projection, this.current);
    this.current = projection;
    this.lastProjection = projection;
    this.lastFailure = null;
    const waiting = [...this.snapshotWaiters];
    this.snapshotWaiters.clear();
    for (const waiter of waiting) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.resolve(projection);
    }
    if (changed) this.notify({ kind: "changed" });
  }

  private notify(change: CoreFollowerChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private failSnapshotWaiters(error: unknown): void {
    const waiting = [...this.snapshotWaiters];
    this.snapshotWaiters.clear();
    for (const waiter of waiting) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

/** Whether the error is a refusal of the core's session (it cannot work on this host). */
export function isCoreRefusal(error: unknown): error is CoreSessionError {
  return error instanceof CoreSessionError && error.kind === "refused";
}
