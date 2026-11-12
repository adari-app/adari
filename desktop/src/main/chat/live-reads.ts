// The reads behind Chat's live row (the Swift app's
// CompanionChatLiveRule, CompanionChatLiveController's follow and stop, and
// CompanionModel.liveScreenRead, for each Chat on screen).
//
// - While a Chat on screen (ChatService.shown: its window in sight) shows a
//   pane whose agent is Claude or Codex (liveKinds; ChatLiveScreen reads
//   either's screen), or Cursor, whose screen it reads too, and Herdr says
//   working, and only while its
//   machine is connected, the pane's screen is read with the needs-you card's
//   `paneRead` (`pane.read`, source recent, plain text, 80 lines) about every
//   400 ms by a ChatLiveReader: the next read only once the last has answered.
//   No other pane is read.
// - Each read's block goes to that Chat's page (IPC.chatLive, its follow
//   number), which merges it with the timeline it shows (the renderer's
//   live-rows.ts). A read that comes back after the Chat closed or moved, or
//   for a pane whose terminal, agent session, machine entry or connection
//   changed, is dropped: nothing goes to the page.
// - The reads stop when the pane stops working, its Chat closes or shows
//   another pane, the machine stops answering, or the window goes out of
//   sight; a stop tells the page whether the row may stay a moment for its
//   text to land (`keeping`: only the work ended, the Chat still on show and
//   the machine connected, as the Swift app's stop(keeping:)) or goes now.
//   The row is kept only while the pane's terminal, agent
//   session, machine entry, connection and agent are the ones the reads
//   began with; and through the page's wait the reads' identity is kept, so a
//   change of any of them then (or the Chat closing or moving) ends the row at
//   once: no text of a previous terminal, session or connection shows in the
//   Chat that replaced it. That identity is held as long as the
//   page's row can be (the page's wait starts when the stop reaches it, maybe
//   late): while the Chat stays shown and is not being read, one record per
//   Chat, released only by a new follow, an identity change (its stop sent)
//   or the Chat leaving or moving; no clock of main's own.
// - One read of a pane at a time: the readers share a PaneReadGate with the
//   needs-you card's reads (src/main/prompt/prompts.ts), so a pane both would
//   read is never read twice at once; the one that finds it out waits a turn.
// - A shown Chat of a Cursor pane (its machine
//   connected) has its footer read for the chips (`options.footer`): one read
//   when it shows (or its terminal, session, connection or agent changes), one
//   when its turn ends, never on a timer while idle; while it works, the live
//   reads' own screens carry it. A footer goes to the page only when it
//   changed, with the terminal and session it was read under.
// - The same for a shown Chat of a Claude Code or Grok pane
//   (`options.mode`): its screen read once on show (or a new identity) and
//   when its turn ends, never on a timer while idle; while Claude works, the
//   live reads' own screens carry it (Grok has none). Its approval mode
//   (approval-modes.ts: Claude's footer row, Grok's border) goes to the page
//   only when it changed, with the terminal, session, connection and run.
//   A screen with no mode that reads (a dialog, an
//   unknown footer row) sends nothing, so the chip keeps the last mode read
//   under the same identity; a new identity still starts with none.
// - A shown Cursor pane that does not work has
//   its footer read again every idleFooterMs (the next read only once the last
//   answered): a `/model` the user types in its terminal starts no turn, so neither
//   the live reads nor a turn's end would read the model line it leaves.

import { ChatLiveReader, PaneReadGate } from "../../shared/chat/live-reader";
import { ChatLiveScreen, type ChatLiveBlock } from "../../shared/chat/live-screen";
import type { ChatLiveEvent, CursorFooterEvent, PaneModeEvent } from "../../shared/ipc-contract";
import { cursorModelLineOf, parseCursorFooter, readGrokScreen, screenMode } from "../../shared/agent-settings";
import { agentKind, agentSession } from "../../shared/send-binding";
import { agentStatusFromWire } from "../../shared/sidebar-model";
import { paneBlocked } from "../../shared/prompt/view";
import type { HerdrHostBackend } from "../herdr/backend";
import type { AgentInfo, TopologyPaneInfo } from "../herdr/wire";
import type { ConnectionIdentity } from "../hosts";
import type { ShownChat } from "./service";

/** What the reads need of the machines (HostRegistry has it all). */
export interface LiveHosts {
  backend(hostId: string): HerdrHostBackend | null;
  /** The answering connection's number; null while it does not answer. */
  connection(hostId: string): number | null;
  connectionIdentity(hostId: string): ConnectionIdentity | null;
  pane(hostId: string, paneId: string): TopologyPaneInfo | null;
  agent(hostId: string, paneId: string): AgentInfo | null;
  /** The connection and the pane's agent run (HostRegistry.run). */
  run?(hostId: string, paneId: string): { connection: number; arrival: number } | null;
}

