// One host's finder for herdr-core Claude and Codex panes whose argv names no
// session, the iPhone app's (HerdrKit CorePaneSession.swift:
// CoreObservationClock, CoreSessionPublication, CoreSessionFinder) ported rule
// for rule:
// - every snapshot the app delivers (HostRegistry, as it applies it) is
//   numbered there, synchronously, in delivery order (`clock.next()`); one
//   older than a snapshot already delivered is dropped, never made the newest;
// - one pass at a time; a newer delivery makes an older pass moot, also
//   mid-pass, before anything is handed over;
// - each pane's session is looked up by the rule (shared/chat/core-pane-session.ts)
//   with the one read-only lookup (shared/chat/core-folder-lookup.ts) on the
//   host's existing read-only exec, its answer proved by the transcript's records;
// - a found session held is checked against the agent process's start on
//   every snapshot (epoch seconds, the same in any time zone): another process
//   under the pid is a new run, one that cannot be verified is taken back;
// - what is found goes to the core (CoreFollower.setSession) as a publication
//   fenced to the snapshot it was decided on and the run it was found for,
//   checked where the core's session changes; it carries the folder it was
//   proved in, and readers take it only there (shownCoreSession);
// - a pane no longer bound by folder has what it was given taken back.
// When the app cannot prove the transcript belongs to the pane's current
// agent run, it refuses (no Chat) rather than binds.

import type { ReadOnlyCommandRunner } from "../../shared/changes/reader";
import {
  coreFolderCommand,
  coreFolderOutputLimit,
  coreGenerationCommand,
  coreGenerationOutputLimit,
  isCoreGeneration,
  makeCoreFolderRef,
  parseCoreFolderOutput,
  parseCoreGenerationOutput,
  transcriptSessionID,
  type CoreEarlierSession,
  type CoreFolderRef,
  type CoreFolderResult,
} from "../../shared/chat/core-folder-lookup";
import { coreFolderKind, coreLookup, corePaneAddress, coreRefusalKind, isAmbiguousSession, type CoreRuleAgent, type CoreRulePane } from "../../shared/chat/core-pane-session";
import { isCoreID } from "../../shared/core-ids";
import { CorePaneRuns, type CorePaneRun } from "./core-projection";
import type { CoreTerminal } from "./core-wire";
import type { CoreFoundSession } from "./wire";

/**
 * The order snapshots were delivered in. The app numbers each one where it is delivered
 * (`next()`, synchronously, in that order) before the finder takes it, so neither promise scheduling nor the order
 * passes start in decides which snapshot is the newest.
 */
export class CoreObservationClock {
  private newest = 0;

  /** Numbers the next delivered snapshot. */
  next(): number {
    this.newest += 1;
    return this.newest;
  }

  /** The newest number delivered. */
  get latest(): number {
    return this.newest;
  }

  /** Notes `number` as delivered; false when a newer one was (an older number is never made the newest). */
  note(number: number): boolean {
    if (number < this.newest) return false;
    this.newest = number;
    return true;
  }

  /** Runs `change` only while `number` is the newest delivered (`change` must not use the clock). */
  whileNewest(number: number, change: () => void): boolean {
    if (number !== this.newest) return false;
    change();
    return true;
  }
}

/**
 * One change the finder hands a host for a terminal: the session (null: none), the
 * agent process's start it verified for it, the run it was decided for, and the snapshot it was decided on.
 */
export class CoreSessionPublication {
  constructor(
    readonly session: CoreFoundSession | null,
    /** The process start verified; null with no session. */
    readonly generation: string | null,
    /** The run it was found (or refused) for; null with no session. */
    readonly run: CorePaneRun | null,
    readonly observation: number,
    private readonly clock: CoreObservationClock,
  ) {}

  /** No newer snapshot was delivered than the one it was decided on. */
  get isCurrent(): boolean {
    return this.clock.latest === this.observation;
  }

