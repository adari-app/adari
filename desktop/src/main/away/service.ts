// "While you were away" in the main process (CompanionAwayModel in the Swift
// app). A visit is the time the window has focus. When one starts, every
// machine is asked for a fresh snapshot and each connected machine is read once
// (its agents' transcripts and `git log` in their folders, the Swift bounds:
// shared/away/readers) since the user last looked at it. A machine that connects
// later in the visit is read when it does. Machines that do not answer get a
// line ("offline since …", "not connected since …").
//
// `since` moves only for a digest the user was shown (the sidebar line or the
// screen on screen: the page says so with `shown`): when the visit ends it
// becomes the time they stopped looking; a digest never shown leaves the old
// `since`, as in the Swift app. Mark all seen makes it now and clears the cards.
// A machine that stops answering during the visit (offline, reconnecting,
// removed) is acknowledged only through the moment it stopped: what it did
// after was not read.

import type { HostView } from "../../shared/ipc-contract";
import { paneSession, type ChatSession } from "../../shared/chat/locator";
import { isGeminiFamilyFormat } from "../../shared/chat/agents/gemini-family";
import { isStoreAgentFormat } from "../../shared/chat/agents/store-agents";
import { isPiFormat } from "../../shared/chat/agents/pi-locator";
import { isOpenCodeFormat } from "../../shared/chat/agents/opencode-locate";
import { sidebarInputFromTopology } from "../../shared/sidebar-model";
import {
  awayPanes,
  buildAwayDigest,
  initialAwayViewState,
  type AwayMacInput,
  type AwayViewState,
} from "../../shared/away/digest";
import { collectAway, defaultAwayLimits, firstSince, type AwayLimits } from "../../shared/away/readers";
import { isCancelled, type RemoteCommandRunner } from "../../shared/remote-command";
import type { SessionTopology } from "../herdr/wire";
import type { HerdrHostBackend } from "../herdr/backend";
import type { SinceStore } from "./since-store";

/** What the service needs of the HostRegistry. */
export interface AwayHosts {
  list(): HostView[];
  backend(id: string): HerdrHostBackend | null;
  refreshAll(): Promise<HostView[]>;
}

export interface AwayServiceOptions {
  readonly hosts: AwayHosts;
  readonly store: SinceStore;
  /** Sends the page the new state. */
  readonly send: (state: AwayViewState) => void;
  /** Seconds since 1970. */
  readonly now?: () => number;
  readonly limits?: AwayLimits;
}

interface Visit {
  readonly abort: AbortController;
  /** The `since` this visit's reads use, per machine. */
  readonly since: Map<string, number>;
  /** Machines read (or being read) this visit. */
  readonly started: Set<string>;
  /** Each read machine's inputs. */
  readonly inputs: Map<string, AwayMacInput>;
  reads: number;
  /** When the user chose Mark all seen this visit. */
  seenAt: number | null;
  /** Read machines that stopped answering this visit, and when: their digest knows nothing after. */
  readonly departed: Map<string, number>;
}

/**
 * Each agent pane's transcript, as Chat finds it (locator.paneSession, the one rule; a Grok pane
 * Chat cannot tell from a peer's has none).
 */