/** The agents whose screens read (Claude Code's, Codex's and Cursor's layouts, ChatLiveScreen). */
export const liveKinds: ReadonlySet<string> = new Set(["claude", "codex", "cursor"]);

/** The pane's key in the read gate: the same as the needs-you card's watch key. */
export const paneReadKey = (hostId: string, paneId: string): string => `${hostId}\u0000${paneId}`;

/** Herdr says the pane's agent works (the sidebar's rule: working, and no question pending). */
export function paneWorking(pane: TopologyPaneInfo, agent: AgentInfo | null): boolean {
  return agentStatusFromWire(pane.agentStatus) === "working" && !paneBlocked(pane, agent);
}

interface LiveFollow {
  /** The Chat as last seen (its follow number may change on a re-open of the same pane). */
  chat: ShownChat;
  readonly hostId: string;
  readonly paneId: string;
  /** The machine entry, connection, terminal and session the reads are for. */
  readonly key: string;
  readonly reader: ChatLiveReader;
}

const chatKey = (chat: ShownChat): string => `${chat.owner.id}\n${chat.slot}`;

/**
 * A keeping stop's row, maybe still waiting for its text on the page: the
 * identity it was read under, held while its Chat stays shown (tied to the
 * Chat and the identity, not to a clock).
 */
interface LiveLanding {
  readonly chat: ShownChat;
  readonly key: string;
}

export interface LiveReadsOptions {
  /** The panes with a read out, shared with the needs-you card's reads. */
  readonly gate?: PaneReadGate;
  readonly intervalMs?: number;
  /** A shown Cursor pane's footer, to its Chat's page. */
  readonly footer?: (chat: ShownChat, event: CursorFooterEvent) => void;
  /** A shown Claude or Grok pane's approval mode, to its Chat's page. */
  readonly mode?: (chat: ShownChat, event: PaneModeEvent) => void;
  /** The wait between two footer reads of a shown idle Cursor pane (idleFooterMs). */
  readonly idleFooterMs?: number;
}

/** A shown idle Cursor pane's footer is read this often (a change the user made in its terminal). */
export const idleFooterMs = 2_500;

/** A shown Cursor Chat whose footer is read: under which identity, whether it worked at the last look, what went last. */
interface FooterWatch {
  chat: ShownChat;
  readonly identity: string;
  /** What is read off its screen: Cursor's footer, or Claude's or Grok's mode. */
  readonly kind: WatchKind;
  working: boolean;
  last: string | null;
  serial: number;
  /** The next idle read of a Cursor watch, waiting (null: none). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** The agents whose shown Chats have their screen watched: Cursor's footer, Claude's and Grok's mode. */
type WatchKind = "cursor" | "claude" | "grok";

export class LiveReads {
  private readonly follows = new Map<string, LiveFollow>();
  /** The keeping stops whose rows may still be on the page, by Chat (until the Chat leaves, reads again or its identity changes). */
  private readonly landings = new Map<string, LiveLanding>();
  private readonly gate: PaneReadGate;
  private readonly intervalMs: number;
  private readonly footerSink: ((chat: ShownChat, event: CursorFooterEvent) => void) | null;
  private readonly modeSink: ((chat: ShownChat, event: PaneModeEvent) => void) | null;
  private readonly footers = new Map<string, FooterWatch>();
  private readonly idleFooterMs: number;

  constructor(
    private readonly hosts: LiveHosts,
    /** The Chats on screen now (ChatService.shown). */
    private readonly chats: () => readonly ShownChat[],
    /** Sends an event to the Chat's page (IPC.chatLive on its window). */
    private readonly post: (chat: ShownChat, event: ChatLiveEvent) => void,
    options: LiveReadsOptions = {},
  ) {
    this.gate = options.gate ?? new PaneReadGate();
    this.intervalMs = options.intervalMs ?? ChatLiveReader.intervalMs;
    this.footerSink = options.footer ?? null;
    this.modeSink = options.mode ?? null;
    this.idleFooterMs = options.idleFooterMs ?? idleFooterMs;
  }

  /** The panes read now, as `hostId pane` (tests). */
  get following(): string[] {
    return [...this.follows.values()].map((follow) => `${follow.hostId} ${follow.paneId}`);
  }