  /**
   * Runs `change` (the host's own change to what it shows for the terminal) only if, right then, no newer
   * snapshot was delivered and, for a session, `terminal` still runs the run it was decided for. True: applied.
   */
  apply(terminal: CoreTerminal | undefined, change: () => void): boolean {
    if (this.session !== null) {
      const run = this.run;
      if (run === null || terminal === undefined) return false;
      const now = CorePaneRuns.of(terminal, run.kind);
      if (now === undefined || !CorePaneRuns.same(now, run)) return false;
    }
    return this.clock.whileNewest(this.observation, change);
  }
}

/** What the finder reads of a host's herdr-core and hands it (CoreFollower; tests: a fake). */
export interface CoreSessionHost {
  /** The terminal as the live subscription has it. */
  terminal(address: string): CoreTerminal | undefined | Promise<CoreTerminal | undefined>;
  /** Applies `publication` through `publication.apply` where the session changes. False: not applied. */
  setSession(publication: CoreSessionPublication, address: string): boolean | Promise<boolean>;
}

/**
 * One core folder lookup on the Mac, its answer read strictly; null when the agent's process is gone or the answer
 * was not one the lookup gives. `coreProcessGeneration`: the process's start alone, for a session held.
 */
export interface CoreTranscriptLocating {
  locateCore(ref: CoreFolderRef, earlier: readonly CoreEarlierSession[]): Promise<CoreFolderResult | null>;
  coreProcessGeneration(pid: number): Promise<string | null>;
}

/** The lookup on a host's existing read-only exec (SshTranscriptReader.runReadOnlyCommand: its deadline; the output caps here). */
export function coreTranscriptLocator(runner: () => ReadOnlyCommandRunner | null): CoreTranscriptLocating {
  const run = (command: string, limit: number): Promise<string> => {
    const commands = runner();
    if (commands === null) return Promise.reject(new Error("no read-only command connection"));
    return commands.runReadOnlyCommand(command, limit);
  };
  return {
    async locateCore(ref, earlier) {
      const command = coreFolderCommand(ref, earlier);
      return command === null ? null : parseCoreFolderOutput(await run(command, coreFolderOutputLimit), ref);
    },
    async coreProcessGeneration(pid) {
      const command = coreGenerationCommand(pid);
      return command === null ? null : parseCoreGenerationOutput(await run(command, coreGenerationOutputLimit));
    },
  };
}

/** A session found for one run of one pane: kept per pane, so a later run never takes it up. */
export interface CoreFound {
  readonly paneID: string;
  /** The run it was found for: its key, then the process's start (`key:generation`). */
  readonly run: string;
  /** Its session UUID, lower-case. */
  readonly session: string;
}

export function coreFound(paneID: string, run: string, session: string): CoreFound {
  return { paneID, run, session: session.toLowerCase() };
}

interface Entry {
  readonly run: CorePaneRun;
  /** The process's start, as a lookup or a check last read it. */
  generation: string | null;
  /** The folder its lookup is for. */
  folder: string | null;
  /** The lookup it last made (its folder and every session skipped), or the refusal's. */
  lookupKey: string | null;
  /** What it handed the core for this run. */
  given: CoreFoundSession | null;
  /** The lookup the session it gave was proved by. */
  givenKey: string | null;
  /** Trips in the current cycle. */
  attempts: number;
  /** The completed turn the session it found was looked up at. */
  foundAtTurn: string | null;
  /** The completed turn whose refresh cycle is running. */
  refreshTurn: string | null;
}

const newEntry = (run: CorePaneRun): Entry => ({
  run,
  generation: null,
  folder: null,
  lookupKey: null,
  given: null,
  givenKey: null,
  attempts: 0,
  foundAtTurn: null,
  refreshTurn: null,
});

/** What a session or refusal given for this run carries. */
const markerOf = (entry: Entry): string => (entry.generation === null ? CorePaneRuns.key(entry.run) : CorePaneRuns.key(entry.run) + ":" + entry.generation);

