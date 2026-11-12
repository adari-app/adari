// The page's side of Chat: the latest update from the main process for each
// pane this window follows, and your pending bubbles (src/shared/chat/pending.ts),
// renderer-wide so a bubble survives switching panes and tabs.

import type { ChatUpdateEvent, HerdrDesktopBridge } from "../../shared/ipc-contract";
import { PendingBackstop, PendingMessages, type PaneScope } from "../../shared/chat/pending";
import { draftKey } from "../components/composer-drafts";
import { agentPicks } from "../components/agent-picks";
import { armedStops } from "../components/agent-stop";
import { handoffStore } from "../handoff/handoff-state";

export const pendingMessages = new PendingMessages();
/** No bubble says "Queued" until restart. */
export const pendingBackstop = new PendingBackstop(pendingMessages);
// A send that failed started no turn, so a stop armed for it goes.
pendingMessages.onFailed((id) => armedStops.cancelSend(id));
export const subscribePending = (onChange: () => void): (() => void) => pendingMessages.subscribe(onChange);

/**
 * The newest update for each pane whose Chat shows (one, or each tile's).
 * Only the Chats followed now are kept: a Chat
 * registers when it mounts (`follow`, a new generation each time) and
 * unregisters before its slot closes (`unfollow`); an update for a pane not
 * followed, or from an earlier follow of it, is dropped.
 */
class ChatUpdates {
  private current: ChatUpdateEvent | null = null;
  private readonly panes = new Map<string, ChatUpdateEvent>();
  /** The pane's follows on screen now (one in practice: a window shows a pane once), by draftKey. */
  private readonly follows = new Map<string, Set<number>>();
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private attached: (() => void) | null = null;

  /** The newest update of any pane. */
  get(): ChatUpdateEvent | null {
    return this.current;
  }

  /** The newest update for the pane, or null. */
  forPane(hostId: string, paneId: string): ChatUpdateEvent | null {
    return this.panes.get(draftKey(hostId, paneId)) ?? null;
  }

  /** A Chat of the pane comes on screen: its generation, passed to openChat and echoed on its updates. */
  follow(hostId: string, paneId: string): number {
    this.generation += 1;
    const key = draftKey(hostId, paneId);
    const follows = this.follows.get(key) ?? new Set<number>();
    follows.add(this.generation);
    this.follows.set(key, follows);
    return this.generation;
  }

  /** That Chat left the screen: what it showed is no longer kept, nor anything that comes for it later. */
  unfollow(hostId: string, paneId: string, follow: number): void {
    const key = draftKey(hostId, paneId);
    const follows = this.follows.get(key);
    if (follows === undefined || !follows.delete(follow) || follows.size > 0) return;
    this.follows.delete(key);
    this.panes.delete(key);
    if (this.current !== null && draftKey(this.current.hostId, this.current.paneId) === key) this.current = null;
  }

  /** Whether a Chat of the pane is on screen. */
  followed(hostId: string, paneId: string): boolean {
    return this.follows.has(draftKey(hostId, paneId));
  }

  /** A live event is for a Chat followed now (and from that follow, when it says), as an update is. */
  accepts(event: Pick<ChatUpdateEvent, "hostId" | "paneId" | "follow">): boolean {
    return this.takes(event);
  }

  /** Whether the update is for a Chat followed now (and from that follow, when it says). */
  private takes(event: Pick<ChatUpdateEvent, "hostId" | "paneId" | "follow">): boolean {
    const follows = this.follows.get(draftKey(event.hostId, event.paneId));
    return follows !== undefined && (event.follow === undefined || follows.has(event.follow));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Listens to the main process once for the page's life. */
  attach(bridge: HerdrDesktopBridge): void {
    if (this.attached !== null) return;
    this.attached = bridge.onChatUpdate((event) => {
      if (!this.takes(event)) return;
      this.current = event;
      this.panes.set(draftKey(event.hostId, event.paneId), event);
      pendingMessages.observe(draftKey(event.hostId, event.paneId), event.timeline, event.state.status === "live");
      // The Model and Effort chips' values, and the turn a confirmed pick's quiet line goes in.
      agentPicks.receive(draftKey(event.hostId, event.paneId), event.settings ?? null, event.timeline.turns.at(-1)?.id ?? null);
      // The Grok session Chat follows, for the Resume chip once the agent leaves.
      if (event.followed !== undefined) handoffStore.life.followed(event.hostId, event.paneId, event.followed);
      for (const listener of Array.from(this.listeners)) listener();
    });
  }
}

export const chatUpdates = new ChatUpdates();

/**
 * Your sends from this Mac's box, counted per pane:
 * each one that adds a row (a message, pictures, a typed / command's row)
 * takes that pane's Chat to its end, following again, wherever you were
 * scrolled. Per pane, so a send in another tile does not move this one.
 */
export class ChatSends {
  private readonly counts = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** How many sends the pane's box has made (0 before the first). */
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** You sent from the pane's box. */
  sent(key: string): void {
    this.counts.set(key, this.count(key) + 1);
    for (const listener of Array.from(this.listeners)) listener();
  }
}

export const chatSends = new ChatSends();

/**
 * Sends through the main process's Send rule; an agent pane's message shows at
 * once as a pending bubble, which goes when the transcript has it (or at once
 * when the send fails: the box keeps the text and its note).
 */
export function sendWithPending(
  send: (hostId: string, paneId: string, text: string) => Promise<void>,
  hostId: string,
  paneId: string,
  text: string,
  isAgent: boolean,
  scope: PaneScope | null = null,
  now: () => number = Date.now,
): Promise<void> {
  const id = isAgent ? pendingMessages.add(draftKey(hostId, paneId), text, now(), scope) : null;
  return send(hostId, paneId, text).then(
    () => {
      if (id !== null) pendingMessages.delivered(id);
    },
    (failure: unknown) => {
      if (id !== null) pendingMessages.failed(id);
      throw failure;
    },
  );
}
