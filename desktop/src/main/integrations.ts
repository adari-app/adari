// Herdr's agent integrations per machine (src/shared/integrations.ts says why
// Chat needs them).
//
// Read: `integration.list` once per machine and connection, when the machine
// answers on a new connection or a new command connection (its epoch;
// HostRegistry's onChange tells this), and again when Settings opens or after
// an install; a machine whose Herdr does not answer it (an error, a reply that
// does not decode: herdr-core, an older Herdr) shows nothing and is never
// asked again on that connection. The list is kept with the entry, connection
// and command connection it was read on (HostView.integrations: only while
// those are the machine's now); a new one starts with nothing (no unanswered
// mark, no outcome), and a reply that comes for an earlier one is dropped.
//
// Install: on a click only. It is bound to the machine's entry, connection and
// command connection as the window showed them; a machine removed, offline or
// reconnected since refuses with a note and sends nothing, as does a target
// Herdr did not list as missing or old on that connection. One install per
// machine and target at a time. Herdr's messages are kept as bounded lines, its
// failure in words without its code; the list is read again after it.
//
// Update all (updateAll): Settings' one click for a machine whose list says
// some of its shown integrations are out of date. Each goes through install()
// above, one after the other, with that binding and those rules; a missing one
// is never installed by it; one refusal or failure does not stop the rest, a
// changed machine stops it; the list is read again at the end.
//
// Install before a start (beforeStart): New agent, about to start an agent of
// a shown kind, asks first. With Settings' switch on (kept in
// userData/integration-settings.json; missing or unreadable: on), a read on the
// machine's entry, connection and command connection as New agent began on it,
// and that target listed as not installed or out of date there, the install
// goes through install() with that binding (so its refusals and its one
// install per machine and target hold: a second New agent of the kind waits on
// the first's install, it never sends another). Herdr's `available` is not
// asked: Herdr installs a hook whose agent its server does not see. New agent
// waits at most autoInstallWaitMs and starts the agent whatever came of it; the
// answer is its one line (installed, updated, Herdr's failure words, or still
// under way). The switch off, a list not read on that connection, a machine
// with no integration calls (herdr-core), a kind Adari shows no integration
// for, or a target listed current or not listed: nothing is sent and there is
// no line.
//
// Not read: a machine with the calls whose list was not read on its
// connection (Herdr did not answer it, or the answer came on another command
// connection and was dropped) is marked so (HostView.integrationsUnread) for
// Chat's line and its Retry (retry), which asks the list again on that same
// connection only.
//
// Started-after marks:
// - New agent asks for a start token (startToken) before anything is
//   sent; it holds when this read lists the kind's integration as current, or
//   an Install of it succeeded on this read. When the agent started (the same
//   kind, on the same read, still so), its pane goes on the read's
//   `startedAfter`: its agent started with the integration in place. That is
//   the only fact used. Herdr reports no process start time, and a pane
//   started any other way (in its terminal, before Adari read the list, on
//   another connection) is not listed, so Chat keeps the steps for it.
// - A list asked after an Installed outcome that still says not installed or
//   out of date wins: the outcome goes (Install or Update shows again) and so
//   do the target's `startedAfter` panes. A read that was already out when the
//   install ended does not count.
//
// Hook review: a pane whose screen showed Codex's hook review
// (HostView.startScreens, on this read's entry, connection and command
// connection) loses its started-after mark: Codex runs on without the hook if
// the user chose Continue without trusting, and the screen going says nothing
// about which choice they made. It goes on the read's `hookReviewed` instead
// (Chat's conservative line) until its agent's session is named (the hook
// reports): then a pane New agent started gets its started-after mark back. A
// pane gone, or no longer running that kind, leaves `hookReviewed` with no
// mark back.
//
// That bookkeeping settles in one pass and is the same on the next pass over
// the same panes and screens. A screen mark counts only for a pane that runs
// that kind in the terminal it was read in with no session named
// (StartScreenService may still hold its old mark when the session appears:
// main.ts tells this service first); a reviewed pane whose terminal changed
// goes with no mark back; past the 64-entry cap a newly reviewed pane leaves
// startedAfter but is not kept (no pane is evicted to make room, so the same
// screens never evict and re-add); the machine is told only when the marks
// changed.

