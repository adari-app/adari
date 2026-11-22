// Presses, releases and drags reach a program that asked for the mouse, as in
// Ghostty (Surface.zig mouseButtonCallback and cursorPosCallback,
// input/mouse_encode.zig; ghostty.5 mouse-reporting true, mouse-shift-capture
// false):
// - the reports, against Ghostty's own VT core (the WASM build) fed the modes
//   a program sends: each event mode (9, 1000, 1002, 1003) in each format
//   (SGR, SGR pixels, urxvt, UTF-8, X10), the three buttons, Alt and Ctrl, a
//   drag one report per cell, a release outside the grid, X10's and UTF-8's
//   limits, nothing with no event mode;
// - the routing, over ghostty-web's real SelectionManager and the app's copy
//   (terminal-copy.ts) on a few DOM nodes that pass events as Chromium does:
//   Shift and no tracking keep today's selection and copy; a press the
//   program took never starts, extends or clears a selection, never copies;
//   a drag stays whose it began as; the right button's menu, the focus-only
//   click, the release outside the window or lost;
// - the canvas with the real mouse events terminal-capture.ts makes.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Ghostty, SelectionManager } from "ghostty-web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { selectInTerminal } from "../src/renderer/terminal/terminal-capture";
import { installSelectionCopy } from "../src/renderer/terminal/terminal-copy";
import { installTerminalMouse, mouseEventMode, MouseReports, pointIn, type PointerLike, type ProgramButton } from "../src/renderer/terminal/terminal-mouse";
import { FakeNode, mouse, type MouseInit } from "./support/fake-dom";
import { desktopRoot } from "./support/swift-fixtures";

let ghostty: Ghostty;

