// The whole surface between the renderer and the main process. The preload
// exposes exactly these calls (src/preload/preload.ts) and the main process
// answers exactly these channels (src/main/ipc.ts), each checking that the
// sender is this app's own page. Nothing else crosses: no generic invoke,
// no Node in the renderer (contextIsolation on, sandbox on, nodeIntegration off).

import type { SessionTopology } from "../main/herdr/wire";
import type { SendBinding } from "./send-binding";
import type { RestartBinding } from "./agent-restart";
import type { StopBinding } from "./agent-stop";
import type { QueuedTakeBack } from "./claude-screen";
import type { PaneBinding, SplitPath, SplitShape, WorkspaceBinding } from "./pane-binding";
import type { AgentStartCommands } from "./start-commands";
import type { FolderListing } from "./folder-browse";
import type { FollowedSession } from "./pane-life";
import type { NewAgentRequest, NewAgentResult } from "../main/herdr/new-agent";
import type { CatalogAgent, CatalogView } from "./model-catalog";
import type { ModelPick } from "./model-choices";
import type { NewWorkspaceRequest, NewWorkspaceResult } from "./new-workspace";
import type { DrawerShellRequest, DrawerShellResult } from "../main/herdr/drawer-shell";
import type { ChatUnavailableReason } from "./chat/feed";
import type { GeminiFamilyAmbiguousReason } from "./chat/agents/gemini-family";
import type { KiroAmbiguousReason } from "./chat/agents/kiro-locate";
import type { ChatImageBlob, ChatTimeline } from "./chat/model";
import type { ChatLiveBlock } from "./chat/live-screen";
import type { ChangesCommitsState, ChangesGitState, ChangesOverviewHost, ChangesToolsState } from "./changes/content";
import type { GitText, GitTextResult } from "./changes/git";
import type { PaneLayout } from "./pane-layout";
import type { ViewCommand } from "./view-commands";
import type { AwayViewState } from "./away/digest";
import type { SearchViewState } from "./search/view";
import type { CursorFooter, CursorPick, GrokFiles, GrokPick, PaneSettings, SettingsScope } from "./agent-settings";
import type { ModeAgent } from "./approval-modes";
import type { CompactOutcome, DraftInput, DraftsChangedEvent, DraftsState, KeptDraft, KeptDraftAction } from "./drafts";
import type { UpdateView } from "./updates";
import type { AnswerRequest, AnswerResult, PanePrompt } from "./prompt/view";
import type { SettingsSection, UploadsDeleteResult, UploadsInventory } from "./settings";
import type { HostIntegrations, IntegrationBinding, IntegrationInstallReply } from "./integrations";
import type { HostStartScreens } from "./prompt/start-screen";

export const IPC = {
  appInfo: "herdr:app-info",
  hostsList: "herdr:hosts-list",
  hostsRefresh: "herdr:hosts-refresh",
  hostsChanged: "herdr:hosts-changed",
  hostsAdd: "herdr:hosts-add",
  hostsRemove: "herdr:hosts-remove",
  hostsPickKey: "herdr:hosts-pick-key",
  hostsUpdate: "herdr:hosts-update",
  hostsSettings: "herdr:hosts-settings",
  hostsRetry: "herdr:hosts-retry",
  /** Trust and connect, for a machine's new host key (its question's id, and its SHA256: fingerprint as shown). */
  hostsTrustKey: "herdr:hosts-trust-key",
  /** Cancel, for a machine's new host key (its question's id): nothing stored. */
  hostsCancelKey: "herdr:hosts-cancel-key",
  terminalOpen: "herdr:terminal-open",
  terminalInput: "herdr:terminal-input",
  terminalResize: "herdr:terminal-resize",
  terminalClose: "herdr:terminal-close",
  terminalData: "herdr:terminal-data",
  terminalExit: "herdr:terminal-exit",
  /** Bytes the page's terminal parsed, so a credited stream (herdr-core) sends more. */
  terminalParsed: "herdr:terminal-parsed",
  paneSend: "herdr:pane-send",
  paneStop: "herdr:pane-stop",
  paneStopIfWorking: "herdr:pane-stop-if-working",
  paneAfterStop: "herdr:pane-after-stop",
  /** Main to the page: a read after an Esc showed Claude's working line gone (EscScreenEvent). */
  paneEscScreen: "herdr:pane-esc-screen",
  paneQueued: "herdr:pane-queued",
  /** Your messages still waiting in Claude's queue, taken back (Up, then Ctrl+U). */
  paneTakeBack: "herdr:pane-take-back",
  paneRestart: "herdr:pane-restart",
  /** Main to the page: a note while a restart still runs (RestartNoteEvent). */
  paneRestartNote: "herdr:pane-restart-note",
  appCommand: "herdr:app-command",
  appCommandDone: "herdr:app-command-done",
  chatOpen: "herdr:chat-open",
  chatClose: "herdr:chat-close",
  chatEarlier: "herdr:chat-earlier",
  chatFollow: "herdr:chat-follow",
  chatUpdate: "herdr:chat-update",
  chatLive: "herdr:chat-live",
  /** A shown Cursor pane's footer (CursorFooterEvent), and a pick that drives its menu. */
  cursorFooter: "herdr:cursor-footer",
  cursorPick: "herdr:cursor-pick",
  /** An OpenCode model pick, driven through its own list in main. */
  openCodePick: "herdr:opencode-pick",
  grokPick: "herdr:grok-pick",
  /** A shown Claude or Grok pane's approval mode off its screen (PaneModeEvent), and a Permissions pick (ModePickResult). */
  paneMode: "herdr:pane-mode",
  modePick: "herdr:mode-pick",
  chatImage: "herdr:chat-image",
  chatBlobImage: "herdr:chat-blob-image",
  clipboardWrite: "herdr:clipboard-write",
  clipboardFiles: "herdr:clipboard-files",
  attachmentUpload: "herdr:attachment-upload",
  attachmentCancel: "herdr:attachment-cancel",
  attachmentDiscard: "herdr:attachment-discard",
  viewCommand: "herdr:view-command",
  ghosttyInfo: "herdr:ghostty-info",
  ghosttyOpen: "herdr:ghostty-open",
  startCommands: "herdr:start-commands",
  newAgent: "herdr:new-agent",
  /**
   * An agent's model list on a machine (machine id, agent: shared/model-catalog.ts
   * CatalogAgent), held or read on first ask (src/main/model-catalogs.ts); and each change of one (a read begun or
   * ended), as { hostId, view }.
   */
  modelCatalog: "herdr:model-catalog",
  modelCatalogChanged: "herdr:model-catalog-changed",
  modelPick: "herdr:model-pick",
  newWorkspace: "herdr:new-workspace",
  /** The folders in one folder on a machine (the folder field's list), and This Mac's folder window. */
  folderBrowse: "herdr:folder-browse",
  folderPick: "herdr:folder-pick",
  /** The terminal drawer's shell (a Herdr shell pane, tab.create), and whether × asks first. */
  drawerShellOpen: "herdr:drawer-shell-open",
  /** Rename workspace… (workspace.rename). */
  renameWorkspace: "herdr:workspace-rename",
  changesAgent: "herdr:changes-agent",
  changesDiff: "herdr:changes-diff",
  changesOverview: "herdr:changes-overview",
  changesClose: "herdr:changes-close",
  awayState: "herdr:away-state",
  awayUpdate: "herdr:away-update",
  awayShown: "herdr:away-shown",
  awayMarkSeen: "herdr:away-mark-seen",
  searchRun: "herdr:search-run",
  searchExpand: "herdr:search-expand",
  searchRetry: "herdr:search-retry",
  searchClose: "herdr:search-close",
  searchUpdate: "herdr:search-update",
  layoutWatch: "herdr:layout-watch",
  layoutUpdate: "herdr:layout-update",
  paneAction: "herdr:pane-action",
  draftsLoad: "herdr:drafts-load",
  draftSave: "herdr:draft-save",
  draftsChanged: "herdr:drafts-changed",
  draftKept: "herdr:draft-kept",
  /** A held typed `/compact` that did not go, to Kept drafts (machine id, pane id, the line). */
  draftKeep: "herdr:draft-keep",
  promptsList: "herdr:prompts-list",
  promptsChanged: "herdr:prompts-changed",
  promptAnswer: "herdr:prompt-answer",
  /** Settings' count of a machine's uploads (its id only; no path crosses). */
  uploadsCount: "herdr:uploads-count",
  /** Settings' Delete now for a machine's uploads, after its confirmation (its id only; no path crosses). */
  uploadsDeleteNow: "herdr:uploads-delete-now",
  /** Settings › Chat saves one kind's start command on a machine (its id, the kind, the command). */
  startCommandSave: "herdr:start-command-save",
  /** About's Open-source licenses (no arguments): the notices file the app ships, opened. */
  openLicenses: "herdr:open-licenses",
  /** A link in Chat or the Terminal, opened in the default browser (http and https only, checked in main). */
  openLink: "herdr:open-link",
  /**
   * Settings' Check for Updates… (no arguments): asked now, its
   * outcome in words for the page (the menu's own check says it in a dialog).
   */
  checkForUpdates: "herdr:check-for-updates",
  /** The app's own update state (src/shared/updates.ts UpdateView), and each change of it. */
  updateState: "herdr:update-state",
  updateChanged: "herdr:update-changed",
  /** The pill's and Settings' Download (no arguments): your click, never automatic. */
  updateDownload: "herdr:update-download",
  /** The pill's and Settings' Restart (no arguments): the main process asks first. */
  updateInstall: "herdr:update-install",
  /** Settings' "Check for updates automatically" (one boolean). */
  updateAutomatic: "herdr:update-automatic",
  /** Install or Update on one of Herdr's integrations (machine id, target, binding). */
  integrationInstall: "herdr:integration-install",
  /** Settings opened: the integrations read again (no arguments). */
  integrationsRefresh: "herdr:integrations-refresh",
} as const;