function sameSession(a: CoreFoundSession | null, b: CoreFoundSession | null): boolean {
  if (a === null || b === null) return a === b;
  return a.source === b.source && a.agent === b.agent && a.kind === b.kind && a.value === b.value && a.foundBy === b.foundBy && a.foundIn === b.foundIn;
}

/** The agent of a machine's snapshot, as the finder reads it (wire AgentInfo). */
export interface CoreFinderAgent extends CoreRuleAgent {
  readonly turn?: number | bigint;
  readonly completionSeq?: number | bigint;
}

/** The pane's latest completed turn (a found session is looked at again once another ends: a new session in the run, `/clear`). */
function completedTurn(paneID: string, agents: readonly CoreFinderAgent[]): string {
  const agent = agents.find((candidate) => candidate.paneID === paneID);
  if (agent === undefined) return "0";
  const value = agent.completionSeq ?? agent.turn ?? 0;
  return value < 0 ? "0" : String(value);
}

export class CoreSessionFinder {
  /** At most this many lookups per cycle (a new lookup, or once a session was found, each completed turn's refresh). */
  static readonly maxNotFoundRetries = 120;
  /** Found sessions kept per pane. */
  static readonly maxFoundPerPane = 16;

  private readonly entries = new Map<string, Entry>();
  private readonly history = new Map<string, CoreFound[]>();
  /** One pass at a time, in the order they asked. */
  private queue: Promise<void> = Promise.resolve();
  /** The newest snapshot a pass ran for. */
  private accepted = 0;
  private closed = false;

  constructor(
    private readonly host: CoreSessionHost,
    private readonly reader: CoreTranscriptLocating,
    readonly clock: CoreObservationClock = new CoreObservationClock(),
  ) {}

  /**
   * Takes in one delivered snapshot (the machine's agents and panes, TUI and core), with the sessions earlier runs
   * of these panes were given (`earlier`). `sequence`: its number in delivery order (`clock.next()` where it was
   * delivered); one older than a snapshot already delivered is dropped. Undefined: numbered as it enters. Returns
   * the sessions it found now (each once).
   */
  async observe(
    agents: readonly CoreFinderAgent[],
    panes: readonly CoreRulePane[],
    options: { readonly earlier?: readonly CoreFound[]; readonly sequence?: number } = {},
  ): Promise<CoreFound[]> {
    if (this.closed) return [];
    let mine: number;
    if (options.sequence !== undefined) {
      if (!this.clock.note(options.sequence)) return [];
      mine = options.sequence;
    } else {
      mine = this.clock.next();
    }
    const release = await this.acquire();
    try {
      for (const found of options.earlier ?? []) this.remember(found);
      if (this.closed || !this.isCurrent(mine) || mine <= this.accepted) return [];
      this.accepted = mine;
      return await this.pass(agents, panes, mine);
    } finally {
      release();
    }
  }

  /** Nothing more is looked up or handed over. */
  close(): void {
    this.closed = true;
  }

  /** What it handed the core for `address` now (tests). */
  given(address: string): CoreFoundSession | null {
    return this.entries.get(address)?.given ?? null;
  }

  private isCurrent(observation: number): boolean {
    return this.clock.latest === observation;
  }

  // MARK: - One snapshot

