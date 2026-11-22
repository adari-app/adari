// The review's three blocking cases, with its CONTRACT cases as
// written, over its own harness (ghostty-web's real SelectionManager and the
// app's copy on support/fake-dom.ts nodes, Ghostty's VT core):
// - a release the app only inferred (the button seen up on a later move)
//   still goes to the program, but is never your own action for a program's
//   copy (OSC 52);
// - only a press whose bytes went is the program's: a press the format
//   cannot say (X10 past column 223, UTF-8 past its limit) sends nothing and
//   is followed by nothing, no move, release or copy, and is not the app's
//   selection either;
// - the view going away mid-press sends the release once, at the last point
//   reported, with the modifiers then, never as your action; nothing when
//   nothing is held or tracking is already off;
// - the fake DOM snapshots a target's listeners as the DOM does.

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

/** The review's harness (boundary-mouse.test.ts setup), unchanged in what it builds. */
function setup(program: string, withMouse = true, width = 640, cols = 80) {
  const win = new FakeNode("window");
  const doc = win.append(new FakeNode("document"));
  vi.stubGlobal("document", doc);
  const frame = doc.append(new FakeNode("frame"));
  const host = frame.append(new FakeNode("host"));
  const canvas = host.append(new FakeNode("canvas"));
  const outside = doc.append(new FakeNode("outside"));
  canvas.rect = { left: 10, top: 20, width, height: 384 };
  const term = ghostty.createTerminal(cols, 24);
  term.write(new TextEncoder().encode(program + "hello world"));
  term.update();
  const sent: (string | number[])[] = [];
  const state = { keyboard: true, focus: 0, releases: 0 };
  const copy: string[] = [];
  const seen: string[] = [];
  for (const node of [win, doc, frame, host, canvas])
    for (const type of ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu"])
      for (const capture of [true, false]) node.addEventListener(type, (e) => seen.push(`${node.name}:${capture ? "capture" : "bubble"}:${type}:${e.defaultPrevented}`), { capture });
  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    state.focus++;
  });
  const selection = new SelectionManager(
    { cols, rows: 24, getViewportY: () => 0, scrollLines() {} } as never,
    { getCanvas: () => canvas, getMetrics: () => ({ width: 8, height: 16 }) } as never,
    term,
    { style: {}, value: "", focus() {}, select() {}, setSelectionRange() {}, addEventListener() {}, removeEventListener() {} } as never,
  );
  const copier = installSelectionCopy({ selection, grid: term, canvas, copy: (t) => copy.push(t), note() {} });
  const reports = new MouseReports(
    { getMode: (n) => term.getMode(n, false), pointAt: (e) => pointIn(e, canvas.getBoundingClientRect(), 8, 16, cols, 24) },
    (d) => sent.push(typeof d === "string" ? d : [...d]),
  );
  const close = withMouse
    ? installTerminalMouse({
        reports,
        frame,
        canvas,
        document: doc,
        hasKeyboard: () => state.keyboard,
        focus: () => {
          state.focus++;
          state.keyboard = true;
        },
        onLink: () => false,
        released: () => state.releases++,
      })
    : () => {};
  const fire = (type: string, x = 4, y = 8, extra = {}, target = canvas) => {
    const event = mouse(type, { clientX: 10 + x, clientY: 20 + y, ...extra }, canvas);
    target.dispatchEvent(event);
    return event;
  };
  const write = (text: string) => {
    term.write(new TextEncoder().encode(text));
    term.update();
  };
  return {
    win, doc, frame, host, canvas, outside, term, reports, sent, state, copy, seen, selection, fire, write, close,
    dispose: () => {
      close();
      copier?.dispose();
      selection.dispose();
      term.free();
    },
  };
}

