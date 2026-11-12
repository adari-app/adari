// A saved machine's backend when it may run either kind of Herdr, or both
// (the Swift client's CoreHostTransport.host). The Herdr TUI backend as
// today, with HerdrClient sending on a CoreHostTransport: the TUI server's
// answer first, herdr-core's spaces after it, and every request routed by its
// ids (`hc:` goes to the core). herdr-core runs on its own SSH client (`hc
// connect`, the same config and host-key pinning). Chat's reads, uploads, the
// start commands file, Changes and search stay on the host's one SSH reader;
// a host with herdr-core and no Herdr socket gets a reads-only relay (the same
// relay script, no socket) so Chat's relay reads apply there too.

import type { Client } from "ssh2";
import type { TranscriptFileReader } from "../../shared/chat/feed";
import type { TranscriptSessionRef } from "../../shared/chat/locator";
import type { ReadOnlyCommandRunner } from "../../shared/changes/reader";
import type { RemoteCommandRunner } from "../../shared/remote-command";
import type { FolderListing } from "../../shared/folder-browse";
import type { AgentStartCommands } from "../../shared/start-commands";
import {
  HerdrTuiBackend,
  type HerdrHostBackend,
  type HerdrTuiRoute,
  type HostUploads,
  type PaneLayoutHerdr,
  type PromptPaneCalls,
  type TerminalHandle,
  type TerminalSink,
} from "./backend";
import { HerdrCoreBackend, coreChangeEvents, type HerdrCoreBackendOptions } from "./core-backend";
import type { CoreLink } from "./core-connection";
import type { CoreFollowerOptions } from "./core-follower";
import { CoreHostTransport, type CoreHostOptions } from "./core-host-transport";
import { CoreIDs } from "./core-model";
import { sameProjection, type CoreProjection } from "./core-projection";
import type { CoreBackoff } from "./core-session";
import { CoreSessionFinder, coreTranscriptLocator, type CoreFound, type CoreTranscriptLocating } from "./core-session-finder";
import { coreFolderKinds } from "../../shared/chat/core-pane-session";
import { sshCoreLink } from "./core-ssh";
import type { EventSink, EventSubscription, PaneSubscription } from "./events";
import type { PinningHostKeyPolicy } from "./host-key-pinning";
import type { NewAgentHerdr } from "./new-agent";
import { relayReadsLaunchCommand, type RelayClient } from "./relay";
import { relayScript as shippedRelayScript } from "./relay-script";
import { SshHerdrTransport, connectSsh, type SshHostConfig } from "./ssh";
import type { TerminalDimensions } from "./terminal";
import type { RoundTripOptions } from "./transport";
import type { SessionTopology, TopologyPaneInfo } from "./wire";

export interface HerdrMachineOptions {
  /** The TUI side's route (tests: the connect seam, the relay script). */
  readonly route?: HerdrTuiRoute;
  /** A new link to the host's herdr-core (default: `hc connect` on its own SSH client, this config and pinning). */
  readonly coreLink?: () => CoreLink | Promise<CoreLink>;
  readonly host?: CoreHostOptions;
  readonly backoff?: CoreBackoff;
  readonly sleep?: (seconds: number) => Promise<void>;
  readonly follower?: CoreFollowerOptions;
  readonly act?: HerdrCoreBackendOptions["act"];
  readonly attach?: HerdrCoreBackendOptions["attach"];
  /** The core folder lookup (default: the host's read-only exec; tests: a fake). */
  readonly coreLookup?: CoreTranscriptLocating;
}

/**
 * The desktop's first look does not wait for herdr-core once the TUI server answered (iOS waits up
 * to 3 s): a TUI host's first snapshot and the cold-open timings stay as they were, and a core found a moment
 * later arrives as a change (the sidebar's events, or the poll).
 */
export const desktopCoreGraceSeconds = 0;

export class HerdrMachineBackend implements HerdrHostBackend {
  readonly kind = "herdr-tui" as const;
  readonly core: HerdrCoreBackend;
  readonly tui: HerdrTuiBackend;
  private hostTransport: CoreHostTransport | null = null;
  /** The reads-only relay's own command connection (used only while the host has herdr-core and no TUI server). */
  private readonly reads: SshHerdrTransport;
  /** The core view the last snapshot showed (a change after it, and before the sidebar's events start, is told then). */
  private shownCore: CoreProjection | null = null;
  private closed = false;
  /**
   * The finder for herdr-core Claude and Codex panes whose argv names no session
   * (core-session-finder.ts), for the backend's life: across the core's reconnects it keeps what each pane's runs
   * were found, so a later run never takes one up.
   */
  readonly finder: CoreSessionFinder;
  /** The last delivered snapshot had a core Claude or Codex pane (the next one, with none, still goes: what was given is taken back). */
  private hadCorePanes = false;
  /** The latest delivered snapshot's pass (tests wait for it). */
  lastPass: Promise<CoreFound[]> = Promise.resolve([]);

