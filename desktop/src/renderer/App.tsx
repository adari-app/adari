// The window: the sidebar on the left (machines, workspaces, panes; what needs
// you first), the selected pane's terminal on the right, or the empty state.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { buildDesktopSidebar, findRow, nextNeedsYou, rowKey } from "../shared/desktop-sidebar";
import { needsCards } from "./chat/needs-card-store";
import { needsPillKinds } from "../shared/needs-pill";
import { applyCleared } from "../shared/prompt/quiet";
import { applyStartScreens } from "../shared/prompt/start-screen";
import { attachSources } from "./components/attachments";
import { draftKey } from "./components/composer-drafts";
import {
  RENDERER_READY,
  type AppCommand,
  type AppInfo,
  type GhosttyAvailability,
  type HostSettings,
  type HostView,
  type MainTab,
  type PaneAction,
  type PaneActionResult,
} from "../shared/ipc-contract";
import { markSeenDone, reconcileSeenDone, type SeenDone } from "../shared/seen-done";
import { emptyFoldState, fold, type SidebarFoldState, type SidebarMode, type SidebarPrioritySectionKind, type SidebarRow } from "../shared/sidebar-model";
import { pendingScopes, restartHolds } from "../shared/chat/pending";
import { agentRestarts } from "./components/restart";
import { HandoffRecents, handoffList, listRows, type HandoffAction, type HandoffTarget } from "../shared/handoff";
import { appShortcut, tileShortcut } from "../shared/app-keys";
import { newAgentPlaces, type NewAgentSplitTarget, type NewAgentWhereChoice } from "../shared/new-agent";
import { defaultWorkspaceName, newWorkspaceMachines, type NewWorkspaceResult } from "../shared/new-workspace";
import { decideTiles, neighbourTile, ratioRequest, sameArrangement, splitRefusal, type TileDecision } from "../shared/pane-layout";
import { bindingTexts, paneBindingOf, rowBindingOf, rowRefusal, workspaceBindingOf, workspaceRefusal, type PaneBinding, type WorkspaceBinding } from "../shared/pane-binding";
import {
  nearestAfterClose,
  notAnswering,
  paneRenameKey,
  renameLabel,
  revealRow,
  revealWorkspace,
  workspacePaneOrder,
  workspaceRenameKey,
  renameTargetOf,
  type PaneMenuContext,
  type RenameTarget,
  type SidebarView,
  type WorkspaceMenuContext,
} from "../shared/pane-manage";
import { PaneViews, lastPaneRestore, loadLastPane, saveLastPane, type PaneRef } from "../shared/pane-view";
import { DrawerToggleGate, TerminalDrawers, drawerShellBelongs, drawerShellLabel, drawerShellsCapacity, withShellsBeingMade, type DrawerShellMaking } from "../shared/terminal-drawer";
import { changesToggled, coveredAfter } from "../shared/changes/tabs";
import { loadFontSize, nextFontSize, saveFontSize, type ViewCommand } from "../shared/view-commands";
import { pendingMessages } from "./chat/chat-state";
import { ChangesOverview } from "./changes/ChangesOverview";
import { AwayScreen, useAwayState } from "./away/Away";
import { revealRequests } from "./search/reveal";
import { SearchScreen, searchAllText, useSearchState } from "./search/Search";
import { isTooShort, selectedRequest, type SearchOpenRequest } from "../shared/search/view";
import { AddHostDialog } from "./components/AddHostDialog";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { EmptyState } from "./components/EmptyState";
import { MainPane } from "./components/MainPane";
import { NewAgentDialog } from "./components/NewAgentDialog";
import type { FolderCalls } from "./components/folder-browse";
import { NewWorkspaceDialog, NewWorkspaceReady } from "./components/NewWorkspaceDialog";
import { Sidebar } from "./components/Sidebar";
import { composerDrafts } from "./components/composer-drafts";
import { agentPicks } from "./components/agent-picks";
import { draftPersistence } from "./components/draft-persistence";
import { deliverHandoff, handoffStore } from "./handoff/handoff-state";
import { layoutStore } from "./split/layout-store";
import { ConfirmClose, commandRunningBody } from "./split/ConfirmClose";
import type { DrawerView } from "./terminal/TerminalDrawer";
import { SplitView, type DividerDrag, type TileEntry } from "./split/SplitView";
import { HandoffPickerView, HandoffToastView } from "./handoff/HandoffPicker";
import { selectInTerminal } from "./terminal/terminal-capture";
import { keyOwners, useEscapeOwner } from "./components/escape-owners";
import { focusReturn, type FocusOwner } from "./components/focus-return";
import { composerSettings } from "./components/composer-settings";
import { SettingsPage, type UpdateReadyPane } from "./settings/SettingsPage";
import { UpdatePill } from "./components/UpdatePill";
import { updateStore } from "./updates/update-store";
import { updateDownloadedToast, updatePill } from "../shared/updates";
import { isSettingsShortcut, settingsKey, type SettingsSection } from "../shared/settings";

const foldKey = "adari.sidebar.fold";
const hostFoldKey = "adari.sidebar.folded-hosts";

