// The preload: the only bridge into the page. It runs sandboxed, with context
// isolation, so it can reach only `electron`'s contextBridge and ipcRenderer,
// and it exposes a fixed list of calls, never ipcRenderer itself
// (the same shape as T3 Code's apps/desktop/src/preload.ts).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  IPC,
  type AppCommand,
  type ChatLiveEvent,
  type ChatUpdateEvent,
  type CursorFooterEvent,
  type EscScreenEvent,
  type RestartNoteEvent,
  type PaneModeEvent,
  type HerdrDesktopBridge,
  type HostView,
  type LayoutUpdateEvent,
  type ModelCatalogChange,
  type TerminalDataEvent,
  type TerminalExitEvent,
} from "../shared/ipc-contract";
import type { ViewCommand } from "../shared/view-commands";
import type { AwayViewState } from "../shared/away/digest";
import type { SearchViewState } from "../shared/search/view";
import type { PanePrompt } from "../shared/prompt/view";
import type { DraftsChangedEvent } from "../shared/drafts";
import type { UpdateView } from "../shared/updates";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: HerdrDesktopBridge = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  listHosts: () => ipcRenderer.invoke(IPC.hostsList),
  refreshHosts: () => ipcRenderer.invoke(IPC.hostsRefresh),
  onHostsChanged: (listener) => subscribe<HostView[]>(IPC.hostsChanged, listener),
  addHost: (request) => ipcRenderer.invoke(IPC.hostsAdd, request),
  updateHost: (request) => ipcRenderer.invoke(IPC.hostsUpdate, request),
  removeHost: (hostId) => ipcRenderer.invoke(IPC.hostsRemove, hostId),
  hostSettings: (hostId) => ipcRenderer.invoke(IPC.hostsSettings, hostId),
  retryHost: (hostId) => ipcRenderer.invoke(IPC.hostsRetry, hostId),
  trustHostKey: (hostId, questionId, fingerprint) => ipcRenderer.invoke(IPC.hostsTrustKey, hostId, questionId, fingerprint),
  cancelHostKey: (hostId, questionId) => ipcRenderer.invoke(IPC.hostsCancelKey, hostId, questionId),
  pickKeyFile: () => ipcRenderer.invoke(IPC.hostsPickKey),
  openTerminal: (request) => ipcRenderer.invoke(IPC.terminalOpen, request),
  terminalInput: (sessionId, data) => ipcRenderer.send(IPC.terminalInput, sessionId, data),
  terminalResize: (sessionId, cols, rows) => ipcRenderer.send(IPC.terminalResize, sessionId, cols, rows),
  closeTerminal: (sessionId) => ipcRenderer.send(IPC.terminalClose, sessionId),
  terminalParsed: (sessionId, bytes) => ipcRenderer.send(IPC.terminalParsed, sessionId, bytes),
  onTerminalData: (listener) => subscribe<TerminalDataEvent>(IPC.terminalData, listener),
  onTerminalExit: (listener) => subscribe<TerminalExitEvent>(IPC.terminalExit, listener),
  sendToPane: (hostId, paneId, text, binding) => ipcRenderer.invoke(IPC.paneSend, hostId, paneId, text, binding),
  stopAgent: (hostId, paneId, binding) => ipcRenderer.invoke(IPC.paneStop, hostId, paneId, binding),
  stopIfWorking: (hostId, paneId, binding) => ipcRenderer.invoke(IPC.paneStopIfWorking, hostId, paneId, binding),
  afterStop: (hostId, paneId, binding) => ipcRenderer.invoke(IPC.paneAfterStop, hostId, paneId, binding),
  onEscScreen: (listener) => subscribe<EscScreenEvent>(IPC.paneEscScreen, listener),
  paneQueued: (hostId, paneId) => ipcRenderer.invoke(IPC.paneQueued, hostId, paneId),
  takeBackQueued: (hostId, paneId, binding, texts) => ipcRenderer.invoke(IPC.paneTakeBack, hostId, paneId, binding, texts),
  restartAgent: (hostId, paneId, binding) => ipcRenderer.invoke(IPC.paneRestart, hostId, paneId, binding),
  onRestartNote: (listener) => subscribe<RestartNoteEvent>(IPC.paneRestartNote, listener),
  // Integrations: Install or Update, and Settings' fresh read.
  installIntegration: (hostId, target, binding) => ipcRenderer.invoke(IPC.integrationInstall, hostId, target, binding),
  refreshIntegrations: () => ipcRenderer.invoke(IPC.integrationsRefresh),
  listPrompts: () => ipcRenderer.invoke(IPC.promptsList),
  onPromptsChanged: (listener) => subscribe<PanePrompt[]>(IPC.promptsChanged, listener),
  answerPrompt: (request) => ipcRenderer.invoke(IPC.promptAnswer, request),
  openChat: (hostId, paneId, slot, follow) => ipcRenderer.send(IPC.chatOpen, hostId, paneId, slot, follow),
  closeChat: (slot) => ipcRenderer.send(IPC.chatClose, slot),
  loadEarlierChat: (slot) => ipcRenderer.invoke(IPC.chatEarlier, slot),
  setChatFollowing: (following, slot) => ipcRenderer.send(IPC.chatFollow, following, slot),
  onChatUpdate: (listener) => subscribe<ChatUpdateEvent>(IPC.chatUpdate, listener),
  onChatLive: (listener) => subscribe<ChatLiveEvent>(IPC.chatLive, listener),
  onCursorFooter: (listener) => subscribe<CursorFooterEvent>(IPC.cursorFooter, listener),
  cursorPick: (hostId, paneId, pick, binding) => ipcRenderer.invoke(IPC.cursorPick, hostId, paneId, pick, binding),
  openCodePick: (hostId, paneId, model, binding) => ipcRenderer.invoke(IPC.openCodePick, hostId, paneId, model, binding),
  grokPick: (hostId, paneId, pick, files, binding) => ipcRenderer.invoke(IPC.grokPick, hostId, paneId, pick, files, binding),
  onPaneMode: (listener) => subscribe<PaneModeEvent>(IPC.paneMode, listener),
  modePick: (hostId, paneId, agent, target, binding) => ipcRenderer.invoke(IPC.modePick, hostId, paneId, agent, target, binding),
  chatImage: (path) => ipcRenderer.invoke(IPC.chatImage, path),
  chatBlobImage: (blob, hostId, slot) => ipcRenderer.invoke(IPC.chatBlobImage, blob, hostId, slot),
  ghosttyInfo: (hostId, paneId) => ipcRenderer.invoke(IPC.ghosttyInfo, hostId, paneId),
  openInGhostty: (hostId, paneId) => ipcRenderer.invoke(IPC.ghosttyOpen, hostId, paneId),
  copyText: (text) => ipcRenderer.send(IPC.clipboardWrite, text),
  uploadAttachment: (hostId, data, extension, uploadId) =>
    uploadId === undefined
      ? ipcRenderer.invoke(IPC.attachmentUpload, hostId, data, extension)
      : ipcRenderer.invoke(IPC.attachmentUpload, hostId, data, extension, uploadId),
  cancelUpload: (uploadId) => ipcRenderer.send(IPC.attachmentCancel, uploadId),
  discardAttachment: (hostId, path) => ipcRenderer.invoke(IPC.attachmentDiscard, hostId, path),
  clipboardFiles: () => ipcRenderer.invoke(IPC.clipboardFiles),
  startCommands: (hostId) => ipcRenderer.invoke(IPC.startCommands, hostId),
  saveStartCommand: (hostId, kind, command) => ipcRenderer.invoke(IPC.startCommandSave, hostId, kind, command),
  newAgent: (hostId, request) => ipcRenderer.invoke(IPC.newAgent, hostId, request),
  // An agent's model list on a machine, and each change of one.
  modelCatalog: (hostId, agent) => ipcRenderer.invoke(IPC.modelCatalog, hostId, agent),
  onModelCatalog: (listener) => subscribe<ModelCatalogChange>(IPC.modelCatalogChanged, listener),
  modelPick: (hostId, paneId, pick, binding) => ipcRenderer.invoke(IPC.modelPick, hostId, paneId, pick, binding),
  newWorkspace: (hostId, request) => ipcRenderer.invoke(IPC.newWorkspace, hostId, request),
  browseFolder: (hostId, directory) => ipcRenderer.invoke(IPC.folderBrowse, hostId, directory),
  pickFolder: (hostId, typed) => ipcRenderer.invoke(IPC.folderPick, hostId, typed),
  openDrawerShell: (hostId, request) => ipcRenderer.invoke(IPC.drawerShellOpen, hostId, request),
  changesAgent: (hostId, paneId) => ipcRenderer.invoke(IPC.changesAgent, hostId, paneId),
  changesDiff: (hostId, paneId, request) => ipcRenderer.invoke(IPC.changesDiff, hostId, paneId, request),
  changesOverview: (hostId) => ipcRenderer.invoke(IPC.changesOverview, hostId),
  closeChanges: () => ipcRenderer.send(IPC.changesClose),
  watchLayout: (hostId, paneId) => ipcRenderer.send(IPC.layoutWatch, hostId, paneId),
  onLayoutUpdate: (listener) => subscribe<LayoutUpdateEvent>(IPC.layoutUpdate, listener),
  paneAction: (hostId, action) => ipcRenderer.invoke(IPC.paneAction, hostId, action),
  renameWorkspace: (hostId, request) => ipcRenderer.invoke(IPC.renameWorkspace, hostId, request),
  onAppCommand: (listener) => subscribe<AppCommand>(IPC.appCommand, listener),
  onViewCommand: (listener) => subscribe<ViewCommand>(IPC.viewCommand, listener),
  appCommandDone: (id) => ipcRenderer.send(IPC.appCommandDone, id),
  awayState: () => ipcRenderer.invoke(IPC.awayState),
  onAwayUpdate: (listener) => subscribe<AwayViewState>(IPC.awayUpdate, listener),
  awayShown: () => ipcRenderer.send(IPC.awayShown),
  awayMarkSeen: () => ipcRenderer.send(IPC.awayMarkSeen),
  searchConversations: (query) => ipcRenderer.send(IPC.searchRun, query),
  searchExpand: (macId, paneId) => ipcRenderer.send(IPC.searchExpand, macId, paneId),
  searchRetry: (macId) => ipcRenderer.send(IPC.searchRetry, macId),
  searchClose: () => ipcRenderer.send(IPC.searchClose),
  onSearchUpdate: (listener) => subscribe<SearchViewState>(IPC.searchUpdate, listener),
  loadDrafts: () => ipcRenderer.invoke(IPC.draftsLoad),
  saveDraft: (hostId, paneId, draft) => ipcRenderer.send(IPC.draftSave, hostId, paneId, draft),
  onDraftsChanged: (listener) => subscribe<DraftsChangedEvent>(IPC.draftsChanged, listener),
  keptDraft: (id, action) => ipcRenderer.invoke(IPC.draftKept, id, action),
  keepDraft: (hostId, paneId, text, outcome) => ipcRenderer.invoke(IPC.draftKeep, hostId, paneId, text, outcome),
  uploadsCount: (hostId, fresh) => (fresh === true ? ipcRenderer.invoke(IPC.uploadsCount, hostId, true) : ipcRenderer.invoke(IPC.uploadsCount, hostId)),
  deleteUploadsNow: (hostId) => ipcRenderer.invoke(IPC.uploadsDeleteNow, hostId),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  openLicenses: () => ipcRenderer.invoke(IPC.openLicenses),
  // A link in Chat or the Terminal, to the default browser (main checks it is http or https).
  openLink: (url) => ipcRenderer.send(IPC.openLink, url),
  // The app's own updates.
  updateState: () => ipcRenderer.invoke(IPC.updateState),
  onUpdateState: (listener) => subscribe<UpdateView>(IPC.updateChanged, listener),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  setAutomaticUpdates: (on) => ipcRenderer.invoke(IPC.updateAutomatic, on === true),
};

contextBridge.exposeInMainWorld("herdrDesktop", bridge);