export function paneSessions(topology: SessionTopology): Record<string, ChatSession | null> {
  const agents: SessionTopology["agents"][number][] = [];
  const seen = new Set<string>();
  for (const agent of topology.agents) {
    if (agent.paneID === "" || seen.has(agent.paneID)) continue;
    seen.add(agent.paneID);
    agents.push(agent);
  }
  const machine = { agents, panes: topology.panes };
  const sessions: Record<string, ChatSession | null> = {};
  for (const pane of topology.panes) {
    const session = paneSession(machine, pane.paneID);
    // The Away digest does not read Cursor's chats yet: a Cursor pane has none.
    sessions[pane.paneID] = session === "ambiguous" || session?.ref.format === "cursor" ? null : session;
    // Nor Gemini CLI's, Qwen Code's or Antigravity's yet.
    if (session !== null && session !== "ambiguous" && isGeminiFamilyFormat(session.ref.format)) sessions[pane.paneID] = null;
    if (session !== "ambiguous" && session?.ref.format === "kimi") sessions[pane.paneID] = null; // nor Kimi's yet
    // Nor Maki's sessions yet.
    if (session !== "ambiguous" && session?.ref.format === "maki") sessions[pane.paneID] = null;
    if (session !== "ambiguous" && session?.ref.format === "kiro") sessions[pane.paneID] = null; // nor Kiro's yet
    if (session !== null && session !== "ambiguous" && isStoreAgentFormat(session.ref.format)) sessions[pane.paneID] = null; // nor Hermes's, Mastra Code's or Cline's yet
    // Nor Pi's, omp's, Copilot's, Droid's, OpenCode's or Kilo's for 0.1.0: Away's folder check knows Claude's and
    // Codex's lines only, so another folder's session would pass it (each needs its own bounded ownership check first).
    if (session !== null && session !== "ambiguous" && (isPiFormat(session.ref.format) || session.ref.format === "copilot" || session.ref.format === "droid" || isOpenCodeFormat(session.ref.format))) sessions[pane.paneID] = null;
  }
  return sessions;
}

export class AwayService {
  private readonly hosts: AwayHosts;
  private readonly store: SinceStore;
  private readonly sendState: (state: AwayViewState) => void;
  private readonly now: () => number;
  private readonly limits: AwayLimits;
  private visit: Visit | null = null;
  /** Machines whose current digest the user was shown. */
  private readonly shownHosts = new Set<string>();
  private current: AwayViewState = initialAwayViewState;

  constructor(options: AwayServiceOptions) {
    this.hosts = options.hosts;
    this.store = options.store;
    this.sendState = options.send;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.limits = options.limits ?? defaultAwayLimits;
  }

  get state(): AwayViewState {
    return this.current;
  }

  /** The window has focus: a visit starts (once). */
  focus(): void {
    if (this.visit !== null) return;
    const visit: Visit = { abort: new AbortController(), since: new Map(), started: new Set(), inputs: new Map(), reads: 0, seenAt: null, departed: new Map() };
    this.visit = visit;
    this.shownHosts.clear();
    this.current = { digest: null, building: true, seenAt: null };
    this.publish();
    void this.hosts.refreshAll().then(
      () => this.hostsChanged(),
      () => this.hostsChanged(),
    );
  }

  /** The window lost focus: what the user was shown is seen up to now; reads stop. */
  blur(): void {
    const visit = this.visit;
    if (visit === null) return;
    const at = this.now();
    for (const host of this.shownHosts) if (visit.inputs.has(host)) this.store.set(host, acknowledged(visit, host, at));
    this.shownHosts.clear();
    visit.abort.abort();
    this.visit = null;
    if (this.current.building) {
      this.current = { ...this.current, building: false };
      this.publish();
    }
  }

  /** The page shows the digest (its line or the screen). */
  shown(): void {
    const visit = this.visit;
    if (visit === null || this.current.digest === null) return;
    // A digest on screen after its machine stopped answering acknowledges nothing new.
    for (const host of visit.inputs.keys()) if (!visit.departed.has(host)) this.shownHosts.add(host);
  }

  /** Mark all seen: `since` is now on every machine read; the cards clear. */
  markAllSeen(): void {
    const visit = this.visit;
    const digest = this.current.digest;
    if (visit === null || digest === null) return;
    const at = this.now();
    for (const [host, mac] of visit.inputs) {
      const through = acknowledged(visit, host, at);
      this.store.set(host, through);
      visit.since.set(host, through);
      this.shownHosts.add(host);
      visit.inputs.set(host, { ...mac, since: at, panes: [], git: {} });
    }
    visit.seenAt = at;
    this.rebuild(visit);
  }

