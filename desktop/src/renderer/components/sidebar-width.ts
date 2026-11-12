// The sidebar's width, T3 Code's way. Its right edge is
// dragged (T3 apps/web/src/hooks/useResizeDrag.ts createResizeDrag, ported
// with the page's frames, blur and body style passed in so it runs in tests);
// the width is kept in page storage across launches (T3 keeps its own in
// localStorage, threadSidebarWidth.ts); a double-click on the edge forgets it
// and puts the default back (T3's SidebarRail onDoubleClick). Never under
// 256 px, and never so wide the main pane goes under 552 px: the window's
// smallest (840 px, window.ts) less the default, so nothing allowed before is
// refused now. Like T3's shouldAcceptWidth, a wider width that would squeeze
// the main pane is refused and a narrower one always taken.

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

export const sidebarWidthKey = "adari.sidebar.width";
export const sidebarDefaultWidth = 288;
export const sidebarMinWidth = 256;
export const mainMinWidth = 552;

/** The widest the sidebar may be in a window `viewport` wide (never under its minimum). */
export function sidebarMaxWidth(viewport: number): number {
  return Math.max(sidebarMinWidth, Math.floor(viewport) - mainMinWidth);
}

/** `width` within the sidebar's minimum and the main pane's (a width that is not a number: the default). */
export function clampSidebarWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return sidebarDefaultWidth;
  return Math.max(sidebarMinWidth, Math.min(Math.round(width), sidebarMaxWidth(viewport)));
}

/** T3's shouldAcceptWidth: a narrower width always; a wider one only while the main pane keeps its minimum. */
export function acceptsSidebarWidth(current: number, next: number, viewport: number): boolean {
  return next <= current || viewport - next >= mainMinWidth;
}