describe("a release the app only inferred", () => {
  it("still reaches the program once, but is not your action; the mouseup seen later changes nothing", () => {
    const t = setup("\x1b[?1002;1006h");
    t.fire("mousedown", 4, 8, { buttons: 1 });
    vi.advanceTimersByTime(60_000);
    t.fire("mousemove", 20, 8, { buttons: 0 }, t.outside);
    t.fire("mousemove", 28, 8, { buttons: 0 }, t.outside);
    t.fire("mouseup", 28, 8, { buttons: 0 });
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;3;1m"]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("inferred from the next press shows the button up: the release goes, not as your action, the new press is the program's", () => {
    const t = setup("\x1b[?1000;1006h");
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.fire("mousedown", 20, 8, { button: 2, buttons: 2 });
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;3;1m", "\x1b[<2;3;1M"]);
    expect(t.state.releases).toBe(0);
    t.fire("mouseup", 20, 8, { button: 2, buttons: 0 });
    expect(t.state.releases).toBe(1);
    t.dispose();
  });

  it("an actual mouseup of a sent mode-9 press counts (no release byte), an inferred one does not", () => {
    const seen = setup("\x1b[?9h");
    seen.fire("mousedown", 4, 8, { buttons: 1 });
    seen.fire("mouseup", 4, 8, { buttons: 0 });
    expect(seen.sent).toEqual([[27, 91, 77, 32, 33, 33]]);
    expect(seen.state.releases).toBe(1);
    seen.dispose();
    const inferred = setup("\x1b[?9h");
    inferred.fire("mousedown", 4, 8, { buttons: 1 });
    inferred.fire("mousemove", 12, 8, { buttons: 0 });
    expect(inferred.state.releases).toBe(0);
    inferred.dispose();
  });
});

describe("only a press whose bytes went is the program's", () => {
  it("CONTRACT: an unencodable X10 press must not later send an orphan release", () => {
    const t = setup("\x1b[?1000h", true, 2400, 300);
    t.fire("mousedown", 223 * 8 + 4, 8, { buttons: 1 });
    t.fire("mouseup", 20, 8, { buttons: 0 });
    expect(t.sent).toEqual([]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("the UTF-8 twin: a press past column 2015 sends nothing, no move, no release, no action", () => {
    const t = setup("\x1b[?1002;1005h", true, 2100 * 8, 2100);
    t.fire("mousedown", 2015 * 8 + 4, 8, { buttons: 1 });
    t.fire("mousemove", 20, 8, { buttons: 1 });
    t.fire("mouseup", 20, 8, { buttons: 0 });
    expect(t.sent).toEqual([]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("does nothing else either: no selection, no copy, the press kept from ghostty-web, the keyboard given", () => {
    const t = setup("\x1b[?1000h", true, 2400, 300);
    const press = t.fire("mousedown", 223 * 8 + 4, 8, { buttons: 1 });
    t.fire("mousemove", 230 * 8, 8, { buttons: 1 });
    t.fire("mouseup", 230 * 8, 8, { buttons: 0 });
    expect(press.defaultPrevented).toBe(true);
    expect(t.seen.filter((line) => line.startsWith("canvas:") && line.includes(":mousedown:"))).toEqual([]);
    expect(t.selection.hasSelection()).toBe(false);
    expect(t.copy).toEqual([]);
    expect(t.state.focus).toBe(1);
    // A press it can say, after, is the program's as ever.
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.fire("mouseup", 4, 8, { buttons: 0 });
    expect(t.sent).toEqual([
      [27, 91, 77, 32, 33, 33],
      [27, 91, 77, 35, 33, 33],
    ]);
    expect(t.state.releases).toBe(1);
    t.dispose();
  });

  it("a view closed after a press it could not say sends nothing", () => {
    const t = setup("\x1b[?1000h", true, 2400, 300);
    t.fire("mousedown", 223 * 8 + 4, 8, { buttons: 1 });
    t.close();
    expect(t.sent).toEqual([]);
    t.dispose();
  });
});

describe("the view going away mid-press", () => {
  it("CONTRACT: closing or switching the view mid-drag must settle the reported press", () => {
    const t = setup("\x1b[?1002;1006h");
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.close();
    t.fire("mouseup", 20, 8, { buttons: 0 }, t.outside);
    expect(t.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    t.dispose();
  });

  it("sends the release once, at the last point and modifiers reported, never as your action", () => {
    const t = setup("\x1b[?1002;1006h");
    t.fire("mousedown", 4, 8, { buttons: 1, altKey: true });
    t.fire("mousemove", 20, 8, { buttons: 1, altKey: true });
    // Shift held: Ghostty sends no drag, so the program last saw the pointer at column 3.
    t.fire("mousemove", 60, 8, { buttons: 1, shiftKey: true });
    t.close();
    t.close();
    expect(t.sent).toEqual(["\x1b[<8;1;1M", "\x1b[<40;3;1M", "\x1b[<8;3;1m"]);
    expect(t.state.releases).toBe(0);
    t.dispose();
  });

  it("each held button gets its release; the legacy format's as button 3", () => {
    const t = setup("\x1b[?1000h");
    t.fire("mousedown", 4, 8, { buttons: 1 });
    t.fire("mousedown", 12, 8, { button: 2, buttons: 3 });
    t.close();
    expect(t.sent).toEqual([
      [27, 91, 77, 32, 33, 33],
      [27, 91, 77, 34, 34, 33],
      [27, 91, 77, 35, 34, 33],
      [27, 91, 77, 35, 34, 33],
    ]);
    t.dispose();
  });

  it("closing with nothing held, after a finished click, or after tracking went off sends nothing", () => {
    const idle = setup("\x1b[?1002;1006h");
    idle.close();
    expect(idle.sent).toEqual([]);
    idle.dispose();
    const done = setup("\x1b[?1002;1006h");
    done.fire("mousedown", 4, 8, { buttons: 1 });
    done.fire("mouseup", 4, 8, { buttons: 0 });
    done.close();
    expect(done.sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    done.dispose();
    const off = setup("\x1b[?1002;1006h");
    off.fire("mousedown", 4, 8, { buttons: 1 });
    off.write("\x1b[?1002l");
    off.close();
    expect(off.sent).toEqual(["\x1b[<0;1;1M"]);
    off.dispose();
  });

  it("a focus-only press or the app's own selection, closed mid-press, sends nothing", () => {
    const focus = setup("\x1b[?1000;1006h");
    focus.state.keyboard = false;
    focus.fire("mousedown", 4, 8, { buttons: 1 });
    focus.close();
    const shift = setup("\x1b[?1000;1006h");
    shift.fire("mousedown", 4, 8, { buttons: 1, shiftKey: true });
    shift.close();
    expect([focus.sent, shift.sent]).toEqual([[], []]);
    focus.dispose();
    shift.dispose();
  });
});

describe("the fake DOM", () => {
  it("CONTRACT: listeners added to the current target/phase wait for the next dispatch", () => {
    const node = new FakeNode("canvas");
    const seen: string[] = [];
    const late = () => seen.push("late");
    node.addEventListener("test", () => {
      seen.push("first");
      node.addEventListener("test", late);
    });
    node.dispatchEvent(new Event("test"));
    expect(seen).toEqual(["first"]);
    node.dispatchEvent(new Event("test"));
    expect(seen).toEqual(["first", "first", "late"]);
  });

  it("a listener removed by an earlier one in the same dispatch does not run", () => {
    const node = new FakeNode("canvas");
    const seen: string[] = [];
    const second = () => seen.push("second");
    node.addEventListener("test", () => {
      seen.push("first");
      node.removeEventListener("test", second);
    });
    node.addEventListener("test", second);
    node.dispatchEvent(new Event("test"));
    expect(seen).toEqual(["first"]);
  });
});
