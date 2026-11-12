// Chat for each window: one ChatFeed (src/shared/chat/feed.ts) following the
// pane the window shows (one per tile on screen when it shows a tab's split
// panes, each in its own slot), over that machine's transcript reader (SFTP for an SSH
// machine, memory for a demo one). The session comes from the latest snapshot
// (Herdr's agent_session, else a Claude pane's folder: locator.sessionForPane)
// and is looked at again on every snapshot, so a session Herdr names later is
// picked up, and a pane that stops being an agent's ends its chat. Every change
// goes to the page as one update: the state and the whole timeline. A feed that
// became unavailable (no transcript yet: a new Claude session writes it only
// after its first message) is retried on later snapshots, at most once per
// interval, doubling up to a cap, still showing why until it loads
// (ChatFeed.swift retries after unavailable too).
//
// A pane switch shows its Chat at once. A window
// that moves to another pane (or closes) keeps its feed paused on a shelf
// shared by the windows (the last seven, 24 MB of timelines: with the one on
// show, eight panes); opening that pane again takes it back, shows what it
// held at once and reads on from its offset. Feeds load cold (the end, then
// earlier only to a screenful of turns plus one). Panes the sidebar shows
// working or just finished are warmed beside the shelf (two at most, so they
// never push out a pane the user opened), their reads one at a time per machine.

import { maxUploadBytes } from "../../shared/attachments";
import { AgentSettingsReader, grokFilesOf, tapReader, type GrokFiles, type PaneSettings, type SettingsScope } from "../../shared/agent-settings";
import type { ContextLimits } from "../../shared/context-meter";
import { ContextSettings } from "./context-settings";
import type { ChatUpdateEvent, ChatViewState } from "../../shared/ipc-contract";
import { ChatFeed, standardColdLoad, type ChatFeedOptions, type ChatFeedUpdate } from "../../shared/chat/feed";
import { approximateBytes, ChatShelf, ChatWarmGate, WarmingReader, warmLimit, warmPlan } from "../../shared/chat/shelf";
import {
  chatSessionKey,
  excludingGrokSessions,
  folderFormats,
  grokSessionIDOf,
  isGrokSessionID,
  paneSession,
  sessionRefFromAgentSession,
  type TranscriptSessionRef,
} from "../../shared/chat/locator";
import { geminiFamilyAmbiguousReason, isGeminiFamilyFormat } from "../../shared/chat/agents/gemini-family";
import { isCursorStorePath } from "../../shared/chat/cursor-store";
import { isPiFormat, piAmbiguousReason } from "../../shared/chat/agents/pi-locator";
import { isOpenCodeFormat, openCodeAmbiguousReason } from "../../shared/chat/agents/opencode-locate";
import { copilotAmbiguousReason } from "../../shared/chat/agents/copilot-locate";
import { droidAmbiguousReason } from "../../shared/chat/agents/droid-locate";
import { isMakiSessionPath, makiSessionIDOfPath } from "../../shared/chat/agents/maki-session";
import { clineAmbiguousReason } from "../../shared/chat/agents/cline-locate";
import { kiroAmbiguousReason } from "../../shared/chat/agents/kiro-locate";
import { isStoreAgentFormat } from "../../shared/chat/agents/store-agents";
import { chatReads } from "../../shared/chat/kinds";
import type { FollowedSession } from "../../shared/pane-life";
import { isCoreID } from "../../shared/core-ids";
import { emptyTimeline, withoutFullDiffs, type ChatAttachment, type ChatImageBlob, type ChatTimeline } from "../../shared/chat/model";
import type { HerdrHostBackend } from "../herdr/backend";
import { isAgentPane, type AgentInfo, type TopologyPaneInfo } from "../herdr/wire";

/** What the service reads from the machines in the sidebar. */
export interface ChatHosts {
  backend(hostId: string): HerdrHostBackend | null;
  pane(hostId: string, paneId: string): TopologyPaneInfo | null;
  agent(hostId: string, paneId: string): AgentInfo | null;
  /** The machine's connection while it answers (a reconnect reads the user's settings again); absent: one connection. */
  connection?(hostId: string): number | null;
  /** The agent panes the sidebar lists, in its order (the ones to warm come from these). */
  agentPanes?(): readonly { readonly hostId: string; readonly paneId: string }[];
  /** The agent panes of one machine's last snapshot (two Grok panes in one folder are refused); absent: none. */
  hostAgentPanes?(hostId: string): readonly string[];
}

/** The launch cache as Chat uses it. */
export interface ChatLaunchCache {
  /** The pane's cached chat (its newest items), or null. */
  chat(hostId: string, paneId: string): ChatTimeline | null;
  /** The machine shows its cached topology, no snapshot yet. */
  catchingUp(hostId: string): boolean;
  /** A live timeline on show (kept by reference; written later). */
  noteChat(hostId: string, paneId: string, timeline: ChatTimeline): void;
}

/** A feed and what it last said, shown in a window, kept paused on the shelf, or warming. */
interface FeedHandle {
  readonly feed: ChatFeed<TranscriptSessionRef>;
  readonly reader: WarmingReader<TranscriptSessionRef>;
  readonly backend: HerdrHostBackend;
  /** `hostId|session key`: what it follows. */
  readonly shelfKey: string;
  last: ChatFeedUpdate;
  /** The window showing it (null: kept or warming). */
  sink: ((update: ChatFeedUpdate) => void) | null;
  unsubscribe: () => void;
  /**
   * The chips' and the ring's reader on this feed's
   * reads, made with it, so a kept feed taken back still knows its model, effort and count, and a new session
   * (a new handle) never shows the old one's; the terminal and session it was made for.
   */
  readonly settings: AgentSettingsReader;
  readonly scope: SettingsScope;
  /** The window showing it, told when the chips' values changed (null: kept or warming). */
  onSettings: (() => void) | null;
  /** The user's auto-compact settings last read for it, kept with it on the shelf (the ring shows them at once when it is back). */
  limits: ContextLimits | null;
  limitsKey: string | null;
  /**
   * The Grok run this feed follows for (its pane, terminal and run), so the session
   * it follows is never sent for a later run; null for Claude and Codex. Set again when a window takes it.
   */
  run: GrokRun | null;
  /** One bounded read of its Grok files outside the growth throttle. */
  readonly refreshGrok: () => Promise<boolean>;
  /**
   * The folders its feed's follow was started
   * with: a kept feed that reads on is started again with these (the same follow), not the pane's folders now,
   * which would start it over.
   */
  folders: readonly string[];
  /**
   * The launch cache its window held on show when it was kept (its live
   * read held fewer items and still read back): the next window to show it holds the same until the live read
   * holds as many, so a pane switch (or a window hidden and back) never drops the screen to the partial live
   * snapshot. Taken once.
   */
  heldCache: { readonly timeline: ChatTimeline; readonly items: number } | null;
  /**
   * The pane's agent run it was started for (its pane, terminal and run): the folders are not in
   * its key, so a real arrival (a new run, another terminal) is told apart by this; a feed is kept on show or
   * taken back only for the same run (iOS keys its chat by pane and arrival too).
   */
  arrival: PaneArrival | null;
}

/** One agent run of a pane, as the snapshots count them (observeRun). */
interface PaneArrival {
  readonly paneId: string;
  readonly terminalID: string;
  readonly generation: number;
}

const sameArrival = (a: PaneArrival | null, b: PaneArrival): boolean =>
  a !== null && a.paneId === b.paneId && a.terminalID === b.terminalID && a.generation === b.generation;

/**
 * The launch cache a hidden window held over its chat's partial live read, kept with the chat
 * itself (not only its feed, which the shelf may let go while the window is hidden): its timeline and count, for
 * the feed that shows that chat next, and what it was for (the session and the run).
 */
interface HeldCache {
  readonly timeline: ChatTimeline;
  readonly items: number;
  readonly shelfKey: string;
  readonly arrival: PaneArrival | null;
}

/**
 * As in the iOS app, the launch cache's `cachedItems` stay on show over `live`
 * while it holds fewer and its earlier history is still read back (the cold load's screenful, which reads back
 * to at least the cached items); the whole file read, or a read back that ended (failed, the cap), hands over
 * to the live read.
 */
export function holdsCache(cachedItems: number, live: ChatTimeline): boolean {
  return itemCount(live) < cachedItems && live.earlier === "loading";
}

/** The same folders, in the same order. */
const sameFolders = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((folder, index) => folder === b[index]);

/** The display items of a timeline. */
const itemCount = (timeline: ChatTimeline): number => timeline.turns.reduce((count, turn) => count + turn.items.length, 0);

