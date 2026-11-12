// The terminal tile copies: TerminalView with
// ghostty-web's real SelectionManager over Ghostty's VT core (the rest of
// ghostty-web's Terminal faked, as there is no DOM here), the bridge's
// clipboard faked. A selection the user makes goes to the clipboard once with a
// "Copied" note in the tile's corner for about a second; ⌘C says it too. A
// program's OSC 52 write, as the pane's bytes carry it, copies only right
// after the user's own key or mouse in the tile on show; a read is never answered.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, useLayoutEffect: fakeReact.useEffect };
});

const shared = vi.hoisted(() => ({
  ghostty: null as unknown as import("ghostty-web").Ghostty,
  made: [] as unknown[],
}));

const cellWidth = 8;
const cellHeight = 16;

class FakeCanvas extends EventTarget {
  parentElement = null;
  clientHeight = 24 * 16;
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 640, bottom: this.clientHeight, width: 640, height: this.clientHeight };
  }
  contains(target: unknown): boolean {
    return target === this;
  }
}

// Each terminal has its own engine (terminal-core.ts); the fake Terminal here builds on the shared one.
vi.mock("../src/renderer/terminal/terminal-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/terminal/terminal-core")>()),
  newTerminalCore: async () => shared.ghostty,
}));

vi.mock("ghostty-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ghostty-web")>();
  return {
    ...actual,
    FitAddon: class {
      proposeDimensions() {
        return { cols: 40, rows: 6 };
      }
    },
    Terminal: class {
      cols = 40;
      rows = 6;
      viewportY = 0;
      options: unknown;
      wasmTerm?: import("ghostty-web").GhosttyTerminal;
      renderer?: { getCanvas(): FakeCanvas; getMetrics(): { width: number; height: number }; charHeight: number; charWidth: number };
      selectionManager?: import("ghostty-web").SelectionManager;
      keys: ((event: unknown) => boolean) | null = null;
      constructor(options: unknown) {
        this.options = options;
        shared.made.push(this);
      }
      loadAddon() {}
      open() {
        const canvas = new FakeCanvas();
        this.wasmTerm = shared.ghostty.createTerminal(this.cols, this.rows);
        this.renderer = { getCanvas: () => canvas, getMetrics: () => ({ width: cellWidth, height: cellHeight }), charHeight: cellHeight, charWidth: cellWidth };
        const textarea = { style: {}, focus() {}, select() {}, setSelectionRange() {} };
        this.selectionManager = new actual.SelectionManager(this as never, this.renderer as never, this.wasmTerm, textarea as never);
      }
      onData() {}
      attachCustomWheelEventHandler() {}
      attachCustomKeyEventHandler(handler: (event: unknown) => boolean) {
        this.keys = handler;
      }
      resize() {}
      focus() {}
      scrollLines() {}
      hasSelection() {
        return this.selectionManager?.hasSelection() ?? false;
      }
      getSelection() {
        return this.selectionManager?.getSelection() ?? "";
      }
      write(bytes: Uint8Array) {
        this.wasmTerm!.write(bytes);
        this.wasmTerm!.update();
      }
      dispose() {
        this.selectionManager?.dispose();
      }
    },
  };
});

import { find, HookHost } from "./support/fake-hooks";

const { Ghostty } = await import("ghostty-web");
const { TerminalView, copiedMs } = await import("../src/renderer/terminal/TerminalView");

type Props = Parameters<typeof TerminalView>[0];

interface MadeTerminal {
  renderer: { getCanvas(): FakeCanvas };
  selectionManager: import("ghostty-web").SelectionManager;
  keys: ((event: unknown) => boolean) | null;
}

