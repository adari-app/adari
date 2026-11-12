// A sidebar you can widen, T3 Code's way
// (apps/web/src/components/ui/sidebar.tsx SidebarRail, hooks/useResizeDrag.ts,
// components/threadSidebarWidth.ts, AppSidebarLayout.tsx). Its right edge is
// dragged; the width is kept across launches; a double-click on the edge puts
// the default back (288 px); never under 256 px, and never so wide the main
// pane goes under its own minimum (T3 refuses such a width). The drag itself
// is T3's createResizeDrag, run here on a fake page (frames, blur, pointer
// capture); the Sidebar's wiring of it is in mac-sidebar-width-hook.test.ts.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  acceptsSidebarWidth,
  clampSidebarWidth,
  createResizeDrag,
  forgetSidebarWidth,
  keepSidebarWidth,
  mainMinWidth,
  readSidebarWidth,
  sidebarDefaultWidth,
  sidebarMaxWidth,
  sidebarMinWidth,
  sidebarWidthKey,
  type DragPage,
  type DragPointer,
  type ResizeSession,
} from "../src/renderer/components/sidebar-width";

class MemoryStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function fakePage() {
  const frames = new Map<number, () => void>();
  let next = 1;
  const blurs = new Set<() => void>();
  const dragging: boolean[] = [];
  const page: DragPage = {
    frame: (callback) => {
      const id = next++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    onBlur: (listener) => {
      blurs.add(listener);
      return () => blurs.delete(listener);
    },
    dragging: (on) => {
      dragging.push(on);
    },
  };
  return {
    page,
    frames,
    blurs,
    dragging,
    flush: () => {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame();
    },
    blur: () => {
      for (const listener of blurs) listener();
    },
  };
}

function fakeTarget() {
  const captured = new Set<number>();
  return {
    captured,
    setPointerCapture: (id: number) => {
      captured.add(id);
    },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => {
      captured.delete(id);
    },
  };
}

function pointer(clientX: number, target = fakeTarget(), pointerId = 1, button = 0): DragPointer {
  return { button, pointerId, clientX, currentTarget: target, preventDefault: () => undefined, stopPropagation: () => undefined };
}

/** The Sidebar's session, on a store: each width shown, the last kept when it moved, the start put back otherwise. */
function session(start: number, viewport: number, store: MemoryStore, shown: number[]): ResizeSession {
  let current = start;
  return {
    width: start,
    bounds: { min: sidebarMinWidth, max: sidebarMaxWidth(viewport) },
    resize(next) {
      if (acceptsSidebarWidth(current, next, viewport)) current = next;
      shown.push(current);
      return current;
    },
    finish(width, moved) {
      if (moved) keepSidebarWidth(store, width);
      else shown.push(start);
    },
    cleanup(committed) {
      if (!committed) shown.push(start);
    },
  };
}

describe("the sidebar's width", () => {
  it("defaults to 288 px, never goes under 256 px, and leaves the main pane its 552 px", () => {
    expect(sidebarDefaultWidth).toBe(288);
    expect(sidebarMinWidth).toBe(256);
    expect(mainMinWidth).toBe(552);
    // The window's smallest (840 px, window.ts) still takes the default: nothing allowed before is refused now.
    expect(clampSidebarWidth(288, 840)).toBe(288);
    expect(sidebarMaxWidth(1440)).toBe(888);
    expect(clampSidebarWidth(440, 1440)).toBe(440);
    expect(clampSidebarWidth(100, 1440)).toBe(256);
    expect(clampSidebarWidth(2_000, 1440)).toBe(888);
    // A window too small for both keeps the sidebar at its minimum.
    expect(clampSidebarWidth(400, 700)).toBe(256);
    expect(clampSidebarWidth(Number.NaN, 1440)).toBe(288);
  });

  it("refuses a wider width that would squeeze the main pane under its minimum, as T3's shouldAcceptWidth does; a narrower one always", () => {
    expect(acceptsSidebarWidth(300, 448, 1000)).toBe(true);
    expect(acceptsSidebarWidth(300, 449, 1000)).toBe(false);
    expect(acceptsSidebarWidth(500, 400, 900)).toBe(true);
  });

  it("is kept under adari.sidebar.width, read back on the next launch, and forgotten by a reset", () => {
    const store = new MemoryStore();
    expect(readSidebarWidth(store)).toBeNull();
    keepSidebarWidth(store, 440.4);
    expect(store.map.get(sidebarWidthKey)).toBe("440");
    // The next launch reads what the last one kept.
    expect(readSidebarWidth(store)).toBe(440);
    forgetSidebarWidth(store);
    expect(readSidebarWidth(store)).toBeNull();
    store.setItem(sidebarWidthKey, "wide");
    expect(readSidebarWidth(store)).toBeNull();
    expect(readSidebarWidth(null)).toBeNull();
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(readSidebarWidth(throwing)).toBeNull();
    expect(() => keepSidebarWidth(throwing, 300)).not.toThrow();
    expect(() => forgetSidebarWidth(throwing)).not.toThrow();
  });
});

describe("dragging the edge (T3's createResizeDrag)", () => {
  it("follows the pointer one frame at a time, keeps the width it is let go at, and captures and frees the pointer", () => {
    const { page, flush, dragging, frames } = fakePage();
    const drag = createResizeDrag(page);
    const store = new MemoryStore();
    const shown: number[] = [];
    const target = fakeTarget();
    drag.begin(pointer(288, target), () => session(288, 1440, store, shown));
    expect(target.captured.has(1)).toBe(true);
    expect(dragging).toEqual([true]);
    drag.onPointerMove(pointer(350, target));
    drag.onPointerMove(pointer(400, target));
    // One frame for both moves.
    expect(frames.size).toBe(1);
    flush();
    expect(shown).toEqual([400]);
    drag.onPointerUp(pointer(440, target));
    expect(shown).toEqual([400, 440]);
    expect(readSidebarWidth(store)).toBe(440);
    expect(target.captured.size).toBe(0);
    expect(dragging).toEqual([true, false]);
  });

  it("stops at 256 px going left and where the main pane keeps 552 px going right", () => {
    for (const [to, viewport, expected] of [
      [20, 1440, 256],
      [1_400, 1440, 888],
      [900, 1000, 448],
    ] as const) {
      const { page } = fakePage();
      const drag = createResizeDrag(page);
      const store = new MemoryStore();
      const shown: number[] = [];
      const target = fakeTarget();
      drag.begin(pointer(288, target), () => session(288, viewport, store, shown));
      drag.onPointerUp(pointer(to, target));
      expect(shown.at(-1), `to ${to} in ${viewport}`).toBe(expected);
      expect(readSidebarWidth(store)).toBe(expected);
    }
  });

  it("keeps nothing for a click without a move; a cancelled pointer, a lost capture or a blur ends it where the pointer last was (T3); cancel() keeps nothing", () => {
    const store = new MemoryStore();
    const click = fakePage();
    const shown: number[] = [];
    let drag = createResizeDrag(click.page);
    let target = fakeTarget();
    drag.begin(pointer(288, target), () => session(288, 1440, store, shown));
    drag.onPointerUp(pointer(289, target));
    expect(readSidebarWidth(store)).toBeNull();
    expect(shown.at(-1)).toBe(288);

    for (const [end, at] of [
      ["onPointerCancel", 500],
      ["onLostPointerCapture", 520],
    ] as const) {
      const fake = fakePage();
      drag = createResizeDrag(fake.page);
      target = fakeTarget();
      drag.begin(pointer(288, target), () => session(288, 1440, store, shown));
      drag.onPointerMove(pointer(at, target));
      // The end event's own position is not used: the last move is.
      drag[end](pointer(900, target));
      expect(readSidebarWidth(store), end).toBe(at);
      expect(fake.dragging.at(-1)).toBe(false);
      expect(fake.frames.size).toBe(0);
    }

    const away = fakePage();
    drag = createResizeDrag(away.page);
    target = fakeTarget();
    drag.begin(pointer(288, target), () => session(288, 1440, store, shown));
    drag.onPointerMove(pointer(360, target));
    away.blur();
    expect(readSidebarWidth(store)).toBe(360);
    expect(away.blurs.size).toBe(0);

    forgetSidebarWidth(store);
    const gone = fakePage();
    drag = createResizeDrag(gone.page);
    target = fakeTarget();
    drag.begin(pointer(288, target), () => session(288, 1440, store, shown));
    drag.onPointerMove(pointer(600, target));
    drag.cancel();
    gone.flush();
    expect(readSidebarWidth(store)).toBeNull();
    expect(shown.at(-1)).toBe(288);
    expect(target.captured.size).toBe(0);
  });

  it("starts only on the main button, one drag at a time, and not when the pointer cannot be captured", () => {
    const { page, dragging } = fakePage();
    const drag = createResizeDrag(page);
    const store = new MemoryStore();
    const shown: number[] = [];
    let started = 0;
    const start = () => {
      started += 1;
      return session(288, 1440, store, shown);
    };
    drag.begin(pointer(288, fakeTarget(), 1, 2), start);
    expect(started).toBe(0);
    const refusing = { ...fakeTarget(), setPointerCapture: () => { throw new Error("no such pointer"); } };
    drag.begin(pointer(288, refusing), start);
    expect(dragging).toEqual([]);
    const target = fakeTarget();
    drag.begin(pointer(288, target), start);
    // A second pointer while a drag is on is not asked to start one (T3's begin returns first).
    drag.begin(pointer(288, fakeTarget(), 2), start);
    expect(started).toBe(2);
    expect(dragging).toEqual([true]);
    // A pointer that is not the drag's moves nothing.
    drag.onPointerUp(pointer(600, target, 2));
    expect(readSidebarWidth(store)).toBeNull();
    drag.cancel();
    expect(dragging).toEqual([true, false]);
  });

  it("re-applies the pointer when the bounds change mid-drag (the window narrows)", () => {
    const { page, flush } = fakePage();
    const drag = createResizeDrag(page);
    const store = new MemoryStore();
    const shown: number[] = [];
    const target = fakeTarget();
    drag.begin(pointer(288, target), () => session(288, 1440, store, shown));
    drag.onPointerMove(pointer(700, target));
    flush();
    expect(shown.at(-1)).toBe(700);
    drag.refresh({ min: sidebarMinWidth, max: sidebarMaxWidth(1000) });
    expect(shown.at(-1)).toBe(448);
  });
});

describe("the edge in the style sheet", () => {
  const css = readFileSync(new URL("../src/renderer/styles/app.css", import.meta.url), "utf8");
  const rule = (selector: string): string => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";

  it("sits over the sidebar's right border with the resize cursor, outside the window's drag area, its line on hover", () => {
    expect(rule(".sb")).toMatch(/width: var\(--sb-w\)/);
    expect(rule(".sb")).toMatch(/position: relative/);
    const edge = rule(".sb-rail");
    expect(edge).toMatch(/position: absolute/);
    expect(edge).toMatch(/top: 0/);
    expect(edge).toMatch(/bottom: 0/);
    expect(edge).toMatch(/cursor: col-resize/);
    expect(edge).toMatch(/-webkit-app-region: no-drag/);
    expect(css).toMatch(/\.sb-rail:hover::after[^{]*\{[^}]*background: var\(--line-2\)/);
  });
});