  /**
   * The key of the reads `chat` wants now: its pane's machine entry,
   * connection, terminal and session while the pane's Claude, Codex or Cursor works and the
   * machine answers; null when it wants none.
   */
  wanted(chat: ShownChat): string | null {
    const { hostId, paneId } = chat;
    const pane = this.hosts.pane(hostId, paneId);
    if (pane === null) return null;
    const agent = this.hosts.agent(hostId, paneId);
    const kind = agentKind(agent, pane);
    if (kind === null || !liveKinds.has(kind) || !paneWorking(pane, agent)) return null;
    return this.identity(chat);
  }

  /**
   * The machine entry, connection, terminal, session and agent of the chat's
   * pane (the agent too, since more than one agent's screen reads);
   * null while it does not answer or cannot be read.
   */
  private identity(chat: ShownChat): string | null {
    const { hostId, paneId } = chat;
    const pane = this.hosts.pane(hostId, paneId);
    const connection = this.hosts.connection(hostId);
    const identity = this.hosts.connectionIdentity(hostId);
    if (pane === null || connection === null || identity === null) return null;
    if (this.hosts.backend(hostId)?.promptIO === undefined) return null;
    const agent = this.hosts.agent(hostId, paneId);
    return JSON.stringify([identity.incarnation, connection, identity.epoch, pane.terminalID, agentSession(agent), agentKind(agent, pane)]);
  }

  /** Looks at every Chat on screen again: reads start, go on, or stop. */
  sync(): void {
    const shown = new Map<string, ShownChat>();
    for (const chat of this.chats()) if (!chat.owner.isDestroyed()) shown.set(chatKey(chat), chat);
    // A row waiting for its text: gone at once when its Chat closed or moved or its identity changed; let go when the reads begin again under it.
    for (const [key, landing] of Array.from(this.landings)) {
      const chat = shown.get(key);
      const same = chat !== undefined && chat.hostId === landing.chat.hostId && chat.paneId === landing.chat.paneId && this.keeps(chat, landing.key);
      if (same && this.wanted(chat) === null) continue;
      this.endLanding(key);
      if (!same) this.send(landing.chat, { type: "stop", hostId: landing.chat.hostId, paneId: landing.chat.paneId, keeping: false });
    }
    for (const [key, follow] of Array.from(this.follows)) {
      const chat = shown.get(key);
      const samePane = chat !== undefined && chat.hostId === follow.hostId && chat.paneId === follow.paneId;
      const wanted = chat === undefined ? null : this.wanted(chat);
      if (samePane && wanted === follow.key) {
        follow.chat = chat;
        continue;
      }
      follow.reader.close();
      this.follows.delete(key);
      // Only the work ended, the Chat still on show and its machine connected under the reads' own identity:
      // the row stays a moment for its text, and main watches that identity meanwhile.
      const keeping = chat !== undefined && samePane && wanted === null && this.keeps(chat, follow.key) && !this.stillWorking(chat);
      this.send(follow.chat, { type: "stop", hostId: follow.hostId, paneId: follow.paneId, keeping });
      if (keeping) {
        this.landings.set(key, { chat: follow.chat, key: follow.key });
      }
    }
    for (const [key, chat] of shown) {
      if (this.follows.has(key)) continue;
      const wanted = this.wanted(chat);
      if (wanted !== null) this.start(key, chat, wanted);
    }
    this.syncFooters(shown);
  }

  /** The shown Cursor Chats' footers (and Claude's and Grok's modes): read on show (or a new identity) and when a turn ends. */
  private syncFooters(shown: ReadonlyMap<string, ShownChat>): void {
    if (this.footerSink === null && this.modeSink === null) return;
    for (const [key, watch] of Array.from(this.footers)) {
      const chat = shown.get(key);
      if (chat === undefined || chat.hostId !== watch.chat.hostId || chat.paneId !== watch.chat.paneId || this.watchIdentity(chat)?.identity !== watch.identity) this.dropWatch(key, watch);
    }
    for (const [key, chat] of shown) {
      const watched = this.watchIdentity(chat);
      if (watched === null) continue;
      const { identity, kind } = watched;
      const working = this.stillWorking(chat);
      const watch = this.footers.get(key);
      if (watch === undefined) {
        const fresh: FooterWatch = { chat, identity, kind, working, last: null, serial: 0, timer: null };
        this.footers.set(key, fresh);
        // A new identity's page cache is cleared before its read (an unread footer shows none).
        this.footerSeen(key, fresh, null);
        // Working: the live reads' first screen carries it.
        if (!working) this.readFooter(key, fresh);
        continue;
      }
      watch.chat = chat;
      const ended = watch.working && !working;
      watch.working = working;
      if (ended) this.readFooter(key, watch);
    }
  }