/** A kept feed's charge on the shelf: its snapshot, and the launch cache it holds for its next window. */
const handleBytes = (handle: FeedHandle): number =>
  approximateBytes(handle.last.timeline) + (handle.heldCache === null ? 0 : approximateBytes(handle.heldCache.timeline));

/**
 * One agent run in a pane, as the snapshots show it: a new run when an agent is seen
 * after a snapshot without one, or in another terminal (Herdr reports no run of its own; PaneLife counts the same way).
 */
interface PaneRun {
  readonly hostId: string;
  readonly paneId: string;
  readonly terminalID: string;
  readonly generation: number;
  readonly running: boolean;
}

/** The Grok run a feed was found for; `byFolder` when no session was named (its folder's newest). */
interface GrokRun {
  readonly hostId: string;
  readonly paneId: string;
  readonly terminalID: string;
  readonly generation: number;
  readonly byFolder: boolean;
}

/** A Grok session Chat followed for one run of a pane (sent as `followed`). */
interface FollowedRun {
  readonly terminalID: string;
  readonly generation: number;
  readonly session: string;
}

/** The followed sessions kept per pane (the latest runs'). */
const maxFollowedRuns = 16;

/** A warm that found no chat is tried again after this long (on a later snapshot). */
export const warmRetryMs = 30_000;
/** The warmed chats' timelines, kept beside the panes the user opened (two cold loads' worth, with room). */
export const warmedByteBudget = 6 * 1_024 * 1_024;

/** A window's page, as the service needs it (Electron's WebContents fits). */
export interface ChatOwner {
  readonly id: number;
  send(channel: string, payload: ChatUpdateEvent): void;
  isDestroyed(): boolean;
}

/** A Chat on screen (its window in sight), as the live reads need it (live-reads.ts). */
export interface ShownChat {
  readonly owner: ChatOwner;
  readonly slot: string;
  readonly follow: number | undefined;
  readonly hostId: string;
  readonly paneId: string;
}

/** A picture larger than this is not shown as a thumbnail: the largest upload. */
export const maxImageBytes = maxUploadBytes;

const imageTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
};

/** An inline image's media types shown (those of a picture by path). */
const blobImageTypes: ReadonlySet<string> = new Set(Object.values(imageTypes));
/**
 * The inline images fetched kept for a show again, by the characters they hold (their data URLs
 * and keys; V8 keeps these one byte each), the least recently shown going first; one being fetched counts once
 * it has come. 32 MiB holds the pictures of a few screens of a long image-heavy chat (a Retina screenshot is
 * 0.3 to 7 MB of base64; the largest allowed, 16 MiB) so a slot opened again or a second window does not read
 * them over the link again; the renderer keeps its own (ChatView). Entries of a transcript no chat follows go.
 */
export const blobImageBudget = 32 * 1_024 * 1_024;

/** An inline image fetched (or being fetched): its machine and transcript, and the characters it holds once come. */
interface BlobImageEntry {
  readonly hostId: string;
  readonly path: string;
  readonly request: Promise<string | null>;
  bytes: number;
}

/** The base64 bytes an inline image's parts hold. */
const blobBase64Length = (blob: ChatImageBlob): number => blob.parts.reduce((total, part) => total + (typeof part === "string" ? part.length : part[1]), 0);

const sameBlob = (a: ChatImageBlob, b: ChatImageBlob): boolean =>
  a.path === b.path &&
  a.ino === b.ino &&
  a.parts.length === b.parts.length &&
  a.parts.every((part, index) => {
    const other = b.parts[index]!;
    return typeof part === "string" ? part === other : typeof other !== "string" && part[0] === other[0] && part[1] === other[1];
  });

type Resolution =
  | {
      readonly kind: "session";
      readonly ref: TranscriptSessionRef;
      readonly folders: readonly string[];
      readonly key: string;
      readonly run: GrokRun | null;
    }
  | { readonly kind: "unavailable"; readonly state: ChatViewState; readonly key: string };

/** How an unavailable feed is retried on later snapshots. */
/** The shelf of the panes the user opened: its count and byte bounds (tests; the defaults otherwise). */
export interface ChatShelfOptions {
  readonly capacity?: number;
  readonly byteBudget?: number;
}

export interface ChatRetryOptions {
  /** The wait before the second retry; it doubles after each (the first is on the next snapshot). */
  readonly afterMs?: number;
  readonly maxMs?: number;
  readonly now?: () => number;
}

interface WindowChat {
  readonly owner: ChatOwner;
  /** The window's chat it is ("" the one pane view's; a tile's own otherwise). */
  readonly slot: string;
  /** The page's follow it answers (echoed on each update). */
  follow: number | undefined;
  hostId: string;
  paneId: string;
  /** The feed on show and what it last said. */
  handle: FeedHandle | null;
  feed: ChatFeed<TranscriptSessionRef> | null;
  /** The backend whose reader the feed uses. */
  backend: HerdrHostBackend | null;
  key: string | null;
  /** The last state and timeline sent (a feed's, or a state of the service's own). */
  state: ChatViewState;
  timeline: ChatTimeline;
  /** The feed's last update had read the transcript to its end. */
  caughtUp: boolean;
  /** Retries of an unavailable feed since it last loaded, and when the next may run. */
  retries: number;
  retryAt: number;
  /** A retry runs: its "loading" is not shown, nor the same reason again. */
  retrying: boolean;
  /** Its window is back in sight: the restarted feed's "loading" is not shown (the page keeps what it had). */
  resuming: boolean;
  /** The chips' reader on the feed's reads (null while no feed runs). */
  settings: AgentSettingsReader | null;
  /** The chips' values changed since the last update: one goes on the next tick. */
  settingsDue: boolean;
  /** The user's auto-compact settings for the transcript read (null until read), and which read they are of. */
  limits: ContextLimits | null;
  limitsKey: string | null;
  /** The terminal and session the settings reader was made for. */
  settingsScope: SettingsScope | null;
  /** Its pane's agent status at the last snapshot (a turn's end reads Grok's files). */
  agentStatus: string | null;
  /** Its timeline is the launch cache's, until the first feed read lands. */
  fromCache?: boolean;
  /**
   * The launch cache's items on show (`fromCache`): it stays on show while the live
   * read holds fewer and still reads back (`holdsCache`).
   */
  cachedItems?: number;
  /** The launch cache it held when its window was hidden (null: none, or used, or another chat now). */
  held?: HeldCache | null;
}

/** A window's chat a picture is asked for: its machine and slot. */
export interface ChatPlace {
  readonly hostId: string;
  readonly slot: string;
}

/** A window's chat: the window and its slot. */
const chatKey = (ownerId: number, slot: string): string => `${ownerId}\n${slot}`;

export class ChatService {
  /** Every chat followed, by window and slot (a tile each). */
  private readonly windows = new Map<string, WindowChat>();
  /** Windows out of sight (minimized, hidden): their feeds stop until they are back. */
  private readonly pausedOwners = new Set<number>();
  /**
   * By `hostId|session key`: the feeds of the panes the user opened, kept paused for a quick way back;
   * the warmed ones beside them (paused too, not yet opened); those warming now.
   */
  private readonly shelf: ChatShelf<FeedHandle>;
  private readonly warmed = new ChatShelf<FeedHandle>(warmLimit, warmedByteBudget);
  private readonly warming = new Map<string, FeedHandle>();
  private readonly gate = new ChatWarmGate();
  /** When a warm ended without a chat (no transcript yet, say) or a warmed chat had to go: not warmed again for `warmRetryMs`. */
  private readonly warmHeldOff = new Map<string, number>();
  /** Each pane's agent run as last seen (by `hostId|paneId`). */
  private readonly runs = new Map<string, PaneRun>();
  /**
   * The Grok sessions Chat followed for each pane's runs (by `hostId|paneId`), kept
   * after their feeds are let go, so a later run that names none never takes one of them up again.
   */
  private readonly followedRuns = new Map<string, FollowedRun[]>();
  /**
   * Each pane's last named Grok resolution (by `hostId|paneId`) with the run it was for,
   * so a snapshot of that run that drops the name keeps the session the run follows (same key and feed).
   */
  private readonly namedRuns = new Map<string, { readonly terminalID: string; readonly generation: number; readonly session: string; readonly resolution: Resolution }>();
  /**
   * By `hostId|paneId`, the session (its shelf key) and the
   * folders of a follow that ended because a line it read while following moved the transcript's folder out of the
   * pane's (ChatFeed.ownershipMoved). While the pane names that session and has those folders, no follow of it is
   * started again: no retry, no new feed (a window opened again, a pane switched back), no warming. The pane stays
   * unavailable (sessionMismatch), so a later record back into its folder never shows the stretch that was refused.
   * The folders are the pane's when Chat first looks after the end (null until then), not the follow's: a feed that
   * read on keeps the folders it started with. Another session or other folders clear it (ownershipMovedHolds), and
   * a new pane has its own key. It lasts as long as the service, the app's run: a restart of the app forgets it.
   */
  private readonly movedOwnership = new Map<string, { readonly shelfKey: string; folders: readonly string[] | null }>();

