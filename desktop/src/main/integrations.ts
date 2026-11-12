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

import type { HostView } from "../shared/ipc-contract";
import {
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
} from "../shared/integrations";
import type { IntegrationHerdr } from "./herdr/backend";
import { errorWords } from "./herdr/new-agent";
import { DecodingError } from "./herdr/decode";
import type { IntegrationInfo } from "./herdr/wire";
import { agentKind, agentSession, runsAgent } from "../shared/send-binding";

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

/** What New agent holds from before it sends anything until its agent started (startToken). */
export interface IntegrationStartToken {
  readonly hostId: string;
  readonly target: string;
  /** The read it was taken on (opaque outside this file). */
  readonly read: unknown;
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
  ) {}

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
      };
      this.reads.set(host.id, read);
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
        // for is not its answer (nor its silence); the snapshot on the new one starts a read of its own.
        if (sentOn !== read.epoch) return;
        if (list === null) {
          // Never answered on this connection: nothing shown, never asked again on it. One that answered before keeps
          // what it said (a later read that fails is not Herdr refusing the call).
          if (read.status === "reading") {
            read.status = "unanswered";
            read.again = false;
            return;
          }
          continue;
        }
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