  /** The identity of a chat's pane while it runs Cursor (or Claude or Grok, with a mode sink) and its machine answers; else null. */
  private watchIdentity(chat: ShownChat): { identity: string; kind: WatchKind } | null {
    const pane = this.hosts.pane(chat.hostId, chat.paneId);
    if (pane === null) return null;
    const kind = agentKind(this.hosts.agent(chat.hostId, chat.paneId), pane);
    const watched = kind === "cursor" ? this.footerSink !== null : (kind === "claude" || kind === "grok") && this.modeSink !== null;
    if (!watched) return null;
    const identity = this.identity(chat);
    return identity === null ? null : { identity, kind: kind as WatchKind };
  }

  private readFooter(key: string, watch: FooterWatch): void {
    const { hostId, paneId } = watch.chat;
    const io = this.hosts.backend(hostId)?.promptIO?.();
    if (io === undefined) return;
    watch.serial += 1;
    const serial = watch.serial;
    void this.gate.reading(paneReadKey(hostId, paneId), () => io.paneRead(paneId, ChatLiveScreen.readLines)).then(
      (screen) => {
        if (watch.serial === serial) this.footerSeen(key, watch, screen);
        this.idleAgain(key, watch);
      },
      () => this.idleAgain(key, watch),
    );
  }

  /**
   * A shown Cursor watch whose pane does not work reads its footer again after
   * idleFooterMs (one waiting at a time; none once the watch went, its identity changed or the pane works: the live
   * reads carry it then, and its turn's end reads it and starts these again).
   */
  private idleAgain(key: string, watch: FooterWatch): void {
    if (watch.kind !== "cursor" || watch.timer !== null || this.footers.get(key) !== watch) return;
    const timer = setTimeout(() => {
      watch.timer = null;
      if (this.footers.get(key) !== watch || this.watchIdentity(watch.chat)?.identity !== watch.identity || this.stillWorking(watch.chat)) return;
      this.readFooter(key, watch);
    }, this.idleFooterMs);
    timer.unref?.();
    watch.timer = timer;
  }

  private dropWatch(key: string, watch: FooterWatch): void {
    if (watch.timer !== null) clearTimeout(watch.timer);
    watch.timer = null;
    if (this.footers.get(key) === watch) this.footers.delete(key);
  }

  /**
   * A screen of a pane read now (a live read, a pick's last
   * read): its footer goes to each shown Chat of the pane that watches it.
   */
  noteScreen(hostId: string, paneId: string, screen: string): void {
    for (const [key, watch] of Array.from(this.footers)) {
      if (watch.chat.hostId === hostId && watch.chat.paneId === paneId) this.footerSeen(key, watch, screen);
    }
  }

  /**
   * A Cursor `/model <id>` was typed into the pane: its footer changes with no
   * turn ending to read it, so each shown Chat of the pane that watches its footer reads it again after a moment
   * (twice: Cursor redraws its footer once the model has switched).
   */
  lookAgain(hostId: string, paneId: string, delaysMs: readonly number[] = [900, 2_500]): void {
    for (const ms of delaysMs) {
      const timer = setTimeout(() => {
        for (const [key, watch] of Array.from(this.footers)) {
          if (watch.kind === "cursor" && watch.chat.hostId === hostId && watch.chat.paneId === paneId) this.readFooter(key, watch);
        }
      }, ms);
      timer.unref?.();
    }
  }

  /**
   * A Permissions pick on a pane ended: its last
   * screen (null: none read) goes as noteScreen's, then a Claude or Grok watch
   * of the pane sends its next read even when it shows the same mode (the
   * page retires the pick's warning on it).
   */
  notePick(hostId: string, paneId: string, screen: string | null): void {
    if (screen !== null) this.noteScreen(hostId, paneId, screen);
    for (const watch of this.footers.values()) {
      if (watch.kind !== "cursor" && watch.chat.hostId === hostId && watch.chat.paneId === paneId) watch.last = null;
    }
  }