import { closeSync, fchmodSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { HostView } from "../shared/ipc-contract";
import {
  autoInstallTexts,
  decodeAutoInstall,
  integrationActionOf,
  integrationMessageLines,
  integrationName,
  integrationStates,
  integrationTargetOf,
  integrationTexts,
  shownIntegrations,
  type HostIntegrations,
  type IntegrationAction,
  type IntegrationBinding,
  type IntegrationInstallReply,
  type IntegrationItem,
  type IntegrationOutcome,
  type IntegrationState,
  type IntegrationUpdateAllReply,
  updateAllTargets,
} from "../shared/integrations";
import type { IntegrationHerdr } from "./herdr/backend";
import { errorWords } from "./herdr/new-agent";
import { DecodingError } from "./herdr/decode";
import type { IntegrationInfo } from "./herdr/wire";
import { agentKind, agentSession, runsAgent } from "../shared/send-binding";
import { integrationInstallTimeoutMs } from "./herdr/client";

/**
 * How long New agent waits for its install before it starts the agent anyway: Herdr's own
 * install timeout (the client's) and 5 seconds for the list read after it.
 */
export const autoInstallWaitMs = integrationInstallTimeoutMs + 5_000;

/** Where Settings' install-before-start switch is kept. */
export interface IntegrationSettingsStore {
  load(): boolean;
  save(on: boolean): void;
}

export function memoryIntegrationSettings(initial = true): IntegrationSettingsStore {
  let kept = initial;
  return {
    load: () => kept,
    save: (on) => {
      kept = on;
    },
  };
}

/** `{"autoInstall": …}` in `file` (userData/integration-settings.json, beside notify-settings.json); missing or unreadable: on. */
export function fileIntegrationSettings(file: string, log: (line: string) => void = () => undefined): IntegrationSettingsStore {
  let kept: unknown = null;
  try {
    kept = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // None yet, or not readable: on.
  }
  return {
    load: () => decodeAutoInstall(kept),
    save: (on) => {
      kept = { autoInstall: on };
      try {
        // Private even over an old temporary file: its mode is set to 0600 before anything is written or renamed
        // (writeFileSync's mode applies only to a file it creates).
        const fd = openSync(`${file}.tmp`, "w", 0o600);
        try {
          fchmodSync(fd, 0o600);
          writeFileSync(fd, `${JSON.stringify(kept)}\n`);
        } finally {
          closeSync(fd);
        }
        renameSync(`${file}.tmp`, file);
      } catch (error) {
        log(`could not keep the integration settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** A timer New agent's wait rings at (tests give their own). */
export type AutoInstallAlarm = (ms: number) => { readonly rang: Promise<void>; cancel(): void };

const liveAlarm: AutoInstallAlarm = (ms) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rang = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return { rang, cancel: () => clearTimeout(timer) };
};

/** What the service needs of the machines (HostRegistry has it). */
export interface IntegrationHosts {
  list(): readonly HostView[];
  backend(id: string): { integrations?(): IntegrationHerdr } | null;
  /** The machine's entry and the command connection a request sent now goes on (null: not listed). */
  connectionIdentity(id: string): { readonly incarnation: number; readonly epoch: number | null } | null;
  /** The machine's connection while it answers (null: it does not). */
  connection(id: string): number | null;
  name(id: string): string | null;
  /** The machine's integrations as read now (null: none to show). */
  setIntegrations(id: string, integrations: HostIntegrations | null): void;
  /** The connection the machine's list was not read on (null: none); absent in older fakes. */
  setIntegrationsUnread?(id: string, unread: IntegrationBinding | null): void;
}

/** The shown targets of Herdr's list, in shownIntegrations' order (an unknown state or target is left out). */
export function shownItems(list: readonly IntegrationInfo[]): IntegrationItem[] {
  const items: IntegrationItem[] = [];
  for (const shown of shownIntegrations) {
    const info = list.find((entry) => entry.target === shown.target);
    if (info === undefined || !integrationStates.includes(info.state as IntegrationState)) continue;
    items.push({ target: shown.target, kind: shown.kind, name: integrationName(shown.target), state: info.state as IntegrationState, available: info.available });
  }
  return items;
}

interface Read {
  readonly hostId: string;
  readonly incarnation: number;
  readonly connection: number;
  /** The command connection (HostView.epoch) it stands for. */
  readonly epoch: number | null;
  /** "reading" (the first read out), "read" (Herdr answered), "unanswered" (never asked again on this connection). */
  status: "reading" | "read" | "unanswered";
  items: readonly IntegrationItem[];
  readonly outcomes: Map<string, IntegrationOutcome>;
  /** A read out now, and one more asked for while it was (Settings opened, an install ended). */
  reading: Promise<void> | null;
  again: boolean;
  /** The install under way per target. */
  readonly installs: Map<string, Promise<IntegrationInstallReply>>;
  /** List requests sent on this read so far, and per target the count when its outcome was set. */
  requests: number;
  readonly outcomeAt: Map<string, number>;
  /** Per target, the panes New agent started on this read with the integration in place. */
  readonly startedAfter: Map<string, string[]>;
  /**
   * Per target, the panes whose screen showed the agent's hook review on this read
   * and whose session is not named yet; `startedAfter`: it was on startedAfter then (it goes back once the session is).
   */
  readonly hookReviewed: Map<string, HookReviewed[]>;
  /** Settings' Update all under way on this read (a second click waits on it). */
  updatingAll: Promise<IntegrationUpdateAllReply> | null;
}

/** A pane that showed the hook review, in the terminal it showed it in. */
interface HookReviewed {
  readonly paneId: string;
  readonly terminalID: string;
  readonly startedAfter: boolean;
}

/** The read's started-after and hook-review marks, to tell whether a pass changed them. */
function hookMarks(read: Read): string {
  return JSON.stringify([[...read.startedAfter], [...read.hookReviewed]]);
}

/**
 * What New agent hears of its integration step as it runs (nothing here changes
 * what is sent): `began` once an install or update is sent, or one under way is joined (`joined`), before the wait;
 * `ended` when the wait ended, `stalled` when its bound ran out first.
 */
export interface IntegrationStepObserver {
  began?(step: { readonly action: IntegrationAction; readonly joined: boolean; readonly name: string }): void;
  ended?(stalled: boolean): void;
}

/** What New agent holds from before it sends anything until its agent started (startToken). */
export interface IntegrationStartToken {
  readonly hostId: string;
  readonly target: string;
  /** The read it was taken on (opaque outside this file). */
  readonly read: unknown;
}

/** The read stands for the entry, connection and command connection `binding` names. */
function sameBinding(read: Read, binding: IntegrationBinding): boolean {
  return read.incarnation === binding.incarnation && read.connection === binding.connection && read.epoch === binding.epoch;
}

/** At most this many started-after panes are kept per target and read (the oldest go first). */
export const maxStartedAfter = 64;

export class IntegrationService {
  private readonly reads = new Map<string, Read>();
  /** Lists asked so far (the tests count them). */
  asked = 0;

  constructor(
    private readonly hosts: IntegrationHosts,
    /** Takes the saved secrets out of a text before it is kept for the page. */
    private readonly redact: (text: string) => string = (text) => text,
    /** Settings' install-before-start switch (on unless kept off). */
    private readonly settings: IntegrationSettingsStore = memoryIntegrationSettings(),
    /** New agent's wait for its install (a test's timer; live: setTimeout). */
    private readonly alarm: AutoInstallAlarm = liveAlarm,
  ) {}

  /** Settings' "Install Herdr's integrations when I start an agent". */
  autoInstall(): boolean {
    return this.settings.load();
  }

  setAutoInstall(on: boolean): boolean {
    this.settings.save(on);
    return this.settings.load();
  }

  /** The machines changed: each connected one with Herdr's calls is read once on its connection and command connection now. */
  hostsChanged(): void {
    const listed = this.hosts.list();
    for (const id of this.reads.keys()) if (!listed.some((host) => host.id === id)) this.reads.delete(id);
    for (const host of listed) {
      const connection = host.state === "connected" ? (host.connection ?? 0) : 0;
      const held = this.reads.get(host.id);
      if (connection === 0 || host.incarnation === undefined) continue;
      const epoch = host.epoch ?? null;
      if (held !== undefined && held.incarnation === host.incarnation && held.connection === connection && held.epoch === epoch) {
        this.noteHookReviews(held, host);
        continue;
      }
      const calls = this.hosts.backend(host.id)?.integrations?.();
      if (calls === undefined) {
        this.reads.delete(host.id);
        continue;
      }
      const read: Read = {
        hostId: host.id,
        incarnation: host.incarnation,
        connection,
        epoch,
        status: "reading",
        items: [],
        outcomes: new Map(),
        reading: null,
        again: false,
        installs: new Map(),
        requests: 0,
        outcomeAt: new Map(),
        startedAfter: new Map(),
        hookReviewed: new Map(),
        updatingAll: null,
      };
      this.reads.set(host.id, read);
      this.markUnread(read, false);
      void this.read(read);
    }
  }

  /**
   * The machine's panes showing the hook review (on this read's entry, connection
   * and command connection) leave startedAfter for hookReviewed; a hookReviewed pane whose agent's session is named
   * now goes back to startedAfter if it was there; one gone, in another terminal or running another kind goes.
   * Idempotent for the same topology and screens, published only on a change.
   */
  private noteHookReviews(read: Read, host: HostView): void {
    const before = hookMarks(read);
    const topology = host.topology;
    /** The pane runs `target`'s agent now in `terminalID`, with no session named (topology unknown: as read). */
    const waits = (paneId: string, target: string, terminalID: string): boolean => {
      if (topology === null) return true;
      const pane = topology.panes.find((candidate) => candidate.paneID === paneId) ?? null;
      const agent = topology.agents.find((candidate) => candidate.paneID === paneId) ?? null;
      if (pane === null || !runsAgent(pane, agent) || integrationTargetOf(agentKind(agent, pane)) !== target) return false;
      return pane.terminalID === terminalID && agentSession(agent) === null;
    };
    // The reviewed panes first: a session named gives the started-after mark back; gone, another terminal or kind: none.
    if (topology !== null) {
      for (const [target, reviewed] of read.hookReviewed) {
        const kept: HookReviewed[] = [];
        for (const entry of reviewed) {
          if (waits(entry.paneId, target, entry.terminalID)) {
            kept.push(entry);
            continue;
          }
          const pane = topology.panes.find((candidate) => candidate.paneID === entry.paneId) ?? null;
          const agent = topology.agents.find((candidate) => candidate.paneID === entry.paneId) ?? null;
          const reports =
            pane !== null &&
            runsAgent(pane, agent) &&
            integrationTargetOf(agentKind(agent, pane)) === target &&
            pane.terminalID === entry.terminalID &&
            agentSession(agent) !== null;
          if (reports && entry.startedAfter) {
            const after = read.startedAfter.get(target) ?? [];
            if (!after.includes(entry.paneId)) read.startedAfter.set(target, [...after, entry.paneId].slice(-maxStartedAfter));
          }
        }
        if (kept.length === 0) read.hookReviewed.delete(target);
        else read.hookReviewed.set(target, kept);
      }
    }
    // Then the screens: only a pane still waiting in the terminal its screen was read in.
    const screens = host.startScreens;
    if (screens !== undefined && screens.incarnation === read.incarnation && screens.connection === read.connection && screens.epoch === read.epoch) {
      for (const screen of screens.panes) {
        if (screen.kind !== "codexHookReview") continue;
        const target = integrationTargetOf("codex");
        if (target === null || !waits(screen.paneId, target, screen.terminalID)) continue;
        const reviewed = read.hookReviewed.get(target) ?? [];
        if (reviewed.some((entry) => entry.paneId === screen.paneId)) continue;
        const after = read.startedAfter.get(target) ?? [];
        const wasAfter = after.includes(screen.paneId);
        if (wasAfter) {
          const rest = after.filter((paneId) => paneId !== screen.paneId);
          if (rest.length === 0) read.startedAfter.delete(target);
          else read.startedAfter.set(target, rest);
        }
        // Full: it loses the promise all the same, and no kept pane is evicted for it.
        if (reviewed.length >= maxStartedAfter) continue;
        read.hookReviewed.set(target, [...reviewed, { paneId: screen.paneId, terminalID: screen.terminalID, startedAfter: wasAfter }]);
      }
    }
    if (hookMarks(read) !== before) this.publish(read);
  }

  /** Settings opened: every machine that answered on its connection is read again (one that did not is not asked). */
  refresh(): Promise<void> {
    return Promise.all([...this.reads.values()].filter((read) => read.status === "read").map((read) => this.read(read))).then(() => undefined);
  }

  /**
   * Captures only (integrations-captures.ts, the demo's Herdr): forgets what was read and clicked on the machine, so the
   * next change reads it again from scratch. Never called on a real connection.
   */
  forgetForCapture(hostId: string): void {
    this.reads.delete(hostId);
    this.hosts.setIntegrations(hostId, null);
    this.hostsChanged();
  }

  /** The machine's integrations as the page sees them now (null: none to show). */
  view(hostId: string): HostIntegrations | null {
    const read = this.reads.get(hostId);
    if (read === undefined || read.status !== "read") return null;
    return {
      incarnation: read.incarnation,
      connection: read.connection,
      epoch: read.epoch,
      items: read.items,
      outcomes: Object.fromEntries(read.outcomes),
      ...(read.startedAfter.size === 0 ? {} : { startedAfter: Object.fromEntries([...read.startedAfter].map(([target, panes]) => [target, [...panes]])) }),
      ...(read.hookReviewed.size === 0 ? {} : { hookReviewed: Object.fromEntries([...read.hookReviewed].map(([target, panes]) => [target, panes.map((entry) => entry.paneId)])) }),
      ...(read.updatingAll === null ? {} : { updatingAll: true as const }),
    };
  }

  /** The target's integration is in place on `read`: listed current, or installed by a click on it. */
  private inPlace(read: Read, target: string): boolean {
    if (read.status !== "read") return false;
    const item = read.items.find((candidate) => candidate.target === target);
    return item?.state === "current" || read.outcomes.get(target)?.phase === "installed";
  }

  /**
   * New agent for `kind` on the machine is about to send its first request. A token when the
   * kind's integration is in place on the machine's read now (null: not known to be, so the pane gets no mark).
   */
  startToken(hostId: string, kind: string): IntegrationStartToken | null {
    const target = integrationTargetOf(kind);
    const read = this.reads.get(hostId);
    if (target === null || read === undefined || !this.inPlace(read, target)) return null;
    return { hostId, target, read };
  }

  /**
   * New agent's agent of `kind` started in `paneId` (Herdr reported it, or the command was
   * typed and Herdr then reported the kind there). Marked only on the token's own read, for its own target, while
   * the integration is still in place there.
   */
  agentStarted(token: IntegrationStartToken, paneId: string, kind: string): void {
    const read = token.read as Read;
    if (!this.current(read) || read.hostId !== token.hostId || integrationTargetOf(kind) !== token.target || !this.inPlace(read, token.target)) return;
    // A pane that showed the hook review gets its mark back only with its session.
    if ((read.hookReviewed.get(token.target) ?? []).some((entry) => entry.paneId === paneId)) return;
    const panes = read.startedAfter.get(token.target) ?? [];
    if (panes.includes(paneId)) return;
    read.startedAfter.set(token.target, [...panes, paneId].slice(-maxStartedAfter));
    this.publish(read);
  }

  private current(read: Read): boolean {
    return this.reads.get(read.hostId) === read;
  }

  /** One list read on `read`'s connection; one asked for while one is out goes after it. */
  private read(read: Read): Promise<void> {
    if (read.reading !== null) {
      read.again = true;
      return read.reading;
    }
    const calls = this.hosts.backend(read.hostId)?.integrations?.();
    if (calls === undefined || read.status === "unanswered") return Promise.resolve();
    read.reading = (async () => {
      do {
        read.again = false;
        this.asked += 1;
        read.requests += 1;
        const serial = read.requests;
        let list: IntegrationInfo[] | null = null;
        let reply: Promise<IntegrationInfo[]> | null = null;
        try {
          reply = calls.integrationList();
        } catch {
          reply = null;
        }
        // The command connection the request went on (asked after it went: a backend picks or opens one then).
        const sentOn = this.hosts.connectionIdentity(read.hostId)?.epoch ?? null;
        try {
          list = reply === null ? null : await reply;
        } catch {
          list = null;
        }
        if (!this.current(read)) return;
        // An answer on another command connection than the one this read stands
        // for is not its answer (nor its silence); the snapshot on the new one starts a read of its own. Until then a
        // read that never answered is marked not read (Chat's Retry asks it again).
        if (sentOn !== read.epoch) {
          if (read.status !== "read") this.markUnread(read, true);
          return;
        }
        if (list === null) {
          // Never answered on this connection: nothing shown, not asked again on it unless Chat's Retry asks. One
          // that answered before keeps what it said (a later read that fails is not Herdr refusing the call).
          if (read.status === "reading") {
            read.status = "unanswered";
            read.again = false;
            this.markUnread(read, true);
            return;
          }
          continue;
        }
        if (read.status !== "read") this.markUnread(read, false);
        read.status = "read";
        read.items = shownItems(list);
        // Asked after the outcome was set and still missing or old: it wins.
        // A list asked before the install ended says nothing about it (its installed outcome and panes stay).
        for (const item of read.items) {
          if (item.state === "current") continue;
          const installed = read.outcomes.get(item.target)?.phase === "installed";
          if (installed && (read.outcomeAt.get(item.target) ?? serial) >= serial) continue;
          if (installed) {
            read.outcomes.delete(item.target);
            read.outcomeAt.delete(item.target);
          }
          read.startedAfter.delete(item.target);
          read.hookReviewed.delete(item.target);
        }
        this.publish(read);
      } while (read.again && this.current(read));
    })().finally(() => {
      read.reading = null;
    });
    return read.reading;
  }

  private publish(read: Read): void {
    if (this.current(read)) this.hosts.setIntegrations(read.hostId, this.view(read.hostId));
  }

  /** The read's connection marked as not read (or no longer), for Chat's line and Retry. */
  private markUnread(read: Read, unread: boolean): void {
    if (!this.current(read)) return;
    this.hosts.setIntegrationsUnread?.(read.hostId, unread ? { incarnation: read.incarnation, connection: read.connection, epoch: read.epoch } : null);
  }

  /**
   * Chat's Retry: the machine's list asked again, only on the entry, connection and command
   * connection the window showed as not read, and only while it is still not read there. Anything else sends nothing.
   */
  retry(hostId: string, binding: IntegrationBinding): Promise<void> {
    const read = this.reads.get(hostId);
    if (read === undefined || read.status === "read" || !sameBinding(read, binding)) return Promise.resolve();
    const identity = this.hosts.connectionIdentity(hostId);
    if (identity === null || identity.incarnation !== binding.incarnation || identity.epoch !== binding.epoch || this.hosts.connection(hostId) !== binding.connection) {
      return Promise.resolve();
    }
    if (this.hosts.backend(hostId)?.integrations?.() === undefined) return Promise.resolve();
    read.status = "reading";
    this.markUnread(read, false);
    return this.read(read);
  }

  /**
   * New agent is about to start an agent of `kind` on the machine it began on (`binding`, taken
   * before anything was awaited): Herdr's integration for it installed or updated first when the switch is on and this
   * connection's list says it is missing or old (or one is under way: this waits on it). Waits at most
   * autoInstallWaitMs and never throws; the line New agent says (null: nothing was asked, or nothing was sent).
   */
  async beforeStart(hostId: string, kind: string, binding: IntegrationBinding, observer?: IntegrationStepObserver): Promise<string | null> {
    if (kind === "shell" || !this.settings.load()) return null;
    const target = integrationTargetOf(kind);
    const read = this.reads.get(hostId);
    if (target === null || read === undefined || read.status !== "read" || !sameBinding(read, binding)) return null;
    const item = read.items.find((candidate) => candidate.target === target);
    if (item === undefined) return null;
    const running = read.installs.get(target);
    const action = integrationActionOf(item.state);
    if (running === undefined && action === null) return null;
    // With none running, an install that already succeeded on this connection stands (inPlace), even when the list
    // after it could not be read: no second install. A later list read and saying missing or old clears it (read()).
    if (running === undefined && this.inPlace(read, target)) return null;
    const machine = this.hosts.name(hostId) ?? "the machine";
    let work: Promise<IntegrationInstallReply>;
    try {
      work = running ?? this.install(hostId, target, binding);
    } catch {
      return null;
    }
    // What is under way now: the running one's action (joined), else the one just sent.
    const under = read.outcomes.get(target)?.action ?? action ?? "install";
    try {
      observer?.began?.({ action: under, joined: running !== undefined, name: item.name });
    } catch {
      // An observer's failure changes nothing here.
    }
    const alarm = this.alarm(autoInstallWaitMs);
    let reply: IntegrationInstallReply | "late";
    try {
      reply = await Promise.race([work.catch((): IntegrationInstallReply => ({ sent: false, note: "" })), alarm.rang.then(() => "late" as const)]);
    } finally {
      alarm.cancel();
    }
    try {
      observer?.ended?.(reply === "late");
    } catch {
      // As above.
    }
    if (reply === "late") {
      const stalledUnder = read.outcomes.get(target)?.action ?? action ?? "install";
      return autoInstallTexts.stalled(item.name, stalledUnder, Math.round(autoInstallWaitMs / 1_000));
    }
    // Refused before anything went (the machine changed since New agent began): no line, the start's own rule says it.
    if (!reply.sent) return null;
    const outcome = reply.outcome;
    if (outcome.phase === "installed") return outcome.action === "update" ? autoInstallTexts.updated(item.name, machine) : autoInstallTexts.installed(item.name, machine);
    return outcome.text;
  }

  /**
   * The user's Install or Update on `target`, bound to the machine as the window showed it (`binding`). Nothing is sent
   * unless the machine is still listed, on that entry, connection and command connection, and Herdr listed the target
   * as not installed or out of date on it. A second click while one runs gets the first one's answer.
   */
  install(hostId: string, target: string, binding: IntegrationBinding): Promise<IntegrationInstallReply> {
    const refuse = (note: string): Promise<IntegrationInstallReply> => Promise.resolve({ sent: false, note });
    const backend = this.hosts.backend(hostId);
    const identity = this.hosts.connectionIdentity(hostId);
    if (backend === null || identity === null) return refuse(integrationTexts.removed);
    const machine = this.hosts.name(hostId) ?? "the machine";
    const connection = this.hosts.connection(hostId);
    if (connection === null) return refuse(integrationTexts.offline(machine));
    if (identity.incarnation !== binding.incarnation || connection !== binding.connection || identity.epoch !== binding.epoch) {
      return refuse(integrationTexts.connectionChanged(machine));
    }
    const read = this.reads.get(hostId);
    const calls = backend.integrations?.();
    if (calls === undefined) return refuse(integrationTexts.unavailable);
    if (read === undefined || read.status !== "read" || read.incarnation !== binding.incarnation || read.connection !== binding.connection || read.epoch !== binding.epoch) {
      return refuse(integrationTexts.connectionChanged(machine));
    }
    const item = read.items.find((candidate) => candidate.target === target);
    const action = item === undefined ? null : integrationActionOf(item.state);
    if (item === undefined || action === null) {
      const running = read.installs.get(target);
      return running ?? refuse(integrationTexts.notListed(machine));
    }
    const running = read.installs.get(target);
    if (running !== undefined) return running;
    const work = this.installNow(read, calls, item, action).finally(() => {
      if (read.installs.get(target) === work) read.installs.delete(target);
    });
    read.installs.set(target, work);
    return work;
  }

  /**
   * Settings' Update all on the machine, bound to it as the window showed it (`binding`): each target the list read on
   * that binding says is out of date (and Settings shows: updateAllTargets), one after the other, each through
   * install() with its own rules (nothing goes once the machine's entry, connection or command connection changed; a
   * target with an install under way, New agent's or a click's, is waited on, never sent twice; one listed current
   * by the list read after an earlier one is passed over). A missing integration is never installed here. A refusal
   * or a failure leaves its own row's words and the rest still go, except a refusal because the machine changed:
   * then nothing more is sent. The list is read again at the end. A second click while one runs gets its answer.
   */
  updateAll(hostId: string, binding: IntegrationBinding): Promise<IntegrationUpdateAllReply> {
    const read = this.reads.get(hostId);
    if (read === undefined || read.status !== "read" || !sameBinding(read, binding)) {
      const machine = this.hosts.name(hostId) ?? "the machine";
      return Promise.resolve({ results: [], note: this.hosts.backend(hostId) === null ? integrationTexts.removed : integrationTexts.connectionChanged(machine) });
    }
    if (read.updatingAll !== null) return read.updatingAll;
    // The targets as the list showed them at the click (missing ones are never among them).
    const targets = updateAllTargets(read.items);
    const work = (async (): Promise<IntegrationUpdateAllReply> => {
      const results: { target: string; reply: IntegrationInstallReply }[] = [];
      for (const target of targets) {
        if (!this.current(read)) break;
        // The list read after an earlier install (or New agent's) may say it is current now: nothing to send.
        const item = read.items.find((candidate) => candidate.target === target);
        if (item === undefined || (item.state !== "outdated" && !read.installs.has(target))) continue;
        let reply: IntegrationInstallReply;
        try {
          reply = await this.install(hostId, target, binding);
        } catch (error) {
          reply = { sent: false, note: integrationTexts.failed("update", errorWords(error)) };
        }
        results.push({ target, reply });
        // The machine changed since the click: nothing more is sent (install() refused it before anything went).
        if (!reply.sent && !this.bindingHolds(hostId, binding)) break;
      }
      // The list read again at the end, on the same read (a reconnect reads its own).
      if (this.current(read)) await this.read(read);
      return { results, note: null };
    })().finally(() => {
      read.updatingAll = null;
      this.publish(read);
    });
    read.updatingAll = work;
    this.publish(read);
    return work;
  }

  /** The machine is still on the entry, connection and command connection `binding` names. */
  private bindingHolds(hostId: string, binding: IntegrationBinding): boolean {
    const identity = this.hosts.connectionIdentity(hostId);
    return identity !== null && identity.incarnation === binding.incarnation && identity.epoch === binding.epoch && this.hosts.connection(hostId) === binding.connection;
  }

  private async installNow(read: Read, calls: IntegrationHerdr, item: IntegrationItem, action: IntegrationAction): Promise<IntegrationInstallReply> {
    const set = (outcome: IntegrationOutcome): IntegrationOutcome => {
      if (this.current(read)) {
        read.outcomes.set(item.target, outcome);
        read.outcomeAt.set(item.target, read.requests);
        this.publish(read);
      }
      return outcome;
    };
    set({ phase: "installing", text: integrationTexts.installing(item.name, action), messages: [], action });
    let outcome: IntegrationOutcome;
    try {
      const messages = await calls.integrationInstall(item.target);
      outcome = { phase: "installed", text: integrationTexts.installed(item.name), messages: integrationMessageLines(messages.map((line) => this.redact(line))), action };
    } catch (error) {
      // A reply not in Herdr's shape is a plain failure line (no path, no code).
      const text = error instanceof DecodingError ? integrationTexts.unreadable(action) : integrationTexts.failed(action, errorWords(error));
      outcome = { phase: "failed", text: this.redact(text), messages: [], action };
    }
    set(outcome);
    // The state after it, on the same connection (a reconnect since reads its own list).
    if (this.current(read)) await this.read(read);
    return { sent: true, outcome };
  }
}
