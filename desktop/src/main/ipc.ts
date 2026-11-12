// The main process's side of the IPC contract (src/shared/ipc-contract.ts):
// every channel checks that the sender is this app's own page and that its
// arguments have the right shape before anything runs.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";

import { isSafeExternalUrl } from "../shared/external-url";
import { isSafeAbsolutePath, isUploadFileName, isUploadFolderName, maxUploadBytes, safeUploadExtension } from "../shared/attachments";
import {
  IPC,
  type AddHostRequest,
  type AppInfo,
  type ChangesDiffRequest,
  type ClipboardFiles,
  type EditHostRequest,
  type EscScreenEvent,
  type RestartNoteEvent,
  type HostSettings,
  type HostView,
  type TerminalOpenRequest,
  type UploadedAttachment,
} from "../shared/ipc-contract";
import type { ChangesService } from "./changes/service";
import type { ChatService } from "./chat/service";
import type { ChatImageBlob } from "../shared/chat/model";
import type { GhosttyActions } from "./ghostty";
import { isSendBinding, notAtPromptText, type SendBinding } from "../shared/send-binding";
import { isPaneBinding } from "../shared/pane-binding";
import { cleanupBinding, cursorPickReadLines, inPaneTurn, pickCursorBound, pickGrokBound, sendBound, takeBackTurn, type SendBox, type SendSite, type TypedCommand } from "./herdr/send";
import { openCodeSettleMs, pickOpenCodeBound } from "./herdr/opencode-pick";
import { pickModeBound } from "./herdr/mode-pick";
import { isModeAgent, isOfferedMode } from "../shared/approval-modes";
import { cursorModelLineOf, cursorTypedRead, grokModelLabel, grokTypedRead, grokWindows, isCursorPick, isGrokPick, parseCursorFooter, readCursorScreen, readGrokScreen, type GrokFiles, type TypedScreenRead } from "../shared/agent-settings";
import type { ModelPickOutcome } from "../shared/ipc-contract";
import type { PaneReadGate } from "../shared/chat/live-reader";
import { paneReadKey } from "./chat/live-reads";
import { restartAgent } from "./herdr/restart";
import { stopAgent } from "./herdr/stop";
import {
  afterStopOnce,
  afterStopTurns,
  boundBoxSite,
  boxChecks,
  composerWrites,
  realWait,
  screenQueued,
  screenWorking,
  sentTexts,
  SentTexts,
  boxReadLines,
  pulledRows,
  takeBackQueuedOnce,
  type ClaudeBoxSite,
  type QueuedTakeBack,
  type TakeBackTurn,
} from "./herdr/claude-box";
import type { HerdrHostBackend } from "./herdr/backend";
import { isRestartBinding } from "../shared/agent-restart";
import { isStopBinding, stopTexts } from "../shared/agent-stop";
import { takeBackTexts } from "../shared/claude-screen";
import { transcriptQueueRecord, type QueueRecord } from "../shared/claude-queue-record";
import { sessionRefFromAgentSession } from "../shared/chat/locator";
import { isAnswerRequest } from "../shared/prompt/view";
import type { PromptService } from "./prompt/prompts";
import { saveStartCommandOf, startCommandsOf } from "./start-commands";
import { folderPickTexts } from "./folder-pick";
import { isBrowseDirectory, maxBrowsePathBytes, type FolderListing } from "../shared/folder-browse";
import { agentPollMs, firstAgentTimeoutMs, liveClock, newAgent, type NewAgentHerdr, type NewAgentRequest, type NewAgentResult } from "./herdr/new-agent";
import { newWorkspace } from "./herdr/new-workspace";
import { openDrawerShell, type DrawerShellRequest } from "./herdr/drawer-shell";
import { machineLink } from "./herdr/machine-link";
import { isNewWorkspaceRequest } from "../shared/new-workspace";
import { absentStartCommands, isEditableStartKind, maximumSaveRequestLength } from "../shared/start-commands";
import type { HostRegistry } from "./hosts";
import type { LayoutService } from "./layouts";
import { isPaneAction, isWorkspaceRename, newAgentInSplit, runPaneAction, runWorkspaceRename } from "./pane-actions";
import { APP_ORIGIN } from "./protocol";
import type { TerminalSessions } from "./terminals";
import type { PaneInputs } from "./pane-inputs";
import type { UploadsDeleteResult, UploadsInventory } from "../shared/settings";
import type { UpdateView } from "../shared/updates";
import type { IntegrationService } from "./integrations";
import type { StartScreenService } from "./start-screens";
import { startScreenRefusal, startScreenTexts } from "../shared/prompt/start-screen";
import { isIntegrationBinding, isShownTarget } from "../shared/integrations";
import { builtInCatalog, catalogAgentOf, effortPattern, isCatalogAgent, isModelId, type CatalogModel } from "../shared/model-catalog";
import { cursorFamilyOf, grokRowOfScreenName, grokSwitchedNames, isModelPick, modelPickCommand, sameCursorFamily, startFlags, type StartFlag } from "../shared/model-choices";
import type { ModelCatalogs } from "./model-catalogs";

export interface IpcDependencies {
  readonly info: AppInfo;
  /** The needs-you card's questions and answers; absent in older tests. */
  readonly prompts?: Pick<PromptService, "list" | "answer">;
  /** Herdr's integrations per machine; absent in older tests. */
  readonly integrations?: Pick<IntegrationService, "install" | "refresh"> & Partial<Pick<IntegrationService, "startToken" | "agentStarted">>;
  /** The panes showing an agent's start screen (a send to one is refused); absent in older tests. */
  readonly startScreens?: Pick<StartScreenService, "shows"> & Partial<Pick<StartScreenService, "sendGuard" | "showing">>;
  /** `current` and `eventsLive` are optional (a hosts object without them checks a send on a fresh snapshot). */
  readonly hosts: Omit<HostRegistry, "current" | "eventsLive"> & Partial<Pick<HostRegistry, "current" | "eventsLive">>;
  readonly terminals: TerminalSessions;
  readonly chat: ChatService;
  readonly changes: ChangesService;
  readonly layouts: LayoutService;
  readonly ghostty: Pick<GhosttyActions, "availability" | "open">;
  copyText(text: string): void;
  /** One attachment to the machine (src/main/uploads/service.ts). */
  uploadAttachment(hostId: string, data: Uint8Array, extension: string, uploadId?: string): Promise<UploadedAttachment>;
  /** Stops the upload with that id (absent in older tests: nothing to stop). */
  cancelUpload?(uploadId: string): void;
  /** Takes one upload back from the machine (absent in older tests: refused). */
  discardAttachment?(hostId: string, path: string): Promise<void>;
  /** The files copied in the Finder (src/main/uploads/clipboard-files.ts). */
  clipboardFiles(): Promise<ClipboardFiles>;
  addHost(request: AddHostRequest): HostView[];
  updateHost(request: EditHostRequest): HostView[];
  removeHost(hostId: string): HostView[];
  hostSettings(hostId: string): HostSettings | null;
  retryHost(hostId: string): Promise<HostView[]>;
  /** Trust and connect, for the fingerprint the page showed. */
  trustHostKey(hostId: string, questionId: string, fingerprint: string): Promise<HostView[]>;
  /** Cancel: nothing stored. */
  cancelHostKey(hostId: string, questionId: string): Promise<HostView[]>;
  pickKeyFile(owner: WebContents): Promise<string | null>;
  /** This Mac's folder window for `owner`'s window, starting at `typed` (absent in older tests: refused). */
  pickFolder?(owner: WebContents, typed: string): Promise<string | null>;
  commandDone(id: string): void;
  /** Takes the saved secrets out of an error text before it crosses to the page. */
  redact?(text: string): string;
  /** The machines' model lists (absent in older tests: the built-in view, and New agent takes no model). */
  readonly modelCatalogs?: Pick<ModelCatalogs, "view" | "settled"> & Partial<Pick<ModelCatalogs, "afterReading">>;
  /** The pause between a pick's reads after its keys (absent: 250 ms; the tests wait for nothing). */
  readonly pickSettleMs?: number;
  /** A Cursor pick's reads share the panes' read gate; its last screen's footer goes to the shown Chats. */
  readonly cursorReads?: {
    readonly gate: PaneReadGate;
    noteScreen(hostId: string, paneId: string, screen: string): void;
    /** A Permissions pick's end: its last screen, then the next read goes even unchanged. */
    notePick(hostId: string, paneId: string, screen: string | null): void;
    /** A Cursor `/model <id>` was typed: its footer is read again shortly (absent in older tests). */
    lookAgain?(hostId: string, paneId: string): void;
  };
  /** Each pane's Terminal input, counted (TerminalSessions bumps it). */
  readonly paneInputs?: PaneInputs;
  /** Settings' count of a machine's uploads (absent in older tests: refused). */
  uploadsCount?(hostId: string, fresh: boolean): Promise<UploadsInventory>;
  /** Settings' Delete now on a machine's uploads (absent in older tests: refused). */
  deleteUploadsNow?(hostId: string): Promise<UploadsDeleteResult>;
  /** Settings' Check for Updates… (absent in older tests: refused); the outcome in words. */
  checkForUpdates?(): Promise<string>;
  /** About's Open-source licenses: opens the shipped notices file (null), or why not (absent: refused). */
  openLicenses?(): Promise<string | null>;
  /** An http or https address, checked here first, opened in the default browser (absent in older tests: ignored). */
  openLink?(url: string): void;
  /** The app's own updates (absent in older tests: refused). */
  readonly updates?: UpdateIpc;
}

