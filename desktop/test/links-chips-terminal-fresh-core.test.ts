// A new terminal never
// shows a closed pane's text. ghostty-web 0.4.0 builds every Terminal on one
// shared Ghostty WASM instance unless it is given its own, and a core freed on
// that instance leaves its cells in memory the next core is built on: pane B
// showed pane A's marker before it wrote anything, and B's shorter output kept
// A's tail (`https://b.invalid/a` read `https://b.invalid/ad/a` on screen and
// to the link provider). `Terminal.open` draws before the port attaches, so
// that text was on screen.
//
// Here TerminalView itself makes the terminals, on the app's own path: the
// real ghostty-web Terminal (its open, buildWasmConfig, the app's theme and
// 10,000-line scrollback at the initial 80x24 grid, its CanvasRenderer, its
// dispose) over the real ghostty-vt.wasm. Only the DOM is faked: the canvas's
// 2D context records each glyph the renderer draws, so "what B shows" is what
// the renderer drew. The port and the link opener are fakes; every address is
// invented.

import { readFileSync } from "node:fs";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeReact } = await import("./support/fake-hooks");
  return { ...actual, ...fakeReact, useLayoutEffect: fakeReact.useEffect };
});

const made = vi.hoisted(() => [] as unknown[]);

vi.mock("ghostty-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ghostty-web")>();
  // The real Terminal, counted as TerminalView makes it.
  class Terminal extends actual.Terminal {
    constructor(options?: ConstructorParameters<typeof actual.Terminal>[0]) {
      super(options);
      made.push(this);
    }
  }
  return {
    ...actual,
    Terminal,
    // The grid the host's size would give: the app's initial 80x24, so no resize.
    FitAddon: class {
      activate() {}
      dispose() {}
      proposeDimensions() {
        return { cols: 80, rows: 24 };
      }
    },
  };
});

import { HookHost } from "./support/fake-hooks";
import { desktopRoot } from "./support/swift-fixtures";

const { TerminalView } = await import("../src/renderer/terminal/TerminalView");

type Props = Parameters<typeof TerminalView>[0];
type RealTerminal = import("ghostty-web").Terminal;

const wasmFile = path.join(desktopRoot, "node_modules/ghostty-web/ghostty-vt.wasm");
const cols = 80;
const rows = 24;
// The fake font's metrics, as CanvasRenderer.measureFont reads them: width 8, height ceil(12 + 3) + 2, baseline ceil(12) + 1.
const cellWidth = 8;
const cellHeight = 17;
const baseline = 13;

