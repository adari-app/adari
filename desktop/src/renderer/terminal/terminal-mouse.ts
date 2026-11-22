// Presses, releases and drags in the terminal, as Ghostty sends them to a
// program that asked for the mouse (Ghostty's Surface.zig mouseButtonCallback
// and cursorPosCallback, input/mouse_encode.zig, and the macOS view's
// SurfaceView_AppKit.swift; ghostty.5: mouse-reporting true,
// mouse-shift-capture false). The wheel has its own path (terminal-input.ts).
//
// The program asked when it set one of the mouse event modes: 9 (X10: presses
// only, no modifiers), 1000 (presses and releases), 1002 (and motion while a
// button is held), 1003 (and all motion). Ghostty's VT core here keeps each
// mode as set; where a program set more than one, the widest is taken.
// Then, with Shift up:
// - the left, middle and right button's press and release go to the program
//   in the format it asked for (SGR 1006, SGR pixels 1016, urxvt 1015, UTF-8
//   1005, else X10 as raw bytes; nothing where X10 or UTF-8 cannot say the
//   cell, the wheel's own limits), the button 0, 1 or 2 plus Shift 4, Alt 8
//   and Ctrl 16 (none in mode 9), a release in the legacy formats as button 3;
// - motion goes once per cell the pointer enters (per pixel in SGR pixels),
//   plus 32, the first held button in Ghostty's order (left, right, middle) or
//   3 with none; out of the terminal only while a button is held, and Shift
//   held during a drag sends none (Ghostty's "Shift overrides mouse
//   grabbing");
// - a press whose bytes went always gets its release, wherever the pointer is
//   when the button comes up (held inside the grid), also when that release
//   was lost (the next move or press shows the button up) or the view goes
//   away first (the last point reported); a press the format cannot say
//   (X10 or UTF-8 past its limit) sends nothing and is followed by nothing;
// - only a release you made (a mouseup seen) of a press whose bytes went
//   counts as your own action for a program's copy (osc52.ts), never one the
//   app inferred or sent as the view went away;
// - the app's own selection never sees those events: they are stopped on the
//   terminal's frame, in the capture phase, before ghostty-web's listeners on
//   its host and canvas and on the document (its SelectionManager, its
//   scrollbar, the copy's double and triple click in terminal-copy.ts); the
//   canvas keeps the keyboard (ghostty-web's own press does that) and a right
//   button or Ctrl press reported leaves no context menu after it.
// What stays the app's, as today: every press with Shift held, and every
// press while the program has not asked; a ⌘-click on a link (it opens);
// a drag that began as the app's selection, to its end. The left press that
// only gives this terminal the keyboard (another tile, the drawer, the
// message box or another window had it) goes nowhere, as Ghostty's
// focus-only click: neither the program nor the selection gets it.

/** The mouse event mode a program asked for (Ghostty's MouseEvent). */
export type MouseEventMode = "x10" | "normal" | "button" | "any";

const MOUSE_X10 = 9;
const MOUSE_NORMAL = 1000;
const MOUSE_BUTTON = 1002;
const MOUSE_ANY = 1003;
const MOUSE_UTF8 = 1005;
const MOUSE_SGR = 1006;
const MOUSE_URXVT = 1015;
const MOUSE_SGR_PIXELS = 1016;

/** The mode in effect; null when the program has not asked for mouse reports. */
export function mouseEventMode(getMode: (mode: number) => boolean): MouseEventMode | null {
  const on = (mode: number): boolean => {
    try {
      return getMode(mode);
    } catch {
      return false;
    }
  };
  if (on(MOUSE_ANY)) return "any";
  if (on(MOUSE_BUTTON)) return "button";
  if (on(MOUSE_NORMAL)) return "normal";
  if (on(MOUSE_X10)) return "x10";
  return null;
}

export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

export interface MouseButtonEventLike extends PointerLike {
  /** 0 left, 1 middle, 2 right (MouseEvent.button). */
  readonly button: number;
  /** The buttons down (MouseEvent.buttons: 1 left, 2 right, 4 middle); missing where not known. */
  readonly buttons?: number;
}

