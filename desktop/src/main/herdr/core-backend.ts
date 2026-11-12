// The second backend, herdr-core: the TS port of the Swift client
// (HerdrKit Core*.swift), so a herdr-core machine sits in the same sidebar as
// a Herdr TUI machine.
//
// `ssh host hc connect` speaks herdr-core over stdin/stdout (core-ssh.ts);
// `hello` (one line each way) picks plain JSON-RPC 2.0 lines or framed mode;
// framed mode carries `[channel u32 LE][kind u8][len u32 LE][payload ≤ 16 MiB]`,
// channel 0 for JSON-RPC, every other channel one stream (core-frames.ts,
// core-connection.ts). CoreSession keeps it connected; CoreFollower follows its
// events into the sidebar's model (core-model.ts, core-projection.ts); the
// bridge (core-bridge.ts) answers HerdrClient's protocol 22 lines from it, so
// every HerdrClient call (Send, the box, the needs-you card, New agent) runs
// unchanged against it.
//
// HerdrCoreBackend is one machine's herdr-core as a HerdrHostBackend. A saved
// machine runs either kind, or both: HerdrMachineBackend (core-host.ts) merges
// it with the TUI backend in one sidebar entry.

import type { TranscriptFileReader } from "../../shared/chat/feed";
import type { TranscriptSessionRef } from "../../shared/chat/locator";
import type { ReadOnlyCommandRunner } from "../../shared/changes/reader";
import type { RemoteCommandRunner } from "../../shared/remote-command";
import type { FolderListing } from "../../shared/folder-browse";
import type { AgentStartCommands } from "../../shared/start-commands";
import type { HerdrHostBackend, HostUploads, PaneLayoutHerdr, PromptPaneCalls, TerminalHandle, TerminalSink } from "./backend";
import { HerdrClient } from "./client";
import { coreActions } from "./core-actions";
import { CoreAttachSession, CoreTerminalError, type CoreAttachOptions } from "./core-attach";
import { CoreBridgeTransport, type CoreActionHandler } from "./core-bridge";
import type { CoreConnection, CoreLink } from "./core-connection";
import { CoreFollower, type CoreFollowerOptions } from "./core-follower";
import { CoreIDs } from "./core-model";
import { CoreBackoff, CoreSession } from "./core-session";
import type { EventSink, EventSubscription, PaneSubscription } from "./events";
import type { NewAgentHerdr } from "./new-agent";
import type { TerminalDimensions } from "./terminal";
import type { RoundTripOptions } from "./transport";
import type { SessionTopology, TopologyPaneInfo } from "./wire";

/** The machine's file side (Chat's reads, uploads, start commands, Changes, search): the SSH host's own reader. */
export interface CoreHostFiles {
  transcripts(): TranscriptFileReader<TranscriptSessionRef> | null;
  uploads?(): HostUploads | null;
  readStartCommandsFile?(): Promise<Uint8Array | null>;
  /** Settings › Chat's start-command save (the SSH host's own). */
  saveStartCommand?(kind: string, command: string): Promise<AgentStartCommands>;
  /** The folder field's listing (the SSH host's own). */
  browseFolder?(directory: string): Promise<FolderListing>;
  /** The machine's home folder (folder-cwd.ts). */
  homeFolder?(): Promise<string>;
  changesRunner?(): ReadOnlyCommandRunner | null;
  commands?(): RemoteCommandRunner | null;
}

export interface HerdrCoreBackendOptions {
  /** A new link to the core (hc connect on the host's own SSH client in the app; a fake core in tests). */
  readonly makeLink: () => CoreLink | Promise<CoreLink>;
  readonly backoff?: CoreBackoff;
  /** Waits between attempts (tests: a log). */
  readonly sleep?: (seconds: number) => Promise<void>;
  readonly helloTimeoutSeconds?: number;
  readonly follower?: CoreFollowerOptions;
  readonly files?: CoreHostFiles;
  /** The actions the bridge answers (default core-actions.ts's). */
  readonly act?: (follower: CoreFollower) => CoreActionHandler;
  /** Terminal attach waits (tests: short). */
  readonly attach?: CoreAttachOptions;
}

/** The core's change stream as the sidebar's events: started once a snapshot is there, `pane.updated` for every change, ended when the line goes. */
export function coreChangeEvents(follower: CoreFollower, sink: EventSink): EventSubscription {
  let over = false;
  const end = (reason: string | null): void => {
    if (over) return;
    over = true;
    unsubscribe();
    sink.ended(reason);
  };
  const unsubscribe = follower.changes((change) => {
    if (over) return;
    if (change.kind === "changed") sink.event("pane.updated", null);
    else end(change.reason);
  });
  void follower.snapshot().then(
    () => {
      if (!over) sink.started();
    },
    (error: unknown) => end(error instanceof Error ? error.message : String(error)),
  );
  return {
    close: () => {
      over = true;
      unsubscribe();
    },
  };
}

/** What opening a herdr-core terminal says when it stops before its first paint. */
export const coreTerminalText = {
  closedWhileOpening: "The terminal was closed before it opened.",
  noFirstPaint: (seconds: number): string => `herdr-core did not show this terminal within ${seconds} seconds, so it was not opened. Try again.`,
};

/** One machine's herdr-core, as a sidebar backend. */
export class HerdrCoreBackend implements HerdrHostBackend {
  readonly kind = "herdr-core" as const;
  readonly session: CoreSession;
  readonly follower: CoreFollower;
  readonly bridge: CoreBridgeTransport;
  private readonly client: HerdrClient;
  private readonly files: CoreHostFiles | undefined;
  private readonly attach: CoreAttachOptions | undefined;
  private readonly terminals = new Set<CoreAttachSession>();