interface Glyph {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/** A 2D context that records every glyph drawn and ignores the rest. */
function recordingContext(glyphs: Glyph[]): unknown {
  const state: Record<string | symbol, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key === "fillText") return (text: string, x: number, y: number) => glyphs.push({ text, x, y });
      if (key === "measureText") return () => ({ width: cellWidth, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 });
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

class FakeElement extends EventTarget {
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  isConnected = true;
  clientWidth = cols * cellWidth;
  clientHeight = rows * cellHeight;
  constructor(readonly tagName = "div") {
    super();
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((each) => each !== child);
    child.parentNode = null;
    return child;
  }
  replaceChildren() {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  querySelector(selector: string) {
    return this.children.find((child) => child.tagName === selector) ?? null;
  }
  contains(target: unknown) {
    return target === this || this.children.some((child) => child === target);
  }
  getClientRects() {
    return [{}];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  focus() {}
  blur() {}
  select() {}
  setSelectionRange() {}
}

class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;
  readonly glyphs: Glyph[] = [];
  private readonly context = recordingContext(this.glyphs);
  constructor() {
    super("canvas");
  }
  getContext() {
    return this.context;
  }
}

interface Listener {
  readonly type: string;
  readonly listener: unknown;
  readonly capture: boolean;
}

const captureOf = (options?: boolean | EventListenerOptions): boolean => (typeof options === "boolean" ? options : options?.capture === true);

/** The document, keeping count of what listens on it: a closed terminal must leave nothing. */
class FakeDocument extends EventTarget {
  readonly listeners: Listener[] = [];
  readonly fonts = { load: async () => [] };
  readonly visibilityState = "visible";
  readonly body = new FakeElement("body");
  readonly activeElement = null;
  createElement(tag: string) {
    return tag === "canvas" ? new FakeCanvas() : new FakeElement(tag);
  }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    const capture = captureOf(options);
    if (listener !== null && !this.listeners.some((each) => each.type === type && each.listener === listener && each.capture === capture)) this.listeners.push({ type, listener, capture });
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    const capture = captureOf(options);
    const at = this.listeners.findIndex((each) => each.type === type && each.listener === listener && each.capture === capture);
    if (at >= 0) this.listeners.splice(at, 1);
    super.removeEventListener(type, listener, options);
  }
}

/** The screen as the renderer has drawn it so far: each glyph at its cell, later draws over earlier ones. */
function drawnRows(canvas: FakeCanvas, upTo = canvas.glyphs.length): string[] {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
  for (const glyph of canvas.glyphs.slice(0, upTo)) {
    const row = (glyph.y - baseline) / cellHeight;
    const col = glyph.x / cellWidth;
    if (Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < rows && col >= 0 && col < cols) grid[row]![col] = glyph.text;
  }
  return grid.map((cells) => cells.join("").trimEnd());
}

let frames: ((time: number) => void)[] = [];
let opened: string[] = [];

/** One animation frame: the render loop draws what changed. */
function frame(): void {
  for (const run of frames.splice(0)) run(0);
}

function fakePort() {
  const subscribers = new Set<(bytes: Uint8Array) => void>();
  return {
    port: {
      subscribe(onData: (bytes: Uint8Array) => void) {
        subscribers.add(onData);
        return () => subscribers.delete(onData);
      },
      resize() {},
      input() {},
    },
    send(text: string) {
      for (const write of subscribers) write(new TextEncoder().encode(text));
    },
  };
}

interface Pane {
  readonly view: HookHost<Props>;
  readonly terminal: RealTerminal;
  readonly canvas: FakeCanvas;
  /** Glyphs drawn by the time the terminal was up, before the pane sent a byte. */
  readonly firstDraw: number;
  send(text: string): void;
  /** Row `y` of the terminal's own buffer, as the copy and the link provider read it. */
  line(y: number): string;
}

/** A pane's TerminalView up on its port, the way the app mounts one. */
async function pane(): Promise<Pane> {
  const { port, send } = fakePort();
  const frameElement = new FakeElement();
  const hostElement = new FakeElement();
  const before = made.length;
  const view = new HookHost<Props>(TerminalView as (props: Props) => unknown, { port, autoFocus: true });
  const slots = (view as unknown as { slots: unknown[] }).slots;
  slots[1] = { current: frameElement };
  slots[2] = { current: hostElement };
  view.render();
  await vi.waitFor(() => {
    expect(made.length).toBe(before + 1);
    expect(hostElement.querySelector("canvas")).not.toBeNull();
  });
  const terminal = made.at(-1) as RealTerminal;
  const canvas = hostElement.querySelector("canvas") as FakeCanvas;
  return {
    view,
    terminal,
    canvas,
    firstDraw: canvas.glyphs.length,
    send,
    line: (y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? "",
  };
}

/** The pane closed: TerminalView's cleanup disposes its terminal (frees its core). */
function close(each: Pane): void {
  each.view.unmount();
  frame();
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  made.length = 0;
  frames = [];
  opened = [];
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    herdrDesktop: { copyText() {}, openLink: (url: string) => opened.push(url) },
  });
  // ghostty-web's own loader resolves its embedded data: URL against self.location (a browser global).
  vi.stubGlobal("self", { location: new URL("app://app/") });
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "", clipboard: { writeText: async () => undefined } });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (run: (time: number) => void) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // The app's window fetches the engine's file from its own protocol; here it is read from the package.
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("ghostty-vt.wasm")
      ? new Response(readFileSync(wasmFile), { headers: { "content-type": "application/wasm" } })
      : originalFetch(input, init),
  );
});

afterEach(() => {
  frame();
  vi.unstubAllGlobals();
});

const marker = "PANE_A_ONLY_MARKER_abcdefghijklmnopqrstuvwxyz";
const blankScreen = Array.from({ length: rows }, () => "");

