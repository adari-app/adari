// The layout of the tab each window shows, kept
// live: the window says which pane it shows; the tab's layout is read
// (`pane.layout`) and sent to the window, then read again when Herdr says it
// changed (`layout.updated`, and the pane created, closed and moved events on
// the machine's event stream, which also bring a snapshot so a new pane has
// its row), when a snapshot changes which panes the tab has, and after the
// window's own split, resize, zoom or close. While a machine's stream is down
// (or it has none) every snapshot reads the shown layout again. One stream per
// machine, held only while a window shows one of its tabs.

import type { LayoutUpdateEvent } from "../shared/ipc-contract";
import type { PaneLayout } from "../shared/pane-layout";
import type { HerdrHostBackend } from "./herdr/backend";
import type { EventSubscription } from "./herdr/events";
import { layoutEventKinds, paneSetEventKinds } from "./herdr/pane-methods";
import type { SessionTopology, TopologyPaneInfo } from "./herdr/wire";

/** What the service reads from the machines in the sidebar (HostRegistry has it). */
export interface LayoutHosts {
  backend(hostId: string): HerdrHostBackend | null;
  pane(hostId: string, paneId: string): TopologyPaneInfo | null;
  topology(hostId: string): SessionTopology | null;
  /** A snapshot now (a pane came or went). */
  refresh(hostId: string): Promise<void>;
}

/** A window's page, as the service needs it (Electron's WebContents fits). */
export interface LayoutOwner {
  readonly id: number;
  send(channel: string, payload: LayoutUpdateEvent): void;
  isDestroyed(): boolean;
}

export interface LayoutServiceOptions {
  /** Events within this long are one read. */
  readonly debounceMs?: number;
  /** The wait before subscribing again after the stream ended; it doubles up to maxRetryMs. */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
}

interface Watch {
  readonly owner: LayoutOwner;
  readonly hostId: string;
  /** The pane the window shows (the layout is asked for with it). */
  paneId: string;
  tabId: string | null;
  /** The tab's panes in the snapshot when it was last read. */
  paneSet: string;
  seq: number;
  layout: PaneLayout | null;
  error: string | null;
}