/** Where the pointer is: its cell (1-based, held inside the grid) and its pixel inside the terminal (held inside it). */
export interface MousePoint {
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The point under the pointer on the terminal's canvas (its client rect), held inside it: a press, a drag or a
 * release outside the terminal says the nearest cell, as Ghostty's posToCell does.
 */
export function pointIn(
  event: PointerLike,
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  cellWidth: number,
  cellHeight: number,
  cols: number,
  rows: number,
): MousePoint {
  const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
  return {
    col: Math.min(cols, Math.max(1, Math.floor(x / Math.max(1, cellWidth)) + 1)),
    row: Math.min(rows, Math.max(1, Math.floor(y / Math.max(1, cellHeight)) + 1)),
    x,
    y,
  };
}

/** What the reports need of the terminal. */
export interface MouseSurface {
  getMode(mode: number): boolean;
  pointAt(event: PointerLike): MousePoint;
}

/** The left, middle or right button (MouseEvent.button; the same numbers as the report's). */
export type ProgramButton = 0 | 1 | 2;

type Action = "press" | "release" | "motion";

function shouldReport(mode: MouseEventMode, action: Action, button: ProgramButton | null): boolean {
  switch (mode) {
    case "x10":
      return action === "press" && button !== null;
    case "normal":
      return action !== "motion";
    case "button":
      return button !== null;
    case "any":
      return true;
  }
}

/** Ghostty's report encoder for one event, with the program's modes. */
export class MouseReports {
  /** The last point reported or tried (Ghostty's last_cell: a move in the same cell is not sent). */
  private last: MousePoint | null = null;
  /** The last point whose bytes went: where the program last saw the pointer. */
  private lastSent: MousePoint | null = null;

  constructor(
    private readonly surface: MouseSurface,
    private readonly send: (data: string | Uint8Array) => void,
  ) {}

  /** The mode in effect; null when the program takes no mouse reports. */
  mode(): MouseEventMode | null {
    return mouseEventMode((mode) => this.surface.getMode(mode));
  }

  /** True when bytes went to the program (none where the mode takes no press or the format cannot say the cell). */
  press(button: ProgramButton, event: PointerLike): boolean {
    return this.report("press", button, event);
  }

  /** True when bytes went to the program. */
  release(button: ProgramButton, event: PointerLike): boolean {
    return this.report("release", button, event);
  }

  /**
   * The release of a held press whose view is going away: at the last point reported (where the program last saw
   * the pointer), with `mods`, in the mode and format then in force. True when bytes went.
   */
  finish(button: ProgramButton, mods: PointerLike): boolean {
    return this.report("release", button, mods, this.lastSent ?? undefined);
  }

  /** A move: `button` the one held (null with none). Sent once per cell entered; true when bytes went. */
  motion(button: ProgramButton | null, event: PointerLike): boolean {
    return this.report("motion", button, event);
  }

  private on(mode: number): boolean {
    try {
      return this.surface.getMode(mode);
    } catch {
      return false;
    }
  }

  private report(action: Action, button: ProgramButton | null, event: PointerLike, at?: MousePoint): boolean {
    const mode = this.mode();
    if (mode === null || !shouldReport(mode, action, button)) return false;
    const point = at ?? this.surface.pointAt(event);
    const pixels = this.on(MOUSE_SGR_PIXELS);
    const last = this.last;
    if (action === "motion" && last !== null) {
      const same = pixels ? Math.round(last.x) === Math.round(point.x) && Math.round(last.y) === Math.round(point.y) : last.col === point.col && last.row === point.row;
      if (same) return false;
    }
    this.last = point;
    const data = this.encode(mode, action, button, event, point, pixels);
    if (data === null) return false;
    this.lastSent = point;
    this.send(data);
    return true;
  }

  /** The report's bytes; null where X10 or UTF-8 cannot say the cell (the wheel's limits). */
  private encode(mode: MouseEventMode, action: Action, button: ProgramButton | null, mods: PointerLike, point: MousePoint, pixels: boolean): string | Uint8Array | null {
    const sgr = pixels || this.on(MOUSE_SGR);
    let code = button === null || (action === "release" && !sgr) ? 3 : button;
    if (mode !== "x10") {
      if (mods.shiftKey) code += 4;
      if (mods.altKey) code += 8;
      if (mods.ctrlKey) code += 16;
    }
    if (action === "motion") code += 32;
    const final = action === "release" ? "m" : "M";
    if (pixels) return `\x1b[<${code};${Math.max(1, Math.round(point.x))};${Math.max(1, Math.round(point.y))}${final}`;
    if (sgr) return `\x1b[<${code};${point.col};${point.row}${final}`;
    if (this.on(MOUSE_URXVT)) return `\x1b[${32 + code};${point.col};${point.row}M`;
    if (this.on(MOUSE_UTF8)) {
      if (32 + point.col > 0x7ff || 32 + point.row > 0x7ff) return null;
      return `\x1b[M${String.fromCharCode(32 + code)}${String.fromCodePoint(32 + point.col)}${String.fromCodePoint(32 + point.row)}`;
    }
    if (32 + point.col > 255 || 32 + point.row > 255) return null;
    return Uint8Array.of(0x1b, 0x5b, 0x4d, 32 + code, 32 + point.col, 32 + point.row);
  }
}

interface ListenerTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: boolean | EventListenerOptions): void;
}