describe("a new terminal starts blank after another one closed", () => {
  it("pane B's first drawn rows are blank, and its short output keeps no tail of pane A", async () => {
    const a = await pane();
    a.send(marker);
    frame();
    expect(drawnRows(a.canvas)[0]).toBe(marker);
    expect(a.line(0)).toBe(marker);
    close(a);

    const b = await pane();
    // What B drew when it came up, before its port sent anything: nothing of A's.
    expect(drawnRows(b.canvas, b.firstDraw)).toEqual(blankScreen);
    for (let y = 0; y < rows; y += 1) expect(b.line(y), `row ${y}`).toBe("");
    b.send("PANE_B");
    frame();
    expect(b.line(0)).toBe("PANE_B");
    expect(drawnRows(b.canvas)[0]).toBe("PANE_B");
    expect(drawnRows(b.canvas).slice(1)).toEqual(blankScreen.slice(1));
    close(b);
  });

  it("the link provider reads only pane B's text, and opens B's address whole", async () => {
    const a = await pane();
    a.send("https://例え.invalid/a");
    frame();
    expect(a.line(0)).toBe("https://例え.invalid/a");
    close(a);

    const b = await pane();
    expect(drawnRows(b.canvas, b.firstDraw)).toEqual(blankScreen);
    b.send("https://b.invalid/a");
    frame();
    expect(b.line(0)).toBe("https://b.invalid/a");
    expect(drawnRows(b.canvas)[0]).toBe("https://b.invalid/a");
    // The detector the mouse goes through, with TerminalView's provider in it.
    const detector = (b.terminal as unknown as { linkDetector: { getLinkAt(x: number, y: number): Promise<{ text: string; activate(event: unknown): void } | undefined> } }).linkDetector;
    const first = await detector.getLinkAt(0, 0);
    const last = await detector.getLinkAt(18, 0);
    expect(first?.text).toBe("https://b.invalid/a");
    expect(last?.text).toBe("https://b.invalid/a");
    expect(await detector.getLinkAt(20, 0)).toBeUndefined();
    first!.activate({ metaKey: true, ctrlKey: false });
    expect(opened).toEqual(["https://b.invalid/a"]);
    close(b);
  });

  it("two panes open side by side keep their own text, and the drawer's or a split's next terminal starts blank", async () => {
    const left = await pane();
    const right = await pane();
    left.send("LEFT_TILE");
    right.send("RIGHT_TILE_LONGER");
    frame();
    expect(left.line(0)).toBe("LEFT_TILE");
    expect(right.line(0)).toBe("RIGHT_TILE_LONGER");
    close(right);
    const next = await pane();
    expect(drawnRows(next.canvas, next.firstDraw)).toEqual(blankScreen);
    expect(next.line(0)).toBe("");
    expect(left.line(0)).toBe("LEFT_TILE");
    close(next);
    close(left);
  });

  it("a closed terminal leaves nothing listening on the document (ghostty-web 0.4.0's dispose misses two)", async () => {
    const listening = (document as unknown as FakeDocument).listeners;
    expect(listening).toEqual([]);
    const first = await pane();
    const second = await pane();
    // Each open adds the Terminal's mouseup and its SelectionManager's mousedown, mousemove, mouseup and click.
    expect(listening.length).toBeGreaterThanOrEqual(10);
    close(first);
    expect(listening.length).toBeGreaterThanOrEqual(5);
    close(second);
    expect(listening).toEqual([]);
  });

  it("when the app's engine file cannot be read, ghostty-web's own copy still gives each terminal its own blank engine", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      asked.push(String(input).startsWith("data:application/wasm;") ? "embedded copy" : String(input));
      return String(input).endsWith("ghostty-vt.wasm") ? new Response("", { status: 404 }) : originalFetch(input, init);
    });
    vi.resetModules();
    const { newTerminalCore } = await import("../src/renderer/terminal/terminal-core");
    const row = (core: import("ghostty-web").GhosttyTerminal): string => {
      core.update();
      return core
        .getLine(0)!
        .map((cell) => (cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint)))
        .join("")
        .trimEnd();
    };
    const first = await newTerminalCore();
    const a = first.createTerminal(cols, rows);
    a.write(marker);
    expect(row(a)).toBe(marker);
    a.free();
    const second = await newTerminalCore();
    expect(second).not.toBe(first);
    const b = second.createTerminal(cols, rows);
    expect(row(b)).toBe("");
    b.write("PANE_B");
    expect(row(b)).toBe("PANE_B");
    b.free();
    // The app's file was asked for once, then ghostty-web's loader read its embedded copy for each terminal.
    expect(asked.filter((url) => url.endsWith("ghostty-vt.wasm"))).toHaveLength(1);
    expect(asked.filter((url) => url === "embedded copy")).toHaveLength(2);
  });

  it("many open and close cycles: each starts blank, and a closed terminal's WASM memory is let go", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const cycles = 30;
    const closed: WeakRef<WebAssembly.Memory>[] = [];
    const memories = new Set<WebAssembly.Memory>();
    for (let n = 0; n < cycles; n += 1) {
      const each = await pane();
      expect(drawnRows(each.canvas, each.firstDraw), `cycle ${n}`).toEqual(blankScreen);
      expect(each.line(0), `cycle ${n}`).toBe("");
      each.send(`CYCLE_${n}_${"z".repeat(60)}\r\n`.repeat(30));
      frame();
      const memory = (each.terminal.wasmTerm as unknown as { memory: WebAssembly.Memory }).memory;
      memories.add(memory);
      closed.push(new WeakRef(memory));
      close(each);
      made.length = 0;
    }
    // Each terminal had its own instance (its own memory), none shared.
    expect(memories.size).toBe(cycles);
    memories.clear();
    for (let i = 0; i < 4; i += 1) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The bound: nothing keeps a closed terminal's instance, so at most one is still uncollected.
    const alive = closed.filter((ref) => ref.deref() !== undefined).length;
    expect(alive).toBeLessThanOrEqual(1);
  });
});
