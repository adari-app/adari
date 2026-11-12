// The main process's reads for an agent's start screen that waits for the
// person while Herdr reports the pane idle (src/shared/prompt/start-screen.ts:
// Codex's hook review).
//
// Which panes: on a connected machine, a pane running a kind whose start
// screen is known (Codex), with no session Herdr names (the screen comes
// before the first turn), not working and not blocked (a blocked pane is the
// needs-you card's: prompts.ts). Each is read (`pane.read`, its last 40 lines,
// through the per-pane gate main shares, never two reads of a pane at once)
// on sight and then every 2.5 s, for its first 3 minutes in sight, and for as
// long as the screen shows. A pane that never showed it in those 3 minutes is
// not read again until its terminal or agent changes. Nothing is ever written
// to a pane.
//
// What it gives: the machine's HostView.startScreens, the panes showing it,
// each with the terminal it was read in, bound to the entry, connection and
// command connection the reads went on. A read that crossed a reconnect, or a
// pane whose terminal or agent changed meanwhile, is dropped; a read that
// failed proves nothing and keeps what the last one said. The state goes when
// a read shows the screen gone, or the pane leaves the list (a session named,
// working, blocked, gone, another agent).
//
// Send guard: a Send to a Codex pane with no session checks the screen inside
// its own turn (sendGuard, used by send.ts inside sendBound's per-pane queue,
// after the fresh snapshot): one read of the pane
// through the same gate, refused when it shows the review, fails or crosses a
// reconnect; then, right before the text write and right before its Return,
// the latest read of the pane (the Send's own or any later one, the watch's
// too) must still show none. The cached mark at the IPC door is only an early
// refusal.
//
// What counts is the newest read of the pane that was asked for (the watch's
// or a Send's), not the newest one that answered: while a newer read is still out, or it failed or crossed a
// reconnect, an older clear answer allows no write and no Return. A Send waits
// for a newer read that is out (settle) before its last checks, which stay
// synchronous; one still out or unverified at a check refuses.
//
// Other start questions: the same watch and the same guard read Grok Build's,
// Cursor Agent's and Gemini CLI's own start questions (folder or workspace trust, Gemini's sign-in picker), by the same rule (a
// pane of the kind with no session Herdr names, not working, not blocked).
// Their reads take the pane's last 100 lines (Grok Build's question sits in
// the middle of a tall screen); Codex's stay at 40. Cursor Agent and Gemini CLI
// often never get a session Herdr names, so a Send to one reads its screen
// every time: one bounded read per Send. The guard also says which screen its
// newest read saw (shown), so the refusal names the question.

import type { HostView } from "../shared/ipc-contract";
import { PaneReadGate } from "../shared/chat/live-reader";
import { agentKind, agentSession, runsAgent } from "../shared/send-binding";
import { paneBlocked } from "../shared/prompt/view";
import { readStartScreenState, startScreenKinds, startScreenLines, type HostStartScreens, type PaneStartScreen, type StartScreenKind } from "../shared/prompt/start-screen";
import { paneReadKey } from "./chat/live-reads";
import type { SessionTopology } from "./herdr/wire";

/** What the service needs of the machines (HostRegistry has it). */
export interface StartScreenHosts {
  list(): readonly HostView[];
  /** The machine's backend: its `pane.read` (absent: it cannot read a pane). */
  backend(id: string): { paneText?(paneId: string, lines: number): Promise<string> } | null;
  /** The machine's entry and the command connection a request sent now goes on (null: not listed). */
  connectionIdentity(id: string): { readonly incarnation: number; readonly epoch: number | null } | null;
  /** The machine's connection while it answers (null: it does not). */
  connection(id: string): number | null;
  /** The machine's panes showing a start screen now (null: none). */
  setStartScreens(id: string, screens: HostStartScreens | null): void;
}

export interface StartScreenClock {
  now(): number;
  every(ms: number, tick: () => void): () => void;
}

export const realStartScreenClock: StartScreenClock = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

/** How often a pane in its window, or showing the screen, is read. */
export const startScreenReadMs = 2_500;
/** How long after a pane is first seen (its terminal and agent) it is read while the screen does not show. */
export const startScreenWindowMs = 3 * 60_000;

/** A pane the watch reads: a known kind (Codex, Grok Build, Cursor Agent, Gemini CLI), no session, not working, not blocked. */
export interface StartScreenPane {
  readonly paneId: string;
  readonly kind: string;
  readonly terminalID: string;
}