  constructor(config: SshHostConfig, policy: PinningHostKeyPolicy, options: HerdrMachineOptions = {}) {
    const route = options.route ?? {};
    const connect = route.connect;
    const open = (c: SshHostConfig, p: PinningHostKeyPolicy, timeoutMs?: number): Promise<Client> =>
      connect === undefined ? connectSsh(c, p, timeoutMs) : connect(c, p);
    const tui = (): HerdrTuiBackend => this.tui;
    const files = {
      transcripts: (): TranscriptFileReader<TranscriptSessionRef> | null => tui().transcripts(),
      uploads: (): HostUploads | null => tui().uploads(),
      readStartCommandsFile: (): Promise<Uint8Array | null> => tui().readStartCommandsFile(),
      saveStartCommand: (kind: string, command: string): Promise<AgentStartCommands> => tui().saveStartCommand(kind, command),
      browseFolder: (directory: string): Promise<FolderListing> => tui().browseFolder(directory),
      homeFolder: (): Promise<string> => tui().homeFolder(),
      changesRunner: (): ReadOnlyCommandRunner | null => tui().changesRunner(),
      commands: (): RemoteCommandRunner | null => tui().commands(),
    };
    this.core = new HerdrCoreBackend({
      makeLink: options.coreLink ?? (() => sshCoreLink(config, policy, open)),
      files,
      ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.follower === undefined ? {} : { follower: options.follower }),
      ...(options.act === undefined ? {} : { act: options.act }),
      ...(options.attach === undefined ? {} : { attach: options.attach }),
    });
    const script = route.relayScript ?? (connect === undefined ? shippedRelayScript : "");
    this.reads = new SshHerdrTransport(config, policy, {
      ...(connect === undefined ? {} : { connect: (c, p) => connect(c, p) }),
      ...(script === "" ? {} : { relayScript: script, relayLaunch: relayReadsLaunchCommand }),
      ...(route.relayHelloMs === undefined ? {} : { relayHelloMs: route.relayHelloMs }),
    });
    // The lookup runs on the host's own read-only exec (the TUI backend's
    // transcripts connection, as Changes' git does): no new remote primitive.
    this.finder = new CoreSessionFinder(
      { terminal: (address) => this.core.follower.terminal(address), setSession: (publication, address) => this.core.follower.setSession(publication, address) },
      options.coreLookup ?? coreTranscriptLocator(() => (this.closed ? null : this.tui.changesRunner())),
    );
    const hostOptions: CoreHostOptions = { coreGraceSeconds: desktopCoreGraceSeconds, ...options.host };
    this.tui = new HerdrTuiBackend(config, policy, {
      ...route,
      transport: (ssh) => {
        this.hostTransport = new CoreHostTransport(ssh, this.core.bridge, hostOptions);
        return this.hostTransport;
      },
      ...(script === "" ? {} : { readsRelay: () => this.readsRelay() }),
    });
  }

  /** The host's merge (what it found, where requests go). */
  get transport(): CoreHostTransport {
    if (this.hostTransport === null) throw new Error("the host transport is made with the TUI backend");
    return this.hostTransport;
  }

  /** Whether this host has herdr-core and no TUI server (everything goes to the core). */
  routesToCoreOnly(): boolean {
    return this.hostTransport?.routesToCoreOnly() ?? false;
  }

  /** The reads relay, only for a host whose TUI server is not there and whose core is (the TUI's relay serves the rest). */
  private async readsRelay(): Promise<RelayClient | null> {
    if (this.closed || !this.routesToCoreOnly()) return null;
    try {
      return await this.reads.openRelay();
    } catch {
      return null;
    }
  }

  async snapshot(options?: RoundTripOptions): Promise<SessionTopology> {
    const topology = await this.tui.snapshot(options);
    this.shownCore = this.core.follower.projection;
    return topology;
  }

  /**
   * As the Swift client's CompanionCoreSessions.observe: a snapshot the app delivered, numbered here,
   * as delivered, before the finder's pass carries it (the finder drops one older than a snapshot delivered since,
   * and the core takes nothing decided on it).
   */
  observeSnapshot(topology: SessionTopology): void {
    if (this.closed) return;
    const isCorePane = (paneID: string, agent: string | undefined): boolean =>
      CoreIDs.isCore(paneID) && coreFolderKinds.some((kind) => kind === agent?.toLowerCase());
    const corePanes = topology.panes.some((pane) => isCorePane(pane.paneID, pane.agent)) || topology.agents.some((agent) => isCorePane(agent.paneID, agent.agent));
    if (!corePanes && !this.hadCorePanes) return;
    this.hadCorePanes = corePanes;
    const sequence = this.finder.clock.next();
    this.lastPass = this.finder.observe(topology.agents, topology.panes, { sequence }).catch(() => []);
  }

  sendInput(paneID: string, text: string, keys: readonly string[]): Promise<void> {
    return this.tui.sendInput(paneID, text, keys);
  }

  prompt(paneID: string, text: string): Promise<void> {
    return this.tui.prompt(paneID, text);
  }

  sendText(paneID: string, text: string): Promise<void> {
    return this.tui.sendText(paneID, text);
  }

  agentKeys(paneID: string, keys: readonly string[]): Promise<void> {
    return this.tui.agentKeys(paneID, keys);
  }

  paneText(paneID: string, lines: number): Promise<string> {
    return this.tui.paneText(paneID, lines);
  }

  workspaceActions(): NewAgentHerdr {
    return this.tui.workspaceActions();
  }

  paneActions(): PaneLayoutHerdr {
    return this.tui.paneActions();
  }

  promptIO(): PromptPaneCalls {
    return this.tui.promptIO();
  }

  transcripts(): TranscriptFileReader<TranscriptSessionRef> | null {
    return this.tui.transcripts();
  }

  uploads(): HostUploads | null {
    return this.tui.uploads();
  }

  readStartCommandsFile(): Promise<Uint8Array | null> {
    return this.tui.readStartCommandsFile();
  }

  /** Settings › Chat's start-command save, on the TUI backend's SFTP connection. */
  saveStartCommand(kind: string, command: string): Promise<AgentStartCommands> {
    return this.tui.saveStartCommand(kind, command);
  }

  /** The folder field's listing, on the TUI backend's SFTP connection. */
  browseFolder(directory: string): Promise<FolderListing> {
    return this.tui.browseFolder(directory);
  }

  /** The home the folder list reads, on the TUI backend's SFTP connection. */
  homeFolder(): Promise<string> {
    return this.tui.homeFolder();
  }

  changesRunner(): ReadOnlyCommandRunner | null {
    return this.tui.changesRunner();
  }

  commands(): RemoteCommandRunner | null {
    return this.tui.commands();
  }

  subscribeEvents(kinds: readonly string[], sink: EventSink): EventSubscription {
    return this.routesToCoreOnly() ? coreChangeEvents(this.core.follower, sink) : this.tui.subscribeEvents(kinds, sink);
  }

  /**
   * The sidebar's events: a herdr-core-only host's from its core; otherwise the TUI server's relay stream as
   * today (its pane subscriptions for its own panes only), with a `pane.updated` for every core change: also a
   * core found after the first snapshot, or installed after a lookup found none, and a core lost while the TUI
   * stays.
   */
  subscribeSidebar(kinds: readonly string[], panes: readonly PaneSubscription[], sink: EventSink): EventSubscription {
    if (this.routesToCoreOnly()) return coreChangeEvents(this.core.follower, sink);
    const follower = this.core.follower;
    let over = false;
    // A lost core is told too (as Swift's merged watcher does), so its rows show it down
    // now rather than at the next poll; the TUI stream stays live.
    const unsubscribe = follower.changes(() => {
      if (!over) sink.event("pane.updated", null);
    });
    const stream = this.tui.subscribeSidebar(
      kinds,
      panes.filter((pane) => !CoreIDs.isCore(pane.paneId)),
      {
        started: () => {
          if (over) return;
          sink.started();
          // A core view that came after the last snapshot and before this stream: told now.
          if (follower.projection !== null && !sameProjection(follower.projection, this.shownCore)) sink.event("pane.updated", null);
        },
        event: (kind, pane) => {
          if (!over) sink.event(kind, pane);
        },
        ended: (reason) => {
          if (over) return;
          over = true;
          unsubscribe();
          sink.ended(reason);
        },
      },
    );
    return {
      close: () => {
        over = true;
        unsubscribe();
        stream.close();
      },
    };
  }

  liveness(event: "visible" | "hidden" | "wake"): void {
    this.tui.liveness(event);
    if (event === "wake") void this.reads.wake();
    else this.reads.setActive(event === "visible");
  }

  openTerminal(pane: TopologyPaneInfo, size: TerminalDimensions, sink: TerminalSink, signal?: AbortSignal): Promise<TerminalHandle> {
    return CoreIDs.isCore(pane.paneID) ? this.core.openTerminal(pane, size, sink, signal) : this.tui.openTerminal(pane, size, sink);
  }

  /** The pair of connections requests go on (the TUI's command connection and the core's): a new number when either changes. */
  connectionEpoch(): number | null {
    return this.hostTransport?.connectionEpoch() ?? this.tui.connectionEpoch();
  }

  close(): void {
    this.closed = true;
    this.finder.close();
    this.tui.close();
    this.core.close();
    this.reads.close();
  }
}