  private async pass(agents: readonly CoreFinderAgent[], panes: readonly CoreRulePane[], observation: number): Promise<CoreFound[]> {
    const found: CoreFound[] = [];
    const bound = new Set<string>();
    const paneIDs: string[] = [];
    for (const id of [...agents.map((agent) => agent.paneID), ...panes.filter((pane) => pane.agent !== undefined && pane.agent !== "").map((pane) => pane.paneID)]) {
      if (isCoreID(id) && !paneIDs.includes(id)) paneIDs.push(id);
    }
    for (const paneID of paneIDs) {
      // A newer snapshot was delivered: it decides.
      if (!this.isCurrent(observation)) return found;
      const address = corePaneAddress(paneID);
      if (address === undefined) continue;
      const lookup = coreLookup(paneID, agents, panes);
      const kind = coreFolderKind(paneID, agents, panes);
      if (lookup.kind === "none" || kind === undefined) continue;
      const terminal = await this.host.terminal(address);
      if (!this.isCurrent(observation)) return found;
      const run = terminal === undefined ? undefined : CorePaneRuns.of(terminal, kind);
      if (run === undefined) continue;
      bound.add(address);
      const entry = this.entries.get(address);
      if (entry === undefined || !CorePaneRuns.same(entry.run, run)) {
        // A new run, or a pane this finder never proved: what the last run was given goes, and so does a found
        // session the core shows that no lookup here proved. Taken back before the entry changes.
        const supplied = agents.some((agent) => agent.paneID === paneID && agent.coreFound !== undefined);
        if ((entry?.given ?? null) !== null || supplied) {
          if (!(await this.publish(null, null, null, address, observation))) return found;
        }
        this.entries.set(address, newEntry(run));
      }
      if (lookup.kind === "refused") {
        const current = this.entries.get(address);
        const marker = current === undefined ? CorePaneRuns.key(run) : markerOf(current);
        if (await this.give({ ...lookup.session, foundBy: marker }, address, observation)) {
          const now = this.entries.get(address);
          if (now !== undefined) {
            now.lookupKey = "refused";
            now.folder = null;
          }
        }
      } else {
        const note = await this.look(paneID, address, lookup.folder, lookup.excluding, run, completedTurn(paneID, agents), observation);
        if (note !== null) found.push(note);
      }
    }
    if (!this.isCurrent(observation)) return found;
    // Panes no longer bound by folder: what they were given is taken back.
    for (const [address, entry] of Array.from(this.entries)) {
      if (bound.has(address)) continue;
      if (entry.given !== null) {
        if (!(await this.publish(null, null, null, address, observation))) return found;
      }
      this.entries.delete(address);
    }
    return found;
  }