function loadFoldedHosts(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(hostFoldKey) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function loadFold(): SidebarFoldState {
  try {
    const saved = localStorage.getItem(foldKey);
    return saved === null ? emptyFoldState : fold.decode(JSON.parse(saved));
  } catch {
    return emptyFoldState;
  }
}

/** This window's own storage (sessionStorage is per window), or null where it is not allowed. */
function windowStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** A divider drag the tiles show: the machine, tab and split it began on, and where its line is. */
interface ShownDrag {
  readonly hostId: string;
  readonly tabId: string;
  readonly splitId: string;
  readonly at: number;
}

const sameDrag = (shown: ShownDrag, drag: DividerDrag): boolean =>
  shown.hostId === drag.hostId && shown.tabId === drag.layout.tabId && shown.splitId === drag.divider.splitId;

interface Selection {
  readonly hostId: string;
  readonly paneId: string;
}

/**
 * The inline rename open now. A pane's field is drawn on its
 * row and bound to the pane as the sidebar showed it when the field opened
 * (rowBindingOf); a workspace's on its header, bound to the machine's
 * connection then (workspaceBindingOf). Its slot and the name it opened with
 * go to the sidebar.
 */
type Renaming =
  | {
      readonly kind: "pane";
      readonly hostId: string;
      readonly paneId: string;
      readonly key: string;
      readonly initial: string;
      readonly binding: PaneBinding;
      /** The pane, or its tab (the name shown was the tab's label), as the menu opened. */
      readonly target: RenameTarget;
    }
  | {
      readonly kind: "workspace";
      readonly hostId: string;
      readonly workspaceId: string;
      readonly key: string;
      readonly initial: string;
      readonly binding: WorkspaceBinding;
    };

/** A main-process refusal as the toast puts it (Electron's "Error invoking remote method …" taken off). */
function failureText(failure: unknown): string {
  return String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

const hidden: GhosttyAvailability = { shown: false };

function sameAvailability(a: GhosttyAvailability, b: GhosttyAvailability): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** How long a note (Ghostty did not open) stays. */
const noticeMs = 8_000;
/** How long a hand-off toast stays. */
const handoffToastMs = 6_000;

/** This window's localStorage, or null where it is not allowed. */
function localStore(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** For captures: the first element matching `selector`, waited for up to `timeoutMs` (a read answers a moment later). */
async function waitForElement(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = document.querySelector(selector);
    if (found !== null || Date.now() >= until) return found as HTMLElement | null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Two frames, so a command's effect is painted before it is acknowledged. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/** The tab a split shows, as its header names it: its label (or number) and workspace. */
function tabTitle(host: HostView, row: SidebarRow): string {
  const tab = host.topology?.tabs.find((candidate) => candidate.tabID === row.tabID);
  const label = tab === undefined ? "" : tab.label !== "" ? tab.label : `Tab ${String(tab.number)}`;
  return label === "" ? row.workspaceLabel : `${label} · ${row.workspaceLabel}`;
}

/** The focus is inside a terminal drawer (its shell, its header). */
function focusInDrawer(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as { closest?: (selector: string) => unknown } | null;
  return active?.closest?.(".tdr") != null;
}

/** Where the keyboard goes back to when a drawer closes: the text field focused as it opens (or the last one), never one in a drawer. */
function focusBeforeDrawer(): FocusOwner | null {
  if (typeof document === "undefined") return null;
  const owner = focusReturn.owner(document.activeElement);
  return owner === null || owner.closest?.(".tdr") != null ? null : owner;
}

/** The folder a drawer's shells open in: the agent pane's, else its workspace's (its first pane's), else null (not known). */
function drawerFolderOf(host: HostView, row: SidebarRow): string | null {
  if (row.cwd !== undefined && row.cwd !== "") return row.cwd;
  return newAgentPlaces([host]).find((place) => place.workspaceId === row.workspaceID)?.folder ?? null;
}

/** Each agent whose update is ready (its machine said so), with its name and where it runs, and its CLI. */
function updateReadyPanes(hosts: readonly HostView[]): UpdateReadyPane[] {
  const panes: UpdateReadyPane[] = [];
  for (const host of hosts) {
    for (const paneId of host.updateReady ?? []) {
      const row = findRow(hosts, host.id, paneId, { nowUnixMs: Date.now(), seenDone: {} });
      if (row !== null) panes.push({ hostId: host.id, paneId, name: row.name, place: `${row.workspaceLabel} · ${host.name}`, kind: row.kind });
    }
  }
  return panes;
}

/**
 * At most one tile shows Changes (a window has one Changes read):
 * the focused tile when its view is Changes, else the first in Herdr's order;
 * any other tile picked on Changes shows Chat until it is the one.
 */
export function oneChangesTile(entries: readonly TileEntry[], focusedPaneId: string): TileEntry[] {
  const changes = (entry: TileEntry): boolean => entry.view === "changes" && entry.row !== null && entry.row.isAgent;
  const shown = entries.find((entry) => entry.paneId === focusedPaneId && changes(entry)) ?? entries.find(changes);
  return entries.map((entry) => (entry.view === "changes" && entry !== shown ? { ...entry, view: "chat" } : entry));
}

export function App() {
  const bridge = window.herdrDesktop;
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [hosts, setHosts] = useState<HostView[] | null>(null);
  const [foldState, setFoldState] = useState<SidebarFoldState>(loadFold);
  const [foldedHosts, setFoldedHosts] = useState<Set<string>>(loadFoldedHosts);
  const [search, setSearch] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  // The machine dialog: Add (null settings) or Edit (a saved machine's settings).
  const [hostDialog, setHostDialog] = useState<{ editing: HostSettings | null } | null>(null);
  // The first machine whose new host key waits for Trust or Cancel.
  const askingHost = hosts?.find((host) => host.hostKey !== undefined);
  // The view Changes was opened over on the open pane (⌃⌘C goes back to it), and the across-agents screen.
  const [changesCovered, setChangesCovered] = useState<MainTab | null>(null);
  const [overviewShown, setOverviewShown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [seenDone, setSeenDone] = useState<SeenDone>({});
  // The terminal's text size (⌘+ / ⌘- / ⌘0), kept per window; the message box over the terminal (⇧⌘T).
  const [fontSize, setFontSize] = useState(() => loadFontSize(windowStorage()));
  const [boxShown, setBoxShown] = useState(false);
  // Open in Ghostty for the selected pane (the header action), a row's menu, and the note when it did not open.
  const [ghostty, setGhostty] = useState<GhosttyAvailability>(hidden);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** New agent's dialog, for the workspace it opened for (null: the first), and Where it opens set to. */
  const [newAgent, setNewAgent] = useState<{
    wanted: { hostId: string; workspaceId: string } | null;
    where?: NewAgentWhereChoice;
    target?: NewAgentSplitTarget | null;
    /** The folder it opens with (a new workspace's Start an agent in it), else the workspace's own. */
    folder?: string;
    /** For exactly that workspace (Start an agent in it): no fallback to another. */
    exact?: boolean;
  } | null>(null);
  /** New workspace's dialog: the machine it opens on (null: the first) and a folder it opens with (set only by a capture). */
  const [newWorkspace, setNewWorkspace] = useState<{ wanted: string | null; folder?: string } | null>(null);
  /** A workspace just made: the main area offers Start an agent in it until another pane or screen is opened. */
  const [made, setMade] = useState<{ hostId: string; hostName: string; workspaceId: string; label: string; folder: string; elsewhere: string | null } | null>(null);
  /** Closing a working agent's pane: asked once. */
  // A working agent's close waits for your yes, bound to the pane as it was when you pressed Close.
  // A row's close (or the header's before its tab's layout came) is bound as the sidebar shows the pane (`from: "row"`).
  // A terminal drawer's shell with a command running asks here too (`body`), and its
  // yes closes it out of its drawer (`drawerOwner`, the agent pane whose drawer holds it).
  const [closing, setClosing] = useState<{ hostId: string; paneId: string; name: string; binding: PaneBinding; from?: "row"; body?: string; drawerOwner?: string } | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const renamingRef = useRef<Renaming | null>(null);
  renamingRef.current = renaming;
  /** A divider being dragged, or let go until Herdr answers: its machine, tab and split, and where its line is. */
  const [drag, setDrag] = useState<ShownDrag | null>(null);
  // The latest snapshot and selection, for seeing a Done at the moment a pane is opened or left.
  const hostsRef = useRef<readonly HostView[]>([]);
  const selectionRef = useRef<Selection | null>(null);
  // The view each pane shows: Chat for an agent, Terminal for a shell, your last pick on a pane kept.
  const views = useMemo(() => new PaneViews(localStore()), []);
  const [, setViewsVersion] = useState(0);
  // The pane open when the app last ran, until it is back (or gone, or you open another).
  const restoring = useRef<PaneRef | null>(loadLastPane(localStore()));
  // Each agent pane's terminal drawer (its shells, height, open), kept per machine and
  // pane across restarts; the drawers a shell is being made for, their one-line notes, whether the shown drawer's
  // shell takes the keys (and a signal that gives them again), and where the keyboard goes back to when it closes.
  const drawers = useMemo(() => new TerminalDrawers(localStore()), []);
  const drawersVersion = useSyncExternalStore(drawers.subscribe, drawers.version, drawers.version);
  const drawerMaking = useRef(new Set<string>());
  // Each drawer's shell being made (its workspace, the panes listed as it was asked for), so the snapshot that
  // lists the new pane before main's answer names it draws no sidebar row for it meanwhile.
  const drawerMakingShells = useRef(new Map<string, DrawerShellMaking>());
  const [drawerOpening, setDrawerOpening] = useState<ReadonlySet<string>>(() => new Set());
  const [drawerNotes, setDrawerNotes] = useState<Readonly<Record<string, string>>>({});
  const [drawerKeys, setDrawerKeys] = useState<{ wants: boolean; signal: number }>({ wants: false, signal: 0 });
  const drawerReturn = useRef<FocusOwner | null>(null);
  const drawerGate = useMemo(() => new DrawerToggleGate(), []);
  // "While you were away": the main process's digest, and whether its screen fills the main area.
  const away = useAwayState(bridge);
  const [awayOpen, setAwayOpen] = useState(false);
  const awayShown = useCallback(() => bridge.awayShown(), [bridge]);
  // "Search conversations" (⇧⌘F): its screen in the main area, the query, the main process's results.
  const [searchOpen, setSearchOpen] = useState(false);
  const [conversationQuery, setConversationQuery] = useState("");
  const searchState = useSearchState(bridge);
  // Settings over the main area (its section; null: closed). The pane under it stays as it was, so
  // Esc, its close button and ⌘, again go back to it with the focus where it was (focus-return.ts).
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const settingsRef = useRef<SettingsSection | null>(null);
  settingsRef.current = settings;
  const settingsSection = useRef<SettingsSection>("machines");
  const settingsBack = useRef<FocusOwner | null>(null);
  const settingsRestore = useRef(false);
  /** The last ⌘, (the page's key, or the menu's): on the Mac both may come for one press, and count as one. */
  const settingsToggled = useRef<{ source: "key" | "menu"; at: number } | null>(null);

  // Every snapshot also reconciles the seen Done sets: a pane that left done is
  // forgotten, so its next Done shows as new (both updates land in one render).
  // And the pending bubbles: a pane gone or no longer an agent's forgets its
  // own; a new terminal or agent session drops them with a quiet line.
  // The machines as Herdr sent them; the page shows them with the cleared panes working.
  const herdrHosts = useRef<HostView[] | null>(null);
  const receiveHosts = useCallback((incoming: HostView[]) => {
    herdrHosts.current = incoming;
    // And a pane showing Codex's hook review as needing you.
    const next = applyStartScreens(applyCleared(incoming, needsCards.all()));
    hostsRef.current = next;
    handoffStore.setHosts(next);
    views.prune(next);
    // A gone pane's drawer, and a gone shell out of its drawer.
    drawers.prune(next);
    setHosts(next);
    setSeenDone((seen) => reconcileSeenDone(seen, next));
    const { scopes, covers } = pendingScopes(next, restartHolds.held(next, Date.now()));
    pendingMessages.reconcile(scopes, covers);
    // A Model or Effort pick held for its pane's next turn goes, or is dropped, by this snapshot.
    agentPicks.syncHosts(next);
  }, [views, drawers]);

  useEffect(() => {
    void bridge.appInfo().then((value) => {
      setInfo(value);
      document.body.classList.add(`platform-${value.platform}`);
      // ⌘Return (Ctrl+Return elsewhere) sends when Send presses Return is off.
      composerSettings.setMac(value.platform === "darwin");
      if (value.capture) document.body.classList.add("capturing");
    });
    void bridge.listHosts().then(receiveHosts);
    const off = bridge.onHostsChanged(receiveHosts);
    // The blocked panes' questions, as main reads them; a pane cleared or marked again shows at once.
    needsCards.attach(bridge);
    // A restart's note while it still runs (Codex's lock wait).
    agentRestarts.attach(bridge);
    const offCleared = needsCards.onCleared(() => {
      if (herdrHosts.current !== null) receiveHosts(herdrHosts.current);
    });
    // The shown Cursor panes' footers, as main reads them (their chips and ring).
    const offFooters = agentPicks.attach(bridge);
    // Adari's own update state (the footer's pill, Settings › Updates, the toast).
    const offUpdates = updateStore.attach(bridge);
    // Every draft change is kept by the main process; the kept ones come back into their boxes.
    // (A bridge without them, as the older tests' fakes, keeps drafts in memory only.)
    const keepsDrafts = typeof bridge.saveDraft === "function" && typeof bridge.loadDrafts === "function";
    if (keepsDrafts) {
      draftPersistence.attach(bridge);
      void bridge.loadDrafts().then((state) => draftPersistence.restore(state));
    }
    const offDrafts = keepsDrafts ? bridge.onDraftsChanged((event) => draftPersistence.changed(event)) : () => undefined;
    // The window closing lets every Send still waiting for its uploads go, unsent (its draft is kept).
    const leave = (): void => composerDrafts.leaveAll();
    const listens = typeof window.addEventListener === "function";
    if (listens) window.addEventListener("pagehide", leave);
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      offCleared();
      offFooters();
      offUpdates();
      offDrafts();
      agentRestarts.attach(null);
      if (listens) window.removeEventListener("pagehide", leave);
      if (keepsDrafts) draftPersistence.detach();
      clearInterval(clock);
    };
  }, [bridge, receiveHosts]);

  useEffect(() => {
    localStorage.setItem(foldKey, JSON.stringify(foldState));
  }, [foldState]);

  useEffect(() => saveFontSize(windowStorage(), fontSize), [fontSize]);

  // The View menu's commands; ⌃⌘C reads the open pane and tab as they are now.
  const viewHandler = useRef<(command: ViewCommand) => void>(() => undefined);
  useEffect(() => bridge.onViewCommand((command) => viewHandler.current(command)), [bridge]);

  useEffect(() => {
    localStorage.setItem(hostFoldKey, JSON.stringify([...foldedHosts]));
  }, [foldedHosts]);

  const setHostFolded = useCallback((hostId: string, folded: boolean) => {
    setFoldedHosts((current) => {
      if (current.has(hostId) === folded) return current;
      const next = new Set(current);
      if (folded) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  }, []);

  // The drawers' shells (every owner, every machine) live in the drawer
  // only: no sidebar row, nor in Priority, Needs you, the counts, search or ⇧⌘J. A shell no drawer holds shows as any pane does.
  const drawerShells = useMemo(
    () => withShellsBeingMade(drawers.heldShells(hosts ?? []), hosts ?? [], drawerMakingShells.current.values()),
    [drawers, drawersVersion, hosts, drawerOpening],
  );
  const sidebar = useMemo(
    () => buildDesktopSidebar(hosts ?? [], { fold: foldState, search: search ?? "", nowUnixMs: now, seenDone, drawerShells }),
    [hosts, foldState, search, now, seenDone, drawerShells],
  );
  // Each blocked pane's reading for its row's pill (Pending Approval or Awaiting Input), as main
  // reads them; the row shows it only while Herdr says the pane needs you.
  const needsVersion = useSyncExternalStore(needsCards.subscribe, needsCards.version, needsCards.version);
  const needsPills = useMemo(() => needsPillKinds(needsCards.all()), [needsVersion]);

  const selectedHost = selection === null ? null : (hosts?.find((host) => host.id === selection.hostId) ?? null);
  const selectedRow =
    selection === null || hosts === null ? null : findRow(hosts, selection.hostId, selection.paneId, { nowUnixMs: now, seenDone });
  const selectedKey = selection === null ? null : rowKey(selection.hostId, selection.paneId);
  // The open pane's view: your pick on it, else Chat for an agent and Terminal for a shell (on start, a reconnect, every open).
  const tab: MainTab = selection === null || selectedRow === null ? "terminal" : views.view(selection.hostId, selectedRow);
  const chooseTab = useCallback(
    (next: MainTab): void => {
      const current = selectionRef.current;
      const row = current === null ? null : findRow(hostsRef.current, current.hostId, current.paneId, { nowUnixMs: Date.now(), seenDone: {} });
      if (current === null || row === null) return;
      views.pick(current.hostId, row, next);
      setViewsVersion((n) => n + 1);
    },
    [views],
  );


  // A pane's Done is seen only while the pane is done: when it is opened done,
  // or left done (a Done reached while it was open keeps its dot on screen
  // until you leave it). Opening a working pane sees
  // nothing, so the Done it reaches later stays new.
  const show = useCallback((next: Selection | null) => {
    const left = selectionRef.current;
    selectionRef.current = next;
    restoring.current = null;
    // What Changes covers is the open pane's: opening another pane clears it.
    if (left?.hostId !== next?.hostId || left?.paneId !== next?.paneId) {
      setChangesCovered(null);
      // Another pane's drawer does not take the keys as it shows (only as it opens).
      drawerReturn.current = null;
      setDrawerKeys((keys) => (keys.wants ? { ...keys, wants: false } : keys));
    }
    setMade(null);
    saveLastPane(localStore(), next);
    setSelection(next);
    setAwayOpen(false);
    setSearchOpen(false);
    setSeenDone((seen) => {
      let marked = seen;
      for (const pane of [left, next]) {
        if (pane !== null) marked = markSeenDone(marked, hostsRef.current, pane.hostId, pane.paneId);
      }
      return marked;
    });
  }, []);
  const select = useCallback(
    (hostId: string, paneId: string) => {
      setOverviewShown(false);
      // A pane opened (a row, ⇧⌘J, a card, a result) shows in place of Settings.
      setSettings(null);
      show({ hostId, paneId });
    },
    [show],
  );
  // Settings opens over the main area at its last section (or `section`); the away, search and
  // Changes screens close (Settings goes back to the pane). The focus to go back to is noted as it opens.
  const openSettings = useCallback((section?: SettingsSection) => {
    if (section !== undefined) settingsSection.current = section;
    if (settingsRef.current === null) {
      settingsBack.current = focusReturn.owner(typeof document === "undefined" ? null : document.activeElement);
      settingsRestore.current = false;
    }
    setAwayOpen(false);
    setSearchOpen(false);
    setOverviewShown(false);
    setSettings(settingsSection.current);
  }, []);
  /** Back to the pane: with `restore`, the focus goes back where it was (Esc, close, ⌘,); not when another screen opened. */
  const closeSettings = useCallback((restore: boolean) => {
    if (settingsRef.current === null) return;
    settingsRestore.current = restore;
    if (!restore) settingsBack.current = null;
    setSettings(null);
  }, []);
  const toggleSettings = useCallback(
    (source: "key" | "menu" | "button") => {
      if (source !== "button") {
        const now = Date.now();
        const last = settingsToggled.current;
        if (last !== null && last.source !== source && now - last.at < 600) {
          settingsToggled.current = null;
          return;
        }
        settingsToggled.current = { source, at: now };
      }
      if (settingsRef.current === null) openSettings();
      else closeSettings(true);
    },
    [openSettings, closeSettings],
  );
  useEffect(() => {
    if (settings !== null || !settingsRestore.current) return;
    settingsRestore.current = false;
    const back = settingsBack.current;
    settingsBack.current = null;
    focusReturn.restore(back);
  }, [settings]);
  // Another screen opened (View › While You Were Away, ⇧⌘F, What Each Agent Changed): it shows, Settings closes.
  useEffect(() => {
    if (awayOpen || searchOpen || overviewShown) closeSettings(false);
  }, [awayOpen, searchOpen, overviewShown, closeSettings]);

  // Every pick of a tab (the segments, ⌃⌘C, an app command) keeps what Changes covers.
  // The pick is the pane's (each pane keeps its own view, Changes included).
  // A window has one Changes read, so one tile of a tab shows
  // Changes at a time: Changes picked on a tile moves the tab's other tiles showing it back to Chat.
  const leaveChangesElsewhere = useCallback(
    (hostId: string, paneId: string) => {
      for (const tile of tilesRef.current?.tiles ?? []) {
        if (tile.paneId === paneId) continue;
        const row = findRow(hostsRef.current, hostId, tile.paneId, { nowUnixMs: Date.now(), seenDone: {} });
        if (row !== null && views.view(hostId, row) === "changes") views.pick(hostId, row, "chat");
      }
    },
    [views],
  );
  const pickTab = useCallback(
    (next: MainTab) => {
      const current = selectionRef.current;
      if (next === "changes" && current !== null) leaveChangesElsewhere(current.hostId, current.paneId);
      setChangesCovered((covered) => coveredAfter(next, tab, covered));
      chooseTab(next);
    },
    [tab, chooseTab, leaveChangesElsewhere],
  );
  // An agent opened from the across-agents screen opens in its Changes; what it covers is not known.
  const openAgentChanges = useCallback(
    (hostId: string, paneId: string) => {
      select(hostId, paneId);
      setChangesCovered(null);
      chooseTab("changes");
    },
    [select, chooseTab],
  );

  // After a restart the pane you had open comes back selected, once its Mac shows it.
  useEffect(() => {
    const last = restoring.current;
    if (last === null || hosts === null || info === null) return;
    if (info.capture) {
      restoring.current = null;
      return;
    }
    const verdict = lastPaneRestore(last, hosts);
    if (verdict === "restore") show(last);
    else if (verdict === "drop") {
      restoring.current = null;
      saveLastPane(localStore(), null);
    }
  }, [hosts, info, show]);

  // One screen fills the main area at a time (the across-agents Changes screen too).
  const openConversations = useCallback((query: string | null) => {
    if (query !== null) setConversationQuery(query);
    setOverviewShown(false);
    setAwayOpen(false);
    setSearchOpen(true);
  }, []);
  // An away card or a search result opens its pane in Chat (the pane's own pick, as a pick of Chat would).
  const openInChat = useCallback(
    (hostId: string, paneId: string) => {
      select(hostId, paneId);
      setChangesCovered(null);
      chooseTab("chat");
    },
    [select, chooseTab],
  );
  // A result opens its pane in Chat at the message.
  const openResult = useCallback(
    (request: SearchOpenRequest) => {
      openInChat(request.macID, request.paneID);
      revealRequests.ask(request.macID, request.paneID, request.messageID);
    },
    [openInChat],
  );
  // The shown pane's tab: its layout comes from the main process and follows Herdr live.
  useEffect(() => layoutStore.attach(bridge), [bridge]);
  useEffect(() => layoutStore.watch(bridge, selection?.hostId ?? null, selection?.paneId ?? null), [bridge, selection]);
  const layoutEvent = useSyncExternalStore(layoutStore.subscribe, () => layoutStore.get());
  const selectedTab = selection === null ? null : (selectedHost?.topology?.panes.find((pane) => pane.paneID === selection.paneId)?.tabID ?? null);
  const shownLayout = layoutEvent === null || selection === null ? null : layoutStore.layoutFor(selection.hostId, selectedTab);
  // The tab's panes as tiles (the selected one focused), or the pane alone (one pane, zoomed, past 4, no layout yet).
  // A drag's override moves the tiles of the machine and tab it began on only.
  const dragHere = drag !== null && selection !== null && drag.hostId === selection.hostId && drag.tabId === shownLayout?.tabId;
  const decision = useMemo<TileDecision | null>(
    () => (selection === null ? null : decideTiles(shownLayout, selection.paneId, dragHere ? new Map([[drag.splitId, drag.at]]) : undefined)),
    [shownLayout, selection, drag, dragHere],
  );
  const tiles = decision?.kind === "tiles" ? decision : null;
  // Herdr's zoom is what shows: a zoomed tab shows its zoomed pane, so
  // the selection moves to it (also when the zoom came from Herdr's TUI) and
  // the sidebar marks, the view, the readers and Unzoom follow.
  const zoomedPane = decision?.kind === "single" && decision.reason === "zoomed" && decision.paneId !== selection?.paneId ? decision.paneId : null;
  useEffect(() => {
    const current = selectionRef.current;
    if (zoomedPane !== null && current !== null) show({ hostId: current.hostId, paneId: zoomedPane });
  }, [zoomedPane, show]);
  const tilesRef = useRef<typeof tiles>(null);
  tilesRef.current = tiles;
  const shownKeys = useMemo<ReadonlySet<string>>(() => {
    if (selection === null) return new Set();
    if (tiles === null) return new Set([rowKey(selection.hostId, selection.paneId)]);
    return new Set(tiles.tiles.map((tile) => rowKey(selection.hostId, tile.paneId)));
  }, [selection, tiles]);
  // A change gives the focused tile the keys (⌘1–⌘4, ⌃⌘ arrows, a click on a tile off its fields).
  const [tileKeys, setTileKeys] = useState(0);
  // Focusing a tile is here only: Herdr's pane.focus is not sent (main/herdr/pane-methods.ts; Herdr's focus following the tile is a card).
  const focusTile = useCallback(
    (paneId: string, keys: boolean) => {
      const current = selectionRef.current;
      if (current === null) return;
      if (current.paneId !== paneId) show({ hostId: current.hostId, paneId });
      if (keys) setTileKeys((n) => n + 1);
    },
    [show],
  );
  // Split, resize, zoom, close: sent to Herdr; the layout comes back read again (main/pane-actions.ts).
  const paneAction = useCallback(
    (hostId: string, action: PaneAction): Promise<PaneActionResult | null> => {
      if (typeof bridge.paneAction !== "function") return Promise.resolve(null);
      return bridge.paneAction(hostId, action).catch((failure: unknown) => {
        const what = {
          split: "Not split",
          resize: "Not resized",
          zoom: action.type === "zoom" && !action.zoomed ? "Not unzoomed" : "Not zoomed",
          close: "Not closed",
          rename: "Not renamed",
        }[action.type];
        setNotice(`${what}: ${String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
        return null;
      });
    },
    [bridge],
  );
  const seenDoneRef = useRef(seenDone);
  seenDoneRef.current = seenDone;
  // Each action is bound to the pane as this window shows it now: the machine's snapshot and the tab's layout
  // (null when it does not show it, and nothing is asked).
  const bindingFor = useCallback((hostId: string, paneId: string): PaneBinding | null => {
    const host = hostsRef.current.find((candidate) => candidate.id === hostId);
    const tabId = host?.topology?.panes.find((pane) => pane.paneID === paneId)?.tabID ?? null;
    return host === undefined ? null : paneBindingOf(host, layoutStore.layoutFor(hostId, tabId), paneId);
  }, []);
  const closePane = useCallback(
    (hostId: string, paneId: string, binding: PaneBinding, from?: "row") => {
      // The other tiles as they were: the focus moves to one of them once the pane is gone.
      const others = (tilesRef.current?.tiles ?? []).filter((tile) => tile.paneId !== paneId);
      // The pane's workspace's rows as they were, for the nearest one when it was shown alone.
      const topology = hostsRef.current.find((candidate) => candidate.id === hostId)?.topology ?? null;
      const order = topology === null ? [] : workspacePaneOrder(topology, hostId, paneId);
      void paneAction(hostId, { type: "close", paneId, binding, ...(from === undefined ? {} : { from }) }).then((result) => {
        const current = selectionRef.current;
        if (result === null || current === null || current.hostId !== hostId || current.paneId !== paneId) return;
        const next = others[0];
        if (next !== undefined) {
          show({ hostId, paneId: next.paneId });
          return;
        }
        // The last pane shown: the nearest row in its workspace that the machine still lists, else nothing selected.
        const listed = (id: string): boolean =>
          hostsRef.current.find((candidate) => candidate.id === hostId)?.topology?.panes.some((pane) => pane.paneID === id) === true;
        const nearest = nearestAfterClose(order, paneId, listed);
        show(nearest === null ? null : { hostId, paneId: nearest });
      });
    },
    [paneAction, show],
  );
  const askClose = useCallback(
    (paneId: string) => {
      const current = selectionRef.current;
      if (current === null) return;
      const row = findRow(hostsRef.current, current.hostId, paneId, { nowUnixMs: Date.now(), seenDone: {} });
      const binding = bindingFor(current.hostId, paneId);
      if (binding === null) {
        setNotice(`Not closed: ${bindingTexts.notShown}`);
        return;
      }
      if (row !== null && row.isAgent && row.status === "working") setClosing({ hostId: current.hostId, paneId, name: row.name, binding });
      else closePane(current.hostId, paneId, binding);
    },
    [bindingFor, closePane],
  );
  // A pane's menu (the header's More, a row's) keeps what it is about from the moment it
  // opens: the pane bound as the window shows it in its tab, else (a row the main area does not show, or a tab whose
  // layout has not come yet) as the sidebar shows it (`from: "row"`), and the name shown. Null: not listed now.
  const paneContextOf = useCallback(
    (hostId: string, paneId: string): PaneMenuContext | null => {
      const host = hostsRef.current.find((candidate) => candidate.id === hostId);
      const row = findRow(hostsRef.current, hostId, paneId, { nowUnixMs: Date.now(), seenDone: seenDoneRef.current });
      if (host === undefined || row === null) return null;
      const shown = bindingFor(hostId, paneId);
      const binding = shown ?? rowBindingOf(host, paneId);
      if (binding === null) return null;
      return { hostId, paneId, binding, ...(shown === null ? { from: "row" as const } : {}), name: row.name, target: renameTargetOf(row) };
    },
    [bindingFor],
  );
  const workspaceContextOf = useCallback((hostId: string, workspaceId: string): WorkspaceMenuContext | null => {
    const host = hostsRef.current.find((candidate) => candidate.id === hostId);
    const workspace = host?.topology?.workspaces.find((candidate) => candidate.workspaceID === workspaceId);
    const binding = host === undefined ? null : workspaceBindingOf(host, workspaceId);
    return workspace === undefined || binding === null ? null : { hostId, workspaceId, binding, name: workspace.label };
  }, []);
  /**
   * Why a menu's pick does nothing (null: it goes on): the machine gone or not answering, or the pane (or the
   * connection) no longer what the menu opened on. `what` begins the note ("Not closed", "Not renamed").
   */
  const pickRefusal = useCallback((what: string, hostId: string, kept: PaneMenuContext | WorkspaceMenuContext | null, gone: string): string | null => {
    const host = hostsRef.current.find((candidate) => candidate.id === hostId);
    if (host === undefined) return `${what}: ${bindingTexts.machineGone}`;
    if (host.state !== "connected") return `${what}: ${notAnswering(host.name)}.`;
    if (kept === null) return `${what}: ${gone}`;
    const refusal = "paneId" in kept ? rowRefusal(kept.binding, host) : workspaceRefusal(kept.binding, host);
    return refusal === null ? null : `${what}: ${refusal}`;
  }, []);
  // Close pane from the pane header's More and a sidebar row's menu, on any pane of any machine,
  // bound as the menu opened; a working agent asks first, as a tile's close does, and your yes
  // sends that same binding.
  const askClosePane = useCallback(
    (hostId: string, kept: PaneMenuContext | null) => {
      const refusal = pickRefusal("Not closed", hostId, kept, bindingTexts.gone);
      if (refusal !== null || kept === null) {
        setNotice(refusal);
        return;
      }
      const row = findRow(hostsRef.current, hostId, kept.paneId, { nowUnixMs: Date.now(), seenDone: {} });
      const from = kept.from === undefined ? {} : { from: kept.from };
      if (row !== null && row.isAgent && row.status === "working") setClosing({ hostId, paneId: kept.paneId, name: kept.name, binding: kept.binding, ...from });
      else closePane(hostId, kept.paneId, kept.binding, kept.from);
    },
    [pickRefusal, closePane],
  );
  // The terminal drawer. Its keyboard goes back where it was before it opened.
  const restoreDrawerFocus = useCallback((): void => {
    const owner = drawerReturn.current;
    drawerReturn.current = null;
    setDrawerKeys((keys) => (keys.wants ? { ...keys, wants: false } : keys));
    if (owner !== null && owner.isConnected !== false) {
      focusReturn.restore(owner);
      return;
    }
    // Nothing to go back to: the keyboard leaves the drawer.
    if (typeof document === "undefined") return;
    const active = document.activeElement as { closest?: (selector: string) => unknown; blur?: () => void } | null;
    if (active?.closest?.(".tdr") != null) active.blur?.();
  }, []);
  const setDrawerNote = useCallback((key: string, text: string | null): void => {
    setDrawerNotes((notes) => {
      if (text === null && !(key in notes)) return notes;
      const next = { ...notes };
      if (text === null) delete next[key];
      else next[key] = text;
      return next;
    });
  }, []);
  // A shell for an agent pane's drawer: a real Herdr shell pane in its workspace at its folder (New agent's shell
  // path, main/herdr/drawer-shell.ts); one at a time per drawer; once made it is the drawer's shown shell.
  const newDrawerShell = useCallback(
    (hostId: string, ownerPaneId: string): void => {
      const key = `${hostId}|${ownerPaneId}`;
      const host = hostsRef.current.find((candidate) => candidate.id === hostId);
      const row = findRow(hostsRef.current, hostId, ownerPaneId, { nowUnixMs: Date.now(), seenDone: {} });
      if (host === undefined || row === null || !row.isAgent) return;
      if (drawerMaking.current.has(key) || drawers.state(hostId, ownerPaneId).shells.length >= drawerShellsCapacity) return;
      const open = bridge.openDrawerShell;
      if (typeof open !== "function") {
        setDrawerNote(key, "Not opened: this window cannot open a shell.");
        return;
      }
      if (host.state !== "connected") {
        setDrawerNote(key, `Not opened: ${notAnswering(host.name)}.`);
        return;
      }
      drawerMaking.current.add(key);
      drawerMakingShells.current.set(key, { hostId, workspaceId: row.workspaceID, known: new Set(host.topology?.panes.map((pane) => pane.paneID) ?? []) });
      setDrawerOpening(new Set(drawerMaking.current));
      setDrawerNote(key, null);
      void open(hostId, { workspaceId: row.workspaceID, folder: drawerFolderOf(host, row) })
        .then(
          (made) => {
            drawers.addShell(hostId, ownerPaneId, made.paneId, Date.now());
            if (made.place !== "folder") {
              const where = made.place === "home" ? `in ${host.name}'s home folder` : `where ${host.name}'s Herdr opens a new tab`;
              setDrawerNote(key, `No folder is known for ${row.workspaceLabel}: this shell opened ${where}.`);
            }
            const shown = selectionRef.current;
            if (shown?.hostId === hostId && shown.paneId === ownerPaneId && drawers.state(hostId, ownerPaneId).open) {
              setDrawerKeys((keys) => ({ wants: true, signal: keys.signal + 1 }));
            }
          },
          (failure: unknown) => setDrawerNote(key, `Not opened: ${failureText(failure)}`),
        )
        .finally(() => {
          drawerMaking.current.delete(key);
          drawerMakingShells.current.delete(key);
          setDrawerOpening(new Set(drawerMaking.current));
        });
    },
    [bridge, drawers, setDrawerNote],
  );
  // ⌘J, View › Terminal, the header's (or an agent tile's) terminal button: the open agent pane's drawer opens, its
  // shell taking the keys (its first shell made on the first open), or closes, the keys going back where they were.
  const mainShowsPane = useRef(true);
  const toggleDrawer = useCallback(
    (paneId?: string): void => {
      const current = selectionRef.current;
      if (current === null || !mainShowsPane.current) return;
      const target = paneId ?? current.paneId;
      const row = findRow(hostsRef.current, current.hostId, target, { nowUnixMs: Date.now(), seenDone: {} });
      if (row === null || !row.isAgent) return;
      // A tile's own button focuses its tile first: the drawer is the focused tile's.
      if (target !== current.paneId) show({ hostId: current.hostId, paneId: target });
      const state = drawers.state(current.hostId, target);
      if (state.open) {
        const inside = focusInDrawer();
        drawers.setOpen(current.hostId, target, false);
        if (inside) restoreDrawerFocus();
        else {
          drawerReturn.current = null;
          setDrawerKeys((keys) => (keys.wants ? { ...keys, wants: false } : keys));
        }
        return;
      }
      drawerReturn.current = focusBeforeDrawer();
      drawers.setOpen(current.hostId, target, true);
      setDrawerKeys((keys) => ({ wants: true, signal: keys.signal + 1 }));
      if (state.shells.length === 0) newDrawerShell(current.hostId, target);
    },
    [drawers, show, newDrawerShell, restoreDrawerFocus],
  );
  const selectDrawerShell = useCallback(
    (hostId: string, ownerPaneId: string, shellPaneId: string): void => {
      drawers.select(hostId, ownerPaneId, shellPaneId);
      setDrawerKeys((keys) => ({ wants: true, signal: keys.signal + 1 }));
    },
    [drawers],
  );
  // A drawer shell's close: its Herdr pane closed (bound as the sidebar shows it), then out of its drawer; the shell
  // beside it takes the keys, or (the last one: the drawer closes) the keys go back where they were.
  const closeShellNow = useCallback(
    (hostId: string, ownerPaneId: string, shellPaneId: string, binding: PaneBinding, from: "row" | undefined, refocus: boolean): void => {
      void paneAction(hostId, { type: "close", paneId: shellPaneId, binding, ...(from === undefined ? {} : { from }) }).then((result) => {
        if (result === null) return;
        const last = drawers.removeShell(hostId, ownerPaneId, shellPaneId);
        if (!refocus) return;
        if (last) restoreDrawerFocus();
        else setDrawerKeys((keys) => ({ wants: true, signal: keys.signal + 1 }));
      });
    },
    [paneAction, drawers, restoreDrawerFocus],
  );
  // ×: closes a shell of the drawer, always after the close confirmation: Herdr gives no authoritative idle state for a
  // shell, and its screen is no proof (a Node REPL's "> ", output ending in "$" or "#").
  // Only a shell this drawer holds, never its owner's own pane or another workspace's pane.
  const closeDrawerShell = useCallback(
    (hostId: string, ownerPaneId: string, shellPaneId: string): void => {
      const refocus = focusInDrawer();
      const host = hostsRef.current.find((candidate) => candidate.id === hostId);
      const state = drawers.state(hostId, ownerPaneId);
      if (!state.shells.some((shell) => shell.paneId === shellPaneId)) return;
      if (!drawerShellBelongs(ownerPaneId, shellPaneId, host?.topology)) {
        // Not this drawer's to close: out of it, nothing sent.
        if (drawers.removeShell(hostId, ownerPaneId, shellPaneId) && refocus) restoreDrawerFocus();
        return;
      }
      const kept = paneContextOf(hostId, shellPaneId);
      if (kept === null && host?.state === "connected" && host.topology?.panes.some((pane) => pane.paneID === shellPaneId) !== true) {
        // Gone from Herdr already: out of the drawer.
        if (drawers.removeShell(hostId, ownerPaneId, shellPaneId) && refocus) restoreDrawerFocus();
        return;
      }
      const refusal = pickRefusal("Not closed", hostId, kept, bindingTexts.gone);
      if (refusal !== null || kept === null) {
        setNotice(refusal);
        return;
      }
      // Named as its drawer tab is ("Terminal", "Terminal 2", … by the drawer's order).
      const index = state.shells.filter((shell) => drawerShellBelongs(ownerPaneId, shell.paneId, host?.topology)).findIndex((shell) => shell.paneId === shellPaneId);
      setClosing({
        hostId,
        paneId: shellPaneId,
        name: drawerShellLabel(index),
        binding: kept.binding,
        ...(kept.from === undefined ? {} : { from: kept.from }),
        body: commandRunningBody,
        drawerOwner: ownerPaneId,
      });
    },
    [drawers, paneContextOf, pickRefusal, restoreDrawerFocus],
  );
  // Rename… from a row's menu and the pane header's More: the field opens on the pane's row, the
  // sidebar first made to show it (revealRow), bound to the pane as the menu opened, with the
  // name shown then. The sidebar's fold, its machines folded and its search are read as the window shows them now.
  const sidebarViewRef = useRef<SidebarView>({ fold: foldState, foldedHosts, search });
  sidebarViewRef.current = { fold: foldState, foldedHosts, search };
  const beginPaneRename = useCallback(
    (hostId: string, kept: PaneMenuContext | null) => {
      const refusal = pickRefusal("Not renamed", hostId, kept, bindingTexts.gone);
      if (refusal !== null || kept === null) {
        setNotice(refusal);
        return;
      }
      const { paneId } = kept;
      setRowMenu(null);
      const view = sidebarViewRef.current;
      const shown = revealRow(hostsRef.current, view, { nowUnixMs: Date.now(), seenDone: seenDoneRef.current }, hostId, paneId);
      if (shown.fold !== view.fold) setFoldState(shown.fold);
      if (shown.foldedHosts !== view.foldedHosts) setFoldedHosts(new Set(shown.foldedHosts));
      if (shown.search !== view.search) setSearch(shown.search);
      // Two rows of one named tab rename the same tab, each in its own row's field (its own slot).
      setRenaming({ kind: "pane", hostId, paneId, key: paneRenameKey(hostId, paneId), initial: kept.name, binding: kept.binding, target: kept.target });
    },
    [pickRefusal],
  );
  // Rename workspace… from a workspace header's menu: the field on the header (the sidebar shows it),
  // bound to the machine's connection as the menu opened.
  const beginWorkspaceRename = useCallback(
    (hostId: string, kept: WorkspaceMenuContext | null) => {
      const refusal = pickRefusal("Not renamed", hostId, kept, bindingTexts.workspaceGone);
      if (refusal !== null || kept === null) {
        setNotice(refusal);
        return;
      }
      const { workspaceId } = kept;
      setRowMenu(null);
      const view = sidebarViewRef.current;
      const shown = revealWorkspace(hostsRef.current, view, { nowUnixMs: Date.now(), seenDone: seenDoneRef.current }, hostId, workspaceId);
      if (shown.fold !== view.fold) setFoldState(shown.fold);
      if (shown.foldedHosts !== view.foldedHosts) setFoldedHosts(new Set(shown.foldedHosts));
      if (shown.search !== view.search) setSearch(shown.search);
      setRenaming({ kind: "workspace", hostId, workspaceId, key: workspaceRenameKey(hostId, workspaceId), initial: kept.name, binding: kept.binding });
    },
    [pickRefusal],
  );
  // Return in the field: one pane.rename bound as the field opened, unless the name is the same or the pane, or the
  // machine's connection, is no longer what it was (refused with the reason, nothing sent).
  const saveRename = useCallback(
    (text: string, key?: string) => {
      const current = renamingRef.current;
      if (current === null || (key !== undefined && key !== current.key)) return;
      setRenaming(null);
      const label = renameLabel(text);
      if (label === current.initial) return;
      // Herdr's workspace.rename and tab.rename take a name, never none (their label is a string).
      if (current.kind === "workspace" && label === null) {
        setNotice("Not renamed: a workspace needs a name.");
        return;
      }
      if (current.kind === "pane" && current.target === "tab" && label === null) {
        setNotice("Not renamed: a tab needs a name.");
        return;
      }
      const host = hostsRef.current.find((candidate) => candidate.id === current.hostId);
      if (host === undefined) {
        setNotice(`Not renamed: ${bindingTexts.machineGone}`);
        return;
      }
      if (host.state !== "connected") {
        setNotice(`Not renamed: ${notAnswering(host.name)}.`);
        return;
      }
      const refusal = current.kind === "pane" ? rowRefusal(current.binding, host) : workspaceRefusal(current.binding, host);
      if (refusal !== null) {
        setNotice(`Not renamed: ${refusal}`);
        return;
      }
      if (current.kind === "pane") {
        const tab = current.target === "tab" ? { target: "tab" as const, tabId: current.binding.tabId } : {};
        void paneAction(current.hostId, { type: "rename", paneId: current.paneId, label, binding: current.binding, ...tab });
        return;
      }
      if (typeof bridge.renameWorkspace !== "function" || label === null) return;
      void bridge
        .renameWorkspace(current.hostId, { workspaceId: current.workspaceId, label, binding: current.binding })
        .catch((failure: unknown) => setNotice(`Not renamed: ${failureText(failure)}`));
    },
    [paneAction, bridge],
  );
  // A field's Esc or blur ends its own rename only (one replaced by another's, its blur coming late, does nothing).
  const cancelRename = useCallback((key?: string) => setRenaming((current) => (current === null || (key !== undefined && key !== current.key) ? current : null)), []);
  // A pane or workspace gone while its field is open: the field goes with its row or header.
  useEffect(() => {
    const current = renamingRef.current;
    if (current === null) return;
    const gone =
      current.kind === "pane"
        ? findRow(hosts ?? [], current.hostId, current.paneId, { nowUnixMs: Date.now(), seenDone: {} }) === null
        : hosts?.find((candidate) => candidate.id === current.hostId)?.topology?.workspaces.some((workspace) => workspace.workspaceID === current.workspaceId) !== true;
    if (gone) setRenaming(null);
  }, [hosts]);
  const zoomPane = useCallback(
    (paneId: string, zoomed: boolean) => {
      const current = selectionRef.current;
      if (current === null) return;
      const binding = bindingFor(current.hostId, paneId);
      if (binding === null) setNotice(`${zoomed ? "Not zoomed" : "Not unzoomed"}: ${bindingTexts.notShown}`);
      else void paneAction(current.hostId, { type: "zoom", paneId, zoomed, binding });
    },
    [bindingFor, paneAction],
  );
  const resizing = useCallback(
    (moving: DividerDrag, at: number) => setDrag({ hostId: moving.hostId, tabId: moving.layout.tabId, splitId: moving.divider.splitId, at }),
    [],
  );
  const resizeCancelled = useCallback((moving: DividerDrag) => setDrag((shown) => (shown !== null && sameDrag(shown, moving) ? null : shown)), []);
  // A release is about the machine and tab the drag began on, never the selection's: sent to that
  // machine while that tab still shows as it was; refused, with nothing sent, once it changed.
  const resized = useCallback(
    (released: DividerDrag, at: number) => {
      const request = ratioRequest(released.divider, at);
      const current = selectionRef.current;
      const now = layoutStore.layoutFor(released.hostId, released.layout.tabId);
      if (request === null) {
        resizeCancelled(released);
        return;
      }
      if (current === null || current.hostId !== released.hostId || now === null || !sameArrangement(now, released.layout)) {
        resizeCancelled(released);
        setNotice("Not resized: the tab changed while the divider was dragged.");
        return;
      }
      // Bound to the pane and the whole split (its shape) as the drag began; a divider Herdr's
      // tree does not place is not sent.
      if (released.binding === null || released.path === null || released.shape === null) {
        resizeCancelled(released);
        setNotice(`Not resized: ${released.binding === null ? bindingTexts.notShown : bindingTexts.divider}`);
        return;
      }
      // Held where you let go until Herdr's layout comes back.
      const held: ShownDrag = { hostId: released.hostId, tabId: released.layout.tabId, splitId: released.divider.splitId, at };
      setDrag(held);
      const resize = { type: "resize" as const, ...request, path: released.path, shape: released.shape, binding: released.binding };
      void paneAction(released.hostId, resize).finally(() =>
        setDrag((shown) => (shown === held ? null : shown)),
      );
    },
    [paneAction, resizeCancelled],
  );
  /** The pane New agent's Where (and the split menu) splits: the one shown, with its tab's pane count, bound as shown now. */
  const splitTargetOf = useCallback(
    (hostId: string, paneId: string): NewAgentSplitTarget | null => {
      const host = hostsRef.current.find((candidate) => candidate.id === hostId);
      const pane = host?.topology?.panes.find((candidate) => candidate.paneID === paneId);
      const row = findRow(hostsRef.current, hostId, paneId, { nowUnixMs: Date.now(), seenDone: {} });
      const binding = bindingFor(hostId, paneId);
      if (host === undefined || pane === undefined || binding === null) return null;
      const tabPanes = host.topology!.panes.filter((candidate) => candidate.tabID === pane.tabID).length;
      return { hostId, workspaceId: pane.workspaceID, paneId, name: row?.name ?? paneId, tabPanes, binding };
    },
    [bindingFor],
  );
  const chooseTileView = useCallback(
    (paneId: string, next: MainTab) => {
      const current = selectionRef.current;
      // The focused tile's pick keeps what Changes covers (⌃⌘C goes back to it), as the one pane view's does.
      if (current !== null && current.paneId === paneId) {
        pickTab(next);
        return;
      }
      const row = current === null ? null : findRow(hostsRef.current, current.hostId, paneId, { nowUnixMs: Date.now(), seenDone: {} });
      if (current === null || row === null) return;
      if (next === "changes") leaveChangesElsewhere(current.hostId, paneId);
      views.pick(current.hostId, row, next);
      setViewsVersion((n) => n + 1);
    },
    [views, pickTab, leaveChangesElsewhere],
  );

  const setMode = useCallback((mode: SidebarMode) => setFoldState((state) => ({ ...state, mode })), []);

  // Send to… (handoff): the open picker, its toast, and carrying out a pick.
  useEffect(() => handoffStore.setSeenDone(seenDone), [seenDone]);
  const picker = useSyncExternalStore(handoffStore.subscribe, () => handoffStore.picker());
  const handoffToast = useSyncExternalStore(handoffStore.subscribe, () => handoffStore.toast());
  const recents = useMemo(() => new HandoffRecents(localStore()), []);
  // The target pane shows in its view (Chat for an agent unless you picked Terminal there), with the message box up on a terminal.
  const openTarget = useCallback(
    (target: HandoffTarget) => {
      select(target.hostId, target.paneId);
      const view = views.view(target.hostId, { paneID: target.paneId, isAgent: target.isAgent, kind: target.kind });
      if (view === "terminal") setBoxShown(true);
      // Changes has no message box; the hand-off lands in Chat, where its draft shows.
      if (view === "changes") chooseTab("chat");
    },
    [select, views, chooseTab],
  );
  const closePicker = useCallback(() => handoffStore.closePicker(), []);
  const pick = useCallback(
    (target: HandoffTarget, action: HandoffAction) => {
      const request = handoffStore.picker();
      handoffStore.closePicker();
      if (request === null) return;
      void deliverHandoff(
        {
          store: handoffStore,
          drafts: composerDrafts,
          recents,
          copy: (text) => bridge.copyText(text),
          open: openTarget,
          // The main process's bound Send, with no pending bubble (a hand-off is not your message in that chat).
          send: (hostId, paneId, text, binding) => bridge.sendToPane(hostId, paneId, text, binding),
        },
        request.payload,
        target,
        action,
      );
    },
    [bridge, recents, openTarget],
  );
  useEffect(() => {
    if (handoffToast === null) return;
    const timer = setTimeout(() => handoffStore.dismissToast(handoffToast.id), handoffToastMs);
    return () => clearTimeout(timer);
  }, [handoffToast]);

  // Asked again with each snapshot: the pane's terminal may come or go.
  useEffect(() => {
    if (selection === null) {
      setGhostty(hidden);
      return;
    }
    let live = true;
    const keep = (value: GhosttyAvailability): void => {
      if (live) setGhostty((current) => (sameAvailability(current, value) ? current : value));
    };
    void bridge.ghosttyInfo(selection.hostId, selection.paneId).then(keep, () => keep(hidden));
    return () => {
      live = false;
    };
  }, [bridge, selection, hosts]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), noticeMs);
    return () => clearTimeout(timer);
  }, [notice]);

  // The update state; a download that finishes while the window is open says so once
  // (T3's desktopUpdate.toast.tsx), in the app's toast.
  const updateView = useSyncExternalStore(updateStore.subscribe, updateStore.view, updateStore.view);
  const shownPill = updateView === null ? null : updatePill(updateView);
  useEffect(() => {
    if (updateStore.takeToast()) setNotice(updateDownloadedToast);
  }, [updateView]);
  /** The pill's click (and Settings' Download and Restart…): nothing downloads or installs without one. */
  const updateAction = useCallback(
    (action: "download" | "install"): void => {
      if (action === "download") {
        void bridge.downloadUpdate?.().then(
          (done) => {
            const error = updateStore.view()?.error;
            if (!done && error?.during === "download") setNotice(`The update did not download: ${error.message}`);
          },
          (failure: unknown) => setNotice(`The update did not download: ${failureText(failure)}`),
        );
      } else {
        // Restart asks first (the main process's dialog); Cancel keeps the download for later.
        void bridge.installUpdate?.().catch((failure: unknown) => setNotice(`The update did not install: ${failureText(failure)}`));
      }
    },
    [bridge],
  );

  const openInGhostty = useCallback(
    (hostId: string, paneId: string) => {
      void bridge.openInGhostty(hostId, paneId).then(
        (reason) => setNotice(reason === null ? null : `Not opened in Ghostty: ${reason}`),
        () => setNotice("Not opened in Ghostty."),
      );
    },
    [bridge],
  );

  // A row's menu: Open in Ghostty, shown only where Ghostty is installed (never on Windows); Close pane
  // on every row (greyed, with the reason, while its machine does not answer).
  const openRowMenu = useCallback(
    async (hostId: string, paneId: string, x: number, y: number): Promise<void> => {
      // What it is about, taken before Ghostty's availability is read.
      const kept = paneContextOf(hostId, paneId);
      if (kept === null) return;
      let availability: GhosttyAvailability;
      try {
        availability = await bridge.ghosttyInfo(hostId, paneId);
      } catch {
        availability = hidden;
      }
      const host = hostsRef.current.find((candidate) => candidate.id === hostId);
      if (host === undefined || findRow(hostsRef.current, hostId, paneId, { nowUnixMs: Date.now(), seenDone: {} }) === null) return;
      const offline = host.state === "connected" ? null : notAnswering(host.name);
      const items: MenuItem[] = [];
      if (availability.shown) {
        items.push({
          label: "Open in Ghostty",
          disabledReason: availability.enabled ? null : availability.reason,
          onSelect: () => openInGhostty(hostId, paneId),
        });
      }
      items.push({ label: "Rename…", disabledReason: offline, onSelect: () => beginPaneRename(hostId, kept) });
      items.push({ label: "Close pane", disabledReason: offline, onSelect: () => askClosePane(hostId, kept) });
      setRowMenu({ x, y, items });
    },
    [bridge, openInGhostty, askClosePane, beginPaneRename, paneContextOf],
  );
  const closeRowMenu = useCallback(() => setRowMenu(null), []);

  // A machine header's menu: Edit machine… for a saved SSH machine (a demo machine has none).
  const openHostMenu = useCallback(
    (hostId: string, x: number, y: number) => {
      if (hostsRef.current.find((host) => host.id === hostId)?.kind !== "ssh") return;
      setRowMenu({
        x,
        y,
        items: [
          {
            label: "Edit machine…",
            onSelect: () =>
              void bridge.hostSettings(hostId).then(
                (settings) => {
                  if (settings !== null) setHostDialog({ editing: settings });
                },
                (error: unknown) =>
                  setNotice(
                    `That machine could not be opened for editing: ${(error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`,
                  ),
              ),
          },
        ],
      });
    },
    [bridge],
  );

  // New agent: ⌘N and the sidebar's row open it for the selected pane's workspace, a header's + and its menu for that one.
  const newAgentPlacesNow = useMemo(() => newAgentPlaces(hosts ?? []), [hosts]);
  const openNewAgent = useCallback(
    (wanted: { hostId: string; workspaceId: string } | null, folder?: string, exact = false) => {
      setRowMenu(null);
      // Where can split the pane shown (when the dialog's workspace is its own).
      const current = selectionRef.current;
      const target = current === null ? null : splitTargetOf(current.hostId, current.paneId);
      if (wanted !== null) {
        setNewAgent({ wanted, target, ...(folder === undefined ? {} : { folder }), ...(exact ? { exact } : {}) });
        return;
      }
      setNewAgent({ wanted: target === null ? null : { hostId: target.hostId, workspaceId: target.workspaceId }, target });
    },
    [splitTargetOf],
  );
  // New workspace: the sidebar's row, ⇧⌘N and the File menu open it on the selected pane's machine,
  // once (on the Mac the menu and the key may both come); made, its shell pane is selected.
  const newWorkspaceMachinesNow = useMemo(() => newWorkspaceMachines(hosts ?? []), [hosts]);
  // The folder field's list (any machine) and Choose… (This Mac), when the bridge has them.
  const folderCalls = useMemo((): FolderCalls | null => {
    const browseFolder = bridge.browseFolder;
    if (browseFolder === undefined) return null;
    const pickFolder = bridge.pickFolder;
    return {
      browse: (hostId, directory) => browseFolder.call(bridge, hostId, directory),
      ...(pickFolder === undefined ? {} : { pick: (hostId: string, typed: string) => pickFolder.call(bridge, hostId, typed) }),
    };
  }, [bridge]);
  const openNewWorkspace = useCallback((hostId: string | null = null, folder?: string) => {
    setRowMenu(null);
    setNewWorkspace((open) => open ?? { wanted: hostId ?? selectionRef.current?.hostId ?? null, ...(folder === undefined ? {} : { folder }) });
  }, []);
  const workspaceMade = useCallback(
    (hostId: string, result: NewWorkspaceResult) => {
      setNewWorkspace(null);
      select(hostId, result.paneId);
      const hostName = hostsRef.current.find((host) => host.id === hostId)?.name ?? hostId;
      setMade({ hostId, hostName, workspaceId: result.workspaceId, label: result.label, folder: result.folder, elsewhere: result.elsewhere ?? null });
    },
    [select],
  );
  // A tile's split menu (and the one pane's header): Split right / down (a shell), or New agent there; refused at 4.
  const openSplitMenu = useCallback(
    (paneId: string, x: number, y: number) => {
      const current = selectionRef.current;
      const target = current === null ? null : splitTargetOf(current.hostId, paneId);
      if (current === null || target === null) return;
      const refusal = splitRefusal(target.tabPanes);
      const hostId = current.hostId;
      const newAgentThere = (where: NewAgentWhereChoice) => {
        setRowMenu(null);
        setNewAgent({ wanted: { hostId, workspaceId: target.workspaceId }, where, target });
      };
      setRowMenu({
        x,
        y,
        items: [
          // Bound to the pane as it was when the menu opened.
          { label: "Split right", disabledReason: refusal, onSelect: () => void paneAction(hostId, { type: "split", paneId, direction: "right", binding: target.binding }) },
          { label: "Split down", disabledReason: refusal, onSelect: () => void paneAction(hostId, { type: "split", paneId, direction: "down", binding: target.binding }) },
          { label: "New agent to the right…", disabledReason: refusal, onSelect: () => newAgentThere("right") },
          { label: "New agent below…", disabledReason: refusal, onSelect: () => newAgentThere("down") },
        ],
      });
    },
    [splitTargetOf, paneAction],
  );
  const openWorkspaceMenu = useCallback(
    (hostId: string, workspaceId: string, x: number, y: number) => {
      const host = hostsRef.current?.find((candidate) => candidate.id === hostId);
      const kept = workspaceContextOf(hostId, workspaceId);
      setRowMenu({
        x,
        y,
        items: [
          {
            label: "New agent here",
            disabledReason: host?.state === "connected" ? null : `${host?.name ?? "The machine"} is not answering`,
            onSelect: () => openNewAgent({ hostId, workspaceId }),
          },
          // The header's inline rename.
          {
            label: "Rename workspace…",
            disabledReason: host?.state === "connected" ? null : notAnswering(host?.name ?? "The machine"),
            onSelect: () => beginWorkspaceRename(hostId, kept),
          },
        ],
      });
    },
    [openNewAgent, beginWorkspaceRename, workspaceContextOf],
  );

  // Commands from the main process (the capture flag drives the window this way).
  const commandHandler = useRef<(command: AppCommand) => void>(() => undefined);
  commandHandler.current = (command: AppCommand) => {
    // A command drives the window as a click would: a row's open menu closes (opening one excepted).
    if (command.type !== "open-row-menu" && command.type !== "open-split-menu") setRowMenu(null);
    switch (command.type) {
      case "select-pane":
        select(command.hostId, command.paneId);
        break;
      case "clear-selection":
        show(null);
        break;
      case "set-mode":
        setMode(command.mode);
        break;
      case "set-tab":
        pickTab(command.tab);
        break;
      case "set-changes-overview":
        setOverviewShown(command.shown);
        if (command.shown) {
          setAwayOpen(false);
          setSearchOpen(false);
        }
        break;
      case "open-changes-row": {
        // As a click on the row would, once the read has drawn it.
        void waitForElement(`[data-item="${CSS.escape(command.rowId)}"]`, 5_000)
          .then((row) => row?.click())
          .then(afterPaint)
          .then(() => bridge.appCommandDone(command.id));
        return;
      }
      case "set-host-folded":
        setHostFolded(command.hostId, command.folded);
        break;
      case "set-box":
        setBoxShown(command.shown);
        break;
      case "show-away":
        setAwayOpen(command.shown);
        if (command.shown) {
          setOverviewShown(false);
          setSearchOpen(false);
        }
        break;
      case "search":
        if (command.query === null) setSearchOpen(false);
        else openConversations(command.query);
        break;
      case "search-open-first": {
        const request = selectedRequest(searchState.groups, null);
        if (request !== null) openResult(request);
        break;
      }
      case "open-row-menu": {
        // At the row, as a right-click there would open it.
        const row = document.querySelector(`[data-row="${CSS.escape(rowKey(command.hostId, command.paneId))}"]`);
        const box = row?.getBoundingClientRect();
        const opened = box === undefined ? Promise.resolve() : openRowMenu(command.hostId, command.paneId, box.left + box.width * 0.4, box.top + box.height * 0.7);
        void opened.then(afterPaint).then(() => bridge.appCommandDone(command.id));
        return;
      }
      case "attach-files": {
        if (selection === null) break;
        const sources = command.files.map((file) => {
          const data = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
          return { name: file.name, type: file.type, size: data.byteLength, bytes: async () => data };
        });
        void attachSources(draftKey(selection.hostId, selection.paneId), sources)
          .then(afterPaint)
          .then(() => bridge.appCommandDone(command.id));
        return;
      }
      case "click": {
        const target = document.querySelector(command.selector);
        if (target instanceof HTMLElement) target.click();
        break;
      }
      case "terminal-select":
        selectInTerminal(command.selector, command.from, command.to ?? null, command.clicks ?? 1);
        break;
      case "open-handoff": {
        const host = hostsRef.current.find((candidate) => candidate.id === command.hostId);
        const row = findRow(hostsRef.current, command.hostId, command.paneId, { nowUnixMs: Date.now(), seenDone });
        if (host !== undefined && row !== null) {
          const source = { hostId: host.id, paneId: row.paneID, name: row.name, kind: row.kind, workspace: row.workspaceLabel, macName: host.name };
          handoffStore.openPicker({ text: command.text, kind: { type: "reply" }, source }, Math.round(window.innerWidth * 0.42), 150);
        }
        break;
      }
      case "pick-handoff": {
        const request = handoffStore.picker();
        const current = request === null ? null : { hostId: request.payload.source.hostId, paneId: request.payload.source.paneId };
        const target = listRows(handoffList(handoffStore.macs(), current, [], "")).find(
          (candidate) => candidate.hostId === command.hostId && candidate.paneId === command.paneId,
        );
        if (target !== undefined) pick(target, command.action);
        void wait(400).then(afterPaint).then(() => bridge.appCommandDone(command.id));
        return;
      }
      case "open-new-agent":
        if (command.where !== undefined && command.hostId !== null && command.workspaceId !== null) {
          // As the split menu's New agent to the right… / below… opens it beside that pane.
          setNewAgent({ wanted: { hostId: command.hostId, workspaceId: command.workspaceId }, where: command.where.direction, target: splitTargetOf(command.hostId, command.where.paneId) });
          break;
        }
        openNewAgent(command.hostId === null || command.workspaceId === null ? null : { hostId: command.hostId, workspaceId: command.workspaceId });
        break;
      case "open-new-workspace":
        openNewWorkspace(command.hostId, command.folder);
        break;
      case "create-workspace": {
        // As the dialog's Return would: on the connection the window shows now.
        setNewWorkspace(null);
        const machine = newWorkspaceMachines(hostsRef.current).find((candidate) => candidate.hostId === command.hostId);
        const made =
          machine === undefined
            ? Promise.reject(new Error("that machine is not answering"))
            : bridge
                .newWorkspace(command.hostId, { folder: command.folder, name: command.name ?? defaultWorkspaceName(command.folder), binding: machine.binding })
                .then((result) => workspaceMade(command.hostId, result));
        void made
          .catch((failure: unknown) => setNotice(`Not created: ${String(failure)}`))
          .then(() => wait(600))
          .then(afterPaint)
          .then(() => bridge.appCommandDone(command.id));
        return;
      }
      case "zoom-pane": {
        // As the tile's zoom button: its press focuses the tile, its click zooms; the layout comes back from Herdr.
        if (command.zoomed) show({ hostId: command.hostId, paneId: command.paneId });
        const binding = bindingFor(command.hostId, command.paneId);
        void (binding === null ? Promise.resolve(null) : paneAction(command.hostId, { type: "zoom", paneId: command.paneId, zoomed: command.zoomed, binding }))
          .then(() => wait(500))
          .then(afterPaint)
          .then(() => bridge.appCommandDone(command.id));
        return;
      }
      case "open-split-menu": {
        // Under the pane's split button (its tile's header, or the one pane's header), as a click there opens it.
        const tile = document.querySelector(`[data-tile="${CSS.escape(command.paneId)}"]`);
        const button = tile === null ? document.querySelector('.main button[aria-label="Split"]') : tile.querySelector('button[aria-label^="Split "]');
        const box = button?.getBoundingClientRect();
        if (box !== undefined) openSplitMenu(command.paneId, box.left, box.bottom + 4);
        break;
      }
      case "open-workspace-menu": {
        const header = document.querySelector(`[data-host="${CSS.escape(command.hostId)}"] [data-ws="${CSS.escape(command.workspaceId)}"]`);
        const box = header?.getBoundingClientRect();
        if (box !== undefined) openWorkspaceMenu(command.hostId, command.workspaceId, box.left + box.width * 0.35, box.top + box.height * 0.7);
        break;
      }
      case "rename-pane":
        beginPaneRename(command.hostId, paneContextOf(command.hostId, command.paneId));
        break;
      case "rename-workspace":
        beginWorkspaceRename(command.hostId, workspaceContextOf(command.hostId, command.workspaceId));
        break;
      // The menu's Settings… (a toggle, as ⌘,; it waits while a rename field is open, as the menu's
      // other commands do), and the captures' open at a section or close.
      case "settings":
        if (command.open === "toggle") {
          if (!keyOwners.any()) toggleSettings("menu");
        } else if (command.open) openSettings(command.section);
        else closeSettings(true);
        break;
      case "start-new-agent": {
        setNewAgent(null);
        const started = bridge
          .newAgent(command.hostId, { workspaceId: command.workspaceId, folder: command.folder, kind: command.kind })
          .then((result) => select(command.hostId, result.paneId))
          .catch((failure: unknown) => setNotice(`Not started: ${String(failure)}`));
        void started.then(() => wait(600)).then(afterPaint).then(() => bridge.appCommandDone(command.id));
        return;
      }
    }
    void afterPaint().then(() => bridge.appCommandDone(command.id));
  };
  useEffect(() => bridge.onAppCommand((command) => commandHandler.current(command)), [bridge]);

  const ready = useRef(false);
  useEffect(() => {
    if (ready.current || hosts === null || info === null) return;
    ready.current = true;
    void document.fonts.ready.then(afterPaint).then(() => bridge.appCommandDone(RENDERER_READY));
  }, [hosts, info, bridge]);

  // ⌘J (Ctrl+J): the open pane's terminal drawer; ⇧⌘J (Ctrl+Shift+J): the next pane needing you. ⌘F (Ctrl+F): search. ⇧⌘F (Ctrl+Shift+F): search conversations. ⌘N (Ctrl+N): New agent.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // An open rename field owns every key (none taken here, so it gets them all).
      if (keyOwners.any()) return;
      // ⌘, (Ctrl+,): Settings, and again back to the pane (taken before the terminal sees it).
      if (isSettingsShortcut(event, info?.platform === "darwin")) {
        event.preventDefault();
        event.stopPropagation();
        toggleSettings("key");
        return;
      }
      // While tiles show: ⌘1–⌘4 a tile by its place, ⌃⌘ arrows the neighbouring one (taken before the terminal sees them;
      // not while Settings covers them).
      const shown = settingsRef.current === null ? tilesRef.current : null;
      const tileKey = shown === null ? null : tileShortcut(event, info?.platform === "darwin");
      if (shown !== null && tileKey !== null) {
        const target = tileKey.type === "tile" ? (shown.tiles[tileKey.index]?.paneId ?? null) : neighbourTile(shown.tiles, shown.focusedPaneId, tileKey.direction);
        if (tileKey.type === "tile" && target === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (target !== null) focusTile(target, true);
        return;
      }
      const shortcut = appShortcut(event, info?.platform === "darwin");
      if (shortcut === null) return;
      // Taken here, before the terminal sees it (ghostty-web's encoder ignores defaultPrevented,
      // so ⇧⌘N typed n and Ctrl+Shift+N sent Ctrl+N), as the tile keys above are.
      event.preventDefault();
      event.stopPropagation();
      if (shortcut === "nextNeedsYou") {
        const next = nextNeedsYou(sidebar, selectedKey);
        if (next !== null) select(next.hostId, next.row.paneID);
      } else if (shortcut === "toggleTerminal") {
        // The open pane's terminal drawer (once, with View › Terminal's same press).
        if (drawerGate.take("key", Date.now())) toggleDrawer();
      } else if (shortcut === "search") {
        setSearch((current) => current ?? "");
      } else if (shortcut === "searchConversations") {
        openConversations(null);
      } else if (shortcut === "newWorkspace") {
        openNewWorkspace();
      } else {
        openNewAgent(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [info, sidebar, selectedKey, select, openNewAgent, openNewWorkspace, openConversations, focusTile, toggleSettings, toggleDrawer, drawerGate]);

  viewHandler.current = (command: ViewCommand) => {
    // The native menu's commands wait while a rename field is open.
    if (keyOwners.any()) return;
    if (command === "new-workspace") openNewWorkspace();
    else if (command === "toggle-box") setBoxShown((shown) => !shown);
    // View › Terminal (⌘J), the open pane's terminal drawer.
    else if (command === "toggle-terminal") {
      if (drawerGate.take("menu", Date.now())) toggleDrawer();
    }
    // The View menu's While You Were Away and What Each Agent Changed.
    else if (command === "open-away") {
      setOverviewShown(false);
      setSearchOpen(false);
      setAwayOpen(true);
    } else if (command === "open-changes") {
      setAwayOpen(false);
      setSearchOpen(false);
      setOverviewShown(true);
    }
    else if (command === "toggle-changes") {
      if (overviewShown || awayOpen || searchOpen || selectedRow === null) return;
      const next = changesToggled(tab, selectedRow.isAgent, changesCovered);
      if (next !== null) pickTab(next);
    } else setFontSize((size) => nextFontSize(size, command));
  };

  // Each text field taking the focus (the terminal, the Composer) is where a rename
  // field gives the keyboard back after Return or Esc.
  useEffect(() => {
    const noted = (event: FocusEvent): void => focusReturn.noted(event.target);
    window.addEventListener("focusin", noted, true);
    return () => window.removeEventListener("focusin", noted, true);
  }, []);

  // Escape leaves the away screen and the search screen (there it is not Stop).
  useEscapeOwner(awayOpen || searchOpen);
  useEffect(() => {
    if (!awayOpen && !searchOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setAwayOpen(false);
      setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [awayOpen, searchOpen]);

  // ⌘J acts only while the main area shows a pane (not a screen over it: Changes,
  // away, search, New agent, or Settings, whose page hides the pane and its drawer until it closes).
  mainShowsPane.current = !overviewShown && !awayOpen && !searchOpen && made === null && settings === null;

  if (hosts === null || info === null) return <div className="app" />;

  /** A shell of the agent pane's drawer needs you (an agent started in it is blocked); the sidebar leaves it out. */
  const drawerNeedsYou = (host: HostView, ownerPaneId: string): boolean =>
    drawers
      .state(host.id, ownerPaneId)
      .shells.some((shell) => drawerShellBelongs(ownerPaneId, shell.paneId, host.topology) && findRow(hosts, host.id, shell.paneId, { nowUnixMs: now, seenDone })?.glyph === "needsYou");
  /** An agent pane's terminal drawer as its pane (or the split) shows it; none for a shell. */
  const drawerViewFor = (host: HostView, row: SidebarRow): DrawerView | null => {
    if (!row.isAgent) return null;
    const key = `${host.id}|${row.paneID}`;
    const state = drawers.state(host.id, row.paneID);
    const shown = selection !== null && selection.hostId === host.id && selection.paneId === row.paneID;
    // A saved shell that is the agent's own pane or another workspace's is never shown
    // (pruned once its machine answers; hidden until then).
    const shells = state.shells.filter((shell) => drawerShellBelongs(row.paneID, shell.paneId, host.topology));
    // Named by the drawer's order; a shell that needs you (an agent started in it, blocked) is out of the
    // sidebar, so its tab and the drawer button show a dot.
    const shellViews = shells.map((shell, index) => {
      const shellRow = findRow(hosts, host.id, shell.paneId, { nowUnixMs: now, seenDone });
      return { paneId: shell.paneId, row: shellRow, label: drawerShellLabel(index), needsYou: shellRow?.glyph === "needsYou" };
    });
    return {
      state,
      shells: shellViews,
      needsYou: shellViews.some((shell) => shell.needsYou),
      opening: drawerOpening.has(key),
      note: drawerNotes[key] ?? null,
      folder: drawerFolderOf(host, row),
      wantsKeys: shown && drawerKeys.wants,
      focusSignal: drawerKeys.signal,
      onToggle: () => toggleDrawer(row.paneID),
      onNewShell: () => newDrawerShell(host.id, row.paneID),
      onCloseShell: (paneId) => closeDrawerShell(host.id, row.paneID, paneId),
      onSelectShell: (paneId) => selectDrawerShell(host.id, row.paneID, paneId),
      onHeight: (height) => drawers.setHeight(host.id, row.paneID, height),
      onEscape: restoreDrawerFocus,
      onDismissNote: () => setDrawerNote(key, null),
    };
  };
  // The agents whose update is ready (UpdateMark), listed in Settings › Updates.
  const updateReady: UpdateReadyPane[] = settings !== "updates" ? [] : updateReadyPanes(hosts);

  return (
    <div className={settings === null ? "app" : "app settings-open"}>
      <Sidebar
        sidebar={sidebar}
        selectedKey={selectedKey}
        shownKeys={shownKeys}
        search={search}
        demo={info.demo}
        foldedHosts={foldedHosts}
        needsPills={needsPills}
        onSelect={select}
        onRowMenu={(hostId, paneId, x, y) => void openRowMenu(hostId, paneId, x, y)}
        onToggleHost={(hostId) => setHostFolded(hostId, !foldedHosts.has(hostId))}
        onHostMenu={openHostMenu}
        onRetryHost={(hostId) => void bridge.retryHost(hostId).then(receiveHosts, () => undefined)}
        onMode={setMode}
        onToggleWorkspace={(hostId, workspaceId) => setFoldState((state) => fold.toggleWorkspace(state, workspaceId, hostId))}
        onToggleExpanded={(hostId, workspaceId) => setFoldState((state) => fold.toggleExpanded(state, workspaceId, hostId))}
        onToggleSection={(kind: SidebarPrioritySectionKind) => setFoldState((state) => fold.toggleSection(state, kind))}
        onSearch={setSearch}
        onAddHost={() => setHostDialog({ editing: null })}
        onOpenSettings={() => toggleSettings("button")}
        settingsOpen={settings !== null}
        settingsKey={settingsKey(info.platform === "darwin")}
        updatePill={shownPill === null ? null : <UpdatePill pill={shownPill} onAction={updateAction} />}
        onNewAgent={openNewAgent}
        onWorkspaceMenu={openWorkspaceMenu}
        newAgentKey={info.platform === "darwin" ? "⌘N" : "Ctrl+N"}
        onNewWorkspace={() => openNewWorkspace()}
        newWorkspaceKey={info.platform === "darwin" ? "⇧⌘N" : "Ctrl+Shift+N"}
        renaming={
          renaming === null
            ? null
            : { key: renaming.key, initial: renaming.initial, ...(renaming.kind === "pane" && renaming.target === "tab" ? { target: "tab" as const } : {}) }
        }
        onRenameSave={saveRename}
        onRenameCancel={cancelRename}
        top={
          search === null ? null : (
            <button className={searchOpen ? "search-all on" : "search-all"} onClick={() => openConversations(isTooShort(search) ? null : search.trim())}>
              {searchAllText(search)}
            </button>
          )
        }
      />
      {overviewShown ? (
        <ChangesOverview bridge={bridge} hosts={hosts} onOpenAgent={openAgentChanges} onClose={() => setOverviewShown(false)} />
      ) : awayOpen ? (
        <AwayScreen
          state={away}
          now={now / 1000}
          onClose={() => setAwayOpen(false)}
          onOpenCard={(card) => {
            openInChat(card.macID, card.paneID);
            revealRequests.ask(card.macID, card.paneID, card.firstNewItemID);
          }}
          onMarkSeen={() => bridge.awayMarkSeen()}
          onShown={awayShown}
        />
      ) : searchOpen ? (
        <SearchScreen
          bridge={bridge}
          state={searchState}
          query={conversationQuery}
          now={now / 1000}
          onQuery={setConversationQuery}
          onOpen={openResult}
          onClose={() => setSearchOpen(false)}
        />
      ) : made !== null ? (
        <NewWorkspaceReady
          hostName={made.hostName}
          label={made.label}
          folder={made.folder}
          elsewhere={made.elsewhere}
          present={newAgentPlacesNow.some((place) => place.hostId === made.hostId && place.workspaceId === made.workspaceId)}
          onStartAgent={() => {
            // That exact machine and workspace, as New agent can start there now.
            if (!newAgentPlaces(hostsRef.current).some((place) => place.hostId === made.hostId && place.workspaceId === made.workspaceId)) {
              setNotice(`Not started: ${made.label} is not available on ${made.hostName} now.`);
              return;
            }
            openNewAgent({ hostId: made.hostId, workspaceId: made.workspaceId }, made.folder, true);
          }}
          onOpenShell={() => setMade(null)}
        />
      ) : selectedHost !== null && selectedRow !== null && tiles !== null ? (
        <SplitView
          host={selectedHost}
          title={tabTitle(selectedHost, selectedRow)}
          tiles={oneChangesTile(
            tiles.tiles.map((tile): TileEntry => {
              const row = findRow(hosts, selectedHost.id, tile.paneId, { nowUnixMs: now, seenDone });
              return {
                paneId: tile.paneId,
                index: tile.index,
                frame: tile.frame,
                row,
                view: row === null ? "terminal" : views.view(selectedHost.id, row),
                drawerOpen: row !== null && row.isAgent && drawers.state(selectedHost.id, row.paneID).open,
                drawerNeedsYou: row !== null && row.isAgent && drawerNeedsYou(selectedHost, row.paneID),
              };
            }),
            tiles.focusedPaneId,
          )}
          layout={shownLayout!}
          dividers={tiles.dividers}
          focusedPaneId={tiles.focusedPaneId}
          focusSignal={tileKeys}
          mac={info.platform === "darwin"}
          fontSize={fontSize}
          boxShown={boxShown}
          onBoxShown={setBoxShown}
          onFocus={focusTile}
          onView={chooseTileView}
          onZoom={(paneId) => zoomPane(paneId, true)}
          onClose={askClose}
          onSplitMenu={openSplitMenu}
          onResizing={resizing}
          onResize={resized}
          onResizeCancel={resizeCancelled}
          drawer={drawerViewFor(selectedHost, selectedRow)}
          onToggleDrawer={toggleDrawer}
        />
      ) : selectedHost !== null && selectedRow !== null ? (
        <MainPane
          host={selectedHost}
          row={selectedRow}
          tab={tab}
          onTab={pickTab}
          mac={info.platform === "darwin"}
          fontSize={fontSize}
          boxShown={boxShown}
          onBoxShown={setBoxShown}
          ghostty={ghostty}
          onOpenInGhostty={() => openInGhostty(selectedHost.id, selectedRow.paneID)}
          zoomed={decision?.kind === "single" && decision.zoomed}
          note={decision?.kind === "single" ? decision.note : null}
          onSplitMenu={(x, y) => openSplitMenu(selectedRow.paneID, x, y)}
          onUnzoom={() => zoomPane(selectedRow.paneID, false)}
          menuContext={() => paneContextOf(selectedHost.id, selectedRow.paneID)}
          onClose={(kept) => askClosePane(selectedHost.id, kept === undefined ? paneContextOf(selectedHost.id, selectedRow.paneID) : kept)}
          onRename={(kept) => beginPaneRename(selectedHost.id, kept === undefined ? paneContextOf(selectedHost.id, selectedRow.paneID) : kept)}
          drawer={drawerViewFor(selectedHost, selectedRow)}
        />
      ) : (
        <EmptyState needsYou={sidebar.badge} hosts={hosts.length} />
      )}
      {settings === null ? null : (
        <SettingsPage
          bridge={bridge}
          info={info}
          hosts={hosts}
          section={settings}
          onSection={(section) => {
            settingsSection.current = section;
            setSettings(section);
          }}
          onClose={() => closeSettings(true)}
          covered={hostDialog !== null || rowMenu !== null || picker !== null || newAgent !== null || newWorkspace !== null || closing !== null}
          fontSize={fontSize}
          onFontCommand={(command) => setFontSize((size) => nextFontSize(size, command))}
          onAddMachine={() => setHostDialog({ editing: null })}
          onEditMachine={(hostId) =>
            void bridge.hostSettings(hostId).then(
              (editing) => {
                if (editing !== null) setHostDialog({ editing });
              },
              (error: unknown) => setNotice(`That machine could not be opened for editing: ${failureText(error)}`),
            )
          }
          onRemoveMachine={(hostId) =>
            bridge.removeHost(hostId).then(receiveHosts, (error: unknown) => setNotice(`Not removed: ${failureText(error)}`))
          }
          updateReady={updateReady}
          onOpenPane={select}
          update={updateView}
          onUpdateAction={updateAction}
        />
      )}
      {rowMenu === null ? null : <ContextMenu x={rowMenu.x} y={rowMenu.y} items={rowMenu.items} onClose={closeRowMenu} />}
      {picker === null ? null : (
        <HandoffPickerView
          key={picker.id}
          request={picker}
          store={handoffStore}
          recents={recents.list()}
          mac={info.platform === "darwin"}
          onPick={pick}
          onCopy={(text) => bridge.copyText(text)}
          onClose={closePicker}
        />
      )}
      {handoffToast === null ? null : (
        <HandoffToastView
          text={handoffToast.text}
          onOpen={
            handoffToast.target === null || findRow(hosts, handoffToast.target.hostId, handoffToast.target.paneId, { nowUnixMs: now, seenDone }) === null
              ? null
              : () => {
                  const target = handoffToast.target!;
                  handoffStore.dismissToast();
                  openTarget(target);
                }
          }
          onClose={() => handoffStore.dismissToast()}
        />
      )}
      {notice === null ? null : (
        <div className="app-toast" role="status" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {newAgent === null ? null : (
        <NewAgentDialog
          places={newAgentPlacesNow}
          wanted={newAgent.wanted}
          storage={localStore()}
          splitTarget={newAgent.target ?? null}
          initialWhere={newAgent.where ?? "tab"}
          {...(newAgent.folder === undefined ? {} : { initialFolder: newAgent.folder })}
          {...(newAgent.exact === true ? { exact: true } : {})}
          folders={folderCalls}
          start={(place, folder, kind, where, models) =>
            bridge.newAgent(place.hostId, {
              workspaceId: place.workspaceId,
              folder,
              kind,
              ...(where.type === "split" ? { where } : {}),
              // New agent's Model and Effort (none: the agent's defaults, no flag).
              ...(models === undefined || (models.model === null && models.effort === null) ? {} : { model: models.model, effort: models.effort }),
            })
          }
          onStarted={(place, result) => {
            setNewAgent(null);
            // Its view by its kind: Chat for an agent that answered, the terminal for a shell (or a command no agent came from).
            select(place.hostId, result.paneId);
            if (result.summary !== null) setNotice(result.summary);
          }}
          onClose={() => setNewAgent(null)}
        />
      )}
      {newWorkspace === null ? null : (
        <NewWorkspaceDialog
          machines={newWorkspaceMachinesNow}
          hosts={hosts}
          wanted={newWorkspace.wanted}
          {...(newWorkspace.folder === undefined ? {} : { initialFolder: newWorkspace.folder })}
          folders={folderCalls}
          create={(machine, request) => bridge.newWorkspace(machine.hostId, request)}
          onCreated={(machine, result) => workspaceMade(machine.hostId, result)}
          onClose={() => setNewWorkspace(null)}
        />
      )}
      {closing === null ? null : (
        <ConfirmClose
          name={closing.name}
          {...(closing.body === undefined ? {} : { body: closing.body })}
          onConfirm={() => {
            setClosing(null);
            // The binding taken when Close was pressed: refused if the pane changed while you were asked.
            if (closing.drawerOwner !== undefined) closeShellNow(closing.hostId, closing.drawerOwner, closing.paneId, closing.binding, closing.from, true);
            else closePane(closing.hostId, closing.paneId, closing.binding, closing.from);
          }}
          onCancel={() => setClosing(null)}
        />
      )}
      {hostDialog === null ? null : (
        <AddHostDialog
          editing={hostDialog.editing}
          passwordStorage={info.passwordStorage}
          onClose={() => setHostDialog(null)}
          onSaved={(next) => {
            receiveHosts(next);
            setHostDialog(null);
          }}
        />
      )}
      {/* A machine's new host key, asked about one machine at a time (never over Add or Edit); one dialog per question (keyed by its id). */}
      {hostDialog !== null || askingHost === undefined || askingHost.hostKey === undefined ? null : (
        <HostKeyDialog
          key={askingHost.hostKey.id}
          hostId={askingHost.id}
          name={askingHost.name}
          question={askingHost.hostKey}
          onAnswered={receiveHosts}
        />
      )}
    </div>
  );
}
