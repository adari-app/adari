// What the shell needs from one machine, whatever serves it. Three things sit
// behind this today or later: the Herdr TUI server over SSH (implemented here),
// the demo host (src/main/demo), and herdr-core (an interface only, in
// core-backend.ts, for the TS port of the Swift herdr-core client).
//
// The Herdr TUI backend opens every connection through one
// function (its route's connect): connectSsh for a saved machine, or This
// Mac's local session (local.ts connectLocal, this-mac.ts). Requests, the
// event stream, terminals, Chat's reads, uploads, the sweep and Changes' git
// run unchanged on either.

import type { TranscriptFileReader } from "../../shared/chat/feed";
import type { TranscriptSessionRef } from "../../shared/chat/locator";
import type { PaneLayout } from "../../shared/pane-layout";
import { maximumStartCommandsBytes, readFirstStartCommandsFile, type AgentStartCommands } from "../../shared/start-commands";
import type { ReadOnlyCommandRunner } from "../../shared/changes/reader";
import type { RemoteCommandRunner } from "../../shared/remote-command";
import type { Client } from "ssh2";

import { SshTranscriptReader } from "../chat/ssh-reader";
import { sftpStartCommandsFiles } from "../start-commands-sftp";
import { saveStartCommand } from "../start-commands-write";
import { browseFolder, folderBrowseTimeoutMs, sftpFolderReader } from "../folder-browse";
import type { FolderListing } from "../../shared/folder-browse";
import { ssh2UploadSftp } from "../uploads/sftp";
import { removeUpload, uploadAttachment, type RemoteAttachment, type UploadSftp } from "../uploads/upload";
import { HerdrClient } from "./client";
import { openRelayEventStream, openSshEventStream, subscribeRequestLine, type EventSink, type EventSubscription, type PaneSubscription } from "./events";
import { relayScript as shippedRelayScript } from "./relay-script";
import type { NewAgentHerdr } from "./new-agent";
import type { SplitParams } from "./pane-methods";
import type { PinningHostKeyPolicy } from "./host-key-pinning";
import { SshHerdrTransport, SshTerminalSession, attachTargetFor, connectSsh, type SshHostConfig, type TerminalSink } from "./ssh";
import type { TerminalDimensions } from "./terminal";
import type { RelayClient } from "./relay";
import type { HerdrTransport, RoundTripOptions } from "./transport";
import type { IntegrationInfo, PaneZoom, SessionTopology, SplitRatioLayout, TopologyPaneInfo } from "./wire";

export type { TerminalSink } from "./ssh";