/** "local": This Mac, built in and reached with no SSH. */
export type HostKind = "demo" | "ssh" | "local";

/**
 * "Open in Ghostty" for one pane (src/main/ghostty.ts): hidden when Ghostty is
 * not installed (and on Windows); disabled, with the reason, when the pane
 * cannot be opened that way.
 */
export type GhosttyAvailability =
  | { readonly shown: false }
  | { readonly shown: true; readonly enabled: true }
  | { readonly shown: true; readonly enabled: false; readonly reason: string };
export type HostState = "connecting" | "connected" | "offline";

/** One machine in the sidebar, as the renderer sees it. No secrets cross. */
/**
 * What the main process counted of a machine: its
 * connection generation (one more each time it answers again after it
 * stopped) and each pane's agent run (one more each time an agent arrives in
 * it). A hand-off picked on a row is bound to these; the main process refuses
 * it when they changed.
 */
/** A read after an Esc to `paneId` showed Claude's working line gone (main tells the page at that read). */
export interface EscScreenEvent {
  readonly hostId: string;
  readonly paneId: string;
  readonly working: false;
}

/** The restart of `paneId` still runs, and the page shows `note` for it (the lock wait's). */
export interface RestartNoteEvent {
  readonly hostId: string;
  readonly paneId: string;
  readonly note: string;
}

export interface HostRun {
  readonly connection: number;
  readonly arrivals: Readonly<Record<string, number>>;
}

/**
 * The machine presented a host key nothing is pinned for. The
 * connection ended during the key exchange: nothing was sent and nothing was
 * stored. The page asks "Trust this Mac?" with these; Trust pins exactly this key.
 */
export interface HostKeyQuestion {
  /**
   * This question's own id (opaque, a UUID; a new one each time a machine is asked). Trust and
   * Cancel send it back, and the main process acts only while it is the question still open.
   */
  readonly id: string;
  readonly host: string;
  readonly port: number;
  /** The key's type as the server sent it ("ssh-ed25519"). */
  readonly keyType: string;
  /** The type as OpenSSH names it in `ssh-keygen -l` ("ED25519"). */
  readonly typeLabel: string;
  /** The key's fingerprint as OpenSSH prints it ("SHA256:" and base64). */
  readonly fingerprint: string;
  /** The command that prints it on the Mac, to compare. */
  readonly check: string;
}

/** One machine's model list changed (IPC.modelCatalogChanged). */
export interface ModelCatalogChange {
  readonly hostId: string;
  readonly view: CatalogView;
}