  constructor(options: HerdrCoreBackendOptions) {
    this.session = new CoreSession({
      makeLink: options.makeLink,
      ...(options.backoff === undefined ? {} : { backoff: options.backoff }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.helloTimeoutSeconds === undefined ? {} : { helloTimeoutSeconds: options.helloTimeoutSeconds }),
    });
    this.follower = new CoreFollower(this.session, options.follower);
    this.bridge = new CoreBridgeTransport(this.follower, (options.act ?? coreActions)(this.follower));
    this.client = new HerdrClient(this.bridge);
    this.files = options.files;
    this.attach = options.attach;
  }

  /** The live connection now (null while none is). */
  get connection(): CoreConnection | null {
    return this.follower.liveConnection;
  }

  snapshot(options?: RoundTripOptions): Promise<SessionTopology> {
    return this.client.sessionTopology(options);
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

  paneText(paneID: string, lines: number): Promise<string> {
    return this.client.paneText(paneID, lines);
  }

  workspaceActions(): NewAgentHerdr {
    return this.client;
  }

  paneActions(): PaneLayoutHerdr {
    return this.client;
  }

  promptIO(): PromptPaneCalls {
    return this.client;
  }

  transcripts(): TranscriptFileReader<TranscriptSessionRef> | null {
    return this.files?.transcripts() ?? null;
  }

  uploads(): HostUploads | null {
    return this.files?.uploads?.() ?? null;
  }

  readStartCommandsFile(): Promise<Uint8Array | null> {
    return this.files?.readStartCommandsFile?.() ?? Promise.resolve(null);
  }

  saveStartCommand(kind: string, command: string): Promise<AgentStartCommands> {
    const save = this.files?.saveStartCommand;
    return save === undefined ? Promise.reject(new Error("This machine cannot save start commands from here.")) : save.call(this.files, kind, command);
  }

  browseFolder(directory: string): Promise<FolderListing> {
    const browse = this.files?.browseFolder;
    return browse === undefined ? Promise.resolve({ type: "unavailable" }) : browse.call(this.files, directory);
  }

  homeFolder(): Promise<string> {
    const home = this.files?.homeFolder;
    return home === undefined ? Promise.reject(new Error("this machine cannot say from here")) : home.call(this.files);
  }

  changesRunner(): ReadOnlyCommandRunner | null {
    return this.files?.changesRunner?.() ?? null;
  }

  commands(): RemoteCommandRunner | null {
    return this.files?.commands?.() ?? null;
  }

  subscribeEvents(_kinds: readonly string[], sink: EventSink): EventSubscription {
    return coreChangeEvents(this.follower, sink);
  }

  subscribeSidebar(_kinds: readonly string[], _panes: readonly PaneSubscription[], sink: EventSink): EventSubscription {
    return coreChangeEvents(this.follower, sink);
  }

  /**
   * The pane's terminal over its attach channel (core-attach.ts). Opens at the first
   * paint (or while a kept terminal waits for its new shell); a refused attach or a gone terminal throws, as a
   * TUI attach that cannot start does.
   *
   * Output is credited only as the page's terminal says it parsed it (the handle's
   * `parsed`), never as it is handed over: the core sends at most its window (256 KiB) beyond what was parsed, so
   * a page that is behind, hidden or still loading holds the core back (and gets a fresh repaint when more than
   * 4 MiB behind) instead of growing a backlog in main or the page.
   *
   * The opening stops when `signal` aborts (the page closed it first) or when no first
   * paint came within `firstPaintSeconds`; either way the attach is closed (one adopted later gets CLOSE).
   */
  async openTerminal(pane: TopologyPaneInfo, size: TerminalDimensions, sink: TerminalSink, signal?: AbortSignal): Promise<TerminalHandle> {
    const address = CoreIDs.address(pane.paneID);
    if (address === undefined) throw new Error("This pane has no terminal to attach.");
    if (signal?.aborted === true) throw new Error(coreTerminalText.closedWhileOpening);
    const session = new CoreAttachSession(this.follower, address, size.cols, size.rows, this.attach);
    this.terminals.add(session);
    let open = true;
    const end = (reason: string | null): void => {
      this.terminals.delete(session);
      if (!open) return;
      open = false;
      sink.exit(reason);
    };
    void (async () => {
      try {
        for await (const chunk of session.output) if (open) sink.data(chunk);
        end(null);
      } catch (error) {
        end(error instanceof CoreTerminalError ? error.message : error instanceof Error ? error.message : String(error));
      }
    })();
    const shut = (): void => {
      open = false;
      this.terminals.delete(session);
      session.close();
    };
    let stopped: string | null = null;
    const stop = (why: string): void => {
      stopped ??= why;
      shut();
    };
    const cancelled = (): void => stop(coreTerminalText.closedWhileOpening);
    const seconds = this.attach?.firstPaintSeconds ?? 30;
    const deadline = setTimeout(() => stop(coreTerminalText.noFirstPaint(seconds)), seconds * 1000);
    signal?.addEventListener("abort", cancelled, { once: true });
    session.start();
    try {
      await session.opened();
    } catch (error) {
      shut();
      throw new Error(stopped ?? (error instanceof Error ? error.message : String(error)));
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancelled);
    }
    return {
      input: (data) => session.send(data),
      resize: (cols, rows) => session.resize(cols, rows),
      close: shut,
      parsed: (bytes) => session.fed(bytes),
    };
  }

  connectionEpoch(): number | null {
    return this.follower.epoch;
  }

  close(): void {
    for (const session of this.terminals) session.close();
    this.terminals.clear();
    this.follower.close();
  }
}