interface HostStream {
  subscription: EventSubscription | null;
  live: boolean;
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  debounce: ReturnType<typeof setTimeout> | null;
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export class LayoutService {
  private readonly watches = new Map<number, Watch>();
  private readonly streams = new Map<string, HostStream>();
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;

  constructor(
    private readonly hosts: LayoutHosts,
    private readonly channel: string,
    options: LayoutServiceOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 120;
    this.retryMs = options.retryMs ?? 2_000;
    this.maxRetryMs = options.maxRetryMs ?? 60_000;
  }

  /** The window shows `paneId` on `hostId` (null: nothing). Another pane of the same tab reads nothing again. */
  watch(owner: LayoutOwner, hostId: string | null, paneId: string | null): void {
    if (hostId === null || paneId === null) {
      this.drop(owner.id);
      return;
    }
    const tabId = this.hosts.pane(hostId, paneId)?.tabID ?? null;
    const current = this.watches.get(owner.id);
    if (current !== undefined && current.hostId === hostId && tabId !== null && current.tabId === tabId) {
      current.paneId = paneId;
      this.emit(current);
      return;
    }
    const watch: Watch = {
      owner,
      hostId,
      paneId,
      tabId,
      paneSet: this.paneSet(hostId, tabId),
      seq: current?.seq ?? 0,
      layout: null,
      error: null,
    };
    this.watches.set(owner.id, watch);
    this.ensureStream(hostId);
    if (current !== undefined && current.hostId !== hostId) this.releaseStream(current.hostId);
    void this.read(watch);
  }

  /** A new snapshot: a tab whose panes changed is read again (every shown tab while its stream is down). */
  refresh(): void {
    for (const watch of Array.from(this.watches.values())) {
      if (watch.owner.isDestroyed()) {
        this.drop(watch.owner.id);
        continue;
      }
      const pane = this.hosts.pane(watch.hostId, watch.paneId);
      const tabId = pane?.tabID ?? watch.tabId;
      const set = this.paneSet(watch.hostId, tabId);
      const moved = pane !== null && watch.tabId !== null && pane.tabID !== watch.tabId;
      const live = this.streams.get(watch.hostId)?.live === true;
      if (set === watch.paneSet && !moved && live) continue;
      if (pane === null) {
        // The shown pane is gone: ask with another of its tab until the window shows something else.
        const other = this.hosts.topology(watch.hostId)?.panes.find((candidate) => candidate.tabID === tabId);
        if (other === undefined) {
          if (watch.layout !== null || watch.error !== null) {
            watch.layout = null;
            watch.error = null;
            this.emit(watch);
          }
          watch.paneSet = set;
          continue;
        }
        watch.paneId = other.paneID;
      }
      watch.paneSet = set;
      void this.read(watch);
    }
  }

  /** Reads every shown layout on the machine again (after a split, resize, zoom or close); resolves once they answered. */
  async reread(hostId: string): Promise<void> {
    await Promise.all([...this.watches.values()].filter((watch) => watch.hostId === hostId).map((watch) => this.read(watch)));
  }

  /**
   * A layout Herdr sent with a reply (pane.zoom's): every window showing its
   * tab on the machine gets it at once, and a read still in flight for it is
   * dropped (it was asked before the change).
   */
  accept(hostId: string, layout: PaneLayout): void {
    for (const watch of Array.from(this.watches.values())) {
      if (watch.hostId !== hostId || watch.tabId !== layout.tabId) continue;
      watch.seq += 1;
      watch.layout = layout;
      watch.error = null;
      this.emit(watch);
    }
  }

  /** The layout the window was last sent, or null. */
  shown(owner: { readonly id: number }): PaneLayout | null {
    return this.watches.get(owner.id)?.layout ?? null;
  }

  /** What the window shows: the machine and the tab's layout it was last sent (null: it shows nothing). */
  watched(owner: { readonly id: number }): { readonly hostId: string; readonly layout: PaneLayout | null } | null {
    const watch = this.watches.get(owner.id);
    return watch === undefined ? null : { hostId: watch.hostId, layout: watch.layout };
  }

  /** The window went away. */
  close(owner: { readonly id: number }): void {
    this.drop(owner.id);
  }

  closeAll(): void {
    for (const id of Array.from(this.watches.keys())) this.drop(id);
    for (const hostId of Array.from(this.streams.keys())) this.stopStream(hostId);
  }

  private paneSet(hostId: string, tabId: string | null): string {
    if (tabId === null) return "";
    const topology = this.hosts.topology(hostId);
    return (topology?.panes ?? [])
      .filter((pane) => pane.tabID === tabId)
      .map((pane) => pane.paneID)
      .join("\n");
  }

  private async read(watch: Watch): Promise<void> {
    watch.seq += 1;
    const seq = watch.seq;
    const actions = this.hosts.backend(watch.hostId)?.paneActions?.() ?? null;
    let layout: PaneLayout | null = null;
    let error: string | null = null;
    if (actions === null) {
      error = "This machine does not give its pane layout.";
    } else {
      try {
        layout = await actions.paneLayout(watch.paneId);
      } catch (failure) {
        error = describe(failure);
      }
    }
    if (this.watches.get(watch.owner.id) !== watch || watch.seq !== seq) return;
    watch.layout = layout;
    watch.error = error;
    if (layout !== null) watch.tabId = layout.tabId;
    watch.paneSet = this.paneSet(watch.hostId, watch.tabId);
    this.emit(watch);
  }

  private emit(watch: Watch): void {
    if (watch.owner.isDestroyed()) return;
    watch.owner.send(this.channel, { hostId: watch.hostId, paneId: watch.paneId, tabId: watch.tabId, layout: watch.layout, error: watch.error });
  }

  private drop(ownerId: number): void {
    const watch = this.watches.get(ownerId);
    if (watch === undefined) return;
    this.watches.delete(ownerId);
    watch.seq += 1;
    this.releaseStream(watch.hostId);
  }

  // MARK: the machine's event stream

  private ensureStream(hostId: string): void {
    if (this.streams.has(hostId)) return;
    const stream: HostStream = { subscription: null, live: false, failures: 0, retry: null, debounce: null };
    this.streams.set(hostId, stream);
    this.subscribe(hostId, stream);
  }

  private subscribe(hostId: string, stream: HostStream): void {
    const backend = this.hosts.backend(hostId);
    if (backend?.subscribeEvents === undefined) return;
    const current = (): boolean => this.streams.get(hostId) === stream;
    stream.subscription = backend.subscribeEvents(layoutEventKinds, {
      started: () => {
        if (!current()) return;
        const wasDown = stream.failures > 0;
        stream.live = true;
        stream.failures = 0;
        // Back after a gap: what changed meanwhile was not heard.
        if (wasDown) this.schedule(hostId, stream);
      },
      event: (kind) => {
        if (!current() || !layoutEventKinds.includes(kind)) return;
        if (paneSetEventKinds.includes(kind)) void this.hosts.refresh(hostId).catch(() => undefined);
        this.schedule(hostId, stream);
      },
      ended: () => {
        if (!current()) return;
        stream.live = false;
        stream.subscription = null;
        const wait = Math.min(this.maxRetryMs, this.retryMs * 2 ** stream.failures);
        stream.failures += 1;
        stream.retry = setTimeout(() => {
          stream.retry = null;
          if (current()) this.subscribe(hostId, stream);
        }, wait);
      },
    });
  }

  /** One read for a burst of events. */
  private schedule(hostId: string, stream: HostStream): void {
    if (stream.debounce !== null) return;
    stream.debounce = setTimeout(() => {
      stream.debounce = null;
      if (this.streams.get(hostId) === stream) void this.reread(hostId);
    }, this.debounceMs);
  }

  private releaseStream(hostId: string): void {
    if ([...this.watches.values()].some((watch) => watch.hostId === hostId)) return;
    this.stopStream(hostId);
  }

  private stopStream(hostId: string): void {
    const stream = this.streams.get(hostId);
    if (stream === undefined) return;
    this.streams.delete(hostId);
    if (stream.retry !== null) clearTimeout(stream.retry);
    if (stream.debounce !== null) clearTimeout(stream.debounce);
    stream.subscription?.close();
    stream.subscription = null;
  }
}
