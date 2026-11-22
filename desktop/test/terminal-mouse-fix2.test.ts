// The two boundary cases the re-review left open, and the cleanup
// that must always finish, over the review's harness (ghostty-web's real
// SelectionManager and the app's copy on support/fake-dom.ts nodes, Ghostty's
// VT core), with the window as the document's parent:
// - a fresh press anywhere (another tile, the rest of the window, this
//   terminal) retires an old press of the same button whose release was never
//   seen: the program gets that release once, never as your action, and the
//   fresh press's own release is never taken for the old one's; a drag still
//   going keeps its real release, also outside the tile;
// - the window losing focus or the page hidden finishes a held press (one
//   release at the last point reported, never your action) and keeps the
//   listeners, so a click after the window is back reports as before;
// - closing takes every listener back also when sending the release throws.

import { readFileSync } from "node:fs";

import { Ghostty, SelectionManager } from "ghostty-web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { installSelectionCopy } from "../src/renderer/terminal/terminal-copy";
import { installTerminalMouse, MouseReports, pointIn } from "../src/renderer/terminal/terminal-mouse";
import { FakeNode, mouse } from "./support/fake-dom";

let ghostty: Ghostty;
beforeAll(async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(process.cwd() + "/node_modules/ghostty-web/ghostty-vt.wasm"), { env: { log() {} } });
  ghostty = new Ghostty(instance);
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText() {
        throw Error("real clipboard forbidden");
      },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The review's harness (rerev1-boundary.test.ts setup), with the window given to the controller. */
function setup(program: string, cols = 80, rows = 24) {
  const win = new FakeNode("window");
  const doc = win.append(new FakeNode("document"));
  vi.stubGlobal("document", doc);
  const frame = doc.append(new FakeNode("frame"));
  const host = frame.append(new FakeNode("host"));
  const canvas = host.append(new FakeNode("canvas"));
  const outside = doc.append(new FakeNode("outside"));
  canvas.rect = { left: 10, top: 20, width: cols * 8, height: rows * 16 };
  const term = ghostty.createTerminal(cols, rows);
  term.write(new TextEncoder().encode(program + "hello world"));
  term.update();
  const sent: (string | number[])[] = [];
  const state = { keyboard: true, focus: 0, releases: 0, throwInput: false, hidden: false };
  const copy: string[] = [];
  for (const node of [win, doc, frame, host, canvas])
    for (const type of ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu"])
      for (const capture of [true, false]) node.addEventListener(type, () => undefined, { capture });
  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    state.focus++;
  });
  const selection = new SelectionManager(
    { cols, rows, getViewportY: () => 0, scrollLines() {} } as never,
    { getCanvas: () => canvas, getMetrics: () => ({ width: 8, height: 16 }) } as never,
    term,
    { style: {}, value: "", focus() {}, select() {}, setSelectionRange() {}, addEventListener() {}, removeEventListener() {} } as never,
  );
  const copier = installSelectionCopy({ selection, grid: term, canvas, copy: (t) => copy.push(t), note() {} });
  const reports = new MouseReports(
    { getMode: (n) => term.getMode(n, false), pointAt: (e) => pointIn(e, canvas.getBoundingClientRect(), 8, 16, cols, rows) },
    (d) => {
      if (state.throwInput) throw Error("injected transport send failure");
      sent.push(typeof d === "string" ? d : [...d]);
    },
  );
  const close = installTerminalMouse({
    reports,
    frame,
    canvas,
    document: doc,
    window: win,
    isHidden: () => state.hidden,
    hasKeyboard: () => state.keyboard,
    focus: () => {
      state.focus++;
      state.keyboard = true;
    },
    onLink: () => false,
    released: () => state.releases++,
  });
  const fire = (type: string, x = 4, y = 8, extra = {}, target: FakeNode = canvas) => {
    const event = mouse(type, { clientX: 10 + x, clientY: 20 + y, ...extra }, canvas);
    target.dispatchEvent(event);
    return event;
  };
  const write = (text: string) => {
    term.write(new TextEncoder().encode(text));
    term.update();
  };
  /** The window loses focus (also what hiding it does). */
  const blur = () => win.dispatchEvent(new Event("blur"));
  /** The page's visibility changes (Chromium fires it at the document; it bubbles). */
  const visibility = (hidden: boolean) => {
    state.hidden = hidden;
    doc.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  };
  return {
    win, doc, frame, host, canvas, outside, term, sent, state, copy, selection, fire, write, close, blur, visibility,
    dispose: () => {
      close();
      copier?.dispose();
      selection.dispose();
      term.free();
    },
  };
}