  /** Told when the Chats on screen may have changed (opened, closed, paused, a snapshot). */
  private readonly shownListeners = new Set<() => void>();

  private readonly retryAfterMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private readonly contextSettings: ContextSettings;

  /** The launch cache (absent: none). */
  private launchCache: ChatLaunchCache | null = null;

  constructor(
    private readonly hosts: ChatHosts,
    private readonly channel: string,
    private readonly feedOptions: ChatFeedOptions = {},
    retry: ChatRetryOptions = {},
    shelf: ChatShelfOptions = {},
  ) {
    this.shelf = new ChatShelf<FeedHandle>(shelf.capacity, shelf.byteBudget);
    this.retryAfterMs = retry.afterMs ?? 5_000;
    this.retryMaxMs = retry.maxMs ?? 60_000;
    this.now = retry.now ?? Date.now;
    this.contextSettings = new ContextSettings(this.now);
  }

  /** Shows a pane's cached chat while its machine catches up, and keeps live ones for the next launch. */
  useLaunchCache(cache: ChatLaunchCache): void {
    this.launchCache = cache;
  }

  /** The cached chat, marked as catching up, while the machine has no snapshot yet (nothing is read). */
  private showCached(chat: WindowChat): void {
    const key = "launch-cache";
    if (chat.key === key && chat.feed === null) return;
    this.release(chat);
    chat.held = null;
    chat.key = key;
    chat.state = { status: "loading" };
    chat.timeline = this.launchCache?.chat(chat.hostId, chat.paneId) ?? emptyTimeline;
    chat.fromCache = chat.timeline.turns.length > 0;
    chat.cachedItems = chat.fromCache ? itemCount(chat.timeline) : 0;
    chat.caughtUp = false;
    this.emit(chat);
  }

  /**
   * Follows `paneId` on `hostId` for the window's chat `slot` (each tile has
   * its own; "" is the one pane view's); the same pane again re-sends what is
   * shown. `follow` is the page's generation for that Chat, sent back on
   * every update so a late one from an earlier follow can be told apart.
   */
  open(owner: ChatOwner, hostId: string, paneId: string, slot = "", follow?: number): void {
    let chat = this.windows.get(chatKey(owner.id, slot));
    if (chat === undefined) {
      chat = {
        owner,
        slot,
        follow,
        hostId,
        paneId,
        handle: null,
        feed: null,
        backend: null,
        key: null,
        state: { status: "idle" },
        timeline: emptyTimeline,
        caughtUp: false,
        retries: 0,
        retryAt: 0,
        retrying: false,
        resuming: false,
        settings: null,
        settingsDue: false,
        limits: null,
        limitsKey: null,
        settingsScope: null,
        agentStatus: null,
      };
      this.windows.set(chatKey(owner.id, slot), chat);
    }
    chat.follow = follow;
    if (chat.hostId === hostId && chat.paneId === paneId && chat.key !== null) {
      this.apply(chat);
      this.emit(chat);
      this.shownChanged();
      return;
    }
    chat.hostId = hostId;
    chat.paneId = paneId;
    chat.key = null;
    // The launch cache on show was the pane before's (a feed that held it keeps it: release).
    if (chat.handle === null) {
      chat.fromCache = false;
      chat.cachedItems = 0;
    }
    this.apply(chat);
    this.shownChanged();
  }

  /**
   * Stops the window's chat in `slot` (its Chat closed), or every chat of the window (no slot: it went away);
   * each one's feed is kept paused on the shelf.
   */
  close(owner: { readonly id: number }, slot?: string): void {
    for (const [key, chat] of Array.from(this.windows)) {
      if (chat.owner.id !== owner.id || (slot !== undefined && chat.slot !== slot)) continue;
      this.windows.delete(key);
      this.release(chat);
    }
    this.shownChanged();
  }

  /**
   * The window went out of sight (true) or is back (false). Out of sight its
   * feeds stop without a word to the page, which keeps showing what it had;
   * back, each starts again and its next answer replaces what was shown (no
   * "loading" in between). A chat opened meanwhile starts then too.
   * Out of sight each feed is kept
   * paused on the shelf, so back in sight it is taken back and reads on from
   * where it was (a feed the shelf let go meanwhile starts again).
   */
  setPaused(owner: { readonly id: number }, paused: boolean): void {
    if (paused === this.pausedOwners.has(owner.id)) return;
    const chats = Array.from(this.windows.values()).filter((chat) => chat.owner.id === owner.id);
    if (paused) {
      this.pausedOwners.add(owner.id);
      for (const chat of chats) {
        // The launch cache it holds stays with the chat while hidden, whether or not its feed does.
        const handle = chat.handle;
        const items = chat.cachedItems ?? 0;
        chat.held =
          handle !== null && chat.fromCache === true && items > 0 ? { timeline: chat.timeline, items, shelfKey: handle.shelfKey, arrival: handle.arrival } : null;
        this.release(chat);
        chat.key = null;
      }
      this.shownChanged();
      return;
    }
    this.pausedOwners.delete(owner.id);
    for (const chat of chats) {
      chat.resuming = true;
      this.apply(chat);
    }
    this.shownChanged();
  }

  paused(owner: { readonly id: number }): boolean {
    return this.pausedOwners.has(owner.id);
  }

  loadEarlier(owner: { readonly id: number }, slot = ""): Promise<void> {
    return this.windows.get(chatKey(owner.id, slot))?.feed?.loadEarlier() ?? Promise.resolve();
  }

  setFollowingNewest(owner: { readonly id: number }, following: boolean, slot = ""): void {
    this.windows.get(chatKey(owner.id, slot))?.feed?.setFollowingNewest(following);
  }

  /** A new snapshot: each window's session is looked at again, and panes working or just finished are warmed. */
  refresh(): void {
    this.observeKnownRuns();
    for (const chat of Array.from(this.windows.values())) {
      if (this.windows.get(chatKey(chat.owner.id, chat.slot)) !== chat) continue;
      if (chat.owner.isDestroyed()) {
        this.close(chat.owner);
        continue;
      }
      this.apply(chat);
      // A turn that ended reads Grok's files once (its last bytes may sit inside the throttle).
      const status = this.hosts.agent(chat.hostId, chat.paneId)?.agentStatus ?? null;
      if (chat.agentStatus === "working" && status !== "working") void chat.handle?.refreshGrok();
      chat.agentStatus = status;
    }
    this.dropEndedRuns();
    this.prefetch();
    this.shownChanged();
  }

  /** The Chats on screen now: followed, their windows in sight and not gone. */
  shown(): ShownChat[] {
    return Array.from(this.windows.values())
      .filter((chat) => !this.pausedOwners.has(chat.owner.id) && !chat.owner.isDestroyed())
      .map((chat) => ({ owner: chat.owner, slot: chat.slot, follow: chat.follow, hostId: chat.hostId, paneId: chat.paneId }));
  }

  /** `listener` runs whenever the Chats on screen may have changed. */
  onShownChange(listener: () => void): () => void {
    this.shownListeners.add(listener);
    return () => this.shownListeners.delete(listener);
  }

  private shownChanged(): void {
    for (const listener of Array.from(this.shownListeners)) listener();
  }

  /** Stops every chat: the windows', the kept, the warmed and the warming feeds. */
  closeAll(): void {
    for (const chat of Array.from(this.windows.values())) this.close(chat.owner);
    this.pausedOwners.clear();
    const warming = [...this.warming.values()];
    this.warming.clear();
    for (const handle of [...this.shelf.removeAll(() => true), ...this.warmed.removeAll(() => true), ...warming]) this.stopHandle(handle);
    this.blobImages.clear();
    this.blobImageBytes = 0;
  }

  /** The feeds of the panes the user opened kept paused, by `hostId|session key`, the least recently kept first (tests). */
  get keptKeys(): readonly string[] {
    return this.shelf.keys;
  }

  /** The bytes the kept feeds of the panes the user opened are charged now (tests). */
  get keptBytes(): number {
    return this.shelf.bytes;
  }

  /** The warmed feeds kept paused, not yet opened (tests). */
  get warmedKeys(): readonly string[] {
    return this.warmed.keys;
  }