beforeAll(async () => {
  const wasm = readFileSync(path.join(process.cwd(), "node_modules/ghostty-web/ghostty-vt.wasm"));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  shared.ghostty = new Ghostty(instance);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

class Listening extends EventTarget {
  replaceChildren() {}
  isConnected = true;
  getClientRects() {
    return [{}];
  }
}

function fakePort() {
  const subscribers = new Set<(bytes: Uint8Array) => void>();
  const inputs: (string | Uint8Array)[] = [];
  return {
    inputs,
    port: {
      subscribe(onData: (bytes: Uint8Array) => void) {
        subscribers.add(onData);
        return () => subscribers.delete(onData);
      },
      resize() {},
      input(data: string | Uint8Array) {
        inputs.push(data);
      },
    },
    send(text: string) {
      for (const write of subscribers) write(new TextEncoder().encode(text));
    },
  };
}

function mouse(type: string, col: number, row: number, detail = 1): Event {
  const at = { offsetX: col * cellWidth + 2, offsetY: row * cellHeight + 2 };
  return Object.assign(new Event(type), { button: 0, clientX: at.offsetX, clientY: at.offsetY, detail, ...at });
}

function bubbled(event: Event, canvas: EventTarget): Event {
  Object.defineProperty(event, "target", { value: canvas });
  return event;
}

let clipboard: string[];

/** A terminal tile up, the program's bytes on its screen. */
async function tile(program: string) {
  const { port, send, inputs } = fakePort();
  const frame = new Listening();
  const hostElement = new Listening();
  const view = new HookHost(TerminalView as (props: Props) => unknown, { port, autoFocus: true });
  const slots = (view as unknown as { slots: unknown[] }).slots;
  slots[1] = { current: frame };
  slots[2] = { current: hostElement };
  view.render();
  await settle();
  const terminal = shared.made.at(-1) as MadeTerminal;
  if (program !== "") send(program);
  const canvas = terminal.renderer.getCanvas();
  const drag = (from: [number, number], to: [number, number]): void => {
    canvas.dispatchEvent(mouse("mousedown", from[0], from[1]));
    document.dispatchEvent(bubbled(mouse("mousedown", from[0], from[1]), canvas));
    canvas.dispatchEvent(mouse("mousemove", to[0], to[1]));
    canvas.dispatchEvent(mouse("mouseup", to[0], to[1]));
    document.dispatchEvent(bubbled(mouse("mouseup", to[0], to[1]), canvas));
    document.dispatchEvent(bubbled(mouse("click", to[0], to[1]), canvas));
  };
  const note = () => find(view.tree, "div", "term-copied");
  const screen = (row: number): string => (terminal as unknown as { wasmTerm: import("ghostty-web").GhosttyTerminal }).wasmTerm.getLine(row)!.map((cell) => (cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint))).join("").trimEnd();
  return { view, terminal, send, drag, note, frame, hostElement, inputs, screen };
}

beforeEach(() => {
  shared.made.length = 0;
  clipboard = [];
  vi.useFakeTimers();
  vi.stubGlobal("document", Object.assign(new EventTarget(), { fonts: { load: async () => undefined }, visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
  vi.stubGlobal("window", { herdrDesktop: { copyText: (text: string) => clipboard.push(text) } });
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

describe("a selection in the terminal tile", () => {
  it("goes to the clipboard once, with a Copied note for about a second", async () => {
    const t = await tile("hello world\r\n");
    expect(t.note()).toBeUndefined();
    t.drag([6, 0], [10, 0]);
    expect(clipboard).toEqual(["world"]);
    const note = t.note();
    expect(note?.props.children).toBe("Copied");
    expect(note?.props["role"]).toBe("status");
    vi.advanceTimersByTime(copiedMs - 1);
    expect(t.note()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(t.note()).toBeUndefined();
    t.view.unmount();
  });

  it("a click that clears it copies nothing and shows no note", async () => {
    const t = await tile("hello world\r\n");
    t.drag([0, 0], [4, 0]);
    vi.advanceTimersByTime(copiedMs);
    t.drag([8, 0], [8, 0]);
    expect(t.terminal.selectionManager.hasSelection()).toBe(false);
    expect(clipboard).toEqual(["hello"]);
    expect(t.note()).toBeUndefined();
    t.view.unmount();
  });

  it("⌘C copies it again (Ghostty's text) and says so", async () => {
    const t = await tile("abcdefghijKLMNOPQRSTUVWXYZabcdefghijklmnop\r\n");
    t.drag([0, 0], [1, 1]);
    expect(clipboard).toEqual(["abcdefghijKLMNOPQRSTUVWXYZabcdefghijklmnop"]);
    vi.advanceTimersByTime(copiedMs);
    expect(t.note()).toBeUndefined();
    expect(t.terminal.keys?.({ key: "c", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(clipboard).toEqual(["abcdefghijKLMNOPQRSTUVWXYZabcdefghijklmnop", "abcdefghijKLMNOPQRSTUVWXYZabcdefghijklmnop"]);
    expect(t.note()).toBeDefined();
    t.view.unmount();
  });
});

const osc52 = (targets: string, text: string): string => `\x1b]52;${targets};${Buffer.from(text, "utf8").toString("base64")}\x07`;

describe("a program's OSC 52 write in the terminal tile", () => {
  it("right after a key of the user's in the tile goes to the clipboard, with the Copied note", async () => {
    const t = await tile("$ ");
    t.frame.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(1_500);
    t.send(`copied ${osc52("c", "the program's selection")}ok\r\n`);
    expect(clipboard).toEqual(["the program's selection"]);
    expect(t.note()?.props.children).toBe("Copied");
    // The rest of the bytes reach the screen as ever; nothing is answered.
    expect(t.screen(0)).toBe("$ copied ok");
    expect(t.inputs).toEqual([]);
    t.view.unmount();
  });

  it("right after a press of the user's mouse in the tile, too", async () => {
    const t = await tile("");
    t.frame.dispatchEvent(new Event("mousedown"));
    t.send(osc52("c", "by mouse"));
    expect(clipboard).toEqual(["by mouse"]);
    t.view.unmount();
  });

  it("with no action of the user's, or one more than 2 s ago, is refused", async () => {
    const t = await tile("");
    t.send(osc52("c", "on its own"));
    t.frame.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(2_001);
    t.send(osc52("c", "too late"));
    expect(clipboard).toEqual([]);
    expect(t.note()).toBeUndefined();
    t.view.unmount();
  });

  it("for a tile not on show is refused, even right after an action", async () => {
    const t = await tile("");
    t.hostElement.getClientRects = () => [];
    t.frame.dispatchEvent(new Event("keydown"));
    t.send(osc52("c", "hidden tile"));
    t.hostElement.getClientRects = () => [{}];
    (document as unknown as { visibilityState: string }).visibilityState = "hidden";
    t.frame.dispatchEvent(new Event("keydown"));
    t.send(osc52("c", "hidden window"));
    expect(clipboard).toEqual([]);
    t.view.unmount();
  });

  it("a read (query) is refused: nothing answered, the clipboard untouched", async () => {
    const t = await tile("");
    t.frame.dispatchEvent(new Event("keydown"));
    t.send("\x1b]52;c;?\x07");
    expect(t.inputs).toEqual([]);
    expect(clipboard).toEqual([]);
    expect(t.note()).toBeUndefined();
    t.view.unmount();
  });
});