export interface HostView {
  readonly id: string;
  readonly name: string;
  readonly kind: HostKind;
  /** user@host:port for SSH, "demo" for a demo host, "local" for This Mac. */
  readonly address: string;
  /** "macOS", "Linux", … when known (demo hosts say so). */
  readonly platform: string | null;
  readonly state: HostState;
  readonly error: string | null;
  readonly topology: SessionTopology | null;
  /** When the topology was read (ms since 1970), or null. */
  readonly fetchedAtMs: number | null;
  /**
   * `topology` is the launch cache's, shown until the first snapshot lands; nothing in it
   * can be sent to or acted on (the main process checks every action on a live snapshot).
   */
  readonly catchingUp?: boolean;
  /** The machine refused the sign-in; nothing is tried until Try again or Edit machine. */
  readonly authRefused?: boolean;
  /** Its host key waits for Trust or Cancel; nothing is tried until then. */
  readonly hostKey?: HostKeyQuestion;
  /** Its new host key was not trusted (Cancel, or it could not be saved); nothing is tried until Try again. */
  readonly hostKeyDeclined?: boolean;
  /** The main process's counts for the snapshot shown (absent: none, as in fixtures). */
  readonly run?: HostRun;
  /**
   * The machine's connection: a new number each time it answers again after
   * it stopped (or first answers); 0 or absent while it never answered. A pane
   * action is bound to it.
   */
  readonly connection?: number;
  /** The machine's entry in the sidebar: a new number each time it is added; a pane action is bound to it. */
  readonly incarnation?: number;
  /**
   * The command connection its snapshot came on (the SSH transport's epoch: a
   * new number for every SSH client; 0 for the demo; null or absent: not
   * known). A pane action is bound to it.
   */
  readonly epoch?: number | null;
  /** The agent panes whose Claude Code has an update installed (absent: none). */
  readonly updateReady?: readonly string[];
  /**
   * This Mac's Herdr is not running (no socket where Herdr puts it): the words and a short
   * hint, shown as a note under the machine, not an error (absent: it runs, or the machine is not This Mac).
   */
  readonly notRunning?: HostNotRunning;
  /**
   * Herdr's agent integrations as read on this connection, the shown kinds only
   * (absent: not read yet, or this machine's Herdr does not answer integration.list).
   */
  readonly integrations?: HostIntegrations;
  /**
   * The panes showing an agent's start screen that waits for the person
   * (Codex's hook review) while Herdr reports them idle, as main last read them on this connection (absent: none).
   * The page shows them as needing you (prompt/start-screen.ts applyStartScreens).
   */
  readonly startScreens?: HostStartScreens;
}

/** "Herdr is not running on this Mac" and what to do about it. */
export interface HostNotRunning {
  readonly text: string;
  readonly hint: string;
}

export interface AppInfo {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly demo: boolean;
  /** Launched to capture its own window: animations hold still. */
  readonly capture: boolean;
  /**
   * Whether this build updates itself, and where it checks (GitHub Releases of
   * adari-app/adari, in a signed package only). The live state is updateState / onUpdateState.
   */
  readonly updates: { readonly enabled: boolean; readonly feedUrl: string };
  /** Whether a password can be saved here (safeStorage can encrypt); a key file works either way. */
  readonly passwordStorage: boolean;
  /** The commit the app was built from (git's short hash, set by scripts/build.mjs); null: not known. */
  readonly commit?: string | null;
}

/** How a machine signs in: a password (the default, as the iPhone app), or a private key file. */
export type SshAuthMethod = "password" | "key";

export interface AddHostRequest {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth: SshAuthMethod;
  /** The key file's path (key file only; ignored for a password). */
  readonly keyPath: string;
  readonly herdrSession: string;
  /**
   * The password, or the key file's passphrase ("" for none). Crosses once,
   * to be saved encrypted in the main process; never sent back. null keeps
   * the one saved (Edit only).
   */
  readonly secret: string | null;
}

/** Edit a saved machine: the same fields, and which machine. */
export interface EditHostRequest extends AddHostRequest {
  readonly id: string;
}

/** A saved SSH machine as Edit shows it. No secret: only whether one is saved. */
export interface HostSettings {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth: SshAuthMethod;
  readonly keyPath: string;
  readonly herdrSession: string;
  /** A password (or the key's passphrase) is saved for this machine. */
  readonly secretSaved: boolean;
}

export interface TerminalOpenRequest {
  readonly hostId: string;
  readonly paneId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalDataEvent {
  readonly sessionId: string;
  readonly data: Uint8Array;
}

export interface TerminalExitEvent {
  readonly sessionId: string;
  readonly reason: string | null;
}

export type MainTab = "chat" | "terminal" | "changes";

/**
 * What Chat shows for the open pane: the feed's states, plus the desktop's
 * own: the pane runs no agent ("notAgent"), or its machine has no transcript
 * reader ("noAccess"; a herdr-core machine reads with its SSH
 * host's reader, as a Herdr TUI machine does).
 */
export type ChatViewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "live" }
  | {
      readonly status: "unavailable";
      /** `ambiguousCursorSession`, two Cursor panes in one folder (Grok's `ambiguousSession`, Cursor's note). */
      readonly reason:
        | ChatUnavailableReason
        | "notAgent"
        | "noAccess"
        | "ambiguousCursorSession"
        /** Two Pi (or omp) panes in one folder. */
        | "ambiguousPiSession"
        | "ambiguousOmpSession"
        | "ambiguousOpenCodeSession" // Two OpenCode (or Kilo) panes in one folder
        | "ambiguousKiloSession"
        // Two Gemini (or Qwen) panes in one folder, their own agent's note.
        | GeminiFamilyAmbiguousReason
        | "ambiguousCopilotSession" // Two Copilot panes in one folder name no session
        | "ambiguousDroidSession" // Two Droid panes
        /** `ambiguousKimiSession`, two Kimi panes in one folder (Kimi's note). */
        | "ambiguousKimiSession"
        // Two Maki panes in one folder (Maki's note).
        | "ambiguousMakiSession"
        | "ambiguousClineSession" // Two Cline panes in one folder
        | KiroAmbiguousReason // Two Kiro panes in one folder
        // Two herdr-core Claude (or Codex) panes in one folder name none.
        | "ambiguousClaudeSession"
        | "ambiguousCodexSession";
      /** With `codexOtherFolder`, the folder the Codex session's own header names. */
      readonly folder?: string;
    };

/** One chat update: the state and the whole timeline for the pane the window follows. */
export interface ChatUpdateEvent {
  readonly hostId: string;
  readonly paneId: string;
  readonly state: ChatViewState;
  readonly timeline: ChatTimeline;
  /** The timeline is the launch cache's, shown until the first feed read lands. */
  readonly catchingUp?: boolean;
  /**
   * The follow it answers (the number openChat passed): the page keeps it
   * only while that follow is still on screen.
   */
  readonly follow?: number;
  /**
   * The Model and Effort chips' values, read from the same
   * transcript reads (src/shared/agent-settings.ts), with the terminal and
   * session they are for; absent while no Claude or Codex transcript is read.
   */
  readonly settings?: PaneSettings;
  /**
   * The Grok session the feed follows (its id, from the updates.jsonl it
   * located and checked), with the terminal the pane's agent runs in: Resume offers it after the
   * agent leaves. Absent for other agents, or while none is followed.
   */
  readonly followed?: FollowedSession;
  /**
   * The feed has read the transcript to its end (Swift's
   * ChatFeedUpdate.caughtUp): a live row starts only then. Absent: not known (no feed).
   */
  readonly caughtUp?: boolean;
}