/** What the page may ask of the updater (src/main/updates.ts UpdateController). */
export interface UpdateIpc {
  view(): UpdateView;
  download(): Promise<boolean>;
  /** Asks first (a dialog over the window); Restart quits into the update. */
  requestInstall(): Promise<"installing" | "cancelled" | "not-ready">;
  setAutomatic(on: boolean): UpdateView;
}

/** Bounds on what the page may send. */
const maxInputBytes = 1_048_576;
/** Raw terminal bytes (a legacy X10 mouse report is 6) come only this small. */
export const maxRawInputBytes = 64;

/** Terminal input: text up to 1 MB, or a Uint8Array of 1 to 64 raw bytes. */
function isTerminalInput(data: unknown): data is string | Uint8Array {
  if (typeof data === "string") return Buffer.byteLength(data) <= maxInputBytes;
  return data instanceof Uint8Array && data.byteLength >= 1 && data.byteLength <= maxRawInputBytes;
}
const maxTextBytes = 100_000;
const maxIdLength = 256;
const maxPathBytes = 4_096;
const maxCopyBytes = 4 * 1_048_576;
/** A password or passphrase: at most 4096 bytes of UTF-8. */
const maxSecretBytes = 4_096;

export function isTrustedUrl(url: string): boolean {
  return url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
}

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return isTrustedUrl(event.senderFrame?.url ?? "");
}

/** At most this many parts in an inline picture's reference (kept base64 and ranges). */
const maxBlobParts = 4_096;

/** An inline picture's reference as a message carries it (ChatImageBlob), within bounds. */
function isChatImageBlob(value: unknown): value is ChatImageBlob {
  if (typeof value !== "object" || value === null) return false;
  const blob = value as { path?: unknown; ino?: unknown; parts?: unknown };
  if (typeof blob.path !== "string" || blob.path === "" || blob.path.includes("\0") || Buffer.byteLength(blob.path) > maxPathBytes) return false;
  if (blob.ino !== null && !(typeof blob.ino === "number" && Number.isSafeInteger(blob.ino) && blob.ino >= 0)) return false;
  if (!Array.isArray(blob.parts) || blob.parts.length === 0 || blob.parts.length > maxBlobParts) return false;
  let ranges = 0;
  for (const part of blob.parts as unknown[]) {
    if (typeof part === "string") {
      if (part.length > maxUploadBytes * 2) return false;
      continue;
    }
    if (!Array.isArray(part) || part.length !== 2) return false;
    const [offset, length] = part as unknown[];
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return false;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0) return false;
    ranges += 1;
  }
  return ranges > 0;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxIdLength;
}

/** A SHA-256 host-key fingerprint as OpenSSH prints it ("SHA256:" and 43 base64 characters). */
function isOpenSSHFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
}

/** A host-key question's id as the main process makes it (crypto.randomUUID). */
function isQuestionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** A chat slot: a tile's (its pane's key), short. */
function isSlot(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxIdLength * 2 + 1;
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2000;
}

export function isAddHostRequest(value: unknown): value is AddHostRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    typeof v["host"] === "string" &&
    typeof v["port"] === "number" &&
    typeof v["username"] === "string" &&
    (v["auth"] === "password" || v["auth"] === "key") &&
    typeof v["keyPath"] === "string" &&
    typeof v["herdrSession"] === "string" &&
    (v["secret"] === null || (typeof v["secret"] === "string" && Buffer.byteLength(v["secret"]) <= maxSecretBytes)) &&
    [v["name"], v["host"], v["username"], v["keyPath"], v["herdrSession"]].every((s) => (s as string).length <= 4096)
  );
}

export function isEditHostRequest(value: unknown): value is EditHostRequest {
  return isAddHostRequest(value) && isId((value as unknown as Record<string, unknown>)["id"]);
}

export function isTerminalOpenRequest(value: unknown): value is TerminalOpenRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isId(v["hostId"]) && isId(v["paneId"]) && isDimension(v["cols"]) && isDimension(v["rows"]);
}

/** Takes the saved secrets out of every rejection a handler gives the page (set by registerIpc). */
let redactError: (text: string) => string = (text) => text;

function redacted(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  return new Error(redactError(text));
}

/**
 * A folder New agent may start in: any path text on
 * one line with no control, line-separator or invisible formatting character
 * (a NUL, a newline, an escape, a direction override). It goes to Herdr as
 * structured cwd data, never through a shell.
 */
export function isNewAgentFolder(folder: unknown): folder is string | null {
  if (folder === null) return true;
  return typeof folder === "string" && Buffer.byteLength(folder) <= maxPathBytes && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(folder);
}

export function isNewAgentRequest(value: unknown): value is NewAgentRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isId(v["workspaceId"]) &&
    isNewAgentFolder(v["folder"]) &&
    typeof v["kind"] === "string" &&
    /^[a-z][a-z0-9_-]{0,31}$/.test(v["kind"]) &&
    (v["where"] === undefined || isNewAgentWhere(v["where"])) &&
    // A model and an effort of plain characters only (the machine's list is checked after).
    (v["model"] === undefined || v["model"] === null || (typeof v["model"] === "string" && /^[A-Za-z0-9~][A-Za-z0-9~._:@+/[\]-]{0,255}$/.test(v["model"]))) &&
    (v["effort"] === undefined || v["effort"] === null || (typeof v["effort"] === "string" && effortPattern.test(v["effort"])))
  );
}

/** A model pick's binding: at the prompt only, never the Compact's while-working permission. */
export function pickBinding(binding: SendBinding): SendBinding {
  const { queuesWhileWorking: _ignored, ...rest } = binding;
  return { ...rest, atPromptOnly: true };
}

/** Reads of Grok's screen after a model pick's Return, at most (a pause between). */
export const grokConfirmReads = 8;

/**
 * Grok's screen after a model pick's Return, read until its footer (the box's border, "Grok 4.7
 * Fast (low)") or a "Switched to …" line new since the box was read empty names the model picked (at most
 * grokConfirmReads). The names on screen and the list's labels can differ ("Grok 4.7 Fast", "Grok 4.7 Build Fast"):
 * a name stands for the row grokRowOfScreenName finds. Confirmed: the border names the picked row; or a new
 * "Switched to" line does while the border names no row of the list (not yet redrawn, or a name no row matches);
 * or a new "Switched to" line names no row while the border names none either (the pick the app made stands). A
 * border naming another row of the list is never a confirmation.
 */
export async function grokAfterPick(
  models: readonly CatalogModel[],
  picked: string,
  switchedBefore: readonly { readonly name: string; readonly effort: string }[],
  read: () => Promise<string>,
  wait: () => Promise<void>,
): Promise<ModelPickOutcome> {
  let last: ModelPickOutcome = { type: "grok", confirmed: false, shown: null, said: null, effort: null };
  for (let attempt = 0; attempt < grokConfirmReads; attempt += 1) {
    if (attempt > 0) await wait();
    let screen: string;
    try {
      screen = await read();
    } catch {
      continue;
    }
    const grok = readGrokScreen(screen);
    const shown = grok?.borderModel ?? null;
    const border = shown === null ? null : grokRowOfScreenName(models, shown);
    const switched = grokSwitchedNames(screen);
    const fresh = switched.length > switchedBefore.length || (switched.length > 0 && switched.at(-1)!.name !== switchedBefore.at(-1)?.name) ? switched.at(-1)! : null;
    const said = fresh === null ? null : grokRowOfScreenName(models, fresh.name);
    const confirmed = border === picked || (border === null && fresh !== null && (said === picked || said === null));
    const effort = border === picked ? (grok?.borderEffort ?? fresh?.effort ?? null) : (fresh?.effort ?? grok?.borderEffort ?? null);
    last = { type: "grok", confirmed, shown, said: fresh?.name ?? null, effort };
    if (confirmed) return last;
  }
  return last;
}

/**
 * New agent's Model and Effort as the agent's start flags, each checked against the machine's list
 * for the agent (read first when none is held) and its strict pattern; a choice outside them refuses the start.
 */