  /** Machines changed (the registry's onChange): read those that connected this visit. */
  hostsChanged(): void {
    const visit = this.visit;
    if (visit === null) return;
    // A machine read (or being read) that is no longer connected stopped answering now (its first time this visit counts).
    const connected = new Set(this.hosts.list().flatMap((host) => (host.state === "connected" ? [host.id] : [])));
    for (const host of visit.started) if (!connected.has(host) && !visit.departed.has(host)) visit.departed.set(host, this.now());
    for (const host of this.hosts.list()) {
      if (visit.started.has(host.id) || host.state !== "connected" || host.topology === null) continue;
      visit.started.add(host.id);
      void this.read(visit, host, host.topology);
    }
    this.rebuild(visit);
  }

  private sinceFor(visit: Visit, host: string): number {
    let since = visit.since.get(host);
    if (since === undefined) {
      since = this.store.get(host) ?? firstSince(this.now());
      visit.since.set(host, since);
    }
    return since;
  }

  private async read(visit: Visit, host: HostView, topology: SessionTopology): Promise<void> {
    const since = this.sinceFor(visit, host.id);
    const backend = this.hosts.backend(host.id);
    const input = sidebarInputFromTopology(topology, { macID: host.id, nowUnixMs: this.now() * 1000 });
    const panes = awayPanes(input, paneSessions(topology));
    visit.reads += 1;
    this.rebuild(visit);
    try {
      const mac = await collectAway(
        { id: host.id, name: host.name, since, panes, reader: backend?.transcripts() ?? null, runner: commandsOf(backend) },
        this.limits,
        visit.abort.signal,
      );
      if (this.visit !== visit || visit.seenAt !== null && visit.inputs.has(host.id)) return;
      visit.inputs.set(host.id, mac);
      // A new digest of this machine: shown once it is on screen.
      this.shownHosts.delete(host.id);
    } catch (error) {
      if (isCancelled(error, visit.abort.signal) || this.visit !== visit) return;
    } finally {
      visit.reads -= 1;
    }
    if (this.visit === visit) this.rebuild(visit);
  }

  private rebuild(visit: Visit): void {
    if (this.visit !== visit) return;
    const macs: AwayMacInput[] = [];
    for (const host of this.hosts.list()) {
      const read = visit.inputs.get(host.id);
      if (read !== undefined) {
        macs.push(host.state === "offline" ? { ...read, state: { kind: "offline", since: seconds(host.fetchedAtMs) } } : read);
        continue;
      }
      // A machine on its way is read when it connects.
      if (host.state !== "offline") continue;
      const stored = this.store.get(host.id);
      const state: AwayMacInput["state"] =
        host.fetchedAtMs !== null ? { kind: "offline", since: seconds(host.fetchedAtMs) } : { kind: "notConnected", since: stored };
      macs.push({ id: host.id, name: host.name, since: stored ?? firstSince(this.now()), state, panes: [], git: {} });
    }
    const building = visit.reads > 0 || this.hosts.list().some((host) => host.state === "connecting" && !visit.started.has(host.id));
    const anyRead = macs.length > 0;
    this.current = { digest: anyRead || !building ? buildAwayDigest(macs, this.now()) : null, building, seenAt: visit.seenAt };
    this.publish();
  }

  private publish(): void {
    this.sendState(this.current);
  }

  close(): void {
    this.visit?.abort.abort();
    this.visit = null;
  }
}

/** What a machine's digest covers: through `at`, or through when it stopped answering this visit. */
function acknowledged(visit: Visit, host: string, at: number): number {
  const departed = visit.departed.get(host);
  return departed === undefined ? at : Math.min(at, departed);
}

const seconds = (ms: number | null): number | null => (ms === null ? null : ms / 1000);

function commandsOf(backend: HerdrHostBackend | null): RemoteCommandRunner | null {
  return backend?.commands?.() ?? null;
}
