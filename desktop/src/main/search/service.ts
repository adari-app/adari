// "Search conversations" in the main process (CompanionSearchModel in the
// Swift app). One search per machine (shared/search/runner: one command over
// the machine's transcript connection, then the matching lines read), its
// results grouped by pane across machines. The page sends every edit of the
// query: an edit cancels the old query's commands and reads at once, and the new
// query is searched once typing pauses for 300 ms (CompanionSearchModel's
// scheduleSearch; the rows already found stay until then). Closing the screen
// cancels everything, and a machine that connects or goes
// offline has its search cancelled (and run again). Unlike the Swift app, which
// holds one live connection, every connected machine is searched.

import type { HostView } from "../../shared/ipc-contract";
import { awayPanes, type AwayPane } from "../../shared/away/digest";
import { SearchRun, type SearchRemote, type SearchUpdate } from "../../shared/search/runner";
import { SearchQuery, searchBounds } from "../../shared/search/search";
import { buildGroups, emptySearchState, type SearchMacPhase, type SearchMacStatus, type SearchViewState } from "../../shared/search/view";
import { sidebarInputFromTopology } from "../../shared/sidebar-model";
import { paneSessions } from "../away/service";
import type { SessionTopology } from "../herdr/wire";
import type { HerdrHostBackend } from "../herdr/backend";

/** What the service needs of the HostRegistry. */
export interface SearchHosts {
  list(): HostView[];
  backend(id: string): HerdrHostBackend | null;
}

/** The window a search belongs to (its webContents). */
export interface SearchOwner {
  readonly id: number;
  send(channel: string, payload: SearchViewState): void;
  isDestroyed(): boolean;
}

interface MacEntry {
  readonly id: string;
  name: string;
  panes: readonly AwayPane[];
  remote: SearchRemote | null;
  /** When it changes, the machine's search starts again. */
  connectionKey: string;
  run: SearchRun | null;
  update: SearchUpdate | null;
  status: SearchMacStatus;
  /** Counts the machine's searches: an update of an earlier one is dropped. */
  serial: number;
}

interface Session {
  readonly owner: SearchOwner;
  query: SearchQuery | null;
  macs: MacEntry[];
  expanded: Set<string>;
  last: string;
  /** The pause before the query's search starts. */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Agent panes with no transcript to search. */
/** Search reads Claude's and Codex's transcripts; a Grok pane has no transcript to search. */
function searchableSessions(topology: SessionTopology): ReturnType<typeof paneSessions> {
  const sessions = paneSessions(topology);
  for (const [paneID, session] of Object.entries(sessions)) if (session?.ref.format === "grok") sessions[paneID] = null;
  return sessions;
}

const unsearched = (mac: MacEntry): number => mac.panes.filter((pane) => pane.kind !== "" && pane.session === null).length;

function status(id: string, name: string, phase: SearchMacPhase, unsearchedPanes = 0): SearchMacStatus {
  return { id, name, phase, truncated: false, skippedPanes: 0, unsearchedPanes };
}

export class SearchService {
  private readonly sessions = new Map<number, Session>();

  constructor(
    private readonly hosts: SearchHosts,
    private readonly channel: string,
    private readonly timeoutMs: number = searchBounds.timeoutMs,
    /** 0 starts at once (tests). */
    private readonly pauseMs: number = searchBounds.pauseMs,
  ) {}

  /** The query as typed: cancels the old search now, searches every machine after the pause; too short clears. */
  search(owner: SearchOwner, text: string): void {
    const session = this.session(owner);
    this.refreshMacs(session, false);
    const query = SearchQuery.make(text);
    if (query === null) {
      this.cancelAll(session);
      session.query = null;
      session.expanded.clear();
      for (const mac of session.macs) {
        mac.update = null;
        mac.status = status(mac.id, mac.name, mac.remote === null ? "offline" : "waiting");
      }
      this.publish(session);
      return;
    }
    if (session.query !== null && session.query.text === query.text) {
      this.publish(session);
      return;
    }
    this.cancelAll(session);
    session.query = query;
    session.expanded.clear();
    if (this.pauseMs <= 0) {
      for (const mac of session.macs) this.start(session, mac);
    } else {
      for (const mac of session.macs) mac.status = status(mac.id, mac.name, mac.remote === null ? "offline" : "searching", unsearched(mac));
      session.timer = setTimeout(() => {
        session.timer = null;
        if (this.sessions.get(owner.id) !== session) return;
        for (const mac of session.macs) this.start(session, mac);
        this.publish(session);
      }, this.pauseMs);
    }
    this.publish(session);
  }

  /** "N more in this pane": every match the pane has. */
  expand(owner: SearchOwner, macID: string, paneID: string): void {
    const session = this.sessions.get(owner.id);
    if (session === undefined) return;
    session.expanded.add(macID + "|" + paneID);
    this.publish(session);
    session.macs.find((mac) => mac.id === macID)?.run?.expand(paneID);
  }

  /** The machine's search again ("Try again"). */
  retry(owner: SearchOwner, macID: string): void {
    const session = this.sessions.get(owner.id);
    const mac = session?.macs.find((candidate) => candidate.id === macID);
    if (session === undefined || mac === undefined || session.query === null || session.timer !== null) return;
    this.start(session, mac);
    this.publish(session);
  }