export async function newAgentFlags(catalogs: Pick<ModelCatalogs, "settled"> | undefined, hostId: string, request: NewAgentRequest): Promise<readonly StartFlag[]> {
  const model = request.model ?? null;
  const effort = request.effort ?? null;
  if (model === null && effort === null) return [];
  const agent = catalogAgentOf(request.kind);
  if (agent === null || catalogs === undefined) throw new Error("This agent takes no model or effort from New agent.");
  const view = await catalogs.settled(hostId, agent);
  const checked = startFlags(agent, { model, effort }, view.models);
  if (!checked.ok) throw new Error(`${checked.reason} Nothing was made.`);
  return checked.flags;
}

/** A drawer shell's request: the workspace and a folder New agent would take (null: not known). */
export function isDrawerShellRequest(value: unknown): value is DrawerShellRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every((key) => key === "workspaceId" || key === "folder") && isId(v["workspaceId"]) && isNewAgentFolder(v["folder"]);
}

/** New agent's Where: a new tab, or a split right or down of a pane, bound to that pane as the window showed it. */
function isNewAgentWhere(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["type"] === "tab") return true;
  return (
    v["type"] === "split" &&
    (v["direction"] === "right" || v["direction"] === "down") &&
    isId(v["targetPaneId"]) &&
    isPaneBinding(v["binding"]) &&
    v["binding"].paneId === v["targetPaneId"]
  );
}

/** A file's path (at most 4 KB, no NUL) or a full commit hash. */
export function isChangesDiffRequest(value: unknown): value is ChangesDiffRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["kind"] === "file") {
    const path = v["path"];
    return typeof path === "string" && path.length > 0 && !path.includes("\0") && Buffer.byteLength(path) <= maxPathBytes;
  }
  if (v["kind"] === "commit") {
    const hash = v["hash"];
    return typeof hash === "string" && (hash.length === 40 || hash.length === 64) && /^[0-9a-f]+$/.test(hash);
  }
  return false;
}

/** A word to the page that asked, while its request still runs (a page gone hears nothing). */
function tellPage(event: IpcMainInvokeEvent, channel: string, value: unknown): void {
  try {
    const sender = event.sender as Partial<WebContents> | undefined;
    if (sender?.isDestroyed?.() === true) return;
    sender?.send?.(channel, value);
  } catch {
    // The page went: nothing to tell.
  }
}

export function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    let result: unknown;
    try {
      result = listener(event, ...args);
    } catch (error) {
      throw redacted(error);
    }
    return result instanceof Promise
      ? result.catch((error: unknown) => {
          throw redacted(error);
        })
      : result;
  });
}

/** `…/.adari-attachments-<32 hex>/attachment-<uuid>.<ext>`: the uploader's own name and its folder's. */
function isUploadPathShape(path: string): boolean {
  const parts = path.split("/");
  return parts.length >= 3 && isUploadFileName(parts.at(-1)!) && isUploadFolderName(parts.at(-2)!);
}

export function on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!trusted(event)) return;
    listener(event, ...args);
  });
}