const sgr = "\x1b[?1000;1002;1006h";

describe("fix 1: a fresh press anywhere ends an old held press, with no clipboard window", () => {
  it("another tile's fresh same-button click retires the stale press as inferred; its release is not this tile's", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    vi.advanceTimersByTime(60_000);
    // Elsewhere in the window (another tile): the press, then its release.
    t.fire("mousedown", 44, 8, { buttons: 1 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;6;1m"]);
    t.fire("mouseup", 44, 8, { buttons: 0 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;6;1m"]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("a fresh press on this terminal retires the stale one first, then is reported; its own release is the action", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    vi.advanceTimersByTime(60_000);
    t.fire("mousedown", 20, 8, { buttons: 1 });
    expect(t.state.releases).toBe(0);
    t.fire("mouseup", 20, 8, { buttons: 0 });
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;3;1m", "\x1b[<0;3;1M", "\x1b[<0;3;1m"]);
    expect(t.state.releases).toBe(1);
    expect(t.selection.hasSelection()).toBe(false);
    expect(t.copy).toEqual([]);
    t.dispose();
  });

  it("other held buttons the fresh press shows up are settled the same way, never as an action", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    vi.advanceTimersByTime(60_000);
    // A right press elsewhere with the left button up: the left press ended unseen.
    t.fire("mousedown", 44, 8, { button: 2, buttons: 2 }, t.outside);
    t.fire("mouseup", 44, 8, { button: 2, buttons: 0 }, t.outside);
    t.fire("mouseup", 44, 8, { buttons: 0 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;6;1m"]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("with tracking off since, the stale press is dropped with nothing sent and its button is free again", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.write("\x1b[?1000;1002l");
    t.fire("mousedown", 44, 8, { buttons: 1 }, t.outside);
    t.fire("mouseup", 44, 8, { buttons: 0 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M"]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("a real drag that goes outside the tile and ends there keeps its seen release and its clipboard window", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.fire("mousemove", 20, 8, { buttons: 1 });
    t.fire("mousemove", 2000, 8, { buttons: 1 }, t.outside);
    vi.advanceTimersByTime(5_000);
    t.fire("mouseup", 2000, 8, { buttons: 0 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<32;3;1M", "\x1b[<32;80;1M", "\x1b[<0;80;1m"]);
    expect(t.state.releases).toBe(1);
    t.dispose();
  });

  it("a fresh press of a different button during a real drag does not retire the drag", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.fire("mousemove", 2000, 8, { buttons: 1 }, t.outside);
    // The right button goes down and up elsewhere while the left is still held.
    t.fire("mousedown", 2000, 8, { button: 2, buttons: 3 }, t.outside);
    t.fire("mouseup", 2000, 8, { button: 2, buttons: 1 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<32;80;1M"]);
    t.fire("mouseup", 2000, 8, { buttons: 0 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<32;80;1M", "\x1b[<0;80;1m"]);
    expect(t.state.releases).toBe(1);
    t.dispose();
  });

  it("a fresh left press after a Shift selection's missed release is routed afresh (to the program)", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1, shiftKey: true });
    // Its mouseup was missed; a fresh left press, no Shift.
    t.fire("mousedown", 20, 8, { buttons: 1 });
    t.fire("mouseup", 20, 8, { buttons: 0 });
    expect(t.sent).toEqual(["\x1b[<0;3;1M", "\x1b[<0;3;1m"]);
    expect(t.state.releases).toBe(1);
    t.dispose();
  });
});

describe("fix 2: the window hidden or losing focus finishes a held press, the listeners kept", () => {
  it("blur with a press held: one release at the last point reported, with its modifiers, no clipboard window", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.fire("mousemove", 20, 8, { buttons: 1, altKey: true });
    t.blur();
    t.blur();
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<40;3;1M", "\x1b[<8;3;1m"]);
    // The button's real release, if it comes back here, is not the program's any more.
    t.fire("mouseup", 30, 8, { buttons: 0 });
    expect(t.sent).toHaveLength(3);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("blur with nothing held sends nothing", () => {
    const t = setup(sgr);
    t.blur();
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.fire("mouseup", 4, 8, { buttons: 0 });
    t.blur();
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    t.dispose();
  });

  it("the page hidden finishes a held press; a visibility change to visible does not", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.visibility(false);
    expect(t.sent).toEqual(["\x1b[<0;1;1M"]);
    t.visibility(true);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("with tracking off since, nothing is sent", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.write("\x1b[?1000;1002l");
    t.blur();
    expect(t.sent).toEqual(["\x1b[<0;1;1M"]);
    t.dispose();
  });

  it("a click after the window is back reports as before: the listeners are still there", () => {
    const t = setup(sgr);
    const listening = [t.frame.listening("mousedown"), t.doc.listening("mousedown"), t.doc.listening("mouseup"), t.win.listening("blur")];
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.blur();
    t.visibility(true);
    expect([t.frame.listening("mousedown"), t.doc.listening("mousedown"), t.doc.listening("mouseup"), t.win.listening("blur")]).toEqual(listening);
    t.visibility(false);
    t.fire("mousedown", 12, 8, { buttons: 1 });
    t.fire("mouseup", 12, 8, { buttons: 0 });
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m", "\x1b[<0;2;1M", "\x1b[<0;2;1m"]);
    expect(t.state.releases).toBe(1);
    expect(t.copy).toEqual([]);
    t.dispose();
  });

  it("a Shift selection is not touched by blur", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1, shiftKey: true });
    t.fire("mousemove", 40, 8, { buttons: 1, shiftKey: true });
    t.blur();
    t.fire("mouseup", 40, 8, { buttons: 0 });
    expect(t.sent).toEqual([]);
    expect(t.copy).toEqual(["hello"]);
    t.dispose();
  });
});

describe("fix 3: cleanup always finishes", () => {
  it("CONTRACT: a close-time send failure must still remove the mouse listeners", () => {
    const t = setup("\x1b[?1000;1006h");
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.state.throwInput = true;
    expect(() => t.close()).toThrow("injected transport send failure");
    // Only the pre-existing trace listeners should remain; new capture listeners must be gone.
    expect(t.frame.listening("mousedown")).toBe(2);
    expect(t.doc.listening("mousemove")).toBe(3);
    t.close();
  });

  it("all eight listeners are gone and nothing is left held: a second close sends nothing", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    // Before: the trace pair and the selection's own, plus the controller's.
    expect([t.frame.listening("mousedown"), t.frame.listening("contextmenu"), t.frame.listening("dblclick")]).toEqual([3, 3, 3]);
    expect([t.doc.listening("mousedown"), t.doc.listening("mouseup"), t.doc.listening("visibilitychange")]).toEqual([4, 4, 1]);
    expect(t.win.listening("blur")).toBe(1);
    t.state.throwInput = true;
    expect(() => t.close()).toThrow("injected transport send failure");
    expect([t.frame.listening("mousedown"), t.frame.listening("contextmenu"), t.frame.listening("dblclick")]).toEqual([2, 2, 2]);
    expect([t.doc.listening("mousedown"), t.doc.listening("mouseup"), t.doc.listening("visibilitychange")]).toEqual([3, 3, 0]);
    expect(t.win.listening("blur")).toBe(0);
    t.state.throwInput = false;
    t.close();
    t.blur();
    t.fire("mouseup", 4, 8, { buttons: 0 });
    expect(t.sent).toEqual(["\x1b[<0;1;1M"]);
    expect(t.state.releases).toBe(0);
  });

  it("a send that throws on blur still lets the button go; the next press reports", () => {
    const t = setup(sgr);
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.state.throwInput = true;
    expect(() => t.blur()).toThrow("injected transport send failure");
    t.state.throwInput = false;
    t.fire("mouseup", 4, 8, { buttons: 0 });
    expect(t.state.releases).toBe(0);
    t.fire("mousedown", 12, 8, { buttons: 1 });
    t.fire("mouseup", 12, 8, { buttons: 0 });
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;2;1M", "\x1b[<0;2;1m"]);
    t.dispose();
  });
});