/**
 * The shown Chat's pane read off its screen while its
 * Claude works (src/main/chat/live-reads.ts): each read's block (null: none
 * being written, or the read failed), and when the reads stop, whether the
 * row may stay a moment for its text to land (`keeping`: only the work ended,
 * the Chat still on show) or goes now. `follow` as on ChatUpdateEvent.
 */
/** What a shown Cursor pane's footer says (null: none that reads), for its terminal and session. */
export interface CursorFooterEvent {
  readonly hostId: string;
  readonly paneId: string;
  readonly scope: SettingsScope;
  /** The connection and the pane's agent run it was read under (absent: not known here). */
  readonly run?: { readonly connection: number; readonly arrival: number } | null;
  readonly footer: CursorFooter | null;
  /**
   * The model line under the box as drawn when no footer reads ("Composer 2.5 Fast", "Auto": no
   * effort word), whoever made the change; absent or null: none (the box not on screen, or a footer that reads).
   */
  readonly modelLine?: string | null;
}

/** How a Cursor pick went: set (the footer shows it), Cursor's selector opened (the Model chip), or not, with why. */
export type CursorPickResult =
  | { readonly type: "set"; readonly footer: CursorFooter }
  | { readonly type: "opened" }
  | { readonly type: "busy" }
  | { readonly type: "refused"; readonly note: string; readonly footer: CursorFooter | null };

/** How an OpenCode model pick went: set (its footer names the model), or not, with why. */
export type OpenCodePickResult = { readonly type: "set"; readonly model: string; readonly label: string } | { readonly type: "refused"; readonly note: string };

/**
 * What a model pick main typed came to: for Cursor, its footer's model line read after the Return
 * (null: none read), which may name another family than the one asked for; nothing for the others.
 */
export type ModelPickOutcome =
  | { readonly type: "cursor"; readonly modelLine: string | null; readonly footer: CursorFooter | null }
  /**
   * Grok's screen read after the Return: `confirmed` when its footer (the box's border) or a new
   * "Switched to …" line names the model picked (or names one no row of the list matches, as the pick stands then);
   * `shown` the border's model name ("Grok 4.7 Fast"), `effort` its level ("low"), each null when none reads.
   * `said` the name the new "Switched to …" line gave ("Grok 4.6"; null: no new
   * line), so a pick confirmed by that line alone can be told from a later border naming another model.
   */
  | { readonly type: "grok"; readonly confirmed: boolean; readonly shown: string | null; readonly said: string | null; readonly effort: string | null };

/** How a Grok pick went: set (its screen shows it), its model list opened, or not, with why. */
export type GrokPickResult =
  | { readonly type: "set"; readonly effort: string | null; readonly window: string | null }
  | { readonly type: "opened" }
  | { readonly type: "busy" }
  | { readonly type: "refused"; readonly note: string };

/** What a shown Claude Code or Grok pane's screen says its approval mode is (null: none that reads), for its terminal, session, connection and run. */
export interface PaneModeEvent {
  readonly hostId: string;
  readonly paneId: string;
  readonly agent: "claude" | "grok";
  readonly scope: SettingsScope;
  readonly run?: { readonly connection: number; readonly arrival: number } | null;
  readonly mode: string | null;
  /** Grok's border's model name with that mode ("Grok 4.7 Fast"); absent or null: none read. */
  readonly borderModel?: string | null;
}

/**
 * How a Permissions pick went: set (the mode the screen shows at its
 * end; Cursor's with the footer read then), the pane not at its prompt (held
 * for its next turn), or refused with why and the mode the screen showed (null:
 * none read). Never a guess: the chip shows what the screen showed.
 */
export type ModePickResult =
  | { readonly type: "set"; readonly mode: string | null; readonly footer?: CursorFooter | null }
  | { readonly type: "busy" }
  /**
   * `mode`: what the screen showed last (null: none reads). `unknown`: a key that may have
   * changed the mode went and its screen did not read after it: the mode is not known (the chip says
   * Permissions; never the mode before the pick).
   */
  | {
      readonly type: "refused";
      readonly note: string;
      readonly mode: string | null;
      readonly footer?: CursorFooter | null;
      readonly unknown?: true;
      /** Stopped on a mode more permissive than both the start and the target (or unread past one): the chip warns. */
      readonly warning?: true;
    };

export type ChatLiveEvent =
  | { readonly type: "block"; readonly hostId: string; readonly paneId: string; readonly follow?: number; readonly block: ChatLiveBlock | null }
  | { readonly type: "stop"; readonly hostId: string; readonly paneId: string; readonly follow?: number; readonly keeping: boolean };

/**
 * What the window asks Herdr to do to a pane of the tab it shows: split it
 * right or down (a shell, as Herdr's split
 * makes), move a divider (its split's new ratio), zoom it or end the zoom,
 * close it. Each is bound to the pane as you saw it (`binding`, its paneId the
 * action's); the main process refuses it, sending nothing, once
 * the window or Herdr shows otherwise.
 */
export type PaneAction =
  | { readonly type: "split"; readonly paneId: string; readonly direction: "right" | "down"; readonly binding: PaneBinding }
  /**
   * A divider let go: its split's ratio set to `ratio` (layout.set_split_ratio); `paneId` is a pane on the
   * split's first side; `path` is where the split sat in the tab shown; `shape` is the whole split as
   * shown (its direction and both sides' panes in order).
   */
  | {
      readonly type: "resize";
      readonly paneId: string;
      readonly splitId: string;
      readonly path: SplitPath;
      readonly shape: SplitShape;
      readonly ratio: number;
      readonly binding: PaneBinding;
    }
  | { readonly type: "zoom"; readonly paneId: string; readonly zoomed: boolean; readonly binding: PaneBinding }
  /**
   * `from: "row"` is a close from a sidebar row's menu (or the pane header before its
   * tab's layout came): bound to the pane as the sidebar shows it (pane-binding rowBindingOf), so the
   * window need not show it in a tile; checked against a fresh snapshot and Herdr's layout read now.
   */
  | { readonly type: "close"; readonly paneId: string; readonly binding: PaneBinding; readonly from?: "row" }
  /**
   * Rename… (a row's inline field): the pane's label set to `label` with one pane.rename,
   * null clearing it (Herdr's own name returns). Bound as the sidebar shows the pane (rowBindingOf), as a
   * row's close is. As the Swift renameTarget does, a row whose shown name is its tab's label
   * renames the tab, `target: "tab"` with the bound pane's tab (one tab.rename, a name never null).
   */
  | {
      readonly type: "rename";
      readonly paneId: string;
      readonly label: string | null;
      readonly binding: PaneBinding;
      readonly target?: "tab";
      readonly tabId?: string;
    };

