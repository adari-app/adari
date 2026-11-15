// Moving a workspace up or down the Projects tab by dragging its header. T3
// Code's sidebar drags its rows with dnd-kit once the pointer has moved 6 px
// (apps/web/src/components/Sidebar.tsx, SIDEBAR_DRAG_DISTANCE); Adari adds no
// dependency, so this is the same with pointer events on the window:
//
// - a press on a header that moves less than 6 px is still a plain click;
// - past 6 px the workspace drags: a line shows the slot it lands in (before
//   the first header whose middle is below the pointer, else after the last),
//   the list scrolls while the pointer is near its top or bottom edge, and
//   letting go puts it there (the click the release sends is swallowed);
// - Esc cancels (it is the drag's own then, never Stop), as do the window
//   losing focus, a cancelled pointer, a lost pointer capture (an active drag
//   captures the pointer to its header) and a move that shows the button is no
//   longer held (a release the window never heard of); nothing moves;
// - the dragged workspace no longer shown (it went, its machine went, was
//   folded or lost its snapshot) ends the drag at once: nothing is left of it.
//
// The page (window listeners, the headers' boxes, the list's edges and
// scroll, frames) is passed in, so the drag runs in tests without a DOM.

import { escapeOwners } from "./escape-owners";

/** How far the pointer moves before a press on a header becomes a drag (T3 Code's SIDEBAR_DRAG_DISTANCE). */
export const workspaceDragDistance = 6;
/** How near the list's top or bottom edge (px) the pointer scrolls the list. */
export const edgeZone = 36;
/** The most the list scrolls in one frame (px), with the pointer at or past the edge. */
export const maxScrollStep = 14;