/** The panes of a snapshot whose start screen is read. */
export function startScreenPanes(topology: SessionTopology): StartScreenPane[] {
  return topology.panes.flatMap((pane) => {
    const agent = topology.agents.find((candidate) => candidate.paneID === pane.paneID) ?? null;
    const kind = agentKind(agent, pane);
    if (kind === null || !runsAgent(pane, agent) || !startScreenKinds.has(kind)) return [];
    if (agentSession(agent) !== null || paneBlocked(pane, agent)) return [];
    const status = agent?.agentStatus ?? pane.agentStatus;
    if (status === "working") return [];
    return [{ paneId: pane.paneID, kind, terminalID: pane.terminalID }];
  });
}

interface Entry {
  readonly identity: string;
  readonly kind: string;
  readonly terminalID: string;
  readonly firstSeenMs: number;
  lastReadMs: number | null;
  inFlight: boolean;
  shown: StartScreenKind | null;
}

/**
 * A Send's own check of the pane's screen (StartScreenService.sendGuard): `read`
 * after its queue and fresh snapshot, `clear` synchronously right before each write.
 */
export interface StartScreenGuard {
  /**
   * Reads the pane's last lines now through the shared per-pane gate: true when the read answered on the machine's
   * connection as it was, and shows no start screen for an agent of `kind` (the pane's terminal `terminalID`);
   * false when it shows one, failed, or the connection changed meanwhile.
   */
  read(kind: string, terminalID: string): Promise<boolean>;
  /**
   * Right before a write, nothing awaited: the read said none, and the newest read of the pane asked for since (any)
   * answered and still does (one still out, failed or unverified is not clear).
   */
  clear(): boolean;
  /**
   * Waits until no newer read of the pane is out (a few at most; reads nothing itself), so the last
   * synchronous checks see its answer. A read that never answers keeps the Send waiting as its own read would.
   */
  settle(): Promise<void>;
  /**
   * The start screen the newest answered read of the pane showed on this Send's connection and
   * terminal, else the one this Send's own read showed (null: none seen; a refusal then says the screen could not be
   * checked). Only names the refusal; never allows anything.
   */
  shown?(): StartScreenKind | null;
}

/**
 * The newest read of a pane that was asked for (the watch's or a Send's), by
 * the order the reads went: "out" while it has not answered, "failed" when it failed, crossed a reconnect or its pane
 * changed (it proves nothing), "answered" with what it showed.
 */
interface NewestRead {
  readonly serial: number;
  readonly identity: string;
  readonly terminalID: string;
  state: "out" | "failed" | "answered";
  shown: StartScreenKind | null;
  /** Settles when the read is done (never rejects). */
  readonly done: Promise<void>;
}

/** How many newer reads a Send's settle waits for, one after another, before its checks decide. */
const settleRounds = 4;

interface HostWatch {
  readonly incarnation: number;
  readonly connection: number;
  readonly epoch: number | null;
  readonly panes: Map<string, Entry>;
  /** What was last given to the registry. */
  published: string;
}

export class StartScreenService {
  private readonly hostsWatched = new Map<string, HostWatch>();
  private stopTimer: (() => void) | null = null;
  private busy = false;
  private again = false;
  /** Reads asked so far (the tests count them). */
  reads = 0;
  /** Per `host/pane`, the newest read asked for; `serial` counts reads in the order they went. */
  private readonly newest = new Map<string, NewestRead>();
  private serial = 0;

  constructor(
    private readonly hosts: StartScreenHosts,
    private readonly clock: StartScreenClock = realStartScreenClock,
    /** The per-pane read gate main shares with the needs-you card, Chat's live reads and Update ready. */
    private readonly gate: PaneReadGate = new PaneReadGate(),
  ) {}

  start(intervalMs = startScreenReadMs): void {
    this.stop();
    this.stopTimer = this.clock.every(intervalMs, () => this.hostsChanged());
    this.hostsChanged();
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }

  /** Whether the pane shows a start screen by the last reads on the machine's connection now. */
  shows(hostId: string, paneId: string): boolean {
    const watch = this.hostsWatched.get(hostId);
    return watch !== undefined && this.hosts.connection(hostId) === watch.connection && (watch.panes.get(paneId)?.shown ?? null) !== null;
  }

  /** The start screen the pane shows by the last reads on the machine's connection now (null: none). */
  showing(hostId: string, paneId: string): StartScreenKind | null {
    const watch = this.hostsWatched.get(hostId);
    if (watch === undefined || this.hosts.connection(hostId) !== watch.connection) return null;
    return watch.panes.get(paneId)?.shown ?? null;
  }