  /** The screen went away: every command and read stops. */
  close(owner: { readonly id: number }): void {
    const session = this.sessions.get(owner.id);
    if (session === undefined) return;
    this.cancelAll(session);
    this.sessions.delete(owner.id);
  }

  closeAll(): void {
    for (const session of this.sessions.values()) this.cancelAll(session);
    this.sessions.clear();
  }

  /** Machines changed (the registry's onChange): one that connected or went offline searches again. */
  hostsChanged(): void {
    for (const session of Array.from(this.sessions.values())) {
      if (session.owner.isDestroyed()) {
        this.close(session.owner);
        continue;
      }
      this.refreshMacs(session, true);
    }
  }

  /** What the window is shown now (tests). */
  state(owner: { readonly id: number }): SearchViewState {
    const session = this.sessions.get(owner.id);
    return session === undefined ? emptySearchState : this.view(session);
  }

  private session(owner: SearchOwner): Session {
    let session = this.sessions.get(owner.id);
    if (session === undefined) {
      session = { owner, query: null, macs: [], expanded: new Set(), last: "", timer: null };
      this.sessions.set(owner.id, session);
    }
    return session;
  }

  /** The machines to search, in the sidebar's order; `restart` searches again those whose connection changed. */
  private refreshMacs(session: Session, restart: boolean): void {
    const old = new Map(session.macs.map((mac) => [mac.id, mac]));
    const next: MacEntry[] = [];
    const again: MacEntry[] = [];
    for (const host of this.hosts.list()) {
      const backend = this.hosts.backend(host.id);
      const runner = backend?.commands?.() ?? null;
      const reader = backend?.transcripts() ?? null;
      const online = host.state === "connected" && host.topology !== null && runner !== null && reader !== null;
      const remote: SearchRemote | null = online ? { run: (command, max, signal) => runner.run(command, max, signal), read: (path, offset, max) => reader.read(path, offset, max) } : null;
      const panes =
        host.topology === null ? [] : awayPanes(sidebarInputFromTopology(host.topology, { macID: host.id, nowUnixMs: Date.now() }), searchableSessions(host.topology));
      const connectionKey = online ? "online" : "offline";
      const before = old.get(host.id);
      if (before === undefined) {
        const mac: MacEntry = {
          id: host.id,
          name: host.name,
          panes,
          remote,
          connectionKey,
          run: null,
          update: null,
          status: status(host.id, host.name, remote === null ? "offline" : "waiting"),
          serial: 0,
        };
        next.push(mac);
        if (session.query !== null) again.push(mac);
        continue;
      }
      old.delete(host.id);
      // A pane's name or a new pane changes nothing searched now.
      before.name = host.name;
      before.panes = panes;
      const changed = before.connectionKey !== connectionKey;
      before.remote = remote;
      before.connectionKey = connectionKey;
      next.push(before);
      if (changed && session.query !== null) again.push(before);
    }
    for (const gone of old.values()) this.cancel(gone);
    session.macs = next;
    // In the pause, the timer starts every machine.
    for (const mac of again) {
      if (session.timer === null) this.start(session, mac);
      else mac.status = status(mac.id, mac.name, mac.remote === null ? "offline" : "searching", unsearched(mac));
    }
    if (restart) this.publish(session);
  }

  private start(session: Session, mac: MacEntry): void {
    this.cancel(mac);
    mac.update = null;
    const serial = mac.serial;
    const query = session.query;
    if (query === null) {
      mac.status = status(mac.id, mac.name, mac.remote === null ? "offline" : "waiting", unsearched(mac));
      return;
    }
    if (mac.remote === null) {
      mac.status = status(mac.id, mac.name, "offline", unsearched(mac));
      return;
    }
    const targets = mac.panes.flatMap((pane) => (pane.session === null ? [] : [{ paneID: pane.paneID, session: pane.session.ref }]));
    if (targets.length === 0) {
      mac.status = status(mac.id, mac.name, "done", unsearched(mac));
      return;
    }
    mac.status = status(mac.id, mac.name, "searching", unsearched(mac));
    const run = new SearchRun(query, targets, mac.remote, this.timeoutMs);
    mac.run = run;
    run.onUpdate((update) => {
      if (mac.serial !== serial || mac.run !== run) return;
      const phase: SearchMacPhase = update.phase === "reading" ? "searching" : update.phase;
      mac.status = { ...mac.status, phase, truncated: update.truncated, skippedPanes: update.skippedPanes };
      mac.update = update;
      this.publish(session);
    });
    run.start();
  }

  private cancel(mac: MacEntry): void {
    mac.serial += 1;
    mac.run?.cancel();
    mac.run = null;
  }

  private cancelAll(session: Session): void {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    for (const mac of session.macs) this.cancel(mac);
  }

  private view(session: Session): SearchViewState {
    return {
      searched: session.query?.text ?? null,
      statuses: session.macs.map((mac) => mac.status),
      groups: buildGroups(
        session.macs.map((mac) => ({
          id: mac.id,
          name: mac.name,
          panes: mac.panes.map((pane) => ({ id: pane.paneID, name: pane.name, kind: pane.kind === "" ? null : pane.kind, folder: pane.folder })),
          update: mac.update,
        })),
        session.expanded,
      ),
    };
  }

  private publish(session: Session): void {
    if (session.owner.isDestroyed()) return;
    const state = this.view(session);
    const key = JSON.stringify(state);
    if (key === session.last) return;
    session.last = key;
    session.owner.send(this.channel, state);
  }
}