/** One workspace section of the dragged one's machine, top to bottom, as on screen. */
export interface DropBox {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

/** The slot (0 to boxes.length) a drop at `y` lands in: before the first box whose middle is below `y`, else last. */
export function dropSlot(boxes: readonly DropBox[], y: number): number {
  const at = boxes.findIndex((box) => y < (box.top + box.bottom) / 2);
  return at < 0 ? boxes.length : at;
}

/** How much the list scrolls this frame with the pointer at `y`: up near its top, down near its bottom, else 0. */
export function edgeScroll(edges: { readonly top: number; readonly bottom: number } | null, y: number): number {
  if (edges === null || edges.bottom - edges.top < edgeZone * 2) return 0;
  const step = (depth: number): number => Math.ceil((Math.min(edgeZone, depth) / edgeZone) * maxScrollStep);
  if (y < edges.top + edgeZone) return -step(edges.top + edgeZone - y);
  if (y > edges.bottom - edgeZone) return step(y - (edges.bottom - edgeZone));
  return 0;
}

/** What the sidebar draws while a workspace drags: its line at `slot` of the machine's sections. */
export interface WorkspaceDragShown {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly slot: number;
}

/** The element a press was on, as much of it as pointer capture needs. */
export interface DragCaptureTarget {
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
}

export interface DragPointerEvent {
  readonly button: number;
  /** The buttons held (absent: not known); a move without the primary one means the release was missed. */
  readonly buttons?: number;
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  /** The header pressed: an active drag captures the pointer to it (absent: no capture). */
  readonly currentTarget?: DragCaptureTarget | null;
}

/** A pointer event as the window hears it during a press (its currentTarget is the window, not the header). */
export type DragWindowPointer = Omit<DragPointerEvent, "currentTarget">;

export interface DragKeyEvent {
  readonly key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface WorkspaceDragListeners {
  move(event: DragWindowPointer): void;
  up(event: DragWindowPointer): void;
  cancel(event: DragWindowPointer): void;
  /** The pointer's capture lost (the header went from the page, or the system took it). */
  lost(event: DragWindowPointer): void;
  key(event: DragKeyEvent): void;
  blur(): void;
}

/** The page under the drag. */
export interface WorkspaceDragPage {
  /** The window's pointer moves, releases, cancels and lost captures, its keys (before anything else sees them) and its blur; returns their removal. */
  listen(listeners: WorkspaceDragListeners): () => void;
  /** The machine's workspace sections as on screen now, top to bottom. */
  boxes(hostId: string): DropBox[];
  /** The list's visible top and bottom (null: no list). */
  edges(): { readonly top: number; readonly bottom: number } | null;
  scrollBy(dy: number): void;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  /** Runs `callback` a task later (after the click a release sends). */
  later(callback: () => void): void;
  /** Holds Esc for the drag (escape-owners); returns the release. */
  holdEscape(): () => void;
  /** The grabbing cursor (and no text selection) on the whole page while a drag is on. */
  dragging(on: boolean): void;
}

export interface WorkspaceDragEnds {
  /** The line to draw, or null: none. */
  show(shown: WorkspaceDragShown | null): void;
  /** Let go: the workspace goes before `before` (a workspace id of the same machine), or last when null. */
  drop(hostId: string, workspaceId: string, before: string | null): void;
}

interface Press {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  y: number;
  phase: "pressed" | "dragging" | "cancelled";
  boxes: DropBox[];
  slot: number;
  frame: number | null;
  stop: () => void;
  release: (() => void) | null;
  readonly target: DragCaptureTarget | null;
  captured: boolean;
}

export function createWorkspaceDrag(page: WorkspaceDragPage, ends: WorkspaceDragEnds) {
  let press: Press | null = null;
  let swallowClick = false;

  /**
   * The boxes again and the line's slot; false (and the drag abandoned) when the dragged workspace is no
   * longer among them (it went, or its machine did).
   */
  const place = (p: Press): boolean => {
    p.boxes = page.boxes(p.hostId);
    if (!p.boxes.some((box) => box.id === p.workspaceId)) {
      finish(false, false);
      return false;
    }
    const slot = dropSlot(p.boxes, p.y);
    if (slot === p.slot) return true;
    p.slot = slot;
    ends.show({ hostId: p.hostId, workspaceId: p.workspaceId, slot });
    return true;
  };

  const tick = (): void => {
    const p = press;
    if (p === null || p.phase !== "dragging") return;
    p.frame = null;
    const dy = edgeScroll(page.edges(), p.y);
    if (dy === 0) return;
    page.scrollBy(dy);
    if (!place(p)) return;
    p.frame = page.frame(tick);
  };

  /** The drag's look goes (its line, the cursor, its hold on Esc, its pointer capture). */
  const unshow = (p: Press): void => {
    if (p.frame !== null) page.cancelFrame(p.frame);
    p.frame = null;
    p.release?.();
    p.release = null;
    if (p.captured) {
      p.captured = false;
      try {
        if (p.target?.hasPointerCapture(p.pointerId) === true) p.target.releasePointerCapture(p.pointerId);
      } catch {
        // The pointer or the header is gone already.
      }
    }
    page.dragging(false);
    ends.show(null);
  };

  /**
   * The press ends: dropped where its line is (`drop`), or not. `swallow`: the click the release sends next is the
   * drag's (false when no release of this press is coming to the header: its source went, or the release was missed).
   */
  const finish = (drop: boolean, swallow = true): void => {
    const p = press;
    if (p === null) return;
    press = null;
    p.stop();
    if (p.phase === "pressed") return;
    const dragging = p.phase === "dragging";
    p.phase = "cancelled";
    if (dragging) unshow(p);
    if (swallow) {
      // The click this release sends is the drag's, not the header's.
      swallowClick = true;
      page.later(() => {
        swallowClick = false;
      });
    }
    if (drop && dragging) ends.drop(p.hostId, p.workspaceId, p.boxes[p.slot]?.id ?? null);
  };

  const begin = (p: Press): void => {
    const boxes = page.boxes(p.hostId);
    if (!boxes.some((box) => box.id === p.workspaceId)) {
      finish(false, false);
      return;
    }
    p.phase = "dragging";
    p.release = page.holdEscape();
    page.dragging(true);
    // The pointer stays the drag's until it is let go, wherever it goes (a lost capture cancels).
    try {
      p.target?.setPointerCapture(p.pointerId);
      p.captured = p.target !== null;
    } catch {
      p.captured = false;
    }
    p.slot = -1;
    place(p);
  };

  const listeners: WorkspaceDragListeners = {
    move(event) {
      const p = press;
      if (p === null || event.pointerId !== p.pointerId) return;
      // The primary button is up, yet no release came (let go outside the window): it ends, nothing moves.
      if (event.buttons !== undefined && (event.buttons & 1) === 0) {
        finish(false, false);
        return;
      }
      p.y = event.clientY;
      if (p.phase === "pressed") {
        if (Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < workspaceDragDistance) return;
        begin(p);
      } else if (p.phase === "dragging") {
        if (!place(p)) return;
      }
      if (press !== p || p.phase !== "dragging") return;
      if (p.frame === null && edgeScroll(page.edges(), p.y) !== 0) p.frame = page.frame(tick);
    },
    up(event) {
      const p = press;
      if (p === null || event.pointerId !== p.pointerId) return;
      p.y = event.clientY;
      if (p.phase === "dragging" && !place(p)) return;
      finish(true);
    },
    cancel(event) {
      if (press === null || event.pointerId !== press.pointerId) return;
      finish(false);
    },
    lost(event) {
      // Only an active drag's capture counts (releasing it ourselves sends this too, after the drag has ended).
      const p = press;
      if (p === null || event.pointerId !== p.pointerId || p.phase !== "dragging" || !p.captured) return;
      p.captured = false;
      finish(false, false);
    },
    key(event) {
      const p = press;
      if (p === null || p.phase !== "dragging" || event.key !== "Escape") return;
      // Esc is the drag's own: it cancels, and nothing else (Stop, a menu) sees it.
      event.preventDefault();
      event.stopPropagation();
      p.phase = "cancelled";
      unshow(p);
    },
    blur: () => finish(false),
  };

  return {
    /** A press on a workspace header (`enabled` false: no drag, as while searching). */
    press(event: DragPointerEvent, hostId: string, workspaceId: string, enabled: boolean): void {
      if (!enabled || event.button !== 0 || press !== null) return;
      press = {
        hostId,
        workspaceId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        y: event.clientY,
        phase: "pressed",
        boxes: [],
        slot: -1,
        frame: null,
        stop: () => undefined,
        release: null,
        target: event.currentTarget ?? null,
        captured: false,
      };
      press.stop = page.listen(listeners);
    },
    /**
     * Ends the press, as if it never moved anything, when its workspace is no longer shown (`shown` false:
     * the workspace or its machine gone, its machine folded or without its snapshot). Called on every render.
     */
    keepIf(shown: (hostId: string, workspaceId: string) => boolean): void {
      if (press !== null && !shown(press.hostId, press.workspaceId)) finish(false, false);
    },
    /** The header's click: true when it is a drag's release (the header does nothing with it). */
    takeClick(): boolean {
      if (!swallowClick) return false;
      swallowClick = false;
      return true;
    },
    /** Whether a workspace is being dragged now. */
    active: (): boolean => press?.phase === "dragging",
    /** Abandons any drag: nothing moves. */
    cancel: (): void => finish(false),
  };
}

export type WorkspaceDrag = ReturnType<typeof createWorkspaceDrag>;

interface Rect {
  readonly top: number;
  readonly bottom: number;
}

interface ListElement {
  getBoundingClientRect(): Rect;
  scrollBy(options: { top: number }): void;
  querySelectorAll(selector: string): ArrayLike<{ getBoundingClientRect(): Rect; getAttribute(name: string): string | null }>;
}

/** The sidebar's list (read when a drag runs, never while rendering). */
function list(): ListElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(".sb-list") as ListElement | null;
}

/** The page's own window, list, frames and body. */
export function liveWorkspaceDragPage(): WorkspaceDragPage {
  return {
    listen(listeners) {
      const move = (event: PointerEvent): void => listeners.move(event);
      const up = (event: PointerEvent): void => listeners.up(event);
      const cancel = (event: PointerEvent): void => listeners.cancel(event);
      const lost = (event: PointerEvent): void => listeners.lost(event);
      const key = (event: KeyboardEvent): void => listeners.key(event);
      const blur = (): void => listeners.blur();
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("lostpointercapture", lost, true);
      window.addEventListener("keydown", key, true);
      window.addEventListener("blur", blur);
      return () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", cancel, true);
        window.removeEventListener("lostpointercapture", lost, true);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("blur", blur);
      };
    },
    boxes(hostId) {
      const sections = list()?.querySelectorAll(`[data-host="${CSS.escape(hostId)}"] [data-ws-section]`);
      if (sections === undefined) return [];
      return Array.from(sections, (section) => {
        const box = section.getBoundingClientRect();
        return { id: section.getAttribute("data-ws-section") ?? "", top: box.top, bottom: box.bottom };
      });
    },
    edges() {
      const box = list()?.getBoundingClientRect();
      return box === undefined ? null : { top: box.top, bottom: box.bottom };
    },
    scrollBy: (dy) => list()?.scrollBy({ top: dy }),
    frame: (callback) => requestAnimationFrame(() => callback()),
    cancelFrame: (id) => cancelAnimationFrame(id),
    later: (callback) => void setTimeout(callback, 0),
    holdEscape: () => escapeOwners.hold(),
    dragging(on) {
      const style = document.body.style;
      if (on) {
        style.cursor = "grabbing";
        style.userSelect = "none";
      } else {
        style.removeProperty("cursor");
        style.removeProperty("user-select");
      }
    },
  };
}