  /**
   * The check a Send to the pane makes inside its own turn (send.ts sendBoundNow,
   * for a pane of a kind whose start screen is read (Codex, Grok Build, Cursor Agent, Gemini CLI)
   * with no session). Reads only; never a key.
   */
  sendGuard(hostId: string, paneId: string): StartScreenGuard {
    const key = `${hostId}/${paneId}`;
    let asked: { readonly serial: number; readonly identity: string; readonly terminalID: string } | null = null;
    let none = false;
    /** What this Send's own read showed. */
    let ownShown: StartScreenKind | null = null;
    const settle = async (): Promise<void> => {
      for (let round = 0; round < settleRounds; round += 1) {
        const held = this.newest.get(key);
        if (held === undefined || held.state !== "out") return;
        await held.done;
      }
    };
    const clear = (): boolean => {
      if (!none || asked === null || this.identityNow(hostId) !== asked.identity) return false;
      if (this.shows(hostId, paneId)) return false;
      const last = this.newest.get(key);
      return (
        last !== undefined &&
        last.serial >= asked.serial &&
        last.state === "answered" &&
        last.identity === asked.identity &&
        last.terminalID === asked.terminalID &&
        last.shown === null
      );
    };
    const shown = (): StartScreenKind | null => {
      const last = this.newest.get(key);
      if (asked !== null && last !== undefined && last.state === "answered" && last.shown !== null && last.identity === asked.identity && last.terminalID === asked.terminalID) {
        return last.shown;
      }
      return ownShown;
    };
    return {
      read: async (kind, terminalID) => {
        none = false;
        ownShown = null;
        const backend = this.hosts.backend(hostId);
        const before = this.identityNow(hostId);
        if (backend?.paneText === undefined || before === null) return false;
        const paneText = backend.paneText.bind(backend);
        let finish!: () => void;
        const mine = this.asked(key, before, terminalID, new Promise<void>((done) => (finish = done)));
        asked = mine;
        let text: string | null;
        const lines = startScreenLines(kind);
        try {
          text = await this.gate.reading(paneReadKey(hostId, paneId), () => paneText(paneId, lines));
        } catch {
          text = null;
        }
        // A read whose bottom is a question cut above its title proves nothing, as a failed one.
        const state = text === null ? null : readStartScreenState(text, kind, lines);
        if (text === null || state === "unverified" || this.identityNow(hostId) !== before) {
          this.answered(mine, "failed", null);
          finish();
          return false;
        }
        const seen = state;
        ownShown = seen;
        this.answered(mine, "answered", seen);
        finish();
        // The watch's mark follows it (Chat and the sidebar show Needs you at once).
        const watch = this.hostsWatched.get(hostId);
        const entry = watch?.panes.get(paneId);
        if (watch !== undefined && entry !== undefined && entry.terminalID === terminalID && entry.kind === kind && watch.connection === this.hosts.connection(hostId)) {
          entry.shown = seen;
          entry.lastReadMs = this.clock.now();
          this.publish(hostId, watch);
        }
        none = seen === null;
        if (!none) return false;
        // A newer read asked for meanwhile (the watch's, queued behind this one) is waited for.
        await settle();
        return clear();
      },
      clear,
      settle,
      shown,
    };
  }

  /** A read of the pane goes now: it is the newest asked for, out until it answers. */
  private asked(key: string, identity: string, terminalID: string, done: Promise<void>): NewestRead {
    this.serial += 1;
    const read: NewestRead = { serial: this.serial, identity, terminalID, state: "out", shown: null, done };
    this.newest.set(key, read);
    return read;
  }

  /** The read is done; it is what counts only while no newer one was asked for. */
  private answered(read: NewestRead, state: "failed" | "answered", shown: StartScreenKind | null): void {
    read.state = state;
    read.shown = shown;
  }