export interface TerminalHandle {
  /** Keys from the terminal view. */
  input(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /**
   * The page's terminal parsed `bytes` more of what the sink was given, in order. A
   * stream credited by its reader (herdr-core's attach) is credited only for these; absent where none is.
   */
  parsed?(bytes: number): void;
}

export type BackendKind = "herdr-tui" | "herdr-core" | "demo";

/** The app's uploads to one machine (src/main/uploads): an attachment, and the 30-day sweep's file access. */
export interface HostUploads {
  /** A key per machine account (user@host:port): the sweep runs once a day per key. */
  readonly machineKey: string;
  /** Uploads one attachment to the private folder scheme; its path on the machine. A stop (`signal`) sends no further request. */
  upload(data: Uint8Array, extension: string, signal?: AbortSignal): Promise<RemoteAttachment>;
  /** × on a chip already on the machine: that upload goes (upload.ts removeUpload), under one deadline. */
  discard?(path: string): Promise<void>;
  /** Runs `work` with the machine's file access (the upload sweep). */
  withFiles<T>(work: (sftp: UploadSftp) => Promise<T>): Promise<T>;
}

/** An upload's deadline, connecting included: 12 MB over a slow link. */
export const uploadTimeoutMs = 120_000;
/** The sweep's deadline. */
export const sweepTimeoutMs = 120_000;
/** One start-command save's deadline, connecting included (a few small requests). */
export const startCommandSaveTimeoutMs = 20_000;
/** One removal's deadline, connecting included (RemoteAttachmentUploadOperation.cleanupTimeoutNanoseconds). */
export const discardTimeoutMs = 40_000;

/** The pane layout calls (src/main/herdr/pane-methods.ts); HerdrClient has them. */
export interface PaneLayoutHerdr {
  paneLayout(paneID: string): Promise<PaneLayout>;
  splitPane(split: SplitParams): Promise<TopologyPaneInfo>;
  setSplitRatio(tabID: string, path: readonly boolean[], ratio: number): Promise<SplitRatioLayout>;
  zoomPane(paneID: string, zoomed: boolean): Promise<PaneZoom>;
  closePane(paneID: string): Promise<void>;
  /** `pane.rename` (null clears the label); absent where the backend cannot rename. */
  renamePane?(paneID: string, label: string | null): Promise<void>;
  /** `tab.rename` (a name, never null); absent where the backend cannot rename. */
  renameTab?(tabID: string, label: string): Promise<void>;
  /** `workspace.rename`; absent where the backend cannot rename. */
  renameWorkspace?(workspaceID: string, label: string): Promise<void>;
}

/** The two pane calls the needs-you card makes (HerdrClient.paneRead, paneSendKeys). */
export interface PromptPaneCalls {
  paneRead(pane: string, lines: number): Promise<string>;
  paneSendKeys(pane: string, keys: readonly string[]): Promise<void>;
}

/** Herdr's integration calls (HerdrClient has them). */
export interface IntegrationHerdr {
  integrationList(): Promise<IntegrationInfo[]>;
  integrationInstall(target: string): Promise<string[]>;
}

export interface HerdrHostBackend {
  readonly kind: BackendKind;
  /** Workspaces, tabs, panes and agents with their status, in one view. */
  snapshot(): Promise<SessionTopology>;
  /** Writes `text` in one `pane.send_input` and presses `keys`. */
  sendInput(paneID: string, text: string, keys: readonly string[]): Promise<void>;
  /** Herdr's `agent.prompt` to the pane's agent. */
  prompt(paneID: string, text: string): Promise<void>;
  /** `pane.send_text`: the text, nothing pressed. */
  sendText(paneID: string, text: string): Promise<void>;
  /** `agent.send_keys`: refused by Herdr unless an agent runs in the pane. */
  agentKeys(paneID: string, keys: readonly string[]): Promise<void>;
  /** A pane's last `lines` lines as plain text (`pane.read`), the update mark's short read; absent where it cannot read. */
  paneText?(paneID: string, lines: number): Promise<string>;
  /** Reads the machine's agent transcripts for Chat (read only); null when it cannot. */
  transcripts(): TranscriptFileReader<TranscriptSessionRef> | null;
  /** Uploads to the machine, over the transcript reader's SFTP connection; absent or null when it cannot. */
  uploads?(): HostUploads | null;
  /** The Mac's `~/.adari/agents.json`, else the old `~/.herdr-companion/agents.json` (read only; null: none); absent when the backend cannot read files. */
  readStartCommandsFile?(): Promise<Uint8Array | null>;
  /**
   * Settings › Chat saves `kind`'s start command (empty: none) into `~/.adari/agents.json`
   * (start-commands-write.ts); the file as the reader reads it after. Absent where the backend cannot write files.
   */
  saveStartCommand?(kind: string, command: string): Promise<AgentStartCommands>;
  /**
   * The folders in one folder on the machine (`directory` as typed, ending in "/"; "~/" its home),
   * for New workspace's and New agent's folder field; read only (src/main/folder-browse.ts). Absent where it cannot.
   */
  browseFolder?(directory: string): Promise<FolderListing>;
  /**
   * The machine's home folder, the one the folder list reads for `~/` (the reader's
   * `home()`), so a `~` folder goes to Herdr as a whole path (folder-cwd.ts). Absent where it cannot say.
   */
  homeFolder?(): Promise<string>;
  /**
   * `integration.list` and `integration.install` on the command connection
   * (src/main/integrations.ts); absent where Herdr gives none (herdr-core).
   */
  integrations?(): IntegrationHerdr;
  /** The Herdr calls New agent makes (tab.create, agent.start, …); absent where it cannot start one. */
  workspaceActions?(): NewAgentHerdr;
  /** Runs Changes' read-only git commands on the machine; none when it cannot. */
  changesRunner?(): ReadOnlyCommandRunner | null;
  /** Runs read-only commands (git log, grep) for the away digest and search; null or absent when it cannot. */
  commands?(): RemoteCommandRunner | null;
  /** A tab's split panes: its layout (and, for the window's actions, split, resize, zoom, close); absent where Herdr gives none. */
  paneActions?(): PaneLayoutHerdr;
  /**
   * The pane's screen as plain text (`pane.read`, source
   * recent) and keys pressed in the pane (`pane.send_keys`), the Swift app's
   * paneIO; absent where Herdr gives none.
   */
  promptIO?(): PromptPaneCalls;
  /** Herdr's event stream for `kinds` (`events.subscribe`); absent where there is none. */
  subscribeEvents?(kinds: readonly string[], sink: EventSink): EventSubscription;
  /**
   * The sidebar's events (`kinds`, and `panes`' pane-scoped ones) on the command
   * connection's relay only: with no relay it ends at once (EventSink.ended with relayOffReason) and the
   * sidebar polls instead; never a connection of its own. Absent where there is none.
   */
  subscribeSidebar?(kinds: readonly string[], panes: readonly PaneSubscription[], sink: EventSink): EventSubscription;
  /** A window on screen or not (`visible`, `hidden`), or focus or wake (`wake`: the 2 s ping). */
  liveness?(event: "visible" | "hidden" | "wake"): void;
  /** Attaches one pane; bytes go to `sink` until the handle is closed or the attach ends. */
  /**
   * `signal`: aborted when the page that asked goes before the terminal opened; a
   * backend that waits to open (herdr-core's first paint) stops then and keeps nothing open.
   */
  openTerminal(pane: TopologyPaneInfo, size: TerminalDimensions, sink: TerminalSink, signal?: AbortSignal): Promise<TerminalHandle>;
  /**
   * The epoch of the connection its requests go on now
   * (HerdrTransport.connectionEpoch); a pane action is bound to it. Null
   * while none is held. Absent where requests hold no connection (the demo):
   * one connection for the backend's life.
   */
  connectionEpoch?(): number | null;
  /**
   * A snapshot the app delivered (HostRegistry, as it applies it, in delivery
   * order, before anything awaits): a host with herdr-core numbers it and its finder looks up the sessions of
   * core Claude and Codex panes whose argv names none. Absent where there is no core.
   */
  observeSnapshot?(topology: SessionTopology): void;
  /** Drops held connections. */
  close(): void;
}

/** Opens one client for a backend's connection: connectSsh, or This Mac's local session. */
export type ClientConnector = (config: SshHostConfig, policy: PinningHostKeyPolicy) => Promise<Client>;

/** How a Herdr TUI backend reaches its machine; SSH when left out. */
export interface HerdrTuiRoute {
  /** Opens every connection (the command connection, each event stream, each terminal, the transcript reader's). */
  readonly connect?: ClientConnector;
  /** The upload sweep's key for the machine (default user@host:port). */
  readonly machineKey?: string;
  /** The command connection's deadline for one request (default defaultRoundTripTimeoutMs, as for SSH). */
  readonly roundTripTimeoutMs?: number;
  /**
   * The relay script for the command connection (default: relay-script.ts's for SSH, none
   * for a route with its own connect, This Mac's local session, which keeps its local path).
   */
  readonly relayScript?: string;
  /** The relay's hello deadline (tests). */
  readonly relayHelloMs?: number;
  /** The transport HerdrClient sends on, made from the SSH one (a herdr-core host's merge, core-host.ts); default the SSH transport. */
  readonly transport?: (ssh: SshHerdrTransport) => HerdrTransport;
  /** The relay Chat's reads use while the command connection has none (a herdr-core host's reads relay). */
  readonly readsRelay?: () => Promise<RelayClient | null>;
}

/** The Herdr TUI server over SSH, protocol 22 (CitadelTransport's route), or over This Mac's local session. */
export class HerdrTuiBackend implements HerdrHostBackend {
  readonly kind = "herdr-tui" as const;
  private readonly transport: SshHerdrTransport;
  private readonly client: HerdrClient;
  private readonly terminals = new Set<SshTerminalSession>();
  private readonly streams = new Set<EventSubscription>();
  private reader: SshTranscriptReader | null = null;
  private readonly connect: ClientConnector;
  /** The command connection starts the relay. */
  private readonly relayOn: boolean;