/** A workspace's new label (1 to 256 characters: Herdr's label is a string), bound as the sidebar showed it. */
export interface WorkspaceRename {
  readonly workspaceId: string;
  readonly label: string;
  readonly binding: WorkspaceBinding;
}

/** A split's new pane; null for the other actions. */
export interface PaneActionResult {
  readonly paneId: string | null;
}

/**
 * The layout of the tab the window shows: sent when it is
 * first read and every time it is read again. `paneId` is the pane the window
 * said it shows; `layout` null while Herdr gave none (`error` says why).
 */
export interface LayoutUpdateEvent {
  readonly hostId: string;
  readonly paneId: string;
  readonly tabId: string | null;
  readonly layout: PaneLayout | null;
  readonly error: string | null;
}

/** An attachment on its machine: the path the message carries (src/shared/attachments.ts). */
export interface UploadedAttachment {
  readonly path: string;
  readonly byteCount: number;
}

/** Files copied in the Finder, read by the main process for a paste (src/main/uploads/clipboard-files.ts). */
export interface ClipboardFiles {
  readonly files: readonly { readonly name: string; readonly type: string; readonly data: Uint8Array }[];
  /** Names of copied files of a kind that does not upload. */
  readonly refused: readonly string[];
  /** Names past the ten one paste takes. */
  readonly excess: readonly string[];
  /** Lines saying why a file could not be read. */
  readonly failures: readonly string[];
}

/** One agent's Changes as the main process read them (the page makes the rows: shared/changes/content.ts). */
export interface ChangesAgentResult {
  readonly hostId: string;
  readonly paneId: string;
  /** The agent's kind ("claude", "codex", "grok", …). */
  readonly kind: string;
  readonly folder: string | null;
  /** The machine answers and its git can be read. */
  readonly online: boolean;
  readonly tools: ChangesToolsState;
  readonly git: ChangesGitState;
  readonly commits: ChangesCommitsState;
  /** The start of the commits read (seconds since 1970). */
  readonly commitsSince: number | null;
  readonly sinceKnown: boolean;
  /** The other agent panes open in the folder, by name. */
  readonly sharing: readonly string[];
}

/** A file of the folder (by its path in the last status read) or a commit (by its hash in the last log read). */
export type ChangesDiffRequest = { readonly kind: "file"; readonly path: string } | { readonly kind: "commit"; readonly hash: string };

/** A diff as git gave it (with the bound it was read to), or why there is none. */
export type ChangesDiffResult =
  | Exclude<GitTextResult, { readonly kind: "text" }>
  | { readonly kind: "text"; readonly text: GitText; readonly bound: number }
  | { readonly kind: "offline" };

/** Commands the main process sends to the page (the capture flag drives these). */
export type AppCommand =
  | { readonly id: string; readonly type: "select-pane"; readonly hostId: string; readonly paneId: string }
  | { readonly id: string; readonly type: "clear-selection" }
  | { readonly id: string; readonly type: "set-mode"; readonly mode: "projects" | "priority" }
  | { readonly id: string; readonly type: "set-tab"; readonly tab: MainTab }
  /** The across-agents screen, shown or not. */
  | { readonly id: string; readonly type: "set-changes-overview"; readonly shown: boolean }
  /** In the open agent's Changes, opens a row's diff by its id (captures only). */
  | { readonly id: string; readonly type: "open-changes-row"; readonly rowId: string }
  | { readonly id: string; readonly type: "set-host-folded"; readonly hostId: string; readonly folded: boolean }
  /** The message box over the terminal (⇧⌘T). */
  | { readonly id: string; readonly type: "set-box"; readonly shown: boolean }
  /** A sidebar row's menu, as a right-click opens it (captures only; nothing in it is chosen). */
  | { readonly id: string; readonly type: "open-row-menu"; readonly hostId: string; readonly paneId: string }
  /** Files attached to the open pane's message box, as a drop would (captures only). */
  | { readonly id: string; readonly type: "attach-files"; readonly files: readonly { readonly name: string; readonly type: string; readonly base64: string }[] }
  /** A click on the first element `selector` finds, as your click would (captures only: Send, a thumbnail, a Copy). */
  | { readonly id: string; readonly type: "click"; readonly selector: string }
  /** A selection in the terminal canvas `selector` finds, as your mouse makes it: `clicks` presses at `from`, a drag to `to` on the last (fractions of the canvas; captures only). */
  | {
      readonly id: string;
      readonly type: "terminal-select";
      readonly selector: string;
      readonly from: { readonly x: number; readonly y: number };
      readonly to?: { readonly x: number; readonly y: number };
      readonly clicks?: number;
    }
  /** Send to… for a reply in the pane's chat, as its menu opens the picker (captures only). */
  | { readonly id: string; readonly type: "open-handoff"; readonly hostId: string; readonly paneId: string; readonly text: string }
  /** The open picker's Return (draft) or ⌘Return (send now) on a pane (captures only). */
  | { readonly id: string; readonly type: "pick-handoff"; readonly hostId: string; readonly paneId: string; readonly action: "draft" | "sendNow" }
  /** New agent's dialog for a workspace, as its header's + opens it; null: ⌘N; `where`: as a split menu's New agent there opens it (captures only). */
  | {
      readonly id: string;
      readonly type: "open-new-agent";
      readonly hostId: string | null;
      readonly workspaceId: string | null;
      readonly where?: { readonly paneId: string; readonly direction: "right" | "down" };
    }
  /** A pane zoomed or unzoomed, as its tile's zoom button does: the press focuses the tile first (captures only). */
  | { readonly id: string; readonly type: "zoom-pane"; readonly hostId: string; readonly paneId: string; readonly zoomed: boolean }
  /** A pane's split menu, as its split button opens it (captures only; nothing in it is chosen). */
  | { readonly id: string; readonly type: "open-split-menu"; readonly hostId: string; readonly paneId: string }
  /** A workspace header's menu (New agent here), as a right-click opens it (captures only; nothing is chosen). */
  | { readonly id: string; readonly type: "open-workspace-menu"; readonly hostId: string; readonly workspaceId: string }
  /** New agent started as the dialog's Return would start it (captures only; the demo's Herdr). */
  | { readonly id: string; readonly type: "start-new-agent"; readonly hostId: string; readonly workspaceId: string; readonly kind: string; readonly folder: string | null }
  /** New workspace's dialog, as ⇧⌘N opens it on the machine named (null: the selected pane's; captures only). */
  | { readonly id: string; readonly type: "open-new-workspace"; readonly hostId: string | null; readonly folder?: string }
  /** New workspace made as the dialog's Return would make it (captures only; the demo's Herdr). */
  | { readonly id: string; readonly type: "create-workspace"; readonly hostId: string; readonly folder: string; readonly name: string | null }
  /** "While you were away": its screen shown or left (captures). */
  | { readonly id: string; readonly type: "show-away"; readonly shown: boolean }
  /** Search conversations (⇧⌘F) with this query; null closes it (captures). */
  | { readonly id: string; readonly type: "search"; readonly query: string | null }
  /** Opens the first result on show (captures). */
  | { readonly id: string; readonly type: "search-open-first" }
  /** Rename… on a pane (its row's field opens, as the menu item does), and Rename workspace…. */
  | { readonly id: string; readonly type: "rename-pane"; readonly hostId: string; readonly paneId: string }
  | { readonly id: string; readonly type: "rename-workspace"; readonly hostId: string; readonly workspaceId: string }
  /**
   * Settings in the main window: the app menu's Settings… (File menu on Windows and Linux) toggles it
   * as ⌘, does; the captures open it at a section, or close it.
   */
  | { readonly id: string; readonly type: "settings"; readonly open: boolean | "toggle"; readonly section?: SettingsSection };