  /**
   * The folder lookup of one run: at most `maxNotFoundRetries` trips per cycle; once a session is found, again only
   * when a turn ends or what it skips changes, its process start checked on every snapshot.
   */
  private async look(
    paneID: string,
    address: string,
    folder: string,
    peers: readonly string[],
    run: CorePaneRun,
    turn: string,
    observation: number,
  ): Promise<CoreFound | null> {
    const format = run.kind === "claude" ? "claude" : "codex";
    // A found session held stands only for the process start verified now, a cached success
    // too. Another process under this pid is a new run (a fresh lookup); one that cannot be verified has its
    // session taken back until a lookup proves it again.
    const held = this.entries.get(address)?.given ?? null;
    if (held !== null && !isAmbiguousSession(held)) {
      let current: string | null;
      try {
        current = await this.reader.coreProcessGeneration(run.pid);
      } catch {
        current = null;
      }
      const entry = this.entries.get(address);
      if (!this.isCurrent(observation) || entry === undefined || !CorePaneRuns.same(entry.run, run)) return null;
      if (current === null || current !== entry.generation) {
        if (!(await this.give(null, address, observation))) return null;
        if (current !== null) {
          const fresh = newEntry(run);
          fresh.generation = current;
          this.entries.set(address, fresh);
        } else {
          const now = this.entries.get(address);
          if (now !== undefined) now.foundAtTurn = null;
        }
      }
    }
    const { skipped, earlier } = this.skips(paneID, run, peers);
    const ref = makeCoreFolderRef(format, folder, skipped, run.pid);
    if (ref === null) {
      // More to skip than a lookup takes: refused, as the rule refuses.
      const current = this.entries.get(address);
      const refusal: CoreFoundSession = {
        source: `herdr:${run.kind}`,
        agent: run.kind,
        kind: coreRefusalKind(format),
        value: folder,
        foundBy: current === undefined ? CorePaneRuns.key(run) : markerOf(current),
      };
      if (await this.give(refusal, address, observation)) {
        const now = this.entries.get(address);
        if (now !== undefined) {
          now.lookupKey = "refused";
          now.folder = null;
        }
      }
      return null;
    }
    const stored = this.entries.get(address);
    if (stored === undefined) return null;
    let entry: Entry = { ...stored };
    const key = CoreSessionFinder.lookupKey(folder, ref.excluding, earlier, entry.generation);
    if (entry.lookupKey !== key) {
      // A new cycle: a session found for another folder, one skipped now, or a refusal, goes before the
      // new lookup is awaited.
      const given = entry.given;
      if (given !== null && (entry.folder !== folder || isAmbiguousSession(given) || !CoreSessionFinder.allowed(given.value, ref.excluding, earlier, entry.generation))) {
        if (!(await this.give(null, address, observation))) return null;
        const cleared = this.entries.get(address);
        if (cleared === undefined) return null;
        entry = { ...cleared };
      }
      entry.lookupKey = key;
      entry.folder = folder;
      entry.attempts = 0;
      entry.foundAtTurn = null;
      entry.refreshTurn = null;
    } else if (entry.given !== null && entry.foundAtTurn !== null) {
      // Found this turn: it stands. A completed turn since starts one refresh cycle.
      if (entry.foundAtTurn === turn) return null;
      if (entry.refreshTurn !== turn) {
        entry.refreshTurn = turn;
        entry.attempts = 0;
      }
    }
    // The cap holds whether or not a session is kept.
    if (entry.attempts >= CoreSessionFinder.maxNotFoundRetries) {
      this.entries.set(address, entry);
      return null;
    }
    entry.attempts += 1;
    this.entries.set(address, entry);
    let result: CoreFolderResult | null;
    try {
      result = await this.reader.locateCore(ref, earlier);
    } catch {
      // Unread (the line, a timeout): a session stands only while what proved it is unchanged.
      const now = this.entries.get(address);
      if (this.isCurrent(observation) && now !== undefined && CorePaneRuns.same(now.run, run) && now.given !== null && now.givenKey !== key) {
        await this.give(null, address, observation);
      }
      return null;
    }
    // A newer snapshot, or the run or the lookup changed meanwhile: the next pass decides.
    const after = this.entries.get(address);
    if (!this.isCurrent(observation) || after === undefined || !CorePaneRuns.same(after.run, run) || after.lookupKey !== key) return null;
    if (result === null) {
      // The agent's process is gone, or the answer proved nothing.
      await this.give(null, address, observation);
      return null;
    }
    if (after.generation !== null && after.generation !== result.generation) {
      // Another process under the same pid: a new run; what the last one had goes.
      if (after.given !== null) {
        if (!(await this.give(null, address, observation))) return null;
      }
      const fresh = newEntry(run);
      fresh.folder = folder;
      fresh.lookupKey = key;
      fresh.attempts = 1;
      this.entries.set(address, fresh);
    }
    const settled = CoreSessionFinder.lookupKey(folder, ref.excluding, earlier, result.generation);
    const proved = this.entries.get(address);
    if (proved !== undefined) {
      proved.generation = result.generation;
      // What it skips for this very process (its own finds never count).
      proved.lookupKey = settled;
    }
    const id = result.path === null ? null : (transcriptSessionID(result.path, format)?.toLowerCase() ?? null);
    if (id === null || !CoreSessionFinder.allowed(id, ref.excluding, earlier, result.generation)) {
      // Nothing written since the agent started (yet), or the one it found is gone.
      await this.give(null, address, observation);
      return null;
    }
    const runKey = CorePaneRuns.key(run) + ":" + result.generation;
    // With the folder it was proved in.
    const session: CoreFoundSession = { source: `herdr:${run.kind}`, agent: run.kind, kind: "id", value: id, foundBy: runKey, foundIn: folder };
    if (!(await this.give(session, address, observation))) return null;
    // Nothing is recorded for a snapshot a newer one replaced meanwhile.
    const recorded = this.entries.get(address);
    if (!this.isCurrent(observation) || recorded === undefined || !CorePaneRuns.same(recorded.run, run)) return null;
    recorded.foundAtTurn = turn;
    recorded.givenKey = settled;
    const note = coreFound(paneID, runKey, id);
    return this.remember(note) ? note : null;
  }