  constructor(
    private readonly config: SshHostConfig,
    private readonly policy: PinningHostKeyPolicy,
    private readonly route: HerdrTuiRoute = {},
  ) {
    const connect = route.connect;
    this.connect = connect ?? ((c, p) => connectSsh(c, p));
    const script = route.relayScript ?? (connect === undefined ? shippedRelayScript : "");
    this.transport = new SshHerdrTransport(config, policy, {
      ...(connect === undefined ? {} : { connect: (c, p) => connect(c, p) }),
      ...(route.roundTripTimeoutMs === undefined ? {} : { roundTripTimeoutMs: route.roundTripTimeoutMs }),
      ...(script === "" ? {} : { relayScript: script }),
      ...(route.relayHelloMs === undefined ? {} : { relayHelloMs: route.relayHelloMs }),
    });
    this.relayOn = script !== "";
    this.client = new HerdrClient(route.transport?.(this.transport) ?? this.transport);
  }

  /** `options`: This Mac's deadline (a saved machine passes none). */
  snapshot(options?: RoundTripOptions): Promise<SessionTopology> {
    return this.client.sessionTopology(options);
  }

  paneText(paneID: string, lines: number): Promise<string> {
    return this.client.paneText(paneID, lines);
  }

  /** The SSH command connection's epoch (a new number for every SSH client the transport opens). */
  connectionEpoch(): number | null {
    return this.transport.connectionEpoch();
  }

