// Every machine in the sidebar: its backend (Herdr TUI over SSH, or a demo
// host), its last snapshot, and whether it answered. Several machines from the
// start; each refreshes on its own, so one slow or offline machine never holds
// up the others.

import { randomUUID } from "node:crypto";

import type { HostKeyQuestion, HostNotRunning, HostView } from "../shared/ipc-contract";
import type { HostIntegrations } from "../shared/integrations";
import type { HostStartScreens } from "../shared/prompt/start-screen";
import { PaneLife } from "../shared/pane-life";
import type { HerdrHostBackend } from "./herdr/backend";
import { dottedKind, relayOffReason, type EventSubscription } from "./herdr/events";
import { sidebarEventKinds, sidebarPaneEventKind } from "./herdr/pane-methods";
import { AuthenticationFailedError, HerdrNotRunningHereError } from "./herdr/errors";
import { NewHostKeyError, hostKeyCheckCommand, keyTypeLabel } from "./herdr/host-key-pinning";
import type { AgentInfo, SessionTopology, TopologyPaneInfo } from "./herdr/wire";

export interface HostDescriptor {
  readonly id: string;
  readonly name: string;
  readonly kind: HostView["kind"];
  readonly address: string;
  readonly platform: string | null;
}

/**
 * A host-key question open now. `id` is opaque and new for each question (a UUID, as
 * Swift's HostKeyQuestion has). It lives on one entry (one incarnation of the machine: an edit or a removal
 * makes another) beside the endpoint and the key it asks about, and it is dropped when the question is
 * answered or the machine asked again. An answer carrying any other id finds nothing to act on.
 */
interface OpenHostKeyQuestion {
  readonly id: string;
  readonly key: NewHostKeyError;
}

interface HostEntry {
  readonly descriptor: HostDescriptor;
  readonly backend: HerdrHostBackend;
  state: HostView["state"];
  error: string | null;
  topology: SessionTopology | null;
  fetchedAtMs: number | null;
  refreshing: Promise<void> | null;
  /** The machine refused the sign-in: no snapshot is asked for until Try again or an edit. */
  authRefused: boolean;
  /**
   * The host key a first contact presented (nothing pinned, nothing sent), waiting for
   * the person's Trust or Cancel under its question's id; no snapshot is asked for until then.
   */
  question: OpenHostKeyQuestion | null;
  /** Its new host key was not trusted (Cancel, or the pin could not be saved): nothing is asked until Try again. */
  hostKeyDeclined: boolean;
  /** Snapshots asked for so far; the number of the last one that came. */
  asked: number;
  answered: number;
  /** Its connection: a new number from the registry each time it answers after it had not (0: never answered). */
  connection: number;
  /** This entry: a new number from the registry each time a machine is added. */
  readonly incarnation: number;
  /** The command connection (HerdrHostBackend.connectionEpoch) its last snapshot was sent on (null: none yet). */
  epoch: number | null;
  /** Its agent panes marked "Update ready" (UpdateMarkService). */
  updateReady: readonly string[];
  /** Herdr's integrations as read on one connection (IntegrationService); null: none. */
  integrations: HostIntegrations | null;
  /** Its panes showing a start screen (StartScreenService); null: none. */
  startScreens: HostStartScreens | null;
  /** This Mac's Herdr is not running (HerdrNotRunningHereError): a note, not an error. */
  notRunning: HostNotRunning | null;
  /**
   * The last topology from the launch cache, shown (marked as catching up) until the first
   * snapshot lands. Never read for an action: pane(), agent() and the rest read `topology` only.
   */
  cached: SessionTopology | null;
  /** The sidebar's event stream on the relay, and whether Herdr started it. */
  events: EventSubscription | null;
  eventsLive: boolean;
  /** The command connection and the panes the stream was asked for (a new connection or pane set asks again). */
  eventsEpoch: number | null;
  eventsPanes: string;
  /** A burst's 50 ms gather, and one more snapshot due after the one in flight (the latest wins). */
  burst: NodeJS.Timeout | null;
  again: boolean;
}

/** Events gathered this long give one snapshot. */
export const sidebarBurstMs = 50;
/** While the sidebar's events are live, the timer's snapshot is a backstop this far apart. */
export const sidebarBackstopMs = 30_000;
/** A send trusts the latest snapshot this young while the events keep it current. */
export const sendTrustMs = 10_000;

