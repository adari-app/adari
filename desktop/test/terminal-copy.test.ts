// A selection the user makes in the terminal goes to
// the clipboard as soon as it ends, as Herdr, Ghostty (copy-on-select) and
// Claude Code do. Driven through ghostty-web's own SelectionManager (the one
// the app's terminal uses) over Ghostty's VT core fed real bytes, a fake
// canvas and document for the mouse, and a fake clipboard:
// - a drag copies once, when the button comes up (never on each move);
// - a double click copies the word by Ghostty's word rule (a path whole);
// - a triple click copies the line, soft-wrapped rows as one line;
// - the text reads as Ghostty copies it: soft-wrapped rows joined, trailing
//   blanks trimmed at each line's end, wide characters once;
// - a click that clears the selection, and a blank or whitespace selection,
//   leave the clipboard alone; ⌘C still copies; each copy says "Copied".

import { readFileSync } from "node:fs";
import path from "node:path";

import { Ghostty, SelectionManager, type GhosttyTerminal } from "ghostty-web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { demoCaptureSteps } from "../src/main/capture";
import { demoHostIds } from "../src/main/demo/demo-hosts";
import { installSelectionCopy, lineAt, maxSelectionCopyBytes, selectedText, wordAt } from "../src/renderer/terminal/terminal-copy";
import { TerminalInput, type TerminalSurface } from "../src/renderer/terminal/terminal-input";
import type { ClipboardFiles } from "../src/shared/ipc-contract";
import { desktopRoot } from "./support/swift-fixtures";

let ghostty: Ghostty;

beforeAll(async () => {
  const wasm = readFileSync(path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  ghostty = new Ghostty(instance);
});

const cellWidth = 8;
const cellHeight = 16;

class FakeCanvas extends EventTarget {
  parentElement = null;
  constructor(readonly clientHeight: number) {
    super();
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 1000, bottom: this.clientHeight, width: 1000, height: this.clientHeight };
  }
  contains(target: unknown): boolean {
    return target === this;
  }
}

function mouse(type: string, init: Record<string, number>): Event {
  return Object.assign(new Event(type), { button: 0, clientX: init.offsetX, clientY: init.offsetY, ...init });
}

/** The same event as it reaches the document, bubbled up from the canvas (its target the canvas). */
function bubbled(event: Event, canvas: EventTarget): Event {
  Object.defineProperty(event, "target", { value: canvas });
  return event;
}

/** One terminal: Ghostty's VT core, ghostty-web's SelectionManager on it, the copy installed, a fake clipboard. */
function rig(program: string, cols = 20, rows = 6) {
  const vt: GhosttyTerminal = ghostty.createTerminal(cols, rows);
  vt.write(new TextEncoder().encode(program));
  vt.update();
  const canvas = new FakeCanvas(rows * cellHeight);
  const terminal = { cols, rows, viewportY: 0, scrollLines: () => undefined };
  const renderer = { getCanvas: () => canvas, getMetrics: () => ({ width: cellWidth, height: cellHeight }) };
  const textarea = { style: {}, focus() {}, select() {}, setSelectionRange() {} };
  const manager = new SelectionManager(terminal as never, renderer as never, vt, textarea as never);
  const clipboard: string[] = [];
  const notes: string[] = [];
  let copied = 0;
  const copy = installSelectionCopy({
    selection: manager,
    grid: vt,
    canvas,
    copy: (text) => clipboard.push(text),
    copied: () => (copied += 1),
    note: (text) => notes.push(text),
  });
  if (copy === null) throw new Error("the copy did not install on ghostty-web's SelectionManager");
  const at = (col: number, row: number) => ({ offsetX: col * cellWidth + 2, offsetY: row * cellHeight + 2 });
  const press = (col: number, row: number, detail = 1): void => {
    canvas.dispatchEvent(mouse("mousedown", { ...at(col, row), detail }));
    document.dispatchEvent(bubbled(mouse("mousedown", { ...at(col, row), detail }), canvas));
  };
  const move = (col: number, row: number): void => {
    canvas.dispatchEvent(mouse("mousemove", { ...at(col, row), buttons: 1 }));
  };
  const release = (col: number, row: number, detail = 1): void => {
    canvas.dispatchEvent(mouse("mouseup", { ...at(col, row), detail }));
    document.dispatchEvent(bubbled(mouse("mouseup", { ...at(col, row), detail }), canvas));
    canvas.dispatchEvent(mouse("click", { ...at(col, row), detail }));
    document.dispatchEvent(bubbled(mouse("click", { ...at(col, row), detail }), canvas));
  };
  const drag = (from: [number, number], to: [number, number]): void => {
    press(from[0], from[1]);
    move(Math.round((from[0] + to[0]) / 2), Math.round((from[1] + to[1]) / 2));
    move(to[0], to[1]);
    release(to[0], to[1]);
  };
  const click = (col: number, row: number): void => {
    press(col, row);
    release(col, row);
  };
  const doubleClick = (col: number, row: number): void => {
    press(col, row, 1);
    release(col, row, 1);
    press(col, row, 2);
    release(col, row, 2);
    canvas.dispatchEvent(mouse("dblclick", { ...at(col, row), detail: 2 }));
  };
  const tripleClick = (col: number, row: number): void => {
    doubleClick(col, row);
    press(col, row, 3);
    release(col, row, 3);
  };
  return { vt, manager, copy, clipboard, notes, copied: () => copied, press, move, release, drag, click, doubleClick, tripleClick };
}