  sendInput(paneID: string, text: string, keys: readonly string[]): Promise<void> {
    return this.client.sendInput(paneID, text, keys);
  }

  prompt(paneID: string, text: string): Promise<void> {
    return this.client.prompt(paneID, text);
  }

  sendText(paneID: string, text: string): Promise<void> {
    return this.client.sendText(paneID, text);
  }

  agentKeys(paneID: string, keys: readonly string[]): Promise<void> {
    return this.client.agentSendKeys(paneID, keys);
  }

  workspaceActions(): NewAgentHerdr {
    return this.client;
  }

  /** On the command connection. */
  integrations(): IntegrationHerdr {
    return this.client;
  }

  paneActions(): PaneLayoutHerdr {
    return this.client;
  }

  /** `pane.read` and `pane.send_keys` on the command connection. */
  promptIO(): PromptPaneCalls {
    return this.client;
  }

  /**
   * A relay `stream` on the command connection while it has a relay; otherwise its own SSH
   * connection per stream (CitadelTransport.stream). Closed with the backend.
   */
  subscribeEvents(kinds: readonly string[], sink: EventSink): EventSubscription {
    return this.held((tracked) =>
      this.relayOn
        ? openRelayEventStream(() => this.transport.openRelay(), subscribeRequestLine(kinds), tracked, (fallback) =>
            openSshEventStream(this.config, this.policy, kinds, fallback, this.connect),
          )
        : openSshEventStream(this.config, this.policy, kinds, tracked, this.connect),
    sink);
  }

  /** The sidebar's events, on the relay only (relay off: ended at once, nothing opened). */
  subscribeSidebar(kinds: readonly string[], panes: readonly PaneSubscription[], sink: EventSink): EventSubscription {
    const line = subscribeRequestLine(kinds, panes);
    return this.held((tracked) => openRelayEventStream(() => (this.relayOn ? this.transport.openRelay() : Promise.resolve(null)), line, tracked), sink);
  }

  /** The command connection's liveness (the relay's pings). */
  liveness(event: "visible" | "hidden" | "wake"): void {
    if (event === "wake") void this.transport.wake();
    else this.transport.setActive(event === "visible");
  }

  /** A stream kept in `streams` until it ends or is closed (the backend's close ends it); its end always comes after an await. */
  private held(open: (sink: EventSink) => EventSubscription, sink: EventSink): EventSubscription {
    let tracked: EventSubscription | null = null;
    const opened = open({
      started: () => sink.started(),
      event: (kind, pane) => sink.event(kind, pane),
      ended: (reason) => {
        if (tracked !== null) this.streams.delete(tracked);
        sink.ended(reason);
      },
    });
    tracked = opened;
    this.streams.add(opened);
    return {
      close: () => {
        this.streams.delete(opened);
        opened.close();
      },
    };
  }

