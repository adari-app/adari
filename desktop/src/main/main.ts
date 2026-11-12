// The main process: one window, the app's own protocol, an allowlisted IPC
// surface, and the machines in the sidebar. The structure follows T3 Code's
// apps/desktop (main process, preload, renderer served from its own scheme);
// the code is ours.

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, clipboard, dialog, powerMonitor, safeStorage, session, shell, webContents, type WebContents } from "electron";

import { IPC, type AddHostRequest, type AppInfo, type EditHostRequest, type HostView } from "../shared/ipc-contract";
import { developmentIcon } from "./app-icon";
import { followFocus, registerAwayIpc } from "./away/ipc";
import { AwayService } from "./away/service";
import { FileSinceStore, MemorySinceStore } from "./away/since-store";
import { AppCommands } from "./app-commands";
import { ChangesService } from "./changes/service";
import { registerSearchIpc } from "./search/ipc";
import { SearchService } from "./search/service";
import { followWindowSight } from "./window-sight";
import { ChatService } from "./chat/service";
import { LiveReads } from "./chat/live-reads";
import { PaneReadGate } from "../shared/chat/live-reader";
import { HerdrMachineBackend } from "./herdr/core-host";
import { defaultSessionName } from "./herdr/commands";
import { FilePinStore, PinningHostKeyPolicy } from "./herdr/host-key-pinning";
import { AuthLatch } from "./herdr/ssh";
import { detachedSpawn, findGhostty, GhosttyActions, ghosttyLocal, systemProbe } from "./ghostty";
import { HostStore, SavedHosts, type SavedHost } from "./host-store";
import { HostRegistry, type HostDescriptor } from "./hosts";
import { diskCacheFiles, LaunchCache } from "./launch-cache";
import { registerIpc } from "./ipc";
import { startCommandsOf } from "./start-commands";
import { commandFor } from "../shared/start-commands";
import { FileCatalogStore, LocalCatalogRunner, ModelCatalogs, RemoteCatalogRunner, type CatalogRunner } from "./model-catalogs";
import { readInteractiveEnvironment } from "./herdr/local";
import { LayoutService } from "./layouts";
import { openShippedLicenses } from "./licenses";
import { hasInstrumentFlag, parseLaunchOptions } from "./launch-options";
import { installApplicationMenu } from "./menu";
import { registerAppProtocol, registerSchemePrivileges } from "./protocol";
import { SecretStore, type SecretCipher } from "./secret-store";
import { TerminalSessions } from "./terminals";
import { PaneInputs } from "./pane-inputs";
import { appBundleOf, checkOwnSignature, fileUpdatePrefs, memoryUpdatePrefs, UpdateController, updateSettings } from "./updates";
import { describeManualCheck, type installQuestion } from "../shared/updates";
import { electronClipboardSource, readClipboardFiles } from "./uploads/clipboard-files";
import { countAnswerMs, draftsNameUpload, FileSweepLog, UploadService } from "./uploads/service";
import { buildCommit } from "./build-info";
import { createMainWindow } from "./window";
import { DraftStore, MemoryDraftFiles, fileDrafts } from "./drafts";
import { draftsAnswered, registerDraftsIpc } from "./drafts-ipc";
import type { DraftsChangedEvent } from "../shared/drafts";
import { UpdateMarkService } from "./update-marks";
import { IntegrationService } from "./integrations";
import { StartScreenService } from "./start-screens";
import { PromptService } from "./prompt/prompts";
import { pickFolderOnThisMac } from "./folder-pick";
import { addThisMac, isBuiltInHost, thisMacAvailable, thisMacDescriptor, thisMacId, ThisMacBackend } from "./this-mac";
// The This Mac fixture (captures 99-100): its code comes through dev() like the demo; only its type here.
import type { ThisMacFixture } from "./this-mac-fixture";

/** Set by scripts/build.mjs: true for development builds, false for `npm run dist:mac|win|linux`. */
declare const __ADARI_DEMO__: boolean;
/**
 * Set by scripts/build.mjs: the team ID of the Developer ID Application
 * certificate a release build was made to be signed with (scripts/release-signing.cjs checked it); "" for every other
 * build.
 */
declare const __ADARI_UPDATE_TEAM__: string;

/**
 * This build was made to be signed with a Developer ID, so it may update itself
 * (src/main/updates.ts), once it has checked its own signature against this team (checkOwnSignature).
 */
const updateTeam: string = __ADARI_UPDATE_TEAM__;
const signedBuild = updateTeam !== "";

// The demo, the showcase, the captures and the probes (dev-modes.ts): in development builds only. In a dist
// build this is null and esbuild drops the require with the demo and showcase code and their fixtures.
const devModes: typeof import("./dev-modes") | null = __ADARI_DEMO__ ? (require("./dev-modes") as typeof import("./dev-modes")) : null;

/** The development-only modules; reached only from a branch the demo flags open, which a dist build never parses on. */
function dev(): typeof import("./dev-modes") {
  if (devModes === null) throw new Error("This build has no demo.");
  return devModes;
}

// A build without the demo reads its flags as the shipped app does: the demo flags are off.
const options = parseLaunchOptions(process.argv, { packaged: app.isPackaged || devModes === null });
if (options.userDataDir) app.setPath("userData", options.userDataDir);

registerSchemePrivileges();

// The sidebar's snapshot timer; while a machine's events ride its relay, a 30 s backstop.
const refreshIntervalMs = 5_000;

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

/** A dialog over the main window (or on its own when there is none). */
function messageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const owner = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
  return owner === null ? dialog.showMessageBox(options) : dialog.showMessageBox(owner, options);
}

/**
 * The menu's Check for Updates…: asks the feed now and says what happened in a dialog
 * (a failure too); a newer version offers Download, which downloads only (the pill then shows its ring, then Restart).
 */
async function checkFromMenu(updates: UpdateController): Promise<void> {
  const check = await updates.check("manual");
  const message = describeManualCheck(check);
  if (check.kind !== "available") {
    await messageBox({ message });
    return;
  }
  const answer = await messageBox({
    message,
    detail: "Download it now? Adari asks before it restarts to install it.",
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response === 0) void updates.download();
}

/** Restart's question (T3's install confirmation): Restart, or Cancel to keep the download for later. */
async function confirmInstall(question: ReturnType<typeof installQuestion>): Promise<boolean> {
  const answer = await messageBox({ type: "question", message: question.message, detail: question.detail, buttons: [...question.buttons], defaultId: 0, cancelId: 1 });
  return answer.response === 0;
}

function sshDescriptor(saved: SavedHost): HostDescriptor {
  return {
    id: saved.id,
    name: saved.name,
    kind: "ssh",
    address: `${saved.username}@${saved.host}:${saved.port}`,
    platform: null,
  };
}

/**
 * Electron's safeStorage (on macOS, a key in the login Keychain). The storage
 * backend is asked on Linux only, where "basic_text" means no keyring.
 */
function systemCipher(): SecretCipher {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    ...(process.platform === "linux" ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() } : {}),
  };
}