export interface TerminalMouseOptions {
  readonly reports: MouseReports;
  /** The terminal's frame: the parent of ghostty-web's host (its listeners are below it). */
  readonly frame: ListenerTarget;
  /** ghostty-web's canvas: only presses on it are the terminal's. */
  readonly canvas: unknown;
  /**
   * The document: presses (every fresh press, here or anywhere, ends what it proves ended), moves and releases
   * anywhere, the keyboard's place as a press begins, and `visibilitychange` (with `isHidden`).
   */
  readonly document: ListenerTarget;
  /**
   * The window: its `blur` (the window losing focus, also as it is hidden: the Mac's Close Window only hides it and
   * keeps every terminal attached) finishes a press the program holds. Absent where there is no window.
   */
  readonly window?: ListenerTarget;
  /** Whether the page is hidden now (document.visibilityState), read on `visibilitychange`. */
  isHidden?(): boolean;
  /** Whether this terminal has the keyboard in a focused window (read as a press begins, before the app moves focus). */
  hasKeyboard(): boolean;
  /** Gives the terminal the keyboard (what ghostty-web's own press does). */
  focus(): void;
  /** Whether this press is a link's ⌘-click (the link opens; the press stays the app's). */
  onLink(event: MouseButtonEventLike): boolean;
  /**
   * A release you made (a mouseup seen) of a press whose bytes went to the program: your own action in the tile
   * (osc52.ts). Never for a release the app only inferred, nor for one sent as the view goes away.
   */
  released(): void;
}

/** The DOM's bit in MouseEvent.buttons for each button. */
const buttonBit: Record<ProgramButton, number> = { 0: 1, 1: 4, 2: 2 };
/** Ghostty's order for the button a drag reports: left, right, middle. */
const motionOrder: readonly ProgramButton[] = [0, 2, 1];

function programButton(button: number): ProgramButton | null {
  return button === 0 || button === 1 || button === 2 ? button : null;
}

/**
 * Routes the terminal's presses, moves and releases (above). Two separate things end what it does:
 * - finishing the gesture: the release of every press the program still holds, once, at the last point reported
 *   (never as your action), with the listeners kept; on the window's blur or the page hidden, so the terminal works
 *   as before when the window is back;
 * - the returned function, for when the view goes away: finishes the gesture, then takes every listener back (also
 *   when sending that release throws); calling it again does nothing.
 */