  /** The start commands file, on the transcripts' SFTP connection (read only). */
  readStartCommandsFile(): Promise<Uint8Array | null> {
    return readFirstStartCommandsFile((path) => this.transcripts().readSmallFile(path, maximumStartCommandsBytes + 1));
  }

  /** The start-command save, on the transcripts' SFTP connection (as the read). */
  saveStartCommand(kind: string, command: string): Promise<AgentStartCommands> {
    return this.transcripts().withSftp("Saving the start commands", (sftp) => saveStartCommand(sftpStartCommandsFiles(sftp), kind, command), startCommandSaveTimeoutMs);
  }

  /** One folder's folders for the folder field, on the transcripts' SFTP connection (read only, as the start commands' read). */
  browseFolder(directory: string): Promise<FolderListing> {
    return this.transcripts().withSftp("Listing a folder", (sftp) => browseFolder(sftpFolderReader(sftp), directory), folderBrowseTimeoutMs);
  }

  /** The home the folder list reads `~/` as (the same reader, the same SFTP connection). */
  homeFolder(): Promise<string> {
    return this.transcripts().withSftp("Reading the home folder", (sftp) => sftpFolderReader(sftp).home(), folderBrowseTimeoutMs);
  }

  /** Its own SSH connection with SFTP, opened on first use; transcript reads and watches go on the relay while it is up. */
  transcripts(): SshTranscriptReader {
    const fallback = this.route.readsRelay;
    const relay = this.relayOn
      ? fallback === undefined
        ? () => this.transport.readyRelay()
        : async () => (await this.transport.readyRelay()) ?? (await fallback())
      : fallback;
    this.reader ??= new SshTranscriptReader(this.config, this.policy, {
      connect: this.connect,
      ...(relay === undefined ? {} : { relay }),
    });
    return this.reader;
  }

  /** Over the transcript reader's connection (the existing SFTP session), opened on first use. */
  uploads(): HostUploads {
    const reader = this.transcripts();
    return {
      machineKey: this.route.machineKey ?? `${this.config.username}@${this.config.host}:${this.config.port}`,
      upload: (data, extension, signal) =>
        reader.withSftp(
          "Uploading the attachment",
          (sftp) => uploadAttachment(ssh2UploadSftp(sftp), data, extension, undefined, signal === undefined ? {} : { signal }),
          uploadTimeoutMs,
        ),
      discard: (path) => reader.withSftp("Removing the attachment", (sftp) => removeUpload(ssh2UploadSftp(sftp), path), discardTimeoutMs),
      withFiles: (work) => reader.withSftp("Cleaning up old uploads", (sftp) => work(ssh2UploadSftp(sftp)), sweepTimeoutMs),
    };
  }

  /** Changes' git runs over the transcript connection (one exec per command). */
  changesRunner(): SshTranscriptReader {
    return this.transcripts();
  }

  /** git log and grep over the transcripts' own SSH connection. */
  commands(): RemoteCommandRunner {
    return this.transcripts();
  }

  async openTerminal(pane: TopologyPaneInfo, size: TerminalDimensions, sink: TerminalSink): Promise<TerminalHandle> {
    const target = attachTargetFor(pane);
    if (target === null) throw new Error("This pane has no terminal to attach.");
    const session = new SshTerminalSession(
      this.config,
      this.policy,
      target,
      size,
      {
        data: (bytes) => sink.data(bytes),
        exit: (reason) => {
          this.terminals.delete(session);
          sink.exit(reason);
        },
      },
      this.connect,
    );
    this.terminals.add(session);
    try {
      await session.start();
    } catch (error) {
      this.terminals.delete(session);
      session.close();
      throw error;
    }
    return {
      input: (data) => session.send(data),
      resize: (cols, rows) => session.resize(cols, rows),
      close: () => {
        this.terminals.delete(session);
        session.close();
      },
    };
  }

  close(): void {
    for (const session of this.terminals) session.close();
    this.terminals.clear();
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.transport.close();
    this.reader?.close();
    this.reader = null;
  }
}