  /** The footer (or the mode) on `screen` (null: none read yet) to the Chat's page, when it changed and the pane is still under the watch's identity. */
  private footerSeen(key: string, watch: FooterWatch, screen: string | null): void {
    if (this.footers.get(key) !== watch || this.watchIdentity(watch.chat)?.identity !== watch.identity) return;
    const seen = watch.kind === "cursor" ? (screen === null ? null : parseCursorFooter(screen)) : screen === null ? null : screenMode(watch.kind, screen);
    // A screen read with no mode on it (a dialog, a footer row that does not read) keeps the
    // last mode read under this identity; only a screen that shows a mode changes it. A new identity's first send
    // (screen null) still clears it. Cursor's footer is not held back by this.
    if (watch.kind !== "cursor" && screen !== null && seen === null) return;
    // Cursor's model line when no footer reads ("Composer 2.5 Fast", "Auto"), whoever changed it;
    // Grok's border's model name with its mode ("Grok 4.7 Fast"). Each goes only when there is one.
    const line = watch.kind === "cursor" && seen === null && screen !== null ? cursorModelLineOf(screen) : null;
    const border = watch.kind === "grok" && screen !== null ? (readGrokScreen(screen)?.borderModel ?? null) : null;
    const text = JSON.stringify(line === null && border === null ? seen : { seen, line, border });
    if (text === watch.last) return;
    watch.last = text;
    const { hostId, paneId } = watch.chat;
    const pane = this.hosts.pane(hostId, paneId);
    if (pane === null || watch.chat.owner.isDestroyed()) return;
    const scope = { terminalID: pane.terminalID, session: agentSession(this.hosts.agent(hostId, paneId)) };
    const run = this.hosts.run?.(hostId, paneId) ?? null;
    if (watch.kind === "cursor") this.footerSink?.(watch.chat, { hostId, paneId, scope, run, footer: seen as CursorFooterEvent["footer"], ...(line === null ? {} : { modelLine: line }) });
    else this.modeSink?.(watch.chat, { hostId, paneId, agent: watch.kind, scope, run, mode: seen as string | null, ...(border === null ? {} : { borderModel: border }) });
  }

  /** Stops every read (the app quits). */
  closeAll(): void {
    for (const follow of this.follows.values()) follow.reader.close();
    this.follows.clear();
    for (const key of Array.from(this.landings.keys())) this.endLanding(key);
    for (const [key, watch] of Array.from(this.footers)) this.dropWatch(key, watch);
  }

  /** The chat's pane is still under the reads' identity `key`, its agent one whose screen reads. */
  private keeps(chat: ShownChat, key: string): boolean {
    const pane = this.hosts.pane(chat.hostId, chat.paneId);
    const kind = pane === null ? null : agentKind(this.hosts.agent(chat.hostId, chat.paneId), pane);
    return kind !== null && liveKinds.has(kind) && this.identity(chat) === key;
  }

  private endLanding(key: string): void {
    this.landings.delete(key);
  }

  private stillWorking(chat: ShownChat): boolean {
    const pane = this.hosts.pane(chat.hostId, chat.paneId);
    return pane !== null && paneWorking(pane, this.hosts.agent(chat.hostId, chat.paneId));
  }

  private start(key: string, chat: ShownChat, wanted: string): void {
    const { hostId, paneId } = chat;
    let follow: LiveFollow | null = null;
    const reader = new ChatLiveReader((_pane, block) => this.delivered(key, follow, block), { intervalMs: this.intervalMs, gate: this.gate });
    follow = { chat, hostId, paneId, key: wanted, reader };
    this.follows.set(key, follow);
    const calls = (): ReturnType<NonNullable<HerdrHostBackend["promptIO"]>> | null => this.hosts.backend(hostId)?.promptIO?.() ?? null;
    // The pane's agent picks its screen's reader (the identity `wanted` holds it too).
    const pane = this.hosts.pane(hostId, paneId);
    const kind = pane === null ? null : agentKind(this.hosts.agent(hostId, paneId), pane);
    reader.follow(
      paneReadKey(hostId, paneId),
      wanted,
      () => {
        const io = calls();
        if (io === null) return Promise.reject(new Error("the machine cannot be read"));
        const read = io.paneRead(paneId, ChatLiveScreen.readLines);
        // While Cursor works, its footer comes from these reads (and Claude's mode).
        const noted = kind === "cursor" || (kind === "claude" && this.modeSink !== null);
        return noted ? read.then((screen) => (this.noteScreen(hostId, paneId, screen), screen)) : read;
      },
      kind,
    );
  }

  /** A read's block: to the page only while its follow is current and its pane, terminal, session and connection are the same. */
  private delivered(key: string, follow: LiveFollow | null, block: ChatLiveBlock | null): void {
    if (follow === null || this.follows.get(key) !== follow) return;
    if (this.identity(follow.chat) !== follow.key) return;
    this.send(follow.chat, { type: "block", hostId: follow.hostId, paneId: follow.paneId, block });
  }

  private send(chat: ShownChat, event: ChatLiveEvent): void {
    if (chat.owner.isDestroyed()) return;
    this.post(chat, chat.follow === undefined ? event : { ...event, follow: chat.follow });
  }
}