export function installTerminalMouse(options: TerminalMouseOptions): () => void {
  const { reports, frame, canvas, document } = options;
  /** Presses whose bytes went to the program, until their release. */
  const held = new Set<ProgramButton>();
  /** The modifiers of the last report sent for a held press (the release at close carries them). */
  let lastMods: PointerLike | null = null;
  let closed = false;
  /** Focus-only presses, until their release. */
  const focusOnly = new Set<ProgramButton>();
  /** A left press that went to the app's selection, until its release. */
  let appDrag = false;
  /** Whether this terminal had the keyboard as the current press began. */
  let hadKeyboard = false;
  /** A press was reported whose context menu (right button, Ctrl-click) is not the app's. */
  let eatMenu = false;
  /** The last left press was not the app's (its double click is not ghostty-web's either). */
  let leftTaken = false;

  /** The protocol release; `seen` (a mouseup you made) also makes it your own action for a program's copy. */
  const releaseTo = (button: ProgramButton, event: MouseButtonEventLike, seen: boolean): void => {
    held.delete(button);
    reports.release(button, event);
    if (seen) options.released();
  };

  /**
   * A button that is up by the event's own account, its release never seen (it came up outside the window): the
   * program still gets its release, but an inferred release is never your action (it may come long after, from a
   * move anywhere).
   */
  const settle = (event: MouseButtonEventLike): void => {
    if (typeof event.buttons !== "number") return;
    const buttons = event.buttons;
    for (const button of held) if ((buttons & buttonBit[button]) === 0) releaseTo(button, event, false);
    for (const button of focusOnly) if ((buttons & buttonBit[button]) === 0) focusOnly.delete(button);
    if (appDrag && (buttons & buttonBit[0]) === 0) appDrag = false;
  };

  /**
   * Every fresh press, on this terminal, another tile or anywhere else in the window (the document sees it before any
   * frame does). A button pressed again proves its old press ended, its release never seen (it came up outside the
   * window, or the window lost it): that old press is retired as inferred, before the fresh press is routed, and the
   * fresh press's own release is then never taken for the old one's. The pressed button's own bit is down again in
   * `buttons`, so `button` says it; the other buttons the event shows up are settled the same way. A drag still going
   * (its button not pressed again) keeps its real release, also outside the tile.
   */
  const onDocumentPress = (raw: Event): void => {
    const event = raw as unknown as MouseButtonEventLike & Event;
    if (event.target === canvas) hadKeyboard = options.hasKeyboard();
    const button = programButton(event.button);
    if (button !== null) {
      if (held.has(button)) releaseTo(button, event, false);
      focusOnly.delete(button);
      if (button === 0) appDrag = false;
    }
    settle(event);
  };

  const onPress = (raw: Event): void => {
    if (raw.target !== canvas) return;
    const event = raw as unknown as MouseButtonEventLike & Event;
    eatMenu = false;
    settle(event);
    const button = programButton(event.button);
    if (button === null || appDrag) return;
    const taken = held.size > 0 || focusOnly.size > 0;
    if (!taken && (event.shiftKey || reports.mode() === null || options.onLink(event))) {
      // The app's, exactly as today.
      if (button === 0) {
        appDrag = true;
        leftTaken = false;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    options.focus();
    if (button === 0) leftTaken = true;
    if (button === 0 && !taken && !hadKeyboard) {
      focusOnly.add(0);
      return;
    }
    if (button === 2 || (button === 0 && event.ctrlKey)) eatMenu = true;
    if (held.has(button)) return;
    // Held only when its bytes went: a press the format cannot say (X10 or UTF-8 past their limit) does nothing at
    // all, no move, release or copy after it, and is not the app's selection either.
    if (reports.press(button, event)) {
      held.add(button);
      lastMods = event;
    }
  };

  const onMove = (raw: Event): void => {
    const event = raw as unknown as MouseButtonEventLike & Event;
    settle(event);
    if (appDrag) return;
    if (held.size > 0) {
      if (event.shiftKey) return;
      if (reports.motion(motionOrder.find((button) => held.has(button)) ?? null, event)) lastMods = event;
      return;
    }
    // No button of the program's held: a move over the terminal with no button down (mode 1003 only; a drag
    // begun elsewhere, in another tile or as a focus-only click, is not this program's).
    if (event.target === canvas && (event.buttons ?? 0) === 0) reports.motion(null, event);
  };

  const onRelease = (raw: Event): void => {
    const event = raw as unknown as MouseButtonEventLike & Event;
    const button = programButton(event.button);
    if (button === null) return;
    if (button === 0 && appDrag) {
      appDrag = false;
      return;
    }
    if (focusOnly.delete(button)) return;
    if (held.has(button)) releaseTo(button, event, true);
  };

  const onMenu = (event: Event): void => {
    if (event.target !== canvas || !eatMenu) return;
    eatMenu = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onDoubleClick = (event: Event): void => {
    if (event.target === canvas && leftTaken) event.stopPropagation();
  };

  /**
   * Finishing the gesture (not removing listeners): every press the program still holds gets its release now, once,
   * at the last point reported and with the modifiers then, in the mode and format in force (nothing where tracking
   * is now off), never as your action. Ownership is cleared also when sending throws; its later mouseup does nothing.
   */
  const finishHeld = (): void => {
    try {
      for (const button of held) if (lastMods !== null) reports.finish(button, lastMods);
    } finally {
      held.clear();
    }
  };

  /** The window lost focus (blurred, or hidden by Close Window): its mouseup may never come here. */
  const onWindowBlur = (): void => finishHeld();

  const onVisibility = (): void => {
    if (options.isHidden?.() === true) finishHeld();
  };

  const view = options.window;
  document.addEventListener("mousedown", onDocumentPress, { capture: true });
  document.addEventListener("mousemove", onMove, { capture: true });
  document.addEventListener("mouseup", onRelease, { capture: true });
  frame.addEventListener("mousedown", onPress, { capture: true });
  frame.addEventListener("contextmenu", onMenu, { capture: true });
  frame.addEventListener("dblclick", onDoubleClick, { capture: true });
  if (view !== undefined) {
    view.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    if (closed) return;
    closed = true;
    try {
      // The view goes away mid-press: the program gets its release now, while the port still takes it.
      finishHeld();
    } finally {
      // Removing the listeners, whatever that release did.
      focusOnly.clear();
      appDrag = false;
      document.removeEventListener("mousedown", onDocumentPress, { capture: true });
      document.removeEventListener("mousemove", onMove, { capture: true });
      document.removeEventListener("mouseup", onRelease, { capture: true });
      frame.removeEventListener("mousedown", onPress, { capture: true });
      frame.removeEventListener("contextmenu", onMenu, { capture: true });
      frame.removeEventListener("dblclick", onDoubleClick, { capture: true });
      if (view !== undefined) {
        view.removeEventListener("blur", onWindowBlur);
        document.removeEventListener("visibilitychange", onVisibility);
      }
    }
  };
}
