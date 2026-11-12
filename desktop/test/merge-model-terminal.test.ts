// The screen read (TerminalView onScreen, the context ring's "Context low
// (N% remaining)") and the selection copy and OSC 52 gate in the same terminal.
// A selection the user makes goes to the clipboard and never feeds the ring (no
// output, no screen read); the screen read never copies; a program's OSC 52
// write reaches the clipboard by its own gate and the ring reads the screen
// without its payload. (The harness is terminal-view-copy.test.ts's, with the
// fake Terminal's buffer read as the screen read reads it.)


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

// Each terminal's own engine (terminal-core.ts); the fake Terminal here builds on the shared one.
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
      // The live screen as the model's visibleText reads it.
      get buffer() {
        const grid = this.wasmTerm!;
        return {
          active: {
            type: "normal",
            baseY: 0,
            getLine: (y: number) => {
              const cells = grid.getLine(y);
              return cells === null
                ? undefined
                : { translateToString: () => cells.map((cell) => (cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint))).join("").trimEnd() };
            },
          },
        };
      }
    },
  };
});

import { find, HookHost } from "./support/fake-hooks";

const { Ghostty } = await import("ghostty-web");
const { TerminalView } = await import("../src/renderer/terminal/TerminalView");

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
async function tile(program: string, onScreen?: (text: string) => void) {
  const { port, send, inputs } = fakePort();
  const frame = new Listening();
  const hostElement = new Listening();
  const view = new HookHost(TerminalView as (props: Props) => unknown, { port, autoFocus: true, ...(onScreen === undefined ? {} : { onScreen }) });
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

const osc52 = (targets: string, text: string): string => `\x1b]52;${targets};${Buffer.from(text, "utf8").toString("base64")}\x07`;

describe("the ring's screen read beside the selection copy", () => {
  it("reads the screen after output and copies nothing", async () => {
    const screens: string[] = [];
    const t = await tile("", (text) => screens.push(text));
    t.send("Context low (12% remaining)\r\n$ ");
    vi.advanceTimersByTime(1_000);
    expect(screens).toHaveLength(1);
    expect(screens[0]!.split("\n")[0]).toBe("Context low (12% remaining)");
    expect(clipboard).toEqual([]);
    expect(t.note()).toBeUndefined();
    t.view.unmount();
  });

  it("a selection the user makes is copied and never read as the screen", async () => {
    const screens: string[] = [];
    const t = await tile("", (text) => screens.push(text));
    t.send("Context low (12% remaining)\r\n");
    vi.advanceTimersByTime(1_000);
    expect(screens).toHaveLength(1);
    t.drag([0, 0], [10, 0]);
    expect(clipboard).toEqual(["Context low"]);
    expect(t.note()?.props.children).toBe("Copied");
    vi.advanceTimersByTime(3_000);
    // No output since: no screen read, and the selection is not one.
    expect(screens).toHaveLength(1);
    // New output is read as the screen, not as the selection.
    t.send("ready\r\n");
    vi.advanceTimersByTime(1_000);
    expect(screens).toHaveLength(2);
    expect(screens[1]!.split("\n").slice(0, 2)).toEqual(["Context low (12% remaining)", "ready"]);
    expect(clipboard).toEqual(["Context low"]);
    t.view.unmount();
  });

  it("a program's OSC 52 write goes by its own gate; the screen read sees the screen, not its payload", async () => {
    const screens: string[] = [];
    const t = await tile("", (text) => screens.push(text));
    t.frame.dispatchEvent(new Event("keydown"));
    t.send(`Context low (9% remaining)${osc52("c", "secret-ish payload")}\r\n`);
    expect(clipboard).toEqual(["secret-ish payload"]);
    vi.advanceTimersByTime(1_000);
    expect(screens).toHaveLength(1);
    expect(screens[0]).toContain("Context low (9% remaining)");
    expect(screens[0]).not.toContain("secret-ish payload");
    expect(screens[0]).not.toContain(Buffer.from("secret-ish payload").toString("base64"));
    t.view.unmount();
  });
});