export function registerIpc(deps: IpcDependencies): void {
  const redact = deps.redact;
  redactError = redact === undefined ? (text) => text : (text) => redact(text);
  handle(IPC.appInfo, () => deps.info);
  handle(IPC.hostsList, () => deps.hosts.list());
  handle(IPC.hostsRefresh, () => deps.hosts.refreshAll());
  handle(IPC.hostsAdd, (_event, request) => {
    if (!isAddHostRequest(request)) throw new Error("bad request");
    return deps.addHost(request);
  });
  handle(IPC.hostsUpdate, (_event, request) => {
    if (!isEditHostRequest(request)) throw new Error("bad request");
    return deps.updateHost(request);
  });
  handle(IPC.hostsRemove, (_event, hostId) => {
    if (!isId(hostId)) throw new Error("bad request");
    return deps.removeHost(hostId);
  });
  handle(IPC.hostsSettings, (_event, hostId) => {
    if (!isId(hostId)) throw new Error("bad request");
    return deps.hostSettings(hostId);
  });
  handle(IPC.hostsRetry, (_event, hostId) => {
    if (!isId(hostId)) throw new Error("bad request");
    return deps.retryHost(hostId);
  });
  // The answer to a machine's new host key, naming the question it answers. Only a
  // fingerprint in OpenSSH's form crosses; the main process pins only the key it asked about, and only
  // while that question is the one open and this is its fingerprint.
  handle(IPC.hostsTrustKey, (_event, hostId, questionId, fingerprint) => {
    if (!isId(hostId) || !isQuestionId(questionId) || !isOpenSSHFingerprint(fingerprint)) throw new Error("bad request");
    return deps.trustHostKey(hostId, questionId, fingerprint);
  });
  handle(IPC.hostsCancelKey, (_event, hostId, questionId) => {
    if (!isId(hostId) || !isQuestionId(questionId)) throw new Error("bad request");
    return deps.cancelHostKey(hostId, questionId);
  });
  handle(IPC.hostsPickKey, (event) => deps.pickKeyFile(event.sender));
  handle(IPC.terminalOpen, (event, request) => {
    if (!isTerminalOpenRequest(request)) throw new Error("bad request");
    return deps.terminals.open(event.sender, request);
  });
  // Bound to the pane as the user saw it, checked on a fresh snapshot right before writing (send.ts sendBound).
  const sendBox = (hostId: string, paneId: string, backend: HerdrHostBackend): { box?: SendBox } => {
    const site = boxSite(hostId, paneId, backend);
    if (site === null) return {};
    return {
      box: {
        site,
        // Only messages sent to the run in the pane now are ours, each kept with its run.
        own: (run) => sentTexts.recent(backend, paneId, run),
        sent: (sent, run) => sentTexts.record(backend, paneId, sent, run),
        // Each cleanup key goes only while this machine's entry holds this writer and no box mark came.
        machine: () => deps.hosts.backend(hostId) === backend,
        marks: () => boxChecks.marks(backend, paneId),
        // The box is read only after a Stop, an Esc or a failed send on the pane, and only while the relay is
        // up and the machine's sidebar events are live; otherwise before every Claude send.
        due: () => deps.hosts.eventsLive?.(hostId) !== true || boxChecks.isDue(backend, paneId),
        checked: () => boxChecks.checked(backend, paneId),
        failed: () => boxChecks.mark(backend, paneId),
        // What a take-back left in Claude's row; a read that shows it empty resolves it.
        pulled: () => pulledRows.get(backend, paneId),
        resolved: () => pulledRows.set(backend, paneId, null),
      },
    };
  };
  // Claude Code's box in a pane, read through the pane-read gate (one read of a pane at a time).
  const boxSite = (hostId: string, paneId: string, backend: HerdrHostBackend): ClaudeBoxSite | null => {
    const calls = backend.promptIO?.();
    if (calls === undefined) return null;
    const gate = deps.cursorReads?.gate;
    const key = paneReadKey(hostId, paneId);
    const read = (): Promise<string> => calls.paneRead(paneId, boxReadLines);
    return {
      read: () => (gate === undefined ? read() : gate.reading(key, read)),
      keys: (keys) => backend.agentKeys(paneId, keys),
      wait: realWait,
    };
  };
  // A Send's write, bound to the pane as the user saw it (free text, and a model pick's command main made).
  const sendPaneBound = async (hostId: string, paneId: string, text: string, binding: SendBinding, command?: TypedCommand): Promise<void> => {
    const backend = deps.hosts.backend(hostId);
    if (backend === null) throw new Error("That machine is no longer listed.");
    // Codex's hook review on the pane's screen: its Return would pick a choice; nothing goes.
    // Only an early refusal; the Send reads the screen again in its own turn.
    // The note names the screen the watch read (Codex's hook review's among them).
    if (deps.startScreens?.shows(hostId, paneId) === true) {
      const shown = deps.startScreens.showing?.(hostId, paneId) ?? null;
      throw new Error(shown === null ? startScreenTexts.notSent : startScreenRefusal(shown));
    }
    const startScreens = deps.startScreens;
    await sendBound(
      {
        writer: backend,
        // The latest snapshot while the events keep it current and it is under 10 s old; a fresh one otherwise
        // (relay off, events not acknowledged), before the write and the Return.
        fresh: () => (deps.hosts.current === undefined ? deps.hosts.fresh(hostId) : deps.hosts.current(hostId)),
        pane: () => deps.hosts.pane(hostId, paneId),
        agent: () => deps.hosts.agent(hostId, paneId),
        run: () => deps.hosts.run(hostId, paneId),
        // Terminal input since a cleanup's binding calls off its keys.
        ...(deps.paneInputs === undefined ? {} : { inputGeneration: () => deps.paneInputs!.generation(hostId, paneId) }),
        ...(startScreens?.sendGuard === undefined ? {} : { startScreen: () => startScreens.sendGuard!(hostId, paneId) }),
        ...sendBox(hostId, paneId, backend),
      },
      paneId,
      text,
      binding,
      command,
    );
    // A `/model …` line sent to Cursor (one the user typed in the box; no pick makes one)
    // may change its footer with no turn: its footer is read again shortly.
    if (/^\/model [A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text) && deps.hosts.agent(hostId, paneId)?.agent?.toLowerCase() === "cursor") {
      deps.cursorReads?.lookAgain?.(hostId, paneId);
    }
    // With the sidebar's events live, the pane's change brings its own snapshot.
    if (deps.hosts.eventsLive?.(hostId) !== true) void deps.hosts.refresh(hostId);
  };
  handle(IPC.paneSend, async (_event, hostId, paneId, text, binding) => {
    if (
      !isId(hostId) ||
      !isId(paneId) ||
      typeof text !== "string" ||
      Buffer.byteLength(text) > maxTextBytes ||
      !isSendBinding(binding)
    ) {
      throw new Error("bad request");
    }
    await sendPaneBound(hostId, paneId, text, binding);
  });
  // A live model pick, never a finished command. The pane must be the agent's (its
  // binding names the kind, which the bound send compares); the model and effort are checked against the machine's
  // list for that agent and its patterns, and main makes the command (model-choices.ts modelPickCommand); it goes as
  // a pick does: at the prompt only (notAtPromptText otherwise: the page holds it), never into a start screen or a
  // dialog, while the pane is as the user saw it. A pick held for the next turn comes through here again when it goes.
  // Claude Code and Codex take it so; a pick naming an agent modelPickAgents does not list is refused as a bad
  // request before the list is read or anything is written.
  // Grok Build (`/model <id>`, an id its list names) and Cursor Agent (`/model <family name>`, never a
  // family whose name is inside another's) too, typed as characters with their Return under the same guards, and only
  // once a read of the pane in the Send's own turn shows the agent's box empty. Grok's files are read again after;
  // Cursor's model line is read until it names the family asked for (a few reads), and what it says is the answer.
  handle(IPC.modelPick, async (_event, hostId, paneId, pick, binding, ...rest): Promise<ModelPickOutcome | void> => {
    if (!isId(hostId) || !isId(paneId) || !isModelPick(pick) || !isSendBinding(binding) || rest.length > 0) throw new Error("bad request");
    if (!binding.isAgent || binding.kind?.toLowerCase() !== pick.agent) throw new Error("bad request");
    if (deps.modelCatalogs === undefined) throw new Error("Not sent: this window cannot check a model against the machine's list.");
    let view = await deps.modelCatalogs.settled(hostId, pick.agent);
    let built = modelPickCommand(pick, view.models);
    // Grok's and Cursor's list still being read (the row came from the list held before): its read
    // is waited for and the pick checked again, so a row shown either picks or says why not.
    if (!built.ok && view.loading && (pick.agent === "grok" || pick.agent === "cursor") && deps.modelCatalogs.afterReading !== undefined) {
      view = await deps.modelCatalogs.afterReading(hostId, pick.agent);
      built = modelPickCommand(pick, view.models);
    }
    if (!built.ok) throw new Error(`Not sent: ${built.reason}`);
    if (pick.agent !== "grok" && pick.agent !== "cursor") {
      await sendPaneBound(hostId, paneId, built.command, pickBinding(binding));
      return;
    }
    const backend = deps.hosts.backend(hostId);
    const calls = backend?.promptIO?.();
    if (backend === null || calls === undefined) throw new Error("Not sent: that machine is no longer listed.");
    const gate = deps.cursorReads?.gate;
    const key = paneReadKey(hostId, paneId);
    const read = (): Promise<string> => {
      const once = (): Promise<string> => calls.paneRead(paneId, cursorPickReadLines);
      return gate === undefined ? once() : gate.reading(key, once);
    };
    const name = pick.agent === "grok" ? "Grok" : "Cursor";
    // The agent's box on its screen: its text ("" when empty) and whether the agent works; null: not on its screen.
    const boxOf = (screen: string): { readonly text: string; readonly working: boolean } | null => {
      if (pick.agent === "grok") {
        const grok = readGrokScreen(screen);
        return grok === null ? null : { text: grok.draft, working: false };
      }
      const cursor = readCursorScreen(screen);
      return cursor.kind === "box" ? { text: cursor.empty ? "" : cursor.draft, working: cursor.working } : null;
    };
    // Grok's "Switched to …" lines on the screen read empty, so a new one after the Return is told apart.
    let switchedBefore: readonly { readonly name: string; readonly effort: string }[] = [];
    const ready = async (): Promise<string | null> => {
      let screen: string;
      try {
        screen = await read();
      } catch {
        return "Not sent: the pane did not answer. Check its terminal.";
      }
      const box = boxOf(screen);
      // The box must be empty (the plain box: no list or menu under it) before anything goes.
      if (box === null) return `Not sent: ${name}'s box is not on its screen now (a dialog or a list). Check its terminal.`;
      if (box.working) return notAtPromptText;
      if (box.text !== "") return `Not sent: ${name}'s box has text in it. Send or clear it, then pick again.`;
      if (pick.agent === "grok") switchedBefore = grokSwitchedNames(screen);
      return null;
    };
    // Right before its Return the box must hold exactly the command.
    // Cursor 2026.11.11 draws its own list under a typed `/model <family>`:
    // the box holding exactly the command, directly under it "Models matching" the family typed, its marked first row
    // naming exactly that family (the second column, the remembered variant, is not compared), and nothing else.
    const family = pick.agent === "cursor" ? cursorFamilyOf(view.models, pick.model)! : null;
    // Each read says whether the screen is that one, still on its way, or another
    // (send.ts reads again while it is on its way, at most typedReadBackReads times, every check before each read).
    const shows = async (command: string): Promise<TypedScreenRead> => {
      try {
        const screen = await read();
        return family === null ? grokTypedRead(screen, command) : cursorTypedRead(screen, command, family.name);
      } catch {
        return "differs";
      }
    };
    const pause = deps.pickSettleMs === undefined ? undefined : (): Promise<void> => new Promise((resolve) => setTimeout(resolve, deps.pickSettleMs));
    await sendPaneBound(hostId, paneId, built.command, pickBinding(binding), { ready, shows, ...(pause === undefined ? {} : { pause }) });
    if (pick.agent === "grok") {
      // As a Grok pick does: its files read again for the chips (Grok writes the model it switched to there).
      void deps.chat.grokFiles(hostId, paneId);
      return await grokAfterPick(view.models, pick.model, switchedBefore, read, () => new Promise((resolve) => setTimeout(resolve, deps.pickSettleMs ?? openCodeSettleMs)));
    }
    deps.cursorReads?.lookAgain?.(hostId, paneId);
    let screen: string | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, deps.pickSettleMs ?? openCodeSettleMs));
      try {
        screen = await read();
      } catch {
        continue;
      }
      const line = cursorModelLineOf(screen);
      if (line !== null && sameCursorFamily(line, family!.name)) break;
    }
    return { type: "cursor", modelLine: screen === null ? null : cursorModelLineOf(screen), footer: screen === null ? null : parseCursorFooter(screen) };
  });
  // An OpenCode model pick by its id: the model must be in the machine's list, read with its display
  // name (`--verbose`), and that name one OpenCode's search can be typed with; every key is made in main
  // (opencode-pick.ts). The same guards as a model pick: no start screen, the pane's binding, its send turn; never while
  // OpenCode works or waits on a question (refused, not held); one at a time per pane.
  handle(IPC.openCodePick, async (_event, hostId, paneId, model, binding, ...rest) => {
    if (!isId(hostId) || !isId(paneId) || !isModelId("opencode", model) || !isSendBinding(binding) || rest.length > 0) throw new Error("bad request");
    if (!binding.isAgent || binding.kind?.toLowerCase() !== "opencode") throw new Error("bad request");
    if (deps.startScreens?.shows(hostId, paneId) === true) {
      const shown = deps.startScreens.showing?.(hostId, paneId) ?? null;
      return { type: "refused", note: shown === null ? startScreenTexts.notSent : startScreenRefusal(shown) };
    }
    if (deps.modelCatalogs === undefined) return { type: "refused", note: "Not set: this window cannot check a model against the machine's list." };
    // Its display name as read (`--verbose`), whole (not cut), of characters OpenCode's search takes as typed.
    const pickable = (one: CatalogModel): boolean =>
      one.variants !== undefined && one.group !== null && /^[^\p{Cc}\p{Cf}\u{2026}]{1,80}$/u.test(one.label) && one.label.trim() === one.label;
    let view = await deps.modelCatalogs.settled(hostId, "opencode");
    let entry = view.models.find((one) => one.id === model);
    // OpenCode's list still being read (the row came from the list held before, or one without its
    // display names): that read is waited for and the model looked up again, so a row shown either picks or says why not.
    if ((entry === undefined || !pickable(entry)) && view.loading && deps.modelCatalogs.afterReading !== undefined) {
      view = await deps.modelCatalogs.afterReading(hostId, "opencode");
      entry = view.models.find((one) => one.id === model);
    }
    if (entry === undefined) return { type: "refused", note: "Not set: that model is not in OpenCode's list on this machine." };
    if (!pickable(entry)) {
      return { type: "refused", note: "Not set: OpenCode's list on this machine gives no display name for it, so pick it in OpenCode's own list." };
    }
    const backend = deps.hosts.backend(hostId);
    const calls = backend?.promptIO?.();
    if (backend === null || calls === undefined) return { type: "refused", note: "Not set: that machine is no longer listed." };
    const gate = deps.cursorReads?.gate;
    const key = paneReadKey(hostId, paneId);
    const { result } = await pickOpenCodeBound(
      {
        writer: backend,
        calls,
        fresh: () => deps.hosts.fresh(hostId),
        pane: () => deps.hosts.pane(hostId, paneId),
        agent: () => deps.hosts.agent(hostId, paneId),
        run: () => deps.hosts.run(hostId, paneId),
        ...(deps.paneInputs === undefined ? {} : { inputGeneration: () => deps.paneInputs!.generation(hostId, paneId) }),
        ...(gate === undefined ? {} : { reading: <T>(read: () => Promise<T>) => gate.reading(key, read) }),
      },
      paneId,
      // pickable: its provider is named.
      { id: entry.id, name: entry.label, provider: entry.group! },
      pickBinding(binding),
      deps.pickSettleMs === undefined ? undefined : () => new Promise((resolve) => setTimeout(resolve, deps.pickSettleMs)),
      key,
    );
    void deps.hosts.refresh(hostId);
    return result.type === "refused" ? { ...result, note: redactError(result.note) } : result;
  });
  // A Cursor pick drives its own menu by keys, bound like a Send (send.ts pickCursorBound).
  handle(IPC.cursorPick, async (_event, hostId, paneId, pick, binding) => {
    if (!isId(hostId) || !isId(paneId) || !isCursorPick(pick) || !isSendBinding(binding)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    const calls = backend?.promptIO?.();
    if (backend === null || calls === undefined) return { type: "refused", note: "Not set: that machine is no longer listed.", footer: null };
    const gate = deps.cursorReads?.gate;
    const key = paneReadKey(hostId, paneId);
    const { result, screen } = await pickCursorBound(
      {
        writer: backend,
        calls,
        fresh: () => deps.hosts.fresh(hostId),
        pane: () => deps.hosts.pane(hostId, paneId),
        agent: () => deps.hosts.agent(hostId, paneId),
        run: () => deps.hosts.run(hostId, paneId),
        ...(deps.paneInputs === undefined ? {} : { inputGeneration: () => deps.paneInputs!.generation(hostId, paneId) }),
        ...(gate === undefined ? {} : { reading: <T>(read: () => Promise<T>) => gate.reading(key, read) }),
      },
      paneId,
      pick,
      binding,
    );
    if (screen !== null) deps.cursorReads?.noteScreen(hostId, paneId, screen);
    void deps.hosts.refresh(hostId);
    return result.type === "refused" ? { ...result, note: redactError(result.note) } : result;
  });
  // A Grok pick types its one /model command, bound like a Send (send.ts pickGrokBound).
  handle(IPC.grokPick, async (_event, hostId, paneId, pick, files, binding) => {
    if (!isId(hostId) || !isId(paneId) || !isGrokPick(pick) || !isGrokFiles(files) || !isSendBinding(binding)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    const calls = backend?.promptIO?.();
    if (backend === null || calls === undefined) return { type: "refused", note: "Not set: that machine is no longer listed." };
    const gate = deps.cursorReads?.gate;
    const key = paneReadKey(hostId, paneId);
    const { result } = await pickGrokBound(
      {
        writer: backend,
        calls,
        fresh: () => deps.hosts.fresh(hostId),
        pane: () => deps.hosts.pane(hostId, paneId),
        agent: () => deps.hosts.agent(hostId, paneId),
        run: () => deps.hosts.run(hostId, paneId),
        ...(deps.paneInputs === undefined ? {} : { inputGeneration: () => deps.paneInputs!.generation(hostId, paneId) }),
        ...(gate === undefined ? {} : { reading: <T>(read: () => Promise<T>) => gate.reading(key, read) }),
      },
      paneId,
      pick,
      files,
      binding,
      undefined,
      // A fresh read of summary.json and signals.json may settle it too.
      () => deps.chat.grokFiles(hostId, paneId),
    );
    // And one more after the pick, for the chips.
    void deps.chat.grokFiles(hostId, paneId);
    void deps.hosts.refresh(hostId);
    return result.type === "refused" ? { ...result, note: redactError(result.note) } : result;
  });
  // A Permissions pick, driven by the agent's own keys or command, bound like a Send (mode-pick.ts pickModeBound).
  handle(IPC.modePick, async (_event, hostId, paneId, agent, target, binding) => {
    if (!isId(hostId) || !isId(paneId) || typeof agent !== "string" || !isModeAgent(agent) || !isOfferedMode(agent, target) || !isSendBinding(binding)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    const calls = backend?.promptIO?.();
    if (backend === null || calls === undefined) return { type: "refused", note: "Not set: that machine is no longer listed.", mode: null };
    const gate = deps.cursorReads?.gate;
    const key = paneReadKey(hostId, paneId);
    const { result, screen } = await pickModeBound(
      {
        writer: backend,
        calls,
        fresh: () => deps.hosts.fresh(hostId),
        pane: () => deps.hosts.pane(hostId, paneId),
        agent: () => deps.hosts.agent(hostId, paneId),
        run: () => deps.hosts.run(hostId, paneId),
        ...(deps.paneInputs === undefined ? {} : { inputGeneration: () => deps.paneInputs!.generation(hostId, paneId) }),
        ...(gate === undefined ? {} : { reading: <T>(read: () => Promise<T>) => gate.reading(key, read) }),
      },
      paneId,
      agent,
      target,
      binding,
    );
    // A pick may press Esc in the pane: the next Claude send reads its box first.
    boxChecks.mark(backend, paneId);
    // The last screen read goes to the shown Chat's watch too (Claude's and Grok's mode, Cursor's footer), before
    // the answer; the watch's next read goes too even unchanged (it retires the pick's warning).
    deps.cursorReads?.notePick(hostId, paneId, screen);
    void deps.hosts.refresh(hostId);
    return result.type === "refused" ? { ...result, note: redactError(result.note) } : result;
  });
  // Stop: one plain Esc to the pane the user sees, every press (stop.ts).
  handle(IPC.paneStop, async (_event, hostId, paneId, binding) => {
    if (!isId(hostId) || !isId(paneId) || !isStopBinding(binding)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    if (backend === null) return stopTexts.notListed;
    // An Esc on the pane: the next Claude send reads its box first.
    boxChecks.mark(backend, paneId);
    const note = await stopAgent(
      {
        writer: backend,
        machine: deps.hosts.name(hostId) ?? "the machine",
        pane: () => deps.hosts.pane(hostId, paneId),
        identity: () => {
          const identity = deps.hosts.connectionIdentity(hostId);
          return identity === null ? null : { incarnation: identity.incarnation, connection: deps.hosts.connection(hostId), epoch: identity.epoch };
        },
      },
      paneId,
      binding,
    );
    void deps.hosts.refresh(hostId);
    return note === null ? null : redactError(note);
  });
  // The pane still holds the terminal the page showed, and Claude Code runs there.
  const claudeShown = (hostId: string, paneId: string, binding: { terminalID: string; kind: string | null }): boolean => {
    if (binding.kind !== "claude") return false;
    const pane = deps.hosts.pane(hostId, paneId);
    return pane !== null && (binding.terminalID === "" || pane.terminalID === binding.terminalID);
  };
  // A press outside Herdr's working: Esc only while Claude's screen shows its working line.
  handle(IPC.paneStopIfWorking, async (_event, hostId, paneId, binding) => {
    if (!isId(hostId) || !isId(paneId) || !isStopBinding(binding)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    if (backend === null || !claudeShown(hostId, paneId, binding)) return { sent: false, note: null };
    const site = boxSite(hostId, paneId, backend);
    if (site === null || !(await screenWorking(site))) return { sent: false, note: null };
    boxChecks.mark(backend, paneId);
    const note = await stopAgent(
      {
        writer: backend,
        machine: deps.hosts.name(hostId) ?? "the machine",
        pane: () => deps.hosts.pane(hostId, paneId),
        identity: () => {
          const identity = deps.hosts.connectionIdentity(hostId);
          return identity === null ? null : { incarnation: identity.incarnation, connection: deps.hosts.connection(hostId), epoch: identity.epoch };
        },
      },
      paneId,
      binding,
    );
    void deps.hosts.refresh(hostId);
    return { sent: note === null, note: note === null ? null : redactError(note) };
  });
  // After an Esc, Chat's last send put back in Claude's box (cancelled before any answer), the box emptied.
  handle(IPC.paneAfterStop, async (event, hostId, paneId, binding) => {
    if (!isId(hostId) || !isId(paneId) || !isStopBinding(binding)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    if (backend === null || !claudeShown(hostId, paneId, binding)) return { cancelled: null, cleared: false, working: null };
    const site = boxSite(hostId, paneId, backend);
    if (site === null) return { cancelled: null, cleared: false, working: null };
    // The read that shows Claude's working line gone tells the page at once (before any clear).
    let working: boolean | null = null;
    const seen = (now: boolean): void => {
      if (working === false) return;
      working = now;
      if (!now) tellPage(event, IPC.paneEscScreen, { hostId, paneId, working: false } satisfies EscScreenEvent);
    };
    // Bound before the first read to the machine and the agent the Esc went to (the
    // page's binding: terminal, kind, session, the machine's entry) and its run now; each clearing key goes only
    // while that holds, with no Terminal input since (a Stop or Esc press is not text: it does not call it off).
    // Only a last send that went to this run is ours. A Send's write to the pane started
    // since (composerWrites, counted by sendBound) calls the keys off too: the box may hold its text with ours.
    const view: SendSite = {
      writer: backend,
      fresh: async () => true,
      pane: () => deps.hosts.pane(hostId, paneId),
      agent: () => deps.hosts.agent?.(hostId, paneId) ?? null,
      run: () => deps.hosts.run?.(hostId, paneId) ?? null,
      ...(deps.paneInputs === undefined ? {} : { inputGeneration: () => deps.paneInputs!.generation(hostId, paneId) }),
    };
    const bound = cleanupBinding(view, { terminalID: binding.terminalID, isAgent: true, kind: binding.kind, session: binding.session }, {
      site,
      own: () => [],
      sent: () => undefined,
      machine: () => deps.hosts.backend(hostId) === backend && deps.hosts.connectionIdentity?.(hostId)?.incarnation === binding.incarnation,
    }, paneId);
    // One at a time per pane; the send is claimed as the box matches it (not after the clear).
    const found = await afterStopOnce(backend, paneId, boundBoxSite(site, bound.holds), sentTexts, afterStopTurns, seen, bound.run);
    return { ...found, working };
  });
  // Claude Code's queue record for the pane's session, the transcript of
  // the session Herdr names for the Claude agent there, which must be the page's (binding.session). None (no
  // session, another session, no transcript reader): the take-back presses no key.
  const queueRecordOf = (hostId: string, paneId: string, backend: HerdrHostBackend, session: string | null): QueueRecord | undefined => {
    if (session === null || typeof backend.transcripts !== "function") return undefined;
    const named = deps.hosts.agent?.(hostId, paneId)?.agentSession;
    if (named === undefined || named.source !== "herdr:claude" || named.kind !== "id" || named.value !== session) return undefined;
    const ref = sessionRefFromAgentSession(named);
    const reader = backend.transcripts();
    if (ref === null || ref.format !== "claude" || reader === null) return undefined;
    return transcriptQueueRecord(reader, ref);
  };
  // The user's messages still waiting in Claude's queue, taken back: Up, then Ctrl+U (claude-box.ts
  // takeBackQueued). Bound before the first read as the reads after an Esc are (the page's binding, the machine's
  // entry, the run now), and to no Stop, Esc, pick or failed send since (box marks): each key goes only while that
  // holds. Only texts Chat sent to this run count, so a run or pane changed since the send presses nothing.
  // `none` only for a read that shows no queue; anything else is a refusal with its note, so the page never stops
  // on it. The command connection is the page's, no dialog shows by Herdr's snapshot, and the turn is the one the
  // page saw, checked before the first read and right before every key. The whole take-back runs in the pane's
  // Send order.
  handle(IPC.paneTakeBack, async (_event, hostId, paneId, binding, texts) => {
    if (
      !isId(hostId) ||
      !isId(paneId) ||
      !isStopBinding(binding) ||
      !Array.isArray(texts) ||
      texts.length === 0 ||
      !texts.every((text) => typeof text === "string" && Buffer.byteLength(text) <= maxTextBytes)
    ) {
      throw new Error("bad request");
    }
    const refused = (note: string): QueuedTakeBack => ({ type: "left", note, pressed: false });
    // More of the user's texts than a take-back asks for is said, never read as no queue (nor cut short).
    if (texts.length > SentTexts.kept) return refused(takeBackTexts.tooMany);
    const backend = deps.hosts.backend(hostId);
    if (backend === null) return refused(takeBackTexts.connection);
    if (!claudeShown(hostId, paneId, binding)) return refused(takeBackTexts.notOurs);
    const site = boxSite(hostId, paneId, backend);
    if (site === null) return refused(takeBackTexts.unread);
    // The page's machine entry, its connection and its command connection (a non-null epoch) are the
    // ones now: compared before the first read and right before every key.
    const connected = (): boolean => {
      const identity = deps.hosts.connectionIdentity?.(hostId) ?? null;
      return (
        deps.hosts.backend(hostId) === backend &&
        identity !== null &&
        identity.incarnation === binding.incarnation &&
        binding.epoch !== null &&
        identity.epoch === binding.epoch &&
        deps.hosts.connection?.(hostId) === binding.connection
      );
    };
    // In the pane's Send order (send.ts inPaneTurn), so a Send made meanwhile waits for the pulled row
    // to be cleared or left, then reads the box (it is marked due before the first read, so before any key).
    return inPaneTurn(backend, paneId, async (): Promise<QueuedTakeBack> => {
      boxChecks.mark(backend, paneId);
      if (!connected()) return refused(takeBackTexts.connection);
      const view: SendSite = {
        writer: backend,
        fresh: async () => true,
        pane: () => deps.hosts.pane(hostId, paneId),
        agent: () => deps.hosts.agent?.(hostId, paneId) ?? null,
        run: () => deps.hosts.run?.(hostId, paneId) ?? null,
        ...(deps.paneInputs === undefined ? {} : { inputGeneration: () => deps.paneInputs!.generation(hostId, paneId) }),
      };
      const bound = cleanupBinding(view, { terminalID: binding.terminalID, isAgent: true, kind: binding.kind, session: binding.session }, {
        site,
        own: () => [],
        sent: () => undefined,
        machine: () => deps.hosts.backend(hostId) === backend && deps.hosts.connectionIdentity?.(hostId)?.incarnation === binding.incarnation,
        marks: () => boxChecks.marks(backend, paneId),
      }, paneId);
      // The turn the page saw (its episode), by Herdr's snapshot; a dialog by it too.
      const turnNow = (): TakeBackTurn => takeBackTurn(binding, view.pane(), view.agent());
      // The last synchronous check before every key, nothing awaited between.
      const holds = (): boolean => bound.holds() && connected() && turnNow() !== "dialog";
      // The pull proved by Claude Code's own record; what it leaves in the row
      // holds every Send back until a read shows it resolved.
      const record = queueRecordOf(hostId, paneId, backend, binding.session);
      return takeBackQueuedOnce(backend, paneId, boundBoxSite(site, holds), {
        asked: texts as string[],
        own: sentTexts.recent(backend, paneId, bound.run),
        forget: (text) => void sentTexts.forget(backend, paneId, text),
        turn: turnNow,
        ...(record === undefined ? {} : { record }),
        row: (state) => pulledRows.set(backend, paneId, state),
      });
    });
  });
  // The backstop's read: messages waiting in Claude's queue.
  handle(IPC.paneQueued, async (_event, hostId, paneId) => {
    if (!isId(hostId) || !isId(paneId)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    if (backend === null) return null;
    const site = boxSite(hostId, paneId, backend);
    return site === null ? null : await screenQueued(site);
  });
  // Restart: /exit, then the same session's resume command in the pane's shell (restart.ts).
  handle(IPC.paneRestart, async (event, hostId, paneId, binding) => {
    if (!isId(hostId) || !isId(paneId) || !isRestartBinding(binding)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    if (backend === null) return "Not restarted: that machine is no longer listed";
    // The pane's screen (Codex's row after /exit), read through the pane-read gate.
    const screen = boxSite(hostId, paneId, backend);
    const note = await restartAgent(
      {
        writer: backend,
        machine: deps.hosts.name(hostId) ?? "the machine",
        fresh: () => deps.hosts.fresh(hostId),
        pane: () => deps.hosts.pane(hostId, paneId),
        agent: () => deps.hosts.agent(hostId, paneId),
        identity: () => {
          const identity = deps.hosts.connectionIdentity(hostId);
          return identity === null ? null : { incarnation: identity.incarnation, connection: deps.hosts.connection(hostId), epoch: identity.epoch };
        },
        snapshotEpoch: () => deps.hosts.snapshotEpoch(hostId),
        startCommands: () => startCommandsOf(backend),
        ...(screen === null ? {} : { read: screen.read }),
        entry: () => deps.hosts.backend(hostId) === backend,
        run: () => deps.hosts.run(hostId, paneId),
        // The user's Terminal input to the pane, a composer write to it, a box mark
        // (Stop, Esc, a pick, a failed send): any of them since the restart began calls off its next Return.
        inputs: () => [deps.paneInputs?.generation(hostId, paneId) ?? 0, composerWrites.count(backend, paneId), boxChecks.marks(backend, paneId)],
        // The lock wait's note, on the page while the restart still runs.
        note: (text) => tellPage(event, IPC.paneRestartNote, { hostId, paneId, note: redactError(text) } satisfies RestartNoteEvent),
      },
      paneId,
      binding,
    );
    void deps.hosts.refresh(hostId);
    return note === null ? null : redactError(note);
  });
  // The user's Install or Update (bound to the machine as the window showed it), and
  // Settings' fresh read. Nothing is installed without the click; a stale binding sends nothing (integrations.ts).
  if (deps.integrations !== undefined) {
    const integrations = deps.integrations;
    handle(IPC.integrationInstall, async (_event, hostId, target, binding) => {
      if (!isId(hostId) || !isShownTarget(target) || !isIntegrationBinding(binding)) throw new Error("bad request");
      const reply = await integrations.install(hostId, target, binding);
      return reply.sent ? reply : { sent: false, note: redactError(reply.note) };
    });
    handle(IPC.integrationsRefresh, () => integrations.refresh());
  }
  // The needs-you card's questions and answers (src/main/prompt/prompts.ts).
  if (deps.prompts !== undefined) {
    const prompts = deps.prompts;
    handle(IPC.promptsList, () => prompts.list());
    handle(IPC.promptAnswer, async (_event, request) => {
      if (!isAnswerRequest(request)) throw new Error("bad request");
      const result = await prompts.answer(request);
      return result.type === "sent" || result.type === "changed" ? result : { ...result, note: redactError(result.note) };
    });
  }
  handle(IPC.ghosttyInfo, (_event, hostId, paneId) => {
    if (!isId(hostId) || !isId(paneId)) throw new Error("bad request");
    return deps.ghostty.availability(hostId, paneId);
  });
  handle(IPC.ghosttyOpen, (_event, hostId, paneId) => {
    if (!isId(hostId) || !isId(paneId)) throw new Error("bad request");
    return deps.ghostty.open(hostId, paneId);
  });
  handle(IPC.attachmentUpload, (_event, hostId, data, extension, uploadId) => {
    if (
      !isId(hostId) ||
      !(data instanceof Uint8Array) ||
      data.byteLength === 0 ||
      data.byteLength > maxUploadBytes ||
      typeof extension !== "string" ||
      safeUploadExtension(extension) !== extension ||
      !(uploadId === undefined || isId(uploadId))
    ) {
      throw new Error("bad request");
    }
    return uploadId === undefined ? deps.uploadAttachment(hostId, data, extension) : deps.uploadAttachment(hostId, data, extension, uploadId);
  });
  on(IPC.attachmentCancel, (_event, uploadId) => {
    if (isId(uploadId)) deps.cancelUpload?.(uploadId);
  });
  handle(IPC.attachmentDiscard, (_event, hostId, path) => {
    // Only the shape of one of the uploader's own files here; the machine's home and the file are checked there.
    if (!isId(hostId) || typeof path !== "string" || path.length > 4_096 || !isSafeAbsolutePath(path) || !isUploadPathShape(path)) {
      throw new Error("bad request");
    }
    if (deps.discardAttachment === undefined) throw new Error("Removing uploads is not available here.");
    return deps.discardAttachment(hostId, path);
  });
  handle(IPC.clipboardFiles, () => deps.clipboardFiles());
  // Settings' uploads, named by the machine's id only: the renderer never gives a path. What is
  // counted and removed is decided in main (uploads/service.ts: the uploader's own files in its own folders).
  // And whether it is the page's fresh ask after an upload (a walk started
  // after it, never one already running), a boolean when given.
  handle(IPC.uploadsCount, (_event, hostId, ...rest) => {
    if (!isId(hostId) || rest.length > 1 || (rest.length === 1 && typeof rest[0] !== "boolean")) throw new Error("bad request");
    if (deps.uploadsCount === undefined) throw new Error("Counting uploads is not available here.");
    return deps.uploadsCount(hostId, rest[0] === true);
  });
  handle(IPC.uploadsDeleteNow, (_event, hostId, ...rest) => {
    if (!isId(hostId) || rest.length > 0) throw new Error("bad request");
    if (deps.deleteUploadsNow === undefined) throw new Error("Removing uploads is not available here.");
    return deps.deleteUploadsNow(hostId);
  });
  handle(IPC.checkForUpdates, (_event, ...rest) => {
    if (rest.length > 0) throw new Error("bad request");
    if (deps.checkForUpdates === undefined) throw new Error("Updates are not available here.");
    return deps.checkForUpdates();
  });
  // No arguments but the setting's one boolean. Download and Restart act only on what
  // the main process found and downloaded itself, and Restart asks there first.
  const updates = (rest: unknown[]): UpdateIpc => {
    if (rest.length > 0) throw new Error("bad request");
    if (deps.updates === undefined) throw new Error("Updates are not available here.");
    return deps.updates;
  };
  handle(IPC.updateState, (_event, ...rest) => updates(rest).view());
  handle(IPC.updateDownload, (_event, ...rest) => updates(rest).download());
  handle(IPC.updateInstall, (_event, ...rest) => updates(rest).requestInstall());
  handle(IPC.updateAutomatic, (_event, on, ...rest) => {
    if (typeof on !== "boolean") throw new Error("bad request");
    return updates(rest).setAutomatic(on);
  });
  // An agent's model list on a machine, as held now (a read begun behind when there is none or it is
  // old); only the machine's id and one of the agents with a list.
  handle(IPC.modelCatalog, (_event, hostId, agent, ...rest) => {
    if (!isId(hostId) || !isCatalogAgent(agent) || rest.length > 0) throw new Error("bad request");
    if (deps.modelCatalogs === undefined) return builtInCatalog(agent);
    return deps.modelCatalogs.view(hostId, agent);
  });
  handle(IPC.startCommands, (_event, hostId) => {
    if (!isId(hostId)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    return backend === null ? absentStartCommands : startCommandsOf(backend);
  });
  // Settings › Chat's save: a machine's id, one of the kinds Settings edits, and the command (the
  // checks themselves, the reader's, run in start-commands-write.ts). Only on a machine that answers now; what was
  // saved is the machine's start commands from then on (New agent, Resume and restart read it in main).
  handle(IPC.startCommandSave, async (_event, hostId, kind, command, ...rest) => {
    if (!isId(hostId) || !isEditableStartKind(kind) || typeof command !== "string" || command.length > maximumSaveRequestLength || rest.length > 0) {
      throw new Error("bad request");
    }
    // Asked when the request comes, and again when its turn in the machine's queue comes,
    // right before the write: still listed, still the backend it was queued on (an edit replaces it), connected.
    const writable = () => {
      const backend = deps.hosts.backend(hostId);
      const host = deps.hosts.list().find((candidate) => candidate.id === hostId);
      if (backend === null || host === undefined) throw new Error("That machine is no longer listed.");
      if (host.state !== "connected") throw new Error(`${host.name} is not connected.`);
      return backend;
    };
    const backend = writable();
    return saveStartCommandOf(backend, kind, command, () => {
      if (writable() !== backend) throw new Error("That machine was edited before the save started. Nothing was saved.");
    });
  });
  handle(IPC.openLicenses, async (_event, ...rest) => {
    if (rest.length > 0) throw new Error("bad request");
    if (deps.openLicenses === undefined) throw new Error("The licenses are not available here.");
    return deps.openLicenses();
  });
  // New agent: a tab in the workspace, or a split of a pane (the guarded split: fresh state, refused past 4, one
  // at a time per tab; pane-actions.ts), and the kind started there (new-agent.ts); the next snapshot lists it.
  handle(IPC.newAgent, async (event, hostId, request) => {
    if (!isId(hostId) || !isNewAgentRequest(request)) throw new Error("bad request");
    const backend = deps.hosts.backend(hostId);
    if (backend === null) throw new Error("That machine is no longer listed.");
    // The workspace is one the machine has as it answers now, before anything is read or made.
    const host = deps.hosts.list().find((candidate) => candidate.id === hostId);
    if (host === undefined) throw new Error("That machine is no longer listed.");
    if (host.state !== "connected" || host.topology === null) throw new Error(`${host.name} is not answering.`);
    if (!host.topology.workspaces.some((workspace) => workspace.workspaceID === request.workspaceId)) {
      throw new Error(`That workspace is not on ${host.name} now.`);
    }
    const actions = backend.workspaceActions?.();
    if (actions === undefined) throw new Error("This machine cannot start an agent from here.");
    // The machine and the connection New agent began on, taken before anything is
    // awaited; every request it sends is checked against it right before it goes (machine-link.ts).
    const link = machineLink(deps.hosts, hostId, host.name);
    // The Model and Effort checked against the machine's list for the agent before anything is made.
    const flags = await newAgentFlags(deps.modelCatalogs, hostId, request);
    const commands = await startCommandsOf(backend);
    // The machine's name for New agent's lines, and its home for a `~` folder (folder-cwd.ts).
    const home = backend.homeFolder?.bind(backend);
    const machine = { name: host.name, link, ...(home === undefined ? {} : { home }) };
    // Whether the kind's integration is in place on this machine before anything goes; the
    // pane its agent started in is then marked as started after it (integrations.ts startToken).
    const token = request.kind === "shell" ? null : (deps.integrations?.startToken?.(hostId, request.kind) ?? null);
    const started = async (run: Promise<NewAgentResult>): Promise<NewAgentResult> => {
      const result = await run;
      if (token !== null && result.start.type !== "noAgent" && result.start.type !== "shell") deps.integrations?.agentStarted?.(token, result.paneId, result.kind);
      return result;
    };
    const start = (herdr: NewAgentHerdr) => started(newAgent(herdr, commands, request, liveClock, firstAgentTimeoutMs, agentPollMs, machine, flags));
    if (request.where?.type === "split") {
      return newAgentInSplit(deps.hosts, deps.layouts, event.sender, hostId, request, actions, start);
    }
    const result = await start(actions);
    await deps.hosts.refresh(hostId);
    return result;
  });
  // The terminal drawer's shell, made by New agent's shell path (tab.create alone) in
  // a workspace the machine has as it answers now. Its × is the pane close, which always asks in the page
  // (no idle answer comes from here). Extra arguments are refused, as uploads-count's are.
  handle(IPC.drawerShellOpen, (_event, hostId, request, ...rest) => {
    if (!isId(hostId) || !isDrawerShellRequest(request) || rest.length > 0) throw new Error("bad request");
    return openDrawerShell(deps.hosts, hostId, request);
  });
  // The folder field's list: one folder on a machine that answers now, over its own connection (read
  // only, never recursive: folder-browse.ts). A machine not listed or not answering says so instead of failing.
  handle(IPC.folderBrowse, (_event, hostId, directory, ...rest) => {
    if (!isId(hostId) || !isBrowseDirectory(directory) || rest.length > 0) throw new Error("bad request");
    const host = deps.hosts.list().find((candidate) => candidate.id === hostId);
    const backend = deps.hosts.backend(hostId);
    if (host === undefined || backend === null || host.state !== "connected") return { type: "offline" } satisfies FolderListing;
    if (backend.browseFolder === undefined) return { type: "unavailable" } satisfies FolderListing;
    return backend.browseFolder(directory);
  });
  // Choose…, This Mac's folder window (T3 Code's pickFolder); refused for any other machine, whose
  // folders are not on this disk.
  handle(IPC.folderPick, (event, hostId, typed, ...rest) => {
    if (!isId(hostId) || typeof typed !== "string" || typed.length > maxBrowsePathBytes || rest.length > 0) throw new Error("bad request");
    const host = deps.hosts.list().find((candidate) => candidate.id === hostId);
    if (host === undefined || host.kind !== "local") throw new Error(folderPickTexts.onlyThisMac);
    if (deps.pickFolder === undefined) throw new Error(folderPickTexts.notAvailable);
    return deps.pickFolder(event.sender, typed);
  });
  // New workspace: one workspace.create on the machine and connection the user asked on (new-workspace.ts); the sidebar read again.
  handle(IPC.newWorkspace, (_event, hostId, request) => {
    if (!isId(hostId) || !isNewWorkspaceRequest(request)) throw new Error("bad request");
    return newWorkspace(deps.hosts, hostId, request);
  });
  // A tile's split, a divider's resize, zoom, close (pane-actions.ts): bound to the pane as the sender's window
  // shows it, checked against that window and a fresh snapshot and layout; the layout read again before it resolves.
  // Rename workspace… (pane-actions.ts): bound to the machine's connection as the page saw it.
  handle(IPC.renameWorkspace, (_event, hostId, request) => {
    if (!isId(hostId) || !isWorkspaceRename(request)) throw new Error("bad request");
    return runWorkspaceRename(deps.hosts, hostId, request);
  });
  handle(IPC.paneAction, (event, hostId, action) => {
    if (!isId(hostId) || !isPaneAction(action)) throw new Error("bad request");
    return runPaneAction(deps.hosts, deps.layouts, event.sender, hostId, action);
  });
  handle(IPC.chatEarlier, (event, slot) => deps.chat.loadEarlier(event.sender, isSlot(slot) ? slot : ""));
  handle(IPC.changesAgent, (event, hostId, paneId) => {
    if (!isId(hostId) || !isId(paneId)) throw new Error("bad request");
    return deps.changes.agent(event.sender, hostId, paneId);
  });
  handle(IPC.changesDiff, (event, hostId, paneId, request) => {
    if (!isId(hostId) || !isId(paneId) || !isChangesDiffRequest(request)) throw new Error("bad request");
    return deps.changes.diff(event.sender, hostId, paneId, request);
  });
  handle(IPC.changesOverview, (event, hostId) => {
    if (!isId(hostId)) throw new Error("bad request");
    return deps.changes.overview(event.sender, hostId);
  });
  handle(IPC.chatImage, (event, path) => {
    if (typeof path !== "string" || path === "" || Buffer.byteLength(path) > maxPathBytes) throw new Error("bad request");
    return deps.chat.image(event.sender, path);
  });
  // An inline picture left out of a relay read; main fetches only one its window's chat shows:
  // that chat, by its machine and slot.
  handle(IPC.chatBlobImage, (event, blob, hostId, slot) => {
    if (!isChatImageBlob(blob) || !isId(hostId) || (slot !== undefined && !isSlot(slot))) throw new Error("bad request");
    return deps.chat.blobImage(event.sender, blob, { hostId, slot: slot ?? "" });
  });

  on(IPC.terminalInput, (event, sessionId, data) => {
    if (!isId(sessionId) || !isTerminalInput(data)) return;
    deps.terminals.input(event.sender, sessionId, data);
  });
  on(IPC.terminalResize, (event, sessionId, cols, rows) => {
    if (!isId(sessionId) || !isDimension(cols) || !isDimension(rows)) return;
    deps.terminals.resize(event.sender, sessionId, cols, rows);
  });
  on(IPC.terminalClose, (event, sessionId) => {
    if (!isId(sessionId)) return;
    deps.terminals.close(event.sender, sessionId);
  });
  // What the page's terminal parsed (a credited stream's flow).
  on(IPC.terminalParsed, (event, sessionId, bytes) => {
    if (!isId(sessionId) || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    deps.terminals.parsed(event.sender, sessionId, bytes);
  });
  // A tile's Chat names its slot; none is the one pane view's chat.
  on(IPC.chatOpen, (event, hostId, paneId, slot, follow) => {
    if (!isId(hostId) || !isId(paneId) || (slot !== undefined && !isSlot(slot))) return;
    if (follow !== undefined && !(Number.isSafeInteger(follow) && (follow as number) >= 0)) return;
    deps.chat.open(event.sender, hostId, paneId, slot ?? "", follow as number | undefined);
  });
  on(IPC.chatClose, (event, slot) => {
    if (slot === undefined) deps.chat.close(event.sender);
    else if (isSlot(slot)) deps.chat.close(event.sender, slot);
  });
  on(IPC.changesClose, (event) => deps.changes.close(event.sender));
  // The pane the window shows (null: none); its tab's layout follows on IPC.layoutUpdate (layouts.ts).
  on(IPC.layoutWatch, (event, hostId, paneId) => {
    if (hostId === null && paneId === null) deps.layouts.watch(event.sender, null, null);
    else if (isId(hostId) && isId(paneId)) deps.layouts.watch(event.sender, hostId, paneId);
  });
  on(IPC.chatFollow, (event, following, slot) => {
    if (typeof following === "boolean") deps.chat.setFollowingNewest(event.sender, following, isSlot(slot) ? slot : "");
  });
  on(IPC.clipboardWrite, (_event, text) => {
    if (typeof text === "string" && Buffer.byteLength(text) <= maxCopyBytes) deps.copyText(text);
  });
  // A link in Chat or the Terminal: http and https only (the window's own guard's rule), never the window.
  on(IPC.openLink, (_event, url) => {
    if (typeof url === "string" && isSafeExternalUrl(url)) deps.openLink?.(url);
  });
  on(IPC.appCommandDone, (_event, id) => {
    if (isId(id)) deps.commandDone(id);
  });
}

/** What a Grok pick's command needs, checked (a model id of Grok's shape, known words). */
function isGrokFiles(value: unknown): value is GrokFiles {
  if (typeof value !== "object" || value === null) return false;
  const files = value as Record<string, unknown>;
  const model = files["model"], effort = files["effort"], window = files["window"];
  return (
    (model === null || (typeof model === "string" && grokModelLabel(model) !== null)) &&
    (effort === null || (typeof effort === "string" && ["low", "medium", "high", "xhigh"].includes(effort))) &&
    (window === null || (typeof window === "string" && (grokWindows as readonly string[]).includes(window)))
  );
}