  /**
   * Hands `session` to the core for `address` when it is not what it has, with the process start verified for it
   * and its run. Never from a snapshot a newer one replaced; the host applies it only if none was delivered by the
   * time it changes. False when not handed: the core keeps what it had, and so does the entry.
   */
  private async give(session: CoreFoundSession | null, address: string, observation: number): Promise<boolean> {
    const entry = this.entries.get(address);
    if (entry === undefined) return false;
    if (sameSession(entry.given, session)) return true;
    if (!this.isCurrent(observation)) return false;
    const before = { run: entry.run, given: entry.given, givenKey: entry.givenKey, generation: entry.generation };
    entry.given = session;
    if (session === null) entry.givenKey = null;
    const applied = await this.publish(session, session === null ? null : before.generation, session === null ? null : before.run, address, observation);
    const now = this.entries.get(address);
    if (!applied && now !== undefined && CorePaneRuns.same(now.run, before.run)) {
      now.given = before.given;
      now.givenKey = before.givenKey;
    }
    return applied;
  }

  /** One change for the host, fenced by the snapshot it was decided on. */
  private async publish(session: CoreFoundSession | null, generation: string | null, run: CorePaneRun | null, address: string, observation: number): Promise<boolean> {
    return await this.host.setSession(new CoreSessionPublication(session, generation, run, observation, this.clock), address);
  }

  /** A lookup's inputs: the folder, what it skips, and the sessions found under this pid for another process than `generation`. */
  static lookupKey(folder: string, skipped: readonly string[], earlier: readonly CoreEarlierSession[], generation: string | null): string {
    const others = earlier.filter((item) => item.generation !== generation).map((item) => `${item.generation}:${item.id}`);
    return [folder, ...skipped, ...others].join("\n");
  }

  /** Whether `id` may be this run's: not skipped, and when found under this terminal and pid before, found for this very process. */
  static allowed(value: string, skipped: readonly string[], earlier: readonly CoreEarlierSession[], generation: string | null): boolean {
    const id = value.toLowerCase();
    if (skipped.includes(id)) return false;
    const before = earlier.filter((item) => item.id === id);
    if (before.length === 0) return true;
    if (generation === null) return false;
    return before.some((item) => item.generation === generation);
  }

  // MARK: - Earlier runs

  /**
   * What a lookup of `run` skips besides `peers`: the sessions found for the pane's other runs and those found
   * without a process start, always, and (`earlier`) those found under this terminal and
   * pid, skipped unless the process is still the one they were found for (a pid given again is another run).
   */
  skips(paneID: string, run: CorePaneRun, peers: readonly string[]): { skipped: string[]; earlier: CoreEarlierSession[] } {
    const earlier: CoreEarlierSession[] = [];
    const other = new Set<string>();
    const key = CorePaneRuns.key(run);
    for (const entry of this.history.get(paneID) ?? []) {
      const generation = entry.run.startsWith(key + ":") ? entry.run.slice(key.length + 1) : "";
      if (isCoreGeneration(generation)) {
        if (!earlier.some((item) => item.generation === generation && item.id === entry.session)) earlier.push({ generation, id: entry.session });
      } else {
        other.add(entry.session);
      }
    }
    const skipped = new Set([...peers.map((id) => id.toLowerCase()), ...other]);
    const order = (a: CoreEarlierSession, b: CoreEarlierSession): number =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0;
    return { skipped: [...skipped].sort(), earlier: earlier.sort(order) };
  }

  /** Keeps `found` (the latest `maxFoundPerPane` per pane); false when it was kept already. */
  private remember(found: CoreFound): boolean {
    const list = this.history.get(found.paneID) ?? [];
    if (list.some((item) => item.run === found.run && item.session === found.session)) return false;
    list.push(found);
    this.history.set(found.paneID, list.slice(-CoreSessionFinder.maxFoundPerPane));
    return true;
  }

  // MARK: - One at a time

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => done);
    return previous.then(() => release);
  }
}
