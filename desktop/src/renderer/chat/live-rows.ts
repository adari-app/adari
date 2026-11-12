// The page's side of Chat's live row: for each pane whose Chat is on screen, the
// block the main process last read off its screen (IPC.chatLive), merged with
// the timeline that Chat shows (ChatLiveMerge, src/shared/chat/live-screen.ts).
// A read's block updates the merge over the pane's timeline as it is then (a
// new block's row waits until the feed has read the transcript to its end:
// ChatUpdateEvent.caughtUp); Chat shows `row(timeline)` at its end until the
// transcript's own text lands. When the reads stop because only the work
// ended (`keeping`), the row stays at most 2 s for its text to land (it goes
// the moment it does); any other stop ends it at once, as does the Chat
// leaving the pane.

import { liveLandingMs } from "../../shared/chat/live-reader";
import { ChatLiveMerge } from "../../shared/chat/live-screen";
import { emptyTimeline, type ChatTimeline } from "../../shared/chat/model";
import type { ChatLiveEvent, HerdrDesktopBridge } from "../../shared/ipc-contract";
import { draftKey } from "../components/composer-drafts";
import { chatUpdates } from "./chat-state";

export { liveLandingMs };

interface LivePane {
  merge: ChatLiveMerge;
  landing: ReturnType<typeof setTimeout> | null;
}

export class LiveRows {
  private readonly panes = new Map<string, LivePane>();
  private readonly listeners = new Set<() => void>();
  private serial = 0;
  private attached: (() => void) | null = null;

  constructor(
    /** The pane's timeline and caughtUp as its Chat has them now, and whether an event's follow is on screen. */
    private readonly chats: Pick<typeof chatUpdates, "forPane" | "accepts" | "followed"> = chatUpdates,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes with each change of any row (useSyncExternalStore's snapshot). */
  version = (): number => this.serial;

  /** Listens to the main process once for the page's life. */
  attach(bridge: HerdrDesktopBridge): void {
    if (this.attached !== null || bridge.onChatLive === undefined) return;
    this.attached = bridge.onChatLive((event) => this.receive(event));
  }

  /** The live row's text over `timeline` (the pane's own, as the transcript has it); null: none. */
  row(hostId: string, paneId: string, timeline: ChatTimeline): string | null {
    return this.panes.get(draftKey(hostId, paneId))?.merge.row(timeline) ?? null;
  }

  /** The merge for the pane (tests). */
  merge(hostId: string, paneId: string): ChatLiveMerge | null {
    return this.panes.get(draftKey(hostId, paneId))?.merge ?? null;
  }

  receive(event: ChatLiveEvent): void {
    if (!this.chats.accepts(event)) return;
    const key = draftKey(event.hostId, event.paneId);
    const pane = this.panes.get(key) ?? { merge: new ChatLiveMerge(), landing: null };
    const before = pane.merge.clone();
    this.endLanding(pane);
    if (event.type === "block") {
      const shown = this.chats.forPane(event.hostId, event.paneId);
      pane.merge.update(event.block, shown?.timeline ?? emptyTimeline, shown?.caughtUp === true);
    } else if (event.keeping && pane.merge.block !== null) {
      pane.landing = setTimeout(() => {
        if (this.panes.get(key) !== pane) return;
        pane.landing = null;
        pane.merge = new ChatLiveMerge();
        this.changed();
      }, liveLandingMs);
    } else {
      pane.merge = new ChatLiveMerge();
    }
    this.panes.set(key, pane);
    if (!pane.merge.equals(before)) this.changed();
  }

  /** The pane's Chat left the screen: its row goes, unless another Chat of it is still on screen. */
  left(hostId: string, paneId: string): void {
    if (this.chats.followed(hostId, paneId)) return;
    const key = draftKey(hostId, paneId);
    const pane = this.panes.get(key);
    if (pane === undefined) return;
    this.endLanding(pane);
    this.panes.delete(key);
    if (pane.merge.block !== null) this.changed();
  }

  clear(): void {
    for (const pane of this.panes.values()) this.endLanding(pane);
    this.panes.clear();
    this.changed();
  }

  private endLanding(pane: LivePane): void {
    if (pane.landing === null) return;
    clearTimeout(pane.landing);
    pane.landing = null;
  }

  private changed(): void {
    this.serial += 1;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

export const liveRows = new LiveRows();
