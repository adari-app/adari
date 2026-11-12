// Opening a search result (or an away card) at its row in Chat. The
// result asks for the message; that pane's Chat takes the request, loads
// earlier messages until the row is there (or the start, or the chat's
// 2,000-message cap, is reached), scrolls it to the middle and marks it for a
// moment. A row Chat cannot reach gets a quiet note instead.

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import type { ChatTimeline } from "../../shared/chat/model";

export interface RevealRequest {
  readonly hostId: string;
  readonly paneId: string;
  /** The chat row's id; null opens the pane's Chat only (a very long message). */
  readonly messageId: string | null;
  readonly serial: number;
}

/** Earlier messages loaded at most for one request. */
export const maxRevealLoads = 50;
/** How long the row stays marked. */
export const revealMarkMs = 1_500;
/** How long the note stays. */
export const revealNoteMs = 6_000;
export const revealMissingText = "That message is too far back to show here.";

class RevealRequests {
  private pending: RevealRequest | null = null;
  private serial = 0;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ask(hostId: string, paneId: string, messageId: string | null): void {
    this.serial += 1;
    this.pending = { hostId, paneId, messageId, serial: this.serial };
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** The request for this pane, if one waits (not taken). */
  peek(hostId: string, paneId: string): RevealRequest | null {
    const request = this.pending;
    return request !== null && request.hostId === hostId && request.paneId === paneId ? request : null;
  }

  /** Takes the request (once). */
  take(serial: number): void {
    if (this.pending?.serial !== serial) return;
    this.pending = null;
    for (const listener of Array.from(this.listeners)) listener();
  }

  clear(): void {
    this.pending = null;
  }
}

/** The page's one queue of reveal requests. */
export const revealRequests = new RevealRequests();

/** Whether the timeline shows `id` (an item, or a call in a folded group). */
export function timelineHas(timeline: ChatTimeline, id: string): boolean {
  return timeline.turns.some((turn) => turn.items.some((item) => item.value.id === id));
}

export type RevealStep = { readonly kind: "found" } | { readonly kind: "load" } | { readonly kind: "wait" } | { readonly kind: "missing" };

/**
 * What to do for a message id now: there (found); earlier messages to load
 * (load, at most `maxRevealLoads` times); a read on its way or the chat still
 * loading (wait); or out of reach: the start, the cap, a failed read (missing).
 */
export function revealStep(timeline: ChatTimeline, id: string, loads: number, chatLoading: boolean): RevealStep {
  if (timelineHas(timeline, id)) return { kind: "found" };
  if (chatLoading && timeline.turns.length === 0) return { kind: "wait" };
  switch (timeline.earlier) {
    case "loading":
      return { kind: "wait" };
    case "available":
      return loads < maxRevealLoads ? { kind: "load" } : { kind: "missing" };
    default:
      return { kind: "missing" };
  }
}

export interface RevealOptions {
  readonly hostId: string;
  readonly paneId: string;
  readonly timeline: ChatTimeline;
  /** The chat has not read its transcript yet. */
  readonly chatLoading: boolean;
  /** The chat cannot show this pane's transcript. */
  readonly unavailable: boolean;
  readonly scroller: RefObject<HTMLDivElement | null>;
  loadEarlier(): void;
  /** Stops following the newest message (the row stays where it is put). */
  stopFollowing(): void;
}

/** The pane's Chat takes and carries out the reveal request; the note to show, if any. */
export function useReveal(options: RevealOptions): { readonly note: string | null } {
  const { hostId, paneId, timeline, chatLoading, unavailable, scroller, loadEarlier, stopFollowing } = options;
  const request = useSyncExternalStore(revealRequests.subscribe, () => revealRequests.peek(hostId, paneId));
  const loads = useRef<{ serial: number; count: number }>({ serial: -1, count: 0 });
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (request === null) return;
    if (loads.current.serial !== request.serial) loads.current = { serial: request.serial, count: 0 };
    if (request.messageId === null) {
      revealRequests.take(request.serial);
      return;
    }
    if (unavailable) {
      revealRequests.take(request.serial);
      return;
    }
    const step = revealStep(timeline, request.messageId, loads.current.count, chatLoading);
    switch (step.kind) {
      case "wait":
        return;
      case "load":
        loads.current.count += 1;
        loadEarlier();
        return;
      case "missing":
        revealRequests.take(request.serial);
        setNote(revealMissingText);
        return;
      case "found": {
        revealRequests.take(request.serial);
        stopFollowing();
        const id = request.messageId;
        // After the rows are laid out: the row in the middle, marked a moment.
        requestAnimationFrame(() => {
          const anchor = scroller.current?.querySelector(`[data-chat-ids~="${CSS.escape(id)}"]`) ?? null;
          const row = anchor?.nextElementSibling ?? null;
          if (row === null) return;
          row.scrollIntoView({ block: "center" });
          row.classList.add("chat-reveal");
          // A capture run keeps the mark until its picture is taken.
          if (!document.body.classList.contains("capturing")) setTimeout(() => row.classList.remove("chat-reveal"), revealMarkMs);
        });
        return;
      }
    }
  }, [request, timeline, chatLoading, unavailable, scroller, loadEarlier, stopFollowing]);

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), revealNoteMs);
    return () => clearTimeout(timer);
  }, [note]);

  return { note };
}
