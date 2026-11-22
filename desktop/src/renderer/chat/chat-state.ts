// The page's side of Chat: the latest update from the main process for each
// pane this window follows, and your pending bubbles (src/shared/chat/pending.ts),
// renderer-wide so a bubble survives switching panes and tabs.

import type { ChatUpdateEvent, HerdrDesktopBridge, SendCheck, SendReceipt } from "../../shared/ipc-contract";
import { sendProofBoundMs } from "../../shared/claude-screen";
import { PendingBackstop, PendingMessages, type PaneScope } from "../../shared/chat/pending";
import type { UnprovedSend } from "../../shared/drafts";
import { draftKey } from "../components/composer-drafts";
import { agentPicks, turnAnchor } from "../components/agent-picks";
import { armedStops } from "../components/agent-stop";
import { handoffStore } from "../handoff/handoff-state";

export const pendingMessages = new PendingMessages();
/** No bubble says "Queued" until restart. */
export const pendingBackstop = new PendingBackstop(pendingMessages);
// A send that failed started no turn, so a stop armed for it goes.
pendingMessages.onFailed((id) => armedStops.cancelSend(id));
export const subscribePending = (onChange: () => void): (() => void) => pendingMessages.subscribe(onChange);

/**
 * The page's side of main's kept copies of picture messages past their Return (drafts.json `unproved`): each bubble
 * the transcript settles, or that is put back, dismissed or taken back, releases its copy and ends main's check (a
 * receipt that comes after the transcript settled its bubble too); each copy is told where its session's transcript
 * stood when it went (its bubble's baseline), so after a reload or a start its bubble (restoreUnproved) settles only
 * by its own message.
 */
export function attachSendKeeping(bridge: Pick<HerdrDesktopBridge, "unprovedRelease" | "sendCheckEnd" | "unprovedHistory">): () => void {
  const offReleased = pendingMessages.onReleased((item) => {
    if (item.kept !== undefined) void bridge.unprovedRelease?.(item.kept).catch(() => undefined);
    if (item.check !== undefined) void bridge.sendCheckEnd?.(item.check).catch(() => undefined);
  });
  const offHistory = pendingMessages.onHistory((kept, anchor) => {
    void bridge.unprovedHistory?.(kept, anchor).catch(() => undefined);
  });
  return () => {
    offReleased();
    offHistory();
  };
}

/**
 * Main's kept copies at launch (`add`): each comes back as its bubble, never into the composer; one still checking
 * turns "could not confirm" at its bound unless main's word comes first. Each time main's drafts change (`add` false):
 * main's newer word for the bubbles shown only (a send whose receipt is still on its way is never shown twice).
 */
export function restoreUnproved(entries: readonly UnprovedSend[], add = true, now: () => number = Date.now, wait: (ms: number) => Promise<void> = realWait): void {
  for (const restored of pendingMessages.restore(entries, now(), add)) {
    void wait(Math.max(0, restored.boundAt - now())).then(() => pendingMessages.unconfirmed(restored.id));
  }
}

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

  /**
   * Whether the pane's own Chat on screen says its session's transcript was not found (ChatView's notFound line): a
   * session named whose file is not written yet (Pi, Claude Code before their first message). False for a Chat not
   * on screen, loading, live, or unavailable for another reason.
   */
  transcriptNotFound(hostId: string, paneId: string): boolean {
    if (!this.followed(hostId, paneId)) return false;
    const state = this.forPane(hostId, paneId)?.state;
    return state?.status === "unavailable" && state.reason === "notFound";
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
      agentPicks.receive(draftKey(event.hostId, event.paneId), event.settings ?? null, turnAnchor(event.timeline.turns));
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

/** What follows a Send whose receipt names a check (a picture message to Claude Code). */
export interface SendFollow {
  /** The check's outcome by its id (the bridge's sendCheck); absent: an older bridge, so the receipt is the word. */
  readonly check?: (checkId: string) => Promise<SendCheck | null>;
  /** Waits `ms` (the bound; tests drive it). */
  readonly wait?: (ms: number) => Promise<void>;
}

function realWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends through the main process's Send rule; an agent pane's message shows at
 * once as a pending bubble, which goes when the transcript has it (or at once
 * when the send fails: the box keeps the text and its note).
 *
 * Resolves as soon as the keys and the Return went (so the composer empties then, its chips too). A receipt that
 * names a check keeps the bubble sending (past its Return: Esc's take-back may try it) until the check's outcome:
 * `taken` delivers it; `stillInBox` turns it "still in the terminal's box"; `unknown` (or no outcome) leaves it
 * sending. The bound (`sendProofBoundMs`) runs on its own clock from the receipt, raced against the check: once it
 * passes with the transcript not settling it, the bubble says Adari could not confirm it, and a later answer applies
 * only while the bubble is still there. Nothing is put back on the app's own word once the keys went.
 */
export function sendWithPending(
  send: (hostId: string, paneId: string, text: string) => Promise<SendReceipt | void>,
  hostId: string,
  paneId: string,
  text: string,
  isAgent: boolean,
  scope: PaneScope | null = null,
  now: () => number = Date.now,
  /** The pane's own Chat said its transcript was not found as it went (chatUpdates.transcriptNotFound). */
  noTranscript = false,
  follow: SendFollow = {},
): Promise<void> {
  const id = isAgent ? pendingMessages.add(draftKey(hostId, paneId), text, now(), scope, noTranscript) : null;
  return send(hostId, paneId, text).then(
    (receipt) => {
      if (id === null) return;
      const checkId = receipt?.check ?? null;
      if (checkId === null || follow.check === undefined) {
        pendingMessages.delivered(id);
        return;
      }
      pendingMessages.typed(id, { check: checkId, kept: receipt?.kept ?? null });
      void followCheck(id, follow.check(checkId), follow.wait ?? realWait);
    },
    (failure: unknown) => {
      if (id !== null) pendingMessages.failed(id);
      throw failure;
    },
  );
}

/**
 * The check's outcome for bubble `id` against the bound, which starts at the receipt on its own clock: a check that
 * never answers still ends in "could not confirm" at the bound; an answer after it applies only while the bubble is
 * still there (pending.checked).
 */
async function followCheck(id: string, checked: Promise<SendCheck | null>, wait: (ms: number) => Promise<void>): Promise<void> {
  const answer = checked.catch((): null => null);
  const bound = wait(sendProofBoundMs).then((): "bound" => "bound");
  const first = await Promise.race([answer, bound]);
  if (first === "taken" || first === "stillInBox") {
    pendingMessages.checked(id, first);
    return;
  }
  if (first !== "bound") await bound;
  pendingMessages.unconfirmed(id);
  if (first !== "bound") return;
  const late = await answer;
  if (late === "taken" || late === "stillInBox") pendingMessages.checked(id, late);
}