  /** The machines changed (or the timer ticked): each watched pane due is read once; the rest forgotten. */
  hostsChanged(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        this.pass();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  /** The machine's entry, command connection and connection now, as a read compares them before and after. */
  private identityNow(hostId: string): string | null {
    const identity = this.hosts.connectionIdentity(hostId);
    const connection = this.hosts.connection(hostId);
    return identity === null || connection === null ? null : `${identity.incarnation}|${identity.epoch}|${connection}`;
  }

  private pass(): void {
    const listed = this.hosts.list();
    for (const id of this.hostsWatched.keys()) {
      if (listed.some((host) => host.id === id)) continue;
      this.hostsWatched.delete(id);
    }
    for (const key of this.newest.keys()) {
      if (!listed.some((host) => key.startsWith(`${host.id}/`))) this.newest.delete(key);
    }
    const now = this.clock.now();
    for (const host of listed) {
      // Bound as the window shows the machine (HostView: its entry, connection and the snapshot's command connection).
      const connection = host.state === "connected" ? (host.connection ?? 0) : 0;
      const backend = this.hosts.backend(host.id);
      if (connection === 0 || host.incarnation === undefined || host.topology === null || backend?.paneText === undefined) {
        if (this.hostsWatched.delete(host.id)) this.hosts.setStartScreens(host.id, null);
        continue;
      }
      const epoch = host.epoch ?? null;
      let watch = this.hostsWatched.get(host.id);
      if (watch === undefined || watch.incarnation !== host.incarnation || watch.connection !== connection || watch.epoch !== epoch) {
        watch = { incarnation: host.incarnation, connection, epoch, panes: new Map(), published: "" };
        this.hostsWatched.set(host.id, watch);
      }
      const panes = startScreenPanes(host.topology);
      const ids = new Set(panes.map((pane) => pane.paneId));
      for (const id of watch.panes.keys()) if (!ids.has(id)) watch.panes.delete(id);
      const paneText = backend.paneText.bind(backend);
      for (const pane of panes) {
        const identityKey = `${pane.kind}|${pane.terminalID}`;
        let entry = watch.panes.get(pane.paneId);
        if (entry === undefined || entry.identity !== identityKey) {
          entry = { identity: identityKey, kind: pane.kind, terminalID: pane.terminalID, firstSeenMs: now, lastReadMs: null, inFlight: false, shown: null };
          watch.panes.set(pane.paneId, entry);
        }
        if (entry.inFlight) continue;
        if (entry.lastReadMs !== null && now - entry.lastReadMs < startScreenReadMs) continue;
        if (entry.shown === null && entry.lastReadMs !== null && now - entry.firstSeenMs >= startScreenWindowMs) continue;
        entry.inFlight = true;
        entry.lastReadMs = now;
        this.reads += 1;
        const owner = watch;
        const asked = entry;
        const before = this.identityNow(host.id);
        let finish!: () => void;
        const read = this.asked(`${host.id}/${pane.paneId}`, before ?? "", pane.terminalID, new Promise<void>((done) => (finish = done)));
        void this.gate
          .reading(paneReadKey(host.id, pane.paneId), () => paneText(pane.paneId, startScreenLines(pane.kind)))
          .then(
            (text) => this.answer(host.id, owner, pane.paneId, asked, before, text, read),
            () => this.answer(host.id, owner, pane.paneId, asked, before, null, read),
          )
          .finally(finish);
      }
      this.publish(host.id, watch);
    }
  }

  private answer(hostId: string, watch: HostWatch, paneId: string, entry: Entry, before: string | null, text: string | null, read: NewestRead): void {
    entry.inFlight = false;
    // Anything but a verified answer leaves the read unverified (a Send's checks refuse on it).
    this.answered(read, "failed", null);
    // A machine removed, reconnected or on another command connection since, or the pane's terminal or agent
    // changed: the answer is not this pane's now.
    if (this.hostsWatched.get(hostId) !== watch || watch.panes.get(paneId) !== entry) return;
    if (before === null || this.identityNow(hostId) !== before || this.hosts.connection(hostId) !== watch.connection) return;
    if (text === null) return;
    // A question cut above its title by the read: unverified, the last mark kept.
    const state = readStartScreenState(text, entry.kind, startScreenLines(entry.kind));
    if (state === "unverified") return;
    entry.shown = state;
    this.answered(read, "answered", entry.shown);
    this.publish(hostId, watch);
  }

  private publish(hostId: string, watch: HostWatch): void {
    const panes: PaneStartScreen[] = [...watch.panes]
      .filter(([, entry]) => entry.shown !== null)
      .map(([paneId, entry]) => ({ paneId, kind: entry.shown!, terminalID: entry.terminalID }))
      .sort((a, b) => (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
    const key = JSON.stringify(panes);
    if (key === watch.published) return;
    watch.published = key;
    this.hosts.setStartScreens(hostId, panes.length === 0 ? null : { incarnation: watch.incarnation, connection: watch.connection, epoch: watch.epoch, panes });
  }
}