beforeEach(() => {
  vi.stubGlobal("document", new EventTarget());
  // ghostty-web's own copy goes to navigator.clipboard: it must never be reached.
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: () => {
        throw new Error("ghostty-web's own copy ran");
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("a drag", () => {
  it("copies the selected text once, when the button comes up", () => {
    const t = rig("hello world\r\n");
    t.press(0, 0);
    t.move(2, 0);
    t.move(4, 0);
    expect(t.clipboard).toEqual([]);
    t.release(4, 0);
    expect(t.clipboard).toEqual(["hello"]);
    expect(t.copied()).toBe(1);
  });

  it("joins a soft-wrapped line and breaks at hard line ends (ghostty-web alone puts a newline after every row)", () => {
    const t = rig("abcdefghijKLMNO\r\nnext\r\n", 10);
    t.drag([0, 0], [9, 2]);
    expect(t.clipboard).toEqual(["abcdefghijKLMNO\nnext"]);
    expect(t.manager.getSelection()).toBe("abcdefghij\nKLMNO\nnext");
  });

  it("keeps a space where a line wrapped and trims trailing blanks only at line ends", () => {
    const t = rig("abcd efgh ijkl\r\nab   \r\ncd\r\n", 10);
    t.drag([0, 0], [9, 3]);
    expect(t.clipboard).toEqual(["abcd efgh ijkl\nab\ncd"]);
  });

  it("copies wide characters once (ghostty-web alone adds a space after each)", () => {
    const t = rig("日本語ab\r\n", 12);
    t.drag([0, 0], [11, 0]);
    expect(t.clipboard).toEqual(["日本語ab"]);
  });

  it("copies a selection backwards as forwards", () => {
    const t = rig("one two three\r\n");
    t.drag([6, 0], [4, 0]);
    expect(t.clipboard).toEqual(["two"]);
  });

  it("a selection over blank cells or whitespace copies nothing", () => {
    const t = rig("x\r\n\r\n   \r\n");
    t.drag([0, 1], [10, 3]);
    expect(t.clipboard).toEqual([]);
    expect(t.copied()).toBe(0);
  });
});

describe("a click", () => {
  it("that clears a selection leaves the clipboard alone (ghostty-web alone copies the character clicked)", () => {
    const t = rig("hello world\r\n");
    t.drag([0, 0], [4, 0]);
    expect(t.clipboard).toEqual(["hello"]);
    t.click(8, 0);
    expect(t.manager.hasSelection()).toBe(false);
    expect(t.clipboard).toEqual(["hello"]);
    expect(t.copied()).toBe(1);
  });

  it("a double click copies the word by Ghostty's rule: a path or a dotted name whole", () => {
    const t = rig("open src/main/terminals.ts now\r\n", 40);
    t.doubleClick(8, 0);
    expect(t.clipboard).toEqual(["src/main/terminals.ts"]);
    expect(t.copied()).toBe(1);
  });

  it("a double click stops at Ghostty's boundary characters", () => {
    const t = rig('say "quoted-word", (paren) x:y\r\n', 40);
    t.doubleClick(6, 0);
    t.doubleClick(20, 0);
    t.doubleClick(27, 0);
    t.doubleClick(28, 0);
    expect(t.clipboard).toEqual(["quoted-word", "paren", "x", ":"]);
  });

  it("a double click on a blank copies nothing", () => {
    const t = rig("a    b\r\n");
    t.doubleClick(3, 0);
    expect(t.clipboard).toEqual([]);
  });

  it("a double click takes a word across a soft wrap, as Ghostty does", () => {
    const t = rig("abcde ghijKLMNOPQRSTuv end\r\n", 10);
    t.doubleClick(3, 1);
    expect(t.clipboard).toEqual(["ghijKLMNOPQRSTuv"]);
  });

  it("a triple click copies the whole line, its soft-wrapped rows as one, once", () => {
    const t = rig("first\r\nabcde ghijKLMNOPQRSTuv\r\nlast\r\n", 10);
    t.tripleClick(3, 2);
    // The double click's word, then the triple click's line: one copy each.
    expect(t.clipboard).toEqual(["ghijKLMNOPQRSTuv", "abcde ghijKLMNOPQRSTuv"]);
    expect(t.copied()).toBe(2);
    expect(t.manager.hasSelection()).toBe(true);
    // A move and the button coming up after the third press neither change nor copy it.
    t.move(0, 4);
    t.release(0, 4, 3);
    expect(t.clipboard).toHaveLength(2);
    expect(t.copy.text()).toBe("abcde ghijKLMNOPQRSTuv");
  });
});

describe("the text read from Ghostty's screen", () => {
  it("reads the scrollback as well as the screen", () => {
    const vt = ghostty.createTerminal(10, 2);
    vt.write(new TextEncoder().encode("one\r\ntwo\r\nthree\r\nfour"));
    vt.update();
    expect(vt.getScrollbackLength()).toBe(2);
    expect(selectedText(vt, { col: 0, row: 0 }, { col: 9, row: 3 })).toBe("one\ntwo\nthree\nfour");
  });

  it("a line and a word, by absolute row", () => {
    const vt = ghostty.createTerminal(10, 4);
    vt.write(new TextEncoder().encode("x\r\nabcdefghijKL\r\n"));
    vt.update();
    expect(lineAt(vt, 2)).toEqual({ start: { col: 0, row: 1 }, end: { col: 9, row: 2 } });
    expect(lineAt(vt, 0)).toEqual({ start: { col: 0, row: 0 }, end: { col: 9, row: 0 } });
    expect(wordAt(vt, 1, 4)).toEqual({ start: { col: 0, row: 1 }, end: { col: 1, row: 2 } });
    expect(wordAt(vt, 0, 0)).toEqual({ start: { col: 0, row: 0 }, end: { col: 0, row: 0 } });
  });

  it("refuses a selection larger than the clipboard takes, and says so", () => {
    const t = rig("hello\r\n");
    expect(maxSelectionCopyBytes).toBe(4 * 1_048_576);
    const big = "x".repeat(maxSelectionCopyBytes + 1);
    const original = t.copy.text;
    t.copy.text = () => big;
    t.drag([0, 0], [4, 0]);
    t.copy.text = original;
    expect(t.clipboard).toEqual([]);
    expect(t.notes).toEqual(["Not copied: the selection is over 4 MB."]);
  });
});

describe("⌘C", () => {
  it("still copies the selection, as the copy reads it", () => {
    const t = rig("abcdefghijKLMNO\r\n", 10);
    t.drag([0, 0], [9, 1]);
    const surface: TerminalSurface = {
      getMode: () => false,
      alternateScreen: () => false,
      mouseTracking: () => false,
      bracketedPaste: () => false,
      hasSelection: () => t.manager.hasSelection(),
      getSelection: () => t.copy.text(),
      scrollLines: () => undefined,
      cellHeight: () => cellHeight,
      cellAt: () => ({ col: 1, row: 1 }),
    };
    const copies: string[] = [];
    const noFiles: ClipboardFiles = { files: [], refused: [], excess: [], failures: [] };
    const input = new TerminalInput(surface, {
      send: () => undefined,
      copy: (text) => copies.push(text),
      note: () => undefined,
      upload: () => Promise.reject(new Error("no")),
      clipboardFiles: async () => noFiles,
      prepareImage: async () => null as never,
    });
    expect(input.key({ key: "c", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(copies).toEqual(["abcdefghijKLMNO"]);
  });
});

describe("dispose", () => {
  it("stops copying (ghostty-web's own copy never comes back)", () => {
    const t = rig("hello world\r\n");
    t.copy.dispose();
    t.drag([0, 0], [4, 0]);
    expect(t.clipboard).toEqual([]);
  });
});

describe("the demo capture", () => {
  it("follows the split steps with a selection dragged in a terminal, its Copied note captured", () => {
    const steps = demoCaptureSteps(demoHostIds);
    // Step 36 follows the splits' 35; the model chips' steps (37, 38) come after it.
    const at = steps.findIndex((step) => step.name === "36-terminal-copied");
    expect(steps[at - 1]!.name).toBe("35-new-agent-where");
    const last = steps[at]!;
    expect(last.commands).toContainEqual({ type: "set-tab", tab: "terminal" });
    expect(last.after?.commands).toEqual([{ type: "terminal-select", selector: ".term-host canvas", from: { x: 0.02, y: 0.08 }, to: { x: 0.7, y: 0.3 } }]);
    // The note shows for 1.2 s: the capture is taken well within it.
    expect(last.settleMs).toBeLessThan(1_000);
  });
});