  /** The feeds warming now (tests). */
  get warmingKeys(): readonly string[] {
    return [...this.warming.keys()];
  }

  /**
   * Warms the panes the sidebar shows working or just finished (`agentPanes`, in its order):
   * not on show, not kept, not warming, at most two at once, each one's reads through its machine's gate.
   * Once loaded a warmed feed is kept paused beside the panes the user opened (two of them at most: it never
   * pushes one of theirs out); a window that opens it takes it as it is, warming or warmed. A warmed pane that
   * is no longer working or just finished goes, making room.
   */
  prefetch(): void {
    const panes = this.hosts.agentPanes?.() ?? [];
    const candidates = new Map<string, { hostId: string; paneId: string; resolution: Extract<Resolution, { kind: "session" }>; backend: HerdrHostBackend }>();
    for (const { hostId, paneId } of panes) {
      const status = this.hosts.agent(hostId, paneId)?.agentStatus;
      if (status !== "working" && status !== "done") continue;
      const resolution = this.resolve(hostId, paneId);
      const backend = this.hosts.backend(hostId);
      if (resolution.kind !== "session" || backend === null || backend.transcripts() === null) continue;
      // A follow that ended on a moved ownership is not warmed either.
      if (this.ownershipMovedHolds(hostId, paneId, resolution)) continue;
      const key = `${hostId}|${resolution.key}`;
      if (!candidates.has(key)) candidates.set(key, { hostId, paneId, resolution, backend });
    }
    for (const gone of this.warmed.removeAll((key) => !candidates.has(key))) this.stopHandle(gone);
    if (candidates.size === 0) return;
    const shown = new Set<string>();
    for (const chat of this.windows.values()) if (chat.handle !== null) shown.add(chat.handle.shelfKey);
    const now = this.now();
    for (const [key, at] of this.warmHeldOff) if (now - at >= warmRetryMs) this.warmHeldOff.delete(key);
    const eligible = [...candidates.keys()].filter((key) => !this.warmHeldOff.has(key));
    const kept = new Set([...this.shelf.keys, ...this.warmed.keys]);
    const picked = warmPlan(eligible, shown, kept, new Set(this.warming.keys()), Math.max(0, warmLimit - this.warmed.count));
    for (const key of picked) {
      const candidate = candidates.get(key)!;
      const reader = candidate.backend.transcripts();
      if (reader === null) continue;
      const handle = this.makeHandle(reader, candidate.backend, candidate.hostId, candidate.paneId, key, candidate.resolution.ref.format, true);
      handle.run = candidate.resolution.run;
      handle.arrival = this.arrivalOf(candidate.hostId, candidate.paneId);
      this.warming.set(key, handle);
      handle.folders = candidate.resolution.folders;
      handle.feed.start(candidate.resolution.ref, candidate.resolution.folders);
      void handle.feed.loaded().then((live) => {
        if (this.warming.get(key) !== handle) return;
        this.warming.delete(key);
        if (live) this.keepWarmed(handle);
        else {
          this.warmHeldOff.set(key, this.now());
          this.stopHandle(handle);
        }
        this.prefetch();
      });
    }
  }