/** The page's storage, as much of it as the width needs. */
export interface WidthStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The width the last launch kept (null: none, or not a width). */
export function readSidebarWidth(store: WidthStore | null): number | null {
  if (store === null) return null;
  try {
    const text = store.getItem(sidebarWidthKey);
    if (text === null || !/^\d+(\.\d+)?$/.test(text.trim())) return null;
    const width = Number(text);
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

export function keepSidebarWidth(store: WidthStore | null, width: number): void {
  try {
    store?.setItem(sidebarWidthKey, String(Math.round(width)));
  } catch {
    // A page whose storage refuses keeps the width for this launch only.
  }
}

export function forgetSidebarWidth(store: WidthStore | null): void {
  try {
    store?.removeItem(sidebarWidthKey);
  } catch {
    // Nothing kept to forget.
  }
}

export interface ResizeBounds {
  readonly min: number;
  readonly max: number;
}

/** One drag's own state and effects (T3's ResizeSession, for a right edge). */
export interface ResizeSession {
  readonly width: number;
  /** Pointer widths are clamped to these before `resize` sees them. */
  bounds: ResizeBounds;
  /** Shows `width` if it is taken; returns the width shown. */
  resize(width: number): number;
  /** The drag ended where the pointer was: `moved` false for a click. */
  finish(width: number, moved: boolean): void;
  /** Every end; `committed` false when the drag was abandoned. */
  cleanup?(committed: boolean): void;
}

/** As much of a pointer event as the drag reads. */
export interface DragPointer {
  readonly button: number;
  readonly pointerId: number;
  readonly clientX: number;
  readonly currentTarget: {
    setPointerCapture(pointerId: number): void;
    hasPointerCapture(pointerId: number): boolean;
    releasePointerCapture(pointerId: number): void;
  };
  preventDefault(): void;
  stopPropagation(): void;
}

/** The page under the drag: its frames, its window's blur, and the body's resize cursor. */
export interface DragPage {
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  /** Calls `listener` when the window loses focus; returns its removal. */
  onBlur(listener: () => void): () => void;
  /** The resize cursor (and no text selection) on the whole page while a drag is on. */
  dragging(on: boolean): void;
}

interface ActiveDrag {
  readonly session: ResizeSession;
  readonly target: DragPointer["currentTarget"];
  readonly pointerId: number;
  readonly startX: number;
  pendingX: number;
  width: number;
  moved: boolean;
  frame: number | null;
  stopBlur: () => void;
}

/** T3's createResizeDrag: pointer capture, one resize a frame, a blur or a lost pointer ends it where it was. */
export function createResizeDrag(page: DragPage) {
  let drag: ActiveDrag | null = null;

  const flush = (): void => {
    const active = drag;
    if (active === null) return;
    const delta = active.pendingX - active.startX;
    if (Math.abs(delta) > 2) active.moved = true;
    const { min, max } = active.session.bounds;
    active.width = active.session.resize(Math.max(min, Math.min(max, active.session.width + delta)));
  };

  const finish = (commit: boolean): void => {
    const active = drag;
    if (active === null) return;
    if (active.frame !== null) page.cancelFrame(active.frame);
    active.frame = null;
    active.stopBlur();
    if (commit) flush();
    // Releasing the pointer can send lostpointercapture at once: the drag is over before that.
    drag = null;
    try {
      if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    } catch {
      // The pointer is gone already.
    }
    page.dragging(false);
    active.session.cleanup?.(commit);
    if (commit) active.session.finish(active.width, active.moved);
  };

  const end = (event: DragPointer, usePosition: boolean): void => {
    const active = drag;
    if (active === null || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pendingX = event.clientX;
    finish(true);
  };

  return {
    begin(event: DragPointer, start: () => ResizeSession | null): void {
      if (event.button !== 0 || drag !== null) return;
      const session = start();
      if (session === null) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        session.cleanup?.(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      drag = {
        session,
        target: event.currentTarget,
        pointerId: event.pointerId,
        startX: event.clientX,
        pendingX: event.clientX,
        width: session.width,
        moved: false,
        frame: null,
        // Leaving the window mid-drag ends it where the pointer was.
        stopBlur: page.onBlur(() => finish(true)),
      };
      page.dragging(true);
    },
    onPointerMove(event: DragPointer): void {
      const active = drag;
      if (active === null || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingX = event.clientX;
      if (Math.abs(event.clientX - active.startX) > 2) active.moved = true;
      if (active.frame !== null) return;
      active.frame = page.frame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: DragPointer): void => end(event, true),
    onPointerCancel: (event: DragPointer): void => end(event, false),
    onLostPointerCapture: (event: DragPointer): void => end(event, false),
    /** Abandons the drag: nothing kept, the width it started at shown again. */
    cancel: (): void => finish(false),
    /** New bounds mid-drag (the window changed): the pointer's width again within them. */
    refresh(bounds?: ResizeBounds): void {
      if (drag === null) return;
      if (bounds !== undefined) drag.session.bounds = bounds;
      flush();
    },
  };
}

function pageStore(): WidthStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The page's own frames, blur and body (read when a drag runs, never while rendering). */
function livePage(): DragPage {
  return {
    frame: (callback) => requestAnimationFrame(() => callback()),
    cancelFrame: (id) => cancelAnimationFrame(id),
    onBlur: (listener) => {
      window.addEventListener("blur", listener);
      return () => window.removeEventListener("blur", listener);
    },
    dragging: (on) => {
      const style = document.body.style;
      if (on) {
        style.cursor = "col-resize";
        style.userSelect = "none";
      } else {
        style.removeProperty("cursor");
        style.removeProperty("user-select");
      }
    },
  };
}

/** The window, where there is one that can be listened to (none while rendering outside a page). */
function listenableWindow(): Window | null {
  return typeof window === "undefined" || typeof window.addEventListener !== "function" ? null : window;
}

function subscribeViewport(onChange: () => void): () => void {
  const win = listenableWindow();
  if (win === null) return () => undefined;
  win.addEventListener("resize", onChange);
  return () => win.removeEventListener("resize", onChange);
}

const viewportWidth = (): number => {
  const width = listenableWindow()?.innerWidth;
  return typeof width === "number" && width > 0 ? width : Number.POSITIVE_INFINITY;
};
const noViewport = (): number => Number.POSITIVE_INFINITY;

/** A pointer event on the edge, whose parent is the sidebar. */
type EdgePointer = DragPointer & { readonly currentTarget: DragPointer["currentTarget"] & { readonly parentElement: { readonly style: { setProperty(name: string, value: string): void } } | null } };

/**
 * The sidebar's width now (the kept one, or the default, within the window) as its `--sb-w`, and its edge's
 * handlers: a drag shows each width on the sidebar itself, frame by frame, and keeps the one it is let go at;
 * a double-click forgets it.
 */
export function useSidebarWidth() {
  const viewport = useSyncExternalStore(subscribeViewport, viewportWidth, noViewport);
  const [kept, setKept] = useState<number | null>(() => readSidebarWidth(pageStore()));
  const width = clampSidebarWidth(kept ?? sidebarDefaultWidth, viewport);
  const live = useRef({ width, viewport });
  live.current = { width, viewport };
  // Created once: a drag lives across renders (the machines' list re-renders every few seconds).
  const [drag] = useState(() => createResizeDrag(livePage()));
  const max = sidebarMaxWidth(viewport);
  useEffect(() => {
    drag.refresh({ min: sidebarMinWidth, max });
  }, [drag, max]);
  useEffect(() => () => drag.cancel(), [drag]);

  const start = (event: EdgePointer): ResizeSession => {
    const aside = event.currentTarget.parentElement;
    const from = live.current.width;
    let shown = from;
    const show = (value: number): void => aside?.style.setProperty("--sb-w", `${value}px`);
    return {
      width: from,
      bounds: { min: sidebarMinWidth, max: sidebarMaxWidth(live.current.viewport) },
      resize(next) {
        if (acceptsSidebarWidth(shown, next, live.current.viewport)) {
          shown = next;
          show(shown);
        }
        return shown;
      },
      finish(final, moved) {
        if (!moved) {
          show(from);
          return;
        }
        keepSidebarWidth(pageStore(), final);
        setKept(final);
      },
      cleanup(committed) {
        if (!committed) show(from);
      },
    };
  };

  return {
    width,
    style: { "--sb-w": `${width}px` } as CSSProperties,
    edge: {
      onPointerDown: (event: EdgePointer) => drag.begin(event, () => start(event)),
      onPointerMove: (event: DragPointer) => drag.onPointerMove(event),
      onPointerUp: (event: DragPointer) => drag.onPointerUp(event),
      onPointerCancel: (event: DragPointer) => drag.onPointerCancel(event),
      onLostPointerCapture: (event: DragPointer) => drag.onLostPointerCapture(event),
      onDoubleClick: () => {
        drag.cancel();
        forgetSidebarWidth(pageStore());
        setKept(null);
      },
    },
  };
}