beforeAll(async () => {
  const wasm = readFileSync(path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  ghostty = new Ghostty(instance);
});

const cellWidth = 8;
const cellHeight = 16;

type Sent = string | number[];

function vt(program: string) {
  const term = ghostty.createTerminal(80, 24);
  if (program !== "") term.write(new TextEncoder().encode(program));
  term.update();
  return term;
}

/** Reports over Ghostty's VT core after `program` wrote its modes; the grid `cols` by `rows` from the top left. */
function reporter(program: string, cols = 80, rows = 24) {
  const term = vt(program);
  const sent: Sent[] = [];
  const rect = { left: 0, top: 0, width: cols * cellWidth, height: rows * cellHeight };
  const reports = new MouseReports(
    { getMode: (mode) => term.getMode(mode, false), pointAt: (event) => pointIn(event, rect, cellWidth, cellHeight, cols, rows) },
    (data) => sent.push(typeof data === "string" ? data : [...data]),
  );
  return { reports, sent };
}

/** The middle of a cell (1-based), or a pixel in it. */
function at(col: number, row: number, mods: Partial<PointerLike> = {}, dx = 4, dy = 8): PointerLike {
  return { clientX: (col - 1) * cellWidth + dx, clientY: (row - 1) * cellHeight + dy, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods };
}

const formats = {
  // Hover at (5,2); press at (3,2); a move inside (3,2) one pixel on; a drag into (4,2); the release there.
  sgr: { mode: "\x1b[?1006h", hover: "\x1b[<35;5;2M", press: "\x1b[<0;3;2M", pixel: null, drag: "\x1b[<32;4;2M", release: "\x1b[<0;4;2m" },
  "sgr pixels": { mode: "\x1b[?1016h", hover: "\x1b[<35;36;24M", press: "\x1b[<0;20;24M", pixel: "\x1b[<32;21;24M", drag: "\x1b[<32;28;24M", release: "\x1b[<0;28;24m" },
  urxvt: { mode: "\x1b[?1015h", hover: "\x1b[67;5;2M", press: "\x1b[32;3;2M", pixel: null, drag: "\x1b[64;4;2M", release: "\x1b[35;4;2M" },
  "utf-8": { mode: "\x1b[?1005h", hover: "\x1b[MC%\"", press: "\x1b[M #\"", pixel: null, drag: "\x1b[M@$\"", release: "\x1b[M#$\"" },
  x10: {
    mode: "",
    hover: [27, 91, 77, 67, 37, 34],
    press: [27, 91, 77, 32, 35, 34],
    pixel: null,
    drag: [27, 91, 77, 64, 36, 34],
    release: [27, 91, 77, 35, 36, 34],
  },
} as const satisfies Record<string, { mode: string; hover: Sent; press: Sent; pixel: Sent | null; drag: Sent; release: Sent }>;

const modes = { 9: ["press"], 1000: ["press", "release"], 1002: ["press", "pixel", "drag", "release"], 1003: ["hover", "press", "pixel", "drag", "release"] } as const;

/** Hover, press, a one-pixel move, a drag into the next cell, the release. */
function gesture(reports: MouseReports): void {
  reports.motion(null, at(5, 2));
  reports.press(0, at(3, 2));
  reports.motion(0, at(3, 2, {}, 5));
  reports.motion(0, at(4, 2));
  reports.release(0, at(4, 2));
}

describe("a press, a drag and a release reported to the program", () => {
  for (const [format, expected] of Object.entries(formats)) {
    for (const [mode, events] of Object.entries(modes)) {
      it(`mode ${mode} in ${format}: ${events.join(", ")}`, () => {
        const t = reporter(`\x1b[?${mode}h${expected.mode}`);
        gesture(t.reports);
        const want = events.map((event) => expected[event]).filter((each): each is Exclude<typeof each, null> => each !== null);
        expect(t.sent).toEqual(want);
      });
    }
  }

  it("reports the middle and the right button, and their releases (legacy formats: button 3)", () => {
    const sgr = reporter("\x1b[?1000;1006h");
    for (const button of [1, 2] as const) {
      sgr.reports.press(button, at(3, 2));
      sgr.reports.release(button, at(3, 2));
    }
    expect(sgr.sent).toEqual(["\x1b[<1;3;2M", "\x1b[<1;3;2m", "\x1b[<2;3;2M", "\x1b[<2;3;2m"]);
    const urxvt = reporter("\x1b[?1000;1015h");
    for (const button of [1, 2] as const) {
      urxvt.reports.press(button, at(3, 2));
      urxvt.reports.release(button, at(3, 2));
    }
    expect(urxvt.sent).toEqual(["\x1b[33;3;2M", "\x1b[35;3;2M", "\x1b[34;3;2M", "\x1b[35;3;2M"]);
  });

  it("adds Alt 8 and Ctrl 16 as Ghostty does (⌘ is not a mouse modifier), and none in mode 9", () => {
    const t = reporter("\x1b[?1002;1006h");
    t.reports.press(0, at(3, 2, { altKey: true }));
    t.reports.press(0, at(3, 2, { ctrlKey: true }));
    t.reports.press(0, at(3, 2, { altKey: true, ctrlKey: true }));
    t.reports.press(0, at(3, 2, { metaKey: true }));
    t.reports.motion(0, at(4, 2, { ctrlKey: true }));
    t.reports.release(2, at(4, 2, { altKey: true }));
    expect(t.sent).toEqual(["\x1b[<8;3;2M", "\x1b[<16;3;2M", "\x1b[<24;3;2M", "\x1b[<0;3;2M", "\x1b[<48;4;2M", "\x1b[<10;4;2m"]);
    const x10 = reporter("\x1b[?9h");
    x10.reports.press(0, at(3, 2, { altKey: true, ctrlKey: true }));
    x10.reports.press(2, at(3, 2, { ctrlKey: true }));
    expect(x10.sent).toEqual([
      [27, 91, 77, 32, 35, 34],
      [27, 91, 77, 34, 35, 34],
    ]);
  });

  it("reports a drag once per cell it enters, never per event (per pixel only in SGR pixels)", () => {
    const t = reporter("\x1b[?1002;1006h");
    t.reports.press(0, at(1, 1));
    for (let x = 0; x < 6 * cellWidth; x += 1) t.reports.motion(0, { ...at(1, 1), clientX: x });
    t.reports.release(0, at(6, 1));
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<32;2;1M", "\x1b[<32;3;1M", "\x1b[<32;4;1M", "\x1b[<32;5;1M", "\x1b[<32;6;1M", "\x1b[<0;6;1m"]);
    const pixels = reporter("\x1b[?1002;1016h");
    pixels.reports.press(0, at(1, 1));
    pixels.reports.motion(0, at(1, 1, {}, 5));
    pixels.reports.motion(0, at(1, 1, {}, 5));
    pixels.reports.motion(0, at(1, 1, {}, 6));
    expect(pixels.sent).toEqual(["\x1b[<0;4;8M", "\x1b[<32;5;8M", "\x1b[<32;6;8M"]);
  });

  it("holds a drag and a release outside the terminal inside the grid", () => {
    const t = reporter("\x1b[?1002;1006h");
    t.reports.press(0, at(3, 2));
    t.reports.motion(0, { ...at(3, 2), clientX: -30, clientY: 500 });
    t.reports.release(0, { ...at(3, 2), clientX: 900, clientY: -5 });
    expect(t.sent).toEqual(["\x1b[<0;3;2M", "\x1b[<32;1;24M", "\x1b[<0;80;1m"]);
    const pixels = reporter("\x1b[?1000;1016h");
    pixels.reports.press(0, at(3, 2));
    pixels.reports.release(0, { ...at(3, 2), clientX: 900, clientY: -5 });
    expect(pixels.sent).toEqual(["\x1b[<0;20;24M", "\x1b[<0;640;1m"]);
  });

  it("sends nothing where X10 or UTF-8 cannot say the cell (the wheel's limits)", () => {
    const x10 = reporter("\x1b[?1000h", 300);
    x10.reports.press(0, at(223, 1));
    x10.reports.press(0, at(224, 1));
    expect(x10.sent).toEqual([[27, 91, 77, 32, 255, 33]]);
    const utf8 = reporter("\x1b[?1000;1005h", 2100);
    utf8.reports.press(0, at(2015, 1));
    utf8.reports.press(0, at(2016, 1));
    expect(utf8.sent).toEqual([`\x1b[M ${String.fromCodePoint(2047)}!`]);
  });

  it("sends nothing when the program has not asked for mouse reports (a format alone is not asking)", () => {
    for (const program of ["", "\x1b[?1006h", "\x1b[?1000h\x1b[?1000l"]) {
      const t = reporter(program);
      expect(t.reports.mode()).toBeNull();
      gesture(t.reports);
      expect(t.sent).toEqual([]);
    }
  });

  it("takes the widest event mode a program set (Ghostty's core keeps each as set)", () => {
    expect(mouseEventMode((mode) => vt("\x1b[?1000h\x1b[?1003h").getMode(mode, false))).toBe("any");
    expect(mouseEventMode((mode) => vt("\x1b[?1000;1002h").getMode(mode, false))).toBe("button");
    expect(mouseEventMode((mode) => vt("\x1b[?1000h").getMode(mode, false))).toBe("normal");
    expect(mouseEventMode((mode) => vt("\x1b[?9h").getMode(mode, false))).toBe("x10");
  });
});

const bit: Record<ProgramButton, number> = { 0: 1, 1: 4, 2: 2 };

/** A terminal's canvas in a frame, with ghostty-web's SelectionManager, the app's copy and the routing over Ghostty's VT core. */
function routed(program: string, options: { keyboard?: boolean; link?: (event: { metaKey: boolean }) => boolean } = {}) {
  const root = new FakeNode("document");
  vi.stubGlobal("document", root);
  const frame = root.append(new FakeNode("frame"));
  const host = frame.append(new FakeNode("host"));
  const canvas = host.append(new FakeNode("canvas"));
  const sidebar = root.append(new FakeNode("sidebar"));
  canvas.rect = { left: 10, top: 20, width: 80 * cellWidth, height: 24 * cellHeight };
  const term = vt(program);
  const seen = { hostPresses: 0, canvasPresses: 0, menus: 0, doubleClicks: 0 };
  // ghostty-web's own listeners, as its open() adds them: the scrollbar's press on the host (capture), the focus on the canvas.
  host.addEventListener("mousedown", () => (seen.hostPresses += 1), { capture: true });
  canvas.addEventListener("mousedown", () => (seen.canvasPresses += 1));
  canvas.addEventListener("contextmenu", () => (seen.menus += 1));
  canvas.addEventListener("dblclick", () => (seen.doubleClicks += 1));
  const textarea = { style: {}, value: "", focus() {}, select() {}, setSelectionRange() {}, addEventListener() {}, removeEventListener() {} };
  const renderer = { getCanvas: () => canvas, getMetrics: () => ({ width: cellWidth, height: cellHeight }) };
  const owner = { cols: 80, rows: 24, getViewportY: () => 0, scrollLines: () => undefined };
  const selection = new SelectionManager(owner as never, renderer as never, term, textarea as never);
  const copied: string[] = [];
  const state = { copiedNotes: 0, keyboard: options.keyboard ?? true, focuses: 0, releases: 0 };
  const copy = installSelectionCopy({ selection, grid: term, canvas, copy: (text) => copied.push(text), copied: () => (state.copiedNotes += 1), note: () => undefined });
  const sent: Sent[] = [];
  const reports = new MouseReports(
    { getMode: (mode) => term.getMode(mode, false), pointAt: (event) => pointIn(event, canvas.getBoundingClientRect(), cellWidth, cellHeight, 80, 24) },
    (data) => sent.push(typeof data === "string" ? data : [...data]),
  );
  const close = installTerminalMouse({
    reports,
    frame,
    canvas,
    document: root,
    hasKeyboard: () => state.keyboard,
    focus: () => (state.focuses += 1),
    onLink: (event) => options.link?.(event) ?? false,
    released: () => (state.releases += 1),
  });
  const xy = (col: number, row: number) => ({ clientX: canvas.rect.left + (col - 1) * cellWidth + 4, clientY: canvas.rect.top + (row - 1) * cellHeight + 8 });
  const press = (col: number, row: number, init: Partial<MouseInit> = {}): Event => {
    const event = mouse("mousedown", { ...xy(col, row), buttons: bit[(init.button ?? 0) as ProgramButton], ...init }, canvas);
    canvas.dispatchEvent(event);
    return event;
  };
  const move = (col: number, row: number, init: Partial<MouseInit> = {}, over: FakeNode = canvas): void => {
    over.dispatchEvent(mouse("mousemove", { ...xy(col, row), buttons: 1, ...init }, canvas));
  };
  const release = (col: number, row: number, init: Partial<MouseInit> = {}, over: FakeNode = canvas): void => {
    over.dispatchEvent(mouse("mouseup", { ...xy(col, row), buttons: 0, ...init }, canvas));
    over.dispatchEvent(mouse("click", { ...xy(col, row), buttons: 0, ...init }, canvas));
  };
  const drag = (from: [number, number], to: [number, number], init: Partial<MouseInit> = {}): void => {
    press(from[0], from[1], init);
    move(to[0], to[1], init);
    release(to[0], to[1], init);
  };
  return { root, frame, host, canvas, sidebar, selection, copy, copied, sent, seen, state, close, press, move, release, drag };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: () => {
        throw new Error("ghostty-web's own copy ran");
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tracking = "\x1b[?1000;1006hhello world\r\n";

describe("whose a press is: the program's or the app's selection", () => {
  it("with Shift held: no report, the app's selection as today, copied as it ends", () => {
    const t = routed(tracking);
    t.drag([1, 1], [5, 1], { shiftKey: true });
    expect(t.sent).toEqual([]);
    expect(t.selection.hasSelection()).toBe(true);
    expect(t.copied).toEqual(["hello"]);
    expect(t.state.copiedNotes).toBe(1);
    expect(t.seen.canvasPresses).toBe(1);
    expect(t.state.releases).toBe(0);
  });

  it("when the program has not asked: today's selection and copy, nothing sent", () => {
    const t = routed("hello world\r\n");
    t.drag([7, 1], [11, 1]);
    expect(t.sent).toEqual([]);
    expect(t.copied).toEqual(["world"]);
    expect(t.state.copiedNotes).toBe(1);
  });

  it("a press the program took starts no selection, its release copies nothing, and neither reaches ghostty-web", () => {
    const t = routed(tracking);
    const pressed = t.press(1, 1);
    t.move(5, 1);
    t.release(5, 1);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;5;1m"]);
    expect(t.selection.hasSelection()).toBe(false);
    expect(t.copy?.text()).toBe("");
    expect(t.copied).toEqual([]);
    expect(t.state.copiedNotes).toBe(0);
    // Stopped on the frame: neither the scrollbar's press on the host nor the canvas's own saw it.
    expect(t.seen.hostPresses).toBe(0);
    expect(t.seen.canvasPresses).toBe(0);
    expect(pressed.defaultPrevented).toBe(true);
    expect(t.state.focuses).toBe(1);
    expect(t.state.releases).toBe(1);
  });

  it("does not clear or extend a selection already there", () => {
    const t = routed(tracking);
    t.drag([1, 1], [5, 1], { shiftKey: true });
    t.drag([7, 1], [11, 1]);
    expect(t.selection.hasSelection()).toBe(true);
    expect(t.copy?.text()).toBe("hello");
    expect(t.copied).toEqual(["hello"]);
  });

  it("a double or triple click the program took selects no word or line", () => {
    const t = routed(tracking);
    for (const detail of [1, 2, 3]) {
      t.press(1, 1, { detail });
      t.release(1, 1, { detail });
    }
    t.canvas.dispatchEvent(mouse("dblclick", { clientX: 14, clientY: 28, detail: 2 }, t.canvas));
    expect(t.seen.doubleClicks).toBe(0);
    expect(t.selection.hasSelection()).toBe(false);
    expect(t.copied).toEqual([]);
    expect(t.sent).toHaveLength(6);
  });

  it("a selection begun with Shift stays the app's when Shift comes up mid-drag", () => {
    const t = routed("\x1b[?1002;1006hhello world\r\n");
    t.press(1, 1, { shiftKey: true });
    t.move(3, 1);
    t.move(5, 1);
    t.release(5, 1);
    expect(t.sent).toEqual([]);
    expect(t.copied).toEqual(["hello"]);
  });

  it("a press the program took stays the program's when Shift goes down mid-drag, to its release", () => {
    const t = routed("\x1b[?1002;1006hhello world\r\n");
    t.press(1, 1);
    t.move(3, 1);
    // Ghostty sends no drag while Shift is held; the release still comes, with Shift's 4.
    t.move(5, 1, { shiftKey: true });
    t.release(5, 1, { shiftKey: true });
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<32;3;1M", "\x1b[<4;5;1m"]);
    expect(t.selection.hasSelection()).toBe(false);
    expect(t.copied).toEqual([]);
  });

  it("a ⌘-click on a link stays the app's (it opens) and sends nothing", () => {
    const t = routed(tracking, { link: (event) => event.metaKey });
    t.drag([1, 1], [1, 1], { metaKey: true });
    expect(t.sent).toEqual([]);
    expect(t.seen.canvasPresses).toBe(1);
    expect(t.copied).toEqual([]);
    // A ⌘-click elsewhere goes to the program, ⌘ not said (Ghostty).
    const elsewhere = routed(tracking);
    elsewhere.drag([2, 2], [2, 2], { metaKey: true });
    expect(elsewhere.sent).toEqual(["\x1b[<0;2;2M", "\x1b[<0;2;2m"]);
  });

  it("the left click that only gives the terminal the keyboard goes nowhere; the next one is the program's", () => {
    const t = routed(tracking, { keyboard: false });
    t.drag([1, 1], [5, 1]);
    expect(t.sent).toEqual([]);
    expect(t.selection.hasSelection()).toBe(false);
    expect(t.copied).toEqual([]);
    expect(t.state.focuses).toBe(1);
    expect(t.state.releases).toBe(0);
    t.state.keyboard = true;
    t.drag([2, 1], [2, 1]);
    expect(t.sent).toEqual(["\x1b[<0;2;1M", "\x1b[<0;2;1m"]);
  });

  it("the right button goes to the program without the context menu; with no tracking, the menu is today's", () => {
    const t = routed(tracking, { keyboard: false });
    t.press(3, 2, { button: 2 });
    const menu = mouse("contextmenu", { clientX: 30, clientY: 44, button: 2 }, t.canvas);
    t.canvas.dispatchEvent(menu);
    t.release(3, 2, { button: 2 });
    expect(t.sent).toEqual(["\x1b[<2;3;2M", "\x1b[<2;3;2m"]);
    expect(t.seen.menus).toBe(0);
    expect(menu.defaultPrevented).toBe(true);
    const plain = routed("hello\r\n");
    plain.press(3, 2, { button: 2 });
    plain.canvas.dispatchEvent(mouse("contextmenu", { clientX: 30, clientY: 44, button: 2 }, plain.canvas));
    expect(plain.seen.menus).toBe(1);
    expect(plain.sent).toEqual([]);
  });

  it("a release outside the terminal, or one the window never saw, still reaches the program, inside the grid", () => {
    const t = routed("\x1b[?1002;1006h");
    t.press(3, 2);
    t.sidebar.dispatchEvent(mouse("mousemove", { clientX: -100, clientY: 900, buttons: 1 }, t.canvas));
    t.sidebar.dispatchEvent(mouse("mouseup", { clientX: 2000, clientY: -40, buttons: 0 }, t.canvas));
    expect(t.sent).toEqual(["\x1b[<0;3;2M", "\x1b[<32;1;24M", "\x1b[<0;80;1m"]);
    // The button came up outside the window: the next move shows it up, and the release goes then.
    t.press(4, 2);
    t.move(6, 3, { buttons: 0 });
    expect(t.sent.slice(3)).toEqual(["\x1b[<0;4;2M", "\x1b[<0;6;3m"]);
    // Only the mouseup seen counts as your action; the release the app inferred does not.
    expect(t.state.releases).toBe(1);
    expect(t.selection.hasSelection()).toBe(false);
  });

  it("moves with no button go to a program in mode 1003 only, over the terminal only", () => {
    const any = routed("\x1b[?1003;1006h");
    any.move(2, 2, { buttons: 0 });
    any.move(2, 2, { buttons: 0 });
    any.sidebar.dispatchEvent(mouse("mousemove", { clientX: 2000, clientY: 4, buttons: 0 }, any.canvas));
    // A drag begun elsewhere (another tile) crossing this terminal is not this program's.
    any.move(4, 2, { buttons: 1 });
    expect(any.sent).toEqual(["\x1b[<35;2;2M"]);
    const button = routed("\x1b[?1002;1006h");
    button.move(2, 2, { buttons: 0 });
    expect(button.sent).toEqual([]);
  });

  it("takes every listener back when closed", () => {
    const t = routed(tracking);
    t.close();
    for (const type of ["mousedown", "contextmenu", "dblclick"]) expect(t.frame.listening(type)).toBe(0);
    t.drag([1, 1], [5, 1]);
    expect(t.sent).toEqual([]);
    expect(t.copied).toEqual(["hello"]);
  });
});

/** MouseEvent as the browser makes it: offsetX/Y against the canvas it lands on. */
class FakeMouseEvent extends Event {
  declare clientX: number;
  declare clientY: number;
  constructor(type: string, init: MouseEventInit) {
    const { bubbles, cancelable, ...rest } = init;
    super(type, { bubbles, cancelable });
    Object.assign(this, { button: 0, buttons: 0, detail: 0, clientX: 0, clientY: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...rest });
  }
  get offsetX(): number {
    return this.clientX - ((this.target as FakeNode | null)?.rect.left ?? 0);
  }
  get offsetY(): number {
    return this.clientY - ((this.target as FakeNode | null)?.rect.top ?? 0);
  }
}

/** terminal-capture.ts's own presses with Shift held (it has no Shift of its own). */
function shiftSelect(canvas: FakeNode, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const rect = canvas.getBoundingClientRect();
  const fire = (type: string, point: { x: number; y: number }, buttons: number): void => {
    canvas.dispatchEvent(new FakeMouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, detail: 1, shiftKey: true, clientX: rect.left + point.x * rect.width, clientY: rect.top + point.y * rect.height }));
  };
  fire("mousedown", from, 1);
  fire("mousemove", to, 1);
  fire("mouseup", to, 0);
  fire("click", to, 0);
}

describe("the terminal's canvas, with real mouse events", () => {
  function onCanvas(program: string) {
    const t = routed(program);
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    vi.stubGlobal("HTMLCanvasElement", FakeNode);
    Object.assign(t.root, { querySelector: (selector: string) => (selector === ".term-host canvas" ? t.canvas : null) });
    return t;
  }
  // "hello world" across the top row: from its first cell to the middle of its fifth.
  const from = { x: 0.5 / 80, y: 0.5 / 24 };
  const to = { x: 4.5 / 80, y: 0.5 / 24 };

  it("with tracking on, a press and drag leave ghostty-web with no selection and go to the program", () => {
    const t = onCanvas("\x1b[?1002;1006hhello world\r\n");
    expect(selectInTerminal(".term-host canvas", from, to, 1)).toBe(true);
    expect(t.selection.hasSelection()).toBe(false);
    expect(t.copied).toEqual([]);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<32;5;1M", "\x1b[<0;5;1m"]);
  });

  it("with Shift, the selection is there and copies", () => {
    const t = onCanvas("\x1b[?1002;1006hhello world\r\n");
    shiftSelect(t.canvas, from, to);
    expect(t.selection.hasSelection()).toBe(true);
    expect(t.copied).toEqual(["hello"]);
    expect(t.sent).toEqual([]);
  });

  it("with no tracking, a drag selects and copies as today", () => {
    const t = onCanvas("hello world\r\n");
    expect(selectInTerminal(".term-host canvas", from, to, 1)).toBe(true);
    expect(t.copied).toEqual(["hello"]);
    expect(t.sent).toEqual([]);
  });
});
