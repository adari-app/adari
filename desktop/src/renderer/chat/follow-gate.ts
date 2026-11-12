// The Chat lets go of the newest only on your own gesture (the
// T3 Code way: apps/web/src/components/chat/timelineViewport.ts). Your wheel or
// a key moving up, a touch, or a drag on the scrollbar makes the scroll events
// that follow your own for a short glide (a smooth scroll's animation, the
// trackpad's momentum); a UI command (a search or away reveal) lets go on its
// own. A scroll nobody made (the browser's scroll anchoring, our own pins and
// anchors, a clamp after the rows above shrank) never lets go: while following,
// the Chat goes back to its end. Following resumes at the end, on the New pill
// or on a send.
//
// The permission belongs to the navigation still going
// on. Following again (the end, New, a send), our own re-pins, a cancelled
// press, the window losing focus and the scroller going away revoke it; only a
// new gesture (each wheel event of a smooth scroll or of the trackpad's
// momentum renews it) grants it again.
//
// A press gives the glide after its
// release only when the press itself is known to navigate: a hit on a classic
// scrollbar, or a held press that moved the Chat up since it began or since
// the last revoke. T3 judges a pointer navigation when it happens
// (navigationReleasesFollow) and keeps no permission for later.

/** One thing you did that can move the Chat (as the browser reports it). */
export type ChatNavigation =
  | { readonly source: "wheel"; readonly deltaY: number; readonly ctrlKey: boolean }
  | { readonly source: "key"; readonly key: string; readonly shiftKey: boolean; readonly editable: boolean; readonly composing: boolean }
  | { readonly source: "touch" }
  /** `candidate`: a press in an overlay scrollbar's guessed strip: the bar, or the content under it. */
  | { readonly source: "pointerDown"; readonly onScrollbar: boolean; readonly candidate?: boolean }
  | { readonly source: "pointerUp" };

/** What a revoke keeps. */
export interface ChatGateRevoke {
  /** A scrollbar drag whose button is still down stays yours (it is the navigation still going on). */
  readonly keepsHeldDrag?: boolean;
}

/** The keys that scroll the Chat up (T3's UP_KEYS); Shift-Space pages up too. */
const upKeys = new Set(["PageUp", "Home", "ArrowUp"]);

export function scrollsUpKey(key: string, shiftKey: boolean): boolean {
  return upKeys.has(key) || (key === " " && shiftKey);
}

/** How long after your last wheel tick, key press, touch move or scrollbar drag a scroll is still yours (ms). */
export const gestureGlideMs = 400;

/** Whether the scroll events now are your own: armed by your gestures, never by a scroll. */
export class ChatFollowGate {
  private until = Number.NEGATIVE_INFINITY;
  private dragging = false;
  /** The held press is known to navigate, so its release gives the glide. */
  private navigates = false;

  heard(navigation: ChatNavigation, now: number): void {
    switch (navigation.source) {
      case "wheel":
        // Ctrl-wheel is zoom (a pinch), not a scroll; a wheel down never leaves the end.
        if (!navigation.ctrlKey && navigation.deltaY < 0) this.until = now + gestureGlideMs;
        return;
      case "key":
        // A key in the box (or any field) moves its caret, not the Chat.
        if (navigation.editable || navigation.composing) return;
        if (scrollsUpKey(navigation.key, navigation.shiftKey)) this.until = now + gestureGlideMs;
        return;
      case "touch":
        this.until = now + gestureGlideMs;
        return;
      case "pointerDown":
        // A drag on the scrollbar sends no wheel or key: the press on the scroller itself (not a row) starts one.
        // It owns scrolls while held. A hit on a classic bar is known to navigate; a strip
        // candidate is not until it moves the Chat up.
        if (!navigation.onScrollbar) return;
        this.dragging = true;
        this.navigates = navigation.candidate !== true;
        return;
      case "pointerUp":
        // A click on the track pages with an animation that outlives the press: only a press known to navigate gives it.
        if (this.dragging && this.navigates) this.until = now + gestureGlideMs;
        this.dragging = false;
        this.navigates = false;
        return;
    }
  }

  /** The Chat moved up while a press is held: the press navigates; its release gives the glide. */
  movedUp(): void {
    if (this.dragging) this.navigates = true;
  }

  /**
   * Ownership ends: the glide window, and the drag unless `keepsHeldDrag`. It never
   * grants a new window (pointer-up does: a track click's animation outlives the press; a cancel does not).
   * A drag still held keeps owning its scrolls, but its release gives the glide only if it
   * moves the Chat up again after this.
   */
  revoke(options: ChatGateRevoke = {}): void {
    this.until = Number.NEGATIVE_INFINITY;
    this.navigates = false;
    if (options.keepsHeldDrag !== true) this.dragging = false;
  }

  /** Whether a scroll event at `now` is your own. */
  ownScroll(now: number): boolean {
    return this.dragging || now <= this.until;
  }
}

/**
 * What a scroll event does to following:
 * - "follow": at the end; following (again, if it had let go);
 * - "release": your own scroll up left the end: following lets go;
 * - "pin": following, away from the end by a move you did not make: back to the end;
 * - "stay": let go and away from the end: nothing changes.
 */
export type ChatScrollOutcome = "follow" | "release" | "pin" | "stay";

export function chatScrollOutcome(scroll: {
  /** Following the newest before this event. */
  readonly following: boolean;
  /** Within the end band now. */
  readonly atEnd: boolean;
  /** scrollTop went up since the last event or pin. */
  readonly wentUp: boolean;
  /** The content got shorter since then: a clamp, not your move (T3's createUpwardScrollDetector). */
  readonly shrank: boolean;
  /** Your gesture armed the gate. */
  readonly own: boolean;
}): ChatScrollOutcome {
  if (scroll.atEnd) return "follow";
  if (!scroll.following) return "stay";
  return scroll.wentUp && scroll.own && !scroll.shrank ? "release" : "pin";
}

/** The overlay scrollbar's strip at the scroller's right edge (macOS draws it over the content, taking no room). */
export const overlayScrollbarPx = 16;

/**
 * Whether a press on the scroller itself (not a row) is on its scrollbar. The Chat's
 * column is narrower than the scroller (chat.css:8-9), so a press in the blank gutter beside it also lands
 * on the scroller: only the scrollbar's own area counts. A classic scrollbar takes room: outside the client
 * area (`clientLeft` to `clientLeft + clientWidth`; the left side covers a right-to-left scroller's bar). An
 * overlay one takes none: its strip at the right edge. With nothing to scroll there is no scrollbar.
 */
export function scrollbarHit(
  x: number,
  box: { readonly left: number; readonly width: number; readonly clientLeft: number; readonly clientWidth: number; readonly overflows: boolean },
): boolean {
  if (!box.overflows) return false;
  const at = x - box.left;
  if (classicScrollbar(box)) return at < box.clientLeft || at >= box.clientLeft + box.clientWidth;
  return at >= box.width - overlayScrollbarPx;
}

/** A classic scrollbar takes room, so a hit on it is sure; an overlay one's strip is only a guess. */
export function classicScrollbar(box: { readonly width: number; readonly clientWidth: number }): boolean {
  return box.width - box.clientWidth >= 1;
}

/** Whether a key event's target is a field (a key there moves a caret, never the Chat). */
export function editableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  return element.tagName === "TEXTAREA" || element.tagName === "INPUT" || element.tagName === "SELECT";
}