  /**
   * A picture the user's message carries, as a data URL, or null: only a path that is
   * an image attachment of a message in one of the window's chats, read
   * through the same read-only reader, up to 12 MB (the largest upload).
   */
  async image(owner: { readonly id: number }, path: string): Promise<string | null> {
    const chat = Array.from(this.windows.values()).find(
      (candidate) => candidate.owner.id === owner.id && candidate.backend !== null && this.showsAttachment(candidate.timeline, path),
    );
    const reader = chat?.backend?.transcripts() ?? null;
    if (chat === undefined || reader === null) return null;
    const type = imageTypes[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
    if (type === undefined) return null;
    try {
      const size = await reader.size(path);
      if (size <= 0 || size > maxImageBytes) return null;
      const bytes = await reader.read(path, 0, size);
      return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      return null;
    }
  }

  /**
   * Inline images fetched (or being fetched), by host, transcript, inode and parts; the least
   * recently shown first. `bytes`: the characters it holds once come (0 while it is fetched).
   */
  private readonly blobImages = new Map<string, BlobImageEntry>();
  private blobImageBytes = 0;

  /**
   * An inline image a relay read left out (relay v1.2, rule 5), as a data URL, or null: only
   * one a message on show in the window's live chat carries (these parts exactly; not the launch cache's), of a
   * shown media type, up to 12 MB, fetched from the transcript that chat's feed follows now (its path and inode)
   * by plain relay reads. Fetched once per host, transcript, inode and parts (kept for a show again, within
   * `blobImageBudget`); a failed fetch is not kept.
   *
   * The chat is the one `place` names (the window's slot), on the machine it names: the file
   * coordinates mean a file on that machine only.
   */
  async blobImage(owner: { readonly id: number }, blob: ChatImageBlob, place: ChatPlace): Promise<string | null> {
    const chat = this.windows.get(chatKey(owner.id, place.slot));
    if (chat === undefined || chat.owner.id !== owner.id || chat.hostId !== place.hostId || chat.handle === null || chat.fromCache === true) return null;
    const attachment = this.shownBlob(chat.timeline, blob);
    if (attachment === null) return null;
    const feed = chat.handle.feed;
    const type = attachment.mediaType;
    if (type === null || !blobImageTypes.has(type)) return null;
    if (Math.floor((blobBase64Length(blob) * 3) / 4) > maxImageBytes) return null;
    const key = JSON.stringify([chat.hostId, blob.path, blob.ino, blob.parts]);
    let entry = this.blobImages.get(key);
    if (entry === undefined) {
      const made: BlobImageEntry = {
        hostId: chat.hostId,
        path: blob.path,
        request: feed.fetchImage(blob).then(
          (base64) => (base64 === null || base64.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ? null : `data:${type};base64,${base64}`),
          () => null,
        ),
        bytes: 0,
      };
      entry = made;
      this.blobImages.set(key, made);
      void made.request.then((url) => {
        // Let go meanwhile (its transcript no longer followed, or trimmed): nothing to count.
        if (this.blobImages.get(key) !== made) return;
        if (url === null) {
          this.blobImages.delete(key);
          return;
        }
        made.bytes = key.length + url.length;
        this.blobImageBytes += made.bytes;
        this.trimBlobImages(key);
      });
    } else {
      // Shown again: the newest.
      this.blobImages.delete(key);
      this.blobImages.set(key, entry);
    }
    return entry.request;
  }

  /** The oldest shown inline images go while over the budget (never `keep`, the one just come). */
  private trimBlobImages(keep: string | null): void {
    for (const [key, entry] of this.blobImages) {
      if (this.blobImageBytes <= blobImageBudget) return;
      if (key === keep) continue;
      this.blobImages.delete(key);
      this.blobImageBytes -= entry.bytes;
    }
  }

  /**
   * The inline images of transcripts no window's chat follows now go (a chat closed or moved on);
   * run by release, so after every transition that takes a chat's feed away.
   */
  private forgetUnfollowedBlobImages(): void {
    if (this.blobImages.size === 0) return;
    const followed = new Set<string>();
    for (const chat of this.windows.values()) {
      const path = chat.handle?.feed.path ?? null;
      if (path !== null) followed.add(JSON.stringify([chat.hostId, path]));
    }
    for (const [key, entry] of Array.from(this.blobImages)) {
      if (followed.has(JSON.stringify([entry.hostId, entry.path]))) continue;
      this.blobImages.delete(key);
      this.blobImageBytes -= entry.bytes;
    }
  }

  /** The inline images kept now: how many and their characters (tests). */
  get blobImagesKept(): { readonly count: number; readonly bytes: number } {
    return { count: this.blobImages.size, bytes: this.blobImageBytes };
  }

  /** The attachment of a message on show that carries `blob`, or null. */
  private shownBlob(timeline: ChatTimeline, blob: ChatImageBlob): ChatAttachment | null {
    for (const turn of timeline.turns) {
      for (const item of turn.items) {
        if (item.type !== "user") continue;
        const found = item.value.attachments.find((attachment) => attachment.blob !== undefined && sameBlob(attachment.blob, blob));
        if (found !== undefined) return found;
      }
    }
    return null;
  }

  private showsAttachment(timeline: ChatTimeline, path: string): boolean {
    return timeline.turns.some((turn) =>
      turn.items.some((item) => item.type === "user" && item.value.attachments.some((attachment) => attachment.path === path)),
    );
  }

  private resolve(hostId: string, paneId: string): Resolution {
    const pane = this.hosts.pane(hostId, paneId);
    const agent = this.hosts.agent(hostId, paneId);
    const unavailable = (state: ChatViewState): Resolution => ({ kind: "unavailable", state, key: JSON.stringify(state) });
    // Every snapshot of the pane counts for its runs (one without an agent ends the run).
    this.observeRun(hostId, paneId);
    const isAgent = (agent?.agent !== undefined && agent.agent !== "") || (pane !== null && isAgentPane(pane));
    if (!isAgent) return unavailable({ status: "unavailable", reason: pane === null ? "noSession" : "notAgent" });
    // An agent of a kind Chat doesn't read
    // (kinds.ts; Maki and Antigravity for 0.1.0) follows nothing: its Chat tab shows the one Chat line (unread.ts),
    // and no session is guessed or read for it (a Maki pane's folder rule would take the folder's newest log).
    // Herdr's aliases as the locator maps them (`github-copilot` is Copilot); Maki's
    // format is `maki` and Antigravity's `antigravity`, neither a kind kinds.ts lists, so both still follow nothing.
    // agentFormat and chatReads both read the alias through agent-names.ts
    // readerKind, the one mapping the UI helpers (defaultView, the fallback line, the names) use too.
    // The kind as Herdr labels it (chatReads maps its aliases): Antigravity's label `agy` is the kind
    // kinds.ts lists, its format (`antigravity`) not; every other kind's format is its kind.
    // Kiro is not a kind kinds.ts lists, so a Kiro pane follows nothing here, as Maki.
    const readKind = agent?.agent ?? pane?.agent;
    if (readKind !== undefined && readKind !== "" && !chatReads(readKind)) return unavailable({ status: "unavailable", reason: "noSession" });
    // Away's and Changes' rule (locator.paneSession): a Grok pane that follows its folder
    // never takes a session its Grok peers name, and one another unnamed Grok pane shares is refused.
    const peerIDs = (this.hosts.hostAgentPanes?.(hostId) ?? []).filter((peerId) => peerId !== paneId);
    const agents = [paneId, ...peerIDs].flatMap((id) => {
      const info = id === paneId ? agent : this.hosts.agent(hostId, id);
      return info === null ? [] : [{ ...info, paneID: id }];
    });
    const panes = [paneId, ...peerIDs].flatMap((id) => {
      const info = id === paneId ? pane : this.hosts.pane(hostId, id);
      return info === null ? [] : [{ ...info, paneID: id }];
    });
    const found = paneSession({ agents, panes }, paneId);
    // A run that names no session now but follows one it was named keeps it.
    // Cursor's panes by the same rules as Grok's (folderFormats).
    const kind = (agent?.agent ?? pane?.agent ?? "").toLowerCase();
    // A herdr-core Claude or Codex pane's refusal (core-pane-session.ts) keeps no Grok run's session.
    const coreRefusal = found === "ambiguous" && isCoreID(paneId) && (kind === "claude" || kind === "codex");
    const kept =
      (found === "ambiguous" && !coreRefusal) || (found !== null && found !== "ambiguous" && folderFormats.includes(found.ref.format) && found.ref.lookup.kind === "folder")
        ? this.keptNamed(hostId, paneId, agents)
        : null;
    if (kept !== null) return kept;
    if (found === null) return unavailable({ status: "unavailable", reason: "noSession" });
    // Two Cursor panes say Cursor's note.
    // Two Gemini (or Qwen) panes say their own agent's note.
    // Two Copilot (or Droid) panes say their own note.
    const ambiguous =
      piAmbiguousReason(agent?.agent ?? pane?.agent) /* two Pi (omp) panes say their own note */ ??
      openCodeAmbiguousReason(agent?.agent ?? pane?.agent) ?? // two OpenCode (or Kilo) panes say their own note
      geminiFamilyAmbiguousReason(agent?.agent ?? pane?.agent) ??
      copilotAmbiguousReason(agent?.agent ?? pane?.agent) ??
      droidAmbiguousReason(agent?.agent ?? pane?.agent) ??
      clineAmbiguousReason(agent?.agent ?? pane?.agent) ?? // two Cline panes say Cline's note
      kiroAmbiguousReason(agent?.agent ?? pane?.agent) ?? // two Kiro panes say Kiro's note
      (kind === "kimi" // Kimi's note
        ? "ambiguousKimiSession"
        : kind === "cursor"
          ? "ambiguousCursorSession"
          : // two Maki panes say Maki's note.
            kind === "maki"
            ? "ambiguousMakiSession"
            : "ambiguousSession");
    // And a herdr-core Claude or Codex pane its own agent's.
    if (coreRefusal) return unavailable({ status: "unavailable", reason: kind === "claude" ? "ambiguousClaudeSession" : "ambiguousCodexSession" });
    if (found === "ambiguous") return unavailable({ status: "unavailable", reason: ambiguous });
    // A run that names no session never takes up one Chat followed for an earlier run
    // of the pane: none until its own is written (the unavailable retry finds it then).
    const session = folderFormats.includes(found.ref.format) ? excludingGrokSessions(found, this.earlierRunsSessions(hostId, paneId)) : found;
    if (session === "ambiguous") return unavailable({ status: "unavailable", reason: ambiguous });
    // A Grok feed belongs to the run it was found for; one its folder found (no session
    // named) is that run's only, so a later run in the folder looks again rather than taking it back.
    let run: GrokRun | null = null;
    let key = chatSessionKey(session);
    if (folderFormats.includes(session.ref.format)) {
      const now = this.observeRun(hostId, paneId);
      const byFolder = session.ref.lookup.kind === "folder";
      run = { hostId, paneId, terminalID: now.terminalID, generation: now.generation, byFolder };
      if (byFolder) key += `|run ${JSON.stringify([paneId, now.terminalID, now.generation])}`;
      const named = byFolder ? null : grokSessionIDOf(session.ref);
      if (named !== null) {
        const resolution: Resolution = { kind: "session", ref: session.ref, folders: session.paneFolders, key, run };
        this.namedRuns.set(`${hostId}|${paneId}`, { terminalID: now.terminalID, generation: now.generation, session: named, resolution });
        return resolution;
      }
    }
    return { kind: "session", ref: session.ref, folders: session.paneFolders, key, run };
  }

  /**
   * The named resolution the pane's run in it now was given and follows (Chat sent it
   * as followed for this run), while no peer names that session; else null (a run that followed nothing named
   * yet, a new run or terminal: its folder is looked up).
   */
  private keptNamed(hostId: string, paneId: string, agents: readonly AgentInfo[]): Resolution | null {
    const key = `${hostId}|${paneId}`;
    const kept = this.namedRuns.get(key);
    if (kept === undefined) return null;
    const now = this.observeRun(hostId, paneId);
    if (!now.running || kept.terminalID !== now.terminalID || kept.generation !== now.generation) return null;
    const followed = (this.followedRuns.get(key) ?? []).some(
      (entry) => entry.terminalID === now.terminalID && entry.generation === now.generation && entry.session === kept.session,
    );
    if (!followed) return null;
    const namedByPeer = agents.some((agent) => {
      if (agent.paneID === paneId || agent.agentSession === undefined) return false;
      const ref = sessionRefFromAgentSession(agent.agentSession);
      return ref !== null && folderFormats.includes(ref.format) && grokSessionIDOf(ref) === kept.session;
    });
    return namedByPeer ? null : kept.resolution;
  }

  /** The feeds the pane's windows show stop the tasks and subagents its ended run left running. */
  private endSessionIn(hostId: string, paneId: string): void {
    for (const chat of this.windows.values()) if (chat.hostId === hostId && chat.paneId === paneId) chat.handle?.feed.endSession();
  }

  /** The pane's run as last observed (resolve observes it first). */
  private arrivalOf(hostId: string, paneId: string): PaneArrival {
    const run = this.runs.get(`${hostId}|${paneId}`);
    return { paneId, terminalID: run?.terminalID ?? "", generation: run?.generation ?? 0 };
  }

  /** The pane's agent run by the latest snapshot (a new one after none ran, or in another terminal). */
  private observeRun(hostId: string, paneId: string): PaneRun {
    const pane = this.hosts.pane(hostId, paneId);
    const agent = this.hosts.agent(hostId, paneId);
    const running = (agent?.agent !== undefined && agent.agent !== "") || (pane !== null && isAgentPane(pane));
    const terminalID = agent?.terminalID !== undefined && agent.terminalID !== "" ? agent.terminalID : (pane?.terminalID ?? "");
    const key = `${hostId}|${paneId}`;
    const previous = this.runs.get(key);
    const arrived = running && (previous === undefined || !previous.running || previous.terminalID !== terminalID);
    // The run ended (the agent exited, or another run began): what it left running is over.
    if (previous !== undefined && previous.running && (!running || arrived)) this.endSessionIn(hostId, paneId);
    const run: PaneRun = {
      hostId,
      paneId,
      terminalID: running ? terminalID : (previous?.terminalID ?? terminalID),
      generation: (previous?.generation ?? 0) + (arrived ? 1 : 0),
      running,
    };
    this.runs.set(key, run);
    return run;
  }

  /**
   * Every snapshot counts for the runs of every pane the service has seen run, whether
   * or not a window shows it (closed, parked, paused): an exit (no agent, or the pane gone) or a new run is
   * recorded before any later run is resolved, and a kept named binding of a run that ended goes.
   */
  private observeKnownRuns(): void {
    for (const run of Array.from(this.runs.values())) this.observeRun(run.hostId, run.paneId);
    for (const [key, kept] of Array.from(this.namedRuns)) {
      const now = this.runs.get(key);
      if (now === undefined || !now.running || now.terminalID !== kept.terminalID || now.generation !== kept.generation) this.namedRuns.delete(key);
    }
  }

  /**
   * The sessions Chat followed for the pane's runs before the one in it now,
   * never one the run in it now followed (a resumed session an earlier run followed too).
   */
  private earlierRunsSessions(hostId: string, paneId: string): string[] {
    const now = this.observeRun(hostId, paneId);
    const followed = this.followedRuns.get(`${hostId}|${paneId}`) ?? [];
    const isNow = (entry: FollowedRun): boolean => entry.terminalID === now.terminalID && entry.generation === now.generation;
    const current = new Set(followed.filter(isNow).map((entry) => entry.session));
    const earlier = followed.filter((entry) => !isNow(entry) && !current.has(entry.session));
    return [...new Set(earlier.map((entry) => entry.session))];
  }

  /** Chat followed `session` for `run` (sent as `followed`): kept for the pane's later runs. */
  private noteFollowed(run: GrokRun, session: string): void {
    const key = `${run.hostId}|${run.paneId}`;
    const list = (this.followedRuns.get(key) ?? []).filter(
      (entry) => !(entry.terminalID === run.terminalID && entry.generation === run.generation && entry.session === session),
    );
    list.push({ terminalID: run.terminalID, generation: run.generation, session });
    this.followedRuns.set(key, list.slice(-maxFollowedRuns));
  }

  /** Whether `run` is the one in its pane now (still running, in the same terminal). */
  private isCurrent(run: GrokRun): boolean {
    const now = this.runs.get(`${run.hostId}|${run.paneId}`);
    return now !== undefined && now.running && now.terminalID === run.terminalID && now.generation === run.generation;
  }

  /** A kept, warmed or warming feed its folder found for a run that ended is let go. */
  private dropEndedRuns(): void {
    const ended = (handle: FeedHandle): boolean => {
      const run = handle.run;
      if (run === null || !run.byFolder) return false;
      this.observeRun(run.hostId, run.paneId);
      return !this.isCurrent(run);
    };
    for (const gone of this.shelf.removeAll((_key, handle) => ended(handle))) this.stopHandle(gone);
    for (const gone of this.warmed.removeAll((_key, handle) => ended(handle))) this.stopHandle(gone);
    for (const [key, handle] of Array.from(this.warming)) {
      if (!ended(handle)) continue;
      this.warming.delete(key);
      this.stopHandle(handle);
    }
  }

  /** Starts, restarts or stops the window's feed for what its pane names now (nothing while its window is out of sight). */
  private apply(chat: WindowChat): void {
    if (this.pausedOwners.has(chat.owner.id)) return;
    const resolution = this.resolve(chat.hostId, chat.paneId);
    const backend = this.hosts.backend(chat.hostId);
    const reader = backend?.transcripts() ?? null;
    if (resolution.kind === "session" && reader === null) {
      this.showOwn(chat, { status: "unavailable", reason: "noAccess" }, "noAccess");
      return;
    }
    if (resolution.kind === "unavailable" && this.launchCache?.catchingUp(chat.hostId) === true) {
      this.showCached(chat);
      return;
    }
    if (resolution.kind === "unavailable") {
      this.showOwn(chat, resolution.state, resolution.key);
      return;
    }
    // The pane's run now (resolve observed it): a feed started for another run is not kept.
    const arrival = this.arrivalOf(chat.hostId, chat.paneId);
    if (chat.key === resolution.key && chat.feed !== null && chat.backend === backend && sameArrival(chat.handle?.arrival ?? null, arrival)) {
      const state = chat.feed.state;
      if (state.status !== "unavailable") return;
      // The folders are not in the key; a chat that is unavailable because its
      // transcript is not the pane's folders' (sessionMismatch) looks again at once when they change. A chat
      // that reads keeps reading: new folders never start it over.
      // A Codex session another folder's by its header (codexOtherFolder) the same.
      if ((state.reason === "sessionMismatch" || state.reason === "codexOtherFolder") && chat.handle !== null && !sameFolders(chat.handle.folders, resolution.folders)) {
        chat.retries = 0;
        chat.retryAt = 0;
      }
      // A follow a moved ownership ended is not started again for the same
      // session and folders (it would read the stretch it refused as this pane's); its sessionMismatch stays.
      if (this.ownershipMovedHolds(chat.hostId, chat.paneId, resolution)) return;
      this.retry(chat, chat.feed, resolution);
      return;
    }
    // Nor by a new feed (a window opened on the pane again, a pane switched back, a new run).
    if (this.ownershipMovedHolds(chat.hostId, chat.paneId, resolution)) {
      this.showOwn(chat, { status: "unavailable", reason: "sessionMismatch" }, `ownershipMoved|${resolution.key}`);
      return;
    }
    chat.retries = 0;
    chat.retryAt = 0;
    chat.retrying = false;
    // The one it opens is taken back when kept (or warming), before the pane it showed is kept
    // paused (a full shelf lets nothing go for a swap); a pane on the same session keeps the feed on show.
    const shelfKey = `${chat.hostId}|${resolution.key}`;
    const showing = chat.handle;
    const status = showing?.feed.state.status;
    let kept: FeedHandle | null;
    if (
      showing !== null &&
      showing.shelfKey === shelfKey &&
      showing.backend === backend &&
      sameArrival(showing.arrival, arrival) &&
      (status === "live" || status === "loading")
    ) {
      kept = showing;
      chat.handle = null;
    } else {
      kept = this.adopt(shelfKey, backend!, arrival);
      this.release(chat);
      // The same session's feed of an earlier run (or another backend) is not kept for later.
      if (showing !== null && showing.shelfKey === shelfKey && this.shelf.peek(shelfKey) === showing) {
        this.shelf.take(shelfKey);
        this.stopHandle(showing);
      }
      // The pictures of a transcript no chat follows now went with release.
    }
    // What this chat's hidden window held, for this session and run (else nothing: another chat).
    const stash = chat.held ?? null;
    chat.held = null;
    const handle = kept ?? this.makeHandle(reader!, backend!, chat.hostId, chat.paneId, shelfKey, resolution.ref.format, false);
    handle.arrival = arrival;
    // The run it shows for now (a named session's feed may be taken back by a later run).
    handle.run = resolution.run;
    handle.sink = (update) => this.received(chat, handle.feed, update);
    handle.onSettings = () => this.settingsChanged(chat, handle.settings);
    if (chat.settings !== handle.settings) {
      // The chips and the ring follow the handle's own reader; the user's limits are read again for it.
      chat.settings = handle.settings;
      chat.settingsScope = handle.scope;
      chat.settingsDue = false;
      chat.limits = handle.limits;
      chat.limitsKey = handle.limitsKey;
    }
    chat.handle = handle;
    chat.feed = handle.feed;
    chat.backend = backend;
    chat.key = resolution.key;
    // A kept feed parked while its window held the launch cache holds it
    // again (its items, their count, catching up: rows unconfirmed); its feed still reads back to that count
    // (the fill target it was started with).
    // A feed the shelf let go meanwhile: the chat's own hold (the same session and run), so the
    // feed started in its place holds it and reads back to its count.
    const ownHold = stash !== null && stash.shelfKey === shelfKey && sameArrival(stash.arrival, arrival) ? stash : null;
    const held = kept?.heldCache ?? ownHold;
    if (kept !== null) kept.heldCache = null;
    if (kept === null && held !== null) {
      chat.timeline = held.timeline;
      chat.fromCache = true;
      chat.cachedItems = held.items;
    }
    if (kept !== null) {
      // On show at once as it was kept; it reads on from where it was.
      chat.state = kept.last.state;
      chat.timeline = kept.last.timeline;
      if (held !== null) {
        chat.timeline = held.timeline;
        chat.fromCache = true;
        chat.cachedItems = held.items;
      }
      // A paused feed reads on from where it was: caught up again only once read (resume says so).
      // One still warming keeps what it last said of its newest (as the Swift app does).
      chat.caughtUp = !kept.feed.isPaused && kept.feed.caughtUp;
      // A window back in sight keeps what it showed over a "loading".
      if (!chat.resuming || kept.last.state.status !== "loading") this.emit(chat);
      kept.feed.resume();
      // A Chat back on show reads Grok's files once (a new feed reads them on its first read).
      void kept.refreshGrok();
    }
    // A kept feed that reads (or loads) for this key (the same session)
    // reads on: it is started again with its own follow's folders, which the feed takes as the follow it has,
    // not the pane's folders now (which would start it over). Its folder check stands; the mismatch retry
    // compares with the folders it checks against.
    const keptStatus = kept?.feed.state.status;
    const readsOn = kept !== null && (keptStatus === "live" || keptStatus === "loading");
    const folders = readsOn ? handle.folders : resolution.folders;
    handle.folders = folders;
    // The cold load reads back at least the cached items on show.
    handle.feed.start(resolution.ref, folders, chat.fromCache === true ? (chat.cachedItems ?? 0) : 0);
  }

  /** A feed of the service's: cold first loads, its reads through the machine's gate while it warms. */
  private makeHandle(
    base: NonNullable<ReturnType<HerdrHostBackend["transcripts"]>>,
    backend: HerdrHostBackend,
    hostId: string,
    paneId: string,
    shelfKey: string,
    format: TranscriptSessionRef["format"],
    warming: boolean,
  ): FeedHandle {
    const reader = new WarmingReader<TranscriptSessionRef>(base, hostId, this.gate, warming);
    // The chips read what the feed reads (no read of their own), a kept or warming feed's too.
    const settings = new AgentSettingsReader(format);
    let handle: FeedHandle | null = null;
    const tapped = tapReader(reader, settings, () => handle?.onSettings?.());
    // A first load whose screenful named no model reads on for it (the chips only).
    const lookBack = {
      wants: () => (format === "claude" || format === "codex") && settings.settings.modelLabel === null,
      line: (text: string, offset: number) => {
        if (settings.line(text, offset)) handle?.onSettings?.();
      },
    };
    // A running subagent's step is read with this reader too (beneath the chips' tap), only on show.
    const feed = new ChatFeed<TranscriptSessionRef>(tapped, {
      ...this.feedOptions,
      cold: this.feedOptions.cold ?? standardColdLoad,
      lookBack,
      subagentReader: reader,
      stepsShown: () => !reader.warming,
    });
    const made: FeedHandle = {
      feed,
      reader,
      backend,
      shelfKey,
      last: { state: feed.state, timeline: feed.timeline },
      sink: null,
      unsubscribe: () => undefined,
      settings,
      scope: this.scopeOf(hostId, paneId),
      onSettings: null,
      limits: null,
      limitsKey: null,
      run: null,
      refreshGrok: () => tapped.refreshGrok(),
      folders: [],
      heldCache: null,
      arrival: null,
    };
    handle = made;
    made.unsubscribe = feed.subscribe((update) => {
      made.last = update;
      // A follow ended on a moved ownership is kept ended for this pane's session and folders.
      if (feed.ownershipMoved && this.movedOwnership.get(`${hostId}|${paneId}`)?.shelfKey !== made.shelfKey) {
        this.movedOwnership.set(`${hostId}|${paneId}`, { shelfKey: made.shelfKey, folders: null });
      }
      // A kept feed's read that lands after it was kept is charged, the shelf trimmed.
      if (made.sink === null) this.recharge(made);
      else made.sink(update);
    });
    return made;
  }

  /**
   * The kept (or warming) feed for `shelfKey` on this backend, taken off the shelf; null when there is none to show.
   * One started for another run of the pane (`arrival`) is stopped, not shown.
   */
  private adopt(shelfKey: string, backend: HerdrHostBackend, arrival: PaneArrival): FeedHandle | null {
    let handle = this.shelf.take(shelfKey) ?? this.warmed.take(shelfKey) ?? null;
    if (handle === null) {
      const warming = this.warming.get(shelfKey);
      if (warming !== undefined) {
        this.warming.delete(shelfKey);
        handle = warming;
      }
    }
    if (handle === null) return null;
    const status = handle.feed.state.status;
    if (handle.backend !== backend || !sameArrival(handle.arrival, arrival) || (status !== "live" && status !== "loading")) {
      this.stopHandle(handle);
      return null;
    }
    handle.reader.warming = false;
    return handle;
  }

  /** The window lets its feed go: kept paused on the shelf while it follows (else stopped). */
  private release(chat: WindowChat): void {
    const handle = chat.handle;
    const { limits, limitsKey } = chat;
    chat.handle = null;
    chat.feed = null;
    chat.backend = null;
    chat.settings = null;
    chat.settingsDue = false;
    chat.limits = null;
    chat.limitsKey = null;
    chat.settingsScope = null;
    if (handle === null) return;
    handle.limits = limits;
    handle.limitsKey = limitsKey;
    handle.sink = null;
    handle.onSettings = null;
    // The launch cache on show (catching up: its live read holds fewer
    // items, or none yet) goes with the kept feed, for whichever window shows it next.
    handle.heldCache = chat.fromCache === true && (chat.cachedItems ?? 0) > 0 ? { timeline: chat.timeline, items: chat.cachedItems ?? 0 } : null;
    chat.fromCache = false;
    chat.cachedItems = 0;
    this.park(handle);
    // Every transition that takes a chat's feed away (closed, hidden, moved on, unavailable, the
    // launch cache only) lets go the pictures of a transcript no window's chat follows now; a fetch still on its
    // way for one is then not counted or kept (blobImage). Another chat that follows it keeps them.
    this.forgetUnfollowedBlobImages();
  }

  /** A kept feed's charge, its snapshot now; what had to go for it stops (a warmed one waits before it warms again). */
  private recharge(handle: FeedHandle): void {
    const bytes = handleBytes(handle);
    if (this.shelf.peek(handle.shelfKey) === handle) {
      for (const gone of this.shelf.resize(handle.shelfKey, bytes)) this.stopHandle(gone);
    } else if (this.warmed.peek(handle.shelfKey) === handle) {
      for (const gone of this.warmed.resize(handle.shelfKey, bytes)) {
        this.warmHeldOff.set(gone.shelfKey, this.now());
        this.stopHandle(gone);
      }
    }
  }

  private park(handle: FeedHandle): void {
    if (!this.pause(handle)) return;
    for (const gone of this.shelf.put(handle.shelfKey, handle, handleBytes(handle))) this.stopHandle(gone);
  }

  /** A warmed feed, kept paused beside the panes the user opened; one that has to go is not warmed again for a while. */
  private keepWarmed(handle: FeedHandle): void {
    if (!this.pause(handle)) return;
    for (const gone of this.warmed.put(handle.shelfKey, handle, handleBytes(handle))) {
      this.warmHeldOff.set(gone.shelfKey, this.now());
      this.stopHandle(gone);
    }
  }

  /** Pauses a feed that follows (true); one that does not is stopped. */
  private pause(handle: FeedHandle): boolean {
    const status = handle.feed.state.status;
    if (status !== "live" && status !== "loading") {
      this.stopHandle(handle);
      return false;
    }
    handle.feed.pause();
    handle.reader.warming = false;
    return true;
  }

  private stopHandle(handle: FeedHandle): void {
    handle.sink = null;
    handle.onSettings = null;
    handle.unsubscribe();
    handle.feed.stop();
  }

  /** The chips' values changed on a read: an update goes once the read's own (if any) has gone. */
  private settingsChanged(chat: WindowChat, settings: AgentSettingsReader): void {
    if (chat.settings !== settings || chat.settingsDue) return;
    chat.settingsDue = true;
    setTimeout(() => {
      if (!chat.settingsDue || chat.settings !== settings || this.windows.get(chatKey(chat.owner.id, chat.slot)) !== chat) return;
      this.emit(chat);
    }, 0);
  }

  /** The pane's terminal and agent session by the latest snapshot. */
  private scopeOf(hostId: string, paneId: string): SettingsScope {
    const pane = this.hosts.pane(hostId, paneId);
    const session = this.hosts.agent(hostId, paneId)?.agentSession?.value;
    return { terminalID: pane?.terminalID ?? "", session: session === undefined || session === "" ? null : session };
  }

  /**
   * The Grok session the live feed follows (the id its checked updates.jsonl is
   * filed under), with the terminal the pane's agent runs in, for Resume after it leaves; else null.
   */
  private followedOf(chat: WindowChat): FollowedSession | null {
    const path = chat.feed?.path ?? null;
    // A Cursor chat's store.db, filed under its chat id, the same way.
    if (chat.state.status !== "live" || path === null || !(path.endsWith("/updates.jsonl") || isCursorStorePath(path) || isMakiSessionPath(path))) return null;
    // A Maki session's log is named by its id (a base58 id, not a UUID).
    const makiSession = makiSessionIDOfPath(path);
    const session = makiSession ?? path.split("/").at(-2) ?? "";
    if (makiSession === null && !isGrokSessionID(session)) return null;
    // Stamped with the pane, terminal and run the feed was found for, and only while
    // that run is the pane's (never a kept feed's session for a later run).
    const run = chat.handle?.feed === chat.feed ? chat.handle.run : null;
    if (run === null || run.paneId !== chat.paneId || run.terminalID === "" || !this.isCurrent(run)) return null;
    this.noteFollowed(run, session);
    return { terminalID: run.terminalID, session };
  }

  /**
   * One bounded read of the Grok files of the pane's Chat (after a
   * pick, and for its settle), then what they say as a pick reads them; null when no Chat follows a Grok
   * session for the pane's current run.
   */
  async grokFiles(hostId: string, paneId: string): Promise<GrokFiles | null> {
    const chat = Array.from(this.windows.values()).find(
      (each) => each.hostId === hostId && each.paneId === paneId && each.handle !== null && each.handle.settings.format === "grok",
    );
    const handle = chat?.handle ?? null;
    if (handle === null || (handle.run !== null && !this.isCurrent(handle.run))) return null;
    if (!(await handle.refreshGrok())) return null;
    if (chat!.handle !== handle) return null;
    return grokFilesOf(handle.settings.settings);
  }

  /** The chips' values with the terminal and session they were read for (the identity the reader was made for). */
  private settingsOf(chat: WindowChat): PaneSettings | null {
    if (chat.settings === null || chat.feed === null || chat.settingsScope === null) return null;
    const pane = this.hosts.pane(chat.hostId, chat.paneId);
    const agent = this.hosts.agent(chat.hostId, chat.paneId);
    this.loadLimits(chat, chat.settings, agent?.cwd ?? pane?.cwd ?? null);
    return { ...chat.settings.settings, scope: chat.settingsScope, limits: chat.limits };
  }

  /**
   * The user's auto-compact settings beside the transcript read, read
   * once a minute at most (ContextSettings keeps them), again on a reconnect;
   * an update goes when they changed.
   */
  private loadLimits(chat: WindowChat, settings: AgentSettingsReader, cwd: string | null): void {
    const file = settings.file;
    const reader = chat.backend?.transcripts() ?? null;
    const format = settings.format;
    // Grok has no settings files the ring reads (nor Cursor).
    if (file === null || reader === null || format === "grok" || format === "cursor") return;
    if (isPiFormat(format)) return; // nor Pi or omp.
    if (isOpenCodeFormat(format)) return; // nor OpenCode or Kilo.
    // Nor Gemini CLI, Qwen Code or Antigravity.
    if (isGeminiFamilyFormat(format)) return;
    if (format === "copilot" || format === "droid") return; // nor Copilot or Droid
    if (format === "kimi") return; // nor Kimi
    // Nor Maki.
    if (format === "maki") return;
    if (isStoreAgentFormat(format)) return; // nor Hermes, Mastra Code or Cline.
    if (format === "kiro") return; // nor Kiro.
    const connection = this.hosts.connection?.(chat.hostId) ?? 0;
    const key = JSON.stringify([chat.hostId, connection, format, file, cwd]);
    const fresh = chat.limitsKey !== key;
    chat.limitsKey = key;
    if (fresh) chat.limits = null;
    void this.contextSettings.load(reader, `${chat.hostId}#${connection}`, format, file, cwd).then(
      (limits) => {
        if (chat.settings !== settings || chat.limitsKey !== key || this.windows.get(chatKey(chat.owner.id, chat.slot)) !== chat) return;
        if (JSON.stringify(limits) === JSON.stringify(chat.limits)) return;
        chat.limits = limits;
        this.emit(chat);
      },
      () => undefined,
    );
  }

  /**
   * A follow of this pane's session ended on a moved
   * ownership, and the pane still names that session with the same folders: none is started. Another session or
   * other folders clear the record (resolved afresh).
   */
  private ownershipMovedHolds(hostId: string, paneId: string, resolution: Extract<Resolution, { kind: "session" }>): boolean {
    const key = `${hostId}|${paneId}`;
    const moved = this.movedOwnership.get(key);
    if (moved === undefined) return false;
    if (moved.shelfKey === `${hostId}|${resolution.key}`) {
      // The pane's folders at the first look after the end are the ones it holds for.
      moved.folders ??= resolution.folders;
      if (sameFolders(moved.folders, resolution.folders)) return true;
    }
    this.movedOwnership.delete(key);
    return false;
  }

  /** The same session again while its feed is unavailable: started once more when its wait is over. */
  private retry(chat: WindowChat, feed: ChatFeed<TranscriptSessionRef>, resolution: Extract<Resolution, { kind: "session" }>): void {
    const now = this.now();
    if (now < chat.retryAt) return;
    chat.retryAt = now + Math.min(this.retryMaxMs, this.retryAfterMs * 2 ** chat.retries);
    chat.retries += 1;
    chat.retrying = true;
    if (chat.handle?.feed === feed) chat.handle.folders = resolution.folders;
    feed.start(resolution.ref, resolution.folders);
  }

  private received(chat: WindowChat, feed: ChatFeed<TranscriptSessionRef>, update: ChatFeedUpdate): void {
    if (chat.feed !== feed || this.windows.get(chatKey(chat.owner.id, chat.slot)) !== chat) return;
    if (chat.resuming) {
      if (update.state.status === "loading") return;
      chat.resuming = false;
    }
    if (chat.retrying) {
      // The page keeps the reason it shows until the retry has an answer, and a same answer changes nothing.
      if (update.state.status === "loading") return;
      chat.retrying = false;
      const same =
        update.state.status === "unavailable" && chat.state.status === "unavailable" && update.state.reason === chat.state.reason && update.state.folder === chat.state.folder;
      if (same) return;
    }
    // The cached chat stays on show until the feed's first read lands.
    if (chat.fromCache === true && update.state.status === "loading" && update.timeline.turns.length === 0) return;
    // The launch cache's items stay on show (catching up, no row action) while the live
    // read holds fewer and still reads its screenful back; never fewer than cached, never the newest few and
    // then the rest. Nothing of the live read is kept for the next launch meanwhile.
    if (chat.fromCache === true && update.state.status === "live" && holdsCache(chat.cachedItems ?? 0, update.timeline)) {
      const changed = chat.state.status !== "live" || chat.caughtUp;
      chat.state = update.state;
      chat.caughtUp = false;
      if (changed) this.emit(chat);
      return;
    }
    chat.fromCache = false;
    chat.cachedItems = 0;
    if (update.state.status === "live") {
      chat.retries = 0;
      chat.retryAt = 0;
      this.launchCache?.noteChat(chat.hostId, chat.paneId, update.timeline);
    }
    chat.state = update.state;
    chat.timeline = update.timeline;
    chat.caughtUp = update.caughtUp === true;
    this.emit(chat);
  }

  /** A state of the service's own (not an agent, no session, no reader): no feed runs. */
  private showOwn(chat: WindowChat, state: ChatViewState, key: string): void {
    if (chat.key === key && chat.feed === null) return;
    this.release(chat);
    chat.held = null;
    chat.key = key;
    chat.state = state;
    chat.timeline = emptyTimeline;
    chat.caughtUp = false;
    chat.fromCache = false;
    this.emit(chat);
  }

  private emit(chat: WindowChat): void {
    if (chat.owner.isDestroyed()) return;
    chat.settingsDue = false;
    const settings = this.settingsOf(chat);
    const followed = this.followedOf(chat);
    const event: ChatUpdateEvent = {
      hostId: chat.hostId,
      paneId: chat.paneId,
      state: chat.state,
      timeline: withoutFullDiffs(chat.timeline),
      ...(settings === null ? {} : { settings }),
      ...(followed === null ? {} : { followed }),
      // Said only once true (the live row starts then).
      ...(chat.caughtUp ? { caughtUp: true } : {}),
      ...(chat.fromCache === true ? { catchingUp: true } : {}),
    };
    chat.owner.send(this.channel, chat.follow === undefined ? event : { ...event, follow: chat.follow });
  }
}