/** The id the page acknowledges once it has mounted and shown its first hosts. */
export const RENDERER_READY = "ready";

export interface HerdrDesktopBridge {
  appInfo(): Promise<AppInfo>;
  listHosts(): Promise<HostView[]>;
  refreshHosts(): Promise<HostView[]>;
  onHostsChanged(listener: (hosts: HostView[]) => void): () => void;
  addHost(request: AddHostRequest): Promise<HostView[]>;
  /** Saves an edited machine; it reconnects with the new settings. */
  updateHost(request: EditHostRequest): Promise<HostView[]>;
  /** Removes the machine and its saved password. */
  removeHost(hostId: string): Promise<HostView[]>;
  /** A saved SSH machine's settings for Edit, or null (a demo machine, or gone). */
  hostSettings(hostId: string): Promise<HostSettings | null>;
  /** Try again after a refused sign-in: one more attempt with the saved credentials. */
  retryHost(hostId: string): Promise<HostView[]>;
  /**
   * Trust and connect. Pins the machine's new host key only while `questionId` is the
   * question still open (HostView.hostKey.id) and `fingerprint` the one it asked about, then connects again.
   */
  trustHostKey(hostId: string, questionId: string, fingerprint: string): Promise<HostView[]>;
  /** Cancel. Nothing is stored; the machine waits for Try again. Only for the question still open. */
  cancelHostKey(hostId: string, questionId: string): Promise<HostView[]>;
  pickKeyFile(): Promise<string | null>;
  openTerminal(request: TerminalOpenRequest): Promise<{ sessionId: string }>;
  /** Text (UTF-8 encoded in main) or raw bytes, 1 to 64 (a legacy X10 mouse report). */
  terminalInput(sessionId: string, data: string | Uint8Array): void;
  terminalResize(sessionId: string, cols: number, rows: number): void;
  closeTerminal(sessionId: string): void;
  /**
   * The page's terminal parsed `bytes` more of the session's output, in order. A
   * herdr-core terminal is credited only for these, so a page that is behind holds the core back. Absent in older fakes.
   */
  terminalParsed?(sessionId: string, bytes: number): void;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;
  /**
   * Sends a message by the Swift app's rule (src/main/herdr/send.ts): Herdr's
   * agent.prompt to a Claude or Codex agent, else one paste and its Return; a
   * shell takes one line. Bound to the pane as you saw it (`binding`): sent only
   * while a fresh snapshot still shows it. Rejects with the note to show; the
   * text is kept.
   */
  sendToPane(hostId: string, paneId: string, text: string, binding: SendBinding): Promise<void>;
  /**
   * Stop: Escape to the pane's agent (`agent.send_keys`),
   * only while a fresh snapshot still shows the agent `binding` saw working
   * (src/main/herdr/stop.ts). Resolves with the note to show under the box, or
   * null when Escape went.
   */
  stopAgent(hostId: string, paneId: string, binding: StopBinding): Promise<string | null>;
  /**
   * A press while neither Herdr nor the last read showed
   * working: one fresh read of Claude Code's screen, and one Esc only when its
   * working line shows. `sent` false: nothing went (a settled idle). Absent in older fakes.
   */
  stopIfWorking?(hostId: string, paneId: string, binding: StopBinding): Promise<{ readonly sent: boolean; readonly note: string | null }>;
  /**
   * After an Esc to a Claude pane, the text of Chat's last
   * send if Claude Code put it back in its box (cancelled before any answer),
   * and whether its box was emptied again. Absent in older fakes.
   */
  afterStop?(hostId: string, paneId: string, binding: StopBinding): Promise<{
    readonly cancelled: string | null;
    readonly cleared: boolean;
    /** Claude's working line by the reads (false once one showed it gone; null: no read showed the box). */
    readonly working?: boolean | null;
  }>;
  /**
   * The read after an Esc that showed Claude's working
   * line gone, told at that read (afterStop's answer comes after any clear).
   * Absent in older fakes.
   */
  onEscScreen?(listener: (event: EscScreenEvent) => void): () => void;
  /** Messages wait in Claude Code's queue by a fresh read (null: not read). Absent in older fakes. */
  paneQueued?(hostId: string, paneId: string): Promise<boolean | null>;
  /**
   * Takes back `texts` (your sends still waiting in Claude Code's queue, oldest first) from the
   * Claude pane `binding` shows: Up, then Ctrl+U, each key bound as the cleanup keys are, a screen read before and
   * after (src/main/herdr/claude-box.ts takeBackQueued). Never Escape, never Return. Absent in older fakes.
   */
  takeBackQueued?(hostId: string, paneId: string, binding: StopBinding, texts: readonly string[]): Promise<QueuedTakeBack>;
  /** /exit, then the resume command for the same session, in the same pane (restart.ts); the note, or null when it resumed. */
  restartAgent(hostId: string, paneId: string, binding: RestartBinding): Promise<string | null>;
  /** Main's note for a restart that still runs (Codex's lock wait); absent in older fakes. */
  onRestartNote?(listener: (event: RestartNoteEvent) => void): () => void;
  /** Each blocked pane's question as main last read it (src/main/prompt/prompts.ts); absent in older fakes. */
  listPrompts?(): Promise<PanePrompt[]>;
  onPromptsChanged?(listener: (prompts: PanePrompt[]) => void): () => void;
  /** An option of the question the page showed (and the box's text with "No, tell…"), sent only while the pane still shows it. */
  answerPrompt?(request: AnswerRequest): Promise<AnswerResult>;
  /**
   * Follows the pane's transcript for this window's Chat; updates come on
   * onChatUpdate. A tile's Chat passes its own `slot` (one
   * feed per tile on screen); without one it is the window's one chat.
   * `follow` is this Chat's generation, echoed on each of its updates.
   */
  openChat(hostId: string, paneId: string, slot?: string, follow?: number): void;
  /** Stops the chat in `slot`; without one, every chat of the window. */
  closeChat(slot?: string): void;
  /** Reads the messages before the loaded ones (Load earlier). */
  loadEarlierChat(slot?: string): Promise<void>;
  /** Whether the chat is pinned to its newest message. */
  setChatFollowing(following: boolean, slot?: string): void;
  onChatUpdate(listener: (event: ChatUpdateEvent) => void): () => void;
  /** The shown Chat's live reply off its pane's screen; absent in older fakes. */
  onChatLive?(listener: (event: ChatLiveEvent) => void): () => void;
  /** A shown Cursor pane's footer as main read it. */
  onCursorFooter?(listener: (event: CursorFooterEvent) => void): () => void;
  /** A Cursor pick, driven through Cursor's own menu by keys (src/main/herdr/send.ts driveCursorPick). */
  cursorPick?(hostId: string, paneId: string, pick: CursorPick, binding: SendBinding): Promise<CursorPickResult>;
  /** A Grok pick: its one `/model` command typed and Enter, the screen read before and after. */
  grokPick?(hostId: string, paneId: string, pick: GrokPick, files: GrokFiles, binding: SendBinding): Promise<GrokPickResult>;
  /** A shown Claude or Grok pane's approval mode as main read it off its screen. */
  onPaneMode?(listener: (event: PaneModeEvent) => void): () => void;
  /** A Permissions pick, driven in main by the agent's own keys or command, reading its screen at each step. */
  modePick?(hostId: string, paneId: string, agent: ModeAgent, target: string, binding: SendBinding): Promise<ModePickResult>;
  /** A picture a message in the open chat carries, as a data URL, or null. */
  chatImage(path: string): Promise<string | null>;
  /**
   * An inline picture a message in the open chat carries, left out of its read, as a data URL, or
   * null. Asked of that chat: its machine and its slot (a tile's; none: the one pane view's).
   */
  chatBlobImage(blob: ChatImageBlob, hostId: string, slot?: string): Promise<string | null>;
  copyText(text: string): void;
  /**
   * Uploads one attachment to the machine's private folder over its SFTP
   * connection (the Swift app's folder scheme and checks); resolves with its
   * path there, or rejects with the reason to show. The
   * composer gives each upload an id (`uploadId`) so × on its chip can stop it.
   */
  uploadAttachment(hostId: string, data: Uint8Array, extension: string, uploadId?: string): Promise<UploadedAttachment>;
  /** × on a chip still uploading: the upload with that id sends no further request, and what it made goes. */
  cancelUpload(uploadId: string): void;
  /**
   * × on a chip already on the machine: that upload (one of
   * the uploader's own files, checked on the machine) goes, under one
   * deadline; rejects with the reason to show.
   */
  discardAttachment(hostId: string, path: string): Promise<void>;
  /** The files copied in the Finder, read for a paste (empty when the clipboard names none). */
  clipboardFiles(): Promise<ClipboardFiles>;
  /** Whether "Open in Ghostty" shows for the pane, and if it cannot open, why. */
  ghosttyInfo(hostId: string, paneId: string): Promise<GhosttyAvailability>;
  /**
   * Opens the pane in Ghostty: the system ssh with the saved host's user, host
   * and port, running the attach line. Resolves null once Ghostty is started,
   * or with the reason it was not.
   */
  openInGhostty(hostId: string, paneId: string): Promise<string | null>;
  /** The machine's start commands (`~/.adari/agents.json`, else the old `~/.herdr-companion/agents.json`), read once per connection. */
  startCommands(hostId: string): Promise<AgentStartCommands>;
  /**
   * Saves `kind`'s start command (empty: the stock command) in the machine's `~/.adari/agents.json`;
   * the machine's start commands after it (used from then on), or rejects with why it was not saved.
   */
  saveStartCommand?(hostId: string, kind: string, command: string): Promise<AgentStartCommands>;
  /**
   * The folders directly in `directory` on the machine (as typed, ending in "/"; "~/" is its home),
   * for New workspace's and New agent's folder field; read only. Absent in older test bridges.
   */
  browseFolder?(hostId: string, directory: string): Promise<FolderListing>;
  /** This Mac's folder window, starting at `typed` when it is a folder there; the folder chosen, or null. */
  pickFolder?(hostId: string, typed: string): Promise<string | null>;
  /** New agent: a tab in the workspace with the kind (or a shell) started in it; resolves once the snapshot lists it. */
  newAgent(hostId: string, request: NewAgentRequest): Promise<NewAgentResult>;
  /** `agent`'s model list on the machine, as held now (a read begun behind when none or old; absent in older fakes). */
  modelCatalog?(hostId: string, agent: CatalogAgent): Promise<CatalogView>;
  /** Each change of a model list (absent in older fakes). */
  onModelCatalog?(listener: (change: ModelCatalogChange) => void): () => void;
  /**
   * A live model pick (a model from the picker, or Codex's Effort, which names
   * its model): main checks it against the machine's list, makes the agent's command and sends it bound as a pick
   * (at the prompt only); rejects with why (absent in older fakes).
   */
  modelPick?(hostId: string, paneId: string, pick: ModelPick, binding: SendBinding): Promise<ModelPickOutcome | void>;
  /** An OpenCode model pick by its id (main makes every key from the machine's list). */
  openCodePick?(hostId: string, paneId: string, model: string, binding: SendBinding): Promise<OpenCodePickResult>;
  /**
   * New workspace: one `workspace.create` on the machine at the folder with the
   * name, while it answers on the connection `request.binding` saw; resolves
   * once the snapshot lists it, or rejects with the note to show.
   */
  newWorkspace(hostId: string, request: NewWorkspaceRequest): Promise<NewWorkspaceResult>;
  /**
   * A shell for an agent pane's terminal drawer, a real Herdr shell pane in the
   * workspace at the folder (the machine's home when null); resolves once the snapshot was read again.
   */
  openDrawerShell?(hostId: string, request: DrawerShellRequest): Promise<DrawerShellResult>;
  /**
   * Reads an agent's Changes (its own calls from its transcript,
   * its folder's git, the commits this session). A newer call for the window
   * ends this one, which resolves null.
   */
  changesAgent(hostId: string, paneId: string): Promise<ChangesAgentResult | null>;
  /** A file's or a commit's diff of the last Changes read for the pane; null when a newer one ended it. */
  changesDiff(hostId: string, paneId: string, request: ChangesDiffRequest): Promise<ChangesDiffResult | null>;
  /** One machine's agents (the page asks each machine in the sidebar): git once per folder, each session's own files; null when a newer one ended it. */
  changesOverview(hostId: string): Promise<ChangesOverviewHost | null>;
  /** Ends this window's Changes reads (the view closed). */
  closeChanges(): void;
  /** The pane the window shows (null: none): its tab's layout comes on onLayoutUpdate, and again whenever it changes. */
  watchLayout(hostId: string | null, paneId: string | null): void;
  onLayoutUpdate(listener: (event: LayoutUpdateEvent) => void): () => void;
  /**
   * A tile's split, a divider's resize, zoom or close, sent to Herdr; resolves
   * once the tab's layout was read again (and, for a split or close, a new
   * snapshot taken). Rejects with the note to show (a refused split past 4 panes).
   */
  paneAction(hostId: string, action: PaneAction): Promise<PaneActionResult>;
  /**
   * Rename workspace…: one workspace.rename while the binding holds (the machine's connection
   * as the page saw it, the workspace still listed); resolves once a snapshot was read again. Rejects with the
   * note to show.
   */
  renameWorkspace(hostId: string, request: WorkspaceRename): Promise<void>;
  onAppCommand(listener: (command: AppCommand) => void): () => void;
  /** The View menu's commands (text size, the message box). */
  onViewCommand(listener: (command: ViewCommand) => void): () => void;
  appCommandDone(id: string): void;
  /** "While you were away" now; changes come on onAwayUpdate. */
  awayState(): Promise<AwayViewState>;
  onAwayUpdate(listener: (state: AwayViewState) => void): () => void;
  /** The digest is on screen (its line or its screen): leaving afterwards counts it as seen. */
  awayShown(): void;
  /** Mark all seen. */
  awayMarkSeen(): void;
  /** The search field's text, every edit: the main process cancels the old search at once and searches every machine after a 300 ms pause; too short clears. Changes come on onSearchUpdate. */
  searchConversations(query: string): void;
  /** "N more in this pane". */
  searchExpand(macId: string, paneId: string): void;
  /** A machine's search again ("Try again"). */
  searchRetry(macId: string): void;
  /** The search screen went away: every command and read stops. */
  searchClose(): void;
  onSearchUpdate(listener: (state: SearchViewState) => void): () => void;
  /** The drafts kept through a quit or a crash, and Kept drafts (src/main/drafts.ts). */
  loadDrafts(): Promise<DraftsState>;
  /** A pane's draft as it is now (null: empty, or sent); the main process writes it within 500 ms. */
  saveDraft(hostId: string, paneId: string, draft: DraftInput | null): void;
  /** The drafts changed in the main process (a pane found gone: its draft went to Kept drafts). */
  onDraftsChanged(listener: (event: DraftsChangedEvent) => void): () => void;
  /** Put in box (take: the item, or null when it is gone) or Discard a kept draft. */
  keptDraft(id: string, action: KeptDraftAction): Promise<KeptDraft | null>;
  /**
   * A held typed `/compact` line that did not go while your box held newer
   * text, to the pane's Kept drafts: the item, or null with no room (absent in older tests).
   * `outcome` says whether it was refused before any key went or may have
   * gone; main picks the reason from it (anything but "refused" is kept as may have gone).
   */
  keepDraft?(hostId: string, paneId: string, text: string, outcome: CompactOutcome): Promise<KeptDraft | null>;
  /**
   * The app's uploads on the machine, counted (rejects with why when it cannot count them).
   * `fresh` after an upload: counted by a walk started after this ask, never one already running.
   */
  uploadsCount(hostId: string, fresh?: boolean): Promise<UploadsInventory>;
  /** Delete now: every upload of the app's on the machine but those still used in the app. */
  deleteUploadsNow(hostId: string): Promise<UploadsDeleteResult>;
  /** Settings' Check for Updates…: asks the feed now; the outcome in words (no dialog: the page shows it). */
  checkForUpdates(): Promise<string>;
  /** About's Open-source licenses: opens the notices file the app ships (null), or says why it did not. */
  openLicenses?(): Promise<string | null>;
  /**
   * A link in Chat or the Terminal opened in the default browser, never in the app's window; main
   * opens only http and https (isSafeExternalUrl) and ignores anything else (absent in older tests).
   */
  openLink?(url: string): void;
  /** The app's own update state, and each change of it (absent in older tests). */
  updateState?(): Promise<UpdateView>;
  onUpdateState?(listener: (view: UpdateView) => void): () => void;
  /** Download (true: it downloaded; false: nothing to download, or it failed: the state says). */
  downloadUpdate?(): Promise<boolean>;
  /** Restart: the main process asks "Install update … and restart Adari?" first. */
  installUpdate?(): Promise<"installing" | "cancelled" | "not-ready">;
  /** "Check for updates automatically" on or off; the state after. */
  setAutomaticUpdates?(on: boolean): Promise<UpdateView>;
  /** Your Install or Update for `target` on the machine as the window showed it (absent in older fakes). */
  installIntegration?(hostId: string, target: string, binding: IntegrationBinding): Promise<IntegrationInstallReply>;
  /** Settings opened: each machine that answered is read again (absent in older fakes). */
  refreshIntegrations?(): Promise<void>;
}

declare global {
  interface Window {
    readonly herdrDesktop: HerdrDesktopBridge;
  }
}