/** What the registry does beside its snapshots (the launch cache). */
export interface HostRegistryHooks {
  /** A snapshot landed (the launch cache keeps it; nothing is written here). */
  snapshot?(hostId: string, topology: SessionTopology): void;
}

/** The sidebar's kinds, dotted (an event in either spelling refreshes). */
const sidebarKinds: ReadonlySet<string> = new Set([...sidebarEventKinds, sidebarPaneEventKind]);

/** The machine's entry and the command connection its requests go on now. */
export interface ConnectionIdentity {
  readonly incarnation: number;
  readonly epoch: number | null;
}

/** The epoch of the connection `backend` sends on now (null: none held); 0 for a backend without connections (the demo: one for its life). */
function epochOf(backend: HerdrHostBackend): number | null {
  return backend.connectionEpoch === undefined ? 0 : backend.connectionEpoch();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the page shows of a new host key (never the pin's hex: the person sees OpenSSH's form), with its question's id. */
function questionOf({ id, key }: OpenHostKeyQuestion): HostKeyQuestion {
  return {
    id,
    host: key.host,
    port: key.port,
    keyType: key.keyType,
    typeLabel: keyTypeLabel(key.keyType),
    fingerprint: key.display,
    check: hostKeyCheckCommand(key.keyType),
  };
}

export class HostRegistry {
  private readonly entries: HostEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Its own count of each machine's connections and each pane's agent runs (a hand-off's binding is checked on it). */
  private readonly life = new PaneLife();
  /** The last connection number given (one count for every machine, so a machine added again never repeats one). */
  private connections = 0;
  /** Machines added so far (HostEntry.incarnation). */
  private incarnations = 0;

  constructor(
    private readonly onChange: (hosts: HostView[]) => void,
    private readonly now: () => number = Date.now,
    /** Takes the saved secrets out of an error text before it is kept for the page. */
    private readonly redact: (text: string) => string = (text) => text,
    private readonly hooks: HostRegistryHooks = {},
  ) {}

  /** A new entry's fields beside its descriptor, backend and incarnation. */
  private newFields(cached: SessionTopology | null) {
    return {
      state: "connecting" as HostView["state"],
      error: null,
      topology: null,
      fetchedAtMs: null,
      refreshing: null,
      authRefused: false,
      question: null,
      hostKeyDeclined: false,
      asked: 0,
      answered: 0,
      connection: 0,
      epoch: null,
      updateReady: [] as readonly string[],
      integrations: null as HostIntegrations | null,
      startScreens: null as HostStartScreens | null,
      notRunning: null,
      cached,
      events: null,
      eventsLive: false,
      eventsEpoch: null,
      eventsPanes: "",
      burst: null,
      again: false,
    };
  }

  /** `cached`: the machine's last topology from the launch cache, shown until a snapshot lands. */
  add(descriptor: HostDescriptor, backend: HerdrHostBackend, cached: SessionTopology | null = null): void {
    if (this.entries.some((entry) => entry.descriptor.id === descriptor.id)) {
      throw new Error(`a host with id ${descriptor.id} already exists`);
    }
    // This Mac (the local entry) sits first; every other machine after the ones before it.
    const place = descriptor.kind === "local" ? 0 : this.entries.length;
    this.entries.splice(place, 0, {
      descriptor,
      backend,
      ...this.newFields(cached),
      incarnation: (this.incarnations += 1),
    });
    this.changed();
    void this.refresh(descriptor.id);
  }

  /**
   * An edited machine: the new backend in the old one's place (closed), its
   * snapshot read again from scratch.
   */
  replace(descriptor: HostDescriptor, backend: HerdrHostBackend): void {
    const index = this.entries.findIndex((entry) => entry.descriptor.id === descriptor.id);
    if (index < 0) {
      this.add(descriptor, backend);
      return;
    }
    const old = this.entries[index];
    // The old entry's question goes with it; an answer to it finds nothing here. An edit is a new entry
    // for the pane-action bindings too (the new backend's epochs start again).
    this.entries[index] = {
      descriptor,
      backend,
      ...this.newFields(null),
      incarnation: (this.incarnations += 1),
    };
    if (old !== undefined) this.unfollow(old);
    old?.backend.close();
    // The old connection ended: its count of connections moves on
    // when the new one answers, so a hand-off picked before the edit is stale.
    this.life.observeHosts(this.entries.map((candidate) => this.lifeHost(candidate)));
    this.changed();
    void this.refresh(descriptor.id);
  }

  remove(id: string): void {
    const index = this.entries.findIndex((entry) => entry.descriptor.id === id);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    if (entry !== undefined) this.unfollow(entry);
    entry?.backend.close();
    this.life.observeHosts(this.entries.map((candidate) => this.lifeHost(candidate)));
    this.changed();
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.descriptor.id === id);
  }

  list(): HostView[] {
    return this.entries.map((entry) => ({
      ...entry.descriptor,
      state: entry.state,
      error: entry.error,
      // The cached topology until the first snapshot lands, marked as catching up.
      topology: entry.topology ?? entry.cached,
      ...(this.showsCache(entry) ? { catchingUp: true } : {}),
      fetchedAtMs: entry.fetchedAtMs,
      authRefused: entry.authRefused,
      ...(entry.question === null ? {} : { hostKey: questionOf(entry.question) }),
      ...(entry.hostKeyDeclined ? { hostKeyDeclined: true } : {}),
      ...(entry.topology === null
        ? {}
        : {
            run: {
              connection: this.life.connection(entry.descriptor.id),
              arrivals: Object.fromEntries(entry.topology.panes.map((pane) => [pane.paneID, this.life.arrival(entry.descriptor, pane.paneID)])),
            },
          }),
      connection: entry.connection,
      incarnation: entry.incarnation,
      epoch: entry.epoch,
      ...(entry.updateReady.length === 0 ? {} : { updateReady: entry.updateReady }),
      ...(this.integrationsShown(entry) ? { integrations: entry.integrations! } : {}),
      ...(this.startScreensShown(entry) ? { startScreens: entry.startScreens! } : {}),
      ...(entry.notRunning === null ? {} : { notRunning: entry.notRunning }),
    }));
  }

  /** The machine's panes marked "Update ready" now; the window hears only a change. */
  setUpdateReady(hostId: string, panes: readonly string[]): void {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    if (entry === undefined) return;
    const next = [...panes].sort();
    if (next.length === entry.updateReady.length && next.every((pane, index) => pane === entry.updateReady[index])) return;
    entry.updateReady = next;
    this.changed();
  }

  /**
   * The machine's integrations as read now (IntegrationService; null: none).
   * Shown only while the machine answers on the entry, connection and command connection they were read on.
   */
  setIntegrations(hostId: string, integrations: HostIntegrations | null): void {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    if (entry === undefined || (entry.integrations === null && integrations === null)) return;
    entry.integrations = integrations;
    this.changed();
  }

  /**
   * The machine's panes showing a start screen as read now
   * (StartScreenService; null: none). Shown only while the machine answers on the entry, connection and command
   * connection they were read on.
   */
  setStartScreens(hostId: string, screens: HostStartScreens | null): void {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    if (entry === undefined || (entry.startScreens === null && screens === null)) return;
    entry.startScreens = screens;
    this.changed();
  }

  private startScreensShown(entry: HostEntry): boolean {
    const shown = entry.startScreens;
    return shown !== null && entry.state === "connected" && shown.incarnation === entry.incarnation && shown.connection === entry.connection && shown.epoch === entry.epoch;
  }

  private integrationsShown(entry: HostEntry): boolean {
    const shown = entry.integrations;
    // And on the command connection the last snapshot came on.
    return shown !== null && entry.state === "connected" && shown.incarnation === entry.incarnation && shown.connection === entry.connection && shown.epoch === entry.epoch;
  }

  /** The connection and the pane's agent run now, or null while the machine does not answer. */
  run(hostId: string, paneId: string): { connection: number; arrival: number } | null {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    if (entry === undefined || !this.life.isLive(hostId)) return null;
    return { connection: this.life.connection(hostId), arrival: this.life.arrival(entry.descriptor, paneId) };
  }

  private lifeHost(entry: HostEntry) {
    return { id: entry.descriptor.id, address: entry.descriptor.address, state: entry.state, topology: entry.topology };
  }

  /**
   * The machine's connection while it answers (a pane
   * action is bound to it); null while it does not, or when it is not listed.
   */
  connection(hostId: string): number | null {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    return entry === undefined || entry.state !== "connected" || entry.connection === 0 ? null : entry.connection;
  }

  /**
   * The machine's entry and the command connection a request sent now goes on
   * (read from the backend each time, so a reconnect between
   * snapshots shows); null when it is not listed.
   */
  connectionIdentity(hostId: string): ConnectionIdentity | null {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    return entry === undefined ? null : { incarnation: entry.incarnation, epoch: epochOf(entry.backend) };
  }

  /** The machine's name as the sidebar shows it, or null when it is not listed. */
  name(hostId: string): string | null {
    return this.entries.find((candidate) => candidate.descriptor.id === hostId)?.descriptor.name ?? null;
  }

  /** The command connection the machine's last snapshot came on (a stop's key goes on it); null: none yet. */
  snapshotEpoch(hostId: string): number | null {
    return this.entries.find((candidate) => candidate.descriptor.id === hostId)?.epoch ?? null;
  }

  backend(id: string): HerdrHostBackend | null {
    return this.entries.find((entry) => entry.descriptor.id === id)?.backend ?? null;
  }

  /** The machine's last snapshot, or null. */
  topology(hostId: string): SessionTopology | null {
    return this.entries.find((candidate) => candidate.descriptor.id === hostId)?.topology ?? null;
  }

  pane(hostId: string, paneId: string): TopologyPaneInfo | null {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    return entry?.topology?.panes.find((pane) => pane.paneID === paneId) ?? null;
  }

  /** Every agent pane of the last snapshots, machine by machine, in their order. */
  agentPanes(): { hostId: string; paneId: string }[] {
    return this.entries.flatMap((entry) =>
      (entry.topology?.agents ?? []).map((agent) => ({ hostId: entry.descriptor.id, paneId: agent.paneID })),
    );
  }

  /** One machine's agent panes, from the last snapshot. */
  hostAgentPanes(hostId: string): string[] {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    return (entry?.topology?.agents ?? []).map((agent) => agent.paneID);
  }

  /** The agent Herdr lists in the pane, from the last snapshot. */
  agent(hostId: string, paneId: string): AgentInfo | null {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    return entry?.topology?.agents.find((agent) => agent.paneID === paneId) ?? null;
  }

  /**
   * One machine's snapshot; a failure keeps the last one and marks the
   * machine offline. Nothing is asked of a machine that refused the sign-in,
   * nor of one whose new host key waits for an answer.
   */
  refresh(id: string): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === id);
    if (entry === undefined) return Promise.resolve();
    if ((entry.authRefused || entry.question !== null || entry.hostKeyDeclined) && entry.refreshing === null) return Promise.resolve();
    entry.refreshing ??= this.ask(entry);
    return entry.refreshing;
  }

  /**
   * One snapshot of `entry`, asked now (a send's fresh() asks its own instead of waiting for
   * one in flight; only an answer newer than the last one applied counts, so replies in any order agree).
   */
  private ask(entry: HostEntry): Promise<void> {
    const self: { asking: Promise<void> | null } = { asking: null };
    self.asking = (async () => {
      entry.asked += 1;
      const number = entry.asked;
      try {
        const reply = entry.backend.snapshot();
        // The connection that request went on (a backend picks it, or opens one, when asked).
        const epoch = epochOf(entry.backend);
        const topology = await reply;
        if (number > entry.answered) {
          entry.epoch = epoch;
          if (entry.state !== "connected" || entry.connection === 0) {
            this.connections += 1;
            entry.connection = this.connections;
          }
          entry.answered = number;
          entry.topology = topology;
          entry.cached = null;
          entry.fetchedAtMs = this.now();
          entry.state = "connected";
          entry.error = null;
          entry.authRefused = false;
          entry.question = null;
          entry.notRunning = null;
          this.hooks.snapshot?.(entry.descriptor.id, topology);
          // Delivered, in order, now (the core's finder numbers it here).
          entry.backend.observeSnapshot?.(topology);
        }
      } catch (error) {
        if (number > entry.answered) {
          entry.state = "offline";
          // This Mac's Herdr not running is a note with its hint, not an error.
          entry.notRunning = error instanceof HerdrNotRunningHereError ? { text: error.message, hint: error.hint } : null;
          // A Herdr that is not running has no panes, so its last snapshot goes with it (otherwise the folded
          // header would still count its panes); a machine that is only out of reach keeps its "last known".
          if (entry.notRunning !== null) {
            entry.topology = null;
            entry.cached = null;
          }
          entry.error = entry.notRunning === null ? this.redact(describe(error)) : null;
          entry.authRefused = error instanceof AuthenticationFailedError;
          // Each question its own id; one asked again (after Cancel and Try again) is a new question.
          entry.question = error instanceof NewHostKeyError ? { id: randomUUID(), key: error } : null;
        }
      } finally {
        if (entry.refreshing === self.asking) entry.refreshing = null;
      }
      if (this.entries.includes(entry)) this.life.observe(this.lifeHost(entry));
      if (this.entries.includes(entry)) {
        this.follow(entry);
        this.changed();
      }
      // Events that came while this one was out get one more, now (the latest wins).
      if (entry.again && this.entries.includes(entry)) {
        entry.again = false;
        void this.refresh(entry.descriptor.id);
      }
    })();
    return self.asking;
  }

  // MARK: the sidebar by events

  /**
   * Keeps the machine's sidebar events on its relay while it answers: asked again on a new connection or
   * a new set of panes. With no relay the stream ends at once and the timer polls.
   */
  private follow(entry: HostEntry): void {
    const subscribe = entry.backend.subscribeSidebar;
    if (subscribe === undefined || entry.state !== "connected" || entry.topology === null) return;
    const epoch = epochOf(entry.backend);
    const panes = entry.topology.panes.map((pane) => pane.paneID).sort();
    const key = panes.join("\n");
    if (entry.eventsEpoch === epoch && entry.eventsPanes === key) return;
    entry.eventsEpoch = epoch;
    entry.eventsPanes = key;
    const before = entry.events;
    let mine: EventSubscription | null = null;
    let started = false;
    mine = subscribe.call(
      entry.backend,
      sidebarEventKinds,
      panes.map((paneId) => ({ type: sidebarPaneEventKind, paneId })),
      {
        started: () => {
          started = true;
          if (entry.events !== mine) return;
          entry.eventsLive = true;
          // A replacement's start bridges the handover with one snapshot (a change while
          // neither stream covered it is not lost until the backstop).
          if (before !== null && this.entries.includes(entry)) void this.refresh(entry.descriptor.id);
        },
        event: (kind) => {
          if (entry.events === mine && sidebarKinds.has(dottedKind(kind))) this.burst(entry);
        },
        ended: (reason) => {
          if (entry.events !== mine) return;
          entry.events = null;
          entry.eventsLive = false;
          // A stream that ran and ended (its relay went, the connection with it): a snapshot now reconnects,
          // relay first, and asks again. One that never started (relay off, refused) waits for a new connection.
          if (started && reason !== relayOffReason && this.entries.includes(entry)) {
            entry.eventsEpoch = null;
            void this.refresh(entry.descriptor.id);
          }
        },
      },
    );
    entry.events = mine;
    // Not live until the new subscription starts (the old one's events are no longer taken).
    entry.eventsLive = false;
    before?.close();
  }

  private unfollow(entry: HostEntry): void {
    const events = entry.events;
    entry.events = null;
    entry.eventsLive = false;
    events?.close();
    if (entry.burst !== null) clearTimeout(entry.burst);
    entry.burst = null;
  }

  /** One sidebar event: events gathered for 50 ms give one snapshot; one in flight takes one more after it. */
  private burst(entry: HostEntry): void {
    if (entry.burst !== null) return;
    entry.burst = setTimeout(() => {
      entry.burst = null;
      if (!this.entries.includes(entry)) return;
      if (entry.refreshing !== null) entry.again = true;
      else void this.refresh(entry.descriptor.id);
    }, sidebarBurstMs);
  }

  /** The machine shows its launch cache while it connects, no snapshot yet (offline, it is "last known"). */
  catchingUp(hostId: string): boolean {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === hostId);
    return entry !== undefined && this.showsCache(entry);
  }

  private showsCache(entry: HostEntry): boolean {
    return entry.topology === null && entry.cached !== null && entry.state === "connecting";
  }

  /** Whether the machine's sidebar events are live (the latest snapshot is kept current). */
  eventsLive(hostId: string): boolean {
    return this.entries.find((candidate) => candidate.descriptor.id === hostId)?.eventsLive ?? false;
  }

  /**
   * Try again, beside a refused sign-in's or a declined host key's error: one more attempt (the caller
   * resets the connection's latch). A declined key is asked about again.
   */
  retry(id: string): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === id);
    if (entry === undefined) return Promise.resolve();
    entry.authRefused = false;
    entry.hostKeyDeclined = false;
    return this.refresh(id);
  }

  /**
   * "Trust and connect". Only for the question open now (`questionId` is its id),
   * and only when `shown` is the fingerprint it showed (OpenSSH's SHA256: form): anything else stores
   * nothing, clears nothing and connects nothing. `pin` stores exactly that key's pin
   * (PinningHostKeyPolicy.trustNewKey); then the machine is asked again, and a different key on that
   * connection gets the changed-key refusal. A pin refused (another key got there first) or not saved
   * stores nothing and sends nothing: the machine says why and waits for Try again.
   */
  async trustHostKey(id: string, questionId: string, shown: string, pin: (key: NewHostKeyError) => "trust" | "reject"): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === id);
    const open = entry?.question ?? null;
    if (entry === undefined || open === null || open.id !== questionId || open.key.display !== shown) return;
    let outcome: "trust" | "reject";
    try {
      outcome = pin(open.key);
    } catch {
      outcome = "reject";
    }
    entry.question = null;
    if (outcome !== "trust") {
      entry.hostKeyDeclined = true;
      entry.error = "This Mac's host key was not saved: another key is saved for it now, or the saved keys could not be written. Nothing was sent.";
      this.changed();
      return;
    }
    entry.error = null;
    this.changed();
    await this.refresh(id);
  }

  /**
   * "Cancel": nothing stored and nothing sent; the machine waits for Try again. Only for
   * the question open now (`questionId` is its id); any other id leaves everything as it is.
   */
  cancelHostKey(id: string, questionId: string): void {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === id);
    if (entry === undefined || entry.question === null || entry.question.id !== questionId) return;
    entry.question = null;
    entry.hostKeyDeclined = true;
    entry.error = "Not connected: this Mac's host key was not trusted. Nothing was sent or saved.";
    this.changed();
  }

  /**
   * A snapshot asked for after this call began (one already in flight proves
   * nothing: it may predate the call): true once one came, false when the
   * machine did not answer or is no longer listed. A Send checks its pane on
   * it right before writing (the Swift CompanionAgentGuard.check).
   */
  async fresh(id: string): Promise<boolean> {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === id);
    if (entry === undefined) return false;
    if (entry.authRefused || entry.question !== null || entry.hostKeyDeclined) return false;
    // Its own snapshot, at once (never one in flight first and then another).
    const before = entry.asked;
    await this.ask(entry);
    if (!this.entries.includes(entry)) return false;
    return entry.answered > before;
  }

  /**
   * A send's check. The latest snapshot stands while the sidebar's events keep it
   * current and it is under 10 s old (no request); otherwise a fresh one first (fresh()).
   */
  async current(id: string): Promise<boolean> {
    const entry = this.entries.find((candidate) => candidate.descriptor.id === id);
    if (entry === undefined) return false;
    const young = entry.fetchedAtMs !== null && this.now() - entry.fetchedAtMs < sendTrustMs;
    // Only a snapshot from the connection the backend sends on now, and none while
    // an event's snapshot is still to come (gathering, or one more due after the one in flight).
    const sameConnection = entry.epoch !== null && entry.epoch === epochOf(entry.backend);
    const settled = entry.refreshing === null && entry.burst === null && !entry.again;
    if (entry.state === "connected" && entry.topology !== null && entry.eventsLive && young && sameConnection && settled) return true;
    return this.fresh(id);
  }

  async refreshAll(): Promise<HostView[]> {
    await Promise.all(this.entries.map((entry) => this.refresh(entry.descriptor.id)));
    return this.list();
  }

  /**
   * Refreshes every machine every `intervalMs`; a machine whose sidebar events are live
   * only when its last snapshot is `backstopMs` old (the events bring the rest).
   */
  start(intervalMs: number, backstopMs: number = sidebarBackstopMs): void {
    this.stop();
    this.timer = setInterval(() => {
      const now = this.now();
      for (const entry of this.entries) {
        if (entry.eventsLive && entry.fetchedAtMs !== null && now - entry.fetchedAtMs < backstopMs) continue;
        void this.refresh(entry.descriptor.id);
      }
    }, intervalMs);
  }

  /** A window on screen or not, or focus or wake, to every machine's connection. */
  liveness(event: "visible" | "hidden" | "wake"): void {
    for (const entry of this.entries) entry.backend.liveness?.(event);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    this.stop();
    for (const entry of this.entries.splice(0)) {
      this.unfollow(entry);
      entry.backend.close();
    }
  }

  private changed(): void {
    this.onChange(this.list());
  }
}