void app.whenReady().then(() => {
  // No camera, microphone, notifications or anything else the page could ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerAppProtocol(path.join(__dirname, "../renderer"));

  const userData = app.getPath("userData");
  const secretStore = new SecretStore(path.join(userData, "host-secrets.json"), systemCipher());
  // Unfinished writes of an earlier run are old copies: dropped, only by the instance holding the lock.
  const holdsLock = app.hasSingleInstanceLock();
  if (!options.demo && holdsLock) secretStore.discardStaleTemps();
  // Demo mode lists demo machines only; the saved SSH machines are not loaded.
  const book = new SavedHosts(new HostStore(path.join(userData, "hosts.json")), secretStore, undefined, !options.demo, holdsLock);
  const policy = new PinningHostKeyPolicy(new FilePinStore(path.join(userData, "known_hosts.json")));
  const commands = new AppCommands();
  // Updates are on only in a signed, packaged Mac build (never in a development, demo or capture run, which never
  // load electron-updater): the first check 15 s after opening, then every 4 minutes while the setting is on. Its
  // state goes to the page (the sidebar's pill, Settings › Updates) on every change. Also off when opened with a
  // demo, capture or probe flag, which the shipped parser drops (hasInstrumentFlag reads them raw), and off for the
  // run when the app's own signature is not the Developer ID one it was built for.
  const updateRun = updateSettings(process.env, { platform: process.platform, packaged: app.isPackaged, signed: signedBuild, demo: options.demo, flags: hasInstrumentFlag(process.argv) });
  const updateLog = (line: string): void => console.log(`updates: ${line}`);
  if (signedBuild && (process.env["HERDR_COMPANION_UPDATE_FEED"] ?? "") !== "") updateLog("HERDR_COMPANION_UPDATE_FEED is ignored: a signed release checks GitHub only");
  let updates = new UpdateController({
    settings: updateRun,
    version: app.getVersion(),
    prefs: updateRun.enabled ? fileUpdatePrefs(path.join(userData, "update-settings.json"), updateLog) : memoryUpdatePrefs(),
    confirmInstall,
    verifySignature: () => checkOwnSignature(appBundleOf(process.execPath), updateTeam),
    log: updateLog,
  });
  const sendUpdate = (): void => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.updateChanged, updates.view());
  };
  let stopUpdateFeed = updates.subscribe(sendUpdate);
  /** The updater the window talks to (a capture run swaps in its fake one for the update captures, then puts this back). */
  const useUpdates = (next: UpdateController): void => {
    if (next === updates) return;
    stopUpdateFeed();
    updates.stop();
    updates = next;
    stopUpdateFeed = updates.subscribe(sendUpdate);
    // The app's own one back: its timers again (none in a build that does not update itself).
    if (updates === shippedUpdates) updates.start();
    sendUpdate();
  };
  const shippedUpdates = updates;
  updates.start();

  let chat: ChatService | null = null;
  let uploads: UploadService | null = null;
  // The panes whose Claude Code has an update installed (short pane reads, budgeted).
  let updateMarks: UpdateMarkService | null = null;
  /** Herdr's integrations per machine (read on each new connection). */
  let integrations: IntegrationService | null = null;
  /** The panes showing Codex's hook review (short reads, never a key). */
  let startScreens: StartScreenService | null = null;
  let away: AwayService | null = null;
  let searches: SearchService | null = null;
  let layout: LayoutService | null = null;
  // The composer's drafts through a quit or a crash (a demo run's are never kept).
  const drafts = new DraftStore(options.demo ? new MemoryDraftFiles() : fileDrafts(path.join(userData, "drafts.json")), {
    log: (line) => console.warn(`drafts: ${line}`),
  });
  const notifyDrafts = (event: DraftsChangedEvent): void => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.draftsChanged, event);
  };
  // Error texts on their way to the page lose every saved password and passphrase.
  const redact = (text: string): string => book.redact(text);
  // Each saved machine's last topology and open chats, shown at once on launch (a demo keeps none): display text
  // only (launch-cache.ts says what), the saved secrets taken out of it, the secrets read once per cache write, not
  // once per text.
  const launchCache = options.demo ? null : new LaunchCache(diskCacheFiles(path.join(userData, "launch-cache")), Date.now, redact, () => book.redactor());
  const savedMachine = (hostId: string): boolean => book.list().some((host) => host.id === hostId);
  const registry = new HostRegistry(
    (hosts: HostView[]) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.hostsChanged, hosts);
      chat?.refresh();
      uploads?.hostsChanged(hosts);
      away?.hostsChanged();
      searches?.hostsChanged();
      layout?.refresh();
      updateMarks?.hostsChanged();
      integrations?.hostsChanged();
      startScreens?.hostsChanged();
      const moved = draftsAnswered(drafts, hosts);
      if (moved !== null) notifyDrafts(moved);
    },
    Date.now,
    redact,
    {
      snapshot: (hostId, topology) => {
        if (launchCache !== null && savedMachine(hostId)) launchCache.noteTopology(hostId, topology);
      },
    },
  );
  // The panes with a read out, shared by the card's reads and Chat's live reads (never two of a pane at once).
  const paneReads = new PaneReadGate();
  // Each pane's Terminal input, counted for the chips' picks and for the card's answers.
  const paneInputs = new PaneInputs();
  // Each blocked pane's question, read every 2.5 s while its machine answers (prompt/prompts.ts).
  const prompts = new PromptService(
    registry,
    (list) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.promptsChanged, list);
    },
    undefined,
    paneReads,
    paneInputs,
  );
  // The update mark's screen reads take the same per-pane gate (one read of a pane at a time).
  updateMarks = new UpdateMarkService(registry, Date.now, paneReads);
  integrations = new IntegrationService(registry, redact);
  // The hook-review reads take the same per-pane gate.
  const startScreenService = new StartScreenService(registry, undefined, paneReads);
  startScreens = startScreenService;
  // The composer's and the terminal's uploads, and the daily 30-day sweep of them on each machine.
  uploads = new UploadService(registry, new FileSweepLog(path.join(userData, "upload-sweeps.json")));
  const uploadService = uploads;
  const terminals = new TerminalSessions(registry, paneInputs);
  const chats = new ChatService(registry, IPC.chatUpdate);
  chat = chats;
  if (launchCache !== null) {
    chats.useLaunchCache({
      chat: (hostId, paneId) => launchCache.chat(hostId, paneId),
      catchingUp: (hostId) => registry.catchingUp(hostId),
      noteChat: (hostId, paneId, timeline) => {
        if (savedMachine(hostId)) launchCache.noteChat(hostId, paneId, timeline);
      },
    });
  }
  // The shown Chat's Claude pane read about every 400 ms while it works (chat/live-reads.ts).
  const liveReads = new LiveReads(
    registry,
    () => chats.shown(),
    (shown, event) => webContents.fromId(shown.owner.id)?.send(IPC.chatLive, event),
    // A shown Cursor pane's footer (its chips), read on show, at a turn's end and from the live reads.
    // A shown Claude or Grok pane's approval mode (its Permissions chip), read the same way off its screen.
    {
      gate: paneReads,
      footer: (shown, event) => webContents.fromId(shown.owner.id)?.send(IPC.cursorFooter, event),
      mode: (shown, event) => webContents.fromId(shown.owner.id)?.send(IPC.paneMode, event),
    },
  );
  chats.onShownChange(() => liveReads.sync());
  // The shown tab's split panes, kept live (layouts.ts).
  const layouts = new LayoutService(registry, IPC.layoutUpdate);
  layout = layouts;
  const changes = new ChangesService(registry);
  // When the user last looked at each machine: kept in the app's data folder; a demo's looks are not kept.
  const awayService = new AwayService({
    hosts: registry,
    store: options.demo ? new MemorySinceStore() : new FileSinceStore(path.join(userData, "away-since.json")),
    send: (state) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.awayUpdate, state);
    },
  });
  away = awayService;
  registerAwayIpc(awayService);
  const searchService = new SearchService(registry, IPC.searchUpdate);
  searches = searchService;
  registerSearchIpc(searchService);
  registerDraftsIpc(drafts, {
    agentOf: (hostId, paneId) => registry.agent(hostId, paneId)?.agent ?? registry.pane(hostId, paneId)?.agent ?? null,
    notify: notifyDrafts,
    hostLabel: (hostId) => registry.name(hostId),
  });

  // Each machine's sign-in latch: a new one with each backend, reset by Try again.
  const latches = new Map<string, AuthLatch>();
  // A saved machine runs the Herdr TUI, herdr-core, or both, found as the iPhone app finds them (the TUI
  // first; `hc connect` on its own SSH client after): one sidebar entry (core-host.ts).
  const backendFor = (host: SavedHost): HerdrMachineBackend => {
    const latch = new AuthLatch();
    latches.set(host.id, latch);
    return new HerdrMachineBackend(book.connectConfig(host, latch), policy);
  };
  // This Mac, built in and first, reached with no SSH (macOS). Never in a demo or capture
  // run: those show their fixtures only (a capture places its own fake-herdr This Mac, below).
  if (!options.demo && thisMacAvailable(process.platform)) addThisMac(registry);
  for (const host of book.list()) registry.add(sshDescriptor(host), backendFor(host), launchCache?.load(host.id)?.topology ?? null);
  if (options.showcase) {
    // The showcase: the invented setup only; no recorded fixture is shown.
    const { DemoBackend, showcaseHosts } = dev();
    for (const host of showcaseHosts(Date.now())) registry.add(host.descriptor, new DemoBackend(host, null));
  } else if (options.demo) {
    const { DemoBackend, bundledDemoFixtures, demoHosts } = dev();
    for (const host of demoHosts(bundledDemoFixtures, Date.now())) {
      registry.add(host.descriptor, new DemoBackend(host, bundledDemoFixtures));
    }
  }

  // Open in Ghostty: the saved SSH host's address; a demo machine has none, and
  // demo and capture runs never start anything. This Mac opens its Herdr with no ssh: the
  // herdr and login environment its in-app pane uses.
  const ghostty = new GhosttyActions(
    () => findGhostty(process.platform, systemProbe()),
    (hostId, paneId) => {
      const host = registry.list().find((candidate) => candidate.id === hostId);
      const pane = registry.pane(hostId, paneId);
      if (host === undefined || pane === null) return null;
      const address = book.list().find((candidate) => candidate.id === hostId) ?? null;
      const backend = registry.backend(hostId);
      return {
        pane: { hostKind: host.kind, paneID: pane.paneID, terminalID: pane.terminalID, ...(pane.agent === undefined ? {} : { agent: pane.agent }) },
        address:
          address === null
            ? null
            : { host: address.host, port: address.port, username: address.username, herdrSession: address.herdrSession },
        ...(host.kind === "local" && backend instanceof ThisMacBackend
          ? { local: ghosttyLocal(backend.loginEnvironment(), defaultSessionName, systemProbe()) }
          : {}),
      };
    },
    options.demo || options.captureDir !== null
      ? () => {
          throw new Error("this run starts nothing");
        }
      : detachedSpawn,
  );

  const info: AppInfo = {
    version: app.getVersion(),
    platform: process.platform,
    // The showcase reads as a real day of work: no Demo chip.
    demo: options.demo && !options.showcase,
    capture: options.captureDir !== null || options.showcaseCaptureDir !== null,
    updates: { enabled: updateRun.enabled, feedUrl: updateRun.feedUrl },
    passwordStorage: book.passwordsAvailable(),
    // Settings' version line.
    commit: buildCommit,
  };

  // The model-lists capture (202): the demo machine standing in for This Mac while that capture runs (null otherwise).
  let listsCaptureThisMac: string | null = null;
  // Each machine's model lists, read from the agents themselves on first need (This Mac directly, another Mac over
  // its read-only command path, the demo from its fixtures), kept in memory and on disk.
  // This Mac's lists run in the environment its panes have (the interactive login shell's, read
  // once on the first list; the login environment when that read fails).
  let listEnvironment: Promise<NodeJS.ProcessEnv | null> | null = null;
  const paneEnvironment = async (backend: ThisMacBackend): Promise<NodeJS.ProcessEnv> => {
    listEnvironment ??= readInteractiveEnvironment();
    return (await listEnvironment) ?? backend.loginEnvironment();
  };
  const modelCatalogs = new ModelCatalogs({
    machine: (hostId, agent) => {
      const host = registry.list().find((candidate) => candidate.id === hostId);
      const backend = registry.backend(hostId);
      if (host === undefined || backend === null || host.state !== "connected") return null;
      let runner: CatalogRunner | null = null;
      if (backend instanceof ThisMacBackend) runner = new LocalCatalogRunner(() => paneEnvironment(backend), os.homedir());
      else {
        const remote = backend.commands?.() ?? null;
        if (remote !== null) runner = new RemoteCatalogRunner(remote, host.name);
      }
      if (runner === null) return null;
      return { runner, startCommand: async () => commandFor(await startCommandsOf(backend), agent) };
    },
    store: options.demo ? null : new FileCatalogStore(path.join(userData, "model-catalogs.json")),
    now: Date.now,
    // This Mac's lists stand in for another Mac's Cursor or Claude Code list that needs its keychain
    // (the demo has no This Mac: capture 202 names a demo machine for it while it runs).
    thisMac: () => (options.demo ? listsCaptureThisMac : registry.has(thisMacId) ? thisMacId : null),
    machineName: (hostId) => registry.list().find((candidate) => candidate.id === hostId)?.name ?? null,
    changed: (hostId, view) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.modelCatalogChanged, { hostId, view });
    },
  });

  registerIpc({
    info,
    prompts,
    modelCatalogs,
    integrations,
    startScreens: startScreenService,
    // A Cursor pick reads its pane through the shared gate; its last screen's footer goes to the shown Chats.
    cursorReads: {
      gate: paneReads,
      noteScreen: (hostId, paneId, screen) => liveReads.noteScreen(hostId, paneId, screen),
      notePick: (hostId, paneId, screen) => liveReads.notePick(hostId, paneId, screen),
      lookAgain: (hostId, paneId) => liveReads.lookAgain(hostId, paneId),
    },
    paneInputs,
    hosts: registry,
    terminals,
    chat: chats,
    changes,
    layouts,
    ghostty,
    // A capture run never touches this Mac's clipboard (its terminal step copies a selection).
    // The showcase shots (--showcase-capture) are a capture run too.
    copyText: (text) => {
      if (options.captureDir === null && options.showcaseCaptureDir === null) clipboard.writeText(text);
    },
    uploadAttachment: (hostId, data, extension, uploadId) => uploadService.upload(hostId, data, extension, uploadId),
    cancelUpload: (uploadId) => uploadService.cancel(uploadId),
    discardAttachment: (hostId, path) => uploadService.discard(hostId, path),
    clipboardFiles: () => readClipboardFiles(electronClipboardSource(clipboard)),
    addHost(request: AddHostRequest) {
      if (options.demo) throw new Error("Demo mode shows its demo machines only.");
      const host = book.add(request);
      registry.add(sshDescriptor(host), backendFor(host));
      return registry.list();
    },
    updateHost(request: EditHostRequest) {
      if (options.demo) throw new Error("Demo mode shows its demo machines only.");
      const host = book.update(request);
      registry.replace(sshDescriptor(host), backendFor(host));
      return registry.list();
    },
    removeHost(hostId: string) {
      // This Mac is built in: never removed, and nothing of it is saved to take away.
      if (isBuiltInHost(hostId)) return registry.list();
      // The machine and its saved password go together.
      if (!options.demo) book.remove(hostId);
      latches.delete(hostId);
      // Its launch cache goes with it.
      launchCache?.forget(hostId);
      // Its drafts and kept drafts go with it.
      drafts.forgetHost(hostId);
      notifyDrafts({ state: drafts.state(), gone: [] });
      registry.remove(hostId);
      return registry.list();
    },
    async retryHost(hostId: string) {
      latches.get(hostId)?.reset();
      await registry.retry(hostId);
      return registry.list();
    },
    // The answer to a machine's new host key. Trust pins only the key asked about
    // (the registry checks the question's id and the fingerprint shown), through the pin file's one
    // compare-and-pin; an answer to a question no longer open does nothing.
    async trustHostKey(hostId: string, questionId: string, fingerprint: string) {
      await registry.trustHostKey(hostId, questionId, fingerprint, (key) => policy.trustNewKey(key.host, key.port, key.fingerprint));
      return registry.list();
    },
    async cancelHostKey(hostId: string, questionId: string) {
      registry.cancelHostKey(hostId, questionId);
      return registry.list();
    },
    hostSettings: (hostId: string) => (options.demo ? null : book.settings(hostId)),
    async pickKeyFile(owner: WebContents) {
      const window = BrowserWindow.fromWebContents(owner);
      const pick: Electron.OpenDialogOptions = {
        title: "Choose the private key file",
        buttonLabel: "Choose",
        defaultPath: app.getPath("home"),
        properties: ["openFile", "showHiddenFiles"],
      };
      const result = window === null ? await dialog.showOpenDialog(pick) : await dialog.showOpenDialog(window, pick);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    // This Mac's Choose… (ipc.ts lets only This Mac ask), the macOS folder window over the asking window.
    async pickFolder(owner: WebContents, typed: string) {
      const window = BrowserWindow.fromWebContents(owner);
      return pickFolderOnThisMac((pick) => (window === null ? dialog.showOpenDialog(pick) : dialog.showOpenDialog(window, pick)), typed, app.getPath("home"));
    },
    commandDone: (id) => commands.answered(id),
    redact,
    // Settings' uploads (by the machine's id; uploads/service.ts decides what is counted and removed:
    // Delete now keeps what a draft or a kept draft names) and its Check for Updates…, the menu's own handler.
    uploadsCount: (hostId, fresh) => uploadService.count(hostId, countAnswerMs, fresh),
    deleteUploadsNow: (hostId) => uploadService.deleteNow(hostId, (path) => draftsNameUpload(drafts.state(), path)),
    // Settings' check says its outcome in the page; Download and Restart are the user's clicks.
    checkForUpdates: async () => describeManualCheck(await updates.check("manual")),
    // About's Open-source licenses: the THIRD_PARTY_NOTICES.md this build ships, in the Mac's viewer.
    openLicenses: () => openShippedLicenses({ appPath: app.getAppPath(), userData: app.getPath("userData"), open: (file) => shell.openPath(file) }),
    // A link in Chat or the Terminal (ipc.ts checked it is http or https), in the default browser; a
    // capture run never opens one (it only says which).
    openLink: (url) => {
      if (options.captureDir === null && options.showcaseCaptureDir === null) void shell.openExternal(url);
      else console.log(`open-link (capture run, not opened): ${url}`);
    },
    updates: {
      view: () => updates.view(),
      download: () => updates.download(),
      requestInstall: () => updates.requestInstall(),
      setAutomatic: (on) => updates.setAutomatic(on),
    },
  });

  installApplicationMenu({
    updatesEnabled: updateRun.enabled,
    checkForUpdates: () => void checkFromMenu(updates),
    viewCommand: (command) => {
      const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (target !== null && !target.isDestroyed()) target.webContents.send(IPC.viewCommand, command);
    },
    // Settings… toggles Settings in the focused window's page, as ⌘, does there.
    openSettings: () => {
      const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (target !== null && !target.isDestroyed()) void commands.send(target.webContents, { type: "settings", open: "toggle" }).catch(() => undefined);
    },
  });
  // Our icon under `electron .` (a packaged app has its own from the .icns).
  const icon = developmentIcon(app.getAppPath(), app.isPackaged, process.platform);
  if (icon.dock !== null) app.dock?.setIcon(icon.dock);
  const showcaseCapture = options.showcaseCaptureDir;
  const window = createMainWindow({
    // The showcase shots: 1600 x 900 points drawn at 2x on any display (a 3200 x 1800 window at zoom 2, showcase-capture.ts).
    ...(showcaseCapture !== null
      ? { width: dev().showcaseWindow.width * dev().showcaseWindow.scale, height: dev().showcaseWindow.height * dev().showcaseWindow.scale, largerThanScreen: true }
      : options.windowSize),
    showInactive:
      options.captureDir !== null || options.lookProbeDir !== null || options.flickerProbeDir !== null || options.probeFile !== null || showcaseCapture !== null,
    ...(icon.window === null ? {} : { icon: icon.window }),
  });
  mainWindow = window;
  // A capture run's window never has focus: its visit starts with the captures.
  if (options.captureDir === null && showcaseCapture === null) followFocus(window, awayService);
  const contents = window.webContents;
  contents.on("render-process-gone", () => {
    terminals.closeAll(contents);
    chats.close(contents);
    changes.close(contents);
    searchService.close(contents);
    layouts.close(contents);
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      terminals.closeAll(contents);
      chats.close(contents);
      changes.close(contents);
      searchService.close(contents);
      layouts.close(contents);
    }
  });
  const contentsId = contents.id;
  contents.once("destroyed", () => {
    chats.close({ id: contentsId });
    changes.close({ id: contentsId });
    searchService.close({ id: contentsId });
    layouts.close({ id: contentsId });
  });
  // Minimized or hidden, the window shows no tile: its Chat feeds pause until it is back.
  const stopSight = followWindowSight(window, (paused) => {
    chats.setPaused({ id: contentsId }, paused);
    // The relays are pinged every 5 s only while the window is on screen.
    registry.liveness(paused ? "hidden" : "visible");
  });
  // Focus or wake: a 2 s ping on each relay; no pong reconnects at once.
  window.on("focus", () => registry.liveness("wake"));
  powerMonitor.on("resume", () => registry.liveness("wake"));
  window.on("closed", () => {
    stopSight();
    mainWindow = null;
  });

  registry.start(refreshIntervalMs);
  prompts.start();
  startScreenService.start();
  launchCache?.start();
  app.on("before-quit", () => {
    // No more automatic checks.
    updates.stop();
    // The launch cache: what changed since the last 10 s write, written now.
    launchCache?.stop();
    launchCache?.flush(true);
    prompts.stop();
    startScreenService.stop();
    liveReads.closeAll();
    // The drafts not written yet are written now.
    drafts.flush();
    terminals.closeAll();
    chats.closeAll();
    changes.closeAll();
    awayService.close();
    searchService.closeAll();
    layouts.closeAll();
    registry.close();
  });

  const probeFile = options.probeFile;
  if (probeFile !== null) {
    const { demoHostIds, demoProbeScenarios, runFramesProbe } = dev();
    void (async () => {
      await registry.refreshAll();
      const scenarios = demoProbeScenarios(demoHostIds);
      const results = await runFramesProbe(window, commands, path.resolve(probeFile), scenarios);
      for (const result of results) console.log(`probe ${result.name}: ${JSON.stringify(result.stats)}`);
    })().then(
      () => app.quit(),
      (error: unknown) => {
        console.error(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      },
    );
  }

  if (showcaseCapture !== null) {
    const { findFfmpeg, runShowcaseCapture, showcaseHostIds } = dev();
    void (async () => {
      await registry.refreshAll();
      awayService.focus();
      const results = await runShowcaseCapture({
        window,
        commands,
        directory: path.resolve(showcaseCapture),
        refresh: () => registry.refreshAll(),
        ffmpeg: findFfmpeg(),
        log: (line) => console.log(line),
      });
      console.log(`showcase: ${results.length} shots in ${path.resolve(showcaseCapture)} (${Object.values(showcaseHostIds).join(", ")})`);
    })().then(
      () => app.quit(),
      (error: unknown) => {
        console.error(`showcase capture failed: ${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      },
    );
  }

  const flickerProbeDir = options.flickerProbeDir;
  if (flickerProbeDir !== null && !app.isPackaged) {
    const { demoHostIds, runFlickerProbe } = dev();
    void (async () => {
      await registry.refreshAll();
      const dir = path.resolve(flickerProbeDir);
      console.log(`flicker probe: ${await runFlickerProbe(window, commands, dir, demoHostIds, process.env["HERDR_FLICKER_LABEL"] ?? "run")}`);
    })().then(
      () => app.quit(),
      (error: unknown) => {
        console.error(`flicker probe failed: ${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      },
    );
  }

  const captureDir = options.captureDir;
  const lookProbeDir = options.lookProbeDir;
  // The capture's fake-herdr This Mac (99-100), closed with the app.
  let thisMacFixture: ThisMacFixture | null = null;
  /** --capture-only's captures (each name starting with one of its prefixes), else all of them. */
  const chosenCaptures = <T extends { readonly name: string }>(steps: T[]): T[] =>
    options.captureOnly === null ? steps : steps.filter((step) => options.captureOnly!.some((prefix) => step.name.startsWith(prefix)));
  /** The window's size before 113 made it the minimum (put back after its picture). */
  let settingsCaptureSize: [number, number] | null = null;
  /** Puts back the screens and status of the pane 131-133 last blocked. */
  let tallCardRestore: (() => void) | null = null;
  /** Puts back the folder and session of the pane 156-157 changed. */
  let codexSessionRestore: (() => void) | null = null;
  /** Puts back the session and integration states 158-162 changed. */
  let integrationsRestore: (() => void)[] = [];
  // Captures 169-172 (first Chat): what each step changed, and the panes there when they began.
  const firstChatRestore: (() => void)[] = [];
  let firstChatPanes: Set<string> | null = null;
  let linksCaptureSize: [number, number] | null = null;
  let linksShellScreen: readonly string[] | null = null;
  /** The status 173-174's pane had before them (put back after 174). */
  let compactStatusHad: string | null = null;
  /** The status 175-176's pane had before them (put back after 176). */
  let takeBackStatusHad: string | null = null;
  // Captures 177-180 (start questions): the panes there before a step's New agent (the ones it made close after).
  let startQuestionPanes: Set<string> | null = null;
  /** The model pickers: the Mac mini's panes before 183 (186's New agent pane closed after 187). */
  let pickersPanes: Set<string> | null = null;
  /** Live picks: the Mac mini's panes before 212 (213's New agent pane closed after 214). */
  let livepickPanes: Set<string> | null = null;
  /** Puts the Grok pane's question and status back after 222. */
  let livefixRestore: (() => void) | null = null;
  const livefixGrokPane = "wD:pK";
  // Capture 194 (Chat support): what puts the demo's integrations back.
  const chatSupportRestore: (() => void)[] = [];
  // The model lists: what captures 202-203 changed in the demo, put back after each.
  const listsRestore: (() => void)[] = [];
  app.on("before-quit", () => void thisMacFixture?.close());
  if (captureDir !== null || lookProbeDir !== null) {
    const {
      DemoBackend,
      agentsCaptureSteps,
      chipsEffortCaptureSteps,
      codexAskCaptureSteps,
      codexLiveCaptureSteps,
      cursorCaptureSteps,
      cursorChipsCaptureSteps,
      cursorLiveCaptureSteps,
      demoCaptureSteps,
      demoHostIds,
      grokCaptureSteps,
      grokCardCaptureSteps,
      grokChipsCaptureSteps,
      hostKeyCaptureSteps,
      liveRowCaptureSteps,
      manageCaptureSteps,
      modesCaptureSteps,
      needsCardCaptureSteps,
      newKeyBackend,
      newKeyHost,
      ringCaptureSteps,
      runCaptures,
      runLookProbe,
      runningCaptureSteps,
      sendCaptureSteps,
      sidebarCaptureSteps,
      sidebarFoldedCaptureSteps,
      sidebarWidthCaptureSteps,
      settingsCaptureSteps,
      tallCardCaptureSteps,
      terminalDrawerCaptureSteps,
      thisMacCaptureSteps,
      openThisMacFixture,
      updateMarkCaptureSteps,
      updateCaptureSteps,
      folderPickCaptureSteps,
      startFixCaptureSteps,
      codexSessionCaptureSteps,
      integrationsCaptureSteps,
      linksChipsCaptureSteps,
      firstChatCaptureSteps,
      compactCapturePane,
      compactCaptureSteps,
      DemoClaudeQueue,
      takeBackCapturePane,
      takeBackCaptureSteps,
      startQuestionCaptureSteps,
      pickersCaptureSteps,
      pickersCodexPane,
      chatSupportCaptureSteps,
      chatSupportCaptureTargets,
      cursorPickCaptureSteps,
      listsCaptureSteps,
      listsCodexPane,
      listsCodexUpdateScreen,
      livepickCaptureSteps,
      livefixCaptureSteps,
      twotierCaptureSteps,
    } = dev();
    void (async () => {
      await registry.refreshAll();
      awayService.focus();
      if (captureDir !== null) {
        // Capture order: send 41-44, sidebar 84-85, needs-card (45-50), grok 51, update-ready 52, live-row 53-54, codex-live 55-56,
        // cursor 57, manage 58-61, chips-effort 62, running 63-65, cursor-live 66-67, cursor-chips 68-70, grok-chips 71-73,
        // grok card (80-83), This Mac 99-100, the sidebar's width 101-105, sidebar 86-87, codex-ask 88-90, modes 91-96, host key 97-98,
        // Settings 106-114, the terminal drawer 115-120, the agents 121-125, the context ring 126-130, the tall approvals 131-133,
        // the app's own updates 134-140, folder-pick 141-148, start-fix 149-154, codex-session 155-157, integrations 158-162,
        // links-chips 163-168, Compact held and compacted 173-174, a queued message taken back 175-176, the model pickers 181-187,
        // chat-support 190-196, twotier 230-233 (last).
        const results = await runCaptures(window, commands, path.resolve(captureDir), chosenCaptures([
          ...demoCaptureSteps(demoHostIds),
          ...sendCaptureSteps(demoHostIds),
          // The list without the two cards 84 and the needs-you pills 85, before 45-50 answer the demo's dialogs.
          ...sidebarCaptureSteps(demoHostIds),
          ...needsCardCaptureSteps(demoHostIds),
          ...grokCaptureSteps(demoHostIds),
          ...updateMarkCaptureSteps(demoHostIds),
          ...liveRowCaptureSteps(demoHostIds),
          ...codexLiveCaptureSteps(demoHostIds),
          ...cursorCaptureSteps(demoHostIds),
          ...manageCaptureSteps(demoHostIds),
          ...chipsEffortCaptureSteps(demoHostIds),
          // The Running strip 63, its panel 64, the rows after they end 65.
          ...runningCaptureSteps(demoHostIds),
          ...cursorLiveCaptureSteps(demoHostIds),
          ...cursorChipsCaptureSteps(demoHostIds),
          ...grokChipsCaptureSteps(demoHostIds),
          // Grok's approval as the card (80), its frame in Terminal 81, a pick 82, the Working line 83.
          ...grokCardCaptureSteps(demoHostIds),
          // This Mac on the capture's fake-herdr fixture (a new short folder under TMPDIR each time),
          // never this Mac's own Herdr: found (99), then not running (100), then taken out of the list again
          // so 86-98 draw as before.
          ...thisMacCaptureSteps(async (state) => {
            await thisMacFixture?.close();
            thisMacFixture = null;
            if (state === "gone") {
              registry.remove(thisMacId);
              return;
            }
            thisMacFixture = await openThisMacFixture(mkdtempSync(path.join(os.tmpdir(), "hc-tm-")), state);
            const backend = new ThisMacBackend(thisMacFixture.options);
            if (registry.has(thisMacId)) registry.replace(thisMacDescriptor(), backend);
            else registry.add(thisMacDescriptor(), backend);
            await registry.refresh(thisMacId);
          }),
          // The long names at 288 px 101, the edge dragged to 440 px 102, its minimum 103, the main
          // pane's minimum 104, a double-click back to 288 px 105 (nothing kept, so 86-98 draw as before).
          ...sidebarWidthCaptureSteps(demoHostIds),
          // A folded project that keeps its agent that needs you 86, folded machines that keep theirs 87.
          ...sidebarFoldedCaptureSteps(demoHostIds),
          // Codex's tool-call question as the card (88), its form in Terminal 89, a pick 90.
          ...codexAskCaptureSteps(demoHostIds),
          // The Permissions chip on Claude 91, Grok 92, Cursor 93, Codex 94, Codex's menu 95, Approve for me picked 96.
          ...modesCaptureSteps(demoHostIds),
          // A machine seen for the first time asks (97); Cancel leaves it for Try again (98).
          ...hostKeyCaptureSteps(newKeyHost.id, async () => {
            registry.add(newKeyHost, newKeyBackend());
            await registry.refresh(newKeyHost.id);
          }),
          // The footer's Settings button 106, each section over the split tab 107-112, the window's minimum size 113
          // (its size put back after), closed again 114. Chat's start command being typed 108b and saved 108c (a script
          // in the window types it, and puts Mac mini's command back after).
          ...settingsCaptureSteps(demoHostIds, async (size) => {
            if (size !== null) {
              settingsCaptureSize ??= window.getSize() as [number, number];
              window.setSize(size.width, size.height);
            } else if (settingsCaptureSize !== null) {
              window.setSize(settingsCaptureSize[0], settingsCaptureSize[1]);
              settingsCaptureSize = null;
            }
            await new Promise((done) => setTimeout(done, 300));
          }, (script) => window.webContents.executeJavaScript(script, true)),
          // The drawer closed 115, two shells 116, the Claude Code tab 117, Codex's
          // switch 118, a shell without one 119, the drawer in a split 120 (after Settings, so 106-114 draw as before).
          ...terminalDrawerCaptureSteps(demoHostIds),
          // A dozen kinds on build-box, New agent's list, an Amp pane's own screen and Chat line, numbered 121-125
          // (after the drawer's 115-120, so every earlier capture draws as before).
          ...agentsCaptureSteps(demoHostIds),
          // /compact typed 126 and sent 127 (the ring at rest), the card's Compact: the ring turning 128-130
          // (after the agents' 121-125).
          ...ringCaptureSteps(demoHostIds),
          // Claude Code's approval taller than the card's 40-line read, a 60-line command 131 and an edit with a long
          // diff 132 on beacon's screen; 133, a frame whose header is above even the taller read, on sundial with the
          // same call running in Chat. Each pane's screens and status put back after.
          ...tallCardCaptureSteps(demoHostIds, async (hostId, paneId, screens, running) => {
            tallCardRestore?.();
            tallCardRestore = null;
            const backend = registry.backend(hostId);
            if (screens !== null && backend instanceof DemoBackend) tallCardRestore = backend.showPrompt(paneId, screens, running ?? null);
            await registry.refresh(hostId);
          }),
          // Settings › Updates in this capture run (off) 134, then a fake updater (no network)
          // in the app's place: the pill's Download 135, its ring 136, the toast and Restart 137-138, Settings › Updates
          // with the download ready 139, Restarting… 140; the app's own (off) updater put back after.
          ...updateCaptureSteps(demoHostIds, { version: app.getVersion(), use: (controller) => useUpdates(controller ?? shippedUpdates) }),
          // New workspace's machine picker and recent rows 141, the folder list 142-145 (Tab, a missing
          // folder, build-box's Linux home), New agent's Starts in 146 and its list 147, This Mac's Choose… 148 (This Mac
          // on the fake-herdr fixture as 99 has it, its home a small invented tree; taken out again after).
          ...folderPickCaptureSteps(
            demoHostIds,
            (script) => window.webContents.executeJavaScript(script, true),
            async (state) => {
              await thisMacFixture?.close();
              thisMacFixture = null;
              if (state === "gone") {
                if (registry.has(thisMacId)) registry.remove(thisMacId);
                return null;
              }
              thisMacFixture = await openThisMacFixture(mkdtempSync(path.join(os.tmpdir(), "hc-tm-")), state);
              const backend = new ThisMacBackend(thisMacFixture.options);
              if (registry.has(thisMacId)) registry.replace(thisMacDescriptor(), backend);
              else registry.add(thisMacDescriptor(), backend);
              await registry.refresh(thisMacId);
              return thisMacFixture.options.home ?? null;
            },
          ),
          // New agent after a busy shell 149, one that never reached its prompt 150,
          // an agent at its sign-in screen 151, a program not installed 152, New workspace from ~/… 153 and from a folder
          // the machine lacks 154; the Mac mini's demo Herdr given each step's start quirks, put back after (last).
          ...startFixCaptureSteps(
            demoHostIds,
            (script) => window.webContents.executeJavaScript(script, true),
            async (hostId, quirks, fallBackHome = false) => {
              const backend = registry.backend(hostId);
              if (backend instanceof DemoBackend) backend.setStartQuirks(quirks, fallBackHome);
            },
          ),
          // Settings › Chat's Codex row and its note 155; the Atelier Codex pane's Chat
          // while its named session's header is another folder's 156, and with no session named 157; put back after each (last).
          ...codexSessionCaptureSteps(demoHostIds, async (hostId, paneId, what) => {
            codexSessionRestore?.();
            codexSessionRestore = null;
            const backend = registry.backend(hostId);
            if (what !== null && backend instanceof DemoBackend) codexSessionRestore = backend.setPaneSession(paneId, what);
            await registry.refresh(hostId);
          }),
          // The Atelier Codex pane's Chat with Codex's integration not installed 158, after
          // Install 159, out of date 160; Settings › Machines' line 161; a no-session send 162; put back after each (last).
          ...integrationsCaptureSteps(demoHostIds, async (hostId, paneId, what) => {
            for (const restore of integrationsRestore.splice(0).reverse()) restore();
            const backend = registry.backend(hostId);
            if (what !== null && backend instanceof DemoBackend) {
              if (what.noSession) integrationsRestore.push(backend.setPaneSession(paneId, { session: null }));
              for (const [target, state] of Object.entries(what.states)) integrationsRestore.push(backend.setIntegration(target, state));
            }
            await registry.refresh(hostId);
            integrations?.forgetForCapture(hostId);
          }),
          // A chat reply's link under the mouse 163, a terminal URL with Cmd held 164, the Model chip
          // reading Fable 5.2 from Claude Code's new /model line 165-166 (1440x900, the minimum), the old parse's long
          // label as a test string 167-168 (the minimum, 1440x900), Send inside the box; the window's size put back after.
          ...linksChipsCaptureSteps(
            demoHostIds,
            async (size) => {
              if (size !== null) {
                linksCaptureSize ??= window.getSize() as [number, number];
                window.setSize(size.width, size.height);
              } else if (linksCaptureSize !== null) {
                window.setSize(linksCaptureSize[0], linksCaptureSize[1]);
                linksCaptureSize = null;
              }
              await new Promise((done) => setTimeout(done, 400));
            },
            async (hostId, paneId, stdout) => {
              const backend = registry.backend(hostId);
              const written = backend instanceof DemoBackend && backend.printCommandOutput(paneId, stdout);
              await registry.refresh(hostId);
              return written;
            },
            async (hostId, paneId, screen) => {
              const backend = registry.backend(hostId);
              if (!(backend instanceof DemoBackend)) return;
              if (screen !== null) linksShellScreen ??= backend.transport.show(paneId, [screen]);
              else if (linksShellScreen !== null) {
                backend.transport.show(paneId, linksShellScreen);
                linksShellScreen = null;
              }
            },
          ),
          // The old Atelier Codex pane's steps after Install 169, New agent's Codex after it
          // 170, a new Codex on its hook review as needing you 171, a no-session send then the session named: one message 172.
          ...firstChatCaptureSteps(demoHostIds, async (hostId, paneId, what) => {
            for (const restore of firstChatRestore.splice(0).reverse()) restore();
            const backend = registry.backend(hostId);
            if (!(backend instanceof DemoBackend)) return;
            if (what === null) {
              // The panes a step's New agent made go again (only those: the ones not there when it began).
              const made = (registry.list().find((host) => host.id === hostId)?.topology?.panes ?? []).filter((pane) => firstChatPanes !== null && !firstChatPanes.has(pane.paneID));
              for (const pane of made) await backend.paneActions().closePane(pane.paneID);
              firstChatPanes = null;
            } else {
              firstChatPanes ??= new Set((registry.list().find((host) => host.id === hostId)?.topology?.panes ?? []).map((pane) => pane.paneID));
              const session = what.noSession ? backend.setPaneSession(paneId, { session: null }) : null;
              let adopted = false;
              const adopt = (): void => {
                if (adopted || session === null) return;
                adopted = true;
                session();
              };
              if (session !== null) firstChatRestore.push(adopt);
              for (const [target, state] of Object.entries(what.states)) firstChatRestore.push(backend.setIntegration(target, state));
              if (what.quirks !== undefined) {
                backend.setStartQuirks(what.quirks);
                firstChatRestore.push(() => backend.setStartQuirks(null));
              }
              if (what.adoptAfterMs !== undefined) {
                setTimeout(() => {
                  adopt();
                  void registry.refresh(hostId);
                }, what.adoptAfterMs);
              }
            }
            await registry.refresh(hostId);
            integrations?.forgetForCapture(hostId);
          }),
          // The marigold pane working with its Running strip, /compact held 173; the
          // turn ends (done, the strip still running), Compact goes and the compaction lands 174; its status put back.
          ...compactCaptureSteps(demoHostIds, async (step) => {
            const backend = registry.backend(demoHostIds.macMini);
            if (!(backend instanceof DemoBackend)) return;
            if (step === "restore") {
              if (compactStatusHad !== null) backend.setPaneStatus(compactCapturePane, compactStatusHad);
              compactStatusHad = null;
            } else {
              const had = backend.setPaneStatus(compactCapturePane, step);
              compactStatusHad ??= had;
              // The compaction lands a moment after the held Compact went at done.
              if (step === "done") setTimeout(() => void backend.compacted(compactCapturePane), 1_500);
            }
            await registry.refresh(demoHostIds.macMini);
          }),
          // The marigold pane working with Claude Code's queue on its screen; a
          // message sent waits there (175), Esc takes it back into the box (176); its status and screen put back.
          ...takeBackCaptureSteps(demoHostIds, async (step) => {
            const backend = registry.backend(demoHostIds.macMini);
            if (!(backend instanceof DemoBackend)) return;
            if (step === "restore") {
              backend.transport.setQueue(takeBackCapturePane, null);
              if (takeBackStatusHad !== null) backend.setPaneStatus(takeBackCapturePane, takeBackStatusHad);
              takeBackStatusHad = null;
            } else {
              takeBackStatusHad ??= backend.setPaneStatus(takeBackCapturePane, "working");
              backend.transport.setQueue(takeBackCapturePane, new DemoClaudeQueue("marigold", ["\u{23FA} Bash(npm test -- export)", "  \u{23BF}  Running\u{2026}"]));
            }
            await registry.refresh(demoHostIds.macMini);
          }),
          // New agent's Grok Build 177, Cursor Agent 178 and Gemini CLI 179-180,
          // each on its own start question while Herdr says idle with no session: Needs you and Chat's line; the panes
          // they made close and the start quirks go back after each.
          ...startQuestionCaptureSteps(demoHostIds, async (hostId, what) => {
            const backend = registry.backend(hostId);
            if (!(backend instanceof DemoBackend)) return;
            const panes = () => registry.list().find((host) => host.id === hostId)?.topology?.panes ?? [];
            if (what === null) {
              for (const pane of panes().filter((each) => startQuestionPanes !== null && !startQuestionPanes.has(each.paneID))) {
                await backend.paneActions().closePane(pane.paneID);
              }
              startQuestionPanes = null;
              backend.setStartQuirks(null);
            } else {
              startQuestionPanes = new Set(panes().map((pane) => pane.paneID));
              backend.setStartQuirks({ noSession: [what.kind], startScreen: { [what.kind]: what.screen } });
            }
            await registry.refresh(hostId);
          }),
          // The Model chip's picker on Codex 181 and Cursor with a search 182, New agent's
          // OpenCode picker 183, Codex's Effort for gpt-6.1-sol 184 and gpt-6-luna 185 (the Atelier pane's transcript names
          // each), New agent with a model and effort 186, its new pane's chips 187; the pane 187 made closed after (last).
          ...pickersCaptureSteps(demoHostIds, async (step) => {
            const backend = registry.backend(demoHostIds.macMini);
            if (!(backend instanceof DemoBackend)) return;
            const panesNow = (): string[] => (registry.list().find((host) => host.id === demoHostIds.macMini)?.topology?.panes ?? []).map((pane) => pane.paneID);
            if (step === "mark-panes") pickersPanes = new Set(panesNow());
            else if (step === "close-made") {
              for (const paneId of panesNow()) if (pickersPanes !== null && !pickersPanes.has(paneId)) await backend.paneActions().closePane(paneId);
              pickersPanes = null;
            } else backend.codexModel(pickersCodexPane, step.codexModel.model, step.codexModel.effort);
            await registry.refresh(demoHostIds.macMini);
          }),
          // An early kind's (Qwen Code's) pane with the Early badge and line 190, a
          // supported one 191, New agent's list 192-193, Settings with early kinds' integrations found 194 (put back
          // after), Settings › Chat's start commands 195, an early kind's split tile 196.
          ...chatSupportCaptureSteps(demoHostIds, async (early) => {
            for (const restore of chatSupportRestore.splice(0).reverse()) restore();
            const backend = registry.backend(demoHostIds.macMini);
            if (early && backend instanceof DemoBackend) {
              for (const [target, state] of Object.entries(chatSupportCaptureTargets)) chatSupportRestore.push(backend.setIntegrationFound(target, state));
            }
            await registry.refresh(demoHostIds.macMini);
            integrations?.forgetForCapture(demoHostIds.macMini);
          }),
          // The Cursor pane's Model chip 200 (its families; nothing picked).
          ...cursorPickCaptureSteps(demoHostIds),
          // The icons 201 (six panes started on build-box's research), Cursor's list read
          // on This Mac 202 (build-box stands in for it; the Mac mini's Cursor list answers as with the keychain locked),
          // Codex's update card (203) (build-box's Codex pane blocked on it), Claude Code's note 204. Each put back after.
          ...listsCaptureSteps(demoHostIds, async (step) => {
            for (const restore of listsRestore.splice(0).reverse()) restore();
            const mini = registry.backend(demoHostIds.macMini);
            const box = registry.backend(demoHostIds.buildBox);
            if (step === "keychain" && mini instanceof DemoBackend) {
              const remote = mini.commands();
              remote.keychainLocked.add("cursor");
              listsCaptureThisMac = demoHostIds.buildBox;
              modelCatalogs.forgetForCapture(demoHostIds.macMini, "cursor");
              listsRestore.push(() => {
                remote.keychainLocked.delete("cursor");
                listsCaptureThisMac = null;
                modelCatalogs.forgetForCapture(demoHostIds.macMini, "cursor");
              });
            } else if (step === "codex-update" && box instanceof DemoBackend) {
              listsRestore.push(box.showPrompt(listsCodexPane, [listsCodexUpdateScreen], null));
            }
            await registry.refresh(demoHostIds.buildBox);
            await registry.refresh(demoHostIds.macMini);
          }),
          // The Model menu on Grok 210, Cursor's families 211, OpenCode's display names
          // in New agent 212, its new pane 213 and that pane's menu 214 (the pane closed after; last).
          ...livepickCaptureSteps(demoHostIds, async (step) => {
            const backend = registry.backend(demoHostIds.macMini);
            if (!(backend instanceof DemoBackend)) return;
            const panesNow = (): string[] => (registry.list().find((host) => host.id === demoHostIds.macMini)?.topology?.panes ?? []).map((pane) => pane.paneID);
            if (step === "mark-panes") livepickPanes = new Set(panesNow());
            else {
              for (const paneId of panesNow()) if (livepickPanes !== null && !livepickPanes.has(paneId)) await backend.paneActions().closePane(paneId);
              livepickPanes = null;
            }
            await registry.refresh(demoHostIds.macMini);
          }),
          // The Cursor pane's not-sent line 220, the Grok pane's chips after a pick 221 and
          // its menu 222 (the demo Grok pane stays on the model picked; last).
          ...livefixCaptureSteps(demoHostIds, async (step) => {
            const backend = registry.backend(demoHostIds.macMini);
            if (!(backend instanceof DemoBackend)) return;
            livefixRestore?.();
            livefixRestore = step === "grok-idle" ? backend.idleForCapture(livefixGrokPane) : null;
            await registry.refresh(demoHostIds.macMini);
          }),
          // Grok Build's Chat tab with Early 230, New agent's list 231, a Claude Code pane
          // 232, Settings › Chat's start commands 233 (nothing changed in the demo; last).
          ...twotierCaptureSteps(demoHostIds),
        ]));
        for (const result of results) console.log(`captured ${result.file} (${result.width}x${result.height})`);
      } else {
        await commands.ready(30_000);
      }
      if (lookProbeDir !== null) console.log(`probed ${await runLookProbe(window, commands, path.resolve(lookProbeDir), demoHostIds)}`);
    })().then(
      () => {
        if (options.captureQuit) app.quit();
      },
      (error: unknown) => {
        console.error(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
        if (options.captureQuit) app.exit(1);
      },
    );
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
